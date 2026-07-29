import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

/**
 * External credential discovery reads `CLAUDE_CONFIG_DIR` and `CODEX_HOME` so an
 * account switcher that relocates Claude Code / Codex CLI is the account gjc
 * imports. `Bun.env === process.env` and the env module merges the caller's
 * `cwd/.env` into it, so without a trust boundary a repository could point
 * discovery at a credential file it ships and have gjc import it as the user's
 * own account.
 *
 * `projectEnv` is parsed at module load from `process.cwd()`, so these drive a
 * child process with a controlled cwd.
 */

const PROBE = path.join(import.meta.dir, "fixtures", "credential-import-root-probe.ts");
const KEYS = ["CLAUDE_CONFIG_DIR", "CODEX_HOME"] as const;

const CLAUDE_SOURCE_DEFAULT = "Claude Code (~/.claude/.credentials.json)";
const CLAUDE_SOURCE_REDIRECTED = "Claude Code ($CLAUDE_CONFIG_DIR/.credentials.json)";
const CODEX_SOURCE_DEFAULT = "Codex CLI (~/.codex/auth.json)";
const CODEX_SOURCE_REDIRECTED = "Codex CLI ($CODEX_HOME/auth.json)";

interface Resolved {
	sources: string[];
	skipped: string[];
}

const tempDirs: string[] = [];

function tempDir(): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gjc-cred-root-trust-"));
	tempDirs.push(dir);
	return dir;
}

function claudeCredentials(account: string): string {
	return JSON.stringify({
		claudeAiOauth: {
			accessToken: `sk-ant-oat01-${account}-access-token`,
			refreshToken: `sk-ant-ort01-${account}-refresh-token`,
			expiresAt: Date.now() + 3_600_000,
		},
	});
}

function codexAuth(account: string): string {
	const payload = Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 3600 })).toString("base64url");
	const header = Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString("base64url");
	return JSON.stringify({
		tokens: {
			access_token: `${header}.${payload}.synthetic`,
			refresh_token: `codex-${account}-refresh-token-1234567890`,
			account_id: `acct-${account}`,
		},
	});
}

/** A credential root the probe imports from when discovery is pointed at it. */
function credentialRoot(account: string): string {
	const dir = tempDir();
	fs.writeFileSync(path.join(dir, ".credentials.json"), claudeCredentials(account));
	fs.writeFileSync(path.join(dir, "auth.json"), codexAuth(account));
	return dir;
}

/** A home directory holding the default `~/.claude` and `~/.codex` accounts. */
function homeWithDefaults(): string {
	const dir = tempDir();
	fs.mkdirSync(path.join(dir, ".claude"));
	fs.mkdirSync(path.join(dir, ".codex"));
	fs.writeFileSync(path.join(dir, ".claude", ".credentials.json"), claudeCredentials("home"));
	fs.writeFileSync(path.join(dir, ".codex", "auth.json"), codexAuth("home"));
	return dir;
}

function projectDir(dotenv?: string): string {
	const dir = tempDir();
	if (dotenv !== undefined) fs.writeFileSync(path.join(dir, ".env"), dotenv);
	return dir;
}

afterEach(() => {
	for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

async function discoverIn(cwd: string, homeDir: string, overrides: Record<string, string> = {}): Promise<Resolved> {
	const env: Record<string, string> = {};
	for (const [key, value] of Object.entries(process.env)) {
		if (value !== undefined) env[key] = value;
	}
	for (const key of KEYS) delete env[key];
	// `$credentialEnv` also consults the agent `.env`, the GJC config `.env`,
	// `~/.env` and the login shell rc files; keep all of them neutral.
	env.HOME = tempDir();
	env.GJC_CODING_AGENT_DIR = tempDir();
	env.GJC_PROBE_HOME_DIR = homeDir;
	Object.assign(env, overrides);

	const proc = Bun.spawn([process.execPath, PROBE], { cwd, env, stdout: "pipe", stderr: "pipe" });
	const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
	const exitCode = await proc.exited;
	if (exitCode !== 0) throw new Error(`probe failed (${exitCode}): ${stderr}`);
	return JSON.parse(stdout.trim()) as Resolved;
}

// Each case spawns a Bun process that loads the credential-import module graph,
// which is well past the 5s default when the suite runs alongside other files.
const PROBE_TIMEOUT_MS = 30_000;

describe("external credential root trust boundary", () => {
	it(
		"imports the home-directory accounts when nothing redirects discovery",
		async () => {
			const resolved = await discoverIn(projectDir(), homeWithDefaults());
			expect(resolved.sources).toEqual([CLAUDE_SOURCE_DEFAULT, CODEX_SOURCE_DEFAULT]);
		},
		PROBE_TIMEOUT_MS,
	);

	it(
		"ignores roots planted by the project .env",
		async () => {
			const planted = credentialRoot("attacker");
			const resolved = await discoverIn(
				projectDir(`CLAUDE_CONFIG_DIR=${planted}\nCODEX_HOME=${planted}\n`),
				homeWithDefaults(),
			);
			expect(resolved.sources).toEqual([CLAUDE_SOURCE_DEFAULT, CODEX_SOURCE_DEFAULT]);
		},
		PROBE_TIMEOUT_MS,
	);

	it(
		"honors roots inherited from the launching shell",
		async () => {
			const selected = credentialRoot("selected");
			const resolved = await discoverIn(projectDir(), homeWithDefaults(), {
				CLAUDE_CONFIG_DIR: selected,
				CODEX_HOME: selected,
			});
			expect(resolved.sources).toEqual([CLAUDE_SOURCE_REDIRECTED, CODEX_SOURCE_REDIRECTED]);
		},
		PROBE_TIMEOUT_MS,
	);

	it(
		"does not let the project .env override an inherited root",
		async () => {
			const selected = credentialRoot("selected");
			const planted = credentialRoot("attacker");
			const resolved = await discoverIn(
				projectDir(`CLAUDE_CONFIG_DIR=${planted}\nCODEX_HOME=${planted}\n`),
				homeWithDefaults(),
				{ CLAUDE_CONFIG_DIR: selected, CODEX_HOME: selected },
			);
			expect(resolved.sources).toEqual([CLAUDE_SOURCE_REDIRECTED, CODEX_SOURCE_REDIRECTED]);
			expect(resolved.skipped).toEqual([]);
		},
		PROBE_TIMEOUT_MS,
	);

	it(
		"falls back to the home default for a relative inherited root",
		async () => {
			const home = homeWithDefaults();
			// Relative values resolve against the project cwd for the external CLIs,
			// which would reintroduce the project-controlled redirect.
			const cwd = projectDir();
			fs.mkdirSync(path.join(cwd, "shipped"));
			fs.writeFileSync(path.join(cwd, "shipped", ".credentials.json"), claudeCredentials("attacker"));
			fs.writeFileSync(path.join(cwd, "shipped", "auth.json"), codexAuth("attacker"));
			const resolved = await discoverIn(cwd, home, {
				CLAUDE_CONFIG_DIR: "shipped",
				CODEX_HOME: "shipped",
			});
			expect(resolved.sources).toEqual([CLAUDE_SOURCE_DEFAULT, CODEX_SOURCE_DEFAULT]);
		},
		PROBE_TIMEOUT_MS,
	);
});
