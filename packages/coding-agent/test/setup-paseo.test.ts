import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { parseSetupArgs } from "../src/cli/setup-cli";
import { checkPaseoSetup, STALE_GUIDANCE } from "../src/setup/paseo/check";
import { type CompletedStep, compensate, recoverIntent, SagaStepError } from "../src/setup/paseo/install-saga";
import {
	currentIdentity,
	hashBytes,
	planPublish,
	publishPlan,
	readTarget,
	serializeJson,
} from "../src/setup/paseo/json-publisher";
import { createOrchestrationSeed } from "../src/setup/paseo/orchestration-preferences";
import {
	classifyIdentity,
	classifyIntent,
	INTENT_VERSION,
	type IntentRecord,
	isProvenancedProvider,
	provenancedProviderKeys,
	readIntent,
	readProvenance,
	writeIntent,
	writeProvenance,
} from "../src/setup/paseo/paseo-ownership";
import { assertUsableFlags, PaseoSetupUsageError } from "../src/setup/paseo/paseo-setup";
import {
	buildProviderEntry,
	hasProviderConflict,
	providerEntryHash,
	providerKeyFor,
	resolveGjcCommand,
} from "../src/setup/paseo/provider-config";
import { removePaseoSetup } from "../src/setup/paseo/remove";
import { checkExitCode, type SetupCheckStatus } from "../src/setup/paseo/result-types";
import {
	createDefaultPaseoPaths,
	type PaseoLsOutcome,
	type PaseoPaths,
	type PaseoSetupDependencies,
	parseProviderLs,
	resolvePaseoHome,
} from "../src/setup/paseo/setup-deps";
import { installSkillsBridge, preflightSkillsBridge, SkillsBridgeError } from "../src/setup/paseo/skills-bridge";

const FIXTURE_PASSWORD = "$2b$10$FIXTUREFIXTUREFIXTUREFIXTUREFIXTUREFIXTUREFIXTUREFIXTUR";
const SKILL_NAMES = ["paseo", "paseo-advisor", "paseo-committee", "paseo-handoff", "paseo-loop"];

describe("Paseo home resolution", () => {
	test("shares custom and tilde-expanded PASEO_HOME paths with setup", () => {
		const home = "/home/tester";
		const agentDir = "/home/tester/.gjc/agent";
		expect(resolvePaseoHome({ PASEO_HOME: "/srv/paseo" }, home)).toBe("/srv/paseo");
		expect(resolvePaseoHome({ PASEO_HOME: "~/custom-paseo" }, home)).toBe("/home/tester/custom-paseo");
		expect(createDefaultPaseoPaths(agentDir, home, { PASEO_HOME: "/srv/paseo" }).configJson).toBe(
			"/srv/paseo/config.json",
		);
	});
});
/** Built from codepoints so this test file stays pure ASCII on disk. */
const NON_ASCII_VALUE = String.fromCodePoint(0xd55c, 0xad6d, 0xc5b4);

/** A reachable-daemon outcome carrying the measured row shape. */
function lsOk(...ids: string[]): PaseoLsOutcome {
	return { kind: "ok", providerIds: ids, rows: ids.map(id => ({ id, status: "available" })) };
}

const tempRoots: string[] = [];

afterEach(async () => {
	for (const root of tempRoots.splice(0)) {
		await fs.rm(root, { recursive: true, force: true }).catch(() => undefined);
	}
});

async function makeRoot(): Promise<string> {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-paseo-test-"));
	tempRoots.push(root);
	return root;
}

interface Fixture {
	readonly root: string;
	readonly paths: PaseoPaths;
	readonly deps: PaseoSetupDependencies;
	readonly probes: number[];
	readonly spawned: string[][];
}

/**
 * Build a fully isolated fixture.
 *
 * Every path points inside a temp root, so no test can reach the real
 * `~/.paseo`, `~/.agents`, or `~/.gjc`. `runProviderLs` is injected rather than
 * mocked at module scope, which is why this suite needs no `mock.module()`.
 */
async function makeFixture(outcome: PaseoLsOutcome = { kind: "timeout", timeoutMs: 5_000 }): Promise<Fixture> {
	const root = await makeRoot();
	const home = path.join(root, "home");
	const agentDir = path.join(root, "agentdir");
	const paseoHome = path.join(home, ".paseo");
	const agentsSkills = path.join(home, ".agents", "skills");
	await fs.mkdir(paseoHome, { recursive: true });
	await fs.mkdir(agentsSkills, { recursive: true });
	await fs.mkdir(path.join(agentDir, "skills"), { recursive: true });

	const paths: PaseoPaths = {
		configJson: path.join(paseoHome, "config.json"),
		orchestrationPreferences: path.join(paseoHome, "orchestration-preferences.json"),
		agentsSkillsDir: agentsSkills,
		bridgeDir: path.join(agentDir, "paseo-skills"),
		provenanceLedger: path.join(agentDir, "paseo", "provenance.json"),
		intentRecord: path.join(agentDir, "paseo", "intent.json"),
		gjcSkillsDir: path.join(agentDir, "skills"),
	};

	const probes: number[] = [];
	const spawned: string[][] = [];
	const deps: PaseoSetupDependencies = {
		paths,
		runProviderLs: async timeoutMs => {
			probes.push(timeoutMs);
			return outcome;
		},
		now: () => new Date("2026-01-01T00:00:00.000Z"),
	};
	return { root, paths, deps, probes, spawned };
}

