import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { YAML } from "bun";
import { projectSharedStateRoot } from "../../src/gjc-runtime/session-layout";
import {
	extractWorkflowSetting,
	resolveWorkflowSetting,
	WorkflowSettingError,
	type WorkflowSettingKey,
} from "../../src/gjc-runtime/workflow-settings";

const KEY: WorkflowSettingKey = "gjc.ralplan.maxIterations";
const PROBE = path.join(import.meta.dir, "../fixtures/workflow-settings-probe.ts");

const stringParse = (value: unknown) =>
	typeof value === "string"
		? { kind: "valid" as const, value }
		: { kind: "invalid" as const, reason: "expected string" };

const temporaryDirectories: string[] = [];

async function tempDir(): Promise<string> {
	const directory = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-workflow-settings-"));
	temporaryDirectories.push(directory);
	return directory;
}

afterEach(async () => {
	await Promise.all(
		temporaryDirectories.splice(0).map(directory => fs.rm(directory, { recursive: true, force: true })),
	);
});

async function writeProjectConfig(cwd: string, document: unknown): Promise<string> {
	const projectDir = path.join(cwd, ".gjc");
	await fs.mkdir(projectDir, { recursive: true });
	const configPath = path.join(projectDir, "config.yml");
	await fs.writeFile(configPath, YAML.stringify(document, null, 2));
	return configPath;
}

async function writeProjectSettings(cwd: string, document: unknown): Promise<string> {
	const projectDir = path.join(cwd, ".gjc");
	await fs.mkdir(projectDir, { recursive: true });
	const settingsPath = path.join(projectDir, "settings.json");
	await fs.writeFile(settingsPath, JSON.stringify(document, null, 2));
	return settingsPath;
}

async function resolveIn(
	cwd: string,
	env: Record<string, string | undefined>,
	key: string = KEY,
	options: { strict?: boolean; agentDir?: string } = {},
): Promise<{ value: unknown; source: string; diagnostics: unknown[]; threw?: boolean; message?: string }> {
	const args = [process.execPath, PROBE, key, ...(options.strict ? ["--strict"] : [])];
	if (options.agentDir) args.push("--agent-dir", options.agentDir);
	const proc = Bun.spawn(args, {
		cwd,
		env: {
			...process.env,
			// Child probes must not inherit a runner's custom agent profile;
			// individual tests opt in explicitly when that behavior is under test.
			GJC_CODING_AGENT_DIR: undefined,
			PI_CODING_AGENT_DIR: undefined,
			...env,
		},
		stdout: "pipe",
		stderr: "pipe",
	});
	const [out, err] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
	if ((await proc.exited) !== 0) throw new Error(`probe failed: ${err}`);
	return JSON.parse(out.trim()) as { value: unknown; source: string; diagnostics: unknown[] };
}

