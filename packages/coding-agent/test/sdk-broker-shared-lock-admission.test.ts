import { expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { acquireFileLock } from "../src/config/file-lock";
import { planLaunchWorktree } from "../src/gjc-runtime/launch-worktree";
import { Broker, type BrokerResponse } from "../src/sdk/broker/broker";
import { setLifecycleCommandResolverForTest } from "../src/sdk/broker/lifecycle";
import { SessionIndex, sessionIndexChecksum } from "../src/sdk/broker/session-index";

for (const outcome of ["throw", "cancel", "teardown", "timeout", "late ack"] as const) {
	test(`managed admission observes a shared-lock writer after ${outcome}`, async () => {
		const root = await fs.mkdtemp(path.join(process.env.TMPDIR ?? "/tmp", "gjc-shared-admission-"));
		const repo = path.join(root, "repo");
		const agentDir = path.join(root, "agent");
		const broker = new Broker({ agentDir });
		let releaseLock: (() => Promise<void>) | undefined;
		let request: Promise<BrokerResponse> | undefined;
		let spawnCount = 0;
		try {
			await fs.mkdir(repo);
			await Bun.write(path.join(repo, ".gitignore"), "/.worktrees\n");
			for (const args of [
				["init"],
				["add", ".gitignore"],
				["-c", "user.name=Test", "-c", "user.email=test@example.test", "commit", "-m", "fixture"],
			]) {
				const result = Bun.spawnSync(["git", ...args], { cwd: repo, stdout: "pipe", stderr: "pipe" });
				if (result.exitCode !== 0) throw new Error(result.stderr.toString());
			}
			const plan = planLaunchWorktree(repo, { enabled: true, detached: false, name: "shared" });
			if (!plan.enabled) throw new Error("Expected managed worktree plan");
			await broker.start();
			const baseline = await new SessionIndex(agentDir).append({
				type: "host_registered",
				sessionId: outcome === "teardown" ? "shared-owner" : "baseline",
				locator: {
					cwd: outcome === "teardown" ? plan.worktreePath : repo,
					worktreeRoot: outcome === "teardown" ? plan.worktreePath : null,
					stateRoot: path.join(root, "state"),
				},
				endpointGeneration: 1,
				pid: process.pid,
			});
			await broker.index.refresh();
			setLifecycleCommandResolverForTest(broker, () => {
				spawnCount++;
				throw new Error("unit test stops at spawn authorization");
			});
			const log = path.join(agentDir, "sdk", "sessions", "index.jsonl");
			// Hold the actual shared lock without using SessionIndex's process-local queue:
			// another host can own this lock while both durable file stamps remain unchanged.
			releaseLock = await acquireFileLock(log);
			request = broker.handleRequest(
				"session.create",
				{ cwd: repo, target: { worktree: { enabled: true, name: "shared" } } },
				`shared-lock-${outcome}`,
			);
			const premature = await Promise.race([
				request.then(response => ({ response })),
				Bun.sleep(200).then(() => undefined),
			]);
			if (outcome !== "throw") {
				const { checksum: _checksum, ...prior } = baseline;
				const event = {
					...prior,
					type: outcome === "teardown" ? ("host_unregistered" as const) : ("host_registered" as const),
					indexSeq: baseline.indexSeq + 1,
					sessionId: "shared-owner",
					locator: {
						cwd: plan.worktreePath,
						worktreeRoot: plan.worktreePath,
						stateRoot: path.join(root, "state"),
					},
				};
				await fs.appendFile(log, `${JSON.stringify({ ...event, checksum: sessionIndexChecksum(event) })}\n`);
			}
			await releaseLock();
			releaseLock = undefined;
			const response = await request;
			const vacant = outcome === "throw" || outcome === "teardown";
			expect(response).toMatchObject({ ok: false, error: { code: vacant ? "spawn_failed" : "worktree_in_use" } });
			expect(spawnCount).toBe(vacant ? 1 : 0);
			expect(premature).toBeUndefined();
		} finally {
			await releaseLock?.();
			await request?.catch(() => {});
			setLifecycleCommandResolverForTest(broker, undefined);
			await broker.stop();
			await fs.rm(root, { recursive: true, force: true });
		}
	}, 20_000);
}
