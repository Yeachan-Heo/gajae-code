import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { Image } from "@gajae-code/tui/components/image";
import {
	type CellDimensions,
	encodeKitty,
	getCellDimensions,
	ImageProtocol,
	isWindowsTerminalPreviewSixelSupported,
	kittyImageId,
	renderImage,
	setCellDimensions,
	TERMINAL,
} from "@gajae-code/tui/terminal-capabilities";

type MutableTerminalInfo = {
	imageProtocol: ImageProtocol | null;
};

const terminal = TERMINAL as unknown as MutableTerminalInfo;
const BASE64_DUMMY = "AA==";
const SQUARE_DIMENSIONS = { widthPx: 100, heightPx: 100 };
const BASE64_ONE_PIXEL_PNG =
	"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAAAAAA6fptVAAAACklEQVR4nGNgAAAAAgABSK+kcQAAAABJRU5ErkJggg==";

function parseKittyParam(sequence: string, key: "c" | "r"): number | null {
	const match = sequence.match(new RegExp(`${key}=(\\d+)`));
	if (!match) return null;
	return Number.parseInt(match[1], 10);
}

function parseITermWidth(sequence: string): string | null {
	const match = sequence.match(/width=([^;:]+)/);
	return match?.[1] ?? null;
}

describe("terminal image rendering", () => {
	const originalProtocol = TERMINAL.imageProtocol;
	let originalCellDims: CellDimensions;

	beforeEach(() => {
		originalCellDims = { ...getCellDimensions() };
		setCellDimensions({ widthPx: 10, heightPx: 10 });
		terminal.imageProtocol = null;
	});

	afterEach(() => {
		setCellDimensions(originalCellDims);
		terminal.imageProtocol = originalProtocol;
	});

	it("fits Kitty images within max width and max height while preserving aspect ratio", () => {
		terminal.imageProtocol = ImageProtocol.Kitty;
		const result = renderImage(BASE64_DUMMY, SQUARE_DIMENSIONS, {
			maxWidthCells: 10,
			maxHeightCells: 2,
		});

		expect(result).not.toBeNull();
		expect(result?.rows).toBe(2);
		expect(parseKittyParam(result?.sequence ?? "", "c")).toBe(2);
		expect(parseKittyParam(result?.sequence ?? "", "r")).toBe(2);
	});

	it("uses intrinsic image size when no bounds are provided", () => {
		terminal.imageProtocol = ImageProtocol.Kitty;
		const result = renderImage(BASE64_DUMMY, SQUARE_DIMENSIONS);

		expect(result).not.toBeNull();
		expect(result?.rows).toBe(10);
		expect(parseKittyParam(result?.sequence ?? "", "c")).toBe(10);
		expect(parseKittyParam(result?.sequence ?? "", "r")).toBe(10);
	});

	it("reduces iTerm2 width when max height is the limiting bound", () => {
		terminal.imageProtocol = ImageProtocol.Iterm2;
		const result = renderImage(BASE64_DUMMY, SQUARE_DIMENSIONS, {
			maxWidthCells: 10,
			maxHeightCells: 2,
		});

		expect(result).not.toBeNull();
		expect(result?.rows).toBe(2);
		expect(parseITermWidth(result?.sequence ?? "")).toBe("2");
		expect(result?.sequence).toContain("height=auto");
	});

	it("encodes SIXEL output when protocol is SIXEL", () => {
		terminal.imageProtocol = ImageProtocol.Sixel;
		const result = renderImage(BASE64_ONE_PIXEL_PNG, SQUARE_DIMENSIONS, {
			maxWidthCells: 10,
			maxHeightCells: 2,
		});

		expect(result).not.toBeNull();
		expect(result?.rows).toBe(2);
		expect(result?.sequence.startsWith("\x1bP")).toBe(true);
	});

	it("Image component forwards maxHeightCells to terminal rendering", () => {
		terminal.imageProtocol = ImageProtocol.Kitty;
		const image = new Image(
			BASE64_DUMMY,
			"image/png",
			{ fallbackColor: text => text },
			{ maxWidthCells: 10, maxHeightCells: 2 },
			SQUARE_DIMENSIONS,
		);

		const lines = image.render(20);

		expect(lines).toHaveLength(2);
		expect(lines[1]).toContain("\x1b[1A");
		expect(lines[1]).toContain("c=2");
		expect(lines[1]).toContain("r=2");
	});
});

