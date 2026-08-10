import { describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { getResidentCacheRootDir, logger, TempDir } from "@gajae-code/utils";
import { EphemeralBlobStore, ResidentCacheTrustError } from "../../src/session/blob-store";
import { SessionManager } from "../../src/session/session-manager";
import { FileSessionStorage } from "../../src/session/session-storage";

const itPosix = it.skipIf(process.platform === "win32");

interface ManagedSidecarFixture {
	readonly manager: SessionManager;
	readonly sidecarCacheDirs: string[];
	readonly cleanup: () => void;
}

/**
 * A managed session keeps its cold-history sidecar in a resident-cache instance
 * directory rather than under managed authority, so `close()` disposes that
 * directory during teardown.
 */
function createManagedSidecarSession(prefix: string): ManagedSidecarFixture {
	const tempDir = TempDir.createSync(prefix);
	const cwd = path.join(tempDir.path(), "project");
	const agentDir = path.join(tempDir.path(), "agent");
	fs.mkdirSync(cwd, { recursive: true });
	const storage = new FileSessionStorage();
	const destination = SessionManager.managedDestination(cwd, agentDir, storage);
	const manager = SessionManager.create(cwd, destination, storage);
	manager.setSessionMemoryMode("enabled");
	manager.appendMessage({
		role: "assistant",
		content: [{ type: "text", text: "published" }],
		api: "anthropic-messages",
		provider: "anthropic",
		model: "claude-sonnet-4-5",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: Date.now(),
	});
	let firstKeptEntryId = "";
	for (let index = 0; index < 400; index++) {
		firstKeptEntryId = manager.appendMessage({
			role: "user",
			content: `managed-${index}-${"x".repeat(256)}`,
			timestamp: Date.now(),
		});
	}
	manager.appendCompaction("summary", undefined, firstKeptEntryId, 20_000);
	expect(manager.getSessionMemoryStats()).toMatchObject({ coldRetirementActive: true, sidecarIneligible: false });

	if (destination.kind !== "managed") throw new Error("Expected a managed destination");
	const cacheRoot = getResidentCacheRootDir(destination.securityContext.profileAgentDir);
	const residentTextCacheDir = manager.residentTextCacheDirForTests();
	const sidecarCacheDirs = fs
		.readdirSync(cacheRoot)
		.map(name => path.join(cacheRoot, name))
		.filter(candidate => path.basename(candidate).startsWith("i-") && candidate !== residentTextCacheDir);

	return { manager, sidecarCacheDirs, cleanup: () => tempDir.removeSync() };
}

describe("managed sidecar resident-cache release", () => {
	itPosix(
		"closes the session when the sidecar cache directory is already gone",
		async () => {
			const fixture = createManagedSidecarSession("@pi-managed-sidecar-missing-");
			try {
				expect(fixture.sidecarCacheDirs).not.toHaveLength(0);
				for (const directory of fixture.sidecarCacheDirs) fs.rmSync(directory, { recursive: true, force: true });

				await fixture.manager.close();

				for (const directory of fixture.sidecarCacheDirs) expect(fs.existsSync(directory)).toBe(false);
			} finally {
				fixture.cleanup();
			}
		},
		60_000,
	);

	itPosix(
		"closes the session when the sidecar cache refuses disposal",
		async () => {
			const fixture = createManagedSidecarSession("@pi-managed-sidecar-untrusted-");
			const warn = vi.spyOn(logger, "warn").mockImplementation(() => {});
			const dispose = vi.spyOn(EphemeralBlobStore.prototype, "dispose").mockImplementation(function (
				this: EphemeralBlobStore,
			) {
				throw new ResidentCacheTrustError("directory_untrusted", this.dir);
			});
			try {
				expect(fixture.sidecarCacheDirs).not.toHaveLength(0);

				await fixture.manager.close();

				expect(dispose.mock.calls.length).toBeGreaterThan(0);
				expect(
					warn.mock.calls.some(([message]) => String(message).includes("managed sidecar resident cache")),
				).toBe(true);
			} finally {
				dispose.mockRestore();
				warn.mockRestore();
				for (const directory of fixture.sidecarCacheDirs) fs.rmSync(directory, { recursive: true, force: true });
				fixture.cleanup();
			}
		},
		60_000,
	);
});
