import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as path from "node:path";
import type { AgentSideConnection, SessionNotification } from "@agentclientprotocol/sdk";
import { AcpAgent } from "@gajae-code/coding-agent/modes/acp/acp-agent";
import { writeBrokerDiscovery } from "@gajae-code/coding-agent/sdk/broker/discovery";
import { TempDir } from "@gajae-code/utils";

const TOKEN = "acp-transcript-continuation-token";
/** Small enough that every fixture body needs several `resource.body` pages. */
const CONTINUATION_PAGE_CHARS = 8;

async function bounded<T>(promise: Promise<T>, label: string): Promise<T> {
	return await Promise.race([
		promise,
		Bun.sleep(5_000).then(() => {
			throw new Error(`Timed out waiting for ${label}`);
		}),
	]);
}

async function waitFor(predicate: () => boolean, label: string): Promise<void> {
	const deadline = Date.now() + 5_000;
	while (Date.now() < deadline) {
		if (predicate()) return;
		await Bun.sleep(5);
	}
	throw new Error(`Timed out waiting for ${label}`);
}

function updateMeta(notification: SessionNotification): Record<string, unknown> | undefined {
	const meta = (notification.update as { _meta?: unknown })._meta;
	return typeof meta === "object" && meta !== null ? (meta as Record<string, unknown>) : undefined;
}

function skipBoundaries(notifications: SessionNotification[]): unknown[] {
	return notifications
		.map(notification => updateMeta(notification)?.gjcTranscriptReplaySkipped)
		.filter(value => value !== undefined);
}

function replayKinds(notifications: SessionNotification[]): string[] {
	return notifications.map(notification => notification.update.sessionUpdate);
}

function textChunks(notifications: SessionNotification[]): Array<Record<string, unknown>> {
	const chunks: Array<Record<string, unknown>> = [];
	for (const notification of notifications) {
		const update = notification.update as {
			sessionUpdate: string;
			content?: { type?: string; text?: string };
			messageId?: string;
		};
		if (
			update.sessionUpdate !== "user_message_chunk" &&
			update.sessionUpdate !== "agent_message_chunk" &&
			update.sessionUpdate !== "agent_thought_chunk"
		)
			continue;
		chunks.push({
			sessionUpdate: update.sessionUpdate,
			text: update.content?.text,
			...(update.messageId === undefined ? {} : { messageId: update.messageId }),
		});
	}
	return chunks;
}

/** Every tool-call lifecycle update the client saw, in order, as `id:status`. */
function toolCallStates(notifications: SessionNotification[]): string[] {
	const states: string[] = [];
	for (const notification of notifications) {
		const update = notification.update as { sessionUpdate: string; toolCallId?: string; status?: string };
		if (update.sessionUpdate !== "tool_call" && update.sessionUpdate !== "tool_call_update") continue;
		states.push(`${update.sessionUpdate}:${update.toolCallId}:${update.status}`);
	}
	return states;
}

/** Tool call ids the client was told about but never given a terminal state for. */
function pendingToolCalls(notifications: SessionNotification[]): string[] {
	const status = new Map<string, string>();
	for (const notification of notifications) {
		const update = notification.update as { sessionUpdate: string; toolCallId?: string; status?: string };
		if (update.sessionUpdate !== "tool_call" && update.sessionUpdate !== "tool_call_update") continue;
		if (typeof update.toolCallId !== "string") continue;
		status.set(update.toolCallId, String(update.status));
	}
	return [...status].filter(([, value]) => value !== "completed" && value !== "failed").map(([id]) => id);
}

/** Builds the body-less `item_too_large` row `transcript.list` publishes for an oversized entry. */
function oversizedRow(itemId: string, fields: string[]): Record<string, unknown> {
	return {
		id: itemId,
		error: { code: "item_too_large" },
		continuations: fields.map(field => ({
			query: "Q23",
			resourceKind: "transcript",
			resourceId: "default",
			revision: "rev-1",
			itemId,
			field,
		})),
	};
}

