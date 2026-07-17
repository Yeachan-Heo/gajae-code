import { describe, expect, it } from "bun:test";
import * as path from "node:path";
import { parseRuleConditionAndScope, type Rule } from "@gajae-code/coding-agent/capability/rule";
import { buildRuleFromMarkdown } from "@gajae-code/coding-agent/discovery/helpers";
import { TtsrManager } from "@gajae-code/coding-agent/export/ttsr";

function makeRule(partial: Partial<Rule>): Rule {
	return {
		name: partial.name ?? "rule",
		path: partial.path ?? "/tmp/rule.md",
		content: partial.content ?? "Do not use as any",
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
			path: "/tmp/rule.md",
			level: "project",
		},
	};
}

function bucketRulesWithTtsrDisabled(rules: Rule[]): { rulebookRules: Rule[]; alwaysApplyRules: Rule[] } {
	const ttsrManager = new TtsrManager({ enabled: false });
	const rulebookRules: Rule[] = [];
	const alwaysApplyRules: Rule[] = [];
	for (const rule of rules) {
		const isTtsrRule = rule.condition && rule.condition.length > 0 ? ttsrManager.addRule(rule) : false;
		if (isTtsrRule) {
			continue;
		}
		if (rule.alwaysApply === true) {
			alwaysApplyRules.push(rule);
			continue;
		}
		if (rule.description) {
			rulebookRules.push(rule);
		}
	}
	return { rulebookRules, alwaysApplyRules };
}

describe("parseRuleConditionAndScope", () => {
	it("accepts condition and scope as literal strings", () => {
		const parsed = parseRuleConditionAndScope({
			condition: "\\bas any\\b",
			scope: "tool:edit",
		});

		expect(parsed.condition).toEqual(["\\bas any\\b"]);
		expect(parsed.scope).toEqual(["tool:edit"]);
	});

	it("accepts condition and scope as arrays", () => {
		const parsed = parseRuleConditionAndScope({
			condition: ["foo", "bar"],
			scope: ["tool:edit", "tool:write"],
		});

		expect(parsed.condition).toEqual(["foo", "bar"]);
		expect(parsed.scope).toEqual(["tool:edit", "tool:write"]);
	});

	it("accepts legacy ttsr_trigger as condition fallback", () => {
		const parsed = parseRuleConditionAndScope({
			ttsr_trigger: "forbidden",
		});

		expect(parsed.condition).toEqual(["forbidden"]);
		expect(parsed.scope).toBeUndefined();
	});

	it("accepts legacy ttsrTrigger as condition fallback", () => {
		const parsed = parseRuleConditionAndScope({
			ttsrTrigger: "legacy-camel-case",
		});

		expect(parsed.condition).toEqual(["legacy-camel-case"]);
		expect(parsed.scope).toBeUndefined();
	});

	it("keeps regex-like conditions as regex and does not infer file scope", () => {
		const parsed = parseRuleConditionAndScope({
			condition: "error.*timeout",
		});

		expect(parsed.condition).toEqual(["error.*timeout"]);
		expect(parsed.scope).toBeUndefined();
	});

	it("splits comma-delimited scope without corrupting brace globs", () => {
		const parsed = parseRuleConditionAndScope({
			scope: "text, tool:edit(*.{ts,tsx})",
		});

		expect(parsed.condition).toBeUndefined();
		expect(parsed.scope).toEqual(["text", "tool:edit(*.{ts,tsx})"]);
	});

	it("maps glob-like condition to edit/write scoped shorthand", () => {
		const parsed = parseRuleConditionAndScope({
			condition: "*.rs",
		});

		expect(parsed.condition).toEqual([".*"]);
		expect(parsed.scope).toEqual(["tool:edit(*.rs)", "tool:write(*.rs)"]);
	});

	it("parses per-rule repeat policy frontmatter", () => {
		const rule = buildRuleFromMarkdown(
			"rule.md",
			'---\ncondition: "forbidden"\nrepeatMode: "after-gap"\nrepeatGap: 3\n---\nContent',
			"/tmp/rule.md",
			{ provider: "test", providerName: "test", path: "/tmp/rule.md", level: "project" },
		);

		expect(rule.condition).toEqual(["forbidden"]);
		expect(rule.repeatMode).toBe("after-gap");
		expect(rule.repeatGap).toBe(3);
	});
});

