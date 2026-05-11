import { describe, expect, spyOn, test } from "bun:test";
import * as core from "@actions/core";
import { ActionFailureError } from "./action";
import { ChatIdSchema } from "./coder-client";
import { OUTPUT_MAP, setActionOutputs, setFailureOutputs } from "./outputs";
import type { ActionOutputs } from "./schemas";
import { ActionOutputsSchema } from "./schemas";
import { mockChat } from "./test-helpers";

const baseOutputs: ActionOutputs = {
	coderUsername: "u",
	chatId: "990e8400-e29b-41d4-a716-446655440000",
	chatUrl: "https://coder.test/chats/990e8400-e29b-41d4-a716-446655440000",
	chatCreated: true,
};

function captureSetOutput(): {
	calls: Array<[string, string]>;
	restore: () => void;
} {
	const calls: Array<[string, string]> = [];
	const spy = spyOn(core, "setOutput").mockImplementation(
		(name: string, value: unknown) => {
			calls.push([name, String(value)]);
		},
	);
	return {
		calls,
		restore: () => {
			spy.mockRestore();
		},
	};
}

describe("OUTPUT_MAP", () => {
	test("declares an entry for every action.yaml output", () => {
		const expected = [
			"coder-username",
			"chat-id",
			"chat-url",
			"chat-created",
			"chat-status",
			"chat-title",
			"workspace-id",
			"pull-request-url",
			"pull-request-state",
			"pull-request-title",
			"pull-request-number",
			"diff-additions",
			"diff-deletions",
			"diff-changed-files",
			"head-branch",
			"base-branch",
			"chat-error-kind",
			"chat-error-message",
		];
		const actual = OUTPUT_MAP.map((e) => e.name);
		expect(actual).toEqual(expected);
	});

	test("required entries are exactly the four base outputs", () => {
		const required = OUTPUT_MAP.filter((e) => e.required).map((e) => e.name);
		expect(required).toEqual([
			"coder-username",
			"chat-id",
			"chat-url",
			"chat-created",
		]);
	});

	// Structural guard: a new ActionOutputs property without a matching
	// OUTPUT_MAP entry compiles, passes type checks, and silently never
	// emits the output. This test fails loudly when the two drift.
	test("covers every ActionOutputsSchema key", () => {
		const mapProps = new Set(OUTPUT_MAP.map((e) => e.prop));
		const schemaKeys = new Set(
			Object.keys(ActionOutputsSchema.shape) as Array<keyof ActionOutputs>,
		);
		expect(mapProps).toEqual(schemaKeys);
	});
});

