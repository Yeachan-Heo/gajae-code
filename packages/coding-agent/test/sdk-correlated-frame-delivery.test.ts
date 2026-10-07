import { afterEach, expect, spyOn, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { NotificationServer } from "@gajae-code/natives";
import type { ExtensionActions, ExtensionAPI } from "../src/extensibility/extensions/types";
import { brokerOwnerForTest } from "../src/sdk/broker/ensure";
import { boundedCorrelatedAgentEndFrame, createNotificationsExtension } from "../src/sdk/bus";
import { RESPONSE_CEILING_BYTES } from "../src/sdk/host/query/handlers";

/**
 * Issue #4691: a broker-managed SDK prompt that outlives the process-local
 * submission TTL (PROMPT_SUBMISSION_TTL_MS = 5 min) must still publish exactly
 * one correlated terminal lifecycle event. Before the fix, terminalization
 * committed the durable outcome, then emitPromptLifecycle ran
 * cleanupPromptRecords first, which age-evicted the just-terminalized record,
 * so the positioned ring and the requester never saw `agent_end`.
 */

const dirs: string[] = [];
// Captured before any Date.now spy: waitFor deadlines must use the real clock
// even while the process clock is shifted past the submission TTL.
const realNow = Date.now.bind(Date);
const sockets: WebSocket[] = [];
const isolatedSdkHostTest = process.env.GJC_CI_SDK_HOST_ISOLATED === "1" ? test : test.skip;

afterEach(async () => {
	await Promise.all(sockets.splice(0).map(closeSocket));
	for (const dir of dirs) await brokerOwnerForTest(dir)?.stop();
	for (const dir of dirs.splice(0)) await fs.promises.rm(dir, { recursive: true, force: true });
});

async function closeSocket(socket: WebSocket): Promise<void> {
	if (socket.readyState === WebSocket.CLOSED) return;
	const { promise, resolve } = Promise.withResolvers<void>();
	socket.addEventListener("close", () => resolve(), { once: true });
	socket.close();
	await Promise.race([promise, Bun.sleep(500)]);
}

async function waitFor(predicate: () => boolean, label: string, timeoutMs = 10_000): Promise<void> {
	const deadline = realNow() + timeoutMs;
	while (!predicate()) {
		if (realNow() > deadline) throw new Error(`Timed out waiting for ${label}`);
		await Bun.sleep(20);
	}
}

function context(cwd: string, sessionId: string): Record<string, unknown> {
	return {
		cwd,
		sessionMetadata: { kind: "main", taskDepth: 0 },
		sessionManager: {
			getSessionId: () => sessionId,
			getCwd: () => cwd,
			getSessionName: () => "prompt terminal ttl",
			getUsageStatistics: () => ({ input: 1, output: 2, cacheRead: 0, cacheWrite: 0, premiumRequests: 0, cost: 0 }),
			getBranch: () => [],
		},
		getContextUsage: () => ({ tokens: 3, contextWindow: 100, percent: 3 }),
		model: { provider: "fixture-provider", id: "fixture-model" },
		getThinkingLevel: () => "low",
		getActivePromptHandle: () => undefined,
		getSystemPrompt: () => ["test"],
		isIdle: () => true,
		hasPendingMessages: () => false,
		getPendingMessageCounts: () => ({ steering: 0, followUp: 0, nextTurn: 0 }),
		resolveTool: () => undefined,
	};
}

function start(
	ctx: Record<string, unknown>,
	deliverUserMessage: ExtensionActions["sendUserMessage"] = () => undefined,
): Map<string, (event: unknown, context: unknown) => unknown> {
	const handlers = new Map<string, (event: unknown, context: unknown) => unknown>();
	const api = {
		on: (event: string, handler: (event: unknown, context: unknown) => unknown) => handlers.set(event, handler),
		registerCommand: () => {},
		getThinkingLevel: () => undefined,
		sendUserMessage: (
			content: Parameters<ExtensionActions["sendUserMessage"]>[0],
			options?: Parameters<ExtensionActions["sendUserMessage"]>[1],
		) => {
			const commit = options?.onPreflightAcceptCommit;
			const accepted = options?.onPreflightAccepted;
			const deliver = () => Promise.resolve(deliverUserMessage(content));
			if (commit)
				return Promise.resolve(commit()).then(() => {
					accepted?.();
					return deliver();
				});
			accepted?.();
			return deliver();
		},
	} as unknown as ExtensionAPI;
	createNotificationsExtension(api, undefined);
	void handlers.get("session_start")?.({ type: "session_start" }, ctx);
	return handlers;
}

async function connect(
	cwd: string,
	sessionId: string,
): Promise<{ socket: WebSocket; frames: Record<string, unknown>[] }> {
	const endpointFile = path.join(cwd, ".gjc", "state", "sdk", `${sessionId}.json`);
	await waitFor(() => fs.existsSync(endpointFile), "SDK endpoint");
	const endpoint = JSON.parse(fs.readFileSync(endpointFile, "utf8")) as { url: string; token: string };
	const frames: Record<string, unknown>[] = [];
	const socket = new WebSocket(`${endpoint.url}/?token=${encodeURIComponent(endpoint.token)}`);
	sockets.push(socket);
	socket.addEventListener("message", event => frames.push(JSON.parse(String(event.data))));
	await new Promise<void>((resolve, reject) => {
		socket.addEventListener("open", () => resolve(), { once: true });
		socket.addEventListener("error", () => reject(new Error("WS error")), { once: true });
	});
	return { socket, frames };
}

isolatedSdkHostTest("oversized correlated snapshots still reach a prompt terminal", async () => {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "gjc-sdk-oversized-prompt-"));
	dirs.push(cwd);
	const sessionId = `sdk-oversized-prompt-${Date.now()}`;
	const sessionContext = context(cwd, sessionId);
	const handlers = start(sessionContext, () => new Promise<never>(() => {}) as never);
	const { socket, frames } = await connect(cwd, sessionId);
	socket.send(
		JSON.stringify({
			type: "control_request",
			id: "oversized-prompt",
			operation: "turn.prompt",
			input: { text: "stream" },
		}),
	);
	await waitFor(
		() => frames.some(frame => frame.type === "control_response" && frame.id === "oversized-prompt"),
		"prompt acknowledgement",
	);
	const acknowledgement = frames.find(
		frame => frame.type === "control_response" && frame.id === "oversized-prompt",
	) as { result: { commandId: string; turnId: string } };
	const correlation = acknowledgement.result;
	await handlers.get("agent_start")?.({ type: "agent_start" }, sessionContext);
	const largeMessage = { role: "assistant", content: [{ type: "text", text: "x".repeat(RESPONSE_CEILING_BYTES) }] };
	const oversizedTextDelta = "text-😀".repeat(RESPONSE_CEILING_BYTES / 4);
	const oversizedThinkingDelta = "thinking-漢".repeat(RESPONSE_CEILING_BYTES / 4);
	await handlers.get("message_update")?.(
		{
			type: "message_update",
			message: largeMessage,
			assistantMessageEvent: { type: "text_delta", delta: oversizedTextDelta },
		},
		sessionContext,
	);
	await handlers.get("message_update")?.(
		{
			type: "message_update",
			message: largeMessage,
			assistantMessageEvent: { type: "thinking_delta", delta: oversizedThinkingDelta },
		},
		sessionContext,
	);
	await handlers.get("message_update")?.(
		{ type: "message_update", message: largeMessage, assistantMessageEvent: { type: "text_delta", delta: "x" } },
		sessionContext,
	);
	await handlers.get("message_update")?.(
		{
			type: "message_update",
			message: { role: "assistant", content: [] },
			assistantMessageEvent: { type: "text_delta", delta: "later" },
		},
		sessionContext,
	);
	await handlers.get("message_end")?.({ type: "message_end", message: largeMessage }, sessionContext);
	await handlers.get("agent_end")?.({ type: "agent_end", stopReason: "completed", messages: [] }, sessionContext);
	await waitFor(
		() =>
			frames.some(
				frame =>
					frame.type === "agent_end" &&
					frame.commandId === correlation.commandId &&
					frame.turnId === correlation.turnId,
			),
		"correlated terminal",
		2000,
	);
	expect(
		frames.some(
			frame =>
				frame.type === "event" &&
				frame.kind === "message_update" &&
				(frame.payload as { event?: { assistantMessageEvent?: { delta?: string } } }).event?.assistantMessageEvent
					?.delta === "later",
		),
	).toBe(true);
	expect(
		frames.some(
			frame =>
				frame.type === "event" &&
				frame.kind === "message_update" &&
				(frame.payload as { event?: { assistantMessageEvent?: { delta?: string } } }).event?.assistantMessageEvent
					?.delta === "x",
		),
	).toBe(true);
	const correlatedUpdates = frames.filter(
		frame =>
			frame.type === "event" &&
			frame.kind === "message_update" &&
			frame.commandId === correlation.commandId &&
			frame.turnId === correlation.turnId,
	);
	const textDeltas = correlatedUpdates
		.map(frame => (frame.payload as { event?: { assistantMessageEvent?: { type?: string; delta?: string } } }).event)
		.filter(event => event?.assistantMessageEvent?.type === "text_delta")
		.map(event => event?.assistantMessageEvent?.delta ?? "")
		.filter(delta => delta !== "x" && delta !== "later");
	const thinkingDeltas = correlatedUpdates
		.map(frame => (frame.payload as { event?: { assistantMessageEvent?: { type?: string; delta?: string } } }).event)
		.filter(event => event?.assistantMessageEvent?.type === "thinking_delta")
		.map(event => event?.assistantMessageEvent?.delta ?? "");
	expect(textDeltas.join("")).toBe(oversizedTextDelta);
	expect(thinkingDeltas.join("")).toBe(oversizedThinkingDelta);
	for (const update of correlatedUpdates) {
		expect(Buffer.byteLength(JSON.stringify(update))).toBeLessThanOrEqual(RESPONSE_CEILING_BYTES);
		expect(JSON.stringify(update)).not.toContain("[truncated]");
	}
	const messageEnd = frames.find(frame => frame.type === "event" && frame.kind === "message_end");
	expect(messageEnd).toBeDefined();
	expect(Buffer.byteLength(JSON.stringify(messageEnd))).toBeLessThanOrEqual(RESPONSE_CEILING_BYTES);
	expect(JSON.stringify(messageEnd)).not.toContain("[truncated]");
	expect(
		(messageEnd?.payload as { event?: { message?: { textTruncated?: boolean } } }).event?.message?.textTruncated,
	).toBe(true);
});

