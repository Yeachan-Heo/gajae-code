const lifecycleUtf8Decoder = new TextDecoder("utf-8", { fatal: true });

/** Decodes persisted lifecycle bytes without replacement characters before JSON parsing. */
export function decodeLifecycleUtf8(bytes: Uint8Array): string {
	return lifecycleUtf8Decoder.decode(bytes);
}

/** Parses persisted lifecycle JSON only after fatal UTF-8 decoding. */
export function parseLifecycleJson(bytes: Uint8Array): unknown {
	return JSON.parse(decodeLifecycleUtf8(bytes));
}
