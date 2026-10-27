import { afterEach, expect, test, vi } from "bun:test";
import * as syncFs from "node:fs";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { exactRemoveDirectoryTree, snapshotDirectoryTree } from "@gajae-code/natives";
import { nativeProcessBindings } from "@gajae-code/utils/native-process";
import { acquireFileLock, type FileLockOwnerToken, FileLockTestHooks, withFileLock } from "../src/config/file-lock";

const roots: string[] = [];
type ControlledReleaseRetry = {
	cancelled: boolean;
	callback: () => void | Promise<void>;
};
const controlledReleaseRetries: ControlledReleaseRetry[] = [];

afterEach(async () => {
	for (const timer of controlledReleaseRetries.splice(0)) timer.cancelled = true;
	vi.restoreAllMocks();
	FileLockTestHooks.nativeQuarantineBindings = undefined;
	FileLockTestHooks.beforeRemovalRecordUnlink = undefined;
	FileLockTestHooks.beforeRemovalOwnerPublish = undefined;
	FileLockTestHooks.afterRemovalOwnerPublish = undefined;
	FileLockTestHooks.afterRemovalTransitionMissing = undefined;
	FileLockTestHooks.afterForeignTransitionMissing = undefined;
	for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
});

async function fixture() {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "file-lock-removal-owner-"));
	roots.push(root);
	const file = path.join(root, "index.jsonl");
	return { file, lock: `${file}.lock`, transition: `${file}.lock.removing` };
}

async function record(transition: string, owner: FileLockOwnerToken) {
	const stat = await fs.lstat(transition, { bigint: true });
	await Bun.write(
		`${transition}.owner`,
		JSON.stringify({ owner, rootDev: stat.dev.toString(), rootIno: stat.ino.toString() }),
	);
}

function controlReleasePendingRetries(): void {
	const realSetTimeout = globalThis.setTimeout;
	const realClearTimeout = globalThis.clearTimeout;
	const controlledSetTimeout = (callback: () => void | Promise<void>, delay?: number): NodeJS.Timeout => {
		if ([250, 1_000, 5_000, 15_000, 60_000].includes(delay ?? 0)) {
			const timer = { cancelled: false, callback };
			controlledReleaseRetries.push(timer);
			return timer as unknown as NodeJS.Timeout;
		}
		return realSetTimeout(callback, delay);
	};
	const controlledClearTimeout = (timer: unknown): void => {
		if (typeof timer === "object" && timer !== null && "cancelled" in timer && "callback" in timer) {
			(timer as ControlledReleaseRetry).cancelled = true;
			return;
		}
		realClearTimeout(timer as NodeJS.Timeout);
	};
	vi.spyOn(globalThis, "setTimeout").mockImplementation(controlledSetTimeout as unknown as typeof setTimeout);
	vi.spyOn(globalThis, "clearTimeout").mockImplementation(controlledClearTimeout as unknown as typeof clearTimeout);
}

async function runNextControlledReleaseRetry(): Promise<void> {
	const timer = controlledReleaseRetries.shift();
	expect(timer).toBeDefined();
	if (!timer || timer.cancelled) throw new Error("Expected an active pending release retry");
	await timer.callback();
}

const deadOwner: FileLockOwnerToken = { pid: 2147483647, timestamp: Date.now(), owner_token: "dead-remover" };

for (const [name, owner] of [
	["dead owner", deadOwner],
	["recycled pid", { pid: process.pid, process_incarnation: "different-incarnation", timestamp: Date.now() }],
] as const) {
	test(`real acquire recovers ${name} before payload scrub`, async () => {
		const { file, transition } = await fixture();
		await fs.mkdir(transition);
		await Bun.write(path.join(transition, "info"), JSON.stringify({ pid: process.pid, timestamp: Date.now() }));
		await Bun.write(path.join(transition, "payload"), "not yet scrubbed");
		await record(transition, owner);
		const release = await acquireFileLock(file, { retries: 2, retryDelayMs: 1 });
		expect(await fs.exists(transition)).toBe(false);
		expect(await fs.exists(`${transition}.owner`)).toBe(false);
		await release();
	});
}

test("real acquire leaves a live transition owner and payload untouched", async () => {
	const { file, transition } = await fixture();
	await fs.mkdir(transition);
	await Bun.write(path.join(transition, "payload"), "live payload");
	const incarnation = nativeProcessBindings().Process.fromPid(process.pid)?.incarnation;
	expect(incarnation).toBeString();
	await record(transition, { pid: process.pid, timestamp: Date.now(), process_incarnation: incarnation });
	const bytes = await Bun.file(`${transition}.owner`).text();
	await expect(acquireFileLock(file, { retries: 2, retryDelayMs: 1 })).rejects.toMatchObject({
		code: "acquire_timeout",
		orphanPath: transition,
		holder: expect.stringContaining(`blocked by retained removal transition ${transition}`),
	});
	expect(await Bun.file(path.join(transition, "payload")).text()).toBe("live payload");
	expect(await Bun.file(`${transition}.owner`).text()).toBe(bytes);
});

