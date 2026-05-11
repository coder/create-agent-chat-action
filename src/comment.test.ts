import { describe, expect, mock, test } from "bun:test";
import { CoderAPIError } from "./coder-client";
import {
	buildCommentMarker,
	buildDeploymentChatsUrl,
	buildFailureCommentBody,
	type ChatErrorKind,
	classifyError,
	deriveCommentKey,
	type FailureDetail,
	findCommentByPredicate,
	normalizeBaseUrl,
} from "./comment";

// ChatErrorKind must mirror FailureDetail's discriminator so adding a kind
// to FailureDetail also widens ChatErrorKind without a separate edit.
const _kindMirrorsDetail: ChatErrorKind extends FailureDetail["kind"]
	? FailureDetail["kind"] extends ChatErrorKind
		? true
		: false
	: false = true;
void _kindMirrorsDetail;

describe("buildCommentMarker", () => {
	test("uses the marker prefix and appends the key verbatim", () => {
		expect(buildCommentMarker("owner/repo#123")).toBe(
			"<!-- coder-agent-chat-action:owner/repo#123 -->",
		);
	});

	test("preserves an idempotency-key value verbatim", () => {
		expect(buildCommentMarker("my-key")).toBe(
			"<!-- coder-agent-chat-action:my-key -->",
		);
	});
});

describe("deriveCommentKey", () => {
	test("uses idempotencyKey when set", () => {
		expect(
			deriveCommentKey({
				idempotencyKey: "custom",
				githubURL: "https://github.com/owner/repo/issues/123",
			}),
		).toBe("custom");
	});

	test("falls back to <owner>/<repo>#<number> from github-url", () => {
		expect(
			deriveCommentKey({
				githubURL: "https://github.com/owner/repo/issues/123",
			}),
		).toBe("owner/repo#123");
	});

	test("derives the same per-target key for PR URLs", () => {
		expect(
			deriveCommentKey({
				githubURL: "https://github.com/owner/repo/pull/42",
			}),
		).toBe("owner/repo#42");
	});

	test("handles enterprise GitHub URLs", () => {
		expect(
			deriveCommentKey({
				githubURL: "https://code.acme.com/owner/repo/issues/42",
			}),
		).toBe("owner/repo#42");
	});

	test("appends workflow suffix to the derived per-target key", () => {
		expect(
			deriveCommentKey({
				githubURL: "https://github.com/owner/repo/issues/123",
				workflow: "doc-check",
			}),
		).toBe("owner/repo#123:doc-check");
	});

	test("idempotencyKey overrides workflow scoping", () => {
		expect(
			deriveCommentKey({
				idempotencyKey: "custom",
				githubURL: "https://github.com/owner/repo/issues/123",
				workflow: "doc-check",
			}),
		).toBe("custom");
	});

	test("ignores an empty workflow string", () => {
		expect(
			deriveCommentKey({
				githubURL: "https://github.com/owner/repo/issues/123",
				workflow: "",
			}),
		).toBe("owner/repo#123");
	});
});