async function seedConfig(paths: PaseoPaths, providers: Record<string, unknown> = {}): Promise<void> {
	const config = {
		daemon: { auth: { password: FIXTURE_PASSWORD }, port: 4317 },
		agents: { providers: { claude: { enabled: true }, ...providers } },
	};
	await fs.writeFile(paths.configJson, serializeJson(config), { mode: 0o600 });
}

async function seedSkills(paths: PaseoPaths, extra: string[] = []): Promise<void> {
	for (const name of [...SKILL_NAMES, ...extra]) {
		await fs.mkdir(path.join(paths.agentsSkillsDir, name), { recursive: true });
		await fs.writeFile(path.join(paths.agentsSkillsDir, name, "SKILL.md"), `# ${name}\n`);
	}
}

/** Recursive metadata + content snapshot, used to prove a tree was not modified. */
async function snapshotTree(root: string): Promise<string> {
	const rows: string[] = [];
	async function walk(dir: string): Promise<void> {
		const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
		for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
			const full = path.join(dir, entry.name);
			const rel = path.relative(root, full);
			const stat = await fs.lstat(full);
			if (entry.isSymbolicLink()) {
				rows.push(`link ${rel} -> ${await fs.readlink(full)}`);
			} else if (entry.isDirectory()) {
				rows.push(`dir ${rel} ${(stat.mode & 0o777).toString(8)}`);
				await walk(full);
			} else {
				rows.push(`file ${rel} ${(stat.mode & 0o777).toString(8)} ${hashBytes(await fs.readFile(full, "utf8"))}`);
			}
		}
	}
	await walk(root);
	return rows.join("\n");
}

function providersOf(parsed: Record<string, unknown>): Record<string, unknown> {
	const agents = parsed.agents;
	if (!agents || typeof agents !== "object" || Array.isArray(agents)) return {};
	const providers = (agents as Record<string, unknown>).providers;
	if (!providers || typeof providers !== "object" || Array.isArray(providers)) return {};
	return providers as Record<string, unknown>;
}

describe("byte preservation (AC-3)", () => {
	test("2-space input round-trips and preserves non-owned regions", async () => {
		const { paths } = await makeFixture();
		await seedConfig(paths);
		const original = await fs.readFile(paths.configJson, "utf8");

		const current = await readTarget(paths.configJson);
		expect(current.raw).toBe(original);

		const plan = planPublish(current, draft => {
			providersOf(draft).gjc = { enabled: true };
		});
		await publishPlan(paths.configJson, plan, {
			expectedIdentity: current.identity,
			backup: false,
			now: new Date(),
		});

		const after = JSON.parse(await fs.readFile(paths.configJson, "utf8")) as Record<string, unknown>;
		// The regions we do not own must survive untouched, including the credential.
		expect(JSON.stringify(after.daemon)).toBe(JSON.stringify({ auth: { password: FIXTURE_PASSWORD }, port: 4317 }));
		expect(JSON.stringify(providersOf(after).claude)).toBe(JSON.stringify({ enabled: true }));
	});

	test.each([
		["4-space indentation", (o: unknown) => `${JSON.stringify(o, null, 4)}\n`],
		["tab indentation", (o: unknown) => `${JSON.stringify(o, null, "\t")}\n`],
		["no trailing newline", (o: unknown) => JSON.stringify(o, null, 2)],
	])("%s is refused as format-drift and nothing is written", async (_label: string, encode: (
		o: unknown,
	) => string) => {
		const { paths } = await makeFixture();
		await fs.writeFile(paths.configJson, encode({ agents: { providers: {} } }));
		const before = await fs.readFile(paths.configJson, "utf8");

		await expect(readTarget(paths.configJson)).rejects.toMatchObject({
			name: "PaseoPublishError",
			refusal: { reason: "format-drift" },
		});
		expect(await fs.readFile(paths.configJson, "utf8")).toBe(before);
	});

	test("unparseable JSON is refused as parse-refusal and nothing is written", async () => {
		const { paths } = await makeFixture();
		await fs.writeFile(paths.configJson, "{ not json ");
		const before = await fs.readFile(paths.configJson, "utf8");

		await expect(readTarget(paths.configJson)).rejects.toMatchObject({
			refusal: { reason: "parse-refusal" },
		});
		expect(await fs.readFile(paths.configJson, "utf8")).toBe(before);
	});

	test("non-ASCII values round-trip under 2-space encoding", async () => {
		const { paths } = await makeFixture();
		await fs.writeFile(paths.configJson, serializeJson({ label: NON_ASCII_VALUE, agents: { providers: {} } }));
		const current = await readTarget(paths.configJson);
		expect(current.parsed.label).toBe(NON_ASCII_VALUE);
	});

	test("number spellings that do not survive re-serialization are refused", async () => {
		const { paths } = await makeFixture();
		// `1e3` re-serializes as `1000`, so the self-check must catch it rather
		// than silently normalizing a file we do not own.
		await fs.writeFile(paths.configJson, '{\n  "timeout": 1e3\n}\n');
		await expect(readTarget(paths.configJson)).rejects.toMatchObject({
			refusal: { reason: "format-drift" },
		});
	});
});

