import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as native from "@gajae-code/natives";
import * as managedStorage from "../src/session/internal/managed-session-storage";
import {
	listProjectSessionTranscriptFiles,
	readAuthorizedProjectSessionTranscript,
} from "../src/session/session-manager";

let cwd: string;
let root: string;
let candidate: string;
let transcript: string;

beforeEach(async () => {
	cwd = fs.realpathSync(await fs.promises.mkdtemp(path.join(os.tmpdir(), "gjc-project-transcript-windows-")));
	root = path.join(cwd, ".gjc");
	candidate = path.join(root, "sessions", "current.jsonl");
	await fs.promises.mkdir(path.dirname(candidate), { recursive: true });
	transcript = `${JSON.stringify({ type: "session", version: 3, id: "project-session", cwd })}\n`;
	await Bun.write(candidate, transcript);
	// Exercise the Windows branch without changing process.platform or claiming
	// that POSIX fixtures verify Windows filesystem/reparse-point semantics.
	vi.spyOn(os, "platform").mockReturnValue("win32");
	vi.spyOn(native, "openRecoveryFsRoot").mockImplementation(() => {
		throw new Error("unsupported_platform");
	});
});

afterEach(async () => {
	vi.restoreAllMocks();
	await fs.promises.rm(cwd, { recursive: true, force: true });
});

