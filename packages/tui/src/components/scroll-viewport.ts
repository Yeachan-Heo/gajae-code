import type { Component } from "../tui";

export interface ScrollViewportReflowAnchor {
	id: string;
	graphemeOffset: number;
	viewportRow: number;
}

export interface ScrollViewportSource {
	getRowCount(width: number): number;
	renderRows(width: number, startRow: number, endRow: number): string[];
	captureReflowAnchor?(startRow: number, endRow: number): ScrollViewportReflowAnchor | undefined;
	resolveReflowAnchor?(anchor: ScrollViewportReflowAnchor): number | undefined;
	captureReflowSeenState?(rowExclusive: number): unknown;
	resolveReflowUnseenRows?(seenState: unknown): number | undefined;
}

export interface ScrollViewportOptions {
	height?: number;
	overscan?: number;
	followTail?: boolean;
}

export interface ScrollViewportState {
	offset: number;
	height: number;
	totalRows: number;
	atTail: boolean;
	followTail: boolean;
	unseenRows: number;
}

const toNonNegativeInteger = (value: number, fallback: number): number => {
	return Number.isFinite(value) ? Math.max(0, Math.floor(value)) : fallback;
};

export class ScrollViewport implements Component {
	#height: number;
	#overscan: number;
	#followTail: boolean;
	#offset = 0;
	#totalRows = 0;
	#seenTailRows = 0;
	#unseenRows = 0;
	#initialized = false;
	#lastWidth: number | undefined;
	#distanceFromTail = 0;
	#semanticSeenState: unknown;
	#unanchoredUnseenRows = 0;
	#pendingReflowSnapshot:
		| {
				width: number;
				readingAnchor: ScrollViewportReflowAnchor | undefined;
				seenState: unknown;
				distanceFromTail: number;
		  }
		| undefined;

	constructor(
		private readonly source: ScrollViewportSource,
		options: ScrollViewportOptions = {},
	) {
		this.#height = toNonNegativeInteger(options.height ?? 0, 0);
		this.#overscan = toNonNegativeInteger(options.overscan ?? 0, 0);
		this.#followTail = options.followTail ?? true;
	}

	setHeight(height: number): void {
		this.#height = toNonNegativeInteger(height, this.#height);
		this.#clampOffset();
	}

	setOverscan(overscan: number): void {
		this.#overscan = toNonNegativeInteger(overscan, this.#overscan);
	}

	setFollowTail(followTail: boolean): void {
		this.#followTail = followTail;
		if (followTail) {
			this.#offset = this.#maxOffset();
			this.#markTailSeen();
			this.#distanceFromTail = 0;
		}
	}

	isFollowingTail(): boolean {
		return this.#followTail;
	}

	setOffset(offset: number): void {
		this.#followTail = false;
		this.#offset = toNonNegativeInteger(offset, this.#offset);
		this.#clampOffset();
		this.#distanceFromTail = Math.max(0, this.#maxOffset() - this.#offset);
	}

