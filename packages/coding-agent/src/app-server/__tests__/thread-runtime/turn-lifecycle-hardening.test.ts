import { expect, test } from "bun:test";
import type { AgentMessage } from "@gajae-code/agent-core";
import type { ThreadItem } from "../../../../vendor/codex-app-server-schema/stable/typescript/v2/ThreadItem";
import type { Turn } from "../../../../vendor/codex-app-server-schema/stable/typescript/v2/Turn";
import type { SessionClient, SessionRequestOptions } from "../../thread-runtime/child-bridge";
import { ThreadRuntimeManager } from "../../thread-runtime/thread-runtime-manager";
import {
	TurnController,
	TurnControllerError,
	type TurnControllerNotification,
} from "../../thread-runtime/turn-controller";
import {
	makeTurnCreatedRecord,
	makeTurnTerminalRecord,
	ProjectionCorruptError,
	type ProjectionEnvelope,
	type ProjectionRecord,
	reconstructTurnSnapshots,
	TurnProjectionReducer,
} from "../../thread-runtime/turn-projection";

const THREAD_ID = "hardening-thread";
const COMMAND_ID = "child-command";
const CHILD_TURN_ID = "child-turn";
const APP_TURN_ID = "app-turn-hardening";

interface FakeOptions {
	readonly promptResult?: unknown;
	readonly promptError?: unknown;
	readonly promptStatus?: unknown;
}

class FakeClient implements SessionClient {
	readonly calls: Array<{ operation: string; input: Record<string, unknown> }> = [];
	readonly appended: ProjectionEnvelope[] = [];
	appendResponse: unknown;
	appendThrow: unknown;
	private revision = 0;

	constructor(private readonly options: FakeOptions = {}) {}

	onFrame(): () => void {
		return () => {};
	}

	onReconnect(): () => void {
		return () => {};
	}

	onReconnectFailed(): () => void {
		return () => {};
	}

	async request(): Promise<Record<string, unknown>> {
		return {};
	}

	async query(query: string, input: Record<string, unknown> = {}): Promise<unknown> {
		this.calls.push({ operation: query, input });
		if (query === "turn.prompt_status") return this.options.promptStatus ?? { status: "unknown" };
		return {};
	}

	async control(operation: string, input: Record<string, unknown> = {}, _options?: SessionRequestOptions) {
		this.calls.push({ operation, input });
		if (operation === "turn.prompt") {
			if (this.options.promptError !== undefined) throw this.options.promptError;
			return this.options.promptResult ?? { accepted: true, commandId: COMMAND_ID, turnId: CHILD_TURN_ID };
		}
		if (operation === "projection.append") {
			const envelope = input.envelope as ProjectionEnvelope;
			this.appended.push(envelope);
			this.revision += 1;
			if (this.appendThrow !== undefined) throw this.appendThrow;
			if (this.appendResponse !== undefined) return this.appendResponse;
			return { entryId: `append-${this.revision}`, revision: this.revision };
		}
		if (operation === "projection.read") return { records: [], revision: 0 };
		return {};
	}

	async close(): Promise<void> {}

	promptCount(): number {
		return this.calls.filter(call => call.operation === "turn.prompt").length;
	}
}

function managerWith(client: SessionClient): ThreadRuntimeManager {
	const manager = new ThreadRuntimeManager({ maxLoadedThreads: 4 });
	manager.register(THREAD_ID, "attached", undefined, undefined, { client });
	return manager;
}

function assistant(text: string, responseId = "response-1"): AgentMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "openai-responses",
		provider: "openai",
		model: "gpt",
		usage: {
			input: 1,
			output: 1,
			cacheRead: 0,
			cacheWrite: 0,
			reasoningTokens: 0,
			totalTokens: 2,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: 1,
		responseId,
	} as AgentMessage;
}

const lifecycleFrame = (type: "agent_start" | "agent_end", extra: Record<string, unknown> = {}) => ({
	type,
	commandId: COMMAND_ID,
	turnId: CHILD_TURN_ID,
	...extra,
});

const eventFrame = (event: Record<string, unknown>) => ({
	type: "event",
	kind: event.type,
	payload: { event },
	commandId: COMMAND_ID,
	turnId: CHILD_TURN_ID,
});

const flush = async () => {
	await Bun.sleep(0);
	await Bun.sleep(0);
	await Bun.sleep(0);
};

