import { describe, expect, it } from "bun:test";
import type { Rule } from "@gajae-code/coding-agent/capability/rule";
import { type TtsrInjectionRecord, TtsrManager } from "@gajae-code/coding-agent/export/ttsr";

function makeRule(partial: Partial<Rule>): Rule {
	return {
		name: partial.name ?? "rule",
		path: partial.path ?? `/tmp/${partial.name ?? "rule"}.md`,
		content: partial.content ?? "Injected rule content",
		globs: partial.globs,
		alwaysApply: partial.alwaysApply,
		description: partial.description,
		condition: partial.condition,
		scope: partial.scope,
		repeatMode: partial.repeatMode,
		repeatGap: partial.repeatGap,
		_source: partial._source ?? {
			provider: "test",
			providerName: "test",
			path: partial.path ?? `/tmp/${partial.name ?? "rule"}.md`,
			level: "project",
		},
	};
}

const textContext = { source: "text" as const };

function checkNames(manager: TtsrManager, delta: string): string[] {
	return manager.checkDelta(delta, textContext).map(rule => rule.name);
}

function runMessage(manager: TtsrManager, delta = "forbidden"): string[] {
	manager.resetBuffer();
	const matches = manager.checkDelta(delta, textContext);
	if (matches.length > 0) {
		manager.markInjected(matches);
	}
	manager.incrementMessageCount();
	return matches.map(rule => rule.name);
}

describe("G002 red-team bounded matching", () => {
	it("detects a safe regex match spanning a chunk boundary", () => {
		const manager = new TtsrManager();
		const rule = makeRule({ name: "chunk-boundary", condition: ["forbidden"], scope: ["text"] });
		expect(manager.addRule(rule)).toBe(true);

		expect(checkNames(manager, "for")).toEqual([]);
		expect(checkNames(manager, "bidden")).toEqual(["chunk-boundary"]);
	});

	it("detects a safe regex match starting exactly at the retained window edge", () => {
		const manager = new TtsrManager();
		const rule = makeRule({ name: "window-edge", condition: ["EDGE"], scope: ["text"] });
		expect(manager.addRule(rule)).toBe(true);

		// SAFE_REGEX_WINDOW_MULTIPLIER is 4, so the safe window for EDGE is 16 chars.
		// Twelve filler chars plus the four-char pattern puts the match at index 0 of the retained window.
		expect(checkNames(manager, "abcdefghijkl")).toEqual([]);
		expect(checkNames(manager, "EDGE")).toEqual(["window-edge"]);
	});

	it("matches unsafe anchored/lookaround regexes through full-buffer fallback", () => {
		const manager = new TtsrManager();
		const anchored = makeRule({ name: "anchored-full-buffer", condition: ["^hello.*forbidden$"], scope: ["text"] });
		const lookaround = makeRule({
			name: "lookaround-full-buffer",
			condition: ["(?<=hello )forbidden"],
			scope: ["text"],
		});
		expect(manager.addRule(anchored)).toBe(true);
		expect(manager.addRule(lookaround)).toBe(true);

		expect(checkNames(manager, "hello ")).toEqual([]);
		expect(checkNames(manager, "forbidden")).toEqual(["anchored-full-buffer", "lookaround-full-buffer"]);
	});

	it("matches quantified unsafe regexes across deltas beyond the bounded window", () => {
		const manager = new TtsrManager();
		const rule = makeRule({ name: "quantified-full-buffer", condition: ["eval\\(.*\\)"], scope: ["text"] });
		expect(manager.addRule(rule)).toBe(true);

		expect(checkNames(manager, "eval(")).toEqual([]);
		expect(checkNames(manager, "x".repeat(60))).toEqual([]);
		expect(checkNames(manager, ")")).toEqual(["quantified-full-buffer"]);
	});

	it("still matches a literal safe pattern through the bounded boundary window", () => {
		const manager = new TtsrManager();
		const rule = makeRule({ name: "literal-boundary", condition: ["literal-boundary"], scope: ["text"] });
		expect(manager.addRule(rule)).toBe(true);

		expect(checkNames(manager, "literal-")).toEqual([]);
		expect(checkNames(manager, "boundary")).toEqual(["literal-boundary"]);
	});

	it("does not miss a match fed as many one-character deltas", () => {
		const manager = new TtsrManager();
		const rule = makeRule({ name: "small-deltas", condition: ["forbidden"], scope: ["text"] });
		expect(manager.addRule(rule)).toBe(true);

		const results = Array.from("forbidden", char => checkNames(manager, char));
		expect(results.slice(0, -1)).toEqual(Array.from({ length: 8 }, () => []));
		expect(results.at(-1)).toEqual(["small-deltas"]);
	});

	it("does not false-positive when the matching rule is not triggerable for the context", () => {
		const manager = new TtsrManager();
		const thinkingOnly = makeRule({ name: "thinking-only", condition: ["forbidden"], scope: ["thinking"] });
		const tsToolOnly = makeRule({ name: "ts-tool-only", condition: ["forbidden"], scope: ["tool:edit(*.ts)"] });
		expect(manager.addRule(thinkingOnly)).toBe(true);
		expect(manager.addRule(tsToolOnly)).toBe(true);

		expect(manager.checkDelta("forbidden", textContext)).toEqual([]);
		expect(manager.checkDelta("forbidden", { source: "tool", toolName: "edit", filePaths: ["src/main.rs"] })).toEqual(
			[],
		);
	});
});

