/**
 * Action-owned chat-label keys, used by both the reuse lookup
 * (`findReuseMatch`) and the chat-creation labels (`buildChatLabels`).
 * Both call sites must stay in sync; this object is the single source
 * of truth so a developer cannot add a label key to one without the
 * other.
 */
export const ACTION_LABEL_KEYS = {
	marker: "coder-agents-chat-action",
	target: "gh-target",
	user: "coder-agents-chat-action-user",
	workflow: "coder-agents-chat-action-workflow",
} as const;

/**
 * Reserved label keys on chats this action creates. A sanitized
 * `idempotency-key` matching one of these is rejected upstream so the
 * user input cannot overwrite an action-owned label.
 */
export const RESERVED_LABEL_KEYS: ReadonlySet<string> = new Set(
	Object.values(ACTION_LABEL_KEYS),
);

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
