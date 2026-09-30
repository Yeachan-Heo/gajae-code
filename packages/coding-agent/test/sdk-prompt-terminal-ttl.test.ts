import { afterEach, expect, spyOn, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ExtensionActions, ExtensionAPI } from "../src/extensibility/extensions/types";
import { projectSharedStateRoot } from "../src/gjc-runtime/session-layout";
import { brokerOwnerForTest } from "../src/sdk/broker/ensure";
import { createNotificationsExtension } from "../src/sdk/bus";

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
	const endpointFile = path.join(projectSharedStateRoot(cwd), "sdk", `${sessionId}.json`);
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

const SUBMISSION_TTL_MS = 5 * 60_000;

isolatedSdkHostTest(
	"prompt outliving the submission TTL still publishes exactly one correlated positioned terminal",
	async () => {
		const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "gjc-sdk-prompt-terminal-ttl-"));
		dirs.push(cwd);
		const sessionId = `sdk-prompt-terminal-ttl-${Date.now()}`;
		const sessionContext = context(cwd, sessionId);
		// The prompt never completes delivery on its own: the agent stays active
		// until the test drives agent_end, like a 27-minute broker-managed run.
		const handlers = start(sessionContext, () => new Promise<never>(() => {}) as never);
		const { socket, frames } = await connect(cwd, sessionId);

		socket.send(
			JSON.stringify({
				type: "control_request",
				id: "long-prompt",
				operation: "turn.prompt",
				input: { text: "run longer than the submission TTL" },
			}),
		);
		await waitFor(
			() => frames.some(frame => frame.type === "control_response" && frame.id === "long-prompt"),
			"prompt acknowledgement",
		);
		const acknowledgement = frames.find(frame => frame.type === "control_response" && frame.id === "long-prompt") as {
			result?: { commandId?: unknown; turnId?: unknown };
		};
		const correlation = { commandId: acknowledgement.result?.commandId, turnId: acknowledgement.result?.turnId };
		expect(correlation.commandId).toBeTruthy();
		expect(correlation.turnId).toBeTruthy();

		await handlers.get("agent_start")?.({ type: "agent_start" }, sessionContext);

		// Advance the process clock beyond PROMPT_SUBMISSION_TTL_MS while the
		// prompt is still active, then finish the agent naturally.
		const realNow = Date.now;
		const shifted = realNow() + SUBMISSION_TTL_MS + 60_000;
		const clockSpy = spyOn(Date, "now").mockImplementation(() => shifted);
		try {
			await handlers.get("agent_end")?.(
				{ type: "agent_end", stopReason: "completed", messages: [] },
				sessionContext,
			);

			await waitFor(
				() =>
					frames.some(
						frame =>
							(frame.type === "agent_end" || frame.type === "agent_failed") &&
							frame.commandId === correlation.commandId &&
							frame.turnId === correlation.turnId,
					),
				"correlated terminal lifecycle frame past the submission TTL",
			);

			const terminals = frames.filter(
				frame =>
					(frame.type === "agent_end" || frame.type === "agent_failed") &&
					frame.commandId === correlation.commandId &&
					frame.turnId === correlation.turnId,
			);
			expect(terminals).toHaveLength(1);
		} finally {
			clockSpy.mockRestore();
		}

		await handlers.get("session_shutdown")?.({ type: "session_shutdown" }, sessionContext);
	},
	75_000,
);

