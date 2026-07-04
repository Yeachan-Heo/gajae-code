const PASTE_START = "\x1b[200~";
const PASTE_END = "\x1b[201~";

type HandledPasteResult = { handled: true; normalText?: string; pasteContent?: string; remaining: string };
export type PasteResult = { handled: false } | HandledPasteResult;

function trailingPasteStartPrefixLength(value: string): number {
	const maxLength = Math.min(PASTE_START.length - 1, value.length);
	for (let length = maxLength; length >= 2; length--) {
		if (PASTE_START.startsWith(value.slice(-length))) return length;
	}
	return 0;
}

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

	/**
	 * Process incoming terminal data for bracketed paste sequences.
	 *
	 * @returns `{ handled: false }` if the data contains no paste sequence and
	 *          should be processed normally. `{ handled: true }` if the data was
	 *          consumed by paste buffering — `pasteContent` is set when a complete
	 *          paste has been assembled; omitted when still buffering.
	 */
	process(data: string): PasteResult {
		if (this.#active) {
			return this.#consumeActivePaste(data);
		}

		const hadPendingStart = this.#pendingStart.length > 0;
		const input = `${this.#pendingStart}${data}`;
		this.#pendingStart = "";

		const startIndex = input.indexOf(PASTE_START);
		if (startIndex !== -1) {
			this.#active = true;
			this.#buffer = "";
			const normalText = input.slice(0, startIndex);
			const paste = this.#consumeActivePaste(input.slice(startIndex + PASTE_START.length));
			if (normalText.length > 0) {
				return { ...paste, normalText };
			}
			return paste;
		}

		const pendingLength = trailingPasteStartPrefixLength(input);
		if (pendingLength > 0) {
			this.#pendingStart = input.slice(-pendingLength);
			const normalText = input.slice(0, -pendingLength);
			return normalText.length > 0 ? { handled: true, normalText, remaining: "" } : { handled: true, remaining: "" };
		}

		if (hadPendingStart) {
			return { handled: true, normalText: input, remaining: "" };
		}

		return { handled: false };
	}

	#consumeActivePaste(data: string): HandledPasteResult {
		this.#buffer += data;

		const endIndex = this.#buffer.indexOf(PASTE_END);
		if (endIndex === -1) return { handled: true, remaining: "" };

		const pasteContent = this.#buffer.substring(0, endIndex);
		const remaining = this.#buffer.substring(endIndex + PASTE_END.length);

		this.#buffer = "";
		this.#active = false;

		return { handled: true, pasteContent, remaining };
	}
}
