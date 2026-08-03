import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { parseFrontmatter } from "@gajae-code/utils";

const tempRoots: string[] = [];
const repoRoot = path.resolve(import.meta.dir, "..", "..", "..");
const cliEntry = path.join(repoRoot, "packages", "coding-agent", "src", "cli.ts");

type CliResult = {
	readonly exitCode: number;
	readonly stderr: string;
	readonly stdout: string;
};

function runGjc(args: readonly string[], env: NodeJS.ProcessEnv = process.env): CliResult {
	const result = Bun.spawnSync([process.execPath, cliEntry, ...args], {
		cwd: repoRoot,
		env,
		stderr: "pipe",
		stdout: "pipe",
	});
	return {
		exitCode: result.exitCode,
		stderr: result.stderr.toString(),
		stdout: result.stdout.toString(),
	};
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readJsonObject(stdout: string): Record<string, unknown> {
	const parsed: unknown = JSON.parse(stdout);
	if (!isRecord(parsed)) {
		throw new Error("expected CLI JSON object");
	}
	return parsed;
}

function requiredString(record: Record<string, unknown>, key: string): string {
	const value = record[key];
	if (typeof value !== "string") throw new Error(`expected ${key} to be a string`);
	return value;
}

function requiredRecords(record: Record<string, unknown>, key: string): readonly Record<string, unknown>[] {
	const value = record[key];
	if (!Array.isArray(value)) throw new Error(`expected ${key} to be an array`);
	return value.map(entry => {
		if (!isRecord(entry)) {
			throw new Error(`expected ${key} entries to be objects`);
		}
		return entry;
	});
}

async function makeTempRoot(): Promise<string> {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-ultratest-default-surface-"));
	tempRoots.push(root);
	return root;
}

afterEach(async () => {
	await Promise.all(tempRoots.splice(0).map(root => fs.rm(root, { recursive: true, force: true })));
});

describe("ultratest opt-in surface", () => {
	it("extracts a reusable skill body with only supported routing frontmatter", async () => {
		const template = await Bun.file(path.join(repoRoot, "docs", "ultratest-skill-template.md")).text();
		const bodyMarker = template.indexOf("\n---\n");
		if (bodyMarker < 0) throw new Error("expected reusable skill body marker");
		const parsed = parseFrontmatter(template.slice(bodyMarker + 1));

		expect(Object.keys(parsed.frontmatter).sort()).toEqual(["description", "name"]);
		expect(parsed.frontmatter.name).toBe("ultratest");
	}, 30_000);

	it("omits ultratest from the source CLI skill list", async () => {
		// Given: an isolated GJC home and agent-config directory.
		const root = await makeTempRoot();
		const home = path.join(root, "home");
		const agentDir = path.join(root, "agent");
		await fs.mkdir(home);
		const env = { ...process.env, GJC_CODING_AGENT_DIR: agentDir, HOME: home };

		// When: the public skills list runs from source.
		const listResult = runGjc(["skills", "list", "--json"], env);

		// Then: no bundled ultratest entry is exposed.
		expect(listResult.exitCode, listResult.stderr).toBe(0);
		const listedSkills = requiredRecords(readJsonObject(listResult.stdout), "skills");
		expect(listedSkills.some(skill => requiredString(skill, "name") === "ultratest")).toBe(false);
	}, 30_000);

	it("rejects ultratest as an embedded skill read target", async () => {
		// Given: an isolated GJC home and agent-config directory.
		const root = await makeTempRoot();
		const home = path.join(root, "home");
		const agentDir = path.join(root, "agent");
		await fs.mkdir(home);
		const env = { ...process.env, GJC_CODING_AGENT_DIR: agentDir, HOME: home };

		// When: an embedded skill read is requested by exact name.
		const readResult = runGjc(["skills", "read", "ultratest", "--json"], env);

		// Then: the source CLI rejects the non-default asset.
		expect(readResult.exitCode).not.toBe(0);
	}, 30_000);

	it("does not install ultratest with default definitions", async () => {
		// Given: an isolated GJC home and agent-config directory.
		const root = await makeTempRoot();
		const home = path.join(root, "home");
		const agentDir = path.join(root, "agent");
		await fs.mkdir(home);
		const env = { ...process.env, GJC_CODING_AGENT_DIR: agentDir, HOME: home };

		// When: default definitions are installed from source.
		const installResult = runGjc(["setup", "defaults", "--json"], env);

		// Then: no ultratest asset is reported or materialized.
		expect(installResult.exitCode, installResult.stderr).toBe(0);
		const installation = readJsonObject(installResult.stdout);
		expect(requiredString(installation, "targetRoot")).toBe(agentDir);
		expect(requiredRecords(installation, "files").some(file => file.name === "ultratest")).toBe(false);
		await expect(fs.stat(path.join(agentDir, "skills", "ultratest", "SKILL.md"))).rejects.toThrow();
	}, 30_000);
});
