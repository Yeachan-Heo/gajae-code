const PASTE_START = "\x1b[200~";
const PASTE_END = "\x1b[201~";
const PASTE_PREFIX_TIMEOUT_MS = 10;

export type PasteResult =
	| { handled: false; data: string }
	| { handled: true; pasteContent?: string; remaining: string; prefix?: string };

/**
 * Handles bracketed paste mode buffering for terminal input components.
 *
 * Bracketed paste mode wraps pasted content between start (\x1b[200~) and
 * end (\x1b[201~) markers, which may arrive split across multiple chunks.
 * This class buffers incoming data and assembles complete paste payloads.
 */
export class BracketedPasteHandler {
	#buffer = "";
	#active = false;
	#pendingStart = "";
	#pendingStartTimer?: NodeJS.Timeout;
	#timedOutStart = "";

	constructor(private readonly onPendingStartTimeout?: (data: string) => void) {}

	#findPendingStart(data: string): string {
		for (let length = Math.min(PASTE_START.length - 1, data.length); length > 0; length--) {
			const suffix = data.slice(data.length - length);
			if (PASTE_START.startsWith(suffix)) return suffix;
		}
		return "";
	}

	#clearPendingStartTimer(): void {
		if (this.#pendingStartTimer) {
			clearTimeout(this.#pendingStartTimer);
			this.#pendingStartTimer = undefined;
		}
	}

	#clearPendingStart(): string {
		this.#clearPendingStartTimer();
		const pending = this.#pendingStart;
		this.#pendingStart = "";
		return pending;
	}

	#bufferPendingStart(pendingStart: string): void {
		this.#pendingStart = pendingStart;
		this.#clearPendingStartTimer();
		const onTimeout = this.onPendingStartTimeout;
		if (!onTimeout) return;
		this.#pendingStartTimer = setTimeout(() => {
			const timedOut = this.#clearPendingStart();
			if (timedOut.length === 0) return;
			this.#timedOutStart = timedOut;
			onTimeout(timedOut);
		}, PASTE_PREFIX_TIMEOUT_MS);
	}

	/**
	 * Process incoming terminal data for bracketed paste sequences.
	 *
	 * @returns `{ handled: false, data }` if the data contains no paste sequence and
	 *          should be processed normally. `{ handled: true }` if the data was
	 *          consumed by paste buffering — `pasteContent` is set when a complete
	 *          paste has been assembled; omitted when still buffering.
	 */
	process(data: string): PasteResult {
		if (this.#active) {
			this.#buffer += data;
			return this.#flushActivePaste();
		}

		if (this.#timedOutStart && data === this.#timedOutStart) {
			this.#timedOutStart = "";
			return { handled: false, data };
		}

		if (this.#pendingStart) {
			this.#clearPendingStartTimer();
			data = this.#pendingStart + data;
			this.#pendingStart = "";
		}

		const startIndex = data.indexOf(PASTE_START);
		if (startIndex !== -1) {
			this.#active = true;
			this.#buffer = data.slice(startIndex + PASTE_START.length);
			const result = this.#flushActivePaste();
			if (!result.handled) return result;
			const prefix = data.slice(0, startIndex);
			return prefix.length > 0 ? { ...result, prefix } : result;
		}

		const pendingStart = this.#findPendingStart(data);
		if (pendingStart) {
			this.#bufferPendingStart(pendingStart);
			const normalData = data.slice(0, data.length - pendingStart.length);
			if (normalData.length > 0) return { handled: false, data: normalData };
			return { handled: true, remaining: "" };
		}

		return { handled: false, data };
	}

	#flushActivePaste(): PasteResult {
		const endIndex = this.#buffer.indexOf(PASTE_END);
		if (endIndex === -1) return { handled: true, remaining: "" };

		const pasteContent = this.#buffer.substring(0, endIndex);
		const remaining = this.#buffer.substring(endIndex + PASTE_END.length);

		this.#buffer = "";
		this.#active = false;

		return { handled: true, pasteContent, remaining };
	}
}
