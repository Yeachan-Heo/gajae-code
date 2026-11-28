import { describe, expect, it } from "bun:test";
import * as fsSync from "node:fs";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { sessionMatchesConfinement } from "../src/session/session-confinement";
import { SessionManager, SessionManagerTestHooks } from "../src/session/session-manager";

function writeTranscript(file: string, id: string, cwd: string, confined: boolean, padding = ""): void {
	const header = {
		type: "session",
		id,
		timestamp: "2025-01-01T00:00:00Z",
		cwd,
		version: 3,
		...(confined ? { filesystemScope: "cwd" } : {}),
	};
	const message = {
		type: "message",
		id: "1",
		parentId: null,
		timestamp: "2025-01-01T00:00:01Z",
		message: { role: "user", content: `${id}${padding}`, timestamp: 1 },
	};
	fsSync.writeFileSync(file, `${JSON.stringify(header)}\n${JSON.stringify(message)}\n`);
}

describe("--confine session selection", () => {
	it("keeps a confined transcript out of an ordinary resume match", () => {
		expect(sessionMatchesConfinement({ filesystemScope: "cwd" }, true)).toBe(true);
		expect(sessionMatchesConfinement({ filesystemScope: "cwd" }, false)).toBe(false);
		expect(sessionMatchesConfinement({}, false)).toBe(true);
		expect(sessionMatchesConfinement({}, true)).toBe(false);
	});
	it("does not leave an ordinary transcript when a confined resume path is missing", async () => {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "confine-missing-"));
		const missing = path.join(dir, "missing.jsonl");
		try {
			await expect(
				SessionManager.open(
					missing,
					SessionManager.explicitDestination(dir),
					undefined,
					"copy-retain",
					"enabled",
					undefined,
					"resume",
				),
			).rejects.toThrow(/missing path/);
			await expect(fs.stat(missing)).rejects.toMatchObject({ code: "ENOENT" });
		} finally {
			await fs.rm(dir, { recursive: true, force: true });
		}
	});
	it("inspects a fork source scope without creating a missing transcript", async () => {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "confine-inspect-"));
		const missing = path.join(dir, "missing.jsonl");
		const confined = path.join(dir, "confined.jsonl");
		const ordinary = path.join(dir, "ordinary.jsonl");
		writeTranscript(confined, "confined-session", dir, true);
		writeTranscript(ordinary, "ordinary-session", dir, false);
		try {
			expect(SessionManager.inspectTranscriptScope(missing)).toBeUndefined();
			await expect(fs.stat(missing)).rejects.toMatchObject({ code: "ENOENT" });
			expect(SessionManager.inspectTranscriptScope(confined)).toEqual({ confined: true });
			expect(SessionManager.inspectTranscriptScope(ordinary)).toEqual({ confined: false });
		} finally {
			await fs.rm(dir, { recursive: true, force: true });
		}
	});
	it("keeps confinement when a confined transcript is resumed by id", async () => {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "confine-resume-id-"));
		const created = SessionManager.create(dir, SessionManager.explicitDestination(dir), undefined, undefined, true);
		await created.ensureOnDisk();
		const sessionPath = created.getSessionFile();
		const sessionId = created.getSessionId();
		await created.close();
		if (!sessionPath || !sessionId) throw new Error("confined session was not persisted");
		try {
			const resumed = await SessionManager.open(
				sessionPath,
				SessionManager.explicitDestination(dir),
				undefined,
				"copy-retain",
				"shadow",
				undefined,
				"resume",
			);
			expect(resumed.isFilesystemConfined()).toBe(true);
			expect(resumed.getSessionId()).toBe(sessionId);
			await resumed.close();
		} finally {
			await fs.rm(dir, { recursive: true, force: true });
		}
	});
	it("creates a confined child transcript for a missing path in create mode", async () => {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "confine-create-"));
		const child = path.join(dir, "child.jsonl");
		try {
			const opened = await SessionManager.open(
				child,
				SessionManager.explicitDestination(dir),
				undefined,
				"copy-retain",
				"shadow",
				undefined,
				"create",
			);
			expect(opened.isFilesystemConfined()).toBe(true);
			await opened.ensureOnDisk();
			await opened.close();
			const header = JSON.parse((await fs.readFile(child, "utf8")).split(/\r?\n/, 1)[0]!);
			expect(header.filesystemScope).toBe("cwd");
		} finally {
			await fs.rm(dir, { recursive: true, force: true });
		}
	});
	it("refuses to adopt an unconfined transcript in create mode", async () => {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "confine-create-existing-"));
		const existing = path.join(dir, "existing.jsonl");
		writeTranscript(existing, "ordinary-session", dir, false);
		try {
			await expect(
				SessionManager.open(
					existing,
					SessionManager.explicitDestination(dir),
					undefined,
					"copy-retain",
					"shadow",
					undefined,
					"create",
				),
			).rejects.toThrow(/unconfined transcript/);
			const header = JSON.parse((await fs.readFile(existing, "utf8")).split(/\r?\n/, 1)[0]!);
			expect(header.id).toBe("ordinary-session");
			expect(header.filesystemScope).toBeUndefined();
		} finally {
			await fs.rm(dir, { recursive: true, force: true });
		}
	});
	it("continues an older matching-scope transcript past a newer over-budget opposite-scope one", async () => {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "confine-continue-"));
		const older = path.join(dir, "older.jsonl");
		const newer = path.join(dir, "newer.jsonl");
		writeTranscript(older, "confined-session", dir, true);
		writeTranscript(newer, "ordinary-session", dir, false, "x".repeat(16384));
		const past = new Date(Date.now() - 60_000);
		await fs.utimes(older, past, past);
		SessionManagerTestHooks.sessionContextBudgetBytesOverride = 4096;
		try {
			const resumed = await SessionManager.continueRecent(
				dir,
				SessionManager.explicitDestination(dir),
				undefined,
				"copy-retain",
				"shadow",
				undefined,
				true,
			);
			try {
				expect(resumed.getSessionId()).toBe("confined-session");
				expect(resumed.isFilesystemConfined()).toBe(true);
			} finally {
				await resumed.close();
			}
		} finally {
			SessionManagerTestHooks.sessionContextBudgetBytesOverride = undefined;
			await fs.rm(dir, { recursive: true, force: true });
		}
	});
});
describe("--confine session lifecycle", () => {
	it("keeps a lifecycle fork of a confined transcript confined", async () => {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "confine-fork-"));
		const sourceDir = path.join(dir, "source");
		const forkDir = path.join(dir, "fork");
		await fs.mkdir(sourceDir);
		const created = SessionManager.create(
			sourceDir,
			SessionManager.explicitDestination(sourceDir),
			undefined,
			undefined,
			true,
		);
		await created.ensureOnDisk();
		const sessionPath = created.getSessionFile();
		await created.close();
		if (!sessionPath) throw new Error("confined session was not persisted");
		try {
			const captured = SessionManager.captureTranscriptStrict(sessionPath);
			if (captured.kind !== "captured") throw new Error(captured.reason);
			const forked = await SessionManager.forkFromCaptured(
				captured.snapshot,
				sourceDir,
				SessionManager.explicitDestination(forkDir),
				"copy-retain",
				"shadow",
				undefined,
			);
			if (forked.kind !== "forked") throw new Error(forked.reason);
			expect(forked.manager.isFilesystemConfined()).toBe(true);
			const header = JSON.parse((await fs.readFile(forked.manager.getSessionFile()!, "utf8")).split(/\r?\n/, 1)[0]!);
			expect(header.filesystemScope).toBe("cwd");
			await forked.manager.close();
		} finally {
			await fs.rm(dir, { recursive: true, force: true });
		}
	});
});
