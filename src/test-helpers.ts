import { mock } from "bun:test";
import { type CoderClient, ChatIdSchema } from "./coder-client";
import type {
	CoderSDKUser,
	CoderSDKGetUsersResponse,
	CoderChat,
	CoderOrganization,
	CreateChatRequest,
	CreateChatMessageRequest,
	CreateChatMessageResponse,
	ChatId,
} from "./coder-client";
import type { Clock } from "./action";
import type { ActionInputs } from "./schemas";
import { DEFAULT_WAIT_TIMEOUT_SECONDS } from "./schemas";
import type { ActionContext } from "./action";

/**
 * Fake clock that records every sleep duration and treats sleeps as
 * instantaneous, so the 5-second polling cadence is deterministic in
 * tests. Time advances synchronously with each sleep.
 */
export function createFakeClock(): Clock & { sleeps: number[] } {
	const sleeps: number[] = [];
	let currentMs = 0;
	return {
		now: () => currentMs,
		sleep: (ms: number) => {
			sleeps.push(ms);
			currentMs += ms;
			return Promise.resolve();
		},
		sleeps,
	};
}

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

// User with no organization memberships.
export const mockUserNoOrgs: CoderSDKUser = {
	...mockUser,
	organization_ids: [],
};

// Default organization fixture. The id is intentionally distinct from
// `mockUser.organization_ids[0]` so org-resolution tests can prove which path
// produced the value rather than relying on mock-call assertions alone.
export const mockOrganization: CoderOrganization = {
	id: "cc0e8400-e29b-41d4-a716-446655440000",
	name: "coder",
	display_name: "Coder",
};

export const mockChat: CoderChat = {
	id: ChatIdSchema.parse("990e8400-e29b-41d4-a716-446655440000"),
	owner_id: "550e8400-e29b-41d4-a716-446655440000",
	workspace_id: "aa0e8400-e29b-41d4-a716-446655440000",
	parent_chat_id: null,
	root_chat_id: null,
	last_model_config_id: "bb0e8400-e29b-41d4-a716-446655440000",
	title: "Test chat",
	status: "running",
	last_error: null,
	diff_status: null,
	created_at: "2024-01-01T00:00:00Z",
	updated_at: "2024-01-01T00:00:00Z",
	archived: false,
};

export const mockChatWithDiff: CoderChat = {
	...mockChat,
	status: "completed",
	diff_status: {
		chat_id: "990e8400-e29b-41d4-a716-446655440000",
		url: "https://github.com/test-org/test-repo/pull/42",
		pull_request_state: "open",
		pull_request_title: "Fix issue #123",
		pull_request_draft: false,
		changes_requested: false,
		additions: 50,
		deletions: 10,
		changed_files: 3,
		author_login: "testuser",
		author_avatar_url: null,
		base_branch: "main",
		head_branch: "fix/issue-123",
		pr_number: 42,
		commits: 2,
		approved: false,
		reviewer_count: 0,
		refreshed_at: "2024-01-01T01:00:00Z",
		stale_at: null,
	},
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
		coderOrganization: undefined,
		githubToken: "github-token",
		githubURL: "https://github.com/test-org/test-repo/issues/123",
		githubUserID: 12345,
		commentOnIssue: true,
		wait: "none",
		waitTimeoutSeconds: DEFAULT_WAIT_TIMEOUT_SECONDS,
		...overrides,
	} as ActionInputs;
}

/**
 * Mock CoderClient for testing
 */
export class MockCoderClient implements CoderClient {
	public mockGetCoderUserByGithubID = mock();
	public mockGetCoderUserByUsername = mock((_username: string) =>
		Promise.resolve(mockUser),
	);
	public mockGetOrganizationByName = mock((_name: string) =>
		Promise.resolve(mockOrganization),
	);
	public mockCreateChat = mock();
	public mockCreateChatMessage = mock();
	public mockGetChat = mock();
	public mockListChats = mock();

	async getCoderUserByGitHubId(githubUserId: number): Promise<CoderSDKUser> {
		return this.mockGetCoderUserByGithubID(githubUserId);
	}

	async getCoderUserByUsername(username: string): Promise<CoderSDKUser> {
		return this.mockGetCoderUserByUsername(username);
	}

	async getOrganizationByName(name: string): Promise<CoderOrganization> {
		return this.mockGetOrganizationByName(name);
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
 * Build a minimal `ActionContext` shaped like `@actions/github`'s Context.
 * Tests populate only the fields they exercise.
 */
export function createMockContext(
	overrides?: Partial<ActionContext>,
): ActionContext {
	return {
		eventName: "",
		actor: "",
		payload: {},
		...overrides,
	};
}

/**
 * Mock Octokit for testing. Includes a `paginate` mock so tests for code
 * paths that walk every comment with `octokit.paginate(listComments, ...)`
 * can return the full list in one shot. By default `paginate` resolves to
 * the `data` array of whatever `listComments` was set to return so existing
 * single-page tests keep working without changing every call site.
 */
export function createMockOctokit() {
	const listComments = mock();
	const paginate = mock(async () => {
		const result = await listComments();
		return (result?.data ?? []) as unknown[];
	}) as ReturnType<typeof mock> & {
		iterator: ReturnType<typeof mock>;
	};
	paginate.iterator = mock();
	return {
		paginate,
		rest: {
			users: {
				getByUsername: mock(),
			},
			issues: {
				listComments,
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
		headers: new Map(),
	};
}
