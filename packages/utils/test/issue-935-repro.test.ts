import { afterEach, describe, expect, it, vi } from "bun:test";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as fsPromises from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { directoryCaseSensitive } from "@gajae-code/natives";
import { resolveEquivalentPath } from "../src/dirs";
import { stablePathKey } from "../src/path-identity";

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

	it("canonicalizes existing Windows short-name aliases", async () => {
		if (process.platform !== "win32") return;

		const directory = await fsPromises.mkdtemp(path.join(os.tmpdir(), "gjc-short-name-key-"));
		try {
			const shortPath = path.join(directory, "SESSION~1.JSONL");
			const canonicalPath = path.join(directory, "long-session-name.jsonl");
			const sensitivity = directoryCaseSensitive(directory);
			vi.spyOn(fs, "lstatSync").mockImplementation((() => ({})) as unknown as typeof fs.lstatSync);
			vi.spyOn(fs, "realpathSync").mockImplementation((() => canonicalPath) as unknown as typeof fs.realpathSync);
			if (sensitivity === false) {
				expect(stablePathKey(shortPath)).toBe(stablePathKey(canonicalPath));
			} else {
				expect(stablePathKey(shortPath)).not.toBe(stablePathKey(canonicalPath));
			}
		} finally {
			await fsPromises.rm(directory, { recursive: true, force: true });
		}
	});

	it("uses the parent directory's case rule for missing transcript names", async () => {
		if (process.platform !== "win32") return;

		const configuredRoot = process.env.GJC_TEST_CASE_SENSITIVE_DIRECTORY;
		if (configuredRoot) expect(directoryCaseSensitive(configuredRoot)).toBe(true);
		const directory = await fsPromises.mkdtemp(path.join(configuredRoot ?? os.tmpdir(), "gjc-session-key-"));
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
			expect(stablePathKey(firstPath)).toBe(stablePathKey(path.join(directory, "Session.jsonl.")));
			expect(stablePathKey(firstPath)).toBe(stablePathKey(path.join(directory, "Session.jsonl ")));

			const resolvedDirectory = path.win32.resolve(directory);
			const extendedDirectory = resolvedDirectory.startsWith("\\\\?\\")
				? resolvedDirectory
				: resolvedDirectory.startsWith("\\\\")
					? `\\\\?\\UNC\\${resolvedDirectory.slice(2)}`
					: `\\\\?\\${resolvedDirectory}`;
			const extendedPath = `${extendedDirectory}\\Session.jsonl`;
			expect(stablePathKey(extendedPath)).not.toBe(stablePathKey(`${extendedPath}.`));
		} finally {
			await fsPromises.rm(directory, { recursive: true, force: true });
		}
	});

	it("uses ordinal folding without collapsing expanded Unicode casing", async () => {
		if (process.platform !== "win32") return;

		const directory = await fsPromises.mkdtemp(path.join(os.tmpdir(), "gjc-session-key-unicode-"));
		try {
			expect(directoryCaseSensitive(directory)).toBe(false);
			const dottedCapitalIPath = path.join(directory, "İ.jsonl");
			const dottedLowercaseIPath = path.join(directory, "i̇.jsonl");
			expect(stablePathKey(dottedCapitalIPath)).not.toBe(stablePathKey(dottedLowercaseIPath));
			expect(stablePathKey(path.join(directory, "Session.jsonl"))).toBe(
				stablePathKey(path.join(directory, "session.jsonl")),
			);
			expect(stablePathKey(path.join(directory, "Session.jsonl"))).toBe(
				stablePathKey(path.join(directory, "Session.jsonl.")),
			);
		} finally {
			await fsPromises.rm(directory, { recursive: true, force: true });
		}
	});

	it("preserves ancestor casing for zero-inode fallback keys", async () => {
		if (process.platform !== "win32") return;

		const directory = await fsPromises.mkdtemp(path.join(os.tmpdir(), "gjc-session-key-fallback-"));
		try {
			expect(directoryCaseSensitive(directory)).toBe(false);
			vi.spyOn(fs, "statSync").mockImplementation((() => ({ dev: 0n, ino: 0n })) as unknown as typeof fs.statSync);
			const realpathSpy = vi.spyOn(fs, "realpathSync").mockImplementation((() => {
				throw new Error("canonical parent unavailable");
			}) as unknown as typeof fs.realpathSync);
			const dottedCapitalIPath = path.join(directory, "İ.jsonl");
			const dottedLowercaseIPath = path.join(directory, "i̇.jsonl");
			expect(stablePathKey(dottedCapitalIPath)).not.toBe(stablePathKey(dottedLowercaseIPath));
			expect(stablePathKey(path.join(directory, "Session.jsonl"))).toBe(
				stablePathKey(path.join(directory, "session.jsonl")),
			);
			const alternateParentSpelling = path.join(path.dirname(directory), path.basename(directory).toUpperCase());
			expect(stablePathKey(path.join(directory, "Session.jsonl"))).not.toBe(
				stablePathKey(path.join(alternateParentSpelling, "Session.jsonl")),
			);
			expect(realpathSpy).toHaveBeenCalled();
			expect(stablePathKey(path.join(directory, "Session.jsonl"))).toBe(
				stablePathKey(path.join(directory, "Session.jsonl.")),
			);
		} finally {
			await fsPromises.rm(directory, { recursive: true, force: true });
		}
	});

	it.skipIf(!process.env.GJC_TEST_CASE_SENSITIVE_DIRECTORY)(
		"keeps existing case-distinct transcript files separate in a case-sensitive directory",
		async () => {
			if (process.platform !== "win32") return;
			const directory = await fsPromises.mkdtemp(
				path.join(process.env.GJC_TEST_CASE_SENSITIVE_DIRECTORY!, "gjc-session-key-existing-"),
			);
			try {
				expect(directoryCaseSensitive(directory)).toBe(true);
				const firstPath = path.join(directory, "Session.jsonl");
				const secondPath = path.join(directory, "session.jsonl");
				await Bun.write(firstPath, "first");
				await Bun.write(secondPath, "second");
				expect(stablePathKey(firstPath)).not.toBe(stablePathKey(secondPath));
			} finally {
				await fsPromises.rm(directory, { recursive: true, force: true });
			}
		},
	);

	it("preserves missing UNC name casing when share semantics are unavailable", () => {
		if (process.platform !== "win32") return;

		const lstat = vi.spyOn(fs, "lstatSync").mockImplementation((() => {
			throw new Error("ENOENT");
		}) as unknown as typeof fs.lstatSync);
		const realpath = vi.spyOn(fs, "realpathSync").mockImplementation((() => {
			throw new Error("ENOENT");
		}) as unknown as typeof fs.realpathSync);
		vi.spyOn(fs, "statSync").mockImplementation((() => {
			throw new Error("network unavailable");
		}) as unknown as typeof fs.statSync);

		expect(stablePathKey(String.raw`\\server\share\Sessions\session.jsonl`)).not.toBe(
			stablePathKey(String.raw`\\SERVER\SHARE\sessions\SESSION.JSONL`),
		);
		expect(stablePathKey(String.raw`\\?\UNC\server\share\Sessions\session.jsonl`)).not.toBe(
			stablePathKey(String.raw`\\?\UNC\SERVER\SHARE\sessions\SESSION.JSONL`),
		);
		expect(lstat).not.toHaveBeenCalled();
		expect(realpath).not.toHaveBeenCalled();
	});

	it.skipIf(process.platform !== "win32" || !process.env.GJC_TEST_UNC_CASE_SENSITIVE_DIRECTORY)(
		"keeps distinct transcript entries on a case-sensitive UNC share",
		async () => {
			const directory = process.env.GJC_TEST_UNC_CASE_SENSITIVE_DIRECTORY!;
			expect(path.win32.normalize(directory).startsWith("\\\\")).toBe(true);
			expect(directoryCaseSensitive(directory)).toBe(true);
			const stem = `gjc-unc-${crypto.randomUUID()}`;
			const firstPath = path.join(directory, `${stem}-Session.jsonl`);
			const secondPath = path.join(directory, `${stem}-session.jsonl`);
			try {
				await Bun.write(firstPath, "upper");
				await Bun.write(secondPath, "lower");
				expect(stablePathKey(firstPath)).not.toBe(stablePathKey(secondPath));
			} finally {
				await fsPromises.rm(firstPath, { force: true });
				await fsPromises.rm(secondPath, { force: true });
			}
		},
	);

	it.skipIf(process.platform !== "win32" || !process.env.GJC_TEST_UNC_CASE_INSENSITIVE_DIRECTORY)(
		"folds transcript aliases on a case-insensitive UNC share",
		async () => {
			const directory = process.env.GJC_TEST_UNC_CASE_INSENSITIVE_DIRECTORY!;
			expect(path.win32.normalize(directory).startsWith("\\\\")).toBe(true);
			expect(directoryCaseSensitive(directory)).toBe(false);
			const stem = `gjc-unc-${crypto.randomUUID()}`;
			const firstPath = path.join(directory, `${stem}-Session.jsonl`);
			const aliasPath = path.join(directory, `${stem}-session.jsonl`);
			try {
				await Bun.write(firstPath, "session");
				expect(stablePathKey(firstPath)).toBe(stablePathKey(aliasPath));
			} finally {
				await fsPromises.rm(firstPath, { force: true });
			}
		},
	);
});
