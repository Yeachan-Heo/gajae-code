import { describe, expect, it } from "bun:test";
import * as path from "node:path";
import type { Skill } from "../../src/extensibility/skills";
import { resolveLocalUrlToPath } from "../../src/internal-urls";
import { expandInternalUrls, expandSkillUrls } from "../../src/tools/bash-skill-urls";
import { ToolError } from "../../src/tools/tool-errors";

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

describe("expandInternalUrls", () => {
	it("expands context-free internal URLs in one command", async () => {
		const skills = [createSkill("valid-skill", "/tmp/skills/valid-skill")];
		const router = createInternalRouter({
			"memory://root/memory_summary.md": { sourcePath: "/tmp/memories/memory_summary.md" },
			"rule://rs-no-unwrap": { sourcePath: "/tmp/rules/rs-no-unwrap.md" },
		});
		const command = "cat memory://root/memory_summary.md rule://rs-no-unwrap skill://valid-skill/scripts/init.py";
		const expectedSkillPath = path.join(skills[0].baseDir, "scripts/init.py");

		await expect(expandInternalUrls(command, { skills, internalRouter: router })).resolves.toBe(
			`cat ${shellEscape("/tmp/memories/memory_summary.md")} ${shellEscape("/tmp/rules/rs-no-unwrap.md")} ${shellEscape(expectedSkillPath)}`,
		);
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
		const expectedPath = resolveLocalUrlToPath("local://handoffs/new-file.json", localOptions);

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
		const expectedPath = resolveLocalUrlToPath("local:///PLAN.md", localOptions);

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
		const expectedPath = resolveLocalUrlToPath("local:///PLAN.md", localOptions);

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
		const expectedPath = resolveLocalUrlToPath("local:///PLAN.md", localOptions);

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
		await expect(expandInternalUrls("cat rule://my-rule", { skills: [], internalRouter: router })).rejects.toThrow(
			"rule:// URL resolved without a filesystem path",
		);
	});

	it("surfaces resolver errors with actionable context", async () => {
		const router = createInternalRouter({
			"memory://root/missing.md": { error: "Memory file not found" },
		});
		await expect(
			expandInternalUrls("cat memory://root/missing.md", { skills: [], internalRouter: router }),
		).rejects.toThrow("Failed to resolve memory:// URL in bash command");
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
		const expectedPath = resolveLocalUrlToPath("local://PLAN.md", localOptions);
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
