import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
	acquireFileLock,
	FILE_LOCK_ORPHAN_TRANSITION_ADOPTION_AGE_MS,
	FileLockAcquireError,
} from "../src/config/file-lock";
import { Broker } from "../src/sdk/broker/broker";
import { brokerLockHostIdentity } from "../src/sdk/broker/lock-host-identity";
import { processIncarnation } from "../src/sdk/broker/process-incarnation";
import { SessionIndex, sessionIndexStartupLockOptions } from "../src/sdk/broker/session-index";

const holderFixture = path.join(import.meta.dir, "fixtures", "session-index-lock-holder.ts");
const hostlessRemoverFixture = path.join(import.meta.dir, "fixtures", "hostless-lock-remover.ts");
const roots: string[] = [];
const children: Bun.Subprocess[] = [];

interface LockInfo {
	pid: number;
	owner_host_id?: string;
	owner_token?: string;
}

afterEach(async () => {
	for (const child of children.splice(0)) {
		if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
		await child.exited;
	}
	await Promise.all(roots.splice(0).map(root => fs.rm(root, { recursive: true, force: true })));
});

async function makeAgentDir(): Promise<string> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-index-dead-owner-"));
	roots.push(dir);
	await fs.mkdir(path.join(dir, "sdk", "sessions"), { recursive: true, mode: 0o700 });
	return dir;
}

function indexPath(agentDir: string): string {
	return path.join(agentDir, "sdk", "sessions", "index.jsonl");
}

async function readLockInfo(lockDir: string): Promise<LockInfo> {
	return JSON.parse(await Bun.file(path.join(lockDir, "info")).text()) as LockInfo;
}

async function holdLock(agentDir: string, mode: "same-host" | "foreign"): Promise<LockInfo> {
	const child = Bun.spawn([process.execPath, holderFixture, agentDir, mode], {
		cwd: path.resolve(import.meta.dir, "../../.."),
		stdout: "pipe",
		stderr: "pipe",
	});
	children.push(child);
	const ready = path.join(agentDir, "holder-ready");
	const deadline = Date.now() + 10_000;
	while (Date.now() < deadline && !(await fs.exists(ready))) {
		if (child.exitCode !== null) {
			const stderr = await new Response(child.stderr).text();
			throw new Error(`lock holder exited early (${child.exitCode}): ${stderr}`);
		}
		await Bun.sleep(20);
	}
	if (!(await fs.exists(ready))) {
		child.kill("SIGKILL");
		const stderr = await new Response(child.stderr).text();
		throw new Error(`lock holder did not publish a session-index lock: ${stderr}`);
	}
	const info = JSON.parse(await Bun.file(ready).text()) as LockInfo;
	child.kill("SIGKILL");
	await child.exited;
	return info;
}

function startupOptions(waitMs: number) {
	return sessionIndexStartupLockOptions(performance.now() + waitMs, undefined, "ordinary");
}

async function openIndex(agentDir: string, waitMs: number): Promise<{ index: SessionIndex; ms: number }> {
	const started = performance.now();
	const index = await new SessionIndex(agentDir).open(startupOptions(waitMs));
	return { index, ms: performance.now() - started };
}