isolatedSdkHostTest("oversized non-text message_end does not fabricate assistant text", async () => {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "gjc-sdk-oversized-non-text-"));
	dirs.push(cwd);
	const sessionId = `sdk-oversized-non-text-${Date.now()}`;
	const sessionContext = context(cwd, sessionId);
	const handlers = start(sessionContext, () => new Promise<never>(() => {}) as never);
	const { socket, frames } = await connect(cwd, sessionId);
	socket.send(
		JSON.stringify({
			type: "control_request",
			id: "oversized-non-text",
			operation: "turn.prompt",
			input: { text: "stream" },
		}),
	);
	await waitFor(
		() => frames.some(frame => frame.type === "control_response" && frame.id === "oversized-non-text"),
		"prompt acknowledgement",
	);
	await handlers.get("agent_start")?.({ type: "agent_start" }, sessionContext);
	const largeImage = {
		role: "assistant",
		content: [{ type: "image", data: "x".repeat(RESPONSE_CEILING_BYTES), mimeType: "image/png" }],
	};
	await handlers.get("message_update")?.(
		{
			type: "message_update",
			message: { role: "assistant", content: [] },
			assistantMessageEvent: { type: "thinking_delta", delta: "x" },
		},
		sessionContext,
	);
	await handlers.get("message_end")?.({ type: "message_end", message: largeImage }, sessionContext);
	await waitFor(
		() => frames.some(frame => frame.type === "event" && frame.kind === "message_end"),
		"message_end",
		2000,
	);
	const messageEnd = frames.find(frame => frame.type === "event" && frame.kind === "message_end");
	expect(messageEnd).toBeDefined();
	expect(Buffer.byteLength(JSON.stringify(messageEnd))).toBeLessThanOrEqual(RESPONSE_CEILING_BYTES);
	const content = (
		messageEnd?.payload as { event?: { message?: { content?: Array<{ type?: string; text?: string }> } } }
	).event?.message?.content;
	expect(content).toEqual([]);
	expect(JSON.stringify(messageEnd)).not.toContain("[truncated]");
});

