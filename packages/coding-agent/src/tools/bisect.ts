import type { AgentTool, AgentToolContext, AgentToolResult, AgentToolUpdateCallback } from "@gajae-code/agent-core";
import { prompt } from "@gajae-code/utils";
import * as z from "zod/v4";
import bisectDescription from "../prompts/tools/bisect.md" with { type: "text" };
import * as git from "../utils/git";
import type { ToolSession } from ".";
import type { OutputMeta } from "./output-meta";
import { ToolAbortError, ToolError, throwIfAborted } from "./tool-errors";
import { toolResult } from "./tool-result";

const DEFAULT_MAX_STEPS = 40;
const DEFAULT_STEP_TIMEOUT_MS = 10 * 60 * 1000;
/** git bisect run convention: a predicate exiting 125 means "cannot test this revision". */
const SKIP_EXIT_CODE = 125;

const bisectSchema = z.object({
	good: z
		.string()
		.min(1)
		.describe("A known-good commit-ish (must be an ancestor of `bad`) where the predicate passes."),
	bad: z
		.string()
		.min(1)
		.default("HEAD")
		.describe("A known-bad commit-ish (defaults to HEAD) where the predicate fails."),
	run: z
		.string()
		.min(1)
		.describe("Shell command evaluated at each revision. Exit 0 = good, 125 = skip, any other non-zero = bad."),
	invert: z
		.boolean()
		.default(false)
		.describe("Find the commit that FIXED the behavior instead of the one that broke it (exit 0 is treated as bad)."),
	maxSteps: z
		.number()
		.int()
		.positive()
		.max(1000)
		.default(DEFAULT_MAX_STEPS)
		.describe("Maximum bisection steps before giving up."),
	stepTimeoutMs: z
		.number()
		.int()
		.positive()
		.default(DEFAULT_STEP_TIMEOUT_MS)
		.describe("Per-step timeout in milliseconds; a timed-out step is treated as a skip."),
});

type BisectParams = z.infer<typeof bisectSchema>;

export type BisectVerdict = "good" | "bad" | "skip";

export interface BisectStep {
	rev: string;
	verdict: BisectVerdict;
}

export interface BisectMarkResult {
	exitCode: number;
	output: string;
}

export interface BisectControllerDeps {
	maxSteps: number;
	/** SHA of the revision git currently has checked out. */
	currentRev: () => Promise<string>;
	/** Evaluate the predicate at the checked-out revision. */
	evaluate: (rev: string) => Promise<BisectVerdict>;
	/** Apply the verdict via `git bisect good|bad|skip` and return the raw result. */
	mark: (verdict: BisectVerdict) => Promise<BisectMarkResult>;
}

export interface BisectOutcome {
	culprit: string | null;
	steps: BisectStep[];
	concluded: boolean;
	reason?: string;
}

export interface BisectToolDetails {
	meta?: OutputMeta;
	culprit: string | null;
	invert: boolean;
	concluded: boolean;
	steps: BisectStep[];
	author?: string;
	date?: string;
	subject?: string;
	reason?: string;
}

const FIRST_BAD_RE = /^([0-9a-f]{7,40}) is the first bad commit$/m;
const ONLY_SKIPPED_RE = /only '?skip'?ped commits left to test/i;

/** Parse the culprit SHA from `git bisect good|bad` output, or null when not yet converged. */
export function parseFirstBadCommit(output: string): string | null {
	const match = FIRST_BAD_RE.exec(output);
	return match ? match[1]! : null;
}

/**
 * Map a predicate exit code to a bisect verdict. `invert` swaps the good/bad
 * mapping (to hunt for a fixing commit) but never reinterprets a skip.
 */
export function classifyExit(exitCode: number, invert: boolean): BisectVerdict {
	if (exitCode === SKIP_EXIT_CODE) return "skip";
	const verdict: BisectVerdict = exitCode === 0 ? "good" : "bad";
	if (!invert) return verdict;
	return verdict === "good" ? "bad" : "good";
}

/**
 * Drive the bisect loop. Pure orchestration — every git/predicate effect is
 * injected — so it can be exercised deterministically without a real repo.
 */
export async function runBisectController(deps: BisectControllerDeps, signal?: AbortSignal): Promise<BisectOutcome> {
	const steps: BisectStep[] = [];
	for (let step = 0; step < deps.maxSteps; step += 1) {
		throwIfAborted(signal);
		const rev = await deps.currentRev();
		const verdict = await deps.evaluate(rev);
		steps.push({ rev, verdict });
		const marked = await deps.mark(verdict);
		if (marked.exitCode !== 0) {
			return {
				culprit: null,
				steps,
				concluded: false,
				reason: marked.output.trim() || `git bisect ${verdict} failed with exit code ${marked.exitCode}`,
			};
		}
		const culprit = parseFirstBadCommit(marked.output);
		if (culprit) return { culprit, steps, concluded: true };
		if (ONLY_SKIPPED_RE.test(marked.output)) {
			return {
				culprit: null,
				steps,
				concluded: false,
				reason: "only skipped commits are left to test — the result is undetermined",
			};
		}
	}
	return {
		culprit: null,
		steps,
		concluded: false,
		reason: `reached the ${deps.maxSteps}-step limit without converging`,
	};
}

