import { afterEach, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

/**
 * Status-line commands and finalize validation spawn a login shell.
 * A repository `.env` must not supply BASH_ENV, ENV, or ZDOTDIR to those
 * children. A different caller value is still passed through.
 */

const PROBE = path.join(import.meta.dir, "fixtures", "shell-startup-hook-children-probe.ts");
const hasBash = fs.existsSync("/bin/bash");
const tempDirs: string[] = [];

afterEach(() => {
	for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function makeTemp(prefix: string): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
	tempDirs.push(dir);
	return dir;
}

function writeScript(file: string, marker: string): void {
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, `printf 'ran\\n' > ${JSON.stringify(marker)}\n`);
}

interface Dump {
	bash: string;
	zdot: string;
	env: string;
	unrelated: string;
	caseName: string;
}

interface ShellReport {
	exitCode: number;
	stderr: string;
	dump: Dump | null;
}

interface Report {
	before: { bash: string; zdot: string; env: string };
	after: { bash: string; zdot: string; env: string };
	bashStatus: ShellReport;
	zsh: ShellReport | null;
	fin: { exitStatus: number; pass: boolean; dump: Dump | null } | { error: string };
	cachedDelete: ShellReport | null;
	cachedReplace: ShellReport | null;
	concurrent: [ShellReport, ShellReport] | null;
	caseNeighbor: ShellReport | null;
	spaced: ShellReport | null;
	trimmed: ShellReport | null;
	explicit: ShellReport | null;
	propertyRan: boolean;
}

function childEnv(home: string, extra: Record<string, string>): Record<string, string> {
	const env: Record<string, string> = {};
	for (const [key, value] of Object.entries(process.env)) {
		if (value !== undefined) env[key] = value;
	}
	for (const key of ["BASH_ENV", "ZDOTDIR", "ENV", "SHELLOPTS", "PS4", "UNRELATED_OK", "Bash_Env"]) delete env[key];
	env.HOME = home;
	env.USERPROFILE = home;
	env.TERM = "dumb";
	env.CI = "1";
	const pathKey = "PATH";
	const parentPath = process.env[pathKey];
	env[pathKey] = parentPath && parentPath.length > 0 ? parentPath : "/usr/bin:/bin";
	Object.assign(env, extra);
	return env;
}

async function runProbe(
	project: string,
	out: string,
	extra: Record<string, string>,
	flags: Record<string, string> = {},
) {
	const home = makeTemp("gjc-hook-home-");
	const proc = Bun.spawn([process.execPath, PROBE], {
		cwd: project,
		env: { ...childEnv(home, extra), PROBE_OUT: out, ...flags },
		stdout: "pipe",
		stderr: "pipe",
	});
	const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
	const exitCode = await proc.exited;
	const reportPath = path.join(out, "report.json");
	if (exitCode !== 0 || !fs.existsSync(reportPath)) {
		throw new Error(`probe failed (${exitCode}): ${stderr}\n${stdout}`);
	}
	return JSON.parse(fs.readFileSync(reportPath, "utf8")) as Report;
}

function layout(dotenv: string) {
	const project = makeTemp("gjc-hook-proj-");
	const out = makeTemp("gjc-hook-out-");
	const projectBash = path.join(project, "evil.sh");
	const projectZdot = path.join(project, "zdot");
	const ranBash = path.join(project, "ran-bash");
	const ranZsh = path.join(project, "ran-zsh");
	writeScript(projectBash, ranBash);
	writeScript(path.join(projectZdot, ".zshenv"), ranZsh);
	fs.writeFileSync(
		path.join(project, ".env"),
		`BASH_ENV=${projectBash}\nZDOTDIR=${projectZdot}\nENV=${projectBash}\nUNRELATED_OK=kept-token\n${dotenv}`,
	);
	return { project, out, projectBash, projectZdot, ranBash, ranZsh };
}

function expectEmptyHooks(dump: Dump | null): void {
	expect(dump).not.toBeNull();
	expect(dump?.bash).toBe("");
	expect(dump?.zdot).toBe("");
	expect(dump?.env).toBe("");
	expect(dump?.unrelated).toBe("kept-token");
}

test.skipIf(!hasBash)(
	"project startup hooks stay out of status-line and finalize children",
	async () => {
		const { project, out, projectBash, projectZdot, ranBash, ranZsh } = layout("");
		const report = await runProbe(
			project,
			out,
			{},
			{
				PROBE_CACHE: "1",
				PROBE_CONCURRENT: "1",
				PROBE_NEIGHBOR: "1",
				PROBE_PROPERTY: "1",
			},
		);
		expect(report.before).toEqual({ bash: projectBash, zdot: projectZdot, env: projectBash });
		expect(report.after).toEqual(report.before);
		expect(fs.existsSync(ranBash)).toBe(false);
		expect(fs.existsSync(ranZsh)).toBe(false);
		expect(report.bashStatus.exitCode).toBe(0);
		expectEmptyHooks(report.bashStatus.dump);
		if (report.zsh) expectEmptyHooks(report.zsh.dump);
		expect(report.fin).toMatchObject({ pass: true, dump: { bash: "", zdot: "", env: "", unrelated: "kept-token" } });
		expectEmptyHooks(report.cachedDelete?.dump ?? null);
		expect(report.cachedDelete?.stderr ?? "").not.toContain("ran");
		expectEmptyHooks(report.cachedReplace?.dump ?? null);
		expect(report.concurrent?.[0].dump?.bash).toBe("");
		expect(report.concurrent?.[1].dump?.bash).toBe("");
		expect(report.caseNeighbor?.dump?.caseName).toBe("kept-case");
		expect(report.caseNeighbor?.dump?.bash).toBe("");
		expect(report.spaced?.dump?.env).toBe("  kept spaced  ");
		expect(report.trimmed?.dump?.bash).toBe("");
		expect(report.propertyRan).toBe(true);
	},
	90_000,
);

test.skipIf(!hasBash)(
	"keeps a caller startup value that differs from the project declaration",
	async () => {
		const { project, out } = layout("");
		const explicit = makeTemp("gjc-hook-explicit-");
		const explicitBash = path.join(explicit, "custom.sh");
		const explicitZdot = path.join(explicit, "zdot");
		writeScript(explicitBash, path.join(explicit, "ran-bash"));
		writeScript(path.join(explicitZdot, ".zshenv"), path.join(explicit, "ran-zsh"));
		const report = await runProbe(
			project,
			out,
			{},
			{
				PROBE_EXPLICIT_BASH: explicitBash,
				PROBE_EXPLICIT_ENV: explicitBash,
				PROBE_EXPLICIT_ZDOT: explicitZdot,
			},
		);
		expect(report.explicit?.exitCode).toBe(0);
		expect(report.explicit?.dump).toEqual({
			bash: explicitBash,
			zdot: explicitZdot,
			env: explicitBash,
			unrelated: "kept-token",
			caseName: "",
		});
		expect(report.after.bash).not.toBe(explicitBash);
	},
	60_000,
);

test.skipIf(!hasBash)(
	"keeps an exported shell startup value that differs from the project",
	async () => {
		const { project, out, projectBash, ranBash } = layout("");
		const safe = makeTemp("gjc-hook-safe-");
		const safeBash = path.join(safe, "keep.sh");
		const safeZdot = path.join(safe, "zdot");
		const ranSafe = path.join(safe, "ran-bash");
		writeScript(safeBash, ranSafe);
		writeScript(path.join(safeZdot, ".zshenv"), path.join(safe, "ran-zsh"));
		const report = await runProbe(
			project,
			out,
			{ BASH_ENV: safeBash, ZDOTDIR: safeZdot, ENV: safeBash },
			{ PROBE_CACHE: "1" },
		);
		expect(report.before.bash).toBe(safeBash);
		expect(report.after.bash).toBe(safeBash);
		expect(fs.existsSync(ranBash)).toBe(false);
		expect(fs.existsSync(ranSafe)).toBe(true);
		expect(report.bashStatus.dump?.bash).toBe(safeBash);
		expect(report.bashStatus.dump?.zdot).toBe(safeZdot);
		expect(report.bashStatus.dump?.unrelated).toBe("kept-token");
		expect(report.cachedDelete?.dump?.bash).toBe(safeBash);
		expect(report.cachedReplace?.dump?.bash).toBe(safeBash);
		expect(projectBash).not.toBe(safeBash);
		if (!("error" in report.fin)) expect(report.fin.dump?.bash).toBe(safeBash);
	},
	60_000,
);

test.skipIf(!hasBash)(
	"a startup value equal to the project declaration is not passed",
	async () => {
		const project = makeTemp("gjc-hook-eq-");
		const out = makeTemp("gjc-hook-out-");
		const hook = path.join(project, "same.sh");
		const zdot = path.join(project, "zdot");
		const ranBash = path.join(project, "ran-bash");
		writeScript(hook, ranBash);
		writeScript(path.join(zdot, ".zshenv"), path.join(project, "ran-zsh"));
		fs.writeFileSync(
			path.join(project, ".env"),
			`BASH_ENV=${hook}\nZDOTDIR=${zdot}\nENV=${hook}\nUNRELATED_OK=kept-token\n`,
		);
		const report = await runProbe(project, out, { BASH_ENV: hook, ZDOTDIR: zdot, ENV: hook }, { PROBE_CACHE: "1" });
		expect(fs.existsSync(ranBash)).toBe(false);
		expectEmptyHooks(report.bashStatus.dump);
		expectEmptyHooks(report.cachedDelete?.dump ?? null);
		expect(report.after.bash).toBe(hook);
		if (!("error" in report.fin)) expect(report.fin.dump?.bash).toBe("");
	},
	60_000,
);

test.skipIf(!hasBash)(
	"a dynamic project startup declaration is not passed to children",
	async () => {
		const home = makeTemp("gjc-hook-dyn-home-");
		const project = makeTemp("gjc-hook-dyn-");
		const out = makeTemp("gjc-hook-out-");
		const hook = path.join(home, "dyn-evil.sh");
		const zdot = path.join(home, "dyn-zdot");
		const ranBash = path.join(project, "ran-bash");
		writeScript(hook, ranBash);
		writeScript(path.join(zdot, ".zshenv"), path.join(project, "ran-zsh"));
		fs.writeFileSync(
			path.join(project, ".env"),
			"BASH_ENV=$HOME/dyn-evil.sh\nZDOTDIR=$HOME/dyn-zdot\nENV=$HOME/dyn-evil.sh\nUNRELATED_OK=kept-token\n",
		);
		const report = await runProbe(project, out, { HOME: home, USERPROFILE: home }, { PROBE_CACHE: "1" });
		expect(report.before.bash).toBe(hook);
		expect(report.after.bash).toBe(hook);
		expect(fs.existsSync(ranBash)).toBe(false);
		expectEmptyHooks(report.bashStatus.dump);
		expectEmptyHooks(report.cachedDelete?.dump ?? null);
		expectEmptyHooks(report.cachedReplace?.dump ?? null);
	},
	60_000,
);
