import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Agent, type AgentTool } from "@gajae-code/agent-core";
import {
	type AssistantMessage,
	getBundledModel,
	type Message,
	type ToolCall,
	type ToolResultMessage,
} from "@gajae-code/ai";
import { AssistantMessageEventStream } from "@gajae-code/ai/utils/event-stream";
import { parseRuleConditionAndScope, type Rule } from "@gajae-code/coding-agent/capability/rule";
import { buildRuleFromMarkdown } from "@gajae-code/coding-agent/discovery/helpers";
import { type TtsrInjectionRecord, TtsrManager } from "@gajae-code/coding-agent/export/ttsr";
import { logger } from "@gajae-code/utils";
import { ModelRegistry } from "../src/config/model-registry";
import { Settings } from "../src/config/settings";
import { EditTool } from "../src/edit";
import { createAgentSession } from "../src/sdk";
import { AgentSession } from "../src/session/agent-session";
import { AuthStorage } from "../src/session/auth-storage";
import { convertToLlm } from "../src/session/messages";
import { SessionManager } from "../src/session/session-manager";
import type { ToolSession } from "../src/tools";
import { BUILTIN_TOOL_DESCRIPTORS, LazyAgentTool } from "../src/tools/descriptors";
import { WriteTool } from "../src/tools/write";

/** Deep copy that keeps symbol-keyed schema annotations (unlike structuredClone). */
function cloneSchema<T>(value: T): T {
	if (Array.isArray(value)) return value.map(item => cloneSchema(item)) as T;
	if (!value || typeof value !== "object") return value;
	const copy = Object.create(Object.getPrototypeOf(value)) as Record<PropertyKey, unknown>;
	for (const key of Reflect.ownKeys(value)) copy[key] = cloneSchema((value as Record<PropertyKey, unknown>)[key]);
	return copy as T;
}

