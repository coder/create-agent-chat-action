import * as core from "@actions/core";
import type { getOctokit } from "@actions/github";
import type {
	ChatId,
	ChatStatus,
	CoderChat,
	CoderClient,
	CreateChatRequest,
} from "./coder-client";
import {
	buildCommentMarker,
	buildDeploymentChatsUrl,
	buildFailureCommentBody,
	classifyError,
	deriveCommentKey,
	type FailureDetail,
	GITHUB_URL_REGEX,
	normalizeBaseUrl,
	upsertComment,
	upsertCommentByMarker,
} from "./comment";
import type { ActionInputs, ActionOutputs, ChatErrorKind } from "./schemas";

export type Octokit = ReturnType<typeof getOctokit>;

/**
 * Clock abstracts wall-clock time so the polling loop can be driven by
 * a fake in tests. The default uses Date.now and setTimeout.
 */
export interface Clock {
	now(): number;
	sleep(ms: number): Promise<void>;
}

export const defaultClock: Clock = {
	now: () => Date.now(),
	sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};

/**
 * Polling cadence for wait=complete. Matches doc-check.yaml's loop.
 * Not exposed as an input.
 */
export const POLL_INTERVAL_MS = 5000;

// Maximum consecutive getChat failures tolerated by the polling loop
// before failing the action. The reference bash loop retries naturally
// on curl failure; the typed loop has to ride out transient outages
// (rolling deploys, brief 5xx) explicitly.
export const MAX_CONSECUTIVE_POLL_FAILURES = 3;

// Typed against ChatStatus so a typo in this list (e.g. "compleeted")
// fails the compile, instead of silently never matching and causing an
// infinite poll until timeout.
const TERMINAL_STATUSES: ReadonlySet<ChatStatus> = new Set<ChatStatus>([
	"waiting",
	"completed",
	"error",
]);

/**
 * Thrown when the chat fails or polling times out. `index.ts` routes this
 * through `setFailureOutputs` to populate `chat-error-*` and `chat-*`
 * outputs, then calls `core.setFailed`. `run()` also runs the failure
 * comment helper before re-throwing the error so a single comment
 * captures both classified API failures and wait-mode failures.
 */
export class ActionFailureError extends Error {
	constructor(
		public readonly kind: ChatErrorKind,
		message: string,
		public readonly chat?: CoderChat,
		options?: { cause?: unknown; chatId?: ChatId },
	) {
		super(message, options?.cause ? { cause: options.cause } : undefined);
		this.name = "ActionFailureError";
		this.chatId = options?.chatId ?? chat?.id;
	}

	// chat-id output. Falls back to options.chatId when chat is
	// undefined (e.g. transport failure on the first getChat).
	readonly chatId?: ChatId;

	// coder-username output. Decorated by run() once the user resolves.
	coderUsername?: string;

	// chat-url output. Decorated by run() once the chat URL is built.
	chatUrl?: string;
}

/**
 * Stringify an unknown thrown value for a wrapping error message. Library
 * code may throw `Error`s, bare strings, or arbitrary values.
 */
function describeError(err: unknown): string {
	if (err instanceof Error) {
		return err.message;
	}
	if (typeof err === "string") {
		return err;
	}
	try {
		return JSON.stringify(err);
	} catch {
		return String(err);
	}
}

/**
 * GitHub `author_association` values that map to repository write access in
 * the action's auto-resolve trust model. `OWNER` and `MEMBER` cover org
 * and personal-repo owners; `COLLABORATOR` covers invited collaborators.
 * Any other association (including `CONTRIBUTOR`, `FIRST_TIMER`,
 * `FIRST_TIME_CONTRIBUTOR`, `MANNEQUIN`, `NONE`) is treated as untrusted.
 *
 * See: https://docs.github.com/en/graphql/reference/enums#commentauthorassociation
 */
const TRUSTED_AUTHOR_ASSOCIATIONS = new Set([
	"OWNER",
	"MEMBER",
	"COLLABORATOR",
]);