isolatedSdkHostTest("oversized message_end preserves aggregate text across multiple blocks", async () => {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "gjc-sdk-oversized-multi-text-"));
	dirs.push(cwd);
	const sessionId = `sdk-oversized-multi-text-${Date.now()}`;
	const sessionContext = context(cwd, sessionId);
	const handlers = start(sessionContext, () => new Promise<never>(() => {}) as never);
	const { socket, frames } = await connect(cwd, sessionId);
	socket.send(
		JSON.stringify({
			type: "control_request",
			id: "oversized-multi-text",
			operation: "turn.prompt",
			input: { text: "stream" },
		}),
	);
	await waitFor(
		() => frames.some(frame => frame.type === "control_response" && frame.id === "oversized-multi-text"),
		"prompt acknowledgement",
	);
	await handlers.get("agent_start")?.({ type: "agent_start" }, sessionContext);
	const textBlocks = Array.from({ length: 9 }, (_, index) => String.fromCharCode(97 + index).repeat(120_000));
	const message = {
		role: "assistant",
		content: textBlocks.map(text => ({ type: "text", text })),
	};
	await handlers.get("message_end")?.({ type: "message_end", message }, sessionContext);
	await waitFor(
		() => frames.some(frame => frame.type === "event" && frame.kind === "message_end"),
		"message_end",
		2000,
	);
	const messageEnd = frames.find(frame => frame.type === "event" && frame.kind === "message_end");
	expect(messageEnd).toBeDefined();
	expect(Buffer.byteLength(JSON.stringify(messageEnd))).toBeLessThanOrEqual(RESPONSE_CEILING_BYTES);
	const content = (
		messageEnd?.payload as { event?: { message?: { content?: Array<{ type?: string; text?: string }> } } }
	).event?.message?.content;
	expect(content?.every(block => block.type === "text")).toBe(true);
	const joinedText = content?.map(block => block.text ?? "").join("") ?? "";
	expect(joinedText.length).toBeGreaterThan(8 * 120_000);
	expect(joinedText).toBe(textBlocks.join("").slice(0, joinedText.length));
	expect(content?.length).toBeGreaterThan(1);
	const boundedMessage = (
		messageEnd?.payload as { event?: { message?: { textTruncated?: boolean; omittedTextBlocks?: number } } }
	).event?.message;
	expect(boundedMessage?.textTruncated).toBe(true);
	expect(boundedMessage?.omittedTextBlocks ?? 0).toBe(textBlocks.length - (content?.length ?? 0));
	expect(JSON.stringify(messageEnd)).not.toContain("[truncated]");
});

