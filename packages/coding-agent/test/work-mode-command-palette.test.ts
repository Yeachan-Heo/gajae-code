import { expect, test } from "bun:test";
import { CURATED_WORK_MODES } from "../src/config/work-mode-catalog";
import { createWorkModePaletteEntries, createWorkModeSelectorCards } from "../src/config/work-mode-view";

test("keeps deterministic work-mode palette IDs, order, disabled reasons, and one-to-one routing", () => {
	const cards = createWorkModeSelectorCards();
	const entries = createWorkModePaletteEntries();
	const expectedIds: readonly [
		"work-mode:quick-edit",
		"work-mode:daily-coding",
		"work-mode:deep-plan",
		"work-mode:review",
		"work-mode:autonomous",
	] = [
		"work-mode:quick-edit",
		"work-mode:daily-coding",
		"work-mode:deep-plan",
		"work-mode:review",
		"work-mode:autonomous",
	];

	expect(entries.map(entry => entry.id)).toEqual([...expectedIds]);
	expect(entries.map(entry => entry.modeId)).toEqual(CURATED_WORK_MODES.map(mode => mode.id));
	expect(entries.map(entry => entry.category)).toEqual(CURATED_WORK_MODES.map(() => "Work Modes"));
	expect(new Set(entries.map(entry => entry.id)).size).toBe(entries.length);
	expect(new Set(entries.map(entry => entry.modeId)).size).toBe(entries.length);
	expect(entries).toHaveLength(cards.length);

	for (let index = 0; index < entries.length; index += 1) {
		const entry = entries[index];
		const card = cards[index];
		if (!entry || !card) throw new Error("Palette and selector catalogs diverged");
		expect(entry.id).toBe(`work-mode:${card.modeId}`);
		expect(entry.modeId).toBe(card.modeId);
		expect(entry.searchText).toBe(card.searchText);
		expect(entry.disabled).toBe(card.disabled);
		expect(entry.disabledReason).toBe(card.disabledReason);
		expect(entry.label).toBe(`Work Mode: ${card.label}`);
		expect(entry.description).toBe(`${card.taskContext} Profile ${card.profileId}.`);
	}

	const unavailable = createWorkModePaletteEntries({
		unavailableModeIds: new Set(["deep-plan", "review"]),
		unavailableReasons: new Map([
			["deep-plan", "Required provider is not authenticated"],
			["review", "Curated profile is shadowed by a user profile"],
		]),
	});
	expect(unavailable.map(entry => entry.id)).toEqual([...expectedIds]);
	expect(unavailable.find(entry => entry.modeId === "deep-plan")).toMatchObject({
		id: "work-mode:deep-plan",
		disabled: true,
		disabledReason: "Required provider is not authenticated",
	});
	expect(unavailable.find(entry => entry.modeId === "review")).toMatchObject({
		id: "work-mode:review",
		disabled: true,
		disabledReason: "Curated profile is shadowed by a user profile",
	});
	expect(unavailable.find(entry => entry.modeId === "quick-edit")).toMatchObject({
		id: "work-mode:quick-edit",
		disabled: false,
	});

	const routeById = new Map(unavailable.map(entry => [entry.id, entry.modeId]));
	expect(routeById.size).toBe(CURATED_WORK_MODES.length);
	for (const mode of CURATED_WORK_MODES) {
		expect(routeById.get(`work-mode:${mode.id}`)).toBe(mode.id);
	}
});
