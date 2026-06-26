import { describe, expect, test } from "bun:test";
import type { Model } from "@gajae-code/ai";
import {
	buildFastStatusReport,
	FAST_STATUS_OFF,
	FAST_STATUS_TITLE,
	type FastStatusSessionLike,
	formatFastStatusReport,
} from "@gajae-code/coding-agent/slash-commands/helpers/fast-status-report";

const ICON = "\u26a1";

function model(provider: string, id: string): Model {
	return { provider, id } as unknown as Model;
}

describe("formatFastStatusReport", () => {
	test("AC-5: formats a multiline active + role-model report with fast/off per row", () => {
		const report = formatFastStatusReport({
			rows: [
				{ label: "현재 모델", model: model("anthropic", "claude-sonnet-4-5"), fast: true },
				{ label: "DEFAULT", model: model("anthropic", "claude-sonnet-4-5"), fast: true },
				{ label: "EXECUTOR", model: model("openai", "gpt-5"), fast: false },
			],
			iconFast: ICON,
		});
		const lines = report.split("\n");
		expect(lines.length).toBeGreaterThan(1);
		expect(lines[0]).toBe(FAST_STATUS_TITLE);
		expect(report).toContain(`현재 모델: anthropic/claude-sonnet-4-5 ${ICON}`);
		expect(report).toContain(`DEFAULT: anthropic/claude-sonnet-4-5 ${ICON}`);
		expect(report).toContain(`EXECUTOR: openai/gpt-5 ${FAST_STATUS_OFF}`);
	});

	test("AC-2: renders fast on anthropic rows and off on openai/openai-codex rows", () => {
		const report = formatFastStatusReport({
			rows: [
				{ label: "현재 모델", model: model("anthropic", "claude-opus-4-1"), fast: true },
				{ label: "EXECUTOR", model: model("openai", "gpt-5"), fast: false },
				{ label: "ARCHITECT", model: model("openai-codex", "gpt-5-codex"), fast: false },
			],
			iconFast: ICON,
		});
		expect(report).toContain(`현재 모델: anthropic/claude-opus-4-1 ${ICON}`);
		expect(report).toContain(`EXECUTOR: openai/gpt-5 ${FAST_STATUS_OFF}`);
		expect(report).toContain(`ARCHITECT: openai-codex/gpt-5-codex ${FAST_STATUS_OFF}`);
		// Exactly one fast icon (the anthropic active row).
		expect(report.split(ICON).length - 1).toBe(1);
	});

	test("AC-3: all rows off renders no fast icon", () => {
		const report = formatFastStatusReport({
			rows: [
				{ label: "현재 모델", model: model("anthropic", "claude-sonnet-4-5"), fast: false },
				{ label: "EXECUTOR", model: model("openai", "gpt-5"), fast: false },
			],
			iconFast: ICON,
		});
		expect(report).not.toContain(ICON);
		expect(report).toContain(`현재 모델: anthropic/claude-sonnet-4-5 ${FAST_STATUS_OFF}`);
		expect(report).toContain(`EXECUTOR: openai/gpt-5 ${FAST_STATUS_OFF}`);
	});

	test("AC-6: each row's fast flag is rendered independently", () => {
		// Mirrors serviceTier="claude-only": the active OpenAI model is off even
		// though fast mode is globally "enabled", while the Anthropic role is on.
		const report = formatFastStatusReport({
			rows: [
				{ label: "현재 모델", model: model("openai", "gpt-5"), fast: false },
				{ label: "DEFAULT", model: model("anthropic", "claude-sonnet-4-5"), fast: true },
			],
			iconFast: ICON,
		});
		expect(report).toContain(`현재 모델: openai/gpt-5 ${FAST_STATUS_OFF}`);
		expect(report).toContain(`DEFAULT: anthropic/claude-sonnet-4-5 ${ICON}`);
	});

	test("AC-7: uses the supplied icon token, never a hardcoded emoji", () => {
		const report = formatFastStatusReport({
			rows: [{ label: "현재 모델", model: model("anthropic", "claude-sonnet-4-5"), fast: true }],
			iconFast: ">>",
		});
		expect(report).toContain("현재 모델: anthropic/claude-sonnet-4-5 >>");
		expect(report).not.toContain(ICON);
	});

	test("AC-8: every row off is all off", () => {
		const report = formatFastStatusReport({
			rows: [
				{ label: "현재 모델", model: model("anthropic", "claude-sonnet-4-5"), fast: false },
				{ label: "DEFAULT", model: model("anthropic", "claude-sonnet-4-5"), fast: false },
			],
			iconFast: ICON,
		});
		expect(report).not.toContain(ICON);
		expect(report.split("\n").every(line => line === FAST_STATUS_TITLE || line.endsWith(FAST_STATUS_OFF))).toBe(true);
	});

	test("applies the inactive formatter (e.g. TUI dim) to off rows only", () => {
		const report = formatFastStatusReport({
			rows: [
				{ label: "현재 모델", model: model("anthropic", "claude-sonnet-4-5"), fast: true },
				{ label: "EXECUTOR", model: model("openai", "gpt-5"), fast: false },
			],
			iconFast: ICON,
			formatInactive: text => `<dim>${text}</dim>`,
		});
		expect(report).toContain(`EXECUTOR: openai/gpt-5 <dim>${FAST_STATUS_OFF}</dim>`);
		expect(report).not.toContain(`<dim>${ICON}</dim>`);
	});
});

