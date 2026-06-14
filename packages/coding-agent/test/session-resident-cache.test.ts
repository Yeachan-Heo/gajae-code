import { afterEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { AssistantMessage, UserMessage } from "@gajae-code/ai";
import { exportFromFile, exportSessionToHtml } from "@gajae-code/coding-agent/export/html";
import {
	BlobStore,
	EphemeralBlobStore,
	externalizeImageDataSync,
	ResidentBlobMissingError,
} from "@gajae-code/coding-agent/session/blob-store";
import { SessionManager, type SessionMessageEntry } from "@gajae-code/coding-agent/session/session-manager";
import { logger } from "@gajae-code/utils";

const tempDirs: string[] = [];
afterEach(async () => {
	vi.restoreAllMocks();
	for (const dir of tempDirs.splice(0)) await fs.promises.rm(dir, { recursive: true, force: true });
});

function makeTempDir(): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gjc-resident-cache-"));
	tempDirs.push(dir);
	return dir;
}

function assistantMessage(text: string): AssistantMessage {
	return {
		role: "assistant" as const,
		content: [{ type: "text" as const, text }],
		api: "anthropic-messages" as const,
		provider: "anthropic" as const,
		model: "test-model",
		stopReason: "stop",
		usage: {
			input: 1,
			output: 1,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 2,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		timestamp: Date.now(),
	};
}

function firstMessageEntry(sm: SessionManager): SessionMessageEntry {
	const entry = sm.getEntries().find((e): e is SessionMessageEntry => e.type === "message");
	if (!entry) throw new Error("Expected message entry");
	return entry;
}

function residentCacheRoot(sm: SessionManager): string {
	const artifactsDir = sm.getArtifactsDir();
	if (!artifactsDir) throw new Error("Expected artifacts dir");
	return path.join(artifactsDir, "resident-cache");
}

function residentCacheDirs(sm: SessionManager): string[] {
	const root = residentCacheRoot(sm);
	return fs.existsSync(root) ? fs.readdirSync(root).map(name => path.join(root, name)) : [];
}

function activeResidentCacheDir(sm: SessionManager): string {
	const dirs = residentCacheDirs(sm).filter(dir => path.basename(dir).startsWith(sm.getSessionId()));
	if (dirs.length !== 1) throw new Error(`Expected one active resident cache dir, got ${dirs.length}`);
	return dirs[0]!;
}

async function createPersistedLargeTextSession(
	text: string,
): Promise<{ sm: SessionManager; sessionFile: string; artifactsDir: string; cacheDir: string; entryId: string }> {
	const root = makeTempDir();
	const sm = SessionManager.create(root, path.join(root, "sessions"));
	const entryId = sm.appendMessage(assistantMessage(text));
	await sm.ensureOnDisk();
	await sm.flush();
	const sessionFile = sm.getSessionFile();
	const artifactsDir = sm.getArtifactsDir();
	if (!sessionFile || !artifactsDir) throw new Error("Expected persisted session paths");
	const cacheDir = activeResidentCacheDir(sm);
	expect(fs.existsSync(cacheDir)).toBe(true);

	return { sm, sessionFile, artifactsDir, cacheDir, entryId };
}

function expectMissingBlob(fn: () => unknown): void {
	try {
		fn();
		throw new Error("Expected ResidentBlobMissingError");
	} catch (err) {
		expectResidentBlobMissing(err);
	}
}

async function expectMissingBlobAsync(fn: () => Promise<unknown>): Promise<void> {
	try {
		await fn();
		throw new Error("Expected ResidentBlobMissingError");
	} catch (err) {
		expectResidentBlobMissing(err);
	}
}

function expectResidentBlobMissing(err: unknown): void {
	expect(err).toBeInstanceOf(ResidentBlobMissingError);
	const missing = err as ResidentBlobMissingError;
	expect(missing.hash).toMatch(/^[a-f0-9]{64}$/);
	expect(missing.kind).toBe("text");
	expect(missing.message).not.toContain("blob:sha256:");
}

async function fileDoesNotContainBlobRef(filePath: string): Promise<void> {
	const bytes = await Bun.file(filePath).text();
	expect(bytes).not.toContain("blob:sha256:");
	expect(bytes).not.toContain("__gjcResidentBlob");
}

describe("resident text cache missing-blob and reference hygiene", () => {
	it("throws typed ResidentBlobMissingError from public materialization APIs when the resident text blob is missing", async () => {
		const sentinel = `missing resident text ${"x".repeat(2048)}`;
		const { sm, sessionFile, cacheDir, entryId } = await createPersistedLargeTextSession(sentinel);
		await sm.close();
		expect(fs.existsSync(cacheDir)).toBe(false);

		const reopened = await SessionManager.open(sessionFile);
		const reopenedCacheDir = activeResidentCacheDir(reopened);
		await fs.promises.rm(reopenedCacheDir, { recursive: true, force: true });

		vi.spyOn(EphemeralBlobStore.prototype, "getSync").mockImplementation(function (
			this: EphemeralBlobStore,
			hash: string,
		) {
			return BlobStore.prototype.getSync.call(this, hash);
		});

		expectMissingBlob(() => reopened.getEntries());
		expectMissingBlob(() => reopened.getEntry(entryId));
		expectMissingBlob(() => reopened.getBranch());
		expectMissingBlob(() => reopened.buildSessionContext());
		await reopened.close();
	});

	it("does not leak resident blob refs through healthy public reads, exports, or rewritten JSONL", async () => {
		const sentinel = `healthy resident text ${"y".repeat(2048)}`;
		const { sm, sessionFile } = await createPersistedLargeTextSession(sentinel);
		expect(JSON.stringify(sm.buildSessionContext().messages)).not.toContain("blob:sha256:");
		expect(JSON.stringify(sm.getEntries())).not.toContain("blob:sha256:");
		expect(JSON.stringify(sm.getEntry(firstMessageEntry(sm).id))).not.toContain("blob:sha256:");
		expect(JSON.stringify(sm.getBranch())).not.toContain("blob:sha256:");

		const liveHtml = path.join(makeTempDir(), "live.html");
		await exportSessionToHtml(sm, undefined, { outputPath: liveHtml });
		expect(await Bun.file(liveHtml).text()).not.toContain("blob:sha256:");
		await sm.close();

		const standaloneHtml = path.join(makeTempDir(), "standalone.html");
		await exportFromFile(sessionFile, { outputPath: standaloneHtml });
		expect(await Bun.file(standaloneHtml).text()).not.toContain("blob:sha256:");

		const reopened = await SessionManager.open(sessionFile);
		await reopened.rewriteEntries();
		await reopened.close();
		await fileDoesNotContainBlobRef(sessionFile);
	});

	it("surfaces typed missing resident text errors from exports and persists a placeholder on rewrite after disk cache deletion", async () => {
		const sentinel = `corrupt resident text ${"z".repeat(2048)}`;
		const { sm, sessionFile } = await createPersistedLargeTextSession(sentinel);
		const liveCacheDir = activeResidentCacheDir(sm);
		await fs.promises.rm(liveCacheDir, { recursive: true, force: true });

		await expectMissingBlobAsync(() =>
			exportSessionToHtml(sm, undefined, { outputPath: path.join(makeTempDir(), "live-corrupt.html") }),
		);
		await sm.close();

		const standalone = await SessionManager.open(sessionFile);
		const standaloneCacheDir = activeResidentCacheDir(standalone);
		await fs.promises.rm(standaloneCacheDir, { recursive: true, force: true });
		await expectMissingBlobAsync(() =>
			exportSessionToHtml(standalone, undefined, {
				outputPath: path.join(makeTempDir(), "standalone-corrupt.html"),
			}),
		);
		await standalone.close();
		await expectMissingBlobAsync(async () => {
			const exportManager = await SessionManager.open(sessionFile);
			const exportCacheDir = activeResidentCacheDir(exportManager);
			await fs.promises.rm(exportCacheDir, { recursive: true, force: true });
			await exportSessionToHtml(exportManager, undefined, {
				outputPath: path.join(makeTempDir(), "from-file-corrupt.html"),
			});
		});

		const rewrite = await SessionManager.open(sessionFile);
		const rewriteCacheDir = activeResidentCacheDir(rewrite);
		await fs.promises.rm(rewriteCacheDir, { recursive: true, force: true });
		await rewrite.rewriteEntries();
		await rewrite.close().catch(() => {});
		const rewritten = await Bun.file(sessionFile).text();
		expect(rewritten).toContain("Session resident text blob missing");
		expect(rewritten).toContain("original content unavailable");
		expect(rewritten).not.toContain(sentinel);
		await fileDoesNotContainBlobRef(sessionFile);
	});

	it("keeps warm materialized resident text readable until entry revision invalidation after cache deletion", async () => {
		// Plan contract: "typed corruption for active materialization" — data that predates
		// corruption remains readable from the warm in-memory view, equivalent to a
		// caller-held array, but the next rematerialization must surface ResidentBlobMissingError.
		const sentinel = `warm sabotage resident text ${"w".repeat(2048)}`;
		const { sm } = await createPersistedLargeTextSession(sentinel);
		const warmEntries = sm.getEntries();
		expect(JSON.stringify(warmEntries)).toContain(sentinel);

		await fs.promises.rm(residentCacheRoot(sm), { recursive: true, force: true });
		expect(JSON.stringify(sm.getEntries())).toContain(sentinel);

		sm.appendMessage(assistantMessage("invalidate warm resident view"));
		expectMissingBlob(() => sm.getEntries());
		await sm.close().catch(() => {});
	});

	it("standalone export close does not destroy the live manager resident cache", async () => {
		const sentinel = `export sharing ${"q".repeat(2048)}`;
		const { sm, sessionFile, cacheDir } = await createPersistedLargeTextSession(sentinel);
		const liveHtml = path.join(makeTempDir(), "live-share.html");
		await exportSessionToHtml(sm, undefined, { outputPath: liveHtml });
		const standaloneHtml = path.join(makeTempDir(), "standalone-share.html");
		await exportFromFile(sessionFile, { outputPath: standaloneHtml });
		expect(fs.existsSync(cacheDir)).toBe(true);
		expect(JSON.stringify(sm.getEntries())).toContain(sentinel);
		expect(JSON.stringify(sm.buildSessionContext())).toContain(sentinel);
		expect(await Bun.file(liveHtml).text()).not.toContain("blob:sha256:");
		expect(await Bun.file(standaloneHtml).text()).not.toContain("blob:sha256:");
		await sm.close();
	});

	it("keeps existing durable image missing-blob fallback semantics", async () => {
		const root = makeTempDir();
		const blobs = new BlobStore(path.join(root, "blobs"));
		const ref = externalizeImageDataSync(blobs, Buffer.from("image-bytes").toString("base64"));
		const sm = SessionManager.create(root, path.join(root, "sessions"));
		const warnSpy = vi.spyOn(logger, "warn").mockImplementation(() => {});
		sm.appendMessage({
			role: "user",
			content: [{ type: "image", data: ref, mimeType: "image/png" }],
			timestamp: Date.now(),
		});
		sm.appendMessage(assistantMessage("persist image ref"));
		await sm.ensureOnDisk();
		await sm.flush();
		const sessionFile = sm.getSessionFile();
		if (!sessionFile) throw new Error("Expected session file");
		await sm.close();
		await fs.promises.rm(path.join(root, "blobs"), { recursive: true, force: true });

		const reopened = await SessionManager.open(sessionFile);
		const user = reopened
			.getEntries()
			.find(
				(e): e is SessionMessageEntry & { message: UserMessage } =>
					e.type === "message" && e.message.role === "user",
			);
		if (!user) throw new Error("Expected user entry");
		expect(JSON.stringify(user.message.content)).toContain(ref);
		expect(warnSpy).toHaveBeenCalled();
		await reopened.close();
	});
});
