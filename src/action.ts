import * as core from "@actions/core";
import type {
	CreateChatRequest,
	CoderClient,
	CoderChat,
	ChatId,
} from "./coder-client";
import type { ActionInputs, ActionOutputs } from "./schemas";
import type { getOctokit } from "@actions/github";

export type Octokit = ReturnType<typeof getOctokit>;

export class CoderAgentChatAction {
	constructor(
		private readonly coder: CoderClient,
		private readonly octokit: Octokit,
		private readonly inputs: ActionInputs,
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
	 * Comment on GitHub issue with chat link
	 */
	async commentOnIssue(
		chatUrl: string,
		owner: string,
		repo: string,
		issueNumber: number,
	): Promise<void> {
		const body = `Agent chat created: ${chatUrl}`;

		try {
			const { data: comments } = await this.octokit.rest.issues.listComments({
				owner,
				repo,
				issue_number: issueNumber,
			});

			const existingComment = comments
				.reverse()
				.find((comment: { body?: string }) =>
					comment.body?.startsWith("Agent chat created:"),
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
			core.error(`Failed to comment on issue: ${error}`);
		}
	}

	/**
	 * Warn loudly when the user opts in to inputs whose behavior has not
	 * landed yet. The schema accepts these so the slice series (S4 wait,
	 * S7 idempotency) can wire each one without amending action.yaml
	 * again, but a workflow author who explicitly sets `wait: complete`
	 * deserves to see that the action will not honor it yet rather than
	 * silently returning early.
	 */
	warnUnwiredInputs(): void {
		if (this.inputs.wait === "complete") {
			core.warning(
				"`wait: complete` is declared but not yet implemented in this slice; " +
					"the action will return immediately. Tracked in S4.",
			);
		}
		if (this.inputs.idempotencyLabelKey !== undefined) {
			core.warning(
				"`idempotency-label-key` is declared but not yet implemented in this slice; " +
					"the action will always create a new chat. Tracked in S7.",
			);
		}
	}

	/**
	 * Build a rich ActionOutputs from a Chat response. Cherry-picked from
	 * the discarded PR #1; populates v0 outputs from data the chats API
	 * already returns.
	 */
	buildOutputs(
		coderUsername: string,
		chat: CoderChat,
		chatCreated: boolean,
	): ActionOutputs {
		const diff = chat.diff_status;
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
			// pull_request_title defaults to "" in the Zod schema; use `||`
			// to also fall through empty string to undefined so the action
			// output is unset rather than blank. Diverges intentionally from
			// the `??` style used by the other nullable fields.
			pullRequestTitle: diff?.pull_request_title || undefined,
			pullRequestNumber: diff?.pr_number ?? undefined,
			additions: diff?.additions,
			deletions: diff?.deletions,
			changedFiles: diff?.changed_files,
			headBranch: diff?.head_branch ?? undefined,
			baseBranch: diff?.base_branch ?? undefined,
		};
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
			// The schema permits both identity inputs to be unset so S2 can
			// auto-resolve from `github.context`. Until S2 lands, fail with a
			// message that names both inputs and the slice that wires the
			// fallback rather than crashing inside the user lookup with a
			// misleading "GitHub user ID cannot be undefined" error.
			throw new Error(
				"Cannot resolve Coder user: set either `github-user-id` or " +
					"`coder-username`. Auto-resolution from the workflow context " +
					"is tracked in S2.",
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

			// Fetch the full chat after the message so the action surfaces a
			// consistent output shape regardless of which path created or
			// continued the chat. If the fetch fails, fall back to a minimal
			// output rather than failing the whole step, since the follow-up
			// message has already been sent successfully.
			let chat: CoderChat | undefined;
			try {
				chat = await this.coder.getChat(chatId);
				core.info(`Chat status: ${chat.status}, title: ${chat.title}`);
			} catch (error) {
				core.warning(
					`Failed to fetch chat after sending message; outputs will be minimal: ${error}`,
				);
			}

			const chatUrl = this.generateChatUrl(chatId);

			if (this.inputs.commentOnIssue) {
				core.info(
					`Commenting on ${githubOrg}/${githubRepo}#${githubIssueNumber}`,
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

		if (this.inputs.commentOnIssue) {
			core.info(
				`Commenting on ${githubOrg}/${githubRepo}#${githubIssueNumber}`,
			);
			await this.commentOnIssue(
				chatUrl,
				githubOrg,
				githubRepo,
				githubIssueNumber,
			);
			core.info("Comment posted successfully");
		} else {
			core.info("Skipping comment (commentOnIssue is false)");
		}

		return this.buildOutputs(coderUsername, createdChat, true);
	}
}
