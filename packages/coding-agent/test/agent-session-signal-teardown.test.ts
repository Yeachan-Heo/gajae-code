import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { Agent } from "@gajae-code/agent-core";
import { getBundledModel } from "@gajae-code/ai";
import { ModelRegistry } from "@gajae-code/coding-agent/config/model-registry";
import { Settings } from "@gajae-code/coding-agent/config/settings";
import * as contextManager from "@gajae-code/coding-agent/eval/js/context-manager";
import * as pyExecutor from "@gajae-code/coding-agent/eval/py/executor";
import { AgentSession } from "@gajae-code/coding-agent/session/agent-session";
import { AuthStorage } from "@gajae-code/coding-agent/session/auth-storage";
import { SessionManager } from "@gajae-code/coding-agent/session/session-manager";
import * as tabSupervisor from "@gajae-code/coding-agent/tools/browser/tab-supervisor";
import { TempDir } from "@gajae-code/utils";

describe("AgentSession.disposeChildSubprocesses (#698 signal teardown)", () => {
	let tempDir: TempDir | undefined;
	let authStorage: AuthStorage | undefined;
	let session: AgentSession | undefined;
	let sessionManager: SessionManager;
	let releaseTabs: ReturnType<typeof vi.fn>;
	let disposeKernels: ReturnType<typeof vi.fn>;
	let disposeVms: ReturnType<typeof vi.fn>;

	beforeEach(async () => {
		tempDir = TempDir.createSync("@gjc-signal-teardown-");
		authStorage = await AuthStorage.create(path.join(tempDir.path(), "testauth.db"));
		authStorage.setRuntimeApiKey("anthropic", "test-key");
		const modelRegistry = new ModelRegistry(authStorage);
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected bundled anthropic model to exist");
		const agent = new Agent({
			initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] },
		});
		sessionManager = SessionManager.inMemory();
		session = new AgentSession({ agent, sessionManager, settings: Settings.isolated(), modelRegistry });

		releaseTabs = vi.spyOn(tabSupervisor, "releaseTabsForOwner").mockResolvedValue(0);
		disposeKernels = vi.spyOn(pyExecutor, "disposeKernelSessionsByOwner").mockResolvedValue(undefined);
		disposeVms = vi.spyOn(contextManager, "disposeVmContextsByOwner").mockResolvedValue(undefined);
	});

	afterEach(async () => {
		// Ensure the spies resolve so the dispose() teardown below can't hang on a
		// deliberately-stalled mock left over from the boundedness test.
		releaseTabs.mockResolvedValue(0);
		disposeKernels.mockResolvedValue(undefined);
		disposeVms.mockResolvedValue(undefined);
		await session?.dispose();
		session = undefined;
		authStorage?.close();
		authStorage = undefined;
		tempDir?.removeSync();
		tempDir = undefined;
		vi.restoreAllMocks();
	});

	it("releases the session's browser tabs (force-kill) and Python/JS kernels", async () => {
		await session!.disposeChildSubprocesses();

		expect(releaseTabs).toHaveBeenCalledTimes(1);
		expect(releaseTabs).toHaveBeenCalledWith(sessionManager.getSessionId(), { kill: true });
		expect(disposeKernels).toHaveBeenCalledTimes(1);
		expect(disposeVms).toHaveBeenCalledTimes(1);
		// Browser and eval kernels share no owner id, but both teardowns must fire.
		expect(disposeKernels.mock.calls[0]?.[0]).toBe(disposeVms.mock.calls[0]?.[0]);
	});

	it("is idempotent across repeated calls", async () => {
		await session!.disposeChildSubprocesses();
		await session!.disposeChildSubprocesses();

		expect(releaseTabs).toHaveBeenCalledTimes(2);
		expect(disposeKernels).toHaveBeenCalledTimes(2);
		expect(disposeVms).toHaveBeenCalledTimes(2);
	});

	it("returns within the time box even when a teardown step hangs", async () => {
		releaseTabs.mockReturnValue(new Promise<number>(() => {}));

		const start = Date.now();
		await session!.disposeChildSubprocesses(20);
		const elapsed = Date.now() - start;

		expect(elapsed).toBeLessThan(2_000);
		// The non-hanging steps still ran.
		expect(disposeKernels).toHaveBeenCalledTimes(1);
		expect(disposeVms).toHaveBeenCalledTimes(1);
	});

	it("never rejects when a teardown step throws", async () => {
		disposeKernels.mockRejectedValue(new Error("kernel shutdown boom"));

		await expect(session!.disposeChildSubprocesses()).resolves.toBeUndefined();
		expect(releaseTabs).toHaveBeenCalledTimes(1);
		expect(disposeVms).toHaveBeenCalledTimes(1);
	});

	it("drains tool-registered cleanups so a non-eval owner is not orphaned on signal exit", async () => {
		// An autoresearch mission registers its kernel under its own owner id, which is
		// deliberately distinct from the session's eval owner (spec f33). Before the
		// signal path drained these, Ctrl-C left the subprocess running.
		const missionOwner = "autoresearch:mission-1";
		const reaped: string[] = [];
		session!.registerToolSessionCleanup(async () => {
			reaped.push(missionOwner);
		});

		await session!.disposeChildSubprocesses();

		expect(reaped).toEqual([missionOwner]);
		// The mission owner is not the eval owner the built-in disposals target.
		expect(disposeKernels.mock.calls[0]?.[0]).not.toBe(missionOwner);
	});

	it("drains transition-registered cleanups, which is where the SDK actually puts tool cleanups", async () => {
		// The SDK binds a tool's `registerSessionCleanup` to
		// registerToolSessionTransitionCleanup (sdk/session.ts), so a discoverable
		// builtin like the autoresearch mission python tool lands in the TRANSITION
		// set, not the one registerToolSessionCleanup fills. Draining only the latter
		// passed every test while still orphaning the kernel on Ctrl-C in production.
		const missionOwner = "autoresearch:mission-2";
		const reaped: string[] = [];
		session!.registerToolSessionTransitionCleanup(async () => {
			reaped.push(missionOwner);
		});

		await session!.disposeChildSubprocesses();

		expect(reaped).toEqual([missionOwner]);
	});

	it("drains both cleanup sets on a single signal teardown", async () => {
		const order: string[] = [];
		session!.registerToolSessionCleanup(() => {
			order.push("direct");
		});
		session!.registerToolSessionTransitionCleanup(() => {
			order.push("transition");
		});

		await session!.disposeChildSubprocesses();

		expect(order.sort()).toEqual(["direct", "transition"]);
	});

	it("stays inside the time box when a transition cleanup hangs", async () => {
		session!.registerToolSessionTransitionCleanup(() => new Promise<void>(() => {}));

		const start = Date.now();
		await session!.disposeChildSubprocesses(20);

		expect(Date.now() - start).toBeLessThan(2_000);
		expect(disposeKernels).toHaveBeenCalledTimes(1);
	});

	it("does not double-run a tool cleanup that graceful dispose already drained", async () => {
		let runs = 0;
		session!.registerToolSessionCleanup(() => {
			runs += 1;
		});

		await session!.disposeChildSubprocesses();
		await session!.disposeChildSubprocesses();

		expect(runs).toBe(1);
	});

	it("stays inside the time box when a tool cleanup hangs", async () => {
		session!.registerToolSessionCleanup(() => new Promise<void>(() => {}));

		const start = Date.now();
		await session!.disposeChildSubprocesses(20);

		expect(Date.now() - start).toBeLessThan(2_000);
		expect(disposeKernels).toHaveBeenCalledTimes(1);
	});

	it("never rejects when a tool cleanup throws", async () => {
		session!.registerToolSessionCleanup(() => {
			throw new Error("mission kernel dispose boom");
		});

		await expect(session!.disposeChildSubprocesses()).resolves.toBeUndefined();
		expect(disposeKernels).toHaveBeenCalledTimes(1);
	});
});