test("a definitively rejected prompt releases the admission slot instead of wedging the thread", async () => {
	for (const rejection of [
		{ label: "explicit failure result", options: { promptResult: { ok: false, error: { code: "invalid_input" } } } },
		{ label: "accepted:false result", options: { promptResult: { accepted: false } } },
		{
			label: "thrown typed rejection",
			options: { promptError: Object.assign(new Error("bad input"), { code: "invalid_input" }) },
		},
	]) {
		const client = new FakeClient(rejection.options);
		const manager = managerWith(client);
		const controller = new TurnController({ manager, emit: () => {}, idFactory: () => APP_TURN_ID });

		await expect(controller.start({ threadId: THREAD_ID, params: { text: "hi" } })).rejects.toMatchObject({
			code: "internal",
		});
		expect(client.appended, rejection.label).toHaveLength(0);
		expect(manager.get(THREAD_ID)?.activeTurn, rejection.label).toBe(false);
		expect(controller.activeTurnCount, rejection.label).toBe(0);

		// The thread must still accept a fresh turn rather than reporting busy forever.
		const accepting = new FakeClient();
		const acceptingManager = managerWith(accepting);
		const acceptingController = new TurnController({
			manager: acceptingManager,
			emit: () => {},
			idFactory: () => APP_TURN_ID,
		});
		await expect(
			acceptingController.start({ threadId: THREAD_ID, params: { text: "retry" } }),
		).resolves.toBeDefined();
	}
});

test("a canonical failed prompt status materializes the accepted turn before releasing the slot", async () => {
	// Q26 `failed` carries acceptedAt, so the prompt WAS accepted and then terminalized. Its history
	// must survive; releasing the slot without durable records would erase an accepted turn.
	const client = new FakeClient({
		promptError: new Error("request timeout"),
		promptStatus: {
			status: "failed",
			commandId: COMMAND_ID,
			turnId: CHILD_TURN_ID,
			clientRef: APP_TURN_ID,
			acceptedAt: 1,
			terminalAt: 2,
			error: { code: "prompt_failed", message: "child failed" },
		},
	});
	const manager = managerWith(client);
	const notifications: string[] = [];
	const controller = new TurnController({
		manager,
		emit: notification => {
			notifications.push(notification.method);
		},
		idFactory: () => APP_TURN_ID,
	});

	await expect(controller.start({ threadId: THREAD_ID, params: { text: "hi" } })).rejects.toMatchObject({
		code: "internal",
	});
	// This turn terminalized before any turn/start response existed, so it must stay durable-only:
	// publishing turn/completed here would precede both turn/started and the error response.
	expect(notifications).toEqual([]);
	// Never resubmitted, and both the created mapping and the failed terminal are durable.
	expect(client.promptCount()).toBe(1);
	expect(client.appended.map(record => record.recordKind)).toEqual([
		"app-server.turn.created",
		"app-server.turn.terminal",
	]);
	const terminal = client.appended.at(-1)?.payload as { turn: Turn };
	expect(terminal.turn.status).toBe("failed");
	expect(terminal.turn.error).not.toBeNull();
	// The slot is released only after that durable record exists.
	expect(manager.get(THREAD_ID)?.activeTurn).toBe(false);
	expect(controller.activeTurnCount).toBe(0);
});

test("a failed prompt status without child identities stays recovery_required", async () => {
	const client = new FakeClient({
		promptError: new Error("request timeout"),
		promptStatus: { status: "failed" },
	});
	const manager = managerWith(client);
	const controller = new TurnController({ manager, emit: () => {}, idFactory: () => APP_TURN_ID });

	await expect(controller.start({ threadId: THREAD_ID, params: { text: "hi" } })).rejects.toMatchObject({
		code: "recovery_required",
	});
	expect(client.promptCount()).toBe(1);
	expect(client.appended).toHaveLength(0);
	expect(controller.getState(THREAD_ID)).toBe("recovery_required");
});

test("an unknown prompt status still retains recovery state rather than releasing the turn", async () => {
	const client = new FakeClient({ promptError: new Error("request timeout"), promptStatus: { status: "unknown" } });
	const manager = managerWith(client);
	const controller = new TurnController({ manager, emit: () => {}, idFactory: () => APP_TURN_ID });

	await expect(controller.start({ threadId: THREAD_ID, params: { text: "hi" } })).rejects.toMatchObject({
		code: "recovery_required",
	});
	expect(client.promptCount()).toBe(1);
	expect(controller.getState(THREAD_ID)).toBe("recovery_required");
});

