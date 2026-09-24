import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Agent } from "@gajae-code/agent-core";
import { createMockModel } from "@gajae-code/ai/providers/mock";
import { Settings } from "../src/config/settings";
import type { ExtensionAPI, ExtensionContext } from "../src/extensibility/extensions";
import { createSdkSessionRuntimeExtension } from "../src/sdk/host/session-runtime";
import type { SdkFrame } from "../src/sdk/host/types";
import { AgentSession } from "../src/session/agent-session";
import { SessionManager } from "../src/session/session-manager";

/**
 * A prompt submitted to a session with no selected model must be refused by the
 * REAL SDK session runtime: `createSdkSessionRuntimeExtension` builds the private
 * `createControlSurface`, whose `submit` reserves an admission in
 * `InvocationReconciliation` BEFORE the producer runs. The refusal therefore has
 * to release that reservation, or the client's `clientRef` stays retained and a
 * retry answers `client_ref_conflict` instead of the real diagnostic.
 *
 * The producer here is a live `AgentSession` with no model, bridged exactly the
 * way production bridges it (`modes/runtime-init.ts`: the extension's
 * `sendUserMessage` forwards content and options, preflight callbacks included).
 * The code and message are asserted as literals because they are the wire
 * contract, not an implementation detail.
 */
const EXPECTED_CODE = "model_not_selected";
const EXPECTED_MESSAGE = "No model is selected for this session. Select a model before submitting a prompt.";

interface ControlResponse {
	ok?: boolean;
	error?: { code?: string; message?: string };
	result?: Record<string, unknown>;
}

interface RuntimeHarness {
	control(operation: string, input: Record<string, unknown>): Promise<ControlResponse>;
	query(query: string, input: Record<string, unknown>): Promise<ControlResponse>;
	session: AgentSession;
	sessionManager: SessionManager;
	restoreModel(): void;
	streamCalls(): number;
	aborts(): number;
	produced(): readonly string[];
	stop(): Promise<void>;
}

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
	for (const cleanup of cleanups.splice(0)) await cleanup();
});

async function startRuntimeHarness(): Promise<RuntimeHarness> {
	const cwd = await mkdtemp(path.join(os.tmpdir(), "gjc-missing-model-runtime-"));
	const sessionId = `missing-model-runtime-${Date.now()}`;
	let streamCalls = 0;
	let aborts = 0;
	const produced: string[] = [];
	const mock = createMockModel({ responses: [{ content: ["ok"] }] });
	const agent = new Agent({
		// The exact failing state: SDK prompt admission with no resolved model.
		initialState: { model: undefined, systemPrompt: ["test"], messages: [], tools: [] },
		streamFn: (model, context, options) => {
			streamCalls++;
			return mock.stream(model, context, options);
		},
	});
	const sessionManager = SessionManager.inMemory(cwd);
	const session = new AgentSession({
		agent,
		sessionManager,
		settings: Settings.isolated({ "compaction.enabled": false }),
		modelRegistry: { getApiKey: async () => "registry-api-key", getAvailable: () => [] } as never,
	});
	const handlers = new Map<string, (event: unknown, ctx: ExtensionContext) => Promise<void> | void>();
	const waiters = new Map<string, (frame: ControlResponse) => void>();
	let receive: ((connectionId: string, frame: SdkFrame) => void) | undefined;
	let nextId = 0;
	const api = {
		on(event: string, handler: (event: unknown, ctx: ExtensionContext) => Promise<void> | void) {
			handlers.set(event, handler);
		},
		// Production bridge (`modes/runtime-init.ts`): forward the submission and its
		// options — preflight callbacks, preflight signal, run capability — verbatim
		// to the live session, so the rejection is the one production produces.
		sendUserMessage: async (content: string, options?: Record<string, unknown>) => {
			produced.push(String(content));
			return await session.sendUserMessage(content, options as never);
		},
	} as unknown as ExtensionAPI;
	createSdkSessionRuntimeExtension(api, {
		agentDir: path.join(cwd, ".gjc", "agent"),
		createTransport: async ({ sessionId: id, stateRoot, token }) => ({
			sessionId: id,
			stateRoot,
			token,
			onFrame(handler) {
				receive = handler;
				return () => {
					if (receive === handler) receive = undefined;
				};
			},
			sendFrame(_connectionId, frame) {
				const response = frame as ControlResponse & { id?: unknown };
				if (typeof response.id === "string") waiters.get(response.id)?.(response);
				return "written" as const;
			},
			broadcastFrame() {},
			onNegotiatedCapabilities() {
				return () => {};
			},
			start: async () => ({ url: "ws://127.0.0.1:1" }),
			stop: async () => {},
		}),
	});
	const ctx = {
		cwd,
		workflowGate: undefined,
		sdkBindings: () => [],
		isIdle: () => !session.isStreaming,
		abort: () => {
			aborts++;
		},
		onSessionEvent: () => () => {},
		sessionManager: {
			getSessionId: () => sessionId,
			getSessionFile: () => path.join(cwd, ".gjc", "state", `${sessionId}.jsonl`),
			getSessionName: () => undefined,
			getBranch: () => [],
		},
	} as unknown as ExtensionContext;
	await handlers.get("session_start")?.({}, ctx);
	const send = (frame: Record<string, unknown>): Promise<ControlResponse> => {
		const id = `frame-${nextId++}`;
		const { promise, resolve } = Promise.withResolvers<ControlResponse>();
		waiters.set(id, resolve);
		receive?.("client", { ...frame, id } as unknown as SdkFrame);
		return promise;
	};
	const harness: RuntimeHarness = {
		control: (operation, input) => send({ type: "control_request", operation, input }),
		query: (query, input) => send({ type: "query_request", query, input }),
		session,
		sessionManager,
		restoreModel: () => agent.setModel(mock.model),
		streamCalls: () => streamCalls,
		aborts: () => aborts,
		produced: () => produced,
		stop: async () => {
			await handlers.get("session_shutdown")?.({}, ctx);
			await session.dispose();
			await rm(cwd, { recursive: true, force: true });
		},
	};
	cleanups.push(harness.stop);
	return harness;
}