/**
 * Structural subset of `@actions/github`'s `Context` covering the fields the
 * action reads. Production callers pass `github.context`; tests build
 * fixtures via `createMockContext`.
 *
 * The auto-resolve trust gate (`classifyAutoResolveTrust`) reads
 * `pull_request.head.repo` / `pull_request.base.repo` for fork detection,
 * and `comment.author_association` / `review.author_association` as the
 * sender-reliable trust signals. `issue.author_association` and
 * `pull_request.author_association` are typed on the payload for
 * completeness but the gate deliberately does not read them (they
 * describe the resource opener, not the event sender). Fields are
 * typed loosely because the full webhook schemas are large and
 * event-specific.
 */
export interface ActionContext {
	eventName: string;
	actor: string;
	payload: {
		sender?: {
			id?: number;
			[key: string]: unknown;
		};
		pull_request?: {
			author_association?: string;
			head?: {
				repo?: {
					fork?: boolean;
					full_name?: string;
					[key: string]: unknown;
				} | null;
				[key: string]: unknown;
			};
			base?: {
				repo?: {
					full_name?: string;
					[key: string]: unknown;
				} | null;
				[key: string]: unknown;
			};
			[key: string]: unknown;
		};
		issue?: {
			author_association?: string;
			[key: string]: unknown;
		};
		comment?: {
			author_association?: string;
			[key: string]: unknown;
		};
		review?: {
			author_association?: string;
			[key: string]: unknown;
		};
		[key: string]: unknown;
	};
}

/**
 * Outcome of the auto-resolve trust gate. `trusted` means the gate found a
 * repository-write-level signal and auto-resolve may proceed. `untrusted`
 * means the gate found a signal that fails the bar (fork PR, low-trust
 * association) and auto-resolve must refuse. `no-signal` means the
 * payload carried nothing the gate can act on, so the gate defers to
 * GitHub's underlying event-permission model (secret access, branch
 * protection, etc.).
 */
type TrustClassification =
	| { kind: "trusted"; reason: string }
	| { kind: "untrusted"; reason: string }
	| { kind: "no-signal" };

/**
 * Classify whether the triggering identity from `context` is trusted for
 * auto-resolve.
 *
 * Two layers of signal, applied in order:
 *
 * 1. Fork pull requests always refuse. An attacker who opens a PR from a
 *    fork must not be able to bind the workflow's Coder token to their
 *    own Coder identity (if they happen to have one) and execute
 *    attacker-controlled prompts. A `null` `head.repo` (deleted fork) is
 *    also treated as a fork: the only way `head.repo` becomes null is
 *    when the fork's source repository was deleted, which collapses the
 *    same-repo check below into a false negative.
 *
 * 2. `author_association` on `comment` or `review`, in that order. These
 *    are the only fields where the association describes the event
 *    *sender* rather than the resource *author*. On `issue_comment`,
 *    `comment.user` is the sender; on `pull_request_review`,
 *    `review.user` is the sender. By contrast, `issue.author_association`
 *    and `pull_request.author_association` describe the resource opener,
 *    not the labeler / assigner / reviewer who actually triggered the
 *    event. Reading them would refuse a trusted MEMBER labeling an
 *    issue opened by a NONE user.
 *
 * Returning `no-signal` is deliberate: events like `issues`,
 * `pull_request` (same-repo), `workflow_dispatch`, `push`, and
 * `repository_dispatch` carry no sender-association data the gate can
 * trust, and the underlying GitHub permission model already gates who
 * can trigger them. The trust gate is layered on top of, not in place
 * of, those controls.
 */
