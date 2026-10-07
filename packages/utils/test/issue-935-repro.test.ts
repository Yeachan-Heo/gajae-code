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

	it("normalizes path casing on Windows for consistent path comparison", () => {
		// Simulate Windows behavior: resolveEquivalentPath should lowercase paths
		if (process.platform !== "win32") return;

		// Mock realpathSync to return an uppercase path
		const upperPath = "C:\\Users\\User\\Project\\session.jsonl";
		vi.spyOn(fs, "realpathSync").mockImplementation((() => upperPath) as unknown as typeof fs.realpathSync);

		const result = resolveEquivalentPath(upperPath);

		// Result should be lowercased
		expect(result).toBe(upperPath.toLowerCase());
	});

	it("lowercases paths when realpath fails on Windows", () => {
		if (process.platform !== "win32") return;

		const upperPath = "C:\\Users\\User\\Project\\session.jsonl";
		vi.spyOn(fs, "realpathSync").mockImplementation((() => {
			const error = new Error("ENOENT: no such file or directory, realpath");
			(error as NodeJS.ErrnoException).code = "ENOENT";
			throw error;
		}) as unknown as typeof fs.realpathSync);

		const result = resolveEquivalentPath(upperPath);

		// Result should still be lowercased even when realpath fails
		expect(result).toBe(upperPath.toLowerCase());
	});
});
