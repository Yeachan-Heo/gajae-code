import { expect, test } from "bun:test";
import type { AgentMessage } from "@gajae-code/agent-core";
import { stableValidators } from "../../protocol-source/schema-validators.generated";
import type { SessionClient, SessionRequestOptions } from "../../thread-runtime/child-bridge";
import { ThreadRuntimeManager } from "../../thread-runtime/thread-runtime-manager";
import { TurnController, type TurnControllerNotification } from "../../thread-runtime/turn-controller";
import type { ProjectionEnvelope, ProjectionRecord } from "../../thread-runtime/turn-projection";

const THREAD_ID = "thread-test";
const COMMAND_ID = "child-command";
const CHILD_TURN_ID = "child-turn";

class FakeSessionClient implements SessionClient {
	readonly calls: Array<{ operation: string; input: Record<string, unknown>; options?: SessionRequestOptions }> = [];
	readonly projectionRecords: ProjectionRecord[] = [];
	promptResult: unknown = { accepted: true, commandId: COMMAND_ID, turnId: CHILD_TURN_ID };
	promptError: unknown;
	promptStatusResult: unknown = { status: "unknown" };
	failProjection = false;
	beforePrompt?: () => void;
	private revision = 0;

	onFrame(_handler: (frame: Record<string, unknown>) => void): () => void {
		return () => {};
	}

	onReconnect(_handler: () => void): () => void {
		return () => {};
	}

	onReconnectFailed(_handler: (error: Error) => void): () => void {
		return () => {};
	}

	async request(
		_frame: Record<string, unknown>,
		_timeout?: number | SessionRequestOptions,
	): Promise<Record<string, unknown>> {
		return {};
	}

	async query(query: string, input: Record<string, unknown> = {}): Promise<unknown> {
		this.calls.push({ operation: query, input });
		if (query === "turn.prompt_status") return this.promptStatusResult;
		return {};
	}

	async control(
		operation: string,
		input: Record<string, unknown> = {},
		options?: SessionRequestOptions,
	): Promise<unknown> {
		this.calls.push({ operation, input, options });
		if (operation === "turn.prompt") {
			this.beforePrompt?.();
			if (this.promptError !== undefined) throw this.promptError;
			return this.promptResult;
		}
		if (operation === "projection.append") {
			if (this.failProjection) throw new Error("projection flush failed");
			const envelope = input.envelope as ProjectionEnvelope;
			const durable: ProjectionRecord = { ...envelope, revision: ++this.revision };
			this.projectionRecords.push(durable);
			return { entryId: `projection-${durable.revision}`, revision: durable.revision };
		}
		if (operation === "projection.read")
			return {
				records: this.projectionRecords.map(record => {
					const { revision: _revision, ...envelope } = record;
					return { entryId: `projection-${record.revision}`, envelope };
				}),
				revision: this.revision,
			};
		return {};
	}

	async setModelForTurn(requestedModel: string): Promise<() => Promise<void>> {
		this.calls.push({ operation: "turn.modelOverride", input: { model: requestedModel } });
		return async () => {
			this.calls.push({ operation: "turn.modelOverride.restore", input: { model: requestedModel } });
		};
	}
	async close(): Promise<void> {}
}

function managerWithClient(client: SessionClient): ThreadRuntimeManager {
	const manager = new ThreadRuntimeManager({ maxLoadedThreads: 2 });
	manager.register(THREAD_ID, "attached", undefined, undefined, { client });
	return manager;
}

function assistant(text: string, responseId = "response-1", usage = true): AgentMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "openai-responses",
		provider: "openai",
		model: "gpt",
		usage: usage
			? {
					input: 3,
					output: 2,
					cacheRead: 1,
					cacheWrite: 0,
					reasoningTokens: 0,
					totalTokens: 6,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				}
			: {
					input: 0,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0,
					reasoningTokens: 0,
					totalTokens: 0,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
		stopReason: "stop",
		timestamp: 1,
		responseId,
	} as AgentMessage;
}

function eventFrame(event: Record<string, unknown>): Record<string, unknown> {
	return {
		type: "event",
		kind: event.type,
		payload: { event },
		commandId: COMMAND_ID,
		turnId: CHILD_TURN_ID,
	};
}

function lifecycleFrame(
	type: "agent_start" | "agent_end" | "agent_failed",
	extra: Record<string, unknown> = {},
): Record<string, unknown> {
	return { type, commandId: COMMAND_ID, turnId: CHILD_TURN_ID, ...extra };
}

