import { describe, expect, it } from "bun:test";
import type { Rule } from "@gajae-code/coding-agent/capability/rule";
import { buildRuleFromMarkdown } from "@gajae-code/coding-agent/discovery/helpers";
import { TtsrManager } from "@gajae-code/coding-agent/export/ttsr";
import { buildSessionContext, type SessionEntry } from "@gajae-code/coding-agent/session/session-manager";

const source = { provider: "test", providerName: "test", path: "/tmp/rule.md", level: "project" as const };

function makeRule(partial: Partial<Rule>): Rule {
	return {
		name: partial.name ?? "rule",
		path: partial.path ?? "/tmp/rule.md",
		content: partial.content ?? "Rule content",
		globs: partial.globs,
		alwaysApply: partial.alwaysApply,
		description: partial.description,
		condition: partial.condition,
		scope: partial.scope,
		interruptMode: partial.interruptMode,
		repeatMode: partial.repeatMode,
		repeatGap: partial.repeatGap,
		_source: partial._source ?? source,
	};
}

function ttsrEntry(
	partial: Partial<Extract<SessionEntry, { type: "ttsr_injection" }>>,
): Extract<SessionEntry, { type: "ttsr_injection" }> {
	return {
		type: "ttsr_injection",
		id: partial.id ?? "ttsr-entry",
		parentId: partial.parentId ?? null,
		timestamp: partial.timestamp ?? "2026-07-06T00:00:00.000Z",
		injectedRules: partial.injectedRules ?? [],
		injectedRuleRecords: partial.injectedRuleRecords,
		ttsrMessageCount: partial.ttsrMessageCount,
	};
}

describe("G002 TTSR persistence boundary", () => {
	it("round-trips rich injection records through buildSessionContext and restores after-gap at the exact remaining gap", () => {
		const entry = ttsrEntry({
			injectedRules: ["after-gap-rule"],
			injectedRuleRecords: [{ name: "after-gap-rule", lastInjectedAt: 7, repeatMode: "after-gap", repeatGap: 3 }],
			ttsrMessageCount: 8,
		});

		const context = buildSessionContext([entry]);

		expect(context.injectedTtsrRuleRecords).toEqual([
			{ name: "after-gap-rule", lastInjectedAt: 7, repeatMode: "after-gap", repeatGap: 3 },
		]);
		expect(context.ttsrMessageCount).toBe(8);

		const manager = new TtsrManager({ repeatMode: "once", repeatGap: 10 });
		expect(
			manager.addRule(
				makeRule({
					name: "after-gap-rule",
					condition: ["forbidden"],
					scope: ["text"],
					repeatMode: "after-gap",
					repeatGap: 3,
				}),
			),
		).toBe(true);
		manager.restoreInjected(context.injectedTtsrRuleRecords ?? []);
		manager.restoreMessageCount(context.ttsrMessageCount ?? 0);

		expect(manager.checkDelta("forbidden", { source: "text", streamKey: "before-gap" })).toEqual([]);
		manager.incrementMessageCount();
		expect(manager.checkDelta("forbidden", { source: "text", streamKey: "one-message-remaining" })).toEqual([]);
		manager.incrementMessageCount();
		expect(manager.checkDelta("forbidden", { source: "text", streamKey: "at-gap" }).map(rule => rule.name)).toEqual([
			"after-gap-rule",
		]);
	});

	it("persists real markInjected records through SessionContext and SDK restore calls", () => {
		const original = new TtsrManager({ repeatMode: "once", repeatGap: 10 });
		const rule = makeRule({
			name: "real-mark-after-gap",
			condition: ["forbidden"],
			scope: ["text"],
			repeatMode: "after-gap",
			repeatGap: 3,
		});
		expect(original.addRule(rule)).toBe(true);
		original.incrementMessageCount();
		original.incrementMessageCount();
		original.markInjected([rule]);

		const persistedRecords = original.getInjectedRecords();
		const persistedMessageCount = original.getMessageCount();
		const context = buildSessionContext([
			ttsrEntry({
				injectedRules: persistedRecords.map(record => record.name),
				injectedRuleRecords: persistedRecords,
				ttsrMessageCount: persistedMessageCount,
			}),
		]);

		expect(context.injectedTtsrRuleRecords).toEqual(persistedRecords);
		expect(context.ttsrMessageCount).toBe(persistedMessageCount);

		const restored = new TtsrManager({ repeatMode: "once", repeatGap: 10 });
		expect(restored.addRule(rule)).toBe(true);
		restored.restoreInjected(context.injectedTtsrRuleRecords ?? []);
		restored.restoreMessageCount(context.ttsrMessageCount ?? 0);

		expect(restored.checkDelta("forbidden", { source: "text", streamKey: "gap-0" })).toEqual([]);
		restored.incrementMessageCount();
		expect(restored.checkDelta("forbidden", { source: "text", streamKey: "gap-1" })).toEqual([]);
		restored.incrementMessageCount();
		expect(restored.checkDelta("forbidden", { source: "text", streamKey: "gap-2" })).toEqual([]);
		restored.incrementMessageCount();
		expect(restored.checkDelta("forbidden", { source: "text", streamKey: "gap-3" }).map(match => match.name)).toEqual(
			["real-mark-after-gap"],
		);
	});

	it("synthesizes legacy injectedRules as lastInjectedAt zero records and keeps once-mode sessions blocked", () => {
		const context = buildSessionContext([ttsrEntry({ injectedRules: ["legacy-once-rule"] })]);

		expect(context.injectedTtsrRuleRecords).toEqual([{ name: "legacy-once-rule", lastInjectedAt: 0 }]);
		expect(context.ttsrMessageCount).toBe(0);

		const manager = new TtsrManager({ repeatMode: "once" });
		expect(manager.addRule(makeRule({ name: "legacy-once-rule", condition: ["legacy"], scope: ["text"] }))).toBe(
			true,
		);
		manager.restoreInjected(context.injectedTtsrRuleRecords ?? []);

		expect(manager.checkDelta("legacy", { source: "text" })).toEqual([]);
	});
});

