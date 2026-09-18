/**
 * Work preservation and operator wording for a post-start terminal prompt failure (issue #5664).
 *
 * A turn that fails AFTER execution started may have spent an hour editing the worktree. The
 * failure is terminal by design — a re-submit is a NEW independent `turn.prompt`, so replaying a
 * turn that already ran `apply_patch` would re-run the user's side effects, which is exactly what
 * `#shouldRetryFirstPrompt`'s tool/output gates exist to prevent (issue #5574). Nothing here
 * re-opens those gates. Instead it makes the terminal outcome non-destructive and non-misleading:
 *
 *   - the uncommitted TRACKED work is snapshotted into the git stash list BEFORE the turn reports
 *     `error`, so an operator can recover it after the worktree is swept;
 *   - the snapshot's location is stated in operator-facing wording, because a snapshot nobody can
 *     find is not a fix — and so is what the snapshot does NOT hold, because a recovery hint an
 *     operator trusts and that then silently drops their new files is worse than no hint at all.
 *     `git stash create` captures tracked/staged content only, so untracked files are reported as
 *     uncaptured (by count) rather than implied to be recoverable;
 *   - a `provider_transport` failure is described as an upstream provider problem rather than as a
 *     failure of the operator's task.
 *
 * Preservation is deliberately scoped to the PHASE, not the category: a post-start fatal strands
 * work whatever classified it (issue #5615's bare `agent_runtime` `prompt_failed` ended the same
 * way). The upstream-provider wording is the part gated on `provider_transport`.
 *
 * The capture is BOUNDED and local to this module rather than delegated to the harness's
 * `preserveDirtyWorktree`. That helper backs a `vanish` receipt, where completeness is the point,
 * so it hashes every untracked file's contents and runs git unbounded; this path runs synchronously
 * inside `#settlePrompt` before the rejection, so a hung git or a pathological worktree would delay
 * the terminal outcome itself. It also cannot distinguish "clean" from "could not look" — every git
 * failure inside it degrades to empty evidence — which is precisely the conflation that let an
 * uninspectable worktree be reported as clean.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { isSafePromptFailureCode } from "../../sdk/prompt-failure";
import type { SdkPromptFailureCategory } from "../../sdk/prompt-status";

/**
 * Whether the worktree was actually inspected, and what was found.
 *
 * `clean` and `unknown` are deliberately distinct. Collapsing them — as returning a bare
 * `undefined` for both did — tells an operator whose worktree could NOT be inspected the same
 * thing it tells one whose worktree was verified empty, so they sweep it and lose the edits. A
 * failure to verify is not evidence of absence.
 */
export type PostStartPreservationStatus = "preserved" | "clean" | "unknown";

/** What a post-start terminal managed to preserve. Always reported, never implied by absence. */
export interface PostStartPreservation {
	/** `clean` = verified nothing to preserve. `unknown` = could NOT verify or snapshot. */
	status: PostStartPreservationStatus;
	/** Present only when a recoverable stash object was actually stored. */
	stashRef?: string;
	/** False when the worktree was dirty but some component could not be captured. */
	snapshotComplete: boolean;
	/**
	 * How many untracked files exist in the worktree but NOT in the stash object.
	 *
	 * A COUNT, never the paths: this object is interpolated into a message that crosses the wire,
	 * and untracked paths are user-controlled strings. A non-negative integer is the whole budget
	 * the `#4068`/`#4077` redaction contract allows here — the same reasoning that makes
	 * `safeStashRef` admit only a bare hex oid.
	 */
	untrackedNotCaptured?: number;
	/**
	 * The worktree was observed changing while it was being captured, so the snapshot may be missing
	 * edits that landed mid-flight. A BOOLEAN, never the paths that changed — same redaction contract
	 * as {@link PostStartPreservation.untrackedNotCaptured}.
	 */
	racedDuringCapture?: boolean;
}

/**
 * A stash ref is a locally computed git object id, not provider text, but it is interpolated into
 * a message that crosses the wire. Admit it only as a bare hex oid so a git build that someday
 * returns prose on this channel cannot widen what reaches the client (the `#4068`/`#4077`
 * redaction contract, of which `isSafePromptFailureCode` is the classifier-token half).
 */
