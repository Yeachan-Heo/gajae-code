import { expect, test } from "bun:test";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import fc from "fast-check";

// Fake git and post-checkout are #!/bin/sh scripts. Win32 skips those cases.
const skipUnixShell = process.platform === "win32";
const childScript = join(import.meta.dir, "iso-git-config-env-child.ts");
const sep = process.platform === "win32" ? ";" : ":";

function gitName(): string {
	return process.platform === "win32" ? "git.exe" : "git";
}

function isExecutableFile(file: string): boolean {
	try {
		const info = statSync(file);
		if (!info.isFile()) return false;
		if (process.platform === "win32") return file.toLowerCase().endsWith(".exe");
		return (info.mode & 0o111) !== 0;
	} catch {
		return false;
	}
}

function locateGit(pathValue: string): { kind: "found"; path: string } | { kind: "skip"; reason: string } {
	for (const dir of pathValue.split(sep)) {
		if (!dir) continue;
		const candidate = join(dir, gitName());
		if (isExecutableFile(candidate)) return { kind: "found", path: candidate };
	}
	return { kind: "skip", reason: "no executable git" };
}

const host = locateGit(process.env.PATH ?? "");
const skipWithoutGit = host.kind === "skip";

function temp(label: string): string {
	return mkdtempSync(join(tmpdir(), `iso-git-config-${label}-`));
}

