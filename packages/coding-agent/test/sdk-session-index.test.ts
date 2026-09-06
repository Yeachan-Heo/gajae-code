import { describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import path from "node:path";
import * as native from "@gajae-code/natives";
import { FileLockTestHooks } from "../src/config/file-lock";
import {
	canonicalSessionCwd,
	SessionIndex,
	type SessionIndexEvent,
	sessionIndexChecksum,
	sessionWorktreeRoot,
} from "../src/sdk/broker/session-index";
import {
	assertSupportedSessionIndexEventVersion,
	assertSupportedSnapshotVersion,
	assertSupportedStateVersion,
	SDK_STATE_VERSION,
	SESSION_INDEX_EVENT_VERSION,
	SESSION_INDEX_SNAPSHOT_VERSION,
	UnsupportedStateVersionError,
} from "../src/sdk/broker/state-version";

const event = (sessionId: string) => ({
	type: "host_registered" as const,
	sessionId,
	locator: { cwd: "r", worktreeRoot: null, stateRoot: "q" },
	endpointGeneration: 1,
	pid: process.pid,
});

function deferred<T = void>() {
	return Promise.withResolvers<T>();
}
describe("SDK session index", () => {
	it("diagnoses a missing index without creating session directories", async () => {
		const dir = await fs.mkdtemp(path.join(process.env.TMPDIR ?? "/tmp", "gjc-index-missing-"));
		expect(await new SessionIndex(dir).diagnose()).toEqual({
			status: "healthy",
			validPrefixSeq: 0,
			snapshotSeq: 0,
		});
		expect(await fs.exists(path.join(dir, "sdk", "sessions"))).toBe(false);
	});
	it("coordinates concurrent opens for one normalized index path", async () => {
		const dir = await fs.mkdtemp(path.join(process.env.TMPDIR ?? "/tmp", "gjc-index-open-"));
		const sessionsDir = path.join(dir, "sdk", "sessions");
		const entered = deferred();
		const release = deferred();
		const chmod = fs.chmod.bind(fs);
		let chmodCalls = 0;
		const spy = vi.spyOn(fs, "chmod").mockImplementation(async (file, mode) => {
			if (path.resolve(file.toString()) === path.resolve(sessionsDir)) {
				chmodCalls++;
				entered.resolve();
				await release.promise;
			}
			return await chmod(file, mode);
		});
		try {
			const first = new SessionIndex(dir).open();
			await entered.promise;
			const second = new SessionIndex(path.join(dir, ".")).open();
			release.resolve();
			const [one, two] = await Promise.all([first, second]);
			expect(chmodCalls).toBe(1);
			expect(one).not.toBe(two);
			expect(one.indexSeq).toBe(0);
			expect(two.indexSeq).toBe(0);
		} finally {
			spy.mockRestore();
		}
	});
	it("clears a failed open group so a later open can retry", async () => {
		const dir = await fs.mkdtemp(path.join(process.env.TMPDIR ?? "/tmp", "gjc-index-open-failure-"));
		const sessionsDir = path.join(dir, "sdk", "sessions");
		const chmod = fs.chmod.bind(fs);
		let fail = true;
		const error = new Error("chmod failed");
		const spy = vi.spyOn(fs, "chmod").mockImplementation(async (file, mode) => {
			if (fail && path.resolve(file.toString()) === path.resolve(sessionsDir)) {
				fail = false;
				throw error;
			}
			return await chmod(file, mode);
		});
		try {
			await expect(new SessionIndex(dir).open()).rejects.toBe(error);
			await expect(new SessionIndex(dir).open()).resolves.toBeInstanceOf(SessionIndex);
		} finally {
			spy.mockRestore();
		}
	});
	it("does not serialize opens for different index paths", async () => {
		const root = await fs.mkdtemp(path.join(process.env.TMPDIR ?? "/tmp", "gjc-index-open-isolation-"));
		const firstDir = path.join(root, "first");
		const secondDir = path.join(root, "second");
		const firstSessionsDir = path.join(firstDir, "sdk", "sessions");
		const entered = deferred();
		const release = deferred();
		const chmod = fs.chmod.bind(fs);
		const spy = vi.spyOn(fs, "chmod").mockImplementation(async (file, mode) => {
			if (path.resolve(file.toString()) === path.resolve(firstSessionsDir)) {
				entered.resolve();
				await release.promise;
			}
			return await chmod(file, mode);
		});
		try {
			const first = new SessionIndex(firstDir).open();
			await entered.promise;
			await expect(new SessionIndex(secondDir).open()).resolves.toBeInstanceOf(SessionIndex);
			release.resolve();
			await first;
		} finally {
			spy.mockRestore();
		}
	});
	it("uses the native Windows process handle when signal-zero misreports a detached host", async () => {
		const dir = await fs.mkdtemp(path.join(process.env.TMPDIR ?? "/tmp", "gjc-index-windows-live-"));
		const originalPlatform = process.platform;
		const originalKill = process.kill;
		const processRef = {
			incarnation: "windows:133830291061234567",
			status: () => "running" as const,
		};
		const fromPid = vi.spyOn(native.Process, "fromPid").mockReturnValue(processRef as never);
		process.kill = (() => {
			throw Object.assign(new Error("signal zero unavailable"), { code: "EINVAL" });
		}) as typeof process.kill;
		Object.defineProperty(process, "platform", { configurable: true, value: "win32" });
		try {
			const index = await new SessionIndex(dir).open();
			await index.append({
				...event("windows-detached"),
				hostIncarnation: processRef.incarnation,
			});
			expect(index.listSessions().sessions).toMatchObject([
				{ sessionId: "windows-detached", live: true, identityProvenance: "composite" },
			]);
			expect(fromPid).toHaveBeenCalled();
		} finally {
			Object.defineProperty(process, "platform", { configurable: true, value: originalPlatform });
			process.kill = originalKill;
			fromPid.mockRestore();
			await fs.rm(dir, { recursive: true, force: true });
		}
	});
	it("replays only rows after the snapshotted prefix", async () => {
		const dir = await fs.mkdtemp(path.join(process.env.TMPDIR ?? "/tmp", "gjc-index-"));
		const index = await new SessionIndex(dir).open();
		await index.append(event("one"));
		await index.snapshot();
		await index.append(event("two"));
		const replay = await new SessionIndex(dir).open();
		expect(replay.listSessions().sessions.map(session => session.sessionId)).toEqual(["one", "two"]);
		expect(replay.indexSeq).toBe(2);
	});
	it("accepts a contiguous crash-window overlap that starts after an earlier rotation", async () => {
		const dir = await fs.mkdtemp(path.join(process.env.TMPDIR ?? "/tmp", "gjc-index-overlap-"));
		const index = await new SessionIndex(dir).open();
		await index.append(event("one"));
		await index.snapshot();
		const log = path.join(dir, "sdk", "sessions", "index.jsonl");
		await fs.writeFile(log, "");
		await index.append(event("two"));
		await index.append(event("three"));
		await index.snapshot();
		expect(await index.diagnose()).toMatchObject({ status: "healthy", snapshotSeq: 3, validPrefixSeq: 3 });
		expect((await index.append(event("four"))).indexSeq).toBe(4);
	});
	it("does not resynchronize after an incomplete pre-watermark overlap", async () => {
		const dir = await fs.mkdtemp(path.join(process.env.TMPDIR ?? "/tmp", "gjc-index-overlap-gap-"));
		const index = await new SessionIndex(dir).open();
		await index.append(event("one"));
		await index.append(event("two"));
		await index.append(event("three"));
		await index.snapshot();
		const log = path.join(dir, "sdk", "sessions", "index.jsonl");
		const rowOne = (await fs.readFile(log, "utf8")).split("\n")[0]!;
		const four = { ...event("four"), version: SDK_STATE_VERSION, indexSeq: 4, ts: 1 };
		await fs.writeFile(
			log,
			`${rowOne}\n${JSON.stringify({ ...four, checksum: sessionIndexChecksum(four as Parameters<typeof sessionIndexChecksum>[0]) })}\n`,
		);
		const diagnosis = await index.diagnose();
		expect(diagnosis).toMatchObject({ status: "corrupt", snapshotSeq: 3, validPrefixSeq: 3 });
		// Append self-repairs from the diagnosed watermark instead of resynchronizing
		// with the incomplete overlap: the accepted event chains from seq 3, not 4.
		expect((await index.append(event("accepted-after-repair"))).indexSeq).toBe(4);
		const replay = await new SessionIndex(dir).open();
		expect(replay.listSessions().warnings).toEqual([]);
		expect(replay.indexSeq).toBe(4);
	});
	it("retains the valid prefix and warns on corrupt post-snapshot data", async () => {
		const dir = await fs.mkdtemp(path.join(process.env.TMPDIR ?? "/tmp", "gjc-index-"));
		const index = await new SessionIndex(dir).open();
		await index.append(event("s"));
		await fs.appendFile(path.join(dir, "sdk", "sessions", "index.jsonl"), "broken\n");
		const replay = await new SessionIndex(dir).open();
		expect(replay.listSessions().indexSeq).toBe(1);
		expect(replay.listSessions().warnings).not.toHaveLength(0);
	});
	it("resyncs a stale reader after another index rotates the log", async () => {
		const dir = await fs.mkdtemp(path.join(process.env.TMPDIR ?? "/tmp", "gjc-index-"));
		const writer = await new SessionIndex(dir).open();
		const reader = await new SessionIndex(dir).open();
		await writer.append(event("before"));
		await reader.refresh();
		await writer.snapshot();
		const log = path.join(dir, "sdk", "sessions", "index.jsonl");
		await fs.rename(`${log}.rotating`, log).catch(() => undefined);
		await fs.writeFile(log, "");
		await writer.append(event("after"));
		await reader.refresh();
		expect(reader.listSessions().sessions.map(session => session.sessionId)).toEqual(["before", "after"]);
		expect(reader.listSessions().warnings).toEqual([]);
	});
	it("does not let a stale snapshot overwrite a newer snapshot", async () => {
		const dir = await fs.mkdtemp(path.join(process.env.TMPDIR ?? "/tmp", "gjc-index-"));
		const stale = await new SessionIndex(dir).open();
		const writer = await new SessionIndex(dir).open();
		await writer.append(event("one"));
		await writer.snapshot();
		await writer.append(event("two"));
		await writer.snapshot();
		await stale.snapshot();
		const snapshot = JSON.parse(await fs.readFile(path.join(dir, "sdk", "sessions", "index.snapshot.json"), "utf8"));
		expect(snapshot.indexSeq).toBe(2);
	});
	it("repairs a corrupt snapshot before rotating the retained log", async () => {
		const dir = await fs.mkdtemp(path.join(process.env.TMPDIR ?? "/tmp", "gjc-index-"));
		const index = await new SessionIndex(dir).open();
		await index.append(event("before"));
		const sessionsDir = path.join(dir, "sdk", "sessions");
		await fs.writeFile(path.join(sessionsDir, "index.snapshot.json"), "{");
		// The first append against the corrupt snapshot self-repairs (quarantining
		// the poisoned snapshot) and then lands; a manual repair afterwards reports
		// the already-healthy index untouched.
		expect((await index.append(event("lands-after-self-repair"))).indexSeq).toBe(2);
		expect(await index.repair()).toMatchObject({ status: "healthy", repaired: false });
		await index.append({
			...event("after"),
			locator: { cwd: "r".repeat(4 * 1024 * 1024), worktreeRoot: null, stateRoot: "q" },
		});
		const snapshot = JSON.parse(await fs.readFile(path.join(sessionsDir, "index.snapshot.json"), "utf8"));
		expect(snapshot.indexSeq).toBe(3);
		const replay = await new SessionIndex(dir).open();
		expect(replay.indexSeq).toBe(3);
		expect(replay.listSessions().warnings).toEqual([]);
	});
	it("repairs a structurally invalid high-sequence snapshot before rotating an oversized log", async () => {
		const dir = await fs.mkdtemp(path.join(process.env.TMPDIR ?? "/tmp", "gjc-index-"));
		const index = await new SessionIndex(dir).open();
		const sessionsDir = path.join(dir, "sdk", "sessions");
		const snapshotFile = path.join(sessionsDir, "index.snapshot.json");
		await index.append(event("before"));
		await index.snapshot();
		const invalidSnapshot = JSON.parse(await fs.readFile(snapshotFile, "utf8"));
		invalidSnapshot.indexSeq = 999;
		await fs.writeFile(snapshotFile, JSON.stringify(invalidSnapshot));
		const oversized = {
			...event("oversized"),
			locator: { cwd: "r".repeat(4 * 1024 * 1024), worktreeRoot: null, stateRoot: "q" },
			version: SDK_STATE_VERSION,
			indexSeq: 2,
			ts: Date.now(),
		};
		await fs.appendFile(
			path.join(sessionsDir, "index.jsonl"),
			`${JSON.stringify({ ...oversized, checksum: sessionIndexChecksum(oversized as Parameters<typeof sessionIndexChecksum>[0]) })}\n`,
		);
		// The first append self-repairs against the invalid high-sequence snapshot
		// (quarantining it, republishing the surviving prefix) and then lands.
		expect((await index.append(event("lands-after-self-repair"))).indexSeq).toBe(3);
		expect(await index.repair()).toMatchObject({ status: "healthy", repaired: false });

		await index.append(event("after"));
		await index.compact();

		expect(JSON.parse(await fs.readFile(snapshotFile, "utf8")).indexSeq).toBe(4);

		expect((await fs.stat(path.join(sessionsDir, "index.jsonl"))).size).toBe(0);
		const replay = await new SessionIndex(dir).open();
		expect(replay.listSessions().sessions.map(session => session.sessionId)).toEqual([
			"before",
			"oversized",
			"lands-after-self-repair",
			"after",
		]);
		expect(replay.indexSeq).toBe(4);
	});
	it("preserves the repaired valid-prefix watermark after a historical overlap", async () => {
		const dir = await fs.mkdtemp(path.join(process.env.TMPDIR ?? "/tmp", "gjc-index-repair-watermark-"));
		const index = await new SessionIndex(dir).open();
		await index.append(event("one"));
		await index.append(event("two"));
		await index.append(event("three"));
		await index.snapshot();
		const sessionsDir = path.join(dir, "sdk", "sessions");
		const snapshotFile = path.join(sessionsDir, "index.snapshot.json");
		const snapshot = JSON.parse(await fs.readFile(snapshotFile, "utf8"));
		snapshot.indexSeq = 99;
		await fs.writeFile(snapshotFile, JSON.stringify(snapshot));
		const log = path.join(sessionsDir, "index.jsonl");
		await fs.appendFile(log, "broken\n");

		const repair = await index.repair();
		expect(repair).toMatchObject({ status: "corrupt", repaired: true, validPrefixSeq: 3 });
		expect(JSON.parse(await fs.readFile(snapshotFile, "utf8"))).toMatchObject({
			indexSeq: repair.validPrefixSeq,
			events: [{ indexSeq: 1 }, { indexSeq: 2 }, { indexSeq: 3 }],
		});
		expect((await new SessionIndex(dir).open()).indexSeq).toBe(repair.validPrefixSeq);
		expect((await index.append(event("after-repair"))).indexSeq).toBe(repair.validPrefixSeq + 1);
	});
	it("tolerates Windows permission errors while opening and syncing the snapshot directory", async () => {
		const dir = await fs.mkdtemp(path.join(process.env.TMPDIR ?? "/tmp", "gjc-index-"));
		const index = await new SessionIndex(dir).open();
		await index.append(event("snapshot"));
		const sessionsDir = path.join(dir, "sdk", "sessions");
		const platform = Object.getOwnPropertyDescriptor(process, "platform");
		Object.defineProperty(process, "platform", { configurable: true, value: "win32" });
		try {
			for (const [stage, code] of [
				["open", "EPERM"],
				["sync", "EACCES"],
			] as const) {
				const open = fs.open.bind(fs);
				const spy = vi.spyOn(fs, "open").mockImplementation((async (file: string, ...rest: unknown[]) => {
					if (path.resolve(file) === path.resolve(sessionsDir) && stage === "open")
						throw Object.assign(new Error(code), { code });
					const handle = await (open as (file: string, ...args: unknown[]) => Promise<fs.FileHandle>)(
						file,
						...rest,
					);
					if (path.resolve(file) === path.resolve(sessionsDir) && stage === "sync")
						(handle as unknown as { sync: () => Promise<void> }).sync = async () => {
							throw Object.assign(new Error(code), { code });
						};
					return handle;
				}) as typeof fs.open);
				try {
					await index.snapshot();
				} finally {
					spy.mockRestore();
				}
			}
		} finally {
			if (platform) Object.defineProperty(process, "platform", platform);
		}
	});
	it("propagates non-permission Windows directory fsync errors", async () => {
		const dir = await fs.mkdtemp(path.join(process.env.TMPDIR ?? "/tmp", "gjc-index-"));
		const index = await new SessionIndex(dir).open();
		const sessionsDir = path.join(dir, "sdk", "sessions");
		const platform = Object.getOwnPropertyDescriptor(process, "platform");
		const open = fs.open.bind(fs);
		Object.defineProperty(process, "platform", { configurable: true, value: "win32" });
		const error = Object.assign(new Error("EIO"), { code: "EIO" });
		const spy = vi.spyOn(fs, "open").mockImplementation((async (file: string, ...rest: unknown[]) => {
			const handle = await (open as (file: string, ...args: unknown[]) => Promise<fs.FileHandle>)(file, ...rest);
			if (path.resolve(file) === path.resolve(sessionsDir))
				(handle as unknown as { sync: () => Promise<void> }).sync = async () => {
					throw error;
				};
			return handle;
		}) as typeof fs.open);
		try {
			await expect(index.snapshot()).rejects.toBe(error);
		} finally {
			spy.mockRestore();
			if (platform) Object.defineProperty(process, "platform", platform);
		}
	});
	it("publishes the snapshot without fsyncing a read-only temp handle (Windows EPERM, #4250)", async () => {
		const dir = await fs.mkdtemp(path.join(process.env.TMPDIR ?? "/tmp", "gjc-index-readonly-fsync-"));
		const index = await new SessionIndex(dir).open();
		await index.append(event("windows"));
		// Windows refuses FlushFileBuffers on a handle opened read-only with EPERM.
		// Any read-only open of the snapshot temp must fail exactly like the reported
		// crash, and publication must still land through a writable handle.
		const open = fs.open.bind(fs);
		const spy = vi.spyOn(fs, "open").mockImplementation((async (file: string, ...rest: unknown[]) => {
			const handle = await (open as (file: string, ...args: unknown[]) => Promise<fs.FileHandle>)(file, ...rest);
			if (rest[0] === "r" && file.endsWith(".tmp"))
				(handle as unknown as { sync: () => Promise<void> }).sync = async () => {
					throw Object.assign(new Error("operation not permitted, fsync"), { code: "EPERM" });
				};
			return handle;
		}) as typeof fs.open);
		try {
			await index.snapshot();
		} finally {
			spy.mockRestore();
		}
		const snapshot = JSON.parse(await fs.readFile(path.join(dir, "sdk", "sessions", "index.snapshot.json"), "utf8"));
		expect(snapshot.events.map((item: SessionIndexEvent) => item.sessionId)).toEqual(["windows"]);
		// Publication must not leave the temp artifact behind.
		const entries = await fs.readdir(path.join(dir, "sdk", "sessions"));
		expect(entries.filter(name => name.endsWith(".tmp"))).toEqual([]);
	});
	it("accepts EBADF when closing a successfully written and synced append handle", async () => {
		const dir = await fs.mkdtemp(path.join(process.env.TMPDIR ?? "/tmp", "gjc-index-close-ebadf-"));
		const index = await new SessionIndex(dir).open();
		const log = path.join(dir, "sdk", "sessions", "index.jsonl");
		const open = fs.open.bind(fs);
		let injected = false;
		const spy = vi.spyOn(fs, "open").mockImplementation((async (file: string, ...rest: unknown[]) => {
			const handle = await (open as (file: string, ...args: unknown[]) => Promise<fs.FileHandle>)(file, ...rest);
			if (!injected && path.resolve(file) === path.resolve(log) && rest[0] === "a") {
				injected = true;
				const close = handle.close.bind(handle);
				(handle as unknown as { close: () => Promise<void> }).close = async () => {
					await close();
					throw Object.assign(new Error("EBADF"), { code: "EBADF" });
				};
			}
			return handle;
		}) as typeof fs.open);
		try {
			await index.append(event("close-ebadf"));
		} finally {
			spy.mockRestore();
		}
		expect(injected).toBe(true);
		expect((await new SessionIndex(dir).open()).listSessions().sessions.map(session => session.sessionId)).toEqual([
			"close-ebadf",
		]);
	});
	it("holds refresh at a filesystem barrier while queued replay, append, and snapshot preserve monotonic state", async () => {
		const dir = await fs.mkdtemp(path.join(process.env.TMPDIR ?? "/tmp", "gjc-index-mutation-race-"));
		const index = await new SessionIndex(dir).open();
		await index.append(event("before"));
		const log = path.join(dir, "sdk", "sessions", "index.jsonl");
		const entered = deferred();
		const release = deferred();
		const open = fs.open.bind(fs);
		let holdLogRead = true;
		const spy = vi.spyOn(fs, "open").mockImplementation((async (file: string, ...rest: unknown[]) => {
			if (holdLogRead && path.resolve(file) === path.resolve(log) && rest[0] === "r") {
				holdLogRead = false;
				entered.resolve();
				await release.promise;
			}
			return await (open as (file: string, ...args: unknown[]) => Promise<fs.FileHandle>)(file, ...rest);
		}) as typeof fs.open);
		const receipt = <T>(promise: Promise<T>) => {
			const result: { status: "pending" | "fulfilled" | "rejected" } = { status: "pending" };
			void promise.then(
				() => {
					result.status = "fulfilled";
				},
				() => {
					result.status = "rejected";
				},
			);
			return result;
		};
		try {
			const refresh = index.refresh();
			await entered.promise;
			const replay = index.replay();
			const append = index.append(event("after"));
			const snapshot = index.snapshot();
			const receipts = [receipt(replay), receipt(append), receipt(snapshot)];

			expect(receipts).toEqual([{ status: "pending" }, { status: "pending" }, { status: "pending" }]);

			release.resolve();
			const [, , appended] = await Promise.all([refresh, replay, append, snapshot]);
			expect(receipts).toEqual([{ status: "fulfilled" }, { status: "fulfilled" }, { status: "fulfilled" }]);
			expect(appended.indexSeq).toBe(2);
			expect(index.indexSeq).toBe(2);
			expect(index.listSessions().sessions.map(session => session.sessionId)).toEqual(["before", "after"]);

			const snapshotContents = JSON.parse(
				await fs.readFile(path.join(dir, "sdk", "sessions", "index.snapshot.json"), "utf8"),
			);
			expect(snapshotContents.indexSeq).toBe(2);
			expect(snapshotContents.events.map((item: SessionIndexEvent) => item.indexSeq)).toEqual([1, 2]);
			const reopened = await new SessionIndex(dir).open();
			expect(reopened.indexSeq).toBe(2);
			expect(reopened.listSessions().sessions.map(session => session.sessionId)).toEqual(["before", "after"]);
		} finally {
			release.resolve();
			spy.mockRestore();
		}
	});
	it("serializes concurrent writers and replays a strictly monotonic log", async () => {
		const dir = await fs.mkdtemp(path.join(process.env.TMPDIR ?? "/tmp", "gjc-index-"));
		const one = await new SessionIndex(dir).open();
		const two = await new SessionIndex(dir).open();
		await Promise.all(Array.from({ length: 20 }, (_, i) => (i % 2 ? one : two).append(event(`s-${i}`))));
		const replay = await new SessionIndex(dir).open();
		expect(replay.indexSeq).toBe(20);
		expect(replay.listSessions().sessions).toHaveLength(20);
		expect(
			(await fs.readFile(path.join(dir, "sdk", "sessions", "index.jsonl"), "utf8"))
				.trim()
				.split("\n")
				.map(line => JSON.parse(line).indexSeq),
		).toEqual(Array.from({ length: 20 }, (_, i) => i + 1));
	});
	it("serializes independent writer processes without duplicate or inverted sequences", async () => {
		const dir = await fs.mkdtemp(path.join(process.env.TMPDIR ?? "/tmp", "gjc-index-processes-"));
		const modulePath = path.resolve(import.meta.dir, "../src/sdk/broker/session-index.ts");
		const script = `
			import { SessionIndex } from ${JSON.stringify(modulePath)};
			const index = await new SessionIndex(process.env.AGENT_DIR).open();
			for (let i = 0; i < 5; i++) {
				await index.append({
					type: "host_registered",
					sessionId: process.env.WRITER_ID + "-" + i,
					locator: { cwd: "r", worktreeRoot: null, stateRoot: "q" },
					endpointGeneration: 1,
					pid: process.pid,
				});
			}
		`;
		const children = Array.from({ length: 3 }, (_, writer) =>
			Bun.spawn([process.execPath, "-e", script], {
				env: { ...process.env, AGENT_DIR: dir, WRITER_ID: `writer-${writer}` },
				stdout: "ignore",
				stderr: "pipe",
			}),
		);
		for (const child of children) {
			const stderr = await new Response(child.stderr).text();
			expect(await child.exited, stderr).toBe(0);
		}
		const replay = await new SessionIndex(dir).open();
		expect(replay.indexSeq).toBe(15);
		expect(replay.listSessions().sessions).toHaveLength(15);
		const sequences = (await fs.readFile(path.join(dir, "sdk", "sessions", "index.jsonl"), "utf8"))
			.trim()
			.split("\n")
			.map(line => (JSON.parse(line) as { indexSeq: number }).indexSeq);
		expect(sequences).toEqual(Array.from({ length: 15 }, (_, index) => index + 1));
	}, 30_000);
	it("self-repairs an unterminated suffix on append while quarantining evidence", async () => {
		const dir = await fs.mkdtemp(path.join(process.env.TMPDIR ?? "/tmp", "gjc-index-"));
		const index = await new SessionIndex(dir).open();
		await index.append(event("prefix"));
		const log = path.join(dir, "sdk", "sessions", "index.jsonl");
		await fs.appendFile(log, '{"partial":');
		const corrupt = await new SessionIndex(dir).open();
		expect(corrupt.listSessions().sessions.map(session => session.sessionId)).toEqual(["prefix"]);
		expect(corrupt.listSessions().warnings).toContain("Corrupt session index entry; replay truncated");
		// Appending against the corrupt suffix repairs in place instead of failing:
		// the valid prefix survives, the new event lands, and the poisoned bytes are
		// quarantined for inspection rather than blocking every later launch.
		const appended = await corrupt.append(event("durable-after-repair"));
		expect(appended.indexSeq).toBe(2);
		const replay = await new SessionIndex(dir).open();
		expect(replay.listSessions().warnings).toEqual([]);
		expect(replay.listSessions().sessions.map(session => session.sessionId)).toEqual([
			"prefix",
			"durable-after-repair",
		]);
		const quarantine = await fs.readdir(path.join(dir, "sdk", "sessions", "quarantine"));
		expect(quarantine.length).toBe(1);
		const evidence = await fs.readFile(
			path.join(dir, "sdk", "sessions", "quarantine", quarantine[0]!, "index.jsonl"),
			"utf8",
		);
		expect(evidence).toContain('{"partial":');
	});
	it("self-repairs a validly-signed stale-sequence append from another writer", async () => {
		// Field failure mode: a long-lived broker holding stale in-memory state signs
		// events with a years-old indexSeq (checksum valid, sequence wrong). One such
		// row used to poison the log permanently — every later append threw, and an
		// operator-run repair was re-poisoned by the next stale write, leaving
		// delegated session launches dead until someone deleted the index by hand.
		const dir = await fs.mkdtemp(path.join(process.env.TMPDIR ?? "/tmp", "gjc-index-"));
		const index = await new SessionIndex(dir).open();
		for (const name of ["one", "two", "three"]) await index.append(event(name));
		const log = path.join(dir, "sdk", "sessions", "index.jsonl");
		const stale: Omit<SessionIndexEvent, "checksum"> = {
			version: SDK_STATE_VERSION,
			indexSeq: 1,
			ts: Date.now(),
			type: "lifecycle_terminal",
			sessionId: "stale-writer",
			locator: { cwd: "unknown", worktreeRoot: null, stateRoot: "q" },
			endpointGeneration: 0,
			pid: process.pid,
			terminalUncertain: true,
		};
		await fs.appendFile(log, `${JSON.stringify({ ...stale, checksum: sessionIndexChecksum(stale) })}\n`);
		const poisoned = await new SessionIndex(dir).open();
		expect(poisoned.listSessions().warnings).toContain("Corrupt session index entry; replay truncated");
		const appended = await poisoned.append(event("four"));
		expect(appended.indexSeq).toBe(4);
		const replay = await new SessionIndex(dir).open();
		expect(replay.listSessions().warnings).toEqual([]);
		expect(replay.listSessions().sessions.map(session => session.sessionId)).toEqual(["one", "two", "three", "four"]);
	});
	it("refreshes a cold reader from a compacted snapshot", async () => {
		const dir = await fs.mkdtemp(path.join(process.env.TMPDIR ?? "/tmp", "gjc-index-cold-refresh-"));
		const writer = await new SessionIndex(dir).open();
		await writer.append(event("snapshot-only"));
		await writer.compact();

		const cold = new SessionIndex(dir);
		await cold.refresh();
		expect(cold.listSessions().sessions.map(session => session.sessionId)).toEqual(["snapshot-only"]);
	});
	it("rotates repeatedly while concurrent writers and readers preserve every event", async () => {
		const dir = await fs.mkdtemp(path.join(process.env.TMPDIR ?? "/tmp", "gjc-index-"));
		const writers = await Promise.all([new SessionIndex(dir).open(), new SessionIndex(dir).open()]);
		const largeEvent = (sessionId: string) => ({
			...event(sessionId),
			locator: { cwd: "r".repeat(300_000), worktreeRoot: null, stateRoot: "q" },
		});
		for (let round = 0; round < 3; round++) {
			await Promise.all(
				Array.from({ length: 16 }, (_, index) =>
					writers[index % writers.length]!.append(largeEvent(`r-${round}-${index}`)),
				),
			);
			const readers = await Promise.all(Array.from({ length: 4 }, () => new SessionIndex(dir).open()));
			expect(readers.map(reader => reader.indexSeq)).toEqual(Array(4).fill((round + 1) * 16));
			expect(readers[0]!.listSessions().sessions).toHaveLength((round + 1) * 16);
			expect((await fs.stat(path.join(dir, "sdk", "sessions", "index.jsonl"))).size).toBeLessThan(4 * 1024 * 1024);
		}
		expect(
			JSON.parse(await fs.readFile(path.join(dir, "sdk", "sessions", "index.snapshot.json"), "utf8")),
		).toMatchObject({
			indexSeq: expect.any(Number),
		});
	}, 30_000);

	it("compaction retains terminal sessions and keeps live sessions with their original indexSeq", async () => {
		const dir = await fs.mkdtemp(path.join(process.env.TMPDIR ?? "/tmp", "gjc-index-"));
		const deadPid = await (async () => {
			const proc = Bun.spawn({ cmd: ["true"] });
			await proc.exited;
			return proc.pid;
		})();
		const index = await new SessionIndex(dir).open();
		await index.append(event("live"));
		await index.append({ ...event("dead"), pid: deadPid });
		await index.append({ ...event("dead"), type: "host_unregistered", pid: deadPid });
		await index.append(event("live2"));
		await index.snapshot();
		const snapshot = JSON.parse(await fs.readFile(path.join(dir, "sdk", "sessions", "index.snapshot.json"), "utf8"));
		expect(snapshot.events.map((e: { sessionId: string }) => e.sessionId)).toEqual(["live", "dead", "dead", "live2"]);
		expect(snapshot.events[0].indexSeq).toBe(1);
		expect(snapshot.indexSeq).toBe(4);
		const replay = await new SessionIndex(dir).open();
		expect(replay.listSessions().sessions.map(s => s.sessionId)).toEqual(["live", "dead", "live2"]);
		expect(replay.listSessions().sessions.find(session => session.sessionId === "dead")).toMatchObject({
			live: false,
			terminal: true,
		});
		expect(replay.indexSeq).toBe(4);
	});
	it("collapses superseded heartbeats to the latest per surviving session", async () => {
		const dir = await fs.mkdtemp(path.join(process.env.TMPDIR ?? "/tmp", "gjc-index-"));
		const index = await new SessionIndex(dir).open();
		await index.append(event("s"));
		await index.append({ ...event("s"), type: "host_heartbeat" });
		await index.append({ ...event("s"), type: "host_heartbeat" });
		await index.append(event("other"));
		const before = index.listSessions().sessions.map(session => session.sessionId);
		await index.snapshot();
		const snapshot = JSON.parse(await fs.readFile(path.join(dir, "sdk", "sessions", "index.snapshot.json"), "utf8"));
		const heartbeats = snapshot.events.filter((e: { type: string }) => e.type === "host_heartbeat");
		expect(heartbeats).toHaveLength(1);
		expect(heartbeats[0].indexSeq).toBe(3);
		const replay = await new SessionIndex(dir).open();
		expect(replay.listSessions().sessions.map(s => s.sessionId)).toEqual(before);
	});
	it("accepts a gapped-monotonic snapshot on replay and chains subsequent appends", async () => {
		const dir = await fs.mkdtemp(path.join(process.env.TMPDIR ?? "/tmp", "gjc-index-"));
		const sessionsDir = path.join(dir, "sdk", "sessions");
		await fs.mkdir(sessionsDir, { recursive: true });
		const signed = (indexSeq: number, sessionId: string) => {
			const unsigned = {
				...event(sessionId),
				version: SDK_STATE_VERSION,
				indexSeq,
				ts: 1,
			};
			return { ...unsigned, checksum: sessionIndexChecksum(unsigned as Parameters<typeof sessionIndexChecksum>[0]) };
		};
		await fs.writeFile(
			path.join(sessionsDir, "index.snapshot.json"),
			JSON.stringify({ version: 2, indexSeq: 5, events: [signed(1, "a"), signed(5, "b")] }),
		);
		const replay = await new SessionIndex(dir).open();
		expect(replay.listSessions().warnings).toEqual([]);
		expect(replay.indexSeq).toBe(5);
		const appended = await replay.append(event("c"));
		expect(appended.indexSeq).toBe(6);
	});
	it("repairs a compacted high-watermark snapshot with historical overlap and remains appendable", async () => {
		const dir = await fs.mkdtemp(path.join(process.env.TMPDIR ?? "/tmp", "gjc-index-repair-watermark-"));
		const sessionsDir = path.join(dir, "sdk", "sessions");
		await fs.mkdir(sessionsDir, { recursive: true });
		const signed = (indexSeq: number, sessionId: string) => {
			const unsigned = { ...event(sessionId), version: SDK_STATE_VERSION, indexSeq, ts: 1 };
			return { ...unsigned, checksum: sessionIndexChecksum(unsigned as Parameters<typeof sessionIndexChecksum>[0]) };
		};
		const history = Array.from({ length: 5 }, (_, index) => signed(index + 1, `history-${index + 1}`));
		const tail = signed(6, "tail");
		await fs.writeFile(
			path.join(sessionsDir, "index.snapshot.json"),
			JSON.stringify({ version: 2, indexSeq: 5, events: [history[0], history[2]] }),
		);
		await fs.writeFile(
			path.join(sessionsDir, "index.jsonl"),
			`${[...history, tail].map(row => JSON.stringify(row)).join("\n")}\nbroken\n`,
		);

		const index = await new SessionIndex(dir).open();
		const repair = await index.repair();

		expect(repair).toMatchObject({ status: "corrupt", repaired: true, validPrefixSeq: 6 });
		expect(JSON.parse(await fs.readFile(path.join(sessionsDir, "index.snapshot.json"), "utf8"))).toMatchObject({
			indexSeq: 6,
		});
		expect((await index.append(event("resumed"))).indexSeq).toBe(repair.validPrefixSeq + 1);
	});
	it("rejects a non-monotonic snapshot as invalid", async () => {
		const dir = await fs.mkdtemp(path.join(process.env.TMPDIR ?? "/tmp", "gjc-index-"));
		const sessionsDir = path.join(dir, "sdk", "sessions");
		await fs.mkdir(sessionsDir, { recursive: true });
		const signed = (indexSeq: number, sessionId: string) => {
			const unsigned = { ...event(sessionId), version: SDK_STATE_VERSION, indexSeq, ts: 1 };
			return { ...unsigned, checksum: sessionIndexChecksum(unsigned as Parameters<typeof sessionIndexChecksum>[0]) };
		};
		await fs.writeFile(
			path.join(sessionsDir, "index.snapshot.json"),
			JSON.stringify({ version: 2, indexSeq: 3, events: [signed(3, "a"), signed(2, "b")] }),
		);
		const replay = await new SessionIndex(dir).open();
		expect(replay.listSessions().warnings).toContain("Invalid session index snapshot");
		expect(replay.indexSeq).toBe(0);
	});
	it("guards state version: rejects a newer snapshot and reads an older one", async () => {
		const dir = await fs.mkdtemp(path.join(process.env.TMPDIR ?? "/tmp", "gjc-index-"));
		const sessionsDir = path.join(dir, "sdk", "sessions");
		await fs.mkdir(sessionsDir, { recursive: true });
		const snapshotFile = path.join(sessionsDir, "index.snapshot.json");
		await fs.writeFile(snapshotFile, JSON.stringify({ version: 5, indexSeq: 7, events: [] }));
		const unsupported = new SessionIndex(dir);
		expect(await unsupported.diagnose()).toMatchObject({ status: "unsupported", validPrefixSeq: 0, snapshotSeq: 7 });
		expect(await unsupported.repair()).toMatchObject({ status: "unsupported", repaired: false });
		await expect(new SessionIndex(dir).open()).rejects.toThrow(/Unsupported SDK state version/);
		const futureOne = { ...event("supported-prefix"), version: SDK_STATE_VERSION, indexSeq: 1, ts: 1 };
		const futureTwo = { ...event("future-event"), version: SESSION_INDEX_EVENT_VERSION + 1, indexSeq: 2, ts: 2 };
		await fs.writeFile(
			snapshotFile,
			JSON.stringify({
				version: 2,
				indexSeq: 2,
				events: [
					{
						...futureOne,
						checksum: sessionIndexChecksum(futureOne as Parameters<typeof sessionIndexChecksum>[0]),
					},
					{
						...futureTwo,
						checksum: sessionIndexChecksum(futureTwo as Parameters<typeof sessionIndexChecksum>[0]),
					},
				],
			}),
		);
		const futureSnapshot = new SessionIndex(dir);
		expect(await futureSnapshot.diagnose()).toMatchObject({
			status: "unsupported",
			validPrefixSeq: 1,
			snapshotSeq: 2,
		});
		expect(await futureSnapshot.repair()).toMatchObject({ status: "unsupported", repaired: false });
		await expect(futureSnapshot.open()).rejects.toThrow(/maximum supported version is 4/);
		const invalidFutureSnapshot = JSON.stringify({
			version: 2,
			indexSeq: 99,
			events: [
				{ ...futureOne, checksum: sessionIndexChecksum(futureOne as Parameters<typeof sessionIndexChecksum>[0]) },
				{ ...futureTwo, checksum: "invalid" },
			],
		});
		await fs.writeFile(snapshotFile, invalidFutureSnapshot);
		const invalidFuture = new SessionIndex(dir);
		expect(await invalidFuture.diagnose()).toMatchObject({
			status: "unsupported",
			validPrefixSeq: 1,
			snapshotSeq: 99,
		});
		expect(await invalidFuture.repair()).toMatchObject({ status: "unsupported", repaired: false });
		expect(await fs.readFile(snapshotFile, "utf8")).toBe(invalidFutureSnapshot);
		const legacy = { ...event("legacy"), version: 1 as const, indexSeq: 1, ts: 1 };
		const legacyEvent = {
			...legacy,
			checksum: sessionIndexChecksum(legacy as unknown as Parameters<typeof sessionIndexChecksum>[0]),
		};
		await fs.writeFile(snapshotFile, JSON.stringify({ version: 1, indexSeq: 1, events: [legacyEvent] }));
		const replay = await new SessionIndex(dir).open();
		expect(replay.listSessions().warnings).toEqual([]);
		expect(replay.listSessions().sessions.map(s => s.sessionId)).toEqual(["legacy"]);
	});
	it("fences locator-v2 log events from older readers before snapshot rotation", async () => {
		const dir = await fs.mkdtemp(path.join(process.env.TMPDIR ?? "/tmp", "gjc-index-event-fence-"));
		const sessionsDir = path.join(dir, "sdk", "sessions");
		const log = path.join(sessionsDir, "index.jsonl");
		await fs.mkdir(sessionsDir, { recursive: true });
		const legacy = {
			version: SDK_STATE_VERSION,
			indexSeq: 1,
			type: "host_registered" as const,
			sessionId: "legacy-prefix",
			locator: { repo: dir, stateRoot: path.join(dir, ".gjc", "state") },
			endpointGeneration: 1,
			pid: process.pid,
			ts: 1,
		};
		await fs.writeFile(
			log,
			`${JSON.stringify({
				...legacy,
				checksum: sessionIndexChecksum(legacy as unknown as Omit<SessionIndexEvent, "checksum">),
			})}\n`,
		);

		const index = await new SessionIndex(dir).open();
		const locatorV2 = await index.append(event("locator-v2"));
		expect(locatorV2.version).toBe(SESSION_INDEX_EVENT_VERSION);
		expect(await fs.exists(path.join(sessionsDir, "index.snapshot.json"))).toBe(false);

		const entries = (await fs.readFile(log, "utf8"))
			.trim()
			.split("\n")
			.map(line => JSON.parse(line));
		expect(entries).toMatchObject([
			{ version: SDK_STATE_VERSION },
			{ version: SESSION_INDEX_EVENT_VERSION, locator: { cwd: "r", worktreeRoot: null, stateRoot: "q" } },
		]);
		let thrown: unknown;
		try {
			for (const entry of entries) assertSupportedStateVersion(log, entry);
		} catch (error) {
			thrown = error;
		}
		expect(thrown).toBeInstanceOf(UnsupportedStateVersionError);
		expect(thrown).toMatchObject({
			code: "unsupported_state_version",
			version: SESSION_INDEX_EVENT_VERSION,
			maximumSupportedVersion: SDK_STATE_VERSION,
		});
	});
	it("compacts idempotently: a second snapshot of the same history is byte-identical", async () => {
		const dir = await fs.mkdtemp(path.join(process.env.TMPDIR ?? "/tmp", "gjc-index-"));
		const deadPid = await (async () => {
			const proc = Bun.spawn({ cmd: ["true"] });
			await proc.exited;
			return proc.pid;
		})();
		const index = await new SessionIndex(dir).open();
		await index.append(event("live"));
		await index.append({ ...event("dead"), pid: deadPid });
		await index.append({ ...event("dead"), type: "host_unregistered", pid: deadPid });
		await index.append({ ...event("live"), type: "host_heartbeat" });
		await index.append(event("live2"));
		const snapshotFile = path.join(dir, "sdk", "sessions", "index.snapshot.json");
		await index.snapshot();
		const first = await fs.readFile(snapshotFile, "utf8");
		const reopened = await new SessionIndex(dir).open();
		await reopened.snapshot();
		const second = await fs.readFile(snapshotFile, "utf8");
		expect(second).toBe(first);
	});
	it("diagnoses and repairs legacy sequence inversion without mutating dry evidence", async () => {
		const dir = await fs.mkdtemp(path.join(process.env.TMPDIR ?? "/tmp", "gjc-index-"));
		const index = await new SessionIndex(dir).open();
		await index.append(event("snapshot"));
		await index.snapshot();
		await index.append(event("valid-prefix"));
		const log = path.join(dir, "sdk", "sessions", "index.jsonl");
		const inverted = { ...event("inverted"), version: SDK_STATE_VERSION, indexSeq: 1, ts: 1 };
		await fs.appendFile(
			log,
			`${JSON.stringify({ ...inverted, checksum: sessionIndexChecksum(inverted as Parameters<typeof sessionIndexChecksum>[0]) })}\n`,
		);
		const before = await fs.readFile(log, "utf8");
		const corrupt = await new SessionIndex(dir).open();
		expect(await corrupt.diagnose()).toMatchObject({ status: "corrupt", snapshotSeq: 1, validPrefixSeq: 2 });
		expect(await fs.readFile(log, "utf8")).toBe(before);

		const repair = await corrupt.repair();
		expect(repair).toMatchObject({ status: "corrupt", repaired: true, validPrefixSeq: 2 });
		expect(repair.quarantinePath).toBeDefined();
		expect(await fs.readFile(path.join(repair.quarantinePath!, "index.jsonl"), "utf8")).toBe(before);
		expect((await new SessionIndex(dir).open()).indexSeq).toBe(2);
		const resumed = await new SessionIndex(dir).open();
		expect((await resumed.append(event("resumed"))).indexSeq).toBe(3);
		expect(await resumed.repair()).toMatchObject({ status: "healthy", repaired: false, validPrefixSeq: 3 });
	});
	it("quarantines an invalid snapshot and rebuilds from a valid log prefix", async () => {
		const dir = await fs.mkdtemp(path.join(process.env.TMPDIR ?? "/tmp", "gjc-index-invalid-snapshot-"));
		const index = await new SessionIndex(dir).open();
		await index.append(event("log-prefix"));
		const snapshot = path.join(dir, "sdk", "sessions", "index.snapshot.json");
		await fs.writeFile(snapshot, "not-json");
		const before = await fs.readFile(snapshot);
		const diagnosis = await index.diagnose();
		expect(diagnosis).toMatchObject({ status: "corrupt", reason: "invalid snapshot", validPrefixSeq: 1 });
		const repair = await index.repair();
		expect(repair).toMatchObject({ status: "corrupt", repaired: true, validPrefixSeq: 1 });
		expect(await fs.readFile(path.join(repair.quarantinePath!, "index.snapshot.json"))).toEqual(before);
		expect((await new SessionIndex(dir).open()).indexSeq).toBe(1);
	});
	it("detects checksum corruption in physical log history covered by a valid snapshot", async () => {
		const dir = await fs.mkdtemp(path.join(process.env.TMPDIR ?? "/tmp", "gjc-index-covered-history-"));
		const index = await new SessionIndex(dir).open();
		await index.append(event("snapshotted"));
		await index.snapshot();
		const log = path.join(dir, "sdk", "sessions", "index.jsonl");
		const rows = (await fs.readFile(log, "utf8")).trim().split("\n");
		const tampered = { ...(JSON.parse(rows[0]!) as SessionIndexEvent), checksum: "0".repeat(64) };
		await fs.writeFile(log, `${JSON.stringify(tampered)}\n`);
		const before = await fs.readFile(log);
		const diagnosis = await index.diagnose();
		expect(diagnosis).toMatchObject({ status: "corrupt", validPrefixSeq: 1 });
		const repair = await index.repair();
		expect(repair).toMatchObject({ status: "corrupt", repaired: true, validPrefixSeq: 1 });
		expect(await fs.readFile(path.join(repair.quarantinePath!, "index.jsonl"))).toEqual(before);
		expect((await new SessionIndex(dir).open()).indexSeq).toBe(1);
	});
	it("persists quarantine evidence before replacing the live snapshot or log", async () => {
		const dir = await fs.mkdtemp(path.join(process.env.TMPDIR ?? "/tmp", "gjc-index-quarantine-order-"));
		const index = await new SessionIndex(dir).open();
		await index.append(event("prefix"));
		const sessionsDir = path.join(dir, "sdk", "sessions");
		const log = path.join(sessionsDir, "index.jsonl");
		await fs.appendFile(log, "broken\n");
		const originalRename = fs.rename.bind(fs);
		let replacementChecks = 0;
		const rename = vi.spyOn(fs, "rename").mockImplementation(async (from, to) => {
			if (to === path.join(sessionsDir, "index.snapshot.json") || to === log) {
				const repairs = await fs.readdir(path.join(sessionsDir, "quarantine"));
				expect(repairs).toHaveLength(1);
				expect(await fs.readFile(path.join(sessionsDir, "quarantine", repairs[0]!, "index.jsonl"))).toEqual(
					await fs.readFile(log),
				);
				replacementChecks++;
			}
			await originalRename(from, to);
		});
		try {
			expect(await index.repair()).toMatchObject({ repaired: true });
		} finally {
			rename.mockRestore();
		}
		expect(replacementChecks).toBe(2);
	});
	it("does not recreate a retired index directory when a heartbeat pass runs", async () => {
		const dir = await fs.mkdtemp(path.join(process.env.TMPDIR ?? "/tmp", "gjc-index-retired-"));
		const index = await new SessionIndex(dir).open();
		await index.append(event("heartbeat-owner"));
		const sessionsDir = path.join(dir, "sdk", "sessions");
		expect(await fs.exists(sessionsDir)).toBe(true);

		// The owner retires the whole state root; the broker's periodic checkpoint must
		// observe "nothing to check point" rather than rebuilding the tree underneath it.
		await fs.rm(path.join(dir, "sdk"), { recursive: true, force: true });
		expect(await index.checkpointLiveHeartbeats()).toBe(0);
		expect(await fs.exists(sessionsDir)).toBe(false);
		expect(await fs.exists(path.join(dir, "sdk"))).toBe(false);
	});
	it("repairs a long history into a retention-bounded snapshot other clients can lock promptly", async () => {
		const dir = await fs.mkdtemp(path.join(process.env.TMPDIR ?? "/tmp", "gjc-index-repair-bound-"));
		const maxRows = 50;
		const policy = { maxRows };
		const seed = await new SessionIndex(dir, policy).open();
		// History that never reached a rotation boundary: the log alone carries every
		// event, so repair is what decides whether the republished snapshot is bounded.
		for (let i = 0; i < 400; i++) await seed.append(event(`session-${i}`));
		const sessionsDir = path.join(dir, "sdk", "sessions");
		const log = path.join(sessionsDir, "index.jsonl");
		const before = await fs.readFile(log);
		await fs.appendFile(log, "broken\n");

		const repair = await new SessionIndex(dir, policy).repair();
		expect(repair).toMatchObject({ status: "corrupt", repaired: true });
		expect(await fs.readFile(path.join(repair.quarantinePath!, "index.jsonl"))).toEqual(
			Buffer.concat([before, Buffer.from("broken\n")]),
		);
		// A repair republishes history as the snapshot; without retention it restores an
		// unbounded snapshot that every later locked transaction must re-parse, which is
		// how one broker starved every other client of the index lock.
		const snapshot = JSON.parse(await fs.readFile(path.join(sessionsDir, "index.snapshot.json"), "utf8")) as {
			events: SessionIndexEvent[];
		};
		expect(snapshot.events.length).toBeLessThanOrEqual(maxRows);
		// Repair truncates the log to match the snapshot: the pre-repair events are all
		// covered by the republished snapshot, so leaving them in place would force every
		// later #scan() to re-parse the full history under the lock.
		expect((await fs.readFile(path.join(sessionsDir, "index.jsonl"), "utf8")).trim()).toBe("");

		// A second client must still take the shared index lock while the repaired index
		// is in normal use, within a bound far below the 60s launch budget.
		const holder = await new SessionIndex(dir, policy).open();
		const contender = await new SessionIndex(dir, policy).open();
		await holder.append(event("post-repair"));
		const started = Date.now();
		await contender.withLocked(async () => undefined);
		expect(Date.now() - started).toBeLessThan(5_000);
		// The seeding above appends 400 fsynced rows; on slow CI filesystems that
		// setup alone can exceed the 5s default per-test ceiling even though the
		// lock-promptness contract asserted above stays far below it. Match the
		// other heavy multi-process tests in this file.
	}, 30_000);
	it("serializes repair with a racing writer and resumes after the retained prefix", async () => {
		const dir = await fs.mkdtemp(path.join(process.env.TMPDIR ?? "/tmp", "gjc-index-"));
		const seed = await new SessionIndex(dir).open();
		await seed.append(event("snapshot"));
		await seed.snapshot();
		await seed.append(event("prefix"));
		const inverted = { ...event("inverted"), version: SDK_STATE_VERSION, indexSeq: 1, ts: 1 };
		await fs.appendFile(
			path.join(dir, "sdk", "sessions", "index.jsonl"),
			`${JSON.stringify({ ...inverted, checksum: sessionIndexChecksum(inverted as Parameters<typeof sessionIndexChecksum>[0]) })}\n`,
		);
		const corrupt = await new SessionIndex(dir).open();
		const repairEntered = Promise.withResolvers<void>();
		const resumeRepair = Promise.withResolvers<void>();
		const quarantineRepairPrefix = path.join(dir, "sdk", "sessions", "quarantine", "repair-");
		const originalMkdir = fs.mkdir.bind(fs);
		const mkdir = vi.spyOn(fs, "mkdir").mockImplementation(async (target, options) => {
			if (typeof target === "string" && target.startsWith(quarantineRepairPrefix)) {
				repairEntered.resolve();
				await resumeRepair.promise;
			}
			await originalMkdir(target, options);
		});
		const repairing = corrupt.repair();
		try {
			await repairEntered.promise;
			const writer = new SessionIndex(dir);
			const appending = writer.append(event("racing-writer"));
			resumeRepair.resolve();
			const [repair, appended] = await Promise.all([repairing, appending]);
			expect(repair.validPrefixSeq).toBe(2);
			expect(appended.indexSeq).toBe(3);
			const replay = await new SessionIndex(dir).open();
			expect(replay.indexSeq).toBe(3);
			expect((await replay.diagnose()).status).toBe("healthy");
		} finally {
			resumeRepair.resolve();
			mkdir.mockRestore();
		}
	});
	it("does not unregister a same-session successor under the index lock", async () => {
		const dir = await fs.mkdtemp(path.join(process.env.TMPDIR ?? "/tmp", "gjc-index-unregister-"));
		const index = await new SessionIndex(dir).open();
		await index.append({
			...event("session"),
			pid: 1001,
			endpointMtimeMs: 1,
			lifecycleRequestId: "request-a",
			processIncarnation: "incarnation-a",
		});
		const predecessor = index.listSessions().sessions[0]!;
		await index.append({
			...event("session"),
			pid: 1002,
			endpointMtimeMs: 2,
			lifecycleRequestId: "request-b",
			processIncarnation: "incarnation-b",
		});
		expect(await index.unregisterIfCurrent(predecessor)).toBe(false);
		const successor = index.listSessions().sessions[0]!;
		expect(successor).toMatchObject({ pid: 1002, lifecycleRequestId: "request-b" });
		expect(await index.unregisterIfCurrent({ ...successor, hostIncarnation: "different-incarnation" })).toBe(false);
		expect(await index.unregisterIfCurrent(successor)).toBe(true);
		expect(index.listSessions().sessions).toEqual([
			expect.objectContaining({
				sessionId: "session",
				pid: 1002,
				lifecycleRequestId: "request-b",
				live: false,
				terminal: true,
			}),
		]);
	});
	it("does not unregister a concurrent terminal-uncertain record", async () => {
		const dir = await fs.mkdtemp(path.join(process.env.TMPDIR ?? "/tmp", "gjc-index-uncertain-"));
		const index = await new SessionIndex(dir).open();
		await index.append({
			...event("session"),
			pid: 1001,
			endpointMtimeMs: 1,
			lifecycleRequestId: "request",
			processIncarnation: "incarnation",
		});
		const predecessor = index.listSessions().sessions[0]!;
		await index.append({
			...event("session"),
			type: "lifecycle_terminal",
			pid: 1001,
			endpointMtimeMs: 1,
			lifecycleRequestId: "request",
			processIncarnation: "incarnation",
			terminalUncertain: true,
		});
		expect(await index.unregisterIfCurrent(predecessor)).toBe(false);
		expect(index.listSessions().sessions[0]).toMatchObject({
			sessionId: "session",
			terminalUncertain: true,
			live: false,
		});
	});
	it("never exposes a terminal-uncertain identity as live", async () => {
		const dir = await fs.mkdtemp(path.join(process.env.TMPDIR ?? "/tmp", "gjc-index-uncertain-live-"));
		const index = await new SessionIndex(dir).open();
		const registration = await index.append(event("session"));
		expect(await index.checkpointLiveHeartbeats()).toBe(1);
		expect(index.listSessions().sessions[0]).toMatchObject({ live: true });
		await index.append({
			type: "lifecycle_terminal",
			sessionId: registration.sessionId,
			locator: registration.locator,
			endpointGeneration: registration.endpointGeneration,
			pid: registration.pid,
			...(registration.processIncarnation === undefined
				? {}
				: { processIncarnation: registration.processIncarnation }),
			...(registration.hostIncarnation === undefined ? {} : { hostIncarnation: registration.hostIncarnation }),
			terminalUncertain: true,
		});
		expect(index.listSessions().sessions[0]).toMatchObject({ terminalUncertain: true, live: false });
	});
	it("fences unresolved state roots, then projects either surviving root as authority", async () => {
		for (const terminateHigherGeneration of [false, true]) {
			const dir = await fs.mkdtemp(path.join(process.env.TMPDIR ?? "/tmp", "gjc-index-ambiguous-"));
			const index = await new SessionIndex(dir).open();
			const sessionId = `ambiguous-${terminateHigherGeneration ? "higher" : "lower"}`;
			const alternate = await index.append({
				...event(sessionId),
				locator: { cwd: "alternate", worktreeRoot: null, stateRoot: "alternate-state" },
				endpointGeneration: 1,
			});
			const current = await index.append({
				...event(sessionId),
				locator: { cwd: "current", worktreeRoot: null, stateRoot: "current-state" },
				endpointGeneration: 2,
			});
			const terminated = terminateHigherGeneration ? current : alternate;
			const survivor = terminateHigherGeneration ? alternate : current;

			expect(index.listSessions().sessions).toEqual([
				expect.objectContaining({
					sessionId,
					endpointGeneration: current.endpointGeneration,
					ambiguous: true,
					live: false,
				}),
			]);
			const ambiguousSeq = index.indexSeq;
			expect(await index.checkpointLiveHeartbeats()).toBe(0);
			expect(index.indexSeq).toBe(ambiguousSeq);

			await index.append({
				type: "host_unregistered",
				sessionId: terminated.sessionId,
				locator: terminated.locator,
				endpointGeneration: terminated.endpointGeneration,
				pid: terminated.pid,
				...(terminated.processIncarnation === undefined
					? {}
					: { processIncarnation: terminated.processIncarnation }),
				...(terminated.hostIncarnation === undefined ? {} : { hostIncarnation: terminated.hostIncarnation }),
			});
			expect(index.listSessions().sessions).toEqual([
				expect.objectContaining({
					sessionId,
					endpointGeneration: survivor.endpointGeneration,
					locator: survivor.locator,
					ambiguous: false,
				}),
			]);
			expect(await index.checkpointLiveHeartbeats()).toBe(1);
			expect(index.listSessions().sessions).toEqual([
				expect.objectContaining({
					sessionId,
					endpointGeneration: survivor.endpointGeneration,
					ambiguous: false,
					live: true,
				}),
			]);
		}
	});
	it("does not fence a real endpoint root behind a generation-0 bookkeeping registration", async () => {
		// Regression: main.ts appends a direct-session GC fence row under the
		// agent dir with endpointGeneration 0 and no endpoint. That row must not
		// mark the session's real endpoint root ambiguous — every interactive
		// session would otherwise read live:false and chat daemons (Telegram)
		// could never attach any session (#post-0.13.1 notification outage).
		for (const bookkeepingFirst of [true, false]) {
			const dir = await fs.mkdtemp(path.join(process.env.TMPDIR ?? "/tmp", "gjc-index-bookkeeping-"));
			const index = await new SessionIndex(dir).open();
			const sessionId = `direct-${bookkeepingFirst ? "first" : "second"}`;
			const bookkeeping = {
				type: "host_registered" as const,
				sessionId,
				locator: { cwd: "r", worktreeRoot: null, stateRoot: dir },
				endpointGeneration: 0,
				pid: process.pid,
			};
			if (bookkeepingFirst) await index.append(bookkeeping);
			const real = await index.append(event(sessionId));
			if (!bookkeepingFirst) await index.append(bookkeeping);
			expect(await index.checkpointLiveHeartbeats()).toBe(1);
			expect(index.listSessions().sessions).toEqual([
				expect.objectContaining({
					sessionId,
					endpointGeneration: real.endpointGeneration,
					locator: real.locator,
					ambiguous: false,
					live: true,
				}),
			]);
		}
	});
	it("keeps fencing every generation-0 root that is not a proven bookkeeping registration", async () => {
		// The bookkeeping exemption is shape-scoped, not "generation === 0":
		// `recordTerminalUncertain` emits an unproven generation-0
		// `lifecycle_terminal` claim, and a malformed generation is not proof of
		// anything. Both must keep fencing a conflicting endpoint root closed.
		for (const conflicting of [
			{ name: "lifecycle-uncertain", type: "lifecycle_terminal" as const, endpointGeneration: 0 },
			{ name: "malformed-generation", type: "host_registered" as const, endpointGeneration: 1.5 },
		]) {
			const dir = await fs.mkdtemp(path.join(process.env.TMPDIR ?? "/tmp", "gjc-index-fence-"));
			const index = await new SessionIndex(dir).open();
			const sessionId = `fenced-${conflicting.name}`;
			await index.append({
				type: conflicting.type,
				sessionId,
				locator: { cwd: "other", worktreeRoot: null, stateRoot: "other-state" },
				endpointGeneration: conflicting.endpointGeneration,
				pid: process.pid,
			});
			await index.append(event(sessionId));
			expect(index.listSessions().sessions).toEqual([
				expect.objectContaining({ sessionId, ambiguous: true, live: false }),
			]);
			expect(await index.checkpointLiveHeartbeats()).toBe(0);
		}
	});
	it("keeps a sole live bookkeeping root as surviving authority after the endpoint root unregisters", async () => {
		// Exempting the bookkeeping row from the ambiguity fence must not change
		// surviving-authority selection: while the direct session process is still
		// registered, an unregistered endpoint root must not become the public row
		// (which would let lifecycle admit a delete for a live session).
		const dir = await fs.mkdtemp(path.join(process.env.TMPDIR ?? "/tmp", "gjc-index-survivor-"));
		const index = await new SessionIndex(dir).open();
		const sessionId = "survivor";
		const bookkeeping = await index.append({
			type: "host_registered",
			sessionId,
			locator: { cwd: "r", worktreeRoot: null, stateRoot: dir },
			endpointGeneration: 0,
			pid: process.pid,
		});
		const real = await index.append(event(sessionId));
		await index.append({
			type: "host_unregistered",
			sessionId,
			locator: real.locator,
			endpointGeneration: real.endpointGeneration,
			pid: real.pid,
			...(real.processIncarnation === undefined ? {} : { processIncarnation: real.processIncarnation }),
			...(real.hostIncarnation === undefined ? {} : { hostIncarnation: real.hostIncarnation }),
		});
		expect(index.listSessions().sessions).toEqual([
			expect.objectContaining({
				sessionId,
				endpointGeneration: bookkeeping.endpointGeneration,
				locator: bookkeeping.locator,
				ambiguous: false,
				terminal: false,
			}),
		]);
	});
	it("still fences a generation-0 registration that does not carry agent-dir provenance", async () => {
		// The exemption is bound to the direct-session GC fence row's durable
		// provenance (agent dir as state root). A foreign or legacy generation-0
		// registration proves nothing and must keep fencing, or the fence is
		// fail-open relative to the symmetric rule it relaxes.
		const dir = await fs.mkdtemp(path.join(process.env.TMPDIR ?? "/tmp", "gjc-index-foreign-"));
		const index = await new SessionIndex(dir).open();
		const sessionId = "foreign-zero";
		await index.append({
			type: "host_registered",
			sessionId,
			locator: { cwd: "elsewhere", worktreeRoot: null, stateRoot: "not-the-agent-dir" },
			endpointGeneration: 0,
			pid: process.pid,
		});
		await index.append(event(sessionId));
		expect(index.listSessions().sessions).toEqual([
			expect.objectContaining({ sessionId, ambiguous: true, live: false }),
		]);
		expect(await index.checkpointLiveHeartbeats()).toBe(0);
	});
	it("recognizes the fence row when writer and reader spell the agent dir differently", async () => {
		// The row's state root is whatever spelling the writing process used. A
		// symlinked agent dir read back via its realpath (or the reverse) must
		// still be recognized, or every session is re-fenced and no chat daemon
		// can attach — the original outage, reintroduced by a stricter check.
		const real = await fs.mkdtemp(path.join(process.env.TMPDIR ?? "/tmp", "gjc-index-real-"));
		const link = `${real}-link`;
		await fs.symlink(real, link);
		const sessionId = "symlinked-agent-dir";
		// Reader opens through the symlink; writer recorded the realpath.
		const index = await new SessionIndex(link).open();
		await index.append({
			type: "host_registered",
			sessionId,
			locator: { cwd: "r", worktreeRoot: null, stateRoot: real },
			endpointGeneration: 0,
			pid: process.pid,
		});
		const endpointRoot = await index.append(event(sessionId));
		expect(index.listSessions().sessions).toEqual([
			expect.objectContaining({
				sessionId,
				endpointGeneration: endpointRoot.endpointGeneration,
				ambiguous: false,
			}),
		]);
		expect(await index.checkpointLiveHeartbeats()).toBe(1);
	});
	it("promotes the sole surviving endpoint root once a competing root unregisters", async () => {
		// With the GC fence row plus two endpoint roots, resolving the conflict
		// must publish the endpoint root that is still live — never the terminated
		// one, even though it holds the higher generation. Otherwise SessionRouter
		// stays detached after the ambiguity clears.
		for (const terminatedIsHigher of [true, false]) {
			const dir = await fs.mkdtemp(path.join(process.env.TMPDIR ?? "/tmp", "gjc-index-promote-"));
			const index = await new SessionIndex(dir).open();
			const sessionId = `promote-${terminatedIsHigher ? "higher" : "lower"}`;
			await index.append({
				type: "host_registered",
				sessionId,
				locator: { cwd: "r", worktreeRoot: null, stateRoot: dir },
				endpointGeneration: 0,
				pid: process.pid,
			});
			const survivor = await index.append({
				...event(sessionId),
				locator: { cwd: "survivor", worktreeRoot: null, stateRoot: "survivor-root" },
				endpointGeneration: terminatedIsHigher ? 1 : 2,
			});
			const terminated = await index.append({
				...event(sessionId),
				locator: { cwd: "terminated", worktreeRoot: null, stateRoot: "terminated-root" },
				endpointGeneration: terminatedIsHigher ? 2 : 1,
			});
			expect(index.listSessions().sessions).toEqual([
				expect.objectContaining({ sessionId, ambiguous: true, live: false }),
			]);
			await index.append({
				type: "host_unregistered",
				sessionId,
				locator: terminated.locator,
				endpointGeneration: terminated.endpointGeneration,
				pid: terminated.pid,
				...(terminated.processIncarnation === undefined
					? {}
					: { processIncarnation: terminated.processIncarnation }),
				...(terminated.hostIncarnation === undefined ? {} : { hostIncarnation: terminated.hostIncarnation }),
			});
			expect(index.listSessions().sessions).toEqual([
				expect.objectContaining({
					sessionId,
					endpointGeneration: survivor.endpointGeneration,
					locator: survivor.locator,
					ambiguous: false,
					terminal: false,
				}),
			]);
			expect(await index.checkpointLiveHeartbeats()).toBe(1);
			expect(index.listSessions().sessions[0]).toMatchObject({ live: true });
		}
	});
	it("hides deleted sessions until a later registration establishes new authority", async () => {
		const dir = await fs.mkdtemp(path.join(process.env.TMPDIR ?? "/tmp", "gjc-index-deleted-"));
		const index = await new SessionIndex(dir).open();
		const registration = await index.append(event("deleted"));
		await index.append({
			type: "session_deleted",
			sessionId: registration.sessionId,
			locator: registration.locator,
			endpointGeneration: registration.endpointGeneration,
			pid: registration.pid,
			...(registration.processIncarnation === undefined
				? {}
				: { processIncarnation: registration.processIncarnation }),
			...(registration.hostIncarnation === undefined ? {} : { hostIncarnation: registration.hostIncarnation }),
		});
		expect(index.listSessions().sessions).toEqual([]);

		await index.append({
			type: "host_heartbeat",
			sessionId: registration.sessionId,
			locator: registration.locator,
			endpointGeneration: registration.endpointGeneration,
			pid: registration.pid,
			...(registration.processIncarnation === undefined
				? {}
				: { processIncarnation: registration.processIncarnation }),
			...(registration.hostIncarnation === undefined ? {} : { hostIncarnation: registration.hostIncarnation }),
		});
		expect(index.listSessions().sessions).toEqual([]);

		await index.append({ ...event("deleted"), endpointGeneration: registration.endpointGeneration + 1 });
		expect(index.listSessions().sessions).toEqual([
			expect.objectContaining({ sessionId: "deleted", endpointGeneration: registration.endpointGeneration + 1 }),
		]);
	});
	it("preserves closure before deletion but rejects delayed closure evidence", async () => {
		const dir = await fs.mkdtemp(path.join(process.env.TMPDIR ?? "/tmp", "gjc-index-retirement-evidence-"));
		const index = await new SessionIndex(dir).open();
		const expected = {
			sessionId: "retirement-evidence",
			stateRoot: dir,
			endpointGeneration: 1,
			pid: process.pid,
			processIncarnation: "retirement-process",
			hostIncarnation: "retirement-host",
			endpointMtimeMs: 11,
			lifecycleRequestId: "retirement-request",
		};
		try {
			await index.append({
				type: "host_registered",
				locator: { cwd: dir, worktreeRoot: null, stateRoot: dir },
				...expected,
			});
			const closed = await index.append({
				type: "session_closed",
				locator: { cwd: dir, worktreeRoot: null, stateRoot: dir },
				...expected,
			});
			await index.append({
				type: "session_deleted",
				locator: { cwd: dir, worktreeRoot: null, stateRoot: dir },
				...expected,
			});
			const historical = index.findHistoricalSessionIdentity(expected);
			if (!historical) throw new Error("Expected historical retirement identity");
			expect(index.findSessionClosedEvidence(historical)).toBe(closed.indexSeq);

			const delayedExpected = { ...expected, sessionId: "retirement-delayed" };
			await index.append({
				type: "host_registered",
				locator: { cwd: dir, worktreeRoot: null, stateRoot: dir },
				...delayedExpected,
			});
			await index.append({
				type: "session_deleted",
				locator: { cwd: dir, worktreeRoot: null, stateRoot: dir },
				...delayedExpected,
			});
			await index.append({
				type: "session_closed",
				locator: { cwd: dir, worktreeRoot: null, stateRoot: dir },
				...delayedExpected,
			});
			const delayedHistorical = index.findHistoricalSessionIdentity(delayedExpected);
			if (!delayedHistorical) throw new Error("Expected delayed historical identity");
			expect(index.findSessionClosedEvidence(delayedHistorical)).toBeUndefined();
			expect(index.findSessionTerminalEvidence(delayedHistorical)).toEqual({
				type: "session_deleted",
				indexSeq: 5,
			});
		} finally {
			await fs.rm(dir, { recursive: true, force: true });
		}
	});
	it("resolves legacy retirement authority only from one retained file-bound identity", async () => {
		const dir = await fs.mkdtemp(path.join(process.env.TMPDIR ?? "/tmp", "gjc-index-legacy-file-bound-"));
		const index = await new SessionIndex(dir).open();
		const expected = {
			sessionId: "legacy-file-bound",
			stateRoot: dir,
			endpointGeneration: 1,
			pid: process.pid,
			processIncarnation: "legacy-process",
			hostIncarnation: "legacy-host",
			endpointMtimeMs: 11,
			lifecycleRequestId: "legacy-request",
		};
		try {
			await index.append({
				type: "host_registered",
				locator: { cwd: dir, worktreeRoot: null, stateRoot: dir },
				...expected,
			});
			expect(index.findUniqueHistoricalFileBoundSessionIdentity(expected)).toBeUndefined();

			await index.append({
				type: "lifecycle_terminal",
				locator: { cwd: dir, worktreeRoot: null, stateRoot: dir },
				...expected,
				endpointFileId: "1:1",
				terminalUncertain: true,
			});
			expect(index.findUniqueHistoricalFileBoundSessionIdentity(expected)).toMatchObject({
				endpointFileId: "1:1",
			});

			await index.append({
				type: "lifecycle_terminal",
				locator: { cwd: dir, worktreeRoot: null, stateRoot: dir },
				...expected,
				endpointFileId: "2:2",
				terminalUncertain: true,
			});
			expect(index.findUniqueHistoricalFileBoundSessionIdentity(expected)).toBeUndefined();
		} finally {
			await fs.rm(dir, { recursive: true, force: true });
		}
	});
	it("refreshIfChanged skips the locked rescan while the index is unchanged (#4689)", async () => {
		const dir = await fs.mkdtemp(path.join(process.env.TMPDIR ?? "/tmp", "gjc-index-poll-"));
		await new SessionIndex(dir).append(event("polled"));
		const index = new SessionIndex(dir);
		// First poll establishes the baseline stamp and loads state.
		expect(await index.refreshIfChanged()).toBe(true);
		expect(index.listSessions().sessions).toEqual([expect.objectContaining({ sessionId: "polled" })]);

		// An unchanged index must not be re-read: count log reads across polls.
		const logPath = path.join(dir, "sdk", "sessions", "index.jsonl");
		const readFile = fs.readFile.bind(fs);
		let logReads = 0;
		const spy = vi.spyOn(fs, "readFile").mockImplementation((async (file: unknown, options?: unknown) => {
			if (path.resolve(String(file)) === logPath) logReads++;
			return await readFile(file as Parameters<typeof fs.readFile>[0], options as BufferEncoding);
		}) as typeof fs.readFile);
		// Reads alone are not the regression that matters: the idle cost this fix
		// removes is contention on the machine-global session-index lock. A change
		// that put the unchanged path back under `withFileLock()` without reading
		// would satisfy `logReads === 0` while restoring the exact starvation.
		let lockAttempts = 0;
		FileLockTestHooks.afterParentMkdir = () => {
			lockAttempts++;
		};
		try {
			for (let i = 0; i < 5; i++) expect(await index.refreshIfChanged()).toBe(false);
			expect(logReads).toBe(0);
			expect(lockAttempts).toBe(0);
			expect(index.listSessions().sessions).toEqual([expect.objectContaining({ sessionId: "polled" })]);
		} finally {
			FileLockTestHooks.afterParentMkdir = undefined;
			spy.mockRestore();
		}
	});
	it("a changed index still takes the session-index lock, so the no-lock assertion discriminates (#4689)", async () => {
		const dir = await fs.mkdtemp(path.join(process.env.TMPDIR ?? "/tmp", "gjc-index-poll-lock-"));
		const writer = new SessionIndex(dir);
		await writer.append(event("locked"));
		const index = new SessionIndex(dir);
		expect(await index.refreshIfChanged()).toBe(true);

		let lockAttempts = 0;
		FileLockTestHooks.afterParentMkdir = () => {
			lockAttempts++;
		};
		try {
			// Control: an unchanged poll is lock-free.
			expect(await index.refreshIfChanged()).toBe(false);
			expect(lockAttempts).toBe(0);
			// A durable append must still reclassify under the index lock, proving the
			// zero-lock assertion above is a real behavioral fence and not vacuous.
			await writer.append(event("locked-2"));
			lockAttempts = 0;
			expect(await index.refreshIfChanged()).toBe(true);
			expect(lockAttempts).toBeGreaterThan(0);
			expect(index.indexSeq).toBe(writer.indexSeq);
		} finally {
			FileLockTestHooks.afterParentMkdir = undefined;
		}
	});
	it("refreshIfChanged reloads after an external append and after log removal (#4689)", async () => {
		const dir = await fs.mkdtemp(path.join(process.env.TMPDIR ?? "/tmp", "gjc-index-poll-reload-"));
		const writer = new SessionIndex(dir);
		await writer.append(event("first"));
		const reader = new SessionIndex(dir);
		expect(await reader.refreshIfChanged()).toBe(true);
		expect(reader.listSessions().sessions).toEqual([expect.objectContaining({ sessionId: "first" })]);

		await writer.append(event("second"));
		expect(await reader.refreshIfChanged()).toBe(true);
		expect(reader.indexSeq).toBe(writer.indexSeq);

		await fs.rm(path.join(dir, "sdk", "sessions", "index.jsonl"));
		expect(await reader.refreshIfChanged()).toBe(true);
		expect(reader.listSessions().sessions).toEqual([]);
	});
	it("refreshIfChanged observes same-instance rotation compaction (#4689 review)", async () => {
		// A self-rotation resets the log offset; the fast path must never accept
		// the new stamp while pre-compaction events are still resident.
		const dir = await fs.mkdtemp(path.join(process.env.TMPDIR ?? "/tmp", "gjc-index-rotate-"));
		// maxRows makes rotation drop rows, so stale pre-compaction memory is
		// distinguishable from the compacted on-disk truth.
		const index = new SessionIndex(dir, { maxRows: 10 });
		// Direct-write a valid log right at the rotation threshold so the next
		// append rotates. 15k small terminal rows ≈ 4.2 MiB.
		const lines: string[] = [];
		let seq = 0;
		const now = Date.now();
		for (let i = 0; i < 7500; i++) {
			for (const type of ["host_registered", "host_unregistered"] as const) {
				const unsigned = {
					version: SDK_STATE_VERSION,
					indexSeq: ++seq,
					type,
					sessionId: `old-${i}`,
					locator: { cwd: "/tmp/old", worktreeRoot: null, stateRoot: "/tmp/old/.gjc/state" },
					endpointGeneration: 1,
					pid: 2147480000 + i,
					ts: now - (7500 - i) * 2000,
				};
				lines.push(
					JSON.stringify({
						...unsigned,
						checksum: sessionIndexChecksum(unsigned as Parameters<typeof sessionIndexChecksum>[0]),
					}),
				);
			}
		}
		const sessionsDir = path.join(dir, "sdk", "sessions");
		await fs.mkdir(sessionsDir, { recursive: true, mode: 0o700 });
		await fs.writeFile(path.join(sessionsDir, "index.jsonl"), `${lines.join("\n")}\n`);
		await index.open();
		expect(index.indexSeq).toBe(seq);
		// This append crosses the 4 MiB rotation bound and rotates in-instance.
		await index.append(event("trigger"));
		const fresh = await new SessionIndex(dir, { maxRows: 10 }).open();
		// Compaction must have dropped the bulk of the seeded rows.
		expect(fresh.listSessions().sessions.length).toBeLessThan(100);
		// The rotated instance must agree with a from-disk reader exactly.
		expect(index.listSessions().sessions).toEqual(fresh.listSessions().sessions);
		expect(index.indexSeq).toBe(fresh.indexSeq);
		// And the fast path must not resurrect pre-compaction state.
		expect(await index.refreshIfChanged()).toBe(false);
		expect(index.listSessions().sessions).toEqual(fresh.listSessions().sessions);
	});
	it("refreshIfChanged never fast-paths a corrupt suffix (#4689 review)", async () => {
		const dir = await fs.mkdtemp(path.join(process.env.TMPDIR ?? "/tmp", "gjc-index-poll-corrupt-"));
		const writer = new SessionIndex(dir);
		await writer.append(event("corrupt-me"));
		await fs.appendFile(path.join(dir, "sdk", "sessions", "index.jsonl"), "broken\n");
		const reader = new SessionIndex(dir);
		expect(await reader.refreshIfChanged()).toBe(true);
		expect(reader.listSessions().warnings).not.toHaveLength(0);
		// Corrupt state always reloads instead of taking the stamp fast path.
		expect(await reader.refreshIfChanged()).toBe(true);
		expect(reader.listSessions().warnings).not.toHaveLength(0);
	});
	it("refreshIfChanged detects a same-size rename-replace whose timestamps collide (#4689)", async () => {
		// The cheap path must not depend on timestamp resolution. A same-size
		// rename-replace inside one filesystem tick reports identical size,
		// mtimeMs and ctimeMs (measured here: the overwhelming majority of
		// attempts), so a stamp built only from size+timestamps would report
		// "unchanged" after a real snapshot replacement. The cooperative writer
		// protocol replaces files by rename, which always installs a new inode,
		// so the inode is the field that makes this detectable.
		const dir = await fs.mkdtemp(path.join(process.env.TMPDIR ?? "/tmp", "gjc-index-ino-"));
		const writer = new SessionIndex(dir);
		const first = await writer.append(event("ino-old"));
		await writer.snapshot();
		const reader = new SessionIndex(dir);
		expect(await reader.refreshIfChanged()).toBe(true);
		expect(reader.listSessions().sessions.map(s => s.sessionId)).toEqual(["ino-old"]);

		const snapPath = path.join(dir, "sdk", "sessions", "index.snapshot.json");
		const buildPayload = (sessionId: string) => {
			const replacement = {
				version: SDK_STATE_VERSION,
				indexSeq: first.indexSeq,
				type: "host_registered" as const,
				sessionId,
				locator: { cwd: "r", worktreeRoot: null, stateRoot: "q" },
				endpointGeneration: 1,
				pid: process.pid,
				ts: first.ts,
			};
			return JSON.stringify({
				version: 3,
				indexSeq: first.indexSeq,
				events: [
					{
						...replacement,
						checksum: sessionIndexChecksum(replacement as Parameters<typeof sessionIndexChecksum>[0]),
					},
				],
			});
		};
		// Reproduce a natural timestamp collision: replace by rename until the
		// post-replacement stat is indistinguishable from the pre-replacement
		// stat on size+mtimeMs+ctimeMs, leaving the inode as the only signal.
		let collided = false;
		let detectedOnCollision = false;
		let detectedAnyReplacement = false;
		let expected = "";
		for (let attempt = 0; attempt < 200 && !collided; attempt++) {
			const before = await fs.stat(snapPath);
			expected = `ino-new-${String(attempt).padStart(3, "0")}`;
			const payload = buildPayload(expected);
			const staging = `${snapPath}.collide-${attempt}.tmp`;
			await fs.writeFile(staging, payload);
			await fs.rename(staging, snapPath);
			const after = await fs.stat(snapPath);
			collided =
				after.size === before.size &&
				after.mtimeMs === before.mtimeMs &&
				after.ctimeMs === before.ctimeMs &&
				after.ino !== before.ino;
			// Always consume the poll from THIS iteration and keep its result:
			// asserting a later refresh would test a call that sees no change.
			const detected = await reader.refreshIfChanged();
			detectedAnyReplacement ||= detected;
			if (collided) detectedOnCollision = detected;
		}
		// Some filesystems expose ctime with enough precision that a rename-replace
		// never collides on size+timestamps within this bounded loop. That is an
		// environment limitation, not a product failure; still verify that the
		// ordinary replacement was detected before leaving the test.
		if (!collided) {
			expect(detectedAnyReplacement).toBe(true);
			return;
		}
		expect(detectedOnCollision).toBe(true);
		// Only the inode changed, and the poll from that exact iteration reported
		// a change and fully replayed the replacement snapshot.
		expect(reader.listSessions().sessions.map(s => s.sessionId)).toEqual([expected]);
	});
	it("log growth plus an inode-only snapshot replacement replays instead of tailing (#4730 review)", async () => {
		// The locked classifier may only tail when this is the SAME log grown in
		// place AND the SAME snapshot file. A rename-over installs a new inode
		// while size and timestamps can still match, so the combination -- log
		// grew, snapshot swapped for a same-size/same-timestamp file -- must
		// replay; tailing would cache a stale compacted projection and serve it as
		// current. Each half is covered separately elsewhere; this pins the
		// combination, and it is asserted through the real reader so a
		// misclassification shows up as a divergent projection.
		const dir = await fs.mkdtemp(path.join(process.env.TMPDIR ?? "/tmp", "gjc-index-tail-ino-"));
		const writer = new SessionIndex(dir);
		const first = await writer.append(event("combo-a"));
		await writer.snapshot();
		const reader = new SessionIndex(dir);
		expect(await reader.refreshIfChanged()).toBe(true);
		expect(reader.listSessions().sessions.map(s => s.sessionId)).toEqual(["combo-a"]);

		const snapPath = path.join(dir, "sdk", "sessions", "index.snapshot.json");
		const before = await fs.stat(snapPath);
		// Build a VALID signed snapshot of identical byte length naming a
		// different session, so only a real replay can observe it.
		const target = Number(before.size);
		let swapped = "";
		for (let pad = 0; pad < 500 && !swapped; pad++) {
			const replacement = {
				version: SDK_STATE_VERSION,
				indexSeq: first.indexSeq,
				type: "host_registered" as const,
				sessionId: "combo-z",
				locator: { cwd: "r".repeat(1 + pad), worktreeRoot: null, stateRoot: "q" },
				endpointGeneration: 1,
				pid: process.pid,
				ts: first.ts,
			};
			const candidate = JSON.stringify({
				version: 3,
				indexSeq: first.indexSeq,
				events: [
					{
						...replacement,
						checksum: sessionIndexChecksum(replacement as Parameters<typeof sessionIndexChecksum>[0]),
					},
				],
			});
			if (Buffer.byteLength(candidate) === target) swapped = candidate;
		}
		expect(swapped.length).toBeGreaterThan(0);

		// Grow the log through the real writer so the log side looks append-only,
		// then rename-replace the snapshot: same size, new inode.
		await writer.append(event("combo-b"));
		const staging = `${snapPath}.combo.tmp`;
		await fs.writeFile(staging, swapped);
		await fs.rename(staging, snapPath);
		const after = await fs.stat(snapPath);
		expect(Number(after.size)).toBe(target);
		expect(after.ino).not.toBe(before.ino);

		// The reader must converge on the writer's durable sequence and observe the
		// replaced snapshot, not a tail-cached prefix of the old one.
		expect(await reader.refreshIfChanged()).toBe(true);
		expect(reader.indexSeq).toBe(writer.indexSeq);
		expect(reader.listSessions().sessions.map(s => s.sessionId)).toContain("combo-z");
	});
	it("refreshIfChanged fully replays same-size rewrites and snapshot-only changes (#4689 QA)", async () => {
		const dir = await fs.mkdtemp(path.join(process.env.TMPDIR ?? "/tmp", "gjc-index-poll-rewrite-"));
		const writer = new SessionIndex(dir);
		await writer.append(event("alpha"));
		const reader = new SessionIndex(dir);
		expect(await reader.refreshIfChanged()).toBe(true);
		expect(reader.listSessions().sessions.map(s => s.sessionId)).toEqual(["alpha"]);

		// Same-size in-place rewrite of the log: stamp changes, tail cannot see it.
		const logPath = path.join(dir, "sdk", "sessions", "index.jsonl");
		const original = (await fs.readFile(logPath, "utf8")).trim();
		const originalParsed = JSON.parse(original);
		const rewritten: Record<string, unknown> = {
			...originalParsed,
			sessionId: "omega!",
			ts: originalParsed.ts + 1,
		};
		delete rewritten.checksum;
		// Pad to the identical byte length so size alone cannot detect the rewrite.
		const lineFor = (obj: Record<string, unknown>) =>
			`${JSON.stringify({ ...obj, checksum: sessionIndexChecksum(obj as never) })}\n`;
		const target = original.length + 1;
		// Tune sessionId/repo so the rewrite has the identical byte length and
		// size alone cannot detect it.
		while (lineFor(rewritten).length > target && (rewritten.sessionId as string).length > 1)
			rewritten.sessionId = (rewritten.sessionId as string).slice(0, -1);
		const pad = target - lineFor(rewritten).length;
		expect(pad).toBeGreaterThanOrEqual(0);
		if (pad > 0)
			rewritten.locator = {
				...(rewritten.locator as { repo: string; stateRoot: string }),
				repo: `${(rewritten.locator as { repo: string }).repo}${"x".repeat(pad)}`,
			};
		const line = lineFor(rewritten);
		expect(line.length).toBe(target);
		await fs.writeFile(logPath, line);
		// The stamp detects same-size rewrites by mtime/ctime; a fast test can
		// write within the original tick, so move the timestamp explicitly.
		const later = new Date(Date.now() + 5000);
		await fs.utimes(logPath, later, later);
		expect(await reader.refreshIfChanged()).toBe(true);
		expect(reader.listSessions().sessions.map(s => s.sessionId)).toEqual([String(rewritten.sessionId)]);
	});
	it("refreshIfChanged fully replays a snapshot-only replacement (#4689 QA)", async () => {
		const dir = await fs.mkdtemp(path.join(process.env.TMPDIR ?? "/tmp", "gjc-index-poll-snaponly-"));
		const writer = new SessionIndex(dir);
		const first = await writer.append(event("snap-old"));
		await writer.snapshot();
		const reader = new SessionIndex(dir);
		expect(await reader.refreshIfChanged()).toBe(true);
		expect(reader.listSessions().sessions.map(s => s.sessionId)).toEqual(["snap-old"]);

		// Replace only the snapshot payload; log untouched.
		const replacement = {
			version: SDK_STATE_VERSION,
			indexSeq: first.indexSeq,
			type: "host_registered" as const,
			sessionId: "snap-new",
			locator: { cwd: "r", worktreeRoot: null, stateRoot: "q" },
			endpointGeneration: 1,
			pid: process.pid,
			ts: first.ts,
		};
		const snapshot = {
			version: 3,
			indexSeq: first.indexSeq,
			events: [
				{
					...replacement,
					checksum: sessionIndexChecksum(replacement as Parameters<typeof sessionIndexChecksum>[0]),
				},
			],
		};
		const snapFile = path.join(dir, "sdk", "sessions", "index.snapshot.json");
		await fs.writeFile(snapFile, JSON.stringify(snapshot));
		const snapLater = new Date(Date.now() + 5000);
		await fs.utimes(snapFile, snapLater, snapLater);
		expect(await reader.refreshIfChanged()).toBe(true);
		expect(reader.listSessions().sessions.map(s => s.sessionId)).toEqual(["snap-new"]);
	});
	it("refreshIfChanged reclassifies under the lock when a compaction lands mid-poll (#4689 review)", async () => {
		const dir = await fs.mkdtemp(path.join(process.env.TMPDIR ?? "/tmp", "gjc-index-poll-race-"));
		const logPath = path.join(dir, "sdk", "sessions", "index.jsonl");
		const writer = new SessionIndex(dir);
		await writer.append(event("base"));
		await writer.snapshot();
		// Post-rotation shape for the reader: snapshot carries "base", log is empty.
		await fs.writeFile(logPath, "");
		const reader = new SessionIndex(dir);
		expect(await reader.refreshIfChanged()).toBe(true);
		expect(reader.listSessions().sessions.map(s => s.sessionId)).toEqual(["base"]);

		// Append-only growth from the reader's viewpoint: log grows, snapshot untouched.
		await writer.append(event("late"));
		// A compaction lands between the reader's unlocked stat and its locked
		// classification: snapshot rewritten through both events, log replaced empty.
		const originalHook = FileLockTestHooks.afterParentMkdir;
		let interleaved = false;
		FileLockTestHooks.afterParentMkdir = async () => {
			if (interleaved) return;
			interleaved = true;
			// Rotation shape, with raw file ops only (a SessionIndex op here would
			// queue behind this very lock attempt on the per-path op queue). The
			// existing snapshot carries "base"; the log carries only "late" (the
			// log was truncated after the first snapshot, emulating rotation).
			const snapPath = path.join(dir, "sdk", "sessions", "index.snapshot.json");
			const prior = JSON.parse(await fs.readFile(snapPath, "utf8"));
			const tail = (await fs.readFile(logPath, "utf8"))
				.split("\n")
				.filter(Boolean)
				.map(line => JSON.parse(line));
			const events = [...prior.events, ...tail];
			const snap = { version: 3, indexSeq: events.at(-1).indexSeq, events };
			await fs.writeFile(snapPath, JSON.stringify(snap));
			await fs.writeFile(logPath, "");
		};
		try {
			expect(await reader.refreshIfChanged()).toBe(true);
		} finally {
			FileLockTestHooks.afterParentMkdir = originalHook;
		}
		expect(interleaved).toBe(true);
		// Without locked reclassification the tail read sees an empty log at
		// offset 0 and keeps the stale projection; the locked path must replay.
		expect(reader.listSessions().sessions.map(s => s.sessionId)).toEqual(["base", "late"]);
	});
	it("quarantines legacy repo-only rows with a re-register diagnostic", async () => {
		const dir = await fs.mkdtemp(path.join(process.env.TMPDIR ?? "/tmp", "gjc-index-legacy-locator-"));
		const legacy = {
			version: SDK_STATE_VERSION,
			indexSeq: 1,
			type: "host_registered" as const,
			sessionId: "legacy-session",
			locator: { repo: dir, stateRoot: path.join(dir, ".gjc", "state") },
			endpointGeneration: 1,
			pid: process.pid,
			ts: Date.now(),
		};
		const line = {
			...legacy,
			checksum: sessionIndexChecksum(legacy as unknown as Omit<SessionIndexEvent, "checksum">),
		};
		const sessionsDir = path.join(dir, "sdk", "sessions");
		await fs.mkdir(sessionsDir, { recursive: true });
		await fs.writeFile(path.join(sessionsDir, "index.jsonl"), `${JSON.stringify(line)}\n`);
		const index = await new SessionIndex(dir).open();
		expect(index.listSessions().sessions).toEqual([]);
		expect(index.listSessions().warnings).toContain(
			"Session legacy-session has a legacy locator row and must re-register.",
		);
		const audit = await fs.readFile(path.join(sessionsDir, "index-audit.jsonl"), "utf8");
		expect(audit).toContain('"code":"rejected_legacy_locator"');
		expect(audit).toContain('"sessionId":"legacy-session"');
	});
	it("quarantines mixed locator rows that retain a legacy repo key", async () => {
		const dir = await fs.mkdtemp(path.join(process.env.TMPDIR ?? "/tmp", "gjc-index-mixed-locator-"));
		const mixed = {
			version: SDK_STATE_VERSION,
			indexSeq: 1,
			type: "host_registered" as const,
			sessionId: "mixed-session",
			locator: { cwd: dir, worktreeRoot: null, stateRoot: path.join(dir, ".gjc", "state"), repo: dir },
			endpointGeneration: 1,
			pid: process.pid,
			ts: Date.now(),
		};
		const line = {
			...mixed,
			checksum: sessionIndexChecksum(mixed as unknown as Omit<SessionIndexEvent, "checksum">),
		};
		const sessionsDir = path.join(dir, "sdk", "sessions");
		await fs.mkdir(sessionsDir, { recursive: true });
		await fs.writeFile(path.join(sessionsDir, "index.jsonl"), `${JSON.stringify(line)}\n`);
		const index = await new SessionIndex(dir).open();
		expect(index.listSessions().sessions).toEqual([]);
		expect(index.listSessions().warnings).toContain(
			"Session mixed-session has a legacy locator row and must re-register.",
		);
	});
	it("accepts v4 events and snapshots across scan, replay, tail, append, and repair (#5181)", async () => {
		const dir = await fs.mkdtemp(path.join(process.env.TMPDIR ?? "/tmp", "gjc-index-v4-accept-"));
		const sessionsDir = path.join(dir, "sdk", "sessions");
		const logPath = path.join(sessionsDir, "index.jsonl");
		const snapshotPath = path.join(sessionsDir, "index.snapshot.json");
		await fs.mkdir(sessionsDir, { recursive: true });
		const v4Event = (sessionId: string, indexSeq: number) => {
			const unsigned = {
				...event(sessionId),
				version: SESSION_INDEX_EVENT_VERSION,
				indexSeq,
				ts: 1,
			};
			return { ...unsigned, checksum: sessionIndexChecksum(unsigned as Parameters<typeof sessionIndexChecksum>[0]) };
		};

		// Scan + replay of a v4-only log must stay healthy and project the session.
		await fs.writeFile(logPath, `${JSON.stringify(v4Event("v4-a", 1))}\n`);
		const scanned = new SessionIndex(dir);
		expect(await scanned.diagnose()).toMatchObject({ status: "healthy", validPrefixSeq: 1 });
		const replayed = await new SessionIndex(dir).open();
		expect(replayed.listSessions().sessions.map(s => s.sessionId)).toEqual(["v4-a"]);
		expect(replayed.listSessions().warnings).toEqual([]);

		// Keep a second reader open so its refresh exercises the append-only tail path.
		const tailer = await new SessionIndex(dir).open();
		// Appending through the replayed reader writes v4 and accepts it.
		const appended = await replayed.append(event("v4-b"));
		expect(appended.version).toBe(SESSION_INDEX_EVENT_VERSION);
		expect((await fs.readFile(logPath, "utf8")).trim().split("\n")).toHaveLength(2);

		// The existing reader tails the grown v4 log without a replay-class crash.
		expect(await tailer.refreshIfChanged()).toBe(true);
		expect(tailer.listSessions().sessions.map(s => s.sessionId)).toEqual(["v4-a", "v4-b"]);

		// Snapshot path: a v4 snapshot replays healthy, and repair is a no-op.
		await tailer.snapshot();
		const snapshot = JSON.parse(await fs.readFile(snapshotPath, "utf8"));
		expect(snapshot.version).toBe(SESSION_INDEX_EVENT_VERSION);
		await fs.rm(logPath);
		const fromSnapshot = new SessionIndex(dir);
		expect(await fromSnapshot.diagnose()).toMatchObject({ status: "healthy", validPrefixSeq: 2 });
		expect(await fromSnapshot.repair()).toMatchObject({ status: "healthy", repaired: false });
		expect(JSON.parse(await fs.readFile(snapshotPath, "utf8"))).toEqual(snapshot);

		// Mixed v1-prefix + v4-suffix log replays both formats; checksums stay valid.
		const legacyV1 = {
			...event("v1-c"),
			version: SDK_STATE_VERSION,
			indexSeq: 3,
			ts: 1,
		};
		await fs.writeFile(
			logPath,
			[
				JSON.stringify({
					...legacyV1,
					checksum: sessionIndexChecksum(legacyV1 as Parameters<typeof sessionIndexChecksum>[0]),
				}),
				JSON.stringify(v4Event("v4-d", 4)),
				JSON.stringify(v4Event("v4-e", 5)),
				"",
			].join("\n"),
		);
		const mixed = await new SessionIndex(dir).open();
		expect(await mixed.diagnose()).toMatchObject({ status: "healthy", validPrefixSeq: 5 });
		expect(mixed.listSessions().sessions.map(s => s.sessionId)).toEqual(
			expect.arrayContaining(["v1-c", "v4-d", "v4-e"]),
		);
		expect(mixed.listSessions().warnings).toEqual([]);
	});
	it("keeps future index versions fail-closed with data-preserving quarantine (#5181)", async () => {
		const dir = await fs.mkdtemp(path.join(process.env.TMPDIR ?? "/tmp", "gjc-index-v4-future-"));
		const sessionsDir = path.join(dir, "sdk", "sessions");
		const logPath = path.join(sessionsDir, "index.jsonl");
		const snapshotPath = path.join(sessionsDir, "index.snapshot.json");
		await fs.mkdir(sessionsDir, { recursive: true });
		const signed = (version: number, sessionId: string, indexSeq: number) => {
			const unsigned = { ...event(sessionId), version, indexSeq, ts: 1 };
			return { ...unsigned, checksum: sessionIndexChecksum(unsigned as Parameters<typeof sessionIndexChecksum>[0]) };
		};

		// A future v5 log row fails closed BEFORE mutation and preserves every byte.
		const futureLog = `${JSON.stringify(signed(SESSION_INDEX_EVENT_VERSION, "ok", 1))}\n${JSON.stringify(
			signed(SESSION_INDEX_EVENT_VERSION + 1, "future", 2),
		)}\n`;
		await fs.writeFile(logPath, futureLog);
		const future = new SessionIndex(dir);
		expect(await future.diagnose()).toMatchObject({
			status: "unsupported",
			validPrefixSeq: 1,
			reason: expect.stringContaining("maximum supported version is 4"),
		});
		expect(await future.repair()).toMatchObject({ status: "unsupported", repaired: false });
		await expect(new SessionIndex(dir).open()).rejects.toThrow(/maximum supported version is 4/);
		expect(await fs.readFile(logPath, "utf8")).toBe(futureLog);
		expect(await fs.exists(snapshotPath)).toBe(false);

		// Repair never manufactures a snapshot from an unsupported log.
		expect(await fs.readdir(sessionsDir)).not.toContain("quarantine");

		// A malformed row mid-log stays quarantined with full byte contents on repair.
		await fs.writeFile(
			logPath,
			`${JSON.stringify(signed(SESSION_INDEX_EVENT_VERSION, "prefix", 1))}\nbroken-not-json\n`,
		);
		const corrupt = await new SessionIndex(dir).open();
		const repair = await corrupt.repair();
		expect(repair).toMatchObject({ status: "corrupt", repaired: true });
		expect(repair.quarantinePath).toEqual(expect.any(String));
		const quarantinedLog = await fs.readFile(path.join(repair.quarantinePath!, "index.jsonl"), "utf8");
		expect(quarantinedLog).toContain("broken-not-json");
		expect(quarantinedLog).toContain('"sessionId":"prefix"');
		// The valid prefix is republished; the corrupt suffix is dropped from it.
		const repairedSnapshot = JSON.parse(await fs.readFile(snapshotPath, "utf8"));
		expect(repairedSnapshot.version).toBe(SESSION_INDEX_EVENT_VERSION);
		expect(repairedSnapshot.indexSeq).toBe(1);
	});
	it("fences the generic state-version guard away from session-index rows (#5181)", async () => {
		// The exact reported crash class: assertSupportedStateVersion rejects v4
		// with "maximum supported version is 1", while the dedicated index event
		// guard accepts v4. The guards must stay distinguishable so no scan path
		// can apply the generic fence to index rows again.
		const v4 = { version: SESSION_INDEX_EVENT_VERSION };
		expect(() => assertSupportedStateVersion("index.jsonl", v4)).toThrow(
			new UnsupportedStateVersionError("index.jsonl", SESSION_INDEX_EVENT_VERSION),
		);
		expect(() => assertSupportedSessionIndexEventVersion("index.jsonl", v4)).not.toThrow();
		expect(() => assertSupportedSessionIndexEventVersion("index.jsonl", { version: 1 })).not.toThrow();
		expect(() => assertSupportedSessionIndexEventVersion("index.jsonl", { version: 5 })).toThrow(
			new UnsupportedStateVersionError("index.jsonl", 5, SESSION_INDEX_EVENT_VERSION),
		);
		expect(() =>
			assertSupportedSnapshotVersion("index.snapshot.json", { version: SESSION_INDEX_SNAPSHOT_VERSION }),
		).not.toThrow();
		expect(() => assertSupportedSnapshotVersion("index.snapshot.json", { version: 1 })).not.toThrow();
		expect(() => assertSupportedSnapshotVersion("index.snapshot.json", { version: 5 })).toThrow(
			new UnsupportedStateVersionError("index.snapshot.json", 5, SESSION_INDEX_SNAPSHOT_VERSION),
		);
	});
	it("canonicalizes cwd and reports null worktree root outside Git", async () => {
		const real = await fs.mkdtemp(path.join(process.env.TMPDIR ?? "/tmp", "gjc-index-canonical-"));
		const link = `${real}-link`;
		await fs.symlink(real, link);
		expect(await canonicalSessionCwd(link)).toBe(real);
		expect(await sessionWorktreeRoot(real)).toBeNull();
	});
});
