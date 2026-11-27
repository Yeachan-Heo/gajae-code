import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { checkBiomeMaxSize, formatOversizedReport, matchesBiomeIncludes } from "./check-biome-max-size";
import { safeRm } from "./safe-cleanup";

let root = "";

beforeEach(async () => {
	root = await fs.mkdtemp(path.join(os.tmpdir(), "check-biome-max-size-"));
});

afterEach(async () => {
	if (root) await safeRm(root, { recursive: true, force: true });
	root = "";
});

async function writeFixture(files: Record<string, string>): Promise<string[]> {
	for (const [relativePath, content] of Object.entries(files)) {
		await Bun.write(path.join(root, relativePath), content);
	}
	return Object.keys(files);
}

function rootConfig(files: Record<string, unknown>, extra: Record<string, unknown> = {}): string {
	return JSON.stringify({ files, ...extra });
}

async function check(files: Record<string, string>) {
	const listed = await writeFixture(files);
	return checkBiomeMaxSize({ root, listFiles: async () => listed });
}

describe("checkBiomeMaxSize", () => {
	test("reports an included file at files.maxSize, which Biome already skips", async () => {
		const result = await check({
			"biome.json": rootConfig({ maxSize: 1000, includes: ["packages/*/src/**/*.ts"] }),
			"packages/a/src/big.ts": "x".repeat(1000),
			"packages/a/src/small.ts": "x".repeat(999),
		});
		expect(result.oversized).toEqual([
			{ path: "packages/a/src/big.ts", size: 1000, limit: 1000, config: "biome.json" },
		]);
		// biome.json itself plus the two sources.
		expect(result.checkedFiles).toBe(3);
	});

	test("passes when every processed file is within the limit", async () => {
		const result = await check({
			"biome.json": rootConfig({ maxSize: 1000, includes: ["packages/*/src/**/*.ts"] }),
			"packages/a/src/small.ts": "x".repeat(10),
		});
		expect(result.oversized).toEqual([]);
	});

	test("ignores oversized files that files.includes does not select or explicitly negates", async () => {
		const result = await check({
			"biome.json": rootConfig({
				maxSize: 1000,
				includes: ["packages/*/src/**/*.ts", "!packages/a/src/huge.ts"],
			}),
			"packages/a/src/huge.ts": "x".repeat(5000),
			"docs/huge.md": "x".repeat(5000),
			"packages/a/src/models.json": "x".repeat(5000),
		});
		expect(result.oversized).toEqual([]);
	});

	test("rejects a root biome.json without an explicit files.maxSize", async () => {
		await expect(
			check({
				"biome.json": rootConfig({ includes: ["**/*.ts"] }),
				"src/a.ts": "x",
			}),
		).rejects.toThrow("must set files.maxSize explicitly");
	});

	test("applies a matching override files.maxSize instead of the global limit", async () => {
		const result = await check({
			"biome.json": rootConfig(
				{ maxSize: 1000, includes: ["src/**/*.ts"] },
				{ overrides: [{ includes: ["src/generated/**"], files: { maxSize: 10000 } }] },
			),
			"src/generated/table.ts": "x".repeat(5000),
			"src/hand.ts": "x".repeat(1001),
		});
		expect(result.oversized.map(entry => [entry.path, entry.limit])).toEqual([["src/hand.ts", 1000]]);
	});

	test("ignores an override without includes, which Biome does not apply", async () => {
		const result = await check({
			"biome.json": rootConfig(
				{ maxSize: 1000, includes: ["src/**/*.ts"] },
				{ overrides: [{ files: { maxSize: 10000 } }] },
			),
			"src/big.ts": "x".repeat(5000),
		});
		expect(result.oversized.map(entry => [entry.path, entry.limit])).toEqual([["src/big.ts", 1000]]);
	});

	test("labels a nested biome.jsonc with its real file name", async () => {
		const result = await check({
			"biome.json": rootConfig({ maxSize: 1000, includes: ["src/**/*.ts"] }),
			"vendor/biome.jsonc": JSON.stringify({ root: false, files: { maxSize: 2000 } }),
			"vendor/src/big.ts": "x".repeat(2001),
		});
		expect(result.oversized).toEqual([
			{ path: "vendor/src/big.ts", size: 2001, limit: 2000, config: "vendor/biome.jsonc" },
		]);
	});

	test("checks files under a nested biome.json against that config's limit", async () => {
		const result = await check({
			"biome.json": rootConfig({ maxSize: 1000, includes: ["src/**/*.ts", "!vendor/**"] }),
			"vendor/biome.json": JSON.stringify({ root: false, files: { maxSize: 2000 } }),
			"vendor/src/ok.ts": "x".repeat(1500),
			"vendor/src/big.ts": "x".repeat(2001),
			"vendor/README.md": "x".repeat(5000),
		});
		expect(result.oversized).toEqual([
			{ path: "vendor/src/big.ts", size: 2001, limit: 2000, config: "vendor/biome.json" },
		]);
	});

	test("skips listed paths that no longer exist in the working tree", async () => {
		await writeFixture({ "biome.json": rootConfig({ maxSize: 1000, includes: ["src/**/*.ts"] }) });
		const result = await checkBiomeMaxSize({ root, listFiles: async () => ["biome.json", "src/deleted.ts"] });
		expect(result.checkedFiles).toBe(1);
		expect(result.oversized).toEqual([]);
	});
});

describe("matchesBiomeIncludes", () => {
	test("lets the last matching pattern win", () => {
		const includes = ["packages/**/*.ts", "!packages/**/vendor/**", "packages/a/vendor/keep.ts"];
		expect(matchesBiomeIncludes("packages/a/src/x.ts", includes)).toBe(true);
		expect(matchesBiomeIncludes("packages/a/vendor/drop.ts", includes)).toBe(false);
		expect(matchesBiomeIncludes("packages/a/vendor/keep.ts", includes)).toBe(true);
	});
});

describe("formatOversizedReport", () => {
	test("names each file, its size, the limit and the remedies", () => {
		const report = formatOversizedReport([{ path: "src/big.ts", size: 1001, limit: 1000, config: "biome.json" }]);
		expect(report).toContain("src/big.ts: 1001 bytes >= 1000 bytes (limit from biome.json)");
		expect(report).toContain("split the file");
		expect(report).toContain("raise files.maxSize");
		expect(report).toContain('"!<path>" entry in files.includes');
	});
});
