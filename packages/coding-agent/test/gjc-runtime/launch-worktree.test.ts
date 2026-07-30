import { afterEach, describe, expect, it, spyOn } from "bun:test";
import * as crypto from "node:crypto";
import * as fsSync from "node:fs";
import * as fs from "node:fs/promises";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import type { Args } from "@gajae-code/coding-agent/cli/args";
import { buildDefaultTmuxLaunchPlan } from "@gajae-code/coding-agent/gjc-runtime/launch-tmux";
import {
	ensureLaunchWorktree,
	parseLaunchWorktreeMode,
	planLaunchWorktree,
	prepareLaunchWorktree,
} from "@gajae-code/coding-agent/gjc-runtime/launch-worktree";

const cleanupRoots: string[] = [];
const cleanupPaths: string[] = [];

function run(command: string, args: string[], cwd: string): string {
	const result = Bun.spawnSync([command, ...args], { cwd, stdout: "pipe", stderr: "pipe" });
	if (result.exitCode === 0) return result.stdout.toString().trim();
	throw new Error(result.stderr.toString().trim() || `${command} ${args.join(" ")} failed`);
}

function testSlug(value: string): string {
	const readable = value
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/-+/g, "-")
		.replace(/^-|-$/g, "");
	const prefix = readable || "default";
	const digest = crypto.createHash("sha256").update(value).digest("hex").slice(0, 8);
	return `${prefix}-${digest}`;
}

async function createRepo(prefix: string): Promise<string> {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
	cleanupRoots.push(root);
	run("git", ["init"], root);
	run("git", ["config", "user.email", "test@example.com"], root);
	run("git", ["config", "user.name", "Test User"], root);
	await Bun.write(path.join(root, "README.md"), "hello\n");
	run("git", ["add", "README.md"], root);
	run("git", ["commit", "-m", "init"], root);
	return root;
}

afterEach(async () => {
	for (const root of cleanupRoots.splice(0)) {
		const bucket = path.join(path.dirname(root), `${path.basename(root)}.gajae-code-worktrees`);
		const branchSlug = testSlug(run("git", ["branch", "--show-current"], root));
		Bun.spawnSync(["git", "worktree", "remove", "--force", path.join(bucket, branchSlug)], {
			cwd: root,
			stdout: "ignore",
			stderr: "ignore",
		});
		Bun.spawnSync(["git", "worktree", "remove", "--force", path.join(bucket, "feature-demo")], {
			cwd: root,
			stdout: "ignore",
			stderr: "ignore",
		});
		await fs.rm(root, { recursive: true, force: true });
		await fs.rm(bucket, { recursive: true, force: true });
	}
	for (const cleanupPath of cleanupPaths.splice(0)) await fs.rm(cleanupPath, { recursive: true, force: true });
});