isolatedSdkHostTest("oversized message_end keeps every text block when text fits", async () => {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "gjc-sdk-fitting-multi-text-"));
	dirs.push(cwd);
	const sessionId = `sdk-fitting-multi-text-${Date.now()}`;
	const sessionContext = context(cwd, sessionId);
	const handlers = start(sessionContext, () => new Promise<never>(() => {}) as never);
	const { socket, frames } = await connect(cwd, sessionId);
	socket.send(
		JSON.stringify({
			type: "control_request",
			id: "fitting-multi-text",
			operation: "turn.prompt",
			input: { text: "stream" },
		}),
	);
	await waitFor(
		() => frames.some(frame => frame.type === "control_response" && frame.id === "fitting-multi-text"),
		"prompt acknowledgement",
	);
	await handlers.get("agent_start")?.({ type: "agent_start" }, sessionContext);
	const textBlocks = ["one", "two", "three"];
	const message = {
		role: "assistant",
		content: [
			{ type: "image", data: "x".repeat(RESPONSE_CEILING_BYTES), mimeType: "image/png" },
			...textBlocks.map(text => ({ type: "text", text })),
		],
	};
	await handlers.get("message_end")?.({ type: "message_end", message }, sessionContext);
	await waitFor(
		() => frames.some(frame => frame.type === "event" && frame.kind === "message_end"),
		"message_end",
		2000,
	);
	const messageEnd = frames.find(frame => frame.type === "event" && frame.kind === "message_end");
	expect(messageEnd).toBeDefined();
	const boundedMessage = (
		messageEnd?.payload as {
			event?: {
				message?: {
					content?: Array<{ type?: string; text?: string }>;
					textTruncated?: boolean;
					omittedTextBlocks?: number;
				};
			};
		}
	).event?.message;
	expect(boundedMessage?.content).toEqual(textBlocks.map(text => ({ type: "text", text })));
	expect(boundedMessage?.textTruncated).toBeUndefined();
	expect(boundedMessage?.omittedTextBlocks).toBeUndefined();
});

