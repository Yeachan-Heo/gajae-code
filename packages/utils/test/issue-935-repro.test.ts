import { afterEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
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
		vi.spyOn(fs, "readdirSync").mockImplementation((() => [
			"long-session-name.jsonl",
		]) as unknown as typeof fs.readdirSync);

		expect(stablePathKey(shortPath)).toBe(stablePathKey(canonicalPath));
	});

	it("keeps distinct existing Windows entries separate when names differ by case", () => {
		if (process.platform !== "win32") return;

		const firstPath = "C:\\sessions\\Session.jsonl";
		const secondPath = "C:\\sessions\\session.jsonl";
		vi.spyOn(fs, "lstatSync").mockImplementation((() => ({})) as unknown as typeof fs.lstatSync);
		vi.spyOn(fs, "realpathSync").mockImplementation(
			((inputPath: string) => inputPath) as unknown as typeof fs.realpathSync,
		);
		vi.spyOn(fs, "statSync").mockImplementation((() => ({ dev: 1n, ino: 2n })) as unknown as typeof fs.statSync);
		vi.spyOn(fs, "readdirSync").mockImplementation((() => [
			"Session.jsonl",
			"session.jsonl",
		]) as unknown as typeof fs.readdirSync);

		expect(stablePathKey(firstPath)).not.toBe(stablePathKey(secondPath));
	});
});
