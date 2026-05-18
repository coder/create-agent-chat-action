import { describe, expect, test } from "bun:test";
import { CoderChatSchema } from "./coder-client";
import {
	type ActionInputs,
	ActionInputsSchema,
	ActionOutputsSchema,
	DEFAULT_WAIT_TIMEOUT_SECONDS,
} from "./schemas";
import { mockChat, mockChatWithDiff } from "./test-helpers";

const actionInputValid: ActionInputs = {
	coderURL: "https://coder.test",
	coderToken: "test-token",
	coderOrganization: "my-org",
	chatPrompt: "test prompt",
	githubURL: "https://github.com/owner/repo/issues/123",
	githubToken: "github-token",
	commentOnIssue: true,
	wait: "none",
	waitTimeoutSeconds: DEFAULT_WAIT_TIMEOUT_SECONDS,
	forceNewChat: false,
};

describe("ActionInputsSchema", () => {
	describe("Valid Input Cases", () => {
		test("accepts minimal required inputs", () => {
			const result = ActionInputsSchema.parse(actionInputValid);
			expect(result.coderURL).toBe(actionInputValid.coderURL);
			expect(result.coderToken).toBe(actionInputValid.coderToken);
			expect(result.coderOrganization).toBe(actionInputValid.coderOrganization);
			expect(result.chatPrompt).toBe(actionInputValid.chatPrompt);
			expect(result.githubURL).toBe(actionInputValid.githubURL);
			expect(result.githubToken).toBe(actionInputValid.githubToken);
		});

		test("accepts optional workspace-id", () => {
			const input = {
				...actionInputValid,
				workspaceId: "550e8400-e29b-41d4-a716-446655440000",
			};
			const result = ActionInputsSchema.parse(input);
			expect(result.workspaceId).toBe(input.workspaceId);
		});

		test("accepts optional model-config-id", () => {
			const input = {
				...actionInputValid,
				modelConfigId: "550e8400-e29b-41d4-a716-446655440000",
			};
			const result = ActionInputsSchema.parse(input);
			expect(result.modelConfigId).toBe(input.modelConfigId);
		});

		test("accepts optional existing-chat-id", () => {
			const input = {
				...actionInputValid,
				existingChatId: "550e8400-e29b-41d4-a716-446655440000",
			};
			const result = ActionInputsSchema.parse(input);
			expect(result.existingChatId).toBe(input.existingChatId);
		});

		test("accepts optional idempotency-key", () => {
			const input = {
				...actionInputValid,
				idempotencyKey: "gh:owner/repo#123",
			};
			const result = ActionInputsSchema.parse(input);
			expect(result.idempotencyKey).toBe(input.idempotencyKey);
		});

		test("coderOrganization is optional with no default", () => {
			const { coderOrganization: _, ...withoutOrg } = actionInputValid;
			const result = ActionInputsSchema.parse(withoutOrg);
			expect(result.coderOrganization).toBeUndefined();
		});

		test("accepts valid URL formats", () => {
			const validUrls = [
				"https://coder.test",
				"https://coder.example.com:8080",
				"http://12.34.56.78",
				"https://12.34.56.78:9000",
				"http://localhost:3000",
				"http://127.0.0.1:3000",
				"http://[::1]:3000",
			];

			for (const url of validUrls) {
				const input = {
					...actionInputValid,
					coderURL: url,
				};
				const result = ActionInputsSchema.parse(input);
				expect(result.coderURL).toBe(url);
			}
		});
	});

	describe("Invalid Input Cases", () => {
		test("rejects missing required fields", () => {
			expect(() => ActionInputsSchema.parse({})).toThrow();
		});

		test("rejects invalid URL format for coderURL", () => {
			const input = {
				...actionInputValid,
				coderURL: "not-a-url",
			};
			expect(() => ActionInputsSchema.parse(input)).toThrow();
		});

		test("rejects invalid URL format for githubURL", () => {
			const input = {
				...actionInputValid,
				githubURL: "not-a-url",
			};
			expect(() => ActionInputsSchema.parse(input)).toThrow();
		});

		test("rejects empty string for githubToken", () => {
			const input = {
				...actionInputValid,
				githubToken: "",
			};
			expect(() => ActionInputsSchema.parse(input)).toThrow();
		});

		test("rejects empty strings for required fields", () => {
			const input = {
				...actionInputValid,
				coderToken: "",
			};
			expect(() => ActionInputsSchema.parse(input)).toThrow();
		});

		test("rejects invalid UUID for workspaceId", () => {
			const input = {
				...actionInputValid,
				workspaceId: "not-a-uuid",
			};
			expect(() => ActionInputsSchema.parse(input)).toThrow();
		});

		test("rejects renamed-away github-issue-url field", () => {
			const { githubURL: _, ...withoutGithubURL } = actionInputValid;
			const input = {
				...withoutGithubURL,
				githubIssueURL: "https://github.com/owner/repo/issues/123",
			};
			expect(() => ActionInputsSchema.parse(input)).toThrow();
		});

		test("rejects existing-chat-id combined with force-new-chat", () => {
			const result = ActionInputsSchema.safeParse({
				...actionInputValid,
				existingChatId: "550e8400-e29b-41d4-a716-446655440000",
				forceNewChat: true,
			});
			expect(result.success).toBe(false);
			if (result.success) {
				return;
			}
			expect(result.error.issues).toEqual(
				expect.arrayContaining([
					expect.objectContaining({
						path: ["forceNewChat"],
						message: expect.stringMatching(
							/existing-chat-id and force-new-chat/,
						),
					}),
				]),
			);
		});
	});

	describe("Wait mode", () => {
		test("wait defaults to none when omitted", () => {
			const { wait: _, ...withoutWait } = actionInputValid;
			const result = ActionInputsSchema.parse(withoutWait);
			expect(result.wait).toBe("none");
		});

		test("accepts wait=none", () => {
			const result = ActionInputsSchema.parse({
				...actionInputValid,
				wait: "none",
			});
			expect(result.wait).toBe("none");
		});

		test("accepts wait=complete", () => {
			const result = ActionInputsSchema.parse({
				...actionInputValid,
				wait: "complete",
			});
			expect(result.wait).toBe("complete");
		});

		test("rejects unknown wait values", () => {
			const input = {
				...actionInputValid,
				wait: "forever",
			};
			expect(() => ActionInputsSchema.parse(input)).toThrow();
		});
	});

	describe("wait-timeout-seconds", () => {
		test("defaults to DEFAULT_WAIT_TIMEOUT_SECONDS when omitted", () => {
			const { waitTimeoutSeconds: _, ...withoutTimeout } = actionInputValid;
			const result = ActionInputsSchema.parse(withoutTimeout);
			expect(result.waitTimeoutSeconds).toBe(DEFAULT_WAIT_TIMEOUT_SECONDS);
		});

		test("accepts a positive integer", () => {
			const result = ActionInputsSchema.parse({
				...actionInputValid,
				waitTimeoutSeconds: 1200,
			});
			expect(result.waitTimeoutSeconds).toBe(1200);
		});

		test("coerces a positive integer string", () => {
			const result = ActionInputsSchema.parse({
				...actionInputValid,
				waitTimeoutSeconds: "900",
			});
			expect(result.waitTimeoutSeconds).toBe(900);
		});

		test("rejects 0", () => {
			expect(() =>
				ActionInputsSchema.parse({
					...actionInputValid,
					waitTimeoutSeconds: 0,
				}),
			).toThrow();
		});

		test("rejects negative integers", () => {
			expect(() =>
				ActionInputsSchema.parse({
					...actionInputValid,
					waitTimeoutSeconds: -5,
				}),
			).toThrow();
		});

		test("rejects non-integers", () => {
			expect(() =>
				ActionInputsSchema.parse({
					...actionInputValid,
					waitTimeoutSeconds: 1.5,
				}),
			).toThrow();
		});
	});
});

