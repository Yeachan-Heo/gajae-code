import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fsSync from "node:fs";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
	type FileLockAcquireResult,
	FileLockAcquireStatus,
	FileLockFailure,
	type FileLockProbeResult,
	FileLockProbeState,
	probeFileLock,
	tryAcquireFileLock,
} from "@gajae-code/natives";
import { logger } from "@gajae-code/utils";
import * as ownership from "../../src/session/session-ownership";
// @ts-expect-error -- Bun loads a query-suffixed specifier as a second instance of the module.
import * as ownershipCopy from "../../src/session/session-ownership.ts?copy=2";
import { assertRuntimeLockDirectoryUnchanged, prepareRuntimeLockDirectory } from "../../src/session/session-storage";

const {
	claimSessionOwner,
	probeSessionOwner,
	probeSessionOwners,
	resetSessionOwnershipForTests,
	SessionHeldError,
	SessionOwnershipError,
	SessionOwnershipTestHooks,
	sessionOwnerHolderPhrase,
	sessionOwnerKey,
	sessionOwnersDirectory,
	sessionOwnershipCounters,
} = ownership;

const supported = process.platform === "linux" || process.platform === "darwin";

let home: string;
let claims: ownership.SessionOwnerClaim[];
let warnings: string[];

async function claimed(sessionId: string, surface: ownership.SessionOwnerSurface = "terminal") {
	const result = await claimSessionOwner(sessionId, { surface });
	if (result.status !== "claimed") throw new Error(`expected a claim, got ${result.status}`);
	claims.push(result.claim);
	return result.claim;
}

function ownersPath(sessionId: string, suffix: ".session-owner" | ".owner.json"): string {
	return path.join(sessionOwnersDirectory(), `${sessionOwnerKey(sessionId)}${suffix}`);
}

async function readJson(file: string): Promise<Record<string, unknown>> {
	return JSON.parse(await fs.readFile(file, "utf8")) as Record<string, unknown>;
}

/** The test preload's isolated home, restored after each test. */
let preloadHome: string | undefined;

beforeEach(async () => {
	home = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "gjc-session-ownership-")));
	preloadHome = SessionOwnershipTestHooks.homeOverride;
	SessionOwnershipTestHooks.homeOverride = home;
	claims = [];
	// Warnings stay in memory: the logger's file sink lives under the real home.
	warnings = [];
	vi.spyOn(logger, "warn").mockImplementation(message => {
		warnings.push(message);
	});
	// Every claim below must land in this temp home, never in the real one.
	if (!sessionOwnersDirectory().startsWith(`${home}${path.sep}`)) throw new Error("owners directory escaped");
});

afterEach(async () => {
	try {
		for (const claim of claims.splice(0)) claim.release();
	} finally {
		SessionOwnershipTestHooks.homeOverride = preloadHome;
		delete SessionOwnershipTestHooks.lockBackend;
		delete SessionOwnershipTestHooks.beforeRecordPublish;
		vi.restoreAllMocks();
		await fs.chmod(home, 0o700).catch(() => {});
		await fs.rm(home, { recursive: true, force: true });
		// Last, so a leaked claim fails this test without skipping the cleanup above.
		resetSessionOwnershipForTests();
	}
});

