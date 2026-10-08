/**
 * A ```svg fence drawn as an inline terminal image. The source is rasterized
 * off the JS thread and shown through {@link Image}; while the fence streams,
 * each throttled revision repairs the partial source and replaces the
 * previous raster, which stays on screen until the next one lands.
 *
 * Sizing is natural rather than preview-capped: one terminal row spans
 * {@link UNITS_PER_ROW} SVG user units, so `font-size="14"` text lands near
 * the terminal's own glyph size and the figure takes as many columns as its
 * drawing needs — up to the full width, and a viewport-relative height. The
 * raster is drawn at the terminal's device pixels per unit, padded to whole
 * cells, and redrawn when the room it is shown in changes, so the terminal
 * places it 1:1: any resampling, even 0.99×, blurs every glyph edge.
 *
 * Ported from oh-my-pi (MIT) packages/tui/src/chat/svg-figure.ts
 */
import { Image, type ImageOptions as ImageComponentOptions } from "../components/image";
import type { CellDimensions } from "../terminal-capabilities";
import type { Component } from "../tui";
import { closePartialSvg, prepareSvg } from "./svg-source";

/** Budget for tracking terminal image allocations. */
export interface ImageBudget {
	release(key: string): void;
}

/** SVG user units per terminal row; a 1000-unit-wide drawing spans ~125 columns of 1:2 cells. */
// biome-ignore lint/correctness/noUnusedVariables: documented design constant
const UNITS_PER_ROW = 16;
/** Least time between rasters of a fence that is still streaming. */
const STREAM_INTERVAL_MS = 200;
/** Longest raster edge; the native rasterizer caps the surface at 4096² pixels. */
const MAX_EDGE_PX = 4096;
/** Share of the terminal's rows one figure may fill, so it fits on screen whole. */
const MAX_VIEWPORT_SHARE = 0.8;

/** Cells a figure may fill. */
interface Limits {
	columns: number;
	rows: number;
}

/** One rasterized revision and the inputs that produced it. */
interface Raster {
	source: string;
	/** Cell size the raster was padded to; its pixels are whole cells of it. */
	cell: CellDimensions;
	limits: Limits;
	/** Base64 PNG. */
	data: string;
	widthPx: number;
	heightPx: number;
	/** Budget key; one per revision so a new raster is a new terminal image. */
	key: string;
}

/** Inputs of a raster attempt, successful or not. */
interface Attempt {
	source: string;
	cell: CellDimensions;
	limits: Limits;
	final: boolean;
}

let nextFigureId = 0;

/** Lazy-loaded rasterizeSvg function from natives. */
let rasterizeSvgFn: ((input: Uint8Array, maxWidthPx: number, maxHeightPx: number) => Promise<Uint8Array>) | undefined;

async function getRasterizeSvg() {
	if (!rasterizeSvgFn) {
		const natives = await import("@gajae-code/natives");
		rasterizeSvgFn = (natives as any).rasterizeSvg;
	}
	return rasterizeSvgFn;
}

/** Cells a figure rendered at `width` may fill: the image's width, a share of the viewport, and the raster edge cap. */
function limitsFor(width: number, cell: CellDimensions): Limits {
	const viewportRows = Math.floor((process.stdout.rows || 24) * MAX_VIEWPORT_SHARE);
	return {
		columns: Math.min(width, Math.floor(MAX_EDGE_PX / cell.widthPx)),
		rows: Math.max(1, Math.min(viewportRows, Math.floor(MAX_EDGE_PX / cell.heightPx))),
	};
}

export interface SvgFigureOptions {
	/**
	 * Color palette for SVG variable substitution. Maps CSS variable names to hex colors.
	 * Required keys: `fg` (foreground text color).
	 * Example: { fg: "#e5e5e7", accent: "#0099ff", ... }
	 */
	colorPalette: Readonly<Record<string, string>>;
	/** Shared inline-image budget; superseded rasters are released from it. */
	budget?: ImageBudget;
	/** The figure's rows changed outside a text update: a raster landed or rendering fell back to code. */
	onChange: () => void;
	/** Theme fallback color for text when image cannot render */
	fallbackColor?: (text: string) => string;
	/** Get current cell dimensions */
	getCellDimensions: () => CellDimensions;
}

