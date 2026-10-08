/**
 * A ```svg fence drawn as an inline terminal image. The source is rasterized
 * off the JS thread and shown through {@link Image}; while the fence streams,
 * each throttled revision repairs the partial source and replaces the
 * previous raster, which stays on screen until the next one lands.
 *
 * Sizing is natural rather than preview-capped: the figure takes as many columns as its
 * drawing needs — up to the full width, and a viewport-relative height. The
 * raster is drawn at the terminal's device pixels per unit, padded to whole
 * cells, and redrawn when the room it is shown in changes, so the terminal
 * places it 1:1: any resampling, even 0.99×, blurs every glyph edge.
 *
 * Source: oh-my-pi (https://github.com/can1357/oh-my-pi)
 */
import { logger } from "@gajae-code/utils";

type RasterizeSvgFn = (input: Uint8Array, maxWidthPx: number, maxHeightPx: number) => Promise<Uint8Array>;
let rasterizeSvg: RasterizeSvgFn | undefined;

async function getRasterizeSvg(): Promise<RasterizeSvgFn> {
	if (!rasterizeSvg) {
		const natives = await import("@gajae-code/natives");
		rasterizeSvg = natives.rasterizeSvg as RasterizeSvgFn;
	}
	return rasterizeSvg;
}

import { Image, type ImageTheme } from "../components/image";
import { type CellDimensions, getCellDimensions, getImageDimensions } from "../terminal-capabilities";
import type { Component } from "../tui";
import { closePartialSvg, prepareSvg } from "./svg-source";

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

/** Cells a figure rendered at `width` may fill: the image's width, a share of the viewport, and the raster edge cap. */
function limitsFor(width: number, cell: CellDimensions): Limits {
	const viewportRows = Math.floor((process.stdout.rows || 24) * MAX_VIEWPORT_SHARE);
	return {
		columns: Math.min(width - 2, Math.floor(MAX_EDGE_PX / cell.widthPx)),
		rows: Math.max(1, Math.min(viewportRows, Math.floor(MAX_EDGE_PX / cell.heightPx))),
	};
}

export interface SvgFigureOptions {
	/**
	 * Theme for rendering the image fallback text.
	 */
	theme: ImageTheme;
	/** The figure's rows changed outside a text update: a raster landed or rendering fell back to code. */
	onChange: () => void;
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
	/** Final source that could not be drawn; rendered as plaintext. */
	#failed: string | undefined;
	#rasterizing = false;
	#startedAt = Number.NEGATIVE_INFINITY;
	#timer: NodeJS.Timeout | undefined;
	/** A {@link #schedule} is queued for the end of the current task. */
	#queued = false;
	#disposed = false;
	/** Last render width; rasters wait for the first render to know their room. */
	#width: number | undefined;
	#image: { raster: Raster; component: Image } | undefined;

	constructor(options: SvgFigureOptions) {
		this.#options = options;
	}

	/** Feed the fence body; `final` once the fence closed or the message stopped streaming. */
	update(source: string, final: boolean): void {
		if (source === this.#source && final === this.#final) return;
		this.#source = source;
		this.#final = final;
		// Deferred: a block built mid-stream is marked streaming right after it
		// is mounted, when render() was called already (e.g. by diffing); a
		// schedule() queued before then is dropped, so the next render() starts
		// a new one.
		if (!this.#queued) {
			this.#queued = true;
			queueMicrotask(() => {
				this.#queued = false;
				this.#schedule();
			});
		}
	}

	render(width: number): string[] {
		const width1 = width;
		if (width1 !== this.#width) {
			this.#width = width1;
			this.#schedule();
		}
		if (!this.#raster && !this.#failed) return [];
		if (this.#failed) {
			// Return failed source as plain text lines split by newlines
			return this.#failed.split("\n").map(line => line || "");
		}
		if (this.#raster) {
			const image = this.#imageFor(this.#raster);
			return image.render(width1);
		}
		return [];
	}

	invalidate(): void {
		this.#raster = undefined;
		this.#image = undefined;
	}

	dispose(): void {
		this.#disposed = true;
		clearTimeout(this.#timer);
		this.#timer = undefined;
	}

	debugState(): Record<string, unknown> {
		return {
			final: this.#final,
			failed: this.#failed === this.#source,
			raster: this.#raster ? `${this.#raster.widthPx}x${this.#raster.heightPx}` : null,
			current: this.#raster?.source === this.#source,
		};
	}

	/** Whether the current source and cell size have not been attempted yet. */
	#stale(width: number): boolean {
		const attempt = this.#attempt;
		if (this.#failed === this.#source) return false;
		const cell = getCellDimensions();
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
		const cell = getCellDimensions();
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
				const prepared = prepareSvg(svg, { fg: "#ffffff" });
				const rasterize = await getRasterizeSvg();
				png = await rasterize(
					new TextEncoder().encode(prepared),
					attempt.limits.columns * cell.widthPx,
					attempt.limits.rows * cell.heightPx,
				);
			} catch (error) {
				// A streaming prefix that does not parse yet keeps the previous raster.
				if (attempt.final) logger.debug("SVG figure did not render", { error: String(error) });
			} finally {
				this.#rasterizing = false;
			}
		}
		if (this.#disposed) return;
		const data = png ? Buffer.from(png).toString("base64") : undefined;
		const size = data ? getImageDimensions(data, "image/png") : null;
		if (data && size) {
			this.#show(attempt, data, size.widthPx, size.heightPx);
		} else if (attempt.final) {
			this.#failed = attempt.source;
			this.#options.onChange();
		}
		// The source, cell size, or room moved on while this raster ran.
		this.#schedule();
	}

	#show(attempt: Attempt, data: string, widthPx: number, heightPx: number): void {
		this.#raster = {
			source: attempt.source,
			cell: attempt.cell,
			limits: attempt.limits,
			data,
			widthPx,
			heightPx,
			key: `svg${this.#id}:${++this.#revision}`,
		};
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
		const component = new Image(raster.data, "image/png", this.#options.theme, {
			maxWidthCells: columns,
			maxHeightCells: rows,
			filename: "svg",
		});
		this.#image = { raster, component };
		return component;
	}

	get pending(): boolean {
		return this.#rasterizing || (this.#final === false && this.#raster === undefined && this.#failed === undefined);
	}
}
