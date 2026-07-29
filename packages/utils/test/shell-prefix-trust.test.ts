import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

/**
 * The shell prefix is interpolated ahead of every bash command
 * (`${prefix} ${command}`) and run through the shell, so whatever can set it can
 * execute arbitrary commands. `$env` merges the caller's `cwd/.env`, so without a
 * trust boundary a repository could plant `.env` and take over the agent's shell.
 *
 * `projectEnv` is parsed at module load from `process.cwd()`, so these drive a
 * child process with a controlled cwd.
 */

const PROBE = path.join(import.meta.dir, "fixtures", "shell-prefix-probe.ts");
const PREFIX_KEYS = ["PI_SHELL_PREFIX", "CLAUDE_CODE_SHELL_PREFIX"] as const;

const tempDirs: string[] = [];

function tempDir(): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gjc-trust-iso-"));
	tempDirs.push(dir);
	return dir;
}

function projectDir(dotenv?: string): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gjc-shell-prefix-trust-"));
	tempDirs.push(dir);
	if (dotenv !== undefined) fs.writeFileSync(path.join(dir, ".env"), dotenv);
	return dir;
}

afterEach(() => {
	for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

async function resolvePrefixIn(cwd: string, overrides: Record<string, string> = {}): Promise<string | null> {
	const env: Record<string, string> = {};
	for (const [key, value] of Object.entries(process.env)) {
		if (value !== undefined) env[key] = value;
	}
	// Never let the outer environment leak a prefix into the child.
	for (const key of PREFIX_KEYS) delete env[key];
	// `$credentialEnv` also consults file sources the child env cannot mask:
	// the agent `.env`, the GJC config `.env`, `~/.env` and the login shell rc
	// files. Point HOME and the agent dir at empty temp dirs so a contributor who
	// exports one of these names from a shell rc still sees a hermetic result.
	env.HOME = tempDir();
	env.GJC_CODING_AGENT_DIR = tempDir();
	Object.assign(env, overrides);

	const proc = Bun.spawn([process.execPath, PROBE], { cwd, env, stdout: "pipe", stderr: "pipe" });
	const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
	const exitCode = await proc.exited;
	if (exitCode !== 0) throw new Error(`probe failed (${exitCode}): ${stderr}`);
	return (JSON.parse(stdout.trim()) as { prefix: string | null }).prefix;
}

describe("shell prefix trust boundary", () => {
	it("resolves no prefix when nothing sets one", async () => {
		expect(await resolvePrefixIn(projectDir())).toBeNull();
	});

	it("ignores a shell prefix planted by the project .env", async () => {
		const cwd = projectDir("PI_SHELL_PREFIX=echo injected;\n");
		expect(await resolvePrefixIn(cwd)).toBeNull();
	});

	it("ignores the legacy CLAUDE_CODE_SHELL_PREFIX planted by the project .env", async () => {
		const cwd = projectDir("CLAUDE_CODE_SHELL_PREFIX=echo injected;\n");
		expect(await resolvePrefixIn(cwd)).toBeNull();
	});

	it("still honors a prefix inherited from the launching shell", async () => {
		const cwd = projectDir();
		expect(await resolvePrefixIn(cwd, { PI_SHELL_PREFIX: "trusted-wrapper" })).toBe("trusted-wrapper");
	});

	it("still honors the legacy alias from the launching shell", async () => {
		const cwd = projectDir();
		expect(await resolvePrefixIn(cwd, { CLAUDE_CODE_SHELL_PREFIX: "legacy-wrapper" })).toBe("legacy-wrapper");
	});

	it("does not let the project .env override an inherited prefix", async () => {
		const cwd = projectDir("PI_SHELL_PREFIX=echo injected;\n");
		expect(await resolvePrefixIn(cwd, { PI_SHELL_PREFIX: "trusted-wrapper" })).toBe("trusted-wrapper");
	});
});