const STASH_REF_PATTERN = /^[0-9a-f]{7,64}$/;

/**
 * Admit a stash ref only as a bare hex oid. Applied at BOTH ends — where the ref is captured and
 * where it is written into something wire-bound — because the wording and `preservedStashRef` are
 * reachable with any `PostStartPreservation`, not only one this module built.
 */
export function safeStashRef(value: unknown): string | undefined {
	return typeof value === "string" && STASH_REF_PATTERN.test(value) ? value : undefined;
}

/**
 * Admit an uncaptured-untracked count only as a non-negative safe integer, for the same reason
 * `safeStashRef` exists: `PostStartPreservation` is reachable with any value and this number is
 * interpolated into wire-bound text. A non-integer, negative, or absent count reads as zero rather
 * than reaching the operator as prose.
 */
export function uncapturedUntrackedCount(value: unknown): number {
	return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : 0;
}

/**
 * Read a status conservatively. A missing or unrecognized value becomes `unknown` rather than
 * `clean`, for the same reason `safeStashRef` and `uncapturedUntrackedCount` bound their inputs:
 * this type is reachable with any value, and the failure that must never happen here is telling an
 * operator their worktree is empty when nobody established that.
 */
export function preservationStatus(value: unknown): PostStartPreservationStatus {
	return value === "preserved" || value === "clean" ? value : "unknown";
}

/**
 * Only an explicit `true` asserts the worktree held still across the capture.
 *
 * Positive framing on purpose: a missing or garbage value is then "not verified stable", which is
 * the conservative side. The inverse spelling would let an absent field silently mean "no race" and
 * promote an unverified snapshot to complete — the exact direction this must never fail in.
 */
function verifiedStable(value: unknown): boolean {
	return value === true;
}

/** Read a race flag defensively; only an explicit `true` claims one was observed. */
export function racedDuringCapture(value: unknown): boolean {
	return value === true;
}

/** A worktree nobody could inspect. Conservative by construction. */
export function unverifiedPreservation(): PostStartPreservation {
	return { status: "unknown", snapshotComplete: false };
}

/** The action an operator must take when the snapshot does not hold everything. */
export const OPERATOR_KEEP_WORKTREE = "do not discard this worktree";
export const OPERATOR_NOTHING_TO_PRESERVE = "No uncommitted work was found to preserve.";
export const OPERATOR_UPSTREAM_LABEL = "Upstream provider failure";
export const OPERATOR_UPSTREAM_SUFFIX = ": the model provider ended this turn, not your task.";
export const OPERATOR_POST_START_PREFIX = "The turn ended after execution had already started.";

/**
 * Budgets for the capture. `#settlePrompt` runs this SYNCHRONOUSLY before it rejects the turn, so a
 * slow git invocation blocks the Bun event loop and delays the very terminal this exists to make
 * safe. The capture therefore runs on ASYNC child processes: `execFileSync` would pin the loop for the
 * whole wall, and one `AcpAgent` serves many session records in one process, so a blocking capture
 * stalls every OTHER session's frames too. `execFile` enforces both bounds for real (a `timeout`
 * overrun SIGKILLs the child; a `maxBuffer` overrun rejects) while leaving the loop free —
 * measured on this runtime: 0 loop ticks during a 1s sync child, 46 during the same async one.
 *
 * `PRESERVE_BUDGET_MS` is the WHOLE-capture wall, and the per-command cap alone cannot enforce it:
 * the dirty path runs up to six git children, so six independent 2s caps admit ~12s. Each spawn is
 * therefore given `min(GIT_COMMAND_TIMEOUT_MS, deadline - now)` — see {@link boundedGit} — which
 * bounds the total at the wall plus at most one command's scheduling grace.
 */
