import { afterEach, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
	FileLockAcquireError,
	type FileLockOptions,
	FileLockTestHooks,
	processStartTime,
	withFileLock,
} from "@gajae-code/coding-agent/config/file-lock";
import { exactRemoveDirectoryTree, snapshotDirectoryTree } from "@gajae-code/natives";

/**
 * #5653: the exhaustion diagnostic branched on `owner_host_id !== undefined` alone, so a
 * holder running on THIS host — a pid this process may legitimately probe, and whose lock
 * the reclamation path may legitimately reap — was still reported as "liveness unknown from
 * this host". Reading that, an operator concludes a dead lock is wedged when it is not.
 * These cases drive the real `withFileLock` exhaustion path, never the private helper.
 */

const FOREIGN_PHRASE = "liveness unknown from this host";

const tempDirs: string[] = [];

afterEach(async () => {
	FileLockTestHooks.nativeQuarantineBindings = undefined;
	for (const dir of tempDirs.splice(0)) {
		await fs.rm(dir, { recursive: true, force: true });
	}
});

async function makeTemp(): Promise<string> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "file-lock-local-holder-"));
	tempDirs.push(dir);
	return dir;
}

async function publishHolder(
	lockDir: string,
	info: { pid: number; start_time: string; start_time_format?: string; owner_host_id?: string },
): Promise<number> {
	const timestamp = Date.now();
	await fs.mkdir(lockDir, { recursive: true });
	await fs.writeFile(path.join(lockDir, "info"), JSON.stringify({ ...info, timestamp }), "utf8");
	return timestamp;
}

/** Contend for an already-held lock until the retry budget is spent, then return the holder line. */
async function holderAtExhaustion(filePath: string, options: FileLockOptions): Promise<string> {
	let failure: unknown;
	try {
		await withFileLock(
			filePath,
			async () => {
				throw new Error("the published holder's lock must never be acquired");
			},
			{ retries: 2, retryDelayMs: 1, ...options },
		);
	} catch (error) {
		failure = error;
	}
	expect(failure).toBeInstanceOf(FileLockAcquireError);
	const error = failure as FileLockAcquireError;
	expect(error.code).toBe("acquire_timeout");
	return error.holder;
}

/** A pid whose process is provably gone, with the start time captured while it still ran. */
async function exitedOwner(): Promise<{ pid: number; start_time: string }> {
	const child = Bun.spawn(["sleep", "30"], { stdout: "ignore", stderr: "ignore" });
	const pid = child.pid;
	// Capture the OS start time while the pid is still the process we spawned, so a later
	// pid reuse cannot make the record describe some unrelated live process.
	const startTime = processStartTime(pid);
	child.kill("SIGKILL");
	await child.exited;
	for (let attempt = 0; attempt < 200 && !isDead(pid); attempt++) await Bun.sleep(5);
	expect(isDead(pid)).toBe(true);
	return { pid, start_time: startTime ?? "unknown" };
}

function isDead(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return false;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "ESRCH";
	}
}

test("reports a local live holder's real liveness instead of an opaque foreign line", async () => {
	const filePath = path.join(await makeTemp(), "local-live.json");
	await publishHolder(`${filePath}.lock`, {
		pid: process.pid,
		start_time: processStartTime(process.pid) ?? "unknown",
		start_time_format: "utc-v1",
		owner_host_id: "this-host",
	});

	const holder = await holderAtExhaustion(filePath, { ownerHostId: "this-host" });

	expect(holder).toContain(`pid ${process.pid}`);
	expect(holder).toContain("(live)");
	expect(holder).not.toContain(FOREIGN_PHRASE);
	expect(await fs.exists(`${filePath}.lock`)).toBe(true);
});

