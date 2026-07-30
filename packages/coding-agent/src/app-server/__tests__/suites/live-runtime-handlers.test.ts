import { expect, test } from "bun:test";
import { stableValidators } from "../../protocol-source/schema-validators.generated";
import type { HandlerContext, HandlerResult } from "../../suites/handlers";
import { liveRuntimeHandlers } from "../../suites/live-runtime-handlers";
import type { SessionClient } from "../../thread-runtime/child-bridge";
import { ThreadRuntimeManager } from "../../thread-runtime/thread-runtime-manager";
import { TurnController } from "../../thread-runtime/turn-controller";

const THREAD_ID = "live-runtime-thread";
const APP_TURN_ID = "live-runtime-turn";

/**
 * Only the child-process boundary is substituted: no production child factory exists, so the
 * retained SessionClient is a recorder. The manager, the TurnController and the handlers under
 * test are the real production objects.
 */
class RecordingClient implements SessionClient {
	readonly calls: Array<{ operation: string; input: Record<string, unknown> }> = [];
	controlThrow: unknown;
	private revision = 0;

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
		if (query === "turn.prompt_status") return { status: "unknown" };
		return {};
	}

	async control(operation: string, input: Record<string, unknown> = {}): Promise<unknown> {
		this.calls.push({ operation, input });
		if (operation === "turn.prompt") return { accepted: true, commandId: "child-command", turnId: "child-turn" };
		if (operation === "projection.append") return { entryId: `append-${++this.revision}`, revision: this.revision };
		if (operation === "projection.read") return { records: [], revision: 0 };
		if (this.controlThrow !== undefined) throw this.controlThrow;
		return {};
	}

	async close(): Promise<void> {}

	controlCalls(operation: string): Array<Record<string, unknown>> {
		return this.calls.filter(call => call.operation === operation).map(call => call.input);
	}
}

function loadedRuntime(client: SessionClient): { manager: ThreadRuntimeManager; controller: TurnController } {
	const manager = new ThreadRuntimeManager({ maxLoadedThreads: 4 });
	manager.register(THREAD_ID, "attached", undefined, "conn-a", { client, cwd: "/workspace" });
	manager.markActive(THREAD_ID);
	const controller = new TurnController({ manager, emit: () => {}, idFactory: () => APP_TURN_ID });
	return { manager, controller };
}

const resultOf = (result: HandlerResult): Record<string, unknown> => {
	expect(result.ok, JSON.stringify(result)).toBe(true);
	return (result as { ok: true; result: unknown }).result as Record<string, unknown>;
};

test("thread/loaded/list reports the real loaded threads and refuses without a runtime", async () => {
	const client = new RecordingClient();
	const { manager } = loadedRuntime(client);
	const params = {};
	expect(stableValidators.clientRequestParams["thread/loaded/list"]?.(params)).toBe(true);

	const listed = resultOf(await liveRuntimeHandlers["thread/loaded/list"](params, { manager }));
	expect(stableValidators.clientRequestResults["thread/loaded/list"]?.(listed)).toBe(true);
	expect(listed.data).toEqual([THREAD_ID]);
	expect(listed.nextCursor).toBeNull();
	expect(manager.loaded().map(thread => thread.threadId)).toEqual([THREAD_ID]);

	// An empty list would falsely claim nothing is loaded, so a missing runtime is an error.
	expect(await liveRuntimeHandlers["thread/loaded/list"](params, {})).toEqual({
		ok: false,
		errorKey: "internalError",
	});
});

test("thread/unsubscribe distinguishes notLoaded, notSubscribed and a real unsubscribe", async () => {
	const client = new RecordingClient();
	const { manager } = loadedRuntime(client);
	const unsubscribed: string[] = [];
	const context: HandlerContext = { manager, unsubscribe: threadId => void unsubscribed.push(threadId) };

	const params = { threadId: THREAD_ID };
	expect(stableValidators.clientRequestParams["thread/unsubscribe"]?.(params)).toBe(true);

	const real = resultOf(await liveRuntimeHandlers["thread/unsubscribe"](params, context));
	expect(stableValidators.clientRequestResults["thread/unsubscribe"]?.(real)).toBe(true);
	expect(real.status).toBe("unsubscribed");
	expect(unsubscribed).toEqual([THREAD_ID]);

	const missing = resultOf(await liveRuntimeHandlers["thread/unsubscribe"]({ threadId: "absent" }, context));
	expect(missing.status).toBe("notLoaded");

	const withoutCapability = resultOf(await liveRuntimeHandlers["thread/unsubscribe"](params, { manager }));
	expect(withoutCapability.status).toBe("notSubscribed");

	expect(await liveRuntimeHandlers["thread/unsubscribe"]({}, context)).toEqual({
		ok: false,
		errorKey: "invalidParams",
	});
});

