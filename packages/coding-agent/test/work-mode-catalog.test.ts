import { expect, test } from "bun:test";
import { BUILTIN_MODEL_PROFILES } from "../src/config/model-profiles";
import {
	CURATED_WORK_MODES,
	getCuratedWorkMode,
	WORK_MODE_CATALOG_VERSION,
	WORK_MODE_IDS,
} from "../src/config/work-mode-catalog";

const expectedCatalog: typeof CURATED_WORK_MODES = [
	{
		id: "quick-edit",
		label: "Quick Edit",
		taskContext: "Short, constrained code changes.",
		searchTerms: ["quick", "edit", "constrained", "code"],
		profileId: "codex-eco",
	},
	{
		id: "daily-coding",
		label: "Daily Coding",
		taskContext: "General implementation and tests.",
		searchTerms: ["daily", "coding", "implementation", "tests"],
		profileId: "codex-medium",
	},
	{
		id: "deep-plan",
		label: "Deep Plan",
		taskContext: "Architecture and large-change planning.",
		searchTerms: ["deep", "plan", "architecture", "planning"],
		profileId: "claude-opus",
	},
	{
		id: "review",
		label: "Review",
		taskContext: "Read-heavy criticism and validation.",
		searchTerms: ["review", "criticism", "validation"],
		profileId: "claude-fable",
	},
	{
		id: "autonomous",
		label: "Autonomous",
		taskContext: "Multi-step implementation and verification under explicit user direction.",
		searchTerms: ["autonomous", "multi-step", "implementation", "verification"],
		profileId: "lunamaxxing",
	},
];

test("publishes the exact version-one catalog table in stable order", () => {
	expect(WORK_MODE_CATALOG_VERSION).toBe(1);
	expect(CURATED_WORK_MODES).toEqual(expectedCatalog);
	expect(WORK_MODE_IDS).toEqual(["quick-edit", "daily-coding", "deep-plan", "review", "autonomous"]);
});

test("catalog entries contain only static intent fields and no ranking or routing data", () => {
	const staticKeys = ["id", "label", "taskContext", "searchTerms", "profileId"].sort();
	const forbiddenTerms = ["rank", "ranking", "route", "routing", "score", "price", "latency", "quality", "health"];

	for (const mode of CURATED_WORK_MODES) {
		expect(Object.keys(mode).sort()).toEqual(staticKeys);
		const serialized = JSON.stringify(mode).toLowerCase();
		for (const forbiddenTerm of forbiddenTerms) expect(serialized.includes(forbiddenTerm)).toBe(false);
	}
});

test("each catalog profile id names one distinct bundled profile", () => {
	const bundledNames = new Set(BUILTIN_MODEL_PROFILES.map(profile => profile.name));
	const curatedProfileIds = CURATED_WORK_MODES.map(mode => mode.profileId);

	expect(curatedProfileIds.every(profileId => bundledNames.has(profileId))).toBe(true);
	expect(new Set(curatedProfileIds).size).toBe(CURATED_WORK_MODES.length);
});

test("lookup follows the immutable catalog order and rejects unknown ids", () => {
	expect(WORK_MODE_IDS.map(modeId => getCuratedWorkMode(modeId)?.id)).toEqual([...WORK_MODE_IDS]);
	expect(WORK_MODE_IDS.map(modeId => getCuratedWorkMode(modeId)?.profileId)).toEqual([
		"codex-eco",
		"codex-medium",
		"claude-opus",
		"claude-fable",
		"lunamaxxing",
	]);
	expect(getCuratedWorkMode("not-a-curated-mode")).toBeUndefined();
});

test("catalog and every nested entry are frozen snapshots", () => {
	expect(Object.isFrozen(CURATED_WORK_MODES)).toBe(true);
	expect(Object.isFrozen(WORK_MODE_IDS)).toBe(true);
	for (const mode of CURATED_WORK_MODES) {
		expect(Object.isFrozen(mode)).toBe(true);
		expect(Object.isFrozen(mode.searchTerms)).toBe(true);
	}
});