isolatedSdkHostTest(
	"cleanup during in-flight terminalization cannot drop the terminal event",
	async () => {
		const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "gjc-sdk-prompt-terminal-ttl-race-"));
		dirs.push(cwd);
		const sessionId = `sdk-prompt-terminal-ttl-race-${Date.now()}`;
		const sessionContext = context(cwd, sessionId);
		const handlers = start(sessionContext, () => new Promise<never>(() => {}) as never);
		const { socket, frames } = await connect(cwd, sessionId);

		socket.send(
			JSON.stringify({
				type: "control_request",
				id: "race-prompt",
				operation: "turn.prompt",
				input: { text: "terminalize while cleanup runs" },
			}),
		);
		await waitFor(
			() => frames.some(frame => frame.type === "control_response" && frame.id === "race-prompt"),
			"prompt acknowledgement",
		);
		const acknowledgement = frames.find(frame => frame.type === "control_response" && frame.id === "race-prompt") as {
			result?: { commandId?: unknown; turnId?: unknown };
		};
		const correlation = { commandId: acknowledgement.result?.commandId, turnId: acknowledgement.result?.turnId };

		await handlers.get("agent_start")?.({ type: "agent_start" }, sessionContext);

		const shifted = realNow() + SUBMISSION_TTL_MS + 60_000;
		const clockSpy = spyOn(Date, "now").mockImplementation(() => shifted);
		try {
			// Start natural terminalization without awaiting it, then force a
			// cleanup pass (via a correlated agent event) while terminalization is
			// awaiting durable persistence. The record is terminal-in-progress, so
			// cleanup must not evict it before publication settles.
			const terminalization = handlers.get("agent_end")?.(
				{ type: "agent_end", stopReason: "completed", messages: [] },
				sessionContext,
			);
			await Bun.sleep(10);
			handlers.get("tool_execution_update")?.(
				{ type: "tool_execution_update", toolCallId: "race-tool", output: "tick" },
				sessionContext,
			);
			await terminalization;

			await waitFor(
				() =>
					frames.some(
						frame =>
							(frame.type === "agent_end" || frame.type === "agent_failed") &&
							frame.commandId === correlation.commandId &&
							frame.turnId === correlation.turnId,
					),
				"correlated terminal lifecycle frame after mid-terminalization cleanup",
			);
		} finally {
			clockSpy.mockRestore();
		}

		await handlers.get("session_shutdown")?.({ type: "session_shutdown" }, sessionContext);
	},
	75_000,
);

isolatedSdkHostTest(
	"past-TTL terminal is delivered exactly once and the submission registry stays healthy",
	async () => {
		const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "gjc-sdk-prompt-terminal-ttl-once-"));
		dirs.push(cwd);
		const sessionId = `sdk-prompt-terminal-ttl-once-${Date.now()}`;
		const sessionContext = context(cwd, sessionId);
		const handlers = start(sessionContext, () => new Promise<never>(() => {}) as never);
		const { socket, frames } = await connect(cwd, sessionId);

		const submit = async (requestId: string): Promise<{ commandId: unknown; turnId: unknown }> => {
			socket.send(
				JSON.stringify({
					type: "control_request",
					id: requestId,
					operation: "turn.prompt",
					input: { text: `prompt ${requestId}` },
				}),
			);
			await waitFor(
				() => frames.some(frame => frame.type === "control_response" && frame.id === requestId),
				`prompt acknowledgement ${requestId}`,
			);
			const acknowledgement = frames.find(frame => frame.type === "control_response" && frame.id === requestId) as {
				result?: { commandId?: unknown; turnId?: unknown };
			};
			return { commandId: acknowledgement.result?.commandId, turnId: acknowledgement.result?.turnId };
		};
		const correlatedTerminals = (correlation: { commandId: unknown; turnId: unknown }) =>
			frames.filter(
				frame =>
					(frame.type === "agent_end" || frame.type === "agent_failed") &&
					frame.commandId === correlation.commandId &&
					frame.turnId === correlation.turnId,
			);

		const first = await submit("first-prompt");
		await handlers.get("agent_start")?.({ type: "agent_start" }, sessionContext);

		const shifted = realNow() + SUBMISSION_TTL_MS + 60_000;
		const clockSpy = spyOn(Date, "now").mockImplementation(() => shifted);
		try {
			await handlers.get("agent_end")?.(
				{ type: "agent_end", stopReason: "completed", messages: [] },
				sessionContext,
			);
			await waitFor(() => correlatedTerminals(first).length > 0, "first correlated terminal");
			// Re-driving agent_end must never re-publish the same correlated terminal.
			await handlers.get("agent_end")?.(
				{ type: "agent_end", stopReason: "completed", messages: [] },
				sessionContext,
			);
			await Bun.sleep(100);
			expect(correlatedTerminals(first)).toHaveLength(1);
		} finally {
			clockSpy.mockRestore();
		}

		// The registry must keep accepting and terminalizing new prompts after a
		// past-TTL terminal: no wedged admission and no leaked record blocking
		// the next correlation.
		const second = await submit("second-prompt");
		await handlers.get("agent_start")?.({ type: "agent_start" }, sessionContext);
		await handlers.get("agent_end")?.({ type: "agent_end", stopReason: "completed", messages: [] }, sessionContext);
		await waitFor(() => correlatedTerminals(second).length > 0, "second correlated terminal");
		expect(correlatedTerminals(second)).toHaveLength(1);
		expect(correlatedTerminals(first)).toHaveLength(1);

		await handlers.get("session_shutdown")?.({ type: "session_shutdown" }, sessionContext);
	},
	75_000,
);
