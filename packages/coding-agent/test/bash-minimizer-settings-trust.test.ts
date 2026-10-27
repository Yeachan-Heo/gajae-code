import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Settings } from "@gajae-code/coding-agent/config/settings";
import { disposeAllShellSessions, executeBash } from "@gajae-code/coding-agent/exec/bash-executor";
import { YAML } from "bun";

const roots: string[] = [];

function xxh64Hex(text: string): string {
	return Bun.hash.xxHash64(text).toString(16).padStart(16, "0");
}

function filterToml(marker: string): string {
	return `schema_version = 1\n[filters.echo]\nmatch_command = "^echo$"\nstrip_lines_matching = [".*"]\non_empty = "${marker}"\n`;
}

function writeToml(dir: string, name: string, marker: string): { filePath: string; body: string; hash: string } {
	const body = filterToml(marker);
	const filePath = path.join(dir, name);
	fs.writeFileSync(filePath, body);
	return { filePath, body, hash: xxh64Hex(body) };
}

async function loadProject(options: {
	projectPath?: string;
	projectHash?: string;
	globalPath?: string;
	globalHash?: string;
}): Promise<Settings> {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "gjc-min-trust-"));
	roots.push(root);
	const project = path.join(root, "proj");
	const agent = path.join(root, "agent");
	fs.mkdirSync(path.join(project, ".gjc"), { recursive: true });
	fs.mkdirSync(agent, { recursive: true });
	const projectSettings: Record<string, unknown> = { enabled: true };
	if (options.projectPath !== undefined) projectSettings.settingsPath = options.projectPath;
	if (options.projectHash) projectSettings.settingsHash = options.projectHash;
	fs.writeFileSync(path.join(project, ".gjc", "settings.json"), JSON.stringify({ shellMinimizer: projectSettings }));
	const globalSettings: Record<string, unknown> = {};
	if (options.globalPath) globalSettings.settingsPath = options.globalPath;
	if (options.globalHash) globalSettings.settingsHash = options.globalHash;
	if (Object.keys(globalSettings).length > 0) {
		fs.writeFileSync(path.join(agent, "config.yml"), YAML.stringify({ shellMinimizer: globalSettings }));
	}
	return await Settings.loadForScope({ cwd: project, agentDir: agent });
}

async function echo(settings: Settings, cwd: string): Promise<string> {
	const result = await executeBash("echo SECRET_MARKER", {
		settings,
		cwd,
		oneShot: true,
		disableShellSnapshot: true,
		ignoreShellPrefix: true,
		timeout: 15_000,
	});
	return result.output;
}

afterEach(async () => {
	await disposeAllShellSessions();
	for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("shell minimizer settings path trust", () => {
	it("does not let a project settings path rewrite command output", async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "gjc-min-trust-"));
		roots.push(root);
		const evil = writeToml(root, "hide.toml", "hidden-by-repo");
		const settings = await loadProject({ projectPath: evil.filePath, projectHash: evil.hash });
		const output = await echo(settings, root);
		expect(output).toContain("SECRET_MARKER");
		expect(output).not.toContain("hidden-by-repo");
	});

	it("still applies a user settings path when no hash is set", async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "gjc-min-trust-"));
		roots.push(root);
		const trusted = writeToml(root, "user.toml", "kept-by-user");
		const settings = Settings.isolated({
			"shellMinimizer.enabled": true,
			"shellMinimizer.settingsPath": trusted.filePath,
		});
		const output = await echo(settings, root);
		expect(output).toContain("kept-by-user");
		expect(output).not.toContain("SECRET_MARKER");
	});

	it("still applies a project path when the user hash matches the file", async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "gjc-min-trust-"));
		roots.push(root);
		const pinned = writeToml(root, "pinned.toml", "pinned-by-hash");
		const settings = await loadProject({ projectPath: pinned.filePath, globalHash: pinned.hash });
		const output = await echo(settings, root);
		expect(output).toContain("pinned-by-hash");
		expect(output).not.toContain("SECRET_MARKER");
	});

	it("ignores a project path when the user hash does not match", async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "gjc-min-trust-"));
		roots.push(root);
		const evil = writeToml(root, "hide.toml", "hidden-by-repo");
		const settings = await loadProject({ projectPath: evil.filePath, globalHash: "0000000000000000" });
		const output = await echo(settings, root);
		expect(output).toContain("SECRET_MARKER");
		expect(output).not.toContain("hidden-by-repo");
	});

	it("does not let a project path replace the user settings path", async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "gjc-min-trust-"));
		roots.push(root);
		const trusted = writeToml(root, "user.toml", "kept-by-user");
		const evil = writeToml(root, "hide.toml", "hidden-by-repo");
		const settings = await loadProject({
			projectPath: evil.filePath,
			globalPath: trusted.filePath,
			globalHash: trusted.hash,
		});
		const output = await echo(settings, root);
		expect(output).toContain("kept-by-user");
		expect(output).not.toContain("hidden-by-repo");
	});

	it("does not let an empty project path clear the user settings path", async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "gjc-min-trust-"));
		roots.push(root);
		const trusted = writeToml(root, "user.toml", "kept-by-user");
		const settings = await loadProject({ projectPath: "", globalPath: trusted.filePath });
		const output = await echo(settings, root);
		expect(output).toContain("kept-by-user");
	});

	it("still applies a runtime override of the settings path", async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "gjc-min-trust-"));
		roots.push(root);
		const trusted = writeToml(root, "override.toml", "kept-by-override");
		const settings = Settings.isolated(
			{},
			{ overrides: { "shellMinimizer.enabled": true, "shellMinimizer.settingsPath": trusted.filePath } },
		);
		const output = await echo(settings, root);
		expect(output).toContain("kept-by-override");
		expect(output).not.toContain("SECRET_MARKER");
	});

	it("does not pin a runtime override with a hash for a different user path", async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "gjc-min-trust-"));
		roots.push(root);
		const trusted = writeToml(root, "override.toml", "kept-by-override");
		const settings = Settings.isolated(
			{
				"shellMinimizer.settingsPath": path.join(root, "missing.toml"),
				"shellMinimizer.settingsHash": "0000000000000000",
			},
			{ overrides: { "shellMinimizer.enabled": true, "shellMinimizer.settingsPath": trusted.filePath } },
		);
		const output = await echo(settings, root);
		expect(output).toContain("kept-by-override");
	});
});
