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

/** Tool calls the client is still showing as unfinished after replay returned. */
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

/** The tool call a terminal `tool_call_update` closes, when that is what the notification is. */
function terminalToolCallId(notification: SessionNotification): string | undefined {
	const update = notification.update as { sessionUpdate: string; toolCallId?: string; status?: string };
	if (update.sessionUpdate !== "tool_call_update") return undefined;
	if (update.status !== "completed" && update.status !== "failed") return undefined;
	return typeof update.toolCallId === "string" ? update.toolCallId : undefined;
}

describe("ACP transcript replay degradation", () => {
	let tempDir: TempDir;
	let connectionAbort: AbortController;
	let server: Bun.Server<undefined> | undefined;
	let transcriptItems: unknown[] = [];
	let transcriptSecondPageFailure: string | undefined;
	let updates: SessionNotification[] = [];
	/** Every update the agent handed the connection, including the ones the client rejected. */
	let attempted: SessionNotification[] = [];
	let loadRejection: unknown;
	let agentDir = "";
	let cwd = "";

	beforeEach(async () => {
		tempDir = TempDir.createSync("@acp-transcript-replay-");
		connectionAbort = new AbortController();
		transcriptItems = [];
		transcriptSecondPageFailure = undefined;
		updates = [];
		attempted = [];
		loadRejection = undefined;
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
						// A paged transcript whose second page fails: the first page replays, the
						// cursor promises more, and the follow-up query rejects.
						if (frame.query === "transcript.list" && transcriptSecondPageFailure !== undefined) {
							if (frame.cursor === undefined) {
								socket.send(
									JSON.stringify({
										type: "query_response",
										id: frame.id,
										ok: true,
										result: {
											page: {
												items: transcriptItems,
												complete: false,
												continuationCursor: "transcript-page-2",
											},
										},
									}),
								);
								return;
							}
							socket.send(
								JSON.stringify({
									type: "query_response",
									id: frame.id,
									ok: false,
									error: { code: transcriptSecondPageFailure, message: transcriptSecondPageFailure },
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
	async function loadReplayedSession(
		items: unknown[],
		expectLoadRejection = false,
		rejectSessionUpdate?: (notification: SessionNotification) => boolean,
		onSessionUpdate?: (notification: SessionNotification, agent: AcpAgent) => Promise<void>,
	): Promise<SessionNotification[]> {
		transcriptItems = items;
		let agent: AcpAgent | undefined;
		const connection = {
			sessionUpdate: async (notification: SessionNotification) => {
				attempted.push(notification);
				// A client that refuses one frame never saw it, so it must not count as delivered.
				if (rejectSessionUpdate?.(notification)) throw new Error("client rejected session update");
				updates.push(notification);
				if (agent) await onSessionUpdate?.(notification, agent);
			},
			signal: connectionAbort.signal,
			closed: Promise.withResolvers<void>().promise,
		} as unknown as AgentSideConnection;
		const acp = new AcpAgent(connection, { agentDir });
		agent = acp;
		const created = await bounded(acp.newSession({ cwd, mcpServers: [] }), "new session");
		await waitFor(
			() =>
				updates.some(update => update.update.sessionUpdate === "available_commands_update") &&
				updates.some(update => updateMeta(update)?.gjcPhase === "idle"),
			"new session bootstrap",
		);
		updates.length = 0;
		attempted.length = 0;
		const load = bounded(acp.loadSession({ sessionId: created.sessionId, cwd, mcpServers: [] }), "load session");
		if (expectLoadRejection)
			loadRejection = await load.then(
				() => {
					throw new Error("Expected session/load to reject");
				},
				(error: unknown) => error,
			);
		else await load;
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

	// A `tool_call` start is published before its result is read, so every path that
	// passes over the matching `toolResult` owes the client an end event: a skipped
	// row otherwise leaves the call at `pending` for the life of the session (#4063).
	it("names a replayed tool result from its start when the result row lost the name", async () => {
		const replayed = await loadReplayedSession([
			{
				id: "assistant-1",
				role: "assistant",
				textSummary: "Reading",
				body: "Reading",
				content: [{ type: "toolCall", id: "tool-1", name: "read", arguments: { path: "missing.ts" } }],
			},
			{
				id: "result-1",
				role: "toolResult",
				textSummary: "File not found",
				body: "File not found",
				content: [{ type: "text", text: "File not found" }],
				toolCallId: "tool-1",
				toolName: "",
			},
		]);

		expect(toolCallStates(replayed)).toEqual(["tool_call:tool-1:pending", "tool_call_update:tool-1:completed"]);
		expect(pendingToolCalls(replayed)).toEqual([]);
		expect(skipBoundaries(replayed)).toEqual([]);
	});

	it("fails a replayed tool call that no transcript field can name", async () => {
		const replayed = await loadReplayedSession([
			{
				id: "assistant-1",
				role: "assistant",
				textSummary: "Reading",
				body: "Reading",
				content: [{ type: "toolCall", id: "tool-1", name: "", arguments: {} }],
			},
			{
				id: "result-1",
				role: "toolResult",
				textSummary: "File not found",
				body: "File not found",
				content: [{ type: "text", text: "File not found" }],
				toolCallId: "tool-1",
			},
		]);

		expect(toolCallStates(replayed)).toEqual(["tool_call:tool-1:pending", "tool_call_update:tool-1:failed"]);
		expect(pendingToolCalls(replayed)).toEqual([]);
		expect(JSON.stringify(replayed)).toContain("could not be replayed");
		expect(skipBoundaries(replayed)).toEqual([{ count: 1, reason: "transcript_tool_call_unavailable" }]);
	});

	it("fails a replayed tool call the transcript never resolved", async () => {
		const replayed = await loadReplayedSession([
			{
				id: "assistant-1",
				role: "assistant",
				textSummary: "Reading",
				body: "Reading",
				content: [{ type: "toolCall", id: "tool-1", name: "read", arguments: { path: "missing.ts" } }],
			},
		]);

		expect(toolCallStates(replayed)).toEqual(["tool_call:tool-1:pending", "tool_call_update:tool-1:failed"]);
		expect(pendingToolCalls(replayed)).toEqual([]);
		expect(JSON.stringify(replayed)).toContain("without a result for this tool call");
		expect(skipBoundaries(replayed)).toEqual([{ count: 1, reason: "transcript_tool_call_unavailable" }]);
	});

	it("drops a tool result whose call was never published without stranding one", async () => {
		const replayed = await loadReplayedSession([
			{ id: "user-1", role: "user", textSummary: "Earlier request", body: "Earlier request" },
			{
				id: "result-1",
				role: "toolResult",
				textSummary: "File not found",
				body: "File not found",
				content: [{ type: "text", text: "File not found" }],
				toolCallId: "ghost-tool",
			},
		]);

		expect(toolCallStates(replayed)).toEqual([]);
		expect(pendingToolCalls(replayed)).toEqual([]);
		expect(skipBoundaries(replayed)).toEqual([{ count: 1, reason: "transcript_tool_call_unavailable" }]);
	});

	// A start the transcript never resolved is closed as unresolved; a start the replay
	// itself abandoned mid-page is a different failure and must read differently (#4063).
	it("closes published tool calls when a later transcript page throws", async () => {
		transcriptSecondPageFailure = "unavailable";
		const replayed = await loadReplayedSession(
			[
				{
					id: "assistant-1",
					role: "assistant",
					textSummary: "Reading",
					body: "Reading",
					content: [{ type: "toolCall", id: "tool-1", name: "read", arguments: { path: "missing.ts" } }],
				},
			],
			true,
		);

		expect(toolCallStates(replayed)).toEqual(["tool_call:tool-1:pending", "tool_call_update:tool-1:failed"]);
		expect(pendingToolCalls(replayed)).toEqual([]);
		expect(JSON.stringify(replayed)).toContain("Transcript replay stopped before this tool call reached a result.");
		expect(JSON.stringify(replayed)).not.toContain("without a result for this tool call");
		expect(skipBoundaries(replayed)).toEqual([]);
	});

	// The cleanup itself can fail. Publishing tool-1's terminal update used to tear the
	// session record down, after which every later cleanup publication was a silent no-op:
	// tool-2 stayed pending and nothing said so (#4063).
	it("closes the calls behind a failing cleanup publication and reports the ones it could not close", async () => {
		transcriptSecondPageFailure = "unavailable";
		const replayed = await loadReplayedSession(
			[
				{
					id: "assistant-1",
					role: "assistant",
					textSummary: "Reading",
					body: "Reading",
					content: [
						{ type: "toolCall", id: "tool-1", name: "read", arguments: { path: "missing.ts" } },
						{ type: "toolCall", id: "tool-2", name: "read", arguments: { path: "other.ts" } },
					],
				},
			],
			true,
			notification => terminalToolCallId(notification) === "tool-1",
		);

		// Every open call is attempted, not only the ones ahead of the first failure.
		expect(attempted.map(terminalToolCallId).filter(id => id !== undefined)).toEqual(["tool-1", "tool-2"]);
		// tool-2 queued behind the failure still reaches a terminal status on the client.
		expect(toolCallStates(replayed)).toEqual([
			"tool_call:tool-1:pending",
			"tool_call:tool-2:pending",
			"tool_call_update:tool-2:failed",
		]);
		// tool-1's terminal frame was refused by the client, so it cannot be closed — and every
		// call left pending is named by the failure `session/load` reports.
		expect(pendingToolCalls(replayed)).toEqual(["tool-1"]);
		const reported = String((loadRejection as Error).message);
		expect(reported).toContain("ACP transcript replay could not close published tool calls: tool-1");
		expect(reported).not.toContain("tool-2");
		for (const toolCallId of pendingToolCalls(replayed)) expect(reported).toContain(toolCallId);
	});

	// A refused close must not take the session record down before the calls behind it have
	// been attempted: the cleanup used to publish through `#publishSessionUpdate`, which fails
	// the session on the first rejected frame and left every later close a silent no-op (#4063).
	it("closes the calls behind a refused mid-replay close and names the one it could not close", async () => {
		const replayed = await loadReplayedSession(
			[
				{
					id: "assistant-1",
					role: "assistant",
					textSummary: "Reading",
					body: "Reading",
					content: [
						{ type: "toolCall", id: "tool-1", name: "read", arguments: {} },
						{ type: "toolCall", id: "tool-2", name: "read", arguments: {} },
					],
				},
				{ id: "toolresult-1", role: "toolResult", toolCallId: "tool-1", textSummary: "Body lost" },
			],
			true,
			notification => terminalToolCallId(notification) === "tool-1",
		);

		// Every published start is attempted, not only the ones ahead of the refused close.
		expect([...new Set(attempted.map(terminalToolCallId).filter(id => id !== undefined))]).toEqual([
			"tool-1",
			"tool-2",
		]);
		// tool-2 queued behind the refusal still reaches a terminal status on the client.
		expect(toolCallStates(replayed)).toEqual([
			"tool_call:tool-1:pending",
			"tool_call:tool-2:pending",
			"tool_call_update:tool-2:failed",
		]);
		// tool-1 stayed in `replayTools` because its close was never accepted, so the failure
		// `session/load` reports names it instead of dropping it on the attempt.
		expect(pendingToolCalls(replayed)).toEqual(["tool-1"]);
		const reported = String((loadRejection as Error).message);
		expect(reported).toContain("ACP transcript replay could not close published tool calls: tool-1");
		for (const toolCallId of pendingToolCalls(replayed)) expect(reported).toContain(toolCallId);
		expect(skipBoundaries(replayed)).toEqual([{ count: 3, reason: "transcript_body_unavailable" }]);
	});

	// Same invariant on the other mid-replay close: a result row that can be read but names
	// nothing, whose start is equally nameless (#4063).
	it("closes the calls behind a refused close of an unnameable tool call and names it", async () => {
		const replayed = await loadReplayedSession(
			[
				{
					id: "assistant-1",
					role: "assistant",
					textSummary: "Reading",
					body: "Reading",
					content: [
						{ type: "toolCall", id: "tool-1", name: "", arguments: {} },
						{ type: "toolCall", id: "tool-2", name: "read", arguments: {} },
					],
				},
				{ id: "toolresult-1", role: "toolResult", toolCallId: "tool-1", textSummary: "done", body: "done" },
			],
			true,
			notification => terminalToolCallId(notification) === "tool-1",
		);

		expect([...new Set(attempted.map(terminalToolCallId).filter(id => id !== undefined))]).toEqual([
			"tool-1",
			"tool-2",
		]);
		expect(toolCallStates(replayed)).toEqual([
			"tool_call:tool-1:pending",
			"tool_call:tool-2:pending",
			"tool_call_update:tool-2:failed",
		]);
		expect(pendingToolCalls(replayed)).toEqual(["tool-1"]);
		const reported = String((loadRejection as Error).message);
		expect(reported).toContain("ACP transcript replay could not close published tool calls: tool-1");
		for (const toolCallId of pendingToolCalls(replayed)) expect(reported).toContain(toolCallId);
		expect(skipBoundaries(replayed)).toEqual([{ count: 3, reason: "transcript_tool_call_unavailable" }]);
	});

	// `session/close` lands after the start but before an unreplayable result can close it.
	// The direct cleanup path must still honor the session boundary even though it bypasses
	// normal publication failure handling so one refused close cannot silence later calls.
	it("publishes no terminal for an unreplayable result after the session closes", async () => {
		const replayed = await loadReplayedSession(
			[
				{
					id: "assistant-1",
					role: "assistant",
					textSummary: "Reading",
					body: "Reading",
					content: [{ type: "toolCall", id: "tool-race", name: "read", arguments: { path: "missing.ts" } }],
				},
				{
					id: "result-1",
					role: "toolResult",
					textSummary: "Body lost",
					toolCallId: "tool-race",
					toolName: "read",
				},
			],
			true,
			undefined,
			async (notification, agent) => {
				const update = notification.update as { sessionUpdate: string; toolCallId?: string };
				if (update.sessionUpdate !== "tool_call" || update.toolCallId !== "tool-race") return;
				await agent.closeSession({ sessionId: notification.sessionId });
			},
		);

		expect(toolCallStates(replayed)).toEqual(["tool_call:tool-race:pending"]);
		expect(attempted.map(terminalToolCallId).filter(id => id !== undefined)).toEqual([]);
		expect(skipBoundaries(replayed)).toEqual([]);
		const reported = String((loadRejection as Error).message);
		expect(reported).toContain("Unknown session, not found");
		expect(reported).not.toContain("tool-race");
	});

	// `session/close` can also land between entries in the final cleanup pass. The first
	// terminal is already delivered, but the pass must re-check session ownership before
	// publishing the next while still continuing after ordinary publication failures.
	it("stops final cleanup when the session closes between tool calls", async () => {
		const replayed = await loadReplayedSession(
			[
				{
					id: "assistant-1",
					role: "assistant",
					textSummary: "Reading",
					body: "Reading",
					content: [
						{ type: "toolCall", id: "tool-before-close", name: "read", arguments: { path: "missing.ts" } },
						{ type: "toolCall", id: "tool-after-close", name: "read", arguments: { path: "other.ts" } },
					],
				},
			],
			true,
			undefined,
			async (notification, agent) => {
				if (terminalToolCallId(notification) !== "tool-before-close") return;
				await agent.closeSession({ sessionId: notification.sessionId });
			},
		);

		expect(attempted.map(terminalToolCallId).filter(id => id !== undefined)).toEqual(["tool-before-close"]);
		expect(toolCallStates(replayed)).toEqual([
			"tool_call:tool-before-close:pending",
			"tool_call:tool-after-close:pending",
			"tool_call_update:tool-before-close:failed",
		]);
		expect(pendingToolCalls(replayed)).toEqual(["tool-after-close"]);
		const reported = String((loadRejection as Error).message);
		expect(reported).toContain("Unknown session, not found");
		expect(reported).not.toContain("tool-after-close");
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