describe("Windows bounded project transcript reads", () => {
	it("reads explicit and discovered project transcripts through the shared bounded capture", () => {
		const capture = vi.spyOn(managedStorage, "captureManagedFilePrefixNoFollow");
		const limit = Buffer.byteLength(transcript);
		expect(readAuthorizedProjectSessionTranscript(root, candidate, limit)?.toString()).toBe(transcript);
		expect(listProjectSessionTranscriptFiles(cwd)).toEqual([candidate]);
		for (const discovered of listProjectSessionTranscriptFiles(cwd)) {
			expect(readAuthorizedProjectSessionTranscript(root, discovered, limit)?.toString()).toBe(transcript);
		}
		expect(capture).toHaveBeenCalledWith(candidate, limit + 1);
	});

	it("reads a simulated Darwin transcript without traversing /dev/fd", () => {
		vi.spyOn(os, "platform").mockReturnValue("darwin");
		const capture = vi.spyOn(managedStorage, "captureManagedFilePrefixNoFollow");
		const limit = Buffer.byteLength(transcript);
		expect(readAuthorizedProjectSessionTranscript(root, candidate, limit)?.toString()).toBe(transcript);
		expect(capture).toHaveBeenCalledTimes(1);
		expect(capture).toHaveBeenCalledWith(candidate, limit + 1);
	});

	it("does not turn other native root authorization failures into a fallback", () => {
		vi.spyOn(native, "openRecoveryFsRoot").mockImplementation(() => {
			throw new Error("io_error");
		});
		const capture = vi.spyOn(managedStorage, "captureManagedFilePrefixNoFollow");
		expect(() => readAuthorizedProjectSessionTranscript(root, candidate, 4096)).toThrow("io_error");
		expect(capture).not.toHaveBeenCalled();
	});

	it.each(["unsupported_platform", "io_error"])("handles native read result %s without bypassing authority", code => {
		const readManaged = vi.fn(() => ({ ok: false, code }));
		const close = vi.fn();
		const authority: native.RecoveryFsRoot = Object.create(native.RecoveryFsRoot.prototype, {
			readManaged: { value: readManaged },
			close: { value: close },
		});
		vi.spyOn(native, "openRecoveryFsRoot").mockReturnValue(authority);
		const capture = vi.spyOn(managedStorage, "captureManagedFilePrefixNoFollow");
		const result = readAuthorizedProjectSessionTranscript(root, candidate, 4096);
		if (code === "unsupported_platform") {
			expect(result?.toString()).toBe(transcript);
			expect(capture).toHaveBeenCalledWith(candidate, 4097);
		} else {
			expect(result).toBeUndefined();
			expect(capture).not.toHaveBeenCalled();
		}
		expect(readManaged).toHaveBeenCalledWith("sessions/current.jsonl");
		expect(close).toHaveBeenCalledTimes(1);
	});

	it("rejects oversized files before capture and rejects invalid bounds", () => {
		const capture = vi.spyOn(managedStorage, "captureManagedFilePrefixNoFollow");
		expect(
			readAuthorizedProjectSessionTranscript(root, candidate, Buffer.byteLength(transcript) - 1),
		).toBeUndefined();
		for (const limit of [-1, 0.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER]) {
			expect(readAuthorizedProjectSessionTranscript(root, candidate, limit)).toBeUndefined();
		}
		expect(capture).not.toHaveBeenCalled();
	});

	it("rejects paths outside the project transcript containers", () => {
		expect(readAuthorizedProjectSessionTranscript(root, path.join(cwd, "outside.jsonl"), 4096)).toBeUndefined();
		expect(
			readAuthorizedProjectSessionTranscript(root, path.join(root, "audit", "events.jsonl"), 4096),
		).toBeUndefined();
	});

	it("rejects hardlinked transcript files", async () => {
		await fs.promises.link(candidate, path.join(cwd, "hardlink.jsonl"));
		expect(() => readAuthorizedProjectSessionTranscript(root, candidate, 4096)).toThrow("file is unsafe");
	});

	it.skipIf(process.platform === "win32")("rejects a symbolic-link transcript before capture", async () => {
		const link = path.join(root, "sessions", "link.jsonl");
		await fs.promises.symlink(candidate, link);
		const capture = vi.spyOn(managedStorage, "captureManagedFilePrefixNoFollow");
		expect(() => readAuthorizedProjectSessionTranscript(root, link, 4096)).toThrow("file is unsafe");
		expect(capture).not.toHaveBeenCalled();
	});

	it("rejects a linked parent (a junction on Windows)", async () => {
		const link = path.join(root, "sessions", "redirect");
		await fs.promises.symlink(path.dirname(candidate), link, process.platform === "win32" ? "junction" : "dir");
		expect(() => readAuthorizedProjectSessionTranscript(root, path.join(link, "current.jsonl"), 4096)).toThrow(
			"parent is unsafe",
		);
	});

	it("rejects replacement between the initial file inspection and capture", async () => {
		const replacement = path.join(cwd, "replacement.jsonl");
		await Bun.write(replacement, transcript);
		const capture = managedStorage.captureManagedFilePrefixNoFollow;
		vi.spyOn(managedStorage, "captureManagedFilePrefixNoFollow").mockImplementation((pathname, limit) => {
			fs.renameSync(candidate, path.join(cwd, "retired.jsonl"));
			fs.renameSync(replacement, candidate);
			return capture(pathname, limit);
		});
		expect(() => readAuthorizedProjectSessionTranscript(root, candidate, 4096)).toThrow("file identity changed");
	});

	it("rejects file identity changes during descriptor capture", () => {
		const fstat = fs.fstatSync;
		let observations = 0;
		function changedFstat(fd: number, options?: fs.StatOptions & { bigint?: false }): fs.Stats;
		function changedFstat(fd: number, options: fs.StatOptions & { bigint: true }): fs.BigIntStats;
		function changedFstat(fd: number, options?: fs.StatOptions): fs.Stats | fs.BigIntStats;
		function changedFstat(fd: number, options?: fs.StatOptions): fs.Stats | fs.BigIntStats {
			const stat = fstat(fd, options);
			if (stat.isFile() && ++observations === 2) {
				stat.ino = typeof stat.ino === "bigint" ? stat.ino + 1n : stat.ino + 1;
			}
			return stat;
		}
		vi.spyOn(fs, "fstatSync").mockImplementation(changedFstat);
		expect(() => readAuthorizedProjectSessionTranscript(root, candidate, 4096)).toThrow("source_changed");
	});

	it("rejects parent replacement after capture even when the file retains its identity", () => {
		const capture = managedStorage.captureManagedFilePrefixNoFollow;
		vi.spyOn(managedStorage, "captureManagedFilePrefixNoFollow").mockImplementation((pathname, limit) => {
			const snapshot = capture(pathname, limit);
			const parent = path.dirname(candidate);
			const retired = path.join(root, "retired");
			fs.renameSync(parent, retired);
			fs.mkdirSync(parent);
			fs.renameSync(path.join(retired, path.basename(candidate)), candidate);
			return snapshot;
		});
		expect(() => readAuthorizedProjectSessionTranscript(root, candidate, 4096)).toThrow("parent identity changed");
	});

	it("reads an actual host transcript without platform or native spies", () => {
		vi.restoreAllMocks();
		const limit = Buffer.byteLength(transcript);
		expect(readAuthorizedProjectSessionTranscript(root, candidate, limit)?.toString()).toBe(transcript);
		const discovered = listProjectSessionTranscriptFiles(cwd);
		expect(discovered).toEqual([candidate]);
		expect(readAuthorizedProjectSessionTranscript(root, discovered[0]!, limit)?.toString()).toBe(transcript);
		expect(readAuthorizedProjectSessionTranscript(root, candidate, limit - 1)).toBeUndefined();
	});
});