function expectNothingAdmitted(harness: RuntimeHarness): void {
	expect(harness.streamCalls()).toBe(0);
	expect(harness.session.isStreaming).toBe(false);
	expect(harness.session.agent.state.messages.filter(message => message.role === "user")).toEqual([]);
	expect(harness.sessionManager.getEntries().filter(entry => entry.type === "message")).toEqual([]);
}

test("the SDK runtime refuses a no-model prompt and releases the clientRef admission it reserved", async () => {
	const harness = await startRuntimeHarness();

	const first = await harness.control("turn.prompt", { text: "first attempt", clientRef: "runtime-ref" });
	expect(first).toMatchObject({ ok: false, error: { code: EXPECTED_CODE, message: EXPECTED_MESSAGE } });
	// Pre-acceptance refusal: no result, so no commandId/turnId/clientRef is published.
	expect(first.result).toBeUndefined();
	expect(JSON.stringify(first)).not.toContain("commandId");

	// No accepted record exists for the refused submission...
	const status = await harness.query("turn.prompt_status", { clientRef: "runtime-ref" });
	expect(status).toMatchObject({ ok: true, result: { status: "unknown" } });

	// ...and `unknown` alone cannot tell a released reservation from a retained
	// one, so re-drive the SAME clientRef on a FRESH request. The reservation was
	// released iff this reaches the live producer again and fails the same way
	// instead of answering `client_ref_conflict`.
	const second = await harness.control("turn.prompt", { text: "second attempt", clientRef: "runtime-ref" });
	expect(second).toMatchObject({ ok: false, error: { code: EXPECTED_CODE, message: EXPECTED_MESSAGE } });
	expect(second.result).toBeUndefined();
	expect(harness.produced()).toEqual(["first attempt", "second attempt"]);
	expectNothingAdmitted(harness);

	// Recovery: with a model resolved, the SAME clientRef is admitted and runs,
	// which is only possible if both the reservation and the retained-ref slot
	// were released by the refusals.
	harness.restoreModel();
	const recovered = await harness.control("turn.prompt", { text: "model restored", clientRef: "runtime-ref" });
	expect(recovered).toMatchObject({
		ok: true,
		result: { accepted: true, clientRef: "runtime-ref", commandId: expect.any(String), turnId: expect.any(String) },
	});
});

test("the SDK runtime classifies turn.abort_and_prompt identically after its real abort prelude", async () => {
	const harness = await startRuntimeHarness();

	// The production input schema carries no clientRef for this operation, so the
	// admission it reserves is anonymous and is not observable from the wire.
	const response = await harness.control("turn.abort_and_prompt", { text: "abort then prompt" });
	expect(response).toMatchObject({ ok: false, error: { code: EXPECTED_CODE, message: EXPECTED_MESSAGE } });
	expect(response.result).toBeUndefined();
	// The real abort prelude ran before the refused submission.
	expect(harness.aborts()).toBe(1);
	expect(harness.produced()).toEqual(["abort then prompt"]);
	expectNothingAdmitted(harness);
});
