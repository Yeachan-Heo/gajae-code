import { describe, expect, it } from "bun:test";
import * as zlib from "node:zlib";
import {
	__gajaePetTestHooks,
	buildGajaePixelFrames,
	encodeGridIterm2,
	encodeGridSixel,
	PET_SKIN_IDS,
	PET_SKINS,
	resolvePetMode,
} from "@gajae-code/tui";

function decodeIterm2Png(sequence: string): {
	width: number;
	height: number;
	rgba: Uint8Array;
	chunks: Array<{ type: string; data: Buffer; crc: number }>;
} {
	const match = sequence.match(/^\x1b\]1337;File=[^:]+:([A-Za-z0-9+/=]+)\x1b\\$/u);
	if (!match) throw new Error("Invalid iTerm2 image sequence");
	const png = Buffer.from(match[1], "base64");
	expect(png.subarray(0, 8)).toEqual(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
	const chunks: Array<{ type: string; data: Buffer; crc: number }> = [];
	for (let offset = 8; offset < png.length; ) {
		const length = png.readUInt32BE(offset);
		const type = png.toString("ascii", offset + 4, offset + 8);
		const data = png.subarray(offset + 8, offset + 8 + length);
		chunks.push({ type, data, crc: png.readUInt32BE(offset + 8 + length) });
		offset += 12 + length;
	}
	const ihdr = chunks.find(chunk => chunk.type === "IHDR")?.data;
	if (!ihdr) throw new Error("Missing IHDR");
	const width = ihdr.readUInt32BE(0);
	const height = ihdr.readUInt32BE(4);
	const compressed = Buffer.concat(chunks.filter(chunk => chunk.type === "IDAT").map(chunk => chunk.data));
	const scanlines = zlib.inflateSync(compressed);
	const rgba = new Uint8Array(width * height * 4);
	for (let y = 0; y < height; y++) {
		expect(scanlines[y * (width * 4 + 1)]).toBe(0);
		rgba.set(scanlines.subarray(y * (width * 4 + 1) + 1, (y + 1) * (width * 4 + 1)), y * width * 4);
	}
	return { width, height, rgba, chunks };
}

function pngCrc(type: string, data: Uint8Array): number {
	let crc = 0xffffffff;
	for (const byte of Buffer.concat([Buffer.from(type, "ascii"), Buffer.from(data)])) {
		crc ^= byte;
		for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
	}
	return (crc ^ 0xffffffff) >>> 0;
}

