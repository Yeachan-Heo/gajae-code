/**
 * G005 red-team: ACP client-terminal handle lifecycle (AC9).
 *
 * The foldable client-terminal path in BashTool.execute must create exactly ONE
 * remote handle per command (createTerminal), retain it across the fold, and
 * release it exactly once by whichever path settles: foreground completion,
 * fold-then-complete, complete-then-fold, kill-mid-fold, owner teardown. Owner
 * teardown must fail the job visibly (failNow -> delivered failure), never
 * cancel it silently.
 */
import { afterEach, describe, expect, it, mock, spyOn } from "bun:test";
import { AsyncJobManager } from "../src/async";
import type { ClientBridge, ClientBridgeTerminalHandle } from "../src/session/client-bridge";
import type { FoldAdapter } from "../src/session/fold-coordinator";
import type { ToolSession } from "../src/tools";
import { BashTool } from "../src/tools/bash";

interface Harness {
	session: ToolSession;
	manager: AsyncJobManager;
	adapters: FoldAdapter[];
	delivered: Array<{ jobId: string; text: string }>;
}

function makeHarness(bridge: ClientBridge): Harness {
	const delivered: Array<{ jobId: string; text: string }> = [];
	const manager = new AsyncJobManager({
		retentionMs: 60_000,
		onJobComplete: async (jobId, text) => {
			delivered.push({ jobId, text });
		},
	});
	const adapters: FoldAdapter[] = [];
	const session = {
		cwd: "/tmp",
		hasUI: false,
		skills: [],
		getSessionFile: () => null,
		settings: {
			get(key: string) {
				if (key === "async.enabled") return true;
				if (key === "bash.autoBackground.enabled") return false;
				if (key === "bash.autoBackground.thresholdMs") return 60_000;
				if (key === "bashInterceptor.enabled") return false;
				if (key === "astGrep.enabled") return false;
				if (key === "astEdit.enabled") return false;
				if (key === "search.enabled") return false;
				if (key === "find.enabled") return false;
				return undefined;
			},
			has: () => false,
			getBashInterceptorRules: () => [],
		},
		getClientBridge: () => bridge,
		getSessionId: () => "acp-session",
		getAgentId: () => "0-Main",
		getAsyncJobManager: () => manager,
		registerForegroundFoldParticipant: (adapter: FoldAdapter) => {
			adapters.push(adapter);
			return () => {};
		},
	} as unknown as ToolSession;
	return { session, manager, adapters, delivered };
}

function foldVia(adapter: FoldAdapter): void {
	adapter.detachObserver({
		jobId: adapter.jobId,
		jobGeneration: adapter.jobGeneration,
		kind: adapter.kind,
		label: adapter.label,
		outputRef: adapter.outputRef,
		remainingIntent: undefined,
		foldedAt: Date.now(),
		cwdSensitive: adapter.cwdSensitive,
	});
}

async function waitFor(predicate: () => boolean, timeoutMs = 5_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (predicate()) return;
		await Bun.sleep(5);
	}
	throw new Error("waitFor timed out");
}

function makeHandle(
	terminalId: string,
	opts: { poisoned?: () => boolean } = {},
): {
	handle: ClientBridgeTerminalHandle;
	exit: PromiseWithResolvers<{ exitCode: number; signal: null }>;
} {
	const exit = Promise.withResolvers<{ exitCode: number; signal: null }>();
	return {
		exit,
		handle: {
			terminalId,
			waitForExit: () => exit.promise,
			currentOutput: async () => {
				if (opts.poisoned?.()) throw new Error("terminal/output failed: client disconnected");
				return { output: `${terminalId} output\n`, truncated: false };
			},
			kill: async () => {},
			release: async () => {},
		},
	};
}

afterEach(() => {
	mock.restore();
	AsyncJobManager.resetForTests();
});

