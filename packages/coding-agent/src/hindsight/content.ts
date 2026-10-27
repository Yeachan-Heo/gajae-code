/**
 * Pure content utilities for the Hindsight backend.
 *
 * Ports the semantics of the upstream OpenCode plugin
 * (vectorize-io/hindsight @ hindsight-integrations/opencode/src/content.ts):
 *   - tag stripping for anti-feedback (a recalled <memories> block must
 *     never end up retained as a new memory)
 *   - recall query composition + truncation under a character budget
 *   - retention transcript framing
 */

export interface HindsightMessage {
	role: string;
	content: string;
}

export interface RecallResultLike {
	text: string;
	type?: string | null;
	mentioned_at?: string | null;
}

const MEMORY_TAG_NAMES = ["memories", "hindsight_memories", "relevant_memories", "mental_models"] as const;

function memoryTagExpression(name: string): RegExp {
	return new RegExp(`<\\s*\\/?\\s*${name}\\s*>`, "gi");
}

interface MemoryTagSpan {
	start: number;
	end: number;
	close: boolean;
	paired: boolean;
	absorbed: boolean;
}

function findMemoryTagSpans(content: string, name: string): MemoryTagSpan[] {
	const spans: MemoryTagSpan[] = [];
	for (const match of content.matchAll(memoryTagExpression(name))) {
		const raw = match[0];
		const start = match.index ?? 0;
		spans.push({
			start,
			end: start + raw.length,
			close: raw.includes("/"),
			paired: false,
			absorbed: false,
		});
	}
	return spans;
}

function mergeSpans(ranges: Array<[number, number]>): Array<[number, number]> {
	const sorted = ranges.filter(([start, end]) => end > start).sort((a, b) => a[0] - b[0] || b[1] - a[1]);
	const merged: Array<[number, number]> = [];
	for (const [start, end] of sorted) {
		const last = merged[merged.length - 1];
		if (!last || start > last[1]) merged.push([start, end]);
		else last[1] = Math.max(last[1], end);
	}
	return merged;
}

/**
 * Remove one memory-tag family.
 *
 * A matched block is removed whole. An extra closer after that block is the
 * recall frame ending early: the escaped text through that closer is removed
 * so it is not retained as instructions. A closer or opener with no block
 * before it is removed as a token only, and the surrounding prose stays.
 */
function stripMemoryTagFamily(content: string, name: string): string {
	const tags = findMemoryTagSpans(content, name);
	if (tags.length === 0) return content;

	const ranges: Array<[number, number]> = [];
	const stack: MemoryTagSpan[] = [];
	for (const tag of tags) {
		if (!tag.close) {
			stack.push(tag);
			continue;
		}
		const open = stack.pop();
		if (!open) continue;
		open.paired = true;
		tag.paired = true;
		ranges.push([open.start, tag.end]);
	}

	for (const tag of tags) {
		if (!tag.close || tag.paired) continue;
		let previous: MemoryTagSpan | undefined;
		for (const candidate of tags) {
			if (candidate.end <= tag.start) previous = candidate;
			else break;
		}
		const followsClosedBlock = Boolean(previous?.close && (previous.paired || previous.absorbed));
		if (followsClosedBlock && previous) {
			ranges.push([previous.end, tag.end]);
			tag.absorbed = true;
		} else {
			ranges.push([tag.start, tag.end]);
		}
	}

	for (const tag of tags) {
		if (!tag.close && !tag.paired) ranges.push([tag.start, tag.end]);
	}

	let out = content;
	for (const [start, end] of mergeSpans(ranges).reverse()) {
		out = out.slice(0, start) + out.slice(end);
	}
	return out;
}

/** Escape recognized tag delimiters so recalled text cannot close the outer frame. */
function stripMemoryTagTokens(text: string): string {
	let out = text;
	for (const name of MEMORY_TAG_NAMES) {
		out = out.replace(memoryTagExpression(name), tag => tag.replace("<", "&lt;"));
	}
	return out;
}

/**
 * Strip `<memories>`, `<mental_models>`, and legacy memory blocks.
 *
 * Matching is case-insensitive and allows whitespace inside the tag.
 * Both per-turn recall and curated mental models are injected around the
 * prompt. If a closer, a case variant, or an early-ended frame leaks into
 * the retention transcript, the next retain stores the breakout as a new
 * memory. Always strip before retaining.
 */
export function stripMemoryTags(content: string): string {
	let out = content;
	while (true) {
		let stripped = out;
		for (const name of MEMORY_TAG_NAMES) stripped = stripMemoryTagFamily(stripped, name);
		if (stripped === out) return out;
		out = stripped;
	}
}

/** Format recall results into a bullet list for context injection. */
export function formatMemories(results: RecallResultLike[]): string {
	if (results.length === 0) return "";
	return results
		.map(r => {
			const typeStr = r.type ? ` [${r.type}]` : "";
			const dateStr = r.mentioned_at ? ` (${r.mentioned_at})` : "";
			const text = stripMemoryTagTokens(r.text);
			return `- ${text}${typeStr}${dateStr}`;
		})
		.join("\n\n");
}