function classifyAutoResolveTrust(context: ActionContext): TrustClassification {
	const pr = context.payload.pull_request;
	if (pr) {
		const headRepo = pr.head?.repo;
		const baseRepo = pr.base?.repo;
		const headFullName = headRepo?.full_name;
		const baseFullName = baseRepo?.full_name;
		const isFork =
			headRepo === null ||
			headRepo?.fork === true ||
			(typeof headFullName === "string" &&
				typeof baseFullName === "string" &&
				headFullName !== baseFullName);
		if (isFork) {
			return {
				kind: "untrusted",
				reason:
					"the pull request is from a fork; auto-resolve refuses to bind " +
					"the workflow's Coder identity to a fork-PR author",
			};
		}
	}

	// Only read `author_association` from `comment` and `review`: those
	// are the only payload fields where the association describes the
	// event sender rather than the resource author. `issue` and
	// `pull_request` `author_association` describe the opener, which is
	// frequently NOT the sender (a MEMBER labeling an issue, an assignee
	// receiving an assignment, etc.).
	const associations: Array<{ source: string; value: unknown }> = [
		{ source: "comment", value: context.payload.comment?.author_association },
		{ source: "review", value: context.payload.review?.author_association },
	];
	for (const { source, value } of associations) {
		if (typeof value !== "string" || value.length === 0) {
			continue;
		}
		if (TRUSTED_AUTHOR_ASSOCIATIONS.has(value)) {
			return {
				kind: "trusted",
				reason: `${source}.author_association is ${value}`,
			};
		}
		return {
			kind: "untrusted",
			reason:
				`${source}.author_association is ${value}, which lacks ` +
				"repository write access",
		};
	}

	return { kind: "no-signal" };
}

export class CoderAgentChatAction {
	constructor(
		private readonly coder: CoderClient,
		private readonly octokit: Octokit,
		private readonly inputs: ActionInputs,
		private readonly context: ActionContext,
		private readonly clock: Clock = defaultClock,
	) {}

	/**
	 * Parse owner, repo, and item number from a GitHub issue or PR URL.
	 * The number namespace is shared between issues and PRs in a repo.
	 */
	parseGithubURL(): {
		githubOrg: string;
		githubRepo: string;
		githubIssueNumber: number;
	} {
		if (!this.inputs.githubURL) {
			throw new Error("Missing GitHub URL");
		}

		const match = this.inputs.githubURL.match(GITHUB_URL_REGEX);
		if (!match) {
			throw new Error(`Invalid GitHub URL: ${this.inputs.githubURL}`);
		}
		return {
			githubOrg: match[1],
			githubRepo: match[2],
			githubIssueNumber: parseInt(match[3], 10),
		};
	}

	/**
	 * Generate chat URL.
	 */
	generateChatUrl(chatId: ChatId): string {
		return `${normalizeBaseUrl(this.inputs.coderURL)}/chats/${chatId}`;
	}

	// Comment on the linked GitHub issue or pull request with the chat link
	// via the shared `upsertComment` helper. The predicate matches the
	// success-path "Agent chat:" prefix, distinct from the failure-comment
	// marker, so a successful re-run after a failed run currently leaves the
	// failure comment in place rather than collapsing both onto one comment
	// per target. Tracked in CODAGT-288.
	async commentOnIssue(
		chatUrl: string,
		owner: string,
		repo: string,
		issueNumber: number,
	): Promise<void> {
		const body = `Agent chat: ${chatUrl}`;
		await upsertComment({
			octokit: this.octokit,
			owner,
			repo,
			issueNumber,
			body,
			predicate: (comment) => comment.body?.startsWith("Agent chat:") ?? false,
		});
	}

	/**
	 * Warn loudly when the user opts in to inputs whose runtime behavior
	 * is not yet wired. The schema accepts these so the contract is stable;
	 * the warning prevents silent no-ops for workflow authors who explicitly
	 * opt in.
	 */
	warnUnwiredInputs(): void {
		if (this.inputs.idempotencyKey !== undefined) {
			core.warning(
				"`idempotency-key` is declared but not yet implemented; " +
					"the action will always create a new chat.",
			);
		}
		if (this.inputs.coderOrganization !== undefined) {
			core.warning(
				"`coder-organization` is declared but not yet wired through to " +
					"the API; the chat will be created without an explicit " +
					"organization.",
			);
		}
	}