describe("test isolation", () => {
	it("the test preload points every claim at its own temp home", () => {
		expect(preloadHome).toBeString();
		expect(path.dirname(preloadHome!)).toBe(path.resolve(os.tmpdir()));
		expect(path.basename(preloadHome!)).toStartWith("gjc-test-owners-");
	});

	it("a leaked claim is dropped and reported, and the registry is clean afterwards", async () => {
		const leaked = await claimSessionOwner("leak", { surface: "terminal" });
		expect(leaked.status).toBe("claimed");
		expect(() => resetSessionOwnershipForTests()).toThrow("1 session claim(s) were never released");
		expect(await probeSessionOwner("leak")).toEqual({ state: "free" });
		expect(() => resetSessionOwnershipForTests()).not.toThrow();
	});

	it.if(supported)("releasing a claim the reset dropped leaves a newer claim of that session alone", async () => {
		const leaked = await claimSessionOwner("leak2", { surface: "terminal" });
		if (leaked.status !== "claimed") throw new Error("expected a claim");
		expect(() => resetSessionOwnershipForTests()).toThrow("1 session claim(s) were never released");
		const newer = await claimed("leak2", "sdk");
		expect(newer.shared).toBe(false);
		leaked.claim.release();
		expect(await probeSessionOwner("leak2")).toMatchObject({ state: "held", self: true, holder: { surface: "sdk" } });
		expect(await probeFileLock(ownersPath("leak2", ".session-owner"))).toEqual({ state: FileLockProbeState.Held });
		expect(await readJson(ownersPath("leak2", ".owner.json"))).toMatchObject({ surface: "sdk" });
	});
});

describe("sessionOwnerKey", () => {
	it("keeps a safe id and hashes anything else, independent of any path", () => {
		expect(sessionOwnerKey("0193f1aa-7b2c_4d")).toBe("0193f1aa-7b2c_4d");
		for (const id of ["../escape", "a b", "x".repeat(129), "h-0193f1aa", "/tmp/s.jsonl", "AbC"]) {
			const key = sessionOwnerKey(id);
			expect(key).toMatch(/^h-[0-9a-f]{32}$/);
			expect(sessionOwnerKey(id)).toBe(key);
		}
		expect(sessionOwnerKey("a b")).not.toBe(sessionOwnerKey("a c"));
		expect(() => sessionOwnerKey("")).toThrow(TypeError);
	});
});

