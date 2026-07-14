import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { ThinkingLevel } from "@gajae-code/agent-core";
import { resetSettingsForTest, Settings } from "../src/config/settings";
import { renderSegment, type SegmentContext } from "../src/modes/components/status-line/segments";
import { EMPTY_JOBS_SNAPSHOT } from "../src/modes/jobs-observer";
import { initTheme } from "../src/modes/theme/theme";

function contextForModel(name: string): SegmentContext {
	return {
		session: {
			state: {
				model: { id: name.toLowerCase(), name, thinking: false, contextWindow: 200_000 },
				thinkingLevel: ThinkingLevel.Off,
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
		contextWindow: 200_000,
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
	await Settings.init({ inMemory: true, cwd: process.cwd() });
});

afterAll(() => resetSettingsForTest());

describe("status-line fallback model", () => {
	it("renders the active fallback model from the session snapshot", () => {
		const rendered = Bun.stripANSI(renderSegment("model", contextForModel("Fallback Model")).content);

		expect(rendered).toContain("Fallback Model");
		expect(rendered).not.toContain("Primary Model");
	});
});
