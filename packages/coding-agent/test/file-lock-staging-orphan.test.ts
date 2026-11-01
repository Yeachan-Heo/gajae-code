import { afterEach, expect, test, vi } from "bun:test";
import * as crypto from "node:crypto";
import * as syncFs from "node:fs";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
	FileLockTestHooks,
	fileLockStagingOwnerPid,
	inspectFileLockStagingDir,
	processStartTime,
	reapOrphanedLockStagingDirs,
	withFileLock,
} from "../src/config/file-lock";
import { collectFileLocksForGc, fileLocksGcAdapter } from "../src/config/file-lock-gc";
import type { GcContext } from "../src/gjc-runtime/gc-runtime";

const DEAD_PID = 525252;
const LOCAL_HOST_ID = "staging-orphan-local-host";
const UNVERIFIED_STAGING_GRACE_MS = 60_000;
const roots: string[] = [];
const uuid = "12345678-1234-1234-1234-123456789abc";
afterEach(async () => {
	vi.restoreAllMocks();
	FileLockTestHooks.nativeQuarantineBindings = undefined;
	FileLockTestHooks.stagingIdentityEvidence = undefined;
	FileLockTestHooks.processIncarnation = undefined;
	FileLockTestHooks.afterStagingInfoWrite = undefined;
	for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
});
async function fixture(
	pid = DEAD_PID,
	info: object | null = { pid, timestamp: 1 },
	startTime = pid === process.pid ? (processStartTime(pid) ?? "unknown") : "fixture-start-time",
	ownerHostId?: string,
) {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "staging-orphan-"));
	roots.push(root);
	const file = path.join(root, "index.jsonl");
	const encodedStartTime = `s${crypto.createHash("sha256").update(startTime, "utf8").digest("base64url").slice(0, 16)}`;
	const stagingHostIdentity = ownerHostId
		? `h${crypto.createHash("sha256").update(ownerHostId, "utf8").digest("base64url").slice(0, 16)}.`
		: "";
	const staging = `${file}.lock.pending.${pid}.${stagingHostIdentity}${encodedStartTime}.1234567890123456`;
	await fs.mkdir(staging);
	if (info) await Bun.write(path.join(staging, "info"), JSON.stringify(info));
	return { root, file, staging };
}
async function ageStaging(staging: string) {
	const old = new Date(Date.now() - UNVERIFIED_STAGING_GRACE_MS - 1);
	const infoPath = path.join(staging, "info");
	if (await Bun.file(infoPath).exists()) await fs.utimes(infoPath, old, old);
	await fs.utimes(staging, old, old);
}
function deadPid() {
	vi.spyOn(process, "kill").mockImplementation(pid => {
		if (pid === DEAD_PID) throw Object.assign(new Error("dead"), { code: "ESRCH" });
		return true;
	});
}
function context(root: string): GcContext {
	return { cwd: root, env: {}, force: false, probe: () => ({ status: "dead" }) };
}

test.each([true, false])("acquisition reaps dead staging (info=%s)", async hasInfo => {
	const { file, staging } = await fixture(
		DEAD_PID,
		hasInfo ? { pid: DEAD_PID, timestamp: 1, owner_host_id: LOCAL_HOST_ID } : null,
		"fixture-start-time",
		LOCAL_HOST_ID,
	);
	if (!hasInfo) await ageStaging(staging);
	deadPid();
	expect(await withFileLock(file, async () => "acquired", { ownerHostId: LOCAL_HOST_ID })).toBe("acquired");
	expect(await fs.exists(staging)).toBe(false);
});

test("GC discovers and prunes a dead staging owner with verified info", async () => {
	const { root, staging } = await fixture(DEAD_PID, { pid: DEAD_PID, timestamp: 1 });
	const ctx = context(root);
	const collected = await collectFileLocksForGc(ctx, { roots: [root] });
	expect(collected.errors).toEqual([]);
	expect(collected.records).toHaveLength(1);
	const record = collected.records[0]!;
	expect(record.status).toBe("file_lock_staging_orphan");
	expect(record.removable).toBe(true);
	expect(await fileLocksGcAdapter.prune(record, ctx)).toEqual({ removed: true });
	expect(await fs.exists(staging)).toBe(false);
});

