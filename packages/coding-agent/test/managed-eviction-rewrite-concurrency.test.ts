import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { SessionManager } from "../src/session/session-manager";

// Evicting compacted content arms a whole-file rewrite, so that manager's next publish replaces
// the file rather than appending one record. On a shared transcript that is the destructive
// shape: a stale resident view published over the file would drop whatever another opener
// committed after this one read it.

const roots: string[] = [];
const managers: SessionManager[] = [];

afterEach(async () => {
	for (const manager of managers.splice(0)) await manager.closeStrict().catch(() => undefined);
	for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
});

async function sharedOpens(): Promise<{
	file: string;
	first: SessionManager;
	second: SessionManager;
	destination: ReturnType<typeof SessionManager.managedDestination>;
	keptId: string;
	compactionId: string;
}> {
	const root = await fs.mkdtemp(path.join(import.meta.dirname, ".tmp-eviction-"));
	roots.push(root);
	const cwd = path.join(root, "workspace");
	const agentDir = path.join(root, "agent");
	await fs.mkdir(cwd, { recursive: true });
	await fs.mkdir(agentDir, { recursive: true, mode: 0o700 });
	const destination = SessionManager.managedDestination(cwd, agentDir);
	const writer = SessionManager.create(cwd, destination);
	managers.push(writer);
	// Eviction walks back from the compaction and stops at `firstKeptEntryId`, so the payload
	// that gets evicted is the OLDER one. Spill depends on shape, not size: `#coldSpillClone`
	// passes a string `content` through untouched at any length, so the payload arrives as
	// content blocks above COLD_SPILL_MIN_CHARS (1024).
	const bulkyBlock = "z".repeat(200_000);
	for (const turn of [1, 2]) {
		writer.appendMessage({
			role: "assistant" as const,
			content: [
				{ type: "text" as const, text: bulkyBlock },
				{ type: "text" as const, text: `${bulkyBlock}-${turn}` },
			],
			timestamp: turn,
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
	}
	writer.appendMessage({ role: "user" as const, content: "kept turn", timestamp: 3 });
	const keptId = writer.getLeafId();
	if (!keptId) throw new Error("expected a committed leaf");
	await writer.ensureOnDisk();
	const file = writer.getSessionFile();
	if (!file) throw new Error("expected a transcript path");
	const compactionId = writer.appendCompaction("summary", undefined, keptId, 100);
	await writer.flush();
	const first = await SessionManager.open(file, destination);
	const second = await SessionManager.open(file, destination);
	managers.push(first, second);
	return { file, first, second, destination, keptId, compactionId };
}

describe("eviction that arms a rewrite on a shared transcript", () => {
	it("refuses to publish the stale resident view over a newer commit", async () => {
		const { file, first, second, destination, keptId, compactionId } = await sharedOpens();
		// The second opener evicts, so its next publish is a whole-file replacement built from
		// the entries it read; the first opener then advances the transcript.
		const eviction = second.evictCompactedContent(keptId, compactionId);
		expect(eviction.evictedEntries).toBeGreaterThan(0);
		first.appendMessage({ role: "user" as const, content: "from first", timestamp: 4 });
		await first.flush();
		const advanced = await Bun.file(file).text();
		expect(advanced).toContain("from first");

		// The rewrite must refuse instead of replaying the stale view over "from first". The
		// refusal surfaces through the append wrapper, so name the underlying cause rather than
		// accepting any failure.
		let refusal: unknown;
		try {
			second.appendMessage({ role: "user" as const, content: "from second", timestamp: 5 });
		} catch (error) {
			refusal = error;
		}
		expect(refusal).toBeInstanceOf(Error);
		expect((refusal as Error).message).toContain("managed_replace_identity_mismatch");
		const after = await Bun.file(file).text();
		expect(after).toBe(advanced);
		expect(after).not.toContain("from second");

		const reopened = await SessionManager.open(file, destination);
		managers.push(reopened);
		expect(JSON.stringify(reopened.getEntries())).toContain("from first");
	});
});
