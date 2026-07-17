import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { Agent } from "@gajae-code/agent-core";
import { getBundledModel } from "@gajae-code/ai";
import { AsyncJobManager } from "@gajae-code/coding-agent/async/job-manager";
import { ModelRegistry } from "@gajae-code/coding-agent/config/model-registry";
import { Settings } from "@gajae-code/coding-agent/config/settings";
import { AgentSession } from "@gajae-code/coding-agent/session/agent-session";
import { AuthStorage } from "@gajae-code/coding-agent/session/auth-storage";
import { SessionManager } from "@gajae-code/coding-agent/session/session-manager";
import { TempDir } from "@gajae-code/utils";

const CLEANUP_NOTICE =
	"Unable to confirm owned subagent cleanup; session was not replaced. Wait for or inspect remaining subagents, then retry /new.";

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

	it("replaces the session without a job manager or live children", async () => {
		const previous = session.sessionFile;

		await expect(session.newSession()).resolves.toBe(true);
		expect(session.sessionFile).toBeDefined();
		expect(session.sessionFile).not.toBe(previous);
	});

	it("waits for cooperative owned children before replacing identity", async () => {
		const ownerManager = installOwnerManager();
		const previous = session.sessionFile;
		const jobId = ownerManager.register(
			"task",
			"cooperative child",
			async ({ signal }) => {
				await new Promise<void>(resolve => signal.addEventListener("abort", () => resolve(), { once: true }));
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
		const newSession = vi.spyOn(sessionManager, "newSession");
		const first = session.newSession();
		const second = session.newSession();

		expect(second).toBe(first);
		await expect(first).resolves.toBe(true);
		expect(newSession).toHaveBeenCalledTimes(1);

		await expect(session.newSession()).resolves.toBe(true);
		expect(newSession).toHaveBeenCalledTimes(2);
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
		vi.spyOn(sessionManager, "newSession").mockImplementation(async options => {
			order.push("new");
			return await SessionManager.prototype.newSession.call(sessionManager, options);
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
		vi.spyOn(sessionManager, "newSession").mockImplementation(async options => {
			await SessionManager.prototype.newSession.call(sessionManager, options);
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
				await new Promise<void>(resolve => signal.addEventListener("abort", () => resolve(), { once: true }));
				return "cancelled";
			},
			{ ownerId: "owner" },
		);

		await expect(session.newSession()).resolves.toBe(true);
		expect(manager.getJob(genericJobId)?.status).toBe("cancelled");
		expect(completions).toEqual([]);
		expect(manager.getDeliveryState({ ownerId: "owner" }).queued).toBe(0);
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
