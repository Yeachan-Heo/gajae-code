import { afterEach, beforeEach, describe, expect, test, vi } from "bun:test";
import type * as nfs from "node:fs";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { loadCapabilityForHome } from "@gajae-code/coding-agent/capability";
import { type ContextFile, contextFileCapability } from "@gajae-code/coding-agent/capability/context-file";
import { clearCache } from "@gajae-code/coding-agent/capability/fs";
import { hookCapability } from "@gajae-code/coding-agent/capability/hook";
import { type Rule, ruleCapability } from "@gajae-code/coding-agent/capability/rule";
import { settingsCapability } from "@gajae-code/coding-agent/capability/settings";
import { type Skill, skillCapability } from "@gajae-code/coding-agent/capability/skill";
import { type SlashCommand, slashCommandCapability } from "@gajae-code/coding-agent/capability/slash-command";
import { type SystemPrompt, systemPromptCapability } from "@gajae-code/coding-agent/capability/system-prompt";
import { toolCapability } from "@gajae-code/coding-agent/capability/tool";
import { getAgentDir, resetAgentDirFromEnvironment, setAgentDir } from "@gajae-code/utils";
// Register all discovery providers as a side effect.
import "@gajae-code/coding-agent/discovery";

let tempDir: string;
let home: string;
let project: string;
let originalGjcAgentDir: string | undefined;
let originalPiAgentDir: string | undefined;

async function writeFile(filePath: string, content: string): Promise<void> {
	await fs.mkdir(path.dirname(filePath), { recursive: true });
	await Bun.write(filePath, content);
}

async function makeSkill(root: string, name: string): Promise<void> {
	await writeFile(
		path.join(root, name, "SKILL.md"),
		["---", `name: ${name}`, `description: ${name} description`, "---", "", `# ${name}`].join("\n"),
	);
}

/**
 * Seed one full user profile: SYSTEM.md, RULES.md, AGENTS.md, a skill, a
 * command, a hook, settings, and an executable descriptor (custom tool).
 */
async function seedProfile(agentDir: string, label: string): Promise<void> {
	await writeFile(path.join(agentDir, "SYSTEM.md"), `# ${label} system`);
	await writeFile(path.join(agentDir, "RULES.md"), `${label} rules`);
	await writeFile(path.join(agentDir, "AGENTS.md"), `${label} agents`);
	await makeSkill(path.join(agentDir, "skills"), `${label}-skill`);
	await writeFile(
		path.join(agentDir, "commands", `${label}-command.md`),
		["---", `description: ${label} command`, "---", "", `${label} body`].join("\n"),
	);
	await writeFile(
		path.join(agentDir, "hooks", `${label}-hook.ts`),
		[
			"// decoy-seeded hook source; loader contract does not execute it during discovery",
			`export const ${label.replace(/-/g, "_")}_hooks = [];`,
		].join("\n"),
	);
	await writeFile(path.join(agentDir, "config.yml"), ["# profile settings", `theme: "${label}-theme"`].join("\n"));
	await writeFile(
		path.join(agentDir, "tools", `${label}-tool.md`),
		["---", `description: Execute the ${label} tool`, "---", "", "Runs the tool."].join("\n"),
	);
}

/** Every user-scope capability exercised by the isolation contract. */
const ALL_CAPABILITIES = [
	systemPromptCapability.id,
	ruleCapability.id,
	contextFileCapability.id,
	skillCapability.id,
	slashCommandCapability.id,
	hookCapability.id,
	settingsCapability.id,
	toolCapability.id,
] as const;

beforeEach(async () => {
	clearCache();
	tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-4834-home-isolation-"));
	home = path.join(tempDir, "supplied-home");
	project = path.join(tempDir, "project");
	await fs.mkdir(home, { recursive: true });
	await fs.mkdir(project, { recursive: true });
	await fs.mkdir(path.join(project, ".git"), { recursive: true });
	originalGjcAgentDir = process.env.GJC_CODING_AGENT_DIR;
	originalPiAgentDir = process.env.PI_CODING_AGENT_DIR;
});

