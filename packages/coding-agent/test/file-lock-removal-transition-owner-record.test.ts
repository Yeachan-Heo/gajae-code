import { afterEach, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { nativeProcessBindings } from "@gajae-code/utils/native-process";
import { acquireFileLock, type FileLockOwnerToken, FileLockTestHooks } from "../src/config/file-lock";

const roots: string[] = [];
afterEach(async () => {
	FileLockTestHooks.nativeQuarantineBindings = undefined;
	FileLockTestHooks.beforeRemovalOwnerPublish = undefined;
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

test.each([
	"before-rename",
	"after-rename",
	"after-scrub",
	"legacy-after-scrub",
])("SIGKILL %s retains the remover record and recovers", async phase => {
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

test("a foreign remover is never probed or displaced using local pid evidence", async () => {
	const { file, transition } = await fixture();
	await fs.mkdir(transition);
	await Bun.write(path.join(transition, "payload"), "foreign payload");
	await record(transition, { ...deadOwner, owner_host_id: "foreign-host" });
	await expect(
		acquireFileLock(file, { ownerHostId: "local-host", retries: 2, retryDelayMs: 1 }),
	).rejects.toMatchObject({
		code: "acquire_timeout",
		orphanPath: transition,
	});
	expect(await Bun.file(path.join(transition, "payload")).text()).toBe("foreign payload");
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
