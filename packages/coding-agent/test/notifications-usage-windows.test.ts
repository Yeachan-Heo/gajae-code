import { describe, expect, test } from "bun:test";
import { formatRemoteUsageWindows } from "../src/sdk/bus/index";

const RESET_5H = Date.parse("2026-07-24T03:30:00Z");
const RESET_7D = Date.parse("2026-07-26T03:00:00Z");
const RESET_CODEX = Date.parse("2026-07-28T17:02:47Z");

describe("formatRemoteUsageWindows", () => {
	test("groups windows by provider instead of collapsing across providers", () => {
		const lines = formatRemoteUsageWindows([
			{
				provider: "claude",
				limits: [
					{
						id: "5h",
						label: "5 Hour",
						window: { id: "5h", label: "5 Hour", durationMs: 5 * 3_600_000, resetsAt: RESET_5H },
						amount: { usedFraction: 0.07, unit: "percent" },
					},
					{
						id: "7d",
						label: "7 Day",
						window: { id: "7d", label: "7 Day", durationMs: 7 * 24 * 3_600_000, resetsAt: RESET_7D },
						amount: { usedFraction: 0.79, unit: "percent" },
					},
				],
			},
			{
				provider: "openai-codex",
				limits: [
					{
						id: "7d",
						label: "7 Day",
						window: { id: "7d", label: "7 Day", durationMs: 7 * 24 * 3_600_000, resetsAt: RESET_CODEX },
						scope: { provider: "openai-codex", tier: "pro" },
						amount: { usedFraction: 0.53, unit: "percent" },
					},
				],
			},
		]);

		expect(lines).toEqual([
			"Claude",
			"- 5-hour limit — 7% used — resets 2026-07-24 03:30:00 UTC",
			"- Weekly limit — 79% used — resets 2026-07-26 03:00:00 UTC",
			"",
			"Openai Codex",
			"- Weekly limit (pro) — 53% used — resets 2026-07-28 17:02:47 UTC",
		]);
	});

	test("keeps non-5h/7d windows and derives used fraction from used/limit", () => {
		const lines = formatRemoteUsageWindows([
			{
				provider: "gemini",
				limits: [
					{
						id: "daily",
						label: "Daily requests",
						window: { id: "daily", label: "Daily" },
						amount: { used: 120, limit: 1000, unit: "requests" },
					},
				],
			},
		]);

		expect(lines).toEqual(["Gemini", "- Daily — 12% used"]);
	});

	test("dedupes the same window across accounts keeping the highest usage", () => {
		const lines = formatRemoteUsageWindows([
			{
				provider: "claude",
				limits: [
					{
						id: "5h",
						label: "5 Hour",
						window: { id: "5h", label: "5 Hour", resetsAt: RESET_5H },
						amount: { usedFraction: 0.1, unit: "percent" },
					},
				],
			},
			{
				provider: "claude",
				limits: [
					{
						id: "5h",
						label: "5 Hour",
						window: { id: "5h", label: "5 Hour", resetsAt: RESET_5H },
						amount: { usedFraction: 0.42, unit: "percent" },
					},
				],
			},
		]);

		expect(lines).toEqual(["Claude", "- 5-hour limit — 42% used — resets 2026-07-24 03:30:00 UTC"]);
	});

	test("skips providers that report no limits and tolerates malformed input", () => {
		expect(formatRemoteUsageWindows(undefined)).toEqual([]);
		expect(formatRemoteUsageWindows("nope")).toEqual([]);
		expect(formatRemoteUsageWindows([{ provider: "grok-cli", limits: [] }, { provider: "kimi" }, null])).toEqual([]);
	});
});