test.skipIf(skipUnixShell)("locator uses a git that exists only in a custom directory", () => {
	const root = temp("custom");
	try {
		const bin = join(root, "only");
		mkdirSync(bin);
		const git = join(bin, "git");
		writeFileSync(git, "#!/bin/sh\nexit 0\n");
		chmodSync(git, 0o755);
		expect(locateGit(bin)).toEqual({ kind: "found", path: git });
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test.skipIf(skipUnixShell)("locator skips a non-executable git ahead of a runnable one", () => {
	const root = temp("decoy");
	try {
		const decoy = join(root, "decoy");
		const real = join(root, "real");
		mkdirSync(decoy);
		mkdirSync(real);
		writeFileSync(join(decoy, "git"), "not executable\n");
		chmodSync(join(decoy, "git"), 0o644);
		const good = join(real, "git");
		writeFileSync(good, "#!/bin/sh\nexit 0\n");
		chmodSync(good, 0o755);
		expect(locateGit(`${decoy}${sep}${real}`)).toEqual({ kind: "found", path: good });
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("missing git is an explicit skip", () => {
	const root = temp("absent");
	try {
		expect(locateGit(root)).toEqual({ kind: "skip", reason: "no executable git" });
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("unix shell git property is skipped on win32", () => {
	expect(skipUnixShell).toBe(process.platform === "win32");
});

function gitDir(): string {
	if (host.kind !== "found") throw new Error("executable git missing");
	return dirname(host.path);
}

function git(repo: string, root: string, args: string[]): void {
	if (host.kind !== "found") throw new Error("executable git missing");
	execFileSync(host.path, args, {
		cwd: repo,
		stdio: "ignore",
		env: { PATH: `${gitDir()}${sep}/usr/bin${sep}/bin`, HOME: root, USERPROFILE: root, TMPDIR: root },
	});
}

function runChild(repo: string, merged: string, env: NodeJS.ProcessEnv): void {
	const result = spawnSync(process.execPath, [childScript, repo, merged], { env, encoding: "utf8" });
	if (result.status !== 0) {
		throw new Error(result.stderr || result.stdout || `iso start exited ${result.status}`);
	}
}

function repoWithHook(): { root: string; repo: string; merged: string; marker: string; hooks: string } {
	const root = temp("repo");
	const repo = join(root, "repo");
	const hooks = join(repo, ".hooks");
	const marker = join(root, "marker");
	mkdirSync(hooks, { recursive: true });
	const hook = join(hooks, "post-checkout");
	writeFileSync(hook, `#!/bin/sh\necho ran > '${marker}'\n`);
	chmodSync(hook, 0o755);
	git(repo, root, ["init", "-q", "-b", "main"]);
	git(repo, root, ["config", "user.email", "test@example.com"]);
	git(repo, root, ["config", "user.name", "test"]);
	writeFileSync(join(repo, "a.txt"), "hi\n");
	git(repo, root, ["add", ".hooks/post-checkout", "a.txt"]);
	git(repo, root, ["commit", "-q", "-m", "init"]);
	return { root, repo, merged: join(root, "merged"), marker, hooks };
}

function baseEnv(root: string, extra: Record<string, string>): NodeJS.ProcessEnv {
	const path = host.kind === "found" ? `${gitDir()}${sep}/usr/bin${sep}/bin` : `/usr/bin${sep}/bin`;
	const env: NodeJS.ProcessEnv = { PATH: path, HOME: root, USERPROFILE: root, TMPDIR: root };
	for (const [key, value] of Object.entries(extra)) env[key] = value;
	return env;
}

test.skipIf(skipUnixShell || skipWithoutGit)(
	"isoStart does not run a post-checkout hook from the git config channel",
	() => {
		const fixture = repoWithHook();
		try {
			runChild(
				fixture.repo,
				fixture.merged,
				baseEnv(fixture.root, {
					GIT_CONFIG_COUNT: "1",
					GIT_CONFIG_KEY_0: "core.hooksPath",
					GIT_CONFIG_VALUE_0: fixture.hooks,
					GIT_AUTHOR_NAME: " Kept Name ",
					GIT_CONFIG_NOSYSTEM: "1",
				}),
			);
			expect(existsSync(fixture.marker)).toBe(false);
			expect(readFileSync(join(fixture.merged, "a.txt"), "utf8")).toBe("hi\n");
		} finally {
			rmSync(fixture.root, { recursive: true, force: true });
		}
	},
);

test.skipIf(skipUnixShell || skipWithoutGit)("isoStart keeps a checkout when the git config channel is unset", () => {
	const fixture = repoWithHook();
	try {
		runChild(
			fixture.repo,
			fixture.merged,
			baseEnv(fixture.root, {
				GIT_AUTHOR_NAME: " Kept Name ",
				GIT_CONFIG_NOSYSTEM: "1",
			}),
		);
		expect(existsSync(fixture.marker)).toBe(false);
		expect(readFileSync(join(fixture.merged, "a.txt"), "utf8")).toBe("hi\n");
	} finally {
		rmSync(fixture.root, { recursive: true, force: true });
	}
});

test.skipIf(skipUnixShell)("isoStart copies a non-git directory without spawning git", () => {
	const root = temp("nongit");
	try {
		const bin = join(root, "bin");
		const lower = join(root, "lower");
		const log = join(root, "child-env");
		mkdirSync(bin);
		mkdirSync(lower);
		const fake = join(bin, "git");
		writeFileSync(fake, "#!/bin/sh\nprintf '%s\\n' ran >> \"$PI_ISO_ENV_LOG\"\nexit 0\n");
		chmodSync(fake, 0o755);
		writeFileSync(join(lower, "a.txt"), "hi\n");
		runChild(lower, join(root, "merged"), {
			PATH: `${bin}${sep}/usr/bin${sep}/bin`,
			HOME: root,
			USERPROFILE: root,
			TMPDIR: root,
			PI_ISO_ENV_LOG: log,
			GIT_CONFIG_COUNT: "1",
			GIT_CONFIG_KEY_0: "core.hooksPath",
			GIT_CONFIG_VALUE_0: "/hooks",
			GIT_AUTHOR_NAME: " Kept Name ",
		});
		expect(existsSync(log)).toBe(false);
		expect(readFileSync(join(root, "merged", "a.txt"), "utf8")).toBe("hi\n");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

function isGitConfigChannel(name: string): boolean {
	const head = "GIT_CONFIG_";
	if (name.length < head.length || name.slice(0, head.length).toLowerCase() !== "git_config_") return false;
	const rest = name.slice(head.length);
	const folded = rest.toLowerCase();
	if (folded === "count" || folded === "parameters" || folded === "global" || folded === "system") return true;
	for (const prefix of ["key_", "value_"]) {
		if (!folded.startsWith(prefix)) continue;
		const digits = rest.slice(prefix.length);
		return digits.length > 0 && [...digits].every(char => char >= "0" && char <= "9");
	}
	return false;
}

function observeGitChild(name: string): string {
	const root = temp("prop");
	try {
		const bin = join(root, "bin");
		mkdirSync(bin);
		const fake = join(bin, "git");
		writeFileSync(
			fake,
			'#!/bin/sh\nprintf \'%s\\n\' BEGIN >> "$PI_ISO_ENV_LOG"\n/usr/bin/env >> "$PI_ISO_ENV_LOG"\nexit 0\n',
		);
		chmodSync(fake, 0o755);
		const lower = join(root, "lower");
		mkdirSync(lower);
		writeFileSync(join(lower, ".git"), "gitdir: /unused\n");
		const log = join(root, "child-env");
		const env: NodeJS.ProcessEnv = {
			PATH: `${bin}${sep}/usr/bin${sep}/bin`,
			HOME: root,
			USERPROFILE: root,
			TMPDIR: root,
			PI_ISO_ENV_LOG: log,
			GIT_AUTHOR_NAME: " Kept Name ",
			GIT_CONFIG_NOSYSTEM: "1",
		};
		env[name] = "M605";
		runChild(lower, join(root, "merged"), env);
		return readFileSync(log, "utf8");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
}

function isEnvName(name: string): boolean {
	if (name.length < 1 || name.length > 40) return false;
	if (/[= \0\r\n]/.test(name)) return false;
	return !["PATH", "HOME", "USERPROFILE", "TMPDIR", "PI_ISO_ENV_LOG"].includes(name);
}

const channelName = fc.oneof(
	fc.constantFrom(
		"GIT_CONFIG_COUNT",
		"git_config_count",
		"Git_Config_Parameters",
		"GIT_CONFIG_GLOBAL",
		"GIT_CONFIG_SYSTEM",
	),
	fc.integer({ min: 0, max: 9999 }).map(n => `GIT_CONFIG_KEY_${n}`),
	fc.integer({ min: 0, max: 9999 }).map(n => `git_config_value_${n}`),
);

const keptName = fc.constantFrom(
	"GIT_CONFIG_KEY_",
	"GIT_CONFIG_VALUE_",
	"GIT_CONFIG_KEY_0x",
	"GIT_CONFIG_COUNTER",
	"LANG",
);

test.skipIf(skipUnixShell)(
	"spawned git child drops only the git config channel",
	() => {
		fc.assert(
			fc.property(fc.oneof(channelName, keptName).filter(isEnvName), name => {
				const text = observeGitChild(name);
				expect(text).toContain("BEGIN");
				expect(text).toContain("GIT_AUTHOR_NAME= Kept Name ");
				expect(text).toContain("GIT_CONFIG_NOSYSTEM=1");
				if (isGitConfigChannel(name)) expect(text.includes(`${name}=`)).toBe(false);
				else expect(text).toContain(`${name}=M605`);
			}),
			{ seed: 605, numRuns: 64 },
		);
	},
	180_000,
);
