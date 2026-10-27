import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { isoDiff, isoIsUnavailableError } from "../native/index.js";

describe("iso diff golden", () => {
	it("matches the pre-sync plain-tree output", async () => {
		const fixtureRoot = path.join(import.meta.dir, "fixtures", "goldens", "pi-iso", "plain");
		const golden = JSON.parse(await fs.readFile(path.join(fixtureRoot, "iso-diff.json"), "utf8"));
		const actual = await isoDiff(path.join(fixtureRoot, "lower"), path.join(fixtureRoot, "merged"));

		expect(actual).toEqual(golden.diff);
	});

	it("recognizes unavailable errors with and without a leading message", () => {
		expect(isoIsUnavailableError("ISO_UNAVAILABLE: backend missing")).toBe(true);
		expect(isoIsUnavailableError("前段: ISO_UNAVAILABLE: backend missing")).toBe(true);
		expect(isoIsUnavailableError("unrelated failure")).toBe(false);
	});
});
