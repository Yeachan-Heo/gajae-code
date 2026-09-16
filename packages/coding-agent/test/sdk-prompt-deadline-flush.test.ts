import { afterEach, describe, expect, test } from "bun:test";
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { flushWorktreeOnPromptDeadline } from "../src/sdk/prompt-deadline-flush";
import { PromptDeadlineManager } from "../src/sdk/prompt-deadline-manager";

/**
 * #5583: a prompt retired by its deadline used to tear the session down with the
 * agent's worktree dirty, losing finished work. The expiry path now flushes that
 * work to a WIP commit first — best effort, and only on the path that genuinely
 * retires the prompt.
 */

const tempRoots: string[] = [];

afterEach(async () => {
	await Promise.all(tempRoots.splice(0).map(dir => fsp.rm(dir, { recursive: true, force: true })));
});

async function run(cwd: string, args: string[]): Promise<string> {
	const proc = Bun.spawn(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
	const [code, stdout, stderr] = await Promise.all([
		proc.exited,
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
	]);
	if (code !== 0) throw new Error(`git ${args.join(" ")} failed: ${stderr}`);
	return stdout;
}

async function initRepo(prefix: string): Promise<string> {
	const root = await fsp.mkdtemp(path.join(os.tmpdir(), prefix));
	tempRoots.push(root);
	await run(root, ["init", "--initial-branch=work"]);
	await run(root, ["config", "user.email", "test@example.com"]);
	await run(root, ["config", "user.name", "Test"]);
	await fsp.writeFile(path.join(root, "README.md"), "hello\n");
	await run(root, ["add", "README.md"]);
	await run(root, ["commit", "-m", "init"]);
	return root;
}

/**
 * Reconciliation double that accepts the synthetic deadline outcome. `barrier`
 * holds `claimPendingOutcome` open so a test can land progress mid-expiry.
 */
function reconciliation(barrier?: { started: () => void; release: Promise<void> }) {
	const finalized: string[] = [];
	return {
		finalized,
		api: {
			lookup: () => ({ status: "running" }),
			claimPendingOutcome: async () => {
				barrier?.started();
				await barrier?.release;
			},
			noteTransition: async () => {},
			finalizeOutcome: async (_kind: string, _correlation: unknown, outcome: { code?: string }) => {
				finalized.push(outcome.code ?? "none");
			},
		},
	};
}

describe("flushWorktreeOnPromptDeadline", () => {
	test("commits uncommitted work so a deadline leaves the worktree clean", async () => {
		const root = await initRepo("gjc-deadline-flush-");
		const headBefore = (await run(root, ["rev-parse", "HEAD"])).trim();
		await fsp.writeFile(path.join(root, "README.md"), "edited by the agent\n");
		await fsp.writeFile(path.join(root, "new-file.ts"), "export const answer = 42;\n");

		const result = await flushWorktreeOnPromptDeadline(root);

		expect(result).toBeDefined();
		expect(result?.branch).toBe("work");
		expect(path.resolve(result?.worktreeRoot ?? "")).toBe(path.resolve(root));
		// The worktree is clean and the work is recoverable from the new commit.
		expect(await run(root, ["status", "--porcelain"])).toBe("");
		const headAfter = (await run(root, ["rev-parse", "HEAD"])).trim();
		expect(headAfter).not.toBe(headBefore);
		expect(await run(root, ["log", "-1", "--pretty=%s"])).toBe("wip(work): autosave on prompt deadline\n");
		expect(await run(root, ["show", "HEAD:new-file.ts"])).toBe("export const answer = 42;\n");
		expect(await run(root, ["show", "HEAD:README.md"])).toBe("edited by the agent\n");
		// Never pushed, and the prior commit is still the parent.
		expect((await run(root, ["rev-parse", "HEAD~1"])).trim()).toBe(headBefore);
	});

	test("creates no commit when the worktree is already clean", async () => {
		const root = await initRepo("gjc-deadline-flush-clean-");
		const headBefore = (await run(root, ["rev-parse", "HEAD"])).trim();

		expect(await flushWorktreeOnPromptDeadline(root)).toBeUndefined();

		expect((await run(root, ["rev-parse", "HEAD"])).trim()).toBe(headBefore);
		expect((await run(root, ["rev-list", "--count", "HEAD"])).trim()).toBe("1");
	});

	test("returns undefined outside a git worktree instead of throwing", async () => {
		const root = await fsp.mkdtemp(path.join(os.tmpdir(), "gjc-deadline-flush-nogit-"));
		tempRoots.push(root);
		await fsp.writeFile(path.join(root, "scratch.txt"), "not versioned\n");

		expect(await flushWorktreeOnPromptDeadline(root)).toBeUndefined();
		expect(await fsp.exists(path.join(root, ".git"))).toBe(false);
	});
});

describe("PromptDeadlineManager deadline flush wiring (#5583)", () => {
	test("flushes the worktree before retiring ownership on a genuine deadline", async () => {
		const root = await initRepo("gjc-deadline-manager-flush-");
		await fsp.writeFile(path.join(root, "work.ts"), "export const inProgress = true;\n");
		const { api, finalized } = reconciliation();
		const order: string[] = [];
		const manager = new PromptDeadlineManager({
			reconciliation: api as never,
			getLeaseMs: () => 20,
			getMaxMs: () => 60_000,
			onDeadlineExceeded: async () => {
				order.push("flush");
				await flushWorktreeOnPromptDeadline(root);
			},
			onExpired: () => {
				order.push("retire");
			},
		});
		const correlation = { commandId: "flush-cmd", turnId: "flush-turn" };
		manager.onAccepted(correlation);
		await Bun.sleep(150);

		expect(finalized).toContain("prompt_deadline_exceeded");
		// The flush runs before teardown, so the WIP commit exists by the time the
		// session is gone.
		expect(order).toEqual(["flush", "retire"]);
		expect(await run(root, ["status", "--porcelain"])).toBe("");
		expect(await run(root, ["show", "HEAD:work.ts"])).toBe("export const inProgress = true;\n");
		expect(manager.has(correlation)).toBe(false);
		manager.clearAll();
	});

	test("a failing flush leaves the deadline outcome and teardown unchanged", async () => {
		const { api, finalized } = reconciliation();
		let expired = 0;
		const manager = new PromptDeadlineManager({
			reconciliation: api as never,
			getLeaseMs: () => 20,
			getMaxMs: () => 60_000,
			onDeadlineExceeded: () => {
				throw new Error("git exploded");
			},
			onExpired: () => {
				expired += 1;
			},
		});
		const correlation = { commandId: "flush-fail-cmd", turnId: "flush-fail-turn" };
		manager.onAccepted(correlation);
		await Bun.sleep(150);

		expect(finalized).toContain("prompt_deadline_exceeded");
		expect(expired).toBe(1);
		expect(manager.has(correlation)).toBe(false);
		manager.clearAll();
	});

	test("does not flush when renewed progress supersedes the expiry", async () => {
		const root = await initRepo("gjc-deadline-superseded-");
		await fsp.writeFile(path.join(root, "live.ts"), "export const stillRunning = true;\n");
		let now = 0;
		const claimStarted = Promise.withResolvers<void>();
		const releaseClaim = Promise.withResolvers<void>();
		const { api } = reconciliation({ started: claimStarted.resolve, release: releaseClaim.promise });
		let flushes = 0;
		const manager = new PromptDeadlineManager({
			reconciliation: api as never,
			getLeaseMs: () => 20,
			getMaxMs: () => 60_000,
			now: () => now,
			onDeadlineExceeded: async () => {
				flushes += 1;
				await flushWorktreeOnPromptDeadline(root);
			},
		});
		const correlation = { commandId: "live-cmd", turnId: "live-turn" };
		manager.onAccepted(correlation);
		now = 20;
		// Attributable progress lands while the expiry pass is barriered inside its
		// claim: `#backOffIfSuperseded` then cancels this instance, so the still-live
		// prompt's in-flight edits must not be committed out from under it.
		await claimStarted.promise;
		now = 30;
		manager.onProgress(correlation, 30);
		releaseClaim.resolve();
		await Bun.sleep(50);

		expect(flushes).toBe(0);
		expect(manager.has(correlation)).toBe(true);
		expect(await run(root, ["status", "--porcelain"])).toBe("?? live.ts\n");
		manager.clearAll();
	});
});
