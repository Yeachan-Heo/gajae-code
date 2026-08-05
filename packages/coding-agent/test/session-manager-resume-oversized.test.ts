import { afterEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
	RESUME_TRANSCRIPT_MAX_BYTES,
	type ResumeSessionIdentity,
	SessionManager,
	SessionTranscriptOversizedError,
} from "@gajae-code/coding-agent/session/session-manager";
import { FileSessionStorage } from "@gajae-code/coding-agent/session/session-storage";

const tempDirs: string[] = [];

afterEach(async () => {
	vi.restoreAllMocks();
	for (const dir of tempDirs.splice(0)) await fs.promises.rm(dir, { recursive: true, force: true });
});

function makeTempDir(): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gjc-resume-oversized-"));
	tempDirs.push(dir);
	return dir;
}

/**
 * Build a valid but oversized transcript fixture without allocating 64 MiB of
 * real content. The file header + one message is written, then the file is
 * extended (sparse) to `targetBytes` so `stat().size` reports the oversize
 * while the actual block allocation stays tiny.
 */
function writeOversizedTranscript(filePath: string, targetBytes: number, sessionId = "oversized"): number {
	const header = {
		type: "session",
		id: sessionId,
		timestamp: new Date(0).toISOString(),
		cwd: "/cwd",
		version: 5,
	};
	const message = {
		type: "message",
		id: "message",
		parentId: null,
		timestamp: new Date(0).toISOString(),
		message: { role: "user", content: "resume", timestamp: 0 },
	};
	const prefix = `${JSON.stringify(header)}\n${JSON.stringify(message)}\n`;
	fs.writeFileSync(filePath, prefix, { mode: 0o600 });
	// Extend to the target size without writing the full content.
	const fd = fs.openSync(filePath, "r+");
	fs.ftruncateSync(fd, targetBytes);
	fs.closeSync(fd);
	return fs.statSync(filePath).size;
}

function identityFromStat(filePath: string, sessionId: string, size: number): ResumeSessionIdentity {
	const stat = fs.statSync(filePath);
	return {
		canonicalPath: path.resolve(filePath),
		sessionId,
		dev: BigInt((stat.dev as number) || 0),
		ino: BigInt((stat.ino as number) || 0),
		nlink: BigInt((stat.nlink as number) || 1),
		size,
		mtimeMs: stat.mtimeMs,
		mtimeNs: BigInt(Math.floor(stat.mtimeMs * 1_000_000)),
		ctimeNs: BigInt(Math.floor(stat.mtimeMs * 1_000_000)),
		sha256: "ignored-by-precheck",
	};
}

describe("SessionManager oversized resume graceful fallback (#3851)", () => {
	it("inspectSessionTailReadOnly returns oversized before reading file content", async () => {
		const dir = makeTempDir();
		const filePath = path.join(dir, "oversized.jsonl");
		const targetBytes = RESUME_TRANSCRIPT_MAX_BYTES + 1;
		const reportedSize = writeOversizedTranscript(filePath, targetBytes);

		expect(reportedSize).toBe(targetBytes);

		// The pre-check must fire from stat alone, never decoding the body.
		const inspected = await SessionManager.inspectSessionTailReadOnly(filePath, new FileSessionStorage());
		expect(inspected).toEqual({ kind: "error", reason: "oversized", size: reportedSize });
	});

	it("openExistingStrict returns oversized without creating or rewriting the session", async () => {
		const dir = makeTempDir();
		const filePath = path.join(dir, "oversized.jsonl");
		const targetBytes = RESUME_TRANSCRIPT_MAX_BYTES + 1024;
		const reportedSize = writeOversizedTranscript(filePath, targetBytes);
		const identity = identityFromStat(filePath, "oversized", reportedSize);
		const sessionDir = path.join(dir, "sessions");

		const opened = await SessionManager.openExistingStrict(
			identity,
			SessionManager.explicitDestination(sessionDir),
			new FileSessionStorage(),
		);
		expect(opened.kind).toBe("error");
		if (opened.kind !== "error") throw new Error("expected error");
		expect(opened.reason).toBe("oversized");
		expect(opened.size).toBe(reportedSize);
		// No session manager should have been constructed or files written.
		expect(fs.existsSync(sessionDir)).toBe(false);
	});

	it("SessionManager.open throws SessionTranscriptOversizedError for oversized transcripts", async () => {
		const dir = makeTempDir();
		const filePath = path.join(dir, "oversized.jsonl");
		const targetBytes = RESUME_TRANSCRIPT_MAX_BYTES + 1;
		writeOversizedTranscript(filePath, targetBytes);
		const sessionDir = path.join(dir, "sessions");

		let caught: unknown;
		try {
			await SessionManager.open(filePath, SessionManager.explicitDestination(sessionDir));
		} catch (error) {
			caught = error;
		}
		expect(caught).toBeInstanceOf(SessionTranscriptOversizedError);
		expect((caught as SessionTranscriptOversizedError).code).toBe("oversized");
		// No destination directory created on the fail-closed path.
		expect(fs.existsSync(sessionDir)).toBe(false);
	});

	it("does not classify a just-under-limit session as oversized", async () => {
		const dir = makeTempDir();
		const filePath = path.join(dir, "near-limit.jsonl");
		// Write a real (small) valid session — well under the limit.
		const header = {
			type: "session",
			id: "near-limit",
			timestamp: new Date(0).toISOString(),
			cwd: "/cwd",
			version: 5,
		};
		const message = {
			type: "message",
			id: "message",
			parentId: null,
			timestamp: new Date(0).toISOString(),
			message: { role: "user", content: "resume", timestamp: 0 },
		};
		fs.writeFileSync(filePath, `${JSON.stringify(header)}\n${JSON.stringify(message)}\n`, { mode: 0o600 });

		const inspected = await SessionManager.inspectSessionTailReadOnly(filePath, new FileSessionStorage());
		expect(inspected.kind).toBe("resumable");
	});

	it("RESUME_TRANSCRIPT_MAX_BYTES matches the managed-storage per-file bound", () => {
		// Guard against silently decoupling the resume limit from the artifact bound.
		expect(RESUME_TRANSCRIPT_MAX_BYTES).toBe(64 * 1024 * 1024);
	});
});
