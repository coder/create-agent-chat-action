import * as core from "@actions/core";
import type { ActionOutputs } from "./schemas";

/**
 * OUTPUT_MAP declares how each `ActionOutputs` property maps to its
 * `action.yaml` output name. Required entries are always emitted; optional
 * entries are emitted only when defined. Keeping the list data-driven
 * prevents drift between property names and YAML output names that a
 * conditional `setOutput` chain hides.
 */
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
	{ name: "additions", prop: "additions" },
	{ name: "deletions", prop: "deletions" },
	{ name: "changed-files", prop: "changedFiles" },
	{ name: "head-branch", prop: "headBranch" },
	{ name: "base-branch", prop: "baseBranch" },
	{ name: "chat-error-kind", prop: "chatErrorKind" },
	{ name: "chat-error-message", prop: "chatErrorMessage" },
];

/**
 * setActionOutputs writes every entry from OUTPUT_MAP to GitHub Actions
 * outputs. Optional entries with `undefined` values are skipped so
 * downstream `if:` guards behave the way workflow authors expect.
 * Numbers and booleans are coerced via `String(...)` so the emitted
 * value is the same regardless of the runtime type.
 */
export function setActionOutputs(outputs: ActionOutputs): void {
	for (const { name, prop, required } of OUTPUT_MAP) {
		const value = outputs[prop];
		if (!required && value === undefined) {
			continue;
		}
		// Required fields with `undefined` values fall through to the
		// empty string. This is defensive: ActionOutputsSchema rejects
		// missing required fields, so this branch should not fire in
		// practice, but emitting `""` rather than crashing here keeps
		// the workflow log readable if someone short-circuits the
		// schema in tests.
		const stringified = typeof value === "string" ? value : String(value ?? "");
		core.setOutput(name, stringified);
	}
}
