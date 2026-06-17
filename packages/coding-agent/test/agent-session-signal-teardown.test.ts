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
});