describe("G002 TTSR rule frontmatter parsing", () => {
	it("ignores invalid repeat policy frontmatter instead of accepting it", () => {
		const invalidMode = buildRuleFromMarkdown(
			"invalid-mode.md",
			'---\ncondition: "forbidden"\nrepeatMode: "sometimes"\nrepeatGap: 4\n---\nContent',
			"/tmp/invalid-mode.md",
			source,
		);
		const nonNumericGap = buildRuleFromMarkdown(
			"non-numeric-gap.md",
			'---\ncondition: "forbidden"\nrepeatMode: "after-gap"\nrepeatGap: "often"\n---\nContent',
			"/tmp/non-numeric-gap.md",
			source,
		);
		const negativeGap = buildRuleFromMarkdown(
			"negative-gap.md",
			'---\ncondition: "forbidden"\nrepeatMode: "after-gap"\nrepeatGap: "-1"\n---\nContent',
			"/tmp/negative-gap.md",
			source,
		);
		const negativeNumericGap = buildRuleFromMarkdown(
			"negative-numeric-gap.md",
			'---\ncondition: "forbidden"\nrepeatMode: "after-gap"\nrepeatGap: -1\n---\nContent',
			"/tmp/negative-numeric-gap.md",
			source,
		);
		const zeroGap = buildRuleFromMarkdown(
			"zero-gap.md",
			'---\ncondition: "forbidden"\nrepeatMode: "after-gap"\nrepeatGap: 0\n---\nContent',
			"/tmp/zero-gap.md",
			source,
		);
		const fractionalGap = buildRuleFromMarkdown(
			"fractional-gap.md",
			'---\ncondition: "forbidden"\nrepeatMode: "after-gap"\nrepeatGap: 2.5\n---\nContent',
			"/tmp/fractional-gap.md",
			source,
		);
		const positiveIntegerGap = buildRuleFromMarkdown(
			"positive-integer-gap.md",
			'---\ncondition: "forbidden"\nrepeatMode: "after-gap"\nrepeatGap: 3\n---\nContent',
			"/tmp/positive-integer-gap.md",
			source,
		);

		expect(invalidMode.repeatMode).toBeUndefined();
		expect(invalidMode.repeatGap).toBe(4);
		expect(nonNumericGap.repeatMode).toBe("after-gap");
		expect(nonNumericGap.repeatGap).toBeUndefined();
		expect(negativeGap.repeatMode).toBe("after-gap");
		expect(negativeGap.repeatGap).toBeUndefined();
		expect(negativeNumericGap.repeatMode).toBe("after-gap");
		expect(negativeNumericGap.repeatGap).toBeUndefined();
		expect(zeroGap.repeatMode).toBe("after-gap");
		expect(zeroGap.repeatGap).toBeUndefined();
		expect(fractionalGap.repeatMode).toBe("after-gap");
		expect(fractionalGap.repeatGap).toBeUndefined();
		expect(positiveIntegerGap.repeatMode).toBe("after-gap");
		expect(positiveIntegerGap.repeatGap).toBe(3);
	});

	it("parses valid once and after-gap repeat policy frontmatter onto rules", () => {
		const onceRule = buildRuleFromMarkdown(
			"once.md",
			'---\ncondition: "forbidden"\nrepeatMode: "once"\n---\nContent',
			"/tmp/once.md",
			source,
		);
		const afterGapRule = buildRuleFromMarkdown(
			"after-gap.md",
			'---\ncondition: "forbidden"\nrepeatMode: "after-gap"\nrepeatGap: 5\n---\nContent',
			"/tmp/after-gap.md",
			source,
		);

		expect(onceRule.repeatMode).toBe("once");
		expect(onceRule.repeatGap).toBeUndefined();
		expect(afterGapRule.repeatMode).toBe("after-gap");
		expect(afterGapRule.repeatGap).toBe(5);
	});
});
