import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { AssistantMessage } from "@gajae-code/ai";
import { exportSessionToHtml } from "@gajae-code/coding-agent/export/html";
import { SessionManager, type SessionMessageEntry } from "@gajae-code/coding-agent/session/session-manager";
import * as native from "@gajae-code/natives";
import { getAgentDir, getResidentCacheRootDir, setAgentDir } from "@gajae-code/utils";

const originalAgentDir = getAgentDir();
const originalAgentDirOverride = process.env.GJC_CODING_AGENT_DIR;
const tempDirs: string[] = [];
beforeEach(() => {
	setAgentDir(path.join(tempRoot(), "agent"));
});
afterEach(async () => {
	vi.restoreAllMocks();
	setAgentDir(originalAgentDir);
	if (originalAgentDirOverride === undefined) delete process.env.GJC_CODING_AGENT_DIR;
	else process.env.GJC_CODING_AGENT_DIR = originalAgentDirOverride;
	for (const dir of tempDirs.splice(0)) await fs.promises.rm(dir, { recursive: true, force: true });
});

function tempRoot(prefix = "gjc-resident-life-"): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
	tempDirs.push(dir);
	return dir;
}

function failedNativeRename(): native.NativeNoReplaceResult {
	return {
		ok: false,
		code: "io_error",
		mutationState: "not_committed",
		durabilityState: "not_attempted",
		reason: "io_failure",
		primitive: "unknown",
		phase: "rename",
		diagnostic: { schemaVersion: 1, collectionState: "unavailable" },
	};
}
function installVerifiedNativeCleanup(): void {
	vi.spyOn(native, "exactUnlink").mockImplementation((pathname, identity) => {
		const parent = fs.lstatSync(path.dirname(pathname), { bigint: true });
		if (
			identity.parentDev === undefined ||
			identity.parentIno === undefined ||
			parent.dev !== identity.parentDev ||
			parent.ino !== identity.parentIno
		)
			throw new Error("resident cleanup parent authority mismatch");
		const stat = fs.lstatSync(pathname, { bigint: true });
		if (
			stat.dev !== identity.dev ||
			stat.ino !== identity.ino ||
			stat.nlink !== identity.nlink ||
			stat.size !== identity.size ||
			stat.mtimeNs !== identity.mtimeNs
		)
			throw new Error("resident cleanup file identity mismatch");
		if (identity.sha256) {
			const digest = createHash("sha256").update(fs.readFileSync(pathname)).digest("hex");
			if (digest !== identity.sha256) throw new Error("resident cleanup file digest mismatch");
		}
		if (identity.directory && identity.quarantineName) {
			const detachedPath = path.join(path.dirname(pathname), identity.quarantineName);
			fs.renameSync(pathname, detachedPath);
			return { ok: true, detachedPath };
		}
		fs.rmSync(pathname, { force: true });
		return { ok: true };
	});
	vi.spyOn(native, "exactRemoveDirectoryTree").mockImplementation((pathname, snapshot, parentIdentity) => {
		const parent = fs.lstatSync(path.dirname(pathname), { bigint: true });
		if (!parentIdentity) throw new Error("resident tree cleanup parent authority missing");
		if (parent.dev !== parentIdentity.dev || parent.ino !== parentIdentity.ino)
			throw new Error("resident tree cleanup parent authority mismatch");
		const current = native.snapshotDirectoryTree(pathname);
		if (!current.ok || !current.snapshot || current.snapshot.entries.length !== snapshot.entries.length)
			throw new Error("resident tree cleanup snapshot mismatch");
		const expected = new Map(snapshot.entries.map(entry => [entry.relativePath, entry]));
		for (const entry of current.snapshot.entries) {
			const authorized = expected.get(entry.relativePath);
			if (!authorized) throw new Error("resident tree cleanup snapshot mismatch");
			if (entry.relativePath === "") {
				if (entry.kind !== "directory" || entry.dev !== authorized.dev || entry.ino !== authorized.ino)
					throw new Error("resident tree cleanup root identity mismatch");
			} else if (JSON.stringify(entry) !== JSON.stringify(authorized)) {
				throw new Error("resident tree cleanup child identity mismatch");
			}
		}
		fs.rmSync(pathname, { recursive: true, force: true });
		return { ok: true };
	});
}

