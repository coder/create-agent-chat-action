import * as core from "@actions/core";
import * as github from "@actions/github";
import { ActionFailureError, CoderAgentChatAction } from "./action";
import { RealCoderClient } from "./coder-client";
import { setActionOutputs, setFailureOutputs } from "./outputs";
import { ActionInputsSchema } from "./schemas";

// Convert the `github-user-id` workflow input to a number, or return
// undefined when unset. Returns NaN for anything that isn't a plain
// decimal integer literal so it fails schema parse instead of silently
// resolving to the wrong Coder user. `Number()` alone is too permissive:
// it accepts hex (`"0x1F"` -> 31), binary (`"0b101"` -> 5), octal
// (`"0o7"` -> 7), and scientific notation (`"1e3"` -> 1000), all of
// which would pass `z.number().int().positive()`. The bare regex gate
// rejects every non-decimal form. See #16.
export function parseGithubUserID(raw: string): number | undefined {
	if (!raw) return undefined;
	if (!/^\d+$/.test(raw)) return Number.NaN;
	return Number(raw);
}

async function main() {
	try {
		const githubUserID = parseGithubUserID(core.getInput("github-user-id"));

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
			idempotencyKey: core.getInput("idempotency-key") || undefined,
		});

		core.debug("Inputs validated successfully");
		core.debug(`Coder URL: ${inputs.coderURL}`);
		core.debug(`Organization: ${inputs.coderOrganization}`);

		const coder = new RealCoderClient(inputs.coderURL, inputs.coderToken);
		const octokit = github.getOctokit(inputs.githubToken);

		core.debug("Clients initialized");

		const action = new CoderAgentChatAction(
			coder,
			octokit,
			inputs,
			github.context,
		);
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
