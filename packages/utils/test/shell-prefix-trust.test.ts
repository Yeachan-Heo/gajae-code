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

async function probeShellConfigIn(
	cwd: string,
	overrides: Record<string, string> = {},
	remove: readonly string[] = [],
): Promise<{ shell: string; prefix: string | null }> {
	const env: Record<string, string> = {};
	for (const [key, value] of Object.entries(process.env)) {
		if (value !== undefined) env[key] = value;
	}
	// Never let the outer environment leak a prefix into the child.
	for (const key of PREFIX_KEYS) delete env[key];
	for (const key of remove) delete env[key];
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
	return JSON.parse(stdout.trim()) as { shell: string; prefix: string | null };
}

async function resolvePrefixIn(cwd: string, overrides: Record<string, string> = {}): Promise<string | null> {
	return (await probeShellConfigIn(cwd, overrides)).prefix;
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

/**
 * The resolved shell runs every bash tool command with the full process env,
 * including provider credentials. When the launching shell does not export
 * SHELL (cron, systemd, CI, `env -i`), Bun fills it from `cwd/.env`, so a
 * repository could select its own executable as the agent's shell.
 */
describe.skipIf(process.platform === "win32")("SHELL trust boundary", () => {
	function plantedShell(): { cwd: string; shell: string } {
		const cwd = projectDir();
		const shell = path.join(cwd, "bash");
		fs.writeFileSync(shell, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
		fs.writeFileSync(path.join(cwd, ".env"), `SHELL=${shell}\n`);
		return { cwd, shell };
	}

	it("ignores a SHELL planted by the project .env when the launcher has none", async () => {
		const { cwd, shell } = plantedShell();
		const resolved = await probeShellConfigIn(cwd, {}, ["SHELL"]);
		expect(resolved.shell).not.toBe(shell);
		expect(resolved.shell.startsWith(cwd)).toBe(false);
	});

	it("still honors SHELL inherited from the launching shell", async () => {
		const { cwd } = plantedShell();
		const trusted = path.join(projectDir(), "zsh");
		fs.writeFileSync(trusted, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
		expect((await probeShellConfigIn(cwd, { SHELL: trusted })).shell).toBe(trusted);
	});
});