test.each(["before-rename", "after-rename", "after-scrub", "legacy-after-scrub"])(
	"SIGKILL %s retains the remover record and recovers",
	async phase => {
		const { file, lock, transition } = await fixture();
		const initial = phase === "legacy-after-scrub" ? transition : lock;
		await fs.mkdir(initial);
		await Bun.write(path.join(initial, "info"), JSON.stringify(deadOwner));
		const child = Bun.spawn(
			[
				process.execPath,
				"-e",
				`
import { acquireFileLock, FileLockTestHooks } from ${JSON.stringify(path.resolve(import.meta.dir, "../src/config/file-lock.ts"))};
import { exactRemoveDirectoryTree, renameDirectoryNoReplacePath, snapshotDirectoryTree } from "@gajae-code/natives";
const file = process.env.LOCKED_FILE;
const lock = file + ".lock";
const removalTarget = process.env.REMOVAL_CRASH_PHASE === "legacy-after-scrub" ? lock + ".removing" : lock;
FileLockTestHooks.nativeQuarantineBindings = () => ({
  snapshotDirectoryTree,
  exactRemoveDirectoryTree(target, snapshot) {
    if (target !== removalTarget) return exactRemoveDirectoryTree(target, snapshot);
    if (Bun.file(lock + ".removing.owner").size === 0) throw new Error("owner not prepublished");
    if (snapshot.entries.length !== 2) throw new Error("captured tree was mutated");
    if (process.env.REMOVAL_CRASH_PHASE === "after-rename") {
      if (!renameDirectoryNoReplacePath(lock, lock + ".removing").ok) throw new Error("rename refused");
    } else if (process.env.REMOVAL_CRASH_PHASE.endsWith("after-scrub")) {
      const removed = exactRemoveDirectoryTree(target, snapshot);
      if (removed.code !== "cleanup_pending" || !removed.payloadDurable) throw new Error("scrub refused");
    }
    process.kill(process.pid, "SIGKILL");
    throw new Error("SIGKILL did not terminate remover");
  }
});
await acquireFileLock(file, { retries: 2, retryDelayMs: 1 });
`,
			],
			{
				cwd: path.resolve(import.meta.dir, "../../.."),
				env: { ...process.env, LOCKED_FILE: file, REMOVAL_CRASH_PHASE: phase },
				stdout: "pipe",
				stderr: "pipe",
			},
		);
		const code = await child.exited;
		const stderr = await new Response(child.stderr).text();
		expect(stderr).toBe("");
		expect(code).not.toBe(0);
		const observedOwner = ((await Bun.file(`${transition}.owner`).json()) as { owner: FileLockOwnerToken }).owner;
		expect(observedOwner?.pid).toBe(child.pid);
		expect(observedOwner?.process_incarnation).toBeString();
		const retained = phase === "before-rename" ? lock : transition;
		expect(await Bun.file(path.join(retained, "info")).text()).toBe(
			phase.endsWith("after-scrub") ? "" : JSON.stringify(deadOwner),
		);
		const release = await acquireFileLock(file, { retries: 2, retryDelayMs: 1 });
		expect(await fs.exists(transition)).toBe(false);
		expect(await fs.exists(`${transition}.owner`)).toBe(false);
		await release();
	},
);

const HOSTLESS_ORPHAN_AGE_MS = 5_000;

async function setTreeMtime(root: string, when: Date): Promise<void> {
	for (const entry of await fs.readdir(root, { withFileTypes: true })) {
		const entryPath = path.join(root, entry.name);
		if (entry.isDirectory()) await setTreeMtime(entryPath, when);
		else await fs.utimes(entryPath, when, when);
	}
	await fs.utimes(root, when, when);
}

async function ageRetainedRemoval(transition: string, ageMs = HOSTLESS_ORPHAN_AGE_MS * 2): Promise<void> {
	const old = new Date(Date.now() - ageMs);
	await setTreeMtime(transition, old);
	await fs.utimes(`${transition}.owner`, old, old);
}

async function snapshotRetainedRemoval(transition: string): Promise<Record<string, string>> {
	const files: Record<string, string> = { ".owner": await Bun.file(`${transition}.owner`).text() };
	const walk = async (dir: string, prefix: string): Promise<void> => {
		for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
			const relative = `${prefix}${entry.name}`;
			if (entry.isDirectory()) await walk(path.join(dir, entry.name), `${relative}/`);
			else files[relative] = await Bun.file(path.join(dir, entry.name)).text();
		}
	};
	await walk(transition, "");
	return files;
}

const hostQualified = {
	ownerHostId: "local-host",
	orphanTransitionAgeMs: HOSTLESS_ORPHAN_AGE_MS,
	retries: 2,
	retryDelayMs: 1,
} as const;

/** SIGKILL a hostless owner (a build that predates host-id stamping) at `phase` of its own release. */
async function crashHostlessRemover(
	file: string,
	phase: "after-rename" | "after-scrub",
): Promise<{ pid: number; transition: string }> {
	const child = Bun.spawn(
		[process.execPath, path.join(import.meta.dir, "fixtures", "hostless-lock-remover.ts"), file, phase],
		{
			cwd: path.resolve(import.meta.dir, "../../.."),
			stdout: "pipe",
			stderr: "pipe",
		},
	);
	expect(await child.exited).not.toBe(0);
	expect(child.signalCode).toBe("SIGKILL");
	const transition = `${file}.lock.removing`;
	const recorded = ((await Bun.file(`${transition}.owner`).json()) as { owner: FileLockOwnerToken }).owner;
	expect(recorded.pid).toBe(child.pid);
	expect(recorded.owner_host_id).toBeUndefined();
	expect(await fs.exists(transition)).toBe(true);
	return { pid: child.pid, transition };
}

test.each(["after-rename", "after-scrub"] as const)(
	"host-qualified acquire keeps a fresh hostless remover %s foreign, then adopts it once quiescent",
	async phase => {
		const { file } = await fixture();
		const { pid, transition } = await crashHostlessRemover(file, phase);
		const before = await snapshotRetainedRemoval(transition);
		const kill = vi.spyOn(process, "kill");

		await expect(acquireFileLock(file, hostQualified)).rejects.toMatchObject({
			code: "acquire_timeout",
			orphanPath: transition,
		});
		expect(kill.mock.calls.filter(([probed]) => probed === pid)).toHaveLength(0);
		expect(await snapshotRetainedRemoval(transition)).toEqual(before);

		await ageRetainedRemoval(transition);
		const release = await acquireFileLock(file, hostQualified);
		expect(kill.mock.calls.some(([probed]) => probed === pid)).toBe(true);
		expect(await fs.exists(transition)).toBe(false);
		expect(await fs.exists(`${transition}.owner`)).toBe(false);
		await release();
	},
);

