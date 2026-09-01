import { beforeAll, describe, expect, it } from "bun:test";
import { visibleWidth } from "@gajae-code/tui";
import { resetSettingsForTest, Settings } from "../src/config/settings";
import { shortenModelId } from "../src/modes/components/status-line/model-name";
import { StatusLineComponent } from "../src/modes/components/tool-status-header";
import { initTheme } from "../src/modes/theme/theme";

/**
 * Adversarial coverage for the narrow-width priority row: hostile model ids,
 * impossible context numbers, and widths the layout is never supposed to see.
 * The rail must stay inside its width, stay single-line, and never crash.
 */

const strip = (value: string): string => Bun.stripANSI(value);

interface Hostile {
	modelId?: unknown;
	percent?: unknown;
	contextWindow?: unknown;
	goalStatus?: unknown;
}

function buildRail(hostile: Hostile = {}): StatusLineComponent {
	const contextWindow = "contextWindow" in hostile ? hostile.contextWindow : 200_000;
	const component = new StatusLineComponent(
		{
			state: {
				messages: [],
				model: { id: "modelId" in hostile ? hostile.modelId : "anthropic/claude-sonnet-4-5", contextWindow },
			},
			isStreaming: false,
			getAsyncJobSnapshot: () => ({ running: [] }),
			isFastModeActive: () => false,
			getContextUsage: () => ({ percent: "percent" in hostile ? hostile.percent : 42.5, contextWindow }),
			getGoalModeState: () => ({ goal: { status: hostile.goalStatus ?? "active", tokensUsed: 1 } }),
			settings: { get: () => false },
			modelRegistry: { isUsingOAuth: () => false },
			sessionManager: {
				getSessionName: () => "RedTeam",
				getUsageStatistics: () => ({
					input: 1,
					output: 1,
					cacheRead: 0,
					cacheWrite: 0,
					premiumRequests: 0,
					cost: 1,
				}),
			},
		} as unknown as ConstructorParameters<typeof StatusLineComponent>[0],
		{ version: "9.9.9" },
	);
	component.updateSettings({
		preset: "custom",
		leftSegments: ["model", "mode", "git", "path"],
		rightSegments: ["session_name", "cost"],
		separator: "slash",
		showSkillHud: false,
		showActionHints: false,
		sessionAccent: false,
		maxRows: 1,
	});
	component.setGoalModeStatus({ enabled: true, paused: false });
	return component;
}

beforeAll(async () => {
	resetSettingsForTest();
	await Settings.init({ inMemory: true });
	await initTheme();
});

describe("status rail narrow-width red team", () => {
	it.each([
		["control characters", "anthropic/claude\u0007-sonnet\u001b[31m-4-5"],
		["newline injection", "anthropic/claude\n-sonnet-4-5"],
		["1000-character id", `anthropic/${"x".repeat(1000)}`],
		["separators only", "///"],
		["dashes only", "----"],
		["wide east-asian id", "provider/모델-이름-4-5"],
		["emoji id", "provider/🦞-4-5"],
		["date-only id", "20250929"],
	])("keeps every row inside the width for a %s model id", (_label, modelId) => {
		for (const width of [0, 1, 2, 3, 4, 8, 16, 32, 64]) {
			const rows = buildRail({ modelId }).render(width);
			for (const row of rows) {
				expect(visibleWidth(row)).toBeLessThanOrEqual(width);
				expect(row).not.toContain("\n");
			}
		}
	});

	it.each([
		["NaN", Number.NaN],
		["Infinity", Number.POSITIVE_INFINITY],
		["negative", -12.5],
		["over 100", 4_242.9],
		["null", null],
		["string", "42"],
	])("survives a %s context percentage", (_label, percent) => {
		for (const width of [4, 10, 24, 40]) {
			const rows = buildRail({ percent }).render(width);
			for (const row of rows) expect(visibleWidth(row)).toBeLessThanOrEqual(width);
			// Something always renders: the rail never goes blank at these widths.
			expect(strip(rows.join("")).length).toBeGreaterThan(0);
		}
	});

	it.each([
		["zero", 0],
		["negative", -1],
		["NaN", Number.NaN],
	])("falls back to the ordinary rail for a %s context window", (_label, contextWindow) => {
		for (const width of [1, 4, 12, 40]) {
			const rows = buildRail({ contextWindow }).render(width);
			for (const row of rows) expect(visibleWidth(row)).toBeLessThanOrEqual(width);
		}
	});

	it("survives an unknown goal status", () => {
		for (const width of [4, 12, 30]) {
			const rows = buildRail({ goalStatus: "totally-unknown" }).render(width);
			for (const row of rows) expect(visibleWidth(row)).toBeLessThanOrEqual(width);
			expect(strip(rows.join("")).length).toBeGreaterThan(0);
		}
	});

	it("never emits an empty or whitespace-only label from the shortening heuristic", () => {
		const hostile = [
			"",
			" ",
			"/",
			"///",
			"-",
			"----",
			"claude-",
			"-20250929",
			"20250929",
			"a/b/c/",
			"\u0000",
			"🦞",
			"claude-\u0007",
			`${"y".repeat(500)}-20250101`,
		];
		for (const id of hostile) {
			const label = shortenModelId(id);
			expect(label.length).toBeGreaterThan(0);
			expect(label.trim().length).toBeGreaterThan(0);
		}
	});

	it("is deterministic: the same inputs render byte-identical rows", () => {
		for (const width of [4, 12, 24, 40]) {
			expect(buildRail().render(width)).toEqual(buildRail().render(width));
		}
	});
});
