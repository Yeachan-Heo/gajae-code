import type { ToolCall, ToolResultMessage } from "@gajae-code/ai/types";
import { estimateEntryTokens } from "../src/compaction/compaction";
import type { SessionEntry, SessionMessageEntry } from "../src/compaction/entries";
import {
	commitToolOutputPrune,
	createPrunedNotice,
	extractToolOutputText,
	type PruneConfig,
	planToolOutputPrune,
	type ToolOutputPrunePlan,
} from "../src/compaction/pruning";

export interface TestPrunedOriginal {
	entryId: string;
	toolName?: string;
	originalText: string;
	tokens: number;
	complete?: boolean;
}

export interface TestPruneOptions {
	relaxedMinimum?: number;
	artifactRefMaxChars?: number;
	artifactRef?: (candidate: TestPrunedOriginal) => string | undefined;
}

export interface TestPruneResult {
	prunedCount: number;
	tokensSaved: number;
	originals: TestPrunedOriginal[];
	prunedEntries: SessionMessageEntry[];
}

function toolCallsById(entries: readonly SessionEntry[]): Map<string, ToolCall> {
	const calls = new Map<string, ToolCall>();
	for (const entry of entries) {
		if (entry.type !== "message" || entry.message.role !== "assistant") continue;
		for (const content of entry.message.content) {
			if (content.type === "toolCall") calls.set(content.id, content);
		}
	}
	return calls;
}

function messageEntries(entries: readonly SessionEntry[]): SessionMessageEntry[] {
	return entries.filter((entry): entry is SessionMessageEntry => entry.type === "message");
}

function cloneEntries(entries: readonly SessionEntry[]): SessionEntry[] {
	return structuredClone([...entries]) as SessionEntry[];
}

function replacementPlan(
	entries: readonly SessionEntry[],
	plan: ToolOutputPrunePlan,
	opts: TestPruneOptions,
): {
	overrides: Map<string, { replacementText: string }>;
	originals: TestPrunedOriginal[];
} {
	const calls = toolCallsById(entries);
	const originals: TestPrunedOriginal[] = [];
	const overrides = new Map<string, { replacementText: string }>();
	for (const digest of plan.digests) {
		const entry = entries.find(candidate => candidate.id === digest.entryId);
		if (entry?.type !== "message" || entry.message.role !== "toolResult") continue;
		const message = entry.message as ToolResultMessage;
		const captured = extractToolOutputText(message);
		const proposal = plan.replacements.find(candidate => candidate.entryId === digest.entryId);
		if (!proposal) continue;
		const original: TestPrunedOriginal = {
			entryId: digest.entryId,
			toolName: message.toolName,
			originalText: captured.text,
			tokens: proposal.tokens,
			complete: proposal.complete,
		};
		originals.push(original);
		if (!opts.artifactRef) continue;
		const artifact = proposal.complete ? opts.artifactRef(original) : undefined;
		if (artifact !== undefined && !/^artifact:\/\/\d+$/.test(artifact))
			throw new Error("artifactRef must be a numeric artifact://<id> reference");
		if (
			artifact !== undefined &&
			opts.artifactRefMaxChars !== undefined &&
			artifact.length > opts.artifactRefMaxChars
		)
			throw new Error("artifactRef exceeded artifactRefMaxChars");
		const call = calls.get(message.toolCallId);
		overrides.set(digest.entryId, {
			replacementText: createPrunedNotice(proposal.tokens, message, call, artifact),
		});
	}
	return { overrides, originals };
}

export function applyToolOutputPrune(
	entries: SessionEntry[],
	config: PruneConfig,
	opts: TestPruneOptions = {},
): TestPruneResult {
	const effectiveConfig =
		opts.relaxedMinimum === undefined
			? config
			: { ...config, minimumSavings: Math.min(config.minimumSavings, Math.max(0, opts.relaxedMinimum)) };
	const working = cloneEntries(entries);
	const plan = planToolOutputPrune(working, effectiveConfig, {
		artifactRefMaxChars: opts.artifactRefMaxChars,
	});
	if (plan.digests.length === 0) return { prunedCount: 0, tokensSaved: 0, originals: [], prunedEntries: [] };
	const { overrides, originals } = replacementPlan(working, plan, opts);
	const beforeTokens = new Map(messageEntries(working).map(entry => [entry.id, estimateEntryTokens(entry)] as const));
	const outcomes = commitToolOutputPrune(working, plan, { replacements: overrides });
	const committedIds = new Set(
		outcomes.filter(outcome => outcome.outcome === "committed").map(outcome => outcome.entryId),
	);
	const prunedEntries = outcomes
		.filter(outcome => outcome.outcome === "committed")
		.map(outcome => messageEntries(working).find(entry => entry.id === outcome.entryId))
		.filter((entry): entry is SessionMessageEntry => entry !== undefined);
	const tokensSaved = prunedEntries.reduce((total, entry) => {
		const before = beforeTokens.get(entry.id) ?? 0;
		return total + Math.max(0, before - estimateEntryTokens(entry));
	}, 0);
	for (const source of messageEntries(entries)) {
		const updated = prunedEntries.find(entry => entry.id === source.id);
		if (!updated) continue;
		source.message = structuredClone(updated.message);
	}
	return {
		prunedCount: prunedEntries.length,
		tokensSaved,
		originals: originals.filter(original => committedIds.has(original.entryId)),
		prunedEntries,
	};
}
