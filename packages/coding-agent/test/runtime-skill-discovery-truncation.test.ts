/**
 * Paging for `discoverRuntimeSkills` and the `gjc skills discover` flags that
 * expose it (issue #5536). Before this, the library sliced matched candidates to
 * a limit with no signal and the CLI passed neither `query` nor `limit`, so a
 * registered skill beyond the first 20 was invocable by exact name and absent
 * from every listing with nothing explaining the gap. Raising the CLI default to
 * 50 only moved the cliff, so the page is now addressable by `--offset`.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { safeRm } from "../../../scripts/safe-cleanup";
import Skills from "../src/commands/skills";
import type { SkillsSettings } from "../src/config/settings-schema";
import { discoverRuntimeSkills, SKILL_DISCOVERY_MAX_LIMIT } from "../src/extensibility/runtime-skill-discovery";

/** Mirrors the library's bounded diagnostic budget; the paging notice must outlive it. */
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
 *
 * Untrusting the scopes is not enough on its own: the bundled workflow skills
 * are scanned under `source: "all"` regardless of trust and of the
 * include/ignore/disabled filters, so every call below also pins
 * `source: "user"` — the scope that excludes bundled skills by design and still
 * covers custom directories. Without that pin, adding one bundled skill shifts
 * every count and diagnostic string asserted in this file.
 */
function policy(customDirectories: string[]): SkillsSettings {
	return { enabled: true, trustProjectSkills: false, trustUserSkills: false, customDirectories };
}

function fillerName(index: number): string {
	return `alpha-filler-${String(index).padStart(2, "0")}`;
}