describe("compare-and-swap", () => {
	test("publish refuses when the file changed after it was read", async () => {
		const { paths } = await makeFixture();
		await seedConfig(paths);
		const current = await readTarget(paths.configJson);
		const plan = planPublish(current, draft => {
			providersOf(draft).gjc = { enabled: true };
		});

		// Another writer lands between our read and our publish.
		await fs.writeFile(paths.configJson, serializeJson({ agents: { providers: { other: { enabled: true } } } }));
		const interleaved = await fs.readFile(paths.configJson, "utf8");

		await expect(
			publishPlan(paths.configJson, plan, { expectedIdentity: current.identity, backup: false, now: new Date() }),
		).rejects.toMatchObject({ refusal: { reason: "cas-conflict" } });
		expect(await fs.readFile(paths.configJson, "utf8")).toBe(interleaved);
	});
});

describe("backup safety", () => {
	test("backups are always mode 0600 even when the source is world-readable", async () => {
		const { paths } = await makeFixture();
		await fs.writeFile(paths.orchestrationPreferences, serializeJson({}), { mode: 0o644 });

		const current = await readTarget(paths.orchestrationPreferences);
		const plan = planPublish(current, draft => {
			draft.providers = { impl: "gjc" };
		});
		const result = await publishPlan(paths.orchestrationPreferences, plan, {
			expectedIdentity: current.identity,
			backup: true,
			now: new Date("2026-01-01T00:00:00.000Z"),
		});

		expect(result.backupPath).toBeDefined();
		const stat = await fs.stat(result.backupPath as string);
		expect(stat.mode & 0o777).toBe(0o600);
		// Republishing must not widen the source's own permissions either.
		expect((await fs.stat(paths.orchestrationPreferences)).mode & 0o777).toBe(0o644);
	});

	test("the credential never appears in a check result", async () => {
		const fixture = await makeFixture();
		await seedConfig(fixture.paths);
		const result = await checkPaseoSetup(fixture.deps);
		expect(JSON.stringify(result)).not.toContain(FIXTURE_PASSWORD);
	});
});

describe("executable resolution", () => {
	function withChannel<T>(channel: string | undefined, compiled: boolean, fn: () => T): T {
		const priorChannel = process.env.GJC_BUILD_CHANNEL;
		const priorCompiled = process.env.PI_COMPILED;
		if (channel === undefined) delete process.env.GJC_BUILD_CHANNEL;
		else process.env.GJC_BUILD_CHANNEL = channel;
		if (compiled) process.env.PI_COMPILED = "true";
		else delete process.env.PI_COMPILED;
		try {
			return fn();
		} finally {
			if (priorChannel === undefined) delete process.env.GJC_BUILD_CHANNEL;
			else process.env.GJC_BUILD_CHANNEL = priorChannel;
			if (priorCompiled === undefined) delete process.env.PI_COMPILED;
			else process.env.PI_COMPILED = priorCompiled;
		}
	}

	// A shipped binary defines PI_COMPILED together with channel release/dev, and
	// resolveBuildMetadata reads the explicit channel first, so it never reports
	// "compiled". Grouping release/dev/compiled is the fix for that defect.
	test.each(["release", "dev"])("channel %s resolves to the running executable", (channel: string) => {
		const resolution = withChannel(channel, true, () => resolveGjcCommand());
		expect(resolution.ok).toBe(true);
		if (resolution.ok) expect(resolution.command).toEqual([process.execPath, "acp"]);
	});

	test("unknown channel is a hard failure naming the channel", () => {
		const resolution = withChannel("unknown", false, () => resolveGjcCommand());
		expect(resolution.ok).toBe(false);
		if (!resolution.ok) expect(resolution.channel).toBe("unknown");
	});

	test("no resolution ever emits a bare gjc string", () => {
		for (const channel of ["release", "dev", "unknown", undefined]) {
			const compiled = channel === "release" || channel === "dev";
			const resolution = withChannel(channel, compiled, () => resolveGjcCommand());
			if (resolution.ok) expect(resolution.command[0]).not.toBe("gjc");
		}
	});
});

