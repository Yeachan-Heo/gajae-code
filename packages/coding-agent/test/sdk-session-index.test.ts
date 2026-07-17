import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import path from "node:path";
import { SessionIndex } from "../src/sdk/broker/session-index";

const event = (sessionId: string) => ({
	type: "host_registered" as const,
	sessionId,
	locator: { repo: "r", stateRoot: "q" },
	endpointGeneration: 1,
	pid: process.pid,
});
describe("SDK session index", () => {
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
	it("retains the valid prefix and warns on corrupt post-snapshot data", async () => {
		const dir = await fs.mkdtemp(path.join(process.env.TMPDIR ?? "/tmp", "gjc-index-"));
		const index = await new SessionIndex(dir).open();
		await index.append(event("s"));
		await fs.appendFile(path.join(dir, "sdk", "sessions", "index.jsonl"), "broken\n");
		const replay = await new SessionIndex(dir).open();
		expect(replay.listSessions().indexSeq).toBe(1);
		expect(replay.listSessions().warnings).not.toHaveLength(0);
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
	it("compacts an oversized log by pruning superseded heartbeats and truncating", async () => {
		const dir = await fs.mkdtemp(path.join(process.env.TMPDIR ?? "/tmp", "gjc-index-"));
		const log = path.join(dir, "sdk", "sessions", "index.jsonl");
		const index = await new SessionIndex(dir, { compactLogBytes: 1 }).open();
		await index.append(event("s"));
		for (let i = 0; i < 5; i++) await index.append({ ...event("s"), type: "host_heartbeat" as const });
		expect((await fs.stat(log)).size).toBe(0);
		const replay = await new SessionIndex(dir).open();
		expect(replay.indexSeq).toBe(6);
		const sessions = replay.listSessions().sessions;
		expect(sessions).toHaveLength(1);
		expect(sessions[0]?.sessionId).toBe("s");
		expect(sessions[0]?.locator).toEqual({ repo: "r", stateRoot: "q" });
		// Only the registration and the newest heartbeat survive compaction.
		const snapshot = JSON.parse(await fs.readFile(path.join(dir, "sdk", "sessions", "index.snapshot.json"), "utf8"));
		expect(snapshot.events.map((e: { indexSeq: number }) => e.indexSeq)).toEqual([1, 6]);
	});
	it("keeps concurrent writers consistent across a compaction by another writer", async () => {
		const dir = await fs.mkdtemp(path.join(process.env.TMPDIR ?? "/tmp", "gjc-index-"));
		const compacting = await new SessionIndex(dir, { compactLogBytes: 1 }).open();
		const other = await new SessionIndex(dir).open();
		await other.append(event("a"));
		await compacting.append({ ...event("a"), type: "host_heartbeat" as const });
		// `other`'s consumed offset now exceeds the truncated log; it must rebuild
		// from the snapshot instead of reporting a dead index.
		await other.append(event("b"));
		expect(other.indexSeq).toBe(3);
		const replay = await new SessionIndex(dir).open();
		expect(replay.indexSeq).toBe(3);
		expect(
			replay
				.listSessions()
				.sessions.map(session => session.sessionId)
				.sort(),
		).toEqual(["a", "b"]);
		expect(replay.listSessions().warnings).toHaveLength(0);
	});
});
