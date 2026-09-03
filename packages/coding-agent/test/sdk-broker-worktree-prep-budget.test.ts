import { expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import {
	DependencyPreparationTimeoutError,
	ensureReusableNodeModules,
	planLaunchWorktree,
	WorktreePreparationTimeoutError,
} from "../src/gjc-runtime/launch-worktree";
import { Broker } from "../src/sdk/broker/broker";
import {
	deriveLifecycleDeadlines,
	hasValidLifecycleDeadlines,
	setEnsureLaunchWorktreeForTest,
	setEnsureReusableNodeModulesForTest,
	setLifecycleCommandResolverForTest,
	setLifecycleTimingForTest,
} from "../src/sdk/broker/lifecycle";

async function createRepo(root: string): Promise<string> {
	const repo = path.join(root, "repo");
	await fs.mkdir(repo, { recursive: true });
	for (const args of [
		["init"],
		["config", "user.email", "lifecycle@example.test"],
		["config", "user.name", "Lifecycle Test"],
	]) {
		const result = Bun.spawnSync(["git", ...args], { cwd: repo, stdout: "pipe", stderr: "pipe" });
		if (result.exitCode !== 0) throw new Error(result.stderr.toString());
	}
	await fs.writeFile(path.join(repo, "README"), "fixture\n");
	await fs.writeFile(path.join(repo, ".gitignore"), "/.worktrees\n");
	const added = Bun.spawnSync(["git", "add", "README", ".gitignore"], { cwd: repo, stdout: "pipe", stderr: "pipe" });
	if (added.exitCode !== 0) throw new Error(added.stderr.toString());
	const commit = Bun.spawnSync(["git", "commit", "-m", "fixture"], { cwd: repo, stdout: "pipe", stderr: "pipe" });
	if (commit.exitCode !== 0) throw new Error(commit.stderr.toString());
	return repo;
}

test("RED A: slow worktree prep no longer spends the child semantic readiness clock", async () => {
	const root = await fs.mkdtemp(path.join(process.env.TMPDIR ?? "/tmp", "gjc-prep-budget-a-"));
	const agentDir = path.join(root, "agent");
	const broker = new Broker({ agentDir });
	let now = 1_000_000;
	let spawnCount = 0;
	try {
		const repo = await createRepo(root);
		const planned = planLaunchWorktree(repo, { enabled: true, detached: false, name: "feat" });
		if (!planned.enabled) throw new Error("expected worktree plan");
		setLifecycleTimingForTest(broker, {
			now: () => now,
			sleep: async ms => {
				now += ms;
			},
		});
		setEnsureLaunchWorktreeForTest(broker, async () => {
			now += 9_000;
			await fs.mkdir(planned.worktreePath, { recursive: true });
			return {
				enabled: true,
				cwd: planned.worktreePath,
				created: true,
				reused: false,
				createdBranch: true,
				branch: "feat",
			};
		});
		setEnsureReusableNodeModulesForTest(broker, async () => "present");
		setLifecycleCommandResolverForTest(broker, () => {
			spawnCount += 1;
			throw new Error("stop after spawn authorization");
		});
		await broker.start();
		const response = await broker.handleRequest(
			"session.create",
			{
				cwd: repo,
				stateRoot: path.join(repo, ".gjc", "state"),
				target: { worktree: { enabled: true, name: "feat" } },
				readinessTimeoutMs: 10_000,
			},
			"prep-budget-a",
		);
		expect(spawnCount).toBe(1);
		expect(response).toMatchObject({
			ok: false,
			error: { code: "spawn_failed", message: expect.stringContaining("stop after spawn authorization") },
		});
		expect(response).not.toMatchObject({ error: { code: "readiness_timeout" } });
		expect(response).not.toMatchObject({ error: { code: "worktree_preparation_timeout" } });
		const rows = (await fs.readFile(path.join(agentDir, "sdk", "lifecycle-ledger.jsonl"), "utf8"))
			.split("\n")
			.filter(Boolean)
			.map(line => JSON.parse(line) as Record<string, unknown>);
		const withEffects = rows.findLast(row => {
			const effects = row.durableEffects as { timings?: { worktreePreparationMs?: number } } | undefined;
			return typeof effects?.timings?.worktreePreparationMs === "number";
		});
		const withIntent = rows.findLast(
			row =>
				typeof (row.effectIntent as { lifecycleCleanupDeadlineAt?: number } | undefined)
					?.lifecycleCleanupDeadlineAt === "number",
		);
		const effectIntent = (withIntent?.effectIntent ?? withEffects?.effectIntent) as
			| { lifecycleCleanupDeadlineAt?: number }
			| undefined;
		const durable = withEffects?.durableEffects as {
			timings?: { worktreePreparationMs?: number };
			worktree?: { createdBranch?: boolean };
		};
		expect(durable?.timings?.worktreePreparationMs).toBeGreaterThanOrEqual(9_000);
		expect(durable?.worktree?.createdBranch).toBe(true);
		expect(effectIntent?.lifecycleCleanupDeadlineAt).toBe(1_000_000 + 70_000);
		const childCleanup = deriveLifecycleDeadlines(1_000_000 + 9_000, 10_000).lifecycleCleanupDeadlineAt;
		expect(effectIntent?.lifecycleCleanupDeadlineAt).not.toBe(childCleanup);
		expect(hasValidLifecycleDeadlines(deriveLifecycleDeadlines(1_000_000 + 9_000, 10_000), 1_000_000 + 9_000)).toBe(
			true,
		);
	} finally {
		setEnsureLaunchWorktreeForTest(broker, undefined);
		setEnsureReusableNodeModulesForTest(broker, undefined);
		setLifecycleCommandResolverForTest(broker, undefined);
		setLifecycleTimingForTest(broker, undefined);
		await broker.stop();
		await fs.rm(root, { recursive: true, force: true });
	}
}, 20_000);

test("RED B: worktree prep timeout does not spawn a child", async () => {
	const root = await fs.mkdtemp(path.join(process.env.TMPDIR ?? "/tmp", "gjc-prep-budget-b-"));
	const agentDir = path.join(root, "agent");
	const broker = new Broker({ agentDir });
	let now = 1_000_000;
	let spawnCount = 0;
	try {
		const repo = await createRepo(root);
		const planned = planLaunchWorktree(repo, { enabled: true, detached: false, name: "slow" });
		if (!planned.enabled) throw new Error("expected worktree plan");
		setLifecycleTimingForTest(broker, {
			now: () => now,
			sleep: async ms => {
				now += ms;
			},
		});
		setEnsureLaunchWorktreeForTest(broker, async (_plan, opts) => {
			if (opts.signal.aborted || now >= opts.deadlineAt) throw new WorktreePreparationTimeoutError();
			await new Promise<void>((_, reject) => {
				const fail = (): void => reject(new WorktreePreparationTimeoutError());
				opts.signal.addEventListener("abort", fail, { once: true });
				now = opts.deadlineAt;
			});
			throw new WorktreePreparationTimeoutError();
		});
		setEnsureReusableNodeModulesForTest(broker, async () => "present");
		setLifecycleCommandResolverForTest(broker, () => {
			spawnCount += 1;
			return { file: "/bin/false", args: [] };
		});
		await broker.start();
		const response = await broker.handleRequest(
			"session.create",
			{
				cwd: repo,
				target: { worktree: { enabled: true, name: "slow" } },
				worktreePreparationTimeoutMs: 1_000,
				dependencyPreparationTimeoutMs: 1_000,
				readinessTimeoutMs: 4_000,
			},
			"prep-budget-b",
		);
		expect(response).toMatchObject({ ok: false, error: { code: "worktree_preparation_timeout" } });
		expect(spawnCount).toBe(0);
	} finally {
		setEnsureLaunchWorktreeForTest(broker, undefined);
		setEnsureReusableNodeModulesForTest(broker, undefined);
		setLifecycleCommandResolverForTest(broker, undefined);
		setLifecycleTimingForTest(broker, undefined);
		await broker.stop();
		await fs.rm(root, { recursive: true, force: true });
	}
}, 20_000);

test("dependency prep timeout retains the created worktree and concurrent content", async () => {
	const root = await fs.mkdtemp(path.join(process.env.TMPDIR ?? "/tmp", "gjc-prep-budget-retain-"));
	const agentDir = path.join(root, "agent");
	const broker = new Broker({ agentDir });
	try {
		const repo = await createRepo(root);
		await fs.appendFile(path.join(repo, ".gitignore"), "/ignored-dependency.txt\n");
		for (const args of [
			["add", ".gitignore"],
			["commit", "-m", "ignore dependency output"],
		]) {
			const result = Bun.spawnSync(["git", ...args], { cwd: repo, stdout: "pipe", stderr: "pipe" });
			if (result.exitCode !== 0) throw new Error(result.stderr.toString());
		}
		const planned = planLaunchWorktree(repo, { enabled: true, detached: false, name: "dependency-timeout" });
		if (!planned.enabled) throw new Error("expected worktree plan");
		setEnsureReusableNodeModulesForTest(broker, async (_sourceRoot, worktreePath) => {
			await fs.writeFile(path.join(worktreePath, "README"), "tracked change\n");
			await fs.writeFile(path.join(worktreePath, "untracked-dependency.txt"), "untracked\n");
			await fs.writeFile(path.join(worktreePath, "ignored-dependency.txt"), "ignored\n");
			throw new DependencyPreparationTimeoutError();
		});
		await broker.start();

		const response = await broker.handleRequest(
			"session.create",
			{
				cwd: repo,
				stateRoot: path.join(repo, ".gjc", "state"),
				target: { worktree: { enabled: true, name: "dependency-timeout" } },
				worktreePreparationTimeoutMs: 5_000,
				dependencyPreparationTimeoutMs: 5_000,
				readinessTimeoutMs: 4_000,
			},
			"prep-budget-retain",
		);

		expect(response).toMatchObject({ ok: false, error: { code: "dependency_preparation_timeout" } });
		expect(await fs.readFile(path.join(planned.worktreePath, "README"), "utf8")).toBe("tracked change\n");
		expect(await fs.readFile(path.join(planned.worktreePath, "untracked-dependency.txt"), "utf8")).toBe(
			"untracked\n",
		);
		expect(await fs.readFile(path.join(planned.worktreePath, "ignored-dependency.txt"), "utf8")).toBe("ignored\n");
	} finally {
		setEnsureReusableNodeModulesForTest(broker, undefined);
		await broker.stop();
		await fs.rm(root, { recursive: true, force: true });
	}
}, 20_000);

test("RED C: child readiness timeout is distinct from prep time", async () => {
	const root = await fs.mkdtemp(path.join(process.env.TMPDIR ?? "/tmp", "gjc-prep-budget-c-"));
	const agentDir = path.join(root, "agent");
	const broker = new Broker({ agentDir });
	let now = 1_000_000;
	let spawnCount = 0;
	try {
		const repo = await createRepo(root);
		const planned = planLaunchWorktree(repo, { enabled: true, detached: false, name: "hung" });
		if (!planned.enabled) throw new Error("expected worktree plan");
		setLifecycleTimingForTest(broker, {
			now: () => now,
			sleep: async ms => {
				now += ms;
			},
		});
		setEnsureLaunchWorktreeForTest(broker, async () => {
			await fs.mkdir(planned.worktreePath, { recursive: true });
			return {
				enabled: true,
				cwd: planned.worktreePath,
				created: true,
				reused: false,
				createdBranch: true,
				branch: "hung",
			};
		});
		setEnsureReusableNodeModulesForTest(broker, async () => "present");
		setLifecycleCommandResolverForTest(broker, () => {
			spawnCount += 1;
			return { file: "/usr/bin/yes", args: [] };
		});
		await broker.start();
		const response = await broker.handleRequest(
			"session.create",
			{
				cwd: repo,
				target: { worktree: { enabled: true, name: "hung" } },
				readinessTimeoutMs: 4_000,
			},
			"prep-budget-c",
		);
		expect(response.ok).toBe(false);
		expect((response as { error?: { code?: string } }).error?.code).not.toBe("worktree_preparation_timeout");
		expect((response as { error?: { code?: string } }).error?.code).not.toBe("dependency_preparation_timeout");
		expect(spawnCount).toBe(1);
		expect((response as { error?: { message?: string } }).error?.message).not.toMatch(
			/Lifecycle preparation exhausted the semantic readiness deadline before spawning/,
		);
	} finally {
		setEnsureLaunchWorktreeForTest(broker, undefined);
		setEnsureReusableNodeModulesForTest(broker, undefined);
		setLifecycleCommandResolverForTest(broker, undefined);
		setLifecycleTimingForTest(broker, undefined);
		await broker.stop();
		await fs.rm(root, { recursive: true, force: true });
	}
}, 20_000);

test("worktreePlan plus supplied child 5-tuple is invalid_input", async () => {
	const root = await fs.mkdtemp(path.join(process.env.TMPDIR ?? "/tmp", "gjc-prep-tuple-"));
	const agentDir = path.join(root, "agent");
	const broker = new Broker({ agentDir });
	try {
		const repo = await createRepo(root);
		await broker.start();
		const deadlines = deriveLifecycleDeadlines(1_000_000, 4_000);
		const response = await broker.handleRequest(
			"session.create",
			{
				cwd: repo,
				target: { worktree: { enabled: true, name: "tuple" } },
				...deadlines,
			},
			"prep-tuple",
		);
		expect(response).toMatchObject({ ok: false, error: { code: "invalid_input" } });
	} finally {
		await broker.stop();
		await fs.rm(root, { recursive: true, force: true });
	}
}, 20_000);
test("dependency install failures redact TOKEN= values from the thrown message", async () => {
	const root = await fs.mkdtemp(path.join(process.env.TMPDIR ?? "/tmp", "gjc-prep-secret-"));
	try {
		const repo = await createRepo(root);
		await fs.writeFile(
			path.join(repo, "package.json"),
			JSON.stringify({
				name: "secret-workspace",
				private: true,
				packageManager: "npm@1.0.0",
				workspaces: ["packages/*"],
			}),
		);
		await fs.mkdir(path.join(repo, "packages", "app"), { recursive: true });
		await fs.writeFile(
			path.join(repo, "packages", "app", "package.json"),
			JSON.stringify({ name: "app", version: "1.0.0" }),
		);
		let thrown: unknown;
		try {
			ensureReusableNodeModules(repo, repo);
		} catch (error) {
			thrown = error;
		}
		expect(thrown).toBeInstanceOf(Error);
		const message = thrown instanceof Error ? thrown.message : String(thrown);
		expect(message).toContain("worktree_dependency");
		expect(message).not.toMatch(/TOKEN=secret/i);
	} finally {
		await fs.rm(root, { recursive: true, force: true });
	}
});
