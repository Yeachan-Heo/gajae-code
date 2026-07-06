import * as z from "zod/v4";
import { WORKFLOW_ESCALATION_ROUTES, WORKFLOW_INTENT_ROUTES, type WorkflowIntentDiff } from "./workflow-intent-diff";

const WORKFLOW_CLAIM_IDS = ["workflow-route", "root-cause-phase", "escalation-gate"] as const;
const WORKFLOW_OBSERVERS = ["intent-router", "root-cause-schema", "escalation-gate"] as const;

const WorkflowIntentRouteSchema = z.enum(WORKFLOW_INTENT_ROUTES);
const WorkflowEscalationRouteSchema = z.enum(WORKFLOW_ESCALATION_ROUTES);
const WorkflowRootCausePhaseSchema = z.object({
	status: z.enum(["active", "inactive"]),
	triggers: z.array(z.string()),
});
const WorkflowClaimsLedgerSchema = z.object({
	version: z.literal(1),
	claims: z.array(
		z.object({
			id: z.enum(WORKFLOW_CLAIM_IDS),
			statement: z.string(),
			status: z.literal("confirmed"),
			confidence: z.literal("high"),
			evidence: z.array(z.string()),
		}),
	),
});
const WorkflowConsensusReportSchema = z.object({
	version: z.literal(1),
	route: WorkflowIntentRouteSchema,
	confidence: z.literal("high"),
	summary: z.string(),
	observerSignals: z.array(
		z.object({
			observer: z.enum(WORKFLOW_OBSERVERS),
			conclusion: z.string(),
			evidence: z.array(z.string()),
		}),
	),
	escalationGate: z.object({
		status: z.enum(["required", "not-required"]),
		reason: z.string(),
	}),
});

const WorkflowIntentDiffSchema = z
	.object({
		version: z.literal(1),
		route: WorkflowIntentRouteSchema,
		reason: z.string(),
		directTracking: z.enum(["custom-entry-only", "not-direct"]),
		recommendedSkill: WorkflowEscalationRouteSchema.optional(),
		recommendedInvocation: z.string().optional(),
		triggers: z.array(z.string()),
		rootCausePhase: WorkflowRootCausePhaseSchema,
		claimsLedger: WorkflowClaimsLedgerSchema,
		consensusReport: WorkflowConsensusReportSchema,
		promptPreview: z.string(),
	})
	.superRefine((intent, ctx) => {
		const direct = intent.route === "direct";
		const expectedTracking = direct ? "custom-entry-only" : "not-direct";
		const expectedGateStatus = direct ? "not-required" : "required";

		if (intent.directTracking !== expectedTracking) {
			ctx.addIssue({
				code: "custom",
				path: ["directTracking"],
				message: `directTracking must be ${expectedTracking} for route ${intent.route}`,
			});
		}
		if (intent.consensusReport.route !== intent.route) {
			ctx.addIssue({
				code: "custom",
				path: ["consensusReport", "route"],
				message: "consensus route must match the top-level workflow route",
			});
		}
		if (intent.consensusReport.escalationGate.status !== expectedGateStatus) {
			ctx.addIssue({
				code: "custom",
				path: ["consensusReport", "escalationGate", "status"],
				message: `escalation gate must be ${expectedGateStatus} for route ${intent.route}`,
			});
		}
		if (direct) {
			if (intent.recommendedSkill !== undefined || intent.recommendedInvocation !== undefined) {
				ctx.addIssue({
					code: "custom",
					path: ["recommendedSkill"],
					message: "direct workflow reports must not carry escalation recommendations",
				});
			}
		} else {
			if (intent.recommendedSkill !== intent.route || intent.recommendedInvocation === undefined) {
				ctx.addIssue({
					code: "custom",
					path: ["recommendedSkill"],
					message: "escalated workflow reports must carry matching recommendations",
				});
			}
		}

		for (const signal of intent.consensusReport.observerSignals) {
			if (signal.observer === "intent-router" && signal.conclusion !== intent.route) {
				ctx.addIssue({
					code: "custom",
					path: ["consensusReport", "observerSignals"],
					message: "intent-router signal must match the top-level workflow route",
				});
			}
			if (signal.observer === "root-cause-schema" && signal.conclusion !== intent.rootCausePhase.status) {
				ctx.addIssue({
					code: "custom",
					path: ["consensusReport", "observerSignals"],
					message: "root-cause-schema signal must match the root-cause phase status",
				});
			}
			if (signal.observer === "escalation-gate" && signal.conclusion !== expectedGateStatus) {
				ctx.addIssue({
					code: "custom",
					path: ["consensusReport", "observerSignals"],
					message: "escalation-gate signal must match the escalation gate status",
				});
			}
		}
	});

export function parseWorkflowIntentDiffPayload(value: unknown): WorkflowIntentDiff | undefined {
	const result = WorkflowIntentDiffSchema.safeParse(value);
	return result.success ? result.data : undefined;
}
