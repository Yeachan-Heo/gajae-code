import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
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
	sourceExists: boolean;
	backupExists: boolean;
	markerExists: boolean;
	markerStatus: string | null;
	targetValue: unknown;
};

async function runProbe(
	cwd: string,
	options: { home: string; configDir?: string; agentDir?: string },
): Promise<ProbeResult> {
	const args = [process.execPath, PROBE];
	if (options.agentDir) args.push("--agent-dir", options.agentDir);
	const proc = Bun.spawn(args, {
		cwd,
		env: { ...process.env, HOME: options.home, GJC_CONFIG_DIR: options.configDir ?? ".gjc" },
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
		expect(first.sourceExists).toBe(true); // source kept active (shadowed by config.yml)
		expect(first.targetValue).toBe(7);

		const second = await runProbe(cwd, { home, configDir: ".myconfig" });
		expect(second.markerStatus).toBe("complete");
		expect(second.sourceExists).toBe(true); // still kept (shadowed) after re-load
		expect(second.backupExists).toBe(true);
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
		const sourceSha256 = createHash("sha256").update(sourceRaw).digest("hex");
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
		const sourceSha256 = createHash("sha256").update(sourceRaw).digest("hex");
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
		const sourceSha256 = createHash("sha256").update(sourceRaw).digest("hex");
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
		expect(result.sourceExists).toBe(true); // source kept active (shadowed by config.yml)
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

	test("pending yes/yes with matching hashes and a satisfied target dedupes the source", async () => {
		const home = await tempDir();
		const cwd = await tempDir();
		const { source, agentDir } = await setupHome(home, ".myconfig");
		const sourceRaw = JSON.stringify({ "gjc.ralplan.maxIterations": 7 });
		const sourceSha256 = createHash("sha256").update(sourceRaw).digest("hex");
		await fs.mkdir(agentDir, { recursive: true });
		// Crash after patch + move, before finalization: target patched, S and B both present.
		await fs.writeFile(
			path.join(agentDir, "config.yml"),
			YAML.stringify({ gjc: { ralplan: { maxIterations: 7 } } }, null, 2),
		);
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
		expect(result.markerStatus).toBe("complete");
		expect(result.sourceExists).toBe(true); // source kept active (resolver deactivates it while it matches)
		expect(result.backupExists).toBe(true);
		expect(result.targetValue).toBe(7);
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
		const oldSourceHash = createHash("sha256").update('{"gjc.ralplan.maxIterations":7}').digest("hex");
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
		expect(createHash("sha256").update(backupRaw).digest("hex")).toBe(marker.sourceSha256);
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
		const oldSourceHash = createHash("sha256").update('{"gjc.ralplan.maxIterations":7}').digest("hex");
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
		const oldSourceHash = createHash("sha256").update('{"gjc.ralplan.maxIterations":7}').digest("hex");
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
		const oldSourceHash = createHash("sha256").update('{"gjc.ultragoal.nudgeBudget":7}').digest("hex");
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
		const oldSourceHash = createHash("sha256").update('{"gjc.ralplan.maxIterations":7}').digest("hex");
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
		const oldSourceHash = createHash("sha256")
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
		const oldSourceHash = createHash("sha256").update('{"gjc.ralplan.autoHandoff":"team"}').digest("hex");
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
		const oldSourceHash = createHash("sha256").update(oldRaw).digest("hex");
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

	test("editing the legacy source after completion re-migrates the current value", async () => {
		const home = await tempDir();
		const cwd = await tempDir();
		const { source, agentDir } = await setupHome(home, ".myconfig");
		await fs.mkdir(agentDir, { recursive: true });
		const target = path.join(agentDir, "config.yml");
		const oldRaw = '{"gjc.ralplan.maxIterations":7}';
		await fs.writeFile(target, YAML.stringify({ gjc: { ralplan: { maxIterations: 7 } } }, null, 2));
		await fs.writeFile(`${source}.bak`, oldRaw); // the migration copy (old source)
		await fs.writeFile(source, '{"gjc.ralplan.maxIterations":9}'); // user edited after completion
		const oldSourceHash = createHash("sha256").update(oldRaw).digest("hex");
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
		// The stale complete marker is invalidated and the current source value
		// (9) is re-migrated over the stale 7.
		expect(result.markerStatus).toBe("complete");
		expect(result.targetValue).toBe(9);
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
		const oldSourceHash = createHash("sha256").update(oldRaw).digest("hex");
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
	test("deleting the source after completion keeps a user-edited target override", async () => {
		const home = await tempDir();
		const cwd = await tempDir();
		const { source, agentDir } = await setupHome(home, ".myconfig");
		await fs.mkdir(agentDir, { recursive: true });
		const target = path.join(agentDir, "config.yml");
		const oldRaw = '{"gjc.ralplan.maxIterations":7}';
		// The user ran `gjc config set` to 11 AFTER the migration, then deleted
		// the legacy source.
		await fs.writeFile(target, YAML.stringify({ gjc: { ralplan: { maxIterations: 11 } } }, null, 2));
		await fs.writeFile(`${source}.bak`, oldRaw); // migration copy (7)
		const oldSourceHash = createHash("sha256").update(oldRaw).digest("hex");
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
		// source is absent (deleted)

		const result = await runProbe(cwd, { home, configDir: ".myconfig" });
		// The user's override (11) is NOT the migration's write (7), so it is kept.
		expect(result.markerStatus).toBeNull();
		expect(result.backupExists).toBe(false);
		expect(result.targetValue).toBe(11);
	});

	test("a second legacy edit after re-migration is still reconciled", async () => {
		const home = await tempDir();
		const cwd = await tempDir();
		const { source, agentDir } = await setupHome(home, ".myconfig");
		await fs.mkdir(agentDir, { recursive: true });
		const target = path.join(agentDir, "config.yml");
		const oldRaw = '{"gjc.ralplan.maxIterations":7}';
		await fs.writeFile(target, YAML.stringify({ gjc: { ralplan: { maxIterations: 7 } } }, null, 2));
		await fs.writeFile(`${source}.bak`, oldRaw);
		await fs.writeFile(source, '{"gjc.ralplan.maxIterations":9}');
		const oldSourceHash = createHash("sha256").update(oldRaw).digest("hex");
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

		expect((await runProbe(cwd, { home, configDir: ".myconfig" })).targetValue).toBe(9);
		// The backup is REFRESHED (not removed) after the first re-migration, so a
		// SECOND edit still has a comparison basis.
		await fs.writeFile(source, '{"gjc.ralplan.maxIterations":12}');
		expect((await runProbe(cwd, { home, configDir: ".myconfig" })).targetValue).toBe(12);
	});

	test("the refreshed reconcile backup stays owner-only", async () => {
		const home = await tempDir();
		const cwd = await tempDir();
		const { source, agentDir } = await setupHome(home, ".myconfig");
		await fs.mkdir(agentDir, { recursive: true });
		const target = path.join(agentDir, "config.yml");
		const oldRaw = '{"gjc.ralplan.maxIterations":7}';
		await fs.writeFile(target, YAML.stringify({ gjc: { ralplan: { maxIterations: 7 } } }, null, 2));
		await fs.writeFile(`${source}.bak`, oldRaw);
		await fs.writeFile(source, '{"gjc.ralplan.maxIterations":9}');
		const oldSourceHash = createHash("sha256").update(oldRaw).digest("hex");
		const agentIdentity = await fs.stat(agentDir);
		await fs.writeFile(
			`${source}.migrated`,
			JSON.stringify({
				version: 1,
				status: "complete",
				sourcePath: source,
				backupPath: `${source}.bak`,
				targetPath: target,
				canonicalTargetDir: await fs.realpath(agentDir),
				canonicalTargetIdentity: `${agentIdentity.dev}:${agentIdentity.ino}`,
				sourceSha256: oldSourceHash,
				migratedKeys: ["gjc.ralplan.maxIterations"],
				startedAt: new Date().toISOString(),
				completedAt: new Date().toISOString(),
			}),
		);

		const result = await runProbe(cwd, { home, configDir: ".myconfig" });
		expect(result.targetValue).toBe(9);
		// The refreshed backup holds the FULL legacy document; a 022 umask must
		// never make it world-readable (0o600, not 0o644).
		const backupMode = (await fs.stat(`${source}.bak`)).mode & 0o777;
		expect(backupMode).toBe(0o600);
	});

	test("reconciled completion binds to the directory that received the repairs", async () => {
		const home = await tempDir();
		const cwd = await tempDir();
		const { source, agentDir } = await setupHome(home, ".myconfig");
		await fs.mkdir(agentDir, { recursive: true });
		const target = path.join(agentDir, "config.yml");
		const oldRaw = '{"gjc.ralplan.maxIterations":7}';
		await fs.writeFile(target, YAML.stringify({ gjc: { ralplan: { maxIterations: 7 } } }, null, 2));
		await fs.writeFile(`${source}.bak`, oldRaw);
		await fs.writeFile(source, '{"gjc.ralplan.maxIterations":9}');
		const oldSourceHash = createHash("sha256").update(oldRaw).digest("hex");
		await fs.writeFile(
			`${source}.migrated`,
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
		expect(result.targetValue).toBe(9);
		const stat = await fs.stat(agentDir);
		const marker = JSON.parse(await fs.readFile(`${source}.migrated`, "utf8")) as {
			status?: unknown;
			canonicalTargetDir?: unknown;
			canonicalTargetIdentity?: unknown;
		};
		expect(marker.status).toBe("complete");
		expect(marker.canonicalTargetDir).toBe(await fs.realpath(agentDir));
		expect(marker.canonicalTargetIdentity).toBe(`${stat.dev}:${stat.ino}`);
	});

	test("a workflow key added to the source after completion is migrated", async () => {
		const home = await tempDir();
		const cwd = await tempDir();
		const { source, agentDir } = await setupHome(home, ".myconfig");
		await fs.mkdir(agentDir, { recursive: true });
		const target = path.join(agentDir, "config.yml");
		const oldRaw = '{"gjc.ralplan.maxIterations":7}';
		await fs.writeFile(target, YAML.stringify({ gjc: { ralplan: { maxIterations: 7 } } }, null, 2));
		await fs.writeFile(`${source}.bak`, oldRaw);
		// The user ADDS a previously absent key (nudgeBudget) after completion.
		await fs.writeFile(source, '{"gjc.ralplan.maxIterations":7,"gjc.ultragoal.nudgeBudget":5}');
		const oldSourceHash = createHash("sha256").update(oldRaw).digest("hex");
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
		expect(result.markerStatus).toBe("complete");
		const parsed = YAML.parse(await fs.readFile(target, "utf8")) as Record<string, unknown>;
		const gjc = parsed.gjc as Record<string, unknown> | undefined;
		const ultragoal = gjc?.ultragoal as Record<string, unknown> | undefined;
		expect(ultragoal?.nudgeBudget).toBe(5); // the newly added key is copied
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
		const oldSourceHash = createHash("sha256").update(oldRaw).digest("hex");
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
	test("a second edit to a reconcile-copied key is propagated", async () => {
		const home = await tempDir();
		const cwd = await tempDir();
		const { source, agentDir } = await setupHome(home, ".myconfig");
		await fs.mkdir(agentDir, { recursive: true });
		const target = path.join(agentDir, "config.yml");
		const oldRaw = '{"gjc.ralplan.maxIterations":7}';
		await fs.writeFile(target, YAML.stringify({ gjc: { ralplan: { maxIterations: 7 } } }, null, 2));
		await fs.writeFile(`${source}.bak`, oldRaw);
		await fs.writeFile(source, '{"gjc.ralplan.maxIterations":7,"gjc.ultragoal.nudgeBudget":5}');
		const oldSourceHash = createHash("sha256").update(oldRaw).digest("hex");
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

		// First load copies the newly added nudgeBudget into the target.
		const first = await runProbe(cwd, { home, configDir: ".myconfig" });
		expect(first.markerStatus).toBe("complete");
		// The SECOND edit to the copied key must be honored (the marker now owns
		// the key via migratedKeys).
		await fs.writeFile(source, '{"gjc.ralplan.maxIterations":7,"gjc.ultragoal.nudgeBudget":8}');
		const second = await runProbe(cwd, { home, configDir: ".myconfig" });
		const parsed = YAML.parse(await fs.readFile(target, "utf8")) as Record<string, unknown>;
		const ultragoal = (parsed.gjc as Record<string, unknown> | undefined)?.ultragoal as
			| Record<string, unknown>
			| undefined;
		expect(ultragoal?.nudgeBudget).toBe(8);
		expect(second.markerStatus).toBe("complete");
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
		const oldSourceHash = createHash("sha256").update(oldRaw).digest("hex");
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
		const oldSourceHash = createHash("sha256").update(oldRaw).digest("hex");
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
		const oldSourceHash = createHash("sha256").update(oldRaw).digest("hex");
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
				sourceSha256: createHash("sha256").update(sourceRaw).digest("hex"),
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
				sourceSha256: createHash("sha256").update(oldRaw).digest("hex"),
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
				sourceSha256: createHash("sha256").update(oldRaw).digest("hex"),
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
				sourceSha256: createHash("sha256").update(sourceRaw).digest("hex"),
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
				sourceSha256: createHash("sha256").update(oldRaw).digest("hex"),
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
				sourceSha256: createHash("sha256").update(oldRaw).digest("hex"),
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
		const hash = (value: unknown): string => createHash("sha256").update(JSON.stringify(value)).digest("hex");
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
				sourceSha256: createHash("sha256").update(proposedRaw).digest("hex"),
				priorSourceSha256: createHash("sha256").update(originalRaw).digest("hex"),
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

	test("a deleted-and-readded marker-owned key is reconciled again", async () => {
		const home = await tempDir();
		const cwd = await tempDir();
		const { source, agentDir } = await setupHome(home, ".myconfig");
		await fs.mkdir(agentDir, { recursive: true });
		const target = path.join(agentDir, "config.yml");
		const oldRaw = '{"gjc.ralplan.maxIterations":7}';
		await fs.writeFile(target, YAML.stringify({ gjc: { ralplan: { maxIterations: 7 } } }, null, 2));
		await fs.writeFile(`${source}.bak`, oldRaw);
		const oldSourceHash = createHash("sha256").update(oldRaw).digest("hex");
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

		// Load 1: the user REMOVES the key -> the target is unset.
		await fs.writeFile(source, "{}");
		expect((await runProbe(cwd, { home, configDir: ".myconfig" })).targetValue).toBeNull();
		// Load 2: the user RE-ADDS the key -> it is copied again.
		await fs.writeFile(source, '{"gjc.ralplan.maxIterations":9}');
		expect((await runProbe(cwd, { home, configDir: ".myconfig" })).targetValue).toBe(9);
	});

	test("malformed-parent reconciliation clears the stale marker-owned target", async () => {
		const home = await tempDir();
		const cwd = await tempDir();
		const { source, agentDir } = await setupHome(home, ".myconfig");
		await fs.mkdir(agentDir, { recursive: true });
		const target = path.join(agentDir, "config.yml");
		const oldRaw = '{"gjc.ultragoal.nudgeBudget":7}';
		await fs.writeFile(target, YAML.stringify({ gjc: { ultragoal: { nudgeBudget: 7 } } }, null, 2));
		await fs.writeFile(`${source}.bak`, oldRaw);
		// The user breaks the ultragoal parent after completion.
		await fs.writeFile(source, '{"gjc":{"ultragoal":"broken"}}');
		const oldSourceHash = createHash("sha256").update(oldRaw).digest("hex");
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
		const parsed = YAML.parse(await fs.readFile(target, "utf8")) as Record<string, unknown>;
		const ultragoal = (parsed.gjc as Record<string, unknown> | undefined)?.ultragoal as
			| Record<string, unknown>
			| undefined;
		expect(ultragoal?.nudgeBudget).toBeUndefined(); // stale migration-write cleared
		expect(result.sourceExists).toBe(true);
	});
});
