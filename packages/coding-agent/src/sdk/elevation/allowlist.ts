import { findOperation } from "../protocol/operation-registry";

/**
 * Exact elevation-gated allowlist, fully qualified and enumerative.
 *
 * The elevation allowlist is the exact set of registry operations below (the
 * raw destructive lifecycle and workflow-approval operations). It is declared
 * ONCE here as a `Set<string>` of `"kind:sdkId"` keys and mechanically pinned
 * against `operation-registry.ts` by the allowlist unit test: every key must
 * resolve via `findOperation(kind, sdkId)` and no elevatable operation may be
 * silently missing. Any operation NOT in this set is rejected at issue with
 * `elevation_not_allowlisted` before any ledger reservation. There is no
 * generalized policy engine: this is the deterministic predicate.
 */
export const ELEVATION_ALLOWLIST_KEYS = [
	"global:session.close",
	"global:session.delete",
	"control:session.delete",
	"control:session.close",
	"control:context.clear",
	"control:session.cwd.move",
	"control:compaction.run",
	"control:bash.execute",
	"control:bash.background",
	"control:queue.message.remove",
	"control:queue.message.update",
	"control:retry.abort",
	"control:retry.now",
	"control:bash.abort",
	"control:retry.auto.set",
	"control:compaction.auto.set",
	"control:extension.set_enabled",
	"control:queue.interrupt_mode.set",
	"control:queue.follow_up_mode.set",
	"control:queue.steering_mode.set",
	"control:tools.active.set",
	"control:permission_mode.set",
	"control:service_tier.set",
	"control:workflow.gate_answer",
	"control:workflow.plan_approve",
] as const;
const elevationAllowlistKeySet = new Set<string>(ELEVATION_ALLOWLIST_KEYS);

/**
 * Whether `(kind, sdkId)` is the fully qualified identity of an allowlisted
 * elevation-gated operation. The pair is validated against the operation
 * registry before any elevation is admitted, so a key can never name an
 * operation that does not exist.
 */
export function isElevationAllowlisted(kind: unknown, sdkId: unknown): boolean {
	if (typeof kind !== "string" || typeof sdkId !== "string") return false;
	if (!elevationAllowlistKeySet.has(`${kind}:${sdkId}`)) return false;
	return findOperation(kind as "control" | "global" | "query" | "reverse", sdkId) !== undefined;
}
