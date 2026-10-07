import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { FileType, fuzzyFind, listWorkspace } from "../native/index.js";

type FuzzyRow = [string, boolean, number];
type WorkspaceRow = [string, number, number | null];
type FuzzySummary = { matchCount: number; totalMatches: number; sha256: string };
type WorkspaceSummary = {
	entryCount: number;
	agentsMdFiles: string[];
	truncated: boolean;
	sha256: string;
};
type SymlinkSummary = { matchCount: number; fileSymlinkIncluded: boolean; sha256: string };
type Golden = {
	source: string;
	normalization: string;
	scenarios: {
		fuzzyVisible: FuzzySummary;
		fuzzyAll: FuzzySummary;
		fuzzySymlinks: SymlinkSummary;
		workspaceVisible: WorkspaceSummary;
		workspaceAll: WorkspaceSummary;
		workspaceSymlinks: { entryCount: number; sha256: string };
	};
};
type FuzzyResult = {
	matches: { path: string; isDirectory: boolean; score: number }[];
	totalMatches: number;
};
type WorkspaceResult = {
	entries: { path: string; fileType: FileType; size?: number }[];
	agentsMdFiles: string[];
	truncated: boolean;
};

const fixtureRoot = path.join(import.meta.dir, "fixtures", `.fd-workspace-golden-${crypto.randomUUID()}`);
const goldensPath = path.join(import.meta.dir, "fixtures", "goldens", "fd-workspace", "pre-sync.json");
const MAX_RESULTS = 2_000;
let golden: Golden;

async function createFixtureTree() {
	await fs.mkdir(fixtureRoot, { recursive: true });
	await fs.writeFile(path.join(fixtureRoot, ".gitignore"), "needle-ignored.txt\nignored-dir/\nsrc/AGENTS.md\n");
	await fs.writeFile(path.join(fixtureRoot, "AGENTS.md"), "root guidance\n");
	await fs.writeFile(path.join(fixtureRoot, "needle-visible.txt"), "visible\n");
	await fs.writeFile(path.join(fixtureRoot, "needle-ignored.txt"), "ignored file\n");
	await fs.writeFile(path.join(fixtureRoot, ".needle-hidden.txt"), "hidden file\n");
	await fs.mkdir(path.join(fixtureRoot, "src"), { recursive: true });
	await fs.writeFile(path.join(fixtureRoot, "src", "AGENTS.md"), "src guidance\n");
	await fs.writeFile(path.join(fixtureRoot, "src", "main.ts"), "export {}\n");
	await fs.mkdir(path.join(fixtureRoot, "ignored-dir"), { recursive: true });
	await fs.writeFile(path.join(fixtureRoot, "ignored-dir", "needle-ignored.txt"), "ignored directory\n");
	await fs.writeFile(path.join(fixtureRoot, "ignored-dir", "AGENTS.md"), "ignored guidance\n");
	await fs.mkdir(path.join(fixtureRoot, ".hidden-dir"), { recursive: true });
	await fs.writeFile(path.join(fixtureRoot, ".hidden-dir", "needle-hidden.txt"), "hidden directory\n");
	await fs.writeFile(path.join(fixtureRoot, ".hidden-dir", "AGENTS.md"), "hidden guidance\n");
	await fs.mkdir(path.join(fixtureRoot, "needle-target-dir"), { recursive: true });
	await fs.writeFile(path.join(fixtureRoot, "needle-target-dir", "needle-target.txt"), "symlink target\n");

	for (let index = 0; index < 512; index++) {
		const name = `needle-dir-${String(index).padStart(3, "0")}`;
		const directory = path.join(fixtureRoot, name);
		await fs.mkdir(directory);
		await fs.writeFile(path.join(directory, `needle-file-${String(index).padStart(3, "0")}.txt`), `entry ${index}\n`);
	}

	if (process.platform !== "win32") {
		await fs.symlink("needle-target-dir", path.join(fixtureRoot, "link-dir"));
		await fs.symlink("needle-visible.txt", path.join(fixtureRoot, "needle-file-link.txt"));
	}
}

function sha256(rows: readonly unknown[]): string {
	return createHash("sha256").update(JSON.stringify(rows)).digest("hex");
}

async function runFuzzy(options: { hidden: boolean; gitignore: boolean; maxResults?: number }): Promise<FuzzyResult> {
	return fuzzyFind({
		query: "needle",
		path: fixtureRoot,
		hidden: options.hidden,
		gitignore: options.gitignore,
		cache: false,
		maxResults: options.maxResults ?? MAX_RESULTS,
	});
}

async function runWorkspace(options: { hidden: boolean; gitignore: boolean }): Promise<WorkspaceResult> {
	return listWorkspace({
		path: fixtureRoot,
		maxDepth: 2,
		hidden: options.hidden,
		gitignore: options.gitignore,
		collectAgentsMd: true,
	});
}

