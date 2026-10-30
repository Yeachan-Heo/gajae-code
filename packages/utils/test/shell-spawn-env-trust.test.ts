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
	"BUN_OPTIONS",
	"PERLLIB",
	"_JAVA_OPTIONS",
	"NPM_CONFIG_NODE_OPTIONS",
	"RIPGREP_CONFIG_PATH",
	"TAR_OPTIONS",
	"RSYNC_RSH",
	"MAKEFLAGS",
	"MAKEFILES",
	"SHELLOPTS",
	"PS4",
	"NODE_OPTIONS",
	"PYTHONPATH",
	"PYTHONUSERBASE",
	"PYTHONSTARTUP",
	"PERL5OPT",
	"PERL5LIB",
	"JAVA_TOOL_OPTIONS",
	"JDK_JAVA_OPTIONS",
	"LD_PRELOAD",
	"LD_AUDIT",
	"LD_LIBRARY_PATH",
	"DYLD_LIBRARY_PATH",
	"GIT_ASKPASS",
	"SSH_ASKPASS",
	"GIT_EXEC_PATH",
	"GIT_PROXY_COMMAND",
	"GIT_SEQUENCE_EDITOR",
	"GIT_TEMPLATE_DIR",
	"ZDOTDIR",
	"ENV",
	"USERPROFILE",
	"HOMEDRIVE",
	"HOMEPATH",
	"XDG_CONFIG_HOME",
	"GIT_DIR",
	"GIT_COMMON_DIR",
	"GIT_SSH_COMMAND",
	"GIT_EXTERNAL_DIFF",
	"GIT_CONFIG_COUNT",
	"GIT_CONFIG_KEY_0",
	"GIT_CONFIG_VALUE_0",
	"GIT_CONFIG_PARAMETERS",
	"UNRELATED_PROJECT_VAR",
] as const;
type Probe = Record<
	(typeof HOOK_KEYS)[number] | "SHARED_XDG_CONFIG_HOME" | "HOME" | "TRUSTED_HOME" | "LIVE_BASH_ENV" | "HOME_OVERRIDE",
	string | null
