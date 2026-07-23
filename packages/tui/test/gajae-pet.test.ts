import { describe, expect, it } from "bun:test";
import {
	__gajaePetTestHooks,
	buildGajaePixelFrames,
	burstTimeline,
	encodeGajaePetGif,
	encodeGridSixel,
	getGajaePetGifCached,
	getGajaePetGifCacheStats,
	idleTimeline,
	PET_SKINS,
	petBurstDurationMs,
	petBurstFrame,
	previewTimeline,
	resetGajaePetGifCache,
	workingTimeline,
} from "@gajae-code/tui";
import { encodeITerm2Multipart, wrapITerm2RecordsForTmux } from "../src/terminal-capabilities";

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
