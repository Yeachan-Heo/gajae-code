/**
 * The per-manager claim set and the release table of the single-owner design (§2.5), driven through
 * real SessionManager rotations and real claims in the test preload's isolated home.
 */
import { afterEach, describe, expect, it } from "bun:test";
import * as fsSync from "node:fs";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { sessionClaimSetOf } from "../../src/session/internal/session-claim-set";
import { type SessionDestination, SessionManager } from "../../src/session/session-manager";
import {
	claimSessionOwner,
	probeSessionOwner,
	resetSessionOwnershipForTests,
	type SessionOwnerClaim,
	SessionOwnershipTestHooks,
	sessionOwnersDirectory,
	sessionOwnershipCounters,
} from "../../src/session/session-ownership";
import {
	FileSessionStorage,
	type SessionStorageWriter,
	type SessionStorageWriterOpenOptions,
	SessionStorageWriterRetryableCloseError,
} from "../../src/session/session-storage";

const supported = process.platform === "linux" || process.platform === "darwin";
const roots: string[] = [];
const managers: SessionManager[] = [];

afterEach(async () => {
	try {
		for (const manager of managers.splice(0)) await manager.close().catch(() => undefined);
		for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
	} finally {
		// Throws when a claim leaked, so a missed release fails the test that leaked it.
		resetSessionOwnershipForTests();
	}
});

function user(text: string) {
	return { role: "user" as const, content: text, timestamp: Date.now() };
}

async function workspace(kind: "managed" | "explicit" = "managed") {
	const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "gjc-claim-set-")));
	roots.push(root);
	const cwd = path.join(root, "workspace");
	const agentDir = path.join(root, "agent");
	await fs.mkdir(cwd, { recursive: true });
	await fs.mkdir(agentDir, { recursive: true, mode: 0o700 });
	const destination: SessionDestination =
		kind === "managed"
			? SessionManager.managedDestination(cwd, agentDir)
			: SessionManager.explicitDestination(path.join(root, "sessions"));
	return { root, cwd, destination };
}

async function persisted(
	kind: "managed" | "explicit" = "managed",
	place?: { root: string; cwd: string; destination: SessionDestination },
) {
	const { root, cwd, destination } = place ?? (await workspace(kind));
	const manager = SessionManager.create(cwd, destination);
	managers.push(manager);
	manager.appendMessage(user("first"));
	manager.appendMessage(user("second"));
	await manager.ensureOnDisk();
	await manager.flush();
	return { root, cwd, destination, manager, claims: sessionClaimSetOf(manager) };
}

async function claim(sessionId: string): Promise<SessionOwnerClaim> {
	const result = await claimSessionOwner(sessionId, { surface: "terminal" });
	if (result.status !== "claimed") throw new Error(`expected a claim of ${sessionId}, got ${result.status}`);
	return result.claim;
}

async function held(sessionId: string): Promise<boolean> {
	return (await probeSessionOwner(sessionId)).state === "held";
}

