import { afterEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { EphemeralBlobStore, MemoryBlobStore } from "@gajae-code/coding-agent/session/blob-store";
import { SessionManager } from "@gajae-code/coding-agent/session/session-manager";
import { getAgentDir, getResidentCacheRootDir, setAgentDir } from "@gajae-code/utils";

const originalAgentDir = getAgentDir();
const temporaryDirectories: string[] = [];

afterEach(async () => {
	vi.restoreAllMocks();
	setAgentDir(originalAgentDir);
	await Promise.all(
		temporaryDirectories.splice(0).map(directory => fsp.rm(directory, { recursive: true, force: true })),
	);
});

function isWithin(root: string, candidate: string): boolean {
	const relative = path.relative(path.resolve(root), path.resolve(candidate));
	return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

describe.skipIf(process.platform !== "win32")("Windows resident-cache disk gate", () => {
	it("uses MemoryBlobStore and never creates a resident cache directory", async () => {
		const root = await fsp.mkdtemp(path.join(os.tmpdir(), "gjc-resident-cache-win32-"));
		temporaryDirectories.push(root);
		const cwd = path.join(root, "workspace");
		const agentDir = path.join(root, "agent");
		await fsp.mkdir(cwd);
		setAgentDir(agentDir);
		const cacheRoot = getResidentCacheRootDir(agentDir);
		const mkdirSync = vi.spyOn(fs, "mkdirSync");
		const mkdtempSync = vi.spyOn(fs, "mkdtempSync");
		const memoryPutSync = vi.spyOn(MemoryBlobStore.prototype, "putSync");
		const diskStoreAdoption = vi.spyOn(EphemeralBlobStore, "adoptVerifiedDir");
		const manager = SessionManager.create(cwd, path.join(root, "sessions"));
		const text = `native Windows resident cache gate ${"w".repeat(4096)}`;
		try {
			manager.appendMessage({ role: "user", content: text, timestamp: Date.now() });
			await manager.ensureOnDisk();
			await manager.flush();

			expect(JSON.stringify(manager.getEntries())).toContain(text);
			expect(memoryPutSync).toHaveBeenCalled();
			expect(diskStoreAdoption).not.toHaveBeenCalled();
			expect(manager.getObservabilityStatsForTests().residentCacheWin32FallbackCount).toBe(1);
			expect(fs.existsSync(cacheRoot)).toBe(false);
			expect(mkdirSync.mock.calls.some(([directory]) => isWithin(cacheRoot, String(directory)))).toBe(false);
			expect(mkdtempSync.mock.calls.some(([prefix]) => isWithin(cacheRoot, String(prefix)))).toBe(false);
		} finally {
			await manager.close().catch(() => {});
		}
	});
});