test("GC retains old unverified staging without a local host identity", async () => {
	const { root, staging } = await fixture(DEAD_PID, null);
	await ageStaging(staging);
	const ctx = context(root);
	const collected = await collectFileLocksForGc(ctx, { roots: [root] });
	expect(collected.errors).toEqual([]);
	expect(collected.records).toHaveLength(1);
	const record = collected.records[0]!;
	expect(record.removable).toBe(false);
	expect(await fileLocksGcAdapter.prune(record, ctx)).toEqual({
		removed: false,
		skipped: "unverified_staging_directory",
	});
	expect(await fs.exists(staging)).toBe(true);
});

test("staging names carry a hashed host identity when the caller provides one", async () => {
	const { file } = await fixture();
	FileLockTestHooks.stagingIdentityEvidence = () => ({ processIncarnation: null, startTime: null });
	let stagingPath: string | undefined;
	FileLockTestHooks.afterStagingInfoWrite = path => {
		stagingPath = path;
	};
	const hostIdHash = crypto.createHash("sha256").update(LOCAL_HOST_ID, "utf8").digest("base64url").slice(0, 16);

	expect(await withFileLock(file, async () => "acquired", { ownerHostId: LOCAL_HOST_ID })).toBe("acquired");
	if (!stagingPath) throw new Error("expected staging path to be observed");
	expect(path.basename(stagingPath)).toContain(`.pending.${process.pid}.h${hostIdHash}.`);
	expect(fileLockStagingOwnerPid(path.basename(stagingPath))).toBe(process.pid);
});

test("reaps a same-host staging owner after its pid is proven dead", async () => {
	const { file, staging } = await fixture(
		DEAD_PID,
		{
			pid: DEAD_PID,
			timestamp: 1,
			owner_host_id: LOCAL_HOST_ID,
			process_incarnation: "dead-owner-incarnation",
		},
		"fixture-start-time",
		LOCAL_HOST_ID,
	);
	deadPid();

	expect(await withFileLock(file, async () => "acquired", { ownerHostId: LOCAL_HOST_ID })).toBe("acquired");
	expect(await fs.exists(staging)).toBe(false);
});

test("accepts a previous local host id when reaping staging owners", async () => {
	const previousHostId = "previous-local-host";
	const { file, staging } = await fixture(
		DEAD_PID,
		{
			pid: DEAD_PID,
			timestamp: 1,
			owner_host_id: previousHostId,
		},
		"fixture-start-time",
		previousHostId,
	);
	deadPid();

	const summary = await reapOrphanedLockStagingDirs(`${file}.lock`, {
		ownerHostId: LOCAL_HOST_ID,
		previousOwnerHostIds: [previousHostId],
	});
	expect(summary.removed).toEqual([staging]);
	expect(await fs.exists(staging)).toBe(false);
});

test("keeps foreign-host staging owners even when the local pid is dead", async () => {
	const { file, staging } = await fixture(DEAD_PID, {
		pid: DEAD_PID,
		timestamp: 1,
		owner_host_id: "different-host",
	});
	await ageStaging(staging);
	deadPid();

	const summary = await reapOrphanedLockStagingDirs(`${file}.lock`, { ownerHostId: LOCAL_HOST_ID });
	expect(summary.removed).toEqual([]);
	expect(summary.retained).toMatchObject([{ pid: DEAD_PID, reason: "host_qualified_staging_owner" }]);
	expect(await fs.exists(staging)).toBe(true);
});

test("does not age-reap unverified staging whose name identifies a foreign host", async () => {
	const { staging } = await fixture(DEAD_PID, null, "fixture-start-time", "different-host");
	await ageStaging(staging);
	const probe = vi.fn(() => "dead" as const);

	const result = await inspectFileLockStagingDir(staging, probe, true, LOCAL_HOST_ID);
	expect(result).toMatchObject({ pid: DEAD_PID, status: "unknown", removed: false });
	expect(result.reason).toBe("host_qualified_staging_owner");
	expect(probe).not.toHaveBeenCalled();
	expect(await fs.exists(staging)).toBe(true);
});

