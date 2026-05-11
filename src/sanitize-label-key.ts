/**
 * Reserved label keys on chats this action creates. A sanitized
 * `idempotency-key` matching one of these is rejected upstream so the
 * user input cannot overwrite an action-owned label.
 */
export const RESERVED_LABEL_KEYS: ReadonlySet<string> = new Set([
	"coder-agent-chat-action",
	"gh-target",
	"coder-agent-chat-action-user",
]);

/**
 * Coerce an arbitrary string into a chat-label key the platform accepts.
 * Platform regex: `^[a-zA-Z0-9][a-zA-Z0-9._/-]*$`, max 64 bytes. Empty
 * results fall back to `"key"`.
 */
export function sanitizeLabelKey(input: string): string {
	const lowered = input.toLowerCase();
	const replaced = lowered.replace(/[^a-z0-9._/-]/g, "-");
	const trimmed = replaced.replace(/^[^a-z0-9]+/, "");
	const nonEmpty = trimmed.length > 0 ? trimmed : "key";
	return nonEmpty.slice(0, 64);
}
