import { afterAll, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildSessionContext, loadEntriesFromFile } from "../../../session/session-manager";
import { stableValidators } from "../../protocol-source/schema-validators.generated";
import {
	feedbackUploadHandler,
	goalsReviewHandlers,
	reviewStartHandler,
	threadGoalClearHandler,
	threadGoalGetHandler,
	threadGoalSetHandler,
} from "../../suites/goals-review-handlers";
import type { HandlerContext } from "../../suites/handlers";
import type { LoadedThreadRuntime, SessionClient } from "../../thread-runtime/child-bridge";
import { loadThread } from "../../thread-runtime/child-bridge";
import { createProductionThreadStartAdapter } from "../../thread-runtime/production-child";
import { ThreadRuntimeManager } from "../../thread-runtime/thread-runtime-manager";

type Notification = { method: string; params: Record<string, unknown> };

const root = mkdtempSync(join(tmpdir(), "gjc-goals-review-suite-"));
const threadId = "thread-goals-review";
const sessionFile = join(root, "session.jsonl");

function resetSession(): void {
	writeFileSync(
		sessionFile,
		`${JSON.stringify({
			type: "session",
			version: 5,
			id: threadId,
			timestamp: new Date(0).toISOString(),
			cwd: root,
		})}\n`,
	);
}

function contextFor(notifications: Notification[] = []): HandlerContext {
	return {
		connectionId: "goals-review-test",
		// The app-server host can provide this same persisted session-file seam while a child
		// runtime is unavailable; no process-global goal state is touched by these tests.
		sessionFile,
		broadcastThread: (_threadId, method, params) => {
			if (typeof params === "object" && params !== null && !Array.isArray(params))
				notifications.push({ method, params: params as Record<string, unknown> });
		},
	} as HandlerContext & { sessionFile: string };
}

function resultOf(value: { ok: true; result: unknown } | { ok: false; errorKey: string }): unknown {
	if (!value.ok) throw new Error(`handler failed: ${value.errorKey}`);
	return value.result;
}

beforeEach(() => {
	resetSession();
});

afterAll(() => {
	rmSync(root, { recursive: true, force: true });
});

test("thread/goal/set and thread/goal/get persist and read a real session goal", async () => {
	const notifications: Notification[] = [];
	const context = contextFor(notifications);
	const setParams = { threadId, objective: "Keep the app-server protocol honest" };
	const getParams = { threadId };

	expect(stableValidators.clientRequestParams["thread/goal/set"]?.(setParams)).toBe(true);
	expect(stableValidators.clientRequestParams["thread/goal/get"]?.(getParams)).toBe(true);
	expect(stableValidators.clientRequestParams["thread/goal/clear"]?.(getParams)).toBe(true);
	expect(
		stableValidators.clientRequestParams["thread/goal/set"]?.({ thread_id: threadId, objective: "wrong key" }),
	).toBe(false);

	const setResult = await threadGoalSetHandler(setParams, context);
	expect(setResult.ok).toBe(true);
	if (!setResult.ok) throw new Error(setResult.errorKey);
	expect(stableValidators.clientRequestResults["thread/goal/set"]?.(setResult.result)).toBe(true);
	expect(setResult.result).toMatchObject({ goal: { threadId, objective: setParams.objective, status: "active" } });

	const persisted = await loadEntriesFromFile(sessionFile);
	const persistedContext = buildSessionContext(persisted.filter(entry => entry.type !== "session"));
	expect(persistedContext.mode).toBe("goal");
	expect(persistedContext.modeData?.goal).toMatchObject({ objective: setParams.objective, status: "active" });

	const getResult = await threadGoalGetHandler(getParams, context);
	expect(getResult).toEqual({ ok: true, result: { goal: (setResult.result as { goal: unknown }).goal } });
	expect(notifications.map(notification => notification.method)).toEqual(["thread/goal/updated"]);
	expect(stableValidators.serverNotificationParams["thread/goal/updated"]?.(notifications[0]?.params)).toBe(true);
});

