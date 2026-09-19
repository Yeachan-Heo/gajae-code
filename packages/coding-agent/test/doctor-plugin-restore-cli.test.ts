import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { pluginTargetId, resolveDoctorRoot } from "../src/cli/doctor/ids";
import type { DoctorReport } from "../src/cli/doctor/types";
import { registryPathForScope } from "../src/extensibility/gjc-plugins/registry";

const cli = path.resolve(import.meta.dir, "../src/cli.ts");
const config = path.resolve(import.meta.dir, "../src/sdk/broker/internal-source.bunfig.toml");
const bundle = path.join(import.meta.dir, "fixtures", "gjc-plugins", "valid-six-surface-bundle");
const roots: string[] = [];

interface Fixture {
	root: string;
	profile: string;
	project: string;
	registryPath: string;
	target: string;
	pluginRoot: string;
}

async function fixture(): Promise<Fixture> {
	const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "doctor-restore-cli-")));
	roots.push(root);
	const profile = path.join(root, "profile");
	const project = path.join(root, "project");
	await fs.mkdir(profile, { mode: 0o700 });
	await fs.mkdir(project, { mode: 0o700 });
	await fs.cp(bundle, path.join(project, "source"), { recursive: true });
	const install = Bun.spawnSync(
		[process.execPath, "--no-env-file", `--config=${config}`, cli, "plugin", "install", "--project", "./source"],
		{
			cwd: project,
			env: {
				PATH: process.env.PATH,
				HOME: root,
				GJC_CODING_AGENT_DIR: profile,
				BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0",
				NO_COLOR: "1",
			},
			stdout: "pipe",
			stderr: "pipe",
		},
	);
	if (install.exitCode !== 0) throw new Error(`plugin install failed: ${install.stderr.toString()}`);
	const registryPath = registryPathForScope("project", project);
	const registry = await Bun.file(registryPath).json();
	const entry = registry.plugins[0];
	const rootId = resolveDoctorRoot("config-project", path.join(project, ".gjc")).rootId;
	return {
		root,
		profile,
		project,
		registryPath,
		pluginRoot: entry.pluginRoot,
		target: pluginTargetId(rootId, "gjc", "project", entry.name),
	};
}

/** Reads the pins the operator must pass explicitly: the run reports them as a candidate, never auto-selects them. */
async function pins(f: Fixture): Promise<{ ref: string; sha256: string }> {
	const preview = await doctor(f, [
		"--check",
		"plugin",
		"--scope",
		"project",
		"--repair",
		"plugin.restore-known-artifact",
		"--target",
		f.target,
	]);
	const candidate = preview.report.repairs[0]?.candidates[0];
	if (!candidate?.ref || !candidate.sha256)
		throw new Error(`no restore candidate: ${JSON.stringify(preview.report.repairs[0])}`);
	return { ref: candidate.ref, sha256: candidate.sha256 };
}

async function doctor(f: Fixture, args: string[]): Promise<{ report: DoctorReport; code: number; output: string }> {
	const child = Bun.spawn(
		[process.execPath, "--no-env-file", `--config=${config}`, cli, "doctor", "--json", ...args],
		{
			cwd: f.project,
			env: {
				PATH: process.env.PATH,
				HOME: f.root,
				GJC_CODING_AGENT_DIR: f.profile,
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
		const [stdout, stderr, code] = await Promise.all([
			new Response(child.stdout).text(),
			new Response(child.stderr).text(),
			child.exited,
		]);
		const report = JSON.parse(stdout) as DoctorReport;
		expect(report.summary.exitCode).toBe(code);
		return { report, code, output: stdout + stderr };
	} finally {
		clearTimeout(timer);
	}
}

afterEach(async () => {
	for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
});

describe("doctor plugin.restore-known-artifact CLI", () => {
	const selection = ["--check", "plugin", "--scope", "project"];

	test("restores a damaged known artifact and preserves the registry's enablement", async () => {
		const f = await fixture();
		const before = await Bun.file(f.registryPath).json();
		expect(before.plugins[0].enabled).toBe(true);
		await fs.rm(f.pluginRoot, { recursive: true, force: true });

		const pin = await pins(f);
		const result = await doctor(f, [
			...selection,
			"--fix",
			"--repair",
			"plugin.restore-known-artifact",
			"--target",
			f.target,
			"--ref",
			pin.ref,
			"--sha256",
			pin.sha256,
			"--allow-risk",
			"plugin-change",
			"--allow-risk",
			"install-replace",
			"--yes",
			"--timeout-ms",
			"110000",
		]);
		const repair = result.report.repairs[0];
		expect(repair.state, JSON.stringify(repair)).toBe("verified");
		expect(result.code).toBe(0);
		expect((await fs.stat(f.pluginRoot)).isDirectory()).toBe(true);
		const after = await Bun.file(f.registryPath).json();
		expect(after.plugins[0].enabled).toBe(true);
		expect(after.plugins[0].name).toBe(before.plugins[0].name);
	}, 240_000);

	test("refuses without install-replace authorization and leaves the artifact untouched", async () => {
		const f = await fixture();
		await fs.rm(f.pluginRoot, { recursive: true, force: true });
		const pin = await pins(f);
		const result = await doctor(f, [
			...selection,
			"--fix",
			"--repair",
			"plugin.restore-known-artifact",
			"--target",
			f.target,
			"--ref",
			pin.ref,
			"--sha256",
			pin.sha256,
			"--allow-risk",
			"plugin-change",
			"--yes",
		]);
		expect(result.report.repairs[0]).toMatchObject({ state: "blocked", sideEffectStarted: false });
		expect(result.report.repairs[0].readiness).toContain("authorization_missing");
		await expect(fs.stat(f.pluginRoot)).rejects.toMatchObject({ code: "ENOENT" });
	}, 120_000);

	test("reports a healthy artifact as not_needed without any restore effect", async () => {
		const f = await fixture();
		const pin = await pins(f);
		const result = await doctor(f, [
			...selection,
			"--fix",
			"--repair",
			"plugin.restore-known-artifact",
			"--target",
			f.target,
			"--ref",
			pin.ref,
			"--sha256",
			pin.sha256,
			"--allow-risk",
			"plugin-change",
			"--allow-risk",
			"install-replace",
			"--yes",
		]);
		expect(result.report.repairs[0]).toMatchObject({
			state: "not_needed",
			reasonCode: "plugin_artifact_present",
			sideEffectStarted: false,
		});
	}, 120_000);
});
