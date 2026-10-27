/**
 * Strict JSONL parsing for bench evidence and control streams.
 *
 * `Bun.JSONL.parse` can return the values before a later syntax error, which
 * would silently drop evidence; these helpers reject malformed or truncated
 * input instead.
 */

/** Parse a complete JSONL document; throws on a syntax error or a truncated last record. */
export function parseJsonl(text: string, source: string): unknown[] {
	const result = Bun.JSONL.parseChunk(text);
	if (result.error) throw new Error(`${source}: ${result.error.message} at offset ${result.read}`);
	if (!result.done && text.slice(result.read).trim()) throw new Error(`${source}: truncated JSONL record at offset ${result.read}`);
	return result.values;
}

/** Incrementally parse a byte stream of JSONL records; throws on malformed or truncated input. */
export async function* readJsonlStream<T>(stream: ReadableStream<Uint8Array>, source: string): AsyncGenerator<T> {
	const decoder = new TextDecoder();
	let buffered = "";
	for await (const chunk of stream) {
		buffered += decoder.decode(chunk, { stream: true });
		const result = Bun.JSONL.parseChunk(buffered);
		if (result.error) throw new Error(`${source}: ${result.error.message} at offset ${result.read}`);
		for (const value of result.values) yield value as T;
		buffered = buffered.slice(result.read);
	}
	buffered += decoder.decode();
	for (const value of parseJsonl(buffered, source)) yield value as T;
}
