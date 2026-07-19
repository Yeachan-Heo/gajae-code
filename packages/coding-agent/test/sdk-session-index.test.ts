import { describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import path from "node:path";
import { SessionIndex, type SessionIndexEvent, sessionIndexChecksum } from "../src/sdk/broker/session-index";
import { SDK_STATE_VERSION } from "../src/sdk/broker/state-version";

const event = (sessionId: string) => ({
	type: "host_registered" as const,
	sessionId,
	locator: { repo: "r", stateRoot: "q" },
	endpointGeneration: 1,
	pid: process.pid,
});
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
		await expect(index.append(event("not-accepted"))).rejects.toThrow("--repair-session-index");
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
		await expect(index.append(event("blocked-before-repair"))).rejects.toThrow("--repair-session-index");
		expect(await index.repair()).toMatchObject({ status: "corrupt", repaired: true, validPrefixSeq: 1 });
		await index.append({
			...event("after"),
			locator: { repo: "r".repeat(4 * 1024 * 1024), stateRoot: "q" },
		});
		const snapshot = JSON.parse(await fs.readFile(path.join(sessionsDir, "index.snapshot.json"), "utf8"));
		expect(snapshot.indexSeq).toBe(2);
		const replay = await new SessionIndex(dir).open();
		expect(replay.indexSeq).toBe(2);
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
			locator: { repo: "r".repeat(4 * 1024 * 1024), stateRoot: "q" },
			version: SDK_STATE_VERSION,
			indexSeq: 2,
			ts: Date.now(),
		};
		await fs.appendFile(
			path.join(sessionsDir, "index.jsonl"),
			`${JSON.stringify({ ...oversized, checksum: sessionIndexChecksum(oversized as Parameters<typeof sessionIndexChecksum>[0]) })}\n`,
		);
		await expect(index.append(event("blocked-before-repair"))).rejects.toThrow("--repair-session-index");
		expect(await index.repair()).toMatchObject({ status: "corrupt", repaired: true, validPrefixSeq: 2 });

		await index.append(event("after"));

		expect(JSON.parse(await fs.readFile(snapshotFile, "utf8")).indexSeq).toBe(3);

		expect((await fs.stat(path.join(sessionsDir, "index.jsonl"))).size).toBe(0);
		const replay = await new SessionIndex(dir).open();
		expect(replay.listSessions().sessions.map(session => session.sessionId)).toEqual([
			"before",
			"oversized",
			"after",
		]);
		expect(replay.indexSeq).toBe(3);
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
					locator: { repo: "r", stateRoot: "q" },
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
	it("refuses to append after an unterminated suffix while retaining the valid prefix", async () => {
		const dir = await fs.mkdtemp(path.join(process.env.TMPDIR ?? "/tmp", "gjc-index-"));
		const index = await new SessionIndex(dir).open();
		await index.append(event("prefix"));
		const log = path.join(dir, "sdk", "sessions", "index.jsonl");
		await fs.appendFile(log, '{"partial":');
		const corrupt = await new SessionIndex(dir).open();
		expect(corrupt.listSessions().sessions.map(session => session.sessionId)).toEqual(["prefix"]);
		expect(corrupt.listSessions().warnings).toContain("Corrupt session index entry; replay truncated");
		await expect(corrupt.append(event("not-durable"))).rejects.toThrow("Cannot append to corrupt session index log");
		const replay = await new SessionIndex(dir).open();
		expect(replay.listSessions().sessions.map(session => session.sessionId)).toEqual(["prefix"]);
	});
	it("rotates repeatedly while concurrent writers and readers preserve every event", async () => {
		const dir = await fs.mkdtemp(path.join(process.env.TMPDIR ?? "/tmp", "gjc-index-"));
		const writers = await Promise.all([new SessionIndex(dir).open(), new SessionIndex(dir).open()]);
		const largeEvent = (sessionId: string) => ({
			...event(sessionId),
			locator: { repo: "r".repeat(300_000), stateRoot: "q" },
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

	it("compaction drops terminal+dead sessions and keeps live sessions with their original indexSeq", async () => {
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
		expect(snapshot.events.map((e: { sessionId: string }) => e.sessionId)).toEqual(["live", "live2"]);
		expect(snapshot.events[0].indexSeq).toBe(1);
		expect(snapshot.indexSeq).toBe(4);
		const replay = await new SessionIndex(dir).open();
		expect(replay.listSessions().sessions.map(s => s.sessionId)).toEqual(["live", "live2"]);
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
		await fs.writeFile(snapshotFile, JSON.stringify({ version: 3, indexSeq: 7, events: [] }));
		const unsupported = new SessionIndex(dir);
		expect(await unsupported.diagnose()).toMatchObject({ status: "unsupported", validPrefixSeq: 0, snapshotSeq: 7 });
		expect(await unsupported.repair()).toMatchObject({ status: "unsupported", repaired: false });
		await expect(new SessionIndex(dir).open()).rejects.toThrow(/Unsupported SDK state version/);
		const futureOne = { ...event("supported-prefix"), version: SDK_STATE_VERSION, indexSeq: 1, ts: 1 };
		const futureTwo = { ...event("future-event"), version: 2, indexSeq: 2, ts: 2 };
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
		await expect(futureSnapshot.open()).rejects.toThrow(/maximum supported version is 1/);
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
});
