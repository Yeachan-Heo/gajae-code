import { afterEach, describe, expect, it, setDefaultTimeout } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

/**
 * `prepareLaunchWorktree` / `planLaunchWorktree` select the launch bucket from
 * `GJC_WORKTREE_DIR`. Bun loads `cwd/.env` into `process.env` before the module
 * runs, so the refusal is only visible from a process whose cwd is the project
 * that declares the variable.
 */

const PROBE = path.join(import.meta.dir, "../fixtures/worktree-bucket-trust-probe.ts");

setDefaultTimeout(60_000);

const tempDirs: string[] = [];

afterEach(() => {
	for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function git(repo: string, args: string[]): void {
	const result = Bun.spawnSync(["git", ...args], { cwd: repo, stdout: "pipe", stderr: "pipe" });
	if (result.exitCode !== 0) {
		throw new Error(result.stderr.toString().trim() || `git ${args.join(" ")} failed`);
	}
}

function createRepo(): { root: string; repo: string; planted: string; operator: string } {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "gjc-worktree-bucket-trust-"));
	tempDirs.push(root);
	const repo = path.join(root, "repo");
	const planted = path.join(root, "planted");
	const operator = path.join(root, "operator");
	fs.mkdirSync(repo);
	git(repo, ["init"]);
	git(repo, ["config", "user.email", "test@example.com"]);
	git(repo, ["config", "user.name", "Test User"]);
	fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
	fs.writeFileSync(path.join(repo, ".gitignore"), "/.worktrees\n");
	git(repo, ["add", "README.md", ".gitignore"]);
	git(repo, ["commit", "-m", "init"]);
	return { root, repo, planted, operator };
}

function under(parent: string, child: string | null): boolean {
	if (!child) return false;
	const resolvedParent = path.resolve(parent);
	const resolvedChild = path.resolve(child);
	return resolvedChild === resolvedParent || resolvedChild.startsWith(`${resolvedParent}${path.sep}`);
}

async function resolveIn(
	repo: string,
	dotenv: string | undefined,
	overrides: Record<string, string> = {},
	mode: "plan" | "prepare" = "plan",
) {
	if (dotenv !== undefined) fs.writeFileSync(path.join(repo, ".env"), dotenv);
	const env: Record<string, string> = {};
	for (const [key, value] of Object.entries(process.env)) {
		if (value !== undefined) env[key] = value;
	}
	delete env.GJC_WORKTREE_DIR;
	delete env.GIT_DIR;
	delete env.GIT_WORK_TREE;
	delete env.BUN_OPTIONS;
	env.GJC_WORKTREE_BUCKET_PROBE_REPO = repo;
	env.GJC_WORKTREE_BUCKET_PROBE_MODE = mode;
	Object.assign(env, overrides);

	const proc = Bun.spawn([process.execPath, PROBE], { cwd: repo, env, stdout: "pipe", stderr: "pipe" });
	const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
	const exitCode = await proc.exited;
	if (exitCode !== 0) throw new Error(`probe failed (${exitCode}): ${stderr}`);
	return JSON.parse(stdout.trim()) as { error: string | null; worktreePath: string | null; envValue: string | null };
}

describe("launch worktree bucket project dotenv trust", () => {
	it("ignores a project .env GJC_WORKTREE_DIR and prepares the default in-repo worktree", async () => {
		const { repo, planted } = createRepo();
		const resolved = await resolveIn(repo, `GJC_WORKTREE_DIR=${planted}\n`, {}, "prepare");
		expect(resolved.error).toBeNull();
		expect(resolved.envValue).toBe(planted);
		expect(under(path.join(repo, ".worktrees"), resolved.worktreePath)).toBe(true);
		expect(fs.existsSync(planted)).toBe(false);
	});

	it("keeps an operator GJC_WORKTREE_DIR the project does not declare", async () => {
		const { repo, operator } = createRepo();
		const resolved = await resolveIn(repo, "OTHER=1\n", { GJC_WORKTREE_DIR: operator }, "prepare");
		expect(resolved.error).toBeNull();
		expect(resolved.envValue).toBe(operator);
		expect(under(operator, resolved.worktreePath)).toBe(true);
		expect(fs.existsSync(resolved.worktreePath ?? "")).toBe(true);
	});

	it("ignores a dynamic project declaration without using the expanded bucket", async () => {
		const { repo, planted } = createRepo();
		const resolved = await resolveIn(repo, "GJC_WORKTREE_DIR=$GJC_PLANTED_BUCKET\n", {
			GJC_PLANTED_BUCKET: planted,
		});
		expect(resolved.error).toBeNull();
		expect(resolved.envValue).toBe(planted);
		expect(under(path.join(repo, ".worktrees"), resolved.worktreePath)).toBe(true);
		expect(under(planted, resolved.worktreePath)).toBe(false);
	});

	it("still ignores a project bucket after the dotenv file is removed", async () => {
		const { repo, planted } = createRepo();
		const resolved = await resolveIn(repo, `GJC_WORKTREE_DIR=${planted}\n`, {
			GJC_WORKTREE_BUCKET_PROBE_DROP: "unlink",
		});
		expect(resolved.error).toBeNull();
		expect(resolved.envValue).toBe(planted);
		expect(under(path.join(repo, ".worktrees"), resolved.worktreePath)).toBe(true);
	});

	it("still ignores a project bucket after the process cwd changes", async () => {
		const { repo, planted } = createRepo();
		const resolved = await resolveIn(repo, `GJC_WORKTREE_DIR=${planted}\n`, {
			GJC_WORKTREE_BUCKET_PROBE_DROP: "chdir",
		});
		expect(resolved.error).toBeNull();
		expect(resolved.envValue).toBe(planted);
		expect(under(path.join(repo, ".worktrees"), resolved.worktreePath)).toBe(true);
	});

	it("keeps an operator value when the project declares a different static bucket", async () => {
		const { repo, planted, operator } = createRepo();
		const resolved = await resolveIn(repo, `GJC_WORKTREE_DIR=${planted}\n`, { GJC_WORKTREE_DIR: operator });
		expect(resolved.error).toBeNull();
		expect(resolved.envValue).toBe(operator);
		expect(under(operator, resolved.worktreePath)).toBe(true);
		expect(under(planted, resolved.worktreePath)).toBe(false);
	});
});
