import { z } from "zod";
import { normalizeBaseUrl } from "./url";

/**
 * Default per-request timeout. A hung Coder server would otherwise burn
 * CI minutes up to the workflow's job-level timeout (default 6 hours).
 */
export const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;

export interface CoderClient {
	/**
	 * Resolve the Coder user the configured `coder-token` belongs to via
	 * `GET /api/v2/users/me`. The chat owner on `POST /api/experimental/chats`
	 * is always the token holder (the API has no owner override), so this is
	 * the Coder identity the chat runs as.
	 */
	getAuthenticatedUser(): Promise<CoderSDKUser>;

	getOrganizationByName(name: string): Promise<CoderOrganization>;

	createChat(params: CreateChatRequest): Promise<CoderChat>;

	createChatMessage(
		chatId: ChatId,
		params: CreateChatMessageRequest,
	): Promise<CreateChatMessageResponse>;

	getChat(chatId: ChatId): Promise<CoderChat>;

	listChats(opts?: ListChatsOptions): Promise<CoderChat[]>;
}

export interface ListChatsOptions {
	/**
	 * `key:value` label filter. Multiple entries become repeated
	 * `?label=...` params and are ANDed by the API.
	 */
	label?: string | string[];
	/** If false, send `?q=archived:false` explicitly. */
	archived?: boolean;
}

export class RealCoderClient implements CoderClient {
	private readonly serverURL: string;
	private readonly headers: Record<string, string>;

	constructor(serverURL: string, apiToken: string) {
		// Strip trailing slashes so `${this.serverURL}${endpoint}` never
		// produces a double-slash URL when a user passes `https://coder/`.
		this.serverURL = normalizeBaseUrl(serverURL);
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
		let response: Response;
		try {
			response = await fetch(url, {
				...options,
				headers: { ...this.headers, ...options?.headers },
				signal:
					options?.signal ?? AbortSignal.timeout(DEFAULT_REQUEST_TIMEOUT_MS),
			});
		} catch (err) {
			// Rewrap AbortSignal.timeout's DOMException so callers see a
			// CoderAPIError carrying the endpoint and the configured
			// timeout. Without this, classifyError downgrades the abort to
			// a generic `api_error` with the runtime-default message.
			if (err instanceof DOMException && err.name === "TimeoutError") {
				throw new CoderAPIError(
					`Request to ${endpoint} timed out after ${DEFAULT_REQUEST_TIMEOUT_MS}ms`,
					0,
				);
			}
			throw err;
		}

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

	async getAuthenticatedUser(): Promise<CoderSDKUser> {
		// `users/me` resolves the session token to its owning user. No
		// caching here; callers memoize when they need to reference the
		// result more than once per run.
		const response = await this.request<unknown>("/api/v2/users/me");
		return CoderSDKUserSchema.parse(response);
	}

	async getOrganizationByName(name: string): Promise<CoderOrganization> {
		if (!name) {
			throw new CoderAPIError("Organization name cannot be empty", 400);
		}
		const endpoint = `/api/v2/organizations/${encodeURIComponent(name)}`;
		const response = await this.request<unknown>(endpoint);
		return CoderOrganizationSchema.parse(response);
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

	async listChats(opts?: ListChatsOptions): Promise<CoderChat[]> {
		const params: string[] = [];
		if (opts?.label !== undefined) {
			const labels = Array.isArray(opts.label) ? opts.label : [opts.label];
			for (const l of labels) {
				params.push(`label=${encodeURIComponent(l)}`);
			}
		}
		if (opts?.archived === false) {
			// Explicit `?q=archived:false` pins the contract even though
			// the API filters archived chats by default.
			params.push(`q=${encodeURIComponent("archived:false")}`);
		}
		const query = params.length ? `?${params.join("&")}` : "";
		const endpoint = `/api/experimental/chats${query}`;
		const response = await this.request<unknown>(endpoint);
		const parsed = CoderChatListResponseSchema.parse(response);
		return parsed;
	}
}

// Branded types
export const ChatIdSchema = z.string().uuid().brand("ChatId");
export type ChatId = z.infer<typeof ChatIdSchema>;

// `deleted` is parsed leniently: `codersdk.User` does not currently
// serialize it. The field is retained for forward compatibility with a
// future server schema that exposes it.
export const CoderSDKUserSchema = z.object({
	id: z.string().uuid(),
	username: z.string(),
	email: z.string().email(),
	organization_ids: z.array(z.string().uuid()),
	github_com_user_id: z.number().optional(),
	deleted: z.boolean().optional(),
});
export type CoderSDKUser = z.infer<typeof CoderSDKUserSchema>;

// Organization schema. Returned by `GET /api/v2/organizations/{name}` and
// used to resolve the `coder-organization` input to a UUID for createChat.
export const CoderOrganizationSchema = z.object({
	id: z.string().uuid(),
	name: z.string(),
	display_name: z.string().optional(),
});
export type CoderOrganization = z.infer<typeof CoderOrganizationSchema>;

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

// PR/branch metadata Agents tracks for a chat.
export const ChatDiffStatusSchema = z.object({
	chat_id: z.string().uuid(),
	url: z.string().nullable().optional(),
	pull_request_state: z.string().nullable().optional(),
	pull_request_title: z.string().nullable().optional(),
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
	last_model_config_id: z.string().uuid().nullable().optional(),
	title: z.string(),
	status: ChatStatusSchema,
	last_error: z.string().nullable().optional(),
	diff_status: ChatDiffStatusSchema.nullable().optional(),
	created_at: z.string(),
	updated_at: z.string(),
	archived: z.boolean().nullable().optional(),
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

// Create chat request. The chats API requires `organization_id` on every
// create.
export const CreateChatRequestSchema = z.object({
	organization_id: z.string().uuid(),
	content: z.array(ChatInputPartSchema).min(1),
	workspace_id: z.string().uuid().optional(),
	model_config_id: z.string().uuid().optional(),
	// Sent only when `idempotency-key` is provided. Platform key regex:
	// `^[a-zA-Z0-9][a-zA-Z0-9._/-]*$`, max 50 entries.
	labels: z.record(z.string(), z.string()).optional(),
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

// Full enum for the `chat-error-kind` action output. The action populates
// these downstream when API errors are mapped to outputs.
export const ChatErrorKindSchema = z.enum([
	"org_not_found",
	"spend_exceeded",
	"api_error",
	"timeout",
]);
export type ChatErrorKind = z.infer<typeof ChatErrorKindSchema>;

/**
 * CoderAPIError carries the status code and raw response body from a Coder
 * API failure. The body is preserved verbatim so the failure-path
 * classifier in `comment.ts` can pattern-match structured shapes (e.g.
 * the spend-exceeded 409) without rerunning the request.
 */
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
