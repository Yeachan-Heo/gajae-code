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
import { execFileSync } from "node:child_process";
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

/** A worktree nobody could inspect. Conservative by construction. */
function unverifiedPreservation(): PostStartPreservation {
	return { status: "unknown", snapshotComplete: false };
}

/** The action an operator must take when the snapshot does not hold everything. */
export const OPERATOR_KEEP_WORKTREE = "do not discard this worktree";
export const OPERATOR_NOTHING_TO_PRESERVE = "No uncommitted work was found to preserve.";
export const OPERATOR_UPSTREAM_LABEL = "Upstream provider failure";
export const OPERATOR_UPSTREAM_SUFFIX = ": the model provider ended this turn, not your task.";
export const OPERATOR_POST_START_PREFIX = "The turn ended after execution had already started.";

/**
 * Budgets for the capture. `#settlePrompt` runs this SYNCHRONOUSLY before it rejects the turn, so
 * an unbounded git invocation blocks the Bun event loop and delays the very terminal this exists to
 * make safe. `execFileSync` honours both of these for real on this runtime (a `timeout` overrun
 * throws `ETIMEDOUT` after SIGKILL; a `maxBuffer` overrun throws `ENOBUFS`), so they are enforcement
 * rather than decoration.
 */
const GIT_COMMAND_TIMEOUT_MS = 2_000;
const GIT_OUTPUT_MAX_BYTES = 1_000_000;
const PRESERVE_BUDGET_MS = 5_000;

/** This is the ACP settle path, not the harness vanish path; the stash list records which. */
const STASH_MESSAGE = "gjc-post-start-snapshot";

/** The three facts the ACP path needs. Deliberately NOT the full vanish-receipt evidence set. */
export interface WorktreeCapture {
	status: PostStartPreservationStatus;
	stashRef?: string;
	untrackedNotCaptured: number;
}

/** Injectable capture seam; production uses {@link boundedWorktreeCapture}. */
export type WorktreeCaptureFn = (workspace: string) => WorktreeCapture;

function gitRun(workspace: string, args: string[]): string {
	return execFileSync("git", args, {
		cwd: workspace,
		encoding: "utf8",
		stdio: ["ignore", "pipe", "ignore"],
		timeout: GIT_COMMAND_TIMEOUT_MS,
		maxBuffer: GIT_OUTPUT_MAX_BYTES,
		killSignal: "SIGKILL",
	});
}

/**
 * True only for a git process that ran to completion and exited with `expected`.
 *
 * This is the distinction the whole `clean` vs `unknown` split rests on: a plain non-zero exit is
 * git ANSWERING (`diff --quiet` exits 1 to mean "dirty"), whereas a spawn failure, an `ETIMEDOUT`,
 * or an `ENOBUFS` sets a string `code` and means git never answered at all. Reading the second as
 * the first is what would report an uninspectable worktree as clean.
 */
function isPlainExit(error: unknown, expected: number): boolean {
	const candidate = error as { status?: unknown; code?: unknown } | undefined;
	return candidate?.status === expected && typeof candidate?.code !== "string";
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
export function boundedWorktreeCapture(workspace: string): WorktreeCapture {
	const deadline = Date.now() + PRESERVE_BUDGET_MS;
	const overBudget = (): boolean => Date.now() > deadline;
	const unknown: WorktreeCapture = { status: "unknown", untrackedNotCaptured: 0 };

	// 1. Tracked changes. `--quiet` produces NO output, so a huge diff cannot blow the buffer:
	//    exit 0 = no tracked change, exit 1 = dirty, anything else = git did not answer.
	if (overBudget()) return unknown;
	let trackedDirty: boolean;
	try {
		gitRun(workspace, ["diff", "--quiet", "HEAD"]);
		trackedDirty = false;
	} catch (error) {
		if (!isPlainExit(error, 1)) return unknown;
		trackedDirty = true;
	}

	// 2. Untracked COUNT only — never contents. A worktree emitting more than the cap is
	//    emphatically not clean, so a truncated read is `unknown`, never `clean`.
	if (overBudget()) return unknown;
	let untrackedNotCaptured: number;
	try {
		untrackedNotCaptured = gitRun(workspace, ["ls-files", "--others", "--exclude-standard"])
			.split("\n")
			.map(line => line.trim())
			.filter(Boolean).length;
	} catch {
		return unknown;
	}

	// 3. Verified empty: nothing to stash, so nothing is stashed.
	if (!trackedDirty && untrackedNotCaptured === 0) return { status: "clean", untrackedNotCaptured: 0 };
	// Untracked-only: there is no tracked content for a stash object to hold, so there is no ref to
	// offer. Reported as preserved-without-a-ref, which routes to the keep-the-worktree wording.
	if (!trackedDirty) return { status: "preserved", untrackedNotCaptured };

	// 4. Snapshot the tracked content. A failure here means no recoverable ref — still `preserved`,
	//    because the tree IS known dirty, just not recoverable from the stash list.
	if (overBudget()) return { status: "preserved", untrackedNotCaptured };
	let oid: string;
	try {
		oid = gitRun(workspace, ["stash", "create", STASH_MESSAGE]).trim();
	} catch {
		return { status: "preserved", untrackedNotCaptured };
	}
	if (oid.length === 0) return { status: "preserved", untrackedNotCaptured };

	if (overBudget()) return { status: "preserved", untrackedNotCaptured };
	try {
		gitRun(workspace, ["stash", "store", "-m", STASH_MESSAGE, oid]);
	} catch {
		// The object exists but nothing references it, so it is not durably recoverable.
		return { status: "preserved", untrackedNotCaptured };
	}
	return { status: "preserved", stashRef: oid, untrackedNotCaptured };
}

/**
 * Report what a post-start terminal managed to preserve, without ever letting that reporting change
 * the terminal outcome the caller would otherwise have produced.
 *
 * Every failure mode reports `unknown` rather than throwing: a missing workspace, a workspace that
 * is not a git repo, a git binary that is missing or hangs, a capture that overran its budget.
 * "I could not look" is reported as exactly that, never as a verified-clean tree.
 */
export function preservePostStartWork(
	workspace: string | undefined,
	capture: WorktreeCaptureFn = boundedWorktreeCapture,
): PostStartPreservation {
	if (typeof workspace !== "string" || workspace.length === 0) return unverifiedPreservation();
	try {
		const result = capture(workspace);
		const status = preservationStatus(result.status);
		if (status === "unknown") return unverifiedPreservation();
		if (status === "clean") return { status: "clean", snapshotComplete: true };
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
			snapshotComplete: stashRef !== undefined && untrackedNotCaptured === 0,
			...(untrackedNotCaptured > 0 ? { untrackedNotCaptured } : {}),
		};
	} catch {
		return unverifiedPreservation();
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
		else if (!preservation.snapshotComplete) parts.push(`The snapshot is incomplete; ${OPERATOR_KEEP_WORKTREE}.`);
	}
	return parts.join(" ");
}