test("does not age-reap a legacy unverified staging name without host provenance", async () => {
	const { staging } = await fixture(DEAD_PID, null);
	await ageStaging(staging);
	deadPid();

	const result = await inspectFileLockStagingDir(staging, () => "dead", true, LOCAL_HOST_ID);
	expect(result).toMatchObject({ pid: DEAD_PID, status: "unknown", removed: false });
	expect(result.reason).toBe("unverified_staging_directory");
	expect(await fs.exists(staging)).toBe(true);
});

test("reaps a local staging owner when its recorded process incarnation was replaced", async () => {
	const { staging } = await fixture(
		process.pid,
		{
			pid: process.pid,
			timestamp: 1,
			owner_host_id: LOCAL_HOST_ID,
			process_incarnation: "previous-incarnation",
		},
		"previous-process-generation",
	);
	FileLockTestHooks.processIncarnation = pid => (pid === process.pid ? "current-incarnation" : null);

	const result = await inspectFileLockStagingDir(staging, () => "alive", true, LOCAL_HOST_ID);
	expect(result).toMatchObject({ pid: process.pid, status: "dead", removed: true });
	expect(await fs.exists(staging)).toBe(false);
});

test.each(["missing", "empty"] as const)("retains %s info until the unverified grace period expires", async kind => {
	const { staging } = await fixture(DEAD_PID, null, "fixture-start-time", LOCAL_HOST_ID);
	if (kind === "empty") await fs.writeFile(path.join(staging, "info"), "");
	deadPid();

	const result = await inspectFileLockStagingDir(staging, () => "dead", true, LOCAL_HOST_ID);
	expect(result).toMatchObject({ pid: DEAD_PID, status: "unknown", removed: false });
	expect(result.reason).toBe("unverified_staging_directory");
	expect(await fs.exists(staging)).toBe(true);
});

test.each(["missing", "empty"] as const)("reaps old %s info only after its owner is dead", async kind => {
	const { staging } = await fixture(DEAD_PID, null, "fixture-start-time", LOCAL_HOST_ID);
	if (kind === "empty") await fs.writeFile(path.join(staging, "info"), "");
	await ageStaging(staging);
	deadPid();

	const result = await inspectFileLockStagingDir(staging, () => "dead", true, LOCAL_HOST_ID);
	expect(result).toMatchObject({ pid: DEAD_PID, status: "dead", removed: true, reason: "removed" });
	expect(await fs.exists(staging)).toBe(false);
});

test("never reaps an old unverified staging directory owned by a live process", async () => {
	const { staging } = await fixture(process.pid, null, processStartTime(process.pid) ?? "unknown", LOCAL_HOST_ID);
	await ageStaging(staging);

	const result = await inspectFileLockStagingDir(staging, () => "alive", true, LOCAL_HOST_ID);
	expect(result).toMatchObject({ pid: process.pid, status: "alive", removed: false });
	expect(await fs.exists(staging)).toBe(true);
});

test.each([true, false])("current process staging is retained (info=%s)", async hasInfo => {
	const { staging } = await fixture(process.pid, hasInfo ? { pid: process.pid, timestamp: 1 } : null);
	const probe = vi.fn(() => "dead" as const);
	expect((await inspectFileLockStagingDir(staging, probe, true)).status).toBe("alive");
	expect(probe).not.toHaveBeenCalled();
	expect(await fs.exists(staging)).toBe(true);
});

test.each(["alive", "unknown"] as const)("unproven staging owner is skipped before snapshotting (%s)", async status => {
	const { staging } = await fixture(DEAD_PID, { pid: DEAD_PID, timestamp: 1 }, "unknown");
	const probe = vi.fn(() => status);
	const snapshot = vi.fn(() => {
		throw new Error("unproven staging owner must not be snapshotted");
	});
	FileLockTestHooks.nativeQuarantineBindings = () => ({
		snapshotDirectoryTree: snapshot,
		exactRemoveDirectoryTree: () => ({ ok: false, code: "identity_mismatch" }),
	});

	const result = await inspectFileLockStagingDir(staging, probe, true);
	expect(result).toMatchObject({ pid: DEAD_PID, status, removed: false });
	expect(probe).toHaveBeenCalledWith(DEAD_PID);
	expect(snapshot).not.toHaveBeenCalled();
	expect(await fs.exists(staging)).toBe(true);
});

