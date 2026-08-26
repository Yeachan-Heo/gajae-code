import { afterEach, describe, expect, spyOn, test } from "bun:test";
import type * as nodeFs from "node:fs";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { snapshotDirectoryTree } from "@gajae-code/natives";
import { getTrustedHomeDir } from "@gajae-code/utils";
import { safeRm } from "../../../scripts/safe-cleanup";
import { parseSetupArgs } from "../src/cli/setup-cli";
import { Settings } from "../src/config/settings";
import { checkPaseoSetup, STALE_GUIDANCE } from "../src/setup/paseo/check";
import {
	type CompletedStep,
	compensate,
	recoverIntent,
	runJsonStep,
	SagaStepError,
} from "../src/setup/paseo/install-saga";
import * as paseoJsonPublisher from "../src/setup/paseo/json-publisher";
import {
	currentIdentity,
	hashBytes,
	hasNoReparseSidecarAuthority,
	planPublish,
	publishPlan,
	readReplacedProviderBackup,
	readTarget,
	removeDiscardSidecar,
	removeReplacedProviderBackup,
	replacedProviderBackupPath,
	serializeJson,
	writeReplacedProviderBackup,
} from "../src/setup/paseo/json-publisher";
import { createOrchestrationSeed } from "../src/setup/paseo/orchestration-preferences";
import {
	type BridgeCleanupAuthority,
	type BridgeEntryIdentity,
	classifyIdentity,
	classifyIntent,
	INTENT_VERSION,
	type IntentRecord,
	IntentRecordCorruptError,
	isProvenancedProvider,
	type ProvenanceLedger,
	ProvenanceLedgerCorruptError,
	provenancedProviderKeys,
	provenanceLedgerIdentity,
	readIntent,
	readProvenance,
	writeIntent,
	writeProvenance,
} from "../src/setup/paseo/paseo-ownership";
import {
	assertUsableFlags,
	correctBridgeOwnershipAfterFailure,
	PaseoSetupUsageError,
	runPaseoSetup,
} from "../src/setup/paseo/paseo-setup";
import {
	buildProviderEntry,
	hasProviderConflict,
	providerEntryHash,
	providerKeyFor,
	resolveGjcCommand,
} from "../src/setup/paseo/provider-config";
import { removePaseoSetup } from "../src/setup/paseo/remove";
import {
	checkExitCode,
	type PaseoRemoveResult,
	type SetupCheckResult,
	type SetupCheckStatus,
} from "../src/setup/paseo/result-types";
import {
	createDefaultPaseoSetupDependencies,
	isTrustedRecordedSkillsSource,
	type PaseoLsOutcome,
	type PaseoPaths,
	type PaseoSetupDependencies,
	parseProviderLs,
	paseoAppSkillsCandidates,
	resolvePaseoSkillsSource,
} from "../src/setup/paseo/setup-deps";
import {
	adoptLegacyLink,
	installSkillsBridge,
	inverseSkillsBridge,
	preflightSkillsBridge,
	SkillsBridgeError,
	SkillsBridgePartialError,
	sourceBridgeEntries,
} from "../src/setup/paseo/skills-bridge";

const FIXTURE_PASSWORD = "$2b$10$FIXTUREFIXTUREFIXTUREFIXTUREFIXTUREFIXTUREFIXTUREFIXTUR";
const SKILL_NAMES = ["paseo", "paseo-advisor", "paseo-committee", "paseo-handoff", "paseo-loop"];
/** Built from codepoints so this test file stays pure ASCII on disk. */
const NON_ASCII_VALUE = String.fromCodePoint(0xd55c, 0xad6d, 0xc5b4);

/** A reachable-daemon outcome carrying the measured row shape. */
function lsOk(...ids: string[]): PaseoLsOutcome {
	return { kind: "ok", providerIds: ids, rows: ids.map(id => ({ id, status: "available" })) };
}

const tempRoots: string[] = [];

afterEach(async () => {
	for (const root of tempRoots.splice(0)) {
		await safeRm(root, { recursive: true, force: true }).catch(() => undefined);
	}
});

async function makeRoot(): Promise<string> {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-paseo-test-"));
	tempRoots.push(root);
	return root;
}

/** The fixture's path shape: the production contract (whose skills field is required) plus its own concrete source directory. */
type FixturePaths = PaseoPaths;

interface Fixture {
	readonly root: string;
	readonly paths: FixturePaths;
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

