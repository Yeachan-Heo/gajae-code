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
 */
import { preserveDirtyWorktree } from "../../harness-control-plane/preserve";
import { isSafePromptFailureCode } from "../../sdk/prompt-failure";
import type { SdkPromptFailureCategory } from "../../sdk/prompt-status";

/** What a post-start terminal managed to preserve. Absent when there was nothing to preserve. */
export interface PostStartPreservation {
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

/** The action an operator must take when the snapshot does not hold everything. */
export const OPERATOR_KEEP_WORKTREE = "do not discard this worktree";
export const OPERATOR_UPSTREAM_LABEL = "Upstream provider failure";
export const OPERATOR_UPSTREAM_SUFFIX = ": the model provider ended this turn, not your task.";
export const OPERATOR_POST_START_PREFIX = "The turn ended after execution had already started.";

/**
 * Snapshot a possibly-dirty worktree without mutating it, and never let that change the terminal
 * outcome the caller would otherwise have produced.
 *
 * `preserveDirtyWorktree` is the shipped helper (harness architect blocker B2): `git diff HEAD` +
 * sha256, an untracked manifest, and a `git stash create` + `git stash store` snapshot. It never
 * resets, cleans, commits, or otherwise touches the working tree. A clean tree makes
 * `git stash create` a no-op that emits no oid, so a failure storm cannot stash-spam the list.
 *
 * Every failure mode here returns `undefined` rather than throwing: a workspace that is not a git
 * repo, a git binary that is missing or hangs, a clean tree. Preservation is a best-effort
 * addition to a terminal path, never a new way for that path to fail.
 */
export function preservePostStartWork(
	workspace: string | undefined,
	preserve: typeof preserveDirtyWorktree = preserveDirtyWorktree,
): PostStartPreservation | undefined {
	if (typeof workspace !== "string" || workspace.length === 0) return undefined;
	try {
		const result = preserve(workspace);
		// Gate on dirty: a clean tree preserved nothing, so there is nothing to report and no ref
		// an operator could recover.
		if (result.gitDelta !== "dirty") return undefined;
		const stashRef = safeStashRef(result.stashRef);
		// `git stash create` snapshots tracked+staged content ONLY — an untracked file is absent from
		// the stash object's tree, so `git stash apply <ref>` will not bring it back. (Not fixable by
		// passing `-u`: `git stash create` takes a MESSAGE, not flags, so `-u` becomes the message and
		// the tree is unchanged — verified on git 2.47.3 and 2.55.0. Real untracked capture needs
		// `git stash push -u`, which mutates the worktree and would break this path's non-destructive
		// guarantee.) So a dirty tree carrying untracked files is NOT completely snapshotted, whatever
		// the shared helper's own `snapshotComplete` says about its manifest being readable.
		const untrackedNotCaptured = result.untrackedManifest.length;
		return {
			...(stashRef === undefined ? {} : { stashRef }),
			snapshotComplete: result.snapshotComplete === true && stashRef !== undefined && untrackedNotCaptured === 0,
			...(untrackedNotCaptured > 0 ? { untrackedNotCaptured } : {}),
		};
	} catch {
		return undefined;
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

	const ref = preservation === undefined ? undefined : safeStashRef(preservation.stashRef);
	if (preservation === undefined) parts.push("No uncommitted work was found to preserve.");
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
