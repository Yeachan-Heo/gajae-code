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
