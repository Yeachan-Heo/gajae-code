/**
 * Context compaction for long sessions.
 *
 * Pure functions for compaction logic. The session manager handles I/O,
 * and after compaction the session is reloaded.
 */

import * as os from "node:os";
import {
	type AssistantMessage,
	Effort,
	type Message,
	type MessageAttribution,
	type Model,
	type ProviderSessionState,
	type Usage,
} from "@gajae-code/ai";
import { logger, prompt } from "@gajae-code/utils";
import { type AgentTelemetry, instrumentedCompleteSimple } from "../telemetry";
import type { AgentMessage, AgentTool } from "../types";
import type { CompactionEntry, SessionEntry } from "./entries";
import { type ConvertToLlm, convertToLlm, createBranchSummaryMessage, createCustomMessage } from "./messages";
import {
	buildOpenAiNativeHistory,
	getPreservedOpenAiRemoteCompactionData,
	requestOpenAiRemoteCompaction,
	requestRemoteCompaction,
	shouldUseOpenAiRemoteCompaction,
	withOpenAiRemoteCompactionPreserveData,
} from "./openai";
import autoHandoffThresholdFocusPrompt from "./prompts/auto-handoff-threshold-focus.md" with { type: "text" };
import compactionSummaryPrompt from "./prompts/compaction-summary.md" with { type: "text" };
import compactionTurnPrefixPrompt from "./prompts/compaction-turn-prefix.md" with { type: "text" };
import compactionUpdateSummaryPrompt from "./prompts/compaction-update-summary.md" with { type: "text" };
import handoffDocumentPrompt from "./prompts/handoff-document.md" with { type: "text" };

import {
	computeFileLists,
	createFileOps,
	extractFileOpsFromMessage,
	type FileOperations,
	SUMMARIZATION_SYSTEM_PROMPT,
	serializeConversation,
	upsertFileOperations,
} from "./utils";

// ============================================================================
// File Operation Tracking
// ============================================================================

/** Details stored in CompactionEntry.details for file tracking */
export interface CompactionDetails {
	readFiles: string[];
	modifiedFiles: string[];
}

/**
 * Extract file operations from messages and previous compaction entries.
 */
function extractFileOperations(
	messages: AgentMessage[],
	entries: SessionEntry[],
	prevCompactionIndex: number,
): FileOperations {
	const fileOps = createFileOps();

	// Collect from previous compaction's details (if pi-generated)
	if (prevCompactionIndex >= 0) {
		const prevCompaction = entries[prevCompactionIndex] as CompactionEntry;
		if (!prevCompaction.fromExtension && prevCompaction.details) {
			const details = prevCompaction.details as CompactionDetails;
			if (Array.isArray(details.readFiles)) {
				for (const f of details.readFiles) fileOps.read.add(f);
			}
			if (Array.isArray(details.modifiedFiles)) {
				for (const f of details.modifiedFiles) fileOps.edited.add(f);
			}
		}
	}

	// Extract from tool calls in messages
	for (const msg of messages) {
		extractFileOpsFromMessage(msg, fileOps);
	}

	return fileOps;
}

// ============================================================================
// Message Extraction
// ============================================================================

/**
 * Extract AgentMessage from an entry if it produces one.
 * Returns undefined for entries that don't contribute to LLM context.
 */
function getMessageFromEntry(entry: SessionEntry): AgentMessage | undefined {
	if (entry.type === "message") {
		return entry.message;
	}
	if (entry.type === "custom_message") {
		return createCustomMessage(
			entry.customType,
			entry.content,
			entry.display,
			entry.details,
			entry.timestamp,
			entry.attribution,
		);
	}
	if (entry.type === "branch_summary") {
		return createBranchSummaryMessage(entry.summary, entry.fromId, entry.timestamp);
	}
	return undefined;
}

/** Result from compact() - SessionManager adds uuid/parentUuid when saving */
export interface CompactionResult<T = unknown> {
	summary: string;
	/** Short PR-style summary for display purposes. */
	shortSummary?: string;
	firstKeptEntryId: string;
	tokensBefore: number;
	/** Hook-specific data (e.g., ArtifactIndex, version markers for structured compaction) */
	details?: T;
	/** Hook-provided data to persist alongside compaction entry. */
	preserveData?: Record<string, unknown>;
}

// ============================================================================
// Types
// ============================================================================

export interface CompactionSettings {
	enabled: boolean;
	strategy?: "context-full" | "handoff" | "off";
	thresholdPercent?: number;
	thresholdTokens?: number;
	reserveTokens: number;
	keepRecentTokens: number;
	autoContinue?: boolean;
	remoteEnabled?: boolean;
	remoteEndpoint?: string;
}

export type RemoteCompactionFallbackHealthEvent =
	| { kind: "success"; model: string; provider: string }
	| { kind: "fallback"; model: string; provider: string; error: string };

export interface RemoteCompactionFallbackHealthHooks {
	recordRemoteCompactionFallback(event: RemoteCompactionFallbackHealthEvent): void;
}

function isAbortError(error: unknown): boolean {
	return error instanceof Error && error.name === "AbortError";
}

export const DEFAULT_COMPACTION_SETTINGS: CompactionSettings = {
	enabled: true,
	strategy: "context-full",
	thresholdPercent: -1,
	thresholdTokens: -1,
	reserveTokens: 16384,
	keepRecentTokens: 20000,
	autoContinue: true,
	remoteEnabled: true,
};

// ============================================================================
// Token calculation
// ============================================================================

/**
 * Calculate total context tokens from usage.
 * Uses the native totalTokens field when available, falls back to computing from components.
 */
export function calculateContextTokens(usage: Usage): number {
	return usage.totalTokens || usage.input + usage.output + usage.cacheRead + usage.cacheWrite;
}

export function calculatePromptTokens(usage: Usage): number {
	const promptTokens = usage.input + usage.cacheRead + usage.cacheWrite;
	if (promptTokens > 0) {
		return promptTokens;
	}
	return calculateContextTokens(usage);
}

/**
 * Get usage from an assistant message if available.
 * Skips aborted and error messages as they don't have valid usage data.
 */
function getAssistantUsage(msg: AgentMessage): Usage | undefined {
	if (msg.role === "assistant" && "usage" in msg) {
		const assistantMsg = msg as AssistantMessage;
		if (assistantMsg.stopReason !== "aborted" && assistantMsg.stopReason !== "error" && assistantMsg.usage) {
			return assistantMsg.usage;
		}
	}
	return undefined;
}

/**
 * Find the last non-aborted assistant message usage from session entries.
 */
export function getLastAssistantUsage(entries: SessionEntry[]): Usage | undefined {
	for (let i = entries.length - 1; i >= 0; i--) {
		const entry = entries[i];
		if (entry.type === "message") {
			const usage = getAssistantUsage(entry.message);
			if (usage) return usage;
		}
	}
	return undefined;
}

/**
 * Effective reserve: the largest of 15% of the context window, the configured floor,
 * and the model's reserved completion budget (`maxOutputTokens`).
 *
 * Reserving `maxOutputTokens` keeps the safe input/prompt-packing budget below the
 * *total* context window for models whose completion reservation exceeds the 15%
 * floor (e.g. a 400K-context model with 128K max output reserves 128K, not 60K, so
 * input is capped near 272K instead of 340K).
 */
