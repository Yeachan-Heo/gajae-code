/**
 * Process-wide registry mapping a session id to its active pending interactive asks.
 *
 * Exposes session-owned pending interactive ask interactions to SDK clients through
 * a stable public interface for discovery and answering via ask.answer.
 *
 * Complements ask-answer-registry.ts by tracking the pending ask state (question,
 * options, etc) rather than just the answer source.
 */

import { randomUUID } from "node:crypto";
import type { AskRemoteReceipt, AskSettlement } from "./index";

export interface InteractivePendingAsk {
	/** Stable ID for this ask, unique per session per ask lifetime. */
	id: string;
	/** The question text displayed to the user. */
	question: string;
	/** Available response options. */
	options: readonly string[];
	/** Whether multiple options can be selected. */
	multi: boolean;
	/** Optional recommended option index. */
	recommendedIndex?: number;
	/** Optional timeout in milliseconds. */
	timeoutMs?: number;
	/** Current interaction mode (selector or editor). */
	interaction: "selector" | "editor";
	/** Currently selected options. */
	selectedOptions: readonly string[];
	/** Whether there is non-empty custom input. */
	hasNonWhitespaceCustom: boolean;
	/** Optional title for editor interaction. */
	editorTitle?: string;
	/** Optional prefill for editor interaction. */
	editorPrefill?: string;
}

interface PendingAskEntry {
	readonly ask: InteractivePendingAsk;
	readonly receipt: AskRemoteReceipt;
	/** Function to abort/cancel the ask. */
	readonly abort: () => void;
}

const pendingAsks = new Map<string, Map<string, PendingAskEntry>>();

/**
 * Register a pending interactive ask for a session.
 * Returns a disposer that clears the ask from the registry.
 */
export function registerInteractivePendingAsk(
	sessionId: string,
	question: string,
	options: readonly string[],
	multi: boolean,
	receipt: AskRemoteReceipt,
	abort: () => void,
	details?: {
		recommendedIndex?: number;
		timeoutMs?: number;
		interaction?: "selector" | "editor";
		selectedOptions?: readonly string[];
		hasNonWhitespaceCustom?: boolean;
		editorTitle?: string;
		editorPrefill?: string;
	},
): string {
	const askId = randomUUID();
	const sessionAsks = pendingAsks.get(sessionId) ?? new Map();
	const ask: InteractivePendingAsk = {
		id: askId,
		question,
		options,
		multi,
		recommendedIndex: details?.recommendedIndex,
		timeoutMs: details?.timeoutMs,
		interaction: details?.interaction ?? "selector",
		selectedOptions: details?.selectedOptions ?? [],
		hasNonWhitespaceCustom: details?.hasNonWhitespaceCustom ?? false,
		editorTitle: details?.editorTitle,
		editorPrefill: details?.editorPrefill,
	};
	sessionAsks.set(askId, { ask, receipt, abort });
	pendingAsks.set(sessionId, sessionAsks);
	return askId;
}

/**
 * Update the state of a pending interactive ask.
 * Returns true if the ask exists and was updated.
 */
export function updateInteractivePendingAsk(
	sessionId: string,
	askId: string,
	updates: Partial<Omit<InteractivePendingAsk, "id">>,
): boolean {
	const sessionAsks = pendingAsks.get(sessionId);
	if (!sessionAsks) return false;
	const entry = sessionAsks.get(askId);
	if (!entry) return false;
	// Create a new ask object with updates (since ask is readonly)
	const updatedAsk: InteractivePendingAsk = { ...entry.ask, ...updates };
	// Replace the entry with a new one containing the updated ask
	sessionAsks.set(askId, { ...entry, ask: updatedAsk });
	return true;
}

/**
 * Get a pending ask by ID.
 */
export function getInteractivePendingAsk(sessionId: string, askId: string): InteractivePendingAsk | undefined {
	const sessionAsks = pendingAsks.get(sessionId);
	if (!sessionAsks) return undefined;
	return sessionAsks.get(askId)?.ask;
}

/**
 * Get all pending asks for a session.
 */
export function listInteractivePendingAsks(sessionId: string): readonly InteractivePendingAsk[] {
	const sessionAsks = pendingAsks.get(sessionId);
	if (!sessionAsks) return [];
	return Array.from(sessionAsks.values()).map(entry => entry.ask);
}

/**
 * Resolve a pending ask with a settlement, then remove it from the registry.
 * Returns true if the ask was found and settled.
 */
export async function settleInteractivePendingAsk(
	sessionId: string,
	askId: string,
	settlement: AskSettlement,
): Promise<boolean> {
	const sessionAsks = pendingAsks.get(sessionId);
	if (!sessionAsks) return false;
	const entry = sessionAsks.get(askId);
	if (!entry) return false;
	try {
		// The receipt's settle method will handle the settlement and return a result
		await entry.receipt.settle(settlement);
	} catch (error) {
		// Log but don't fail on settle errors
		if (error instanceof Error) {
			console.warn(`Failed to settle pending ask ${askId}:`, error.message);
		}
	}
	sessionAsks.delete(askId);
	if (sessionAsks.size === 0) {
		pendingAsks.delete(sessionId);
	}
	return true;
}

/**
 * Get the receipt for a pending ask (for testing/debugging).
 */
export function getInteractivePendingAskReceipt(sessionId: string, askId: string): AskRemoteReceipt | undefined {
	const sessionAsks = pendingAsks.get(sessionId);
	if (!sessionAsks) return undefined;
	return sessionAsks.get(askId)?.receipt;
}

/**
 * Clear all pending asks for a session (e.g. on session termination).
 */
export function clearSessionInteractivePendingAsks(sessionId: string): void {
	pendingAsks.delete(sessionId);
}
