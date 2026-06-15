import { afterEach, describe, expect, it, vi } from "bun:test";
import { CancellableLoader, Container, type TUI } from "@gajae-code/tui";

describe("CancellableLoader disposal", () => {
	afterEach(() => {
		vi.useRealTimers();
	});

	it("stops its animation interval when removed by container.clear()", () => {
		vi.useFakeTimers();
		const requestRender = vi.fn();
		const ui = { requestRender } as unknown as TUI;
		const container = new Container();
		let colorTick = 0;
		const loader = new CancellableLoader(
			ui,
			text => text,
			text => `${text}-${colorTick}`,
			"Loading",
			["|", "/"],
		);

		container.addChild(loader);
		expect(requestRender).toHaveBeenCalledTimes(1);

		colorTick = 1;
		vi.advanceTimersByTime(80);
		const beforeClear = requestRender.mock.calls.length;
		expect(beforeClear).toBeGreaterThan(1);

		container.clear();
		colorTick = 2;
		vi.advanceTimersByTime(160);
		expect(requestRender.mock.calls.length).toBe(beforeClear);
	});
});
