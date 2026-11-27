import * as fs from "node:fs/promises";

/** Parses a UTF-8 JSON file whose top level is an object. */
export async function readJson(filePath: string): Promise<Record<string, unknown>> {
	return JSON.parse(await fs.readFile(filePath, "utf-8")) as Record<string, unknown>;
}

/** Typed view for callers that assert a shape instead of narrowing the record. */
export function asRecord<T>(value: Record<string, unknown>): T {
	return value as T;
}
