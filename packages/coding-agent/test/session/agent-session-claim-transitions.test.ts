/**
 * AgentSession's outer transitions and the claim set (single-owner design §2.5, §12): every outer
 * transition holds a claim-set transition open, so a predecessor stays claimed until the switch
 * commits, and a rollback or hook cancel releases the target instead. Claims are real claims in the
 * test preload's isolated home, handed in where the factories will hand them in (4b): the target is
 * claimed just before the manager rotates to it. Ownership runs in `observe` under the strict seam,
 * so a transition write to an id the set does not hold fails the test.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Agent } from "@gajae-code/agent-core";
import * as compactionModule from "@gajae-code/agent-core/compaction";
import { getBundledModel } from "@gajae-code/ai";
import { AsyncJobManager } from "../../src/async/job-manager";
import { ModelRegistry } from "../../src/config/model-registry";
import { Settings } from "../../src/config/settings";
import { AgentSession } from "../../src/session/agent-session";
import { AuthStorage } from "../../src/session/auth-storage";
import { sessionClaimSetOf } from "../../src/session/internal/session-claim-set";
import { SessionManager } from "../../src/session/session-manager";
import {
	claimSessionOwner,
	probeSessionOwner,
	resetSessionOwnershipForTests,
	type SessionOwnerClaim,
	SessionOwnershipTestHooks,
} from "../../src/session/session-ownership";
import { outsideStrictSeam, useStrictWriteDetection } from "./strict-write-detection";

const supported = process.platform === "linux" || process.platform === "darwin";
const roots: string[] = [];
const sessions: AgentSession[] = [];
const authStores: AuthStorage[] = [];

beforeEach(() => {
	SessionOwnershipTestHooks.mode = "observe";
});

afterEach(async () => {
	try {
		for (const session of sessions.splice(0)) await session.dispose();
		AsyncJobManager.setInstance(undefined);
		for (const auth of authStores.splice(0)) auth.close();
		for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
	} finally {
		vi.restoreAllMocks();
		delete SessionOwnershipTestHooks.mode;
		// Throws when a claim leaked, so a missed release fails the test that leaked it.
		resetSessionOwnershipForTests();
	}
});

const user = (text: string) => ({ role: "user" as const, content: text, timestamp: Date.now() });

async function claim(sessionId: string): Promise<SessionOwnerClaim> {
	const result = await claimSessionOwner(sessionId, { surface: "terminal" });
	if (result.status !== "claimed") throw new Error(`expected a claim of ${sessionId}, got ${result.status}`);
	return result.claim;
}

const held = async (sessionId: string) => (await probeSessionOwner(sessionId)).state === "held";

/** A session A open in an AgentSession with A claimed, and a second persisted session B on disk. */
async function fixture(options: { extensionRunner?: unknown; agentId?: string } = {}) {
	const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "gjc-claim-transitions-")));
	roots.push(root);
	const cwd = path.join(root, "workspace");
	const agentDir = path.join(root, "agent");
	await fs.mkdir(cwd, { recursive: true });
	await fs.mkdir(agentDir, { recursive: true, mode: 0o700 });
	const destination = SessionManager.managedDestination(cwd, agentDir);
	// B is written by another opener that held its own claim; this process never claimed it.
	const { otherFile, otherId } = await outsideStrictSeam(async () => {
		const other = SessionManager.create(cwd, destination);
		other.appendMessage(user("B-1"));
		await other.ensureOnDisk();
		await other.flush();
		const file = other.getSessionFile()!;
		const id = other.getSessionId();
		await other.close();
		return { otherFile: file, otherId: id };
	});

	const manager = SessionManager.create(cwd, destination);
	const claims = sessionClaimSetOf(manager);
	const predecessor = manager.getSessionId();
	claims.add(await claim(predecessor));
	manager.appendMessage(user("A-1"));
	await manager.ensureOnDisk();
	await manager.flush();

	const authStorage = await AuthStorage.create(path.join(root, "auth.db"));
	authStores.push(authStorage);
	const model = getBundledModel("anthropic", "claude-sonnet-4-5");
	if (!model) throw new Error("Expected bundled model");
	const session = new AgentSession({
		agent: new Agent({ initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] } }),
		sessionManager: manager,
		settings: Settings.isolated({ "compaction.enabled": false }),
		modelRegistry: new ModelRegistry(authStorage, path.join(root, "models.yml")),
		agentId: options.agentId ?? "claim-transitions",
		...(options.extensionRunner ? { extensionRunner: options.extensionRunner as never } : {}),
	});
	sessions.push(session);
	return { manager, claims, predecessor, otherFile, otherId, authStorage, session };
}