	/**
	 * Build a rich ActionOutputs from a Chat response.
	 */
	buildOutputs(
		coderUsername: string,
		chat: CoderChat,
		chatCreated: boolean,
	): ActionOutputs {
		const diff = chat.diff_status;
		// Two nullish-handling patterns:
		//   `?? undefined` for `.nullable().optional()` fields.
		//   gated `hasPR ? ... : undefined` for `.default(0)` numerics, so
		//     a chat with diff_status but no PR yet does not emit a
		//     misleading truthy "0".
		const hasPR = diff?.pr_number != null;
		return {
			coderUsername,
			chatId: chat.id,
			chatUrl: this.generateChatUrl(chat.id),
			chatCreated,
			chatStatus: chat.status,
			chatTitle: chat.title,
			workspaceId: chat.workspace_id ?? undefined,
			pullRequestUrl: diff?.url ?? undefined,
			pullRequestState: diff?.pull_request_state ?? undefined,
			pullRequestTitle: diff?.pull_request_title ?? undefined,
			pullRequestNumber: diff?.pr_number ?? undefined,
			additions: hasPR ? diff?.additions : undefined,
			deletions: hasPR ? diff?.deletions : undefined,
			changedFiles: hasPR ? diff?.changed_files : undefined,
			headBranch: diff?.head_branch ?? undefined,
			baseBranch: diff?.base_branch ?? undefined,
			chatErrorMessage: chat.last_error ?? undefined,
		};
	}

	/**
	 * Poll the chat until terminal (waiting, completed, error) or
	 * timeout. Throws ActionFailureError on the `error` terminal so
	 * callers cannot mistake it for success.
	 *
	 * `requireNonTerminalFirst` defends against TOCTOU after a state-
	 * changing call (e.g. createChatMessage to a chat already in
	 * `waiting`): the first poll may see the pre-message status before
	 * the agent transitions. When set, the loop requires at least one
	 * non-terminal observation before accepting any terminal.
	 */
	async waitForTerminal(
		chatId: ChatId,
		options: { requireNonTerminalFirst?: boolean } = {},
	): Promise<CoderChat> {
		const timeoutMs = this.inputs.waitTimeoutSeconds * 1000;
		const startedAt = this.clock.now();
		let latest: CoderChat | undefined;
		let sawNonTerminal = !options.requireNonTerminalFirst;
		let firstTerminal: ChatStatus | undefined;
		let consecutiveFailures = 0;

		// Poll-first-then-sleep mirrors doc-check.yaml's bash loop: 3 polls
		// means 2 sleeps.
		while (true) {
			try {
				latest = await this.coder.getChat(chatId);
				consecutiveFailures = 0;
			} catch (err) {
				consecutiveFailures++;
				const message = err instanceof Error ? err.message : String(err);
				if (consecutiveFailures >= MAX_CONSECUTIVE_POLL_FAILURES) {
					// Wrap transport failures (network, 5xx, auth) so workflows
					// branching on chat-error-kind see api_error rather than a
					// plain Error. Forward chatId explicitly so chat-id is set
					// even when no fresh chat object is available.
					throw new ActionFailureError(
						"api_error",
						`Polling chat ${chatId} failed after ${consecutiveFailures} attempts: ${message}`,
						undefined,
						{ cause: err, chatId },
					);
				}
				// Transient failure: log and ride it out, mirroring the
				// reference bash loop's natural retry on curl failure.
				core.warning(
					`Poll ${consecutiveFailures}/${MAX_CONSECUTIVE_POLL_FAILURES} for chat ${chatId} failed: ${message}`,
				);
			}

			if (latest && consecutiveFailures === 0) {
				core.info(`Chat status: ${latest.status}`);

				const isTerminal = TERMINAL_STATUSES.has(latest.status);
				if (isTerminal) {
					if (sawNonTerminal) {
						return this.throwOnChatError(latest);
					}
					// requireNonTerminalFirst is true and we have not seen a
					// non-terminal status yet. Record the first terminal we
					// see; accept any later poll that observes a different
					// terminal. This catches a fast follow-up message that
					// transitions waiting -> completed (or -> error) within
					// one poll interval, which would otherwise look stale.
					if (firstTerminal === undefined) {
						firstTerminal = latest.status;
					} else if (latest.status !== firstTerminal) {
						return this.throwOnChatError(latest);
					}
				} else {
					sawNonTerminal = true;
				}
			}

			const elapsedMs = this.clock.now() - startedAt;
			if (elapsedMs >= timeoutMs) {
				throw new ActionFailureError(
					"timeout",
					this.timeoutMessage(chatId, latest, sawNonTerminal),
					latest,
					{ chatId },
				);
			}

			await this.clock.sleep(POLL_INTERVAL_MS);
		}
	}

