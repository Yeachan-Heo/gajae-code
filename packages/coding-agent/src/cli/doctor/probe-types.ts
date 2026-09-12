import type { DoctorCheck } from "./types";

export type DoctorProbeKind = "native" | "projection";

export interface DoctorProbeReceipt {
	readonly schemaVersion: 1;
	readonly kind: DoctorProbeKind;
	readonly status: "completed" | "failed";
	readonly reasonCode: string;
	readonly checks: readonly DoctorCheck[];
}
