import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { CliConfig } from "@gajae-code/utils/cli";
import Plugin from "../src/commands/plugin";

const TEST_CONFIG: CliConfig = {
	bin: "gjc",
	version: "0.0.0-test",
	commands: new Map(),
};

let tempRoot: string | undefined;

const agentDirs: string[] = [];

async function runPluginCommand(
	args: string[],
	cwd: string,
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
	// Isolate the user scope: without this the child process reads the real
	// ~/.gjc/agent registry and inherits whatever the developer has installed.
	const agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-plugin-command-agent-"));
	agentDirs.push(agentDir);
	const proc = Bun.spawn({
		cmd: [process.execPath, path.join(import.meta.dir, "../src/cli.ts"), "plugin", ...args],
		cwd,
		env: { ...process.env, GJC_CODING_AGENT_DIR: agentDir },
		stdout: "pipe",
		stderr: "pipe",
	});
	const [exitCode, stdout, stderr] = await Promise.all([
		proc.exited,
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
	]);
	return { exitCode, stdout, stderr };
}

async function makeTempProject(): Promise<string> {
	tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-plugin-command-"));
	return tempRoot;
}

describe("Plugin command scope parsing", () => {
	afterEach(async () => {
		if (tempRoot) {
			await fs.rm(tempRoot, { recursive: true, force: true });
			tempRoot = undefined;
		}
		for (const dir of agentDirs.splice(0)) await fs.rm(dir, { recursive: true, force: true });
	});
	it("rejects invalid scope values", async () => {
		const command = new Plugin(["install", "--scope", "porject"], TEST_CONFIG);
		await expect(command.parse(Plugin)).rejects.toThrow(/Expected --scope to be one of: user, project/);
	});

	it("lists installed GJC plugin bundles in text and JSON output", async () => {
		const cwd = await makeTempProject();
		const fixture = path.join(import.meta.dir, "fixtures/gjc-plugins/valid-six-surface-bundle");

		const install = await runPluginCommand(["install", fixture, "--project"], cwd);
		expect(install.exitCode).toBe(0);
		expect(install.stderr).toBe("");

		const textList = await runPluginCommand(["list"], cwd);
		expect(textList.exitCode).toBe(0);
		expect(textList.stderr).toBe("");
		expect(textList.stdout).toContain("GJC Plugin Bundles:");
		expect(textList.stdout).toContain("valid-six-surface-bundle@1.0.0");
		expect(textList.stdout).toContain("(project)");

		const jsonList = await runPluginCommand(["list", "--json"], cwd);
		expect(jsonList.exitCode).toBe(0);
		expect(jsonList.stderr).toBe("");
		// `gjc` now carries safe lifecycle summaries keyed by canonical identity
		// (kind, scope, name) rather than raw registry entries.
		const parsed = JSON.parse(jsonList.stdout) as {
			gjc?: Array<{ identity: { kind: string; scope: string; name: string }; version: string }>;
		};
		expect(parsed.gjc).toEqual([
			expect.objectContaining({
				identity: { kind: "gjc-bundle", scope: "project", name: "valid-six-surface-bundle" },
				version: "1.0.0",
			}),
		]);
		// Safe summaries never expose the raw source locator or the install path.
		expect(jsonList.stdout).not.toContain("pluginRoot");
		expect(jsonList.stdout).not.toContain("copiedFiles");
		// Assert on the `gjc` envelope specifically. The sibling `npm` and
		// `marketplace` arrays are pre-existing surfaces owned elsewhere, so a
		// whole-document scan would conflate their behavior with this one.
		const listed = JSON.parse(jsonList.stdout) as { gjc?: unknown[] };
		const gjcJson = JSON.stringify(listed.gjc ?? []);
		expect(gjcJson).not.toContain("manifestPath");
		expect(gjcJson).not.toContain(os.homedir());
		expect(gjcJson).not.toMatch(/"uri"\s*:/);
	});

	it("GJC install and upgrade failures never echo the source or its cause", async () => {
		const cwd = await makeTempProject();
		// A hostile locator carrying credentials, a query string, a fragment, and
		// an absolute home path. None of it may reach stdout or stderr on any GJC
		// CLI surface, in text or JSON mode.
		const hostile = "https://user:s3cr3t-token@example.invalid/owner/repo.git?auth=abc#frag";

		// Install a real bundle from a source that is then deleted, so `upgrade`
		// actually reaches the GJC lifecycle and fails re-resolving a stored
		// locator. Upgrading a name that is not installed would fall through to
		// the marketplace and never exercise this surface at all.
		const stagedSource = path.join(cwd, "staged-bundle");
		await fs.cp(path.join(import.meta.dir, "fixtures/gjc-plugins/valid-six-surface-bundle"), stagedSource, {
			recursive: true,
		});
		const seeded = await runPluginCommand(["install", stagedSource, "--project"], cwd);
		expect(seeded.exitCode).toBe(0);
		await fs.rm(stagedSource, { recursive: true, force: true });

		const install = await runPluginCommand(["install", hostile, "--project"], cwd);
		const installJson = await runPluginCommand(["install", hostile, "--project", "--json"], cwd);
		const upgrade = await runPluginCommand(["upgrade", "valid-six-surface-bundle", "--project"], cwd);
		const upgradeJson = await runPluginCommand(["upgrade", "valid-six-surface-bundle", "--project", "--json"], cwd);

		// The upgrade must reach the lifecycle and report a typed failure, not a
		// marketplace fallthrough and not an unhandled crash.
		expect(`${upgrade.stdout}${upgrade.stderr}`).not.toContain("marketplace");
		expect(`${upgradeJson.stdout}${upgradeJson.stderr}`).toContain("source_unavailable");

		for (const result of [install, installJson, upgrade, upgradeJson]) {
			const output = `${result.stdout}${result.stderr}`;
			expect(output).not.toContain("s3cr3t-token");
			expect(output).not.toContain("user:");
			expect(output).not.toContain("auth=abc");
			expect(output).not.toContain("#frag");
			expect(output).not.toContain(os.homedir());
			expect(output).not.toContain(stagedSource);
		}
	});
});
