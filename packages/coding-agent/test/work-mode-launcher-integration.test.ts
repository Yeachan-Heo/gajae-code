import { expect, test } from "bun:test";
import { CURATED_WORK_MODES } from "../src/config/work-mode-catalog";
import { ActionRegistry, type WorkModeActionId } from "../src/modes/action-registry";
import { SelectorController } from "../src/modes/controllers/selector-controller";
import type { InteractiveModeContext } from "../src/modes/types";

const WORK_MODE_ACTION_IDS = [
	"work-mode:quick-edit",
	"work-mode:daily-coding",
	"work-mode:deep-plan",
	"work-mode:review",
	"work-mode:autonomous",
] as const satisfies readonly WorkModeActionId[];

test("SelectorController reuses one ActionRegistry route for every Work Mode", async () => {
	const opened: string[] = [];
	const ctx = {
		session: {
			subscribe: () => undefined,
		},
	} as unknown as InteractiveModeContext;
	const controller = new SelectorController(ctx);
	const controllerSeam = controller as unknown as {
		showModelSelector(options?: { initialWorkModeId?: string }): void;
	};
	controllerSeam.showModelSelector = options => {
		opened.push(options?.initialWorkModeId ?? "");
	};
	const registry = new ActionRegistry<void>({ context: undefined, showError: () => {} });

	controller.setActionRegistry(registry);
	controller.setActionRegistry(registry);

	const ids = registry.all().map(action => action.id);
	expect(ids).toEqual([...WORK_MODE_ACTION_IDS]);
	expect(new Set(ids).size).toBe(CURATED_WORK_MODES.length);

	expect(await registry.execute(WORK_MODE_ACTION_IDS[1])).toBe(true);
	expect(opened).toEqual(["daily-coding"]);
});
