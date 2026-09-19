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

/**
 * Wait for an observable condition instead of guessing how long the manager
 * needs. A fixed sleep has to cover a real flush's five git subprocesses, which
 * is fine locally and flaky on a loaded CI runner; polling scales with the box.
 * The generous bound is deliberate — it exists to turn a genuine hang into a
 * legible timeout, not to police timing, which the assertions still do.
 */
async function waitFor(predicate: () => boolean, label: string, timeoutMs = 10_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!predicate()) {
		if (Date.now() > deadline) throw new Error(`Timed out waiting for ${label}`);
		await Bun.sleep(5);
	}
}

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

		const result = await flushWorktreeOnPromptDeadline(root, { explicitOptIn: true });

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

		expect(await flushWorktreeOnPromptDeadline(root, { explicitOptIn: true })).toBeUndefined();

		expect((await run(root, ["rev-parse", "HEAD"])).trim()).toBe(headBefore);
		expect((await run(root, ["rev-list", "--count", "HEAD"])).trim()).toBe("1");
	});

	test("returns undefined outside a git worktree instead of throwing", async () => {
		const root = await fsp.mkdtemp(path.join(os.tmpdir(), "gjc-deadline-flush-nogit-"));
		tempRoots.push(root);
		await fsp.writeFile(path.join(root, "scratch.txt"), "not versioned\n");

		expect(await flushWorktreeOnPromptDeadline(root, { explicitOptIn: true })).toBeUndefined();
		expect(await fsp.exists(path.join(root, ".git"))).toBe(false);
	});

	test("an already-aborted signal stops the flush before it commits anything", async () => {
		const root = await initRepo("gjc-deadline-flush-aborted-");
		await fsp.writeFile(path.join(root, "unsaved.ts"), "export const lost = false;\n");
		const controller = new AbortController();
		controller.abort(new Error("bound elapsed"));

		expect(
			await flushWorktreeOnPromptDeadline(root, { explicitOptIn: true, signal: controller.signal }),
		).toBeUndefined();

		// No commit was created and the work is still in the worktree, untouched.
		expect((await run(root, ["rev-list", "--count", "HEAD"])).trim()).toBe("1");
		expect(await run(root, ["status", "--porcelain"])).toBe("?? unsaved.ts\n");
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
				await flushWorktreeOnPromptDeadline(root, { explicitOptIn: true });
			},
			onExpired: () => {
				order.push("retire");
			},
		});
		const correlation = { commandId: "flush-cmd", turnId: "flush-turn" };
		manager.onAccepted(correlation);
		await waitFor(() => order.length === 2, "the flush and the retirement");

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
		await waitFor(() => expired === 1, "the retirement after the failing flush");

		expect(finalized).toContain("prompt_deadline_exceeded");
		expect(expired).toBe(1);
		expect(manager.has(correlation)).toBe(false);
		manager.clearAll();
	});

	/**
	 * Review round 2 on #5623: a flush that never settles — blocking git lock,
	 * credential prompt, hanging pre-commit hook — used to strand `onExpired` and
	 * `clear` forever, because a try/catch cannot rescue a pending promise. These
	 * tests pass only if the bound always settles; a regression hangs the suite.
	 */
	test("a never-settling flush cannot hold teardown past the bound", async () => {
		const { api, finalized } = reconciliation();
		let expired = 0;
		const manager = new PromptDeadlineManager({
			reconciliation: api as never,
			getLeaseMs: () => 20,
			getMaxMs: () => 60_000,
			deadlineFlushTimeoutMs: 20,
			onDeadlineExceeded: () => new Promise<void>(() => {}),
			onExpired: () => {
				expired += 1;
			},
		});
		const correlation = { commandId: "flush-hang-cmd", turnId: "flush-hang-turn" };
		manager.onAccepted(correlation);
		// The poll bound is far above the 20ms flush bound on purpose: if the flush
		// bound regressed, this times out with a legible message instead of hanging.
		await waitFor(() => expired === 1, "teardown past the abandoned flush");

		// Reaching these assertions at all is the point: teardown completed.
		expect(finalized).toContain("prompt_deadline_exceeded");
		expect(expired).toBe(1);
		expect(manager.has(correlation)).toBe(false);
		manager.clearAll();
	});

	test("aborts the hook's signal when the bound elapses", async () => {
		const aborted = Promise.withResolvers<string>();
		const { api } = reconciliation();
		const manager = new PromptDeadlineManager({
			reconciliation: api as never,
			getLeaseMs: () => 20,
			getMaxMs: () => 60_000,
			deadlineFlushTimeoutMs: 20,
			onDeadlineExceeded: (_correlation, signal) =>
				new Promise<void>(() => {
					signal.addEventListener("abort", () => aborted.resolve(String((signal.reason as Error)?.message)));
				}),
		});
		const correlation = { commandId: "flush-abort-cmd", turnId: "flush-abort-turn" };
		manager.onAccepted(correlation);

		// The abort is what kills the git subprocess inside a real flush.
		expect(await aborted.promise).toContain("20ms");
		manager.clearAll();
	});

	test("awaits a slow but finite flush to completion instead of truncating it", async () => {
		const root = await initRepo("gjc-deadline-slow-flush-");
		await fsp.writeFile(path.join(root, "slow.ts"), "export const slow = true;\n");
		const { api } = reconciliation();
		const order: string[] = [];
		const manager = new PromptDeadlineManager({
			reconciliation: api as never,
			getLeaseMs: () => 20,
			getMaxMs: () => 60_000,
			// Comfortably longer than the deliberate delay below.
			deadlineFlushTimeoutMs: 2_000,
			onDeadlineExceeded: async (_correlation, signal) => {
				await Bun.sleep(40);
				await flushWorktreeOnPromptDeadline(root, { explicitOptIn: true, signal });
				order.push("flush");
			},
			onExpired: () => {
				order.push("retire");
			},
		});
		const correlation = { commandId: "flush-slow-cmd", turnId: "flush-slow-turn" };
		manager.onAccepted(correlation);
		// A real flush spawns five git subprocesses; a fixed sleep sized on a fast
		// box is what made this flake on CI. The deep-equal below still pins order,
		// so a truncated flush fails as ["retire"] rather than passing early.
		await waitFor(() => order.length === 2, "the flush and the retirement");

		// The bound must not truncate work that finishes within it.
		expect(order).toEqual(["flush", "retire"]);
		expect(await run(root, ["status", "--porcelain"])).toBe("");
		expect(await run(root, ["show", "HEAD:slow.ts"])).toBe("export const slow = true;\n");
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
				await flushWorktreeOnPromptDeadline(root, { explicitOptIn: true });
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

	/**
	 * #5623 review round 2: the flush is an await like any other in `#onDeadline`,
	 * and up to ten seconds long, so progress can land and renew the lease while it
	 * runs. Without a fence AFTER it, the stale expiry retires ownership and clears
	 * the lease of a prompt that is demonstrably live again.
	 */
	test("does not retire ownership when progress lands during the flush", async () => {
		let now = 0;
		const flushStarted = Promise.withResolvers<void>();
		const releaseFlush = Promise.withResolvers<void>();
		const { api, finalized } = reconciliation();
		let expired = 0;
		const manager = new PromptDeadlineManager({
			reconciliation: api as never,
			getLeaseMs: () => 20,
			getMaxMs: () => 60_000,
			now: () => now,
			deadlineFlushTimeoutMs: 5_000,
			onDeadlineExceeded: async () => {
				flushStarted.resolve();
				await releaseFlush.promise;
			},
			onExpired: () => {
				expired += 1;
			},
		});
		const correlation = { commandId: "flush-renew-cmd", turnId: "flush-renew-turn" };
		manager.onAccepted(correlation);
		now = 20;

		// The flush is in flight and the durable outcome is still pending: the
		// terminal must not become visible before the worktree checkpoint finishes.
		await flushStarted.promise;
		expect(finalized).toEqual([]);
		// Progress renews the same lease object and bumps its generation.
		now = 30;
		manager.onProgress(correlation, 30);
		releaseFlush.resolve();
		await Bun.sleep(50);

		// The post-flush fence backs this stale expiry off instead of tearing down
		// a renewed prompt, and reschedules so it keeps a live deadline.
		expect(expired).toBe(0);
		expect(finalized).toEqual([]);
		expect(manager.has(correlation)).toBe(true);
		expect(manager.deadlineAt(correlation)).toBe(50);
		manager.clearAll();
	});
});