test("a quiescent hostless remover record stays foreign while any captured entry is recent", async () => {
	const { file } = await fixture();
	const { transition } = await crashHostlessRemover(file, "after-rename");
	await ageRetainedRemoval(transition);
	const now = new Date();
	await fs.utimes(path.join(transition, "info"), now, now);
	const before = await snapshotRetainedRemoval(transition);

	await expect(acquireFileLock(file, hostQualified)).rejects.toMatchObject({ code: "acquire_timeout" });
	expect(await snapshotRetainedRemoval(transition)).toEqual(before);
});

test("a hostless remover record dated in the future stays foreign", async () => {
	const { file } = await fixture();
	const { transition } = await crashHostlessRemover(file, "after-scrub");
	await ageRetainedRemoval(transition, -HOSTLESS_ORPHAN_AGE_MS * 20);
	const before = await snapshotRetainedRemoval(transition);

	await expect(acquireFileLock(file, hostQualified)).rejects.toMatchObject({ code: "acquire_timeout" });
	expect(await snapshotRetainedRemoval(transition)).toEqual(before);
});

test("a quiescent hostless remover record naming a live process is never adopted", async () => {
	const { file, transition } = await fixture();
	await fs.mkdir(transition);
	await Bun.write(path.join(transition, "info"), "");
	const incarnation = nativeProcessBindings().Process.fromPid(process.pid)?.incarnation;
	expect(incarnation).toBeString();
	await record(transition, { pid: process.pid, timestamp: Date.now(), process_incarnation: incarnation });
	await ageRetainedRemoval(transition);
	const before = await snapshotRetainedRemoval(transition);

	await expect(acquireFileLock(file, hostQualified)).rejects.toMatchObject({ code: "acquire_timeout" });
	expect(await snapshotRetainedRemoval(transition)).toEqual(before);
});

test("a quiescent hostless remover record bound to another tree is never adopted", async () => {
	const { file, transition } = await fixture();
	await fs.mkdir(transition);
	await Bun.write(path.join(transition, "info"), "");
	const stat = await fs.lstat(transition, { bigint: true });
	await Bun.write(
		`${transition}.owner`,
		JSON.stringify({ owner: deadOwner, rootDev: stat.dev.toString(), rootIno: (stat.ino + 1n).toString() }),
	);
	await ageRetainedRemoval(transition);
	const before = await snapshotRetainedRemoval(transition);

	await expect(acquireFileLock(file, hostQualified)).rejects.toMatchObject({ code: "acquire_timeout" });
	expect(await snapshotRetainedRemoval(transition)).toEqual(before);
});

test("a quiescent foreign-host remover record stays foreign", async () => {
	const { file, transition } = await fixture();
	await fs.mkdir(transition);
	await Bun.write(path.join(transition, "info"), "");
	await record(transition, { ...deadOwner, owner_host_id: "foreign-host" });
	await ageRetainedRemoval(transition);
	const before = await snapshotRetainedRemoval(transition);
	const kill = vi.spyOn(process, "kill");

	await expect(acquireFileLock(file, hostQualified)).rejects.toMatchObject({ code: "acquire_timeout" });
	expect(kill.mock.calls.filter(([probed]) => probed === deadOwner.pid)).toHaveLength(0);
	expect(await snapshotRetainedRemoval(transition)).toEqual(before);
});

test("real acquire reclaims an empty stale ownerless transition", async () => {
	const { file, transition } = await fixture();
	await fs.mkdir(transition);
	const old = new Date(Date.now() - 120_000);
	await fs.utimes(transition, old, old);
	const release = await acquireFileLock(file, { retries: 2, retryDelayMs: 1 });
	expect(await fs.exists(transition)).toBe(false);
	await release();
});

test("real acquire retains an empty ownerless transition within grace", async () => {
	const { file, transition } = await fixture();
	await fs.mkdir(transition);
	const recent = new Date(Date.now() - 1_000);
	await fs.utimes(transition, recent, recent);
	await expect(acquireFileLock(file, { retries: 2, retryDelayMs: 1 })).rejects.toMatchObject({
		code: "acquire_timeout",
		orphanPath: transition,
	});
	expect(await fs.readdir(transition)).toEqual([]);
});

test("ownerless adoption refuses a concurrent live replacement and its sibling claim", async () => {
	const { file, transition } = await fixture();
	await fs.mkdir(transition);
	const old = new Date(Date.now() - 120_000);
	await fs.utimes(transition, old, old);
	let replaced = false;
	let liveRecord = "";
	FileLockTestHooks.beforeRemovalOwnerPublish = async target => {
		if (target !== transition || replaced) return;
		replaced = true;
		await fs.rename(transition, `${transition}.original`);
		await fs.mkdir(transition);
		await fs.utimes(transition, old, old);
		await record(transition, { pid: process.pid, timestamp: Date.now(), owner_token: "live-replacement" });
		liveRecord = await Bun.file(`${transition}.owner`).text();
	};
	await expect(acquireFileLock(file, { retries: 2, retryDelayMs: 1 })).rejects.toMatchObject({
		orphanPath: transition,
	});
	expect(replaced).toBe(true);
	expect(await fs.readdir(transition)).toEqual([]);
	expect(await Bun.file(`${transition}.owner`).text()).toBe(liveRecord);
});

test("a dead sibling record cannot authorize a replacement root", async () => {
	const { file, transition } = await fixture();
	await fs.mkdir(transition);
	await record(transition, deadOwner);
	await fs.rename(transition, `${transition}.original`);
	await fs.mkdir(transition);
	await Bun.write(path.join(transition, "payload"), "replacement payload");
	await expect(acquireFileLock(file, { retries: 2, retryDelayMs: 1 })).rejects.toMatchObject({
		code: "acquire_timeout",
		orphanPath: transition,
	});
	expect(await Bun.file(path.join(transition, "payload")).text()).toBe("replacement payload");
	expect(await fs.exists(`${transition}.owner`)).toBe(true);
});