describe("BashTool ACP terminal fold red-team", () => {
	it("fold-then-complete: exactly one create and exactly one release", async () => {
		const { exit, handle } = makeHandle("term-ftc");
		const bridge: ClientBridge = { capabilities: { terminal: true }, createTerminal: async () => handle };
		const createSpy = spyOn(bridge, "createTerminal");
		const releaseSpy = spyOn(handle, "release");

		const h = makeHarness(bridge);
		const tool = new BashTool(h.session);
		const resultPromise = tool.execute("call-ftc", { command: "sleep 30" }, undefined, () => {});
		await waitFor(() => h.adapters.length === 1);
		foldVia(h.adapters[0]!);
		const result = await resultPromise;
		expect(result.details?.async?.state).toBe("running");
		expect(result.details?.terminalId).toBe("term-ftc");
		expect(createSpy).toHaveBeenCalledTimes(1);
		expect(releaseSpy).not.toHaveBeenCalled();

		exit.resolve({ exitCode: 0, signal: null });
		await waitFor(() => h.delivered.length === 1);
		await waitFor(() => releaseSpy.mock.calls.length === 1);
		expect(releaseSpy).toHaveBeenCalledTimes(1);
		expect(h.delivered[0]?.text).toContain("term-ftc output");
	});

	it("complete-then-fold: release happens exactly once, fold is a no-op after settlement", async () => {
		const { exit, handle } = makeHandle("term-ctf");
		const bridge: ClientBridge = { capabilities: { terminal: true }, createTerminal: async () => handle };
		const createSpy = spyOn(bridge, "createTerminal");
		const releaseSpy = spyOn(handle, "release");

		const h = makeHarness(bridge);
		const tool = new BashTool(h.session);
		const resultPromise = tool.execute("call-ctf", { command: "echo done" }, undefined, () => {});
		await waitFor(() => h.adapters.length === 1);

		// The remote command finishes BEFORE the fold: the foreground wait wins.
		exit.resolve({ exitCode: 0, signal: null });
		const result = await resultPromise;
		expect(result.details?.async).toBeUndefined();
		expect(createSpy).toHaveBeenCalledTimes(1);

		// The foreground path already released; a fold racing the tail must not
		// double-release.
		await waitFor(() => releaseSpy.mock.calls.length === 1);
		foldVia(h.adapters[0]!);
		await Bun.sleep(50);
		expect(releaseSpy).toHaveBeenCalledTimes(1);
	});

	it("kill-mid-fold: one kill, one release, and the failure is delivered", async () => {
		const { exit, handle } = makeHandle("term-kill-mid", { poisoned: () => true });
		const bridge: ClientBridge = { capabilities: { terminal: true }, createTerminal: async () => handle };
		const releaseSpy = spyOn(handle, "release");
		const killSpy = spyOn(handle, "kill");

		const h = makeHarness(bridge);
		const tool = new BashTool(h.session);
		const resultPromise = tool.execute("call-kill-mid", { command: "sleep 30" }, undefined, () => {});
		await waitFor(() => h.adapters.length === 1);
		foldVia(h.adapters[0]!);
		const result = await resultPromise;
		expect(result.details?.async?.state).toBe("running");
		const jobId = result.details?.async?.jobId;
		if (!jobId) throw new Error("expected a background job id");

		exit.reject(new Error("terminal/wait failed: client disconnected"));
		await waitFor(() => h.delivered.length === 1);
		const delivery = h.delivered[0]!;
		expect(delivery.jobId).toBe(jobId);
		expect(delivery.text).toContain("client disconnected");

		const row = h.manager.getJobsSnapshot().jobs.find(job => job.id === jobId);
		expect(row?.status).toBe("failed");
		expect(row?.deliveryState).toBe("delivered");
		await waitFor(() => releaseSpy.mock.calls.length === 1);
		expect(releaseSpy).toHaveBeenCalledTimes(1);
		// A rejected wait must stop the remote command before releasing the handle.
		expect(killSpy).toHaveBeenCalledTimes(1);
	});

	it("owner teardown mid-fold: failNow delivers the failure, release happens once, cancel is refused", async () => {
		const { exit, handle } = makeHandle("term-owner");
		const bridge: ClientBridge = { capabilities: { terminal: true }, createTerminal: async () => handle };
		const releaseSpy = spyOn(handle, "release");
		const killSpy = spyOn(handle, "kill");

		const h = makeHarness(bridge);
		const tool = new BashTool(h.session);
		const resultPromise = tool.execute("call-owner", { command: "sleep 30" }, undefined, () => {});
		await waitFor(() => h.adapters.length === 1);
		foldVia(h.adapters[0]!);
		const result = await resultPromise;
		const jobId = result.details?.async?.jobId;
		if (!jobId) throw new Error("expected a background job id");

		// The owner is torn down while the remote command is still running. The
		// registered owner cleanup must failNow, not cancel: cancel delivers
		// nothing, which would silently orphan the failure.
		h.manager.runOwnerProducerCleanups({ ownerId: "0-Main" });

		await waitFor(() => h.delivered.length === 1);
		expect(h.delivered[0]).toEqual({ jobId, text: "Client terminal owner was torn down." });
		expect(h.manager.getJob(jobId)?.status).toBe("failed");
		// A failed job must not be cancellable into a deliver-nothing state.
		expect(h.manager.cancel(jobId)).toBe(false);

		// The runner observes the run ended (the remote handle's waitForExit
		// resolves) and its finally releases the terminal exactly once.
		exit.resolve({ exitCode: 0, signal: null });
		await waitFor(() => releaseSpy.mock.calls.length === 1);
		expect(releaseSpy).toHaveBeenCalledTimes(1);
		expect(killSpy).toHaveBeenCalledTimes(1);
	});

	it("owner teardown BEFORE the fold: the foreground wait still releases once", async () => {
		const { exit, handle } = makeHandle("term-owner-pre");
		const bridge: ClientBridge = { capabilities: { terminal: true }, createTerminal: async () => handle };
		const releaseSpy = spyOn(handle, "release");

		const h = makeHarness(bridge);
		const tool = new BashTool(h.session);
		const resultPromise = tool.execute("call-owner-pre", { command: "sleep 30" }, undefined, () => {});
		const resultError = resultPromise.catch(error => error);
		await waitFor(() => h.adapters.length === 1);

		h.manager.runOwnerProducerCleanups({ ownerId: "0-Main" });

		// failNow settles the job; the foreground wait sees the failure and
		// acknowledges it, releasing the terminal exactly once. The remote
		// handle's exit then resolves and the runner's finally releases once.
		await waitFor(() => h.delivered.length === 1);
		exit.resolve({ exitCode: 0, signal: null });
		await waitFor(() => releaseSpy.mock.calls.length === 1);
		expect(releaseSpy).toHaveBeenCalledTimes(1);
		expect(await resultError).toHaveProperty("message");
		expect((await resultError).message).toContain("term-owner-pre output");
	});
});