describe("classifyError", () => {
	test("maps the 409 spend-exceeded JSON shape from coder/coder", () => {
		// Shape from coderd/exp_chats.go writeChatUsageLimitExceeded
		// serializing codersdk.ChatUsageLimitExceededResponse: a JSON body
		// with `message`, `spent_micros`, `limit_micros`, `resets_at` returned
		// alongside HTTP 409.
		const err = new CoderAPIError(
			"Coder API error: Conflict",
			409,
			JSON.stringify({
				message: "Chat usage limit exceeded.",
				spent_micros: 1234567,
				limit_micros: 5000000,
				resets_at: "2026-05-01T00:00:00Z",
			}),
		);
		expect(classifyError(err)).toEqual({
			kind: "spend_exceeded",
			message: "Chat usage limit exceeded.",
			spentMicros: 1234567,
			limitMicros: 5000000,
			resetsAt: "2026-05-01T00:00:00Z",
		});
	});

	test("maps the user-not-found error from getCoderUserByGitHubId", () => {
		const err = new CoderAPIError(
			"No Coder user found with GitHub user ID 12345",
			404,
			undefined,
			"user_not_found",
		);
		const result = classifyError(err);
		expect(result.kind).toBe("user_not_found");
		expect(result.message).toContain("No Coder user found");
	});

	test("maps the multi-user error from getCoderUserByGitHubId", () => {
		const err = new CoderAPIError(
			"Multiple Coder users found with GitHub user ID 12345",
			409,
			undefined,
			"user_ambiguous",
		);
		const result = classifyError(err);
		expect(result.kind).toBe("user_ambiguous");
	});

	test("falls back to api_error for unknown CoderAPIError shapes", () => {
		const err = new CoderAPIError("Coder API error: Bad Gateway", 502);
		const result = classifyError(err);
		expect(result.kind).toBe("api_error");
	});

	// 409 with neither the spend-exceeded body nor a user-* error code (a
	// generic conflict) must fall through to api_error rather than being
	// silently misclassified by a future loosening of `parseSpendExceededBody`.
	test("falls back to api_error for 409 without spend body or error code", () => {
		const err = new CoderAPIError("some other conflict", 409);
		const result = classifyError(err);
		expect(result.kind).toBe("api_error");
	});

	// `api_error` must surface the diagnostic `message` from the response
	// body when one is present, not the HTTP status text wrapper. This is
	// the difference between
	//   Detail: workspace_id: must be a valid UUID
	// and
	//   Detail: Coder API error: Bad Request
	// in the failure comment.
	test("api_error surfaces the diagnostic message from the response body", () => {
		const err = new CoderAPIError(
			"Coder API error: Bad Request",
			400,
			JSON.stringify({
				message: "workspace_id: must be a valid UUID",
			}),
		);
		const result = classifyError(err);
		expect(result.kind).toBe("api_error");
		expect(result.message).toBe("workspace_id: must be a valid UUID");
	});

	test("api_error falls back to err.message when response has no JSON body", () => {
		const err = new CoderAPIError("Coder API error: Bad Gateway", 502, "");
		const result = classifyError(err);
		expect(result.message).toBe("Coder API error: Bad Gateway");
	});

	test("falls back to api_error for non-CoderAPIError thrown values", () => {
		const err = new Error("connection refused");
		const result = classifyError(err);
		expect(result.kind).toBe("api_error");
		expect(result.message).toBe("connection refused");
	});

	// `kind` takes precedence over the spend-exceeded body shape so the
	// classifier never silently misclassifies a user-lookup error that
	// happens to ride a 409 with a spend-shaped body.
	test("kind takes precedence over a spend-shaped 409 body", () => {
		const err = new CoderAPIError(
			"Multiple Coder users found with GitHub user ID 12345",
			409,
			JSON.stringify({
				message: "unrelated",
				spent_micros: 1,
				limit_micros: 2,
				resets_at: "",
			}),
			"user_ambiguous",
		);
		const result = classifyError(err);
		expect(result.kind).toBe("user_ambiguous");
	});
});

describe("buildFailureCommentBody", () => {
	const marker = "<!-- coder-agent-chat-action:owner/repo#123 -->";
	const chatsUrl = "https://coder.test/chats";

	test("spend_exceeded body includes kind, dollar amounts, deployment chat URL, and marker", () => {
		const detail: FailureDetail = {
			kind: "spend_exceeded",
			message: "Chat usage limit exceeded.",
			spentMicros: 1230000,
			limitMicros: 5000000,
			resetsAt: "2026-05-01T00:00:00Z",
		};
		const body = buildFailureCommentBody(detail, { chatsUrl, marker });
		expect(body).toContain("chat-error-kind=spend_exceeded");
		expect(body).toContain("$1.23");
		expect(body).toContain("$5.00");
		expect(body).toContain(chatsUrl);
		expect(body.endsWith(marker)).toBe(true);
	});

	test("user_not_found body names both identity inputs and ends with marker", () => {
		const detail: FailureDetail = {
			kind: "user_not_found",
			message: "No Coder user found with GitHub user ID 12345",
		};
		const body = buildFailureCommentBody(detail, { chatsUrl, marker });
		expect(body).toContain("chat-error-kind=user_not_found");
		expect(body).toContain("github-user-id");
		expect(body).toContain("coder-username");
		expect(body.endsWith(marker)).toBe(true);
	});

	test("user_ambiguous body suggests coder-username and ends with marker", () => {
		const detail: FailureDetail = {
			kind: "user_ambiguous",
			message: "Multiple Coder users found with GitHub user ID 12345",
		};
		const body = buildFailureCommentBody(detail, { chatsUrl, marker });
		expect(body).toContain("chat-error-kind=user_ambiguous");
		expect(body).toContain("coder-username");
		expect(body.endsWith(marker)).toBe(true);
	});

	test("api_error body includes the underlying message and ends with marker", () => {
		const detail: FailureDetail = {
			kind: "api_error",
			message: "Coder API error: Bad Gateway",
		};
		const body = buildFailureCommentBody(detail, { chatsUrl, marker });
		expect(body).toContain("chat-error-kind=api_error");
		expect(body).toContain("Coder API error: Bad Gateway");
		expect(body.endsWith(marker)).toBe(true);
	});

	// `org_not_found` is in the enum but no current code path produces it.
	// This test exercises the body so the branch stays in coverage.
	test("org_not_found body names coder-organization and ends with marker", () => {
		const detail: FailureDetail = {
			kind: "org_not_found",
			message: "Coder user has no organization memberships",
		};
		const body = buildFailureCommentBody(detail, { chatsUrl, marker });
		expect(body).toContain("chat-error-kind=org_not_found");
		expect(body).toContain("coder-organization");
		expect(body.endsWith(marker)).toBe(true);
	});
});

