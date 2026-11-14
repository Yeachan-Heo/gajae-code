import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { defaultGcAdapters, type GcContext, type GcPidProbe } from "../../src/gjc-runtime/gc-runtime";
import { createShellSnapshotCacheForTesting, shellSnapshotRootOwnerPid } from "../../src/utils/shell-snapshot";
import { shellSnapshotsGcAdapter } from "../../src/utils/shell-snapshot-gc";

/**
 * A session's shell snapshot root is removed by a postmortem hook, which does
 * not run when the process is killed. The owner pid in the root name is what
 * lets `gjc gc` prove a leftover root is abandoned.
 */

const DEAD_PID = 4_000_001;
const LIVE_PID = 4_000_002;

const probe: GcPidProbe = pid =>
	pid === DEAD_PID ? { status: "dead" } : { status: "keep", reason: pid === LIVE_PID ? "alive" : "unknown" };

const tempDirs: string[] = [];

function makeTmpRoot(): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gjc-shell-snapshot-gc-test-"));
	tempDirs.push(dir);
	return dir;
}

function seedRoot(tmpRoot: string, name: string): string {
	const dir = path.join(tmpRoot, name);
	fs.mkdirSync(dir, { mode: 0o700 });
	fs.writeFileSync(path.join(dir, "snapshot-bash-1.sh"), "alias ll='ls -l'\n");
	return dir;
}

function ctxFor(tmpRoot: string, pidProbe: GcPidProbe = probe): GcContext {
	return { probe: pidProbe, force: false, env: { ...process.env, TMPDIR: tmpRoot }, cwd: process.cwd() };
}

afterEach(() => {
	for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("shell snapshot root naming", () => {
	it("encodes the creating process pid in the root name", async () => {
		const tmpRoot = makeTmpRoot();
		const home = path.join(tmpRoot, "home");
		fs.mkdirSync(home);
		const cache = createShellSnapshotCacheForTesting({ tempRoot: tmpRoot, home, platform: process.platform });
		try {
			expect(await cache.getOrCreateSnapshot("/bin/sh", { HOME: home, PATH: Bun.env.PATH })).not.toBeNull();
			const roots = fs.readdirSync(tmpRoot).filter(name => name.startsWith("gjc-shell-snapshots-"));
			expect(roots).toHaveLength(1);
			expect(shellSnapshotRootOwnerPid(roots[0])).toBe(process.pid);
		} finally {
			await cache.cleanup();
		}
	});

	it("reads no owner from names that do not carry one", () => {
		expect(shellSnapshotRootOwnerPid("gjc-shell-snapshots-AbC123")).toBeUndefined();
		expect(shellSnapshotRootOwnerPid("gjc-shell-snapshots-0-AbC123")).toBeUndefined();
		expect(shellSnapshotRootOwnerPid("gjc-shell-snapshots-12x-AbC123")).toBeUndefined();
		expect(shellSnapshotRootOwnerPid("other-12-AbC123")).toBeUndefined();
		expect(shellSnapshotRootOwnerPid("gjc-shell-snapshots-12-AbC123")).toBe(12);
	});
});

describe("shell snapshot GC", () => {
	it("is one of the default gc stores", async () => {
		expect((await defaultGcAdapters()).map(adapter => adapter.store)).toContain("shell_snapshots");
	});

	it("reports nothing when no snapshot roots exist", async () => {
		const tmpRoot = makeTmpRoot();
		fs.mkdirSync(path.join(tmpRoot, "unrelated"));
		expect(await shellSnapshotsGcAdapter.collect(ctxFor(tmpRoot))).toEqual({ records: [], errors: [] });
	});

	it("marks only a root whose owner is dead as removable", async () => {
		const tmpRoot = makeTmpRoot();
		seedRoot(tmpRoot, `gjc-shell-snapshots-${DEAD_PID}-Aaaaaa`);
		seedRoot(tmpRoot, `gjc-shell-snapshots-${LIVE_PID}-Bbbbbb`);
		seedRoot(tmpRoot, "gjc-shell-snapshots-Cccccc");

		const { records, errors } = await shellSnapshotsGcAdapter.collect(ctxFor(tmpRoot));
		expect(errors).toEqual([]);
		const byId = new Map(records.map(record => [record.id, record]));
		expect(byId.get(`gjc-shell-snapshots-${DEAD_PID}-Aaaaaa`)).toMatchObject({
			status: "dead",
			pid: DEAD_PID,
			pid_status: "dead",
			removable: true,
			action: "would_remove",
		});
		expect(byId.get(`gjc-shell-snapshots-${LIVE_PID}-Bbbbbb`)).toMatchObject({
			status: "alive",
			pid: LIVE_PID,
			removable: false,
			action: "none",
		});
		expect(byId.get("gjc-shell-snapshots-Cccccc")).toMatchObject({ status: "unowned", removable: false });
	});

	it("never follows a symlink that carries a snapshot root name", async () => {
		const tmpRoot = makeTmpRoot();
		const target = seedRoot(tmpRoot, "precious");
		fs.symlinkSync(target, path.join(tmpRoot, `gjc-shell-snapshots-${DEAD_PID}-Linkkk`));

		const [record] = (await shellSnapshotsGcAdapter.collect(ctxFor(tmpRoot))).records;
		expect(record).toMatchObject({ status: "not_directory", removable: false });
		expect(await shellSnapshotsGcAdapter.prune({ ...record, removable: true }, ctxFor(tmpRoot))).toMatchObject({
			removed: false,
		});
		expect(fs.existsSync(path.join(target, "snapshot-bash-1.sh"))).toBe(true);
	});

	it("removes a dead owner's root on prune", async () => {
		const tmpRoot = makeTmpRoot();
		const dir = seedRoot(tmpRoot, `gjc-shell-snapshots-${DEAD_PID}-Aaaaaa`);
		const [record] = (await shellSnapshotsGcAdapter.collect(ctxFor(tmpRoot))).records;
		expect(await shellSnapshotsGcAdapter.prune(record, ctxFor(tmpRoot))).toEqual({ removed: true });
		expect(fs.existsSync(dir)).toBe(false);
	});

	it("re-probes at prune time and keeps a root whose pid came back to life", async () => {
		const tmpRoot = makeTmpRoot();
		const dir = seedRoot(tmpRoot, `gjc-shell-snapshots-${DEAD_PID}-Aaaaaa`);
		const [record] = (await shellSnapshotsGcAdapter.collect(ctxFor(tmpRoot))).records;
		expect(record.removable).toBe(true);

		const reused: GcPidProbe = () => ({ status: "keep", reason: "alive" });
		const outcome = await shellSnapshotsGcAdapter.prune(record, ctxFor(tmpRoot, reused));
		expect(outcome.removed).toBe(false);
		expect(outcome.skipped).toContain("alive");
		expect(fs.existsSync(dir)).toBe(true);
	});
});
