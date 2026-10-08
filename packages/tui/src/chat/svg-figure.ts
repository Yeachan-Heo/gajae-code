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
import { rasterizeSvg } from "@gajae-code/natives";
import { logger } from "@gajae-code/utils";
import { Image, type ImageTheme } from "../components/image";
import { type CellDimensions, getCellDimensions, getImageDimensions, TERMINAL } from "../terminal-capabilities";
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
}

/** Inputs of a raster attempt, successful or not. */
interface Attempt {
	source: string;
	palette: Readonly<Record<string, string>>;
	cell: CellDimensions;
	limits: Limits;
	final: boolean;
}

interface Layout {
	width: number;
	cell: CellDimensions;
	limits: Limits;
}

/** Cells a figure rendered at `width` may fill: the image's width, a share of the viewport, and the raster edge cap. */
function limitsFor(width: number, cell: CellDimensions): Limits {
	const viewportRows = Math.floor((process.stdout.rows || 24) * MAX_VIEWPORT_SHARE);
	return {
		columns: Math.max(1, Math.min(Math.max(1, width - 2), Math.floor(MAX_EDGE_PX / cell.widthPx))),
		rows: Math.max(1, Math.min(viewportRows, Math.floor(MAX_EDGE_PX / cell.heightPx))),
	};
}

export interface SvgFigureOptions {
	/**
	 * Theme for rendering the image fallback text.
	 */
	theme: ImageTheme;
	/** CSS colors substituted for SVG theme variables and currentColor. */
	palette: Readonly<Record<string, string>>;
	/** The figure's rows changed outside a text update: a raster landed or rendering fell back to code. */
	onChange: () => void;
}

export class SvgFigure implements Component {
	readonly #options: SvgFigureOptions;
	#palette: Readonly<Record<string, string>>;
	#source = "";
	/** No more text arrives for this fence: no throttling, and a failed raster falls back to code. */
	#final = false;
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
	#layout: Layout | undefined;
	#image: { raster: Raster; cell: CellDimensions; columns: number; rows: number; component: Image } | undefined;
	#graphicsUnavailableNotified = false;

	constructor(options: SvgFigureOptions) {
		this.#options = options;
		this.#palette = options.palette;
	}

