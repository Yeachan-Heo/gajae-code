import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { Image } from "@gajae-code/tui/components/image";
import {
	type CellDimensions,
	encodeKittyTransmit,
	getCellDimensions,
	ImageProtocol,
	isTerminalGraphicsFallbackActive,
	isWindowsTerminalPreviewSixelSupported,
	kittyImageId,
	renderImage,
	resetKittyTransmissions,
	setCellDimensions,
	setKittyTransmitWriter,
	TERMINAL,
	withTerminalGraphicsFallback,
} from "@gajae-code/tui/terminal-capabilities";

type MutableTerminalInfo = {
	imageProtocol: ImageProtocol | null;
};

const terminal = TERMINAL as unknown as MutableTerminalInfo;
const BASE64_DUMMY = "AA==";
const SQUARE_DIMENSIONS = { widthPx: 100, heightPx: 100 };
const BASE64_ONE_PIXEL_PNG =
	"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAAAAAA6fptVAAAACklEQVR4nGNgAAAAAgABSK+kcQAAAABJRU5ErkJggg==";

function parseKittyParam(sequence: string, key: "c" | "r" | "i" | "p"): number | null {
	const match = sequence.match(new RegExp(`(?:^|[,;\\x1b_G])${key}=(\\d+)`));
	if (!match) return null;
	return Number.parseInt(match[1], 10);
}

function parseITermWidth(sequence: string): string | null {
	const match = sequence.match(/width=([^;:]+)/);
	return match?.[1] ?? null;
}

/**
 * Minimal model of kitty graphics terminal state. Implements the spec rules
 * that matter for placement lifecycles:
 * - transmitting data (a=t / a=T) without i= creates a fresh anonymous image
 *   every time; with a=T each emission also creates a NEW placement — the
 *   original stacking bug;
 * - transmitting data for an EXISTING client image id deletes the image and
 *   all of its placements before storing the new data;
 * - a=p creates-or-replaces exactly the (i, p) placement it names.
 */
class KittyTerminalModel {
	images = new Map<string, string>();
	placements = new Map<string, string>(); // "imageKey:placementId" -> imageKey
	#autoPlacementCounter = 0;
	#anonImageCounter = 0;
	#pending?: { params: Map<string, string>; data: string };

	apply(output: string): void {
		const escapeRegex = /\x1b_G([^;\x1b]*)(?:;([^\x1b]*))?\x1b\\/g;
		let match: RegExpExecArray | null = escapeRegex.exec(output);
		while (match) {
			const params = new Map<string, string>();
			for (const part of (match[1] ?? "").split(",")) {
				const eq = part.indexOf("=");
				if (eq > 0) params.set(part.slice(0, eq), part.slice(eq + 1));
			}
			const data = match[2] ?? "";

			if (this.#pending) {
				this.#pending.data += data;
				if (params.get("m") !== "1") {
					const done = this.#pending;
					this.#pending = undefined;
					this.#finishTransmission(done.params, done.data);
				}
			} else {
				const action = params.get("a") ?? "t";
				if (action === "t" || action === "T") {
					if (params.get("m") === "1") {
						this.#pending = { params, data };
					} else {
						this.#finishTransmission(params, data);
					}
				} else if (action === "p") {
					const imageKey = params.get("i");
					if (imageKey && this.images.has(imageKey)) {
						const placementId = params.get("p") ?? `auto${++this.#autoPlacementCounter}`;
						this.placements.set(`${imageKey}:${placementId}`, imageKey);
					}
				}
			}
			match = escapeRegex.exec(output);
		}
	}

	#finishTransmission(params: Map<string, string>, data: string): void {
		// Without a client id every transmission stores a fresh anonymous image.
		const imageKey = params.get("i") ?? `anon${++this.#anonImageCounter}`;
		if (this.images.has(imageKey)) {
			// Spec: re-transmitting an existing id deletes the image AND all placements.
			this.images.delete(imageKey);
			for (const key of Array.from(this.placements.keys())) {
				if (key.startsWith(`${imageKey}:`)) this.placements.delete(key);
			}
		}
		this.images.set(imageKey, data);
		if (params.get("a") === "T") {
			const placementId = params.get("p") ?? `auto${++this.#autoPlacementCounter}`;
			this.placements.set(`${imageKey}:${placementId}`, imageKey);
		}
	}
}