test.each(["unknown", "start-time"] as const)("probes liveness for old synthetic %s staging identities", async kind => {
	const startTime = processStartTime(process.pid);
	if (!startTime) throw new Error("Expected a process start time for this regression test");
	const ownerStartTime = kind === "unknown" ? "unknown" : startTime;
	const { file, staging } = await fixture(
		process.pid,
		{
			pid: process.pid,
			timestamp: 1,
			start_time: ownerStartTime,
			start_time_format: "utc-v1",
		},
		"fixture-start-time",
	);
	const encoded = crypto
		.createHash("sha256")
		.update(`${process.pid}:${ownerStartTime}`, "utf8")
		.digest("base64url")
		.slice(0, 16);
	const syntheticStaging = `${file}.lock.pending.${process.pid}.s${encoded}.1234567890123456`;
	await fs.rename(staging, syntheticStaging);
	const probe = vi.fn(() => "alive" as const);
	const snapshot = vi.fn(() => {
		throw new Error("live synthetic staging owner must not be snapshotted");
	});
	FileLockTestHooks.nativeQuarantineBindings = () => ({
		snapshotDirectoryTree: snapshot,
		exactRemoveDirectoryTree: () => ({ ok: false, code: "identity_mismatch" }),
	});

	const result = await inspectFileLockStagingDir(syntheticStaging, probe, true);
	expect(result).toMatchObject({ pid: process.pid, status: "alive", removed: false });
	expect(probe).toHaveBeenCalledWith(process.pid);
	expect(snapshot).not.toHaveBeenCalled();
	expect(await fs.exists(syntheticStaging)).toBe(true);
});

test.each(["alive", "unknown"] as const)("legacy fallback staging retains a %s owner", async status => {
	const { file, staging } = await fixture(DEAD_PID, {
		pid: DEAD_PID,
		timestamp: 1,
		start_time: "later-known-start-time",
		start_time_format: "utc-v1",
	});
	const legacyStaging = `${file}.lock.pending.${DEAD_PID}.${uuid}`;
	await fs.rename(staging, legacyStaging);
	const probe = vi.fn(() => status);
	const snapshot = vi.fn(() => {
		throw new Error("unproven legacy owner must not be snapshotted");
	});
	FileLockTestHooks.nativeQuarantineBindings = () => ({
		snapshotDirectoryTree: snapshot,
		exactRemoveDirectoryTree: () => ({ ok: false, code: "identity_mismatch" }),
	});

	const result = await inspectFileLockStagingDir(legacyStaging, probe, true);
	expect(result).toMatchObject({ pid: DEAD_PID, status, removed: false });
	expect(probe).toHaveBeenCalledWith(DEAD_PID);
	expect(snapshot).not.toHaveBeenCalled();
	expect(await fs.exists(legacyStaging)).toBe(true);
});

test("reaps old staging after its name-encoded PID is reused", async () => {
	const { staging } = await fixture(
		process.pid,
		{ pid: process.pid, timestamp: 1, start_time: "old-process-incarnation", start_time_format: "utc-v1" },
		"old-process-incarnation",
	);
	const probe = vi.fn(() => "alive" as const);

	const result = await inspectFileLockStagingDir(staging, probe, true);
	expect(result).toMatchObject({ pid: process.pid, status: "dead", removed: true });
	expect(await fs.exists(staging)).toBe(false);
});

test("record pid is authoritative over a dead name pid", async () => {
	const { staging } = await fixture(DEAD_PID, { pid: process.pid, timestamp: 1 });
	expect((await inspectFileLockStagingDir(staging, () => "dead", true)).removed).toBe(false);
});

test.each(["alive", "unknown"] as const)("missing info retains %s owner", async status => {
	const { staging } = await fixture(DEAD_PID, null);
	expect((await inspectFileLockStagingDir(staging, () => status, true)).status).toBe(status);
	expect(await fs.exists(staging)).toBe(true);
});

