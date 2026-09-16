import { afterEach, describe, expect, spyOn, test } from "bun:test";
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { flushWorktreeOnPromptDeadline } from "../src/sdk/prompt-deadline-flush";
import { PromptDeadlineManager } from "../src/sdk/prompt-deadline-manager";
import * as git from "../src/utils/git";

/**
 * #5583: a prompt retired by its deadline used to tear the session down with the
 * agent's worktree dirty, losing finished work. The expiry path now flushes that
 * work to a WIP commit first — best effort, and only on the path that genuinely
 * retires the prompt.
 */

const tempRoots: string[] = [];
const restorers: (() => void)[] = [];

afterEach(async () => {
	for (const restore of restorers.splice(0)) restore();
	await Promise.all(tempRoots.splice(0).map(dir => fsp.rm(dir, { recursive: true, force: true })));
});

/**
 * Wait for an observable condition instead of guessing how long the manager
 * needs. A fixed sleep has to cover a real flush's git subprocesses, which is
 * fine locally and flaky on a loaded CI runner; polling scales with the box.
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
 * A LINKED worktree of a fresh repo — what an agent/paseo session actually runs
 * in, and the only shape the autosave treats as session-owned by default.
 */
async function initLinkedWorktree(prefix: string): Promise<string> {
	const primary = await initRepo(prefix);
	const linked = path.join(path.dirname(primary), `${path.basename(primary)}-linked`);
	tempRoots.push(linked);
	await run(primary, ["worktree", "add", "-b", "agent", linked]);
	return linked;
}

/** The autosave only honours the schema default in a worktree the session owns. */
const OWNED = { explicitOptIn: true } as const;

describe("flushWorktreeOnPromptDeadline", () => {
	test("commits uncommitted work so a deadline leaves the worktree clean", async () => {
		const root = await initRepo("gjc-deadline-flush-");
		const headBefore = (await run(root, ["rev-parse", "HEAD"])).trim();
		await fsp.writeFile(path.join(root, "README.md"), "edited by the agent\n");
		await fsp.writeFile(path.join(root, "new-file.ts"), "export const answer = 42;\n");

		const result = await flushWorktreeOnPromptDeadline(root, OWNED);

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

		expect(await flushWorktreeOnPromptDeadline(root, OWNED)).toBeUndefined();

		expect((await run(root, ["rev-parse", "HEAD"])).trim()).toBe(headBefore);
		expect((await run(root, ["rev-list", "--count", "HEAD"])).trim()).toBe("1");
	});

	test("returns undefined outside a git worktree instead of throwing", async () => {
		const root = await fsp.mkdtemp(path.join(os.tmpdir(), "gjc-deadline-flush-nogit-"));
		tempRoots.push(root);
		await fsp.writeFile(path.join(root, "scratch.txt"), "not versioned\n");

		expect(await flushWorktreeOnPromptDeadline(root, OWNED)).toBeUndefined();
		expect(await fsp.exists(path.join(root, ".git"))).toBe(false);
	});

	test("an already-aborted signal stops the flush before it commits anything", async () => {
		const root = await initRepo("gjc-deadline-flush-aborted-");
		await fsp.writeFile(path.join(root, "unsaved.ts"), "export const lost = false;\n");
		const controller = new AbortController();
		controller.abort(new Error("bound elapsed"));

		expect(await flushWorktreeOnPromptDeadline(root, { ...OWNED, signal: controller.signal })).toBeUndefined();

		// No commit was created and the work is still in the worktree, untouched.
		expect((await run(root, ["rev-list", "--count", "HEAD"])).trim()).toBe("1");
		expect(await run(root, ["status", "--porcelain"])).toBe("?? unsaved.ts\n");
	});
});

/**
 * #5623 review round 3: `git add -A` is right for a session that owns its
 * checkout and wrong for one sharing the user's, where it would sweep up
 * whatever they happen to have open. `sdk.flushWorktreeOnDeadline` still
 * defaults to on, but the implicit default only applies in a linked worktree —
 * an agent/paseo session — which is the exact shape the #5583 report describes.
 */
