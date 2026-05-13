import { describe, expect, test } from "bun:test";
import {
	ACTION_LABEL_KEYS,
	RESERVED_LABEL_KEYS,
	sanitizeLabelKey,
} from "./sanitize-label-key";

describe("sanitizeLabelKey", () => {
	test("lowercases and replaces disallowed characters with '-'", () => {
		expect(sanitizeLabelKey("My Custom Key!")).toBe("my-custom-key-");
	});

	test("preserves the four punctuation classes the platform allows", () => {
		expect(sanitizeLabelKey("a.b_c/d-e")).toBe("a.b_c/d-e");
	});

	test("falls back to 'key' when the input sanitizes to empty", () => {
		expect(sanitizeLabelKey("!@#$%")).toBe("key");
		expect(sanitizeLabelKey("")).toBe("key");
	});

	test("trims leading non-alphanumeric characters before returning", () => {
		expect(sanitizeLabelKey(".foo")).toBe("foo");
		expect(sanitizeLabelKey("---bar")).toBe("bar");
		expect(sanitizeLabelKey("/baz")).toBe("baz");
	});

	test("truncates to 64 bytes", () => {
		const seventy = "a".repeat(70);
		const result = sanitizeLabelKey(seventy);
		expect(result).toHaveLength(64);
		expect(result).toBe("a".repeat(64));
	});
});

describe("RESERVED_LABEL_KEYS", () => {
	test("includes the per-user scope key that prevents cross-user hijack", () => {
		// Without this entry, a sanitized idempotency-key value of
		// "coder-agents-chat-action-user" would silently overwrite the
		// per-user label and let any user impersonate any other on the
		// same target.
		expect(RESERVED_LABEL_KEYS.has("coder-agents-chat-action-user")).toBe(true);
	});

	test("includes the per-workflow scope key that prevents reuse-scope hijack", () => {
		// Without this entry, a sanitized idempotency-key value of
		// "coder-agents-chat-action-workflow" would silently overwrite the
		// per-workflow label and break per-workflow reuse isolation.
		expect(RESERVED_LABEL_KEYS.has("coder-agents-chat-action-workflow")).toBe(
			true,
		);
	});

	test("is derived from ACTION_LABEL_KEYS so neither table can drift", () => {
		// `findReuseMatch` and `buildChatLabels` both reference
		// `ACTION_LABEL_KEYS` for the action-owned label keys; the reserved
		// set must reserve every one of them. If a developer adds an entry
		// to `ACTION_LABEL_KEYS` without updating the reserved set, an
		// `idempotency-key` value matching the new key could silently
		// overwrite it.
		for (const key of Object.values(ACTION_LABEL_KEYS)) {
			expect(RESERVED_LABEL_KEYS.has(key)).toBe(true);
		}
	});
});