describe.if(supported)("the claim set's release table (design §2.5)", () => {
	it("keeps a factory's claim until close() completes", async () => {
		const { manager, claims } = await persisted();
		const id = manager.getSessionId();
		const handed = await claim(id);
		claims.add(handed);
		expect(claims.has(id)).toBe(true);
		manager.appendMessage(user("third"));
		await manager.flush();
		expect(await held(id)).toBe(true);
		await manager.close();
		expect(handed.released).toBe(true);
		expect(await held(id)).toBe(false);
	});

	it("rotation: the target is claimed first, the predecessor is released only after the rotation commits", async () => {
		const { manager, claims } = await persisted();
		const predecessor = manager.getSessionId();
		claims.add(await claim(predecessor));
		const prepared = await manager.prepareNewSession();
		claims.add(await claim(prepared.sessionId));
		{
			// An enclosing transition (an AgentSession switch) is not committed until it ends.
			using _outer = claims.transition();
			manager.commitPreparedNewSession(prepared);
			expect(manager.getSessionId()).toBe(prepared.sessionId);
			expect(await held(predecessor)).toBe(true);
		}
		expect(await held(predecessor)).toBe(false);
		expect(await held(prepared.sessionId)).toBe(true);
		expect(claims.sessionIds).toEqual([prepared.sessionId]);

		// Without an enclosing transition, the rotating SessionManager call is the commit.
		const next = await manager.prepareNewSession();
		claims.add(await claim(next.sessionId));
		manager.commitPreparedNewSession(next);
		expect(await held(prepared.sessionId)).toBe(false);
		expect(claims.sessionIds).toEqual([next.sessionId]);
	});

	it("hook cancel: a target claimed for the transition is released, the predecessor kept", async () => {
		const { manager, claims } = await persisted();
		const current = manager.getSessionId();
		claims.add(await claim(current));
		{
			using _transition = claims.transition();
			claims.add(await claim("cancelled-target"));
			// session_before_switch returned cancel: no rotation happens.
		}
		expect(await held("cancelled-target")).toBe(false);
		expect(await held(current)).toBe(true);
		expect(claims.sessionIds).toEqual([current]);
	});

	it("rollback of a failed switch: the target is released, the predecessor kept", async () => {
		const other = await persisted();
		const otherFile = other.manager.getSessionFile()!;
		const otherId = other.manager.getSessionId();
		await other.manager.close();
		const { manager, claims } = await persisted("managed", other);
		const current = manager.getSessionId();
		claims.add(await claim(current));
		const snapshot = manager.captureState();
		{
			using _switch = claims.transition();
			claims.add(await claim(otherId));
			await manager.setSessionFile(otherFile);
			expect(manager.getSessionId()).toBe(otherId);
			await manager.restoreRollbackState(snapshot);
		}
		expect(manager.getSessionId()).toBe(current);
		expect(await held(otherId)).toBe(false);
		expect(await held(current)).toBe(true);
	});

	it("two files carrying one copied id: one claim per id, kept across the switch", async () => {
		const { manager, claims, root } = await persisted("explicit");
		const id = manager.getSessionId();
		const copy = path.join(root, "copy.jsonl");
		await fs.copyFile(manager.getSessionFile()!, copy);
		claims.add(await claim(id));
		const duplicate = await claim(id);
		expect(duplicate.shared).toBe(true);
		claims.add(duplicate);
		expect(duplicate.released).toBe(true);
		await manager.setSessionFile(copy);
		expect(manager.getSessionId()).toBe(id);
		expect(await held(id)).toBe(true);
		await manager.close();
		expect(await held(id)).toBe(false);
	});

	it("cold-sidecar manager swap: the claims move, and the old manager's close unlocks nothing", async () => {
		const previous = await persisted();
		const id = previous.manager.getSessionId();
		previous.claims.add(await claim(id));
		const successor = await persisted();
		previous.claims.moveTo(successor.claims);
		expect(previous.claims.sessionIds).toEqual([]);
		await previous.manager.close();
		expect(await held(id)).toBe(true);
		expect(successor.claims.has(id)).toBe(true);
		await successor.manager.close();
		expect(await held(id)).toBe(false);
	});

	it("deferred owner shutdown: the predecessor waits for finalization, at most the cap", async () => {
		const { manager, claims } = await persisted();
		const predecessor = manager.getSessionId();
		claims.add(await claim(predecessor));
		const finalization = Promise.withResolvers<void>();
		claims.holdUntil(predecessor, finalization.promise);
		const successor = await manager.prepareNewSession();
		claims.add(await claim(successor.sessionId));
		manager.commitPreparedNewSession(successor);
		expect(await held(predecessor)).toBe(true);
		finalization.resolve();
		await finalization.promise;
		expect(await held(predecessor)).toBe(false);
		expect(sessionOwnershipCounters().release_after_deferred_timeout).toBe(0);

		// A finalization that never settles holds only until the cap, and is counted.
		claims.holdUntil(successor.sessionId, new Promise<void>(() => {}), 20);
		const third = await manager.prepareNewSession();
		claims.add(await claim(third.sessionId));
		manager.commitPreparedNewSession(third);
		expect(await held(successor.sessionId)).toBe(true);
		await Bun.sleep(80);
		expect(await held(successor.sessionId)).toBe(false);
		expect(sessionOwnershipCounters().release_after_deferred_timeout).toBe(1);
	});

	it("close() during a deferred hold releases the held claim when the hold ends", async () => {
		const { manager, claims } = await persisted();
		const id = manager.getSessionId();
		claims.add(await claim(id));
		const finalization = Promise.withResolvers<void>();
		claims.holdUntil(id, finalization.promise);
		await manager.close();
		expect(await held(id)).toBe(true);
		finalization.resolve();
		await finalization.promise;
		expect(await held(id)).toBe(false);
	});
});

type CloseFault = "none" | "retryable_once" | "unknown";

/** Real file storage whose persist-writer close fails in a chosen, certified way. */
class CloseFaultStorage extends FileSessionStorage {
	fault: CloseFault = "none";

	override openWriter(file: string, options?: SessionStorageWriterOpenOptions): SessionStorageWriter {
		return super.openWriter(file, {
			...options,
			closeAdapter: {
				close: fd => {
					if (this.fault === "retryable_once") {
						this.fault = "none";
						throw new SessionStorageWriterRetryableCloseError();
					}
					fsSync.closeSync(fd);
					if (this.fault === "unknown") throw new Error("close outcome unknown");
				},
			},
		});
	}
}

async function explicitWithFault(fault: CloseFault) {
	const { root, cwd } = await workspace("explicit");
	const storage = new CloseFaultStorage();
	const manager = SessionManager.create(cwd, SessionManager.explicitDestination(path.join(root, "sessions")), storage);
	managers.push(manager);
	manager.appendMessage(user("first"));
	await manager.ensureOnDisk();
	// An append opens the persist writer whose close the fault targets.
	manager.appendMessage(user("second"));
	await manager.flush();
	const id = manager.getSessionId();
	sessionClaimSetOf(manager).add(await claim(id));
	storage.fault = fault;
	return { manager, id };
}

