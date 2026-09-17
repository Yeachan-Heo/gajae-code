/**
 * Truncation reporting for `discoverRuntimeSkills` and the `gjc skills discover`
 * flags that let a human page past it (issue #5536). Before this, the library
 * sliced matched candidates to a limit with no signal and the CLI passed neither
 * `query` nor `limit`, so a registered skill beyond the first 20 was invocable by
 * exact name and absent from every listing with nothing explaining the gap.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { getConfigRootDir, setAgentDir } from "@gajae-code/utils";
import { safeRm } from "../../../scripts/safe-cleanup";
import { runSkillsCommand } from "../src/cli/skills-cli";
import Skills from "../src/commands/skills";
import { resetSettingsForTest } from "../src/config/settings";
import type { SkillsSettings } from "../src/config/settings-schema";
import { discoverRuntimeSkills, SKILL_DISCOVERY_MAX_LIMIT } from "../src/extensibility/runtime-skill-discovery";

/** Mirrors the library's bounded diagnostic budget; the truncation notice must outlive it. */
const MAX_DIAGNOSTICS = 10;
/** Library default page size, unchanged by #5536 so the agent tool's context budget is untouched. */
const DEFAULT_LIMIT = 20;

const roots: string[] = [];

async function makeRoot(prefix: string): Promise<string> {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), `gjc-5536-${prefix}-`));
	roots.push(root);
	return root;
}

async function makeSkill(root: string, name: string, description: string): Promise<string> {
	const dir = path.join(root, name);
	await fs.mkdir(dir, { recursive: true });
	const filePath = path.join(dir, "SKILL.md");
	await fs.writeFile(filePath, `---\nname: ${name}\ndescription: ${description}\n---\n\n# ${name}\n`, "utf8");
	return filePath;
}

/**
 * Discovery isolated to `skills.customDirectories`: both ambient scopes are
 * untrusted, so nothing on the developer's real machine can change the counts,
 * while custom directories stay visible (naming one is explicit consent).
 */
function policy(customDirectories: string[]): SkillsSettings {
	return { enabled: true, trustProjectSkills: false, trustUserSkills: false, customDirectories };
}

/** Filler names sort before "ego-browser", so the registered skill falls past the limit. */
async function makeFiller(root: string, count: number): Promise<void> {
	for (let i = 0; i < count; i += 1) {
		await makeSkill(root, `alpha-filler-${String(i).padStart(2, "0")}`, `Filler skill number ${i}`);
	}
}

function truncationMessages(messages: string[]): string[] {
	return messages.filter(message => message.startsWith("showing "));
}

afterEach(async () => {
	for (const root of roots.splice(0)) await safeRm(root, { recursive: true, force: true });
});

describe("discoverRuntimeSkills truncation diagnostics", () => {
	// AC1: the reported repro. 22 filler skills bury a registered skill, and the
	// default page hides it with no explanation.
	it("reports the hidden remainder and still finds the buried skill by query", async () => {
		const cwd = await makeRoot("cwd");
		const home = await makeRoot("home");
		const egoDir = await makeRoot("ego");
		const fillerDir = await makeRoot("filler");
		await makeFiller(fillerDir, 22);
		await makeSkill(egoDir, "ego-browser", "Drive the ego browser");

		const result = await discoverRuntimeSkills({ cwd, home, policy: policy([egoDir, fillerDir]) });

		expect(result.candidates).toHaveLength(DEFAULT_LIMIT);
		expect(result.candidates.map(candidate => candidate.name)).not.toContain("ego-browser");
		expect(truncationMessages(result.diagnostics.messages)).toEqual([
			`showing 20 of 23 matching skills; raise the limit (max ${SKILL_DISCOVERY_MAX_LIMIT}) or narrow the query to see the rest`,
		]);

		const narrowed = await discoverRuntimeSkills({
			cwd,
			home,
			query: "ego-browser",
			policy: policy([egoDir, fillerDir]),
		});
		expect(narrowed.candidates.map(candidate => candidate.name)).toEqual(["ego-browser"]);
		expect(truncationMessages(narrowed.diagnostics.messages)).toEqual([]);
	});

	// AC2: the exact interaction that makes a budgeted notice vacuous. Stale
	// customDirectories entries (purged plugin caches) emit one diagnostic each
	// and exhaust MAX_DIAGNOSTICS before the slice is reached.
	it("keeps the truncation notice when the diagnostic budget is already full", async () => {
		const cwd = await makeRoot("budget-cwd");
		const home = await makeRoot("budget-home");
		const fillerDir = await makeRoot("budget-filler");
		await makeFiller(fillerDir, 22);
		const missing = Array.from({ length: 12 }, (_, i) => path.join(cwd, "purged-paseo-skills", String(i)));

		const result = await discoverRuntimeSkills({ cwd, home, policy: policy([...missing, fillerDir]) });

		// The budget really is exhausted: 12 missing dirs, only 10 messages kept.
		expect(result.diagnostics.messages.filter(message => message.includes("does not exist"))).toHaveLength(
			MAX_DIAGNOSTICS,
		);
		expect(truncationMessages(result.diagnostics.messages)).toEqual([
			`showing 20 of 22 matching skills; raise the limit (max ${SKILL_DISCOVERY_MAX_LIMIT}) or narrow the query to see the rest`,
		]);
	});

	// AC3: a full-but-not-truncated page is not truncation, and an empty result is
	// already explained by describeNoSkillMatch.
	it("stays silent when nothing was dropped", async () => {
		const cwd = await makeRoot("exact-cwd");
		const home = await makeRoot("exact-home");
		const fillerDir = await makeRoot("exact-filler");
		await makeFiller(fillerDir, 5);

		const exact = await discoverRuntimeSkills({ cwd, home, limit: 5, policy: policy([fillerDir]) });
		expect(exact.candidates).toHaveLength(5);
		expect(truncationMessages(exact.diagnostics.messages)).toEqual([]);

		const empty = await discoverRuntimeSkills({
			cwd,
			home,
			query: "no-skill-mentions-this-term",
			policy: policy([fillerDir]),
		});
		expect(empty.candidates).toEqual([]);
		expect(truncationMessages(empty.diagnostics.messages)).toEqual([]);
	});

	// AC4: clamping stays the library's job, so the command layer can forward a
	// raw user value without a second bound and without crashing.
	it("clamps an out-of-range limit instead of throwing", async () => {
		const cwd = await makeRoot("clamp-cwd");
		const home = await makeRoot("clamp-home");
		const fillerDir = await makeRoot("clamp-filler");
		await makeFiller(fillerDir, 55);

		const high = await discoverRuntimeSkills({ cwd, home, limit: 999, policy: policy([fillerDir]) });
		expect(high.candidates).toHaveLength(SKILL_DISCOVERY_MAX_LIMIT);
		expect(truncationMessages(high.diagnostics.messages)).toEqual([
			`showing 50 of 55 matching skills; raise the limit (max ${SKILL_DISCOVERY_MAX_LIMIT}) or narrow the query to see the rest`,
		]);

		for (const limit of [0, -5]) {
			const low = await discoverRuntimeSkills({ cwd, home, limit, policy: policy([fillerDir]) });
			expect(low.candidates).toHaveLength(1);
		}
	});
});

