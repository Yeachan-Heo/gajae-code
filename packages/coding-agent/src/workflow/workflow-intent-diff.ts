import {
	buildWorkflowIntentReport,
	type WorkflowClaimsLedger,
	type WorkflowConsensusReport,
} from "./workflow-intent-report";

export const WORKFLOW_INTENT_DIFF_CUSTOM_TYPE = "workflow-intent-diff";

export type WorkflowIntentRoute = "direct" | "deep-interview" | "ralplan" | "ultragoal" | "team";
export type DirectTrackingMode = "custom-entry-only" | "not-direct";
export type RootCausePhaseStatus = "active" | "inactive";

export interface WorkflowIntentDiff {
	readonly version: 1;
	readonly route: WorkflowIntentRoute;
	readonly reason: string;
	readonly directTracking: DirectTrackingMode;
	readonly recommendedSkill?: Exclude<WorkflowIntentRoute, "direct">;
	readonly recommendedInvocation?: string;
	readonly triggers: readonly string[];
	readonly rootCausePhase: {
		readonly status: RootCausePhaseStatus;
		readonly triggers: readonly string[];
	};
	readonly claimsLedger: WorkflowClaimsLedger;
	readonly consensusReport: WorkflowConsensusReport;
	readonly promptPreview: string;
}

interface RouteMatch {
	readonly route: WorkflowIntentRoute;
	readonly reason: string;
	readonly recommendedInvocation?: string;
	readonly triggers: readonly string[];
}

const PROMPT_PREVIEW_LIMIT = 240;

const DURABLE_TRACKING_PATTERNS = [
	/\bultragoal\b/i,
	/\bdurable (?:goal|tracking|ledger|plan)\b/i,
	/\b(?:goal|tracking|plan) ledger\b/i,
	/\bcheckpoint(?:ed|ing)? (?:goal|plan|workflow|release|work)\b/i,
	/\bcheckpoint (?:this|the) (?:goal|plan|workflow|release|work)\b/i,
] as const;

const AMBIGUOUS_REQUIREMENT_PATTERNS = [
	/\bambiguous (?:requirement|requirements|request|requests|scope)\b/i,
	/\bdeep[- ]interview\b/i,
	/\binterview me\b/i,
	/\bdon't assume\b/i,
	/\bnot sure\b/i,
	/\bunclear\b/i,
	/\bvague\b/i,
] as const;

const ARCHITECTURE_SEQUENCE_PATTERNS = [
	/\barchitecture\b/i,
	/\barchitectural\b/i,
	/\bsequence\b/i,
	/\bmigrate\b/i,
	/\bmigration\b/i,
	/\bauth(?:entication|orization)? (?:migration|sequence|rollout|release|refactor|rewrite|transition)\b/i,
	/\bsecurity\b/i,
	/\bcompliance\b/i,
	/\bPII\b/i,
	/\bproduction (?:release|rollout|deployment|migration|incident|data|change|cutover)\b/i,
	/\bdeploy(?:ing)? to production\b/i,
	/\bbreaking change\b/i,
	/\bdata loss\b/i,
	/\bdestructive\b/i,
] as const;

const TEAM_PATTERNS = [
	/\buse (?:a )?team\b/i,
	/\bcoordinated (?:persistent )?workers\b/i,
	/\bpersistent workers\b/i,
	/\bworker coordination\b/i,
] as const;

const ROOT_CAUSE_TRIGGERS = [
	{ name: "contradiction", pattern: /\bcontradict(?:ion|s|ory)?\b/i },
	{ name: "regression", pattern: /\bregression\b/i },
	{
		name: "high-risk transition",
		pattern:
			/\b(?:migrate|migration|auth(?:entication|orization)? (?:migration|sequence|rollout|release|refactor|rewrite|transition)|security|breaking change|data loss|destructive|production (?:release|rollout|deployment|migration|incident|data|change|cutover)|deploy(?:ing)? to production|compliance|PII)\b/i,
	},
] as const;

function matchesAny(text: string, patterns: readonly RegExp[]): boolean {
	return patterns.some(pattern => pattern.test(text));
}

function withGlobal(pattern: RegExp): RegExp {
	const flags = pattern.flags.includes("g") ? pattern.flags : `${pattern.flags}g`;
	return new RegExp(pattern.source, flags);
}