	private timeoutMessage(
		chatId: ChatId,
		latest: CoderChat | undefined,
		sawNonTerminal: boolean,
	): string {
		// requireNonTerminalFirst was set, the chat never left its starting
		// terminal status, and the timeout fired. The agent likely did not
		// process the follow-up message at all; surface that explicitly.
		if (!sawNonTerminal && latest) {
			return (
				`Chat ${chatId} remained in terminal status \`${latest.status}\` ` +
				`for the entire ${this.inputs.waitTimeoutSeconds}s wait window; ` +
				"the agent may not have processed the follow-up message."
			);
		}
		return `Timed out after ${this.inputs.waitTimeoutSeconds}s waiting for chat ${chatId} to reach a terminal status`;
	}

	/**
	 * Throw when a terminal chat ended in `error`; pass `waiting` and
	 * `completed` through unchanged. The `api_error` kind is coarse:
	 * a workflow branching on it cannot distinguish chat-level failures
	 * from polling-transport failures. CODAGT-290 will refine the
	 * mapping by inspecting `last_error`.
	 */
	private throwOnChatError(chat: CoderChat): CoderChat {
		if (chat.status === "error") {
			const message = chat.last_error || "Chat ended in error state";
			throw new ActionFailureError("api_error", message, chat);
		}
		return chat;
	}

	/**
	 * Wrap waitForTerminal so a thrown ActionFailureError carries the
	 * at-creation context (chat-id, chat-status, chat-url, coder-
	 * username). On a transport failure during the first getChat,
	 * error.chat is undefined; fill it from the at-creation snapshot.
	 */
	private async pollWithContext(
		chatId: ChatId,
		context: {
			coderUsername: string;
			chatUrl: string;
			atCreation?: CoderChat;
		},
		options?: { requireNonTerminalFirst?: boolean },
	): Promise<CoderChat> {
		try {
			return await this.waitForTerminal(chatId, options);
		} catch (err) {
			if (err instanceof ActionFailureError) {
				if (!err.chat && context.atCreation) {
					// chat is set in the constructor, so rebuild with the
					// at-creation snapshot, then carry the decoration over.
					const rewrapped = new ActionFailureError(
						err.kind,
						err.message,
						context.atCreation,
						{ cause: err.cause, chatId },
					);
					rewrapped.coderUsername = context.coderUsername;
					rewrapped.chatUrl = context.chatUrl;
					throw rewrapped;
				}
				err.coderUsername = context.coderUsername;
				err.chatUrl = context.chatUrl;
			}
			throw err;
		}
	}