/** Claim each successor `prepare` returns, standing in for 4b's factory claim. */
function claimPrepared(manager: SessionManager, method: "prepareNewSession" | "prepareFork") {
	const claims = sessionClaimSetOf(manager);
	const prepare = manager[method].bind(manager) as (...args: unknown[]) => Promise<{ sessionId: string } | undefined>;
	vi.spyOn(manager, method).mockImplementation((async (...args: unknown[]) => {
		const prepared = await prepare(...args);
		if (prepared) claims.add(await claim(prepared.sessionId));
		return prepared;
	}) as never);
}

/** Claim the switch target just before the manager rotates to it, and record what was held right after. */
function claimTargetOnSwitch(manager: SessionManager, targetId: string, predecessor: string) {
	const afterRotation: boolean[] = [];
	const setSessionFile = manager.setSessionFile.bind(manager);
	vi.spyOn(manager, "setSessionFile").mockImplementation(async (file, options) => {
		sessionClaimSetOf(manager).add(await claim(targetId));
		await setSessionFile(file, options);
		afterRotation.push(await held(predecessor));
	});
	return afterRotation;
}

describe.if(supported)("AgentSession outer transitions keep claims until they end (design §2.5)", () => {
	useStrictWriteDetection();

	it("/resume: the predecessor stays claimed past the rotation and is released once the switch commits", async () => {
		const { manager, claims, predecessor, otherFile, otherId } = await fixture();
		const afterRotation = claimTargetOnSwitch(manager, otherId, predecessor);

		const session = sessions[0]!;
		expect(await session.switchSession(otherFile)).toBe(true);

		expect(afterRotation).toEqual([true]);
		expect(manager.getSessionId()).toBe(otherId);
		expect(await held(predecessor)).toBe(false);
		expect(await held(otherId)).toBe(true);
		expect(claims.sessionIds).toEqual([otherId]);
	});

	it("rollback of a failed switch: the target is released and the predecessor stays claimed", async () => {
		const { manager, claims, predecessor, otherFile, otherId } = await fixture();
		const afterRotation = claimTargetOnSwitch(manager, otherId, predecessor);
		// The successor fails after the manager rotated to it, so the switch restores the predecessor.
		vi.spyOn(manager, "ensureOnDisk").mockRejectedValueOnce(new Error("successor ensureOnDisk failed"));

		const session = sessions[0]!;
		await expect(session.switchSession(otherFile)).rejects.toThrow("successor ensureOnDisk failed");

		expect(afterRotation).toEqual([true]);
		expect(manager.getSessionId()).toBe(predecessor);
		expect(await held(predecessor)).toBe(true);
		expect(await held(otherId)).toBe(false);
		expect(claims.sessionIds).toEqual([predecessor]);
	});

	it("hook cancel: a target claimed inside the transition is released and the predecessor kept", async () => {
		const staged: { manager?: SessionManager } = {};
		const extensionRunner = {
			hasHandlers: (event: string) => event === "session_before_switch",
			emit: async (event: { type: string }) => {
				if (event.type !== "session_before_switch") return undefined;
				// A surface that claims its target before the hook, then the hook cancels.
				sessionClaimSetOf(staged.manager!).add(await claim("cancelled-target"));
				return { cancel: true };
			},
		};
		const { manager, claims, predecessor, otherFile } = await fixture({ extensionRunner });
		staged.manager = manager;
		const session = sessions[0]!;

		expect(await session.switchSession(otherFile)).toBe(false);
		expect(await held("cancelled-target")).toBe(false);
		expect(await session.newSession()).toBe(false);
		expect(await held("cancelled-target")).toBe(false);

		expect(manager.getSessionId()).toBe(predecessor);
		expect(await held(predecessor)).toBe(true);
		expect(claims.sessionIds).toEqual([predecessor]);
	});

	it("/new and branch: the predecessor is released when the transition ends, the successor kept", async () => {
		const { manager, claims, predecessor, session } = await fixture();
		claimPrepared(manager, "prepareNewSession");

		expect(await session.newSession()).toBe(true);
		const successor = manager.getSessionId();
		expect(successor).not.toBe(predecessor);
		expect(await held(predecessor)).toBe(false);
		expect(claims.sessionIds).toEqual([successor]);

		manager.appendMessage(user("successor prompt"));
		await manager.flush();
		const prepareBranchedSession = manager.prepareBranchedSession.bind(manager);
		vi.spyOn(manager, "prepareBranchedSession").mockImplementation(async leafId => {
			const prepared = await prepareBranchedSession(leafId);
			claims.add(await claim(prepared.sessionId));
			return prepared;
		});
		const entry = manager.getEntries().find(each => each.type === "message")!;
		// The branch successor is published inside prepare, before this spy can claim it; 4b claims it
		// in the factory, ahead of that write. Until then the branch runs outside the strict seam.
		const branched = await outsideStrictSeam(() => session.branch(entry.id));
		expect(branched.cancelled).toBe(false);
		const fork = manager.getSessionId();
		expect(fork).not.toBe(successor);
		expect(await held(successor)).toBe(false);
		expect(await held(fork)).toBe(true);
		expect(claims.sessionIds).toEqual([fork]);
	});

	it("deferred owner shutdown: the predecessor stays claimed until the deferred finalization settles", async () => {
		const asyncManager = new AsyncJobManager({ onJobComplete: async () => {} });
		AsyncJobManager.setInstance(asyncManager);
		const { manager, claims, predecessor, otherFile, otherId } = await fixture({ agentId: "owner" });
		claimTargetOnSwitch(manager, otherId, predecessor);
		const gate = Promise.withResolvers<void>();
		let settleCalls = 0;
		vi.spyOn(asyncManager, "cancelAndSettleOwnerJobs").mockImplementation(async () => {
			settleCalls += 1;
			// The switch's own settle fails, so finalization is deferred; its retries wait for the gate.
			if (settleCalls === 1) return false;
			await gate.promise;
			return true;
		});
		const session = sessions[0]!;

		expect(await session.switchSession(otherFile)).toBe(true);
		expect(manager.getSessionId()).toBe(otherId);
		expect(await held(predecessor)).toBe(true);
		expect(claims.sessionIds.toSorted()).toEqual([predecessor, otherId].toSorted());

		gate.resolve();
		const deadline = Date.now() + 5_000;
		while ((await held(predecessor)) && Date.now() < deadline) await Bun.sleep(10);
		expect(await held(predecessor)).toBe(false);
		expect(await held(otherId)).toBe(true);
		expect(claims.sessionIds).toEqual([otherId]);
	});
	it("handoff rollback after the rotation, before the commit: the target is released and the predecessor kept", async () => {
		const { manager, claims, predecessor, authStorage, session } = await fixture();
		authStorage.setRuntimeApiKey("anthropic", "test-key");
		manager.appendMessage(user("A-2"));
		await manager.flush();
		vi.spyOn(compactionModule, "generateHandoff").mockResolvedValue("## Goal\nContinue");
		claimPrepared(manager, "prepareNewSession");
		let target: string | undefined;
		let targetClaimed = false;
		// Fails inside the commit boundary, after the manager rotated to the successor.
		vi.spyOn(session, "retireSessionAgentModelOverrides").mockImplementationOnce(() => {
			target = manager.getSessionId();
			targetClaimed = claims.has(target) && claims.has(predecessor);
			throw new Error("successor adoption failed");
		});

		await expect(session.handoff()).rejects.toThrow("successor adoption failed");

		expect(target).toBeDefined();
		expect(target).not.toBe(predecessor);
		expect(targetClaimed).toBe(true);
		expect(manager.getSessionId()).toBe(predecessor);
		expect(await held(predecessor)).toBe(true);
		expect(await held(target!)).toBe(false);
		expect(claims.sessionIds).toEqual([predecessor]);
	});

	it("handoff rollback after the commit: the target is released and the predecessor kept", async () => {
		const { manager, claims, predecessor, authStorage, session } = await fixture({ agentId: "owner" });
		authStorage.setRuntimeApiKey("anthropic", "test-key");
		manager.appendMessage(user("A-2"));
		await manager.flush();
		vi.spyOn(compactionModule, "generateHandoff").mockResolvedValue("## Goal\nContinue");
		claimPrepared(manager, "prepareNewSession");
		let committed = false;
		let target: string | undefined;
		const commitPreparedNewSession = manager.commitPreparedNewSession.bind(manager);
		vi.spyOn(manager, "commitPreparedNewSession").mockImplementation(prepared => {
			commitPreparedNewSession(prepared);
			committed = true;
			target = manager.getSessionId();
		});
		// Fails after the session transition committed (the job-manager rekey), before handoff
		// marks itself committed, so it still rolls back to the predecessor.
		const forEndpoint = AsyncJobManager.forEndpoint.bind(AsyncJobManager);
		let thrown = false;
		vi.spyOn(AsyncJobManager, "forEndpoint").mockImplementation(endpointId => {
			if (committed && !thrown) {
				thrown = true;
				throw new Error("successor rekey failed");
			}
			return forEndpoint(endpointId);
		});

		await expect(outsideStrictSeam(() => session.handoff())).rejects.toThrow();

		expect(thrown).toBe(true);
		expect(target).toBeDefined();
		expect(target).not.toBe(predecessor);
		expect(manager.getSessionId()).toBe(predecessor);
		expect(await held(predecessor)).toBe(true);
		expect(await held(target!)).toBe(false);
		expect(claims.sessionIds).toEqual([predecessor]);
	});

	it("fork(): the predecessor is released once the fork commits, the fork kept", async () => {
		const { manager, claims, predecessor, session } = await fixture();
		claimPrepared(manager, "prepareFork");

		// prepareFork publishes the fork before this spy can claim it; 4b claims it inside prepare.
		expect(await outsideStrictSeam(() => session.fork())).toBe(true);

		const fork = manager.getSessionId();
		expect(fork).not.toBe(predecessor);
		expect(await held(predecessor)).toBe(false);
		expect(await held(fork)).toBe(true);
		expect(claims.sessionIds).toEqual([fork]);
	});

	it("bounded cold fork(): the manager swap keeps the fork's claim and releases the predecessor's", async () => {
		const { manager, claims, predecessor, session } = await fixture();
		const stats = manager.getSessionMemoryStats.bind(manager);
		vi.spyOn(manager, "getSessionMemoryStats").mockImplementation(() => ({ ...stats(), coldRetirementActive: true }));
		const forkFrom = SessionManager.forkFrom.bind(SessionManager);
		vi.spyOn(SessionManager, "forkFrom").mockImplementation((async (...args: Parameters<typeof forkFrom>) => {
			const forked = await forkFrom(...args);
			sessionClaimSetOf(forked).add(await claim(forked.getSessionId()));
			return forked;
		}) as never);

		// forkFrom publishes the fork before this spy can claim it; 4b claims it inside the factory.
		expect(await outsideStrictSeam(() => session.fork())).toBe(true);

		expect(session.sessionManager).not.toBe(manager);
		const fork = session.sessionManager.getSessionId();
		expect(fork).not.toBe(predecessor);
		expect(await held(predecessor)).toBe(false);
		expect(claims.sessionIds).toEqual([]);
		expect(await held(fork)).toBe(true);
		expect(sessionClaimSetOf(session.sessionManager).sessionIds).toEqual([fork]);
	});
});
