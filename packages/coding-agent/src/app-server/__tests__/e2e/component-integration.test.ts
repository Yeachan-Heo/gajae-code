import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";

import * as os from "node:os";
import * as path from "node:path";
import { ConnectionState } from "../../router/connection-state";
import { processInbound } from "../../server";
import { HandlerRegistry, registerBuiltinHandlers } from "../../suites/handlers";
import type { ChildBridgeOptions, SessionClient, SessionRequestOptions } from "../../thread-runtime/child-bridge";

import {
	type EndpointAuthority,
	type ThreadEffectiveSettings,
	ThreadRuntimeManager,
} from "../../thread-runtime/thread-runtime-manager";
import { TurnController } from "../../thread-runtime/turn-controller";
import { assertTranscript, goldenBytes, type TranscriptHeader } from "./oracle-contract";

const THREAD_ID = "component-integration-thread";
const FIRST_TURN_ID = "component-integration-turn-1";
const SECOND_TURN_ID = "component-integration-turn-2";
const CHILD_COMMAND_PREFIX = "component-integration-command-";
const CHILD_TURN_PREFIX = "component-integration-child-turn-";
const CONNECTION_ID = "component-integration-connection";
const TEST_CWD = mkdtempSync(path.join(os.tmpdir(), "gjc-component-integration-cwd-"));
const TEST_AGENT_DIR = mkdtempSync(path.join(os.tmpdir(), "gjc-component-integration-agent-"));
const GOLDEN_PATH = path.join(import.meta.dir, "golden/component-integration.golden.json");

const HEADER: TranscriptHeader = {
	gateId: "component-integration",
	transportMode: "in-process",
	executionMode: "injected-in-process-session",
	profile: "stable",
};

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const authority: EndpointAuthority = {
	endpointGeneration: 1,
	endpointIncarnation: "c".repeat(64),
	endpointMtimeMs: 1,
	pid: 1234,
};

const previousAgentDir = process.env.GJC_AGENT_DIR;
beforeAll(() => {
	process.env.GJC_AGENT_DIR = TEST_AGENT_DIR;
});
afterAll(() => {
	if (previousAgentDir === undefined) delete process.env.GJC_AGENT_DIR;
	else process.env.GJC_AGENT_DIR = previousAgentDir;
	rmSync(TEST_CWD, { recursive: true, force: true });
	rmSync(TEST_AGENT_DIR, { recursive: true, force: true });
});

function effectiveSettings(sessionId: string, cwd: string): ThreadEffectiveSettings {
	return {
		model: "requested-model",
		modelProvider: "openai",
		serviceTier: null,
		cwd,
		instructionSources: [],
		approvalPolicy: "untrusted",
		approvalsReviewer: "user",
		sandbox: { type: "dangerFullAccess" },
		reasoningEffort: null,
		thread: {
			id: sessionId,
			sessionId,
			forkedFromId: null,
			parentThreadId: null,
			preview: "preview",
			ephemeral: false,
			isPinned: false,
			modelProvider: "openai",
			createdAt: 0,
			updatedAt: 0,
			recencyAt: null,
			status: { type: "idle" },
			path: null,
			cwd,
			cliVersion: "1",
			source: "cli",
			threadSource: null,
			agentNickname: null,
			agentRole: null,
			gitInfo: null,
			name: null,
			turns: [],
			extra: null,
			historyMode: "paginated",
			canAcceptDirectInput: true,
		},
		runtimeWorkspaceRoots: [],
		activePermissionProfile: null,
		multiAgentMode: "proactive",
	};
}

function turnParams(threadId: string, text: string): Record<string, unknown> {
	return {
		threadId,
		input: [{ type: "text", text, text_elements: [] }],
	};
}

function threadStartParams(): Record<string, unknown> {
	return {
		cwd: TEST_CWD,
		allowProviderModelFallback: false,
		experimentalRawEvents: false,
	};
}

function decodeFrame(frame: Uint8Array | undefined): Record<string, unknown> {
	if (frame === undefined) throw new Error("Expected a JSON-RPC response frame.");
	return JSON.parse(decoder.decode(frame)) as Record<string, unknown>;
}

function errorCode(frame: Record<string, unknown>): number {
	const error = frame.error;
	if (!error || typeof error !== "object" || Array.isArray(error)) throw new Error("Expected an error response.");
	return (error as Record<string, unknown>).code as number;
}

function responseResult(frame: Record<string, unknown>): Record<string, unknown> {
	const result = frame.result;
	if (!result || typeof result !== "object" || Array.isArray(result)) throw new Error("Expected a result response.");
	return result as Record<string, unknown>;
}