describe.if(supported)("claim, probe and release", () => {
	it("writes the holder record after acquiring and removes it before unlocking", async () => {
		expect(await probeSessionOwner("s1")).toEqual({ state: "free" });
		expect(await Bun.file(sessionOwnersDirectory()).exists()).toBe(false);

		const claim = await claimed("s1", "print");
		expect(claim).toMatchObject({ sessionId: "s1", surface: "print", shared: false, released: false });
		expect((await fs.stat(sessionOwnersDirectory())).mode & 0o777).toBe(0o700);
		expect((await fs.stat(ownersPath("s1", ".session-owner"))).mode & 0o777).toBe(0o600);
		expect((await fs.stat(ownersPath("s1", ".owner.json"))).mode & 0o777).toBe(0o600);
		const record = await readJson(ownersPath("s1", ".owner.json"));
		expect(record).toMatchObject({ v: 1, sessionId: "s1", pid: process.pid, surface: "print", host: os.hostname() });
		expect(record.claimNonce).toBeString();

		expect(await probeSessionOwner("s1")).toMatchObject({
			state: "held",
			self: true,
			holder: { surface: "print", pid: process.pid },
		});
		expect(await probeFileLock(ownersPath("s1", ".session-owner"))).toEqual({ state: FileLockProbeState.Held });

		claim.release();
		claim.release();
		expect(claim.released).toBe(true);
		expect(await Bun.file(ownersPath("s1", ".owner.json")).exists()).toBe(false);
		// The sidecar stays: unlinking it could split one lock between two inodes.
		expect(await Bun.file(ownersPath("s1", ".session-owner")).exists()).toBe(true);
		expect(await probeSessionOwner("s1")).toEqual({ state: "free" });
	});

	it("the record appears only after the lock is held and is gone before the unlock", async () => {
		const recordFile = ownersPath("s7", ".owner.json");
		const seen: string[] = [];
		SessionOwnershipTestHooks.lockBackend = {
			tryAcquire: async (sidecar, timeoutMs) => {
				const result = await tryAcquireFileLock(sidecar, timeoutMs);
				seen.push(`acquired, record ${fsSync.existsSync(recordFile)}`);
				const lock = result.lock;
				if (!lock) return result;
				const observed = {
					get held() {
						return lock.held;
					},
					release() {
						seen.push(`unlock, record ${fsSync.existsSync(recordFile)}`);
						lock.release();
					},
				};
				return { ...result, lock: observed };
			},
			probe: probeFileLock,
		};
		const claim = await claimed("s7");
		expect(fsSync.existsSync(recordFile)).toBe(true);
		claim.release();
		expect(seen).toEqual(["acquired, record false", "unlock, record false"]);
	});

	it("a failed record write leaves no temp file and no stale record", async () => {
		await claimed("s12");
		const recordFile = ownersPath("s12", ".owner.json");
		const stale = await readJson(recordFile);
		claims.pop()?.release();
		await Bun.write(recordFile, JSON.stringify({ ...stale, claimNonce: "dead-holder" }));
		SessionOwnershipTestHooks.beforeRecordPublish = () => {
			throw new Error("ENOSPC");
		};
		try {
			const claim = await claimed("s12");
			expect(claim.shared).toBe(false);
		} finally {
			delete SessionOwnershipTestHooks.beforeRecordPublish;
		}
		expect(await fs.readdir(sessionOwnersDirectory())).toEqual([`${sessionOwnerKey("s12")}.session-owner`]);
		expect(warnings).toEqual(["Session owner record write failed"]);
	});

	it("shares a session this process already holds, and only the last release unlocks", async () => {
		const [a, b] = await Promise.all([
			claimSessionOwner("s2", { surface: "app" }),
			claimSessionOwner("s2", { surface: "sdk" }),
		]);
		if (a.status !== "claimed" || b.status !== "claimed") throw new Error("expected two claims");
		claims.push(a.claim, b.claim);
		expect([a.claim.shared, b.claim.shared].sort()).toEqual([false, true]);
		expect(b.claim.surface).toBe("app");

		a.claim.release();
		expect(await probeSessionOwner("s2")).toMatchObject({ state: "held", self: true });
		b.claim.release();
		expect(await probeSessionOwner("s2")).toEqual({ state: "free" });
		const again = await claimed("s2");
		expect(again.shared).toBe(false);
	});

	it("a record with another nonce is never trusted for this process's claim and never removed", async () => {
		const claim = await claimed("s3", "terminal");
		const recordPath = ownersPath("s3", ".owner.json");
		const forged = { ...(await readJson(recordPath)), claimNonce: "someone-else", surface: "app" };
		await Bun.write(recordPath, JSON.stringify(forged));

		expect(await probeSessionOwner("s3")).toMatchObject({
			state: "held",
			self: true,
			holder: { surface: "terminal" },
		});
		claim.release();
		expect(await readJson(recordPath)).toMatchObject({ claimNonce: "someone-else" });
		expect(await probeSessionOwner("s3")).toEqual({ state: "free" });
	});

	it("ids that differ only in case are separate sessions, even on a case-insensitive volume", async () => {
		const upper = await claimed("AbC");
		// Before keys folded case, this was "held" by the AbC claim's own sidecar.
		expect((await claimed("abc")).shared).toBe(false);
		expect(await probeSessionOwners(["AbC", "abc"])).toEqual(
			new Map([
				["AbC", expect.objectContaining({ state: "held", self: true })],
				["abc", expect.objectContaining({ state: "held", self: true })],
			]),
		);
		upper.release();
		expect(await probeSessionOwner("AbC")).toEqual({ state: "free" });
		expect(await probeSessionOwner("abc")).toMatchObject({ state: "held", self: true });
	});

	it("a batch probe answers every id, sixteen lock calls at a time", async () => {
		await fs.mkdir(sessionOwnersDirectory(), { recursive: true, mode: 0o700 });
		const ids = Array.from({ length: 40 }, (_, index) => `b${index}`);
		const heldKeys = new Set(ids.filter((_, index) => index % 3 === 0).map(id => sessionOwnerKey(id)));
		let inFlight = 0;
		let peak = 0;
		SessionOwnershipTestHooks.lockBackend = {
			tryAcquire: async () => ({ status: FileLockAcquireStatus.Held }),
			probe: async sidecar => {
				inFlight += 1;
				peak = Math.max(peak, inFlight);
				await Bun.sleep(1);
				inFlight -= 1;
				const key = path.basename(sidecar, ".session-owner");
				return { state: heldKeys.has(key) ? FileLockProbeState.Held : FileLockProbeState.Free };
			},
		};
		const results = await probeSessionOwners(ids);
		expect(peak).toBe(16);
		expect([...results.keys()]).toEqual(ids);
		for (const [index, id] of ids.entries()) {
			expect(results.get(id)?.state).toBe(index % 3 === 0 ? "held" : "free");
		}
	});

	it("a probe reports this process's own claim even when the owners directory is gone", async () => {
		await claimed("s8");
		const moved = path.join(home, "moved-owners");
		await fs.rename(sessionOwnersDirectory(), moved);
		try {
			expect(await probeSessionOwner("s8")).toMatchObject({ state: "held", self: true });
			expect(await probeSessionOwner("s9")).toEqual({ state: "free" });
		} finally {
			await fs.rename(moved, sessionOwnersDirectory());
		}
	});

	it("a probe waits for a claim in flight in this process", async () => {
		const started = Promise.withResolvers<void>();
		const gate = Promise.withResolvers<void>();
		SessionOwnershipTestHooks.lockBackend = {
			tryAcquire: async (sidecar, timeoutMs) => {
				started.resolve();
				await gate.promise;
				return tryAcquireFileLock(sidecar, timeoutMs);
			},
			// Without the wait, the probe would ask the lock and hear "free".
			probe: async () => ({ state: FileLockProbeState.Free }),
		};
		const claiming = claimSessionOwner("s10", { surface: "terminal" });
		await started.promise;
		const probing = probeSessionOwner("s10");
		gate.resolve();
		const result = await claiming;
		if (result.status === "claimed") claims.push(result.claim);
		expect(await probing).toMatchObject({ state: "held", self: true });
	});

	it("two copies of the module share one registry", async () => {
		const copy: typeof ownership = ownershipCopy;
		expect(copy.claimSessionOwner).not.toBe(claimSessionOwner);
		// One test-hook slot per process too, so the preload's isolation reaches every copy.
		expect(copy.SessionOwnershipTestHooks).toBe(SessionOwnershipTestHooks);
		const first = await claimed("s4");
		expect(await copy.probeSessionOwner("s4")).toMatchObject({ state: "held", self: true });
		const second = await copy.claimSessionOwner("s4", { surface: "sdk" });
		if (second.status !== "claimed") throw new Error("expected a shared claim");
		claims.push(second.claim);
		expect(second.claim.shared).toBe(true);
		first.release();
		second.claim.release();
		expect(await copy.probeSessionOwner("s4")).toEqual({ state: "free" });
	});

	it("batch-probes many ids in one call", async () => {
		await claimed("mine");
		const foreign = await tryAcquireFileLock(ownersPath("theirs", ".session-owner"));
		try {
			const results = await probeSessionOwners(["mine", "theirs", "nobody", "mine"]);
			expect([...results.keys()]).toEqual(["mine", "theirs", "nobody"]);
			expect(results.get("mine")).toMatchObject({ state: "held", self: true });
			// A handle outside the registry, with no record, is "another gjc process".
			expect(results.get("theirs")).toEqual({ state: "held", self: false, holder: undefined });
			expect(results.get("nobody")).toEqual({ state: "free" });
		} finally {
			foreign.lock?.release();
		}
	});
});

