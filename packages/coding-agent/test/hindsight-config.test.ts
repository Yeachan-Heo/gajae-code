import { describe, expect, it } from "bun:test";
import { Settings } from "../src/config/settings";
import { loadHindsightConfig } from "../src/hindsight/config";

const settings = () =>
	Settings.isolated({
		"hindsight.retainEveryNTurns": 3,
		"hindsight.recallMaxTokens": 1024,
		"hindsight.recallContextTurns": 1,
		"hindsight.recallMaxQueryChars": 800,
	});

describe("loadHindsightConfig numeric env overrides", () => {
	it("applies plain-digit env values", () => {
		const config = loadHindsightConfig(settings(), {
			HINDSIGHT_RETAIN_EVERY_N_TURNS: "5",
			HINDSIGHT_RECALL_MAX_TOKENS: " 2048 ",
			HINDSIGHT_RECALL_CONTEXT_TURNS: "2",
			HINDSIGHT_RECALL_MAX_QUERY_CHARS: "0",
		});
		expect(config.retainEveryNTurns).toBe(5);
		expect(config.recallMaxTokens).toBe(2048);
		expect(config.recallContextTurns).toBe(2);
		expect(config.recallMaxQueryChars).toBe(0);
	});

	it.each([
		"5turns",
		"1e3",
		"1.5",
		"-3",
		"",
		"0x10",
		"99999999999999999999",
	])("ignores %p and keeps the settings value", raw => {
		const config = loadHindsightConfig(settings(), {
			HINDSIGHT_RETAIN_EVERY_N_TURNS: raw,
			HINDSIGHT_RECALL_MAX_TOKENS: raw,
			HINDSIGHT_RECALL_CONTEXT_TURNS: raw,
			HINDSIGHT_RECALL_MAX_QUERY_CHARS: raw,
		});
		expect(config.retainEveryNTurns).toBe(3);
		expect(config.recallMaxTokens).toBe(1024);
		expect(config.recallContextTurns).toBe(1);
		expect(config.recallMaxQueryChars).toBe(800);
	});
});
