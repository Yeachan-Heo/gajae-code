import { afterEach, describe, expect, it, spyOn } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { getConfigRootDir, sanitizeDisplayLine, setAgentDir } from "@gajae-code/utils";
import fc from "fast-check";
import { runSkillsCommand } from "../../src/cli/skills-cli";
import type { RuntimeSkillDiscoveryCandidate } from "../../src/extensibility/runtime-skill-discovery";

const ESC = "\u001b";
const BEL = "\u0007";
const RLO = "\u202e";
const HOSTILE_NAME = `clip${ESC}[2Kboard`;
const HOSTILE_DESCRIPTION = `clipboard-marker before\nFORGED-LINE${ESC}]52;c;YXR0YWNr${BEL}${RLO} after`;
const ORDINARY_DESCRIPTION = "  Keeps café spaces.  ";

const originalAgentDir = process.env.GJC_CODING_AGENT_DIR;
const fallbackAgentDir = path.join(getConfigRootDir(), "agent");
const roots: string[] = [];

async function writeSkill(
	projectDir: string,
	dirName: string,
	name: string,
	description: string,
	globs?: string[],
): Promise<void> {
	const dir = path.join(projectDir, ".gjc", "skills", dirName);
	await fs.mkdir(dir, { recursive: true });
	const lines = ["---", `name: ${JSON.stringify(name)}`, `description: ${JSON.stringify(description)}`];
	if (globs && globs.length > 0) {
		lines.push("globs:");
		for (const glob of globs) lines.push(`  - ${JSON.stringify(glob)}`);
	}
	lines.push("---", "", `# ${dirName}`, "");
	await fs.writeFile(path.join(dir, "SKILL.md"), `${lines.join("\n")}\n`, "utf8");
}

async function discoverText(projectDir: string, query: string): Promise<string> {
	const previousCwd = process.cwd();
	const chunks: string[] = [];
	const write = spyOn(process.stdout, "write").mockImplementation(chunk => {
		chunks.push(String(chunk));
		return true;
	});
	process.chdir(projectDir);
	try {
		await runSkillsCommand({
			action: "discover",
			flags: { source: "project", query, limit: 20 },
		});
		return chunks.join("");
	} finally {
		write.mockRestore();
		process.chdir(previousCwd);
		process.exitCode = 0;
	}
}

async function projectFixture(): Promise<string> {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-skills-discover-"));
	roots.push(root);
	const projectDir = path.join(root, "project");
	const agentDir = path.join(root, "agent");
	await fs.mkdir(projectDir, { recursive: true });
	await fs.mkdir(agentDir, { recursive: true });
	setAgentDir(agentDir);
	return projectDir;
}

function expectedLine(candidate: RuntimeSkillDiscoveryCandidate): string {
	const useWhen =
		candidate.useWhen && candidate.useWhen.length > 0
			? ` [when: ${candidate.useWhen.map(part => sanitizeDisplayLine(part)).join(", ")}]`
			: "";
	return `${sanitizeDisplayLine(candidate.name)}\t${sanitizeDisplayLine(candidate.source)}\t${sanitizeDisplayLine(candidate.description)}\t${sanitizeDisplayLine(candidate.path)}${useWhen}`;
}

afterEach(async () => {
	if (originalAgentDir) setAgentDir(originalAgentDir);
	else {
		setAgentDir(fallbackAgentDir);
		delete process.env.GJC_CODING_AGENT_DIR;
	}
	process.exitCode = 0;
	while (roots.length > 0) {
		const root = roots.pop();
		if (root) await fs.rm(root, { recursive: true, force: true });
	}
});

describe("gjc skills discover stdout", () => {
	it("does not write a terminal control sequence from a skill description", async () => {
		const projectDir = await projectFixture();
		await writeSkill(projectDir, "clipboard-skill", HOSTILE_NAME, HOSTILE_DESCRIPTION);
		await writeSkill(projectDir, "clipboard-skill-copy", HOSTILE_NAME, HOSTILE_DESCRIPTION);

		const text = await discoverText(projectDir, "clipboard-marker");

		expect(text.includes(ESC)).toBe(false);
		expect(text.includes(BEL)).toBe(false);
		expect(text.includes(RLO)).toBe(false);
		expect(text.split("\n").some(line => line.startsWith("FORGED-LINE"))).toBe(false);
		expect(text).toContain("clipboard\tproject\tclipboard-marker before FORGED-LINE after\t");
		expect(text).toContain('skill "clipboard" already resolved');
	});

	it("keeps an ordinary skill description unchanged", async () => {
		const projectDir = await projectFixture();
		await writeSkill(projectDir, "PlainHelper", "PlainHelper", ORDINARY_DESCRIPTION, ["**/*.ts"]);

		const text = await discoverText(projectDir, "PlainHelper");
		const line = text.split("\n").find(row => row.startsWith("PlainHelper\t"));

		expect(line).toBeDefined();
		const [name, source, description, rest] = line!.split("\t");
		expect(name).toBe("PlainHelper");
		expect(source).toBe("project");
		expect(description).toBe(ORDINARY_DESCRIPTION);
		expect(rest).toContain(`${path.sep}.gjc${path.sep}skills${path.sep}PlainHelper${path.sep}SKILL.md`);
		expect(rest?.endsWith(" [when: **/*.ts]")).toBe(true);
		expect(text.includes(ESC)).toBe(false);
	});

	it("property: discover candidate text omits terminal controls, seed 20261025, 64 inputs", async () => {
		const mod = await import("../../src/cli/skills-cli");
		const format = mod.formatCandidate;
		expect(typeof format).toBe("function");
		const field = fc.string({ maxLength: 48 });
		fc.assert(
			fc.property(
				field,
				field,
				fc.constantFrom("project" as const, "user" as const, "bundled" as const),
				field,
				fc.array(field, { maxLength: 3 }),
				(name, description, source, skillPath, when) => {
					const candidate: RuntimeSkillDiscoveryCandidate = {
						name,
						description,
						source,
						path: skillPath,
						useWhen: when.length > 0 ? when : undefined,
					};
					const line = format(candidate);
					const again = format({
						name: sanitizeDisplayLine(candidate.name),
						description: sanitizeDisplayLine(candidate.description),
						source: candidate.source,
						path: sanitizeDisplayLine(candidate.path),
						useWhen: candidate.useWhen?.map(part => sanitizeDisplayLine(part)),
					});
					expect(line).toBe(expectedLine(candidate));
					expect(line).toBe(again);
					expect(line.includes(ESC)).toBe(false);
					expect(line.includes("\n")).toBe(false);
					expect(/[\u0000-\u0008\u000B-\u001F\u007F-\u009F]/u.test(line)).toBe(false);
					expect(line.includes(RLO)).toBe(false);
				},
			),
			{ seed: 20261025, numRuns: 64 },
		);
	});
});
