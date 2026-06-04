import { beforeAll, describe, expect, it } from "bun:test";
import type { SegmentContext } from "../src/modes/components/status-line/segments";
import { renderSegment } from "../src/modes/components/status-line/segments";
import { EMPTY_JOBS_SNAPSHOT } from "../src/modes/jobs-observer";
import { initTheme, theme } from "../src/modes/theme/theme";

beforeAll(async () => {
	await initTheme();
});

function createCtx(usage: Partial<SegmentContext["usageStats"]>): SegmentContext {
	return {
		session: {
			state: {},
			isFastModeEnabled: () => false,
			modelRegistry: { isUsingOAuth: () => false },
			sessionManager: undefined,
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
			...usage,
		},
		contextPercent: 0,
		contextWindow: 0,
		autoCompactEnabled: false,
		subagentCount: 0,
		jobs: EMPTY_JOBS_SNAPSHOT,
		sessionStartTime: Date.now(),
		git: {
			branch: null,
			status: null,
			pr: null,
		},
		usage: null,
	};
}

describe("issue #953 cache status line icons", () => {
	it("renders cache reads as cache output and cache writes as cache input", () => {
		const cacheRead = renderSegment("cache_read", createCtx({ cacheRead: 28_919_910 }));
		const cacheWrite = renderSegment("cache_write", createCtx({ cacheWrite: 1_759_992 }));

		expect(cacheRead.visible).toBe(true);
		expect(cacheRead.content).toContain(theme.icon.cache);
		expect(cacheRead.content).toContain(theme.icon.output);
		expect(cacheRead.content).not.toContain(theme.icon.input);

		expect(cacheWrite.visible).toBe(true);
		expect(cacheWrite.content).toContain(theme.icon.cache);
		expect(cacheWrite.content).toContain(theme.icon.input);
		expect(cacheWrite.content).not.toContain(theme.icon.output);
	});
});
