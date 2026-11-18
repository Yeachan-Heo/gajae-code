import { afterEach, describe, expect, it, spyOn } from "bun:test";
import { execFile } from "node:child_process";
import { lstat, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import * as path from "node:path";
import { promisify } from "node:util";
import * as utils from "@gajae-code/utils";
import { getMemoriesDir } from "@gajae-code/utils";
import fc from "fast-check";
import { registerOwnedDeletionRoot, safeRm } from "../../../../scripts/safe-cleanup";
import { resetActiveRulesForTests, setActiveRules } from "../../src/capability/rule";
import { disposeAllShellSessions } from "../../src/exec/bash-executor";
import type { Skill } from "../../src/extensibility/skills";
import { resolveLocalUrlToPath } from "../../src/internal-urls";
import type { ToolSession } from "../../src/tools";
import { BashTool } from "../../src/tools/bash";
import {
	expandInternalUrls,
	expandSkillUrls,
	refuseShellBearingRulePath,
	resolveSkillUrl,
} from "../../src/tools/bash-skill-urls";
import { ToolError } from "../../src/tools/tool-errors";
import { stubBashExecutorSettings } from "../helpers/tool-session-settings";

/** Match bash skill expansion: real ancestor plus the components that do not exist yet. */
async function canonicalExistingPath(target: string): Promise<string> {
	const missing: string[] = [];
	let cursor = target;
	for (;;) {
		try {
			await lstat(cursor);
			return path.join(await realpath(cursor), ...missing);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		}
		const parent = path.dirname(cursor);
		if (parent === cursor) return target;
		missing.unshift(path.basename(cursor));
		cursor = parent;
	}
}

function shellEscape(p: string): string {
	return `'${p.replace(/'/g, "'\\''")}'`;
}

function createSkill(name: string, baseDir: string): Skill {
	const resolvedBaseDir = path.resolve(baseDir);
	return {
		name,
		description: `${name} description`,
		filePath: path.join(resolvedBaseDir, "SKILL.md"),
		baseDir: resolvedBaseDir,
		source: "test",
	};
}

function createInternalRouter(resources: Record<string, { sourcePath?: string; error?: string }>): {
	canHandle: (input: string) => boolean;
	resolve: (
		input: string,
	) => Promise<{ url: string; content: string; contentType: "text/plain"; sourcePath?: string; immutable: boolean }>;
} {
	return {
		canHandle: input => /^(agent|artifact|plan|memory|rule):\/\//.test(input),
		resolve: async input => {
			const entry = resources[input];
			if (!entry) {
				throw new Error(`No mapping for ${input}`);
			}
			if (entry.error) {
				throw new Error(entry.error);
			}
			return {
				url: input,
				content: "",
				contentType: "text/plain",
				sourcePath: entry.sourcePath,
				immutable: true,
			};
		},
	};
}

describe("expandSkillUrls", () => {
	it("expands a basic skill:// URI to an absolute path", () => {
		const skills = [createSkill("valid-skill", "/tmp/skills/valid-skill")];
		const command = "python skill://valid-skill/scripts/init.py";
		const expectedPath = path.join(skills[0].baseDir, "scripts/init.py");

		expect(expandSkillUrls(command, skills)).toBe(`python ${shellEscape(expectedPath)}`);
	});

	it("expands multiple skill:// URIs in one command", () => {
		const skills = [
			createSkill("first-skill", "/tmp/skills/first-skill"),
			createSkill("second-skill", "/tmp/skills/second-skill"),
		];
		const command = "cp skill://first-skill/a.txt skill://second-skill/b.txt";
		const firstPath = path.join(skills[0].baseDir, "a.txt");
		const secondPath = path.join(skills[1].baseDir, "b.txt");

		expect(expandSkillUrls(command, skills)).toBe(`cp ${shellEscape(firstPath)} ${shellEscape(secondPath)}`);
	});

	it("throws ToolError for unknown skills with available names", () => {
		const skills = [
			createSkill("first-skill", "/tmp/skills/first-skill"),
			createSkill("second-skill", "/tmp/skills/second-skill"),
		];

		expect(() => expandSkillUrls("python skill://missing/run.py", skills)).toThrow(
			"Unknown skill: missing. Available: first-skill, second-skill",
		);
	});

	it("throws ToolError for path traversal attempts", () => {
		const skills = [createSkill("valid-skill", "/tmp/skills/valid-skill")];

		expect(() => expandSkillUrls("cat skill://valid-skill/../../../etc/passwd", skills)).toThrow(
			"Path traversal (..) is not allowed in skill:// URLs",
		);
	});

	it("returns command unchanged when there are no skill:// tokens", () => {
		const skills = [createSkill("valid-skill", "/tmp/skills/valid-skill")];
		const command = "git status";

		expect(expandSkillUrls(command, skills)).toBe(command);
	});

	it("does not expand non-skill internal URIs", () => {
		const skills = [createSkill("valid-skill", "/tmp/skills/valid-skill")];
		const command = "echo agent://1 artifact://abc rule://security";

		expect(expandSkillUrls(command, skills)).toBe(command);
	});

	it("expands URI in double quotes", () => {
		const skills = [createSkill("valid-skill", "/tmp/skills/valid-skill")];
		const command = 'python "skill://valid-skill/scripts/init.py"';
		const expectedPath = path.join(skills[0].baseDir, "scripts/init.py");

		expect(expandSkillUrls(command, skills)).toBe(`python ${shellEscape(expectedPath)}`);
	});

	it("expands URI in single quotes", () => {
		const skills = [createSkill("valid-skill", "/tmp/skills/valid-skill")];
		const command = "python 'skill://valid-skill/scripts/init.py'";
		const expectedPath = path.join(skills[0].baseDir, "scripts/init.py");

		expect(expandSkillUrls(command, skills)).toBe(`python ${shellEscape(expectedPath)}`);
	});

	it("shell-escapes paths with spaces", () => {
		const skills = [createSkill("space-skill", "/tmp/skills/with space")];
		const command = "python skill://space-skill/scripts/my%20file.py";
		const expectedPath = path.join(skills[0].baseDir, "scripts/my file.py");

		expect(expandSkillUrls(command, skills)).toBe(`python ${shellEscape(expectedPath)}`);
	});

	it("shell-escapes paths containing single quotes", () => {
		const skills = [createSkill("quote-skill", "/tmp/skills/with'quote")];
		const command = "python skill://quote-skill/scripts/init.py";
		const expectedPath = path.join(skills[0].baseDir, "scripts/init.py");

		expect(expandSkillUrls(command, skills)).toBe(`python ${shellEscape(expectedPath)}`);
	});

	it("resolves skill://name with no relative path to SKILL.md", () => {
		const skills = [createSkill("valid-skill", "/tmp/skills/valid-skill")];
		const command = "cat skill://valid-skill";

		expect(expandSkillUrls(command, skills)).toBe(`cat ${shellEscape(skills[0].filePath)}`);
	});

	it("returns command unchanged when no skills are loaded", () => {
		const command = "python skill://valid-skill/scripts/init.py";
		expect(expandSkillUrls(command, [])).toBe(command);
	});

	it("throws ToolError when traversal is attempted with encoded segments", () => {
		const skills = [createSkill("valid-skill", "/tmp/skills/valid-skill")];
		expect(() => expandSkillUrls("cat skill://valid-skill/%2E%2E/%2E%2E/etc/passwd", skills)).toThrow(ToolError);
	});
});

describe("resolveSkillUrl skill selection", () => {
	it("keeps generated nested and prefix-similar roots from changing the named skill", () => {
		for (let seed = 0; seed < 64; seed++) {
			const baseDir = path.resolve(`/tmp/skill-url-property-${seed}/skills/outer-${seed}`);
			const selected = createSkill(`outer-${seed}`, baseDir);
			const nestedDir = path.join(baseDir, `inner-${seed}`);
			const nestedChildDir = path.join(nestedDir, `child-${seed}`);
			const unrelated = [
				createSkill(`inner-${seed}`, nestedDir),
				createSkill(`child-${seed}`, nestedChildDir),
				createSkill(`sibling-${seed}`, `${baseDir}-inner-${seed}`),
				createSkill(`other-${seed}`, path.resolve(`/tmp/other-skill-${seed}`)),
			];
			for (let index = unrelated.length - 1; index > 0; index--) {
				const swapWith = (seed * 7 + index * 3) % (index + 1);
				[unrelated[index], unrelated[swapWith]] = [unrelated[swapWith]!, unrelated[index]!];
			}
			const insertionIndex = seed % (unrelated.length + 1);
			unrelated.splice(insertionIndex, 0, selected);

			const url = `skill://${selected.name}/inner-${seed}/child-${seed}/file-${seed}.txt`;
			const resolved = resolveSkillUrl(url, unrelated);

			expect(resolved.skill).toBe(selected);
			expect(resolved.lexicalPath).toBe(path.join(baseDir, `inner-${seed}`, `child-${seed}`, `file-${seed}.txt`));
		}
	});
});

describe("expandInternalUrls", () => {
	it("expands context-free internal URLs in one command", async () => {
		const skills = [createSkill("valid-skill", "/tmp/skills/valid-skill")];
		const command = "cat skill://valid-skill/scripts/init.py";
		const expectedSkillPath = await canonicalExistingPath(path.join(skills[0].baseDir, "scripts/init.py"));

		await expect(expandInternalUrls(command, { skills })).resolves.toBe(`cat ${shellEscape(expectedSkillPath)}`);
	});

	it("rejects managed artifact and agent authority in subprocess commands", async () => {
		const router = createInternalRouter({
			"artifact://7": { sourcePath: "/tmp/artifacts/with'quote.log" },
			"agent://abc": { sourcePath: "/tmp/session/abc.md" },
		});
		await expect(expandInternalUrls('cat "artifact://7"', { skills: [], internalRouter: router })).rejects.toThrow(
			"artifact:// URLs cannot be expanded",
		);
		await expect(expandInternalUrls("echo agent://abc", { skills: [], internalRouter: router })).rejects.toThrow(
			"agent:// URLs cannot be expanded",
		);
	});

	it("expands local:// URLs to filesystem paths without requiring preexisting files", async () => {
		const localOptions = {
			getArtifactsDir: () => "/tmp/session-artifacts",
			getSessionId: () => "session-1",
		};
		const command = "mv /tmp/source.json local://handoffs/new-file.json";
		const expectedPath = await canonicalExistingPath(
			resolveLocalUrlToPath("local://handoffs/new-file.json", localOptions),
		);

		await expect(expandInternalUrls(command, { skills: [], localOptions })).resolves.toBe(
			`mv /tmp/source.json ${shellEscape(expectedPath)}`,
		);
	});

	it("expands local:/ (single-slash) URL in double quotes", async () => {
		const localOptions = {
			getArtifactsDir: () => "/tmp/session-artifacts",
			getSessionId: () => "session-1",
		};
		const command = 'cat "local:/PLAN.md"';
		const expectedPath = await canonicalExistingPath(resolveLocalUrlToPath("local:///PLAN.md", localOptions));

		await expect(expandInternalUrls(command, { skills: [], localOptions })).resolves.toBe(
			`cat ${shellEscape(expectedPath)}`,
		);
	});

	it("expands local:/ (single-slash) URL in single quotes", async () => {
		const localOptions = {
			getArtifactsDir: () => "/tmp/session-artifacts",
			getSessionId: () => "session-1",
		};
		const command = "cat 'local:/PLAN.md'";
		const expectedPath = await canonicalExistingPath(resolveLocalUrlToPath("local:///PLAN.md", localOptions));

		await expect(expandInternalUrls(command, { skills: [], localOptions })).resolves.toBe(
			`cat ${shellEscape(expectedPath)}`,
		);
	});

	it("expands local:/ (single-slash) URL without quotes", async () => {
		const localOptions = {
			getArtifactsDir: () => "/tmp/session-artifacts",
			getSessionId: () => "session-1",
		};
		const command = "cat local:/PLAN.md";
		const expectedPath = await canonicalExistingPath(resolveLocalUrlToPath("local:///PLAN.md", localOptions));

		await expect(expandInternalUrls(command, { skills: [], localOptions })).resolves.toBe(
			`cat ${shellEscape(expectedPath)}`,
		);
	});

	it("throws when local:// URL is used without local protocol options", async () => {
		await expect(expandInternalUrls("mv foo local://bar", { skills: [] })).rejects.toThrow(
			"Cannot resolve local:// URL in bash command: local protocol options are unavailable for this session.",
		);
	});

	it("rejects managed artifact URLs before router resolution", async () => {
		await expect(expandInternalUrls("cat artifact://1", { skills: [] })).rejects.toThrow(
			"artifact:// URLs cannot be expanded",
		);
	});

	it("throws when internal router resolves URL without sourcePath", async () => {
		const router = createInternalRouter({
			"rule://my-rule": {},
		});
		await expect(
			expandInternalUrls("cat rule://my-rule", {
				skills: [],
				internalRouter: router,
				sessionCwd: path.join(tmpdir(), "bash-url-session"),
			}),
		).rejects.toThrow("rule:// URL resolved without a filesystem path");
	});

	it("surfaces resolver errors with actionable context", async () => {
		const router = createInternalRouter({
			"rule://missing": { error: "Rule not found" },
		});
		await expect(
			expandInternalUrls("cat rule://missing", {
				skills: [],
				internalRouter: router,
				sessionCwd: path.join(tmpdir(), "bash-url-session"),
			}),
		).rejects.toThrow("Failed to resolve rule:// URL in bash command");
	});

	it("does not match local:/ inside filesystem paths (e.g. /repo/local:/PLAN.md)", async () => {
		const command = "cat /repo/local:/PLAN.md";
		await expect(expandInternalUrls(command, { skills: [] })).resolves.toBe(command);
	});

	it("does not match local:/ after ./ or ../ prefixes", async () => {
		const command = "cat ./local:/PLAN.md ../local:/other.md";
		await expect(expandInternalUrls(command, { skills: [] })).resolves.toBe(command);
	});

	it("still matches standalone local:/ at a real token boundary", async () => {
		const localOptions = {
			getArtifactsDir: () => "/tmp/session-artifacts",
			getSessionId: () => "session-1",
		};
		const command = "cat local:/PLAN.md";
		const expectedPath = await canonicalExistingPath(resolveLocalUrlToPath("local://PLAN.md", localOptions));
		await expect(expandInternalUrls(command, { skills: [], localOptions })).resolves.toBe(
			`cat ${shellEscape(expectedPath)}`,
		);
	});

	it("does not match local:/ when embedded in words (e.g., notlocal:/, mylocal:/)", async () => {
		const command1 = "cat notlocal:/PLAN.md";
		await expect(expandInternalUrls(command1, { skills: [] })).resolves.toBe(command1);

		const command2 = "cat mylocal:/data.json";
		await expect(expandInternalUrls(command2, { skills: [] })).resolves.toBe(command2);

		const command3 = "cat getlocal:/file.txt";
		await expect(expandInternalUrls(command3, { skills: [] })).resolves.toBe(command3);

		const localOptions = {
			getArtifactsDir: () => "/tmp/session-artifacts",
			getSessionId: () => "session-1",
		};
		await expect(expandInternalUrls(command1, { skills: [], localOptions })).resolves.toBe(command1);
	});

	it("does not match local:/ after a hyphen (e.g. not-local:/PLAN.md)", async () => {
		const command = "cat not-local:/PLAN.md";
		await expect(expandInternalUrls(command, { skills: [] })).resolves.toBe(command);

		const localOptions = {
			getArtifactsDir: () => "/tmp/session-artifacts",
			getSessionId: () => "session-1",
		};
		await expect(expandInternalUrls(command, { skills: [], localOptions })).resolves.toBe(command);
	});
});

const execFileAsync = promisify(execFile);
const PROPERTY_SEED = 481703;

async function symlinkCreationSupported(): Promise<boolean> {
	const windows = process.platform === "win32";
	if (windows) {
		return false;
	}
	const dir = await mkdtemp(path.join(tmpdir(), "bash-symlink-probe-"));
	try {
		const target = path.join(dir, "target");
		await writeFile(target, "t");
		await symlink(target, path.join(dir, "link"));
		return true;
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code;
		const denied = code === "EPERM" || code === "EACCES";
		if (denied) return false;
		throw error;
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
}

const symlinkSupported = await symlinkCreationSupported();

async function withGrantedHomeRoot(body: (root: string) => Promise<void>): Promise<void> {
	const name = `.gjc-bash-ancestor-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
	let canonicalBase = homedir();
	try {
		canonicalBase = await realpath(homedir());
	} catch {
		canonicalBase = homedir();
	}
	const root = path.join(canonicalBase, name);
	const forget = registerOwnedDeletionRoot(root);
	await mkdir(root);
	try {
		await body(path.join(homedir(), name));
	} finally {
		await safeRm(root, { recursive: true, force: true });
		forget();
	}
}

async function homeChildWritable(): Promise<boolean> {
	try {
		await withGrantedHomeRoot(async () => {});
		return true;
	} catch {
		return false;
	}
}

const canWriteUnderHome = await homeChildWritable();

function memoryRootFor(agentDir: string, cwd: string): string {
	const encoded = `--${cwd.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
	return path.join(getMemoriesDir(agentDir), encoded);
}

/**
 * The shell reads a drive-qualified path with `/` separators, so a rule path on
 * Windows is handed over in that spelling rather than the native one.
 */
function shellSpelling(filePath: string): string {
	return /^[A-Za-z]:[\\/]/.test(filePath) ? filePath.replaceAll("\\", "/") : filePath;
}

async function expectExpandsToSource(
	command: string,
	options: Parameters<typeof expandInternalUrls>[1],
	sourcePath: string,
): Promise<void> {
	const expanded = await expandInternalUrls(command, options);
	const quoted = expanded.slice(expanded.indexOf(" ") + 1);
	expect(quoted.startsWith("'") && quoted.endsWith("'")).toBe(true);
	const got = quoted.slice(1, -1).replaceAll("'\\''", "'");
	const lexical = path.resolve(sourcePath);
	let real = lexical;
	try {
		real = await realpath(sourcePath);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
	}
	expect([shellSpelling(lexical), shellSpelling(real)]).toContain(got);
}

describe("expandInternalUrls session scope", () => {
	it("still allows a rule file inside the session directory", async () => {
		const cwd = await mkdtemp(path.join(tmpdir(), "bash-rule-in-"));
		try {
			const sourcePath = path.join(cwd, "deploy.md");
			await writeFile(sourcePath, "own-rule");
			const router = createInternalRouter({ "rule://deploy": { sourcePath } });
			await expectExpandsToSource(
				"cat rule://deploy",
				{
					skills: [],
					internalRouter: router,
					sessionCwd: cwd,
					sessionAgentDir: path.join(cwd, "agent"),
				},
				sourcePath,
			);
		} finally {
			await rm(cwd, { recursive: true, force: true });
		}
	});

	it("rejects memory:// before router resolution, with or without a session directory", async () => {
		const cwd = await mkdtemp(path.join(tmpdir(), "bash-mem-own-"));
		const agentDir = await mkdtemp(path.join(tmpdir(), "bash-mem-own-agent-"));
		try {
			const sourcePath = path.join(memoryRootFor(agentDir, cwd), "memory_summary.md");
			await mkdir(path.dirname(sourcePath), { recursive: true });
			await writeFile(sourcePath, "own-memory");
			const router = createInternalRouter({
				"memory://root": { sourcePath },
				"memory://root/": { sourcePath },
				"memory://root/memory_summary.md": { sourcePath },
			});
			const resolveSpy = spyOn(router, "resolve");
			const options = { skills: [], internalRouter: router, sessionCwd: cwd, sessionAgentDir: agentDir };
			for (const command of [
				"cat memory://root",
				"cat memory://root/",
				"printf x >> memory://root/memory_summary.md",
			]) {
				await expect(expandInternalUrls(command, options)).rejects.toThrow(
					/memory:\/\/ URLs cannot be expanded in bash commands/,
				);
			}
			await expect(expandInternalUrls("cat memory://root", { skills: [], internalRouter: router })).rejects.toThrow(
				/memory:\/\/ URLs cannot be expanded in bash commands/,
			);
			expect(resolveSpy).not.toHaveBeenCalled();
		} finally {
			await rm(cwd, { recursive: true, force: true });
			await rm(agentDir, { recursive: true, force: true });
		}
	});

	it.skipIf(process.platform === "win32")(
		"does not let two project paths that fold to one memory root share a bash expansion",
		async () => {
			const parent = await mkdtemp(path.join(tmpdir(), "bash-shared-root-"));
			const agentDir = path.join(parent, "agent");
			const firstCwd = path.join(parent, "work", "acme-api", "server");
			const secondCwd = path.join(parent, "work", "acme", "api-server");
			const colonCwd = path.join(parent, "work", "acme:api", "server");
			try {
				const sharedRoot = memoryRootFor(agentDir, firstCwd);
				expect(memoryRootFor(agentDir, secondCwd)).toBe(sharedRoot);
				expect(memoryRootFor(agentDir, colonCwd)).toBe(sharedRoot);
				const sourcePath = path.join(sharedRoot, "memory_summary.md");
				await mkdir(sharedRoot, { recursive: true });
				for (const cwd of [firstCwd, secondCwd, colonCwd]) await mkdir(cwd, { recursive: true });
				await writeFile(sourcePath, "first-project-memory");
				const router = createInternalRouter({ "memory://root/memory_summary.md": { sourcePath } });
				const shared = { skills: [] as Skill[], internalRouter: router, sessionAgentDir: agentDir };
				for (const sessionCwd of [firstCwd, secondCwd, colonCwd]) {
					await expect(
						expandInternalUrls("cat memory://root/memory_summary.md", { ...shared, sessionCwd }),
					).rejects.toThrow(/memory root is not unique per project/);
					await expect(
						expandInternalUrls("printf x >> memory://root/memory_summary.md", { ...shared, sessionCwd }),
					).rejects.toThrow(/memory root is not unique per project/);
				}
				const ruleSource = path.join(secondCwd, "deploy.md");
				await writeFile(ruleSource, "own-rule");
				const ruleRouter = createInternalRouter({ "rule://deploy": { sourcePath: ruleSource } });
				await expectExpandsToSource(
					"cat rule://deploy",
					{ ...shared, internalRouter: ruleRouter, sessionCwd: secondCwd },
					ruleSource,
				);
			} finally {
				await rm(parent, { recursive: true, force: true });
			}
		},
	);

	it("still allows a user rule file inside the session agent directory", async () => {
		const cwd = await mkdtemp(path.join(tmpdir(), "bash-rule-proj-"));
		const agentDir = await mkdtemp(path.join(tmpdir(), "bash-rule-agent-"));
		try {
			const sourcePath = path.join(agentDir, "RULES.md");
			await writeFile(sourcePath, "user-rule");
			const router = createInternalRouter({ "rule://RULES": { sourcePath } });
			await expectExpandsToSource(
				"cat rule://RULES",
				{
					skills: [],
					internalRouter: router,
					sessionCwd: cwd,
					sessionAgentDir: agentDir,
				},
				sourcePath,
			);
		} finally {
			await rm(cwd, { recursive: true, force: true });
			await rm(agentDir, { recursive: true, force: true });
		}
	});

	function activeUserRule(name: string, filePath: string, provider = "agents") {
		return {
			name,
			path: filePath,
			content: name,
			_source: {
				provider,
				providerName: provider,
				path: filePath,
				level: "user" as const,
			},
		};
	}

	it("expands an active user rule under .agent/rules and .agents/rules", async () => {
		const trusted = await mkdtemp(path.join(tmpdir(), "bash-user-rule-"));
		const spy = spyOn(utils, "getTrustedHomeDir").mockReturnValue(trusted);
		try {
			const repo = path.join(trusted, "work", "repo");
			const cwd = path.join(repo, "subdir");
			const agentsRule = path.join(trusted, ".agents", "rules", "name.md");
			const agentRule = path.join(trusted, ".agent", "rules", "check.md");
			const dotted = path.join(trusted, ".agents", "rules", ".", "name.md");
			await mkdir(path.dirname(agentsRule), { recursive: true });
			await mkdir(path.dirname(agentRule), { recursive: true });
			await mkdir(cwd, { recursive: true });
			await writeFile(agentsRule, "agents-user-rule");
			await writeFile(agentRule, "agent-user-rule");
			await execFileAsync("git", ["init", "-q", repo]);
			setActiveRules([activeUserRule("name", agentsRule), activeUserRule("check", agentRule)]);
			const router = createInternalRouter({
				"rule://name": { sourcePath: agentsRule },
				"rule://dotted": { sourcePath: dotted },
				"rule://check": { sourcePath: agentRule },
			});
			const options = {
				skills: [] as Skill[],
				internalRouter: router,
				sessionCwd: cwd,
				sessionAgentDir: path.join(trusted, "agent"),
			};
			await expectExpandsToSource("cat rule://name", options, agentsRule);
			await expectExpandsToSource("cat rule://dotted", options, agentsRule);
			await expectExpandsToSource("cat rule://check", options, agentRule);
		} finally {
			spy.mockRestore();
			resetActiveRulesForTests();
			await rm(trusted, { recursive: true, force: true });
		}
	});

	it("rejects an undiscovered home file, a Cursor user rule, and a Windsurf global rule", async () => {
		const trusted = await mkdtemp(path.join(tmpdir(), "bash-user-limit-"));
		const spy = spyOn(utils, "getTrustedHomeDir").mockReturnValue(trusted);
		try {
			const repo = path.join(trusted, "work", "repo");
			const cwd = path.join(repo, "subdir");
			const undiscovered = path.join(trusted, ".agents", "rules", "other.md");
			const homeNotes = path.join(trusted, "notes.md");
			const cursorRule = path.join(trusted, ".cursor", "rules", "style.md");
			const windsurfRule = path.join(trusted, ".codeium", "windsurf", "memories", "global_rules.md");
			await mkdir(path.dirname(undiscovered), { recursive: true });
			await mkdir(path.dirname(cursorRule), { recursive: true });
			await mkdir(path.dirname(windsurfRule), { recursive: true });
			await mkdir(cwd, { recursive: true });
			await writeFile(undiscovered, "undiscovered");
			await writeFile(homeNotes, "home-notes");
			await writeFile(cursorRule, "cursor-rule");
			await writeFile(windsurfRule, "windsurf-rule");
			await execFileAsync("git", ["init", "-q", repo]);
			setActiveRules([
				activeUserRule("notes", homeNotes),
				activeUserRule("style", cursorRule, "cursor"),
				activeUserRule("global_rules", windsurfRule, "windsurf"),
			]);
			const router = createInternalRouter({
				"rule://other": { sourcePath: undiscovered },
				"rule://notes": { sourcePath: homeNotes },
				"rule://style": { sourcePath: cursorRule },
				"rule://global_rules": { sourcePath: windsurfRule },
			});
			const options = {
				skills: [] as Skill[],
				internalRouter: router,
				sessionCwd: cwd,
				sessionAgentDir: path.join(trusted, "agent"),
			};
			await expect(expandInternalUrls("cat rule://other", options)).rejects.toThrow(/outside this session/);
			await expect(expandInternalUrls("cat rule://notes", options)).rejects.toThrow(/outside this session/);
			await expect(expandInternalUrls("cat rule://style", options)).rejects.toThrow(/outside this session/);
			await expect(expandInternalUrls("cat rule://global_rules", options)).rejects.toThrow(/outside this session/);
		} finally {
			spy.mockRestore();
			resetActiveRulesForTests();
			await rm(trusted, { recursive: true, force: true });
		}
	});

	it.skipIf(process.platform === "win32" || !symlinkSupported)(
		"rejects a discovered user rule whose real path leaves .agents/rules",
		async () => {
			const trusted = await mkdtemp(path.join(tmpdir(), "bash-user-link-"));
			const outside = await mkdtemp(path.join(tmpdir(), "bash-user-link-out-"));
			const spy = spyOn(utils, "getTrustedHomeDir").mockReturnValue(trusted);
			try {
				const cwd = path.join(trusted, "work", "repo");
				const link = path.join(trusted, ".agents", "rules", "name.md");
				const secret = path.join(outside, "secret.md");
				await mkdir(path.dirname(link), { recursive: true });
				await mkdir(cwd, { recursive: true });
				await writeFile(secret, "secret");
				await symlink(secret, link);
				await execFileAsync("git", ["init", "-q", cwd]);
				setActiveRules([activeUserRule("name", link)]);
				const router = createInternalRouter({ "rule://name": { sourcePath: link } });
				await expect(
					expandInternalUrls("cat rule://name", {
						skills: [],
						internalRouter: router,
						sessionCwd: cwd,
						sessionAgentDir: path.join(trusted, "agent"),
					}),
				).rejects.toThrow(/outside this session/);
			} finally {
				spy.mockRestore();
				resetActiveRulesForTests();
				await rm(trusted, { recursive: true, force: true });
				await rm(outside, { recursive: true, force: true });
			}
		},
	);

	it.skipIf(!canWriteUnderHome)(
		"expands a project rule discovered from an ancestor directory in a non-Git session",
		async () => {
			await withGrantedHomeRoot(async root => {
				const project = path.join(root, "work", "project");
				const cwd = path.join(project, "subdir");
				const agentRule = path.join(project, ".agent", "rules", "check.md");
				const agentsRule = path.join(project, ".agents", "rules", "check.md");
				await mkdir(path.dirname(agentRule), { recursive: true });
				await mkdir(path.dirname(agentsRule), { recursive: true });
				await mkdir(cwd);
				await writeFile(agentRule, "ancestor-rule");
				await writeFile(agentsRule, "ancestor-rules");
				const router = createInternalRouter({
					"rule://check": { sourcePath: agentRule },
					"rule://checks": { sourcePath: agentsRule },
				});
				const options = {
					skills: [] as Skill[],
					internalRouter: router,
					sessionCwd: cwd,
					sessionAgentDir: path.join(root, "agent"),
				};
				await expectExpandsToSource("cat rule://check", options, agentRule);
				await expectExpandsToSource("cat rule://checks", options, agentsRule);
			});
		},
	);

	it("expands an ancestor project rule under the trusted home when that home is not the runtime home", async () => {
		const trusted = await mkdtemp(path.join(tmpdir(), "bash-trusted-home-"));
		const spy = spyOn(utils, "getTrustedHomeDir").mockReturnValue(trusted);
		try {
			const project = path.join(trusted, "work", "project");
			const cwd = path.join(project, "subdir");
			const rule = path.join(project, ".agent", "rules", "check.md");
			await mkdir(path.dirname(rule), { recursive: true });
			await mkdir(cwd);
			await writeFile(rule, "trusted-ancestor");
			const router = createInternalRouter({ "rule://check": { sourcePath: rule } });
			await expectExpandsToSource(
				"cat rule://check",
				{
					skills: [],
					internalRouter: router,
					sessionCwd: cwd,
					sessionAgentDir: path.join(trusted, "agent"),
				},
				rule,
			);
		} finally {
			spy.mockRestore();
			await rm(trusted, { recursive: true, force: true });
		}
	});

	it.skipIf(!canWriteUnderHome)(
		"refuses an ancestor rule that is inside the runtime home but outside the trusted home",
		async () => {
			await withGrantedHomeRoot(async root => {
				const trusted = await mkdtemp(path.join(tmpdir(), "bash-trusted-other-"));
				const spy = spyOn(utils, "getTrustedHomeDir").mockReturnValue(trusted);
				try {
					const project = path.join(root, "work", "project");
					const cwd = path.join(project, "subdir");
					const rule = path.join(project, ".agent", "rules", "check.md");
					await mkdir(path.dirname(rule), { recursive: true });
					await mkdir(cwd);
					await writeFile(rule, "runtime-home");
					const router = createInternalRouter({ "rule://check": { sourcePath: rule } });
					await expect(
						expandInternalUrls("cat rule://check", {
							skills: [],
							internalRouter: router,
							sessionCwd: cwd,
							sessionAgentDir: path.join(root, "agent"),
						}),
					).rejects.toThrow(/outside this session/);
				} finally {
					spy.mockRestore();
					await rm(trusted, { recursive: true, force: true });
				}
			});
		},
	);

	it.skipIf(!canWriteUnderHome)(
		"refuses a non-rule ancestor file, a sibling project rule, and a home rule in a non-Git session",
		async () => {
			await withGrantedHomeRoot(async root => {
				const project = path.join(root, "work", "project");
				const cwd = path.join(project, "subdir");
				const notes = path.join(project, "notes.md");
				const sibling = path.join(root, "work", "other", ".agent", "rules", "check.md");
				const homeRule = path.join(homedir(), ".agent", "rules", "gjc-bash-home-boundary.md");
				await mkdir(cwd, { recursive: true });
				await mkdir(path.dirname(sibling), { recursive: true });
				await writeFile(notes, "notes");
				await writeFile(sibling, "sibling");
				const router = createInternalRouter({
					"rule://notes": { sourcePath: notes },
					"rule://sibling": { sourcePath: sibling },
					"rule://home": { sourcePath: homeRule },
				});
				const options = {
					skills: [] as Skill[],
					internalRouter: router,
					sessionCwd: cwd,
					sessionAgentDir: path.join(root, "agent"),
				};
				await expect(expandInternalUrls("cat rule://notes", options)).rejects.toThrow(/outside this session/);
				await expect(expandInternalUrls("cat rule://sibling", options)).rejects.toThrow(/outside this session/);
				await expect(expandInternalUrls("cat rule://home", options)).rejects.toThrow(/outside this session/);
			});
		},
	);

	it.skipIf(!canWriteUnderHome)("refuses a rule above the Git root when the session is below home", async () => {
		await withGrantedHomeRoot(async root => {
			const repo = path.join(root, "repo");
			const cwd = path.join(repo, "subdir");
			const above = path.join(root, ".agent", "rules", "check.md");
			await mkdir(cwd, { recursive: true });
			await mkdir(path.dirname(above), { recursive: true });
			await writeFile(above, "above");
			await execFileAsync("git", ["init", "-q", repo]);
			const router = createInternalRouter({ "rule://check": { sourcePath: above } });
			await expect(
				expandInternalUrls("cat rule://check", {
					skills: [],
					internalRouter: router,
					sessionCwd: cwd,
					sessionAgentDir: path.join(root, "agent"),
				}),
			).rejects.toThrow(/outside this session/);
		});
	});

	it.skipIf(process.platform === "win32" || !symlinkSupported || !canWriteUnderHome)(
		"refuses an ancestor rule symlink that leaves the ancestor directory",
		async () => {
			const outside = await mkdtemp(path.join(tmpdir(), "bash-ancestor-out-"));
			try {
				await withGrantedHomeRoot(async root => {
					const project = path.join(root, "project");
					const cwd = path.join(project, "subdir");
					const link = path.join(project, ".agent", "rules", "check.md");
					const secret = path.join(outside, "secret.md");
					await mkdir(path.dirname(link), { recursive: true });
					await mkdir(cwd);
					await writeFile(secret, "secret");
					await symlink(secret, link);
					const router = createInternalRouter({ "rule://check": { sourcePath: link } });
					await expect(
						expandInternalUrls("cat rule://check", {
							skills: [],
							internalRouter: router,
							sessionCwd: cwd,
							sessionAgentDir: path.join(root, "agent"),
						}),
					).rejects.toThrow(/outside this session/);
				});
			} finally {
				await rm(outside, { recursive: true, force: true });
			}
		},
	);

	it.skipIf(process.platform === "win32" || !symlinkSupported || !canWriteUnderHome)(
		"refuses an ancestor rule symlink that stays inside the ancestor but leaves the rule directory",
		async () => {
			await withGrantedHomeRoot(async root => {
				const project = path.join(root, "project");
				const cwd = path.join(project, "subdir");
				const sibling = path.join(project, "other-session", "secret.md");
				const notes = path.join(project, "notes.md");
				await mkdir(path.dirname(sibling), { recursive: true });
				await mkdir(cwd);
				await writeFile(sibling, "secret");
				await writeFile(notes, "notes");
				for (const dirName of [".agent", ".agents"]) {
					const rules = path.join(project, dirName, "rules");
					await mkdir(rules, { recursive: true });
					const toSibling = path.join(rules, "check.md");
					const toNotes = path.join(rules, "notes.md");
					await symlink(sibling, toSibling);
					await symlink(notes, toNotes);
					const router = createInternalRouter({
						"rule://check": { sourcePath: toSibling },
						"rule://notes": { sourcePath: toNotes },
					});
					const options = {
						skills: [] as Skill[],
						internalRouter: router,
						sessionCwd: cwd,
						sessionAgentDir: path.join(root, "agent"),
					};
					await expect(expandInternalUrls("cat rule://check", options)).rejects.toThrow(/outside this session/);
					await expect(expandInternalUrls("cat rule://notes", options)).rejects.toThrow(/outside this session/);
					await rm(toSibling);
					await rm(toNotes);
				}
				const widened = path.join(project, "widened");
				await mkdir(widened);
				await writeFile(path.join(widened, "secret.md"), "widened");
				const linkedRoot = path.join(project, ".agent", "rules");
				await rm(linkedRoot, { recursive: true, force: true });
				await symlink(widened, linkedRoot);
				const widenedRule = path.join(linkedRoot, "secret.md");
				const widenedRouter = createInternalRouter({ "rule://secret": { sourcePath: widenedRule } });
				await expect(
					expandInternalUrls("cat rule://secret", {
						skills: [],
						internalRouter: widenedRouter,
						sessionCwd: cwd,
						sessionAgentDir: path.join(root, "agent"),
					}),
				).rejects.toThrow(/outside this session/);
			});
		},
	);

	it("still allows a rule file at the repo root above the session directory", async () => {
		const repo = await mkdtemp(path.join(tmpdir(), "bash-rule-repo-"));
		try {
			await execFileAsync("git", ["init", "-q", repo]);
			const cwd = path.join(repo, "pkg");
			await mkdir(cwd);
			const sourcePath = path.join(repo, "deploy.md");
			await writeFile(sourcePath, "repo-rule");
			const router = createInternalRouter({ "rule://deploy": { sourcePath } });
			await expectExpandsToSource(
				"cat rule://deploy",
				{
					skills: [],
					internalRouter: router,
					sessionCwd: cwd,
					sessionAgentDir: path.join(repo, "agent"),
				},
				sourcePath,
			);
		} finally {
			await rm(repo, { recursive: true, force: true });
		}
	});

	it("still allows generated rule files inside the session directory", async () => {
		const segment = fc.stringMatching(/^[a-z][a-z0-9]{0,5}$/);
		await fc.assert(
			fc.asyncProperty(fc.array(segment, { minLength: 1, maxLength: 3 }), async segments => {
				const cwd = await mkdtemp(path.join(tmpdir(), "bash-rule-prop-"));
				try {
					const sourcePath = path.join(cwd, ...segments, "rule.md");
					await mkdir(path.dirname(sourcePath), { recursive: true });
					await writeFile(sourcePath, "generated");
					const router = createInternalRouter({ "rule://generated": { sourcePath } });
					await expectExpandsToSource(
						"cat rule://generated",
						{
							skills: [],
							internalRouter: router,
							sessionCwd: cwd,
							sessionAgentDir: path.join(cwd, "agent"),
						},
						sourcePath,
					);
				} finally {
					await rm(cwd, { recursive: true, force: true });
				}
			}),
			{ seed: PROPERTY_SEED, numRuns: 64 },
		);
	});

	it("refuses a rule file from another project", async () => {
		const cwd = await mkdtemp(path.join(tmpdir(), "bash-rule-a-"));
		const other = await mkdtemp(path.join(tmpdir(), "bash-rule-b-"));
		try {
			const sourcePath = path.join(other, "deploy.md");
			await writeFile(sourcePath, "other-rule");
			const router = createInternalRouter({ "rule://deploy": { sourcePath } });
			let message = "";
			try {
				await expandInternalUrls("printf x >> rule://deploy", {
					skills: [],
					internalRouter: router,
					sessionCwd: cwd,
					sessionAgentDir: path.join(cwd, "agent"),
				});
			} catch (error) {
				message = error instanceof Error ? error.message : String(error);
			}
			expect(message).toContain("outside this session");
			expect(message).not.toContain(path.basename(other));
			expect(message).not.toContain(sourcePath);
		} finally {
			await rm(cwd, { recursive: true, force: true });
			await rm(other, { recursive: true, force: true });
		}
	});

	it("rejects memory:// in bash even when the router names a foreign session file", async () => {
		const cwd = await mkdtemp(path.join(tmpdir(), "bash-mem-a-"));
		const otherCwd = await mkdtemp(path.join(tmpdir(), "bash-mem-b-"));
		const agentDir = await mkdtemp(path.join(tmpdir(), "bash-mem-agent-"));
		try {
			const foreign = path.join(memoryRootFor(agentDir, otherCwd), "memory_summary.md");
			await mkdir(path.dirname(foreign), { recursive: true });
			await writeFile(foreign, "other-memory");
			const urls = [
				"memory://root/memory_summary.md",
				"memory://%72oot/",
				"memory://root/#section",
				"memory://root/?q=1",
			];
			const router = createInternalRouter(Object.fromEntries(urls.map(url => [url, { sourcePath: foreign }])));
			const options = { skills: [], internalRouter: router, sessionCwd: cwd, sessionAgentDir: agentDir };
			for (const url of urls) {
				await expect(expandInternalUrls(`printf x >> ${url}`, options)).rejects.toThrow(
					/memory:\/\/ URLs cannot be expanded/,
				);
			}
		} finally {
			await rm(cwd, { recursive: true, force: true });
			await rm(otherCwd, { recursive: true, force: true });
			await rm(agentDir, { recursive: true, force: true });
		}
	});

	it("refuses a rule in another session's root while keeping the caller's own root", async () => {
		const parent = await mkdtemp(path.join(tmpdir(), "bash-two-sessions-"));
		try {
			const callerCwd = path.join(parent, "caller-project");
			const callerAgent = path.join(parent, "caller-agent");
			const otherCwd = path.join(parent, "other-project");
			const otherAgent = path.join(parent, "other-agent");
			await mkdir(callerCwd);
			await mkdir(callerAgent);
			await mkdir(otherCwd);
			await mkdir(otherAgent);
			const ownRule = path.join(callerAgent, "own.md");
			const foreignAgentRule = path.join(otherAgent, "secret.md");
			const otherSessionOnly = path.join(otherCwd, "only-there.md");
			const foreignMemory = path.join(memoryRootFor(otherAgent, otherCwd), "memory_summary.md");
			await writeFile(ownRule, "own-rule");
			await writeFile(foreignAgentRule, "other-agent-rule");
			await writeFile(otherSessionOnly, "other-session-only");
			await mkdir(path.dirname(foreignMemory), { recursive: true });
			await writeFile(foreignMemory, "other-memory");
			const router = createInternalRouter({
				"rule://own": { sourcePath: ownRule },
				"rule://secret": { sourcePath: foreignAgentRule },
				"rule://only-there": { sourcePath: otherSessionOnly },
				"memory://root/memory_summary.md": { sourcePath: foreignMemory },
			});
			const options = {
				skills: [] as Skill[],
				internalRouter: router,
				sessionCwd: callerCwd,
				sessionAgentDir: callerAgent,
			};
			await expectExpandsToSource("cat rule://own", options, ownRule);
			for (const url of ["rule://secret", "rule://only-there"]) {
				let message = "";
				try {
					await expandInternalUrls(`cat ${url}`, options);
				} catch (error) {
					message = error instanceof Error ? error.message : String(error);
				}
				expect(message).toContain("outside this session");
				expect(message).not.toContain(path.basename(otherCwd));
				expect(message).not.toContain(path.basename(otherAgent));
				expect(message).not.toContain(path.basename(otherSessionOnly));
			}
			await expect(expandInternalUrls("cat memory://root/memory_summary.md", options)).rejects.toThrow(
				/memory:\/\/ URLs cannot be expanded/,
			);
		} finally {
			await rm(parent, { recursive: true, force: true });
		}
	});

	it.skipIf(process.platform === "win32" || !symlinkSupported)(
		"refuses a rule URL quoted inside a larger argument instead of splicing a canonical path",
		async () => {
			const repo = await mkdtemp(path.join(tmpdir(), "bash-rule-quote-"));
			try {
				await execFileAsync("git", ["init", "-q", repo]);
				const dangerous = path.join(repo, "$(touch pwned).md");
				await writeFile(dangerous, "dangerous-rule");
				const alias = path.join(repo, "alias.md");
				await symlink(dangerous, alias);
				const benign = path.join(repo, "deploy.md");
				await writeFile(benign, "benign-rule");
				const router = createInternalRouter({
					"rule://alias": { sourcePath: alias },
					"rule://deploy": { sourcePath: benign },
				});
				const options = {
					skills: [] as Skill[],
					internalRouter: router,
					sessionCwd: repo,
					sessionAgentDir: path.join(repo, "agent"),
				};
				// An unquoted embedded URL keeps working: the replacement starts its own
				// shell word segment.
				const expanded = await expandInternalUrls("grep --file=rule://deploy /dev/null", options);
				expect(expanded).toContain(shellEscape(await realpath(benign)));
				// Inside an argument the caller already quoted, the same replacement would
				// end that quote early, so it is refused before expansion. A leading `$`
				// would also reinterpret the replacement's quoting.
				for (const command of [
					"grep '--file=rule://alias' /dev/null",
					'grep "--file=rule://alias" /dev/null',
					"grep $'x\\' rule://alias' /dev/null",
					"cat $'rule://alias'",
					'cat $"rule://alias"',
					"cat $rule://alias",
					"cat \\'rule://alias'",
					'printf "%s\\n" "$(cat "prefix rule://alias")"',
					"cat <<EOF\nrule://alias\nEOF",
					'echo ok # "\ncat "prefix rule://alias"',
					"printf '%s\\n' $[ rule://alias ]",
					"(( rule://alias ))",
					"let rule://alias",
					"echo $" + "{x:-rule://alias}",
					"printf '%s\\n' $" + "{a[rule://alias]}",
					"a[0+'rule://alias'+0]=x",
					"a['rule://alias']=x",
				]) {
					await expect(expandInternalUrls(command, options)).rejects.toThrow(/standalone shell argument/);
				}
				const realBenign = await realpath(benign);
				for (const command of ["cat 'rule://deploy'", 'cat "rule://deploy"']) {
					expect(await expandInternalUrls(command, options)).toContain(shellEscape(realBenign));
				}
			} finally {
				await rm(repo, { recursive: true, force: true });
			}
		},
	);

	it.skipIf(process.platform === "win32" || !symlinkSupported)(
		"refuses a rule whose canonical path carries shell expansion syntax",
		async () => {
			const repo = await mkdtemp(path.join(tmpdir(), "bash-rule-path-syntax-"));
			try {
				await execFileAsync("git", ["init", "-q", repo]);
				const dangerous = path.join(repo, "$(touch pwned).md");
				await writeFile(dangerous, "dangerous-rule");
				const semicolon = path.join(repo, "x; touch pwned;#.md");
				await writeFile(semicolon, "semicolon-rule");
				const alias = path.join(repo, "alias.md");
				await symlink(dangerous, alias);
				const benign = path.join(repo, "deploy.md");
				await writeFile(benign, "benign-rule");
				const router = createInternalRouter({
					"rule://alias": { sourcePath: alias },
					"rule://semicolon": { sourcePath: semicolon },
					"rule://deploy": { sourcePath: benign },
				});
				const options = {
					skills: [] as Skill[],
					internalRouter: router,
					sessionCwd: repo,
					sessionAgentDir: path.join(repo, "agent"),
				};
				for (const command of [
					"cat rule://alias",
					'l""et rule://alias',
					"\\let rule://alias",
					"eval rule://semicolon",
				]) {
					await expect(expandInternalUrls(command, options)).rejects.toThrow(/shell syntax/);
				}
				expect(await expandInternalUrls("cat rule://deploy", options)).toContain(
					shellEscape(await realpath(benign)),
				);
				await expect(Bun.file(path.join(repo, "pwned")).exists()).resolves.toBe(false);
			} finally {
				await rm(repo, { recursive: true, force: true });
			}
		},
	);

	it.skipIf(process.platform !== "win32")(
		"expands an in-root rule whose canonical path carries Windows separators",
		async () => {
			const repo = await mkdtemp(path.join(tmpdir(), "bash-rule-win-path-"));
			try {
				const sourcePath = path.join(repo, ".agent", "rules", "deploy.md");
				await mkdir(path.dirname(sourcePath), { recursive: true });
				await writeFile(sourcePath, "windows-rule");
				const router = createInternalRouter({ "rule://deploy": { sourcePath } });
				const expanded = await expandInternalUrls("cat rule://deploy", {
					skills: [],
					internalRouter: router,
					sessionCwd: repo,
					sessionAgentDir: path.join(repo, "agent"),
				});
				// The resolved path is drive-qualified and backslash-separated on
				// Windows; the shell reads the forward-slash spelling of the same file.
				const real = await realpath(sourcePath);
				expect(real).toContain("\\");
				expect(expanded).toBe(`cat '${real.replaceAll("\\", "/")}'`);
			} finally {
				await rm(repo, { recursive: true, force: true });
			}
		},
	);

	it.skipIf(process.platform !== "win32")(
		"refuses a rule in a case-variant sibling directory when the volume is case-sensitive",
		async () => {
			const parent = await mkdtemp(path.join(tmpdir(), "bash-rule-case-"));
			try {
				const callerCwd = path.join(parent, "Repo");
				const variantCwd = path.join(parent, "repo");
				const agentDir = path.join(parent, "agent");
				await mkdir(callerCwd);
				await mkdir(variantCwd);
				await mkdir(agentDir);
				// A case-insensitive directory folds the two names onto one; the
				// containment question only exists where they stay distinct.
				if ((await realpath(callerCwd)) === (await realpath(variantCwd))) return;
				const sourcePath = path.join(variantCwd, "secret.md");
				await writeFile(sourcePath, "foreign-rule");
				const router = createInternalRouter({ "rule://secret": { sourcePath } });
				await expect(
					expandInternalUrls("cat rule://secret", {
						skills: [],
						internalRouter: router,
						sessionCwd: callerCwd,
						sessionAgentDir: agentDir,
					}),
				).rejects.toThrow(/outside this session/);
			} finally {
				await rm(parent, { recursive: true, force: true });
			}
		},
	);

	it.skipIf(process.platform === "win32" || !symlinkSupported)(
		"does not leak a foreign session path when its rule link cannot be resolved",
		async () => {
			const parent = await mkdtemp(path.join(tmpdir(), "bash-foreign-loop-"));
			try {
				const callerCwd = path.join(parent, "caller-project");
				const callerAgent = path.join(parent, "caller-agent");
				const otherAgent = path.join(parent, "other-agent");
				await mkdir(callerCwd);
				await mkdir(callerAgent);
				await mkdir(otherAgent);
				const loop = path.join(otherAgent, "loop.md");
				await symlink(loop, loop);
				const router = createInternalRouter({ "rule://loop": { sourcePath: loop } });
				let message = "";
				try {
					await expandInternalUrls("cat rule://loop", {
						skills: [],
						internalRouter: router,
						sessionCwd: callerCwd,
						sessionAgentDir: callerAgent,
					});
				} catch (error) {
					message = error instanceof Error ? error.message : String(error);
				}
				expect(message).toContain("outside this session");
				expect(message).not.toContain(path.basename(otherAgent));
				expect(message).not.toContain(loop);
			} finally {
				await rm(parent, { recursive: true, force: true });
			}
		},
	);

	it("refuses a rule file that only shares a directory prefix", async () => {
		const parent = await mkdtemp(path.join(tmpdir(), "bash-prefix-"));
		try {
			const cwd = path.join(parent, "proj");
			const sibling = path.join(parent, "proj-extra");
			await mkdir(cwd);
			await mkdir(sibling);
			const sourcePath = path.join(sibling, "deploy.md");
			await writeFile(sourcePath, "prefix");
			const router = createInternalRouter({ "rule://deploy": { sourcePath } });
			await expect(
				expandInternalUrls("cat rule://deploy", {
					skills: [],
					internalRouter: router,
					sessionCwd: cwd,
					sessionAgentDir: path.join(cwd, "agent"),
				}),
			).rejects.toThrow(/outside this session/);
		} finally {
			await rm(parent, { recursive: true, force: true });
		}
	});

	it("still allows a rule file in a session directory that ends with a space", async () => {
		const parent = await mkdtemp(path.join(tmpdir(), "bash-space-ok-"));
		try {
			const cwd = path.join(parent, "proj ");
			const agentDir = path.join(parent, "agent");
			const rulePath = path.join(cwd, "own.md");
			await mkdir(cwd);
			await writeFile(rulePath, "own-rule");
			const router = createInternalRouter({ "rule://own": { sourcePath: rulePath } });
			const options = { skills: [], internalRouter: router, sessionCwd: cwd, sessionAgentDir: agentDir };
			await expectExpandsToSource("cat rule://own", options, rulePath);
		} finally {
			await rm(parent, { recursive: true, force: true });
		}
	});

	it("refuses a rule file in the directory named by trimming the session directory", async () => {
		const parent = await mkdtemp(path.join(tmpdir(), "bash-space-no-"));
		try {
			const cwd = path.join(parent, "proj ");
			const trimmed = cwd.trim();
			const agentDir = path.join(parent, "agent");
			const rulePath = path.join(trimmed, "secret.md");
			await mkdir(cwd);
			await mkdir(trimmed);
			await writeFile(rulePath, "foreign-rule");
			const router = createInternalRouter({ "rule://secret": { sourcePath: rulePath } });
			const options = { skills: [], internalRouter: router, sessionCwd: cwd, sessionAgentDir: agentDir };
			await expect(expandInternalUrls("cat rule://secret", options)).rejects.toThrow(/outside this session/);
		} finally {
			await rm(parent, { recursive: true, force: true });
		}
	});

	it.skipIf(process.platform === "win32" || !symlinkSupported)(
		"refuses a rule symlink that leaves the session",
		async () => {
			const cwd = await mkdtemp(path.join(tmpdir(), "bash-link-in-"));
			const outside = await mkdtemp(path.join(tmpdir(), "bash-link-out-"));
			try {
				const secret = path.join(outside, "secret.md");
				const link = path.join(cwd, "deploy.md");
				await writeFile(secret, "secret");
				await symlink(secret, link);
				const router = createInternalRouter({ "rule://deploy": { sourcePath: link } });
				await expect(
					expandInternalUrls("cat rule://deploy", {
						skills: [],
						internalRouter: router,
						sessionCwd: cwd,
						sessionAgentDir: path.join(cwd, "agent"),
					}),
				).rejects.toThrow(/outside this session/);
			} finally {
				await rm(cwd, { recursive: true, force: true });
				await rm(outside, { recursive: true, force: true });
			}
		},
	);

	it.skipIf(process.platform === "win32" || !symlinkSupported)(
		"expands an ancestor rule when the trusted home is reached through a symlink",
		async () => {
			const physical = await mkdtemp(path.join(tmpdir(), "bash-home-real-"));
			const holder = await mkdtemp(path.join(tmpdir(), "bash-home-link-"));
			const linkedHome = path.join(holder, "home");
			await symlink(physical, linkedHome);
			const spy = spyOn(utils, "getTrustedHomeDir").mockReturnValue(linkedHome);
			try {
				const project = path.join(physical, "project");
				const rule = path.join(project, ".agent", "rules", "check.md");
				await mkdir(path.dirname(rule), { recursive: true });
				await writeFile(rule, "symlinked-home-rule");
				const physicalCwd = path.join(project, "subdir");
				await mkdir(physicalCwd);
				const router = createInternalRouter({ "rule://check": { sourcePath: rule } });
				const options = {
					skills: [] as Skill[],
					internalRouter: router,
					sessionAgentDir: path.join(physical, "agent"),
				};
				await expectExpandsToSource("cat rule://check", { ...options, sessionCwd: physicalCwd }, rule);
				const lexicalCwd = path.join(linkedHome, "project", "subdir");
				await expectExpandsToSource("cat rule://check", { ...options, sessionCwd: lexicalCwd }, rule);
			} finally {
				spy.mockRestore();
				await rm(holder, { recursive: true, force: true });
				await rm(physical, { recursive: true, force: true });
			}
		},
	);

	it("refuses bash expansion of a rule URL when the session directory is omitted", async () => {
		const cwd = await mkdtemp(path.join(tmpdir(), "bash-omit-"));
		try {
			const sourcePath = path.join(cwd, "deploy.md");
			await writeFile(sourcePath, "own");
			const router = createInternalRouter({ "rule://deploy": { sourcePath } });
			await expect(expandInternalUrls("cat rule://deploy", { skills: [], internalRouter: router })).rejects.toThrow(
				/without a session directory/,
			);
		} finally {
			await rm(cwd, { recursive: true, force: true });
		}
	});

	it("hides foreign rule names when a bash rule URL cannot be resolved", async () => {
		const cwd = await mkdtemp(path.join(tmpdir(), "bash-names-"));
		try {
			const router = {
				canHandle: () => true,
				resolve: async () => {
					throw new Error("Unknown rule: missing\nAvailable: private-deploy\nprivate-deploy\ncontinued-fragment");
				},
			};
			let message = "";
			try {
				await expandInternalUrls("cat rule://missing", {
					skills: [],
					internalRouter: router,
					sessionCwd: cwd,
				});
			} catch (error) {
				message = error instanceof Error ? error.message : String(error);
			}
			expect(message).toContain("Unknown rule: missing");
			expect(message).not.toContain("Available:");
			expect(message).not.toContain("private-deploy");
			expect(message).not.toContain("continued-fragment");
		} finally {
			await rm(cwd, { recursive: true, force: true });
		}
	});

	it("property: rule files beside the session directory are not expanded", async () => {
		const segment = fc.stringMatching(/^[a-z][a-z0-9]{0,5}$/);
		await fc.assert(
			fc.asyncProperty(segment, async name => {
				const parent = await mkdtemp(path.join(tmpdir(), "bash-beside-"));
				try {
					const cwd = path.join(parent, "proj");
					const beside = path.join(parent, `other-${name}`);
					await mkdir(cwd);
					await mkdir(beside);
					const sourcePath = path.join(beside, "rule.md");
					await writeFile(sourcePath, "beside");
					const router = createInternalRouter({ "rule://beside": { sourcePath } });
					await expect(
						expandInternalUrls("cat rule://beside", {
							skills: [],
							internalRouter: router,
							sessionCwd: cwd,
							sessionAgentDir: path.join(cwd, "agent"),
						}),
					).rejects.toThrow(/outside this session/);
				} finally {
					await rm(parent, { recursive: true, force: true });
				}
			}),
			{ seed: PROPERTY_SEED, numRuns: 64 },
		);
	});
});

/**
 * A Windows rule path reached this guard with backslashes and was refused, so
 * every approved `rule://` expansion failed on Windows. A backslash is a
 * separator there and an escape in the shell, so the guard has to translate
 * rather than refuse, and still refuse when a backslash can be an escape.
 */
describe("refuseShellBearingRulePath", () => {
	it("expresses a Windows drive path in the separator form the shell reads", () => {
		expect(refuseShellBearingRulePath("C:\\Users\\me\\work\\repo\\.agent\\rules\\deploy.md")).toBe(
			"C:/Users/me/work/repo/.agent/rules/deploy.md",
		);
		expect(refuseShellBearingRulePath("d:\\rules\\deploy.md")).toBe("d:/rules/deploy.md");
	});

	it("keeps the POSIX path it is given", () => {
		expect(refuseShellBearingRulePath("/home/me/work/repo/.agents/rules/deploy.md")).toBe(
			"/home/me/work/repo/.agents/rules/deploy.md",
		);
	});

	it("still refuses a backslash that the shell would read as an escape", () => {
		// Not Windows-shaped, so a backslash is a literal name character that an
		// unquoted or doubly-quoted context would consume as an escape.
		expect(() => refuseShellBearingRulePath("/home/me/rules/odd\\name.md")).toThrow(/shell syntax/);
		// A UNC path has no forward-slash spelling every Windows shell accepts.
		expect(() => refuseShellBearingRulePath("\\\\server\\share\\rules\\deploy.md")).toThrow(/shell syntax/);
	});

	it("still refuses shell syntax that survives separator translation", () => {
		for (const resolvedPath of [
			"C:\\repo\\$(touch pwned)\\rule.md",
			"C:\\repo\\x; touch pwned;#\\rule.md",
			"C:\\repo\\`whoami`\\rule.md",
			"C:\\repo\\a&b\\rule.md",
			"C:\\repo\\a|b\\rule.md",
			"C:\\repo\\a<b\\rule.md",
			"C:\\repo\\a>b\\rule.md",
			"C:\\repo\\a(b)\\rule.md",
			"C:\\repo\\a'b\\rule.md",
			'C:\\repo\\a"b\\rule.md',
			"C:\\repo\\a\nb\\rule.md",
			"C:\\repo\\a\rb\\rule.md",
		]) {
			expect(() => refuseShellBearingRulePath(resolvedPath)).toThrow(/shell syntax/);
		}
	});
});

function textOf(result: { content: Array<{ type: string; text?: string }> }): string {
	return result.content.find(part => part.type === "text")?.text ?? "";
}

function createAgentDirBashTool(
	cwd: string,
	requestedAgentDir: string,
	settingsAgentDir: string,
	readOnlyPrefixes?: readonly string[],
): BashTool {
	const session = {
		cwd,
		getSessionFile: () => null,
		getSessionId: () => "bash-agent-dir-scope",
		getSessionAgentDir: () => requestedAgentDir,
		bashRestrictionProfile: readOnlyPrefixes ? ("read-only" as const) : undefined,
		bashAllowedPrefixes: readOnlyPrefixes ? [...readOnlyPrefixes] : undefined,
		skills: [],
		settings: {
			has(key: string) {
				return this.get(key) !== undefined;
			},
			get(key: string) {
				if (key === "bashInterceptor.enabled") return false;
				if (key === "async.enabled") return false;
				if (key === "bash.autoBackground.enabled") return false;
				if (key === "bash.autoBackground.thresholdMs") return 60_000;
				if (key === "bash.stripTrailingHeadTail") return false;
				return undefined;
			},
			getBashInterceptorRules() {
				return [];
			},
			getAgentDir: () => settingsAgentDir,
			...stubBashExecutorSettings,
		},
	} as unknown as ToolSession;
	return new BashTool(session);
}

describe("bash session agent directory", () => {
	afterEach(async () => {
		resetActiveRulesForTests();
		await disposeAllShellSessions();
	});

	it.skipIf(process.platform === "win32")(
		"refuses a settings agent directory rule and accepts the requested agent directory in bash command, env, and cwd",
		async () => {
			const parent = await mkdtemp(path.join(tmpdir(), "bash-agent-dir-"));
			try {
				const project = path.join(parent, "project");
				const settingsAgentDir = path.join(parent, "agent-a");
				const requestedAgentDir = path.join(parent, "agent-b");
				await mkdir(project);
				await mkdir(settingsAgentDir);
				await mkdir(requestedAgentDir);
				const requestedReal = await realpath(requestedAgentDir);
				const ruleSource = (filePath: string) => ({
					provider: "test",
					providerName: "test",
					path: filePath,
					level: "user" as const,
				});
				setActiveRules([
					{
						name: "profile-a",
						path: settingsAgentDir,
						content: "settings-profile",
						_source: ruleSource(settingsAgentDir),
					},
					{
						name: "profile-b",
						path: requestedAgentDir,
						content: "requested-profile",
						_source: ruleSource(requestedAgentDir),
					},
				]);
				const tool = createAgentDirBashTool(project, requestedAgentDir, settingsAgentDir);
				await expect(tool.execute("call-command-a", { command: "printf '%s' rule://profile-a" })).rejects.toThrow(
					/outside this session/,
				);
				await expect(
					tool.execute("call-env-a", { command: "printf '%s' \"$FOO\"", env: { FOO: "rule://profile-a" } }),
				).rejects.toThrow(/outside this session/);
				await expect(tool.execute("call-cwd-a", { command: "pwd -P", cwd: "rule://profile-a" })).rejects.toThrow(
					/outside this session/,
				);
				const commandResult = await tool.execute("call-command-b", { command: "printf '%s' rule://profile-b" });
				expect(textOf(commandResult)).toContain(requestedReal);
				const envResult = await tool.execute("call-env-b", {
					command: "printf '%s' \"$FOO\"",
					env: { FOO: "rule://profile-b" },
				});
				expect(textOf(envResult)).toContain(requestedReal);
				const cwdResult = await tool.execute("call-cwd-b", { command: "pwd -P", cwd: "rule://profile-b" });
				expect(textOf(cwdResult)).toContain(requestedReal);
			} finally {
				resetActiveRulesForTests();
				await rm(parent, { recursive: true, force: true });
			}
		},
	);

	it.skipIf(process.platform === "win32")(
		"rejects memory:// in bash command, env, and cwd for two projects that share a folded memory root",
		async () => {
			const parent = await mkdtemp(path.join(tmpdir(), "bash-tool-mem-"));
			try {
				const agentDir = path.join(parent, "agent");
				const firstCwd = path.join(parent, "work", "acme-api", "server");
				const secondCwd = path.join(parent, "work", "acme", "api-server");
				const sharedRoot = memoryRootFor(agentDir, firstCwd);
				expect(memoryRootFor(agentDir, secondCwd)).toBe(sharedRoot);
				await mkdir(sharedRoot, { recursive: true });
				await writeFile(path.join(sharedRoot, "memory_summary.md"), "first-project-memory");
				for (const cwd of [firstCwd, secondCwd]) {
					await mkdir(cwd, { recursive: true });
					const tool = createAgentDirBashTool(cwd, agentDir, path.join(parent, "settings-agent"));
					await expect(
						tool.execute("call-mem-command", { command: "cat memory://root/memory_summary.md" }),
					).rejects.toThrow(/memory:\/\/ URLs cannot be expanded/);
					await expect(
						tool.execute("call-mem-env", { command: "printf '%s' \"$FOO\"", env: { FOO: "memory://root" } }),
					).rejects.toThrow(/memory:\/\/ URLs cannot be expanded/);
					await expect(tool.execute("call-mem-cwd", { command: "pwd", cwd: "memory://root" })).rejects.toThrow(
						/memory:\/\/ URLs cannot be expanded/,
					);
				}
			} finally {
				await rm(parent, { recursive: true, force: true });
			}
		},
	);

	it.skipIf(process.platform === "win32")(
		"expands a rule URL inside a multiline env value while refusing a foreign session rule there",
		async () => {
			const parent = await mkdtemp(path.join(tmpdir(), "bash-env-multiline-"));
			try {
				const project = path.join(parent, "project");
				const agentDir = path.join(parent, "agent");
				const foreign = path.join(parent, "foreign");
				await mkdir(project);
				await mkdir(agentDir);
				await mkdir(foreign);
				const ownRule = path.join(project, "own.md");
				const foreignRule = path.join(foreign, "foreign.md");
				await writeFile(ownRule, "own-rule");
				await writeFile(foreignRule, "foreign-rule");
				const ruleSource = (filePath: string) => ({
					provider: "test",
					providerName: "test",
					path: filePath,
					level: "user" as const,
				});
				setActiveRules([
					{ name: "own", path: ownRule, content: "own-rule", _source: ruleSource(ownRule) },
					{ name: "foreign", path: foreignRule, content: "foreign-rule", _source: ruleSource(foreignRule) },
				]);
				const tool = createAgentDirBashTool(project, agentDir, path.join(parent, "settings-agent"));
				// Env values are data: the prompt tells the model to hand multiline and
				// untrusted content to the tool through them, so a rule URL there is
				// expanded like any other value instead of being read as shell text.
				const multiline = (url: string) => `line one\n${url}\nline three`;
				const ownResult = await tool.execute("call-env-multiline-own", {
					command: 'printf "%s" "$PAYLOAD"',
					env: { PAYLOAD: multiline("rule://own") },
				});
				expect(textOf(ownResult)).toContain(await realpath(ownRule));
				// The same position still refuses a rule that is not this session's.
				await expect(
					tool.execute("call-env-multiline-foreign", {
						command: 'printf "%s" "$PAYLOAD"',
						env: { PAYLOAD: multiline("rule://foreign") },
					}),
				).rejects.toThrow(/outside this session/);
				// Command text keeps the shell-context guard that env values do not need.
				await expect(
					tool.execute("call-command-heredoc", { command: "cat <<EOF\nrule://own\nEOF" }),
				).rejects.toThrow(/standalone shell argument/);
			} finally {
				resetActiveRulesForTests();
				await rm(parent, { recursive: true, force: true });
			}
		},
	);

	it.skipIf(process.platform === "win32" || !canWriteUnderHome)(
		"expands an ancestor project rule through bash command execution in a non-Git session",
		async () => {
			await withGrantedHomeRoot(async root => {
				const project = path.join(root, "work", "project");
				const cwd = path.join(project, "subdir");
				const rulePath = path.join(project, ".agent", "rules", "check.md");
				const agentDir = path.join(root, "agent");
				await mkdir(path.dirname(rulePath), { recursive: true });
				await mkdir(cwd);
				await mkdir(agentDir);
				await writeFile(rulePath, "ancestor-rule");
				setActiveRules([
					{
						name: "check",
						path: rulePath,
						content: "ancestor-rule",
						_source: {
							provider: "test",
							providerName: "test",
							path: rulePath,
							level: "project",
						},
					},
				]);
				try {
					const tool = createAgentDirBashTool(cwd, agentDir, path.join(root, "settings-agent"));
					const ruleReal = await realpath(rulePath);
					const result = await tool.execute("call-ancestor", { command: "printf '%s' rule://check" });
					expect(textOf(result)).toContain(ruleReal);
					const envResult = await tool.execute("call-ancestor-env", {
						command: "printf '%s' \"$FOO\"",
						env: { FOO: "rule://check" },
					});
					expect(textOf(envResult)).toContain(ruleReal);
					await expect(
						tool.execute("call-ancestor-cwd", { command: "pwd -P", cwd: "rule://check" }),
					).rejects.toThrow(/not a directory/);
				} finally {
					resetActiveRulesForTests();
				}
			});
		},
	);

	it.skipIf(process.platform === "win32")(
		"expands an active user rule under .agents/rules in bash command and env",
		async () => {
			const trusted = await mkdtemp(path.join(tmpdir(), "bash-user-cat-"));
			const spy = spyOn(utils, "getTrustedHomeDir").mockReturnValue(trusted);
			try {
				const repo = path.join(trusted, "work", "repo");
				const cwd = path.join(repo, "subdir");
				const rulePath = path.join(trusted, ".agents", "rules", "name.md");
				const agentDir = path.join(trusted, "agent");
				await mkdir(path.dirname(rulePath), { recursive: true });
				await mkdir(cwd, { recursive: true });
				await mkdir(agentDir);
				await writeFile(rulePath, "active-user-rule");
				await execFileAsync("git", ["init", "-q", repo]);
				setActiveRules([
					{
						name: "name",
						path: rulePath,
						content: "name",
						_source: {
							provider: "agents",
							providerName: "agents",
							path: rulePath,
							level: "user" as const,
						},
					},
				]);
				const tool = createAgentDirBashTool(cwd, agentDir, path.join(trusted, "settings-agent"));
				const commandResult = await tool.execute("call-user-rule", { command: "cat rule://name" });
				expect(textOf(commandResult)).toContain("active-user-rule");
				const envResult = await tool.execute("call-user-env", {
					command: 'cat "$FOO"',
					env: { FOO: "rule://name" },
				});
				expect(textOf(envResult)).toContain("active-user-rule");
			} finally {
				spy.mockRestore();
				resetActiveRulesForTests();
				await rm(trusted, { recursive: true, force: true });
			}
		},
	);

	it.skipIf(process.platform === "win32")("rejects a Cursor user rule in bash command and env", async () => {
		const trusted = await mkdtemp(path.join(tmpdir(), "bash-cursor-rule-"));
		const spy = spyOn(utils, "getTrustedHomeDir").mockReturnValue(trusted);
		try {
			const repo = path.join(trusted, "work", "repo");
			const cwd = path.join(repo, "subdir");
			const cursorPath = path.join(trusted, ".cursor", "rules", "style.md");
			const agentDir = path.join(trusted, "agent");
			await mkdir(path.dirname(cursorPath), { recursive: true });
			await mkdir(cwd, { recursive: true });
			await mkdir(agentDir);
			await writeFile(cursorPath, "cursor-rule");
			await execFileAsync("git", ["init", "-q", repo]);
			setActiveRules([
				{
					name: "style",
					path: cursorPath,
					content: "style",
					_source: {
						provider: "cursor",
						providerName: "cursor",
						path: cursorPath,
						level: "user" as const,
					},
				},
			]);
			const tool = createAgentDirBashTool(cwd, agentDir, path.join(trusted, "settings-agent"));
			await expect(tool.execute("call-cursor", { command: "cat rule://style" })).rejects.toThrow(
				/outside this session/,
			);
			await expect(
				tool.execute("call-cursor-env", { command: 'cat "$FOO"', env: { FOO: "rule://style" } }),
			).rejects.toThrow(/outside this session/);
		} finally {
			spy.mockRestore();
			resetActiveRulesForTests();
			await rm(trusted, { recursive: true, force: true });
		}
	});

	it.skipIf(process.platform === "win32" || !symlinkSupported)(
		"refuses a quoted rule URL in read-only bash before the canonical path can reach the shell",
		async () => {
			const repo = await mkdtemp(path.join(tmpdir(), "bash-rule-readonly-"));
			try {
				await execFileAsync("git", ["init", "-q", repo]);
				const dangerous = path.join(repo, "$(touch pwned).md");
				await writeFile(dangerous, "dangerous-rule");
				const alias = path.join(repo, "alias.md");
				await symlink(dangerous, alias);
				setActiveRules([
					{
						name: "alias",
						path: alias,
						content: "dangerous-rule",
						_source: { provider: "test", providerName: "test", path: alias, level: "project" },
					},
				]);
				const tool = createAgentDirBashTool(repo, path.join(repo, "agent"), path.join(repo, "settings-agent"), [
					"grep",
				]);
				await expect(
					tool.execute("call-readonly-splice", { command: "grep --file=rule://alias /dev/null" }),
				).rejects.toThrow(/standalone shell argument/);
				await expect(Bun.file(path.join(repo, "pwned")).exists()).resolves.toBe(false);
			} finally {
				resetActiveRulesForTests();
				await rm(repo, { recursive: true, force: true });
			}
		},
	);
});
