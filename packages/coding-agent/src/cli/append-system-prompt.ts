import { existsSync } from "node:fs";
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

/** User APPEND_SYSTEM.md only. Repository copies are not appended. */
export function discoverAppendSystemPromptFile(): string | undefined {
	const candidates = getConfigDirs("", { existingOnly: false }).flatMap(entry => {
		const filePath = path.join(entry.path, "APPEND_SYSTEM.md");
		return existsSync(filePath) ? [{ level: entry.level, path: filePath }] : [];
	});
	return selectAppendSystemPromptFile(candidates);
}
