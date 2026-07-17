import type { RootCausePhaseStatus, WorkflowIntentRoute } from "./workflow-intent-diff";

export type WorkflowConfidence = "high";
export type WorkflowClaimStatus = "confirmed";
export type WorkflowEscalationGateStatus = "required" | "not-required";
export type WorkflowSignalObserver = "intent-router" | "root-cause-schema" | "escalation-gate";

export interface WorkflowClaim {
	readonly id: "workflow-route" | "root-cause-phase" | "escalation-gate";
	readonly statement: string;
	readonly status: WorkflowClaimStatus;
	readonly confidence: WorkflowConfidence;
	readonly evidence: readonly string[];
}

export interface WorkflowClaimsLedger {
	readonly version: 1;
	readonly claims: readonly WorkflowClaim[];
}

export interface WorkflowObserverSignal {
	readonly observer: WorkflowSignalObserver;
	readonly conclusion: string;
	readonly evidence: readonly string[];
}

export interface WorkflowConsensusReport {
	readonly version: 1;
	readonly route: WorkflowIntentRoute;
	readonly confidence: WorkflowConfidence;
	readonly summary: string;
	readonly observerSignals: readonly WorkflowObserverSignal[];
	readonly escalationGate: {
		readonly status: WorkflowEscalationGateStatus;
		readonly reason: string;
	};
}

export interface WorkflowIntentReport {
	readonly claimsLedger: WorkflowClaimsLedger;
	readonly consensusReport: WorkflowConsensusReport;
}

export interface WorkflowIntentReportInput {
	readonly route: WorkflowIntentRoute;
	readonly reason: string;
	readonly direct: boolean;
	readonly recommendedInvocation?: string;
	readonly triggers: readonly string[];
	readonly rootCausePhase: {
		readonly status: RootCausePhaseStatus;
		readonly triggers: readonly string[];
	};
}

function triggerEvidence(triggers: readonly string[]): readonly string[] {
	return triggers.map(trigger => `trigger: ${trigger}`);
}

function rootCauseEvidence(input: WorkflowIntentReportInput): readonly string[] {
	if (input.rootCausePhase.status === "inactive") return ["root-cause: inactive"];
	return ["root-cause: active", ...input.rootCausePhase.triggers.map(trigger => `root-cause-trigger: ${trigger}`)];
}

function escalationEvidence(input: WorkflowIntentReportInput): readonly string[] {
	if (input.direct) return ["escalation: not-required", `reason: ${input.reason}`];
	return ["escalation: required", `invocation: ${input.recommendedInvocation ?? input.route}`];
}

function escalationGate(input: WorkflowIntentReportInput): WorkflowConsensusReport["escalationGate"] {
	if (input.direct) {
		return {
			status: "not-required",
			reason: input.reason,
		};
	}
	return {
		status: "required",
		reason: input.recommendedInvocation ?? input.route,
	};
}

function consensusSummary(input: WorkflowIntentReportInput): string {
	if (input.direct) return "Consensus: direct implementation with CustomEntry-only workflow traceability.";
	return `Consensus: route through ${input.recommendedInvocation ?? input.route} because ${input.reason}.`;
}

export function buildWorkflowIntentReport(input: WorkflowIntentReportInput): WorkflowIntentReport {
	const confidence: WorkflowConfidence = "high";
	const gate = escalationGate(input);
	const routeEvidence = [`route: ${input.route}`, `reason: ${input.reason}`, ...triggerEvidence(input.triggers)];
	const causeEvidence = rootCauseEvidence(input);
	const gateEvidence = escalationEvidence(input);

	return {
		claimsLedger: {
			version: 1,
			claims: [
				{
					id: "workflow-route",
					statement: `Prompt should follow the ${input.route} workflow route.`,
					status: "confirmed",
					confidence,
					evidence: routeEvidence,
				},
				{
					id: "root-cause-phase",
					statement: `Root-cause phase is ${input.rootCausePhase.status}.`,
					status: "confirmed",
					confidence,
					evidence: causeEvidence,
				},
				{
					id: "escalation-gate",
					statement: `Escalation gate is ${gate.status}.`,
					status: "confirmed",
					confidence,
					evidence: gateEvidence,
				},
			],
		},
		consensusReport: {
			version: 1,
			route: input.route,
			confidence,
			summary: consensusSummary(input),
			observerSignals: [
				{ observer: "intent-router", conclusion: input.route, evidence: routeEvidence },
				{ observer: "root-cause-schema", conclusion: input.rootCausePhase.status, evidence: causeEvidence },
				{ observer: "escalation-gate", conclusion: gate.status, evidence: gateEvidence },
			],
			escalationGate: gate,
		},
	};
}
