import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as path from "node:path";
import type { AgentSideConnection, SessionNotification } from "@agentclientprotocol/sdk";
import { AcpAgent, transcriptReplayContent } from "@gajae-code/coding-agent/modes/acp/acp-agent";
import { writeBrokerDiscovery } from "@gajae-code/coding-agent/sdk/broker/discovery";
import { TempDir } from "@gajae-code/utils";

const TOKEN = "acp-transcript-replay-token";

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

describe("ACP transcript replay degradation", () => {
	let tempDir: TempDir;
	let connectionAbort: AbortController;
	let server: Bun.Server<undefined> | undefined;
	let transcriptItems: unknown[] = [];
	let updates: SessionNotification[] = [];
	let agentDir = "";
	let cwd = "";

	beforeEach(async () => {
		tempDir = TempDir.createSync("@acp-transcript-replay-");
		connectionAbort = new AbortController();
		transcriptItems = [];
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
					socket.send(JSON.stringify({ type: "hello", connectionId: "acp-transcript-replay" }));
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
		if (port === undefined) throw new Error("Expected ACP fixture server port");
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

	/** Creates a session, drains its bootstrap updates, then replays it through `session/load`. */
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
		const created = await bounded(acp.newSession({ cwd, mcpServers: [] }), "new session");
		await waitFor(
			() =>
				updates.some(update => update.update.sessionUpdate === "available_commands_update") &&
				updates.some(update => updateMeta(update)?.gjcPhase === "idle"),
			"new session bootstrap",
		);
		updates.length = 0;
		await bounded(acp.loadSession({ sessionId: created.sessionId, cwd, mcpServers: [] }), "load session");
		return updates;
	}

	it("skips a transcript entry without a production body and reports the boundary", async () => {
		const replayed = await loadReplayedSession([
			{ id: "user-1", role: "user", textSummary: "Earlier request", body: "Earlier request" },
			{
				id: "user-2",
				role: "user",
				textSummary: "Body lost",
				content: [{ type: "text", text: "Never replayed" }],
			},
			{ id: "assistant-1", role: "assistant", textSummary: "Earlier response", body: "Earlier response" },
		]);

		expect(textChunks(replayed)).toEqual([
			{ sessionUpdate: "user_message_chunk", text: "Earlier request", messageId: "user-1" },
			{ sessionUpdate: "agent_message_chunk", text: "Earlier response", messageId: "assistant-1" },
		]);
		expect(JSON.stringify(replayed)).not.toContain("Never replayed");
		expect(skipBoundaries(replayed)).toEqual([{ count: 1, reason: "transcript_body_unavailable" }]);
	});

	it("loads a session whose transcript entries are all unreplayable and replays zero messages", async () => {
		const replayed = await loadReplayedSession([
			{ id: "user-1", role: "user", textSummary: "Body lost" },
			{ id: "assistant-1", role: "assistant", textSummary: "Body lost", body: null },
			{ id: "result-1", role: "toolResult", textSummary: "Body lost", toolCallId: "tool-1", toolName: "read" },
		]);

		expect(textChunks(replayed)).toEqual([]);
		expect(replayKinds(replayed)).toEqual(["session_info_update"]);
		expect(skipBoundaries(replayed)).toEqual([{ count: 3, reason: "transcript_body_unavailable" }]);
	});

	it("replays a healthy transcript unchanged and reports no skip boundary", async () => {
		const replayed = await loadReplayedSession([
			{ id: "user-1", role: "user", textSummary: "Earlier request", body: "Earlier request" },
			{
				id: "assistant-1",
				role: "assistant",
				textSummary: "Earlier response",
				body: "Earlier thought\nEarlier response",
				content: [
					{ type: "thinking", thinking: "Earlier thought" },
					{ type: "text", text: "Earlier response" },
					{ type: "toolCall", id: "replay-tool-1", name: "read", arguments: { path: "missing.ts" } },
				],
			},
			{
				id: "result-1",
				role: "toolResult",
				textSummary: "File not found",
				body: "File not found",
				content: [{ type: "text", text: "File not found" }],
				toolCallId: "replay-tool-1",
				toolName: "read",
				isError: true,
			},
		]);

		expect(replayKinds(replayed)).toEqual([
			"session_info_update",
			"user_message_chunk",
			"agent_thought_chunk",
			"agent_message_chunk",
			"tool_call",
			"tool_call_update",
		]);
		expect(textChunks(replayed)).toEqual([
			{ sessionUpdate: "user_message_chunk", text: "Earlier request", messageId: "user-1" },
			{ sessionUpdate: "agent_thought_chunk", text: "Earlier thought", messageId: "assistant-1" },
			{ sessionUpdate: "agent_message_chunk", text: "Earlier response", messageId: "assistant-1" },
		]);
		expect(updateMeta(replayed[0]!)).toEqual({
			gjcTranscriptImageReplay: { available: false, reason: "historical_transcript_images_unavailable" },
		});
		expect(skipBoundaries(replayed)).toEqual([]);
	});
});

describe("transcriptReplayContent", () => {
	it("signals an unavailable production body instead of throwing", () => {
		expect(transcriptReplayContent({ id: "user-1", role: "user", textSummary: "Body lost" })).toEqual({
			replayable: false,
			reason: "transcript_body_unavailable",
		});
	});

	it("keeps the replayable body contract for healthy entries", () => {
		expect(transcriptReplayContent({ id: "user-1", role: "user", body: "Earlier request" })).toEqual({
			replayable: true,
			content: {
				blocks: [{ type: "text", text: "Earlier request" }],
				images: { available: false, reason: "historical_transcript_images_unavailable" },
			},
		});
		expect(transcriptReplayContent({ id: "user-1", role: "user", body: "" })).toEqual({
			replayable: true,
			content: {
				blocks: [],
				images: { available: false, reason: "historical_transcript_images_unavailable" },
			},
		});
	});
});
