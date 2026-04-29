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
	 * Parse owner and repo from issue URL
	 */
	parseGithubIssueURL(): {
		githubOrg: string;
		githubRepo: string;
		githubIssueNumber: number;
	} {
		if (!this.inputs.githubURL) {
			throw new Error("Missing issue URL");
		}

		const match = this.inputs.githubURL.match(
			/([^/]+)\/([^/]+)\/issues\/(\d+)/,
		);
		if (!match) {
			throw new Error(`Invalid issue URL: ${this.inputs.githubURL}`);
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
		let coderUsername: string;
		if (this.inputs.coderUsername) {
			core.info(`Using provided Coder username: ${this.inputs.coderUsername}`);
			coderUsername = this.inputs.coderUsername;
		} else {
			core.info(
				`Looking up Coder user by GitHub user ID: ${this.inputs.githubUserID}`,
			);
			const coderUser = await this.coder.getCoderUserByGitHubId(
				this.inputs.githubUserID,
			);
			coderUsername = coderUser.username;
		}

		const { githubOrg, githubRepo, githubIssueNumber } =
			this.parseGithubIssueURL();
		core.info(`GitHub owner: ${githubOrg}`);
		core.info(`GitHub repo: ${githubRepo}`);
		core.info(`GitHub issue number: ${githubIssueNumber}`);
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

			return {
				coderUsername,
				chatId: this.inputs.existingChatId,
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
				`Commenting on issue ${githubOrg}/${githubRepo}#${githubIssueNumber}`,
			);
			await this.commentOnIssue(
				chatUrl,
				githubOrg,
				githubRepo,
				githubIssueNumber,
			);
			core.info("Comment posted successfully");
		} else {
			core.info("Skipping comment on issue (commentOnIssue is false)");
		}

		return this.buildOutputs(coderUsername, createdChat, true);
	}
}
