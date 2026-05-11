import { describe, expect, test, beforeEach, spyOn } from "bun:test";
import * as core from "@actions/core";
import {
	ActionFailureError,
	CoderAgentChatAction,
	MAX_CONSECUTIVE_POLL_FAILURES,
	POLL_INTERVAL_MS,
} from "./action";
import type { Octokit } from "./action";
import { CoderAPIError } from "./coder-client";
import { ChatIdSchema, type CoderSDKUser } from "./coder-client";
import { ActionOutputsSchema } from "./schemas";
import {
	MockCoderClient,
	createFakeClock,
	createMockOctokit,
	createMockInputs,
	createMockContext,
	mockUser,
	mockUserNoOrgs,
	mockChat,
	mockChatWithDiff,
	mockChatMessageResponse,
	mockOrganization,
} from "./test-helpers";

describe("CoderAgentChatAction", () => {
	let coderClient: MockCoderClient;
	let octokit: ReturnType<typeof createMockOctokit>;

	beforeEach(() => {
		coderClient = new MockCoderClient();
		octokit = createMockOctokit();
		// CI runners set GITHUB_WORKFLOW from the workflow's `name:` field,
		// which would suffix the marker and break the literal assertions
		// below. Clear it so tests pin the workflow-unset baseline.
		delete process.env.GITHUB_WORKFLOW;
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
		test("creates new comment with marker when none exists", async () => {
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

			await action.commentOnIssue({
				chatUrl: "chat-url",
				owner: "owner",
				repo: "repo",
				issueNumber: 123,
				chatCreated: true,
			});

			expect(octokit.rest.issues.createComment).toHaveBeenCalledTimes(1);
			const call = octokit.rest.issues.createComment.mock.calls[0]?.[0] as {
				owner: string;
				repo: string;
				issue_number: number;
				body: string;
			};
			expect(call.owner).toBe("owner");
			expect(call.repo).toBe("repo");
			expect(call.issue_number).toBe(123);
			expect(call.body).toContain("**Coder Agent Chat: created**");
			expect(call.body).toContain("Chat: chat-url");
			expect(call.body).toContain(
				"<!-- coder-agent-chat-action:test-org/test-repo#123 -->",
			);
		});

		test("updates the existing marker comment in place", async () => {
			const marker = "<!-- coder-agent-chat-action:test-org/test-repo#123 -->";
			octokit.rest.issues.listComments.mockResolvedValue({
				data: [
					{ id: 1, body: `prior\n\n${marker}` },
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

			await action.commentOnIssue({
				chatUrl: "new-url",
				owner: "owner",
				repo: "repo",
				issueNumber: 123,
				chatCreated: true,
			});

			expect(octokit.rest.issues.updateComment).toHaveBeenCalledTimes(1);
			const call = octokit.rest.issues.updateComment.mock.calls[0]?.[0] as {
				comment_id: number;
				body: string;
			};
			expect(call.comment_id).toBe(1);
			expect(call.body).toContain("Chat: new-url");
			expect(call.body).toContain(marker);
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
					action.commentOnIssue({
						chatUrl: "url",
						owner: "owner",
						repo: "repo",
						issueNumber: 123,
						chatCreated: true,
					}),
				).resolves.toBeUndefined();
				expect(errorLog).toHaveBeenCalledWith(
					expect.stringContaining("Failed to post failure comment"),
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
		expect(coderClient.mockCreateChat).toHaveBeenCalledWith(
			expect.objectContaining({
				content: [{ type: "text", text: "Test prompt" }],
				workspace_id: undefined,
				model_config_id: undefined,
			}),
		);

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
			coderClient.mockGetCoderUserByUsername.mockResolvedValue({
				...mockUser,
				username: "bot-user",
			});
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
			// The real RealCoderClient.getCoderUserByGitHubId throws
			// CoderAPIError with status 404; the mock must match so
			// classifyError sees user_not_found rather than the api_error
			// fallback.
			coderClient.mockGetCoderUserByGithubID.mockRejectedValue(
				new CoderAPIError(
					"No Coder user found with GitHub user ID 12345",
					404,
					undefined,
					"user_not_found",
				),
			);
			octokit.rest.issues.listComments.mockResolvedValue({
				data: [],
			} as ReturnType<typeof octokit.rest.issues.listComments>);
			octokit.rest.issues.createComment.mockResolvedValue(
				{} as ReturnType<typeof octokit.rest.issues.createComment>,
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
			// Assert the failure went through user_not_found classification
			// (the comment body kind line proves classifyError matched).
			const call = octokit.rest.issues.createComment.mock.calls[0]?.[0] as
				| { body: string }
				| undefined;
			expect(call?.body).toContain("chat-error-kind=user_not_found");
		});

		test("throws error when chat creation fails", async () => {
			coderClient.mockGetCoderUserByGithubID.mockResolvedValue(mockUser);
			coderClient.mockCreateChat.mockRejectedValue(
				new Error("Failed to create chat"),
			);
			octokit.rest.issues.listComments.mockResolvedValue({
				data: [],
			} as ReturnType<typeof octokit.rest.issues.listComments>);
			octokit.rest.issues.createComment.mockResolvedValue(
				{} as ReturnType<typeof octokit.rest.issues.createComment>,
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

		test(
			"posts a failure comment with chat-error-kind=spend_exceeded " +
				"and spent/limit amounts on 409 spend-exceeded shape",
			async () => {
				coderClient.mockGetCoderUserByGithubID.mockResolvedValue(mockUser);
				coderClient.mockCreateChat.mockRejectedValue(
					new CoderAPIError(
						"Coder API error: Conflict",
						409,
						JSON.stringify({
							message: "Chat usage limit exceeded.",
							spent_micros: 7_500_000,
							limit_micros: 10_000_000,
							resets_at: "2026-05-01T00:00:00Z",
						}),
					),
				);
				octokit.rest.issues.listComments.mockResolvedValue({
					data: [],
				} as ReturnType<typeof octokit.rest.issues.listComments>);
				octokit.rest.issues.createComment.mockResolvedValue(
					{} as ReturnType<typeof octokit.rest.issues.createComment>,
				);

				const inputs = createMockInputs({ githubUserID: 12345 });
				const action = new CoderAgentChatAction(
					coderClient,
					octokit as unknown as Octokit,
					inputs,
					createMockContext(),
				);

				await expect(action.run()).rejects.toThrow();

				expect(octokit.rest.issues.createComment).toHaveBeenCalledTimes(1);
				const call = octokit.rest.issues.createComment.mock.calls[0]?.[0] as
					| { body: string }
					| undefined;
				expect(call?.body).toContain("chat-error-kind=spend_exceeded");
				expect(call?.body).toContain("$7.50");
				expect(call?.body).toContain("$10.00");
				expect(call?.body).toContain("https://coder.test/chats");
				expect(call?.body).toContain(
					"<!-- coder-agent-chat-action:test-org/test-repo#123 -->",
				);
			},
		);

		test(
			"posts a failure comment with chat-error-kind=user_not_found and " +
				"names the input that needs adjusting",
			async () => {
				coderClient.mockGetCoderUserByGithubID.mockRejectedValue(
					new CoderAPIError(
						"No Coder user found with GitHub user ID 12345",
						404,
						undefined,
						"user_not_found",
					),
				);
				octokit.rest.issues.listComments.mockResolvedValue({
					data: [],
				} as ReturnType<typeof octokit.rest.issues.listComments>);
				octokit.rest.issues.createComment.mockResolvedValue(
					{} as ReturnType<typeof octokit.rest.issues.createComment>,
				);

				const inputs = createMockInputs({ githubUserID: 12345 });
				const action = new CoderAgentChatAction(
					coderClient,
					octokit as unknown as Octokit,
					inputs,
					createMockContext(),
				);

				await expect(action.run()).rejects.toThrow();

				expect(octokit.rest.issues.createComment).toHaveBeenCalledTimes(1);
				const call = octokit.rest.issues.createComment.mock.calls[0]?.[0] as
					| { body: string }
					| undefined;
				expect(call?.body).toContain("chat-error-kind=user_not_found");
				expect(call?.body).toContain("github-user-id");
				expect(call?.body).toContain("coder-username");
				expect(call?.body).toContain(
					"<!-- coder-agent-chat-action:test-org/test-repo#123 -->",
				);
			},
		);

		test(
			"posts a failure comment with chat-error-kind=user_ambiguous and " +
				"suggests coder-username",
			async () => {
				coderClient.mockGetCoderUserByGithubID.mockRejectedValue(
					new CoderAPIError(
						"Multiple Coder users found with GitHub user ID 12345",
						409,
						undefined,
						"user_ambiguous",
					),
				);
				octokit.rest.issues.listComments.mockResolvedValue({
					data: [],
				} as ReturnType<typeof octokit.rest.issues.listComments>);
				octokit.rest.issues.createComment.mockResolvedValue(
					{} as ReturnType<typeof octokit.rest.issues.createComment>,
				);

				const inputs = createMockInputs({ githubUserID: 12345 });
				const action = new CoderAgentChatAction(
					coderClient,
					octokit as unknown as Octokit,
					inputs,
					createMockContext(),
				);

				await expect(action.run()).rejects.toThrow();

				expect(octokit.rest.issues.createComment).toHaveBeenCalledTimes(1);
				const call = octokit.rest.issues.createComment.mock.calls[0]?.[0] as
					| { body: string }
					| undefined;
				expect(call?.body).toContain("chat-error-kind=user_ambiguous");
				expect(call?.body).toContain("coder-username");
				expect(call?.body).toContain(
					"<!-- coder-agent-chat-action:test-org/test-repo#123 -->",
				);
			},
		);

		test("falls back to chat-error-kind=api_error for unknown 4xx shapes", async () => {
			coderClient.mockGetCoderUserByGithubID.mockResolvedValue(mockUser);
			coderClient.mockCreateChat.mockRejectedValue(
				new CoderAPIError("Coder API error: Bad Request", 400, ""),
			);
			octokit.rest.issues.listComments.mockResolvedValue({
				data: [],
			} as ReturnType<typeof octokit.rest.issues.listComments>);
			octokit.rest.issues.createComment.mockResolvedValue(
				{} as ReturnType<typeof octokit.rest.issues.createComment>,
			);

			const inputs = createMockInputs({ githubUserID: 12345 });
			const action = new CoderAgentChatAction(
				coderClient,
				octokit as unknown as Octokit,
				inputs,
				createMockContext(),
			);

			await expect(action.run()).rejects.toThrow();

			expect(octokit.rest.issues.createComment).toHaveBeenCalledTimes(1);
			const call = octokit.rest.issues.createComment.mock.calls[0]?.[0] as
				| { body: string }
				| undefined;
			expect(call?.body).toContain("chat-error-kind=api_error");
			expect(call?.body).toContain(
				"<!-- coder-agent-chat-action:test-org/test-repo#123 -->",
			);
		});

		test("posts no failure comment when commentOnIssue=false", async () => {
			coderClient.mockGetCoderUserByGithubID.mockResolvedValue(mockUser);
			coderClient.mockCreateChat.mockRejectedValue(
				new CoderAPIError("Coder API error: Bad Request", 400, ""),
			);

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

			await expect(action.run()).rejects.toThrow();

			expect(octokit.rest.issues.listComments).not.toHaveBeenCalled();
			expect(octokit.rest.issues.createComment).not.toHaveBeenCalled();
			expect(octokit.rest.issues.updateComment).not.toHaveBeenCalled();
		});

		test(
			"updates existing failure comment in place when re-run with the " +
				"same marker key",
			async () => {
				coderClient.mockGetCoderUserByGithubID.mockResolvedValue(mockUser);
				coderClient.mockCreateChat.mockRejectedValue(
					new CoderAPIError("Coder API error: Bad Request", 400, ""),
				);
				const marker =
					"<!-- coder-agent-chat-action:test-org/test-repo#123 -->";
				octokit.rest.issues.listComments.mockResolvedValue({
					data: [
						{ id: 1, body: "Some unrelated comment" },
						{
							id: 2,
							body: `Earlier failure body\n\n${marker}`,
						},
					],
				} as ReturnType<typeof octokit.rest.issues.listComments>);
				octokit.rest.issues.updateComment.mockResolvedValue(
					{} as ReturnType<typeof octokit.rest.issues.updateComment>,
				);

				const inputs = createMockInputs({ githubUserID: 12345 });
				const action = new CoderAgentChatAction(
					coderClient,
					octokit as unknown as Octokit,
					inputs,
					createMockContext(),
				);

				await expect(action.run()).rejects.toThrow();

				expect(octokit.rest.issues.updateComment).toHaveBeenCalledTimes(1);
				const updateCall = octokit.rest.issues.updateComment.mock
					.calls[0]?.[0] as { comment_id: number; body: string } | undefined;
				expect(updateCall?.comment_id).toBe(2);
				expect(updateCall?.body).toContain(marker);
				expect(octokit.rest.issues.createComment).not.toHaveBeenCalled();
			},
		);

		test(
			"scopes the marker by GITHUB_WORKFLOW so two workflows on the " +
				"same target do not overwrite each other",
			async () => {
				process.env.GITHUB_WORKFLOW = "doc-check";
				try {
					coderClient.mockGetCoderUserByGithubID.mockResolvedValue(mockUser);
					coderClient.mockCreateChat.mockRejectedValue(
						new CoderAPIError("Coder API error: Bad Request", 400, ""),
					);
					octokit.rest.issues.listComments.mockResolvedValue({
						data: [],
					} as ReturnType<typeof octokit.rest.issues.listComments>);
					octokit.rest.issues.createComment.mockResolvedValue(
						{} as ReturnType<typeof octokit.rest.issues.createComment>,
					);

					const inputs = createMockInputs({ githubUserID: 12345 });
					const action = new CoderAgentChatAction(
						coderClient,
						octokit as unknown as Octokit,
						inputs,
						createMockContext(),
					);

					await expect(action.run()).rejects.toThrow();

					expect(octokit.rest.issues.createComment).toHaveBeenCalledTimes(1);
					const call = octokit.rest.issues.createComment.mock.calls[0]?.[0] as
						| { body: string }
						| undefined;
					expect(call?.body).toContain(
						"<!-- coder-agent-chat-action:test-org/test-repo#123:doc-check -->",
					);
				} finally {
					delete process.env.GITHUB_WORKFLOW;
				}
			},
		);

		test(
			"posts a failure comment when github-url is a pull request URL " +
				"(end-to-end PR support)",
			async () => {
				coderClient.mockGetCoderUserByGithubID.mockResolvedValue(mockUser);
				coderClient.mockCreateChat.mockRejectedValue(
					new CoderAPIError("Coder API error: Bad Request", 400, ""),
				);
				octokit.rest.issues.listComments.mockResolvedValue({
					data: [],
				} as ReturnType<typeof octokit.rest.issues.listComments>);
				octokit.rest.issues.createComment.mockResolvedValue(
					{} as ReturnType<typeof octokit.rest.issues.createComment>,
				);

				const inputs = createMockInputs({
					githubUserID: 12345,
					githubURL: "https://github.com/test-org/test-repo/pull/77",
				});
				const action = new CoderAgentChatAction(
					coderClient,
					octokit as unknown as Octokit,
					inputs,
					createMockContext(),
				);

				await expect(action.run()).rejects.toThrow();

				expect(octokit.rest.issues.createComment).toHaveBeenCalledTimes(1);
				const call = octokit.rest.issues.createComment.mock.calls[0]?.[0] as
					| { issue_number: number; body: string }
					| undefined;
				expect(call?.issue_number).toBe(77);
				expect(call?.body).toContain(
					"<!-- coder-agent-chat-action:test-org/test-repo#77 -->",
				);
			},
		);

		// chat-error-* outputs are the machine-readable contract for
		// downstream workflow steps. The classified error must travel from
		// run() through index.ts via ActionFailureError so the OUTPUT_MAP
		// table is the single source of truth for output names.
		test(
			"throws ActionFailureError carrying chat-error-* outputs on " +
				"the failure path",
			async () => {
				coderClient.mockGetCoderUserByGithubID.mockResolvedValue(mockUser);
				coderClient.mockCreateChat.mockRejectedValue(
					new CoderAPIError("Coder API error: Bad Request", 400, ""),
				);
				octokit.rest.issues.listComments.mockResolvedValue({
					data: [],
				} as ReturnType<typeof octokit.rest.issues.listComments>);
				octokit.rest.issues.createComment.mockResolvedValue(
					{} as ReturnType<typeof octokit.rest.issues.createComment>,
				);

				const inputs = createMockInputs({ githubUserID: 12345 });
				const action = new CoderAgentChatAction(
					coderClient,
					octokit as unknown as Octokit,
					inputs,
					createMockContext(),
				);

				let caught: unknown;
				try {
					await action.run();
				} catch (error) {
					caught = error;
				}
				expect(caught).toBeInstanceOf(ActionFailureError);
				const failure = caught as ActionFailureError;
				expect(failure.kind).toBe("api_error");
				expect(failure.message).toBe("Coder API error: Bad Request");
				expect(failure.cause).toBeInstanceOf(CoderAPIError);
			},
		);

		// Posting the failure comment must never mask the original API
		// error. If the GitHub API rejects, the classified error must still
		// propagate (not the GitHub error) so the workflow surfaces the
		// actual failure.
		test(
			"propagates the classified error when GitHub comment posting " +
				"itself fails",
			async () => {
				coderClient.mockGetCoderUserByGithubID.mockResolvedValue(mockUser);
				coderClient.mockCreateChat.mockRejectedValue(
					new CoderAPIError("Coder API error: Bad Request", 400, ""),
				);
				// paginate (which findCommentByPredicate uses) rejects.
				octokit.paginate.mockRejectedValue(new Error("boom"));

				const inputs = createMockInputs({ githubUserID: 12345 });
				const action = new CoderAgentChatAction(
					coderClient,
					octokit as unknown as Octokit,
					inputs,
					createMockContext(),
				);

				let caught: unknown;
				try {
					await action.run();
				} catch (error) {
					caught = error;
				}
				expect(caught).toBeInstanceOf(ActionFailureError);
				expect((caught as ActionFailureError).kind).toBe("api_error");
			},
		);

		// `handleFailure`'s defensive catch around `parseGithubURL` keeps a
		// malformed github-url from masking the original API error. The
		// schema only validates URL syntax, so a URL like
		// `https://github.com/foo` passes the schema but the regex does not
		// match.
		test(
			"degrades gracefully when github-url passes schema but fails " +
				"the issue/PR regex",
			async () => {
				// Failing the user lookup means parseGithubURL never runs in
				// runInner; only handleFailure's defensive call hits the bad URL.
				coderClient.mockGetCoderUserByGithubID.mockRejectedValue(
					new CoderAPIError(
						"No Coder user found with GitHub user ID 12345",
						404,
						undefined,
						"user_not_found",
					),
				);

				const inputs = createMockInputs({
					githubUserID: 12345,
					// Passes schema (.url()) but does not match the issue/PR regex.
					githubURL: "https://github.com/owner-only",
				});
				const action = new CoderAgentChatAction(
					coderClient,
					octokit as unknown as Octokit,
					inputs,
					createMockContext(),
				);

				let caught: unknown;
				try {
					await action.run();
				} catch (error) {
					caught = error;
				}
				// The classified error survived the parseGithubURL throw inside
				// handleFailure: chat-error-kind is user_not_found, not the
				// parser's "Invalid GitHub URL" string.
				expect(caught).toBeInstanceOf(ActionFailureError);
				expect((caught as ActionFailureError).kind).toBe("user_not_found");
				expect((caught as ActionFailureError).message).toContain(
					"No Coder user found",
				);
				// No comment posted because the parser rejected the URL.
				expect(octokit.rest.issues.createComment).not.toHaveBeenCalled();
			},
		);
	});

	describe("Organization resolution", () => {
		test("resolves org by name to a UUID when coder-organization is set", async () => {
			coderClient.mockGetCoderUserByGithubID.mockResolvedValue(mockUser);
			coderClient.mockCreateChat.mockResolvedValue(mockChat);

			const inputs = createMockInputs({
				githubUserID: 12345,
				coderOrganization: "coder",
			});
			const action = new CoderAgentChatAction(
				coderClient,
				octokit as unknown as Octokit,
				inputs,
				createMockContext(),
			);

			await action.run();

			expect(coderClient.mockGetOrganizationByName).toHaveBeenCalledWith(
				"coder",
			);
			expect(coderClient.mockCreateChat).toHaveBeenCalledWith(
				expect.objectContaining({
					organization_id: mockOrganization.id,
				}),
			);
		});

		test("defaults to the resolved user's first org membership when coder-organization is unset", async () => {
			coderClient.mockGetCoderUserByGithubID.mockResolvedValue(mockUser);
			coderClient.mockCreateChat.mockResolvedValue(mockChat);

			const inputs = createMockInputs({
				githubUserID: 12345,
				coderOrganization: undefined,
			});
			const action = new CoderAgentChatAction(
				coderClient,
				octokit as unknown as Octokit,
				inputs,
				createMockContext(),
			);

			await action.run();

			expect(coderClient.mockGetOrganizationByName).not.toHaveBeenCalled();
			expect(coderClient.mockCreateChat).toHaveBeenCalledWith(
				expect.objectContaining({
					organization_id: mockUser.organization_ids[0],
				}),
			);
		});

		test("defaults via getCoderUserByUsername when only coder-username is set", async () => {
			coderClient.mockGetCoderUserByUsername.mockResolvedValue(mockUser);
			coderClient.mockCreateChat.mockResolvedValue(mockChat);

			const inputs = createMockInputs({
				githubUserID: undefined,
				coderUsername: mockUser.username,
				coderOrganization: undefined,
			});
			const action = new CoderAgentChatAction(
				coderClient,
				octokit as unknown as Octokit,
				inputs,
				createMockContext(),
			);

			await action.run();

			expect(coderClient.mockGetCoderUserByUsername).toHaveBeenCalledWith(
				mockUser.username,
			);
			expect(coderClient.mockGetOrganizationByName).not.toHaveBeenCalled();
			expect(coderClient.mockCreateChat).toHaveBeenCalledWith(
				expect.objectContaining({
					organization_id: mockUser.organization_ids[0],
				}),
			);
		});

		test("fails with chat-error-kind=org_not_found when the resolved user has no org memberships", async () => {
			coderClient.mockGetCoderUserByGithubID.mockResolvedValue(mockUserNoOrgs);

			const inputs = createMockInputs({
				githubUserID: 12345,
				coderOrganization: undefined,
			});
			const action = new CoderAgentChatAction(
				coderClient,
				octokit as unknown as Octokit,
				inputs,
				createMockContext(),
			);

			let caught: unknown;
			try {
				await action.run();
			} catch (e) {
				caught = e;
			}

			expect(caught).toBeInstanceOf(ActionFailureError);
			expect((caught as ActionFailureError).kind).toBe("org_not_found");
			expect(coderClient.mockCreateChat).not.toHaveBeenCalled();
		});

		test("wraps getOrganizationByName 404 in ActionFailureError(org_not_found)", async () => {
			coderClient.mockGetCoderUserByGithubID.mockResolvedValue(mockUser);
			coderClient.mockGetOrganizationByName.mockRejectedValue(
				new CoderAPIError("Coder API error: Not Found", 404),
			);

			const inputs = createMockInputs({
				githubUserID: 12345,
				coderOrganization: "does-not-exist",
			});
			const action = new CoderAgentChatAction(
				coderClient,
				octokit as unknown as Octokit,
				inputs,
				createMockContext(),
			);

			let caught: unknown;
			try {
				await action.run();
			} catch (e) {
				caught = e;
			}

			expect(caught).toBeInstanceOf(ActionFailureError);
			expect((caught as ActionFailureError).kind).toBe("org_not_found");
			expect((caught as ActionFailureError).message).toContain(
				"does-not-exist",
			);
			expect(coderClient.mockCreateChat).not.toHaveBeenCalled();
		});

		test("non-404 CoderAPIError from getOrganizationByName is not classified as org_not_found", async () => {
			coderClient.mockGetCoderUserByGithubID.mockResolvedValue(mockUser);
			coderClient.mockGetOrganizationByName.mockRejectedValue(
				new CoderAPIError("Coder API error: Unauthorized", 401),
			);

			const inputs = createMockInputs({
				githubUserID: 12345,
				coderOrganization: "coder",
			});
			const action = new CoderAgentChatAction(
				coderClient,
				octokit as unknown as Octokit,
				inputs,
				createMockContext(),
			);

			let caught: unknown;
			try {
				await action.run();
			} catch (e) {
				caught = e;
			}

			expect(caught).toBeInstanceOf(ActionFailureError);
			expect((caught as ActionFailureError).kind).not.toBe("org_not_found");
			expect((caught as ActionFailureError).cause).toBeInstanceOf(
				CoderAPIError,
			);
		});

		test("existing-chat-id flow does not resolve the organization", async () => {
			coderClient.mockGetCoderUserByGithubID.mockResolvedValue(mockUserNoOrgs);
			coderClient.mockCreateChatMessage.mockResolvedValue(
				mockChatMessageResponse,
			);

			// User has zero org memberships and no `coder-organization` is set,
			// which would fail the create-chat path. The follow-up path must
			// not trigger that resolution because createChatMessage inherits
			// the chat's organization.
			const inputs = createMockInputs({
				githubUserID: 12345,
				coderOrganization: undefined,
				existingChatId: "990e8400-e29b-41d4-a716-446655440000",
			});
			const action = new CoderAgentChatAction(
				coderClient,
				octokit as unknown as Octokit,
				inputs,
				createMockContext(),
			);

			const result = await action.run();

			expect(coderClient.mockGetOrganizationByName).not.toHaveBeenCalled();
			expect(coderClient.mockGetCoderUserByUsername).not.toHaveBeenCalled();
			expect(coderClient.mockCreateChatMessage).toHaveBeenCalled();
			expect(coderClient.mockCreateChat).not.toHaveBeenCalled();
			expect(result.chatCreated).toBe(false);
		});

		test("wraps getCoderUserByUsername 404 in ActionFailureError(user_not_found)", async () => {
			coderClient.mockGetCoderUserByUsername.mockRejectedValue(
				new CoderAPIError("Coder API error: Not Found", 404),
			);

			const inputs = createMockInputs({
				githubUserID: undefined,
				coderUsername: "missing-user",
				coderOrganization: undefined,
			});
			const action = new CoderAgentChatAction(
				coderClient,
				octokit as unknown as Octokit,
				inputs,
				createMockContext(),
			);

			let caught: unknown;
			try {
				await action.run();
			} catch (e) {
				caught = e;
			}

			expect(caught).toBeInstanceOf(ActionFailureError);
			expect((caught as ActionFailureError).kind).toBe("user_not_found");
			expect((caught as ActionFailureError).message).toContain("missing-user");
			// Cause chain preserves the original CoderAPIError for debugging.
			expect((caught as ActionFailureError).cause).toBeInstanceOf(
				CoderAPIError,
			);
			expect(coderClient.mockCreateChat).not.toHaveBeenCalled();
		});

		test("non-404 CoderAPIError from getCoderUserByUsername is not classified as user_not_found", async () => {
			coderClient.mockGetCoderUserByUsername.mockRejectedValue(
				new CoderAPIError("Coder API error: Unauthorized", 401),
			);

			const inputs = createMockInputs({
				githubUserID: undefined,
				coderUsername: "some-user",
				coderOrganization: undefined,
			});
			const action = new CoderAgentChatAction(
				coderClient,
				octokit as unknown as Octokit,
				inputs,
				createMockContext(),
			);

			let caught: unknown;
			try {
				await action.run();
			} catch (e) {
				caught = e;
			}

			expect(caught).toBeInstanceOf(ActionFailureError);
			expect((caught as ActionFailureError).kind).not.toBe("user_not_found");
			expect((caught as ActionFailureError).cause).toBeInstanceOf(
				CoderAPIError,
			);
		});

		test("warns and picks the first org when the user has multiple memberships", async () => {
			const multiOrgUser = {
				...mockUser,
				organization_ids: [
					mockUser.organization_ids[0],
					"770e8400-e29b-41d4-a716-446655440000",
				],
			};
			coderClient.mockGetCoderUserByGithubID.mockResolvedValue(multiOrgUser);
			coderClient.mockCreateChat.mockResolvedValue(mockChat);
			const warningSpy = spyOn(core, "warning").mockImplementation(() => {});

			try {
				const inputs = createMockInputs({
					githubUserID: 12345,
					coderOrganization: undefined,
				});
				const action = new CoderAgentChatAction(
					coderClient,
					octokit as unknown as Octokit,
					inputs,
					createMockContext(),
				);

				await action.run();

				expect(warningSpy).toHaveBeenCalledTimes(1);
				expect(warningSpy.mock.calls[0][0]).toContain(
					"2 organization memberships",
				);
				expect(warningSpy.mock.calls[0][0]).toContain("coder-organization");
				expect(coderClient.mockCreateChat).toHaveBeenCalledWith(
					expect.objectContaining({
						organization_id: multiOrgUser.organization_ids[0],
					}),
				);
			} finally {
				warningSpy.mockRestore();
			}
		});

		test("single-org user does not emit a warning", async () => {
			coderClient.mockGetCoderUserByGithubID.mockResolvedValue(mockUser);
			coderClient.mockCreateChat.mockResolvedValue(mockChat);
			const warningSpy = spyOn(core, "warning").mockImplementation(() => {});

			try {
				const inputs = createMockInputs({
					githubUserID: 12345,
					coderOrganization: undefined,
				});
				const action = new CoderAgentChatAction(
					coderClient,
					octokit as unknown as Octokit,
					inputs,
					createMockContext(),
				);

				await action.run();

				expect(warningSpy).not.toHaveBeenCalled();
			} finally {
				warningSpy.mockRestore();
			}
		});

		test("ActionFailureError preserves the original error as `cause` when wrapping a 404", async () => {
			coderClient.mockGetCoderUserByGithubID.mockResolvedValue(mockUser);
			const originalError = new CoderAPIError(
				"Coder API error: Not Found",
				404,
			);
			coderClient.mockGetOrganizationByName.mockRejectedValue(originalError);

			const inputs = createMockInputs({
				githubUserID: 12345,
				coderOrganization: "does-not-exist",
			});
			const action = new CoderAgentChatAction(
				coderClient,
				octokit as unknown as Octokit,
				inputs,
				createMockContext(),
			);

			let caught: unknown;
			try {
				await action.run();
			} catch (e) {
				caught = e;
			}

			expect((caught as ActionFailureError).cause).toBe(originalError);
		});
	});

	describe("Idempotency by label", () => {
		test("unset: action creates a new chat without listChats and without labels", async () => {
			coderClient.mockGetCoderUserByGithubID.mockResolvedValue(mockUser);
			coderClient.mockCreateChat.mockResolvedValue(mockChat);

			const inputs = createMockInputs({
				githubUserID: 12345,
				idempotencyKey: undefined,
			});
			const action = new CoderAgentChatAction(
				coderClient,
				octokit as unknown as Octokit,
				inputs,
				createMockContext(),
			);

			await action.run();

			expect(coderClient.mockListChats).not.toHaveBeenCalled();
			expect(coderClient.mockCreateChat).toHaveBeenCalledTimes(1);
			const req = coderClient.mockCreateChat.mock.calls[0]?.[0] as
				| { labels?: Record<string, string> }
				| undefined;
			expect(req?.labels).toBeUndefined();
			expect(coderClient.mockCreateChatMessage).not.toHaveBeenCalled();
		});

		test(
			"set, no match: creates with the three labels and uses the " +
				"sanitized key value",
			async () => {
				coderClient.mockGetCoderUserByGithubID.mockResolvedValue(mockUser);
				coderClient.mockListChats.mockResolvedValue([]);
				coderClient.mockCreateChat.mockResolvedValue(mockChat);

				const inputs = createMockInputs({
					githubUserID: 12345,
					githubURL: "https://github.com/test-org/test-repo/issues/123",
					idempotencyKey: "My Custom Key!",
				});
				const action = new CoderAgentChatAction(
					coderClient,
					octokit as unknown as Octokit,
					inputs,
					createMockContext(),
				);

				await action.run();

				expect(coderClient.mockListChats).toHaveBeenCalledTimes(1);
				expect(coderClient.mockCreateChat).toHaveBeenCalledTimes(1);
				const req = coderClient.mockCreateChat.mock.calls[0]?.[0] as
					| { labels?: Record<string, string> }
					| undefined;
				expect(req?.labels).toBeDefined();
				expect(req?.labels?.["coder-agent-chat-action"]).toBe("true");
				expect(req?.labels?.["gh-target"]).toBe("test-org/test-repo#123");
				expect(req?.labels?.["coder-agent-chat-action-user"]).toBe(mockUser.id);
				// The fourth key is the sanitized idempotency-key: exactly one
				// extra key, allowed by the platform's regex, mapped to "true".
				const sanitizedKeys = Object.keys(req?.labels ?? {}).filter(
					(k) =>
						k !== "coder-agent-chat-action" &&
						k !== "gh-target" &&
						k !== "coder-agent-chat-action-user",
				);
				expect(sanitizedKeys).toHaveLength(1);
				const sanitizedKey = sanitizedKeys[0];
				expect(sanitizedKey).toMatch(/^[a-z0-9][a-z0-9._/-]*$/);
				expect(req?.labels?.[sanitizedKey]).toBe("true");
			},
		);

		test("set, no match: listChats is called with the sanitized label filter", async () => {
			coderClient.mockGetCoderUserByGithubID.mockResolvedValue(mockUser);
			coderClient.mockListChats.mockResolvedValue([]);
			coderClient.mockCreateChat.mockResolvedValue(mockChat);

			const inputs = createMockInputs({
				githubUserID: 12345,
				idempotencyKey: "my-key",
			});
			const action = new CoderAgentChatAction(
				coderClient,
				octokit as unknown as Octokit,
				inputs,
				createMockContext(),
			);

			await action.run();

			expect(coderClient.mockListChats).toHaveBeenCalledTimes(1);
			const arg = coderClient.mockListChats.mock.calls[0]?.[0] as
				| { label?: string | string[]; archived?: boolean }
				| undefined;
			expect(arg?.label).toEqual([
				"my-key:true",
				"gh-target:test-org/test-repo#123",
				`coder-agent-chat-action-user:${mockUser.id}`,
			]);
			expect(arg?.archived).toBe(false);
		});

		test(
			"set, one non-archived match: sends a follow-up via createChatMessage " +
				"and does not create a new chat",
			async () => {
				coderClient.mockGetCoderUserByGithubID.mockResolvedValue(mockUser);
				coderClient.mockListChats.mockResolvedValue([
					{ ...mockChat, archived: false },
				]);
				coderClient.mockCreateChatMessage.mockResolvedValue(
					mockChatMessageResponse,
				);
				coderClient.mockGetChat.mockResolvedValue(mockChat);

				const inputs = createMockInputs({
					githubUserID: 12345,
					idempotencyKey: "my-key",
				});
				const action = new CoderAgentChatAction(
					coderClient,
					octokit as unknown as Octokit,
					inputs,
					createMockContext(),
				);

				const result = await action.run();

				expect(coderClient.mockCreateChat).not.toHaveBeenCalled();
				expect(coderClient.mockCreateChatMessage).toHaveBeenCalledTimes(1);
				const [chatId, params] =
					coderClient.mockCreateChatMessage.mock.calls[0] ?? [];
				expect(chatId).toBe(mockChat.id);
				expect(params).toEqual({
					content: [{ type: "text", text: "Test prompt" }],
					model_config_id: undefined,
				});

				const parsedResult = ActionOutputsSchema.parse(result);
				expect(parsedResult.chatCreated).toBe(false);
				expect(parsedResult.chatId).toBe(mockChat.id);
				// Reuse path uses S8's success-comment body shape with the
				// "message sent" heading (not "created").
				expect(octokit.rest.issues.createComment).toHaveBeenCalledTimes(1);
				const commentCall = octokit.rest.issues.createComment.mock
					.calls[0]?.[0] as { body: string } | undefined;
				expect(commentCall?.body).toMatch(
					/^\*\*Coder Agent Chat: message sent\*\*/,
				);
			},
		);

		test(
			"set, single match, getChat refresh fails: action resolves with " +
				"pre-message snapshot rather than failing",
			async () => {
				// Outputs degrade to the pre-message chat when the refresh
				// throws; the message itself already succeeded.
				const stale = {
					...mockChat,
					archived: false,
					status: "waiting" as const,
				};
				coderClient.mockGetCoderUserByGithubID.mockResolvedValue(mockUser);
				coderClient.mockListChats.mockResolvedValue([stale]);
				coderClient.mockCreateChatMessage.mockResolvedValue(
					mockChatMessageResponse,
				);
				coderClient.mockGetChat.mockRejectedValue(
					new Error("transient API error"),
				);

				const inputs = createMockInputs({
					githubUserID: 12345,
					idempotencyKey: "my-key",
				});
				const action = new CoderAgentChatAction(
					coderClient,
					octokit as unknown as Octokit,
					inputs,
					createMockContext(),
				);

				const result = await action.run();

				const parsedResult = ActionOutputsSchema.parse(result);
				expect(parsedResult.chatCreated).toBe(false);
				expect(parsedResult.chatId).toBe(stale.id);
				expect(parsedResult.chatStatus).toBe("waiting");
				expect(coderClient.mockGetChat).toHaveBeenCalledWith(stale.id);
			},
		);

		test(
			"set, multiple non-archived matches: picks the most recent by " +
				"updated_at and warns in the workflow log",
			async () => {
				const older = {
					...mockChat,
					id: ChatIdSchema.parse("aa0e8400-e29b-41d4-a716-446655440111"),
					archived: false,
					updated_at: "2026-04-01T00:00:00Z",
				};
				const newer = {
					...mockChat,
					id: ChatIdSchema.parse("bb0e8400-e29b-41d4-a716-446655440222"),
					archived: false,
					updated_at: "2026-04-29T00:00:00Z",
				};
				coderClient.mockGetCoderUserByGithubID.mockResolvedValue(mockUser);
				// Non-sorted order: proves the action sorts itself.
				coderClient.mockListChats.mockResolvedValue([older, newer]);
				coderClient.mockCreateChatMessage.mockResolvedValue(
					mockChatMessageResponse,
				);
				// Keep the warning count at one (the multi-match warning).
				coderClient.mockGetChat.mockResolvedValue(newer);

				const warnSpy = spyOn(core, "warning").mockImplementation(() => {});

				const inputs = createMockInputs({
					githubUserID: 12345,
					idempotencyKey: "my-key",
					// Avoid the unwired-input warning for `coder-organization`.
					coderOrganization: undefined,
				});
				const action = new CoderAgentChatAction(
					coderClient,
					octokit as unknown as Octokit,
					inputs,
					createMockContext(),
				);

				try {
					await action.run();

					expect(coderClient.mockCreateChat).not.toHaveBeenCalled();
					expect(coderClient.mockCreateChatMessage).toHaveBeenCalledTimes(1);
					const [chatId] =
						coderClient.mockCreateChatMessage.mock.calls[0] ?? [];
					expect(chatId).toBe(newer.id);

					expect(warnSpy).toHaveBeenCalledTimes(1);
					const warnArg = warnSpy.mock.calls[0]?.[0];
					expect(String(warnArg)).toContain("my-key");
					expect(String(warnArg)).toContain(newer.id);
					// The reused chat is not listed as ignored.
					const msg = String(warnArg);
					const ignoringClause = msg.slice(msg.indexOf("and ignoring:"));
					expect(ignoringClause).not.toContain(newer.id);
					expect(ignoringClause).toContain(older.id);
				} finally {
					warnSpy.mockRestore();
				}
			},
		);

		test("set, only match is archived: creates a new chat (does not unarchive)", async () => {
			coderClient.mockGetCoderUserByGithubID.mockResolvedValue(mockUser);
			coderClient.mockListChats.mockResolvedValue([
				{ ...mockChat, archived: true },
			]);
			coderClient.mockCreateChat.mockResolvedValue(mockChat);

			const inputs = createMockInputs({
				githubUserID: 12345,
				idempotencyKey: "my-key",
			});
			const action = new CoderAgentChatAction(
				coderClient,
				octokit as unknown as Octokit,
				inputs,
				createMockContext(),
			);

			await action.run();

			// Pin that the lookup ran; otherwise the archived filter is
			// not what made creation proceed.
			expect(coderClient.mockListChats).toHaveBeenCalledTimes(1);
			expect(coderClient.mockCreateChatMessage).not.toHaveBeenCalled();
			expect(coderClient.mockCreateChat).toHaveBeenCalledTimes(1);
			const createReq = coderClient.mockCreateChat.mock.calls[0]?.[0] as
				| { labels?: Record<string, string> }
				| undefined;
			expect(createReq?.labels).toEqual({
				"coder-agent-chat-action": "true",
				"gh-target": "test-org/test-repo#123",
				"coder-agent-chat-action-user": mockUser.id,
				"my-key": "true",
			});
		});

		test(
			"set, existing-chat-id provided: skips listChats lookup and uses " +
				"the existing-chat-id (existing-chat-id wins)",
			async () => {
				coderClient.mockGetCoderUserByGithubID.mockResolvedValue(mockUser);
				coderClient.mockCreateChatMessage.mockResolvedValue(
					mockChatMessageResponse,
				);
				coderClient.mockGetChat.mockResolvedValue(mockChat);

				const existingChatId = "990e8400-e29b-41d4-a716-446655440000";
				const inputs = createMockInputs({
					githubUserID: 12345,
					existingChatId,
					idempotencyKey: "my-key",
				});
				const action = new CoderAgentChatAction(
					coderClient,
					octokit as unknown as Octokit,
					inputs,
					createMockContext(),
				);

				const result = await action.run();

				expect(coderClient.mockListChats).not.toHaveBeenCalled();
				expect(coderClient.mockCreateChat).not.toHaveBeenCalled();
				expect(coderClient.mockCreateChatMessage).toHaveBeenCalledWith(
					existingChatId,
					expect.objectContaining({
						content: [{ type: "text", text: "Test prompt" }],
					}),
				);
				const parsedResult = ActionOutputsSchema.parse(result);
				expect(parsedResult.chatCreated).toBe(false);
				expect(parsedResult.chatId).toBe(mockChat.id);
				expect(parsedResult.chatStatus).toBe(mockChat.status);
				expect(parsedResult.chatTitle).toBe(mockChat.title);
			},
		);

		test(
			"set, listChats throws: error propagates with operation context " +
				"(no silent fall-through to creation)",
			async () => {
				// A failed lookup must propagate (no silent fall-through to
				// duplicate creation) and the message must name what failed.
				coderClient.mockGetCoderUserByGithubID.mockResolvedValue(mockUser);
				coderClient.mockListChats.mockRejectedValue(
					new CoderAPIError("Coder API error: Bad Request", 400, ""),
				);

				const inputs = createMockInputs({
					githubUserID: 12345,
					idempotencyKey: "my-key",
				});
				const action = new CoderAgentChatAction(
					coderClient,
					octokit as unknown as Octokit,
					inputs,
					createMockContext(),
				);

				await expect(action.run()).rejects.toThrow(
					/Failed to look up chats by idempotency labels/,
				);
				expect(coderClient.mockCreateChat).not.toHaveBeenCalled();
				expect(coderClient.mockCreateChatMessage).not.toHaveBeenCalled();
			},
		);

		test(
			"set to a value that sanitizes to a reserved label key: " +
				"action fails fast with a clear error and does not call the API",
			async () => {
				// `idempotency-key: "gh-target"` would silently overwrite
				// the reserved label. The check is hoisted before
				// findIdempotentMatch, so listChats never runs.
				coderClient.mockGetCoderUserByGithubID.mockResolvedValue(mockUser);

				const inputs = createMockInputs({
					githubUserID: 12345,
					idempotencyKey: "gh-target",
				});
				const action = new CoderAgentChatAction(
					coderClient,
					octokit as unknown as Octokit,
					inputs,
					createMockContext(),
				);

				await expect(action.run()).rejects.toThrow(/reserved/i);
				expect(coderClient.mockListChats).not.toHaveBeenCalled();
				expect(coderClient.mockCreateChat).not.toHaveBeenCalled();
				expect(coderClient.mockCreateChatMessage).not.toHaveBeenCalled();
			},
		);

		test(
			"set, distinct Coder users sharing the same idempotency-key on the " +
				"same gh-target each get their own chat (no cross-user hijack)",
			async () => {
				// User A's chat lookup matches their own chat; User B with a
				// different resolved user ID, the same key, and the same target
				// must not find User A's chat. We pin this by asserting the
				// lookup carries the per-user label so the API cannot AND-match
				// a chat created with the other user's UUID.
				const userB: CoderSDKUser = {
					...mockUser,
					id: "770e8400-e29b-41d4-a716-446655440777",
					username: "userB",
				};
				coderClient.mockGetCoderUserByGithubID.mockResolvedValue(userB);
				coderClient.mockListChats.mockResolvedValue([]);
				coderClient.mockCreateChat.mockResolvedValue(mockChat);

				const inputs = createMockInputs({
					githubUserID: 67890,
					idempotencyKey: "shared-key",
				});
				const action = new CoderAgentChatAction(
					coderClient,
					octokit as unknown as Octokit,
					inputs,
					createMockContext(),
				);

				await action.run();

				// The lookup must include the per-user scope so the chats API
				// cannot match a chat created with mockUser.id.
				expect(coderClient.mockListChats).toHaveBeenCalledTimes(1);
				const arg = coderClient.mockListChats.mock.calls[0]?.[0] as
					| { label?: string[] }
					| undefined;
				expect(arg?.label).toContain(
					`coder-agent-chat-action-user:${userB.id}`,
				);
				expect(arg?.label).not.toContain(
					`coder-agent-chat-action-user:${mockUser.id}`,
				);

				// Creation went through and stamped User B's UUID into the
				// chat's per-user label so a later lookup by User B finds it
				// and a later lookup by User A does not.
				expect(coderClient.mockCreateChat).toHaveBeenCalledTimes(1);
				const createReq = coderClient.mockCreateChat.mock.calls[0]?.[0] as
					| { labels?: Record<string, string> }
					| undefined;
				expect(createReq?.labels?.["coder-agent-chat-action-user"]).toBe(
					userB.id,
				);
			},
		);

		test(
			"set, coder-username resolution path: the same per-user scope is " +
				"applied as the github-user-id path",
			async () => {
				// All other idempotency tests resolve the user via
				// `getCoderUserByGithubID`. Without this test, dropping the
				// `getCoderUserByUsername` call (leaving `coderUserId`
				// uninitialized) would still pass the rest of the suite.
				coderClient.mockGetCoderUserByUsername.mockResolvedValue(mockUser);
				coderClient.mockListChats.mockResolvedValue([]);
				coderClient.mockCreateChat.mockResolvedValue(mockChat);

				const inputs = createMockInputs({
					githubUserID: undefined,
					coderUsername: mockUser.username,
					idempotencyKey: "my-key",
				});
				const action = new CoderAgentChatAction(
					coderClient,
					octokit as unknown as Octokit,
					inputs,
					createMockContext(),
				);

				await action.run();

				expect(coderClient.mockGetCoderUserByUsername).toHaveBeenCalledWith(
					mockUser.username,
				);
				expect(coderClient.mockGetCoderUserByGithubID).not.toHaveBeenCalled();

				expect(coderClient.mockListChats).toHaveBeenCalledTimes(1);
				const arg = coderClient.mockListChats.mock.calls[0]?.[0] as
					| { label?: string[] }
					| undefined;
				expect(arg?.label).toContain(
					`coder-agent-chat-action-user:${mockUser.id}`,
				);

				expect(coderClient.mockCreateChat).toHaveBeenCalledTimes(1);
				const createReq = coderClient.mockCreateChat.mock.calls[0]?.[0] as
					| { labels?: Record<string, string> }
					| undefined;
				expect(createReq?.labels?.["coder-agent-chat-action-user"]).toBe(
					mockUser.id,
				);
			},
		);
	});
});