describe("deadline autosave worktree ownership (#5623)", () => {
	test("autosaves a linked worktree the session owns on the default", async () => {
		const root = await initLinkedWorktree("gjc-deadline-owned-");
		await fsp.writeFile(path.join(root, "agent-work.ts"), "export const work = true;\n");

		// No explicit opt-in: this is the schema default doing the work.
		const result = await flushWorktreeOnPromptDeadline(root);

		expect(result).toBeDefined();
		expect(result?.branch).toBe("agent");
		expect(await run(root, ["status", "--porcelain"])).toBe("");
		expect(await run(root, ["show", "HEAD:agent-work.ts"])).toBe("export const work = true;\n");
	});

	test("leaves a primary checkout alone on the default", async () => {
		const root = await initRepo("gjc-deadline-unowned-");
		await fsp.writeFile(path.join(root, "user-work.ts"), "export const mine = true;\n");
		const headBefore = (await run(root, ["rev-parse", "HEAD"])).trim();

		expect(await flushWorktreeOnPromptDeadline(root)).toBeUndefined();

		// Nothing committed, nothing staged: the user's checkout is untouched.
		expect((await run(root, ["rev-parse", "HEAD"])).trim()).toBe(headBefore);
		expect(await run(root, ["status", "--porcelain"])).toBe("?? user-work.ts\n");
		expect(await run(root, ["diff", "--cached", "--name-only"])).toBe("");
	});

	test("autosaves a primary checkout when the user opted in explicitly", async () => {
		const root = await initRepo("gjc-deadline-optin-");
		await fsp.writeFile(path.join(root, "user-work.ts"), "export const mine = true;\n");

		expect(await flushWorktreeOnPromptDeadline(root, { explicitOptIn: true })).toBeDefined();

		expect(await run(root, ["status", "--porcelain"])).toBe("");
		expect(await run(root, ["show", "HEAD:user-work.ts"])).toBe("export const mine = true;\n");
	});
});

/**
 * #5623 review round 4. The autosave no longer stages into the user's real
 * index or commits through porcelain: it stages into a throwaway
 * `GIT_INDEX_FILE` inside the git dir, builds the commit with `write-tree` +
 * `commit-tree`, and adopts it with a compare-and-swap `update-ref` against the
 * HEAD it captured. So a failing or abandoned attempt never wrote the real index
 * at all — strictly stronger than the tree snapshot-and-restore it replaces,
 * which silently dropped index-only state like skip-worktree — and the one
 * mutation that can outlive teardown is conditional on an unchanged HEAD.
 */