/**
 * Run the predicate as `sh -c <run>` in `cwd` and return its exit code. A step
 * that exceeds `timeoutMs` is killed and reported as a skip (125). Honors the
 * outer abort signal by propagating a {@link ToolAbortError}.
 */
async function evaluatePredicate(
	run: string,
	cwd: string,
	timeoutMs: number,
	signal: AbortSignal | undefined,
): Promise<number> {
	const controller = new AbortController();
	let timedOut = false;
	const timer = setTimeout(() => {
		timedOut = true;
		controller.abort();
	}, timeoutMs);
	const onExternalAbort = () => controller.abort();
	signal?.addEventListener("abort", onExternalAbort, { once: true });
	try {
		const child = Bun.spawn(["sh", "-c", run], {
			cwd,
			stdin: "ignore",
			stdout: "ignore",
			stderr: "ignore",
			signal: controller.signal,
		});
		const exitCode = await child.exited;
		if (timedOut) return SKIP_EXIT_CODE;
		if (signal?.aborted) throw new ToolAbortError();
		return exitCode ?? 1;
	} catch (error) {
		if (timedOut) return SKIP_EXIT_CODE;
		if (signal?.aborted) throw new ToolAbortError();
		throw new ToolError(`Failed to run bisect predicate: ${error instanceof Error ? error.message : String(error)}`);
	} finally {
		clearTimeout(timer);
		signal?.removeEventListener("abort", onExternalAbort);
	}
}

function formatSteps(steps: BisectStep[]): string {
	if (steps.length === 0) return "  (seeded range converged immediately)";
	return steps.map((step, index) => `  ${index + 1}. ${step.rev.slice(0, 12)} → ${step.verdict}`).join("\n");
}

/**
 * Report the post-teardown worktree state honestly. `git bisect reset` plus a
 * `git reset --hard` restores every *tracked* file to its pre-bisect state, so
 * the common "predicate wrote to a tracked file" case is fully cleaned. A
 * predicate that created *untracked* files is intentionally left untouched (the
 * tool never deletes files it did not create), so those are surfaced as a note
 * rather than hidden behind a false "restored" claim. Any residual tracked
 * change is reported as a warning so the tool never overstates the cleanup.
 */
async function describeRestore(cwd: string): Promise<string> {
	const tracked = (await git.status(cwd, { porcelainV1: true, untrackedFiles: "no" }).catch(() => "")).trim();
	if (tracked) {
		return `WARNING: working tree not fully restored — tracked changes remain after teardown:\n${tracked}`;
	}
	const all = (await git.status(cwd, { porcelainV1: true, untrackedFiles: "all" }).catch(() => "")).trim();
	if (all) {
		return "Working tree restored: tracked files reset to their pre-bisect state (untracked files the predicate created are left in place).";
	}
	return "Working tree restored to its pre-bisect state.";
}

export class BisectTool implements AgentTool<typeof bisectSchema, BisectToolDetails> {
	readonly name = "bisect";
	readonly label = "Bisect";
	readonly summary = "Find the commit that introduced a regression by driving git bisect with a shell predicate";
	readonly description: string;
	readonly parameters = bisectSchema;
	readonly strict = true;
	readonly loadMode = "discoverable";
	readonly intent = (args: Partial<BisectParams>): string =>
		args.run ? `bisecting: ${args.run}` : "bisecting regression";

	constructor(private readonly session: ToolSession) {
		this.description = prompt.render(bisectDescription);
	}