	/**
	 * Resolve the Coder username to run as. Resolution order, high to low:
	 *
	 * 1. `coder-username` input.
	 * 2. `github-user-id` input.
	 * 3. `context.payload.sender.id` (issue, pull request, comment, and most
	 *    webhook-driven events that carry the triggering user under `sender`).
	 * 4. `context.actor` for events whose payload lacks a usable `sender.id`
	 *    (partial sender objects, bot dispatches, custom dispatch chains).
	 *    Resolved to a numeric id via `octokit.rest.users.getByUsername`,
	 *    then to a Coder user.
	 *
	 * `schedule` events are refused before any auto-resolve source: their
	 * `actor` is the workflow file's last editor, not a triggering identity.
	 *
	 * Throws naming both inputs when no source resolves. Intermediate
	 * failures are wrapped to name the auto-resolved source, preserve the
	 * upstream error, and recommend `coder-username` as the bypass.
	 *
	 * Before sources 3 and 4, a trust gate (`classifyAutoResolveTrust`)
	 * refuses auto-resolve for fork pull requests and for triggering
	 * identities whose `comment.author_association` or
	 * `review.author_association` lacks repository write access (anything
	 * other than `OWNER`, `MEMBER`, `COLLABORATOR`). This prevents a
	 * hostile-trigger attack where an attacker who happens to have a
	 * Coder identity could open a fork PR or drop a comment to bind
	 * their Coder identity to the workflow and execute
	 * attacker-controlled prompts under the workflow's Coder session
	 * token. Setting `coder-username` or `github-user-id` bypasses the
	 * trust gate: the workflow author has explicitly chosen the identity.
	 */
	async resolveCoderUsername(): Promise<string> {
		if (this.inputs.coderUsername) {
			core.info(`Using provided Coder username: ${this.inputs.coderUsername}`);
			return this.inputs.coderUsername;
		}
		if (this.inputs.githubUserID !== undefined) {
			core.info(
				`Looking up Coder user by GitHub user ID: ${this.inputs.githubUserID}`,
			);
			const coderUser = await this.coder.getCoderUserByGitHubId(
				this.inputs.githubUserID,
			);
			return coderUser.username;
		}

		// Refuse before any auto-resolve source so the exclusion is semantic,
		// not an artifact of source ordering. Today's `schedule` payloads
		// omit `sender`, but a future shape that delivered it would still
		// describe the underlying webhook trigger, not the cron run.
		if (this.context.eventName === "schedule") {
			throw new Error(
				"Cannot auto-resolve a GitHub identity for `schedule` events: " +
					"`github.context.actor` for cron-triggered runs is the workflow " +
					"file's last editor, not the triggering user. " +
					"Set the `coder-username` input to a Coder username, or set " +
					"`github-user-id` to the GitHub numeric user id of the user the " +
					"chat should run as.",
			);
		}

		// Trust gate: before auto-resolving from `sender.id` or `actor`,
		// refuse if the triggering identity comes from a fork PR or carries a
		// low-trust `author_association`. Without this gate, an attacker who
		// happens to have a Coder identity could open a fork PR or drop an
		// issue comment to bind their Coder identity to the workflow and
		// execute attacker-controlled prompts under the workflow's Coder
		// token. Explicit `coder-username` and `github-user-id` inputs are
		// handled above and bypass this gate by design.
		const trust = classifyAutoResolveTrust(this.context);
		if (trust.kind === "untrusted") {
			throw new Error(
				"Refusing to auto-resolve a GitHub identity: " +
					`${trust.reason}. ` +
					"Set the `coder-username` input to a Coder username, or set " +
					"`github-user-id` to the GitHub numeric user id of the user " +
					"the chat should run as.",
			);
		}
		if (trust.kind === "trusted") {
			core.info(`Auto-resolve trust check passed: ${trust.reason}`);
		}

		// Prefer `sender.id` over `actor`: it's already numeric, no extra
		// API call. The guard mirrors `z.number().int().positive()` on the
		// `github-user-id` input.
		const senderId = this.context.payload?.sender?.id;
		if (
			typeof senderId === "number" &&
			Number.isInteger(senderId) &&
			senderId > 0
		) {
			core.info(
				`Auto-resolving Coder user from github.context.payload.sender.id: ${senderId}`,
			);
			try {
				const coderUser = await this.coder.getCoderUserByGitHubId(senderId);
				return coderUser.username;
			} catch (err) {
				throw new Error(
					`Failed to resolve Coder user from github.context.payload.sender.id (${senderId}): ${describeError(err)}. ` +
						"Set the `coder-username` input to bypass auto-resolution.",
				);
			}
		}

		// Actor fallback for events whose payload lacks a usable `sender.id`.
		// `workflow_dispatch` payloads do include `sender.id`, so source 3
		// handles it; this branch covers partial sender objects, bot
		// dispatches, and custom dispatch chains.
		const actor = this.context.actor;
		if (actor) {
			core.info(
				`Auto-resolving Coder user from github.context.actor: ${actor}`,
			);
			let actorId: number;
			try {
				const { data } = await this.octokit.rest.users.getByUsername({
					username: actor,
				});
				actorId = data.id;
			} catch (err) {
				throw new Error(
					`Failed to resolve GitHub user id for github.context.actor (${actor}): ${describeError(err)}. ` +
						"Set the `coder-username` input to bypass auto-resolution.",
				);
			}
			try {
				const coderUser = await this.coder.getCoderUserByGitHubId(actorId);
				return coderUser.username;
			} catch (err) {
				throw new Error(
					`Failed to resolve Coder user for github.context.actor (${actor}, GitHub user id ${actorId}): ${describeError(err)}. ` +
						"Set the `coder-username` input to bypass auto-resolution.",
				);
			}
		}

		throw new Error(
			"Could not auto-resolve a GitHub identity from the workflow context. " +
				"Set the `coder-username` input to a Coder username, or set " +
				"`github-user-id` to the GitHub numeric user id of the user the " +
				"chat should run as.",
		);
	}

