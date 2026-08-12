import { expect, test } from "bun:test";
import { createWorkModePaletteEntries } from "../src/config/work-mode-view";
import { ActionRegistry, type WorkModeActionId } from "../src/modes/action-registry";
import { registerWorkModePaletteActions } from "../src/modes/controllers/selector-controller";

const actionRegistry = (): ActionRegistry<void> =>
	new ActionRegistry({
		context: undefined,
		showError: () => {},
	});

const WORK_MODE_ACTION_IDS = [
	"work-mode:quick-edit",
	"work-mode:daily-coding",
	"work-mode:deep-plan",
	"work-mode:review",
	"work-mode:autonomous",
] as const satisfies readonly WorkModeActionId[];

test("registers the canonical five Work Mode actions once and preserves order", async () => {
	const registry = actionRegistry();
	const launched: string[] = [];
	const entries = createWorkModePaletteEntries();
	const expectedIds = WORK_MODE_ACTION_IDS;

	expect(
		registerWorkModePaletteActions(registry, {
			entries,
			launch: modeId => {
				launched.push(modeId);
			},
		}),
	).toEqual([...expectedIds]);
	expect(
		registerWorkModePaletteActions(registry, {
			entries,
			launch: () => {
				launched.push("duplicate");
			},
		}),
	).toEqual([]);
	expect(registry.all().map(action => action.id)).toEqual([...expectedIds]);

	const selected = expectedIds[2];
	if (!selected) throw new Error("Expected a third Work Mode action");
	expect(await registry.execute(selected)).toBe(true);
	expect(launched).toEqual(["deep-plan"]);
});

test("disabled canonical entries expose their reason and cannot dispatch", async () => {
	const registry = actionRegistry();
	const entries = createWorkModePaletteEntries({
		unavailableModeIds: new Set(["review"]),
		unavailableReasons: new Map([["review", "Curated profile is unavailable"]]),
	});
	const disabled = entries.find(entry => entry.modeId === "review");
	if (!disabled) throw new Error("Expected the review Work Mode entry");
	const launched: string[] = [];

	registerWorkModePaletteActions(registry, {
		entries,
		launch: modeId => {
			launched.push(modeId);
		},
	});

	expect(disabled.disabled).toBe(true);
	expect(disabled.disabledReason).toBe("Curated profile is unavailable");
	expect(registry.isAvailable(disabled.id)).toBe(false);
	expect(await registry.execute(disabled.id)).toBe(false);
	expect(launched).toEqual([]);
});
