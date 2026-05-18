import { describe, expect, test } from "bun:test";
import { sanitizeLabelToken } from "./sanitize-label-token";

describe("sanitizeLabelToken", () => {
	test("lowercases and replaces disallowed characters with '-'", () => {
		expect(sanitizeLabelToken("My Custom Key!")).toBe("my-custom-key-");
	});

	test("preserves the four punctuation classes the platform allows", () => {
		expect(sanitizeLabelToken("a.b_c/d-e")).toBe("a.b_c/d-e");
	});

	test("falls back to 'key' when the input sanitizes to empty", () => {
		expect(sanitizeLabelToken("!@#$%")).toBe("key");
		expect(sanitizeLabelToken("")).toBe("key");
	});

	test("trims leading non-alphanumeric characters before returning", () => {
		expect(sanitizeLabelToken(".foo")).toBe("foo");
		expect(sanitizeLabelToken("---bar")).toBe("bar");
		expect(sanitizeLabelToken("/baz")).toBe("baz");
	});

	test("truncates to 64 bytes", () => {
		const seventy = "a".repeat(70);
		const result = sanitizeLabelToken(seventy);
		expect(result).toHaveLength(64);
		expect(result).toBe("a".repeat(64));
	});
});
