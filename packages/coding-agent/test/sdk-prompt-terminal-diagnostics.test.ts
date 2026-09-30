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
 * assistant message. The SDK/ACP failure envelope carries only the bounded,
 * derived phase/category wording (see `promptFailureMessage` and
 * `sanitizePromptFailure`), never raw provider text, while the assistant message
 * can remain in the local session transcript. The bounded operator log keeps that
 * failure diagnosable without widening the SDK/ACP redaction boundary.
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

			// The legacy wire discriminator is preserved, but a post-start failure is
			// no longer described as a submission rejection.
			const failure = frames.find(frame => frame.type === "agent_failed") as Record<string, unknown>;
			expect(failure).toMatchObject({
				commandId: first.commandId,
				turnId: first.turnId,
				error: { code: "agent_error", message: "Agent run failed after execution started." },
				outcome: {
					kind: "failed",
					code: "prompt_failed",
					message: "Agent run failed after execution started.",
					provenance: "agent_failed",
					phase: "post_start",
					category: "agent_runtime",
				},
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
	"SDK host carries a bounded provider stream classifier with a post-start phase",
	async () => {
		const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "gjc-sdk-prompt-provider-stream-"));
		dirs.push(cwd);
		const sessionId = `sdk-prompt-provider-stream-${Date.now()}`;
		const sessionContext = context(cwd, sessionId);
		const reason = "upstream request failed: stream interrupted before terminal response event";
		const model = createMockModel({
			handler: {
				// Mirrors the real Responses provider catch attaching the bounded
				// classifier produced by the shared SSE parser.
				throw: Object.assign(new Error(reason), { code: "upstream_stream_interrupted" }),
			},
		});
		const agent = new Agent({
			initialState: { model, systemPrompt: ["test"], messages: [], tools: [] },
			streamFn: model.stream,
			requestMaxRetries: 0,
			streamMaxRetries: 0,
		});
		let handlers!: Map<string, (event: unknown, context: unknown) => unknown>;
		handlers = await start(sessionContext, async () => {
			await agent.prompt("work the provider failure");
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

		try {
			socket.send(
				JSON.stringify({
					type: "control_request",
					id: "provider-stream",
					operation: "turn.prompt",
					input: { text: "work the provider failure" },
				}),
			);
			await waitFor(() => frames.some(frame => frame.type === "agent_failed"), "provider stream terminal");

			const failure = frames.find(frame => frame.type === "agent_failed") as Record<string, unknown>;
			expect(failure).toMatchObject({
				error: { code: "agent_error", message: "Provider failure after execution started." },
				outcome: {
					kind: "failed",
					code: "prompt_failed",
					message: "Provider failure after execution started.",
					provenance: "agent_failed",
					phase: "post_start",
					category: "provider_transport",
					providerCode: "upstream_stream_interrupted",
				},
			});
			// Raw provider text never crosses the SDK boundary.
			expect(JSON.stringify(failure)).not.toContain(reason);
		} finally {
			unsubscribe();
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
				outcome: {
					kind: "failed",
					code: "prompt_failed",
					message: "Prompt submission failed.",
					provenance: "agent_failed",
					phase: "submission",
					category: "agent_runtime",
				},
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

isolatedSdkHostTest(
	"SDK host treats a cooperative pause as a normal prompt terminal",
	async () => {
		const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "gjc-sdk-prompt-terminal-paused-"));
		dirs.push(cwd);
		const sessionId = `sdk-prompt-terminal-paused-${Date.now()}`;
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

		const submit = async (requestId: string): Promise<void> => {
			socket.send(
				JSON.stringify({
					type: "control_request",
					id: requestId,
					operation: "turn.prompt",
					input: { text: "pause this turn", clientRef: requestId },
				}),
			);
			await waitFor(
				() => frames.some(frame => frame.type === "control_response" && frame.id === requestId),
				`prompt acknowledgement ${requestId}`,
			);
		};
		const waitForActive = async (clientRef: string): Promise<void> => {
			let lastResponse = "none";
			for (let attempt = 0; attempt < 120; attempt += 1) {
				const id = `${clientRef}-active-${attempt}`;
				socket.send(
					JSON.stringify({
						type: "query_request",
						id,
						query: "turn.result",
						input: { kind: "prompt", clientRef },
					}),
				);
				await waitFor(() => frames.some(frame => frame.id === id), `active prompt query ${clientRef}`);
				const response = frames.find(frame => frame.id === id) as
					| { result?: { status?: string; [key: string]: unknown } }
					| undefined;
				if (response !== undefined) lastResponse = JSON.stringify(response);
				if (response?.result?.status === "accepted" || response?.result?.status === "in_flight") return;
			}
			throw new Error(`prompt ${clientRef} never became in_flight; lastResponse=${lastResponse}`);
		};
		const result = async (clientRef: string): Promise<Record<string, unknown>> => {
			let lastResponse = "none";
			let responseSeen = false;
			for (let attempt = 0; attempt < 120; attempt += 1) {
				const id = `${clientRef}-result-${attempt}`;
				socket.send(
					JSON.stringify({
						type: "query_request",
						id,
						query: "turn.result",
						input: { kind: "prompt", clientRef },
					}),
				);
				await waitFor(() => frames.some(frame => frame.id === id), `terminal prompt query ${clientRef}`);
				const response = frames.find(frame => frame.id === id) as
					| { result?: { status?: string; [key: string]: unknown } }
					| undefined;
				if (response !== undefined) {
					responseSeen = true;
					lastResponse = JSON.stringify(response);
				}
				if (response?.result?.status === "failed" || response?.result?.status === "terminal_ok")
					return response.result;
				await Bun.sleep(25);
			}
			throw new Error(
				`turn.result never reported a terminal status for ${clientRef}; responseSeen=${responseSeen}; lastResponse=${lastResponse}`,
			);
		};

		try {
			await submit("paused-prompt");
			await waitForActive("paused-prompt");
			await handlers.get("agent_start")?.({ type: "agent_start" }, sessionContext);
			await handlers.get("agent_end")?.({ type: "agent_end", stopReason: "paused", messages: [] }, sessionContext);
			const paused = await result("paused-prompt");
			expect(paused.status).toBe("terminal_ok");
			expect(paused.outcome).toEqual({ kind: "stopped", reason: "end_turn", provenance: "agent" });
			expect(diagnostics).toHaveLength(0);

			await submit("paused-error-prompt");
			await waitForActive("paused-error-prompt");
			await handlers.get("agent_start")?.({ type: "agent_start" }, sessionContext);
			await handlers.get("agent_end")?.(
				{
					type: "agent_end",
					stopReason: "paused",
					messages: [{ role: "assistant", stopReason: "error", errorMessage: "provider failed" }],
				},
				sessionContext,
			);
			const failed = await result("paused-error-prompt");
			expect(failed.status).toBe("failed");
			expect(failed.outcome).toMatchObject({ kind: "failed", code: "prompt_failed", provenance: "agent_failed" });
			expect(diagnostics).toHaveLength(1);
			expect(diagnostics[0]).toMatchObject({
				loopStopReason: "paused",
				assistantStopReason: "error",
				reason: "provider failed",
			});
		} finally {
			errorSpy.mockRestore();
		}

		await handlers.get("session_shutdown")?.({ type: "session_shutdown" }, sessionContext);
	},
	75_000,
);

const F2_DIAGNOSTIC = {
	category: "auth",
	httpStatus: 401,
	code: "authentication_error",
	evidence: "structured_code",
} as const;

isolatedSdkHostTest(
	"F2 the native agent_failed producer publishes the adapter diagnostic on the real wire frame",
	async () => {
		const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "gjc-sdk-f2-thrown-"));
		dirs.push(cwd);
		const sessionId = `sdk-f2-thrown-${Date.now()}`;
		const sessionContext = context(cwd, sessionId);
		const handlers = await start(sessionContext, () => undefined);
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

		socket.send(
			JSON.stringify({
				type: "control_request",
				id: "f2-thrown",
				operation: "turn.prompt",
				input: { text: "provider refuses this turn", clientRef: "f2-thrown-ref" },
			}),
		);
		await waitFor(
			() => frames.some(frame => frame.type === "control_response" && frame.id === "f2-thrown"),
			"prompt acknowledgement",
		);

		// The real native handlers, with the payload the Agent emits: a thrown
		// provider failure whose validated diagnostic travels on the error.
		await handlers.get("agent_start")?.({ type: "agent_start" }, sessionContext);
		await handlers.get("agent_failed")?.(
			{
				type: "agent_failed",
				error: Object.assign(new Error("provider rejected sk-ant-secret-F2 https://api.example/v1"), {
					code: "provider_rejected",
					providerDiagnostic: { ...F2_DIAGNOSTIC },
				}),
			},
			sessionContext,
		);
		await waitFor(() => frames.some(frame => frame.type === "agent_failed"), "native agent_failed frame");

		const failure = frames.find(frame => frame.type === "agent_failed") as Record<string, unknown>;
		expect(failure).toMatchObject({
			error: { code: "provider_rejected", message: "Prompt submission failed.", providerDiagnostic: F2_DIAGNOSTIC },
		});
		// The published frame stays bounded: no raw body, key or URL rides along.
		expect(JSON.stringify(failure)).not.toContain("sk-ant-secret-F2");
		expect(JSON.stringify(failure)).not.toContain("api.example");

		await handlers.get("session_shutdown")?.({ type: "session_shutdown" }, sessionContext);
	},
	75_000,
);

