import { afterEach, describe, expect, it } from "bun:test";
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { runNativeRalplanCommand } from "../../src/gjc-runtime/ralplan-runtime";
import {
	assertCwdMatchesRepositoryBinding,
	assertExecutionRootMatchesRepositoryBinding,
	assertPathUnderRepositoryBinding,
	captureRepositoryBinding,
	parseRepositoryBinding,
	publicRepositoryBinding,
	REPOSITORY_BINDING_SCHEMA,
	RepositoryBindingError,
	repositoryBindingsMatch,
	resolveTaskRepositoryBinding,
} from "../../src/gjc-runtime/repository-binding";
import { buildTaskReceipt } from "../../src/task/receipt";
import type { SingleResult } from "../../src/task/types";

const tempRoots: string[] = [];

afterEach(async () => {
	await Promise.all(tempRoots.splice(0).map(dir => fsp.rm(dir, { recursive: true, force: true })));
});

async function initGitRepo(root: string): Promise<void> {
	const run = async (args: string[]) => {
		const proc = Bun.spawn(["git", ...args], { cwd: root, stdout: "pipe", stderr: "pipe" });
		const code = await proc.exited;
		if (code !== 0) {
			const err = await new Response(proc.stderr).text();
			throw new Error(`git ${args.join(" ")} failed: ${err}`);
		}
	};
	await run(["init"]);
	await run(["config", "user.email", "test@example.com"]);
	await run(["config", "user.name", "Test"]);
	await fsp.writeFile(path.join(root, "README.md"), "hello\n");
	await run(["add", "README.md"]);
	await run(["commit", "-m", "init"]);
}

