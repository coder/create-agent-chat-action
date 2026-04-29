import { z } from "zod";

/**
 * Object shape for the raw action inputs. The mutual-exclusion rule for
 * github-user-id and coder-username is enforced by the wrapper schema below.
 *
 * Both identity inputs are optional at the object level. S2 adds an
 * auto-resolve fallback that lets the action run with neither set; S1
 * declares the schema shape that S2 builds on.
 */
const ActionInputsObjectSchema = z.object({
	chatPrompt: z.string().min(1),
	coderToken: z.string().min(1),
	coderURL: z.string().url(),
	coderOrganization: z.string().min(1).optional(),
	githubURL: z.string().url(),
	githubToken: z.string(),
	githubUserID: z.number().int().positive().optional(),
	coderUsername: z.string().min(1).optional(),
	workspaceId: z.string().uuid().optional(),
	modelConfigId: z.string().uuid().optional(),
	existingChatId: z.string().uuid().optional(),
	commentOnIssue: z.boolean().default(true),
	wait: z.enum(["none", "complete"]).default("none"),
	waitTimeoutSeconds: z.coerce.number().int().positive().default(600),
	idempotencyLabelKey: z.string().min(1).optional(),
});

export const ActionInputsSchema = ActionInputsObjectSchema.refine(
	(data) =>
		!(data.githubUserID !== undefined && data.coderUsername !== undefined),
	{
		message:
			"Cannot set both github-user-id and coder-username; choose one or leave both unset to auto-resolve.",
		path: ["coderUsername"],
	},
);

export type ActionInputs = z.infer<typeof ActionInputsSchema>;

/**
 * Action outputs surface for v0. Only the four core fields are guaranteed.
 * The rest are optional: they are populated by later slices (S4 wait, S5
 * failure path, S8 success path) as behavior lands.
 */
export const ActionOutputsSchema = z.object({
	coderUsername: z.string(),
	chatId: z.string().uuid(),
	chatUrl: z.string().url(),
	chatCreated: z.boolean(),
	// Chat metadata (cherry-picked from the discarded PR #1 schema).
	chatStatus: z.string().optional(),
	chatTitle: z.string().optional(),
	workspaceId: z.string().uuid().optional(),
	// Diff/PR metadata, populated when the chat has tracked changes.
	pullRequestUrl: z.string().optional(),
	pullRequestState: z.string().optional(),
	pullRequestTitle: z.string().optional(),
	pullRequestNumber: z.number().optional(),
	additions: z.number().optional(),
	deletions: z.number().optional(),
	changedFiles: z.number().optional(),
	headBranch: z.string().optional(),
	baseBranch: z.string().optional(),
	// Failure-path outputs, populated by S5 when the chat errors.
	chatErrorKind: z.string().optional(),
	chatErrorMessage: z.string().optional(),
});

export type ActionOutputs = z.infer<typeof ActionOutputsSchema>;
