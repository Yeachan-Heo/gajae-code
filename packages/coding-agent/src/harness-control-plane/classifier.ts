/**
 * Deterministic recovery classifier (pure).
 *
 * Maps a bounded {@link Observation} + remaining retry budget to exactly one
 * {@link RecoveryDecision}. Encodes the plan's hard data-loss invariants:
 *   - dirty deltas are NEVER `restart-clean`; they map to `restart-preserve-delta`.
 *   - unknown deltas are NEVER destructive; they map to `human-check`.
 *   - a deleted/mismatched worktree maps to `human-check` (never recreate over unknown data).
 * `send-enter` is intentionally never emitted: it is unsupported for the gajae-code
 * RPC adapter in v1 (no blind key injection).
 */
import type { ClassifyInput, RecoveryDecision } from "./types";

export function classifyRecovery(input: ClassifyInput): RecoveryDecision {
	const { observation: o, retryBudget: budget } = input;

	// Deleted worktree / path mismatch — never recreate over unknown data.
	if (o.risk === "deleted-worktree") {
		return {
			classification: "human-check",
			reason: "deleted-worktree-or-path-mismatch",
			severity: "critical",
			ownerRequired: false,
			requiredReceiptFamily: "vanish",
		};
	}

	if (o.ownerLive) {
		if (o.risk === "prompt-not-accepted") {
			if (budget.reinjectPrompt > 0) {
				return {
					classification: "reinject-prompt",
					reason: "prompt-ack-without-agent-start",
					severity: "warn",
					ownerRequired: true,
					requiredReceiptFamily: "prompt-acceptance",
				};
			}
			return {
				classification: "human-check",
				reason: "prompt-not-accepted-budget-exhausted",
				severity: "critical",
				ownerRequired: false,
				requiredReceiptFamily: null,
			};
		}
		if (o.observedSignals.includes("validation-failed")) {
			if (budget.validationRepair > 0) {
				return {
					classification: "continue",
					reason: "validation-failed-repair-budget-remains",
					severity: "warn",
					ownerRequired: true,
					requiredReceiptFamily: "validation",
				};
			}
			return {
				classification: "human-check",
				reason: "validation-failed-budget-exhausted",
				severity: "critical",
				ownerRequired: false,
				requiredReceiptFamily: "validation",
			};
		}
		return {
			classification: "continue",
			reason: "owner-live-active",
			severity: "info",
			ownerRequired: true,
			requiredReceiptFamily: null,
		};
	}

	// Owner / RPC vanished — branch on git delta. Every branch requires a `vanish` receipt.
	switch (o.gitDelta) {
		case "dirty":
			if (budget.dirtyVanishPreserve > 0) {
				return {
					classification: "restart-preserve-delta",
					reason: "owner-vanished-dirty-delta",
					severity: "critical",
					ownerRequired: true,
					requiredReceiptFamily: "vanish",
				};
			}
			return {
				classification: "fallback-codex-exec",
				reason: "dirty-vanish-preserve-budget-exhausted",
				severity: "critical",
				ownerRequired: true,
				requiredReceiptFamily: "vanish",
			};
		case "zero-delta":
			if (budget.zeroDeltaVanish > 0) {
				return {
					classification: "restart-clean",
					reason: "owner-vanished-zero-delta",
					severity: "warn",
					ownerRequired: true,
					requiredReceiptFamily: "vanish",
				};
			}
			return {
				classification: "fallback-codex-exec",
				reason: "zero-delta-vanish-budget-exhausted",
				severity: "critical",
				ownerRequired: true,
				requiredReceiptFamily: "vanish",
			};
		case "clean":
			return {
				classification: "restart-clean",
				reason: "owner-vanished-clean",
				severity: "warn",
				ownerRequired: true,
				requiredReceiptFamily: "vanish",
			};
		default:
			// unknown delta — critical, never destructive.
			return {
				classification: "human-check",
				reason: "owner-vanished-unknown-delta",
				severity: "critical",
				ownerRequired: false,
				requiredReceiptFamily: "vanish",
			};
	}
}