describe("repository binding (#2901)", () => {
	it("captures and matches the same repository identity", async () => {
		const root = await fsp.mkdtemp(path.join(os.tmpdir(), "gjc-repo-bind-"));
		tempRoots.push(root);
		await initGitRepo(root);

		const binding = await captureRepositoryBinding(root);
		expect(binding.schema).toBe(REPOSITORY_BINDING_SCHEMA);
		expect(binding.commonDir).toBeTruthy();
		expect(path.resolve(binding.worktreeRoot)).toBe(path.resolve(root));

		const active = await assertCwdMatchesRepositoryBinding(root, binding);
		expect(repositoryBindingsMatch(active, binding)).toBe(true);
		expect(assertPathUnderRepositoryBinding(binding, "README.md")).toContain("README.md");
	});

	it("fails closed when active cwd is a sibling repository", async () => {
		const parent = await fsp.mkdtemp(path.join(os.tmpdir(), "gjc-repo-siblings-"));
		tempRoots.push(parent);
		const left = path.join(parent, "left");
		const right = path.join(parent, "right");
		await fsp.mkdir(left);
		await fsp.mkdir(right);
		await initGitRepo(left);
		await initGitRepo(right);

		const leftBinding = await captureRepositoryBinding(left);
		await expect(assertCwdMatchesRepositoryBinding(right, leftBinding)).rejects.toBeInstanceOf(
			RepositoryBindingError,
		);
		await expect(assertCwdMatchesRepositoryBinding(right, leftBinding)).rejects.toMatchObject({
			code: "identity_mismatch",
		});

		expect(() => assertPathUnderRepositoryBinding(leftBinding, path.join(right, "README.md"))).toThrow(
			/escapes bound repository root/,
		);
	});

	it("rejects relativeSubdir that escapes with ..", () => {
		expect(() =>
			parseRepositoryBinding({
				schema: REPOSITORY_BINDING_SCHEMA,
				worktreeRoot: "/tmp/repo",
				commonDir: "/tmp/repo/.git",
				relativeSubdir: "../sibling",
			}),
		).toThrow(/relativeSubdir/);
	});

	it("stamps omitted task bindings from session cwd (no implicit unbound lane)", async () => {
		const root = await fsp.mkdtemp(path.join(os.tmpdir(), "gjc-repo-stamp-"));
		tempRoots.push(root);
		await initGitRepo(root);

		const stamped = await resolveTaskRepositoryBinding(root, undefined);
		expect(stamped.schema).toBe(REPOSITORY_BINDING_SCHEMA);
		expect(path.resolve(stamped.worktreeRoot)).toBe(path.resolve(root));
		await assertExecutionRootMatchesRepositoryBinding(root, stamped);
	});

	it("rejects declared task binding that points at a sibling repo", async () => {
		const parent = await fsp.mkdtemp(path.join(os.tmpdir(), "gjc-repo-task-sib-"));
		tempRoots.push(parent);
		const left = path.join(parent, "left");
		const right = path.join(parent, "right");
		await fsp.mkdir(left);
		await fsp.mkdir(right);
		await initGitRepo(left);
		await initGitRepo(right);

		const rightBinding = await captureRepositoryBinding(right);
		await expect(resolveTaskRepositoryBinding(left, rightBinding)).rejects.toMatchObject({
			code: "identity_mismatch",
		});
	});

	it("preserves source repository identity in a linked git worktree", async () => {
		const root = await fsp.mkdtemp(path.join(os.tmpdir(), "gjc-repo-wt-"));
		tempRoots.push(root);
		const main = path.join(root, "main");
		const linked = path.join(root, "linked");
		await fsp.mkdir(main);
		await initGitRepo(main);
		const binding = await captureRepositoryBinding(main);

		const proc = Bun.spawn(["git", "worktree", "add", "--detach", linked, "HEAD"], {
			cwd: main,
			stdout: "pipe",
			stderr: "pipe",
		});
		const code = await proc.exited;
		if (code !== 0) {
			throw new Error(`git worktree add failed: ${await new Response(proc.stderr).text()}`);
		}

		const active = await assertExecutionRootMatchesRepositoryBinding(linked, binding);
		expect(repositoryBindingsMatch(active, binding)).toBe(true);
		expect(path.resolve(active.commonDir ?? "")).toBe(path.resolve(binding.commonDir ?? ""));
	});

	it("includes resolved repository identity on task receipts", () => {
		const binding = publicRepositoryBinding({
			schema: REPOSITORY_BINDING_SCHEMA,
			worktreeRoot: "/tmp/repo",
			commonDir: "/tmp/repo/.git",
			branch: "main",
			head: "abc123",
		});
		const raw = {
			index: 0,
			id: "0-Task",
			agent: "executor",
			agentSource: "bundled",
			task: "review",
			exitCode: 0,
			output: "ok",
			stderr: "",
			truncated: false,
			durationMs: 1,
			tokens: 0,
			repositoryBinding: binding,
		} satisfies SingleResult;
		const receipt = buildTaskReceipt(raw);
		expect(receipt.repositoryBinding).toEqual(binding);
	});

	it("enforces ralplan repository binding on stage write after seed", async () => {
		const parent = await fsp.mkdtemp(path.join(os.tmpdir(), "gjc-ralplan-bind-"));
		tempRoots.push(parent);
		const left = path.join(parent, "left");
		const right = path.join(parent, "right");
		await fsp.mkdir(left);
		await fsp.mkdir(right);
		await initGitRepo(left);
		await initGitRepo(right);

		const sessionId = "test-session-2901";
		const envSession = process.env.GJC_SESSION_ID;
		process.env.GJC_SESSION_ID = sessionId;
		try {
			const seed = await runNativeRalplanCommand(["--json", "binding enforce dogfood"], left);
			expect(seed.status).toBe(0);
			const seedPayload = JSON.parse(seed.stdout ?? "{}") as { repository_binding?: { worktreeRoot?: string } };
			expect(seedPayload.repository_binding?.worktreeRoot).toBeTruthy();

			const artifactPath = path.join(left, "planner-note.md");
			await fsp.writeFile(artifactPath, "# planner\n");
			const okWrite = await runNativeRalplanCommand(
				["--write", "--stage", "planner", "--stage_n", "1", "--artifact", artifactPath, "--json"],
				left,
			);
			expect(okWrite.status).toBe(0);
			const writePayload = JSON.parse(okWrite.stdout ?? "{}") as { repository_binding?: { worktreeRoot?: string } };
			expect(writePayload.repository_binding?.worktreeRoot).toBeTruthy();

			// Copy state into RIGHT under same relative session path is not how product works;
			// instead re-seed is not needed: enforce uses LEFT seed when cwd is RIGHT only if
			// state lives under RIGHT. Product path: seed on LEFT, then invoke write with cwd=RIGHT
			// cannot see LEFT state — so test sibling by reusing LEFT binding via explicit fail path:
			const leftState = path.join(left, ".gjc", `_session-${sessionId}`, "state", "ralplan-state.json");
			const rightStateDir = path.join(right, ".gjc", `_session-${sessionId}`, "state");
			await fsp.mkdir(rightStateDir, { recursive: true });
			await fsp.copyFile(leftState, path.join(rightStateDir, "ralplan-state.json"));

			const siblingWrite = await runNativeRalplanCommand(
				["--write", "--stage", "architect", "--stage_n", "1", "--artifact", "# arch\n", "--json"],
				right,
			);
			expect(siblingWrite.status).toBe(2);
			expect(siblingWrite.stderr).toMatch(/repository binding rejected|identity_mismatch|does not match/i);
		} finally {
			if (envSession === undefined) delete process.env.GJC_SESSION_ID;
			else process.env.GJC_SESSION_ID = envSession;
		}
	});
});
