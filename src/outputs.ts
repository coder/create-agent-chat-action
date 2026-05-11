import * as core from "@actions/core";
import type { ActionOutputs } from "./schemas";

// Maps each ActionOutputs property to its action.yaml output name.
// Required entries are always emitted; optional entries only when defined.
export const OUTPUT_MAP: ReadonlyArray<{
	name: string;
	prop: keyof ActionOutputs;
	required?: boolean;
}> = [
	{ name: "coder-username", prop: "coderUsername", required: true },
	{ name: "chat-id", prop: "chatId", required: true },
	{ name: "chat-url", prop: "chatUrl", required: true },
	{ name: "chat-created", prop: "chatCreated", required: true },
	{ name: "chat-status", prop: "chatStatus" },
	{ name: "chat-title", prop: "chatTitle" },
	{ name: "workspace-id", prop: "workspaceId" },
	{ name: "pull-request-url", prop: "pullRequestUrl" },
	{ name: "pull-request-state", prop: "pullRequestState" },
	{ name: "pull-request-title", prop: "pullRequestTitle" },
	{ name: "pull-request-number", prop: "pullRequestNumber" },
	{ name: "diff-additions", prop: "additions" },
	{ name: "diff-deletions", prop: "deletions" },
	{ name: "diff-changed-files", prop: "changedFiles" },
	{ name: "head-branch", prop: "headBranch" },
	{ name: "base-branch", prop: "baseBranch" },
	{ name: "chat-error-kind", prop: "chatErrorKind" },
	{ name: "chat-error-message", prop: "chatErrorMessage" },
];

// Writes ActionOutputs to GitHub Actions outputs. Optional entries with
// undefined values are skipped so downstream `if:` guards work; values
// are coerced to strings so numbers and booleans serialize predictably.
export function setActionOutputs(outputs: ActionOutputs): void {
	for (const { name, prop, required } of OUTPUT_MAP) {
		const value = outputs[prop];
		if (!required && value === undefined) {
			continue;
		}
		// Defensive: ActionOutputsSchema rejects missing required fields,
		// but emit "" rather than crashing if a test bypasses the schema.
		const stringified = typeof value === "string" ? value : String(value ?? "");
		core.setOutput(name, stringified);
	}
}
