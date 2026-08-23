import { afterEach, expect, spyOn, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Agent, type AgentEvent } from "@gajae-code/agent-core";
import { createMockModel } from "@gajae-code/ai/providers/mock";
import { logger } from "@gajae-code/utils";
import type { ExtensionActions, ExtensionAPI } from "../src/extensibility/extensions/types";
import { brokerOwnerForTest } from "../src/sdk/broker/ensure";
import { createNotificationsExtension } from "../src/sdk/bus";

/**
 * A provider failure reaches this extension as an `agent_end` carrying an error
 * assistant message. The SDK/ACP failure envelope uses the fixed safe token
 * "Prompt submission failed." (see `sanitizePromptFailure`), while the assistant
 * message can remain in the local session transcript. The bounded operator log
 * keeps that failure diagnosable without widening the SDK/ACP redaction boundary.
 */

const dirs: string[] = [];
const sockets: WebSocket[] = [];
type AgentEndEvent = Extract<AgentEvent, { type: "agent_end" }>;
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

async function waitFor(predicate: () => boolean, label: string): Promise<void> {
	const deadline = Date.now() + 60_000;
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

isolatedSdkHostTest(
	"SDK host logs a bounded reason from a reachable provider failure",
	async () => {
		const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "gjc-sdk-prompt-terminal-diagnostics-"));
		dirs.push(cwd);
		const sessionId = `sdk-prompt-terminal-diagnostics-${Date.now()}`;
		const sessionContext = context(cwd, sessionId);
		const reason = `Session context exceeds materialization budget (99 > 64 bytes): secret-provider-token=${"x".repeat(600)}`;
		const model = createMockModel({ handler: { throw: new Error(reason) } });
		const agent = new Agent({
			initialState: { model, systemPrompt: ["test"], messages: [], tools: [] },
			streamFn: model.stream,
			requestMaxRetries: 0,
			streamMaxRetries: 0,
		});
		let handlers!: Map<string, (event: unknown, context: unknown) => unknown>;
		handlers = await start(sessionContext, async () => {
			await agent.prompt("reproduce the reviewer findings");
		});
		const unsubscribe = agent.subscribe(event => {
			void handlers.get(event.type)?.(event, sessionContext);
		});
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
			// A real provider exception is converted by Agent into an error assistant
			// and a normal loop terminal; the assistant error makes the SDK terminal fail.
			const first = await submit("failing-prompt");
			await waitFor(() => frames.some(frame => frame.type === "agent_failed"), "failed prompt terminal");

			// The SDK failure envelope never names the cause, only the fixed safe token.
			const failure = frames.find(frame => frame.type === "agent_failed") as Record<string, unknown>;
			expect(failure).toMatchObject({
				commandId: first.commandId,
				turnId: first.turnId,
				error: { code: "agent_error", message: "Prompt submission failed." },
				outcome: { kind: "failed", code: "prompt_failed", message: "Prompt submission failed." },
			});
			expect(JSON.stringify(failure)).not.toContain("materialization budget");
			expect(JSON.stringify(failure)).not.toContain("secret-provider-token");

			expect(diagnostics).toHaveLength(1);
			expect(diagnostics[0]).toMatchObject({
				sessionId,
				commandId: first.commandId,
				turnId: first.turnId,
				loopStopReason: "completed",
				assistantStopReason: "error",
				reason: reason.slice(0, 512),
			});
			expect(diagnostics[0]?.reason).toHaveLength(512);
		} finally {
			unsubscribe();
			errorSpy.mockRestore();
		}

		await handlers.get("session_shutdown")?.({ type: "session_shutdown" }, sessionContext);
	},
	75_000,
);

isolatedSdkHostTest(
	"SDK host logs a bounded reason from an accepted sendUserMessage rejection",
	async () => {
		const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "gjc-sdk-prompt-terminal-accepted-rejection-"));
		dirs.push(cwd);
		const sessionId = `sdk-prompt-terminal-accepted-rejection-${Date.now()}`;
		const sessionContext = context(cwd, sessionId);
		const reason = `Accepted sendUserMessage rejected after commit: ${"y".repeat(600)}`;
		const handlers = await start(sessionContext, async () => {
			throw new Error(reason);
		});
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

		let sdkPromptTerminalFailedCount = 0;
		let diagnostic: Record<string, unknown> | undefined;
		const errorSpy = spyOn(logger, "error").mockImplementation((...args: unknown[]) => {
			if (args[0] !== "sdk_prompt_terminal_failed") return;
			sdkPromptTerminalFailedCount++;
			diagnostic = args[1] as Record<string, unknown>;
		});

		try {
			socket.send(
				JSON.stringify({
					type: "control_request",
					id: "accepted-rejection",
					operation: "turn.prompt",
					input: { text: "fail after acceptance" },
				}),
			);
			await waitFor(
				() => frames.some(frame => frame.type === "control_response" && frame.id === "accepted-rejection"),
				"accepted prompt acknowledgement",
			);
			await waitFor(() => frames.some(frame => frame.type === "agent_failed"), "accepted rejection terminal");

			const acknowledgement = frames.find(
				frame => frame.type === "control_response" && frame.id === "accepted-rejection",
			) as { result?: { commandId?: unknown; turnId?: unknown } };
			const failure = frames.find(frame => frame.type === "agent_failed") as Record<string, unknown>;
			expect(failure).toMatchObject({
				commandId: acknowledgement.result?.commandId,
				turnId: acknowledgement.result?.turnId,
				error: { code: "internal", message: "Prompt submission failed." },
				outcome: { kind: "failed", code: "prompt_failed", message: "Prompt submission failed." },
			});
			expect(JSON.stringify(failure)).not.toContain("Accepted sendUserMessage rejected");
			expect(sdkPromptTerminalFailedCount).toBe(1);
			expect(diagnostic).toMatchObject({
				sessionId,
				commandId: acknowledgement.result?.commandId,
				turnId: acknowledgement.result?.turnId,
				reason: reason.slice(0, 512),
			});
			expect(diagnostic?.reason).toHaveLength(512);
		} finally {
			errorSpy.mockRestore();
		}

		await handlers.get("session_shutdown")?.({ type: "session_shutdown" }, sessionContext);
	},
	75_000,
);
isolatedSdkHostTest(
	"SDK host does not log a client cancellation as a prompt terminal failure",
	async () => {
		const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "gjc-sdk-prompt-terminal-cancel-"));
		dirs.push(cwd);
		const sessionId = `sdk-prompt-terminal-cancel-${Date.now()}`;
		const sessionContext = context(cwd, sessionId);
		const handlers = await start(sessionContext);
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
			const cancelled: AgentEndEvent = { type: "agent_end", stopReason: "cancelled", messages: [] };
			await handlers.get("agent_start")?.({ type: "agent_start" }, sessionContext);
			await handlers.get("agent_failed")?.(
				{ type: "agent_failed", error: Object.assign(new Error("cancel secret"), { code: "aborted" }) },
				sessionContext,
			);
			await handlers.get("agent_end")?.(cancelled, sessionContext);
			await waitFor(() => frames.some(frame => frame.type === "agent_failed"), "cancelled prompt terminal");
			expect(frames.find(frame => frame.type === "agent_failed")).toMatchObject({
				error: { code: "aborted", message: "Prompt submission failed." },
			});

			// A user interrupt is intent, not an undiagnosable defect, so it must not
			// pollute the operator log with an error for every cancel.
			expect(diagnostics).toHaveLength(0);
		} finally {
			errorSpy.mockRestore();
		}

		await handlers.get("session_shutdown")?.({ type: "session_shutdown" }, sessionContext);
	},
	75_000,
);