describe("session-index dead-owner reclaim", () => {
	it("reclaims a same-host lock whose owner was killed, including one aged 12s", async () => {
		const dir = await makeAgentDir();
		const dead = await holdLock(dir, "same-host");
		const lockDir = `${indexPath(dir)}.lock`;
		const aged = new Date(Date.now() - 12_000);
		await fs.utimes(lockDir, aged, aged);
		await fs.utimes(path.join(lockDir, "info"), aged, aged);
		const host = await brokerLockHostIdentity(dir);

		const { index, ms } = await openIndex(dir, 60_000);
		expect(ms).toBeLessThan(2_000);
		expect(index.indexSeq).toBe(0);
		expect(await fs.exists(lockDir)).toBe(false);
		let recorded: LockInfo | undefined;
		await index.withLocked(async () => {
			recorded = await readLockInfo(lockDir);
		});
		expect(recorded?.owner_host_id).toBe(host.ownerHostId);
		expect(recorded?.pid).toBe(process.pid);
		expect(recorded?.pid).not.toBe(dead.pid);
	});

	it("does not steal a lock held by a live same-host owner", async () => {
		const dir = await makeAgentDir();
		const host = await brokerLockHostIdentity(dir);
		const file = indexPath(dir);
		const release = await acquireFileLock(file, { retries: 3, retryDelayMs: 5, ...host });
		try {
			const started = performance.now();
			const failure = await new SessionIndex(dir).open(startupOptions(400)).then(
				() => undefined,
				(error: unknown) => error,
			);
			expect(performance.now() - started).toBeLessThan(2_000);
			expect(failure).toBeInstanceOf(FileLockAcquireError);
			const error = failure as FileLockAcquireError;
			expect(error.holderIsLive).toBe(true);
			expect(error.holder).toContain(`pid ${process.pid}`);
			expect(error.holder).toContain("(live)");
			const info = await readLockInfo(`${file}.lock`);
			expect(info.pid).toBe(process.pid);
			expect(info.owner_host_id).toBe(host.ownerHostId);
		} finally {
			await release();
		}
	});

	it("reclaims a leftover .removing directory whose same-host owner is dead", async () => {
		const dir = await makeAgentDir();
		const dead = await holdLock(dir, "same-host");
		const file = indexPath(dir);
		const removing = `${file}.lock.removing`;
		await fs.rename(`${file}.lock`, removing);
		expect((await readLockInfo(removing)).pid).toBe(dead.pid);

		const { ms } = await openIndex(dir, 60_000);
		expect(ms).toBeLessThan(2_000);
		expect(await fs.exists(removing)).toBe(false);
		expect(await fs.exists(`${file}.lock`)).toBe(false);
	});

	it("reclaims a quiescent .removing left by a hostless owner killed mid-release", async () => {
		const dir = await makeAgentDir();
		const file = indexPath(dir);
		const child = Bun.spawn([process.execPath, hostlessRemoverFixture, file, "after-scrub"], {
			cwd: path.resolve(import.meta.dir, "../../.."),
			stdout: "pipe",
			stderr: "pipe",
		});
		children.push(child);
		await child.exited;
		expect(child.signalCode).toBe("SIGKILL");
		const removing = `${file}.lock.removing`;
		const record = (await Bun.file(`${removing}.owner`).json()) as { owner: LockInfo };
		expect(record.owner.pid).toBe(child.pid);
		expect(record.owner.owner_host_id).toBeUndefined();
		const aged = new Date(Date.now() - FILE_LOCK_ORPHAN_TRANSITION_ADOPTION_AGE_MS - 1_000);
		for (const entry of await fs.readdir(removing)) await fs.utimes(path.join(removing, entry), aged, aged);
		await fs.utimes(removing, aged, aged);
		await fs.utimes(`${removing}.owner`, aged, aged);

		const { ms } = await openIndex(dir, 60_000);
		expect(ms).toBeLessThan(2_000);
		expect(await fs.exists(removing)).toBe(false);
		expect(await fs.exists(`${removing}.owner`)).toBe(false);
		expect(await fs.exists(`${file}.lock`)).toBe(false);
	});

	it("does not reclaim a dead owner attributed to another host", async () => {
		const dir = await makeAgentDir();
		const dead = await holdLock(dir, "foreign");
		const lockDir = `${indexPath(dir)}.lock`;
		const before = await Bun.file(path.join(lockDir, "info")).text();
		expect(dead.owner_host_id).toBe("foreign-session-index-host");

		const started = performance.now();
		const failure = await new SessionIndex(dir).open(startupOptions(400)).then(
			() => undefined,
			(error: unknown) => error,
		);
		expect(performance.now() - started).toBeLessThan(2_000);
		expect(failure).toBeInstanceOf(FileLockAcquireError);
		const error = failure as FileLockAcquireError;
		expect(error.holderIsLive).toBe(false);
		expect(error.holder).toContain("foreign-session-index-host");
		expect(error.holder).toContain("liveness unknown from this host");
		expect(await Bun.file(path.join(lockDir, "info")).text()).toBe(before);
	});

	it("죽은 주인 잠금 → 회수 후 시작", async () => {
		const dir = await makeAgentDir();
		const dead = await holdLock(dir, "same-host");
		const lockDir = `${indexPath(dir)}.lock`;
		const before = await Bun.file(path.join(lockDir, "info")).text();
		const broker = new Broker({ agentDir: dir, startupCheckpointDeadline: performance.now() + 15_000 });
		try {
			const started = performance.now();
			const discovery = await broker.start();
			expect(performance.now() - started).toBeLessThan(5_000);
			expect(discovery.pid).toBe(process.pid);
			const sessions = await fs.readdir(path.join(dir, "sdk", "sessions"));
			const tombstones = sessions.filter(name => name.startsWith("index.jsonl.lock.stale-"));
			expect(tombstones).toHaveLength(1);
			expect(await Bun.file(path.join(dir, "sdk", "sessions", tombstones[0]!, "info")).text()).toBe(before);
			expect(JSON.parse(before)).toMatchObject({ pid: dead.pid });
			expect(await fs.exists(lockDir)).toBe(false);
		} finally {
			await broker.stop();
		}
	}, 20_000);

	it("살아 있는 주인 → 시작 거부", async () => {
		const dir = await makeAgentDir();
		const host = await brokerLockHostIdentity(dir);
		const file = indexPath(dir);
		const release = await acquireFileLock(file, { retries: 3, retryDelayMs: 5, ...host });
		const before = await Bun.file(path.join(`${file}.lock`, "info")).text();
		const broker = new Broker({ agentDir: dir, startupCheckpointDeadline: performance.now() + 800 });
		try {
			const failure = await broker.start().then(
				() => undefined,
				(error: unknown) => error,
			);
			expect(failure).toBeInstanceOf(FileLockAcquireError);
			expect((failure as FileLockAcquireError).holderIsLive).toBe(true);
			expect(await Bun.file(path.join(`${file}.lock`, "info")).text()).toBe(before);
			const sessions = await fs.readdir(path.join(dir, "sdk", "sessions"));
			expect(sessions.filter(name => name.startsWith("index.jsonl.lock.stale-"))).toEqual([]);
		} finally {
			await release();
			await broker.stop();
		}
	}, 15_000);

	it("does not recover an empty info lock or an incarnation mismatch", async () => {
		const dir = await makeAgentDir();
		const host = await brokerLockHostIdentity(dir);
		const incarnation = processIncarnation(process.pid);
		if (!incarnation) throw new Error("Current process incarnation is unavailable");
		const sessionsDir = path.join(dir, "sdk", "sessions");
		const emptyLock = path.join(sessionsDir, "index.jsonl.lock");
		await fs.mkdir(emptyLock, { mode: 0o700 });
		await Bun.write(path.join(emptyLock, "info"), "");
		const emptyBroker = new Broker({ agentDir: dir, startupCheckpointDeadline: performance.now() + 800 });
		try {
			const failure = await emptyBroker.start().then(
				() => undefined,
				(error: unknown) => error,
			);
			expect(failure).toBeInstanceOf(FileLockAcquireError);
			expect(await Bun.file(path.join(emptyLock, "info")).text()).toBe("");
			expect(await fs.exists(emptyLock)).toBe(true);
		} finally {
			await emptyBroker.stop();
		}
		await fs.rm(emptyLock, { recursive: true, force: true });

		const mismatched = JSON.stringify({
			pid: process.pid,
			process_incarnation: `${incarnation}-mismatch`,
			timestamp: Date.now(),
			owner_host_id: host.ownerHostId,
			owner_token: "incarnation-mismatch",
		});
		await fs.mkdir(emptyLock, { mode: 0o700 });
		await Bun.write(path.join(emptyLock, "info"), mismatched);
		const mismatchBroker = new Broker({ agentDir: dir, startupCheckpointDeadline: performance.now() + 800 });
		try {
			const failure = await mismatchBroker.start().then(
				() => undefined,
				(error: unknown) => error,
			);
			expect(failure).toBeInstanceOf(FileLockAcquireError);
			expect(await Bun.file(path.join(emptyLock, "info")).text()).toBe(mismatched);
			expect(await fs.exists(emptyLock)).toBe(true);
			const sessions = await fs.readdir(sessionsDir);
			expect(sessions.filter(name => name.startsWith("index.jsonl.lock.stale-"))).toEqual([]);
		} finally {
			await mismatchBroker.stop();
		}
	}, 15_000);
});