test("reports a local dead holder as dead but not reaped instead of unknown from this host", async () => {
	const filePath = path.join(await makeTemp(), "local-dead.json");
	const lockDir = `${filePath}.lock`;
	const owner = await exitedOwner();
	await publishHolder(lockDir, { ...owner, start_time_format: "utc-v1", owner_host_id: "this-host" });
	// A local dead owner is stale on liveness alone — the stale threshold never enters the
	// verdict — so it is normally reclaimed on the first retry. Exhaustion is reachable only
	// when the host refuses to reap the directory, which is exactly the state the diagnostic
	// exists to describe. Refuse removal for this lock only.
	let refusals = 0;
	FileLockTestHooks.nativeQuarantineBindings = () => ({
		snapshotDirectoryTree,
		exactRemoveDirectoryTree: (target, snapshot, parentIdentity, detachOnly) => {
			if (path.resolve(target) !== path.resolve(lockDir))
				return exactRemoveDirectoryTree(target, snapshot, parentIdentity, detachOnly);
			refusals++;
			return { ok: false, code: "cleanup_refused" };
		},
	});

	const holder = await holderAtExhaustion(filePath, { ownerHostId: "this-host" });

	// The reclamation path really did judge this dead local owner stale and try to reap it:
	// without the refusal the lock would have been acquired instead of exhausting.
	expect(refusals).toBeGreaterThan(0);
	expect(holder).toContain(`pid ${owner.pid}`);
	expect(holder).toContain("dead but not reaped");
	expect(holder).not.toContain(FOREIGN_PHRASE);
	expect(await fs.exists(lockDir)).toBe(true);
});

test("treats a previous host identity of this installation as local", async () => {
	const filePath = path.join(await makeTemp(), "previous-host.json");
	await publishHolder(`${filePath}.lock`, {
		pid: process.pid,
		start_time: processStartTime(process.pid) ?? "unknown",
		start_time_format: "utc-v1",
		owner_host_id: "previous-host",
	});

	const holder = await holderAtExhaustion(filePath, {
		ownerHostId: "current-host",
		previousOwnerHostIds: ["previous-host"],
	});

	expect(holder).toContain(`pid ${process.pid}`);
	expect(holder).toContain("(live)");
	expect(holder).not.toContain(FOREIGN_PHRASE);
});

test("keeps a genuinely foreign holder opaque", async () => {
	const filePath = path.join(await makeTemp(), "foreign.json");
	await publishHolder(`${filePath}.lock`, {
		pid: process.pid,
		start_time: "unknown",
		owner_host_id: "another-host",
	});

	const holder = await holderAtExhaustion(filePath, { ownerHostId: "this-host" });

	expect(holder).toContain(`pid ${process.pid} on host another-host`);
	expect(holder).toContain(FOREIGN_PHRASE);
	expect(holder).not.toContain("(live)");
	expect(holder).not.toContain("dead but not reaped");
	expect(await fs.exists(`${filePath}.lock`)).toBe(true);
});

test("names the missing provenance of an unqualified holder instead of a host", async () => {
	const filePath = path.join(await makeTemp(), "unqualified.json");
	const lockDir = `${filePath}.lock`;
	// No owner_host_id key at all: an older record predating host qualification. A
	// host-aware acquirer must still fail closed on it — the pid stays unprobed and the
	// lock unreclaimed — without inventing a host value for it.
	const timestamp = await publishHolder(lockDir, { pid: process.pid, start_time: "unknown" });
	const published = await fs.readFile(path.join(lockDir, "info"), "utf8");

	const holder = await holderAtExhaustion(filePath, { ownerHostId: "this-host" });

	expect(holder).toBe(
		`held by pid ${process.pid} on an unrecorded host (${FOREIGN_PHRASE}) since ${new Date(timestamp).toISOString()}`,
	);
	expect(holder).not.toContain("undefined");
	expect(holder).not.toContain("on host");
	// The pid was never probed: a live local pid would otherwise have been labelled.
	expect(holder).not.toContain("(live)");
	expect(holder).not.toContain("dead but not reaped");
	// Fail-closed for real, not only in wording: the record still owns the directory.
	expect(await fs.exists(lockDir)).toBe(true);
	expect(await fs.readFile(path.join(lockDir, "info"), "utf8")).toBe(published);
});

test("keeps a host-qualified holder opaque to an acquirer carrying no host identity", async () => {
	const filePath = path.join(await makeTemp(), "no-acquirer-host.json");
	const timestamp = await publishHolder(`${filePath}.lock`, {
		pid: process.pid,
		start_time: "unknown",
		owner_host_id: "publisher-host",
	});

	const holder = await holderAtExhaustion(filePath, {});

	expect(holder).toBe(
		`held by pid ${process.pid} on host publisher-host (${FOREIGN_PHRASE}) since ${new Date(timestamp).toISOString()}`,
	);
});
