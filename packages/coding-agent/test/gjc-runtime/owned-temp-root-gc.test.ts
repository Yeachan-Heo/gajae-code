import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createRunnerScriptCache } from "../../src/eval/py/runner-artifact";
import { defaultGcAdapters, type GcContext, type GcPidProbe } from "../../src/gjc-runtime/gc-runtime";
import {
	OWNED_TEMP_ROOT_PREFIXES,
	ownedTempRootOwnerPid,
	parseOwnedTempRootOwner,
	resolveTempRoot,
} from "../../src/gjc-runtime/owned-temp-root";
import { createOwnedTempRootGcAdapter } from "../../src/gjc-runtime/owned-temp-root-gc";
import { RevisionStore, trackedSpillDirectoriesForTest } from "../../src/sdk/host/query/revision-store";
import { createShellSnapshotCacheForTesting } from "../../src/utils/shell-snapshot";

const shellSnapshotsGcAdapter = createOwnedTempRootGcAdapter("shell_snapshots");

/**
 * Shell snapshot, SDK snapshot spill and Python runner roots are removed only by
 * a postmortem hook, which does not run when the process is killed. The owner
 * pid in the root name is what lets `gjc gc` prove a leftover root is abandoned.
 */

const DEAD_PID = 4_000_001;
const LIVE_PID = 4_000_002;

// Read the collector's actual PID namespace inode on Linux
let COLLECTOR_NS_INO: number | undefined;
if (process.platform === "linux") {
	try {
		COLLECTOR_NS_INO = fs.statSync("/proc/self/ns/pid").ino;
	} catch {
		// Fall back if we can't read the namespace
	}
}

const probe: GcPidProbe = pid =>
	pid === DEAD_PID ? { status: "dead" } : { status: "keep", reason: pid === LIVE_PID ? "alive" : "unknown" };

/**
 * Create a root name with the correct format for this platform.
 * On Linux, includes the namespace inode; on other platforms, omits it.
 */
function rootName(prefix: string, pid: number, random: string): string {
	if (process.platform === "linux" && COLLECTOR_NS_INO !== undefined) {
		return `${prefix}${pid}.${COLLECTOR_NS_INO}-${random}`;
	}
	return `${prefix}${pid}-${random}`;
}

const tempDirs: string[] = [];

function makeTmpRoot(): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gjc-owned-temp-root-gc-test-"));
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
	// Set TMPDIR, TEMP, and TMP all to tmpRoot for fixture isolation.
	// Prevents resolver from falling back to real process.env on any platform.
	return {
		probe: pidProbe,
		force: false,
		env: { ...process.env, TMPDIR: tmpRoot, TEMP: tmpRoot, TMP: tmpRoot },
		cwd: process.cwd(),
	};
}

