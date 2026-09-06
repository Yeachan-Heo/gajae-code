import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { stripVTControlCharacters } from "node:util";
import { Agent, type AgentTool } from "@gajae-code/agent-core";
import type { AssistantMessage, Model } from "@gajae-code/ai";
import { AssistantMessageEventStream } from "@gajae-code/ai/utils/event-stream";
import { AsyncJobManager } from "@gajae-code/coding-agent/async/job-manager";
import { ModelRegistry } from "@gajae-code/coding-agent/config/model-registry";
import { resetSettingsForTest, Settings } from "@gajae-code/coding-agent/config/settings";
import { ExtensionRuntime, loadExtensionFromFactory } from "@gajae-code/coding-agent/extensibility/extensions/loader";
import { ExtensionRunner } from "@gajae-code/coding-agent/extensibility/extensions/runner";
import { EventController } from "@gajae-code/coding-agent/modes/controllers/event-controller";
import {
	InteractiveMode,
	resolveActivityIndicatorMessage,
	tallyBackgroundActivity,
} from "@gajae-code/coding-agent/modes/interactive-mode";
import { initTheme } from "@gajae-code/coding-agent/modes/theme/theme";
import {
	AgentSession,
	type AgentSessionEvent,
	type AsyncJobSnapshotItem,
} from "@gajae-code/coding-agent/session/agent-session";
import { AuthStorage } from "@gajae-code/coding-agent/session/auth-storage";
import { SessionManager } from "@gajae-code/coding-agent/session/session-manager";
import { EventBus } from "@gajae-code/coding-agent/utils/event-bus";
import { Container, Loader } from "@gajae-code/tui";
import { logger, postmortem, TempDir } from "@gajae-code/utils";
import * as z from "zod/v4";
import { VirtualTerminal } from "../../tui/test/virtual-terminal";
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
	const pendingJobs: Array<{ resolve: (value: string) => void }> = [];

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

	async function startContinuingRun(recovery: "compaction" | "hook-veto" | "retry") {
		mode.stop();
		await session.dispose();
		const modelRegistry = new ModelRegistry(authStorage);
		const primary = modelRegistry.find("anthropic", "claude-sonnet-4-5");
		const fallback = modelRegistry.find("openai", "gpt-4o-mini");
		if (!primary || !fallback) throw new Error("Expected bundled continuation models");
		authStorage.setRuntimeApiKey("anthropic", "test-key");
		authStorage.setRuntimeApiKey("openai", "test-key");
		const sessionManager = SessionManager.create(tempDir.path(), tempDir.path());
		const runtime = new ExtensionRuntime();
		const extension = await loadExtensionFromFactory(
			api => {
				api.on("session_before_compact", async event =>
					recovery === "hook-veto"
						? { cancel: true }
						: {
								compaction: {
									summary: "Earlier conversation compacted",
									firstKeptEntryId: event.preparation.firstKeptEntryId,
									tokensBefore: event.preparation.tokensBefore,
								},
							},
				);
			},
			tempDir.path(),
			new EventBus(),
			runtime,
		);
		const firstTool = Promise.withResolvers<string>();
		const continuedTool = Promise.withResolvers<string>();
		pendingJobs.push(firstTool, continuedTool);
		const toolParameters = z.object({ stage: z.enum(["initial", "continued"]) });
		const tool: AgentTool<typeof toolParameters> = {
			name: "activity_probe",
			label: "Activity probe",
			description: "Hold a deterministic tool execution for activity assertions",
			parameters: toolParameters,
			intent: args =>
				args.stage === "initial" ? "Preparing continuation" : "Reviewing remaining responsibility boundaries",
			execute: async (_id, args) => ({
				content: [
					{ type: "text", text: await (args.stage === "initial" ? firstTool.promise : continuedTool.promise) },
				],
			}),
		};
		let calls = 0;
		const response = (model: Model, content: AssistantMessage["content"], totalTokens: number): AssistantMessage => ({
			role: "assistant",
			content,
			api: model.api,
			provider: model.provider,
			model: model.id,
			usage: {
				input: totalTokens,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: content.some(part => part.type === "toolCall") ? "toolUse" : "stop",
			timestamp: Date.now() + calls,
		});
		const agent = new Agent({
			intentTracing: true,
			getApiKey: () => "test-key",
			initialState: { model: primary, systemPrompt: ["Test"], tools: [tool], messages: [] },
			streamFn: model => {
				const call = ++calls;
				const stream = new AssistantMessageEventStream();
				queueMicrotask(() => {
					if (recovery === "retry" && call === 2) {
						const message = {
							...response(model, [], 0),
							stopReason: "error" as const,
							errorMessage: "rate limit exceeded",
							errorStatus: 429,
							transportFailure: { kind: "transport" as const, status: 429 },
						};
						stream.push({ type: "start", partial: message });
						stream.push({ type: "error", reason: "error", error: message });
						return;
					}
					const done = call === (recovery === "retry" ? 4 : 3);
					const message = response(
						model,
						done
							? [{ type: "text", text: "Finished continuation" }]
							: [
									{
										type: "toolCall",
										id: `probe-${call}`,
										name: tool.name,
										arguments: { stage: call === 1 ? "initial" : "continued" },
									},
								],
						recovery !== "retry" && call === 1 ? 180_000 : 1_000,
					);
					stream.push({ type: "start", partial: message });
					stream.push({ type: "done", reason: message.stopReason === "toolUse" ? "toolUse" : "stop", message });
				});
				return stream;
			},
		});
		const settings = Settings.isolated({
			"compaction.enabled": recovery !== "retry",
			"compaction.strategy": "context-full",
			"compaction.thresholdTokens": 100_000,
			"compaction.keepRecentTokens": 10,
			"contextPromotion.enabled": false,
			"retry.baseDelayMs": 1,
			"fallback.maxAttempts": 3,
		});
		settings.setModelRole("default", "anthropic/claude-sonnet-4-5");
		session = new AgentSession({
			agent,
			sessionManager,
			settings,
			modelRegistry,
			agentId: "0-Main",
			extensionRunner: new ExtensionRunner([extension], runtime, tempDir.path(), sessionManager, modelRegistry),
		});
		if (recovery === "retry")
			session.setConfiguredModelChain("default", ["anthropic/claude-sonnet-4-5", "openai/gpt-4o-mini"], "test");
		session.setResourceSampler(() => ({ heapUsedBytes: 0, providerBytes: 0, messageCount: 0, imageBytes: 0 }));
		for (let index = 0; index < 3; index++) {
			agent.emitExternalEvent({
				type: "message_end",
				message: { role: "user", content: `Earlier request ${index}`, timestamp: Date.now() },
			});
			agent.emitExternalEvent({
				type: "message_end",
				message: response(primary, [{ type: "text", text: `Earlier response ${index}` }], 1_000),
			});
		}
		await session.awaitSessionSettlement();
		mode = new InteractiveMode(session, "test");
		const terminal = new VirtualTerminal(100, 30);
		mode.ui.terminal = terminal;
		await mode.init();
		const events: AgentSessionEvent[] = [];
		session.subscribe(event => events.push(event));
		const run = session.prompt("Continue working through recovery");
		await waitFor(() => renderStatus(mode).includes("Preparing continuation"));
		return { events, run, firstTool, continuedTool, terminal };
	}

	it.each([
		"compaction",
		"hook-veto",
		"retry",
	] as const)("keeps the working intent visible through a real %s continuation without agent_start", async recovery => {
		const { events, run, firstTool, continuedTool, terminal } = await startContinuingRun(recovery);
		try {
			expect(renderStatus(mode)).toContain("Preparing continuation");
			firstTool.resolve("first tool complete");
			const recoveredToolId = recovery === "retry" ? "probe-3" : "probe-2";
			await waitFor(() => mode.pendingTools.has(recoveredToolId) && !mode.autoCompactionLoader && !mode.retryLoader);
			expect(events.filter(event => event.type === "agent_start")).toHaveLength(1);
			expect(events.filter(event => event.type === "agent_end")).toHaveLength(0);
			expect(
				events.some(event => event.type === (recovery === "retry" ? "auto_retry_end" : "auto_compaction_end")),
			).toBe(true);
			expect(session.isStreaming).toBe(true);
			expect(renderStatus(mode)).toContain("Reviewing remaining responsibility boundaries");
			for (const width of [60, 100, 160]) {
				terminal.resize(width, 30);
				await terminal.waitForRender();
				expect(terminal.getViewport().join("\n")).toContain("Reviewing remaining responsibility boundaries");
			}
			continuedTool.resolve("continued tool complete");
			await run;
			await session.waitForIdle();
			await waitFor(() => mode.loadingAnimation === undefined);
			expect(events.filter(event => event.type === "agent_end")).toHaveLength(1);
			expect(renderStatus(mode)).toBe("");
			await terminal.waitForRender();
			expect(terminal.getViewport().join("\n")).not.toContain("Reviewing remaining responsibility boundaries");
		} finally {
			firstTool.resolve("cleanup");
			continuedTool.resolve("cleanup");
			await run;
		}
	});

	it("retains foreground intent and background ownership across compaction and terminal cleanup", async () => {
		const { run, firstTool, continuedTool } = await startContinuingRun("compaction");
		const ownerId = session.getAgentId();
		if (!ownerId) throw new Error("Expected owner");
		const background = Promise.withResolvers<string>();
		pendingJobs.push(background);
		const jobId = manager.register("task", "continuation companion", () => background.promise, {
			ownerId,
			metadata: { subagent: { id: "compaction-companion", agent: "executor", agentSource: "bundled" } },
		});
		manager.registerSubagentRecord({
			subagentId: "compaction-companion",
			ownerId,
			currentJobId: jobId,
			historicalJobIds: [],
			status: "running",
			sessionFile: null,
			resumable: false,
		});
		try {
			await waitFor(() => renderStatus(mode).includes("1 subagent"));
			firstTool.resolve("initial complete");
			await waitFor(() => mode.pendingTools.has("probe-2") && !mode.autoCompactionLoader);
			expect(renderStatus(mode)).toContain("Reviewing remaining responsibility boundaries");
			expect(renderStatus(mode)).toContain("1 subagent");
			expect(renderStatus(mode)).not.toContain("Background:");
			continuedTool.resolve("continued complete");
			await run;
			await session.waitForIdle();
			await waitFor(() => renderStatus(mode).includes("Background: 1 subagent"));
			background.resolve("background complete");
			await waitFor(() => mode.loadingAnimation === undefined);
			expect(renderStatus(mode)).toBe("");
		} finally {
			firstTool.resolve("cleanup");
			continuedTool.resolve("cleanup");
			background.resolve("cleanup");
			await run;
		}
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

	it.each([
		"compaction",
		"retry",
	] as const)("does not resurrect terminal foreground activity after %s cleanup with stale streaming state", async recovery => {
		mode.ensureLoadingAnimation();
		Object.defineProperty(session, "isStreaming", { configurable: true, get: () => true });
		const controller = new EventController(mode);
		try {
			await controller.handleEvent(
				recovery === "compaction"
					? { type: "auto_compaction_start", reason: "threshold", action: "context-full" }
					: { type: "auto_retry_start", attempt: 1, maxAttempts: 3, delayMs: 1000, errorMessage: "rate limited" },
			);
			await controller.handleEvent({ type: "agent_end", messages: [], stopReason: "cancelled" });
			await controller.handleEvent(
				recovery === "compaction"
					? {
							type: "auto_compaction_end",
							action: "context-full",
							result: undefined,
							aborted: true,
							willRetry: false,
						}
					: { type: "auto_retry_end", success: false, attempt: 1, finalError: "cancelled" },
			);
			mode.syncActivityIndicator();
			expect(mode.loadingAnimation).toBeUndefined();
			expect(renderStatus(mode)).toBe("");
		} finally {
			controller.dispose();
		}
	});

	it("preserves foreground ownership across repeated retries and nested display suspension", async () => {
		const controller = new EventController(mode);
		mode.ensureLoadingAnimation();
		mode.setWorkingMessage("Reviewing remaining responsibility boundaries");
		const originalEscape = mode.editor.onEscape;
		try {
			for (const attempt of [1, 2]) {
				await controller.handleEvent({
					type: "auto_retry_start",
					attempt,
					maxAttempts: 3,
					delayMs: 1000,
					errorMessage: "rate limited",
				});
				expect(renderStatus(mode)).toContain(`Retrying (${attempt}/3)`);
				expect(mode.statusContainer.children).toHaveLength(1);
			}
			const releaseOuter = mode.suspendActivityIndicator();
			const releaseInner = mode.suspendActivityIndicator();
			try {
				await controller.handleEvent({ type: "auto_retry_end", success: true, attempt: 2 });
				expect(renderStatus(mode)).toBe("");
				releaseInner();
				expect(renderStatus(mode)).toBe("");
			} finally {
				releaseInner();
				releaseOuter();
			}
			expect(mode.editor.onEscape).toBe(originalEscape);
			expect(mode.retryCountdownTimer).toBeUndefined();
			expect(renderStatus(mode)).toContain("Reviewing remaining responsibility boundaries");
			await controller.handleEvent({ type: "agent_end", messages: [] });
			expect(renderStatus(mode)).toBe("");
		} finally {
			controller.dispose();
		}
	});

	it.each([false, true])("keeps idle maintenance idle after completion (aborted=%s)", async aborted => {
		const controller = new EventController(mode);
		try {
			await controller.handleEvent({ type: "auto_compaction_start", reason: "idle", action: "context-full" });
			expect(renderStatus(mode)).toContain("Idle Auto context-full maintenance");
			await controller.handleEvent({
				type: "auto_compaction_end",
				action: "context-full",
				result: undefined,
				aborted,
				skipped: !aborted,
				willRetry: false,
			});
			expect(session.isStreaming).toBe(false);
			expect(mode.loadingAnimation).toBeUndefined();
			expect(renderStatus(mode)).toBe("");
		} finally {
			controller.dispose();
		}
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