test("a buffered frame is never overtaken by a later terminal while turn/started is blocked", async () => {
	const client = new FakeClient();
	const manager = managerWith(client);
	const releaseStarted = Promise.withResolvers<void>();
	const notifications: string[] = [];
	const controller = new TurnController({
		manager,
		emit: async notification => {
			notifications.push(notification.method);
			if (notification.method === "turn/started") await releaseStarted.promise;
		},
		idFactory: () => APP_TURN_ID,
	});

	const handle = await controller.start({ threadId: THREAD_ID, params: { text: "hello" } });
	const streamed = assistant("streamed");
	// Observed before the barrier opens, so it must be reduced before any later terminal.
	controller.acceptFrame(THREAD_ID, eventFrame({ type: "message_start", message: streamed }));

	const delivered = handle.responseDelivered();
	await flush();
	// Arrives while turn/started is still awaiting its slow subscriber.
	controller.acceptFrame(THREAD_ID, lifecycleFrame("agent_end", { messages: [streamed], stopReason: "completed" }));
	await flush();
	releaseStarted.resolve();
	await delivered;
	await flush();

	expect(notifications).toEqual([
		"turn/started",
		"item/started",
		"item/completed",
		"turn/completed",
		"thread/tokenUsage/updated",
	]);
	const terminal = client.appended.at(-1);
	expect(terminal?.recordKind).toBe("app-server.turn.terminal");
	const terminalTurn = (terminal?.payload as { turn: Turn }).turn;
	expect(terminalTurn.items).toHaveLength(1);
	expect((terminalTurn.items[0] as { text: string }).text).toBe("streamed");
});

test("a terminal turn is disposed even when its notification delivery fails", async () => {
	const client = new FakeClient();
	const manager = managerWith(client);
	const controller = new TurnController({
		manager,
		emit: notification => {
			if (notification.method === "turn/completed") throw new Error("writer rejected");
		},
		idFactory: () => APP_TURN_ID,
	});

	const handle = await controller.start({ threadId: THREAD_ID, params: { text: "hello" } });
	await handle.responseDelivered();
	controller.acceptFrame(
		THREAD_ID,
		lifecycleFrame("agent_end", { messages: [assistant("done")], stopReason: "completed" }),
	);
	await flush();

	// The terminal was durably committed, so the turn must not linger and block later turns.
	expect(client.appended.at(-1)?.recordKind).toBe("app-server.turn.terminal");
	expect(controller.activeTurnCount).toBe(0);
	expect(manager.get(THREAD_ID)?.activeTurn).toBe(false);
	await expect(controller.start({ threadId: THREAD_ID, params: { text: "next" } })).resolves.toBeDefined();
});

test("a frame whose nested identity contradicts its envelope is rejected, not attributed", async () => {
	const client = new FakeClient();
	const manager = managerWith(client);
	const notifications: TurnControllerNotification[] = [];
	const controller = new TurnController({
		manager,
		emit: notification => {
			notifications.push(notification);
		},
		idFactory: () => APP_TURN_ID,
	});

	const handle = await controller.start({ threadId: THREAD_ID, params: { text: "hello" } });
	await handle.responseDelivered();
	notifications.length = 0;

	// Outer envelope matches the active mapping; the nested event belongs to another child turn.
	controller.acceptFrame(THREAD_ID, {
		type: "event",
		kind: "agent_end",
		commandId: COMMAND_ID,
		turnId: CHILD_TURN_ID,
		payload: {
			event: {
				type: "agent_end",
				commandId: "other-command",
				turnId: "other-turn",
				messages: [assistant("foreign")],
				stopReason: "completed",
			},
		},
	});
	await flush();

	expect(notifications).toHaveLength(0);
	expect(client.appended.some(record => record.recordKind === "app-server.turn.terminal")).toBe(false);
	expect(controller.getState(THREAD_ID)).not.toBe("terminal");
});

