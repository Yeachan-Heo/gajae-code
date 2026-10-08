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

	it("recovers after a failed final source is replaced by valid SVG", async () => {
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
		}
	});
});
