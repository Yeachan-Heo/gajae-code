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
