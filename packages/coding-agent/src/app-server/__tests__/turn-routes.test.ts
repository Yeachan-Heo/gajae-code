import { expect, test } from "bun:test";
import * as path from "node:path";
import type { ThreadItem } from "../../../vendor/codex-app-server-schema/stable/typescript/v2/ThreadItem";
import type { Turn } from "../../../vendor/codex-app-server-schema/stable/typescript/v2/Turn";
import { experimentalValidators, stableValidators } from "../protocol-source/schema-validators.generated";
import { ConnectionState } from "../router/connection-state";
import { type InboundContext, processInbound } from "../server";
import type { ChildBridgeOptions, SessionClient, SessionRequestOptions } from "../thread-runtime/child-bridge";
import {
	type EndpointAuthority,
	type ThreadEffectiveSettings,
	ThreadRuntimeManager,
} from "../thread-runtime/thread-runtime-manager";
import { TurnController, TurnControllerError } from "../thread-runtime/turn-controller";
import {
	makeTurnCreatedRecord,
	makeTurnItemCompletedRecord,
	makeTurnTerminalRecord,
	type ProjectionEnvelope,
} from "../thread-runtime/turn-projection";

const THREAD_ID = "turn-route-thread";
const COMMAND_ID = "child-command";
const CHILD_TURN_ID = "child-turn";
const APP_TURN_ID = "app-turn-route";

const enc = (value: string) => new TextEncoder().encode(value);
const dec = (value: Uint8Array | undefined) =>
	value ? (JSON.parse(new TextDecoder().decode(value)) as Record<string, unknown>) : undefined;
const errorCode = (result: { response?: Uint8Array }): number =>
	(dec(result.response)!.error as Record<string, unknown>).code as number;

const authority = (generation: number): EndpointAuthority => ({
	endpointGeneration: generation,
	endpointIncarnation: "d".repeat(64),
	endpointMtimeMs: 1,
	pid: 4321,
});

const effectiveSettings = (sessionId: string, cwd: string): ThreadEffectiveSettings => ({
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
});

const persistedItem: ThreadItem = {
	type: "agentMessage",
	id: "persisted-item",
	text: "persisted answer",
	phase: null,
	memoryCitation: null,
};

const persistedTurn = (status: Turn["status"] = "completed"): Turn => ({
	id: APP_TURN_ID,
	items: [persistedItem],
	itemsView: "full",
	status,
	error: null,
	startedAt: 10,
	completedAt: 11,
	durationMs: 1_000,
});

/** Durable history for one completed turn, in the exact production wrapper shape. */
function persistedHistory(): ProjectionEnvelope[] {
	return [
		makeTurnCreatedRecord({
			turn: { ...persistedTurn("inProgress"), items: [], completedAt: null, durationMs: null },
			commandId: COMMAND_ID,
			turnId: CHILD_TURN_ID,
			clientRef: APP_TURN_ID,
		}),
		makeTurnItemCompletedRecord(
			{ turnId: APP_TURN_ID, item: persistedItem, order: 0 },
			{ commandId: COMMAND_ID, turnId: CHILD_TURN_ID },
			APP_TURN_ID,
		),
		makeTurnTerminalRecord({ turn: persistedTurn() }, { commandId: COMMAND_ID, turnId: CHILD_TURN_ID }),
	];
}

interface FakeClientOptions {
	readonly history?: readonly ProjectionEnvelope[];
	readonly promptResult?: unknown;
	readonly promptError?: unknown;
	readonly modelOverrideError?: unknown;
}

class FakeClient implements SessionClient {
	readonly calls: Array<{ operation: string; input: Record<string, unknown> }> = [];
	closeCount = 0;

	constructor(private readonly options: FakeClientOptions = {}) {}

	onFrame(_handler: (frame: Record<string, unknown>) => void): () => void {
		return () => {};
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
		return { status: "unknown" };
	}