test("a duplicated projection source key at a new revision is corruption, not idempotence", () => {
	const created = makeTurnCreatedRecord({
		turn: {
			id: APP_TURN_ID,
			items: [],
			itemsView: "full",
			status: "inProgress",
			error: null,
			startedAt: 10,
			completedAt: null,
			durationMs: null,
		},
		commandId: COMMAND_ID,
		turnId: CHILD_TURN_ID,
		clientRef: APP_TURN_ID,
	});
	const item: ThreadItem = {
		type: "agentMessage",
		id: "item-1",
		text: "answer",
		phase: null,
		memoryCitation: null,
	};
	const terminal = makeTurnTerminalRecord(
		{
			turn: {
				id: APP_TURN_ID,
				items: [],
				itemsView: "full",
				status: "completed",
				error: null,
				startedAt: 10,
				completedAt: 11,
				durationMs: 1_000,
			},
		},
		{ commandId: COMMAND_ID, turnId: CHILD_TURN_ID },
	);
	void item;
	const revised = (record: ProjectionEnvelope, revision: number): ProjectionRecord => ({ ...record, revision });

	const reducer = new TurnProjectionReducer();
	reducer.apply(revised(created, 1));
	// Same revision is an in-memory replay and stays acceptable.
	expect(() => reducer.apply(revised(created, 1))).not.toThrow();
	// A distinct revision means the durable log contains a duplicate record.
	expect(() => reducer.apply(revised(created, 2))).toThrow(ProjectionCorruptError);

	expect(() => reconstructTurnSnapshots([revised(created, 1), revised(created, 2), revised(terminal, 3)])).toThrow(
		"duplicated at revision",
	);
});

test("TurnControllerError codes stay distinct for admission and durability failures", () => {
	expect(new TurnControllerError("busy", "b").code).toBe("busy");
	expect(new TurnControllerError("idempotency_conflict", "c").code).toBe("idempotency_conflict");
	expect(new TurnControllerError("projection_corrupt", "p").code).toBe("projection_corrupt");
	expect(new TurnControllerError("recovery_required", "r").code).toBe("recovery_required");
});

test("a buffered terminal delivery failure rejects with the classified error, never undefined", async () => {
	for (const failing of ["turn/completed", "thread/tokenUsage/updated"]) {
		const client = new FakeClient();
		const manager = managerWith(client);
		const controller = new TurnController({
			manager,
			emit: notification => {
				if (notification.method === failing) throw new Error(`writer rejected ${failing}`);
			},
			idFactory: () => APP_TURN_ID,
		});

		const handle = await controller.start({ threadId: THREAD_ID, params: { text: "hello" } });
		// Buffered before the barrier, so the terminal is processed inside the delivery drain.
		controller.acceptFrame(
			THREAD_ID,
			lifecycleFrame("agent_end", { messages: [assistant("done")], stopReason: "completed" }),
		);

		let rejection: unknown;
		try {
			await handle.responseDelivered();
		} catch (error) {
			rejection = error;
		}
		// The drain disposes the terminal turn, so `active.failure` is gone; the original error must
		// still surface instead of an unclassifiable `undefined` rejection.
		expect(rejection, failing).toBeDefined();
		expect((rejection as { message?: string }).message, failing).toContain(failing);
		expect(client.appended.at(-1)?.recordKind, failing).toBe("app-server.turn.terminal");
		expect(controller.activeTurnCount, failing).toBe(0);
	}
});

test("an errorless rejected projection append is never treated as a durable receipt", async () => {
	for (const rejected of [
		{ ok: false, revision: 1 },
		{ accepted: false, revision: 1 },
	]) {
		const client = new FakeClient();
		// The child definitively rejects the append yet still returns a revision.
		client.appendResponse = rejected;
		const manager = managerWith(client);
		const controller = new TurnController({ manager, emit: () => {}, idFactory: () => APP_TURN_ID });

		await expect(controller.start({ threadId: THREAD_ID, params: { text: "hi" } })).rejects.toMatchObject({
			code: "recovery_required",
		});
		expect(controller.getState(THREAD_ID), JSON.stringify(rejected)).toBe("recovery_required");
	}
});

test("a nested or thrown idempotency conflict keeps its typed code", async () => {
	// Nested under `result`: the code must survive unwrapping.
	const nested = new FakeClient();
	nested.appendResponse = { result: { ok: false, revision: 1, error: { code: "idempotency_conflict" } } };
	const nestedController = new TurnController({
		manager: managerWith(nested),
		emit: () => {},
		idFactory: () => APP_TURN_ID,
	});
	await expect(nestedController.start({ threadId: THREAD_ID, params: { text: "hi" } })).rejects.toMatchObject({
		code: "idempotency_conflict",
	});

	// Thrown straight through by the bridge client: still a conflict, not generic recovery.
	const thrown = new FakeClient();
	thrown.appendThrow = Object.assign(new Error("source key conflict"), { code: "idempotency_conflict" });
	const thrownController = new TurnController({
		manager: managerWith(thrown),
		emit: () => {},
		idFactory: () => APP_TURN_ID,
	});
	await expect(thrownController.start({ threadId: THREAD_ID, params: { text: "hi" } })).rejects.toMatchObject({
		code: "idempotency_conflict",
	});
});