describe("deadline autosave index isolation (#5623)", () => {
	/** A repo whose index mixes every state the autosave has to preserve. */
	async function initMixedIndexRepo(prefix: string): Promise<string> {
		const root = await initRepo(prefix);
		// Tracked, then hidden from git with skip-worktree and edited behind it.
		// Neither `status` nor `diff --cached` shows this bit — only `ls-files -v`.
		await fsp.writeFile(path.join(root, "hidden.ts"), "export const hidden = 0;\n");
		await run(root, ["add", "hidden.ts"]);
		await run(root, ["commit", "-m", "add hidden"]);
		await fsp.writeFile(path.join(root, "hidden.ts"), "export const hidden = 1;\n");
		await run(root, ["update-index", "--skip-worktree", "hidden.ts"]);
		// Staged by the user beforehand.
		await fsp.writeFile(path.join(root, "user-staged.ts"), "export const staged = 1;\n");
		await run(root, ["add", "user-staged.ts"]);
		// Tracked and modified, deliberately NOT staged.
		await fsp.writeFile(path.join(root, "README.md"), "edited by the user\n");
		// Untracked.
		await fsp.writeFile(path.join(root, "agent-work.ts"), "export const work = true;\n");
		// Intent-to-add: an index entry with no content behind it.
		await fsp.writeFile(path.join(root, "intent.ts"), "export const intent = true;\n");
		await run(root, ["add", "-N", "intent.ts"]);
		return root;
	}

	/** The full observable index state, not the convenient half of it. */
	async function indexState(root: string): Promise<{ cached: string[]; flags: string[]; status: string[] }> {
		const lines = (text: string) => text.split("\n").filter(Boolean).sort();
		return {
			cached: lines(await run(root, ["diff", "--cached", "--name-only"])),
			// The only one of the three that shows skip-worktree / assume-unchanged.
			flags: lines(await run(root, ["ls-files", "-v"])),
			status: lines(await run(root, ["status", "--porcelain=v1"])),
		};
	}

	/** Move HEAD from "outside", touching neither the index nor the worktree. */
	async function externalCommit(root: string): Promise<string> {
		const tree = (await run(root, ["rev-parse", "HEAD^{tree}"])).trim();
		const parent = (await run(root, ["rev-parse", "HEAD"])).trim();
		const sha = (await run(root, ["commit-tree", tree, "-p", parent, "-m", "someone else's commit"])).trim();
		await run(root, ["update-ref", "HEAD", sha]);
		return sha;
	}

	/**
	 * Hold the autosave open immediately after it has staged — the exact window in
	 * which the old implementation had already mutated the user's real index and
	 * had yet to produce a commit.
	 */
	function pauseAfterStaging(): { release: () => void; staged: Promise<void> } {
		const staged = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		const original = git.stage.files;
		const spy = spyOn(git.stage, "files").mockImplementation(async (...args: Parameters<typeof original>) => {
			await original(...args);
			staged.resolve();
			await release.promise;
		});
		restorers.push(() => {
			release.resolve();
			spy.mockRestore();
		});
		return { release: release.resolve, staged: staged.promise };
	}

	async function tempIndexFiles(root: string): Promise<string[]> {
		return (await fsp.readdir(path.join(root, ".git"))).filter(entry => entry.startsWith("gjc-deadline-index-"));
	}

	test("a late autosave never clobbers a HEAD that moved while it was queued", async () => {
		// Finding 1. `withRepoLock` awaits its predecessor BEFORE honouring the
		// abort signal, so an autosave teardown has already walked away from can
		// still reach its mutation long after the world moved on. The adoption is
		// therefore a compare-and-swap against the HEAD captured before staging:
		// when that HEAD moved, the prepared commit is dropped on the floor.
		const root = await initMixedIndexRepo("gjc-deadline-late-");
		const before = await indexState(root);
		const gate = pauseAfterStaging();

		const flushing = flushWorktreeOnPromptDeadline(root, OWNED);
		await gate.staged;
		// Someone else commits while this autosave is parked mid-flight.
		const external = await externalCommit(root);
		gate.release();

		expect(await flushing).toBeUndefined();
		// Their commit is still HEAD and no WIP commit exists anywhere.
		expect((await run(root, ["rev-parse", "HEAD"])).trim()).toBe(external);
		expect(await run(root, ["log", "--all", "--pretty=%s"])).not.toContain("autosave on prompt deadline");
		// And the real index was never opened for writing on the way there.
		expect(await indexState(root)).toEqual(before);
		expect(await tempIndexFiles(root)).toEqual([]);
	});

	test("an abort after staging leaves the index exactly as the user had it", async () => {
		// Finding 3. The old implementation staged into the real index and relied on
		// a `write-tree`/`read-tree` snapshot to undo it, which cannot carry
		// intent-to-add or skip-worktree. Nothing is restored now because nothing
		// was written: the real index is byte-identical, flags included.
		const root = await initMixedIndexRepo("gjc-deadline-abort-mid-");
		const before = await indexState(root);
		const commitsBefore = (await run(root, ["rev-list", "--count", "HEAD"])).trim();
		const gate = pauseAfterStaging();

		const controller = new AbortController();
		const flushing = flushWorktreeOnPromptDeadline(root, { ...OWNED, signal: controller.signal });
		await gate.staged;
		controller.abort(new Error("deadline flush bound elapsed"));
		gate.release();

		expect(await flushing).toBeUndefined();
		expect((await run(root, ["rev-list", "--count", "HEAD"])).trim()).toBe(commitsBefore);
		expect(await indexState(root)).toEqual(before);
		expect(await tempIndexFiles(root)).toEqual([]);
	});

	test("leaves an unmerged index alone rather than committing over the conflict", async () => {
		const root = await initMixedIndexRepo("gjc-deadline-unmerged-");
		// A real unmerged index: staging into a HEAD-seeded scratch index would
		// happily commit the conflict markers and then adopt a resolved index over
		// the user's unresolved one, so the autosave must not start.
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

		expect(await flushWorktreeOnPromptDeadline(root, OWNED)).toBeUndefined();

		expect((await run(root, ["rev-list", "--count", "HEAD"])).trim()).toBe(commitsBefore);
		expect(await indexState(root)).toEqual(before);
	});

	test("still commits the whole mixed worktree on the success path", async () => {
		const root = await initMixedIndexRepo("gjc-deadline-mixed-success-");

		expect(await flushWorktreeOnPromptDeadline(root, OWNED)).toBeDefined();

		// Both halves of the observable state: a clean status AND an empty cached
		// diff. Adopting the scratch index only after the ref moved is what makes
		// the second one hold — restoring a pre-autosave snapshot instead would
		// leave a phantom "revert everything" staged diff behind a clean status.
		expect(await run(root, ["status", "--porcelain=v1"])).toBe("");
		expect(await run(root, ["diff", "--cached", "--name-only"])).toBe("");
		expect((await run(root, ["rev-list", "--count", "HEAD"])).trim()).toBe("3");
		expect(await run(root, ["show", "HEAD:agent-work.ts"])).toBe("export const work = true;\n");
		expect(await run(root, ["show", "HEAD:user-staged.ts"])).toBe("export const staged = 1;\n");
		expect(await run(root, ["show", "HEAD:intent.ts"])).toBe("export const intent = true;\n");
		expect(await run(root, ["show", "HEAD:README.md"])).toBe("edited by the user\n");
		expect(await tempIndexFiles(root)).toEqual([]);
	});

	test("runs no repository commit hook during teardown", async () => {
		// Finding 4, hook half. Porcelain `git commit` ran whatever `pre-commit` and
		// `commit-msg` the repository ships — arbitrary repo-controlled code, during
		// session teardown, under a deadline. `commit-tree` runs neither.
		const root = await initMixedIndexRepo("gjc-deadline-no-hooks-");
		// Sentinels live under .git/ so they cannot show up as untracked files and
		// contaminate the status assertion below.
		const sentinels = ["pre-commit", "commit-msg"].map(hook => path.join(root, ".git", `${hook}-ran`));
		for (const [index, hook] of ["pre-commit", "commit-msg"].entries()) {
			await fsp.writeFile(path.join(root, ".git", "hooks", hook), `#!/bin/sh\ntouch ${sentinels[index]}\nexit 0\n`, {
				mode: 0o755,
			});
		}

		expect(await flushWorktreeOnPromptDeadline(root, OWNED)).toBeDefined();

		expect(await Promise.all(sentinels.map(file => fsp.exists(file)))).toEqual([false, false]);
		expect(await run(root, ["status", "--porcelain=v1"])).toBe("");
	});

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
});

