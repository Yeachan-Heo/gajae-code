import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Agent, type AgentTool } from "@gajae-code/agent-core";
import { getBundledModel } from "@gajae-code/ai";
import { createMockModel, type MockResponse } from "@gajae-code/ai/providers/mock";
import { ModelRegistry } from "@gajae-code/coding-agent/config/model-registry";
import { resetSettingsForTest, Settings } from "@gajae-code/coding-agent/config/settings";
import { createAgentSession } from "@gajae-code/coding-agent/sdk";
import { AgentSession } from "@gajae-code/coding-agent/session/agent-session";
import { AuthStorage } from "@gajae-code/coding-agent/session/auth-storage";
import { convertToLlm } from "@gajae-code/coding-agent/session/messages";
import { SessionManager } from "@gajae-code/coding-agent/session/session-manager";
import {
	bindToolLineage,
	classifyOwnedCompletion,
	lookupOwnedRegistration,
	type OwnedCompletionEnvelope,
	registerOwnedRegistration,
	registerTerminalTurnScope,
	resetTerminalAbortRegistriesForTests,
	type TurnRegistrationKey,
} from "@gajae-code/coding-agent/session/terminal-abort";
import type { ToolSession } from "@gajae-code/coding-agent/tools";
import { BashTool } from "@gajae-code/coding-agent/tools/bash";
import { JobTool } from "@gajae-code/coding-agent/tools/job";
import { MonitorTool } from "@gajae-code/coding-agent/tools/monitor";
import { SubagentTool } from "@gajae-code/coding-agent/tools/subagent";
import { Snowflake } from "@gajae-code/utils";
import { AsyncJobManager } from "../src/async";

/** Scripted assistant turn that issues a single `bash` tool call. */
function bashCall(command: string, callId: string, background = false): MockResponse {
	return {
		content: [
			{
				type: "toolCall",
				id: callId,
				name: "bash",
				arguments: { command, timeout: 10, ...(background ? { background: true } : {}) },
			},
		],
		stopReason: "toolUse",
	};
}

/** Scripted plain-text assistant turn with `stopReason: "stop"`. */
function stopReply(text: string): MockResponse {
	return {
		content: [{ type: "text", text }],
		stopReason: "stop",
	};
}

async function waitFor(predicate: () => boolean, label: string, timeoutMs = 10_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!predicate()) {
		if (Date.now() > deadline) throw new Error(`Timed out waiting for ${label}`);
		await Bun.sleep(10);
	}
}

