import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

/**
 * A project `.env` must not be able to make the bash tool run repository code.
 * git runs `core.fsmonitor` during `git status`, and that config can come from
 * `GIT_CONFIG_*`, `XDG_CONFIG_HOME/git/config`, or a `GIT_DIR` config; bash
 * sources `BASH_ENV` before every command. The non-PTY path spawns a chain of
 * Bun worker processes that each reload `cwd/.env`, and the PTY path inherits
 * the process environment, so the probe drives the real execution paths and
 * checks whether the planted hook actually ran.
 */

const PROBE = path.join(import.meta.dir, "fixtures", "bash-project-hook-probe.ts");
const HOOK_KEYS = [
	"BASH_ENV",
	"PERLLIB",
	"_JAVA_OPTIONS",
	"npm_config_node_options",
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
	"DYLD_INSERT_LIBRARIES",
	"BUN_OPTIONS",
	"GIT_ASKPASS",
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
	"GIT_CONFIG_COUNT",
	"GIT_CONFIG_KEY_0",
	"GIT_CONFIG_VALUE_0",
	"GIT_CONFIG_PARAMETERS",
];

const tempDirs: string[] = [];

function tempDir(): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gjc-bash-hook-"));
	tempDirs.push(dir);
	return dir;
}

afterEach(() => {
	for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

interface Project {
	cwd: string;
	marker: string;
	hook: string;
}

function project(dotenv: (project: Project) => string): Project {
	const cwd = tempDir();
	const marker = path.join(cwd, "hook-ran");
	const hook = path.join(cwd, "hook.sh");
	fs.writeFileSync(hook, `#!/bin/sh\necho ran >> "${marker}"\n`, { mode: 0o755 });
	const git = Bun.spawnSync(["git", "init", "-q", cwd]);
	if (git.exitCode !== 0) throw new Error(`git init failed: ${git.stderr.toString()}`);
	const result = { cwd, marker, hook };
	fs.writeFileSync(path.join(cwd, ".env"), dotenv(result));
	return result;
}

async function runProbe(
	target: Project,
	mode: "worker" | "pty" | "inprocess",
	inherited: Record<string, string> = {},
	disableDotenvAutoload = false,
): Promise<boolean> {
	const env: Record<string, string> = {};
	for (const [key, value] of Object.entries(process.env)) {
		if (value !== undefined) env[key] = value;
	}
	for (const key of HOOK_KEYS) delete env[key];
	delete env.GJC_TEST_DOTENV_AFTER_START;
	env.HOME = tempDir();
	env.GJC_CODING_AGENT_DIR = tempDir();
	Object.assign(env, inherited);
	// An empty override means "the launcher does not export this variable".
	for (const [key, value] of Object.entries(inherited)) if (value === "") delete env[key];

	fs.rmSync(target.marker, { force: true });
	const proc = Bun.spawn([process.execPath, ...(disableDotenvAutoload ? ["--no-env-file"] : []), PROBE, mode], {
		cwd: target.cwd,
		env,
		stdout: "pipe",
		stderr: "pipe",
	});
	const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
	const exitCode = await proc.exited;
	if (exitCode !== 0) throw new Error(`probe failed (${exitCode}): ${stderr}`);
	const lastLine = stdout.trim().split("\n").at(-1) ?? "";
	expect(JSON.parse(lastLine)).toEqual({ exitCode: 0, done: true });
	return fs.existsSync(target.marker);
}

const VECTORS: Record<string, (project: Project) => string> = {
	BUN_OPTIONS: ({ cwd, marker }) => {
		fs.writeFileSync(path.join(cwd, "project-preload.ts"), `await Bun.write(${JSON.stringify(marker)}, "ran");\n`);
		return "BUN_OPTIONS=--preload=./project-preload.ts\n";
	},
	GIT_CONFIG_: ({ hook }) => `GIT_CONFIG_COUNT=1\nGIT_CONFIG_KEY_0=core.fsmonitor\nGIT_CONFIG_VALUE_0=${hook}\n`,
	XDG_CONFIG_HOME: ({ cwd, hook }) => {
		fs.mkdirSync(path.join(cwd, "xdg", "git"), { recursive: true });
		fs.writeFileSync(path.join(cwd, "xdg", "git", "config"), `[core]\n\tfsmonitor = ${hook}\n`);
		return `XDG_CONFIG_HOME=${path.join(cwd, "xdg")}\n`;
	},
	GIT_DIR: ({ cwd, hook }) => {
		fs.appendFileSync(path.join(cwd, ".git", "config"), "");
		const evil = path.join(cwd, "evil-git");
		fs.cpSync(path.join(cwd, ".git"), evil, { recursive: true });
		fs.appendFileSync(path.join(evil, "config"), `[core]\n\tfsmonitor = ${hook}\n`);
		return `GIT_DIR=${evil}\n`;
	},
	BASH_ENV: ({ hook }) => `BASH_ENV=${hook}\n`,
	HOME: ({ cwd, hook }) => {
		const home = path.join(cwd, "planted-home");
		fs.mkdirSync(home, { recursive: true });
		fs.writeFileSync(path.join(home, ".gitconfig"), `[core]\n\tfsmonitor = ${hook}\n`);
		return `HOME=${home}\n`;
	},
};

/** Values a parent GJC forwards to a child session match the child's project `.env`. */
function forwarded(target: Project): Record<string, string> {
	const values: Record<string, string> = {};
	for (const line of fs.readFileSync(path.join(target.cwd, ".env"), "utf8").split("\n")) {
		const separator = line.indexOf("=");
		if (separator > 0) values[line.slice(0, separator)] = line.slice(separator + 1);
	}
	return values;
}

describe.skipIf(process.platform === "win32")("bash tool ignores project .env hook variables", () => {
	it("does not run a project BUN_OPTIONS preload before the isolated worker entrypoint", async () => {
		const target = project(VECTORS.BUN_OPTIONS!);
		expect(await runProbe(target, "worker", {}, true)).toBe(false);
	});

	// The isolated worker chain is Bun processes that each reload `cwd/.env`,
	// and the native shell imports the worker environment wholesale. (It already
	// skips BASH_ENV/ENV itself, so only git vectors reach this path.)
	for (const name of ["GIT_CONFIG_", "XDG_CONFIG_HOME", "GIT_DIR", "HOME"]) {
		it(`does not run a ${name} hook from the project .env (isolated worker)`, async () => {
			// HOME only reaches the shell from the project when the launcher has none.
			const inherited: Record<string, string> = name === "HOME" ? { HOME: "" } : {};
			expect(await runProbe(project(VECTORS[name]!), "worker", inherited)).toBe(false);
		});
	}

	it("does not reload a hook added to .env after startup in the source runtime", async () => {
		const target = project(() => "");
		const dotenv = `GIT_CONFIG_COUNT=1\nGIT_CONFIG_KEY_0=core.fsmonitor\nGIT_CONFIG_VALUE_0=${target.hook}\n`;
		expect(await runProbe(target, "worker", { GJC_TEST_DOTENV_AFTER_START: dotenv })).toBe(false);
	});

	// Interpreters the command starts load code named by the environment. Each
	// case plants the payload in the project and runs the interpreter from the
	// bash tool; skipped when the interpreter is not installed.
	const RUNTIME_VECTORS: { name: string; binary: string; command: string; plant: (project: Project) => string }[] = [
		{
			name: "NODE_OPTIONS",
			binary: "node",
			command: "node -e 0",
			plant: ({ cwd, marker }) => {
				fs.writeFileSync(
					path.join(cwd, "preload.cjs"),
					`require("fs").writeFileSync(${JSON.stringify(marker)}, "ran");\n`,
				);
				return `NODE_OPTIONS=--require ${path.join(cwd, "preload.cjs")}\n`;
			},
		},
		{
			name: "PYTHONPATH",
			binary: "python3",
			command: "python3 -c 0",
			plant: ({ cwd, marker }) => {
				fs.writeFileSync(path.join(cwd, "sitecustomize.py"), `open(${JSON.stringify(marker)}, "w").write("ran")\n`);
				return `PYTHONPATH=${cwd}\n`;
			},
		},
		{
			name: "PYTHONUSERBASE",
			binary: "python3",
			command: "python3 -c 0",
			plant: ({ cwd, marker }) => {
				const userBase = path.join(cwd, "userbase");
				const python = Bun.which("python3");
				if (!python) throw new Error("python3 is required to find the user site path");
				const site = Bun.spawnSync([python, "-c", "import site; print(site.USER_SITE)"], {
					cwd,
					env: { ...process.env, PYTHONUSERBASE: userBase, PYTHONPATH: undefined, PYTHONSTARTUP: undefined },
				});
				if (site.exitCode !== 0) throw new Error(`python3 failed: ${site.stderr.toString()}`);
				const userSite = site.stdout.toString().trim();
				if (!userSite || userSite === "None") throw new Error("python3 did not report a user site path");
				fs.mkdirSync(userSite, { recursive: true });
				fs.writeFileSync(
					path.join(userSite, "usercustomize.py"),
					`open(${JSON.stringify(marker)}, "w").write("ran")\n`,
				);
				return `PYTHONUSERBASE=${userBase}\n`;
			},
		},
		{
			name: "PERL5OPT",
			binary: "perl",
			command: "perl -e 0",
			plant: ({ cwd, marker }) => {
				fs.writeFileSync(
					path.join(cwd, "Planted.pm"),
					`open(my $f, ">", ${JSON.stringify(marker)}); print $f "ran"; 1;\n`,
				);
				return `PERL5OPT=-MPlanted\nPERL5LIB=${cwd}\n`;
			},
		},
		{
			name: "PERLLIB",
			binary: "perl",
			command: "perl -e 'use strict; 1'",
			plant: ({ cwd, marker }) => {
				const lib = path.join(cwd, "perllib");
				fs.mkdirSync(lib);
				fs.writeFileSync(
					path.join(lib, "strict.pm"),
					`open(my $f, ">", ${JSON.stringify(marker)}); close $f; package strict; sub import {} 1;\n`,
				);
				return `PERLLIB=${lib}\n`;
			},
		},
		{
			name: "RIPGREP_CONFIG_PATH",
			binary: "rg",
			command: "rg needle needle.txt",
			plant: ({ cwd, hook }) => {
				fs.writeFileSync(path.join(cwd, "needle.txt"), "needle\n");
				fs.writeFileSync(path.join(cwd, "rgconfig"), `--pre=${hook}\n`);
				return `RIPGREP_CONFIG_PATH=${path.join(cwd, "rgconfig")}\n`;
			},
		},
		{
			name: "TAR_OPTIONS",
			binary: "tar",
			command: "tar tf archive.tar",
			plant: ({ cwd, hook }) => {
				fs.writeFileSync(path.join(cwd, "member.txt"), "x\n");
				const tar = Bun.spawnSync(["tar", "cf", "archive.tar", "member.txt"], { cwd });
				if (tar.exitCode !== 0) throw new Error(`tar failed: ${tar.stderr.toString()}`);
				return `TAR_OPTIONS=--use-compress-program=${hook}\n`;
			},
		},
		{
			name: "RSYNC_RSH",
			binary: "rsync",
			command: "rsync member.txt remote:/tmp/",
			plant: ({ cwd, hook }) => {
				fs.writeFileSync(path.join(cwd, "member.txt"), "x\n");
				return `RSYNC_RSH=${hook}\n`;
			},
		},
		{
			name: "MAKEFLAGS",
			binary: "make",
			command: "make",
			plant: ({ cwd, hook }) => {
				fs.writeFileSync(path.join(cwd, "Makefile"), "all:\n\t@true\n");
				return `MAKEFLAGS=SHELL=${hook}\n`;
			},
		},
		{
			// npm reads `npm_config_*` in any case and treats `-` like `_`; the
			// mixed-case, dashed spelling reaches lifecycle scripts through npm.
			name: "npm_config_Script-Shell",
			binary: "npm",
			command: "npm run -s probe",
			plant: ({ cwd, hook }) => {
				fs.writeFileSync(
					path.join(cwd, "package.json"),
					JSON.stringify({ name: "probe", version: "1.0.0", scripts: { probe: "true" } }),
				);
				return `npm_config_Script-Shell=${hook}\n`;
			},
		},
		{
			name: "SHELLOPTS",
			binary: "bash",
			command: "bash -c true",
			// Single quotes keep the dotenv value literal: bash, not dotenv, expands it.
			plant: ({ hook }) => `SHELLOPTS=xtrace\nPS4='$(${hook})'\n`,
		},
	];
	for (const vector of RUNTIME_VECTORS) {
		it.skipIf(!Bun.which(vector.binary))(
			`does not let a project ${vector.name} inject code into ${vector.binary}`,
			async () => {
				const target = project(vector.plant);
				const command = `${vector.command} >/dev/null 2>&1; echo probe-done`;
				expect(await runProbe(target, "worker", { GJC_TEST_PROBE_COMMAND: command })).toBe(false);
			},
		);
	}

	// The JVM loads a `-javaagent` from JAVA_TOOL_OPTIONS and JDK_JAVA_OPTIONS before `main`.
	for (const key of ["JAVA_TOOL_OPTIONS", "JDK_JAVA_OPTIONS"]) {
		it.skipIf(!Bun.which("javac") || !Bun.which("jar") || !Bun.which("java"))(
			`does not let a project ${key} agent load into java`,
			async () => {
				const target = project(({ cwd, marker }) => {
					const source = path.join(cwd, "Planted.java");
					fs.writeFileSync(
						source,
						`public class Planted { public static void premain(String a) throws Exception { java.nio.file.Files.write(java.nio.file.Paths.get(${JSON.stringify(marker)}), new byte[0]); } }\n`,
					);
					fs.writeFileSync(path.join(cwd, "manifest.txt"), "Premain-Class: Planted\n");
					for (const argv of [
						["javac", source],
						["jar", "cfm", "planted.jar", "manifest.txt", "Planted.class"],
					]) {
						const step = Bun.spawnSync(argv, { cwd });
						if (step.exitCode !== 0) throw new Error(`${argv[0]} failed: ${step.stderr.toString()}`);
					}
					return `${key}=-javaagent:${path.join(cwd, "planted.jar")}\n`;
				});
				const command = "java -version >/dev/null 2>&1; echo probe-done";
				expect(await runProbe(target, "worker", { GJC_TEST_PROBE_COMMAND: command })).toBe(false);
			},
			60_000,
		);
	}

	// The dynamic loader runs a preloaded library in every dynamically linked
	// command, including a plain `ls`.
	it.skipIf(process.platform !== "linux" || !Bun.which("cc"))(
		"does not let a project LD_PRELOAD library load into shell commands",
		async () => {
			const target = project(({ cwd, marker }) => {
				const source = path.join(cwd, "preload.c");
				fs.writeFileSync(
					source,
					`#include <stdio.h>\n__attribute__((constructor)) static void planted(void) { FILE *f = fopen(${JSON.stringify(marker)}, "w"); if (f) fclose(f); }\n`,
				);
				const library = path.join(cwd, "preload.so");
				const cc = Bun.spawnSync(["cc", "-shared", "-fPIC", "-o", library, source]);
				if (cc.exitCode !== 0) throw new Error(`cc failed: ${cc.stderr.toString()}`);
				return `LD_PRELOAD=${library}\n`;
			});
			expect(await runProbe(target, "worker", { GJC_TEST_PROBE_COMMAND: "ls >/dev/null; echo probe-done" })).toBe(
				false,
			);
		},
	);

	// `LD_AUDIT` modules are loaded by the loader itself, before the program runs.
	it.skipIf(process.platform !== "linux" || !Bun.which("cc"))(
		"does not let a project LD_AUDIT module load into shell commands",
		async () => {
			const target = project(({ cwd, marker }) => {
				const source = path.join(cwd, "audit.c");
				fs.writeFileSync(
					source,
					`#include <stdio.h>\nunsigned int la_version(unsigned int v) { FILE *f = fopen(${JSON.stringify(marker)}, "w"); if (f) fclose(f); return v; }\n`,
				);
				const library = path.join(cwd, "audit.so");
				const cc = Bun.spawnSync(["cc", "-shared", "-fPIC", "-o", library, source]);
				if (cc.exitCode !== 0) throw new Error(`cc failed: ${cc.stderr.toString()}`);
				return `LD_AUDIT=${library}\n`;
			});
			expect(await runProbe(target, "worker", { GJC_TEST_PROBE_COMMAND: "ls >/dev/null; echo probe-done" })).toBe(
				false,
			);
		},
	);

	// `LD_LIBRARY_PATH` is searched before the system directories, so a project
	// library with the soname of one `ls` links against shadows it. The planted
	// copy is an ELF filter on the real library, so `ls` still works.
	const lsDependency = (() => {
		if (process.platform !== "linux" || !Bun.which("cc") || !Bun.which("ldd")) return undefined;
		const ls = Bun.which("ls");
		if (!ls) return undefined;
		const ldd = Bun.spawnSync(["ldd", ls]).stdout.toString();
		for (const line of ldd.split("\n")) {
			const match = /^\s*(\S+)\s+=>\s+(\/\S+)/.exec(line);
			if (match && !/^(?:libc|libm|libdl|libpthread|ld-linux)[.-]/.test(match[1]!)) {
				return { soname: match[1]!, real: match[2]! };
			}
		}
		return undefined;
	})();
	it.skipIf(!lsDependency)("does not let a project LD_LIBRARY_PATH shadow a library of shell commands", async () => {
		const target = project(({ cwd, marker }) => {
			const source = path.join(cwd, "shadow.c");
			fs.writeFileSync(
				source,
				`#include <stdio.h>\n__attribute__((constructor)) static void planted(void) { FILE *f = fopen(${JSON.stringify(marker)}, "w"); if (f) fclose(f); }\n`,
			);
			const libDir = path.join(cwd, "lib");
			fs.mkdirSync(libDir);
			const { soname, real } = lsDependency!;
			const cc = Bun.spawnSync([
				"cc",
				"-shared",
				"-fPIC",
				"-o",
				path.join(libDir, soname),
				source,
				`-Wl,-soname,${soname}`,
				`-Wl,--filter,${real}`,
			]);
			if (cc.exitCode !== 0) throw new Error(`cc failed: ${cc.stderr.toString()}`);
			return `LD_LIBRARY_PATH=${libDir}\n`;
		});
		expect(await runProbe(target, "worker", { GJC_TEST_PROBE_COMMAND: "ls >/dev/null 2>&1; echo probe-done" })).toBe(
			false,
		);
	});

	it.skipIf(!Bun.which("python3"))("still honors a PYTHONPATH the launching shell exported", async () => {
		const target = project(() => "PYTHONPATH=/nonexistent-project-path\n");
		const trusted = path.join(target.cwd, "trusted");
		fs.mkdirSync(trusted);
		fs.writeFileSync(
			path.join(trusted, "sitecustomize.py"),
			`open(${JSON.stringify(target.marker)}, "w").write("ran")\n`,
		);
		const command = "python3 -c 0 >/dev/null 2>&1; echo probe-done";
		expect(await runProbe(target, "worker", { PYTHONPATH: trusted, GJC_TEST_PROBE_COMMAND: command })).toBe(true);
	});

	it.skipIf(process.platform !== "linux" || !Bun.which("python3") || !Bun.which("script"))(
		"does not run a project PYTHONSTARTUP file in the interactive PTY",
		async () => {
			const target = project(({ cwd, marker }) => {
				const startup = path.join(cwd, "startup.py");
				fs.writeFileSync(startup, `open(${JSON.stringify(marker)}, "w").write("ran")\n`);
				return `PYTHONSTARTUP=${startup}\n`;
			});
			const command = "printf 'exit()\\n' | script -qec 'python3' /dev/null; echo probe-done";
			expect(await runProbe(target, "pty", { ...forwarded(target), GJC_TEST_PROBE_COMMAND: command })).toBe(false);
		},
	);

	// The PTY runs a real `bash -lc` that inherits the host environment. A
	// top-level host never holds dotenv values there, but a child GJC launched
	// with the parent's forwarded environment does, with values equal to the
	// project declaration.
	for (const name of ["GIT_CONFIG_", "BASH_ENV"]) {
		it(`does not run a forwarded ${name} hook through the interactive PTY`, async () => {
			const target = project(VECTORS[name]!);
			expect(await runProbe(target, "pty", forwarded(target))).toBe(false);
		});
	}

	// Windows runs the native shell in-process, and Bun's dotenv autoload puts the
	// project values into the real process environment, which the shell imports
	// before `sessionEnv`. Emulated here by forwarding the values into the host.
	it("does not run a GIT_CONFIG_ hook through the in-process native shell", async () => {
		const target = project(VECTORS.GIT_CONFIG_!);
		expect(await runProbe(target, "inprocess", forwarded(target))).toBe(false);
	});

	it("removes project Windows home selectors from the in-process native shell", async () => {
		const target = project(() => "USERPROFILE=project-profile\nHOMEDRIVE=project-drive\nHOMEPATH=project-path\n");
		const command = `test -z "\${USERPROFILE-}\${HOMEDRIVE-}\${HOMEPATH-}" && test -n "\${HOME-}" && echo probe-done`;
		expect(await runProbe(target, "inprocess", { GJC_TEST_PROBE_COMMAND: command, HOME: "" })).toBe(false);
	});

	it("does not run a project GIT_SEQUENCE_EDITOR during git rebase -i", async () => {
		const target = project(({ hook }) => `GIT_SEQUENCE_EDITOR=${hook}\n`);
		for (const message of ["one", "two"]) {
			Bun.spawnSync(
				["git", "-c", "user.email=a@b", "-c", "user.name=a", "commit", "-q", "--allow-empty", "-m", message],
				{
					cwd: target.cwd,
				},
			);
		}
		const command = "git rebase -i HEAD~1 >/dev/null 2>&1; git rebase --abort >/dev/null 2>&1; echo probe-done";
		expect(await runProbe(target, "worker", { GJC_TEST_PROBE_COMMAND: command })).toBe(false);
	});

	it("does not run a project GIT_ASKPASS on an authenticated fetch", async () => {
		const target = project(({ hook }) => `GIT_ASKPASS=${hook}\n`);
		using server = Bun.serve({
			port: 0,
			hostname: "127.0.0.1",
			fetch: () => new Response("", { status: 401, headers: { "WWW-Authenticate": 'Basic realm="x"' } }),
		});
		const command = `git ls-remote http://127.0.0.1:${server.port}/r.git >/dev/null 2>&1; echo probe-done`;
		expect(await runProbe(target, "worker", { GJC_TEST_PROBE_COMMAND: command })).toBe(false);
	});

	it("does not run a project GIT_EXEC_PATH helper during a remote lookup", async () => {
		const target = project(({ cwd, hook }) => {
			const execPath = path.join(cwd, "git-exec");
			fs.mkdirSync(execPath);
			const helper = path.join(execPath, "git-remote-http");
			fs.copyFileSync(hook, helper);
			fs.chmodSync(helper, 0o755);
			return `GIT_EXEC_PATH=${execPath}\n`;
		});
		const command = "git ls-remote http://127.0.0.1:1/r.git >/dev/null 2>&1; echo probe-done";
		for (const mode of ["worker", "pty", "inprocess"] as const) {
			const inherited = { GJC_TEST_PROBE_COMMAND: command, ...(mode === "worker" ? {} : forwarded(target)) };
			expect(await runProbe(target, mode, inherited)).toBe(false);
		}
	});

	it("does not run a project GIT_PROXY_COMMAND during a git-protocol lookup", async () => {
		const target = project(({ hook }) => `GIT_PROXY_COMMAND=${hook}\n`);
		const command = "git ls-remote git://127.0.0.1:1/r.git >/dev/null 2>&1; echo probe-done";
		for (const mode of ["worker", "pty", "inprocess"] as const) {
			const inherited = { GJC_TEST_PROBE_COMMAND: command, ...(mode === "worker" ? {} : forwarded(target)) };
			expect(await runProbe(target, mode, inherited)).toBe(false);
		}
	});

	it("does not install a project GIT_TEMPLATE_DIR hook during git init", async () => {
		const target = project(({ cwd, hook }) => {
			const templates = path.join(cwd, "templates");
			const hooks = path.join(templates, "hooks");
			fs.mkdirSync(hooks, { recursive: true });
			const preCommit = path.join(hooks, "pre-commit");
			fs.copyFileSync(hook, preCommit);
			fs.chmodSync(preCommit, 0o755);
			return `GIT_TEMPLATE_DIR=${templates}\n`;
		});
		const repo = path.join(target.cwd, "new-repo");
		const command = `git init -q "${repo}" && git -C "${repo}" -c user.email=a@b -c user.name=a commit --allow-empty -qm probe; echo probe-done`;
		for (const mode of ["worker", "pty", "inprocess"] as const) {
			const inherited = { GJC_TEST_PROBE_COMMAND: command, ...(mode === "worker" ? {} : forwarded(target)) };
			expect(await runProbe(target, mode, inherited)).toBe(false);
		}
	});

	it("still honors a hook variable the launching shell exported with a different value", async () => {
		const target = project(({ cwd }) => `XDG_CONFIG_HOME=${path.join(cwd, "unused")}\n`);
		const xdg = path.join(target.cwd, "operator-xdg");
		fs.mkdirSync(path.join(xdg, "git"), { recursive: true });
		fs.writeFileSync(path.join(xdg, "git", "config"), `[core]\n\tfsmonitor = ${target.hook}\n`);
		expect(await runProbe(target, "worker", { XDG_CONFIG_HOME: xdg })).toBe(true);
		expect(await runProbe(target, "pty", { XDG_CONFIG_HOME: xdg })).toBe(true);
	});
});

/**
 * zsh sources `$ZDOTDIR/.zshenv` before `-c` commands. Only the PTY path runs the
 * configured shell binary (the non-PTY path is the built-in bash emulator), so
 * this is exercised when a zsh is available.
 */
const ZSH = Bun.which("zsh");
describe.skipIf(process.platform === "win32" || !ZSH)("interactive PTY ignores a project ZDOTDIR", () => {
	it("does not source a forwarded project ZDOTDIR/.zshenv", async () => {
		const target = project(({ cwd, hook }) => {
			const zdot = path.join(cwd, "zdot");
			fs.mkdirSync(zdot, { recursive: true });
			fs.writeFileSync(path.join(zdot, ".zshenv"), `${hook}\n`);
			return `ZDOTDIR=${zdot}\n`;
		});
		expect(await runProbe(target, "pty", { ...forwarded(target), GJC_TEST_SHELL_PATH: ZSH! })).toBe(false);
	});
});
