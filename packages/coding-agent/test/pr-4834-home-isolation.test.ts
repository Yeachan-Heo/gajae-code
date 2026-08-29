import { afterEach, beforeEach, describe, expect, test, vi } from "bun:test";
import type * as buffer from "node:buffer";
import type * as nfs from "node:fs";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { initializeWithSettings, loadCapability, loadCapabilityForHome } from "@gajae-code/coding-agent/capability";
import { type ContextFile, contextFileCapability } from "@gajae-code/coding-agent/capability/context-file";
import { type Extension, extensionCapability } from "@gajae-code/coding-agent/capability/extension";
import { type ExtensionModule, extensionModuleCapability } from "@gajae-code/coding-agent/capability/extension-module";
import { clearCache, readFile } from "@gajae-code/coding-agent/capability/fs";
import { hookCapability } from "@gajae-code/coding-agent/capability/hook";
import { type Rule, ruleCapability } from "@gajae-code/coding-agent/capability/rule";
import { settingsCapability } from "@gajae-code/coding-agent/capability/settings";
import { type Skill, skillCapability } from "@gajae-code/coding-agent/capability/skill";
import { type SlashCommand, slashCommandCapability } from "@gajae-code/coding-agent/capability/slash-command";
import { type SSHHost, sshCapability } from "@gajae-code/coding-agent/capability/ssh";
import { type SystemPrompt, systemPromptCapability } from "@gajae-code/coding-agent/capability/system-prompt";
import { toolCapability } from "@gajae-code/coding-agent/capability/tool";
import { getAgentDir, resetAgentDirFromEnvironment, setAgentDir } from "@gajae-code/utils";
import { Settings } from "../src/config/settings";
// Register all discovery providers as a side effect.
import { cleanupTempHome } from "./helpers/temp-home-cleanup";
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
	project = path.join(home, "project");
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

	test("omitting originalAgentDir from temp-home cleanup leaves a pre-existing profile override in place", () => {
		const marker = path.join(tempDir, "preexisting-profile");
		process.env.GJC_CODING_AGENT_DIR = marker;
		resetAgentDirFromEnvironment();

		cleanupTempHome(() => ({
			tempDir: "",
			tempHomeDir: "",
			originalHome: process.env.HOME,
		}))();

		expect(process.env.GJC_CODING_AGENT_DIR).toBe(marker);
		expect(getAgentDir()).toBe(marker);
	});

	test("explicit home resolves a relative cwd before walking to the repository root", async () => {
		await writeFile(path.join(project, ".gjc", "SYSTEM.md"), "# project system");
		const relativeProject = path.relative(process.cwd(), project);

		const result = await loadCapabilityForHome<SystemPrompt>(systemPromptCapability.id, home, {
			cwd: relativeProject,
			providers: ["native"],
		});

		expect(result.items.map(item => item.content)).toEqual(["# project system"]);
	});

	test("explicit home rejects a cwd whose canonical path is outside the supplied home", async () => {
		const outside = path.join(tempDir, "outside-project");
		await fs.mkdir(outside, { recursive: true });

		await expect(
			loadCapabilityForHome<SystemPrompt>(systemPromptCapability.id, home, {
				cwd: outside,
				providers: ["native"],
			}),
		).rejects.toThrow(/cwd is outside the supplied home/);
	});

	test("explicit home rejects a cwd symlink that escapes into a decoy project", async () => {
		const decoyProject = path.join(tempDir, "process-decoy", "project");
		await writeFile(path.join(decoyProject, ".gjc", "SYSTEM.md"), "# decoy system");
		const symlinkedCwd = path.join(home, "project-link");
		await fs.symlink(decoyProject, symlinkedCwd, "dir");

		const reads = new Set<string>();
		const realReaddir = fs.readdir.bind(fs);
		vi.spyOn(fs, "readdir").mockImplementation(((target: nfs.PathLike, options?: nfs.ObjectEncodingOptions) => {
			reads.add(path.resolve(String(target)));
			return realReaddir(target, options);
		}) as unknown as typeof fs.readdir);
		const realBunFile = Bun.file.bind(Bun) as (target: string | URL | number) => Bun.BunFile;
		vi.spyOn(Bun, "file").mockImplementation(((target: string | URL | number) => {
			if (typeof target !== "number") reads.add(path.resolve(String(target)));
			return realBunFile(target);
		}) as unknown as typeof Bun.file);

		const result = await loadCapabilityForHome<SystemPrompt>(systemPromptCapability.id, home, {
			cwd: symlinkedCwd,
			providers: ["native"],
		}).catch(() => undefined);

		expect(result?.items ?? []).toEqual([]);
		const canonicalReads = await Promise.all([...reads].map(filePath => fs.realpath(filePath).catch(() => filePath)));
		expect(
			canonicalReads.filter(
				filePath => filePath === decoyProject || filePath.startsWith(`${decoyProject}${path.sep}`),
			),
		).toEqual([]);
	});

	test("explicit-home leaf reads bypass a poisoned lexical cache entry", async () => {
		const decoyFile = path.join(tempDir, "process-decoy", "SYSTEM.md");
		const isolatedFile = path.join(home, ".gjc", "agent", "SYSTEM.md");
		await writeFile(decoyFile, "# decoy system");
		await fs.mkdir(path.dirname(isolatedFile), { recursive: true });
		await fs.symlink(decoyFile, isolatedFile, "file");

		// An ordinary read intentionally populates the legacy lexical cache with
		// the symlink target. The isolated provider read must canonicalize at the
		// leaf seam and reject that target instead of reusing the poisoned entry.
		expect(await readFile(isolatedFile)).toBe("# decoy system");
		const result = await loadCapabilityForHome<SystemPrompt>(systemPromptCapability.id, home, {
			cwd: project,
			providers: ["native"],
		});

		expect(result.items).toEqual([]);
		expect(result.warnings).toEqual([]);
	});

	test("explicit home native project discovery stays on the fixed .gjc root", async () => {
		const originalGjcConfigDir = process.env.GJC_CONFIG_DIR;
		const originalPiConfigDir = process.env.PI_CONFIG_DIR;
		try {
			process.env.GJC_CONFIG_DIR = ".gjc-alt";
			delete process.env.PI_CONFIG_DIR;

			const decoyProject = path.join(tempDir, "process-decoy", "project");
			await writeFile(path.join(decoyProject, ".gjc", "SYSTEM.md"), "# decoy system");
			await fs.symlink(path.join(decoyProject, ".gjc"), path.join(project, ".gjc"), "dir");
			await writeFile(path.join(project, ".gjc-alt", "SYSTEM.md"), "# configured project system");

			await expect(
				loadCapabilityForHome<SystemPrompt>(systemPromptCapability.id, home, {
					cwd: project,
					providers: ["native"],
				}),
			).rejects.toThrow(/project registry root/);
		} finally {
			if (originalGjcConfigDir === undefined) delete process.env.GJC_CONFIG_DIR;
			else process.env.GJC_CONFIG_DIR = originalGjcConfigDir;
			if (originalPiConfigDir === undefined) delete process.env.PI_CONFIG_DIR;
			else process.env.PI_CONFIG_DIR = originalPiConfigDir;
		}
	});

	test("explicit home fails closed when its .gjc root redirects outside the profile", async () => {
		const decoyRoot = path.join(tempDir, "decoy-profile", ".gjc");
		await seedProfile(path.join(decoyRoot, "agent"), "decoy");
		await fs.symlink(decoyRoot, path.join(home, ".gjc"), "dir");

		await expect(
			loadCapabilityForHome<SystemPrompt>(systemPromptCapability.id, home, {
				cwd: project,
				providers: ["native"],
			}),
		).rejects.toThrow(/config root|user agent directory/);
	});

	test("explicit home fails closed when its agent or plugin roots redirect outside the profile", async () => {
		const decoyRoot = path.join(tempDir, "decoy-profile", ".gjc");
		await fs.mkdir(path.join(home, ".gjc"), { recursive: true });
		await seedProfile(path.join(decoyRoot, "agent"), "decoy");
		await fs.symlink(path.join(decoyRoot, "agent"), path.join(home, ".gjc", "agent"), "dir");

		await expect(
			loadCapabilityForHome<SystemPrompt>(systemPromptCapability.id, home, {
				cwd: project,
				providers: ["native"],
			}),
		).rejects.toThrow(/user agent directory/);

		await fs.rm(path.join(home, ".gjc", "agent"), { recursive: true, force: true });
		await fs.mkdir(path.join(decoyRoot, "plugins"), { recursive: true });
		await fs.symlink(path.join(decoyRoot, "plugins"), path.join(home, ".gjc", "plugins"), "dir");
		await expect(
			loadCapabilityForHome<Skill>(skillCapability.id, home, {
				cwd: project,
				providers: ["claude-plugins"],
			}),
		).rejects.toThrow(/plugin registry root/);
	});

	test("explicit home fails closed when a non-native provider root redirects outside the profile", async () => {
		const decoyGemini = path.join(tempDir, "decoy-profile", ".gemini");
		await writeFile(path.join(decoyGemini, "GEMINI.md"), "# decoy gemini");
		await fs.symlink(decoyGemini, path.join(home, ".gemini"), "dir");

		await expect(
			loadCapabilityForHome<SystemPrompt>(systemPromptCapability.id, home, {
				cwd: project,
				providers: ["gemini"],
			}),
		).rejects.toThrow(/gemini user root/);

		await fs.rm(path.join(home, ".gemini"), { recursive: true, force: true });
		const decoyOpenCode = path.join(tempDir, "decoy-profile", ".opencode");
		await writeFile(
			path.join(decoyOpenCode, "commands", "decoy.md"),
			["---", "description: decoy", "---", "", "decoy"].join("\n"),
		);
		await fs.symlink(decoyOpenCode, path.join(project, ".opencode"), "dir");

		await expect(
			loadCapabilityForHome<SlashCommand>(slashCommandCapability.id, home, {
				cwd: project,
				providers: ["opencode"],
			}),
		).rejects.toThrow(/opencode project root/);
	});

	test.skipIf(process.platform === "win32")(
		"explicit Gemini leaf reads reject symlinks outside the supplied home",
		async () => {
			const outsideGemini = path.join(tempDir, "outside-gemini.md");
			const suppliedGemini = path.join(home, ".gemini", "GEMINI.md");
			await writeFile(outsideGemini, "# outside gemini");
			await fs.mkdir(path.dirname(suppliedGemini), { recursive: true });
			await fs.symlink(outsideGemini, suppliedGemini, "file");

			const result = await loadCapabilityForHome<ContextFile>(contextFileCapability.id, home, {
				cwd: project,
				providers: ["gemini"],
			});

			expect(result.items).toEqual([]);
			expect(result.items.some(item => item.content.includes("outside gemini"))).toBe(false);
		},
	);

	test.skipIf(process.platform === "win32")(
		"explicit Gemini directory reads reject a symlinked extension root",
		async () => {
			const outsideExtensions = path.join(tempDir, "outside-gemini-extensions");
			const suppliedExtensions = path.join(home, ".gemini", "extensions");
			await writeFile(
				path.join(outsideExtensions, "external", "gemini-extension.json"),
				JSON.stringify({ name: "external-extension" }),
			);
			await fs.mkdir(path.dirname(suppliedExtensions), { recursive: true });
			await fs.symlink(outsideExtensions, suppliedExtensions, "dir");

			const result = await loadCapabilityForHome<Extension>(extensionCapability.id, home, {
				cwd: project,
				providers: ["gemini"],
			});

			expect(result.items).toEqual([]);
			expect(result.items.some(item => item.name === "external-extension")).toBe(false);
		},
	);

	test.skipIf(process.platform === "win32")(
		"project agents reads never authorize an external agent directory",
		async () => {
			const externalAgentDir = path.join(tempDir, "external-agent");
			const externalProjectAgents = path.join(externalAgentDir, ".agent");
			await writeFile(path.join(externalProjectAgents, "AGENTS.md"), "# external project agents");
			await fs.symlink(externalProjectAgents, path.join(project, ".agent"), "dir");

			await expect(
				loadCapabilityForHome<ContextFile>(contextFileCapability.id, home, {
					cwd: project,
					agentDir: externalAgentDir,
					providers: ["agents"],
				}),
			).rejects.toThrow(/agents project root/);
		},
	);

	test("explicit home validates only effective providers", async () => {
		const decoyGemini = path.join(tempDir, "decoy-profile", ".gemini");
		await writeFile(path.join(decoyGemini, "GEMINI.md"), "# decoy gemini");
		await fs.symlink(decoyGemini, path.join(home, ".gemini"), "dir");

		const result = await loadCapabilityForHome<SystemPrompt>(systemPromptCapability.id, home, {
			cwd: project,
			providers: ["native"],
			excludeProviders: ["gemini"],
		});

		expect(result.items).toEqual([]);
	});

	test("explicit home rejects absolute and parent-escaping extension settings paths", async () => {
		const outsideAbsolute = path.join(tempDir, "outside-absolute.ts");
		const outsideRelative = path.join(tempDir, "outside-relative.ts");
		await writeFile(outsideAbsolute, "export default {};\n");
		await writeFile(outsideRelative, "export default {};\n");
		await writeFile(
			path.join(home, ".gjc", "agent", "settings.json"),
			JSON.stringify({ extensions: [outsideAbsolute, path.relative(project, outsideRelative)] }),
		);

		const result = await loadCapabilityForHome<ExtensionModule>(extensionModuleCapability.id, home, {
			cwd: project,
			providers: ["native"],
		});

		expect(result.items).toEqual([]);
		expect(result.warnings).toHaveLength(2);
		expect(result.warnings.every(warning => warning.includes("escapes isolated home"))).toBe(true);
	});

	test("explicit home ignores absolute and parent-escaping manifest extension paths", async () => {
		const outsideAbsolute = path.join(tempDir, "manifest-outside-absolute.ts");
		const outsideRelative = path.join(tempDir, "manifest-outside-relative.ts");
		await writeFile(outsideAbsolute, "export default {};\n");
		await writeFile(outsideRelative, "export default {};\n");
		const manifestDir = path.join(home, ".gjc", "agent", "extensions", "declared");
		await writeFile(
			path.join(manifestDir, "package.json"),
			JSON.stringify({ gjc: { extensions: [outsideAbsolute, path.relative(manifestDir, outsideRelative)] } }),
		);

		const result = await loadCapabilityForHome<ExtensionModule>(extensionModuleCapability.id, home, {
			cwd: project,
			providers: ["native"],
		});

		expect(result.items).toEqual([]);
	});

	test("explicit home excludes symlinked native extension candidates outside the profile", async () => {
		const extensionsDir = path.join(home, ".gjc", "agent", "extensions");
		const directTarget = path.join(tempDir, "outside-direct.ts");
		const indexTarget = path.join(tempDir, "outside-index.ts");
		const manifestTarget = path.join(tempDir, "outside-manifest.ts");
		await writeFile(directTarget, "export default {};");
		await writeFile(indexTarget, "export default {};");
		await writeFile(manifestTarget, "export default {};");
		await fs.mkdir(path.join(extensionsDir, "indexed"), { recursive: true });
		await fs.mkdir(path.join(extensionsDir, "declared"), { recursive: true });
		await fs.symlink(directTarget, path.join(extensionsDir, "direct.ts"), "file");
		await fs.symlink(indexTarget, path.join(extensionsDir, "indexed", "index.ts"), "file");
		await fs.symlink(manifestTarget, path.join(extensionsDir, "declared", "outside.ts"), "file");
		await writeFile(
			path.join(extensionsDir, "declared", "package.json"),
			JSON.stringify({ gjc: { extensions: ["./outside.ts"] } }),
		);

		const result = await loadCapabilityForHome<ExtensionModule>(extensionModuleCapability.id, home, {
			cwd: project,
			providers: ["native"],
		});

		expect(result.items).toEqual([]);
		expect(result.warnings).toEqual([]);
	});

	test("explicit home uses the physical home boundary for nested non-Git projects", async () => {
		const physicalHome = path.join(tempDir, "physical-home");
		const symlinkedHome = path.join(tempDir, "symlinked-home");
		const nestedProject = path.join(physicalHome, "nested-project");
		await fs.mkdir(path.join(nestedProject, "child"), { recursive: true });
		await fs.symlink(physicalHome, symlinkedHome, "dir");
		await writeFile(path.join(nestedProject, ".gjc", "SYSTEM.md"), "# nested project system");

		const result = await loadCapabilityForHome<SystemPrompt>(systemPromptCapability.id, symlinkedHome, {
			cwd: path.join(symlinkedHome, "nested-project", "child"),
			providers: ["native"],
		});

		expect(result.items.map(item => item.content)).toEqual(["# nested project system"]);
		expect(result.items[0]?._source.path).toBe(path.join(nestedProject, ".gjc", "SYSTEM.md"));
	});

	test("explicit home does not walk a no-repo cwd into unrelated ancestors", async () => {
		await writeFile(path.join(tempDir, ".gjc", "SYSTEM.md"), "# unrelated ancestor system");
		clearCache();
		const result = await loadCapabilityForHome<SystemPrompt>(systemPromptCapability.id, home, {
			cwd: project,
			providers: ["native"],
		});
		expect(result.items).toEqual([]);
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
		const realBunFile = Bun.file;
		type ReaddirOptions =
			| (nfs.ObjectEncodingOptions & { withFileTypes?: boolean; recursive?: boolean })
			| BufferEncoding
			| null;
		type ReaddirResult = string[] | buffer.NonSharedBuffer[] | nfs.Dirent[];
		const passthroughReaddir = realReaddir.bind(fs) as unknown as (
			t: nfs.PathLike,
			options?: ReaddirOptions,
		) => Promise<ReaddirResult>;
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
		vi.spyOn(fs, "readdir").mockImplementation(((target: nfs.PathLike, options?: ReaddirOptions) => {
			reads.add(path.resolve(String(target)));
			return passthroughReaddir(target, options);
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
		const passthroughBunFile = realBunFile.bind(Bun) as (target: string | URL | number) => Bun.BunFile;
		vi.spyOn(Bun, "file").mockImplementation(((target: string | URL | number) => {
			const file = passthroughBunFile(target);
			const recordPath = () => {
				if (typeof target !== "number") reads.add(path.resolve(String(target)));
			};
			return new Proxy(file, {
				get(fileTarget, property, receiver) {
					if (property === "text") {
						return async () => {
							recordPath();
							return fileTarget.text();
						};
					}
					if (property === "slice") {
						return (start?: number, end?: number) => {
							recordPath();
							return fileTarget.slice(start, end);
						};
					}
					return Reflect.get(fileTarget, property, receiver);
				},
			});
		}) as unknown as typeof Bun.file);
		clearCache();

		const loadedCapabilities = await Promise.all(
			ALL_CAPABILITIES.map(
				async capabilityId => [capabilityId, await loadCapabilityForHome(capabilityId, home, options)] as const,
			),
		);
		for (const [capabilityId, result] of loadedCapabilities) {
			expect(Array.isArray(result.items), `${capabilityId} should return items`).toBe(true);
			expect(Array.isArray(result.all), `${capabilityId} should return diagnostics`).toBe(true);
			expect(Array.isArray(result.providers), `${capabilityId} should return providers`).toBe(true);
			expect(result.warnings, `${capabilityId} should load without warnings`).toEqual([]);
		}

		const decoyReads = [...reads].filter(p => p.startsWith(decoyAgentDir));
		expect(decoyReads).toEqual([]);
	});

	test("explicit home ignores contaminated process provider and extension policy", async () => {
		const homeAgentDir = path.join(home, ".gjc", "agent");
		await seedProfile(homeAgentDir, "home");
		initializeWithSettings(Settings.isolated({ disabledProviders: ["native"], disabledExtensions: ["home-skill"] }));
		try {
			const options = { cwd: project, providers: ["native"] as string[] };
			const skills = await loadCapabilityForHome<Skill>(skillCapability.id, home, options);
			expect(skills.items.map(item => item.name)).toEqual(["home-skill"]);
			expect(skills.warnings).toEqual([]);
		} finally {
			initializeWithSettings(Settings.isolated());
		}
	});

	test("public loadCapability cannot use isolatedHome to bypass active provider and extension policy", async () => {
		await fs.mkdir(path.join(project, ".opencode", "commands"), { recursive: true });
		await writeFile(
			path.join(project, ".opencode", "commands", "ordinary-command.md"),
			["---", "description: ordinary command", "---", "", "ordinary body"].join("\n"),
		);

		initializeWithSettings(Settings.isolated({ disabledProviders: ["opencode"] }));
		try {
			const blockedProvider = await loadCapability<SlashCommand>(slashCommandCapability.id, {
				cwd: project,
				providers: ["opencode"],
				isolatedHome: true,
			});
			expect(blockedProvider.items).toEqual([]);
		} finally {
			initializeWithSettings(Settings.isolated());
		}

		initializeWithSettings(Settings.isolated({ disabledExtensions: ["slash-command:ordinary-command"] }));
		try {
			const blockedExtension = await loadCapability<SlashCommand>(slashCommandCapability.id, {
				cwd: project,
				providers: ["opencode"],
				isolatedHome: true,
			});
			expect(blockedExtension.items).toEqual([]);
		} finally {
			initializeWithSettings(Settings.isolated());
		}
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

	test("explicit agent directory remains authoritative when the default agent root escapes", async () => {
		const explicitAgentDir = path.join(tempDir, "explicit-agent-3");
		const decoyAgentDir = path.join(tempDir, "process-decoy", ".gjc", "agent");
		await seedProfile(explicitAgentDir, "explicit");
		await seedProfile(decoyAgentDir, "decoy");
		await fs.mkdir(path.join(home, ".gjc"), { recursive: true });
		await fs.symlink(decoyAgentDir, path.join(home, ".gjc", "agent"), "dir");

		const result = await loadCapabilityForHome<SystemPrompt>(systemPromptCapability.id, home, {
			cwd: project,
			agentDir: explicitAgentDir,
			providers: ["native"],
		});

		expect(result.items.map(item => item.content)).toEqual(["# explicit system"]);
	});

	test("explicit home scopes ssh-json user discovery away from the ambient profile", async () => {
		const homeAgentDir = path.join(home, ".gjc", "agent");
		const decoyAgentDir = path.join(tempDir, "process-decoy", ".gjc", "agent");
		await writeFile(
			path.join(homeAgentDir, "ssh.json"),
			JSON.stringify({ hosts: { home: { host: "home.example", username: "home-user" } } }),
		);
		await writeFile(
			path.join(decoyAgentDir, "ssh.json"),
			JSON.stringify({ hosts: { decoy: { host: "decoy.example", username: "decoy-user" } } }),
		);
		setAgentDir(decoyAgentDir);

		const reads = new Set<string>();
		const realReadFile = fs.readFile.bind(fs);
		vi.spyOn(fs, "readFile").mockImplementation(((filePath: Parameters<typeof fs.readFile>[0]) => {
			if (!(typeof filePath === "object" && "close" in filePath)) reads.add(path.resolve(String(filePath)));
			return realReadFile(filePath, "utf-8");
		}) as unknown as typeof fs.readFile);

		const result = await loadCapabilityForHome<SSHHost>(sshCapability.id, home, {
			cwd: project,
			providers: ["ssh-json"],
		});

		expect(result.items.map(item => item.name)).toEqual(["home"]);
		expect(result.items[0]?._source.path).toBe(path.join(homeAgentDir, "ssh.json"));
		expect([...reads].filter(filePath => filePath.startsWith(decoyAgentDir))).toEqual([]);
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
