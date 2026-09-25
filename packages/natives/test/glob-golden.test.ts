import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { FileType, glob, type GlobMatch, type GlobOptions } from "../native/index.js";

type GoldenScenario = { matchCount: number; sha256: string };
type GlobGolden = {
	scenarios: {
		visible: GoldenScenario;
		hidden: GoldenScenario;
		all: GoldenScenario;
		symlinks: GoldenScenario;
		large: GoldenScenario;
	};
};
type Row = [string, number];

const fixtureRoot = path.join(import.meta.dir, "fixtures", `.glob-golden-${crypto.randomUUID()}`);
const goldensPath = path.join(import.meta.dir, "fixtures", "goldens", "glob", "pre-sync.json");
let golden: GlobGolden;
let symlinksAvailable = false;

async function createFixtureTree() {
	await fs.mkdir(path.join(fixtureRoot, "large"), { recursive: true });
	await fs.mkdir(path.join(fixtureRoot, "dir"), { recursive: true });
	await fs.mkdir(path.join(fixtureRoot, "ignored-dir"), { recursive: true });
	await fs.mkdir(path.join(fixtureRoot, "node_modules", "pkg"), { recursive: true });
	await fs.mkdir(path.join(fixtureRoot, ".git"), { recursive: true });
	await fs.writeFile(path.join(fixtureRoot, ".gitignore"), "ignored.txt\nignored-dir/\n");
	await fs.writeFile(path.join(fixtureRoot, "visible.txt"), "visible\n");
	await fs.writeFile(path.join(fixtureRoot, "ignored.txt"), "ignored\n");
	await fs.writeFile(path.join(fixtureRoot, ".hidden.txt"), "hidden\n");
	await fs.writeFile(path.join(fixtureRoot, "dir", "nested.txt"), "nested\n");
	await fs.writeFile(path.join(fixtureRoot, "ignored-dir", "hidden.txt"), "ignored\n");
	await fs.writeFile(path.join(fixtureRoot, "node_modules", "pkg", "index.js"), "module\n");
	await fs.writeFile(path.join(fixtureRoot, "visible-target.txt"), "target\n");
	for (let index = 0; index < 512; index++) {
		await fs.writeFile(
			path.join(fixtureRoot, "large", `item-${String(index).padStart(3, "0")}.txt`),
			"x\n",
		);
	}
	if (process.platform !== "win32") {
		await fs.symlink("visible-target.txt", path.join(fixtureRoot, "link-file"));
		await fs.symlink("dir", path.join(fixtureRoot, "link-dir"));
		symlinksAvailable = true;
	}
}

function normalizedRows(matches: GlobMatch[], omitSymlinks: boolean): Row[] {
	return matches
		.filter(entry => !omitSymlinks || entry.fileType !== FileType.Symlink)
		.map(({ path: entryPath, fileType }) => [entryPath, fileType as number] as Row)
		.sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
}

function summary(rows: Row[]): GoldenScenario {
	return {
		matchCount: rows.length,
		sha256: createHash("sha256").update(JSON.stringify(rows)).digest("hex"),
	};
}

async function runGlob(options: Partial<Omit<GlobOptions, "path" | "pattern">>) {
	const result = await glob({ path: fixtureRoot, pattern: "**/*", recursive: true, cache: false, ...options });
	expect(result.totalMatches).toBe(result.matches.length);
	return result;
}

beforeAll(async () => {
	golden = JSON.parse(await fs.readFile(goldensPath, "utf8")) as GlobGolden;
	await createFixtureTree();
});

afterAll(async () => {
	await fs.rm(fixtureRoot, { recursive: true, force: true });
});

describe("glob pre-sync differential goldens", () => {
	it("matches visible, ignore-aware paths on a tree with a large directory", async () => {
		const result = await runGlob({ hidden: false, gitignore: true });
		expect(summary(normalizedRows(result.matches, true))).toEqual(golden.scenarios.visible);
	});

	it("matches hidden entries without crossing gitignore rules", async () => {
		const result = await runGlob({ hidden: true, gitignore: true });
		expect(summary(normalizedRows(result.matches, true))).toEqual(golden.scenarios.hidden);
	});

	it("matches ignored files and node_modules when requested", async () => {
		const result = await runGlob({ hidden: true, gitignore: false, includeNodeModules: true });
		expect(summary(normalizedRows(result.matches, true))).toEqual(golden.scenarios.all);
	});

	it.skipIf(process.platform === "win32")(
		"matches file and directory symlink entries on POSIX filesystems",
		async () => {
			expect(symlinksAvailable).toBe(true);
			const result = await runGlob({ hidden: true, gitignore: true, fileType: FileType.Symlink });
			expect(summary(normalizedRows(result.matches, false))).toEqual(golden.scenarios.symlinks);
		},
	);

	it("matches the full 512-file large-directory fixture at the requested depth", async () => {
		const result = await glob({
			path: fixtureRoot,
			pattern: "large/*.txt",
			recursive: false,
			hidden: true,
			gitignore: true,
			cache: false,
			fileType: FileType.File,
		});
		expect(result.totalMatches).toBe(result.matches.length);
		expect(summary(normalizedRows(result.matches, false))).toEqual(golden.scenarios.large);
	});
});