/** Format current UTC time for the recall preamble. */
export function formatCurrentTime(now: Date = new Date()): string {
	const y = now.getUTCFullYear();
	const m = String(now.getUTCMonth() + 1).padStart(2, "0");
	const d = String(now.getUTCDate()).padStart(2, "0");
	const h = String(now.getUTCHours()).padStart(2, "0");
	const min = String(now.getUTCMinutes()).padStart(2, "0");
	return `${y}-${m}-${d} ${h}:${min}`;
}

/**
 * Slice messages to the last N turns, where a turn boundary is a user message.
 * Returns the trailing tail starting at the (N-th from the end) user message.
 */
export function sliceLastTurnsByUserBoundary(messages: HindsightMessage[], turns: number): HindsightMessage[] {
	if (messages.length === 0 || turns <= 0) return [];

	let userTurnsSeen = 0;
	let startIndex = -1;

	for (let i = messages.length - 1; i >= 0; i--) {
		if (messages[i].role === "user") {
			userTurnsSeen += 1;
			if (userTurnsSeen >= turns) {
				startIndex = i;
				break;
			}
		}
	}

	return startIndex === -1 ? [...messages] : messages.slice(startIndex);
}

/**
 * Compose a recall query from the latest user prompt plus optional prior context.
 *
 * When `recallContextTurns <= 1` the query is just the trimmed latest prompt.
 * Otherwise we prepend a `Prior context:` block built from the trailing
 * `recallContextTurns` user-bounded turns (memory tags stripped, latest prompt
 * suppressed to avoid duplicating it inside the context block).
 */
export function composeRecallQuery(
	latestQuery: string,
	messages: HindsightMessage[],
	recallContextTurns: number,
): string {
	const latest = latestQuery.trim();
	if (recallContextTurns <= 1 || messages.length === 0) return latest;

	const contextual = sliceLastTurnsByUserBoundary(messages, recallContextTurns);
	const contextLines: string[] = [];

	for (const msg of contextual) {
		const content = stripMemoryTags(msg.content).trim();
		if (!content) continue;
		if (msg.role === "user" && content === latest) continue;
		contextLines.push(`${msg.role}: ${content}`);
	}

	if (contextLines.length === 0) return latest;
	return ["Prior context:", contextLines.join("\n"), latest].join("\n\n");
}

/**
 * Truncate a composed recall query to `maxChars`.
 *
 * Always preserves the latest user message. Drops oldest context lines first
 * and degrades gracefully when even the latest message exceeds the budget.
 */
export function truncateRecallQuery(query: string, latestQuery: string, maxChars: number): string {
	if (maxChars <= 0 || query.length <= maxChars) return query;

	const latest = latestQuery.trim();
	const latestOnly = latest.length > maxChars ? latest.slice(0, maxChars) : latest;

	if (!query.includes("Prior context:")) return latestOnly;

	const contextMarker = "Prior context:\n\n";
	const markerIndex = query.indexOf(contextMarker);
	if (markerIndex === -1) return latestOnly;

	const suffix = `\n\n${latest}`;
	const suffixIndex = query.lastIndexOf(suffix);
	if (suffixIndex === -1) return latestOnly;
	if (suffix.length >= maxChars) return latestOnly;

	const contextBody = query.slice(markerIndex + contextMarker.length, suffixIndex);
	const contextLines = contextBody.split("\n").filter(Boolean);

	const kept: string[] = [];
	for (let i = contextLines.length - 1; i >= 0; i--) {
		kept.unshift(contextLines[i]);
		const candidate = `${contextMarker}${kept.join("\n")}${suffix}`;
		if (candidate.length > maxChars) {
			kept.shift();
			break;
		}
	}

	if (kept.length > 0) return `${contextMarker}${kept.join("\n")}${suffix}`;
	return latestOnly;
}

export interface RetentionTranscript {
	transcript: string | null;
	messageCount: number;
}

/**
 * Format messages into a retention transcript using `[role: ...]` markers.
 *
 * - When `retainFullWindow` is true, all messages are included (used when the
 *   caller pre-sliced the window itself).
 * - Otherwise, only the last user turn (last user message → end) is retained.
 *
 * Messages are tag-stripped before framing to break the recall→retain loop.
 * Returns `{ transcript: null }` when nothing meaningful survives.
 */
export function prepareRetentionTranscript(
	messages: HindsightMessage[],
	retainFullWindow = false,
): RetentionTranscript {
	if (messages.length === 0) return { transcript: null, messageCount: 0 };

	let targetMessages: HindsightMessage[];
	if (retainFullWindow) {
		targetMessages = messages;
	} else {
		let lastUserIdx = -1;
		for (let i = messages.length - 1; i >= 0; i--) {
			if (messages[i].role === "user") {
				lastUserIdx = i;
				break;
			}
		}
		if (lastUserIdx === -1) return { transcript: null, messageCount: 0 };
		targetMessages = messages.slice(lastUserIdx);
	}

	const parts: string[] = [];
	for (const msg of targetMessages) {
		const content = stripMemoryTags(msg.content).trim();
		if (!content) continue;
		parts.push(`[role: ${msg.role}]\n${content}\n[${msg.role}:end]`);
	}

	if (parts.length === 0) return { transcript: null, messageCount: 0 };

	const transcript = parts.join("\n\n");
	if (transcript.trim().length < 10) return { transcript: null, messageCount: 0 };

	return { transcript, messageCount: parts.length };
}
