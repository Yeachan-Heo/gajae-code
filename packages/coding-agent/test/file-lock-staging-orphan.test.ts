import { afterEach, expect, test, vi } from "bun:test";
import * as syncFs from "node:fs";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { inspectFileLockStagingDir, reapOrphanedLockStagingDirs, withFileLock } from "../src/config/file-lock";
import { collectFileLocksForGc, fileLocksGcAdapter } from "../src/config/file-lock-gc";
import type { GcContext } from "../src/gjc-runtime/gc-runtime";

const DEAD_PID = 525252;
const roots: string[] = [];
const uuid = "12345678-1234-1234-1234-123456789abc";
afterEach(async () => {
	vi.restoreAllMocks();
	for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
});
async function fixture(pid = DEAD_PID, info: object | null = { pid, timestamp: 1 }) {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "staging-orphan-"));
	roots.push(root);
	const file = path.join(root, "index.jsonl");
	const staging = `${file}.lock.pending.${pid}.${uuid}`;
	await fs.mkdir(staging);
	if (info) await Bun.write(path.join(staging, "info"), JSON.stringify(info));
	return { root, file, staging };
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
	const { file, staging } = await fixture(DEAD_PID, hasInfo ? { pid: DEAD_PID, timestamp: 1 } : null);
	deadPid();
	expect(await withFileLock(file, async () => "acquired")).toBe("acquired");
	expect(await fs.exists(staging)).toBe(false);
});

test.each([true, false])("GC discovers and prunes dead staging (info=%s)", async hasInfo => {
	const { root, staging } = await fixture(DEAD_PID, hasInfo ? { pid: DEAD_PID, timestamp: 1 } : null);
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

test.each([true, false])("current process staging is retained (info=%s)", async hasInfo => {
	const { staging } = await fixture(process.pid, hasInfo ? { pid: process.pid, timestamp: 1 } : null);
	const probe = vi.fn(() => "dead" as const);
	expect((await inspectFileLockStagingDir(staging, probe, true)).status).toBe("alive");
	expect(probe).not.toHaveBeenCalled();
	expect(await fs.exists(staging)).toBe(true);
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
	const { staging } = await fixture(DEAD_PID, { broken: true });
	expect((await inspectFileLockStagingDir(staging, () => "dead", true)).removed).toBe(false);
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
	for (let index = 1; index <= 64; index++) {
		await fs.mkdir(
			`${file}.lock.pending.${DEAD_PID}.${index.toString(16).padStart(8, "0")}-1234-1234-1234-123456789abc`,
		);
	}
	deadPid();
	const summary = await reapOrphanedLockStagingDirs(`${file}.lock`);
	expect(summary.removed).toHaveLength(64);
	expect((await fs.readdir(root)).filter(entry => entry.includes(".pending."))).toHaveLength(1);
	await reapOrphanedLockStagingDirs(`${file}.lock`);
	expect(await fs.exists(staging)).toBe(false);
});
