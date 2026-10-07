import { expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { FileLockTestHooks } from "../src/config/file-lock";
import { planLaunchWorktree } from "../src/gjc-runtime/launch-worktree";
import { Broker, type BrokerResponse } from "../src/sdk/broker/broker";
import { setLifecycleCommandResolverForTest } from "../src/sdk/broker/lifecycle";
import { SessionIndex } from "../src/sdk/broker/session-index";

for (const outcome of ["throw", "cancel", "teardown", "timeout", "late ack"] as const) {
	test(`managed create reconciles a real queued registration after ${outcome}`, async () => {
		const root = await fs.mkdtemp(path.join(process.env.TMPDIR ?? "/tmp", "gjc-registration-order-"));
		const repo = path.join(root, "repo");
		const agentDir = path.join(root, "agent");
		const broker = new Broker({ agentDir });
		const writer = new SessionIndex(agentDir);
		const entered = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		const previousHook = FileLockTestHooks.afterParentMkdir;
		let pending: Promise<unknown> | undefined;
		let request: Promise<BrokerResponse> | undefined;
		let spawnCount = 0;
		try {
			await fs.mkdir(repo);
			await Bun.write(path.join(repo, ".gitignore"), "/.worktrees\n");
			for (const args of [
				["init"],
				["add", ".gitignore"],
				["-c", "user.name=Test", "-c", "user.email=test@example.test", "commit", "--allow-empty", "-m", "fixture"],
			]) {
				const result = Bun.spawnSync(["git", ...args], { cwd: repo, stdout: "pipe", stderr: "pipe" });
				if (result.exitCode !== 0) throw new Error(result.stderr.toString());
			}
			const plan = planLaunchWorktree(repo, { enabled: true, detached: false, name: "shared" });
			if (!plan.enabled) throw new Error("Expected managed worktree plan");
			await broker.start();
			const registration = {
				type: "host_registered" as const,
				sessionId: "concurrent-owner",
				locator: { cwd: plan.worktreePath, worktreeRoot: plan.worktreePath, stateRoot: path.join(root, "state") },
				endpointGeneration: 1,
				pid: process.pid,
			};
			if (outcome === "teardown") await writer.append(registration);
			await broker.index.refresh();
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
				if (outcome === "throw") throw new Error("registration failed before commit");
			};
			pending = writer
				.append(outcome === "teardown" ? { ...registration, type: "host_unregistered" } : registration)
				.then(
					value => ({ value }),
					error => ({ error }),
				);
			await entered.promise;
			if (outcome === "cancel" || outcome === "timeout") {
				// Abandoning the registration caller's observation does not cancel its durable append.
				const abandoned = Promise.withResolvers<never>();
				const signal = outcome === "cancel" ? AbortSignal.abort() : AbortSignal.timeout(1);
				if (signal.aborted) abandoned.reject(signal.reason);
				else signal.addEventListener("abort", () => abandoned.reject(signal.reason), { once: true });
				await expect(Promise.race([pending, abandoned.promise])).rejects.toMatchObject({
					name: outcome === "cancel" ? "AbortError" : "TimeoutError",
				});
			}
			request = broker.handleRequest(
				"session.create",
				{ cwd: repo, target: { worktree: { enabled: true, name: "shared" } } },
				`registration-${outcome}`,
			);
			const premature = await Promise.race([
				request.then(response => ({ response })),
				Bun.sleep(200).then(() => undefined),
			]);
			release.resolve();
			const writerResult = await pending;
			if (outcome === "throw") expect(writerResult).toMatchObject({ error: expect.any(Error) });
			const response = await request;
			const vacant = outcome === "throw" || outcome === "teardown";
			expect(response).toMatchObject({ ok: false, error: { code: vacant ? "spawn_failed" : "worktree_in_use" } });
			if (vacant)
				expect(response).toMatchObject({
					error: { message: expect.stringContaining("unit test stops at spawn authorization") },
				});
			expect(spawnCount).toBe(vacant ? 1 : 0);
			expect(premature).toBeUndefined();
			if (outcome !== "throw" && outcome !== "teardown") {
				expect(
					await broker.handleRequest(
						"session.create",
						{ cwd: repo, target: { worktree: { enabled: true, name: "shared" } } },
						`registration-${outcome}`,
					),
				).toEqual(response);
			}
		} finally {
			release.resolve();
			FileLockTestHooks.afterParentMkdir = previousHook;
			await pending;
			await request?.catch(() => {});
			setLifecycleCommandResolverForTest(broker, undefined);
			await broker.stop();
			await fs.rm(root, { recursive: true, force: true });
		}
	}, 20_000);
}
