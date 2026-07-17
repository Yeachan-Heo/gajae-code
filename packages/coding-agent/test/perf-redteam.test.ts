import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { AsyncJobManager } from "../src/async/job-manager";
import { SessionIndex } from "../src/sdk/broker/session-index";
import { RevisionStore } from "../src/sdk/host/query/revision-store";
import { SessionManager } from "../src/session/session-manager";

const event = (sessionId: string) => ({
	type: "host_registered" as const,
	sessionId,
	locator: { repo: "r", stateRoot: "q" },
	endpointGeneration: 1,
	pid: process.pid,
});

async function tempDir(prefix: string): Promise<string> {
	return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

describe("perf change-set adversarial probes", () => {
	it("keeps a valid snapshot across a crash-window log truncation and concurrent stale reader", async () => {
		const dir = await tempDir("gjc-perf-index-");
		try {
			const writer = await new SessionIndex(dir).open();
			const reader = await new SessionIndex(dir).open();
			await writer.append(event("before"));
			await reader.refresh();
			await writer.snapshot();
			// Simulates a process crash after durable snapshot rename but before rotation.
			await fs.writeFile(path.join(dir, "sdk", "sessions", "index.jsonl"), "");
			await writer.append(event("after"));
			await reader.refresh();
			expect(reader.listSessions().sessions.map(item => item.sessionId)).toEqual(["before", "after"]);
		} finally {
			await fs.rm(dir, { recursive: true, force: true });
		}
	});

	it("rejects an append after a corrupt suffix so durable events remain replayable", async () => {
		const dir = await tempDir("gjc-perf-corrupt-");
		try {
			const index = await new SessionIndex(dir).open();
			await index.append(event("prefix"));
			const log = path.join(dir, "sdk", "sessions", "index.jsonl");
			await fs.appendFile(log, "{broken}");
			const suffix = await new SessionIndex(dir).open();
			const beforeAppend = await fs.readFile(log, "utf8");
			await expect(suffix.append(event("would-be-hidden"))).rejects.toThrow(
				"Cannot append to corrupt session index log",
			);
			expect(await fs.readFile(log, "utf8")).toBe(beforeAppend);
			const replay = await new SessionIndex(dir).open();
			expect(replay.listSessions().sessions.map(item => item.sessionId)).toEqual(["prefix"]);
			expect(replay.listSessions().warnings).toContain("Corrupt session index entry; replay truncated");
		} finally {
			await fs.rm(dir, { recursive: true, force: true });
		}
	});

	it("does not leak tree mutations into canonical entries", () => {
		const manager = SessionManager.inMemory();
		manager.appendMessage({ role: "user", content: "canonical", timestamp: 0 });
		const tree = manager.getTree();
		const message = tree[0]?.entry;
		if (message?.type !== "message" || message.message.role !== "user") throw new Error("missing tree message");
		message.message.content = "poisoned";
		const reread = manager.getTree()[0]?.entry;
		expect(reread).toMatchObject({ type: "message", message: { role: "user", content: "canonical" } });
	});

	it("preserves UTF-8 and lone-surrogate byte ranges through a spilled >4MiB revision", async () => {
		const dir = await tempDir("gjc-perf-revision-");
		try {
			const text = `${"漢🙂".repeat(350_000)}\ud800${"中🚀".repeat(350_000)}\udc00tail`;
			const store = new RevisionStore("s", Date.now, { storageDir: dir });
			const revision = await store.createRevision("resource", "id", { body: text });
			const chunks: string[] = [];
			for (let offset = 0; ; ) {
				const slice = await store.readStringRange("resource", "id", revision, "body", offset, 65_537);
				if (!slice) throw new Error(`missing slice at ${offset}`);
				chunks.push(slice.body);
				if (slice.complete) break;
				offset = slice.offset + Buffer.byteLength(slice.body);
			}
			expect(chunks.join("")).toBe(text);
			await store.close();
		} finally {
			await fs.rm(dir, { recursive: true, force: true });
		}
	}, 30_000);

	it("streams exact JSON escaping for large primitive, array, and object strings", async () => {
		const text = `quote " slash \\ control \u0000 emoji 🙂 lone \ud800 ${"x".repeat(5 * 1024 * 1024)}`;
		const values = [text, [text], { body: text }];
		const store = new RevisionStore("s");
		for (const [index, value] of values.entries()) {
			const revision = await store.createRevision("resource", String(index), value);
			let offset = 0;
			let serialised = "";
			for (;;) {
				const page = await store.readRootRange("resource", String(index), revision, offset, 256 * 1024);
				if (!page) throw new Error("missing serialized snapshot page");
				serialised += page.body;
				if (page.complete) break;
				offset = page.offset + Buffer.byteLength(page.body);
			}
			expect(serialised).toBe(JSON.stringify(value));
			expect(await store.readRevision("resource", String(index), revision)).toEqual(value);
		}
		expect(store.peakBufferedBytes).toBeLessThanOrEqual(4 * 1024 * 1024);
		await store.close();
	}, 30_000);

	it("serializes undefined array values and rejects a one-MiB page item without over-reading", async () => {
		const reads: Array<[number, number]> = [];
		const store = new RevisionStore("s", Date.now, { onReadRange: (start, end) => reads.push([start, end]) });
		const revision = await store.createRevision("resource", "items", [undefined, "x".repeat(1024 * 1024), "tail"]);
		expect(await store.readRevision("resource", "items", revision)).toEqual([null, "x".repeat(1024 * 1024), "tail"]);
		const page = await store.readPage("resource", "items", revision, 1, 1024 * 1024 - 1);
		expect(page).toEqual({ items: [], complete: false });
		expect(reads).toEqual([]);
	});

	it("retention zero cannot retain dead letters and tombstone sweeping is safe without registrations", async () => {
		const manager = new AsyncJobManager({
			retentionMs: 0,
			onJobComplete: () => {
				throw new Error("delivery failure");
			},
		});
		manager.register("task", "terminal", async () => "done", { id: "zero-retention" });
		await manager.waitForAll();
		await manager.drainDeliveries({ timeoutMs: 5_000 });
		expect(manager.getDeliveryState()).toMatchObject({ deadLettered: 0, queued: 0 });
		expect(manager.getMonitorTombstone("unregistered")).toBeUndefined();
		await manager.dispose();
	});
});
