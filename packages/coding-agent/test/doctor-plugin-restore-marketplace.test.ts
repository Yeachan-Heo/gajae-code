/**
 * D6 private-marketplace restore through the real `gjc doctor` CLI.
 *
 * The lane itself is covered by `doctor-plugin-restore.test.ts`; this file
 * proves the doctor-side wiring: the marketplace family is dispatched rather
 * than refused as unsupported, it demands the same explicit pins as every other
 * repair, and npm stays the plan's distinct shared-layout refusal.
 *
 * Marketplace paths resolve from the process config root, not from
 * `setAgentDir`, so every case runs in a spawned child with an isolated `HOME`.
 * An in-process fixture would write into the operator's real `~/.gjc`.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { pluginTargetId, resolveDoctorRoot } from "../src/cli/doctor/ids";
import type { DoctorReport } from "../src/cli/doctor/types";

const cli = path.resolve(import.meta.dir, "../src/cli.ts");
const config = path.resolve(import.meta.dir, "../src/sdk/broker/internal-source.bunfig.toml");
const PLUGIN_ID = "private-plugin@private";
const roots: string[] = [];

interface Fixture {
	readonly root: string;
	readonly project: string;
	readonly installedRoot: string;
	readonly sha: string;
	readonly targetId: string;
}

afterEach(async () => {
	for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
});

/** A locally hosted, pinned-SHA private marketplace whose cached artifact is corrupt. */
async function fixture(): Promise<Fixture> {
	const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "doctor-mkt-")));
	roots.push(root);
	const project = path.join(root, "project");
	const agentDir = path.join(root, ".gjc", "agent");
	await fs.mkdir(project, { recursive: true, mode: 0o700 });
	await fs.mkdir(agentDir, { recursive: true, mode: 0o700 });

	const pluginRepo = path.join(root, "plugin-repo");
	await fs.mkdir(path.join(pluginRepo, ".claude-plugin"), { recursive: true });
	await fs.writeFile(
		path.join(pluginRepo, ".claude-plugin", "plugin.json"),
		JSON.stringify({ name: "private-plugin", version: "1.0.0" }),
	);
	for (const args of [
		["init", "-q", pluginRepo],
		["-C", pluginRepo, "config", "user.email", "test@example.invalid"],
		["-C", pluginRepo, "config", "user.name", "test"],
		["-C", pluginRepo, "add", "."],
		["-C", pluginRepo, "commit", "-qm", "fixture"],
	])
		spawnSync("git", args);
	const sha = spawnSync("git", ["-C", pluginRepo, "rev-parse", "HEAD"], { encoding: "utf8" }).stdout.trim();

	// Canonical layout under the isolated config root: <home>/.gjc/plugins/...
	const pluginsDir = path.join(root, ".gjc", "plugins");
	const marketplaceRoot = path.join(pluginsDir, "cache", "marketplaces", "private");
	await fs.mkdir(marketplaceRoot, { recursive: true });
	const catalogPath = path.join(marketplaceRoot, "marketplace.json");
	await fs.writeFile(
		catalogPath,
		JSON.stringify({
			name: "private",
			owner: { name: "test" },
			plugins: [{ name: "private-plugin", source: { source: "url", url: pluginRepo, sha }, version: "1.0.0" }],
		}),
	);
	await Bun.write(
		path.join(root, ".gjc", "marketplaces.json"),
		JSON.stringify({
			version: 1,
			marketplaces: [
				{
					name: "private",
					sourceType: "local",
					sourceUri: marketplaceRoot,
					catalogPath,
					addedAt: "2020-01-01T00:00:00.000Z",
					updatedAt: "2020-01-01T00:00:00.000Z",
				},
			],
		}),
	);

	const installedRoot = path.join(pluginsDir, "cache", "plugins", "private___private-plugin___1.0.0");
	await fs.mkdir(installedRoot, { recursive: true });
	await fs.writeFile(path.join(installedRoot, "corrupt"), "bad");
	await Bun.write(
		path.join(pluginsDir, "installed_plugins.json"),
		JSON.stringify({
			version: 2,
			plugins: {
				[PLUGIN_ID]: [
					{
						scope: "user",
						installPath: installedRoot,
						version: "1.0.0",
						installedAt: "2020-01-01T00:00:00.000Z",
						lastUpdated: "2020-01-01T00:00:00.000Z",
						enabled: false,
					},
				],
			},
		}),
	);

	const rootId = resolveDoctorRoot("config-user", agentDir).rootId;
	return { root, project, installedRoot, sha, targetId: pluginTargetId(rootId, "marketplace", "user", PLUGIN_ID) };
}

