/**
 * Factory claims (single-owner design §2.4, §13 step 1): each persisting factory claims its id
 * before its first write, under the mode it read once; `observe` never refuses; `off` makes no lock
 * call at all. The static and prototype writer inventories cover every factory's write paths; this
 * file pins the rules they cannot see: sync factories, refusal-free outcomes, a fork's legacy
 * source, the successor claim before the artifact copy, and subagent and staged children.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { FileLockAcquireStatus, FileLockProbeState, probeFileLock, tryAcquireFileLock } from "@gajae-code/natives";
import type { Args } from "../../src/cli/args";
import { Settings } from "../../src/config/settings";
import { createSessionManager } from "../../src/main";
import { ManagedSessionDescendantStore } from "../../src/session/internal/managed-session-storage";
import { sessionClaimSetOf } from "../../src/session/internal/session-claim-set";
import { SessionManager, SessionManagerTestHooks } from "../../src/session/session-manager";
import {
	inspectSessionOwners,
	probeSessionOwner,
	resetSessionOwnershipForTests,
	type SessionOwnerLockBackend,
	SessionOwnershipTestHooks,
	sessionOwnerKey,
	sessionOwnershipCounters,
} from "../../src/session/session-ownership";
import { FileSessionStorage } from "../../src/session/session-storage";

const supported = process.platform === "linux" || process.platform === "darwin";
const roots: string[] = [];
const managers: SessionManager[] = [];

beforeEach(() => {
	SessionOwnershipTestHooks.mode = "observe";
});

afterEach(async () => {
	try {
		for (const manager of managers.splice(0)) await manager.close().catch(() => undefined);
		for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
	} finally {
		delete SessionOwnershipTestHooks.mode;
		delete SessionOwnershipTestHooks.lockBackend;
		delete SessionManagerTestHooks.beforeExistingSessionHydration;
		vi.restoreAllMocks();
		resetSessionOwnershipForTests();
	}
});

function user(text: string) {
	return { role: "user" as const, content: text, timestamp: Date.now() };
}

function keep<T extends SessionManager>(manager: T): T {
	managers.push(manager);
	return manager;
}

async function workspace() {
	const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "gjc-factory-claims-")));
	roots.push(root);
	const cwd = path.join(root, "workspace");
	const agentDir = path.join(root, "agent");
	await fs.mkdir(cwd, { recursive: true });
	await fs.mkdir(agentDir, { recursive: true, mode: 0o700 });
	const destination = SessionManager.managedDestination(cwd, agentDir);
	if (destination.kind !== "managed") throw new Error("expected a managed destination");
	return { root, cwd, destination };
}

/** A committed managed session, written in `off` so its own writes claim nothing. */
async function committed(place: Awaited<ReturnType<typeof workspace>>) {
	SessionOwnershipTestHooks.mode = "off";
	const manager = SessionManager.create(place.cwd, place.destination);
	manager.appendMessage(user("question"));
	await manager.ensureOnDisk();
	await manager.flush();
	const file = manager.getSessionFile()!;
	const id = manager.getSessionId();
	await manager.close();
	SessionOwnershipTestHooks.mode = "observe";
	return { file, id };
}

/** The native locks, except that `heldIds` read as held by another process. */
function heldElsewhere(...heldIds: string[]): SessionOwnerLockBackend {
	const held = (sidecar: string) => heldIds.some(id => path.basename(sidecar).startsWith(`${sessionOwnerKey(id)}.`));
	return {
		tryAcquire: (sidecar, timeoutMs) =>
			held(sidecar)
				? Promise.resolve({ status: FileLockAcquireStatus.Held })
				: tryAcquireFileLock(sidecar, timeoutMs),
		probe: (sidecar, timeoutMs) =>
			held(sidecar) ? Promise.resolve({ state: FileLockProbeState.Held }) : probeFileLock(sidecar, timeoutMs),
	};
}

async function state(sessionId: string): Promise<string> {
	return (await probeSessionOwner(sessionId)).state;
}