describe.if(supported)("the owners directory fails closed like the append lock", () => {
	it("refuses a symlinked .gjc", async () => {
		const elsewhere = path.join(home, "elsewhere");
		await fs.mkdir(elsewhere, { mode: 0o700 });
		await fs.symlink(elsewhere, path.join(home, ".gjc"));
		const refused = await claimSessionOwner("s5", { surface: "terminal" }).catch((error: unknown) => error);
		expect(refused).toBeInstanceOf(SessionOwnershipError);
		expect((refused as InstanceType<typeof SessionOwnershipError>).code).toBe("owners_directory_unsafe");
		expect(await probeSessionOwner("s5")).toEqual({
			state: "unknown",
			reason: "failed",
			code: "owners_directory_unsafe",
		});
		expect(await Bun.file(path.join(elsewhere, "runtime")).exists()).toBe(false);
	});

	it("releases and refuses when the owners directory is swapped during the acquire", async () => {
		const owners = sessionOwnersDirectory();
		const old = `${owners}.old`;
		SessionOwnershipTestHooks.lockBackend = {
			tryAcquire: async (sidecar, timeoutMs) => {
				const result = await tryAcquireFileLock(sidecar, timeoutMs);
				await fs.rename(owners, old);
				await fs.mkdir(owners, { mode: 0o700 });
				return result;
			},
			probe: probeFileLock,
		};
		const refused = await claimSessionOwner("s11", { surface: "terminal" }).catch((error: unknown) => error);
		expect(refused).toBeInstanceOf(SessionOwnershipError);
		expect((refused as InstanceType<typeof SessionOwnershipError>).code).toBe("owners_directory_changed");
		// The lock taken in the swapped-out directory is released, and no record names this process.
		expect(await probeFileLock(path.join(old, `${sessionOwnerKey("s11")}.session-owner`))).toEqual({
			state: FileLockProbeState.Free,
		});
		expect(await Bun.file(path.join(old, `${sessionOwnerKey("s11")}.owner.json`)).exists()).toBe(false);
		delete SessionOwnershipTestHooks.lockBackend;
		expect(await probeSessionOwner("s11")).toEqual({ state: "free" });
		expect((await claimed("s11")).shared).toBe(false);
	});

	it("refuses a home other users can write", async () => {
		await fs.chmod(home, 0o777);
		const refused = await claimSessionOwner("s6", { surface: "terminal" }).catch((error: unknown) => error);
		expect(refused).toBeInstanceOf(SessionOwnershipError);
		expect(refused).toMatchObject({ code: "owners_directory_unsafe", errno: undefined });
		expect((await probeSessionOwner("s6")).state).toBe("unknown");
	});

	it.if(process.getuid?.() !== 0)("reports a filesystem refusal as I/O, with a fixed operator message", async () => {
		// Owner-only but not writable: creating `.gjc` fails with EACCES, not a safety check.
		await fs.chmod(home, 0o500);
		const refused = await claimSessionOwner("s13", { surface: "terminal" }).catch((error: unknown) => error);
		expect(refused).toBeInstanceOf(SessionOwnershipError);
		expect(refused).toMatchObject({ code: "owners_directory_io", errno: "EACCES" });
		const message = (refused as InstanceType<typeof SessionOwnershipError>).operatorMessage;
		expect(message).toStartWith("gjc could not check safely whether another process has this session open");
		expect(message).not.toContain(home);
		// The trusted home need not be `~`, so the message never names it that way.
		expect(message).not.toContain("~");
		expect(message).toContain(".gjc/runtime in your home directory");
	});

	it.if(process.getuid?.() !== 0)("a probe reports a filesystem refusal as I/O, as a claim does", async () => {
		(await claimed("s14")).release();
		const runtime = path.join(home, ".gjc", "runtime");
		await fs.chmod(runtime, 0o000);
		try {
			expect(await probeSessionOwner("s14")).toEqual({
				state: "unknown",
				reason: "failed",
				code: "owners_directory_io",
			});
		} finally {
			await fs.chmod(runtime, 0o700);
		}
	});

	it("accepts only a single lower-case segment as a lock namespace name", () => {
		for (const name of ["", "..", "../owners", "a/b", "Owners", ".hidden", "x".repeat(65)])
			expect(() => prepareRuntimeLockDirectory(name, home)).toThrow(TypeError);
		expect(prepareRuntimeLockDirectory("session-owners", home).path).toBe(sessionOwnersDirectory());
	});

	it("names each namespace in its directory errors, keeping the append-lock text", async () => {
		const owners = prepareRuntimeLockDirectory("session-owners", home);
		const appendLocks = prepareRuntimeLockDirectory("append-locks", home);
		const causeOf = (run: () => void): string => {
			try {
				run();
			} catch (error) {
				return String((error as Error).cause);
			}
			throw new Error("expected a refusal");
		};
		for (const directory of [owners.path, appendLocks.path]) {
			await fs.rm(directory, { recursive: true });
			await fs.symlink(home, directory);
		}
		expect([owners.label, appendLocks.label]).toEqual(["session-owner", "append-lock"]);
		expect(causeOf(() => assertRuntimeLockDirectoryUnchanged(owners.directories, "c", owners.label))).toBe(
			`Error: Unsafe session-owner directory: ${owners.path}`,
		);
		expect(causeOf(() => assertRuntimeLockDirectoryUnchanged(appendLocks.directories))).toBe(
			`Error: Unsafe append-lock directory: ${appendLocks.path}`,
		);
	});
});