describe("terminal abort registers a turn scope so left-running owned work classifies by source", () => {
	let session: AgentSession;
	let chainSessionManager: SessionManager;
	let tempDir: string;
	let authStorage: AuthStorage | undefined;
	let scriptedResponses: MockResponse[];
	let manager: AsyncJobManager;
	let bashToolRef: BashTool;
	let toolSession: ToolSession;
	let settingsRef: Settings;
	let modelRegistryRef: ModelRegistry;

	beforeEach(async () => {
		tempDir = path.join(os.tmpdir(), `pi-terminal-abort-chain-${Snowflake.next()}`);
		fs.mkdirSync(tempDir, { recursive: true });

		resetSettingsForTest();
		await Settings.init({ inMemory: true, cwd: tempDir });

		authStorage = await AuthStorage.create(path.join(tempDir, "testauth.db"));
		authStorage.setRuntimeApiKey("anthropic", "test-key");

		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("expected claude-sonnet-4-5 to be bundled");

		const modelRegistry = new ModelRegistry(authStorage, path.join(tempDir, "models.yml"));
		modelRegistryRef = modelRegistry;
		const settings = Settings.isolated({
			"compaction.enabled": false,
			"todo.enabled": false,
			"todo.eager": false,
			"todo.reminders": false,
			// The managed async-job path must be live so BashTool registers jobs
			// and the terminal-abort lineage binding is captured.
			"async.enabled": true,
			"bash.autoBackground.enabled": true,
		});
		settingsRef = settings;
		const sessionManager = SessionManager.inMemory(tempDir);
		chainSessionManager = sessionManager;

		const ts: ToolSession = {
			cwd: tempDir,
			hasUI: false,
			settings,
			getSessionFile: () => sessionManager.getSessionFile() ?? null,
			getSessionId: () => sessionManager.getSessionId?.() ?? null,
			getSessionSpawns: () => "*",
		};
		const bashTool = new BashTool(ts);
		bashToolRef = bashTool;
		toolSession = ts;

		scriptedResponses = [];

		const mock = createMockModel({
			handler: () => scriptedResponses.shift() ?? stopReply("done"),
		});

		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: {
				model,
				systemPrompt: ["Test"],
				tools: [bashTool as unknown as AgentTool],
				messages: [],
			},
			convertToLlm,
			streamFn: mock.stream,
		});

		manager = new AsyncJobManager({ maxRunningJobs: 2, onJobComplete: () => {} });
		AsyncJobManager.setInstance(manager);
		// Mirror the production sdk/session.ts wiring: the manager is registered
		// under the session endpoint so managed jobs resolve the endpoint-owned
		// manager instead of the process-global instance (review thread P1).
		AsyncJobManager.registerForEndpoint(chainSessionManager.getSessionId(), manager);
		// Isolate the module-global terminal-abort registries per test: job ids
		// (bg_N) and generations (job:N) collide across fresh managers, and the
		// registries are process-lifetime by design.
		resetTerminalAbortRegistriesForTests();

		session = new AgentSession({
			agent,
			sessionManager,
			settings,
			modelRegistry,
			toolRegistry: new Map([[bashTool.name, bashTool as unknown as AgentTool]]),
		});
		session.setSdkPermissionMode("allow");
	});

	afterEach(async () => {
		AsyncJobManager.setInstance(undefined);
		AsyncJobManager.unregisterManager(manager);
		await session?.dispose();
		authStorage?.close();
		authStorage = undefined;
		if (fs.existsSync(tempDir)) {
			fs.rmSync(tempDir, { recursive: true, force: true });
		}
	});

	it("terminal abort registers the scope so the left-running owned job classifies as owned-completion", async () => {
		const callId = "call_terminal_owned";
		scriptedResponses = [bashCall("sleep 30", callId, true), stopReply("ok")];

		const promptPromise = session.prompt("run owned work").catch(() => {});
		await waitFor(() => manager.getAllJobs().length > 0, "bash job registered");
		// Wait for the background job to be fully backgrounded (the prompt
		// completes, the tool returns the background result) so the abort cannot
		// interrupt a foreground wait and cancel+unregister the job — it must
		// stay registered as left-running owned work.
		await promptPromise;
		const job = manager.getAllJobs()[0]!;

		const handle = session.agent.activeResourceRunId;
		const proof = await session.abortPromptAndWait(handle ?? job.id, {
			graceMs: 2_000,
			terminal: { scope: "turn" },
		});
		// The abort may or may not fence (run handle availability varies), but the
		// terminal scope MUST be registered for the aborted turn either way.
		expect(proof).toBeDefined();

		// The left-running owned job now classifies by exact source lineage.
		const classified = classifyOwnedCompletion(job.id, job.generation);
		expect(classified).toBeDefined();
		expect(classified?.registration.jobId).toBe(job.id);
		expect(classified?.registration.jobGeneration).toBe(job.generation);

		await promptPromise;
	}, 20_000);

	it("starts managed jobs in the session's endpoint-owned manager, not the process-global instance", async () => {
		// Reproduction of the review-thread P1 scenario: a SECOND session's
		// manager is the process-global instance, while this session's manager
		// is registered under its endpoint. A Bash launched by THIS session
		// must land in the endpoint-owned manager — otherwise a scope:"owned"
		// abort consults the endpoint manager and cannot cancel the actual
		// job, and missing-job settlement retires the tuple while the job
		// keeps running.
		const foreign = new AsyncJobManager({ maxRunningJobs: 2, onJobComplete: () => {} });
		try {
			AsyncJobManager.setInstance(foreign);
			scriptedResponses = [bashCall("sleep 30", "call_endpoint_manager", true), stopReply("ok")];
			const promptPromise = session.prompt("run owned work").catch(() => {});
			await waitFor(() => manager.getAllJobs().length > 0, "job registered in the endpoint-owned manager");
			expect(manager.getAllJobs().length).toBeGreaterThan(0);
			// The process-global (foreign) manager never received this session's job.
			expect(foreign.getAllJobs().length).toBe(0);
			await promptPromise;
		} finally {
			AsyncJobManager.setInstance(manager);
			AsyncJobManager.unregisterManager(foreign);
		}
	}, 20_000);

	it("preserves the live global manager when duplicate endpoint admission rejects session construction", async () => {
		const liveSessionManager = SessionManager.inMemory(tempDir);
		const duplicateSessionManager = SessionManager.inMemory(tempDir);
		let liveSession: AgentSession | undefined;
		const endpointId = liveSessionManager.getSessionId();
		const duplicateId = vi.spyOn(duplicateSessionManager, "getSessionId").mockReturnValue(endpointId);
		try {
			const created = await createAgentSession({
				cwd: tempDir,
				agentDir: tempDir,
				authStorage,
				settings: Settings.isolated({ "async.enabled": true }),
				sessionManager: liveSessionManager,
				model: getBundledModel("anthropic", "claude-sonnet-4-5"),
				disableExtensionDiscovery: true,
				extensions: [],
				skills: [],
				rules: [],
				contextFiles: [],
				promptTemplates: [],
				slashCommands: [],
				enableMCP: false,
				enableLsp: false,
				toolNames: ["__none__"],
			});
			liveSession = created.session;
			const liveManager = AsyncJobManager.forEndpoint(endpointId);
			expect(liveManager).toBeDefined();
			expect(AsyncJobManager.instance()).toBe(liveManager);

			// A second top-level construction with the same endpoint must fail
			// BEFORE setInstance() runs. Previously it replaced the live global
			// with the rejected construction's orphan manager, redirecting
			// global-manager consumers away from the live session.
			await expect(
				createAgentSession({
					cwd: tempDir,
					agentDir: tempDir,
					authStorage,
					settings: Settings.isolated({ "async.enabled": true }),
					sessionManager: duplicateSessionManager,
					model: getBundledModel("anthropic", "claude-sonnet-4-5"),
					disableExtensionDiscovery: true,
					extensions: [],
					skills: [],
					rules: [],
					contextFiles: [],
					promptTemplates: [],
					slashCommands: [],
					enableMCP: false,
					enableLsp: false,
					toolNames: ["__none__"],
				}),
			).rejects.toThrow("endpoint id is already held by another live async job manager");
			expect(AsyncJobManager.forEndpoint(endpointId)).toBe(liveManager);
			expect(AsyncJobManager.instance()).toBe(liveManager);
		} finally {
			duplicateId.mockRestore();
			await liveSession?.dispose();
			AsyncJobManager.setInstance(manager);
		}
	}, 20_000);

	it("releases an admitted endpoint manager when startup fails before session construction", async () => {
		const startupSessionManager = SessionManager.inMemory(tempDir);
		const endpointId = startupSessionManager.getSessionId();
		const blockedArtifactsDir = path.join(tempDir, "not-a-directory");
		fs.writeFileSync(blockedArtifactsDir, "file blocks local root initialization");
		const options = {
			cwd: tempDir,
			agentDir: tempDir,
			authStorage,
			settings: Settings.isolated({ "async.enabled": true }),
			sessionManager: startupSessionManager,
			model: getBundledModel("anthropic", "claude-sonnet-4-5"),
			disableExtensionDiscovery: true,
			extensions: [],
			skills: [],
			rules: [],
			contextFiles: [],
			promptTemplates: [],
			slashCommands: [],
			enableMCP: false,
			enableLsp: false,
			toolNames: ["__none__"],
		};
		await expect(
			createAgentSession({
				...options,
				localProtocolOptions: {
					getArtifactsDir: () => blockedArtifactsDir,
					isManagedDestination: () => false,
				},
			}),
		).rejects.toThrow();
		// The failed pre-session startup restores the prior global and removes
		// the admitted endpoint mapping, so retrying the same endpoint works.
		expect(AsyncJobManager.forEndpoint(endpointId)).toBeUndefined();
		expect(AsyncJobManager.instance()).toBe(manager);
		const retry = await createAgentSession(options);
		try {
			expect(AsyncJobManager.forEndpoint(endpointId)).toBeDefined();
		} finally {
			await retry.session.dispose();
			AsyncJobManager.setInstance(manager);
		}
	}, 20_000);

	it("starts async Bash through its endpoint manager after the global manager is cleared", async () => {
		// Reproduction of the review-thread P1 scenario: concurrent top-level
		// session B had been the global instance and was disposed, clearing
		// instance(), while this live session's manager remains registered by
		// endpoint. The async-request gate must consult the endpoint-first
		// resolver before rejecting Bash.
		try {
			AsyncJobManager.setInstance(undefined);
			scriptedResponses = [bashCall("sleep 30", "call_endpoint_after_global_dispose", true), stopReply("ok")];
			const promptPromise = session.prompt("run endpoint-owned async work").catch(() => {});
			await waitFor(() => manager.getAllJobs().length > 0, "job registered after global manager was cleared");
			expect(manager.getAllJobs().length).toBeGreaterThan(0);
			await promptPromise;
		} finally {
			AsyncJobManager.setInstance(manager);
		}
	}, 20_000);

	it("owned scope registers a scope with owned-completion delivery disabled", async () => {
		const callId = "call_terminal_owned_disabled";
		scriptedResponses = [bashCall("sleep 30", callId, true), stopReply("ok")];

		const promptPromise = session.prompt("run capturable work").catch(() => {});
		await waitFor(() => manager.getAllJobs().length > 0, "bash job registered");
		// Fully background the job first so the abort cannot interrupt a
		// foreground wait and cancel+unregister it (review thread P2).
		await promptPromise;
		const job = manager.getAllJobs()[0]!;

		await session.abortPromptAndWait(session.agent.activeResourceRunId ?? job.id, {
			graceMs: 2_000,
			terminal: { scope: "owned" },
		});

		// The job still classifies as owned (exact tuple), but the scope's
		// owned-completion policy is disabled — no resume from stopped work.
		const classified = classifyOwnedCompletion(job.id, job.generation);
		expect(classified).toBeDefined();
		expect(classified?.registration.promptAttemptEpoch).toBeGreaterThanOrEqual(0);

		await promptPromise;
	}, 20_000);

	it("terminal abort advances the epoch so a later turn's work never binds the aborted scope", async () => {
		// Turn A spawns a job; terminal abort fences turn A's lineage+epoch.
		scriptedResponses = [bashCall("sleep 30", "call-a", true), stopReply("ok")];
		const firstPrompt = session.prompt("first turn").catch(() => {});
		await waitFor(() => manager.getAllJobs().length > 0, "first job registered");
		await firstPrompt;
		const firstJob = manager.getAllJobs()[0]!;
		await session.abortPromptAndWait(session.agent.activeResourceRunId ?? firstJob.id, {
			graceMs: 2_000,
			terminal: { scope: "turn" },
		});
		expect(classifyOwnedCompletion(firstJob.id, firstJob.generation)).toBeDefined();

		// Turn B (fresh user prompt) spawns a job in a NEW turn: the epoch
		// advanced, so its lineage is distinct and the aborted scope must NOT
		// claim it (AC 27/28 — the fence bounds only the aborted turn).
		const jobCountBefore = manager.getAllJobs().length;
		scriptedResponses = [bashCall("sleep 30", "call-b", true), stopReply("ok")];
		const secondPrompt = session.prompt("second turn").catch(() => {});
		await waitFor(() => manager.getAllJobs().length > jobCountBefore, "second job registered");
		await secondPrompt;
		const secondJob = manager.getAllJobs().find(job => job.id !== firstJob.id)!;
		expect(classifyOwnedCompletion(secondJob.id, secondJob.generation)).toBeUndefined();
	}, 20_000);

	it("consecutive normal turns get distinct lineage epochs; owned abort of turn B never captures turn A's job", async () => {
		// Turn A completes normally (no abort), leaving a registered job.
		scriptedResponses = [bashCall("sleep 30", "call-distinct-a", true), stopReply("ok")];
		await session.prompt("first turn");
		await waitFor(() => manager.getAllJobs().length >= 1, "first job registered");
		const jobA = manager.getAllJobs()[0]!;

		// Turn B also completes normally; the lineage epoch must NOT be reused,
		// otherwise both turns share (lineageIdHash, epoch) and turn A's job
		// would look owned by turn B (review thread P1).
		scriptedResponses = [bashCall("sleep 30", "call-distinct-b", true), stopReply("ok")];
		await session.prompt("second turn");
		await waitFor(() => manager.getAllJobs().length >= 2, "second job registered");
		const jobB = manager.getAllJobs().find(job => job.id !== jobA.id)!;

		// Terminal owned abort of the CURRENT turn (B): its scope captures only
		// B's exact registered work; turn A's left-running job stays foreign.
		await session.abortPromptAndWait(session.agent.activeResourceRunId ?? jobB.id, {
			graceMs: 2_000,
			terminal: { scope: "owned" },
		});
		expect(classifyOwnedCompletion(jobA.id, jobA.generation)).toBeUndefined();
		expect(classifyOwnedCompletion(jobB.id, jobB.generation)).toBeDefined();
	}, 20_000);

	it("monitor jobs are registered as exact owned work of the turn (scope:owned can stop them)", async () => {
		// Bind a lineage to the monitor tool call id as beforeToolCall would.
		// The monitor path resolves the binding with the SESSION endpoint (the
		// Bash/Job paths do the same), so the bind must carry that endpoint.
		const bindEndpoint = chainSessionManager.getSessionId?.() ?? "local";
		bindToolLineage("call-monitor", {
			lineageIdHash: "monitor-lineage",
			promptAttemptEpoch: 41,
			endpointGeneration: 0,
			endpointId: bindEndpoint,
		});
		const monitorJob = await bashToolRef.startMonitorJob(
			{ command: "echo monitor", timeout: 10 },
			{ toolCallId: "call-monitor" },
		);
		const registration = lookupOwnedRegistration(
			monitorJob.jobId,
			manager.getJob(monitorJob.jobId)?.generation ?? "",
		);
		expect(registration).toBeDefined();
		expect(registration?.lineageIdHash).toBe("monitor-lineage");
		expect(registration?.promptAttemptEpoch).toBe(41);
	}, 20_000);

	it("terminal abort discards hidden next-turn messages queued by the aborted turn", async () => {
		// A hidden next-turn successor is scheduled for the current generation;
		// the terminal abort closes the fence BEFORE the scheduled drain runs,
		// so the drain is blocked and must discard the queued messages instead
		// of leaving them for a later explicit prompt (review thread P2).
		session.queueDeferredMessageForTests(
			{
				role: "custom",
				customType: "test-hidden-next-turn",
				content: [{ type: "text", text: "hidden successor" }],
				display: true,
				details: {},
				timestamp: Date.now(),
			},
			true,
		);
		await session.abortPromptAndWait(session.agent.activeResourceRunId ?? "run", {
			graceMs: 2_000,
			terminal: { scope: "turn" },
		});
		expect(session.getPendingNextTurnMessagesForTests()).toHaveLength(0);
	}, 20_000);

	it("terminal abort + new prompt discards hidden next-turn successors before injection", async () => {
		scriptedResponses = [stopReply("ok")];
		await session.prompt("first turn");
		// A hidden successor is queued for the current (first) turn's generation.
		session.queueDeferredMessageForTests(
			{
				role: "custom",
				customType: "test-hidden-skip",
				content: [{ type: "text", text: "hidden successor" }],
				display: true,
				details: {},
				timestamp: Date.now(),
			},
			true,
		);
		// Terminal abort closes the first turn's fence.
		await session.abortPromptAndWait(session.agent.activeResourceRunId ?? "run", {
			graceMs: 2_000,
			terminal: { scope: "turn" },
		});
		// A NEW prompt advances the generation: the scheduled drain is skipped,
		// and the explicit-prompt admission must discard the aborted turn's
		// hidden successors instead of injecting them into this new turn
		// (review thread P2).
		scriptedResponses = [stopReply("ok")];
		await session.prompt("new user turn");
		expect(session.getPendingNextTurnMessagesForTests()).toHaveLength(0);
	}, 20_000);

	it("terminal abort purges steering queued for the aborted turn but keeps owned-completion follow-ups", async () => {
		scriptedResponses = [stopReply("ok")];
		await session.prompt("first turn");
		// A steer is queued just before the terminal abort wins.
		session.agent.steer({
			role: "custom",
			customType: "steer-test",
			content: [{ type: "text", text: "stale steer" }],
			display: true,
			details: {},
			timestamp: Date.now(),
		});
		await session.abortPromptAndWait(session.agent.activeResourceRunId ?? "run", {
			graceMs: 2_000,
			terminal: { scope: "turn" },
		});
		// The queued steering is purged so it cannot alter the next user turn;
		// the follow-up queue is untouched (owned-completion resumes still deliver).
		expect(session.agent.hasQueuedSteering()).toBe(false);
		expect(session.agent.snapshotQueues().followUp).toHaveLength(0);
	}, 20_000);
	it("settles owned-completion registrations when the idle prompt attempt fails", async () => {
		// Reproduction of the review-thread P2 scenario: an idle owned-completion
		// is drained by the yield queue and injected via agent.prompt; when the
		// provider call REJECTS, the drained entry has no further delivery
		// boundary, so the settlement must run in a finally around the prompt
		// attempt — otherwise the terminal tuple leaks until registry saturation.
		const bindEndpoint = chainSessionManager.getSessionId?.() ?? "local";
		const jobId = "bg-idle-fail";
		const generation = "job:1";
		const registration: TurnRegistrationKey = {
			endpointId: bindEndpoint,
			endpointGeneration: 0,
			lineageIdHash: "idle-fail-lineage",
			promptAttemptEpoch: 55,
			jobId,
			jobGeneration: generation,
		};
		registerTerminalTurnScope({
			lineageIdHash: registration.lineageIdHash,
			promptAttemptEpoch: registration.promptAttemptEpoch,
		});
		registerOwnedRegistration(registration, { isJobTerminal: () => true });
		expect(lookupOwnedRegistration(jobId, generation, bindEndpoint)).toBeDefined();

		const unregisterKind = session.yieldQueue.register<{ ownedCompletion: OwnedCompletionEnvelope }>(
			"test-idle-fail",
			{
				isStale: () => false,
				groupKey: () => "idle-fail",
				build: entries => ({
					role: "custom",
					customType: "test-idle-fail",
					content: "idle completion",
					display: false,
					details: { ownedCompletions: entries.map(entry => entry.ownedCompletion) },
					timestamp: Date.now(),
				}),
			},
		);
		const promptSpy = vi.spyOn(session.agent, "prompt").mockRejectedValue(new Error("provider failure"));
		try {
			session.yieldQueue.enqueue("test-idle-fail", {
				ownedCompletion: {
					lineageIdHash: registration.lineageIdHash,
					promptAttemptEpoch: registration.promptAttemptEpoch,
					registration,
				},
			});
			// The enqueue schedules an idle flush (session is idle); wait for the
			// drained entry's settlement boundary to fire — the prompt rejects,
			// so the finally must be what retires the tuple.
			await waitFor(
				() => lookupOwnedRegistration(jobId, generation, bindEndpoint) === undefined,
				"tuple settled after failed idle injection",
				10_000,
			);
		} finally {
			promptSpy.mockRestore();
			unregisterKind();
		}
	}, 20_000);

	it("foreground bash completes and acknowledges on the endpoint-owned manager, never the process-global instance", async () => {
		// Reproduction of the review-thread P1 scenario: the FOREGROUND
		// completion/abort branches must use the same endpoint-owned manager
		// the job was created in — the process-global instance belongs to a
		// different concurrent session and would ack a same-id foreign delivery
		// while leaving this session's delivery queued.
		const foreign = new AsyncJobManager({ maxRunningJobs: 2, onJobComplete: () => {} });
		try {
			AsyncJobManager.setInstance(foreign);
			const bindEndpoint = chainSessionManager.getSessionId() ?? "local";
			scriptedResponses = [bashCall("echo foreground-ok", "call_fg_endpoint", false), stopReply("done")];
			const promptPromise = session.prompt("run foreground work").catch(() => {});
			await promptPromise;
			// The foreground job landed in the endpoint-owned manager and its
			// terminal delivery was acknowledged there.
			expect(foreign.getAllJobs().length).toBe(0);
			const endpointJobs = manager.getAllJobs();
			expect(endpointJobs.length).toBeGreaterThan(0);
			await waitFor(() => manager.getDeliveryState().queued === 0, "endpoint delivery acknowledged", 5_000);
			// The foreground owned-bash registration is unregistered on the
			// endpoint manager's tuple after completion.
			const job = endpointJobs[0]!;
			await waitFor(
				() => lookupOwnedRegistration(job.id, job.generation, bindEndpoint) === undefined,
				"foreground owned-bash registration unregistered",
				5_000,
			);
		} finally {
			AsyncJobManager.setInstance(manager);
			AsyncJobManager.unregisterManager(foreign);
		}
	}, 20_000);

	it("JobTool lists and cancels jobs on the endpoint-owned manager", async () => {
		// Reproduction of the review-thread P1 scenario: JobTool.execute and
		// #snapshotJobs must resolve the session's endpoint manager — a
		// non-global session A otherwise inspects session B's manager and
		// cannot manage the job A just launched.
		const foreign = new AsyncJobManager({ maxRunningJobs: 2, onJobComplete: () => {} });
		try {
			AsyncJobManager.setInstance(foreign);
			scriptedResponses = [bashCall("sleep 30", "call_jobtool", true), stopReply("ok")];
			const promptPromise = session.prompt("spawn job").catch(() => {});
			await waitFor(() => manager.getAllJobs().length > 0, "job registered");
			await promptPromise;
			const jobTool = new JobTool(toolSession);
			const job = manager.getAllJobs()[0]!;
			const listResult = await jobTool.execute("job-call", { list: true });
			expect(listResult.details?.jobs.some(snapshot => snapshot.id === job.id)).toBe(true);
			const cancelResult = await jobTool.execute("job-call", { cancel: [job.id] });
			expect(cancelResult.details?.cancelled?.[0]?.status).toBe("cancelled");
			await waitFor(() => manager.getJob(job.id)?.status !== "running", "endpoint job cancelled", 5_000);
		} finally {
			AsyncJobManager.setInstance(manager);
			AsyncJobManager.unregisterManager(foreign);
		}
	}, 20_000);

	it("routes child tools through their inherited manager instead of a concurrent global manager", async () => {
		// Child sessions have their own unregistered endpoint. Their tools must
		// use the manager inherited from the parent rather than process-global
		// session B, or jobs and their async-result delivery cross session trees.
		const foreign = new AsyncJobManager({ maxRunningJobs: 2, onJobComplete: () => {} });
		try {
			AsyncJobManager.setInstance(foreign);
			const childToolSession: ToolSession = {
				...toolSession,
				getSessionId: () => "unregistered-child-endpoint",
				getAsyncJobManager: () => manager,
			};
			const monitorTool = new MonitorTool(childToolSession);
			await monitorTool.execute("monitor-call", {
				command: "echo monitor-line",
				kind: "other",
				description: "probe",
			});
			expect(foreign.getAllJobs().length).toBe(0);
			const endpointJobs = manager.getAllJobs();
			expect(endpointJobs.length).toBe(1);
			// Non-persistent monitors cancel after the first delivered line —
			// on the endpoint manager that owns the job.
			await waitFor(
				() => manager.getJob(endpointJobs[0]!.id)?.status !== "running",
				"endpoint monitor cancelled",
				5_000,
			);
		} finally {
			AsyncJobManager.setInstance(manager);
			AsyncJobManager.unregisterManager(foreign);
		}
	}, 20_000);

	it("session transitions cancel and settle through the session-owned manager, never the process-global instance", async () => {
		// Reproduction of the review-thread P1 scenario: with concurrent
		// top-level sessions and B as the process-global instance, a
		// transition (newSession/fork/handoff/switch) must run
		// #cancelOwnAsyncJobs / #settleOwnAsyncJobsBeforeArtifactRetirement
		// against THIS session's OWNED manager — resolving the process-global
		// instance would cancel nothing of A's (B's manager), then rekeying
		// retires A's predecessor registrations while A's old job keeps
		// running and its stale completion reaches the successor.
		const foreign = new AsyncJobManager({ maxRunningJobs: 2, onJobComplete: () => {} });
		const owned = new AsyncJobManager({ maxRunningJobs: 2, onJobComplete: () => {} });
		let transitionSession: AgentSession | undefined;
		try {
			AsyncJobManager.setInstance(foreign);
			// A same-owner job exists in BOTH managers: the old (broken) code
			// canceled the global instance's job; the fixed code must only
			// touch the session-owned manager.
			foreign.register("task", "foreign same-owner job", () => new Promise(() => {}), {
				id: "foreign-owner-job",
				ownerId: "sub-route-1",
			});
			owned.register("task", "owned job", () => new Promise(() => {}), {
				id: "owned-owner-job",
				ownerId: "sub-route-1",
			});
			expect(foreign.getJob("foreign-owner-job")?.status).toBe("running");
			expect(owned.getJob("owned-owner-job")?.status).toBe("running");

			const mock = createMockModel({ handler: () => stopReply("done") });
			const agent = new Agent({
				getApiKey: () => "test-key",
				initialState: {
					model: getBundledModel("anthropic", "claude-sonnet-4-5")!,
					systemPrompt: ["Test"],
					tools: [bashToolRef as unknown as AgentTool],
					messages: [],
				},
				convertToLlm,
				streamFn: mock.stream,
			});
			transitionSession = new AgentSession({
				agent,
				sessionManager: SessionManager.inMemory(tempDir),
				settings: settingsRef,
				modelRegistry: modelRegistryRef,
				toolRegistry: new Map([[bashToolRef.name, bashToolRef as unknown as AgentTool]]),
				// Mirror the production sdk/session.ts wiring: the top-level
				// session owns its endpoint manager.
				agentId: "sub-route-1",
				ownedAsyncJobManager: owned,
			});
			await transitionSession.dispose();
			// The OWNED manager's same-owner job was torn down; the FOREIGN
			// (process-global) manager's same-owner job is untouched — proving
			// cleanup resolved through the session-owned manager.
			expect(foreign.getJob("foreign-owner-job")?.status).toBe("running");
			expect(owned.getJob("owned-owner-job")).toBeUndefined();
		} finally {
			AsyncJobManager.setInstance(manager);
			AsyncJobManager.unregisterManager(foreign);
			AsyncJobManager.unregisterManager(owned);
			await transitionSession?.dispose();
		}
	}, 20_000);

	it("getAsyncJobSnapshot reads the session-owned manager, never the process-global instance", async () => {
		// Reproduction of the review-thread P2 scenario: /jobs, the status
		// header, and the active-background count must reflect THIS session's
		// jobs — with concurrent top-level sessions and B as the process-global
		// instance, snapshotting B would report no running jobs for A or show
		// B's.
		const foreign = new AsyncJobManager({ maxRunningJobs: 2, onJobComplete: () => {} });
		const owned = new AsyncJobManager({ maxRunningJobs: 2, onJobComplete: () => {} });
		let snapshotSession: AgentSession | undefined;
		try {
			AsyncJobManager.setInstance(foreign);
			foreign.register("bash", "foreign job", () => new Promise(() => {}), {
				id: "snap-foreign",
				ownerId: "sub-snap-1",
			});
			owned.register("bash", "owned job", () => new Promise(() => {}), {
				id: "snap-owned",
				ownerId: "sub-snap-1",
			});

			const mock = createMockModel({ handler: () => stopReply("done") });
			const agent = new Agent({
				getApiKey: () => "test-key",
				initialState: {
					model: getBundledModel("anthropic", "claude-sonnet-4-5")!,
					systemPrompt: ["Test"],
					tools: [bashToolRef as unknown as AgentTool],
					messages: [],
				},
				convertToLlm,
				streamFn: mock.stream,
			});
			snapshotSession = new AgentSession({
				agent,
				sessionManager: SessionManager.inMemory(tempDir),
				settings: settingsRef,
				modelRegistry: modelRegistryRef,
				toolRegistry: new Map([[bashToolRef.name, bashToolRef as unknown as AgentTool]]),
				agentId: "sub-snap-1",
				ownedAsyncJobManager: owned,
			});
			const snapshot = snapshotSession.getAsyncJobSnapshot();
			expect(snapshot?.running.some(job => job.id === "snap-owned")).toBe(true);
			expect(snapshot?.running.some(job => job.id === "snap-foreign")).toBe(false);
		} finally {
			AsyncJobManager.setInstance(manager);
			AsyncJobManager.unregisterManager(foreign);
			AsyncJobManager.unregisterManager(owned);
			await snapshotSession?.dispose();
		}
	}, 20_000);

	it("job tail keeps paused (queued-resume) jobs registered until they are cancelled", async () => {
		// Reproduction of the review-thread P2 scenario: a still-queued resume
		// job reports status "paused" (not quiescent — settleOwnedWork cancels
		// paused jobs before it can claim stopped_owned), so the job tool's
		// terminal filter must NOT retire its ownership tuple — otherwise a
		// later scope:"owned" abort finds an empty causal set and reports
		// stopped_owned while the job remains visibly paused.
		const pausedManager = new AsyncJobManager({ maxRunningJobs: 1, onJobComplete: () => {} });
		const pausedEndpoint = "ep-paused-route";
		try {
			AsyncJobManager.registerForEndpoint(pausedEndpoint, pausedManager);
			// Occupy the only concurrency slot so the resume queues instead of
			// starting.
			pausedManager.register("task", "filler", () => new Promise(() => {}), {
				id: "filler-paused",
				ownerId: "sub-paused-1",
			});
			pausedManager.registerSubagentRecord({
				subagentId: "sub-paused-1",
				ownerId: "sub-paused-1",
				currentJobId: null,
				historicalJobIds: [],
				status: "paused",
				sessionFile: "/tmp/sub-paused-1.jsonl",
				resumable: true,
			});
			pausedManager.setResumeRunner(() => "job-resumed-paused");
			bindToolLineage("resume-call-paused", {
				lineageIdHash: "paused-lineage",
				promptAttemptEpoch: 7,
				endpointGeneration: 0,
				endpointId: pausedEndpoint,
			});
			const queued = pausedManager.resumeSubagent(
				"sub-paused-1",
				{ ownerId: "sub-paused-1" },
				"resume msg",
				"resume-call-paused",
			);
			expect(queued.ok).toBe(true);
			expect(queued.status).toBe("queued");
			const queuedId = "queued:sub-paused-1:1";
			const queuedJob = pausedManager.getJob(queuedId);
			expect(queuedJob?.status).toBe("paused");
			const queuedRegistration: TurnRegistrationKey = {
				endpointId: pausedEndpoint,
				endpointGeneration: 0,
				lineageIdHash: "paused-lineage",
				promptAttemptEpoch: 7,
				jobId: queuedId,
				jobGeneration: queuedId,
			};
			registerOwnedRegistration(queuedRegistration, { isJobTerminal: () => true });
			expect(lookupOwnedRegistration(queuedId, queuedId, pausedEndpoint)).toBeDefined();

			const pausedTs: ToolSession = {
				cwd: tempDir,
				hasUI: false,
				settings: settingsRef,
				getSessionFile: () => chainSessionManager.getSessionFile() ?? null,
				getSessionId: () => pausedEndpoint,
				getSessionSpawns: () => "*",
			};
			const jobTool = new JobTool(pausedTs);
			await jobTool.execute("job-call", { tail: [queuedId] });
			// The paused job's ownership tuple SURVIVES the job-tool read —
			// only completed/failed/cancelled jobs retire their registrations.
			expect(lookupOwnedRegistration(queuedId, queuedId, pausedEndpoint)).toBeDefined();
		} finally {
			AsyncJobManager.unregisterManager(pausedManager);
		}
	}, 20_000);

	it("direct idle owned-monitor delivery settles the delivered registration", async () => {
		// Reproduction of the review-thread P2 scenario: an owned monitor
		// notification admitted while the session is idle goes through the
		// DIRECT #promptWithMessage path (bypassing onFollowUpConsumed), and a
		// non-persistent monitor cancels right after its first line — so the
		// finally must settle the delivered envelope, as the yield-queue idle
		// injector already does, or the terminal tuple occupies the registry
		// until saturation.
		const bindEndpoint = chainSessionManager.getSessionId?.() ?? "local";
		const jobId = "mon-idle-direct";
		const generation = "job:1";
		const registration: TurnRegistrationKey = {
			endpointId: bindEndpoint,
			endpointGeneration: 0,
			lineageIdHash: "idle-direct-lineage",
			promptAttemptEpoch: 66,
			jobId,
			jobGeneration: generation,
		};
		// Turn-scope registration classifies the envelope "fresh", so the
		// direct idle admission runs the prompt (not the owned-drop path) and
		// the finally must settle the tuple.
		registerTerminalTurnScope({
			lineageIdHash: registration.lineageIdHash,
			promptAttemptEpoch: registration.promptAttemptEpoch,
		});
		registerOwnedRegistration(registration, { isJobTerminal: () => true });
		expect(lookupOwnedRegistration(jobId, generation, bindEndpoint)).toBeDefined();

		await session.sendCustomMessage(
			{
				customType: "task-notification",
				content: "monitor line",
				display: false,
				attribution: "agent",
				details: {
					taskId: jobId,
					ownedCompletions: [
						{
							lineageIdHash: registration.lineageIdHash,
							promptAttemptEpoch: registration.promptAttemptEpoch,
							registration,
						},
					],
				},
			},
			{ triggerTurn: true, deliverAs: "followUp" },
		);
		await waitFor(
			() => lookupOwnedRegistration(jobId, generation, bindEndpoint) === undefined,
			"tuple settled after direct idle owned-monitor delivery",
			10_000,
		);
	}, 20_000);

	it("newSession takes the transition shutdown lease on the session-owned manager, not a foreign global", async () => {
		// Reproduction of the review-thread P1 scenario: newSession/switchSession
		// acquired their owner-subagent shutdown lease through
		// AsyncJobManager.instance(). With concurrent top-level sessions A and B
		// where B is the global instance and both roots share the `main` owner
		// id, transitioning A would lease/settle B's subagents while A's work
		// stays live. The lease must resolve through the session-owned manager.
		const foreign = new AsyncJobManager({ maxRunningJobs: 2, onJobComplete: () => {} });
		const owned = new AsyncJobManager({ maxRunningJobs: 2, onJobComplete: () => {} });
		const ownerId = "lease-owner-1";
		let leaseSession: AgentSession | undefined;
		try {
			AsyncJobManager.setInstance(foreign);
			// Hold an owner lease on the FOREIGN global manager: a pre-fix
			// newSession resolved instance() (== foreign) and refused to start
			// while this lease is held; the session-owned manager has none.
			const foreignLease = foreign.beginOwnerSubagentShutdown(ownerId);
			expect(foreignLease).toBeDefined();
			const sessMgr = SessionManager.inMemory(tempDir);
			// Mirror sdk/session.ts: the owning session registers its manager
			// under its endpoint.
			AsyncJobManager.registerForEndpoint(sessMgr.getSessionId(), owned);

			const mock = createMockModel({ handler: () => stopReply("done") });
			const agent = new Agent({
				getApiKey: () => "test-key",
				initialState: {
					model: getBundledModel("anthropic", "claude-sonnet-4-5")!,
					systemPrompt: ["Test"],
					tools: [bashToolRef as unknown as AgentTool],
					messages: [],
				},
				convertToLlm,
				streamFn: mock.stream,
			});
			leaseSession = new AgentSession({
				agent,
				sessionManager: sessMgr,
				settings: settingsRef,
				modelRegistry: modelRegistryRef,
				toolRegistry: new Map([[bashToolRef.name, bashToolRef as unknown as AgentTool]]),
				agentId: ownerId,
				ownedAsyncJobManager: owned,
			});
			leaseSession.setSdkPermissionMode("allow");
			const ok = await leaseSession.newSession();
			expect(ok).toBe(true);
			// The commit rotated the endpoint identity and the owned manager
			// followed it (rekey ran, predecessor mapping moved to successor).
			expect(AsyncJobManager.endpointIdOf(owned)).toBe(sessMgr.getSessionId());
			expect(AsyncJobManager.forEndpoint(sessMgr.getSessionId())).toBe(owned);
			// The foreign global's lease is untouched and its mapping intact.
			expect(foreignLease).toBeDefined();
		} finally {
			AsyncJobManager.setInstance(manager);
			AsyncJobManager.unregisterManager(foreign);
			AsyncJobManager.unregisterManager(owned);
			await leaseSession?.dispose();
		}
	}, 20_000);

	it("subagent tool routes list through the session endpoint's manager, not the global instance", async () => {
		// Reproduction of the review-thread P1 scenario: SubagentTool.execute()
		// selected only AsyncJobManager.instance(), so a non-global session A's
		// records/jobs live in A's manager but list/pause/resume/message/cancel
		// inspected B's — the record is absent there or belongs to another
		// same-id subagent.
		const globalMgr = new AsyncJobManager({ maxRunningJobs: 2, onJobComplete: () => {} });
		const epMgr = new AsyncJobManager({ maxRunningJobs: 2, onJobComplete: () => {} });
		const epId = "ep-subagent-route";
		try {
			AsyncJobManager.setInstance(globalMgr);
			AsyncJobManager.registerForEndpoint(epId, epMgr);
			globalMgr.registerSubagentRecord({
				subagentId: "sub-global-1",
				ownerId: "own-global",
				currentJobId: null,
				historicalJobIds: [],
				status: "running",
				sessionFile: "/tmp/sub-global-1.jsonl",
				resumable: false,
			});
			epMgr.registerSubagentRecord({
				subagentId: "sub-endpoint-1",
				ownerId: "own-ep",
				currentJobId: null,
				historicalJobIds: [],
				status: "running",
				sessionFile: "/tmp/sub-endpoint-1.jsonl",
				resumable: false,
			});

			const ts: ToolSession = {
				cwd: tempDir,
				hasUI: false,
				settings: settingsRef,
				getSessionFile: () => null,
				getSessionId: () => epId,
				getSessionSpawns: () => "*",
			};
			const tool = new SubagentTool(ts);
			const result = await tool.execute("call-subagent-list", { action: "list", limit: 50 });
			const ids = (result.details?.subagents ?? []).map(snapshot => snapshot.id);
			expect(ids).toContain("sub-endpoint-1");
			expect(ids).not.toContain("sub-global-1");
		} finally {
			AsyncJobManager.setInstance(manager);
			AsyncJobManager.unregisterManager(globalMgr);
			AsyncJobManager.unregisterManager(epMgr);
		}
	}, 20_000);

	it("clearContext suppresses the session-owned manager's pending deliveries, never the foreign global's", async () => {
		// Reproduction of the review-thread P2 scenario: clearContext resolved
		// #suppressOwnAsyncJobDeliveries through AsyncJobManager.instance().
		// With concurrent top-level sessions A and B where B is the global
		// instance, A's context clear cancelled A's jobs but suppressed B's
		// deliveries — an already-completed delivery pending in A's manager
		// could be injected after A's context was cleared, while a same-owner
		// delivery in B was discarded.
		const foreign = new AsyncJobManager({ maxRunningJobs: 4, onJobComplete: () => new Promise<void>(() => {}) });
		const owned = new AsyncJobManager({ maxRunningJobs: 4, onJobComplete: () => new Promise<void>(() => {}) });
		const ownerId = "xlumo-owner";
		let clearSession: AgentSession | undefined;
		try {
			AsyncJobManager.setInstance(foreign);
			const sessMgr = SessionManager.inMemory(tempDir);
			AsyncJobManager.registerForEndpoint(sessMgr.getSessionId(), owned);
			// Completed-but-undelivered jobs (the delivery callback never
			// resolves) leave pending deliveries in each manager.
			owned.register("bash", "owned pending", async () => "done", {
				id: "xlumo-owned",
				ownerId,
			});
			foreign.register("bash", "foreign pending", async () => "done", {
				id: "xlumo-foreign",
				ownerId,
			});
			await owned.waitForAll();
			await foreign.waitForAll();
			expect(owned.getDeliveryState({ ownerId }).pendingJobIds).toContain("xlumo-owned");
			expect(foreign.getDeliveryState({ ownerId }).pendingJobIds).toContain("xlumo-foreign");

			const mock = createMockModel({ handler: () => stopReply("done") });
			const agent = new Agent({
				getApiKey: () => "test-key",
				initialState: {
					model: getBundledModel("anthropic", "claude-sonnet-4-5")!,
					systemPrompt: ["Test"],
					tools: [bashToolRef as unknown as AgentTool],
					messages: [],
				},
				convertToLlm,
				streamFn: mock.stream,
			});
			clearSession = new AgentSession({
				agent,
				sessionManager: sessMgr,
				settings: settingsRef,
				modelRegistry: modelRegistryRef,
				toolRegistry: new Map([[bashToolRef.name, bashToolRef as unknown as AgentTool]]),
				agentId: ownerId,
				ownedAsyncJobManager: owned,
			});
			clearSession.setSdkPermissionMode("allow");
			expect(await clearSession.clearContext()).toBe(true);
			// THIS session's pending delivery was acknowledged; the foreign
			// global's same-owner delivery is untouched.
			expect(owned.getDeliveryState({ ownerId }).pendingJobIds).not.toContain("xlumo-owned");
			expect(foreign.getDeliveryState({ ownerId }).pendingJobIds).toContain("xlumo-foreign");
		} finally {
			AsyncJobManager.setInstance(manager);
			AsyncJobManager.unregisterManager(foreign);
			AsyncJobManager.unregisterManager(owned);
			await clearSession?.dispose();
		}
	}, 20_000);

	it("does not requeue owned completions already classified as dropped after a failed prompt", async () => {
		// Reproduction of the review-thread P2 scenario: a deferred batch
		// containing a scope:"owned"-denied completion whose prompt fails
		// restored ALL queuedMessages, including the dropped entry settled at
		// the drain boundary. Once the scope and its now-unoccupied policy
		// tombstone are evicted by the bounded registries, the restored
		// external monitor message classifies as ordinary and can reach a
		// later prompt despite the owned abort's zero-delivery guarantee.
		resetTerminalAbortRegistriesForTests();
		const dropLineage = "xlumr-drop-lineage";
		const dropEpoch = 5;
		// An OWNED abort landed with a disabled policy: this envelope is DROP.
		registerTerminalTurnScope({
			lineageIdHash: dropLineage,
			promptAttemptEpoch: dropEpoch,
			ownedCompletionPolicy: "disabled",
		});
		const freshLineage = "xlumr-fresh-lineage";
		const freshEpoch = 6;
		registerTerminalTurnScope({
			lineageIdHash: freshLineage,
			promptAttemptEpoch: freshEpoch,
			ownedCompletionPolicy: "enabled",
		});
		const dropRegistration: TurnRegistrationKey = {
			endpointId: "ep-xlumr",
			endpointGeneration: 0,
			lineageIdHash: dropLineage,
			promptAttemptEpoch: dropEpoch,
			jobId: "xlumr-drop-job",
			jobGeneration: "job:1",
		};
		const freshRegistration: TurnRegistrationKey = {
			endpointId: "ep-xlumr",
			endpointGeneration: 0,
			lineageIdHash: freshLineage,
			promptAttemptEpoch: freshEpoch,
			jobId: "xlumr-fresh-job",
			jobGeneration: "job:2",
		};
		registerOwnedRegistration(dropRegistration, { isJobTerminal: () => true });
		registerOwnedRegistration(freshRegistration, { isJobTerminal: () => true });

		const owned = new AsyncJobManager({ maxRunningJobs: 4, onJobComplete: () => {} });
		let dropSession: AgentSession | undefined;
		try {
			AsyncJobManager.registerForEndpoint("ep-xlumr", owned);
			// A FAILING prompt: the drain boundary runs the deferred batch and
			// the prompt rejects, exercising the catch that requeues only the
			// surviving reclassified entries.
			const failingMock = createMockModel({
				handler: () => {
					throw new Error("prompt failed");
				},
			});
			const agent = new Agent({
				getApiKey: () => "test-key",
				initialState: {
					model: getBundledModel("anthropic", "claude-sonnet-4-5")!,
					systemPrompt: ["Test"],
					tools: [bashToolRef as unknown as AgentTool],
					messages: [],
				},
				convertToLlm,
				streamFn: failingMock.stream,
			});
			dropSession = new AgentSession({
				agent,
				sessionManager: SessionManager.inMemory(tempDir),
				settings: settingsRef,
				modelRegistry: modelRegistryRef,
				toolRegistry: new Map([[bashToolRef.name, bashToolRef as unknown as AgentTool]]),
				agentId: "xlumr-owner",
				ownedAsyncJobManager: owned,
			});
			dropSession.setSdkPermissionMode("allow");

			const droppedMsg = {
				role: "custom" as const,
				customType: "task-notification",
				content: "dropped monitor line",
				display: false,
				timestamp: 1,
				details: {
					taskId: "xlumr-drop-job",
					ownedCompletions: [
						{
							lineageIdHash: dropLineage,
							promptAttemptEpoch: dropEpoch,
							registration: dropRegistration,
						},
					],
				},
			};
			const freshMsg = {
				role: "custom" as const,
				customType: "task-notification",
				content: "fresh monitor line",
				display: false,
				timestamp: 2,
				details: {
					taskId: "xlumr-fresh-job",
					ownedCompletions: [
						{
							lineageIdHash: freshLineage,
							promptAttemptEpoch: freshEpoch,
							registration: freshRegistration,
						},
					],
				},
			};
			const ds = dropSession;
			ds.queueDeferredMessageForTests(droppedMsg, true);
			ds.queueDeferredMessageForTests(freshMsg, false);

			await waitFor(
				() => ds.getPendingNextTurnMessagesForTests().length > 0,
				"failed prompt requeues the surviving entries",
				15_000,
			);
			const requeued = ds.getPendingNextTurnMessagesForTests();
			const contents = requeued.map(message => (message as { content?: unknown }).content);
			expect(contents).not.toContain("dropped monitor line");
			expect(contents).toContain("fresh monitor line");
		} finally {
			AsyncJobManager.unregisterManager(owned);
			await dropSession?.dispose();
		}
	}, 20_000);
});