const GIT_COMMAND_TIMEOUT_MS = 2_000;
const GIT_OUTPUT_MAX_BYTES = 1_000_000;
const PRESERVE_BUDGET_MS = 5_000;
/**
 * Below this much remaining budget, do not spawn at all.
 *
 * Not a nicety — it is the only safe handling of the tail. `timeout: 0` is UNBOUNDED (measured:
 * `timeout: 0` against `sleep 3` completed in 3013ms), so a naive `Math.min(cap, remaining)` would
 * make the worst case — no budget left — strictly worse than having no deadline at all. A negative
 * throws `ERR_OUT_OF_RANGE`. Skipping the spawn is the only correct tail.
 */
const MIN_SPAWN_BUDGET_MS = 50;

/**
 * How long settlement will wait for the detached capture tail before rejecting without it.
 *
 * `preservePostStartWork` already bounds its own git work to {@link PRESERVE_BUDGET_MS}, so in
 * practice the tail always wins this race. The wall exists for the case that bound cannot cover — an
 * injected capture seam that never settles, or a pathological stall between spawns — because a
 * deferred reject that never fires would hang the prompt forever, which is strictly worse than the
 * blocking this deferral replaces. The grace is what separates "the capture used its whole budget"
 * from "the capture is never coming back".
 */
export const SETTLE_PRESERVATION_WALL_MS = PRESERVE_BUDGET_MS + 1_000;

/** This is the ACP settle path, not the harness vanish path; the stash list records which. */
const STASH_MESSAGE = "gjc-post-start-snapshot";

/** The three facts the ACP path needs. Deliberately NOT the full vanish-receipt evidence set. */
export interface WorktreeCapture {
	status: PostStartPreservationStatus;
	stashRef?: string;
	untrackedNotCaptured: number;
	/**
	 * `true` ONLY when the capture was fenced against its own snapshot afterwards: the working tree
	 * still matched the stash object's tree (`git diff --quiet <oid>`) AND no untracked file appeared.
	 * Absent, `false`, or garbage all mean "not verified", which downgrades the result rather than
	 * promoting it — see {@link verifiedStable}.
	 */
	stable?: boolean;
}

/** Injectable capture seam; production uses {@link boundedWorktreeCapture}. */
export type WorktreeCaptureFn = (workspace: string) => Promise<WorktreeCapture> | WorktreeCapture;

/** A git runner already bound to one capture's workspace and deadline. */
type BoundedGit = (args: string[]) => Promise<string>;

const execFileAsync = promisify(execFile);

/**
 * Raised instead of spawning when the whole-capture deadline leaves no usable room.
 *
 * Deliberately an exception: every call site already treats a git failure as "git did not answer"
 * and degrades accordingly, so budget exhaustion lands in exactly the right branch without any
 * caller needing a second code path. It carries no `status`, so `isPlainExit` rejects it and it can
 * never be mistaken for git answering.
 */
class CaptureBudgetExhausted extends Error {}

/**
 * Bind a git runner to one capture, so the remaining budget travels with every child it spawns.
 *
 * The deadline is a closure parameter rather than module state on purpose: two concurrent captures
 * must not share, or reset, each other's wall.
 */
function boundedGit(workspace: string, deadline: number): BoundedGit {
	return async (args: string[]): Promise<string> => {
		const remaining = deadline - Date.now();
		// Never pass 0 (unbounded) or a negative (throws ERR_OUT_OF_RANGE).
		if (remaining < MIN_SPAWN_BUDGET_MS) throw new CaptureBudgetExhausted();
		const { stdout } = await execFileAsync("git", args, {
			cwd: workspace,
			encoding: "utf8",
			timeout: Math.min(GIT_COMMAND_TIMEOUT_MS, remaining),
			maxBuffer: GIT_OUTPUT_MAX_BYTES,
			killSignal: "SIGKILL",
		});
		return stdout;
	};
}