export function effectiveReserveTokens(
	contextWindow: number,
	settings: CompactionSettings,
	maxOutputTokens = 0,
): number {
	return Math.max(Math.floor(contextWindow * 0.15), settings.reserveTokens, Math.max(0, maxOutputTokens));
}

/**
 * Check if compaction should trigger based on context usage.
 *
 * `maxOutputTokens` is the model's reserved completion budget; it is excluded from
 * the safe input budget so prompt + reserved output cannot exceed the total window.
 */
export function shouldCompact(
	contextTokens: number,
	contextWindow: number,
	settings: CompactionSettings,
	maxOutputTokens = 0,
): boolean {
	if (!settings.enabled || settings.strategy === "off" || contextWindow <= 0) return false;
	const thresholdTokens = resolveThresholdTokens(contextWindow, settings, maxOutputTokens);
	return contextTokens > thresholdTokens;
}

/** Reason a compaction was triggered. `token` is the normal user-configurable path; the rest are emergency floors. */
export type CompactionTriggerReason =
	| "token"
	| "heap"
	| "retainedMemory"
	| "providerBytes"
	| "messageCount"
	| "imageBytes";

/** A point-in-time resource sample. Supplied by an injectable sampler so tests never read real RSS. */
export interface EmergencyCompactionSample {
	/** Resident heap bytes (e.g. process.memoryUsage().heapUsed). */
	heapUsedBytes: number;
	/** Approximate serialized provider-context bytes. */
	providerBytes: number;
	/** Provider-visible message count. */
	messageCount: number;
	/** Approximate inline image bytes in the provider context. */
	imageBytes: number;
	/** Bytes retained by session resident image sentinels; separate from provider-visible bytes. */
	sessionResidentImageBytes?: number;
	/** Bytes retained by non-provider materialized/session-local caches. */
	materializedResidentBytes?: number;
	/** Number of live TUI chat-container children. */
	tuiChatChildren?: number;
	/** Bytes retained by TUI render caches. */
	tuiCachedRenderBytes?: number;
}

export interface EmergencyCompactionLimits {
	heapUsedBytes: number;
	providerBytes: number;
	messageCount: number;
	imageBytes: number;
	retainedMemoryBytes?: number;
	retainedMemoryDiagnosticBytes?: number;
	tuiChatChildren?: number;
	tuiChatChildrenDiagnostic?: number;
}

const MAX_EMERGENCY_HEAP_FLOOR_BYTES = 1_536 * 1024 * 1024; // 1.5 GiB resident heap
const EMERGENCY_RETAINED_MEMORY_BYTES = 128 * 1024 * 1024;
const DIAGNOSTIC_RETAINED_MEMORY_BYTES = 64 * 1024 * 1024;
const EMERGENCY_TUI_CHAT_CHILDREN = 1000;
const DIAGNOSTIC_TUI_CHAT_CHILDREN = 700;
let retainedMemoryDiagnosticActive = false;
let tuiChatChildrenDiagnosticActive = false;

export function resetEmergencyRetainedMemoryDiagnosticsForTests(): void {
	retainedMemoryDiagnosticActive = false;
	tuiChatChildrenDiagnosticActive = false;
}

export function resolveEmergencyCompactionLimits(totalMemoryBytes: number = os.totalmem()): EmergencyCompactionLimits {
	// Invalid or non-positive total memory (bad injection, exotic platform)
	// must never disable the heap floor — fall back to the fixed 1.5 GiB cap.
	const safeTotal =
		Number.isFinite(totalMemoryBytes) && totalMemoryBytes > 0 ? totalMemoryBytes : Number.POSITIVE_INFINITY;
	return {
		heapUsedBytes: Math.min(MAX_EMERGENCY_HEAP_FLOOR_BYTES, Math.floor(0.5 * safeTotal)),
		providerBytes: 24 * 1024 * 1024, // 24 MiB serialized provider context
		messageCount: 4000,
		imageBytes: 64 * 1024 * 1024, // 64 MiB inline image bytes
		retainedMemoryBytes: EMERGENCY_RETAINED_MEMORY_BYTES,
		retainedMemoryDiagnosticBytes: DIAGNOSTIC_RETAINED_MEMORY_BYTES,
		tuiChatChildren: EMERGENCY_TUI_CHAT_CHILDREN,
		tuiChatChildrenDiagnostic: DIAGNOSTIC_TUI_CHAT_CHILDREN,
	};
}

/**
 * Non-disableable emergency floors. These sit well above normal usage and exist so a
 * long session on weak hardware compacts before OOM even when token-based compaction is
 * disabled or its threshold is set too high. They are NOT user-tunable down to zero.
 */
export const DEFAULT_EMERGENCY_COMPACTION_LIMITS: EmergencyCompactionLimits = resolveEmergencyCompactionLimits();

/**
 * Returns the first emergency limit exceeded (heap > retainedMemory > providerBytes > imageBytes > messageCount),
 * or null when none is. Pure apart from retained-memory diagnostics; the caller routes the result through the
 * normal pair-safe `compact()` cut logic so a tool_use/tool_result pair is never split.
 */
export function emergencyCompactionReason(
	sample: EmergencyCompactionSample,
	limits: EmergencyCompactionLimits = resolveEmergencyCompactionLimits(),
): CompactionTriggerReason | null {
	const retainedMemoryBytes = (sample.materializedResidentBytes ?? 0) + (sample.tuiCachedRenderBytes ?? 0);
	const tuiChatChildren = sample.tuiChatChildren ?? 0;
	const retainedDiagnostic =
		retainedMemoryBytes >= (limits.retainedMemoryDiagnosticBytes ?? DIAGNOSTIC_RETAINED_MEMORY_BYTES);
	const childDiagnostic = tuiChatChildren >= (limits.tuiChatChildrenDiagnostic ?? DIAGNOSTIC_TUI_CHAT_CHILDREN);
	if (retainedDiagnostic && !retainedMemoryDiagnosticActive) {
		logger.warn("Emergency compaction retained-memory diagnostic threshold crossed", {
			retainedMemoryBytes,
			limitBytes: limits.retainedMemoryDiagnosticBytes ?? DIAGNOSTIC_RETAINED_MEMORY_BYTES,
		});
	}
	if (childDiagnostic && !tuiChatChildrenDiagnosticActive) {
		logger.warn("Emergency compaction TUI chat-child diagnostic threshold crossed", {
			tuiChatChildren,
			limit: limits.tuiChatChildrenDiagnostic ?? DIAGNOSTIC_TUI_CHAT_CHILDREN,
		});
	}
	retainedMemoryDiagnosticActive = retainedDiagnostic;
	tuiChatChildrenDiagnosticActive = childDiagnostic;

	if (sample.heapUsedBytes > limits.heapUsedBytes) return "heap";
	if (
		retainedMemoryBytes >= (limits.retainedMemoryBytes ?? EMERGENCY_RETAINED_MEMORY_BYTES) ||
		tuiChatChildren >= (limits.tuiChatChildren ?? EMERGENCY_TUI_CHAT_CHILDREN)
	)
		return "retainedMemory";
	if (sample.providerBytes > limits.providerBytes) return "providerBytes";
	if (sample.imageBytes > limits.imageBytes) return "imageBytes";
	if (sample.messageCount > limits.messageCount) return "messageCount";
	return null;
}

