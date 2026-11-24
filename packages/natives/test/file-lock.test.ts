import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { Subprocess } from "bun";
import {
	FileLockAcquireStatus,
	FileLockFailure,
	FileLockProbeState,
	probeFileLock,
	tryAcquireFileLock,
} from "../native/index.js";

const supported = process.platform === "linux" || process.platform === "darwin";
const holderScript = path.join(import.meta.dir, "file-lock-holder-child.ts");

const directories: string[] = [];
const children: Subprocess<"pipe", "pipe", "pipe">[] = [];
const strayPids: number[] = [];

async function tempDir(): Promise<string> {
	const directory = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-file-lock-"));
	directories.push(directory);
	return directory;
}

function alive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

/** The `ps` state of `pid`, once it is stopped or after a short wait. */
async function processState(pid: number): Promise<string> {
	let state = "";
	for (let attempt = 0; attempt < 100 && !state.startsWith("T"); attempt++) {
		if (attempt > 0) await Bun.sleep(10);
		state = (await Bun.$`ps -o stat= -p ${pid}`.nothrow().text()).trim();
	}
	return state;
}

afterEach(async () => {
	for (const child of children.splice(0)) {
		child.kill("SIGKILL");
		await child.exited;
	}
	for (const pid of strayPids.splice(0)) {
		if (alive(pid)) process.kill(pid, "SIGKILL");
	}
	await Promise.all(directories.splice(0).map(directory => fs.rm(directory, { recursive: true, force: true })));
});

interface Holder {
	child: Subprocess<"pipe", "pipe", "pipe">;
	ready: { status: string; grandchild: number | null };
	nextLine(): Promise<string>;
}

/** Start a child process that acquires `lockPath` and report its ready line. */
async function startHolder(lockPath: string, grandchildPidFile?: string): Promise<Holder> {
	const env: Record<string, string | undefined> = { ...process.env, FILE_LOCK_PATH: lockPath };
	if (grandchildPidFile) env.FILE_LOCK_GRANDCHILD_PID_FILE = grandchildPidFile;
	const child = Bun.spawn([process.execPath, holderScript], {
		cwd: import.meta.dir,
		env,
		stdin: "pipe",
		stdout: "pipe",
		stderr: "pipe",
	});
	children.push(child);
	const reader = child.stdout.getReader();
	const decoder = new TextDecoder();
	let buffered = "";
	const nextLine = async (): Promise<string> => {
		while (!buffered.includes("\n")) {
			const { value, done } = await reader.read();
			if (done) throw new Error(`holder exited early: ${await new Response(child.stderr).text()}`);
			buffered += decoder.decode(value, { stream: true });
		}
		const index = buffered.indexOf("\n");
		const line = buffered.slice(0, index);
		buffered = buffered.slice(index + 1);
		return line;
	};
	const ready = JSON.parse(await nextLine()) as Holder["ready"];
	if (ready.grandchild !== null) strayPids.push(ready.grandchild);
	return { child, ready, nextLine };
}