	async control(operation: string, input: Record<string, unknown> = {}, _options?: SessionRequestOptions) {
		this.calls.push({ operation, input });
		if (operation === "turn.prompt") {
			if (this.options.promptError !== undefined) throw this.options.promptError;
			return this.options.promptResult ?? { accepted: true, commandId: COMMAND_ID, turnId: CHILD_TURN_ID };
		}
		if (operation === "projection.append") return { entryId: "append-1", revision: 1 };
		if (operation === "projection.read") {
			const history = this.options.history ?? [];
			return {
				records: history.map((envelope, index) => ({ entryId: `projection-${index + 1}`, envelope })),
				revision: history.length,
			};
		}
		return {};
	}
	async setModelForTurn(requestedModel: string): Promise<() => Promise<void>> {
		this.calls.push({ operation: "turn.modelOverride", input: { model: requestedModel } });
		if (this.options.modelOverrideError !== undefined) throw this.options.modelOverrideError;
		return async () => {
			this.calls.push({ operation: "turn.modelOverride.restore", input: { model: requestedModel } });
		};
	}

	async close(): Promise<void> {
		this.closeCount += 1;
	}
}

async function initialized(experimentalApi = false): Promise<ConnectionState> {
	const state = new ConnectionState();
	const manager = new ThreadRuntimeManager();
	const capabilities = experimentalApi ? ',"capabilities":{"experimentalApi":true}' : "";
	await processInbound(
		state,
		manager,
		enc(`{"id":1,"method":"initialize","params":{"clientInfo":{"name":"test","version":"1"}${capabilities}}}`),
	);
	await processInbound(state, manager, enc('{"method":"initialized"}'));
	return state;
}

function loadedManager(client: SessionClient, cwd: string): ThreadRuntimeManager {
	const manager = new ThreadRuntimeManager({ maxLoadedThreads: 4 });
	manager.register(THREAD_ID, "spawned", authority(1), "conn-a", {
		sessionId: THREAD_ID,
		cwd,
		client,
		effectiveSettings: effectiveSettings(THREAD_ID, cwd),
		closeChild: async () => {},
	});
	return manager;
}

const turnStartFrame = (input: string) => enc(`{"id":2,"method":"turn/start","params":${input}}`);
const resumeFrame = (params: string) => enc(`{"id":3,"method":"thread/resume","params":${params}}`);

test("turn/start returns a validated response plus both delivery hooks and defers notifications", async () => {
	const state = await initialized();
	const cwd = path.resolve("turn-start-cwd");
	const client = new FakeClient();
	const manager = loadedManager(client, cwd);
	const notifications: string[] = [];
	const controller = new TurnController({
		manager,
		emit: notification => {
			notifications.push(notification.method);
		},
		idFactory: () => APP_TURN_ID,
	});

	const result = await processInbound(
		state,
		manager,
		turnStartFrame(`{"threadId":"${THREAD_ID}","input":[{"type":"text","text":"hello","text_elements":[]}]}`),
		undefined,
		"websocket",
		undefined,
		{ connectionId: "conn-a", turnController: controller },
	);

	const response = dec(result.response)!.result as Record<string, unknown>;
	expect(stableValidators.clientRequestResults["turn/start"](response)).toBe(true);
	expect((response.turn as Record<string, unknown>).id).toBe(APP_TURN_ID);
	expect(typeof result.responseDelivered).toBe("function");
	expect(typeof result.rollbackUndeliveredResponse).toBe("function");
	expect(notifications).toEqual([]);
	await result.responseDelivered?.();
	expect(notifications).toEqual(["turn/started"]);
	expect(client.calls.filter(call => call.operation === "turn.prompt")).toHaveLength(1);
	expect(client.calls.filter(call => call.operation === "turn.modelOverride")).toHaveLength(0);
});

test("turn/start rejects unsupported input variants and overrides before any child control", async () => {
	const state = await initialized();
	const cwd = path.resolve("turn-start-unsupported");
	for (const params of [
		`{"threadId":"${THREAD_ID}","input":[{"type":"localImage","path":"/tmp/a.png"}]}`,
		`{"threadId":"${THREAD_ID}","input":[{"type":"text","text":"ok","text_elements":[]}],"outputSchema":{"type":"object"}}`,
		`{"threadId":"${THREAD_ID}","input":[]}`,
	]) {
		const client = new FakeClient();
		const manager = loadedManager(client, cwd);
		const controller = new TurnController({ manager, emit: () => {}, idFactory: () => APP_TURN_ID });
		const result = await processInbound(state, manager, turnStartFrame(params), undefined, "websocket", undefined, {
			connectionId: "conn-a",
			turnController: controller,
		});
		expect(errorCode(result), params).toBe(-32081);
		expect(client.calls.filter(call => call.operation === "turn.prompt")).toHaveLength(0);
		expect(controller.activeTurnCount).toBe(0);
	}
});