describe("TtsrManager disabled behavior", () => {
	it("does not register rules when disabled", () => {
		const manager = new TtsrManager({ enabled: false });
		const rule = makeRule({
			name: "disabled-rule",
			condition: ["forbidden"],
			scope: ["text"],
		});

		expect(manager.addRule(rule)).toBe(false);
		expect(manager.hasRules()).toBe(false);
		manager.restoreInjected([rule.name]);
		expect(manager.getInjectedRuleNames()).toEqual([]);
	});

	it("does not match deltas when disabled", () => {
		const manager = new TtsrManager({ enabled: false });
		const rule = makeRule({
			name: "disabled-match",
			condition: ["forbidden"],
			scope: ["text"],
		});

		expect(manager.addRule(rule)).toBe(false);
		expect(manager.checkDelta("forbidden", { source: "text" })).toEqual([]);
	});

	it("keeps disabled conditional-only rules out of sdk rulebook bucketing", () => {
		const conditionalOnly = makeRule({
			name: "conditional-only",
			condition: ["forbidden"],
		});
		const conditionalWithDescription = makeRule({
			name: "conditional-with-description",
			condition: ["forbidden"],
			description: "Visible in rulebook when TTSR is disabled",
		});
		const conditionalAlwaysApply = makeRule({
			name: "conditional-always-apply",
			condition: ["forbidden"],
			alwaysApply: true,
		});

		// Mirrors sdk/session.ts discovery bucketing: addRule(false) must not turn conditional-only rules into rulebook rules.
		const { rulebookRules, alwaysApplyRules } = bucketRulesWithTtsrDisabled([
			conditionalOnly,
			conditionalWithDescription,
			conditionalAlwaysApply,
		]);

		expect(rulebookRules).toEqual([conditionalWithDescription]);
		expect(alwaysApplyRules).toEqual([conditionalAlwaysApply]);
	});
});

