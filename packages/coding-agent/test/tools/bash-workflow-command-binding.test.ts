import { afterEach, describe, expect, it, vi } from "bun:test";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { disposeAllShellSessions } from "../../src/exec/bash-executor";
import type { ToolSession } from "../../src/tools";
import { BashTool } from "../../src/tools/bash";
import { checkBashAllowedPrefixes } from "../../src/tools/bash-allowed-prefixes";
import * as shellSnapshot from "../../src/utils/shell-snapshot";
import { stubBashExecutorSettings } from "../helpers/tool-session-settings";

const ROLE_PREFIXES = [
	"gjc ralplan --write",
	"gjc state",
	"git status",
	"git log",
	"git show",
	"git diff",
	"git blame",
	"git rev-parse",
	"git ls-files",
];

const PROPERTY_SEED = 40517;
const PROPERTY_INPUTS = 64;
const HAS_BASH = process.platform !== "win32" && fs.existsSync("/bin/bash") && Bun.which("git") !== null;

afterEach(async () => {
	vi.restoreAllMocks();
	await disposeAllShellSessions();
});

function mulberry32(seed: number): () => number {
	let state = seed >>> 0;
	return () => {
		state = (state + 0x6d2b79f5) | 0;
		let t = Math.imul(state ^ (state >>> 15), 1 | state);
		t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

function withHelperOption(command: string, option: string): string {
	const splitAt = command.indexOf(" -- ");
	if (splitAt !== -1) return `${command.slice(0, splitAt)} ${option}${command.slice(splitAt)}`;
	if (command.endsWith(" --")) return `${command.slice(0, -3)} ${option} --`;
	return `${command} ${option}`;
}

function gitEnv(home: string): NodeJS.ProcessEnv {
	return {
		...process.env,
		HOME: home,
		GIT_CONFIG_GLOBAL: "/dev/null",
		GIT_CONFIG_SYSTEM: "/dev/null",
		GIT_AUTHOR_NAME: "t",
		GIT_AUTHOR_EMAIL: "t@example.com",
		GIT_COMMITTER_NAME: "t",
		GIT_COMMITTER_EMAIL: "t@example.com",
	};
}

function git(cwd: string, home: string, args: string[]): void {
	execFileSync("git", args, { cwd, env: gitEnv(home), stdio: "pipe" });
}

function writeExecutable(file: string, body: string): void {
	fs.writeFileSync(file, body);
	fs.chmodSync(file, 0o755);
}

interface WorkflowRepo {
	dir: string;
	home: string;
	cleanup: () => void;
}

function createWorkflowRepo(options?: { externalMarker?: string; textconvMarker?: string }): WorkflowRepo {
	const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "gjc-wf-bash-")));
	const home = path.join(dir, "home");
	fs.mkdirSync(home);
	git(dir, home, ["init", "-q"]);
	fs.writeFileSync(path.join(dir, "f"), "hi\n");
	git(dir, home, ["add", "f"]);
	git(dir, home, ["-c", "commit.gpgsign=false", "commit", "-qm", "init"]);
	fs.writeFileSync(path.join(dir, "f"), "changed\n");
	if (options?.externalMarker) {
		const helper = path.join(dir, "ext.sh");
		writeExecutable(helper, `#!/bin/sh\ntouch '${options.externalMarker}'\nexit 0\n`);
		git(dir, home, ["config", "diff.external", helper]);
	}
	if (options?.textconvMarker) {
		const helper = path.join(dir, "tc.sh");
		writeExecutable(helper, `#!/bin/sh\ntouch '${options.textconvMarker}'\ncat "$1"\n`);
		git(dir, home, ["config", "diff.ext.textconv", helper]);
		fs.writeFileSync(path.join(dir, ".gitattributes"), "f diff=ext\n");
	}
	return { dir, home, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

let sessionSerial = 0;

function createWorkflowTool(repo: WorkflowRepo, snapshotBody: string, shellPrefix?: string): BashTool {
	sessionSerial += 1;
	const snapshotPath = path.join(repo.dir, `snapshot-${sessionSerial}.sh`);
	fs.writeFileSync(snapshotPath, snapshotBody);
	vi.spyOn(shellSnapshot, "getOrCreateSnapshot").mockResolvedValue(snapshotPath);
	const session = {
		cwd: repo.dir,
		getSessionFile: () => null,
		getSessionId: () => `workflow-bash-${sessionSerial}`,
		bashAllowedPrefixes: ROLE_PREFIXES,
		bashRestrictionProfile: "workflow" as const,
		settings: {
			has(key: string) {
				return this.get(key) !== undefined;
			},
			get(key: string) {
				if (key === "bashInterceptor.enabled") return false;
				if (key === "async.enabled") return false;
				if (key === "bash.autoBackground.enabled") return false;
				if (key === "bash.autoBackground.thresholdMs") return 60_000;
				if (key === "bash.stripTrailingHeadTail") return false;
				return undefined;
			},
			getBashInterceptorRules() {
				return [];
			},
			...stubBashExecutorSettings,
			getShellConfig() {
				return {
					shell: "/bin/bash",
					args: ["-c"],
					env: {
						PATH: process.env.PATH ?? "/usr/bin:/bin",
						HOME: repo.home,
						GIT_CONFIG_GLOBAL: "/dev/null",
						GIT_CONFIG_SYSTEM: "/dev/null",
					},
					prefix: shellPrefix,
				};
			},
		},
	} as unknown as ToolSession;
	return new BashTool(session);
}

function resultText(result: { content: Array<{ type: string; text?: string }> }): string {
	return result.content.find(part => part.type === "text")?.text ?? "";
}

describe("workflow bash command binding", () => {
	it("allows git inspection commands the workflow profile already accepted", () => {
		for (const command of [
			"git status",
			"git diff",
			"git diff --stat",
			"git diff --text",
			"git diff --no-ext-diff",
			"git diff --no-textconv",
			"git diff -- f",
			"git diff -- --ext-diff",
			"git log --oneline -20",
			"git show HEAD",
			"git blame -- src/a.ts",
			"git rev-parse HEAD",
			"git ls-files",
			"git diff HEAD~1",
		]) {
			expect({ command, ...checkBashAllowedPrefixes(command, ROLE_PREFIXES) }).toMatchObject({ allowed: true });
		}
	});

	it("refuses git --ext-diff and --textconv helper options", () => {
		for (const command of [
			"git diff --ext-diff",
			"git diff --textconv",
			"git diff --ext-diff=driver",
			"git log -p --textconv",
			"git show --ext-diff -- f",
			"git blame --textconv -- f",
		]) {
			const result = checkBashAllowedPrefixes(command, ROLE_PREFIXES);
			expect({ command, ...result }).toMatchObject({ allowed: false });
			expect(result.reason).toContain("external diff or textconv");
		}
	});

	it("property pins workflow command normalization, seed 40517, 64 inputs", async () => {
		const mod = await import("../../src/tools/bash-allowed-prefixes");
		const normalize = mod.normalizeWorkflowBashCommand;
		if (typeof normalize !== "function") throw new Error("workflow normalizer is missing");
		const gitPath = Bun.which("git", { PATH: process.env.PATH ?? "" });
		if (!gitPath) throw new Error("git is not on PATH");
		const random = mulberry32(PROPERTY_SEED);
		const subs = ["diff", "log", "show", "blame", "status", "rev-parse", "ls-files"];
		const tails = [
			"",
			"--stat",
			"--src-prefix a",
			"--src-prefix a -- f",
			"--dst-prefix z -- f",
			"--unified 3",
			"--abbrev 8",
			"-- f",
			"--",
			"HEAD -- f",
			"--text",
			"--no-ext-diff",
		];
		const quotedWords = (command: string): string[] => command.split(" ").map(word => word.slice(1, -1));
		for (let index = 0; index < PROPERTY_INPUTS; index += 1) {
			const sub = subs[Math.floor(random() * subs.length)]!;
			const tail = tails[Math.floor(random() * tails.length)]!;
			const command = tail ? `git ${sub} ${tail}` : `git ${sub}`;
			const userRest = tail ? tail.split(" ") : [];
			const normalized = normalize(command, ROLE_PREFIXES, { profile: "workflow" });
			if (!normalized) throw new Error(`normalizer rejected a safe command: ${command}`);
			const words = quotedWords(normalized);
			expect(words[0]).toBe(gitPath);
			expect(words[1]).toBe(sub);
			if (sub === "blame" || sub === "diff" || sub === "log" || sub === "show") {
				expect(words.slice(2, 4)).toEqual(["--no-ext-diff", "--no-textconv"]);
				expect(words.slice(4)).toEqual(userRest);
				const prefixAt = words.indexOf("--src-prefix");
				if (prefixAt !== -1 && words[prefixAt + 1] !== undefined && words[prefixAt + 1] !== "--") {
					expect(words[prefixAt + 1]).not.toBe("--no-ext-diff");
				}
			} else {
				expect(words.slice(2)).toEqual(userRest);
			}
			expect(normalize(command, ROLE_PREFIXES, { profile: "workflow" })).toBe(normalized);
		}
	});

	it("property pins git external helper options, seed 40517, 64 inputs", () => {
		const random = mulberry32(PROPERTY_SEED);
		const subs = ["status", "log", "show", "diff", "blame", "rev-parse", "ls-files"];
		const tails = [
			"",
			"--oneline -5",
			"--stat",
			"--name-only",
			"HEAD",
			"HEAD~1",
			"-- src/a.ts",
			"-1 --oneline",
			"--no-ext-diff",
			"--no-textconv",
			"--text",
			"--",
		];
		for (let index = 0; index < PROPERTY_INPUTS; index += 1) {
			const sub = subs[Math.floor(random() * subs.length)]!;
			const tail = tails[Math.floor(random() * tails.length)]!;
			const command = tail ? `git ${sub} ${tail}` : `git ${sub}`;
			const allowed = checkBashAllowedPrefixes(command, ROLE_PREFIXES);
			expect({ command, ...allowed }).toMatchObject({ allowed: true });
			expect(checkBashAllowedPrefixes(command, ROLE_PREFIXES)).toEqual(allowed);
			for (const option of ["--ext-diff", "--textconv"]) {
				const dangerous = withHelperOption(command, option);
				expect({ dangerous, ...checkBashAllowedPrefixes(dangerous, ROLE_PREFIXES) }).toMatchObject({
					allowed: false,
				});
			}
		}
	});

	it.skipIf(!HAS_BASH)("allows a plain git diff to print the working tree change", async () => {
		const repo = createWorkflowRepo();
		try {
			const tool = createWorkflowTool(repo, ":\n");
			const diff = await tool.execute("tool-call", { command: "git diff -- f" });
			const status = await tool.execute("tool-call", { command: "git status --short" });
			const log = await tool.execute("tool-call", { command: "git log -1 --oneline" });
			expect(resultText(diff)).toContain("+changed");
			expect(resultText(status)).toContain("f");
			expect(resultText(log)).toContain("init");
		} finally {
			repo.cleanup();
		}
	});

	it.skipIf(!HAS_BASH)("refuses a snapshot alias that replaces an allowlisted git command", async () => {
		const repo = createWorkflowRepo();
		const marker = path.join(repo.dir, "alias-marker");
		try {
			const tool = createWorkflowTool(repo, `shopt -s expand_aliases\nalias git='touch ${marker}'\n`);
			const result = await tool.execute("tool-call", { command: "git diff -- f" });
			expect(fs.existsSync(marker)).toBe(false);
			expect(resultText(result)).toContain("+changed");
		} finally {
			repo.cleanup();
		}
	});

	it.skipIf(!HAS_BASH)("refuses a snapshot function that replaces an allowlisted git command", async () => {
		const repo = createWorkflowRepo();
		const marker = path.join(repo.dir, "function-marker");
		try {
			const tool = createWorkflowTool(repo, `git() { touch '${marker}'; }\n`);
			const result = await tool.execute("tool-call", { command: "git diff -- f" });
			expect(fs.existsSync(marker)).toBe(false);
			expect(resultText(result)).toContain("+changed");
		} finally {
			repo.cleanup();
		}
	});

	it.skipIf(!HAS_BASH)("refuses a snapshot PATH entry that replaces git", async () => {
		const repo = createWorkflowRepo();
		const marker = path.join(repo.dir, "path-marker");
		const evilBin = path.join(repo.dir, "evil-bin");
		try {
			fs.mkdirSync(evilBin);
			writeExecutable(path.join(evilBin, "git"), `#!/bin/sh\ntouch '${marker}'\nexit 0\n`);
			const tool = createWorkflowTool(repo, `export PATH='${evilBin}'\n`);
			const result = await tool.execute("tool-call", { command: "git diff -- f" });
			expect(fs.existsSync(marker)).toBe(false);
			expect(resultText(result)).toContain("+changed");
		} finally {
			repo.cleanup();
		}
	});

	it.skipIf(!HAS_BASH)("refuses a configured external diff helper on an allowlisted git diff", async () => {
		const marker = path.join(os.tmpdir(), `gjc-wf-ext-${process.pid}`);
		fs.rmSync(marker, { force: true });
		const repo = createWorkflowRepo({ externalMarker: marker });
		try {
			const tool = createWorkflowTool(repo, ":\n");
			await expect(tool.execute("tool-call", { command: "git diff --ext-diff -- f" })).rejects.toThrow(
				"external diff or textconv",
			);
			expect(fs.existsSync(marker)).toBe(false);
			const plain = await tool.execute("tool-call", { command: "git diff -- f" });
			expect(fs.existsSync(marker)).toBe(false);
			expect(resultText(plain)).toContain("+changed");
		} finally {
			repo.cleanup();
			fs.rmSync(marker, { force: true });
		}
	});

	it.skipIf(!HAS_BASH)("refuses a snapshot function named for the resolved git path", async () => {
		const repo = createWorkflowRepo();
		const marker = path.join(repo.dir, "abs-fn-marker");
		const gitPath = Bun.which("git", { PATH: process.env.PATH ?? "" });
		if (!gitPath) throw new Error("git is not on PATH");
		try {
			const tool = createWorkflowTool(repo, `${gitPath}() { touch '${marker}'; }\n`);
			const result = await tool.execute("tool-call", { command: "git diff -- f" });
			expect(fs.existsSync(marker)).toBe(false);
			expect(resultText(result)).toContain("+changed");
		} finally {
			repo.cleanup();
		}
	});

	it.skipIf(!HAS_BASH)("refuses a configured shell prefix before an allowlisted git command", async () => {
		const repo = createWorkflowRepo();
		const marker = path.join(repo.dir, "prefix-marker");
		try {
			const tool = createWorkflowTool(repo, ":\n", `touch ${marker};`);
			const result = await tool.execute("tool-call", { command: "git diff -- f" });
			expect(fs.existsSync(marker)).toBe(false);
			expect(resultText(result)).toContain("+changed");
		} finally {
			repo.cleanup();
		}
	});

	it.skipIf(!HAS_BASH)("allows an incomplete src-prefix to leave the helper unrun", async () => {
		const marker = path.join(os.tmpdir(), `gjc-wf-src-miss-${process.pid}`);
		fs.rmSync(marker, { force: true });
		const repo = createWorkflowRepo({ externalMarker: marker });
		try {
			const tool = createWorkflowTool(repo, ":\n");
			await expect(tool.execute("tool-call", { command: "git diff --src-prefix" })).rejects.toThrow();
			expect(fs.existsSync(marker)).toBe(false);
		} finally {
			repo.cleanup();
			fs.rmSync(marker, { force: true });
		}
	});

	it.skipIf(!HAS_BASH)("refuses an external diff helper when src-prefix takes a value", async () => {
		const marker = path.join(os.tmpdir(), `gjc-wf-src-${process.pid}`);
		fs.rmSync(marker, { force: true });
		const repo = createWorkflowRepo({ externalMarker: marker });
		try {
			const tool = createWorkflowTool(repo, ":\n");
			const result = await tool.execute("tool-call", { command: "git diff --src-prefix b/ -- f" });
			expect(fs.existsSync(marker)).toBe(false);
			expect(resultText(result)).toContain("+changed");
		} finally {
			repo.cleanup();
			fs.rmSync(marker, { force: true });
		}
	});

	it.skipIf(!HAS_BASH)("refuses a configured textconv helper on an allowlisted git diff", async () => {
		const marker = path.join(os.tmpdir(), `gjc-wf-tc-${process.pid}`);
		fs.rmSync(marker, { force: true });
		const repo = createWorkflowRepo({ textconvMarker: marker });
		try {
			const tool = createWorkflowTool(repo, ":\n");
			await expect(tool.execute("tool-call", { command: "git diff --textconv -- f" })).rejects.toThrow(
				"external diff or textconv",
			);
			expect(fs.existsSync(marker)).toBe(false);
			const plain = await tool.execute("tool-call", { command: "git diff -- f" });
			expect(fs.existsSync(marker)).toBe(false);
			expect(resultText(plain)).toContain("+changed");
		} finally {
			repo.cleanup();
			fs.rmSync(marker, { force: true });
		}
	});
});