describe("provider entry", () => {
	test("permission mode is always prompt, with and without an mpreset", () => {
		expect(buildProviderEntry(["/bin/gjc", "acp"]).env.GJC_ACP_PERMISSION_MODE).toBe("prompt");
		expect(buildProviderEntry(["/bin/gjc", "acp"], "codex-pro").env.GJC_ACP_PERMISSION_MODE).toBe("prompt");
	});

	test("mpreset changes the key and the command tail", () => {
		expect(providerKeyFor()).toBe("gjc");
		expect(providerKeyFor("codex-pro")).toBe("gjc-codex-pro");
		expect(buildProviderEntry(["/bin/gjc", "acp"], "codex-pro").command.slice(-3)).toEqual([
			"acp",
			"--mpreset",
			"codex-pro",
		]);
	});

	test("an absent key is not a conflict", () => {
		const entry = buildProviderEntry(["/bin/gjc", "acp"]);
		expect(hasProviderConflict({ agents: { providers: {} } }, "gjc", entry).conflict).toBe(false);
	});

	test("an identical entry is not a conflict, a differing one is", () => {
		const entry = buildProviderEntry(["/bin/gjc", "acp"]);
		expect(hasProviderConflict({ agents: { providers: { gjc: entry } } }, "gjc", entry).conflict).toBe(false);
		expect(
			hasProviderConflict({ agents: { providers: { gjc: { ...entry, label: "mine" } } } }, "gjc", entry).conflict,
		).toBe(true);
	});
});

describe("orchestration seeding (AC-15)", () => {
	// Verified against a live file: roles are nested under `providers`, and the
	// sibling `preferences` array belongs to the user.
	test("seeds only empty nested roles and leaves populated ones untouched", () => {
		const preferences: Record<string, unknown> = {
			providers: { impl: "mine", ui: "" },
			preferences: ["keep"],
		};
		const seed = createOrchestrationSeed(preferences);
		expect(seed.seededKeys).not.toContain("impl");
		expect(seed.seededKeys).toContain("ui");
		expect(seed.seededKeys).toContain("audit");

		const draft = structuredClone(preferences);
		seed.mutate(draft);
		const roles = draft.providers as Record<string, unknown>;
		expect(roles.impl).toBe("mine");
		expect(roles.ui).toBe("gjc");
		expect(draft.preferences).toEqual(["keep"]);
	});

	test("writes nothing at the top level and creates providers when absent", () => {
		const seed = createOrchestrationSeed({});
		const draft: Record<string, unknown> = {};
		seed.mutate(draft);
		expect(Object.keys(draft)).toEqual(["providers"]);
		expect(Object.keys(draft.providers as Record<string, unknown>).sort()).toEqual([
			"audit",
			"impl",
			"planning",
			"research",
			"ui",
		]);
	});

	test("a fully assigned file needs no seeding", () => {
		const seed = createOrchestrationSeed({
			providers: { impl: "a", ui: "b", research: "c", planning: "d", audit: "e" },
		});
		expect(seed.seededKeys).toEqual([]);
	});
});

describe("four-state check (AC-16, AC-17, AC-18)", () => {
	async function cleanL1(outcome: PaseoLsOutcome): Promise<Fixture> {
		const fixture = await makeFixture(outcome);
		await seedSkills(fixture.paths);
		await fs.mkdir(fixture.paths.bridgeDir, { recursive: true });
		for (const name of SKILL_NAMES) {
			await fs.symlink(path.join(fixture.paths.agentsSkillsDir, name), path.join(fixture.paths.bridgeDir, name));
		}
		const resolution = resolveGjcCommand();
		const command = resolution.ok ? resolution.command : [process.execPath, "acp"];
		await seedConfig(fixture.paths, { gjc: buildProviderEntry(command) });
		await fs.writeFile(
			fixture.paths.orchestrationPreferences,
			serializeJson({ providers: { impl: "gjc", ui: "gjc", research: "gjc", planning: "gjc", audit: "gjc" } }),
		);
		return fixture;
	}

	test("a dirty L1 is drift regardless of the daemon, and exits 1", async () => {
		const fixture = await makeFixture(lsOk("gjc"));
		await seedConfig(fixture.paths);
		const result = await checkPaseoSetup(fixture.deps);
		expect(result.status).toBe("drift");
		expect(checkExitCode(result)).toBe(1);
	});

	test("clean L1 plus a daemon listing the provider is pass", async () => {
		const fixture = await cleanL1(lsOk("gjc"));
		const result = await checkPaseoSetup(fixture.deps);
		expect(result.status).toBe("pass");
		expect(checkExitCode(result)).toBe(0);
	});

	test("clean L1 plus a daemon omitting the provider is stale with guidance", async () => {
		const fixture = await cleanL1(lsOk("claude"));
		const result = await checkPaseoSetup(fixture.deps);
		expect(result.status).toBe("stale");
		expect(result.guidance).toBe(STALE_GUIDANCE);
		expect(checkExitCode(result)).toBe(0);
	});

	// The specific regression: an unreachable daemon must map uniquely to
	// `skipped`. An earlier draft let this same predicate also satisfy `pass`.
	test.each<PaseoLsOutcome>([
		{ kind: "timeout", timeoutMs: 5_000 },
		{ kind: "unavailable", detail: "spawn failed" },
		{ kind: "malformed", detail: "bad json" },
		{ kind: "nonzero-exit", exitCode: 3, detail: "boom" },
	])("clean L1 plus an unreachable daemon is skipped, never pass ($kind)", async (outcome: PaseoLsOutcome) => {
		const fixture = await cleanL1(outcome);
		const result = await checkPaseoSetup(fixture.deps);
		expect(result.status).toBe("skipped");
		expect(result.status).not.toBe("pass");
		expect(checkExitCode(result)).toBe(0);
	});

	test("the status union never leaves the four locked values", async () => {
		const seen = new Set<SetupCheckStatus>();
		const outcomes: PaseoLsOutcome[] = [lsOk("gjc"), lsOk(), { kind: "timeout", timeoutMs: 1 }];
		for (const outcome of outcomes) {
			const fixture = await cleanL1(outcome);
			seen.add((await checkPaseoSetup(fixture.deps)).status);
		}
		const dirty = await makeFixture();
		seen.add((await checkPaseoSetup(dirty.deps)).status);
		expect([...seen].every(status => ["pass", "drift", "stale", "skipped"].includes(status))).toBe(true);
		expect(seen.size).toBe(4);
	});

	// Regression: a listed-but-unavailable provider was reported as `pass`,
	// claiming a working integration the user does not have.
	test("a listed but unavailable provider is stale, not pass", async () => {
		const fixture = await cleanL1({
			kind: "ok",
			providerIds: ["gjc"],
			rows: [{ id: "gjc", status: "unavailable" }],
		});
		const result = await checkPaseoSetup(fixture.deps);
		expect(result.status).toBe("stale");
		expect(result.guidance).toContain("unavailable");
	});

	test("a row without a status is trusted as available", async () => {
		const fixture = await cleanL1({ kind: "ok", providerIds: ["gjc"], rows: [{ id: "gjc" }] });
		expect((await checkPaseoSetup(fixture.deps)).status).toBe("pass");
	});

	test("check never spawns a daemon restart", async () => {
		const fixture = await cleanL1(lsOk());
		await checkPaseoSetup(fixture.deps);
		// The injected probe is the only process surface check is given.
		expect(fixture.probes.length).toBe(1);
		expect(fixture.spawned).toEqual([]);
	});
});

