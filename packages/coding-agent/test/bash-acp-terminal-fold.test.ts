import { afterEach, describe, expect, it, mock, spyOn } from "bun:test";
import { AsyncJobManager } from "../src/async";
import { JobsObserver } from "../src/modes/jobs-observer";
import type {
	ClientBridge,
	ClientBridgeTerminalHandle,
	ClientBridgeTerminalOutput,
} from "../src/session/client-bridge";
import type { FoldAdapter } from "../src/session/fold-coordinator";
import type { ToolSession } from "../src/tools";
import { BashTool } from "../src/tools/bash";

interface Harness {
	session: ToolSession;
	manager: AsyncJobManager;
	adapters: FoldAdapter[];
	delivered: Array<{ jobId: string; text: string }>;
}

function makeHarness(
	bridge: ClientBridge,
	options: { autoBackgroundEnabled?: boolean; thresholdMs?: number } = {},
): Harness {
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
				if (key === "bash.autoBackground.enabled") return options.autoBackgroundEnabled ?? false;
				if (key === "bash.autoBackground.thresholdMs") return options.thresholdMs ?? 60_000;
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

afterEach(() => {
	mock.restore();
	AsyncJobManager.resetForTests();
});

describe("BashTool ACP terminal fold", () => {
	it("folds a client terminal, retaining exactly one remote handle across the fold", async () => {
		const exit = Promise.withResolvers<{ exitCode: number; signal: null }>();
		const handle: ClientBridgeTerminalHandle = {
			terminalId: "term-fold",
			waitForExit: () => exit.promise,
			currentOutput: async () => ({ output: "step 1 done\n", truncated: false }),
			kill: async () => {},
			release: async () => {},
		};
		const bridge: ClientBridge = { capabilities: { terminal: true }, createTerminal: async () => handle };
		const createSpy = spyOn(bridge, "createTerminal");
		const releaseSpy = spyOn(handle, "release");
		const killSpy = spyOn(handle, "kill");

		const h = makeHarness(bridge);
		const tool = new BashTool(h.session);
		const resultPromise = tool.execute("call-fold", { command: "sleep 30" }, undefined, () => {});

		// The bridge registered a foldable participant for its manager-backed job.
		await waitFor(() => h.adapters.length === 1);
		const adapter = h.adapters[0]!;
		expect(adapter.kind).toBe("client-terminal");

		foldVia(adapter);
		const result = await resultPromise;

		// The foreground returned a background-start result that keeps the terminal
		// card bound to the same remote id.
		expect(result.details?.async?.state).toBe("running");
		expect(result.details?.terminalId).toBe("term-fold");
		const backgroundJobId = result.details?.async?.jobId;
		expect(backgroundJobId).toBeTruthy();
		expect(h.manager.getJob(backgroundJobId!)?.metadata?.backgrounded).toBe(true);
		expect(createSpy).toHaveBeenCalledTimes(1);
		// Retained, not torn down: folding must never kill or release the remote work.
		expect(releaseSpy).not.toHaveBeenCalled();
		expect(killSpy).not.toHaveBeenCalled();

		// The folded command finishes on its own and is delivered as a background job.
		exit.resolve({ exitCode: 0, signal: null });
		await waitFor(() => h.delivered.length === 1);
		expect(h.delivered[0]?.text).toContain("step 1 done");
		// Released exactly once, by the job that owns it now.
		await waitFor(() => releaseSpy.mock.calls.length === 1);
		expect(releaseSpy).toHaveBeenCalledTimes(1);
	});

	it("auto-backgrounds an ACP terminal with manager and observer visibility", async () => {
		const exit = Promise.withResolvers<{ exitCode: number; signal: null }>();
		let releaseCalls = 0;
		const handle: ClientBridgeTerminalHandle = {
			terminalId: "term-auto-background",
			waitForExit: () => exit.promise,
			currentOutput: async () => ({ output: "auto background output\n", truncated: false }),
			kill: async () => {},
			release: async () => {
				releaseCalls += 1;
			},
		};
		const bridge: ClientBridge = { capabilities: { terminal: true }, createTerminal: async () => handle };
		const h = makeHarness(bridge, { autoBackgroundEnabled: true, thresholdMs: 10 });
		const observer = new JobsObserver(h.manager, "0-Main");
		try {
			const tool = new BashTool(h.session);
			const result = await tool.execute("call-auto-background", { command: "sleep 30" }, undefined, () => {});
			expect(result.details?.async?.state).toBe("running");
			const jobId = result.details?.async?.jobId;
			if (!jobId) throw new Error("expected auto-backgrounded ACP job id");
			expect(h.manager.getJob(jobId)?.metadata?.backgrounded).toBe(true);
			expect(observer.getSnapshot().foldedJobs?.find(job => job.id === jobId)?.backgrounded).toBe(true);

			exit.resolve({ exitCode: 0, signal: null });
			await waitFor(() => h.delivered.length === 1);
			await waitFor(() => releaseCalls === 1);
			expect(releaseCalls).toBe(1);
		} finally {
			observer.dispose();
		}
	});

	it("surfaces a client-killed folded terminal as a delivered failure, releasing once", async () => {
		const exit = Promise.withResolvers<{ exitCode: number; signal: null }>();
		let poisoned = false;
		const handle: ClientBridgeTerminalHandle = {
			terminalId: "term-killed",
			waitForExit: () => exit.promise,
			currentOutput: async () => {
				if (poisoned) throw new Error("terminal/output failed: client disconnected");
				return { output: "partial\n", truncated: false };
			},
			kill: async () => {},
			release: async () => {},
		};
		const bridge: ClientBridge = { capabilities: { terminal: true }, createTerminal: async () => handle };
		const releaseSpy = spyOn(handle, "release");

		const h = makeHarness(bridge);
		const tool = new BashTool(h.session);
		const resultPromise = tool.execute("call-killed", { command: "sleep 30" }, undefined, () => {});

		await waitFor(() => h.adapters.length === 1);
		foldVia(h.adapters[0]!);
		const result = await resultPromise;
		expect(result.details?.async?.state).toBe("running");
		const jobId = result.details?.async?.jobId;
		if (!jobId) throw new Error("expected a background job id");

		// The client dies mid-fold: the poll read starts rejecting and the exit never
		// arrives normally.
		poisoned = true;
		exit.reject(new Error("terminal/wait failed: client disconnected"));

		// The failure is DELIVERED, not swallowed: no terminal job may end silent.
		await waitFor(() => h.delivered.length === 1);
		const delivery = h.delivered[0];
		if (!delivery) throw new Error("expected a delivered failure");
		expect(delivery.jobId).toBe(jobId);
		expect(delivery.text).toContain("client disconnected");

		const row = h.manager.getJobsSnapshot().jobs.find(job => job.id === jobId);
		if (!row) throw new Error("expected the failed job in the snapshot");
		expect(row.status).toBe("failed");
		// Exactly one public state, and it is not the silent set.
		expect(["delivered", "failed-visible"]).toContain(row.deliveryState);

		await waitFor(() => releaseSpy.mock.calls.length === 1);
		expect(releaseSpy).toHaveBeenCalledTimes(1);
	});

	it("keeps routing a capable ACP session through the client terminal", async () => {
		const handle: ClientBridgeTerminalHandle = {
			terminalId: "term-route",
			waitForExit: async () => ({ exitCode: 0, signal: null }),
			currentOutput: async () => ({ output: "routed\n", truncated: false }),
			kill: async () => {},
			release: async () => {},
		};
		const bridge: ClientBridge = { capabilities: { terminal: true }, createTerminal: async () => handle };
		const createSpy = spyOn(bridge, "createTerminal");

		const h = makeHarness(bridge);
		const tool = new BashTool(h.session);
		const result = await tool.execute("call-route", { command: "echo routed" }, undefined, () => {});

		// A manager being available must not divert the command to the local
		// executor: the ACP terminal contract still owns execution, and exactly one
		// remote handle is created.
		expect(createSpy).toHaveBeenCalledTimes(1);
		expect(result.details?.terminalId).toBe("term-route");
	});

	it("returns an update error when post-create ACP cleanup never settles", async () => {
		const handle: ClientBridgeTerminalHandle = {
			terminalId: "term-update-error",
			waitForExit: async () => ({ exitCode: 0, signal: null }),
			currentOutput: async () => ({ output: "", truncated: false }),
			kill: async () => await new Promise<void>(() => {}),
			release: async () => await new Promise<void>(() => {}),
		};
		const bridge: ClientBridge = { capabilities: { terminal: true }, createTerminal: async () => handle };
		const h = makeHarness(bridge);
		const tool = new BashTool(h.session);
		const startedAt = Date.now();

		await expect(
			tool.execute("call-update-error", { command: "sleep 30" }, undefined, () => {
				throw new Error("editor update failed");
			}),
		).rejects.toThrow("editor update failed");
		expect(Date.now() - startedAt).toBeLessThan(2_500);
		expect(h.manager.getJobsSnapshot().jobs).toHaveLength(0);
	});

	it("retains polled ACP output when timeout recovery read expires", async () => {
		let outputReads = 0;
		const pendingOutput = new Promise<ClientBridgeTerminalOutput>(() => {});
		const handle: ClientBridgeTerminalHandle = {
			terminalId: "term-timeout-recovery",
			waitForExit: () => new Promise(() => {}),
			currentOutput: async () => {
				outputReads += 1;
				if (outputReads === 1) return { output: "polled diagnostics\n", truncated: false };
				return pendingOutput;
			},
			kill: async () => {},
			release: async () => {},
		};
		const bridge: ClientBridge = { capabilities: { terminal: true }, createTerminal: async () => handle };
		const h = makeHarness(bridge);
		const tool = new BashTool(h.session);

		const result = await tool.execute(
			"call-timeout-recovery",
			{ command: "sleep 30", timeout: 1 },
			undefined,
			() => {},
		);
		expect(result.details?.async?.state).toBe("running");
		await waitFor(() => h.delivered.length === 1, 4_000);
		const text = h.delivered[0]?.text ?? "";
		expect(text).toContain("polled diagnostics");
		expect(text).toContain("Command timed out after 1 seconds");
	});

	it("retains polled ACP output without a job manager", async () => {
		let outputReads = 0;
		const handle: ClientBridgeTerminalHandle = {
			terminalId: "term-managerless-timeout-recovery",
			waitForExit: () => new Promise(() => {}),
			currentOutput: async () => {
				outputReads += 1;
				if (outputReads <= 3) return { output: "managerless diagnostics\n", truncated: false };
				throw new Error("terminal/output failed during recovery");
			},
			kill: async () => {},
			release: async () => {},
		};
		const bridge: ClientBridge = { capabilities: { terminal: true }, createTerminal: async () => handle };
		const h = makeHarness(bridge);
		const tool = new BashTool({ ...h.session, getAsyncJobManager: undefined } as unknown as ToolSession);

		await expect(
			tool.execute("call-managerless-timeout-recovery", { command: "sleep 30", timeout: 1 }, undefined, () => {}),
		).rejects.toThrow(/managerless diagnostics[\s\S]*Command timed out after 1 seconds/);
	});

	it("retains polled ACP output when normal-exit final read rejects", async () => {
		let outputReads = 0;
		const exit = Promise.withResolvers<{ exitCode: number; signal: null }>();
		const handle: ClientBridgeTerminalHandle = {
			terminalId: "term-normal-exit-recovery",
			waitForExit: () => exit.promise,
			currentOutput: async () => {
				outputReads += 1;
				if (outputReads === 1) return { output: "normal-exit diagnostics\n", truncated: false };
				throw new Error("terminal/output failed after exit");
			},
			kill: async () => {},
			release: async () => {},
		};
		const bridge: ClientBridge = { capabilities: { terminal: true }, createTerminal: async () => handle };
		const h = makeHarness(bridge);
		const tool = new BashTool({ ...h.session, getAsyncJobManager: undefined } as unknown as ToolSession);

		const resultPromise = tool.execute("call-normal-exit-recovery", { command: "echo done" }, undefined, () => {});
		await waitFor(() => outputReads === 1);
		exit.resolve({ exitCode: 0, signal: null });
		const result = await resultPromise;
		const text = result.content.map(part => ("text" in part ? part.text : "")).join("\n");
		expect(text).toContain("normal-exit diagnostics");
		expect(text).toContain("Terminal output recovery failed");
	});

	it("retains polled ACP output when abort races final recovery", async () => {
		let outputReads = 0;
		const exit = Promise.withResolvers<{ exitCode: number; signal: null }>();
		const pendingOutput = new Promise<ClientBridgeTerminalOutput>(() => {});
		const handle: ClientBridgeTerminalHandle = {
			terminalId: "term-abort-recovery",
			waitForExit: () => exit.promise,
			currentOutput: async () => {
				outputReads += 1;
				if (outputReads === 1) return { output: "abort diagnostics\n", truncated: false };
				return pendingOutput;
			},
			kill: async () => {},
			release: async () => {},
		};
		const bridge: ClientBridge = { capabilities: { terminal: true }, createTerminal: async () => handle };
		const h = makeHarness(bridge);
		const controller = new AbortController();
		const tool = new BashTool({ ...h.session, getAsyncJobManager: undefined } as unknown as ToolSession);

		const resultPromise = tool.execute("call-abort-recovery", { command: "echo done" }, controller.signal, () => {});
		await waitFor(() => outputReads === 1);
		exit.resolve({ exitCode: 0, signal: null });
		await waitFor(() => outputReads === 2);
		controller.abort();
		await expect(resultPromise).rejects.toThrow(/abort diagnostics[\s\S]*Command aborted/);
	});

	it("kills and retains output when an ACP poll read rejects", async () => {
		let outputReads = 0;
		let killCalls = 0;
		const handle: ClientBridgeTerminalHandle = {
			terminalId: "term-poll-recovery",
			waitForExit: () => new Promise(() => {}),
			currentOutput: async () => {
				outputReads += 1;
				if (outputReads === 1) return { output: "poll diagnostics\n", truncated: false };
				throw new Error("terminal/output failed during poll");
			},
			kill: async () => {
				killCalls += 1;
			},
			release: async () => {},
		};
		const bridge: ClientBridge = { capabilities: { terminal: true }, createTerminal: async () => handle };
		const h = makeHarness(bridge);
		const tool = new BashTool({ ...h.session, getAsyncJobManager: undefined } as unknown as ToolSession);

		await expect(tool.execute("call-poll-recovery", { command: "echo done" }, undefined, () => {})).rejects.toThrow(
			/poll diagnostics[\s\S]*Terminal output recovery failed[\s\S]*terminal\/output failed during poll/,
		);
		expect(killCalls).toBe(1);
	});

	it("kills and retains output when ACP progress update throws", async () => {
		const exit = Promise.withResolvers<{ exitCode: number; signal: null }>();
		let killCalls = 0;
		const handle: ClientBridgeTerminalHandle = {
			terminalId: "term-update-recovery",
			waitForExit: () => exit.promise,
			currentOutput: async () => ({ output: "update diagnostics\n", truncated: false }),
			kill: async () => {
				killCalls += 1;
			},
			release: async () => {},
		};
		const bridge: ClientBridge = { capabilities: { terminal: true }, createTerminal: async () => handle };
		const h = makeHarness(bridge);
		const tool = new BashTool({ ...h.session, getAsyncJobManager: undefined } as unknown as ToolSession);

		await expect(
			tool.execute("call-update-recovery", { command: "echo done" }, undefined, update => {
				if (update.content.length > 0) throw new Error("progress callback failed");
			}),
		).rejects.toThrow(/update diagnostics[\s\S]*Terminal output recovery failed/);
		expect(killCalls).toBe(1);
	});
});