describe("gjc skills discover flags", () => {
	let agentDir = "";
	let originalCwd = "";
	const previousAgentDir = process.env.GJC_CODING_AGENT_DIR;
	const fallbackAgentDir = path.join(getConfigRootDir(), "agent");

	beforeEach(async () => {
		resetSettingsForTest();
		originalCwd = process.cwd();
		agentDir = await makeRoot("agent");
		setAgentDir(agentDir);
	});

	afterEach(() => {
		process.chdir(originalCwd);
		vi.restoreAllMocks();
		resetSettingsForTest();
		if (previousAgentDir) {
			setAgentDir(previousAgentDir);
		} else {
			setAgentDir(fallbackAgentDir);
			delete process.env.GJC_CODING_AGENT_DIR;
		}
	});

	it("declares --limit and --query on the command", () => {
		// integer, not string: the command layer must hand the library a number so
		// normalizeLimit can clamp it (no second clamp here).
		expect(Skills.flags.limit.kind).toBe("integer");
		expect(Skills.flags.query.kind).toBe("string");
		expect(Skills.examples.some(example => example.includes("--query"))).toBe(true);
		expect(Skills.examples.some(example => example.includes("--limit"))).toBe(true);
	});

	// AC5: the flags must actually reach discoverRuntimeSkills, and --json must
	// carry `scanned` so "how many were there really" is machine-readable.
	it("forwards limit and query into discovery and reports scanned in JSON", async () => {
		const cwd = await makeRoot("cli-cwd");
		const fillerDir = await makeRoot("cli-filler");
		await makeFiller(fillerDir, 6);
		await fs.writeFile(
			path.join(agentDir, "config.yml"),
			[
				"configSchemaVersion: 2",
				"skills:",
				"  enabled: true",
				"  trustProjectSkills: false",
				"  trustUserSkills: false",
				"  customDirectories:",
				`    - ${fillerDir}`,
				"",
			].join("\n"),
			"utf8",
		);
		resetSettingsForTest();
		process.chdir(cwd);

		const chunks: string[] = [];
		vi.spyOn(process.stdout, "write").mockImplementation(chunk => {
			chunks.push(String(chunk));
			return true;
		});

		await runSkillsCommand({ action: "discover", flags: { json: true, limit: 2, query: "alpha-filler" } });

		const payload = JSON.parse(chunks.join("")) as {
			candidates: Array<{ name: string }>;
			scanned: number;
			diagnostics: string[];
		};
		expect(payload.candidates.map(candidate => candidate.name)).toEqual(["alpha-filler-00", "alpha-filler-01"]);
		expect(payload.scanned).toBe(6);
		expect(truncationMessages(payload.diagnostics)).toEqual([
			`showing 2 of 6 matching skills; raise the limit (max ${SKILL_DISCOVERY_MAX_LIMIT}) or narrow the query to see the rest`,
		]);
	});
});
