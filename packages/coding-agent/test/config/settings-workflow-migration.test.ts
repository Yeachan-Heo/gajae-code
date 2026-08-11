import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import * as nodeCrypto from "node:crypto";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { YAML } from "bun";

const PROBE = path.join(import.meta.dir, "../fixtures/settings-workflow-migration-probe.ts");

const temporaryDirectories: string[] = [];

async function tempDir(): Promise<string> {
	const directory = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-migration-"));
	temporaryDirectories.push(directory);
	return directory;
}

afterEach(async () => {
	await Promise.all(
		temporaryDirectories.splice(0).map(directory => fs.rm(directory, { recursive: true, force: true })),
	);
});

type ProbeResult = {
	loadFailed?: boolean;
	sourceExists: boolean;
	backupExists: boolean;
	markerExists: boolean;
	markerStatus: string | null;
	targetValue: unknown;
	strictInvalidEvidenceExists?: boolean;
	strictInvalidEvidenceKeys?: string[];
	strictInvalidEvidenceMalformed?: boolean;
};

async function runProbe(
	cwd: string,
	options: {
		home: string;
		configDir?: string;
		agentDir?: string;
		codingAgentDir?: string;
		env?: Record<string, string>;
	},
): Promise<ProbeResult> {
	const args = [process.execPath, PROBE];
	if (options.agentDir) args.push("--agent-dir", options.agentDir);
	const proc = Bun.spawn(args, {
		cwd,
		env: {
			...process.env,
			HOME: options.home,
			GJC_CONFIG_DIR: options.configDir ?? ".gjc",
			...(options.codingAgentDir ? { GJC_CODING_AGENT_DIR: options.codingAgentDir } : {}),
			...(options.env ?? {}),
		},
		stdout: "pipe",
		stderr: "pipe",
	});
	const [out, err] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
	if ((await proc.exited) !== 0) throw new Error(`probe failed (exit ${await proc.exited}): ${err}`);
	return JSON.parse(out.trim()) as ProbeResult;
}

async function setupHome(
	home: string,
	configDir: string,
): Promise<{ configRoot: string; source: string; agentDir: string }> {
	const configRoot = path.join(home, configDir);
	await fs.mkdir(configRoot, { recursive: true });
	return {
		configRoot,
		source: path.join(configRoot, "settings.json"),
		agentDir: path.join(configRoot, "agent"),
	};
}