async function doctor(f: Fixture, args: string[]): Promise<{ report: DoctorReport; code: number }> {
	const child = Bun.spawn(
		[process.execPath, "--no-env-file", `--config=${config}`, cli, "doctor", "--json", ...args],
		{
			cwd: f.project,
			env: {
				PATH: process.env.PATH,
				HOME: f.root,
				GJC_CODING_AGENT_DIR: path.join(f.root, ".gjc", "agent"),
				BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0",
				NO_COLOR: "1",
			},
			stdin: "ignore",
			stdout: "pipe",
			stderr: "pipe",
		},
	);
	const timer = setTimeout(() => child.kill("SIGKILL"), 120_000);
	try {
		const [stdout, , code] = await Promise.all([
			new Response(child.stdout).text(),
			new Response(child.stderr).text(),
			child.exited,
		]);
		const report = JSON.parse(stdout) as DoctorReport;
		expect(report.summary.exitCode).toBe(code);
		return { report, code };
	} finally {
		clearTimeout(timer);
	}
}

const selection = ["--check", "plugin", "--scope", "user"];
const authorized = ["--allow-risk", "plugin-change", "--allow-risk", "install-replace", "--allow-risk", "network"];

describe("doctor D6 private-marketplace dispatch", () => {
	test("publishes the catalog pin as a candidate and restores the corrupt artifact", async () => {
		const f = await fixture();
		expect(await fs.readdir(f.installedRoot)).toEqual(["corrupt"]);

		// The pin is reported, never auto-selected: an unpinned apply must refuse.
		const preview = await doctor(f, [
			...selection,
			"--fix",
			"--repair",
			"plugin.restore-known-artifact",
			"--target",
			f.targetId,
			"--allow-risk",
			"plugin-change",
			"--allow-risk",
			"install-replace",
			"--allow-risk",
			"network",
			"--yes",
		]);
		const repair = preview.report.repairs[0];
		expect(repair.state).toBe("blocked");
		expect(repair.candidates[0]?.ref).toBe(f.sha);
		const digest = repair.candidates[0]?.sha256;
		expect(digest).toBeDefined();
		expect(await fs.readdir(f.installedRoot)).toEqual(["corrupt"]);

		const applied = await doctor(f, [
			...selection,
			"--fix",
			"--repair",
			"plugin.restore-known-artifact",
			"--target",
			f.targetId,
			"--ref",
			f.sha,
			"--sha256",
			digest as string,
			"--allow-risk",
			"plugin-change",
			"--allow-risk",
			"install-replace",
			"--allow-risk",
			"network",
			"--yes",
			"--timeout-ms",
			"110000",
		]);
		expect(applied.report.repairs[0].state, JSON.stringify(applied.report.repairs[0])).toBe("verified");
		const restored = await fs.readdir(f.installedRoot);
		expect(restored).toContain(".claude-plugin");
		expect(restored).not.toContain("corrupt");
		// Disabled state survives the restore.
		const registry = await Bun.file(path.join(f.root, ".gjc", "plugins", "installed_plugins.json")).json();
		expect(registry.plugins[PLUGIN_ID][0].enabled).toBe(false);
	}, 240_000);

	test("publishes a byte-identical pin across repeated runs and across artifact damage", async () => {
		const f = await fixture();
		const pin = async (): Promise<{ ref?: string; sha256?: string }> => {
			const r = await doctor(f, [
				...selection,
				"--dry-run",
				"--repair",
				"plugin.restore-known-artifact",
				"--target",
				f.targetId,
			]);
			const c = r.report.repairs[0].candidates[0];
			return { ref: c?.ref, sha256: c?.sha256 };
		};
		// An operator must be able to read a pin, then authorize it in a later
		// invocation. A pin that moves between runs can never be pre-authorized.
		const first = await pin();
		expect(first.ref).toBe(f.sha);
		expect(first.sha256).toBeDefined();
		expect(await pin()).toEqual(first);
		// The pin names the catalog entry, not the installed bytes, so damaging or
		// deleting the artifact must not move it — otherwise the very artifact that
		// needs repair could never be pre-authorized.
		await fs.rm(f.installedRoot, { recursive: true, force: true });
		expect(await pin()).toEqual(first);
	}, 180_000);

	test("restores an artifact that is entirely absent", async () => {
		const f = await fixture();
		// The whole point of D6: the artifact is gone. A pin derived from the
		// installed tree would be undefined here and would make this unrepairable.
		await fs.rm(f.installedRoot, { recursive: true, force: true });

		const preview = await doctor(f, [
			...selection,
			"--fix",
			"--repair",
			"plugin.restore-known-artifact",
			"--target",
			f.targetId,
			...authorized,
			"--yes",
		]);
		const candidate = preview.report.repairs[0].candidates[0];
		expect(candidate?.ref).toBe(f.sha);
		expect(candidate?.sha256).toBeDefined();

		const applied = await doctor(f, [
			...selection,
			"--fix",
			"--repair",
			"plugin.restore-known-artifact",
			"--target",
			f.targetId,
			"--ref",
			f.sha,
			"--sha256",
			candidate?.sha256 as string,
			...authorized,
			"--yes",
			"--timeout-ms",
			"110000",
		]);
		expect(applied.report.repairs[0].state, JSON.stringify(applied.report.repairs[0])).toBe("verified");
		expect(await fs.readdir(f.installedRoot)).toContain(".claude-plugin");
	}, 240_000);

	test("refuses when the network risk the lane enforces is not authorized", async () => {
		const f = await fixture();
		// The marketplace lane resolves a git source, so its own authorizer demands
		// `network`. The plan must demand it too, pre-effect.
		const result = await doctor(f, [
			...selection,
			"--fix",
			"--repair",
			"plugin.restore-known-artifact",
			"--target",
			f.targetId,
			"--ref",
			f.sha,
			"--sha256",
			"a".repeat(64),
			"--allow-risk",
			"plugin-change",
			"--allow-risk",
			"install-replace",
			"--yes",
		]);
		expect(result.report.repairs[0].riskClasses).toContain("network");
		expect(result.report.repairs[0].readiness).toContain("authorization_missing");
		expect(result.report.repairs[0]).toMatchObject({ state: "blocked", sideEffectStarted: false });
		expect(await fs.readdir(f.installedRoot)).toEqual(["corrupt"]);
	}, 120_000);

	test("leaves no staged tree behind on a refusal after authorization", async () => {
		const f = await fixture();
		const staged = async (): Promise<string[]> =>
			(await fs.readdir(os.tmpdir())).filter(name => name.startsWith("gjc-marketplace-restore-"));
		const before = await staged();

		// Authorization stages a full copy of the resolved tree before anything can
		// refuse. Disposal is the caller's contract, so a refusal must not leak it.
		const result = await doctor(f, [
			...selection,
			"--fix",
			"--repair",
			"plugin.restore-known-artifact",
			"--target",
			f.targetId,
			"--ref",
			f.sha,
			"--sha256",
			"a".repeat(64),
			...authorized,
			"--yes",
		]);
		expect(result.report.repairs[0].state).toBe("blocked");
		expect(await staged()).toEqual(before);
	}, 180_000);

	test("refuses a wrong provenance pin without touching the artifact", async () => {
		const f = await fixture();
		const result = await doctor(f, [
			...selection,
			"--fix",
			"--repair",
			"plugin.restore-known-artifact",
			"--target",
			f.targetId,
			"--ref",
			"f".repeat(40),
			"--sha256",
			"a".repeat(64),
			"--allow-risk",
			"plugin-change",
			"--allow-risk",
			"install-replace",
			"--allow-risk",
			"network",
			"--yes",
		]);
		expect(result.report.repairs[0]).toMatchObject({
			state: "blocked",
			reasonCode: "candidate_provenance_mismatch",
			sideEffectStarted: false,
		});
		expect(await fs.readdir(f.installedRoot)).toEqual(["corrupt"]);
	}, 120_000);

	test("refuses without install-replace authorization", async () => {
		const f = await fixture();
		const result = await doctor(f, [
			...selection,
			"--fix",
			"--repair",
			"plugin.restore-known-artifact",
			"--target",
			f.targetId,
			"--ref",
			f.sha,
			"--sha256",
			"a".repeat(64),
			"--allow-risk",
			"plugin-change",
			"--yes",
		]);
		expect(result.report.repairs[0]).toMatchObject({ state: "blocked", sideEffectStarted: false });
		expect(result.report.repairs[0].readiness).toContain("authorization_missing");
		expect(await fs.readdir(f.installedRoot)).toEqual(["corrupt"]);
	}, 120_000);
});
