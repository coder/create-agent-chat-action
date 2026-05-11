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

		test("converts null pull_request_title to undefined", () => {
			// pull_request_title is .nullable().optional(); explicit null
			// from the API maps to undefined so the output is unset.
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
		test("does not warn for wait=complete", () => {
			const warning = spyOn(core, "warning").mockImplementation(() => {});
			try {
				const inputs = createMockInputs({ wait: "complete" });
				const action = new CoderAgentChatAction(
					coderClient,
					octokit as unknown as Octokit,
					inputs,
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

			// Both identity inputs unset. The schema permits this so the
			// runtime can later auto-resolve from the workflow context;
			// until that lands, action.run must fail with a clear message
			// instead of calling the user lookup with undefined.
			await expect(action.run()).rejects.toThrow(
				/set either `github-user-id` or `coder-username`/,
			);
			expect(coderClient.mockGetCoderUserByGithubID).not.toHaveBeenCalled();
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
			);

			await expect(action.run()).rejects.toThrow("Failed to create chat");
		});
	});
});
