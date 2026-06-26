import { beforeAll, describe, expect, it } from "bun:test";
import { visibleWidth } from "@gajae-code/tui";
import { WelcomeComponent } from "../src/modes/components/welcome";
import { getThemeByName, setThemeInstance } from "../src/modes/theme/theme";

beforeAll(async () => {
	const theme = await getThemeByName("red-claw");
	if (!theme) throw new Error("Failed to load red-claw theme");
	setThemeInstance(theme);
});

describe("WelcomeComponent viewport sizing", () => {
	it("uses the full terminal width on wide initial forge viewports", () => {
		const welcome = new WelcomeComponent("1.2.3", "test-model", "test-provider", [], [], "ascii");
		const lines = welcome.render(200);

		expect(lines.length).toBeGreaterThan(0);
		for (const line of lines) {
			expect(visibleWidth(line)).toBe(198);
		}
	});

	it("degrades gracefully on tiny terminal widths", () => {
		const welcome = new WelcomeComponent("1.2.3", "test-model", "test-provider", [], [], "ascii");

		expect(welcome.render(5).every(line => visibleWidth(line) <= 3)).toBe(true);
		expect(welcome.render(3)).toEqual([]);
		expect(welcome.render(24).every(line => visibleWidth(line) <= 22)).toBe(true);
	});
});
