import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { stripVTControlCharacters } from "node:util";
import { Agent } from "@gajae-code/agent-core";
import { AsyncJobManager } from "@gajae-code/coding-agent/async/job-manager";
import { ModelRegistry } from "@gajae-code/coding-agent/config/model-registry";
import { resetSettingsForTest, Settings } from "@gajae-code/coding-agent/config/settings";
import { EventController } from "@gajae-code/coding-agent/modes/controllers/event-controller";
import {
	InteractiveMode,
	resolveActivityIndicatorMessage,
	tallyBackgroundActivity,
} from "@gajae-code/coding-agent/modes/interactive-mode";
import { initTheme } from "@gajae-code/coding-agent/modes/theme/theme";
import { AgentSession, type AsyncJobSnapshotItem } from "@gajae-code/coding-agent/session/agent-session";
import { AuthStorage } from "@gajae-code/coding-agent/session/auth-storage";
import { SessionManager } from "@gajae-code/coding-agent/session/session-manager";
import { Container, Loader } from "@gajae-code/tui";
import { logger, postmortem, TempDir } from "@gajae-code/utils";
import { FileLockTestHooks } from "../src/config/file-lock";
import { ExtensionUiController } from "../src/modes/controllers/extension-ui-controller";
import { SelectorController } from "../src/modes/controllers/selector-controller";

async function waitFor(predicate: () => boolean): Promise<void> {
	for (let attempt = 0; attempt < 100; attempt++) {
		if (predicate()) return;
		await Bun.sleep(5);
	}
	throw new Error("Timed out waiting for activity lifecycle transition");
}

function renderStatus(mode: InteractiveMode): string {
	return stripVTControlCharacters(mode.statusContainer.render(120).join("\n"));
}

