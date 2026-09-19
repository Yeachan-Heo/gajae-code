import type { DoctorCheck } from "./types";

/** Maximum UTF-8 payload accepted by the doctor probe transport. */
export const PROBE_OUTPUT_LIMIT_BYTES = 64 * 1024;
/**
 * Producer-side budget for a projection receipt. Kept below the transport limit
 * so the probe never has to discard a whole surface: the producer sheds its own
 * lowest-value item checks instead. The headroom covers the trailing newline
 * and transport framing.
 */
export const PROJECTION_RECEIPT_BUDGET_BYTES = PROBE_OUTPUT_LIMIT_BYTES - 1024;

export type DoctorProbeKind = "native" | "projection";

export interface DoctorProbeReceipt {
	readonly schemaVersion: 1;
	readonly kind: DoctorProbeKind;
	readonly status: "completed" | "failed";
	readonly reasonCode: string;
	readonly checks: readonly DoctorCheck[];
}
