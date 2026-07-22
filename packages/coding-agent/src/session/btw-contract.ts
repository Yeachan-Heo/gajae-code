export const BTW_MAX_CONTEXT_TURNS = 12;
export const BTW_MAX_CONTEXT_UTF8_BYTES = 64 * 1024;
export const BTW_MAX_QUESTION_UTF8_BYTES = 16 * 1024;
export const BTW_MAX_ANSWER_UTF8_BYTES = 32 * 1024;
export const BTW_MAX_ERROR_UTF8_BYTES = 4 * 1024;
export const BTW_STREAM_IDLE_TIMEOUT_MS = 30_000;
export const BTW_STREAM_TOTAL_TIMEOUT_MS = 120_000;

export interface BtwTextExchange {
	question: string;
	answer: string;
}

export function utf8ByteLength(text: string): number {
	return Buffer.byteLength(text, "utf8");
}

export function truncateUtf8(text: string, maxBytes: number): string {
	if (utf8ByteLength(text) <= maxBytes) return text;
	let bytes = 0;
	let result = "";
	for (const character of text) {
		const characterBytes = utf8ByteLength(character);
		if (bytes + characterBytes > maxBytes) break;
		result += character;
		bytes += characterBytes;
	}
	return result;
}

export function sanitizeBtwError(text: string): string {
	const sanitized = text
		.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, " ")
		.replace(/[\u202A-\u202E\u2066-\u2069]/g, "")
		.replace(/\s+/g, " ")
		.trim();
	return truncateUtf8(sanitized || "Side-chat request failed.", BTW_MAX_ERROR_UTF8_BYTES);
}
export function exchangeUtf8Bytes(exchange: BtwTextExchange): number {
	return utf8ByteLength(exchange.question) + utf8ByteLength(exchange.answer);
}

export function boundBtwExchanges(exchanges: readonly BtwTextExchange[]): BtwTextExchange[] {
	const bounded: BtwTextExchange[] = [];
	let totalBytes = 0;
	for (let index = exchanges.length - 1; index >= 0 && bounded.length < BTW_MAX_CONTEXT_TURNS; index -= 1) {
		const exchange = exchanges[index];
		if (!exchange) continue;
		const normalized = {
			question: truncateUtf8(exchange.question, BTW_MAX_QUESTION_UTF8_BYTES),
			answer: truncateUtf8(exchange.answer, BTW_MAX_ANSWER_UTF8_BYTES),
		};
		const bytes = exchangeUtf8Bytes(normalized);
		if (bytes > BTW_MAX_CONTEXT_UTF8_BYTES - totalBytes) break;
		bounded.unshift(normalized);
		totalBytes += bytes;
	}
	return bounded;
}
