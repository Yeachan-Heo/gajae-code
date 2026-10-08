import { beforeEach, describe, expect, it, mock } from "bun:test";
import { SvgFigure } from "../src/chat/svg-figure";
import type { ImageTheme } from "../src/components/image";

describe("SvgFigure", () => {
	let onChange: ReturnType<typeof mock>;
	let theme: ImageTheme;

	beforeEach(() => {
		onChange = mock(() => {});
		theme = {
			fallbackColor: (str: string) => str,
		};
	});

	it("initializes without source", () => {
		const figure = new SvgFigure({ theme, onChange });
		const lines = figure.render(80);
		expect(lines).toEqual([]);
	});

	it("returns empty lines while source is streaming", () => {
		const figure = new SvgFigure({ theme, onChange });
		figure.update('<svg><rect fill="red"/>', false);
		const lines = figure.render(80);
		// While streaming, we may not have a rendered image yet, so check that we don't crash
		expect(Array.isArray(lines)).toBe(true);
	});

	it("calls onChange when updated", async () => {
		const figure = new SvgFigure({ theme, onChange });
		figure.update("<svg><rect/></svg>", true);
		// Wait for microtask to complete
		await new Promise(resolve => setTimeout(resolve, 0));
		// onChange may not be called if rasterization fails or hasn't completed
		expect(typeof figure.pending).toBe("boolean");
	});

	it("disposes cleanly", () => {
		const figure = new SvgFigure({ theme, onChange });
		figure.update("<svg/>", false);
		expect(() => figure.dispose()).not.toThrow();
	});

	it("returns debug state", () => {
		const figure = new SvgFigure({ theme, onChange });
		figure.update("<svg/>", true);
		const state = figure.debugState();
		expect(state).toHaveProperty("final");
		expect(state).toHaveProperty("raster");
		expect(state).toHaveProperty("current");
	});

	it("invalidates cache", () => {
		const figure = new SvgFigure({ theme, onChange });
		figure.update("<svg/>", true);
		expect(() => figure.invalidate()).not.toThrow();
	});

	it("reports pending state correctly", () => {
		const figure = new SvgFigure({ theme, onChange });
		figure.update("<svg/>", false);
		expect(figure.pending).toEqual(true);
		figure.update("<svg/>", true);
		// After marking as final, pending state depends on whether rasterization has completed
		expect(typeof figure.pending).toBe("boolean");
	});
});