describe("TtsrManager scope matching", () => {
	it("applies file-scoped tool rules without cross-language contamination", () => {
		const manager = new TtsrManager();
		const rule = makeRule({
			name: "ts-no-as-any",
			condition: ["\\bas any\\b"],
			scope: ["tool:edit(*.ts)", "tool:write(*.ts)"],
		});

		manager.addRule(rule);

		expect(
			manager.checkDelta("as any", {
				source: "tool",
				toolName: "edit",
				filePaths: ["src/main.ts"],
			}),
		).toEqual([rule]);

		expect(
			manager.checkDelta("as any", {
				source: "tool",
				toolName: "edit",
				filePaths: ["src/main.rs"],
			}),
		).toEqual([]);

		expect(
			manager.checkDelta("as any", {
				source: "text",
			}),
		).toEqual([]);
	});

	it("treats bare tool names as specific tools, not as the generic tool scope", () => {
		const manager = new TtsrManager();
		const rule = makeRule({
			name: "tooling-only",
			condition: ["forbidden"],
			scope: ["tooling"],
		});

		manager.addRule(rule);

		expect(
			manager.checkDelta("forbidden", {
				source: "tool",
				toolName: "edit",
			}),
		).toEqual([]);

		expect(
			manager.checkDelta("forbidden", {
				source: "tool",
				toolName: "tooling",
			}),
		).toEqual([rule]);
	});

	it("preserves path glob casing in tool scope matching", () => {
		const manager = new TtsrManager();
		const rule = makeRule({
			name: "upper-ext-only",
			condition: ["forbidden"],
			scope: ["tool:edit(*.TS)"],
		});

		manager.addRule(rule);

		expect(
			manager.checkDelta("forbidden", {
				source: "tool",
				toolName: "edit",
				filePaths: ["src/main.ts"],
			}),
		).toEqual([]);

		expect(
			manager.checkDelta("forbidden", {
				source: "tool",
				toolName: "edit",
				filePaths: ["src/main.TS"],
			}),
		).toEqual([rule]);
	});

	it("returns false when registering rules with only invalid condition regex", () => {
		const manager = new TtsrManager();
		const added = manager.addRule(
			makeRule({
				name: "invalid-regex",
				condition: ["("],
			}),
		);

		expect(added).toBe(false);
	});

	it("returns false when registering rules with unreachable malformed scope", () => {
		const manager = new TtsrManager();
		const added = manager.addRule(
			makeRule({
				name: "invalid-scope",
				condition: ["forbidden"],
				scope: ["tool:edit(*.ts"],
			}),
		);

		expect(added).toBe(false);
		expect(
			manager.checkDelta("forbidden", {
				source: "tool",
				toolName: "edit",
				filePaths: ["src/main.ts"],
			}),
		).toEqual([]);
	});

	it("matches write scope and rejects thinking/tool mismatches for the same rule", () => {
		const manager = new TtsrManager();
		const rule = makeRule({
			name: "ts-no-write-as-any",
			condition: ["\\bas any\\b"],
			scope: ["tool:write(*.ts)"],
		});

		manager.addRule(rule);

		expect(
			manager.checkDelta("as any", {
				source: "tool",
				toolName: "write",
				filePaths: ["src/main.ts"],
			}),
		).toEqual([rule]);
		expect(
			manager.checkDelta("as any", {
				source: "thinking",
			}),
		).toEqual([]);
		expect(
			manager.checkDelta("as any", {
				source: "tool",
				toolName: "edit",
				filePaths: ["src/main.ts"],
			}),
		).toEqual([]);
	});

	it("matches file-scoped rules across relative and absolute path variants", () => {
		const manager = new TtsrManager();
		const rule = makeRule({
			name: "variant-paths",
			condition: ["forbidden"],
			scope: ["tool:edit(*.ts)"],
		});
		const absolutePath = path.resolve("/tmp", "src", "main.ts");

		manager.addRule(rule);

		expect(
			manager.checkDelta("forbidden", {
				source: "tool",
				toolName: "edit",
				filePaths: ["./src/main.ts"],
			}),
		).toEqual([rule]);
		expect(
			manager.checkDelta("forbidden", {
				source: "tool",
				toolName: "edit",
				filePaths: ["src/main.ts"],
			}),
		).toEqual([rule]);
		expect(
			manager.checkDelta("forbidden", {
				source: "tool",
				toolName: "edit",
				filePaths: [absolutePath],
			}),
		).toEqual([rule]);
	});
});

describe("TtsrManager bounded matching", () => {
	it("matches safe conditions across chunk boundaries", () => {
		const manager = new TtsrManager();
		const rule = makeRule({ name: "boundary", condition: ["forbidden"], scope: ["text"] });
		manager.addRule(rule);

		expect(manager.checkDelta("for", { source: "text" })).toEqual([]);
		expect(manager.checkDelta("bidden", { source: "text" })).toEqual([rule]);
	});

	it("falls back to full-buffer matching for anchored unsafe regex", () => {
		const manager = new TtsrManager();
		const rule = makeRule({ name: "anchored", condition: ["^hello.*forbidden$"], scope: ["text"] });
		manager.addRule(rule);

		expect(manager.checkDelta("hello ", { source: "text" })).toEqual([]);
		expect(manager.checkDelta("forbidden", { source: "text" })).toEqual([rule]);
	});

	it("does not scan conditions when no rule is triggerable for the context", () => {
		const manager = new TtsrManager();
		const rule = makeRule({ name: "once-only", condition: ["forbidden"], scope: ["text"] });
		manager.addRule(rule);
		manager.markInjected([rule]);

		expect(manager.checkDelta("forbidden", { source: "text" })).toEqual([]);
	});
});

