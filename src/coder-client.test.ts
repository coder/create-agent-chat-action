import { describe, expect, test, beforeEach, mock } from "bun:test";
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

	beforeEach(() => {
		const mockInputs = createMockInputs();
		client = new RealCoderClient(mockInputs.coderURL, mockInputs.coderToken);
		mockFetch = mock(() => Promise.resolve(createMockResponse([])));
		global.fetch = mockFetch as unknown as typeof fetch;
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
			expect(
				client.getCoderUserByGitHubId(mockUser.github_com_user_id ?? 0),
			).rejects.toThrow(CoderAPIError);
		});

		test("throws when no user found", async () => {
			mockFetch.mockResolvedValue(createMockResponse(mockUserListEmpty));
			expect(
				client.getCoderUserByGitHubId(mockUser.github_com_user_id ?? 0),
			).rejects.toThrow(CoderAPIError);
		});

		test("sends status:active filter in the query string", async () => {
			mockFetch.mockResolvedValue(createMockResponse(mockUserList));
			await client.getCoderUserByGitHubId(mockUser.github_com_user_id ?? 0);
			const calledUrl = mockFetch.mock.calls[0]?.[0] as string;
			const rawQuery = decodeURIComponent(calledUrl.split("?q=")[1] ?? "");
			expect(rawQuery).toContain(`github_com_user_id:${mockUser.github_com_user_id}`);
			expect(rawQuery).toContain("status:active");
		});

		test("returns the live user when a soft-deleted user shares the github id", async () => {
			const liveUser = { ...mockUser };
			const deletedUser = {
				...mockUser,
				id: "770e8400-e29b-41d4-a716-446655440002",
				username: "olddeleteduser",
				deleted: true,
			};
			mockFetch.mockResolvedValue(
				createMockResponse({ users: [deletedUser, liveUser] }),
			);
			const result = await client.getCoderUserByGitHubId(
				mockUser.github_com_user_id ?? 0,
			);
			expect(result.id).toBe(liveUser.id);
			expect(result.username).toBe(liveUser.username);
		});

		test("errors with user_ambiguous kind when two live users share the github id", async () => {
			mockFetch.mockResolvedValue(createMockResponse(mockUserListDuplicate));
			let caught: unknown;
			try {
				await client.getCoderUserByGitHubId(mockUser.github_com_user_id ?? 0);
			} catch (err) {
				caught = err;
			}
			expect(caught).toBeInstanceOf(CoderAPIError);
			expect((caught as CoderAPIError).kind).toBe("user_ambiguous");
		});

		test("errors with user_not_found kind when all matching users are soft-deleted", async () => {
			const deletedUser = {
				...mockUser,
				id: "770e8400-e29b-41d4-a716-446655440003",
				username: "olddeleteduser",
				deleted: true,
			};
			mockFetch.mockResolvedValue(createMockResponse({ users: [deletedUser] }));
			let caught: unknown;
			try {
				await client.getCoderUserByGitHubId(mockUser.github_com_user_id ?? 0);
			} catch (err) {
				caught = err;
			}
			expect(caught).toBeInstanceOf(CoderAPIError);
			expect((caught as CoderAPIError).kind).toBe("user_not_found");
		});

		test("errors with user_not_found kind when the response is empty", async () => {
			mockFetch.mockResolvedValue(createMockResponse(mockUserListEmpty));
			let caught: unknown;
			try {
				await client.getCoderUserByGitHubId(mockUser.github_com_user_id ?? 0);
			} catch (err) {
				caught = err;
			}
			expect(caught).toBeInstanceOf(CoderAPIError);
			expect((caught as CoderAPIError).kind).toBe("user_not_found");
		});

		test("throws on 401 unauthorized", async () => {
			mockFetch.mockResolvedValue(
				createMockResponse(
					{ error: "Unauthorized" },
					{ ok: false, status: 401, statusText: "Unauthorized" },
				),
			);
			expect(
				client.getCoderUserByGitHubId(mockUser.github_com_user_id ?? 0),
			).rejects.toThrow(CoderAPIError);
		});

		test("throws when GitHub user ID is 0", async () => {
			expect(client.getCoderUserByGitHubId(0)).rejects.toThrow(
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
			expect(
				client.createChatMessage(mockChat.id, {
					content: [{ type: "text", text: "Test" }],
				}),
			).rejects.toThrow(CoderAPIError);
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
});
