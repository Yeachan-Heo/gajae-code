export type JsonObject = Record<string, unknown>;

export function isJsonObject(value: unknown): value is JsonObject {
	return !!value && typeof value === "object" && !Array.isArray(value);
}

/** True when `value` is a plain JSON object with no own enumerable keys. */
export function isJsonObjectEmpty(value: JsonObject): boolean {
	for (const key in value) {
		if (Object.hasOwn(value, key)) return false;
	}
	return true;
}
