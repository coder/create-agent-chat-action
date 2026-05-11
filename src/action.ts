import * as core from "@actions/core";
import type {
	CreateChatRequest,
	CoderClient,
	CoderChat,
	ChatId,
	ChatStatus,
} from "./coder-client";
import type { ActionInputs, ActionOutputs, ChatErrorKind } from "./schemas";
import type { getOctokit } from "@actions/github";

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
 * Thrown when the chat ends in `error` or the polling loop times out.
 * index.ts maps this onto the chat-error-* and chat-* outputs and
 * calls core.setFailed. The optional cause preserves stack traces
 * from the underlying transport error.
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

export class CoderAgentChatAction {
	constructor(
		private readonly coder: CoderClient,
		private readonly octokit: Octokit,
		private readonly inputs: ActionInputs,
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

		const match = this.inputs.githubURL.match(
			/([^/]+)\/([^/]+)\/(?:issues|pull)\/(\d+)/,
		);
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
	 * Generate chat URL
	 */
	generateChatUrl(chatId: ChatId): string {
		const baseURL = this.inputs.coderURL.split(/[?#]/)[0].replace(/\/$/, "");
		return `${baseURL}/chats/${chatId}`;
	}

	/**
	 * Comment on the linked GitHub issue or pull request with the chat link.
	 */
	async commentOnIssue(
		chatUrl: string,
		owner: string,
		repo: string,
		issueNumber: number,
	): Promise<void> {
		const body = `Agent chat: ${chatUrl}`;

		try {
			const { data: comments } = await this.octokit.rest.issues.listComments({
				owner,
				repo,
				issue_number: issueNumber,
			});

			const existingComment = comments
				.reverse()
				.find((comment: { body?: string }) =>
					comment.body?.startsWith("Agent chat:"),
				);

			if (existingComment) {
				await this.octokit.rest.issues.updateComment({
					owner,
					repo,
					comment_id: existingComment.id,
					body,
				});
			} else {
				await this.octokit.rest.issues.createComment({
					owner,
					repo,
					issue_number: issueNumber,
					body,
				});
			}
		} catch (error) {
			core.error(`Failed to post comment: ${error}`);
		}
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
	 * Main action execution
	 */
	async run(): Promise<ActionOutputs> {
		this.warnUnwiredInputs();

		let coderUsername: string;
		if (this.inputs.coderUsername) {
			core.info(`Using provided Coder username: ${this.inputs.coderUsername}`);
			coderUsername = this.inputs.coderUsername;
		} else if (this.inputs.githubUserID !== undefined) {
			core.info(
				`Looking up Coder user by GitHub user ID: ${this.inputs.githubUserID}`,
			);
			const coderUser = await this.coder.getCoderUserByGitHubId(
				this.inputs.githubUserID,
			);
			coderUsername = coderUser.username;
		} else {
			// Both identity inputs are unset. The schema permits this so the
			// runtime can later auto-resolve from the workflow context; until
			// that path lands, fail with a clear message rather than crashing
			// inside the user lookup.
			throw new Error(
				"Cannot resolve Coder user: set either `github-user-id` or " +
					"`coder-username`.",
			);
		}

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