/**
 * True only for a git process that ran to completion and exited with `expected`.
 *
 * This is the distinction the whole `clean` vs `unknown` split rests on: a plain non-zero exit is
 * git ANSWERING (`diff --quiet` exits 1 to mean "dirty"), whereas a spawn failure, a timeout kill,
 * or an output-cap overrun means git never answered at all. Reading the second as the first is what
 * would report an uninspectable worktree as clean.
 *
 * The ASYNC error shape differs from the sync one and this predicate reads the async shape.
 * Measured on this runtime:
 *
 *   case                     execFileSync                promisify(execFile)
 *   -----------------------  --------------------------  ---------------------------------------
 *   diff --quiet, dirty      {status:1, code:undefined}  {code:1, status:undefined, killed:false}
 *   timeout (SIGKILL)        {code:"ETIMEDOUT"}          {code:null, killed:true, signal:"SIGKILL"}
 *   missing binary           {code:"ENOENT"}             {code:"ENOENT", errno:-2}
 *   maxBuffer overrun        {code:"ENOBUFS"}            {code:"ERR_CHILD_PROCESS_STDIO_MAXBUFFER"}
 *
 * So the exit code now arrives as a NUMBER in `code` and `status` is undefined — reading `status`
 * here would make every dirty worktree degrade to `unknown`, silently disabling the whole feature
 * while the honest-status tests still passed. `killed` is checked explicitly because a SIGKILLed
 * timeout carries `code: null`, and `typeof null !== "string"`, so a string-only guard would read a
 * killed child as an answer.
 */
function isPlainExit(error: unknown, expected: number): boolean {
	const candidate = error as { code?: unknown; killed?: unknown } | undefined;
	if (candidate?.killed === true) return false;
	return typeof candidate?.code === "number" && candidate.code === expected;
}

/**
 * Bounded, read-mostly worktree capture for the ACP settle path.
 *
 * It deliberately does NOT reuse `preserveDirtyWorktree`: that helper backs a `vanish` receipt,
 * where completeness is the point, so it hashes every untracked file's CONTENTS and runs unbounded
 * git commands. This path needs only three facts — is it dirty, is there a recoverable ref, how
 * many untracked files are outside that ref — and it needs them fast, so it never reads file
 * contents and never runs a git command without a timeout and an output cap.
 *
 * Non-destructive, exactly as before: `git stash create` builds a commit object without touching
 * the working tree, and `git stash store` only writes a ref. Nothing resets, cleans, or commits.
 */
/** The two cheap observations the capture is built on. */
interface WorktreeObservation {
	trackedDirty: boolean;
	untracked: number;
}

/**
 * One bounded pass of the two observations, or `undefined` when git did not answer.
 *
 * `diff --quiet` produces NO output, so a huge diff cannot blow the buffer: exit 0 = no tracked
 * change, exit 1 = dirty, anything else = git did not answer. A worktree emitting more untracked
 * paths than the output cap is emphatically not clean, so a truncated read is a non-answer too.
 */
async function observeWorktree(git: BoundedGit): Promise<WorktreeObservation | undefined> {
	let trackedDirty: boolean;
	try {
		await git(["diff", "--quiet", "HEAD"]);
		trackedDirty = false;
	} catch (error) {
		// Covers budget exhaustion too: `CaptureBudgetExhausted` carries no `status`, so it is not a
		// plain exit and the observation degrades to "git did not answer" — never to `clean`.
		if (!isPlainExit(error, 1)) return undefined;
		trackedDirty = true;
	}
	try {
		const untracked = (await git(["ls-files", "--others", "--exclude-standard"]))
			.split("\n")
			.map(line => line.trim())
			.filter(Boolean).length;
		return { trackedDirty, untracked };
	} catch {
		return undefined;
	}
}

/**
 * Content fence: does the WORKING TREE still hold exactly what the stash object captured?
 *
 * `git diff --quiet <oid>` compares the worktree against that object's tree, which is precisely the
 * "did the tracked content stay equal to what I captured" question — and it is content-aware where
 * the coarse observation pair is not. Measured on git 2.47.3 and 2.55.0: a tracked file edited after
 * `stash create` leaves `diff --quiet HEAD` still exiting 1 and the untracked count unchanged (so the
 * coarse pair says "stable"), while `diff --quiet <oid>` exits 1 and catches it. `--quiet` emits no
 * output, so however large the divergence it cannot blow the output cap.
 *
 * Only a PLAIN exit 0 is stability. A plain exit 1 is git answering "diverged"; a string `code` — a
 * spawn failure, `ETIMEDOUT`, `ENOBUFS` — is git not answering at all, and an unverifiable fence must
 * never promote a result to complete.
 */
