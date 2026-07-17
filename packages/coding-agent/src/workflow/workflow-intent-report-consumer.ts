import type { SessionEntry } from "../session/session-manager";
import {
	WORKFLOW_INTENT_DIFF_CUSTOM_TYPE,
	WORKFLOW_INTENT_ROUTES,
	type WorkflowIntentDiff,
	type WorkflowIntentRoute,
} from "./workflow-intent-diff";
import type { WorkflowSignalObserver } from "./workflow-intent-report";
import { parseWorkflowIntentDiffPayload } from "./workflow-intent-report-schema";

export type WorkflowConsumerConfidence = "none" | "low" | "medium" | "high";

export interface WorkflowRouteCounts {
	readonly direct: number;
	readonly "deep-interview": number;
	readonly ralplan: number;
	readonly ultragoal: number;
	readonly team: number;
}

export interface WorkflowIntentReportEntry {
	readonly entryId: string;
	readonly timestamp: string;
	readonly intent: WorkflowIntentDiff;
}

export interface WorkflowIntentReportTotals {
	readonly total: number;
	readonly byRoute: WorkflowRouteCounts;
	readonly escalationRequired: number;
	readonly rootCauseActive: number;
}

export interface WorkflowIntentReportCollection {
	readonly entries: readonly WorkflowIntentReportEntry[];
	readonly latest: WorkflowIntentReportEntry | undefined;
	readonly totals: WorkflowIntentReportTotals;
}

export interface WorkflowObserverSignalSummary {
	readonly observer: WorkflowSignalObserver;
	readonly conclusion: string;
	readonly count: number;
}

export interface WorkflowConsensusSummary {
	readonly total: number;
	readonly dominantRoute: WorkflowIntentRoute | undefined;
	readonly confidence: WorkflowConsumerConfidence;
	readonly escalationGate: {
		readonly required: boolean;
		readonly count: number;
		readonly latestReason: string | undefined;
	};
	readonly rootCausePhase: {
		readonly active: boolean;
		readonly count: number;
		readonly triggers: readonly string[];
	};
	readonly observerSignals: readonly WorkflowObserverSignalSummary[];
}

function emptyRouteCounts(): WorkflowRouteCounts {
	return {
		direct: 0,
		"deep-interview": 0,
		ralplan: 0,
		ultragoal: 0,
		team: 0,
	};
}

function parseWorkflowIntentDiffEntry(entry: SessionEntry): WorkflowIntentReportEntry | undefined {
	if (entry.type !== "custom" || entry.customType !== WORKFLOW_INTENT_DIFF_CUSTOM_TYPE) return undefined;
	const intent = parseWorkflowIntentDiffPayload(entry.data);
	if (!intent) return undefined;
	return { entryId: entry.id, timestamp: entry.timestamp, intent };
}

function incrementRoute(counts: WorkflowRouteCounts, route: WorkflowIntentRoute): WorkflowRouteCounts {
	switch (route) {
		case "direct":
			return { ...counts, direct: counts.direct + 1 };
		case "deep-interview":
			return { ...counts, "deep-interview": counts["deep-interview"] + 1 };
		case "ralplan":
			return { ...counts, ralplan: counts.ralplan + 1 };
		case "ultragoal":
			return { ...counts, ultragoal: counts.ultragoal + 1 };
		case "team":
			return { ...counts, team: counts.team + 1 };
	}
}

function routeCount(counts: WorkflowRouteCounts, route: WorkflowIntentRoute): number {
	switch (route) {
		case "direct":
			return counts.direct;
		case "deep-interview":
			return counts["deep-interview"];
		case "ralplan":
			return counts.ralplan;
		case "ultragoal":
			return counts.ultragoal;
		case "team":
			return counts.team;
	}
}

export function collectWorkflowIntentReports(entries: readonly SessionEntry[]): WorkflowIntentReportCollection {
	const reports: WorkflowIntentReportEntry[] = [];
	let byRoute = emptyRouteCounts();
	let escalationRequired = 0;
	let rootCauseActive = 0;

	for (const entry of entries) {
		const report = parseWorkflowIntentDiffEntry(entry);
		if (!report) continue;
		reports.push(report);
		byRoute = incrementRoute(byRoute, report.intent.route);
		if (report.intent.consensusReport.escalationGate.status === "required") escalationRequired += 1;
		if (report.intent.rootCausePhase.status === "active") rootCauseActive += 1;
	}

	return {
		entries: reports,
		latest: reports[reports.length - 1],
		totals: {
			total: reports.length,
			byRoute,
			escalationRequired,
			rootCauseActive,
		},
	};
}

function dominantRouteFor(counts: WorkflowRouteCounts, total: number): WorkflowIntentRoute | undefined {
	if (total === 0) return undefined;
	let dominant: WorkflowIntentRoute | undefined;
	let dominantCount = 0;
	let tied = false;

	for (const route of WORKFLOW_INTENT_ROUTES) {
		const count = routeCount(counts, route);
		if (count > dominantCount) {
			dominant = route;
			dominantCount = count;
			tied = false;
			continue;
		}
		if (count === dominantCount && count > 0) tied = true;
	}

	return tied ? undefined : dominant;
}

function confidenceFor(
	total: number,
	dominantCount: number,
	dominantRoute: WorkflowIntentRoute | undefined,
): WorkflowConsumerConfidence {
	if (total === 0) return "none";
	if (!dominantRoute) return "low";
	const ratio = dominantCount / total;
	if (ratio === 1) return "high";
	if (ratio >= 0.5) return "medium";
	return "low";
}

export function summarizeWorkflowConsensus(intents: readonly WorkflowIntentDiff[]): WorkflowConsensusSummary {
	let byRoute = emptyRouteCounts();
	let escalationCount = 0;
	let latestEscalationReason: string | undefined;
	let activeRootCauseCount = 0;
	const rootCauseTriggers: string[] = [];
	const observerSignalCounts = new Map<string, WorkflowObserverSignalSummary>();

	for (const intent of intents) {
		byRoute = incrementRoute(byRoute, intent.route);
		if (intent.consensusReport.escalationGate.status === "required") {
			escalationCount += 1;
			latestEscalationReason = intent.consensusReport.escalationGate.reason;
		}
		if (intent.rootCausePhase.status === "active") {
			activeRootCauseCount += 1;
			for (const trigger of intent.rootCausePhase.triggers) {
				if (!rootCauseTriggers.includes(trigger)) rootCauseTriggers.push(trigger);
			}
		}
		for (const signal of intent.consensusReport.observerSignals) {
			const key = `${signal.observer}\u0000${signal.conclusion}`;
			const existing = observerSignalCounts.get(key);
			observerSignalCounts.set(key, {
				observer: signal.observer,
				conclusion: signal.conclusion,
				count: existing ? existing.count + 1 : 1,
			});
		}
	}

	const total = intents.length;
	const dominantRoute = dominantRouteFor(byRoute, total);
	const dominantCount = dominantRoute ? routeCount(byRoute, dominantRoute) : 0;

	return {
		total,
		dominantRoute,
		confidence: confidenceFor(total, dominantCount, dominantRoute),
		escalationGate: {
			required: escalationCount > 0,
			count: escalationCount,
			latestReason: latestEscalationReason,
		},
		rootCausePhase: {
			active: activeRootCauseCount > 0,
			count: activeRootCauseCount,
			triggers: rootCauseTriggers,
		},
		observerSignals: Array.from(observerSignalCounts.values()),
	};
}
