import { describe, expect, it } from "bun:test";
import {
	__gajaePetTestHooks,
	buildGajaePixelFrames,
	encodeGridSixel,
	PET_SKIN_IDS,
	PET_SKINS,
	resolvePetMode,
} from "@gajae-code/tui";

describe("gajae pixel frames", () => {
	it("falls back removed persisted skins to RedGajae without overriding explicit off", () => {
		expect(resolvePetMode("removed-skin")).toBe("red");
		expect(resolvePetMode("off")).toBe("off");
		expect(resolvePetMode("blue")).toBe("blue");
	});

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

	it("registers Ouroboros as a 16x16 skin with authored heart turns and work transitions", () => {
		expect(PET_SKIN_IDS).toContain("ouroboros");
		const skin = PET_SKINS.ouroboros;
		expect(skin.baseFrame).toBe("idle");
		expect(skin.work).toHaveLength(8);
		expect(skin.workEnter).toHaveLength(2);
		expect(skin.workExit?.map(([frame]) => frame)).toEqual(["enter-2", "enter-1", "idle"]);
		expect(skin.idle.map(([frame]) => frame)).toContain("blink");
		expect(skin.idle.map(([frame]) => frame)).toContain("tongue-2");
		expect(skin.idle.map(([frame]) => frame)).toContain("cry-3");
		expect(skin.idle.filter(([frame]) => frame === "tongue-2")).toHaveLength(3);
		expect(skin.idle.map(([frame]) => frame).slice(-8, -1)).toEqual([
			"cry-1",
			"cry-2",
			"cry-3",
			"cry-2",
			"cry-3",
			"cry-2",
			"cry-3",
		]);
		expect(skin.burst.intro.map(([frame]) => frame)).toContain("heart-accent");
		expect(skin.workBursts?.map(burst => burst.intro.some(([frame]) => frame === "heart-accent"))).toEqual([
			true,
			false,
		]);
		expect(skin.workBursts?.[1]?.intro.map(([frame]) => frame).filter(frame => frame.startsWith("cry-"))).toEqual([
			"cry-1",
			"cry-2",
			"cry-3",
			"cry-2",
			"cry-3",
			"cry-2",
			"cry-3",
		]);

		for (const frame of Object.values(skin.frames)) {
			expect(frame).toHaveLength(16);
			expect(frame.every(row => row.length === 16)).toBe(true);
		}

		const distinctWorkFrames = new Set(skin.work.map(([name]) => skin.frames[name]?.join("\n")));
		expect(distinctWorkFrames.size).toBe(8);
		for (const [name] of skin.work) {
			const grid = skin.frames[name];
			expect(grid?.join("").match(/G/g)).toHaveLength(1);
			expect(grid?.join("")).toContain("r");
		}
		expect(skin.work.every(([, duration]) => duration === 220)).toBe(true);
		expect(skin.frames["enter-2"]).toEqual(skin.frames["spin-1"]?.map(row => row.replaceAll("G", "D")));

		const rotatedHeartStart = [...(skin.frames["heart-turn-0"] ?? [])]
			.reverse()
			.map(row => [...row].reverse().join(""));
		expect(skin.frames.heart).toEqual(rotatedHeartStart);
		for (const removedFrame of ["heart-turn-2", "heart-turn-7", "heart-turn-8", "heart-turn-9"]) {
			expect(skin.frames).not.toHaveProperty(removedFrame);
		}
		expect(skin.burst.intro.map(([frame]) => frame).filter(frame => frame.startsWith("heart-turn-"))).toEqual([
			"heart-turn-0",
			"heart-turn-1",
			"heart-turn-3",
			"heart-turn-4",
			"heart-turn-5",
			"heart-turn-6",
			"heart-turn-10",
			"heart-turn-11",
			"heart-turn-11",
			"heart-turn-10",
			"heart-turn-6",
			"heart-turn-5",
			"heart-turn-4",
			"heart-turn-3",
			"heart-turn-1",
			"heart-turn-0",
		]);
	});

	it("renders Ouroboros at the same terminal footprint as the crab skins", () => {
		const built = buildGajaePixelFrames({
			protocol: "sixel",
			cellWidthPx: 9,
			cellHeightPx: 18,
			targetRows: 2,
			skin: "ouroboros",
		});

		expect(built.widthPx).toBe(36);
		expect(built.heightPx).toBe(36);
		expect(built.columns).toBe(4);
		expect(built.rows).toBe(2);
		expect(Object.keys(built.frames)).toHaveLength(27);
		expect(built.frames.idle.startsWith('\x1bP0;1;0q"1;1;36;36')).toBe(true);
		expect(built.frames["spin-1"]).not.toBe(built.frames["spin-2"]);
	});
});
