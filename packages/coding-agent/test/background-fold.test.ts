import { describe, expect, test } from "bun:test";
import { BACKGROUND_FOLD_DOUBLE_PRESS_MS, InputController } from "../src/modes/controllers/input-controller";

describe("foreground bash background fold", () => {
	test("requires a second press within the preserved 750ms window", () => {
		let folds = 0;
		let status = "";
		const controller = new InputController({
			session: {
				hasForegroundBashBackgroundRequestHandler: () => true,
				requestForegroundBashBackground: () => {
					folds += 1;
					return true;
				},
			},
			showStatus: (message: string) => {
				status = message;
			},
			showWarning: () => {},
		} as never);
		const realNow = Date.now;
		try {
			Date.now = () => 1_000;
			expect(controller.handleForegroundToolBackgroundFold()).toBe(true);
			expect(status).toContain("again");
			Date.now = () => 1_000 + BACKGROUND_FOLD_DOUBLE_PRESS_MS;
			expect(controller.handleForegroundToolBackgroundFold()).toBe(true);
			expect(folds).toBe(1);
		} finally {
			Date.now = realNow;
		}
	});
});