describe("setActionOutputs", () => {
	test("emits the four required outputs even with no optional fields", () => {
		const cap = captureSetOutput();
		try {
			setActionOutputs(baseOutputs);
			const names = cap.calls.map(([n]) => n).sort();
			expect(names).toEqual(
				["chat-created", "chat-id", "chat-url", "coder-username"].sort(),
			);
		} finally {
			cap.restore();
		}
	});

	test("skips optional fields whose value is undefined", () => {
		const cap = captureSetOutput();
		try {
			setActionOutputs({ ...baseOutputs, chatStatus: undefined });
			const emittedNames = cap.calls.map(([n]) => n);
			expect(emittedNames).not.toContain("chat-status");
			expect(emittedNames).not.toContain("workspace-id");
		} finally {
			cap.restore();
		}
	});

	test("emits the string '0' for numeric zero rather than skipping", () => {
		const cap = captureSetOutput();
		try {
			setActionOutputs({ ...baseOutputs, additions: 0 });
			const additions = cap.calls.find(([n]) => n === "diff-additions");
			expect(additions).toBeDefined();
			expect(additions?.[1]).toBe("0");
		} finally {
			cap.restore();
		}
	});

	test("emits the string 'false' for boolean false", () => {
		const cap = captureSetOutput();
		try {
			setActionOutputs({ ...baseOutputs, chatCreated: false });
			const created = cap.calls.find(([n]) => n === "chat-created");
			expect(created).toBeDefined();
			expect(created?.[1]).toBe("false");
		} finally {
			cap.restore();
		}
	});

	test("emits a number cast to string for numeric outputs", () => {
		const cap = captureSetOutput();
		try {
			setActionOutputs({
				...baseOutputs,
				additions: 50,
				deletions: 10,
				changedFiles: 3,
				pullRequestNumber: 42,
			});
			const numericPairs = cap.calls.filter(([n]) =>
				[
					"diff-additions",
					"diff-deletions",
					"diff-changed-files",
					"pull-request-number",
				].includes(n),
			);
			const map = Object.fromEntries(numericPairs);
			expect(map["diff-additions"]).toBe("50");
			expect(map["diff-deletions"]).toBe("10");
			expect(map["diff-changed-files"]).toBe("3");
			expect(map["pull-request-number"]).toBe("42");
		} finally {
			cap.restore();
		}
	});

	test("emits the empty string when a required field is undefined", () => {
		// ActionOutputsSchema rejects undefined required fields, but if
		// callers bypass the schema (e.g. tests) we should not crash.
		const cap = captureSetOutput();
		try {
			setActionOutputs({
				...baseOutputs,
				coderUsername: undefined as unknown as string,
			});
			const username = cap.calls.find(([n]) => n === "coder-username");
			expect(username).toBeDefined();
			expect(username?.[1]).toBe("");
		} finally {
			cap.restore();
		}
	});

	test("emits all outputs when every field is populated", () => {
		const cap = captureSetOutput();
		try {
			setActionOutputs({
				...baseOutputs,
				chatStatus: "completed",
				chatTitle: "T",
				workspaceId: "aa0e8400-e29b-41d4-a716-446655440000",
				pullRequestUrl: "https://github.com/o/r/pull/1",
				pullRequestState: "open",
				pullRequestTitle: "title",
				pullRequestNumber: 1,
				additions: 1,
				deletions: 2,
				changedFiles: 3,
				headBranch: "h",
				baseBranch: "b",
				chatErrorKind: "api_error",
				chatErrorMessage: "m",
			});
			expect(cap.calls).toHaveLength(OUTPUT_MAP.length);
		} finally {
			cap.restore();
		}
	});
});

describe("setFailureOutputs", () => {
	test("always sets chat-error-kind and chat-error-message", () => {
		const cap = captureSetOutput();
		try {
			const err = new ActionFailureError("timeout", "Timed out after 600s");

			setFailureOutputs(err);

			expect(cap.calls).toContainEqual(["chat-error-kind", "timeout"]);
			expect(cap.calls).toContainEqual([
				"chat-error-message",
				"Timed out after 600s",
			]);
			const names = cap.calls.map(([n]) => n);
			expect(names).not.toContain("chat-id");
			expect(names).not.toContain("chat-status");
			expect(names).not.toContain("chat-url");
			expect(names).not.toContain("coder-username");
		} finally {
			cap.restore();
		}
	});

	test("emits chat-id and chat-status when error.chat is set", () => {
		const cap = captureSetOutput();
		try {
			const err = new ActionFailureError(
				"api_error",
				"Anthropic 429",
				mockChat,
			);

			setFailureOutputs(err);

			expect(cap.calls).toContainEqual(["chat-id", String(mockChat.id)]);
			expect(cap.calls).toContainEqual(["chat-status", mockChat.status]);
		} finally {
			cap.restore();
		}
	});

	test("emits chat-id from chatId option when chat is absent", () => {
		// Transport failure on first getChat: no fresh chat object,
		// but chatId is forwarded so chat-id is still populated.
		const cap = captureSetOutput();
		try {
			const chatId = ChatIdSchema.parse("990e8400-e29b-41d4-a716-446655440000");
			const err = new ActionFailureError(
				"api_error",
				"connection reset",
				undefined,
				{ chatId },
			);

			setFailureOutputs(err);

			expect(cap.calls).toContainEqual(["chat-id", String(chatId)]);
			const names = cap.calls.map(([n]) => n);
			expect(names).not.toContain("chat-status");
		} finally {
			cap.restore();
		}
	});

	test("emits chat-url and coder-username when decorated", () => {
		const cap = captureSetOutput();
		try {
			const err = new ActionFailureError("timeout", "Timed out", mockChat);
			err.chatUrl = "https://coder.test/chats/abc";
			err.coderUsername = "testuser";

			setFailureOutputs(err);

			expect(cap.calls).toContainEqual([
				"chat-url",
				"https://coder.test/chats/abc",
			]);
			expect(cap.calls).toContainEqual(["coder-username", "testuser"]);
		} finally {
			cap.restore();
		}
	});
});
