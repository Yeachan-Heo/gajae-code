/**
 * StdinBuffer buffers input and emits complete sequences.
 *
 * This is necessary because stdin data events can arrive in partial chunks,
 * especially for escape sequences like mouse events. Without buffering,
 * partial sequences can be misinterpreted as regular keypresses.
 *
 * For example, the mouse SGR sequence `\x1b[<35;20;5m` might arrive as:
 * - Event 1: `\x1b`
 * - Event 2: `[<35`
 * - Event 3: `;20;5m`
 *
 * The buffer accumulates these until a complete sequence is detected.
 * Call the `process()` method to feed input data.
 *
 * Based on code from OpenTUI (https://github.com/anomalyco/opentui)
 * MIT License - Copyright (c) 2025 opentui
 */

import { StringDecoder } from "node:string_decoder";
import { EventEmitter } from "events";

const ESC = "\x1b";
const BRACKETED_PASTE_START = "\x1b[200~";
const BRACKETED_PASTE_END = "\x1b[201~";
const SGR_QUARANTINE_MAX_BYTES = 256;
const SGR_QUARANTINE_TIMEOUT_MS = 100;

/** True for complete SGR mouse CSI reports. These remain control input, never text. */
export function isSgrMouseSequence(sequence: string): boolean {
	return /^\x1b\[<\d+;\d+;\d+[Mm]$/.test(sequence);
}

/** True when a buffered sequence begins an SGR mouse report, valid or not. */
function isSgrMousePrefix(sequence: string): boolean {
	return sequence.startsWith(`${ESC}[<`);
}

function isUtf8LeadByte(byte: number): boolean {
	return byte >= 0xc2 && byte <= 0xf4;
}

function endsWithIncompleteUtf8Sequence(data: Buffer): boolean {
	if (data.length === 0) return false;

	let index = data.length - 1;
	let continuationCount = 0;
	while (index >= 0) {
		const byte = data[index]!;
		if (byte < 0x80 || byte > 0xbf) break;
		continuationCount++;
		index--;
	}

	if (index < 0) {
		return continuationCount > 0;
	}

	const lead = data[index]!;
	let expectedLength = 0;
	if (lead >= 0xc2 && lead <= 0xdf) expectedLength = 2;
	else if (lead >= 0xe0 && lead <= 0xef) expectedLength = 3;
	else if (lead >= 0xf0 && lead <= 0xf4) expectedLength = 4;

	return expectedLength > 0 && continuationCount + 1 < expectedLength;
}

function legacyMetaSequence(byte: number): string {
	return `\x1b${String.fromCharCode(byte - 128)}`;
}

/**
 * Check if a string is a complete escape sequence or needs more data
 */
function isCompleteSequence(data: string): "complete" | "incomplete" | "not-escape" {
	if (!data.startsWith(ESC)) {
		return "not-escape";
	}

	if (data.length === 1) {
		return "incomplete";
	}

	const afterEsc = data.slice(1);

	// CSI sequences: ESC [
	if (afterEsc.startsWith("[")) {
		// Check for old-style mouse sequence: ESC[M + 3 bytes
		if (afterEsc.startsWith("[M")) {
			// Old-style mouse needs ESC[M + 3 bytes = 6 total
			return data.length >= 6 ? "complete" : "incomplete";
		}
		return isCompleteCsiSequence(data);
	}

	// OSC sequences: ESC ]
	if (afterEsc.startsWith("]")) {
		return isCompleteOscSequence(data);
	}

	// DCS sequences: ESC P ... ESC \ (includes XTVersion responses)
	if (afterEsc.startsWith("P")) {
		return isCompleteDcsSequence(data);
	}

	// APC sequences: ESC _ ... ESC \ (includes Kitty graphics responses)
	if (afterEsc.startsWith("_")) {
		return isCompleteApcSequence(data);
	}

	// SS3 sequences: ESC O
	if (afterEsc.startsWith("O")) {
		// ESC O followed by a single character
		return afterEsc.length >= 2 ? "complete" : "incomplete";
	}

	// Meta key sequences: ESC followed by a single character
	if (afterEsc.length === 1) {
		return "complete";
	}

	// Unknown escape sequence - treat as complete
	return "complete";
}

/**
 * Check if CSI sequence is complete
 * CSI sequences: ESC [ ... followed by a final byte (0x40-0x7E)
 */
function isCompleteCsiSequence(data: string): "complete" | "incomplete" {
	if (!data.startsWith(`${ESC}[`)) {
		return "complete";
	}

	// Need at least ESC [ and one more character
	if (data.length < 3) {
		return "incomplete";
	}

	const payload = data.slice(2);

	// CSI sequences end with a byte in the range 0x40-0x7E (@-~)
	// This includes all letters and several special characters
	const lastChar = payload[payload.length - 1];
	const lastCharCode = lastChar.charCodeAt(0);

	if (lastCharCode >= 0x40 && lastCharCode <= 0x7e) {
		// Special handling for SGR mouse sequences
		// Format: ESC[<B;X;Ym or ESC[<B;X;YM
		if (payload.startsWith("<")) {
			// Must have format: <digits;digits;digits[Mm]
			// SGR-looking reports remain terminal control input even when malformed.
			// Treat their final byte as complete so trailing user input is preserved.
			if (lastChar === "M" || lastChar === "m") return "complete";
			return "incomplete";
		}

		return "complete";
	}

	return "incomplete";
}

/**
 * Check if OSC sequence is complete
 * OSC sequences: ESC ] ... ST (where ST is ESC \ or BEL)
 */
function isCompleteOscSequence(data: string): "complete" | "incomplete" {
	if (!data.startsWith(`${ESC}]`)) {
		return "complete";
	}

	// OSC sequences end with ST (ESC \) or BEL (\x07)
	if (data.endsWith(`${ESC}\\`) || data.endsWith("\x07")) {
		return "complete";
	}

	return "incomplete";
}

/**
 * Check if DCS (Device Control String) sequence is complete
 * DCS sequences: ESC P ... ST (where ST is ESC \)
 * Used for XTVersion responses like ESC P >| ... ESC \
 */
function isCompleteDcsSequence(data: string): "complete" | "incomplete" {
	if (!data.startsWith(`${ESC}P`)) {
		return "complete";
	}

	// DCS sequences end with ST (ESC \)
	if (data.endsWith(`${ESC}\\`)) {
		return "complete";
	}

	return "incomplete";
}

/**
 * Check if APC (Application Program Command) sequence is complete
 * APC sequences: ESC _ ... ST (where ST is ESC \)
 * Used for Kitty graphics responses like ESC _ G ... ESC \
 */
function isCompleteApcSequence(data: string): "complete" | "incomplete" {
	if (!data.startsWith(`${ESC}_`)) {
		return "complete";
	}

	// APC sequences end with ST (ESC \)
	if (data.endsWith(`${ESC}\\`)) {
		return "complete";
	}

	return "incomplete";
}

/**
 * Split accumulated buffer into complete sequences
 */
function parseUnmodifiedKittyPrintableCodepoint(sequence: string): number | undefined {
	const match = sequence.match(/^\x1b\[(\d+)(?::\d*)?(?::\d+)?u$/);
	if (!match) return undefined;

	const codepoint = parseInt(match[1]!, 10);
	return codepoint >= 32 ? codepoint : undefined;
}

function extractCompleteSequences(buffer: string): { sequences: string[]; remainder: string } {
	const sequences: string[] = [];
	let pos = 0;

	while (pos < buffer.length) {
		const remaining = buffer.slice(pos);

		// Try to extract a sequence starting at this position
		if (remaining.startsWith(ESC)) {
			// Find the end of this escape sequence
			let seqEnd = 1;
			while (seqEnd <= remaining.length) {
				const candidate = remaining.slice(0, seqEnd);
				const status = isCompleteSequence(candidate);

				if (status === "complete") {
					sequences.push(candidate);
					pos += seqEnd;
					break;
				} else if (status === "incomplete") {
					seqEnd++;
				} else {
					// Should not happen when starting with ESC
					sequences.push(candidate);
					pos += seqEnd;
					break;
				}
			}

			if (seqEnd > remaining.length) {
				return { sequences, remainder: remaining };
			}
		} else {
			// Not an escape sequence - take a single character
			sequences.push(remaining[0]!);
			pos++;
		}
	}

	return { sequences, remainder: "" };
}

export type StdinBufferOptions = {
	/**
	 * Maximum time to wait for sequence completion (default: 10ms)
	 * After this time, the buffer is flushed even if incomplete
	 */
	timeout?: number;
};

export type StdinBufferEventMap = {
	data: [string];
	paste: [string];
};

/**
 * Buffers stdin input and emits complete sequences via the 'data' event.
 * Handles partial escape sequences that arrive across multiple chunks.
 *
 * StdinBuffer is the single raw-stdin decoding boundary: raw terminal bytes
 * enter via `process()` and decoded string events leave via the 'data' and
 * 'paste' events. UTF-8 is decoded exactly once here (using a persistent
 * StringDecoder) so multi-byte characters split across chunk boundaries are
 * reassembled rather than corrupted into U+FFFD. All downstream parsing
 * (escape sequences, bracketed paste, Kitty/CSI, OSC/DA1) operates on strings.
 */
export class StdinBuffer extends EventEmitter<StdinBufferEventMap> {
	#buffer: string = "";
	#timeout?: NodeJS.Timeout;
	readonly #timeoutMs: number;
	#pasteMode: boolean = false;
	#pasteBuffer: string = "";
	#pendingKittyPrintableCodepoint: number | undefined;
	// Persistent UTF-8 decoder. Holds an incomplete trailing multi-byte
	// sequence between chunks so split reads (e.g. a 3-byte Korean syllable
	// split across two stdin events) reassemble correctly instead of emitting
	// U+FFFD. Reset on clear()/destroy(); never finalized on normal flush.
	#decoder = new StringDecoder("utf8");
	#decoderHasPendingUtf8 = false;
	#pendingSingleUtf8LeadByte: number | undefined;
	#sgrQuarantine = false;
	#sgrQuarantineBytes = 0;
	#sgrQuarantineSemicolons = 0;
	#sgrQuarantineHasDigit = false;

	constructor(options: StdinBufferOptions = {}) {
		super();
		this.#timeoutMs = options.timeout ?? 10;
	}

	process(data: string | Buffer): void {
		// Do not cancel a bounded SGR quarantine while waiting for its final byte.
		if (this.#timeout && !this.#sgrQuarantine) {
			clearTimeout(this.#timeout);
			this.#timeout = undefined;
		}

		// Decode raw bytes into a string. Buffers come from raw stdin; strings
		// come from tests or non-terminal callers and are already decoded.
		let str: string;
		let decodedFromBuffer = false;
		if (Buffer.isBuffer(data)) {
			let bytes = data;
			const hadPendingUtf8 = this.#decoderHasPendingUtf8 || this.#pendingSingleUtf8LeadByte !== undefined;

			if (this.#pendingSingleUtf8LeadByte !== undefined) {
				const nextByte = data[0];
				if (nextByte !== undefined && nextByte >= 0x80 && nextByte <= 0xbf) {
					bytes = Buffer.concat([Buffer.from([this.#pendingSingleUtf8LeadByte]), data]);
					this.#pendingSingleUtf8LeadByte = undefined;
				} else {
					const pendingMeta = this.#consumePendingSingleUtf8LeadAsMeta();
					if (pendingMeta !== undefined) {
						this.#emitDataSequence(pendingMeta);
					}
				}
			}

			if (bytes.length === 1 && bytes[0]! > 127 && !this.#decoderHasPendingUtf8) {
				const byte = bytes[0]!;
				if (isUtf8LeadByte(byte)) {
					this.#pendingSingleUtf8LeadByte = byte;
					this.#decoderHasPendingUtf8 = true;
					this.#timeout = setTimeout(() => {
						const sequence = this.#consumePendingSingleUtf8LeadAsMeta();
						if (sequence !== undefined) {
							this.#emitDataSequence(sequence);
						}
					}, this.#timeoutMs);
					return;
				}
				str = legacyMetaSequence(byte);
			} else {
				// Decode through the persistent StringDecoder so a multi-byte
				// sequence split across chunks (e.g. a 3-byte Korean syllable)
				// is reassembled instead of emitting U+FFFD.
				str = this.#decoder.write(bytes);
				decodedFromBuffer = true;
				const allContinuationBytes = bytes.every(byte => byte >= 0x80 && byte <= 0xbf);
				this.#decoderHasPendingUtf8 =
					endsWithIncompleteUtf8Sequence(bytes) && !(hadPendingUtf8 && str.length > 0 && allContinuationBytes);
			}
		} else {
			const pendingMeta = this.#consumePendingSingleUtf8LeadAsMeta();
			if (pendingMeta !== undefined) {
				this.#emitDataSequence(pendingMeta);
			}
			str = data;
		}

		if (str.length === 0 && this.#buffer.length === 0) {
			// A Buffer that decoded to nothing means the decoder is holding an
			// incomplete UTF-8 prefix; emit nothing and wait for the completing
			// bytes. Preserve the historical empty 'data' event for explicit
			// empty-string input only.
			if (!decodedFromBuffer) {
				this.#emitDataSequence("");
			}
			return;
		}

		if (this.#sgrQuarantine) {
			str = this.#consumeSgrQuarantine(str);
			if (str.length === 0) return;
		}

		this.#buffer += str;

		if (this.#pasteMode) {
			this.#pasteBuffer += this.#buffer;
			this.#buffer = "";

			const endIndex = this.#pasteBuffer.indexOf(BRACKETED_PASTE_END);
			if (endIndex !== -1) {
				const pastedContent = this.#pasteBuffer.slice(0, endIndex);
				const remaining = this.#pasteBuffer.slice(endIndex + BRACKETED_PASTE_END.length);

				this.#pasteMode = false;
				this.#pasteBuffer = "";
				this.#pendingKittyPrintableCodepoint = undefined;

				this.emit("paste", pastedContent);

				if (remaining.length > 0) {
					this.process(remaining);
				}
			}
			return;
		}

		const startIndex = this.#buffer.indexOf(BRACKETED_PASTE_START);
		if (startIndex !== -1) {
			if (startIndex > 0) {
				const beforePaste = this.#buffer.slice(0, startIndex);
				const result = extractCompleteSequences(beforePaste);
				for (const sequence of result.sequences) {
					this.#emitDataSequence(sequence);
				}
				if (result.remainder.length > 0) {
					this.#emitDataSequence(result.remainder);
				}
			}

			this.#pendingKittyPrintableCodepoint = undefined;
			this.#buffer = this.#buffer.slice(startIndex + BRACKETED_PASTE_START.length);
			this.#pasteMode = true;
			this.#pasteBuffer = this.#buffer;
			this.#buffer = "";

			const endIndex = this.#pasteBuffer.indexOf(BRACKETED_PASTE_END);
			if (endIndex !== -1) {
				const pastedContent = this.#pasteBuffer.slice(0, endIndex);
				const remaining = this.#pasteBuffer.slice(endIndex + BRACKETED_PASTE_END.length);

				this.#pasteMode = false;
				this.#pasteBuffer = "";
				this.#pendingKittyPrintableCodepoint = undefined;

				this.emit("paste", pastedContent);

				if (remaining.length > 0) {
					this.process(remaining);
				}
			}
			return;
		}

		const result = extractCompleteSequences(this.#buffer);
		this.#buffer = result.remainder;

		for (const sequence of result.sequences) {
			if (isSgrMousePrefix(sequence) && !isSgrMouseSequence(sequence)) continue;
			this.#emitDataSequence(sequence);
		}

		if (this.#buffer.length > 0) {
			this.#timeout = setTimeout(() => {
				if (isSgrMousePrefix(this.#buffer)) {
					this.#beginSgrQuarantine();
					return;
				}
				const flushed = this.flush();
				for (const sequence of flushed) {
					this.#emitDataSequence(sequence);
				}
			}, this.#timeoutMs);
		}
	}

	#beginSgrQuarantine(): void {
		const suffix = this.#buffer.slice(3);
		let semicolons = 0;
		let hasDigit = false;
		for (let index = 0; index < suffix.length; index += 1) {
			const char = suffix[index]!;
			if (/\d/u.test(char)) {
				hasDigit = true;
				continue;
			}
			if (char === ";" && hasDigit && semicolons < 2) {
				semicolons += 1;
				hasDigit = false;
				continue;
			}
			const remainder = suffix.slice(index);
			this.#buffer = "";
			this.#pendingKittyPrintableCodepoint = undefined;
			if (remainder) this.process(remainder);
			return;
		}
		this.#buffer = "";
		this.#pendingKittyPrintableCodepoint = undefined;
		this.#sgrQuarantine = true;
		this.#sgrQuarantineBytes = suffix.length;
		this.#sgrQuarantineSemicolons = semicolons;
		this.#sgrQuarantineHasDigit = hasDigit;
		this.#timeout = setTimeout(() => this.#endSgrQuarantine(), SGR_QUARANTINE_TIMEOUT_MS);
	}

	#endSgrQuarantine(): void {
		if (this.#timeout) clearTimeout(this.#timeout);
		this.#timeout = undefined;
		this.#sgrQuarantine = false;
		this.#sgrQuarantineBytes = 0;
		this.#sgrQuarantineSemicolons = 0;
		this.#sgrQuarantineHasDigit = false;
	}

	#consumeSgrQuarantine(data: string): string {
		for (let index = 0; index < data.length; index += 1) {
			const char = data[index]!;
			if (this.#sgrQuarantineBytes >= SGR_QUARANTINE_MAX_BYTES) {
				let resume = index;
				while (resume < data.length && /[\d;]/u.test(data[resume]!)) resume += 1;
				if (resume < data.length && /[Mm]/u.test(data[resume]!)) resume += 1;
				this.#endSgrQuarantine();
				return data.slice(resume);
			}
			if (/\d/u.test(char)) {
				this.#sgrQuarantineHasDigit = true;
				this.#sgrQuarantineBytes += 1;
				continue;
			}
			if (char === ";" && this.#sgrQuarantineHasDigit && this.#sgrQuarantineSemicolons < 2) {
				this.#sgrQuarantineSemicolons += 1;
				this.#sgrQuarantineHasDigit = false;
				this.#sgrQuarantineBytes += 1;
				continue;
			}
			if ((char === "M" || char === "m") && this.#sgrQuarantineSemicolons === 2 && this.#sgrQuarantineHasDigit) {
				this.#endSgrQuarantine();
				return data.slice(index + 1);
			}
			this.#endSgrQuarantine();
			return data.slice(index);
		}
		return "";
	}

	#consumePendingSingleUtf8LeadAsMeta(): string | undefined {
		const byte = this.#pendingSingleUtf8LeadByte;
		if (byte === undefined) return undefined;
		this.#pendingSingleUtf8LeadByte = undefined;
		this.#decoderHasPendingUtf8 = false;
		return legacyMetaSequence(byte);
	}
	#emitDataSequence(sequence: string): void {
		const rawCodepoint = sequence.length === 1 ? sequence.codePointAt(0) : undefined;
		if (rawCodepoint !== undefined && rawCodepoint === this.#pendingKittyPrintableCodepoint) {
			this.#pendingKittyPrintableCodepoint = undefined;
			return;
		}

		this.#pendingKittyPrintableCodepoint = parseUnmodifiedKittyPrintableCodepoint(sequence);
		this.emit("data", sequence);
	}

	flush(): string[] {
		if (this.#timeout) {
			clearTimeout(this.#timeout);
			this.#timeout = undefined;
		}
		if (this.#sgrQuarantine) this.#endSgrQuarantine();

		const pendingMeta = this.#consumePendingSingleUtf8LeadAsMeta();

		if (this.#buffer.length === 0) {
			return pendingMeta === undefined ? [] : [pendingMeta];
		}

		if (isSgrMousePrefix(this.#buffer)) {
			this.#buffer = "";
			this.#pendingKittyPrintableCodepoint = undefined;
			return pendingMeta === undefined ? [] : [pendingMeta];
		}

		const sequences = pendingMeta === undefined ? [this.#buffer] : [pendingMeta, this.#buffer];
		this.#buffer = "";
		this.#pendingKittyPrintableCodepoint = undefined;
		return sequences;
	}

	clear(): void {
		if (this.#timeout) {
			clearTimeout(this.#timeout);
			this.#timeout = undefined;
		}
		this.#buffer = "";
		this.#pasteMode = false;
		this.#pasteBuffer = "";
		this.#pendingKittyPrintableCodepoint = undefined;
		this.#sgrQuarantine = false;
		this.#sgrQuarantineBytes = 0;
		this.#sgrQuarantineSemicolons = 0;
		this.#sgrQuarantineHasDigit = false;
		// Drop any incomplete multi-byte sequence the decoder is holding so a
		// stale partial prefix cannot combine with future input. destroy()
		// resets the decoder by calling clear().
		this.#decoder = new StringDecoder("utf8");
		this.#decoderHasPendingUtf8 = false;
		this.#pendingSingleUtf8LeadByte = undefined;
	}

	getBuffer(): string {
		return this.#buffer;
	}

	destroy(): void {
		this.clear();
	}
}