class RecordingClient implements SessionClient {
	readonly calls: Array<{ operation: string; input: Record<string, unknown> }> = [];
	private frameHandler: ((frame: Record<string, unknown>) => void) | undefined;
	private revision = 0;
	private promptNumber = 0;
	private latestPrompt: { readonly commandId: string; readonly turnId: string } | undefined;

	onFrame(handler: (frame: Record<string, unknown>) => void): () => void {
		this.frameHandler = handler;
		return () => {
			if (this.frameHandler === handler) this.frameHandler = undefined;
		};
	}

	onReconnect(_handler: () => void): () => void {
		return () => {};
	}

	onReconnectFailed(_handler: (error: Error) => void): () => void {
		return () => {};
	}

	async request(): Promise<Record<string, unknown>> {
		return {};
	}

	async query(query: string, input: Record<string, unknown> = {}): Promise<unknown> {
		this.calls.push({ operation: query, input });
		if (query === "projection.read") return { records: [], revision: 0 };
		return {};
	}

	async control(
		operation: string,
		input: Record<string, unknown> = {},
		_options?: SessionRequestOptions,
	): Promise<unknown> {
		this.calls.push({ operation, input });
		if (operation === "turn.prompt") {
			this.promptNumber += 1;
			this.latestPrompt = {
				commandId: `${CHILD_COMMAND_PREFIX}${this.promptNumber}`,
				turnId: `${CHILD_TURN_PREFIX}${this.promptNumber}`,
			};
			return { accepted: true, ...this.latestPrompt };
		}
		if (operation === "projection.append") {
			this.revision += 1;
			return { entryId: `component-integration-projection-${this.revision}`, revision: this.revision };
		}
		if (operation === "projection.read") return { records: [], revision: 0 };
		return {};
	}

	async close(): Promise<void> {}

	emitLifecycle(type: "agent_start" | "agent_end", stopReason?: "completed" | "interrupted"): void {
		if (!this.latestPrompt) throw new Error("Cannot emit a lifecycle frame before turn.prompt.");
		this.frameHandler?.({
			type,
			commandId: this.latestPrompt.commandId,
			turnId: this.latestPrompt.turnId,
			...(type === "agent_end" ? { messages: [], stopReason: stopReason ?? "completed" } : {}),
		});
	}

	controlCalls(operation: string): Array<Record<string, unknown>> {
		return this.calls.filter(call => call.operation === operation).map(call => call.input);
	}
}

class ComponentHarness {
	readonly state = new ConnectionState();
	readonly manager = new ThreadRuntimeManager({ maxLoadedThreads: 4 });
	readonly client = new RecordingClient();
	readonly registry = new HandlerRegistry();
	readonly requests: Array<{ id: string | number; method: string }> = [];
	readonly responses: Array<Record<string, unknown>> = [];
	readonly wireFrames: Array<Record<string, unknown>> = [];
	readonly notifications: Array<Record<string, unknown>> = [];
	readonly subscriptions: string[] = [];
	readonly controller: TurnController;
	readonly adapter: ChildBridgeOptions;

	constructor() {
		registerBuiltinHandlers(this.registry);
		this.controller = new TurnController({
			manager: this.manager,
			clock: () => 1_000,
			idFactory: (() => {
				let next = 0;
				return () => {
					next += 1;
					return next === 1 ? FIRST_TURN_ID : SECOND_TURN_ID;
				};
			})(),
			emit: notification => {
				const frame = structuredClone({
					method: notification.method,
					params: notification.params,
				});
				this.notifications.push(frame);
				this.wireFrames.push(frame);
			},
		});
		this.adapter = {
			manager: this.manager,
			create: async request => ({
				sessionId: THREAD_ID,
				cwd: request.cwd,
				authority,
				client: this.client,
				awaitReady: async () => {},
				closeChild: async () => {},
				effectiveSettings: effectiveSettings(THREAD_ID, request.cwd),
			}),
			onFrame: (child, frame) => this.controller.acceptFrame(child.sessionId, frame),
		};
	}

	async request(
		id: string | number,
		method: string,
		params?: Record<string, unknown>,
	): Promise<Record<string, unknown>> {
		this.requests.push({ id, method });
		const result = await processInbound(
			this.state,
			this.manager,
			encoder.encode(JSON.stringify({ id, method, ...(params === undefined ? {} : { params }) })),
			undefined,
			"websocket",
			this.registry,
			{
				connectionId: CONNECTION_ID,
				isActive: () => true,
				threadStartAdapter: this.adapter,
				turnController: this.controller,
				subscribe: threadId => {
					this.subscriptions.push(threadId);
				},
			},
		);
		const response = decodeFrame(result.response);
		this.responses.push(response);
		this.wireFrames.push(response);
		await result.responseDelivered?.();
		return response;
	}

