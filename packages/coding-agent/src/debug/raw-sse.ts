import { type Component, matchesKey, padding, replaceTabs, truncateToWidth, visibleWidth } from "@gajae-code/tui";
import { sanitizeText } from "@gajae-code/utils";
import { theme } from "../modes/theme/theme";
import { copyToClipboard } from "../utils/clipboard";
import { formatRawSseIsoTime, type RawSseDebugBuffer, rawSseRecordLines } from "./raw-sse-buffer";

const MIN_VIEWER_WIDTH = 20;
const VIEWER_FRAME_LINES = 5;

function sanitizeFrameLine(line: string, width: number): string {
	return truncateToWidth(replaceTabs(sanitizeText(line)), width);
}

export interface RawSseViewerOptions {
	buffer: RawSseDebugBuffer;
	terminalRows: number;
	onExit: () => void;
	onStatus?: (message: string) => void;
	onUpdate?: () => void;
}

export class RawSseViewerComponent implements Component {
	readonly #buffer: RawSseDebugBuffer;
	readonly #terminalRows: number;
	readonly #onExit: () => void;
	readonly #onStatus?: (message: string) => void;
	readonly #onUpdate?: () => void;
	readonly #unsubscribe: () => void;
	#scrollOffset = 0;
	#followTail = true;
	#lastRenderWidth = MIN_VIEWER_WIDTH;
	#statusMessage: string | undefined;