describe.if(supported)("native file lock", () => {
	it("acquires, refuses a second handle and releases idempotently", async () => {
		const lockPath = path.join(await tempDir(), "s.session-owner");

		const first = await tryAcquireFileLock(lockPath);
		expect(first.status).toBe(FileLockAcquireStatus.Acquired);
		expect(first.lock?.held).toBe(true);
		expect((await fs.stat(lockPath)).mode & 0o777).toBe(0o600);

		// Locks belong to a handle, not a process: a second handle in this
		// process loses, and the probe cannot tell which process holds it.
		const second = await tryAcquireFileLock(lockPath);
		expect(second).toEqual({ status: FileLockAcquireStatus.Held });
		expect(await probeFileLock(lockPath)).toEqual({ state: FileLockProbeState.Held });

		first.lock?.release();
		first.lock?.release();
		expect(first.lock?.held).toBe(false);
		expect(await probeFileLock(lockPath)).toEqual({ state: FileLockProbeState.Free });

		const again = await tryAcquireFileLock(lockPath);
		expect(again.status).toBe(FileLockAcquireStatus.Acquired);
		again.lock?.release();
	});

	it("a probe never creates the sidecar or takes the lock", async () => {
		const lockPath = path.join(await tempDir(), "s.session-owner");
		expect(await probeFileLock(lockPath)).toEqual({ state: FileLockProbeState.Free });
		expect(await Bun.file(lockPath).exists()).toBe(false);

		const holder = await startHolder(lockPath);
		expect(holder.ready.status).toBe(FileLockAcquireStatus.Acquired);
		// On macOS this is an F_GETLK query observing another process's flock.
		expect(await probeFileLock(lockPath)).toEqual({ state: FileLockProbeState.Held });
		expect(await probeFileLock(lockPath)).toEqual({ state: FileLockProbeState.Held });

		holder.child.stdin.write("release\n");
		await holder.child.stdin.flush();
		expect(await holder.nextLine()).toBe("released");
		expect(await probeFileLock(lockPath)).toEqual({ state: FileLockProbeState.Free });
		const mine = await tryAcquireFileLock(lockPath);
		expect(mine.status).toBe(FileLockAcquireStatus.Acquired);
		mine.lock?.release();
	});

	it("a lock held by another process is seen as held, and kill -9 frees it at once", async () => {
		const lockPath = path.join(await tempDir(), "s.session-owner");
		const holder = await startHolder(lockPath);
		expect(holder.ready.status).toBe(FileLockAcquireStatus.Acquired);

		expect(await tryAcquireFileLock(lockPath)).toEqual({ status: FileLockAcquireStatus.Held });
		expect(await probeFileLock(lockPath)).toEqual({ state: FileLockProbeState.Held });

		holder.child.kill("SIGKILL");
		await holder.child.exited;
		// No retry: a kernel lock is gone the moment its holder is.
		expect(await probeFileLock(lockPath)).toEqual({ state: FileLockProbeState.Free });
		const successor = await tryAcquireFileLock(lockPath);
		expect(successor.status).toBe(FileLockAcquireStatus.Acquired);
		successor.lock?.release();
	});

	it("a suspended holder keeps the lock", async () => {
		const lockPath = path.join(await tempDir(), "s.session-owner");
		const holder = await startHolder(lockPath);
		process.kill(holder.child.pid, "SIGSTOP");
		try {
			expect(await processState(holder.child.pid)).toStartWith("T");
			expect(await probeFileLock(lockPath)).toEqual({ state: FileLockProbeState.Held });
			expect(await tryAcquireFileLock(lockPath)).toEqual({ status: FileLockAcquireStatus.Held });
		} finally {
			process.kill(holder.child.pid, "SIGCONT");
		}
		expect(await probeFileLock(lockPath)).toEqual({ state: FileLockProbeState.Held });
	});

	it("a grandchild spawned by the holder does not keep the lock", async () => {
		const directory = await tempDir();
		const lockPath = path.join(directory, "s.session-owner");
		const holder = await startHolder(lockPath, path.join(directory, "grandchild.pid"));
		const grandchild = holder.ready.grandchild;
		expect(grandchild).toBeNumber();
		expect(alive(grandchild as number)).toBe(true);

		holder.child.kill("SIGKILL");
		await holder.child.exited;
		expect(alive(grandchild as number)).toBe(true);
		expect(await probeFileLock(lockPath)).toEqual({ state: FileLockProbeState.Free });
		const successor = await tryAcquireFileLock(lockPath);
		expect(successor.status).toBe(FileLockAcquireStatus.Acquired);
		successor.lock?.release();
	});

	it("a symlinked sidecar fails closed", async () => {
		const directory = await tempDir();
		const target = path.join(directory, "target");
		await fs.writeFile(target, "");
		const link = path.join(directory, "s.session-owner");
		await fs.symlink(target, link);

		const acquired = await tryAcquireFileLock(link);
		expect(acquired.status).toBe(FileLockAcquireStatus.Failed);
		expect(acquired.code).toBe("ELOOP");
		expect(acquired.lock).toBeUndefined();
		const probed = await probeFileLock(link);
		expect(probed.state).toBe(FileLockProbeState.Unknown);
		expect(probed.reason).toBe(FileLockFailure.Failed);
		expect(probed.code).toBe("ELOOP");
	});
});

describe.if(!supported)("native file lock on an unsupported platform", () => {
	it("reports unavailable instead of locking", async () => {
		const lockPath = path.join(await tempDir(), "s.session-owner");
		const acquired = await tryAcquireFileLock(lockPath);
		expect(acquired.status).toBe(FileLockAcquireStatus.Unavailable);
		expect(acquired.code).toBe("unsupported_platform");
		const probed = await probeFileLock(lockPath);
		expect(probed.state).toBe(FileLockProbeState.Unknown);
		expect(probed.reason).toBe(FileLockFailure.Unavailable);
	});
});