export function resolveThresholdTokens(
	contextWindow: number,
	settings: CompactionSettings,
	maxOutputTokens = 0,
): number {
	// Fixed token limit takes priority over percentage
	const thresholdTokens = settings.thresholdTokens;
	if (typeof thresholdTokens === "number" && Number.isFinite(thresholdTokens) && thresholdTokens > 0) {
		// Clamp to [1, contextWindow - 1] so there's always room
		return Math.min(contextWindow - 1, Math.max(1, thresholdTokens));
	}

	// Percentage-based threshold
	const thresholdPercent = settings.thresholdPercent;
	if (typeof thresholdPercent !== "number" || !Number.isFinite(thresholdPercent) || thresholdPercent <= 0) {
		return contextWindow - effectiveReserveTokens(contextWindow, settings, maxOutputTokens);
	}
	const clampedThresholdPercent = Math.min(99, Math.max(1, thresholdPercent));
	return Math.floor(contextWindow * (clampedThresholdPercent / 100));
}

// ============================================================================
// Cut point detection
// ============================================================================

/**
 * Image content has no tokenizer representation; charge a fixed estimate
 * matching what providers typically bill for inline images.
 */
export const IMAGE_TOKEN_ESTIMATE = 1200;
/**
 * Estimate tokens for collected message fragments using the native-free
 * heuristic. Provider usage is the authoritative anchor for context-changing
 * decisions (see {@link calculatePromptTokens}); this chars/4 estimate covers
 * only unsent/trailing deltas and per-entry budgeting, and callers add a
 * conservative inflation factor where threshold safety requires it.
 */
function countCollectedMessageFragments(collected: { fragments: string[]; extra: number }): number {
	return estimateTextTokensHeuristic(collected.fragments) + collected.extra;
}

/**
 * Average bytes per token for the cheap heuristic. ~4 bytes/token is the
 * conventional approximation for English/code text under modern BPE
 * vocabularies; it intentionally errs slightly low-precision in exchange for
 * never touching the native tokenizer (and its ~50MB BPE table).
 */
const HEURISTIC_BYTES_PER_TOKEN = 4;

/**
 * Token-dense character weight for the script-aware heuristic.
 *
 * Common-BMP CJK blocks (Hangul, unified/compat Han, Kana, CJK punctuation,
 * full-width forms) tokenize at ~0.6–1.0 tokens per character under
 * o200k-class BPE vocabularies (measured o200k_base: Hangul prose 0.604,
 * spaceless Hangul 0.964, Han 0.793, Kana 0.740 tokens/char — versus the
 * 0.25 the chars/4 heuristic assumes). Each such character is charged 1
 * token: an upper bound for these measured blocks whose only failure mode is
 * compacting slightly early, while undercounting risks overflowing the
 * provider window.
 *
 * Surrogate code units are charged 0.5 each, i.e. 1 token per supplementary
 * code point (supplementary Han extensions, emoji, and other astral chars).
 * That is a floor rather than an upper bound — rare ideographs and emoji can
 * cost several tokens — but it is strictly safer than the 0.5-per-pair the
 * plain chars/4 rule produced.
 */
function tokenDenseCharWeight(text: string): { weight: number; units: number } {
	let weight = 0;
	let units = 0;
	for (let i = 0; i < text.length; i++) {
		const c = text.charCodeAt(i);
		if (
			(c >= 0x1100 && c <= 0x11ff) || // Hangul Jamo
			(c >= 0x3000 && c <= 0x303f) || // CJK symbols & punctuation
			(c >= 0x3040 && c <= 0x30ff) || // Hiragana & Katakana
			(c >= 0x3130 && c <= 0x318f) || // Hangul compatibility Jamo
			(c >= 0x3400 && c <= 0x4dbf) || // CJK ideographs extension A
			(c >= 0x4e00 && c <= 0x9fff) || // CJK unified ideographs
			(c >= 0xac00 && c <= 0xd7af) || // Hangul syllables
			(c >= 0xf900 && c <= 0xfaff) || // CJK compatibility ideographs
			(c >= 0xff00 && c <= 0xffef) // Half/full-width forms
		) {
			weight += 1;
			units += 1;
		} else if (c >= 0xd800 && c <= 0xdfff) {
			// Surrogate half: a supplementary code point contributes two units.
			weight += 0.5;
			units += 1;
		}
	}
	return { weight, units };
}

/**
 * Script-aware native-free token estimate for a plain string fragment:
 * token-dense characters cost ~1 token each, everything else chars/4.
 */
function estimateFragmentTokensHeuristic(fragment: string): { dense: number; otherChars: number } {
	const { weight, units } = tokenDenseCharWeight(fragment);
	return { dense: weight, otherChars: fragment.length - units };
}

/**
 * Native-free token estimate for a message. This is the only message
 * token estimator: provider usage (see {@link calculatePromptTokens}) anchors
 * the already-sent context, and this covers unsent/trailing deltas, per-entry
 * budgeting, and display surfaces. Callers add a conservative inflation factor
 * where compaction-threshold safety requires it.
 */
export function estimateMessageTokensHeuristic(message: AgentMessage): number {
	const { fragments, extra } = collectMessageFragments(message);
	return extra + estimateTextTokensHeuristic(fragments);
}

/**
 * Script-aware native-free token estimate for plain string fragments.
 * Fragment-level counterpart of {@link estimateMessageTokensHeuristic}.
 */
export function estimateTextTokensHeuristic(fragments: string | readonly string[]): number {
	const list = typeof fragments === "string" ? [fragments] : fragments;
	let dense = 0;
	let otherChars = 0;
	for (const fragment of list) {
		const counts = estimateFragmentTokensHeuristic(fragment);
		dense += counts.dense;
		otherChars += counts.otherChars;
	}
	return Math.ceil(dense + Math.max(0, otherChars) / HEURISTIC_BYTES_PER_TOKEN);
}

/** Shared content walk for both the native and heuristic estimators. */
function collectMessageFragments(message: AgentMessage): { fragments: string[]; extra: number } {
	const fragments: string[] = [];
	let extra = 0;
	if ((message as { role?: string }).role === "bashExecution") {
		const bash = message as { command?: unknown; output?: unknown };
		if (typeof bash.command === "string") fragments.push(bash.command);
		if (typeof bash.output === "string") fragments.push(bash.output);
		return { fragments, extra };
	}

	switch (message.role) {
		case "user":
		case "custom": {
			const content = (message as { content: string | Array<{ type: string; text?: string }> }).content;
			if (typeof content === "string") {
				fragments.push(content);
			} else if (Array.isArray(content)) {
				for (const block of content) {
					if (block.type === "text" && block.text) {
						fragments.push(block.text);
					}
				}
			}
			break;
		}
		case "assistant": {
			const assistant = message as AssistantMessage;
			for (const block of assistant.content) {
				if (block.type === "text") {
					fragments.push(block.text);
				} else if (block.type === "thinking") {
					fragments.push(block.thinking);
				} else if (block.type === "toolCall") {
					fragments.push(block.name);
					fragments.push(JSON.stringify(block.arguments));
				}
			}
			break;
		}
		case "hookMessage":
		case "toolResult": {
			if (typeof message.content === "string") {
				fragments.push(message.content);
			} else {
				for (const block of message.content) {
					if (block.type === "text" && block.text) {
						fragments.push(block.text);
					} else if (block.type === "image") {
						extra += IMAGE_TOKEN_ESTIMATE;
					}
				}
			}
			break;
		}
		case "branchSummary":
		case "compactionSummary": {
			fragments.push(message.summary);
			break;
		}
		default:
			break;
	}

	return { fragments, extra };
}