/** Filler names sort before "ego-browser", so the registered skill falls past the limit. */
async function makeFiller(root: string, count: number): Promise<void> {
	for (let i = 0; i < count; i += 1) {
		await makeSkill(root, fillerName(i), `Filler skill number ${i}`);
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

		const result = await discoverRuntimeSkills({ cwd, home, source: "user", policy: policy([egoDir, fillerDir]) });

		expect(result.candidates).toHaveLength(DEFAULT_LIMIT);
		expect(result.candidates.map(candidate => candidate.name)).not.toContain("ego-browser");
		expect(truncationMessages(result.diagnostics.messages)).toEqual([
			"showing 1-20 of 23 matching skills; pass --offset 20 for the next page, or narrow the query",
		]);

		const narrowed = await discoverRuntimeSkills({
			cwd,
			home,
			source: "user",
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

		const result = await discoverRuntimeSkills({
			cwd,
			home,
			source: "user",
			policy: policy([...missing, fillerDir]),
		});

		// The budget really is exhausted: 12 missing dirs, only 10 messages kept.
		expect(result.diagnostics.messages.filter(message => message.includes("does not exist"))).toHaveLength(
			MAX_DIAGNOSTICS,
		);
		expect(truncationMessages(result.diagnostics.messages)).toEqual([
			"showing 1-20 of 22 matching skills; pass --offset 20 for the next page, or narrow the query",
		]);
	});

	// AC3: a full-but-not-truncated page is not truncation, and an empty result is
	// already explained by describeNoSkillMatch.
	it("stays silent when nothing was dropped", async () => {
		const cwd = await makeRoot("exact-cwd");
		const home = await makeRoot("exact-home");
		const fillerDir = await makeRoot("exact-filler");
		await makeFiller(fillerDir, 5);

		const exact = await discoverRuntimeSkills({ cwd, home, source: "user", limit: 5, policy: policy([fillerDir]) });
		expect(exact.candidates).toHaveLength(5);
		expect(truncationMessages(exact.diagnostics.messages)).toEqual([]);

		const empty = await discoverRuntimeSkills({
			cwd,
			home,
			source: "user",
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

		const high = await discoverRuntimeSkills({ cwd, home, source: "user", limit: 999, policy: policy([fillerDir]) });
		expect(high.candidates).toHaveLength(SKILL_DISCOVERY_MAX_LIMIT);
		expect(truncationMessages(high.diagnostics.messages)).toEqual([
			"showing 1-50 of 55 matching skills; pass --offset 50 for the next page, or narrow the query",
		]);

		for (const limit of [0, -5]) {
			const low = await discoverRuntimeSkills({ cwd, home, source: "user", limit, policy: policy([fillerDir]) });
			expect(low.candidates).toHaveLength(1);
		}
	});

	// AC5 (library half): an offset is a stateless page cursor, the final page
	// carries no continuation, and an offset past the end is an empty page with a
	// way back rather than a silent nothing.
	it("pages by offset, drops the continuation on the last page, and explains an offset past the end", async () => {
		const cwd = await makeRoot("offset-cwd");
		const home = await makeRoot("offset-home");
		const fillerDir = await makeRoot("offset-filler");
		await makeFiller(fillerDir, 12);

		const last = await discoverRuntimeSkills({
			cwd,
			home,
			source: "user",
			limit: 5,
			offset: 10,
			policy: policy([fillerDir]),
		});
		expect(last.candidates.map(candidate => candidate.name)).toEqual([fillerName(10), fillerName(11)]);
		expect(last.matching).toBe(12);
		expect(last.offset).toBe(10);
		expect(last.nextOffset).toBeUndefined();
		expect(truncationMessages(last.diagnostics.messages)).toEqual(["showing 11-12 of 12 matching skills"]);

		const past = await discoverRuntimeSkills({
			cwd,
			home,
			source: "user",
			limit: 5,
			offset: 40,
			policy: policy([fillerDir]),
		});
		expect(past.candidates).toEqual([]);
		expect(past.nextOffset).toBeUndefined();
		expect(past.diagnostics.messages).toContain(
			"no skills at offset 40; 12 matching skills total, pass --offset 0 to start over",
		);

		// A negative offset is normalized to the first page, not to an error.
		const negative = await discoverRuntimeSkills({
			cwd,
			home,
			source: "user",
			limit: 5,
			offset: -3,
			policy: policy([fillerDir]),
		});
		expect(negative.offset).toBe(0);
		expect(negative.candidates.map(candidate => candidate.name)).toEqual([
			fillerName(0),
			fillerName(1),
			fillerName(2),
			fillerName(3),
			fillerName(4),
		]);
		expect(negative.nextOffset).toBe(5);
	});
});

/**
 * The CLI half runs the real binary in a subprocess, exactly as
 * plugin-command.test.ts does, so oclif actually parses the flags and the
 * assertions cover the whole command path instead of a hand-built args object.
 * The catalog is two differently-named groups: a query that selects only one of
 * them is what makes query forwarding falsifiable.
 */
describe("gjc skills discover paging", () => {
	const FILLER_COUNT = 55;
	const TARGET_COUNT = 3;
	/**
	 * The CLI counterpart of `policy()`: `GJC_CODING_AGENT_DIR` isolates the user
	 * scope's filesystem, but the bundled workflow skills are scanned under the
	 * default `--source all` regardless of trust, so the catalog is pinned to the
	 * user scope — where the fixture's customDirectories live and bundled skills do
	 * not — to keep `allNames` the whole catalog.
	 */
	const USER_SCOPE = ["--source", "user"];
	const targetName = (index: number) => `zeta-target-${index}`;
	const allNames = [
		...Array.from({ length: FILLER_COUNT }, (_, i) => fillerName(i)),
		...Array.from({ length: TARGET_COUNT }, (_, i) => targetName(i)),
	];
	let fixtureRoot = "";
	let agentDir = "";
	let cwd = "";

	interface DiscoverPayload {
		candidates: Array<{ name: string }>;
		scanned: number;
		matching: number;
		offset: number;
		nextOffset?: number;
		diagnostics: string[];
	}

	async function runDiscover(args: string[]): Promise<{ exitCode: number; stdout: string; stderr: string }> {
		const proc = Bun.spawn({
			cmd: [process.execPath, path.join(import.meta.dir, "../src/cli.ts"), "skills", "discover", ...args],
			cwd,
			// Isolate the user scope: without this the child reads the developer's
			// real ~/.gjc/agent config and the counts stop being deterministic.
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

	async function discoverJson(args: string[]): Promise<{ raw: string; payload: DiscoverPayload }> {
		const result = await runDiscover(["--json", ...args]);
		expect(result.exitCode).toBe(0);
		return { raw: result.stdout, payload: JSON.parse(result.stdout) as DiscoverPayload };
	}

	const names = (payload: DiscoverPayload): string[] => payload.candidates.map(candidate => candidate.name);

	beforeAll(async () => {
		fixtureRoot = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-5536-cli-"));
		agentDir = path.join(fixtureRoot, "agent");
		cwd = path.join(fixtureRoot, "cwd");
		const skillsDir = path.join(fixtureRoot, "skills");
		for (const dir of [agentDir, cwd, skillsDir]) await fs.mkdir(dir, { recursive: true });
		await makeFiller(skillsDir, FILLER_COUNT);
		for (let i = 0; i < TARGET_COUNT; i += 1) {
			await makeSkill(skillsDir, targetName(i), `Target skill number ${i}`);
		}
		await fs.writeFile(
			path.join(agentDir, "config.yml"),
			[
				"configSchemaVersion: 2",
				"skills:",
				"  enabled: true",
				"  trustProjectSkills: false",
				"  trustUserSkills: false",
				"  customDirectories:",
				`    - ${skillsDir}`,
				"",
			].join("\n"),
			"utf8",
		);
	});

	afterAll(async () => {
		if (fixtureRoot) await safeRm(fixtureRoot, { recursive: true, force: true });
	});

	it("declares --limit, --query, and --offset on the command", () => {
		// integer, not string: the command layer must hand the library a number so
		// normalizeLimit/normalizeOffset can clamp it (no second clamp here).
		expect(Skills.flags.limit.kind).toBe("integer");
		expect(Skills.flags.offset.kind).toBe("integer");
		expect(Skills.flags.query.kind).toBe("string");
		for (const flag of ["--query", "--limit", "--offset"]) {
			expect(Skills.examples.some(example => example.includes(flag))).toBe(true);
		}
	});

	// The assertion the previous version of this test was missing: it passed an
	// explicit limit, so it stayed green with the CLI default reverted.
	it("defaults an unflagged page to the library maximum, not the agent-sized default", async () => {
		// Unflagged means no --limit: the scope pin below never sets a page size.
		const { payload } = await discoverJson([...USER_SCOPE]);

		expect(payload.candidates).toHaveLength(SKILL_DISCOVERY_MAX_LIMIT);
		expect(names(payload)).toEqual(allNames.slice(0, SKILL_DISCOVERY_MAX_LIMIT));
		expect(payload.matching).toBe(allNames.length);
		expect(payload.nextOffset).toBe(SKILL_DISCOVERY_MAX_LIMIT);
	});

	it("forwards --query so the non-matching group is excluded", async () => {
		const { payload } = await discoverJson([...USER_SCOPE, "--query", "zeta-target"]);

		expect(names(payload)).toEqual(Array.from({ length: TARGET_COUNT }, (_, i) => targetName(i)));
		expect(payload.nextOffset).toBeUndefined();
	});

	// `matching` is the page denominator; `scanned` is what the query filter ran
	// against. A filtered query is where the two numbers have to diverge, which is
	// what makes the new field more than a rename of the old one.
	it("reports matching below scanned once a query filters the catalog", async () => {
		const { payload } = await discoverJson([...USER_SCOPE, "--query", "zeta-target"]);

		expect(payload.scanned).toBe(allNames.length);
		expect(payload.matching).toBe(TARGET_COUNT);
	});

	it("pages the whole matching set contiguously and omits nextOffset on the final page", async () => {
		const first = await discoverJson([...USER_SCOPE, "--offset", "0"]);
		const second = await discoverJson([...USER_SCOPE, "--offset", String(SKILL_DISCOVERY_MAX_LIMIT)]);

		expect(first.payload.offset).toBe(0);
		expect(first.payload.nextOffset).toBe(SKILL_DISCOVERY_MAX_LIMIT);
		expect(second.payload.offset).toBe(SKILL_DISCOVERY_MAX_LIMIT);
		expect(second.payload.nextOffset).toBeUndefined();
		// Absent, not null: a serialized `"nextOffset": null` would satisfy
		// toBeUndefined() after parsing and still mislead a machine consumer.
		expect(second.raw).not.toContain("nextOffset");

		const firstNames = names(first.payload);
		const secondNames = names(second.payload);
		expect(firstNames.filter(name => secondNames.includes(name))).toEqual([]);
		expect([...firstNames, ...secondNames]).toEqual(allNames);
	});

	// The #5536 failure mode at the new threshold: with the CLI default of 50,
	// entry 51 must be reachable by flag rather than only by exact name.
	it("reaches position 51 of the catalog, which no flag combination could return before", async () => {
		const fiftyFirst = allNames[SKILL_DISCOVERY_MAX_LIMIT];

		const firstPage = await discoverJson([...USER_SCOPE]);
		expect(names(firstPage.payload)).not.toContain(fiftyFirst);

		const nextPage = await discoverJson([...USER_SCOPE, "--offset", String(SKILL_DISCOVERY_MAX_LIMIT)]);
		expect(names(nextPage.payload)[0]).toBe(fiftyFirst);
	});

	it("prints a next-page command that round-trips, and prints none on the last page", async () => {
		const text = await runDiscover([...USER_SCOPE, "--limit", "50", "--query", "alpha-filler"]);
		expect(text.exitCode).toBe(0);

		const nextPageLine = text.stdout.split("\n").find(line => line.startsWith("Next page: "));
		// The filters the invocation carried are echoed back, so the printed line
		// is runnable as printed instead of silently dropping the query. A non-"all"
		// --source is one of those filters, which is why the replay below inherits
		// the scope pin from the printed command rather than re-adding it.
		expect(nextPageLine).toBe(
			"Next page: gjc skills discover --offset 50 --limit 50 --query alpha-filler --source user",
		);

		const replayArgs = (nextPageLine ?? "").replace("Next page: gjc skills discover ", "").split(" ");
		const replayed = await discoverJson(replayArgs);
		expect(names(replayed.payload)).toEqual(allNames.slice(SKILL_DISCOVERY_MAX_LIMIT, FILLER_COUNT));

		const lastPage = await runDiscover([...USER_SCOPE, "--offset", String(SKILL_DISCOVERY_MAX_LIMIT)]);
		expect(lastPage.exitCode).toBe(0);
		expect(lastPage.stdout).not.toContain("Next page:");
	});
});