test("oversized agent_end preserves finalText truncation metadata", () => {
	const agentEnd = boundedCorrelatedAgentEndFrame({
		type: "agent_end",
		finalText: "x".repeat(RESPONSE_CEILING_BYTES),
	});
	expect(agentEnd.finalTextTruncated).toBe(true);
	expect((agentEnd.finalText as string).length).toBeLessThan(RESPONSE_CEILING_BYTES);
	expect(agentEnd.finalText).toContain("[truncated]");
	const alreadyTruncated = boundedCorrelatedAgentEndFrame({
		type: "agent_end",
		finalText: "x".repeat(RESPONSE_CEILING_BYTES),
		finalTextTruncated: true,
	});
	expect(alreadyTruncated.finalTextTruncated).toBe(true);
	const short = boundedCorrelatedAgentEndFrame({ type: "agent_end", finalText: "short", finalTextTruncated: true });
	expect(short).toEqual({ type: "agent_end", finalText: "short", finalTextTruncated: true });
});

isolatedSdkHostTest(
	"failed correlated terminal delivery sends a classified terminal",
	async () => {
		const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "gjc-sdk-delivery-failure-"));
		dirs.push(cwd);
		const sessionId = `sdk-delivery-failure-${Date.now()}`;
		const sessionContext = context(cwd, sessionId);
		const handlers = start(sessionContext, () => new Promise<never>(() => {}) as never);
		const { socket, frames } = await connect(cwd, sessionId);
		socket.send(
			JSON.stringify({
				type: "control_request",
				id: "failed-delivery",
				operation: "turn.prompt",
				input: { text: "stream" },
			}),
		);
		await waitFor(
			() => frames.some(frame => frame.type === "control_response" && frame.id === "failed-delivery"),
			"prompt acknowledgement",
		);
		const acknowledgement = frames.find(
			frame => frame.type === "control_response" && frame.id === "failed-delivery",
		) as { result: { commandId: string; turnId: string } };
		await handlers.get("agent_start")?.({ type: "agent_start" }, sessionContext);
		const original = NotificationServer.prototype.sendTo;
		const send = spyOn(NotificationServer.prototype, "sendTo").mockImplementation(function (
			this: NotificationServer,
			connectionId,
			json,
		) {
			if (JSON.parse(json).type === "agent_end")
				throw new Error("sdk directed delivery rejected: cause=writer_backlog_full frameBytes=200");
			return original.call(this, connectionId, json);
		});
		try {
			await handlers.get("agent_end")?.(
				{ type: "agent_end", stopReason: "completed", messages: [] },
				sessionContext,
			);
			await waitFor(
				() =>
					frames.some(
						frame =>
							frame.type === "agent_failed" &&
							frame.commandId === acknowledgement.result.commandId &&
							frame.turnId === acknowledgement.result.turnId,
					),
				"delivery failure terminal",
				5000,
			);
			const failure = frames.find(
				frame => frame.type === "agent_failed" && frame.commandId === acknowledgement.result.commandId,
			) as { error: { code: string; cause: string; frameBytes: number }; outcome: { providerCode?: string } };
			expect(failure.error.code).toBe("delivery_failed");
			expect(failure.error.cause).toBe("writer_backlog_full");
			expect(failure.error.frameBytes).toBeLessThan(RESPONSE_CEILING_BYTES);
			expect(failure.outcome.providerCode).toBe("writer_backlog_full");
		} finally {
			send.mockRestore();
		}
	},
	10_000,
);

isolatedSdkHostTest(
	"failed correlated non-terminal delivery does not terminalize an active prompt",
	async () => {
		const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "gjc-sdk-delivery-race-"));
		dirs.push(cwd);
		const sessionId = `sdk-delivery-race-${Date.now()}`;
		const sessionContext = context(cwd, sessionId);
		const handlers = start(sessionContext, () => new Promise<never>(() => {}) as never);
		const { socket, frames } = await connect(cwd, sessionId);
		socket.send(
			JSON.stringify({
				type: "control_request",
				id: "delivery-race",
				operation: "turn.prompt",
				input: { text: "stream" },
			}),
		);
		await waitFor(
			() => frames.some(frame => frame.type === "control_response" && frame.id === "delivery-race"),
			"prompt acknowledgement",
		);
		const original = NotificationServer.prototype.sendTo;
		let failedNonTerminalSend = false;
		let syntheticTerminalSend = false;
		const send = spyOn(NotificationServer.prototype, "sendTo").mockImplementation(function (
			this: NotificationServer,
			connectionId,
			json,
		) {
			const frame = JSON.parse(json) as { type?: string; kind?: string };
			if (!failedNonTerminalSend && frame.type === "event" && frame.kind === "message_update") {
				failedNonTerminalSend = true;
				throw new Error("sdk directed delivery rejected: cause=writer_backlog_full frameBytes=200");
			}
			if (frame.type === "agent_failed") syntheticTerminalSend = true;
			return original.call(this, connectionId, json);
		});
		try {
			await handlers.get("agent_start")?.({ type: "agent_start" }, sessionContext);
			await handlers.get("message_update")?.(
				{
					type: "message_update",
					message: { role: "assistant", content: [] },
					assistantMessageEvent: { type: "text_delta", delta: "active run" },
				},
				sessionContext,
			);
			expect(failedNonTerminalSend).toBe(true);
			expect(syntheticTerminalSend).toBe(false);
		} finally {
			send.mockRestore();
		}
	},
	10_000,
);