function entryTokenFingerprint(
	entry: SessionEntry,
	message: AgentMessage,
	collected: { fragments: string[]; extra: number },
): string {
	const maybePruned = message as { prunedAt?: unknown };
	let fingerprint = `${entry.type.length}:${entry.type}${(entry.id ?? "").length}:${entry.id ?? ""}${message.role.length}:${message.role}${String(collected.extra).length}:${String(collected.extra)}${collected.fragments.length}:`;
	for (const fragment of collected.fragments) fingerprint += `${fragment.length}:${fragment}`;
	if (maybePruned.prunedAt !== undefined) {
		const prunedAt = String(maybePruned.prunedAt);
		fingerprint += `prunedAt${prunedAt.length}:${prunedAt}`;
	}
	return fingerprint;
}

const entryTokenCache = new WeakMap<SessionEntry, { fingerprint: string; tokens: number }>();

export function estimateEntryTokens(entry: SessionEntry): number {
	const msg = getMessageFromEntry(entry);
	if (!msg) return 0;
	const collected = collectMessageFragments(msg);
	const fingerprint = entryTokenFingerprint(entry, msg, collected);
	const cached = entryTokenCache.get(entry);
	if (cached?.fingerprint === fingerprint) return cached.tokens;
	const tokens = countCollectedMessageFragments(collected);
	entryTokenCache.set(entry, { fingerprint, tokens });
	return tokens;
}

export function estimateEntriesTokens(entries: SessionEntry[], startIndex: number, endIndex: number): number {
	let total = 0;
	for (let i = startIndex; i < endIndex; i++) {
		total += estimateEntryTokens(entries[i]);
	}
	return total;
}

/**
 * Find valid cut points: indices of user, assistant, custom, or bashExecution messages.
 * Never cut at tool results (they must follow their tool call).
 * When we cut at an assistant message with tool calls, its tool results follow it
 * and will be kept.
 * BashExecutionMessage is treated like a user message (user-initiated context).
 */
function findValidCutPoints(entries: SessionEntry[], startIndex: number, endIndex: number): number[] {
	const cutPoints: number[] = [];
	for (let i = startIndex; i < endIndex; i++) {
		const entry = entries[i];
		switch (entry.type) {
			case "message": {
				const role = entry.message.role as string;
				switch (role) {
					case "bashExecution":
					case "hookMessage":
					case "branchSummary":
					case "compactionSummary":
					case "user":
					case "assistant":
						cutPoints.push(i);
						break;
					case "toolResult":
						break;
				}
				break;
			}
			case "thinking_level_change":
			case "model_change":
			case "compaction":
			case "branch_summary":
			case "custom":
			case "custom_message":
			case "label":
		}
		// branch_summary and custom_message are user-role messages, valid cut points
		if (entry.type === "branch_summary" || entry.type === "custom_message") {
			cutPoints.push(i);
		}
	}
	return cutPoints;
}

/**
 * Find the user message (or bashExecution) that starts the turn containing the given entry index.
 * Returns -1 if no turn start found before the index.
 * BashExecutionMessage is treated like a user message for turn boundaries.
 */
export function findTurnStartIndex(entries: SessionEntry[], entryIndex: number, startIndex: number): number {
	for (let i = entryIndex; i >= startIndex; i--) {
		const entry = entries[i];
		// branch_summary and custom_message are user-role messages, can start a turn
		if (entry.type === "branch_summary" || entry.type === "custom_message") {
			return i;
		}
		if (entry.type === "message") {
			const role = entry.message.role as string;
			if (role === "user" || role === "bashExecution") {
				return i;
			}
		}
	}
	return -1;
}

export interface CutPointResult {
	/** Index of first entry to keep */
	firstKeptEntryIndex: number;
	/** Index of user message that starts the turn being split, or -1 if not splitting */
	turnStartIndex: number;
	/** Whether this cut splits a turn (cut point is not a user message) */
	isSplitTurn: boolean;
}

/**
 * Find the cut point in session entries that keeps approximately `keepRecentTokens`.
 *
 * Algorithm: Walk backwards from newest, accumulating estimated message sizes.
 * Stop when we've accumulated >= keepRecentTokens. Cut at that point.
 *
 * Can cut at user OR assistant messages (never tool results). When cutting at an
 * assistant message with tool calls, its tool results come after and will be kept.
 *
 * Returns CutPointResult with:
 * - firstKeptEntryIndex: the entry index to start keeping from
 * - turnStartIndex: if cutting mid-turn, the user message that started that turn
 * - isSplitTurn: whether we're cutting in the middle of a turn
 *
 * Only considers entries between `startIndex` and `endIndex` (exclusive).
 */
export function findCutPoint(
	entries: SessionEntry[],
	startIndex: number,
	endIndex: number,
	keepRecentTokens: number,
): CutPointResult {
	const cutPoints = findValidCutPoints(entries, startIndex, endIndex);

	if (cutPoints.length === 0) {
		return { firstKeptEntryIndex: startIndex, turnStartIndex: -1, isSplitTurn: false };
	}

	// Walk backwards from newest, accumulating estimated message sizes
	let accumulatedTokens = 0;
	let cutIndex = cutPoints[0]; // Default: keep from first message (not header)

	for (let i = endIndex - 1; i >= startIndex; i--) {
		const entry = entries[i];
		// Estimate this message's size
		const messageTokens = estimateEntryTokens(entry);
		accumulatedTokens += messageTokens;

		// Check if we've exceeded the budget
		if (accumulatedTokens >= keepRecentTokens) {
			// Find the closest valid cut point at or after this entry
			let foundCutPoint = false;
			for (let c = 0; c < cutPoints.length; c++) {
				if (cutPoints[c] >= i) {
					cutIndex = cutPoints[c];
					foundCutPoint = true;
					break;
				}
			}
			if (!foundCutPoint) {
				cutIndex = cutPoints[cutPoints.length - 1];
			}
			break;
		}
	}

	// Scan backwards from cutIndex to include any non-message entries (bash, settings, etc.)
	while (cutIndex > startIndex) {
		const prevEntry = entries[cutIndex - 1];
		// Stop at session header or compaction boundaries
		if (prevEntry.type === "compaction") {
			break;
		}
		if (prevEntry.type === "message") {
			// Stop if we hit any message
			break;
		}
		// Include this non-message entry (bash, settings change, etc.)
		cutIndex--;
	}

	// Determine if this is a split turn
	const cutEntry = entries[cutIndex];
	const isUserMessage = cutEntry.type === "message" && cutEntry.message.role === "user";
	const turnStartIndex = isUserMessage ? -1 : findTurnStartIndex(entries, cutIndex, startIndex);

	return {
		firstKeptEntryIndex: cutIndex,
		turnStartIndex,
		isSplitTurn: !isUserMessage && turnStartIndex !== -1,
	};
}

