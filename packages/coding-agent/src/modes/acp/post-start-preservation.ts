/**
 * Work preservation and operator wording for a post-start terminal prompt failure (issue #5664).
 *
 * A turn that fails AFTER execution started may have spent an hour editing the worktree. The
 * failure is terminal by design — a re-submit is a NEW independent `turn.prompt`, so replaying a
 * turn that already ran `apply_patch` would re-run the user's side effects, which is exactly what
 * `#shouldRetryFirstPrompt`'s tool/output gates exist to prevent (issue #5574). Nothing here
 * re-opens those gates. Instead it makes the terminal outcome non-destructive and non-misleading:
 *
 *   - the uncommitted work is snapshotted into the git stash list BEFORE the turn reports `error`,
 *     so an operator can recover it after the worktree is swept;
 *   - the snapshot's location is stated in operator-facing wording, because a snapshot nobody can
 *     find is not a fix;
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
		return {
			...(stashRef === undefined ? {} : { stashRef }),
			snapshotComplete: result.snapshotComplete === true && stashRef !== undefined,
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
		if (!preservation.snapshotComplete) parts.push("The snapshot is incomplete; do not discard this worktree.");
	}
	return parts.join(" ");
}