test("a live foreign transition is never probed or displaced using local pid evidence", async () => {
	const { file, transition } = await fixture();
	await fs.mkdir(transition);
	await Bun.write(path.join(transition, "payload"), "foreign payload");
	const foreignOwner: FileLockOwnerToken = {
		pid: process.pid,
		timestamp: Date.now(),
		owner_token: "live-foreign-remover",
		owner_host_id: "foreign-host",
	};
	await record(transition, foreignOwner);
	const foreignRecord = await Bun.file(`${transition}.owner`).text();
	const kill = vi.spyOn(process, "kill");
	await expect(
		acquireFileLock(file, { ownerHostId: "local-host", retries: 2, retryDelayMs: 1 }),
	).rejects.toMatchObject({
		code: "acquire_timeout",
		orphanPath: transition,
	});
	expect(await Bun.file(path.join(transition, "payload")).text()).toBe("foreign payload");
	expect(await Bun.file(`${transition}.owner`).text()).toBe(foreignRecord);
	expect(kill.mock.calls.filter(([pid]) => pid === foreignOwner.pid)).toHaveLength(0);
});

test("a pre-detach foreign receipt matching the live canonical root blocks acquisition untouched", async () => {
	const { file, lock, transition } = await fixture();
	const release = await acquireFileLock(file, { ownerHostId: "local-host", retries: 2, retryDelayMs: 1 });
	const originalInfo = await Bun.file(path.join(lock, "info")).text();
	const canonicalOwner: FileLockOwnerToken = {
		pid: 2147483646,
		timestamp: Date.now(),
		owner_token: "canonical-live-owner",
		owner_host_id: "local-host",
	};
	const canonicalInfo = JSON.stringify(canonicalOwner);
	await Bun.write(path.join(lock, "info"), canonicalInfo);
	const canonicalSnapshot = snapshotDirectoryTree(lock);
	if (!canonicalSnapshot.ok || !canonicalSnapshot.snapshot)
		throw new Error("Expected a native snapshot of the canonical lock root.");
	const foreignOwner: FileLockOwnerToken = {
		pid: process.pid,
		timestamp: Date.now(),
		owner_token: "foreign-pre-detach-remover",
		owner_host_id: "foreign-host",
	};
	const recordPath = `${transition}.owner`;
	const foreignRecord = JSON.stringify({
		owner: foreignOwner,
		rootDev: canonicalSnapshot.snapshot.rootDev,
		rootIno: canonicalSnapshot.snapshot.rootIno,
	});
	await Bun.write(recordPath, foreignRecord);
	expect(await fs.exists(transition)).toBe(false);

	const kill = vi.spyOn(process, "kill").mockImplementation(() => true);
	const callback = vi.fn(async () => "must not enter");
	try {
		await expect(
			withFileLock(file, callback, { ownerHostId: "local-host", retries: 2, retryDelayMs: 1 }),
		).rejects.toMatchObject({ code: "acquire_timeout" });
		expect(callback).not.toHaveBeenCalled();
		expect(kill.mock.calls.filter(([pid]) => pid === foreignOwner.pid)).toHaveLength(0);
		expect(await Bun.file(path.join(lock, "info")).text()).toBe(canonicalInfo);
		expect(await Bun.file(recordPath).text()).toBe(foreignRecord);
		expect(await fs.exists(transition)).toBe(false);
	} finally {
		await fs.rm(recordPath, { force: true });
		await Bun.write(path.join(lock, "info"), originalInfo);
		await release();
	}
});

test("host-qualified acquisition treats a hostless pre-detach receipt as foreign", async () => {
	const { file, lock, transition } = await fixture();
	await fs.mkdir(lock);
	const canonicalInfo = JSON.stringify({ ...deadOwner, owner_token: "hostless-canonical-owner" });
	await Bun.write(path.join(lock, "info"), canonicalInfo);
	const canonical = await fs.lstat(lock, { bigint: true });
	const hostlessOwner = { ...deadOwner, owner_token: "hostless-remover" };
	const recordBytes = JSON.stringify({
		owner: hostlessOwner,
		rootDev: canonical.dev.toString(),
		rootIno: canonical.ino.toString(),
	});
	await Bun.write(`${transition}.owner`, recordBytes);

	const kill = vi.spyOn(process, "kill");
	const callback = vi.fn(async () => undefined);
	await expect(
		withFileLock(file, callback, { ownerHostId: "local-host", retries: 2, retryDelayMs: 1 }),
	).rejects.toMatchObject({ code: "acquire_timeout" });

	expect(callback).not.toHaveBeenCalled();
	expect(kill.mock.calls.filter(([pid]) => pid === hostlessOwner.pid)).toHaveLength(0);
	expect(await Bun.file(`${transition}.owner`).text()).toBe(recordBytes);
	expect(await Bun.file(path.join(lock, "info")).text()).toBe(canonicalInfo);
});

test("host-qualified acquisition never probes or adopts a hostless retirement", async () => {
	const { file, transition } = await fixture();
	await fs.mkdir(transition);
	await Bun.write(path.join(transition, "payload"), "foreign payload");
	const hostlessOwner = { ...deadOwner, owner_token: "hostless-remover" };
	await record(transition, hostlessOwner);
	const recordBytes = await Bun.file(`${transition}.owner`).text();
	const kill = vi.spyOn(process, "kill");

	await expect(
		acquireFileLock(file, { ownerHostId: "local-host", retries: 2, retryDelayMs: 1 }),
	).rejects.toMatchObject({ code: "acquire_timeout" });

	expect(kill.mock.calls.filter(([pid]) => pid === hostlessOwner.pid)).toHaveLength(0);
	expect(await Bun.file(path.join(transition, "payload")).text()).toBe("foreign payload");
	expect(await Bun.file(`${transition}.owner`).text()).toBe(recordBytes);
});

