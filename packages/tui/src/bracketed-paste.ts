const PASTE_START = "\x1b[200~";
const PASTE_END = "\x1b[201~";

export type PasteResult = { handled: false } | { handled: true; pasteContent?: string; remaining: string };

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

	/**
	 * Process incoming terminal data for bracketed paste sequences.
	 *
	 * @returns `{ handled: false }` if the data contains no paste sequence and
	 *          should be processed normally. `{ handled: true }` if the data was
	 *          consumed by paste buffering — `pasteContent` is set when a complete
	 *          paste has been assembled; omitted when still buffering.
	 */
	process(data: string): PasteResult {
		if (!this.#active) {
			const hadBufferedPrefix = this.#buffer.length > 0;
			const combined = this.#buffer + data;
			this.#buffer = "";

			const startIndex = combined.indexOf(PASTE_START);
			if (startIndex === -1) {
				if (PASTE_START.startsWith(combined)) {
					this.#buffer = combined;
					return { handled: true, remaining: "" };
				}
				if (hadBufferedPrefix) {
					return { handled: true, remaining: combined };
				}
				return { handled: false };
			}

			if (startIndex > 0) {
				return { handled: false };
			}

			this.#active = true;
			this.#buffer = combined.slice(PASTE_START.length);
		} else {
			this.#buffer += data;
		}

		const endIndex = this.#buffer.indexOf(PASTE_END);
		if (endIndex === -1) return { handled: true, remaining: "" };

		const pasteContent = this.#buffer.substring(0, endIndex);
		const remaining = this.#buffer.substring(endIndex + PASTE_END.length);

		this.#buffer = "";
		this.#active = false;

		return { handled: true, pasteContent, remaining };
	}
}
