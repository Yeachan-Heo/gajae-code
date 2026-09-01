import { beforeAll, describe, expect, it } from "bun:test";
import { visibleWidth } from "@gajae-code/tui";
import { resetSettingsForTest, Settings } from "../src/config/settings";
import { FooterComponent } from "../src/modes/components/footer";
import { shortenModelId } from "../src/modes/components/status-line/model-name";
import { StatusLineComponent } from "../src/modes/components/tool-status-header";
import { initTheme, theme } from "../src/modes/theme/theme";
import type { AgentSession } from "../src/session/agent-session";

const CONTEXT_WINDOW = 200_000;
const MODEL_ID = "anthropic/claude-sonnet-4-5-20250929";

const strip = (value: string): string => Bun.stripANSI(value);

interface SessionOverrides {
	percent?: number | null;
	goalStatus?: "active" | "paused" | "complete" | "dropped";
	modelId?: string;
}

function createSession(overrides: SessionOverrides = {}) {
	const percent = overrides.percent === undefined ? 18.3 : overrides.percent;
	return {
		state: {
			messages: [],
			model: { id: overrides.modelId ?? MODEL_ID, contextWindow: CONTEXT_WINDOW },
		},
		isStreaming: false,
		getAsyncJobSnapshot: () => ({ running: [] }),
		getCurrentModel: () => undefined,
		isFastModeEnabled: () => false,
		isFastModeActive: () => false,
		getContextUsage: () => ({ percent, contextWindow: CONTEXT_WINDOW }),
		getGoalModeState: () => ({ goal: { status: overrides.goalStatus ?? "active", tokensUsed: 12_345 } }),
		settings: { get: () => false },
		modelRegistry: { isUsingOAuth: () => false },
		sessionManager: {
			getSessionName: () => "MinWidth",
			getUsageStatistics: () => ({
				input: 1000,
				output: 500,
				cacheRead: 0,
				cacheWrite: 0,
				premiumRequests: 0,
				cost: 0.5,
			}),
		},
	} as unknown as ConstructorParameters<typeof StatusLineComponent>[0];
}

/** Default-preset-shaped rail: context % rides inside `model`, goal rides in `mode`. */
function buildRail(overrides: SessionOverrides = {}, goalActive = true): StatusLineComponent {
	const component = new StatusLineComponent(createSession(overrides), { version: "9.9.9" });
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
	component.setGoalModeStatus(goalActive ? { enabled: true, paused: false } : undefined);
	return component;
}

const CONTEXT_TOKEN = /\d+(?:\.\d+)?%/;

beforeAll(async () => {
	resetSettingsForTest();
	await Settings.init({ inMemory: true });
	await initTheme();
});

describe("shortenModelId", () => {
	it.each([
		["anthropic/claude-sonnet-4-5-20250929", "sonnet-4.5"],
		["claude-opus-4-1-20250805", "opus-4.1"],
		["openai/gpt-4o-2024-05-13", "gpt-4o"],
		["gpt-5.1-codex", "gpt-5.1-codex"],
		["google/gemini-3-pro", "gemini-3-pro"],
		["openrouter/anthropic/claude-haiku-4-5", "haiku-4.5"],
		["qwen2.5:7b", "qwen2.5:7b"],
		["llama3", "llama3"],
		// Dashed size/variant tokens are not version parts and must survive intact.
		["meta/llama-3-8b-instruct", "llama-3-8b-instruct"],
		["llama-3-70b", "llama-3-70b"],
		["qwen-2-5-7b-instruct", "qwen-2.5-7b-instruct"],
		["claude-3-5-haiku-20241022", "3.5-haiku"],
	])("shortens %s to %s", (input, expected) => {
		expect(shortenModelId(input)).toBe(expected);
	});

	it.each([
		"",
		"   ",
		"20250929",
		"anthropic/",
		"claude-",
		"-20250929",
	])("never returns an empty label for %p", input => {
		expect(shortenModelId(input).length).toBeGreaterThan(0);
	});

	it("falls back to a stable label when the id is missing", () => {
		expect(shortenModelId(undefined)).toBe("no-model");
		expect(shortenModelId(null)).toBe("no-model");
	});
});

