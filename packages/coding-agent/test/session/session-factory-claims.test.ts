/**
 * Factory claims (single-owner design §2.4, §13 step 1): each persisting factory claims its id
 * before its first write, under the mode it read once; `observe` never refuses; `off` makes no lock
 * call at all. The static and prototype writer inventories cover every factory's write paths; this
 * file pins the rules they cannot see: sync factories, refusal-free outcomes, a fork's legacy
 * source, the successor claim before the artifact copy, and subagent and staged children.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { FileLockAcquireStatus, FileLockProbeState, probeFileLock, tryAcquireFileLock } from "@gajae-code/natives";
import { Container, getTerminalId, TUI } from "@gajae-code/tui";
import { getAgentDir, getTerminalSessionsDir } from "@gajae-code/utils";
import type { Subprocess } from "bun";
import { VirtualTerminal } from "../../../tui/test/virtual-terminal";
import type { Args } from "../../src/cli/args";
import { deleteSessionPickerCandidate } from "../../src/cli/session-picker";
import { resetSettingsForTest, Settings } from "../../src/config/settings";
import { createSessionManager, operatorFacingSessionOpenMessage, SessionResumeCancelledError } from "../../src/main";
import { type HeldSessionChoice, heldSessionWarningDialog } from "../../src/modes/components/session-held-warning";
import { SelectorController } from "../../src/modes/controllers/selector-controller";
import { initTheme } from "../../src/modes/theme/theme";
import type { InteractiveModeContext } from "../../src/modes/types";
import { createAgentSession, probeSessionOwners } from "../../src/sdk";
import { ManagedSessionDescendantStore } from "../../src/session/internal/managed-session-storage";
import { probeHeldSessions, sessionClaimSetOf } from "../../src/session/internal/session-claim-set";
import { SessionManager, SessionManagerTestHooks } from "../../src/session/session-manager";
import {
	inspectSessionOwners,
	probeSessionOwner,
	resetSessionOwnershipForTests,
	SessionHeldError,
	type SessionOwnerLockBackend,
	SessionOwnershipError,
	SessionOwnershipTestHooks,
	sessionOwnerKey,
	sessionOwnershipCounters,
} from "../../src/session/session-ownership";
import { liveSessionOwnershipMode, sessionOwnershipMode } from "../../src/session/session-ownership-mode";
import { FileSessionStorage } from "../../src/session/session-storage";

const supported = process.platform === "linux" || process.platform === "darwin";
const roots: string[] = [];
const managers: SessionManager[] = [];

beforeAll(() => initTheme());

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

/** The native locks, except that claims of `failedIds` fail as an owners-directory lock error would. */
function failingFor(...failedIds: string[]): SessionOwnerLockBackend {
	const failed = (sidecar: string) =>
		failedIds.some(id => path.basename(sidecar).startsWith(`${sessionOwnerKey(id)}.`));
	return {
		tryAcquire: (sidecar, timeoutMs) =>
			failed(sidecar)
				? Promise.resolve({ status: FileLockAcquireStatus.Failed, code: "EACCES" })
				: tryAcquireFileLock(sidecar, timeoutMs),
		probe: (sidecar, timeoutMs) =>
			failed(sidecar) ? Promise.resolve({ state: FileLockProbeState.Free }) : probeFileLock(sidecar, timeoutMs),
	};
}

