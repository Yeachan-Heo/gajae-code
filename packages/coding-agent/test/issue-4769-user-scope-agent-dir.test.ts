import { afterEach, beforeEach, describe, expect, test, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { getCapability, loadCapability, loadCapabilityForHome } from "@gajae-code/coding-agent/capability";
import { type ContextFile, contextFileCapability } from "@gajae-code/coding-agent/capability/context-file";
import { clearCache } from "@gajae-code/coding-agent/capability/fs";
import { type Rule, ruleCapability } from "@gajae-code/coding-agent/capability/rule";
import { type Skill, skillCapability } from "@gajae-code/coding-agent/capability/skill";
import { type SystemPrompt, systemPromptCapability } from "@gajae-code/coding-agent/capability/system-prompt";
import type { LoadContext } from "@gajae-code/coding-agent/capability/types";
import { runMigrate } from "@gajae-code/coding-agent/cli/migrate-cli";
import { Settings } from "@gajae-code/coding-agent/config/settings";
import { discoverCustomCommands } from "@gajae-code/coding-agent/extensibility/custom-commands/loader";
import { loadHooks } from "@gajae-code/coding-agent/extensibility/hooks/loader";
import {
	discoverRuntimeSkills,
	findRuntimeSkillByName,
} from "@gajae-code/coding-agent/extensibility/runtime-skill-discovery";
import {
	listNativeSkillsForManagement,
	writeNativeSkill,
} from "@gajae-code/coding-agent/extensibility/skill-management";
import { loadSkills } from "@gajae-code/coding-agent/extensibility/skills";
import { loadSlashCommands } from "@gajae-code/coding-agent/extensibility/slash-commands";
import {
	buildSystemPrompt as buildSdkSystemPrompt,
	createAgentSession,
	discoverContextFiles as discoverSdkContextFiles,
	discoverSlashCommands as discoverSdkSlashCommands,
} from "@gajae-code/coding-agent/sdk";
import { SessionManager } from "@gajae-code/coding-agent/session/session-manager";
import { getAgentDir, getAgentProfileAuthority, setAgentDir } from "@gajae-code/utils";
import { safeRm } from "../../../scripts/safe-cleanup";
// Register all discovery providers as a side effect.
import "@gajae-code/coding-agent/discovery";

let tempDir: string;
let home: string;
let project: string;
let profile: string;
let originalAgentDir: string;

async function writeFile(filePath: string, content: string): Promise<void> {
	await fs.mkdir(path.dirname(filePath), { recursive: true });
	await fs.writeFile(filePath, content);
}

async function makeSkill(root: string, name: string, description = `${name} body`): Promise<string> {
	const filePath = path.join(root, name, "SKILL.md");
	await writeFile(
		filePath,
		["---", `name: ${name}`, `description: ${description}`, "---", "", `# ${name}`].join("\n"),
	);
	return filePath;
}

function nativeProvider(capabilityId: string) {
	const capability = getCapability(capabilityId);
	if (!capability) throw new Error(`capability ${capabilityId} missing`);
	const provider = capability.providers.find(p => p.id === "native");
	if (!provider) throw new Error(`native provider for ${capabilityId} not registered`);
	return provider.load as (ctx: LoadContext) => Promise<{ items: unknown[] }>;
}

beforeEach(async () => {
	clearCache();
	tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-4769-user-scope-"));
	home = path.join(tempDir, "home");
	project = path.join(tempDir, "project");
	profile = path.join(tempDir, "profile-agent-dir");
	await fs.mkdir(home, { recursive: true });
	await fs.mkdir(project, { recursive: true });
	await fs.mkdir(profile, { recursive: true });
	await fs.mkdir(path.join(project, ".git"), { recursive: true });
	originalAgentDir = getAgentDir();
});

afterEach(async () => {
	clearCache();
	vi.restoreAllMocks();
	setAgentDir(originalAgentDir);
	await safeRm(tempDir, { recursive: true, force: true });
});

describe("issue #4769: user scope follows the agent directory", () => {
	test("explicit-home loading derives its default agent directory from home", async () => {
		const homeAgentDir = path.join(home, ".gjc", "agent");
		const decoyAgentDir = path.join(tempDir, "process-global-decoy");
		await writeFile(path.join(homeAgentDir, "SYSTEM.md"), "# home system");
		await writeFile(path.join(homeAgentDir, "RULES.md"), "home rules");
		await writeFile(path.join(homeAgentDir, "AGENTS.md"), "home agents");
		await makeSkill(path.join(homeAgentDir, "skills"), "home-skill");
		await writeFile(path.join(decoyAgentDir, "SYSTEM.md"), "# decoy system");
		await writeFile(path.join(decoyAgentDir, "RULES.md"), "decoy rules");
		await writeFile(path.join(decoyAgentDir, "AGENTS.md"), "decoy agents");
		await makeSkill(path.join(decoyAgentDir, "skills"), "decoy-skill");

		setAgentDir(decoyAgentDir);
		const options = { cwd: project, agentDir: homeAgentDir, providers: ["native"] };
		const system = await loadCapabilityForHome<SystemPrompt>(systemPromptCapability.id, home, options);
		const rules = await loadCapabilityForHome<Rule>(ruleCapability.id, home, options);
		const context = await loadCapabilityForHome<ContextFile>(contextFileCapability.id, home, options);
		const skills = await loadCapabilityForHome<Skill>(skillCapability.id, home, options);

		expect(system.items.map(item => item.content)).toEqual(["# home system"]);
		expect(rules.items.map(item => item.content)).toEqual(["home rules"]);
		expect(context.items.map(item => item.content)).toEqual(["home agents"]);
		expect(skills.items.map(item => item.name)).toEqual(["home-skill"]);
		for (const result of [system, rules, context, skills]) {
			expect(result.items.every(item => !item.path.startsWith(decoyAgentDir))).toBe(true);
		}
	});

	test("explicit-home loading still honors an explicit agent directory", async () => {
		const explicitAgentDir = path.join(tempDir, "explicit-agent");
		const decoyAgentDir = path.join(tempDir, "process-global-decoy");
		await writeFile(path.join(explicitAgentDir, "SYSTEM.md"), "# explicit system");
		await makeSkill(path.join(explicitAgentDir, "skills"), "explicit-skill");
		await writeFile(path.join(decoyAgentDir, "SYSTEM.md"), "# decoy system");
		await makeSkill(path.join(decoyAgentDir, "skills"), "decoy-skill");

		setAgentDir(decoyAgentDir);
		const options = { cwd: project, agentDir: explicitAgentDir, providers: ["native"] };
		const system = await loadCapabilityForHome<SystemPrompt>(systemPromptCapability.id, home, options);
		const skills = await loadCapabilityForHome<Skill>(skillCapability.id, home, options);

		expect(system.items.map(item => item.content)).toEqual(["# explicit system"]);
		expect(skills.items.map(item => item.name)).toEqual(["explicit-skill"]);
	});

	test("explicit-home loading excludes home marketplace roots when profile differs", async () => {
		const pluginPath = path.join(home, "marketplace-plugin");
		await makeSkill(path.join(pluginPath, "skills"), "leaked-skill");
		await writeFile(
			path.join(home, ".gjc", "plugins", "installed_plugins.json"),
			JSON.stringify({
				version: 2,
				plugins: {
					"leak@market": [{ installPath: pluginPath, version: "1.0.0", scope: "user", enabled: true }],
				},
			}),
		);

		const result = await loadCapabilityForHome<Skill>(skillCapability.id, home, { cwd: project, agentDir: profile });
		expect(result.items.map(item => item.name)).not.toContain("leaked-skill");
	});

	test("capability loading derives an omitted agent directory from the owning settings", async () => {
		const decoyAgentDir = path.join(tempDir, "process-global-decoy");
		await writeFile(path.join(profile, "SYSTEM.md"), "# settings-owned system");
		await writeFile(path.join(decoyAgentDir, "SYSTEM.md"), "# global decoy system");
		setAgentDir(decoyAgentDir);

		const result = await loadCapability<SystemPrompt>(systemPromptCapability.id, {
			cwd: project,
			settings: Settings.isolated({}, { agentDir: profile }),
			providers: ["native"],
		});

		expect(result.items.map(item => item.content)).toEqual(["# settings-owned system"]);
	});

	test("public SDK context and prompt wrappers keep agent location and settings authority together", async () => {
		await writeFile(path.join(profile, "AGENTS.md"), "profile agents authority marker");
		await writeFile(path.join(profile, "SYSTEM.md"), "profile system authority marker");
		const enabled = Settings.isolated({ disabledProviders: [] });
		const disabled = Settings.isolated({ disabledProviders: ["native"] });

		const enabledContext = await discoverSdkContextFiles(project, profile, enabled);
		const disabledContext = await discoverSdkContextFiles(project, profile, disabled);
		const enabledPrompt = await buildSdkSystemPrompt({ cwd: project, agentDir: profile, settings: enabled });
		const disabledPrompt = await buildSdkSystemPrompt({ cwd: project, agentDir: profile, settings: disabled });

		expect(enabledContext.map(item => item.content)).toContain("profile agents authority marker");
		expect(disabledContext.map(item => item.content)).not.toContain("profile agents authority marker");
		expect(enabledPrompt.systemPrompt.join("\n")).toContain("profile system authority marker");
		expect(disabledPrompt.systemPrompt.join("\n")).not.toContain("profile system authority marker");
	});

	test("user SYSTEM.md is read from the agent directory, not the home-relative default", async () => {
		await writeFile(path.join(profile, "SYSTEM.md"), "# profile system prompt");
		// Decoy in the home-relative default location: must stay unread.
		await writeFile(path.join(home, ".gjc", "agent", "SYSTEM.md"), "# default-profile decoy");

		const load = nativeProvider(systemPromptCapability.id) as (
			ctx: LoadContext,
		) => Promise<{ items: SystemPrompt[] }>;
		const { items } = await load({ cwd: project, home, repoRoot: project, userAgentDir: profile });

		expect(items.map(item => item.content)).toEqual(["# profile system prompt"]);
		expect(items[0]?.path).toBe(path.join(profile, "SYSTEM.md"));
	});

	test("user RULES.md is read from the agent directory, not the home-relative default", async () => {
		await writeFile(path.join(profile, "RULES.md"), "profile rules body");
		await writeFile(path.join(home, ".gjc", "agent", "RULES.md"), "default-profile decoy");

		const load = nativeProvider(ruleCapability.id) as (ctx: LoadContext) => Promise<{ items: Rule[] }>;
		const { items } = await load({ cwd: project, home, repoRoot: project, userAgentDir: profile });
		const sticky = items.find(rule => rule.name === "RULES");

		expect(sticky?.path).toBe(path.join(profile, "RULES.md"));
		expect(items.every(rule => rule.path !== path.join(home, ".gjc", "agent", "RULES.md"))).toBe(true);
	});

	test("discovery scans only the profile's skills; the default profile's skills do not leak in", async () => {
		await makeSkill(path.join(profile, "skills"), "profile-skill");
		await makeSkill(path.join(home, ".gjc", "agent", "skills"), "default-profile-skill");

		const load = nativeProvider(skillCapability.id) as (ctx: LoadContext) => Promise<{ items: Skill[] }>;
		const { items } = await load({ cwd: project, home, repoRoot: project, userAgentDir: profile });

		expect(items.map(skill => skill.name)).toEqual(["profile-skill"]);
	});

	test("a hostile mocked HOME cannot inject user skills under a profile", async () => {
		const hostileHome = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-4769-hostile-home-"));
		vi.spyOn(os, "homedir").mockReturnValue(hostileHome);
		await makeSkill(path.join(hostileHome, ".gjc", "agent", "skills"), "hostile-skill");
		await makeSkill(path.join(hostileHome, ".gjc", "skills"), "hostile-legacy-skill");

		const load = nativeProvider(skillCapability.id) as (ctx: LoadContext) => Promise<{ items: Skill[] }>;
		const { items } = await load({ cwd: project, home, repoRoot: project, userAgentDir: profile });

		expect(items.map(skill => skill.name)).toEqual([]);
	});

	test("default profile keeps scanning the home-relative legacy roots", async () => {
		const defaultAgentDir = path.join(home, ".gjc", "agent");
		await makeSkill(path.join(defaultAgentDir, "skills"), "canonical-skill");
		await makeSkill(path.join(home, ".gjc", "skills"), "legacy-skill");

		const load = nativeProvider(skillCapability.id) as (ctx: LoadContext) => Promise<{ items: Skill[] }>;
		const { items } = await load({ cwd: project, home, repoRoot: project, userAgentDir: defaultAgentDir });

		expect(items.map(skill => skill.name).sort()).toEqual(["canonical-skill", "legacy-skill"]);
	});

	test("custom profile authority stays sticky when a HOME refresh makes its path canonical", async () => {
		const refreshedHome = path.join(tempDir, "refreshed-home");
		const customProfile = path.join(refreshedHome, ".gjc", "agent");
		await fs.mkdir(refreshedHome, { recursive: true });
		const homeSpy = vi.spyOn(os, "homedir").mockReturnValue(home);

		setAgentDir(customProfile);
		expect(getAgentProfileAuthority()).toBe("custom");
		await makeSkill(path.join(customProfile, "skills"), "profile-after-refresh");

		homeSpy.mockReturnValue(refreshedHome);
		expect(getAgentDir()).toBe(customProfile);
		expect(getAgentProfileAuthority()).toBe("custom");
		await makeSkill(path.join(refreshedHome, ".gjc", "skills"), "default-legacy-decoy");

		const result = await loadCapability<Skill>(skillCapability.id, {
			cwd: project,
			agentDir: customProfile,
			providers: ["native"],
		});
		expect(result.items.map(skill => skill.name)).toEqual(["profile-after-refresh"]);

		const profileAuthority = getAgentProfileAuthority();
		const policy = { enabled: true, trustProjectSkills: true, trustUserSkills: true };
		const discovered = await discoverRuntimeSkills({
			cwd: project,
			home: refreshedHome,
			agentDir: customProfile,
			profileAuthority,
			policy,
		});
		expect(discovered.candidates.map(skill => skill.name)).toEqual(["profile-after-refresh"]);

		const managed = await listNativeSkillsForManagement({
			cwd: project,
			home: refreshedHome,
			agentDir: customProfile,
			profileAuthority,
			policy,
		});
		expect(managed.map(skill => skill.name)).toEqual(["profile-after-refresh"]);
	});
});

describe("issue #4769: every writer is discovered by every reader", () => {
	test("session startup threads its explicit profile to every native reader", async () => {
		const decoy = path.join(tempDir, "decoy-agent-dir");
		await makeSkill(path.join(profile, "skills"), "session-profile-skill", "Session profile skill");
		await makeSkill(path.join(decoy, "skills"), "session-decoy-skill", "Process-global decoy skill");
		await writeFile(path.join(profile, "SYSTEM.md"), "# session profile system");
		await writeFile(path.join(decoy, "SYSTEM.md"), "# process-global decoy system");
		await writeFile(path.join(profile, "RULES.md"), "session profile rules");
		await writeFile(path.join(decoy, "RULES.md"), "process-global decoy rules");
		await writeFile(path.join(profile, "AGENTS.md"), "session profile agents");
		await writeFile(path.join(decoy, "AGENTS.md"), "process-global decoy agents");

		setAgentDir(decoy);
		const scopedSettings = await Settings.loadForScope({ cwd: project, agentDir: profile });
		const { session } = await createAgentSession({
			cwd: project,
			agentDir: profile,
			sessionManager: SessionManager.inMemory(),
			settings: scopedSettings,
			enableMCP: false,
			enableLsp: false,
		});
		try {
			expect(session.skills.map(skill => skill.name)).toContain("session-profile-skill");
			expect(session.skills.map(skill => skill.name)).not.toContain("session-decoy-skill");
			const prompt = session.systemPrompt.join("\n");
			expect(prompt).toContain("session profile system");
			expect(prompt).toContain("session profile agents");
			expect(prompt).not.toContain("process-global decoy system");
			expect(prompt).not.toContain("process-global decoy agents");
		} finally {
			await session.dispose();
			await scopedSettings.close();
		}
	});

	test("writeNativeSkill(user) targets the agent dir and is listed, discovered, and loaded", async () => {
		const receipt = await writeNativeSkill({
			cwd: project,
			scope: "user",
			name: "writer-skill",
			content: ["---", "name: writer-skill", "description: written by gjc skill", "---", "", "# writer"].join("\n"),
			agentDir: profile,
		});
		expect(receipt.path).toBe(path.join(profile, "skills", "writer-skill", "SKILL.md"));

		// skill-management reader
		const records = await listNativeSkillsForManagement({ cwd: project, home, agentDir: profile });
		const record = records.find(r => r.name === "writer-skill");
		expect(record).toMatchObject({ scope: "user", enabled: true, path: receipt.path });

		// runtime skill discovery reader
		const discovered = await discoverRuntimeSkills({
			cwd: project,
			home,
			agentDir: profile,
			policy: { enabled: true, trustUserSkills: true },
		});
		expect(discovered.candidates.map(c => c.name)).toContain("writer-skill");

		const byName = await findRuntimeSkillByName(project, "writer-skill", { enabled: true }, home, profile);
		expect(byName?.filePath).toBe(receipt.path);

		// capability/session reader
		setAgentDir(profile);
		const { skills } = await loadSkills({ cwd: project });
		expect(skills.map(skill => skill.name)).toContain("writer-skill");
	});

	test("gjc migrate writes user skills into the agent dir and discovery finds them", async () => {
		const sourceHome = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-4769-migrate-home-"));
		await makeSkill(path.join(sourceHome, ".claude", "skills"), "migrated-skill");

		setAgentDir(profile);
		const report = await runMigrate({
			from: ["claude-code"],
			force: false,
			dryRun: false,
			homeDir: sourceHome,
			project: false,
			json: false,
			cwd: project,
		});
		expect(report.actions.length).toBeGreaterThan(0);

		const migratedPath = path.join(profile, "skills", "migrated-skill", "SKILL.md");
		expect(await fs.readFile(migratedPath, "utf8")).toContain("migrated-skill");

		const { skills } = await loadSkills({ cwd: project });
		expect(skills.map(skill => skill.name)).toContain("migrated-skill");
		await safeRm(sourceHome, { recursive: true, force: true });
	});

	test("session slash-command discovery stays on the explicit profile", async () => {
		await writeFile(
			path.join(profile, "commands", "profile-command.md"),
			["---", "description: profile command", "---", "", "profile body"].join("\n"),
		);
		await writeFile(
			path.join(home, ".gjc", "agent", "commands", "decoy-command.md"),
			["---", "description: decoy command", "---", "", "decoy body"].join("\n"),
		);

		const commands = await loadSlashCommands({ cwd: project, agentDir: profile });
		expect(commands.map(command => command.name)).toEqual(["profile-command", "init"]);
		const destination = path.join(tempDir, "destination-slash");
		await writeFile(
			path.join(destination, ".gjc", "commands", "destination-command.md"),
			["---", "description: destination command", "---", "", "destination body"].join("\n"),
		);
		const destinationCommands = await discoverSdkSlashCommands(destination, profile);
		expect(destinationCommands.map(command => command.name)).toContain("destination-command");
		expect(destinationCommands.map(command => command.name)).not.toContain("decoy-command");
	});

	test("custom command discovery stays on the explicit profile while including project commands", async () => {
		const ambientAgentDir = path.join(home, ".gjc", "agent");
		const writeCommand = async (root: string, name: string): Promise<void> => {
			await writeFile(path.join(root, name, "index.ts"), "export default () => [];\n");
		};

		await writeCommand(path.join(profile, "commands"), "profile-custom");
		await writeCommand(path.join(ambientAgentDir, "commands"), "ambient-custom");
		await writeCommand(path.join(project, ".gjc", "commands"), "project-custom");

		vi.spyOn(os, "homedir").mockReturnValue(home);
		const result = await discoverCustomCommands({ cwd: project, agentDir: profile });
		const discovered = result.paths.map(entry => entry.path).sort();

		expect(discovered).toEqual(
			[
				path.join(profile, "commands", "profile-custom", "index.ts"),
				path.join(project, ".gjc", "commands", "project-custom", "index.ts"),
			].sort(),
		);
		expect(discovered).not.toContain(path.join(ambientAgentDir, "commands", "ambient-custom", "index.ts"));
	});

	test("loaded hook exec follows the destination cwd supplied after rescope", async () => {
		const destination = path.join(tempDir, "destination");
		await fs.mkdir(destination, { recursive: true });
		const hookPath = path.join(tempDir, "cwd-hook.ts");
		await writeFile(
			hookPath,
			'export default api => { api.on("agent_start", async (_event, _context) => api.exec("pwd", [])); };\n',
		);
		const loaded = await loadHooks([hookPath], project);
		loaded.hooks[0]?.setCwd?.(destination);
		const handler = loaded.hooks[0]?.handlers.get("agent_start")?.[0];
		expect(handler).toBeDefined();
		const result = (await handler!({}, { cwd: destination } as never)) as { code: number; stdout: string };
		expect(result).toMatchObject({ code: 0 });
		expect(result.stdout.trim()).toBe(destination);
	});
});
