import { describe, expect, it } from "bun:test";
import { visibleWidth } from "@gajae-code/tui";
import {
	EFFECTIVE_CONFIGURATION_SOURCE_RANKS,
	type EffectiveConfigurationSourceRecord,
	resolveEffectiveConfiguration,
} from "../src/config/effective-configuration";
import {
	createEffectiveConfigurationExplainView,
	createEffectiveConfigurationPickerDetailsView,
	renderEffectiveConfigurationExplainLines,
	renderEffectiveConfigurationPickerDetailsLines,
} from "../src/config/effective-configuration-view";

const KEY = "界面.模型";

function source(
	sourceId: string,
	rank: EffectiveConfigurationSourceRecord["rank"],
	value: unknown,
	ownership: EffectiveConfigurationSourceRecord["ownership"] = "owned",
): EffectiveConfigurationSourceRecord {
	return {
		sourceId,
		canonicalKey: KEY,
		presence: { presence: "present", value },
		rank,
		ownership,
		safePath: `/Users/用户/very/long/project/.gjc/${sourceId}.yml`,
		physicalIdentity: { kind: "known", identity: `physical:${sourceId}` },
		revision: `rev-${sourceId}`,
		aliases: [`旧-${sourceId}`],
		stability: { state: "stable" },
	};
}

describe("effective configuration picker and explain UI adapters", () => {
	it("share the same safe source facts and never expose the resolved value", () => {
		const result = resolveEffectiveConfiguration(KEY, [
			source("owned", EFFECTIVE_CONFIGURATION_SOURCE_RANKS.ownedUser, "secret-value"),
			source("discovered", EFFECTIVE_CONFIGURATION_SOURCE_RANKS.discoveredUser, "lower", "discovered"),
		]);
		const explain = createEffectiveConfigurationExplainView(result);
		const picker = createEffectiveConfigurationPickerDetailsView(result);

		expect(picker.sources).toEqual(explain.sources);
		expect(picker.sourceOptions).toEqual(explain.sources);
		expect(picker.selectedSourceId).toBe("owned");
		expect(picker.writableSourceIds).toEqual(["owned"]);
		expect(JSON.stringify(explain)).not.toContain("secret-value");
		expect(JSON.stringify(picker)).not.toContain("secret-value");
		expect(picker.sources.find(source => source.sourceId === "discovered")?.writable).toBe(false);
	});

	it("renders semantic no-color lines within narrow terminal-cell widths", () => {
		const result = resolveEffectiveConfiguration(KEY, [
			source("漢字-source", EFFECTIVE_CONFIGURATION_SOURCE_RANKS.ownedUser, { label: "値" }),
		]);
		const explain = createEffectiveConfigurationExplainView(result);
		const picker = createEffectiveConfigurationPickerDetailsView(result);
		for (const line of renderEffectiveConfigurationExplainLines(explain, 18)) {
			expect(visibleWidth(line)).toBeLessThanOrEqual(18);
			expect(line).not.toMatch(/\x1b/u);
		}
		for (const line of renderEffectiveConfigurationPickerDetailsLines(picker, { width: 18 })) {
			expect(visibleWidth(line)).toBeLessThanOrEqual(18);
			expect(line).not.toMatch(/[\u0000-\u001f\u007f]/u);
		}
	});

	it("deep-freezes every consumer view and keeps source ordering deterministic", () => {
		const records = [
			source("z", EFFECTIVE_CONFIGURATION_SOURCE_RANKS.ownedUser, "same"),
			source("a", EFFECTIVE_CONFIGURATION_SOURCE_RANKS.ownedUser, "same"),
		];
		const first = createEffectiveConfigurationPickerDetailsView(resolveEffectiveConfiguration(KEY, records));
		const second = createEffectiveConfigurationPickerDetailsView(
			resolveEffectiveConfiguration(KEY, [...records].reverse()),
		);

		expect(first).toEqual(second);
		expect(Object.isFrozen(first)).toBe(true);
		expect(Object.isFrozen(first.sourceOptions)).toBe(true);
		expect(Object.isFrozen(first.recovery)).toBe(true);
	});
});