test("turn/start honours a resolved per-turn model override before prompting the retained child", async () => {
	const state = await initialized();
	const cwd = path.resolve("turn-start-model-override");
	const client = new FakeClient();
	const manager = loadedManager(client, cwd);
	const controller = new TurnController({ manager, emit: () => {}, idFactory: () => APP_TURN_ID });
	const result = await processInbound(
		state,
		manager,
		turnStartFrame(
			`{"threadId":"${THREAD_ID}","input":[{"type":"text","text":"hello","text_elements":[]}],"model":"provider/turn-model","approvalPolicy":"never","sandboxPolicy":{"type":"dangerFullAccess"},"collaborationMode":{"mode":"default","settings":{"model":"provider/turn-model","reasoning_effort":"medium"}}}`,
		),
		undefined,
		"websocket",
		undefined,
		{ connectionId: "conn-a", turnController: controller },
	);
	const response = dec(result.response);
	expect(response?.error).toBeUndefined();
	expect(client.calls.slice(0, 2)).toEqual([
		{ operation: "turn.modelOverride", input: { model: "provider/turn-model" } },
		{ operation: "turn.prompt", input: { text: "hello", clientRef: APP_TURN_ID } },
	]);
});

test("turn/start rejects an unknown model override with the requested model named in the error", async () => {
	const state = await initialized();
	const cwd = path.resolve("turn-start-model-unknown");
	const client = new FakeClient({
		modelOverrideError: new Error('Model override "missing/model" could not be resolved.'),
	});
	const manager = loadedManager(client, cwd);
	const controller = new TurnController({ manager, emit: () => {}, idFactory: () => APP_TURN_ID });
	const result = await processInbound(
		state,
		manager,
		turnStartFrame(
			`{"threadId":"${THREAD_ID}","input":[{"type":"text","text":"hello","text_elements":[]}],"model":"missing/model"}`,
		),
		undefined,
		"websocket",
		undefined,
		{ connectionId: "conn-a", turnController: controller },
	);
	expect(dec(result.response)).toEqual({
		id: 2,
		error: { code: -32602, message: 'Model override "missing/model" could not be resolved.' },
	});
	expect(client.calls.some(call => call.operation === "turn.prompt")).toBe(false);
});
test("turn/start maps unknown threads, busy, idempotency conflict, and internal failures distinctly", async () => {
	const state = await initialized();
	const cwd = path.resolve("turn-start-errors");
	const validParams = `{"threadId":"${THREAD_ID}","input":[{"type":"text","text":"hello","text_elements":[]}]}`;

	const emptyManager = new ThreadRuntimeManager();
	const emptyController = new TurnController({ manager: emptyManager, emit: () => {} });
	const missing = await processInbound(
		state,
		emptyManager,
		turnStartFrame(validParams),
		undefined,
		"websocket",
		undefined,
		{ turnController: emptyController },
	);
	expect(errorCode(missing)).toBe(-32010);

	const cases: Array<{ code: number; controllerError: TurnControllerError }> = [
		{ code: -32016, controllerError: new TurnControllerError("busy", "busy") },
		{ code: -32013, controllerError: new TurnControllerError("idempotency_conflict", "conflict") },
		{ code: -32603, controllerError: new TurnControllerError("projection_corrupt", "corrupt") },
		{ code: -32603, controllerError: new TurnControllerError("recovery_required", "recovery") },
	];
	for (const { code, controllerError } of cases) {
		const client = new FakeClient();
		const manager = loadedManager(client, cwd);
		const controller = new TurnController({ manager, emit: () => {} });
		controller.start = async () => {
			throw controllerError;
		};
		const result = await processInbound(
			state,
			manager,
			turnStartFrame(validParams),
			undefined,
			"websocket",
			undefined,
			{
				turnController: controller,
			},
		);
		expect(errorCode(result), controllerError.code).toBe(code);
	}
});