describe("narrow fail-open", () => {
	function backend(
		acquire: (sidecar: string) => FileLockAcquireResult | Promise<FileLockAcquireResult>,
		probe?: FileLockProbeResult,
	) {
		const calls = { acquire: 0, probe: 0 };
		SessionOwnershipTestHooks.lockBackend = {
			tryAcquire: async sidecar => {
				calls.acquire += 1;
				return acquire(sidecar);
			},
			probe: async () => {
				calls.probe += 1;
				return probe ?? { state: FileLockProbeState.Free };
			},
		};
		return calls;
	}

	it("unavailable turns claims and probes off for the whole process", async () => {
		const calls = backend(() => ({ status: FileLockAcquireStatus.Unavailable, code: "ENOLCK" }));
		expect(await claimSessionOwner("f1", { surface: "terminal" })).toEqual({
			status: "skipped",
			reason: "unavailable",
			code: "ENOLCK",
		});
		expect(await claimSessionOwner("f2", { surface: "terminal" })).toMatchObject({
			status: "skipped",
			reason: "unavailable",
		});
		expect(await probeSessionOwner("f2")).toEqual({ state: "unknown", reason: "unavailable", code: "ENOLCK" });
		expect(calls).toEqual({ acquire: 1, probe: 0 });
		expect(warnings).toEqual(["Session ownership is unavailable; claims are off for this process"]);
	});

	it("claims waiting on an acquire that finds the platform unavailable do not ask again", async () => {
		const calls = backend(async () => {
			await Bun.sleep(5);
			return { status: FileLockAcquireStatus.Unavailable, code: "ENOLCK" };
		});
		const results = await Promise.all(
			Array.from({ length: 3 }, () => claimSessionOwner("f8", { surface: "terminal" })),
		);
		for (const result of results) expect(result).toMatchObject({ status: "skipped", reason: "unavailable" });
		expect(calls.acquire).toBe(1);
	});

	it("a probe turns claims off only for an unsupported platform", async () => {
		await fs.mkdir(path.join(home, ".gjc", "runtime", "session-owners"), { recursive: true, mode: 0o700 });
		const calls = backend(() => ({ status: FileLockAcquireStatus.Acquired }), {
			state: FileLockProbeState.Unknown,
			reason: FileLockFailure.Unavailable,
			code: "unsupported_platform",
		});
		expect(await probeSessionOwner("f3")).toMatchObject({ state: "unknown", reason: "unavailable" });
		expect(await claimSessionOwner("f3", { surface: "terminal" })).toMatchObject({
			status: "skipped",
			reason: "unavailable",
		});
		expect(calls.acquire).toBe(0);
	});

	it("a probe's ENOTSUP or timeout leaves claims on", async () => {
		await fs.mkdir(path.join(home, ".gjc", "runtime", "session-owners"), { recursive: true, mode: 0o700 });
		for (const [reason, code] of [
			[FileLockFailure.Unavailable, "ENOTSUP"],
			[FileLockFailure.TimedOut, "timed_out"],
		] as const) {
			const calls = backend(() => ({ status: FileLockAcquireStatus.Held }), {
				state: FileLockProbeState.Unknown,
				reason,
				code,
			});
			expect(await probeSessionOwner("f7")).toEqual({ state: "unknown", reason, code });
			expect(await claimSessionOwner("f7", { surface: "terminal" })).toEqual({ status: "held", holder: undefined });
			expect(calls.acquire).toBe(1);
		}
		expect(warnings).toEqual([]);
	});

	it("one timeout turns claims off for the process: later claims fail open without waiting", async () => {
		const STALL_MS = 200;
		const calls = backend(async () => {
			await Bun.sleep(STALL_MS);
			return { status: FileLockAcquireStatus.TimedOut, code: "timed_out" };
		});
		const stalled = Date.now();
		expect(await claimSessionOwner("f4", { surface: "terminal" })).toEqual({
			status: "skipped",
			reason: "timed_out",
			code: "timed_out",
		});
		expect(Date.now() - stalled).toBeGreaterThanOrEqual(STALL_MS - 5);
		const later = Date.now();
		for (const id of ["f4", "f4-new", "f4-fork"])
			expect(await claimSessionOwner(id, { surface: "terminal" })).toEqual({
				status: "skipped",
				reason: "timed_out",
				code: "timed_out",
			});
		expect(Date.now() - later).toBeLessThan(STALL_MS);
		expect(calls.acquire).toBe(1);
		expect(sessionOwnershipCounters().fail_open).toBe(4);
		expect(warnings).toEqual(["Session ownership claim timed out; claims are off for this process"]);
	});

	it("any other lock failure refuses, open/permission EACCES included", async () => {
		for (const code of ["EACCES", "foreign_owner", "ELOOP"]) {
			backend(() => ({ status: FileLockAcquireStatus.Failed, code }));
			const refused = await claimSessionOwner(`f5-${code}`, { surface: "terminal" }).catch(
				(error: unknown) => error,
			);
			expect(refused).toBeInstanceOf(SessionOwnershipError);
			expect((refused as InstanceType<typeof SessionOwnershipError>).code).toBe(code);
		}
		await fs.mkdir(path.join(home, ".gjc", "runtime", "session-owners"), { recursive: true, mode: 0o700 });
		backend(() => ({ status: FileLockAcquireStatus.Held }), {
			state: FileLockProbeState.Unknown,
			reason: FileLockFailure.Failed,
			code: "EACCES",
		});
		expect(await probeSessionOwner("f6")).toEqual({ state: "unknown", reason: "failed", code: "EACCES" });
		// Contention, as the primitive classifies it, is a holder, not a failure.
		expect(await claimSessionOwner("f6", { surface: "terminal" })).toEqual({ status: "held", holder: undefined });
	});
});

