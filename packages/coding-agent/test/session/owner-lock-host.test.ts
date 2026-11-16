import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import * as native from "@gajae-code/natives";
import { FileSessionStorage } from "../../src/session/session-storage";

describe("host-qualified transcript authority locks", () => {
	let directory: string;
	let file: string;
	const storage = new FileSessionStorage();
	beforeEach(async () => {
		directory = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-owner-lock-host-"));
		file = path.join(directory, "owner.lock");
	});
	afterEach(async () => {
		await fs.rm(directory, { recursive: true, force: true });
	});
	async function deadOwner(): Promise<{ pid: number; incarnation: string }> {
		const child = Bun.spawn([process.execPath, "-e", "await Bun.sleep(60000)"], {
			stdin: "ignore",
			stdout: "ignore",
			stderr: "ignore",
		});
		try {
			const reference = native.Process.fromPid(child.pid);
			expect(reference).not.toBeNull();
			expect(reference!.incarnation.length).toBeGreaterThan(0);
			return { pid: child.pid, incarnation: reference!.incarnation };
		} finally {
			child.kill();
			await child.exited;
			expect(native.Process.fromPid(child.pid)).toBeNull();
		}
	}
	async function seed(owner: { pid: number; incarnation: string }, hostId?: string, legacy = false): Promise<string> {
		const bytes = legacy
			? `${owner.pid}:old-generation\n`
			: `${JSON.stringify({
					...owner,
					token: "old-generation",
					...(hostId === undefined ? {} : { hostId }),
				})}\n`;
		await Bun.write(file, bytes);
		await fs.chmod(file, 0o600);
		return bytes;
	}

	for (const legacy of [false, true]) {
		for (const reused of [false, true]) {
			it(`preserves missing-both-host ${legacy ? "legacy" : "JSON"} bytes/inode for a locally ${reused ? "reused" : "dead"} PID`, async () => {
				const dead = await deadOwner();
				const current = native.Process.fromPid(process.pid)!;
				expect(current.incarnation).not.toBe(dead.incarnation);
				const bytes = await seed({ ...dead, pid: reused ? process.pid : dead.pid }, undefined, legacy);
				const before = await fs.lstat(file, { bigint: true });
				const probe = spyOn(native.Process, "fromPid");
				const remove = spyOn(native, "exactUnlink");
				try {
					expect(storage.acquireExclusiveLockSync(file)).toBeUndefined();
					// The sole probe belongs to the new candidate, never the unqualified old record.
					expect(probe.mock.calls.map(([pid]) => pid)).toEqual([process.pid]);
					expect(remove.mock.calls.filter(([name]) => name === file)).toHaveLength(0);
					expect(await Bun.file(file).text()).toBe(bytes);
					const after = await fs.lstat(file, { bigint: true });
					expect([after.dev, after.ino]).toEqual([before.dev, before.ino]);
					// POSIX exact unlink deliberately retains its descriptor-scrubbed private
					// entry. Account only for names from these actual native cleanup calls.
					const retained: string[] = [];
					for (const [source, expected] of remove.mock.calls) {
						if (source === file || !expected.quarantineName) continue;
						const name = expected.quarantineName;
						const stat = await fs.lstat(path.join(directory, name), { bigint: true }).catch((error: unknown) => {
							if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
							throw error;
						});
						if (!stat) continue;
						expect(stat.isFile()).toBe(true);
						expect([stat.dev, stat.ino, stat.size]).toEqual([expected.dev, expected.ino, 0n]);
						expect(await Bun.file(path.join(directory, name)).bytes()).toHaveLength(0);
						retained.push(name);
					}
					expect((await fs.readdir(directory)).sort()).toEqual(["owner.lock", ...retained].sort());
				} finally {
					remove.mockRestore();
					probe.mockRestore();
				}
			});
		}
	}

	it("refuses foreign, missing, and empty host identities before probing an old PID", async () => {
		const dead = await deadOwner();
		for (const [recordHost, callerHost] of [
			[undefined, undefined],
			["foreign-host", "local-host"],
			[undefined, "local-host"],
			["local-host", undefined],
			["local-host", ""],
			["", "local-host"],
			["", ""],
		] as const) {
			const bytes = await seed(dead, recordHost);
			const before = await fs.lstat(file, { bigint: true });
			const probe = spyOn(native.Process, "fromPid");
			const remove = spyOn(native, "exactUnlink");
			try {
				expect(storage.acquireExclusiveLockSync(file, { ownerHostId: callerHost })).toBeUndefined();
				expect(probe.mock.calls.map(([pid]) => pid)).toEqual([process.pid]);
				expect(remove.mock.calls.filter(([name]) => name === file)).toHaveLength(0);
				expect(await Bun.file(file).text()).toBe(bytes);
				const after = await fs.lstat(file, { bigint: true });
				expect([after.dev, after.ino]).toEqual([before.dev, before.ino]);
			} finally {
				remove.mockRestore();
				probe.mockRestore();
			}
			await fs.unlink(file);
		}
	});

	for (const reused of [false, true]) {
		it(`recovers matching qualified hosts with positive native ${reused ? "incarnation mismatch" : "process absence"} evidence`, async () => {
			const dead = await deadOwner();
			const bytes = await seed({ ...dead, pid: reused ? process.pid : dead.pid }, "local-host");
			const probe = spyOn(native.Process, "fromPid");
			const remove = spyOn(native, "exactUnlink");
			try {
				const lock = storage.acquireExclusiveLockSync(file, { ownerHostId: "local-host" });
				expect(lock).toBeDefined();
				try {
					expect(probe.mock.calls.map(([pid]) => pid)).toEqual([
						process.pid,
						reused ? process.pid : dead.pid,
						process.pid,
					]);
					expect(remove.mock.calls.filter(([name]) => name === file)).toHaveLength(1);
					const record = await Bun.file(file).json();
					expect(record.hostId).toBe("local-host");
					expect(record.pid).toBe(process.pid);
					expect(record.incarnation).toBe(native.Process.fromPid(process.pid)!.incarnation);
					expect(record.token).not.toBe("old-generation");
					expect(await Bun.file(file).text()).not.toBe(bytes);
				} finally {
					lock?.releaseSync();
				}
				expect(await Bun.file(file).exists()).toBe(false);
			} finally {
				remove.mockRestore();
				probe.mockRestore();
			}
		});
	}

	it("preserves a matching live generation and an unverifiable process observation", async () => {
		const current = native.Process.fromPid(process.pid)!;
		const bytes = await seed({ pid: process.pid, incarnation: current.incarnation }, "local-host");
		const before = await fs.lstat(file, { bigint: true });
		expect(storage.acquireExclusiveLockSync(file, { ownerHostId: "local-host" })).toBeUndefined();
		const realProbe = native.Process.fromPid;
		let calls = 0;
		const probe = spyOn(native.Process, "fromPid").mockImplementation(pid => {
			if (++calls === 2) throw new Error("native process observation unavailable");
			return realProbe.call(native.Process, pid);
		});
		const remove = spyOn(native, "exactUnlink");
		try {
			expect(storage.acquireExclusiveLockSync(file, { ownerHostId: "local-host" })).toBeUndefined();
			expect(calls).toBe(2);
			expect(remove.mock.calls.filter(([name]) => name === file)).toHaveLength(0);
			expect(await Bun.file(file).text()).toBe(bytes);
			const after = await fs.lstat(file, { bigint: true });
			expect([after.dev, after.ino]).toEqual([before.dev, before.ino]);
		} finally {
			remove.mockRestore();
			probe.mockRestore();
		}
	});

	it("allows an ordinary unqualified caller to acquire an absent path", async () => {
		const lock = storage.acquireExclusiveLockSync(file);
		expect(lock).toBeDefined();
		const record = await Bun.file(file).json();
		expect(record.pid).toBe(process.pid);
		expect(record.hostId).toBeUndefined();
		lock!.releaseSync();
		expect(await Bun.file(file).exists()).toBe(false);
	});

	it("a late release never removes a successor lock generation", async () => {
		const lock = storage.acquireExclusiveLockSync(file, { ownerHostId: "local-host" });
		expect(lock).toBeDefined();
		await fs.rename(file, `${file}.original`);
		const successor = await seed(await deadOwner(), "successor-host");
		const before = await fs.lstat(file, { bigint: true });
		lock!.releaseSync();
		lock!.releaseSync();
		expect(await Bun.file(file).text()).toBe(successor);
		const after = await fs.lstat(file, { bigint: true });
		expect([after.dev, after.ino]).toEqual([before.dev, before.ino]);
	});
});