describe("ACP transcript replay continuation recovery", () => {
	let tempDir: TempDir;
	let connectionAbort: AbortController;
	let server: Bun.Server<undefined> | undefined;
	let transcriptItems: unknown[] = [];
	/** `${itemId}:${field}` -> full field value the host would serve over `resource.body`. */
	let continuationFields = new Map<string, string>();
	let continuationFailure: string | undefined;
	let continuationFailureField: string | undefined;
	let resourceBodyQueries: Array<Record<string, unknown>> = [];
	let updates: SessionNotification[] = [];
	let agentDir = "";
	let cwd = "";

	beforeEach(async () => {
		tempDir = TempDir.createSync("@acp-transcript-continuation-");
		connectionAbort = new AbortController();
		transcriptItems = [];
		continuationFields = new Map();
		continuationFailure = undefined;
		continuationFailureField = undefined;
		resourceBodyQueries = [];
		updates = [];
		agentDir = path.join(tempDir.path(), "agent");
		cwd = path.join(tempDir.path(), "workspace");
		server = Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			fetch(request, server) {
				if (new URL(request.url).searchParams.get("token") !== TOKEN)
					return new Response("Unauthorized", { status: 401 });
				if (!server.upgrade(request)) return new Response("Upgrade failed", { status: 400 });
			},
			websocket: {
				open(socket) {
					socket.send(JSON.stringify({ type: "hello", connectionId: "acp-transcript-continuation" }));
				},
				message(socket, raw) {
					const frame = JSON.parse(String(raw)) as Record<string, unknown>;
					if (frame.type === "register_provider") {
						socket.send(
							JSON.stringify({ type: "register_provider_result", id: frame.id, ok: true, leaseId: "lease" }),
						);
						return;
					}
					if (frame.type === "broker_request") {
						const result =
							frame.operation === "session.create"
								? {
										sessionId: "replay-session",
										endpoint: { url: `ws://127.0.0.1:${server!.port}`, token: TOKEN },
									}
								: {};
						socket.send(JSON.stringify({ type: "broker_response", id: frame.id, ok: true, result }));
						return;
					}
					if (frame.type === "query_request") {
						if (frame.query === "runtime.capabilities") {
							socket.send(
								JSON.stringify({
									type: "query_response",
									id: frame.id,
									ok: true,
									result: { promptTerminalOutcomeVersion: 1 },
								}),
							);
							return;
						}
						if (frame.query === "Q23" || frame.query === "resource.body") {
							const input = (frame.input ?? {}) as Record<string, unknown>;
							resourceBodyQueries.push({
								...input,
								...(frame.cursor === undefined ? {} : { cursor: frame.cursor }),
							});
							if (
								continuationFailure !== undefined ||
								(continuationFailureField !== undefined &&
									(frame.input as Record<string, unknown> | undefined)?.field === continuationFailureField)
							) {
								socket.send(
									JSON.stringify({
										type: "query_response",
										id: frame.id,
										ok: false,
										error: { code: continuationFailure, message: continuationFailure },
									}),
								);
								return;
							}
							// The cursor carries the selector forward exactly like the real host does.
							const cursor = typeof frame.cursor === "string" ? frame.cursor.split("|") : undefined;
							const itemId = cursor ? String(cursor[0]) : String(input.itemId);
							const field = cursor ? String(cursor[1]) : String(input.field);
							const offset = cursor ? Number(cursor[2]) : 0;
							const key = `${itemId}:${field}`;
							const value = continuationFields.get(key);
							if (value === undefined) {
								socket.send(
									JSON.stringify({
										type: "query_response",
										id: frame.id,
										ok: false,
										error: { code: "resource_gone", message: "resource_gone" },
									}),
								);
								return;
							}
							const body = value.slice(offset, offset + CONTINUATION_PAGE_CHARS);
							const end = offset + body.length;
							const complete = end >= value.length;
							socket.send(
								JSON.stringify({
									type: "query_response",
									id: frame.id,
									ok: true,
									result: {
										page: {
											items: [{ itemId, field, byteOffset: offset, body, complete }],
											complete,
											...(complete ? {} : { continuationCursor: `${itemId}|${field}|${end}` }),
										},
									},
								}),
							);
							return;
						}
						const items =
							frame.query === "config.list/get"
								? [{ mode: "default", model: "openai/gpt", thinking: "medium" }]
								: frame.query === "models.list/current"
									? [{ provider: "openai", id: "gpt", name: "GPT" }]
									: frame.query === "providers.list/active"
										? [{ provider: "openai", connectionKind: "credential" }]
										: frame.query === "transcript.list"
											? transcriptItems
											: [];
						const result =
							frame.query === "context.get"
								? { usage: { tokens: 0, contextWindow: 200_000, percent: 0, source: "test" } }
								: { page: { items, complete: true } };
						socket.send(JSON.stringify({ type: "query_response", id: frame.id, ok: true, result }));
						return;
					}
					if (frame.type !== "control_request") return;
					socket.send(JSON.stringify({ type: "control_response", id: frame.id, ok: true, result: {} }));
				},
			},
		});
		const port = server.port;
		if (port === undefined) throw new Error("Expected the ACP fixture server to expose a port");
		await writeBrokerDiscovery(agentDir, {
			version: 1,
			protocolVersion: 3,
			packageGeneration: "test",
			ownerId: "test-owner",
			pid: process.pid,
			host: "127.0.0.1",
			port,
			url: `ws://127.0.0.1:${port}`,
			token: TOKEN,
			startedAt: Date.now(),
			heartbeatAt: Date.now(),
		});
	});

	afterEach(() => {
		connectionAbort.abort();
		server?.stop(true);
		tempDir.removeSync();
	});

	async function loadReplayedSession(items: unknown[]): Promise<SessionNotification[]> {
		transcriptItems = items;
		const connection = {
			sessionUpdate: async (notification: SessionNotification) => {
				updates.push(notification);
			},
			signal: connectionAbort.signal,
			closed: Promise.withResolvers<void>().promise,
		} as unknown as AgentSideConnection;
		const acp = new AcpAgent(connection, { agentDir });
		const created = await bounded(acp.newSession({ cwd, mcpServers: [] }), "a new session");
		await waitFor(
			() =>
				updates.some(update => update.update.sessionUpdate === "available_commands_update") &&
				updates.some(update => updateMeta(update)?.gjcPhase === "idle"),
			"the new session bootstrap",
		);
		updates.length = 0;
		resourceBodyQueries.length = 0;
		await bounded(acp.loadSession({ sessionId: created.sessionId, cwd, mcpServers: [] }), "the loaded session");
		return updates;
	}

	it("recovers an oversized entry through its continuations instead of skipping it", async () => {
		const oversizedBody = "Oversized assistant answer that spans several continuation pages.";
		continuationFields.set("assistant-big:role", "assistant");
		continuationFields.set("assistant-big:body", oversizedBody);
		const replayed = await loadReplayedSession([
			{ id: "user-1", role: "user", textSummary: "Earlier request", body: "Earlier request" },
			oversizedRow("assistant-big", ["id", "role", "textSummary", "body"]),
			{ id: "user-2", role: "user", textSummary: "Follow-up", body: "Follow-up" },
		]);

		expect(textChunks(replayed)).toEqual([
			{ sessionUpdate: "user_message_chunk", text: "Earlier request", messageId: "user-1" },
			{ sessionUpdate: "agent_message_chunk", text: oversizedBody, messageId: "assistant-big" },
			{ sessionUpdate: "user_message_chunk", text: "Follow-up", messageId: "user-2" },
		]);
		expect(skipBoundaries(replayed)).toEqual([]);
		// Only the fields replay consumes are read, and the body is paged to completion.
		expect(resourceBodyQueries.filter(query => query.field !== undefined).map(query => query.field)).toEqual([
			"role",
			"body",
		]);
		const expectedPages =
			Math.ceil("assistant".length / CONTINUATION_PAGE_CHARS) +
			Math.ceil(oversizedBody.length / CONTINUATION_PAGE_CHARS);
		expect(expectedPages).toBeGreaterThan(2);
		expect(resourceBodyQueries.length).toBe(expectedPages);
	});

	it("recovers an oversized tool result and pairs it with its tool call", async () => {
		continuationFields.set("result-big:role", "toolResult");
		continuationFields.set("result-big:body", "Oversized tool output");
		continuationFields.set("result-big:toolCallId", "tool-1");
		continuationFields.set("result-big:toolName", "read");
		continuationFields.set("result-big:isError", "false");
		const replayed = await loadReplayedSession([
			{
				id: "assistant-1",
				role: "assistant",
				textSummary: "Reading",
				body: "Reading",
				content: [{ type: "toolCall", id: "tool-1", name: "read", arguments: { file_path: "big.ts" } }],
			},
			oversizedRow("result-big", ["id", "role", "body", "toolCallId", "toolName", "isError"]),
		]);

		expect(toolCallStates(replayed)).toEqual(["tool_call:tool-1:pending", "tool_call_update:tool-1:completed"]);
		expect(pendingToolCalls(replayed)).toEqual([]);
		expect(JSON.stringify(replayed)).toContain("Oversized tool output");
		expect(skipBoundaries(replayed)).toEqual([]);
	});

	it("reports and skips an entry that has neither a body nor a usable continuation", async () => {
		const replayed = await loadReplayedSession([
			{ id: "user-1", role: "user", textSummary: "Earlier request", body: "Earlier request" },
			{ id: "lost-1", error: { code: "item_too_large" }, continuations: [] },
			{ id: "assistant-1", role: "assistant", textSummary: "Earlier response", body: "Earlier response" },
		]);

		expect(textChunks(replayed)).toEqual([
			{ sessionUpdate: "user_message_chunk", text: "Earlier request", messageId: "user-1" },
			{ sessionUpdate: "agent_message_chunk", text: "Earlier response", messageId: "assistant-1" },
		]);
		expect(skipBoundaries(replayed)).toEqual([{ count: 1, reason: "transcript_body_unavailable" }]);
	});

	it("reports and skips an entry whose continuation cannot be read", async () => {
		continuationFailure = "resource_gone";
		const replayed = await loadReplayedSession([
			{ id: "user-1", role: "user", textSummary: "Earlier request", body: "Earlier request" },
			oversizedRow("assistant-big", ["id", "role", "body"]),
		]);

		expect(textChunks(replayed)).toEqual([
			{ sessionUpdate: "user_message_chunk", text: "Earlier request", messageId: "user-1" },
		]);
		expect(skipBoundaries(replayed)).toEqual([{ count: 1, reason: "transcript_body_unavailable" }]);
	});

	it("drops the paired result when the entry owning its tool call was skipped", async () => {
		const replayed = await loadReplayedSession([
			{ id: "user-1", role: "user", textSummary: "Earlier request", body: "Earlier request" },
			{
				id: "assistant-1",
				role: "assistant",
				textSummary: "Body lost",
				content: [{ type: "toolCall", id: "tool-1", name: "read", arguments: { file_path: "missing.ts" } }],
			},
			{
				id: "result-1",
				role: "toolResult",
				textSummary: "File read",
				body: "File read",
				content: [{ type: "text", text: "File read" }],
				toolCallId: "tool-1",
				toolName: "read",
			},
		]);

		expect(toolCallStates(replayed)).toEqual([]);
		expect(pendingToolCalls(replayed)).toEqual([]);
		expect(JSON.stringify(replayed)).not.toContain("missing.ts");
		expect(skipBoundaries(replayed)).toEqual([{ count: 2, reason: "transcript_body_unavailable" }]);
	});

	it("closes a tool call whose result entry is unrecoverable so nothing stays pending", async () => {
		const replayed = await loadReplayedSession([
			{
				id: "assistant-1",
				role: "assistant",
				textSummary: "Reading",
				body: "Reading",
				content: [{ type: "toolCall", id: "tool-1", name: "read", arguments: { file_path: "big.ts" } }],
			},
			{ id: "result-1", role: "toolResult", textSummary: "Body lost", toolCallId: "tool-1", toolName: "read" },
		]);

		expect(toolCallStates(replayed)).toEqual(["tool_call:tool-1:pending", "tool_call_update:tool-1:failed"]);
		expect(pendingToolCalls(replayed)).toEqual([]);
		expect(JSON.stringify(replayed)).toContain("could not be replayed");
		expect(skipBoundaries(replayed)).toEqual([{ count: 1, reason: "transcript_body_unavailable" }]);
	});

	it("loads a session whose entries are all unrecoverable and replays zero messages", async () => {
		const replayed = await loadReplayedSession([
			{ id: "user-1", role: "user", textSummary: "Body lost" },
			oversizedRow("assistant-big", ["id", "role", "body"]),
			{ id: "result-1", role: "toolResult", textSummary: "Body lost", toolCallId: "tool-1", toolName: "read" },
		]);

		expect(textChunks(replayed)).toEqual([]);
		expect(toolCallStates(replayed)).toEqual([]);
		expect(replayKinds(replayed)).toEqual(["session_info_update"]);
		expect(skipBoundaries(replayed)).toEqual([{ count: 3, reason: "transcript_body_unavailable" }]);
	});

	it("replays a healthy transcript without reading any continuation", async () => {
		const replayed = await loadReplayedSession([
			{ id: "user-1", role: "user", textSummary: "Earlier request", body: "Earlier request" },
			{
				id: "assistant-1",
				role: "assistant",
				textSummary: "Earlier response",
				body: "Earlier response",
				content: [
					{ type: "text", text: "Earlier response" },
					{ type: "toolCall", id: "tool-1", name: "read", arguments: { file_path: "found.ts" } },
				],
			},
			{
				id: "result-1",
				role: "toolResult",
				textSummary: "File read",
				body: "File read",
				content: [{ type: "text", text: "File read" }],
				toolCallId: "tool-1",
				toolName: "read",
			},
		]);

		expect(replayKinds(replayed)).toEqual([
			"session_info_update",
			"user_message_chunk",
			"agent_message_chunk",
			"tool_call",
			"tool_call_update",
		]);
		expect(toolCallStates(replayed)).toEqual(["tool_call:tool-1:pending", "tool_call_update:tool-1:completed"]);
		expect(skipBoundaries(replayed)).toEqual([]);
		expect(resourceBodyQueries).toEqual([]);
	});
	it("recovers typed content when an oversized assistant entry owns a tool call", async () => {
		const toolCall = { type: "toolCall", id: "tool-1", name: "read", arguments: { file_path: "large.ts" } };
		continuationFields.set("assistant-big:role", "assistant");
		continuationFields.set("assistant-big:body", "Reading a very large file");
		continuationFields.set("assistant-big:content", JSON.stringify([toolCall]));
		const replayed = await loadReplayedSession([
			oversizedRow("assistant-big", ["id", "role", "body", "content"]),
			{
				id: "result-1",
				role: "toolResult",
				textSummary: "File read",
				body: "File read",
				content: [{ type: "text", text: "File read" }],
				toolCallId: "tool-1",
				toolName: "read",
			},
		]);

		expect(toolCallStates(replayed)).toEqual(["tool_call:tool-1:pending", "tool_call_update:tool-1:completed"]);
		expect(skipBoundaries(replayed)).toEqual([]);
	});

	it("preserves typed failure status for an oversized tool result", async () => {
		continuationFields.set("result-big:role", "toolResult");
		continuationFields.set("result-big:body", "Permission denied");
		continuationFields.set("result-big:toolCallId", "tool-1");
		continuationFields.set("result-big:toolName", "read");
		continuationFields.set("result-big:isError", "true");
		const replayed = await loadReplayedSession([
			{
				id: "assistant-1",
				role: "assistant",
				textSummary: "Reading",
				body: "Reading",
				content: [{ type: "toolCall", id: "tool-1", name: "read", arguments: { file_path: "secret.ts" } }],
			},
			oversizedRow("result-big", ["id", "role", "body", "toolCallId", "toolName", "isError"]),
		]);

		expect(toolCallStates(replayed)).toEqual(["tool_call:tool-1:pending", "tool_call_update:tool-1:failed"]);
		expect(skipBoundaries(replayed)).toEqual([]);
	});

	it("retains recovered tool identity when only the oversized result body fails", async () => {
		continuationFields.set("result-big:role", "toolResult");
		continuationFields.set("result-big:toolCallId", "tool-1");
		continuationFields.set("result-big:toolName", "read");
		continuationFields.set("result-big:isError", "false");
		continuationFailureField = "body";
		const replayed = await loadReplayedSession([
			{
				id: "assistant-1",
				role: "assistant",
				textSummary: "Reading",
				body: "Reading",
				content: [{ type: "toolCall", id: "tool-1", name: "read", arguments: { file_path: "big.ts" } }],
			},
			oversizedRow("result-big", ["id", "role", "body", "toolCallId", "toolName", "isError"]),
		]);

		expect(toolCallStates(replayed)).toEqual(["tool_call:tool-1:pending", "tool_call_update:tool-1:failed"]);
		expect(pendingToolCalls(replayed)).toEqual([]);
	});
	it("keeps a successful oversized tool result successful when the row advertises no isError", async () => {
		continuationFields.set("result-big:role", "toolResult");
		continuationFields.set("result-big:body", "Successful tool output");
		continuationFields.set("result-big:toolCallId", "tool-1");
		continuationFields.set("result-big:toolName", "read");
		const replayed = await loadReplayedSession([
			{
				id: "assistant-1",
				role: "assistant",
				textSummary: "Reading",
				body: "Reading",
				content: [{ type: "toolCall", id: "tool-1", name: "read", arguments: { file_path: "ok.ts" } }],
			},
			oversizedRow("result-big", ["id", "role", "body", "toolCallId", "toolName"]),
		]);

		expect(toolCallStates(replayed)).toEqual(["tool_call:tool-1:pending", "tool_call_update:tool-1:completed"]);
		expect(JSON.stringify(replayed)).toContain("Successful tool output");
		expect(skipBoundaries(replayed)).toEqual([]);
	});

	it("fails an oversized tool result whose advertised isError continuation cannot be read", async () => {
		continuationFields.set("result-big:role", "toolResult");
		continuationFields.set("result-big:body", "Tool output of unproven outcome");
		continuationFields.set("result-big:toolCallId", "tool-1");
		continuationFields.set("result-big:toolName", "read");
		continuationFields.set("result-big:isError", "false");
		continuationFailureField = "isError";
		const replayed = await loadReplayedSession([
			{
				id: "assistant-1",
				role: "assistant",
				textSummary: "Reading",
				body: "Reading",
				content: [{ type: "toolCall", id: "tool-1", name: "read", arguments: { file_path: "big.ts" } }],
			},
			oversizedRow("result-big", ["id", "role", "body", "toolCallId", "toolName", "isError"]),
		]);

		expect(toolCallStates(replayed)).toEqual(["tool_call:tool-1:pending", "tool_call_update:tool-1:failed"]);
		expect(pendingToolCalls(replayed)).toEqual([]);
	});
});
