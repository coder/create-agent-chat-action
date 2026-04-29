import { z } from "zod";

export interface CoderClient {
	getCoderUserByGitHubId(
		githubUserId: number | undefined,
	): Promise<CoderSDKUser>;

	createChat(params: CreateChatRequest): Promise<CoderChat>;

	createChatMessage(
		chatId: ChatId,
		params: CreateChatMessageRequest,
	): Promise<CreateChatMessageResponse>;

	getChat(chatId: ChatId): Promise<CoderChat>;

	listChats(): Promise<CoderChat[]>;
}

export class RealCoderClient implements CoderClient {
	private readonly headers: Record<string, string>;

	constructor(
		private readonly serverURL: string,
		apiToken: string,
	) {
		this.headers = {
			"Coder-Session-Token": apiToken,
			"Content-Type": "application/json",
		};
	}

	private async request<T>(
		endpoint: string,
		options?: RequestInit,
	): Promise<T> {
		const url = `${this.serverURL}${endpoint}`;
		const response = await fetch(url, {
			...options,
			headers: { ...this.headers, ...options?.headers },
		});

		if (!response.ok) {
			const body = await response.text().catch(() => "");
			throw new CoderAPIError(
				`Coder API error: ${response.statusText}`,
				response.status,
				body,
			);
		}

		if (
			response.status === 204 ||
			response.headers?.get("content-length") === "0"
		) {
			return undefined as T;
		}

		return response.json() as Promise<T>;
	}

	async getCoderUserByGitHubId(
		githubUserId: number | undefined,
	): Promise<CoderSDKUser> {
		if (githubUserId === undefined) {
			throw new CoderAPIError("GitHub user ID cannot be undefined", 400);
		}
		if (githubUserId === 0) {
			throw "GitHub user ID cannot be 0";
		}
		const endpoint = `/api/v2/users?q=${encodeURIComponent(`github_com_user_id:${githubUserId}`)}`;
		const response = await this.request<unknown[]>(endpoint);
		const userList = CoderSDKGetUsersResponseSchema.parse(response);
		if (userList.users.length === 0) {
			throw new CoderAPIError(
				`No Coder user found with GitHub user ID ${githubUserId}`,
				404,
			);
		}
		if (userList.users.length > 1) {
			throw new CoderAPIError(
				`Multiple Coder users found with GitHub user ID ${githubUserId}`,
				409,
			);
		}
		return CoderSDKUserSchema.parse(userList.users[0]);
	}

	async createChat(params: CreateChatRequest): Promise<CoderChat> {
		const endpoint = "/api/experimental/chats";
		const response = await this.request<unknown>(endpoint, {
			method: "POST",
			body: JSON.stringify(params),
		});
		return CoderChatSchema.parse(response);
	}

	async createChatMessage(
		chatId: ChatId,
		params: CreateChatMessageRequest,
	): Promise<CreateChatMessageResponse> {
		const endpoint = `/api/experimental/chats/${encodeURIComponent(chatId)}/messages`;
		const response = await this.request<unknown>(endpoint, {
			method: "POST",
			body: JSON.stringify(params),
		});
		return CreateChatMessageResponseSchema.parse(response);
	}

	async getChat(chatId: ChatId): Promise<CoderChat> {
		const endpoint = `/api/experimental/chats/${encodeURIComponent(chatId)}`;
		const response = await this.request<unknown>(endpoint);
		return CoderChatSchema.parse(response);
	}

	async listChats(): Promise<CoderChat[]> {
		const endpoint = "/api/experimental/chats";
		const response = await this.request<unknown>(endpoint);
		const parsed = CoderChatListResponseSchema.parse(response);
		return parsed;
	}
}

// Branded types
export const ChatIdSchema = z.string().uuid().brand("ChatId");
export type ChatId = z.infer<typeof ChatIdSchema>;

