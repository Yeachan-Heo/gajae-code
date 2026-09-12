import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { pluginTargetId, resolveDoctorRoot } from "../src/cli/doctor/ids";
import type { DoctorReport } from "../src/cli/doctor/types";

const cli = path.resolve(import.meta.dir, "../src/cli.ts");
const config = path.resolve(import.meta.dir, "../src/sdk/broker/internal-source.bunfig.toml");
const roots: string[] = [];
interface Fixture {
	root: string;
	profile: string;
	project: string;
	plugins: string;
	marker: string;
}
async function fixture(): Promise<Fixture> {
	const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "doctor-plugin-cli-")));
	roots.push(root);
	const profile = path.join(root, "profile");
	const project = path.join(root, "project");
	const plugins = path.join(root, ".gjc", "plugins");
	const marker = path.join(root, "plugin-executed");
	await fs.mkdir(profile, { mode: 0o700 });
	await fs.mkdir(project, { mode: 0o700 });
	await fs.mkdir(plugins, { recursive: true, mode: 0o700 });
	await Bun.write(
		path.join(plugins, "package.json"),
		JSON.stringify({ dependencies: { "@fixture/target": "1.0.0", other: "1.0.0" } }),
	);
	await Bun.write(
		path.join(plugins, "gjc-plugins.lock.json"),
		JSON.stringify({
			plugins: {
				"@fixture/target": { version: "1.0.0", enabled: true, enabledFeatures: null },
				other: { version: "1.0.0", enabled: true, enabledFeatures: null },
			},
			settings: {},
		}),
	);
	for (const name of ["@fixture/target", "other"]) {
		const directory = path.join(plugins, "node_modules", name);
		await fs.mkdir(directory, { recursive: true, mode: 0o700 });
		await Bun.write(
			path.join(directory, "package.json"),
			JSON.stringify({ name, version: "1.0.0", gjc: { name, tools: ["boom.ts"] } }),
		);
		await Bun.write(path.join(directory, "boom.ts"), `await Bun.write(${JSON.stringify(marker)}, "executed");\n`);
	}
	return { root, profile, project, plugins, marker };
}
async function invoke(f: Fixture, args: string[]): Promise<{ report: DoctorReport; code: number; output: string }> {
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
	const timer = setTimeout(() => child.kill("SIGKILL"), 20_000);
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

describe("doctor plugin quarantine CLI", () => {
	test("disables one scoped npm plugin without evaluating code or touching its sibling", async () => {
		const f = await fixture();
		const rootId = resolveDoctorRoot("config-user", f.profile).rootId;
		const target = pluginTargetId(rootId, "npm", "user", "@fixture/target");
		const selection = ["--check", "plugin", "--scope", "user"];
		const before = await invoke(f, selection);
		expect(before.report.checks.find(check => check.targetId === target)?.evidence.enabled).toBe(true);
		const result = await invoke(f, [
			...selection,
			"--fix",
			"--repair",
			"plugin.quarantine-selected",
			"--target",
			target,
			"--allow-risk",
			"plugin-change",
			"--yes",
		]);
		expect(result.code, JSON.stringify(result.report.repairs)).toBe(0);
		expect(result.report.repairs[0].state).toBe("verified");
		const saved = await Bun.file(path.join(f.plugins, "gjc-plugins.lock.json")).json();
		expect(saved.plugins["@fixture/target"].enabled).toBe(false);
		expect(saved.plugins.other.enabled).toBe(true);
		expect(await Bun.file(f.marker).exists()).toBe(false);
		expect(
			result.report.checks.find(check => check.targetId === target && !check.id.startsWith("before."))?.evidence
				.enabled,
		).toBe(false);
	}, 30_000);
});