test("turn/interrupt aborts the live turn through the real control seam exactly once", async () => {
	const client = new RecordingClient();
	const { manager, controller } = loadedRuntime(client);
	const context: HandlerContext = { manager, turnController: controller };

	// No active turn yet: the pinned notFound is the honest answer.
	expect(await liveRuntimeHandlers["turn/interrupt"]({ threadId: THREAD_ID, turnId: APP_TURN_ID }, context)).toEqual({
		ok: false,
		errorKey: "notFound",
	});

	await controller.start({ threadId: THREAD_ID, params: { text: "hello" } });
	expect(controller.activeTurnId(THREAD_ID)).toBe(APP_TURN_ID);

	const params = { threadId: THREAD_ID, turnId: APP_TURN_ID };
	expect(stableValidators.clientRequestParams["turn/interrupt"]?.(params)).toBe(true);
	const interrupted = resultOf(await liveRuntimeHandlers["turn/interrupt"](params, context));
	expect(stableValidators.clientRequestResults["turn/interrupt"]?.(interrupted)).toBe(true);
	expect(client.controlCalls("turn.abort")).toHaveLength(1);

	// A stale turn id never aborts the live turn.
	expect(await liveRuntimeHandlers["turn/interrupt"]({ threadId: THREAD_ID, turnId: "stale-turn" }, context)).toEqual({
		ok: false,
		errorKey: "notFound",
	});
	expect(client.controlCalls("turn.abort")).toHaveLength(1);

	client.controlThrow = new Error("child refused");
	expect(await liveRuntimeHandlers["turn/interrupt"](params, context)).toEqual({
		ok: false,
		errorKey: "internalError",
	});
});

test("turn/steer carries real text to the child and rejects a stale precondition", async () => {
	const client = new RecordingClient();
	const { manager, controller } = loadedRuntime(client);
	const context: HandlerContext = { manager, turnController: controller };
	await controller.start({ threadId: THREAD_ID, params: { text: "hello" } });

	const params = {
		threadId: THREAD_ID,
		input: [{ type: "text", text: "steer me", text_elements: [] }],
		expectedTurnId: APP_TURN_ID,
	};
	expect(stableValidators.clientRequestParams["turn/steer"]?.(params)).toBe(true);
	const steered = resultOf(await liveRuntimeHandlers["turn/steer"](params, context));
	expect(stableValidators.clientRequestResults["turn/steer"]?.(steered)).toBe(true);
	expect(steered.turnId).toBe(APP_TURN_ID);
	expect(client.controlCalls("turn.steer")).toEqual([{ text: "steer me" }]);

	// A stale precondition must not reach the child at all.
	expect(await liveRuntimeHandlers["turn/steer"]({ ...params, expectedTurnId: "stale" }, context)).toEqual({
		ok: false,
		errorKey: "conflict",
	});
	expect(client.controlCalls("turn.steer")).toHaveLength(1);

	// Non-text input has no honest `turn.steer` representation, so it is refused rather than reduced.
	expect(
		await liveRuntimeHandlers["turn/steer"](
			{ ...params, input: [{ type: "localImage", path: "/tmp/shot.png" }] },
			context,
		),
	).toEqual({ ok: false, errorKey: "invalidParams" });
	expect(client.controlCalls("turn.steer")).toHaveLength(1);
});

test("liveRuntimeHandlers exposes exactly the runtime-backed methods", () => {
	expect(Object.keys(liveRuntimeHandlers).sort()).toEqual([
		"thread/loaded/list",
		"thread/unsubscribe",
		"turn/interrupt",
		"turn/steer",
	]);
});