> & {
	PROJECT_DYNAMIC_BASH_ENV: boolean;
	PROJECT_HAS_BASH_ENV_VALUE: boolean;
	NPM_NODE_OPTIONS_NAMES: string[];
};

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
	"GIT_ASKPASS=./hook.sh",
	"SSH_ASKPASS=./hook.sh",
	"GIT_EXEC_PATH=./git-exec",
	"GIT_PROXY_COMMAND=./proxy.sh",
	"GIT_SEQUENCE_EDITOR=./hook.sh",
	"GIT_TEMPLATE_DIR=./templates",
	"ZDOTDIR=./zdot",
	"ENV=./hook.sh",
	"USERPROFILE=./project-home",
	"HOMEDRIVE=project-drive",
	"HOMEPATH=project-home",
	"XDG_CONFIG_HOME=./xdg",
	"GIT_DIR=./evil-git",
	"GIT_COMMON_DIR=./evil-git",
	"GIT_SSH_COMMAND=./hook.sh",
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
		expect(probe).toMatchObject({
			BASH_ENV: null,
			GIT_ASKPASS: null,
			SSH_ASKPASS: null,
			GIT_EXEC_PATH: null,
			GIT_PROXY_COMMAND: null,
			GIT_SEQUENCE_EDITOR: null,
			GIT_TEMPLATE_DIR: null,
			ZDOTDIR: null,
			ENV: null,
			USERPROFILE: null,
			HOMEDRIVE: null,
			HOMEPATH: null,
			XDG_CONFIG_HOME: null,
			GIT_DIR: null,
			GIT_COMMON_DIR: null,
			GIT_SSH_COMMAND: null,
			GIT_EXTERNAL_DIFF: null,
			GIT_CONFIG_COUNT: null,
			GIT_CONFIG_KEY_0: null,
			GIT_CONFIG_VALUE_0: null,
			GIT_CONFIG_PARAMETERS: null,
			// Ordinary project variables still reach commands.
			UNRELATED_PROJECT_VAR: "kept",
			// The shared shell-config env (Python kernels) keeps documented XDG values.
			SHARED_XDG_CONFIG_HOME: "./xdg",
		});
	});

	it("drops project Windows home selectors and restores the trusted account home when available", async () => {
		const cwd = tempDir();
		const projectHome = path.join(cwd, "project-home");
		fs.writeFileSync(
			path.join(cwd, ".env"),
			`USERPROFILE=${projectHome}\nHOMEDRIVE=project-drive\nHOMEPATH=project-home\n`,
		);
		const probe = await probeIn(cwd, autoload, { HOME: "" });
		expect(probe.USERPROFILE).toBeNull();
		expect(probe.HOMEDRIVE).toBeNull();
		expect(probe.HOMEPATH).toBeNull();
		expect(probe.HOME).toBe(probe.TRUSTED_HOME);
		expect(probe.HOME_OVERRIDE).toBe(probe.TRUSTED_HOME);
		expect(probe.HOME).not.toBe(projectHome);
	});

	it("drops a dynamic project declaration", async () => {
		const probe = await probeIn(tempDir("HOOK=./hook.sh\nBASH_ENV=$HOOK\n"), autoload);
		expect(probe.BASH_ENV).toBeNull();
	});

	it("drops a dynamic-only hook declaration without a parsed value", async () => {
		const value = "./hook\r.sh";
		const probe = await probeIn(tempDir(`BASH_ENV=${value}\n`), autoload, { BASH_ENV: value });
		expect(probe).toMatchObject({
			LIVE_BASH_ENV: value,
			PROJECT_DYNAMIC_BASH_ENV: true,
			PROJECT_HAS_BASH_ENV_VALUE: false,
			BASH_ENV: null,
		});
	});

	it("keeps hook variables inherited from the launching shell", async () => {
		const probe = await probeIn(tempDir(), autoload, {
			BASH_ENV: "/opt/operator/bashenv",
			GIT_CONFIG_COUNT: "0",
			GIT_EXEC_PATH: "/opt/operator/git-exec",
			GIT_PROXY_COMMAND: "/opt/operator/proxy.sh",
			GIT_TEMPLATE_DIR: "/opt/operator/templates",
			USERPROFILE: "/opt/operator/profile",
			HOMEDRIVE: "C:",
			HOMEPATH: "\\Users\\operator",
		});
		expect(probe.BASH_ENV).toBe("/opt/operator/bashenv");
		expect(probe.GIT_CONFIG_COUNT).toBe("0");
		expect(probe.GIT_EXEC_PATH).toBe("/opt/operator/git-exec");
		expect(probe.GIT_PROXY_COMMAND).toBe("/opt/operator/proxy.sh");
		expect(probe.GIT_TEMPLATE_DIR).toBe("/opt/operator/templates");
		expect(probe.USERPROFILE).toBe("/opt/operator/profile");
		expect(probe.HOMEDRIVE).toBe("C:");
		expect(probe.HOMEPATH).toBe("\\Users\\operator");
	});

	it("does not let the project .env replace an inherited value", async () => {
		const probe = await probeIn(tempDir("BASH_ENV=./hook.sh\n"), autoload, { BASH_ENV: "/opt/operator/bashenv" });
		expect(probe.BASH_ENV).toBe("/opt/operator/bashenv");
	});

	// Bun does not expose which source supplied a value, so an inherited value
	// the project repeats verbatim, or a key the project declares dynamically,
	// is ambiguous. Like the credential snapshot (`$inheritedEnv`), these fail
	// closed: the hook variable is dropped rather than risk running project code.
	it("drops an inherited value the project .env repeats verbatim (ambiguous, fails closed)", async () => {
		const probe = await probeIn(tempDir("BASH_ENV=/opt/operator/bashenv\n"), autoload, {
			BASH_ENV: "/opt/operator/bashenv",
		});
		expect(probe.BASH_ENV).toBeNull();
	});

	it("drops an inherited value when the project .env declares the key dynamically (ambiguous, fails closed)", async () => {
		const probe = await probeIn(tempDir("HOOK=./hook.sh\nBASH_ENV=$HOOK\n"), autoload, {
			BASH_ENV: "/opt/operator/bashenv",
		});
		expect(probe.BASH_ENV).toBeNull();
	});
});

describe("bash spawn env Bun startup options", () => {
	it("drops a project BUN_OPTIONS declaration before a child Bun runtime starts", async () => {
		const probe = await probeIn(tempDir("BUN_OPTIONS=--preload=./project-preload.ts\n"), false);
		expect(probe.BUN_OPTIONS).toBeNull();
	});

	it("keeps a trusted inherited BUN_OPTIONS value when the project does not declare it", async () => {
		const probe = await probeIn(tempDir(), false, { BUN_OPTIONS: "--no-env-file" });
		expect(probe.BUN_OPTIONS).toBe("--no-env-file");
	});
});