function fuzzySummary(result: FuzzyResult): FuzzySummary {
	const symlinkAliases = result.matches.filter(match => match.path.startsWith("link-dir/"));
	const rows: FuzzyRow[] = result.matches
		.filter(match => !match.path.startsWith("link-dir/"))
		.map(({ path: matchPath, isDirectory, score }) => [matchPath, isDirectory, score]);
	return {
		matchCount: rows.length,
		totalMatches: result.totalMatches - symlinkAliases.length,
		sha256: sha256(rows),
	};
}

function fuzzySymlinkSummary(result: FuzzyResult): SymlinkSummary {
	const rows: FuzzyRow[] = result.matches
		.filter(match => match.path.startsWith("link-dir/"))
		.map(({ path: matchPath, isDirectory, score }) => [matchPath, isDirectory, score]);
	return {
		matchCount: rows.length,
		fileSymlinkIncluded: result.matches.some(match => match.path === "needle-file-link.txt"),
		sha256: sha256(rows),
	};
}

function workspaceSummary(result: WorkspaceResult): WorkspaceSummary {
	const rows: WorkspaceRow[] = result.entries
		.filter(entry => entry.fileType !== FileType.Symlink)
		.map(({ path: entryPath, fileType, size }) => [entryPath, fileType as number, size ?? null]);
	return {
		entryCount: rows.length,
		agentsMdFiles: result.agentsMdFiles,
		truncated: result.truncated,
		sha256: sha256(rows),
	};
}

function workspaceSymlinkSummary(result: WorkspaceResult): { entryCount: number; sha256: string } {
	const rows = result.entries
		.filter(entry => entry.fileType === FileType.Symlink)
		.map(({ path: entryPath, fileType }) => [entryPath, fileType as number]);
	return { entryCount: rows.length, sha256: sha256(rows) };
}

beforeAll(async () => {
	await createFixtureTree();
	golden = JSON.parse(await fs.readFile(goldensPath, "utf8")) as Golden;
});

afterAll(async () => {
	await fs.rm(fixtureRoot, { recursive: true, force: true });
});

describe("fd/workspace pre-sync differential goldens", () => {
	it("matches fuzzy results on 512 directories with hidden paths excluded", async () => {
		const result = await runFuzzy({ hidden: false, gitignore: true });
		expect(fuzzySummary(result)).toEqual(golden.scenarios.fuzzyVisible);
		expect(result.totalMatches).toBeGreaterThan(512);

		const bounded = await runFuzzy({ hidden: false, gitignore: true, maxResults: 16 });
		expect(bounded.totalMatches).toBe(result.totalMatches);
		expect(bounded.matches).toEqual(result.matches.slice(0, 16));
	});

	it("matches fuzzy results with hidden and ignored paths included", async () => {
		const visible = await runFuzzy({ hidden: false, gitignore: true });
		const all = await runFuzzy({ hidden: true, gitignore: false });
		expect(fuzzySummary(all)).toEqual(golden.scenarios.fuzzyAll);
		expect(all.totalMatches).toBeGreaterThan(visible.totalMatches);
	});

	it.skipIf(process.platform === "win32")(
		"preserves fuzzy directory-link traversal and file symlink matches",
		async () => {
			const result = await runFuzzy({ hidden: true, gitignore: false });
			expect(fuzzySymlinkSummary(result)).toEqual(golden.scenarios.fuzzySymlinks);
		},
	);

	it("matches workspace entries, ignore rules, and AGENTS.md collection", async () => {
		const result = await runWorkspace({ hidden: false, gitignore: true });
		expect(workspaceSummary(result)).toEqual(golden.scenarios.workspaceVisible);
		expect(result.entries.filter(entry => /^needle-dir-\d{3}$/.test(entry.path))).toHaveLength(512);
		expect(result.entries.map(entry => entry.path)).toContain("src/AGENTS.md");
		expect(result.entries.map(entry => entry.path)).not.toContain("ignored-dir/AGENTS.md");
		expect(result.agentsMdFiles).toEqual(["src/AGENTS.md"]);
	});

	it("matches workspace entries when hidden and ignored paths are included", async () => {
		const result = await runWorkspace({ hidden: true, gitignore: false });
		expect(workspaceSummary(result)).toEqual(golden.scenarios.workspaceAll);
		expect(result.entries.map(entry => entry.path)).toContain(".needle-hidden.txt");
		expect(result.entries.map(entry => entry.path)).toContain("needle-ignored.txt");
		expect(result.agentsMdFiles).toEqual([".hidden-dir/AGENTS.md", "ignored-dir/AGENTS.md", "src/AGENTS.md"]);
	});

	it.skipIf(process.platform === "win32")(
		"preserves workspace symlink entries without traversing directory links",
		async () => {
			const result = await runWorkspace({ hidden: true, gitignore: false });
			expect(workspaceSymlinkSummary(result)).toEqual(golden.scenarios.workspaceSymlinks);
			expect(result.entries.map(entry => entry.path)).toContain("link-dir");
			expect(result.entries.map(entry => entry.path)).toContain("needle-file-link.txt");
			expect(result.entries.map(entry => entry.path)).not.toContain("link-dir/needle-target.txt");
		},
	);
});
