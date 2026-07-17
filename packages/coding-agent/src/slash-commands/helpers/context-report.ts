import type { AgentMessage } from "@gajae-code/agent-core";
import { type CompactionSettings, calculatePromptTokens } from "@gajae-code/agent-core/compaction";
import type { AssistantMessage, Usage } from "@gajae-code/ai";
import { computeContextBreakdown } from "../../modes/utils/context-usage";
import type { CompactionEntry, SessionEntry } from "../../session/session-manager";
import type { SlashCommandRuntime } from "../types";
import { renderAsciiBar } from "./format";

interface ActiveHistorySummary {
	activeMessages: readonly AgentMessage[];
	rawBranchMessages: number;
	rawBranchEntries: number;
	compaction: CompactionEntry | undefined;
	compactedRawMessages: number | undefined;
}

function isMessageEntry(entry: SessionEntry): boolean {
	return entry.type === "message" || entry.type === "custom_message" || entry.type === "branch_summary";
}

function summarizeActiveHistory(runtime: SlashCommandRuntime): ActiveHistorySummary {
	const activeContext = runtime.sessionManager.buildSessionContext();
	const branch = runtime.sessionManager.getBranch();
	let compaction: CompactionEntry | undefined;
	let compactionIndex = -1;
	for (let i = branch.length - 1; i >= 0; i--) {
		const entry = branch[i];
		if (entry.type === "compaction") {
			compaction = entry;
			compactionIndex = i;
			break;
		}
	}

	const rawBranchMessages = branch.filter(isMessageEntry).length;
	let compactedRawMessages: number | undefined;
	if (compaction) {
		const firstKeptIndex = branch.findIndex(entry => entry.id === compaction?.firstKeptEntryId);
		if (firstKeptIndex >= 0 && compactionIndex >= 0) {
			compactedRawMessages = branch.slice(0, firstKeptIndex).filter(isMessageEntry).length;
		}
	}

	return {
		activeMessages: activeContext.messages,
		rawBranchMessages,
		rawBranchEntries: branch.length,
		compaction,
		compactedRawMessages,
	};
}

function findLastAssistantUsage(messages: readonly AgentMessage[]):
	| {
			message: AssistantMessage;
			usage: Usage;
	  }
	| undefined {
	for (let i = messages.length - 1; i >= 0; i--) {
		const message = messages[i];
		if (message.role === "assistant") {
			const assistant = message as AssistantMessage;
			return { message: assistant, usage: assistant.usage };
		}
	}
	return undefined;
}

function formatUnknownNumber(value: number | undefined): string {
	return value === undefined ? "unknown" : value.toLocaleString();
}

function formatTokenLine(label: string, tokens: number, contextWindow: number): string {
	const fraction = contextWindow > 0 ? tokens / contextWindow : 0;
	return `  ${label.padEnd(16)} ${renderAsciiBar(fraction)}  ${tokens.toLocaleString()} tokens`;
}

function formatReserveText(runtime: SlashCommandRuntime, contextWindow: number, reserveTokens: number): string {
	if (contextWindow <= 0) return "unknown";
	if (reserveTokens > 0) return `${reserveTokens.toLocaleString()} tokens`;
	const compaction = runtime.settings.getGroup("compaction") as CompactionSettings;
	if (!compaction.enabled || compaction.strategy === "off") return "none configured";
	return "unknown";
}

function contextUsageSourceLabel(source: "provider_anchor" | "heuristic" | "unknown"): string {
	if (source === "provider_anchor") return "provider-reported";
	if (source === "unknown") return "estimated; exact count unknown until next response";
	return "estimated";
}

/**
 * Build the `/context` ACP-mode text. Tries the rich breakdown first
 * (categories + auto-compact buffer + free slack) and falls back to the
 * minimal "window/used" lines when the breakdown helper throws.
 */