afterEach(() => {
	for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("owned temp root naming", () => {
	it("encodes the creating process pid in the root name", async () => {
		const tmpRoot = makeTmpRoot();
		const home = path.join(tmpRoot, "home");
		fs.mkdirSync(home);
		const cache = createShellSnapshotCacheForTesting({ tempRoot: tmpRoot, home, platform: process.platform });
		try {
			expect(await cache.getOrCreateSnapshot("/bin/sh", { HOME: home, PATH: Bun.env.PATH })).not.toBeNull();
			const roots = fs.readdirSync(tmpRoot).filter(name => name.startsWith("gjc-shell-snapshots-"));
			expect(roots).toHaveLength(1);
			expect(ownedTempRootOwnerPid("shell_snapshots", roots[0])).toBe(process.pid);
			// On Linux, verify the namespace part is also emitted
			if (process.platform === "linux") {
				const owner = parseOwnedTempRootOwner("shell_snapshots", roots[0]);
				expect(owner?.pidNamespace).toBeDefined();
			}
		} finally {
			await cache.cleanup();
		}
	});

	it("encodes the creating process pid in the Python runner root name", async () => {
		const tmpRoot = makeTmpRoot();
		const cache = createRunnerScriptCache(tmpRoot);
		try {
			const script = await cache.ensureRunnerScript();
			const root = path.relative(tmpRoot, script).split(path.sep)[0];
			expect(ownedTempRootOwnerPid("python_runners", root)).toBe(process.pid);
			// On Linux, verify the namespace part is also emitted
			if (process.platform === "linux") {
				const owner = parseOwnedTempRootOwner("python_runners", root);
				expect(owner?.pidNamespace).toBeDefined();
			}
		} finally {
			await cache.cleanup();
		}
	});

	it("encodes the creating process pid in the SDK snapshot spill root name", async () => {
		const store = new RevisionStore("owned-temp-root-session");
		try {
			// Large enough to force a spill to disk.
			await store.createRevision("probe", "probe-resource", { body: "x".repeat(20 * 1024 * 1024) });
			const [spill] = trackedSpillDirectoriesForTest();
			expect(spill).toBeDefined();
			expect(ownedTempRootOwnerPid("sdk_snapshots", path.basename(spill))).toBe(process.pid);
			// On Linux, verify the namespace part is also emitted
			if (process.platform === "linux") {
				const owner = parseOwnedTempRootOwner("sdk_snapshots", path.basename(spill));
				expect(owner?.pidNamespace).toBeDefined();
			}
		} finally {
			await store.close();
		}
	});

	it("reads no owner from names that do not carry one", () => {
		expect(ownedTempRootOwnerPid("shell_snapshots", "gjc-shell-snapshots-AbC123")).toBeUndefined();
		expect(ownedTempRootOwnerPid("shell_snapshots", "gjc-shell-snapshots-0-AbC123")).toBeUndefined();
		expect(ownedTempRootOwnerPid("shell_snapshots", "gjc-shell-snapshots-12x-AbC123")).toBeUndefined();
		expect(ownedTempRootOwnerPid("shell_snapshots", "gjc-sdk-snapshots-12-AbC123")).toBeUndefined();
		expect(ownedTempRootOwnerPid("shell_snapshots", "gjc-shell-snapshots-12-AbC123")).toBe(12);
	});

	it("parses namespace inode from root names on Linux", () => {
		// Legacy format without namespace: should parse just the pid
		const legacy = parseOwnedTempRootOwner("shell_snapshots", "gjc-shell-snapshots-12-AbC123");
		expect(legacy).toEqual({ pid: 12, pidNamespace: undefined });

		// New format with namespace: should parse pid and namespace inode
		const withNs = parseOwnedTempRootOwner("shell_snapshots", "gjc-shell-snapshots-12.4026531956-AbC123");
		expect(withNs).toEqual({ pid: 12, pidNamespace: 4026531956 });

		// Invalid formats should return undefined
		expect(parseOwnedTempRootOwner("shell_snapshots", "gjc-shell-snapshots-12.0-AbC123")).toBeUndefined();
		expect(parseOwnedTempRootOwner("shell_snapshots", "gjc-shell-snapshots-0.4026531956-AbC123")).toBeUndefined();
		// Namespace values that would lose precision or overflow should be rejected
		expect(
			parseOwnedTempRootOwner("shell_snapshots", `gjc-shell-snapshots-12.${Number.MAX_SAFE_INTEGER + 1}-AbC123`),
		).toBeUndefined();
	});
});

describe("owned temp root GC", () => {
	it("registers one default gc store per owned temp root kind", async () => {
		const stores = (await defaultGcAdapters()).map(adapter => adapter.store);
		for (const kind of Object.keys(OWNED_TEMP_ROOT_PREFIXES)) expect(stores).toContain(kind as never);
	});

	it("scopes each store to its own prefix", async () => {
		const tmpRoot = makeTmpRoot();
		seedRoot(tmpRoot, rootName("gjc-shell-snapshots-", DEAD_PID, "Aaaaaa"));
		seedRoot(tmpRoot, rootName("gjc-sdk-snapshots-", DEAD_PID, "Bbbbbb"));
		seedRoot(tmpRoot, rootName("gjc-python-runner-", DEAD_PID, "Cccccc"));
		for (const [kind, prefix] of Object.entries(OWNED_TEMP_ROOT_PREFIXES)) {
			const adapter = createOwnedTempRootGcAdapter(kind as keyof typeof OWNED_TEMP_ROOT_PREFIXES);
			const { records } = await adapter.collect(ctxFor(tmpRoot));
			expect(records.map(record => ({ store: record.store, prefix: record.id.startsWith(prefix) }))).toEqual([
				{ store: kind as keyof typeof OWNED_TEMP_ROOT_PREFIXES, prefix: true },
			]);
			// Dead PID roots should be removable on all platforms (using actual namespace on Linux, PID-only on others)
			expect(records[0]?.removable).toBe(true);
		}
	});

	it("reports nothing when no snapshot roots exist", async () => {
		const tmpRoot = makeTmpRoot();
		fs.mkdirSync(path.join(tmpRoot, "unrelated"));
		expect(await shellSnapshotsGcAdapter.collect(ctxFor(tmpRoot))).toEqual({ records: [], errors: [] });
	});

	it("marks only a root whose owner is dead as removable", async () => {
		const tmpRoot = makeTmpRoot();
		const deadRootId = rootName("gjc-shell-snapshots-", DEAD_PID, "Aaaaaa");
		const liveRootId = rootName("gjc-shell-snapshots-", LIVE_PID, "Bbbbbb");
		seedRoot(tmpRoot, deadRootId);
		seedRoot(tmpRoot, liveRootId);
		seedRoot(tmpRoot, "gjc-shell-snapshots-Cccccc");

		const { records, errors } = await shellSnapshotsGcAdapter.collect(ctxFor(tmpRoot));
		expect(errors).toEqual([]);
		const byId = new Map(records.map(record => [record.id, record]));
		expect(byId.get(deadRootId)).toMatchObject({
			status: "dead",
			pid: DEAD_PID,
			pid_status: "dead",
			removable: true,
			action: "would_remove",
		});
		expect(byId.get(liveRootId)).toMatchObject({
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
		fs.symlinkSync(target, path.join(tmpRoot, rootName("gjc-shell-snapshots-", DEAD_PID, "Linkkk")));

		const [record] = (await shellSnapshotsGcAdapter.collect(ctxFor(tmpRoot))).records;
		expect(record).toMatchObject({ status: "not_directory", removable: false });
		expect(await shellSnapshotsGcAdapter.prune({ ...record, removable: true }, ctxFor(tmpRoot))).toMatchObject({
			removed: false,
		});
		expect(fs.existsSync(path.join(target, "snapshot-bash-1.sh"))).toBe(true);
	});

	it("removes a dead owner's root on prune", async () => {
		const tmpRoot = makeTmpRoot();
		const dir = seedRoot(tmpRoot, rootName("gjc-shell-snapshots-", DEAD_PID, "Aaaaaa"));
		const [record] = (await shellSnapshotsGcAdapter.collect(ctxFor(tmpRoot))).records;
		expect(await shellSnapshotsGcAdapter.prune(record, ctxFor(tmpRoot))).toEqual({ removed: true });
		expect(fs.existsSync(dir)).toBe(false);
	});

	it("re-probes at prune time and keeps a root whose pid came back to life", async () => {
		const tmpRoot = makeTmpRoot();
		const dir = seedRoot(tmpRoot, rootName("gjc-shell-snapshots-", DEAD_PID, "Aaaaaa"));
		const [record] = (await shellSnapshotsGcAdapter.collect(ctxFor(tmpRoot))).records;
		expect(record.removable).toBe(true);

		const reused: GcPidProbe = () => ({ status: "keep", reason: "alive" });
		const outcome = await shellSnapshotsGcAdapter.prune(record, ctxFor(tmpRoot, reused));
		expect(outcome.removed).toBe(false);
		expect(outcome.skipped).toContain("alive");
		expect(fs.existsSync(dir)).toBe(true);
	});

	it("uses Windows TEMP over TMPDIR to find Python runner roots", async () => {
		// On Windows, resolveTempRoot should check TEMP before TMPDIR.
		// This prevents orphaned Python runner roots when TMPDIR and TEMP differ.
		const tmproot_a = makeTmpRoot();
		const tmproot_b = makeTmpRoot();

		// Create a stale Python runner root in tmproot_b (TEMP)
		// Use legacy format (no namespace) since we're simulating Windows
		const stalePythonRoot = seedRoot(tmproot_b, `gjc-python-runner-${DEAD_PID}-Stale`);

		// On Windows with TMPDIR=a and TEMP=b, resolveTempRoot should return b
		const env = {
			...process.env,
			TMPDIR: tmproot_a,
			TEMP: tmproot_b,
		};
		expect(resolveTempRoot(env, "win32")).toBe(tmproot_b);

		// The collector (with injected win32 platform) should scan tmproot_b and find the stale root
		const pythonGcAdapter = createOwnedTempRootGcAdapter("python_runners", "win32");
		const ctx: GcContext = {
			probe,
			force: false,
			env,
			cwd: process.cwd(),
		};
		const { records } = await pythonGcAdapter.collect(ctx);
		expect(records).toHaveLength(1);
		expect(records[0]).toMatchObject({
			store: "python_runners",
			id: `gjc-python-runner-${DEAD_PID}-Stale`,
			path: stalePythonRoot,
			status: "dead",
			pid: DEAD_PID,
			removable: true,
		});
	});

	it("resolves Windows TMP when TEMP is not set", () => {
		// Windows fallback: if TEMP is not set, check TMP
		const tmproot = makeTmpRoot();
		const env = { TMP: tmproot };
		expect(resolveTempRoot(env, "win32")).toBe(tmproot);
	});

	it("falls through to TMP when TEMP is empty string", () => {
		// Empty string is falsy, so should fall through to TMP
		const tmproot = makeTmpRoot();
		const env = { TEMP: "", TMP: tmproot };
		expect(resolveTempRoot(env, "win32")).toBe(tmproot);
	});

	it("uses TMPDIR on POSIX platforms", () => {
		// On POSIX, TMPDIR takes precedence over TEMP
		const tmpdir_path = makeTmpRoot();
		const env = { TMPDIR: tmpdir_path, TEMP: "/tmp/other" };
		expect(resolveTempRoot(env, "linux")).toBe(tmpdir_path);
	});

	it.skipIf(process.platform !== "linux")(
		"keeps roots from different PID namespaces even if owner is dead",
		async () => {
			// On Linux, a root owned by a dead pid in a different namespace should be kept.
			// Critically: the pid is NOT probed when namespace doesn't match (fail-closed).
			const tmpRoot = makeTmpRoot();
			const foreignNsIno = 4026531956; // Example Linux PID namespace inode (different from collector)
			const rootName = `gjc-shell-snapshots-${DEAD_PID}.${foreignNsIno}-Aaaaaa`;
			const dir = seedRoot(tmpRoot, rootName);

			// Probe that tracks if pid was checked
			let pidProbed = false;
			const trackingProbe: GcPidProbe = pid => {
				pidProbed = true;
				return pid === DEAD_PID ? { status: "dead" } : { status: "keep", reason: "unknown" };
			};

			const { records, errors } = await shellSnapshotsGcAdapter.collect(ctxFor(tmpRoot, trackingProbe));
			expect(errors).toEqual([]);
			expect(records).toHaveLength(1);
			const record = records[0];
			expect(record.status).toBe("foreign_namespace");
			expect(record.removable).toBe(false);
			expect(record.action).toBe("none");
			expect(record.reason).toContain("different PID namespace");
			// Verify pid was NOT probed (fail-closed: foreign namespace means don't check pid)
			expect(pidProbed).toBe(false);
			// Verify the directory is not removed
			expect(fs.existsSync(dir)).toBe(true);
		},
	);

	it.skipIf(process.platform !== "linux")("removes roots matching collector's namespace with dead pid", async () => {
		// A root with namespace inode matching the collector's should be removed if the owner is dead.
		// This verifies that namespace matching doesn't prevent removal of truly dead processes.
		if (COLLECTOR_NS_INO === undefined) {
			// Skip if we can't read the collector's namespace
			return;
		}
		const tmpRoot = makeTmpRoot();
		// Create a root with the collector's actual namespace
		const rootName = `gjc-shell-snapshots-${DEAD_PID}.${COLLECTOR_NS_INO}-Aaaaaa`;
		const dir = seedRoot(tmpRoot, rootName);

		// This should remove it because namespace matches and pid is dead
		const { records } = await shellSnapshotsGcAdapter.collect(ctxFor(tmpRoot));
		expect(records).toHaveLength(1);
		expect(records[0]?.status).toBe("dead");
		expect(records[0]?.removable).toBe(true);
		const outcome = await shellSnapshotsGcAdapter.prune(records[0]!, ctxFor(tmpRoot));
		expect(outcome.removed).toBe(true);
		expect(fs.existsSync(dir)).toBe(false);
	});

	it.skipIf(process.platform !== "linux")("keeps roots without namespace part (legacy format)", async () => {
		// Roots created before namespace tracking was added are kept to be safe.
		// We cannot prove they belong to this namespace, so we do not prune them even if the pid is dead.
		// Critically: the pid is NOT probed (fail-closed).
		const tmpRoot = makeTmpRoot();
		const legacyName = `gjc-shell-snapshots-${DEAD_PID}-Aaaaaa`; // No namespace part
		const dir = seedRoot(tmpRoot, legacyName);

		// Probe that tracks if pid was checked
		let pidProbed = false;
		const trackingProbe: GcPidProbe = pid => {
			pidProbed = true;
			return pid === DEAD_PID ? { status: "dead" } : { status: "keep", reason: "unknown" };
		};

		const { records } = await shellSnapshotsGcAdapter.collect(ctxFor(tmpRoot, trackingProbe));
		expect(records).toHaveLength(1);
		const record = records[0];
		// Legacy roots without namespace part are kept, not removed
		expect(record).toMatchObject({
			status: "unowned",
			removable: false,
			action: "none",
		});
		expect(record.reason).toContain("namespace");
		// Verify pid was NOT probed (fail-closed: no namespace part means don't check pid on Linux)
		expect(pidProbed).toBe(false);
		// Verify the directory is not removed
		expect(fs.existsSync(dir)).toBe(true);
	});
});