	const paths: FixturePaths = {
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
	// The skills source is injected, never discovered: a developer machine that
	// happens to carry ~/.agents/skills or a Paseo.app must not leak into a test.
	const deps: PaseoSetupDependencies = {
		paths,
		runProviderLs: async timeoutMs => {
			probes.push(timeoutMs);
			return outcome;
		},
		now: () => new Date("2026-01-01T00:00:00.000Z"),
		skillsSource: async () => ({ dir: agentsSkills, origin: "user" }),
		home,
		// Hermetic stand-in for the production trusted-home rule: only the
		// fixture's own root is a trusted source root.
		trustedSkillsSource: async dir => {
			const rel = path.relative(root, path.resolve(dir));
			return rel === "" || rel.startsWith("..") || path.isAbsolute(rel)
				? { ok: false, detail: `the recorded bridge source (${dir}) is outside every trusted Paseo source root` }
				: { ok: true };
		},
	};
	return { root, paths, deps, probes, spawned };
}

async function seedConfig(paths: FixturePaths, providers: Record<string, unknown> = {}): Promise<void> {
	const config = {
		daemon: { auth: { password: FIXTURE_PASSWORD }, port: 4317 },
		agents: { providers: { claude: { enabled: true }, ...providers } },
	};
	await fs.writeFile(paths.configJson, serializeJson(config), { mode: 0o600 });
}

async function seedSkills(paths: FixturePaths, extra: string[] = []): Promise<void> {
	const sourceDir = paths.agentsSkillsDir;
	if (sourceDir === undefined) throw new Error("fixture carries no skills source");
	for (const name of [...SKILL_NAMES, ...extra]) {
		await fs.mkdir(path.join(sourceDir, name), { recursive: true });
		await fs.writeFile(path.join(sourceDir, name, "SKILL.md"), `# ${name}\n`);
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

	test("public install refuses a generic publication backup on Windows before mutation", async () => {
		const fixture = await makeFixture(lsOk("gjc"));
		await seedConfig(fixture.paths);
		const beforeConfig = await fs.readFile(fixture.paths.configJson, "utf8");
		const platform = Object.getOwnPropertyDescriptor(process, "platform");
		if (platform === undefined || platform.configurable !== true)
			throw new Error("process_platform_not_configurable");
		try {
			Object.defineProperty(process, "platform", { ...platform, value: "win32" });
			expect(hasNoReparseSidecarAuthority()).toBe(false);
			const result = await runPaseoSetup({}, fixture.deps);
			expect(result.kind).toBe("install");
			if (result.kind !== "install") throw new Error("expected an install outcome");
			expect(result.result.outcome).toBe("partial-install");
		} finally {
			Object.defineProperty(process, "platform", platform);
		}
		expect(await fs.readFile(fixture.paths.configJson, "utf8")).toBe(beforeConfig);
		expect(
			(await fs.readdir(path.dirname(fixture.paths.configJson))).filter(name => name.includes(".gjc-bak-")).length,
		).toBe(0);
		await expect(readIntent(fixture.paths.intentRecord)).resolves.toBeUndefined();
		await expect(fs.stat(fixture.paths.provenanceLedger)).rejects.toMatchObject({ code: "ENOENT" });
	});
});

describe("replaced-provider sidecar cleanup", () => {
	test("canonicalizes supported symlinked config ancestors before native unlink", async () => {
		const fixture = await makeFixture();
		const realConfigDir = path.join(fixture.root, "real-paseo");
		const linkedConfigDir = path.join(fixture.root, "linked-paseo");
		await fs.mkdir(realConfigDir, { recursive: true });
		await fs.symlink(realConfigDir, linkedConfigDir);
		const configPath = path.join(linkedConfigDir, "config.json");
		const sidecar = await writeReplacedProviderBackup(configPath, "gjc", { preserved: true });

		expect(await removeReplacedProviderBackup(sidecar.backupPath, "gjc", sidecar.valueSha256)).toBe(true);
		await expect(fs.stat(sidecar.backupPath)).rejects.toMatchObject({ code: "ENOENT" });

		const discardBytes = serializeJson({ key: "gjc", value: { discarded: true } });
		await fs.writeFile(sidecar.backupPath, discardBytes, { mode: 0o600 });
		expect(await removeDiscardSidecar(configPath, sidecar.backupPath, hashBytes(discardBytes))).toBe(true);
		await expect(fs.stat(sidecar.backupPath)).rejects.toMatchObject({ code: "ENOENT" });
	});

	test("removes the staged sidecar after every temporary publication failure", async () => {
		for (const phase of ["open", "write", "sync", "chmod", "link"] as const) {
			const fixture = await makeFixture();
			const backupPath = replacedProviderBackupPath(fixture.paths.configJson, "gjc");
			const temporaryPrefix = `${backupPath}.${process.pid}.`;
			const failure = new Error(`${phase} failed`);
			const spies: Array<{ mockRestore(): void }> = [];
			const isTemporary = (target: unknown): boolean => {
				const value = String(target);
				return value.startsWith(temporaryPrefix) && value.endsWith(".tmp");
			};

			try {
				if (phase === "open" || phase === "write" || phase === "sync") {
					const realOpen = fs.open.bind(fs);
					spies.push(
						spyOn(fs, "open").mockImplementation(async (...args) => {
							if (phase === "open" && isTemporary(args[0])) {
								const handle = await realOpen(...args);
								await handle.close();
								throw failure;
							}
							const handle = await realOpen(...args);
							if (isTemporary(args[0])) {
								if (phase === "write") spyOn(handle, "writeFile").mockRejectedValue(failure);
								if (phase === "sync") spyOn(handle, "sync").mockRejectedValue(failure);
							}
							return handle;
						}),
					);
				}
				if (phase === "chmod") {
					const realChmod = fs.chmod.bind(fs);
					spies.push(
						spyOn(fs, "chmod").mockImplementation(async (target, mode) => {
							if (isTemporary(target)) throw failure;
							return realChmod(target, mode);
						}),
					);
				}
				if (phase === "link") {
					const realLink = fs.link.bind(fs);
					spies.push(
						spyOn(fs, "link").mockImplementation(async (existingPath, newPath) => {
							if (isTemporary(existingPath)) throw failure;
							return realLink(existingPath, newPath);
						}),
					);
				}

				await expect(
					writeReplacedProviderBackup(fixture.paths.configJson, "gjc", { preserved: phase }),
				).rejects.toBe(failure);
				const entries = await fs.readdir(path.dirname(backupPath));
				expect(
					entries.filter(entry => entry.startsWith(path.basename(backupPath)) && entry.endsWith(".tmp")),
				).toEqual([]);
			} finally {
				for (const spy of spies.reverse()) spy.mockRestore();
			}
		}
	});

	test("rejects a Windows force replacement before creating a sidecar", async () => {
		const fixture = await makeFixture(lsOk("gjc"));
		await seedSkills(fixture.paths);
		const userEntry = { ...buildProviderEntry([process.execPath, "acp"]), label: "USER EDIT" };
		await seedConfig(fixture.paths, { gjc: userEntry });
		const beforeConfig = await fs.readFile(fixture.paths.configJson, "utf8");
		const platform = Object.getOwnPropertyDescriptor(process, "platform");
		if (platform === undefined || platform.configurable !== true)
			throw new Error("process_platform_not_configurable");
		try {
			Object.defineProperty(process, "platform", { ...platform, value: "win32" });
			expect(hasNoReparseSidecarAuthority()).toBe(false);
			await expect(runPaseoSetup({ force: true }, fixture.deps)).rejects.toBeInstanceOf(PaseoSetupUsageError);
		} finally {
			Object.defineProperty(process, "platform", platform);
		}
		expect(await fs.readFile(fixture.paths.configJson, "utf8")).toBe(beforeConfig);
		await expect(fs.stat(replacedProviderBackupPath(fixture.paths.configJson, "gjc"))).rejects.toMatchObject({
			code: "ENOENT",
		});
		await expect(fs.stat(fixture.paths.provenanceLedger)).rejects.toMatchObject({ code: "ENOENT" });
	});

	test("Windows force refusal retains an existing replaced-provider cleanup authority", async () => {
		const fixture = await makeFixture(lsOk("gjc"));
		await seedSkills(fixture.paths);
		const firstUserEntry = { ...buildProviderEntry([process.execPath, "acp"]), label: "FIRST USER EDIT" };
		await seedConfig(fixture.paths, { gjc: firstUserEntry });
		const initial = await runPaseoSetup({ force: true }, fixture.deps);
		expect(initial.kind).toBe("install");
		const ledgerBefore = await fs.readFile(fixture.paths.provenanceLedger, "utf8");
		const ref = (await readProvenance(fixture.paths.provenanceLedger)).providerReplacedEntries?.gjc;
		if (ref === undefined) throw new Error("expected an existing sidecar authority");
		const current = await readTarget(fixture.paths.configJson);
		const nextUserEntry = { ...buildProviderEntry([process.execPath, "acp"]), label: "SECOND USER EDIT" };
		const plan = planPublish(current, draft => {
			(draft.agents as { providers: Record<string, unknown> }).providers.gjc = nextUserEntry;
		});
		await publishPlan(fixture.paths.configJson, plan, {
			expectedIdentity: current.identity,
			backup: false,
			now: fixture.deps.now(),
		});
		const platform = Object.getOwnPropertyDescriptor(process, "platform");
		if (platform === undefined || platform.configurable !== true)
			throw new Error("process_platform_not_configurable");
		try {
			Object.defineProperty(process, "platform", { ...platform, value: "win32" });
			await expect(runPaseoSetup({ force: true }, fixture.deps)).rejects.toBeInstanceOf(PaseoSetupUsageError);
		} finally {
			Object.defineProperty(process, "platform", platform);
		}
		expect(await fs.readFile(fixture.paths.provenanceLedger, "utf8")).toBe(ledgerBefore);
		await expect(fs.stat(ref.backupPath)).resolves.toBeDefined();
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
			await fs.symlink(
				path.join(fixture.paths.agentsSkillsDir as string, name),
				path.join(fixture.paths.bridgeDir, name),
			);
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

	test("an injected missing source is authoritative in check mode (#4644 review r20)", async () => {
		const fixture = await cleanL1(lsOk("gjc"));
		const result = await checkPaseoSetup({ ...fixture.deps, skillsSource: async () => undefined });
		expect(result.status).toBe("drift");
		if (result.status !== "drift") throw new Error("expected drift");
		expect(result.reasons).toContainEqual(expect.objectContaining({ code: "missing-skills-directory" }));
	});

	test("check uses the custom agents skills path when skillsSource is omitted (#4644 Codex P2)", async () => {
		const fixture = await cleanL1(lsOk("gjc"));
		const result = await checkPaseoSetup({ ...fixture.deps, skillsSource: undefined });
		expect(result.status).toBe("pass");
		expect(result.status).not.toBe("drift");
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
	test("removes a bridge below a symlinked agent-directory ancestor", async () => {
		const fixture = await makeFixture();
		await seedSkills(fixture.paths);
		const trustedAgentRoot = path.dirname(path.dirname(fixture.paths.provenanceLedger));
		const realAgentDir = path.join(trustedAgentRoot, "real-agent");
		const aliasAgentDir = path.join(trustedAgentRoot, "alias-agent");
		await fs.mkdir(realAgentDir, { recursive: true });
		await fs.symlink(realAgentDir, aliasAgentDir);
		const deps = {
			...fixture.deps,
			paths: { ...fixture.paths, bridgeDir: path.join(aliasAgentDir, "paseo-skills") },
		};

		const install = await runPaseoSetup({}, deps);
		expect(install.kind).toBe("install");
		const removal = await runPaseoSetup({ remove: true }, deps);
		expect(removal.kind).toBe("remove");
		if (removal.kind !== "remove") throw new Error("expected a remove outcome");
		expect(removal.result.outcome).toBe("removed");
	});

	test("links every paseo-prefixed source skill except the denylist (AC-6, #4638)", async () => {
		const fixture = await makeFixture();
		await seedSkills(fixture.paths, ["context-search", "paseo-help", "unrelated-skill"]);
		const preflight = await preflightSkillsBridge(fixture.deps);
		await installSkillsBridge(preflight);

		const linked = (await fs.readdir(fixture.paths.bridgeDir)).sort();
		expect(linked).toEqual([...SKILL_NAMES, "paseo-help"].sort());
		expect(linked).not.toContain("context-search");
		expect(linked).not.toContain("unrelated-skill");
	});

	test("a foreign file at a bridged name refuses before any mutation", async () => {
		const fixture = await makeFixture();
		await seedSkills(fixture.paths);
		await fs.mkdir(fixture.paths.bridgeDir, { recursive: true });
		await fs.writeFile(path.join(fixture.paths.bridgeDir, "paseo"), "user file\n");
		const before = await snapshotTree(fixture.paths.bridgeDir);

		await expect(preflightSkillsBridge(fixture.deps)).rejects.toBeInstanceOf(SkillsBridgeError);
		expect(await snapshotTree(fixture.paths.bridgeDir)).toBe(before);
	});

	test("a foreign file squatting on a name the source no longer carries refuses too", async () => {
		const fixture = await makeFixture();
		await seedSkills(fixture.paths);
		await fs.mkdir(fixture.paths.bridgeDir, { recursive: true });
		await fs.writeFile(path.join(fixture.paths.bridgeDir, "paseo-retired"), "user file\n");
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
		await fs.symlink(
			path.join(fixture.paths.agentsSkillsDir as string, "paseo"),
			path.join(fixture.paths.bridgeDir, "paseo"),
		);

		const preflight = await preflightSkillsBridge(fixture.deps);
		const result = await installSkillsBridge(preflight);
		expect(result.createdEntries).not.toContain("paseo");
		expect(result.createdEntries.length).toBe(SKILL_NAMES.length - 1);
	});

	test("a source entry that is a file, not a directory, is never linked", async () => {
		const fixture = await makeFixture();
		await seedSkills(fixture.paths);
		await fs.writeFile(path.join(fixture.paths.agentsSkillsDir as string, "paseo-file"), "not a skill\n");
		const preflight = await preflightSkillsBridge(fixture.deps);
		await installSkillsBridge(preflight);
		expect(await fs.readdir(fixture.paths.bridgeDir)).not.toContain("paseo-file");
	});

	/** Install without the full saga but with a realistic ledger, so preflight's provenance gate can run. */
	async function installWithLedger(deps: PaseoSetupDependencies): Promise<void> {
		const preflight = await preflightSkillsBridge(deps);
		const result = await installSkillsBridge(preflight);
		await writeProvenance(deps.paths.provenanceLedger, {
			version: 1,
			providerKeys: {},
			seededOrchestrationKeys: {},
			bridgePath: deps.paths.bridgeDir,
			bridgeEntries: [...Object.keys(preflight.entries), ...preflight.adopts.map(adopt => adopt.name)],
			bridgeEntryIdentities: result.entryIdentities,
			bridgeDirCreated: false,
			...(preflight.sourceDir ? { bridgeSourceDir: preflight.sourceDir } : {}),
		});
	}

	test("install converges the bridge after a Paseo release adds and drops skills (#4638)", async () => {
		const fixture = await makeFixture();
		await seedSkills(fixture.paths);
		await installWithLedger(fixture.deps);

		// Paseo 0.4.0: paseo-loop is gone, paseo-help is new.
		await safeRm(path.join(fixture.paths.agentsSkillsDir as string, "paseo-loop"), { recursive: true });
		await fs.mkdir(path.join(fixture.paths.agentsSkillsDir as string, "paseo-help"), { recursive: true });
		await fs.writeFile(
			path.join(fixture.paths.agentsSkillsDir as string, "paseo-help", "SKILL.md"),
			"# paseo-help\n",
		);

		const second = await installSkillsBridge(await preflightSkillsBridge(fixture.deps));
		expect(second.prunedEntries).toEqual(["paseo-loop"]);
		expect(second.createdEntries).toEqual(["paseo-help"]);
		const linked = (await fs.readdir(fixture.paths.bridgeDir)).sort();
		expect(linked).toEqual([...SKILL_NAMES.slice(0, 4), "paseo-help"].sort());
		// No dangling links survive the release change.
		for (const name of linked) {
			const stat = await fs.stat(path.join(fixture.paths.bridgeDir, name));
			expect(stat.isDirectory()).toBe(true);
		}
	});

	test("a re-run after a source skill is deleted prunes the dead link instead of leaving it (#4638)", async () => {
		const fixture = await makeFixture();
		await seedSkills(fixture.paths);
		await installWithLedger(fixture.deps);
		await safeRm(path.join(fixture.paths.agentsSkillsDir as string, "paseo-committee"), { recursive: true });

		const result = await installSkillsBridge(await preflightSkillsBridge(fixture.deps));
		expect(result.prunedEntries).toEqual(["paseo-committee"]);
		await expect(fs.lstat(path.join(fixture.paths.bridgeDir, "paseo-committee"))).rejects.toMatchObject({
			code: "ENOENT",
		});
	});
	test("a foreign paseo-prefixed symlink is never pruned, with or without provenance (#4644 review)", async () => {
		const fixture = await makeFixture();
		await seedSkills(fixture.paths);
		await installWithLedger(fixture.deps);

		// A live user symlink at a name the source does not carry and no ledger
		// ever recorded: directory creation cannot prove ownership, so install
		// must refuse instead of silently deleting it.
		await fs.symlink(
			path.join(fixture.paths.agentsSkillsDir as string, "paseo"),
			path.join(fixture.paths.bridgeDir, "paseo-mine"),
		);
		const before = await snapshotTree(fixture.paths.bridgeDir);

		await expect(preflightSkillsBridge(fixture.deps)).rejects.toBeInstanceOf(SkillsBridgeError);
		expect(await snapshotTree(fixture.paths.bridgeDir)).toBe(before);
	});
	test("a retargeted recorded link is a conflict, never pruned (#4644 review r2)", async () => {
		const fixture = await makeFixture();
		await seedSkills(fixture.paths);
		await installWithLedger(fixture.deps);

		// The user retargets a ledger-recorded name at their own tree, then a
		// Paseo release drops that name from the source. Setup must apply the
		// same exact-target predicate remove does: the recorded NAME is not
		// ownership once the link no longer points where the ledger recorded.
		await safeRm(path.join(fixture.paths.bridgeDir, "paseo-loop"));
		await fs.symlink(path.join(fixture.root, "user-own-tree"), path.join(fixture.paths.bridgeDir, "paseo-loop"));
		await safeRm(path.join(fixture.paths.agentsSkillsDir as string, "paseo-loop"), { recursive: true });
		const before = await snapshotTree(fixture.paths.bridgeDir);

		await expect(preflightSkillsBridge(fixture.deps)).rejects.toBeInstanceOf(SkillsBridgeError);
		expect(await snapshotTree(fixture.paths.bridgeDir)).toBe(before);
	});

	test("adoption is refused when the ledger already records a source (#4644 review r2)", async () => {
		const fixture = await makeFixture();
		await seedSkills(fixture.paths);
		// The ledger records ~/.agents/skills as its source, but the discovered
		// source is the app bundle and a recorded link points somewhere else
		// entirely: adoption exists only for legacy ledgers, so this conflicts.
		const bundle = path.join(fixture.root, "Applications", "Paseo.app", "Contents", "Resources", "skills");
		for (const name of ["paseo"]) {
			await fs.mkdir(path.join(bundle, name), { recursive: true });
			await fs.writeFile(path.join(bundle, name, "SKILL.md"), `# ${name}\n`);
		}
		await fs.mkdir(fixture.paths.bridgeDir, { recursive: true });
		await fs.symlink(path.join(fixture.root, "elsewhere"), path.join(fixture.paths.bridgeDir, "paseo"));
		await writeProvenance(fixture.paths.provenanceLedger, {
			version: 1,
			providerKeys: {},
			seededOrchestrationKeys: {},
			bridgePath: fixture.paths.bridgeDir,
			bridgeEntries: ["paseo"],
			bridgeDirCreated: false,
			bridgeSourceDir: fixture.paths.agentsSkillsDir,
		});
		const deps: PaseoSetupDependencies = {
			...fixture.deps,
			skillsSource: async () => ({ dir: bundle, origin: "app-bundle" }),
		};

		await expect(preflightSkillsBridge(deps)).rejects.toBeInstanceOf(SkillsBridgeError);
	});

	test("PASEO_SKILLS_DIR from a project .env is not honored (#4644 review r2)", async () => {
		const root = await makeRoot();
		const home = path.join(root, "home");
		const userDir = path.join(home, ".agents", "skills");
		await fs.mkdir(userDir, { recursive: true });
		// A cloned repository ships this .env and the directory it points at.
		const repoDir = path.join(root, "repo");
		const repoSkills = path.join(repoDir, "skills");
		await fs.mkdir(repoSkills, { recursive: true });
		await fs.mkdir(path.join(repoSkills, "paseo-evil"), { recursive: true });
		await Bun.write(path.join(repoDir, ".env"), `PASEO_SKILLS_DIR=${repoSkills}\n`);
		const priorCwd = process.cwd();
		process.chdir(repoDir);
		const prior = process.env.PASEO_SKILLS_DIR;
		process.env.PASEO_SKILLS_DIR = repoSkills;
		try {
			await expect(resolvePaseoSkillsSource(home)).resolves.toEqual({ dir: userDir, origin: "user" });
		} finally {
			process.chdir(priorCwd);
			if (prior === undefined) delete process.env.PASEO_SKILLS_DIR;
			else process.env.PASEO_SKILLS_DIR = prior;
		}
	});

	test("a bridge-step provenance write failure leaves the ledger intact and no links behind (#4644 review r3)", async () => {
		const fixture = await makeFixture(lsOk("gjc"));
		await seedSkills(fixture.paths);
		await seedConfig(fixture.paths);
		// Complete one install so provider/orchestration steps and their ledger
		// records exist, then reset ONLY the bridge and make the provenance
		// directory unwritable. The next run must fail while committing the
		// bridge provenance -- AFTER the earlier steps, AT the bridge step --
		// proving the record-before-mutation ordering: no link appears and the
		// ledger is unchanged (the failed write rolls back to the old record).
		await runPaseoSetup({}, fixture.deps);
		const before = await fs.readFile(fixture.paths.provenanceLedger, "utf8");
		await safeRm(fixture.paths.bridgeDir, { recursive: true });
		const ledgerParent = path.dirname(fixture.paths.provenanceLedger);
		await fs.chmod(ledgerParent, 0o555);
		let outcome: Awaited<ReturnType<typeof runPaseoSetup>> | undefined;
		try {
			outcome = await runPaseoSetup({}, fixture.deps);
		} catch {
			// A thrown error is also acceptable; both must leave no unrecorded
			// links.
		} finally {
			await fs.chmod(ledgerParent, 0o755);
		}

		// The bridge directory must not exist: no link was created before the
		// record committed.
		await expect(fs.stat(fixture.paths.bridgeDir)).rejects.toMatchObject({ code: "ENOENT" });
		// The failed atomic write left the previous ledger byte-identical and no
		// temporary litter behind.
		expect(await fs.readFile(fixture.paths.provenanceLedger, "utf8")).toBe(before);
		expect((await fs.readdir(ledgerParent)).filter(name => name.endsWith(".tmp"))).toEqual([]);
		if (outcome?.kind === "install") {
			expect(outcome.result.outcome).not.toBe("installed");
		}
	});

	test("a user-created exact-target link is never recorded or removed (#4644 review r3)", async () => {
		const fixture = await makeFixture(lsOk("gjc"));
		await seedSkills(fixture.paths);
		await seedConfig(fixture.paths);
		// The user pre-creates a link whose target matches what GJC would write,
		// in an existing bridge directory no ledger ever recorded.
		await fs.mkdir(fixture.paths.bridgeDir, { recursive: true });
		await fs.symlink(
			path.join(fixture.paths.agentsSkillsDir as string, "paseo"),
			path.join(fixture.paths.bridgeDir, "paseo"),
		);

		const install = await runPaseoSetup({}, fixture.deps);
		expect(install.kind).toBe("install");
		// The user link is a noop to install but is NOT adopted into ownership.
		const ledger = await readProvenance(fixture.paths.provenanceLedger);
		expect(ledger.bridgeEntries).not.toContain("paseo");
		expect(ledger.bridgeEntries).toContain("paseo-advisor");

		// Remove cleans only what GJC recorded; the user's link survives.
		const remove = await runPaseoSetup({ remove: true }, fixture.deps);
		if (remove.kind !== "remove") throw new Error("expected a remove outcome");
		expect(remove.result.outcome).toBe("removed");
		expect((await fs.lstat(path.join(fixture.paths.bridgeDir, "paseo"))).isSymbolicLink()).toBe(true);
	});

	test("a recorded same-target link with a replaced identity refuses convergence (#4644 Codex P2)", async () => {
		const fixture = await makeFixture();
		await seedSkills(fixture.paths);
		await installWithLedger(fixture.deps);
		const name = "paseo";
		const bridgeName = path.join(fixture.paths.bridgeDir, name);
		const target = path.join(fixture.paths.agentsSkillsDir as string, name);
		// Replace the recorded symlink atomically with a user-created link that
		// carries the same target text but a different no-follow identity.
		const replacement = `${bridgeName}.replacement`;
		await fs.symlink(target, replacement);
		await fs.rename(replacement, bridgeName);
		const before = await snapshotTree(fixture.paths.bridgeDir);
		const recordedLedger = await fs.readFile(fixture.paths.provenanceLedger, "utf8");

		await expect(preflightSkillsBridge(fixture.deps)).rejects.toBeInstanceOf(SkillsBridgeError);
		expect(await snapshotTree(fixture.paths.bridgeDir)).toBe(before);
		expect(await fs.readFile(fixture.paths.provenanceLedger, "utf8")).toBe(recordedLedger);
	});

	test("exact-target dangling links require recorded identity before prune-and-recreate (#4644 Codex P2)", async () => {
		for (const mode of ["unrecorded", "identityless", "durable"] as const) {
			const fixture = await makeFixture();
			await seedSkills(fixture.paths);
			const name = "paseo";
			const sourceDir = await fs.realpath(fixture.paths.agentsSkillsDir as string);
			const sourceSkill = path.join(sourceDir, name);
			const bridgeName = path.join(fixture.paths.bridgeDir, name);

			if (mode === "durable") {
				await installWithLedger(fixture.deps);
			} else {
				await fs.mkdir(fixture.paths.bridgeDir, { recursive: true });
				await fs.symlink(sourceSkill, bridgeName);
				if (mode === "identityless") {
					await writeProvenance(fixture.paths.provenanceLedger, {
						version: 1,
						providerKeys: {},
						seededOrchestrationKeys: {},
						bridgePath: fixture.paths.bridgeDir,
						bridgeSourceDir: sourceDir,
						bridgeEntries: [name],
						bridgeEntryIdentities: {},
						bridgeDirCreated: false,
					});
				}
			}

			const before = await snapshotTree(fixture.paths.bridgeDir);
			const originalLstat = fs.lstat.bind(fs);
			let raced = false;
			const lstat = spyOn(fs, "lstat").mockImplementation(async (target, ...rest) => {
				if (!raced && path.resolve(String(target)) === path.resolve(bridgeName)) {
					raced = true;
					await safeRm(sourceSkill, { recursive: true });
				}
				return (await originalLstat(target, ...rest)) as never;
			});
			try {
				if (mode === "durable") {
					const preflight = await preflightSkillsBridge(fixture.deps);
					expect(preflight.entries[name]?.action).toBe("prune-and-recreate");
				} else {
					const preflight = await preflightSkillsBridge(fixture.deps);
					expect(preflight.entries[name]).toBeUndefined();
					expect(preflight.ambiguities?.map(ambiguity => ambiguity.name)).toContain(name);
					expect(await snapshotTree(fixture.paths.bridgeDir)).toBe(before);
					expect(await fs.readlink(bridgeName)).toBe(sourceSkill);
				}
				expect(raced).toBe(true);
				await expect(fs.stat(bridgeName)).rejects.toMatchObject({ code: "ENOENT" });
			} finally {
				lstat.mockRestore();
			}
		}
	});

	test("a prewritten bridge plan never adopts a user-created exact-target link (#4644 Codex P2)", async () => {
		const fixture = await makeFixture(lsOk("gjc"));
		await seedSkills(fixture.paths);
		await seedConfig(fixture.paths);
		// Model the durable pre-mutation ledger write: the planned name is recorded
		// before `installSkillsBridge` creates it, but no per-entry identity exists.
		await writeProvenance(fixture.paths.provenanceLedger, {
			version: 1,
			providerKeys: {},
			seededOrchestrationKeys: {},
			bridgePath: fixture.paths.bridgeDir,
			bridgeSourceDir: await fs.realpath(fixture.paths.agentsSkillsDir as string),
			bridgeEntries: ["paseo"],
			bridgeEntryIdentities: {},
			bridgeDirCreated: false,
		});
		await fs.mkdir(fixture.paths.bridgeDir, { recursive: true });
		await fs.symlink(
			path.join(fixture.paths.agentsSkillsDir as string, "paseo"),
			path.join(fixture.paths.bridgeDir, "paseo"),
		);

		const before = await snapshotTree(fixture.paths.bridgeDir);
		const recordedLedger = await fs.readFile(fixture.paths.provenanceLedger, "utf8");
		const install = await runPaseoSetup({}, fixture.deps);
		expect(install.kind).toBe("install");
		if (install.kind !== "install") throw new Error("expected an install outcome");
		expect(install.result.outcome).toBe("partial-install");
		if (install.result.outcome !== "partial-install") throw new Error("expected a partial install outcome");
		expect(install.result.evidence.detail).toContain("identityless");
		// The matching target does not authorize the identityless user link. It
		// survives unchanged while unrelated bridge entries and setup state proceed.
		expect(await fs.readlink(path.join(fixture.paths.bridgeDir, "paseo"))).toBe(
			path.join(fixture.paths.agentsSkillsDir as string, "paseo"),
		);
		const beforeProvenance = JSON.parse(recordedLedger) as ProvenanceLedger;
		const afterProvenance = await readProvenance(fixture.paths.provenanceLedger);
		expect(afterProvenance.bridgePath).toBe(beforeProvenance.bridgePath);
		expect(afterProvenance.bridgeEntries).toContain("paseo");
		expect(afterProvenance.bridgeEntryIdentities?.paseo).toBeUndefined();
		expect(await snapshotTree(fixture.paths.bridgeDir)).not.toBe(before);
		expect(
			providersOf(JSON.parse(await fs.readFile(fixture.paths.configJson, "utf8")) as Record<string, unknown>).gjc,
		).toBeDefined();
		expect((await fs.lstat(path.join(fixture.paths.bridgeDir, "paseo"))).isSymbolicLink()).toBe(true);
	});

	test("an identityless prewritten stale link is preserved even when its target matches (#4644 Codex P2)", async () => {
		const fixture = await makeFixture();
		await seedSkills(fixture.paths);
		const retiredSource = path.join(fixture.root, "retired-skills");
		const name = "paseo-loop";
		await fs.mkdir(path.join(retiredSource, name), { recursive: true });
		await fs.mkdir(fixture.paths.bridgeDir, { recursive: true });
		await writeProvenance(fixture.paths.provenanceLedger, {
			version: 1,
			providerKeys: {},
			seededOrchestrationKeys: {},
			bridgePath: fixture.paths.bridgeDir,
			bridgeSourceDir: retiredSource,
			bridgeEntries: [name],
			bridgeEntryIdentities: {},
			bridgeDirCreated: false,
		});
		// The user writes the exact target after the durable prewritten plan.
		await fs.symlink(path.join(retiredSource, name), path.join(fixture.paths.bridgeDir, name));
		await safeRm(path.join(fixture.paths.agentsSkillsDir as string, name), { recursive: true });
		const before = await snapshotTree(fixture.paths.bridgeDir);

		const preflight = await preflightSkillsBridge(fixture.deps);
		expect(preflight.entries[name]).toBeUndefined();
		expect(preflight.ambiguities?.map(ambiguity => ambiguity.name)).toContain(name);
		expect(await snapshotTree(fixture.paths.bridgeDir)).toBe(before);
	});

	test("source-relocation adoption refuses a replaced matching-target symlink (#4644 Codex P2)", async () => {
		const fixture = await makeFixture();
		await seedSkills(fixture.paths);
		const name = "paseo";
		const oldSource = await fs.realpath(fixture.paths.agentsSkillsDir as string);
		const relocatedSource = path.join(fixture.root, "relocated-skills");
		await fs.mkdir(path.join(relocatedSource, name), { recursive: true });
		await fs.writeFile(path.join(relocatedSource, name, "SKILL.md"), `# ${name}\n`);

		await fs.mkdir(fixture.paths.bridgeDir, { recursive: true });
		const bridgeName = path.join(fixture.paths.bridgeDir, name);
		const oldTarget = path.join(oldSource, name);
		await fs.symlink(oldTarget, bridgeName);
		const original = await fs.lstat(bridgeName, { bigint: true });
		const recordedIdentity = {
			dev: original.dev.toString(),
			ino: original.ino.toString(),
			size: original.size.toString(),
			mtimeNs: original.mtimeNs.toString(),
		};
		// Atomically replace the original link with a user-created link carrying
		// the same old-source target text but a different no-follow identity.
		const replacement = `${bridgeName}.replacement`;
		await fs.symlink(oldTarget, replacement);
		await fs.rename(replacement, bridgeName);

		await writeProvenance(fixture.paths.provenanceLedger, {
			version: 1,
			providerKeys: {},
			seededOrchestrationKeys: {},
			bridgePath: fixture.paths.bridgeDir,
			bridgeSourceDir: oldSource,
			bridgeEntries: [name],
			bridgeEntryIdentities: { [name]: recordedIdentity },
			bridgeDirCreated: false,
		});
		const before = await snapshotTree(fixture.paths.bridgeDir);
		const recordedLedger = await fs.readFile(fixture.paths.provenanceLedger, "utf8");
		const deps: PaseoSetupDependencies = {
			...fixture.deps,
			skillsSource: async () => ({ dir: relocatedSource, origin: "app-bundle" }),
		};

		await expect(preflightSkillsBridge(deps)).rejects.toBeInstanceOf(SkillsBridgeError);
		expect(await snapshotTree(fixture.paths.bridgeDir)).toBe(before);
		expect(await fs.readFile(fixture.paths.provenanceLedger, "utf8")).toBe(recordedLedger);
	});

	test("a corrupt provenance ledger is an explicit error, never an empty one (#4644 review r3)", async () => {
		const fixture = await makeFixture();
		await seedSkills(fixture.paths);
		await fs.mkdir(path.dirname(fixture.paths.provenanceLedger), { recursive: true });
		await Bun.write(fixture.paths.provenanceLedger, "{ not json at all");
		await expect(readProvenance(fixture.paths.provenanceLedger)).rejects.toThrow(/corrupt/);
		// Check surfaces the corruption instead of silently owning nothing.
		await expect(checkPaseoSetup(fixture.deps)).rejects.toThrow(/corrupt/);
	});

	test("prune ownership stays recorded until the unlink completes (#4644 review r3)", async () => {
		const fixture = await makeFixture(lsOk("gjc"));
		await seedSkills(fixture.paths);
		await seedConfig(fixture.paths);
		await runPaseoSetup({}, fixture.deps);
		// A Paseo release drops a skill; the next install prunes it.
		await safeRm(path.join(fixture.paths.agentsSkillsDir as string, "paseo-loop"), { recursive: true });
		const rerun = await runPaseoSetup({}, fixture.deps);
		expect(rerun.kind).toBe("install");
		// After the prune completes the name is no longer owned...
		const ledger = await readProvenance(fixture.paths.provenanceLedger);
		expect(ledger.bridgeEntries).not.toContain("paseo-loop");
		// ...and the link is gone.
		await expect(fs.lstat(path.join(fixture.paths.bridgeDir, "paseo-loop"))).rejects.toMatchObject({
			code: "ENOENT",
		});
		// The pre-prune record (written before mutation) included the name, so a
		// crash between record and unlink could not strand an unowned link; that
		// window is exercised by the ownership-superset invariant below.
		expect([...(ledger.bridgeEntries ?? [])].sort()).toEqual([
			"paseo",
			"paseo-advisor",
			"paseo-committee",
			"paseo-handoff",
		]);
	});

	test("a failed adoption restores the original legacy link (#4644 review r18)", async () => {
		const fixture = await makeFixture();
		await seedSkills(fixture.paths);
		await fs.mkdir(fixture.paths.bridgeDir, { recursive: true });
		// A recorded legacy link pointing at the legacy source. The adoption
		// plan is driven through installSkillsBridge with a preflight whose
		// replacement target COLLIDES with an occupant planted on the bridge
		// name after the preflight: the quarantine rename removes our link,
		// the replacement publish then fails EEXIST, and the ORIGINAL legacy
		// link must be restored.
		const name = "paseo";
		const legacyTarget = path.join(fixture.paths.agentsSkillsDir as string, name);
		const bridgeName = path.join(fixture.paths.bridgeDir, name);
		await fs.symlink(legacyTarget, bridgeName);
		const legacyStat = await fs.lstat(bridgeName, { bigint: true });
		const plan = {
			name,
			linkPath: bridgeName,
			targetPath: path.join(fixture.paths.agentsSkillsDir as string, "paseo-loop"),
			legacySourceDir: fixture.paths.agentsSkillsDir as string,
			linkTarget: legacyTarget,
			linkIdentity: {
				dev: legacyStat.dev,
				ino: legacyStat.ino,
				size: legacyStat.size,
				mtimeNs: legacyStat.mtimeNs,
			},
		};
		// Occupy the bridge name so the replacement publish hits EEXIST.
		await safeRm(bridgeName);
		await Bun.write(bridgeName, "occupant\n");
		await expect(adoptLegacyLink(plan, plan.legacySourceDir)).rejects.toThrow();
		// The occupant was never destroyed and the bridge name still holds it
		// (nothing foreign is deleted); the legacy link is recoverable in the
		// quarantine. With a VACANT name the original link comes back exactly.
		expect(await fs.readFile(bridgeName, "utf8")).toBe("occupant\n");
	});

	test("register compensation restores adopted legacy link text and ledger facts (#4644 Codex P2)", async () => {
		const fixture = await makeFixture(lsOk("gjc"));
		await seedSkills(fixture.paths);
		await seedConfig(fixture.paths);
		const legacySource = fixture.paths.agentsSkillsDir as string;
		const bundle = path.join(fixture.root, "Applications", "Paseo.app", "Contents", "Resources", "skills");
		for (const name of SKILL_NAMES) {
			await fs.mkdir(path.join(bundle, name), { recursive: true });
			await fs.writeFile(path.join(bundle, name, "SKILL.md"), `# ${name}\n`);
		}
		await fs.mkdir(fixture.paths.bridgeDir, { recursive: true });
		const originalLinkTexts: Record<string, string> = {};
		const legacyIdentities: Record<
			string,
			{ readonly dev: string; readonly ino: string; readonly size: string; readonly mtimeNs: string }
		> = {};
		for (const name of SKILL_NAMES) {
			const bridgeName = path.join(fixture.paths.bridgeDir, name);
			const legacyTarget = path.join(legacySource, name);
			const original = path.relative(path.dirname(bridgeName), legacyTarget);
			originalLinkTexts[name] = original;
			await fs.symlink(original, bridgeName);
			const stat = await fs.lstat(bridgeName, { bigint: true });
			legacyIdentities[name] = {
				dev: stat.dev.toString(),
				ino: stat.ino.toString(),
				size: stat.size.toString(),
				mtimeNs: stat.mtimeNs.toString(),
			};
		}
		await writeProvenance(fixture.paths.provenanceLedger, {
			version: 1,
			providerKeys: {},
			seededOrchestrationKeys: {},
			bridgePath: fixture.paths.bridgeDir,
			bridgeEntries: [...SKILL_NAMES],
			bridgeEntryIdentities: legacyIdentities,
			bridgeDirCreated: false,
		});
		const before = await readProvenance(fixture.paths.provenanceLedger);
		const deps: PaseoSetupDependencies = {
			...fixture.deps,
			skillsSource: async () => ({ dir: bundle, origin: "app-bundle" }),
		};
		const settingsInit = spyOn(Settings, "init").mockImplementation(() =>
			Promise.reject(new Error("simulated skills registration failure")),
		);
		try {
			const install = await runPaseoSetup({}, deps);
			expect(install.kind).toBe("install");
			if (install.kind !== "install") throw new Error("unreachable");
			expect(install.result.outcome).toBe("partial-install");
			for (const name of SKILL_NAMES) {
				expect(await fs.readlink(path.join(fixture.paths.bridgeDir, name))).toBe(originalLinkTexts[name]);
			}
			expect(await readProvenance(fixture.paths.provenanceLedger)).toEqual(before);
		} finally {
			settingsInit.mockRestore();
		}
	});

	test("quarantine restoration never clobbers an entry claiming the bridge name (#4644 review r15)", async () => {
		const fixture = await makeFixture();
		await seedSkills(fixture.paths);
		await fs.mkdir(fixture.paths.bridgeDir, { recursive: true });
		// GJC's recorded link and a foreign entry racing for the same name: the
		// divergence restore must leave a foreign occupant of the bridge name
		// untouched rather than rename the quarantined object over it.
		const name = "paseo-loop";
		const bridgeName = path.join(fixture.paths.bridgeDir, name);
		await fs.symlink(path.join(fixture.paths.agentsSkillsDir as string, "paseo"), bridgeName);
		const foreignStat = await fs.lstat(bridgeName, { bigint: true });

		await expect(
			installSkillsBridge({
				bridgeDir: fixture.paths.bridgeDir,
				bridgeDirCreated: false,
				entries: {},
				prunes: [
					{
						name,
						linkPath: bridgeName,
						linkTarget: path.join(fixture.paths.agentsSkillsDir as string, name),
						linkIdentity: {
							dev: foreignStat.dev,
							ino: foreignStat.ino,
							size: foreignStat.size,
							mtimeNs: foreignStat.mtimeNs,
						},
					},
				],
				adopts: [],
			}),
		).rejects.toBeInstanceOf(SkillsBridgeError);
		// The foreign link survives at the bridge name.
		expect((await fs.lstat(bridgeName)).isSymbolicLink()).toBe(true);
		// No destructive rename left the bridge dir with litter beyond the
		// quarantined object (recoverable, never deleted).
		const names = (await fs.readdir(fixture.paths.bridgeDir)).filter(entry => entry !== name);
		for (const leftover of names) {
			expect(leftover.startsWith(".gjc-paseo-quarantine-")).toBe(true);
		}
	});

	test("a swapped pathname is detected post-rename and the foreign link restored (#4644 review r3)", async () => {
		const fixture = await makeFixture();
		await seedSkills(fixture.paths);
		await fs.mkdir(fixture.paths.bridgeDir, { recursive: true });
		// A foreign link occupies a name the (hand-built) preflight believes is
		// GJC's own with a different recorded target.
		await fs.symlink(
			path.join(fixture.paths.agentsSkillsDir as string, "paseo"),
			path.join(fixture.paths.bridgeDir, "paseo-loop"),
		);
		const foreignStat = await fs.lstat(path.join(fixture.paths.bridgeDir, "paseo-loop"), { bigint: true });
		const before = await snapshotTree(fixture.paths.bridgeDir);

		await expect(
			installSkillsBridge({
				bridgeDir: fixture.paths.bridgeDir,
				bridgeDirCreated: false,
				entries: {},
				prunes: [
					{
						name: "paseo-loop",
						linkPath: path.join(fixture.paths.bridgeDir, "paseo-loop"),
						linkTarget: path.join(fixture.paths.agentsSkillsDir as string, "paseo-loop"),
						linkIdentity: {
							dev: foreignStat.dev,
							ino: foreignStat.ino,
							size: foreignStat.size,
							mtimeNs: foreignStat.mtimeNs,
						},
					},
				],
				adopts: [],
			}),
		).rejects.toBeInstanceOf(SkillsBridgeError);
		// The foreign link is never destroyed (#4644 reviews r3/r15): the
		// original path is VACANT after the quarantine rename, so the
		// no-clobber restore puts it back exactly as it was; when a concurrent
		// entry had claimed the path meanwhile, the quarantined foreign object
		// stays AT the quarantine name instead of being renamed over it.
		expect(await snapshotTree(fixture.paths.bridgeDir)).toBe(before);
	});

	test("a same-target replacement after preflight is preserved (#4644 review r20)", async () => {
		const fixture = await makeFixture();
		await seedSkills(fixture.paths);
		await fs.mkdir(fixture.paths.bridgeDir, { recursive: true });
		const name = "paseo-loop";
		const bridgeName = path.join(fixture.paths.bridgeDir, name);
		const target = path.join(fixture.paths.agentsSkillsDir as string, name);
		await fs.symlink(target, bridgeName);
		const original = await fs.lstat(bridgeName, { bigint: true });
		const plan = {
			name,
			linkPath: bridgeName,
			linkTarget: target,
			linkIdentity: {
				dev: original.dev,
				ino: original.ino,
				size: original.size,
				mtimeNs: original.mtimeNs,
			},
		};
		// The replacement has the exact expected link text, so content-only
		// verification would delete it. Its inode is not GJC's preflight inode.
		const replacementPath = path.join(fixture.paths.bridgeDir, "replacement");
		await fs.symlink(target, replacementPath);
		await fs.rename(replacementPath, bridgeName);
		await expect(
			installSkillsBridge({
				bridgeDir: fixture.paths.bridgeDir,
				bridgeDirCreated: false,
				entries: {},
				prunes: [plan],
				adopts: [],
			}),
		).rejects.toBeInstanceOf(SkillsBridgeError);
		expect((await fs.lstat(bridgeName)).isSymbolicLink()).toBe(true);
		expect(await fs.readlink(bridgeName)).toBe(target);
	});

	test("remove refuses a same-target successor after installation (#4644 review r21)", async () => {
		const fixture = await makeFixture();
		await seedSkills(fixture.paths);
		await installWithLedger(fixture.deps);
		const name = "paseo-loop";
		const bridgeName = path.join(fixture.paths.bridgeDir, name);
		const target = path.join(fixture.paths.agentsSkillsDir as string, name);
		const successor = path.join(fixture.paths.bridgeDir, "successor");
		await fs.symlink(target, successor);
		await fs.rename(successor, bridgeName);

		const remove = await removePaseoSetup(fixture.deps, { now: new Date() });
		expect(remove.outcome).toBe("partial-removal");
		expect((await fs.lstat(bridgeName)).isSymbolicLink()).toBe(true);
		expect(await fs.readlink(bridgeName)).toBe(target);
	});

	test("inverse refuses a swapped bridge root before the first symlink unlink", async () => {
		const fixture = await makeFixture();
		await seedSkills(fixture.paths);
		await seedConfig(fixture.paths);
		const installed = await runPaseoSetup({}, fixture.deps);
		expect(installed.kind).toBe("install");
		const ledger = await readProvenance(fixture.paths.provenanceLedger);
		const retainedRoot = `${fixture.paths.bridgeDir}.retained`;
		await fs.rename(fixture.paths.bridgeDir, retainedRoot);
		await fs.mkdir(fixture.paths.bridgeDir);
		const replacement = path.join(fixture.paths.bridgeDir, "paseo");
		await fs.symlink(path.join(fixture.paths.agentsSkillsDir as string, "paseo"), replacement);

		await expect(
			inverseSkillsBridge(fixture.deps, {
				createdEntries: [...(ledger.bridgeEntries ?? [])],
				prunedEntries: [],
				adoptedEntries: [],
				entryIdentities: ledger.bridgeEntryIdentities ?? {},
				bridgeDirCreated: ledger.bridgeDirCreated ?? false,
				bridgeDirIdentity: ledger.bridgeDirIdentity,
				sourceDir: ledger.bridgeSourceDir,
			}),
		).rejects.toThrow(/replaced Paseo skills bridge directory/);
		// The replacement root and its occupant survive; the recorded links remain
		// under the detached original root for explicit recovery.
		expect(await fs.readlink(replacement)).toBe(path.join(fixture.paths.agentsSkillsDir as string, "paseo"));
		expect((await fs.readdir(retainedRoot)).length).toBe(SKILL_NAMES.length);
	});

	test("an interpolated project .env override is rejected by presence (#4644 review r3)", async () => {
		const root = await makeRoot();
		const home = path.join(root, "home");
		const userDir = path.join(home, ".agents", "skills");
		await fs.mkdir(userDir, { recursive: true });
		const repoDir = path.join(root, "repo");
		const repoSkills = path.join(repoDir, "skills");
		await fs.mkdir(path.join(repoSkills, "paseo-evil"), { recursive: true });
		// Bun expands $PWD before process.env sees the value, so a literal
		// comparison would match nothing; presence must be the rule.
		await Bun.write(path.join(repoDir, ".env"), "PASEO_SKILLS_DIR=$PWD/skills\n");
		const priorCwd = process.cwd();
		process.chdir(repoDir);
		process.env.PASEO_SKILLS_DIR = repoSkills;
		try {
			await expect(resolvePaseoSkillsSource(home)).resolves.toEqual({ dir: userDir, origin: "user" });
		} finally {
			process.chdir(priorCwd);
			delete process.env.PASEO_SKILLS_DIR;
		}
	});

	test("removal uses the ledger-recorded bridge directory throughout (#4644 review r3)", async () => {
		const fixture = await makeFixture(lsOk("gjc"));
		await seedSkills(fixture.paths);
		await seedConfig(fixture.paths);
		await runPaseoSetup({}, fixture.deps);
		// Simulate a path migration: the ledger still records the original
		// directory (which holds the links), while deps.paths points elsewhere.
		const moved = path.join(fixture.root, "moved-paseo-skills");
		await fs.mkdir(moved, { recursive: true });
		const migratedDeps: PaseoSetupDependencies = {
			...fixture.deps,
			paths: { ...fixture.deps.paths, bridgeDir: moved },
		};

		const remove = await removePaseoSetup(migratedDeps, { now: new Date() });
		// #4644 review r14: a recorded path OUTSIDE the agent directory must be
		// confined by both the basename rule and the genuine-migration rule.
		// `moved-paseo-skills` carries the bridge family basename, so the
		// basename rule alone accepts it — the migration rule (no genuine GJC
		// ledger beside the victim) still refuses it. Whichever rule fires,
		// the failure path reports the recorded directory and cleans nothing.
		expect(["removed", "partial-removal"]).toContain(remove.outcome);
		if (remove.outcome === "partial-removal") {
			expect(remove.evidence.detail).toMatch(
				/does not carry the bridge directory name|escapes the agent directory|not a location Paseo skills discovery|neither the configured bridge .* nor an authenticated migration record/,
			);
		}
	});

	test("a valid but empty source bridges nothing and records no phantom bridge (#4644 review r5)", async () => {
		const fixture = await makeFixture(lsOk("gjc"));
		await seedConfig(fixture.paths);
		// The source directory exists but ships no `paseo*` skills: an
		// intentional no-bridge state. No directory is created, nothing is
		// registered, and the ledger must not claim a bridge GJC never built
		// (a phantom record would make --remove straddle a missing path and
		// --check look healthy while loading nothing).
		await runPaseoSetup({}, fixture.deps);
		await runPaseoSetup({}, fixture.deps);

		await expect(fs.stat(fixture.paths.bridgeDir)).rejects.toMatchObject({ code: "ENOENT" });
		const ledger = await readProvenance(fixture.paths.provenanceLedger);
		expect(ledger.bridgeDirCreated).toBeFalsy();
		expect(ledger.bridgePath).toBeUndefined();
		expect(ledger.bridgeEntries).toEqual([]);

		// Removal is still a clean no-op-with-provenance: the daemon credential
		// and the foreign provider survive, and no bridge path is touched.
		const deps: PaseoSetupDependencies = {
			...fixture.deps,
			skillsSource: async () => undefined,
		};
		const remove = await runPaseoSetup({ remove: true }, deps);
		if (remove.kind !== "remove") throw new Error("expected a remove outcome");
		expect(remove.result.outcome).toBe("removed");
		const config = JSON.parse(await fs.readFile(fixture.paths.configJson, "utf8")) as Record<string, unknown>;
		const providers = (config.agents as { providers: Record<string, unknown> }).providers;
		expect(Object.keys(providers).sort()).toEqual(["claude"]);
	});
	test("install and remove serialize on one per-agent mutation lock (#4644 review r5)", async () => {
		const fixture = await makeFixture(lsOk("gjc"));
		await seedSkills(fixture.paths);
		await seedConfig(fixture.paths);

		// The install pauses INSIDE its bridge step and stays there; the remove
		// starts while the install still holds the lock, so the two genuinely
		// overlap (#4644 review r7: releasing the install before starting the
		// remove proves nothing about serialization).
		const installEnteredBridge = Promise.withResolvers<void>();
		const releaseInstall = Promise.withResolvers<void>();
		const gatedSource = fixture.deps.skillsSource;
		const installDeps: PaseoSetupDependencies = {
			...fixture.deps,
			skillsSource: async () => {
				const source = await gatedSource?.();
				installEnteredBridge.resolve();
				await releaseInstall.promise;
				return source;
			},
		};

		const installPromise = runPaseoSetup({}, installDeps);
		// Wait until the install is provably inside its bridge step (it holds
		// the mutation lock and is about to create links).
		await installEnteredBridge.promise;
		const removePromise = runPaseoSetup({ remove: true }, fixture.deps);

		// While the install is blocked mid-mutation, the remove must NOT be able
		// to finish: un-serialized, it would clear the ledger while the install
		// is still creating links and registering the bridge. The settle
		// observer is attached BEFORE the wait so a remove that finished early
		// cannot escape the assertion.
		let removeSettled = false;
		const removeObserved = removePromise.then(
			() => {
				removeSettled = true;
			},
			() => {
				removeSettled = true;
			},
		);
		await Bun.sleep(200);
		expect(removeSettled).toBe(false);
		void removeObserved;

		// Release the install; both now run to completion in serialized order.
		releaseInstall.resolve();
		const install = await installPromise;
		expect(install.kind).toBe("install");
		const remove = await removePromise;
		expect(remove.kind).toBe("remove");

		// The terminal state is consistent whichever side won the serialized
		// order: every live bridge link is covered by the ledger record, and a
		// completed remove leaves no owned link or entry behind.
		const ledger = await readProvenance(fixture.paths.provenanceLedger);
		const liveLinks = (await fs.readdir(fixture.paths.bridgeDir).catch(() => [])).filter(name =>
			name.startsWith("paseo"),
		);
		const recorded = new Set(ledger.bridgeEntries ?? []);
		for (const name of liveLinks) {
			expect(recorded.has(name)).toBe(true);
		}
		if (remove.kind === "remove" && remove.result.outcome === "removed") {
			expect(ledger.bridgeEntries ?? []).toEqual([]);
			expect(liveLinks).toEqual([]);
		}
	});

	test("a pre-existing identical provider entry is never claimed as GJC-owned (#4644 review r5)", async () => {
		const fixture = await makeFixture(lsOk("gjc"));
		await seedSkills(fixture.paths);
		await seedConfig(fixture.paths);
		// Run 1: GJC installs and records its entry.
		await runPaseoSetup({}, fixture.deps);
		// The ledger is lost (or the machine is rebuilt): the config still
		// carries an entry byte-identical to what GJC writes, but GJC no
		// longer has any record of creating it.
		await writeProvenance(fixture.paths.provenanceLedger, {
			version: 1,
			providerKeys: {},
			seededOrchestrationKeys: {},
		});

		const install = await runPaseoSetup({}, fixture.deps);
		expect(install.kind).toBe("install");

		const ledger = await readProvenance(fixture.paths.provenanceLedger);
		expect(ledger.providerKeys.gjc).toBeUndefined();
		expect(ledger.providerPreexistingKeys?.gjc).toBe(true);

		// A later remove leaves the entry in place: it was never GJC's.
		const remove = await runPaseoSetup({ remove: true }, fixture.deps);
		if (remove.kind !== "remove") throw new Error("expected a remove outcome");
		const after = JSON.parse(await fs.readFile(fixture.paths.configJson, "utf8")) as Record<string, unknown>;
		const providers = (after.agents as { providers: Record<string, unknown> }).providers;
		expect(providers.gjc).toBeDefined();
	});

	test("a --force overwrite restores the replaced provider entry on remove (#4644 review r5)", async () => {
		const fixture = await makeFixture(lsOk("gjc"));
		await seedSkills(fixture.paths);
		const userEntry = { ...buildProviderEntry([process.execPath, "acp"]), label: "USER EDIT", enabled: false };
		await seedConfig(fixture.paths, { gjc: userEntry });

		const install = await runPaseoSetup({ force: true }, fixture.deps);
		expect(install.kind).toBe("install");
		const ledger = await readProvenance(fixture.paths.provenanceLedger);
		expect(ledger.providerKeys.gjc).toBeDefined();
		const ref = ledger.providerReplacedEntries?.gjc;
		expect(typeof ref?.backupPath).toBe("string");
		expect(path.isAbsolute(ref?.backupPath ?? "")).toBe(true);
		// The pointer targets a private sidecar holding the replaced value; the
		// ledger itself never serializes the entry (#4644 review r7: a provider
		// value can carry credential-bearing env/argument content, and GJC-side
		// durable state is credential-free by contract).
		const sidecar = JSON.parse(await fs.readFile(ref?.backupPath ?? "", "utf8")) as {
			key: string;
			value: unknown;
		};
		expect(sidecar.key).toBe("gjc");
		expect(sidecar.value).toEqual(userEntry);
		expect((await fs.stat(ref?.backupPath ?? "")).mode & 0o777).toBe(0o600);
		expect(await fs.readFile(fixture.paths.provenanceLedger, "utf8")).not.toContain("USER EDIT");

		const remove = await runPaseoSetup({ remove: true }, fixture.deps);
		if (remove.kind !== "remove") throw new Error("expected a remove outcome");
		const after = JSON.parse(await fs.readFile(fixture.paths.configJson, "utf8")) as Record<string, unknown>;
		const providers = (after.agents as { providers: Record<string, unknown> }).providers;
		expect(providers.gjc).toEqual(userEntry);
		// The sidecar served its restore and is cleaned up with the ownership.
		await expect(fs.stat(ref?.backupPath ?? "")).rejects.toMatchObject({ code: "ENOENT" });
	});

	test("a repeated --force later failure restores pre-step provider provenance and keeps its sidecar", async () => {
		const fixture = await makeFixture(lsOk("gjc"));
		await seedSkills(fixture.paths);
		const firstUserEntry = { ...buildProviderEntry([process.execPath, "acp"]), label: "FIRST USER EDIT" };
		await seedConfig(fixture.paths, { gjc: firstUserEntry });

		const firstInstall = await runPaseoSetup({ force: true }, fixture.deps);
		expect(firstInstall.kind).toBe("install");
		const beforeRetry = await readProvenance(fixture.paths.provenanceLedger);
		const originalRef = beforeRetry.providerReplacedEntries?.gjc;
		if (originalRef === undefined) throw new Error("expected the first force install to preserve a sidecar");

		// A user edit after the first install is the value the repeated force step
		// must restore if a later step fails. The original sidecar remains the
		// removal authority for the first value and must stay referenced.
		const secondUserEntry = { ...buildProviderEntry([process.execPath, "acp"]), label: "SECOND USER EDIT" };
		const current = await readTarget(fixture.paths.configJson);
		const edit = planPublish(current, draft => {
			providersOf(draft).gjc = secondUserEntry;
		});
		await publishPlan(fixture.paths.configJson, edit, {
			expectedIdentity: current.identity,
			backup: false,
			now: fixture.deps.now(),
		});

		const settingsInit = spyOn(Settings, "init").mockRejectedValue(new Error("simulated later Paseo failure"));
		try {
			const retry = await runPaseoSetup({ force: true }, fixture.deps);
			expect(retry.kind).toBe("install");
			if (retry.kind === "install") expect(retry.result.outcome).toBe("partial-install");
		} finally {
			settingsInit.mockRestore();
		}

		const restored = await readTarget(fixture.paths.configJson);
		expect(providersOf(restored.parsed).gjc).toEqual(secondUserEntry);
		const afterRetry = await readProvenance(fixture.paths.provenanceLedger);
		expect(afterRetry.providerKeys).toEqual(beforeRetry.providerKeys);
		expect(afterRetry.providerPreexistingKeys).toEqual(beforeRetry.providerPreexistingKeys);
		expect(afterRetry.providerReplacedEntries).toEqual(beforeRetry.providerReplacedEntries);
		expect(afterRetry.providerReplacedEntries?.gjc).toEqual(originalRef);
		await expect(fs.stat(originalRef.backupPath)).resolves.toBeDefined();
	});

	test("a migration with a tampered ledger name or path refuses instead of cleaning (#4644 review r5)", async () => {
		const fixture = await makeFixture(lsOk("gjc"));
		await seedSkills(fixture.paths);
		await seedConfig(fixture.paths);
		await runPaseoSetup({}, fixture.deps);

		// Tamper: a traversal entry name inside the recorded set.
		const victimDir = path.join(fixture.root, "outside");
		await fs.mkdir(victimDir, { recursive: true });
		const ledger = await readProvenance(fixture.paths.provenanceLedger);
		await writeProvenance(fixture.paths.provenanceLedger, {
			...ledger,
			bridgeEntries: ["paseo", "../../outside/paseo-skills"],
		});

		const newBridge = path.join(fixture.root, "agentdir-new", "paseo-skills");
		const migratedDeps: PaseoSetupDependencies = {
			...fixture.deps,
			paths: { ...fixture.deps.paths, bridgeDir: newBridge },
		};

		await expect(runPaseoSetup({}, migratedDeps)).rejects.toThrow(/unsafe Paseo skill bridge entry name/);
		// The old directory's real links are untouched by the refusal.
		for (const name of ["paseo", "paseo-advisor"]) {
			await expect(fs.lstat(path.join(fixture.paths.bridgeDir, name))).resolves.toBeDefined();
		}
		await expect(fs.lstat(victimDir)).resolves.toBeDefined();
	});

	test("an unreadable source directory fails closed and preserves the bridge (#4644 review r5)", async () => {
		const fixture = await makeFixture(lsOk("gjc"));
		await seedSkills(fixture.paths);
		await seedConfig(fixture.paths);
		await runPaseoSetup({}, fixture.deps);
		const before = await snapshotTree(fixture.paths.bridgeDir);

		// The source directory exists but cannot be read: an app update or a
		// permission change mid-run. Every recorded entry must survive.
		await fs.chmod(fixture.paths.agentsSkillsDir as string, 0o000);
		try {
			// Preflight refuses before any mutation; nothing is pruned.
			await expect(runPaseoSetup({}, fixture.deps)).rejects.toBeInstanceOf(SkillsBridgeError);
		} finally {
			await fs.chmod(fixture.paths.agentsSkillsDir as string, 0o755);
		}
		expect(await snapshotTree(fixture.paths.bridgeDir)).toBe(before);
	});

	test("a source that vanishes mid-run fails closed and preserves the bridge (#4644 review r5)", async () => {
		const fixture = await makeFixture(lsOk("gjc"));
		await seedSkills(fixture.paths);
		await seedConfig(fixture.paths);
		await runPaseoSetup({}, fixture.deps);
		const before = await snapshotTree(fixture.paths.bridgeDir);

		// The resolver verifies the directory, then it disappears before
		// enumeration: the preflight must refuse rather than prune everything.
		const vanishable = path.join(fixture.root, "vanishing-skills");
		await fs.cp(fixture.paths.agentsSkillsDir as string, vanishable, { recursive: true });
		const deps: PaseoSetupDependencies = {
			...fixture.deps,
			skillsSource: async () => {
				await safeRm(vanishable, { recursive: true, force: true });
				return { dir: vanishable, origin: "user" };
			},
		};

		// Preflight refuses rather than pruning; the bridge is untouched.
		await expect(runPaseoSetup({}, deps)).rejects.toBeInstanceOf(SkillsBridgeError);
		expect(await snapshotTree(fixture.paths.bridgeDir)).toBe(before);
	});

	test("a source skill removed after preflight cannot produce a successful dangling bridge", async () => {
		const fixture = await makeFixture(lsOk("gjc"));
		await seedSkills(fixture.paths);
		await seedConfig(fixture.paths);
		const preflight = await preflightSkillsBridge(fixture.deps);
		await safeRm(path.join(fixture.paths.agentsSkillsDir as string, "paseo-loop"), { recursive: true });

		await expect(installSkillsBridge(preflight)).rejects.toBeInstanceOf(SkillsBridgePartialError);
		await expect(fs.stat(path.join(fixture.paths.bridgeDir, "paseo-loop"))).rejects.toMatchObject({ code: "ENOENT" });
	});

	test("a source skill reappearing immediately before prune is preserved with provenance", async () => {
		const fixture = await makeFixture(lsOk("gjc"));
		await seedSkills(fixture.paths);
		await seedConfig(fixture.paths);
		await runPaseoSetup({}, fixture.deps);
		const sourceSkill = path.join(fixture.paths.agentsSkillsDir as string, "paseo-loop");
		const bridgeSkill = path.join(fixture.paths.bridgeDir, "paseo-loop");
		await safeRm(sourceSkill, { recursive: true });

		const originalStat = fs.stat.bind(fs);
		let reappeared = false;
		const statImpl = async (target: any, options?: any) => {
			if (!reappeared && path.resolve(String(target)) === path.resolve(sourceSkill)) {
				reappeared = true;
				await fs.mkdir(sourceSkill, { recursive: true });
			}
			return originalStat(target, options);
		};
		const stat = spyOn(fs, "stat").mockImplementation(statImpl as typeof fs.stat);
		try {
			const install = await runPaseoSetup({}, fixture.deps);
			expect(install.kind).toBe("install");
			if (install.kind !== "install") throw new Error("expected an install outcome");
			expect(install.result.outcome).toBe("partial-install");
			if (install.result.outcome !== "partial-install") throw new Error("expected a partial install outcome");
			expect(install.result.evidence.detail).toContain("source skill reappeared");
		} finally {
			stat.mockRestore();
		}

		expect(reappeared).toBe(true);
		expect((await fs.lstat(bridgeSkill)).isSymbolicLink()).toBe(true);
		expect((await readProvenance(fixture.paths.provenanceLedger)).bridgeEntries).toContain("paseo-loop");
	});

	test("a resolved source that becomes empty prunes to a recorded-created empty bridge, and remove cleans it (#4644 review r5)", async () => {
		const fixture = await makeFixture(lsOk("gjc"));
		await seedSkills(fixture.paths);
		await seedConfig(fixture.paths);
		await runPaseoSetup({}, fixture.deps);

		// Every skill disappears but the directory itself remains valid.
		for (const name of SKILL_NAMES) {
			await safeRm(path.join(fixture.paths.agentsSkillsDir as string, name), { recursive: true });
		}
		const converged = await runPaseoSetup({}, fixture.deps);
		expect(converged.kind).toBe("install");
		const ledger = await readProvenance(fixture.paths.provenanceLedger);
		expect(ledger.bridgeEntries).toEqual([]);
		expect(ledger.bridgeDirCreated).toBe(true);

		const remove = await runPaseoSetup({ remove: true }, fixture.deps);
		if (remove.kind !== "remove") throw new Error("expected a remove outcome");
		expect(remove.result.outcome).toBe("removed");
		await expect(fs.stat(fixture.paths.bridgeDir)).rejects.toMatchObject({ code: "ENOENT" });
	});
	test("a --force overwrite of a scalar provider value is restored on remove (#4644 review r6)", async () => {
		const fixture = await makeFixture(lsOk("gjc"));
		await seedSkills(fixture.paths);
		await seedConfig(fixture.paths, { gjc: "user scalar value" });

		const install = await runPaseoSetup({ force: true }, fixture.deps);
		expect(install.kind).toBe("install");
		const ledger = await readProvenance(fixture.paths.provenanceLedger);
		// A scalar prior is preserved through the same sidecar pointer, never
		// serialized into the ledger itself.
		const sidecar = JSON.parse(await fs.readFile(ledger.providerReplacedEntries?.gjc?.backupPath ?? "", "utf8")) as {
			key: string;
			value: unknown;
		};
		expect(sidecar.value).toBe("user scalar value");
		expect(await fs.readFile(fixture.paths.provenanceLedger, "utf8")).not.toContain("user scalar value");

		const remove = await runPaseoSetup({ remove: true }, fixture.deps);
		if (remove.kind !== "remove") throw new Error("expected a remove outcome");
		const after = JSON.parse(await fs.readFile(fixture.paths.configJson, "utf8")) as Record<string, unknown>;
		const providers = (after.agents as { providers: Record<string, unknown> }).providers;
		expect(providers.gjc).toBe("user scalar value");
	});

	test("a --force overwrite of a null provider value is restored on remove (#4644 review r6)", async () => {
		const fixture = await makeFixture(lsOk("gjc"));
		await seedSkills(fixture.paths);
		const config = {
			daemon: { auth: { password: FIXTURE_PASSWORD }, port: 4317 },
			agents: { providers: { claude: { enabled: true }, gjc: null } },
		};
		await fs.writeFile(fixture.paths.configJson, serializeJson(config), { mode: 0o600 });

		const install = await runPaseoSetup({ force: true }, fixture.deps);
		expect(install.kind).toBe("install");

		const remove = await runPaseoSetup({ remove: true }, fixture.deps);
		if (remove.kind !== "remove") throw new Error("expected a remove outcome");
		const after = JSON.parse(await fs.readFile(fixture.paths.configJson, "utf8")) as Record<string, unknown>;
		const providers = (after.agents as { providers: Record<string, unknown> }).providers;
		expect(providers.gjc).toBeNull();
	});

	test("a missing replaced-provider sidecar fails removal closed instead of deleting the key (#4644 review r7)", async () => {
		const fixture = await makeFixture(lsOk("gjc"));
		await seedSkills(fixture.paths);
		const userEntry = { ...buildProviderEntry([process.execPath, "acp"]), label: "USER EDIT", enabled: false };
		await seedConfig(fixture.paths, { gjc: userEntry });
		await runPaseoSetup({ force: true }, fixture.deps);

		// The private sidecar is lost (deleted, restored from a partial backup):
		// removal must not fall back to deleting content it cannot restore.
		const ledger = await readProvenance(fixture.paths.provenanceLedger);
		await safeRm(ledger.providerReplacedEntries?.gjc?.backupPath ?? "", { force: true });

		const remove = await runPaseoSetup({ remove: true }, fixture.deps);
		if (remove.kind !== "remove") throw new Error("expected a remove outcome");
		expect(remove.result.outcome).toBe("partial-removal");
		if (remove.result.outcome === "partial-removal") {
			expect(remove.result.evidence.detail).toContain("cannot be restored");
		}
		// GJC's entry survives: the restore never happened, so neither may the delete.
		const after = JSON.parse(await fs.readFile(fixture.paths.configJson, "utf8")) as Record<string, unknown>;
		expect(providersOf(after).gjc).toBeDefined();
	});

	test("a failed sidecar deletion retries after restoring the user provider value", async () => {
		const fixture = await makeFixture(lsOk("gjc"));
		await seedSkills(fixture.paths);
		const userEntry = { ...buildProviderEntry([process.execPath, "acp"]), label: "USER EDIT", enabled: false };
		await seedConfig(fixture.paths, { gjc: userEntry });
		await runPaseoSetup({ force: true }, fixture.deps);
		const ledgerBefore = await readProvenance(fixture.paths.provenanceLedger);
		const sidecarPath = ledgerBefore.providerReplacedEntries?.gjc?.backupPath;
		if (sidecarPath === undefined) throw new Error("expected a replaced-provider sidecar");

		const realRemove = paseoJsonPublisher.removeReplacedProviderBackup.bind(paseoJsonPublisher);
		let attempts = 0;
		const removeSidecar = spyOn(paseoJsonPublisher, "removeReplacedProviderBackup").mockImplementation(
			async (...args) => {
				attempts += 1;
				if (attempts === 1) return false;
				return realRemove(...args);
			},
		);
		try {
			const first = await runPaseoSetup({ remove: true }, fixture.deps);
			expect(first.kind).toBe("remove");
			if (first.kind !== "remove") throw new Error("expected a remove outcome");
			expect(first.result.outcome).toBe("partial-removal");
			const restored = JSON.parse(await fs.readFile(fixture.paths.configJson, "utf8")) as Record<string, unknown>;
			expect(providersOf(restored).gjc).toEqual(userEntry);
			expect((await readProvenance(fixture.paths.provenanceLedger)).providerReplacedEntries?.gjc).toBeDefined();
			await expect(fs.stat(sidecarPath)).resolves.toBeDefined();
		} finally {
			removeSidecar.mockRestore();
		}

		const second = await runPaseoSetup({ remove: true }, fixture.deps);
		expect(second.kind).toBe("remove");
		if (second.kind !== "remove") throw new Error("expected a remove outcome");
		expect(second.result.outcome).toBe("removed");
		expect((await readProvenance(fixture.paths.provenanceLedger)).providerReplacedEntries?.gjc).toBeUndefined();
		await expect(fs.stat(sidecarPath)).rejects.toMatchObject({ code: "ENOENT" });
	});

	test("replaced-provider sidecar names are injective across colliding sanitized keys (#4644 review r8)", async () => {
		const fixture = await makeFixture(lsOk("gjc"));
		await seedSkills(fixture.paths);
		await seedConfig(fixture.paths);
		// `a/b` and `a_b` sanitize identically; before r8 both mapped to ONE
		// sidecar path, so the second `--force` renamed over the first key's
		// only preserved copy of the user's value.
		const slashRef = await writeReplacedProviderBackup(fixture.paths.configJson, "a/b", "slash value");
		const underscoreRef = await writeReplacedProviderBackup(fixture.paths.configJson, "a_b", "underscore value");
		expect(slashRef.backupPath).not.toBe(underscoreRef.backupPath);
		// Both preserved values survive side by side and read back exactly.
		const slash = await readReplacedProviderBackup(slashRef.backupPath, "a/b", slashRef.valueSha256);
		expect(slash).toEqual({ found: true, value: "slash value" });
		const underscore = await readReplacedProviderBackup(underscoreRef.backupPath, "a_b", underscoreRef.valueSha256);
		expect(underscore).toEqual({ found: true, value: "underscore value" });
	});

	test("an existing replaced-provider sidecar is never clobbered (#4644 review r8)", async () => {
		const fixture = await makeFixture(lsOk("gjc"));
		await seedSkills(fixture.paths);
		await seedConfig(fixture.paths);
		const first = await writeReplacedProviderBackup(fixture.paths.configJson, "gjc", "user value");
		// A later write of the SAME key with DIFFERENT bytes must fail closed
		// instead of replacing the user's preserved value.
		await expect(writeReplacedProviderBackup(fixture.paths.configJson, "gjc", "attacker value")).rejects.toThrow(
			/already exists at this path with different content/,
		);
		// The first value is intact.
		const reread = await readReplacedProviderBackup(first.backupPath, "gjc", first.valueSha256);
		expect(reread).toEqual({ found: true, value: "user value" });
		// Re-writing the exact same bytes is idempotent and keeps the ref.
		const again = await writeReplacedProviderBackup(fixture.paths.configJson, "gjc", "user value");
		expect(again.backupPath).toBe(first.backupPath);
		expect(again.valueSha256).toBe(first.valueSha256);
	});
	test("an exact pre-existing sidecar remains user-owned through install and remove (#4644 review r19)", async () => {
		const fixture = await makeFixture(lsOk("gjc"));
		await seedSkills(fixture.paths);
		const userEntry = { ...buildProviderEntry([process.execPath, "acp"]), label: "USER EDIT" };
		await seedConfig(fixture.paths, { gjc: userEntry });
		const sidecar = await writeReplacedProviderBackup(fixture.paths.configJson, "gjc", userEntry);

		const install = await runPaseoSetup({ force: true }, fixture.deps);
		expect(install.kind).toBe("install");
		if (install.kind !== "install") throw new Error("expected an install outcome");
		expect(install.result.outcome).toBe("installed");

		const remove = await runPaseoSetup({ remove: true }, fixture.deps);
		expect(remove.kind).toBe("remove");
		if (remove.kind !== "remove") throw new Error("expected a remove outcome");
		expect(remove.result.outcome).toBe("removed");
		expect(await readReplacedProviderBackup(sidecar.backupPath, "gjc", sidecar.valueSha256)).toEqual({
			found: true,
			value: userEntry,
		});
	});
	test("a sidecar conflict during the provider step refuses before publication instead of stranding an unowned overwrite (#4644 review r8)", async () => {
		const fixture = await makeFixture(lsOk("gjc"));
		await seedSkills(fixture.paths);
		const userEntry = { ...buildProviderEntry([process.execPath, "acp"]), label: "USER EDIT" };
		await seedConfig(fixture.paths, { gjc: userEntry });
		// An attacker pre-plants a sidecar at the deterministic injective path
		// holding different content for the same key: `--force` must fail before
		// publication, and the tampered sidecar must not be overwritten.
		const plantedPath = replacedProviderBackupPath(fixture.paths.configJson, "gjc");
		await Bun.write(plantedPath, serializeJson({ key: "gjc", value: { evil: true } }));

		const install = await runPaseoSetup({ force: true }, fixture.deps);
		expect(install.kind).toBe("install");
		if (install.kind === "install") expect(install.result.outcome).toBe("partial-install");
		const after = JSON.parse(await fs.readFile(fixture.paths.configJson, "utf8")) as Record<string, unknown>;
		expect(providersOf(after).gjc).toEqual(userEntry);
		const ledger = await readProvenance(fixture.paths.provenanceLedger);
		expect(ledger.providerKeys.gjc).toBeUndefined();
		// r16: the planted file PREDATES this run (persist refused on it), so
		// unpersist never deletes it — a pre-existing sidecar is not ours to
		// remove. The user's config entry is still restored and no NEW sidecar
		// was created, which is the fail-closed contract.
		expect(await fs.readFile(plantedPath, "utf8")).toContain("evil");
	});

	test("persists the replaced-provider sidecar before publication and recovers a pre-publication interruption (#4644 Codex P1)", async () => {
		const fixture = await makeFixture(lsOk("gjc"));
		await seedSkills(fixture.paths);
		const userEntry = { ...buildProviderEntry([process.execPath, "acp"]), label: "USER EDIT" };
		await seedConfig(fixture.paths, { gjc: userEntry });
		const before = await readTarget(fixture.paths.configJson);
		const sidecarPath = replacedProviderBackupPath(fixture.paths.configJson, "gjc");
		const sidecarRef = {
			backupPath: sidecarPath,
			valueSha256: hashBytes(serializeJson(userEntry)),
		};
		const sidecarBytes = serializeJson({ key: "gjc", value: userEntry });
		const discardSidecar = { backupPath: sidecarPath, valueSha256: hashBytes(sidecarBytes) };
		let valueAtPersist: unknown;

		await expect(
			runJsonStep({
				label: fixture.paths.configJson,
				step: "provider-config",
				targetPath: fixture.paths.configJson,
				provenancePath: fixture.paths.provenanceLedger,
				intentPath: fixture.paths.intentRecord,
				ownedKeys: ["agents.providers.gjc"],
				expectedPreflightIdentity: before.identity,
				mutate: draft => {
					(draft.agents as { providers: Record<string, unknown> }).providers.gjc = { replaced: true };
				},
				nextLedger: ledger => ({
					...ledger,
					providerKeys: { ...ledger.providerKeys, gjc: "new-provider-entry" },
					providerReplacedEntries: { ...ledger.providerReplacedEntries, gjc: sidecarRef },
				}),
				revert: draft => {
					(draft.agents as { providers: Record<string, unknown> }).providers.gjc = userEntry;
				},
				revertLedger: ledger => ledger,
				discardSidecar,
				persist: async () => {
					const observed = await readTarget(fixture.paths.configJson);
					valueAtPersist = providersOf(observed.parsed).gjc;
					await writeReplacedProviderBackup(fixture.paths.configJson, "gjc", userEntry);
					// Model an interruption immediately after the sidecar is made
					// durable: publication must not have happened yet.
					throw new Error("simulated interruption after sidecar persistence");
				},
				now: new Date("2026-01-01T00:00:00.000Z"),
			}),
		).rejects.toBeInstanceOf(SagaStepError);

		expect(valueAtPersist).toEqual(userEntry);
		expect(providersOf((await readTarget(fixture.paths.configJson)).parsed).gjc).toEqual(userEntry);
		expect(await readReplacedProviderBackup(sidecarPath, "gjc", sidecarRef.valueSha256)).toEqual({
			found: true,
			value: userEntry,
		});
		expect(await readIntent(fixture.paths.intentRecord)).toBeDefined();

		const recovery = await recoverIntent(fixture.paths.intentRecord, {
			repair: true,
			expectedTargetPaths: [
				fixture.paths.configJson,
				fixture.paths.orchestrationPreferences,
				fixture.paths.bridgeDir,
			],
			expectedProvenancePath: fixture.paths.provenanceLedger,
		});
		if (!recovery?.recovered) throw new Error(JSON.stringify(recovery));
		expect(recovery?.recovered).toBe(true);
		expect(await readIntent(fixture.paths.intentRecord)).toBeUndefined();
		// The target never published, so recovery discards the intent and the
		// authenticated sidecar this interrupted step created.
		await expect(fs.stat(sidecarPath)).rejects.toMatchObject({ code: "ENOENT" });
		expect((await readProvenance(fixture.paths.provenanceLedger)).providerReplacedEntries?.gjc).toBeUndefined();
	});

	test("a refused provider publish leaves no replaced-provider sidecar behind (#4644 review r8)", async () => {
		const fixture = await makeFixture(lsOk("gjc"));
		await seedSkills(fixture.paths);
		const userEntry = { ...buildProviderEntry([process.execPath, "acp"]), label: "USER EDIT" };
		await seedConfig(fixture.paths, { gjc: userEntry });
		let mutated = false;
		const deps: PaseoSetupDependencies = {
			...fixture.deps,
			// The bridge preflight runs after config.json was read for ownership
			// decisions; a user edit landing in that window must refuse the
			// publish AND leave no credential-bearing sidecar behind.
			skillsSource: async () => {
				if (!mutated) {
					mutated = true;
					const config = JSON.parse(await fs.readFile(fixture.paths.configJson, "utf8")) as Record<
						string,
						unknown
					>;
					config.daemon = { ...(config.daemon as object), port: 9999 };
					await fs.writeFile(fixture.paths.configJson, serializeJson(config), { mode: 0o600 });
				}
				return { dir: fixture.paths.agentsSkillsDir as string, origin: "user" };
			},
		};

		const install = await runPaseoSetup({ force: true }, deps);
		expect(install.kind).toBe("install");
		if (install.kind === "install") expect(install.result.outcome).toBe("partial-install");
		const sidecars = (await fs.readdir(path.dirname(fixture.paths.configJson))).filter(name =>
			name.includes("gjc-replaced"),
		);
		expect(sidecars).toEqual([]);
	});

	test("a fresh no-source install records no bridge ownership and never deletes later user content at that path (#4644 review r8)", async () => {
		const fixture = await makeFixture(lsOk("gjc"));
		await seedConfig(fixture.paths);
		const deps: PaseoSetupDependencies = {
			...fixture.deps,
			skillsSource: async () => undefined,
		};

		const install = await runPaseoSetup({}, deps);
		expect(install.kind).toBe("install");
		if (install.kind !== "install") throw new Error("unreachable");
		expect(install.result.outcome).toBe("installed");
		if (install.result.outcome !== "installed") throw new Error("unreachable");
		expect(install.result.changed).toContain("paseo skills bridge (no source)");
		// Nothing was created, so NOTHING may be recorded: a planned
		// `bridgeDirCreated: true` used to let --remove trust false ownership.
		const ledger = await readProvenance(fixture.paths.provenanceLedger);
		expect(ledger.bridgePath).toBeUndefined();
		expect(ledger.bridgeDirCreated).toBeFalsy();
		expect(ledger.bridgeEntries).toBeUndefined();

		// The user later creates that exact path with their own work.
		await fs.mkdir(fixture.paths.bridgeDir, { recursive: true });
		await Bun.write(path.join(fixture.paths.bridgeDir, "user-file.md"), "# user work\n");

		const remove = await runPaseoSetup({ remove: true }, deps);
		expect(remove.kind).toBe("remove");
		if (remove.kind !== "remove") throw new Error("unreachable");
		expect(["removed", "nothing-to-remove"]).toContain(remove.result.outcome);
		// The user's content survived the removal run untouched.
		expect(await fs.readFile(path.join(fixture.paths.bridgeDir, "user-file.md"), "utf8")).toBe("# user work\n");
	});
	test("a mid-bridge failure corrects the ledger to observed reality instead of the plan (#4644 review r9)", async () => {
		const fixture = await makeFixture(lsOk("gjc"));
		await seedSkills(fixture.paths);
		await seedConfig(fixture.paths);
		const bridgeLedger = await readProvenance(fixture.paths.provenanceLedger);
		// Partial failure: the first link was created, the second refused, so
		// ownership is the created link only — never the full plan.
		await correctBridgeOwnershipAfterFailure(fixture.deps, bridgeLedger, false, {
			createdEntries: ["paseo"],
			prunedEntries: [],
			adoptedEntries: [],
			entryIdentities: {},
			bridgeDirCreated: false,
			sourceDir: fixture.paths.agentsSkillsDir,
		});
		expect((await readProvenance(fixture.paths.provenanceLedger)).bridgeEntries).toEqual(["paseo"]);

		// Prunes completed before the failure leave the ledger too.
		await correctBridgeOwnershipAfterFailure(
			fixture.deps,
			{ ...bridgeLedger, bridgeEntries: ["paseo", "paseo-loop"] },
			false,
			{
				createdEntries: ["paseo-advisor"],
				prunedEntries: ["paseo-loop"],
				adoptedEntries: [],
				entryIdentities: {},
				bridgeDirCreated: false,
			},
		);
		expect((await readProvenance(fixture.paths.provenanceLedger)).bridgeEntries).toEqual(["paseo", "paseo-advisor"]);
	});

	test("installSkillsBridge failures carry partial results (#4644 review r9)", async () => {
		const fixture = await makeFixture(lsOk("gjc"));
		await seedSkills(fixture.paths);
		const preflight = await preflightSkillsBridge(fixture.deps);
		expect(preflight.bridgeDirCreated).toBe(true);
		// The directory appears after the preflight said absent: creation
		// refuses before any link exists, and the failure still carries the
		// (empty) partial state callers correct the ledger with.
		await fs.mkdir(path.dirname(fixture.paths.bridgeDir), { recursive: true });
		await fs.mkdir(fixture.paths.bridgeDir);
		const attempt = await installSkillsBridge(preflight).catch(error => error);
		expect(attempt).toBeInstanceOf(SkillsBridgePartialError);
		if (attempt instanceof SkillsBridgePartialError) {
			expect(attempt.partial.createdEntries).toEqual([]);
			expect(attempt.partial.bridgeDirCreated).toBe(false);
		}
	});

	test("malformed provenance fields fail closed as corrupt instead of defaulting (#4644 review r9)", async () => {
		const fixture = await makeFixture(lsOk("gjc"));
		await seedSkills(fixture.paths);
		await seedConfig(fixture.paths);
		const base = await readProvenance(fixture.paths.provenanceLedger);
		const malformed: readonly (readonly [string, unknown])[] = [
			["providerKeys", "garbage"],
			["providerReplacedEntries", "garbage"],
			["seededOrchestrationKeys", 7],
			["bridgePath", 42],
			["bridgeEntries", "paseo"],
			["bridgeEntries", ["paseo", 7]],
			["bridgeDirCreated", "yes"],
			["version", "one"],
		];
		for (const [field, value] of malformed) {
			await writeProvenance(fixture.paths.provenanceLedger, { ...base, [field]: value } as never);
			await expect(readProvenance(fixture.paths.provenanceLedger)).rejects.toBeInstanceOf(
				ProvenanceLedgerCorruptError,
			);
		}
		// Absent fields still default: an old-shape ledger reads cleanly.
		await Bun.write(
			fixture.paths.provenanceLedger,
			`${JSON.stringify({ version: 1, providerKeys: { gjc: "abc" } }, null, 2)}\n`,
		);
		const legacy = await readProvenance(fixture.paths.provenanceLedger);
		expect(legacy.providerKeys).toEqual({ gjc: "abc" });
		expect(legacy.bridgeEntries).toBeUndefined();
	});

	test("a symlinked sidecar is refused instead of read through (#4644 review r9)", async () => {
		const fixture = await makeFixture(lsOk("gjc"));
		await seedSkills(fixture.paths);
		await seedConfig(fixture.paths);
		const real = path.join(fixture.root, "attacker.json");
		await Bun.write(real, `${JSON.stringify({ key: "gjc", value: { evil: true } }, null, 2)}\n`);
		const ref = await writeReplacedProviderBackup(fixture.paths.configJson, "gjc", { real: "value" });
		// Swap the sidecar for a symlink at the same path: the read must fail
		// closed (never follow), so restoration can never be redirected.
		await safeRm(ref.backupPath);
		await fs.symlink(real, ref.backupPath);
		const read = await readReplacedProviderBackup(ref.backupPath, "gjc", ref.valueSha256);
		expect(read).toEqual({ found: false });
	});

	test("a dangling off-source bridge link reports exactly one drift reason (#4644 review r9)", async () => {
		const fixture = await makeFixture(lsOk("gjc"));
		await seedSkills(fixture.paths);
		await seedConfig(fixture.paths);
		await runPaseoSetup({}, fixture.deps);
		// The recorded link is retargeted at a deleted foreign path: dangling
		// AND off-source at once. Before r9 both scan loops reported it.
		const foreign = path.join(fixture.root, "gone", "paseo");
		await safeRm(path.join(fixture.paths.bridgeDir, "paseo"));
		await fs.symlink(foreign, path.join(fixture.paths.bridgeDir, "paseo"));
		const check = await runPaseoSetup({ check: true }, fixture.deps);
		if (check.kind !== "check") throw new Error("expected a check outcome");
		const subjects = check.result.reasons.map(reason => reason.subject);
		const duplicates = subjects.filter((subject, index) => subjects.indexOf(subject) !== index);
		expect(duplicates).toEqual([]);
		expect(check.result.reasons.filter(reason => reason.subject.endsWith("/paseo")).length).toBe(1);
	});

	test("a ledger-commit failure unpersists the sidecar and reverts the publish (#4644 review r10)", async () => {
		const fixture = await makeFixture(lsOk("gjc"));
		await seedSkills(fixture.paths);
		const userEntry = { ...buildProviderEntry([process.execPath, "acp"]), label: "USER EDIT" };
		await seedConfig(fixture.paths, { gjc: userEntry });
		// A read-only provenance directory: readProvenance sees ENOENT (an
		// empty ledger) before the step, and writeProvenance's temp-file open
		// fails EACCES only AFTER the publish + persist succeeded.
		const blocker = path.join(fixture.root, "blocker");
		await fs.mkdir(blocker, { recursive: true, mode: 0o500 });
		const sidecarPath = replacedProviderBackupPath(fixture.paths.configJson, "gjc");
		let persisted = false;

		await expect(
			runJsonStep({
				label: fixture.paths.configJson,
				step: "provider-config",
				targetPath: fixture.paths.configJson,
				provenancePath: path.join(blocker, "paseo", "provenance.json"),
				intentPath: fixture.paths.intentRecord,
				ownedKeys: ["agents.providers.gjc"],
				expectedPreflightIdentity: (await readTarget(fixture.paths.configJson)).identity,
				mutate: draft => {
					(draft.agents as { providers: Record<string, unknown> }).providers.gjc = { replaced: true };
				},
				nextLedger: ledger => ledger,
				revert: draft => {
					(draft.agents as { providers: Record<string, unknown> }).providers.gjc = userEntry;
				},
				revertLedger: ledger => ledger,
				persist: async () => {
					await writeReplacedProviderBackup(fixture.paths.configJson, "gjc", userEntry);
					persisted = true;
				},
				unpersist: async () => {
					persisted = false;
					await safeRm(sidecarPath, { force: true });
				},
				now: new Date("2026-01-01T00:00:00.000Z"),
			}),
		).rejects.toBeInstanceOf(SagaStepError);
		expect(persisted).toBe(false);
		// The publication was rolled back and no orphaned sidecar survives.
		const after = JSON.parse(await fs.readFile(fixture.paths.configJson, "utf8")) as Record<string, unknown>;
		expect(providersOf(after).gjc).toEqual(userEntry);
		await expect(fs.lstat(sidecarPath)).rejects.toMatchObject({ code: "ENOENT" });
		await expect(fs.lstat(fixture.paths.intentRecord)).rejects.toMatchObject({ code: "ENOENT" });
	});

	test("non-string provenance record values are corruption, not provenance (#4644 review r10)", async () => {
		const fixture = await makeFixture(lsOk("gjc"));
		await seedSkills(fixture.paths);
		await seedConfig(fixture.paths);
		const base = await readProvenance(fixture.paths.provenanceLedger);
		for (const [field, value] of [
			["providerKeys", { gjc: 7 }],
			["seededOrchestrationKeys", { leader: { nested: true } }],
			["providerKeys", { gjc: null }],
		] as const) {
			await writeProvenance(fixture.paths.provenanceLedger, { ...base, [field]: value } as never);
			await expect(readProvenance(fixture.paths.provenanceLedger)).rejects.toBeInstanceOf(
				ProvenanceLedgerCorruptError,
			);
		}
	});

	test("a corrupt intent record is a refusal, never absence (#4644 review r10)", async () => {
		const fixture = await makeFixture(lsOk("gjc"));
		await seedSkills(fixture.paths);
		await seedConfig(fixture.paths);
		await fs.mkdir(path.dirname(fixture.paths.intentRecord), { recursive: true });
		await Bun.write(fixture.paths.intentRecord, "{ this is not json");
		const recovery = await recoverIntent(fixture.paths.intentRecord, {
			repair: true,
			expectedTargetPaths: [
				fixture.paths.configJson,
				fixture.paths.orchestrationPreferences,
				fixture.paths.bridgeDir,
			],
			expectedProvenancePath: fixture.paths.provenanceLedger,
		});
		expect(recovery?.recovered).toBe(false);
		expect(recovery?.detail).toContain("corrupt");
		const check = await runPaseoSetup({ check: true }, fixture.deps);
		if (check.kind !== "check") throw new Error("expected a check outcome");
		expect(check.result.reasons.map(reason => reason.code)).toContain("partial-install");
	});

	test("a tampered recorded bridge source outside trusted roots never drives removal (#4644 review r10)", async () => {
		const fixture = await makeFixture(lsOk("gjc"));
		await seedSkills(fixture.paths);
		await seedConfig(fixture.paths);
		await runPaseoSetup({}, fixture.deps);
		const ledger = await readProvenance(fixture.paths.provenanceLedger);
		await writeProvenance(fixture.paths.provenanceLedger, { ...ledger, bridgeSourceDir: "/etc/paseo-skills" });

		const remove = await runPaseoSetup({ remove: true }, fixture.deps);
		expect(remove.kind).toBe("remove");
		if (remove.kind !== "remove") throw new Error("unreachable");
		expect(remove.result.outcome).toBe("partial-removal");
		if (remove.result.outcome === "partial-removal") {
			expect(remove.result.evidence.detail).toContain("outside every trusted Paseo source root");
			// The refusal happens in the pre-settings validation window, so
			// the skills.customDirectories registration is NOT unregistered
			// first (the bridge-path rule's ordering, mirrored for the source).
			expect(remove.result.evidence.retained).toContain(fixture.paths.provenanceLedger);
		}
		// The bridge links are intact.
		for (const name of SKILL_NAMES) {
			await fs.lstat(path.join(fixture.paths.bridgeDir, name));
		}
	});

	test("a symlinked skills source records canonically and stays removable (#4644 review r11)", async () => {
		const fixture = await makeFixture(lsOk("gjc"));
		await seedConfig(fixture.paths);
		// The source the resolver returns is a SYMLINK inside the fixture root;
		// its canonical target is a sibling directory, also inside the root.
		const realSkills = path.join(fixture.root, "real-skills");
		for (const name of ["paseo", "paseo-loop"]) {
			await fs.mkdir(path.join(realSkills, name), { recursive: true });
		}
		const linkedSkills = path.join(fixture.root, "linked-skills");
		await fs.symlink(realSkills, linkedSkills);
		const deps: PaseoSetupDependencies = {
			...fixture.deps,
			skillsSource: async () => ({ dir: linkedSkills, origin: "user" }),
		};

		await runPaseoSetup({}, deps);
		const ledger = await readProvenance(fixture.paths.provenanceLedger);
		// The ledger carries the CANONICAL directory, matching what the
		// removal-time trust check resolves.
		expect(ledger.bridgeSourceDir).toBe(realSkills);

		const remove = await runPaseoSetup({ remove: true }, deps);
		expect(remove.kind).toBe("remove");
		if (remove.kind !== "remove") throw new Error("unreachable");
		expect(remove.result.outcome).toBe("removed");
		await expect(fs.stat(fixture.paths.bridgeDir)).rejects.toMatchObject({ code: "ENOENT" });
	});

	test("a symlinked source passes --check without false drift after install (#4644 review r12)", async () => {
		const fixture = await makeFixture(lsOk("gjc"));
		await seedConfig(fixture.paths);
		const realSkills = path.join(fixture.root, "real-skills");
		for (const name of ["paseo", "paseo-loop"]) {
			await fs.mkdir(path.join(realSkills, name), { recursive: true });
		}
		const linkedSkills = path.join(fixture.root, "linked-skills");
		await fs.symlink(realSkills, linkedSkills);
		const deps: PaseoSetupDependencies = {
			...fixture.deps,
			skillsSource: async () => ({ dir: linkedSkills, origin: "user" }),
		};
		await runPaseoSetup({}, deps);

		// The drift scan canonicalizes the source exactly like installation,
		// so a valid bridge through a symlinked source reports NO drift.
		const check = await runPaseoSetup({ check: true }, deps);
		if (check.kind !== "check") throw new Error("expected a check outcome");
		expect(check.result.reasons.filter(reason => reason.code.includes("skill"))).toEqual([]);
	});

	test("a tampered intent record redirecting the provenance path is refused (#4644 review r13)", async () => {
		const fixture = await makeFixture(lsOk("gjc"));
		await seedSkills(fixture.paths);
		await seedConfig(fixture.paths);
		// A record that keeps its two target fields but points recovery at a
		// foreign provenance path must be corruption, not a recovery input.
		const foreign = path.join(fixture.root, "foreign", "provenance.json");
		const record = {
			version: 1,
			step: "provider-config",
			targetPath: fixture.paths.configJson,
			targetPreflightIdentity: "a".repeat(64),
			targetExpectedIdentity: "b".repeat(64),
			provenancePath: foreign,
			provenancePreflightIdentity: "c".repeat(64),
			provenanceExpectedIdentity: "d".repeat(64),
			ownedKeys: ["agents.providers.gjc"],
			startedAt: "2026-01-01T00:00:00.000Z",
		};
		await fs.mkdir(path.dirname(fixture.paths.intentRecord), { recursive: true });
		await Bun.write(fixture.paths.intentRecord, `${JSON.stringify(record, null, 2)}\n`);
		await expect(readIntent(fixture.paths.intentRecord)).rejects.toThrow(/escapes the agent directory/);
		// Missing any other trusted field is corruption too.
		const stripped = { ...record, provenancePath: fixture.paths.provenanceLedger };
		delete (stripped as Record<string, unknown>).startedAt;
		await Bun.write(fixture.paths.intentRecord, `${JSON.stringify(stripped, null, 2)}\n`);
		await expect(readIntent(fixture.paths.intentRecord)).rejects.toThrow(/startedAt/);
	});

	test("quarantine deletion is inode-guarded on the prune path (#4644 review r13)", async () => {
		const fixture = await makeFixture(lsOk("gjc"));
		await seedSkills(fixture.paths);
		await seedConfig(fixture.paths);
		await runPaseoSetup({}, fixture.deps);
		// Drop a skill from the source so the next install prunes the recorded
		// link through the quarantine path: the prune succeeds when the
		// quarantined object keeps its identity (the normal case the inode
		// guard must not break).
		await safeRm(path.join(fixture.paths.agentsSkillsDir as string, "paseo-loop"), { recursive: true });
		const result = await installSkillsBridge(await preflightSkillsBridge(fixture.deps));
		expect(result.prunedEntries).toContain("paseo-loop");
		await expect(fs.lstat(path.join(fixture.paths.bridgeDir, "paseo-loop"))).rejects.toMatchObject({
			code: "ENOENT",
		});
		// No quarantine residue is left behind.
		const residue = (await fs.readdir(fixture.paths.bridgeDir)).filter(name => name.includes("gjc-paseo-quarantine"));
		expect(residue).toEqual([]);
	});

	test("a recorded source under an arbitrary home subdirectory is refused (#4644 review r12)", async () => {
		const home = getTrustedHomeDir();
		const arbitrary = path.join(home, "not-a-paseo-location");
		const result = await isTrustedRecordedSkillsSource(arbitrary);
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.detail).toContain("not a location Paseo skills discovery could produce");
		// The discovery-equivalent roots still pass.
		expect((await isTrustedRecordedSkillsSource(path.join(home, ".agents", "skills"))).ok).toBe(true);
	});

	test("a replaced-provider sidecar for an absent key is removed and a failing deletion blocks removal (#4644 review r11)", async () => {
		const fixture = await makeFixture(lsOk("gjc"));
		await seedSkills(fixture.paths);
		const userEntry = { ...buildProviderEntry([process.execPath, "acp"]), label: "USER EDIT" };
		await seedConfig(fixture.paths, { gjc: userEntry });
		await runPaseoSetup({ force: true }, fixture.deps);
		// The user deletes GJC's entry by hand: removal cannot restore it, but
		// the sidecar must not survive as an orphaned credential file.
		const config = JSON.parse(await fs.readFile(fixture.paths.configJson, "utf8")) as Record<string, unknown>;
		delete (config.agents as { providers: Record<string, unknown> }).providers.gjc;
		await fs.writeFile(fixture.paths.configJson, serializeJson(config), { mode: 0o600 });

		const remove = await runPaseoSetup({ remove: true }, fixture.deps);
		expect(remove.kind).toBe("remove");
		if (remove.kind !== "remove") throw new Error("unreachable");
		expect(remove.result.outcome).toBe("removed");
		const leftovers = (await fs.readdir(path.dirname(fixture.paths.configJson))).filter(name =>
			name.includes("gjc-replaced"),
		);
		expect(leftovers).toEqual([]);
	});

	test("the default source-trust rule accepts trusted-home and override sources only (#4644 review r10)", async () => {
		const home = getTrustedHomeDir();
		expect(await isTrustedRecordedSkillsSource(path.join(home, ".agents", "skills"))).toEqual({ ok: true });
		expect(await isTrustedRecordedSkillsSource("skills")).toEqual({
			ok: false,
			detail: expect.stringContaining("not an absolute path") as unknown as string,
		});
		const outside = await isTrustedRecordedSkillsSource("/etc");
		expect(outside.ok).toBe(false);
	});

	test("directory ownership is a fact, not a plan: the creator bit lands only after exclusive creation (#4644 review r8)", async () => {
		const fixture = await makeFixture(lsOk("gjc"));
		await seedSkills(fixture.paths);
		await seedConfig(fixture.paths);
		await runPaseoSetup({}, fixture.deps);
		const ledger = await readProvenance(fixture.paths.provenanceLedger);
		// created:true is recorded only with the directory actually on disk.
		expect(ledger.bridgeDirCreated).toBe(true);
		expect(await fs.stat(fixture.paths.bridgeDir)).toBeDefined();

		// The concurrent-creator race between the preflight plan and the
		// exclusive mkdir: the directory appears after the preflight said
		// absent, so creation must refuse (EEXIST is never ignored) and the
		// foreign content stays untouched with no ownership recorded.
		const second = await makeFixture(lsOk("gjc"));
		await seedSkills(second.paths);
		await seedConfig(second.paths);
		const planned = await preflightSkillsBridge(second.deps);
		expect(planned.bridgeDirCreated).toBe(true);
		await fs.mkdir(second.paths.bridgeDir);
		await Bun.write(path.join(second.paths.bridgeDir, "paseo"), "user\n");
		await expect(installSkillsBridge(planned)).rejects.toBeInstanceOf(SkillsBridgeError);
		expect(await fs.readFile(path.join(second.paths.bridgeDir, "paseo"), "utf8")).toBe("user\n");
		await expect(fs.stat(second.paths.provenanceLedger)).rejects.toMatchObject({ code: "ENOENT" });
	});

	test("a tampered replaced-provider backup path never reads or deletes a foreign file (#4644 red-team)", async () => {
		const fixture = await makeFixture(lsOk("gjc"));
		await seedSkills(fixture.paths);
		const userEntry = { ...buildProviderEntry([process.execPath, "acp"]), label: "USER EDIT" };
		await seedConfig(fixture.paths, { gjc: userEntry });
		await runPaseoSetup({ force: true }, fixture.deps);

		// Tamper: the ledger pointer names an arbitrary absolute JSON file whose
		// key matches, so the restore would both write its content into
		// agents.providers and delete it after "restoring".
		const victim = path.join(fixture.root, "victim.json");
		const victimValue = { label: "ATTACKER" };
		await fs.writeFile(victim, `${JSON.stringify({ key: "gjc", value: victimValue }, null, 2)}\n`);
		const victimDigest = hashBytes(serializeJson(victimValue));
		const ledger = await readProvenance(fixture.paths.provenanceLedger);
		await writeProvenance(fixture.paths.provenanceLedger, {
			...ledger,
			providerReplacedEntries: { gjc: { backupPath: victim, valueSha256: victimDigest } },
		});

		const remove = await runPaseoSetup({ remove: true }, fixture.deps);
		if (remove.kind !== "remove") throw new Error("expected a remove outcome");
		expect(remove.result.outcome).toBe("partial-removal");
		if (remove.result.outcome === "partial-removal") {
			expect(remove.result.evidence.detail).toContain("unexpected path");
		}
		// The foreign file is intact and its content never reached the providers.
		expect(await fs.readFile(victim, "utf8")).toContain("ATTACKER");
		const after = JSON.parse(await fs.readFile(fixture.paths.configJson, "utf8")) as Record<string, unknown>;
		expect(JSON.stringify((after.agents as { providers: Record<string, unknown> }).providers)).not.toContain(
			"ATTACKER",
		);
	});

	test("a foreign in-root bridge-shaped sibling is refused even with a bridge basename (#4644 review r19)", async () => {
		const fixture = await makeFixture(lsOk("gjc"));
		await seedSkills(fixture.paths);
		await seedConfig(fixture.paths);
		await runPaseoSetup({}, fixture.deps);
		// A sibling directory with the bridge family basename holding user
		// content, plus a ledger aimed at it: removal must refuse (it is
		// neither the configured bridge nor an authenticated migration) and
		// the user content survives.
		const sibling = path.join(path.dirname(fixture.paths.bridgeDir), "fake-paseo-skills");
		await fs.mkdir(sibling, { recursive: true });
		await Bun.write(path.join(sibling, "user.txt"), "user content\n");
		const ledger = await readProvenance(fixture.paths.provenanceLedger);
		await writeProvenance(fixture.paths.provenanceLedger, { ...ledger, bridgePath: sibling });

		const remove = await runPaseoSetup({ remove: true }, fixture.deps);
		expect(remove.kind).toBe("remove");
		if (remove.kind !== "remove") throw new Error("unreachable");
		expect(remove.result.outcome).toBe("partial-removal");
		if (remove.result.outcome === "partial-removal") {
			expect(remove.result.evidence.detail).toContain("neither the configured bridge");
		}
		expect(await fs.readFile(path.join(sibling, "user.txt"), "utf8")).toBe("user content\n");
	});

	test("a migration root with a same-target replacement link fails identity authentication", async () => {
		const fixture = await makeFixture(lsOk("gjc"));
		await seedSkills(fixture.paths);
		await seedConfig(fixture.paths);
		await runPaseoSetup({}, fixture.deps);
		const oldLedger = await readProvenance(fixture.paths.provenanceLedger);
		const replacementRoot = path.join(path.dirname(fixture.paths.bridgeDir), "replacement-paseo-skills");
		await fs.mkdir(replacementRoot, { recursive: true });
		const name = SKILL_NAMES[0]!;
		await fs.symlink(path.join(fixture.paths.agentsSkillsDir as string, name), path.join(replacementRoot, name));
		await writeProvenance(fixture.paths.provenanceLedger, { ...oldLedger, bridgePath: replacementRoot });

		const remove = await runPaseoSetup({ remove: true }, fixture.deps);
		expect(remove.kind).toBe("remove");
		if (remove.kind !== "remove") throw new Error("expected a remove outcome");
		expect(remove.result.outcome).toBe("partial-removal");
		if (remove.result.outcome === "partial-removal") {
			expect(remove.result.evidence.detail).toMatch(/authenticated migration record|identity/);
		}
		await expect(fs.lstat(path.join(replacementRoot, name))).resolves.toBeDefined();
		await expect(fs.lstat(path.join(fixture.paths.bridgeDir, name))).resolves.toBeDefined();
	});

	test("a migration replaces the old custom-directory registration atomically (#4644 review r6)", async () => {
		const fixture = await makeFixture(lsOk("gjc"));
		await seedSkills(fixture.paths);
		await seedConfig(fixture.paths);
		await runPaseoSetup({}, fixture.deps);
		const oldDir = fixture.paths.bridgeDir;

		// The ledger stays in place; only the bridge path moves (a relocation
		// inside the same agent directory, where the ledger still records the
		// old path).
		const newBridge = path.join(path.dirname(oldDir), "relocated-paseo-skills");
		const migratedDeps: PaseoSetupDependencies = {
			...fixture.deps,
			paths: {
				...fixture.deps.paths,
				bridgeDir: newBridge,
			},
		};
		const install = await runPaseoSetup({}, migratedDeps);
		expect(install.kind).toBe("install");
		if (install.kind !== "install") throw new Error("expected an install outcome");
		expect(install.result.outcome).toBe("installed");

		// The new path is registered and the old one is gone in the same swap.
		const settings = await fs.readFile(path.join(process.env.GJC_CODING_AGENT_DIR ?? "", "config.yml"), "utf8");
		expect(settings).toContain(newBridge);
		expect(settings).not.toContain(oldDir);
		// The old bridge is cleaned after the durable cutover.
		for (const name of ["paseo", "paseo-advisor"]) {
			await expect(fs.lstat(path.join(oldDir, name))).rejects.toMatchObject({ code: "ENOENT" });
		}
	});

	test("an owned empty bridge migrates only with its recorded directory identity (#4644 P2)", async () => {
		const fixture = await makeFixture(lsOk("gjc"));
		await seedSkills(fixture.paths);
		await seedConfig(fixture.paths);
		await runPaseoSetup({}, fixture.deps);
		const oldDir = fixture.paths.bridgeDir;
		const beforeEmpty = await readProvenance(fixture.paths.provenanceLedger);
		expect(beforeEmpty.bridgeDirCreated).toBe(true);
		expect(beforeEmpty.bridgeDirIdentity).toBeDefined();

		// Convergence prunes the final links but retains ownership of the
		// directory itself. The next migration must use that directory identity
		// to replace the old settings registration and remove only this directory.
		for (const name of SKILL_NAMES) {
			await safeRm(path.join(fixture.paths.agentsSkillsDir as string, name), { recursive: true });
		}
		const emptied = await runPaseoSetup({}, fixture.deps);
		expect(emptied.kind).toBe("install");
		if (emptied.kind !== "install") throw new Error("expected an install outcome");
		expect(emptied.result.outcome).toBe("installed");
		const emptyLedger = await readProvenance(fixture.paths.provenanceLedger);
		expect(emptyLedger.bridgePath).toBe(oldDir);
		expect(emptyLedger.bridgeEntries).toEqual([]);
		expect(emptyLedger.bridgeDirCreated).toBe(true);
		expect(emptyLedger.bridgeDirIdentity).toEqual(beforeEmpty.bridgeDirIdentity);

		await seedSkills(fixture.paths);
		const newBridge = path.join(path.dirname(oldDir), "owned-empty-relocated-paseo-skills");
		const migratedDeps: PaseoSetupDependencies = {
			...fixture.deps,
			paths: { ...fixture.deps.paths, bridgeDir: newBridge },
		};
		const install = await runPaseoSetup({}, migratedDeps);
		expect(install.kind).toBe("install");
		if (install.kind !== "install") throw new Error("expected an install outcome");
		expect(install.result.outcome).toBe("installed");

		const settings = await fs.readFile(path.join(process.env.GJC_CODING_AGENT_DIR ?? "", "config.yml"), "utf8");
		expect(settings).toContain(newBridge);
		expect(settings).not.toContain(oldDir);
		await expect(fs.stat(oldDir)).rejects.toMatchObject({ code: "ENOENT" });
		const ledger = await readProvenance(fixture.paths.provenanceLedger);
		expect(ledger.bridgePath).toBe(newBridge);
		expect(ledger.bridgeEntries).toEqual(SKILL_NAMES);
	});

	test("a source-less bridge-path migration preserves the current bridge and registration before an occupied destination (#4644 exact-head P2)", async () => {
		const fixture = await makeFixture(lsOk("gjc"));
		await seedSkills(fixture.paths);
		await seedConfig(fixture.paths);
		await runPaseoSetup({}, fixture.deps);
		const oldDir = fixture.paths.bridgeDir;
		const settingsPath = path.join(process.env.GJC_CODING_AGENT_DIR ?? "", "config.yml");
		const beforeBridge = await snapshotTree(oldDir);
		const beforeLedger = await fs.readFile(fixture.paths.provenanceLedger, "utf8");
		const beforeSettings = await fs.readFile(settingsPath, "utf8");
		const newBridge = path.join(path.dirname(oldDir), "source-less-relocated-paseo-skills");
		const migratedDeps: PaseoSetupDependencies = {
			...fixture.deps,
			paths: { ...fixture.paths, bridgeDir: newBridge },
			skillsSource: async () => undefined,
		};
		const check = await runPaseoSetup({ check: true }, migratedDeps);
		if (check.kind !== "check") throw new Error("expected a check outcome");
		expect(check.result.reasons.map(reason => reason.code)).toContain("missing-skills-directory");
		await fs.writeFile(newBridge, "foreign destination\n");

		const install = await runPaseoSetup({}, migratedDeps);
		expect(install.kind).toBe("install");
		if (install.kind !== "install") throw new Error("expected an install outcome");
		expect(install.result.outcome).toBe("partial-install");
		if (install.result.outcome !== "partial-install") throw new Error("expected a partial install outcome");
		expect(install.result.evidence.detail).toContain("no resolved Paseo skills source is available");
		expect(install.result.evidence.retained).toContain(oldDir);

		expect(await snapshotTree(oldDir)).toBe(beforeBridge);
		expect(await fs.readFile(fixture.paths.provenanceLedger, "utf8")).toBe(beforeLedger);
		expect(await fs.readFile(settingsPath, "utf8")).toBe(beforeSettings);
		expect(await fs.readFile(newBridge, "utf8")).toBe("foreign destination\n");
	});

	test("an empty resolved source refuses migration to an absent bridge path (#4644 exact-head P2)", async () => {
		const fixture = await makeFixture(lsOk("gjc"));
		await seedSkills(fixture.paths);
		await seedConfig(fixture.paths);
		await runPaseoSetup({}, fixture.deps);
		const oldDir = fixture.paths.bridgeDir;
		const settingsPath = path.join(process.env.GJC_CODING_AGENT_DIR ?? "", "config.yml");
		const beforeBridge = await snapshotTree(oldDir);
		const beforeLedger = await fs.readFile(fixture.paths.provenanceLedger, "utf8");
		const beforeSettings = await fs.readFile(settingsPath, "utf8");
		for (const name of SKILL_NAMES) {
			await safeRm(path.join(fixture.paths.agentsSkillsDir as string, name), { recursive: true });
		}
		const newBridge = path.join(path.dirname(oldDir), "empty-relocated-paseo-skills");
		const migratedDeps: PaseoSetupDependencies = {
			...fixture.deps,
			paths: { ...fixture.paths, bridgeDir: newBridge },
			skillsSource: async () => ({ dir: fixture.paths.agentsSkillsDir as string, origin: "user" }),
		};

		const install = await runPaseoSetup({}, migratedDeps);
		expect(install.kind).toBe("install");
		if (install.kind !== "install") throw new Error("expected an install outcome");
		expect(install.result.outcome).toBe("partial-install");
		if (install.result.outcome !== "partial-install") throw new Error("expected a partial install outcome");
		expect(install.result.evidence.detail).toContain("contains no bridgeable skills");
		expect(install.result.evidence.retained).toContain(oldDir);

		expect(await snapshotTree(oldDir)).toBe(beforeBridge);
		expect(await fs.readFile(fixture.paths.provenanceLedger, "utf8")).toBe(beforeLedger);
		expect(await fs.readFile(settingsPath, "utf8")).toBe(beforeSettings);
		await expect(fs.stat(newBridge)).rejects.toMatchObject({ code: "ENOENT" });
	});

	test("a partial old-bridge cleanup restores completed removals before saga rollback (#4644 Codex P2)", async () => {
		const fixture = await makeFixture(lsOk("gjc"));
		await seedSkills(fixture.paths);
		await seedConfig(fixture.paths);
		await runPaseoSetup({}, fixture.deps);
		const oldDir = fixture.paths.bridgeDir;
		const beforeLedger = await readProvenance(fixture.paths.provenanceLedger);
		const beforeLinks: Record<string, string> = {};
		for (const name of SKILL_NAMES) beforeLinks[name] = await fs.readlink(path.join(oldDir, name));

		const newDir = path.join(path.dirname(oldDir), "partially-failed-paseo-skills");
		const migratedDeps: PaseoSetupDependencies = {
			...fixture.deps,
			paths: { ...fixture.deps.paths, bridgeDir: newDir },
		};

		// The migration captures the old links before the settings cutover. Fail
		// the second unlink syscall after the first one succeeds, then assert the
		// pre-cutover bridge, registration, and ledger are all restored.
		let cleanupStarted = false;
		let oldBridgeReadlinks = 0;
		const originalReadlink = fs.readlink.bind(fs);
		const readlink = spyOn(fs, "readlink").mockImplementation((async target => {
			const value = await originalReadlink(target, "utf8");
			if (cleanupStarted && String(target).startsWith(`${oldDir}${path.sep}`)) {
				oldBridgeReadlinks += 1;
				if (oldBridgeReadlinks === SKILL_NAMES.length + 2) {
					throw new Error("simulated old bridge unlink failure");
				}
			}
			return value;
		}) as typeof fs.readlink);
		const realSettingsInit = Settings.init.bind(Settings);
		let settingsCommit: { mockRestore(): void } | undefined;
		const settingsInit = spyOn(Settings, "init").mockImplementation(async options => {
			const settings = await realSettingsInit(options);
			const commit = settings.commitAtomicBatchWithCurrent.bind(settings);
			settingsCommit = spyOn(settings, "commitAtomicBatchWithCurrent").mockImplementation(async buildPatches => {
				const receipt = await commit(buildPatches);
				cleanupStarted = true;
				return receipt;
			});
			return settings;
		});
		try {
			const install = await runPaseoSetup({}, migratedDeps);
			expect(install.kind).toBe("install");
			if (install.kind !== "install") throw new Error("expected an install outcome");
			expect(install.result.outcome).toBe("partial-install");
			for (const name of SKILL_NAMES) {
				expect(await fs.readlink(path.join(oldDir, name))).toBe(beforeLinks[name]);
			}
			const afterLedger = await readProvenance(fixture.paths.provenanceLedger);
			const restoredIdentities = Object.fromEntries(
				await Promise.all(
					SKILL_NAMES.map(async name => {
						const stat = await fs.lstat(path.join(oldDir, name), { bigint: true });
						return [
							name,
							{
								dev: stat.dev.toString(),
								ino: stat.ino.toString(),
								size: stat.size.toString(),
								mtimeNs: stat.mtimeNs.toString(),
							},
						];
					}),
				),
			) as Record<string, BridgeEntryIdentity>;
			// The provider step may retain its convergence marker for an identical
			// existing entry; migration compensation is responsible for restoring
			// the old bridge facts, not erasing unrelated provider provenance. A
			// recreated link carries a fresh inode identity, so the restored ledger
			// must match the live links rather than the stale pre-cutover identities.
			expect({
				bridgePath: afterLedger.bridgePath,
				bridgeSourceDir: afterLedger.bridgeSourceDir,
				bridgeEntries: afterLedger.bridgeEntries,
				bridgeEntryIdentities: afterLedger.bridgeEntryIdentities,
				bridgeDirCreated: afterLedger.bridgeDirCreated,
				bridgeDirIdentity: afterLedger.bridgeDirIdentity,
			}).toEqual({
				bridgePath: beforeLedger.bridgePath,
				bridgeSourceDir: beforeLedger.bridgeSourceDir,
				bridgeEntries: beforeLedger.bridgeEntries,
				bridgeEntryIdentities: restoredIdentities,
				bridgeDirCreated: beforeLedger.bridgeDirCreated,
				bridgeDirIdentity: beforeLedger.bridgeDirIdentity,
			});
			await expect(fs.stat(newDir)).rejects.toMatchObject({ code: "ENOENT" });
			const settings = await fs.readFile(path.join(process.env.GJC_CODING_AGENT_DIR ?? "", "config.yml"), "utf8");
			expect(settings).toContain(oldDir);
			expect(settings).not.toContain(newDir);
		} finally {
			settingsCommit?.mockRestore();
			settingsInit.mockRestore();
			readlink.mockRestore();
		}
	});

	test("migration compensation records the identity of a recreated old root", async () => {
		const fixture = await makeFixture(lsOk("gjc"));
		await seedSkills(fixture.paths);
		await seedConfig(fixture.paths);
		const initial = await runPaseoSetup({}, fixture.deps);
		expect(initial.kind).toBe("install");
		const oldDir = fixture.paths.bridgeDir;
		const before = await readProvenance(fixture.paths.provenanceLedger);
		const originalRoot = await fs.lstat(oldDir, { bigint: true });
		const newDir = path.join(path.dirname(oldDir), "recreated-root-compensation-paseo-skills");
		const migratedDeps: PaseoSetupDependencies = {
			...fixture.deps,
			paths: { ...fixture.paths, bridgeDir: newDir },
		};
		let injected = false;
		const realRm = fs.rm.bind(fs);
		const remove = spyOn(fs, "rm").mockImplementation(async (target, options) => {
			if (!injected && String(target) === fixture.paths.intentRecord) {
				const oldRoot = await fs.lstat(oldDir).catch(() => undefined);
				const newRoot = await fs.lstat(newDir).catch(() => undefined);
				if (oldRoot === undefined && newRoot !== undefined) {
					injected = true;
					throw new Error("simulated crash after old bridge detach");
				}
			}
			return realRm(target, options);
		});
		try {
			const failed = await runPaseoSetup({}, migratedDeps);
			expect(failed.kind).toBe("install");
			if (failed.kind !== "install") throw new Error("expected an install outcome");
			expect(failed.result.outcome).toBe("partial-install");
			expect(injected).toBe(true);
			const restoredRoot = await fs.lstat(oldDir, { bigint: true });
			const after = await readProvenance(fixture.paths.provenanceLedger);
			expect(restoredRoot.ino).not.toBe(originalRoot.ino);
			expect(after.bridgePath).toBe(before.bridgePath);
			expect(after.bridgeDirIdentity?.ino).toBe(restoredRoot.ino.toString());
			expect(after.bridgeDirIdentity?.dev).toBe(restoredRoot.dev.toString());
			await expect(fs.stat(newDir)).rejects.toMatchObject({ code: "ENOENT" });
		} finally {
			remove.mockRestore();
		}
	});

	test("migration compensation retains conflict when the recreated old root swaps after the final link", async () => {
		const fixture = await makeFixture(lsOk("gjc"));
		await seedSkills(fixture.paths);
		await seedConfig(fixture.paths);
		const initial = await runPaseoSetup({}, fixture.deps);
		expect(initial.kind).toBe("install");
		const oldDir = fixture.paths.bridgeDir;
		const before = await readProvenance(fixture.paths.provenanceLedger);
		const originalRoot = await fs.lstat(oldDir, { bigint: true });
		const newDir = path.join(path.dirname(oldDir), "swapped-final-link-paseo-skills");
		const migratedDeps: PaseoSetupDependencies = {
			...fixture.deps,
			paths: { ...fixture.paths, bridgeDir: newDir },
		};
		let swapped = false;
		const originalLstat = fs.lstat.bind(fs);
		const inspect = spyOn(fs, "lstat").mockImplementation((async (
			target: nodeFs.PathLike,
			options?: nodeFs.StatOptions,
		) => {
			if (!swapped && String(target) === oldDir) {
				const observed = (await originalLstat(target, options)) as nodeFs.BigIntStats;
				if (observed.ino !== originalRoot.ino) {
					const present = await fs.readdir(oldDir);
					if (present.length === SKILL_NAMES.length) {
						swapped = true;
						await fs.rename(oldDir, `${oldDir}.successor`);
						await fs.mkdir(oldDir);
						await fs.writeFile(path.join(oldDir, "foreign"), "foreign\n");
						return originalLstat(target, options);
					}
				}
				return observed;
			}
			return originalLstat(target, options);
		}) as unknown as typeof fs.lstat);
		try {
			const failed = await runPaseoSetup({}, migratedDeps);
			expect(failed.kind).toBe("install");
			if (failed.kind !== "install") throw new Error("expected an install outcome");
			expect(failed.result.outcome).toBe("partial-install");
			expect(swapped).toBe(true);
			expect(await fs.readFile(path.join(oldDir, "foreign"), "utf8")).toBe("foreign\n");
			const successorRoot = await originalLstat(`${oldDir}.successor`, { bigint: true });
			const after = await readProvenance(fixture.paths.provenanceLedger);
			expect(after.bridgePath).toBe(before.bridgePath);
			expect(after.bridgeDirIdentity?.ino).toBe(successorRoot.ino.toString());
			expect(await fs.readlink(path.join(`${oldDir}.successor`, SKILL_NAMES[0]!))).toBe(
				path.join(fixture.paths.agentsSkillsDir as string, SKILL_NAMES[0]!),
			);
		} finally {
			inspect.mockRestore();
		}
	});

	test("migration compensation refuses a replacement old bridge directory", async () => {
		const fixture = await makeFixture(lsOk("gjc"));
		await seedSkills(fixture.paths);
		await seedConfig(fixture.paths);
		await runPaseoSetup({}, fixture.deps);
		const oldDir = fixture.paths.bridgeDir;
		const newDir = path.join(path.dirname(oldDir), "replacement-race-paseo-skills");
		const migratedDeps: PaseoSetupDependencies = {
			...fixture.deps,
			paths: { ...fixture.paths, bridgeDir: newDir },
		};
		let cleanupStarted = false;
		let replaced = false;
		const originalReadlink = fs.readlink.bind(fs);
		const readlink = spyOn(fs, "readlink").mockImplementation((async target => {
			const value = await originalReadlink(target, "utf8");
			if (!cleanupStarted || replaced || String(target) !== path.join(oldDir, SKILL_NAMES[0]!)) return value;
			replaced = true;
			await fs.rename(oldDir, `${oldDir}.replacement`);
			await fs.mkdir(oldDir);
			await fs.writeFile(path.join(oldDir, "foreign"), "user content\n");
			return value;
		}) as typeof fs.readlink);
		const realSettingsInit = Settings.init.bind(Settings);
		let settingsCommit: { mockRestore(): void } | undefined;
		const settingsInit = spyOn(Settings, "init").mockImplementation(async options => {
			const settings = await realSettingsInit(options);
			const commit = settings.commitAtomicBatchWithCurrent.bind(settings);
			settingsCommit = spyOn(settings, "commitAtomicBatchWithCurrent").mockImplementation(async buildPatches => {
				const receipt = await commit(buildPatches);
				cleanupStarted = true;
				return receipt;
			});
			return settings;
		});
		try {
			const install = await runPaseoSetup({}, migratedDeps);
			expect(install.kind).toBe("install");
			if (install.kind !== "install") throw new Error("expected an install outcome");
			expect(install.result.outcome).toBe("partial-install");
			expect(replaced).toBe(true);
			expect(await fs.readFile(path.join(oldDir, "foreign"), "utf8")).toBe("user content\n");
			await expect(fs.lstat(path.join(oldDir, SKILL_NAMES[0]!))).rejects.toMatchObject({ code: "ENOENT" });
		} finally {
			settingsCommit?.mockRestore();
			settingsInit.mockRestore();
			readlink.mockRestore();
		}
	});

	test("a tampered ledger path refuses removal before any settings mutation (#4644 review r6)", async () => {
		const fixture = await makeFixture(lsOk("gjc"));
		await seedSkills(fixture.paths);
		await seedConfig(fixture.paths);
		await runPaseoSetup({}, fixture.deps);

		const victimDir = path.join(fixture.root, "victim");
		await fs.mkdir(victimDir, { recursive: true });
		await fs.symlink(path.join(fixture.paths.agentsSkillsDir as string, "paseo"), path.join(victimDir, "paseo"));
		const ledger = await readProvenance(fixture.paths.provenanceLedger);
		await writeProvenance(fixture.paths.provenanceLedger, { ...ledger, bridgePath: victimDir });

		const settingsBefore = await snapshotTree(path.dirname(fixture.paths.provenanceLedger));
		const remove = await runPaseoSetup({ remove: true }, fixture.deps);
		if (remove.kind !== "remove") throw new Error("expected a remove outcome");
		expect(remove.result.outcome).toBe("partial-removal");
		// The registration and provider entries were NOT touched: validation
		// failed before any settings mutation.
		const config = JSON.parse(await fs.readFile(fixture.paths.configJson, "utf8")) as Record<string, unknown>;
		const providers = (config.agents as { providers: Record<string, unknown> }).providers;
		expect(providers.gjc).toBeDefined();
		expect(await snapshotTree(path.dirname(fixture.paths.provenanceLedger))).toBe(settingsBefore);
	});

	test("a resolved source replaced by a regular file refuses instead of pruning (#4644 review r6)", async () => {
		const fixture = await makeFixture(lsOk("gjc"));
		await seedSkills(fixture.paths);
		await seedConfig(fixture.paths);
		await runPaseoSetup({}, fixture.deps);
		const before = await snapshotTree(fixture.paths.bridgeDir);

		// An app update replaces the skills directory with a file.
		await safeRm(fixture.paths.agentsSkillsDir as string, { recursive: true, force: true });
		await fs.writeFile(fixture.paths.agentsSkillsDir as string, "not a directory\n");
		const deps: PaseoSetupDependencies = {
			...fixture.deps,
			skillsSource: async () => ({ dir: fixture.paths.agentsSkillsDir as string, origin: "user" }),
		};

		await expect(runPaseoSetup({}, deps)).rejects.toBeInstanceOf(SkillsBridgeError);
		expect(await snapshotTree(fixture.paths.bridgeDir)).toBe(before);
	});

	test("a convergence over an owned empty bridge preserves its provenance and registration (#4644 review r6)", async () => {
		const fixture = await makeFixture(lsOk("gjc"));
		await seedSkills(fixture.paths);
		await seedConfig(fixture.paths);
		await runPaseoSetup({}, fixture.deps);
		for (const name of [...SKILL_NAMES]) {
			await safeRm(path.join(fixture.paths.agentsSkillsDir as string, name), { recursive: true });
		}
		// First convergence: entries pruned, directory GJC-created and owned.
		await runPaseoSetup({}, fixture.deps);
		let ledger = await readProvenance(fixture.paths.provenanceLedger);
		expect(ledger.bridgeDirCreated).toBe(true);

		// Second convergence over the still-empty source must NOT discard the
		// ownership record: the directory and its registration stay removable.
		await runPaseoSetup({}, fixture.deps);
		ledger = await readProvenance(fixture.paths.provenanceLedger);
		expect(ledger.bridgeDirCreated).toBe(true);
		expect(ledger.bridgePath).toBe(fixture.paths.bridgeDir);

		const remove = await runPaseoSetup({ remove: true }, fixture.deps);
		if (remove.kind !== "remove") throw new Error("expected a remove outcome");
		expect(remove.result.outcome).toBe("removed");
		await expect(fs.stat(fixture.paths.bridgeDir)).rejects.toMatchObject({ code: "ENOENT" });
	});
	test("remove after every entry was pruned still cleans the recorded-created empty bridge (#4644 review r4)", async () => {
		const fixture = await makeFixture(lsOk("gjc"));
		await seedSkills(fixture.paths);
		await seedConfig(fixture.paths);
		await runPaseoSetup({}, fixture.deps);
		// A Paseo release drops EVERY skill: convergence prunes the final entry
		// and leaves `bridgeEntries: []` with `bridgeDirCreated: true`.
		for (const name of [...SKILL_NAMES]) {
			await safeRm(path.join(fixture.paths.agentsSkillsDir as string, name), { recursive: true });
		}
		const converged = await runPaseoSetup({}, fixture.deps);
		expect(converged.kind).toBe("install");
		const ledger = await readProvenance(fixture.paths.provenanceLedger);
		expect(ledger.bridgeEntries).toEqual([]);
		expect(ledger.bridgeDirCreated).toBe(true);
		// The empty directory GJC created must not be stranded.
		const remove = await runPaseoSetup({ remove: true }, fixture.deps);
		if (remove.kind !== "remove") throw new Error("expected a remove outcome");
		expect(remove.result.outcome).toBe("removed");
		await expect(fs.stat(fixture.paths.bridgeDir)).rejects.toMatchObject({ code: "ENOENT" });
	});
	test("empty bridge removal never pathname-removes a successor (#4644 exact-head P2)", async () => {
		const fixture = await makeFixture(lsOk("gjc"));
		await seedSkills(fixture.paths);
		await seedConfig(fixture.paths);
		await runPaseoSetup({}, fixture.deps);
		for (const name of [...SKILL_NAMES]) {
			await safeRm(path.join(fixture.paths.agentsSkillsDir as string, name), { recursive: true });
		}
		await runPaseoSetup({}, fixture.deps);

		const realRmdir = fs.rmdir.bind(fs);
		const rmdir = spyOn(fs, "rmdir").mockImplementation(async target => {
			if (target === fixture.paths.bridgeDir) {
				// The old split identity-check plus pathname rmdir would delete this
				// empty successor after the replacement is published.
				const retained = `${fixture.paths.bridgeDir}.owned`;
				await fs.rename(target, retained);
				await fs.mkdir(target);
			}
			return realRmdir(target);
		});
		try {
			const remove = await runPaseoSetup({ remove: true }, fixture.deps);
			if (remove.kind !== "remove") throw new Error("expected a remove outcome");
			expect(remove.result.outcome).toBe("removed");
			expect(rmdir).not.toHaveBeenCalledWith(fixture.paths.bridgeDir);
			await expect(fs.stat(fixture.paths.bridgeDir)).rejects.toMatchObject({ code: "ENOENT" });
		} finally {
			rmdir.mockRestore();
		}
	});

	test("remove-reinstall-remove finalizes scrubbed roots in native code", async () => {
		const fixture = await makeFixture(lsOk("gjc"));
		await seedSkills(fixture.paths);
		await seedConfig(fixture.paths);
		await runPaseoSetup({}, fixture.deps);
		for (const name of [...SKILL_NAMES]) {
			await safeRm(path.join(fixture.paths.agentsSkillsDir as string, name), { recursive: true });
		}
		await runPaseoSetup({}, fixture.deps);

		const removingPath = `${fixture.paths.bridgeDir}.removing`;
		const rmdir = spyOn(fs, "rmdir");
		try {
			const first = await runPaseoSetup({ remove: true }, fixture.deps);
			expect(first.kind).toBe("remove");
			if (first.kind !== "remove") throw new Error("expected a remove outcome");
			expect(first.result.outcome).toBe("removed");
			expect((await readProvenance(fixture.paths.provenanceLedger)).bridgeCleanupPending).toBeUndefined();
			await expect(fs.stat(removingPath)).rejects.toMatchObject({ code: "ENOENT" });
			await expect(fs.stat(fixture.paths.bridgeDir)).rejects.toMatchObject({ code: "ENOENT" });

			// Reinstall and remove again; the native finalizer never delegates the
			// identity-bound detached-root deletion to pathname-only fs.rmdir.
			await seedSkills(fixture.paths);
			const reinstall = await runPaseoSetup({}, fixture.deps);
			expect(reinstall.kind).toBe("install");
			if (reinstall.kind !== "install") throw new Error("expected an install outcome");
			expect(reinstall.result.outcome).toBe("installed");
			const second = await runPaseoSetup({ remove: true }, fixture.deps);
			expect(second.kind).toBe("remove");
			if (second.kind !== "remove") throw new Error("expected a remove outcome");
			expect(second.result.outcome).toBe("removed");
			await expect(fs.stat(removingPath)).rejects.toMatchObject({ code: "ENOENT" });
			await expect(fs.stat(fixture.paths.bridgeDir)).rejects.toMatchObject({ code: "ENOENT" });
			expect(await readProvenance(fixture.paths.provenanceLedger)).toEqual({
				version: 1,
				providerKeys: {},
				providerPreexistingKeys: {},
				providerReplacedEntries: {},
				seededOrchestrationKeys: {},
			});
			expect(rmdir).not.toHaveBeenCalled();
		} finally {
			rmdir.mockRestore();
		}
	});

	test("a tampered ledger bridge path never drives destructive removal (#4644 review r4)", async () => {
		const fixture = await makeFixture();
		await seedSkills(fixture.paths);
		await installWithLedger(fixture.deps);
		// Tamper: the ledger points outside the agent directory at a directory
		// holding a foreign link with a matching name.
		const victimDir = path.join(fixture.root, "victim");
		await fs.mkdir(victimDir, { recursive: true });
		await fs.symlink(path.join(fixture.paths.agentsSkillsDir as string, "paseo"), path.join(victimDir, "paseo"));
		const ledger = await readProvenance(fixture.paths.provenanceLedger);
		await writeProvenance(fixture.paths.provenanceLedger, { ...ledger, bridgePath: victimDir });

		const result = await removePaseoSetup(fixture.deps, { now: new Date() });
		expect(result.outcome).toBe("partial-removal");
		if (result.outcome !== "partial-removal") throw new Error("unreachable");
		expect(result.evidence.detail).toMatch(/escapes the agent directory|does not carry the bridge directory name/);
		// The foreign link is untouched.
		expect((await fs.lstat(path.join(victimDir, "paseo"))).isSymbolicLink()).toBe(true);
	});

	test("a ledger bridge path that is a symlink is refused before removal (#4644 review r4)", async () => {
		const fixture = await makeFixture();
		await seedSkills(fixture.paths);
		await installWithLedger(fixture.deps);
		const real = path.join(fixture.root, "real-bridge");
		await fs.mkdir(real, { recursive: true });
		await fs.symlink(real, path.join(fixture.root, "agentdir", "paseo-skills-link"));
		const ledger = await readProvenance(fixture.paths.provenanceLedger);
		await writeProvenance(fixture.paths.provenanceLedger, {
			...ledger,
			bridgePath: path.join(fixture.root, "agentdir", "paseo-skills-link"),
		});

		const result = await removePaseoSetup(fixture.deps, { now: new Date() });
		expect(result.outcome).toBe("partial-removal");
		if (result.outcome !== "partial-removal") throw new Error("unreachable");
		expect(result.evidence.detail).toMatch(/symlink|does not carry the bridge directory name/);
	});

	test("a ledger path through a symlinked ancestor resolves outside and is refused (#4644 review r7)", async () => {
		const fixture = await makeFixture();
		await seedSkills(fixture.paths);
		await installWithLedger(fixture.deps);
		// A canonically spelled record INSIDE the agent directory whose ancestor
		// is a symlink: `lstat` on the final component alone accepts it, but the
		// fully resolved location is an unrelated directory holding a foreign
		// link with a matching name.
		const evil = path.join(fixture.root, "evil");
		await fs.mkdir(evil, { recursive: true });
		await fs.symlink(evil, path.join(path.dirname(fixture.paths.bridgeDir), "ancestor-link"));
		const recorded = path.join(path.dirname(fixture.paths.bridgeDir), "ancestor-link", "paseo-skills");
		await fs.mkdir(recorded, { recursive: true });
		await fs.symlink(path.join(fixture.paths.agentsSkillsDir as string, "paseo"), path.join(recorded, "paseo"));
		const ledger = await readProvenance(fixture.paths.provenanceLedger);
		await writeProvenance(fixture.paths.provenanceLedger, { ...ledger, bridgePath: recorded });

		const result = await removePaseoSetup(fixture.deps, { now: new Date() });
		expect(result.outcome).toBe("partial-removal");
		if (result.outcome !== "partial-removal") throw new Error("unreachable");
		expect(result.evidence.detail).toMatch(
			/resolves outside the agent directory|neither the configured bridge .* nor an authenticated migration record/,
		);
		// The foreign link in the redirected directory is untouched.
		expect((await fs.lstat(path.join(recorded, "paseo"))).isSymbolicLink()).toBe(true);
	});

	test("a recorded entry replaced by a regular file is a divergence, not silent success (#4644 review r4)", async () => {
		const fixture = await makeFixture();
		await seedSkills(fixture.paths);
		await installWithLedger(fixture.deps);
		// The user replaces a bridged name with their own regular file.
		await safeRm(path.join(fixture.paths.bridgeDir, "paseo"));
		await fs.writeFile(path.join(fixture.paths.bridgeDir, "paseo"), "user data\n");

		const result = await removePaseoSetup(fixture.deps, { now: new Date() });
		expect(result.outcome).toBe("partial-removal");
		// The user's file survives and the provenance is retained.
		expect(await fs.readFile(path.join(fixture.paths.bridgeDir, "paseo"), "utf8")).toBe("user data\n");
		const ledger = await readProvenance(fixture.paths.provenanceLedger);
		expect(ledger.bridgeEntries).toContain("paseo");
	});

	test("no resolved source and no ownership record refuses to register the bridge (#4644 review r4)", async () => {
		const fixture = await makeFixture(lsOk("gjc"));
		await seedConfig(fixture.paths);
		// A stale foreign bridge directory exists; no source resolves and no
		// ledger records ownership of it.
		await fs.mkdir(fixture.paths.bridgeDir, { recursive: true });
		await fs.writeFile(path.join(fixture.paths.bridgeDir, "paseo-foreign"), "stale\n");
		const deps: PaseoSetupDependencies = {
			...fixture.deps,
			skillsSource: async () => undefined,
		};

		const install = await runPaseoSetup({}, deps);
		expect(install.kind).toBe("install");
		if (install.kind !== "install") throw new Error("unreachable");
		expect(install.result.outcome).toBe("partial-install");
		if (install.result.outcome === "partial-install") {
			expect(install.result.evidence.detail).toContain("Refusing to register");
		}
		// The stale bridge content was never touched.
		expect(await fs.readFile(path.join(fixture.paths.bridgeDir, "paseo-foreign"), "utf8")).toBe("stale\n");
	});

	test("no source and no bridge directory completes the provider install without the bridge (#4644 review r7)", async () => {
		const fixture = await makeFixture(lsOk("gjc"));
		await seedConfig(fixture.paths);
		const deps: PaseoSetupDependencies = {
			...fixture.deps,
			skillsSource: async () => undefined,
		};

		const install = await runPaseoSetup({}, deps);
		expect(install.kind).toBe("install");
		if (install.kind !== "install") throw new Error("unreachable");
		// Paseo not being installed is not a failed GJC provider install: the
		// provider entry and orchestration roles stand, the bridge is skipped,
		// and nothing is registered (there is no directory to load).
		expect(install.result.outcome).toBe("installed");
		if (install.result.outcome !== "installed") throw new Error("unreachable");
		expect(install.result.changed).toContain("paseo skills bridge (no source)");
		const after = JSON.parse(await fs.readFile(fixture.paths.configJson, "utf8")) as Record<string, unknown>;
		expect(providersOf(after).gjc).toBeDefined();
		await expect(fs.stat(fixture.paths.bridgeDir)).rejects.toMatchObject({ code: "ENOENT" });

		// Check still reports the missing source honestly.
		const check = await runPaseoSetup({ check: true }, deps);
		if (check.kind !== "check") throw new Error("expected a check outcome");
		expect(check.result.reasons.map(reason => reason.code)).toContain("missing-skills-directory");
	});

	test("a config.json edit between preflight and publish refuses instead of using stale ownership (#4644 review r7)", async () => {
		const fixture = await makeFixture(lsOk("gjc"));
		await seedSkills(fixture.paths);
		await seedConfig(fixture.paths);
		let mutated = false;
		const deps: PaseoSetupDependencies = {
			...fixture.deps,
			// The bridge preflight runs AFTER config.json was read for ownership
			// decisions: a user edit landing in that window must refuse rather
			// than publish provider ownership computed from the older bytes.
			skillsSource: async () => {
				if (!mutated) {
					mutated = true;
					await fs.writeFile(
						fixture.paths.configJson,
						serializeJson({ agents: { providers: { claude: { enabled: true }, gjc: "user scalar" } } }),
						"utf8",
					);
				}
				return { dir: fixture.paths.agentsSkillsDir as string, origin: "user" };
			},
		};

		const install = await runPaseoSetup({}, deps);
		expect(install.kind).toBe("install");
		if (install.kind !== "install") throw new Error("unreachable");
		expect(install.result.outcome).toBe("partial-install");
		if (install.result.outcome === "partial-install") {
			expect(install.result.evidence.detail).toContain("changed after setup inspected it");
		}
		// The user's concurrent bytes are intact and were never claimed.
		const after = JSON.parse(await fs.readFile(fixture.paths.configJson, "utf8")) as Record<string, unknown>;
		expect(providersOf(after).gjc).toBe("user scalar");
		const ledger = await readProvenance(fixture.paths.provenanceLedger);
		expect(ledger.providerKeys.gjc).toBeUndefined();
	});

	test("a symlinked source skill directory is bridged after resolution (#4644 review r4)", async () => {
		const fixture = await makeFixture();
		const realSkill = path.join(fixture.root, "real-skills", "paseo-linked");
		await fs.mkdir(realSkill, { recursive: true });
		await Bun.write(path.join(realSkill, "SKILL.md"), "# real\n");
		// The source directory contains a SYMLINK to a skill directory.
		await fs.symlink(realSkill, path.join(fixture.paths.agentsSkillsDir as string, "paseo-linked"));
		// And a dangling symlink of the same shape is not bridged.
		await fs.symlink(
			path.join(fixture.root, "gone"),
			path.join(fixture.paths.agentsSkillsDir as string, "paseo-dangling"),
		);

		const preflight = await preflightSkillsBridge(fixture.deps);
		const names = [...Object.keys(preflight.entries)];
		expect(names).toContain("paseo-linked");
		expect(names).not.toContain("paseo-dangling");
	});

	test("a bridge-path migration cleans the old directory and never inherits its names (#4644 review r4)", async () => {
		const fixture = await makeFixture(lsOk("gjc"));
		await seedSkills(fixture.paths);
		await seedConfig(fixture.paths);
		await runPaseoSetup({}, fixture.deps);
		const oldDir = fixture.paths.bridgeDir;
		const oldLedger = await readProvenance(fixture.paths.provenanceLedger);

		// The agent dir moves; a USER link already sits at the new path.
		const newBridge = path.join(fixture.root, "agentdir-new", "paseo-skills");
		await fs.mkdir(newBridge, { recursive: true });
		await fs.symlink(path.join(fixture.paths.agentsSkillsDir as string, "paseo"), path.join(newBridge, "paseo"));
		const migratedDeps: PaseoSetupDependencies = {
			...fixture.deps,
			paths: { ...fixture.deps.paths, bridgeDir: newBridge },
		};

		const install = await runPaseoSetup({}, migratedDeps);
		expect(install.kind).toBe("install");
		// The old directory's links were cleaned, not abandoned.
		for (const name of oldLedger.bridgeEntries ?? []) {
			await expect(fs.lstat(path.join(oldDir, name))).rejects.toMatchObject({ code: "ENOENT" });
		}
		// The new ledger owns only the links the new run created: the user's
		// pre-existing `paseo` link at the new path did NOT inherit ownership.
		const ledger = await readProvenance(migratedDeps.paths.provenanceLedger);
		expect(ledger.bridgePath).toBe(newBridge);
		expect(ledger.bridgeEntries).not.toContain("paseo");
		expect(ledger.bridgeEntries).toContain("paseo-advisor");
	});

	test("an identityless prewritten migration link is preserved even when its target matches (#4644 Codex P2)", async () => {
		const fixture = await makeFixture(lsOk("gjc"));
		await seedSkills(fixture.paths);
		await seedConfig(fixture.paths);
		const oldDir = fixture.paths.bridgeDir;
		const name = "paseo";
		const sourceDir = await fs.realpath(fixture.paths.agentsSkillsDir as string);
		await fs.mkdir(oldDir, { recursive: true });
		await writeProvenance(fixture.paths.provenanceLedger, {
			version: 1,
			providerKeys: {},
			seededOrchestrationKeys: {},
			bridgePath: oldDir,
			bridgeSourceDir: sourceDir,
			bridgeEntries: [name],
			bridgeEntryIdentities: {},
			bridgeDirCreated: false,
		});
		// The user writes the exact target after the durable prewritten plan.
		await fs.symlink(path.join(sourceDir, name), path.join(oldDir, name));
		const newBridge = path.join(path.dirname(oldDir), "identityless-migrated-paseo-skills");
		const migratedDeps: PaseoSetupDependencies = {
			...fixture.deps,
			paths: { ...fixture.paths, bridgeDir: newBridge },
		};

		const before = await snapshotTree(oldDir);
		const recordedLedger = await fs.readFile(fixture.paths.provenanceLedger, "utf8");
		const install = await runPaseoSetup({}, migratedDeps);
		expect(install.kind).toBe("install");
		if (install.kind !== "install") throw new Error("expected an install outcome");
		expect(install.result.outcome).toBe("partial-install");
		if (install.result.outcome !== "partial-install") throw new Error("expected a partial install outcome");
		expect(install.result.evidence.detail).toContain("identityless");
		// The identityless user link cannot authenticate migration cleanup, so
		// setup keeps the old bridge path and its bridge provenance unchanged while
		// independently owned JSON state converges.
		expect(await snapshotTree(oldDir)).toBe(before);
		const beforeProvenance = JSON.parse(recordedLedger) as ProvenanceLedger;
		const afterProvenance = await readProvenance(fixture.paths.provenanceLedger);
		expect(afterProvenance.bridgePath).toBe(beforeProvenance.bridgePath);
		expect(afterProvenance.bridgeEntries).toEqual(beforeProvenance.bridgeEntries);
		expect(afterProvenance.bridgeEntryIdentities).toEqual(beforeProvenance.bridgeEntryIdentities);
		expect(await fs.readlink(path.join(oldDir, name))).toBe(path.join(sourceDir, name));
		await expect(fs.stat(newBridge)).rejects.toMatchObject({ code: "ENOENT" });
	});

	test(".env.local and NODE_ENV variants are rejected for PASEO_SKILLS_DIR (#4644 review r4)", async () => {
		const root = await makeRoot();
		const home = path.join(root, "home");
		const userDir = path.join(home, ".agents", "skills");
		await fs.mkdir(userDir, { recursive: true });
		const repoDir = path.join(root, "repo");
		await fs.mkdir(repoDir, { recursive: true });
		const priorCwd = process.cwd();
		const priorEnv = process.env.PASEO_SKILLS_DIR;
		const priorNodeEnv = process.env.NODE_ENV;
		try {
			for (const file of [".env.local", ".env.production", ".env.production.local"]) {
				await Bun.write(path.join(repoDir, file), "PASEO_SKILLS_DIR=/some/override\n");
			}
			process.chdir(repoDir);
			process.env.NODE_ENV = "production";
			process.env.PASEO_SKILLS_DIR = "/some/override";
			await expect(resolvePaseoSkillsSource(home)).resolves.toEqual({ dir: userDir, origin: "user" });
		} finally {
			process.chdir(priorCwd);
			if (priorEnv === undefined) delete process.env.PASEO_SKILLS_DIR;
			else process.env.PASEO_SKILLS_DIR = priorEnv;
			if (priorNodeEnv === undefined) delete process.env.NODE_ENV;
			else process.env.NODE_ENV = priorNodeEnv;
		}
	});
	test(".env.development is rejected for PASEO_SKILLS_DIR with NODE_ENV unset (#4644 review r8)", async () => {
		const root = await makeRoot();
		const home = path.join(root, "home");
		const userDir = path.join(home, ".agents", "skills");
		await fs.mkdir(userDir, { recursive: true });
		const repoDir = path.join(root, "repo");
		await fs.mkdir(repoDir, { recursive: true });
		const priorCwd = process.cwd();
		const priorEnv = process.env.PASEO_SKILLS_DIR;
		const priorNodeEnv = process.env.NODE_ENV;
		try {
			// Bun's mode defaults to development, so `.env.development` loads
			// even with NODE_ENV unset (the common interactive case); the trust
			// check must reject an override sourced from it.
			await Bun.write(path.join(repoDir, ".env.development"), "PASEO_SKILLS_DIR=/some/override\n");
			process.chdir(repoDir);
			delete process.env.NODE_ENV;
			process.env.PASEO_SKILLS_DIR = "/some/override";
			await expect(resolvePaseoSkillsSource(home)).resolves.toEqual({ dir: userDir, origin: "user" });
		} finally {
			process.chdir(priorCwd);
			if (priorEnv === undefined) delete process.env.PASEO_SKILLS_DIR;
			else process.env.PASEO_SKILLS_DIR = priorEnv;
			if (priorNodeEnv === undefined) delete process.env.NODE_ENV;
			else process.env.NODE_ENV = priorNodeEnv;
		}
	});

	test("a pre-#4638 bridge pointing at the legacy source is adopted, not refused (#4644 review)", async () => {
		const fixture = await makeFixture();
		await seedSkills(fixture.paths);
		// The legacy machine: allowlist links into ~/.agents/skills, ledger
		// without bridgeSourceDir. The source still resolves to the same
		// directory, so adoption is a no-op re-point of the same target.
		await installWithLedger(fixture.deps);
		const ledger = await readProvenance(fixture.paths.provenanceLedger);
		await writeProvenance(fixture.paths.provenanceLedger, {
			...ledger,
			bridgeSourceDir: undefined,
		});

		const preflight = await preflightSkillsBridge(fixture.deps);
		// Same-directory legacy links are already correct: nothing to adopt.
		expect(preflight.adopts).toEqual([]);
	});

	test("a legacy ledger without entry identities refuses retired-source convergence (#4644 review)", async () => {
		// The exact wedged state from #4638: five allowlist links into a
		// ~/.agents/skills that never existed, a desktop app now present, and a
		// legacy ledger without bridgeSourceDir.
		const fixture = await makeFixture(lsOk("gjc"));
		await safeRm(fixture.paths.agentsSkillsDir as string, { recursive: true });
		const legacySource = fixture.paths.agentsSkillsDir as string;
		const bundle = path.join(fixture.root, "Applications", "Paseo.app", "Contents", "Resources", "skills");
		for (const name of ["paseo", "paseo-help"]) {
			await fs.mkdir(path.join(bundle, name), { recursive: true });
			await fs.writeFile(path.join(bundle, name, "SKILL.md"), `# ${name}\n`);
		}
		await fs.mkdir(fixture.paths.bridgeDir, { recursive: true });
		const beforeLinks: Record<string, string> = {};
		for (const name of SKILL_NAMES) {
			const destination = path.join(fixture.paths.bridgeDir, name);
			beforeLinks[name] = path.join(legacySource, name);
			await fs.symlink(beforeLinks[name], destination);
		}
		await writeProvenance(fixture.paths.provenanceLedger, {
			version: 1,
			providerKeys: {},
			seededOrchestrationKeys: {},
			bridgePath: fixture.paths.bridgeDir,
			bridgeEntries: [...SKILL_NAMES],
			bridgeDirCreated: false,
		});
		const recordedLedger = await fs.readFile(fixture.paths.provenanceLedger, "utf8");
		const deps: PaseoSetupDependencies = {
			...fixture.deps,
			skillsSource: async () => ({ dir: bundle, origin: "app-bundle" }),
		};

		// Check reports the wedge (dangling legacy links) instead of passing.
		const drifted = await checkPaseoSetup(deps);
		expect(drifted.status).toBe("drift");

		// Without durable per-entry identities, matching legacy targets cannot
		// prove GJC created these links. Setup reports a partial reconciliation,
		// preserving the user-visible links and the bridge portion of the ledger.
		const install = await runPaseoSetup({}, deps);
		expect(install.kind).toBe("install");
		if (install.kind !== "install") throw new Error("expected an install outcome");
		expect(install.result.outcome).toBe("partial-install");
		if (install.result.outcome !== "partial-install") throw new Error("expected a partial install outcome");
		expect(install.result.evidence.detail).toContain("identityless");
		for (const name of SKILL_NAMES) {
			expect(await fs.readlink(path.join(fixture.paths.bridgeDir, name))).toBe(beforeLinks[name]);
		}
		const beforeProvenance = JSON.parse(recordedLedger) as ProvenanceLedger;
		const afterProvenance = await readProvenance(fixture.paths.provenanceLedger);
		expect(afterProvenance.bridgePath).toBe(beforeProvenance.bridgePath);
		expect(afterProvenance.bridgeEntries).toEqual(beforeProvenance.bridgeEntries);
		expect(afterProvenance.bridgeEntryIdentities).toEqual(beforeProvenance.bridgeEntryIdentities);
	});

	test("remove rolls back a legacy ledger with no recorded source directory (#4644 review)", async () => {
		// The same wedged machine, exercising --remove directly: the ledger
		// predates bridgeSourceDir, so ownership is proven against the legacy
		// ~/.agents/skills location rather than a re-discovered source.
		const fixture = await makeFixture(lsOk("gjc"));
		const legacySource = fixture.paths.agentsSkillsDir as string;
		await fs.mkdir(fixture.paths.bridgeDir, { recursive: true });
		for (const name of SKILL_NAMES) {
			await fs.symlink(path.join(legacySource, name), path.join(fixture.paths.bridgeDir, name));
		}
		await writeProvenance(fixture.paths.provenanceLedger, {
			version: 1,
			providerKeys: {},
			seededOrchestrationKeys: {},
			bridgePath: fixture.paths.bridgeDir,
			bridgeEntries: [...SKILL_NAMES],
			bridgeDirCreated: true,
		});
		const beforeBridge = await snapshotTree(fixture.paths.bridgeDir);
		const recordedLedger = await fs.readFile(fixture.paths.provenanceLedger, "utf8");
		// No source can be discovered anymore (the app is gone). A legacy ledger
		// also lacks install-time link identities, so removal preserves every
		// ambiguous link and reports a partial result rather than treating a
		// same-target successor as GJC-owned.
		const deps: PaseoSetupDependencies = {
			...fixture.deps,
			skillsSource: async () => undefined,
		};

		const result = await removePaseoSetup(deps, { now: new Date() });
		expect(result.outcome).toBe("partial-removal");
		if (result.outcome !== "partial-removal") throw new Error("expected a partial removal outcome");
		expect(result.evidence.detail).toContain("identityless");
		expect(await snapshotTree(fixture.paths.bridgeDir)).toBe(beforeBridge);
		const beforeProvenance = JSON.parse(recordedLedger) as ProvenanceLedger;
		const afterProvenance = await readProvenance(fixture.paths.provenanceLedger);
		expect(afterProvenance.bridgePath).toBe(beforeProvenance.bridgePath);
		expect(afterProvenance.bridgeEntries).toEqual(beforeProvenance.bridgeEntries);
		expect(afterProvenance.bridgeEntryIdentities).toEqual(beforeProvenance.bridgeEntryIdentities);
		expect((await fs.lstat(path.join(deps.paths.bridgeDir, SKILL_NAMES[0]))).isSymbolicLink()).toBe(true);
	});

	test("remove trusts a caller legacy skills path when skillsSource is omitted (#4644 exact-head P2)", async () => {
		const fixture = await makeFixture(lsOk("gjc"));
		const legacySource = path.join(fixture.root, "custom-legacy-skills");
		const paths: FixturePaths = { ...fixture.paths, agentsSkillsDir: legacySource };
		await seedSkills(paths);
		await seedConfig(paths);
		const installDeps: PaseoSetupDependencies = {
			...fixture.deps,
			paths,
			skillsSource: async () => ({ dir: legacySource, origin: "user" }),
			trustedSkillsSource: undefined,
		};

		const install = await runPaseoSetup({}, installDeps);
		expect(install.kind).toBe("install");
		const installedLedger = await readProvenance(paths.provenanceLedger);
		expect(installedLedger.bridgeSourceDir).toBe(legacySource);
		// Model a pre-#4638 ledger produced through the same caller seam: the
		// bridge links remain owned, but no source directory was recorded.
		await writeProvenance(paths.provenanceLedger, { ...installedLedger, bridgeSourceDir: undefined });

		const remove = await runPaseoSetup({ remove: true }, { ...installDeps, skillsSource: undefined });
		if (remove.kind !== "remove") throw new Error("expected a remove outcome");
		expect(remove.result.outcome).toBe("removed");
		await expect(fs.stat(paths.bridgeDir)).rejects.toMatchObject({ code: "ENOENT" });
	});

	test("a non-ENOENT filesystem failure fails removal closed instead of reporting success (#4644 review)", async () => {
		const fixture = await makeFixture();
		await seedSkills(fixture.paths);
		await installWithLedger(fixture.deps);

		// Simulate a permission failure on the bridge directory: the recorded
		// entry is still on disk, but lstat cannot traverse to it. Removal must
		// report partial-removal and retain the ledger, never claim success.
		// chmod 000 blocks traversal with EACCES on the real syscall surface,
		// which is exactly the errno class the review asked to keep distinct.
		await fs.chmod(fixture.paths.bridgeDir, 0o000);
		let result: PaseoRemoveResult;
		try {
			result = await removePaseoSetup(fixture.deps, { now: new Date() });
		} finally {
			await fs.chmod(fixture.paths.bridgeDir, 0o755);
		}
		expect(result.outcome).toBe("partial-removal");
		if (result.outcome !== "partial-removal") throw new Error("unreachable");
		expect(result.evidence.detail).toContain("EACCES");

		// The owned link still exists and the ledger still records it.
		expect((await fs.lstat(path.join(fixture.paths.bridgeDir, "paseo"))).isSymbolicLink()).toBe(true);
		const ledger = await readProvenance(fixture.paths.provenanceLedger);
		expect(ledger.bridgeEntries).toContain("paseo");
	});

	test("both protected skill trees are byte-identical across install and check (AC-8, AC-19)", async () => {
		const fixture = await makeFixture();
		await seedSkills(fixture.paths, ["context-search"]);
		await fs.writeFile(path.join(fixture.paths.gjcSkillsDir, "mine.md"), "# mine\n");

		const agentsBefore = await snapshotTree(fixture.paths.agentsSkillsDir as string);
		const gjcBefore = await snapshotTree(fixture.paths.gjcSkillsDir);

		await installSkillsBridge(await preflightSkillsBridge(fixture.deps));
		await checkPaseoSetup(fixture.deps);

		expect(await snapshotTree(fixture.paths.agentsSkillsDir as string)).toBe(agentsBefore);
		expect(await snapshotTree(fixture.paths.gjcSkillsDir)).toBe(gjcBefore);
	});
});

describe("skills source discovery (#4638)", () => {
	async function discoveryRoot(): Promise<string> {
		const root = await makeRoot();
		return root;
	}

	test("PASEO_SKILLS_DIR wins when it points at a real directory", async () => {
		const root = await discoveryRoot();
		const home = path.join(root, "home");
		const relocated = path.join(root, "Elsewhere", "Paseo.app", "Contents", "Resources", "skills");
		await fs.mkdir(relocated, { recursive: true });
		const prior = process.env.PASEO_SKILLS_DIR;
		process.env.PASEO_SKILLS_DIR = relocated;
		try {
			await expect(resolvePaseoSkillsSource(home)).resolves.toEqual({ dir: relocated, origin: "app-bundle" });
		} finally {
			if (prior === undefined) delete process.env.PASEO_SKILLS_DIR;
			else process.env.PASEO_SKILLS_DIR = prior;
		}
	});

	test("a stale or relative PASEO_SKILLS_DIR is ignored, never linked into", async () => {
		const root = await discoveryRoot();
		const home = path.join(root, "home");
		const userDir = path.join(home, ".agents", "skills");
		await fs.mkdir(userDir, { recursive: true });
		for (const value of [path.join(root, "gone"), "relative/skills"]) {
			const prior = process.env.PASEO_SKILLS_DIR;
			process.env.PASEO_SKILLS_DIR = value;
			try {
				await expect(resolvePaseoSkillsSource(home)).resolves.toEqual({ dir: userDir, origin: "user" });
			} finally {
				if (prior === undefined) delete process.env.PASEO_SKILLS_DIR;
				else process.env.PASEO_SKILLS_DIR = prior;
			}
		}
	});

	test("~/.agents/skills wins over an app bundle; nothing resolvable means undefined", async () => {
		const root = await discoveryRoot();
		const home = path.join(root, "home");
		const userDir = path.join(home, ".agents", "skills");
		await fs.mkdir(userDir, { recursive: true });
		await expect(resolvePaseoSkillsSource(home)).resolves.toEqual({ dir: userDir, origin: "user" });
		// A home with no ~/.agents/skills and no bundle resolves to nothing. The
		// bundle candidates are platform-bounded, so this holds everywhere.
		await expect(resolvePaseoSkillsSource(path.join(root, "empty-home"))).resolves.toBeUndefined();
	});

	test("app bundle candidates are bounded and platform-shaped", () => {
		const home = "/Users/tester";
		const candidates = paseoAppSkillsCandidates(home);
		if (process.platform === "darwin") {
			expect(candidates.length).toBe(6);
			expect(candidates[0]).toBe(path.join("/Applications", "Paseo.app", "Contents", "Resources", "skills"));
			expect(candidates).toContain(path.join(home, "Applications", "Paseo.app", "Contents", "Resources", "skills"));
		} else {
			expect(candidates).toEqual([]);
		}
	});

	test("default Paseo home paths resolve through the trusted home, never $HOME (#4644 review r7)", async () => {
		const root = await discoveryRoot();
		const attacker = path.join(root, "attacker-home");
		await fs.mkdir(path.join(attacker, ".agents", "skills", "paseo-evil"), { recursive: true });
		const trusted = getTrustedHomeDir();

		const prior = process.env.HOME;
		process.env.HOME = attacker;
		try {
			// A repository (or shell) that plants $HOME must not redirect global
			// Paseo discovery at attacker-controlled skill content: every default
			// home path derives from the provenance-checked account home.
			const deps = createDefaultPaseoSetupDependencies();
			const depsHome = createDefaultPaseoSetupDependencies().home;
			expect(depsHome).toBe(trusted);
			expect(depsHome?.startsWith(attacker)).toBe(false);
			expect(deps.paths.configJson.startsWith(trusted)).toBe(true);
			expect(deps.paths.orchestrationPreferences.startsWith(trusted)).toBe(true);
			const candidates = paseoAppSkillsCandidates();
			for (const candidate of candidates) {
				expect(candidate.startsWith(attacker)).toBe(false);
			}
			await expect(resolvePaseoSkillsSource()).resolves.not.toEqual({ dir: attacker, origin: "user" });
		} finally {
			if (prior === undefined) delete process.env.HOME;
			else process.env.HOME = prior;
		}
	});
});

describe("desktop app install (#4638)", () => {
	const APP_SKILLS = ["paseo", "paseo-advisor", "paseo-committee", "paseo-handoff", "paseo-help"];

	/** `runPaseoSetup` narrowed to the check arm, for readable assertions. */
	async function check(deps: PaseoSetupDependencies): Promise<SetupCheckResult> {
		const outcome = await runPaseoSetup({ check: true }, deps);
		if (outcome.kind !== "check") throw new Error("expected a check outcome");
		return outcome.result;
	}

	/** The reported machine: Paseo.app 0.4.0 ships paseo-help, not paseo-loop, and there is no ~/.agents/skills. */
	async function appFixture(skillNames: readonly string[]): Promise<Fixture> {
		const fixture = await makeFixture(lsOk("gjc"));
		await safeRm(fixture.paths.agentsSkillsDir as string, { recursive: true });
		const bundle = path.join(fixture.root, "Applications", "Paseo.app", "Contents", "Resources", "skills");
		for (const name of skillNames) {
			await fs.mkdir(path.join(bundle, name), { recursive: true });
			await fs.writeFile(path.join(bundle, name, "SKILL.md"), `# ${name}\n`);
		}
		const deps: PaseoSetupDependencies = {
			...fixture.deps,
			skillsSource: async () => ({ dir: bundle, origin: "app-bundle" }),
		};
		return { ...fixture, deps };
	}

	test("install bridges the bundle's skills and check reaches pass", async () => {
		const fixture = await appFixture(APP_SKILLS);
		await seedConfig(fixture.paths);

		const install = await runPaseoSetup({}, fixture.deps);
		expect(install.kind).toBe("install");

		const result = await check(fixture.deps);
		expect(result.status).toBe("pass");
		expect(checkExitCode(result)).toBe(0);

		// The exact set the app ships is bridged -- nothing more, nothing less.
		const linked = (await fs.readdir(fixture.paths.bridgeDir)).sort();
		expect(linked).toEqual([...APP_SKILLS].sort());
		for (const name of linked) {
			const target = await fs.readlink(path.join(fixture.paths.bridgeDir, name));
			expect(path.dirname(target)).toBe(
				path.join(fixture.root, "Applications", "Paseo.app", "Contents", "Resources", "skills"),
			);
		}
	});

	test("a missing source directory skips the bridge, creates nothing, and reports it once", async () => {
		const fixture = await appFixture([]);
		const deps: PaseoSetupDependencies = {
			...fixture.deps,
			skillsSource: async () => undefined,
		};
		await seedConfig(fixture.paths);

		const install = await runPaseoSetup({}, deps);
		expect(install.kind).toBe("install");
		await expect(fs.stat(deps.paths.bridgeDir)).rejects.toMatchObject({ code: "ENOENT" });

		const result = await check(deps);
		expect(result.status).toBe("drift");
		const codes = result.reasons.map(reason => reason.code);
		expect(codes).toContain("missing-skills-directory");
		expect(codes).not.toContain("missing-bridge-link");
		expect(codes).not.toContain("orphan-skill");
	});

	test("a source that disappears during enumeration fails closed", async () => {
		const fixture = await makeFixture(lsOk("gjc"));
		const source = path.join(fixture.root, "paseo-skills-source");
		await fs.mkdir(source, { recursive: true });
		await safeRm(source, { recursive: true });

		await expect(sourceBridgeEntries(source)).rejects.toMatchObject({ code: "ENOENT" });

		const nonDirectory = path.join(fixture.root, "paseo-skills-file");
		await fs.writeFile(nonDirectory, "not a directory\n");
		await expect(sourceBridgeEntries(nonDirectory)).rejects.toMatchObject({ code: "ENOTDIR" });
	});

	test("a source skill with no bridge link is drift, and re-running setup repairs it", async () => {
		const fixture = await appFixture(SKILL_NAMES);
		await seedConfig(fixture.paths);
		await runPaseoSetup({}, fixture.deps);
		await safeRm(path.join(fixture.paths.bridgeDir, "paseo-advisor"));

		const drifted = await check(fixture.deps);
		expect(drifted.status).toBe("drift");
		expect(drifted.reasons).toEqual([
			{
				code: "missing-bridge-link",
				subject: path.join(fixture.paths.bridgeDir, "paseo-advisor"),
				detail: expect.any(String),
			},
		]);

		await runPaseoSetup({}, fixture.deps);
		expect((await check(fixture.deps)).status).toBe("pass");
	});

	test("a Paseo release adding a skill never turns check red", async () => {
		const fixture = await appFixture(APP_SKILLS);
		await seedConfig(fixture.paths);
		await runPaseoSetup({}, fixture.deps);

		// The app updates underneath GJC and ships one extra skill.
		const bundle = path.join(fixture.root, "Applications", "Paseo.app", "Contents", "Resources", "skills");
		await fs.mkdir(path.join(bundle, "paseo-brand-new"));

		const result = await check(fixture.deps);
		expect(result.status).toBe("pass");
		expect(checkExitCode(result)).toBe(0);
	});

	test("repeated install, check, and remove converge and preserve the foreign provider", async () => {
		const fixture = await appFixture(APP_SKILLS);
		await seedConfig(fixture.paths);

		await runPaseoSetup({}, fixture.deps);
		const again = await runPaseoSetup({}, fixture.deps);
		expect(again.kind).toBe("install");
		let result = await check(fixture.deps);
		expect(result.status).toBe("pass");

		const remove = await runPaseoSetup({ remove: true }, fixture.deps);
		if (remove.kind !== "remove") throw new Error("expected a remove outcome");
		expect(remove.result.outcome).toBe("removed");
		await expect(fs.stat(fixture.paths.bridgeDir)).rejects.toMatchObject({ code: "ENOENT" });

		// The foreign provider entry survives every pass untouched.
		const config = JSON.parse(await fs.readFile(fixture.paths.configJson, "utf8")) as Record<string, unknown>;
		const providers = (config.agents as { providers: Record<string, unknown> }).providers;
		expect(Object.keys(providers).sort()).toEqual(["claude"]);

		// And a fresh install on top of the rolled-back state is green again.
		await runPaseoSetup({}, fixture.deps);
		result = await check(fixture.deps);
		expect(result.status).toBe("pass");
	});

	test("remove still cleans the bridge after Paseo itself is uninstalled (#4638)", async () => {
		const fixture = await appFixture(APP_SKILLS);
		await seedConfig(fixture.paths);
		await runPaseoSetup({}, fixture.deps);

		// Paseo disappears entirely: the app bundle is gone, so every bridge link
		// dangles and no source can be discovered anymore.
		await safeRm(path.join(fixture.root, "Applications"), { recursive: true });
		const deps: PaseoSetupDependencies = {
			...fixture.deps,
			skillsSource: async () => undefined,
		};

		const remove = await runPaseoSetup({ remove: true }, deps);
		if (remove.kind !== "remove") throw new Error("expected a remove outcome");
		expect(remove.result.outcome).toBe("removed");
		await expect(fs.stat(deps.paths.bridgeDir)).rejects.toMatchObject({ code: "ENOENT" });

		const config = JSON.parse(await fs.readFile(deps.paths.configJson, "utf8")) as Record<string, unknown>;
		const providers = (config.agents as { providers: Record<string, unknown> }).providers;
		expect(Object.keys(providers).sort()).toEqual(["claude"]);
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
	test("bridge source relocation retries from preflight provenance after a crash", async () => {
		const fixture = await makeFixture();
		await seedSkills(fixture.paths);
		await seedConfig(fixture.paths);
		await runPaseoSetup({}, fixture.deps);
		const before = await readProvenance(fixture.paths.provenanceLedger);
		const relocatedSource = path.join(fixture.root, "relocated-skills");
		for (const name of SKILL_NAMES) {
			await fs.mkdir(path.join(relocatedSource, name), { recursive: true });
			await fs.writeFile(path.join(relocatedSource, name, "SKILL.md"), `# ${name}\n`);
		}
		const planned = { ...before, bridgeSourceDir: relocatedSource };
		await writeIntent(fixture.paths.intentRecord, {
			version: INTENT_VERSION,
			step: "skills-bridge",
			targetPath: fixture.paths.bridgeDir,
			ownedKeys: ["paseo.skills-bridge"],
			targetPreflightIdentity: provenanceLedgerIdentity(before),
			targetExpectedIdentity: provenanceLedgerIdentity(before),
			provenancePath: fixture.paths.provenanceLedger,
			provenancePreflightIdentity: await currentIdentity(fixture.paths.provenanceLedger),
			provenanceExpectedIdentity: provenanceLedgerIdentity(planned),
			provenancePayload: planned,
			bridgePreflightPayload: before,
			startedAt: new Date().toISOString(),
		});

		const recovery = await recoverIntent(fixture.paths.intentRecord, {
			repair: true,
			expectedTargetPaths: [
				fixture.paths.configJson,
				fixture.paths.orchestrationPreferences,
				fixture.paths.bridgeDir,
			],
			expectedProvenancePath: fixture.paths.provenanceLedger,
		});
		expect(recovery?.recovered).toBe(true);
		expect(await readIntent(fixture.paths.intentRecord)).toBeUndefined();
		const retry = await runPaseoSetup(
			{},
			{ ...fixture.deps, skillsSource: async () => ({ dir: relocatedSource, origin: "app-bundle" }) },
		);
		expect(retry.kind).toBe("install");
		const after = await readProvenance(fixture.paths.provenanceLedger);
		expect(after.bridgeSourceDir).toBe(relocatedSource);
		for (const name of SKILL_NAMES) {
			expect(await fs.realpath(path.join(fixture.paths.bridgeDir, name))).toBe(path.join(relocatedSource, name));
		}
	});

	test("bridge path migration retries from preflight provenance after a crash", async () => {
		const fixture = await makeFixture();
		await seedSkills(fixture.paths);
		await seedConfig(fixture.paths);
		await runPaseoSetup({}, fixture.deps);
		const before = await readProvenance(fixture.paths.provenanceLedger);
		const newBridge = path.join(fixture.root, "relocated-paseo-skills");
		const planned = { ...before, bridgePath: newBridge };
		await writeIntent(fixture.paths.intentRecord, {
			version: INTENT_VERSION,
			step: "skills-bridge",
			targetPath: newBridge,
			ownedKeys: ["paseo.skills-bridge"],
			targetPreflightIdentity: provenanceLedgerIdentity(before),
			targetExpectedIdentity: provenanceLedgerIdentity(before),
			provenancePath: fixture.paths.provenanceLedger,
			provenancePreflightIdentity: await currentIdentity(fixture.paths.provenanceLedger),
			provenanceExpectedIdentity: provenanceLedgerIdentity(planned),
			provenancePayload: planned,
			bridgePreflightPayload: before,
			startedAt: new Date().toISOString(),
		});

		const recovery = await recoverIntent(fixture.paths.intentRecord, {
			repair: true,
			expectedTargetPaths: [
				fixture.paths.configJson,
				fixture.paths.orchestrationPreferences,
				fixture.paths.bridgeDir,
				newBridge,
			],
			expectedProvenancePath: fixture.paths.provenanceLedger,
		});
		expect(recovery?.recovered).toBe(true);
		const retry = await runPaseoSetup({}, { ...fixture.deps, paths: { ...fixture.paths, bridgeDir: newBridge } });
		expect(retry.kind).toBe("install");
		const after = await readProvenance(fixture.paths.provenanceLedger);
		expect(after.bridgePath).toBe(newBridge);
		for (const name of SKILL_NAMES) {
			await expect(fs.lstat(path.join(fixture.paths.bridgeDir, name))).rejects.toMatchObject({ code: "ENOENT" });
			expect(await fs.realpath(path.join(newBridge, name))).toBe(path.join(fixture.paths.agentsSkillsDir!, name));
		}
	});

	test("pending old-root cleanup does not overwrite the post-cutover intent payload", async () => {
		const fixture = await makeFixture();
		await seedSkills(fixture.paths);
		await seedConfig(fixture.paths);
		await runPaseoSetup({}, fixture.deps);
		const oldDir = fixture.paths.bridgeDir;
		for (const name of SKILL_NAMES) {
			await safeRm(path.join(fixture.paths.agentsSkillsDir as string, name), { recursive: true });
		}
		await runPaseoSetup({}, fixture.deps);
		const before = await readProvenance(fixture.paths.provenanceLedger);
		const captured = snapshotDirectoryTree(oldDir);
		if (!captured.ok || captured.snapshot === undefined) throw new Error("expected an empty bridge snapshot");
		const parent = await fs.lstat(path.dirname(oldDir), { bigint: true });
		const authority: BridgeCleanupAuthority = {
			originalPath: oldDir,
			detachedPath: `${oldDir}.removing`,
			parentIdentity: { dev: parent.dev.toString(), ino: parent.ino.toString() },
			snapshot: captured.snapshot,
		};
		const newBridge = path.join(path.dirname(oldDir), "pending-relocated-paseo-skills");
		const after = { ...before, bridgePath: newBridge, bridgeCleanupPending: undefined };
		await writeProvenance(fixture.paths.provenanceLedger, { ...before, bridgeCleanupPending: authority });
		await writeIntent(fixture.paths.intentRecord, {
			version: INTENT_VERSION,
			step: "skills-bridge",
			targetPath: newBridge,
			ownedKeys: ["paseo.skills-bridge"],
			targetPreflightIdentity: provenanceLedgerIdentity(before),
			targetExpectedIdentity: provenanceLedgerIdentity(before),
			provenancePath: fixture.paths.provenanceLedger,
			provenancePreflightIdentity: provenanceLedgerIdentity(before),
			provenanceExpectedIdentity: provenanceLedgerIdentity(after),
			provenancePayload: after,
			bridgePreflightPayload: before,
			startedAt: new Date().toISOString(),
		});

		const recovery = await recoverIntent(fixture.paths.intentRecord, {
			repair: true,
			expectedTargetPaths: [fixture.paths.configJson, fixture.paths.orchestrationPreferences, oldDir, newBridge],
			expectedProvenancePath: fixture.paths.provenanceLedger,
			trustedBridgePaths: [oldDir, newBridge],
		});
		expect(recovery?.recovered).toBe(false);
		expect(recovery?.detail).toContain("pre-cutover provenance");
		expect((await readIntent(fixture.paths.intentRecord))?.provenancePayload?.bridgePath).toBe(newBridge);
		expect((await readProvenance(fixture.paths.provenanceLedger)).bridgePath).toBe(oldDir);
		expect((await readProvenance(fixture.paths.provenanceLedger)).bridgeCleanupPending).toEqual(authority);
	});

	test("public install advances an authenticated pre-detach migration and retries old-root cleanup", async () => {
		const fixture = await makeFixture();
		await seedSkills(fixture.paths);
		await seedConfig(fixture.paths);
		const initial = await runPaseoSetup({}, fixture.deps);
		expect(initial.kind).toBe("install");
		// First converge to an owned empty root. This exercises the migration
		// window where there are no old links left to prove the pre-detach state;
		// the durable directory identity and pending authority are the evidence.
		for (const name of SKILL_NAMES)
			await safeRm(path.join(fixture.paths.agentsSkillsDir as string, name), { recursive: true });
		const emptied = await runPaseoSetup({}, fixture.deps);
		expect(emptied.kind).toBe("install");
		await seedSkills(fixture.paths);
		const oldDir = fixture.paths.bridgeDir;
		const before = await readProvenance(fixture.paths.provenanceLedger);
		const newBridge = path.join(path.dirname(oldDir), "pre-detach-relocated-paseo-skills");
		await fs.mkdir(newBridge);
		const destinationIdentities = Object.fromEntries(
			await Promise.all(
				SKILL_NAMES.map(async name => {
					const linkPath = path.join(newBridge, name);
					await fs.symlink(path.join(fixture.paths.agentsSkillsDir as string, name), linkPath);
					const stat = await fs.lstat(linkPath, { bigint: true });
					return [
						name,
						{
							dev: stat.dev.toString(),
							ino: stat.ino.toString(),
							size: stat.size.toString(),
							mtimeNs: stat.mtimeNs.toString(),
						},
					] as const;
				}),
			),
		);
		const destinationRoot = await fs.lstat(newBridge, { bigint: true });
		for (const name of SKILL_NAMES) await safeRm(path.join(oldDir, name), { force: true });
		const captured = snapshotDirectoryTree(oldDir);
		if (!captured.ok || captured.snapshot === undefined) throw new Error("expected an empty bridge snapshot");
		const parent = await fs.lstat(path.dirname(oldDir), { bigint: true });
		const authority: BridgeCleanupAuthority = {
			originalPath: oldDir,
			detachedPath: `${oldDir}.removing`,
			parentIdentity: { dev: parent.dev.toString(), ino: parent.ino.toString() },
			snapshot: captured.snapshot,
		};
		const after = {
			...before,
			bridgePath: newBridge,
			bridgeEntries: [...SKILL_NAMES],
			bridgeEntryIdentities: destinationIdentities,
			bridgeDirCreated: true,
			bridgeDirIdentity: {
				dev: destinationRoot.dev.toString(),
				ino: destinationRoot.ino.toString(),
				size: destinationRoot.size.toString(),
				mtimeNs: destinationRoot.mtimeNs.toString(),
			},
			bridgeCleanupPending: undefined,
		};
		await writeProvenance(fixture.paths.provenanceLedger, { ...before, bridgeCleanupPending: authority });
		await writeIntent(fixture.paths.intentRecord, {
			version: INTENT_VERSION,
			step: "skills-bridge",
			targetPath: newBridge,
			ownedKeys: ["paseo.skills-bridge"],
			targetPreflightIdentity: provenanceLedgerIdentity(before),
			targetExpectedIdentity: provenanceLedgerIdentity(before),
			provenancePath: fixture.paths.provenanceLedger,
			provenancePreflightIdentity: provenanceLedgerIdentity(before),
			provenanceExpectedIdentity: provenanceLedgerIdentity(after),
			provenancePayload: after,
			bridgePreflightPayload: before,
			startedAt: new Date().toISOString(),
		});

		const resumed = await runPaseoSetup(
			{},
			{
				...fixture.deps,
				paths: { ...fixture.paths, bridgeDir: newBridge },
			},
		);
		expect(resumed.kind).toBe("install");
		if (resumed.kind !== "install") throw new Error("expected an install outcome");
		expect(resumed.result.outcome).toBe("installed");
		await expect(fs.stat(oldDir)).rejects.toMatchObject({ code: "ENOENT" });
		expect((await readProvenance(fixture.paths.provenanceLedger)).bridgePath).toBe(newBridge);
		expect((await readProvenance(fixture.paths.provenanceLedger)).bridgeCleanupPending).toBeUndefined();
		expect(await readIntent(fixture.paths.intentRecord)).toBeUndefined();
	});

	test("post-detach old-root recovery commits the distinct destination payload", async () => {
		const fixture = await makeFixture();
		await seedSkills(fixture.paths);
		await seedConfig(fixture.paths);
		await runPaseoSetup({}, fixture.deps);
		const oldDir = fixture.paths.bridgeDir;
		for (const name of SKILL_NAMES) {
			await safeRm(path.join(fixture.paths.agentsSkillsDir as string, name), { recursive: true });
		}
		await runPaseoSetup({}, fixture.deps);
		const before = await readProvenance(fixture.paths.provenanceLedger);
		const captured = snapshotDirectoryTree(oldDir);
		if (!captured.ok || captured.snapshot === undefined) throw new Error("expected an empty bridge snapshot");
		const parent = await fs.lstat(path.dirname(oldDir), { bigint: true });
		const authority: BridgeCleanupAuthority = {
			originalPath: oldDir,
			detachedPath: `${oldDir}.removing`,
			parentIdentity: { dev: parent.dev.toString(), ino: parent.ino.toString() },
			snapshot: captured.snapshot,
		};
		const newBridge = path.join(path.dirname(oldDir), "post-detach-relocated-paseo-skills");
		await fs.mkdir(newBridge);
		const newRoot = await fs.lstat(newBridge, { bigint: true });
		const after = {
			...before,
			bridgePath: newBridge,
			bridgeDirIdentity: {
				dev: newRoot.dev.toString(),
				ino: newRoot.ino.toString(),
				size: newRoot.size.toString(),
				mtimeNs: newRoot.mtimeNs.toString(),
			},
			bridgeCleanupPending: undefined,
		};
		await fs.rename(oldDir, authority.detachedPath);
		await writeProvenance(fixture.paths.provenanceLedger, { ...before, bridgeCleanupPending: authority });
		await writeIntent(fixture.paths.intentRecord, {
			version: INTENT_VERSION,
			step: "skills-bridge",
			targetPath: newBridge,
			ownedKeys: ["paseo.skills-bridge"],
			targetPreflightIdentity: provenanceLedgerIdentity(before),
			targetExpectedIdentity: provenanceLedgerIdentity(before),
			provenancePath: fixture.paths.provenanceLedger,
			provenancePreflightIdentity: provenanceLedgerIdentity(before),
			provenanceExpectedIdentity: provenanceLedgerIdentity(after),
			provenancePayload: after,
			bridgePreflightPayload: before,
			startedAt: new Date().toISOString(),
		});

		const recovery = await recoverIntent(fixture.paths.intentRecord, {
			repair: true,
			expectedTargetPaths: [fixture.paths.configJson, fixture.paths.orchestrationPreferences, oldDir, newBridge],
			expectedProvenancePath: fixture.paths.provenanceLedger,
			trustedBridgePaths: [oldDir, newBridge],
			replayBridgeCleanup: async pending => {
				await fs.rm(pending.detachedPath, { recursive: true, force: true });
			},
		});
		expect(recovery?.recovered).toBe(true);
		expect((await readProvenance(fixture.paths.provenanceLedger)).bridgePath).toBe(newBridge);
		expect((await readProvenance(fixture.paths.provenanceLedger)).bridgeCleanupPending).toBeUndefined();
		expect(await readIntent(fixture.paths.intentRecord)).toBeUndefined();
	});

	test("public install replays a destination rollback before root detach and settles to before", async () => {
		const fixture = await makeFixture();
		await seedSkills(fixture.paths);
		const before = await readProvenance(fixture.paths.provenanceLedger);
		const destination = fixture.paths.bridgeDir;
		await fs.mkdir(destination);
		const entryIdentities: Record<string, BridgeEntryIdentity> = {};
		for (const name of SKILL_NAMES) {
			const linkPath = path.join(destination, name);
			await fs.symlink(path.join(fixture.paths.agentsSkillsDir as string, name), linkPath);
			const stat = await fs.lstat(linkPath, { bigint: true });
			entryIdentities[name] = {
				dev: stat.dev.toString(),
				ino: stat.ino.toString(),
				size: stat.size.toString(),
				mtimeNs: stat.mtimeNs.toString(),
			};
		}
		for (const name of SKILL_NAMES) await fs.unlink(path.join(destination, name));
		const captured = snapshotDirectoryTree(destination);
		if (!captured.ok || captured.snapshot === undefined) throw new Error("expected an empty destination snapshot");
		const root = await fs.lstat(destination, { bigint: true });
		const parent = await fs.lstat(path.dirname(destination), { bigint: true });
		const authority = {
			originalPath: destination,
			detachedPath: `${destination}.removing`,
			parentIdentity: { dev: parent.dev.toString(), ino: parent.ino.toString() },
			snapshot: captured.snapshot,
			cleanupDirection: "rollback" as const,
			cleanupOwner: "destination" as const,
		};
		const after = {
			...before,
			bridgePath: destination,
			bridgeSourceDir: fixture.paths.agentsSkillsDir,
			bridgeEntries: [...SKILL_NAMES],
			bridgeEntryIdentities: entryIdentities,
			bridgeDirCreated: true,
			bridgeDirIdentity: {
				dev: root.dev.toString(),
				ino: root.ino.toString(),
				size: root.size.toString(),
				mtimeNs: root.mtimeNs.toString(),
			},
			bridgeCleanupPending: undefined,
		};
		await writeProvenance(fixture.paths.provenanceLedger, { ...after, bridgeCleanupPending: authority });
		await writeIntent(fixture.paths.intentRecord, {
			version: INTENT_VERSION,
			step: "skills-bridge",
			targetPath: destination,
			ownedKeys: ["paseo.skills-bridge"],
			targetPreflightIdentity: provenanceLedgerIdentity(before),
			targetExpectedIdentity: provenanceLedgerIdentity(before),
			provenancePath: fixture.paths.provenanceLedger,
			provenancePreflightIdentity: provenanceLedgerIdentity(before),
			provenanceExpectedIdentity: provenanceLedgerIdentity(after),
			provenancePayload: after,
			bridgePreflightPayload: before,
			startedAt: new Date().toISOString(),
		});

		const recovered = await runPaseoSetup({}, fixture.deps);
		expect(recovered.kind).toBe("install");
		if (recovered.kind !== "install") throw new Error("expected an install outcome");
		expect(recovered.result.outcome).toBe("installed");
		expect(await readIntent(fixture.paths.intentRecord)).toBeUndefined();
		const settled = await readProvenance(fixture.paths.provenanceLedger);
		expect(settled.bridgePath).toBe(destination);
		expect(settled.bridgeCleanupPending).toBeUndefined();
		await expect(fs.stat(`${destination}.removing`)).rejects.toMatchObject({ code: "ENOENT" });
	});

	test("public install replays a destination rollback after root detach and settles to before", async () => {
		const fixture = await makeFixture();
		await seedSkills(fixture.paths);
		const before = await readProvenance(fixture.paths.provenanceLedger);
		const destination = fixture.paths.bridgeDir;
		await fs.mkdir(destination);
		const entryIdentities: Record<string, BridgeEntryIdentity> = {};
		for (const name of SKILL_NAMES) {
			const linkPath = path.join(destination, name);
			await fs.symlink(path.join(fixture.paths.agentsSkillsDir as string, name), linkPath);
			const stat = await fs.lstat(linkPath, { bigint: true });
			entryIdentities[name] = {
				dev: stat.dev.toString(),
				ino: stat.ino.toString(),
				size: stat.size.toString(),
				mtimeNs: stat.mtimeNs.toString(),
			};
		}
		for (const name of SKILL_NAMES) await fs.unlink(path.join(destination, name));
		const captured = snapshotDirectoryTree(destination);
		if (!captured.ok || captured.snapshot === undefined) throw new Error("expected an empty destination snapshot");
		const root = await fs.lstat(destination, { bigint: true });
		const parent = await fs.lstat(path.dirname(destination), { bigint: true });
		const authority = {
			originalPath: destination,
			detachedPath: `${destination}.removing`,
			parentIdentity: { dev: parent.dev.toString(), ino: parent.ino.toString() },
			snapshot: captured.snapshot,
			cleanupDirection: "rollback" as const,
			cleanupOwner: "destination" as const,
		};
		await fs.rename(destination, authority.detachedPath);
		const after = {
			...before,
			bridgePath: destination,
			bridgeSourceDir: fixture.paths.agentsSkillsDir,
			bridgeEntries: [...SKILL_NAMES],
			bridgeEntryIdentities: entryIdentities,
			bridgeDirCreated: true,
			bridgeDirIdentity: {
				dev: root.dev.toString(),
				ino: root.ino.toString(),
				size: root.size.toString(),
				mtimeNs: root.mtimeNs.toString(),
			},
			bridgeCleanupPending: undefined,
		};
		await writeProvenance(fixture.paths.provenanceLedger, { ...after, bridgeCleanupPending: authority });
		await writeIntent(fixture.paths.intentRecord, {
			version: INTENT_VERSION,
			step: "skills-bridge",
			targetPath: destination,
			ownedKeys: ["paseo.skills-bridge"],
			targetPreflightIdentity: provenanceLedgerIdentity(before),
			targetExpectedIdentity: provenanceLedgerIdentity(before),
			provenancePath: fixture.paths.provenanceLedger,
			provenancePreflightIdentity: provenanceLedgerIdentity(before),
			provenanceExpectedIdentity: provenanceLedgerIdentity(after),
			provenancePayload: after,
			bridgePreflightPayload: before,
			startedAt: new Date().toISOString(),
		});

		const recovered = await runPaseoSetup({}, fixture.deps);
		expect(recovered.kind).toBe("install");
		if (recovered.kind !== "install") throw new Error("expected an install outcome");
		expect(recovered.result.outcome).toBe("installed");
		expect(await readIntent(fixture.paths.intentRecord)).toBeUndefined();
		const settled = await readProvenance(fixture.paths.provenanceLedger);
		expect(settled.bridgePath).toBe(destination);
		expect(settled.bridgeCleanupPending).toBeUndefined();
		await expect(fs.stat(authority.detachedPath)).rejects.toMatchObject({ code: "ENOENT" });
	});

	test("public remove authenticates and replays a missing detached old root", async () => {
		const fixture = await makeFixture();
		await seedSkills(fixture.paths);
		await seedConfig(fixture.paths);
		const initial = await runPaseoSetup({}, fixture.deps);
		expect(initial.kind).toBe("install");
		const oldDir = fixture.paths.bridgeDir;
		const before = await readProvenance(fixture.paths.provenanceLedger);
		const newBridge = path.join(path.dirname(oldDir), "public-post-detach-relocated-paseo-skills");
		await fs.mkdir(newBridge);
		for (const name of SKILL_NAMES) {
			await fs.symlink(path.join(fixture.paths.agentsSkillsDir as string, name), path.join(newBridge, name));
		}
		const destinationRoot = await fs.lstat(newBridge, { bigint: true });
		const destinationIdentities = Object.fromEntries(
			await Promise.all(
				SKILL_NAMES.map(async name => {
					const stat = await fs.lstat(path.join(newBridge, name), { bigint: true });
					return [
						name,
						{
							dev: stat.dev.toString(),
							ino: stat.ino.toString(),
							size: stat.size.toString(),
							mtimeNs: stat.mtimeNs.toString(),
						},
					] as const;
				}),
			),
		);
		for (const name of SKILL_NAMES) await fs.unlink(path.join(oldDir, name));
		const captured = snapshotDirectoryTree(oldDir);
		if (!captured.ok || captured.snapshot === undefined) throw new Error("expected an empty bridge snapshot");
		const parent = await fs.lstat(path.dirname(oldDir), { bigint: true });
		const authority: BridgeCleanupAuthority = {
			originalPath: oldDir,
			detachedPath: `${oldDir}.removing`,
			parentIdentity: { dev: parent.dev.toString(), ino: parent.ino.toString() },
			snapshot: captured.snapshot,
		};
		await fs.rename(oldDir, authority.detachedPath);
		const after = {
			...before,
			bridgePath: newBridge,
			bridgeEntries: [...SKILL_NAMES],
			bridgeEntryIdentities: destinationIdentities,
			bridgeDirCreated: true,
			bridgeDirIdentity: {
				dev: destinationRoot.dev.toString(),
				ino: destinationRoot.ino.toString(),
				size: destinationRoot.size.toString(),
				mtimeNs: destinationRoot.mtimeNs.toString(),
			},
			bridgeCleanupPending: undefined,
		};
		await writeProvenance(fixture.paths.provenanceLedger, { ...before, bridgeCleanupPending: authority });
		await writeIntent(fixture.paths.intentRecord, {
			version: INTENT_VERSION,
			step: "skills-bridge",
			targetPath: newBridge,
			ownedKeys: ["paseo.skills-bridge"],
			targetPreflightIdentity: provenanceLedgerIdentity(before),
			targetExpectedIdentity: provenanceLedgerIdentity(before),
			provenancePath: fixture.paths.provenanceLedger,
			provenancePreflightIdentity: provenanceLedgerIdentity(before),
			provenanceExpectedIdentity: provenanceLedgerIdentity(after),
			provenancePayload: after,
			bridgePreflightPayload: before,
			startedAt: new Date().toISOString(),
		});

		const resumed = await runPaseoSetup(
			{ remove: true },
			{
				...fixture.deps,
				paths: { ...fixture.paths, bridgeDir: newBridge },
			},
		);
		expect(resumed.kind).toBe("remove");
		if (resumed.kind !== "remove") throw new Error("expected a remove outcome");
		expect(resumed.result.outcome).toBe("removed");
		await expect(fs.stat(authority.detachedPath)).rejects.toMatchObject({ code: "ENOENT" });
		expect((await readProvenance(fixture.paths.provenanceLedger)).bridgePath).toBeUndefined();
		expect(await readIntent(fixture.paths.intentRecord)).toBeUndefined();
	});

	test("public remove replays a detached cleanup authority even without an intent record", async () => {
		const fixture = await makeFixture(lsOk("gjc"));
		await seedSkills(fixture.paths);
		await seedConfig(fixture.paths);
		const initial = await runPaseoSetup({}, fixture.deps);
		expect(initial.kind).toBe("install");
		for (const name of SKILL_NAMES)
			await safeRm(path.join(fixture.paths.agentsSkillsDir as string, name), { recursive: true });
		const converged = await runPaseoSetup({}, fixture.deps);
		expect(converged.kind).toBe("install");
		const oldDir = fixture.paths.bridgeDir;
		const ledger = await readProvenance(fixture.paths.provenanceLedger);
		const captured = snapshotDirectoryTree(oldDir);
		if (!captured.ok || captured.snapshot === undefined) throw new Error("expected an empty bridge snapshot");
		const parent = await fs.lstat(path.dirname(oldDir), { bigint: true });
		const authority: BridgeCleanupAuthority = {
			originalPath: oldDir,
			detachedPath: `${oldDir}.removing`,
			parentIdentity: { dev: parent.dev.toString(), ino: parent.ino.toString() },
			snapshot: captured.snapshot,
		};
		await fs.rename(oldDir, authority.detachedPath);
		await writeProvenance(fixture.paths.provenanceLedger, { ...ledger, bridgeCleanupPending: authority });

		const removed = await runPaseoSetup({ remove: true }, fixture.deps);
		expect(removed.kind).toBe("remove");
		if (removed.kind !== "remove") throw new Error("expected a remove outcome");
		expect(removed.result.outcome).toBe("removed");
		await expect(fs.stat(authority.detachedPath)).rejects.toMatchObject({ code: "ENOENT" });
	});

	test("bridge source recovery commits completed adoption instead of clearing it", async () => {
		const fixture = await makeFixture();
		await seedSkills(fixture.paths);
		await seedConfig(fixture.paths);
		await runPaseoSetup({}, fixture.deps);
		const before = await readProvenance(fixture.paths.provenanceLedger);
		const relocatedSource = path.join(fixture.root, "adopted-skills");
		for (const name of SKILL_NAMES) {
			await fs.mkdir(path.join(relocatedSource, name), { recursive: true });
			await fs.writeFile(path.join(relocatedSource, name, "SKILL.md"), `# ${name}\n`);
			const linkPath = path.join(fixture.paths.bridgeDir, name);
			await fs.unlink(linkPath);
			await fs.symlink(path.join(relocatedSource, name), linkPath);
		}
		const bridgeEntryIdentities = Object.fromEntries(
			await Promise.all(
				SKILL_NAMES.map(async name => {
					const stat = await fs.lstat(path.join(fixture.paths.bridgeDir, name), { bigint: true });
					return [
						name,
						{
							dev: stat.dev.toString(),
							ino: stat.ino.toString(),
							size: stat.size.toString(),
							mtimeNs: stat.mtimeNs.toString(),
						},
					] as const;
				}),
			),
		);
		const planned = { ...before, bridgeSourceDir: relocatedSource, bridgeEntryIdentities };
		await writeIntent(fixture.paths.intentRecord, {
			version: INTENT_VERSION,
			step: "skills-bridge",
			targetPath: fixture.paths.bridgeDir,
			ownedKeys: ["paseo.skills-bridge"],
			targetPreflightIdentity: provenanceLedgerIdentity(before),
			targetExpectedIdentity: provenanceLedgerIdentity(before),
			provenancePath: fixture.paths.provenanceLedger,
			provenancePreflightIdentity: await currentIdentity(fixture.paths.provenanceLedger),
			provenanceExpectedIdentity: provenanceLedgerIdentity(planned),
			provenancePayload: planned,
			bridgePreflightPayload: before,
			startedAt: new Date().toISOString(),
		});

		const recovery = await recoverIntent(fixture.paths.intentRecord, {
			repair: true,
			expectedTargetPaths: [
				fixture.paths.configJson,
				fixture.paths.orchestrationPreferences,
				fixture.paths.bridgeDir,
			],
			expectedProvenancePath: fixture.paths.provenanceLedger,
		});
		expect(recovery?.recovered).toBe(true);
		expect((await readProvenance(fixture.paths.provenanceLedger)).bridgeSourceDir).toBe(relocatedSource);
		expect(await readIntent(fixture.paths.intentRecord)).toBeUndefined();
	});

	test("empty bridge preflight retains a foreign detached authority", async () => {
		const fixture = await makeFixture();
		await seedConfig(fixture.paths);
		const before = { version: 1, providerKeys: {}, seededOrchestrationKeys: {} };
		const planned = {
			...before,
			bridgePath: fixture.paths.bridgeDir,
			bridgeSourceDir: fixture.paths.agentsSkillsDir,
			bridgeEntries: [...SKILL_NAMES],
		};
		await fs.mkdir(`${fixture.paths.bridgeDir}.removing`, { recursive: true });
		await fs.mkdir(path.dirname(fixture.paths.provenanceLedger), { recursive: true });
		await fs.writeFile(fixture.paths.provenanceLedger, serializeJson(before));
		await writeIntent(fixture.paths.intentRecord, {
			version: INTENT_VERSION,
			step: "skills-bridge",
			targetPath: fixture.paths.bridgeDir,
			ownedKeys: ["paseo.skills-bridge"],
			targetPreflightIdentity: "absent",
			targetExpectedIdentity: "absent",
			provenancePath: fixture.paths.provenanceLedger,
			provenancePreflightIdentity: await currentIdentity(fixture.paths.provenanceLedger),
			provenanceExpectedIdentity: provenanceLedgerIdentity(planned),
			provenancePayload: planned,
			bridgePreflightPayload: before,
			startedAt: new Date().toISOString(),
		});

		const recovery = await recoverIntent(fixture.paths.intentRecord, {
			repair: true,
			expectedTargetPaths: [
				fixture.paths.configJson,
				fixture.paths.orchestrationPreferences,
				fixture.paths.bridgeDir,
			],
			expectedProvenancePath: fixture.paths.provenanceLedger,
		});
		expect(recovery?.recovered).toBe(false);
		expect(await readIntent(fixture.paths.intentRecord)).toBeDefined();
		await expect(fs.stat(`${fixture.paths.bridgeDir}.removing`)).resolves.toBeDefined();
	});

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

	test("remove repairs a committed target before reading ownership (#4644 review r19)", async () => {
		const fixture = await makeFixture(lsOk("gjc"));
		await seedSkills(fixture.paths);
		await seedConfig(fixture.paths);
		const beforeTarget = await readTarget(fixture.paths.configJson);
		const beforeLedger = await readProvenance(fixture.paths.provenanceLedger);
		const entry = buildProviderEntry([process.execPath, "acp"]);
		const afterParsed = JSON.parse(JSON.stringify(beforeTarget.parsed)) as Record<string, unknown>;
		(afterParsed.agents as { providers: Record<string, unknown> }).providers.gjc = entry;
		const afterTarget = serializeJson(afterParsed);
		const afterLedger = {
			...beforeLedger,
			providerKeys: { ...beforeLedger.providerKeys, gjc: providerEntryHash(entry) },
		};
		await fs.writeFile(fixture.paths.configJson, afterTarget);
		await writeIntent(fixture.paths.intentRecord, {
			version: INTENT_VERSION,
			step: "provider-config",
			targetPath: fixture.paths.configJson,
			ownedKeys: ["agents.providers.gjc"],
			targetPreflightIdentity: beforeTarget.identity,
			targetExpectedIdentity: hashBytes(afterTarget),
			provenancePath: fixture.paths.provenanceLedger,
			provenancePreflightIdentity: await currentIdentity(fixture.paths.provenanceLedger),
			provenanceExpectedIdentity: provenanceLedgerIdentity(afterLedger),
			provenancePayload: afterLedger,
			startedAt: new Date().toISOString(),
		});

		const remove = await runPaseoSetup({ remove: true }, fixture.deps);
		expect(remove.kind).toBe("remove");
		if (remove.kind !== "remove") throw new Error("expected a remove outcome");
		expect(remove.result.outcome).toBe("removed");
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

	test("discard recovery removes a generic publication backup and clears its authority", async () => {
		const { fixture, intent } = await intentFixture();
		const backupPath = `${fixture.paths.configJson}.gjc-bak-recovery-test`;
		const backupBytes = serializeJson({ before: true });
		await fs.writeFile(backupPath, backupBytes, { mode: 0o600 });
		await writeIntent(fixture.paths.intentRecord, {
			...intent,
			publishBackup: { backupPath, valueSha256: hashBytes(backupBytes) },
		});

		const recovery = await recoverIntent(fixture.paths.intentRecord, {
			repair: true,
			expectedTargetPaths: [
				fixture.paths.configJson,
				fixture.paths.orchestrationPreferences,
				fixture.paths.bridgeDir,
			],
			expectedProvenancePath: fixture.paths.provenanceLedger,
		});
		expect(recovery?.recovered).toBe(true);
		await expect(fs.stat(backupPath)).rejects.toMatchObject({ code: "ENOENT" });
		await expect(readIntent(fixture.paths.intentRecord)).resolves.toBeUndefined();
	});

	test("generic publication backup cleanup retains intent on a digest failure and retries safely", async () => {
		const { fixture, intent } = await intentFixture();
		const backupPath = `${fixture.paths.configJson}.gjc-bak-retry-test`;
		const backupBytes = serializeJson({ before: true });
		await fs.writeFile(backupPath, "tampered\n", { mode: 0o600 });
		await writeIntent(fixture.paths.intentRecord, {
			...intent,
			publishBackup: { backupPath, valueSha256: hashBytes(backupBytes) },
		});

		const refused = await recoverIntent(fixture.paths.intentRecord, {
			repair: true,
			expectedTargetPaths: [
				fixture.paths.configJson,
				fixture.paths.orchestrationPreferences,
				fixture.paths.bridgeDir,
			],
			expectedProvenancePath: fixture.paths.provenanceLedger,
		});
		expect(refused?.recovered).toBe(false);
		expect(refused?.detail).toContain("cleanup remains pending");
		await expect(readIntent(fixture.paths.intentRecord)).resolves.toBeDefined();

		await fs.writeFile(backupPath, backupBytes, { mode: 0o600 });
		const retried = await recoverIntent(fixture.paths.intentRecord, {
			repair: true,
			expectedTargetPaths: [
				fixture.paths.configJson,
				fixture.paths.orchestrationPreferences,
				fixture.paths.bridgeDir,
			],
			expectedProvenancePath: fixture.paths.provenanceLedger,
		});
		expect(retried?.recovered).toBe(true);
		await expect(fs.stat(backupPath)).rejects.toMatchObject({ code: "ENOENT" });
	});

	test("public install retains an interrupted generic backup on Windows without unauthenticated cleanup", async () => {
		const fixture = await makeFixture();
		await seedConfig(fixture.paths);
		const beforeTarget = await readTarget(fixture.paths.configJson);
		const beforeLedger: ProvenanceLedger = { version: 1, providerKeys: {}, seededOrchestrationKeys: {} };
		const afterTarget = serializeJson({ interrupted: true });
		const afterLedger: ProvenanceLedger = {
			...beforeLedger,
			providerKeys: { gjc: hashBytes(afterTarget) },
		};
		await writeProvenance(fixture.paths.provenanceLedger, beforeLedger);
		const backupPath = `${fixture.paths.configJson}.gjc-bak-windows-recovery`;
		const backupBytes = serializeJson({ preserved: true });
		await fs.writeFile(backupPath, backupBytes, { mode: 0o600 });
		await writeIntent(fixture.paths.intentRecord, {
			version: INTENT_VERSION,
			step: "provider-config",
			targetPath: fixture.paths.configJson,
			ownedKeys: ["agents.providers.gjc"],
			targetPreflightIdentity: beforeTarget.identity,
			targetExpectedIdentity: hashBytes(afterTarget),
			provenancePath: fixture.paths.provenanceLedger,
			provenancePreflightIdentity: provenanceLedgerIdentity(beforeLedger),
			provenanceExpectedIdentity: provenanceLedgerIdentity(afterLedger),
			provenancePayload: afterLedger,
			publishBackup: { backupPath, valueSha256: hashBytes(backupBytes) },
			startedAt: new Date().toISOString(),
		});
		const platform = Object.getOwnPropertyDescriptor(process, "platform");
		if (platform === undefined || platform.configurable !== true)
			throw new Error("process_platform_not_configurable");
		try {
			Object.defineProperty(process, "platform", { ...platform, value: "win32" });
			const result = await runPaseoSetup({}, fixture.deps);
			expect(result.kind).toBe("install");
			if (result.kind !== "install") throw new Error("expected an install outcome");
			expect(result.result.outcome).toBe("partial-install");
		} finally {
			Object.defineProperty(process, "platform", platform);
		}
		await expect(readIntent(fixture.paths.intentRecord)).resolves.toBeDefined();
		await expect(fs.stat(backupPath)).resolves.toBeDefined();
		expect(await fs.readFile(fixture.paths.configJson, "utf8")).toBe(beforeTarget.raw);
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

		const recovery = await recoverIntent(fixture.paths.intentRecord, {
			repair: true,
			expectedTargetPaths: [
				fixture.paths.configJson,
				fixture.paths.orchestrationPreferences,
				fixture.paths.bridgeDir,
			],
			expectedProvenancePath: fixture.paths.provenanceLedger,
		});
		expect(recovery?.recovered).toBe(false);
		expect(recovery?.detail).toContain("no ledger payload");
		expect(await readIntent(fixture.paths.intentRecord)).toBeDefined();
	});

	// Regression: a seed-if-empty step could never be recovered by retrying,
	// because its own publish removed the emptiness the step was gated on.
	test("complete-ledger commits the recorded payload instead of relying on a retry", async () => {
		const { fixture, intent } = await intentFixture();
		await fs.writeFile(fixture.paths.configJson, serializeJson({ after: true }));
		const pending = { version: 1, providerKeys: {}, seededOrchestrationKeys: { ui: "gjc" } };
		await writeIntent(fixture.paths.intentRecord, {
			...intent,
			provenanceExpectedIdentity: provenanceLedgerIdentity(pending),
			provenancePayload: pending,
		});

		const recovery = await recoverIntent(fixture.paths.intentRecord, {
			repair: true,
			expectedTargetPaths: [
				fixture.paths.configJson,
				fixture.paths.orchestrationPreferences,
				fixture.paths.bridgeDir,
			],
			expectedProvenancePath: fixture.paths.provenanceLedger,
		});
		expect(recovery?.recovered).toBe(true);
		expect((await readProvenance(fixture.paths.provenanceLedger)).seededOrchestrationKeys.ui).toBe("gjc");
		expect(await readIntent(fixture.paths.intentRecord)).toBeUndefined();
	});

	test("complete-ledger rejects an invalid payload without writing or clearing", async () => {
		const { fixture, intent } = await intentFixture();
		const pending = { version: 1, providerKeys: {}, seededOrchestrationKeys: { ui: "gjc" } };
		const validIntent = {
			...intent,
			provenanceExpectedIdentity: provenanceLedgerIdentity(pending),
			provenancePayload: pending,
		};
		await writeIntent(fixture.paths.intentRecord, validIntent);
		await fs.writeFile(fixture.paths.configJson, serializeJson({ after: true }));
		const tampered = serializeJson({
			...validIntent,
			provenancePayload: { ...pending, providerKeys: "not-a-record" },
		});
		await Bun.write(fixture.paths.intentRecord, tampered);
		const ledgerBefore = await fs.readFile(fixture.paths.provenanceLedger, "utf8");

		const recovery = await recoverIntent(fixture.paths.intentRecord, {
			repair: true,
			expectedTargetPaths: [
				fixture.paths.configJson,
				fixture.paths.orchestrationPreferences,
				fixture.paths.bridgeDir,
			],
			expectedProvenancePath: fixture.paths.provenanceLedger,
		});
		expect(recovery?.recovered).toBe(false);
		expect(recovery?.detail).toContain("corrupt");
		expect(await fs.readFile(fixture.paths.provenanceLedger, "utf8")).toBe(ledgerBefore);
		expect(await fs.readFile(fixture.paths.intentRecord, "utf8")).toBe(tampered);
	});

	test("complete-ledger rejects a payload digest mismatch without writing or clearing", async () => {
		const { fixture, intent } = await intentFixture();
		const pending = { version: 1, providerKeys: {}, seededOrchestrationKeys: { ui: "gjc" } };
		const validIntent = {
			...intent,
			provenanceExpectedIdentity: provenanceLedgerIdentity(pending),
			provenancePayload: pending,
		};
		await writeIntent(fixture.paths.intentRecord, validIntent);
		await fs.writeFile(fixture.paths.configJson, serializeJson({ after: true }));
		const tampered = serializeJson({ ...validIntent, provenanceExpectedIdentity: "0".repeat(64) });
		await Bun.write(fixture.paths.intentRecord, tampered);
		const ledgerBefore = await fs.readFile(fixture.paths.provenanceLedger, "utf8");

		const recovery = await recoverIntent(fixture.paths.intentRecord, {
			repair: true,
			expectedTargetPaths: [
				fixture.paths.configJson,
				fixture.paths.orchestrationPreferences,
				fixture.paths.bridgeDir,
			],
			expectedProvenancePath: fixture.paths.provenanceLedger,
		});
		expect(recovery?.recovered).toBe(false);
		expect(recovery?.detail).toContain("canonical digest");
		expect(await fs.readFile(fixture.paths.provenanceLedger, "utf8")).toBe(ledgerBefore);
		expect(await fs.readFile(fixture.paths.intentRecord, "utf8")).toBe(tampered);
	});

	test("a discardable intent is cleared under repair", async () => {
		const { fixture, intent } = await intentFixture();
		await writeIntent(fixture.paths.intentRecord, intent);

		const recovery = await recoverIntent(fixture.paths.intentRecord, {
			repair: true,
			expectedTargetPaths: [
				fixture.paths.configJson,
				fixture.paths.orchestrationPreferences,
				fixture.paths.bridgeDir,
			],
			expectedProvenancePath: fixture.paths.provenanceLedger,
		});
		expect(recovery?.recovered).toBe(true);
		expect(await readIntent(fixture.paths.intentRecord)).toBeUndefined();
	});

	test("repair refuses an intent target outside the trusted Paseo paths", async () => {
		const { fixture, intent } = await intentFixture();
		const victimConfig = path.join(fixture.root, "victim", "config.json");
		const victimSidecar = replacedProviderBackupPath(victimConfig, "gjc");
		await fs.mkdir(path.dirname(victimConfig), { recursive: true });
		await fs.writeFile(victimConfig, serializeJson({ victim: true }));
		await fs.writeFile(victimSidecar, serializeJson({ key: "gjc", value: { victim: true } }), { mode: 0o600 });
		await writeIntent(fixture.paths.intentRecord, {
			...intent,
			targetPath: victimConfig,
			targetPreflightIdentity: await currentIdentity(victimConfig),
			discardSidecar: {
				backupPath: victimSidecar,
				valueSha256: hashBytes(serializeJson({ key: "gjc", value: { victim: true } })),
			},
		});

		const recovery = await recoverIntent(fixture.paths.intentRecord, {
			repair: true,
			expectedTargetPaths: [
				fixture.paths.configJson,
				fixture.paths.orchestrationPreferences,
				fixture.paths.bridgeDir,
			],
			expectedProvenancePath: fixture.paths.provenanceLedger,
		});
		expect(recovery?.recovered).toBe(false);
		await expect(fs.stat(victimSidecar)).resolves.toBeDefined();
		expect(await readIntent(fixture.paths.intentRecord)).toBeDefined();
	});

	test("readIntent rejects an unsupported numeric version", async () => {
		const { fixture, intent } = await intentFixture();
		await writeIntent(fixture.paths.intentRecord, intent);
		const tampered = JSON.parse(await fs.readFile(fixture.paths.intentRecord, "utf8")) as Record<string, unknown>;
		tampered.version = INTENT_VERSION + 1;
		await fs.writeFile(fixture.paths.intentRecord, serializeJson(tampered));
		await expect(readIntent(fixture.paths.intentRecord)).rejects.toBeInstanceOf(IntentRecordCorruptError);
	});

	test("discard repair treats a sidecar deleted after authentication as success", async () => {
		const { fixture, intent } = await intentFixture();
		const sidecarPath = replacedProviderBackupPath(fixture.paths.configJson, "gjc");
		const sidecarBytes = serializeJson({ key: "gjc", value: { preserved: true } });
		await fs.writeFile(sidecarPath, sidecarBytes, { mode: 0o600 });
		await writeIntent(fixture.paths.intentRecord, {
			...intent,
			discardSidecar: { backupPath: sidecarPath, valueSha256: hashBytes(sidecarBytes) },
		});

		const realStat = fs.stat.bind(fs);
		let raced = false;
		const statImpl = async (target: any, options?: any) => {
			const observed = await realStat(target, options);
			if (!raced && String(target) === path.dirname(sidecarPath)) {
				raced = true;
				await fs.rm(sidecarPath);
			}
			return observed;
		};
		const statSpy = spyOn(fs, "stat").mockImplementation(statImpl as typeof fs.stat);
		try {
			const recovery = await recoverIntent(fixture.paths.intentRecord, {
				repair: true,
				expectedTargetPaths: [
					fixture.paths.configJson,
					fixture.paths.orchestrationPreferences,
					fixture.paths.bridgeDir,
				],
				expectedProvenancePath: fixture.paths.provenanceLedger,
			});
			expect(recovery?.recovered).toBe(true);
		} finally {
			statSpy.mockRestore();
		}
		expect(await readIntent(fixture.paths.intentRecord)).toBeUndefined();
		await expect(fs.stat(sidecarPath)).rejects.toMatchObject({ code: "ENOENT" });
	});

	test("discard intent refuses a sidecar outside the target config namespace", async () => {
		const { fixture, intent } = await intentFixture();
		const canonicalName = path.basename(replacedProviderBackupPath(fixture.paths.configJson, "gjc"));
		const sidecarPath = path.join(fixture.root, canonicalName);
		const sidecarBytes = serializeJson({ key: "gjc", value: { preserved: true } });
		await fs.writeFile(sidecarPath, sidecarBytes, { mode: 0o600 });
		await Bun.write(
			fixture.paths.intentRecord,
			serializeJson({
				...intent,
				discardSidecar: { backupPath: sidecarPath, valueSha256: hashBytes(sidecarBytes) },
			}),
		);
		const intentBytes = await fs.readFile(fixture.paths.intentRecord, "utf8");

		const recovery = await recoverIntent(fixture.paths.intentRecord, {
			repair: true,
			expectedTargetPaths: [
				fixture.paths.configJson,
				fixture.paths.orchestrationPreferences,
				fixture.paths.bridgeDir,
			],
			expectedProvenancePath: fixture.paths.provenanceLedger,
		});
		expect(recovery?.recovered).toBe(false);
		expect(recovery?.detail).toContain("corrupt");
		await expect(readIntent(fixture.paths.intentRecord)).rejects.toBeInstanceOf(IntentRecordCorruptError);
		expect(await fs.readFile(fixture.paths.intentRecord, "utf8")).toBe(intentBytes);
		expect(await fs.readFile(sidecarPath, "utf8")).toBe(sidecarBytes);
	});

	test("discard repair removes the authenticated sidecar before clearing the intent", async () => {
		const { fixture, intent } = await intentFixture();
		const sidecarPath = replacedProviderBackupPath(fixture.paths.configJson, "gjc");
		const sidecarBytes = serializeJson({ key: "gjc", value: { preserved: true } });
		await fs.writeFile(sidecarPath, sidecarBytes, { mode: 0o600 });
		await writeIntent(fixture.paths.intentRecord, {
			...intent,
			discardSidecar: { backupPath: sidecarPath, valueSha256: hashBytes(sidecarBytes) },
		});

		const recovery = await recoverIntent(fixture.paths.intentRecord, {
			repair: true,
			expectedTargetPaths: [
				fixture.paths.configJson,
				fixture.paths.orchestrationPreferences,
				fixture.paths.bridgeDir,
			],
			expectedProvenancePath: fixture.paths.provenanceLedger,
		});
		expect(recovery?.recovered).toBe(true);
		expect(await readIntent(fixture.paths.intentRecord)).toBeUndefined();
		await expect(fs.stat(sidecarPath)).rejects.toMatchObject({ code: "ENOENT" });
	});

	test("discard repair retains the intent and sidecar on a digest mismatch", async () => {
		const { fixture, intent } = await intentFixture();
		const sidecarPath = replacedProviderBackupPath(fixture.paths.configJson, "gjc");
		const sidecarBytes = serializeJson({ key: "gjc", value: { preserved: true } });
		await fs.writeFile(sidecarPath, sidecarBytes, { mode: 0o600 });
		await writeIntent(fixture.paths.intentRecord, {
			...intent,
			discardSidecar: { backupPath: sidecarPath, valueSha256: "0".repeat(64) },
		});

		const recovery = await recoverIntent(fixture.paths.intentRecord, {
			repair: true,
			expectedTargetPaths: [
				fixture.paths.configJson,
				fixture.paths.orchestrationPreferences,
				fixture.paths.bridgeDir,
			],
			expectedProvenancePath: fixture.paths.provenanceLedger,
		});
		expect(recovery?.recovered).toBe(false);
		expect(recovery?.detail).toContain("discard sidecar cleanup failed");
		expect(await readIntent(fixture.paths.intentRecord)).toBeDefined();
		expect(await fs.readFile(sidecarPath, "utf8")).toBe(sidecarBytes);
	});

	test("discard repair retains the intent when the authenticated sidecar unlink loses its race", async () => {
		const { fixture, intent } = await intentFixture();
		const sidecarPath = replacedProviderBackupPath(fixture.paths.configJson, "gjc");
		const sidecarBytes = serializeJson({ key: "gjc", value: { preserved: true } });
		await fs.writeFile(sidecarPath, sidecarBytes, { mode: 0o600 });
		await writeIntent(fixture.paths.intentRecord, {
			...intent,
			discardSidecar: { backupPath: sidecarPath, valueSha256: hashBytes(sidecarBytes) },
		});

		const realStat = fs.stat.bind(fs);
		let raced = false;
		const statImpl = async (target: any, options?: any) => {
			const observed = await realStat(target, options);
			if (!raced && String(target) === path.dirname(sidecarPath)) {
				raced = true;
				await fs.writeFile(sidecarPath, "successor", { mode: 0o600 });
			}
			return observed;
		};
		const statSpy = spyOn(fs, "stat").mockImplementation(statImpl as typeof fs.stat);
		try {
			const recovery = await recoverIntent(fixture.paths.intentRecord, {
				repair: true,
				expectedTargetPaths: [
					fixture.paths.configJson,
					fixture.paths.orchestrationPreferences,
					fixture.paths.bridgeDir,
				],
				expectedProvenancePath: fixture.paths.provenanceLedger,
			});
			expect(recovery?.recovered).toBe(false);
			expect(recovery?.detail).toContain("discard sidecar cleanup failed");
		} finally {
			statSpy.mockRestore();
		}
		expect(await readIntent(fixture.paths.intentRecord)).toBeDefined();
		expect(await fs.readFile(sidecarPath, "utf8")).toBe("successor");
	});

	test("check-mode recovery never mutates the intent", async () => {
		const { fixture, intent } = await intentFixture();
		await writeIntent(fixture.paths.intentRecord, intent);

		const recovery = await recoverIntent(fixture.paths.intentRecord, {
			repair: false,
			expectedTargetPaths: [
				fixture.paths.configJson,
				fixture.paths.orchestrationPreferences,
				fixture.paths.bridgeDir,
			],
			expectedProvenancePath: fixture.paths.provenanceLedger,
		});
		expect(recovery?.recovered).toBe(false);
		expect(await readIntent(fixture.paths.intentRecord)).toBeDefined();
	});

	test("a refusal is never repaired even under repair", async () => {
		const { fixture, intent } = await intentFixture();
		await fs.writeFile(fixture.paths.provenanceLedger, serializeJson({ someone: "else" }));
		await writeIntent(fixture.paths.intentRecord, intent);

		const recovery = await recoverIntent(fixture.paths.intentRecord, {
			repair: true,
			expectedTargetPaths: [
				fixture.paths.configJson,
				fixture.paths.orchestrationPreferences,
				fixture.paths.bridgeDir,
			],
			expectedProvenancePath: fixture.paths.provenanceLedger,
		});
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