// ============================================================================
// Summarization
// ============================================================================

const SUMMARIZATION_PROMPT = prompt.render(compactionSummaryPrompt);

const UPDATE_SUMMARIZATION_PROMPT = prompt.render(compactionUpdateSummaryPrompt);

const HANDOFF_DOCUMENT_PROMPT = prompt.render(handoffDocumentPrompt);

export const AUTO_HANDOFF_THRESHOLD_FOCUS = prompt.render(autoHandoffThresholdFocusPrompt);

function formatAdditionalContext(context: string[] | undefined): string {
	if (!context || context.length === 0) return "";
	const lines = context.map(line => `- ${line}`).join("\n");
	return `<additional-context>\n${lines}\n</additional-context>\n\n`;
}

/**
 * Generate a summary of the conversation using the LLM.
 * If previousSummary is provided, uses the update prompt to merge.
 */
export interface SummaryOptions {
	promptOverride?: string;
	extraContext?: string[];
	remoteEndpoint?: string;
	remoteInstructions?: string;
	initiatorOverride?: MessageAttribution;
	metadata?: Record<string, unknown>;
	convertToLlm?: ConvertToLlm;
	/**
	 * Optional telemetry handle. When provided, every LLM call emitted during
	 * compaction is wrapped in an OTEL chat span tagged with
	 * `pi.gen_ai.oneshot.kind` (`compaction_summary` or `compaction_turn_prefix`).
	 */
	telemetry?: AgentTelemetry;
	authCredentialType?: "api_key" | "oauth";
	/**
	 * Provider session affinity id forwarded to the maintenance LLM call so it
	 * reuses the live turn's provider/WebSocket session (matches the
	 * `providerSessionId ?? sessionId` the agent loop sends for normal turns).
	 */
	sessionId?: string;
	/** Shared provider state map so maintenance calls reuse session-scoped transport/session caches. */
	providerSessionState?: Map<string, ProviderSessionState>;
	/** Hint that websocket transport should be preferred when supported by the provider implementation. */
	preferWebsockets?: boolean;
	/** Session-owned health sink for remote-compaction fallback transition logging. */
	remoteCompactionFallbackHealth?: RemoteCompactionFallbackHealthHooks;
}

/**
 * Cap the serialized conversation fed to a summarization request so the request
 * itself fits inside the model's context window.
 *
 * Without this, summarizing a near-full context serializes (nearly) the entire
 * history back into a single summary request; on strict backends (e.g.
 * OpenAI-code/Codex `context_length_exceeded`) that request itself overflows and
 * throws, so context-overflow recovery cannot produce a summary and the agent
 * fails to compact-and-continue — a non-interactive `gjc -p` run then terminates
 * on the very overflow the recovery was meant to absorb.
 *
 * The budget reserves the summary's own output tokens plus prompt/system/template
 * overhead, and applies a conservative safety factor for estimator error on
 * dense text (the reason the original overflow was missed).
 * Truncation keeps the head (origin/goals) and the tail (most recent state) and
 * elides the middle; it is a last resort that only triggers when the input would
 * otherwise not fit.
 */
export function boundConversationTextForSummary(
	conversationText: string,
	model: Model,
	outputMaxTokens: number,
): string {
	const contextWindow = model.contextWindow;
	if (!Number.isFinite(contextWindow) || contextWindow <= 0) return conversationText;

	const OVERHEAD_TOKENS = 4096;
	const SAFETY_FACTOR = 0.6;
	const inputBudgetTokens = Math.floor(
		(contextWindow - Math.max(0, outputMaxTokens) - OVERHEAD_TOKENS) * SAFETY_FACTOR,
	);
	const totalEstimatedTokens = estimateTextTokensHeuristic(conversationText);
	const assemble = (head: string, tail: string): string => {
		const elided = conversationText.length - head.length - tail.length;
		return `${head}\n\n[... ${elided} characters of older conversation elided so this summarization request fits within the model context window ...]\n\n${tail}`;
	};
	const bareMarker = assemble("", "");
	const fitsBudget = (candidate: string) => estimateTextTokensHeuristic(candidate) <= inputBudgetTokens;
	if (inputBudgetTokens <= 0) {
		// A window this small cannot fit any excerpt (not even the marker).
		// Fail closed with an empty excerpt rather than submitting text into a
		// request that is guaranteed to overflow.
		return "";
	}
	if (totalEstimatedTokens <= inputBudgetTokens) return conversationText;

	// Derive the character budget from the text's own measured token density
	// instead of assuming 4 chars/token: a CJK-heavy conversation runs near
	// 1 token/char, and a fixed 4-chars/token cut would overshoot the budget
	// by up to ~4x — re-overflowing the very request this bound protects.
	// Verify the complete assembled candidate (elision marker included)
	// against the estimator and shrink until it fits.
	const charsPerToken = conversationText.length / totalEstimatedTokens;
	let budgetChars = Math.floor(inputBudgetTokens * charsPerToken);
	for (let attempt = 0; attempt < 12 && budgetChars > 0; attempt++) {
		const headChars = Math.floor(budgetChars * 0.35);
		const tailChars = Math.max(0, budgetChars - headChars);
		const head = conversationText.slice(0, headChars);
		const tail = tailChars > 0 ? conversationText.slice(conversationText.length - tailChars) : "";
		const assembled = assemble(head, tail);
		if (fitsBudget(assembled)) return assembled;
		budgetChars = Math.floor(budgetChars * 0.8);
	}
	// All attempts overshot (adversarially non-uniform density, or a budget
	// smaller than the marker itself). Fail closed: return the bare marker
	// only when it fits the budget, else an empty excerpt — never an
	// over-budget result.
	return fitsBudget(bareMarker) ? bareMarker : "";
}

export async function generateSummary(
	currentMessages: AgentMessage[],
	model: Model,
	reserveTokens: number,
	apiKey: string,
	signal?: AbortSignal,
	customInstructions?: string,
	previousSummary?: string,
	options?: SummaryOptions,
): Promise<string> {
	const maxTokens = Math.floor(0.8 * reserveTokens);

	// Use update prompt if we have a previous summary, otherwise initial prompt
	let basePrompt = previousSummary ? UPDATE_SUMMARIZATION_PROMPT : SUMMARIZATION_PROMPT;
	if (options?.promptOverride) {
		basePrompt = options.promptOverride;
	}
	if (customInstructions) {
		basePrompt = `${basePrompt}\n\nAdditional focus: ${customInstructions}`;
	}

	// Serialize conversation to text so model doesn't try to continue it
	// Convert to LLM messages first (handles custom app messages when caller provides a transformer).
	const llmMessages = (options?.convertToLlm ?? convertToLlm)(currentMessages);
	const conversationText = boundConversationTextForSummary(serializeConversation(llmMessages), model, maxTokens);

	// Build the prompt with conversation wrapped in tags
	let promptText = `<conversation>\n${conversationText}\n</conversation>\n\n`;
	if (previousSummary) {
		promptText += `<previous-summary>\n${previousSummary}\n</previous-summary>\n\n`;
	}
	promptText += formatAdditionalContext(options?.extraContext);
	promptText += basePrompt;

	const summarizationMessages = [
		{
			role: "user" as const,
			content: [{ type: "text" as const, text: promptText }],
			timestamp: Date.now(),
		},
	];

	if (options?.remoteEndpoint) {
		const remote = await requestRemoteCompaction(
			options.remoteEndpoint,
			{
				systemPrompt: SUMMARIZATION_SYSTEM_PROMPT,
				prompt: promptText,
			},
			signal,
		);
		return remote.summary;
	}

	const response = await instrumentedCompleteSimple(
		model,
		{ systemPrompt: [SUMMARIZATION_SYSTEM_PROMPT], messages: summarizationMessages },
		{
			maxTokens,
			signal,
			apiKey,
			reasoning: Effort.High,
			initiatorOverride: options?.initiatorOverride,
			metadata: options?.metadata,
			sessionId: options?.sessionId,
			providerSessionState: options?.providerSessionState,
			preferWebsockets: options?.preferWebsockets,
		},
		{ telemetry: options?.telemetry, oneshotKind: "compaction_summary" },
	);

	if (response.stopReason === "error") {
		throw new Error(`Summarization failed: ${response.errorMessage || "Unknown error"}`);
	}

	const textContent = response.content
		.filter((c): c is { type: "text"; text: string } => c.type === "text")
		.map(c => c.text)
		.join("\n");

	return textContent;
}

