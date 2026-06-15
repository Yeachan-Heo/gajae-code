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
				{ label: "현재 모델", model: model("anthropic", "claude-sonnet-4-5") },
				{ label: "DEFAULT", model: model("anthropic", "claude-sonnet-4-5") },
				{ label: "EXECUTOR", model: model("openai", "gpt-5") },
			],
			isFastForProvider: provider => provider === "anthropic",
			iconFast: ICON,
		});
		const lines = report.split("\n");
		expect(lines.length).toBeGreaterThan(1);
		expect(lines[0]).toBe(FAST_STATUS_TITLE);
		expect(report).toContain(`현재 모델: anthropic/claude-sonnet-4-5 ${ICON}`);
		expect(report).toContain(`DEFAULT: anthropic/claude-sonnet-4-5 ${ICON}`);
		expect(report).toContain(`EXECUTOR: openai/gpt-5 ${FAST_STATUS_OFF}`);
	});

	test("AC-2: claude-only marks anthropic rows fast and openai/openai-codex rows off", () => {
		const report = formatFastStatusReport({
			rows: [
				{ label: "현재 모델", model: model("anthropic", "claude-opus-4-1") },
				{ label: "EXECUTOR", model: model("openai", "gpt-5") },
				{ label: "ARCHITECT", model: model("openai-codex", "gpt-5-codex") },
			],
			isFastForProvider: provider => provider === "anthropic",
			iconFast: ICON,
		});
		expect(report).toContain(`현재 모델: anthropic/claude-opus-4-1 ${ICON}`);
		expect(report).toContain(`EXECUTOR: openai/gpt-5 ${FAST_STATUS_OFF}`);
		expect(report).toContain(`ARCHITECT: openai-codex/gpt-5-codex ${FAST_STATUS_OFF}`);
		// Exactly one fast icon (the anthropic active row).
		expect(report.split(ICON).length - 1).toBe(1);
	});

	test("AC-3: none tier marks every row off and renders no fast icon", () => {
		const report = formatFastStatusReport({
			rows: [
				{ label: "현재 모델", model: model("anthropic", "claude-sonnet-4-5") },
				{ label: "EXECUTOR", model: model("openai", "gpt-5") },
			],
			isFastForProvider: () => false,
			iconFast: ICON,
		});
		expect(report).not.toContain(ICON);
		expect(report).toContain(`현재 모델: anthropic/claude-sonnet-4-5 ${FAST_STATUS_OFF}`);
		expect(report).toContain(`EXECUTOR: openai/gpt-5 ${FAST_STATUS_OFF}`);
	});

	test("AC-6: predicate (not a global on/off flag) drives each row independently", () => {
		// Mirrors serviceTier="claude-only": the active OpenAI model is off even
		// though fast mode is globally "enabled", while the Anthropic role is on.
		const report = formatFastStatusReport({
			rows: [
				{ label: "현재 모델", model: model("openai", "gpt-5") },
				{ label: "DEFAULT", model: model("anthropic", "claude-sonnet-4-5") },
			],
			isFastForProvider: provider => provider === "anthropic",
			iconFast: ICON,
		});
		expect(report).toContain(`현재 모델: openai/gpt-5 ${FAST_STATUS_OFF}`);
		expect(report).toContain(`DEFAULT: anthropic/claude-sonnet-4-5 ${ICON}`);
	});

	test("AC-7: uses the supplied icon token, never a hardcoded emoji", () => {
		const report = formatFastStatusReport({
			rows: [{ label: "현재 모델", model: model("anthropic", "claude-sonnet-4-5") }],
			isFastForProvider: () => true,
			iconFast: ">>",
		});
		expect(report).toContain("현재 모델: anthropic/claude-sonnet-4-5 >>");
		expect(report).not.toContain(ICON);
	});

	test("AC-8: unset service tier (predicate false everywhere) is all off", () => {
		const report = formatFastStatusReport({
			rows: [
				{ label: "현재 모델", model: model("anthropic", "claude-sonnet-4-5") },
				{ label: "DEFAULT", model: model("anthropic", "claude-sonnet-4-5") },
			],
			isFastForProvider: () => false,
			iconFast: ICON,
		});
		expect(report).not.toContain(ICON);
		expect(report.split("\n").every(line => line === FAST_STATUS_TITLE || line.endsWith(FAST_STATUS_OFF))).toBe(true);
	});

	test("applies the inactive formatter (e.g. TUI dim) to off rows only", () => {
		const report = formatFastStatusReport({
			rows: [
				{ label: "현재 모델", model: model("anthropic", "claude-sonnet-4-5") },
				{ label: "EXECUTOR", model: model("openai", "gpt-5") },
			],
			isFastForProvider: provider => provider === "anthropic",
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
	}): FastStatusSessionLike {
		return {
			model: args.model,
			isFastForProvider: provider => provider !== undefined && args.fastProviders.includes(provider),
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
				{ id: "default", label: "DEFAULT" },
				{ id: "executor", label: "EXECUTOR" },
				{ id: "architect", label: "ARCHITECT" },
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
			roleTargets: [{ id: "default", label: "DEFAULT" }],
			iconFast: ICON,
		});
		expect(report).toContain(`현재 모델: ${FAST_STATUS_OFF}`);
		expect(report).not.toContain(ICON);
	});
});
