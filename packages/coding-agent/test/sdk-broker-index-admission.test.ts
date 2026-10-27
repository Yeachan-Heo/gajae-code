import { expect, spyOn, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { acquireFileLock, FileLockTestHooks } from "../src/config/file-lock";
import { planLaunchWorktree } from "../src/gjc-runtime/launch-worktree";
import { Broker, type BrokerResponse } from "../src/sdk/broker/broker";
import { setLifecycleCommandResolverForTest, setLifecycleTimingForTest } from "../src/sdk/broker/lifecycle";
import { SessionIndex, sessionIndexChecksum } from "../src/sdk/broker/session-index";

test("ordinary create reaches spawn before an unrelated queued heartbeat consumes its pre-spawn budget", async () => {
	const root = await fs.mkdtemp(path.join(process.env.TMPDIR ?? "/tmp", "gjc-index-admission-"));
	const broker = new Broker({ agentDir: path.join(root, "agent") });
	const entered = Promise.withResolvers<void>();
	const release = Promise.withResolvers<void>();
	const previousHook = FileLockTestHooks.afterParentMkdir;
	let checkpoint: Promise<number> | undefined;
	let request: Promise<BrokerResponse> | undefined;
	let now = 1_000_000;
	let spawnCount = 0;
	const runStartup = broker.runStartup.bind(broker);
	const startupSpy = spyOn(broker, "runStartup").mockImplementation((queueWaitMs, timing, task) =>
		runStartup(queueWaitMs, timing, async admittedAt => {
			checkpoint = broker.index.checkpointLiveHeartbeats();
			await entered.promise;
			return task(admittedAt);
		}),
	);
	try {
		await broker.start();
		await broker.index.refreshIfChanged();
		setLifecycleTimingForTest(broker, {
			now: () => now,
			sleep: async ms => {
				now += ms;
			},
		});
		setLifecycleCommandResolverForTest(broker, () => {
			spawnCount++;
			throw new Error("unit test stops at spawn authorization");
		});
		let blocked = false;
		FileLockTestHooks.afterParentMkdir = async lockPath => {
			if (blocked || !lockPath.includes("index.jsonl")) return;
			blocked = true;
			entered.resolve();
			await release.promise;
		};
		request = broker.handleRequest("session.create", { cwd: root }, "queued-heartbeat-create");
		const outcome = await Promise.race([
			request.then(response => ({ response })),
			Bun.sleep(500).then(() => undefined),
		]);
		// A queued refresh consumes the entire allowance when the heartbeat eventually finishes.
		if (!outcome) now += 31_000;
		release.resolve();
		await checkpoint;
		const response = await request;
		expect(response).toMatchObject({ ok: false, error: { code: "spawn_failed" } });
		expect(spawnCount).toBe(1);
		expect(outcome).toBeDefined();
		expect(await broker.handleRequest("session.create", { cwd: root }, "queued-heartbeat-create")).toEqual(response);
	} finally {
		startupSpy.mockRestore();
		release.resolve();
		FileLockTestHooks.afterParentMkdir = previousHook;
		await checkpoint?.catch(() => {});
		await request?.catch(() => {});
		setLifecycleCommandResolverForTest(broker, undefined);
		setLifecycleTimingForTest(broker, undefined);
		await broker.stop();
		await fs.rm(root, { recursive: true, force: true });
	}
}, 20_000);

test("managed worktree create waits for a shared-lock registration before checking occupancy", async () => {
	const root = await fs.mkdtemp(path.join(process.env.TMPDIR ?? "/tmp", "gjc-worktree-admission-"));
	const repo = path.join(root, "repo");
	const agentDir = path.join(root, "agent");
	const broker = new Broker({ agentDir });
	let releaseLock: (() => Promise<void>) | undefined;
	let request: Promise<BrokerResponse> | undefined;
	try {
		await fs.mkdir(repo);
		for (const args of [["init"], ["config", "user.email", "test@example.test"], ["config", "user.name", "Test"]]) {
			const result = Bun.spawnSync(["git", ...args], { cwd: repo, stdout: "pipe", stderr: "pipe" });
			if (result.exitCode !== 0) throw new Error(result.stderr.toString());
		}
		await Bun.write(path.join(repo, "README"), "fixture\n");
		for (const args of [
			["add", "README"],
			["commit", "-m", "fixture"],
		]) {
			const result = Bun.spawnSync(["git", ...args], { cwd: repo, stdout: "pipe", stderr: "pipe" });
			if (result.exitCode !== 0) throw new Error(result.stderr.toString());
		}
		const plan = planLaunchWorktree(repo, { enabled: true, detached: false, name: "shared" });
		if (!plan.enabled) throw new Error("Expected managed worktree plan");
		await broker.start();
		const baseline = await new SessionIndex(agentDir).append({
			type: "host_registered",
			sessionId: "baseline",
			locator: { cwd: repo, worktreeRoot: null, stateRoot: path.join(root, "state") },
			endpointGeneration: 1,
			pid: process.pid,
		});
		await broker.index.refresh();
		setLifecycleCommandResolverForTest(broker, () => {
			throw new Error("unit test stops at managed spawn authorization");
		});
		const { checksum: _checksum, ...event } = baseline;
		const registration = {
			...event,
			indexSeq: baseline.indexSeq + 1,
			sessionId: "concurrent-owner",
			locator: {
				cwd: plan.worktreePath,
				worktreeRoot: plan.worktreePath,
				stateRoot: path.join(root, "worktree-state"),
			},
		};
		const log = path.join(agentDir, "sdk", "sessions", "index.jsonl");
		releaseLock = await acquireFileLock(log);
		request = broker.handleRequest(
			"session.create",
			{
				cwd: repo,
				target: { worktree: { enabled: true, name: "shared" } },
			},
			"shared-lock-create",
		);
		const premature = await Promise.race([
			request.then(response => ({ response })),
			Bun.sleep(200).then(() => undefined),
		]);
		await fs.appendFile(
			log,
			`${JSON.stringify({ ...registration, checksum: sessionIndexChecksum(registration) })}\n`,
		);
		await releaseLock();
		releaseLock = undefined;
		expect(await request).toMatchObject({
			ok: false,
			error: { code: "worktree_in_use", message: expect.stringContaining("concurrent-owner") },
		});
		expect(premature).toBeUndefined();
	} finally {
		await releaseLock?.();
		await request?.catch(() => {});
		setLifecycleCommandResolverForTest(broker, undefined);
		await broker.stop();
		await fs.rm(root, { recursive: true, force: true });
	}
}, 20_000);