async function trackedMatchesSnapshot(git: BoundedGit, stashRef: string | undefined): Promise<boolean> {
	// No stash object means there is no tree to fence against, so stability cannot be established.
	if (stashRef === undefined) return false;
	try {
		await git(["diff", "--quiet", stashRef]);
		return true;
	} catch {
		// Includes "no budget left to run the fence", which is not verification either.
		return false;
	}
}

export async function boundedWorktreeCapture(workspace: string): Promise<WorktreeCapture> {
	// One deadline for the whole capture, carried by the runner into every child it spawns. Each
	// spawn is capped at the smaller of the per-command cap and what is left, and a spawn with no
	// room left is skipped rather than started, so the boundary checks this used to do between
	// commands are now enforced at every spawn instead of only at a few points.
	const git = boundedGit(workspace, Date.now() + PRESERVE_BUDGET_MS);
	const unknown: WorktreeCapture = { status: "unknown", untrackedNotCaptured: 0 };

	// 1. Observe the worktree.
	const before = await observeWorktree(git);
	if (before === undefined) return unknown;

	// 2. Verified empty — but only if it is STILL empty once re-read. Nothing is stashed either way.
	if (!before.trackedDirty && before.untracked === 0) {
		const after = await observeWorktree(git);
		// Cannot re-read, or it changed: either way "verified empty" is no longer a claim anyone can
		// make, and asserting it would strand whatever landed. Downgrade to `unknown`, never `clean`.
		if (after === undefined || after.trackedDirty || after.untracked !== 0) return unknown;
		return { status: "clean", untrackedNotCaptured: 0, stable: true };
	}

	/**
	 * Decide stability from two independent post-capture checks, then report.
	 *
	 * The tracked half is a CONTENT fence against the snapshot itself ({@link trackedMatchesSnapshot}),
	 * not a re-comparison of the coarse observations. Comparing `before`/`after` cannot see a tracked
	 * file edited while `stash create` ran: the file is dirty in both observations and the untracked
	 * count is unchanged, so the coarse pair called it stable while the stash held only the earlier
	 * bytes — the operator was then told the snapshot was complete and swept the later edit away.
	 *
	 * The untracked half still needs the coarse re-read, because the fence is blind to it: a new
	 * untracked file leaves the two tracked trees identical. The uncaptured count reported is the
	 * larger of the two, since files that appeared mid-capture are absent from the snapshot too.
	 *
	 * A non-answer on either half is NOT stability.
	 */
	const settle = async (stashRef: string | undefined): Promise<WorktreeCapture> => {
		// Fence first, so it runs as close to the capture as the budget allows.
		const trackedStable = await trackedMatchesSnapshot(git, stashRef);
		const after = await observeWorktree(git);
		const untrackedStable = after !== undefined && after.untracked === before.untracked;
		const untrackedNotCaptured = Math.max(before.untracked, after?.untracked ?? before.untracked);
		return {
			status: "preserved",
			...(stashRef === undefined ? {} : { stashRef }),
			untrackedNotCaptured,
			stable: trackedStable && untrackedStable,
		};
	};

	// 3. Untracked-only: no tracked content for a stash object to hold, so there is no ref to offer.
	//    Reported as preserved-without-a-ref, which routes to the keep-the-worktree wording.
	if (!before.trackedDirty) return await settle(undefined);

	// 4. Snapshot the tracked content. A failure here means no recoverable ref — still `preserved`,
	//    because the tree IS known dirty, just not recoverable from the stash list.
	let oid: string;
	try {
		oid = (await git(["stash", "create", STASH_MESSAGE])).trim();
	} catch {
		// Failed, timed out, or no budget left to start: still `preserved`, just no ref.
		return await settle(undefined);
	}
	if (oid.length === 0) return await settle(undefined);

	try {
		await git(["stash", "store", "-m", STASH_MESSAGE, oid]);
	} catch {
		// The object exists but nothing references it, so it is not durably recoverable.
		return await settle(undefined);
	}
	// The ref is kept even when the re-read differs: it genuinely recovers the tracked content it
	// holds, and discarding a real ref over a race would help nobody. `settle` marks it unstable so
	// the snapshot is reported incomplete rather than complete.
	return await settle(oid);
}

