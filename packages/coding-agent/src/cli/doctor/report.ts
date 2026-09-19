import type { DoctorCheck, DoctorMode, DoctorRepair, DoctorReport, DoctorSummary, JsonValue, Verdict } from "./types";

export const DOCTOR_EXIT_CODES = {
	ok: 0,
	findings: 1,
	usage: 2,
	incomplete: 3,
	mutationFailure: 4,
	interrupted: 130,
} as const;
export interface FinalizeInput {
	readonly schemaVersion?: 1;
	readonly runId: string;
	readonly mode: DoctorMode;
	readonly generatedAt: string;
	readonly durationMs: number;
	readonly subject: DoctorReport["subject"];
	readonly selection: DoctorReport["selection"];
	readonly coverage: DoctorReport["coverage"];
	readonly checks: readonly DoctorCheck[];
	readonly repairs?: readonly DoctorRepair[];
	readonly limits?: DoctorReport["limits"];
	readonly invocationError?: string;
	readonly interrupted?: boolean;
}
function sanitize(value: unknown, depth = 0): unknown {
	if (depth > 4) return "[bounded]";
	if (typeof value === "string") return value.replace(/[\u0000-\u001f\u007f]/g, "?").slice(0, 512);
	if (typeof value === "number" || typeof value === "boolean" || value === null) return value;
	if (Array.isArray(value)) return value.slice(0, 100).map(item => sanitize(item, depth + 1));
	if (typeof value === "object" && value !== null) {
		const out: Record<string, unknown> = {};
		for (const [k, v] of Object.entries(value).slice(0, 100)) {
			out[k] = sanitize(v, depth + 1);
		}
		return out;
	}
	return "[omitted]";
}
const EVIDENCE_KEYS = new Set([
	"runtimeVersion",
	"platform",
	"arch",
	"channel",
	"schemaCoverage",
	"startupStatus",
	"runtimeProbed",
	"aclCoverage",
	"mode",
	"ownerMatches",
	"contentsRead",
	"authenticationProbed",
	"present",
	"errno",
	"schemaLocation",
	"enabled",
	"counts",
	"fileKind",
	"version",
	"integrityResult",
	"processObservation",
	"generation",
	"occupancy",
	"readiness",
	"rootId",
	"safeLabel",
	"candidateCount",
	"autoload",
	"hasAuth",
	"status",
	"sourceClass",
	"artifactStatus",
	"transport",
	"count",
	"warningCount",
]);
function sanitizeEvidence(value: DoctorCheck["evidence"]): DoctorCheck["evidence"] {
	const filtered: Record<string, JsonValue> = {};
	for (const [key, raw] of Object.entries(value))
		if (EVIDENCE_KEYS.has(key)) filtered[key] = sanitize(raw) as JsonValue;
	return filtered;
}
export function finalizeReport(input: FinalizeInput): DoctorReport {
	const checks = input.checks.map(check => ({ ...check, evidence: sanitizeEvidence(check.evidence) }));
	const repairs = (input.repairs ?? []).map(repair => ({
		...repair,
		candidates: repair.candidates.map(candidate => ({
			...candidate,
			evidence: sanitizeEvidence(candidate.evidence),
		})),
	}));
	const presentCheckIds = new Set(checks.map(check => check.id));
	const historicalCheckIds = new Set(
		repairs
			.filter(repair => repair.afterCheckIds.length > 0 && repair.afterCheckIds.every(id => presentCheckIds.has(id)))
			.flatMap(repair => repair.beforeCheckIds),
	);
	const currentChecks = checks.filter(check => !historicalCheckIds.has(check.id));
	let verdict: Verdict = "healthy";
	if (input.interrupted) verdict = "inconclusive";
	else if (
		currentChecks.some(
			check =>
				check.execution === "timeout" ||
				check.execution === "blocked" ||
				check.execution === "unsupported" ||
				check.health === "unknown",
		)
	)
		verdict = "inconclusive";
	else if (currentChecks.some(check => check.health === "error")) verdict = "unhealthy";
	else if (currentChecks.some(check => check.health === "warning")) verdict = "degraded";
	const mutationFailure =
		input.mode === "fix" &&
		repairs.some(repair => {
			if (repair.state === "verified" || repair.state === "not_needed") return false;
			if (repair.sideEffectStarted === true) return true;
			// Physical states establish effects even when an adapter incorrectly supplies a negative flag.
			return ["pending_activation", "uncertain", "rolled_back", "rollback_conflict"].includes(repair.state);
		});
	if (mutationFailure) verdict = "inconclusive";
	const incomplete = input.coverage.timedOut > 0 || input.coverage.blocked > 0 || input.coverage.unsupported > 0;
	const readinessBlocked =
		input.mode === "fix" && repairs.some(repair => repair.state !== "verified" && repair.state !== "not_needed");
	const exitCode = input.interrupted
		? DOCTOR_EXIT_CODES.interrupted
		: input.invocationError
			? DOCTOR_EXIT_CODES.usage
			: mutationFailure
				? DOCTOR_EXIT_CODES.mutationFailure
				: incomplete || verdict === "inconclusive" || readinessBlocked
					? DOCTOR_EXIT_CODES.incomplete
					: verdict === "unhealthy"
						? DOCTOR_EXIT_CODES.findings
						: DOCTOR_EXIT_CODES.ok;
	const summary: DoctorSummary = { verdict, exitCode };
	return {
		schemaVersion: 1,
		command: "doctor",
		runId: input.runId,
		mode: input.mode,
		generatedAt: input.generatedAt,
		durationMs: input.durationMs,
		subject: input.subject,
		selection: input.selection,
		coverage: input.coverage,
		summary,
		checks,
		repairs,
		limits: input.limits ?? ({} as DoctorReport["limits"]),
		invocationError: input.invocationError,
	};
}
export function renderDoctorJson(report: DoctorReport): string {
	return `${JSON.stringify(report)}\n`;
}
export function renderDoctorText(report: DoctorReport): string {
	const lines = [
		`gjc doctor (${report.mode})`,
		`verdict: ${report.summary.verdict}`,
		`exit: ${report.summary.exitCode}`,
		`checks: ${report.checks.length}`,
		`repairs: ${report.repairs.length}`,
	];
	for (const check of report.checks) {
		lines.push(`- ${check.id}: ${check.health} (${check.execution})`);
		lines.push(`  target: ${check.targetId}`);
		if (check.reasonCode) lines.push(`  reason: ${check.reasonCode}`);
	}
	for (const repair of report.repairs) {
		lines.push(`- repair ${repair.id}: ${repair.state}`);
		lines.push(`  target: ${repair.targetId}`);
		if (repair.readiness.length) lines.push(`  readiness: ${repair.readiness.join(", ")}`);
	}
	return `${lines.join("\n")}\n`;
}
