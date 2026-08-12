import { describe, expect, it } from "bun:test";
import type { Rule } from "@gajae-code/coding-agent/capability/rule";
import { TtsrManager } from "@gajae-code/coding-agent/export/ttsr";
import { eventAffectsCoordinatorRuntimeState, stateForEvent } from "../src/gjc-runtime/session-state-sidecar";

function makeRule(partial: Partial<Rule>): Rule {
	return {
		name: partial.name ?? "rule",
		path: partial.path ?? "/tmp/rule.md",
		content: partial.content ?? "Do not use forbidden tokens",
		globs: partial.globs,
		alwaysApply: partial.alwaysApply,
		description: partial.description,
		condition: partial.condition,
		scope: partial.scope,
		_source: partial._source ?? {
			provider: "test",
			providerName: "test",
			path: "/tmp/rule.md",
			level: "project",
		},
	};
}

describe("G001 red-team adversarial contracts", () => {
	it("keeps the default TTSR enabled path matching", () => {
		const manager = new TtsrManager();
		const rule = makeRule({ name: "default-enabled", condition: ["forbidden"], scope: ["text"] });

		expect(manager.addRule(rule)).toBe(true);
		expect(manager.hasRules()).toBe(true);
		expect(manager.checkDelta("safe forbidden text", { source: "text" })).toEqual([rule]);
	});

	it("keeps disabled condition plus alwaysApply rules out of TTSR while preserving non-TTSR bucketing", () => {
		const manager = new TtsrManager({ enabled: false });
		const rule = makeRule({ name: "disabled-always", condition: ["forbidden"], alwaysApply: true });

		expect(manager.addRule(rule)).toBe(false);
		expect(manager.hasRules()).toBe(false);
		expect(manager.checkDelta("forbidden", { source: "text" })).toEqual([]);
		expect(rule.alwaysApply).toBe(true);
	});

	it("treats an empty condition array as a non-TTSR rule", () => {
		const manager = new TtsrManager();
		const rule = makeRule({ name: "empty-condition", condition: [] });

		expect(manager.addRule(rule)).toBe(false);
		expect(manager.hasRules()).toBe(false);
		expect(manager.checkDelta("anything", { source: "text" })).toEqual([]);
	});

	it("ignores unknown sidecar event types and records only lifecycle or tool-activity events", () => {
		const events = [
			{ type: "message_update", message: {}, assistantMessageEvent: {} },
			{ type: "notice", level: "info", message: "background" },
			{ type: "turn_start" },
			{ type: "agent_start" },
			{ type: "agent_end", messages: [] },
			{ type: "unknown_future_event", payload: true },
			{ type: "tool_execution_start", toolCallId: "call-1" },
		] as const;

		for (const event of events) {
			const recorded = event.type === "turn_start" || event.type === "agent_start" || event.type === "agent_end";
			// A tool event annotates activity without ever carrying a lifecycle state.
			const activity = event.type === "tool_execution_start";
			expect(eventAffectsCoordinatorRuntimeState(event as never)).toBe(recorded || activity);
			expect(stateForEvent(event as never) !== null).toBe(recorded);
		}
		expect(eventAffectsCoordinatorRuntimeState(events[5] as never)).toBe(false);
		expect(stateForEvent(events[5] as never)).toBeNull();
	});
});
