import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";

import { renderCommandRefBlock } from "@gajae-code/coding-agent/gjc-runtime/workflow-command-ref";
import { CANONICAL_GJC_WORKFLOW_SKILLS } from "@gajae-code/coding-agent/skill-state/canonical-skills";

interface FileSnapshot {
	bytes: Buffer;
	mtimeMs: number;
}

const repoRoot = path.resolve(import.meta.dir, "..", "..", "..", "..");
const skillFiles = CANONICAL_GJC_WORKFLOW_SKILLS.map(skill =>
	path.join(repoRoot, "packages", "coding-agent", "src", "defaults", "gjc", "skills", skill, "SKILL.md"),
);

async function snapshotSkillFiles(): Promise<Map<string, FileSnapshot>> {
	const snapshots = new Map<string, FileSnapshot>();
	for (const file of skillFiles) {
		const stat = await fs.stat(file);
		snapshots.set(file, { bytes: await fs.readFile(file), mtimeMs: stat.mtimeMs });
	}
	return snapshots;
}

async function expectSkillFilesUnchanged(before: Map<string, FileSnapshot>): Promise<void> {
	for (const file of skillFiles) {
		const prior = before.get(file);
		expect(prior, file).toBeDefined();
		if (!prior) continue;
		const stat = await fs.stat(file);
		const bytes = await fs.readFile(file);
		expect(bytes.equals(prior?.bytes ?? Buffer.alloc(0)), file).toBe(true);
		expect(stat.mtimeMs, file).toBe(prior?.mtimeMs);
	}
}

async function runBun(args: string[]): Promise<{ stdout: string; stderr: string; exitCode: number }> {
	const proc = Bun.spawn(["bun", ...args], { cwd: repoRoot, stdout: "pipe", stderr: "pipe" });
	const [stdout, stderr, exitCode] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
		proc.exited,
	]);
	return { stdout, stderr, exitCode };
}

describe("workflow command-reference proof spike", () => {
	it("renders deterministic command-reference blocks", () => {
		const first = renderCommandRefBlock("ralplan");
		const second = renderCommandRefBlock("ralplan");
		expect(first).toEqual(second);
		expect(first.bytes).toContain("<!-- gjc:cmdref:start state -->");
		expect(first.bytes).toContain("gjc state ralplan write --input");
		expect(first.bytes.endsWith("\n")).toBe(true);
	});

	it("reports byte-equal or gap status without mutating SKILL.md files", async () => {
		const before = await snapshotSkillFiles();
		const result = await runBun(["scripts/generate-gjc-skill-command-refs.ts", "--check", "--json"]);
		await expectSkillFilesUnchanged(before);
		expect(result.exitCode).toBe(0);
		expect(result.stderr).toBe("");
		const parsed = JSON.parse(result.stdout) as {
			results: Array<{ skill: string; blockId: string; status: string; reason?: string }>;
		};
		expect(parsed.results).toHaveLength(CANONICAL_GJC_WORKFLOW_SKILLS.length);
		for (const item of parsed.results) {
			expect([...CANONICAL_GJC_WORKFLOW_SKILLS] as string[]).toContain(item.skill);
			expect(item.blockId).toBe("state");
			expect(["BYTE-EQUAL", "GAP"]).toContain(item.status);
		}
		expect(
			parsed.results.every(item => item.status === "GAP" && item.reason === "unmarked / not yet generated"),
		).toBe(true);
	});

	it("prints per-skill token budget report", async () => {
		const result = await runBun(["scripts/audit-skill-token-budget.ts", "--json"]);
		expect(result.exitCode).toBe(0);
		expect(result.stderr).toBe("");
		const parsed = JSON.parse(result.stdout) as {
			skills: Array<{ skill: string; bytes: number; approxTokens: number; sections: unknown[] }>;
		};
		expect(parsed.skills).toHaveLength(CANONICAL_GJC_WORKFLOW_SKILLS.length);
		for (const item of parsed.skills) {
			expect([...CANONICAL_GJC_WORKFLOW_SKILLS] as string[]).toContain(item.skill);
			expect(item.bytes).toBeGreaterThan(0);
			expect(item.approxTokens).toBeGreaterThan(0);
			expect(Array.isArray(item.sections)).toBe(true);
		}
	});
});