describe("workflow-settings resolver", () => {
	test("falls back to the retained project settings.json while project config.yml is absent", async () => {
		const cwd = await tempDir();
		const agentDir = await tempDir();
		// The migration could not publish (e.g. a read-only .gjc): only the
		// retained legacy settings.json exists and its override stays effective.
		await writeProjectSettings(cwd, { "gjc.ralplan.maxIterations": 7 });

		const result = await resolveIn(cwd, { GJC_CODING_AGENT_DIR: agentDir });
		expect(result.value).toBe(7);
		expect(result.source.endsWith(path.join(".gjc", "settings.json"))).toBe(true);
	});

	test("the legacy fallback stays active while no ownership marker records the migrated key", async () => {
		const cwd = await tempDir();
		const agentDir = await tempDir();
		// Both migration targets exist but do NOT contain the workflow key, and no
		// migrated-keys marker records ownership: the migration is incomplete (its
		// publication could not be durably recorded - e.g. an unwritable project
		// `.gjc` or config root rejected the write, so the source was retained),
		// and the retained legacy override must stay effective instead of silently
		// dropping to the default.
		await writeProjectConfig(cwd, { theme: { dark: "red" } });
		await writeProjectSettings(cwd, { "gjc.ralplan.maxIterations": 7 });
		await fs.writeFile(path.join(agentDir, "config.yml"), YAML.stringify({ theme: { dark: "red" } }, null, 2));

		const result = await resolveIn(cwd, { GJC_CODING_AGENT_DIR: agentDir });
		expect(result.value).toBe(7);
		expect(result.source.endsWith(path.join(".gjc", "settings.json"))).toBe(true);
	});

	test("a present migration target with a durable ownership marker suppresses the legacy fallback", async () => {
		const cwd = await tempDir();
		const agentDir = await tempDir();
		const home = await tempDir();
		// Both targets exist and the migrated-keys marker durably records the key:
		// the migration completed, so the retained legacy value is retired - a
		// later `gjc config unset` must stick even while the target stays present.
		await writeProjectConfig(cwd, { theme: { dark: "red" } });
		await writeProjectSettings(cwd, { "gjc.ralplan.maxIterations": 7 });
		await fs.mkdir(projectSharedStateRoot(cwd, agentDir), { recursive: true });
		await fs.writeFile(
			path.join(projectSharedStateRoot(cwd, agentDir), "settings.json.migrated-keys"),
			JSON.stringify(["gjc.ralplan.maxIterations"]),
		);
		await fs.writeFile(path.join(agentDir, "config.yml"), YAML.stringify({ theme: { dark: "red" } }, null, 2));

		const result = await resolveIn(cwd, { GJC_CODING_AGENT_DIR: agentDir, HOME: home, GJC_CONFIG_DIR: ".gjc" });
		expect(result.value).toBe("default");
		expect(result.source).toBe("default");
	});

	test("owned keys do not exit 2 on a malformed retained source", async () => {
		const cwd = await tempDir();
		const agentDir = await tempDir();
		const home = await tempDir();
		// Every strict ralplan key is already owned (migrated-keys marker) and
		// `gjc config unset` removed the key from config.yml; the retained source
		// is later corrupted. The strict resolver must fall through to the
		// default instead of exiting 2 on the stale malformed marker or the
		// pre-ownership JSON parse of the legacy source.
		await writeProjectConfig(cwd, { theme: { dark: "red" } });
		await fs.writeFile(path.join(cwd, ".gjc", "settings.json"), "{ corrupted");
		await fs.mkdir(projectSharedStateRoot(cwd, agentDir), { recursive: true });
		await fs.writeFile(
			path.join(projectSharedStateRoot(cwd, agentDir), "settings.json.migrated-keys"),
			JSON.stringify(["gjc.ralplan.maxIterations", "gjc.ralplan.autoHandoff", "gjc.ralplan.maxReviewPassesPerLane"]),
		);
		await fs.writeFile(path.join(agentDir, "config.yml"), YAML.stringify({ theme: { dark: "red" } }, null, 2));

		const result = await resolveIn(cwd, { GJC_CODING_AGENT_DIR: agentDir, HOME: home, GJC_CONFIG_DIR: ".gjc" }, KEY, {
			strict: true,
		});
		expect(result.value).toBe("default");
		expect(result.threw).toBeUndefined();
	});
	test("the session agent directory overrides the process-global agent layer", async () => {
		const cwd = await tempDir();
		const defaultAgentDir = await tempDir();
		const tenantAgentDir = await tempDir();
		const home = await tempDir();
		// An SDK embedder created the session with `createAgentSession({ agentDir:
		// tenant })`: Settings.init loads/migrates the tenant profile, so the
		// resolver must read THAT config.yml - not the process-global default
		// profile a CLI flow would use.
		await writeProjectConfig(cwd, { theme: { dark: "red" } });
		await fs.mkdir(defaultAgentDir, { recursive: true });
		await fs.writeFile(
			path.join(defaultAgentDir, "config.yml"),
			YAML.stringify({ gjc: { ralplan: { maxIterations: 7 } } }, null, 2),
		);
		await fs.mkdir(tenantAgentDir, { recursive: true });
		await fs.writeFile(
			path.join(tenantAgentDir, "config.yml"),
			YAML.stringify({ gjc: { ralplan: { maxIterations: 9 } } }, null, 2),
		);

		// The process-global env points at the DEFAULT profile; the explicit
		// session agentDir must win.
		const result = await resolveIn(
			cwd,
			{ GJC_CODING_AGENT_DIR: defaultAgentDir, HOME: home, GJC_CONFIG_DIR: ".gjc" },
			KEY,
			{
				agentDir: tenantAgentDir,
			},
		);
		expect(result.value).toBe(9);
		expect(result.source).toContain(tenantAgentDir);
	});
	test("an unreadable legacy config-root source fails closed under strict policy", async () => {
		const cwd = await tempDir();
		const agentDir = await tempDir();
		const home = await tempDir();
		// A legacy config-root settings.json exists under a config root the
		// resolver cannot enter (EACCES on stat): the strict ralplan contract
		// must surface the unreadable explicit source (exit 2) instead of
		// treating it as absence and falling through to the default.
		await writeProjectConfig(cwd, { theme: { dark: "red" } });
		const configRoot = path.join(home, ".gjc");
		await fs.mkdir(path.join(configRoot, "agent"), { recursive: true });
		await fs.writeFile(path.join(configRoot, "settings.json"), JSON.stringify({ "gjc.ralplan.maxIterations": 7 }));
		// Deny access to the config root so `stat` of the legacy source fails
		// with EACCES (a file-mode 000 would not block stat itself).
		await fs.chmod(configRoot, 0o000);
		try {
			const result = await resolveIn(
				cwd,
				{ GJC_CODING_AGENT_DIR: agentDir, HOME: home, GJC_CONFIG_DIR: ".gjc" },
				KEY,
				{ strict: true },
			);
			expect(result.threw).toBe(true);
		} finally {
			await fs.chmod(configRoot, 0o700);
		}
	});
	test("an isolated session profile does not inherit the machine-global legacy source", async () => {
		const cwd = await tempDir();
		const defaultAgentDir = await tempDir();
		const tenantAgentDir = await tempDir();
		const home = await tempDir();
		// The host's machine-global config-root legacy holds a value, but the
		// isolated SDK/tenant profile's config.yml omits the key: the tenant
		// must fall through to the default instead of inheriting the host's
		// legacy override (the migration refuses to consume the machine-global
		// source for custom scopes, so applying it here would defeat profile
		// isolation).
		await writeProjectConfig(cwd, { theme: { dark: "red" } });
		const configRoot = path.join(home, ".gjc");
		await fs.mkdir(path.join(configRoot, "agent"), { recursive: true });
		await fs.writeFile(path.join(configRoot, "settings.json"), JSON.stringify({ "gjc.ralplan.maxIterations": 7 }));
		await fs.mkdir(defaultAgentDir, { recursive: true });
		await fs.writeFile(
			path.join(defaultAgentDir, "config.yml"),
			YAML.stringify({ gjc: { ralplan: { maxIterations: 7 } } }, null, 2),
		);
		await fs.mkdir(tenantAgentDir, { recursive: true });
		await fs.writeFile(path.join(tenantAgentDir, "config.yml"), YAML.stringify({ theme: { dark: "red" } }, null, 2));

		const result = await resolveIn(
			cwd,
			{ GJC_CODING_AGENT_DIR: defaultAgentDir, HOME: home, GJC_CONFIG_DIR: ".gjc" },
			KEY,
			{ agentDir: tenantAgentDir },
		);
		expect(result.value).toBe("default");
		expect(result.source).toBe("default");
	});
	test("an isolated session profile does not inherit the machine-global strict evidence", async () => {
		const cwd = await tempDir();
		const defaultAgentDir = await tempDir();
		const tenantAgentDir = await tempDir();
		const home = await tempDir();
		// The host's machine-global config-root retained STRICT evidence (an
		// invalid legacy value once kept exit 2 for the global profile), but an
		// isolated SDK/tenant profile must fall through to its own defaults
		// instead of failing on the host's retained failure.
		await writeProjectConfig(cwd, { theme: { dark: "red" } });
		const configRoot = path.join(home, ".gjc");
		await fs.mkdir(path.join(configRoot, "agent"), { recursive: true });
		await fs.writeFile(
			path.join(configRoot, "settings.json.strict-invalid"),
			JSON.stringify({
				version: 2,
				keys: [{ key: "gjc.ralplan.maxIterations", value: "invalid" }],
				source: path.join(configRoot, "settings.json"),
			}),
		);
		await fs.mkdir(defaultAgentDir, { recursive: true });
		await fs.writeFile(
			path.join(defaultAgentDir, "config.yml"),
			YAML.stringify({ gjc: { ralplan: { maxIterations: 7 } } }, null, 2),
		);
		await fs.mkdir(tenantAgentDir, { recursive: true });
		await fs.writeFile(path.join(tenantAgentDir, "config.yml"), YAML.stringify({ theme: { dark: "red" } }, null, 2));

		const result = await resolveIn(
			cwd,
			{ GJC_CODING_AGENT_DIR: defaultAgentDir, HOME: home, GJC_CONFIG_DIR: ".gjc" },
			KEY,
			{ strict: true, agentDir: tenantAgentDir },
		);
		expect(result.threw).toBeUndefined();
		expect(result.value).toBe("default");
	});

	test("an unreadable ownership marker fails closed instead of resurrecting the retained value", async () => {
		const cwd = await tempDir();
		const agentDir = await tempDir();
		const home = await tempDir();
		// A migrated key was unset from project config.yml; the retained legacy
		// settings.json still holds an INVALID strict value. The ownership marker
		// exists but is UNREADABLE: resolving must fail closed on the marker read
		// instead of treating it as unowned and reactivating the stale value
		// (which would make ralplan exit 2 again).
		await writeProjectConfig(cwd, { theme: { dark: "red" } });
		await writeProjectSettings(cwd, { "gjc.ralplan.maxIterations": "invalid" });
		await fs.mkdir(projectSharedStateRoot(cwd, agentDir), { recursive: true });
		await fs.writeFile(
			path.join(projectSharedStateRoot(cwd, agentDir), "settings.json.migrated-keys"),
			JSON.stringify(["gjc.ralplan.maxIterations"]),
		);
		await fs.mkdir(agentDir, { recursive: true });
		await fs.chmod(projectSharedStateRoot(cwd, agentDir), 0o000);
		try {
			const result = await resolveIn(
				cwd,
				{ GJC_CODING_AGENT_DIR: agentDir, HOME: home, GJC_CONFIG_DIR: ".gjc" },
				KEY,
				{ strict: true },
			);
			expect(result.threw).toBe(true);
			expect(result.message ?? "").toContain("EACCES");
		} finally {
			await fs.chmod(projectSharedStateRoot(cwd, agentDir), 0o700);
		}
	});

	test("parses a legacy settings.json fallback as JSON, not YAML", async () => {
		const cwd = await tempDir();
		const agentDir = await tempDir();
		// Unquoted keys are valid YAML but INVALID JSON: the legacy file contract
		// requires JSON, so a tolerant resolver must not pick up this value.
		await fs.mkdir(path.join(cwd, ".gjc"), { recursive: true });
		await fs.writeFile(path.join(cwd, ".gjc", "settings.json"), "{ gjc: { ralplan: { maxIterations: 7 } } }");

		const result = await resolveIn(cwd, { GJC_CODING_AGENT_DIR: agentDir });
		expect(result.value).toBe("default");
		// A strict ralplan caller fails closed on the malformed JSON instead of
		// silently using the value or bypassing the malformed-source evidence.
		const strict = await resolveIn(cwd, { GJC_CODING_AGENT_DIR: agentDir }, KEY, { strict: true });
		expect(strict.threw).toBe(true);
	});

	test("a future-schema project config.yml keeps the legacy fallback active", async () => {
		const cwd = await tempDir();
		const agentDir = await tempDir();
		// The project migration skipped the read-only future-schema target
		// (settings.ts future-schema guard), so the migration is incomplete and
		// the retained legacy value still applies.
		await writeProjectConfig(cwd, { configSchemaVersion: 9999, theme: { dark: "red" } });
		await writeProjectSettings(cwd, { "gjc.ralplan.maxIterations": 7 });
		await fs.writeFile(path.join(agentDir, "config.yml"), YAML.stringify({ theme: { dark: "red" } }, null, 2));

		const result = await resolveIn(cwd, { GJC_CODING_AGENT_DIR: agentDir });
		expect(result.value).toBe(7);
	});

	test("a future-schema agent config.yml keeps the config-root legacy fallback active", async () => {
		const home = await tempDir();
		const cwd = await tempDir();
		await fs.mkdir(path.join(home, ".myconfig", "agent"), { recursive: true });
		await fs.writeFile(
			path.join(home, ".myconfig", "agent", "config.yml"),
			YAML.stringify({ configSchemaVersion: 9999, theme: { dark: "red" } }, null, 2),
		);
		await fs.writeFile(
			path.join(home, ".myconfig", "settings.json"),
			JSON.stringify({ "gjc.ralplan.maxIterations": 7 }),
		);

		const result = await resolveIn(cwd, { HOME: home, GJC_CONFIG_DIR: ".myconfig" });
		expect(result.value).toBe(7);
	});

	test("a migrated-keys marker suppresses the legacy fallback after config.yml is deleted", async () => {
		const cwd = await tempDir();
		const agentDir = await tempDir();
		const home = await tempDir();
		// The key was migrated (recorded in the ownership marker) and config.yml
		// was then deleted: the removal must stick, not resurrect the retained
		// legacy value. The agent target exists so the config-root legacy is off.
		await writeProjectSettings(cwd, { "gjc.ralplan.maxIterations": 7 });
		await fs.mkdir(projectSharedStateRoot(cwd, agentDir), { recursive: true });
		await fs.writeFile(
			path.join(projectSharedStateRoot(cwd, agentDir), "settings.json.migrated-keys"),
			JSON.stringify(["gjc.ralplan.maxIterations"]),
		);
		await fs.writeFile(path.join(agentDir, "config.yml"), YAML.stringify({ theme: { dark: "red" } }, null, 2));

		const result = await resolveIn(cwd, { GJC_CODING_AGENT_DIR: agentDir, HOME: home, GJC_CONFIG_DIR: ".gjc" });
		expect(result.value).toBe("default");
		expect(result.source).toBe("default");
	});

	test("the config-root legacy fallback is suppressed for project-owned keys in a collision", async () => {
		const home = await tempDir();
		// cwd = home: the config-root source aliases the project source.
		await fs.mkdir(path.join(home, ".gjc"), { recursive: true });
		const source = path.join(home, ".gjc", "settings.json");
		await fs.writeFile(source, JSON.stringify({ "gjc.ralplan.maxIterations": 7 }));
		// The key was project-migrated and unset; the agent config.yml is absent,
		// so the aliasing config-root legacy candidate would otherwise resurrect
		// the stale value at agent precedence.
		await fs.mkdir(projectSharedStateRoot(home, path.join(home, ".gjc", "agent")), { recursive: true });
		await fs.writeFile(
			path.join(projectSharedStateRoot(home, path.join(home, ".gjc", "agent")), "settings.json.migrated-keys"),
			JSON.stringify(["gjc.ralplan.maxIterations"]),
		);

		const result = await resolveIn(home, { HOME: home, GJC_CONFIG_DIR: ".gjc" });
		expect(result.value).toBe("default");
		expect(result.source).toBe("default");
	});

	test("the config-root legacy fallback is suppressed for project-owned keys via symlink aliases", async () => {
		const home = await tempDir();
		const cwd = await tempDir();
		// The project settings.json is a SYMLINK to the config-root source: the
		// migration treats them as one file by dev/ino, and the resolver's
		// aliasing guard must too.
		await fs.mkdir(path.join(home, ".myconfig"), { recursive: true });
		await fs.writeFile(
			path.join(home, ".myconfig", "settings.json"),
			JSON.stringify({ "gjc.ralplan.maxIterations": 7 }),
		);
		await fs.mkdir(path.join(cwd, ".gjc"), { recursive: true });
		await fs.symlink(path.join(home, ".myconfig", "settings.json"), path.join(cwd, ".gjc", "settings.json"));
		// The key was project-migrated and unset.
		await fs.mkdir(projectSharedStateRoot(cwd, path.join(home, ".myconfig", "agent")), { recursive: true });
		await fs.writeFile(
			path.join(projectSharedStateRoot(cwd, path.join(home, ".myconfig", "agent")), "settings.json.migrated-keys"),
			JSON.stringify(["gjc.ralplan.maxIterations"]),
		);

		const result = await resolveIn(cwd, { HOME: home, GJC_CONFIG_DIR: ".myconfig" });
		expect(result.value).toBe("default");
		expect(result.source).toBe("default");
	});

	test("project .gjc/config.yml wins over the built-in default", async () => {
		const cwd = await tempDir();
		// A non-numeric string is preserved (no schema number coercion applies).
		await writeProjectConfig(cwd, { gjc: { ralplan: { maxIterations: "seven" } } });

		const result = await resolveWorkflowSetting(cwd, KEY, { defaultValue: "default", parse: stringParse });
		expect(result.value).toBe("seven");
		expect(result.source).toBe(path.join(cwd, ".gjc", "config.yml"));
	});

	test("project .gjc/config.yml beats user agent config.yml", async () => {
		const cwd = await tempDir();
		const agentDir = await tempDir();
		await writeProjectConfig(cwd, { gjc: { ralplan: { maxIterations: "project-wins" } } });
		await fs.writeFile(
			path.join(agentDir, "config.yml"),
			YAML.stringify({ gjc: { ralplan: { maxIterations: "agent-loses" } } }, null, 2),
		);

		const result = await resolveIn(cwd, { GJC_CODING_AGENT_DIR: agentDir });
		expect(result.value).toBe("project-wins");
		expect(result.source).toBe(path.join(cwd, ".gjc", "config.yml"));
	});

	test("user agent config.yml wins over the built-in default", async () => {
		const cwd = await tempDir();
		const agentDir = await tempDir();
		await fs.writeFile(
			path.join(agentDir, "config.yml"),
			YAML.stringify({ gjc: { ralplan: { maxIterations: "agent" } } }, null, 2),
		);

		const result = await resolveIn(cwd, { GJC_CODING_AGENT_DIR: agentDir });
		expect(result.value).toBe("agent");
		expect(result.source).toBe(path.join(agentDir, "config.yml"));
	});

	test("a legacy project settings.json applies while project config.yml is absent", async () => {
		const cwd = await tempDir();
		// No migration target exists, so the retained legacy override stays
		// effective (a migration that could not publish must not silently drop it).
		await writeProjectSettings(cwd, { "gjc.ralplan.maxIterations": "legacy-json" });

		const result = await resolveWorkflowSetting(cwd, KEY, { defaultValue: "default", parse: stringParse });
		expect(result.value).toBe("legacy-json");
		expect(result.source.endsWith(path.join(".gjc", "settings.json"))).toBe(true);
	});

	test("a legacy config-root settings.json applies while the agent config.yml is absent", async () => {
		const home = await tempDir();
		const cwd = await tempDir();
		await fs.mkdir(path.join(home, ".myconfig"), { recursive: true });
		await fs.writeFile(
			path.join(home, ".myconfig", "settings.json"),
			JSON.stringify({ "gjc.ralplan.maxIterations": "root" }),
		);

		const result = await resolveIn(cwd, { HOME: home, GJC_CONFIG_DIR: ".myconfig" });
		expect(result.value).toBe("root");
		expect(result.source.endsWith(path.join(".myconfig", "settings.json"))).toBe(true);
	});

	test("strict resolution throws on retained strict-invalid evidence from config-root", async () => {
		const home = await tempDir();
		const cwd = await tempDir();
		await fs.mkdir(path.join(home, ".myconfig"), { recursive: true });
		// Evidence written by the config-root migration when it aborts on an
		// invalid STRICT ralplan legacy value and retains the source.
		await fs.writeFile(
			path.join(home, ".myconfig", "settings.json.strict-invalid"),
			JSON.stringify({
				version: 1,
				key: "gjc.ralplan.maxIterations",
				value: "bad",
				source: path.join(home, ".myconfig", "settings.json"),
			}),
		);

		// Tolerant callers (ultragoal/deep-interview) do not surface it.
		const tolerant = await resolveIn(cwd, { HOME: home, GJC_CONFIG_DIR: ".myconfig" });
		expect(tolerant.value).toBe("default");

		// Strict callers (ralplan) must fail loudly instead of silently falling
		// back to defaults while the retained invalid source is un-repaired.
		const strict = await resolveIn(cwd, { HOME: home, GJC_CONFIG_DIR: ".myconfig" }, KEY, { strict: true });
		expect(strict.threw).toBe(true);
		expect(strict.message).toContain("retained invalid gjc.ralplan.maxIterations");

		// Evidence for a DIFFERENT key does not affect this key's resolution.
		await fs.writeFile(
			path.join(home, ".myconfig", "settings.json.strict-invalid"),
			JSON.stringify({
				version: 1,
				key: "gjc.ralplan.autoHandoff",
				value: "bad",
				source: path.join(home, ".myconfig", "settings.json"),
			}),
		);
		const otherKey = await resolveIn(cwd, { HOME: home, GJC_CONFIG_DIR: ".myconfig" }, KEY, { strict: true });
		expect(otherKey.threw).toBeUndefined();
		expect(otherKey.value).toBe("default");
	});

	test("a valid project config.yml override wins over retained agent-layer evidence", async () => {
		const home = await tempDir();
		const cwd = await tempDir();
		await fs.mkdir(path.join(home, ".myconfig"), { recursive: true });
		// Agent-layer (config-root) retention evidence exists, but the project
		// layer has a valid override: the project value must win and the
		// evidence must not throw before it is read.
		await fs.writeFile(
			path.join(home, ".myconfig", "settings.json.strict-invalid"),
			JSON.stringify({
				version: 1,
				key: "gjc.ralplan.maxIterations",
				value: "bad",
				source: path.join(home, ".myconfig", "settings.json"),
			}),
		);
		await writeProjectConfig(cwd, { gjc: { ralplan: { maxIterations: 7 } } });

		const strict = await resolveIn(cwd, { HOME: home, GJC_CONFIG_DIR: ".myconfig" }, KEY, { strict: true });
		expect(strict.threw).toBeUndefined();
		expect(strict.value).toBe(7);
	});

	test("strict resolution throws on retained project evidence after the project layer yields nothing", async () => {
		const home = await tempDir();
		const cwd = await tempDir();
		await fs.mkdir(path.join(home, ".myconfig"), { recursive: true });
		await fs.mkdir(path.join(cwd, ".gjc"), { recursive: true });
		await fs.mkdir(projectSharedStateRoot(cwd, path.join(home, ".myconfig", "agent")), { recursive: true });
		// Project-layer retention evidence (from the project migration retaining
		// an invalid strict ralplan legacy value).
		await fs.writeFile(
			path.join(projectSharedStateRoot(cwd, path.join(home, ".myconfig", "agent")), "settings.json.strict-invalid"),
			JSON.stringify({
				version: 1,
				key: "gjc.ralplan.maxIterations",
				value: "bad",
				source: path.join(cwd, ".gjc", "settings.json"),
			}),
		);

		const strict = await resolveIn(cwd, { HOME: home, GJC_CONFIG_DIR: ".myconfig" }, KEY, { strict: true });
		expect(strict.threw).toBe(true);
		expect(strict.message).toContain("retained invalid gjc.ralplan.maxIterations");

		// A valid project config.yml value is still honored (project evidence is
		// only consulted when the project layer produced nothing).
		await writeProjectConfig(cwd, { gjc: { ralplan: { maxIterations: 9 } } });
		const override = await resolveIn(cwd, { HOME: home, GJC_CONFIG_DIR: ".myconfig" }, KEY, { strict: true });
		expect(override.threw).toBeUndefined();
		expect(override.value).toBe(9);
	});

	test("strict resolution throws on malformed project evidence for every strict key", async () => {
		const home = await tempDir();
		const cwd = await tempDir();
		await fs.mkdir(path.join(home, ".myconfig"), { recursive: true });
		await fs.mkdir(path.join(cwd, ".gjc"), { recursive: true });
		await fs.mkdir(projectSharedStateRoot(cwd, path.join(home, ".myconfig", "agent")), { recursive: true });
		// Malformed-source evidence (the project migration could not parse
		// settings.json): no key can be trusted, so every strict resolve throws.
		await fs.writeFile(
			path.join(projectSharedStateRoot(cwd, path.join(home, ".myconfig", "agent")), "settings.json.strict-invalid"),
			JSON.stringify({ version: 2, malformed: true, source: path.join(cwd, ".gjc", "settings.json") }),
		);

		const strict = await resolveIn(cwd, { HOME: home, GJC_CONFIG_DIR: ".myconfig" }, KEY, { strict: true });
		expect(strict.threw).toBe(true);
		expect(strict.message).toContain("retained malformed project .gjc/settings.json");

		// A valid project override still wins.
		await writeProjectConfig(cwd, { gjc: { ralplan: { maxIterations: 9 } } });
		const override = await resolveIn(cwd, { HOME: home, GJC_CONFIG_DIR: ".myconfig" }, KEY, { strict: true });
		expect(override.threw).toBeUndefined();
		expect(override.value).toBe(9);
	});

	test("strict resolution throws on malformed config-root evidence", async () => {
		const home = await tempDir();
		const cwd = await tempDir();
		await fs.mkdir(path.join(home, ".myconfig"), { recursive: true });
		await fs.writeFile(
			path.join(home, ".myconfig", "settings.json.strict-invalid"),
			JSON.stringify({ version: 2, malformed: true, source: path.join(home, ".myconfig", "settings.json") }),
		);

		const strict = await resolveIn(cwd, { HOME: home, GJC_CONFIG_DIR: ".myconfig" }, KEY, { strict: true });
		expect(strict.threw).toBe(true);
		expect(strict.message).toContain("retained malformed config-root settings.json");

		// A valid project override still wins over the agent-layer evidence.
		await writeProjectConfig(cwd, { gjc: { ralplan: { maxIterations: 9 } } });
		const override = await resolveIn(cwd, { HOME: home, GJC_CONFIG_DIR: ".myconfig" }, KEY, { strict: true });
		expect(override.threw).toBeUndefined();
		expect(override.value).toBe(9);
	});

	test("flat dotted and nested shapes are both extracted, flat wins", async () => {
		// extractWorkflowSetting keeps flat support for legacy settings.json
		// parsing during migration; config.yml itself is nested-only.
		expect(extractWorkflowSetting({ "gjc.ralplan.maxIterations": 7 }, KEY)).toEqual({ present: true, value: 7 });
		expect(extractWorkflowSetting({ gjc: { ralplan: { maxIterations: 8 } } }, KEY)).toEqual({
			present: true,
			value: 8,
		});
		expect(
			extractWorkflowSetting({ "gjc.ralplan.maxIterations": 7, gjc: { ralplan: { maxIterations: 8 } } }, KEY),
		).toEqual({
			present: true,
			value: 7,
		});
		expect(extractWorkflowSetting({ ralplan: { maxIterations: 9 } }, KEY)).toEqual({
			present: false,
			value: undefined,
		});
		expect(extractWorkflowSetting({ gjc: { other: 1 } }, KEY)).toEqual({ present: false, value: undefined });
		expect(extractWorkflowSetting("not-an-object", KEY)).toEqual({ present: false, value: undefined });
	});

	test("flat dotted keys are not honored in config.yml (nested only)", async () => {
		const cwd = await tempDir();
		// config.yml carries only a flat dotted key: it must be IGNORED because
		// config.yml uses the nested schema form.
		await writeProjectConfig(cwd, { "gjc.ralplan.maxIterations": "yaml-flat-ignored" });

		const result = await resolveWorkflowSetting(cwd, KEY, { defaultValue: "default", parse: stringParse });
		expect(result.value).toBe("default");
		expect(result.source).toBe("default");
	});

	test("empty documents continue; a null root is a malformed shape (strict throws)", async () => {
		const cwd = await tempDir();
		await fs.mkdir(path.join(cwd, ".gjc"), { recursive: true });
		await fs.writeFile(path.join(cwd, ".gjc", "config.yml"), "", "utf8"); // empty YAML -> no explicit settings

		// tolerant: the empty document continues to default
		const result = await resolveWorkflowSetting(cwd, KEY, { defaultValue: "default", parse: stringParse });
		expect(result.value).toBe("default");
		expect(result.source).toBe("default");
		expect(result.diagnostics.map(d => d.status)).toContain("empty-document");

		// a YAML `null` root is a malformed explicit layer: strict fails closed
		await writeProjectConfig(cwd, null);
		await expect(
			resolveWorkflowSetting(cwd, KEY, { defaultValue: "default", parse: stringParse, invalidPolicy: "throw" }),
		).rejects.toThrow();
		const tolerant = await resolveWorkflowSetting(cwd, KEY, { defaultValue: "default", parse: stringParse });
		expect(tolerant.value).toBe("default");
		expect(tolerant.diagnostics.map(d => d.status)).toContain("invalid");
	});

	test("scalar and array roots are invalid shape, continue by default", async () => {
		const cwd = await tempDir();
		await writeProjectConfig(cwd, ["a", "b"]);

		const result = await resolveWorkflowSetting(cwd, KEY, { defaultValue: "default", parse: stringParse });
		expect(result.value).toBe("default");
		expect(result.diagnostics.map(d => d.status)).toContain("invalid");
	});

	test("malformed YAML is invalid syntax, continue by default, throw under strict", async () => {
		const cwd = await tempDir();
		await fs.mkdir(path.join(cwd, ".gjc"), { recursive: true });
		await fs.writeFile(path.join(cwd, ".gjc", "config.yml"), "{ broken: [yaml", "utf8");

		const continued = await resolveWorkflowSetting(cwd, KEY, { defaultValue: "default", parse: stringParse });
		expect(continued.value).toBe("default");
		expect(continued.diagnostics.find(d => d.layer === "project-config")?.classification).toBe("syntax");

		const thrown = await resolveWorkflowSetting(cwd, KEY, {
			defaultValue: "default",
			parse: stringParse,
			invalidPolicy: "throw",
		}).catch(error => error);
		expect(thrown).toBeInstanceOf(WorkflowSettingError);
		expect(thrown.path).toBe(path.join(cwd, ".gjc", "config.yml"));
		expect(thrown.classification).toBe("syntax");
		expect(thrown.layer).toBe("project-config");
		expect(thrown.message).toContain("invalid workflow setting at");
	});

	test("an invalid present value is invalid/value, continue by default, throw under strict", async () => {
		const cwd = await tempDir();
		await writeProjectConfig(cwd, { gjc: { ralplan: { maxIterations: 7 } } });

		const continued = await resolveWorkflowSetting(cwd, KEY, { defaultValue: "default", parse: stringParse });
		expect(continued.value).toBe("default");
		expect(continued.diagnostics.find(d => d.layer === "project-config")?.classification).toBe("value");

		const thrown = await resolveWorkflowSetting(cwd, KEY, {
			defaultValue: "default",
			parse: stringParse,
			invalidPolicy: "throw",
		}).catch(error => error);
		expect(thrown).toBeInstanceOf(WorkflowSettingError);
		expect(thrown.classification).toBe("value");
		expect(thrown.reason).toBe("expected string");
	});

	test("a quoted numeric config.yml value is coerced like the Settings schema", async () => {
		const cwd = await tempDir();
		// Nested config.yml with a quoted number: reconcileSettingsSchema coerces
		// numeric strings for number settings, and the resolver must match it.
		await writeProjectConfig(cwd, { gjc: { ralplan: { maxIterations: "7" } } });
		const numberParse = (value: unknown) =>
			typeof value === "number"
				? { kind: "valid" as const, value }
				: { kind: "invalid" as const, reason: "not a number" };

		const result = await resolveWorkflowSetting(cwd, KEY, { defaultValue: 5, parse: numberParse });
		expect(result.value).toBe(7);
		expect(result.source).toBe(path.join(cwd, ".gjc", "config.yml"));
	});

	test("a malformed parent mapping is an invalid shape (strict throws)", async () => {
		const cwd = await tempDir();
		await fs.mkdir(path.join(cwd, ".gjc"), { recursive: true });
		await fs.writeFile(path.join(cwd, ".gjc", "config.yml"), YAML.stringify({ gjc: { ralplan: [] } }, null, 2));

		await expect(
			resolveWorkflowSetting(cwd, KEY, { defaultValue: "default", parse: stringParse, invalidPolicy: "throw" }),
		).rejects.toThrow();
	});

	test("a missing config.yml in both layers falls back to default with missing-file diagnostics", async () => {
		const cwd = await tempDir();
		const agentDir = await tempDir();

		const result = await resolveIn(cwd, { GJC_CODING_AGENT_DIR: agentDir });
		expect(result.value).toBe("default");
		expect(result.source).toBe("default");
		const statuses = (result.diagnostics as Array<{ status: string }>).map(d => d.status);
		expect(statuses).toContain("missing-file");
	});
});