test("a reconciliation response naming a foreign clientRef never materializes a turn", async () => {
	const client = new FakeClient({
		promptError: new Error("request timeout"),
		promptStatus: {
			status: "failed",
			commandId: COMMAND_ID,
			turnId: CHILD_TURN_ID,
			clientRef: "other-client-ref",
			acceptedAt: 1,
			terminalAt: 2,
			error: { code: "prompt_failed", message: "child failed" },
		},
	});
	const manager = managerWith(client);
	const controller = new TurnController({ manager, emit: () => {}, idFactory: () => APP_TURN_ID });

	await expect(controller.start({ threadId: THREAD_ID, params: { text: "hi" } })).rejects.toMatchObject({
		code: "recovery_required",
	});
	// It described a different prompt, so no child identities may be bound and nothing persisted.
	expect(client.appended).toHaveLength(0);
	expect(controller.getState(THREAD_ID)).toBe("recovery_required");
});

test("legitimate append receipt shapes are never rejected", async () => {
	for (const receipt of [
		{ entryId: "e", revision: 1 },
		{ revision: 1 },
		{ ok: true, revision: 1 },
		{ accepted: true, revision: 1 },
		{ result: { entryId: "e", revision: 1, reused: true } },
	]) {
		const client = new FakeClient();
		client.appendResponse = receipt;
		const controller = new TurnController({
			manager: managerWith(client),
			emit: () => {},
			idFactory: () => APP_TURN_ID,
		});
		await expect(
			controller.start({ threadId: THREAD_ID, params: { text: "hi" } }),
			JSON.stringify(receipt),
		).resolves.toBeDefined();
	}
});

test("a present but malformed reconciliation clientRef fails closed", async () => {
	for (const clientRef of ["", "   ", 42, null]) {
		const client = new FakeClient({
			promptError: new Error("request timeout"),
			promptStatus: {
				status: "accepted",
				commandId: "foreign-command",
				turnId: "foreign-turn",
				clientRef,
				acceptedAt: 1,
			},
		});
		const manager = managerWith(client);
		const controller = new TurnController({ manager, emit: () => {}, idFactory: () => APP_TURN_ID });

		await expect(controller.start({ threadId: THREAD_ID, params: { text: "hi" } })).rejects.toMatchObject({
			code: "recovery_required",
		});
		// A supplied-but-invalid correlation must never bind foreign child identities.
		expect(client.appended, JSON.stringify(clientRef)).toHaveLength(0);
		expect(controller.getState(THREAD_ID), JSON.stringify(clientRef)).toBe("recovery_required");
	}
});

test("a reconciliation status omitting clientRef is still accepted", async () => {
	const client = new FakeClient({
		promptError: new Error("request timeout"),
		promptStatus: { status: "accepted", commandId: COMMAND_ID, turnId: CHILD_TURN_ID, acceptedAt: 1 },
	});
	const manager = managerWith(client);
	const controller = new TurnController({ manager, emit: () => {}, idFactory: () => APP_TURN_ID });

	await expect(controller.start({ threadId: THREAD_ID, params: { text: "hi" } })).resolves.toBeDefined();
	expect(client.appended.map(record => record.recordKind)).toEqual(["app-server.turn.created"]);
});

test("a raw thrown conflict keeps its typed code on item and terminal appends", async () => {
	// The created append succeeds; the later terminal append throws a raw typed bridge conflict.
	const client = new FakeClient();
	const manager = managerWith(client);
	const notifications: string[] = [];
	const controller = new TurnController({
		manager,
		emit: notification => {
			notifications.push(notification.method);
		},
		idFactory: () => APP_TURN_ID,
	});

	const handle = await controller.start({ threadId: THREAD_ID, params: { text: "hello" } });
	client.appendThrow = Object.assign(new Error("source key conflict"), { code: "idempotency_conflict" });
	controller.acceptFrame(
		THREAD_ID,
		lifecycleFrame("agent_end", { messages: [assistant("done")], stopReason: "completed" }),
	);

	let rejection: unknown;
	try {
		await handle.responseDelivered();
	} catch (error) {
		rejection = error;
	}
	// All three append callsites must classify a raw conflict identically, never as generic internal.
	expect(rejection).toMatchObject({ code: "idempotency_conflict" });
	expect(notifications).toEqual(["turn/started"]);
});
