const PASTE_START = "\x1b[200~";
const PASTE_END = "\x1b[201~";

export type PasteResult =
	| { handled: false }
	| { handled: true; normalText?: string; pasteContent?: string; remaining: string };

function findPartialStartMarkerIndex(data: string): number {
	const maxLength = Math.min(data.length, PASTE_START.length - 1);
	for (let length = maxLength; length > 1; length--) {
		const suffix = data.slice(data.length - length);
		if (PASTE_START.startsWith(suffix)) {
			return data.length - length;
		}
	}
	return -1;
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
		const hadPendingStart = this.#pendingStart.length > 0;
		if (hadPendingStart) {
			data = this.#pendingStart + data;
			this.#pendingStart = "";
		}

		if (!this.#active) {
			const startIndex = data.indexOf(PASTE_START);
			if (startIndex !== -1) {
				const normalText = data.slice(0, startIndex);
				this.#active = true;
				this.#buffer = "";
				return this.#processPasteData(data.slice(startIndex + PASTE_START.length), normalText);
			}

			const partialStartIndex = findPartialStartMarkerIndex(data);
			if (partialStartIndex !== -1) {
				const normalText = data.slice(0, partialStartIndex);
				this.#pendingStart = data.slice(partialStartIndex);
				return this.#handled(normalText);
			}

			if (hadPendingStart) {
				return this.#handled(data);
			}

			return { handled: false };
		}

		return this.#processPasteData(data);
	}

	#processPasteData(data: string, normalText?: string): PasteResult {
		this.#buffer += data;

		const endIndex = this.#buffer.indexOf(PASTE_END);
		if (endIndex === -1) return this.#handled(normalText);

		const pasteContent = this.#buffer.substring(0, endIndex);
		const remaining = this.#buffer.substring(endIndex + PASTE_END.length);

		this.#buffer = "";
		this.#active = false;

		return this.#handled(normalText, pasteContent, remaining);
	}

	#handled(normalText?: string, pasteContent?: string, remaining = ""): PasteResult {
		const result: { handled: true; normalText?: string; pasteContent?: string; remaining: string } = {
			handled: true,
			remaining,
		};
		if (normalText !== undefined && normalText.length > 0) result.normalText = normalText;
		if (pasteContent !== undefined) result.pasteContent = pasteContent;
		return result;
	}
}