	constructor(options: RawSseViewerOptions) {
		this.#buffer = options.buffer;
		this.#terminalRows = options.terminalRows;
		this.#onExit = options.onExit;
		this.#onStatus = options.onStatus;
		this.#onUpdate = options.onUpdate;
		this.#unsubscribe = this.#buffer.subscribe(() => {
			this.#followIfNeeded();
			this.#onUpdate?.();
		});
	}

	handleInput(keyData: string): void {
		if (matchesKey(keyData, "escape") || matchesKey(keyData, "esc")) {
			this.#unsubscribe();
			this.#onExit();
			return;
		}

		if (matchesKey(keyData, "ctrl+c")) {
			this.#copyAll();
			return;
		}

		if (matchesKey(keyData, "up")) {
			this.#followTail = false;
			this.#scrollOffset = Math.max(0, this.#scrollOffset - 1);
			this.#onUpdate?.();
			return;
		}

		if (matchesKey(keyData, "down")) {
			this.#followTail = false;
			this.#scrollOffset = Math.min(this.#maxScrollOffset(), this.#scrollOffset + 1);
			this.#onUpdate?.();
			return;
		}

		if (matchesKey(keyData, "pageUp")) {
			this.#followTail = false;
			this.#scrollOffset = Math.max(0, this.#scrollOffset - this.#bodyHeight());
			this.#onUpdate?.();
			return;
		}

		if (matchesKey(keyData, "pageDown")) {
			this.#followTail = false;
			this.#scrollOffset = Math.min(this.#maxScrollOffset(), this.#scrollOffset + this.#bodyHeight());
			this.#onUpdate?.();
			return;
		}

		if (matchesKey(keyData, "end")) {
			this.#followTail = true;
			this.#scrollToTail();
			this.#onUpdate?.();
		}
	}

	invalidate(): void {}

	render(width: number): string[] {
		this.#lastRenderWidth = Math.max(MIN_VIEWER_WIDTH, width);
		this.#followIfNeeded();

		const innerWidth = Math.max(1, this.#lastRenderWidth - 2);
		const bodyHeight = this.#bodyHeight();
		const rawLines = this.#renderRawLines(innerWidth);
		const body = rawLines.slice(this.#scrollOffset, this.#scrollOffset + bodyHeight);
		while (body.length < bodyHeight) body.push("");

		return [
			this.#frameTop(innerWidth),
			this.#frameLine(this.#summaryText(), innerWidth),
			this.#frameSeparator(innerWidth),
			...body.map(line => this.#frameLine(line, innerWidth)),
			this.#frameLine(this.#statusText(), innerWidth),
			this.#frameBottom(innerWidth),
		];
	}

	#renderRawLines(innerWidth: number): string[] {
		const snapshot = this.#buffer.snapshot();
		if (snapshot.records.length === 0) {
			return [
				theme.fg("muted", "No raw SSE frames captured yet."),
				theme.fg("muted", "HTTP SSE providers populate this view while a model response is streaming."),
			];
		}

		const lines: string[] = [];
		if (snapshot.droppedRecords > 0) {
			lines.push(
				theme.fg(
					"warning",
					`: gjc-debug-dropped records=${snapshot.droppedRecords} chars=${snapshot.droppedChars}`,
				),
			);
			lines.push("");
		}
		for (const record of snapshot.records) {
			for (const line of rawSseRecordLines(record)) {
				lines.push(sanitizeFrameLine(line, innerWidth));
			}
			if (record.kind === "event" && record.truncated) {
				lines.push(theme.fg("warning", `: gjc-debug-event-truncated originalChars=${record.originalChars}`));
			}
			lines.push("");
		}
		return lines;
	}

	#summaryText(): string {
		const snapshot = this.#buffer.snapshot();
		const last = snapshot.lastUpdatedAt ? ` last=${formatRawSseIsoTime(snapshot.lastUpdatedAt)}` : "";
		const follow = this.#followTail ? "follow:on" : "follow:off";
		return ` # raw SSE | events=${snapshot.totalEvents} records=${snapshot.records.length}${last} | ${follow} | Esc back Ctrl+C copy End follow`;
	}

	#statusText(): string {
		return this.#statusMessage ?? " Up/Down scroll  PgUp/PgDn page";
	}

	#bodyHeight(): number {
		return Math.max(3, this.#terminalRows - VIEWER_FRAME_LINES);
	}

	#followIfNeeded(): void {
		if (this.#followTail) this.#scrollToTail();
	}

	#scrollToTail(): void {
		this.#scrollOffset = this.#maxScrollOffset();
	}

	#maxScrollOffset(): number {
		const innerWidth = Math.max(1, this.#lastRenderWidth - 2);
		return Math.max(0, this.#renderRawLines(innerWidth).length - this.#bodyHeight());
	}

	#copyAll(): void {
		const payload = this.#buffer.toRawText();
		if (payload.trim().length === 0) {
			const message = "No raw SSE frames to copy";
			this.#statusMessage = message;
			this.#onStatus?.(message);
			this.#onUpdate?.();
			return;
		}

		copyToClipboard(payload)
			.then(
				() => {
					const message = "Copied raw SSE stream";
					this.#statusMessage = message;
					this.#onStatus?.(message);
				},
				(error: unknown) => {
					const message = error instanceof Error ? error.message : String(error);
					this.#statusMessage = `Copy failed: ${message}`;
				},
			)
			.finally(() => {
				this.#onUpdate?.();
			});
	}

	#frameTop(innerWidth: number): string {
		return `${theme.boxSharp.topLeft}${theme.boxSharp.horizontal.repeat(innerWidth)}${theme.boxSharp.topRight}`;
	}

	#frameSeparator(innerWidth: number): string {
		return `${theme.boxSharp.teeRight}${theme.boxSharp.horizontal.repeat(innerWidth)}${theme.boxSharp.teeLeft}`;
	}

	#frameBottom(innerWidth: number): string {
		return `${theme.boxSharp.bottomLeft}${theme.boxSharp.horizontal.repeat(innerWidth)}${theme.boxSharp.bottomRight}`;
	}

	#frameLine(content: string, innerWidth: number): string {
		const truncated = truncateToWidth(content, innerWidth);
		const remaining = Math.max(0, innerWidth - visibleWidth(truncated));
		return `${theme.boxSharp.vertical}${truncated}${padding(remaining)}${theme.boxSharp.vertical}`;
	}
}
