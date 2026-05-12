// Helpers for normalizing user-supplied URLs. Extracted to its own module
// so both `coder-client.ts` and `comment.ts` can use them without creating
// a value-import cycle.

// Strip query/fragment and a trailing slash from a Coder deployment URL so
// it can be safely concatenated with a path.
export function normalizeBaseUrl(coderURL: string): string {
	return coderURL.split(/[?#]/)[0].replace(/\/$/, "");
}