	// Run the action. Failures funnel through `handleFailure` which posts
	// the failure-path comment, then re-throw the (possibly enriched)
	// ActionFailureError so the outer catch in `index.ts` populates
	// chat-error-* outputs via setFailureOutputs and calls setFailed.
	async run(): Promise<ActionOutputs> {
		try {
			return await this.runInner();
		} catch (error) {
			let failure: ActionFailureError;
			try {
				failure = await this.handleFailure(error);
			} catch (handlerError) {
				// If the handler itself throws (e.g. a broken GHA runtime
				// makes core.setOutput reject), log it and re-raise the
				// original error so the workflow surfaces the actual failure.
				core.error(`Failure-path handler errored: ${handlerError}`);
				throw error;
			}
			throw failure;
		}
	}

	// Post the failure comment and return the (possibly re-classified)
	// ActionFailureError. Output emission and `setFailed` are deliberately
	// left to `index.ts` so OUTPUT_MAP stays the single source of truth and
	// `process.exitCode` does not flip mid-test. An `ActionFailureError`
	// thrown by the wait path is preserved verbatim; any other error is
	// classified via comment.ts and wrapped in a fresh ActionFailureError so
	// the failure-path output contract is uniform.
	private async handleFailure(error: unknown): Promise<ActionFailureError> {
		// `detail` is the comment-body shape; `failure` is the thrown shape.
		// Classify first so spend-exceeded fields land in the comment body
		// for both raw-Error and ActionFailureError inputs.
		const detail: FailureDetail = classifyError(error);
		const failure =
			error instanceof ActionFailureError
				? error
				: new ActionFailureError(detail.kind, detail.message, undefined, {
						cause: error,
					});

		if (!this.inputs.commentOnIssue) {
			return failure;
		}
		let target: {
			githubOrg: string;
			githubRepo: string;
			githubIssueNumber: number;
		};
		try {
			target = this.parseGithubURL();
		} catch (parseError) {
			core.error(
				`Cannot post failure comment: github-url is malformed (${parseError})`,
			);
			return failure;
		}

		// `GITHUB_WORKFLOW` is set by the runner to the workflow's `name:`
		// field. We read it here, not in `deriveCommentKey`, so the helper
		// stays pure and tests stay deterministic.
		const workflow = process.env.GITHUB_WORKFLOW || undefined;
		const marker = buildCommentMarker(
			deriveCommentKey({ ...this.inputs, workflow }),
		);
		const body = buildFailureCommentBody(detail, {
			chatsUrl: buildDeploymentChatsUrl(this.inputs.coderURL),
			marker,
		});
		await upsertCommentByMarker({
			octokit: this.octokit,
			owner: target.githubOrg,
			repo: target.githubRepo,
			issueNumber: target.githubIssueNumber,
			body,
			marker,
		});
		return failure;
	}

