import { describe, expect, test } from "bun:test";
import { normalizeModelSelectorValue } from "@gajae-code/coding-agent/config/model-selector-value";
import { Settings } from "@gajae-code/coding-agent/config/settings";

describe("settings model fallback chains", () => {
	test("accepts scalar and array selector chains without narrowing permissive aliases", () => {
		const settings = Settings.isolated({
			modelRoles: { default: "claude-sonnet, best-coder" },
			"task.agentModelOverrides": { executor: ["pi/default:low", "best-coder"] },
		});

		expect(normalizeModelSelectorValue(settings.getModelRole("default"))).toEqual(["claude-sonnet", "best-coder"]);
		expect(normalizeModelSelectorValue(settings.get("task.agentModelOverrides").executor)).toEqual([
			"pi/default:low",
			"best-coder",
		]);
	});

	test("flattens comma-delimited array entries in order", () => {
		expect(normalizeModelSelectorValue(["claude-sonnet, best-coder", "pi/default:low"])).toEqual([
			"claude-sonnet",
			"best-coder",
			"pi/default:low",
		]);
	});

	test("defaults fallback attempts to three", () => {
		expect(Settings.isolated().get("fallback.maxAttempts")).toBe(3);
	});
});

describe("model selector value hardening", () => {
	test("normalizeModelSelectorValue tolerates malformed values", () => {
		expect(normalizeModelSelectorValue({} as never)).toEqual([]);
		expect(normalizeModelSelectorValue(42 as never)).toEqual([]);
		expect(normalizeModelSelectorValue([1, "a/b", null] as never)).toEqual(["a/b"]);
		expect(normalizeModelSelectorValue([])).toEqual([]);
		expect(normalizeModelSelectorValue("  ")).toEqual([]);
	});
});