describe("default launch worktrees", () => {
	it("parses and strips launch worktree flags", () => {
		expect(parseLaunchWorktreeMode(["--worktree", "feature/demo", "hello"])).toEqual({
			mode: { enabled: true, detached: false, name: "feature/demo" },
			remainingArgs: ["hello"],
		});
		expect(parseLaunchWorktreeMode(["--worktree", "--", "hello"])).toEqual({
			mode: { enabled: true, detached: true, name: null },
			remainingArgs: ["hello"],
		});
		expect(parseLaunchWorktreeMode(["--worktree", "--model", "opus"]).mode).toEqual({
			enabled: true,
			detached: true,
			name: null,
		});
		expect(parseLaunchWorktreeMode(["--worktree=feature/demo", "hello"])).toEqual({
			mode: { enabled: true, detached: false, name: "feature/demo" },
			remainingArgs: ["hello"],
		});
		expect(parseLaunchWorktreeMode(["-w", "feature/demo", "hello"])).toEqual({
			mode: { enabled: true, detached: false, name: "feature/demo" },
			remainingArgs: ["hello"],
		});
		expect(parseLaunchWorktreeMode(["-w", "--", "hello"])).toEqual({
			mode: { enabled: true, detached: true, name: null },
			remainingArgs: ["hello"],
		});
		expect(parseLaunchWorktreeMode(["-w=feature/demo", "hello"])).toEqual({
			mode: { enabled: true, detached: false, name: "feature/demo" },
			remainingArgs: ["hello"],
		});
	});

	it("creates and reuses a detached launch worktree beside the source repo", async () => {
		const repo = await createRepo("gjc-launch-worktree-");
		await fs.mkdir(path.join(repo, "node_modules"));

		const first = prepareLaunchWorktree(repo, ["--worktree", "--", "hello"]);
		const branchSlug = testSlug(run("git", ["branch", "--show-current"], repo));
		const expectedPath = path.join(path.dirname(repo), `${path.basename(repo)}.gajae-code-worktrees`, branchSlug);

		expect(await fs.realpath(first.cwd)).toBe(await fs.realpath(expectedPath));
		expect(first.args).toEqual(["hello"]);
		expect(first.worktree.enabled && first.worktree.created).toBe(true);
		expect(first.worktree.enabled && first.worktree.detached).toBe(true);
		expect(await Bun.file(path.join(expectedPath, ".git")).exists()).toBe(true);
		expect((await fs.lstat(path.join(expectedPath, "node_modules"))).isSymbolicLink()).toBe(true);

		const second = prepareLaunchWorktree(repo, ["--worktree", "--slow", "opus"]);
		expect(await fs.realpath(second.cwd)).toBe(await fs.realpath(expectedPath));
		expect(second.worktree.enabled && second.worktree.reused).toBe(true);
	});

	it("creates launch worktrees beside the canonical source repo when launched from an existing worktree", async () => {
		const repo = await fs.realpath(await createRepo("gjc-launch-nested-source-worktree-"));
		const first = prepareLaunchWorktree(repo, ["--worktree"]);
		expect(first.worktree.enabled && first.worktree.created).toBe(true);

		const second = prepareLaunchWorktree(first.cwd, ["--worktree", "feature/nested"]);
		const expectedPath = path.join(
			path.dirname(repo),
			`${path.basename(repo)}.gajae-code-worktrees`,
			testSlug("feature/nested"),
		);

		expect(second.worktree.enabled && second.worktree.repoRoot).toBe(repo);
		expect(await fs.realpath(second.cwd)).toBe(await fs.realpath(expectedPath));
		expect(
			second.cwd.includes(`.gajae-code-worktrees${path.sep}${path.basename(first.cwd)}.gajae-code-worktrees`),
		).toBe(false);
	});

	it("reports actionable diagnostics when the deterministic detached target is a different branch", async () => {
		const repo = await createRepo("gjc-launch-target-mismatch-");
		const first = prepareLaunchWorktree(repo, ["--worktree"]);
		expect(first.worktree.enabled && first.worktree.created).toBe(true);
		run("git", ["checkout", "-b", "other-agent-work"], first.cwd);

		expect(() => prepareLaunchWorktree(repo, ["--worktree"])).toThrow(
			/worktree_target_mismatch:[\s\S]*already registered for refs\/heads\/other-agent-work[\s\S]*Refusing to delete or reuse the conflicting worktree automatically[\s\S]*git worktree remove/,
		);
	});

	it("updates a clean reused detached launch worktree when source HEAD advances", async () => {
		const repo = await createRepo("gjc-launch-advance-worktree-");
		const first = prepareLaunchWorktree(repo, ["--worktree"]);
		expect(first.worktree.enabled && first.worktree.created).toBe(true);

		await Bun.write(path.join(repo, "next.txt"), "next\n");
		run("git", ["add", "next.txt"], repo);
		run("git", ["commit", "-m", "next"], repo);
		const nextHead = run("git", ["rev-parse", "HEAD"], repo);

		const second = prepareLaunchWorktree(repo, ["--worktree"]);
		expect(second.worktree.enabled && second.worktree.reused).toBe(true);
		expect(run("git", ["rev-parse", "HEAD"], second.cwd)).toBe(nextHead);
	});

	it("rejects dirty detached launch worktrees when source HEAD advances", async () => {
		const repo = await createRepo("gjc-launch-dirty-worktree-");
		const first = prepareLaunchWorktree(repo, ["--worktree"]);
		expect(first.worktree.enabled && first.worktree.created).toBe(true);
		await Bun.write(path.join(first.cwd, "dirty.txt"), "dirty\n");

		await Bun.write(path.join(repo, "next.txt"), "next\n");
		run("git", ["add", "next.txt"], repo);
		run("git", ["commit", "-m", "next"], repo);

		expect(() => prepareLaunchWorktree(repo, ["--worktree"])).toThrow(/worktree_dirty:/);
	});

	it("creates named worktrees without reusing a dirty detached source-branch worktree", async () => {
		const repo = await createRepo("gjc-launch-dirty-detached-named-worktree-");
		const detached = prepareLaunchWorktree(repo, ["--worktree"]);
		expect(detached.worktree.enabled && detached.worktree.created).toBe(true);
		await Bun.write(path.join(detached.cwd, "dirty.txt"), "dirty\n");

		const named = prepareLaunchWorktree(repo, ["--worktree", "feat/hud-ui-alignment"]);
		const expectedPath = path.join(
			path.dirname(repo),
			`${path.basename(repo)}.gajae-code-worktrees`,
			testSlug("feat/hud-ui-alignment"),
		);

		expect(await fs.realpath(named.cwd)).toBe(await fs.realpath(expectedPath));
		expect(named.worktree.enabled && named.worktree.branchName).toBe("feat/hud-ui-alignment");
		expect(run("git", ["branch", "--show-current"], named.cwd)).toBe("feat/hud-ui-alignment");
	});

	it("reports a private, platform-neutral error for a broken bucket symlink without deleting it", async () => {
		const repo = await createRepo("gjc launch 'broken-bucket-symlink-");
		const bucket = path.join(path.dirname(repo), `${path.basename(repo)}.gajae-code-worktrees`);
		const missingTarget = path.join(path.dirname(repo), "private-missing-cold-storage-target");
		await fs.symlink(missingTarget, bucket, process.platform === "win32" ? "junction" : "dir");

		let message = "";
		try {
			prepareLaunchWorktree(repo, ["--worktree", "feature/demo"]);
		} catch (error) {
			message = error instanceof Error ? error.message : String(error);
		}
		expect(message).toContain("worktree_bucket_broken_symlink");
		expect(message).toContain("platform-appropriate filesystem tools");
		expect(message).toContain("GJC did not delete or replace the entry");
		expect(message).not.toContain(missingTarget);
		expect(message).not.toMatch(/`?rm\s/);
		expect((await fs.lstat(bucket)).isSymbolicLink()).toBe(true);
	});

	it("reclassifies a broken symlink racing the bucket mkdir instead of leaking raw EEXIST", async () => {
		const repo = await createRepo("gjc-launch-bucket-mkdir-race-");
		const bucket = path.join(path.dirname(repo), `${path.basename(repo)}.gajae-code-worktrees`);
		const missingTarget = path.join(path.dirname(repo), "racing-missing-bucket-target");
		const mkdirSpy = spyOn(fsSync, "mkdirSync").mockImplementationOnce((targetPath: fsSync.PathLike) => {
			expect(path.resolve(String(targetPath))).toBe(path.resolve(bucket));
			fsSync.symlinkSync(missingTarget, targetPath, process.platform === "win32" ? "junction" : "dir");
			throw Object.assign(new Error("raw mkdir race"), { code: "EEXIST" });
		});

		try {
			expect(() => prepareLaunchWorktree(repo, ["--worktree", "feature/demo"])).toThrow(
				/worktree_bucket_broken_symlink[\s\S]*GJC did not delete or replace the entry/,
			);
		} finally {
			mkdirSpy.mockRestore();
		}
		expect((await fs.lstat(bucket)).isSymbolicLink()).toBe(true);
	});

	it("does not treat non-ENOENT bucket inspection failures as a missing directory", async () => {
		const repo = await createRepo("gjc-launch-bucket-inspection-failure-");
		const bucket = path.join(path.dirname(repo), `${path.basename(repo)}.gajae-code-worktrees`);
		const lstatSpy = spyOn(fsSync, "lstatSync").mockImplementationOnce(() => {
			throw Object.assign(new Error("permission denied"), { code: "EACCES" });
		});

		try {
			expect(() => prepareLaunchWorktree(repo, ["--worktree", "feature/demo"])).toThrow(
				/worktree_bucket_inspection_failed[\s\S]*EACCES[\s\S]*GJC did not modify the entry/,
			);
		} finally {
			lstatSpy.mockRestore();
		}
		expect(await Bun.file(bucket).exists()).toBe(false);
	});

	it("allows a valid directory symlink or Windows junction as the worktree bucket", async () => {
		const repo = await createRepo("gjc-launch-valid-bucket-symlink-");
		const bucket = path.join(path.dirname(repo), `${path.basename(repo)}.gajae-code-worktrees`);
		const target = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-launch-bucket-target-"));
		cleanupPaths.push(target);
		await fs.symlink(target, bucket, process.platform === "win32" ? "junction" : "dir");

		const launched = prepareLaunchWorktree(repo, ["--worktree", "feature/demo"]);
		const expectedPath = path.join(target, testSlug("feature/demo"));
		expect(await fs.realpath(launched.cwd)).toBe(await fs.realpath(expectedPath));
		expect((await fs.lstat(bucket)).isSymbolicLink()).toBe(true);
		expect(launched.worktree.enabled && launched.worktree.created).toBe(true);
		const reused = prepareLaunchWorktree(repo, ["--worktree", "feature/demo"]);
		expect(await fs.realpath(reused.cwd)).toBe(await fs.realpath(expectedPath));
		expect(reused.worktree.enabled && reused.worktree.reused).toBe(true);
	});

	it("reports a symlink to a non-directory target without disclosing or deleting the target", async () => {
		const repo = await createRepo("gjc-launch-bucket-file-symlink-");
		const bucket = path.join(path.dirname(repo), `${path.basename(repo)}.gajae-code-worktrees`);
		const target = path.join(path.dirname(repo), "private-bucket-target-file");
		cleanupPaths.push(target);
		await Bun.write(target, "preserve-me\n");
		await fs.symlink(target, bucket, "file");

		let message = "";
		try {
			prepareLaunchWorktree(repo, ["--worktree", "feature/demo"]);
		} catch (error) {
			message = error instanceof Error ? error.message : String(error);
		}
		expect(message).toMatch(/worktree_bucket_not_directory[\s\S]*symbolic link whose target is not a directory/);
		expect(message).not.toContain(target);
		expect(await Bun.file(target).text()).toBe("preserve-me\n");
		expect((await fs.lstat(bucket)).isSymbolicLink()).toBe(true);
	});

	it("reports a regular-file bucket without shell text or deletion side effects", async () => {
		const repo = await createRepo("gjc-launch-bucket-not-directory-");
		const bucket = path.join(path.dirname(repo), `${path.basename(repo)}.gajae-code-worktrees`);
		await Bun.write(bucket, "not-a-directory\n");

		let message = "";
		try {
			prepareLaunchWorktree(repo, ["--worktree", "feature/demo"]);
		} catch (error) {
			message = error instanceof Error ? error.message : String(error);
		}
		expect(message).toMatch(/worktree_bucket_not_directory[\s\S]*not a directory/);
		expect(message).toContain("platform-appropriate filesystem tools");
		expect(message).not.toMatch(/`?rm\s/);
		expect(await Bun.file(bucket).text()).toBe("not-a-directory\n");
	});

	if (process.platform !== "win32") {
		it("reports a FIFO bucket as a non-directory without deleting it", async () => {
			const repo = await createRepo("gjc-launch-bucket-fifo-");
			const bucket = path.join(path.dirname(repo), `${path.basename(repo)}.gajae-code-worktrees`);
			const created = Bun.spawnSync(["mkfifo", bucket], { stdout: "pipe", stderr: "pipe" });
			expect(created.exitCode).toBe(0);

			expect(() => prepareLaunchWorktree(repo, ["--worktree", "feature/demo"])).toThrow(
				/worktree_bucket_not_directory[\s\S]*not a directory/,
			);
			expect((await fs.lstat(bucket)).isFIFO()).toBe(true);
		});

		it("reports a Unix socket bucket as a non-directory without deleting it", async () => {
			const repo = await createRepo("gjc-launch-bucket-socket-");
			const bucket = path.join(path.dirname(repo), `${path.basename(repo)}.gajae-code-worktrees`);
			const server = net.createServer();
			const ready = Promise.withResolvers<void>();
			server.once("error", ready.reject);
			server.listen(bucket, ready.resolve);
			await ready.promise;

			try {
				expect(() => prepareLaunchWorktree(repo, ["--worktree", "feature/demo"])).toThrow(
					/worktree_bucket_not_directory[\s\S]*not a directory/,
				);
				expect((await fs.lstat(bucket)).isSocket()).toBe(true);
			} finally {
				const closed = Promise.withResolvers<void>();
				server.close(error => (error ? closed.reject(error) : closed.resolve()));
				await closed.promise;
			}
		});
	}

	it("creates named launch worktrees from reusable branch names", async () => {
		const repo = await createRepo("gjc-launch-named-worktree-");
		const planned = planLaunchWorktree(repo, { enabled: true, detached: false, name: "feature/demo" });
		const ensured = ensureLaunchWorktree(planned);
		const expectedPath = path.join(
			path.dirname(repo),
			`${path.basename(repo)}.gajae-code-worktrees`,
			testSlug("feature/demo"),
		);

		expect(ensured.enabled && (await fs.realpath(ensured.worktreePath))).toBe(await fs.realpath(expectedPath));
		expect(ensured.enabled && ensured.branchName).toBe("feature/demo");
		expect(run("git", ["branch", "--show-current"], expectedPath)).toBe("feature/demo");
	});

	it("keeps launch worktree slugs collision-resistant for similar branch names", async () => {
		const repo = await createRepo("gjc-launch-collision-worktree-");
		const slashPlan = planLaunchWorktree(repo, { enabled: true, detached: false, name: "feature/demo" });
		const dashPlan = planLaunchWorktree(repo, { enabled: true, detached: false, name: "feature-demo" });
		const casePlan = planLaunchWorktree(repo, { enabled: true, detached: false, name: "Feature" });
		const lowerPlan = planLaunchWorktree(repo, { enabled: true, detached: false, name: "feature" });
		const unicodePlan = planLaunchWorktree(repo, { enabled: true, detached: false, name: "é" });
		const asciiPlan = planLaunchWorktree(repo, { enabled: true, detached: false, name: "e9" });

		expect(slashPlan.enabled && slashPlan.worktreePath.endsWith(testSlug("feature/demo"))).toBe(true);
		expect(dashPlan.enabled && dashPlan.worktreePath.endsWith(testSlug("feature-demo"))).toBe(true);
		expect(slashPlan.enabled && dashPlan.enabled && slashPlan.worktreePath).not.toBe(
			dashPlan.enabled && dashPlan.worktreePath,
		);
		expect(casePlan.enabled && lowerPlan.enabled && casePlan.worktreePath).not.toBe(
			lowerPlan.enabled && lowerPlan.worktreePath,
		);
		expect(unicodePlan.enabled && asciiPlan.enabled && unicodePlan.worktreePath).not.toBe(
			asciiPlan.enabled && asciiPlan.worktreePath,
		);
	});

	it("uses the launch worktree as the generated tmux cwd", async () => {
		const repo = await createRepo("gjc-session-worktree-");
		const launch = prepareLaunchWorktree(repo, ["--worktree"]);
		const parsed = { messages: [], fileArgs: [], unknownFlags: new Map(), tmux: true } satisfies Args;
		const plan = buildDefaultTmuxLaunchPlan({
			parsed,
			rawArgs: launch.args,
			cwd: launch.cwd,
			env: {},
			argv: ["/usr/local/bin/gjc"],
			execPath: "/bin/bun",
			platform: "darwin",
			tty: { stdin: true, stdout: true },
			tmuxAvailable: true,
			existingBranchSessionName: null,
		});

		expect(plan?.cwd).toBe(launch.cwd);
		expect(plan?.newSessionArgs).toContain(launch.cwd);
	});
});
