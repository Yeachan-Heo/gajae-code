import { describe, expect, it } from "bun:test";
import type { CustomEntry, SessionEntry } from "@gajae-code/coding-agent/session/session-manager";
import {
	buildWorkflowIntentDiff,
	WORKFLOW_INTENT_DIFF_CUSTOM_TYPE,
	type WorkflowIntentDiff,
} from "@gajae-code/coding-agent/workflow/workflow-intent-diff";
import {
	collectWorkflowIntentReports,
	summarizeWorkflowConsensus,
} from "@gajae-code/coding-agent/workflow/workflow-intent-report-consumer";

function mustBuildIntent(prompt: string): WorkflowIntentDiff {
	const intent = buildWorkflowIntentDiff(prompt);
	if (!intent) throw new Error(`Expected workflow intent for prompt: ${prompt}`);
	return intent;
}

function customEntry(id: string, data: unknown, customType = WORKFLOW_INTENT_DIFF_CUSTOM_TYPE): CustomEntry<unknown> {
	return {
		type: "custom",
		id,
		parentId: null,
		timestamp: `2026-07-06T00:00:0${id.length}.000Z`,
		customType,
		data,
	};
}

function workflowEntry(id: string, prompt: string): CustomEntry<unknown> {
	return customEntry(id, mustBuildIntent(prompt));
}

describe("workflow intent report consumer", () => {
	it("collects workflow intent CustomEntries and summarizes consensus signals", () => {
		const directIntent = mustBuildIntent("fix the typo in the workflow settings page");
		const directIntentWithExtras = {
			...directIntent,
			ignoredExtra: true,
			consensusReport: {
				...directIntent.consensusReport,
				ignoredNestedExtra: true,
			},
		};
		const entries: readonly SessionEntry[] = [
			customEntry("direct-1", directIntentWithExtras),
			customEntry("ignored-custom", { route: "ralplan" }, "other-extension"),
			workflowEntry("ralplan-1", "plan the architecture sequence before implementation"),
			workflowEntry("ralplan-2", "plan the auth migration sequence and regression risk"),
		];

		const collection = collectWorkflowIntentReports(entries);
		expect(collection.entries.map(entry => entry.entryId)).toEqual(["direct-1", "ralplan-1", "ralplan-2"]);
		expect(collection.latest?.entryId).toBe("ralplan-2");
		const [firstEntry] = collection.entries;
		if (!firstEntry) throw new Error("Expected a sanitized first workflow intent report");
		expect("ignoredExtra" in firstEntry.intent).toBe(false);
		expect("ignoredNestedExtra" in firstEntry.intent.consensusReport).toBe(false);
		expect(collection.totals).toEqual({
			total: 3,
			byRoute: {
				direct: 1,
				"deep-interview": 0,
				ralplan: 2,
				ultragoal: 0,
				team: 0,
			},
			escalationRequired: 2,
			rootCauseActive: 1,
		});

		const summary = summarizeWorkflowConsensus(collection.entries.map(entry => entry.intent));
		expect(summary).toEqual({
			total: 3,
			dominantRoute: "ralplan",
			confidence: "medium",
			escalationGate: {
				required: true,
				count: 2,
				latestReason: "/skill:ralplan --deliberate",
			},
			rootCausePhase: {
				active: true,
				count: 1,
				triggers: ["regression", "high-risk transition"],
			},
			observerSignals: expect.arrayContaining([
				{ observer: "intent-router", conclusion: "ralplan", count: 2 },
				{ observer: "escalation-gate", conclusion: "required", count: 2 },
				{ observer: "root-cause-schema", conclusion: "active", count: 1 },
			]),
		});
	});

	it("ignores non-workflow and malformed entries without throwing", () => {
		const directIntent = mustBuildIntent("fix a direct typo");
		const contradictoryIntent = {
			...directIntent,
			consensusReport: {
				...directIntent.consensusReport,
				route: "team",
				escalationGate: { status: "required", reason: "/skill:team" },
				observerSignals: directIntent.consensusReport.observerSignals.map(signal => {
					if (signal.observer === "intent-router") return { ...signal, conclusion: "team" };
					if (signal.observer === "escalation-gate") return { ...signal, conclusion: "required" };
					return signal;
				}),
			},
		};
		const nonCustom: SessionEntry = {
			type: "label",
			id: "label-1",
			parentId: null,
			timestamp: "2026-07-06T00:01:00.000Z",
			targetId: "direct-1",
			label: "reviewed",
		};
		const entries: readonly SessionEntry[] = [
			nonCustom,
			customEntry("wrong-custom-type", directIntent, "other-extension"),
			customEntry("missing-report-shape", { version: 1, route: "direct" }),
			customEntry("contradictory-report", contradictoryIntent),
			customEntry("wrong-route", {
				version: 1,
				route: "unknown",
				rootCausePhase: { status: "inactive", triggers: [] },
				claimsLedger: { version: 1, claims: [] },
				consensusReport: {
					version: 1,
					observerSignals: [],
					escalationGate: { status: "not-required", reason: "invalid" },
				},
			}),
		];

		const collection = collectWorkflowIntentReports(entries);
		expect(collection).toEqual({
			entries: [],
			latest: undefined,
			totals: {
				total: 0,
				byRoute: {
					direct: 0,
					"deep-interview": 0,
					ralplan: 0,
					ultragoal: 0,
					team: 0,
				},
				escalationRequired: 0,
				rootCauseActive: 0,
			},
		});
		expect(summarizeWorkflowConsensus([])).toEqual({
			total: 0,
			dominantRoute: undefined,
			confidence: "none",
			escalationGate: {
				required: false,
				count: 0,
				latestReason: undefined,
			},
			rootCausePhase: {
				active: false,
				count: 0,
				triggers: [],
			},
			observerSignals: [],
		});
	});
});