/** Every claim fails as an owners-directory lock error would; probes see nothing held. */
function failingForEveryId(): SessionOwnerLockBackend {
	return {
		tryAcquire: async () => ({ status: FileLockAcquireStatus.Failed, code: "EACCES" }),
		probe: async () => ({ state: FileLockProbeState.Free }),
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

	it("observe: a session held elsewhere, or a lock failure enforce would refuse, opens without a claim and is counted", async () => {
		const place = await workspace();
		const { file, id } = await committed(place);
		SessionOwnershipTestHooks.lockBackend = heldElsewhere(id);
		const held = keep(await SessionManager.open(file, place.destination));
		// The refusal gate can tell the outcomes apart; only enforce refuses them.
		expect([held.getSessionId(), sessionClaimSetOf(held).has(id), await sessionClaimSetOf(held).settled()]).toEqual([
			id,
			false,
			"held",
		]);
		expect(sessionOwnershipCounters().claim_conflict).toBeGreaterThan(0);
		await held.close();

		SessionOwnershipTestHooks.lockBackend = failingFor(id);
		const failed = keep(await SessionManager.open(file, place.destination));
		expect([
			failed.getSessionId(),
			sessionClaimSetOf(failed).has(id),
			await sessionClaimSetOf(failed).settled(),
		]).toEqual([id, false, "failed"]);
		expect(sessionOwnershipCounters().claim_failed).toBeGreaterThan(0);
	});

	it("gjc acp keeps an in-memory manager: autoResume never opens, or contends for, the cwd's newest session", async () => {
		const place = await workspace();
		const settings = Settings.isolated({ autoResume: true });
		const destination = SessionManager.managedDestination(place.cwd, settings.getAgentDir());
		if (destination.kind !== "managed") throw new Error("expected a managed destination");
		const { id } = await committed({ ...place, destination });
		SessionOwnershipTestHooks.lockBackend = heldElsewhere(id);
		const args = { mode: "acp" } as Args;
		const acp = keep((await createSessionManager(args, place.cwd, settings))!);
		expect([acp.getSessionId() === id, acp.isPersisted(), sessionClaimSetOf(acp).sessionIds]).toEqual([
			false,
			false,
			[],
		]);
		// A resumed history marked the launch `--continue`, which the ACP option check refuses at startup.
		expect(args.continue).toBeUndefined();
		expect(sessionOwnershipCounters().claim_conflict).toBe(0);
		expect((await inspectSessionOwners()).held).toEqual([]);
	});

	it("gjc acp with autoResume off (the default) creates no persisting session and claims no fresh id", async () => {
		const place = await workspace();
		const acp = keep(
			(await createSessionManager({ mode: "acp" } as Args, place.cwd, Settings.isolated({ autoResume: false })))!,
		);
		expect([acp.isPersisted(), await sessionClaimSetOf(acp).settled()]).toEqual([false, undefined]);
		expect(sessionOwnershipCounters().claim_taken).toBe(0);
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
		try {
			await expect(SessionManager.open(missing, SessionManager.explicitDestination(place.root))).rejects.toThrow(
				"disk full",
			);
		} finally {
			write.mockRestore();
		}
		expect(sessionOwnershipCounters().claim_taken).toBe(taken + 1);
		expect((await inspectSessionOwners()).held).toEqual([]);
	});
});

const holderScript = path.join(import.meta.dir, "session-ownership-holder-child.ts");
const holders: Subprocess<"pipe", "pipe", "pipe">[] = [];

afterEach(async () => {
	for (const child of holders.splice(0)) {
		child.kill("SIGKILL");
		await child.exited;
	}
});

/** Another process, with HOME at the test's owners home, that holds `sessionId`; returns its pid. */
async function holdInAnotherProcess(sessionId: string): Promise<number> {
	const home = SessionOwnershipTestHooks.homeOverride;
	if (!home) throw new Error("the test preload sets the owners home");
	const env: Record<string, string | undefined> = {
		...process.env,
		HOME: home,
		OWNER_SESSION_ID: sessionId,
		OWNER_SURFACE: "terminal",
	};
	for (const key of Object.keys(env))
		if (key.startsWith("XDG_") || /^(GJC|PI)_(CONFIG|CODING_AGENT)_DIR$/.test(key)) delete env[key];
	const child = Bun.spawn([process.execPath, holderScript], {
		cwd: import.meta.dir,
		env,
		stdin: "pipe",
		stdout: "pipe",
		stderr: "pipe",
	});
	holders.push(child);
	const reader = child.stdout.getReader();
	let text = "";
	while (!text.includes("\n")) {
		const { value, done } = await reader.read();
		if (done) throw new Error(`holder exited early: ${await new Response(child.stderr).text()}`);
		text += new TextDecoder().decode(value);
	}
	reader.releaseLock();
	const ready = JSON.parse(text.slice(0, text.indexOf("\n"))) as { status: string; pid: number };
	if (ready.status !== "claimed") throw new Error(`holder did not claim: ${ready.status}`);
	return ready.pid;
}