describe("skills bridge", () => {
	test("links exactly the five allowlisted skills and excludes context-search (AC-6)", async () => {
		const fixture = await makeFixture();
		await seedSkills(fixture.paths, ["context-search"]);
		const preflight = await preflightSkillsBridge(fixture.deps);
		await installSkillsBridge(preflight);

		const linked = (await fs.readdir(fixture.paths.bridgeDir)).sort();
		expect(linked).toEqual([...SKILL_NAMES].sort());
		expect(linked).not.toContain("context-search");
	});

	test("a foreign file at an allowlisted name refuses before any mutation", async () => {
		const fixture = await makeFixture();
		await seedSkills(fixture.paths);
		await fs.mkdir(fixture.paths.bridgeDir, { recursive: true });
		await fs.writeFile(path.join(fixture.paths.bridgeDir, "paseo"), "user file\n");
		const before = await snapshotTree(fixture.paths.bridgeDir);

		await expect(preflightSkillsBridge(fixture.deps)).rejects.toBeInstanceOf(SkillsBridgeError);
		expect(await snapshotTree(fixture.paths.bridgeDir)).toBe(before);
	});

	test("a symlink pointing elsewhere refuses before any mutation", async () => {
		const fixture = await makeFixture();
		await seedSkills(fixture.paths);
		await fs.mkdir(fixture.paths.bridgeDir, { recursive: true });
		await fs.symlink(path.join(fixture.root, "elsewhere"), path.join(fixture.paths.bridgeDir, "paseo"));
		const before = await snapshotTree(fixture.paths.bridgeDir);

		await expect(preflightSkillsBridge(fixture.deps)).rejects.toBeInstanceOf(SkillsBridgeError);
		expect(await snapshotTree(fixture.paths.bridgeDir)).toBe(before);
	});

	test("an already-correct link is a no-op and is not recreated", async () => {
		const fixture = await makeFixture();
		await seedSkills(fixture.paths);
		await fs.mkdir(fixture.paths.bridgeDir, { recursive: true });
		await fs.symlink(path.join(fixture.paths.agentsSkillsDir, "paseo"), path.join(fixture.paths.bridgeDir, "paseo"));

		const preflight = await preflightSkillsBridge(fixture.deps);
		const result = await installSkillsBridge(preflight);
		expect(result.createdEntries).not.toContain("paseo");
		expect(result.createdEntries.length).toBe(SKILL_NAMES.length - 1);
	});

	test("both protected skill trees are byte-identical across install and check (AC-8, AC-19)", async () => {
		const fixture = await makeFixture();
		await seedSkills(fixture.paths, ["context-search"]);
		await fs.writeFile(path.join(fixture.paths.gjcSkillsDir, "mine.md"), "# mine\n");

		const agentsBefore = await snapshotTree(fixture.paths.agentsSkillsDir);
		const gjcBefore = await snapshotTree(fixture.paths.gjcSkillsDir);

		await installSkillsBridge(await preflightSkillsBridge(fixture.deps));
		await checkPaseoSetup(fixture.deps);

		expect(await snapshotTree(fixture.paths.agentsSkillsDir)).toBe(agentsBefore);
		expect(await snapshotTree(fixture.paths.gjcSkillsDir)).toBe(gjcBefore);
	});
});

