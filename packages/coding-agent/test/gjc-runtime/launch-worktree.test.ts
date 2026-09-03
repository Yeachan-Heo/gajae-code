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
	asLaunchWorktreeGuardError,
	ensureLaunchWorktree,
	ensureLaunchWorktreeCancellable,
	ensureReusableNodeModules,
	LaunchWorktreeGuardError,
	parseLaunchWorktreeMode,
	planLaunchWorktree,
	prepareLaunchWorktree,
	resolveWorktreeBucketForPath,
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

/** Runs `body` with the bucket override applied, restoring the caller's environment. */
function withWorktreeBucketDir<T>(value: string, body: () => T): T {
	const previous = process.env.GJC_WORKTREE_DIR;
	process.env.GJC_WORKTREE_DIR = value;
	try {
		return body();
	} finally {
		if (previous === undefined) delete process.env.GJC_WORKTREE_DIR;
		else process.env.GJC_WORKTREE_DIR = previous;
	}
}

async function createRepo(prefix: string): Promise<string> {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
	cleanupRoots.push(root);
	run("git", ["init"], root);
	run("git", ["config", "user.email", "test@example.com"], root);
	run("git", ["config", "user.name", "Test User"], root);
	await Bun.write(path.join(root, "README.md"), "hello\n");
	await Bun.write(path.join(root, ".gitignore"), "/.worktrees\n");
	run("git", ["add", "README.md", ".gitignore"], root);
	run("git", ["commit", "-m", "init"], root);
	return root;
}

