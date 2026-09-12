export type DoctorMode = "diagnose" | "dry-run" | "fix";
/**
 * `unsupported` and `not_selected` are the coverage vocabulary this process
 * accepts across the worker/probe boundary and reports in `DoctorCoverage`; the
 * collectors on this platform never emit them, so their consumers are deliberate
 * validation rather than reachable branches.
 */
export type CheckExecution = "completed" | "blocked" | "timeout" | "cancelled" | "unsupported" | "not_selected";
export type Health = "ok" | "warning" | "error" | "unknown" | "not_applicable";
export type EvidenceLevel = "observed" | "not_probed";
export type Verdict = "healthy" | "degraded" | "unhealthy" | "inconclusive";
export type RepairState =
	| "planned"
	| "blocked"
	| "not_needed"
	// Transient base value only: every construction site overrides it before the
	// repair is returned, so it never reaches a report.
	| "preparing"
	| "pending_activation"
	| "verified"
	| "failed"
	| "uncertain"
	| "rolled_back"
	| "rollback_conflict";
export type ReadinessFactCode =
	| "authorization_missing"
	| "confirmation_required"
	| "candidate_unresolved"
	| "pin_missing"
	| "candidate_selection_missing"
	| "identity_recheck_required"
	| "target_resolution_incomplete"
	| "unsupported";
export type DoctorScope = "user" | "project";

export type DoctorRiskClass =
	| "config-change"
	| "permission-change"
	| "install-replace"
	| "plugin-change"
	| "service-interruption"
	| "artifact-detach"
	| "network"
	| "external-execution";
export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { readonly [key: string]: JsonValue };

export interface CheckEvidence {
	readonly runtimeVersion?: string;
	readonly platform?: string;
	readonly arch?: string;
	readonly channel?: string;
	readonly schemaCoverage?: "selected_fields" | "complete";
	readonly startupStatus?: "autoload" | "autoload-off" | "disabled";
	readonly runtimeProbed?: boolean;
	readonly aclCoverage?: "not_probed" | "verified";
	readonly mode?: number;
	readonly ownerMatches?: boolean;
	readonly contentsRead?: boolean;
	readonly authenticationProbed?: boolean;
	readonly present?: boolean;
	readonly enabled?: boolean;
	readonly autoload?: boolean;
	readonly hasAuth?: boolean;
	readonly status?: string;
	readonly sourceClass?: string;
	/** Closed observation of a known plugin artifact; never a path or content. */
	readonly artifactStatus?: "present" | "absent" | "unreadable";
	readonly transport?: "stdio" | "http" | "sse" | "unknown";
	readonly count?: number;
	readonly warningCount?: number;
	readonly counts?: Readonly<Record<string, number>>;
	readonly errno?: string;
	readonly fileKind?: string;
	readonly schemaLocation?: string;
	readonly version?: string;
	readonly integrityResult?: string;
	readonly processObservation?: JsonValue;
	readonly generation?: string;
	readonly occupancy?: string;
	readonly readiness?: readonly ReadinessFactCode[];
	readonly rootId?: string;
	readonly safeLabel?: string;
	readonly candidateCount?: number;
}
export interface DoctorCheck {
	readonly id: string;
	readonly targetId: string;
	readonly scope?: DoctorScope;
	readonly execution: CheckExecution;
	readonly health: Health;
	readonly reasonCode?: string;
	readonly evidenceLevel: EvidenceLevel;
	readonly observedAt?: string;
	readonly durationMs?: number;
	readonly dependsOn: readonly string[];
	readonly evidence: CheckEvidence;
	readonly remediationIds: readonly string[];
}
export interface RepairCandidate {
	readonly id: string;
	readonly sourceChannel: string;
	readonly ref?: string;
	readonly sha256?: string;
	readonly evidence: CheckEvidence;
}
export interface DoctorRepair {
	readonly id: string;
	readonly targetId: string;
	readonly riskClasses: readonly DoctorRiskClass[];
	readonly authorization: readonly string[];
	readonly readiness: readonly ReadinessFactCode[];
	readonly sourceChannel?: string;
	readonly candidates: readonly RepairCandidate[];
	readonly selectedCandidate?: string;
	readonly preconditions: readonly string[];
	readonly rollbackClass?: string;
	readonly state: RepairState;
	readonly reasonCode?: string;
	readonly sideEffectStarted?: boolean;
	readonly outcome?: { readonly mutationVerified: boolean; readonly desiredStartupStateAchieved?: boolean };
	readonly beforeCheckIds: readonly string[];
	readonly afterCheckIds: readonly string[];
	readonly restartRequired: boolean;
	readonly restartScope?: "none" | "new-session" | "service";
	readonly nonrollbackableEffects: readonly string[];
	readonly activationRecordRef?: string;
}
export interface DoctorCoverage {
	readonly requested: number;
	readonly expanded: number;
	readonly attempted: number;
	readonly completed: number;
	readonly blocked: number;
	readonly timedOut: number;
	readonly unsupported: number;
}
export interface DoctorSummary {
	readonly verdict: Verdict;
	readonly exitCode: number;
}
export interface DoctorReport {
	readonly schemaVersion: 1;
	readonly command: "doctor";
	readonly runId: string;
	readonly mode: DoctorMode;
	readonly generatedAt: string;
	readonly durationMs: number;
	readonly subject: {
		readonly gjcVersion: string;
		readonly platform: string;
		readonly arch: string;
		readonly channel: string;
		readonly scope?: DoctorScope;
		readonly rootIds: readonly string[];
	};
	readonly selection: { readonly checks: readonly string[]; readonly repair?: string; readonly targetId?: string };
	readonly coverage: DoctorCoverage;
	readonly summary: DoctorSummary;
	readonly checks: readonly DoctorCheck[];
	readonly repairs: readonly DoctorRepair[];
	readonly limits: { readonly [key: string]: JsonValue };
	readonly invocationError?: string;
}