	/** Feed the fence body; `final` once the fence closed or the message stopped streaming. */
	update(source: string, final: boolean, palette = this.#palette): void {
		const sourceChanged = source !== this.#source;
		const paletteChanged = palette !== this.#palette;
		if (!sourceChanged && !paletteChanged && final === this.#final) return;
		if (sourceChanged || paletteChanged) this.#failed = undefined;
		this.#source = source;
		this.#final = final;
		this.#palette = palette;
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
		if (!TERMINAL.imageProtocol) {
			clearTimeout(this.#timer);
			this.#timer = undefined;
			if (!this.#graphicsUnavailableNotified) {
				this.#graphicsUnavailableNotified = true;
				this.#options.onChange();
			}
			return [];
		}
		this.#graphicsUnavailableNotified = false;
		const cell = getCellDimensions();
		const limits = limitsFor(width, cell);
		const previousLayout = this.#layout;
		const cellChanged =
			previousLayout?.cell.widthPx !== cell.widthPx || previousLayout.cell.heightPx !== cell.heightPx;
		const layoutChanged =
			previousLayout === undefined ||
			previousLayout.width !== width ||
			cellChanged ||
			previousLayout.limits.columns !== limits.columns ||
			previousLayout.limits.rows !== limits.rows;
		if (layoutChanged) {
			this.#width = width;
			this.#layout = { width, cell, limits };
			if (cellChanged) this.#image?.component.invalidate();
			this.#schedule();
		}
		if (!this.#raster && !this.#failed) return [];
		if (this.failed) return [];
		if (this.#raster) {
			const image = this.#imageFor(this.#raster, limits, cell);
			return image.render(width);
		}
		return [];
	}

	invalidate(): void {
		this.#image?.component.invalidate();
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
			attempt.palette !== this.#palette ||
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
		if (this.#disposed || !TERMINAL.imageProtocol || this.#rasterizing || width === undefined) return;
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
			palette: this.#palette,
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
				const prepared = prepareSvg(svg, attempt.palette);
				const sourcePng = await rasterizeSvg(
					new TextEncoder().encode(prepared),
					attempt.limits.columns * cell.widthPx,
					attempt.limits.rows * cell.heightPx,
				);
				const sourceData = Buffer.from(sourcePng).toString("base64");
				const sourceSize = getImageDimensions(sourceData, "image/png");
				if (!sourceSize) throw new Error("SVG rasterizer returned invalid PNG dimensions");

				const columns = Math.min(attempt.limits.columns, Math.ceil(sourceSize.widthPx / cell.widthPx));
				const rows = Math.min(attempt.limits.rows, Math.ceil(sourceSize.heightPx / cell.heightPx));
				const widthPx = columns * cell.widthPx;
				const heightPx = rows * cell.heightPx;
				if (widthPx === sourceSize.widthPx && heightPx === sourceSize.heightPx) {
					png = sourcePng;
				} else {
					// Terminal graphics occupy whole cells. Keep the original raster's
					// aspect ratio by centering it on a transparent cell-sized canvas;
					// the embedded data URL is resolved without reading host files.
					const scale = Math.min(widthPx / sourceSize.widthPx, heightPx / sourceSize.heightPx, 1);
					const drawnWidth = sourceSize.widthPx * scale;
					const drawnHeight = sourceSize.heightPx * scale;
					const x = (widthPx - drawnWidth) / 2;
					const y = (heightPx - drawnHeight) / 2;
					const paddedSvg =
						`<svg xmlns="http://www.w3.org/2000/svg" width="${widthPx}" height="${heightPx}" ` +
						`viewBox="0 0 ${widthPx} ${heightPx}"><image ` +
						`href="data:image/png;base64,${sourceData}" x="${x}" y="${y}" ` +
						`width="${drawnWidth}" height="${drawnHeight}"/></svg>`;
					png = await rasterizeSvg(new TextEncoder().encode(paddedSvg), widthPx, heightPx);
				}
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
		} else if (attempt.final && attempt.source === this.#source && attempt.palette === this.#palette) {
			this.#failed = attempt.source;
			this.#options.onChange();
		}
		// The source, cell size, or room moved on while this raster ran.
		this.#schedule();
	}

	#show(attempt: Attempt, data: string, widthPx: number, heightPx: number): void {
		if (this.#failed === attempt.source) this.#failed = undefined;
		this.#raster = {
			source: attempt.source,
			cell: attempt.cell,
			limits: attempt.limits,
			data,
			widthPx,
			heightPx,
		};
		this.#options.onChange();
	}

	/**
	 * The image for `raster` over the whole cells it was padded to. At the
	 * cell size and room it was drawn for that box is its pixels exactly; a
	 * raster outdated by a resize is scaled by {@link Image} until its redraw lands.
	 */
	#imageFor(raster: Raster, limits: Limits, cell: CellDimensions): Image {
		const current = this.#image;
		const columns = Math.min(limits.columns, Math.ceil(raster.widthPx / cell.widthPx));
		const rows = Math.min(limits.rows, Math.ceil(raster.heightPx / cell.heightPx));
		if (
			current?.raster === raster &&
			current.cell.widthPx === cell.widthPx &&
			current.cell.heightPx === cell.heightPx &&
			current.columns === columns &&
			current.rows === rows
		) {
			return current.component;
		}
		const component = new Image(raster.data, "image/png", this.#options.theme, {
			maxWidthCells: columns,
			maxHeightCells: rows,
			filename: "svg",
			refetch: () => raster.data,
		});
		this.#image = { raster, cell, columns, rows, component };
		return component;
	}

	get pending(): boolean {
		return this.#rasterizing || (this.#final === false && this.#raster === undefined && this.#failed === undefined);
	}

	get failed(): boolean {
		return this.#failed === this.#source;
	}
}
