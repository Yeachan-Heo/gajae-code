import { describe, expect, it } from "bun:test";
import * as zlib from "node:zlib";
import {
	__gajaePetTestHooks,
	buildGajaePixelFrames,
	burstTimeline,
	encodeGajaePetGif,
	encodeGridIterm2,
	encodeGridSixel,
	getGajaePetGifCached,
	getGajaePetGifCacheStats,
	idleTimeline,
	PET_SKIN_IDS,
	PET_SKINS,
	petBurstDurationMs,
	petBurstFrame,
	previewTimeline,
	resetGajaePetGifCache,
	resolvePetMode,
	workingTimeline,
} from "@gajae-code/tui";
import { encodeITerm2Multipart, wrapITerm2RecordsForTmux } from "../src/terminal-capabilities";

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

	it("centers iTerm2 art in a three-row raster and advertises the padded canvas", () => {
		const built = buildGajaePixelFrames({
			protocol: "iterm2",
			cellWidthPx: 9,
			cellHeightPx: 18,
			targetRows: 2,
			iterm2TopPaddingPx: 9,
			iterm2BottomPaddingPx: 9,
		});
		const decoded = decodeIterm2Png(built.frames.base);
		expect(built.rows).toBe(2);
		expect(built.rasterRows).toBe(3);
		expect(built.heightPx).toBe(54);
		expect(built.frames.base).toContain("width=4;height=3;preserveAspectRatio=0");
		expect(decoded.width).toBe(36);
		expect(decoded.height).toBe(54);
		const alpha = (x: number, y: number) => decoded.rgba[(y * decoded.width + x) * 4 + 3];
		for (const y of [0, 8, 45, 53]) {
			expect(Array.from({ length: decoded.width }, (_, x) => alpha(x, y))).toEqual(Array(decoded.width).fill(0));
		}
		expect(
			decoded.rgba.some((value, index) => index % 4 === 3 && value === 255 && index / 4 / decoded.width >= 9),
		).toBe(true);
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
		expect(sequence).toContain("name=Z2FqYWUtcGV0LnBuZw==;width=2;height=2;preserveAspectRatio=0;inline=1");
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
function gifFrameDelays(bytes: Uint8Array): number[] {
	let offset = 6;
	const read16 = () => {
		const value = bytes[offset] | (bytes[offset + 1] << 8);
		offset += 2;
		return value;
	};
	read16();
	read16();
	const packed = bytes[offset++];
	if (packed & 0x80) offset += 3 * (1 << ((packed & 7) + 1));
	offset += 2;
	const delays: number[] = [];
	const skipSubBlocks = () => {
		while (bytes[offset] !== 0) offset += 1 + bytes[offset];
		offset++;
	};
	while (bytes[offset] !== 0x3b) {
		if (bytes[offset] === 0x21 && bytes[offset + 1] === 0xf9) {
			if (bytes[offset + 2] !== 4) throw new Error("invalid GIF graphics control extension");
			offset += 3;
			offset++;
			delays.push((bytes[offset] | (bytes[offset + 1] << 8)) * 10);
			offset += 2;
			offset++;
			if (bytes[offset++] !== 0) throw new Error("invalid GIF graphics control extension");
		} else if (bytes[offset] === 0x2c) {
			offset += 10;
			const imagePacked = bytes[offset - 1];
			if (imagePacked & 0x80) offset += 3 * (1 << ((imagePacked & 7) + 1));
			offset++;
			skipSubBlocks();
		} else if (bytes[offset] === 0x21) {
			offset += 2;
			offset += 1 + bytes[offset];
			skipSubBlocks();
		} else throw new Error(`invalid GIF block at offset ${offset}`);
	}
	return delays;
}
function gifFirstFramePixels(bytes: Uint8Array): number[] {
	let offset = 6;
	const read16 = () => {
		const value = bytes[offset] | (bytes[offset + 1] << 8);
		offset += 2;
		return value;
	};
	read16();
	read16();
	const packed = bytes[offset++];
	if (packed & 0x80) offset += 3 * (1 << ((packed & 7) + 1));
	offset += 2;
	const skipSubBlocks = () => {
		while (bytes[offset] !== 0) offset += 1 + bytes[offset];
		offset++;
	};
	while (bytes[offset] === 0x21) {
		offset += 2;
		offset += 1 + bytes[offset];
		skipSubBlocks();
	}
	if (bytes[offset] !== 0x2c) throw new Error("missing GIF image block");
	offset += 10;
	const minCodeSize = bytes[offset++];
	if (minCodeSize !== 8) throw new Error("unexpected GIF LZW code size");
	const compressed: number[] = [];
	while (bytes[offset] !== 0) {
		const length = bytes[offset++];
		compressed.push(...bytes.slice(offset, offset + length));
		offset += length;
	}
	let bitOffset = 0;
	const readCode = () => {
		let code = 0;
		for (let bit = 0; bit < 9; bit++) {
			code |= ((compressed[(bitOffset + bit) >> 3] >> ((bitOffset + bit) & 7)) & 1) << bit;
		}
		bitOffset += 9;
		return code;
	};
	const pixels: number[] = [];
	while (bitOffset + 9 <= compressed.length * 8) {
		const code = readCode();
		if (code === 257) break;
		if (code !== 256) pixels.push(code);
	}
	return pixels;
}
describe("GIF artifacts and helpers", () => {
	it("encodes deterministic GIF89a geometry, metadata, delays, and distinct skin palettes", () => {
		const timeline = [
			{ name: "base" as const, delayMs: 25 },
			{ name: "flex" as const, delayMs: 100 },
		];
		const red = encodeGajaePetGif({ skin: "red", timeline, cellWidthPx: 9, cellHeightPx: 18, targetRows: 2 });
		const blue = encodeGajaePetGif({ skin: "blue", timeline, cellWidthPx: 9, cellHeightPx: 18, targetRows: 2 });
		expect(Buffer.from(red.bytes.slice(0, 6)).toString()).toBe("GIF89a");
		expect([red.width, red.height]).toEqual([36, 36]);
		expect(red.bytes).not.toEqual(blue.bytes);
		expect(red.bytes).toEqual(
			encodeGajaePetGif({ skin: "red", timeline, cellWidthPx: 9, cellHeightPx: 18, targetRows: 2 }).bytes,
		);
		expect(red.frames).toEqual(timeline);
		expect(Buffer.from(red.bytes).toString("latin1")).toContain("NETSCAPE2.0");
		const graphicsControlExtension = red.bytes.findIndex(
			(value, index) => value === 0x21 && red.bytes[index + 1] === 0xf9 && red.bytes[index + 2] === 0x04,
		);
		expect(graphicsControlExtension).toBeGreaterThanOrEqual(0);
		expect(red.bytes[graphicsControlExtension + 3]).toBe(0x09);
		expect(red.bytes[graphicsControlExtension + 6]).toBe(0);
		expect(gifFrameDelays(red.bytes)).toEqual([30, 100]);
		expect(red.multipart.slice(1)).toEqual(encodeITerm2Multipart(red.base64).slice(1));
		expect(red.tmuxDcs).toEqual(wrapITerm2RecordsForTmux(red.multipart));
		expect(red.multipart[0]).toBe(
			`\x1b]1337;MultipartFile=;name=Z2FqYWUtcGV0LmdpZg==;size=${red.bytes.byteLength};width=${red.width}px;height=${red.height}px;inline=1;preserveAspectRatio=0:\x07`,
		);
		expect(red.multipart.at(-1)).toBe("\x1b]1337;FileEnd\x07");
		expect(red.multipart.slice(1, -1).every(record => record.length <= 220)).toBe(true);
		expect(red.tmuxDcs.every(record => Buffer.byteLength(record, "utf8") <= 256)).toBe(true);
	});

	it("supports rectangle geometry and all public timeline helpers", () => {
		const rectangle = encodeGajaePetGif({ rectangle: { width: 7, height: 5 }, timeline: idleTimeline() });
		expect([rectangle.width, rectangle.height]).toEqual([7, 5]);
		expect(workingTimeline()).toEqual([
			{ name: "danceL", delayMs: 300 },
			{ name: "danceR", delayMs: 300 },
			{ name: "base", delayMs: 260 },
			{ name: "flex", delayMs: 480 },
			{ name: "base", delayMs: 260 },
		]);
		const blueBurst = burstTimeline("blue");
		expect(blueBurst.slice(0, workingTimeline().length)).toEqual([...workingTimeline()]);
		expect(blueBurst.slice(workingTimeline().length).map(frame => frame.name)).toEqual([
			"cry1",
			"cry2",
			"cry3",
			"cry1",
			"cry2",
			"cry3",
			"cry1",
			"cry2",
			"cry3",
		]);
		expect(blueBurst.reduce((sum, frame) => sum + frame.delayMs, 0)).toBe(petBurstDurationMs(PET_SKINS.blue.burst));
		expect(previewTimeline("red")).toEqual(burstTimeline("red"));
		expect(petBurstDurationMs(PET_SKINS.red.burst)).toBe(2600);
		expect(petBurstFrame(PET_SKINS.red.burst, 0, 0)).toBe("danceL");
		expect(petBurstFrame(PET_SKINS.red.burst, 2000, 220)).toBe("base");
	});
	it("centers an unchanged two-row sprite inside a transparent three-cell iTerm canvas", () => {
		const timeline = [{ name: "base" as const, delayMs: 100 }];
		const centered = encodeGajaePetGif({
			timeline,
			rectangle: { width: 36, height: 57 },
			displaySize: { width: 4, height: 3 },
			contentInset: { topPx: 9, bottomPx: 10 },
		});
		const unpadded = encodeGajaePetGif({
			timeline,
			rectangle: { width: 36, height: 57 },
			displaySize: { width: 4, height: 3 },
		});

		expect([centered.width, centered.height]).toEqual([36, 57]);
		expect(centered.multipart[0]).toContain("width=4;height=3;");
		// Index zero remains transparent. Verify the odd-height half-cell split
		// leaves exactly 9 transparent top rows and 10 transparent bottom rows.
		const pixels = gifFirstFramePixels(centered.bytes);
		expect(pixels).toHaveLength(36 * 57);
		expect(pixels.slice(0, 36 * 9)).toEqual(Array(36 * 9).fill(0));
		expect(pixels.slice(-36 * 10)).toEqual(Array(36 * 10).fill(0));
		expect(centered.bytes).not.toEqual(unpadded.bytes);
	});

	it("keeps GIF cache bounded and resettable", () => {
		resetGajaePetGifCache();
		expect(getGajaePetGifCacheStats()).toMatchObject({
			size: 0,
			bytes: 0,
			evictions: 0,
			gifBytes: 0,
			multipartBytes: 0,
			tmuxDcsBytes: 0,
			base64Bytes: 0,
		});
		const first = getGajaePetGifCached({ rectangle: { width: 1, height: 1 } });
		const second = getGajaePetGifCached({ rectangle: { width: 2, height: 1 } });
		for (let i = 3; i <= 32; i++) getGajaePetGifCached({ rectangle: { width: i, height: 1 } });
		expect(getGajaePetGifCacheStats().size).toBe(32);
		expect(getGajaePetGifCacheStats().evictions).toBe(0);
		expect(getGajaePetGifCached({ rectangle: { width: 1, height: 1 } })).toBe(first);
		getGajaePetGifCached({ rectangle: { width: 33, height: 1 } });
		expect(getGajaePetGifCacheStats().size).toBe(32);
		expect(getGajaePetGifCacheStats().evictions).toBe(1);
		expect(getGajaePetGifCached({ rectangle: { width: 1, height: 1 } })).toBe(first);
		expect(getGajaePetGifCached({ rectangle: { width: 2, height: 1 } })).not.toBe(second);
		resetGajaePetGifCache();
		expect(getGajaePetGifCacheStats()).toMatchObject({
			size: 0,
			bytes: 0,
			evictions: 0,
			gifBytes: 0,
			multipartBytes: 0,
			tmuxDcsBytes: 0,
		});
	});
	it("keys cached GIF artifacts by terminal display size", () => {
		resetGajaePetGifCache();
		const pixels = { width: 36, height: 36 };
		const pixelSized = getGajaePetGifCached({ rectangle: pixels });
		const cellSized = getGajaePetGifCached({
			rectangle: pixels,
			displaySize: { width: 4, height: 2 },
		});
		expect(cellSized).not.toBe(pixelSized);
		expect(pixelSized.multipart[0]).toContain("width=36px;height=36px;");
		expect(cellSized.multipart[0]).toContain("width=4;height=2;");
		resetGajaePetGifCache();
	});

	it("evicts deterministically at the retained-byte ceiling independently of the entry cap", () => {
		const maxRetainedBytes = 8 * 1024 * 1024;
		resetGajaePetGifCache();
		const first = getGajaePetGifCached({
			rectangle: { width: 512, height: 512 },
			timeline: [{ name: "base", delayMs: 100 }],
		});
		for (let width = 513; width <= 527; width++) {
			getGajaePetGifCached({
				rectangle: { width, height: 512 },
				timeline: [{ name: "base", delayMs: 100 }],
			});
		}
		const stats = getGajaePetGifCacheStats();
		expect(stats.bytes).toBeLessThanOrEqual(maxRetainedBytes);
		expect(stats.base64Bytes).toBeGreaterThan(0);
		expect(stats.bytes).toBe(stats.gifBytes + stats.base64Bytes + stats.multipartBytes + stats.tmuxDcsBytes);
		expect(stats.size).toBeLessThan(32);
		expect(stats.evictions).toBeGreaterThan(0);
		expect(
			getGajaePetGifCached({
				rectangle: { width: 512, height: 512 },
				timeline: [{ name: "base", delayMs: 100 }],
			}),
		).not.toBe(first);
		const repeated = getGajaePetGifCacheStats();
		expect(repeated.bytes).toBeLessThanOrEqual(maxRetainedBytes);
		expect(repeated.bytes).toBe(
			repeated.gifBytes + repeated.base64Bytes + repeated.multipartBytes + repeated.tmuxDcsBytes,
		);
		expect(repeated.size).toBeLessThanOrEqual(32);
		resetGajaePetGifCache();
	});
});