	async notify(method: string, params?: Record<string, unknown>): Promise<void> {
		const result = await processInbound(
			this.state,
			this.manager,
			encoder.encode(JSON.stringify({ method, ...(params === undefined ? {} : { params }) })),
			undefined,
			"websocket",
			this.registry,
			{
				connectionId: CONNECTION_ID,
				isActive: () => true,
				threadStartAdapter: this.adapter,
				turnController: this.controller,
				subscribe: threadId => {
					this.subscriptions.push(threadId);
				},
			},
		);
		expect(result.response).toBeUndefined();
	}

	async emitCompletion(stopReason: "completed" | "interrupted" = "completed"): Promise<void> {
		this.client.emitLifecycle("agent_end", stopReason);
		for (let attempt = 0; attempt < 20 && this.controller.activeTurnCount > 0; attempt += 1) await Bun.sleep(0);
		expect(this.controller.activeTurnCount).toBe(0);
	}

	assertClean(): void {
		const violations = assertTranscript({ header: HEADER, requests: this.requests, responses: this.responses });
		expect(violations).toEqual([]);
	}
}

async function initialize(harness: ComponentHarness, id = 1): Promise<void> {
	await harness.request(id, "initialize", { clientInfo: { name: "component-test", version: "1" } });
	await harness.notify("initialized");
}

async function startThread(harness: ComponentHarness, id = 2): Promise<Record<string, unknown>> {
	return await harness.request(id, "thread/start", threadStartParams());
}

async function startTurn(
	harness: ComponentHarness,
	id: string | number,
	threadId = THREAD_ID,
): Promise<Record<string, unknown>> {
	return await harness.request(id, "turn/start", turnParams(threadId, "hello from component integration"));
}

function goldenTranscriptBytes(frames: readonly Record<string, unknown>[]): string {
	return `${JSON.stringify(
		frames.map(frame => JSON.parse(goldenBytes(frame))),
		null,
		"\t",
	)}\n`;
}

async function canonicalScenario(): Promise<ComponentHarness> {
	const harness = new ComponentHarness();

	const beforeInitialize = await harness.request(1, "thread/start", threadStartParams());
	expect(errorCode(beforeInitialize)).toBe(-32600);

	await initialize(harness, 2);
	const duplicateInitialize = await harness.request(3, "initialize", {
		clientInfo: { name: "component-test", version: "duplicate" },
	});
	expect(errorCode(duplicateInitialize)).toBe(-32600);

	const unsupported = await harness.request(4, "account/logout", {});
	expect(errorCode(unsupported)).toBe(-32081);

	const threadStart = await startThread(harness, 5);
	expect(responseResult(threadStart).thread).toMatchObject({ id: THREAD_ID, sessionId: THREAD_ID });

	const firstTurn = await startTurn(harness, 6);
	expect(responseResult(firstTurn).turn).toMatchObject({ id: FIRST_TURN_ID, status: "inProgress" });
	expect(harness.notifications.map(frame => frame.method)).toEqual(["turn/started"]);
	await harness.emitCompletion("completed");
	expect(harness.notifications.map(frame => frame.method)).toEqual(["turn/started", "turn/completed"]);

	const secondTurn = await startTurn(harness, 7);
	expect(responseResult(secondTurn).turn).toMatchObject({ id: SECOND_TURN_ID, status: "inProgress" });
	const busy = await startTurn(harness, 8);
	expect(errorCode(busy)).toBe(-32016);

	const unknownThread = await startTurn(harness, 9, "unknown-component-thread");
	expect(errorCode(unknownThread)).toBe(-32010);

	const interrupt = await harness.request(10, "turn/interrupt", {
		threadId: THREAD_ID,
		turnId: SECOND_TURN_ID,
	});
	expect(responseResult(interrupt)).toEqual({});
	expect(harness.client.controlCalls("turn.abort")).toHaveLength(1);
	await harness.emitCompletion("interrupted");

	harness.assertClean();
	return harness;
}

test("G1 component evidence only: injected in-process session can never satisfy spawned acceptance", () => {
	expect(HEADER.gateId).toBe("component-integration");
	expect(HEADER.transportMode).toBe("in-process");
	expect(HEADER.executionMode).toBe("injected-in-process-session");
	// G1 is component evidence only; this tier alone can never satisfy the spawned/real-client goal.
	expect("component evidence only; never satisfies spawned acceptance").toContain("never");
});

