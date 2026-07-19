import { describe, expect, it } from "bun:test";
import { StatusRowReserve } from "@gajae-code/coding-agent/modes/components/status-row-reserve";
import { Loader, TUI } from "@gajae-code/tui";
import { VirtualTerminal } from "../../../../tui/test/virtual-terminal";

describe("StatusRowReserve", () => {
	it("pads to the high-water mark and never contracts at a stable width", () => {
		let live = 3;
		const reserve = new StatusRowReserve(() => live);
		expect(reserve.render(40)).toEqual([]);
		live = 5;
		expect(reserve.render(40)).toEqual([]);
		live = 2;
		expect(reserve.render(40)).toEqual(["", "", ""]);
		live = 0;
		expect(reserve.render(40)).toEqual(["", "", "", "", ""]);
	});

	it("captures rows outside render frames and resets the reservation on resize", () => {
		let live = 4;
		const reserve = new StatusRowReserve(() => live);
		reserve.capture(40);
		live = 0;
		expect(reserve.render(40)).toHaveLength(4);
		// A resize reflows and repaints the viewport anyway; the reservation
		// restarts from the post-resize live rows.
		live = 1;
		expect(reserve.render(20)).toHaveLength(0);
		live = 0;
		expect(reserve.render(20)).toHaveLength(1);
	});

	it("reserves the wrapped row count of ANSI and Unicode status text per width", () => {
		const term = new VirtualTerminal(40, 4);
		const tui = new TUI(term);
		const loader = new Loader(
			tui,
			text => `\x1b[36m${text}\x1b[0m`,
			text => `\x1b[35m${text}\x1b[0m`,
			"한글🙂 e\u0301 café — wrapping status",
			["|"],
		);
		let removed = false;
		const reserve = new StatusRowReserve(width => (removed ? 0 : loader.render(width).length));
		for (const width of [4, 7, 16, 40]) {
			removed = false;
			const liveRows = loader.render(width).length;
			expect(liveRows, `width=${width}`).toBeGreaterThan(1);
			reserve.capture(width);
			removed = true;
			expect(reserve.render(width), `width=${width}`).toEqual(Array.from({ length: liveRows }, () => ""));
		}
		loader.stop();
		tui.stop();
	});
});