describe("buildFastStatusReport", () => {
	function fakeSession(args: {
		model?: Model;
		roles: Record<string, Model | undefined>;
		fastProviders: string[];
		subagentFastProviders?: string[];
		/** When set, drives `isFastModeActive()` (current-model EFFECTIVE state). */
		currentEffectiveFast?: boolean;
	}): FastStatusSessionLike {
		const subagentFastProviders = args.subagentFastProviders ?? args.fastProviders;
		return {
			model: args.model,
			isFastForProvider: provider => provider !== undefined && args.fastProviders.includes(provider),
			isFastForSubagentProvider: provider => provider !== undefined && subagentFastProviders.includes(provider),
			isFastModeActive:
				args.currentEffectiveFast === undefined ? undefined : () => args.currentEffectiveFast === true,
			resolveRoleModelWithThinking: role => ({ model: args.roles[role] }),
		};
	}

	test("lists the active model and assigned roles, skipping unassigned roles", () => {
		const report = buildFastStatusReport({
			session: fakeSession({
				model: model("anthropic", "claude-sonnet-4-5"),
				roles: { default: model("anthropic", "claude-sonnet-4-5"), executor: model("openai", "gpt-5") },
				fastProviders: ["anthropic"],
			}),
			roleTargets: [
				{ id: "default", label: "DEFAULT", isSubagentRole: false },
				{ id: "executor", label: "EXECUTOR", isSubagentRole: true },
				{ id: "architect", label: "ARCHITECT", isSubagentRole: true },
			],
			iconFast: ICON,
		});
		expect(report).toContain(`현재 모델: anthropic/claude-sonnet-4-5 ${ICON}`);
		expect(report).toContain(`DEFAULT: anthropic/claude-sonnet-4-5 ${ICON}`);
		expect(report).toContain(`EXECUTOR: openai/gpt-5 ${FAST_STATUS_OFF}`);
		// ARCHITECT is unassigned -> skipped entirely.
		expect(report).not.toContain("ARCHITECT");
	});

	test("renders the active row off when no model is selected", () => {
		const report = buildFastStatusReport({
			session: fakeSession({ model: undefined, roles: {}, fastProviders: ["anthropic"] }),
			roleTargets: [{ id: "default", label: "DEFAULT", isSubagentRole: false }],
			iconFast: ICON,
		});
		expect(report).toContain(`현재 모델: ${FAST_STATUS_OFF}`);
		expect(report).not.toContain(ICON);
	});

	test("subagent roles use the subagent tier, not the main session tier", () => {
		// Regression for #691 round-2 blocker: serviceTier=priority but
		// task.serviceTier=none — the main-session rows are fast while the
		// task.agentModelOverrides subagent role runs without fast mode.
		const report = buildFastStatusReport({
			session: fakeSession({
				model: model("anthropic", "claude-sonnet-4-5"),
				roles: {
					default: model("anthropic", "claude-sonnet-4-5"),
					executor: model("anthropic", "claude-opus-4-1"),
				},
				fastProviders: ["anthropic", "openai", "openai-codex"],
				subagentFastProviders: [],
			}),
			roleTargets: [
				{ id: "default", label: "DEFAULT", isSubagentRole: false },
				{ id: "executor", label: "EXECUTOR", isSubagentRole: true },
			],
			iconFast: ICON,
		});
		// Main session is fast (current + modelRoles DEFAULT)...
		expect(report).toContain(`현재 모델: anthropic/claude-sonnet-4-5 ${ICON}`);
		expect(report).toContain(`DEFAULT: anthropic/claude-sonnet-4-5 ${ICON}`);
		// ...but the subagent role is off despite the same provider.
		expect(report).toContain(`EXECUTOR: anthropic/claude-opus-4-1 ${FAST_STATUS_OFF}`);
	});

	test("subagent roles can be fast while the main session is off", () => {
		// Reverse divergence: serviceTier=none but task.serviceTier=priority.
		const report = buildFastStatusReport({
			session: fakeSession({
				model: model("anthropic", "claude-sonnet-4-5"),
				roles: { executor: model("anthropic", "claude-opus-4-1") },
				fastProviders: [],
				subagentFastProviders: ["anthropic"],
			}),
			roleTargets: [{ id: "executor", label: "EXECUTOR", isSubagentRole: true }],
			iconFast: ICON,
		});
		expect(report).toContain(`현재 모델: anthropic/claude-sonnet-4-5 ${FAST_STATUS_OFF}`);
		expect(report).toContain(`EXECUTOR: anthropic/claude-opus-4-1 ${ICON}`);
	});

	test("current row reflects EFFECTIVE state (off after Q1 auto-disable) while subagent stays on", () => {
		// Paired display/executor parity: after a provider fast-mode auto-disable
		// the current model's intent is still priority, but the current row shows
		// off (effective) while an inheriting subagent role stays on.
		const report = buildFastStatusReport({
			session: fakeSession({
				model: model("anthropic", "claude-sonnet-4-5"),
				roles: { executor: model("anthropic", "claude-opus-4-1") },
				fastProviders: ["anthropic"], // intent still grants fast
				subagentFastProviders: ["anthropic"], // subagent inherits intent
				currentEffectiveFast: false, // ...but the current model was auto-disabled
			}),
			roleTargets: [{ id: "executor", label: "EXECUTOR", isSubagentRole: true }],
			iconFast: ICON,
		});
		expect(report).toContain(`현재 모델: anthropic/claude-sonnet-4-5 ${FAST_STATUS_OFF}`);
		expect(report).toContain(`EXECUTOR: anthropic/claude-opus-4-1 ${ICON}`);
	});
});
