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

beforeEach(async () => {
	home = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "gjc-session-ownership-")));
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
	for (const claim of claims.splice(0)) claim.release();
	resetSessionOwnershipForTests();
	delete SessionOwnershipTestHooks.homeOverride;
	delete SessionOwnershipTestHooks.lockBackend;
	vi.restoreAllMocks();
	await fs.chmod(home, 0o700);
	await fs.rm(home, { recursive: true, force: true });
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
		copy.SessionOwnershipTestHooks.homeOverride = home;
		try {
			const first = await claimed("s4");
			expect(await copy.probeSessionOwner("s4")).toMatchObject({ state: "held", self: true });
			const second = await copy.claimSessionOwner("s4", { surface: "sdk" });
			if (second.status !== "claimed") throw new Error("expected a shared claim");
			claims.push(second.claim);
			expect(second.claim.shared).toBe(true);
			first.release();
			second.claim.release();
			expect(await copy.probeSessionOwner("s4")).toEqual({ state: "free" });
		} finally {
			delete copy.SessionOwnershipTestHooks.homeOverride;
		}
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

	it("refuses a home other users can write", async () => {
		await fs.chmod(home, 0o777);
		await expect(claimSessionOwner("s6", { surface: "terminal" })).rejects.toBeInstanceOf(SessionOwnershipError);
		expect((await probeSessionOwner("s6")).state).toBe("unknown");
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

	it.if(supported)("timed_out skips that one claim and the next claim tries again", async () => {
		let first = true;
		const calls = backend(sidecar => {
			if (!first) return tryAcquireFileLock(sidecar);
			first = false;
			return { status: FileLockAcquireStatus.TimedOut, code: "timed_out" };
		});
		expect(await claimSessionOwner("f4", { surface: "terminal" })).toEqual({
			status: "skipped",
			reason: "timed_out",
			code: "timed_out",
		});
		const claim = await claimed("f4");
		expect(claim.shared).toBe(false);
		expect(calls.acquire).toBe(2);
		expect(warnings).toEqual(["Session ownership claim timed out; this claim is skipped"]);
	});

	it("any other lock failure refuses, EACCES included", async () => {
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
		expect(error.operatorMessage).toBe(
			"Session 3f9a1c2e is open for writing in another terminal (pid 4242). Only one process can write a session at a time.",
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
		expect(phrase("terminal", "build-box")).toBe("gjc on build-box (pid 7)");
		expect(sessionOwnerHolderPhrase(undefined)).toBe("another gjc process");
	});
});

describe("dormant", () => {
	it("nothing in src uses the ownership module yet", async () => {
		const src = path.join(import.meta.dir, "../../src");
		const users: string[] = [];
		for await (const file of new Bun.Glob("**/*.ts").scan({ cwd: src })) {
			if (file === path.join("session", "session-ownership.ts")) continue;
			if (/session-ownership(?:\.[jt]s)?["']/.test(await Bun.file(path.join(src, file)).text())) users.push(file);
		}
		expect(users).toEqual([]);
	});

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