test("reaps a legacy staging name after its PID is proven dead", async () => {
	const { file, staging } = await fixture();
	const legacyStaging = `${file}.lock.pending.${DEAD_PID}.${uuid}`;
	await fs.rename(staging, legacyStaging);
	deadPid();

	const summary = await reapOrphanedLockStagingDirs(`${file}.lock`);
	expect(summary.removed).toEqual([legacyStaging]);
	expect(await fs.exists(legacyStaging)).toBe(false);
});

test("reaps bounded staging names for long lock basenames", async () => {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "staging-orphan-long-name-"));
	roots.push(root);
	const file = path.join(root, "x".repeat(220));
	const lockPath = `${file}.lock`;
	const basenameHash = crypto.createHash("sha256").update(path.basename(lockPath)).digest("hex");
	const hostIdHash = crypto.createHash("sha256").update(LOCAL_HOST_ID, "utf8").digest("base64url").slice(0, 16);
	const staging = path.join(root, `.gjc-lock-${basenameHash}.pending.${DEAD_PID}.h${hostIdHash}.${uuid}`);
	await fs.mkdir(staging);
	await ageStaging(staging);
	deadPid();

	const summary = await reapOrphanedLockStagingDirs(lockPath, { ownerHostId: LOCAL_HOST_ID });
	expect(summary.removed).toEqual([staging]);
	expect(summary.retained).toEqual([]);
	expect(await fs.exists(staging)).toBe(false);
});

test("symlink candidate and malformed names are untouched", async () => {
	const { root, file, staging } = await fixture();
	const target = path.join(root, "target");
	await fs.rename(staging, target);
	await fs.symlink(target, staging);
	const malformed = `${file}.lock.pending.${DEAD_PID}.not-a-uuid`;
	await fs.mkdir(malformed);
	deadPid();
	const result = await reapOrphanedLockStagingDirs(`${file}.lock`);
	expect(result.removed).toEqual([]);
	expect(result.retained).toHaveLength(1);
	expect((await fs.lstat(staging)).isSymbolicLink()).toBe(true);
	expect(await Bun.file(path.join(target, "info")).exists()).toBe(true);
	expect(await fs.exists(malformed)).toBe(true);
});

test("malformed info is not treated as missing", async () => {
	const { staging } = await fixture(DEAD_PID, { broken: true }, "fixture-start-time", LOCAL_HOST_ID);
	await ageStaging(staging);
	expect((await inspectFileLockStagingDir(staging, () => "dead", true, LOCAL_HOST_ID)).removed).toBe(false);
});

test("staging removed after discovery is reported as already gone", async () => {
	const { staging } = await fixture(DEAD_PID, null);
	await fs.rm(staging, { recursive: true });
	const probe = vi.fn(() => "dead" as const);
	expect(await inspectFileLockStagingDir(staging, probe, true)).toEqual({
		path: staging,
		status: "unknown",
		removed: false,
		reason: "enoent_already_gone",
	});
	expect(probe).not.toHaveBeenCalled();
});

test("reaping a staging entry that vanishes after readdir does not throw", async () => {
	const { file, staging } = await fixture(DEAD_PID, null);
	const name = path.basename(staging);
	await fs.rm(staging, { recursive: true });
	vi.spyOn(fs, "readdir").mockResolvedValueOnce([name] as never);
	deadPid();
	const summary = await reapOrphanedLockStagingDirs(`${file}.lock`);
	expect(summary.removed).toEqual([]);
	expect(summary.retained).toEqual([
		{ path: staging, status: "unknown", removed: false, reason: "enoent_already_gone" },
	]);
});

test("acquisition succeeds despite reaper probe failure", async () => {
	const { file, staging } = await fixture();
	vi.spyOn(fs, "readdir").mockRejectedValueOnce(new Error("reap denied"));
	expect(await withFileLock(file, async () => 42)).toBe(42);
	expect(await fs.exists(staging)).toBe(true);
});

test("empty staging replacement during probe never inherits deletion authority", async () => {
	const { staging } = await fixture(DEAD_PID, null);
	const original = `${staging}.old`;
	const probe = vi.fn(() => {
		syncFs.renameSync(staging, original);
		syncFs.mkdirSync(staging);
		return "dead" as const;
	});
	expect((await inspectFileLockStagingDir(staging, probe, true)).removed).toBe(false);
	expect(await fs.exists(staging)).toBe(true);
});