/**
 * Report what a post-start terminal managed to preserve, without ever letting that reporting change
 * the terminal outcome the caller would otherwise have produced.
 *
 * Every failure mode reports `unknown` rather than throwing: a missing workspace, a workspace that
 * is not a git repo, a git binary that is missing or hangs, a capture that overran its budget.
 * "I could not look" is reported as exactly that, never as a verified-clean tree.
 */
export async function preservePostStartWork(
	workspace: string | undefined,
	capture: WorktreeCaptureFn = boundedWorktreeCapture,
): Promise<PostStartPreservation> {
	if (typeof workspace !== "string" || workspace.length === 0) return unverifiedPreservation();
	try {
		const result = await capture(workspace);
		const status = preservationStatus(result.status);
		if (status === "unknown") return unverifiedPreservation();
		// A `clean` verdict is only worth reporting when the capture actually verified the tree held
		// still. An unverified "clean" is indistinguishable from "I did not look", so it degrades to
		// `unknown` rather than reassuring an operator about a tree that may have changed.
		if (status === "clean")
			return verifiedStable(result.stable) ? { status: "clean", snapshotComplete: true } : unverifiedPreservation();
		const stable = verifiedStable(result.stable);
		const stashRef = safeStashRef(result.stashRef);
		// `git stash create` snapshots tracked+staged content ONLY — an untracked file is absent from
		// the stash object's tree, so `git stash apply <ref>` will not bring it back. (Not fixable by
		// passing `-u`: `git stash create` takes a MESSAGE, not flags, so `-u` becomes the message and
		// the tree is unchanged — verified on git 2.47.3 and 2.55.0. Real untracked capture needs
		// `git stash push -u`, which mutates the worktree and would break this path's non-destructive
		// guarantee.) So a dirty tree carrying untracked files is NOT completely snapshotted.
		const untrackedNotCaptured = uncapturedUntrackedCount(result.untrackedNotCaptured);
		return {
			status: "preserved",
			...(stashRef === undefined ? {} : { stashRef }),
			// A snapshot taken across a changing worktree is not complete, however good the ref is.
			snapshotComplete: stashRef !== undefined && untrackedNotCaptured === 0 && stable,
			...(untrackedNotCaptured > 0 ? { untrackedNotCaptured } : {}),
			...(stable ? {} : { racedDuringCapture: true }),
		};
	} catch {
		return unverifiedPreservation();
	}
}

/**
 * `preservePostStartWork` bounded so settlement can never wait on it indefinitely.
 *
 * The capture already bounds its own git work to {@link PRESERVE_BUDGET_MS}, so in practice it
 * always wins this race. The wall covers what that bound cannot: an injected capture seam that
 * never settles, or a stall between spawns. It matters because the caller defers its rejection
 * until this resolves, and a deferred reject that never fires hangs the prompt forever — strictly
 * worse than the blocking the deferral replaces.
 *
 * NEVER rejects and never resolves `clean` on a failure: every degraded path reports `unknown`, so
 * a capture nobody could complete is reported as unverified rather than as an empty worktree.
 */
export async function preserveWithinSettlementWall(
	workspace: string | undefined,
	capture: WorktreeCaptureFn = boundedWorktreeCapture,
	wallMs: number = SETTLE_PRESERVATION_WALL_MS,
): Promise<PostStartPreservation> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		return await Promise.race([
			preservePostStartWork(workspace, capture),
			new Promise<PostStartPreservation>(resolve => {
				timer = setTimeout(() => resolve(unverifiedPreservation()), wallMs);
				// A pending wall must never hold the process open.
				timer.unref?.();
			}),
		]);
	} catch {
		// `preservePostStartWork` degrades internally rather than throwing, so this is
		// belt-and-braces — the caller still gets a result it can reject with.
		return unverifiedPreservation();
	} finally {
		if (timer) clearTimeout(timer);
	}
}