test.skipIf(process.platform === "win32").each([
	["host-qualified", "local-host"],
	["unqualified", undefined],
] as const)(
	"%s successor releases after cleaning a completed foreign sidecar-only receipt",
	async (_name, ownerHostId) => {
		const { file, lock, transition } = await fixture();
		const foreignOwner: FileLockOwnerToken = {
			pid: 2147483646,
			timestamp: Date.now(),
			owner_token: "foreign-remover",
			owner_host_id: "foreign-host",
		};
		const recordPath = `${transition}.owner`;
		const foreignRecord = JSON.stringify({ owner: foreignOwner, rootDev: "0", rootIno: "0" });
		await Bun.write(recordPath, foreignRecord);
		expect(await fs.exists(transition)).toBe(false);

		const kill = vi.spyOn(process, "kill");
		const callback = vi.fn(async () => {
			await Bun.write(file, "committed successor state");
			return "successor callback committed";
		});

		await expect(withFileLock(file, callback, { ownerHostId, retries: 2, retryDelayMs: 1 })).resolves.toBe(
			"successor callback committed",
		);

		expect(callback).toHaveBeenCalledTimes(1);
		expect(kill.mock.calls.filter(([pid]) => pid === foreignOwner.pid)).toHaveLength(0);
		expect(await Bun.file(file).text()).toBe("committed successor state");
		expect(await fs.exists(recordPath)).toBe(false);
		expect(await fs.exists(lock)).toBe(false);
	},
);

test("orphan adoption retries a transient native refusal within the acquire budget", async () => {
	const { file, lock, transition } = await fixture();
	await fs.mkdir(transition);
	await Bun.write(path.join(transition, "info"), "");
	const originalTree = snapshotDirectoryTree(transition);
	if (!originalTree.ok || !originalTree.snapshot) throw new Error("Expected a native removal-transition snapshot.");
	await Bun.write(
		`${transition}.owner`,
		JSON.stringify({
			owner: deadOwner,
			rootDev: originalTree.snapshot.rootDev,
			rootIno: originalTree.snapshot.rootIno,
		}),
	);
	const receipt = (await Bun.file(`${transition}.owner`).json()) as { rootDev: string; rootIno: string };

	let removalAttempts = 0;
	FileLockTestHooks.nativeQuarantineBindings = () => ({
		snapshotDirectoryTree,
		exactRemoveDirectoryTree(target, snapshot, parent, detachOnly) {
			if (target === transition) {
				removalAttempts++;
				if (removalAttempts === 1) {
					expect(snapshot.rootDev).toBe(receipt.rootDev);
					expect(snapshot.rootIno).toBe(receipt.rootIno);
					expect(snapshot.entries.map(entry => entry.relativePath).sort()).toEqual(["", "info"]);
					return { ok: false, code: "sharing_violation" };
				}
			}
			return exactRemoveDirectoryTree(target, snapshot, parent, detachOnly);
		},
	});

	const release = await acquireFileLock(file, { retries: 2, retryDelayMs: 1 });
	expect(removalAttempts).toBe(2);
	expect(await fs.exists(transition)).toBe(false);
	expect(await fs.exists(`${transition}.owner`)).toBe(false);
	expect(await fs.exists(lock)).toBe(true);
	await release();
});

test.each(["local-host", "previous-local-host"])("dead %s remover is adopted on the same installation", async host => {
	const { file, transition } = await fixture();
	await fs.mkdir(transition);
	await Bun.write(path.join(transition, "payload"), "dead payload");
	await record(transition, { ...deadOwner, owner_host_id: host });
	const release = await acquireFileLock(file, {
		ownerHostId: "local-host",
		previousOwnerHostIds: ["previous-local-host"],
		retries: 2,
		retryDelayMs: 1,
	});
	expect(await fs.exists(transition)).toBe(false);
	expect(await fs.exists(`${transition}.owner`)).toBe(false);
	await release();
});

for (const payload of ["", "unproven payload"]) {
	test(`real acquire retains non-empty ownerless transition (${JSON.stringify(payload)})`, async () => {
		const { file, transition } = await fixture();
		await fs.mkdir(transition);
		await Bun.write(path.join(transition, "info"), payload);
		const old = new Date(Date.now() - 120_000);
		await fs.utimes(path.join(transition, "info"), old, old);
		await fs.utimes(transition, old, old);
		await expect(acquireFileLock(file, { retries: 2, retryDelayMs: 1 })).rejects.toMatchObject({
			orphanPath: transition,
		});
		expect(await Bun.file(path.join(transition, "info")).text()).toBe(payload);
	});
}

/**
 * A live remover's `.removing.owner` record outlives its tree: the record is cleared only
 * after native removal returns. A lock acquired in that window must still release.
 */
async function liveRemoverRecord(transition: string): Promise<void> {
	const incarnation = nativeProcessBindings().Process.fromPid(process.pid)?.incarnation;
	expect(incarnation).toBeString();
	await Bun.write(
		`${transition}.owner`,
		JSON.stringify({
			owner: { pid: process.pid, timestamp: Date.now(), process_incarnation: incarnation },
			rootDev: "0",
			rootIno: "0",
		}),
	);
}

async function lingeringLiveRemoverRecord(transition: string, clearAfterMs: number): Promise<void> {
	await liveRemoverRecord(transition);
	setTimeout(() => void fs.rm(`${transition}.owner`, { force: true }), clearAfterMs);
}

async function waitForAbsence(target: string, timeoutMs: number): Promise<boolean> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (!(await fs.exists(target))) return true;
		await Bun.sleep(25);
	}
	return !(await fs.exists(target));
}

