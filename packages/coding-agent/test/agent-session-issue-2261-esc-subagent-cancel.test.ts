import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { Agent } from "@gajae-code/agent-core";
import { getBundledModel } from "@gajae-code/ai";
import { AsyncJobManager } from "@gajae-code/coding-agent/async/job-manager";
import { ModelRegistry } from "@gajae-code/coding-agent/config/model-registry";
import { Settings } from "@gajae-code/coding-agent/config/settings";
import * as internalUrls from "@gajae-code/coding-agent/internal-urls";
import { AgentSession } from "@gajae-code/coding-agent/session/agent-session";
import { ArtifactManager } from "@gajae-code/coding-agent/session/artifacts";
import { AuthStorage } from "@gajae-code/coding-agent/session/auth-storage";
import { SessionManager } from "@gajae-code/coding-agent/session/session-manager";
import {
	lookupOwnedRegistration,
	registerOwnedRegistration,
	unregisterOwnedRegistration,
} from "@gajae-code/coding-agent/session/terminal-abort";
import { TempDir } from "@gajae-code/utils";

const CLEANUP_NOTICE =
	"Unable to confirm owned subagent cleanup; session was not replaced. Wait for or inspect remaining subagents, then retry /new.";

async function waitForAbort(signal: AbortSignal): Promise<void> {
	if (signal.aborted) return;
	const aborted = Promise.withResolvers<void>();
	signal.addEventListener("abort", () => aborted.resolve(), { once: true });
	await aborted.promise;
}

async function pathExists(target: string): Promise<boolean> {
	return fs.stat(target).then(
		() => true,
		() => false,
	);
}

async function waitForCondition(predicate: () => boolean | Promise<boolean>, timeoutMs = 2_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (await predicate()) return;
		await Bun.sleep(10);
	}
	throw new Error("Timed out waiting for condition");
}

