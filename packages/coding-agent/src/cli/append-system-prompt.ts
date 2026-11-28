import * as fs from "node:fs/promises";
import * as path from "node:path";

import { getConfigDirs } from "../config";

export interface AppendSystemPromptCandidate {
	level: "user" | "project";
	path: string;
}

/** First user file. A repository copy is untrusted project text and is never selected. */
export function selectAppendSystemPromptFile(candidates: readonly AppendSystemPromptCandidate[]): string | undefined {
	for (const candidate of candidates) {
		if (candidate.level === "user") return candidate.path;
	}
	return undefined;
}

/**
 * Reads a discovered append file. Only regular files are read; a missing, unreadable, or
 * non-regular path (FIFO, socket, directory) yields undefined, never the pathname itself.
 */
export async function readAppendSystemPromptFile(filePath: string | undefined): Promise<string | undefined> {
	if (!filePath) return undefined;
	try {
		if (!(await fs.stat(filePath)).isFile()) return undefined;
		return await fs.readFile(filePath, "utf8");
	} catch {
		return undefined;
	}
}

/** User APPEND_SYSTEM.md only. Repository copies are not appended. */
export async function discoverAppendSystemPromptFile(): Promise<string | undefined> {
	const probed = await Promise.all(
		getConfigDirs("", { existingOnly: false }).map(async entry => {
			const filePath = path.join(entry.path, "APPEND_SYSTEM.md");
			const exists = await fs.access(filePath).then(
				() => true,
				() => false,
			);
			return exists ? [{ level: entry.level, path: filePath }] : [];
		}),
	);
	return selectAppendSystemPromptFile(probed.flat());
}