async function flush(): Promise<void> {
	await Bun.sleep(0);
	await Bun.sleep(0);
}

function methods(notifications: readonly TurnControllerNotification[]): string[] {
	return notifications.map(notification => notification.method);
}

function assertValidNotifications(notifications: readonly TurnControllerNotification[]): void {
	for (const notification of notifications) {
		const validator = stableValidators.serverNotificationParams[notification.method];
		expect(validator?.(notification.params), notification.method).toBe(true);
	}
}

test("turn controller preserves response barrier, durable item ordering, completion shape, and usage ordering", async () => {
	const client = new FakeSessionClient();
	const manager = managerWithClient(client);
	const notifications: TurnControllerNotification[] = [];
	const controller = new TurnController({
		manager,
		emit: notification => {
			notifications.push(notification);
		},
		clock: () => 1_000,
		idFactory: () => "app-turn-1",
	});
	const handle = await controller.start({ threadId: THREAD_ID, params: { text: "hello" } });
	expect(stableValidators.clientRequestResults["turn/start"]!(handle.response)).toBe(true);
	expect(notifications).toEqual([]);
	await handle.responseDelivered();
	expect(methods(notifications)).toEqual(["turn/started"]);
	const first = assistant("partial");
	const final = assistant("final");
	controller.acceptFrame(THREAD_ID, eventFrame({ type: "message_start", message: first }));
	controller.acceptFrame(
		THREAD_ID,
		eventFrame({
			type: "message_update",
			message: first,
			assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "partial", partial: first },
		}),
	);
	controller.acceptFrame(THREAD_ID, lifecycleFrame("agent_end", { messages: [final], stopReason: "completed" }));
	await flush();
	expect(methods(notifications)).toEqual([
		"turn/started",
		"item/started",
		"item/agentMessage/delta",
		"item/completed",
		"turn/completed",
		"thread/tokenUsage/updated",
	]);
	assertValidNotifications(notifications);
	const completed = notifications.find(notification => notification.method === "turn/completed");
	expect(completed).toBeDefined();
	if (completed?.method === "turn/completed") expect(completed.params).not.toHaveProperty("usage");
	const completedIndex = notifications.findIndex(notification => notification.method === "turn/completed");
	const usageIndex = notifications.findIndex(notification => notification.method === "thread/tokenUsage/updated");
	expect(usageIndex).toBeGreaterThan(completedIndex);
});
test("per-turn model override is restored after the child terminalizes", async () => {
	const client = new FakeSessionClient();
	const manager = managerWithClient(client);
	const controller = new TurnController({ manager, emit: () => {}, idFactory: () => "app-turn-model" });
	const handle = await controller.start({
		threadId: THREAD_ID,
		params: { text: "modelled", model: "provider/turn-model" },
	});
	await handle.responseDelivered();
	controller.acceptFrame(THREAD_ID, lifecycleFrame("agent_end", { messages: [], stopReason: "completed" }));
	await flush();
	expect(client.calls.map(call => call.operation)).toEqual([
		"turn.modelOverride",
		"turn.prompt",
		"projection.append",
		"projection.append",
		"turn.modelOverride.restore",
	]);
});

test("synchronous child terminal is buffered until the response is delivered", async () => {
	const client = new FakeSessionClient();
	const manager = managerWithClient(client);
	const notifications: TurnControllerNotification[] = [];
	const controller = new TurnController({
		manager,
		emit: notification => {
			notifications.push(notification);
		},
		idFactory: () => "app-turn-sync",
	});
	client.beforePrompt = () =>
		controller.acceptFrame(THREAD_ID, lifecycleFrame("agent_end", { messages: [], stopReason: "completed" }));
	const handle = await controller.start({ threadId: THREAD_ID, params: { text: "sync" } });
	expect(methods(notifications)).toEqual([]);
	await handle.responseDelivered();
	expect(methods(notifications)).toEqual(["turn/started", "turn/completed"]);
});

test("busy preflight rejection does not create durable turn state", async () => {
	const client = new FakeSessionClient();
	client.promptResult = { ok: false, error: { code: "busy", message: "busy" } };
	const manager = managerWithClient(client);
	const notifications: TurnControllerNotification[] = [];
	const controller = new TurnController({
		manager,
		emit: notification => {
			notifications.push(notification);
		},
		idFactory: () => "app-turn-busy",
	});
	await expect(controller.start({ threadId: THREAD_ID, params: { text: "busy" } })).rejects.toMatchObject({
		code: "busy",
	});
	expect(client.projectionRecords).toHaveLength(0);
	expect(notifications).toHaveLength(0);
	expect(manager.get(THREAD_ID)?.activeTurn).toBe(false);
});

