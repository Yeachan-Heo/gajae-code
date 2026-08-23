/**
 * Result unions for `gjc setup paseo`.
 *
 * `SetupCheckResult` is deliberately four-valued. Parse failures, conflicts,
 * missing executables, and partial-operation evidence are all `drift` carrying
 * a structured reason -- they are NOT extra top-level statuses. Install and
 * remove outcomes live in their own unions so command outcomes never leak into
 * the diagnosis DTO.
 */

/** The four locked check states. Adding a fifth is a spec change, not an implementation detail. */
export type SetupCheckStatus = "pass" | "drift" | "stale" | "skipped";

/** Structured detail carried inside a `drift` result. */
export type DriftReasonCode =
	| "parse-refusal"
	| "format-drift"
	| "owned-key-conflict"
	| "missing-executable"
	| "partial-install"
	| "partial-removal"
	| "orphan-skill"
	| "missing-provider-entry"
	| "missing-bridge-link"
	| "missing-skills-directory"
	| "foreign-skill-link"
	| "unseeded-orchestration-role";

export interface DriftReason {
	readonly code: DriftReasonCode;
	/** Which owned path or key the reason concerns. Never a secret value. */
	readonly subject: string;
	readonly detail: string;
}

export interface SetupCheckResult {
	readonly component: "paseo";
	readonly status: SetupCheckStatus;
	readonly reasons: readonly DriftReason[];
	/** Human-facing next step, present for `stale` so the user knows a restart is theirs to make. */
	readonly guidance?: string;
}

export interface PartialInstallEvidence {
	readonly failedStep: string;
	readonly detail: string;
	/** Paths whose state was preserved for recovery. Never file contents. */
	readonly retained: readonly string[];
}

export type PaseoInstallResult =
	| { readonly outcome: "installed"; readonly changed: readonly string[] }
	| {
			readonly outcome: "partial-install";
			readonly compensated: readonly string[];
			readonly uncompensated: readonly string[];
			readonly evidence: PartialInstallEvidence;
	  };

export interface PartialRemovalEvidence {
	readonly failedStep: string;
	readonly detail: string;
	readonly retained: readonly string[];
}

export type PaseoRemoveResult =
	| { readonly outcome: "removed"; readonly removed: readonly string[] }
	| { readonly outcome: "nothing-to-remove" }
	| {
			readonly outcome: "partial-removal";
			readonly removed: readonly string[];
			readonly remaining: readonly string[];
			readonly evidence: PartialRemovalEvidence;
	  };

/** Exit code for a check result. `stale` and `skipped` are not failures. */
export function checkExitCode(result: SetupCheckResult): number {
	return result.status === "drift" ? 1 : 0;
}
