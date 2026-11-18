import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createRunnerScriptCache } from "../../src/eval/py/runner-artifact";
import { defaultGcAdapters, type GcContext, type GcPidProbe } from "../../src/gjc-runtime/gc-runtime";
import {
	currentOwnerScope,
	OWNED_TEMP_ROOT_PREFIXES,
	ownerScopeOf,
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

// This collector's own owner scope on Linux (host boot id + PID namespace); undefined elsewhere.
const OWN_SCOPE = currentOwnerScope();
// A scope no real host produces: the sha256 prefix of a boot id + namespace pair is never all zero
// in practice, and it stands in for a root written by another host or container.
const FOREIGN_SCOPE = "0000000000000000";

const probe: GcPidProbe = pid =>
	pid === DEAD_PID ? { status: "dead" } : { status: "keep", reason: pid === LIVE_PID ? "alive" : "unknown" };

/** Root name in this platform's format: with this collector's scope on Linux, pid-only elsewhere. */
function rootName(prefix: string, pid: number, random: string): string {
	return OWN_SCOPE !== undefined ? `${prefix}${pid}.${OWN_SCOPE}-${random}` : `${prefix}${pid}-${random}`;
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
			expect(parseOwnedTempRootOwner("shell_snapshots", roots[0])?.pid).toBe(process.pid);
			expect(parseOwnedTempRootOwner("shell_snapshots", roots[0])?.scope).toBe(OWN_SCOPE);
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
			expect(parseOwnedTempRootOwner("python_runners", root)?.pid).toBe(process.pid);
			expect(parseOwnedTempRootOwner("python_runners", root)?.scope).toBe(OWN_SCOPE);
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
			expect(parseOwnedTempRootOwner("sdk_snapshots", path.basename(spill))?.pid).toBe(process.pid);
			expect(parseOwnedTempRootOwner("sdk_snapshots", path.basename(spill))?.scope).toBe(OWN_SCOPE);
		} finally {
			await store.close();
		}
	});

	it("reads no owner from names that do not carry one", () => {
		expect(parseOwnedTempRootOwner("shell_snapshots", "gjc-shell-snapshots-AbC123")?.pid).toBeUndefined();
		expect(parseOwnedTempRootOwner("shell_snapshots", "gjc-shell-snapshots-0-AbC123")?.pid).toBeUndefined();
		expect(parseOwnedTempRootOwner("shell_snapshots", "gjc-shell-snapshots-12x-AbC123")?.pid).toBeUndefined();
		expect(parseOwnedTempRootOwner("shell_snapshots", "gjc-sdk-snapshots-12-AbC123")?.pid).toBeUndefined();
		expect(parseOwnedTempRootOwner("shell_snapshots", "gjc-shell-snapshots-12-AbC123")?.pid).toBe(12);
	});

	it("separates hosts that share the initial PID namespace inode", () => {
		// Every host's initial PID namespace has the same inode, so the boot id must tell them apart.
		const initialPidNamespace = 4026531836;
		const hostA = ownerScopeOf("6f9a3c1e-0d4b-4f7e-9a21-3b8e5c7d1f02", initialPidNamespace);
		const hostB = ownerScopeOf("b2e47d90-81c3-4a65-bf0e-7c19d3a6e854", initialPidNamespace);
		expect(hostA).not.toBe(hostB);
		expect(ownerScopeOf("6f9a3c1e-0d4b-4f7e-9a21-3b8e5c7d1f02", 4026532201)).not.toBe(hostA);
		expect(hostA).toMatch(/^[0-9a-f]{16}$/);
	});

	it("parses the owner scope from root names", () => {
		expect(parseOwnedTempRootOwner("shell_snapshots", "gjc-shell-snapshots-12-AbC123")).toEqual({ pid: 12 });
		expect(parseOwnedTempRootOwner("shell_snapshots", "gjc-shell-snapshots-12.0123456789abcdef-AbC123")).toEqual({
			pid: 12,
			scope: "0123456789abcdef",
		});
		// A bare namespace inode (the previous format) or any non-scope suffix carries no owner.
		expect(parseOwnedTempRootOwner("shell_snapshots", "gjc-shell-snapshots-12.4026531836-AbC123")).toBeUndefined();
		expect(
			parseOwnedTempRootOwner("shell_snapshots", "gjc-shell-snapshots-12.0123456789ABCDEF-AbC123"),
		).toBeUndefined();
		expect(
			parseOwnedTempRootOwner("shell_snapshots", "gjc-shell-snapshots-0.0123456789abcdef-AbC123"),
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
			// A dead owner is provable on Linux (host + PID-namespace scope) for every kind; elsewhere only
			// shell snapshots fall back to PID-only, and SDK/Python roots are kept (see the off-Linux test).
			expect(records[0]?.removable).toBe(process.platform === "linux" || kind === "shell_snapshots");
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
		// Found under TEMP, but kept: off Linux nothing proves this host owns the dead pid.
		expect(records[0]).toMatchObject({
			store: "python_runners",
			id: `gjc-python-runner-${DEAD_PID}-Stale`,
			path: stalePythonRoot,
			status: "unowned",
			removable: false,
		});
	});

	it.each([
		"darwin",
		"win32",
	] as const)("keeps dead-pid SDK and Python roots on %s, where no host identity exists, but still reclaims shell snapshots", async platform => {
		const tmpRoot = makeTmpRoot();
		const env = { ...process.env, TMPDIR: tmpRoot, TEMP: tmpRoot, TMP: tmpRoot };
		const ctx: GcContext = { probe, force: false, env, cwd: process.cwd() };
		for (const kind of ["sdk_snapshots", "python_runners"] as const) {
			const dir = seedRoot(tmpRoot, `${OWNED_TEMP_ROOT_PREFIXES[kind]}${DEAD_PID}-Remote`);
			const adapter = createOwnedTempRootGcAdapter(kind, platform);
			const [record] = (await adapter.collect(ctx)).records;
			expect(record).toMatchObject({ status: "unowned", removable: false });
			expect(await adapter.prune({ ...record, removable: true }, ctx)).toMatchObject({ removed: false });
			expect(fs.existsSync(dir)).toBe(true);
		}
		seedRoot(tmpRoot, `gjc-shell-snapshots-${DEAD_PID}-Local`);
		const [shell] = (await createOwnedTempRootGcAdapter("shell_snapshots", platform).collect(ctx)).records;
		expect(shell).toMatchObject({ status: "dead", removable: true });
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

	it.skipIf(OWN_SCOPE === undefined)(
		"keeps a dead-pid root from another host or PID namespace without probing it",
		async () => {
			const tmpRoot = makeTmpRoot();
			const rootName = `gjc-shell-snapshots-${DEAD_PID}.${FOREIGN_SCOPE}-Aaaaaa`;
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
			expect(record.status).toBe("foreign_scope");
			expect(record.removable).toBe(false);
			expect(record.action).toBe("none");
			expect(record.reason).toContain("another host");
			// Verify pid was NOT probed (fail-closed: foreign namespace means don't check pid)
			expect(pidProbed).toBe(false);
			// Verify the directory is not removed
			expect(fs.existsSync(dir)).toBe(true);
		},
	);

	it.skipIf(OWN_SCOPE === undefined)("removes a dead-pid root carrying this collector's scope", async () => {
		const tmpRoot = makeTmpRoot();
		const rootName = `gjc-shell-snapshots-${DEAD_PID}.${OWN_SCOPE}-Aaaaaa`;
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

	it.skipIf(OWN_SCOPE === undefined)("keeps roots without a scope part (legacy format)", async () => {
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
		expect(record.reason).toContain("no owner scope");
		// Verify pid was NOT probed (fail-closed: no namespace part means don't check pid on Linux)
		expect(pidProbed).toBe(false);
		// Verify the directory is not removed
		expect(fs.existsSync(dir)).toBe(true);
	});
});
