import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { SessionManager, type SessionMessageEntry } from "@gajae-code/coding-agent/session/session-manager";
import { getBlobsDir } from "@gajae-code/utils";

const tempDirs: string[] = [];

afterEach(async () => {
	for (const dir of tempDirs.splice(0)) await fs.promises.rm(dir, { recursive: true, force: true });
});

function makeTempDir(): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gjc-blob-resume-"));
	tempDirs.push(dir);
	return dir;
}

function imageBase64(label: string, size = 4096): string {
	return Buffer.from(`${label}:`.repeat(size)).toString("base64");
}

async function createPersistedImageSession(imageCount = 6): Promise<{
	sessionFile: string;
	images: string[];
}> {
	const root = makeTempDir();
	const sm = SessionManager.create(root, path.join(root, "sessions"));
	const images = Array.from({ length: imageCount }, (_, index) => imageBase64(`image-${index}`));
	for (const [index, data] of images.entries()) {
		sm.appendMessage({
			role: "user",
			content: [{ type: "image", data, mimeType: "image/png" }],
			timestamp: Date.now() + index,
		});
	}
	await sm.ensureOnDisk();
	await sm.flush();
	const sessionFile = sm.getSessionFile();
	if (!sessionFile) throw new Error("Expected persisted session file");
	await sm.close();
	const persisted = await Bun.file(sessionFile).text();
	for (const data of images) expect(persisted).not.toContain(data);
	expect(persisted).toContain("blob:sha256:");
	return { sessionFile, images };
}

function userImageEntries(sm: SessionManager): SessionMessageEntry[] {
	return sm
		.getEntries()
		.filter((entry): entry is SessionMessageEntry => entry.type === "message" && entry.message.role === "user");
}

describe("SessionManager image blob resume", () => {
	it("keeps resumed image-heavy canonical entries resident instead of loading base64 strings", async () => {
		const { sessionFile, images } = await createPersistedImageSession(8);
		const reopened = await SessionManager.open(sessionFile);
		try {
			const entries = userImageEntries(reopened);
			expect(entries).toHaveLength(images.length);
			for (const entry of entries) {
				const canonical = reopened.getCanonicalEntryForTests(entry.id);
				const serializedCanonical = JSON.stringify(canonical);
				expect(serializedCanonical).toContain("__gjcResidentBlob");
				expect(serializedCanonical).toContain("imageData");
				for (const data of images) expect(serializedCanonical).not.toContain(data);
			}
		} finally {
			await reopened.close();
		}
	});

	it("materializes resumed resident images for provider-visible context without leaking blob refs", async () => {
		const { sessionFile, images } = await createPersistedImageSession(3);
		const reopened = await SessionManager.open(sessionFile);
		try {
			const context = reopened.buildSessionContext();
			const serialized = JSON.stringify(context.messages);
			for (const data of images) expect(serialized).toContain(data);
			expect(serialized).not.toContain("blob:sha256:");
			expect(serialized).not.toContain("__gjcResidentBlob");
		} finally {
			await reopened.close();
		}
	});

	it("uses the resident missing-blob placeholder for resumed images and never leaks blob refs", async () => {
		const { sessionFile } = await createPersistedImageSession(1);
		const blobsDir = getBlobsDir();
		await fs.promises.rm(blobsDir, { recursive: true, force: true });
		const reopened = await SessionManager.open(sessionFile);
		try {
			const entriesSerialized = JSON.stringify(reopened.getEntries());
			expect(entriesSerialized).toContain("Session resident imageData blob missing");
			expect(entriesSerialized).toContain("original content unavailable");
			expect(entriesSerialized).not.toContain("blob:sha256:");
			expect(entriesSerialized).not.toContain("__gjcResidentBlob");

			const contextSerialized = JSON.stringify(reopened.buildSessionContext().messages);
			expect(contextSerialized).toContain("Session resident imageData blob missing");
			expect(contextSerialized).not.toContain("blob:sha256:");
			expect(contextSerialized).not.toContain("__gjcResidentBlob");
		} finally {
			await reopened.close();
		}
	});
});