/**
 * Reconciliation double that accepts the synthetic deadline outcome. `barrier`
 * holds `claimPendingOutcome` open so a test can land progress mid-expiry, and
 * `order` records the durable boundary the autosave has to sit between.
 */
function reconciliation(barrier?: { started: () => void; release: Promise<void> }, order: string[] = []) {
	const finalized: string[] = [];
	return {
		finalized,
		order,
		api: {
			lookup: () => ({ status: "running" }),
			claimPendingOutcome: async () => {
				order.push("claim");
				barrier?.started();
				await barrier?.release;
			},
			noteTransition: async () => {},
			finalizeOutcome: async (_kind: string, _correlation: unknown, outcome: { code?: string }) => {
				order.push("finalize");
				finalized.push(outcome.code ?? "none");
			},
		},
	};
}

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
				await flushWorktreeOnPromptDeadline(root, OWNED);
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

	/**
	 * Finding 2 (#5623 review round 4). The autosave used to run AFTER the durable
	 * terminal was written, which made it the one step a crash could silently skip:
	 * the record said `prompt_deadline_exceeded` — terminal, done — while the work
	 * it claims to have saved was still only in the worktree. Running it inside the
	 * claim→finalize window means a death anywhere in it leaves the record PENDING,
	 * so restart recovery retries the prompt instead of reporting finished work
	 * that was never saved.
	 */
	test("autosaves between the durable claim and the durable terminal", async () => {
		const root = await initRepo("gjc-deadline-crash-window-");
		await fsp.writeFile(path.join(root, "work.ts"), "export const unsaved = true;\n");
		const order: string[] = [];
		const { api, finalized } = reconciliation(undefined, order);
		/** What the durable record would have said had the process died mid-flush. */
		let finalizedDuringFlush: string[] | undefined;
		const manager = new PromptDeadlineManager({
			reconciliation: api as never,
			getLeaseMs: () => 20,
			getMaxMs: () => 60_000,
			onDeadlineExceeded: async () => {
				order.push("flush");
				finalizedDuringFlush = [...finalized];
				await flushWorktreeOnPromptDeadline(root, OWNED);
			},
			onExpired: () => {
				order.push("retire");
			},
		});
		const correlation = { commandId: "crash-cmd", turnId: "crash-turn" };
		manager.onAccepted(correlation);
		await waitFor(() => order.includes("retire"), "the full expiry pass");

		// Deep-equal, so a reordering fails as a diff rather than passing loosely.
		expect(order).toEqual(["claim", "flush", "finalize", "retire"]);
		// A crash anywhere inside the flush window finds no terminal written yet:
		// the durable record is still the pending claim, which recovery retries.
		expect(finalizedDuringFlush).toEqual([]);
		expect(finalized).toEqual(["prompt_deadline_exceeded"]);
		// And the work really was saved before the terminal was written.
		expect(await run(root, ["show", "HEAD:work.ts"])).toBe("export const unsaved = true;\n");
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
	 * credential prompt, hanging commit hook — used to strand `onExpired` and
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
				await flushWorktreeOnPromptDeadline(root, { ...OWNED, signal });
				order.push("flush");
			},
			onExpired: () => {
				order.push("retire");
			},
		});
		const correlation = { commandId: "flush-slow-cmd", turnId: "flush-slow-turn" };
		manager.onAccepted(correlation);
		// A real flush spawns several git subprocesses; a fixed sleep sized on a fast
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
				await flushWorktreeOnPromptDeadline(root, OWNED);
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
	 * runs. Without a fence AFTER it, the stale expiry terminalizes and retires a
	 * prompt that is demonstrably live again.
	 */
	test("does not terminalize or retire when progress lands during the flush", async () => {
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

		// The flush is in flight; the terminal has deliberately NOT been written yet.
		await flushStarted.promise;
		expect(finalized).toEqual([]);
		// Progress renews the same lease object and bumps its generation.
		now = 30;
		manager.onProgress(correlation, 30);
		releaseFlush.resolve();
		await Bun.sleep(50);

		// The post-flush fence backs this stale expiry off instead of terminalizing
		// a renewed prompt, and reschedules so it keeps a live deadline.
		expect(finalized).toEqual([]);
		expect(expired).toBe(0);
		expect(manager.has(correlation)).toBe(true);
		expect(manager.deadlineAt(correlation)).toBe(50);
		manager.clearAll();
	});
});
