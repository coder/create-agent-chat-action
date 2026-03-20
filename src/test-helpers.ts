import { mock } from "bun:test";
import { type CoderClient, ChatIdSchema } from "./coder-client";
import type {
	CoderSDKUser,
	CoderSDKGetUsersResponse,
	CoderChat,
	CreateChatRequest,
	CreateChatMessageRequest,
	CreateChatMessageResponse,
	ChatId,
} from "./coder-client";
import type { ActionInputs } from "./schemas";

/**
 * Mock data for tests
 */
export const mockUser: CoderSDKUser = {
	id: "550e8400-e29b-41d4-a716-446655440000",
	username: "testuser",
	email: "test@example.com",
	organization_ids: ["660e8400-e29b-41d4-a716-446655440000"],
	github_com_user_id: 12345,
};

export const mockUserList: CoderSDKGetUsersResponse = {
	users: [mockUser],
};

export const mockUserListEmpty: CoderSDKGetUsersResponse = {
	users: [],
};

export const mockUserListDuplicate: CoderSDKGetUsersResponse = {
	users: [
		mockUser,
		{
			...mockUser,
			id: "660e8400-e29b-41d4-a716-446655440001",
			username: "testuser2",
		},
	],
};

export const mockChat: CoderChat = {
	id: ChatIdSchema.parse("990e8400-e29b-41d4-a716-446655440000"),
	owner_id: "550e8400-e29b-41d4-a716-446655440000",
	workspace_id: null,
	title: "Test chat",
	status: "running",
	created_at: "2024-01-01T00:00:00Z",
	updated_at: "2024-01-01T00:00:00Z",
};

export const mockChatMessageResponse: CreateChatMessageResponse = {
	queued: false,
};

/**
 * Create mock ActionInputs with defaults
 */
export function createMockInputs(
	overrides?: Partial<ActionInputs>,
): ActionInputs {
	return {
		chatPrompt: "Test prompt",
		coderToken: "test-token",
		coderURL: "https://coder.test",
		coderOrganization: "coder",
		githubToken: "github-token",
		githubIssueURL: "https://github.com/test-org/test-repo/issues/123",
		githubUserID: 12345,
		commentOnIssue: true,
		...overrides,
	} as ActionInputs;
}

/**
 * Mock CoderClient for testing
 */
export class MockCoderClient implements CoderClient {
	public mockGetCoderUserByGithubID = mock();
	public mockCreateChat = mock();
	public mockCreateChatMessage = mock();
	public mockGetChat = mock();
	public mockListChats = mock();

	async getCoderUserByGitHubId(githubUserId: number): Promise<CoderSDKUser> {
		return this.mockGetCoderUserByGithubID(githubUserId);
	}

	async createChat(params: CreateChatRequest): Promise<CoderChat> {
		return this.mockCreateChat(params);
	}

	async createChatMessage(
		chatId: ChatId,
		params: CreateChatMessageRequest,
	): Promise<CreateChatMessageResponse> {
		return this.mockCreateChatMessage(chatId, params);
	}

	async getChat(chatId: ChatId): Promise<CoderChat> {
		return this.mockGetChat(chatId);
	}

	async listChats(): Promise<CoderChat[]> {
		return this.mockListChats();
	}
}

/**
 * Mock Octokit for testing
 */
export function createMockOctokit() {
	return {
		rest: {
			users: {
				getByUsername: mock(),
			},
			issues: {
				listComments: mock(),
				createComment: mock(),
				updateComment: mock(),
			},
		},
	};
}

/**
 * Create mock fetch response
 */
export function createMockResponse(
	body: unknown,
	options: { ok?: boolean; status?: number; statusText?: string } = {},
) {
	return {
		ok: options.ok ?? true,
		status: options.status ?? 200,
		statusText: options.statusText ?? "OK",
		json: async () => body,
		text: async () => JSON.stringify(body),
		headers: new Headers(),
	};
}