describe("Windows Terminal Preview SIXEL detection", () => {
	it("requires Windows platform, WT session, and known version 1.22+", () => {
		expect(
			isWindowsTerminalPreviewSixelSupported(
				{ WT_SESSION: "1", TERM_PROGRAM: "Windows_Terminal", TERM_PROGRAM_VERSION: "1.22.2362.0" },
				"win32",
			),
		).toBe(true);
		expect(
			isWindowsTerminalPreviewSixelSupported(
				{ WT_SESSION: "1", TERM_PROGRAM: "Windows_Terminal", TERM_PROGRAM_VERSION: "1.21.0.0" },
				"win32",
			),
		).toBe(false);
		expect(
			isWindowsTerminalPreviewSixelSupported({ WT_SESSION: "1", TERM_PROGRAM: "Windows_Terminal" }, "win32"),
		).toBe(false);
		expect(
			isWindowsTerminalPreviewSixelSupported(
				{ WT_SESSION: "1", TERM_PROGRAM: "Windows_Terminal", TERM_PROGRAM_VERSION: "1.22.2362.0" },
				"linux",
			),
		).toBe(false);
	});
});

describe("kitty placement identity (dedup on repaint)", () => {
	const originalProtocol = TERMINAL.imageProtocol;
	let originalCellDims: CellDimensions;

	beforeEach(() => {
		originalCellDims = { ...getCellDimensions() };
		setCellDimensions({ widthPx: 10, heightPx: 10 });
		terminal.imageProtocol = ImageProtocol.Kitty;
	});

	afterEach(() => {
		setCellDimensions(originalCellDims);
		terminal.imageProtocol = originalProtocol;
	});

	it("derives a stable non-zero image id from content", () => {
		const a = kittyImageId(BASE64_DUMMY);
		const b = kittyImageId(BASE64_DUMMY);
		const c = kittyImageId(BASE64_ONE_PIXEL_PNG);

		expect(a).toBe(b);
		expect(a).not.toBe(0);
		expect(a).not.toBe(c);
	});

	it("emits identical i= and p= for repeated renders of the same content", () => {
		const first = renderImage(BASE64_DUMMY, SQUARE_DIMENSIONS, { maxWidthCells: 10, maxHeightCells: 2 });
		const second = renderImage(BASE64_DUMMY, SQUARE_DIMENSIONS, { maxWidthCells: 10, maxHeightCells: 2 });

		expect(first?.sequence).toBe(second?.sequence);
		expect(first?.sequence).toContain(`i=${kittyImageId(BASE64_DUMMY)}`);
		expect(first?.sequence).toContain("p=1");
	});

	it("gives distinct Image components distinct placement ids but the same image id", () => {
		const makeImage = () =>
			new Image(
				BASE64_DUMMY,
				"image/png",
				{ fallbackColor: text => text },
				{ maxWidthCells: 10, maxHeightCells: 2 },
				SQUARE_DIMENSIONS,
			);

		const lineA = makeImage().render(20).at(-1) ?? "";
		const lineB = makeImage().render(20).at(-1) ?? "";

		const imageIdOf = (line: string) => line.match(/i=(\d+)/)?.[1];
		const placementIdOf = (line: string) => line.match(/p=(\d+)/)?.[1];

		expect(imageIdOf(lineA)).toBeDefined();
		expect(imageIdOf(lineA)).toBe(imageIdOf(lineB));
		expect(placementIdOf(lineA)).toBeDefined();
		expect(placementIdOf(lineA)).not.toBe(placementIdOf(lineB));
	});

	it("re-renders of the same Image component reuse the same placement id", () => {
		const image = new Image(
			BASE64_DUMMY,
			"image/png",
			{ fallbackColor: text => text },
			{ maxWidthCells: 10, maxHeightCells: 2 },
			SQUARE_DIMENSIONS,
		);

		const first = image.render(20).at(-1) ?? "";
		image.invalidate();
		const second = image.render(20).at(-1) ?? "";

		expect(second).toBe(first);
	});

	it("carries i= and p= on the first chunk of chunked transmissions", () => {
		const longData = "A".repeat(9000);
		const sequence = encodeKitty(longData, { columns: 4, rows: 2, imageId: 42, placementId: 7 });
		const chunks = sequence.split("\x1b\\").filter(Boolean);

		expect(chunks.length).toBeGreaterThan(1);
		expect(chunks[0]).toContain("i=42");
		expect(chunks[0]).toContain("p=7");
		expect(chunks[0]).toContain("m=1");
		expect(chunks.at(-1)).toContain("m=0");
	});
});