afterEach(async () => {
	clearCache();
	vi.restoreAllMocks();
	if (originalGjcAgentDir === undefined) delete process.env.GJC_CODING_AGENT_DIR;
	else process.env.GJC_CODING_AGENT_DIR = originalGjcAgentDir;
	if (originalPiAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
	else process.env.PI_CODING_AGENT_DIR = originalPiAgentDir;
	resetAgentDirFromEnvironment();
	await fs.rm(tempDir, { recursive: true, force: true });
});

describe("PR #4834: loadCapabilityForHome never falls back to the process profile", () => {
	test("restoring an absent agent-dir override returns the resolver to the home-relative profile", () => {
		delete process.env.GJC_CODING_AGENT_DIR;
		delete process.env.PI_CODING_AGENT_DIR;
		resetAgentDirFromEnvironment();
		const homeRelativeAgentDir = getAgentDir();

		setAgentDir(path.join(tempDir, "temporary-profile"));
		expect(getAgentDir()).not.toBe(homeRelativeAgentDir);
		delete process.env.GJC_CODING_AGENT_DIR;
		resetAgentDirFromEnvironment();

		expect(process.env.GJC_CODING_AGENT_DIR).toBeUndefined();
		expect(getAgentDir()).toBe(homeRelativeAgentDir);
	});

	test("explicit home performs zero reads of the decoy process profile across every user-scope surface", async () => {
		const homeAgentDir = path.join(home, ".gjc", "agent");
		const decoyAgentDir = path.join(tempDir, "process-decoy", ".gjc", "agent");
		await seedProfile(homeAgentDir, "home");
		await seedProfile(decoyAgentDir, "decoy");
		// Point the process profile at the decoy.
		setAgentDir(decoyAgentDir);

		const options = { cwd: project, providers: ["native"] as string[] };
		const system = await loadCapabilityForHome<SystemPrompt>(systemPromptCapability.id, home, options);
		const rules = await loadCapabilityForHome<Rule>(ruleCapability.id, home, options);
		const context = await loadCapabilityForHome<ContextFile>(contextFileCapability.id, home, options);
		const skills = await loadCapabilityForHome<Skill>(skillCapability.id, home, options);
		const commands = await loadCapabilityForHome<SlashCommand>(slashCommandCapability.id, home, options);

		// Positive behavior: the isolated home's own surfaces load.
		expect(system.items.map(item => item.content)).toEqual(["# home system"]);
		expect(rules.items.map(item => item.content)).toEqual(["home rules"]);
		expect(context.items.map(item => item.content)).toEqual(["home agents"]);
		expect(skills.items.map(item => item.name)).toEqual(["home-skill"]);
		expect(commands.items.map(item => item.name)).toEqual(["home-command"]);

		// Isolation contract part 1: nothing loaded from the decoy profile.
		const results = [system, rules, context, skills, commands];
		for (const result of results) {
			for (const item of result.items) {
				const itemPath = (item as { path?: string }).path;
				if (typeof itemPath === "string") {
					expect(itemPath.startsWith(decoyAgentDir)).toBe(false);
				}
				expect(JSON.stringify(item).includes("decoy")).toBe(false);
			}
		}

		// Isolation contract part 2 (hard proof): instrument every fs read the
		// capability layer performs while loading all eight surfaces and assert
		// none resolves inside the decoy process profile.
		const reads = new Set<string>();
		const realReaddir = fs.readdir;
		const realReadFile = fs.readFile;
		const realStat = fs.stat;
		const realLstat = fs.lstat;
		const realAccess = fs.access;
		const passthroughReaddir = realReaddir.bind(fs) as unknown as (t: nfs.PathLike) => Promise<string[]>;
		const passthroughReadFile = realReadFile.bind(fs) as unknown as (
			f: nfs.PathLike | number,
			e: string,
		) => Promise<string>;
		const passthroughStat = realStat.bind(fs) as unknown as (t: nfs.PathLike) => Promise<nfs.Stats>;
		const passthroughLstat = realLstat.bind(fs) as unknown as (t: nfs.PathLike) => Promise<nfs.Stats>;
		const passthroughAccess = realAccess.bind(fs) as unknown as (t: nfs.PathLike) => Promise<void>;
		// Spy implementations record the path then delegate to the captured real
		// binding; the explicit signatures plus concrete-type casts keep the
		// overloaded node types out of the way without ReturnType<> (repo rule).
		vi.spyOn(fs, "readdir").mockImplementation(((target: nfs.PathLike) => {
			reads.add(path.resolve(String(target)));
			return passthroughReaddir(target);
		}) as unknown as typeof fs.readdir);
		vi.spyOn(fs, "readFile").mockImplementation(((file: nfs.PathLike | number) => {
			reads.add(path.resolve(String(file)));
			return passthroughReadFile(file, "utf-8");
		}) as unknown as typeof fs.readFile);
		vi.spyOn(fs, "stat").mockImplementation(((target: nfs.PathLike) => {
			reads.add(path.resolve(String(target)));
			return passthroughStat(target);
		}) as unknown as typeof fs.stat);
		vi.spyOn(fs, "lstat").mockImplementation(((target: nfs.PathLike) => {
			reads.add(path.resolve(String(target)));
			return passthroughLstat(target);
		}) as unknown as typeof fs.lstat);
		vi.spyOn(fs, "access").mockImplementation(((target: nfs.PathLike) => {
			reads.add(path.resolve(String(target)));
			return passthroughAccess(target);
		}) as unknown as typeof fs.access);
		clearCache();

		for (const capabilityId of ALL_CAPABILITIES) {
			await loadCapabilityForHome(capabilityId, home, options);
		}

		const decoyReads = [...reads].filter(p => p.startsWith(decoyAgentDir));
		expect(decoyReads).toEqual([]);
	});

	test("explicit home still honors an explicit agent directory", async () => {
		const explicitAgentDir = path.join(tempDir, "explicit-agent");
		const decoyAgentDir = path.join(tempDir, "process-decoy", ".gjc", "agent");
		await seedProfile(explicitAgentDir, "explicit");
		await seedProfile(decoyAgentDir, "decoy");
		setAgentDir(decoyAgentDir);

		const options = { cwd: project, agentDir: explicitAgentDir, providers: ["native"] as string[] };
		// The MCP user-scope surface resolves from ctx.userAgentDir, proving the
		// explicit agentDir is threaded through instead of the process profile.
		const mcp = await loadCapabilityForHome<{ name: string }>("mcps", home, options);
		await writeFile(
			path.join(explicitAgentDir, "mcp.json"),
			JSON.stringify({ mcpServers: { "explicit-server": { command: "echo", args: ["hi"] } } }),
		);
		await writeFile(
			path.join(decoyAgentDir, "mcp.json"),
			JSON.stringify({ mcpServers: { "decoy-server": { command: "echo", args: ["decoy"] } } }),
		);
		clearCache();
		const mcpWithFiles = await loadCapabilityForHome<{ name: string }>("mcps", home, options);

		expect(mcp.items.map(item => item.name)).toEqual([]);
		expect(mcpWithFiles.items.map(item => item.name)).toEqual(["explicit-server"]);
		for (const item of mcpWithFiles.items) {
			const itemPath = (item as unknown as { _source?: { path?: string } })._source?.path ?? "";
			expect(itemPath.startsWith(decoyAgentDir)).toBe(false);
		}
	});
	test("explicit agent directory redirects native user-scope surfaces, not only MCP", async () => {
		const explicitAgentDir = path.join(tempDir, "explicit-agent-2");
		const homeAgentDir = path.join(home, ".gjc", "agent");
		await seedProfile(explicitAgentDir, "explicit");
		await seedProfile(homeAgentDir, "home");
		clearCache();

		const options = { cwd: project, agentDir: explicitAgentDir, providers: ["native"] as string[] };
		const system = await loadCapabilityForHome<SystemPrompt>(systemPromptCapability.id, home, options);
		const skills = await loadCapabilityForHome<Skill>(skillCapability.id, home, options);

		// Native user-scope surfaces must resolve from the explicit agent directory
		// (ctx.userAgentDir), not from the supplied home's default profile and not
		// from the process profile.
		expect(system.items.map(item => item.content)).toEqual(["# explicit system"]);
		expect(skills.items.map(item => item.name)).toEqual(["explicit-skill"]);
		for (const item of [...system.items, ...skills.items]) {
			const itemPath = (item as { path?: string }).path ?? "";
			expect(itemPath.startsWith(homeAgentDir)).toBe(false);
			expect(itemPath.startsWith(explicitAgentDir)).toBe(true);
		}
	});

	test("non-absolute home fails closed instead of using the process profile", async () => {
		const decoyAgentDir = path.join(tempDir, "process-decoy", ".gjc", "agent");
		await seedProfile(decoyAgentDir, "decoy");
		setAgentDir(decoyAgentDir);

		await expect(
			loadCapabilityForHome(systemPromptCapability.id, "relative/home", {
				cwd: project,
				providers: ["native"],
			}),
		).rejects.toThrow(/absolute home directory/);
	});
	test("session settings propagate into explicit-home loads instead of defaulting provider toggles", async () => {
		const homeAgentDir = path.join(home, ".gjc", "agent");
		await seedProfile(homeAgentDir, "home");
		// Seed an opencode project command so the toggle under test has a real payload.
		await fs.mkdir(path.join(project, ".opencode", "commands"), { recursive: true });
		await writeFile(
			path.join(project, ".opencode", "commands", "oc-command.md"),
			["---", "description: opencode command", "---", "", "oc body"].join("\n"),
		);
		const enabledSettings = { get: () => undefined } as never;
		const disabledSettings = {
			get: (key: string) => {
				if (key === "commands.enableOpencodeUser") return false;
				if (key === "commands.enableOpencodeProject") return false;
				return undefined;
			},
		} as never;

		// Baseline: without disabling settings the opencode command is discovered
		// from the explicit-home load, proving the provider actually runs here.
		const enabled = await loadCapabilityForHome<SlashCommand>(slashCommandCapability.id, home, {
			cwd: project,
			providers: ["opencode"],
			settings: enabledSettings,
		});
		expect(enabled.items.map(item => item.name)).toContain("oc-command");

		// With the toggles disabled through the same options.settings, the load must
		// honor them. If loadCapabilityForHome drops options.settings from the context,
		// readOpencodeCommandToggles defaults both to enabled and the command leaks in.
		const disabled = await loadCapabilityForHome<SlashCommand>(slashCommandCapability.id, home, {
			cwd: project,
			providers: ["opencode"],
			settings: disabledSettings,
		});
		expect(disabled.items.map(item => item.name)).toEqual([]);
	});
});