describe("G002 red-team repeat/resume behavior", () => {
	it("honors per-rule repeatMode override over the global repeatMode", () => {
		const onceOverride = new TtsrManager({ repeatMode: "after-gap", repeatGap: 1 });
		expect(
			onceOverride.addRule(
				makeRule({ name: "once-override", condition: ["forbidden"], scope: ["text"], repeatMode: "once" }),
			),
		).toBe(true);
		expect(runMessage(onceOverride)).toEqual(["once-override"]);
		expect(runMessage(onceOverride)).toEqual([]);

		const afterGapOverride = new TtsrManager({ repeatMode: "once", repeatGap: 10 });
		expect(
			afterGapOverride.addRule(
				makeRule({
					name: "after-gap-override",
					condition: ["forbidden"],
					scope: ["text"],
					repeatMode: "after-gap",
					repeatGap: 1,
				}),
			),
		).toBe(true);
		expect(runMessage(afterGapOverride)).toEqual(["after-gap-override"]);
		expect(runMessage(afterGapOverride)).toEqual(["after-gap-override"]);
	});

	it("enforces per-rule repeatGap boundary: gap - 1 blocks and gap allows", () => {
		const manager = new TtsrManager({ repeatMode: "after-gap", repeatGap: 99 });
		expect(
			manager.addRule(
				makeRule({
					name: "gap-boundary",
					condition: ["forbidden"],
					scope: ["text"],
					repeatMode: "after-gap",
					repeatGap: 3,
				}),
			),
		).toBe(true);

		expect(runMessage(manager)).toEqual(["gap-boundary"]); // lastInjectedAt 0, messageCount -> 1
		expect(runMessage(manager)).toEqual([]); // gap 1
		expect(runMessage(manager)).toEqual([]); // gap 2 == repeatGap - 1
		expect(runMessage(manager)).toEqual(["gap-boundary"]); // gap 3
	});

	it("restores legacy string[] records as once-mode blocks", () => {
		const manager = new TtsrManager({ repeatMode: "once" });
		const rule = makeRule({ name: "legacy-once-block", condition: ["forbidden"], scope: ["text"] });
		expect(manager.addRule(rule)).toBe(true);
		manager.restoreInjected([rule.name]);

		expect(manager.getInjectedRuleNames()).toEqual(["legacy-once-block"]);
		expect(checkNames(manager, "forbidden")).toEqual([]);
	});

	it("restores new records with exact lastInjectedAt and exposes the same persisted record", () => {
		const manager = new TtsrManager({ repeatMode: "after-gap", repeatGap: 3 });
		const record: TtsrInjectionRecord = {
			name: "record-exact",
			lastInjectedAt: 5,
			repeatMode: "after-gap",
			repeatGap: 3,
		};
		expect(manager.addRule(makeRule({ name: record.name, condition: ["forbidden"], scope: ["text"] }))).toBe(true);
		manager.restoreMessageCount(7);
		manager.restoreInjected([record]);

		expect(manager.getInjectedRecords()).toEqual([record]);
		expect(checkNames(manager, "forbidden")).toEqual([]); // restored gap is 2
		manager.incrementMessageCount();
		manager.resetBuffer();
		expect(checkNames(manager, "forbidden")).toEqual(["record-exact"]); // restored gap is now exactly 3
	});

	it("resumes after-gap from restored message count and triggers only after the remaining gap", () => {
		const manager = new TtsrManager({ repeatMode: "after-gap", repeatGap: 5 });
		expect(manager.addRule(makeRule({ name: "resume-remaining", condition: ["forbidden"], scope: ["text"] }))).toBe(
			true,
		);
		manager.restoreMessageCount(12);
		manager.restoreInjected([{ name: "resume-remaining", lastInjectedAt: 9, repeatMode: "after-gap", repeatGap: 5 }]);

		expect(checkNames(manager, "forbidden")).toEqual([]); // gap 3
		manager.incrementMessageCount();
		manager.resetBuffer();
		expect(checkNames(manager, "forbidden")).toEqual([]); // gap 4
		manager.incrementMessageCount();
		manager.resetBuffer();
		expect(checkNames(manager, "forbidden")).toEqual(["resume-remaining"]); // gap 5
	});

	it("restores from a backward-compatible SessionContext-like legacy-only object without throwing", () => {
		const legacyOnlyContext: { injectedTtsrRules: string[] } = { injectedTtsrRules: ["legacy-only"] };
		const manager = new TtsrManager({ repeatMode: "once" });
		expect(manager.addRule(makeRule({ name: "legacy-only", condition: ["forbidden"], scope: ["text"] }))).toBe(true);

		expect(() => manager.restoreInjected(legacyOnlyContext.injectedTtsrRules)).not.toThrow();
		expect(manager.getInjectedRuleNames()).toEqual(["legacy-only"]);
		expect(checkNames(manager, "forbidden")).toEqual([]);
	});
});
