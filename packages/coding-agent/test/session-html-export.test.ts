import { describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { exportFromFile, exportSessionToHtml } from "@gajae-code/coding-agent/export/html";
import {
	type ColdSpillRef,
	SessionManager,
	type SessionMessageEntry,
} from "@gajae-code/coding-agent/session/session-manager";
import { getBlobsDir, Snowflake } from "@gajae-code/utils";

function largeMarker(label: string): string {
	return `${label}-${"x".repeat(520_000)}-end`;
}

function decodeExportSessionData(html: string): { entries: SessionMessageEntry[] } {
	const match = html.match(/<script id="session-data" type="application\/json">([^<]+)<\/script>/);
	expect(match).toBeTruthy();
	return JSON.parse(Buffer.from(match![1], "base64").toString("utf8"));
}

function exportedMessageText(entry: SessionMessageEntry | undefined): string {
	const message = entry?.message;
	if (!message || !("content" in message)) return "";
	const content = message.content;
	if (typeof content === "string") return content;
	return content
		.filter((block): block is { type: "text"; text: string } => block.type === "text")
		.map(block => block.text)
		.join("");
}

async function buildEvictedSession(
	sessionDir: string,
	marker: string,
): Promise<{ session: SessionManager; oldUserId: string }> {
	const session = SessionManager.create(sessionDir, sessionDir);
	const oldUserId = session.appendMessage({
		role: "user",
		content: [{ type: "text", text: marker }],
		timestamp: Date.now(),
	});
	const firstKeptEntryId = session.appendMessage({ role: "user", content: "kept", timestamp: Date.now() });
	const compactionEntryId = session.appendCompaction("summary", "short", firstKeptEntryId, 123);
	session.evictCompactedContent(firstKeptEntryId, compactionEntryId);
	await session.ensureOnDisk();
	await session.flush();
	return { session, oldUserId };
}

function coldSpillRefs(entry: SessionMessageEntry): ColdSpillRef[] {
	return Object.values(entry.evictedContent?.payloads ?? {});
}

describe("session HTML export fidelity", () => {
	it("exports rehydrated pre-compaction content instead of tombstone notices", async () => {
		const tempDir = path.join(os.tmpdir(), `gjc-html-export-fidelity-${Snowflake.next()}`);
		fs.mkdirSync(tempDir, { recursive: true });
		try {
			const marker = largeMarker("html-export-original");
			const { session, oldUserId } = await buildEvictedSession(tempDir, marker);
			const sessionFile = session.getSessionFile();
			expect(sessionFile).toBeString();
			await session.close();
			const artifactRoot = sessionFile!.slice(0, -6);
			const staleSidecars = ["idx", "tail", "commit"].map(kind =>
				path.join(artifactRoot, `.session-memory.spill.${kind}`),
			);
			fs.mkdirSync(artifactRoot, { recursive: true });
			for (const sidecar of staleSidecars) fs.writeFileSync(sidecar, "stale derived export state");

			const outputPath = path.join(tempDir, "export.html");
			await exportFromFile(sessionFile!, { outputPath });
			expect(staleSidecars.map(sidecar => fs.readFileSync(sidecar, "utf8"))).toEqual(
				staleSidecars.map(() => "stale derived export state"),
			);
			const data = decodeExportSessionData(fs.readFileSync(outputPath, "utf8"));
			const exported = data.entries.find(entry => entry.id === oldUserId);
			expect(exported?.type).toBe("message");
			expect(exportedMessageText(exported)).toBe(marker);
			expect(JSON.stringify(exported)).not.toContain("compacted history evicted");
			expect(JSON.stringify(exported)).not.toContain("Cold-spill blob unavailable");
		} finally {
			fs.rmSync(tempDir, { recursive: true, force: true });
		}
	});

	it("rejects source-path output without modifying the transcript", async () => {
		const tempDir = path.join(os.tmpdir(), `gjc-html-export-alias-${Snowflake.next()}`);
		fs.mkdirSync(tempDir, { recursive: true });
		try {
			const session = SessionManager.create(tempDir, path.join(tempDir, "sessions"));
			session.appendMessage({ role: "user", content: "authoritative", timestamp: 1 });
			await session.ensureOnDisk();
			await session.flush();
			const sessionFile = session.getSessionFile();
			if (!sessionFile) throw new Error("Expected persisted session");
			const before = fs.readFileSync(sessionFile);
			await expect(exportSessionToHtml(session, undefined, { outputPath: sessionFile })).rejects.toThrow(
				"must not overwrite the source transcript",
			);
			expect(fs.readFileSync(sessionFile)).toEqual(before);
			await session.close();
		} finally {
			fs.rmSync(tempDir, { recursive: true, force: true });
		}
	});
	it("streams an enabled cold session without hydrating retired history", async () => {
		const tempDir = path.join(os.tmpdir(), `gjc-html-export-cold-${Snowflake.next()}`);
		fs.mkdirSync(tempDir, { recursive: true });
		try {
			const session = SessionManager.create(tempDir, path.join(tempDir, "sessions"));
			for (let index = 0; index < 2_000; index++) {
				session.appendMessage({ role: "user", content: `cold-${index}-${"x".repeat(512)}`, timestamp: index });
			}
			const firstKeptEntryId = session.appendMessage({ role: "user", content: "kept", timestamp: 2_001 });
			session.appendCompaction("summary", "short", firstKeptEntryId, 2_000);
			await session.ensureOnDisk();
			await session.flush();
			session.setSessionMemoryMode("enabled");
			expect(session.getSessionMemoryStats().coldRetirementActive).toBe(true);

			const outputPath = path.join(tempDir, "cold-export.html");
			await exportSessionToHtml(session, undefined, { outputPath });
			const data = decodeExportSessionData(fs.readFileSync(outputPath, "utf8"));
			expect(data.entries).toHaveLength(2_002);
			expect(data.entries[0]?.type).toBe("message");
			expect(session.getSessionMemoryStats().coldRetirementActive).toBe(true);
			await session.close();
		} finally {
			fs.rmSync(tempDir, { recursive: true, force: true });
		}
	});
	it("renders an explicit unavailable notice when a cold-spill blob is missing", async () => {
		const tempDir = path.join(os.tmpdir(), `gjc-html-export-missing-blob-${Snowflake.next()}`);
		fs.mkdirSync(tempDir, { recursive: true });
		try {
			const marker = largeMarker("html-export-missing");
			const { session, oldUserId } = await buildEvictedSession(tempDir, marker);
			const evicted = session.getCanonicalEntryForTests(oldUserId) as SessionMessageEntry;
			const refs = coldSpillRefs(evicted);
			expect(refs.length).toBeGreaterThan(0);
			for (const ref of refs) {
				fs.rmSync(path.join(getBlobsDir(), ref.sha256), { force: true });
			}
			const sessionFile = session.getSessionFile();
			expect(sessionFile).toBeString();
			await session.close();

			const outputPath = path.join(tempDir, "export-missing.html");
			await exportFromFile(sessionFile!, { outputPath });
			const data = decodeExportSessionData(fs.readFileSync(outputPath, "utf8"));
			const exported = data.entries.find(entry => entry.id === oldUserId);
			expect(exported?.type).toBe("message");
			expect(exportedMessageText(exported)).toContain("[Cold-spill blob unavailable:");
			expect(exportedMessageText(exported)).toContain("original 520");
		} finally {
			fs.rmSync(tempDir, { recursive: true, force: true });
		}
	});
});