describe("provenance-gated removal (AC-19)", () => {
	async function installedFixture(): Promise<Fixture> {
		const fixture = await makeFixture();
		await seedSkills(fixture.paths);
		const entry = buildProviderEntry([process.execPath, "acp"]);
		await seedConfig(fixture.paths, { gjc: entry });
		await fs.writeFile(fixture.paths.orchestrationPreferences, serializeJson({ providers: { impl: "gjc" } }));
		await writeProvenance(fixture.paths.provenanceLedger, {
			version: 1,
			providerKeys: { gjc: providerEntryHash(entry) },
			seededOrchestrationKeys: { impl: "gjc" },
		});
		return fixture;
	}

	test("an unedited seeded key is cleared", async () => {
		const fixture = await installedFixture();
		const result = await removePaseoSetup(fixture.deps, { now: new Date() });
		expect(result.outcome).toBe("removed");
		const after = await readTarget(fixture.paths.configJson);
		expect(providersOf(after.parsed).gjc).toBeUndefined();
	});

	test("a user-edited key survives removal", async () => {
		const fixture = await installedFixture();
		const current = await readTarget(fixture.paths.configJson);
		const plan = planPublish(current, draft => {
			const entry = providersOf(draft).gjc as Record<string, unknown>;
			entry.label = "MY OWN LABEL";
		});
		await publishPlan(fixture.paths.configJson, plan, {
			expectedIdentity: current.identity,
			backup: false,
			now: new Date(),
		});

		await removePaseoSetup(fixture.deps, { now: new Date() });

		const after = await readTarget(fixture.paths.configJson);
		const survivor = providersOf(after.parsed).gjc as Record<string, unknown> | undefined;
		expect(survivor?.label).toBe("MY OWN LABEL");
	});

	// Regression: removal deleted a top-level key that does not exist in the real
	// nested schema, clearing provenance while leaving the role pointing at a
	// provider entry it had just deleted.
	test("seeded nested roles are removed from providers, not from the top level", async () => {
		const fixture = await installedFixture();
		await removePaseoSetup(fixture.deps, { now: new Date() });

		const after = await readTarget(fixture.paths.orchestrationPreferences);
		const roles = after.parsed.providers as Record<string, unknown> | undefined;
		expect(roles?.impl).toBeUndefined();
	});

	test("a user-reassigned role survives removal and keeps sibling keys", async () => {
		const fixture = await installedFixture();
		await fs.writeFile(
			fixture.paths.orchestrationPreferences,
			serializeJson({ providers: { impl: "someone-else", ui: "theirs" }, preferences: ["note"] }),
		);

		await removePaseoSetup(fixture.deps, { now: new Date() });

		const after = await readTarget(fixture.paths.orchestrationPreferences);
		const roles = after.parsed.providers as Record<string, unknown>;
		expect(roles.impl).toBe("someone-else");
		expect(roles.ui).toBe("theirs");
		expect(after.parsed.preferences).toEqual(["note"]);
	});

	test("a never-provenanced key that coincidentally matches is untouched", async () => {
		const fixture = await makeFixture();
		const entry = buildProviderEntry([process.execPath, "acp"]);
		await seedConfig(fixture.paths, { gjc: entry });
		// The ledger records a different key, so `gjc` was never ours.
		await writeProvenance(fixture.paths.provenanceLedger, {
			version: 1,
			providerKeys: { "gjc-other": "deadbeef" },
			seededOrchestrationKeys: {},
		});

		await removePaseoSetup(fixture.deps, { now: new Date() });

		const after = await readTarget(fixture.paths.configJson);
		expect(providersOf(after.parsed).gjc).toBeDefined();
	});

	test("nothing recorded means nothing to remove", async () => {
		const fixture = await makeFixture();
		await seedConfig(fixture.paths);
		const result = await removePaseoSetup(fixture.deps, { now: new Date() });
		expect(result.outcome).toBe("nothing-to-remove");
	});

	test("all provenanced gjc keys from repeated mpreset runs are enumerated", () => {
		const ledger = {
			version: 1,
			providerKeys: { gjc: "a", "gjc-codex-pro": "b", "gjc-fast": "c" },
			seededOrchestrationKeys: {},
		};
		expect(provenancedProviderKeys(ledger)).toEqual(["gjc", "gjc-codex-pro", "gjc-fast"]);
	});

	test("ownership requires both a record and a matching value hash", () => {
		const ledger = { version: 1, providerKeys: { gjc: "hash-a" }, seededOrchestrationKeys: {} };
		expect(isProvenancedProvider(ledger, "gjc", "hash-a")).toBe(true);
		expect(isProvenancedProvider(ledger, "gjc", "hash-b")).toBe(false);
		expect(isProvenancedProvider(ledger, "absent", "hash-a")).toBe(false);
	});
});