describe("TtsrManager repeat behavior", () => {
	const turnContext = { source: "text" as const };

	function createRepeatRule(name = "repeat-rule"): Rule {
		return makeRule({
			name,
			condition: ["forbidden"],
			scope: ["text"],
		});
	}

	function runTurn(manager: TtsrManager, rule: Rule): Rule[] {
		manager.resetBuffer();
		const matches = manager.checkDelta("forbidden", turnContext);
		if (matches.length > 0) {
			manager.markInjected([rule]);
		}
		manager.incrementMessageCount();
		return matches;
	}

	it("never repeats when repeat mode is once", () => {
		const manager = new TtsrManager({
			enabled: true,
			contextMode: "discard",
			interruptMode: "always",
			repeatMode: "once",
			repeatGap: 10,
		});
		const rule = createRepeatRule("once");
		manager.addRule(rule);

		expect(runTurn(manager, rule)).toEqual([rule]);
		expect(runTurn(manager, rule)).toEqual([]);
		expect(runTurn(manager, rule)).toEqual([]);
	});

	it("repeats every turn when repeat mode is after-gap and gap is 1", () => {
		const manager = new TtsrManager({
			enabled: true,
			contextMode: "discard",
			interruptMode: "always",
			repeatMode: "after-gap",
			repeatGap: 1,
		});
		const rule = createRepeatRule("gap-1");
		manager.addRule(rule);

		expect(runTurn(manager, rule)).toEqual([rule]);
		expect(runTurn(manager, rule)).toEqual([rule]);
		expect(runTurn(manager, rule)).toEqual([rule]);
	});

	it("respects repeat gap when repeat mode is after-gap", () => {
		const manager = new TtsrManager({
			enabled: true,
			contextMode: "discard",
			interruptMode: "always",
			repeatMode: "after-gap",
			repeatGap: 2,
		});
		const rule = createRepeatRule("gap-2");
		manager.addRule(rule);

		expect(runTurn(manager, rule)).toEqual([rule]);
		expect(runTurn(manager, rule)).toEqual([]);
		expect(runTurn(manager, rule)).toEqual([rule]);
		expect(runTurn(manager, rule)).toEqual([]);
		expect(runTurn(manager, rule)).toEqual([rule]);
	});

	it("honors per-rule once override when global mode is after-gap", () => {
		const manager = new TtsrManager({ repeatMode: "after-gap", repeatGap: 1 });
		const rule = makeRule({ name: "rule-once", condition: ["forbidden"], scope: ["text"], repeatMode: "once" });
		manager.addRule(rule);

		expect(runTurn(manager, rule)).toEqual([rule]);
		expect(runTurn(manager, rule)).toEqual([]);
	});

	it("honors per-rule after-gap override when global mode is once", () => {
		const manager = new TtsrManager({ repeatMode: "once", repeatGap: 10 });
		const rule = makeRule({
			name: "rule-after-gap",
			condition: ["forbidden"],
			scope: ["text"],
			repeatMode: "after-gap",
			repeatGap: 1,
		});
		manager.addRule(rule);

		expect(runTurn(manager, rule)).toEqual([rule]);
		expect(runTurn(manager, rule)).toEqual([rule]);
	});

	it("honors per-rule repeat gap override", () => {
		const manager = new TtsrManager({ repeatMode: "after-gap", repeatGap: 10 });
		const rule = makeRule({ name: "rule-gap", condition: ["forbidden"], scope: ["text"], repeatGap: 2 });
		manager.addRule(rule);

		expect(runTurn(manager, rule)).toEqual([rule]);
		expect(runTurn(manager, rule)).toEqual([]);
		expect(runTurn(manager, rule)).toEqual([rule]);
	});

	it("blocks restored rules in once mode across resumed sessions", () => {
		const manager = new TtsrManager({
			enabled: true,
			contextMode: "discard",
			interruptMode: "always",
			repeatMode: "once",
			repeatGap: 10,
		});
		const rule = createRepeatRule("restored-once");
		manager.addRule(rule);
		manager.restoreInjected([rule.name]);

		expect(runTurn(manager, rule)).toEqual([]);
		expect(runTurn(manager, rule)).toEqual([]);
	});

	it("applies repeat gap to restored rules in after-gap mode", () => {
		const manager = new TtsrManager({
			enabled: true,
			contextMode: "discard",
			interruptMode: "always",
			repeatMode: "after-gap",
			repeatGap: 2,
		});
		const rule = createRepeatRule("restored-gap");
		manager.addRule(rule);
		manager.restoreInjected([rule.name]);

		expect(runTurn(manager, rule)).toEqual([]);
		expect(runTurn(manager, rule)).toEqual([]);
		expect(runTurn(manager, rule)).toEqual([rule]);
	});

	it("restores new record arrays with exact lastInjectedAt", () => {
		const manager = new TtsrManager({ repeatMode: "after-gap", repeatGap: 3 });
		const rule = createRepeatRule("record-gap");
		manager.addRule(rule);
		manager.restoreMessageCount(4);
		manager.restoreInjected([{ name: rule.name, lastInjectedAt: 2, repeatMode: "after-gap", repeatGap: 3 }]);

		expect(runTurn(manager, rule)).toEqual([]);
		expect(runTurn(manager, rule)).toEqual([rule]);
	});

	it("resumes after-gap with exact remaining gap from restored message count", () => {
		const manager = new TtsrManager({ repeatMode: "after-gap", repeatGap: 5 });
		const rule = createRepeatRule("resume-gap");
		manager.addRule(rule);
		manager.restoreMessageCount(7);
		manager.restoreInjected([{ name: rule.name, lastInjectedAt: 3, repeatMode: "after-gap", repeatGap: 5 }]);

		expect(manager.checkDelta("forbidden", turnContext)).toEqual([]);
		manager.incrementMessageCount();
		manager.resetBuffer();
		expect(manager.checkDelta("forbidden", turnContext)).toEqual([rule]);
	});

	it("tracks only one injection record per rule per turn", () => {
		const manager = new TtsrManager({
			enabled: true,
			contextMode: "discard",
			interruptMode: "always",
			repeatMode: "after-gap",
			repeatGap: 1,
		});
		const rule = createRepeatRule("single-record");
		manager.addRule(rule);

		manager.markInjected([rule]);
		manager.markInjected([rule]);
		manager.markInjected([rule]);
		expect(manager.getInjectedRuleNames()).toEqual([rule.name]);

		manager.incrementMessageCount();
		expect(manager.checkDelta("forbidden", turnContext)).toEqual([rule]);
	});
});

