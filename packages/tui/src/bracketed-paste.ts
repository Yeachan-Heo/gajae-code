const PASTE_START = "\x1b[200~";
const PASTE_END = "\x1b[201~";

export const BRACKETED_PASTE_FRAME_TIMEOUT_MS = 1_000;
export const BRACKETED_PASTE_FRAME_MAX_BYTES = 1024 * 1024;

export type PasteResult =
	| { handled: false }
	| { handled: true; leading: string; pasteContent?: string; remaining: string };

function partialStartSuffixLength(value: string): number {
	const maxLength = Math.min(value.length, PASTE_START.length - 1);
	for (let length = maxLength; length > 0; length -= 1) {
		if (value.endsWith(PASTE_START.slice(0, length))) return length;
	}
	return 0;
}

/**
 * Handles bracketed paste framing with bounded buffering. Leading ordinary
 * input and split markers are retained byte-for-byte; stale or oversized
 * incomplete frames are released as ordinary input on the next event.
 */
export class BracketedPasteHandler {
	#buffer = "";
	#leading = "";
	#active = false;
	#pendingSince: number | undefined;

	get hasPendingFrame(): boolean {
		return this.#active || this.#buffer.length > 0 || this.#leading.length > 0;
	}

	#reset(): void {
		this.#buffer = "";
		this.#leading = "";
		this.#active = false;
		this.#pendingSince = undefined;
	}

	#flushBuffered(): string {
		const buffered = this.#active
			? `${this.#leading}${PASTE_START}${this.#buffer}`
			: `${this.#leading}${this.#buffer}`;
		this.#reset();
		return buffered;
	}

	#flushActive(remaining: string): PasteResult {
		const leading = this.#leading;
		const pasteContent = this.#buffer;
		this.#reset();
		return { handled: true, leading, pasteContent, remaining };
	}

	process(data: string, now = Date.now()): PasteResult {
		if (
			this.hasPendingFrame &&
			this.#pendingSince !== undefined &&
			now - this.#pendingSince >= BRACKETED_PASTE_FRAME_TIMEOUT_MS
		) {
			return this.#active
				? this.#flushActive(data)
				: { handled: true, leading: `${this.#flushBuffered()}${data}`, remaining: "" };
		}
		if (this.hasPendingFrame && data === "\x1b") {
			return this.#active
				? this.#flushActive(data)
				: { handled: true, leading: `${this.#flushBuffered()}${data}`, remaining: "" };
		}

		if (!this.#active) {
			const hadBufferedInput = this.hasPendingFrame;
			const combined = this.#buffer + data;
			this.#buffer = "";
			const startIndex = combined.indexOf(PASTE_START);
			if (startIndex === -1) {
				const partialLength = partialStartSuffixLength(combined);
				if (partialLength > 0) {
					const nextLeading = this.#leading + combined.slice(0, -partialLength);
					const nextBuffer = combined.slice(-partialLength);
					if (Buffer.byteLength(nextLeading) + Buffer.byteLength(nextBuffer) > BRACKETED_PASTE_FRAME_MAX_BYTES) {
						this.#reset();
						return { handled: true, leading: `${nextLeading}${nextBuffer}`, remaining: "" };
					}
					this.#leading = nextLeading;
					this.#buffer = nextBuffer;
					this.#pendingSince ??= now;
					return { handled: true, leading: "", remaining: "" };
				}
				if (hadBufferedInput || this.#leading.length > 0) {
					const leading = this.#leading + combined;
					this.#reset();
					return { handled: true, leading, remaining: "" };
				}
				return { handled: false };
			}

			this.#leading += combined.slice(0, startIndex);
			this.#buffer = combined.slice(startIndex + PASTE_START.length);
			this.#active = true;
			this.#pendingSince ??= now;
		} else {
			this.#buffer += data;
		}

		const endIndex = this.#buffer.indexOf(PASTE_END);
		if (endIndex === -1) {
			if (
				Buffer.byteLength(this.#leading) + Buffer.byteLength(PASTE_START) + Buffer.byteLength(this.#buffer) >
				BRACKETED_PASTE_FRAME_MAX_BYTES
			) {
				return this.#flushActive("");
			}
			return { handled: true, leading: "", remaining: "" };
		}

		const leading = this.#leading;
		const pasteContent = this.#buffer.slice(0, endIndex);
		const remaining = this.#buffer.slice(endIndex + PASTE_END.length);
		this.#reset();
		return { handled: true, leading, pasteContent, remaining };
	}
}