describe.if(supported)("factory claims", () => {
	it("create claims its fresh id in the background, a write in the same tick is covered, close releases", async () => {
		const place = await workspace();
		const manager = keep(SessionManager.create(place.cwd, place.destination));
		manager.appendMessage(user("same tick"));
		await manager.ensureOnDisk();
		expect(await sessionClaimSetOf(manager).settled()).toBe("claimed");
		expect(sessionOwnershipCounters().session_write_without_claim).toBe(0);
		const owners = await inspectSessionOwners();
		expect(owners.held.map(sidecar => [sidecar.sessionId, sidecar.self])).toEqual([[manager.getSessionId(), true]]);
		await manager.close();
		expect(await state(manager.getSessionId())).toBe("free");
	});

	for (const mode of ["observe", "enforce"] as const) {
		it(`${mode}: a session held elsewhere, or a lock failure enforce would refuse, opens without a claim and is counted`, async () => {
			const place = await workspace();
			const { file, id } = await committed(place);
			SessionOwnershipTestHooks.mode = mode;
			SessionOwnershipTestHooks.lockBackend = heldElsewhere(id);
			const held = keep(await SessionManager.open(file, place.destination));
			// The gate where enforce will refuse (5a) can tell the outcomes apart.
			expect([
				held.getSessionId(),
				sessionClaimSetOf(held).has(id),
				await sessionClaimSetOf(held).settled(),
			]).toEqual([id, false, "held"]);
			expect(sessionOwnershipCounters().claim_conflict).toBeGreaterThan(0);
			await held.close();

			SessionOwnershipTestHooks.lockBackend = {
				tryAcquire: async () => ({ status: FileLockAcquireStatus.Failed, code: "EACCES" }),
				probe: async () => ({ state: FileLockProbeState.Free }),
			};
			const failed = keep(await SessionManager.open(file, place.destination));
			expect([
				failed.getSessionId(),
				sessionClaimSetOf(failed).has(id),
				await sessionClaimSetOf(failed).settled(),
			]).toEqual([id, false, "failed"]);
			expect(sessionOwnershipCounters().claim_failed).toBeGreaterThan(0);
		});
	}

	it("gjc acp keeps an in-memory manager: autoResume never opens, or contends for, the cwd's newest session", async () => {
		const place = await workspace();
		const settings = Settings.isolated({ autoResume: true });
		const destination = SessionManager.managedDestination(place.cwd, settings.getAgentDir());
		if (destination.kind !== "managed") throw new Error("expected a managed destination");
		const { id } = await committed({ ...place, destination });
		SessionOwnershipTestHooks.lockBackend = heldElsewhere(id);
		const acp = keep((await createSessionManager({ mode: "acp" } as Args, place.cwd, settings))!);
		expect([acp.getSessionId() === id, acp.isPersisted(), sessionClaimSetOf(acp).sessionIds]).toEqual([
			false,
			false,
			[],
		]);
		expect(sessionOwnershipCounters().claim_conflict).toBe(0);
		expect((await inspectSessionOwners()).held).toEqual([]);
	});

	it("off: no factory or prepare makes a lock call", async () => {
		const place = await workspace();
		const { file } = await committed(place);
		SessionOwnershipTestHooks.mode = "off";
		const calls: string[] = [];
		SessionOwnershipTestHooks.lockBackend = {
			tryAcquire: async sidecar => {
				calls.push(sidecar);
				return { status: FileLockAcquireStatus.Held };
			},
			probe: async sidecar => {
				calls.push(sidecar);
				return { state: FileLockProbeState.Held };
			},
		};
		const opened = keep(await SessionManager.open(file, place.destination));
		await opened.prepareFork();
		keep(await SessionManager.forkFrom(file, place.cwd, place.destination));
		keep(await SessionManager.continueRecent(place.cwd, place.destination));
		keep(SessionManager.create(place.cwd, place.destination));
		expect(calls).toEqual([]);
	});

	it("prepareFork claims the successor after freezing its id and before copying artifacts", async () => {
		const place = await workspace();
		const { file } = await committed(place);
		const manager = keep(await SessionManager.open(file, place.destination));
		const claims = sessionClaimSetOf(manager);
		const copy = manager.copyArtifactsForFork.bind(manager);
		const claimedAtCopy: boolean[] = [];
		vi.spyOn(manager, "copyArtifactsForFork").mockImplementation(async (source, target) => {
			// The successor's id is in its transcript name; compare ids, not only order.
			const successor = path
				.basename(target)
				.replace(/\.jsonl$/, "")
				.split("_")
				.at(-1)!;
			claimedAtCopy.push(claims.has(successor) && successor !== manager.getSessionId());
			return copy(source, target);
		});
		const prepared = await manager.prepareFork();
		expect(claimedAtCopy).toEqual([true]);
		expect(await state(prepared!.sessionId)).toBe("held");
	});

	describe("a fork's legacy-directory source", () => {
		async function legacySource() {
			const place = await workspace();
			const { file, id } = await committed(place);
			const encoded = path
				.resolve(place.cwd)
				.replace(/^[/\\]/, "")
				.replace(/[/\\:]/g, "-");
			const legacyDir = path.join(place.destination.securityContext.sessionsRoot, `--${encoded}--`);
			await fs.mkdir(legacyDir, { recursive: true, mode: 0o700 });
			const legacy = path.join(legacyDir, path.basename(file));
			await fs.rename(file, legacy);
			return { place, legacy, id };
		}

		async function migratedCopies(directory: string, id: string): Promise<number> {
			const names = await fs.readdir(directory);
			return names.filter(name => name.endsWith(`${id}.jsonl`)).length;
		}

		it("free: migrates under a scoped claim, released once the fork holds its own id", async () => {
			const { place, legacy, id } = await legacySource();
			const fork = keep(await SessionManager.forkFrom(legacy, place.cwd, place.destination));
			expect(await migratedCopies(place.destination.directory, id)).toBe(1);
			expect([await state(id), await state(fork.getSessionId())]).toEqual(["free", "held"]);
		});

		it("a source whose id no sidecar can name still forks in observe", async () => {
			const { place, legacy } = await legacySource();
			const lines = (await fs.readFile(legacy, "utf8")).split("\n");
			lines[0] = JSON.stringify({ ...JSON.parse(lines[0]!), id: "" });
			await fs.writeFile(legacy, lines.join("\n"));
			const fork = keep(await SessionManager.forkFrom(legacy, place.cwd, place.destination));
			expect(sessionClaimSetOf(fork).has(fork.getSessionId())).toBe(true);
		});

		it("held elsewhere: is read in place, never migrated, never contended", async () => {
			const { place, legacy, id } = await legacySource();
			SessionOwnershipTestHooks.lockBackend = heldElsewhere(id);
			const fork = keep(await SessionManager.forkFrom(legacy, place.cwd, place.destination));
			expect(await migratedCopies(place.destination.directory, id)).toBe(0);
			expect(fork.getHeader()?.parentSession).toBe(id);
			expect(sessionOwnershipCounters().claim_conflict).toBe(0);
			expect(sessionClaimSetOf(fork).has(fork.getSessionId())).toBe(true);
		});
	});

	it("children are exempt for now (design §13 L2): a nested or staged child claims nothing, before or after commit", async () => {
		const place = await workspace();
		const parent = new ManagedSessionDescendantStore(
			place.destination.securityContext.rootAuthority,
			place.destination.directory,
			undefined,
			undefined,
			place.destination.securityContext.profileAgentDir,
		);
		const store = parent.deriveSubtree("child");
		const destination = SessionManager.nestedManagedDestination(store, store.dir);
		const nested = keep(
			await SessionManager.openNestedManaged(path.join(store.dir, "task.jsonl"), destination, store),
		);
		const staged = keep(
			await SessionManager.stagedNestedManaged(path.join(store.dir, "staged.jsonl"), destination, store),
		);
		staged.appendMessage(user("staged"));
		await staged.flush();
		await staged.commitStaged();
		nested.appendMessage(user("nested"));
		await nested.flush();
		expect((await inspectSessionOwners()).held).toEqual([]);
		expect(sessionOwnershipCounters().session_write_without_claim).toBe(0);
	});

	it("a background claim that lands after the manager rotated away is released at once", async () => {
		const place = await workspace();
		// Hold back the first claim until the rotation has settled.
		const gate = Promise.withResolvers<void>();
		let calls = 0;
		SessionOwnershipTestHooks.lockBackend = {
			tryAcquire: async (sidecar, timeoutMs) => {
				// The first acquire is create's background claim.
				if (calls++ === 0) await gate.promise;
				return tryAcquireFileLock(sidecar, timeoutMs);
			},
			probe: (sidecar, timeoutMs) => probeFileLock(sidecar, timeoutMs),
		};
		const manager = keep(SessionManager.create(place.cwd, place.destination));
		const first = manager.getSessionId();
		await manager.newSession();
		gate.resolve();
		await sessionClaimSetOf(manager).settled();
		await Bun.sleep(0);
		expect([await state(first), sessionClaimSetOf(manager).sessionIds]).toEqual(["free", [manager.getSessionId()]]);
	});
	it("setSessionFile (the /resume switch) claims an existing or a fresh target; a held target still switches, counted", async () => {
		const place = await workspace();
		const a = await committed(place);
		const b = await committed(place);
		const c = await committed(place);
		const manager = keep(await SessionManager.open(a.file, place.destination));
		await manager.setSessionFile(b.file);
		expect([await state(a.id), await state(b.id), sessionClaimSetOf(manager).sessionIds]).toEqual([
			"free",
			"held",
			[b.id],
		]);
		await manager.setSessionFile(path.join(path.dirname(a.file), "2026-01-01T00-00-00-000Z_fresh.jsonl"));
		expect([await state(b.id), sessionClaimSetOf(manager).sessionIds]).toEqual(["free", [manager.getSessionId()]]);
		expect(await state(manager.getSessionId())).toBe("held");
		// Observe never refuses: a target held elsewhere is switched to, without a claim, and counted.
		SessionOwnershipTestHooks.lockBackend = heldElsewhere(c.id);
		await manager.setSessionFile(c.file);
		expect([manager.getSessionId(), sessionClaimSetOf(manager).sessionIds]).toEqual([c.id, []]);
		expect(sessionOwnershipCounters().claim_conflict).toBe(1);
	});

	it("a failed open, or a strict open that returns early, keeps no claim", async () => {
		const place = await workspace();
		const { file, id } = await committed(place);
		SessionManagerTestHooks.beforeExistingSessionHydration = () => {
			throw new Error("hydration failed");
		};
		await expect(SessionManager.open(file, place.destination)).rejects.toThrow("hydration failed");
		await expect(SessionManager.open(file, SessionManager.explicitDestination(path.dirname(file)))).rejects.toThrow(
			"hydration failed",
		);
		expect(await state(id)).toBe("free");
		delete SessionManagerTestHooks.beforeExistingSessionHydration;
		const capture = SessionManager.captureTranscriptStrict(file);
		if (capture.kind !== "captured") throw new Error(`capture failed: ${capture.reason}`);
		const stale = { ...capture.snapshot.identity, sha256: "0".repeat(64) };
		capture.snapshot.close();
		expect((await SessionManager.openExistingStrict(stale, place.destination)).kind).toBe("error");
		expect(await state(id)).toBe("free");

		// A missing path creates a fresh session, claimed before its header write, which fails here.
		const missing = path.join(place.root, "missing.jsonl");
		const taken = sessionOwnershipCounters().claim_taken;
		const write = vi.spyOn(FileSessionStorage.prototype, "openWriter").mockImplementation(() => {
			throw new Error("disk full");
		});
		await expect(SessionManager.open(missing, SessionManager.explicitDestination(place.root))).rejects.toThrow(
			"disk full",
		);
		write.mockRestore();
		expect(sessionOwnershipCounters().claim_taken).toBe(taken + 1);
		expect((await inspectSessionOwners()).held).toEqual([]);
	});
});
