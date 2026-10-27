import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { pathToFileURL } from "node:url";

/**
 * `$credentialEnv` used to treat the home directory as distinct from cwd when
 * `path.resolve` strings differed. That loads the checkout `.env` and shell
 * startup files as trusted credentials. These tests go through `$credentialEnv`
 * and `getShellConfig`.
 */

const envSourceUrl = pathToFileURL(path.resolve(import.meta.dir, "../src/env.ts")).href;
const shellSourceUrl = pathToFileURL(path.resolve(import.meta.dir, "../src/shell-config.ts")).href;

const tempDirs: string[] = [];
const tempLinks: string[] = [];

function rememberDir(dir: string): string {
	tempDirs.push(dir);
	return dir;
}

afterEach(() => {
	for (const link of tempLinks.splice(0)) {
		try {
			fs.unlinkSync(link);
		} catch {}
	}
	for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

/** A second spelling of `dir` whose `path.resolve` text differs but names the same directory. */
function otherSpelling(dir: string): string | undefined {
	const resolved = path.resolve(dir);
	let real = resolved;
	try {
		real = fs.realpathSync(dir);
	} catch {
		return undefined;
	}
	if (path.resolve(real) !== resolved) return real;
	if (real.startsWith("/private/")) {
		const stripped = real.slice("/private".length);
		try {
			if (fs.realpathSync(stripped) === real && path.resolve(stripped) !== resolved) return stripped;
		} catch {}
	}
	const link = path.join(path.dirname(resolved), `${path.basename(resolved)}-link`);
	try {
		fs.symlinkSync(resolved, link);
		tempLinks.push(link);
	} catch {
		return undefined;
	}
	return path.resolve(link) !== resolved ? link : undefined;
}

function makeHome(): { home: string; other: string } | undefined {
	const parent = process.platform !== "win32" && fs.existsSync("/tmp") ? "/tmp" : os.tmpdir();
	const home = rememberDir(fs.mkdtempSync(path.join(parent, "gjc-cred-home-")));
	const other = otherSpelling(home);
	if (other === undefined) return undefined;
	return { home, other };
}

const alternateSpellingAvailable = (() => {
	if (process.platform === "win32") return false;
	const home = makeHome();
	return home !== undefined && path.resolve(home.home) !== path.resolve(home.other);
})();

function writeHomeFiles(home: string, dotenv: string, shellRc: string): void {
	fs.writeFileSync(path.join(home, ".env"), dotenv);
	fs.writeFileSync(path.join(home, ".zshrc"), shellRc);
}

function writeDecoyShell(home: string): string {
	const decoy = path.join(home, "zsh");
	fs.writeFileSync(decoy, "#!/bin/sh\nexit 0\n");
	fs.chmodSync(decoy, 0o755);
	return decoy;
}

function childEnv(home: string, extra: Record<string, string> = {}): Record<string, string> {
	const env: Record<string, string> = {};
	for (const [key, value] of Object.entries(process.env)) {
		if (value !== undefined) env[key] = value;
	}
	delete env.SHELL;
	delete env.PLANTED_HOME_CREDENTIAL;
	delete env.PLANTED_SHELL_CREDENTIAL;
	delete env.GJC_CONFIG_DIR;
	delete env.PI_CONFIG_DIR;
	delete env.GJC_CODING_AGENT_DIR;
	delete env.PI_CODING_AGENT_DIR;
	env.HOME = home;
	if (process.platform === "win32") env.USERPROFILE = home;
	env.GJC_CODING_AGENT_DIR = rememberDir(fs.mkdtempSync(path.join(os.tmpdir(), "gjc-cred-agent-")));
	Object.assign(env, extra);
	return env;
}

function probe(
	cwd: string,
	env: Record<string, string>,
): { cred: string | null; shellCred: string | null; shell: string } {
	const scriptPath = path.join(cwd, "credential-home-probe.ts");
	fs.writeFileSync(
		scriptPath,
		`import { $credentialEnv } from ${JSON.stringify(envSourceUrl)};
import { getShellConfig } from ${JSON.stringify(shellSourceUrl)};
const cred = $credentialEnv("PLANTED_HOME_CREDENTIAL") ?? null;
const shellCred = $credentialEnv("PLANTED_SHELL_CREDENTIAL") ?? null;
const shell = getShellConfig().shell;
console.log(JSON.stringify({ cred, shellCred, shell }));
`,
	);
	const result = Bun.spawnSync({
		cmd: [process.execPath, scriptPath],
		cwd,
		env,
		stdout: "pipe",
		stderr: "pipe",
	});
	const stdout = new TextDecoder().decode(result.stdout).trim();
	if (result.exitCode !== 0 || !stdout) {
		const stderr = new TextDecoder().decode(result.stderr).trim();
		throw new Error(stderr || stdout || `probe exited ${result.exitCode}`);
	}
	return JSON.parse(stdout) as { cred: string | null; shellCred: string | null; shell: string };
}

describe("credential home identity", () => {
	it.skipIf(!alternateSpellingAvailable)(
		"refuses a home dotenv and shell startup credential when cwd is another spelling of that home",
		() => {
			const spellings = makeHome();
			expect(spellings).toBeDefined();
			if (!spellings) throw new Error("alternate spelling disappeared");
			const decoy = writeDecoyShell(spellings.home);
			writeHomeFiles(
				spellings.home,
				`PLANTED_HOME_CREDENTIAL=from-home-dotenv\nSHELL=${decoy}\n`,
				"export PLANTED_SHELL_CREDENTIAL=from-home-zshrc\n",
			);
			const result = probe(spellings.other, childEnv(spellings.home));
			expect(result.cred).toBeNull();
			expect(result.shellCred).toBeNull();
			expect(result.shell).not.toBe(decoy);
		},
	);

	it("refuses a home dotenv credential when the cwd spelling is that home", () => {
		const home = rememberDir(fs.mkdtempSync(path.join(os.tmpdir(), "gjc-cred-home-")));
		writeHomeFiles(home, "PLANTED_HOME_CREDENTIAL=from-home-dotenv\n", "");
		const result = probe(home, childEnv(home));
		expect(result.cred).toBeNull();
	});

	it("refuses a shell startup credential when the cwd spelling is that home", () => {
		const home = rememberDir(fs.mkdtempSync(path.join(os.tmpdir(), "gjc-cred-home-")));
		writeHomeFiles(home, "", "export PLANTED_SHELL_CREDENTIAL=from-home-zshrc\n");
		const result = probe(home, childEnv(home));
		expect(result.shellCred).toBeNull();
	});

	it("still allows a home dotenv and shell startup credential when cwd is a different directory", () => {
		const home = rememberDir(fs.mkdtempSync(path.join(os.tmpdir(), "gjc-cred-home-")));
		const cwd = rememberDir(fs.mkdtempSync(path.join(os.tmpdir(), "gjc-cred-cwd-")));
		writeHomeFiles(
			home,
			"PLANTED_HOME_CREDENTIAL=from-home-dotenv\n",
			"export PLANTED_SHELL_CREDENTIAL=from-home-zshrc\n",
		);
		fs.writeFileSync(path.join(cwd, ".env"), "PLANTED_HOME_CREDENTIAL=from-project\n");
		const result = probe(cwd, childEnv(home));
		expect(result.cred).toBe("from-home-dotenv");
		expect(result.shellCred).toBe("from-home-zshrc");
	});

	it.skipIf(!alternateSpellingAvailable)(
		"still allows an operator environment credential when cwd is another spelling of home",
		() => {
			const spellings = makeHome();
			expect(spellings).toBeDefined();
			if (!spellings) throw new Error("alternate spelling disappeared");
			writeHomeFiles(spellings.home, "PLANTED_HOME_CREDENTIAL=from-home-dotenv\n", "");
			const result = probe(spellings.other, childEnv(spellings.home, { PLANTED_HOME_CREDENTIAL: "from-operator" }));
			expect(result.cred).toBe("from-operator");
		},
	);
});
