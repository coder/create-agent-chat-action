import * as core from "@actions/core";
import * as github from "@actions/github";
import { ActionFailureError, CoderAgentChatAction } from "./action";
import { RealCoderClient } from "./coder-client";
import { setActionOutputs, setFailureOutputs } from "./outputs";
import { ActionInputsSchema } from "./schemas";

async function main() {
	try {
		const inputs = ActionInputsSchema.parse({
			coderURL: core.getInput("coder-url", { required: true }),
			coderToken: core.getInput("coder-token", { required: true }),
			chatPrompt: core.getInput("chat-prompt", { required: true }),
			coderOrganization: core.getInput("coder-organization") || undefined,
			githubURL: core.getInput("github-url", { required: true }),
			githubToken: core.getInput("github-token", { required: true }),
			workspaceId: core.getInput("workspace-id") || undefined,
			modelConfigId: core.getInput("model-config-id") || undefined,
			existingChatId: core.getInput("existing-chat-id") || undefined,
			commentOnIssue: core.getBooleanInput("comment-on-issue"),
			wait: core.getInput("wait") || undefined,
			waitTimeoutSeconds: core.getInput("wait-timeout-seconds") || undefined,
			idempotencyKey: core.getInput("idempotency-key") || undefined,
			forceNewChat: core.getBooleanInput("force-new-chat"),
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
		if (error instanceof ActionFailureError) {
			setFailureOutputs(error);
			core.setFailed(error.message);
			console.error("Action failed:", error.cause ?? error);
		} else if (error instanceof Error) {
			core.setFailed(error.message);
			console.error("Action failed:", error);
			if (error.stack) {
				console.error("Stack trace:", error.stack);
			}
		} else {
			core.setFailed("Unknown error occurred");
			console.error("Unknown error:", error);
		}
		// `core.setFailed` already marks the run as failed. Calling
		// `process.exit(1)` here would skip any remaining unhandled-rejection
		// logging in node's event loop.
	}
}

// Skip the bootstrap when this module is imported by a test runner. Bun
// sets `import.meta.main` to false on non-entry-point imports.
if (import.meta.main) {
	main();
}