describe("normalizeBaseUrl", () => {
	test("strips a trailing slash", () => {
		expect(normalizeBaseUrl("https://coder.test/")).toBe("https://coder.test");
	});

	test("strips query and fragment", () => {
		expect(normalizeBaseUrl("https://coder.test?x=1")).toBe(
			"https://coder.test",
		);
		expect(normalizeBaseUrl("https://coder.test/#anchor")).toBe(
			"https://coder.test",
		);
	});

	test("leaves a clean URL untouched", () => {
		expect(normalizeBaseUrl("https://coder.test")).toBe("https://coder.test");
	});
});

describe("buildDeploymentChatsUrl", () => {
	test("appends /chats to a clean base URL", () => {
		expect(buildDeploymentChatsUrl("https://coder.test")).toBe(
			"https://coder.test/chats",
		);
	});

	test("normalizes trailing slash, query, and fragment before appending", () => {
		expect(buildDeploymentChatsUrl("https://coder.test/?x=1")).toBe(
			"https://coder.test/chats",
		);
		expect(buildDeploymentChatsUrl("https://coder.test/#a")).toBe(
			"https://coder.test/chats",
		);
	});
});

describe("findCommentByPredicate", () => {
	test(
		"sweeps every page (octokit.paginate) and finds the marker even when " +
			"it sits past the first 30-comment page",
		async () => {
			const marker = "<!-- coder-agent-chat-action:owner/repo#1 -->";
			// 35 noise comments before the marker, then a newer noise comment
			// after it. octokit.paginate would return the concatenation of all
			// pages; we just need to confirm findCommentByPredicate calls
			// paginate (not listComments directly) and scans the full list.
			const comments = Array.from({ length: 35 }, (_, i) => ({
				id: i + 1,
				body: `noise ${i}`,
			}));
			comments.push({ id: 999, body: `failure body\n\n${marker}` });
			comments.push({ id: 1000, body: "newer noise" });

			const paginate = mock(async () => comments);
			const octokit = {
				paginate,
				rest: { issues: { listComments: mock() } },
			} as unknown as Parameters<typeof findCommentByPredicate>[0]["octokit"];

			const found = await findCommentByPredicate({
				octokit,
				owner: "owner",
				repo: "repo",
				issueNumber: 1,
				predicate: (c) => c.body?.includes(marker) ?? false,
			});

			expect(found?.id).toBe(999);
			expect(paginate).toHaveBeenCalledTimes(1);
			const paginateCall = (paginate.mock.calls[0] as unknown[])[1] as
				| { per_page?: number }
				| undefined;
			expect(paginateCall?.per_page).toBe(100);
		},
	);

	test("returns undefined when no comment matches the predicate", async () => {
		const paginate = mock(async () => [
			{ id: 1, body: "noise" },
			{ id: 2, body: "more noise" },
		]);
		const octokit = {
			paginate,
			rest: { issues: { listComments: mock() } },
		} as unknown as Parameters<typeof findCommentByPredicate>[0]["octokit"];

		const found = await findCommentByPredicate({
			octokit,
			owner: "owner",
			repo: "repo",
			issueNumber: 1,
			predicate: () => false,
		});

		expect(found).toBeUndefined();
	});

	test("returns the most recent matching comment when multiple match", async () => {
		const marker = "<!-- coder-agent-chat-action:owner/repo#1 -->";
		const paginate = mock(async () => [
			{ id: 1, body: `older\n\n${marker}` },
			{ id: 2, body: `newer\n\n${marker}` },
		]);
		const octokit = {
			paginate,
			rest: { issues: { listComments: mock() } },
		} as unknown as Parameters<typeof findCommentByPredicate>[0]["octokit"];

		const found = await findCommentByPredicate({
			octokit,
			owner: "owner",
			repo: "repo",
			issueNumber: 1,
			predicate: (c) => c.body?.includes(marker) ?? false,
		});

		expect(found?.id).toBe(2);
	});
});