// ============================================================================
// Handoff generation
// ============================================================================

export interface HandoffOptions {
	/** Live agent system prompt — passed verbatim so providers hit the cached prefix. */
	systemPrompt: string[];
	/** Live agent tool list — same purpose. Forced to `toolChoice: "none"`. */
	tools?: AgentTool<any>[];
	customInstructions?: string;
	/**
	 * Optional user-configured extension appended to the base handoff prompt.
	 * It SUPPLEMENTS the immutable base (safety/continuity structure); it never
	 * replaces `HANDOFF_DOCUMENT_PROMPT`.
	 */
	promptExtension?: string;
	convertToLlm?: ConvertToLlm;
	initiatorOverride?: MessageAttribution;
	metadata?: Record<string, unknown>;
	/**
	 * Optional telemetry handle. When provided, the handoff LLM call is
	 * wrapped in an OTEL chat span tagged with `pi.gen_ai.oneshot.kind = "handoff"`.
	 */
	telemetry?: AgentTelemetry;
	authCredentialType?: "api_key" | "oauth";
	/**
	 * Provider session affinity id forwarded to the handoff LLM call so it
	 * reuses the live turn's provider/WebSocket session.
	 */
	sessionId?: string;
	/** Shared provider state map so the handoff call reuses session-scoped transport/session caches. */
	providerSessionState?: Map<string, ProviderSessionState>;
	/** Hint that websocket transport should be preferred when supported by the provider implementation. */
	preferWebsockets?: boolean;
}

export function renderHandoffPrompt(customInstructions?: string, promptExtension?: string): string {
	if (!customInstructions && !promptExtension) return HANDOFF_DOCUMENT_PROMPT;
	return prompt.render(handoffDocumentPrompt, {
		additionalFocus: customInstructions,
		promptExtension,
	});
}

export async function generateHandoff(
	messages: AgentMessage[],
	model: Model,
	apiKey: string,
	options: HandoffOptions,
	signal?: AbortSignal,
): Promise<string> {
	const llmMessages = (options.convertToLlm ?? convertToLlm)(messages);
	const requestMessages: Message[] = [
		...llmMessages,
		{
			role: "user",
			content: [{ type: "text", text: renderHandoffPrompt(options.customInstructions, options.promptExtension) }],
			attribution: "agent",
			timestamp: Date.now(),
		},
	];

	const response = await instrumentedCompleteSimple(
		model,
		{
			systemPrompt: options.systemPrompt,
			messages: requestMessages,
			tools: options.tools,
		},
		{
			apiKey,
			signal,
			reasoning: Effort.High,
			toolChoice: "none",
			initiatorOverride: options.initiatorOverride,
			metadata: options.metadata,
			sessionId: options.sessionId,
			providerSessionState: options.providerSessionState,
			preferWebsockets: options.preferWebsockets,
		},
		{ telemetry: options.telemetry, oneshotKind: "handoff" },
	);

	if (response.stopReason === "error") {
		throw new Error(`Handoff generation failed: ${response.errorMessage || "Unknown error"}`);
	}

	return response.content
		.filter((c): c is { type: "text"; text: string } => c.type === "text")
		.map(c => c.text)
		.join("\n");
}

/** Derive a display summary locally to avoid a second compaction LLM request. */
function deriveShortSummary(summary: string): string {
	const firstParagraph = summary.trim().split(/\n\s*\n/, 1)[0] ?? "";
	const maxLength = 2_000;
	return firstParagraph.length <= maxLength ? firstParagraph : `${firstParagraph.slice(0, maxLength - 1)}…`;
}

// ============================================================================
// Compaction Preparation (for hooks)
// ============================================================================

export interface CompactionPreparation {
	/** UUID of first entry to keep */
	firstKeptEntryId: string;
	/** Messages that will be summarized and discarded */
	messagesToSummarize: AgentMessage[];
	/** Messages that will be turned into turn prefix summary (if splitting) */
	turnPrefixMessages: AgentMessage[];
	/** Messages kept in full after compaction (recent history) */
	recentMessages: AgentMessage[];
	/** Whether this is a split turn (cut point in middle of turn) */
	isSplitTurn: boolean;
	tokensBefore: number;
	/** Summary from previous compaction, for iterative update */
	previousSummary?: string;
	/** Preserved opaque compaction payload from the previous compaction, if any. */
	previousPreserveData?: Record<string, unknown>;
	/** File operations extracted from messagesToSummarize */
	fileOps: FileOperations;
	/** Compaction settions from settings.jsonl	*/
	settings: CompactionSettings;
	/**
	 * Diagnostics for the keep-window token correction (Finding 7). `ratio` is the
	 * clamped heuristic→actual correction that was applied (1 when none supplied);
	 * `keepRecentTokensCorrected` is the heuristic budget findCutPoint actually used.
	 */
	tokenCorrection: { ratio: number; keepRecentTokensCorrected: number };
}

/** Bounds for the keep-window token correction (Finding 7): never trust a ratio
 * beyond 2x in either direction so a bad estimate cannot balloon or collapse the
 * kept window. */
export const TOKEN_CORRECTION_MIN_RATIO = 0.5;
export const TOKEN_CORRECTION_MAX_RATIO = 2;

export interface PrepareCompactionOptions {
	/**
	 * Observed heuristic→actual token correction for the post-boundary keep window
	 * (actualTokens / chars-4-heuristicTokens), supplied by the caller from per-turn
	 * Usage deltas or a stable-prefix-subtracted comparison. Clamped to
	 * [0.5, 2] and applied bidirectionally. When omitted, no correction is applied
	 * (the confounded raw promptTokens/estimatedTokens quotient is never used).
	 */
	tokenCorrectionRatio?: number;
	/**
	 * Model context-window size. Windows below 66k retain the legacy fixed
	 * keepRecentTokens behavior; larger windows scale the keep window to 30%.
	 */
	contextWindow?: number;
}

