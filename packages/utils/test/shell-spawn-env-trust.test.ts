import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

/**
 * Every bash tool command runs with `getShellConfig().env`. bash sources
 * `BASH_ENV` before each non-interactive command, and git applies
 * `GIT_CONFIG_*` (for example `core.fsmonitor`, which git executes during
 * `git status`). A repository `.env` reaches that env through Bun's dotenv
 * autoload or the env module's own overlay, so without a boundary any command —
 * even a restricted role agent's allowlisted `git status` — would run
 * repository code. Both load paths are exercised.
 */

const PROBE = path.join(import.meta.dir, "fixtures", "shell-spawn-env-probe.ts");
const HOOK_KEYS = [
	"BASH_ENV",
	"ENV",
	"GIT_EXTERNAL_DIFF",
	"GIT_CONFIG_COUNT",
	"GIT_CONFIG_KEY_0",
	"GIT_CONFIG_VALUE_0",
	"GIT_CONFIG_PARAMETERS",
	"UNRELATED_PROJECT_VAR",
] as const;
type Probe = Record<(typeof HOOK_KEYS)[number], string | null>;

const tempDirs: string[] = [];

function tempDir(dotenv?: string): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gjc-spawn-env-trust-"));
	tempDirs.push(dir);
	if (dotenv !== undefined) fs.writeFileSync(path.join(dir, ".env"), dotenv);
	return dir;
}

afterEach(() => {
	for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

async function probeIn(cwd: string, autoload: boolean, inherited: Record<string, string> = {}): Promise<Probe> {
	const env: Record<string, string> = {};
	for (const [key, value] of Object.entries(process.env)) {
		if (value !== undefined) env[key] = value;
	}
	for (const key of HOOK_KEYS) delete env[key];
	// Keep user-owned env files (agent `.env`, `~/.env`, shell rc) out of the result.
	env.HOME = tempDir();
	env.GJC_CODING_AGENT_DIR = tempDir();
	Object.assign(env, inherited);

	const args = autoload ? [PROBE] : ["--no-env-file", PROBE];
	const proc = Bun.spawn([process.execPath, ...args], { cwd, env, stdout: "pipe", stderr: "pipe" });
	const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
	const exitCode = await proc.exited;
	if (exitCode !== 0) throw new Error(`probe failed (${exitCode}): ${stderr}`);
	return JSON.parse(stdout.trim()) as Probe;
}

const PLANTED = [
	"BASH_ENV=./hook.sh",
	"ENV=./hook.sh",
	"GIT_EXTERNAL_DIFF=./hook.sh",
	"GIT_CONFIG_COUNT=1",
	"GIT_CONFIG_KEY_0=core.fsmonitor",
	"GIT_CONFIG_VALUE_0=./hook.sh",
	"GIT_CONFIG_PARAMETERS='core.fsmonitor=./hook.sh'",
	"UNRELATED_PROJECT_VAR=kept",
	"",
].join("\n");

describe.each([
	["Bun dotenv autoload", true],
	["no dotenv autoload", false],
] as const)("bash spawn env hook variables (%s)", (_label, autoload) => {
	it("drops shell and git hook variables declared by the project .env", async () => {
		const probe = await probeIn(tempDir(PLANTED), autoload);
		expect(probe).toEqual({
			BASH_ENV: null,
			ENV: null,
			GIT_EXTERNAL_DIFF: null,
			GIT_CONFIG_COUNT: null,
			GIT_CONFIG_KEY_0: null,
			GIT_CONFIG_VALUE_0: null,
			GIT_CONFIG_PARAMETERS: null,
			// Ordinary project variables still reach commands.
			UNRELATED_PROJECT_VAR: "kept",
		});
	});

	it("drops a dynamic project declaration", async () => {
		const probe = await probeIn(tempDir("HOOK=./hook.sh\nBASH_ENV=$HOOK\n"), autoload);
		expect(probe.BASH_ENV).toBeNull();
	});

	it("keeps hook variables inherited from the launching shell", async () => {
		const probe = await probeIn(tempDir(), autoload, { BASH_ENV: "/opt/operator/bashenv", GIT_CONFIG_COUNT: "0" });
		expect(probe.BASH_ENV).toBe("/opt/operator/bashenv");
		expect(probe.GIT_CONFIG_COUNT).toBe("0");
	});

	it("does not let the project .env replace an inherited value", async () => {
		const probe = await probeIn(tempDir("BASH_ENV=./hook.sh\n"), autoload, { BASH_ENV: "/opt/operator/bashenv" });
		expect(probe.BASH_ENV).toBe("/opt/operator/bashenv");
	});
});
