/**
 * G004: managed per-workspace venv resolution.
 *
 * Verifies BYO (VIRTUAL_ENV / .venv) precedence and, absent a BYO env, that gjc
 * auto-creates and uses a per-workspace venv under <cwd>/.gjc/python-env, with a
 * sys.executable assertion proving the kernel interpreter is the managed one.
 * Uses no network: the managed env is created with `python -m venv` and seeded
 * with an empty package set.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { ensurePythonRuntime } from "@gajae-code/coding-agent/eval/py/runtime";

const PYTHON = Bun.which("python3") ?? Bun.which("python");
const NO_AMBIENT_VENV = !process.env.VIRTUAL_ENV && !process.env.CONDA_PREFIX;
const RUN = Boolean(PYTHON) && NO_AMBIENT_VENV;

let cwd: string;

beforeEach(async () => {
	cwd = await fs.mkdtemp(path.join(os.tmpdir(), "rlm-venv-"));
});

afterEach(async () => {
	await fs.rm(cwd, { recursive: true, force: true });
});

const baseEnv = (): Record<string, string | undefined> => ({ PATH: process.env.PATH, HOME: process.env.HOME });

async function createVenv(target: string): Promise<void> {
	const proc = Bun.spawn([PYTHON as string, "-m", "venv", target], { stdout: "pipe", stderr: "pipe" });
	const code = await proc.exited;
	if (code !== 0) throw new Error(`venv create failed (${code}): ${await new Response(proc.stderr).text()}`);
}

describe.skipIf(!RUN)("RLM managed per-workspace venv", () => {
	test("auto-creates <cwd>/.gjc/python-env and the kernel interpreter is that venv", async () => {
		const runtime = await ensurePythonRuntime(cwd, baseEnv(), { managedWorkspaceVenv: true, seedPackages: [] });
		const managedDir = path.join(cwd, ".gjc", "python-env");

		expect(runtime.venvPath).toBe(managedDir);
		expect(runtime.pythonPath.startsWith(managedDir)).toBe(true);
		expect(await Bun.file(runtime.pythonPath).exists()).toBe(true);
		expect(runtime.env.VIRTUAL_ENV).toBe(managedDir);

		// sys.executable/prefix assertion: the resolved interpreter is rooted in the managed venv.
		const probe = Bun.spawnSync([runtime.pythonPath, "-c", "import sys; print(sys.prefix)"]);
		expect(probe.exitCode).toBe(0);
		const reportedPrefix = await fs.realpath(probe.stdout.toString().trim());
		const realManaged = await fs.realpath(managedDir);
		expect(reportedPrefix).toBe(realManaged);
	}, 120_000);

	test("honors a BYO .venv and does not create the managed env", async () => {
		const byo = path.join(cwd, ".venv");
		await createVenv(byo);

		const runtime = await ensurePythonRuntime(cwd, baseEnv(), { managedWorkspaceVenv: true, seedPackages: [] });
		expect(runtime.venvPath).toBe(byo);
		expect(runtime.pythonPath.startsWith(byo)).toBe(true);
		// The managed env was never provisioned because a BYO venv took precedence.
		expect(await Bun.file(path.join(cwd, ".gjc", "python-env")).exists()).toBe(false);
	}, 120_000);
});
