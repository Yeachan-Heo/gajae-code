import { describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Agent } from "@gajae-code/agent-core";
import { getBundledModel } from "@gajae-code/ai";
import { createMockModel } from "@gajae-code/ai/providers/mock";
import { Settings } from "../src/config/settings";
import type { ExtensionAPI, ExtensionContext, ExtensionEvent } from "../src/extensibility/extensions";
import { createSdkSessionRuntimeExtension, terminalStoppedOutcome } from "../src/sdk/host/session-runtime";
import type { SdkFrame } from "../src/sdk/host/types";
import { AgentSession, type AgentSessionEvent } from "../src/session/agent-session";
import { SessionManager } from "../src/session/session-manager";

/**
 * The SDK-only host publishes the lifecycle boundary that settles an externally
 * submitted prompt. An ACP client matches that terminal against the correlation
 * it was acknowledged under and requires a normalized outcome, so a boundary
 * missing either field leaves the client reporting `working` forever even though
 * the turn finished. Measured against Paseo 0.6.1 attached to a live interactive
 * session: the bare `{ type, sessionId }` frame was dropped as
 * `incomplete_correlation`, then as an omitted normalized outcome.
 */
describe("terminalStoppedOutcome", () => {
	test("a completed run stops the turn on the agent's own authority", () => {
		expect(terminalStoppedOutcome("completed", undefined)).toEqual({
			kind: "stopped",
			reason: "end_turn",
			provenance: "agent",
		});
	});

	test("an absent stop reason is treated as a normal end, not an error", () => {
		expect(terminalStoppedOutcome(undefined, undefined)).toEqual({
			kind: "stopped",
			reason: "end_turn",
			provenance: "agent",
		});
	});

	test("a suspended run still ends the turn rather than reporting a cancel", () => {
		expect(terminalStoppedOutcome("paused", undefined)).toEqual({
			kind: "stopped",
			reason: "end_turn",
			provenance: "agent",
		});
	});

	test("an explicit cancel is attributed to the client that asked for it", () => {
		expect(terminalStoppedOutcome("cancelled", undefined)).toEqual({
			kind: "stopped",
			reason: "cancelled",
			provenance: "client_cancel",
		});
	});

	test("an aborted maintenance checkpoint is the one maintenance path that ends the run", () => {
		expect(terminalStoppedOutcome("maintenance", "aborted")).toEqual({
			kind: "stopped",
			reason: "cancelled",
			provenance: "client_cancel",
		});
	});

	test("every result satisfies the ACP terminal-outcome contract", () => {
		// Mirrors the acceptance predicate in modes/acp/acp-agent.ts `terminalOutcome`:
		// a shape outside it is discarded and the prompt never settles.
		const stopReasons = ["completed", "paused", "cancelled", "maintenance", undefined] as const;
		const maintenance = [undefined, "aborted", "compacted", "checkpointed"];
		for (const stopReason of stopReasons) {
			for (const outcomeName of maintenance) {
				const outcome = terminalStoppedOutcome(stopReason, outcomeName);
				expect(outcome.kind).toBe("stopped");
				expect(["end_turn", "max_tokens", "max_turn_requests", "refusal", "cancelled"]).toContain(outcome.reason);
				expect(["agent", "client_cancel"]).toContain(outcome.provenance);
			}
		}
	});
});
test("disowned SDK steering cohorts share streams and terminals without adopting unrelated pending owners", async () => {
	const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-sdk-cohort-"));
	const model = getBundledModel("anthropic", "claude-sonnet-4-5");
	if (!model) throw new Error("Expected bundled Anthropic test model");
	const mock = createMockModel({
		responses: [{ content: ["interrupted"], delayMs: 60_000 }, { content: ["handled both steers"] }],
	});
	const agent = new Agent({
		getApiKey: () => "test-key",
		initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] },
		toolInterruptPolicy: "finish_tools",
		steeringMode: "all",
		streamFn: mock.stream,
	});
	const settings = Settings.isolated({ "compaction.enabled": false });
	settings.setModelRole("default", `${model.provider}/${model.id}`);
	const handlers = new Map<string, (event: unknown, ctx: ExtensionContext) => unknown>();
	const frames: Array<{ connectionId: string; frame: SdkFrame }> = [];
	let receive: ((connectionId: string, frame: SdkFrame) => void) | undefined;
	let ctx: ExtensionContext;
	const sessionManager = SessionManager.inMemory(cwd);
	const session = new AgentSession({
		agent,
		sessionManager,
		settings,
		modelRegistry: { getApiKey: async () => "test-key", getAuthStorageOwner: () => undefined } as never,
		extensionRunner: {
			hasHandlers: () => true,
			emitBeforeAgentStart: async () => undefined,
			emit: async (event: ExtensionEvent) => handlers.get(event.type)?.(event, ctx),
		} as never,
	});
	const api = {
		on: (event: string, handler: (event: unknown, context: ExtensionContext) => unknown) => {
			handlers.set(event, handler);
		},
		sendUserMessage: async (content: string, options: Parameters<AgentSession["sendUserMessage"]>[1]) => {
			if (content === "unrelated") {
				await options?.onPreflightAcceptCommit?.();
				options?.onQueuedPromoted?.({ startsOwnRun: true });
				return;
			}
			return session.sendUserMessage(content, options);
		},
	} as unknown as ExtensionAPI;
	createSdkSessionRuntimeExtension(api, {
		agentDir: cwd,
		settings,
		createTransport: async ({ sessionId, stateRoot, token }) => ({
			sessionId,
			stateRoot,
			token,
			onFrame: handler => {
				receive = handler;
				return () => {
					receive = undefined;
				};
			},
			sendFrame: (connectionId, frame) => {
				frames.push({ connectionId, frame });
				return "written" as const;
			},
			broadcastFrame: frame => {
				frames.push({ connectionId: "broadcast", frame });
			},
			start: async () => ({ url: "ws://127.0.0.1:1" }),
			stop: async () => {},
		}),
	});
	ctx = {
		cwd,
		sessionManager,
		isIdle: () => !agent.state.isStreaming,
		sdkBindings: () => [],
		onSessionEvent: (listener: (event: AgentSessionEvent) => void) => session.subscribe(listener),
	} as unknown as ExtensionContext;
	const waitFor = async (predicate: () => boolean) => {
		const deadline = Date.now() + 5_000;
		while (!predicate()) {
			if (Date.now() >= deadline) throw new Error("Timed out waiting for cohort lifecycle");
			await Bun.sleep(5);
		}
	};
	const submit = async (id: string, text: string) => {
		receive?.(id, { type: "control_request", id, operation: "turn.prompt", input: { text } });
		await waitFor(() => frames.some(({ frame }) => "id" in frame && frame.id === id));
		const response = frames.find(({ frame }) => "id" in frame && frame.id === id)?.frame;
		expect(response).toMatchObject({ ok: true });
		if (!response || !("result" in response)) throw new Error("Missing prompt response");
		const { commandId, turnId } = response.result as { commandId: string; turnId: string };
		return { commandId, turnId };
	};
	try {
		await handlers.get("session_start")?.({}, ctx);
		const first = session.prompt("first task");
		await waitFor(() => agent.state.isStreaming && mock.calls.length === 1);
		const a = await submit("client-a", "steer one");
		const b = await submit("client-b", "steer two");
		const unrelated = await submit("client-c", "unrelated");
		expect(session.getQueuedMessages().steering).toEqual(["steer one", "steer two"]);
		await session.abort({ cause: "user_interrupt" });
		await first.catch(() => {});
		await session.waitForIdle();
		await waitFor(
			() => frames.filter(({ frame }) => frame.type === "event" && frame.kind === "agent_end").length >= 2,
		);
		expect(mock.calls).toHaveLength(2);
		const correlationOf = (frame: SdkFrame): Record<string, unknown> =>
			frame.type === "event" && frame.payload && typeof frame.payload === "object" && "commandId" in frame.payload
				? (frame.payload as Record<string, unknown>)
				: (frame as unknown as Record<string, unknown>);
		for (const [connectionId, correlation] of [
			["client-a", a],
			["client-b", b],
		] as const) {
			const owned = frames.filter(({ frame }) => correlationOf(frame).commandId === correlation.commandId);
			expect(owned.every(entry => entry.connectionId === connectionId || entry.connectionId === "broadcast")).toBe(
				true,
			);
			expect(owned.filter(({ frame }) => frame.type === "event" && frame.kind === "agent_start")).toHaveLength(1);
			const streamed = owned.filter(({ frame }) => frame.type === "event" && frame.kind === "message_update");
			expect(streamed.length).toBeGreaterThan(0);
			expect(streamed.every(entry => entry.connectionId === connectionId)).toBe(true);
			expect(owned.filter(({ frame }) => frame.type === "event" && frame.kind === "agent_end")).toHaveLength(1);
			for (const { frame } of owned) expect(correlationOf(frame)).toMatchObject(correlation);
		}
		expect(frames.filter(({ frame }) => correlationOf(frame).commandId === unrelated.commandId)).toHaveLength(0);
		// The excluded owner is still pending and can be adopted only by its own start.
		await handlers.get("agent_start")?.({ sdkRunToken: `${unrelated.commandId}:${unrelated.turnId}` }, ctx);
		expect(
			frames.filter(
				({ frame }) =>
					frame.type === "event" &&
					frame.kind === "agent_start" &&
					correlationOf(frame).commandId === unrelated.commandId,
			),
		).toHaveLength(1);
		await handlers.get("agent_end")?.(
			{ sdkRunToken: `${unrelated.commandId}:${unrelated.turnId}`, messages: [] },
			ctx,
		);
	} finally {
		await handlers.get("session_shutdown")?.({}, ctx);
		await session.dispose();
		await fs.rm(cwd, { recursive: true, force: true });
	}
}, 20_000);
