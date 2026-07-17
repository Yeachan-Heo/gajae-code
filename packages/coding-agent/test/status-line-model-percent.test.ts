import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { ThinkingLevel } from "@gajae-code/agent-core";
import { resetSettingsForTest, Settings } from "../src/config/settings";
import { renderSegment, type SegmentContext } from "../src/modes/components/status-line/segments";
import { EMPTY_JOBS_SNAPSHOT } from "../src/modes/jobs-observer";
import { initTheme } from "../src/modes/theme/theme";

function makeCtx(overrides: Partial<SegmentContext> = {}): SegmentContext {
	return {
		session: {
			state: {
				model: { id: "sonnet", name: "Sonnet", thinking: true, contextWindow: 200_000 },
				thinkingLevel: ThinkingLevel.High,
			},
			isFastModeActive: () => false,
		} as unknown as SegmentContext["session"],
		width: 120,
		options: {},
		planMode: null,
		goalMode: null,
		usageStats: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			premiumRequests: 0,
			cost: 0,
			tokensPerSecond: null,
		},
		contextPercent: 0,
		contextWindow: 0,
		autoCompactEnabled: false,
		subagentCount: 0,
		jobs: EMPTY_JOBS_SNAPSHOT,
		sessionStartTime: Date.now(),
		git: { branch: null, status: null, pr: null },
		usage: null,
		...overrides,
	};
}

beforeAll(async () => {
	await initTheme();
	await Settings.init({ inMemory: true, cwd: process.cwd() });
});
afterAll(() => {
	resetSettingsForTest();
});

describe("model segment inline context percentage", () => {
	it("renders the token percentage right after the model / reasoning effort", () => {
		const ctx = makeCtx({ contextPercent: 42.5, contextWindow: 200_000 });
		const rendered = Bun.stripANSI(renderSegment("model", ctx).content);

		// Percentage appears, and after the model name + reasoning effort.
		expect(rendered).toContain("42.5%");
		expect(rendered).toMatch(/Sonnet.*42\.5%/);
	});

	it("omits the percentage when contextWindow is unknown", () => {
		const ctx = makeCtx({ contextPercent: 42.5, contextWindow: 0 });
		const rendered = Bun.stripANSI(renderSegment("model", ctx).content);

		expect(rendered).not.toContain("%");
		expect(rendered).toContain("Sonnet");
	});

	it("renders an unknown provider context snapshot as a question mark", () => {
		const ctx = makeCtx({ contextPercent: null, contextWindow: 200_000 });
		const model = Bun.stripANSI(renderSegment("model", ctx).content);
		const contextPct = Bun.stripANSI(renderSegment("context_pct", ctx).content);

		expect(model).toContain("?");
		expect(contextPct).toContain("?/200K");
	});

	it("can be disabled with segmentOptions.model.showContextPercent: false", () => {
		const ctx = makeCtx({
			contextPercent: 42.5,
			contextWindow: 200_000,
			options: { model: { showContextPercent: false } },
		});
		const rendered = Bun.stripANSI(renderSegment("model", ctx).content);

		expect(rendered).not.toContain("42.5%");
		expect(rendered).toContain("Sonnet");
	});
	it("suppresses the inline percentage when a standalone context_pct segment is active", () => {
		const ctx = makeCtx({
			contextPercent: 42.5,
			contextWindow: 200_000,
			contextPctSegmentActive: true,
		});
		const rendered = Bun.stripANSI(renderSegment("model", ctx).content);

		// Avoids showing the same percentage twice in custom layouts that keep
		// both the model segment and a standalone context_pct segment.
		expect(rendered).not.toContain("42.5%");
		expect(rendered).toContain("Sonnet");
	});

	it("still shows the percentage when the reasoning effort is off", () => {
		const ctx = makeCtx({
			contextPercent: 7.3,
			contextWindow: 200_000,
			session: {
				state: {
					model: { id: "sonnet", name: "Sonnet", thinking: true, contextWindow: 200_000 },
					thinkingLevel: ThinkingLevel.Off,
				},
				isFastModeActive: () => false,
			} as unknown as SegmentContext["session"],
		});
		const rendered = Bun.stripANSI(renderSegment("model", ctx).content);

		expect(rendered).toContain("7.3%");
		expect(rendered).toMatch(/Sonnet.*7\.3%/);
	});
});
