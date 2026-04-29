import { describe, expect, test, beforeEach, spyOn } from "bun:test";
import * as core from "@actions/core";
import { CoderAgentChatAction } from "./action";
import type { Octokit } from "./action";
import { ActionOutputsSchema } from "./schemas";
import {
	MockCoderClient,
	createMockOctokit,
	createMockInputs,
	mockUser,
	mockChat,
	mockChatWithDiff,
	mockChatMessageResponse,
} from "./test-helpers";

describe("CoderAgentChatAction", () => {
	let coderClient: MockCoderClient;
	let octokit: ReturnType<typeof createMockOctokit>;

	beforeEach(() => {
		coderClient = new MockCoderClient();
		octokit = createMockOctokit();
	});

	describe("parseGithubURL", () => {
		test("parses valid GitHub issue URL", () => {
			const inputs = createMockInputs({
				githubURL: "https://github.com/owner/repo/issues/123",
			});
			const action = new CoderAgentChatAction(
				coderClient,
				octokit as unknown as Octokit,
				inputs,
			);

			const result = action.parseGithubURL();

			expect(result).toEqual({
				githubOrg: "owner",
				githubRepo: "repo",
				githubIssueNumber: 123,
			});
		});

		test("parses valid GitHub pull request URL", () => {
			const inputs = createMockInputs({
				githubURL: "https://github.com/owner/repo/pull/42",
			});
			const action = new CoderAgentChatAction(
				coderClient,
				octokit as unknown as Octokit,
				inputs,
			);

			const result = action.parseGithubURL();

			expect(result).toEqual({
				githubOrg: "owner",
				githubRepo: "repo",
				githubIssueNumber: 42,
			});
		});

		test("throws when no GitHub URL provided", () => {
			const inputs = createMockInputs({ githubURL: undefined });
			const action = new CoderAgentChatAction(
				coderClient,
				octokit as unknown as Octokit,
				inputs,
			);

			expect(() => action.parseGithubURL()).toThrowError("Missing GitHub URL");
		});

		test("throws for invalid URL format", () => {
			const inputs = createMockInputs({ githubURL: "not-a-url" });
			const action = new CoderAgentChatAction(
				coderClient,
				octokit as unknown as Octokit,
				inputs,
			);

			expect(() => action.parseGithubURL()).toThrowError(
				"Invalid GitHub URL: not-a-url",
			);
		});

		test("handles non-github.com URL", () => {
			const inputs = createMockInputs({
				githubURL: "https://code.acme.com/owner/repo/issues/123",
			});
			const action = new CoderAgentChatAction(
				coderClient,
				octokit as unknown as Octokit,
				inputs,
			);

			const result = action.parseGithubURL();

			expect(result).toEqual({
				githubOrg: "owner",
				githubRepo: "repo",
				githubIssueNumber: 123,
			});
		});
	});

	describe("generateChatUrl", () => {
		test("generates correct chat URL", () => {
			const inputs = createMockInputs();
			const action = new CoderAgentChatAction(
				coderClient,
				octokit as unknown as Octokit,
				inputs,
			);

			const result = action.generateChatUrl(mockChat.id);

			expect(result).toBe(`https://coder.test/chats/${mockChat.id}`);
		});

		test("handles URL with trailing junk", () => {
			const inputs = createMockInputs({
				coderURL: "https://coder.test/?param=value#anchor",
			});
			const action = new CoderAgentChatAction(
				coderClient,
				octokit as unknown as Octokit,
				inputs,
			);

			const result = action.generateChatUrl(mockChat.id);

			expect(result).toBe(`https://coder.test/chats/${mockChat.id}`);
		});
	});

	describe("commentOnIssue", () => {
		test("creates new comment when none exists", async () => {
			octokit.rest.issues.listComments.mockResolvedValue({
				data: [],
			} as ReturnType<typeof octokit.rest.issues.listComments>);
			octokit.rest.issues.createComment.mockResolvedValue(
				{} as ReturnType<typeof octokit.rest.issues.createComment>,
			);

			const inputs = createMockInputs();
			const action = new CoderAgentChatAction(
				coderClient,
				octokit as unknown as Octokit,
				inputs,
			);

			await action.commentOnIssue("chat-url", "owner", "repo", 123);

			expect(octokit.rest.issues.createComment).toHaveBeenCalledWith({
				owner: "owner",
				repo: "repo",
				issue_number: 123,
				body: "Agent chat created: chat-url",
			});
		});

		test("updates existing Agent chat created comment", async () => {
			octokit.rest.issues.listComments.mockResolvedValue({
				data: [
					{ id: 1, body: "Agent chat created: old-url" },
					{ id: 2, body: "Other comment" },
				],
			} as ReturnType<typeof octokit.rest.issues.listComments>);
			octokit.rest.issues.updateComment.mockResolvedValue(
				{} as ReturnType<typeof octokit.rest.issues.updateComment>,
			);

			const inputs = createMockInputs();
			const action = new CoderAgentChatAction(
				coderClient,
				octokit as unknown as Octokit,
				inputs,
			);

			await action.commentOnIssue("new-url", "owner", "repo", 123);

			expect(octokit.rest.issues.updateComment).toHaveBeenCalledWith({
				owner: "owner",
				repo: "repo",
				comment_id: 1,
				body: "Agent chat created: new-url",
			});
		});

		test("warns but doesn't fail on GitHub API error", async () => {
			octokit.rest.issues.listComments.mockRejectedValue(
				new Error("API Error"),
			);

			const inputs = createMockInputs();
			const action = new CoderAgentChatAction(
				coderClient,
				octokit as unknown as Octokit,
				inputs,
			);

			expect(
				action.commentOnIssue("url", "owner", "repo", 123),
			).resolves.toBeUndefined();
		});
	});

	test("creates new chat successfully", async () => {
		coderClient.mockGetCoderUserByGithubID.mockResolvedValue(mockUser);
		coderClient.mockCreateChat.mockResolvedValue(mockChat);

		const inputs = createMockInputs({
			githubUserID: 12345,
		});
		const action = new CoderAgentChatAction(
			coderClient,
			octokit as unknown as Octokit,
			inputs,
		);

		const result = await action.run();

		expect(coderClient.mockGetCoderUserByGithubID).toHaveBeenCalledWith(12345);
		expect(coderClient.mockCreateChat).toHaveBeenCalledWith({
			content: [{ type: "text", text: "Test prompt" }],
			workspace_id: undefined,
			model_config_id: undefined,
		});

		const parsedResult = ActionOutputsSchema.parse(result);
		expect(parsedResult.coderUsername).toBe(mockUser.username);
		expect(parsedResult.chatCreated).toBe(true);
		expect(parsedResult.chatStatus).toBe("running");
		expect(parsedResult.chatTitle).toBe("Test chat");
		expect(parsedResult.workspaceId).toBe(mockChat.workspace_id ?? undefined);
		expect(parsedResult.chatUrl).toMatch(
			/^https:\/\/coder\.test\/chats\/[a-f0-9-]+$/,
		);
	});

	describe("buildOutputs", () => {
		test("maps a chat with no diff_status to base outputs only", () => {
			const inputs = createMockInputs();
			const action = new CoderAgentChatAction(
				coderClient,
				octokit as unknown as Octokit,
				inputs,
			);

			const out = action.buildOutputs(mockUser.username, mockChat, true);

			expect(out.coderUsername).toBe(mockUser.username);
			expect(out.chatId).toBe(mockChat.id);
			expect(out.chatCreated).toBe(true);
			expect(out.chatStatus).toBe("running");
			expect(out.chatTitle).toBe("Test chat");
			expect(out.workspaceId).toBe(mockChat.workspace_id ?? undefined);
			expect(out.pullRequestUrl).toBeUndefined();
			expect(out.pullRequestState).toBeUndefined();
			expect(out.pullRequestTitle).toBeUndefined();
			expect(out.pullRequestNumber).toBeUndefined();
			expect(out.additions).toBeUndefined();
			expect(out.deletions).toBeUndefined();
			expect(out.changedFiles).toBeUndefined();
			expect(out.headBranch).toBeUndefined();
			expect(out.baseBranch).toBeUndefined();
		});

		test("maps a chat with populated diff_status to PR outputs", () => {
			const inputs = createMockInputs();
			const action = new CoderAgentChatAction(
				coderClient,
				octokit as unknown as Octokit,
				inputs,
			);

			const out = action.buildOutputs(
				mockUser.username,
				mockChatWithDiff,
				false,
			);

			expect(out.chatStatus).toBe("completed");
			expect(out.chatTitle).toBe("Test chat");
			expect(out.workspaceId).toBe(mockChatWithDiff.workspace_id ?? undefined);
			expect(out.pullRequestUrl).toBe(
				"https://github.com/test-org/test-repo/pull/42",
			);
			expect(out.pullRequestState).toBe("open");
			expect(out.pullRequestTitle).toBe("Fix issue #123");
			expect(out.pullRequestNumber).toBe(42);
			expect(out.additions).toBe(50);
			expect(out.deletions).toBe(10);
			expect(out.changedFiles).toBe(3);
			expect(out.headBranch).toBe("fix/issue-123");
			expect(out.baseBranch).toBe("main");
		});

		test("converts empty pull_request_title to undefined", () => {
			// pull_request_title defaults to "" in the Zod schema; the action
			// converts that to undefined to keep the output unset rather than
			// emitting a meaningless empty string.
			const inputs = createMockInputs();
			const action = new CoderAgentChatAction(
				coderClient,
				octokit as unknown as Octokit,
				inputs,
			);
			const diff = mockChatWithDiff.diff_status;
			if (!diff) {
				throw new Error("mockChatWithDiff must have diff_status set");
			}
			const chatWithEmptyTitle: typeof mockChatWithDiff = {
				...mockChatWithDiff,
				diff_status: { ...diff, pull_request_title: "" },
			};

			const out = action.buildOutputs(
				mockUser.username,
				chatWithEmptyTitle,
				false,
			);

			expect(out.pullRequestTitle).toBeUndefined();
		});
	});

	test("creates chat using direct coder-username", async () => {
		coderClient.mockCreateChat.mockResolvedValue(mockChat);

		const inputs = createMockInputs({
			githubUserID: undefined,
			coderUsername: mockUser.username,
		});
		const action = new CoderAgentChatAction(
			coderClient,
			octokit as unknown as Octokit,
			inputs,
		);

		const result = await action.run();

		expect(coderClient.mockGetCoderUserByGithubID).not.toHaveBeenCalled();
		expect(coderClient.mockCreateChat).toHaveBeenCalled();

		const parsedResult = ActionOutputsSchema.parse(result);
		expect(parsedResult.coderUsername).toBe(mockUser.username);
		expect(parsedResult.chatCreated).toBe(true);
	});

	test("sends message to existing chat", async () => {
		coderClient.mockGetCoderUserByGithubID.mockResolvedValue(mockUser);
		coderClient.mockCreateChatMessage.mockResolvedValue(
			mockChatMessageResponse,
		);
		coderClient.mockGetChat.mockResolvedValue(mockChat);
		octokit.rest.issues.listComments.mockResolvedValue({
			data: [],
		} as ReturnType<typeof octokit.rest.issues.listComments>);
		octokit.rest.issues.createComment.mockResolvedValue(
			{} as ReturnType<typeof octokit.rest.issues.createComment>,
		);

		const existingChatId = "990e8400-e29b-41d4-a716-446655440000";
		const inputs = createMockInputs({
			githubUserID: 12345,
			existingChatId,
		});
		const action = new CoderAgentChatAction(
			coderClient,
			octokit as unknown as Octokit,
			inputs,
		);

		const result = await action.run();

		expect(coderClient.mockCreateChatMessage).toHaveBeenCalledWith(
			existingChatId,
			{
				content: [{ type: "text", text: "Test prompt" }],
				model_config_id: undefined,
			},
		);
		expect(coderClient.mockCreateChat).not.toHaveBeenCalled();
		expect(coderClient.mockGetChat).toHaveBeenCalledWith(existingChatId);

		const parsedResult = ActionOutputsSchema.parse(result);
		expect(parsedResult.chatCreated).toBe(false);
		expect(parsedResult.chatId).toBe(existingChatId);
		// Existing-chat path now populates the same outputs as the create path.
		expect(parsedResult.chatStatus).toBe("running");
		expect(parsedResult.chatTitle).toBe("Test chat");
		expect(parsedResult.workspaceId).toBe(mockChat.workspace_id ?? undefined);
	});

	test("falls back to minimal outputs when getChat fails after follow-up", async () => {
		coderClient.mockGetCoderUserByGithubID.mockResolvedValue(mockUser);
		coderClient.mockCreateChatMessage.mockResolvedValue(
			mockChatMessageResponse,
		);
		coderClient.mockGetChat.mockRejectedValue(new Error("transient API error"));

		const existingChatId = "990e8400-e29b-41d4-a716-446655440000";
		const inputs = createMockInputs({
			githubUserID: 12345,
			existingChatId,
			commentOnIssue: false,
		});
		const action = new CoderAgentChatAction(
			coderClient,
			octokit as unknown as Octokit,
			inputs,
		);

		// The follow-up message succeeded, so the action should not fail red
		// just because the chat fetch did. The outputs degrade gracefully.
		const result = await action.run();

		expect(coderClient.mockCreateChatMessage).toHaveBeenCalled();
		expect(coderClient.mockGetChat).toHaveBeenCalledWith(existingChatId);

		const parsedResult = ActionOutputsSchema.parse(result);
		expect(parsedResult.chatCreated).toBe(false);
		expect(parsedResult.chatId).toBe(existingChatId);
		expect(parsedResult.chatStatus).toBeUndefined();
		expect(parsedResult.chatTitle).toBeUndefined();
		expect(parsedResult.workspaceId).toBeUndefined();
	});

	test("creates chat with workspace-id", async () => {
		coderClient.mockGetCoderUserByGithubID.mockResolvedValue(mockUser);
		coderClient.mockCreateChat.mockResolvedValue(mockChat);

		const workspaceId = "550e8400-e29b-41d4-a716-446655440000";
		const inputs = createMockInputs({
			githubUserID: 12345,
			workspaceId,
		});
		const action = new CoderAgentChatAction(
			coderClient,
			octokit as unknown as Octokit,
			inputs,
		);

		await action.run();

		expect(coderClient.mockCreateChat).toHaveBeenCalledWith(
			expect.objectContaining({
				workspace_id: workspaceId,
			}),
		);
	});

	describe("commentOnIssue toggle", () => {
		test("does not comment when commentOnIssue is false", async () => {
			coderClient.mockGetCoderUserByGithubID.mockResolvedValue(mockUser);
			coderClient.mockCreateChat.mockResolvedValue(mockChat);

			const inputs = createMockInputs({
				githubUserID: 12345,
				commentOnIssue: false,
			});
			const action = new CoderAgentChatAction(
				coderClient,
				octokit as unknown as Octokit,
				inputs,
			);

			await action.run();

			expect(octokit.rest.issues.listComments).not.toHaveBeenCalled();
			expect(octokit.rest.issues.createComment).not.toHaveBeenCalled();
		});

		test("comments when commentOnIssue is true", async () => {
			coderClient.mockGetCoderUserByGithubID.mockResolvedValue(mockUser);
			coderClient.mockCreateChat.mockResolvedValue(mockChat);
			octokit.rest.issues.listComments.mockResolvedValue({
				data: [],
			} as ReturnType<typeof octokit.rest.issues.listComments>);
			octokit.rest.issues.createComment.mockResolvedValue(
				{} as ReturnType<typeof octokit.rest.issues.createComment>,
			);

			const inputs = createMockInputs({
				githubUserID: 12345,
				githubURL: "https://github.com/owner/repo/issues/123",
				commentOnIssue: true,
			});
			const action = new CoderAgentChatAction(
				coderClient,
				octokit as unknown as Octokit,
				inputs,
			);

			await action.run();

			expect(octokit.rest.issues.listComments).toHaveBeenCalled();
			expect(octokit.rest.issues.createComment).toHaveBeenCalled();
		});
	});

	describe("warnUnwiredInputs", () => {
		test("warns when wait=complete is set", () => {
			const warning = spyOn(core, "warning").mockImplementation(() => {});
			try {
				const inputs = createMockInputs({ wait: "complete" });
				const action = new CoderAgentChatAction(
					coderClient,
					octokit as unknown as Octokit,
					inputs,
				);

				action.warnUnwiredInputs();

				expect(warning).toHaveBeenCalledWith(
					expect.stringContaining("`wait: complete`"),
				);
			} finally {
				warning.mockRestore();
			}
		});

		test("warns when idempotency-label-key is set", () => {
			const warning = spyOn(core, "warning").mockImplementation(() => {});
			try {
				const inputs = createMockInputs({
					idempotencyLabelKey: "gh:owner/repo#1",
				});
				const action = new CoderAgentChatAction(
					coderClient,
					octokit as unknown as Octokit,
					inputs,
				);

				action.warnUnwiredInputs();

				expect(warning).toHaveBeenCalledWith(
					expect.stringContaining("`idempotency-label-key`"),
				);
			} finally {
				warning.mockRestore();
			}
		});

		test("does not warn at defaults", () => {
			const warning = spyOn(core, "warning").mockImplementation(() => {});
			try {
				const inputs = createMockInputs();
				const action = new CoderAgentChatAction(
					coderClient,
					octokit as unknown as Octokit,
					inputs,
				);

				action.warnUnwiredInputs();

				expect(warning).not.toHaveBeenCalled();
			} finally {
				warning.mockRestore();
			}
		});
	});

	describe("identity resolution", () => {
		test("throws when neither github-user-id nor coder-username is set", async () => {
			const inputs = createMockInputs({
				githubUserID: undefined,
				coderUsername: undefined,
			});
			const action = new CoderAgentChatAction(
				coderClient,
				octokit as unknown as Octokit,
				inputs,
			);

			// The schema permits both unset (S2 will auto-resolve from
			// github.context). Until S2 lands, action.run must fail with a
			// clear message instead of calling the user lookup with
			// undefined.
			expect(action.run()).rejects.toThrow(
				/set either `github-user-id` or `coder-username`/,
			);
			expect(action.run()).rejects.toThrow(/tracked in S2/i);
			expect(coderClient.mockGetCoderUserByGithubID).not.toHaveBeenCalled();
		});
	});

	describe("Error Scenarios", () => {
		test("throws error when Coder user not found", async () => {
			coderClient.mockGetCoderUserByGithubID.mockRejectedValue(
				new Error("No Coder user found with GitHub user ID 12345"),
			);

			const inputs = createMockInputs({ githubUserID: 12345 });
			const action = new CoderAgentChatAction(
				coderClient,
				octokit as unknown as Octokit,
				inputs,
			);

			expect(action.run()).rejects.toThrow(
				"No Coder user found with GitHub user ID 12345",
			);
		});

		test("throws error when chat creation fails", async () => {
			coderClient.mockGetCoderUserByGithubID.mockResolvedValue(mockUser);
			coderClient.mockCreateChat.mockRejectedValue(
				new Error("Failed to create chat"),
			);

			const inputs = createMockInputs({ githubUserID: 12345 });
			const action = new CoderAgentChatAction(
				coderClient,
				octokit as unknown as Octokit,
				inputs,
			);

			expect(action.run()).rejects.toThrow("Failed to create chat");
		});
	});
});
