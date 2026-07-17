import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { SessionManager } from "@gajae-code/coding-agent/session/session-manager";

const tempDirs: string[] = [];

afterEach(async () => {
	for (const dir of tempDirs.splice(0)) await fs.promises.rm(dir, { recursive: true, force: true });
});

function makeTempDir(): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gjc-resident-image-cache-"));
	tempDirs.push(dir);
	return dir;
}

function largeImageBase64(): string {
	return Buffer.from("resident-cache-image".repeat(4096)).toString("base64");
}

async function reopenImageSession(): Promise<{ sm: SessionManager; image: string }> {
	const root = makeTempDir();
	const sm = SessionManager.create(root, path.join(root, "sessions"));
	const image = largeImageBase64();
	sm.appendMessage({
		role: "user",
		content: [{ type: "image", data: image, mimeType: "image/png" }],
		timestamp: Date.now(),
	});
	await sm.ensureOnDisk();
	await sm.flush();
	const sessionFile = sm.getSessionFile();
	if (!sessionFile) throw new Error("Expected session file");
	await sm.close();
	return { sm: await SessionManager.open(sessionFile), image };
}

describe("SessionManager resident image materialized-entry cache", () => {
	it("bypasses the fully materialized getEntries cache when resident image sentinels are present", async () => {
		const { sm, image } = await reopenImageSession();
		try {
			const before = sm.getObservabilityStatsForTests();
			const first = JSON.stringify(sm.getEntries());
			const afterFirst = sm.getObservabilityStatsForTests();
			const second = JSON.stringify(sm.getEntries());
			const afterSecond = sm.getObservabilityStatsForTests();

			expect(first).toContain(image);
			expect(second).toContain(image);
			expect(first).not.toContain("blob:sha256:");
			expect(first).not.toContain("__gjcResidentBlob");
			expect(afterFirst.materializedEntriesCachePopulateCount).toBe(
				before.materializedEntriesCachePopulateCount + 1,
			);
			expect(afterSecond.materializedEntriesCachePopulateCount).toBe(
				afterFirst.materializedEntriesCachePopulateCount + 1,
			);
		} finally {
			await sm.close();
		}
	});
});

describe("SessionManager public read snapshots", () => {
	it("does not let production-mode public reads poison canonical session state", () => {
		const previousNodeEnv = process.env.NODE_ENV;
		process.env.NODE_ENV = "production";
		try {
			const session = SessionManager.inMemory();
			session.appendMessage({ role: "user", content: "original", timestamp: 1 });

			const entry = session.getEntries()[0];
			const contextMessage = session.buildSessionContext().messages[0];
			const treeEntry = session.getTree()[0]?.entry;
			if (entry?.type !== "message" || contextMessage?.role !== "user" || treeEntry?.type !== "message") {
				throw new Error("Expected public session message snapshots");
			}
			(entry.message as { content: unknown }).content = "entries poison";
			(contextMessage as { content: unknown }).content = "context poison";
			(treeEntry.message as { content: unknown }).content = "tree poison";

			expect(session.getEntries()[0]).toMatchObject({ message: { content: "original" } });
			expect(session.buildSessionContext().messages[0]).toMatchObject({ content: "original" });
			expect(session.getTree()[0]?.entry).toMatchObject({ message: { content: "original" } });
		} finally {
			process.env.NODE_ENV = previousNodeEnv;
		}
	});

	it("clones nested custom payloads for production collection and direct entry getters", () => {
		const previousNodeEnv = process.env.NODE_ENV;
		process.env.NODE_ENV = "production";
		try {
			const session = SessionManager.inMemory();
			session.appendMessage({ role: "user", content: "root", timestamp: 1 });
			const customId = session.appendCustomEntry("extension", { nested: { value: "original" } });
			const customMessageId = session.appendCustomMessageEntry("extension", "custom message", true, {
				nested: { value: "original" },
			});

			const customFromEntries = session.getEntries().find(entry => entry.id === customId);
			if (customFromEntries?.type !== "custom") throw new Error("Expected custom entry snapshot");
			(customFromEntries.data as { nested: { value: string } }).nested.value = "entries poison";

			const tree = session.getTree();
			const customMessageFromTree = tree[0]?.children[0]?.children[0]?.entry;
			if (customMessageFromTree?.type !== "custom_message") throw new Error("Expected custom message tree snapshot");
			(customMessageFromTree.details as { nested: { value: string } }).nested.value = "tree poison";

			const customFromEntry = session.getEntry(customId);
			if (customFromEntry?.type !== "custom") throw new Error("Expected direct custom entry snapshot");
			(customFromEntry.data as { nested: { value: string } }).nested.value = "entry poison";

			const customMessageFromLeaf = session.getLeafEntry();
			if (customMessageFromLeaf?.type !== "custom_message") throw new Error("Expected leaf custom message snapshot");
			(customMessageFromLeaf.details as { nested: { value: string } }).nested.value = "leaf poison";

			const customMessageFromChildren = session.getChildren(customId)[0];
			if (customMessageFromChildren?.type !== "custom_message")
				throw new Error("Expected child custom message snapshot");
			(customMessageFromChildren.details as { nested: { value: string } }).nested.value = "children poison";

			const customMessageFromBranch = session.getBranch().find(entry => entry.id === customMessageId);
			if (customMessageFromBranch?.type !== "custom_message")
				throw new Error("Expected branch custom message snapshot");
			(customMessageFromBranch.details as { nested: { value: string } }).nested.value = "branch poison";

			const compactionSession = SessionManager.inMemory();
			const firstKeptEntryId = compactionSession.appendMessage({ role: "user", content: "root", timestamp: 1 });
			const compactionId = compactionSession.appendCompaction(
				"summary",
				undefined,
				firstKeptEntryId,
				1,
				{ nested: { value: "original" } },
				false,
				{ nested: { value: "original" } },
			);
			const compaction = compactionSession.getEntries().find(entry => entry.id === compactionId);
			if (compaction?.type !== "compaction") throw new Error("Expected compaction snapshot");
			(compaction.details as { nested: { value: string } }).nested.value = "details poison";
			(compaction.preserveData as { nested: { value: string } }).nested.value = "preserve data poison";

			expect(compactionSession.getEntry(compactionId)).toMatchObject({
				details: { nested: { value: "original" } },
				preserveData: { nested: { value: "original" } },
			});

			expect(session.getEntry(customId)).toMatchObject({ data: { nested: { value: "original" } } });
			expect(session.getLeafEntry()).toMatchObject({ details: { nested: { value: "original" } } });
		} finally {
			process.env.NODE_ENV = previousNodeEnv;
		}
	});
});
