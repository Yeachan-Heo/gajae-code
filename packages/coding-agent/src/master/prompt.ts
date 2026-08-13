/**
 * Master-mode system prompt section (static prompt text only; no runtime deps).
 */
import masterModePrompt from "./master-mode-prompt.md" with { type: "text" };

/** Dedicated master-mode block appended to the system prompt of master sessions. */
export function masterModeSystemPromptSection(): string {
	return masterModePrompt.trim();
}