test("thread/goal/set follows active and paused transitions and rejects replacing a paused goal", async () => {
	const context = contextFor();

	expect(await threadGoalSetHandler({ threadId, objective: "First objective" }, context)).toMatchObject({
		ok: true,
		result: { goal: { status: "active" } },
	});
	expect(await threadGoalSetHandler({ threadId, status: "paused" }, context)).toMatchObject({
		ok: true,
		result: { goal: { status: "paused" } },
	});
	expect(await threadGoalSetHandler({ threadId, objective: "Cannot replace while paused" }, context)).toEqual({
		ok: false,
		errorKey: "invalidParams",
	});
	expect(await threadGoalSetHandler({ threadId, status: "active" }, context)).toMatchObject({
		ok: true,
		result: { goal: { status: "active" } },
	});
	expect(await threadGoalSetHandler({ threadId, status: "complete" }, context)).toMatchObject({
		ok: true,
		result: { goal: { status: "complete" } },
	});
});

test("thread/goal/clear drops the persisted goal and get reports no goal", async () => {
	const notifications: Notification[] = [];
	const context = contextFor(notifications);
	await threadGoalSetHandler({ threadId, objective: "Remove this goal" }, context);

	const clearResult = await threadGoalClearHandler({ threadId }, context);
	expect(clearResult).toEqual({ ok: true, result: { cleared: true } });
	expect(
		stableValidators.clientRequestResults["thread/goal/clear"]?.(clearResult.ok ? clearResult.result : undefined),
	).toBe(true);

	const getResult = await threadGoalGetHandler({ threadId }, context);
	expect(getResult).toEqual({ ok: true, result: { goal: null } });
	expect(notifications.map(notification => notification.method)).toEqual([
		"thread/goal/updated",
		"thread/goal/cleared",
	]);
	expect(stableValidators.serverNotificationParams["thread/goal/cleared"]?.(notifications[1]?.params)).toBe(true);

	const persisted = await loadEntriesFromFile(sessionFile);
	const persistedContext = buildSessionContext(persisted.filter(entry => entry.type !== "session"));
	expect(persistedContext.mode).toBe("none");
});

test("review/start translates targets into a native turn.prompt and returns inline turn", async () => {
	const turn = {
		id: "turn-review-1",
		items: [],
		itemsView: "full",
		status: "inProgress",
		error: null,
		startedAt: 1,
		completedAt: null,
		durationMs: null,
	};
	let delivered = false;
	let rolledBack = false;
	const context = {
		connectionId: "review-connection",
		turnController: {
			start: async (input: { threadId: string; params: Record<string, unknown> }) => {
				expect(input.threadId).toBe(threadId);
				expect(input.params.text).toContain("base branch main");
				return {
					response: { turn },
					responseDelivered: async () => {
						delivered = true;
					},
					rollbackUndelivered: async () => {
						rolledBack = true;
					},
				};
			},
		},
	} as unknown as HandlerContext;
	const params = { threadId, target: { type: "baseBranch", branch: "main" }, delivery: "inline" };
	expect(stableValidators.clientRequestParams["review/start"]?.(params)).toBe(true);
	const result = await reviewStartHandler(params, context);
	expect(result).toMatchObject({ ok: true, result: { turn, reviewThreadId: threadId } });
	expect(delivered).toBe(false);
	if (!result.ok) throw new Error(result.errorKey);
	await result.responseDelivered?.();
	expect(delivered).toBe(true);
	await result.rollbackUndeliveredResponse?.();
	expect(rolledBack).toBe(true);
	expect(stableValidators.clientRequestResults["review/start"]?.(result.result)).toBe(true);
});

test("review/start rejects detached delivery because GJC has no detached review runner", async () => {
	const result = await reviewStartHandler(
		{ threadId, target: { type: "uncommittedChanges" }, delivery: "detached" },
		contextFor(),
	);
	expect(result).toEqual({ ok: false, errorKey: "notSupported" });
});

