import { describe, expect, it } from "bun:test";
import { recoverOrphanedBackups, SessionManager } from "@gajae-code/coding-agent/session/session-manager";
import { MemorySessionStorage } from "@gajae-code/coding-agent/session/session-storage";

class FsCodeError extends Error {
	constructor(
		readonly code: string,
		message: string,
	) {
		super(message);
	}
}

class RenameTrackingStorage extends MemorySessionStorage {
	renames = 0;

	override rename(source: string, target: string): Promise<void> {
		this.renames++;
		return super.rename(source, target);
	}
}

class AsyncRenameEpermStorage extends MemorySessionStorage {
	mode: "recover" | "rollback-failure" | undefined;

	override rename(source: string, target: string): Promise<void> {
		if (this.mode && source.includes(".tmp") && target.endsWith(".jsonl")) {
			if (this.mode === "recover") {
				this.mode = undefined;
				return Promise.reject(new FsCodeError("EPERM", "initial replacement rejected"));
			}
			if (!this.existsSync(target)) {
				return Promise.reject(new Error("replacement retry rejected"));
			}
			return Promise.reject(new FsCodeError("EPERM", "initial replacement rejected"));
		}
		if (this.mode === "rollback-failure" && source.endsWith(".bak") && target.endsWith(".jsonl")) {
			return Promise.reject(new Error("rollback rejected"));
		}
		return super.rename(source, target);
	}
}

async function appendPersistedSession(storage: MemorySessionStorage): Promise<SessionManager> {
	const session = SessionManager.create("/cwd", "/sessions", storage);
	session.appendMessage({ role: "user", content: "first", timestamp: 1 });
	await session.ensureOnDisk();
	return session;
}

describe("SessionManager append-only header patches", () => {
	it("appends a bounded rename patch without replacing the existing session file", async () => {
		const storage = new RenameTrackingStorage();
		const session = SessionManager.create("/cwd", "/sessions", storage);
		await session.ensureOnDisk();
		const sessionFile = session.getSessionFile();
		if (!sessionFile) throw new Error("Expected session file");
		const before = storage.readTextSync(sessionFile);
		storage.renames = 0;

		await expect(session.setSessionName("renamed session", "user")).resolves.toBe(true);

		const after = storage.readTextSync(sessionFile);
		expect(after.startsWith(before)).toBe(true);
		const patch = JSON.parse(after.slice(before.length));
		expect(patch).toEqual({
			type: "header_patch",
			patch: { title: "renamed session", titleSource: "user" },
		});
		expect(after.length - before.length).toBeLessThan(128);
		expect(storage.renames).toBe(0);

		session.appendMessage({ role: "user", content: "after patch", timestamp: Date.now() });
		await expect(session.flush()).resolves.toBeUndefined();
	});
});

describe("SessionManager async atomic rewrite EPERM recovery", () => {
	it("replaces the transcript after an EPERM overwrite failure", async () => {
		const storage = new AsyncRenameEpermStorage();
		const session = await appendPersistedSession(storage);
		await session.flush();
		const sessionFile = session.getSessionFile();
		if (!sessionFile) throw new Error("Expected session file");

		storage.mode = "recover";
		await expect(session.rewriteEntries()).resolves.toBeUndefined();

		expect(storage.readTextSync(sessionFile)).toContain('"content":"first"');
		expect(storage.listFilesSync("/sessions", "*.bak")).toEqual([]);
	});

	it("surfaces the original EPERM as the cause when replacement rollback fails", async () => {
		const storage = new AsyncRenameEpermStorage();
		const session = await appendPersistedSession(storage);
		await session.flush();

		storage.mode = "rollback-failure";
		let thrown: Error | undefined;
		try {
			await session.rewriteEntries();
		} catch (error) {
			thrown = error as Error;
		}

		expect(thrown?.message).toContain("rollback from");
		expect(thrown?.message).toContain("rollback rejected");
		expect(thrown?.cause).toMatchObject({ code: "EPERM", message: "initial replacement rejected" });
	});
});

describe("recoverOrphanedBackups", () => {
	it("promotes an orphaned <basename>.jsonl.<snowflake>.bak back to the primary path when the primary is missing", async () => {
		const storage = new MemorySessionStorage();
		const dir = "/sessions/proj";
		const primary = `${dir}/session-abc.jsonl`;
		const backup = `${primary}.1700000000000.bak`;
		storage.writeTextSync(backup, '{"type":"session","id":"abc"}\n');

		await recoverOrphanedBackups(dir, storage);

		expect(storage.existsSync(primary)).toBe(true);
		expect(storage.existsSync(backup)).toBe(false);
		expect(storage.readTextSync(primary)).toBe('{"type":"session","id":"abc"}\n');
	});

	it("leaves the backup alone when the primary already exists", async () => {
		const storage = new MemorySessionStorage();
		const dir = "/sessions/proj";
		const primary = `${dir}/session-xyz.jsonl`;
		const backup = `${primary}.1700000000000.bak`;
		storage.writeTextSync(primary, '{"type":"session","id":"xyz","keep":true}\n');
		storage.writeTextSync(backup, '{"type":"session","id":"xyz","stale":true}\n');

		await recoverOrphanedBackups(dir, storage);

		expect(storage.readTextSync(primary)).toContain('"keep":true');
		expect(storage.existsSync(backup)).toBe(true);
	});

	it("picks the newest backup when multiple orphans exist for the same primary", async () => {
		const storage = new MemorySessionStorage();
		const dir = "/sessions/proj";
		const primary = `${dir}/session-multi.jsonl`;
		const older = `${primary}.100.bak`;
		const newer = `${primary}.200.bak`;
		storage.writeTextSync(older, "older");
		// Force the newer backup to have a strictly higher mtime so recovery is deterministic.
		await Bun.sleep(5);
		storage.writeTextSync(newer, "newer");

		await recoverOrphanedBackups(dir, storage);

		expect(storage.existsSync(primary)).toBe(true);
		expect(storage.readTextSync(primary)).toBe("newer");
	});
});
