import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Agent, type AgentTool } from "@gajae-code/agent-core";
import { getBundledModel } from "@gajae-code/ai";
import { createMockModel, type MockModel, type MockResponse } from "@gajae-code/ai/providers/mock";
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

const TEST_ABORT_GRACE_MS = 50;

/** Scripted assistant turn that issues a single `bash` tool call. */
function bashCall(command: string, callId: string, background = false): MockResponse {
	return {
		content: [
			{
				type: "toolCall",
				id: callId,
				name: "bash",
				arguments: { command, timeout: 10, ...(background ? { async: true } : {}) },
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
	let manualTeardown = false;
	let chainSessionManager: SessionManager;
	let tempDir: string;
	let authStorage: AuthStorage | undefined;
	let scriptedResponses: MockResponse[];
	let mockModelRef: MockModel | undefined;
	/** Every provider request's serialized context, for negative delivery proofs. */
	const recordedProviderContexts = (): string[] =>
		(mockModelRef?.calls ?? []).map(call => JSON.stringify(call.context.messages));
	let manager: AsyncJobManager;
	let bashToolRef: BashTool;
	let toolSession: ToolSession;
	let settingsRef: Settings;
	let modelRegistryRef: ModelRegistry;

	beforeEach(async () => {
		manualTeardown = false;
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
		mockModelRef = mock;

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
			ownedAsyncJobManager: manager,
			disposeAsyncJobManager: true,
		});
		session.setSdkPermissionMode("allow");
	});

	afterEach(async () => {
		if (manualTeardown) {
			session.agent.abort();
			await manager.dispose({ timeoutMs: 1_000 });
			await chainSessionManager.close();
		} else {
			await session.dispose();
		}
		AsyncJobManager.setInstance(undefined);
		AsyncJobManager.unregisterManager(manager);
		authStorage?.close();
		authStorage = undefined;
		if (fs.existsSync(tempDir)) {
			fs.rmSync(tempDir, { recursive: true, force: true });
		}
	}, 30_000);

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
			graceMs: TEST_ABORT_GRACE_MS,
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
		await Bun.write(blockedArtifactsDir, "file blocks local root initialization");
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
			graceMs: TEST_ABORT_GRACE_MS,
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
			graceMs: TEST_ABORT_GRACE_MS,
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
			graceMs: TEST_ABORT_GRACE_MS,
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
			graceMs: TEST_ABORT_GRACE_MS,
			terminal: { scope: "turn" },
		});
		expect(session.getPendingNextTurnMessagesForTests()).toHaveLength(0);
	}, 20_000);

	it("terminal abort + new prompt discards hidden next-turn successors before injection", async () => {
		scriptedResponses = [stopReply("ok")];
		await session.prompt("first turn");
		// Queue WITHOUT scheduling a drain: the first turn has already ended, so
		// a scheduled drain would fire before the abort lands (the session is
		// idle) and consume the successor as a new turn instead of exercising
		// the admission-time discard this test targets. The message stays queued
		// until the next explicit prompt (review thread P2).
		session.queueDeferredMessageForTests(
			{
				role: "custom",
				customType: "test-hidden-next-turn",
				content: [{ type: "text", text: "hidden successor" }],
				display: true,
				details: {},
				timestamp: Date.now(),
			},
			false,
		);
		// Terminal abort closes the first turn's fence.
		await session.abortPromptAndWait(session.agent.activeResourceRunId ?? "run", {
			graceMs: TEST_ABORT_GRACE_MS,
			terminal: { scope: "turn" },
		});
		// A NEW prompt advances the generation: the explicit-prompt admission
		// must discard the aborted turn's hidden successors before injection
		// instead of adding them to this new turn (review thread P2).
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
			graceMs: TEST_ABORT_GRACE_MS,
			terminal: { scope: "turn" },
		});
		// The queued steering is purged so it cannot alter the next user turn;
		// the follow-up queue is untouched (owned-completion resumes still deliver).
		expect(session.agent.hasQueuedSteering()).toBe(false);
		expect(session.agent.snapshotQueues().followUp).toHaveLength(0);
	}, 20_000);
	it("terminal abort preserves client steering admitted after the abort snapshot", async () => {
		// Review thread P1: a client turn.prompt/steer accepted while the abort
		// is in flight (past its snapshot) is an independent root-turn request
		// whose acceptance was already acknowledged, so the abort must preserve
		// it instead of purging every steering message — clearing it would
		// leave its reconciliation record accepted indefinitely.
		scriptedResponses = [bashCall("sleep 2", "call_hold_turn"), stopReply("steer answered")];
		const promptPromise = session.prompt("hold the turn").catch(() => {});
		await waitFor(() => session.agent.activeResourceRunId !== undefined, "active run handle");
		const abortPromise = session.abortPromptAndWait(session.agent.activeResourceRunId ?? "run", {
			graceMs: TEST_ABORT_GRACE_MS,
			terminal: { scope: "turn" },
		});
		// Queue the client steer AFTER the abort began (past its snapshot): it
		// survives the purge.
		await session.sendUserMessage("client steer", { deliverAs: "steer" });
		await abortPromise;
		// The post-abort rearm schedules the preserved steer: it is consumed by
		// a fresh run instead of staying stranded until unrelated activity
		// (review thread P1). (The pre-snapshot counterpart is blocked — see
		// the "blocks client steering admitted before" test.)
		await waitFor(() => !session.agent.hasQueuedSteering(), "preserved steer consumed");
		await promptPromise;
	}, 30_000);

	it("terminal abort preserves client steering admitted after the abort admission snapshot", async () => {
		// Review thread P1: the host captures the steering snapshot at abort
		// ADMISSION (before its durable marker transaction) — a steer admitted
		// while the abort is in flight classifies as post-snapshot even though
		// the later abortPromptAndWait purge has not run yet.
		scriptedResponses = [bashCall("sleep 2", "call_hold_turn"), stopReply("steer answered")];
		const promptPromise = session.prompt("hold the turn").catch(() => {});
		await waitFor(() => session.agent.activeResourceRunId !== undefined, "active run handle");
		session.captureTerminalAbortSteeringSnapshot();
		await session.sendUserMessage("admission-window steer", { deliverAs: "steer" });
		await session.abortPromptAndWait(session.agent.activeResourceRunId ?? "run", {
			graceMs: TEST_ABORT_GRACE_MS,
			terminal: { scope: "turn" },
		});
		// The steer admitted after the admission snapshot is preserved and
		// rearmed into a fresh run.
		await waitFor(() => !session.agent.hasQueuedSteering(), "admission-window steer consumed");
		await promptPromise;
	}, 30_000);

	it("terminal abort blocks client steering admitted before the abort snapshot", async () => {
		// Review thread P1: an SDK steer admitted into the live turn BEFORE the
		// terminal abort begins is an accepted-pre-close continuation of the
		// aborted attempt, which the terminal-abort contract requires to be
		// blocked — the abort exits the loop and only rearms post-snapshot
		// steers, so a stale steer would otherwise alter the next prompt.
		scriptedResponses = [bashCall("sleep 2", "call_hold_turn"), stopReply("unused")];
		const promptPromise = session.prompt("hold the turn").catch(() => {});
		await waitFor(() => session.agent.activeResourceRunId !== undefined, "active run handle");
		await session.sendUserMessage("pre-abort steer", { deliverAs: "steer" });
		expect(session.agent.hasQueuedSteering()).toBe(true);
		await session.abortPromptAndWait(session.agent.activeResourceRunId ?? "run", {
			graceMs: TEST_ABORT_GRACE_MS,
			terminal: { scope: "turn" },
		});
		expect(session.agent.hasQueuedSteering()).toBe(false);
		expect(session.getQueuedMessages().steering).toEqual([]);
		await promptPromise;
	}, 20_000);

	it("refuses a steer at admission when no turn is live instead of parking it for the next abort", async () => {
		// Enqueue-time admission: with the turn already finished there is no run
		// to steer, so the session routes the request as a follow-up owned by
		// the next turn — never as steering the terminal-abort purge has to
		// reason about.
		scriptedResponses = [stopReply("ok"), stopReply("delivered")];
		await session.prompt("first turn");
		await session.sendUserMessage("post-turn steer", { deliverAs: "steer" });
		expect(session.agent.hasQueuedSteering()).toBe(false);
		await waitFor(() => !session.agent.hasQueuedMessages(), "post-turn steer delivered as its own turn");
		await session.waitForIdle();
		expect(session.agent.state.messages.filter(m => m.role === "assistant")).toHaveLength(2);
	}, 20_000);

	it("terminal abort keeps each abort's steering snapshot scoped to its own admission", async () => {
		// Review thread P1: overlapping aborts of the same turn must each purge
		// with their OWN admission's snapshot — a later admission capturing a
		// higher sequence must not overwrite the earlier admission's snapshot
		// and purge an already-accepted steer.
		scriptedResponses = [bashCall("sleep 2", "call_hold_turn"), stopReply("steer answered")];
		const promptPromise = session.prompt("hold the turn").catch(() => {});
		await waitFor(() => session.agent.activeResourceRunId !== undefined, "active run handle");
		const handle = session.agent.activeResourceRunId;
		// Settle the hold turn's abort first: the loop's teardown is done, so a
		// steer queued afterwards stays in the queue (the terminal fence blocks
		// any idle auto-continue from draining it).
		await session.abortPromptAndWait(handle ?? "run", { graceMs: TEST_ABORT_GRACE_MS, terminal: { scope: "turn" } });
		// Abort A admitted: captures the snapshot (sequence 0).
		const tokenA = session.captureTerminalAbortSteeringSnapshot();
		expect(tokenA).toBeDefined();
		// A client steer is accepted at sequence 1 while A awaits its durable
		// transaction.
		await session.sendUserMessage("accepted steer", { deliverAs: "steer" });
		// Abort B admitted (same turn, distinct admission): captures sequence 1.
		const tokenB = session.captureTerminalAbortSteeringSnapshot();
		expect(tokenB).toBeDefined();
		// B settles FIRST: token-addressed consumption must use B's snapshot (1),
		// not shift A's older FIFO entry. The pre-B steer is blocked.
		await session.abortPromptAndWait(handle ?? "run", {
			graceMs: TEST_ABORT_GRACE_MS,
			terminal: { scope: "turn", steeringSnapshotToken: tokenB },
		});
		expect(session.agent.hasQueuedSteering()).toBe(false);
		// A settles later with its own token. It must not consume another
		// admission's slot or resurrect/preserve stale steering.
		await session.abortPromptAndWait(handle ?? "run", {
			graceMs: TEST_ABORT_GRACE_MS,
			terminal: { scope: "turn", steeringSnapshotToken: tokenA },
		});
		expect(session.agent.hasQueuedSteering()).toBe(false);
		await promptPromise;
	}, 30_000);
	it("narrows overlapping terminal dispositions monotonically at the run's single terminal", async () => {
		// The two abort admissions of ONE live run compose into a single disposition
		// consumed at that run's terminal. Settling the OLDER (looser) admission
		// last must not widen the newer one: only steering admitted after the
		// highest snapshot survives.
		scriptedResponses = [bashCall("sleep 2", "call_hold_turn"), stopReply("late steer answered")];
		const promptPromise = session.prompt("hold the turn").catch(() => {});
		await waitFor(() => session.agent.activeResourceRunId !== undefined, "active run handle");
		const handle = session.agent.activeResourceRunId ?? "run";
		// Abort A admitted first (looser: everything after its snapshot survives).
		const tokenA = session.captureTerminalAbortSteeringSnapshot();
		expect(tokenA).toBeDefined();
		await session.sendUserMessage("between-A-and-B", { deliverAs: "steer" });
		// Abort B admitted second (stricter: only steering after B survives).
		const tokenB = session.captureTerminalAbortSteeringSnapshot();
		expect(tokenB).toBeDefined();
		await session.sendUserMessage("after-B", { deliverAs: "steer" });
		expect(session.getQueuedMessages().steering).toEqual(["between-A-and-B", "after-B"]);

		let followUpAtTerminal: readonly string[] | undefined;
		const unsubscribe = session.subscribe(event => {
			if (event.type === "agent_end" && followUpAtTerminal === undefined)
				followUpAtTerminal = session.getQueuedMessages().followUp;
		});
		// B registers its (stricter) disposition, then A registers its looser one;
		// the run is still live, so both compose before the terminal settles it.
		await Promise.all([
			session.abortPromptAndWait(handle, {
				graceMs: TEST_ABORT_GRACE_MS,
				terminal: { scope: "turn", steeringSnapshotToken: tokenB },
			}),
			session.abortPromptAndWait(handle, {
				graceMs: TEST_ABORT_GRACE_MS,
				terminal: { scope: "turn", steeringSnapshotToken: tokenA },
			}),
		]);
		unsubscribe();
		// Only the post-B steer survived: A's looser predicate could not widen B's.
		expect(followUpAtTerminal).toEqual(["after-B"]);
		expect(session.agent.snapshotSteering()).toEqual([]);
		await promptPromise;
	}, 30_000);

	it("classifies a post-terminal custom steer by provenance, not by its triggerTurn flag", async () => {
		// A terminally aborted turn keeps its continuation fence. A custom steer
		// arriving afterwards must be classified by WHERE IT CAME FROM: genuine
		// user input survives as its own root request, while a continuation the
		// aborted turn's own machinery produced is dropped with its display chip.
		scriptedResponses = [bashCall("sleep 2", "call_hold_turn"), stopReply("user steer answered")];
		const promptPromise = session.prompt("hold the turn").catch(() => {});
		await waitFor(() => session.agent.activeResourceRunId !== undefined, "active run handle");
		const handle = session.agent.activeResourceRunId ?? "run";
		await session.abortPromptAndWait(handle, { graceMs: TEST_ABORT_GRACE_MS, terminal: { scope: "turn" } });
		await promptPromise;

		// Turn-owned reminder: agent-attributed, no external origin, carries a
		// display chip. Dropped, and its chip must not linger in the queue pane.
		const tag = session.enqueueCustomMessageDisplay("stale preview reminder", "steer");
		await session.sendCustomMessage(
			{
				customType: "resolve-reminder",
				content: "stale preview reminder",
				display: false,
				attribution: "agent",
				details: { __pendingDisplayTag: tag },
			},
			{ deliverAs: "steer" },
		);
		expect(session.agent.hasQueuedMessages()).toBe(false);
		expect(session.getQueuedMessages()).toEqual({ steering: [], followUp: [] });

		// A `triggerTurn: true` flag on the SAME turn-owned message must not buy
		// it a fresh root turn: not queued, never persisted, never sent.
		await session.sendCustomMessage(
			{ customType: "resolve-reminder", content: "stale but eager", display: false, attribution: "agent" },
			{ deliverAs: "steer", triggerTurn: true },
		);
		expect(session.agent.hasQueuedMessages()).toBe(false);
		const eagerInHistory = () =>
			session.agent.state.messages.some(message => JSON.stringify(message).includes("stale but eager"));
		expect(eagerInHistory()).toBe(false);

		// An agent-attributed message from an INDEPENDENT external producer (the
		// trusted-adapter origin bit) is also a root request of its own.
		await session.sendCustomMessage(
			{ customType: "ext-notice", content: "external producer notice", display: false, attribution: "agent" },
			{ deliverAs: "steer", origin: "external" },
		);
		await waitFor(() => !session.agent.hasQueuedMessages(), "external-origin custom steer delivered");
		await session.waitForIdle();
		expect(
			session.agent.state.messages.some(
				message => message.role === "custom" && String(message.content).includes("external producer notice"),
			),
		).toBe(true);

		// Genuine user input survives the fence and is delivered as a fresh root.
		await session.sendCustomMessage(
			{ customType: "user-skill", content: "user says do this instead", display: false, attribution: "user" },
			{ deliverAs: "steer" },
		);
		await waitFor(() => !session.agent.hasQueuedMessages(), "user custom steer delivered");
		await session.waitForIdle();
		expect(
			session.agent.state.messages.some(
				message => message.role === "custom" && String(message.content).includes("user says do this instead"),
			),
		).toBe(true);
		expect(
			session.agent.state.messages.some(
				message => message.role === "custom" && String(message.content).includes("stale preview reminder"),
			),
		).toBe(false);
		// Neither dropped message survived into history or a provider request.
		expect(eagerInHistory()).toBe(false);
		expect(recordedProviderContexts().some(text => text.includes("stale but eager"))).toBe(false);
		expect(recordedProviderContexts().some(text => text.includes("stale preview reminder"))).toBe(false);
	}, 30_000);

	it("keeps the fresh-root requirement when a busy owner defers the post-terminal delivery", async () => {
		// An independent root request queued after a terminal abort may be deferred
		// by a busy owner (bash/eval/retry/compaction). The fresh-root requirement
		// must survive that deferral: whichever attempt eventually delivers has to
		// mint the new identity, or the retained fence rejects it forever.
		scriptedResponses = [bashCall("sleep 2", "call_hold_turn"), stopReply("external notice answered")];
		const promptPromise = session.prompt("hold the turn").catch(() => {});
		await waitFor(() => session.agent.activeResourceRunId !== undefined, "active run handle");
		const handle = session.agent.activeResourceRunId ?? "run";
		await session.abortPromptAndWait(handle, { graceMs: TEST_ABORT_GRACE_MS, terminal: { scope: "turn" } });
		await promptPromise;

		// Pretend a busy owner holds the session when the message is queued, so the
		// enqueue-time schedule is refused and only a later attempt can deliver.
		let busy = true;
		Object.defineProperty(session, "isCompacting", { configurable: true, get: () => busy });
		try {
			await session.sendCustomMessage(
				{ customType: "ext-notice", content: "deferred external notice", display: false, attribution: "agent" },
				{ deliverAs: "steer", origin: "external" },
			);
			expect(session.agent.hasQueuedMessages()).toBe(true);
			busy = false;
		} finally {
			delete (session as unknown as Record<string, unknown>).isCompacting;
		}
		// A later independent send schedules delivery; the deferred message's
		// fresh-root requirement is still pending, so BOTH are delivered instead of
		// the first one being stranded behind the retained fence.
		await session.sendCustomMessage(
			{ customType: "ext-notice", content: "second external notice", display: false, attribution: "agent" },
			{ deliverAs: "steer", origin: "external" },
		);
		await waitFor(() => !session.agent.hasQueuedMessages(), "deferred external notices delivered");
		await session.waitForIdle();
		const delivered = session.agent.state.messages
			.filter(message => message.role === "custom")
			.map(message => String(message.content));
		expect(delivered.some(text => text.includes("deferred external notice"))).toBe(true);
		expect(delivered.some(text => text.includes("second external notice"))).toBe(true);
	}, 30_000);

	it("terminal abort keeps the queue display aligned with the disown decisions", async () => {
		// Review thread P2: the display list must mirror what the run's disowned
		// steering became — a purged internal steer disappears everywhere, and a
		// preserved post-snapshot external steer is re-routed (queue AND display)
		// as a follow-up of the fresh turn, so the positional editing APIs never
		// address a stale entry.
		scriptedResponses = [bashCall("sleep 2", "call_hold_turn"), stopReply("steer answered")];
		const promptPromise = session.prompt("hold the turn").catch(() => {});
		await waitFor(() => session.agent.activeResourceRunId !== undefined, "active run handle");
		const handle = session.agent.activeResourceRunId;
		// An internal steer admitted into the live turn before the abort wins:
		// dropped with the aborted turn's other continuations.
		await session.steer("stale internal steer");
		// A client steer admitted after the abort admission snapshot: preserved.
		session.captureTerminalAbortSteeringSnapshot();
		await session.sendUserMessage("client steer", { deliverAs: "steer" });
		expect(session.getQueuedMessages().steering).toEqual(["stale internal steer", "client steer"]);
		let observed: { steering: readonly string[]; followUp: readonly string[] } | undefined;
		const unsubscribe = session.subscribe(event => {
			if (event.type === "agent_end" && observed === undefined) observed = session.getQueuedMessages();
		});
		await session.abortPromptAndWait(handle ?? "run", { graceMs: TEST_ABORT_GRACE_MS, terminal: { scope: "turn" } });
		unsubscribe();
		// At the aborted run's terminal: internal steer gone, client steer
		// re-routed as the next turn's follow-up in both queue and display.
		expect(observed).toEqual({ steering: [], followUp: ["client steer"] });
		expect(session.agent.snapshotSteering()).toHaveLength(0);
		// The rearm then consumes it as a fresh turn.
		await waitFor(() => !session.agent.hasQueuedMessages(), "client steer consumed");
		expect(session.getQueuedMessages()).toEqual({ steering: [], followUp: [] });
		await promptPromise;
	}, 30_000);

	it("terminal abort rearms an external-only follow-up past the terminal fence as a fresh turn", async () => {
		// Reproduction of the review-thread P1 scenario: when a terminal abort
		// leaves ONLY an independently requested external follow-up queued (no
		// owned-completion envelope), the rearm must still allocate a fresh
		// lineage — otherwise the scheduled continue runs under the aborted
		// lineage+epoch, the terminal fence skips it as terminal_turn, and the
		// preserved user follow-up stays stranded until unrelated activity.
		scriptedResponses = [bashCall("sleep 2", "call_hold_turn"), stopReply("follow-up answered")];
		const promptPromise = session.prompt("hold the turn").catch(() => {});
		await waitFor(() => session.agent.activeResourceRunId !== undefined, "active run handle");
		// Queue the external follow-up while the turn is active (the idle
		// auto-continue is suppressed while streaming, so it stays queued).
		await session.followUp("external follow-up");
		expect(session.agent.hasQueuedMessages()).toBe(true);
		const handle = session.agent.activeResourceRunId;
		const proof = await session.abortPromptAndWait(handle ?? "run", {
			graceMs: TEST_ABORT_GRACE_MS,
			terminal: { scope: "turn" },
		});
		expect(proof).toBeDefined();
		// The rearmed continue consumes the external follow-up under a fresh
		// lineage (the mock model answers it); without the fresh lineage the
		// fence skips the continue and the queue never drains.
		await waitFor(() => !session.agent.hasQueuedMessages(), "external follow-up consumed");
		await promptPromise;
	}, 30_000);
	it("terminal abort rebinds the snapshot to the requester's turn that won the race", async () => {
		// Review thread P1: when an abort is admitted while another connection
		// owns the active turn and the aborting requester's own prompt then
		// becomes active, the settlement must purge with the ORIGINAL admission
		// sequence — the session rebinds the captured token to the current turn
		// instead of rejecting it as stale.
		scriptedResponses = [bashCall("sleep 30", "call_hold_turn"), stopReply("ok")];
		const promptPromise = session.prompt("hold the turn").catch(() => {});
		await waitFor(() => session.agent.activeResourceRunId !== undefined, "active run handle");
		const handle = session.agent.activeResourceRunId;
		// Admission capture: recorded under the CURRENT turn key.
		const token = session.captureTerminalAbortSteeringSnapshot();
		expect(token).toBeDefined();
		// A client steer admitted after the snapshot.
		await session.sendUserMessage("requester steer", { deliverAs: "steer" });
		// The requester's turn won the race: rebind the token to the current
		// turn (same key here — a no-op the harness turns into a same-key
		// validation) and settle: the purge must preserve the post-snapshot
		// steer using the ORIGINAL admission sequence.
		session.rebindTerminalAbortSteeringSnapshot(token ?? 0);
		const proof = await session.abortPromptAndWait(handle ?? "run", {
			graceMs: 2_000,
			terminal: { scope: "turn", steeringSnapshotToken: token },
		});
		expect(proof.status).not.toBe("unfenced");
		// The steer survives the purge (post-snapshot against the original
		// admission sequence) and the rearm consumes it.
		await waitFor(() => !session.agent.hasQueuedSteering(), "requester steer consumed");
		await promptPromise;
	}, 30_000);

	it("terminal abort discards snapshots captured by replay-only admissions", async () => {
		// Review thread P1: a durable same-key replay reaches the admission but
		// never settles — its captured snapshot must be discarded, or a later
		// real abort would consume the stale entry and treat steering admitted
		// since the replay as post-abort.
		scriptedResponses = [bashCall("sleep 2", "call_hold_turn"), stopReply("steer answered")];
		const promptPromise = session.prompt("hold the turn").catch(() => {});
		await waitFor(() => session.agent.activeResourceRunId !== undefined, "active run handle");
		await session.abortPromptAndWait(session.agent.activeResourceRunId ?? "run", {
			graceMs: TEST_ABORT_GRACE_MS,
			terminal: { scope: "turn" },
		});
		// A replay-only admission captures a snapshot for the (still fenced)
		// turn and then discards it — the durable replay path never settles.
		const token = session.captureTerminalAbortSteeringSnapshot();
		expect(token).toBeDefined();
		session.discardTerminalAbortSteeringSnapshot(token ?? 0);
		// A client steer admitted AFTER the discarded snapshot: the next real
		// abort must classify it as PRE-snapshot (blocked) — the stale entry
		// would have made it post-snapshot (survive) and leak into the next turn.
		await session.sendUserMessage("steer after replay", { deliverAs: "steer" });
		await session.abortPromptAndWait(session.agent.activeResourceRunId ?? "run", {
			graceMs: TEST_ABORT_GRACE_MS,
			terminal: { scope: "turn" },
		});
		expect(session.agent.hasQueuedSteering()).toBe(false);
		await promptPromise;
	}, 30_000);

	it("terminal abort preserves authorized owned completions queued as hidden next-turn messages", async () => {
		// Review thread P1: when ACP defers agent-initiated turns and a
		// left-running owned job completes after a scope:"turn" abort while the
		// session is idle, sendCustomMessage() queues the authorized completion
		// envelope in #pendingNextTurnMessages with the default origin:"turn".
		// The hidden-next-turn fence purge must not delete it solely by origin —
		// it is a promised resume of the root worker (classified fresh), and
		// dropping it also bypasses the registration-settlement path.
		scriptedResponses = [bashCall("sleep 2", "call_hold_turn")];
		const promptPromise = session.prompt("hold the turn").catch(() => {});
		await waitFor(() => session.agent.activeResourceRunId !== undefined, "active run handle");
		// Terminal abort closes the current turn's continuation fence.
		await session.abortPromptAndWait(session.agent.activeResourceRunId ?? "run", {
			graceMs: TEST_ABORT_GRACE_MS,
			terminal: { scope: "turn" },
		});
		// A left-running owned job completes: its envelope references the
		// authorized scope it is bound to (turn scope enabled, registered
		// tuple), so it must classify FRESH.
		const bindEndpoint = chainSessionManager.getSessionId?.() ?? "local";
		const jobId = "bg-hidden-next";
		const generation = "job:1";
		const registration: TurnRegistrationKey = {
			endpointId: bindEndpoint,
			endpointGeneration: 0,
			lineageIdHash: "hidden-next-lineage",
			promptAttemptEpoch: 77,
			jobId,
			jobGeneration: generation,
		};
		registerTerminalTurnScope({
			lineageIdHash: registration.lineageIdHash,
			promptAttemptEpoch: registration.promptAttemptEpoch,
		});
		registerOwnedRegistration(registration, { isJobTerminal: () => true });
		session.queueDeferredMessageForTests(
			{
				role: "custom",
				customType: "test-hidden-next-owned",
				content: [{ type: "text", text: "owned completion" }],
				display: true,
				details: {
					ownedCompletions: [
						{
							lineageIdHash: registration.lineageIdHash,
							promptAttemptEpoch: registration.promptAttemptEpoch,
							registration,
						},
					],
				},
				timestamp: Date.now(),
			},
			true,
		);
		// Let the scheduled hidden-next-turn flush observe the closed fence:
		// the authorized completion must survive its purge (it was dropped
		// pre-fix solely by origin).
		await Bun.sleep(150);
		expect(
			session
				.getPendingNextTurnMessagesForTests()
				.some(
					message =>
						((message as { content?: unknown }).content as Array<{ text?: string }>)[0]?.text ===
						"owned completion",
				),
		).toBe(true);
		// A new explicit prompt drains the preserved completion: it is
		// classified fresh, delivered (the mock answers), and its registration
		// settles instead of bypassing the settlement path.
		scriptedResponses = [stopReply("completion answered")];
		await session.prompt("new user turn");
		expect(session.getPendingNextTurnMessagesForTests()).toHaveLength(0);
		await waitFor(
			() => lookupOwnedRegistration(jobId, generation, bindEndpoint) === undefined,
			"owned completion registration settled after delivery",
		);
		await promptPromise;
	}, 30_000);

	it("removed steers never fire their ownership hook into a later rearm", async () => {
		// Review thread P1: promotion hooks must bind to the messages a run
		// actually consumes — a steer removed from the queue before the abort
		// (or during the rearm delay) must never fire its requester-ownership
		// callback for a run that did not consume it.
		const promoted: string[] = [];
		const removalDispositions: boolean[] = [];
		scriptedResponses = [bashCall("sleep 2", "hold-removal"), stopReply("accepted")];
		const promptPromise = session.prompt("hold removal window").catch(() => {});
		await waitFor(() => session.agent.activeResourceRunId !== undefined, "active removal window");
		await session.sendUserMessage("removed steer", {
			deliverAs: "steer",
			onQueuedPromoted: promotion => {
				if (promotion?.removed) removalDispositions.push(promotion.removed);
				else promoted.push("removed");
			},
		});
		await session.sendUserMessage("accepted steer", {
			deliverAs: "steer",
			onQueuedPromoted: () => promoted.push("accepted"),
		});
		const removedEntry = session.getQueuedMessageEntries().find(entry => entry.text === "removed steer");
		if (!removedEntry) throw new Error("Expected removable steer entry");
		const removed = session.removeQueuedMessageForEditing(removedEntry.id);
		expect(removed).toBe("removed steer");
		// Removal fires exactly one REMOVAL disposition (bounded terminalization);
		// it must never register as a consumption promotion.
		expect(removalDispositions).toEqual([true]);
		expect(promoted).toEqual([]);
		// The abort's rearm consumes the remaining steer; the removed steer's
		// hook must never fire (the run-acceptance path only fires hooks for
		// the messages actually consumed).
		await session.abortPromptAndWait(session.agent.activeResourceRunId ?? "run", {
			graceMs: 2_000,
			terminal: { scope: "turn" },
		});
		await waitFor(() => !session.agent.hasQueuedSteering(), "remaining steer consumed");
		expect(promoted).not.toContain("removed");
		await promptPromise;
	}, 30_000);

	it("rearm fires the preserved steer's ownership hook past a non-assistant tail", async () => {
		// Review thread P1: when the terminal abort leaves a NON-assistant
		// history tail (a tool result), the rearmed continuation must consume
		// the preserved steer inside the run acceptance (continueQueuedMessages)
		// so the run reports it as consumed and #fireQueuedPromotionHooks
		// records the submitting connection as an owner — otherwise
		// Agent.continue() replays the tail via #runLoop(undefined) with an
		// empty consumed payload, the steer is only dequeued later through
		// getSteeringMessages, the ownership hook never fires, and the
		// connection's later terminal abort is rejected as an owner mismatch.
		let promoted = 0;
		scriptedResponses = [
			stopReply("turn one"),
			// The second turn's model response never emits content: the abort
			// interrupts the delay (delayMs honors the run's AbortSignal), and
			// the fallback path (delay elapsing before the abort) throws — both
			// exit the run through the no-partial branch, so nothing is appended
			// after the manual tool result and the loop never polls the steering
			// queue again.
			{ delayMs: 1_000, throw: "abort probe", content: [] },
			stopReply("steer answered"),
		];
		await session.prompt("first turn");
		// A completed in-flight tool's result is the history tail a terminal
		// abort leaves in production when the grace window lets the tool
		// finish; the harness materializes that exact state.
		session.agent.appendMessage({
			role: "toolResult",
			toolCallId: "call_hold_turn",
			toolName: "bash",
			isError: false,
			content: [{ type: "text", text: "tool result" }],
			timestamp: Date.now(),
		});
		const promptPromise = session.prompt("second turn").catch(() => {});
		await waitFor(() => session.agent.activeResourceRunId !== undefined, "second run handle");
		const abortPromise = session.abortPromptAndWait(session.agent.activeResourceRunId ?? "run", {
			graceMs: TEST_ABORT_GRACE_MS,
			terminal: { scope: "turn" },
		});
		// The client steer is admitted right after the abort admission captured
		// its steering snapshot: it classifies as post-snapshot and is
		// preserved. It lands after the run's entry steering poll and the run
		// never polls again (the delayed model response is interrupted by the
		// abort), so the live loop cannot dequeue it.
		await session.sendUserMessage("rearm steer", {
			deliverAs: "steer",
			onQueuedPromoted: () => {
				promoted += 1;
			},
		});
		await abortPromise;
		// The interrupt appends a synthetic empty aborted assistant message; the
		// production abort with a completed in-flight tool leaves the tool result
		// as the real tail. Pop the synthetic message before the rearm
		// continuation (scheduled at +1ms) selects its dequeue strategy, so the
		// continuation sees the non-assistant tail the P1 describes.
		session.agent.popMessage();
		// The rearm must consume the steer INSIDE the run acceptance (the
		// ownership hook fires) instead of dequeueing it later via
		// getSteeringMessages.
		await waitFor(() => promoted === 1, "rearm steer ownership hook fired");
		expect(promoted).toBe(1);
		expect(session.agent.hasQueuedSteering()).toBe(false);
		await promptPromise;
	}, 30_000);

	it("fires the queued steer's SDK ownership hook exactly once when its run accepts", async () => {
		// Review thread P1: a streaming-diverted SDK turn.prompt accepted while
		// the old turn is still streaming queues a steer without scheduling its
		// own continuation, and the per-message onPromoted ownership callback
		// must survive to the run that eventually accepts the steer — the run
		// must stay associated with the requesting connection or a later
		// terminal abort from that client is rejected as non-owner.
		let promoted = 0;
		scriptedResponses = [stopReply("ok"), stopReply("steer answered")];
		await session.prompt("first turn");
		// Queue the client steer while idle: the auto-continue promotes it into
		// its OWN run, which fires the ownership hook exactly once.
		await session.sendUserMessage("client steer", {
			deliverAs: "steer",
			onQueuedPromoted: () => {
				promoted += 1;
			},
		});
		await waitFor(() => !session.agent.hasQueuedSteering(), "steer consumed by its own run");
		await waitFor(() => promoted === 1, "steer ownership hook fired");
		expect(promoted).toBe(1);
	}, 30_000);

	it("rejects a steering snapshot token captured for an earlier turn", async () => {
		scriptedResponses = [stopReply("first turn done"), bashCall("sleep 2", "call_second_turn")];
		await session.prompt("first turn");
		const staleToken = session.captureTerminalAbortSteeringSnapshot();
		expect(staleToken).toBeDefined();
		const secondPrompt = session.prompt("second turn").catch(() => {});
		await waitFor(() => session.agent.activeResourceRunId !== undefined, "second run handle");
		const handle = session.agent.activeResourceRunId ?? "run";
		await expect(
			session.abortPromptAndWait(handle, {
				graceMs: TEST_ABORT_GRACE_MS,
				terminal: { scope: "turn", steeringSnapshotToken: staleToken },
			}),
		).resolves.toMatchObject({ status: "unfenced", reason: "unknown_run" });
		// The stale token is retired and cannot affect cleanup of the live turn.
		session.discardTerminalAbortSteeringSnapshot(staleToken ?? 0);
		await session.abortPromptAndWait(handle, { graceMs: TEST_ABORT_GRACE_MS, terminal: { scope: "turn" } });
		await secondPrompt;
	}, 30_000);

	it("terminal abort preserves a queued external follow-up through the purge and rearms it", async () => {
		// Delta-review P1 regression: the steering purge must NOT
		// collateral-purge the follow-up queue. An independently requested
		// external follow-up queued when the terminal abort runs is an
		// independent next-root-turn request and must survive the abort
		// (alongside authorized owned-completion envelopes), then be rearmed
		// under a fresh lineage.
		scriptedResponses = [bashCall("sleep 2", "call_hold_turn"), stopReply("follow-up answered")];
		const promptPromise = session.prompt("hold the turn").catch(() => {});
		await waitFor(() => session.agent.activeResourceRunId !== undefined, "active run handle");
		await session.followUp("external follow-up");
		expect(session.agent.snapshotQueues().followUp.length).toBe(1);
		const handle = session.agent.activeResourceRunId;
		const proof = await session.abortPromptAndWait(handle ?? "run", {
			graceMs: TEST_ABORT_GRACE_MS,
			terminal: { scope: "turn" },
		});
		expect(proof).toBeDefined();
		// The follow-up must SURVIVE the abort purge (the pre-fix steering purge
		// removed every non-steer message from BOTH queues) and be DELIVERED under
		// a fresh lineage. Delivery is the strong proof: a purge would also drain
		// the queue, but only a surviving message reaches the model.
		await waitFor(
			() => session.agent.snapshotQueues().followUp.length === 0,
			"external follow-up rearmed and consumed",
		);
		await waitFor(
			() =>
				session.agent.state.messages.some(
					message => message.role === "user" && JSON.stringify(message.content).includes("external follow-up"),
				),
			"external follow-up delivered to the model",
		);
		await promptPromise;
	}, 30_000);
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

	it("settles owned-completion registrations when the disabled gate drops a delivery", async () => {
		// Reproduction of the review-thread P2 scenario: a scope:"owned" abort
		// that settles as owned_unsettled (e.g. a job missing the settlement
		// grace) leaves the disabled gate to later classify the job's terminal
		// completion as drop. The dropped envelope must STILL settle its
		// registration, or repeated occurrences retain terminal tuples until the
		// bounded registry saturates and later owned aborts fail closed.
		const bindEndpoint = chainSessionManager.getSessionId?.() ?? "local";
		const jobId = "bg-drop";
		const generation = "job:1";
		const registration: TurnRegistrationKey = {
			endpointId: bindEndpoint,
			endpointGeneration: 0,
			lineageIdHash: "drop-lineage",
			promptAttemptEpoch: 56,
			jobId,
			jobGeneration: generation,
		};
		registerTerminalTurnScope({
			lineageIdHash: registration.lineageIdHash,
			promptAttemptEpoch: registration.promptAttemptEpoch,
			ownedCompletionPolicy: "disabled",
		});
		registerOwnedRegistration(registration, { isJobTerminal: () => true });
		expect(lookupOwnedRegistration(jobId, generation, bindEndpoint)).toBeDefined();

		const unregisterDropKind = session.yieldQueue.register<{ ownedCompletion: OwnedCompletionEnvelope }>(
			"test-drop",
			{
				isStale: () => false,
				groupKey: () => "drop",
				build: entries => ({
					role: "custom",
					customType: "test-drop",
					content: "dropped completion",
					display: false,
					details: { ownedCompletions: entries.map(entry => entry.ownedCompletion) },
					timestamp: Date.now(),
				}),
			},
		);
		try {
			session.yieldQueue.enqueue("test-drop", {
				ownedCompletion: {
					lineageIdHash: registration.lineageIdHash,
					promptAttemptEpoch: registration.promptAttemptEpoch,
					registration,
				},
			});
			// The idle flush classifies the envelope as drop and must retire the
			// tuple (the dropped subset is settled in the injector).
			await waitFor(
				() => lookupOwnedRegistration(jobId, generation, bindEndpoint) === undefined,
				"tuple settled after dropped delivery",
				10_000,
			);
		} finally {
			unregisterDropKind();
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
			foreign.register("task", "foreign same-owner job", () => Promise.withResolvers<never>().promise, {
				id: "foreign-owner-job",
				ownerId: "sub-route-1",
			});
			owned.register("task", "owned job", () => Promise.withResolvers<never>().promise, {
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
			foreign.register("bash", "foreign job", () => Promise.withResolvers<never>().promise, {
				id: "snap-foreign",
				ownerId: "sub-snap-1",
			});
			owned.register("bash", "owned job", () => Promise.withResolvers<never>().promise, {
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
			pausedManager.register("task", "filler", () => Promise.withResolvers<never>().promise, {
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
			{ triggerTurn: true, deliverAs: "nextTurn" },
		);
		await waitFor(
			() => lookupOwnedRegistration(jobId, generation, bindEndpoint) === undefined,
			"tuple settled after direct idle owned-monitor delivery",
			10_000,
		);
		// The tuple can settle from the delivery finally block before the direct
		// prompt attempt has published its terminal agent event. Join that
		// boundary before afterEach tears down the owned manager, otherwise the
		// teardown races the delivery's final rearm/cleanup microtasks.
		await session.waitForIdle();
		await session.awaitSessionSettlement();
		manualTeardown = true;
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
		const foreign = new AsyncJobManager({
			maxRunningJobs: 4,
			onJobComplete: () => Promise.withResolvers<never>().promise,
		});
		const owned = new AsyncJobManager({
			maxRunningJobs: 4,
			onJobComplete: () => Promise.withResolvers<never>().promise,
		});
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
