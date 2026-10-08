import { beforeEach, describe, expect, it } from "bun:test";
import { SvgFigure } from "../src/chat/svg-figure";
import type { ImageTheme } from "../src/components/image";
import {
	getCellDimensions,
	ImageProtocol,
	setCellDimensions,
	setTerminalImageProtocol,
	TERMINAL,
} from "../src/terminal-capabilities";

const SVG = '<svg width="12" height="7" viewBox="0 0 12 7"><rect width="12" height="7" fill="#f00"/></svg>';
const WIDE_SVG =
	'<svg width="800" height="400" viewBox="0 0 800 400"><rect width="800" height="400" fill="#f00"/></svg>';

describe("SvgFigure", () => {
	let theme: ImageTheme;
	const palette = { fg: "#ffffff" };

	beforeEach(() => {
		theme = {
			fallbackColor: (str: string) => str,
		};
	});

	it("initializes without source", () => {
		const figure = new SvgFigure({ theme, palette, onChange: () => {} });
		const lines = figure.render(80);
		expect(lines).toEqual([]);
	});

	it("rerenders retained raster bytes after invalidating its image cache", async () => {
		const previousProtocol = TERMINAL.imageProtocol;
		const previousCellDimensions = getCellDimensions();
		setTerminalImageProtocol(ImageProtocol.Kitty);
		setCellDimensions({ widthPx: 9, heightPx: 18 });
		const rasterized = Promise.withResolvers<void>();
		const figure = new SvgFigure({ theme, palette, onChange: () => rasterized.resolve() });
		try {
			figure.update(SVG, true);
			expect(figure.render(80)).toEqual([]);
			await rasterized.promise;
			expect(figure.pending).toBe(false);

			const first = figure.render(80).join("");
			expect(first).toContain("\x1b_G");
			expect(figure.debugState()).toMatchObject({ current: true, failed: false, raster: "18x18" });

			figure.invalidate();
			const afterInvalidate = figure.render(80).join("");
			expect(afterInvalidate).toContain("\x1b_G");
		} finally {
			figure.dispose();
			setCellDimensions(previousCellDimensions);
			setTerminalImageProtocol(previousProtocol);
		}
	});

	it("suppresses terminal-image placeholders and notifies the parent when graphics disappear", async () => {
		const previousProtocol = TERMINAL.imageProtocol;
		const rasterized = Promise.withResolvers<void>();
		let changes = 0;
		const figure = new SvgFigure({
			theme,
			palette,
			onChange: () => {
				changes++;
				rasterized.resolve();
			},
		});
		setTerminalImageProtocol(ImageProtocol.Kitty);
		try {
			figure.update(SVG, true);
			figure.render(80);
			await rasterized.promise;
			expect(figure.render(80).join("")).toContain("\x1b_G");

			const changesBeforeFallback = changes;
			setTerminalImageProtocol(null);
			expect(figure.render(80)).toEqual([]);
			expect(changes).toBe(changesBeforeFallback + 1);
			expect(figure.render(80)).toEqual([]);
			expect(changes).toBe(changesBeforeFallback + 1);
		} finally {
			figure.dispose();
			setTerminalImageProtocol(previousProtocol);
		}
	});

	it("rerasterizes when the viewport height changes at the same terminal width", async () => {
		const previousProtocol = TERMINAL.imageProtocol;
		const previousRows = Object.getOwnPropertyDescriptor(process.stdout, "rows");
		const previousCellDimensions = getCellDimensions();
		setTerminalImageProtocol(ImageProtocol.Kitty);
		Object.defineProperty(process.stdout, "rows", { configurable: true, value: 24 });
		setCellDimensions({ widthPx: 9, heightPx: 18 });
		let changed = Promise.withResolvers<void>();
		const figure = new SvgFigure({ theme, palette, onChange: () => changed.resolve() });
		try {
			figure.update(WIDE_SVG, true);
			figure.render(80);
			await changed.promise;
			expect(figure.debugState().raster).toBe("684x342");

			changed = Promise.withResolvers<void>();
			Object.defineProperty(process.stdout, "rows", { configurable: true, value: 6 });
			figure.render(80);
			await changed.promise;
			expect(figure.debugState().raster).toBe("144x72");

			changed = Promise.withResolvers<void>();
			setCellDimensions({ widthPx: 9, heightPx: 36 });
			figure.render(80);
			await changed.promise;
			expect(figure.debugState().raster).toBe("288x144");
		} finally {
			figure.dispose();
			setCellDimensions(previousCellDimensions);
			setTerminalImageProtocol(previousProtocol);
			if (previousRows) Object.defineProperty(process.stdout, "rows", previousRows);
			else Reflect.deleteProperty(process.stdout, "rows");
		}
	});

	it("recovers after a failed final source is replaced by valid SVG", async () => {
		const previousProtocol = TERMINAL.imageProtocol;
		setTerminalImageProtocol(ImageProtocol.Kitty);
		let changed = Promise.withResolvers<void>();
		const figure = new SvgFigure({ theme, palette, onChange: () => changed.resolve() });
		try {
			figure.update("not an SVG document", true);
			figure.render(80);
			await changed.promise;
			expect(figure.failed).toBe(true);

			changed = Promise.withResolvers<void>();
			figure.update(SVG, true);
			figure.render(80);
			await changed.promise;
			expect(figure.failed).toBe(false);
			expect(figure.debugState()).toMatchObject({ current: true, failed: false });
		} finally {
			figure.dispose();
			setTerminalImageProtocol(previousProtocol);
		}
	});
});
