import { describe, expect, it } from "bun:test";
import { __gajaePetTestHooks, buildGajaePixelFrames, encodeGridSixel } from "@gajae-code/tui";

describe("gajae pixel frames", () => {
	it("encodes bottom-aligned sixel frames with a transparent background", () => {
		const built = buildGajaePixelFrames({ protocol: "sixel", cellWidthPx: 9, cellHeightPx: 18, targetRows: 2 });
		expect(built.widthPx).toBe(36);
		expect(built.heightPx).toBe(36);
		expect(built.rows).toBe(2);
		expect(built.rasterRows).toBe(2);
		expect(built.columns).toBe(4);
		for (const frame of Object.values(built.frames)) {
			expect(frame.startsWith('\x1bP0;1;0q"1;1;36;36')).toBe(true);
			expect(frame.endsWith("\x1b\\")).toBe(true);
		}
		// Distinct frames must differ.
		expect(built.frames.base).not.toBe(built.frames.flex);
	});

	it("adds transparent sixel padding for a nine-pixel sub-cell drop", () => {
		const built = buildGajaePixelFrames({
			protocol: "sixel",
			cellWidthPx: 9,
			cellHeightPx: 18,
			targetRows: 2,
			sixelTopPaddingPx: 9,
		});
		expect(built.rows).toBe(2);
		expect(built.rasterRows).toBe(3);
		expect(built.heightPx).toBe(45);
		expect(built.frames.base.startsWith('\x1bP0;1;0q"1;1;36;45')).toBe(true);
	});

	it("carries the >< effort face on danceL and the ^^ victory face on flex", () => {
		const effort = __gajaePetTestHooks
			.getPixelGrid("danceL")
			.slice(6, 9)
			.map(row => row.slice(5, 11));
		const victory = __gajaePetTestHooks
			.getPixelGrid("flex")
			.slice(6, 9)
			.map(row => row.slice(5, 11));

		expect(effort).toEqual(["GVVVGV", "VGVGVV", "GVVVGV"]); // > <
		expect(victory).toEqual(["VGVVGV", "GVGGVG", "VVVVVV"]); // ^ ^
	});

	it("encodes kitty frames as chunked raw-RGBA transmits with delete-first", () => {
		const built = buildGajaePixelFrames({ protocol: "kitty", cellWidthPx: 9, cellHeightPx: 18, targetRows: 2 });
		const frame = built.frames.base;
		expect(frame.startsWith("\x1b_Ga=d,d=I,i=")).toBe(true);
		expect(frame).toContain("a=T,f=32,s=36,v=36");
		// 36x36 RGBA exceeds one kitty payload chunk.
		expect(frame).toContain(",m=1;");
		expect(frame).toContain("\x1b_Gm=0;");
	});

	it("horizontally pads the kitty image so a non-2:1 cell ratio does not stretch the sprite", () => {
		// 14x18 cells aren't 2:1, so the 36px-wide sprite spans ceil(36/14)=3 columns
		// (42px). Pad the canvas to 42px and center the square sprite instead of
		// letting kitty stretch it to fill the wider cell block.
		const built = buildGajaePixelFrames({ protocol: "kitty", cellWidthPx: 14, cellHeightPx: 18, targetRows: 2 });
		expect(built.columns).toBe(3);
		expect(built.frames.base).toContain("s=42,v=36,c=3,r=2");
	});

	it("keeps a minimum 1x scale for tiny cells", () => {
		const sixel = encodeGridSixel(["RK", ".G"], 1);
		expect(sixel.startsWith('\x1bP0;1;0q"1;1;2;2')).toBe(true);
	});
});
