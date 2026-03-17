import { z } from "zod";

const BaseInputsSchema = z.object({
	chatPrompt: z.string().min(1),
	coderToken: z.string().min(1),
	coderURL: z.string().url(),
	githubIssueURL: z.string().url(),
	githubToken: z.string(),
	coderOrganization: z.string().min(1).optional().default("default"),
	workspaceId: z.string().uuid().optional(),
	modelConfigId: z.string().uuid().optional(),
	existingChatId: z.string().uuid().optional(),
	commentOnIssue: z.boolean().default(true),
});

const WithGithubUserIDSchema = BaseInputsSchema.extend({
	githubUserID: z.number().min(1),
	coderUsername: z.undefined(),
});

const WithCoderUsernameSchema = BaseInputsSchema.extend({
	githubUserID: z.undefined(),
	coderUsername: z.string().min(1),
});

export const ActionInputsSchema = z.union([
	WithGithubUserIDSchema,
	WithCoderUsernameSchema,
]);

export type ActionInputs = z.infer<typeof ActionInputsSchema>;

export const ActionOutputsSchema = z.object({
	coderUsername: z.string(),
	chatId: z.string().uuid(),
	chatUrl: z.string().url(),
	chatCreated: z.boolean(),
});

export type ActionOutputs = z.infer<typeof ActionOutputsSchema>;