describe("status rail survives very small widths", () => {
	it("keeps a context percentage at every width from 4 to 120", () => {
		for (let width = 4; width <= 120; width += 1) {
			const rendered = buildRail().render(width);
			const text = strip(rendered.join(" "));

			expect({ width, text }).toMatchObject({ text: expect.stringMatching(CONTEXT_TOKEN) });
			for (const row of rendered) expect(visibleWidth(row)).toBeLessThanOrEqual(width);
		}
	});

	it("never drops the model before the goal, nor the goal before the context", () => {
		const goalGlyph = theme.icon.goal || "G";
		const modelName = shortenModelId(MODEL_ID);

		for (let width = 4; width <= 120; width += 1) {
			const text = strip(buildRail().render(width).join(" "));
			const hasContext = CONTEXT_TOKEN.test(text);
			const hasGoal = text.includes(goalGlyph) || text.includes("Goal");
			const hasModel = text.includes(modelName);

			// Priority order is an invariant of every width, not just the narrow end.
			expect({ width, ok: hasContext || !hasGoal }).toEqual({ width, ok: true });
			expect({ width, ok: hasGoal || !hasModel }).toEqual({ width, ok: true });
		}
	});

	it("suppresses the overflow marker once the rail is narrow", () => {
		for (let width = 4; width <= 30; width += 1) {
			expect(strip(buildRail().render(width).join(" "))).not.toContain("…+");
		}
	});

	it("keeps the context window while it fits and falls back to an integer percentage", () => {
		const wide = strip(buildRail().render(28).join(" "));
		const narrow = strip(buildRail().render(5).join(" "));

		expect(wide).toContain("18.3%/200K");
		expect(narrow).toBe("18%");
	});

	it("renders exact rows at representative widths", () => {
		const goalGlyph = theme.icon.goal || "G";
		const goalLabel = theme.icon.goal ? `${theme.icon.goal} Goal` : "Goal";
		const modelGlyph = theme.icon.model || "s";

		expect(strip(buildRail().render(4)[0])).toBe("18%");
		expect(strip(buildRail().render(12)[0])).toBe(`18%·${goalGlyph}·${modelGlyph}`);
		expect(strip(buildRail().render(24)[0])).toBe(`18.3%/200K·${goalGlyph}·sonnet-4.5`);
		expect(strip(buildRail().render(30)[0])).toBe(`18.3%/200K·${goalLabel}·sonnet-4.5`);
		// Wide enough for the normal rail: the priority row must not hijack it.
		const wide = strip(buildRail().render(80)[0]);
		expect(wide).toContain("sonnet-4.5");
		expect(wide).toContain("Goal");
		// Segment chrome (spaced separators) proves this is the normal rail rather
		// than the compact priority row, whose separators carry no spaces.
		expect(wide).toContain(" / ");
	});

	it("keeps the goal glyph in its status color", () => {
		const pausedRow = buildRail({ goalStatus: "paused" }).render(12)[0];
		const activeRow = buildRail({ goalStatus: "active" }).render(12)[0];

		expect(pausedRow).toContain(theme.getFgAnsi("warning"));
		expect(pausedRow).not.toEqual(activeRow);
	});

	it.each(["complete", "dropped"] as const)("keeps a %s goal distinguishable in glyph form", goalStatus => {
		const row = buildRail({ goalStatus }).render(12)[0];
		const active = buildRail({ goalStatus: "active" }).render(12)[0];

		expect(strip(row).length).toBeGreaterThan(0);
		expect(row).not.toEqual(active);
	});

	it("keeps a wrapped rail wrapped when only ordinary telemetry is lost", () => {
		const component = buildRail();
		component.updateSettings({ maxRows: 3 });

		// Wide enough that wrapping still carries context %, goal and model across
		// its rows: the priority row must not replace a rail that kept them.
		const rows = component.render(44);
		const text = strip(rows.join(" "));

		expect(rows.length).toBeGreaterThan(1);
		expect(text).toContain("sonnet-4.5");
		expect(text).toContain("Goal");
		expect(text).toMatch(CONTEXT_TOKEN);
	});

	it("falls back to the priority row when wrapping itself loses a priority item", () => {
		const component = buildRail();
		component.updateSettings({ maxRows: 3 });

		const rows = component.render(10);

		expect(rows).toHaveLength(1);
		expect(strip(rows[0])).not.toContain("…+");
		expect(strip(rows[0])).toMatch(CONTEXT_TOKEN);
	});

	it("still shows an unknown context percentage rather than nothing", () => {
		const row = strip(buildRail({ percent: null }).render(10).join(" "));
		expect(row.startsWith("?")).toBe(true);
	});

	it("leaves the rail to the normal overflow marker when there is no context or goal", () => {
		const component = new StatusLineComponent(
			{
				state: { messages: [] },
				isStreaming: false,
				getAsyncJobSnapshot: () => ({ running: [] }),
				isFastModeActive: () => false,
				modelRegistry: { isUsingOAuth: () => false },
				sessionManager: {
					getSessionName: () => "NoCtx",
					getUsageStatistics: () => ({
						input: 0,
						output: 0,
						cacheRead: 0,
						cacheWrite: 0,
						premiumRequests: 0,
						cost: 0,
					}),
				},
			} as unknown as ConstructorParameters<typeof StatusLineComponent>[0],
			{ version: "9.9.9" },
		);
		component.updateSettings({
			preset: "custom",
			leftSegments: ["gajae", "session"],
			rightSegments: ["session_name", "time"],
			separator: "pipe",
			showSkillHud: false,
			showActionHints: false,
			sessionAccent: false,
			maxRows: 1,
		});

		expect(strip(component.render(3)[0])).toContain("…");
	});
});

describe("footer model name", () => {
	it("renders the shortened model name instead of the raw id", () => {
		const footer = new FooterComponent(createSession() as unknown as AgentSession);
		const text = footer.render(120).map(strip).join("\n");

		expect(text).toContain("sonnet-4.5");
		expect(text).not.toContain(MODEL_ID);
	});
});