describe("config-root workflow settings migration", () => {
	test("migrates the workflow keys into the default agent config.yml exactly once", async () => {
		const home = await tempDir();
		const cwd = await tempDir();
		const { source } = await setupHome(home, ".myconfig");
		await fs.writeFile(source, JSON.stringify({ "gjc.ralplan.maxIterations": 7 }));

		const first = await runProbe(cwd, { home, configDir: ".myconfig" });
		expect(first.markerStatus).toBe("complete");
		expect(first.backupExists).toBe(true);
		expect(first.sourceExists).toBe(false); // source is retired after completion
		expect(first.targetValue).toBe(7);

		const second = await runProbe(cwd, { home, configDir: ".myconfig" });
		expect(second.markerStatus).toBe("complete");
		expect(second.sourceExists).toBe(false); // source remains retired after re-load
		expect(second.backupExists).toBe(true);
	});

	test("a completed-marker recovery retires a surviving source revision", async () => {
		const home = await tempDir();
		const cwd = await tempDir();
		const { source } = await setupHome(home, ".myconfig");
		const original = JSON.stringify({ "gjc.ralplan.maxIterations": 7 });
		await fs.writeFile(source, original);

		const first = await runProbe(cwd, { home, configDir: ".myconfig" });
		expect(first.markerStatus).toBe("complete");
		expect(first.sourceExists).toBe(false); // retired at completion

		// Simulate the crash window: the complete marker was published but the
		// source quarantine never ran; the surviving revision still matches the
		// marker's recorded sourceSha256.
		await fs.writeFile(source, original);

		const second = await runProbe(cwd, { home, configDir: ".myconfig" });
		expect(second.markerStatus).toBe("complete");
		expect(second.sourceExists).toBe(false); // retired by the completed-marker recovery
		expect(second.targetValue).toBe(7); // config.yml value untouched
	});

	test("a completed-marker recovery preserves a byte-identical recreated source", async () => {
		const home = await tempDir();
		const cwd = await tempDir();
		const { source, agentDir } = await setupHome(home, ".myconfig");
		const original = JSON.stringify({ "gjc.ralplan.maxIterations": 7 });
		await fs.writeFile(source, original);

		const first = await runProbe(cwd, { home, configDir: ".myconfig" });
		expect(first.markerStatus).toBe("complete");
		expect(first.sourceExists).toBe(false); // retired at completion

		// The user UNSETS the migrated key and restores settings.json from the
		// .bak: the recreated source is byte-identical to the marker's recorded
		// hash, but the target no longer satisfies the completed marker - the
		// recovery must NOT mistake the recreation for a crash survivor and
		// retire it (the restored override would silently fall through).
		const backupRaw = await fs.readFile(`${source}.bak`, "utf8");
		await fs.writeFile(source, backupRaw);
		const target = path.join(agentDir, "config.yml");
		const targetDoc = YAML.parse(await fs.readFile(target, "utf8")) as { gjc?: Record<string, unknown> };
		delete (targetDoc.gjc as Record<string, unknown>).ralplan;
		await fs.writeFile(target, YAML.stringify(targetDoc, null, 2));

		const second = await runProbe(cwd, { home, configDir: ".myconfig" });
		expect(second.markerStatus).toBe("complete");
		expect(second.sourceExists).toBe(true); // recreation preserved, not retired
	});

	test("a future-schema agent config.yml still retains config-root strict errors", async () => {
		const home = await tempDir();
		const cwd = await tempDir();
		const { source, agentDir } = await setupHome(home, ".myconfig");
		await fs.mkdir(agentDir, { recursive: true });
		// The target is a future schema (read-only across Settings); the retained
		// source's invalid strict value must still surface through evidence so the
		// config-only resolver keeps exit-2 observable.
		await fs.writeFile(path.join(agentDir, "config.yml"), YAML.stringify({ configSchemaVersion: 9999 }, null, 2));
		await fs.writeFile(source, JSON.stringify({ "gjc.ralplan.maxIterations": "bad" }));

		const result = await runProbe(cwd, { home, configDir: ".myconfig" });
		expect(result.strictInvalidEvidenceExists).toBe(true);
		expect(result.strictInvalidEvidenceKeys).toEqual(["gjc.ralplan.maxIterations"]);
		expect(result.targetValue).toBeNull(); // future-schema target untouched
	});

	test("does not retire the config-root source when it is also the project source", async () => {
		const home = await tempDir();
		// cwd = home -> the project .gjc/settings.json IS the config-root source.
		await fs.mkdir(path.join(home, ".gjc"), { recursive: true });
		const original = JSON.stringify({ "gjc.ralplan.maxIterations": 7, theme: { dark: "red-claw" } });
		await fs.writeFile(path.join(home, ".gjc", "settings.json"), original);

		const result = await runProbe(home, { home, configDir: ".gjc" });
		// The colliding source is preserved (it is the project source): the
		// config-root migration defers to the project migration, so non-workflow
		// project settings stay discoverable and a tracked dotfiles copy survives.
		expect(result.sourceExists).toBe(true);
		expect(result.markerStatus).toBeNull(); // no config-root completion marker
		expect(await fs.readFile(path.join(home, ".gjc", "settings.json"), "utf8")).toBe(original);
		// The workflow keys still migrate - into the PROJECT config.yml.
		const projectConfig = YAML.parse(await fs.readFile(path.join(home, ".gjc", "config.yml"), "utf8")) as {
			gjc?: { ralplan?: Record<string, unknown> };
		};
		expect(projectConfig.gjc?.ralplan?.maxIterations).toBe(7);
	});

	test("a future-schema target retains STRUCTURAL malformation evidence", async () => {
		const home = await tempDir();
		const cwd = await tempDir();
		const { source, agentDir } = await setupHome(home, ".myconfig");
		await fs.mkdir(agentDir, { recursive: true });
		await fs.writeFile(path.join(agentDir, "config.yml"), YAML.stringify({ configSchemaVersion: 9999 }, null, 2));
		// Structurally malformed: parses as JSON but is NOT a valid object root -
		// the revalidation must not treat a successful parse as a repair.
		await fs.writeFile(source, JSON.stringify(null));

		const result = await runProbe(cwd, { home, configDir: ".myconfig" });
		expect(result.strictInvalidEvidenceExists).toBe(true);
		expect(result.strictInvalidEvidenceMalformed).toBe(true);
	});

	test("migrates workflow keys when the agent dir equals the config root and config.yml exists", async () => {
		const home = await tempDir();
		const cwd = await tempDir();
		const configRoot = path.join(home, ".myconfig");
		await fs.mkdir(configRoot, { recursive: true });
		// The agent dir IS the config root; the agent config.yml already exists, so
		// the agent-dir migration skips and would leave the orphan source's
		// workflow keys unmigrated.
		await fs.writeFile(path.join(configRoot, "config.yml"), YAML.stringify({ theme: { dark: "red-claw" } }, null, 2));
		await fs.writeFile(path.join(configRoot, "settings.json"), JSON.stringify({ "gjc.ralplan.maxIterations": 7 }));

		const result = await runProbe(cwd, { home, configDir: ".myconfig", codingAgentDir: configRoot });
		expect(result.markerStatus).toBe("complete");
		expect(result.targetValue).toBe(7); // workflow keys migrated into the agent config.yml
	});

	test("a config-root collision reconciles fallback state against the agent target", async () => {
		const home = await tempDir();
		const cwd = await tempDir();
		const { source } = await setupHome(home, ".gjc");
		// Evidence path occupied -> the config-root fallback lands in the AGENT
		// config.yml with the config-root marker namespace.
		await fs.mkdir(`${source}.strict-invalid`, { recursive: true });
		await fs.writeFile(source, JSON.stringify({ "gjc.ralplan.maxIterations": "bad" }));

		await runProbe(cwd, { home, configDir: ".gjc" });
		const agentConfig = YAML.parse(await fs.readFile(path.join(home, ".gjc", "agent", "config.yml"), "utf8")) as {
			gjc?: { ralplan?: Record<string, unknown> };
		};
		expect(agentConfig.gjc?.ralplan?.maxIterations).toBe("bad");

		// Repair the source, then run from HOME (the config-root source is now
		// also the project source): the collision deferral must clean the AGENT
		// config.yml fallback - the project migration only cleans the project
		// config.yml and its own marker namespace.
		await fs.writeFile(source, "{}");
		await runProbe(home, { home, configDir: ".gjc" });

		const agentConfigAfter = YAML.parse(
			await fs.readFile(path.join(home, ".gjc", "agent", "config.yml"), "utf8"),
		) as { gjc?: { ralplan?: Record<string, unknown> } };
		expect(agentConfigAfter.gjc?.ralplan?.maxIterations).toBeUndefined();
		expect(await fs.lstat(`${source}.config-root.fallback-invalid`).catch(() => null)).toBeNull();
	});

	test("deleting the config-root source reconciles its stale fallback", async () => {
		const home = await tempDir();
		const cwd = await tempDir();
		const { source } = await setupHome(home, ".myconfig");
		await fs.mkdir(`${source}.strict-invalid`, { recursive: true });
		await fs.writeFile(source, JSON.stringify({ "gjc.ralplan.maxIterations": "bad" }));

		await runProbe(cwd, { home, configDir: ".myconfig" });
		const agentConfig = YAML.parse(
			await fs.readFile(path.join(home, ".myconfig", "agent", "config.yml"), "utf8"),
		) as { gjc?: { ralplan?: Record<string, unknown> } };
		expect(agentConfig.gjc?.ralplan?.maxIterations).toBe("bad");

		// The user fixes the invalid value by DELETING settings.json: the stale
		// fallback must be reconciled even though there is nothing left to migrate
		// (source, backup, and migration marker are all absent).
		await fs.rm(source, { force: true });
		await runProbe(cwd, { home, configDir: ".myconfig" });

		const after = YAML.parse(await fs.readFile(path.join(home, ".myconfig", "agent", "config.yml"), "utf8")) as {
			gjc?: { ralplan?: Record<string, unknown> };
		};
		expect(after.gjc?.ralplan?.maxIterations).toBeUndefined();
		expect(await fs.lstat(`${source}.config-root.fallback-invalid`).catch(() => null)).toBeNull();
	});

	test("merges legacy agent-dir settings even when the config-root migration creates config.yml", async () => {
		const home = await tempDir();
		const cwd = await tempDir();
		const { source, agentDir } = await setupHome(home, ".myconfig");
		await fs.mkdir(agentDir, { recursive: true });
		// Legacy agent-dir settings.json with a workflow key and a non-workflow key.
		await fs.writeFile(
			path.join(agentDir, "settings.json"),
			JSON.stringify({ "gjc.ralplan.maxIterations": 5, theme: { dark: "red-claw" } }),
		);
		// Config-root source with a workflow key.
		await fs.writeFile(source, JSON.stringify({ "gjc.ralplan.maxIterations": 7 }));

		const result = await runProbe(cwd, { home, configDir: ".myconfig" });
		// The agent-dir legacy settings merged into config.yml (not ignored because
		// the config-root migration created the file first); the non-workflow
		// legacy value is preserved.
		const config = YAML.parse(await fs.readFile(path.join(agentDir, "config.yml"), "utf8")) as {
			gjc?: { ralplan?: Record<string, unknown> };
			theme?: Record<string, unknown>;
		};
		expect(config.gjc?.ralplan?.maxIterations).toBe(5); // agent-dir value landed first
		expect(config.theme?.dark).toBe("red-claw");
		// The config-root source was still migrated and retired.
		expect(result.markerStatus).toBe("complete");
	});

	test("delayed database settings merge at leaf paths into an existing config.yml", async () => {
		const home = await tempDir();
		const cwd = await tempDir();
		const { agentDir } = await setupHome(home, ".myconfig");
		await fs.mkdir(agentDir, { recursive: true });
		// config.yml already exists (as if a workflow migration created it) with a
		// `gjc` object; the legacy database holds a NESTED sibling under `gjc` and
		// a top-level key, which must merge at the LEAF, not be skipped wholesale
		// because `gjc` exists.
		await fs.writeFile(
			path.join(agentDir, "config.yml"),
			YAML.stringify({ gjc: { ralplan: { maxIterations: 7 } } }, null, 2),
		);
		const db = new Database(path.join(agentDir, "agent.db"));
		db.run(
			"CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER NOT NULL DEFAULT 0)",
		);
		db.run("CREATE TABLE schema_version (version INTEGER PRIMARY KEY)");
		db.run("INSERT INTO schema_version (version) VALUES (5)");
		db.run("INSERT INTO settings (key, value, updated_at) VALUES ('gjc', ?, 0)", [
			JSON.stringify({ ultragoal: { nudgeBudget: 10 } }),
		]);
		db.run("INSERT INTO settings (key, value, updated_at) VALUES ('theme.dark', ?, 0)", [JSON.stringify("red-claw")]);
		db.close();

		await runProbe(cwd, { home, configDir: ".myconfig" });
		const config = YAML.parse(await fs.readFile(path.join(agentDir, "config.yml"), "utf8")) as {
			gjc?: { ralplan?: Record<string, unknown>; ultragoal?: Record<string, unknown> };
			theme?: Record<string, unknown>;
		};
		expect(config.gjc?.ralplan?.maxIterations).toBe(7); // pre-existing value preserved
		expect(config.gjc?.ultragoal?.nudgeBudget).toBe(10); // nested db sibling merged at the leaf
		expect(config.theme?.dark).toBe("red-claw");
	});

	test("flat dotted database keys do not overwrite nested modern config values", async () => {
		const home = await tempDir();
		const cwd = await tempDir();
		const { agentDir } = await setupHome(home, ".myconfig");
		await fs.mkdir(agentDir, { recursive: true });
		// config.yml already has NESTED modern values for the same settings.
		await fs.writeFile(
			path.join(agentDir, "config.yml"),
			YAML.stringify({ theme: { dark: "red-claw" }, gjc: { ralplan: { maxIterations: 7 } } }, null, 2),
		);
		const db = new Database(path.join(agentDir, "agent.db"));
		db.run(
			"CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER NOT NULL DEFAULT 0)",
		);
		db.run("CREATE TABLE schema_version (version INTEGER PRIMARY KEY)");
		db.run("INSERT INTO schema_version (version) VALUES (5)");
		// FLAT dotted rows (the database's key format).
		db.run("INSERT INTO settings (key, value, updated_at) VALUES ('theme.dark', ?, 0)", [JSON.stringify("blue")]);
		db.run("INSERT INTO settings (key, value, updated_at) VALUES ('gjc.ralplan.maxIterations', ?, 0)", [
			JSON.stringify(3),
		]);
		db.close();

		await runProbe(cwd, { home, configDir: ".myconfig" });
		const config = YAML.parse(await fs.readFile(path.join(agentDir, "config.yml"), "utf8")) as {
			gjc?: { ralplan?: Record<string, unknown> };
			theme?: Record<string, unknown>;
		};
		// The absent-only merge compares the flat keys against the NESTED paths, so
		// the modern values survive (the legacy rows are then cleared).
		expect(config.theme?.dark).toBe("red-claw");
		expect(config.gjc?.ralplan?.maxIterations).toBe(7);
	});

	test("preserves literal dotted member keys inside legacy record settings", async () => {
		const home = await tempDir();
		const cwd = await tempDir();
		const { agentDir } = await setupHome(home, ".myconfig");
		await fs.mkdir(agentDir, { recursive: true });
		// config.yml already has a `modelTags` mapping; the legacy database row
		// holds a record whose member key `custom.role` contains a dot and must be
		// kept as a LITERAL record key. The dotted patch grammar cannot address it
		// as a leaf, and splitting it would migrate the tag to a nested
		// `custom.role` path and then clear the row, permanently losing the tag.
		await fs.writeFile(
			path.join(agentDir, "config.yml"),
			YAML.stringify({ modelTags: { default: { name: "Default", color: "accent" } } }, null, 2),
		);
		const db = new Database(path.join(agentDir, "agent.db"));
		db.run(
			"CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER NOT NULL DEFAULT 0)",
		);
		db.run("CREATE TABLE schema_version (version INTEGER PRIMARY KEY)");
		db.run("INSERT INTO schema_version (version) VALUES (5)");
		db.run("INSERT INTO settings (key, value, updated_at) VALUES ('modelTags', ?, 0)", [
			JSON.stringify({ "custom.role": { name: "Custom" } }),
		]);
		db.close();

		await runProbe(cwd, { home, configDir: ".myconfig" });
		const config = YAML.parse(await fs.readFile(path.join(agentDir, "config.yml"), "utf8")) as {
			modelTags?: Record<string, unknown>;
		};
		// The literal `custom.role` key survives inside the existing modelTags
		// record, and the pre-existing `default` member is untouched.
		expect(config.modelTags?.default).toEqual({ name: "Default", color: "accent" });
		expect(config.modelTags?.["custom.role"]).toEqual({ name: "Custom" });
		// The dotted member must NOT have been split into a nested custom.role path.
		expect(config.modelTags?.custom).toBeUndefined();
		// The drained rows are cleared only after the merge, so the tag is not lost.
		const after = new Database(path.join(agentDir, "agent.db"));
		const remaining = after.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM settings").get();
		after.close();
		expect(remaining?.n).toBe(0);
	});
	test("preserves an occupied scalar enclosing path during the database merge", async () => {
		const home = await tempDir();
		const cwd = await tempDir();
		const { agentDir } = await setupHome(home, ".myconfig");
		await fs.mkdir(agentDir, { recursive: true });
		// config.yml holds a SCALAR at a record-valued setting (`modelTags`);
		// the legacy database row for the same key carries a dotted member. The
		// occupied non-record enclosing path must be left unchanged: a
		// whole-record replacement would clobber the modern scalar and then
		// clear the rows, violating the absent-only migration contract.
		await fs.writeFile(path.join(agentDir, "config.yml"), YAML.stringify({ modelTags: "custom" }, null, 2));
		const db = new Database(path.join(agentDir, "agent.db"));
		db.run(
			"CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER NOT NULL DEFAULT 0)",
		);
		db.run("CREATE TABLE schema_version (version INTEGER PRIMARY KEY)");
		db.run("INSERT INTO schema_version (version) VALUES (5)");
		db.run("INSERT INTO settings (key, value, updated_at) VALUES ('modelTags', ?, 0)", [
			JSON.stringify({ "custom.role": { name: "Custom" } }),
		]);
		db.close();

		await runProbe(cwd, { home, configDir: ".myconfig" });

		const config = YAML.parse(await fs.readFile(path.join(agentDir, "config.yml"), "utf8")) as {
			modelTags?: unknown;
		};
		// The modern scalar survives; the legacy record is never merged into it
		// and no dotted path is split into a nested `custom` member.
		expect(config.modelTags).toBe("custom");
		expect((config as Record<string, unknown>).custom).toBeUndefined();
	});
	test("a shadowed invalid strict key is recorded as owned so an unset falls through", async () => {
		const cwd = await tempDir();
		const home = await tempDir();
		const agentDir = path.join(home, ".gjc", "agent");
		// The retained project settings.json holds an INVALID strict value while
		// the project config.yml holds a VALID value for the same key (the
		// shadow case: the valid target wins, so no strict evidence is written).
		// The migration must still record the key as owned - without ownership,
		// a later `gjc config unset` of the target value would resurrect the
		// invalid legacy value and exit 2 instead of falling through to
		// defaults (mirroring the config-root path, where the source is retired).
		await fs.mkdir(path.join(cwd, ".gjc", "state"), { recursive: true });
		await fs.writeFile(
			path.join(cwd, ".gjc", "config.yml"),
			YAML.stringify({ gjc: { ralplan: { maxIterations: 7 } } }, null, 2),
		);
		await fs.writeFile(
			path.join(cwd, ".gjc", "settings.json"),
			JSON.stringify({ "gjc.ralplan.maxIterations": "invalid" }),
		);
		await fs.mkdir(agentDir, { recursive: true });

		// The project migration runs during Settings.load (probe child process).
		await runProbe(cwd, { home, configDir: ".gjc" });

		// The migrated-keys ownership marker records the shadowed key.
		const marker = JSON.parse(
			await fs.readFile(path.join(cwd, ".gjc", "state", "settings.json.migrated-keys"), "utf8"),
		) as string[];
		expect(marker).toContain("gjc.ralplan.maxIterations");
		// Simulate `gjc config unset`: remove the key from the project config.
		await fs.writeFile(path.join(cwd, ".gjc", "config.yml"), YAML.stringify({ theme: { dark: "red" } }, null, 2));

		// A strict ralplan caller must fall through to the default instead of
		// exiting 2 on the resurrected invalid legacy value.
		const wsProbe = path.join(import.meta.dir, "../fixtures/workflow-settings-probe.ts");
		const proc = Bun.spawn([process.execPath, wsProbe, "gjc.ralplan.maxIterations", "--strict"], {
			cwd,
			env: {
				...process.env,
				HOME: home,
				GJC_CONFIG_DIR: ".gjc",
				GJC_CODING_AGENT_DIR: agentDir,
				PI_CODING_AGENT_DIR: undefined,
			},
			stdout: "pipe",
			stderr: "pipe",
		});
		const [out, err] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
		if ((await proc.exited) !== 0) throw new Error(`resolve probe failed: ${err}`);
		const resolved = JSON.parse(out.trim()) as { value: unknown; threw?: boolean };
		expect(resolved.threw).toBeUndefined();
		expect(resolved.value).toBe("default");
	});

	test("database rows are not merged into or drained from read-only targets", async () => {
		const home = await tempDir();
		const cwd = await tempDir();
		const { agentDir } = await setupHome(home, ".myconfig");
		await fs.mkdir(agentDir, { recursive: true });
		// A FUTURE-schema target is read-only across Settings: the legacy database
		// merge must not modify it, and the rows must stay for the next load.
		await fs.writeFile(path.join(agentDir, "config.yml"), YAML.stringify({ configSchemaVersion: 9999 }, null, 2));
		const db = new Database(path.join(agentDir, "agent.db"));
		db.run(
			"CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER NOT NULL DEFAULT 0)",
		);
		db.run("CREATE TABLE schema_version (version INTEGER PRIMARY KEY)");
		db.run("INSERT INTO schema_version (version) VALUES (5)");
		db.run("INSERT INTO settings (key, value, updated_at) VALUES ('theme.dark', ?, 0)", [JSON.stringify("red-claw")]);
		db.close();

		await runProbe(cwd, { home, configDir: ".myconfig" });
		const config = YAML.parse(await fs.readFile(path.join(agentDir, "config.yml"), "utf8")) as Record<
			string,
			unknown
		>;
		expect(config.configSchemaVersion).toBe(9999); // untouched
		expect(config.theme).toBeUndefined(); // not merged
		const after = new Database(path.join(agentDir, "agent.db"));
		const remaining = after.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM settings").get();
		after.close();
		expect(remaining?.n).toBe(1); // rows retained for the next load
	});

	test("database rows are not merged into a malformed config.yml root", async () => {
		const home = await tempDir();
		const cwd = await tempDir();
		const { agentDir } = await setupHome(home, ".myconfig");
		await fs.mkdir(agentDir, { recursive: true });
		// A scalar-root config.yml is malformed user data: the absent-only merge
		// would otherwise replace the whole document before the rows are cleared.
		await fs.writeFile(path.join(agentDir, "config.yml"), "just-a-string\n");
		const db = new Database(path.join(agentDir, "agent.db"));
		db.run(
			"CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER NOT NULL DEFAULT 0)",
		);
		db.run("CREATE TABLE schema_version (version INTEGER PRIMARY KEY)");
		db.run("INSERT INTO schema_version (version) VALUES (5)");
		db.run("INSERT INTO settings (key, value, updated_at) VALUES ('theme.dark', ?, 0)", [JSON.stringify("red-claw")]);
		db.close();

		await runProbe(cwd, { home, configDir: ".myconfig" });
		expect(await fs.readFile(path.join(agentDir, "config.yml"), "utf8")).toBe("just-a-string\n"); // untouched
		const after = new Database(path.join(agentDir, "agent.db"));
		const remaining = after.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM settings").get();
		after.close();
		expect(remaining?.n).toBe(1); // rows retained for the next load
	});

	test("a malformed legacy database row fails the load instead of dropping the valid rows", async () => {
		const home = await tempDir();
		const cwd = await tempDir();
		const { agentDir } = await setupHome(home, ".myconfig");
		await fs.mkdir(agentDir, { recursive: true });
		const db = new Database(path.join(agentDir, "agent.db"));
		db.run(
			"CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER NOT NULL DEFAULT 0)",
		);
		db.run("CREATE TABLE schema_version (version INTEGER PRIMARY KEY)");
		db.run("INSERT INTO schema_version (version) VALUES (5)");
		db.run("INSERT INTO settings (key, value, updated_at) VALUES ('theme.dark', ?, 0)", [JSON.stringify("red-claw")]);
		// One malformed row makes the whole legacy read fail: the load must fail
		// (actionable) instead of silently continuing without the valid rows.
		db.run("INSERT INTO settings (key, value, updated_at) VALUES ('gjc.ralplan.maxIterations', '{broken', 0)");
		db.close();

		const result = await runProbe(cwd, { home, configDir: ".myconfig" });
		expect(result.loadFailed).toBe(true);
		// Nothing was drained: every row stays in place for repair.
		const after = new Database(path.join(agentDir, "agent.db"));
		const remaining = after.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM settings").get();
		after.close();
		expect(remaining?.n).toBe(2);
	});

	test("a malformed legacy database row keeps the settings.json source discoverable", async () => {
		const home = await tempDir();
		const cwd = await tempDir();
		const { agentDir } = await setupHome(home, ".myconfig");
		await fs.mkdir(agentDir, { recursive: true });
		// BOTH legacy sources exist: agentDir/settings.json (retired via the
		// .bak rename only after the combined migration commits) and agent.db
		// with a malformed row that aborts the load.
		await fs.writeFile(path.join(agentDir, "settings.json"), JSON.stringify({ "theme.dark": "red-claw" }));
		const db = new Database(path.join(agentDir, "agent.db"));
		db.run(
			"CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER NOT NULL DEFAULT 0)",
		);
		db.run("CREATE TABLE schema_version (version INTEGER PRIMARY KEY)");
		db.run("INSERT INTO schema_version (version) VALUES (5)");
		db.run("INSERT INTO settings (key, value, updated_at) VALUES ('gjc.ralplan.maxIterations', '{broken', 0)");
		db.close();

		const result = await runProbe(cwd, { home, configDir: ".myconfig" });
		expect(result.loadFailed).toBe(true);
		// The settings.json source was NOT retired: after the database is
		// repaired, the next load still discovers it.
		expect(await fs.stat(path.join(agentDir, "settings.json")).catch(() => null)).not.toBeNull();
		expect(await fs.stat(path.join(agentDir, "settings.json.bak")).catch(() => null)).toBeNull();
	});

	test("gjc ultragoal --help renders help without running the settings migration", async () => {
		const cwd = await tempDir();
		const home = await tempDir();
		// A legacy config-root source the migration would consume if it ran.
		await fs.mkdir(path.join(home, ".gjc"), { recursive: true });
		const legacySource = path.join(home, ".gjc", "settings.json");
		const sourceRaw = JSON.stringify({ "gjc.ralplan.maxIterations": 7 });
		await fs.writeFile(legacySource, sourceRaw);

		const probe = path.join(import.meta.dir, "../fixtures/ultragoal-help-probe.ts");
		const proc = Bun.spawn([process.execPath, probe], {
			cwd,
			env: {
				...process.env,
				HOME: home,
				GJC_CONFIG_DIR: ".gjc",
			},
			stdout: "pipe",
			stderr: "pipe",
		});
		const [out, err] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
		if ((await proc.exited) !== 0) throw new Error(`ultragoal help probe failed: ${err}`);
		expect(out).toContain("ultragoal");
		// The read-only help request performed no migration: the legacy source
		// is untouched and no agent config.yml was created.
		expect(await fs.readFile(legacySource, "utf8")).toBe(sourceRaw);
		expect(await fs.stat(path.join(home, ".gjc", "agent", "config.yml")).catch(() => null)).toBeNull();
	});

	test("project fallback ownership survives the config-root collision reconcile", async () => {
		const home = await tempDir();
		await fs.mkdir(path.join(home, ".gjc"), { recursive: true });
		const source = path.join(home, ".gjc", "settings.json");
		// The project evidence path is occupied -> the PROJECT migration falls
		// back into the project config.yml with the project marker name.
		await fs.mkdir(path.join(home, ".gjc", "state", "settings.json.strict-invalid"), { recursive: true });
		await fs.writeFile(source, JSON.stringify({ "gjc.ralplan.maxIterations": "bad" }));

		// Run from HOME (collision): only the project migration writes a fallback.
		await runProbe(home, { home, configDir: ".gjc" });
		const projectConfig = YAML.parse(await fs.readFile(path.join(home, ".gjc", "config.yml"), "utf8")) as {
			gjc?: { ralplan?: Record<string, unknown> };
		};
		expect(projectConfig.gjc?.ralplan?.maxIterations).toBe("bad");

		// Repair the source: the config-root collision reconcile must NOT delete
		// the project's marker (it owns the project config.yml fallback), so the
		// project cleanup can still remove the value.
		await fs.writeFile(source, "{}");
		await runProbe(home, { home, configDir: ".gjc" });

		const projectAfter = YAML.parse(await fs.readFile(path.join(home, ".gjc", "config.yml"), "utf8")) as {
			gjc?: { ralplan?: Record<string, unknown> };
		};
		expect(projectAfter.gjc?.ralplan?.maxIterations).toBeUndefined();
		expect(await fs.lstat(`${source}.fallback-invalid`).catch(() => null)).toBeNull();
	});

	test("runs even when the target config.yml already exists", async () => {
		const home = await tempDir();
		const cwd = await tempDir();
		const { source, agentDir } = await setupHome(home, ".myconfig");
		await fs.mkdir(agentDir, { recursive: true });
		await fs.writeFile(path.join(agentDir, "config.yml"), YAML.stringify({ theme: { dark: "red-claw" } }, null, 2));
		await fs.writeFile(source, JSON.stringify({ "gjc.ralplan.maxIterations": 7 }));

		const result = await runProbe(cwd, { home, configDir: ".myconfig" });
		expect(result.markerStatus).toBe("complete");
		expect(result.targetValue).toBe(7);
		expect(result.backupExists).toBe(true);
	});

	test("does not overwrite a modern nested target value (absent-only)", async () => {
		const home = await tempDir();
		const cwd = await tempDir();
		const { source, agentDir } = await setupHome(home, ".myconfig");
		await fs.mkdir(agentDir, { recursive: true });
		await fs.writeFile(
			path.join(agentDir, "config.yml"),
			YAML.stringify({ gjc: { ralplan: { maxIterations: 9 } } }, null, 2),
		);
		await fs.writeFile(source, JSON.stringify({ "gjc.ralplan.maxIterations": 7 }));

		const result = await runProbe(cwd, { home, configDir: ".myconfig" });
		expect(result.targetValue).toBe(9); // modern nested target wins
		expect(result.markerStatus).toBe("complete");
		expect(result.backupExists).toBe(true);
	});

	test("does nothing when the config-root source is absent", async () => {
		const home = await tempDir();
		const cwd = await tempDir();
		await setupHome(home, ".myconfig");

		const result = await runProbe(cwd, { home, configDir: ".myconfig" });
		expect(result.markerExists).toBe(false);
		expect(result.backupExists).toBe(false);
	});

	test("leaves a malformed source untouched", async () => {
		const home = await tempDir();
		const cwd = await tempDir();
		const { source } = await setupHome(home, ".myconfig");
		await fs.writeFile(source, "{ broken json");

		const result = await runProbe(cwd, { home, configDir: ".myconfig" });
		expect(result.markerExists).toBe(false);
		expect(result.backupExists).toBe(false);
		expect(result.sourceExists).toBe(true);
		expect(result.strictInvalidEvidenceExists).toBe(true);
		expect(result.strictInvalidEvidenceMalformed).toBe(true);

		// Repairing the source clears the malformed evidence and migrates.
		await fs.writeFile(source, JSON.stringify({ "gjc.ralplan.maxIterations": 7 }));
		const repaired = await runProbe(cwd, { home, configDir: ".myconfig" });
		expect(repaired.markerStatus).toBe("complete");
		expect(repaired.strictInvalidEvidenceExists).toBe(false);
	});

	test("custom agentDir can never consume the machine-global source", async () => {
		const home = await tempDir();
		const cwd = await tempDir();
		const otherAgent = await tempDir();
		const { source } = await setupHome(home, ".myconfig");
		await fs.writeFile(source, JSON.stringify({ "gjc.ralplan.maxIterations": 7 }));

		const result = await runProbe(cwd, { home, configDir: ".myconfig", agentDir: otherAgent });
		expect(result.markerExists).toBe(false);
		expect(result.backupExists).toBe(false);
		expect(result.sourceExists).toBe(true);
		expect(result.targetValue).toBe(null);
	});

	test("an environment-selected non-default agent profile migrates the machine-global source", async () => {
		const home = await tempDir();
		const cwd = await tempDir();
		const { source, configRoot } = await setupHome(home, ".myconfig");
		const customAgent = path.join(configRoot, "custom-agent");
		await fs.mkdir(customAgent, { recursive: true });
		await fs.writeFile(source, JSON.stringify({ "gjc.ralplan.maxIterations": 7 }));

		// GJC_CODING_AGENT_DIR selects a supported non-default global profile; it
		// is not a temporary explicit agentDir, so the machine-global source must
		// migrate into that profile's config.yml.
		const result = await runProbe(cwd, { home, configDir: ".myconfig", codingAgentDir: customAgent });
		expect(result.targetValue).toBe(7);
		expect(result.markerStatus).toBe("complete");
		expect(result.sourceExists).toBe(false); // retired after completion
	});

	test("workflow migrations run when the settings database is unavailable", async () => {
		const home = await tempDir();
		const cwd = await tempDir();
		const { source, agentDir } = await setupHome(home, ".myconfig");
		await fs.mkdir(agentDir, { recursive: true });
		// Block the sqlite path so AgentStorage.open rejects the full load.
		await fs.mkdir(path.join(agentDir, "agent.db"), { recursive: true });
		await fs.writeFile(source, JSON.stringify({ "gjc.ralplan.maxIterations": 7 }));

		const result = await runProbe(cwd, { home, configDir: ".myconfig" });
		expect(result.loadFailed).toBe(true); // the full load failed on the database
		expect(result.targetValue).toBe(7); // but the workflow migration already ran
		expect(result.sourceExists).toBe(false); // source retired by the completed migration
	});

	test("a pre-existing .bak without a marker is never consumed or overwritten", async () => {
		const home = await tempDir();
		const cwd = await tempDir();
		const { source } = await setupHome(home, ".myconfig");
		await fs.writeFile(source, JSON.stringify({ "gjc.ralplan.maxIterations": 7 }));
		await fs.writeFile(`${source}.bak`, "pre-existing backup");

		const result = await runProbe(cwd, { home, configDir: ".myconfig" });
		expect(result.markerExists).toBe(false);
		expect(result.backupExists).toBe(true);
		expect(result.sourceExists).toBe(true);
	});

	test("concurrent loads serialize into one migration", async () => {
		const home = await tempDir();
		const cwd = await tempDir();
		const { source } = await setupHome(home, ".myconfig");
		await fs.writeFile(source, JSON.stringify({ "gjc.ralplan.maxIterations": 7 }));

		const [first, second] = await Promise.all([
			runProbe(cwd, { home, configDir: ".myconfig" }),
			runProbe(cwd, { home, configDir: ".myconfig" }),
		]);
		expect(first.markerStatus).toBe("complete");
		expect(second.markerStatus).toBe("complete");
		expect(first.targetValue).toBe(7);
		expect(second.targetValue).toBe(7);
	});

	test("recovers a valid pending marker whose source was already consumed", async () => {
		const home = await tempDir();
		const cwd = await tempDir();
		const { source, agentDir } = await setupHome(home, ".myconfig");
		const sourceRaw = JSON.stringify({ "gjc.ralplan.maxIterations": 7 });
		const sourceSha256 = nodeCrypto.createHash("sha256").update(sourceRaw).digest("hex");
		await fs.mkdir(agentDir, { recursive: true });
		// Simulate a crash after the patch and source move but before finalization.
		await fs.writeFile(
			path.join(agentDir, "config.yml"),
			YAML.stringify({ gjc: { ralplan: { maxIterations: 7 } } }, null, 2),
		);
		await fs.writeFile(source, sourceRaw);
		await fs.rename(source, `${source}.bak`);
		await fs.writeFile(
			`${source}.migrated`,
			JSON.stringify({
				version: 1,
				status: "pending",
				sourcePath: source,
				backupPath: `${source}.bak`,
				targetPath: path.join(agentDir, "config.yml"),
				canonicalTargetDir: await fs.realpath(agentDir),
				canonicalTargetIdentity: `${(await fs.stat(agentDir)).dev}:${(await fs.stat(agentDir)).ino}`,
				sourceSha256,
				migratedKeys: ["gjc.ralplan.maxIterations"],
				startedAt: new Date().toISOString(),
			}),
		);

		const result = await runProbe(cwd, { home, configDir: ".myconfig" });
		// The copy path NEVER moves the source, so backup + no source is an
		// external DELETION: the migration reverts the marker-owned target value,
		// removes the backup, and clears the marker (instead of finalizing and
		// silently restoring the deleted override).
		expect(result.markerStatus).toBeNull();
		expect(result.backupExists).toBe(false);
		expect(result.targetValue).toBeNull();
	});
	test("deletion recovery never removes a backup replaced during recovery", async () => {
		const home = await tempDir();
		const cwd = await tempDir();
		const { source, agentDir } = await setupHome(home, ".myconfig");
		const sourceRaw = JSON.stringify({ "gjc.ralplan.maxIterations": 7 });
		const sourceSha256 = nodeCrypto.createHash("sha256").update(sourceRaw).digest("hex");
		await fs.mkdir(agentDir, { recursive: true });
		await fs.writeFile(
			path.join(agentDir, "config.yml"),
			YAML.stringify({ gjc: { ralplan: { maxIterations: 7 } } }, null, 2),
		);
		await fs.writeFile(source, sourceRaw);
		await fs.rename(source, `${source}.bak`);
		await fs.writeFile(
			`${source}.migrated`,
			JSON.stringify({
				version: 1,
				status: "pending",
				sourcePath: source,
				backupPath: `${source}.bak`,
				targetPath: path.join(agentDir, "config.yml"),
				canonicalTargetDir: await fs.realpath(agentDir),
				canonicalTargetIdentity: `${(await fs.stat(agentDir)).dev}:${(await fs.stat(agentDir)).ino}`,
				sourceSha256,
				migratedKeys: ["gjc.ralplan.maxIterations"],
				startedAt: new Date().toISOString(),
			}),
		);

		const result = await runProbe(cwd, {
			home,
			configDir: ".myconfig",
			env: { SETTINGS_MIGRATION_TEST_REPLACE_BACKUP_AT_REMOVAL: "1" },
		});

		// The sentinel published at the backup pathname while the recovery
		// removed its verified copy survives; the marker-owned target values are
		// reverted and the marker cleared regardless.
		expect(await fs.readFile(`${source}.bak`, "utf8")).toBe("external-backup-content");
		expect(result.markerStatus).toBeNull();
		expect(result.targetValue).toBeNull();
	});

	test("post-copy mismatch cleanup never removes a replaced backup", async () => {
		const home = await tempDir();
		const cwd = await tempDir();
		const { source } = await setupHome(home, ".myconfig");
		await fs.writeFile(source, '{"gjc.ralplan.maxIterations":7}');
		const backup = `${source}.bak`;
		const sentinel = "external-backup-content";

		// The move succeeds (the source is untouched), but the backup was
		// replaced before the outer post-copy re-hash; the mismatch cleanup must
		// quarantine and re-verify the observed backup instead of removing it by
		// pathname.
		const result = await runProbe(cwd, {
			home,
			configDir: ".myconfig",
			env: { SETTINGS_MIGRATION_TEST_REPLACE_BACKUP_ONLY: "1" },
		});

		expect(await fs.readFile(backup, "utf8")).toBe(sentinel);
		expect(result.targetValue).toBeNull();
		expect(result.markerStatus).toBe("pending");
	});

	test("a scalar/array target root aborts without touching anything", async () => {
		const home = await tempDir();
		const cwd = await tempDir();
		const { source, agentDir } = await setupHome(home, ".myconfig");
		await fs.mkdir(agentDir, { recursive: true });
		await fs.writeFile(path.join(agentDir, "config.yml"), JSON.stringify(["a", "b"]));
		await fs.writeFile(source, JSON.stringify({ "gjc.ralplan.maxIterations": 7 }));

		const result = await runProbe(cwd, { home, configDir: ".myconfig" });
		expect(result.markerExists).toBe(false);
		expect(result.backupExists).toBe(false);
		expect(result.sourceExists).toBe(true);
	});
	test("pending yes/yes with a target that lacks the migrated keys does not delete the source", async () => {
		const home = await tempDir();
		const cwd = await tempDir();
		const { source, agentDir } = await setupHome(home, ".myconfig");
		const sourceRaw = JSON.stringify({ "gjc.ralplan.maxIterations": 7 });
		const sourceSha256 = nodeCrypto.createHash("sha256").update(sourceRaw).digest("hex");
		await fs.mkdir(agentDir, { recursive: true });
		// Target exists but the patch never applied (e.g. a user-created backup
		// with identical content): the source must NOT be dropped.
		await fs.writeFile(path.join(agentDir, "config.yml"), YAML.stringify({ theme: { dark: "red-claw" } }, null, 2));
		await fs.writeFile(source, sourceRaw);
		await fs.writeFile(`${source}.bak`, sourceRaw);
		await fs.writeFile(
			`${source}.migrated`,
			JSON.stringify({
				version: 1,
				status: "pending",
				sourcePath: source,
				backupPath: `${source}.bak`,
				targetPath: path.join(agentDir, "config.yml"),
				canonicalTargetDir: await fs.realpath(agentDir),
				canonicalTargetIdentity: `${(await fs.stat(agentDir)).dev}:${(await fs.stat(agentDir)).ino}`,
				sourceSha256,
				migratedKeys: ["gjc.ralplan.maxIterations"],
				startedAt: new Date().toISOString(),
			}),
		);

		const result = await runProbe(cwd, { home, configDir: ".myconfig" });
		expect(result.markerStatus).toBe("pending"); // not finalized
		expect(result.sourceExists).toBe(true); // source never deleted
		expect(result.backupExists).toBe(true);
	});

	test("a complete marker whose paths do not match the current layout is ignored", async () => {
		const home = await tempDir();
		const cwd = await tempDir();
		const { source } = await setupHome(home, ".myconfig");
		const sourceRaw = JSON.stringify({ "gjc.ralplan.maxIterations": 7 });
		const sourceSha256 = nodeCrypto.createHash("sha256").update(sourceRaw).digest("hex");
		// Stale marker pointing at a different config-root layout.
		await fs.writeFile(source, sourceRaw);
		await fs.writeFile(
			`${source}.migrated`,
			JSON.stringify({
				version: 1,
				status: "complete",
				sourcePath: "/elsewhere/settings.json",
				backupPath: "/elsewhere/settings.json.bak",
				targetPath: "/elsewhere/agent/config.yml",
				sourceSha256,
				migratedKeys: ["gjc.ralplan.maxIterations"],
				startedAt: new Date().toISOString(),
				completedAt: new Date().toISOString(),
			}),
		);

		const result = await runProbe(cwd, { home, configDir: ".myconfig" });
		expect(result.markerStatus).toBe("complete");
		expect(result.backupExists).toBe(true);
		expect(result.sourceExists).toBe(false); // source is retired after fresh completion
		expect(result.targetValue).toBe(7);
	});

	test("a malformed marker is quarantined and a fresh migration completes", async () => {
		const home = await tempDir();
		const cwd = await tempDir();
		const { source } = await setupHome(home, ".myconfig");
		await fs.writeFile(source, JSON.stringify({ "gjc.ralplan.maxIterations": 7 }));
		await fs.writeFile(`${source}.migrated`, "{ not valid json");

		const result = await runProbe(cwd, { home, configDir: ".myconfig" });
		expect(result.markerStatus).toBe("complete");
		expect(result.backupExists).toBe(true);
		expect(result.targetValue).toBe(7);
		const quarantined = await fs
			.lstat(`${source}.migrated.corrupt`)
			.then(() => true)
			.catch(() => false);
		expect(quarantined).toBe(true);
	});

	test("a flat invalid target key is replaced by the valid migrated value", async () => {
		const home = await tempDir();
		const cwd = await tempDir();
		const { source, agentDir } = await setupHome(home, ".myconfig");
		await fs.mkdir(agentDir, { recursive: true });
		// Target uses the accepted flat YAML form with an INVALID value; the flat
		// key wins extraction over the nested form, so it must be removed when
		// the valid legacy value is migrated to the nested path.
		await fs.writeFile(
			path.join(agentDir, "config.yml"),
			YAML.stringify({ "gjc.ralplan.maxIterations": "bad" }, null, 2),
		);
		await fs.writeFile(source, JSON.stringify({ "gjc.ralplan.maxIterations": 7 }));

		const result = await runProbe(cwd, { home, configDir: ".myconfig" });
		expect(result.markerStatus).toBe("complete");
		expect(result.backupExists).toBe(true);
		expect(result.targetValue).toBe(7);
		// The flat invalid key must be gone so resolution sees the nested value.
		const parsed = YAML.parse(await fs.readFile(path.join(agentDir, "config.yml"), "utf8")) as Record<
			string,
			unknown
		>;
		expect(Object.hasOwn(parsed, "gjc.ralplan.maxIterations")).toBe(false);
	});
	test("invalid legacy values are not copied into the durable config.yml", async () => {
		const home = await tempDir();
		const cwd = await tempDir();
		const { source, agentDir } = await setupHome(home, ".myconfig");
		await fs.mkdir(agentDir, { recursive: true });
		await fs.writeFile(
			source,
			JSON.stringify({ "gjc.ultragoal.nudgeBudget": "bad", "gjc.ralplan.maxIterations": 7 }),
		);

		const result = await runProbe(cwd, { home, configDir: ".myconfig" });
		expect(result.markerStatus).toBe("complete");
		expect(result.backupExists).toBe(true);
		expect(result.targetValue).toBe(7); // valid key migrated
		// The invalid nudgeBudget must NOT have been written into config.yml.
		const parsed = YAML.parse(await fs.readFile(path.join(agentDir, "config.yml"), "utf8")) as Record<
			string,
			unknown
		>;
		const gjc = parsed.gjc as Record<string, unknown> | undefined;
		expect(gjc?.ultragoal).toBeUndefined();
	});
	test("a malformed target config.yml does not abort settings load when there is nothing to migrate", async () => {
		const home = await tempDir();
		const cwd = await tempDir();
		const { agentDir } = await setupHome(home, ".myconfig");
		await fs.mkdir(agentDir, { recursive: true });
		await fs.writeFile(path.join(agentDir, "config.yml"), "gjc: [unclosed", "utf8");

		const result = await runProbe(cwd, { home, configDir: ".myconfig" });
		// Load must succeed (no throw from the migration), with no marker/backup.
		expect(result.markerExists).toBe(false);
		expect(result.backupExists).toBe(false);
		expect(result.sourceExists).toBe(false);
	});

	test("a malformed target config.yml with a valid source leaves the source untouched", async () => {
		const home = await tempDir();
		const cwd = await tempDir();
		const { source, agentDir } = await setupHome(home, ".myconfig");
		await fs.mkdir(agentDir, { recursive: true });
		await fs.writeFile(path.join(agentDir, "config.yml"), "gjc: [unclosed", "utf8");
		await fs.writeFile(source, JSON.stringify({ "gjc.ralplan.maxIterations": 7 }));

		const result = await runProbe(cwd, { home, configDir: ".myconfig" });
		// Load survives; the migration warns and leaves source/backup/marker untouched.
		expect(result.sourceExists).toBe(true);
		expect(result.backupExists).toBe(false);
		expect(result.markerExists).toBe(false);
	});

	test("an invalid target value does not block the patch: the valid legacy value wins", async () => {
		const home = await tempDir();
		const cwd = await tempDir();
		const { source, agentDir } = await setupHome(home, ".myconfig");
		await fs.mkdir(agentDir, { recursive: true });
		// Target has an INVALID value for the strict key; the legacy source has a valid one.
		await fs.writeFile(
			path.join(agentDir, "config.yml"),
			YAML.stringify({ gjc: { ralplan: { maxIterations: "not-a-number" } } }, null, 2),
		);
		await fs.writeFile(source, JSON.stringify({ "gjc.ralplan.maxIterations": 7 }));

		const result = await runProbe(cwd, { home, configDir: ".myconfig" });
		expect(result.markerStatus).toBe("complete");
		expect(result.backupExists).toBe(true);
		expect(result.targetValue).toBe(7); // valid legacy value patched over the invalid one
	});
	test("an invalid strict ralplan legacy value keeps the source active (loud failure preserved)", async () => {
		const home = await tempDir();
		const cwd = await tempDir();
		const { source, agentDir } = await setupHome(home, ".myconfig");
		await fs.mkdir(agentDir, { recursive: true });
		// Invalid STRICT key: consuming the source would silently fall back to
		// defaults instead of letting gjc ralplan fail loudly (exit 2).
		await fs.writeFile(source, JSON.stringify({ "gjc.ralplan.maxIterations": "bad" }));

		const result = await runProbe(cwd, { home, configDir: ".myconfig" });
		expect(result.sourceExists).toBe(true); // source kept active
		expect(result.backupExists).toBe(false);
		expect(result.markerExists).toBe(false);
		expect(result.strictInvalidEvidenceExists).toBe(true); // strict evidence recorded
		expect(result.strictInvalidEvidenceKeys).toEqual(["gjc.ralplan.maxIterations"]);
	});
	test("repairing the retained source clears the strict-invalid evidence", async () => {
		const home = await tempDir();
		const cwd = await tempDir();
		const { source, agentDir } = await setupHome(home, ".myconfig");
		await fs.mkdir(agentDir, { recursive: true });
		await fs.writeFile(source, JSON.stringify({ "gjc.ralplan.maxIterations": "bad" }));

		const first = await runProbe(cwd, { home, configDir: ".myconfig" });
		expect(first.strictInvalidEvidenceExists).toBe(true);
		expect(first.sourceExists).toBe(true);

		// User repairs the invalid value: the next load migrates it, retires the
		// source, and clears the evidence so strict resolution stops throwing.
		await fs.writeFile(source, JSON.stringify({ "gjc.ralplan.maxIterations": 7 }));
		const second = await runProbe(cwd, { home, configDir: ".myconfig" });
		expect(second.markerStatus).toBe("complete");
		expect(second.sourceExists).toBe(false); // retired after completion
		expect(second.strictInvalidEvidenceExists).toBe(false);
	});
	test("a future-schema target config.yml is left read-only (migration skipped)", async () => {
		const home = await tempDir();
		const cwd = await tempDir();
		const { source, agentDir } = await setupHome(home, ".myconfig");
		await fs.mkdir(agentDir, { recursive: true });
		await fs.writeFile(
			path.join(agentDir, "config.yml"),
			YAML.stringify({ configSchemaVersion: 999, theme: { dark: "red-claw" } }, null, 2),
		);
		await fs.writeFile(source, JSON.stringify({ "gjc.ralplan.maxIterations": 7 }));

		const result = await runProbe(cwd, { home, configDir: ".myconfig" });
		expect(result.sourceExists).toBe(true); // legacy source stays active
		expect(result.backupExists).toBe(false);
		expect(result.markerExists).toBe(false);
	});
	test("a quoted numeric target value is valid and not overwritten by the migration", async () => {
		const home = await tempDir();
		const cwd = await tempDir();
		const { source, agentDir } = await setupHome(home, ".myconfig");
		await fs.mkdir(agentDir, { recursive: true });
		// The resolver/Settings coerce quoted numerics; the migration must too,
		// so it neither overwrites this target nor treats the legacy value oddly.
		await fs.writeFile(
			path.join(agentDir, "config.yml"),
			YAML.stringify({ gjc: { ralplan: { maxIterations: "9" } } }, null, 2),
		);
		await fs.writeFile(source, JSON.stringify({ "gjc.ralplan.maxIterations": 7 }));

		const result = await runProbe(cwd, { home, configDir: ".myconfig" });
		expect(result.markerStatus).toBe("complete");
		expect(result.backupExists).toBe(true);
		expect(result.targetValue).toBe("9"); // quoted 9 is valid; legacy 7 not patched over it
	});
	test("a valid target override lets the migration proceed past an invalid strict legacy value", async () => {
		const home = await tempDir();
		const cwd = await tempDir();
		const { source, agentDir } = await setupHome(home, ".myconfig");
		await fs.mkdir(agentDir, { recursive: true });
		// The target already carries a VALID maxIterations, so the invalid legacy
		// value would never win in the resolver; the migration must not abort on
		// it and must still migrate the other valid legacy keys.
		await fs.writeFile(
			path.join(agentDir, "config.yml"),
			YAML.stringify({ gjc: { ralplan: { maxIterations: 9 } } }, null, 2),
		);
		await fs.writeFile(
			source,
			JSON.stringify({ "gjc.ralplan.maxIterations": "bad", "gjc.ultragoal.nudgeBudget": 3 }),
		);

		const result = await runProbe(cwd, { home, configDir: ".myconfig" });
		expect(result.markerStatus).toBe("complete"); // migration not aborted
		expect(result.backupExists).toBe(true);
		expect(result.targetValue).toBe(9); // target override preserved
	});
	test("a null YAML target root aborts the migration like a malformed config", async () => {
		const home = await tempDir();
		const cwd = await tempDir();
		const { source, agentDir } = await setupHome(home, ".myconfig");
		await fs.mkdir(agentDir, { recursive: true });
		// YAML `null`/`~` root: #loadYaml treats it as malformed (read-only), so
		// the migration must not write into it or consume the legacy source.
		await fs.writeFile(path.join(agentDir, "config.yml"), "null\n", "utf8");
		await fs.writeFile(source, JSON.stringify({ "gjc.ralplan.maxIterations": 7 }));

		const result = await runProbe(cwd, { home, configDir: ".myconfig" });
		expect(result.sourceExists).toBe(true);
		expect(result.backupExists).toBe(false);
		expect(result.markerExists).toBe(false);
	});
	test("quoted numeric legacy values are written coerced into config.yml", async () => {
		const home = await tempDir();
		const cwd = await tempDir();
		const { source, agentDir } = await setupHome(home, ".myconfig");
		await fs.mkdir(agentDir, { recursive: true });
		await fs.writeFile(source, JSON.stringify({ "gjc.ralplan.maxIterations": "7" }));

		const result = await runProbe(cwd, { home, configDir: ".myconfig" });
		expect(result.markerStatus).toBe("complete");
		expect(result.backupExists).toBe(true);
		expect(result.targetValue).toBe(7); // number, not the raw "7" string
	});
	test("a null legacy source root keeps the source active (strict failure preserved)", async () => {
		const home = await tempDir();
		const cwd = await tempDir();
		const { source, agentDir } = await setupHome(home, ".myconfig");
		await fs.mkdir(agentDir, { recursive: true });
		// The strict resolver treats a null settings root as an invalid shape
		// (exit 2); consuming it via an empty migration would silently default.
		await fs.writeFile(source, "null", "utf8");

		const result = await runProbe(cwd, { home, configDir: ".myconfig" });
		expect(result.sourceExists).toBe(true);
		expect(result.backupExists).toBe(false);
		expect(result.markerExists).toBe(false);
	});
	test("a changed pending source is reapplied over the stale target patch", async () => {
		const home = await tempDir();
		const cwd = await tempDir();
		const { source, agentDir } = await setupHome(home, ".myconfig");
		await fs.mkdir(agentDir, { recursive: true });
		const target = path.join(agentDir, "config.yml");
		// A crashed run patched the OLD legacy value into config.yml...
		await fs.writeFile(target, YAML.stringify({ gjc: { ralplan: { maxIterations: 7 } } }, null, 2));
		// ...and the user edited settings.json before the next load.
		await fs.writeFile(source, '{"gjc.ralplan.maxIterations":9}', "utf8");
		const oldSourceHash = nodeCrypto.createHash("sha256").update('{"gjc.ralplan.maxIterations":7}').digest("hex");
		// The pending marker records the OLD source hash (from the crashed run).
		await fs.writeFile(
			path.join(home, ".myconfig", "settings.json.migrated"),
			JSON.stringify({
				version: 1,
				status: "pending",
				sourcePath: source,
				backupPath: `${source}.bak`,
				targetPath: target,
				canonicalTargetDir: await fs.realpath(agentDir),
				canonicalTargetIdentity: `${(await fs.stat(agentDir)).dev}:${(await fs.stat(agentDir)).ino}`,
				sourceSha256: oldSourceHash,
				migratedKeys: ["gjc.ralplan.maxIterations"],
				startedAt: new Date().toISOString(),
			}),
		);

		const result = await runProbe(cwd, { home, configDir: ".myconfig" });
		// Ownership is unverifiable without a backup: the recovery ABORTS (the
		// source stays active, the marker stays pending) instead of completing
		// with the key omitted from migratedKeys.
		expect(result.markerStatus).toBe("pending");
		expect(result.sourceExists).toBe(true);
		expect(result.targetValue).toBe(7); // unverifiable target kept
	});
	test("an in-place source edit after completion does not mutate the backup", async () => {
		const home = await tempDir();
		const cwd = await tempDir();
		const { source, agentDir } = await setupHome(home, ".myconfig");
		await fs.mkdir(agentDir, { recursive: true });
		await fs.writeFile(source, JSON.stringify({ "gjc.ralplan.maxIterations": 7 }));

		const result = await runProbe(cwd, { home, configDir: ".myconfig" });
		expect(result.markerStatus).toBe("complete");
		// The backup is an INDEPENDENT copy: an in-place edit of the still-active
		// source must not mutate the .bak, so the marker hash keeps describing
		// the migrated bytes.
		const marker = JSON.parse(await fs.readFile(path.join(home, ".myconfig", "settings.json.migrated"), "utf8")) as {
			sourceSha256: string;
		};
		await fs.writeFile(source, JSON.stringify({ "gjc.ralplan.maxIterations": 99 }), "utf8");
		const backupRaw = await fs.readFile(`${source}.bak`, "utf8");
		expect(nodeCrypto.createHash("sha256").update(backupRaw).digest("hex")).toBe(marker.sourceSha256);
	});
	test("a removed pending source key drops its stale target value", async () => {
		const home = await tempDir();
		const cwd = await tempDir();
		const { source, agentDir } = await setupHome(home, ".myconfig");
		await fs.mkdir(agentDir, { recursive: true });
		const target = path.join(agentDir, "config.yml");
		// A crashed run patched maxIterations 7 into config.yml...
		await fs.writeFile(target, YAML.stringify({ gjc: { ralplan: { maxIterations: 7 } } }, null, 2));
		// ...and the user REMOVED the key from settings.json before the next load.
		await fs.writeFile(source, "{}", "utf8");
		const oldSourceHash = nodeCrypto.createHash("sha256").update('{"gjc.ralplan.maxIterations":7}').digest("hex");
		await fs.writeFile(
			path.join(home, ".myconfig", "settings.json.migrated"),
			JSON.stringify({
				version: 1,
				status: "pending",
				sourcePath: source,
				backupPath: `${source}.bak`,
				targetPath: target,
				canonicalTargetDir: await fs.realpath(agentDir),
				canonicalTargetIdentity: `${(await fs.stat(agentDir)).dev}:${(await fs.stat(agentDir)).ino}`,
				sourceSha256: oldSourceHash,
				migratedKeys: ["gjc.ralplan.maxIterations"],
				startedAt: new Date().toISOString(),
			}),
		);

		const result = await runProbe(cwd, { home, configDir: ".myconfig" });
		// Ownership is unverifiable without a backup: the recovery ABORTS (the
		// source stays active, the marker stays pending) instead of completing.
		expect(result.markerStatus).toBe("pending");
		expect(result.sourceExists).toBe(true);
		expect(result.targetValue).toBe(7); // unverifiable target kept
	});
	test("changed-pending recovery does not clobber unrecorded target overrides", async () => {
		const home = await tempDir();
		const cwd = await tempDir();
		const { source, agentDir } = await setupHome(home, ".myconfig");
		await fs.mkdir(agentDir, { recursive: true });
		const target = path.join(agentDir, "config.yml");
		// config.yml already carried a valid USER value for maxIterations, so the
		// crashed migration did NOT record that key; the source is then edited.
		await fs.writeFile(target, YAML.stringify({ gjc: { ralplan: { maxIterations: 9 } } }, null, 2));
		await fs.writeFile(source, '{"gjc.ralplan.maxIterations":11}');
		const oldSourceHash = nodeCrypto.createHash("sha256").update('{"gjc.ralplan.maxIterations":7}').digest("hex");
		await fs.writeFile(
			path.join(home, ".myconfig", "settings.json.migrated"),
			JSON.stringify({
				version: 1,
				status: "pending",
				sourcePath: source,
				backupPath: `${source}.bak`,
				targetPath: target,
				canonicalTargetDir: await fs.realpath(agentDir),
				canonicalTargetIdentity: `${(await fs.stat(agentDir)).dev}:${(await fs.stat(agentDir)).ino}`,
				sourceSha256: oldSourceHash,
				migratedKeys: ["gjc.ultragoal.nudgeBudget"], // NOT maxIterations
				startedAt: new Date().toISOString(),
			}),
		);

		const result = await runProbe(cwd, { home, configDir: ".myconfig" });
		expect(result.targetValue).toBe(9); // the user target override is preserved
	});

	test("changed-pending recovery unsets a stale tolerant patch for an invalid source", async () => {
		const home = await tempDir();
		const cwd = await tempDir();
		const { source, agentDir } = await setupHome(home, ".myconfig");
		await fs.mkdir(agentDir, { recursive: true });
		const target = path.join(agentDir, "config.yml");
		// The crashed run wrote nudgeBudget 7 into config.yml; the user then set
		// the source nudgeBudget to an INVALID value before the retry.
		await fs.writeFile(target, YAML.stringify({ gjc: { ultragoal: { nudgeBudget: 7 } } }, null, 2));
		await fs.writeFile(source, '{"gjc.ultragoal.nudgeBudget":"bad"}');
		const oldSourceHash = nodeCrypto.createHash("sha256").update('{"gjc.ultragoal.nudgeBudget":7}').digest("hex");
		await fs.writeFile(
			path.join(home, ".myconfig", "settings.json.migrated"),
			JSON.stringify({
				version: 1,
				status: "pending",
				sourcePath: source,
				backupPath: `${source}.bak`,
				targetPath: target,
				canonicalTargetDir: await fs.realpath(agentDir),
				canonicalTargetIdentity: `${(await fs.stat(agentDir)).dev}:${(await fs.stat(agentDir)).ino}`,
				sourceSha256: oldSourceHash,
				migratedKeys: ["gjc.ultragoal.nudgeBudget"],
				startedAt: new Date().toISOString(),
			}),
		);

		const result = await runProbe(cwd, { home, configDir: ".myconfig" });
		expect(result.markerStatus).toBe("complete");
		// The stale target patch must be gone so the tolerant runtime falls back.
		const parsed = YAML.parse(await fs.readFile(target, "utf8")) as Record<string, unknown>;
		const ultragoal = (parsed.gjc as Record<string, unknown> | undefined)?.ultragoal as
			| Record<string, unknown>
			| undefined;
		expect(ultragoal?.nudgeBudget).toBe(7); // unverifiable without a backup: kept
	});

	test("changed-pending recovery removes the stale strict patch before aborting", async () => {
		const home = await tempDir();
		const cwd = await tempDir();
		const { source, agentDir } = await setupHome(home, ".myconfig");
		await fs.mkdir(agentDir, { recursive: true });
		const target = path.join(agentDir, "config.yml");
		// The crashed run wrote maxIterations 7; the user then set the source to
		// an INVALID strict value, so the migration must abort but FIRST remove
		// the stale target patch (otherwise the stale valid value would shadow
		// the invalid legacy source and gjc ralplan would not exit 2).
		await fs.writeFile(target, YAML.stringify({ gjc: { ralplan: { maxIterations: 7 } } }, null, 2));
		await fs.writeFile(source, '{"gjc.ralplan.maxIterations":"bad"}');
		const oldSourceHash = nodeCrypto.createHash("sha256").update('{"gjc.ralplan.maxIterations":7}').digest("hex");
		await fs.writeFile(
			path.join(home, ".myconfig", "settings.json.migrated"),
			JSON.stringify({
				version: 1,
				status: "pending",
				sourcePath: source,
				backupPath: `${source}.bak`,
				targetPath: target,
				canonicalTargetDir: await fs.realpath(agentDir),
				canonicalTargetIdentity: `${(await fs.stat(agentDir)).dev}:${(await fs.stat(agentDir)).ino}`,
				sourceSha256: oldSourceHash,
				migratedKeys: ["gjc.ralplan.maxIterations"],
				startedAt: new Date().toISOString(),
			}),
		);

		const result = await runProbe(cwd, { home, configDir: ".myconfig" });
		expect(result.sourceExists).toBe(true); // strict failure preserved
		const parsed = YAML.parse(await fs.readFile(target, "utf8")) as Record<string, unknown>;
		const ralplan = (parsed.gjc as Record<string, unknown> | undefined)?.ralplan as
			| Record<string, unknown>
			| undefined;
		expect(ralplan?.maxIterations).toBe(7); // unverifiable without a backup: kept
	});
	test("changed-pending strict abort applies all queued stale-key repairs", async () => {
		const home = await tempDir();
		const cwd = await tempDir();
		const { source, agentDir } = await setupHome(home, ".myconfig");
		await fs.mkdir(agentDir, { recursive: true });
		const target = path.join(agentDir, "config.yml");
		// The crashed run wrote BOTH a threshold and maxIterations; the user then
		// REMOVED the threshold and set maxIterations to an INVALID strict value.
		await fs.writeFile(
			target,
			YAML.stringify(
				{ gjc: { deepInterview: { ambiguityThreshold: 0.9 }, ralplan: { maxIterations: 7 } } },
				null,
				2,
			),
		);
		await fs.writeFile(source, '{"gjc.ralplan.maxIterations":"bad"}');
		const oldSourceHash = nodeCrypto
			.createHash("sha256")
			.update('{"gjc.deepInterview.ambiguityThreshold":0.9,"gjc.ralplan.maxIterations":7}')
			.digest("hex");
		await fs.writeFile(
			path.join(home, ".myconfig", "settings.json.migrated"),
			JSON.stringify({
				version: 1,
				status: "pending",
				sourcePath: source,
				backupPath: `${source}.bak`,
				targetPath: target,
				canonicalTargetDir: await fs.realpath(agentDir),
				canonicalTargetIdentity: `${(await fs.stat(agentDir)).dev}:${(await fs.stat(agentDir)).ino}`,
				sourceSha256: oldSourceHash,
				migratedKeys: ["gjc.deepInterview.ambiguityThreshold", "gjc.ralplan.maxIterations"],
				startedAt: new Date().toISOString(),
			}),
		);

		const result = await runProbe(cwd, { home, configDir: ".myconfig" });
		expect(result.sourceExists).toBe(true); // strict failure preserved
		const parsed = YAML.parse(await fs.readFile(target, "utf8")) as Record<string, unknown>;
		const gjc = parsed.gjc as Record<string, unknown> | undefined;
		const ralplan = gjc?.ralplan as Record<string, unknown> | undefined;
		expect(ralplan?.maxIterations).toBe(7); // unverifiable without a backup: kept
		const deepInterview = gjc?.deepInterview as Record<string, unknown> | undefined;
		// The removed threshold's ownership is unverifiable without a backup
		// (W6MMR): it is left untouched rather than blindly unset.
		expect(deepInterview?.ambiguityThreshold).toBe(0.9);
	});
	test("the strict abort commits only marker-owned repairs, not fresh unrecorded keys", async () => {
		const home = await tempDir();
		const cwd = await tempDir();
		const { source, agentDir } = await setupHome(home, ".myconfig");
		await fs.mkdir(agentDir, { recursive: true });
		const target = path.join(agentDir, "config.yml");
		// The marker owns ONLY autoHandoff (processed BEFORE the invalid ralplan
		// key); the edited source also adds an UNRECORDED threshold (processed
		// even earlier, so its SET is queued) - the strict abort must commit the
		// autoHandoff repair but NOT the unrecorded threshold.
		await fs.writeFile(target, YAML.stringify({ gjc: { ralplan: { autoHandoff: "team" } } }, null, 2));
		await fs.writeFile(
			source,
			'{"gjc.deepInterview.ambiguityThreshold":0.8,"gjc.ralplan.autoHandoff":"off","gjc.ralplan.maxIterations":"bad"}',
		);
		const oldSourceHash = nodeCrypto.createHash("sha256").update('{"gjc.ralplan.autoHandoff":"team"}').digest("hex");
		await fs.writeFile(
			path.join(home, ".myconfig", "settings.json.migrated"),
			JSON.stringify({
				version: 1,
				status: "pending",
				sourcePath: source,
				backupPath: `${source}.bak`,
				targetPath: target,
				canonicalTargetDir: await fs.realpath(agentDir),
				canonicalTargetIdentity: `${(await fs.stat(agentDir)).dev}:${(await fs.stat(agentDir)).ino}`,
				sourceSha256: oldSourceHash,
				migratedKeys: ["gjc.ralplan.autoHandoff"],
				startedAt: new Date().toISOString(),
			}),
		);

		const result = await runProbe(cwd, { home, configDir: ".myconfig" });
		expect(result.sourceExists).toBe(true); // strict failure preserved
		const parsed = YAML.parse(await fs.readFile(target, "utf8")) as Record<string, unknown>;
		const gjc = parsed.gjc as Record<string, unknown> | undefined;
		const ralplan = gjc?.ralplan as Record<string, unknown> | undefined;
		expect(ralplan?.autoHandoff).toBe("team"); // unverifiable without a backup: kept
		expect(ralplan?.maxIterations).toBeUndefined();
		const deepInterview = gjc?.deepInterview as Record<string, unknown> | undefined;
		expect(deepInterview?.ambiguityThreshold).toBeUndefined(); // unrecorded key NOT committed
	});
	test("a crash then a source edit recovers via the changed-source repair", async () => {
		const home = await tempDir();
		const cwd = await tempDir();
		const { source, agentDir } = await setupHome(home, ".myconfig");
		await fs.mkdir(agentDir, { recursive: true });
		const target = path.join(agentDir, "config.yml");
		const oldRaw = '{"gjc.ralplan.maxIterations":7}';
		await fs.writeFile(target, YAML.stringify({ gjc: { ralplan: { maxIterations: 7 } } }, null, 2));
		await fs.writeFile(`${source}.bak`, oldRaw); // backup matches the marker
		await fs.writeFile(source, '{"gjc.ralplan.maxIterations":9}'); // user edited the source
		const oldSourceHash = nodeCrypto.createHash("sha256").update(oldRaw).digest("hex");
		await fs.writeFile(
			path.join(home, ".myconfig", "settings.json.migrated"),
			JSON.stringify({
				version: 1,
				status: "pending",
				sourcePath: source,
				backupPath: `${source}.bak`,
				targetPath: target,
				canonicalTargetDir: await fs.realpath(agentDir),
				canonicalTargetIdentity: `${(await fs.stat(agentDir)).dev}:${(await fs.stat(agentDir)).ino}`,
				sourceSha256: oldSourceHash,
				migratedKeys: ["gjc.ralplan.maxIterations"],
				startedAt: new Date().toISOString(),
			}),
		);

		const result = await runProbe(cwd, { home, configDir: ".myconfig" });
		// The stale marker-owned value is reverted, the backup/marker cleared,
		// so the edited source becomes effective (fresh re-migration on the next
		// load would also re-apply 9).
		expect(result.markerStatus).toBeNull();
		expect(result.backupExists).toBe(false);
		expect(result.targetValue).toBeNull();
	});

	test("a user-edited target value is kept during stale-complete re-migration", async () => {
		const home = await tempDir();
		const cwd = await tempDir();
		const { source, agentDir } = await setupHome(home, ".myconfig");
		await fs.mkdir(agentDir, { recursive: true });
		const target = path.join(agentDir, "config.yml");
		const oldRaw = '{"gjc.ralplan.maxIterations":7}';
		// The user edited the TARGET to 11 AFTER the migration...
		await fs.writeFile(target, YAML.stringify({ gjc: { ralplan: { maxIterations: 11 } } }, null, 2));
		await fs.writeFile(`${source}.bak`, oldRaw); // migration copy (old value 7)
		// ...and the legacy source to 9.
		await fs.writeFile(source, '{"gjc.ralplan.maxIterations":9}');
		const oldSourceHash = nodeCrypto.createHash("sha256").update(oldRaw).digest("hex");
		await fs.writeFile(
			path.join(home, ".myconfig", "settings.json.migrated"),
			JSON.stringify({
				version: 1,
				status: "complete",
				sourcePath: source,
				backupPath: `${source}.bak`,
				targetPath: target,
				canonicalTargetDir: await fs.realpath(agentDir),
				canonicalTargetIdentity: `${(await fs.stat(agentDir)).dev}:${(await fs.stat(agentDir)).ino}`,
				sourceSha256: oldSourceHash,
				migratedKeys: ["gjc.ralplan.maxIterations"],
				startedAt: new Date().toISOString(),
				completedAt: new Date().toISOString(),
			}),
		);

		const result = await runProbe(cwd, { home, configDir: ".myconfig" });
		// The user's NEWER target value (11) is not the migration's write (7), so
		// the re-migration must NOT clobber it.
		expect(result.markerStatus).toBe("complete");
		expect(result.targetValue).toBe(11);
	});
	test("a malformed source parent aborts the initial migration", async () => {
		const home = await tempDir();
		const cwd = await tempDir();
		const { source, agentDir } = await setupHome(home, ".myconfig");
		await fs.mkdir(agentDir, { recursive: true });
		await fs.writeFile(source, '{"gjc":{"ralplan":"broken"}}'); // non-mapping parent

		const result = await runProbe(cwd, { home, configDir: ".myconfig" });
		// The source stays active (strict ralplan fails on it) - no completion.
		expect(result.sourceExists).toBe(true);
		expect(result.markerStatus).toBeNull();
		expect(result.strictInvalidEvidenceExists).toBe(true);
		expect(result.strictInvalidEvidenceMalformed).toBe(true);
	});

	test("an edited source with an invalid root leaves everything unchanged", async () => {
		const home = await tempDir();
		const cwd = await tempDir();
		const { source, agentDir } = await setupHome(home, ".myconfig");
		await fs.mkdir(agentDir, { recursive: true });
		const target = path.join(agentDir, "config.yml");
		const oldRaw = '{"gjc.ralplan.maxIterations":7}';
		await fs.writeFile(target, YAML.stringify({ gjc: { ralplan: { maxIterations: 7 } } }, null, 2));
		await fs.writeFile(`${source}.bak`, oldRaw);
		await fs.writeFile(source, "null"); // edited to an invalid root
		const oldSourceHash = nodeCrypto.createHash("sha256").update(oldRaw).digest("hex");
		await fs.writeFile(
			path.join(home, ".myconfig", "settings.json.migrated"),
			JSON.stringify({
				version: 1,
				status: "complete",
				sourcePath: source,
				backupPath: `${source}.bak`,
				targetPath: target,
				canonicalTargetDir: await fs.realpath(agentDir),
				canonicalTargetIdentity: `${(await fs.stat(agentDir)).dev}:${(await fs.stat(agentDir)).ino}`,
				sourceSha256: oldSourceHash,
				migratedKeys: ["gjc.ralplan.maxIterations"],
				startedAt: new Date().toISOString(),
				completedAt: new Date().toISOString(),
			}),
		);

		const result = await runProbe(cwd, { home, configDir: ".myconfig" });
		// The malformed source is not accepted; the target and marker stay intact
		// (strict ralplan fails on the malformed source via the resolver).
		expect(result.markerStatus).toBe("complete");
		expect(result.targetValue).toBe(7);
	});
	test("an invalid edited value is not copied during reconciliation", async () => {
		const home = await tempDir();
		const cwd = await tempDir();
		const { source, agentDir } = await setupHome(home, ".myconfig");
		await fs.mkdir(agentDir, { recursive: true });
		const target = path.join(agentDir, "config.yml");
		const oldRaw = '{"gjc.ultragoal.nudgeBudget":7}';
		await fs.writeFile(target, YAML.stringify({ gjc: { ultragoal: { nudgeBudget: 7 } } }, null, 2));
		await fs.writeFile(`${source}.bak`, oldRaw);
		await fs.writeFile(source, '{"gjc.ultragoal.nudgeBudget":"bad"}'); // invalid edit
		const oldSourceHash = nodeCrypto.createHash("sha256").update(oldRaw).digest("hex");
		await fs.writeFile(
			path.join(home, ".myconfig", "settings.json.migrated"),
			JSON.stringify({
				version: 1,
				status: "complete",
				sourcePath: source,
				backupPath: `${source}.bak`,
				targetPath: target,
				canonicalTargetDir: await fs.realpath(agentDir),
				canonicalTargetIdentity: `${(await fs.stat(agentDir)).dev}:${(await fs.stat(agentDir)).ino}`,
				sourceSha256: oldSourceHash,
				migratedKeys: ["gjc.ultragoal.nudgeBudget"],
				startedAt: new Date().toISOString(),
				completedAt: new Date().toISOString(),
			}),
		);

		const result = await runProbe(cwd, { home, configDir: ".myconfig" });
		// The invalid value is NOT written; the stale migration-write stays and
		// the marker is not updated (the legacy layer stays reactivated).
		const parsed = YAML.parse(await fs.readFile(target, "utf8")) as Record<string, unknown>;
		const ultragoal = (parsed.gjc as Record<string, unknown> | undefined)?.ultragoal as
			| Record<string, unknown>
			| undefined;
		expect(ultragoal?.nudgeBudget).toBe(7); // the migration-write, not "bad"
		expect(result.markerStatus).toBe("complete");
	});

	test("pending malformed-source recovery preserves user overrides and clears verified migration writes", async () => {
		const home = await tempDir();
		const cwd = await tempDir();
		const { source, agentDir } = await setupHome(home, ".myconfig");
		await fs.mkdir(agentDir, { recursive: true });
		const target = path.join(agentDir, "config.yml");
		const oldRaw = JSON.stringify({
			"gjc.ralplan.maxIterations": 7,
			"gjc.ultragoal.nudgeBudget": 5,
		});
		// The crashed migration wrote both values. The user then changed only
		// maxIterations before the legacy source became an unusable null root.
		await fs.writeFile(
			target,
			YAML.stringify({ gjc: { ralplan: { maxIterations: 11 }, ultragoal: { nudgeBudget: 5 } } }, null, 2),
		);
		await fs.writeFile(source, "null", "utf8");
		await fs.writeFile(`${source}.bak`, oldRaw);
		const oldSourceHash = nodeCrypto.createHash("sha256").update(oldRaw).digest("hex");
		await fs.writeFile(
			`${source}.migrated`,
			JSON.stringify({
				version: 1,
				status: "pending",
				sourcePath: source,
				backupPath: `${source}.bak`,
				targetPath: target,
				canonicalTargetDir: await fs.realpath(agentDir),
				canonicalTargetIdentity: `${(await fs.stat(agentDir)).dev}:${(await fs.stat(agentDir)).ino}`,
				sourceSha256: oldSourceHash,
				migratedKeys: ["gjc.ralplan.maxIterations", "gjc.ultragoal.nudgeBudget"],
				startedAt: new Date().toISOString(),
			}),
		);

		const result = await runProbe(cwd, { home, configDir: ".myconfig" });
		const parsed = YAML.parse(await fs.readFile(target, "utf8")) as Record<string, unknown>;
		const gjc = parsed.gjc as Record<string, unknown>;
		const ultragoal = gjc.ultragoal as Record<string, unknown> | undefined;
		// The post-crash user override is not equal to the verified backup value.
		expect(result.targetValue).toBe(11);
		// The unchanged target still matches the migration-owned backup value.
		expect(ultragoal?.nudgeBudget).toBeUndefined();
		expect(result.markerStatus).toBeNull();
		expect(result.backupExists).toBe(false);
	});

	test("pending deletion recovery preserves a user-edited target override", async () => {
		const home = await tempDir();
		const cwd = await tempDir();
		const { source, agentDir } = await setupHome(home, ".myconfig");
		await fs.mkdir(agentDir, { recursive: true });
		const target = path.join(agentDir, "config.yml");
		const oldRaw = '{"gjc.ralplan.maxIterations":7}';
		// Crash after patch+backup; the user then set 11 via config set and
		// deleted the source.
		await fs.writeFile(target, YAML.stringify({ gjc: { ralplan: { maxIterations: 11 } } }, null, 2));
		await fs.writeFile(`${source}.bak`, oldRaw);
		const oldSourceHash = nodeCrypto.createHash("sha256").update(oldRaw).digest("hex");
		await fs.writeFile(
			path.join(home, ".myconfig", "settings.json.migrated"),
			JSON.stringify({
				version: 1,
				status: "pending",
				sourcePath: source,
				backupPath: `${source}.bak`,
				targetPath: target,
				canonicalTargetDir: await fs.realpath(agentDir),
				canonicalTargetIdentity: `${(await fs.stat(agentDir)).dev}:${(await fs.stat(agentDir)).ino}`,
				sourceSha256: oldSourceHash,
				migratedKeys: ["gjc.ralplan.maxIterations"],
				startedAt: new Date().toISOString(),
			}),
		);

		const result = await runProbe(cwd, { home, configDir: ".myconfig" });
		expect(result.markerStatus).toBeNull();
		expect(result.backupExists).toBe(false);
		expect(result.targetValue).toBe(11); // the user's override is preserved
	});

	test("an unapplied pending marker never claims an editor value as migration-owned", async () => {
		const home = await tempDir();
		const cwd = await tempDir();
		const { source, agentDir } = await setupHome(home, ".myconfig");
		await fs.mkdir(agentDir, { recursive: true });
		const target = path.join(agentDir, "config.yml");
		const sourceRaw = '{"gjc.ralplan.maxIterations":7}';
		// The crashed run wrote its pending marker but an editor changed
		// config.yml (9) before the target patch; no backup exists because the
		// source move happens only after the patch commits.
		await fs.writeFile(target, YAML.stringify({ gjc: { ralplan: { maxIterations: 9 } } }, null, 2));
		await fs.writeFile(source, sourceRaw);
		await fs.writeFile(
			`${source}.migrated`,
			JSON.stringify({
				version: 1,
				status: "pending",
				sourcePath: source,
				backupPath: `${source}.bak`,
				targetPath: target,
				canonicalTargetDir: await fs.realpath(agentDir),
				canonicalTargetIdentity: `${(await fs.stat(agentDir)).dev}:${(await fs.stat(agentDir)).ino}`,
				sourceSha256: nodeCrypto.createHash("sha256").update(sourceRaw).digest("hex"),
				migratedKeys: ["gjc.ralplan.maxIterations"],
				startedAt: new Date().toISOString(),
			}),
		);

		const result = await runProbe(cwd, { home, configDir: ".myconfig" });
		// The editor's 9 is a genuine override: not overwritten, not recorded as
		// migration-owned (migratedKeys is rebuilt empty), migration completes.
		expect(result.targetValue).toBe(9);
		expect(result.markerStatus).toBe("complete");
		expect(result.backupExists).toBe(true);

		// Deleting the legacy source must NOT revert the editor's 9.
		await fs.rm(source, { force: true });
		const afterDelete = await runProbe(cwd, { home, configDir: ".myconfig" });
		expect(afterDelete.targetValue).toBe(9);
	});

	test("a user-edited target is not unset when the key is removed from the source", async () => {
		const home = await tempDir();
		const cwd = await tempDir();
		const { source, agentDir } = await setupHome(home, ".myconfig");
		await fs.mkdir(agentDir, { recursive: true });
		const target = path.join(agentDir, "config.yml");
		const oldRaw = '{"gjc.ralplan.maxIterations":7}';
		const agentIdentity = await fs.stat(agentDir);
		// The crash left the migration-written value 7; the user then set 9 via
		// config set AND removed the key from the legacy source.
		await fs.writeFile(target, YAML.stringify({ gjc: { ralplan: { maxIterations: 9 } } }, null, 2));
		await fs.writeFile(`${source}.bak`, oldRaw);
		await fs.writeFile(source, "{}"); // key removed from source
		await fs.writeFile(
			`${source}.migrated`,
			JSON.stringify({
				version: 1,
				status: "pending",
				sourcePath: source,
				backupPath: `${source}.bak`,
				targetPath: target,
				canonicalTargetDir: await fs.realpath(agentDir),
				canonicalTargetIdentity: `${agentIdentity.dev}:${agentIdentity.ino}`,
				sourceSha256: nodeCrypto.createHash("sha256").update(oldRaw).digest("hex"),
				migratedKeys: ["gjc.ralplan.maxIterations"],
				startedAt: new Date().toISOString(),
			}),
		);

		const result = await runProbe(cwd, { home, configDir: ".myconfig" });
		// The target 9 does not match the verified backup 7: it is a genuine
		// override and must survive, not be unset merely because a backup exists.
		// The edited-source recovery clears the recovery artifacts after keeping
		// the override.
		expect(result.targetValue).toBe(9);
		expect(result.markerStatus).toBeNull();
	});

	test("an identity-less pending marker never applies recovery claims", async () => {
		const home = await tempDir();
		const cwd = await tempDir();
		const { source, agentDir } = await setupHome(home, ".myconfig");
		await fs.mkdir(agentDir, { recursive: true });
		const target = path.join(agentDir, "config.yml");
		const oldRaw = '{"gjc.ralplan.maxIterations":7}';
		// A (possibly replaced) profile holds a genuine value matching the old
		// backup; an identity-less pending marker from an older build cannot
		// prove this value is migration-owned, so recovery must refuse its claims.
		await fs.writeFile(target, YAML.stringify({ gjc: { ralplan: { maxIterations: 7 } } }, null, 2));
		await fs.writeFile(`${source}.bak`, oldRaw);
		await fs.writeFile(source, '{"gjc.ralplan.maxIterations":9}'); // edited legacy source
		await fs.writeFile(
			`${source}.migrated`,
			JSON.stringify({
				version: 1,
				status: "pending",
				sourcePath: source,
				backupPath: `${source}.bak`,
				targetPath: target,
				sourceSha256: nodeCrypto.createHash("sha256").update(oldRaw).digest("hex"),
				migratedKeys: ["gjc.ralplan.maxIterations"],
				startedAt: new Date().toISOString(),
			}),
		);

		const result = await runProbe(cwd, { home, configDir: ".myconfig" });
		// Claims refused: the genuine override is never unset, and the recovery
		// artifacts are left untouched for diagnosis.
		expect(result.targetValue).toBe(7);
		expect(result.backupExists).toBe(true);
		expect(result.markerStatus).toBe("pending");
	});

	test("a pending marker for a replaced agent directory never claims the new profile", async () => {
		const home = await tempDir();
		const cwd = await tempDir();
		const { source, agentDir } = await setupHome(home, ".myconfig");
		await fs.mkdir(agentDir, { recursive: true });
		const target = path.join(agentDir, "config.yml");
		const sourceRaw = '{"gjc.ralplan.maxIterations":7}';
		await fs.writeFile(source, sourceRaw);
		// A crashed run's pending marker records an identity that no longer
		// matches the current agent directory (deleted/recreated or repointed).
		await fs.writeFile(
			`${source}.migrated`,
			JSON.stringify({
				version: 1,
				status: "pending",
				sourcePath: source,
				backupPath: `${source}.bak`,
				targetPath: target,
				canonicalTargetDir: agentDir,
				canonicalTargetIdentity: "replaced:0",
				sourceSha256: nodeCrypto.createHash("sha256").update(sourceRaw).digest("hex"),
				migratedKeys: ["gjc.ralplan.maxIterations"],
				startedAt: new Date().toISOString(),
			}),
		);

		const result = await runProbe(cwd, { home, configDir: ".myconfig" });
		// The stale marker's claims are refused; the migration re-runs fresh into
		// the current profile and completes with the source value.
		expect(result.markerStatus).toBe("complete");
		expect(result.targetValue).toBe(7);
		expect(result.backupExists).toBe(true);
	});

	test("an externally created backup survives an aborted migration", async () => {
		const home = await tempDir();
		const cwd = await tempDir();
		const { source, agentDir } = await setupHome(home, ".myconfig");
		await fs.mkdir(agentDir, { recursive: true });
		await fs.writeFile(source, '{"gjc.ralplan.maxIterations":7}');
		const backup = `${source}.bak`;
		const sentinel = "external-backup-content";
		// Simulate another process: as soon as this run publishes its pending
		// marker, delete the legacy source and (if no backup exists yet) create
		// one of its own. A backup this migration did not create must never be
		// removed by an abort path.
		const interceptor = Bun.spawn(
			[
				process.execPath,
				"-e",
				`
				import * as fs from "node:fs";
				const marker = ${JSON.stringify(`${source}.migrated`)};
				const source = ${JSON.stringify(source)};
				const backup = ${JSON.stringify(backup)};
				const sentinel = ${JSON.stringify(sentinel)};
				const timer = setInterval(() => {
					if (!fs.existsSync(marker)) return;
					clearInterval(timer);
					fs.rmSync(source, { force: true });
					try {
						fs.writeFileSync(backup, sentinel, { flag: "wx" });
					} catch { /* a migration-owned backup already exists */ }
				}, 1);
			`,
			],
			{ stdout: "pipe", stderr: "pipe" },
		);
		try {
			const result = await runProbe(cwd, { home, configDir: ".myconfig" });
			expect(result.sourceExists).toBe(false);
			// The patch never commits (the source vanishes before the move), so
			// the target holds no migrated value.
			expect(result.targetValue).toBeNull();
			if (result.backupExists) {
				// If a backup is present at the end, it must be the EXTERNAL sentinel
				// (this run never created a backup it could later remove).
				expect(await fs.readFile(backup, "utf8")).toBe(sentinel);
			} else {
				// The migration's own no-replace move already ran before the source
				// deletion landed; its owned backup was removed by the post-move abort.
				expect(result.markerStatus).toBeNull();
			}
		} finally {
			interceptor.kill();
		}
	});
	test("a backup replaced after its identity capture is never removed by the abort path", async () => {
		const home = await tempDir();
		const cwd = await tempDir();
		const { source } = await setupHome(home, ".myconfig");
		await fs.writeFile(source, '{"gjc.ralplan.maxIterations":7}');
		const backup = `${source}.bak`;
		const sentinel = "external-backup-content";

		const result = await runProbe(cwd, {
			home,
			configDir: ".myconfig",
			env: { SETTINGS_MIGRATION_TEST_REPLACE_BACKUP: "1" },
		});

		// The external replacement is preserved: the abort path never unlinks a
		// backup that is no longer the file this run created (the promise that
		// externally created backup data is never removed).
		expect(await fs.readFile(backup, "utf8")).toBe(sentinel);
		// The source edit aborted the move: the target patch was reverted and
		// the pending marker retained for the next load.
		expect(result.markerStatus).toBe("pending");
		expect(result.targetValue).toBeNull();
		// No quarantine leftovers: the migration's own copy was restored and the
		// external replacement was never displaced.
		const leftovers = (await fs.readdir(path.join(home, ".myconfig"))).filter(name => name.includes(".quarantine-"));
		expect(leftovers).toEqual([]);
	});
	test("a backup published at the public pathname during removal is never deleted", async () => {
		const home = await tempDir();
		const cwd = await tempDir();
		const { source } = await setupHome(home, ".myconfig");
		await fs.writeFile(source, '{"gjc.ralplan.maxIterations":7}');
		const backup = `${source}.bak`;
		const sentinel = "external-backup-content";

		const result = await runProbe(cwd, {
			home,
			configDir: ".myconfig",
			env: { SETTINGS_MIGRATION_TEST_REPLACE_BACKUP_AT_REMOVAL: "1" },
		});

		// The file published at the backup pathname while the migration removed
		// its own quarantined copy is preserved: the removal operates on the
		// private quarantine name, never on the public pathname.
		expect(await fs.readFile(backup, "utf8")).toBe(sentinel);
		expect(result.markerStatus).toBe("pending");
		expect(result.targetValue).toBeNull();
		// No quarantine leftovers: the migration's own copy was the one removed.
		const leftovers = (await fs.readdir(path.join(home, ".myconfig"))).filter(name => name.includes(".quarantine-"));
		expect(leftovers).toEqual([]);
	});

	test("an identity-less complete marker never applies recovery claims", async () => {
		const home = await tempDir();
		const cwd = await tempDir();
		const { source, agentDir } = await setupHome(home, ".myconfig");
		await fs.mkdir(agentDir, { recursive: true });
		const target = path.join(agentDir, "config.yml");
		const oldRaw = '{"gjc.ralplan.maxIterations":7}';
		// A (possibly replaced) profile holds a value matching the old backup; an
		// identity-less complete marker from an older build cannot prove this
		// value is migration-owned, so deletion recovery must refuse its claims.
		await fs.writeFile(target, YAML.stringify({ gjc: { ralplan: { maxIterations: 7 } } }, null, 2));
		await fs.writeFile(`${source}.bak`, oldRaw);
		// The legacy source was deleted after completion.
		await fs.writeFile(
			`${source}.migrated`,
			JSON.stringify({
				version: 1,
				status: "complete",
				sourcePath: source,
				backupPath: `${source}.bak`,
				targetPath: target,
				sourceSha256: nodeCrypto.createHash("sha256").update(oldRaw).digest("hex"),
				migratedKeys: ["gjc.ralplan.maxIterations"],
				startedAt: new Date().toISOString(),
				completedAt: new Date().toISOString(),
			}),
		);

		const result = await runProbe(cwd, { home, configDir: ".myconfig" });
		// Claims refused: the profile value is never reverted, and the recovery
		// artifacts are left untouched.
		expect(result.targetValue).toBe(7);
		expect(result.backupExists).toBe(true);
	});

	test("a complete marker for a replaced agent directory never recovers into the new profile", async () => {
		const home = await tempDir();
		const cwd = await tempDir();
		const { source, agentDir } = await setupHome(home, ".myconfig");
		await fs.mkdir(agentDir, { recursive: true });
		const target = path.join(agentDir, "config.yml");
		const oldRaw = '{"gjc.ralplan.maxIterations":7}';
		// The replacement profile holds the old migration-copied value.
		await fs.writeFile(target, YAML.stringify({ gjc: { ralplan: { maxIterations: 7 } } }, null, 2));
		await fs.writeFile(`${source}.bak`, oldRaw);
		// The user EDITED the legacy source after the migration.
		await fs.writeFile(source, '{"gjc.ralplan.maxIterations":12}');
		// The completed marker records an identity that no longer matches the
		// current agent directory (deleted/recreated or repointed).
		await fs.writeFile(
			`${source}.migrated`,
			JSON.stringify({
				version: 1,
				status: "complete",
				sourcePath: source,
				backupPath: `${source}.bak`,
				targetPath: target,
				canonicalTargetDir: agentDir,
				canonicalTargetIdentity: "replaced:0",
				sourceSha256: nodeCrypto.createHash("sha256").update(oldRaw).digest("hex"),
				migratedKeys: ["gjc.ralplan.maxIterations"],
				startedAt: new Date().toISOString(),
				completedAt: new Date().toISOString(),
			}),
		);

		const result = await runProbe(cwd, { home, configDir: ".myconfig" });
		// The stale marker's claims are refused: the replacement profile's value
		// is a genuine override that the fresh re-run must NOT overwrite (the
		// edited source value 12 never clobbers the present valid target 7).
		expect(result.markerStatus).toBe("complete");
		expect(result.targetValue).toBe(7);
		expect(result.backupExists).toBe(true);
	});

	test("a pre-apply repair marker does not reclaim a matching user override after source deletion", async () => {
		const home = await tempDir();
		const cwd = await tempDir();
		const { source, agentDir } = await setupHome(home, ".myconfig");
		await fs.mkdir(agentDir, { recursive: true });
		const target = path.join(agentDir, "config.yml");
		const originalRaw = '{"gjc.ralplan.maxIterations":7}';
		const proposedRaw = '{"gjc.ralplan.maxIterations":9}';
		const hash = (value: unknown): string =>
			nodeCrypto.createHash("sha256").update(JSON.stringify(value)).digest("hex");
		// The process crashed after durable pending-marker publication but before
		// it applied the repair. An editor then chose the same proposed value.
		await fs.writeFile(target, YAML.stringify({ gjc: { ralplan: { maxIterations: 9 } } }, null, 2));
		await fs.writeFile(`${source}.bak`, originalRaw);
		await fs.writeFile(
			`${source}.migrated`,
			JSON.stringify({
				version: 1,
				status: "pending",
				sourcePath: source,
				backupPath: `${source}.bak`,
				targetPath: target,
				canonicalTargetDir: await fs.realpath(agentDir),
				canonicalTargetIdentity: `${(await fs.stat(agentDir)).dev}:${(await fs.stat(agentDir)).ino}`,
				sourceSha256: nodeCrypto.createHash("sha256").update(proposedRaw).digest("hex"),
				priorSourceSha256: nodeCrypto.createHash("sha256").update(originalRaw).digest("hex"),
				migratedKeys: ["gjc.ralplan.maxIterations"],
				repairValueHashes: { "gjc.ralplan.maxIterations": hash(9) },
				preRepairTargetHashes: { "gjc.ralplan.maxIterations": hash(7) },
				repairsApplied: false,
				startedAt: new Date().toISOString(),
			}),
		);

		const result = await runProbe(cwd, { home, configDir: ".myconfig" });
		expect(result.targetValue).toBe(9); // matching value is the user's override
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// Project workflow-settings migration (`.gjc/settings.json` -> `.gjc/config.yml`)
// ─────────────────────────────────────────────────────────────────────────────

const PROJECT_PROBE = path.join(import.meta.dir, "../fixtures/project-workflow-migration-probe.ts");

type ProjectProbeResult = {
	loadFailed?: boolean;
	sourceExists: boolean;
	maxIterations: unknown;
	maxReviewPassesPerLane: unknown;
	gjcValueType?: string | null;
	configYmlRootType?: string | null;
	strictInvalidEvidenceExists?: boolean;
	strictInvalidEvidenceKeys?: string[];
	strictInvalidEvidenceMalformed?: boolean;
	/** Child-process stderr, so tests can assert migration warnings surface. */
	stderr?: string;
	/** Opt-in isolated log content (GJC_PROBE_LOG); empty when not requested. */
	migrationLog?: string;
	/** Generic settings API value for gjc.ralplan.maxIterations after load. */
	settingsGetMaxIterations?: unknown;
};

async function runProjectProbe(
	cwd: string,
	options: { viaTrigger?: boolean; home?: string; expectLoadFailure?: boolean; env?: Record<string, string> } = {},
): Promise<ProjectProbeResult> {
	const args = [
		process.execPath,
		PROJECT_PROBE,
		...(options.viaTrigger ? ["--via-trigger"] : []),
		...(options.expectLoadFailure ? ["--expect-load-failure"] : []),
	];
	const proc = Bun.spawn(args, {
		cwd,
		env: {
			...process.env,
			// A runner's real agent config must never leak into these probes.
			GJC_CODING_AGENT_DIR: undefined,
			PI_CODING_AGENT_DIR: undefined,
			GJC_CONFIG_DIR: undefined,
			PI_CONFIG_DIR: undefined,
			// Isolate the config root (and the migration log) in a temp home when
			// the test asserts warning text.
			HOME: options.home ?? process.env.HOME,
			...(options.home ? { GJC_PROBE_LOG: "1" } : {}),
			...(options.env ?? {}),
		},
		stdout: "pipe",
		stderr: "pipe",
	});
	const [out, err] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
	if ((await proc.exited) !== 0) throw new Error(`project probe failed (exit ${await proc.exited}): ${err}`);
	return { ...(JSON.parse(out.trim()) as ProjectProbeResult), stderr: err };
}

describe("project workflow settings migration", () => {
	test("copies project .gjc/settings.json workflow keys into project config.yml and preserves the source", async () => {
		const cwd = await tempDir();
		await fs.mkdir(path.join(cwd, ".gjc"), { recursive: true });
		await fs.writeFile(
			path.join(cwd, ".gjc", "settings.json"),
			JSON.stringify({ "gjc.ralplan.maxIterations": 7, "gjc.ralplan.maxReviewPassesPerLane": 2 }),
		);

		const result = await runProjectProbe(cwd);
		expect(result.sourceExists).toBe(true); // non-workflow settings still live there
		expect(result.maxIterations).toBe(7);
		expect(result.maxReviewPassesPerLane).toBe(2);
	});

	test("does not overwrite an existing nested config.yml value (absent-only)", async () => {
		const cwd = await tempDir();
		await fs.mkdir(path.join(cwd, ".gjc"), { recursive: true });
		const target = path.join(cwd, ".gjc", "config.yml");
		await fs.writeFile(target, YAML.stringify({ gjc: { ralplan: { maxIterations: 9 } } }, null, 2));
		await fs.writeFile(path.join(cwd, ".gjc", "settings.json"), JSON.stringify({ "gjc.ralplan.maxIterations": 7 }));

		const result = await runProjectProbe(cwd);
		expect(result.maxIterations).toBe(9); // modern nested target wins
	});

	test("does not write a config.yml when the source has no workflow keys", async () => {
		const cwd = await tempDir();
		await fs.mkdir(path.join(cwd, ".gjc"), { recursive: true });
		await fs.writeFile(path.join(cwd, ".gjc", "settings.json"), JSON.stringify({ theme: { dark: "red-claw" } }));

		const result = await runProjectProbe(cwd);
		expect(result.sourceExists).toBe(true);
		expect(result.maxIterations).toBeNull();
		expect(result.maxReviewPassesPerLane).toBeNull();
	});

	test("leaves a malformed source untouched", async () => {
		const cwd = await tempDir();
		await fs.mkdir(path.join(cwd, ".gjc"), { recursive: true });
		await fs.writeFile(path.join(cwd, ".gjc", "settings.json"), "{ not json");

		const result = await runProjectProbe(cwd);
		expect(result.sourceExists).toBe(true);
		expect(result.maxIterations).toBeNull();
	});

	test("skips a future-schema config.yml instead of patching it", async () => {
		const cwd = await tempDir();
		await fs.mkdir(path.join(cwd, ".gjc"), { recursive: true });
		await fs.writeFile(
			path.join(cwd, ".gjc", "config.yml"),
			YAML.stringify({ configSchemaVersion: 9999, gjc: { ralplan: { maxIterations: 9 } } }, null, 2),
		);
		await fs.writeFile(path.join(cwd, ".gjc", "settings.json"), JSON.stringify({ "gjc.ralplan.maxIterations": 7 }));

		const result = await runProjectProbe(cwd);
		expect(result.maxIterations).toBe(9); // future-schema target is read-only
	});

	test("aborts on a malformed project config.yml parent instead of replacing it", async () => {
		const cwd = await tempDir();
		await fs.mkdir(path.join(cwd, ".gjc"), { recursive: true });
		await fs.writeFile(path.join(cwd, ".gjc", "config.yml"), 'gjc: "repair-me"\n');
		await fs.writeFile(path.join(cwd, ".gjc", "settings.json"), JSON.stringify({ "gjc.ralplan.maxIterations": 7 }));

		const result = await runProjectProbe(cwd);
		// The malformed scalar parent is user data; the migration must leave it
		// untouched instead of replacing it with an object.
		expect(result.gjcValueType).toBe("string");
		expect(result.maxIterations).toBeNull();
		expect(result.sourceExists).toBe(true);
	});

	test("records project strict-invalid evidence for an invalid strict ralplan legacy value", async () => {
		const cwd = await tempDir();
		await fs.mkdir(path.join(cwd, ".gjc"), { recursive: true });
		await fs.writeFile(
			path.join(cwd, ".gjc", "settings.json"),
			JSON.stringify({ "gjc.ralplan.maxIterations": "bad" }),
		);

		const result = await runProjectProbe(cwd);
		expect(result.strictInvalidEvidenceExists).toBe(true);
		expect(result.strictInvalidEvidenceKeys).toEqual(["gjc.ralplan.maxIterations"]);
		expect(result.maxIterations).toBeNull(); // never copied into config.yml
		expect(result.sourceExists).toBe(true);
	});

	test("a valid project config.yml override suppresses project strict-invalid evidence", async () => {
		const cwd = await tempDir();
		await fs.mkdir(path.join(cwd, ".gjc"), { recursive: true });
		await fs.writeFile(
			path.join(cwd, ".gjc", "config.yml"),
			YAML.stringify({ gjc: { ralplan: { maxIterations: 7 } } }, null, 2),
		);
		await fs.writeFile(
			path.join(cwd, ".gjc", "settings.json"),
			JSON.stringify({ "gjc.ralplan.maxIterations": "bad" }),
		);

		const result = await runProjectProbe(cwd);
		expect(result.strictInvalidEvidenceExists).toBe(false); // valid override wins
		expect(result.maxIterations).toBe(7);
	});

	test("repairing the invalid project source clears the project evidence", async () => {
		const cwd = await tempDir();
		await fs.mkdir(path.join(cwd, ".gjc"), { recursive: true });
		await fs.writeFile(
			path.join(cwd, ".gjc", "settings.json"),
			JSON.stringify({ "gjc.ralplan.maxIterations": "bad" }),
		);

		const first = await runProjectProbe(cwd);
		expect(first.strictInvalidEvidenceExists).toBe(true);

		await fs.writeFile(path.join(cwd, ".gjc", "settings.json"), JSON.stringify({ "gjc.ralplan.maxIterations": 7 }));
		const second = await runProjectProbe(cwd);
		expect(second.strictInvalidEvidenceExists).toBe(false);
		expect(second.maxIterations).toBe(7); // now migrated into config.yml
	});

	test("records malformed-source evidence for a malformed project settings.json", async () => {
		const cwd = await tempDir();
		await fs.mkdir(path.join(cwd, ".gjc"), { recursive: true });
		await fs.writeFile(path.join(cwd, ".gjc", "settings.json"), "{ not json");

		const result = await runProjectProbe(cwd);
		expect(result.strictInvalidEvidenceExists).toBe(true);
		expect(result.strictInvalidEvidenceMalformed).toBe(true);
		expect(result.sourceExists).toBe(true);

		// Repairing the source clears the malformed evidence and migrates normally.
		await fs.writeFile(path.join(cwd, ".gjc", "settings.json"), JSON.stringify({ "gjc.ralplan.maxIterations": 7 }));
		const repaired = await runProjectProbe(cwd);
		expect(repaired.strictInvalidEvidenceExists).toBe(false);
		expect(repaired.maxIterations).toBe(7);
	});

	test("records malformed evidence for a malformed project workflow parent", async () => {
		const cwd = await tempDir();
		await fs.mkdir(path.join(cwd, ".gjc"), { recursive: true });
		await fs.writeFile(path.join(cwd, ".gjc", "settings.json"), '{"gjc":{"ralplan":"broken"}}');

		const result = await runProjectProbe(cwd);
		expect(result.strictInvalidEvidenceExists).toBe(true);
		expect(result.strictInvalidEvidenceMalformed).toBe(true);
		expect(result.sourceExists).toBe(true);
		expect(result.maxIterations).toBeNull();

		// Repairing the parent clears the evidence and migrates normally.
		await fs.writeFile(path.join(cwd, ".gjc", "settings.json"), JSON.stringify({ "gjc.ralplan.maxIterations": 7 }));
		const repaired = await runProjectProbe(cwd);
		expect(repaired.strictInvalidEvidenceExists).toBe(false);
		expect(repaired.maxIterations).toBe(7);
	});

	test("a tolerant malformed project parent does not poison strict keys", async () => {
		const cwd = await tempDir();
		await fs.mkdir(path.join(cwd, ".gjc"), { recursive: true });
		await fs.writeFile(
			path.join(cwd, ".gjc", "settings.json"),
			'{"gjc":{"deepInterview":"broken","ralplan":{"maxIterations":7}}}',
		);

		const result = await runProjectProbe(cwd);
		// The malformed TOLERANT parent (deepInterview) is skipped like any other
		// invalid tolerant value - it must never produce a global strict marker.
		expect(result.strictInvalidEvidenceExists).toBe(false);
		expect(result.maxIterations).toBe(7); // the valid ralplan key still migrates
	});

	test("owned keys suppress malformed evidence publication for a corrupted source", async () => {
		const cwd = await tempDir();
		await fs.mkdir(path.join(cwd, ".gjc"), { recursive: true });
		// Every strict ralplan key is already owned by config.yml (the
		// migrated-keys marker records them all); the retained source is later
		// corrupted. A stale global malformed marker must NOT be published: a
		// deliberate `gjc config unset` of an owned key must keep falling through
		// to the lower layer/default instead of exiting 2.
		await fs.mkdir(path.join(cwd, ".gjc", "state"), { recursive: true });
		await fs.writeFile(
			path.join(cwd, ".gjc", "state", "settings.json.migrated-keys"),
			JSON.stringify(["gjc.ralplan.maxIterations", "gjc.ralplan.autoHandoff", "gjc.ralplan.maxReviewPassesPerLane"]),
		);
		await fs.writeFile(path.join(cwd, ".gjc", "settings.json"), "{ corrupted");

		const result = await runProjectProbe(cwd);
		expect(result.strictInvalidEvidenceExists).toBe(false);
	});

	test("keeps evidence for every unresolved strict key (multi-key project source)", async () => {
		const cwd = await tempDir();
		await fs.mkdir(path.join(cwd, ".gjc"), { recursive: true });
		// Two invalid strict keys; config.yml carries a VALID override for the
		// later one only. The evidence must keep the unresolved autoHandoff and
		// must not be deleted by the maxIterations override's cleanup.
		await fs.writeFile(
			path.join(cwd, ".gjc", "config.yml"),
			YAML.stringify({ gjc: { ralplan: { maxIterations: 7 } } }, null, 2),
		);
		await fs.writeFile(
			path.join(cwd, ".gjc", "settings.json"),
			JSON.stringify({ "gjc.ralplan.autoHandoff": "bad", "gjc.ralplan.maxIterations": "bad" }),
		);

		const result = await runProjectProbe(cwd);
		expect(result.strictInvalidEvidenceExists).toBe(true);
		expect(result.strictInvalidEvidenceKeys).toEqual(["gjc.ralplan.autoHandoff"]);
		expect(result.maxIterations).toBe(7); // valid override wins and is migrated
	});

	test("removing a migrated key from config.yml does not re-import the stale legacy value", async () => {
		const cwd = await tempDir();
		await fs.mkdir(path.join(cwd, ".gjc"), { recursive: true });
		await fs.writeFile(path.join(cwd, ".gjc", "settings.json"), JSON.stringify({ "gjc.ralplan.maxIterations": 7 }));

		const first = await runProjectProbe(cwd);
		expect(first.maxIterations).toBe(7); // migrated once into config.yml

		// Simulate `gjc config unset gjc.ralplan.maxIterations`: the target key
		// is removed while the legacy source is retained.
		await fs.writeFile(
			path.join(cwd, ".gjc", "config.yml"),
			YAML.stringify({ theme: { dark: "red-claw" } }, null, 2),
		);

		const second = await runProjectProbe(cwd);
		// The per-key completion marker must keep the removal sticky: the stale
		// legacy value is NOT copied back, restoring user/default precedence.
		expect(second.maxIterations).toBeNull();
	});

	test("records pre-existing config-owned keys so a later unset sticks (mixed migration)", async () => {
		const cwd = await tempDir();
		await fs.mkdir(path.join(cwd, ".gjc"), { recursive: true });
		// config.yml already holds a valid maxIterations (pre-existing); only
		// autoHandoff is missing. Both keys are in the legacy source.
		await fs.writeFile(
			path.join(cwd, ".gjc", "config.yml"),
			YAML.stringify({ gjc: { ralplan: { maxIterations: 9 } } }, null, 2),
		);
		await fs.writeFile(
			path.join(cwd, ".gjc", "settings.json"),
			JSON.stringify({ "gjc.ralplan.maxIterations": 7, "gjc.ralplan.autoHandoff": "off" }),
		);

		const first = await runProjectProbe(cwd);
		expect(first.maxIterations).toBe(9); // the pre-existing valid value wins

		// Remove the PRE-EXISTING key (simulate `gjc config unset
		// gjc.ralplan.maxIterations`): it was never copied by this run.
		await fs.writeFile(
			path.join(cwd, ".gjc", "config.yml"),
			YAML.stringify({ theme: { dark: "red-claw" } }, null, 2),
		);

		const second = await runProjectProbe(cwd);
		// The mixed migration recorded EVERY config-owned source key (copied and
		// pre-existing), so the removal sticks instead of re-importing 7.
		expect(second.maxIterations).toBeNull();
	});

	test("a marker-failure rollback preserves independently valid strict evidence", async () => {
		const cwd = await tempDir();
		await fs.mkdir(path.join(cwd, ".gjc"), { recursive: true });
		// The migrated-key marker path is occupied by a directory, so only the
		// marker write fails (the evidence file is unaffected).
		await fs.mkdir(path.join(cwd, ".gjc", "state", "settings.json.migrated-keys"), { recursive: true });
		// An invalid strict key (evidence) plus a valid key (would be copied).
		await fs.writeFile(
			path.join(cwd, ".gjc", "settings.json"),
			JSON.stringify({ "gjc.ralplan.autoHandoff": "bad", "gjc.ralplan.maxIterations": 7 }),
		);

		const result = await runProjectProbe(cwd, { expectLoadFailure: true });
		// The unreadable marker ABORTS the migration: nothing is published, no
		// evidence is written, and the retained source stays active.
		expect(result.loadFailed).toBe(true);
		expect(result.strictInvalidEvidenceExists).toBe(false);
		expect(result.maxIterations).toBeNull();
	});

	test("an unreadable ownership marker leaves an absent config.yml absent so the fallback stays active", async () => {
		const cwd = await tempDir();
		await fs.mkdir(path.join(cwd, ".gjc"), { recursive: true });
		// The migrated-key marker path is occupied by a directory, so only the
		// marker write fails. config.yml does NOT exist yet: the rollback would
		// otherwise leave an empty authoritative config.yml behind and silently
		// disable the retained settings.json fallback while the marker stays
		// unwritable.
		await fs.mkdir(path.join(cwd, ".gjc", "state", "settings.json.migrated-keys"), { recursive: true });
		await fs.writeFile(
			path.join(cwd, ".gjc", "settings.json"),
			JSON.stringify({ "gjc.ralplan.maxIterations": 7, "gjc.ralplan.maxReviewPassesPerLane": 2 }),
		);

		const result = await runProjectProbe(cwd, { home: await tempDir(), expectLoadFailure: true });
		// The unreadable marker ABORTS the migration before any publication:
		// the retained source stays active and no config.yml is created, so the
		// fallback resolution keeps working on every retry.
		expect(result.loadFailed).toBe(true);
		expect(result.sourceExists).toBe(true); // the retained source stays active
		expect(result.configYmlRootType).toBeNull(); // nothing was created
		expect(result.maxIterations).toBeNull(); // nothing published into config.yml
	});

	test("clears fallback-invalid values from config.yml when the source no longer holds them", async () => {
		const cwd = await tempDir();
		await fs.mkdir(path.join(cwd, ".gjc"), { recursive: true });
		// The strict-evidence path is occupied by a directory, so the evidence
		// write fails and the invalid value falls back into config.yml.
		await fs.mkdir(path.join(cwd, ".gjc", "state", "settings.json.strict-invalid"), { recursive: true });
		await fs.writeFile(
			path.join(cwd, ".gjc", "settings.json"),
			JSON.stringify({ "gjc.ralplan.maxIterations": "bad" }),
		);

		const first = await runProjectProbe(cwd);
		// The fallback persisted the invalid value into config.yml (the resolver
		// surface) so exit 2 stays observable.
		expect(first.maxIterations).toBe("bad");

		// Repair the legacy source by removing the invalid key.
		await fs.writeFile(path.join(cwd, ".gjc", "settings.json"), "{}");

		const second = await runProjectProbe(cwd);
		// The tracked fallback value is removed from config.yml; exit 2 does not
		// persist after the repair.
		expect(second.maxIterations).toBeNull();
	});

	test("fallback cleanup preserves a user's newer config.yml override", async () => {
		const cwd = await tempDir();
		await fs.mkdir(path.join(cwd, ".gjc"), { recursive: true });
		await fs.mkdir(path.join(cwd, ".gjc", "state", "settings.json.strict-invalid"), { recursive: true });
		await fs.writeFile(
			path.join(cwd, ".gjc", "settings.json"),
			JSON.stringify({ "gjc.ralplan.maxIterations": "bad" }),
		);

		const first = await runProjectProbe(cwd);
		expect(first.maxIterations).toBe("bad"); // fallback written

		// Repair the source AND replace the fallback value with a valid override.
		await fs.writeFile(path.join(cwd, ".gjc", "settings.json"), "{}");
		await fs.writeFile(
			path.join(cwd, ".gjc", "config.yml"),
			YAML.stringify({ gjc: { ralplan: { maxIterations: 9 } } }, null, 2),
		);

		const second = await runProjectProbe(cwd);
		// The user's newer override survives the cleanup (it does not match the
		// recorded fallback value "bad").
		expect(second.maxIterations).toBe(9);
	});

	test("persists malformed-source strict fallback into config.yml when the evidence cannot be written", async () => {
		const cwd = await tempDir();
		await fs.mkdir(path.join(cwd, ".gjc"), { recursive: true });
		// The strict-evidence path is occupied by a directory, so the evidence
		// write fails; the malformed source must still keep the ralplan exit-2
		// error observable through guaranteed-invalid placeholder values in
		// config.yml (the only surface the strict resolver reads).
		await fs.mkdir(path.join(cwd, ".gjc", "state", "settings.json.strict-invalid"), { recursive: true });
		await fs.writeFile(path.join(cwd, ".gjc", "settings.json"), "{ not json");

		const first = await runProjectProbe(cwd);
		expect(first.maxIterations).toBe(-1);
		expect(first.maxReviewPassesPerLane).toBe(-1);
		const fallbackMarker = path.join(cwd, ".gjc", "settings.json.fallback-invalid");
		expect(await fs.lstat(fallbackMarker).catch(() => null)).not.toBeNull();

		// Repairing the source clears the tracked placeholders and migrates normally.
		await fs.writeFile(path.join(cwd, ".gjc", "settings.json"), JSON.stringify({ "gjc.ralplan.maxIterations": 7 }));
		const repaired = await runProjectProbe(cwd);
		expect(repaired.maxIterations).toBe(7);
		expect(repaired.maxReviewPassesPerLane).toBeNull();
	});

	test("a malformed-source fallback skips keys with a valid config.yml override", async () => {
		const cwd = await tempDir();
		await fs.mkdir(path.join(cwd, ".gjc"), { recursive: true });
		await fs.mkdir(path.join(cwd, ".gjc", "state", "settings.json.strict-invalid"), { recursive: true });
		// A valid explicit config.yml value must win over the malformed source:
		// no placeholder overwrites it, and the unresolved strict keys still get
		// their invalid placeholders so exit 2 stays observable for them.
		await fs.writeFile(
			path.join(cwd, ".gjc", "config.yml"),
			YAML.stringify({ gjc: { ralplan: { maxIterations: 9 } } }, null, 2),
		);
		await fs.writeFile(path.join(cwd, ".gjc", "settings.json"), "{ not json");

		const result = await runProjectProbe(cwd);
		expect(result.maxIterations).toBe(9); // valid override preserved
		expect(result.maxReviewPassesPerLane).toBe(-1); // unresolved strict key
	});

	test("a malformed-source fallback never overwrites a user's present invalid config.yml value", async () => {
		const cwd = await tempDir();
		await fs.mkdir(path.join(cwd, ".gjc"), { recursive: true });
		await fs.mkdir(path.join(cwd, ".gjc", "state", "settings.json.strict-invalid"), { recursive: true });
		// The user's pre-existing INVALID value already keeps the exit-2 error
		// observable on its own, so the fallback must not replace it with a
		// placeholder (a later unset/cleanup would then delete user data).
		await fs.writeFile(
			path.join(cwd, ".gjc", "config.yml"),
			YAML.stringify({ gjc: { ralplan: { maxIterations: "user-mistake" } } }, null, 2),
		);
		await fs.writeFile(path.join(cwd, ".gjc", "settings.json"), "{ not json");

		const first = await runProjectProbe(cwd);
		expect(first.maxIterations).toBe("user-mistake"); // pre-existing value preserved
		expect(first.maxReviewPassesPerLane).toBe(-1); // unresolved absent key still gets a placeholder

		// Repairing the source migrates the valid value over the user's invalid one.
		await fs.writeFile(path.join(cwd, ".gjc", "settings.json"), JSON.stringify({ "gjc.ralplan.maxIterations": 7 }));
		const repaired = await runProjectProbe(cwd);
		expect(repaired.maxIterations).toBe(7);
		expect(repaired.maxReviewPassesPerLane).toBeNull();
	});

	test("an all-present migration surfaces a migrated-keys marker failure instead of silent completion", async () => {
		const cwd = await tempDir();
		await fs.mkdir(path.join(cwd, ".gjc"), { recursive: true });
		// config.yml already holds every valid source key (all-present); the
		// migrated-keys marker path is occupied by a directory so ownership
		// cannot be durably recorded.
		await fs.mkdir(path.join(cwd, ".gjc", "state", "settings.json.migrated-keys"), { recursive: true });
		await fs.writeFile(
			path.join(cwd, ".gjc", "config.yml"),
			YAML.stringify({ gjc: { ralplan: { maxIterations: 9 } } }, null, 2),
		);
		await fs.writeFile(path.join(cwd, ".gjc", "settings.json"), JSON.stringify({ "gjc.ralplan.maxIterations": 7 }));

		const result = await runProjectProbe(cwd, { home: await tempDir(), expectLoadFailure: true });
		// The unreadable marker (EISDIR on the occupied path) ABORTS the
		// migration: the user's pre-existing valid value stays untouched instead
		// of being re-imported over by a markerless publication.
		expect(result.loadFailed).toBe(true);
		expect(result.maxIterations).toBe(9);
	});

	test("a marker re-read failure after publication rolls the committed values back", async () => {
		const cwd = await tempDir();
		const home = await tempDir();
		await fs.mkdir(path.join(cwd, ".gjc", "state"), { recursive: true });
		// The marker is readable for the initial read; the seam replaces it
		// with a DIRECTORY before the post-publication re-read.
		await fs.writeFile(path.join(cwd, ".gjc", "state", "settings.json.migrated-keys"), JSON.stringify([]));
		// The source holds an INVALID strict key, so the seeded evidence is
		// current (not stale); an ownership-marker failure must NOT clear it.
		await fs.writeFile(path.join(cwd, ".gjc", "settings.json"), JSON.stringify({ "gjc.ralplan.autoHandoff": "bad" }));
		await fs.writeFile(
			path.join(cwd, ".gjc", "state", "settings.json.strict-invalid"),
			JSON.stringify({ version: 2, keys: [{ key: "gjc.ralplan.autoHandoff", value: "bad" }] }),
		);

		const result = await runProjectProbe(cwd, {
			home,
			env: { SETTINGS_MIGRATION_TEST_MARKER_MERGE_DIR: "1" },
		});
		// The post-publication marker re-read failed (EISDIR): the committed
		// values were rolled back exactly like a failed marker write, so
		// nothing survives in config.yml without durable ownership.
		expect(result.loadFailed).toBe(false);
		expect(result.maxIterations).toBeNull();
		expect(result.configYmlRootType).toBeNull();
		// The strict-invalid evidence is PRESERVED (cleared only when the
		// SOURCE changed, not for ownership-marker failures).
		expect(result.strictInvalidEvidenceExists).toBe(true);
		expect(result.strictInvalidEvidenceKeys).toEqual(["gjc.ralplan.autoHandoff"]);
	});

	test("a pending retirement marker is completed by the next load after an interrupted migration", async () => {
		const home = await tempDir();
		const cwd = await tempDir();
		const { agentDir } = await setupHome(home, ".myconfig");
		await fs.mkdir(agentDir, { recursive: true });
		// The crash case: the values were published (config.yml exists) and the
		// pending-retirement marker was persisted, but the rename never
		// completed before the process exited.
		await fs.writeFile(
			path.join(agentDir, "config.yml"),
			YAML.stringify({ gjc: { ralplan: { maxIterations: 7 } } }, null, 2),
		);
		const sourceRaw = JSON.stringify({ "gjc.ralplan.maxIterations": 7 });
		await fs.writeFile(path.join(agentDir, "settings.json"), sourceRaw);
		await fs.writeFile(
			path.join(agentDir, "settings.json.pending-retirement"),
			nodeCrypto.createHash("sha256").update(sourceRaw).digest("hex"),
		);

		const result = await runProbe(cwd, { home, configDir: ".myconfig" });
		// The retirement completed: the agent-dir source was renamed to .bak
		// and the pending marker was consumed.
		expect(result.loadFailed).toBe(false);
		expect(await fs.stat(path.join(agentDir, "settings.json")).catch(() => null)).toBeNull();
		expect(await fs.stat(path.join(agentDir, "settings.json.bak")).catch(() => null)).not.toBeNull();
		expect(await fs.stat(path.join(agentDir, "settings.json.pending-retirement")).catch(() => null)).toBeNull();
	});

	test("a changed settings.json is never retired by a stale pending marker", async () => {
		const home = await tempDir();
		const cwd = await tempDir();
		const { agentDir } = await setupHome(home, ".myconfig");
		await fs.mkdir(agentDir, { recursive: true });
		await fs.writeFile(
			path.join(agentDir, "config.yml"),
			YAML.stringify({ gjc: { ralplan: { maxIterations: 7 } } }, null, 2),
		);
		// The pending marker records an OLDER revision (sha of different
		// bytes); the current source holds the user's newer edit and must stay
		// active.
		await fs.writeFile(path.join(agentDir, "settings.json"), JSON.stringify({ "gjc.ralplan.maxIterations": 9 }));
		await fs.writeFile(
			path.join(agentDir, "settings.json.pending-retirement"),
			nodeCrypto
				.createHash("sha256")
				.update(JSON.stringify({ "gjc.ralplan.maxIterations": 7 }))
				.digest("hex"),
		);

		const result = await runProbe(cwd, { home, configDir: ".myconfig" });
		// The retirement is SKIPPED: the user's newer settings are not stranded
		// in the inactive .bak.
		expect(result.loadFailed).toBe(false);
		expect(await fs.stat(path.join(agentDir, "settings.json")).catch(() => null)).not.toBeNull();
		expect(await fs.stat(path.join(agentDir, "settings.json.bak")).catch(() => null)).toBeNull();
	});

	test("a marker without publication proof never retires the source", async () => {
		const home = await tempDir();
		const cwd = await tempDir();
		const { agentDir } = await setupHome(home, ".myconfig");
		await fs.mkdir(agentDir, { recursive: true });
		const sourceRaw = JSON.stringify({ "gjc.ralplan.maxIterations": 7 });
		// The target exists but does NOT contain the source's workflow key (the
		// publication was skipped or conflicted after the marker was persisted):
		// the marker alone is not proof, so the source must not be retired.
		await fs.writeFile(path.join(agentDir, "config.yml"), YAML.stringify({ theme: { dark: "red" } }, null, 2));
		await fs.writeFile(path.join(agentDir, "settings.json"), sourceRaw);
		await fs.writeFile(
			path.join(agentDir, "settings.json.pending-retirement"),
			nodeCrypto.createHash("sha256").update(sourceRaw).digest("hex"),
		);

		const result = await runProbe(cwd, { home, configDir: ".myconfig" });
		expect(result.loadFailed).toBe(false);
		expect(await fs.stat(path.join(agentDir, "settings.json")).catch(() => null)).not.toBeNull();
		expect(await fs.stat(path.join(agentDir, "settings.json.bak")).catch(() => null)).toBeNull();
	});

	test("a failed retirement rename preserves the retry marker", async () => {
		const home = await tempDir();
		const cwd = await tempDir();
		const { agentDir } = await setupHome(home, ".myconfig");
		await fs.mkdir(agentDir, { recursive: true });
		const sourceRaw = JSON.stringify({ "gjc.ralplan.maxIterations": 7 });
		await fs.writeFile(
			path.join(agentDir, "config.yml"),
			YAML.stringify({ gjc: { ralplan: { maxIterations: 7 } } }, null, 2),
		);
		await fs.writeFile(path.join(agentDir, "settings.json"), sourceRaw);
		// The .bak destination is occupied by a DIRECTORY: the rename fails.
		await fs.mkdir(path.join(agentDir, "settings.json.bak"), { recursive: true });
		await fs.writeFile(
			path.join(agentDir, "settings.json.pending-retirement"),
			nodeCrypto.createHash("sha256").update(sourceRaw).digest("hex"),
		);

		const result = await runProbe(cwd, { home, configDir: ".myconfig" });
		expect(result.loadFailed).toBe(false);
		// The source stays and the marker is preserved for the next load's retry.
		expect(await fs.stat(path.join(agentDir, "settings.json")).catch(() => null)).not.toBeNull();
		expect(await fs.stat(path.join(agentDir, "settings.json.pending-retirement")).catch(() => null)).not.toBeNull();
	});

	test("a user-created settings.json beside an existing config.yml is not retired", async () => {
		const home = await tempDir();
		const cwd = await tempDir();
		const { agentDir } = await setupHome(home, ".myconfig");
		await fs.mkdir(agentDir, { recursive: true });
		await fs.writeFile(
			path.join(agentDir, "config.yml"),
			YAML.stringify({ gjc: { ralplan: { maxIterations: 7 } } }, null, 2),
		);
		await fs.writeFile(path.join(agentDir, "settings.json"), JSON.stringify({ "gjc.ralplan.maxIterations": 7 }));

		const result = await runProbe(cwd, { home, configDir: ".myconfig" });
		// No pending marker: the file is the user's own and stays untouched.
		expect(result.loadFailed).toBe(false);
		expect(await fs.stat(path.join(agentDir, "settings.json")).catch(() => null)).not.toBeNull();
		expect(await fs.stat(path.join(agentDir, "settings.json.bak")).catch(() => null)).toBeNull();
	});

	test("excludes retired workflow keys from project settings discovery after a config.yml removal", async () => {
		const cwd = await tempDir();
		const home = await tempDir();
		await fs.mkdir(path.join(cwd, ".gjc"), { recursive: true });
		// Nested form, so the stale value is reachable through the generic
		// settings.get() nested lookup once merged from the retained settings.json.
		await fs.writeFile(
			path.join(cwd, ".gjc", "settings.json"),
			JSON.stringify({ gjc: { ralplan: { maxIterations: 7 } } }),
		);

		const first = await runProjectProbe(cwd, { home });
		expect(first.maxIterations).toBe(7); // migrated into config.yml
		// The project migration runs BEFORE project discovery on the same load, so
		// the generic settings API sees the migrated value immediately (not after
		// one default-returning cycle).
		expect(first.settingsGetMaxIterations).toBe(7);

		// Simulate `gjc config unset gjc.ralplan.maxIterations`.
		await fs.writeFile(
			path.join(cwd, ".gjc", "config.yml"),
			YAML.stringify({ theme: { dark: "red-claw" } }, null, 2),
		);

		const second = await runProjectProbe(cwd, { home });
		// The retained .gjc/settings.json workflow key must not leak through the
		// generic settings API after the removal (the resolver no longer reads it):
		// with the strip settings.get returns the schema default 5, without it the
		// stale 7.
		expect(second.maxIterations).toBeNull();
		expect(second.settingsGetMaxIterations).toBe(5);
	});

	test("persists malformed-source strict fallback into the agent config.yml when config-root evidence cannot be written", async () => {
		const home = await tempDir();
		const cwd = await tempDir();
		const { source, agentDir } = await setupHome(home, ".myconfig");
		// Occupying the evidence path with a directory makes the evidence write fail.
		await fs.mkdir(`${source}.strict-invalid`, { recursive: true });
		await fs.writeFile(source, "{ not json");

		await runProbe(cwd, { home, configDir: ".myconfig" });
		// The evidence sidecar could not be written; invalid placeholders land in
		// the agent config.yml so the strict resolver keeps exit-2 observable.
		const parsed = YAML.parse(await fs.readFile(path.join(agentDir, "config.yml"), "utf8")) as {
			gjc?: { ralplan?: Record<string, unknown> };
		};
		expect(parsed.gjc?.ralplan?.maxIterations).toBe(-1);
		expect(parsed.gjc?.ralplan?.maxReviewPassesPerLane).toBe(-1);
	});

	test("a config-root invalid-value fallback never overwrites a user's present invalid agent config.yml value", async () => {
		const home = await tempDir();
		const cwd = await tempDir();
		const { source, agentDir } = await setupHome(home, ".myconfig");
		await fs.mkdir(`${source}.strict-invalid`, { recursive: true });
		await fs.mkdir(agentDir, { recursive: true });
		// The user's present-but-invalid value already keeps exit-2 observable on
		// its own; the fallback must not overwrite it.
		await fs.writeFile(
			path.join(agentDir, "config.yml"),
			YAML.stringify({ gjc: { ralplan: { maxIterations: "user-mistake" } } }, null, 2),
		);
		await fs.writeFile(source, JSON.stringify({ "gjc.ralplan.maxIterations": "bad" }));

		await runProbe(cwd, { home, configDir: ".myconfig" });
		const parsed = YAML.parse(await fs.readFile(path.join(agentDir, "config.yml"), "utf8")) as {
			gjc?: { ralplan?: Record<string, unknown> };
		};
		expect(parsed.gjc?.ralplan?.maxIterations).toBe("user-mistake");
	});

	test("a project invalid-value fallback never overwrites a user's present invalid config.yml value", async () => {
		const cwd = await tempDir();
		await fs.mkdir(path.join(cwd, ".gjc"), { recursive: true });
		// The strict-evidence path is occupied by a directory, so the evidence
		// write fails and the invalid value would fall back into config.yml.
		await fs.mkdir(path.join(cwd, ".gjc", "state", "settings.json.strict-invalid"), { recursive: true });
		await fs.writeFile(
			path.join(cwd, ".gjc", "config.yml"),
			YAML.stringify({ gjc: { ralplan: { maxIterations: "user-mistake" } } }, null, 2),
		);
		await fs.writeFile(
			path.join(cwd, ".gjc", "settings.json"),
			JSON.stringify({ "gjc.ralplan.maxIterations": "bad" }),
		);

		const result = await runProjectProbe(cwd);
		// The present-but-invalid user value already preserves exit-2; the fallback
		// must not overwrite it (a later cleanup or marker-failure rollback would
		// otherwise delete the user's configuration).
		expect(result.maxIterations).toBe("user-mistake");
	});

	test("merges existing fallback-invalid marker entries across loads", async () => {
		const cwd = await tempDir();
		await fs.mkdir(path.join(cwd, ".gjc"), { recursive: true });
		// The strict-evidence path is occupied by a directory, so the fallback
		// path stays active across every load.
		await fs.mkdir(path.join(cwd, ".gjc", "state", "settings.json.strict-invalid"), { recursive: true });
		await fs.writeFile(
			path.join(cwd, ".gjc", "settings.json"),
			JSON.stringify({ "gjc.ralplan.maxIterations": "badA" }),
		);

		const first = await runProjectProbe(cwd);
		expect(first.maxIterations).toBe("badA"); // fallback written

		// A later source adds a second invalid key while the first stays invalid.
		await fs.writeFile(
			path.join(cwd, ".gjc", "settings.json"),
			JSON.stringify({ "gjc.ralplan.maxIterations": "badA", "gjc.ralplan.autoHandoff": "badB" }),
		);
		const second = await runProjectProbe(cwd);
		expect(second.maxIterations).toBe("badA"); // pre-existing fallback value untouched
		// maxIterations is now present in config.yml (fallback), so only
		// autoHandoff is newly written; the marker must MERGE, keeping
		// maxIterations tracked instead of replacing the marker with just B.
		const markerPath = path.join(cwd, ".gjc", "settings.json.fallback-invalid");
		const markerEntries = JSON.parse(await fs.readFile(markerPath, "utf8")) as { key: string }[];
		expect(markerEntries.map(entry => entry.key).sort()).toEqual([
			"gjc.ralplan.autoHandoff",
			"gjc.ralplan.maxIterations",
		]);

		// Repair the source: BOTH tracked fallback values must be removed from
		// config.yml (without the merge, the untracked maxIterations fallback
		// would persist forever).
		await fs.writeFile(path.join(cwd, ".gjc", "settings.json"), JSON.stringify({ "gjc.ralplan.autoHandoff": "off" }));
		const repaired = await runProjectProbe(cwd);
		expect(repaired.maxIterations).toBeNull();
	});

	test("a partial repair prunes strict evidence to the still-unresolved keys", async () => {
		const cwd = await tempDir();
		await fs.mkdir(path.join(cwd, ".gjc"), { recursive: true });
		// Two unresolved strict keys -> one evidence file recording both.
		await fs.writeFile(
			path.join(cwd, ".gjc", "settings.json"),
			JSON.stringify({ "gjc.ralplan.maxIterations": "bad", "gjc.ralplan.autoHandoff": "bad2" }),
		);

		const first = await runProjectProbe(cwd);
		expect([...(first.strictInvalidEvidenceKeys ?? [])].sort()).toEqual([
			"gjc.ralplan.autoHandoff",
			"gjc.ralplan.maxIterations",
		]);

		// Repair ONLY maxIterations; the target config.yml has a malformed
		// ralplan parent, so the migration aborts BEFORE re-recording the
		// evidence - the start-of-load prune must retain autoHandoff's entry
		// (a whole-file clear would silently lose its exit-2).
		await fs.writeFile(
			path.join(cwd, ".gjc", "settings.json"),
			JSON.stringify({ "gjc.ralplan.maxIterations": 7, "gjc.ralplan.autoHandoff": "bad2" }),
		);
		await fs.writeFile(path.join(cwd, ".gjc", "config.yml"), YAML.stringify({ gjc: { ralplan: [] } }, null, 2));

		const second = await runProjectProbe(cwd);
		expect(second.strictInvalidEvidenceKeys).toEqual(["gjc.ralplan.autoHandoff"]);
	});

	test("a future-schema project config.yml still retains strict errors", async () => {
		const cwd = await tempDir();
		await fs.mkdir(path.join(cwd, ".gjc"), { recursive: true });
		await fs.writeFile(path.join(cwd, ".gjc", "config.yml"), YAML.stringify({ configSchemaVersion: 9999 }, null, 2));
		await fs.writeFile(
			path.join(cwd, ".gjc", "settings.json"),
			JSON.stringify({ "gjc.ralplan.maxIterations": "bad" }),
		);

		const result = await runProjectProbe(cwd);
		expect(result.strictInvalidEvidenceExists).toBe(true);
		expect(result.strictInvalidEvidenceKeys).toEqual(["gjc.ralplan.maxIterations"]);
		expect(result.maxIterations).toBeNull(); // future-schema target untouched
	});

	test("fallback cleanup leaves future-schema targets and markers untouched", async () => {
		const cwd = await tempDir();
		await fs.mkdir(path.join(cwd, ".gjc"), { recursive: true });
		await fs.mkdir(path.join(cwd, ".gjc", "state", "settings.json.strict-invalid"), { recursive: true });
		// Fallback path: source invalid -> config.yml fallback value + marker.
		await fs.writeFile(
			path.join(cwd, ".gjc", "settings.json"),
			JSON.stringify({ "gjc.ralplan.maxIterations": "badA" }),
		);
		const first = await runProjectProbe(cwd);
		expect(first.maxIterations).toBe("badA");

		// The project then upgrades config.yml to a future schema while the source
		// is repaired. The cleanup must NOT unset the recorded key or touch the
		// marker (an older binary treats future-schema config as read-only).
		await fs.writeFile(
			path.join(cwd, ".gjc", "config.yml"),
			YAML.stringify({ configSchemaVersion: 9999, gjc: { ralplan: { maxIterations: "badA" } } }, null, 2),
		);
		await fs.writeFile(path.join(cwd, ".gjc", "settings.json"), "{}");

		const second = await runProjectProbe(cwd);
		expect(second.maxIterations).toBe("badA"); // future-schema target untouched
		const markerPath = path.join(cwd, ".gjc", "settings.json.fallback-invalid");
		const markerEntries = JSON.parse(await fs.readFile(markerPath, "utf8")) as { key: string }[];
		expect(markerEntries.map(entry => entry.key)).toEqual(["gjc.ralplan.maxIterations"]);
	});

	test("a future-schema migration surfaces evidence-write failures", async () => {
		const cwd = await tempDir();
		const home = await tempDir();
		await fs.mkdir(path.join(cwd, ".gjc"), { recursive: true });
		// .gjc/state is a FILE, so the project evidence cannot be written; the
		// read-only future-schema target cannot carry fallback placeholders.
		await fs.writeFile(path.join(cwd, ".gjc", "state"), "occupied");
		await fs.writeFile(path.join(cwd, ".gjc", "config.yml"), YAML.stringify({ configSchemaVersion: 9999 }, null, 2));
		await fs.writeFile(
			path.join(cwd, ".gjc", "settings.json"),
			JSON.stringify({ "gjc.ralplan.maxIterations": "bad" }),
		);

		const result = await runProjectProbe(cwd, { home, expectLoadFailure: true });
		// The unreadable marker (ENOTDIR: .gjc/state is a FILE) ABORTS the
		// migration instead of reimporting the stale value with an empty
		// ownership set; the read-only future-schema target is left untouched.
		expect(result.loadFailed).toBe(true);
	});

	test("an unreadable ownership marker aborts the project migration without touching the user's configuration", async () => {
		const cwd = await tempDir();
		const home = await tempDir();
		await fs.mkdir(path.join(cwd, ".gjc"), { recursive: true });
		// The migrated-key marker path is occupied by a directory, so the marker
		// read fails (EISDIR) and the migration aborts.
		await fs.mkdir(path.join(cwd, ".gjc", "state", "settings.json.migrated-keys"), { recursive: true });
		// config.yml already contains a PRESENT-but-invalid maxIterations value
		// (user data) and the source holds the valid legacy value that repairs it.
		await fs.writeFile(
			path.join(cwd, ".gjc", "config.yml"),
			YAML.stringify({ gjc: { ralplan: { maxIterations: "user-mistake" } } }, null, 2),
		);
		await fs.writeFile(path.join(cwd, ".gjc", "settings.json"), JSON.stringify({ "gjc.ralplan.maxIterations": 7 }));

		const result = await runProjectProbe(cwd, { home, expectLoadFailure: true });
		// The UNREADABLE marker ABORTS the migration (fail closed) instead of
		// proceeding with an empty ownership set that would reimport the stale
		// value: the user's configuration is left untouched for repair.
		expect(result.loadFailed).toBe(true);
		const retained = YAML.parse(await fs.readFile(path.join(cwd, ".gjc", "config.yml"), "utf8")) as {
			gjc?: { ralplan?: { maxIterations?: unknown } };
		};
		expect(retained.gjc?.ralplan?.maxIterations).toBe("user-mistake");
	});

	test("a scalar project config.yml root is not replaced by the migration", async () => {
		const cwd = await tempDir();
		await fs.mkdir(path.join(cwd, ".gjc"), { recursive: true });
		await fs.writeFile(path.join(cwd, ".gjc", "config.yml"), "just a scalar\n");
		await fs.writeFile(path.join(cwd, ".gjc", "settings.json"), JSON.stringify({ "gjc.ralplan.maxIterations": 7 }));

		const result = await runProjectProbe(cwd);
		// The malformed scalar root is user data; the migration aborts instead of
		// replacing the whole document with the migrated mapping.
		expect(result.configYmlRootType).toBe("string");
		expect(result.maxIterations).toBeNull();
	});

	test("an all-present first load still records ownership so a later unset sticks", async () => {
		const cwd = await tempDir();
		await fs.mkdir(path.join(cwd, ".gjc"), { recursive: true });
		await fs.writeFile(
			path.join(cwd, ".gjc", "config.yml"),
			YAML.stringify({ gjc: { ralplan: { maxIterations: 9 } } }, null, 2),
		);
		await fs.writeFile(path.join(cwd, ".gjc", "settings.json"), JSON.stringify({ "gjc.ralplan.maxIterations": 7 }));

		const first = await runProjectProbe(cwd);
		expect(first.maxIterations).toBe(9); // pre-existing valid value wins (all-present)

		// Remove the key (simulate `gjc config unset gjc.ralplan.maxIterations`).
		await fs.writeFile(
			path.join(cwd, ".gjc", "config.yml"),
			YAML.stringify({ theme: { dark: "red-claw" } }, null, 2),
		);

		const second = await runProjectProbe(cwd);
		// The all-present first load recorded ownership (marker published under the
		// lock before returning), so the removal sticks instead of re-importing 7.
		expect(second.maxIterations).toBeNull();
	});

	test("an initially unreadable project source keeps the strict error observable", async () => {
		const cwd = await tempDir();
		await fs.mkdir(path.join(cwd, ".gjc"), { recursive: true });
		await fs.writeFile(
			path.join(cwd, ".gjc", "settings.json"),
			JSON.stringify({ "gjc.ralplan.maxIterations": "bad" }),
		);
		// Mode 000: an EXISTING but unreadable source must still fail loudly.
		await fs.chmod(path.join(cwd, ".gjc", "settings.json"), 0o000);

		const result = await runProjectProbe(cwd);
		expect(result.strictInvalidEvidenceExists).toBe(true);
		expect(result.strictInvalidEvidenceMalformed).toBe(true);
		expect(result.sourceExists).toBe(true);
	});

	test("ensureWorkflowSettingsMigrated triggers the migration from the direct-command path", async () => {
		const cwd = await tempDir();
		await fs.mkdir(path.join(cwd, ".gjc"), { recursive: true });
		await fs.writeFile(path.join(cwd, ".gjc", "settings.json"), JSON.stringify({ "gjc.ralplan.maxIterations": 7 }));

		const result = await runProjectProbe(cwd, { viaTrigger: true });
		expect(result.maxIterations).toBe(7);
		expect(result.sourceExists).toBe(true);
	});
});