test("thread/resume reconstructs durable turns for stable and experimental profiles exactly once", async () => {
	const cwd = path.resolve("resume-cwd");
	for (const experimentalApi of [false, true]) {
		const state = await initialized(experimentalApi);
		const client = new FakeClient({ history: persistedHistory() });
		const manager = loadedManager(client, cwd);
		let subscribed = 0;
		const context: InboundContext = {
			connectionId: "conn-a",
			subscribe: () => {
				subscribed += 1;
			},
		};
		const result = await processInbound(
			state,
			manager,
			resumeFrame(`{"threadId":"${THREAD_ID}"}`),
			undefined,
			"websocket",
			undefined,
			context,
		);
		const response = dec(result.response)!.result as Record<string, unknown>;
		const validators = experimentalApi ? experimentalValidators : stableValidators;
		expect(validators.clientRequestResults["thread/resume"](response)).toBe(true);
		const turns = (response.thread as { turns: Turn[] }).turns;
		expect(turns).toEqual([persistedTurn()]);
		expect(turns[0]?.items).toHaveLength(1);
		expect(client.calls.filter(call => call.operation === "projection.read")).toHaveLength(1);
		if (experimentalApi) {
			expect(response.initialTurnsPage).toBeNull();
			expect(response.turnsBackwardsCursor).toBeNull();
			expect(response.itemsBackwardsCursor).toBeNull();
		} else {
			expect(response).not.toHaveProperty("initialTurnsPage");
			expect(response).not.toHaveProperty("runtimeWorkspaceRoots");
		}
		expect(subscribed).toBe(0);
		await result.responseDelivered?.();
		expect(subscribed).toBe(1);
	}
});

test("thread/resume fails closed on empty durable history instead of returning empty turns", async () => {
	const state = await initialized();
	const cwd = path.resolve("resume-empty");
	const client = new FakeClient({ history: [] });
	const manager = loadedManager(client, cwd);
	const result = await processInbound(
		state,
		manager,
		resumeFrame(`{"threadId":"${THREAD_ID}"}`),
		undefined,
		"websocket",
		undefined,
		{ connectionId: "conn-a" },
	);
	expect(errorCode(result)).toBe(-32603);
});

test("thread/resume rejects unsupported override variants before attachment", async () => {
	const state = await initialized();
	const cwd = path.resolve("resume-unsupported");
	for (const params of [
		`{"threadId":"${THREAD_ID}","model":"other"}`,
		`{"threadId":"${THREAD_ID}","path":"/tmp/rollout.jsonl"}`,
		`{"threadId":"${THREAD_ID}","excludeTurns":true}`,
	]) {
		const client = new FakeClient({ history: persistedHistory() });
		const manager = loadedManager(client, cwd);
		const result = await processInbound(state, manager, resumeFrame(params), undefined, "websocket", undefined, {
			connectionId: "conn-a",
		});
		expect(errorCode(result), params).toBe(-32081);
		expect(client.calls.filter(call => call.operation === "projection.read")).toHaveLength(0);
	}
});

test("thread/resume attaches an absent thread and rolls back only the newly attached runtime", async () => {
	const state = await initialized();
	const cwd = path.resolve("resume-attach");
	const client = new FakeClient({ history: persistedHistory() });
	const manager = new ThreadRuntimeManager({ maxLoadedThreads: 4 });
	let createdOwnership: string | undefined;
	const adapter: ChildBridgeOptions = {
		manager,
		create: async request => {
			createdOwnership = request.ownership;
			return {
				sessionId: THREAD_ID,
				cwd,
				client,
				awaitReady: async () => {},
				effectiveSettings: effectiveSettings(THREAD_ID, cwd),
			};
		},
	};
	const result = await processInbound(
		state,
		manager,
		resumeFrame(`{"threadId":"${THREAD_ID}"}`),
		undefined,
		"websocket",
		undefined,
		{ connectionId: "conn-a", threadStartAdapter: adapter },
	);

	const response = dec(result.response)!.result as Record<string, unknown>;
	expect(stableValidators.clientRequestResults["thread/resume"](response)).toBe(true);
	expect(createdOwnership).toBe("attached");
	expect(manager.loadedCount).toBe(1);

	await result.rollbackUndeliveredResponse?.();
	expect(manager.loadedCount).toBe(0);
	expect(client.closeCount).toBe(1);
});

test("thread/resume without a loaded thread or injected adapter remains not supported", async () => {
	const state = await initialized();
	const manager = new ThreadRuntimeManager();
	const result = await processInbound(
		state,
		manager,
		resumeFrame(`{"threadId":"${THREAD_ID}"}`),
		undefined,
		"websocket",
		undefined,
		{ connectionId: "conn-a" },
	);
	expect(errorCode(result)).toBe(-32081);
});
