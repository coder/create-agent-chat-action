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
import { ChatIdSchema, type CoderChat } from "./coder-client";
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
				/Invalid `github-url` input/,
			);
		});

		test("rejects URL with extra path segments after the issue number", () => {
			const inputs = createMockInputs({
				githubURL: "https://github.com/owner/repo/issues/123/extra",
			});
			const action = new CoderAgentChatAction(
				coderClient,
				octokit as unknown as Octokit,
				inputs,
				createMockContext(),
			);

			expect(() => action.parseGithubURL()).toThrowError(
				/Invalid `github-url` input/,
			);
		});

		test("accepts a trailing slash after the issue number", () => {
			const inputs = createMockInputs({
				githubURL: "https://github.com/owner/repo/issues/123/",
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

		test("accepts a URL with a comment fragment", () => {
			const inputs = createMockInputs({
				githubURL: "https://github.com/owner/repo/issues/123#issuecomment-456",
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

		test("accepts a URL with a query string", () => {
			const inputs = createMockInputs({
				githubURL: "https://github.com/owner/repo/pull/42?ref=main",
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

		test("rejects non-github.com hostnames (F6)", () => {
			// F6 in the security review: the regex used to accept any host
			// because it was end-anchored only. Coercing the action to
			// comment on `https://attacker.example/coder/coder/issues/1`
			// would have called `octokit.rest.issues.createComment` with
			// owner=coder, repo=coder, number=1 under the workflow's
			// `github-token`. The action now refuses.
			const inputs = createMockInputs({
				githubURL: "https://code.acme.com/owner/repo/issues/123",
			});
			const action = new CoderAgentChatAction(
				coderClient,
				octokit as unknown as Octokit,
				inputs,
				createMockContext(),
			);

			expect(() => action.parseGithubURL()).toThrowError(
				/non-github.com hosts/,
			);
		});

		test("rejects an attacker-redirect via a non-github host that mimics the issue path", () => {
			const inputs = createMockInputs({
				githubURL: "https://attacker.example/coder/coder/issues/1",
			});
			const action = new CoderAgentChatAction(
				coderClient,
				octokit as unknown as Octokit,
				inputs,
				createMockContext(),
			);

			expect(() => action.parseGithubURL()).toThrowError(
				/Invalid `github-url` input/,
			);
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

			expect(result).toBe(`https://coder.test/agents/${mockChat.id}`);
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

			expect(result).toBe(`https://coder.test/agents/${mockChat.id}`);
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
			expect(call.body).toContain("**Coder Agents Chat: created**");
			expect(call.body).toContain("Chat: chat-url");
			expect(call.body).toContain(
				"<!-- coder-agents-chat-action:test-org/test-repo#123 -->",
			);
		});

		test("updates the existing marker comment in place", async () => {
			const marker = "<!-- coder-agents-chat-action:test-org/test-repo#123 -->";
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
		coderClient.mockGetAuthenticatedUser.mockResolvedValue(mockUser);
		coderClient.mockCreateChat.mockResolvedValue(mockChat);

		const inputs = createMockInputs({
			commentOnIssue: false,
		});
		const action = new CoderAgentChatAction(
			coderClient,
			octokit as unknown as Octokit,
			inputs,
			createMockContext(),
		);

		const result = await action.run();

		expect(coderClient.mockGetAuthenticatedUser).toHaveBeenCalled();
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
			/^https:\/\/coder\.test\/agents\/[a-f0-9-]+$/,
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

	test("creates a chat under the token owner returned by users/me", async () => {
		coderClient.mockGetAuthenticatedUser.mockResolvedValue(mockUser);
		coderClient.mockCreateChat.mockResolvedValue(mockChat);

		const inputs = createMockInputs({
			commentOnIssue: false,
		});
		const action = new CoderAgentChatAction(
			coderClient,
			octokit as unknown as Octokit,
			inputs,
			createMockContext(),
		);

		const result = await action.run();

		// users/me is the single source of identity now; assert it was
		// called and a chat was created under the resulting username.
		expect(coderClient.mockGetAuthenticatedUser).toHaveBeenCalled();
		expect(coderClient.mockCreateChat).toHaveBeenCalled();

		const parsedResult = ActionOutputsSchema.parse(result);
		expect(parsedResult.coderUsername).toBe(mockUser.username);
		expect(parsedResult.chatCreated).toBe(true);
	});

	test("sends message to existing chat", async () => {
		coderClient.mockGetAuthenticatedUser.mockResolvedValue(mockUser);
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

	test("rejects a malformed existing-chat-id at runtime (defense in depth past the schema)", async () => {
		coderClient.mockGetAuthenticatedUser.mockResolvedValue(mockUser);

		// `createMockInputs` casts to `ActionInputs` without running
		// `ActionInputsSchema`. That lets this test prove the
		// `ChatIdSchema.parse` in the existing-chat branch refuses non-UUID
		// input even if a future caller skips the upstream schema parse.
		const inputs = createMockInputs({
			existingChatId: "not-a-uuid",
		});
		const action = new CoderAgentChatAction(
			coderClient,
			octokit as unknown as Octokit,
			inputs,
			createMockContext(),
		);

		await expect(action.run()).rejects.toThrow();
		expect(coderClient.mockCreateChatMessage).not.toHaveBeenCalled();
	});

	test("falls back to minimal outputs when getChat fails after follow-up", async () => {
		coderClient.mockGetAuthenticatedUser.mockResolvedValue(mockUser);
		coderClient.mockCreateChatMessage.mockResolvedValue(
			mockChatMessageResponse,
		);
		coderClient.mockGetChat.mockRejectedValue(new Error("transient API error"));

		const existingChatId = "990e8400-e29b-41d4-a716-446655440000";
		const inputs = createMockInputs({
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
		coderClient.mockGetAuthenticatedUser.mockResolvedValue(mockUser);
		coderClient.mockCreateChat.mockResolvedValue(mockChat);

		const workspaceId = "550e8400-e29b-41d4-a716-446655440000";
		const inputs = createMockInputs({
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
			coderClient.mockGetAuthenticatedUser.mockResolvedValue(mockUser);
			coderClient.mockCreateChat.mockResolvedValue(mockChat);

			const inputs = createMockInputs({
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
			coderClient.mockGetAuthenticatedUser.mockResolvedValue(mockUser);
			coderClient.mockCreateChat.mockResolvedValue(mockChat);
			octokit.rest.issues.listComments.mockResolvedValue({
				data: [],
			} as ReturnType<typeof octokit.rest.issues.listComments>);
			octokit.rest.issues.createComment.mockResolvedValue(
				{} as ReturnType<typeof octokit.rest.issues.createComment>,
			);

			const inputs = createMockInputs({
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

	describe("Trust gate (top-level, always-on)", () => {
		test("refuses fork pull requests before any Coder API call", async () => {
			coderClient.mockGetAuthenticatedUser.mockResolvedValue(mockUser);
			coderClient.mockCreateChat.mockResolvedValue(mockChat);

			const inputs = createMockInputs({ commentOnIssue: false });
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

			let caught: unknown;
			try {
				await action.run();
			} catch (e) {
				caught = e;
			}
			expect(caught).toBeInstanceOf(Error);
			const message = (caught as Error).message;
			expect(message).toContain("untrusted trigger");
			expect(message).toContain("fork");
			expect(message).toContain("if:");
			// Nothing was called: the gate is fail-closed before any
			// API call, including users/me and createChat.
			expect(coderClient.mockGetAuthenticatedUser).not.toHaveBeenCalled();
			expect(coderClient.mockCreateChat).not.toHaveBeenCalled();
		});

		test("refuses NONE-association comment events", async () => {
			coderClient.mockGetAuthenticatedUser.mockResolvedValue(mockUser);
			coderClient.mockCreateChat.mockResolvedValue(mockChat);

			const inputs = createMockInputs({ commentOnIssue: false });
			const context = createMockContext({
				eventName: "issue_comment",
				actor: "drive-by",
				payload: {
					sender: { id: 99999 },
					comment: { author_association: "NONE" },
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
			expect((caught as Error).message).toContain("NONE");
			expect(coderClient.mockCreateChat).not.toHaveBeenCalled();
		});

		test("trusted MEMBER comment proceeds and createChat is reached", async () => {
			coderClient.mockGetAuthenticatedUser.mockResolvedValue(mockUser);
			coderClient.mockCreateChat.mockResolvedValue(mockChat);

			const inputs = createMockInputs({ commentOnIssue: false });
			const context = createMockContext({
				eventName: "issue_comment",
				actor: "member",
				payload: {
					sender: { id: 42 },
					comment: { author_association: "MEMBER" },
				},
			});
			const action = new CoderAgentChatAction(
				coderClient,
				octokit as unknown as Octokit,
				inputs,
				context,
			);

			await action.run();
			expect(coderClient.mockCreateChat).toHaveBeenCalledTimes(1);
		});

		test("no-signal events (issues, push, workflow_dispatch) proceed", async () => {
			coderClient.mockGetAuthenticatedUser.mockResolvedValue(mockUser);
			coderClient.mockCreateChat.mockResolvedValue(mockChat);

			const inputs = createMockInputs({ commentOnIssue: false });
			const context = createMockContext({
				eventName: "issues",
				actor: "anyone",
				payload: {},
			});
			const action = new CoderAgentChatAction(
				coderClient,
				octokit as unknown as Octokit,
				inputs,
				context,
			);

			await action.run();
			expect(coderClient.mockCreateChat).toHaveBeenCalledTimes(1);
		});

		test("the gate has no input bypass; idempotency-key cannot bypass it", async () => {
			// Pre-rewrite, an explicit acting-coder-username or
			// acting-github-user-id input bypassed the gate. Those inputs
			// were dropped; no current input bypasses the gate. Setting
			// every remaining input still refuses an untrusted trigger.
			coderClient.mockGetAuthenticatedUser.mockResolvedValue(mockUser);
			coderClient.mockCreateChat.mockResolvedValue(mockChat);

			const inputs = createMockInputs({
				commentOnIssue: false,
				idempotencyKey: "anything",
				coderOrganization: "anything",
				workspaceId: "11111111-1111-1111-1111-111111111111",
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

			await expect(action.run()).rejects.toThrow(/untrusted trigger/);
			expect(coderClient.mockCreateChat).not.toHaveBeenCalled();
		});
	});

	describe("wait=complete polling", () => {
		test("wait=none honors the wait gate: no getChat, no clock sleep", async () => {
			coderClient.mockGetAuthenticatedUser.mockResolvedValue(mockUser);
			coderClient.mockCreateChat.mockResolvedValue(mockChat);

			const inputs = createMockInputs({
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
			// getChat and no clock sleep. listChats fires once (the chat
			// reuse lookup) and is not the polling shape.
			expect(coderClient.mockGetChat).not.toHaveBeenCalled();
			expect(coderClient.mockListChats).toHaveBeenCalledTimes(1);
			expect(clock.sleeps).toEqual([]);
		});

		test("wait=complete polls getChat every 5 seconds until terminal", async () => {
			coderClient.mockGetAuthenticatedUser.mockResolvedValue(mockUser);
			coderClient.mockCreateChat.mockResolvedValue({
				...mockChat,
				status: "running",
			});
			coderClient.mockGetChat
				.mockResolvedValueOnce({ ...mockChat, status: "running" })
				.mockResolvedValueOnce({ ...mockChat, status: "running" })
				.mockResolvedValueOnce({ ...mockChat, status: "completed" });

			const inputs = createMockInputs({
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

			// 3 polls + 2 sleeps mirrors doc-check.yaml's cadence. The
			// single listChats call is the reuse lookup, not the polling
			// shape.
			expect(coderClient.mockGetChat).toHaveBeenCalledTimes(3);
			expect(coderClient.mockListChats).toHaveBeenCalledTimes(1);
			expect(clock.sleeps).toEqual([POLL_INTERVAL_MS, POLL_INTERVAL_MS]);
		});

		test("wait=complete + commentOnIssue posts the comment after the chat reaches terminal", async () => {
			// Polling must complete before the comment goes out, otherwise a
			// failure mid-poll would leave a stale "Agents Chat:" comment on
			// the issue while the workflow step itself fails.
			coderClient.mockGetAuthenticatedUser.mockResolvedValue(mockUser);
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
			coderClient.mockGetAuthenticatedUser.mockResolvedValue(mockUser);
			coderClient.mockCreateChat.mockResolvedValue({
				...mockChat,
				status: "running",
			});
			coderClient.mockGetChat.mockResolvedValue({
				...mockChat,
				status: "running",
			});

			const inputs = createMockInputs({
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
			coderClient.mockGetAuthenticatedUser.mockResolvedValue(mockUser);
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
			coderClient.mockGetAuthenticatedUser.mockResolvedValue(mockUser);
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
			coderClient.mockGetAuthenticatedUser.mockResolvedValue(mockUser);
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
			coderClient.mockGetAuthenticatedUser.mockResolvedValue(mockUser);
			coderClient.mockCreateChat.mockResolvedValue({
				...mockChat,
				status: "running",
			});
			coderClient.mockGetChat.mockRejectedValue(
				new Error("connection reset by peer"),
			);

			const inputs = createMockInputs({
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
			expect(err.chatUrl).toContain("/agents/");
			expect(err.coderUsername).toBe(mockUser.username);
		});

		test("wait=complete returns successfully when chat reaches waiting", async () => {
			// `waiting` is terminal but ambiguous (agent done vs agent
			// waiting for input); pin the success path explicitly so a
			// regression that drops it from TERMINAL_STATUSES fails here.
			coderClient.mockGetAuthenticatedUser.mockResolvedValue(mockUser);
			coderClient.mockCreateChat.mockResolvedValue({
				...mockChat,
				status: "running",
			});
			coderClient.mockGetChat.mockResolvedValueOnce({
				...mockChat,
				status: "waiting",
			});

			const inputs = createMockInputs({
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
			coderClient.mockGetAuthenticatedUser.mockResolvedValue(mockUser);
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
			coderClient.mockGetAuthenticatedUser.mockResolvedValue(mockUser);
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
			coderClient.mockGetAuthenticatedUser.mockResolvedValue(mockUser);
			coderClient.mockCreateChat.mockResolvedValue({
				...mockChat,
				status: "running",
			});
			coderClient.mockGetChat.mockResolvedValueOnce({
				...mockChat,
				status: "completed",
			});

			const inputs = createMockInputs({
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
			coderClient.mockGetAuthenticatedUser.mockResolvedValue(mockUser);
			coderClient.mockCreateChat.mockResolvedValue({
				...mockChat,
				status: "running",
			});
			coderClient.mockGetChat
				.mockRejectedValueOnce(new Error("503 Service Unavailable"))
				.mockRejectedValueOnce(new Error("503 Service Unavailable"))
				.mockResolvedValueOnce({ ...mockChat, status: "completed" });

			const inputs = createMockInputs({
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
			coderClient.mockGetAuthenticatedUser.mockResolvedValue(mockUser);
			coderClient.mockCreateChatMessage.mockResolvedValue(
				mockChatMessageResponse,
			);
			coderClient.mockGetChat.mockRejectedValue(
				new Error("connection reset by peer"),
			);

			const existingChatId = "990e8400-e29b-41d4-a716-446655440000";
			const inputs = createMockInputs({
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
			expect(err.chatUrl).toContain("/agents/");
			expect(err.coderUsername).toBe(mockUser.username);
		});

		test("wait=complete + requireNonTerminalFirst times out with a stale-terminal message", async () => {
			// Every poll returns the same terminal status the chat was
			// already in. The loop hits the timeout without ever
			// observing a non-terminal observation; the failure message
			// distinguishes this from a normal "ran out of time" timeout.
			coderClient.mockGetAuthenticatedUser.mockResolvedValue(mockUser);
			coderClient.mockCreateChatMessage.mockResolvedValue(
				mockChatMessageResponse,
			);
			coderClient.mockGetChat.mockResolvedValue({
				...mockChat,
				status: "waiting",
			});

			const existingChatId = "990e8400-e29b-41d4-a716-446655440000";
			const inputs = createMockInputs({
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
			coderClient.mockGetAuthenticatedUser.mockResolvedValue(mockUser);
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
			coderClient.mockGetAuthenticatedUser.mockResolvedValue(mockUser);
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
			coderClient.mockGetAuthenticatedUser.mockResolvedValue(mockUser);
			coderClient.mockCreateChatMessage.mockResolvedValue(
				mockChatMessageResponse,
			);
			coderClient.mockGetChat.mockRejectedValue(new Error("503"));

			const existingChatId = "990e8400-e29b-41d4-a716-446655440000";
			const inputs = createMockInputs({
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
		test("throws error when chat creation fails", async () => {
			coderClient.mockGetAuthenticatedUser.mockResolvedValue(mockUser);
			coderClient.mockCreateChat.mockRejectedValue(
				new Error("Failed to create chat"),
			);
			octokit.rest.issues.listComments.mockResolvedValue({
				data: [],
			} as ReturnType<typeof octokit.rest.issues.listComments>);
			octokit.rest.issues.createComment.mockResolvedValue(
				{} as ReturnType<typeof octokit.rest.issues.createComment>,
			);

			const inputs = createMockInputs({});
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
				coderClient.mockGetAuthenticatedUser.mockResolvedValue(mockUser);
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

				const inputs = createMockInputs({});
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
				expect(call?.body).toContain("https://coder.test/agents");
				expect(call?.body).toContain(
					"<!-- coder-agents-chat-action:test-org/test-repo#123 -->",
				);
			},
		);

		test("falls back to chat-error-kind=api_error for unknown 4xx shapes", async () => {
			coderClient.mockGetAuthenticatedUser.mockResolvedValue(mockUser);
			coderClient.mockCreateChat.mockRejectedValue(
				new CoderAPIError("Coder API error: Bad Request", 400, ""),
			);
			octokit.rest.issues.listComments.mockResolvedValue({
				data: [],
			} as ReturnType<typeof octokit.rest.issues.listComments>);
			octokit.rest.issues.createComment.mockResolvedValue(
				{} as ReturnType<typeof octokit.rest.issues.createComment>,
			);

			const inputs = createMockInputs({});
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
				"<!-- coder-agents-chat-action:test-org/test-repo#123 -->",
			);
		});

		test("posts no failure comment when commentOnIssue=false", async () => {
			coderClient.mockGetAuthenticatedUser.mockResolvedValue(mockUser);
			coderClient.mockCreateChat.mockRejectedValue(
				new CoderAPIError("Coder API error: Bad Request", 400, ""),
			);

			const inputs = createMockInputs({
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
				coderClient.mockGetAuthenticatedUser.mockResolvedValue(mockUser);
				coderClient.mockCreateChat.mockRejectedValue(
					new CoderAPIError("Coder API error: Bad Request", 400, ""),
				);
				const marker =
					"<!-- coder-agents-chat-action:test-org/test-repo#123 -->";
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

				const inputs = createMockInputs({});
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
					coderClient.mockGetAuthenticatedUser.mockResolvedValue(mockUser);
					coderClient.mockCreateChat.mockRejectedValue(
						new CoderAPIError("Coder API error: Bad Request", 400, ""),
					);
					octokit.rest.issues.listComments.mockResolvedValue({
						data: [],
					} as ReturnType<typeof octokit.rest.issues.listComments>);
					octokit.rest.issues.createComment.mockResolvedValue(
						{} as ReturnType<typeof octokit.rest.issues.createComment>,
					);

					const inputs = createMockInputs({});
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
						"<!-- coder-agents-chat-action:test-org/test-repo#123:doc-check -->",
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
				coderClient.mockGetAuthenticatedUser.mockResolvedValue(mockUser);
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
					"<!-- coder-agents-chat-action:test-org/test-repo#77 -->",
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
				coderClient.mockGetAuthenticatedUser.mockResolvedValue(mockUser);
				coderClient.mockCreateChat.mockRejectedValue(
					new CoderAPIError("Coder API error: Bad Request", 400, ""),
				);
				octokit.rest.issues.listComments.mockResolvedValue({
					data: [],
				} as ReturnType<typeof octokit.rest.issues.listComments>);
				octokit.rest.issues.createComment.mockResolvedValue(
					{} as ReturnType<typeof octokit.rest.issues.createComment>,
				);

				const inputs = createMockInputs({});
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
				coderClient.mockGetAuthenticatedUser.mockResolvedValue(mockUser);
				coderClient.mockCreateChat.mockRejectedValue(
					new CoderAPIError("Coder API error: Bad Request", 400, ""),
				);
				// paginate (which findCommentByPredicate uses) rejects.
				octokit.paginate.mockRejectedValue(new Error("boom"));

				const inputs = createMockInputs({});
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

		// `parseGithubURL` runs first in `runInner` so a malformed
		// `github-url` fails fast with a URL-parser error instead of
		// masking some later API error. The schema only validates URL
		// syntax, so a URL like `https://github.com/foo` passes the schema
		// but the regex does not match.
		test("fails fast when github-url passes schema but fails the issue/PR regex", async () => {
			coderClient.mockGetAuthenticatedUser.mockResolvedValue(mockUser);

			const inputs = createMockInputs({
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
			// runInner parses github-url before reaching users/me;
			// `getAuthenticatedUser` is never called.
			expect(coderClient.mockGetAuthenticatedUser).not.toHaveBeenCalled();
			expect(caught).toBeInstanceOf(ActionFailureError);
			expect((caught as ActionFailureError).kind).toBe("api_error");
			expect((caught as ActionFailureError).message).toContain(
				"Invalid `github-url`",
			);
			// No comment posted because the parser rejected the URL.
			expect(octokit.rest.issues.createComment).not.toHaveBeenCalled();
		});
	});

	describe("Organization resolution", () => {
		test("resolves org by name to a UUID when coder-organization is set", async () => {
			coderClient.mockGetAuthenticatedUser.mockResolvedValue(mockUser);
			coderClient.mockCreateChat.mockResolvedValue(mockChat);

			const inputs = createMockInputs({
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
			coderClient.mockGetAuthenticatedUser.mockResolvedValue(mockUser);
			coderClient.mockCreateChat.mockResolvedValue(mockChat);

			const inputs = createMockInputs({
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

		test("resolves the token owner via getAuthenticatedUser when coder-organization is unset", async () => {
			coderClient.mockGetAuthenticatedUser.mockResolvedValue(mockUser);
			coderClient.mockCreateChat.mockResolvedValue(mockChat);

			const inputs = createMockInputs({
				coderOrganization: undefined,
			});
			const action = new CoderAgentChatAction(
				coderClient,
				octokit as unknown as Octokit,
				inputs,
				createMockContext(),
			);

			await action.run();

			expect(coderClient.mockGetAuthenticatedUser).toHaveBeenCalled();
			expect(coderClient.mockGetOrganizationByName).not.toHaveBeenCalled();
			expect(coderClient.mockCreateChat).toHaveBeenCalledWith(
				expect.objectContaining({
					organization_id: mockUser.organization_ids[0],
				}),
			);
		});

		test("fails with chat-error-kind=org_not_found when the resolved user has no org memberships", async () => {
			coderClient.mockGetAuthenticatedUser.mockResolvedValue(mockUserNoOrgs);

			const inputs = createMockInputs({
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
			coderClient.mockGetAuthenticatedUser.mockResolvedValue(mockUser);
			coderClient.mockGetOrganizationByName.mockRejectedValue(
				new CoderAPIError("Coder API error: Not Found", 404),
			);

			const inputs = createMockInputs({
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
			coderClient.mockGetAuthenticatedUser.mockResolvedValue(mockUser);
			coderClient.mockGetOrganizationByName.mockRejectedValue(
				new CoderAPIError("Coder API error: Unauthorized", 401),
			);

			const inputs = createMockInputs({
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
			coderClient.mockGetAuthenticatedUser.mockResolvedValue(mockUserNoOrgs);
			coderClient.mockCreateChatMessage.mockResolvedValue(
				mockChatMessageResponse,
			);

			// User has zero org memberships and no `coder-organization` is set,
			// which would fail the create-chat path. The follow-up path must
			// not trigger that resolution because createChatMessage inherits
			// the chat's organization.
			const inputs = createMockInputs({
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
			// users/me is still called once (the action emits the username
			// output regardless of the existing-chat-id path), but the
			// organization-resolution branch is correctly skipped.
			expect(coderClient.mockGetAuthenticatedUser).toHaveBeenCalledTimes(1);
			expect(coderClient.mockCreateChatMessage).toHaveBeenCalled();
			expect(coderClient.mockCreateChat).not.toHaveBeenCalled();
			expect(result.chatCreated).toBe(false);
		});

		test("surfaces users/me 404 as api_error", async () => {
			coderClient.mockGetAuthenticatedUser.mockRejectedValue(
				new CoderAPIError("Coder API error: Not Found", 404),
			);

			const inputs = createMockInputs({
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

			// users/me failures classify as api_error: a 404 here means the
			// `coder-token` does not authenticate, not that some named user
			// is missing. The original CoderAPIError is preserved on cause.
			expect(caught).toBeInstanceOf(ActionFailureError);
			expect((caught as ActionFailureError).kind).toBe("api_error");
			expect((caught as ActionFailureError).cause).toBeInstanceOf(
				CoderAPIError,
			);
			expect(coderClient.mockCreateChat).not.toHaveBeenCalled();
		});

		test("users/me 401 (non-404) classifies as api_error", async () => {
			coderClient.mockGetAuthenticatedUser.mockRejectedValue(
				new CoderAPIError("Coder API error: Unauthorized", 401),
			);

			const inputs = createMockInputs({
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
			expect((caught as ActionFailureError).kind).toBe("api_error");
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
			coderClient.mockGetAuthenticatedUser.mockResolvedValue(multiOrgUser);
			coderClient.mockCreateChat.mockResolvedValue(mockChat);
			const warningSpy = spyOn(core, "warning").mockImplementation(() => {});

			try {
				const inputs = createMockInputs({
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
			coderClient.mockGetAuthenticatedUser.mockResolvedValue(mockUser);
			coderClient.mockCreateChat.mockResolvedValue(mockChat);
			const warningSpy = spyOn(core, "warning").mockImplementation(() => {});

			try {
				const inputs = createMockInputs({
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
			coderClient.mockGetAuthenticatedUser.mockResolvedValue(mockUser);
			const originalError = new CoderAPIError(
				"Coder API error: Not Found",
				404,
			);
			coderClient.mockGetOrganizationByName.mockRejectedValue(originalError);

			const inputs = createMockInputs({
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

	describe("Chat reuse", () => {
		test("default: listChats is called with the gh-target scope before creating", async () => {
			coderClient.mockGetAuthenticatedUser.mockResolvedValue(mockUser);
			coderClient.mockListChats.mockResolvedValue([]);
			coderClient.mockCreateChat.mockResolvedValue(mockChat);

			const inputs = createMockInputs({});
			const action = new CoderAgentChatAction(
				coderClient,
				octokit as unknown as Octokit,
				inputs,
				createMockContext(),
			);

			await action.run();

			expect(coderClient.mockListChats).toHaveBeenCalledTimes(1);
			const arg = coderClient.mockListChats.mock.calls[0]?.[0] as
				| { label?: string[]; archived?: boolean }
				| undefined;
			// The per-user label is intentionally absent: all chats this
			// action creates are owned by the `coder-token` holder, so
			// scoping by the resolved acting user added no isolation.
			expect(arg?.label).toEqual([
				"coder-agents-chat-action:true",
				"gh-target:test-org/test-repo#123",
			]);
			expect(arg?.archived).toBe(false);
			expect(coderClient.mockCreateChat).toHaveBeenCalledTimes(1);
		});

		test("default: GITHUB_WORKFLOW is included in the lookup and on the created chat", async () => {
			process.env.GITHUB_WORKFLOW = "doc-check";
			try {
				coderClient.mockGetAuthenticatedUser.mockResolvedValue(mockUser);
				coderClient.mockListChats.mockResolvedValue([]);
				coderClient.mockCreateChat.mockResolvedValue(mockChat);

				const inputs = createMockInputs({});
				const action = new CoderAgentChatAction(
					coderClient,
					octokit as unknown as Octokit,
					inputs,
					createMockContext(),
				);

				await action.run();

				const listArg = coderClient.mockListChats.mock.calls[0]?.[0] as
					| { label?: string[] }
					| undefined;
				expect(listArg?.label).toContain(
					"coder-agents-chat-action-workflow:doc-check",
				);
				const createReq = coderClient.mockCreateChat.mock.calls[0]?.[0] as
					| { labels?: Record<string, string> }
					| undefined;
				expect(createReq?.labels?.["coder-agents-chat-action-workflow"]).toBe(
					"doc-check",
				);
			} finally {
				delete process.env.GITHUB_WORKFLOW;
			}
		});

		test("default: writes the two core labels on the new chat", async () => {
			coderClient.mockGetAuthenticatedUser.mockResolvedValue(mockUser);
			coderClient.mockListChats.mockResolvedValue([]);
			coderClient.mockCreateChat.mockResolvedValue(mockChat);

			const inputs = createMockInputs({});
			const action = new CoderAgentChatAction(
				coderClient,
				octokit as unknown as Octokit,
				inputs,
				createMockContext(),
			);

			await action.run();

			const req = coderClient.mockCreateChat.mock.calls[0]?.[0] as
				| { labels?: Record<string, string> }
				| undefined;
			expect(req?.labels?.["coder-agents-chat-action"]).toBe("true");
			expect(req?.labels?.["gh-target"]).toBe("test-org/test-repo#123");
			// No per-user label: the chat owner is the token holder, not
			// the resolved acting user.
			expect(req?.labels?.["coder-agents-chat-action-user"]).toBeUndefined();
			// Workflow env unset; no workflow label and no sharding key.
			expect(Object.keys(req?.labels ?? {}).sort()).toEqual([
				"coder-agents-chat-action",
				"gh-target",
			]);
		});

		test("default + match: sends a follow-up via createChatMessage and does not create", async () => {
			coderClient.mockGetAuthenticatedUser.mockResolvedValue(mockUser);
			coderClient.mockListChats.mockResolvedValue([
				{ ...mockChat, archived: false },
			]);
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

			const modelConfigId = "d3a2b1c4-5678-49ab-bcde-1234567890ab";
			const inputs = createMockInputs({
				chatPrompt: "continue the work",
				modelConfigId,
			});
			const action = new CoderAgentChatAction(
				coderClient,
				octokit as unknown as Octokit,
				inputs,
				createMockContext(),
			);

			const outputs = await action.run();

			// Pin the wire shape: the reused chat receives the prompt and
			// model-config-id, not just any call. A regression that dropped
			// content or model_config_id would have passed the previous
			// "called once" assertion.
			expect(coderClient.mockCreateChatMessage).toHaveBeenCalledTimes(1);
			expect(coderClient.mockCreateChatMessage).toHaveBeenCalledWith(
				mockChat.id,
				expect.objectContaining({
					content: [{ type: "text", text: "continue the work" }],
					model_config_id: modelConfigId,
				}),
			);
			expect(coderClient.mockCreateChat).not.toHaveBeenCalled();
			expect(outputs.chatCreated).toBe(false);

			// The comment heading distinguishes "message sent" (follow-up)
			// from "created" (new chat) and from the wait=complete variants.
			expect(octokit.rest.issues.createComment).toHaveBeenCalledTimes(1);
			const commentCall = octokit.rest.issues.createComment.mock
				.calls[0]?.[0] as { body: string } | undefined;
			expect(commentCall?.body).toContain(
				"**Coder Agents Chat: message sent**",
			);
		});

		test("default + match + wait=complete: polls until terminal status (no silent skip)", async () => {
			// Regression test for DEREM-2: the reuse follow-up path must
			// honor wait=complete the same way the existing-chat-id path
			// does. A reuse-path follow-up to a chat already in a terminal
			// status would otherwise return on the pre-message snapshot
			// before the agent transitions.
			coderClient.mockGetAuthenticatedUser.mockResolvedValue(mockUser);
			coderClient.mockListChats.mockResolvedValue([
				{ ...mockChat, archived: false, status: "waiting" },
			]);
			coderClient.mockCreateChatMessage.mockResolvedValue(
				mockChatMessageResponse,
			);
			// The pre-message status is "waiting" (terminal), so
			// requireNonTerminalFirst must skip the first poll. Then two
			// transitions: running -> completed.
			coderClient.mockGetChat
				.mockResolvedValueOnce({ ...mockChat, status: "waiting" })
				.mockResolvedValueOnce({ ...mockChat, status: "running" })
				.mockResolvedValueOnce({ ...mockChat, status: "completed" });

			const inputs = createMockInputs({
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

			const outputs = await action.run();

			expect(coderClient.mockCreateChatMessage).toHaveBeenCalledTimes(1);
			expect(coderClient.mockCreateChat).not.toHaveBeenCalled();
			expect(coderClient.mockGetChat).toHaveBeenCalledTimes(3);
			expect(outputs.chatStatus).toBe("completed");
		});

		test("default + getChat refresh fails: returns the pre-message snapshot instead of failing", async () => {
			// Use a distinguishable pre-message status so the assertion can
			// distinguish "snapshot preserved" from "refresh skipped entirely."
			// mockChat defaults to "running"; the snapshot here is "waiting".
			const snapshot = {
				...mockChat,
				archived: false,
				status: "waiting" as const,
			};
			coderClient.mockGetAuthenticatedUser.mockResolvedValue(mockUser);
			coderClient.mockListChats.mockResolvedValue([snapshot]);
			coderClient.mockCreateChatMessage.mockResolvedValue(
				mockChatMessageResponse,
			);
			coderClient.mockGetChat.mockRejectedValue(new Error("network"));

			const inputs = createMockInputs({});
			const action = new CoderAgentChatAction(
				coderClient,
				octokit as unknown as Octokit,
				inputs,
				createMockContext(),
			);

			const outputs = await action.run();

			expect(coderClient.mockGetChat).toHaveBeenCalledWith(mockChat.id);
			expect(outputs.chatId).toBe(mockChat.id);
			expect(outputs.chatStatus).toBe("waiting");
			expect(outputs.chatCreated).toBe(false);
		});

		test("default + multiple non-archived matches: picks the most recent by updated_at and warns", async () => {
			const older: CoderChat = {
				...mockChat,
				id: ChatIdSchema.parse("00000000-0000-0000-0000-000000000001"),
				updated_at: "2026-01-01T00:00:00.000000Z",
				archived: false,
			};
			const newer: CoderChat = {
				...mockChat,
				id: ChatIdSchema.parse("00000000-0000-0000-0000-000000000002"),
				updated_at: "2026-02-01T00:00:00.000000Z",
				archived: false,
			};
			coderClient.mockGetAuthenticatedUser.mockResolvedValue(mockUser);
			coderClient.mockListChats.mockResolvedValue([older, newer]);
			coderClient.mockCreateChatMessage.mockResolvedValue(
				mockChatMessageResponse,
			);
			coderClient.mockGetChat.mockResolvedValue(newer);
			const warnSpy = spyOn(core, "warning");

			const inputs = createMockInputs({});
			const action = new CoderAgentChatAction(
				coderClient,
				octokit as unknown as Octokit,
				inputs,
				createMockContext(),
			);

			await action.run();

			expect(coderClient.mockCreateChatMessage).toHaveBeenCalledWith(
				newer.id,
				expect.anything(),
			);
			expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining(older.id));
			warnSpy.mockRestore();
		});

		test("default + only archived match: creates a new chat (does not unarchive)", async () => {
			coderClient.mockGetAuthenticatedUser.mockResolvedValue(mockUser);
			coderClient.mockListChats.mockResolvedValue([
				{ ...mockChat, archived: true },
			]);
			coderClient.mockCreateChat.mockResolvedValue(mockChat);

			const inputs = createMockInputs({});
			const action = new CoderAgentChatAction(
				coderClient,
				octokit as unknown as Octokit,
				inputs,
				createMockContext(),
			);

			await action.run();

			expect(coderClient.mockCreateChat).toHaveBeenCalledTimes(1);
			expect(coderClient.mockCreateChatMessage).not.toHaveBeenCalled();
		});

		test("existing-chat-id wins: lookup is skipped", async () => {
			coderClient.mockGetAuthenticatedUser.mockResolvedValue(mockUser);
			coderClient.mockCreateChatMessage.mockResolvedValue(
				mockChatMessageResponse,
			);
			coderClient.mockGetChat.mockResolvedValue(mockChat);

			const inputs = createMockInputs({
				existingChatId: mockChat.id,
			});
			const action = new CoderAgentChatAction(
				coderClient,
				octokit as unknown as Octokit,
				inputs,
				createMockContext(),
			);

			await action.run();

			expect(coderClient.mockListChats).not.toHaveBeenCalled();
			expect(coderClient.mockCreateChatMessage).toHaveBeenCalledTimes(1);
			expect(coderClient.mockCreateChat).not.toHaveBeenCalled();
		});

		test("force-new-chat: skips lookup and creates a new chat with the action labels", async () => {
			coderClient.mockGetAuthenticatedUser.mockResolvedValue(mockUser);
			coderClient.mockCreateChat.mockResolvedValue(mockChat);

			const inputs = createMockInputs({
				forceNewChat: true,
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
			// Labels are written on every action-created chat regardless of
			// path. A regression that conditionally omitted labels on the
			// force-new-chat path would make those chats invisible to future
			// reuse lookups and not be caught without these assertions.
			const req = coderClient.mockCreateChat.mock.calls[0]?.[0] as
				| { labels?: Record<string, string> }
				| undefined;
			expect(req?.labels?.["coder-agents-chat-action"]).toBe("true");
			expect(req?.labels?.["gh-target"]).toBe("test-org/test-repo#123");
		});

		test("listChats throws: error propagates with operation context", async () => {
			coderClient.mockGetAuthenticatedUser.mockResolvedValue(mockUser);
			coderClient.mockListChats.mockRejectedValue(new Error("boom"));

			const inputs = createMockInputs({});
			const action = new CoderAgentChatAction(
				coderClient,
				octokit as unknown as Octokit,
				inputs,
				createMockContext(),
			);

			await expect(action.run()).rejects.toThrow(
				/Failed to look up chats by reuse labels/,
			);
		});

		test("the reuse scope is intentionally not partitioned by acting user", async () => {
			// Per the security-driven simplification, all chats this action
			// creates are owned by the `coder-token` holder. The reuse scope
			// does not include a per-actor label; workflows that want
			// per-actor separation set `idempotency-key: ${{ github.actor }}`
			// themselves. This test pins the absence of the per-user label so
			// a regression that re-introduces it is caught.
			coderClient.mockGetAuthenticatedUser.mockResolvedValue(mockUser);
			coderClient.mockListChats.mockResolvedValue([]);
			coderClient.mockCreateChat.mockResolvedValue(mockChat);

			const inputs = createMockInputs({});
			const action = new CoderAgentChatAction(
				coderClient,
				octokit as unknown as Octokit,
				inputs,
				createMockContext(),
			);

			await action.run();

			const listArg = coderClient.mockListChats.mock.calls[0]?.[0] as
				| { label?: string[] }
				| undefined;
			for (const label of listArg?.label ?? []) {
				expect(label).not.toMatch(/^coder-agents-chat-action-user:/);
			}
			const createReq = coderClient.mockCreateChat.mock.calls[0]?.[0] as
				| { labels?: Record<string, string> }
				| undefined;
			expect(
				createReq?.labels?.["coder-agents-chat-action-user"],
			).toBeUndefined();
		});

		describe("idempotency-key sharding", () => {
			test("adds the sanitized key as the value of the fixed idempotency label", async () => {
				coderClient.mockGetAuthenticatedUser.mockResolvedValue(mockUser);
				coderClient.mockListChats.mockResolvedValue([]);
				coderClient.mockCreateChat.mockResolvedValue(mockChat);

				const inputs = createMockInputs({
					idempotencyKey: "My Custom Key!",
				});
				const action = new CoderAgentChatAction(
					coderClient,
					octokit as unknown as Octokit,
					inputs,
					createMockContext(),
				);

				await action.run();

				const listArg = coderClient.mockListChats.mock.calls[0]?.[0] as
					| { label?: string[] }
					| undefined;
				// The sanitized key is the value of a fixed key. User input
				// cannot collide with an action-owned key under this scheme.
				expect(listArg?.label).toContain(
					"coder-agents-chat-action-idempotency:my-custom-key-",
				);
				const createReq = coderClient.mockCreateChat.mock.calls[0]?.[0] as
					| { labels?: Record<string, string> }
					| undefined;
				expect(
					createReq?.labels?.["coder-agents-chat-action-idempotency"],
				).toBe("my-custom-key-");
			});

			test("reserved-key collision is no longer possible with the fixed-key scheme", async () => {
				// Pre-rewrite, a sanitized `idempotency-key` value was used as a
				// label KEY and could collide with action-owned keys. The fixed
				// key (`coder-agents-chat-action-idempotency`) makes the value
				// always a value, so even an idempotency-key of `gh-target` now
				// just sets `coder-agents-chat-action-idempotency: gh-target`.
				coderClient.mockGetAuthenticatedUser.mockResolvedValue(mockUser);
				coderClient.mockListChats.mockResolvedValue([]);
				coderClient.mockCreateChat.mockResolvedValue(mockChat);

				const inputs = createMockInputs({
					idempotencyKey: "gh-target",
				});
				const action = new CoderAgentChatAction(
					coderClient,
					octokit as unknown as Octokit,
					inputs,
					createMockContext(),
				);

				await action.run();

				const createReq = coderClient.mockCreateChat.mock.calls[0]?.[0] as
					| { labels?: Record<string, string> }
					| undefined;
				expect(createReq?.labels?.["gh-target"]).toBe("test-org/test-repo#123");
				expect(
					createReq?.labels?.["coder-agents-chat-action-idempotency"],
				).toBe("gh-target");
			});
		});
	});
});