function isNegatedAt(text: string, index: number): boolean {
	const prefix = text.slice(Math.max(0, index - 48), index).toLowerCase();
	const boundary = Math.max(
		prefix.lastIndexOf("."),
		prefix.lastIndexOf(","),
		prefix.lastIndexOf(";"),
		prefix.lastIndexOf(":"),
		prefix.lastIndexOf("?"),
		prefix.lastIndexOf("!"),
		prefix.lastIndexOf("\n"),
		prefix.lastIndexOf(" but "),
		prefix.lastIndexOf(" however "),
		prefix.lastIndexOf(" yet "),
		prefix.lastIndexOf(" then "),
	);
	const localPrefix = boundary >= 0 ? prefix.slice(boundary + 1) : prefix;
	return /(?:^|[\s([{])(?:no|not|without|excluding|exclude|absent|absence of|avoid)\b[^.,!?;:\n]{0,48}$/.test(
		localPrefix,
	);
}

function matchesAnyNonNegated(text: string, patterns: readonly RegExp[]): boolean {
	return patterns.some(pattern => {
		for (const match of text.matchAll(withGlobal(pattern))) {
			if (!isNegatedAt(text, match.index ?? 0)) return true;
		}
		return false;
	});
}

function collectRootCauseTriggers(text: string): readonly string[] {
	return ROOT_CAUSE_TRIGGERS.filter(trigger => matchesAnyNonNegated(text, [trigger.pattern])).map(
		trigger => trigger.name,
	);
}

function buildPromptPreview(text: string): string {
	const compact = text.replace(/\s+/g, " ").trim();
	return compact.length > PROMPT_PREVIEW_LIMIT ? `${compact.slice(0, PROMPT_PREVIEW_LIMIT - 3)}...` : compact;
}

function classifyRoute(text: string): RouteMatch {
	if (matchesAny(text, AMBIGUOUS_REQUIREMENT_PATTERNS)) {
		return {
			route: "deep-interview",
			reason: "ambiguous requirements need clarification",
			recommendedInvocation: "/skill:deep-interview",
			triggers: ["ambiguous requirements"],
		};
	}

	if (matchesAny(text, DURABLE_TRACKING_PATTERNS)) {
		return {
			route: "ultragoal",
			reason: "durable tracking requested",
			recommendedInvocation: "/skill:ultragoal",
			triggers: ["durable tracking"],
		};
	}

	if (matchesAnyNonNegated(text, ARCHITECTURE_SEQUENCE_PATTERNS)) {
		return {
			route: "ralplan",
			reason: "architecture or sequence risk requires deliberate planning",
			recommendedInvocation: "/skill:ralplan --deliberate",
			triggers: ["architecture/sequence risk"],
		};
	}

	if (matchesAny(text, TEAM_PATTERNS)) {
		return {
			route: "team",
			reason: "coordinated persistent workers requested",
			recommendedInvocation: "/skill:team",
			triggers: ["coordinated workers"],
		};
	}

	return {
		route: "direct",
		reason: "clear low-risk prompt stays on direct implementation path",
		triggers: ["low-risk direct"],
	};
}

export function buildWorkflowIntentDiff(text: string): WorkflowIntentDiff | null {
	const promptPreview = buildPromptPreview(text);
	if (!promptPreview) return null;

	const route = classifyRoute(text);
	const rootCauseTriggers = collectRootCauseTriggers(text);
	const rootCauseActive = rootCauseTriggers.length > 0;
	const direct = route.route === "direct";
	const rootCauseStatus: RootCausePhaseStatus = rootCauseActive ? "active" : "inactive";
	const rootCausePhase = {
		status: rootCauseStatus,
		triggers: rootCauseTriggers,
	};
	const report = buildWorkflowIntentReport({
		route: route.route,
		reason: route.reason,
		direct,
		recommendedInvocation: route.recommendedInvocation,
		triggers: route.triggers,
		rootCausePhase,
	});

	return {
		version: 1,
		route: route.route,
		reason: route.reason,
		directTracking: direct ? "custom-entry-only" : "not-direct",
		...(direct ? {} : { recommendedSkill: route.route, recommendedInvocation: route.recommendedInvocation }),
		triggers: route.triggers,
		rootCausePhase,
		claimsLedger: report.claimsLedger,
		consensusReport: report.consensusReport,
		promptPreview,
	};
}