const ITERM_PET_GEOMETRY_FIXTURES = [
	{
		name: "9x18 cells",
		cellWidthPx: 9,
		cellHeightPx: 18,
		expected: {
			widthPx: 36,
			heightPx: 36,
			canvasWidthPx: 36,
			columns: 4,
			rows: 2,
			leftPaddingPx: 0,
			rightPaddingPx: 0,
			topPaddingPx: 0,
		},
	},
	{
		name: "18x24 cells",
		cellWidthPx: 18,
		cellHeightPx: 24,
		expected: {
			widthPx: 48,
			heightPx: 48,
			canvasWidthPx: 54,
			columns: 3,
			rows: 2,
			leftPaddingPx: 3,
			rightPaddingPx: 3,
			topPaddingPx: 0,
		},
	},
	{
		name: "6x6 cells at minimum art scale",
		cellWidthPx: 6,
		cellHeightPx: 6,
		expected: {
			widthPx: 16,
			heightPx: 18,
			canvasWidthPx: 18,
			columns: 3,
			rows: 3,
			leftPaddingPx: 1,
			rightPaddingPx: 1,
			topPaddingPx: 2,
		},
	},
] as const;

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

	it("encodes deterministic iTerm2 PNG dimensions, CRCs, colors, and transparent padding", () => {
		const sequence = encodeGridIterm2(["R."], 2, 2, 2, 1, 1, 0, 0, { R: [12, 34, 56] });
		expect(sequence).toContain("width=2;height=2;preserveAspectRatio=0;inline=1");
		const decoded = decodeIterm2Png(sequence);
		expect(decoded.width).toBe(4);
		expect(decoded.height).toBe(4);
		expect(decoded.chunks.map(chunk => chunk.type)).toEqual(["IHDR", "IDAT", "IEND"]);
		for (const chunk of decoded.chunks) expect(chunk.crc).toBe(pngCrc(chunk.type, chunk.data));
		const pixel = (x: number, y: number) => [
			...decoded.rgba.subarray((y * decoded.width + x) * 4, (y * decoded.width + x + 1) * 4),
		];
		expect(pixel(0, 0)).toEqual([0, 0, 0, 0]);
		expect(pixel(0, 1)).toEqual([12, 34, 56, 255]);
		expect(pixel(2, 1)).toEqual([0, 0, 0, 0]);
		expect(pixel(0, 3)).toEqual([0, 0, 0, 0]);
	});

	it("rejects malformed or unbounded iTerm2 PNG inputs", () => {
		expect(() => encodeGridIterm2([], 1, 1, 1)).toThrow("non-empty and rectangular");
		expect(() => encodeGridIterm2(["R", "RR"], 1, 1, 1)).toThrow("non-empty and rectangular");
		expect(() => encodeGridIterm2(["R"], 0, 1, 1)).toThrow("finite and positive");
		expect(() => encodeGridIterm2(["R"], Number.POSITIVE_INFINITY, 1, 1)).toThrow("finite and positive");
		expect(() => encodeGridIterm2(["R"], 20_000, 1, 1)).toThrow("dimensions are out of bounds");
		expect(() => encodeGridIterm2(["R"], 1, 0, 1)).toThrow("positive integer");
		expect(() => encodeGridIterm2(["R"], 1, 2.5, 1)).toThrow("positive integer");
		expect(() => encodeGridIterm2(["R"], 1, 1, 1, -1)).toThrow("non-negative integer");
		expect(() => encodeGridIterm2(["R"], 1, 1, 1, 0, 0, 0, -1)).toThrow("non-negative integer");
		expect(() => buildGajaePixelFrames({ protocol: "iterm2", cellWidthPx: 0, cellHeightPx: 18 })).toThrow(
			"cell width",
		);
		expect(() => buildGajaePixelFrames({ protocol: "kitty", cellWidthPx: 1, cellHeightPx: 10_000 })).toThrow(
			"frame dimensions are out of bounds",
		);
	});

	it("keeps Kitty and Sixel fixtures unchanged while iTerm2 uses the reserved cell block", () => {
		const sixel = buildGajaePixelFrames({ protocol: "sixel", cellWidthPx: 9, cellHeightPx: 18 });
		const kitty = buildGajaePixelFrames({ protocol: "kitty", cellWidthPx: 9, cellHeightPx: 18 });
		expect(sixel.frames.base).toStartWith('\x1bP0;1;0q"1;1;36;36');
		expect(kitty.frames.base).toContain("a=T,f=32,s=36,v=36,c=4,r=2");

		for (const fixture of ITERM_PET_GEOMETRY_FIXTURES) {
			const iterm2 = buildGajaePixelFrames({
				protocol: "iterm2",
				cellWidthPx: fixture.cellWidthPx,
				cellHeightPx: fixture.cellHeightPx,
			});
			const decoded = decodeIterm2Png(iterm2.frames.base);
			expect(iterm2.frames.base, fixture.name).toContain(
				`width=${fixture.expected.columns};height=${fixture.expected.rows};preserveAspectRatio=0`,
			);
			expect(decoded.width, fixture.name).toBe(fixture.expected.canvasWidthPx);
			expect(decoded.height, fixture.name).toBe(fixture.expected.heightPx);
			const alpha = (x: number, y: number) => decoded.rgba[(y * decoded.width + x) * 4 + 3];
			for (let x = 0; x < fixture.expected.leftPaddingPx; x++) {
				expect(
					Array.from({ length: decoded.height }, (_, y) => alpha(x, y)),
					fixture.name,
				).toEqual(Array(decoded.height).fill(0));
			}
			for (let x = decoded.width - fixture.expected.rightPaddingPx; x < decoded.width; x++) {
				expect(
					Array.from({ length: decoded.height }, (_, y) => alpha(x, y)),
					fixture.name,
				).toEqual(Array(decoded.height).fill(0));
			}
			for (let y = 0; y < fixture.expected.topPaddingPx; y++) {
				expect(
					Array.from({ length: decoded.width }, (_, x) => alpha(x, y)),
					fixture.name,
				).toEqual(Array(decoded.width).fill(0));
			}
			expect(
				decoded.rgba.some((value, index) => index % 4 === 3 && value === 255),
				fixture.name,
			).toBe(true);
			expect(iterm2, fixture.name).toMatchObject({
				widthPx: fixture.expected.widthPx,
				heightPx: fixture.expected.heightPx,
				columns: fixture.expected.columns,
				rows: fixture.expected.rows,
				rasterRows: fixture.expected.rows,
			});
		}
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
