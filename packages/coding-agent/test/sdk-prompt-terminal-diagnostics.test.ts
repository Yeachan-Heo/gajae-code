import { afterEach, expect, spyOn, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { logger } from "@gajae-code/utils";
import { brokerOwnerForTest } from "../src/sdk/broker/ensure";
import { createNotificationsExtension } from "../src/sdk/bus";

/**
 * A turn that dies abnormally publishes a terminal whose wire text is the fixed
 * safe token "Prompt submission failed." (see `sanitizePromptFailure`), so an ACP
 * client can only render `-32603 ... {"code":"prompt_failed"}` and a lane whose
 * transport lost even that frame shows a turn that simply ended: no error, no
 * edit, nothing to act on. The reason a turn died must therefore survive in the
 * local operator log, including for loop-level terminals that carry no legacy
 * discriminator and no assistant message at all.
 */

const dirs: string[] = [];
const sockets: WebSocket[] = [];

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

async function waitFor(predicate: () => boolean, label: string): Promise<void> {
	const deadline = Date.now() + 15_000;
	while (!predicate()) {
		if (Date.now() > deadline) throw new Error(`Timed out waiting for ${label}`);
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
			getSessionName: () => "prompt terminal diagnostics",
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

function start(ctx: Record<string, unknown>): Map<string, (event: unknown, context: unknown) => unknown> {
	const handlers = new Map<string, (event: unknown, context: unknown) => unknown>();
	const api = {
		on: (event: string, handler: (event: unknown, context: unknown) => unknown) => handlers.set(event, handler),
		registerCommand: () => {},
		getThinkingLevel: () => undefined,
		sendUserMessage: (_content: unknown, options?: Record<string, unknown>) => {
			const commit = options?.onPreflightAcceptCommit as (() => unknown) | undefined;
			const accepted = options?.onPreflightAccepted as (() => void) | undefined;
			if (commit) return Promise.resolve(commit()).then(() => accepted?.());
			accepted?.();
			return Promise.resolve(undefined);
		},
	} as never;
	createNotificationsExtension(api, undefined);
	void handlers.get("session_start")?.({ type: "session_start" }, ctx);
	return handlers;
}

test("SDK host logs why a prompt terminal failed even though the wire text is a fixed safe token", async () => {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "gjc-sdk-prompt-terminal-diagnostics-"));
	dirs.push(cwd);
	const sessionId = `sdk-prompt-terminal-diagnostics-${Date.now()}`;
	const sessionContext = context(cwd, sessionId);
	const handlers = start(sessionContext);
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

	const diagnostics: Record<string, unknown>[] = [];
	const errorSpy = spyOn(logger, "error").mockImplementation((...args: unknown[]) => {
		if (args[0] === "sdk_prompt_terminal_failed") diagnostics.push(args[1] as Record<string, unknown>);
	});

	const submit = async (requestId: string): Promise<{ commandId: unknown; turnId: unknown }> => {
		socket.send(
			JSON.stringify({
				type: "control_request",
				id: requestId,
				operation: "turn.prompt",
				input: { text: "reproduce the reviewer findings" },
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

	try {
		// 1. Provider-side turn failure: only the assistant message carries the reason.
		const first = await submit("failing-prompt");
		await handlers.get("agent_start")?.({ type: "agent_start" }, sessionContext);
		await handlers.get("agent_end")?.(
			{
				type: "agent_end",
				stopReason: "completed",
				messages: [
					{
						role: "assistant",
						stopReason: "error",
						errorKind: "provider_error",
						errorMessage: "Session context exceeds materialization budget (99 > 64 bytes)",
					},
				],
			} as never,
			sessionContext,
		);
		await waitFor(() => frames.some(frame => frame.type === "agent_failed"), "failed prompt terminal");

		// Reproduction: the wire never names the cause, only the fixed safe token.
		const failure = frames.find(frame => frame.type === "agent_failed") as Record<string, unknown>;
		expect(failure).toMatchObject({
			commandId: first.commandId,
			turnId: first.turnId,
			error: { code: "agent_error", message: "Prompt submission failed." },
			outcome: { kind: "failed", code: "prompt_failed", message: "Prompt submission failed." },
		});
		expect(JSON.stringify(failure)).not.toContain("materialization budget");

		// The local diagnostic is the only surviving record of why the turn died.
		expect(diagnostics).toHaveLength(1);
		expect(diagnostics[0]).toMatchObject({
			sessionId,
			commandId: first.commandId,
			turnId: first.turnId,
			loopStopReason: "completed",
			assistantStopReason: "error",
			errorKind: "provider_error",
			reason: "Session context exceeds materialization budget (99 > 64 bytes)",
		});

		// 2. Loop-level exhaustion carries no legacy discriminator and no assistant at
		// all, so without the diagnostic an operator has literally nothing to act on.
		const second = await submit("exhausted-prompt");
		await handlers.get("agent_start")?.({ type: "agent_start" }, sessionContext);
		await handlers.get("agent_end")?.(
			{ type: "agent_end", stopReason: "exhausted", messages: [] } as never,
			sessionContext,
		);
		await waitFor(() => diagnostics.length > 1, "exhausted prompt diagnostic");
		expect(diagnostics[1]).toMatchObject({
			commandId: second.commandId,
			turnId: second.turnId,
			loopStopReason: "exhausted",
			assistantStopReason: "none",
			reason: "unreported",
		});
		expect(diagnostics[1]).not.toHaveProperty("errorKind");
	} finally {
		errorSpy.mockRestore();
	}

	await handlers.get("session_shutdown")?.({ type: "session_shutdown" }, sessionContext);
});

test("SDK host does not log a client cancellation as a prompt terminal failure", async () => {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "gjc-sdk-prompt-terminal-cancel-"));
	dirs.push(cwd);
	const sessionId = `sdk-prompt-terminal-cancel-${Date.now()}`;
	const sessionContext = context(cwd, sessionId);
	const handlers = start(sessionContext);
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

	const diagnostics: unknown[] = [];
	const errorSpy = spyOn(logger, "error").mockImplementation((...args: unknown[]) => {
		if (args[0] === "sdk_prompt_terminal_failed") diagnostics.push(args[1]);
	});

	try {
		socket.send(
			JSON.stringify({
				type: "control_request",
				id: "cancelled-prompt",
				operation: "turn.prompt",
				input: { text: "work the user interrupts" },
			}),
		);
		await waitFor(
			() => frames.some(frame => frame.type === "control_response" && frame.id === "cancelled-prompt"),
			"prompt acknowledgement",
		);
		await handlers.get("agent_start")?.({ type: "agent_start" }, sessionContext);
		await handlers.get("agent_end")?.(
			{ type: "agent_end", stopReason: "cancelled", messages: [] } as never,
			sessionContext,
		);
		await waitFor(() => frames.some(frame => frame.type === "agent_failed"), "cancelled prompt terminal");

		// A user interrupt is intent, not an undiagnosable defect, so it must not
		// pollute the operator log with an error for every cancel.
		expect(diagnostics).toHaveLength(0);
	} finally {
		errorSpy.mockRestore();
	}

	await handlers.get("session_shutdown")?.({ type: "session_shutdown" }, sessionContext);
});
