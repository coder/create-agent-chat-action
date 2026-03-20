import * as core from "@actions/core";
import * as github from "@actions/github";
import { CoderAgentChatAction } from "./action";
import { RealCoderClient } from "./coder-client";
import { ActionInputsSchema } from "./schemas";

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
			githubIssueURL: core.getInput("github-issue-url", { required: true }),
			githubToken: core.getInput("github-token", { required: true }),
			githubUserID,
			coderUsername: core.getInput("coder-username") || undefined,
			workspaceId: core.getInput("workspace-id") || undefined,
			modelConfigId: core.getInput("model-config-id") || undefined,
			existingChatId: core.getInput("existing-chat-id") || undefined,
			commentOnIssue: core.getBooleanInput("comment-on-issue"),
		});

		core.debug("Inputs validated successfully");
		core.debug(`Coder URL: ${inputs.coderURL}`);

		const coder = new RealCoderClient(inputs.coderURL, inputs.coderToken);
		const octokit = github.getOctokit(inputs.githubToken);

		core.debug("Clients initialized");

		const action = new CoderAgentChatAction(coder, octokit, inputs);
		const outputs = await action.run();

		core.setOutput("coder-username", outputs.coderUsername);
		core.setOutput("chat-id", outputs.chatId);
		core.setOutput("chat-url", outputs.chatUrl);
		core.setOutput("chat-created", outputs.chatCreated.toString());

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