isolatedSdkHostTest(
	"F2 the native terminal stream-error producer carries the diagnostic to the supported turn.result query",
	async () => {
		const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "gjc-sdk-f2-stream-"));
		dirs.push(cwd);
		const sessionId = `sdk-f2-stream-${Date.now()}`;
		const sessionContext = context(cwd, sessionId);
		const handlers = await start(sessionContext, () => undefined);
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

		socket.send(
			JSON.stringify({
				type: "control_request",
				id: "f2-stream",
				operation: "turn.prompt",
				input: { text: "provider fails inside the stream", clientRef: "f2-stream-ref" },
			}),
		);
		await waitFor(
			() => frames.some(frame => frame.type === "control_response" && frame.id === "f2-stream"),
			"prompt acknowledgement",
		);

		// No agent_failed frame: the failure exists only as a terminal error assistant,
		// so the diagnostic can come from nowhere but the stream-error producer itself.
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
						errorCode: "provider_unavailable",
						errorMessage: "overloaded sk-ant-secret-F2-STREAM https://api.example/v1",
						providerDiagnostic: {
							category: "provider_unavailable",
							httpStatus: 503,
							code: "overloaded_error",
							evidence: "structured_code",
						},
					},
				],
			},
			sessionContext,
		);

		// Q26 `turn.result` is a QUERY, not a control operation: it is read through
		// `query_request`, which is the supported public readback for a durable turn.
		let settled: { status?: string; error?: { code?: string }; outcome?: Record<string, unknown> } | undefined;
		let lastResponse = "none";
		for (let attempt = 0; attempt < 120 && settled === undefined; attempt += 1) {
			socket.send(
				JSON.stringify({
					type: "query_request",
					id: `f2-stream-result-${attempt}`,
					query: "turn.result",
					input: { kind: "prompt", clientRef: "f2-stream-ref" },
				}),
			);
			await Bun.sleep(25);
			const response = frames.find(frame => frame.id === `f2-stream-result-${attempt}`) as
				| { result?: { status?: string; error?: { code?: string }; outcome?: Record<string, unknown> } }
				| undefined;
			if (response !== undefined) lastResponse = JSON.stringify(response);
			if (response?.result?.status === "failed" || response?.result?.status === "terminal_ok")
				settled = response.result;
		}
		if (settled === undefined) throw new Error(`turn.result never reported a terminal status; last=${lastResponse}`);

		expect(settled.status).toBe("failed");
		expect(settled.outcome).toMatchObject({
			kind: "failed",
			code: "prompt_failed",
			provenance: "agent_failed",
			providerCode: "provider_unavailable",
			providerDiagnostic: {
				category: "provider_unavailable",
				httpStatus: 503,
				code: "overloaded_error",
				evidence: "structured_code",
			},
		});
		expect(JSON.stringify(settled)).not.toContain("sk-ant-secret-F2-STREAM");
		expect(JSON.stringify(settled)).not.toContain("api.example");

		await handlers.get("session_shutdown")?.({ type: "session_shutdown" }, sessionContext);
	},
	75_000,
);
