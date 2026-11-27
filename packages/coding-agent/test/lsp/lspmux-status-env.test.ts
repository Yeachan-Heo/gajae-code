import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

/**
 * `detectLspmux` probes `lspmux status` from a fresh process so the repository
 * `.env` loads the same way a checkout does. The stub records that child's
 * environment. Inherited values are entries passed in the parent environment.
 */

const PROBE = path.join(import.meta.dir, "..", "fixtures", "lspmux-status-env-probe.ts");
const HOOKS = ["BASH_ENV", "LD_PRELOAD", "NODE_OPTIONS"] as const;
const PYTHON = fs.existsSync("/usr/bin/python3") ? "/usr/bin/python3" : Bun.which("python3");
const PROJECT_DOTENV =
	"BASH_ENV=project-bash-hook\nLD_PRELOAD=project-ld-preload\nNODE_OPTIONS=--require project-node-hook\n";

const tempDirs: string[] = [];

function tempDir(): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gjc-lspmux-status-env-"));
	tempDirs.push(dir);
	return dir;
}

afterEach(() => {
	for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

interface ChildEnv {
	available: boolean;
	running: boolean;
	env: Record<string, string | null>;
}

function writeStub(binDir: string, reportPath: string): void {
	if (!PYTHON) throw new Error("python3 is required for the status stub");
	fs.mkdirSync(binDir, { recursive: true });
	const stub = path.join(binDir, "lspmux");
	const keys = JSON.stringify([...HOOKS, "KEEP_FROM_SHELL"]);
	fs.writeFileSync(
		stub,
		`#!${PYTHON}\nimport json, os\nkeys = ${keys}\nopen(${JSON.stringify(reportPath)}, "w").write(json.dumps({k: os.environ.get(k) for k in keys}))\n`,
	);
	fs.chmodSync(stub, 0o755);
}

async function probe(inherited: Record<string, string>): Promise<ChildEnv> {
	const root = tempDir();
	const repo = path.join(root, "repo");
	const binDir = path.join(root, "bin");
	const home = path.join(root, "home");
	const reportPath = path.join(root, "child-env.json");
	fs.mkdirSync(path.join(repo, ".git"), { recursive: true });
	fs.mkdirSync(home, { recursive: true });
	fs.writeFileSync(path.join(repo, ".env"), PROJECT_DOTENV);
	writeStub(binDir, reportPath);

	const env: Record<string, string> = {};
	for (const [key, value] of Object.entries(process.env)) {
		if (value !== undefined) env[key] = value;
	}
	for (const key of HOOKS) delete env[key];
	delete env.GJC_DISABLE_LSPMUX;
	delete env.PI_DISABLE_LSPMUX;
	delete env.XDG_CONFIG_HOME;
	env.HOME = home;
	env.USERPROFILE = home;
	env.KEEP_FROM_SHELL = "operator-export";
	env.PATH = [binDir, env.PATH ?? "/usr/bin:/bin"].join(path.delimiter);
	Object.assign(env, inherited);

	const proc = Bun.spawn([process.execPath, PROBE], { cwd: repo, env, stdout: "pipe", stderr: "pipe" });
	const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
	const exitCode = await proc.exited;
	if (exitCode !== 0) throw new Error(`probe failed (${exitCode}): ${stderr}\n${stdout}`);
	const line = stdout.trim().split("\n").at(-1) ?? "";
	const state = JSON.parse(line) as { available: boolean; running: boolean };
	if (!fs.existsSync(reportPath)) {
		throw new Error(
			`status child wrote no env report state=${JSON.stringify(state)} stderr=${stderr} stdout=${stdout}`,
		);
	}
	return { ...state, env: JSON.parse(fs.readFileSync(reportPath, "utf8")) as Record<string, string | null> };
}

describe.skipIf(process.platform === "win32" || !PYTHON)("lspmux status probe child env", () => {
	it("drops project dotenv hook variables from the status child", async () => {
		const result = await probe({});
		expect(result.available).toBe(true);
		expect(result.running).toBe(true);
		expect(result.env.BASH_ENV ?? null).toBeNull();
		expect(result.env.LD_PRELOAD ?? null).toBeNull();
		expect(result.env.NODE_OPTIONS ?? null).toBeNull();
		expect(result.env.KEEP_FROM_SHELL).toBe("operator-export");
	});

	it("keeps a shell-exported value the project dotenv did not supply", async () => {
		const result = await probe({ BASH_ENV: "operator-bash" });
		expect(result.available).toBe(true);
		expect(result.running).toBe(true);
		expect(result.env.BASH_ENV).toBe("operator-bash");
		expect(result.env.KEEP_FROM_SHELL).toBe("operator-export");
	});

	it("drops a shell hook value that repeats the project dotenv declaration", async () => {
		const result = await probe({
			BASH_ENV: "project-bash-hook",
			LD_PRELOAD: "project-ld-preload",
			NODE_OPTIONS: "--require project-node-hook",
		});
		expect(result.available).toBe(true);
		expect(result.running).toBe(true);
		expect(result.env.BASH_ENV ?? null).toBeNull();
		expect(result.env.LD_PRELOAD ?? null).toBeNull();
		expect(result.env.NODE_OPTIONS ?? null).toBeNull();
		expect(result.env.KEEP_FROM_SHELL).toBe("operator-export");
	});
});