describe("ActionOutputsSchema", () => {
	const minimalOutputs = {
		coderUsername: "testuser",
		chatId: "990e8400-e29b-41d4-a716-446655440000",
		chatUrl: "https://coder.test/agents/990e8400-e29b-41d4-a716-446655440000",
		chatCreated: true,
	};

	test("parses minimal outputs", () => {
		const result = ActionOutputsSchema.parse(minimalOutputs);
		expect(result.chatId).toBe(minimalOutputs.chatId);
	});

	test("includes the full v0 output surface", () => {
		const result = ActionOutputsSchema.parse({
			...minimalOutputs,
			chatStatus: "completed",
			chatTitle: "Fix issue",
			workspaceId: "aa0e8400-e29b-41d4-a716-446655440000",
			pullRequestUrl: "https://github.com/owner/repo/pull/42",
			pullRequestState: "open",
			pullRequestTitle: "Fix issue #123",
			pullRequestNumber: 42,
			additions: 50,
			deletions: 10,
			changedFiles: 3,
			headBranch: "fix/issue-123",
			baseBranch: "main",
			chatErrorKind: "spend_exceeded",
			chatErrorMessage: "spend cap reached",
		});
		expect(result.chatStatus).toBe("completed");
		expect(result.chatTitle).toBe("Fix issue");
		expect(result.workspaceId).toBe("aa0e8400-e29b-41d4-a716-446655440000");
		expect(result.pullRequestUrl).toBe("https://github.com/owner/repo/pull/42");
		expect(result.pullRequestState).toBe("open");
		expect(result.pullRequestTitle).toBe("Fix issue #123");
		expect(result.pullRequestNumber).toBe(42);
		expect(result.additions).toBe(50);
		expect(result.deletions).toBe(10);
		expect(result.changedFiles).toBe(3);
		expect(result.headBranch).toBe("fix/issue-123");
		expect(result.baseBranch).toBe("main");
		expect(result.chatErrorKind).toBe("spend_exceeded");
		expect(result.chatErrorMessage).toBe("spend cap reached");
	});
});

describe("CoderChatSchema", () => {
	test("parses a minimal chat object", () => {
		const result = CoderChatSchema.parse(mockChat);
		expect(result.title).toBe(mockChat.title);
		expect(result.status).toBe(mockChat.status);
	});

	test("parses a chat with diff_status populated", () => {
		const result = CoderChatSchema.parse(mockChatWithDiff);
		expect(result.diff_status).toBeDefined();
		expect(result.diff_status?.url).toBe(
			"https://github.com/test-org/test-repo/pull/42",
		);
		expect(result.diff_status?.pr_number).toBe(42);
		expect(result.diff_status?.additions).toBe(50);
		expect(result.diff_status?.deletions).toBe(10);
		expect(result.diff_status?.changed_files).toBe(3);
		expect(result.diff_status?.head_branch).toBe("fix/issue-123");
		expect(result.diff_status?.base_branch).toBe("main");
		expect(result.diff_status?.pull_request_state).toBe("open");
		expect(result.diff_status?.pull_request_title).toBe("Fix issue #123");
	});

	test("parses a chat with diff_status null", () => {
		const result = CoderChatSchema.parse({
			...mockChat,
			diff_status: null,
		});
		expect(result.diff_status).toBeNull();
	});

	test("parses a chat with last_error populated", () => {
		const result = CoderChatSchema.parse({
			...mockChat,
			status: "error",
			last_error: "spend cap reached",
		});
		expect(result.last_error).toBe("spend cap reached");
	});
});
