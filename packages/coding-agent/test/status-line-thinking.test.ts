import { beforeAll, describe, expect, it } from "bun:test";
import { ThinkingLevel } from "@gajae-code/agent-core";
import type { SegmentContext } from "../src/modes/components/status-line/segments";
import { renderSegment } from "../src/modes/components/status-line/segments";
import { EMPTY_JOBS_SNAPSHOT } from "../src/modes/jobs-observer";
import { initTheme, theme } from "../src/modes/theme/theme";

function createCtx(thinkingLevel: ThinkingLevel): SegmentContext {
	return {
		session: {
			state: {
				model: { id: "claude-opus-4-5", name: "Claude Opus 4.5", thinking: true },
				thinkingLevel,
			},
			isFastModeActive: () => false,
		} as unknown as SegmentContext["session"],
		width: 120,
		options: { model: { showThinkingLevel: true } },
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
	};
}

beforeAll(async () => {
	await initTheme();
});
describe("status line thinking indicator", () => {
	it("renders max reasoning with a dedicated theme label", () => {
		const rendered = renderSegment("model", createCtx(ThinkingLevel.Max));

		expect(rendered.visible).toBe(true);
		expect(rendered.content).toContain("Opus 4.5");
		expect(rendered.content).toContain(theme.thinking.max);
	});

	it("renders ultra reasoning with a dedicated theme label", () => {
		const rendered = renderSegment("model", createCtx(ThinkingLevel.Ultra));

		expect(rendered.visible).toBe(true);
		expect(rendered.content).toContain(theme.thinking.ultra);
	});
});
