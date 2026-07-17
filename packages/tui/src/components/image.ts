import {
	getImageDimensions,
	type ImageDimensions,
	ImageProtocol,
	imageFallback,
	isCursorNeutralImagePermittedInFallback,
	isTerminalGraphicsFallbackActive,
	kittyImageId,
	renderImage,
	TERMINAL,
} from "../terminal-capabilities";
import type { Component } from "../tui";

// Monotonic placement id allocator (kitty `p=`). Each Image instance keeps a
// stable placement id so diff-renderer repaints replace its own placement
// instead of stacking new copies, while two components showing identical
// content (same image id) still coexist as distinct placements.
let nextPlacementId = 1;
function allocatePlacementId(): number {
	const id = nextPlacementId;
	nextPlacementId = nextPlacementId >= 0x7fffffff ? 1 : nextPlacementId + 1;
	return id;
}

export interface ImageTheme {
	fallbackColor: (str: string) => string;
}

export interface ImageOptions {
	maxWidthCells?: number;
	maxHeightCells?: number;
	filename?: string;
	refetch?: () => string;
}

export class Image implements Component {
	#base64Data?: string;
	#mimeType: string;
	#dimensions: ImageDimensions;
	#theme: ImageTheme;
	#options: ImageOptions;

	#cachedLines?: string[];
	#cachedWidth?: number;
	#cachedFallbackActive?: boolean;
	#cachedProtocol?: ImageProtocol | null;
	// Computed lazily so non-kitty terminals never pay the hash cost.
	#kittyImageId?: number;
	readonly #kittyPlacementId = allocatePlacementId();

	constructor(
		base64Data: string,
		mimeType: string,
		theme: ImageTheme,
		options: ImageOptions = {},
		dimensions?: ImageDimensions,
	) {
		this.#base64Data = base64Data;
		this.#mimeType = mimeType;
		this.#theme = theme;
		this.#options = options;
		this.#dimensions = dimensions || getImageDimensions(base64Data, mimeType) || { widthPx: 800, heightPx: 600 };
	}

	invalidate(): void {
		this.#cachedLines = undefined;
		this.#cachedWidth = undefined;
		this.#cachedFallbackActive = undefined;
		this.#cachedProtocol = undefined;
	}

	get retainedBase64DataForTest(): string | undefined {
		return this.#base64Data;
	}

	#fallbackLines(): string[] {
		const fallback = imageFallback(this.#mimeType, this.#dimensions, this.#options.filename);
		return [this.#theme.fallbackColor(fallback)];
	}

	#getBase64Data(): string | undefined {
		if (this.#base64Data) return this.#base64Data;
		const refetched = this.#options.refetch?.();
		if (refetched) this.#base64Data = refetched;
		return this.#base64Data;
	}

	render(width: number): string[] {
		// Kitty placements are cursor-neutral, so an opted-in fallback scope
		// (e.g. the IRC split) can still render them safely; iTerm2/SIXEL
		// advance the cursor and stay suppressed.
		const graphicsSuppressed =
			isTerminalGraphicsFallbackActive() &&
			!(TERMINAL.imageProtocol === ImageProtocol.Kitty && isCursorNeutralImagePermittedInFallback());
		const protocol = TERMINAL.imageProtocol;
		if (
			this.#cachedLines &&
			this.#cachedWidth === width &&
			this.#cachedFallbackActive === graphicsSuppressed &&
			this.#cachedProtocol === protocol
		) {
			return this.#cachedLines;
		}

		const cap = this.#options.maxWidthCells;
		const maxWidth = cap != null && cap > 0 ? Math.min(width - 2, cap) : width - 2;

		let lines: string[];

		if (protocol && !graphicsSuppressed) {
			const base64Data = this.#getBase64Data();
			if (!base64Data) {
				lines = this.#fallbackLines();
			} else {
				if (protocol === ImageProtocol.Kitty) {
					this.#kittyImageId ??= kittyImageId(base64Data);
				}
				const result = renderImage(base64Data, this.#dimensions, {
					maxWidthCells: maxWidth,
					maxHeightCells: this.#options.maxHeightCells,
					imageId: this.#kittyImageId,
					placementId: this.#kittyPlacementId,
				});

				if (result) {
					// Return `rows` lines so the TUI accounts for the image height.
					if (result.cursorNeutral) {
						// Kitty a=p,C=1 placements neither move the cursor nor carry
						// pixel data, so the escape lives on the FIRST row — the image
						// anchors to that cell and no cursor-up trick is needed (the
						// old CUU approach clamped at the viewport top edge and placed
						// the image over transcript text when partially scrolled out).
						lines = [result.sequence];
						for (let i = 0; i < result.rows - 1; i++) {
							lines.push("");
						}
					} else {
						// iTerm2/SIXEL draw at the cursor and advance it: reserve
						// rows-1 blank lines (TUI clears them), then move the cursor
						// up and draw from the last line.
						lines = [];
						for (let i = 0; i < result.rows - 1; i++) {
							lines.push("");
						}
						const moveUp = result.rows > 1 ? `\x1b[${result.rows - 1}A` : "";
						lines.push(moveUp + result.sequence);
					}
					this.#base64Data = undefined;
				} else {
					lines = this.#fallbackLines();
				}
			}
		} else {
			lines = this.#fallbackLines();
		}

		this.#cachedLines = lines;
		this.#cachedWidth = width;
		this.#cachedFallbackActive = graphicsSuppressed;
		this.#cachedProtocol = protocol;

		return lines;
	}
}