/**
 * #5623 review round 3: the autosave stages the whole worktree before it
 * commits, so a failing commit hook or an abort landing in between used to
 * leave the user's previously-unstaged and untracked edits staged with no
 * commit to show for it — silently changing whatever they committed next.
 * An attempt that produces no commit must leave the index exactly as it found it.
 */
describe("deadline autosave index rollback (#5623)", () => {
	/** A repo whose index mixes all three states the rollback has to preserve. */
	async function initMixedIndexRepo(prefix: string): Promise<string> {
		const root = await initRepo(prefix);
		// Staged by the user beforehand.
		await fsp.writeFile(path.join(root, "user-staged.ts"), "export const staged = 1;\n");
		await run(root, ["add", "user-staged.ts"]);
		// Tracked and modified, deliberately NOT staged.
		await fsp.writeFile(path.join(root, "README.md"), "edited by the user\n");
		// Untracked.
		await fsp.writeFile(path.join(root, "agent-work.ts"), "export const work = true;\n");
		return root;
	}

	/** The two index facts the rollback must preserve byte-for-byte. */
	async function indexState(root: string): Promise<{ cached: string[]; status: string[] }> {
		const lines = (text: string) => text.split("\n").filter(Boolean).sort();
		return {
			cached: lines(await run(root, ["diff", "--cached", "--name-only"])),
			status: lines(await run(root, ["status", "--porcelain=v1"])),
		};
	}

	async function writePreCommitHook(root: string, script: string): Promise<void> {
		const hook = path.join(root, ".git", "hooks", "pre-commit");
		await fsp.mkdir(path.dirname(hook), { recursive: true });
		await fsp.writeFile(hook, script, { mode: 0o755 });
	}

	async function gitStdin(cwd: string, args: string[], stdin: string): Promise<void> {
		const proc = Bun.spawn(["git", ...args], {
			cwd,
			stdin: Buffer.from(stdin),
			stdout: "pipe",
			stderr: "pipe",
		});
		const [code, stderr] = await Promise.all([proc.exited, new Response(proc.stderr).text()]);
		if (code !== 0) throw new Error(`git ${args.join(" ")} failed: ${stderr}`);
	}

	async function hashBlob(cwd: string, text: string): Promise<string> {
		const proc = Bun.spawn(["git", "hash-object", "-w", "--stdin"], {
			cwd,
			stdin: Buffer.from(text),
			stdout: "pipe",
			stderr: "pipe",
		});
		const [, stdout] = await Promise.all([proc.exited, new Response(proc.stdout).text()]);
		return stdout.trim();
	}

	test("a failing commit hook cannot block the isolated-index autosave", async () => {
		const root = await initMixedIndexRepo("gjc-deadline-hook-fail-");
		await writePreCommitHook(root, "#!/bin/sh\nexit 1\n");
		const commitsBefore = (await run(root, ["rev-list", "--count", "HEAD"])).trim();

		expect(await flushWorktreeOnPromptDeadline(root, { explicitOptIn: true })).toBeDefined();

		expect((await run(root, ["rev-list", "--count", "HEAD"])).trim()).toBe(String(Number(commitsBefore) + 1));
		const after = await indexState(root);
		// The plumbing commit bypasses hooks and adopts the isolated index only
		// after the ref move, leaving no staged or unstaged residue.
		expect(after.cached).toEqual([]);
		expect(after.status).toEqual([]);
	});

	test("an aborted mixed-index autosave leaves the user's index untouched", async () => {
		const root = await initMixedIndexRepo("gjc-deadline-abort-mid-");
		const before = await indexState(root);
		const commitsBefore = (await run(root, ["rev-list", "--count", "HEAD"])).trim();

		const controller = new AbortController();
		controller.abort(new Error("deadline flush bound elapsed"));
		expect(
			await flushWorktreeOnPromptDeadline(root, { explicitOptIn: true, signal: controller.signal }),
		).toBeUndefined();
		expect((await run(root, ["rev-list", "--count", "HEAD"])).trim()).toBe(commitsBefore);
		const after = await indexState(root);
		expect(after.cached).toEqual(before.cached);
		expect(after.status).toEqual(before.status);
	});

	test("never stages an index it cannot snapshot", async () => {
		const root = await initMixedIndexRepo("gjc-deadline-unmerged-");
		// A real unmerged index: `git write-tree` refuses on stage 1/2/3 entries,
		// so the autosave has no rollback available and must not start.
		const [base, ours, theirs] = await Promise.all([
			hashBlob(root, "base\n"),
			hashBlob(root, "ours\n"),
			hashBlob(root, "theirs\n"),
		]);
		await gitStdin(
			root,
			["update-index", "--index-info"],
			`100644 ${base} 1\tconflicted.txt\n100644 ${ours} 2\tconflicted.txt\n100644 ${theirs} 3\tconflicted.txt\n`,
		);
		const before = await indexState(root);
		const commitsBefore = (await run(root, ["rev-list", "--count", "HEAD"])).trim();

		expect(await flushWorktreeOnPromptDeadline(root, { explicitOptIn: true })).toBeUndefined();

		expect((await run(root, ["rev-list", "--count", "HEAD"])).trim()).toBe(commitsBefore);
		const after = await indexState(root);
		expect(after.cached).toEqual(before.cached);
		expect(after.status).toEqual(before.status);
	});

	test("still commits the whole mixed index on the success path", async () => {
		const root = await initMixedIndexRepo("gjc-deadline-mixed-success-");

		expect(await flushWorktreeOnPromptDeadline(root, { explicitOptIn: true })).toBeDefined();

		// A clean tree also proves the snapshot was NOT restored after a commit
		// that landed: doing so would leave a phantom "revert everything" staged.
		expect(await run(root, ["status", "--porcelain=v1"])).toBe("");
		expect((await run(root, ["rev-list", "--count", "HEAD"])).trim()).toBe("2");
		expect(await run(root, ["show", "HEAD:agent-work.ts"])).toBe("export const work = true;\n");
		expect(await run(root, ["show", "HEAD:user-staged.ts"])).toBe("export const staged = 1;\n");
		expect(await run(root, ["show", "HEAD:README.md"])).toBe("edited by the user\n");
	});
});
