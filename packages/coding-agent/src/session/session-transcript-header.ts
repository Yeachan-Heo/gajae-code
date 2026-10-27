const utf8Decoder = new TextDecoder("utf-8");

/** Parse the first JSONL line as a generic record; returns undefined on parse failure. */
export function parseFirstJsonlLine(bytes: Uint8Array): Record<string, unknown> | undefined {
	const NL = 0x0a;
	const end = bytes.indexOf(NL);
	const firstLine = end === -1 ? bytes : bytes.subarray(0, end);
	if (firstLine.length === 0) return undefined;
	try {
		const text = utf8Decoder.decode(firstLine).trim();
		if (!text) return undefined;
		const value: unknown = JSON.parse(text);
		return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : undefined;
	} catch {
		return undefined;
	}
}