/** Every file under `root`, with its bytes' hash and mtime: equal snapshots mean nothing was written. */
async function tree(root: string): Promise<string[]> {
	const names = (await fs.readdir(root, { recursive: true })).sort();
	return Promise.all(
		names.map(async name => {
			const stat = await fs.lstat(path.join(root, name));
			const bytes = stat.isFile() ? Bun.hash(await fs.readFile(path.join(root, name))).toString() : "dir";
			return `${name} ${bytes} ${stat.mtimeMs}`;
		}),
	);
}

// `committed()` leaves the mode at `observe`, so each test sets `enforce` after it.
describe.if(supported)("enforce refusals (5a)", () => {
	it("a session another process holds is refused, naming the holder, before the open writes anything", async () => {
		const place = await workspace();
		const { file, id } = await committed(place);
		SessionOwnershipTestHooks.mode = "enforce";
		const pid = await holdInAnotherProcess(id);
		const before = await tree(place.root);
		const holder = { surface: "terminal" as const, pid };
		await expect(SessionManager.open(file, place.destination)).rejects.toMatchObject({
			code: "session_held",
			holder,
		});
		const capture = SessionManager.captureTranscriptStrict(file);
		if (capture.kind !== "captured") throw new Error(`capture failed: ${capture.reason}`);
		const identity = capture.snapshot.identity;
		capture.snapshot.close();
		await expect(SessionManager.openExistingStrict(identity, place.destination)).rejects.toBeInstanceOf(
			SessionHeldError,
		);
		// A large transcript opens bounded, which builds session-memory sidecars before the manager's
		// own claim: the refusal comes before them.
		SessionManagerTestHooks.eagerHydrationMaxBytesOverride = 64;
		try {
			await expect(
				SessionManager.open(file, place.destination, undefined, undefined, "enabled"),
			).rejects.toBeInstanceOf(SessionHeldError);
		} finally {
			delete SessionManagerTestHooks.eagerHydrationMaxBytesOverride;
		}
		expect(await tree(place.root)).toEqual(before);
		expect((await inspectSessionOwners()).held.filter(sidecar => sidecar.self)).toEqual([]);
		expect(operatorFacingSessionOpenMessage(new SessionHeldError(id, holder), { print: true })).toBe(
			`error: session ${id.slice(0, 8)} is open for writing in another terminal (pid ${pid}).\nOnly one process can write a session at a time. Close it there, or continue in a copy:\n  gjc -p --fork ${id} "<message>"`,
		);
		// A standalone rotation onto the held session is refused before it changes anything (design §1
		// row 9): the manager stays on its own session.
		const rotated = keep(SessionManager.create(place.cwd, place.destination));
		const own = rotated.getSessionId();
		await expect(rotated.setSessionFile(file)).rejects.toMatchObject({ code: "session_held", holder });
		expect(rotated.getSessionId()).toBe(own);
		// The SDK factory's gate: a manager whose rotation reached the held session while the live mode
		// was lowered is refused before createAgentSession's first write once enforce is back.
		SessionOwnershipTestHooks.mode = "observe";
		await rotated.setSessionFile(file);
		SessionOwnershipTestHooks.mode = "enforce";
		await expect(createAgentSession({ sessionManager: rotated })).rejects.toMatchObject({ code: "session_held" });
	});

	it("a switch onto a held target is refused before any event; a free target opens and stays claimed (design §1 row 9)", async () => {
		const place = await workspace();
		const heldTarget = await committed(place);
		const freeTarget = await committed(place);
		SessionOwnershipTestHooks.mode = "enforce";
		const pid = await holdInAnotherProcess(heldTarget.id);
		const events: string[] = [];
		const { session } = await createAgentSession({
			cwd: place.cwd,
			agentDir: path.join(place.root, "agent"),
			settings: Settings.isolated(),
			disableExtensionDiscovery: true,
			extensions: [
				api => {
					api.on("session_before_switch", async () => {
						events.push("session_before_switch");
					});
				},
			],
			skills: [],
			rules: [],
			contextFiles: [],
			promptTemplates: [],
			slashCommands: [],
			enableMCP: false,
			enableLsp: false,
			toolNames: ["__none__"],
		});
		try {
			const own = session.sessionManager.getSessionId();
			await expect(session.switchSession(heldTarget.file)).rejects.toMatchObject({
				code: "session_held",
				holder: { surface: "terminal", pid },
			});
			expect(events).toEqual([]);
			expect(session.sessionManager.getSessionId()).toBe(own);
			// A free target opens; its admission claim is gone once the switch's own claim holds it.
			expect(await session.switchSession(freeTarget.file)).toBe(true);
			expect(events).toEqual(["session_before_switch"]);
			expect(session.sessionManager.getSessionId()).toBe(freeTarget.id);
			expect(sessionClaimSetOf(session.sessionManager).sessionIds).toEqual([freeTarget.id]);
		} finally {
			await session.dispose();
		}
		expect((await probeSessionOwners([freeTarget.id])).get(freeTarget.id)).toEqual({ state: "free" });
	});

	it("picker star and delete of a session another process holds are refused; observe writes as before (design §1 row 17)", async () => {
		const place = await workspace();
		const { file, id } = await committed(place);
		const agentDir = path.join(place.root, "agent");
		const row = async () => {
			const found = (await SessionManager.listManagedForResumePickerReadOnly(place.cwd, agentDir)).find(
				session => session.id === id,
			);
			if (!found) throw new Error("the session is not listed");
			return found;
		};
		const starred = async () => (await row()).starred === true;
		SessionOwnershipTestHooks.mode = "enforce";
		const tui = keep(SessionManager.create(place.cwd, place.destination));
		const pid = await holdInAnotherProcess(id);
		const before = await tree(place.root);
		const held = `it is open in another terminal (pid ${pid}).`;
		// The bare `--resume` picker and the in-TUI `/resume` picker.
		await expect(
			SessionManager.setSessionStarredForPicker(await row(), true, undefined, { surface: "terminal" }),
		).rejects.toThrow(`Can't star this session: ${held}`);
		await expect(deleteSessionPickerCandidate(await row())).rejects.toThrow(`Can't delete this session: ${held}`);
		await expect(tui.setSessionStarredForPicker(await row(), true)).rejects.toThrow(
			`Can't star this session: ${held}`,
		);
		await expect(tui.dropSession(file)).rejects.toThrow(`Can't delete this session: ${held}`);
		expect(await tree(place.root)).toEqual(before);
		expect((await inspectSessionOwners()).held.filter(sidecar => sidecar.self && sidecar.sessionId === id)).toEqual(
			[],
		);
		// Observe: the write goes ahead as on dev, and the conflict is counted.
		SessionOwnershipTestHooks.mode = "observe";
		const conflicts = sessionOwnershipCounters().claim_conflict;
		await SessionManager.setSessionStarredForPicker(await row(), true, undefined, { surface: "terminal" });
		expect(await starred()).toBe(true);
		expect(sessionOwnershipCounters().claim_conflict).toBe(conflicts + 1);
		// The holder quits: a session this process holds is its own, so its picker writes go ahead.
		for (const child of holders.splice(0)) {
			child.kill("SIGKILL");
			await child.exited;
		}
		SessionOwnershipTestHooks.mode = "enforce";
		const own = keep(await SessionManager.open(file, place.destination));
		await own.setSessionStarredForPicker(await row(), false);
		expect(await starred()).toBe(false);
		await own.dropSession(file);
		expect(await Bun.file(file).exists()).toBe(false);
		expect(own.getSessionId()).not.toBe(id);
		expect(await state(id)).toBe("free");
	});

	it("observe adds no await: the switch admission and the held probes return undefined at once, even for a held session", async () => {
		const place = await workspace();
		const target = await committed(place);
		await holdInAnotherProcess(target.id);
		const manager = keep(SessionManager.create(place.cwd, place.destination));
		const observe = { surface: "terminal" as const, mode: "observe" as const };
		expect(manager.switchTargetAdmission(target.file)).toBeUndefined();
		expect(SessionManager.probeHeldTranscript(target.file, observe)).toBeUndefined();
		expect(probeHeldSessions(observe, [target.id])).toBeUndefined();
		// The same calls under enforce see the holder.
		SessionOwnershipTestHooks.mode = "enforce";
		await expect(
			SessionManager.probeHeldTranscript(target.file, { ...observe, mode: "enforce" }),
		).resolves.toBeInstanceOf(SessionHeldError);
	});

	it("/resume Fork whose switch a hook cancels deletes the copy; breadcrumb, session and source stay as they were", async () => {
		const place = await workspace();
		const source = await committed(place);
		SessionOwnershipTestHooks.mode = "enforce";
		await holdInAnotherProcess(source.id);
		// A terminal id, whatever runs the test: tmux and a stdin TTY take precedence over kitty's id,
		// so clear tmux's and read the breadcrumb path back from the same resolver gjc uses.
		const terminalEnv = ["TMUX", "TMUX_PANE", "KITTY_WINDOW_ID"].map(key => [key, process.env[key]] as const);
		const restoreTerminalEnv = () => {
			for (const [key, value] of terminalEnv) {
				if (value === undefined) delete process.env[key];
				else process.env[key] = value;
			}
		};
		delete process.env.TMUX;
		delete process.env.TMUX_PANE;
		process.env.KITTY_WINDOW_ID = "held-fork-test";
		const terminal = getTerminalId();
		const breadcrumb = terminal && path.join(getTerminalSessionsDir(), terminal);
		if (!breadcrumb) {
			restoreTerminalEnv();
			throw new Error("expected a terminal id");
		}
		const previousBreadcrumb = (await Bun.file(breadcrumb).exists()) ? await Bun.file(breadcrumb).text() : undefined;
		const { session } = await createAgentSession({
			cwd: place.cwd,
			agentDir: path.join(place.root, "agent"),
			settings: Settings.isolated(),
			disableExtensionDiscovery: true,
			extensions: [
				api => {
					api.on("session_before_switch", async () => ({ cancel: true }));
				},
			],
			skills: [],
			rules: [],
			contextFiles: [],
			promptTemplates: [],
			slashCommands: [],
			enableMCP: false,
			enableLsp: false,
			toolNames: ["__none__"],
		}).catch(error => {
			restoreTerminalEnv();
			throw error;
		});
		const ui = new TUI(new VirtualTerminal(80, 12));
		try {
			session.sessionManager.appendMessage(user("own"));
			await session.sessionManager.ensureOnDisk();
			await session.sessionManager.flush();
			await Bun.write(breadcrumb, "before\n");
			const own = session.sessionManager.getSessionId();
			const sourceBytes = await Bun.file(source.file).bytes();
			const transcripts = async () =>
				(await fs.readdir(path.dirname(source.file))).filter(name => name.endsWith(".jsonl")).sort();
			const before = await transcripts();
			const statuses: string[] = [];
			const fork = heldSessionWarningDialog(new SessionHeldError(source.id)).options[0];
			const context = {
				ui,
				statusContainer: new Container(),
				pendingMessagesContainer: new Container(),
				compactionQueuedMessages: [],
				pendingTools: new Map(),
				session,
				sessionManager: session.sessionManager,
				settings: { get: () => undefined },
				showHookSelector: async () => fork,
				showStatus: (message: string) => statuses.push(message),
				resetIrcSidebarSession: () => {},
				resetAssistantTextPresentation: () => {},
				updateEditorBorderColor: () => {},
				rebuildInitialMessages: () => {},
				reloadTodos: async () => undefined,
			} as unknown as InteractiveModeContext;
			const controller = new SelectorController(context);
			await controller.handleResumeSession(source.file);

			expect(await transcripts()).toEqual(before);
			expect(await Bun.file(breadcrumb).text()).toBe("before\n");
			expect(session.sessionManager.getSessionId()).toBe(own);
			expect(await Bun.file(source.file).bytes()).toEqual(sourceBytes);
			expect(statuses).not.toContain("Resumed session");
			// The guard was released: a second /resume runs (and its copy goes the same way).
			await controller.handleResumeSession(source.file);
			expect(statuses).not.toContain("Resume already in progress");
			expect(await transcripts()).toEqual(before);
		} finally {
			ui.stop();
			restoreTerminalEnv();
			if (previousBreadcrumb === undefined) await fs.rm(breadcrumb, { force: true });
			else await Bun.write(breadcrumb, previousBreadcrumb);
			await session.dispose();
		}
	});

	it("a failed claim refuses too, but a fork reads a source it cannot claim in place", async () => {
		const place = await workspace();
		const { file, id } = await committed(place);
		SessionOwnershipTestHooks.mode = "enforce";
		SessionOwnershipTestHooks.lockBackend = failingFor(id);
		await expect(SessionManager.open(file, place.destination)).rejects.toBeInstanceOf(SessionOwnershipError);
		// The fork's legacy source needs a migration, whose claim fails: it is read where it is.
		const encoded = path
			.resolve(place.cwd)
			.replace(/^[/\\]/, "")
			.replace(/[/\\:]/g, "-");
		const legacyDir = path.join(place.destination.securityContext.sessionsRoot, `--${encoded}--`);
		await fs.mkdir(legacyDir, { recursive: true, mode: 0o700 });
		const legacy = path.join(legacyDir, path.basename(file));
		await fs.rename(file, legacy);
		const fork = keep(await SessionManager.forkFrom(legacy, place.cwd, place.destination));
		expect(fork.getHeader()?.parentSession).toBe(id);
		expect((await fs.readdir(place.destination.directory)).filter(name => name.endsWith(`${id}.jsonl`))).toEqual([]);
	});

	it("the live mode only lowers a refusal: an operator's observe reaches a manager opened under enforce", async () => {
		const place = await workspace();
		const { file, id } = await committed(place);
		await holdInAnotherProcess(id);
		SessionOwnershipTestHooks.mode = "observe";
		const opened = keep(
			await SessionManager.open(file, place.destination, undefined, undefined, undefined, {
				surface: "terminal",
				mode: "enforce",
			}),
		);
		expect([opened.getSessionId(), await sessionClaimSetOf(opened).settled()]).toEqual([id, "held"]);
		await opened.close();
		// Only an explicit lower mode lowers it: this process's config names none, so a factory that
		// read enforce from its own settings (another agent directory, say) still refuses.
		delete SessionOwnershipTestHooks.mode;
		await expect(
			SessionManager.open(file, place.destination, undefined, undefined, undefined, {
				surface: "app",
				mode: "enforce",
			}),
		).rejects.toBeInstanceOf(SessionHeldError);
	});

	it("--continue and autoResume start fresh with the notice when the newest session is held; -p --continue refuses", async () => {
		const place = await workspace();
		const settings = Settings.isolated({ autoResume: true });
		const destination = SessionManager.managedDestination(place.cwd, settings.getAgentDir());
		if (destination.kind !== "managed") throw new Error("expected a managed destination");
		const older = await committed({ ...place, destination });
		const newest = await committed({ ...place, destination });
		SessionOwnershipTestHooks.mode = "enforce";
		const pid = await holdInAnotherProcess(newest.id);
		const notices: string[] = [];
		const tui = { interactive: true, notice: (message: string) => notices.push(message) };
		const fresh = keep(
			(await createSessionManager({ continue: true } as Args, place.cwd, settings, "terminal", tui))!,
		);
		expect([fresh.getSessionId() === newest.id, fresh.getSessionId() === older.id]).toEqual([false, false]);
		expect(notices).toEqual([
			`Your most recent session is open in another terminal (pid ${pid}), so a new session was started. Run gjc --resume to pick a session.`,
		]);
		const print = { interactive: false, notice: (message: string) => notices.push(message) };
		await expect(
			createSessionManager({ continue: true } as Args, place.cwd, settings, "print", print),
		).rejects.toMatchObject({ code: "session_held", sessionId: newest.id });
		// autoResume was not asked for, so even -p starts fresh, with the notice, and is not marked --continue.
		const args = {} as Args;
		const auto = keep((await createSessionManager(args, place.cwd, settings, "print", print))!);
		expect([auto.getSessionId() === newest.id, args.continue, notices.length]).toEqual([false, undefined, 2]);
	});

	it.each([
		"id",
		"path",
	] as const)("an interactive --resume <%s> of a held session warns before the folder question: Fork copies it, Cancel opens nothing (design §1 row 1)", async form => {
		const place = await workspace();
		const settings = Settings.isolated();
		// The session belongs to another folder, so a free one would get the y/N fork question first.
		const elsewhere = path.join(place.root, "elsewhere");
		await fs.mkdir(elsewhere);
		const destination = SessionManager.managedDestination(elsewhere, settings.getAgentDir());
		if (destination.kind !== "managed") throw new Error("expected a managed destination");
		const source = await committed({ ...place, cwd: elsewhere, destination });
		SessionOwnershipTestHooks.mode = "enforce";
		const pid = await holdInAnotherProcess(source.id);
		const bytes = await Bun.file(source.file).bytes();
		const warned: (number | undefined)[] = [];
		const forked: string[] = [];
		const tui = (choice: HeldSessionChoice) => ({
			interactive: true,
			notice: () => {},
			held: {
				choose: async (error: SessionHeldError) => {
					warned.push(error.holder?.pid);
					return choice;
				},
				forked: (message: string) => forked.push(message),
			},
		});
		const resume = () => ({ resume: form === "id" ? source.id : source.file }) as Args;
		await expect(
			createSessionManager(resume(), place.cwd, settings, "terminal", tui("cancel")),
		).rejects.toBeInstanceOf(SessionResumeCancelledError);
		const copy = keep((await createSessionManager(resume(), place.cwd, settings, "terminal", tui("fork")))!);
		expect([copy.getSessionId() === source.id, copy.getHeader()?.parentSession, copy.getCwd()]).toEqual([
			false,
			source.id,
			place.cwd,
		]);
		expect(warned).toEqual([pid, pid]);
		expect(forked).toEqual([`Forked into a new session. The original stays with another terminal (pid ${pid}).`]);
		expect(await Bun.file(source.file).bytes()).toEqual(bytes);
		// Without a terminal to ask on, the open itself refuses, as in 5a.
		await expect(
			createSessionManager({ resume: source.file } as Args, place.cwd, settings, "terminal", {
				interactive: true,
				notice: () => {},
			}),
		).rejects.toMatchObject({ code: "session_held", holder: { pid } });
	});

	it("continueRecent skips a held bounded candidate it could not continue, and stops at one it could", async () => {
		const place = await workspace();
		/** A linear, compacted transcript, as the bounded loader serves; `reply` ends it on an assistant turn. */
		const compacted = async (reply: boolean): Promise<string> => {
			SessionOwnershipTestHooks.mode = "off";
			const manager = SessionManager.create(place.cwd, place.destination);
			const kept = manager.appendMessage(user("question"));
			if (reply)
				manager.appendMessage({
					role: "assistant",
					content: [{ type: "text", text: "answer" }],
					api: "anthropic-messages",
					provider: "anthropic",
					model: "claude-sonnet-4-5",
					usage: {
						input: 1,
						output: 1,
						cacheRead: 0,
						cacheWrite: 0,
						totalTokens: 2,
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
					},
					stopReason: "stop",
					timestamp: Date.now(),
				});
			manager.appendCompaction("summary", "short", kept, 10);
			await manager.ensureOnDisk();
			await manager.flush();
			const id = manager.getSessionId();
			await manager.close();
			SessionOwnershipTestHooks.mode = "enforce";
			return id;
		};
		const older = { id: await compacted(false) };
		// The newest ends on an assistant reply: today's bounded rule does not continue it.
		const finishedId = await compacted(true);
		await holdInAnotherProcess(finishedId);
		SessionManagerTestHooks.eagerHydrationMaxBytesOverride = 64;
		try {
			const continued = keep(
				await SessionManager.continueRecent(place.cwd, place.destination, undefined, undefined, "enabled"),
			);
			expect(continued.getSessionId()).toBe(older.id);
			await continued.close();
			// Held and continuable: the search ends there, refused.
			await holdInAnotherProcess(older.id);
			await expect(
				SessionManager.continueRecent(place.cwd, place.destination, undefined, undefined, "enabled"),
			).rejects.toMatchObject({ code: "session_held", sessionId: older.id });
		} finally {
			delete SessionManagerTestHooks.eagerHydrationMaxBytesOverride;
		}
	});

	it("the kill switch reads the operator's config.yml: off or observe there drops the next refusal; a silent or unreadable one keeps it", async () => {
		const place = await workspace();
		const { file, id } = await committed(place);
		await holdInAnotherProcess(id);
		// No test mode: both reads are real. The factory read enforce; only the reread file may lower it.
		delete SessionOwnershipTestHooks.mode;
		const openUnderEnforce = () =>
			SessionManager.open(file, place.destination, undefined, undefined, undefined, {
				surface: "terminal",
				mode: "enforce",
			});
		const decisions = async (configPath: string) => {
			const seen: string[] = [];
			for (const mode of ["off", "observe", undefined, "unreadable"] as const) {
				await fs.rm(configPath, { recursive: true, force: true });
				if (mode === "unreadable") await fs.mkdir(configPath);
				else if (mode !== undefined) await Bun.write(configPath, `session:\n  ownership:\n    mode: ${mode}\n`);
				try {
					await (await openUnderEnforce()).close();
					seen.push(`${mode}: opened`);
				} catch (error) {
					seen.push(`${mode}: ${(error as { code?: string }).code}`);
				}
			}
			await fs.rm(configPath, { recursive: true, force: true });
			return seen;
		};
		const expected = ["off: opened", "observe: opened", "undefined: session_held", "unreadable: session_held"];
		// Without process settings (an embedding): the process agent directory's file.
		const processConfig = path.join(getAgentDir(), "config.yml");
		if (!getAgentDir().includes("gjc-test-agent-")) throw new Error("the test preload isolates the agent directory");
		if (await Bun.file(processConfig).exists())
			throw new Error("expected no config.yml in the isolated agent directory");
		// A refusal's reread never changes the mode later factories read once.
		resetSettingsForTest();
		expect(sessionOwnershipMode()).toBe("observe");
		await Bun.write(processConfig, "session:\n  ownership:\n    mode: off\n");
		expect(liveSessionOwnershipMode()).toBe("off");
		expect(sessionOwnershipMode()).toBe("observe");
		expect(await decisions(processConfig)).toEqual(expected);
		// With process settings (the TUI, -p): their agent directory's file, read again past their cache.
		const agentDir = path.join(place.root, "agent");
		await Settings.init({ cwd: place.cwd, agentDir });
		try {
			expect(await decisions(path.join(agentDir, "config.yml"))).toEqual(expected);
		} finally {
			resetSettingsForTest();
		}
	});

	it("createAgentSession refuses the session it creates when its claim fails, closes it, and keeps no claim", async () => {
		const place = await workspace();
		SessionOwnershipTestHooks.mode = "enforce";
		SessionOwnershipTestHooks.lockBackend = failingForEveryId();
		const close = vi.spyOn(SessionManager.prototype, "close");
		await expect(
			createAgentSession({
				cwd: place.cwd,
				agentDir: path.join(place.root, "agent"),
				settings: Settings.isolated(),
				disableExtensionDiscovery: true,
				skills: [],
				rules: [],
				contextFiles: [],
				promptTemplates: [],
				slashCommands: [],
				enableMCP: false,
				enableLsp: false,
				toolNames: ["__none__"],
			}),
		).rejects.toBeInstanceOf(SessionOwnershipError);
		expect(close).toHaveBeenCalledTimes(1);
		expect((await inspectSessionOwners()).held).toEqual([]);
	});

	it("a refused missing-path open leaves no file, and no session directory it created", async () => {
		const place = await workspace();
		SessionOwnershipTestHooks.mode = "enforce";
		SessionOwnershipTestHooks.lockBackend = failingForEveryId();
		const directory = path.join(place.root, "explicit");
		await expect(
			SessionManager.open(path.join(directory, "new.jsonl"), SessionManager.explicitDestination(directory)),
		).rejects.toBeInstanceOf(SessionOwnershipError);
		expect(await Bun.file(directory).exists()).toBe(false);
		expect(await fs.stat(directory).catch(() => "absent")).toBe("absent");
	});

	it("createAgentSession's owner option names the holder other processes see", async () => {
		const place = await workspace();
		const { session } = await createAgentSession({
			cwd: place.cwd,
			agentDir: path.join(place.root, "agent"),
			settings: Settings.isolated(),
			owner: { surface: "app" },
			disableExtensionDiscovery: true,
			skills: [],
			rules: [],
			contextFiles: [],
			promptTemplates: [],
			slashCommands: [],
			enableMCP: false,
			enableLsp: false,
			toolNames: ["__none__"],
		});
		try {
			const id = session.sessionManager.getSessionId();
			expect((await probeSessionOwners([id])).get(id)).toMatchObject({
				state: "held",
				self: true,
				holder: { surface: "app", pid: process.pid },
			});
		} finally {
			await session.dispose();
		}
	});
});