test("release retries behind a live remover's lingering record instead of reporting owner_changed", async () => {
	const { file, lock, transition } = await fixture();
	const release = await acquireFileLock(file, { retries: 2, retryDelayMs: 1 });
	await lingeringLiveRemoverRecord(transition, 100);
	await release();
	expect(await fs.exists(lock)).toBe(false);
});

test.skipIf(process.platform === "win32")(
	"release preserves a foreign receipt bound to the still-live canonical root",
	async () => {
		const { file, lock, transition } = await fixture();
		const release = await acquireFileLock(file, { ownerHostId: "local-host", retries: 2, retryDelayMs: 1 });
		const canonicalInfo = await Bun.file(path.join(lock, "info")).text();
		const canonical = await fs.lstat(lock, { bigint: true });
		const recordBytes = JSON.stringify({
			owner: { ...deadOwner, owner_host_id: "foreign-host" },
			rootDev: canonical.dev.toString(),
			rootIno: canonical.ino.toString(),
		});
		await Bun.write(`${transition}.owner`, recordBytes);
		controlReleasePendingRetries();
		const kill = vi.spyOn(process, "kill");

		await expect(release()).rejects.toThrow();
		expect(await Bun.file(`${transition}.owner`).text()).toBe(recordBytes);
		expect(await Bun.file(path.join(lock, "info")).text()).toBe(canonicalInfo);
		expect(kill.mock.calls.filter(([pid]) => pid === deadOwner.pid)).toHaveLength(0);
		expect(await fs.exists(lock)).toBe(true);
	},
);

test("does not clear a foreign receipt when its root is detached between namespace checks", async () => {
	const { file, lock, transition } = await fixture();
	await fs.mkdir(lock);
	const canonicalInfo = JSON.stringify({ ...deadOwner, owner_host_id: "foreign-host" });
	await Bun.write(path.join(lock, "info"), canonicalInfo);
	const canonical = await fs.lstat(lock, { bigint: true });
	const recordBytes = JSON.stringify({
		owner: { ...deadOwner, owner_host_id: "foreign-host" },
		rootDev: canonical.dev.toString(),
		rootIno: canonical.ino.toString(),
	});
	await Bun.write(`${transition}.owner`, recordBytes);

	let detached = false;
	FileLockTestHooks.afterForeignTransitionMissing = async checkedPath => {
		if (checkedPath !== transition || detached) return;
		detached = true;
		await fs.rename(lock, transition);
	};
	const callback = vi.fn(async () => undefined);
	await expect(
		withFileLock(file, callback, { ownerHostId: "local-host", retries: 2, retryDelayMs: 1 }),
	).rejects.toMatchObject({ code: "acquire_timeout" });

	expect(detached).toBe(true);
	expect(callback).not.toHaveBeenCalled();
	expect(await Bun.file(`${transition}.owner`).text()).toBe(recordBytes);
	expect(await Bun.file(path.join(transition, "info")).text()).toBe(canonicalInfo);
	expect(await fs.exists(lock)).toBe(false);
});

test("clears a completed same-host receipt before honoring its live publisher PID", async () => {
	const { file, transition } = await fixture();
	await fs.mkdir(transition);
	const transitionStat = await fs.lstat(transition, { bigint: true });
	const completedReceipt = JSON.stringify({
		owner: {
			pid: process.pid,
			timestamp: Date.now(),
			owner_token: "completed-same-host-remover",
			owner_host_id: "same-host",
		},
		rootDev: transitionStat.dev.toString(),
		rootIno: transitionStat.ino.toString(),
	});
	await Bun.write(`${transition}.owner`, completedReceipt);
	await fs.rm(transition, { recursive: true });

	let callbackEntered = false;
	await withFileLock(
		file,
		async () => {
			callbackEntered = true;
		},
		{ ownerHostId: "same-host", retries: 2, retryDelayMs: 1 },
	);

	expect(callbackEntered).toBe(true);
	await expect(fs.lstat(`${transition}.owner`)).rejects.toMatchObject({ code: "ENOENT" });
});

test("keeps a live same-host receipt while its captured root remains canonical", async () => {
	const { file, lock, transition } = await fixture();
	await fs.mkdir(lock);
	const canonicalOwner: FileLockOwnerToken = {
		pid: process.pid,
		timestamp: Date.now(),
		owner_token: "canonical-lock-owner",
		owner_host_id: "same-host",
	};
	const canonicalInfo = JSON.stringify(canonicalOwner);
	await Bun.write(path.join(lock, "info"), canonicalInfo);
	const canonicalStat = await fs.lstat(lock, { bigint: true });
	const remover = {
		pid: process.pid,
		timestamp: Date.now(),
		owner_token: "live-remover",
		owner_host_id: "same-host",
	};
	const receipt = JSON.stringify({
		owner: remover,
		rootDev: canonicalStat.dev.toString(),
		rootIno: canonicalStat.ino.toString(),
	});
	await Bun.write(`${transition}.owner`, receipt);

	const callback = vi.fn(async () => undefined);
	await expect(
		withFileLock(file, callback, { ownerHostId: "same-host", retries: 2, retryDelayMs: 1 }),
	).rejects.toMatchObject({ code: "acquire_timeout" });

	expect(callback).not.toHaveBeenCalled();
	expect(await Bun.file(path.join(lock, "info")).text()).toBe(canonicalInfo);
	expect(await Bun.file(`${transition}.owner`).text()).toBe(receipt);
	await expect(fs.lstat(transition)).rejects.toMatchObject({ code: "ENOENT" });
});