describe("intent recovery", () => {
	async function intentFixture(): Promise<{ fixture: Fixture; intent: IntentRecord }> {
		const fixture = await makeFixture();
		await fs.mkdir(path.dirname(fixture.paths.provenanceLedger), { recursive: true });
		await fs.writeFile(fixture.paths.configJson, serializeJson({ before: true }));
		await fs.writeFile(fixture.paths.provenanceLedger, serializeJson({ before: true }));
		const intent: IntentRecord = {
			version: INTENT_VERSION,
			step: "provider-config",
			targetPath: fixture.paths.configJson,
			ownedKeys: ["agents.providers.gjc"],
			targetPreflightIdentity: await currentIdentity(fixture.paths.configJson),
			targetExpectedIdentity: hashBytes(serializeJson({ after: true })),
			provenancePath: fixture.paths.provenanceLedger,
			provenancePreflightIdentity: await currentIdentity(fixture.paths.provenanceLedger),
			provenanceExpectedIdentity: hashBytes(serializeJson({ after: true })),
			startedAt: new Date().toISOString(),
		};
		return { fixture, intent };
	}

	test("target published but ledger not yet committed means complete the ledger", async () => {
		const { fixture, intent } = await intentFixture();
		await fs.writeFile(fixture.paths.configJson, serializeJson({ after: true }));
		expect((await classifyIntent(intent)).action).toBe("complete-ledger");
	});

	test("both written means discard the stale intent", async () => {
		const { fixture, intent } = await intentFixture();
		await fs.writeFile(fixture.paths.configJson, serializeJson({ after: true }));
		await fs.writeFile(fixture.paths.provenanceLedger, serializeJson({ after: true }));
		expect((await classifyIntent(intent)).action).toBe("discard");
	});

	test("target never written means discard", async () => {
		const { intent } = await intentFixture();
		expect((await classifyIntent(intent)).action).toBe("discard");
	});

	test("a third-party target identity refuses", async () => {
		const { fixture, intent } = await intentFixture();
		await fs.writeFile(fixture.paths.configJson, serializeJson({ someone: "else" }));
		expect((await classifyIntent(intent)).action).toBe("refuse");
	});

	test("a divergent ledger refuses regardless of target state", async () => {
		const { fixture, intent } = await intentFixture();
		await fs.writeFile(fixture.paths.configJson, serializeJson({ after: true }));
		await fs.writeFile(fixture.paths.provenanceLedger, serializeJson({ someone: "else" }));
		expect((await classifyIntent(intent)).action).toBe("refuse");
	});

	// An intent written before payloads were recorded cannot be completed, and
	// says so rather than silently discarding an uncommitted ownership record.
	test("complete-ledger without a payload reports honestly and retains the intent", async () => {
		const { fixture, intent } = await intentFixture();
		await fs.writeFile(fixture.paths.configJson, serializeJson({ after: true }));
		await writeIntent(fixture.paths.intentRecord, intent);

		const recovery = await recoverIntent(fixture.paths.intentRecord, { repair: true });
		expect(recovery?.recovered).toBe(false);
		expect(recovery?.detail).toContain("no ledger payload");
		expect(await readIntent(fixture.paths.intentRecord)).toBeDefined();
	});

	// Regression: a seed-if-empty step could never be recovered by retrying,
	// because its own publish removed the emptiness the step was gated on.
	test("complete-ledger commits the recorded payload instead of relying on a retry", async () => {
		const { fixture, intent } = await intentFixture();
		await fs.writeFile(fixture.paths.configJson, serializeJson({ after: true }));
		await writeIntent(fixture.paths.intentRecord, {
			...intent,
			provenancePayload: { version: 1, providerKeys: {}, seededOrchestrationKeys: { ui: "gjc" } },
		});

		const recovery = await recoverIntent(fixture.paths.intentRecord, { repair: true });
		expect(recovery?.recovered).toBe(true);
		expect((await readProvenance(fixture.paths.provenanceLedger)).seededOrchestrationKeys.ui).toBe("gjc");
		expect(await readIntent(fixture.paths.intentRecord)).toBeUndefined();
	});

	test("a discardable intent is cleared under repair", async () => {
		const { fixture, intent } = await intentFixture();
		await writeIntent(fixture.paths.intentRecord, intent);

		const recovery = await recoverIntent(fixture.paths.intentRecord, { repair: true });
		expect(recovery?.recovered).toBe(true);
		expect(await readIntent(fixture.paths.intentRecord)).toBeUndefined();
	});

	test("check-mode recovery never mutates the intent", async () => {
		const { fixture, intent } = await intentFixture();
		await writeIntent(fixture.paths.intentRecord, intent);

		const recovery = await recoverIntent(fixture.paths.intentRecord, { repair: false });
		expect(recovery?.recovered).toBe(false);
		expect(await readIntent(fixture.paths.intentRecord)).toBeDefined();
	});

	test("a refusal is never repaired even under repair", async () => {
		const { fixture, intent } = await intentFixture();
		await fs.writeFile(fixture.paths.provenanceLedger, serializeJson({ someone: "else" }));
		await writeIntent(fixture.paths.intentRecord, intent);

		const recovery = await recoverIntent(fixture.paths.intentRecord, { repair: true });
		expect(recovery?.recovered).toBe(false);
		expect(await readIntent(fixture.paths.intentRecord)).toBeDefined();
	});

	test("identity classification is exhaustive over the three states", () => {
		expect(classifyIdentity("x", "x", "y")).toBe("before");
		expect(classifyIdentity("y", "x", "y")).toBe("intended-after");
		expect(classifyIdentity("z", "x", "y")).toBe("divergent");
	});
});