describe("bash spawn env interpreter injection", () => {
	for (const autoload of [true, false]) {
		it(`drops project interpreter and loader declarations (autoload=${autoload})`, async () => {
			const probe = await probeIn(
				tempDir(
					"NODE_OPTIONS=--require ./r.js\nPYTHONPATH=.\nPYTHONUSERBASE=./userbase\nPYTHONSTARTUP=./startup.py\nJAVA_TOOL_OPTIONS=-javaagent:./agent.jar\nJDK_JAVA_OPTIONS=-javaagent:./agent.jar\nLD_PRELOAD=./planted.so\nLD_AUDIT=./audit.so\nLD_LIBRARY_PATH=./lib\nDYLD_LIBRARY_PATH=./lib\n",
				),
				autoload,
			);
			expect(probe).toMatchObject({
				NODE_OPTIONS: null,
				PYTHONPATH: null,
				PYTHONUSERBASE: null,
				PYTHONSTARTUP: null,
				JAVA_TOOL_OPTIONS: null,
				JDK_JAVA_OPTIONS: null,
				LD_PRELOAD: null,
				LD_AUDIT: null,
				LD_LIBRARY_PATH: null,
				DYLD_LIBRARY_PATH: null,
			});
		});
	}

	it("keeps interpreter variables the launching shell exported with a different value", async () => {
		const probe = await probeIn(
			tempDir(
				"NODE_OPTIONS=--require ./r.js\nPYTHONPATH=.\nPYTHONUSERBASE=./userbase\nPYTHONSTARTUP=./startup.py\nJAVA_TOOL_OPTIONS=-javaagent:./agent.jar\nJDK_JAVA_OPTIONS=-javaagent:./agent.jar\nLD_LIBRARY_PATH=./lib\n",
			),
			true,
			{
				NODE_OPTIONS: "--max-old-space-size=4096",
				PYTHONPATH: "/opt/operator/lib",
				PYTHONUSERBASE: "/opt/operator/python",
				PYTHONSTARTUP: "/opt/operator/startup.py",
				JAVA_TOOL_OPTIONS: "-XX:+UseContainerSupport",
				JDK_JAVA_OPTIONS: "-XX:+UseContainerSupport",
				LD_LIBRARY_PATH: "/opt/cuda/lib64",
			},
		);
		expect(probe).toMatchObject({
			NODE_OPTIONS: "--max-old-space-size=4096",
			PYTHONPATH: "/opt/operator/lib",
			PYTHONUSERBASE: "/opt/operator/python",
			PYTHONSTARTUP: "/opt/operator/startup.py",
			JAVA_TOOL_OPTIONS: "-XX:+UseContainerSupport",
			JDK_JAVA_OPTIONS: "-XX:+UseContainerSupport",
			LD_LIBRARY_PATH: "/opt/cuda/lib64",
		});
	});
});

describe("bash spawn env tool configuration programs", () => {
	for (const autoload of [true, false]) {
		it(`drops project tool-config and sibling injection declarations (autoload=${autoload})`, async () => {
			const probe = await probeIn(
				tempDir(
					[
						"PERLLIB=./lib",
						"_JAVA_OPTIONS=-javaagent:./a.jar",
						"NPM_CONFIG_NODE_OPTIONS=--require ./r.js",
						"RIPGREP_CONFIG_PATH=./rgconfig",
						"TAR_OPTIONS=--use-compress-program=./x.sh",
						"RSYNC_RSH=./x.sh",
						"MAKEFLAGS=SHELL=./x.sh",
						"MAKEFILES=./inc.mk",
						"SHELLOPTS=xtrace",
						"PS4='$(./x.sh)'",
						"",
					].join("\n"),
				),
				autoload,
			);
			expect(probe).toMatchObject({
				PERLLIB: null,
				_JAVA_OPTIONS: null,
				NPM_CONFIG_NODE_OPTIONS: null,
				RIPGREP_CONFIG_PATH: null,
				TAR_OPTIONS: null,
				RSYNC_RSH: null,
				MAKEFLAGS: null,
				MAKEFILES: null,
				SHELLOPTS: null,
				PS4: null,
			});
		});
	}

	// npm reads `npm_config_*` in any case and treats `-` like `_`, so every
	// spelling a dotenv file can declare must be dropped, not just the two
	// canonical ones.
	for (const name of [
		"npm_config_Node_Options",
		"Npm_Config_Node_Options",
		"npm_config_node-options",
		"npm_config_script_shell",
		"NPM_CONFIG_SCRIPT-SHELL",
	]) {
		for (const autoload of [true, false]) {
			it(`drops a project ${name} declaration (autoload=${autoload})`, async () => {
				const probe = await probeIn(tempDir(`${name}=./planted\n`), autoload);
				expect(probe.NPM_NODE_OPTIONS_NAMES).toEqual([]);
			});
		}
	}

	it("keeps tool configuration the launching shell exported", async () => {
		const probe = await probeIn(tempDir("RIPGREP_CONFIG_PATH=./rgconfig\nMAKEFLAGS=SHELL=./x.sh\n"), true, {
			RIPGREP_CONFIG_PATH: "/home/operator/.ripgreprc",
			MAKEFLAGS: "-j8",
		});
		expect(probe).toMatchObject({ RIPGREP_CONFIG_PATH: "/home/operator/.ripgreprc", MAKEFLAGS: "-j8" });
	});
});