test("keeps a completed same-host receipt active when exact unlink is refused", async () => {
	const { file, transition } = await fixture();
	await fs.mkdir(transition);
	const transitionStat = await fs.lstat(transition, { bigint: true });
	const completedReceipt = JSON.stringify({
		owner: {
			pid: process.pid,
			timestamp: Date.now(),
			owner_token: "completed-same-host-remover",
			owner_host_id: "same-host",
		},
		rootDev: transitionStat.dev.toString(),
		rootIno: transitionStat.ino.toString(),
	});
	await Bun.write(`${transition}.owner`, completedReceipt);
	await fs.rm(transition, { recursive: true });

	let refuseUnlink = true;
	FileLockTestHooks.beforeRemovalRecordUnlink = recordPath => !(recordPath === `${transition}.owner` && refuseUnlink);
	await expect(acquireFileLock(file, { ownerHostId: "same-host", retries: 2, retryDelayMs: 1 })).rejects.toMatchObject(
		{ code: "acquire_timeout" },
	);
	expect(await Bun.file(`${transition}.owner`).text()).toBe(completedReceipt);

	refuseUnlink = false;
	const release = await acquireFileLock(file, { ownerHostId: "same-host", retries: 2, retryDelayMs: 1 });
	await release();
	await expect(fs.lstat(`${transition}.owner`)).rejects.toMatchObject({ code: "ENOENT" });
});

test("uses the extended acquisition budget after a competing orphan cleanup", async () => {
	const { file, lock, transition } = await fixture();
	await fs.mkdir(lock);
	await Bun.write(
		path.join(lock, "info"),
		JSON.stringify({ ...deadOwner, timestamp: Date.now(), owner_token: "stale-lock" }),
	);

	let transitionSeeded = false;
	let adoptionRefused = true;
	FileLockTestHooks.beforeRemovalRecordUnlink = async recordPath => {
		if (recordPath === `${transition}.owner` && !transitionSeeded) {
			transitionSeeded = true;
			await fs.mkdir(transition);
			const old = new Date(Date.now() - 120_000);
			await fs.utimes(transition, old, old);
		}
		return true;
	};
	FileLockTestHooks.nativeQuarantineBindings = () => ({
		snapshotDirectoryTree,
		exactRemoveDirectoryTree(target, snapshot, parent, detachOnly) {
			if (target === transition && adoptionRefused) {
				adoptionRefused = false;
				syncFs.rmSync(transition, { recursive: true, force: true });
				return { ok: false, code: "identity_mismatch" };
			}
			return exactRemoveDirectoryTree(target, snapshot, parent, detachOnly);
		},
	});

	const release = await acquireFileLock(file, {
		retries: 2,
		retryDelayMs: 1,
		staleMs: 0,
		orphanTransitionAgeMs: 0,
	});
	await release();
	expect(transitionSeeded).toBe(true);
	expect(adoptionRefused).toBe(false);
	await expect(fs.lstat(lock)).rejects.toMatchObject({ code: "ENOENT" });
	await expect(fs.lstat(transition)).rejects.toMatchObject({ code: "ENOENT" });
	await expect(fs.lstat(`${transition}.owner`)).rejects.toMatchObject({ code: "ENOENT" });
});

test("preserves a local receipt when release detaches after acquisition observes no transition", async () => {
	const { file, lock, transition } = await fixture();
	const release = await acquireFileLock(file, { retries: 2, retryDelayMs: 1 });
	await Bun.write(path.join(lock, "payload"), "partially scrubbed transition");
	controlReleasePendingRetries();

	const ownerPublished = Promise.withResolvers<void>();
	const allowRemoval = Promise.withResolvers<void>();
	const transitionObservedMissing = Promise.withResolvers<void>();
	const allowClassification = Promise.withResolvers<void>();
	let releasePaused = false;
	let classificationPaused = false;
	let transitionPartiallyScrubbed = false;
	let receiptBytes = "";
	FileLockTestHooks.afterRemovalOwnerPublish = async publishedPath => {
		if (publishedPath !== transition || releasePaused) return;
		releasePaused = true;
		receiptBytes = await Bun.file(`${transition}.owner`).text();
		ownerPublished.resolve();
		await allowRemoval.promise;
	};
	FileLockTestHooks.afterRemovalTransitionMissing = async observedPath => {
		if (observedPath !== transition || classificationPaused) return;
		classificationPaused = true;
		transitionObservedMissing.resolve();
		await allowClassification.promise;
	};
	FileLockTestHooks.nativeQuarantineBindings = () => ({
		snapshotDirectoryTree,
		exactRemoveDirectoryTree(target, snapshot, parent, detachOnly) {
			if (target === lock && !transitionPartiallyScrubbed) {
				transitionPartiallyScrubbed = true;
				syncFs.renameSync(lock, transition);
				syncFs.unlinkSync(path.join(transition, "info"));
				return { ok: false, code: "identity_mismatch" };
			}
			return exactRemoveDirectoryTree(target, snapshot, parent, detachOnly);
		},
	});

	const releasePromise = release();
	await ownerPublished.promise;
	const acquisition = acquireFileLock(file, { retries: 2, retryDelayMs: 1 });
	await transitionObservedMissing.promise;
	allowRemoval.resolve();
	await expect(releasePromise).rejects.toThrow("owner_changed");
	allowClassification.resolve();
	await expect(acquisition).rejects.toMatchObject({ code: "acquire_timeout" });

	expect(await Bun.file(`${transition}.owner`).text()).toBe(receiptBytes);
	expect(await Bun.file(path.join(transition, "payload")).text()).toBe("partially scrubbed transition");
	await record(transition, deadOwner);

	const successorRelease = await acquireFileLock(file, { retries: 3, retryDelayMs: 1 });
	await successorRelease();
	expect(await fs.exists(lock)).toBe(false);
	expect(await fs.exists(transition)).toBe(false);
	expect(await fs.exists(`${transition}.owner`)).toBe(false);
});