describe("saga compensation", () => {
	test("undoes completed steps in reverse order", async () => {
		const order: string[] = [];
		const steps: CompletedStep[] = ["one", "two", "three"].map(label => ({
			label,
			undo: async () => {
				order.push(label);
				return { status: "reverted" as const };
			},
		}));

		const outcome = await compensate(steps, new SagaStepError("four", "boom"));
		expect(order).toEqual(["three", "two", "one"]);
		expect(outcome.compensated).toEqual(["three", "two", "one"]);
		expect(outcome.uncompensated).toEqual([]);
	});

	test("a conflicting inverse halts the remaining compensation", async () => {
		const attempted: string[] = [];
		const steps: CompletedStep[] = [
			{
				label: "one",
				undo: async () => {
					attempted.push("one");
					return { status: "reverted" as const };
				},
			},
			{
				label: "two",
				undo: async () => {
					attempted.push("two");
					return { status: "conflict" as const, detail: "changed underneath", retained: ["/tmp/evidence"] };
				},
			},
		];

		const outcome = await compensate(steps, new SagaStepError("three", "boom"));
		// "one" is never attempted, because "two" halted the unwind.
		expect(attempted).toEqual(["two"]);
		expect(outcome.uncompensated).toEqual(["two", "one"]);
		expect(outcome.evidence.detail).toContain("changed underneath");
		expect(outcome.evidence.retained).toContain("/tmp/evidence");
	});
});

describe("CLI surface (AC-10, AC-11)", () => {
	test.each([
		[["setup", "paseo", "--check"], { check: true }],
		[["setup", "paseo", "--json", "--force"], { json: true, force: true }],
		[["setup", "paseo", "--remove"], { remove: true }],
		[["setup", "paseo", "--mpreset", "codex-pro"], { mpreset: "codex-pro" }],
	])("parseSetupArgs resolves %j", (argv: string[], expected: Record<string, unknown>) => {
		const parsed = parseSetupArgs(argv as string[]);
		expect(parsed?.component).toBe("paseo");
		expect(parsed?.flags).toMatchObject(expected as Record<string, unknown>);
	});

	test("check and remove together is rejected naming both flags", () => {
		expect(() => assertUsableFlags({ check: true, remove: true })).toThrow(PaseoSetupUsageError);
		try {
			assertUsableFlags({ check: true, remove: true });
			throw new Error("expected a usage error");
		} catch (error) {
			expect((error as Error).message).toContain("--check");
			expect((error as Error).message).toContain("--remove");
		}
	});

	test("an empty mpreset is rejected", () => {
		expect(() => assertUsableFlags({ mpreset: "  " })).toThrow(PaseoSetupUsageError);
	});
});

describe("provider probe parsing", () => {
	// The measured live shape uses a `provider` key, which an earlier draft
	// rejected as malformed -- making pass/stale unreachable against a real daemon.
	test("parses the real paseo provider ls shape", () => {
		const outcome = parseProviderLs(
			'[{"provider":"gjc","label":"Gajae Code","status":"available","enabled":"Enabled"}]',
		);
		expect(outcome.kind).toBe("ok");
		if (outcome.kind === "ok") {
			expect([...outcome.providerIds]).toEqual(["gjc"]);
			expect(outcome.rows[0]?.status).toBe("available");
		}
	});

	test.each([
		['["gjc","claude"]', ["gjc", "claude"]],
		['{"providers":["gjc"]}', ["gjc"]],
		['{"providers":[{"id":"gjc"}]}', ["gjc"]],
		['{"providers":[{"name":"gjc"}]}', ["gjc"]],
		['[{"provider":"gjc"}]', ["gjc"]],
	])("parses %s", (input: string, expected: string[]) => {
		const outcome = parseProviderLs(input);
		expect(outcome.kind).toBe("ok");
		if (outcome.kind === "ok") expect([...outcome.providerIds]).toEqual(expected);
	});

	test.each([
		"not json",
		'{"providers":{}}',
		'{"providers":[{"nope":1}]}',
	])("rejects %s as malformed", (input: string) => {
		expect(parseProviderLs(input).kind).toBe("malformed");
	});
});