async function activePrompt(label: string): Promise<{
	handlers: Map<string, (event: unknown, context: unknown) => unknown>;
	sessionContext: Record<string, unknown>;
	frames: Record<string, unknown>[];
	correlation: { commandId: string; turnId: string };
}> {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), `gjc-sdk-${label}-`));
	dirs.push(cwd);
	const sessionContext = context(cwd, `sdk-${label}-${Date.now()}`);
	const handlers = start(sessionContext, () => new Promise<never>(() => {}) as never);
	const { socket, frames } = await connect(
		cwd,
		(sessionContext.sessionManager as { getSessionId: () => string }).getSessionId(),
	);
	socket.send(
		JSON.stringify({ type: "control_request", id: label, operation: "turn.prompt", input: { text: "stream" } }),
	);
	await waitFor(
		() => frames.some(frame => frame.type === "control_response" && frame.id === label),
		"prompt acknowledgement",
	);
	const acknowledgement = frames.find(frame => frame.type === "control_response" && frame.id === label) as {
		result: { commandId: string; turnId: string };
	};
	await handlers.get("agent_start")?.({ type: "agent_start" }, sessionContext);
	return { handlers, sessionContext, frames, correlation: acknowledgement.result };
}

function correlatedTerminal(frames: Record<string, unknown>[], correlation: { commandId: string; turnId: string }) {
	return frames.find(
		frame =>
			(frame.type === "agent_end" || frame.type === "agent_failed") &&
			frame.commandId === correlation.commandId &&
			frame.turnId === correlation.turnId,
	);
}

isolatedSdkHostTest("backlog rejection of progress keeps the terminal deliverable", async () => {
	const { handlers, sessionContext, frames, correlation } = await activePrompt("backlog-progress");
	const original = NotificationServer.prototype.sendTo;
	let rejected = false;
	const send = spyOn(NotificationServer.prototype, "sendTo").mockImplementation(function (
		this: NotificationServer,
		id,
		json,
	) {
		const frame = JSON.parse(json) as { type?: string; kind?: string };
		if (!rejected && frame.type === "event" && frame.kind === "message_update") {
			rejected = true;
			throw new Error("sdk directed delivery rejected: cause=writer_backlog_full frameBytes=200");
		}
		return original.call(this, id, json);
	});
	try {
		const message = { role: "assistant", content: [{ type: "text", text: "complete" }] };
		await handlers.get("message_update")?.(
			{ type: "message_update", message, assistantMessageEvent: { type: "text_delta", delta: "complete" } },
			sessionContext,
		);
		await handlers.get("message_end")?.({ type: "message_end", message }, sessionContext);
		await handlers.get("agent_end")?.({ type: "agent_end", stopReason: "completed", messages: [] }, sessionContext);
		await waitFor(
			() => correlatedTerminal(frames, correlation)?.type === "agent_end",
			"agent_end after backlog",
			2000,
		);
		expect(rejected).toBe(true);
	} finally {
		send.mockRestore();
	}
});

isolatedSdkHostTest("one backlog rejection of agent_end is retried", async () => {
	const { handlers, sessionContext, frames, correlation } = await activePrompt("backlog-terminal-once");
	const original = NotificationServer.prototype.sendTo;
	let attempts = 0;
	const send = spyOn(NotificationServer.prototype, "sendTo").mockImplementation(function (
		this: NotificationServer,
		id,
		json,
	) {
		if ((JSON.parse(json) as { type?: string }).type === "agent_end" && ++attempts === 1)
			throw new Error("sdk directed delivery rejected: cause=writer_backlog_full frameBytes=200");
		return original.call(this, id, json);
	});
	try {
		await handlers.get("agent_end")?.({ type: "agent_end", stopReason: "completed", messages: [] }, sessionContext);
		await waitFor(() => correlatedTerminal(frames, correlation)?.type === "agent_end", "retried agent_end", 2000);
		expect(attempts).toBe(2);
		expect(frames.some(frame => frame.type === "agent_failed" && frame.commandId === correlation.commandId)).toBe(
			false,
		);
	} finally {
		send.mockRestore();
	}
});

