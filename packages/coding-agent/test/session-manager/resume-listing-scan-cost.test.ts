import { afterEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { CURRENT_SESSION_VERSION, SessionManager } from "@gajae-code/coding-agent/session/session-manager";

/**
 * Resume listing reads every candidate transcript's trailing bytes to recover a
 * possibly-buried `header_patch` (#3633). A transcript that never emitted one —
 * the common case, since only `/rename` and workspace moves do — cannot be
 * recognized as such without reaching BOF, so the whole file is walked.
 *
 * These tests pin the read cost of that walk. They assert syscall counts rather
 * than wall-clock so they stay deterministic on slow or loaded CI machines.
 */
describe("resume listing trailing-patch scan cost", () => {
	let testDir: string | undefined;

	afterEach(() => {
		vi.restoreAllMocks();
		if (testDir) fs.rmSync(testDir, { recursive: true, force: true });
		testDir = undefined;
	});

	function writeTranscript(
		sessionDir: string,
		cwd: string,
		sessionId: string,
		targetBytes: number,
		starCapable = true,
	): string {
		const sessionFile = path.join(sessionDir, `${sessionId}.jsonl`);
		const lines: string[] = [
			JSON.stringify({
				type: "session",
				version: CURRENT_SESSION_VERSION,
				...(starCapable ? { starredPatchVersion: 1 } : {}),
				id: sessionId,
				timestamp: "2026-08-16T00:00:00.000Z",
				cwd,
				title: "header-title",
			}),
		];
		let bytes = Buffer.byteLength(`${lines[0]}\n`);
		for (let index = 0; bytes < targetBytes; index++) {
			const line = JSON.stringify({
				type: "message",
				id: `m-${index}`,
				parentId: index === 0 ? null : `m-${index - 1}`,
				timestamp: "2026-08-16T00:00:01.000Z",
				message: {
					role: "assistant",
					content: [{ type: "text", text: `payload ${index}: ${"x".repeat(2000)}` }],
					api: "anthropic-messages",
					provider: "anthropic",
					model: "synthetic-model",
					usage: {
						input: 1,
						output: 1,
						cacheRead: 0,
						cacheWrite: 0,
						totalTokens: 2,
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
					},
					stopReason: "stop",
					timestamp: index + 1,
				},
			});
			lines.push(line);
			bytes += Buffer.byteLength(`${line}\n`);
		}
		fs.writeFileSync(sessionFile, `${lines.join("\n")}\n`);
		return sessionFile;
	}

	/** Counts reads issued against the transcript, not against unrelated files. */
	function countReadsFor(target: string): { reads: () => number; bytes: () => number } {
		let reads = 0;
		let bytes = 0;
		const realOpen = fs.promises.open;
		vi.spyOn(fs.promises, "open").mockImplementation(async (...args: Parameters<typeof fs.promises.open>) => {
			const handle = await realOpen(...args);
			if (path.resolve(String(args[0])) !== path.resolve(target)) return handle;
			const realRead = handle.read.bind(handle);
			handle.read = (async (...readArgs: unknown[]) => {
				const result = await (realRead as (...a: unknown[]) => Promise<{ bytesRead: number }>)(...readArgs);
				reads++;
				bytes += result.bytesRead;
				return result;
			}) as typeof handle.read;
			return handle;
		});
		return { reads: () => reads, bytes: () => bytes };
	}

	it("does not issue one read syscall per 4 KiB when a transcript has no header patch", async () => {
		testDir = fs.mkdtempSync(path.join(os.tmpdir(), "gjc-resume-scan-cost-"));
		const cwd = path.join(testDir, "cwd");
		const sessionDir = path.join(testDir, "sessions");
		fs.mkdirSync(cwd, { recursive: true });
		fs.mkdirSync(sessionDir, { recursive: true });

		const sessionFile = writeTranscript(sessionDir, cwd, "scan-cost", 4 * 1024 * 1024);
		const size = fs.statSync(sessionFile).size;
		const counter = countReadsFor(sessionFile);

		const candidates = await SessionManager.listForResumePickerReadOnly(cwd, sessionDir);
		expect(candidates.find(item => item.id === "scan-cost")?.title).toBe("header-title");

		// Before the fix the reverse scan borrowed the caller's 4 KiB prefix
		// buffer, so a transcript with no header_patch cost size/4096 reads.
		const readsAtFourKiB = Math.ceil(size / 4096);
		expect(counter.reads()).toBeLessThan(readsAtFourKiB / 4);
	});

	it("keeps legacy metadata patches bounded when the star capability is absent", async () => {
		testDir = fs.mkdtempSync(path.join(os.tmpdir(), "gjc-resume-scan-legacy-patch-"));
		const cwd = path.join(testDir, "cwd");
		const sessionDir = path.join(testDir, "sessions");
		fs.mkdirSync(cwd, { recursive: true });
		fs.mkdirSync(sessionDir, { recursive: true });

		const sessionFile = writeTranscript(sessionDir, cwd, "scan-legacy-patch", 4 * 1024 * 1024, false);
		fs.appendFileSync(
			sessionFile,
			`${JSON.stringify({
				type: "header_patch",
				patch: { cwd, title: "renamed-without-star-state" },
			})}\n`,
		);
		const size = fs.statSync(sessionFile).size;
		const counter = countReadsFor(sessionFile);

		const candidates = await SessionManager.listForResumePickerReadOnly(cwd, sessionDir);
		expect(candidates.find(item => item.id === "scan-legacy-patch")).toMatchObject({
			title: "renamed-without-star-state",
			starred: false,
		});

		// A transcript without the star capability cannot contain star patches, so
		// resolving its title/cwd patch retains the pre-feature bounded behavior.
		expect(counter.bytes()).toBeLessThan(size / 2);
	});

	it("still stops early when every mutable header field is patched near EOF", async () => {
		testDir = fs.mkdtempSync(path.join(os.tmpdir(), "gjc-resume-scan-early-"));
		const cwd = path.join(testDir, "cwd");
		const sessionDir = path.join(testDir, "sessions");
		fs.mkdirSync(cwd, { recursive: true });
		fs.mkdirSync(sessionDir, { recursive: true });

		const sessionFile = writeTranscript(sessionDir, cwd, "scan-early", 4 * 1024 * 1024);
		fs.appendFileSync(
			sessionFile,
			`${[
				{
					type: "header_patch",
					patch: { cwd, title: "renamed-near-eof" },
				},
				{ type: "header_patch", patch: { starred: false } },
			]
				.map(record => JSON.stringify(record))
				.join("\n")}\n`,
		);
		const size = fs.statSync(sessionFile).size;
		const counter = countReadsFor(sessionFile);

		const candidates = await SessionManager.listForResumePickerReadOnly(cwd, sessionDir);
		expect(candidates.find(item => item.id === "scan-early")?.title).toBe("renamed-near-eof");

		// A patch in the final chunk must not drag the scan across the transcript.
		expect(counter.bytes()).toBeLessThan(size / 2);
	});

	it("recognizes star capability in an oversized header prefix fallback", async () => {
		testDir = fs.mkdtempSync(path.join(os.tmpdir(), "gjc-resume-scan-oversized-header-"));
		const cwd = path.join(testDir, "cwd");
		const sessionDir = path.join(testDir, "sessions");
		fs.mkdirSync(cwd, { recursive: true });
		fs.mkdirSync(sessionDir, { recursive: true });
		const sessionFile = path.join(sessionDir, "oversized-header.jsonl");
		const records = [
			{
				type: "session",
				version: CURRENT_SESSION_VERSION,
				starredPatchVersion: 1,
				id: "oversized-header",
				timestamp: "2026-08-16T00:00:00.000Z",
				cwd,
				title: "oversized",
				parentSession: "x".repeat(8 * 1024),
			},
			{
				type: "message",
				id: "message",
				parentId: null,
				timestamp: "2026-08-16T00:00:01.000Z",
				message: { role: "user", content: "hello", timestamp: 1 },
			},
			{ type: "header_patch", patch: { starred: true } },
		];
		fs.writeFileSync(sessionFile, `${records.map(record => JSON.stringify(record)).join("\n")}\n`);

		const candidates = await SessionManager.listForResumePickerReadOnly(cwd, sessionDir);
		expect(candidates.find(item => item.id === "oversized-header")).toMatchObject({
			title: "oversized",
			starred: true,
		});
	});
});