test("projection append failure after acceptance fails closed without a false response", async () => {
	const client = new FakeSessionClient();
	client.failProjection = true;
	const manager = managerWithClient(client);
	const controller = new TurnController({ manager, emit: () => {}, idFactory: () => "app-turn-projection-fail" });
	await expect(controller.start({ threadId: THREAD_ID, params: { text: "persist" } })).rejects.toMatchObject({
		code: "recovery_required",
	});
	expect(controller.getState(THREAD_ID)).toBe("recovery_required");
	expect(manager.get(THREAD_ID)?.activeTurn).toBe(true);
});

test("lost acknowledgement reconciles by clientRef without submitting twice", async () => {
	const client = new FakeSessionClient();
	client.promptError = new Error("ack timeout");
	client.promptStatusResult = { status: "accepted", commandId: COMMAND_ID, turnId: CHILD_TURN_ID };
	const manager = managerWithClient(client);
	const controller = new TurnController({ manager, emit: () => {}, idFactory: () => "app-turn-reconcile" });
	const handle = await controller.start({ threadId: THREAD_ID, params: { text: "reconcile" } });
	expect(client.calls.filter(call => call.operation === "turn.prompt")).toHaveLength(1);
	expect(client.calls.filter(call => call.operation === "turn.prompt_status")).toHaveLength(1);
	expect(client.projectionRecords[0]?.payload).toMatchObject({ commandId: COMMAND_ID, turnId: CHILD_TURN_ID });
	await handle.rollbackUndelivered();
});

test("barrier overflow, rollback idempotency, mismatched child IDs, and duplicate terminal are fail-closed", async () => {
	const overflowClient = new FakeSessionClient();
	const overflowManager = managerWithClient(overflowClient);
	const overflowController = new TurnController({
		manager: overflowManager,
		emit: () => {},
		barrierCapacity: 1,
		idFactory: () => "app-turn-overflow",
	});
	overflowClient.beforePrompt = () => {
		overflowController.acceptFrame(THREAD_ID, lifecycleFrame("agent_start"));
		overflowController.acceptFrame(THREAD_ID, lifecycleFrame("agent_start"));
	};
	await expect(overflowController.start({ threadId: THREAD_ID, params: { text: "overflow" } })).rejects.toMatchObject({
		code: "recovery_required",
	});

	const client = new FakeSessionClient();
	const manager = managerWithClient(client);
	const notifications: TurnControllerNotification[] = [];
	const controller = new TurnController({
		manager,
		emit: notification => {
			notifications.push(notification);
		},
		idFactory: () => "app-turn-fence",
	});
	const handle = await controller.start({ threadId: THREAD_ID, params: { text: "fence" } });
	await handle.rollbackUndelivered();
	await handle.rollbackUndelivered();
	controller.acceptFrame(THREAD_ID, lifecycleFrame("agent_start"));
	await flush();
	expect(notifications).toHaveLength(0);
	expect(manager.get(THREAD_ID)?.activeTurn).toBe(true);
	expect(controller.getState(THREAD_ID)).toBe("recovery_required");

	const secondClient = new FakeSessionClient();
	const secondManager = managerWithClient(secondClient);
	const secondNotifications: TurnControllerNotification[] = [];
	const secondController = new TurnController({
		manager: secondManager,
		emit: notification => {
			secondNotifications.push(notification);
		},
		idFactory: () => "app-turn-duplicate",
	});
	const secondHandle = await secondController.start({ threadId: THREAD_ID, params: { text: "duplicate" } });
	await secondHandle.responseDelivered();
	secondController.acceptFrame(THREAD_ID, { ...lifecycleFrame("agent_start"), commandId: "wrong", turnId: "wrong" });
	secondController.acceptFrame(THREAD_ID, lifecycleFrame("agent_end", { messages: [], stopReason: "completed" }));
	secondController.acceptFrame(THREAD_ID, lifecycleFrame("agent_end", { messages: [], stopReason: "completed" }));
	await flush();
	expect(methods(secondNotifications)).toEqual(["turn/started", "turn/completed"]);
});