describe("TtsrManager enabled gating (Finding 10)", () => {
	const textContext = { source: "text" as const };

	function makeSettings(enabled: boolean) {
		return {
			enabled,
			contextMode: "discard" as const,
			interruptMode: "always" as const,
			repeatMode: "after-gap" as const,
			repeatGap: 1,
		};
	}

	function forbiddenRule(): Rule {
		return makeRule({ name: "forbidden-rule", condition: ["forbidden"], scope: ["text"] });
	}

	it("does not match when disabled, even with a registered matching rule", () => {
		const manager = new TtsrManager(makeSettings(false));
		manager.addRule(forbiddenRule());
		expect(manager.checkDelta("forbidden", textContext)).toEqual([]);
		// Repeated deltas still never match while disabled.
		expect(manager.checkDelta(" forbidden again", textContext)).toEqual([]);
	});

	it("matches once re-enabled (control)", () => {
		const rule = forbiddenRule();
		const enabled = new TtsrManager(makeSettings(true));
		enabled.addRule(rule);
		expect(enabled.checkDelta("forbidden", textContext)).toEqual([rule]);
	});

	it("disabled manager buffers nothing, so enabling later starts from a clean slate", () => {
		const manager = new TtsrManager(makeSettings(false));
		manager.addRule(forbiddenRule());
		// Feed a partial match while disabled; it must not be retained.
		expect(manager.checkDelta("forbid", textContext)).toEqual([]);
	});
});