	private async runInner(): Promise<ActionOutputs> {
		this.warnUnwiredInputs();

		const coderUsername = await this.resolveCoderUsername();

		const { githubOrg, githubRepo, githubIssueNumber } = this.parseGithubURL();
		core.info(`GitHub owner: ${githubOrg}`);
		core.info(`GitHub repo: ${githubRepo}`);
		core.info(`GitHub item number: ${githubIssueNumber}`);
		core.info(`Coder username: ${coderUsername}`);

		// If an existing chat ID is provided, send a message to it
		if (this.inputs.existingChatId) {
			core.info(
				`Sending message to existing chat: ${this.inputs.existingChatId}`,
			);
			const chatId = this.inputs.existingChatId as ChatId;

			await this.coder.createChatMessage(chatId, {
				content: [{ type: "text", text: this.inputs.chatPrompt }],
				model_config_id: this.inputs.modelConfigId,
			});
			core.info("Message sent successfully");

			const chatUrl = this.generateChatUrl(chatId);

			// wait=complete polls until terminal. requireNonTerminalFirst
			// defends against TOCTOU when sending a follow-up to a chat
			// already in a terminal status (e.g. waiting): the first poll
			// may see the pre-message status before the agent transitions.
			//
			// wait=none does a best-effort one-shot fetch; on fetch failure
			// log a warning and fall back to minimal outputs. The follow-up
			// message is already on the wire.
			let chat: CoderChat | undefined;
			if (this.inputs.wait === "complete") {
				core.info(
					`Waiting for chat to reach terminal status (timeout: ${this.inputs.waitTimeoutSeconds}s)...`,
				);
				chat = await this.pollWithContext(
					chatId,
					{ coderUsername, chatUrl },
					{ requireNonTerminalFirst: true },
				);
				core.info(`Chat reached terminal status: ${chat.status}`);
			} else {
				try {
					chat = await this.coder.getChat(chatId);
					core.info(`Chat status: ${chat.status}, title: ${chat.title}`);
				} catch (error) {
					core.warning(
						`Failed to fetch chat after sending message; outputs will be minimal: ${error}`,
					);
				}
			}

			if (this.inputs.commentOnIssue) {
				core.info(
					`Commenting on issue ${githubOrg}/${githubRepo}#${githubIssueNumber}`,
				);
				await this.commentOnIssue(
					chatUrl,
					githubOrg,
					githubRepo,
					githubIssueNumber,
				);
			}

			if (chat) {
				return this.buildOutputs(coderUsername, chat, false);
			}
			return {
				coderUsername,
				chatId,
				chatUrl,
				chatCreated: false,
			};
		}

		// Create a new chat
		core.info("Creating new agent chat...");
		const req: CreateChatRequest = {
			content: [{ type: "text", text: this.inputs.chatPrompt }],
			workspace_id: this.inputs.workspaceId,
			model_config_id: this.inputs.modelConfigId,
		};

		const createdChat = await this.coder.createChat(req);
		core.info(
			`Agent chat created successfully (id: ${createdChat.id}, status: ${createdChat.status})`,
		);

		const chatUrl = this.generateChatUrl(createdChat.id);
		core.info(`Chat URL: ${chatUrl}`);

		// Poll before commenting so wait=complete posts only after the
		// chat reaches a terminal state. No mid-poll comment updates.
		let finalChat = createdChat;
		if (this.inputs.wait === "complete") {
			core.info(
				`Waiting for chat to reach terminal status (timeout: ${this.inputs.waitTimeoutSeconds}s)...`,
			);
			finalChat = await this.pollWithContext(createdChat.id, {
				coderUsername,
				chatUrl,
				atCreation: createdChat,
			});
			core.info(`Chat reached terminal status: ${finalChat.status}`);
		}

		if (this.inputs.commentOnIssue) {
			core.info(
				`Commenting on issue ${githubOrg}/${githubRepo}#${githubIssueNumber}`,
			);
			await this.commentOnIssue(
				chatUrl,
				githubOrg,
				githubRepo,
				githubIssueNumber,
			);
		} else {
			core.info("Skipping comment on issue (commentOnIssue is false)");
		}

		return this.buildOutputs(coderUsername, finalChat, true);
	}
}