	scrollBy(rows: number): void {
		if (!Number.isFinite(rows)) return;
		this.setOffset(this.#offset + Math.trunc(rows));
	}

	scrollToTail(): void {
		this.setFollowTail(true);
	}

	getState(): ScrollViewportState {
		return {
			offset: this.#offset,
			height: this.#height,
			totalRows: this.#totalRows,
			atTail: this.#offset === this.#maxOffset(),
			followTail: this.#followTail,
			unseenRows: this.#unseenRows,
		};
	}

	invalidate(): void {}

	prepareForLayout(width: number): void {
		this.#pendingReflowSnapshot = this.#captureReflowSnapshot(width);
	}

	render(width: number): string[] {
		const widthChanged = this.#lastWidth !== undefined && width !== this.#lastWidth;
		const reflowSnapshot =
			this.#pendingReflowSnapshot?.width === width
				? this.#pendingReflowSnapshot
				: this.#captureReflowSnapshot(width);
		this.#pendingReflowSnapshot = undefined;
		const totalRows = toNonNegativeInteger(this.source.getRowCount(width), 0);
		const previousUnseenRows = this.#unseenRows;
		const activeSeenState = reflowSnapshot?.seenState ?? this.#semanticSeenState;
		const semanticUnseenRows =
			activeSeenState === undefined ? undefined : this.source.resolveReflowUnseenRows?.(activeSeenState);
		const resolvedUnseenRows =
			semanticUnseenRows === undefined ? undefined : semanticUnseenRows + this.#unanchoredUnseenRows;
		this.#updateTotalRows(totalRows, widthChanged, previousUnseenRows, resolvedUnseenRows);
		if (!widthChanged && semanticUnseenRows !== undefined) {
			this.#unanchoredUnseenRows = Math.max(0, this.#unseenRows - semanticUnseenRows);
		}

		if (this.#followTail) {
			this.#offset = this.#maxOffset();
			this.#markTailSeen();
		} else {
			const anchoredRow = reflowSnapshot?.readingAnchor
				? this.source.resolveReflowAnchor?.(reflowSnapshot.readingAnchor)
				: undefined;
			if (reflowSnapshot?.readingAnchor && anchoredRow !== undefined) {
				this.#offset = anchoredRow - reflowSnapshot.readingAnchor.viewportRow;
			} else if (widthChanged) {
				this.#offset = Math.max(
					0,
					this.#maxOffset() - (reflowSnapshot?.distanceFromTail ?? this.#distanceFromTail),
				);
			}
			this.#clampOffset();
			if (this.#offset === this.#maxOffset()) this.#markTailSeen();
		}
		this.#lastWidth = width;
		this.#distanceFromTail = Math.max(0, this.#maxOffset() - this.#offset);
		if (this.#height === 0) return [];

		const visibleStart = this.#offset;
		const visibleEnd = Math.min(totalRows, visibleStart + this.#height);
		const requestStart = Math.max(0, visibleStart - this.#overscan);
		const requestEnd = Math.min(totalRows, visibleEnd + this.#overscan);
		const requestedRows = requestEnd > requestStart ? this.source.renderRows(width, requestStart, requestEnd) : [];
		const visibleOffset = visibleStart - requestStart;
		const visibleRows = requestedRows.slice(visibleOffset, visibleOffset + (visibleEnd - visibleStart));
		while (visibleRows.length < this.#height) visibleRows.unshift("");

		return visibleRows;
	}

	#updateTotalRows(
		totalRows: number,
		widthChanged: boolean,
		previousUnseenRows: number,
		resolvedUnseenRows: number | undefined,
	): void {
		if (!this.#initialized) {
			this.#initialized = true;
			this.#seenTailRows = totalRows;
		} else if (widthChanged) {
			this.#seenTailRows =
				resolvedUnseenRows === undefined
					? Math.max(0, totalRows - previousUnseenRows)
					: Math.max(0, totalRows - Math.min(resolvedUnseenRows, totalRows));
		} else if (totalRows < this.#totalRows) {
			this.#seenTailRows = Math.min(this.#seenTailRows, totalRows);
		}
		this.#totalRows = totalRows;
		this.#unseenRows = this.#followTail ? 0 : Math.max(0, totalRows - this.#seenTailRows);
	}

	#captureReflowSnapshot(width: number):
		| {
				width: number;
				readingAnchor: ScrollViewportReflowAnchor | undefined;
				seenState: unknown;
				distanceFromTail: number;
		  }
		| undefined {
		if (this.#lastWidth === undefined || width === this.#lastWidth || this.#followTail) return undefined;
		const visibleAnchorRows = this.#unseenRows > 0 ? Math.max(0, this.#height - 1) : this.#height;
		return {
			width,
			readingAnchor: this.source.captureReflowAnchor?.(this.#offset, this.#offset + visibleAnchorRows),
			seenState: this.#semanticSeenState ?? this.source.captureReflowSeenState?.(this.#seenTailRows),
			distanceFromTail: this.#distanceFromTail,
		};
	}
	#markTailSeen(): void {
		this.#seenTailRows = this.#totalRows;
		this.#semanticSeenState = this.source.captureReflowSeenState?.(this.#totalRows);
		this.#unanchoredUnseenRows = 0;
		this.#unseenRows = 0;
	}

	#maxOffset(): number {
		return Math.max(0, this.#totalRows - this.#height);
	}

	#clampOffset(): void {
		this.#offset = Math.max(0, Math.min(this.#offset, this.#maxOffset()));
	}
}