export class SvgFigure implements Component {
	readonly #options: SvgFigureOptions;
	readonly #id = nextFigureId++;
	#source = "";
	/** No more text arrives for this fence: no throttling, and a failed raster falls back to code. */
	#final = false;
	#revision = 0;
	#raster: Raster | undefined;
	#attempt: Attempt | undefined;
	#rasterizing = false;
	#startedAt = Number.NEGATIVE_INFINITY;
	#timer: NodeJS.Timeout | undefined;
	#disposed = false;
	/** Last render width; rasters wait for the first render to know their room. */
	#width: number | undefined;
	#image: { raster: Raster; component: Image } | undefined;
	#placeholder: string[] = [];

	constructor(options: SvgFigureOptions) {
		this.#options = options;
	}

	/** Feed the fence body; `final` once the fence closed or the message stopped streaming. */
	update(source: string, final: boolean): void {
		if (source === this.#source && final === this.#final) return;
		this.#source = source;
		this.#final = final;
		this.#schedule();
	}

	dispose(): void {
		this.#disposed = true;
		clearTimeout(this.#timer);
		this.#timer = undefined;
	}

	invalidate(): void {
		if (this.#image) {
			this.#image.component.invalidate();
		}
	}

	debugState(): Record<string, unknown> {
		return {
			final: this.#final,
			raster: this.#raster ? `${this.#raster.widthPx}x${this.#raster.heightPx}` : null,
			current: this.#raster?.source === this.#source,
		};
	}

	/** Whether the current source, cell size has not been attempted yet. */
	#stale(width: number): boolean {
		const attempt = this.#attempt;
		const cell = this.#options.getCellDimensions();
		const limits = limitsFor(width, cell);
		return (
			attempt === undefined ||
			attempt.source !== this.#source ||
			attempt.cell.widthPx !== cell.widthPx ||
			attempt.cell.heightPx !== cell.heightPx ||
			// A streaming attempt that failed is retried once as final.
			(this.#final && !attempt.final && this.#raster?.source !== this.#source) ||
			((attempt.limits.columns !== limits.columns || attempt.limits.rows !== limits.rows) && this.#outgrown(limits))
		);
	}

	/**
	 * Whether the current raster would come out differently in `limits`. One
	 * below both of its limits drew at its natural size and redraws only once
	 * it no longer fits; one that filled a limit redraws whenever they change.
	 */
	#outgrown(limits: Limits): boolean {
		const raster = this.#raster;
		if (raster?.source !== this.#source) return false;
		const columns = raster.widthPx / raster.cell.widthPx;
		const rows = raster.heightPx / raster.cell.heightPx;
		if (columns < raster.limits.columns && rows < raster.limits.rows) {
			return columns > limits.columns || rows > limits.rows;
		}
		return raster.limits.columns !== limits.columns || raster.limits.rows !== limits.rows;
	}

	/** Start a raster when one is due: single-flight, throttled while streaming, immediate once final. */
	#schedule(): void {
		const width = this.#width;
		if (this.#disposed || this.#rasterizing || width === undefined) return;
		if (this.#final && this.#timer) {
			clearTimeout(this.#timer);
			this.#timer = undefined;
		}
		if (this.#timer || !this.#stale(width)) return;
		const wait = this.#final ? 0 : this.#startedAt + STREAM_INTERVAL_MS - performance.now();
		if (wait > 0) {
			this.#timer = setTimeout(() => {
				this.#timer = undefined;
				this.#schedule();
			}, wait);
			this.#timer.unref?.();
			return;
		}
		void this.#rasterize(width);
	}

	async #rasterize(width: number): Promise<void> {
		const cell = this.#options.getCellDimensions();
		const attempt: Attempt = {
			source: this.#source,
			cell,
			limits: limitsFor(width, cell),
			final: this.#final,
		};
		this.#attempt = attempt;
		const svg = closePartialSvg(attempt.source);
		let png: Uint8Array | undefined;
		if (svg !== null) {
			this.#rasterizing = true;
			this.#startedAt = performance.now();
			try {
				const prepared = prepareSvg(svg, this.#options.colorPalette);
				const rasterize = await getRasterizeSvg();
				if (!rasterize) {
					throw new Error("SVG rasterization not available");
				}
				png = await rasterize(
					new TextEncoder().encode(prepared),
					attempt.limits.columns * cell.widthPx,
					attempt.limits.rows * cell.heightPx,
				);
			} catch (error) {
				// A streaming prefix that does not parse yet keeps the previous raster.
				if (attempt.final) console.debug("SVG figure did not render", error);
			} finally {
				this.#rasterizing = false;
			}
		}
		if (this.#disposed) return;
		const data = png?.toBase64();
		if (data) {
			this.#show(attempt, data);
		} else if (attempt.final) {
			this.#options.onChange();
		}
		// The source, cell size or room moved on while this raster ran.
		this.#schedule();
	}

	#show(attempt: Attempt, data: string): void {
		const previous = this.#raster;
		this.#raster = {
			source: attempt.source,
			cell: attempt.cell,
			limits: attempt.limits,
			data,
			widthPx: attempt.limits.columns * attempt.cell.widthPx,
			heightPx: attempt.limits.rows * attempt.cell.heightPx,
			key: `svg${this.#id}:${++this.#revision}`,
		};
		// A streaming revision is gone for good: free its terminal image now
		// rather than letting it crowd older images out of the store. A
		// re-raster of the same source (cell size or room change) may still be
		// standing in scrollback, so the residency sweep keeps deciding for it.
		if (previous && previous.source !== attempt.source) this.#options.budget?.release(previous.key);
		this.#options.onChange();
	}

	/**
	 * The image for `raster` over the whole cells it was padded to. At the
	 * cell size and room it was drawn for that box is its pixels exactly; a
	 * raster outdated by a resize is scaled by {@link Image} until its redraw lands.
	 */
	#imageFor(raster: Raster): Image {
		const current = this.#image;
		if (current?.raster === raster) return current.component;
		const columns = raster.widthPx / raster.cell.widthPx;
		const rows = raster.heightPx / raster.cell.heightPx;
		const imageOptions: ImageComponentOptions = {
			maxWidthCells: columns,
			maxHeightCells: rows,
			filename: "svg",
		};
		if (this.#options.budget) {
			(imageOptions as any).budget = this.#options.budget;
			(imageOptions as any).imageKey = raster.key;
		}
		(imageOptions as any).requestRender = this.#options.onChange;

		const component = new Image(
			raster.data,
			"image/png",
			{ fallbackColor: this.#options.fallbackColor ?? ((text: string) => text) },
			imageOptions,
			{ widthPx: raster.widthPx, heightPx: raster.heightPx },
		);
		this.#image = { raster, component };
		return component;
	}

	render(width: number): string[] {
		this.#width = width;
		this.#schedule();
		if (this.#raster) {
			return this.#imageFor(this.#raster).render(width);
		}
		return this.#placeholder;
	}
}

let svgFigureRenderingEnabled = true;

/** Set whether SVG figures render as images (setting: tui.renderSvg). */
export function setSvgFigureRendering(enabled: boolean): void {
	svgFigureRenderingEnabled = enabled;
}

/** Get whether SVG figures render as images. */
export function isSvgFigureRenderingEnabled(): boolean {
	return svgFigureRenderingEnabled;
}

// Load natives module early if available
void getRasterizeSvg().catch(() => {
	// Gracefully handle if natives module is not available
});