export function buildContextReportText(runtime: SlashCommandRuntime): string {
	try {
		const history = summarizeActiveHistory(runtime);
		const breakdown = computeContextBreakdown(runtime.session, { messages: history.activeMessages });
		if (breakdown.contextWindow <= 0) {
			return "Context usage is unavailable: no model is selected for this session.";
		}
		const promptUsage = findLastAssistantUsage(history.activeMessages);
		const activeContext =
			breakdown.usedTokens === null
				? `Active context: unknown / ${breakdown.contextWindow.toLocaleString()} tokens (exact count unknown until next response) (${contextUsageSourceLabel(breakdown.source)})`
				: `Active context: ${breakdown.usedTokens.toLocaleString()} / ${breakdown.contextWindow.toLocaleString()} tokens (${((breakdown.usedTokens / breakdown.contextWindow) * 100).toFixed(1)}% used) (${contextUsageSourceLabel(breakdown.source)})`;
		const lines = [
			"Context usage",
			`Model: ${breakdown.model?.provider ?? "unknown"}/${breakdown.model?.id ?? "unknown"}`,
			activeContext,
			...(breakdown.source !== "unknown" &&
			breakdown.usedTokens !== null &&
			breakdown.estimatedCategoryTotal !== breakdown.usedTokens
				? [
						`Estimated category total: ${breakdown.estimatedCategoryTotal.toLocaleString()} tokens (composition below is estimated)`,
					]
				: []),
			`Reserve: ${formatReserveText(runtime, breakdown.contextWindow, breakdown.autoCompactBufferTokens)}`,
			"",
			"Active context breakdown (estimated)",
		];
		for (const category of breakdown.categories) {
			lines.push(formatTokenLine(category.label, category.tokens, breakdown.contextWindow));
		}
		if (breakdown.autoCompactBufferTokens > 0) {
			lines.push(formatTokenLine("Reserve", breakdown.autoCompactBufferTokens, breakdown.contextWindow));
		}
		lines.push(
			formatTokenLine(
				breakdown.usedTokens === null ? "Free (estimated)" : "Free",
				breakdown.freeTokens,
				breakdown.contextWindow,
			),
		);
		lines.push(
			"",
			"History",
			`Active messages sent next turn: ${history.activeMessages.length.toLocaleString()}`,
			`Raw branch history: ${history.rawBranchMessages.toLocaleString()} message entries / ${history.rawBranchEntries.toLocaleString()} total entries`,
			history.compaction
				? `Compacted history: summary active; compacted raw messages: ${formatUnknownNumber(history.compactedRawMessages)}; tokens before compaction: ${history.compaction.tokensBefore.toLocaleString()}`
				: "Compacted history: none on active branch",
			"",
			"Last recorded provider turn",
		);
		if (promptUsage) {
			lines.push(
				`Model: ${promptUsage.message.provider}/${promptUsage.message.model}`,
				`Prompt tokens: ${calculatePromptTokens(promptUsage.usage).toLocaleString()}`,
				`Input/output/cache: ${promptUsage.usage.input.toLocaleString()} / ${promptUsage.usage.output.toLocaleString()} / ${(
					promptUsage.usage.cacheRead + promptUsage.usage.cacheWrite
				).toLocaleString()}`,
				`Cost: $${promptUsage.usage.cost.total.toFixed(6)}`,
			);
		} else {
			lines.push("Usage/cost: unknown (no assistant response with recorded provider usage yet)");
		}
		return lines.join("\n");
	} catch {
		const fallback = runtime.session.getContextUsage();
		if (!fallback) return "Context usage is unavailable.";
		return [
			"Context usage",
			`Active context: ${fallback.tokens === null ? "unknown" : fallback.tokens.toLocaleString()} (${contextUsageSourceLabel(fallback.source)})`,
			`Context window: ${fallback.contextWindow.toLocaleString()}`,
			"Breakdown: unknown",
		].join("\n");
	}
}
