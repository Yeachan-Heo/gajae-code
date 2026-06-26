import { describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { exportFromFile } from "@gajae-code/coding-agent/export/html";
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

			const outputPath = path.join(tempDir, "export.html");
			await exportFromFile(sessionFile!, { outputPath });
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