	async execute(
		_toolCallId: string,
		params: BisectParams,
		signal?: AbortSignal,
		_onUpdate?: AgentToolUpdateCallback<BisectToolDetails>,
		_context?: AgentToolContext,
	): Promise<AgentToolResult<BisectToolDetails>> {
		// Resolve the worktree top level once and run every git, predicate, and
		// teardown operation from it — never from the raw session cwd. The session
		// cwd may be a subdirectory that a candidate commit deletes mid-bisect
		// (leaving later commands with a missing working directory), and `git
		// bisect` itself must be run from the top level of the working tree.
		const cwd = await git.repo.root(this.session.cwd, signal);
		if (!cwd) {
			throw new ToolError("bisect requires a git repository; the current directory is not inside a git worktree.");
		}
		const dirty = (await git.status(cwd, { porcelainV1: true, untrackedFiles: "no" })).trim();
		if (dirty) {
			throw new ToolError(
				"Working tree has uncommitted changes. Commit or stash them before bisecting — git bisect checks out historical commits and would clobber uncommitted work.",
			);
		}

		const goodSha = await git.ref.resolve(cwd, params.good, signal);
		if (!goodSha) throw new ToolError(`Could not resolve the good ref: ${params.good}`);
		const badSha = await git.ref.resolve(cwd, params.bad, signal);
		if (!badSha) throw new ToolError(`Could not resolve the bad ref: ${params.bad}`);
		if (goodSha === badSha) {
			throw new ToolError("good and bad resolve to the same commit; there is nothing to bisect.");
		}
		if (!(await git.bisect.isAncestor(cwd, goodSha, badSha, signal))) {
			throw new ToolError(
				`good (${params.good}) must be an ancestor of bad (${params.bad}). Swap them or pick a correct known-good commit.`,
			);
		}

		let outcome: BisectOutcome;
		// Defensive reset in case a previous aborted bisect left state behind; a
		// no-op when not bisecting (reset never throws).
		await git.bisect.reset(cwd, signal);
		try {
			await git.bisect.start(cwd, signal);
			const badMark = await git.bisect.bad(cwd, badSha, signal);
			if (badMark.exitCode !== 0) {
				throw new ToolError(`git bisect bad failed: ${badMark.stderr.trim() || badMark.stdout.trim()}`);
			}
			const goodMark = await git.bisect.good(cwd, goodSha, signal);
			if (goodMark.exitCode !== 0) {
				throw new ToolError(`git bisect good failed: ${goodMark.stderr.trim() || goodMark.stdout.trim()}`);
			}
			// A tiny good..bad range can converge on the seeding marks themselves.
			const seededCulprit = parseFirstBadCommit(`${goodMark.stdout}\n${goodMark.stderr}`);
			if (seededCulprit) {
				outcome = { culprit: seededCulprit, steps: [], concluded: true };
			} else {
				outcome = await runBisectController(
					{
						maxSteps: params.maxSteps,
						currentRev: async () => (await git.head.sha(cwd, signal)) ?? "HEAD",
						evaluate: async () =>
							classifyExit(
								await evaluatePredicate(params.run, cwd, params.stepTimeoutMs, signal),
								params.invert,
							),
						mark: async verdict => {
							const result =
								verdict === "good"
									? await git.bisect.good(cwd, undefined, signal)
									: verdict === "bad"
										? await git.bisect.bad(cwd, undefined, signal)
										: await git.bisect.skip(cwd, signal);
							return { exitCode: result.exitCode, output: `${result.stdout}\n${result.stderr}` };
						},
					},
					signal,
				);
			}
		} finally {
			// Always restore the working tree, even on error/abort. `git bisect
			// reset` returns HEAD to the original branch/commit but leaves behind
			// any tracked-file edits the `sh -c` predicate made mid-run. The tracked
			// tree was verified clean before we started (precondition above), so
			// discarding tracked modifications (reset --hard) only reverts the
			// predicate's side effects, never user work; then bisect reset restores
			// the original HEAD. Both are best-effort and must not throw here.
			await git.reset(cwd, { hard: true }).catch(() => {});
			await git.bisect.reset(cwd);
		}

		// Never claim a clean restore we did not actually achieve.
		const restoreLine = await describeRestore(cwd);

		if (outcome.concluded && outcome.culprit) {
			const info = await git.bisect.describe(cwd, outcome.culprit).catch(() => null);
			const lines = [
				params.invert ? `First fixing commit: ${outcome.culprit}` : `First bad commit: ${outcome.culprit}`,
			];
			if (info) {
				lines.push(`Author:  ${info.author}`, `Date:    ${info.date}`, `Subject: ${info.subject}`);
				if (info.stat) lines.push("", "Files changed:", info.stat);
			}
			lines.push("", `Tested ${outcome.steps.length} revision(s):`, formatSteps(outcome.steps));
			lines.push("", restoreLine);
			return toolResult<BisectToolDetails>({
				culprit: outcome.culprit,
				invert: params.invert,
				concluded: true,
				steps: outcome.steps,
				author: info?.author,
				date: info?.date,
				subject: info?.subject,
			})
				.text(lines.join("\n"))
				.done();
		}

		const lines = [
			`Bisect did not converge: ${outcome.reason ?? "unknown reason"}.`,
			"",
			`Tested ${outcome.steps.length} revision(s):`,
			formatSteps(outcome.steps),
			"",
			restoreLine,
		];
		return toolResult<BisectToolDetails>({
			culprit: null,
			invert: params.invert,
			concluded: false,
			steps: outcome.steps,
			reason: outcome.reason,
		})
			.text(lines.join("\n"))
			.done();
	}
}
