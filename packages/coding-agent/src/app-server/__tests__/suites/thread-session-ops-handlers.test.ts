import { expect, test } from "bun:test";
import { stableValidators } from "../../protocol-source/schema-validators.generated";
import type { HandlerResult } from "../../suites/handlers";
import {
	threadCompactStartHandler,
	threadSessionOpsHandlers,
	threadShellCommandHandler,
} from "../../suites/thread-session-ops-handlers";
import type { SessionClient } from "../../thread-runtime/child-bridge";
import { ThreadRuntimeManager } from "../../thread-runtime/thread-runtime-manager";

const THREAD_ID = "thread-session-ops";

type Call = { operation: string; input: Record<string, unknown> };

/** The manager and retained thread are real; only the child-process boundary is recorded. */
class RecordingClient implements SessionClient {
	readonly calls: Call[] = [];
	controlResult: unknown = {};
	controlThrow: unknown;

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

	async query(): Promise<unknown> {
		return {};
	}

	async control(operation: string, input: Record<string, unknown> = {}): Promise<unknown> {
		this.calls.push({ operation, input });
		if (this.controlThrow !== undefined) throw this.controlThrow;
		return this.controlResult;
	}

	async close(): Promise<void> {}
}

function loadedRuntime(client?: SessionClient): ThreadRuntimeManager {
	const manager = new ThreadRuntimeManager({ maxLoadedThreads: 4 });
	manager.register(THREAD_ID, "attached", undefined, "connection-a", {
		client,
		cwd: "/workspace",
	});
	return manager;
}

function resultOf(result: HandlerResult): Record<string, unknown> {
	expect(result.ok, JSON.stringify(result)).toBe(true);
	return (result as { ok: true; result: Record<string, unknown> }).result;
}

test("thread/compact/start reaches the retained session's compaction.run seam", async () => {
	const client = new RecordingClient();
	const manager = loadedRuntime(client);
	const params = { threadId: THREAD_ID };
	expect(stableValidators.clientRequestParams["thread/compact/start"]?.(params)).toBe(true);

	const result = await threadCompactStartHandler(params, { manager });
	const payload = resultOf(result);
	expect(stableValidators.clientRequestResults["thread/compact/start"]?.(payload)).toBe(true);
	expect(payload).toEqual({});
	expect(client.calls).toEqual([{ operation: "compaction.run", input: {} }]);
});

test("thread/shellCommand translates command to managed bash.execute", async () => {
	const client = new RecordingClient();
	const manager = loadedRuntime(client);
	const params = { threadId: THREAD_ID, command: "printf 'hello | world'" };
	expect(stableValidators.clientRequestParams["thread/shellCommand"]?.(params)).toBe(true);

	const result = await threadShellCommandHandler(params, { manager });
	const payload = resultOf(result);
	expect(stableValidators.clientRequestResults["thread/shellCommand"]?.(payload)).toBe(true);
	expect(payload).toEqual({});
	expect(client.calls).toEqual([{ operation: "bash.execute", input: { cmd: params.command } }]);
});

test("child rejection or transport failure maps both wired methods to the pinned internalError", async () => {
	const rejectedClient = new RecordingClient();
	rejectedClient.controlResult = { ok: false, error: { code: "invalid_request" } };
	const rejected = await threadCompactStartHandler(
		{ threadId: THREAD_ID },
		{ manager: loadedRuntime(rejectedClient) },
	);
	expect(rejected).toEqual({ ok: false, errorKey: "internalError" });
	expect(rejectedClient.calls).toEqual([{ operation: "compaction.run", input: {} }]);

	const failedClient = new RecordingClient();
	failedClient.controlThrow = new Error("child refused");
	const failed = await threadShellCommandHandler(
		{ threadId: THREAD_ID, command: "echo failure" },
		{ manager: loadedRuntime(failedClient) },
	);
	expect(failed).toEqual({ ok: false, errorKey: "internalError" });
	expect(failedClient.calls).toEqual([{ operation: "bash.execute", input: { cmd: "echo failure" } }]);
});

test("unknown threads, loaded threads without a client, and missing runtime return pinned errors", async () => {
	const client = new RecordingClient();
	const manager = loadedRuntime(client);
	const compact = { threadId: THREAD_ID };
	const shell = { threadId: THREAD_ID, command: "pwd" };

	expect(await threadCompactStartHandler({ threadId: "missing" }, { manager })).toEqual({
		ok: false,
		errorKey: "notFound",
	});
	expect(await threadShellCommandHandler({ threadId: "missing", command: "pwd" }, { manager })).toEqual({
		ok: false,
		errorKey: "notFound",
	});

	const noClientManager = loadedRuntime();
	expect(await threadCompactStartHandler(compact, { manager: noClientManager })).toEqual({
		ok: false,
		errorKey: "internalError",
	});
	expect(await threadShellCommandHandler(shell, { manager: noClientManager })).toEqual({
		ok: false,
		errorKey: "internalError",
	});

	expect(await threadCompactStartHandler(compact, {})).toEqual({ ok: false, errorKey: "internalError" });
	expect(await threadShellCommandHandler(shell, {})).toEqual({ ok: false, errorKey: "internalError" });
});

test("malformed params are rejected before any child control call", async () => {
	const client = new RecordingClient();
	const manager = loadedRuntime(client);

	expect(await threadCompactStartHandler({}, { manager })).toEqual({ ok: false, errorKey: "invalidParams" });
	expect(await threadCompactStartHandler({ threadId: 42 }, { manager })).toEqual({
		ok: false,
		errorKey: "invalidParams",
	});
	expect(await threadShellCommandHandler({ threadId: THREAD_ID }, { manager })).toEqual({
		ok: false,
		errorKey: "invalidParams",
	});
	expect(await threadShellCommandHandler({ threadId: THREAD_ID, command: 42 }, { manager })).toEqual({
		ok: false,
		errorKey: "invalidParams",
	});
	expect(await threadShellCommandHandler({ threadId: THREAD_ID, command: "   " }, { manager })).toEqual({
		ok: false,
		errorKey: "invalidParams",
	});
	expect(client.calls).toEqual([]);
});

test("threadSessionOpsHandlers exposes exactly the genuinely backed methods", () => {
	expect(Object.keys(threadSessionOpsHandlers).sort()).toEqual(["thread/compact/start", "thread/shellCommand"]);
	expect(threadSessionOpsHandlers["thread/compact/start"]).toBe(threadCompactStartHandler);
	expect(threadSessionOpsHandlers["thread/shellCommand"]).toBe(threadShellCommandHandler);
});