isolatedSdkHostTest(
	"successful terminal retry via live emit releases prompt capacity",
	async () => {
		const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "gjc-sdk-backlog-success-capacity-"));
		dirs.push(cwd);
		const sessionId = `sdk-backlog-success-capacity-${Date.now()}`;
		const sessionContext = context(cwd, sessionId);
		const handlers = start(sessionContext, () => new Promise<never>(() => {}) as never);
		const { socket, frames } = await connect(cwd, sessionId);
		const original = NotificationServer.prototype.sendTo;
		const terminalAttempts = new Map<string, number>();
		const send = spyOn(NotificationServer.prototype, "sendTo").mockImplementation(function (
			this: NotificationServer,
			id,
			json,
		) {
			const frame = JSON.parse(json) as { type?: string };
			if (frame.type === "agent_end") {
				const attempt = (terminalAttempts.get(json) ?? 0) + 1;
				terminalAttempts.set(json, attempt);
				if (attempt === 1)
					throw new Error("sdk directed delivery rejected: cause=writer_backlog_full frameBytes=200");
			}
			return original.call(this, id, json);
		});
		try {
			for (let index = 0; index < 128; index++) {
				const id = `backlog-success-capacity-${index}`;
				socket.send(
					JSON.stringify({ type: "control_request", id, operation: "turn.prompt", input: { text: "stream" } }),
				);
				await waitFor(
					() => frames.some(frame => frame.type === "control_response" && frame.id === id),
					`prompt ${id}`,
				);
				const acknowledgement = frames.find(frame => frame.type === "control_response" && frame.id === id) as {
					result: { commandId: string; turnId: string };
				};
				const correlation = acknowledgement.result;
				await handlers.get("agent_start")?.({ type: "agent_start" }, sessionContext);
				await handlers.get("message_update")?.(
					{
						type: "message_update",
						message: { role: "assistant", content: [] },
						assistantMessageEvent: { type: "text_delta", delta: "live" },
					},
					sessionContext,
				);
				await waitFor(
					() =>
						frames.some(
							frame =>
								frame.type === "event" &&
								frame.commandId === correlation.commandId &&
								frame.turnId === correlation.turnId,
						),
					`live progress ${id}`,
				);
				await handlers.get("agent_end")?.(
					{ type: "agent_end", stopReason: "completed", messages: [] },
					sessionContext,
				);
				await waitFor(
					() => correlatedTerminal(frames, correlation)?.type === "agent_end",
					`retried terminal ${id}`,
					1000,
				);
			}

			const finalId = "backlog-success-capacity-final";
			socket.send(
				JSON.stringify({
					type: "control_request",
					id: finalId,
					operation: "turn.prompt",
					input: { text: "admission after successful retries" },
				}),
			);
			await waitFor(
				() => frames.some(frame => frame.type === "control_response" && frame.id === finalId),
				"final prompt",
			);
			const response = frames.find(frame => frame.type === "control_response" && frame.id === finalId) as {
				ok: boolean;
			};
			expect(response.ok).toBe(true);
		} finally {
			send.mockRestore();
		}
	},
	30_000,
);

isolatedSdkHostTest(
	"persistent terminal backlog reaches delivery_failed within a bound",
	async () => {
		const { handlers, sessionContext, frames, correlation } = await activePrompt("backlog-terminal-persistent");
		const original = NotificationServer.prototype.sendTo;
		let attempts = 0;
		const send = spyOn(NotificationServer.prototype, "sendTo").mockImplementation(function (
			this: NotificationServer,
			id,
			json,
		) {
			if ((JSON.parse(json) as { type?: string }).type === "agent_end") {
				attempts++;
				throw new Error("sdk directed delivery rejected: cause=writer_backlog_full frameBytes=200");
			}
			return original.call(this, id, json);
		});
		try {
			await handlers.get("agent_end")?.(
				{ type: "agent_end", stopReason: "completed", messages: [] },
				sessionContext,
			);
			await waitFor(
				() => correlatedTerminal(frames, correlation)?.type === "agent_failed",
				"bounded delivery failure",
				5000,
			);
			expect(attempts).toBeGreaterThan(1);
			expect((correlatedTerminal(frames, correlation) as { error: { code: string } }).error.code).toBe(
				"delivery_failed",
			);
		} finally {
			send.mockRestore();
		}
	},
	5000,
);

