import { afterEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { resolveEquivalentPath } from "../src/dirs";

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

		expect(resolveEquivalentPath(inputPath)).toBe(inputPath);
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

		expect(resolveEquivalentPath(inputPath)).toBe(inputPath);
	});
});