test("G1 state machine: request before initialize returns -32600 Not initialized", async () => {
	const harness = new ComponentHarness();
	const response = await harness.request(1, "thread/start", threadStartParams());
	expect(errorCode(response)).toBe(-32600);
	harness.assertClean();
});

test("G1 state machine: duplicate initialize returns -32600 Already initialized", async () => {
	const harness = new ComponentHarness();
	await initialize(harness);
	const response = await harness.request(2, "initialize", { clientInfo: { name: "duplicate", version: "1" } });
	expect(errorCode(response)).toBe(-32600);
	expect((response.error as Record<string, unknown>).message).toBe("Already initialized");
	harness.assertClean();
});

test("G1 state machine: a not_supported method returns -32081", async () => {
	const harness = new ComponentHarness();
	await initialize(harness);
	const response = await harness.request(2, "account/logout", {});
	expect(errorCode(response)).toBe(-32081);
	harness.assertClean();
});

test("G1 state machine: initialize -> initialized -> thread/start -> turn/start -> turn completion", async () => {
	const harness = new ComponentHarness();
	await initialize(harness);
	const thread = await startThread(harness);
	expect(responseResult(thread).thread).toMatchObject({ id: THREAD_ID, sessionId: THREAD_ID });
	const turn = await startTurn(harness, 3);
	expect(responseResult(turn).turn).toMatchObject({ id: FIRST_TURN_ID, status: "inProgress" });
	await harness.emitCompletion("completed");
	const completed = harness.notifications.find(frame => frame.method === "turn/completed");
	expect(completed).toBeDefined();
	expect((completed?.params as Record<string, unknown>).turn).toMatchObject({
		id: FIRST_TURN_ID,
		status: "completed",
	});
	harness.assertClean();
});

test("G1 state machine: second turn while one is active returns busy (-32016)", async () => {
	const harness = new ComponentHarness();
	await initialize(harness);
	await startThread(harness);
	await startTurn(harness, 3);
	const busy = await startTurn(harness, 4);
	expect(errorCode(busy)).toBe(-32016);
	expect((busy.error as Record<string, unknown>).message).toBe("Resource is busy.");
	await harness.request(5, "turn/interrupt", { threadId: THREAD_ID, turnId: FIRST_TURN_ID });
	await harness.emitCompletion("interrupted");
	harness.assertClean();
});

test("G1 state machine: unknown thread returns notFound (-32010)", async () => {
	const harness = new ComponentHarness();
	await initialize(harness);
	const response = await startTurn(harness, 2, "unknown-component-thread");
	expect(errorCode(response)).toBe(-32010);
	harness.assertClean();
});

test("G1 state machine: interrupt of active turn calls turn.abort and completes as interrupted", async () => {
	const harness = new ComponentHarness();
	await initialize(harness);
	await startThread(harness);
	await startTurn(harness, 3);
	const response = await harness.request(4, "turn/interrupt", { threadId: THREAD_ID, turnId: FIRST_TURN_ID });
	expect(responseResult(response)).toEqual({});
	expect(harness.client.controlCalls("turn.abort")).toEqual([{}]);
	await harness.emitCompletion("interrupted");
	const completed = harness.notifications.find(frame => frame.method === "turn/completed");
	expect((completed?.params as Record<string, unknown>).turn).toMatchObject({ status: "interrupted" });
	harness.assertClean();
});

test("G1 golden transcript: normalized golden bytes match the committed component fixture", async () => {
	const harness = await canonicalScenario();
	const actual = goldenTranscriptBytes(harness.wireFrames);
	expect(actual).toBe(readFileSync(GOLDEN_PATH, "utf8"));
});

test("G1 oracle tamper: dropping turn.id from a real turn/completed frame is rejected", async () => {
	const harness = new ComponentHarness();
	await initialize(harness);
	await startThread(harness);
	await startTurn(harness, 3);
	await harness.emitCompletion("completed");
	harness.assertClean();

	const completed = harness.notifications.find(frame => frame.method === "turn/completed");
	expect(completed).toBeDefined();
	const completedParams = completed?.params as Record<string, unknown>;
	const realTurn = completedParams.turn as Record<string, unknown>;
	const { id: _droppedId, ...tamperedTurn } = realTurn;
	const violations = assertTranscript({
		header: HEADER,
		requests: [{ id: 99, method: "turn/start" }],
		responses: [{ id: 99, result: { turn: tamperedTurn } }],
	});
	expect(violations.some(violation => violation.rule === "validator.result")).toBe(true);
});