function assistant(text: string): AssistantMessage {
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

function readPersistedJsonl(sessionFile: string): Promise<string> {
	return Bun.file(sessionFile).text();
}

function firstAssistant(sm: SessionManager): SessionMessageEntry {
	const entry = sm
		.getEntries()
		.find((e): e is SessionMessageEntry => e.type === "message" && e.message.role === "assistant");
	if (!entry) throw new Error("Expected assistant entry");
	return entry;
}

function residentCacheRoot(): string {
	return getResidentCacheRootDir(getAgentDir());
}

function residentCacheDirs(): string[] {
	const root = residentCacheRoot();
	return fs.existsSync(root)
		? fs
				.readdirSync(root)
				.map(name => path.join(root, name))
				.filter(dir => path.basename(dir).startsWith("i-") && fs.statSync(dir).isDirectory())
		: [];
}

function activeResidentCacheDir(): string {
	const dirs = residentCacheDirs();
	if (dirs.length !== 1) throw new Error(`Expected one active resident cache dir, got ${dirs.length}`);
	return dirs[0]!;
}

async function makeLargeSession(
	text: string,
): Promise<{ sm: SessionManager; root: string; sessionFile: string; artifactsDir: string; cacheDir: string }> {
	const root = tempRoot();
	const sm = SessionManager.create(root, SessionManager.getDefaultSessionDir(root, root));
	sm.appendMessage({ role: "user", content: "start", timestamp: Date.now() });
	sm.appendMessage(assistant(text));
	await sm.ensureOnDisk();
	await sm.flush();
	const sessionFile = sm.getSessionFile();
	const artifactsDir = sm.getArtifactsDir();
	if (!sessionFile || !artifactsDir) throw new Error("Expected persisted paths");
	return { sm, root, sessionFile, artifactsDir, cacheDir: activeResidentCacheDir() };
}

describe("resident cache prune retention, lifecycle cleanup, and JSONL parity", () => {
	it("removes pre-prune resident text from public reads, rewritten JSONL, and live export", async () => {
		const sentinel = `pre-prune sentinel ${"s".repeat(2048)}`;
		const { sm, sessionFile } = await makeLargeSession(sentinel);
		const entry = firstAssistant(sm);
		const updated: SessionMessageEntry = structuredClone(entry);
		if (updated.message.role !== "assistant") throw new Error("Expected assistant entry");
		updated.message.content = [{ type: "text", text: "[pruned compacted replacement]" }];
		sm.applyEntryMessageUpdates([updated]);
		await sm.rewriteEntries();

		expect(JSON.stringify(sm.getEntries())).not.toContain(sentinel);
		expect(JSON.stringify(sm.buildSessionContext())).not.toContain(sentinel);
		expect(await readPersistedJsonl(sessionFile)).not.toContain(sentinel);
		const liveHtml = path.join(tempRoot(), "pruned.html");
		await exportSessionToHtml(sm, undefined, { outputPath: liveHtml });
		expect(await Bun.file(liveHtml).text()).not.toContain(sentinel);
		expect(JSON.stringify(sm.getEntries())).toContain("[pruned compacted replacement]");
		await sm.close();
	});

	it("cleans resident cache on session deletion, session-file switch, and close", async () => {
		const second = await makeLargeSession(`cleanup two ${"d".repeat(2048)}`);
		await second.sm.close();
		const { sm, sessionFile, cacheDir } = await makeLargeSession(`cleanup one ${"c".repeat(2048)}`);
		expect(fs.existsSync(cacheDir)).toBe(true);
		const switchCacheDir = cacheDir;
		await sm.setSessionFile(second.sessionFile);
		expect(fs.existsSync(switchCacheDir)).toBe(false);
		expect(JSON.stringify(sm.getEntries())).toContain("cleanup two");
		const activeCacheDir = activeResidentCacheDir();
		expect(fs.existsSync(activeCacheDir)).toBe(true);
		await sm.close();
		expect(fs.existsSync(activeCacheDir)).toBe(false);

		const deletion = await makeLargeSession(`delete cleanup ${"e".repeat(2048)}`);
		expect(fs.existsSync(deletion.cacheDir)).toBe(true);
		const foreignSessionFile = path.join(path.dirname(deletion.sessionFile), "foreign.jsonl");
		const foreignArtifactsDir = foreignSessionFile.slice(0, -6);
		fs.writeFileSync(foreignSessionFile, "foreign transcript");
		fs.mkdirSync(foreignArtifactsDir);
		fs.writeFileSync(path.join(foreignArtifactsDir, "foreign.txt"), "foreign artifact");
		await deletion.sm.setSessionFile(sessionFile);
		expect(fs.existsSync(deletion.cacheDir)).toBe(false);
		installVerifiedNativeCleanup();
		await deletion.sm.dropSession(deletion.sessionFile);
		expect(fs.existsSync(deletion.artifactsDir)).toBe(false);
		expect(fs.existsSync(deletion.cacheDir)).toBe(false);
		expect(fs.existsSync(deletion.sessionFile)).toBe(false);
		expect(fs.existsSync(foreignSessionFile)).toBe(true);
		expect(fs.existsSync(foreignArtifactsDir)).toBe(true);
		expect(fs.existsSync(path.join(foreignArtifactsDir, "foreign.txt"))).toBe(true);
		expect(fs.existsSync(sessionFile)).toBe(true);
	});

	it("completes managed deletion with descriptor-bound final cleanup authority", async () => {
		const survivor = await makeLargeSession(`pending delete survivor ${"v".repeat(2048)}`);
		await survivor.sm.close();
		const deletion = await makeLargeSession(`pending delete cleanup ${"n".repeat(2048)}`);
		await deletion.sm.setSessionFile(survivor.sessionFile);

		await expect(deletion.sm.dropSession(deletion.sessionFile)).resolves.toBeUndefined();
		expect(fs.existsSync(deletion.sessionFile)).toBe(false);
		expect(fs.existsSync(deletion.artifactsDir)).toBe(false);
		expect(fs.existsSync(deletion.cacheDir)).toBe(false);
		expect(fs.existsSync(survivor.sessionFile)).toBe(true);
	});

	it("fork re-externalizes resident text into an independent cache and keeps both managers readable", async () => {
		const sentinel = `fork resident ${"f".repeat(2048)}`;
		const { sm, sessionFile: oldSessionFile, cacheDir: oldCacheDir } = await makeLargeSession(sentinel);
		const forked = await sm.fork();
		if (!forked) throw new Error("Expected fork result");
		expect(forked.oldSessionFile).toBe(oldSessionFile);
		expect(forked.newSessionFile).not.toBe(oldSessionFile);
		const forkCacheDir = activeResidentCacheDir();
		expect(forkCacheDir).not.toBe(oldCacheDir);
		expect(JSON.stringify(sm.getEntries())).toContain(sentinel);
		expect(JSON.stringify(sm.buildSessionContext())).toContain(sentinel);

		const oldManager = await SessionManager.open(oldSessionFile);
		expect(JSON.stringify(oldManager.getEntries())).toContain(sentinel);
		const cacheDirs = residentCacheDirs();
		expect(cacheDirs).toHaveLength(2);
		expect(cacheDirs).toContain(forkCacheDir);
		expect(cacheDirs.filter(dir => dir !== forkCacheDir)).toHaveLength(1);
		await oldManager.close();
		await sm.close();
	});

	it("moveTo materializes before cache reset and rewrites JSONL from the new resident store", async () => {
		const sentinel = `move resident ${"m".repeat(2048)}`;
		const { sm, sessionFile, cacheDir } = await makeLargeSession(sentinel);
		const newRoot = tempRoot("gjc-resident-moved-");
		await sm.moveTo(newRoot);
		const movedFile = sm.getSessionFile();
		if (!movedFile) throw new Error("Expected moved session file");
		expect(movedFile).not.toBe(sessionFile);
		expect(JSON.stringify(sm.getEntries())).toContain(sentinel);
		expect(JSON.stringify(sm.buildSessionContext())).toContain(sentinel);
		expect(await readPersistedJsonl(movedFile)).toContain(sentinel.slice(0, 100));
		expect(await readPersistedJsonl(movedFile)).not.toContain("__gjcResidentBlob");
		expect(await readPersistedJsonl(movedFile)).not.toContain("blob:sha256:");
		const movedCacheDir = activeResidentCacheDir();
		expect(movedCacheDir).not.toBe(cacheDir);
		await sm.close();
	});

	it("restoreState re-owns resident text before resetting the resident store", async () => {
		const sentinel = `restore resident ${"b".repeat(2048)}`;
		const { sm, sessionFile } = await makeLargeSession(sentinel);
		const snapshot = sm.captureState();

		sm.restoreState(snapshot);
		expect(JSON.stringify(sm.getEntries())).toContain(sentinel);
		expect(JSON.stringify(sm.buildSessionContext())).toContain(sentinel);
		const restoredHtml = path.join(tempRoot(), "restore.html");
		await exportSessionToHtml(sm, undefined, { outputPath: restoredHtml });
		expect(await Bun.file(restoredHtml).text()).not.toContain("blob:sha256:");

		await sm.rewriteEntries();
		const rewritten = await readPersistedJsonl(sessionFile);
		expect(rewritten).toContain(sentinel.slice(0, 100));
		expect(rewritten).not.toContain("__gjcResidentBlob");
		expect(rewritten).not.toContain("blob:sha256:");
		await sm.close();
	});

	it("keeps live resident text readable when moveTo session-file publication fails", async () => {
		const sentinel = `failed session publication ${"r".repeat(2048)}`;
		const { sm, root, sessionFile } = await makeLargeSession(sentinel);
		const newRoot = tempRoot("gjc-resident-failed-move-");
		const realRename = native.renameNoReplacePath;
		vi.spyOn(native, "renameNoReplacePath").mockImplementation((source, target) =>
			String(source) === sessionFile ? failedNativeRename() : realRename(source, target),
		);

		await expect(sm.moveTo(newRoot)).rejects.toThrow("Atomic session rename failed: io_error");
		expect(sm.getCwd()).toBe(root);
		expect(sm.getSessionFile()).toBe(sessionFile);
		expect(fs.existsSync(sessionFile)).toBe(true);
		expect(JSON.stringify(sm.getEntries())).toContain(sentinel);
		expect(JSON.stringify(sm.buildSessionContext())).toContain(sentinel);
		await sm.rewriteEntries();
		expect(await readPersistedJsonl(sessionFile)).toContain(sentinel.slice(0, 100));
		await sm.close();
	});

	it("keeps live resident text readable when artifact publication fails after session rollback", async () => {
		const sentinel = `failed artifact publication ${"a".repeat(2048)}`;
		const { sm, root, sessionFile } = await makeLargeSession(sentinel);
		const oldArtifactDir = sessionFile.slice(0, -6);
		fs.mkdirSync(oldArtifactDir, { recursive: true });
		fs.writeFileSync(path.join(oldArtifactDir, "fixture.txt"), "artifact");
		const newRoot = tempRoot("gjc-resident-failed-artifact-move-");
		const realRename = native.renameNoReplacePath;
		vi.spyOn(native, "renameNoReplacePath").mockImplementation((source, target) =>
			String(source) === oldArtifactDir ? failedNativeRename() : realRename(source, target),
		);

		await expect(sm.moveTo(newRoot)).rejects.toThrow("Atomic session rename failed: io_error");
		expect(sm.getCwd()).toBe(root);
		expect(sm.getSessionFile()).toBe(sessionFile);
		expect(fs.existsSync(sessionFile)).toBe(true);
		expect(JSON.stringify(sm.getEntries())).toContain(sentinel);
		expect(JSON.stringify(sm.buildSessionContext())).toContain(sentinel);
		await sm.rewriteEntries();
		expect(await readPersistedJsonl(sessionFile)).toContain(sentinel.slice(0, 100));
		await sm.close();
	});

	it("persists large text with legacy truncation notice and without resident sentinels or text blob refs", async () => {
		const sentinel = `canonical parity ${"p".repeat(600_000)}`;
		const { sm, sessionFile } = await makeLargeSession(sentinel);
		await sm.close();
		const jsonl = await readPersistedJsonl(sessionFile);
		expect(jsonl).toContain("[Session persistence truncated large content]");
		expect(jsonl).not.toContain("__gjcResidentBlob");
		expect(jsonl).not.toContain("blob:sha256:");
		expect(jsonl).toContain(sentinel.slice(0, 10_000));
		expect(jsonl).not.toContain(sentinel.slice(0, 510_000));

		const lines = jsonl
			.trim()
			.split("\n")
			.map(line => JSON.parse(line) as unknown);
		const assistantEntry = lines.find((entry): entry is { type: "message"; message: AssistantMessage } => {
			if (typeof entry !== "object" || entry === null) return false;
			const candidate = entry as { type?: unknown; message?: { role?: unknown } };
			return candidate.type === "message" && candidate.message?.role === "assistant";
		});
		if (!assistantEntry) throw new Error("Expected assistant entry");
		expect(JSON.stringify(assistantEntry.message.content)).toContain("[Session persistence truncated large content]");
		expect(JSON.stringify(assistantEntry.message.content)).not.toContain("blob:sha256:");
	});
});