describe.if(supported)("the claim set on every close path", () => {
	for (const method of ["closeStrict", "flushAndCloseStrict"] as const) {
		it(`${method}: closed and close_unknown release the claims`, async () => {
			const closed = await explicitWithFault("none");
			expect((await closed.manager[method]()).kind).toBe("closed");
			expect(await held(closed.id)).toBe(false);
			const unknown = await explicitWithFault("unknown");
			expect((await unknown.manager[method]()).kind).toBe("close_unknown");
			expect(await held(unknown.id)).toBe(false);
		});

		it(`${method}: close_failed_retryable keeps the claims until the retry closes`, async () => {
			const { manager, id } = await explicitWithFault("retryable_once");
			expect((await manager[method]()).kind).toBe("close_failed_retryable");
			expect(await held(id)).toBe(true);
			expect((await manager[method]()).kind).toBe("closed");
			expect(await held(id)).toBe(false);
		});
	}

	it("close(): a failed close keeps the claims, and the retry that completes releases them", async () => {
		const { manager, id } = await explicitWithFault("retryable_once");
		await expect(manager.close()).rejects.toThrow();
		expect(await held(id)).toBe(true);
		await manager.close();
		expect(await held(id)).toBe(false);
	});
});

describe("the identity helper", () => {
	it("every session-id change reaches the claim set", async () => {
		const checks: string[] = [];
		const check = (manager: SessionManager, step: string) => {
			expect([step, sessionClaimSetOf(manager).currentSessionId]).toEqual([step, manager.getSessionId()]);
			checks.push(step);
		};
		for (const kind of ["managed", "explicit"] as const) {
			const { manager, destination, cwd } = await persisted(kind);
			check(manager, `${kind}: create`);
			const first = manager.getSessionFile()!;
			const leaf = manager.getLeafId()!;
			const firstState = manager.captureState();
			await manager.newSession();
			check(manager, `${kind}: newSession`);
			manager.appendMessage(user("on the new session"));
			await manager.flush();
			await manager.setSessionFile(first);
			check(manager, `${kind}: setSessionFile`);
			manager.restoreState(firstState);
			check(manager, `${kind}: restoreState`);
			const restored = manager.captureState();
			await manager.newSession();
			await manager.restoreRollbackState(restored);
			check(manager, `${kind}: restoreRollbackState`);
			await manager.fork();
			check(manager, `${kind}: fork`);
			await manager.setSessionFile(first);
			manager.createBranchedSession(leaf);
			check(manager, `${kind}: createBranchedSession`);
			const reopened = await SessionManager.open(first, destination);
			managers.push(reopened);
			check(reopened, `${kind}: open`);
			const forked = await SessionManager.forkFrom(first, cwd, destination);
			managers.push(forked);
			check(forked, `${kind}: forkFrom`);
		}
		// A missing explicit path is created as a new session.
		const { root, destination } = await workspace("explicit");
		const created = await SessionManager.open(path.join(root, "sessions", "missing.jsonl"), destination);
		managers.push(created);
		check(created, "explicit: open of a missing path");
		const memory = SessionManager.inMemory(root);
		managers.push(memory);
		memory.appendMessage(user("in memory"));
		memory.createBranchedSession(memory.getLeafId()!);
		check(memory, "in memory: createBranchedSession");
		expect(checks).toHaveLength(20);
	});
});

describe("with ownership off (the default)", () => {
	it("a full session lifecycle makes no claim, no lock call and no owners directory", async () => {
		const home = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "gjc-claim-set-off-")));
		roots.push(home);
		const preloadHome = SessionOwnershipTestHooks.homeOverride;
		const lockCalls: string[] = [];
		SessionOwnershipTestHooks.homeOverride = home;
		SessionOwnershipTestHooks.lockBackend = {
			tryAcquire: async sidecar => {
				lockCalls.push(`acquire ${sidecar}`);
				throw new Error("no lock call in off");
			},
			probe: async sidecar => {
				lockCalls.push(`probe ${sidecar}`);
				throw new Error("no lock call in off");
			},
		};
		try {
			for (const kind of ["managed", "explicit"] as const) {
				const { manager, destination, cwd } = await persisted(kind);
				const first = manager.getSessionFile()!;
				const leaf = manager.getLeafId()!;
				await manager.newSession();
				manager.appendMessage(user("new"));
				await manager.flush();
				await manager.setSessionFile(first);
				await manager.fork();
				await manager.setSessionFile(first);
				manager.createBranchedSession(leaf);
				const reopened = await SessionManager.open(first, destination);
				const forked = await SessionManager.forkFrom(first, cwd, destination);
				for (const each of [manager, reopened, forked]) {
					expect(sessionClaimSetOf(each).sessionIds).toEqual([]);
					await each.close();
				}
			}
			expect(lockCalls).toEqual([]);
			expect(await Bun.file(sessionOwnersDirectory()).exists()).toBe(false);
			expect(await fs.readdir(home)).toEqual([]);
			expect(sessionOwnershipCounters()).toEqual({
				release_after_deferred_timeout: 0,
				session_write_without_claim: 0,
			});
		} finally {
			SessionOwnershipTestHooks.homeOverride = preloadHome;
			delete SessionOwnershipTestHooks.lockBackend;
		}
	});
});
