import { describe, expect, test, beforeEach, afterEach, mock } from "bun:test";
import { RealCoderClient, CoderAPIError } from "./coder-client";
import {
	mockUser,
	mockUserList,
	mockUserListEmpty,
	mockUserListDuplicate,
	mockChat,
	mockChatMessageResponse,
	createMockInputs,
	createMockResponse,
} from "./test-helpers";

describe("CoderClient", () => {
	let client: RealCoderClient;
	let mockFetch: ReturnType<typeof mock>;
	let originalFetch: typeof fetch;

	beforeEach(() => {
		originalFetch = global.fetch;
		const mockInputs = createMockInputs();
		client = new RealCoderClient(mockInputs.coderURL, mockInputs.coderToken);
		mockFetch = mock(() => Promise.resolve(createMockResponse([])));
		global.fetch = mockFetch as unknown as typeof fetch;
	});

	afterEach(() => {
		global.fetch = originalFetch;
	});

	describe("getCoderUserByGitHubId", () => {
		test("returns the user when found", async () => {
			mockFetch.mockResolvedValue(createMockResponse(mockUserList));
			const result = await client.getCoderUserByGitHubId(
				mockUser.github_com_user_id,
			);
			expect(mockFetch).toHaveBeenCalledWith(
				`https://coder.test/api/v2/users?q=github_com_user_id%3A${mockUser.github_com_user_id?.toString()}`,
				expect.objectContaining({
					headers: expect.objectContaining({
						"Coder-Session-Token": "test-token",
					}),
				}),
			);
			expect(result.id).toBe(mockUser.id);
			expect(result.username).toBe(mockUser.username);
		});

		test("throws when multiple users found", async () => {
			mockFetch.mockResolvedValue(createMockResponse(mockUserListDuplicate));
			await expect(
				client.getCoderUserByGitHubId(mockUser.github_com_user_id ?? 0),
			).rejects.toThrow(CoderAPIError);
		});

		test("throws when no user found", async () => {
			mockFetch.mockResolvedValue(createMockResponse(mockUserListEmpty));
			await expect(
				client.getCoderUserByGitHubId(mockUser.github_com_user_id ?? 0),
			).rejects.toThrow(CoderAPIError);
		});

		test("throws on 401 unauthorized", async () => {
			mockFetch.mockResolvedValue(
				createMockResponse(
					{ error: "Unauthorized" },
					{ ok: false, status: 401, statusText: "Unauthorized" },
				),
			);
			await expect(
				client.getCoderUserByGitHubId(mockUser.github_com_user_id ?? 0),
			).rejects.toThrow(CoderAPIError);
		});

		test("throws when GitHub user ID is 0", async () => {
			await expect(client.getCoderUserByGitHubId(0)).rejects.toThrow(
				"GitHub user ID cannot be 0",
			);
		});
	});

	describe("createChat", () => {
		test("creates chat successfully", async () => {
			mockFetch.mockResolvedValueOnce(createMockResponse(mockChat));
			const result = await client.createChat({
				content: [{ type: "text", text: "Test prompt" }],
			});
			expect(result.id).toBe(mockChat.id);
			expect(result.title).toBe(mockChat.title);
			expect(mockFetch).toHaveBeenNthCalledWith(
				1,
				"https://coder.test/api/experimental/chats",
				expect.objectContaining({
					method: "POST",
					headers: expect.objectContaining({
						"Coder-Session-Token": "test-token",
					}),
					body: JSON.stringify({
						content: [{ type: "text", text: "Test prompt" }],
					}),
				}),
			);
		});

		test("creates chat with workspace_id", async () => {
			mockFetch.mockResolvedValueOnce(createMockResponse(mockChat));
			const workspaceId = "550e8400-e29b-41d4-a716-446655440000";
			await client.createChat({
				content: [{ type: "text", text: "Test prompt" }],
				workspace_id: workspaceId,
			});
			const call = mockFetch.mock.calls[0];
			const body = JSON.parse(call[1].body);
			expect(body.workspace_id).toBe(workspaceId);
		});
	});

	describe("createChatMessage", () => {
		test("sends message successfully", async () => {
			mockFetch.mockResolvedValue(createMockResponse(mockChatMessageResponse));
			const result = await client.createChatMessage(mockChat.id, {
				content: [{ type: "text", text: "Follow-up" }],
			});
			expect(result.queued).toBe(false);
			expect(mockFetch).toHaveBeenCalledWith(
				`https://coder.test/api/experimental/chats/${mockChat.id}/messages`,
				expect.objectContaining({
					method: "POST",
					body: expect.stringContaining("Follow-up"),
				}),
			);
		});

		test("throws on 404", async () => {
			mockFetch.mockResolvedValue(
				createMockResponse(
					{ error: "Not Found" },
					{ ok: false, status: 404, statusText: "Not Found" },
				),
			);
			await expect(
				client.createChatMessage(mockChat.id, {
					content: [{ type: "text", text: "Test" }],
				}),
			).rejects.toThrow(CoderAPIError);
		});
	});

	describe("listChats", () => {
		test("returns chat list", async () => {
			mockFetch.mockResolvedValue(createMockResponse([mockChat]));
			const result = await client.listChats();
			expect(result).toHaveLength(1);
			expect(result[0].id).toBe(mockChat.id);
		});

		test("returns empty list", async () => {
			mockFetch.mockResolvedValue(createMockResponse([]));
			const result = await client.listChats();
			expect(result).toHaveLength(0);
		});
	});

	describe("getChat", () => {
		test("returns chat when found", async () => {
			mockFetch.mockResolvedValue(createMockResponse(mockChat));
			const result = await client.getChat(mockChat.id);
			expect(result.id).toBe(mockChat.id);
			expect(result.status).toBe(mockChat.status);
			expect(mockFetch).toHaveBeenCalledWith(
				`https://coder.test/api/experimental/chats/${mockChat.id}`,
				expect.objectContaining({
					headers: expect.objectContaining({
						"Coder-Session-Token": "test-token",
					}),
				}),
			);
		});
	});

	describe("getCoderUserByGitHubId edge cases", () => {
		test("throws when GitHub user ID is undefined", async () => {
			await expect(client.getCoderUserByGitHubId(undefined)).rejects.toThrow(
				"GitHub user ID cannot be undefined",
			);
		});
	});
});
