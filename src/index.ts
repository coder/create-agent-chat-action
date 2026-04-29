import * as core from "@actions/core";
import * as github from "@actions/github";
import { CoderAgentChatAction } from "./action";
import { RealCoderClient } from "./coder-client";
import { ActionInputsSchema } from "./schemas";
import type { ActionOutputs } from "./schemas";

// OUTPUT_MAP declares how each ActionOutputs property maps to its action.yaml
// output name. The first entry is required (chat-* / coder-username always set);
// subsequent entries are optional and emitted only when defined. Keeping the
// list data-driven prevents drift between property names and YAML output names
// that a 13-block conditional chain hides.
const OUTPUT_MAP: ReadonlyArray<{
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

export function setActionOutputs(outputs: ActionOutputs): void {
	for (const { name, prop, required } of OUTPUT_MAP) {
		const value = outputs[prop];
		if (!required && value === undefined) {
			continue;
		}
		// `core.setOutput` stringifies values internally, but numbers stringify
		// to NaN-prone shapes in some contexts; coerce explicitly.
		const stringified = typeof value === "string" ? value : String(value ?? "");
		core.setOutput(name, stringified);
	}
}

async function main() {
	try {
		const githubUserIdInput = core.getInput("github-user-id");
		const githubUserID = githubUserIdInput
			? Number.parseInt(githubUserIdInput, 10)
			: undefined;

		const inputs = ActionInputsSchema.parse({
			coderURL: core.getInput("coder-url", { required: true }),
			coderToken: core.getInput("coder-token", { required: true }),
			chatPrompt: core.getInput("chat-prompt", { required: true }),
			coderOrganization: core.getInput("coder-organization") || undefined,
			githubURL: core.getInput("github-url", { required: true }),
			githubToken: core.getInput("github-token", { required: true }),
			githubUserID,
			coderUsername: core.getInput("coder-username") || undefined,
			workspaceId: core.getInput("workspace-id") || undefined,
			modelConfigId: core.getInput("model-config-id") || undefined,
			existingChatId: core.getInput("existing-chat-id") || undefined,
			commentOnIssue: core.getBooleanInput("comment-on-issue"),
			wait: core.getInput("wait") || undefined,
			waitTimeoutSeconds: core.getInput("wait-timeout-seconds") || undefined,
			idempotencyLabelKey: core.getInput("idempotency-label-key") || undefined,
		});

		core.debug("Inputs validated successfully");
		core.debug(`Coder URL: ${inputs.coderURL}`);
		core.debug(`Organization: ${inputs.coderOrganization}`);

		const coder = new RealCoderClient(inputs.coderURL, inputs.coderToken);
		const octokit = github.getOctokit(inputs.githubToken);

		core.debug("Clients initialized");

		const action = new CoderAgentChatAction(coder, octokit, inputs);
		const outputs = await action.run();

		setActionOutputs(outputs);

		core.debug("Action completed successfully");
		core.debug(`Outputs: ${JSON.stringify(outputs, null, 2)}`);
	} catch (error) {
		if (error instanceof Error) {
			core.setFailed(error.message);
			console.error("Action failed:", error);
			if (error.stack) {
				console.error("Stack trace:", error.stack);
			}
		} else {
			core.setFailed("Unknown error occurred");
			console.error("Unknown error:", error);
		}
		process.exit(1);
	}
}

main();
