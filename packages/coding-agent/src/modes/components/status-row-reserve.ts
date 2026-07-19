import type { Component } from "@gajae-code/tui";

/**
 * Reserves bottom-status rows on process terminals, which cannot report the
 * user's scrollback position. The component tracks the high-water row count of
 * the transient status slot (working / retry / auto-compaction loaders) at the
 * current width and renders enough blank lines to keep the slot at that
 * height. Removing or swapping a loader therefore never contracts the status
 * area, so completion and retry transitions cannot repaint inline-viewport
 * scrollback the user may be browsing.
 *
 * A resize resets the reservation (the viewport reflows and repaints anyway).
 * Dropping the component (e.g. a full status clear on session switch) drops
 * the reservation with it; the event controller re-creates it lazily.
 */
export class StatusRowReserve implements Component {
	#width = -1;
	#reservedLines = 0;

	constructor(private measureLiveLines: (width: number) => number) {}

	/**
	 * Records the current live transient rows into the high-water mark. Call
	 * before removing a loader so rows that never got a render frame (or are
	 * about to disappear) still count toward the reservation.
	 */
	capture(width: number): number {
		if (width !== this.#width) {
			this.#width = width;
			this.#reservedLines = 0;
		}
		const live = this.measureLiveLines(width);
		if (live > this.#reservedLines) this.#reservedLines = live;
		return live;
	}

	render(width: number): string[] {
		const live = this.capture(width);
		return Array.from({ length: this.#reservedLines - live }, () => "");
	}

	invalidate(): void {}
}
