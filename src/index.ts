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

		core.setOutput("coder-username", outputs.coderUsername);
		core.setOutput("chat-id", outputs.chatId);
		core.setOutput("chat-url", outputs.chatUrl);
		core.setOutput("chat-created", outputs.chatCreated.toString());
		if (outputs.chatStatus !== undefined) {
			core.setOutput("chat-status", outputs.chatStatus);
		}
		if (outputs.chatTitle !== undefined) {
			core.setOutput("chat-title", outputs.chatTitle);
		}
		if (outputs.workspaceId !== undefined) {
			core.setOutput("workspace-id", outputs.workspaceId);
		}
		if (outputs.pullRequestUrl !== undefined) {
			core.setOutput("pull-request-url", outputs.pullRequestUrl);
		}
		if (outputs.pullRequestState !== undefined) {
			core.setOutput("pull-request-state", outputs.pullRequestState);
		}
		if (outputs.pullRequestTitle !== undefined) {
			core.setOutput("pull-request-title", outputs.pullRequestTitle);
		}
		if (outputs.pullRequestNumber !== undefined) {
			core.setOutput(
				"pull-request-number",
				outputs.pullRequestNumber.toString(),
			);
		}
		if (outputs.additions !== undefined) {
			core.setOutput("additions", outputs.additions.toString());
		}
		if (outputs.deletions !== undefined) {
			core.setOutput("deletions", outputs.deletions.toString());
		}
		if (outputs.changedFiles !== undefined) {
			core.setOutput("changed-files", outputs.changedFiles.toString());
		}
		if (outputs.headBranch !== undefined) {
			core.setOutput("head-branch", outputs.headBranch);
		}
		if (outputs.baseBranch !== undefined) {
			core.setOutput("base-branch", outputs.baseBranch);
		}
		if (outputs.chatErrorKind !== undefined) {
			core.setOutput("chat-error-kind", outputs.chatErrorKind);
		}
		if (outputs.chatErrorMessage !== undefined) {
			core.setOutput("chat-error-message", outputs.chatErrorMessage);
		}

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
