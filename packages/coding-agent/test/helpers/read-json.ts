import * as fs from "node:fs/promises";

/** Parses a JSON file whose top level is an object. */
export async function readJson(filePath: string): Promise<Record<string, unknown>> {
	return JSON.parse(await fs.readFile(filePath, "utf-8")) as Record<string, unknown>;
}
