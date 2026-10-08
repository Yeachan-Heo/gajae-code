import { afterEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { directoryCaseSensitive } from "@gajae-code/natives";
import { resolveEquivalentPath, stablePathKey } from "../src/dirs";

describe("issue #935 path equivalence", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("falls back to the lexical project path when realpath fails", () => {
		const inputPath = path.resolve("/sessions/link-project");
		const realpathSpy = vi.spyOn(fs, "realpathSync").mockImplementation((() => {
			const error = new Error("ENOENT: no such file or directory, realpath");
			(error as NodeJS.ErrnoException).code = "ENOENT";
			throw error;
		}) as unknown as typeof fs.realpathSync);

		expect(resolveEquivalentPath(inputPath)).toBe(path.resolve(inputPath));
		expect(realpathSpy).toHaveBeenCalledWith(inputPath);
	});
});

describe("issue #6446 Windows path casing", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("preserves the filesystem's canonical path spelling", () => {
		const inputPath = path.resolve("C:/Users/User/Project/session.jsonl");
		const canonicalPath = "C:\\Users\\User\\Project\\session.jsonl";
		vi.spyOn(fs, "realpathSync").mockImplementation((() => canonicalPath) as unknown as typeof fs.realpathSync);

		expect(resolveEquivalentPath(inputPath)).toBe(canonicalPath);
	});

	it("preserves unresolved path spelling instead of folding potentially case-sensitive names", () => {
		const inputPath = path.resolve("C:/Users/User/Project/session.jsonl");
		vi.spyOn(fs, "realpathSync").mockImplementation((() => {
			const error = new Error("ENOENT: no such file or directory, realpath");
			(error as NodeJS.ErrnoException).code = "ENOENT";
			throw error;
		}) as unknown as typeof fs.realpathSync);

		expect(resolveEquivalentPath(inputPath)).toBe(path.resolve(inputPath));
	});

	it("canonicalizes existing Windows short-name aliases", () => {
		if (process.platform !== "win32") return;

		const shortPath = "C:\\sessions\\SESSION~1.JSONL";
		const canonicalPath = "C:\\sessions\\long-session-name.jsonl";
		vi.spyOn(fs, "lstatSync").mockImplementation((() => ({})) as unknown as typeof fs.lstatSync);
		vi.spyOn(fs, "realpathSync").mockImplementation((() => canonicalPath) as unknown as typeof fs.realpathSync);
		vi.spyOn(fs, "statSync").mockImplementation((() => ({ dev: 1n, ino: 2n })) as unknown as typeof fs.statSync);

		expect(stablePathKey(shortPath)).toBe(stablePathKey(canonicalPath));
	});

	it("uses the parent directory's case rule for missing transcript names", () => {
		if (process.platform !== "win32") return;

		const configuredRoot = process.env.GJC_TEST_CASE_SENSITIVE_DIRECTORY;
		if (configuredRoot) expect(directoryCaseSensitive(configuredRoot)).toBe(true);
		const directory = fs.mkdtempSync(path.join(configuredRoot ?? os.tmpdir(), "gjc-session-key-"));
		try {
			const sensitivity = directoryCaseSensitive(directory);
			const firstPath = path.join(directory, "Session.jsonl");
			const secondPath = path.join(directory, "session.jsonl");
			if (sensitivity === true) {
				expect(stablePathKey(firstPath)).not.toBe(stablePathKey(secondPath));
			} else if (sensitivity === false) {
				expect(stablePathKey(firstPath)).toBe(stablePathKey(secondPath));
			} else {
				expect(stablePathKey(firstPath)).not.toBe(stablePathKey(secondPath));
			}
		} finally {
			fs.rmSync(directory, { recursive: true, force: true });
		}
	});

	it.skipIf(!process.env.GJC_TEST_CASE_SENSITIVE_DIRECTORY)(
		"keeps existing case-distinct transcript files separate in a case-sensitive directory",
		() => {
			if (process.platform !== "win32") return;
			const directory = fs.mkdtempSync(
				path.join(process.env.GJC_TEST_CASE_SENSITIVE_DIRECTORY!, "gjc-session-key-existing-"),
			);
			try {
				expect(directoryCaseSensitive(directory)).toBe(true);
				const firstPath = path.join(directory, "Session.jsonl");
				const secondPath = path.join(directory, "session.jsonl");
				fs.writeFileSync(firstPath, "first");
				fs.writeFileSync(secondPath, "second", { flag: "wx" });
				expect(stablePathKey(firstPath)).not.toBe(stablePathKey(secondPath));
			} finally {
				fs.rmSync(directory, { recursive: true, force: true });
			}
		},
	);

	it("folds missing UNC paths without querying the remote share", () => {
		if (process.platform !== "win32") return;

		vi.spyOn(fs, "lstatSync").mockImplementation((() => {
			throw new Error("ENOENT");
		}) as unknown as typeof fs.lstatSync);
		vi.spyOn(fs, "realpathSync").mockImplementation((() => {
			throw new Error("ENOENT");
		}) as unknown as typeof fs.realpathSync);
		vi.spyOn(fs, "statSync").mockImplementation((() => {
			throw new Error("network unavailable");
		}) as unknown as typeof fs.statSync);

		expect(stablePathKey(String.raw`\\server\share\Sessions\session.jsonl`)).toBe(
			stablePathKey(String.raw`\\SERVER\SHARE\sessions\SESSION.JSONL`),
		);
		expect(stablePathKey(String.raw`\\?\UNC\server\share\Sessions\session.jsonl`)).toBe(
			stablePathKey(String.raw`\\?\UNC\SERVER\SHARE\sessions\SESSION.JSONL`),
		);
	});
});
