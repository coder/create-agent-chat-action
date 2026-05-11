import { describe, expect, test, beforeEach, spyOn } from "bun:test";
import * as core from "@actions/core";
import {
	ActionFailureError,
	CoderAgentChatAction,
	MAX_CONSECUTIVE_POLL_FAILURES,
	POLL_INTERVAL_MS,
} from "./action";
import type { Octokit } from "./action";
import { ActionOutputsSchema } from "./schemas";
import {
	MockCoderClient,
	createFakeClock,
	createMockOctokit,
	createMockInputs,
	createMockContext,
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
				createMockContext(),
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
				createMockContext(),
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
				createMockContext(),
			);

			expect(() => action.parseGithubURL()).toThrowError("Missing GitHub URL");
		});

		test("throws for invalid URL format", () => {
			const inputs = createMockInputs({ githubURL: "not-a-url" });
			const action = new CoderAgentChatAction(
				coderClient,
				octokit as unknown as Octokit,
				inputs,
				createMockContext(),
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
				createMockContext(),
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
				createMockContext(),
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
				createMockContext(),
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
				createMockContext(),
			);

			await action.commentOnIssue("chat-url", "owner", "repo", 123);

			expect(octokit.rest.issues.createComment).toHaveBeenCalledWith({
				owner: "owner",
				repo: "repo",
				issue_number: 123,
				body: "Agent chat: chat-url",
			});
		});

		test("updates existing Agent chat comment", async () => {
			octokit.rest.issues.listComments.mockResolvedValue({
				data: [
					{ id: 1, body: "Agent chat: old-url" },
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
				createMockContext(),
			);

			await action.commentOnIssue("new-url", "owner", "repo", 123);

			expect(octokit.rest.issues.updateComment).toHaveBeenCalledWith({
				owner: "owner",
				repo: "repo",
				comment_id: 1,
				body: "Agent chat: new-url",
			});
		});

		test("warns but doesn't fail on GitHub API error", async () => {
			octokit.rest.issues.listComments.mockRejectedValue(
				new Error("API Error"),
			);
			const errorLog = spyOn(core, "error").mockImplementation(() => {});

			try {
				const inputs = createMockInputs();
				const action = new CoderAgentChatAction(
					coderClient,
					octokit as unknown as Octokit,
					inputs,
					createMockContext(),
				);

				await expect(
					action.commentOnIssue("url", "owner", "repo", 123),
				).resolves.toBeUndefined();
				expect(errorLog).toHaveBeenCalledWith(
					expect.stringContaining("Failed to post comment"),
				);
			} finally {
				errorLog.mockRestore();
			}
		});
	});

	test("creates new chat successfully", async () => {
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
			createMockContext(),
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
				createMockContext(),
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
				createMockContext(),
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

		test("converts null pull_request_title to undefined", () => {
			// pull_request_title is .nullable().optional(); explicit null
			// from the API maps to undefined so the output is unset.
			const inputs = createMockInputs();
			const action = new CoderAgentChatAction(
				coderClient,
				octokit as unknown as Octokit,
				inputs,
				createMockContext(),
			);
			const diff = mockChatWithDiff.diff_status;
			if (!diff) {
				throw new Error("mockChatWithDiff must have diff_status set");
			}
			const chatWithNullTitle: typeof mockChatWithDiff = {
				...mockChatWithDiff,
				diff_status: { ...diff, pull_request_title: null },
			};

			const out = action.buildOutputs(
				mockUser.username,
				chatWithNullTitle,
				false,
			);

			expect(out.pullRequestTitle).toBeUndefined();
		});

		test("emits zero numerics when a PR exists", () => {
			const inputs = createMockInputs();
			const action = new CoderAgentChatAction(
				coderClient,
				octokit as unknown as Octokit,
				inputs,
				createMockContext(),
			);
			const diff = mockChatWithDiff.diff_status;
			if (!diff) {
				throw new Error("mockChatWithDiff must have diff_status set");
			}
			const zeroDiff: typeof mockChatWithDiff = {
				...mockChatWithDiff,
				diff_status: {
					...diff,
					additions: 0,
					deletions: 0,
					changed_files: 0,
				},
			};

			const out = action.buildOutputs(mockUser.username, zeroDiff, false);

			// Zero is a valid value when a PR exists; gating is on PR
			// presence, not on the numeric being non-zero.
			expect(out.additions).toBe(0);
			expect(out.deletions).toBe(0);
			expect(out.changedFiles).toBe(0);
		});

		test("skips numerics when diff_status has no PR indicator", () => {
			const inputs = createMockInputs();
			const action = new CoderAgentChatAction(
				coderClient,
				octokit as unknown as Octokit,
				inputs,
				createMockContext(),
			);
			const diff = mockChatWithDiff.diff_status;
			if (!diff) {
				throw new Error("mockChatWithDiff must have diff_status set");
			}
			// diff_status present but no PR yet: url null, pr_number null.
			// The Zod .default(0) numerics would otherwise leak as "0".
			const noPRYet: typeof mockChatWithDiff = {
				...mockChatWithDiff,
				diff_status: {
					...diff,
					url: null,
					pr_number: null,
				},
			};

			const out = action.buildOutputs(mockUser.username, noPRYet, false);

			expect(out.additions).toBeUndefined();
			expect(out.deletions).toBeUndefined();
			expect(out.changedFiles).toBeUndefined();
		});

		test("skips numerics for a branch-only chat (url set, pr_number null)", () => {
			const inputs = createMockInputs();
			const action = new CoderAgentChatAction(
				coderClient,
				octokit as unknown as Octokit,
				inputs,
				createMockContext(),
			);
			const diff = mockChatWithDiff.diff_status;
			if (!diff) {
				throw new Error("mockChatWithDiff must have diff_status set");
			}
			// Agent pushed a branch but no PR exists yet: url is a branch
			// comparison link, pr_number is null. Numerics belong under the
			// pull-request-* cluster, so emitting them now would be misleading.
			const branchOnly: typeof mockChatWithDiff = {
				...mockChatWithDiff,
				diff_status: {
					...diff,
					url: "https://github.com/test-org/test-repo/compare/main...fix/issue-123",
					pr_number: null,
				},
			};

			const out = action.buildOutputs(mockUser.username, branchOnly, false);

			expect(out.pullRequestUrl).toBe(
				"https://github.com/test-org/test-repo/compare/main...fix/issue-123",
			);
			expect(out.additions).toBeUndefined();
			expect(out.deletions).toBeUndefined();
			expect(out.changedFiles).toBeUndefined();
		});

		test("maps last_error to chatErrorMessage", () => {
			const inputs = createMockInputs();
			const action = new CoderAgentChatAction(
				coderClient,
				octokit as unknown as Octokit,
				inputs,
				createMockContext(),
			);
			const chatWithError: typeof mockChat = {
				...mockChat,
				status: "error",
				last_error: "spend cap reached",
			};

			const out = action.buildOutputs(mockUser.username, chatWithError, true);

			expect(out.chatErrorMessage).toBe("spend cap reached");
			expect(out.chatStatus).toBe("error");
		});

		test("leaves chatErrorMessage undefined when last_error is null", () => {
			const inputs = createMockInputs();
			const action = new CoderAgentChatAction(
				coderClient,
				octokit as unknown as Octokit,
				inputs,
				createMockContext(),
			);

			const out = action.buildOutputs(mockUser.username, mockChat, true);

			expect(out.chatErrorMessage).toBeUndefined();
		});
	});

	test("creates chat using direct coder-username", async () => {
		coderClient.mockCreateChat.mockResolvedValue(mockChat);

		const inputs = createMockInputs({
			githubUserID: undefined,
			coderUsername: mockUser.username,
			commentOnIssue: false,
		});
		const action = new CoderAgentChatAction(
			coderClient,
			octokit as unknown as Octokit,
			inputs,
			createMockContext(),
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
			createMockContext(),
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
		// Existing-chat path populates the same outputs as the create path.
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
			createMockContext(),
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
			commentOnIssue: false,
		});
		const action = new CoderAgentChatAction(
			coderClient,
			octokit as unknown as Octokit,
			inputs,
			createMockContext(),
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
				createMockContext(),
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
				createMockContext(),
			);

			await action.run();

			expect(octokit.rest.issues.listComments).toHaveBeenCalled();
			expect(octokit.rest.issues.createComment).toHaveBeenCalled();
		});
	});

	describe("warnUnwiredInputs", () => {
		test("does not warn for wait=complete", () => {
			const warning = spyOn(core, "warning").mockImplementation(() => {});
			try {
				const inputs = createMockInputs({ wait: "complete" });
				const action = new CoderAgentChatAction(
					coderClient,
					octokit as unknown as Octokit,
					inputs,
					createMockContext(),
				);

				action.warnUnwiredInputs();

				expect(warning).not.toHaveBeenCalledWith(
					expect.stringContaining("`wait: complete`"),
				);
			} finally {
				warning.mockRestore();
			}
		});

		test("warns when idempotency-key is set", () => {
			const warning = spyOn(core, "warning").mockImplementation(() => {});
			try {
				const inputs = createMockInputs({
					idempotencyKey: "gh:owner/repo#1",
				});
				const action = new CoderAgentChatAction(
					coderClient,
					octokit as unknown as Octokit,
					inputs,
					createMockContext(),
				);

				action.warnUnwiredInputs();

				expect(warning).toHaveBeenCalledWith(
					expect.stringContaining("`idempotency-key`"),
				);
			} finally {
				warning.mockRestore();
			}
		});

		test("warns when coder-organization is set", () => {
			const warning = spyOn(core, "warning").mockImplementation(() => {});
			try {
				const inputs = createMockInputs({ coderOrganization: "my-org" });
				const action = new CoderAgentChatAction(
					coderClient,
					octokit as unknown as Octokit,
					inputs,
					createMockContext(),
				);

				action.warnUnwiredInputs();

				expect(warning).toHaveBeenCalledWith(
					expect.stringContaining("`coder-organization`"),
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
					createMockContext(),
				);

				action.warnUnwiredInputs();

				expect(warning).not.toHaveBeenCalled();
			} finally {
				warning.mockRestore();
			}
		});
	});

	describe("Identity resolution", () => {
		test("uses coder-username directly without GitHub-id lookup", async () => {
			coderClient.mockCreateChat.mockResolvedValue(mockChat);

			const inputs = createMockInputs({
				githubUserID: undefined,
				coderUsername: mockUser.username,
				commentOnIssue: false,
			});
			const context = createMockContext({
				eventName: "issues",
				payload: { sender: { id: 99999 } },
			});
			const action = new CoderAgentChatAction(
				coderClient,
				octokit as unknown as Octokit,
				inputs,
				context,
			);

			const result = await action.run();

			expect(coderClient.mockGetCoderUserByGithubID).not.toHaveBeenCalled();
			expect(octokit.rest.users.getByUsername).not.toHaveBeenCalled();
			expect(result.coderUsername).toBe(mockUser.username);
		});

		test("prefers coder-username over github-user-id when both bypass the schema", async () => {
			// The Zod schema rejects setting both inputs simultaneously, but the
			// resolver is a unit and the precedence #1 vs #2 must hold even if a
			// future caller bypasses the schema. Constructing the action directly
			// pins the precedence in the unit's contract.
			coderClient.mockCreateChat.mockResolvedValue(mockChat);

			const inputs = {
				...createMockInputs(),
				coderUsername: mockUser.username,
				githubUserID: 12345,
				commentOnIssue: false,
			};
			const action = new CoderAgentChatAction(
				coderClient,
				octokit as unknown as Octokit,
				inputs,
				createMockContext({ eventName: "issues" }),
			);

			const result = await action.run();

			expect(coderClient.mockGetCoderUserByGithubID).not.toHaveBeenCalled();
			expect(result.coderUsername).toBe(mockUser.username);
		});

		test("looks up by github-user-id when set", async () => {
			coderClient.mockGetCoderUserByGithubID.mockResolvedValue(mockUser);
			coderClient.mockCreateChat.mockResolvedValue(mockChat);

			const inputs = createMockInputs({
				githubUserID: 12345,
				coderUsername: undefined,
				commentOnIssue: false,
			});
			const context = createMockContext({
				eventName: "issues",
				payload: { sender: { id: 99999 } },
			});
			const action = new CoderAgentChatAction(
				coderClient,
				octokit as unknown as Octokit,
				inputs,
				context,
			);

			const result = await action.run();

			expect(coderClient.mockGetCoderUserByGithubID).toHaveBeenCalledWith(
				12345,
			);
			expect(octokit.rest.users.getByUsername).not.toHaveBeenCalled();
			expect(result.coderUsername).toBe(mockUser.username);
		});

		test("falls back to context.payload.sender.id when both inputs are unset", async () => {
			coderClient.mockGetCoderUserByGithubID.mockResolvedValue(mockUser);
			coderClient.mockCreateChat.mockResolvedValue(mockChat);

			const inputs = createMockInputs({
				githubUserID: undefined,
				coderUsername: undefined,
				commentOnIssue: false,
			});
			const context = createMockContext({
				eventName: "issues",
				actor: "some-actor",
				payload: { sender: { id: 424242 } },
			});
			const action = new CoderAgentChatAction(
				coderClient,
				octokit as unknown as Octokit,
				inputs,
				context,
			);

			const result = await action.run();

			expect(coderClient.mockGetCoderUserByGithubID).toHaveBeenCalledWith(
				424242,
			);
			expect(octokit.rest.users.getByUsername).not.toHaveBeenCalled();
			expect(result.coderUsername).toBe(mockUser.username);
		});

		test("falls through to actor when sender exists without a numeric id", async () => {
			// Bot-triggered events sometimes deliver a partial sender object
			// (e.g. `{ login: "bot" }` with no `id`). The resolver guards
			// `sender.id` with `typeof === "number" && > 0` and falls through.
			octokit.rest.users.getByUsername.mockResolvedValue({
				data: { id: 333 },
			} as unknown as ReturnType<typeof octokit.rest.users.getByUsername>);
			coderClient.mockGetCoderUserByGithubID.mockResolvedValue(mockUser);
			coderClient.mockCreateChat.mockResolvedValue(mockChat);

			const inputs = createMockInputs({
				githubUserID: undefined,
				coderUsername: undefined,
				commentOnIssue: false,
			});
			const context = createMockContext({
				eventName: "issues",
				actor: "octocat",
				payload: { sender: {} },
			});
			const action = new CoderAgentChatAction(
				coderClient,
				octokit as unknown as Octokit,
				inputs,
				context,
			);

			const result = await action.run();

			expect(octokit.rest.users.getByUsername).toHaveBeenCalledWith({
				username: "octocat",
			});
			expect(result.coderUsername).toBe(mockUser.username);
		});

		test("treats sender id of 0 as missing and falls through to actor", async () => {
			// Mirrors the Zod schema's positive constraint on `github-user-id`.
			// Without the guard, `0` reaches a bare-string throw inside the
			// Coder client and surfaces as "Unknown error occurred".
			octokit.rest.users.getByUsername.mockResolvedValue({
				data: { id: 444 },
			} as unknown as ReturnType<typeof octokit.rest.users.getByUsername>);
			coderClient.mockGetCoderUserByGithubID.mockResolvedValue(mockUser);
			coderClient.mockCreateChat.mockResolvedValue(mockChat);

			const inputs = createMockInputs({
				githubUserID: undefined,
				coderUsername: undefined,
				commentOnIssue: false,
			});
			const context = createMockContext({
				eventName: "issues",
				actor: "octocat",
				payload: { sender: { id: 0 } },
			});
			const action = new CoderAgentChatAction(
				coderClient,
				octokit as unknown as Octokit,
				inputs,
				context,
			);

			const result = await action.run();

			expect(coderClient.mockGetCoderUserByGithubID).not.toHaveBeenCalledWith(
				0,
			);
			expect(octokit.rest.users.getByUsername).toHaveBeenCalledWith({
				username: "octocat",
			});
			expect(result.coderUsername).toBe(mockUser.username);
		});

		test("treats non-integer sender id as missing and falls through to actor", async () => {
			// Mirrors the Zod schema's `.int()` constraint on `github-user-id`.
			// GitHub user IDs are integers in practice, but the runtime guard
			// should match the schema's shape rather than admitting `1.5`.
			octokit.rest.users.getByUsername.mockResolvedValue({
				data: { id: 444 },
			} as unknown as ReturnType<typeof octokit.rest.users.getByUsername>);
			coderClient.mockGetCoderUserByGithubID.mockResolvedValue(mockUser);
			coderClient.mockCreateChat.mockResolvedValue(mockChat);

			const inputs = createMockInputs({
				githubUserID: undefined,
				coderUsername: undefined,
				commentOnIssue: false,
			});
			const context = createMockContext({
				eventName: "issues",
				actor: "octocat",
				payload: { sender: { id: 1.5 } },
			});
			const action = new CoderAgentChatAction(
				coderClient,
				octokit as unknown as Octokit,
				inputs,
				context,
			);

			const result = await action.run();

			expect(coderClient.mockGetCoderUserByGithubID).not.toHaveBeenCalledWith(
				1.5,
			);
			expect(octokit.rest.users.getByUsername).toHaveBeenCalledWith({
				username: "octocat",
			});
			expect(result.coderUsername).toBe(mockUser.username);
		});

		test("falls back to actor lookup for manual triggers", async () => {
			octokit.rest.users.getByUsername.mockResolvedValue({
				data: { id: 555 },
			} as unknown as ReturnType<typeof octokit.rest.users.getByUsername>);
			coderClient.mockGetCoderUserByGithubID.mockResolvedValue(mockUser);
			coderClient.mockCreateChat.mockResolvedValue(mockChat);

			const inputs = createMockInputs({
				githubUserID: undefined,
				coderUsername: undefined,
				commentOnIssue: false,
			});
			// `workflow_dispatch` payloads do include `sender`, so use a payload
			// shape (sender absent) that genuinely forces the actor branch.
			const context = createMockContext({
				eventName: "workflow_dispatch",
				actor: "octocat",
				payload: {},
			});
			const action = new CoderAgentChatAction(
				coderClient,
				octokit as unknown as Octokit,
				inputs,
				context,
			);

			const result = await action.run();

			expect(octokit.rest.users.getByUsername).toHaveBeenCalledWith({
				username: "octocat",
			});
			expect(coderClient.mockGetCoderUserByGithubID).toHaveBeenCalledWith(555);
			expect(result.coderUsername).toBe(mockUser.username);
		});

		test("refuses to auto-resolve schedule events even when actor is present", async () => {
			const inputs = createMockInputs({
				githubUserID: undefined,
				coderUsername: undefined,
			});
			const context = createMockContext({
				eventName: "schedule",
				actor: "workflow-editor",
				payload: {},
			});
			const action = new CoderAgentChatAction(
				coderClient,
				octokit as unknown as Octokit,
				inputs,
				context,
			);

			let caught: unknown;
			try {
				await action.run();
			} catch (e) {
				caught = e;
			}
			expect(caught).toBeInstanceOf(Error);
			const message = (caught as Error).message;
			expect(message).toContain("schedule");
			expect(message).toContain("coder-username");
			expect(message).toContain("github-user-id");
			expect(octokit.rest.users.getByUsername).not.toHaveBeenCalled();
			expect(coderClient.mockGetCoderUserByGithubID).not.toHaveBeenCalled();
		});

		test("refuses to auto-resolve schedule events even when sender.id is present", async () => {
			// The schedule guard must be semantic, not positional. Today's
			// `schedule` payloads omit `sender`, but if a future GHES extension
			// or custom dispatch chain delivers `sender.id`, we still refuse
			// rather than silently misattribute.
			const inputs = createMockInputs({
				githubUserID: undefined,
				coderUsername: undefined,
			});
			const context = createMockContext({
				eventName: "schedule",
				actor: "workflow-editor",
				payload: { sender: { id: 12345 } },
			});
			const action = new CoderAgentChatAction(
				coderClient,
				octokit as unknown as Octokit,
				inputs,
				context,
			);

			let caught: unknown;
			try {
				await action.run();
			} catch (e) {
				caught = e;
			}
			expect(caught).toBeInstanceOf(Error);
			const message = (caught as Error).message;
			expect(message).toContain("schedule");
			expect(message).toContain("coder-username");
			expect(message).toContain("github-user-id");
			expect(coderClient.mockGetCoderUserByGithubID).not.toHaveBeenCalled();
			expect(octokit.rest.users.getByUsername).not.toHaveBeenCalled();
		});

		test("fails with a clear error when no source resolves", async () => {
			const inputs = createMockInputs({
				githubUserID: undefined,
				coderUsername: undefined,
			});
			const context = createMockContext({
				eventName: "repository_dispatch",
				actor: "",
				payload: {},
			});
			const action = new CoderAgentChatAction(
				coderClient,
				octokit as unknown as Octokit,
				inputs,
				context,
			);

			let caught: unknown;
			try {
				await action.run();
			} catch (e) {
				caught = e;
			}
			expect(caught).toBeInstanceOf(Error);
			const message = (caught as Error).message;
			expect(message).toContain("coder-username");
			expect(message).toContain("github-user-id");
			expect(coderClient.mockGetCoderUserByGithubID).not.toHaveBeenCalled();
			expect(octokit.rest.users.getByUsername).not.toHaveBeenCalled();
		});

		test("wraps sender lookup failure with source and bypass instructions", async () => {
			coderClient.mockGetCoderUserByGithubID.mockRejectedValue(
				new Error("No Coder user found with GitHub user ID 424242"),
			);

			const inputs = createMockInputs({
				githubUserID: undefined,
				coderUsername: undefined,
			});
			const context = createMockContext({
				eventName: "issues",
				payload: { sender: { id: 424242 } },
			});
			const action = new CoderAgentChatAction(
				coderClient,
				octokit as unknown as Octokit,
				inputs,
				context,
			);

			let caught: unknown;
			try {
				await action.run();
			} catch (e) {
				caught = e;
			}
			expect(caught).toBeInstanceOf(Error);
			const message = (caught as Error).message;
			expect(message).toContain("github.context.payload.sender.id");
			expect(message).toContain("424242");
			expect(message).toContain(
				"No Coder user found with GitHub user ID 424242",
			);
			expect(message).toContain("coder-username");
		});

		test("wraps actor getByUsername failure with source and bypass instructions", async () => {
			octokit.rest.users.getByUsername.mockRejectedValue(
				new Error("Not Found"),
			);

			const inputs = createMockInputs({
				githubUserID: undefined,
				coderUsername: undefined,
			});
			const context = createMockContext({
				eventName: "workflow_dispatch",
				actor: "missing-user",
				payload: {},
			});
			const action = new CoderAgentChatAction(
				coderClient,
				octokit as unknown as Octokit,
				inputs,
				context,
			);

			let caught: unknown;
			try {
				await action.run();
			} catch (e) {
				caught = e;
			}
			expect(caught).toBeInstanceOf(Error);
			const message = (caught as Error).message;
			expect(message).toContain("github.context.actor");
			expect(message).toContain("missing-user");
			expect(message).toContain("Not Found");
			expect(message).toContain("coder-username");
			expect(coderClient.mockGetCoderUserByGithubID).not.toHaveBeenCalled();
		});

		test("wraps actor Coder lookup failure with source and bypass instructions", async () => {
			octokit.rest.users.getByUsername.mockResolvedValue({
				data: { id: 555 },
			} as unknown as ReturnType<typeof octokit.rest.users.getByUsername>);
			coderClient.mockGetCoderUserByGithubID.mockRejectedValue(
				new Error("No Coder user found with GitHub user ID 555"),
			);

			const inputs = createMockInputs({
				githubUserID: undefined,
				coderUsername: undefined,
			});
			const context = createMockContext({
				eventName: "workflow_dispatch",
				actor: "octocat",
				payload: {},
			});
			const action = new CoderAgentChatAction(
				coderClient,
				octokit as unknown as Octokit,
				inputs,
				context,
			);

			let caught: unknown;
			try {
				await action.run();
			} catch (e) {
				caught = e;
			}
			expect(caught).toBeInstanceOf(Error);
			const message = (caught as Error).message;
			expect(message).toContain("github.context.actor");
			expect(message).toContain("octocat");
			expect(message).toContain("555");
			expect(message).toContain("No Coder user found with GitHub user ID 555");
			expect(message).toContain("coder-username");
		});

		test("refuses auto-resolve on a fork pull request even with a sender.id", async () => {
			// Hostile-trigger threat model: an attacker who happens to have a
			// Coder identity could open a PR from a fork to bind their identity
			// to the workflow's chat run. The trust gate refuses before any
			// Coder API call.
			const inputs = createMockInputs({
				githubUserID: undefined,
				coderUsername: undefined,
			});
			const context = createMockContext({
				eventName: "pull_request",
				actor: "attacker",
				payload: {
					sender: { id: 99999 },
					pull_request: {
						head: {
							repo: { fork: true, full_name: "attacker/fork" },
						},
						base: { repo: { full_name: "owner/repo" } },
					},
				},
			});
			const action = new CoderAgentChatAction(
				coderClient,
				octokit as unknown as Octokit,
				inputs,
				context,
			);

			let caught: unknown;
			try {
				await action.run();
			} catch (e) {
				caught = e;
			}
			expect(caught).toBeInstanceOf(Error);
			const message = (caught as Error).message;
			expect(message).toContain("fork");
			expect(message).toContain("coder-username");
			expect(message).toContain("github-user-id");
			expect(coderClient.mockGetCoderUserByGithubID).not.toHaveBeenCalled();
			expect(octokit.rest.users.getByUsername).not.toHaveBeenCalled();
		});

		test("detects fork by head/base repo full_name mismatch when fork flag is absent", async () => {
			// Some webhook deliveries omit `fork`. Fall back to comparing
			// `full_name` so the gate still refuses cross-repo PRs.
			const inputs = createMockInputs({
				githubUserID: undefined,
				coderUsername: undefined,
			});
			const context = createMockContext({
				eventName: "pull_request",
				actor: "attacker",
				payload: {
					sender: { id: 99999 },
					pull_request: {
						head: { repo: { full_name: "attacker/fork" } },
						base: { repo: { full_name: "owner/repo" } },
					},
				},
			});
			const action = new CoderAgentChatAction(
				coderClient,
				octokit as unknown as Octokit,
				inputs,
				context,
			);

			let caught: unknown;
			try {
				await action.run();
			} catch (e) {
				caught = e;
			}
			expect(caught).toBeInstanceOf(Error);
			expect((caught as Error).message).toContain("fork");
			expect(coderClient.mockGetCoderUserByGithubID).not.toHaveBeenCalled();
		});

		test("refuses auto-resolve when head.repo is null (deleted fork)", async () => {
			// When a fork's source repository is deleted, GitHub delivers
			// `pull_request.head.repo` as `null`. The fork flag and the
			// full_name comparison both yield falsy under optional chaining,
			// so the gate must treat `null` head repo as a fork explicitly.
			const inputs = createMockInputs({
				githubUserID: undefined,
				coderUsername: undefined,
			});
			const context = createMockContext({
				eventName: "pull_request",
				actor: "attacker",
				payload: {
					sender: { id: 99999 },
					pull_request: {
						head: { repo: null },
						base: { repo: { full_name: "owner/repo" } },
					},
				},
			});
			const action = new CoderAgentChatAction(
				coderClient,
				octokit as unknown as Octokit,
				inputs,
				context,
			);

			let caught: unknown;
			try {
				await action.run();
			} catch (e) {
				caught = e;
			}
			expect(caught).toBeInstanceOf(Error);
			expect((caught as Error).message).toContain("fork");
			expect(coderClient.mockGetCoderUserByGithubID).not.toHaveBeenCalled();
		});

		test("refuses auto-resolve when comment.author_association is CONTRIBUTOR", async () => {
			// Drive-by issue comment from a non-write user. The sender id
			// would resolve under the old behavior; the trust gate must
			// refuse before any Coder lookup.
			const inputs = createMockInputs({
				githubUserID: undefined,
				coderUsername: undefined,
			});
			const context = createMockContext({
				eventName: "issue_comment",
				actor: "drive-by",
				payload: {
					sender: { id: 99999 },
					comment: { author_association: "CONTRIBUTOR" },
				},
			});
			const action = new CoderAgentChatAction(
				coderClient,
				octokit as unknown as Octokit,
				inputs,
				context,
			);

			let caught: unknown;
			try {
				await action.run();
			} catch (e) {
				caught = e;
			}
			expect(caught).toBeInstanceOf(Error);
			const message = (caught as Error).message;
			expect(message).toContain("CONTRIBUTOR");
			expect(message).toContain("author_association");
			expect(message).toContain("coder-username");
			expect(coderClient.mockGetCoderUserByGithubID).not.toHaveBeenCalled();
		});

		test("auto-resolves when MEMBER labels NONE opener's issue (sender is the labeler)", async () => {
			// Realistic `issues: [labeled]` payload. The sender is a trusted
			// MEMBER labeling an issue opened by a NONE user. The gate must
			// NOT read `issue.author_association` (the opener) and refuse;
			// it must auto-resolve the labeler's sender.id.
			coderClient.mockGetCoderUserByGithubID.mockResolvedValue(mockUser);
			coderClient.mockCreateChat.mockResolvedValue(mockChat);

			const inputs = createMockInputs({
				githubUserID: undefined,
				coderUsername: undefined,
				commentOnIssue: false,
			});
			const context = createMockContext({
				eventName: "issues",
				actor: "member-labeler",
				payload: {
					sender: { id: 424242 },
					issue: { author_association: "NONE" },
				},
			});
			const action = new CoderAgentChatAction(
				coderClient,
				octokit as unknown as Octokit,
				inputs,
				context,
			);

			const result = await action.run();

			expect(coderClient.mockGetCoderUserByGithubID).toHaveBeenCalledWith(
				424242,
			);
			expect(result.coderUsername).toBe(mockUser.username);
		});

		test("allows auto-resolve when comment.author_association is MEMBER", async () => {
			coderClient.mockGetCoderUserByGithubID.mockResolvedValue(mockUser);
			coderClient.mockCreateChat.mockResolvedValue(mockChat);

			const inputs = createMockInputs({
				githubUserID: undefined,
				coderUsername: undefined,
				commentOnIssue: false,
			});
			const context = createMockContext({
				eventName: "issue_comment",
				actor: "member-user",
				payload: {
					sender: { id: 424242 },
					comment: { author_association: "MEMBER" },
				},
			});
			const action = new CoderAgentChatAction(
				coderClient,
				octokit as unknown as Octokit,
				inputs,
				context,
			);

			const result = await action.run();

			expect(coderClient.mockGetCoderUserByGithubID).toHaveBeenCalledWith(
				424242,
			);
			expect(result.coderUsername).toBe(mockUser.username);
		});

		test("allows auto-resolve via comment.author_association for OWNER and COLLABORATOR", async () => {
			for (const association of ["OWNER", "COLLABORATOR"] as const) {
				const freshClient = new MockCoderClient();
				freshClient.mockGetCoderUserByGithubID.mockResolvedValue(mockUser);
				freshClient.mockCreateChat.mockResolvedValue(mockChat);

				const inputs = createMockInputs({
					githubUserID: undefined,
					coderUsername: undefined,
					commentOnIssue: false,
				});
				const context = createMockContext({
					eventName: "issue_comment",
					actor: "trusted",
					payload: {
						sender: { id: 7 },
						comment: { author_association: association },
					},
				});
				const action = new CoderAgentChatAction(
					freshClient,
					octokit as unknown as Octokit,
					inputs,
					context,
				);

				const result = await action.run();
				expect(result.coderUsername).toBe(mockUser.username);
				expect(freshClient.mockGetCoderUserByGithubID).toHaveBeenCalledWith(7);
			}
		});

		test("refuses auto-resolve when review.author_association is NONE", async () => {
			// On `pull_request_review`, the reviewer is the sender. A NONE
			// reviewer should not be able to drive auto-resolve even when the
			// PR is same-repo.
			const inputs = createMockInputs({
				githubUserID: undefined,
				coderUsername: undefined,
			});
			const context = createMockContext({
				eventName: "pull_request_review",
				actor: "drive-by-reviewer",
				payload: {
					sender: { id: 99999 },
					review: { author_association: "NONE" },
					pull_request: {
						head: { repo: { fork: false, full_name: "owner/repo" } },
						base: { repo: { full_name: "owner/repo" } },
					},
				},
			});
			const action = new CoderAgentChatAction(
				coderClient,
				octokit as unknown as Octokit,
				inputs,
				context,
			);

			let caught: unknown;
			try {
				await action.run();
			} catch (e) {
				caught = e;
			}
			expect(caught).toBeInstanceOf(Error);
			const message = (caught as Error).message;
			expect(message).toContain("review.author_association");
			expect(message).toContain("NONE");
			expect(coderClient.mockGetCoderUserByGithubID).not.toHaveBeenCalled();
		});

		test("prefers comment.author_association over review.author_association", async () => {
			// On `pull_request_review_comment`, both `comment` and `review`
			// can appear in the payload. The comment is the more specific
			// signal (it identifies the line-level commenter, not the
			// containing review thread author), so comment wins.
			const inputs = createMockInputs({
				githubUserID: undefined,
				coderUsername: undefined,
			});
			const context = createMockContext({
				eventName: "pull_request_review_comment",
				actor: "drive-by",
				payload: {
					sender: { id: 99999 },
					comment: { author_association: "NONE" },
					review: { author_association: "MEMBER" },
				},
			});
			const action = new CoderAgentChatAction(
				coderClient,
				octokit as unknown as Octokit,
				inputs,
				context,
			);

			await expect(action.run()).rejects.toThrow(/NONE/);
		});

		test("coder-username bypasses the trust gate on a fork PR", async () => {
			// Workflow author explicitly opted into running as a known
			// service-account identity. The trust gate must not refuse: the
			// fork PR's prompt is still attacker-controlled, but the workflow
			// author has accepted the responsibility of that opt-in.
			coderClient.mockCreateChat.mockResolvedValue(mockChat);

			const inputs = createMockInputs({
				githubUserID: undefined,
				coderUsername: "bot-user",
				commentOnIssue: false,
			});
			const context = createMockContext({
				eventName: "pull_request",
				actor: "attacker",
				payload: {
					sender: { id: 99999 },
					pull_request: {
						head: { repo: { fork: true, full_name: "attacker/fork" } },
						base: { repo: { full_name: "owner/repo" } },
					},
				},
			});
			const action = new CoderAgentChatAction(
				coderClient,
				octokit as unknown as Octokit,
				inputs,
				context,
			);

			const result = await action.run();
			expect(result.coderUsername).toBe("bot-user");
			expect(coderClient.mockGetCoderUserByGithubID).not.toHaveBeenCalled();
		});

		test("github-user-id bypasses the trust gate on a fork PR", async () => {
			coderClient.mockGetCoderUserByGithubID.mockResolvedValue(mockUser);
			coderClient.mockCreateChat.mockResolvedValue(mockChat);

			const inputs = createMockInputs({
				githubUserID: 7,
				coderUsername: undefined,
				commentOnIssue: false,
			});
			const context = createMockContext({
				eventName: "pull_request",
				actor: "attacker",
				payload: {
					sender: { id: 99999 },
					pull_request: {
						head: { repo: { fork: true, full_name: "attacker/fork" } },
						base: { repo: { full_name: "owner/repo" } },
					},
				},
			});
			const action = new CoderAgentChatAction(
				coderClient,
				octokit as unknown as Octokit,
				inputs,
				context,
			);

			const result = await action.run();
			expect(result.coderUsername).toBe(mockUser.username);
			expect(coderClient.mockGetCoderUserByGithubID).toHaveBeenCalledWith(7);
		});

		test("workflow_dispatch carries no trust signal and auto-resolves", async () => {
			// `workflow_dispatch` payloads carry neither pull_request nor
			// author_association data. The gate returns `no-signal` and
			// auto-resolve proceeds; GitHub already gates who can trigger
			// `workflow_dispatch` (write access to the repo).
			octokit.rest.users.getByUsername.mockResolvedValue({
				data: { id: 555 },
			} as unknown as ReturnType<typeof octokit.rest.users.getByUsername>);
			coderClient.mockGetCoderUserByGithubID.mockResolvedValue(mockUser);
			coderClient.mockCreateChat.mockResolvedValue(mockChat);

			const inputs = createMockInputs({
				githubUserID: undefined,
				coderUsername: undefined,
				commentOnIssue: false,
			});
			const context = createMockContext({
				eventName: "workflow_dispatch",
				actor: "trusted-user",
				payload: {},
			});
			const action = new CoderAgentChatAction(
				coderClient,
				octokit as unknown as Octokit,
				inputs,
				context,
			);

			const result = await action.run();
			expect(result.coderUsername).toBe(mockUser.username);
		});
	});

	describe("wait=complete polling", () => {
		test("wait=none honors the wait gate: no getChat, no clock sleep", async () => {
			coderClient.mockGetCoderUserByGithubID.mockResolvedValue(mockUser);
			coderClient.mockCreateChat.mockResolvedValue(mockChat);

			const inputs = createMockInputs({
				githubUserID: 12345,
				wait: "none",
				commentOnIssue: false,
			});
			const clock = createFakeClock();
			const action = new CoderAgentChatAction(
				coderClient,
				octokit as unknown as Octokit,
				inputs,
				createMockContext(),
				clock,
			);

			await action.run();

			// Assert both observable effects of skipping the loop: no
			// getChat and no clock sleep.
			expect(coderClient.mockGetChat).not.toHaveBeenCalled();
			expect(coderClient.mockListChats).not.toHaveBeenCalled();
			expect(clock.sleeps).toEqual([]);
		});

		test("wait=complete polls getChat every 5 seconds until terminal", async () => {
			coderClient.mockGetCoderUserByGithubID.mockResolvedValue(mockUser);
			coderClient.mockCreateChat.mockResolvedValue({
				...mockChat,
				status: "running",
			});
			coderClient.mockGetChat
				.mockResolvedValueOnce({ ...mockChat, status: "running" })
				.mockResolvedValueOnce({ ...mockChat, status: "running" })
				.mockResolvedValueOnce({ ...mockChat, status: "completed" });

			const inputs = createMockInputs({
				githubUserID: 12345,
				wait: "complete",
				waitTimeoutSeconds: 600,
				commentOnIssue: false,
			});
			const clock = createFakeClock();
			const action = new CoderAgentChatAction(
				coderClient,
				octokit as unknown as Octokit,
				inputs,
				createMockContext(),
				clock,
			);

			await action.run();

			// 3 polls + 2 sleeps mirrors doc-check.yaml's cadence.
			// listChats is the wrong API shape; assert it is never used.
			expect(coderClient.mockGetChat).toHaveBeenCalledTimes(3);
			expect(coderClient.mockListChats).not.toHaveBeenCalled();
			expect(clock.sleeps).toEqual([POLL_INTERVAL_MS, POLL_INTERVAL_MS]);
		});

		test("wait=complete + commentOnIssue posts the comment after the chat reaches terminal", async () => {
			// Polling must complete before the comment goes out, otherwise a
			// failure mid-poll would leave a stale "Agent chat:" comment on
			// the issue while the workflow step itself fails.
			coderClient.mockGetCoderUserByGithubID.mockResolvedValue(mockUser);
			coderClient.mockCreateChat.mockResolvedValue({
				...mockChat,
				status: "running",
			});
			coderClient.mockGetChat
				.mockResolvedValueOnce({ ...mockChat, status: "running" })
				.mockResolvedValueOnce({ ...mockChat, status: "completed" });
			octokit.rest.issues.listComments.mockResolvedValue({
				data: [],
			} as ReturnType<typeof octokit.rest.issues.listComments>);
			octokit.rest.issues.createComment.mockResolvedValue(
				{} as ReturnType<typeof octokit.rest.issues.createComment>,
			);

			const inputs = createMockInputs({
				githubUserID: 12345,
				wait: "complete",
				waitTimeoutSeconds: 600,
				commentOnIssue: true,
			});
			const clock = createFakeClock();
			const action = new CoderAgentChatAction(
				coderClient,
				octokit as unknown as Octokit,
				inputs,
				createMockContext(),
				clock,
			);

			await action.run();

			// invocationCallOrder is a monotonic counter shared across all
			// bun:test mocks in the process, so the last getChat call must
			// happen strictly before any comment API call.
			const getChatOrders = coderClient.mockGetChat.mock.invocationCallOrder;
			const lastGetChat = getChatOrders[getChatOrders.length - 1];
			const firstCommentApi = Math.min(
				...octokit.rest.issues.listComments.mock.invocationCallOrder,
				...octokit.rest.issues.createComment.mock.invocationCallOrder,
			);
			expect(lastGetChat).toBeLessThan(firstCommentApi);
			expect(octokit.rest.issues.createComment).toHaveBeenCalled();
		});

		test("wait=complete fails with chat-error-kind=timeout when timeout reached", async () => {
			coderClient.mockGetCoderUserByGithubID.mockResolvedValue(mockUser);
			coderClient.mockCreateChat.mockResolvedValue({
				...mockChat,
				status: "running",
			});
			coderClient.mockGetChat.mockResolvedValue({
				...mockChat,
				status: "running",
			});

			const inputs = createMockInputs({
				githubUserID: 12345,
				wait: "complete",
				waitTimeoutSeconds: 10,
				commentOnIssue: false,
			});
			const clock = createFakeClock();
			const action = new CoderAgentChatAction(
				coderClient,
				octokit as unknown as Octokit,
				inputs,
				createMockContext(),
				clock,
			);

			let caught: unknown;
			try {
				await action.run();
			} catch (err) {
				caught = err;
			}

			expect(caught).toBeInstanceOf(ActionFailureError);
			const err = caught as ActionFailureError;
			expect(err.kind).toBe("timeout");
			expect(err.message).toContain("10");
			expect(err.chat).toBeDefined();
			expect(err.chat?.status).toBe("running");
		});

		test("wait=complete fails when chat enters error during polling", async () => {
			coderClient.mockGetCoderUserByGithubID.mockResolvedValue(mockUser);
			coderClient.mockCreateChat.mockResolvedValue({
				...mockChat,
				status: "running",
			});
			coderClient.mockGetChat
				.mockResolvedValueOnce({ ...mockChat, status: "running" })
				.mockResolvedValueOnce({
					...mockChat,
					status: "error",
					last_error: "Anthropic 429 rate limit",
				});

			const inputs = createMockInputs({
				githubUserID: 12345,
				wait: "complete",
				waitTimeoutSeconds: 600,
				commentOnIssue: false,
			});
			const clock = createFakeClock();
			const action = new CoderAgentChatAction(
				coderClient,
				octokit as unknown as Octokit,
				inputs,
				createMockContext(),
				clock,
			);

			let caught: unknown;
			try {
				await action.run();
			} catch (err) {
				caught = err;
			}

			// CODAGT-290 will refine last_error mapping; until then,
			// every error terminal surfaces as api_error.
			expect(caught).toBeInstanceOf(ActionFailureError);
			const err = caught as ActionFailureError;
			expect(err.kind).toBe("api_error");
			expect(err.message).toContain("Anthropic 429 rate limit");
			expect(err.chat).toBeDefined();
			expect(err.chat?.status).toBe("error");
		});

		test("wait=complete reaches terminal status, outputs reflect final chat state", async () => {
			coderClient.mockGetCoderUserByGithubID.mockResolvedValue(mockUser);
			const initialChat = {
				...mockChat,
				status: "running" as const,
				title: "initial title",
			};
			const finalChat = {
				...mockChat,
				status: "completed" as const,
				title: "final title",
			};
			coderClient.mockCreateChat.mockResolvedValue(initialChat);
			coderClient.mockGetChat
				.mockResolvedValueOnce({ ...mockChat, status: "running" })
				.mockResolvedValueOnce(finalChat);

			const inputs = createMockInputs({
				githubUserID: 12345,
				wait: "complete",
				waitTimeoutSeconds: 600,
				commentOnIssue: false,
			});
			const clock = createFakeClock();
			const action = new CoderAgentChatAction(
				coderClient,
				octokit as unknown as Octokit,
				inputs,
				createMockContext(),
				clock,
			);

			const result = await action.run();
			const parsed = ActionOutputsSchema.parse(result);

			expect(parsed.chatStatus).toBe("completed");
			expect(parsed.chatTitle).toBe("final title");
		});

		test("wait=complete also polls when existing-chat-id is set", async () => {
			coderClient.mockGetCoderUserByGithubID.mockResolvedValue(mockUser);
			coderClient.mockCreateChatMessage.mockResolvedValue(
				mockChatMessageResponse,
			);
			const finalChat = {
				...mockChat,
				status: "completed" as const,
				title: "final title",
			};
			coderClient.mockGetChat
				.mockResolvedValueOnce({ ...mockChat, status: "running" })
				.mockResolvedValueOnce(finalChat);

			const existingChatId = "990e8400-e29b-41d4-a716-446655440000";
			const inputs = createMockInputs({
				githubUserID: 12345,
				existingChatId,
				wait: "complete",
				waitTimeoutSeconds: 600,
				commentOnIssue: false,
			});
			const clock = createFakeClock();
			const action = new CoderAgentChatAction(
				coderClient,
				octokit as unknown as Octokit,
				inputs,
				createMockContext(),
				clock,
			);

			const result = await action.run();

			// The follow-up message branch must honor wait=complete just
			// like the new-chat branch. action.yaml describes wait without
			// scoping to new chats; the implementation must match.
			expect(coderClient.mockCreateChatMessage).toHaveBeenCalled();
			expect(coderClient.mockGetChat).toHaveBeenCalledTimes(2);
			expect(clock.sleeps).toEqual([POLL_INTERVAL_MS]);

			const parsed = ActionOutputsSchema.parse(result);
			expect(parsed.chatCreated).toBe(false);
			expect(parsed.chatStatus).toBe("completed");
			expect(parsed.chatTitle).toBe("final title");
		});

		test("wait=complete fails with chat-error-kind=api_error when getChat throws", async () => {
			coderClient.mockGetCoderUserByGithubID.mockResolvedValue(mockUser);
			coderClient.mockCreateChat.mockResolvedValue({
				...mockChat,
				status: "running",
			});
			coderClient.mockGetChat.mockRejectedValue(
				new Error("connection reset by peer"),
			);

			const inputs = createMockInputs({
				githubUserID: 12345,
				wait: "complete",
				waitTimeoutSeconds: 600,
				commentOnIssue: false,
			});
			const clock = createFakeClock();
			const action = new CoderAgentChatAction(
				coderClient,
				octokit as unknown as Octokit,
				inputs,
				createMockContext(),
				clock,
			);

			let caught: unknown;
			try {
				await action.run();
			} catch (err) {
				caught = err;
			}

			// A transport failure during polling must surface as
			// ActionFailureError so workflows can branch on chat-error-kind.
			expect(caught).toBeInstanceOf(ActionFailureError);
			const err = caught as ActionFailureError;
			expect(err.kind).toBe("api_error");
			expect(err.message).toContain("connection reset by peer");
			// The loop tolerates MAX_CONSECUTIVE_POLL_FAILURES - 1 failures
			// before failing. With every poll rejecting, that means 3
			// getChat calls and 2 sleeps in between.
			expect(err.message).toContain("3 attempts");
			expect(coderClient.mockGetChat).toHaveBeenCalledTimes(
				MAX_CONSECUTIVE_POLL_FAILURES,
			);
			expect(clock.sleeps).toEqual([POLL_INTERVAL_MS, POLL_INTERVAL_MS]);
			// pollWithContext re-throws with the at-creation chat so
			// chat-id and chat-status outputs survive the failed fetch.
			expect(err.chat).toBeDefined();
			expect(err.chat?.status).toBe("running");
			expect(err.chatId).toBeDefined();
			expect(err.chatUrl).toContain("/chats/");
			expect(err.coderUsername).toBe(mockUser.username);
		});

		test("wait=complete returns successfully when chat reaches waiting", async () => {
			// `waiting` is terminal but ambiguous (agent done vs agent
			// waiting for input); pin the success path explicitly so a
			// regression that drops it from TERMINAL_STATUSES fails here.
			coderClient.mockGetCoderUserByGithubID.mockResolvedValue(mockUser);
			coderClient.mockCreateChat.mockResolvedValue({
				...mockChat,
				status: "running",
			});
			coderClient.mockGetChat.mockResolvedValueOnce({
				...mockChat,
				status: "waiting",
			});

			const inputs = createMockInputs({
				githubUserID: 12345,
				wait: "complete",
				waitTimeoutSeconds: 600,
				commentOnIssue: false,
			});
			const clock = createFakeClock();
			const action = new CoderAgentChatAction(
				coderClient,
				octokit as unknown as Octokit,
				inputs,
				createMockContext(),
				clock,
			);

			const result = await action.run();
			const parsed = ActionOutputsSchema.parse(result);

			expect(parsed.chatStatus).toBe("waiting");
		});

		test("wait=complete fails with default message when chat error has no last_error", async () => {
			// Covers the `last_error || fallback` branch.
			coderClient.mockGetCoderUserByGithubID.mockResolvedValue(mockUser);
			coderClient.mockCreateChat.mockResolvedValue({
				...mockChat,
				status: "running",
			});
			coderClient.mockGetChat.mockResolvedValueOnce({
				...mockChat,
				status: "error",
				last_error: null,
			});

			const inputs = createMockInputs({
				githubUserID: 12345,
				wait: "complete",
				waitTimeoutSeconds: 600,
				commentOnIssue: false,
			});
			const clock = createFakeClock();
			const action = new CoderAgentChatAction(
				coderClient,
				octokit as unknown as Octokit,
				inputs,
				createMockContext(),
				clock,
			);

			let caught: unknown;
			try {
				await action.run();
			} catch (err) {
				caught = err;
			}

			expect(caught).toBeInstanceOf(ActionFailureError);
			const err = caught as ActionFailureError;
			expect(err.kind).toBe("api_error");
			expect(err.message).toBe("Chat ended in error state");
		});

		test("wait=complete + existingChatId waits past stale terminal (TOCTOU)", async () => {
			// Sending a follow-up to a chat already in `waiting` should
			// not return immediately on the first poll.
			// requireNonTerminalFirst forces the loop to observe the
			// agent transitioning before accepting any terminal.
			coderClient.mockGetCoderUserByGithubID.mockResolvedValue(mockUser);
			coderClient.mockCreateChatMessage.mockResolvedValue(
				mockChatMessageResponse,
			);
			coderClient.mockGetChat
				.mockResolvedValueOnce({ ...mockChat, status: "waiting" })
				.mockResolvedValueOnce({ ...mockChat, status: "running" })
				.mockResolvedValueOnce({
					...mockChat,
					status: "completed",
					title: "after follow-up",
				});

			const existingChatId = "990e8400-e29b-41d4-a716-446655440000";
			const inputs = createMockInputs({
				githubUserID: 12345,
				existingChatId,
				wait: "complete",
				waitTimeoutSeconds: 600,
				commentOnIssue: false,
			});
			const clock = createFakeClock();
			const action = new CoderAgentChatAction(
				coderClient,
				octokit as unknown as Octokit,
				inputs,
				createMockContext(),
				clock,
			);

			const result = await action.run();

			expect(coderClient.mockGetChat).toHaveBeenCalledTimes(3);
			expect(clock.sleeps).toEqual([POLL_INTERVAL_MS, POLL_INTERVAL_MS]);

			const parsed = ActionOutputsSchema.parse(result);
			expect(parsed.chatStatus).toBe("completed");
			expect(parsed.chatTitle).toBe("after follow-up");
		});

		test("wait=complete on new-chat path accepts terminal on first poll (no requireNonTerminalFirst)", async () => {
			// New-chat branch leaves requireNonTerminalFirst false:
			// createChat returns a fresh chat, so a terminal on the
			// first poll is real.
			coderClient.mockGetCoderUserByGithubID.mockResolvedValue(mockUser);
			coderClient.mockCreateChat.mockResolvedValue({
				...mockChat,
				status: "running",
			});
			coderClient.mockGetChat.mockResolvedValueOnce({
				...mockChat,
				status: "completed",
			});

			const inputs = createMockInputs({
				githubUserID: 12345,
				wait: "complete",
				waitTimeoutSeconds: 600,
				commentOnIssue: false,
			});
			const clock = createFakeClock();
			const action = new CoderAgentChatAction(
				coderClient,
				octokit as unknown as Octokit,
				inputs,
				createMockContext(),
				clock,
			);

			await action.run();

			expect(coderClient.mockGetChat).toHaveBeenCalledTimes(1);
			expect(clock.sleeps).toEqual([]);
		});

		test("wait=complete tolerates transient getChat failures up to the threshold", async () => {
			// First two getChat calls reject (transient outage); the third
			// returns a terminal status. The loop must stay alive across
			// the failures rather than failing fast on the first one.
			coderClient.mockGetCoderUserByGithubID.mockResolvedValue(mockUser);
			coderClient.mockCreateChat.mockResolvedValue({
				...mockChat,
				status: "running",
			});
			coderClient.mockGetChat
				.mockRejectedValueOnce(new Error("503 Service Unavailable"))
				.mockRejectedValueOnce(new Error("503 Service Unavailable"))
				.mockResolvedValueOnce({ ...mockChat, status: "completed" });

			const inputs = createMockInputs({
				githubUserID: 12345,
				wait: "complete",
				waitTimeoutSeconds: 600,
				commentOnIssue: false,
			});
			const clock = createFakeClock();
			const action = new CoderAgentChatAction(
				coderClient,
				octokit as unknown as Octokit,
				inputs,
				createMockContext(),
				clock,
			);

			const result = await action.run();

			expect(coderClient.mockGetChat).toHaveBeenCalledTimes(3);
			expect(clock.sleeps).toEqual([POLL_INTERVAL_MS, POLL_INTERVAL_MS]);
			const parsed = ActionOutputsSchema.parse(result);
			expect(parsed.chatStatus).toBe("completed");
		});

		test("wait=complete + existingChatId surfaces api_error context when getChat throws", async () => {
			// Existing-chat-id branch calls pollWithContext without
			// atCreation, so the rewrap path is skipped: err.chat stays
			// undefined but err.chatId, chatUrl, and coderUsername are
			// still decorated for the failure outputs.
			coderClient.mockGetCoderUserByGithubID.mockResolvedValue(mockUser);
			coderClient.mockCreateChatMessage.mockResolvedValue(
				mockChatMessageResponse,
			);
			coderClient.mockGetChat.mockRejectedValue(
				new Error("connection reset by peer"),
			);

			const existingChatId = "990e8400-e29b-41d4-a716-446655440000";
			const inputs = createMockInputs({
				githubUserID: 12345,
				existingChatId,
				wait: "complete",
				waitTimeoutSeconds: 600,
				commentOnIssue: false,
			});
			const clock = createFakeClock();
			const action = new CoderAgentChatAction(
				coderClient,
				octokit as unknown as Octokit,
				inputs,
				createMockContext(),
				clock,
			);

			let caught: unknown;
			try {
				await action.run();
			} catch (err) {
				caught = err;
			}

			expect(caught).toBeInstanceOf(ActionFailureError);
			const err = caught as ActionFailureError;
			expect(err.kind).toBe("api_error");
			expect(err.chat).toBeUndefined();
			expect(String(err.chatId)).toBe(existingChatId);
			expect(err.chatUrl).toContain("/chats/");
			expect(err.coderUsername).toBe(mockUser.username);
		});

		test("wait=complete + requireNonTerminalFirst times out with a stale-terminal message", async () => {
			// Every poll returns the same terminal status the chat was
			// already in. The loop hits the timeout without ever
			// observing a non-terminal observation; the failure message
			// distinguishes this from a normal "ran out of time" timeout.
			coderClient.mockGetCoderUserByGithubID.mockResolvedValue(mockUser);
			coderClient.mockCreateChatMessage.mockResolvedValue(
				mockChatMessageResponse,
			);
			coderClient.mockGetChat.mockResolvedValue({
				...mockChat,
				status: "waiting",
			});

			const existingChatId = "990e8400-e29b-41d4-a716-446655440000";
			const inputs = createMockInputs({
				githubUserID: 12345,
				existingChatId,
				wait: "complete",
				waitTimeoutSeconds: 10,
				commentOnIssue: false,
			});
			const clock = createFakeClock();
			const action = new CoderAgentChatAction(
				coderClient,
				octokit as unknown as Octokit,
				inputs,
				createMockContext(),
				clock,
			);

			let caught: unknown;
			try {
				await action.run();
			} catch (err) {
				caught = err;
			}

			expect(caught).toBeInstanceOf(ActionFailureError);
			const err = caught as ActionFailureError;
			expect(err.kind).toBe("timeout");
			expect(err.message).toContain("remained in terminal status");
			expect(err.message).toContain("`waiting`");
			expect(err.message).toContain("agent may not have processed");
			expect(err.chat?.status).toBe("waiting");
		});

		test("wait=complete + existingChatId accepts a fast terminal-to-terminal transition", async () => {
			// Chat is in `waiting`, follow-up sent, agent completes within
			// one poll interval. The second poll sees `completed`. Tracking
			// only `sawNonTerminal` would treat both polls as stale; the
			// loop must accept the second terminal because it differs from
			// the first.
			coderClient.mockGetCoderUserByGithubID.mockResolvedValue(mockUser);
			coderClient.mockCreateChatMessage.mockResolvedValue(
				mockChatMessageResponse,
			);
			coderClient.mockGetChat
				.mockResolvedValueOnce({ ...mockChat, status: "waiting" })
				.mockResolvedValueOnce({
					...mockChat,
					status: "completed",
					title: "after follow-up",
				});

			const existingChatId = "990e8400-e29b-41d4-a716-446655440000";
			const inputs = createMockInputs({
				githubUserID: 12345,
				existingChatId,
				wait: "complete",
				waitTimeoutSeconds: 600,
				commentOnIssue: false,
			});
			const clock = createFakeClock();
			const action = new CoderAgentChatAction(
				coderClient,
				octokit as unknown as Octokit,
				inputs,
				createMockContext(),
				clock,
			);

			const result = await action.run();

			expect(coderClient.mockGetChat).toHaveBeenCalledTimes(2);
			expect(clock.sleeps).toEqual([POLL_INTERVAL_MS]);
			const parsed = ActionOutputsSchema.parse(result);
			expect(parsed.chatStatus).toBe("completed");
			expect(parsed.chatTitle).toBe("after follow-up");
		});

		test("wait=complete + existingChatId surfaces api_error when terminal transitions to error", async () => {
			// Chat is in `waiting`, follow-up sent, agent fails within one
			// poll interval. Second poll sees `error` (different terminal):
			// the loop must reach throwOnChatError, not time out.
			coderClient.mockGetCoderUserByGithubID.mockResolvedValue(mockUser);
			coderClient.mockCreateChatMessage.mockResolvedValue(
				mockChatMessageResponse,
			);
			coderClient.mockGetChat
				.mockResolvedValueOnce({ ...mockChat, status: "waiting" })
				.mockResolvedValueOnce({
					...mockChat,
					status: "error",
					last_error: "agent crashed",
				});

			const existingChatId = "990e8400-e29b-41d4-a716-446655440000";
			const inputs = createMockInputs({
				githubUserID: 12345,
				existingChatId,
				wait: "complete",
				waitTimeoutSeconds: 600,
				commentOnIssue: false,
			});
			const clock = createFakeClock();
			const action = new CoderAgentChatAction(
				coderClient,
				octokit as unknown as Octokit,
				inputs,
				createMockContext(),
				clock,
			);

			let caught: unknown;
			try {
				await action.run();
			} catch (err) {
				caught = err;
			}

			expect(caught).toBeInstanceOf(ActionFailureError);
			const err = caught as ActionFailureError;
			expect(err.kind).toBe("api_error");
			expect(err.message).toBe("agent crashed");
		});

		test("wait=complete timeout sets chat-id even when latest is undefined", async () => {
			// All polls fail transiently; the loop times out before
			// MAX_CONSECUTIVE_POLL_FAILURES is reached. latest stays
			// undefined, so error.chat is undefined too, but error.chatId
			// must be populated from the options so chat-id output is set.
			coderClient.mockGetCoderUserByGithubID.mockResolvedValue(mockUser);
			coderClient.mockCreateChatMessage.mockResolvedValue(
				mockChatMessageResponse,
			);
			coderClient.mockGetChat.mockRejectedValue(new Error("503"));

			const existingChatId = "990e8400-e29b-41d4-a716-446655440000";
			const inputs = createMockInputs({
				githubUserID: 12345,
				existingChatId,
				wait: "complete",
				waitTimeoutSeconds: 4,
				commentOnIssue: false,
			});
			const clock = createFakeClock();
			const action = new CoderAgentChatAction(
				coderClient,
				octokit as unknown as Octokit,
				inputs,
				createMockContext(),
				clock,
			);

			let caught: unknown;
			try {
				await action.run();
			} catch (err) {
				caught = err;
			}

			expect(caught).toBeInstanceOf(ActionFailureError);
			const err = caught as ActionFailureError;
			expect(err.kind).toBe("timeout");
			expect(err.chat).toBeUndefined();
			expect(String(err.chatId)).toBe(existingChatId);
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
				createMockContext(),
			);

			await expect(action.run()).rejects.toThrow(
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
				createMockContext(),
			);

			await expect(action.run()).rejects.toThrow("Failed to create chat");
		});
	});
});