describe("terminal image rendering", () => {
	const originalProtocol = TERMINAL.imageProtocol;
	let originalCellDims: CellDimensions;

	beforeEach(() => {
		originalCellDims = { ...getCellDimensions() };
		setCellDimensions({ widthPx: 10, heightPx: 10 });
		terminal.imageProtocol = null;
		resetKittyTransmissions();
		setKittyTransmitWriter(() => {});
	});

	afterEach(() => {
		setCellDimensions(originalCellDims);
		terminal.imageProtocol = originalProtocol;
		setKittyTransmitWriter(sequence => process.stdout.write(sequence));
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

	it("uses textual image fallback only within scoped graphics fallback", () => {
		terminal.imageProtocol = ImageProtocol.Sixel;
		const image = new Image(
			BASE64_ONE_PIXEL_PNG,
			"image/png",
			{ fallbackColor: text => text },
			{ maxWidthCells: 10, maxHeightCells: 2, refetch: () => BASE64_ONE_PIXEL_PNG },
			SQUARE_DIMENSIONS,
		);

		expect(image.render(20).join("\n")).toContain("\x1bP");
		const fallbackLines = withTerminalGraphicsFallback(() => image.render(20));
		expect(fallbackLines.join("\n")).toContain("[image/png");
		expect(fallbackLines.join("\n")).not.toContain("\x1bP");
		expect(image.render(20).join("\n")).toContain("\x1bP");
	});

	it("restores nested graphics fallback state after exceptions", () => {
		expect(isTerminalGraphicsFallbackActive()).toBe(false);
		expect(() =>
			withTerminalGraphicsFallback(() =>
				withTerminalGraphicsFallback(() => {
					expect(isTerminalGraphicsFallbackActive()).toBe(true);
					throw new Error("expected");
				}),
			),
		).toThrow("expected");
		expect(isTerminalGraphicsFallbackActive()).toBe(false);
	});

	it("permits kitty images inside an opted-in graphics fallback scope", () => {
		terminal.imageProtocol = ImageProtocol.Kitty;
		const image = new Image(
			BASE64_ONE_PIXEL_PNG,
			"image/png",
			{ fallbackColor: text => text },
			{ maxWidthCells: 10, maxHeightCells: 2, refetch: () => BASE64_ONE_PIXEL_PNG },
			SQUARE_DIMENSIONS,
		);

		// Plain fallback scope still suppresses kitty.
		const suppressed = withTerminalGraphicsFallback(() => image.render(20));
		expect(suppressed.join("\n")).toContain("[image/png");
		expect(suppressed.join("\n")).not.toContain("\x1b_G");

		// Opted-in scope renders the cursor-neutral kitty placement.
		const permitted = withTerminalGraphicsFallback(() => image.render(20), { allowCursorNeutralImages: true });
		expect(permitted.join("\n")).toContain("\x1b_G");

		// Outside any scope, unchanged.
		expect(image.render(20).join("\n")).toContain("\x1b_G");
	});

	it("keeps cursor-advancing protocols suppressed in an opted-in fallback scope", () => {
		terminal.imageProtocol = ImageProtocol.Sixel;
		const image = new Image(
			BASE64_ONE_PIXEL_PNG,
			"image/png",
			{ fallbackColor: text => text },
			{ maxWidthCells: 10, maxHeightCells: 2, refetch: () => BASE64_ONE_PIXEL_PNG },
			SQUARE_DIMENSIONS,
		);

		const permitted = withTerminalGraphicsFallback(() => image.render(20), { allowCursorNeutralImages: true });
		expect(permitted.join("\n")).toContain("[image/png");
		expect(permitted.join("\n")).not.toContain("\x1bP");
	});

	it("revokes cursor-neutral permission in nested scopes that do not opt in", () => {
		terminal.imageProtocol = ImageProtocol.Kitty;
		const image = new Image(
			BASE64_ONE_PIXEL_PNG,
			"image/png",
			{ fallbackColor: text => text },
			{ maxWidthCells: 10, maxHeightCells: 2, refetch: () => BASE64_ONE_PIXEL_PNG },
			SQUARE_DIMENSIONS,
		);

		const lines = withTerminalGraphicsFallback(() => withTerminalGraphicsFallback(() => image.render(20)), {
			allowCursorNeutralImages: true,
		});
		expect(lines.join("\n")).toContain("[image/png");
		expect(lines.join("\n")).not.toContain("\x1b_G");
	});

	it("Image component places the kitty escape on the first row without cursor-up", () => {
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
		expect(lines[0]).toContain("a=p");
		expect(lines[0]).toContain("c=2");
		expect(lines[0]).toContain("r=2");
		expect(lines[0]).toContain("C=1");
		expect(lines[0]).not.toContain("\x1b[1A");
		expect(lines[1]).toBe("");
	});

	it("Image component keeps the cursor-up layout for cursor-advancing protocols", () => {
		terminal.imageProtocol = ImageProtocol.Iterm2;
		const image = new Image(
			BASE64_DUMMY,
			"image/png",
			{ fallbackColor: text => text },
			{ maxWidthCells: 10, maxHeightCells: 2 },
			SQUARE_DIMENSIONS,
		);

		const lines = image.render(20);

		expect(lines).toHaveLength(2);
		expect(lines[0]).toBe("");
		expect(lines[1]).toContain("\x1b[1A");
	});
});

describe("kitty transmit/placement split (dedup on repaint)", () => {
	const originalProtocol = TERMINAL.imageProtocol;
	let originalCellDims: CellDimensions;
	let transmitted: string[];

	beforeEach(() => {
		originalCellDims = { ...getCellDimensions() };
		setCellDimensions({ widthPx: 10, heightPx: 10 });
		terminal.imageProtocol = ImageProtocol.Kitty;
		resetKittyTransmissions();
		transmitted = [];
		setKittyTransmitWriter(sequence => transmitted.push(sequence));
	});

	afterEach(() => {
		setCellDimensions(originalCellDims);
		terminal.imageProtocol = originalProtocol;
		setKittyTransmitWriter(sequence => process.stdout.write(sequence));
	});

	it("derives a stable non-zero image id from content", () => {
		const a = kittyImageId(BASE64_DUMMY);
		const b = kittyImageId(BASE64_DUMMY);
		const c = kittyImageId(BASE64_ONE_PIXEL_PNG);

		expect(a).toBe(b);
		expect(a).not.toBe(0);
		expect(a).not.toBe(c);
	});

	it("transmits image data exactly once per image id across renders", () => {
		const first = renderImage(BASE64_DUMMY, SQUARE_DIMENSIONS, { maxWidthCells: 10, maxHeightCells: 2 });
		const second = renderImage(BASE64_DUMMY, SQUARE_DIMENSIONS, { maxWidthCells: 10, maxHeightCells: 2 });

		expect(transmitted).toHaveLength(1);
		expect(transmitted[0]).toContain("a=t");
		expect(transmitted[0]).toContain(`i=${kittyImageId(BASE64_DUMMY)}`);
		// Returned sequences are placement-only: no pixel payload, idempotent.
		expect(first?.sequence).toBe(second?.sequence ?? "");
		expect(first?.sequence).toContain("a=p");
		expect(first?.sequence).not.toContain(BASE64_DUMMY);
	});

	it("carries i= on the first chunk of chunked transmissions", () => {
		const longData = "A".repeat(9000);
		const sequence = encodeKittyTransmit(longData, 42);
		const chunks = sequence.split("\x1b\\").filter(Boolean);

		expect(chunks.length).toBeGreaterThan(1);
		expect(chunks[0]).toContain("a=t");
		expect(chunks[0]).toContain("i=42");
		expect(chunks[0]).toContain("m=1");
		expect(chunks.at(-1)).toContain("m=0");
	});

	it("repainting one component does not delete a sibling placement with identical content", () => {
		const makeImage = () =>
			new Image(
				BASE64_DUMMY,
				"image/png",
				{ fallbackColor: text => text },
				{ maxWidthCells: 10, maxHeightCells: 2 },
				SQUARE_DIMENSIONS,
			);

		const componentA = makeImage();
		const componentB = makeImage();
		const model = new KittyTerminalModel();

		// Initial paint of both components.
		const linesA = componentA.render(20).join("\n");
		const linesB = componentB.render(20).join("\n");
		for (const transmit of transmitted) model.apply(transmit);
		model.apply(linesA);
		model.apply(linesB);

		expect(model.images.size).toBe(1);
		expect(model.placements.size).toBe(2);
		expect(transmitted).toHaveLength(1);

		// Diff-renderer repaints A's line (e.g. transcript scrolled): the same
		// cached line is re-emitted. B's placement must survive.
		const placementsBefore = new Set(model.placements.keys());
		model.apply(linesA);
		model.apply(linesA);

		expect(model.placements.size).toBe(2);
		expect(new Set(model.placements.keys())).toEqual(placementsBefore);
		expect(transmitted).toHaveLength(1);
	});

	it("legacy a=T emission stacks placements in the terminal model (regression contrast)", () => {
		// Documents the failure mode this change fixes: bare a=T without ids
		// stores a fresh anonymous image AND a new placement on every repaint.
		const model = new KittyTerminalModel();
		const legacy = `\x1b_Ga=T,f=100,q=2,c=2,r=2;${BASE64_DUMMY}\x1b\\`;

		model.apply(legacy);
		model.apply(legacy);
		model.apply(legacy);

		expect(model.placements.size).toBe(3);
		expect(model.images.size).toBe(3);
	});

	it("re-renders of the same Image component reuse the same placement", () => {
		const image = new Image(
			BASE64_DUMMY,
			"image/png",
			{ fallbackColor: text => text },
			{ maxWidthCells: 10, maxHeightCells: 2, refetch: () => BASE64_DUMMY },
			SQUARE_DIMENSIONS,
		);
		const model = new KittyTerminalModel();

		const first = image.render(20).join("\n");
		image.invalidate();
		const second = image.render(20).join("\n");

		for (const transmit of transmitted) model.apply(transmit);
		model.apply(first);
		model.apply(second);

		expect(second).toBe(first);
		expect(model.placements.size).toBe(1);
		expect(transmitted).toHaveLength(1);
	});

	it("Image component releases source base64 after successful protocol render", () => {
		terminal.imageProtocol = ImageProtocol.Kitty;
		const image = new Image(
			BASE64_DUMMY,
			"image/png",
			{ fallbackColor: text => text },
			{ maxWidthCells: 10 },
			SQUARE_DIMENSIONS,
		);

		const lines = image.render(20);

		expect(lines[0]).toContain("\x1b_G");
		expect(image.retainedBase64DataForTest).toBeUndefined();
	});

	it("Image component refetches released base64 when an invalidated render needs re-encoding", () => {
		terminal.imageProtocol = ImageProtocol.Kitty;
		let refetchCount = 0;
		const image = new Image(
			BASE64_DUMMY,
			"image/png",
			{ fallbackColor: text => text },
			{
				maxWidthCells: 10,
				refetch: () => {
					refetchCount++;
					return BASE64_DUMMY;
				},
			},
			SQUARE_DIMENSIONS,
		);

		image.render(20);
		image.invalidate();
		const lines = image.render(12);

		expect(refetchCount).toBe(1);
		expect(lines[0]).toContain("\x1b_G");
		expect(image.retainedBase64DataForTest).toBeUndefined();
	});

	it("Image component falls back gracefully after invalidation when released base64 cannot be refetched", () => {
		terminal.imageProtocol = ImageProtocol.Kitty;
		const image = new Image(
			BASE64_DUMMY,
			"image/png",
			{ fallbackColor: text => `fallback:${text}` },
			{ maxWidthCells: 10, filename: "sample.png" },
			SQUARE_DIMENSIONS,
		);

		image.render(20);
		image.invalidate();
		const lines = image.render(12);

		expect(lines).toHaveLength(1);
		expect(lines[0]).toContain("fallback:");
		expect(lines[0]).toContain("sample.png");
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
