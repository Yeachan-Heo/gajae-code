import { redactCrashSecrets } from "@gajae-code/utils";
import { redactChangelogEntry } from "./changelog";
import type { ConventionalAnalysis } from "./types";

/** Same order as generated task messages, so a second pass stays stable. */
function redactCommitText(text: string): string {
	return redactCrashSecrets(redactChangelogEntry(text));
}

export function formatCommitMessage(analysis: ConventionalAnalysis, summary: string): string {
	const scopePart = analysis.scope ? `(${redactCommitText(analysis.scope)})` : "";
	const header = `${analysis.type}${scopePart}: ${redactCommitText(summary)}`;
	const bodyLines = analysis.details.map(detail => `- ${redactCommitText(detail.text.trim())}`);
	if (bodyLines.length === 0) {
		return header;
	}
	return `${header}\n\n${bodyLines.join("\n")}`;
}