// User schemas (same as create-task-action)
export const CoderSDKUserSchema = z.object({
	id: z.string().uuid(),
	username: z.string(),
	email: z.string().email(),
	organization_ids: z.array(z.string().uuid()),
	github_com_user_id: z.number().optional(),
});
export type CoderSDKUser = z.infer<typeof CoderSDKUserSchema>;

export const CoderSDKGetUsersResponseSchema = z.object({
	users: z.array(CoderSDKUserSchema),
});
export type CoderSDKGetUsersResponse = z.infer<
	typeof CoderSDKGetUsersResponseSchema
>;

// Chat status enum
export const ChatStatusSchema = z.enum([
	"waiting",
	"pending",
	"running",
	"paused",
	"completed",
	"error",
]);
export type ChatStatus = z.infer<typeof ChatStatusSchema>;

// ChatDiffStatusSchema describes the PR/branch metadata Agents tracks for
// a chat. Cherry-picked from the discarded PR #1 schema; the runtime
// behavior that consumes it lands in later slices.
export const ChatDiffStatusSchema = z.object({
	chat_id: z.string().uuid(),
	url: z.string().nullable().optional(),
	pull_request_state: z.string().nullable().optional(),
	pull_request_title: z.string().default(""),
	pull_request_draft: z.boolean().default(false),
	changes_requested: z.boolean().default(false),
	additions: z.number().default(0),
	deletions: z.number().default(0),
	changed_files: z.number().default(0),
	author_login: z.string().nullable().optional(),
	author_avatar_url: z.string().nullable().optional(),
	base_branch: z.string().nullable().optional(),
	head_branch: z.string().nullable().optional(),
	pr_number: z.number().nullable().optional(),
	commits: z.number().nullable().optional(),
	approved: z.boolean().nullable().optional(),
	reviewer_count: z.number().nullable().optional(),
	refreshed_at: z.string().nullable().optional(),
	stale_at: z.string().nullable().optional(),
});
export type ChatDiffStatus = z.infer<typeof ChatDiffStatusSchema>;

// Chat schema describes the full chat object returned by the API.
export const CoderChatSchema = z.object({
	id: ChatIdSchema,
	owner_id: z.string().uuid(),
	workspace_id: z.string().uuid().nullable().optional(),
	parent_chat_id: z.string().uuid().nullable().optional(),
	root_chat_id: z.string().uuid().nullable().optional(),
	last_model_config_id: z.string().uuid().optional(),
	title: z.string(),
	status: ChatStatusSchema,
	last_error: z.string().nullable().optional(),
	diff_status: ChatDiffStatusSchema.nullable().optional(),
	created_at: z.string(),
	updated_at: z.string(),
	archived: z.boolean().optional(),
});
export type CoderChat = z.infer<typeof CoderChatSchema>;

// Chat list response (the API returns an array)
export const CoderChatListResponseSchema = z.array(CoderChatSchema);

// Chat input part
export const ChatInputPartSchema = z.object({
	type: z.literal("text"),
	text: z.string().min(1),
});
export type ChatInputPart = z.infer<typeof ChatInputPartSchema>;

// Create chat request
export const CreateChatRequestSchema = z.object({
	content: z.array(ChatInputPartSchema).min(1),
	workspace_id: z.string().uuid().optional(),
	model_config_id: z.string().uuid().optional(),
});
export type CreateChatRequest = z.infer<typeof CreateChatRequestSchema>;

// Create chat message request
export const CreateChatMessageRequestSchema = z.object({
	content: z.array(ChatInputPartSchema).min(1),
	model_config_id: z.string().uuid().optional(),
});
export type CreateChatMessageRequest = z.infer<
	typeof CreateChatMessageRequestSchema
>;

// Create chat message response
export const CreateChatMessageResponseSchema = z.object({
	queued: z.boolean(),
});
export type CreateChatMessageResponse = z.infer<
	typeof CreateChatMessageResponseSchema
>;

// CoderAPIError
export class CoderAPIError extends Error {
	constructor(
		message: string,
		public readonly statusCode: number,
		public readonly response?: unknown,
	) {
		super(message);
		this.name = "CoderAPIError";
	}
}