export function prepareCompaction(
	pathEntries: SessionEntry[],
	settings: CompactionSettings,
	options: PrepareCompactionOptions = {},
): CompactionPreparation | undefined {
	if (pathEntries.length > 0 && pathEntries[pathEntries.length - 1].type === "compaction") {
		return undefined;
	}

	let prevCompactionIndex = -1;
	for (let i = pathEntries.length - 1; i >= 0; i--) {
		if (pathEntries[i].type === "compaction") {
			prevCompactionIndex = i;
			break;
		}
	}
	const boundaryStart = prevCompactionIndex + 1;
	const boundaryEnd = pathEntries.length;

	const lastUsage = getLastAssistantUsage(pathEntries);
	const tokensBefore = lastUsage ? calculateContextTokens(lastUsage) : 0;

	// Correct the keep-window budget for the chars/4 heuristic error using the
	// caller-supplied observed ratio (actual/heuristic). The legacy raw
	// promptTokens/estimatedTokens quotient is intentionally NOT used: promptTokens
	// counts system+tools+full history while estimatedTokens counted only the
	// post-boundary slice, so it was confounded and only ever shrank the window.
	// Here the correction is bidirectional and clamped to [0.5, 2].
	const configuredKeepRecentTokens = settings.keepRecentTokens;
	const contextWindow = options.contextWindow;
	const thresholdSafeKeepRecentTokens =
		contextWindow !== undefined && Number.isFinite(contextWindow) && contextWindow > 1
			? Math.max(
					1,
					resolveThresholdTokens(contextWindow, settings) - effectiveReserveTokens(contextWindow, settings, 0),
				)
			: configuredKeepRecentTokens;
	const keepRecentTokens = Math.min(configuredKeepRecentTokens, thresholdSafeKeepRecentTokens);
	// Preserve the legacy fixed window for smaller models. At 66k and above,
	// retain up to 30% of the model context, but never enough to leave the
	// post-compaction prompt immediately above its configured threshold.
	const scaledKeepRecentTokens =
		contextWindow !== undefined && Number.isFinite(contextWindow) && contextWindow >= 66_000
			? Math.min(thresholdSafeKeepRecentTokens, Math.max(keepRecentTokens, Math.floor(contextWindow * 0.3)))
			: keepRecentTokens;
	const rawRatio = options.tokenCorrectionRatio;
	const appliedRatio =
		rawRatio !== undefined && Number.isFinite(rawRatio) && rawRatio > 0
			? Math.min(TOKEN_CORRECTION_MAX_RATIO, Math.max(TOKEN_CORRECTION_MIN_RATIO, rawRatio))
			: 1;
	// Preserve an explicit keep floor that already covers the whole history: manual
	// and emergency callers rely on prepareCompaction returning undefined rather
	// than manufacturing a summary with no useful reduction. Otherwise, a scaled
	// window that exceeds a short history falls back to the threshold-safe floor.
	const historyTokens = pathEntries
		.slice(boundaryStart, boundaryEnd)
		.reduce((tokens, entry) => tokens + estimateEntryTokens(entry), 0);
	const effectiveKeepRecentTokens =
		configuredKeepRecentTokens > historyTokens
			? configuredKeepRecentTokens
			: scaledKeepRecentTokens > keepRecentTokens && scaledKeepRecentTokens > historyTokens
				? keepRecentTokens
				: scaledKeepRecentTokens;
	const keepRecentTokensCorrected = Math.max(1, Math.round(effectiveKeepRecentTokens / appliedRatio));

	const cutPoint = findCutPoint(pathEntries, boundaryStart, boundaryEnd, keepRecentTokensCorrected);

	// Get ID of first kept entry
	const firstKeptEntry = pathEntries[cutPoint.firstKeptEntryIndex];
	if (!firstKeptEntry?.id) {
		return undefined; // Session needs migration
	}
	const firstKeptEntryId = firstKeptEntry.id;

	const historyEnd = cutPoint.isSplitTurn ? cutPoint.turnStartIndex : cutPoint.firstKeptEntryIndex;

	// Messages to summarize (will be discarded after summary)
	const messagesToSummarize: AgentMessage[] = [];
	for (let i = boundaryStart; i < historyEnd; i++) {
		const msg = getMessageFromEntry(pathEntries[i]);
		if (msg) messagesToSummarize.push(msg);
	}

	// Messages for turn prefix summary (if splitting a turn)
	const turnPrefixMessages: AgentMessage[] = [];
	if (cutPoint.isSplitTurn) {
		for (let i = cutPoint.turnStartIndex; i < cutPoint.firstKeptEntryIndex; i++) {
			const msg = getMessageFromEntry(pathEntries[i]);
			if (msg) turnPrefixMessages.push(msg);
		}
	}

	// Messages kept after compaction (recent history)
	const recentMessages: AgentMessage[] = [];
	for (let i = cutPoint.firstKeptEntryIndex; i < boundaryEnd; i++) {
		const msg = getMessageFromEntry(pathEntries[i]);
		if (msg) recentMessages.push(msg);
	}
	// Nothing to summarize means compaction would be a no-op.
	if (messagesToSummarize.length === 0 && turnPrefixMessages.length === 0) {
		return undefined;
	}

	// Get previous summary and preserved data for iterative updates
	let previousSummary: string | undefined;
	let previousPreserveData: Record<string, unknown> | undefined;
	if (prevCompactionIndex >= 0) {
		const prevCompaction = pathEntries[prevCompactionIndex] as CompactionEntry;
		previousSummary = prevCompaction.summary;
		previousPreserveData = prevCompaction.preserveData;
	}

	// Extract file operations from messages and previous compaction
	const fileOps = extractFileOperations(messagesToSummarize, pathEntries, prevCompactionIndex);

	// Also extract file ops from turn prefix if splitting
	if (cutPoint.isSplitTurn) {
		for (const msg of turnPrefixMessages) {
			extractFileOpsFromMessage(msg, fileOps);
		}
	}

	return {
		firstKeptEntryId,
		messagesToSummarize,
		turnPrefixMessages,
		recentMessages,
		isSplitTurn: cutPoint.isSplitTurn,
		tokensBefore,
		previousSummary,
		previousPreserveData,
		fileOps,
		settings,
		tokenCorrection: { ratio: appliedRatio, keepRecentTokensCorrected },
	};
}

// ============================================================================
// Main compaction function
// ============================================================================

const TURN_PREFIX_SUMMARIZATION_PROMPT = prompt.render(compactionTurnPrefixPrompt);

/**
 * Generate summaries for compaction using prepared data.
 * Returns CompactionResult - SessionManager adds id/parentId when saving.
 *
 * @param preparation - Pre-calculated preparation from prepareCompaction()
 * @param customInstructions - Optional custom focus for the summary
 */
