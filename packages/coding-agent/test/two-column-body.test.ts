import { beforeAll, describe, expect, it, vi } from "bun:test";
import { type Component, visibleWidth } from "@gajae-code/tui";
import { TwoColumnBody } from "../src/modes/components/two-column-body";
import { setThemeInstance } from "../src/modes/theme/theme";
import { loadTestTheme } from "./helpers/test-theme";

class StaticPane implements Component {
	constructor(private readonly lines: string[]) {}

	render(_width: number): string[] {
		return this.lines;
	}

	invalidate = vi.fn();
}

beforeAll(async () => {
	const theme = await loadTestTheme();
	setThemeInstance(theme);
});

describe("TwoColumnBody", () => {
	it("keeps combined rows within the requested width", () => {
		const body = new TwoColumnBody(
			new StaticPane(["left column content that must truncate"]),
			new StaticPane(["right column content that must truncate"]),
			3,
		);

		for (const width of [2, 3, 20, 80]) {
			const lines = body.render(width);
			expect(lines.length).toBe(1);
			expect(visibleWidth(lines[0] ?? "")).toBeLessThanOrEqual(width);
		}
	});

	it("invalidates both panes", () => {
		const left = new StaticPane(["left"]);
		const right = new StaticPane(["right"]);
		const body = new TwoColumnBody(left, right, 3);

		body.invalidate();

		expect(left.invalidate).toHaveBeenCalledTimes(1);
		expect(right.invalidate).toHaveBeenCalledTimes(1);
	});
});