test.each(["alive", "eperm", "unknown"] as const)("GC keeps %s staging owners", async reason => {
	const { root, staging } = await fixture();
	const ctx: GcContext = { ...context(root), probe: () => ({ status: "keep", reason }) };
	const { records } = await collectFileLocksForGc(ctx, { roots: [root] });
	expect(records[0]?.removable).toBe(false);
	expect((await fileLocksGcAdapter.prune(records[0]!, ctx)).removed).toBe(false);
	expect(await fs.exists(staging)).toBe(true);
});

test("GC discovers session index staging without entering session payload trees", async () => {
	const { root, staging } = await fixture();
	const sessions = path.join(root, "sdk", "sessions");
	await fs.mkdir(sessions, { recursive: true });
	await fs.rename(staging, path.join(sessions, path.basename(staging)));
	const payload = path.join(sessions, "payload");
	await fs.mkdir(payload);
	await fs.mkdir(path.join(payload, path.basename(staging)));
	const { records } = await collectFileLocksForGc(context(root), { roots: [root] });
	expect(records.map(record => record.path)).toEqual([path.join(sessions, path.basename(staging))]);
});

test("opportunistic reaping processes at most 64 candidates", async () => {
	const { root, file, staging } = await fixture(DEAD_PID, null);
	await Bun.write(path.join(staging, "info"), JSON.stringify({ pid: DEAD_PID, timestamp: 1 }));
	await ageStaging(staging);
	for (let index = 1; index <= 64; index++) {
		const candidate = `${file}.lock.pending.${DEAD_PID}.${index.toString(16).padStart(8, "0")}-1234-1234-1234-123456789abc`;
		await fs.mkdir(candidate);
		await Bun.write(path.join(candidate, "info"), JSON.stringify({ pid: DEAD_PID, timestamp: 1 }));
	}
	deadPid();
	const summary = await reapOrphanedLockStagingDirs(`${file}.lock`);
	expect(summary.removed).toHaveLength(64);
	expect((await fs.readdir(root)).filter(entry => entry.includes(".pending."))).toHaveLength(1);
	await reapOrphanedLockStagingDirs(`${file}.lock`);
	expect((await fs.readdir(root)).filter(entry => entry.includes(".pending."))).toHaveLength(0);
});

test("reaper advances beyond a 64-entry window of foreign-host staging owners", async () => {
	const { root, file, staging } = await fixture(DEAD_PID, null);
	await fs.rm(staging, { recursive: true });
	const foreignStagingDirs: string[] = [];
	for (let index = 0; index < 64; index++) {
		const suffix = `${index.toString(16).padStart(8, "0")}-1234-1234-1234-123456789abc`;
		const foreignStaging = `${file}.lock.pending.${DEAD_PID}.${suffix}`;
		foreignStagingDirs.push(foreignStaging);
		await fs.mkdir(foreignStaging);
		await Bun.write(
			path.join(foreignStaging, "info"),
			JSON.stringify({ pid: DEAD_PID, timestamp: 1, owner_host_id: "different-host" }),
		);
	}
	const localStaging = `${file}.lock.pending.${DEAD_PID}.ffffffff-1234-1234-1234-123456789abc`;
	await fs.mkdir(localStaging);
	await Bun.write(
		path.join(localStaging, "info"),
		JSON.stringify({ pid: DEAD_PID, timestamp: 1, owner_host_id: LOCAL_HOST_ID }),
	);
	deadPid();

	const first = await reapOrphanedLockStagingDirs(`${file}.lock`, { ownerHostId: LOCAL_HOST_ID });
	const second = await reapOrphanedLockStagingDirs(`${file}.lock`, { ownerHostId: LOCAL_HOST_ID });
	expect([...first.removed, ...second.removed]).toContain(localStaging);
	expect(await fs.exists(localStaging)).toBe(false);
	expect(await Promise.all(foreignStagingDirs.map(fs.exists))).toEqual(Array(64).fill(true));
	expect((await fs.readdir(root)).filter(entry => entry.includes(".pending."))).toHaveLength(64);
});
