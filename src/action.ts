import * as core from "@actions/core";
import type { getOctokit } from "@actions/github";
import { ChatIdSchema, CoderAPIError } from "./coder-client";
import type {
	ChatId,
	ChatStatus,
	CoderChat,
	CoderClient,
	CoderSDKUser,
	CreateChatRequest,
} from "./coder-client";
import {
	ACTION_LABEL_KEYS,
	RESERVED_LABEL_KEYS,
	sanitizeLabelKey,
} from "./sanitize-label-key";
import {
	buildCommentMarker,
	buildDeploymentAgentsUrl,
	buildFailureCommentBody,
	buildSuccessCommentBody,
	classifyError,
	deriveCommentKey,
	type FailureDetail,
	GITHUB_URL_REGEX,
	normalizeBaseUrl,
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

	// acting-coder-username output. Decorated by run() once the user resolves.
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
 * Identity-resolution source labels the divergence check reads to decide
 * whether to warn. `acting-coder-username` and `acting-github-user-id` are explicit
 * workflow inputs; `sender` and `actor` are auto-resolved from
 * `github.context`; `token` is the `users/me` fallback (same user as the
 * token holder, so divergence is impossible by construction).
 */
type IdentitySource =
	| "acting-coder-username"
	| "acting-github-user-id"
	| "sender"
	| "actor"
	| "token";

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
		return `${normalizeBaseUrl(this.inputs.coderURL)}/agents/${chatId}`;
	}

	// Post or update the success comment on the linked issue or pull
	// request. Shares the marker with the failure-path comment so re-runs
	// after a failure replace the failure comment in place rather than
	// stacking. The marker is computed the same way as in `handleFailure`
	// (`GITHUB_WORKFLOW`-scoped unless `idempotency-key` is set).
	//
	// `hasPR` gates `pullRequestUrl` and the diff numerics so a chat with
	// `diff_status` but no PR yet (`pr_number == null`) does not render a
	// misleading comparison URL labelled "Pull request:" or "+0 additions"
	// lines from the Zod-default zeros. `buildOutputs` intentionally
	// diverges: it emits `diff?.url` unconditionally so callers can read a
	// comparison URL when no PR exists yet.
	async commentOnIssue(args: {
		chatUrl: string;
		owner: string;
		repo: string;
		issueNumber: number;
		chatCreated: boolean;
		chat?: CoderChat;
	}): Promise<void> {
		// `GITHUB_WORKFLOW` is read at the call site so `deriveCommentKey`
		// stays pure and tests stay deterministic.
		const workflow = process.env.GITHUB_WORKFLOW || undefined;
		const marker = buildCommentMarker(
			deriveCommentKey({ ...this.inputs, workflow }),
		);
		const diff = args.chat?.diff_status;
		const hasPR = diff?.pr_number != null;
		const body = buildSuccessCommentBody({
			chatUrl: args.chatUrl,
			chatStatus: args.chat?.status,
			marker,
			waitMode: this.inputs.wait === "complete" ? "complete" : "none",
			chatCreated: args.chatCreated,
			pullRequestUrl: hasPR ? (diff?.url ?? undefined) : undefined,
			additions: hasPR ? (diff?.additions ?? undefined) : undefined,
			deletions: hasPR ? (diff?.deletions ?? undefined) : undefined,
			changedFiles: hasPR ? (diff?.changed_files ?? undefined) : undefined,
		});
		await upsertCommentByMarker({
			octokit: this.octokit,
			owner: args.owner,
			repo: args.repo,
			issueNumber: args.issueNumber,
			body,
			marker,
		});
	}

	/**
	 * Warn loudly when the user opts in to inputs whose runtime behavior
	 * is not yet wired. The schema accepts these so the contract is stable;
	 * the warning prevents silent no-ops for workflow authors who explicitly
	 * opt in.
	 */
	warnUnwiredInputs(): void {
		// All v0 inputs are now wired. The helper remains for the test
		// suite import and future unwired inputs.
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
	 * Resolve the Coder username the action runs as for org-pick and the
	 * per-user reuse label. Resolution order, high to low:
	 *
	 * 1. `acting-coder-username` input.
	 * 2. `acting-github-user-id` input.
	 * 3. `context.payload.sender.id` (issue, pull request, comment, and most
	 *    webhook-driven events that carry the triggering user under `sender`).
	 * 4. `context.actor` for events whose payload lacks a usable `sender.id`
	 *    (partial sender objects, bot dispatches, custom dispatch chains).
	 *    Resolved to a numeric id via `octokit.rest.users.getByUsername`,
	 *    then to a Coder user.
	 * 5. `GET /api/v2/users/me` against the configured `coder-token`. The
	 *    chat owner on `POST /api/experimental/chats` is always the token
	 *    holder; for events with no usable github.context signal (schedule,
	 *    a workflow_dispatch with no sender or actor), the token owner is
	 *    the only identity we can attribute the run to.
	 *
	 * Sources 3 and 4 are gated by `classifyAutoResolveTrust`. Fork pull
	 * requests and triggering identities whose `comment.author_association`
	 * or `review.author_association` lacks repository write access cause the
	 * gate to refuse: the action throws and does NOT fall through to
	 * `users/me`, because a hostile-trigger event should not silently
	 * collapse onto the token owner. The gate protects the acting user used
	 * for org-pick and the per-user reuse label (`coder-agents-chat-action-user`),
	 * not the chat owner (which is fixed by the token).
	 *
	 * `schedule` events skip sources 3 and 4 directly: their `actor` is the
	 * workflow file's last editor and their payload carries no triggering
	 * identity. They proceed to `users/me`.
	 *
	 * Returns `{ username, user, source }`. `source` lets the caller decide
	 * whether to run the token-owner vs acting-user divergence check.
	 * `resolveOrganizationID` reuses `user` to read `organization_ids`
	 * without a redundant lookup.
	 */
	async resolveCoderUsername(): Promise<{
		username: string;
		user: CoderSDKUser;
		source: IdentitySource;
	}> {
		if (this.inputs.coderUsername) {
			core.info(
				`Using provided Coder username for acting user: ${this.inputs.coderUsername}`,
			);
			// Fetch the full user so `user.id` is available downstream for
			// the `coder-agents-chat-action-user` per-user reuse scope.
			let coderUser: CoderSDKUser;
			try {
				coderUser = await this.coder.getCoderUserByUsername(
					this.inputs.coderUsername,
				);
			} catch (err) {
				// Symmetric with the named-org 404 wrap in `resolveOrganizationID`.
				if (err instanceof CoderAPIError && err.statusCode === 404) {
					throw new ActionFailureError(
						"user_not_found",
						`Coder user '${this.inputs.coderUsername}' not found. ` +
							"Check the `acting-coder-username` input value.",
						undefined,
						{ cause: err },
					);
				}
				throw err;
			}
			return {
				username: coderUser.username,
				user: coderUser,
				source: "acting-coder-username",
			};
		}
		if (this.inputs.githubUserID !== undefined) {
			core.info(
				`Looking up Coder user by GitHub user ID: ${this.inputs.githubUserID}`,
			);
			const coderUser = await this.coder.getCoderUserByGitHubId(
				this.inputs.githubUserID,
			);
			return {
				username: coderUser.username,
				user: coderUser,
				source: "acting-github-user-id",
			};
		}

		// `schedule` skips the sender/actor branches: the actor on a cron run
		// is the workflow file's last editor, and the payload carries no
		// triggering identity. The trust gate would return `no-signal` and
		// the action proceeds to `users/me` below.
		const isSchedule = this.context.eventName === "schedule";

		if (!isSchedule) {
			// Trust gate: before auto-resolving from `sender.id` or `actor`,
			// refuse if the triggering identity comes from a fork PR or carries
			// a low-trust `author_association`. This protects the acting user
			// used for org-pick and the per-user reuse label
			// (`coder-agents-chat-action-user`) from pollution by untrusted
			// triggers. The chat owner is the `coder-token` holder regardless
			// of the gate's verdict. Explicit `acting-coder-username` and
			// `acting-github-user-id` inputs are handled above and bypass this gate by
			// design; on refusal the action does NOT fall through to `users/me`
			// because a hostile-trigger event should not silently collapse onto
			// the token owner.
			const trust = classifyAutoResolveTrust(this.context);
			if (trust.kind === "untrusted") {
				throw new Error(
					"Refusing to auto-resolve a GitHub identity: " +
						`${trust.reason}. ` +
						"Set the `acting-coder-username` input to a Coder username, or set " +
						"`acting-github-user-id` to the GitHub numeric user id of the user " +
						"to use as the acting user (for org pick and the per-user reuse label).",
				);
			}
			if (trust.kind === "trusted") {
				core.info(`Auto-resolve trust check passed: ${trust.reason}`);
			} else {
				// no-signal: events like `issues`, `push`, same-repo
				// `pull_request`, and `workflow_dispatch` carry no sender-
				// association data the gate can act on. Log so an operator
				// debugging identity resolution can tell the gate ran and
				// deferred, rather than being skipped.
				core.info(
					"Auto-resolve trust gate found no signal in the event payload; " +
						"deferring to GitHub's event-permission model.",
				);
			}

			// Prefer `sender.id` over `actor`: it's already numeric, no extra
			// API call. The guard mirrors `z.number().int().positive()` on the
			// `acting-github-user-id` input.
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
					return {
						username: coderUser.username,
						user: coderUser,
						source: "sender",
					};
				} catch (err) {
					throw new Error(
						`Failed to resolve Coder user from github.context.payload.sender.id (${senderId}): ${describeError(err)}. ` +
							"Set the `acting-coder-username` input to bypass auto-resolution.",
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
							"Set the `acting-coder-username` input to bypass auto-resolution.",
					);
				}
				try {
					const coderUser = await this.coder.getCoderUserByGitHubId(actorId);
					return {
						username: coderUser.username,
						user: coderUser,
						source: "actor",
					};
				} catch (err) {
					throw new Error(
						`Failed to resolve Coder user for github.context.actor (${actor}, GitHub user id ${actorId}): ${describeError(err)}. ` +
							"Set the `acting-coder-username` input to bypass auto-resolution.",
					);
				}
			}
		}

		// Final fallback: derive the acting user from the `coder-token` via
		// `GET /api/v2/users/me`. The chat already runs as this user; using
		// the same identity for org-pick and the per-user reuse label keeps
		// runs without explicit inputs (and `schedule` runs) attributable.
		core.info(
			"No GitHub identity input or workflow-context signal was usable; " +
				"falling back to the `coder-token` owner via GET /api/v2/users/me.",
		);
		let tokenOwner: CoderSDKUser;
		try {
			tokenOwner = await this.getTokenOwner();
		} catch (err) {
			throw new Error(
				`Failed to resolve the \`coder-token\` owner via GET /api/v2/users/me: ${describeError(err)}. ` +
					"Set the `acting-coder-username` input to a Coder username, or set " +
					"`acting-github-user-id` to the GitHub numeric user id of the user to " +
					"use as the acting user (for org pick and the per-user reuse label).",
			);
		}
		return {
			username: tokenOwner.username,
			user: tokenOwner,
			source: "token",
		};
	}

	/**
	 * Lazily fetch and memoize the `coder-token` owner. Used both as the
	 * lowest-priority identity-resolution fallback and as the source of
	 * truth for the token-owner vs acting-user divergence warning.
	 */
	private tokenOwnerCache: CoderSDKUser | undefined;
	private async getTokenOwner(): Promise<CoderSDKUser> {
		if (this.tokenOwnerCache) {
			return this.tokenOwnerCache;
		}
		const user = await this.coder.getAuthenticatedUser();
		this.tokenOwnerCache = user;
		return user;
	}

	/**
	 * When an explicit identity input was provided, compare the resolved
	 * acting user to the `coder-token` owner and warn on divergence. The
	 * chat is owned by the token holder regardless of the resolved acting
	 * user; if they differ, the trust gate, the per-user reuse label, and
	 * the org pick are all protecting an identity that is not the chat
	 * owner. The workflow author should know.
	 *
	 * Suppressed for sources `sender`, `actor`, and `token` itself: those
	 * paths either derive the user from event context (the divergence is
	 * informational, not a workflow-author error) or already match the
	 * token by definition.
	 */
	private async warnOnTokenOwnerDivergence(resolved: {
		username: string;
		user: CoderSDKUser;
		source: IdentitySource;
	}): Promise<void> {
		if (
			resolved.source !== "acting-coder-username" &&
			resolved.source !== "acting-github-user-id"
		) {
			return;
		}
		let tokenOwner: CoderSDKUser;
		try {
			tokenOwner = await this.getTokenOwner();
		} catch (err) {
			// The divergence check is best-effort. A `users/me` failure here
			// would also break createChat (same token), so let the action
			// keep going and surface that failure at the createChat call site.
			core.warning(
				`Could not fetch the \`coder-token\` owner for the token-owner divergence check: ${describeError(err)}. ` +
					"Continuing; the chat will still be owned by whoever the token belongs to.",
			);
			return;
		}
		if (tokenOwner.id === resolved.user.id) {
			return;
		}
		core.warning(
			`The resolved acting user '${resolved.username}' differs from the \`coder-token\` owner '${tokenOwner.username}'. ` +
				"The chat is owned by the token holder; the acting user only " +
				"selects the organization and the per-user reuse label. Confirm " +
				"the token belongs to the user you intended.",
		);
	}

	/**
	 * Resolve the organization id to send on createChat. Resolution order:
	 *
	 * 1. `coder-organization` input, looked up by name via
	 *    `GET /api/v2/organizations/{name}`. Recommended when the user
	 *    belongs to more than one organization, since the fallback choice
	 *    is non-deterministic; a `core.warning` is emitted in that case.
	 * 2. The resolved Coder user's `organization_ids[0]`. `resolveCoderUsername`
	 *    always returns a resolved user object (across every identity
	 *    source); this helper reuses it. The lookup-by-username branch
	 *    below is defensive: it only fires when a future caller passes
	 *    `resolvedUser === undefined`, which the current code path does
	 *    not do.
	 *
	 * Throws `ActionFailureError("org_not_found")` when `coder-organization`
	 * names an org that does not exist (HTTP 404) or the resolved user has no
	 * org memberships. Throws `ActionFailureError("user_not_found")` when only
	 * `acting-coder-username` is set and the user is missing (HTTP 404). Other API
	 * errors propagate as `CoderAPIError`. The original error is attached via
	 * `options.cause` on every wrap; `run()`'s `handleFailure` re-classifies
	 * the failure into the failure-path comment.
	 */
	async resolveOrganizationID(
		coderUsername: string,
		resolvedUser: CoderSDKUser | undefined,
	): Promise<string> {
		if (this.inputs.coderOrganization) {
			core.info(
				`Resolving Coder organization by name: ${this.inputs.coderOrganization}`,
			);
			try {
				const org = await this.coder.getOrganizationByName(
					this.inputs.coderOrganization,
				);
				return org.id;
			} catch (err) {
				// 404 = the named org does not exist; surface as `org_not_found`.
				// Other CoderAPIErrors (auth, network, etc.) propagate as-is.
				if (err instanceof CoderAPIError && err.statusCode === 404) {
					throw new ActionFailureError(
						"org_not_found",
						`Coder organization '${this.inputs.coderOrganization}' not found. ` +
							"Check the `coder-organization` input value.",
						undefined,
						{ cause: err },
					);
				}
				throw err;
			}
		}

		// Default to the user's first org membership. Fetch the user lazily
		// when only `acting-coder-username` was provided; wrap a 404 into
		// `user_not_found` symmetrically with the named-org 404 above.
		let user: CoderSDKUser;
		if (resolvedUser) {
			user = resolvedUser;
		} else {
			try {
				user = await this.coder.getCoderUserByUsername(coderUsername);
			} catch (err) {
				if (err instanceof CoderAPIError && err.statusCode === 404) {
					throw new ActionFailureError(
						"user_not_found",
						`Coder user '${coderUsername}' not found. ` +
							"Check the `acting-coder-username` input value.",
						undefined,
						{ cause: err },
					);
				}
				throw err;
			}
		}
		const orgID = user.organization_ids[0];
		if (!orgID) {
			throw new ActionFailureError(
				"org_not_found",
				`Coder user '${user.username}' has no organization memberships. ` +
					"Set the `coder-organization` input to the organization the chat " +
					"should run in.",
			);
		}
		if (user.organization_ids.length > 1) {
			// `organization_ids` is server-built via `array_agg` with no
			// `ORDER BY`, so the choice is non-deterministic across vacuums and
			// restarts. Recommend pinning via `coder-organization`.
			core.warning(
				`Coder user '${user.username}' has ${user.organization_ids.length} organization memberships; ` +
					`defaulting to ${orgID}. ` +
					"This choice is non-deterministic. Set the `coder-organization` input to pin it.",
			);
		}
		core.info(
			`Defaulting to first organization membership of Coder user '${user.username}': ${orgID}`,
		);
		return orgID;
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
			agentsUrl: buildDeploymentAgentsUrl(this.inputs.coderURL),
			marker,
			chatUrl: failure.chatUrl,
			chatStatus: failure.chat?.status,
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

		const {
			username: coderUsername,
			user: resolvedUser,
			source: identitySource,
		} = await this.resolveCoderUsername();
		core.info(
			`Resolved acting Coder user: '${coderUsername}' (source: ${identitySource})`,
		);
		await this.warnOnTokenOwnerDivergence({
			username: coderUsername,
			user: resolvedUser,
			source: identitySource,
		});

		const { githubOrg, githubRepo, githubIssueNumber } = this.parseGithubURL();
		core.info(`GitHub owner: ${githubOrg}`);
		core.info(`GitHub repo: ${githubRepo}`);
		core.info(`GitHub item number: ${githubIssueNumber}`);

		// If an existing chat ID is provided, send a message to it
		if (this.inputs.existingChatId) {
			core.info(
				`Sending message to existing chat: ${this.inputs.existingChatId}`,
			);
			// Narrow the already-validated string to the branded `ChatId` via
			// `.parse()` instead of the previous unsafe `as ChatId` cast.
			// `ActionInputsSchema` validates `existingChatId` as a UUID up in
			// `index.ts`, so `.parse()` here is the branding step (and a
			// defense-in-depth check if a future caller bypasses that schema).
			const chatId = ChatIdSchema.parse(this.inputs.existingChatId);
			return this.runFollowUp({
				coderUsername,
				chatId,
				preMessageChat: undefined,
				githubOrg,
				githubRepo,
				githubIssueNumber,
			});
		}

		// Chat reuse: the action reuses the most recent non-archived chat
		// scoped to this `gh-target`, the resolved Coder user, and the
		// workflow name (when `GITHUB_WORKFLOW` is set), so re-runs and
		// follow-up triggers converge on one chat per target/user/workflow.
		// `force-new-chat` skips the lookup; `idempotency-key` shards
		// further so two workflow runs with the same scope can maintain
		// distinct chats.
		const sanitizedKey = this.inputs.idempotencyKey
			? sanitizeLabelKey(this.inputs.idempotencyKey)
			: undefined;
		if (sanitizedKey && RESERVED_LABEL_KEYS.has(sanitizedKey)) {
			throw new Error(
				`idempotency-key sanitizes to a reserved chat-label key ("${sanitizedKey}"). ` +
					`Reserved keys: ${[...RESERVED_LABEL_KEYS].join(", ")}. ` +
					"Choose a different idempotency-key value.",
			);
		}
		const ghTarget = `${githubOrg}/${githubRepo}#${githubIssueNumber}`;
		const workflow = process.env.GITHUB_WORKFLOW || undefined;

		if (this.inputs.forceNewChat) {
			core.info("force-new-chat=true: skipping chat-reuse lookup");
		} else {
			const follow = await this.findReuseMatch(
				ghTarget,
				resolvedUser.id,
				workflow,
				sanitizedKey,
			);
			if (follow) {
				core.info(`Reusing existing chat: ${follow.id}`);
				return this.runFollowUp({
					coderUsername,
					chatId: follow.id,
					preMessageChat: follow,
					githubOrg,
					githubRepo,
					githubIssueNumber,
				});
			}
		}

		// Resolve `organization_id` only on the create branch: the
		// existing-chat path inherits the chat's org via `createChatMessage`,
		// and resolving eagerly would fire an extra API call and a spurious
		// `org_not_found` failure for users with no org memberships.
		core.info("Creating new agents chat...");
		const organizationID = await this.resolveOrganizationID(
			coderUsername,
			resolvedUser,
		);
		const req: CreateChatRequest = {
			organization_id: organizationID,
			content: [{ type: "text", text: this.inputs.chatPrompt }],
			workspace_id: this.inputs.workspaceId,
			model_config_id: this.inputs.modelConfigId,
			labels: this.buildChatLabels(
				ghTarget,
				resolvedUser.id,
				workflow,
				sanitizedKey,
			),
		};

		const createdChat = await this.coder.createChat(req);
		core.info(
			`Agents chat created successfully (id: ${createdChat.id}, status: ${createdChat.status})`,
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
			await this.commentOnIssue({
				chatUrl,
				owner: githubOrg,
				repo: githubRepo,
				issueNumber: githubIssueNumber,
				chatCreated: true,
				chat: finalChat,
			});
		} else {
			core.info("Skipping comment on issue (commentOnIssue is false)");
		}

		return this.buildOutputs(coderUsername, finalChat, true);
	}

	/**
	 * Send `chat-prompt` as a follow-up message to an existing chat and
	 * complete the post-message flow (poll under `wait: complete`, refresh
	 * under `wait: none`, comment, build outputs). Used by both the
	 * `existing-chat-id` path (no pre-message snapshot, falls back to a
	 * minimal outputs shim on refresh failure) and the chat-reuse path
	 * (the matched chat is the pre-message snapshot, so refresh failure
	 * preserves the matched chat's state).
	 *
	 * Under `wait: complete`, both paths poll with `requireNonTerminalFirst`
	 * to defend against TOCTOU when the chat was already in a terminal
	 * status when the follow-up was sent: the first poll may still see the
	 * pre-message status before the agent transitions.
	 */
	private async runFollowUp(args: {
		coderUsername: string;
		chatId: ChatId;
		preMessageChat: CoderChat | undefined;
		githubOrg: string;
		githubRepo: string;
		githubIssueNumber: number;
	}): Promise<ActionOutputs> {
		const {
			coderUsername,
			chatId,
			preMessageChat,
			githubOrg,
			githubRepo,
			githubIssueNumber,
		} = args;

		await this.coder.createChatMessage(chatId, {
			content: [{ type: "text", text: this.inputs.chatPrompt }],
			model_config_id: this.inputs.modelConfigId,
		});
		core.info("Message sent successfully");

		const chatUrl = this.generateChatUrl(chatId);

		let chat: CoderChat | undefined = preMessageChat;
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
				const fetched = await this.coder.getChat(chatId);
				core.info(`Chat status: ${fetched.status}, title: ${fetched.title}`);
				chat = fetched;
			} catch (error) {
				core.warning(
					preMessageChat
						? `Failed to fetch chat after sending message; outputs reflect pre-message state: ${error}`
						: `Failed to fetch chat after sending message; outputs will be minimal: ${error}`,
				);
			}
		}

		if (this.inputs.commentOnIssue) {
			core.info(
				`Commenting on issue ${githubOrg}/${githubRepo}#${githubIssueNumber}`,
			);
			await this.commentOnIssue({
				chatUrl,
				owner: githubOrg,
				repo: githubRepo,
				issueNumber: githubIssueNumber,
				chatCreated: false,
				chat,
			});
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

	/**
	 * Most-recent non-archived chat matching the reuse scope, or undefined.
	 * Scope: gh-target + coder-user; workflow when GITHUB_WORKFLOW is set;
	 * sanitized idempotency-key when set. Warns on multiple matches.
	 *
	 * The label set must stay in sync with `buildChatLabels`: a key the
	 * lookup queries but the create branch doesn't write (or vice versa)
	 * breaks reuse silently. `ACTION_LABEL_KEYS` is the shared source of
	 * truth.
	 */
	private async findReuseMatch(
		ghTarget: string,
		coderUserId: string,
		workflow: string | undefined,
		sanitizedKey: string | undefined,
	): Promise<CoderChat | undefined> {
		const labels: string[] = [
			`${ACTION_LABEL_KEYS.marker}:true`,
			`${ACTION_LABEL_KEYS.target}:${ghTarget}`,
			`${ACTION_LABEL_KEYS.user}:${coderUserId}`,
		];
		if (workflow) {
			labels.push(`${ACTION_LABEL_KEYS.workflow}:${workflow}`);
		}
		if (sanitizedKey) {
			labels.push(`${sanitizedKey}:true`);
		}
		let chats: CoderChat[];
		try {
			chats = await this.coder.listChats({
				label: labels,
				archived: false,
			});
		} catch (err) {
			const inner = err instanceof Error ? err.message : String(err);
			throw new Error(
				`Failed to look up chats by reuse labels [${labels.join(", ")}]: ${inner}`,
				{ cause: err },
			);
		}
		// Belt-and-braces: the API filters archived by default.
		const live = chats.filter((chat) => chat.archived !== true);
		if (live.length === 0) {
			return undefined;
		}
		// PostgreSQL `timestamptz` serializes with uniform fractional
		// precision, so lex comparison sorts correctly. ISO 8601 strings
		// are not lex-comparable in general.
		live.sort((a, b) => {
			if (a.updated_at < b.updated_at) return 1;
			if (a.updated_at > b.updated_at) return -1;
			return 0;
		});
		if (live.length > 1) {
			const ignored = live
				.slice(1)
				.map((c) => c.id)
				.join(", ");
			core.warning(
				`Multiple non-archived chats matched reuse scope for ${ghTarget}. ` +
					`Reusing the most recent (${live[0].id}) and ignoring: ${ignored}. ` +
					"Concurrent triggers can race; subsequent runs converge on the " +
					"most recent match.",
			);
		}
		return live[0];
	}

	/**
	 * Labels written on chat creation. Three are always written; the
	 * workflow label is added when GITHUB_WORKFLOW is set; the sanitized
	 * idempotency-key is added when set.
	 *
	 * The label set must stay in sync with `findReuseMatch`: a key the
	 * create branch writes but the lookup doesn't query (or vice versa)
	 * breaks reuse silently. `ACTION_LABEL_KEYS` is the shared source of
	 * truth.
	 */
	private buildChatLabels(
		ghTarget: string,
		coderUserId: string,
		workflow: string | undefined,
		sanitizedKey: string | undefined,
	): Record<string, string> {
		// Defense in depth: `runInner` rejects collisions before any API
		// call; this guards direct callers.
		if (sanitizedKey && RESERVED_LABEL_KEYS.has(sanitizedKey)) {
			throw new Error(
				`idempotency-key sanitizes to a reserved chat-label key ("${sanitizedKey}"). ` +
					`Reserved keys: ${[...RESERVED_LABEL_KEYS].join(", ")}. ` +
					"Choose a different idempotency-key value.",
			);
		}
		const labels: Record<string, string> = {
			[ACTION_LABEL_KEYS.marker]: "true",
			[ACTION_LABEL_KEYS.target]: ghTarget,
			[ACTION_LABEL_KEYS.user]: coderUserId,
		};
		if (workflow) {
			labels[ACTION_LABEL_KEYS.workflow] = workflow;
		}
		if (sanitizedKey) {
			labels[sanitizedKey] = "true";
		}
		return labels;
	}
}