describe("SessionHeldError", () => {
	it("carries a fixed, path-free operator message naming the holder", () => {
		const error = new SessionHeldError("3f9a1c2e-1111-2222", { surface: "terminal", pid: 4242 });
		expect(error.message).toBe("session_held");
		expect(error.code).toBe("session_held");
		expect(error.holder).toEqual({ surface: "terminal", pid: 4242 });
		// The SDK wording (design §3.3) names no CLI command: an embedder has none to run.
		expect(error.operatorMessage).toBe(
			"Session 3f9a1c2e is open for writing in another process (terminal, pid 4242). Only one process can write a session at a time.",
		);

		const unsafe = new SessionHeldError(`${home}/session.jsonl`);
		expect(unsafe.operatorMessage).toBe(
			"This session is open for writing in another gjc process. Only one process can write a session at a time.",
		);
		expect(unsafe.operatorMessage).not.toContain(home);
	});

	it("names every holder as the design's phrase table does", () => {
		const phrase = (surface: ownership.SessionOwnerSurface, host?: string) =>
			sessionOwnerHolderPhrase({ surface, pid: 7, host });
		expect(phrase("app")).toBe("the Gajae Code app (pid 7)");
		expect(phrase("terminal")).toBe("another terminal (pid 7)");
		expect(phrase("print")).toBe("a gjc -p run (pid 7)");
		expect(phrase("sdk-host")).toBe("an SDK session host (pid 7)");
		expect(phrase("acp-host")).toBe("an ACP session host (pid 7)");
		expect(phrase("sdk")).toBe("an application using the gjc SDK (pid 7)");
		expect(phrase("terminal (subagent)")).toBe("a subagent of another terminal (pid 7)");
		expect(phrase("terminal", "build-box")).toBe("a gjc process on build-box (pid 7)");
		expect(sessionOwnerHolderPhrase(undefined)).toBe("another gjc process");
	});

	it("prints a fork command that resolves where the session was found, quoted for the shell", () => {
		const id = "01a21a7f-82ff-7332-bee3-31b605a15de0";
		const fork = ownership.sessionHeldForkCommand;
		expect(fork(id)).toBe(`gjc --fork ${id}`);
		expect(fork(id, { sessionDir: "/work/sessions" })).toBe(`gjc --session-dir /work/sessions --fork ${id}`);
		expect(fork(id, { print: true, source: "/work/a b/it's.jsonl" })).toBe(
			`gjc -p --fork '/work/a b/it'\\''s.jsonl' "<message>"`,
		);
		// A path no terminal should print gets no command at all.
		expect(fork(id, { source: "/work/\u001b[31mred.jsonl" })).toBeUndefined();
		expect(fork(id, { sessionDir: "/work/‮sessions" })).toBeUndefined();
	});

	it("never renders a malformed holder a caller built", () => {
		const malformed = [
			{ surface: "terminal", pid: 7, host: "evil host/../x" },
			{ surface: "root shell" as ownership.SessionOwnerSurface, pid: 7 },
			{ surface: "terminal", pid: -1 },
			{ surface: "terminal", pid: 1.5 },
		] satisfies ownership.SessionOwnerHolder[];
		for (const holder of malformed) expect(sessionOwnerHolderPhrase(holder)).toBe("another gjc process");
		expect(new SessionHeldError("s", malformed[0]).operatorMessage).not.toContain("evil");
	});
});

// Dormancy is proven by behaviour now that the claim set imports this module: a full session
// lifecycle in `off` makes no lock call (session-claim-set.test.ts).
describe("dormant", () => {
	it("the package does not export it", async () => {
		const manifest = (await Bun.file(path.join(import.meta.dir, "../../package.json")).json()) as {
			exports: Record<string, unknown>;
		};
		expect(manifest.exports["./session/session-ownership"]).toBeNull();
		expect(manifest.exports["./session/session-ownership.js"]).toBeNull();
		for (const specifier of [
			"@gajae-code/coding-agent/session/session-ownership",
			"@gajae-code/coding-agent/session/session-ownership.js",
		]) {
			expect(() => Bun.resolveSync(specifier, import.meta.dir)).toThrow();
		}
		// The wildcard still exports its neighbours, so the refusal above is specific to this module.
		expect(Bun.resolveSync("@gajae-code/coding-agent/session/session-storage", import.meta.dir)).toEndWith(
			path.join("src", "session", "session-storage.ts"),
		);
	});
});