describe("interactive background activity indicator", () => {
	let tempDir: TempDir;
	let authStorage: AuthStorage;
	let session: AgentSession;
	let manager: AsyncJobManager;
	let mode: InteractiveMode;
	const pendingJobs: Array<ReturnType<typeof Promise.withResolvers<string>>> = [];

	beforeAll(() => {
		initTheme();
	});

	beforeEach(async () => {
		resetSettingsForTest();
		tempDir = TempDir.createSync("@interactive-background-activity-");
		await Settings.init({ inMemory: true, cwd: tempDir.path() });
		authStorage = await AuthStorage.create(path.join(tempDir.path(), "testauth.db"));
		const modelRegistry = new ModelRegistry(authStorage);
		const model = modelRegistry.find("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected claude-sonnet-4-5 to exist in registry");
		session = new AgentSession({
			agent: new Agent({
				initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] },
			}),
			agentId: "0-Main",
			sessionManager: SessionManager.create(tempDir.path(), tempDir.path()),
			settings: Settings.isolated(),
			modelRegistry,
		});
		manager = new AsyncJobManager({ onJobComplete: () => {}, retentionMs: 60_000 });
		AsyncJobManager.setInstance(manager);
		mode = new InteractiveMode(session, "test");
		await mode.init();
	});

	afterEach(async () => {
		for (const pending of pendingJobs.splice(0)) pending.resolve("done");
		await Bun.sleep(0);
		mode?.stop();
		await session?.dispose();
		await manager?.dispose();
		AsyncJobManager.resetForTests();
		authStorage?.close();
		tempDir?.removeSync();
		resetSettingsForTest();
	});

	it("tallies and distinguishes foreground and background activity messages", () => {
		const running: AsyncJobSnapshotItem[] = [
			{
				id: "subagent",
				type: "task",
				status: "running",
				label: "subagent",
				startTime: 0,
				metadata: { subagent: { id: "subagent", agent: "executor", agentSource: "bundled" } },
			},
			{
				id: "background-bash",
				type: "bash",
				status: "running",
				label: "background bash",
				startTime: 0,
				metadata: { backgrounded: true },
			},
			{ id: "foreground-bash", type: "bash", status: "running", label: "foreground bash", startTime: 0 },
			{
				id: "monitor",
				type: "bash",
				status: "running",
				label: "monitor",
				startTime: 0,
				metadata: { monitor: true },
			},
			{ id: "batch", type: "task", status: "running", label: "batch", startTime: 0 },
		];
		const noActivity = { subagents: 0, backgroundBash: 0, monitors: 0 };
		const mixedActivity = { subagents: 2, backgroundBash: 1, monitors: 1 };

		// A task job without subagent metadata and a Bash job still owned by the
		// foreground match none of the three locked predicates and are not counted.
		expect(tallyBackgroundActivity(running)).toEqual({ subagents: 1, backgroundBash: 1, monitors: 1 });
		expect(resolveActivityIndicatorMessage(false, noActivity, "Working…")).toBeUndefined();
		expect(resolveActivityIndicatorMessage(true, noActivity, "Working…")).toBe("Working…");
		expect(resolveActivityIndicatorMessage(false, mixedActivity, "Working…")).toBe(
			"Background: 2 subagents, 1 background bash, 1 monitor…",
		);
		expect(resolveActivityIndicatorMessage(true, mixedActivity, "Working…")).toBe(
			"Working… · 2 subagents, 1 background bash, 1 monitor",
		);
		expect(resolveActivityIndicatorMessage(false, { subagents: 1, backgroundBash: 0, monitors: 0 }, "Working…")).toBe(
			"Background: 1 subagent…",
		);
		expect(resolveActivityIndicatorMessage(true, { subagents: 0, backgroundBash: 1, monitors: 0 }, "Working…")).toBe(
			"Working… · 1 background bash",
		);
		expect(resolveActivityIndicatorMessage(false, { subagents: 0, backgroundBash: 0, monitors: 2 }, "Working…")).toBe(
			"Background: 2 monitors…",
		);
	});

	it("uses layout-only repaints for the foreground activity indicator", () => {
		const layoutRender = vi.spyOn(mode.ui, "requestLayoutRender");
		const fullRender = vi.spyOn(mode.ui, "requestRender");
		try {
			mode.ensureLoadingAnimation();

			expect(layoutRender).toHaveBeenCalledWith("loader");
			expect(fullRender.mock.calls.some(([, source]) => source === "loader")).toBe(false);
		} finally {
			mode.stopLoadingAnimation({ foregroundSettled: true });
			layoutRender.mockRestore();
			fullRender.mockRestore();
		}
	});

	it("retires the foreground indicator when agent_end races stale streaming state", async () => {
		mode.ensureLoadingAnimation();
		Object.defineProperty(session, "isStreaming", { configurable: true, get: () => true });
		const controller = new EventController(mode);

		await controller.handleEvent({ type: "agent_end", messages: [] });
		mode.syncActivityIndicator();

		expect(mode.loadingAnimation).toBeUndefined();
		expect(renderStatus(mode)).toBe("");
	});

	it("publishes terminal activity cleanup before a slow coordinator sidecar write", async () => {
		mode.ensureLoadingAnimation();
		const lockEntered = Promise.withResolvers<void>();
		const releaseLock = Promise.withResolvers<void>();
		let gated = true;
		const previousHook = FileLockTestHooks.afterParentMkdir;
		FileLockTestHooks.afterParentMkdir = async lockPath => {
			if (!gated || !lockPath.endsWith("mutation.lock.lock")) return;
			gated = false;
			lockEntered.resolve();
			await releaseLock.promise;
		};

		try {
			session.agent.emitExternalEvent({ type: "agent_end", messages: [] });
			await lockEntered.promise;
			await waitFor(() => mode.loadingAnimation === undefined);
		} finally {
			releaseLock.resolve();
			FileLockTestHooks.afterParentMkdir = previousHook;
		}
	});

	it("escalates a second exit while graceful shutdown is blocked", async () => {
		const flush = Promise.withResolvers<void>();
		vi.spyOn(session.sessionManager, "flush").mockReturnValue(flush.promise);
		const quit = vi.spyOn(postmortem, "quit").mockResolvedValue(undefined);

		const firstShutdown = mode.shutdown();
		await Bun.sleep(0);
		await mode.shutdown();

		expect(quit).toHaveBeenCalledWith(1);

		flush.resolve();
		await firstShutdown;
		expect(quit).toHaveBeenCalledWith(0);
	});

	it("retires stale foreground activity across maintenance stop boundaries", async () => {
		mode.ensureLoadingAnimation();
		Object.defineProperty(session, "isStreaming", { configurable: true, get: () => true });
		const controller = new EventController(mode);

		await controller.handleEvent({ type: "auto_compaction_start", reason: "threshold", action: "context-full" });
		mode.autoCompactionLoader?.stop();
		mode.autoCompactionLoader = undefined;
		mode.statusContainer.clear();
		mode.syncActivityIndicator();

		expect(mode.loadingAnimation).toBeUndefined();
		expect(renderStatus(mode)).toBe("");
	});

	it("preserves background activity and re-arms after settled terminal cleanup", async () => {
		const ownerId = session.getAgentId();
		if (!ownerId) throw new Error("Expected an owner id");
		const background = Promise.withResolvers<string>();
		pendingJobs.push(background);
		const jobId = manager.register("task", "terminal-boundary activity", () => background.promise, {
			ownerId,
			metadata: {
				subagent: { id: "terminal-boundary-subagent", agent: "executor", agentSource: "bundled" },
			},
		});
		manager.registerSubagentRecord({
			subagentId: "terminal-boundary-subagent",
			ownerId,
			currentJobId: jobId,
			historicalJobIds: [],
			status: "running",
			sessionFile: null,
			resumable: false,
		});
		await waitFor(() => mode.loadingAnimation !== undefined);

		mode.ensureLoadingAnimation();
		Object.defineProperty(session, "isStreaming", { configurable: true, get: () => true });
		const controller = new EventController(mode);
		await controller.handleEvent({ type: "agent_end", messages: [] });
		mode.syncActivityIndicator();
		const backgroundLoader = mode.loadingAnimation;
		if (!backgroundLoader) throw new Error("Expected background loader after agent_end");
		expect(renderStatus(mode)).toContain("Background: 1 subagent…");

		await controller.handleEvent({ type: "agent_end", messages: [] });
		mode.syncActivityIndicator();
		expect(mode.loadingAnimation).toBe(backgroundLoader);
		expect(renderStatus(mode)).toContain("Background: 1 subagent…");

		const releaseSuspension = mode.suspendActivityIndicator();
		expect(renderStatus(mode)).toBe("");
		await controller.handleEvent({ type: "agent_end", messages: [] });
		releaseSuspension();
		expect(mode.loadingAnimation).toBe(backgroundLoader);
		expect(renderStatus(mode)).toContain("Background: 1 subagent…");

		await controller.handleEvent({ type: "agent_start" });
		expect(renderStatus(mode)).toContain("Working…");
		expect(renderStatus(mode)).toContain("1 subagent");

		background.resolve("done");
		pendingJobs.pop();
		await waitFor(() => manager.getAllJobs({ ownerId }).find(job => job.id === jobId)?.status === "completed");
		Object.defineProperty(session, "isStreaming", { configurable: true, get: () => false });
		await controller.handleEvent({ type: "agent_end", messages: [] });
		await waitFor(() => mode.loadingAnimation === undefined);
	});

	it("schedules the startup crash relay hook from trusted global settings", async () => {
		const debug = vi.spyOn(logger, "debug");
		Settings.instance.set("crashReport.upstream", "sentry");
		Settings.instance.set("crashReport.upstreamDsn", "ftp://invalid.example/1");
		mode.stop();
		mode = new InteractiveMode(session, "test");
		await mode.init();
		await Bun.sleep(20);

		expect(debug).toHaveBeenCalledWith("Crash relay finished", {
			outcome: { status: "skipped", reason: "invalid-dsn" },
		});
		debug.mockRestore();
	});
	it("rejects pending user input when the interactive mode stops", async () => {
		const input = mode.getUserInput();
		mode.stop();

		await expect(input).rejects.toMatchObject({
			message: "Interactive mode stopped",
			code: "cancelled",
		});
	});

	it("keeps owned work visible across foreground end, errors, aborts, completion, and disposal", async () => {
		const ownerId = session.getAgentId();
		if (!ownerId) throw new Error("Expected an owner id");

		const foreign = Promise.withResolvers<string>();
		pendingJobs.push(foreign);
		const foreignJobId = manager.register("task", "foreign activity", () => foreign.promise, {
			ownerId: "foreign-owner",
			metadata: { subagent: { id: "foreign-subagent", agent: "executor", agentSource: "bundled" } },
		});
		manager.registerSubagentRecord({
			subagentId: "foreign-subagent",
			ownerId: "foreign-owner",
			currentJobId: foreignJobId,
			historicalJobIds: [],
			status: "running",
			sessionFile: null,
			resumable: false,
		});
		await Bun.sleep(10);
		expect(mode.loadingAnimation).toBeUndefined();
		foreign.resolve("done");
		pendingJobs.pop();
		await waitFor(() => manager.getAllJobs({ ownerId: "foreign-owner" })[0]?.status === "completed");

		const background = Promise.withResolvers<string>();
		pendingJobs.push(background);
		const jobId = manager.register("task", "background activity", () => background.promise, {
			ownerId,
			metadata: { subagent: { id: "owned-subagent", agent: "executor", agentSource: "bundled" } },
		});
		expect(mode.loadingAnimation).toBeUndefined();
		manager.registerSubagentRecord({
			subagentId: "owned-subagent",
			ownerId,
			currentJobId: jobId,
			historicalJobIds: [],
			status: "running",
			sessionFile: null,
			resumable: false,
		});

		await waitFor(() => mode.loadingAnimation !== undefined);
		expect(manager.getAllJobs({ ownerId }).find(job => job.id === jobId)?.status).toBe("running");
		expect(renderStatus(mode)).toContain("Background: 1 subagent…");

		mode.ensureLoadingAnimation();
		expect(renderStatus(mode)).toContain("Working…");
		expect(renderStatus(mode)).toContain("1 subagent");

		mode.stopLoadingAnimation();
		expect(renderStatus(mode)).toContain("Background: 1 subagent…");

		mode.stopLoadingAnimation({ restoreBackground: false });
		expect(renderStatus(mode)).toBe("");
		mode.syncActivityIndicator();
		expect(renderStatus(mode)).toContain("Background: 1 subagent…");

		const suspendedBackgroundLoader = mode.loadingAnimation;
		if (!suspendedBackgroundLoader) throw new Error("Expected background loader before suspension");
		const stopSuspendedBackgroundLoader = vi.spyOn(suspendedBackgroundLoader, "stop");
		const releaseModalActivity = mode.suspendActivityIndicator();
		expect(renderStatus(mode)).toBe("");
		mode.syncActivityIndicator();
		expect(renderStatus(mode)).toBe("");
		releaseModalActivity();
		expect(mode.loadingAnimation).toBe(suspendedBackgroundLoader);
		expect(stopSuspendedBackgroundLoader).not.toHaveBeenCalled();
		expect(renderStatus(mode)).toContain("Background: 1 subagent…");

		mode.ensureLoadingAnimation();
		let streaming = true;
		Object.defineProperty(session, "isStreaming", { configurable: true, get: () => streaming });
		mode.showError("nonterminal deferred tool error");
		expect(renderStatus(mode)).toContain("Working…");
		streaming = false;
		mode.showError("provider failed");
		expect(renderStatus(mode)).toContain("Background: 1 subagent…");

		const submission = mode.startPendingSubmission({ text: "cancelled", customType: "test" });
		expect(mode.cancelPendingSubmission()).toBe(true);
		expect(submission.cancelled).toBe(true);
		expect(renderStatus(mode)).toContain("Background: 1 subagent…");

		background.resolve("done");
		pendingJobs.pop();
		await waitFor(() => manager.getAllJobs({ ownerId }).find(job => job.id === jobId)?.status === "completed");
		await waitFor(() => mode.loadingAnimation === undefined);
		expect(renderStatus(mode)).toBe("");

		const cancelled = Promise.withResolvers<string>();
		pendingJobs.push(cancelled);
		const cancelledJobId = manager.register("task", "cancelled activity", () => cancelled.promise, {
			ownerId,
			metadata: { subagent: { id: "cancelled-subagent", agent: "executor", agentSource: "bundled" } },
		});
		await waitFor(() => mode.loadingAnimation !== undefined);
		expect(manager.cancel(cancelledJobId, { ownerId })).toBe(true);
		await waitFor(() => mode.loadingAnimation === undefined);
		expect(manager.getAllJobs({ ownerId }).find(job => job.id === cancelledJobId)?.status).toBe("cancelled");
		cancelled.resolve("done");
		pendingJobs.pop();

		mode.stop();
		const afterStop = Promise.withResolvers<string>();
		pendingJobs.push(afterStop);
		const afterStopJobId = manager.register("task", "must not resurrect", () => afterStop.promise, {
			ownerId,
			metadata: { subagent: { id: "after-stop-subagent", agent: "executor", agentSource: "bundled" } },
		});
		manager.registerSubagentRecord({
			subagentId: "after-stop-subagent",
			ownerId,
			currentJobId: afterStopJobId,
			historicalJobIds: [],
			status: "running",
			sessionFile: null,
			resumable: false,
		});
		await Bun.sleep(10);
		expect(mode.loadingAnimation).toBeUndefined();
	});

	it("preserves specialized and nested custom loaders across suspend, release, and stop", async () => {
		const ownerId = session.getAgentId();
		if (!ownerId) throw new Error("Expected an owner id");
		const background = Promise.withResolvers<string>();
		pendingJobs.push(background);
		const jobId = manager.register("task", "lease activity", () => background.promise, {
			ownerId,
			metadata: { subagent: { id: "lease-subagent", agent: "executor", agentSource: "bundled" } },
		});
		manager.registerSubagentRecord({
			subagentId: "lease-subagent",
			ownerId,
			currentJobId: jobId,
			historicalJobIds: [],
			status: "running",
			sessionFile: null,
			resumable: false,
		});
		await waitFor(() => mode.loadingAnimation !== undefined);

		const retryLoader = mode.loadingAnimation!;
		retryLoader.setMessage("Retrying specialized operation");
		mode.loadingAnimation = undefined;
		mode.retryLoader = retryLoader;
		const releaseRetryOuter = mode.suspendActivityIndicator();
		const releaseRetryInner = mode.suspendActivityIndicator();
		mode.syncActivityIndicator();
		expect(mode.retryLoader).toBe(retryLoader);
		expect(renderStatus(mode)).toContain("Retrying specialized operation");
		releaseRetryInner();
		expect(renderStatus(mode)).toContain("Retrying specialized operation");
		releaseRetryOuter();
		expect(renderStatus(mode)).toContain("Retrying specialized operation");

		mode.retryLoader = undefined;
		retryLoader.stop();
		mode.statusContainer.clear();
		mode.syncActivityIndicator();
		expect(renderStatus(mode)).toContain("Background: 1 subagent…");

		const releaseCustomOuter = mode.suspendActivityIndicator();
		const customLoader = new Loader(
			mode.ui,
			value => value,
			value => value,
			"Custom modal activity",
			["."],
		);
		mode.statusContainer.addChild(customLoader);
		const releaseCustomInner = mode.suspendActivityIndicator();
		mode.syncActivityIndicator();
		expect(renderStatus(mode)).toContain("Custom modal activity");
		releaseCustomInner();
		expect(renderStatus(mode)).toContain("Custom modal activity");
		customLoader.stop();
		mode.statusContainer.clear();
		releaseCustomOuter();
		expect(renderStatus(mode)).toContain("Background: 1 subagent…");

		const releaseAfterStop = mode.suspendActivityIndicator();
		const stoppedLoader = new Loader(
			mode.ui,
			value => value,
			value => value,
			"Must not survive stop",
			["."],
		);
		mode.statusContainer.addChild(stoppedLoader);
		mode.stop();
		releaseAfterStop();
		expect(mode.loadingAnimation).toBeUndefined();
		expect(renderStatus(mode)).toBe("");
	});

	it("settles open hook dialogs and custom UI during final disposal", async () => {
		const selection = mode.showHookSelector("Choose", ["one"]);
		const customController = new ExtensionUiController(mode);
		const custom = customController.showHookCustom(() => new Container());

		mode.stop();
		customController.dispose();

		expect(await selection).toBeUndefined();
		expect(await custom).toBeUndefined();
	});

	it("does not remount async selectors or refresh slash state after final stop", async () => {
		const sessions = Promise.withResolvers<[]>();
		const listSessions = vi
			.spyOn(mode.sessionManager, "listForResumePickerReadOnly")
			.mockImplementation(() => sessions.promise);
		const selectorController = new SelectorController(mode);
		const showSelector = vi.spyOn(selectorController, "showSelector");
		const selecting = selectorController.showSessionSelector();
		await waitFor(() => listSessions.mock.calls.length === 1);
		const setAutocompleteProvider = vi.spyOn(mode.editor, "setAutocompleteProvider");

		mode.stop();
		sessions.resolve([]);
		await selecting;
		await mode.refreshSlashCommandState();

		expect(showSelector).not.toHaveBeenCalled();
		expect(setAutocompleteProvider).not.toHaveBeenCalled();
	});

	it("does not finish initialization after final stop wins an awaited setup race", async () => {
		mode.stop();
		mode = new InteractiveMode(session, "test");
		const setup = Promise.withResolvers<void>();
		const refresh = vi.spyOn(mode, "refreshSlashCommandState").mockImplementation(() => setup.promise);
		const initializing = mode.init();
		const concurrentInitialization = mode.init();
		expect(concurrentInitialization).toBe(initializing);
		await waitFor(() => refresh.mock.calls.length === 1);
		mode.stop();
		setup.resolve();
		await initializing;
		expect(mode.isInitialized).toBe(false);
	});

	it("does not resume subscriptions after stop wins post-start hook initialization", async () => {
		mode.stop();
		mode = new InteractiveMode(session, "test");
		const hooks = Promise.withResolvers<void>();
		const initializeHooks = vi.spyOn(mode, "initHooksAndCustomTools").mockImplementation(() => hooks.promise);
		const initializing = mode.init();
		await waitFor(() => initializeHooks.mock.calls.length === 1);
		expect(mode.isInitialized).toBe(true);
		mode.stop();
		hooks.resolve();
		await initializing;
		expect(mode.isInitialized).toBe(false);
	});
});
