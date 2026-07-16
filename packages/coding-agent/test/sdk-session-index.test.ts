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
	it("rotates a large log into a snapshot without disrupting concurrent opens", async () => {
		const dir = await fs.mkdtemp(path.join(process.env.TMPDIR ?? "/tmp", "gjc-index-"));
		const writer = await new SessionIndex(dir).open();
		const largeEvent = (sessionId: string) => ({
			...event(sessionId),
			locator: { repo: "r".repeat(300_000), stateRoot: "q" },
		});
		await Promise.all(Array.from({ length: 16 }, (_, index) => writer.append(largeEvent(`s-${index}`))));
		const readers = await Promise.all(Array.from({ length: 4 }, () => new SessionIndex(dir).open()));
		expect(readers.map(reader => reader.indexSeq)).toEqual([16, 16, 16, 16]);
		expect(readers[0]!.listSessions().sessions).toHaveLength(16);
		expect((await fs.stat(path.join(dir, "sdk", "sessions", "index.jsonl"))).size).toBeLessThan(4 * 1024 * 1024);
		expect(JSON.parse(await fs.readFile(path.join(dir, "sdk", "sessions", "index.snapshot.json"), "utf8"))).toMatchObject({
			indexSeq: expect.any(Number),
		});
	});
});
