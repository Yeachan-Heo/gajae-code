import { afterEach, describe, expect, it } from "bun:test";
import { getCellDimensions, setCellDimensions } from "@gajae-code/tui/terminal-capabilities";
import { TUI } from "@gajae-code/tui/tui";
import { VirtualTerminal } from "./virtual-terminal";

describe("TUI terminal cell-size responses", () => {
	const originalDimensions = { ...getCellDimensions() };

	afterEach(() => {
		setCellDimensions(originalDimensions);
	});

	it("consumes oversized CSI 6 metrics without allocating an unsafe raster", () => {
		setCellDimensions({ widthPx: 8, heightPx: 16 });
		const terminal = new VirtualTerminal();
		const tui = new TUI(terminal);
		tui.start();
		try {
			terminal.sendInput("\x1b[6;65535;65535t");
			expect(getCellDimensions()).toEqual({ widthPx: 8, heightPx: 16 });
		} finally {
			tui.stop();
		}
	});
});