/**
 * Operator-facing wording for a post-start terminal, assembled ONLY from bounded safe tokens: the
 * classifier `category`, a `providerCode` that passes `isSafePromptFailureCode`, and a hex stash
 * oid. Raw provider text never reaches this function and must never reach it.
 *
 * This is additive. The wire `code`/`details` pair and every `PROMPT_FAILURE_MESSAGE_*` constant
 * stay exactly as they are — pinned ACP core-v1 conformance asserts on them — so this wording
 * travels alongside the redacted message instead of repurposing it.
 *
 * Returns `undefined` when there is nothing an operator would not already know: a non-transport
 * failure that also preserved no work reads no better with a sentence added to it.
 */
export function postStartOperatorMessage(input: {
	category: SdkPromptFailureCategory;
	providerCode?: string;
	preservation?: PostStartPreservation;
}): string | undefined {
	const upstream = input.category === "provider_transport";
	const { preservation } = input;
	if (!upstream && !preservation) return undefined;

	const parts: string[] = [];
	if (upstream) {
		const code = isSafePromptFailureCode(input.providerCode) ? ` (${input.providerCode})` : "";
		parts.push(`${OPERATOR_UPSTREAM_LABEL}${code}${OPERATOR_UPSTREAM_SUFFIX}`);
	} else parts.push(OPERATOR_POST_START_PREFIX);

	// A rejection that never reached execution carries no preservation at all, because
	// `#settlePrompt` only captures for a `post_start` phase. Say NOTHING about the worktree in that
	// case: no inspection happened, so "no uncommitted work was found" would assert a check that was
	// never run — the same absence-of-evidence-as-evidence-of-absence error as reporting an
	// uninspectable tree clean. The upstream sentence alone is the whole message.
	const status = preservation === undefined ? undefined : preservationStatus(preservation.status);
	const ref = preservation === undefined ? undefined : safeStashRef(preservation.stashRef);
	if (preservation === undefined) {
		// Deliberately no preservation sentence.
	} else if (status === "clean") parts.push(OPERATOR_NOTHING_TO_PRESERVE);
	else if (status === "unknown")
		// Never "no work was found": nobody established that. The operator must keep the worktree
		// precisely BECAUSE the answer is unknown.
		parts.push(`Uncommitted work could not be verified or preserved; ${OPERATOR_KEEP_WORKTREE}.`);
	else if (ref === undefined)
		parts.push(
			"Uncommitted work was found but no recoverable snapshot ref is available; do not discard this worktree.",
		);
	else {
		parts.push(
			`Uncommitted work was preserved in the git stash list as ${ref} — recover it with \`git stash apply ${ref}\`.`,
		);
		// Name the gap precisely instead of a bare "incomplete". The stash genuinely recovers the
		// tracked edits, so that hint stays; what it does NOT contain is the new files, and an
		// operator who reads only the hint would sweep the worktree and lose them. A count, never a
		// path — see `PostStartPreservation.untrackedNotCaptured`.
		const uncaptured = uncapturedUntrackedCount(preservation.untrackedNotCaptured);
		if (uncaptured > 0)
			parts.push(
				`${uncaptured} new file(s) are NOT in that snapshot and exist only in the worktree; ${OPERATOR_KEEP_WORKTREE}.`,
			);
		// A boolean, never the paths that changed: this crosses the wire and those paths are
		// user-controlled.
		if (racedDuringCapture(preservation.racedDuringCapture))
			parts.push(
				`The worktree changed while it was being captured, so that snapshot may be missing later edits; ${OPERATOR_KEEP_WORKTREE}.`,
			);
		else if (uncaptured === 0 && !preservation.snapshotComplete)
			parts.push(`The snapshot is incomplete; ${OPERATOR_KEEP_WORKTREE}.`);
	}
	return parts.join(" ");
}
