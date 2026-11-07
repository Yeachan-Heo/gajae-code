import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { SessionManager, type SessionMessageEntry } from "../src/session/session-manager";

// Eviction moves payloads out of the transcript into blobs and leaves markers pointing at them.
// Two processes share one blob store, so the question this case answers is the one a user asks
// after another window compacted the session: can this process still read the original content?

const roots: string[] = [];
const managers: SessionManager[] = [];

afterEach(async () => {
	for (const manager of managers.splice(0)) await manager.closeStrict().catch(() => undefined);
	for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
});

describe("blob payloads after another opener evicts", () => {
	it("keeps the original content readable for a process that opens afterwards", async () => {
		const root = await fs.mkdtemp(path.join(import.meta.dirname, ".tmp-blob-gc-"));
		roots.push(root);
		const cwd = path.join(root, "workspace");
		const agentDir = path.join(root, "agent");
		await fs.mkdir(cwd, { recursive: true });
		await fs.mkdir(agentDir, { recursive: true, mode: 0o700 });
		const destination = SessionManager.managedDestination(cwd, agentDir);
		const writer = SessionManager.create(cwd, destination);
		managers.push(writer);
		// Spill needs content blocks above the spill threshold, and eviction only walks entries
		// older than firstKeptEntryId, so the payload goes first and the kept turn last.
		const payload = "needle-payload-".repeat(20_000);
		writer.appendMessage({
			role: "assistant" as const,
			content: [{ type: "text" as const, text: payload }],
			timestamp: 1,
			api: "test",
			provider: "test",
			model: "test",
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop" as const,
		});
		const evictableId = writer.getLeafId();
		if (!evictableId) throw new Error("expected a committed leaf");
		writer.appendMessage({ role: "user" as const, content: "kept turn", timestamp: 2 });
		const keptId = writer.getLeafId();
		if (!keptId) throw new Error("expected a kept leaf");
		await writer.ensureOnDisk();
		const file = writer.getSessionFile();
		if (!file) throw new Error("expected a transcript path");
		const compactionId = writer.appendCompaction("summary", undefined, keptId, 100);
		await writer.flush();

		const evictor = await SessionManager.open(file, destination);
		managers.push(evictor);
		expect(evictor.evictCompactedContent(keptId, compactionId).evictedEntries).toBeGreaterThan(0);
		// Eviction only arms the rewrite; the markers reach disk with the next publish.
		evictor.appendMessage({ role: "user" as const, content: "after eviction", timestamp: 3 });
		await evictor.flush();

		// The transcript no longer carries the payload; it is a marker pointing at a blob.
		const onDisk = await Bun.file(file).text();
		expect(onDisk).not.toContain("needle-payload-needle-payload-needle-payload");

		// A process that opens now must still read the original text, i.e. the blob survived the
		// eviction and is resolvable from a different manager instance.
		const reader = await SessionManager.open(file, destination);
		managers.push(reader);
		const entry = reader.getEntry(evictableId) as SessionMessageEntry | undefined;
		if (entry?.type !== "message") throw new Error("expected the evicted entry");
		// Recorded behaviour: the ordinary read path returns the eviction notice, not the payload.
		// A caller that needs the bytes must use the fidelity path below; this is the split a
		// second window sees, so it is pinned rather than assumed.
		expect(JSON.stringify(entry.message)).not.toContain("needle-payload-");
		expect(JSON.stringify(entry.message)).toContain("evicted to durable cold storage");
		expect(JSON.stringify(reader.getEntries())).not.toContain("needle-payload-");

		// The blob itself survived the eviction: the fidelity read still resolves the original
		// text from the shared blob store, which is what makes the eviction non-destructive.
		const fidelity = reader.getEntryForFidelity(evictableId) as SessionMessageEntry | undefined;
		if (fidelity?.type !== "message") throw new Error("expected the fidelity entry");
		expect(JSON.stringify(fidelity.message)).toContain("needle-payload-");
	});

	// Recorded finding, not an assertion: blob GC itself was not exercised. Whether a GC pass in
	// one process can delete a blob another process is about to rehydrate depends on how GC
	// enumerates references, which needs its own case; this file pins only that an eviction
	// published by one manager stays readable to another.
});