function makeRule(partial: Partial<Rule>): Rule {
	return {
		name: partial.name ?? "rule",
		path: partial.path ?? "/tmp/rule.md",
		content: partial.content ?? "Do not use as any",
		globs: partial.globs,
		alwaysApply: partial.alwaysApply,
		description: partial.description,
		condition: partial.condition,
		astCondition: partial.astCondition,
		scope: partial.scope,
		interruptMode: partial.interruptMode,
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

describe("TTSR astCondition parsing and registration", () => {
	it("normalizes a single astCondition string to a list", () => {
		expect(parseRuleConditionAndScope({ astCondition: "export default $X" }).astCondition).toEqual([
			"export default $X",
		]);
	});

	it("deduplicates astCondition patterns", () => {
		expect(
			parseRuleConditionAndScope({ astCondition: ["export default $X", "export default $X"] }).astCondition,
		).toEqual(["export default $X"]);
	});

	it("drops an empty astCondition", () => {
		expect(parseRuleConditionAndScope({ astCondition: "" }).astCondition).toBeUndefined();
	});

	it("parses astCondition from rule markdown frontmatter", () => {
		const rule = buildRuleFromMarkdown(
			"named-exports.md",
			"---\nastCondition: export default $X\nscope: tool:write(*.ts)\n---\nUse named exports.",
			"/tmp/rules/named-exports.md",
			{ provider: "test", providerName: "test", path: "/tmp/rules/named-exports.md", level: "project" },
		);
		expect(rule.astCondition).toEqual(["export default $X"]);
		expect(rule.condition).toBeUndefined();
		expect(rule.scope).toEqual(["tool:write(*.ts)"]);
	});

	it("registers a rule that only has astCondition", () => {
		const manager = new TtsrManager();
		expect(manager.addRule(makeRule({ name: "ast-only", astCondition: ["export default $X"] }))).toBe(true);
		expect(manager.hasAstRules()).toBe(true);
	});

	it("reports no AST rules when only regex rules are registered", () => {
		const manager = new TtsrManager();
		manager.addRule(makeRule({ name: "regex-only", condition: ["forbidden"] }));
		expect(manager.hasAstRules()).toBe(false);
	});

	it("never streams-matches an AST-only rule", () => {
		const manager = new TtsrManager();
		manager.addRule(makeRule({ name: "ast-only", astCondition: ["export default $X"] }));
		expect(manager.checkDelta("export default foo;", { source: "tool", toolName: "write" })).toEqual([]);
	});
});

describe("TtsrManager.checkAstSnapshot", () => {
	const source = "const foo = 1;\nexport default foo;\n";
	const toolContext = (filePath = "a.ts", toolName = "write", streamKey = "toolcall:write-1") => ({
		source: "tool" as const,
		toolName,
		filePaths: [filePath],
		streamKey,
	});
	const defaultExportRule = (partial: Partial<Rule> = {}) =>
		makeRule({ name: "named-exports", astCondition: ["export default $X"], ...partial });

	it("matches an in-memory source snapshot without a file on disk", async () => {
		const manager = new TtsrManager();
		const rule = defaultExportRule();
		manager.addRule(rule);
		expect(await manager.checkAstSnapshot(source, toolContext())).toEqual([rule]);
	});

	it("does not match a comment-only mention", async () => {
		const manager = new TtsrManager();
		manager.addRule(defaultExportRule());
		expect(await manager.checkAstSnapshot("// export default foo;\nexport const foo = 1;", toolContext())).toEqual(
			[],
		);
	});

	it("reports an invalid CSS astCondition once per rule and language", async () => {
		const warning = spyOn(logger, "warn").mockImplementation(() => {});
		try {
			const manager = new TtsrManager();
			const rule = defaultExportRule({ name: "css-important", astCondition: ["$P: $V !important"] });
			manager.addRule(rule);

			expect(
				await manager.checkAstSnapshot(".button { color: red; }", toolContext("theme.scss", "write", "first")),
			).toEqual([]);
			expect(
				await manager.checkAstSnapshot(".button { color: blue; }", toolContext("other.scss", "write", "second")),
			).toEqual([]);
			expect(
				await manager.checkAstSnapshot(".button { color: red; }", toolContext("theme.css", "write", "third")),
			).toEqual([]);

			const parseWarnings = warning.mock.calls.filter(
				([message]) => message === "TTSR astCondition pattern is invalid for target language",
			);
			expect(parseWarnings).toHaveLength(2);
			expect(parseWarnings.map(([, context]) => context?.lang)).toEqual(["scss", "css"]);
			const diagnostics = manager.getAstConditionDiagnostics();
			expect(diagnostics.map(({ ruleName, lang, patterns }) => ({ ruleName, lang, patterns }))).toEqual([
				{ ruleName: "css-important", lang: "scss", patterns: ["$P: $V !important"] },
				{ ruleName: "css-important", lang: "css", patterns: ["$P: $V !important"] },
			]);
			expect(diagnostics[0]?.parseErrors[0]).toContain("pattern is not valid css on its own");
		} finally {
			warning.mockRestore();
		}
	});

	it("still matches a standalone CSS !important astCondition", async () => {
		const manager = new TtsrManager();
		const rule = defaultExportRule({ name: "css-important", astCondition: ["!important"] });
		manager.addRule(rule);

		expect(await manager.checkAstSnapshot(".button { color: red !important; }", toolContext("theme.scss"))).toEqual([
			rule,
		]);
		expect(manager.getAstConditionDiagnostics()).toEqual([]);
	});

	it("does not report a target source parse error as an invalid pattern", async () => {
		const manager = new TtsrManager();
		const rule = defaultExportRule({ name: "css-declaration", astCondition: ["$P: $V;"] });
		manager.addRule(rule);

		expect(await manager.checkAstSnapshot(".button { color: red;", toolContext("theme.scss"))).toEqual([rule]);
		expect(manager.getAstConditionDiagnostics()).toEqual([]);
	});

	it("holds seeded AST diagnostic deduplication and copy properties (seed 0x6853)", async () => {
		const warning = spyOn(logger, "warn").mockImplementation(() => {});
		try {
			const manager = new TtsrManager();
			const invalidRuleNames = ["invalid-a", "invalid-b", "invalid-c"];
			const sourceOnlyRuleName = "source-only";
			const ruleNames = [...invalidRuleNames, sourceOnlyRuleName];
			const languages = ["scss", "css"] as const;
			for (const ruleName of ruleNames) {
				manager.addRule(
					defaultExportRule({
						name: ruleName,
						astCondition: [ruleName === sourceOnlyRuleName ? "$P: $V;" : "$P: $V !important"],
						scope: languages.map(lang => `tool:write(src/${ruleName}.${lang})`),
					}),
				);
			}

			let state = 0x6853;
			const random = (): number => {
				state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
				return state / 0x1_0000_0000;
			};
			type Event = { ruleName: string; lang: (typeof languages)[number]; sourceKind: "valid" | "malformed" };
			const generatedEvents: Event[] = Array.from({ length: 24 }, () => {
				const ruleName = ruleNames[Math.floor(random() * ruleNames.length)]!;
				const lang = languages[Math.floor(random() * languages.length)]!;
				return { ruleName, lang, sourceKind: random() < 0.5 ? "valid" : "malformed" };
			});
			const coverageEvents: Event[] = invalidRuleNames.flatMap(ruleName =>
				languages.flatMap(lang => [
					{ ruleName, lang, sourceKind: "malformed" as const },
					{ ruleName, lang, sourceKind: "valid" as const },
					{ ruleName, lang, sourceKind: "malformed" as const },
				]),
			);
			const sourceOnlyEvents: Event[] = languages.map(lang => ({
				ruleName: sourceOnlyRuleName,
				lang,
				sourceKind: "malformed",
			}));
			const events = [...generatedEvents, ...coverageEvents, ...sourceOnlyEvents];

			for (const [eventIndex, event] of events.entries()) {
				const source = event.sourceKind === "malformed" ? ".button { color: red;" : ".button { color: red; }";
				await manager.checkAstSnapshot(source, {
					source: "tool",
					toolName: "write",
					filePaths: [`src/${event.ruleName}.${event.lang}`],
					streamKey: `generated-diagnostic-event-${eventIndex}`,
				});
			}

			const expectedPairs = invalidRuleNames
				.flatMap(ruleName => languages.map(lang => `${ruleName}:${lang}`))
				.sort();
			const diagnostics = manager.getAstConditionDiagnostics();
			const diagnosticPairs = diagnostics.map(({ ruleName, lang }) => `${ruleName}:${lang}`).sort();
			expect(diagnosticPairs).toEqual(expectedPairs);
			expect(diagnostics).toHaveLength(expectedPairs.length);
			expect(
				diagnostics.every(
					diagnostic =>
						diagnostic.ruleName !== sourceOnlyRuleName &&
						diagnostic.parseErrors.every(error => error !== "parse error (syntax tree contains error nodes)") &&
						diagnostic.parseErrors.some(error => error.includes("pattern is not valid css on its own")),
				),
			).toBe(true);

			const parseWarnings = warning.mock.calls.filter(
				([message]) => message === "TTSR astCondition pattern is invalid for target language",
			);
			const warningPairs = parseWarnings
				.map(([, context]) => `${String(context?.ruleName)}:${String(context?.lang)}`)
				.sort();
			expect(warningPairs).toEqual(expectedPairs);

			const original = manager.getAstConditionDiagnostics();
			const mutated = manager.getAstConditionDiagnostics();
			const first = mutated[0];
			if (!first) throw new Error("expected generated AST diagnostics");
			first.ruleName = "mutated";
			first.patterns.push("mutated");
			first.parseErrors.push("mutated");
			mutated.push({ ruleName: "mutated", lang: "css", patterns: [], parseErrors: [] });
			expect(manager.getAstConditionDiagnostics()).toEqual(original);
		} finally {
			warning.mockRestore();
		}
	});

	it("does not match unsupported or missing file extensions", async () => {
		const manager = new TtsrManager();
		manager.addRule(defaultExportRule());
		expect(await manager.checkAstSnapshot(source, toolContext("a.unknownext"))).toEqual([]);
		expect(await manager.checkAstSnapshot(source, toolContext("Makefile"))).toEqual([]);
	});

	it("does not evaluate non-tool sources or a disabled manager", async () => {
		const manager = new TtsrManager();
		manager.addRule(defaultExportRule());
		expect(await manager.checkAstSnapshot(source, { ...toolContext(), source: "text" })).toEqual([]);
		const disabled = new TtsrManager({ enabled: false });
		disabled.addRule(defaultExportRule());
		expect(await disabled.checkAstSnapshot(source, toolContext())).toEqual([]);
	});

	it("respects tool and path scope independently", async () => {
		const manager = new TtsrManager();
		const rule = defaultExportRule({ scope: ["tool:write(*.ts)"] });
		manager.addRule(rule);
		expect(await manager.checkAstSnapshot(source, toolContext("a.py"))).toEqual([]);
		expect(await manager.checkAstSnapshot(source, toolContext("a.ts", "edit"))).toEqual([]);
		expect(await manager.checkAstSnapshot(source, toolContext())).toEqual([rule]);
	});

	it("respects rule globs", async () => {
		const manager = new TtsrManager();
		const rule = defaultExportRule({ globs: ["src/**"] });
		manager.addRule(rule);
		expect(await manager.checkAstSnapshot(source, toolContext("lib/a.ts"))).toEqual([]);
		expect(await manager.checkAstSnapshot(source, toolContext("src/a.ts"))).toEqual([rule]);
	});

	it("honors once gating after injection", async () => {
		const manager = new TtsrManager();
		const rule = defaultExportRule();
		manager.addRule(rule);
		manager.markInjected([rule]);
		expect(await manager.checkAstSnapshot(source, toolContext())).toEqual([]);
	});

	it("honors after-gap gating", async () => {
		const manager = new TtsrManager({ repeatMode: "after-gap", repeatGap: 2 });
		const rule = defaultExportRule();
		manager.addRule(rule);
		manager.markInjected([rule]);
		manager.incrementMessageCount();
		expect(await manager.checkAstSnapshot(source, toolContext())).toEqual([]);
		manager.incrementMessageCount();
		expect(await manager.checkAstSnapshot(source, toolContext())).toEqual([rule]);
	});

	it("throttles identical snapshots per stream and clears the throttle on reset", async () => {
		const manager = new TtsrManager();
		const rule = defaultExportRule();
		manager.addRule(rule);
		expect(await manager.checkAstSnapshot(source, toolContext())).toEqual([rule]);
		expect(await manager.checkAstSnapshot(source, toolContext())).toEqual([]);
		expect(await manager.checkAstSnapshot(`${source}\n`, toolContext())).toEqual([rule]);
		expect(await manager.checkAstSnapshot(source, toolContext("b.ts", "write", "toolcall:write-2"))).toEqual([rule]);
		manager.resetBuffer();
		expect(await manager.checkAstSnapshot(source, toolContext())).toEqual([rule]);
	});

	it("ignores an aborted check without consuming the snapshot", async () => {
		const manager = new TtsrManager();
		const rule = defaultExportRule();
		manager.addRule(rule);
		const controller = new AbortController();
		controller.abort();
		expect(await manager.checkAstSnapshot(source, toolContext(), controller.signal)).toEqual([]);
		expect(await manager.checkAstSnapshot(source, toolContext())).toEqual([rule]);
	});
});

describe("TTSR astCondition in the AgentSession tool path", () => {
	let tempDir: string;
	let authStorage: AuthStorage;
	let modelRegistry: ModelRegistry;
	let session: AgentSession | undefined;

	beforeEach(async () => {
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "ttsr-ast-session-"));
		authStorage = await AuthStorage.create(path.join(tempDir, "auth.db"));
		authStorage.setRuntimeApiKey("anthropic", "test-key");
		modelRegistry = new ModelRegistry(authStorage);
	});

	afterEach(async () => {
		await session?.dispose();
		session = undefined;
		authStorage.close();
		fs.rmSync(tempDir, { recursive: true, force: true });
	});

	const RULE_CONTENT = "TTSR-AST-REMINDER: use named exports.";

	function defaultExportRule(partial: Partial<Rule> = {}): Rule {
		return makeRule({
			name: "named-exports",
			content: RULE_CONTENT,
			astCondition: ["export default $X"],
			...partial,
		});
	}

	function createToolSession(): ToolSession {
		return {
			cwd: tempDir,
			hasUI: false,
			enableLsp: false,
			settings: Settings.isolated(),
			getSessionFile: () => null,
			getSessionSpawns: () => "*",
			getArtifactsDir: () => null,
			getSessionId: () => null,
			getPlanModeState: () => undefined,
		} as unknown as ToolSession;
	}

	/** Each prompt consumes one scripted tool-call turn followed by a final text turn. */
	function createSession(
		sessionTools: Array<WriteTool | EditTool | AgentTool>,
		toolCallTurns: ToolCall[][],
		rules: Rule[],
		options: {
			interruptMode?: "always" | "never";
			streamToolArgs?: boolean;
			streamText?: string;
			toolInterruptPolicy?: "abort_tools" | "finish_tools";
		} = {},
	) {
		const tools = sessionTools.map(tool => tool as AgentTool);
		const model = getBundledModel("anthropic", "claude-sonnet-4-5")!;
		const ttsrManager = new TtsrManager({ interruptMode: options.interruptMode ?? "never", contextMode: "keep" });
		for (const rule of rules) ttsrManager.addRule(rule);
		let streamCalls = 0;
		const modelMessages: Message[][] = [];
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model, systemPrompt: ["Test"], tools, messages: [] },
			convertToLlm,
			streamFn: (_model, context) => {
				modelMessages.push(structuredClone(context.messages));
				const turn = streamCalls++;
				const stream = new AssistantMessageEventStream();
				queueMicrotask(() => {
					const calls = turn % 2 === 0 ? toolCallTurns[turn / 2] : undefined;
					// Prose is streamed only alongside the first scripted tool-call turn.
					const streamText = turn === 0 ? options.streamText : undefined;
					const message: AssistantMessage = {
						role: "assistant",
						content: calls
							? [...(streamText ? [{ type: "text" as const, text: streamText }] : []), ...calls]
							: [{ type: "text", text: "Done" }],
						api: model.api,
						provider: model.provider,
						model: model.id,
						usage: {
							input: 1,
							output: 1,
							cacheRead: 0,
							cacheWrite: 0,
							totalTokens: 2,
							cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
						},
						stopReason: calls ? "toolUse" : "stop",
						timestamp: Date.now(),
					};
					stream.push({ type: "start", partial: message });
					if (calls && streamText) {
						stream.push({ type: "text_delta", contentIndex: 0, delta: streamText, partial: message });
					}
					if (calls && options.streamToolArgs) {
						for (let index = 0; index < calls.length; index++) {
							stream.push({
								type: "toolcall_delta",
								contentIndex: index + (streamText ? 1 : 0),
								delta: JSON.stringify(calls[index].arguments),
								partial: message,
							});
						}
					}
					stream.push({ type: "done", reason: calls ? "toolUse" : "stop", message });
					stream.end();
				});
				return stream;
			},
		});
		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(tempDir),
			settings: Settings.isolated({
				"compaction.enabled": false,
				...(options.toolInterruptPolicy ? { toolInterruptPolicy: options.toolInterruptPolicy } : {}),
			}),
			ttsrManager,
			modelRegistry,
			toolRegistry: new Map(tools.map(tool => [tool.name, tool])),
		});
		const triggered: string[][] = [];
		session.subscribe(event => {
			if (event.type === "ttsr_triggered") triggered.push(event.rules.map(rule => rule.name));
		});
		return { session, ttsrManager, triggered, modelMessages };
	}

	function toolResultText(target: AgentSession, toolCallId: string): string {
		const result = target.agent.state.messages.find(
			(message): message is ToolResultMessage => message.role === "toolResult" && message.toolCallId === toolCallId,
		);
		if (!result) throw new Error(`missing tool result for ${toolCallId}`);
		return result.content.map(block => (block.type === "text" ? block.text : "")).join("\n");
	}

	function writeCall(id: string, fileName: string, content: string): ToolCall {
		return { type: "toolCall", id, name: "write", arguments: { path: path.join(tempDir, fileName), content } };
	}

	async function run(target: AgentSession, text: string): Promise<void> {
		await target.prompt(text);
		await target.waitForIdle();
	}

	function injectedNames(target: AgentSession): string[] {
		return target.sessionManager
			.getEntries()
			.flatMap(entry => (entry.type === "ttsr_injection" ? entry.injectedRules : []));
	}

	it.each([
		"always",
		"never",
	] as const)("settles AST rules before the real write executes (%s)", async interruptMode => {
		const { session, triggered, ttsrManager, modelMessages } = createSession(
			[new WriteTool(createToolSession())],
			[[writeCall("write-1", "a.ts", "const foo = 1;\nexport default foo;\n")]],
			[defaultExportRule({ scope: ["tool:write(*.ts)"] })],
			{ interruptMode },
		);
		await run(session, "write it");

		expect(triggered).toEqual([["named-exports"]]);
		expect(ttsrManager.getInjectedRuleNames()).toEqual(["named-exports"]);
		expect(injectedNames(session)).toEqual(["named-exports"]);
		expect(modelMessages).toHaveLength(2);
		expect(JSON.stringify(modelMessages[1])).toContain(RULE_CONTENT);
		const calls = modelMessages[1].flatMap(message =>
			message.role === "assistant"
				? message.content.filter(block => block.type === "toolCall").map(block => block.id)
				: [],
		);
		const results = modelMessages[1].filter(message => message.role === "toolResult");
		expect(calls).toEqual(["write-1"]);
		expect(results).toHaveLength(1);
		for (const id of calls) expect(results.filter(result => result.toolCallId === id)).toHaveLength(1);
		expect(fs.existsSync(path.join(tempDir, "a.ts"))).toBe(interruptMode === "never");
		if (interruptMode === "never") {
			expect(toolResultText(session, "write-1")).toContain(RULE_CONTENT);
			expect(await Bun.file(path.join(tempDir, "a.ts")).text()).toContain("export default foo;");
		} else {
			const aborted = session.agent.state.messages.find(
				message => message.role === "assistant" && message.stopReason === "aborted",
			);
			expect(aborted?.role === "assistant" ? aborted.errorMessage : undefined).toBe(
				"TTSR matched rule: named-exports",
			);
		}
	});

	it("leaves a non-matching write untouched", async () => {
		const { session, triggered, ttsrManager } = createSession(
			[new WriteTool(createToolSession())],
			[[writeCall("write-1", "a.ts", "export const foo = 1;\n")]],
			[defaultExportRule()],
		);
		await run(session, "write it");

		expect(triggered).toEqual([]);
		expect(toolResultText(session, "write-1")).not.toContain(RULE_CONTENT);
		expect(ttsrManager.getInjectedRuleNames()).toEqual([]);
	});

	it("does not re-trigger a once-mode rule on a second matching write", async () => {
		const { session, triggered } = createSession(
			[new WriteTool(createToolSession())],
			[[writeCall("write-1", "a.ts", "export default 1;\n")], [writeCall("write-2", "b.ts", "export default 2;\n")]],
			[defaultExportRule({ repeatMode: "once" })],
		);
		await run(session, "first");
		await run(session, "second");

		expect(triggered).toEqual([["named-exports"]]);
		expect(toolResultText(session, "write-1")).toContain(RULE_CONTENT);
		expect(toolResultText(session, "write-2")).not.toContain(RULE_CONTENT);
		expect(injectedNames(session)).toEqual(["named-exports"]);
	});

	it("matches only the added source of a replace-mode edit", async () => {
		const filePath = path.join(tempDir, "a.ts");
		fs.writeFileSync(filePath, "const foo = 1;\nexport { foo };\n");
		const { session, triggered } = createSession(
			[new EditTool(createToolSession(), "replace")],
			[
				[
					{
						type: "toolCall",
						id: "edit-1",
						name: "edit",
						arguments: {
							path: filePath,
							edits: [{ old_text: "export { foo };", new_text: "export default foo;" }],
						},
					},
				],
			],
			[defaultExportRule({ scope: ["tool:edit(*.ts)"] })],
		);
		await run(session, "edit it");

		expect(fs.readFileSync(filePath, "utf8")).toContain("export default foo;");
		expect(triggered).toEqual([["named-exports"]]);
		expect(toolResultText(session, "edit-1")).toContain(RULE_CONTENT);
		expect(injectedNames(session)).toEqual(["named-exports"]);
	});

	it("blocks a matching replace-mode edit without changing the file", async () => {
		const filePath = path.join(tempDir, "a.ts");
		const original = "export const foo = 1;\n";
		await Bun.write(filePath, original);
		const { session, modelMessages } = createSession(
			[new EditTool(createToolSession(), "replace")],
			[
				[
					{
						type: "toolCall",
						id: "edit-1",
						name: "edit",
						arguments: {
							path: filePath,
							edits: [{ old_text: "export const foo = 1;", new_text: "export default 1;" }],
						},
					},
				],
			],
			[defaultExportRule({ scope: ["tool:edit(*.ts)"] })],
			{ interruptMode: "always" },
		);
		await run(session, "edit it");
		expect(await Bun.file(filePath).text()).toBe(original);
		expect(JSON.stringify(modelMessages[1])).toContain(RULE_CONTENT);
		expect(
			modelMessages[1].filter(message => message.role === "toolResult" && message.toolCallId === "edit-1"),
		).toHaveLength(1);
		expect(injectedNames(session)).toEqual(["named-exports"]);
	});

	it("matches the introduced source of an apply_patch-mode edit", async () => {
		const { session, triggered } = createSession(
			[new EditTool(createToolSession(), "apply_patch")],
			[
				[
					{
						type: "toolCall",
						id: "patch-1",
						name: "edit",
						arguments: {
							input: [
								"*** Begin Patch",
								`*** Add File: ${path.join(tempDir, "added.ts")}`,
								"+export default 42;",
								"*** End Patch",
							].join("\n"),
						},
					},
				],
			],
			[defaultExportRule()],
		);
		await run(session, "patch it");

		expect(fs.existsSync(path.join(tempDir, "added.ts"))).toBe(true);
		expect(triggered).toEqual([["named-exports"]]);
		expect(toolResultText(session, "patch-1")).toContain(RULE_CONTENT);
	});

	it("does not match pre-existing code when an edit adds unrelated source", async () => {
		const filePath = path.join(tempDir, "a.ts");
		await Bun.write(filePath, "const foo = 1;\nexport default foo;\n");
		const { session, triggered, ttsrManager } = createSession(
			[new EditTool(createToolSession(), "replace")],
			[
				[
					{
						type: "toolCall",
						id: "edit-1",
						name: "edit",
						arguments: { path: filePath, edits: [{ old_text: "const foo = 1;", new_text: "const foo = 2;" }] },
					},
				],
			],
			[defaultExportRule()],
		);
		await run(session, "edit it");

		expect(await Bun.file(filePath).text()).toBe("const foo = 2;\nexport default foo;\n");
		expect(triggered).toEqual([]);
		expect(toolResultText(session, "edit-1")).not.toContain(RULE_CONTENT);
		expect(ttsrManager.getInjectedRuleNames()).toEqual([]);
	});

	it("keeps multi-file apply_patch digests isolated by path and language", async () => {
		const { session, triggered } = createSession(
			[new EditTool(createToolSession(), "apply_patch")],
			[
				[
					{
						type: "toolCall",
						id: "patch-1",
						name: "edit",
						arguments: {
							input: [
								"*** Begin Patch",
								`*** Add File: ${path.join(tempDir, "added.ts")}`,
								"+export const foo = 1;",
								`*** Add File: ${path.join(tempDir, "notes.md")}`,
								"+export default foo;",
								"*** End Patch",
							].join("\n"),
						},
					},
				],
			],
			[defaultExportRule({ scope: ["tool:edit(*.ts)"] })],
		);
		await run(session, "patch it");
		expect(await Bun.file(path.join(tempDir, "added.ts")).text()).toContain("export const foo = 1;");
		expect(await Bun.file(path.join(tempDir, "notes.md")).text()).toContain("export default foo;");
		expect(triggered).toEqual([]);
		expect(toolResultText(session, "patch-1")).not.toContain(RULE_CONTENT);
		expect(injectedNames(session)).toEqual([]);
	});

	it("injects a mixed regex and AST rule only once from streamed tool arguments", async () => {
		const { session, triggered } = createSession(
			[new WriteTool(createToolSession())],
			[[writeCall("write-1", "a.ts", "export default 1;\n")]],
			[defaultExportRule({ condition: ["export default"], repeatMode: "once" })],
			{ streamToolArgs: true },
		);
		await run(session, "write it");
		expect(triggered).toEqual([["named-exports"]]);
		expect(toolResultText(session, "write-1").split(RULE_CONTENT)).toHaveLength(2);
		expect(injectedNames(session)).toEqual(["named-exports"]);
	});

	it("does not re-inject a mixed rule already queued by prose matching", async () => {
		const { session, triggered, modelMessages } = createSession(
			[new WriteTool(createToolSession())],
			[[writeCall("write-1", "a.ts", "export default 1;\n")]],
			[defaultExportRule({ condition: ["regex-marker"], repeatMode: "once" })],
			{ streamText: "regex-marker" },
		);
		await run(session, "write it");
		expect(triggered).toHaveLength(0);
		expect(toolResultText(session, "write-1")).not.toContain(RULE_CONTENT);
		expect(JSON.stringify(modelMessages.at(-1))).toContain(RULE_CONTENT);
		expect(injectedNames(session)).toEqual(["named-exports"]);
	});

	it("matches a .scss write through the CSS grammar and blocks it under an always interrupt", async () => {
		const cssContent = "TTSR-CSS-REMINDER: use design tokens.";
		const { session, triggered, modelMessages } = createSession(
			[new WriteTool(createToolSession())],
			[[writeCall("write-1", "theme.scss", ".button { color: red; }\n")]],
			[makeRule({ name: "css-tokens", content: cssContent, astCondition: ["$P: $V;"] })],
			{ interruptMode: "always" },
		);
		await run(session, "write it");

		expect(triggered).toEqual([["css-tokens"]]);
		expect(fs.existsSync(path.join(tempDir, "theme.scss"))).toBe(false);
		expect(JSON.stringify(modelMessages[1])).toContain(cssContent);
	});

	it("allows a .scss write to proceed when its astCondition pattern is invalid", async () => {
		const warning = spyOn(logger, "warn").mockImplementation(() => {});
		try {
			const { session, triggered, ttsrManager } = createSession(
				[new WriteTool(createToolSession())],
				[[writeCall("write-1", "theme.scss", ".button { color: red; }\n")]],
				[makeRule({ name: "css-important", content: RULE_CONTENT, astCondition: ["$P: $V !important"] })],
				{ interruptMode: "always" },
			);
			await run(session, "write it");

			expect(fs.existsSync(path.join(tempDir, "theme.scss"))).toBe(true);
			expect(triggered).toEqual([]);
			expect(ttsrManager.getAstConditionDiagnostics()).toHaveLength(1);
			expect(
				warning.mock.calls.filter(
					([message]) => message === "TTSR astCondition pattern is invalid for target language",
				),
			).toHaveLength(1);
		} finally {
			warning.mockRestore();
		}
	});

	it.each([
		"materialized",
		"deferred",
	] as const)("blocks a matching write dispatched through a %s production tool facade", async state => {
		const toolSession = createToolSession();
		// The agent annotates advertised schemas in place; give this facade its own
		// copy so the shared builtin descriptor stays pristine for other tests.
		const builtin = BUILTIN_TOOL_DESCRIPTORS.write!;
		const descriptor = {
			...builtin,
			metadata: { ...builtin.metadata, parameters: cloneSchema(builtin.metadata.parameters) },
		};
		const facade =
			state === "materialized"
				? new LazyAgentTool(descriptor, new WriteTool(toolSession), undefined, toolSession)
				: new LazyAgentTool(descriptor, undefined, () => new WriteTool(toolSession), toolSession);
		const { session, triggered, modelMessages } = createSession(
			[facade],
			[[writeCall("write-1", "a.ts", "export default 1;\n")]],
			[defaultExportRule()],
			{ interruptMode: "always" },
		);
		await run(session, "write it");

		expect(triggered).toEqual([["named-exports"]]);
		expect(fs.existsSync(path.join(tempDir, "a.ts"))).toBe(false);
		expect(JSON.stringify(modelMessages[1])).toContain(RULE_CONTENT);
		expect(injectedNames(session)).toEqual(["named-exports"]);
	});

	it("evaluates an edit call that arrives under its apply_patch wire name", async () => {
		const { session, triggered, modelMessages } = createSession(
			[new EditTool(createToolSession(), "apply_patch")],
			[
				[
					{
						type: "toolCall",
						id: "patch-1",
						name: "apply_patch",
						arguments: {
							input: [
								"*** Begin Patch",
								`*** Add File: ${path.join(tempDir, "added.ts")}`,
								"+export default 42;",
								"*** End Patch",
							].join("\n"),
						},
					},
				],
			],
			[defaultExportRule()],
			{ interruptMode: "always" },
		);
		await run(session, "patch it");

		expect(triggered).toEqual([["named-exports"]]);
		expect(fs.existsSync(path.join(tempDir, "added.ts"))).toBe(false);
		const results = modelMessages[1].filter(message => message.role === "toolResult");
		expect(results.map(result => result.toolCallId)).toEqual(["patch-1"]);
		expect(JSON.stringify(modelMessages[1])).toContain(RULE_CONTENT);
	});

	it("carries a non-interrupting reminder of a blocked call into the retry injection", async () => {
		const regexContent = "TTSR-REGEX-REMINDER: marker seen.";
		const { session, modelMessages } = createSession(
			[new WriteTool(createToolSession())],
			[[writeCall("write-1", "a.ts", "// regex-only-marker\nexport default 1;\n")]],
			[
				makeRule({
					name: "regex-marker",
					content: regexContent,
					condition: ["regex-only-marker"],
					interruptMode: "never",
					repeatMode: "once",
				}),
				defaultExportRule({ repeatMode: "once" }),
			],
			{ interruptMode: "always", streamToolArgs: true },
		);
		await run(session, "write it");

		expect(fs.existsSync(path.join(tempDir, "a.ts"))).toBe(false);
		const retry = JSON.stringify(modelMessages[1]);
		expect(retry).toContain(RULE_CONTENT);
		expect(retry).toContain(regexContent);
		expect(injectedNames(session).sort()).toEqual(["named-exports", "regex-marker"]);
	});

	it("falls back to matcherDigest when matcherEntries is empty", async () => {
		const tool = Object.assign(new WriteTool(createToolSession()), { matcherEntries: () => [] });
		const { session, triggered } = createSession(
			[tool],
			[[writeCall("write-1", "a.ts", "export default 1;\n")]],
			[defaultExportRule()],
		);
		await run(session, "write it");

		expect(triggered).toEqual([["named-exports"]]);
		expect(toolResultText(session, "write-1")).toContain(RULE_CONTENT);
	});

	it("releases a non-interrupting claim when the user aborts the matched tool mid-execution", async () => {
		const started = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		let blockFirst = true;
		const slowWrite: AgentTool = {
			name: "write",
			label: "Write",
			description: "Slow write",
			parameters: new WriteTool(createToolSession()).parameters,
			matcherDigest: args => (args as { content?: string }).content,
			async execute() {
				if (blockFirst) {
					blockFirst = false;
					started.resolve();
					await release.promise;
				}
				return { content: [{ type: "text", text: "written" }] };
			},
		};
		const { session, ttsrManager } = createSession(
			[slowWrite],
			[[writeCall("write-1", "a.ts", "export default 1;\n")], [writeCall("write-2", "b.ts", "export default 2;\n")]],
			[defaultExportRule({ repeatMode: "once" })],
		);
		const firstRun = session.prompt("first");
		await started.promise;
		expect(ttsrManager.getInjectedRuleNames()).toEqual(["named-exports"]);
		await session.abort();
		release.resolve();
		await firstRun.catch(() => {});
		await session.waitForIdle();
		// The aborted run consumed only its tool-call turn; take the scripted text turn.
		await run(session, "nudge");

		// The aborted call never delivered its reminder: no claim, no record.
		expect(ttsrManager.getInjectedRuleNames()).toEqual([]);
		expect(injectedNames(session)).toEqual([]);

		await run(session, "second");
		expect(toolResultText(session, "write-2")).toContain(RULE_CONTENT);
		expect(injectedNames(session)).toEqual(["named-exports"]);
	});

	it("keeps a rule eligible after its queued prose reminder is dropped undelivered", async () => {
		const { session, ttsrManager } = createSession(
			[new WriteTool(createToolSession())],
			[
				[writeCall("write-1", "a.ts", "export const a = 1;\n")],
				[writeCall("write-2", "b.ts", "export default 2;\n")],
			],
			[defaultExportRule({ condition: ["regex-marker"], repeatMode: "once" })],
			{ streamText: "regex-marker" },
		);
		// The prose match queues a deferred reminder; drop it before delivery.
		session.subscribe(event => {
			if (event.type === "message_end" && event.message.role === "assistant") session.clearQueue();
		});
		await run(session, "first");
		expect(ttsrManager.getInjectedRuleNames()).toEqual([]);

		await run(session, "second");
		expect(toolResultText(session, "write-2")).toContain(RULE_CONTENT);
	});

	it("releases the claim of a sibling call skipped by steering before it ran", async () => {
		const started = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		let blockFirst = true;
		const slowWrite: AgentTool = {
			name: "write",
			label: "Write",
			description: "Slow write",
			parameters: new WriteTool(createToolSession()).parameters,
			concurrency: "exclusive",
			async execute() {
				if (blockFirst) {
					blockFirst = false;
					started.resolve();
					await release.promise;
				}
				return { content: [{ type: "text", text: "written" }] };
			},
		};
		const { session, ttsrManager } = createSession(
			[slowWrite],
			[
				[writeCall("write-1", "a.txt", "plain"), writeCall("write-2", "b.txt", "SIBLING-MARKER")],
				[writeCall("write-3", "c.txt", "SIBLING-MARKER again")],
			],
			[makeRule({ name: "sibling", content: RULE_CONTENT, condition: ["SIBLING-MARKER"], repeatMode: "once" })],
			{ streamToolArgs: true, toolInterruptPolicy: "abort_tools" },
		);
		const firstRun = session.prompt("first");
		await started.promise;
		// The streamed sibling arguments already bucketed and claimed the rule.
		expect(ttsrManager.getInjectedRuleNames()).toEqual(["sibling"]);
		await session.steer("change of plan");
		release.resolve();
		await firstRun.catch(() => {});
		await session.waitForIdle();

		const skipped = session.agent.state.messages.find(
			(message): message is ToolResultMessage => message.role === "toolResult" && message.toolCallId === "write-2",
		);
		expect(skipped).toBeDefined();
		expect(toolResultText(session, "write-2")).not.toContain(RULE_CONTENT);
		expect(injectedNames(session)).toEqual([]);
		expect(ttsrManager.getInjectedRuleNames()).toEqual([]);
	});

	it("does not commit a folded reminder whose result the loop discards", async () => {
		const { session, ttsrManager } = createSession(
			[new WriteTool(createToolSession())],
			[[writeCall("write-1", "a.ts", "export default 1;\n")]],
			[defaultExportRule({ repeatMode: "once" })],
		);
		// Abort after the session folded the reminder but before the loop
		// publishes the decorated result.
		const fold = session.agent.afterToolCall!;
		session.agent.afterToolCall = async (ctx, signal) => {
			const result = await fold(ctx, signal);
			void session.abort();
			await Bun.sleep(10);
			return result;
		};
		await session.prompt("write it").catch(() => {});
		await session.waitForIdle();

		expect(toolResultText(session, "write-1")).not.toContain(RULE_CONTENT);
		expect(injectedNames(session)).toEqual([]);
		expect(ttsrManager.getInjectedRuleNames()).toEqual([]);
	});

	it("commits a delivered fold synchronously when its result is published", async () => {
		const { session, ttsrManager } = createSession(
			[new WriteTool(createToolSession())],
			[[writeCall("write-1", "a.ts", "export default 1;\n")]],
			[defaultExportRule({ repeatMode: "once" })],
		);
		// An agent listener registered after the session runs right after the
		// session's synchronous entry: by then the delivery must be settled, so no
		// later async handling (spill, extensions, turn_end) can undo or reshape it.
		const observed: Array<{ injected: string[]; claimed: string[] }> = [];
		session.agent.subscribe(event => {
			if (event.type !== "message_end" || event.message.role !== "toolResult") return;
			observed.push({ injected: injectedNames(session), claimed: ttsrManager.getInjectedRuleNames() });
			// Simulate a later transform (e.g. an artifact spill preview) of the content.
			event.message.content = [{ type: "text", text: "[spilled]" }];
		});
		await run(session, "write it");

		expect(observed).toEqual([{ injected: ["named-exports"], claimed: ["named-exports"] }]);
		expect(injectedNames(session)).toEqual(["named-exports"]);
		expect(ttsrManager.getInjectedRuleNames()).toEqual(["named-exports"]);
	});

	it("keeps handling a published result when its injection record fails to persist", async () => {
		const { session, ttsrManager } = createSession(
			[new WriteTool(createToolSession())],
			[[writeCall("write-1", "a.ts", "export default 1;\n")]],
			[defaultExportRule({ repeatMode: "once" })],
		);
		const append = session.sessionManager.appendTtsrInjection.bind(session.sessionManager);
		let failures = 0;
		session.sessionManager.appendTtsrInjection = (
			ruleNames: string[],
			records?: TtsrInjectionRecord[],
			ttsrMessageCount?: number,
		) => {
			if (failures++ === 0) throw new Error("disk full");
			return append(ruleNames, records, ttsrMessageCount);
		};
		const delivered: string[] = [];
		session.subscribe(event => {
			if (event.type === "message_end" && event.message.role === "toolResult") {
				delivered.push(event.message.toolCallId);
			}
		});
		await run(session, "write it");

		// The session still persisted and delivered the reminder-bearing result.
		const persisted = session.sessionManager
			.getEntries()
			.flatMap(entry => (entry.type === "message" && entry.message.role === "toolResult" ? [entry.message] : []));
		expect(persisted.map(message => message.toolCallId)).toEqual(["write-1"]);
		expect(JSON.stringify(persisted[0]?.content)).toContain(RULE_CONTENT);
		expect(delivered).toEqual(["write-1"]);
		expect(failures).toBe(1);
		// The delivered reminder stays consumed even though its record was lost.
		expect(ttsrManager.getInjectedRuleNames()).toEqual(["named-exports"]);
	});

	it("carries a folded reminder into the retry when a sibling's interrupt replaces its result", async () => {
		const siblingContent = "TTSR-SIBLING-REMINDER: marker seen.";
		const slowFolded = Promise.withResolvers<void>();
		const interrupted = Promise.withResolvers<void>();
		const makeTool = (name: string): AgentTool => ({
			name,
			label: name,
			description: name,
			parameters: new WriteTool(createToolSession()).parameters,
			concurrency: "shared",
			nonAbortable: true,
			matcherDigest: args => (args as { content?: string }).content,
			async execute() {
				return { content: [{ type: "text", text: `${name} done` }] };
			},
		});
		const call = (id: string, name: string, file: string, content: string): ToolCall => ({
			type: "toolCall",
			id,
			name,
			arguments: { path: path.join(tempDir, file), content },
		});
		const { session, modelMessages } = createSession(
			[makeTool("slow"), makeTool("fast")],
			[[call("slow-1", "slow", "a.txt", "SIBLING-MARKER"), call("fast-1", "fast", "b.ts", "export default 1;\n")]],
			[
				makeRule({
					name: "sibling",
					content: siblingContent,
					condition: ["SIBLING-MARKER"],
					interruptMode: "never",
					repeatMode: "once",
				}),
				defaultExportRule({ interruptMode: "always", repeatMode: "once" }),
			],
			{ streamToolArgs: true },
		);
		// slow folds its reminder, then holds its result until fast's interrupt
		// has aborted the turn, so the loop publishes slow's aborted replacement.
		const fold = session.agent.afterToolCall!;
		session.agent.afterToolCall = async (ctx, signal) => {
			const result = await fold(ctx, signal);
			if (ctx.toolCall.id === "slow-1") {
				slowFolded.resolve();
				await interrupted.promise;
			}
			return result;
		};
		const before = session.agent.beforeToolCall!;
		session.agent.beforeToolCall = async (ctx, signal) => {
			if (ctx.toolCall.id === "fast-1") await slowFolded.promise;
			const result = await before(ctx, signal);
			if (ctx.toolCall.id === "fast-1") setTimeout(() => interrupted.resolve(), 5);
			return result;
		};
		await run(session, "go");

		expect(toolResultText(session, "slow-1")).not.toContain(siblingContent);
		const retry = JSON.stringify(modelMessages[1]);
		expect(retry).toContain(RULE_CONTENT);
		expect(retry).toContain(siblingContent);
		expect(injectedNames(session).sort()).toEqual(["named-exports", "sibling"]);
	});
});