test("feedback/upload persists metadata through the retained child projection writer and returns thread id", async () => {
	const params = {
		classification: "bug",
		reason: "The review panel lost its findings.",
		threadId,
		includeLogs: false,
		tags: { surface: "review" },
	};
	const envelopes: Record<string, unknown>[] = [];
	const client = {
		onFrame: () => () => {},
		onReconnect: () => () => {},
		onReconnectFailed: () => () => {},
		request: async (frame: Record<string, unknown>) => frame,
		query: async () => ({ records: [], revision: 0 }),
		control: async () => ({}),
		appendProjection: async (envelope: Record<string, unknown>) => {
			envelopes.push(envelope);
			return { revision: 1 };
		},
		close: async () => {},
	} as SessionClient;
	const manager = new ThreadRuntimeManager({ maxLoadedThreads: 2 });
	manager.register(threadId, "attached", undefined, "review-connection", { client });
	const context = { ...contextFor(), manager };
	expect(stableValidators.clientRequestParams["feedback/upload"]?.(params)).toBe(true);
	const result = await feedbackUploadHandler(params, context);
	expect(result).toEqual({ ok: true, result: { threadId } });
	expect(stableValidators.clientRequestResults["feedback/upload"]?.(result.ok ? result.result : undefined)).toBe(true);
	expect(envelopes).toHaveLength(1);
	expect(envelopes[0]).toMatchObject({
		schemaVersion: 1,
		recordKind: "app-server.feedback.upload",
		payload: { threadId, classification: "bug", reason: params.reason, includeLogs: false, tags: params.tags },
	});
});

test("feedback/upload persists through a real spawned child without a sessionFile seam", async () => {
	const agentDir = mkdtempSync(join(tmpdir(), "gjc-feedback-agent-"));
	const cwd = mkdtempSync(join(tmpdir(), "gjc-feedback-cwd-"));
	const manager = new ThreadRuntimeManager({ maxLoadedThreads: 2 });
	const adapter = { manager, ...createProductionThreadStartAdapter({ agentDir }) };
	let runtime: LoadedThreadRuntime | undefined;
	try {
		runtime = await loadThread(adapter, { connectionId: "feedback-real", params: { cwd } });
		if (!runtime) throw new Error("real spawned child did not load");
		expect(runtime.ownership).toBe("spawned");
		expect(runtime.effectiveSettings.thread.path).toBeNull();
		const appendProjection = runtime.client.appendProjection;
		if (!appendProjection) throw new Error("real spawned child omitted appendProjection");
		let persistedEnvelope: Record<string, unknown> | undefined;
		runtime.client.appendProjection = async (envelope, options) => {
			persistedEnvelope = envelope;
			return await appendProjection(envelope, options);
		};
		const result = await feedbackUploadHandler(
			{
				threadId: runtime.threadId,
				classification: "bug",
				reason: "real child feedback",
				includeLogs: false,
			},
			{ connectionId: "feedback-real", manager },
		);
		expect(result).toEqual({ ok: true, result: { threadId: runtime.threadId } });
		if (!persistedEnvelope) throw new Error("feedback envelope was not sent to child projection append");
		const receipt = (await appendProjection(persistedEnvelope, {
			confirm: true,
			idempotencyKey: persistedEnvelope.sourceKey as string,
		})) as Record<string, unknown>;
		expect(receipt.reused).toBe(true);
		expect(receipt.revision).toBe(1);
		expect(persistedEnvelope).toMatchObject({
			schemaVersion: 1,
			recordKind: "app-server.feedback.upload",
			payload: {
				threadId: runtime.threadId,
				classification: "bug",
				reason: "real child feedback",
				includeLogs: false,
			},
		});
	} finally {
		if (runtime) manager.remove(runtime.threadId);
		await manager.waitForClosures();
		await adapter.shutdown?.();
		rmSync(agentDir, { recursive: true, force: true });
		rmSync(cwd, { recursive: true, force: true });
	}
}, 120_000);

test("feedback/upload refuses log upload without a GJC sink", async () => {
	const result = await feedbackUploadHandler({ classification: "bug", threadId, includeLogs: true }, contextFor());
	expect(result).toEqual({ ok: false, errorKey: "notSupported" });
});

test("goalsReviewHandlers exposes the backed goal, review, and feedback methods", () => {
	expect(Object.keys(goalsReviewHandlers)).toEqual([
		"thread/goal/get",
		"thread/goal/set",
		"thread/goal/clear",
		"review/start",
		"feedback/upload",
	]);
	expect(resultOf({ ok: true, result: { supported: true } })).toEqual({ supported: true });
});