isolatedSdkHostTest(
	"terminal retry failure releases abandoned prompt capacity",
	async () => {
		const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "gjc-sdk-backlog-capacity-"));
		dirs.push(cwd);
		const sessionId = `sdk-backlog-capacity-${Date.now()}`;
		const sessionContext = context(cwd, sessionId);
		const handlers = start(sessionContext, () => new Promise<never>(() => {}) as never);
		const { socket, frames } = await connect(cwd, sessionId);
		const original = NotificationServer.prototype.sendTo;
		const terminalAttempts = new Map<string, number>();
		const send = spyOn(NotificationServer.prototype, "sendTo").mockImplementation(function (
			this: NotificationServer,
			id,
			json,
		) {
			const frame = JSON.parse(json) as { type?: string };
			if (frame.type === "agent_end") {
				const attempt = (terminalAttempts.get(json) ?? 0) + 1;
				terminalAttempts.set(json, attempt);
				if (attempt === 1)
					throw new Error("sdk directed delivery rejected: cause=writer_backlog_full frameBytes=200");
				throw new Error("sdk directed delivery rejected: cause=connection_closed frameBytes=200");
			}
			return original.call(this, id, json);
		});
		try {
			for (let index = 0; index < 128; index++) {
				const id = `backlog-capacity-${index}`;
				socket.send(
					JSON.stringify({ type: "control_request", id, operation: "turn.prompt", input: { text: "stream" } }),
				);
				await waitFor(
					() => frames.some(frame => frame.type === "control_response" && frame.id === id),
					`prompt ${id}`,
				);
				const acknowledgement = frames.find(frame => frame.type === "control_response" && frame.id === id) as {
					result: { commandId: string; turnId: string };
				};
				const correlation = acknowledgement.result;
				await handlers.get("agent_start")?.({ type: "agent_start" }, sessionContext);
				await handlers.get("agent_end")?.(
					{ type: "agent_end", stopReason: "completed", messages: [] },
					sessionContext,
				);
				await waitFor(
					() => correlatedTerminal(frames, correlation)?.type === "agent_failed",
					`delivery failure ${id}`,
					1000,
				);
			}

			const finalId = "backlog-capacity-final";
			socket.send(
				JSON.stringify({
					type: "control_request",
					id: finalId,
					operation: "turn.prompt",
					input: { text: "admission after retry failures" },
				}),
			);
			await waitFor(
				() => frames.some(frame => frame.type === "control_response" && frame.id === finalId),
				"final prompt",
			);
			const response = frames.find(frame => frame.type === "control_response" && frame.id === finalId) as {
				type: string;
				ok: boolean;
				error?: { code?: string };
			};
			expect(response.ok).toBe(true);
		} finally {
			send.mockRestore();
		}
	},
	30_000,
);

isolatedSdkHostTest("fatal progress delivery failure still abandons the prompt", async () => {
	const { handlers, sessionContext, frames, correlation } = await activePrompt("fatal-progress");
	const original = NotificationServer.prototype.sendTo;
	let rejected = false;
	const send = spyOn(NotificationServer.prototype, "sendTo").mockImplementation(function (
		this: NotificationServer,
		id,
		json,
	) {
		const frame = JSON.parse(json) as { type?: string; kind?: string };
		if (!rejected && frame.type === "event" && frame.kind === "message_update") {
			rejected = true;
			throw new Error("sdk directed delivery rejected: cause=connection_closed frameBytes=200");
		}
		return original.call(this, id, json);
	});
	try {
		await handlers.get("message_update")?.(
			{
				type: "message_update",
				message: { role: "assistant", content: [] },
				assistantMessageEvent: { type: "text_delta", delta: "x" },
			},
			sessionContext,
		);
		await handlers.get("agent_end")?.({ type: "agent_end", stopReason: "completed", messages: [] }, sessionContext);
		await Bun.sleep(100);
		expect(rejected).toBe(true);
		expect(correlatedTerminal(frames, correlation)).toBeUndefined();
	} finally {
		send.mockRestore();
	}
});