test("the same release handle retries a refused detach and a refused local receipt unlink", async () => {
	const { file, lock, transition } = await fixture();
	const release = await acquireFileLock(file, { retries: 2, retryDelayMs: 1 });
	const canonicalInfo = await Bun.file(path.join(lock, "info")).text();
	controlReleasePendingRetries();

	let refuseDetach = true;
	let detachRefusals = 0;
	FileLockTestHooks.nativeQuarantineBindings = () => ({
		snapshotDirectoryTree,
		exactRemoveDirectoryTree(target, snapshot, parent, detachOnly) {
			if (target === lock && refuseDetach) {
				detachRefusals++;
				return { ok: false, code: "sharing_violation" };
			}
			return exactRemoveDirectoryTree(target, snapshot, parent, detachOnly);
		},
	});
	let receiptUnlinkRefusals = 0;
	FileLockTestHooks.beforeRemovalRecordUnlink = recordPath => {
		if (recordPath === `${transition}.owner` && receiptUnlinkRefusals === 0) {
			receiptUnlinkRefusals++;
			return false;
		}
		return true;
	};

	await expect(release()).rejects.toThrow();
	expect(detachRefusals).toBeGreaterThan(0);
	expect(receiptUnlinkRefusals).toBe(1);
	expect(await Bun.file(path.join(lock, "info")).text()).toBe(canonicalInfo);

	refuseDetach = false;
	await expect(release()).resolves.toBeUndefined();
	expect(await fs.exists(`${transition}.owner`)).toBe(false);
	expect(await fs.exists(transition)).toBe(false);
	expect(await fs.exists(lock)).toBe(false);
});

test("a release that outlasts its retry budget finishes in the background without reacquisition", async () => {
	const { file, lock, transition } = await fixture();
	const release = await acquireFileLock(file, { retries: 2, retryDelayMs: 1 });
	await lingeringLiveRemoverRecord(transition, 1_000);
	await expect(release()).rejects.toThrow("removal_record_busy");
	expect(await fs.exists(lock)).toBe(true);
	expect(await waitForAbsence(lock, 4_000)).toBe(true);
});

test("background release retries never remove a successor generation", async () => {
	const { file, lock } = await fixture();
	const release = await acquireFileLock(file, { retries: 2, retryDelayMs: 1 });
	const successor = { pid: process.pid, timestamp: Date.now() + 1_000, owner_token: "successor" };
	await Bun.write(path.join(lock, "info"), JSON.stringify(successor));
	await expect(release()).rejects.toThrow("Failed to release file lock: owner_changed.");
	await Bun.sleep(1_500);
	expect(await Bun.file(path.join(lock, "info")).json()).toEqual(successor);
});

test("background release retries do not authorize a copied-info replacement root", async () => {
	const { file, lock, transition } = await fixture();
	const release = await acquireFileLock(file, { retries: 2, retryDelayMs: 1 });
	const originalInfo = await Bun.file(path.join(lock, "info")).text();
	controlReleasePendingRetries();
	await liveRemoverRecord(transition);
	await expect(release()).rejects.toThrow("removal_record_busy");

	await fs.rename(lock, `${lock}.original`);
	await fs.mkdir(lock);
	await Bun.write(path.join(lock, "info"), originalInfo);
	let replacementSnapshots = 0;
	FileLockTestHooks.nativeQuarantineBindings = () => ({
		snapshotDirectoryTree(target) {
			if (target === lock) replacementSnapshots++;
			return snapshotDirectoryTree(target);
		},
		exactRemoveDirectoryTree,
	});
	await fs.rm(`${transition}.owner`);
	await runNextControlledReleaseRetry();

	expect(replacementSnapshots).toBe(1);
	expect(await Bun.file(path.join(lock, "info")).text()).toBe(originalInfo);
	expect(await Bun.file(path.join(`${lock}.original`, "info")).text()).toBe(originalInfo);
	expect(await fs.exists(lock)).toBe(true);
	expect(await fs.exists(`${lock}.original`)).toBe(true);
});

test("explicit pending release retries do not authorize a copied-info replacement root", async () => {
	const { file, lock, transition } = await fixture();
	const release = await acquireFileLock(file, { retries: 2, retryDelayMs: 1 });
	const originalInfo = await Bun.file(path.join(lock, "info")).text();
	controlReleasePendingRetries();
	await liveRemoverRecord(transition);
	await expect(release()).rejects.toThrow("removal_record_busy");

	await fs.rename(lock, `${lock}.original`);
	await fs.mkdir(lock);
	await Bun.write(path.join(lock, "info"), originalInfo);
	await fs.rm(`${transition}.owner`);
	await expect(release()).rejects.toThrow("Failed to release file lock: owner_changed.");

	expect(await Bun.file(path.join(lock, "info")).text()).toBe(originalInfo);
	expect(await Bun.file(path.join(`${lock}.original`, "info")).text()).toBe(originalInfo);
	expect(await fs.exists(lock)).toBe(true);
	expect(await fs.exists(`${lock}.original`)).toBe(true);
});

test("a pending release cannot capture identity after its initial capture fails", async () => {
	const { file, lock } = await fixture();
	const release = await acquireFileLock(file, { retries: 2, retryDelayMs: 1 });
	const originalInfo = await Bun.file(path.join(lock, "info")).text();
	controlReleasePendingRetries();
	const lstat = vi
		.spyOn(fs, "lstat")
		.mockRejectedValueOnce(Object.assign(new Error("permission denied"), { code: "EACCES" }));

	await expect(release()).rejects.toThrow("Failed to release file lock: owner_changed.");
	expect(lstat.mock.calls[0]).toEqual([lock, { bigint: true }]);
	lstat.mockRestore();
	await expect(release()).rejects.toThrow("Failed to release file lock: owner_changed.");

	expect(await Bun.file(path.join(lock, "info")).text()).toBe(originalInfo);
	expect(await fs.exists(lock)).toBe(true);
});
