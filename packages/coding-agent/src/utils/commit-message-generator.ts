/**
 * Generate commit messages from diffs using the default model.
 * Follows the same pattern as title-generator.ts.
 */
import type { ThinkingLevel } from "@gajae-code/agent-core";
import type { Api, Model } from "@gajae-code/ai/core";
import { completeSimple } from "@gajae-code/ai/core";
import { logger, prompt, redactCrashSecrets } from "@gajae-code/utils";
import { redactChangelogEntry } from "../commit/changelog";
import type { ModelRegistry } from "../config/model-registry";
import { resolveModelRoleValue } from "../config/model-resolver";
import type { Settings } from "../config/settings";
import commitSystemPrompt from "../prompts/system/commit-message-system.md" with { type: "text" };
import { toReasoningEffort } from "../thinking";

const COMMIT_SYSTEM_PROMPT = prompt.render(commitSystemPrompt);
const MAX_DIFF_CHARS = 4000;
const COMMIT_MAX_TOKENS = 60;
const REASONING_SAFE_MAX_TOKENS = 1024;

/** File patterns that should be excluded from commit message generation diffs. */
const NOISE_SUFFIXES = [".lock", ".lockb", "-lock.json", "-lock.yaml"];

/** Strip diff hunks for noisy files that drown out real changes. */
function filterDiffNoise(diff: string): string {
	const lines = diff.split("\n");
	const filtered: string[] = [];
	let skip = false;
	for (const line of lines) {
		if (line.startsWith("diff --git ")) {
			const bPath = line.split(" b/")[1];
			skip = bPath != null && NOISE_SUFFIXES.some(s => bPath.endsWith(s));
		}
		if (!skip) filtered.push(line);
	}
	return filtered.join("\n");
}

/** Keep changelog patterns, then scrub known credential shapes on the whole string. */
function redactCommitMessageText(text: string): string {
	return redactCrashSecrets(redactChangelogEntry(text));
}

function getModelCandidates(
	registry: ModelRegistry,
	settings: Settings,
	credentialSessionId?: string,
): Array<{ model: Model<Api>; thinkingLevel?: ThinkingLevel }> {
	const availableModels = registry.getAvailable(credentialSessionId);
	if (availableModels.length === 0) return [];

	const candidates: Array<{ model: Model<Api>; thinkingLevel?: ThinkingLevel }> = [];
	const addCandidate = (model?: Model<Api>, thinkingLevel?: ThinkingLevel): void => {
		if (!model) return;
		if (candidates.some(c => c.model.provider === model.provider && c.model.id === model.id)) return;
		candidates.push({ model, thinkingLevel });
	};

	const matchPreferences = { usageOrder: settings.getStorage()?.getModelUsageOrder() };
	const configured = resolveModelRoleValue(settings.getModelRole("default"), availableModels, {
		settings,
		matchPreferences,
		modelRegistry: registry,
	});
	addCandidate(configured.model, configured.thinkingLevel);

	for (const model of availableModels) {
		addCandidate(model);
	}

	return candidates;
}

/**
 * Generate a commit message from a unified diff.
 * Returns null if generation fails (caller should fall back to generic message).
 */
export async function generateCommitMessage(
	diff: string,
	registry: ModelRegistry,
	settings: Settings,
	sessionId?: string,
): Promise<string | null> {
	const candidates = getModelCandidates(registry, settings, sessionId);
	if (candidates.length === 0) {
		logger.debug("commit-msg-generator: no model found");
		return null;
	}

	const cleanDiff = filterDiffNoise(diff);
	const truncatedDiff =
		cleanDiff.length > MAX_DIFF_CHARS ? `${cleanDiff.slice(0, MAX_DIFF_CHARS)}\n… (truncated)` : cleanDiff;
	if (!truncatedDiff.trim()) {
		logger.debug("commit-msg-generator: diff is empty after noise filtering");
		return null;
	}
	const userMessage = `<diff>\n${redactCommitMessageText(truncatedDiff)}\n</diff>`;

	for (const candidate of candidates) {
		const apiKey = await registry.getApiKey(candidate.model, sessionId);
		if (!apiKey) continue;

		try {
			const maxTokens = candidate.model.reasoning
				? Math.max(COMMIT_MAX_TOKENS, REASONING_SAFE_MAX_TOKENS)
				: COMMIT_MAX_TOKENS;
			const response = await completeSimple(
				candidate.model,
				{
					systemPrompt: [COMMIT_SYSTEM_PROMPT],
					messages: [{ role: "user", content: userMessage, timestamp: Date.now() }],
				},
				{ apiKey, maxTokens, reasoning: toReasoningEffort(candidate.thinkingLevel) },
			);

			if (response.stopReason === "error") {
				logger.debug("commit-msg-generator: error", { model: candidate.model.id, error: response.errorMessage });
				continue;
			}

			let msg = "";
			for (const content of response.content) {
				if (content.type === "text") msg += content.text;
			}
			msg = msg.trim();
			if (!msg) continue;

			// Clean up: remove wrapping quotes, backticks, trailing period
			msg = msg.replace(/^[`"']|[`"']$/g, "").replace(/\.$/, "");
			msg = redactCommitMessageText(msg);

			logger.debug("commit-msg-generator: generated", { model: candidate.model.id, msg });
			return msg;
		} catch (err) {
			logger.debug("commit-msg-generator: error", {
				model: candidate.model.id,
				error: err instanceof Error ? err.message : String(err),
			});
		}
	}

	return null;
}
