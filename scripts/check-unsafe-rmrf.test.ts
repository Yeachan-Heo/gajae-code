import { describe, expect, test } from "bun:test";
import * as path from "node:path";
import { isFixturePath, scanRepository, scanUnsafeRecursiveRemovals } from "./check-unsafe-rmrf";

function violationsOf(text: string, filePath = "packages/coding-agent/test/example.test.ts") {
	return scanUnsafeRecursiveRemovals([{ path: filePath, text }]);
}

describe("check-unsafe-rmrf scanner", () => {
	test("flags a HOME-seam file with a raw recursive rmSync", () => {
		const violations = violationsOf(
			[
				'import * as os from "node:os";',
				"process.env.HOME = tempHome;",
				"afterEach(() => {",
				"	fs.rmSync(tempHome, { recursive: true, force: true });",
				"});",
			].join("\n"),
		);
		expect(violations).toHaveLength(1);
		expect(violations[0]?.line).toBe(4);
		expect(violations[0]?.message).toContain("safeRm");
	});

	test("flags a HOME-seam file with raw fs.rm and fs.promises.rm", () => {
		for (const call of [
			"await fs.rm(tempDir, { recursive: true, force: true });",
			"await fs.promises.rm(tempDir, { recursive: true, force: true });",
			"fs.rmdirSync(tempDir, { recursive: true });",
		]) {
			const violations = violationsOf(['process.env.HOME = home;', call].join("\n"));
			expect(violations).toHaveLength(1);
		}
	});

	test("flags an os.homedir spy seam", () => {
		const violations = violationsOf(
			['vi.spyOn(os, "homedir").mockReturnValue(home);', "await fs.rm(home, { recursive: true, force: true });"].join(
				"\n",
			),
		);
		expect(violations).toHaveLength(1);
	});

	test("flags named and aliased recursive deletion imports", () => {
		const violations = violationsOf(
			[
				'import { rm as removeTree } from "node:fs/promises";',
				"process.env.HOME = home;",
				"await removeTree(home, { recursive: true, force: true });",
			].join("\n"),
		);
		expect(violations).toHaveLength(1);
		expect(violations[0]?.line).toBe(3);
	});

	test("does not flag files without a HOME seam", () => {
		expect(
			violationsOf(["await fs.rm(tempDir, { recursive: true, force: true });"].join("\n")),
		).toEqual([]);
	});

	test("does not flag migrated safe-contract calls", () => {
		expect(
			violationsOf(
				[
					'import { safeRm } from "../../../scripts/safe-cleanup";',
					"process.env.HOME = home;",
					"await safeRm(home, { recursive: true, force: true });",
				].join("\n"),
			),
		).toEqual([]);
	});

	test("does not flag non-removal recursive calls such as mkdir", () => {
		expect(
			violationsOf(["process.env.HOME = home;", "fs.mkdirSync(dir, { recursive: true });"].join("\n")),
		).toEqual([]);
	});

	test("does not flag non-recursive removals", () => {
		expect(
			violationsOf(["process.env.HOME = home;", "await fs.rm(file, { force: true });"].join("\n")),
		).toEqual([]);
	});

	test("flags shell template and spawn-array force-recursive rm", () => {
		expect(violationsOf(["process.env.HOME = home;", "await $`rm -rf ${dir}`;"].join("\n"))).toHaveLength(1);
		expect(
			violationsOf(['process.env.HOME = home;', 'Bun.spawn(["rm", "-rf", dir]);'].join("\n")),
		).toHaveLength(1);
	});

	test("flags computed HOME seams and deletion methods", () => {
		const violations = violationsOf(
			['process.env["HOME"] = home;', 'fs["rmSync"](home, { recursive: true, force: true });'].join("\n"),
		);
		expect(violations).toHaveLength(1);
		expect(violations[0]?.line).toBe(2);
	});

	test("flags separated shell recursive and force flags", () => {
		expect(violationsOf(["process.env.HOME = home;", "await $`rm -r -f ${dir}`;"].join("\n"))).toHaveLength(1);
		expect(
			violationsOf(['process.env.HOME = home;', 'Bun.spawn(["rm", "-r", "-f", dir]);'].join("\n")),
		).toHaveLength(1);
	});

	test("does not flag bare blocked-command fixture strings", () => {
		expect(
			violationsOf(['process.env.HOME = home;', 'const blocked = ["rm -rf .gjc", "echo verdict"];'].join("\n")),
		).toEqual([]);
	});

	test("flags multi-line rm calls within the recursive window", () => {
		const violations = violationsOf(
			["process.env.HOME = home;", "await fs.rm(", "\ttempDir,", "\t{ recursive: true, force: true },", ");"].join(
				"\n",
			),
		);
		expect(violations).toHaveLength(1);
		expect(violations[0]?.line).toBe(2);
	});

	test("excludes fixture paths from scanning", () => {
		const text = 'process.env.HOME = home;\nfs.rmSync(home, { recursive: true, force: true });';
		expect(violationsOf(text, "packages/coding-agent/test/test-fixtures/guard-violation.ts")).toEqual([]);
		expect(violationsOf(text, "scripts/test-fixtures/guard-violation.ts")).toEqual([]);
	});

	test("isFixturePath recognizes fixture locations", () => {
		expect(isFixturePath("a/fixtures/x.ts")).toBe(true);
		expect(isFixturePath("a/test-fixtures/x.ts")).toBe(true);
		expect(isFixturePath("packages/coding-agent/test/example.test.ts")).toBe(false);
	});
});

describe("check-unsafe-rmrf repository scan", () => {
	test("the repository is clean", async () => {
		const violations = await scanRepository(path.join(import.meta.dir, ".."));
		expect(violations).toEqual([]);
	}, 60_000);
});