describe("createAgentSession TTSR rule registration", () => {
	let tempDir: string;
	let authStorage: AuthStorage;
	let modelRegistry: ModelRegistry;

	beforeEach(async () => {
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "ttsr-ast-sdk-"));
		authStorage = await AuthStorage.create(path.join(tempDir, "auth.db"));
		authStorage.setRuntimeApiKey("anthropic", "test-key");
		modelRegistry = new ModelRegistry(authStorage, path.join(tempDir, "models.yml"));
	});

	afterEach(async () => {
		await modelRegistry.dispose();
		authStorage.close();
		fs.rmSync(tempDir, { recursive: true, force: true });
	});

	it("registers rules that only carry astCondition", async () => {
		const astOnly = makeRule({ name: "ast-only", description: "AST only", astCondition: ["export default $X"] });
		const { session } = await createAgentSession({
			cwd: tempDir,
			agentDir: tempDir,
			sessionManager: SessionManager.inMemory(tempDir),
			settings: Settings.isolated(),
			model: getBundledModel("anthropic", "claude-sonnet-4-5")!,
			modelRegistry,
			disableExtensionDiscovery: true,
			extensions: [],
			skills: [],
			contextFiles: [],
			promptTemplates: [],
			slashCommands: [],
			enableMCP: false,
			enableLsp: false,
			toolNames: [],
			rules: [astOnly],
		});
		try {
			expect(session.ttsrManager?.hasAstRules()).toBe(true);
			const filePath = path.join(tempDir, "a.ts");
			const matches = await session.ttsrManager!.checkAstSnapshot("export default 1;\n", {
				source: "tool",
				toolName: "write",
				filePaths: [filePath],
			});
			expect(matches.map(rule => rule.name)).toEqual(["ast-only"]);
		} finally {
			await session.dispose();
		}
	});
});
