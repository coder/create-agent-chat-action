import { z } from "zod";

// Default for wait-timeout-seconds. Mirrored in action.yaml's default; keep
// in sync if either changes.
export const DEFAULT_WAIT_TIMEOUT_SECONDS = 600;

// Mutual exclusion of github-user-id and coder-username is enforced by
// the wrapper schema below. Both identity inputs are optional at the
// object level so the runtime can later auto-resolve from the workflow
// context.
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
	waitTimeoutSeconds: z.coerce
		.number()
		.int()
		.positive()
		.default(DEFAULT_WAIT_TIMEOUT_SECONDS),
	idempotencyKey: z.string().min(1).optional(),
});

export const ActionInputsSchema = ActionInputsObjectSchema.refine(
	(data) =>
		!(data.githubUserID !== undefined && data.coderUsername !== undefined),
	{
		message: "Cannot set both github-user-id and coder-username; choose one.",
		path: ["coderUsername"],
	},
);

export type ActionInputs = z.infer<typeof ActionInputsSchema>;

// Machine-readable kinds for the chat-error-kind output. Workflows
// branch on this enum without parsing the human-readable message.
export const ChatErrorKindSchema = z.enum([
	"spend_exceeded",
	"user_not_found",
	"user_ambiguous",
	"org_not_found",
	"api_error",
	"timeout",
]);
export type ChatErrorKind = z.infer<typeof ChatErrorKindSchema>;

// Only the four core fields are guaranteed; the rest are populated
// when the runtime path produces them.
export const ActionOutputsSchema = z.object({
	coderUsername: z.string(),
	chatId: z.string().uuid(),
	chatUrl: z.string().url(),
	chatCreated: z.boolean(),
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
	// Set when a chat ends in error or the wait=complete poll loop
	// times out.
	chatErrorKind: ChatErrorKindSchema.optional(),
	chatErrorMessage: z.string().optional(),
});

export type ActionOutputs = z.infer<typeof ActionOutputsSchema>;