afterEach(async () => {
	for (const root of cleanupRoots.splice(0)) {
		const bucket = path.join(root, ".worktrees");
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
			remainingArgs: ["--", "hello"],
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
			remainingArgs: ["--", "hello"],
		});
		expect(parseLaunchWorktreeMode(["-w=feature/demo", "hello"])).toEqual({
			mode: { enabled: true, detached: false, name: "feature/demo" },
			remainingArgs: ["hello"],
		});
		expect(parseLaunchWorktreeMode(["--", "--worktree", "feature/demo"])).toEqual({
			mode: { enabled: false },
			remainingArgs: ["--", "--worktree", "feature/demo"],
		});
	});

	it("creates and reuses a detached launch worktree inside the source repo", async () => {
		const repo = await createRepo("gjc-launch-worktree-");
		await fs.mkdir(path.join(repo, "node_modules"));

		const first = prepareLaunchWorktree(repo, ["--worktree", "--", "hello"]);
		const branchSlug = testSlug(run("git", ["branch", "--show-current"], repo));
		const expectedPath = path.join(repo, ".worktrees", branchSlug);

		expect(await fs.realpath(first.cwd)).toBe(await fs.realpath(expectedPath));
		expect(first.args).toEqual(["--", "hello"]);
		expect(first.worktree.enabled && first.worktree.created).toBe(true);
		expect(first.worktree.enabled && first.worktree.detached).toBe(true);
		expect(await Bun.file(path.join(expectedPath, ".git")).exists()).toBe(true);
		expect((await fs.lstat(path.join(expectedPath, "node_modules"))).isSymbolicLink()).toBe(true);

		const second = prepareLaunchWorktree(repo, ["--worktree", "--slow", "opus"]);
		expect(await fs.realpath(second.cwd)).toBe(await fs.realpath(expectedPath));
		expect(second.worktree.enabled && second.worktree.reused).toBe(true);
	});

	for (const manager of ["bun", "npm", "pnpm"] as const) {
		it(`installs ${manager} workspace dependencies locally instead of linking the source tree`, async () => {
			const repo = await createRepo(`gjc-launch-worktree-${manager}-workspace-`);
			const managerAvailable = manager === "bun" || Bun.which(manager) !== null;
			const packageManagerVersion =
				manager === "bun"
					? Bun.version
					: managerAvailable
						? run(manager, ["--version"], os.tmpdir())
						: manager === "pnpm"
							? "10.14.0"
							: "11.5.2";
			const rootManifest = {
				name: "workspace-root",
				private: true,
				packageManager: `${manager}@${packageManagerVersion}`,
				...(manager === "pnpm" ? {} : { workspaces: ["packages/*"] }),
				devDependencies: { "@scope/app": manager === "npm" ? "1.0.0" : "workspace:*" },
			};
			await Bun.write(path.join(repo, "package.json"), JSON.stringify(rootManifest));
			if (manager === "pnpm") await Bun.write(path.join(repo, "pnpm-workspace.yaml"), "packages:\n  - packages/*\n");
			await fs.mkdir(path.join(repo, "packages", "app"), { recursive: true });
			await Bun.write(
				path.join(repo, "packages", "app", "package.json"),
				JSON.stringify({ name: "@scope/app", version: "1.0.0", exports: "./index.js" }),
			);
			await Bun.write(path.join(repo, "packages", "app", "index.js"), 'export const source = "worktree";\n');
			const installCommand = managerAvailable
				? { command: manager, args: ["install"] }
				: { command: "bun", args: ["x", `${manager}@${packageManagerVersion}`, "install"] };
			run(installCommand.command, installCommand.args, repo);
			const lockfile = manager === "bun" ? "bun.lock" : manager === "pnpm" ? "pnpm-lock.yaml" : "package-lock.json";
			run(
				"git",
				["add", "package.json", lockfile, "packages", ...(manager === "pnpm" ? ["pnpm-workspace.yaml"] : [])],
				repo,
			);
			run("git", ["commit", "-m", "workspace"], repo);

			const plan = planLaunchWorktree(repo, { enabled: true, detached: false, name: `${manager}-workspace` });
			if (!plan.enabled) throw new Error("expected enabled worktree plan");
			const worktree = ensureLaunchWorktree(plan);
			if (!worktree.enabled) throw new Error("expected enabled worktree");
			fsSync.symlinkSync(
				path.join(repo, "node_modules"),
				path.join(worktree.worktreePath, "node_modules"),
				"junction",
			);
			expect(ensureReusableNodeModules(repo, worktree.worktreePath)).toBe("present");

			const launched = prepareLaunchWorktree(repo, ["--worktree", `${manager}-workspace`]);
			const worktreeModules = path.join(launched.cwd, "node_modules");
			expect((await fs.lstat(worktreeModules)).isSymbolicLink()).toBe(false);
			expect(await fs.realpath(path.join(worktreeModules, "@scope", "app"))).toBe(
				path.join(launched.cwd, "packages", "app"),
			);
			expect(await fs.realpath(path.join(repo, "node_modules", "@scope", "app"))).toBe(
				path.join(repo, "packages", "app"),
			);
		}, 30_000);
	}

	it("refuses an unowned external node_modules link instead of installing through it", async () => {
		const repo = await createRepo("gjc-launch-worktree-external-modules-");
		await Bun.write(
			path.join(repo, "package.json"),
			JSON.stringify({
				name: "workspace-root",
				private: true,
				packageManager: `bun@${Bun.version}`,
				workspaces: [],
			}),
		);
		run("git", ["add", "package.json"], repo);
		run("git", ["commit", "-m", "workspace"], repo);

		const plan = planLaunchWorktree(repo, { enabled: true, detached: false, name: "external-modules" });
		if (!plan.enabled) throw new Error("expected enabled worktree plan");
		const worktree = ensureLaunchWorktree(plan);
		if (!worktree.enabled) throw new Error("expected enabled worktree");
		const externalModules = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-external-node-modules-"));
		cleanupPaths.push(externalModules);
		const target = path.join(worktree.worktreePath, "node_modules");
		fsSync.symlinkSync(externalModules, target, "junction");

		expect(() => ensureReusableNodeModules(repo, worktree.worktreePath)).toThrow(/worktree_node_modules_not_local:/);
		expect(await fs.realpath(target)).toBe(externalModules);
	});

	it("creates launch worktrees under the canonical source repo when launched from an existing worktree", async () => {
		const repo = await fs.realpath(await createRepo("gjc-launch-nested-source-worktree-"));
		const first = prepareLaunchWorktree(repo, ["--worktree"]);
		expect(first.worktree.enabled && first.worktree.created).toBe(true);

		const second = prepareLaunchWorktree(first.cwd, ["--worktree", "feature/nested"]);
		const expectedPath = path.join(repo, ".worktrees", testSlug("feature/nested"));

		expect(second.worktree.enabled && second.worktree.repoRoot).toBe(repo);
		expect(await fs.realpath(second.cwd)).toBe(await fs.realpath(expectedPath));
		expect(
			second.cwd.includes(`${path.sep}.worktrees${path.sep}${path.basename(first.cwd)}${path.sep}.worktrees`),
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
		const expectedPath = path.join(repo, ".worktrees", testSlug("feat/hud-ui-alignment"));

		expect(await fs.realpath(named.cwd)).toBe(await fs.realpath(expectedPath));
		expect(named.worktree.enabled && named.worktree.branchName).toBe("feat/hud-ui-alignment");
		expect(run("git", ["branch", "--show-current"], named.cwd)).toBe("feat/hud-ui-alignment");
	});

	it("reports a private, platform-neutral error for a broken bucket symlink without deleting it", async () => {
		const repo = await createRepo("gjc launch 'broken-bucket-symlink-");
		const bucket = path.join(repo, ".worktrees");
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
		const bucket = path.join(repo, ".worktrees");
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
		const bucket = path.join(repo, ".worktrees");
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
		const bucket = path.join(repo, ".worktrees");
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
		const bucket = path.join(repo, ".worktrees");
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
		const bucket = path.join(repo, ".worktrees");
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
			const bucket = path.join(repo, ".worktrees");
			const created = Bun.spawnSync(["mkfifo", bucket], { stdout: "pipe", stderr: "pipe" });
			expect(created.exitCode).toBe(0);

			expect(() => prepareLaunchWorktree(repo, ["--worktree", "feature/demo"])).toThrow(
				/worktree_bucket_not_directory[\s\S]*not a directory/,
			);
			expect((await fs.lstat(bucket)).isFIFO()).toBe(true);
		});

		it("reports a Unix socket bucket as a non-directory without deleting it", async () => {
			const repo = await createRepo("gjc-launch-bucket-socket-");
			const bucket = path.join(repo, ".worktrees");
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
		const expectedPath = path.join(repo, ".worktrees", testSlug("feature/demo"));

		expect(ensured.enabled && (await fs.realpath(ensured.worktreePath))).toBe(await fs.realpath(expectedPath));
		expect(ensured.enabled && ensured.branchName).toBe("feature/demo");
		expect(run("git", ["branch", "--show-current"], expectedPath)).toBe("feature/demo");
	});

	it("rejects an occupied nested path instead of adopting the source repository", async () => {
		const repo = await createRepo("gjc-launch-occupied-worktree-");
		const planned = planLaunchWorktree(repo, { enabled: true, detached: false, name: "feature/demo" });
		if (!planned.enabled) throw new Error("expected enabled worktree plan");
		await fs.mkdir(planned.worktreePath, { recursive: true });
		await Bun.write(path.join(planned.worktreePath, "occupied"), "conflict\n");

		expect(() => ensureLaunchWorktree(planned)).toThrow(/worktree_path_conflict/);
	});

	it("rejects a missing locked worktree instead of running status in its absent path", async () => {
		const repo = await createRepo("gjc-launch-locked-worktree-");
		const planned = planLaunchWorktree(repo, { enabled: true, detached: false, name: "feature/demo" });
		const ensured = ensureLaunchWorktree(planned);
		if (!ensured.enabled) throw new Error("expected enabled worktree");

		run("git", ["worktree", "lock", "--reason", "regression test", ensured.worktreePath], repo);
		await fs.rm(ensured.worktreePath, { recursive: true, force: true });

		expect(() => ensureLaunchWorktree(planned)).toThrow(
			/worktree_path_unavailable[\s\S]*still registered by Git[\s\S]*inspect the worktree lock/,
		);
		run("git", ["worktree", "unlock", ensured.worktreePath], repo);
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

	it("adopts an existing sibling bucket named by the GJC_WORKTREE_DIR template", async () => {
		const repo = await createRepo("gjc-launch-bucket-env-");
		const bucket = path.join(path.dirname(repo), `${path.basename(repo)}.worktrees`);
		cleanupPaths.push(bucket);

		const ensured = withWorktreeBucketDir("{repo}.worktrees", () =>
			ensureLaunchWorktree(planLaunchWorktree(repo, { enabled: true, detached: false, name: "feature/demo" })),
		);

		expect(ensured.enabled && (await fs.realpath(ensured.worktreePath))).toBe(
			await fs.realpath(path.join(bucket, testSlug("feature/demo"))),
		);
		expect(run("git", ["branch", "--show-current"], path.join(bucket, testSlug("feature/demo")))).toBe(
			"feature/demo",
		);
		expect(fsSync.existsSync(path.join(repo, ".worktrees"))).toBe(false);
	});

	it("keeps the template repo-scoped so two repos never share one worktree path", async () => {
		const first = await createRepo("gjc-launch-bucket-shared-a-");
		const second = await createRepo("gjc-launch-bucket-shared-b-");
		const shared = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-launch-bucket-shared-root-"));
		cleanupPaths.push(shared);

		const plans = withWorktreeBucketDir(path.join(shared, "{repo}"), () => [
			planLaunchWorktree(first, { enabled: true, detached: false, name: "feature/demo" }),
			planLaunchWorktree(second, { enabled: true, detached: false, name: "feature/demo" }),
		]);

		expect(plans[0].enabled && path.dirname(plans[0].worktreePath)).toBe(path.join(shared, path.basename(first)));
		expect(plans[1].enabled && path.dirname(plans[1].worktreePath)).toBe(path.join(shared, path.basename(second)));
	});

	it("expands a home-relative override and falls back to the default bucket when unset", async () => {
		const repo = await createRepo("gjc-launch-bucket-home-");
		const homePlan = withWorktreeBucketDir("~/gjc-worktrees", () =>
			planLaunchWorktree(repo, { enabled: true, detached: false, name: "feature/demo" }),
		);
		const blankPlan = withWorktreeBucketDir("   ", () =>
			planLaunchWorktree(repo, { enabled: true, detached: false, name: "feature/demo" }),
		);

		expect(homePlan.enabled && path.dirname(homePlan.worktreePath)).toBe(path.join(os.homedir(), "gjc-worktrees"));
		expect(blankPlan.enabled && path.dirname(blankPlan.worktreePath)).toBe(path.join(repo, ".worktrees"));
	});

	it("rejects the repository-local bucket when Git does not ignore it", async () => {
		const repo = await createRepo("gjc-launch-bucket-unignored-");
		await fs.rm(path.join(repo, ".gitignore"));
		run("git", ["add", ".gitignore"], repo);
		run("git", ["commit", "-m", "remove ignore"], repo);

		expect(() => prepareLaunchWorktree(repo, ["--worktree", "feature/demo"])).toThrow(
			/worktree_bucket_not_ignored[\s\S]*add \/.worktrees/,
		);
		expect(await Bun.file(path.join(repo, ".worktrees")).exists()).toBe(false);
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

describe("GJC_WORKTREE_DIR path red-team", () => {
	it("fails closed when a {repo}-less template points two repos at one worktree path", async () => {
		const first = await createRepo("gjc-launch-bucket-collision-a-");
		const second = await createRepo("gjc-launch-bucket-collision-b-");
		const shared = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-launch-bucket-collision-root-"));
		cleanupPaths.push(shared);
		const bucket = path.join(shared, "one-bucket-for-everything");

		const ensured = withWorktreeBucketDir(bucket, () =>
			ensureLaunchWorktree(planLaunchWorktree(first, { enabled: true, detached: false, name: "feature/demo" })),
		);
		expect(ensured.enabled && ensured.created).toBe(true);

		// The second repo resolves to the SAME worktree path. Adoption must be refused:
		// the path belongs to a different repository (git-common-dir mismatch), so the
		// launch must fail closed with worktree_path_conflict instead of reusing it.
		expect(() =>
			withWorktreeBucketDir(bucket, () =>
				ensureLaunchWorktree(planLaunchWorktree(second, { enabled: true, detached: false, name: "feature/demo" })),
			),
		).toThrow(/worktree_path_conflict/);
		expect(run("git", ["branch", "--show-current"], ensured.enabled ? ensured.worktreePath : "")).toBe(
			"feature/demo",
		);
	});

	it("fails closed when same-basename repos in different parents share a {repo} root", async () => {
		const parentA = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-launch-bucket-twin-a-"));
		const parentB = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-launch-bucket-twin-b-"));
		cleanupPaths.push(parentA, parentB);
		const twinA = path.join(parentA, "app");
		const twinB = path.join(parentB, "app");
		for (const twin of [twinA, twinB]) {
			await fs.mkdir(twin);
			run("git", ["init"], twin);
			run("git", ["config", "user.email", "test@example.com"], twin);
			run("git", ["config", "user.name", "Test User"], twin);
			await Bun.write(path.join(twin, "README.md"), "hello\n");
			run("git", ["add", "README.md"], twin);
			run("git", ["commit", "-m", "init"], twin);
		}
		const shared = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-launch-bucket-twin-root-"));
		cleanupPaths.push(shared);

		// {repo} expands to the basename only, so both twins land in <shared>/app/<slug>.
		const template = path.join(shared, "{repo}");
		const ensured = withWorktreeBucketDir(template, () =>
			ensureLaunchWorktree(planLaunchWorktree(twinA, { enabled: true, detached: false, name: "feature/demo" })),
		);
		expect(ensured.enabled && ensured.created).toBe(true);
		expect(() =>
			withWorktreeBucketDir(template, () =>
				ensureLaunchWorktree(planLaunchWorktree(twinB, { enabled: true, detached: false, name: "feature/demo" })),
			),
		).toThrow(/worktree_path_conflict/);
	});

	it("pins the traversal contract: ../ segments resolve against the repository parent", async () => {
		const repo = await createRepo("gjc-launch-bucket-traversal-");
		const plan = withWorktreeBucketDir(path.join("..", "{repo}-wt"), () =>
			planLaunchWorktree(repo, { enabled: true, detached: false, name: "feature/demo" }),
		);
		expect(plan.enabled && path.dirname(plan.worktreePath)).toBe(
			path.resolve(path.dirname(repo), "..", `${path.basename(repo)}-wt`),
		);
	});

	it("treats a backslash home prefix literally on POSIX", async () => {
		const repo = await createRepo("gjc-launch-bucket-backslash-");
		const plan = withWorktreeBucketDir("~\\gjc-worktrees\\{repo}", () =>
			planLaunchWorktree(repo, { enabled: true, detached: false, name: "feature/demo" }),
		);
		// POSIX has no `~\` home form: the value must NOT expand to the home directory
		// and must stay a relative template resolved against the repository parent.
		expect(plan.enabled && plan.worktreePath.startsWith(os.homedir())).toBe(false);
		expect(plan.enabled && path.dirname(plan.worktreePath)).toBe(
			path.join(path.dirname(repo), `~\\gjc-worktrees\\${path.basename(repo)}`),
		);
	});
});

describe("resolveWorktreeBucketForPath Windows semantics", () => {
	const home = "C:\\Users\\kim";
	const repo = "C:\\repos\\app";

	it("expands ~/ and ~\\ against the injected Windows home", () => {
		expect(resolveWorktreeBucketForPath(repo, "~/wt/{repo}", home, path.win32)).toBe("C:\\Users\\kim\\wt\\app");
		expect(resolveWorktreeBucketForPath(repo, "~\\wt\\{repo}", home, path.win32)).toBe("C:\\Users\\kim\\wt\\app");
		expect(resolveWorktreeBucketForPath(repo, "~", home, path.win32)).toBe(home);
	});

	it("honors absolute drive paths and resolves relatives against the repo parent", () => {
		expect(resolveWorktreeBucketForPath(repo, "D:\\wt\\{repo}", home, path.win32)).toBe("D:\\wt\\app");
		expect(resolveWorktreeBucketForPath(repo, "{repo}.worktrees", home, path.win32)).toBe("C:\\repos\\app.worktrees");
		expect(resolveWorktreeBucketForPath(repo, ".worktrees", home, path.win32)).toBe("C:\\repos\\.worktrees");
	});

	it("keeps UNC repos on their share for the default and relative templates", () => {
		const uncRepo = "\\\\server\\share\\app";
		expect(resolveWorktreeBucketForPath(uncRepo, undefined, home, path.win32)).toBe(
			"\\\\server\\share\\app\\.worktrees",
		);
		expect(resolveWorktreeBucketForPath(uncRepo, "{repo}.worktrees", home, path.win32)).toBe(
			"\\\\server\\share\\app.worktrees",
		);
	});

	it("preserves repo basename case verbatim and treats blanks as the default", () => {
		expect(resolveWorktreeBucketForPath("C:\\repos\\App", "{repo}.worktrees", home, path.win32)).toBe(
			"C:\\repos\\App.worktrees",
		);
		expect(resolveWorktreeBucketForPath(repo, "   ", home, path.win32)).toBe("C:\\repos\\app\\.worktrees");
	});

	it("preserves replacement-token characters in the repository basename", () => {
		expect(resolveWorktreeBucketForPath("C:\\repos\\$&`$'", "{repo}.worktrees", home, path.win32)).toBe(
			"C:\\repos\\$&`$'.worktrees",
		);
	});
});

describe("launch guard classification", () => {
	// Classification is structural: guards are thrown as LaunchWorktreeGuardError at the refusal
	// site, so a newly added guard cannot regress to the crash path by being forgotten in a list.
	it("throws a classified guard, code-prefixed, when the bucket is not git-ignored", async () => {
		const repo = await createRepo("gjc-guard-not-ignored-");
		// Drop the bucket ignore so the preflight refuses.
		await fs.rm(path.join(repo, ".gitignore"), { force: true });
		let caught: unknown;
		try {
			prepareLaunchWorktree(repo, ["--worktree"]);
		} catch (error) {
			caught = error;
		}
		const guard = asLaunchWorktreeGuardError(caught);
		expect(guard).toBeInstanceOf(LaunchWorktreeGuardError);
		expect(guard?.code).toBe("worktree_bucket_not_ignored");
		expect(guard?.message.startsWith("worktree_bucket_not_ignored")).toBe(true);
		expect(guard?.message).toContain("Safe remediation:");
	});

	// Regression: validateBranchName threw raw git stderr with no code prefix, so the guard
	// existed in name only and fell through to the crash path.
	it("prefixes the guard code even when git supplies its own branch-name diagnostic", async () => {
		const repo = await createRepo("gjc-guard-badbranch-");
		let caught: unknown;
		try {
			prepareLaunchWorktree(repo, ["--worktree=bad..name"]);
		} catch (error) {
			caught = error;
		}
		const guard = asLaunchWorktreeGuardError(caught);
		expect(guard).toBeInstanceOf(LaunchWorktreeGuardError);
		expect(guard?.code).toBe("invalid_worktree_branch");
		expect(guard?.message.startsWith("invalid_worktree_branch:")).toBe(true);
	});

	it("redacts secrets and bounds captured branch diagnostics", async () => {
		const repo = await createRepo("gjc-guard-diagnostic-bounds-");
		const secret = "SuperSecretToken123456";
		const branch = `Bearer ${secret} ${"x".repeat(20_000)}`;
		let caught: unknown;
		try {
			prepareLaunchWorktree(repo, ["--worktree", branch]);
		} catch (error) {
			caught = error;
		}
		const guard = asLaunchWorktreeGuardError(caught);
		expect(guard).toBeInstanceOf(LaunchWorktreeGuardError);
		expect(guard?.message).not.toContain(secret);
		expect(guard?.message).toContain("«redacted-auth»");
		expect(Buffer.byteLength(guard?.message ?? "", "utf8")).toBeLessThanOrEqual(16 * 1024);
		expect(guard?.message).toContain("[launch diagnostic truncated]");
	});

	it("leaves a genuine defect unclassified so it keeps full crash diagnostics", () => {
		expect(asLaunchWorktreeGuardError(new TypeError("cannot read properties of undefined"))).toBeNull();
		// A plain Error is never promoted by message shape, even if it looks like a guard.
		expect(asLaunchWorktreeGuardError(new Error("worktree_bucket_not_ignored"))).toBeNull();
		expect(asLaunchWorktreeGuardError(new Error("ENOENT: no such file"))).toBeNull();
		expect(asLaunchWorktreeGuardError("worktree_dirty:/repo")).toBeNull();
		expect(asLaunchWorktreeGuardError(null)).toBeNull();
	});

	it("passes an already-classified guard through unchanged", () => {
		const guard = new LaunchWorktreeGuardError("worktree_dirty", "worktree_dirty:/repo");
		expect(asLaunchWorktreeGuardError(guard)).toBe(guard);
	});

	it("classifies path conflicts on the cancellable preparation path", async () => {
		const repo = await createRepo("gjc-cancellable-guard-");
		const plan = planLaunchWorktree(repo, { enabled: true, detached: false, name: "occupied" });
		await fs.mkdir(path.dirname(plan.worktreePath), { recursive: true });
		await Bun.write(plan.worktreePath, "occupied\n");

		let caught: unknown;
		try {
			await ensureLaunchWorktreeCancellable(plan);
		} catch (error) {
			caught = error;
		}

		const guard = asLaunchWorktreeGuardError(caught);
		expect(guard).toBeInstanceOf(LaunchWorktreeGuardError);
		expect(guard?.code).toBe("worktree_path_conflict");
	});
});