describe("AgentSession Issue #2261 /new owner-subagent cancellation", () => {
	let tempDir: TempDir;
	let authStorage: AuthStorage;
	let sessionManager: SessionManager;
	let session: AgentSession;
	let manager: AsyncJobManager | undefined;

	beforeEach(async () => {
		tempDir = TempDir.createSync("@gjc-issue-2261-");
		authStorage = await AuthStorage.create(path.join(tempDir.path(), "auth.db"));
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected bundled test model");
		sessionManager = SessionManager.create(tempDir.path(), tempDir.path());
		session = new AgentSession({
			agent: new Agent({ initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] } }),
			sessionManager,
			settings: Settings.isolated(),
			modelRegistry: new ModelRegistry(authStorage),
			agentId: "owner",
		});
	});

	afterEach(async () => {
		await session.dispose();
		await manager?.dispose({ timeoutMs: 100 });
		AsyncJobManager.setInstance(undefined);
		authStorage.close();
		tempDir.removeSync();
		vi.restoreAllMocks();
	});

	function installOwnerManager(): AsyncJobManager {
		manager = new AsyncJobManager({ onJobComplete: async () => {} });
		AsyncJobManager.setInstance(manager);
		return manager;
	}

	async function replaceWithOwnedManager(ownerManager: AsyncJobManager): Promise<void> {
		const model = session.model;
		await session.dispose();
		sessionManager = SessionManager.create(tempDir.path(), tempDir.path());
		session = new AgentSession({
			agent: new Agent({ initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] } }),
			sessionManager,
			settings: Settings.isolated(),
			modelRegistry: new ModelRegistry(authStorage),
			agentId: "owner",
			ownedAsyncJobManager: ownerManager,
		});
	}

	it("replaces the session without a job manager or live children", async () => {
		const previous = session.sessionFile;

		await expect(session.newSession()).resolves.toBe(true);
		expect(session.sessionFile).toBeDefined();
		expect(session.sessionFile).not.toBe(previous);
	});

	it("does not claim or rekey a fallback manager for a direct session without ownership", async () => {
		const fallbackManager = installOwnerManager();
		const predecessorEndpoint = sessionManager.getSessionId();
		expect(AsyncJobManager.registerForEndpoint(predecessorEndpoint, fallbackManager)).toBe(true);
		const jobId = fallbackManager.register("task", "direct-session registration", async () => "finished", {
			ownerId: "foreign",
		});
		const job = fallbackManager.getJob(jobId);
		if (!job) throw new Error("Expected fallback manager job");
		await job.promise;
		const registration = {
			endpointId: predecessorEndpoint,
			endpointGeneration: 0,
			lineageIdHash: "direct-session-lineage",
			promptAttemptEpoch: 1,
			jobId,
			jobGeneration: job.generation,
		};
		registerOwnedRegistration(registration);

		try {
			await expect(session.newSession()).resolves.toBe(true);
			expect(AsyncJobManager.forEndpoint(predecessorEndpoint)).toBe(fallbackManager);
			expect(AsyncJobManager.forEndpoint(sessionManager.getSessionId())).toBeUndefined();
			expect(lookupOwnedRegistration(jobId, job.generation, predecessorEndpoint)).toEqual(registration);
		} finally {
			unregisterOwnedRegistration(registration);
			AsyncJobManager.unregisterForEndpoint(predecessorEndpoint);
		}
	});

	it("waits for cooperative owned children before replacing identity", async () => {
		const ownerManager = installOwnerManager();
		const previous = session.sessionFile;
		const jobId = ownerManager.register(
			"task",
			"cooperative child",
			async ({ signal }) => {
				await waitForAbort(signal);
				return "cancelled";
			},
			{
				id: "child-job",
				ownerId: "owner",
				metadata: { subagent: { id: "child", agent: "executor", agentSource: "bundled" } },
			},
		);
		ownerManager.registerSubagentRecord({
			subagentId: "child",
			ownerId: "owner",
			currentJobId: jobId,
			historicalJobIds: [],
			status: "running",
			sessionFile: "/tmp/child.jsonl",
			resumable: true,
		});

		await expect(session.newSession()).resolves.toBe(true);
		expect(session.sessionFile).not.toBe(previous);
		expect(ownerManager.getSubagentRecord("child")).toBeUndefined();
	});

	it("retains identity and emits the exact lease-active notice", async () => {
		const ownerManager = installOwnerManager();
		const previous = session.sessionFile;
		const notices: string[] = [];
		session.subscribe(event => {
			if (event.type === "notice") notices.push(event.message);
		});
		vi.spyOn(ownerManager, "beginOwnerSubagentShutdown").mockReturnValue(undefined);

		await expect(session.newSession()).resolves.toBe(false);
		expect(session.sessionFile).toBe(previous);
		expect(notices).toEqual(["Cannot start a new session while owned subagent cleanup is already in progress."]);
	});

	it("shares one transition promise for concurrent /new requests and permits a later retry", async () => {
		// AgentSession rotates identity via prepare+commit (#3138), not SessionManager.newSession.
		const prepare = vi.spyOn(sessionManager, "prepareNewSession");
		const first = session.newSession();
		const second = session.newSession();

		expect(second).toBe(first);
		await expect(first).resolves.toBe(true);
		expect(prepare).toHaveBeenCalledTimes(1);

		await expect(session.newSession()).resolves.toBe(true);
		expect(prepare).toHaveBeenCalledTimes(2);
	});

	it("fails closed with the actionable notice and retains identity when owned-child proof is not confirmed", async () => {
		const ownerManager = installOwnerManager();
		const previous = session.sessionFile;
		const notices: string[] = [];
		session.subscribe(event => {
			if (event.type === "notice") notices.push(event.message);
		});
		vi.spyOn(ownerManager, "beginOwnerSubagentShutdown").mockReturnValue({
			ownerId: "owner",
			id: "lease",
			targets: [{ subagentId: "stuck", jobId: "stuck-job", source: "record" }],
		});
		vi.spyOn(ownerManager, "cancelAndProveOwnerSubagents").mockResolvedValue({
			ownerId: "owner",
			leaseId: "lease",
			confirmed: false,
			reason: "deadline_exceeded",
			targets: [{ subagentId: "stuck", jobId: "stuck-job", source: "record" }],
			terminalIds: [],
			unresolvedIds: ["stuck"],
		});
		vi.spyOn(ownerManager, "finishOwnerSubagentShutdown");

		await expect(session.newSession()).resolves.toBe(false);
		expect(session.sessionFile).toBe(previous);
		expect(notices).toEqual([CLEANUP_NOTICE]);
		expect(ownerManager.finishOwnerSubagentShutdown).toHaveBeenCalledWith(expect.any(Object), "release");
	});

	it("does not cancel generic owner jobs or replace identity when flush rejects", async () => {
		const ownerManager = installOwnerManager();
		const previous = session.sessionFile;
		const genericGate = Promise.withResolvers<string>();
		const genericJobId = ownerManager.register("bash", "generic", async () => genericGate.promise, {
			ownerId: "owner",
		});
		const cancelAndSettle = vi.spyOn(ownerManager, "cancelAndSettleOwnerJobs");
		const finishShutdown = vi.spyOn(ownerManager, "finishOwnerSubagentShutdown");
		vi.spyOn(sessionManager, "flush").mockRejectedValue(new Error("disk full"));

		await expect(session.newSession()).rejects.toThrow("disk full");
		expect(session.sessionFile).toBe(previous);
		expect(cancelAndSettle).not.toHaveBeenCalled();
		expect(ownerManager.getJob(genericJobId)?.status).toBe("running");
		expect(ownerManager.getDeliveryState({ ownerId: "owner" }).queued).toBe(0);
		expect(finishShutdown).toHaveBeenCalledWith(expect.any(Object), "release");
		genericGate.resolve("finished after retained session");
		await ownerManager.getJob(genericJobId)?.promise;
	});

	it("waits for in-flight owner delivery before flush and generic owner cancellation", async () => {
		const ownerManager = installOwnerManager();
		const order: string[] = [];
		vi.spyOn(ownerManager, "waitForOwnerInFlightDeliveries").mockImplementation(async () => {
			order.push("delivery");
			return true;
		});
		vi.spyOn(sessionManager, "flush").mockImplementation(async () => {
			order.push("flush");
		});
		vi.spyOn(ownerManager, "cancelAndSettleOwnerJobs").mockImplementation(async () => {
			order.push("cancel");
			return true;
		});

		await expect(session.newSession()).resolves.toBe(true);
		expect(order).toEqual(["delivery", "flush", "cancel"]);
	});

	it("creates the /drop identity before deleting the old session and treats deletion failure as non-fatal", async () => {
		const previous = session.sessionFile;
		if (!previous) throw new Error("Expected a persisted session file");
		const order: string[] = [];
		// Identity publication is commitPreparedNewSession (#3138); drop must run after it.
		const originalCommit = sessionManager.commitPreparedNewSession.bind(sessionManager);
		vi.spyOn(sessionManager, "commitPreparedNewSession").mockImplementation(prepared => {
			order.push("new");
			return originalCommit(prepared);
		});
		vi.spyOn(sessionManager, "dropSession").mockImplementation(async () => {
			order.push("drop");
			throw new Error("unlink failed");
		});

		await expect(session.newSession({ drop: true })).resolves.toBe(true);
		expect(order).toEqual(["new", "drop"]);
		expect(session.sessionFile).not.toBe(previous);
	});
	it("commits the lease when identity changes before a later initialization error", async () => {
		const ownerManager = installOwnerManager();
		const finishShutdown = vi.spyOn(ownerManager, "finishOwnerSubagentShutdown");
		// Post-commit, pre-return failure: identity already published via prepare+commit.
		const originalCommit = sessionManager.commitPreparedNewSession.bind(sessionManager);
		vi.spyOn(sessionManager, "commitPreparedNewSession").mockImplementation(prepared => {
			originalCommit(prepared);
			throw new Error("post-identity failure");
		});

		await expect(session.newSession()).rejects.toThrow("post-identity failure");
		expect(finishShutdown).toHaveBeenCalledWith(expect.any(Object), "commit");
	});

	it("fails closed with the exact notice when producer cleanup throws, then permits retry", async () => {
		const ownerManager = installOwnerManager();
		const previous = session.sessionFile;
		const notices: string[] = [];
		session.subscribe(event => {
			if (event.type === "notice") notices.push(event.message);
		});
		let cleanupAttempts = 0;
		ownerManager.registerOwnerCleanup("owner", () => {
			cleanupAttempts += 1;
			if (cleanupAttempts === 1) throw new Error("cleanup failed");
		});

		await expect(session.newSession()).resolves.toBe(false);
		expect(session.sessionFile).toBe(previous);
		expect(notices).toEqual([CLEANUP_NOTICE]);
		await expect(session.newSession()).resolves.toBe(true);
		expect(cleanupAttempts).toBe(2);
	});

	it("settles generic owner jobs and suppresses their delivery before replacing identity", async () => {
		const completions: string[] = [];
		manager = new AsyncJobManager({
			onJobComplete: async jobId => {
				completions.push(jobId);
			},
		});
		AsyncJobManager.setInstance(manager);
		const genericJobId = manager.register(
			"task",
			"generic",
			async ({ signal }) => {
				await waitForAbort(signal);
				return "cancelled";
			},
			{ ownerId: "owner" },
		);

		await expect(session.newSession()).resolves.toBe(true);
		expect(manager.getJob(genericJobId)?.status).toBe("cancelled");
		expect(completions).toEqual([]);
		expect(manager.getDeliveryState({ ownerId: "owner" }).queued).toBe(0);
	});

	it("commits copied-transcript switches with the same session id and suppresses predecessor state", async () => {
		const completions: string[] = [];
		manager = new AsyncJobManager({
			onJobComplete: async jobId => {
				completions.push(jobId);
			},
		});
		AsyncJobManager.setInstance(manager);
		const previousFile = session.sessionFile;
		if (!previousFile) throw new Error("Expected a persisted predecessor session");
		await sessionManager.ensureOnDisk();
		const previousSessionId = session.sessionId;
		const copiedFile = path.join(tempDir.path(), "copied-transcript.jsonl");
		await Bun.write(copiedFile, Bun.file(previousFile));
		const predecessorJobId = manager.register(
			"task",
			"copied transcript predecessor",
			async ({ signal }) => {
				await waitForAbort(signal);
				return "predecessor completion";
			},
			{
				id: "copied-transcript-predecessor-job",
				ownerId: "owner",
				metadata: { subagent: { id: "copied-transcript-child", agent: "executor", agentSource: "bundled" } },
			},
		);
		manager.registerSubagentRecord({
			subagentId: "copied-transcript-child",
			ownerId: "owner",
			currentJobId: predecessorJobId,
			historicalJobIds: [],
			status: "running",
			sessionFile: "/tmp/copied-transcript-child.jsonl",
			resumable: true,
		});
		const finishShutdown = vi.spyOn(manager, "finishOwnerSubagentShutdown");

		await expect(session.switchSession(copiedFile)).resolves.toBe(true);
		await Bun.sleep(10);
		expect(session.sessionFile).toBe(copiedFile);
		expect(session.sessionId).toBe(previousSessionId);
		expect(finishShutdown).toHaveBeenCalledWith(expect.any(Object), "commit");
		expect(manager.getJob(predecessorJobId)?.status).toBe("cancelled");
		expect(manager.getDeliveryState({ ownerId: "owner" }).queued).toBe(0);
		expect(manager.getSubagentRecord("copied-transcript-child")).toBeUndefined();
		expect(completions).toEqual([]);
	});

	it("preserves live owner jobs and producer callbacks when successor validation rolls back", async () => {
		const ownerManager = installOwnerManager();
		const previousFile = session.sessionFile;
		if (!previousFile) throw new Error("Expected a persisted predecessor session");
		await sessionManager.ensureOnDisk();
		const copiedFile = path.join(tempDir.path(), "fallible-successor.jsonl");
		await Bun.write(copiedFile, Bun.file(previousFile));
		let producerCleanupCalls = 0;
		ownerManager.registerOwnerCleanup("owner", () => {
			producerCleanupCalls += 1;
		});
		const ownerJobId = ownerManager.register(
			"task",
			"rollback-preserved owner job",
			async ({ signal }) => {
				await waitForAbort(signal);
				return "cancelled after validated retry";
			},
			{ ownerId: "owner" },
		);
		const predecessorEndpointId = sessionManager.getSessionId();
		const ownerJob = ownerManager.getJob(ownerJobId);
		if (!ownerJob) throw new Error("Expected owner job");
		registerOwnedRegistration(
			{
				endpointId: predecessorEndpointId,
				endpointGeneration: 0,
				lineageIdHash: "switch-rollback-lineage",
				promptAttemptEpoch: 1,
				jobId: ownerJobId,
				jobGeneration: ownerJob.generation,
			},
			{ isJobTerminal: () => false },
		);
		const finishShutdown = vi.spyOn(ownerManager, "finishOwnerSubagentShutdown");
		const validation = vi
			.spyOn(internalUrls, "initializeLocalRoot")
			.mockRejectedValueOnce(new Error("injected successor validation failure"));

		await expect(session.switchSession(copiedFile)).rejects.toThrow("injected successor validation failure");
		expect(session.sessionFile).toBe(previousFile);
		expect(ownerManager.getJob(ownerJobId)?.status).toBe("running");
		// Rekey moved the manager mapping, but rollback restored the
		// predecessor while the job remains live. Its predecessor tuple must
		// survive too; otherwise scope:"owned" can claim stopped_owned without
		// cancelling/classifying this job (review thread P1).
		expect(lookupOwnedRegistration(ownerJobId, ownerJob.generation, predecessorEndpointId)).toBeDefined();
		expect(producerCleanupCalls).toBe(0);
		expect(finishShutdown).toHaveBeenLastCalledWith(expect.any(Object), "release");

		validation.mockRestore();
		await expect(session.switchSession(copiedFile)).resolves.toBe(true);
		expect(session.sessionFile).toBe(copiedFile);
		expect(ownerManager.getJob(ownerJobId)?.status).toBe("cancelled");
		expect(lookupOwnedRegistration(ownerJobId, ownerJob.generation, predecessorEndpointId)).toBeUndefined();
		expect(producerCleanupCalls).toBe(1);
		expect(finishShutdown).toHaveBeenLastCalledWith(expect.any(Object), "commit");
	});

	it.each([
		"proof",
		"settlement",
	] as const)("eventually finalizes the successor after post-validation owner %s timeout", async failure => {
		const ownerManager = installOwnerManager();
		const previousFile = session.sessionFile;
		if (!previousFile) throw new Error("Expected a persisted predecessor session");
		await sessionManager.ensureOnDisk();
		const copiedFile = path.join(tempDir.path(), `${failure}-timeout-successor.jsonl`);
		await Bun.write(copiedFile, Bun.file(previousFile));
		const fallbackRoot = await fs.mkdtemp(path.join(tempDir.path(), `${failure}-resume-fallback-`));
		const fallbackManager = new ArtifactManager(fallbackRoot);
		sessionManager.adoptArtifactManager(fallbackManager);
		session.registerToolSessionTransitionCleanup(async () => {
			sessionManager.releaseArtifactManager(fallbackManager);
			await fs.rm(fallbackRoot, { recursive: true, force: true });
		});
		const retryAllowed = Promise.withResolvers<void>();
		const foreignGate = Promise.withResolvers<string>();
		const foreignJobId = ownerManager.register(
			"task",
			"foreign deferred cleanup job",
			async () => foreignGate.promise,
			{
				ownerId: "foreign",
			},
		);
		if (failure === "proof") {
			let calls = 0;
			vi.spyOn(ownerManager, "cancelAndProveOwnerSubagents").mockImplementation(async lease => {
				calls += 1;
				if (calls === 1) {
					return {
						ownerId: "owner",
						leaseId: lease.id,
						confirmed: false,
						reason: "deadline_exceeded",
						targets: [],
						terminalIds: [],
						unresolvedIds: ["stuck"],
					};
				}
				await retryAllowed.promise;
				return {
					ownerId: "owner",
					leaseId: lease.id,
					confirmed: true,
					reason: "confirmed",
					targets: [],
					terminalIds: [],
					unresolvedIds: [],
				};
			});
		} else {
			let calls = 0;
			vi.spyOn(ownerManager, "cancelAndSettleOwnerJobs").mockImplementation(async () => {
				calls += 1;
				if (calls === 1) return false;
				await retryAllowed.promise;
				return true;
			});
		}
		const finishShutdown = vi.spyOn(ownerManager, "finishOwnerSubagentShutdown");
		const appendMessage = vi.spyOn(sessionManager, "appendMessage");
		const notices: string[] = [];
		session.subscribe(event => {
			if (event.type === "notice") notices.push(event.message);
		});

		try {
			await expect(session.switchSession(copiedFile)).resolves.toBe(true);
			expect(session.sessionFile).toBe(copiedFile);
			expect(finishShutdown).not.toHaveBeenCalled();
			expect(ownerManager.beginOwnerSubagentShutdown("owner")).toBeUndefined();
			expect(await pathExists(fallbackRoot)).toBe(true);
			expect(notices.some(message => message.includes("Successor session is active"))).toBe(true);
			session.agent.emitExternalEvent({
				type: "message_end",
				message: { role: "user", content: "successor remains connected", timestamp: Date.now() },
			});
			expect(appendMessage).toHaveBeenCalledWith(
				expect.objectContaining({ content: "successor remains connected" }),
			);
		} finally {
			retryAllowed.resolve();
		}
		await waitForCondition(() => finishShutdown.mock.calls.some(call => call[1] === "commit"));
		await waitForCondition(async () => !(await pathExists(fallbackRoot)));
		expect(sessionManager.isArtifactManagerAuthorized(fallbackManager)).toBe(false);
		expect(ownerManager.getJob(foreignJobId)?.status).toBe("running");
		const successorJobId = ownerManager.register(
			"bash",
			"successor owner job",
			async () => "successor job complete",
			{
				ownerId: "owner",
			},
		);
		await ownerManager.getJob(successorJobId)?.promise;
		expect(ownerManager.getJob(successorJobId)?.status).toBe("completed");
		await expect(session.newSession()).resolves.toBe(true);
		expect(finishShutdown.mock.calls.filter(call => call[1] === "commit")).toHaveLength(2);
		expect(ownerManager.getJob(foreignJobId)?.status).toBe("running");
		foreignGate.resolve("foreign complete");
		await ownerManager.getJob(foreignJobId)?.promise;
	});

	it("settles detached owner jobs before fork and branch artifact retirement", async () => {
		const ownerManager = installOwnerManager();
		const fallbackRoot = await fs.mkdtemp(path.join(tempDir.path(), "fork-fallback-"));
		const fallbackManager = new ArtifactManager(fallbackRoot);
		sessionManager.adoptArtifactManager(fallbackManager);
		session.registerToolSessionTransitionCleanup(async () => {
			sessionManager.releaseArtifactManager(fallbackManager);
			await fs.rm(fallbackRoot, { recursive: true, force: true });
		});
		const order: string[] = [];
		const ownerJobId = ownerManager.register(
			"task",
			"fork predecessor task",
			async ({ signal }) => {
				await waitForAbort(signal);
				await Bun.write(path.join(fallbackRoot, "late-task.md"), "settled before fork cleanup");
				order.push("late-write");
				return "cancelled";
			},
			{
				ownerId: "owner",
				metadata: { subagent: { id: "fork-child", agent: "executor", agentSource: "bundled" } },
			},
		);
		ownerManager.registerSubagentRecord({
			subagentId: "fork-child",
			ownerId: "owner",
			currentJobId: ownerJobId,
			historicalJobIds: [],
			status: "running",
			sessionFile: null,
			resumable: true,
		});
		const foreignGate = Promise.withResolvers<string>();
		const foreignJobId = ownerManager.register("task", "foreign fork task", async () => foreignGate.promise, {
			ownerId: "foreign",
		});
		const originalSettle = ownerManager.cancelAndSettleOwnerJobs.bind(ownerManager);
		vi.spyOn(ownerManager, "cancelAndSettleOwnerJobs").mockImplementation(async ownerId => {
			const settled = await originalSettle(ownerId);
			order.push("settle");
			return settled;
		});
		const originalCommit = sessionManager.commitPreparedNewSession.bind(sessionManager);
		vi.spyOn(sessionManager, "commitPreparedNewSession").mockImplementation(prepared => {
			order.push("commit");
			originalCommit(prepared);
		});

		await expect(session.fork()).resolves.toBe(true);
		expect(order).toEqual(["late-write", "settle", "commit"]);
		expect(await Bun.file(path.join(fallbackRoot, "late-task.md")).exists()).toBe(false);
		await Bun.sleep(20);
		expect(await Bun.file(fallbackRoot).exists()).toBe(false);
		expect(ownerManager.getJob(foreignJobId)?.status).toBe("running");

		order.length = 0;
		const userEntryId = sessionManager.appendMessage({
			role: "user",
			content: "branch target",
			timestamp: Date.now(),
		});
		await expect(session.branch(userEntryId)).resolves.toMatchObject({ cancelled: false });
		expect(order).toEqual(["settle", "commit"]);
		expect(ownerManager.getJob(foreignJobId)?.status).toBe("running");
		foreignGate.resolve("foreign complete");
		await ownerManager.getJob(foreignJobId)?.promise;
	});

	it("reserves the successor endpoint while branch settlement cancels predecessor jobs", async () => {
		const ownerManager = installOwnerManager();
		await replaceWithOwnedManager(ownerManager);
		const predecessorEndpoint = sessionManager.getSessionId();
		expect(AsyncJobManager.registerForEndpoint(predecessorEndpoint, ownerManager)).toBe(true);
		const userEntryId = sessionManager.appendMessage({
			role: "user",
			content: "branch reservation target",
			timestamp: Date.now(),
		});
		await sessionManager.flush();
		const ownerJobId = ownerManager.register(
			"task",
			"branch reservation predecessor",
			async ({ signal }) => {
				await waitForAbort(signal);
				return "cancelled";
			},
			{ ownerId: "owner" },
		);
		let successorEndpoint: string | undefined;
		const originalPrepare = sessionManager.prepareNewSession.bind(sessionManager);
		vi.spyOn(sessionManager, "prepareNewSession").mockImplementation(async options => {
			const prepared = await originalPrepare(options);
			successorEndpoint = prepared.sessionId;
			return prepared;
		});
		const foreignManager = new AsyncJobManager({ onJobComplete: async () => {} });
		let successorClaim: boolean | undefined;
		const originalSettle = ownerManager.cancelAndSettleOwnerJobs.bind(ownerManager);
		vi.spyOn(ownerManager, "cancelAndSettleOwnerJobs").mockImplementation(async ownerId => {
			if (!successorEndpoint) throw new Error("Successor endpoint was not prepared");
			successorClaim = AsyncJobManager.registerForEndpoint(successorEndpoint, foreignManager);
			return originalSettle(ownerId);
		});

		try {
			await expect(session.branch(userEntryId)).resolves.toMatchObject({ cancelled: false });
			expect(successorClaim).toBe(false);
			expect(successorEndpoint).toBeDefined();
			expect(ownerManager.getJob(ownerJobId)?.status).toBe("cancelled");
			expect(AsyncJobManager.forEndpoint(predecessorEndpoint)).toBeUndefined();
			expect(AsyncJobManager.forEndpoint(successorEndpoint)).toBe(ownerManager);
		} finally {
			await foreignManager.dispose({ timeoutMs: 100 });
		}
	});

	it("removes borrowed-manager successor aliases after a child session commits", async () => {
		const ownerManager = installOwnerManager();
		const parentEndpoint = sessionManager.getSessionId();
		expect(AsyncJobManager.registerForEndpoint(parentEndpoint, ownerManager)).toBe(true);
		const childManager = SessionManager.create(tempDir.path(), tempDir.path());
		const child = new AgentSession({
			agent: new Agent({
				initialState: {
					model: session.model,
					systemPrompt: ["Child test"],
					tools: [],
					messages: [],
				},
			}),
			sessionManager: childManager,
			settings: Settings.isolated(),
			modelRegistry: new ModelRegistry(authStorage),
			agentId: "child",
			ownedAsyncJobManager: ownerManager,
			disposeAsyncJobManager: false,
		});
		const predecessorEndpoint = child.sessionManager.getSessionId();
		expect(AsyncJobManager.forEndpoint(predecessorEndpoint)).toBeUndefined();

		try {
			await expect(child.newSession()).resolves.toBe(true);
			const successorEndpoint = child.sessionManager.getSessionId();
			expect(successorEndpoint).not.toBe(predecessorEndpoint);
			expect(AsyncJobManager.forEndpoint(parentEndpoint)).toBe(ownerManager);
			expect(AsyncJobManager.forEndpoint(predecessorEndpoint)).toBeUndefined();
			expect(AsyncJobManager.forEndpoint(successorEndpoint)).toBeUndefined();
		} finally {
			// Avoid inherited-manager disposal code treating the parent's endpoint as
			// the child's own registration boundary during test teardown.
			AsyncJobManager.unregisterForEndpoint(parentEndpoint);
			await child.dispose();
		}
	});

	it("does not sweep parent registrations when an inherited-manager child is disposed", async () => {
		const ownerManager = installOwnerManager();
		const parentEndpoint = sessionManager.getSessionId();
		expect(AsyncJobManager.registerForEndpoint(parentEndpoint, ownerManager)).toBe(true);
		const parentJobId = ownerManager.register("task", "parent registration", async () => "finished", {
			ownerId: "owner",
		});
		const parentJob = ownerManager.getJob(parentJobId);
		if (!parentJob) throw new Error("Expected parent manager job");
		await parentJob.promise;
		const registration = {
			endpointId: parentEndpoint,
			endpointGeneration: 0,
			lineageIdHash: "parent-registration-lineage",
			promptAttemptEpoch: 1,
			jobId: parentJobId,
			jobGeneration: parentJob.generation,
		};
		registerOwnedRegistration(registration);
		const childManager = SessionManager.create(tempDir.path(), tempDir.path());
		const child = new AgentSession({
			agent: new Agent({
				initialState: {
					model: session.model,
					systemPrompt: ["Child test"],
					tools: [],
					messages: [],
				},
			}),
			sessionManager: childManager,
			settings: Settings.isolated(),
			modelRegistry: new ModelRegistry(authStorage),
			agentId: "child",
			ownedAsyncJobManager: ownerManager,
			disposeAsyncJobManager: false,
		});

		try {
			await child.dispose();
			expect(AsyncJobManager.forEndpoint(parentEndpoint)).toBe(ownerManager);
			expect(lookupOwnedRegistration(parentJobId, parentJob.generation, parentEndpoint)).toEqual(registration);
		} finally {
			unregisterOwnedRegistration(registration);
			AsyncJobManager.unregisterForEndpoint(parentEndpoint);
			await child.dispose();
		}
	});

	it("keeps predecessor endpoint identity when switch fails after successor load", async () => {
		const ownerManager = installOwnerManager();
		const predecessorEndpoint = sessionManager.getSessionId();
		expect(AsyncJobManager.registerForEndpoint(predecessorEndpoint, ownerManager)).toBe(true);
		const predecessorFile = session.sessionFile;
		if (!predecessorFile) throw new Error("Expected a persisted predecessor session");
		const targetManager = SessionManager.create(tempDir.path(), tempDir.path());
		targetManager.appendMessage({ role: "user", content: "switch target", timestamp: Date.now() });
		await targetManager.flush();
		const targetFile = targetManager.getSessionFile();
		const targetEndpoint = targetManager.getSessionId();
		if (!targetFile) throw new Error("Expected a persisted switch target");
		await targetManager.close();
		vi.spyOn(sessionManager, "ensureOnDisk").mockRejectedValueOnce(new Error("post-load switch failure"));
		const ownerGate = Promise.withResolvers<string>();
		const ownerJobId = ownerManager.register("task", "switch predecessor", async () => ownerGate.promise, {
			ownerId: "owner",
		});

		try {
			await expect(session.switchSession(targetFile)).rejects.toThrow("post-load switch failure");
			expect(session.sessionFile).toBe(predecessorFile);
			expect(session.sessionId).toBe(predecessorEndpoint);
			expect(ownerManager.getJob(ownerJobId)?.status).toBe("running");
			expect(AsyncJobManager.forEndpoint(predecessorEndpoint)).toBe(ownerManager);
			expect(AsyncJobManager.forEndpoint(targetEndpoint)).toBeUndefined();
		} finally {
			ownerGate.resolve("finished after rollback");
			await ownerManager.getJob(ownerJobId)?.promise;
		}
	});

	it("fences late same-owner generic admission while leaving foreign jobs isolated", async () => {
		const ownerManager = installOwnerManager();
		const foreignGate = Promise.withResolvers<void>();
		const foreignJobId = ownerManager.register(
			"task",
			"foreign",
			async (): Promise<string> => {
				await foreignGate.promise;
				return "foreign";
			},
			{ ownerId: "foreign" },
		);
		const originalProof = ownerManager.cancelAndProveOwnerSubagents.bind(ownerManager);
		vi.spyOn(ownerManager, "cancelAndProveOwnerSubagents").mockImplementation(async lease => {
			expect(() => ownerManager.register("task", "late", async () => "late", { ownerId: "owner" })).toThrow(
				"Cannot start subagent while owner shutdown is in progress.",
			);
			return await originalProof(lease);
		});

		await expect(session.newSession()).resolves.toBe(true);
		expect(ownerManager.getJob(foreignJobId)?.status).toBe("running");
		foreignGate.resolve();
		await ownerManager.waitForAll();
	});
});