export async function compact(
	preparation: CompactionPreparation,
	model: Model,
	apiKey: string,
	customInstructions?: string,
	signal?: AbortSignal,
	options?: SummaryOptions,
): Promise<CompactionResult> {
	const {
		firstKeptEntryId,
		messagesToSummarize,
		turnPrefixMessages,
		recentMessages,
		isSplitTurn,
		tokensBefore,
		previousSummary,
		previousPreserveData,
		fileOps,
		settings,
	} = preparation;

	const summaryOptions: SummaryOptions = {
		promptOverride: options?.promptOverride,
		extraContext: options?.extraContext,
		remoteEndpoint: settings.remoteEnabled === false ? undefined : settings.remoteEndpoint,
		remoteInstructions: options?.remoteInstructions,
		initiatorOverride: options?.initiatorOverride,
		metadata: options?.metadata,
		convertToLlm: options?.convertToLlm,
		telemetry: options?.telemetry,
		sessionId: options?.sessionId,
		providerSessionState: options?.providerSessionState,
		preferWebsockets: options?.preferWebsockets,
		remoteCompactionFallbackHealth: options?.remoteCompactionFallbackHealth,
	};

	let preserveData = withOpenAiRemoteCompactionPreserveData(previousPreserveData, undefined);
	if (settings.remoteEnabled !== false && shouldUseOpenAiRemoteCompaction(model)) {
		const previousRemoteCompaction = getPreservedOpenAiRemoteCompactionData(previousPreserveData);
		const remoteMessages = [...messagesToSummarize, ...turnPrefixMessages, ...recentMessages];
		const previousReplacementHistory =
			previousRemoteCompaction?.provider === model.provider
				? previousRemoteCompaction.replacementHistory
				: undefined;
		const remoteHistory = buildOpenAiNativeHistory(
			(summaryOptions.convertToLlm ?? convertToLlm)(remoteMessages),
			model,
			previousReplacementHistory,
		);
		if (remoteHistory.length > 0) {
			try {
				const remote = await requestOpenAiRemoteCompaction(
					model,
					apiKey,
					remoteHistory,
					summaryOptions.remoteInstructions ?? SUMMARIZATION_SYSTEM_PROMPT,
					signal,
					{ authCredentialType: options?.authCredentialType },
				);
				preserveData = withOpenAiRemoteCompactionPreserveData(previousPreserveData, remote);
				summaryOptions.remoteCompactionFallbackHealth?.recordRemoteCompactionFallback({
					kind: "success",
					model: model.id,
					provider: model.provider,
				});
			} catch (err) {
				if (signal?.aborted || isAbortError(err)) throw err;
				const error = err instanceof Error ? err.message : String(err);
				if (summaryOptions.remoteCompactionFallbackHealth) {
					summaryOptions.remoteCompactionFallbackHealth.recordRemoteCompactionFallback({
						kind: "fallback",
						error,
						model: model.id,
						provider: model.provider,
					});
				} else {
					logger.warn("OpenAI remote compaction failed, falling back to local summarization", {
						error,
						model: model.id,
						provider: model.provider,
					});
				}
			}
		}
	}

	// Generate summaries (can be parallel if both needed) and merge into one
	let summary: string;

	// A single active Codex WebSocket session cannot service two concurrent
	// requests ("websocket request already in progress"). When the maintenance
	// calls use the Codex Responses provider, share one provider session, and
	// websocket transport is not explicitly disabled, run the split-turn history
	// and turn-prefix summaries sequentially. This covers websocket activation
	// from config/env/model defaults too: the provider can select websockets even
	// when `preferWebsockets` is undefined, while non-Codex providers keep the
	// previous parallel behavior.
	const summariesMayShareWebSocketSession = Boolean(
		model.api === "openai-codex-responses" &&
			summaryOptions.providerSessionState &&
			summaryOptions.preferWebsockets !== false,
	);

	if (isSplitTurn && turnPrefixMessages.length > 0) {
		const runHistorySummary = () =>
			messagesToSummarize.length > 0
				? generateSummary(
						messagesToSummarize,
						model,
						settings.reserveTokens,
						apiKey,
						signal,
						customInstructions,
						previousSummary,
						summaryOptions,
					)
				: Promise.resolve("No prior history.");
		const runTurnPrefixSummary = () =>
			generateTurnPrefixSummary(turnPrefixMessages, model, settings.reserveTokens, apiKey, signal, summaryOptions);

		let historyResult: string;
		let turnPrefixResult: string;
		if (summariesMayShareWebSocketSession) {
			// Sequential: avoids concurrent requests on the same provider session.
			historyResult = await runHistorySummary();
			turnPrefixResult = await runTurnPrefixSummary();
		} else {
			[historyResult, turnPrefixResult] = await Promise.all([runHistorySummary(), runTurnPrefixSummary()]);
		}
		// Merge into single summary
		summary = `${historyResult}\n\n---\n\n**Turn Context (split turn):**\n\n${turnPrefixResult}`;
	} else if (messagesToSummarize.length > 0) {
		// Generate history summary from messages to summarize
		summary = await generateSummary(
			messagesToSummarize,
			model,
			settings.reserveTokens,
			apiKey,
			signal,
			customInstructions,
			previousSummary,
			summaryOptions,
		);
	} else if (previousSummary) {
		// No new messages to summarize, preserve previous summary
		summary = previousSummary;
	} else {
		// No messages and no previous summary
		summary = "No prior history.";
	}

	// Compute file lists and append to summary
	const { readFiles, modifiedFiles } = computeFileLists(fileOps);
	summary = upsertFileOperations(summary, readFiles, modifiedFiles);
	const shortSummary = deriveShortSummary(summary);

	if (!firstKeptEntryId) {
		throw new Error("First kept entry has no ID - session may need migration");
	}

	return {
		summary,
		shortSummary,
		firstKeptEntryId,
		tokensBefore,
		details: { readFiles, modifiedFiles } as CompactionDetails,
		preserveData,
	};
}

/**
 * Generate a summary for a turn prefix (when splitting a turn).
 */
async function generateTurnPrefixSummary(
	messages: AgentMessage[],
	model: Model,
	reserveTokens: number,
	apiKey: string,
	signal?: AbortSignal,
	options?: SummaryOptions,
): Promise<string> {
	const maxTokens = Math.floor(0.5 * reserveTokens); // Smaller budget for turn prefix

	const llmMessages = (options?.convertToLlm ?? convertToLlm)(messages);
	const conversationText = boundConversationTextForSummary(serializeConversation(llmMessages), model, maxTokens);
	const promptText = `<conversation>\n${conversationText}\n</conversation>\n\n${TURN_PREFIX_SUMMARIZATION_PROMPT}`;
	const summarizationMessages = [
		{
			role: "user" as const,
			content: [{ type: "text" as const, text: promptText }],
			timestamp: Date.now(),
		},
	];

	const response = await instrumentedCompleteSimple(
		model,
		{ systemPrompt: [SUMMARIZATION_SYSTEM_PROMPT], messages: summarizationMessages },
		{
			maxTokens,
			signal,
			apiKey,
			reasoning: Effort.High,
			initiatorOverride: options?.initiatorOverride,
			metadata: options?.metadata,
			sessionId: options?.sessionId,
			providerSessionState: options?.providerSessionState,
			preferWebsockets: options?.preferWebsockets,
		},
		{ telemetry: options?.telemetry, oneshotKind: "compaction_turn_prefix" },
	);

	if (response.stopReason === "error") {
		throw new Error(`Turn prefix summarization failed: ${response.errorMessage || "Unknown error"}`);
	}

	return response.content
		.filter((c): c is { type: "text"; text: string } => c.type === "text")
		.map(c => c.text)
		.join("\n");
}
