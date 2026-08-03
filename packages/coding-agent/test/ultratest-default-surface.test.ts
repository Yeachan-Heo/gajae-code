import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

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

describe("ultratest bundled default surface", () => {
	it("reads and installs the ultratest bundled skill through the public CLI", async () => {
		// Given: an isolated GJC home and agent-config directory.
		const root = await makeTempRoot();
		const home = path.join(root, "home");
		const agentDir = path.join(root, "agent");
		await fs.mkdir(home);
		const env = { ...process.env, GJC_CODING_AGENT_DIR: agentDir, HOME: home };

		// When: the public skill-inspection and default-install commands run from source.
		const readResult = runGjc(["skills", "read", "ultratest", "--json"], env);
		const installResult = runGjc(["setup", "defaults", "--json"], env);

		// Then: the embedded asset and its fresh installed copy expose the literal public contract.
		expect(readResult.exitCode, readResult.stderr).toBe(0);
		const embedded = readJsonObject(readResult.stdout);
		expect(requiredString(embedded, "name")).toBe("ultratest");
		expect(requiredString(embedded, "path")).toBe("embedded:gjc/skills/ultratest/SKILL.md");
		const embeddedContent = requiredString(embedded, "content");
		expect(embeddedContent).toContain("# Ultratest");
		expect(embeddedContent).toContain("Behavior promise:");

		expect(installResult.exitCode, installResult.stderr).toBe(0);
		const installation = readJsonObject(installResult.stdout);
		expect(requiredString(installation, "targetRoot")).toBe(agentDir);
		const ultratestFile = requiredRecords(installation, "files").find(file => file.name === "ultratest");
		if (!ultratestFile) throw new Error("setup defaults did not report ultratest");
		expect(requiredString(ultratestFile, "status")).toBe("written");
		expect(requiredString(ultratestFile, "path")).toBe(path.join(agentDir, "skills", "ultratest", "SKILL.md"));

		const installedContent = await Bun.file(path.join(agentDir, "skills", "ultratest", "SKILL.md")).text();
		expect(installedContent).toContain("# Ultratest");
		expect(installedContent).toContain("Behavior promise:");
		expect(installedContent).toBe(embeddedContent);
	}, 30_000);
});
