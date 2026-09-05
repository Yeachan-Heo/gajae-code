import * as crypto from "node:crypto";
import * as fs from "node:fs";
import type { ToolCall, ToolResultMessage } from "@gajae-code/ai/core";
import { matchesKey } from "@gajae-code/tui";
import { formatDuration, formatNumber } from "@gajae-code/utils";
import type { KeyId } from "../../config/keybindings";
import { isSilentAbort } from "../../session/messages";
import type { FileEntry, SessionMessageEntry } from "../../session/session-manager";
import { parseSessionEntries } from "../../session/session-manager";
import type { ObservableSession, SessionObserverRegistry } from "../session-observer-registry";
import { theme } from "../theme/theme";
import {
	buildToolTranscriptEntry,
	composeToolText,
	createToolTranscriptRenderDescriptor,
} from "./tool-transcript-format";
import { type TranscriptViewerEntry, TranscriptViewerOverlay } from "./transcript-viewer-overlay";

const FATAL_UTF8_DECODER = new TextDecoder("utf-8", { fatal: true });

type FileIdentity = { dev: bigint; ino: bigint };
type StableSnapshot = {
	identity: FileIdentity;
	size: number;
	prefix: Buffer;
	tail: Buffer;
	offsetReset: boolean;
};
type SnapshotReadResult =
	| { status: "stable"; snapshot: StableSnapshot }
	| { status: "unstable" }
	| { status: "unavailable" };

class UnstableSnapshotError extends Error {}
type ObserverCache = {
	path: string;
	identity: FileIdentity;
	completeOffset: number;
	prefixDigest: string;
	entries: SessionMessageEntry[];
	model?: string;
	projectedCount: number;
	projectedOutput: TranscriptViewerEntry[];
	toolCallOutputIndex: Map<string, number>;
	projectionSafe: boolean;
};

type ProjectionState = Pick<
	ObserverCache,
	"projectedCount" | "projectedOutput" | "toolCallOutputIndex" | "projectionSafe"
>;
type ProjectionUpdate = { state: ProjectionState; preserveLayoutCache: boolean };

export const __sessionObserverProjectionCounters = {
	enabled: false,
	projectionFullRuns: 0,
	projectionIncrementalRuns: 0,
	sourceMessagesProjected: 0,
	projectedEntriesAppended: 0,
	resultPatchCount: 0,
	snapshot() {
		return {
			projectionFullRuns: this.projectionFullRuns,
			projectionIncrementalRuns: this.projectionIncrementalRuns,
			sourceMessagesProjected: this.sourceMessagesProjected,
			projectedEntriesAppended: this.projectedEntriesAppended,
			resultPatchCount: this.resultPatchCount,
		};
	},
	enable(): void {
		this.enabled = true;
	},
	disable(): void {
		this.enabled = false;
	},
	reset(): void {
		this.projectionFullRuns = 0;
		this.projectionIncrementalRuns = 0;
		this.sourceMessagesProjected = 0;
		this.projectedEntriesAppended = 0;
		this.resultPatchCount = 0;
	},
};

function recordProjectionCounter(
	counter: keyof ReturnType<typeof __sessionObserverProjectionCounters.snapshot>,
	amount = 1,
): void {
	if (__sessionObserverProjectionCounters.enabled) __sessionObserverProjectionCounters[counter] += amount;
}

/** Session-observer adapter. The shared viewer owns navigation and fold state. */
export class SessionObserverOverlayComponent extends TranscriptViewerOverlay {
	#registry: SessionObserverRegistry;
	#onDone: () => void;
	#observeKeys: readonly KeyId[];
	#selectedSessionId?: string;
	#cache?: ObserverCache;

	constructor(registry: SessionObserverRegistry, onDone: () => void, observeKeys: KeyId[]) {
		// The option closures run during the base constructor's initial refresh,
		// where `this` is still in its temporal dead zone; route through a box
		// that is populated immediately after super() returns.
		const box: { component?: SessionObserverOverlayComponent } = {};
		super({
			title: "Session Observer",
			getEntries: () => (box.component ? box.component.#entries() : []),
			onClose: onDone,
			requestRender: () => {},
			enterExpands: true,
			initialSelection: "latest",
			followTail: true,
			maxExpandedLines: 100,
			getHeaderLines: () => (box.component ? box.component.#headerLines() : []),
			getFooterLines: () => (box.component ? box.component.#footerLines() : []),
			footerControls:
				"j/k:select  Enter:expand  PgUp/PgDn:page  [/]/←→:cycle agents  Esc/Ctrl+S:close  g/G:top/bottom",
		});
		box.component = this;
		this.#registry = registry;
		this.#onDone = onDone;
		this.#observeKeys = observeKeys;
		this.#selectedSessionId = this.#mostRecent()?.id;
		if (!this.#selectedSessionId) queueMicrotask(onDone);
		this.#refreshCurrentSource();
	}

	refreshFromRegistry(): void {
		this.#refreshCurrentSource();
	}
	#refreshCurrentSource(): void {
		const session = this.#registry.getSessions().find(candidate => candidate.id === this.#selectedSessionId);
		if (!session?.sessionFile) {
			this.#clearSource();
			this.refresh(undefined, false);
			return;
		}
		const preserveLayoutCache = this.#load(session.sessionFile);
		this.refresh(undefined, preserveLayoutCache);
	}
	override handleInput(keyData: string): void {
		if (this.#observeKeys.some(key => matchesKey(keyData, key))) {
			this.#onDone();
			return;
		}
		if (keyData === "]" || matchesKey(keyData, "right") || matchesKey(keyData, "tab")) {
			this.#cycle(1);
			return;
		}
		if (keyData === "[" || matchesKey(keyData, "left") || matchesKey(keyData, "shift+tab")) {
			this.#cycle(-1);
			return;
		}
		super.handleInput(keyData);
	}
	#mostRecent(): ObservableSession | undefined {
		const all = this.#registry.getSessions().filter(session => session.kind === "subagent");
		return (
			all.filter(session => session.status === "active").sort((a, b) => b.lastUpdate - a.lastUpdate)[0] ??
			all.sort((a, b) => b.lastUpdate - a.lastUpdate)[0]
		);
	}
	#cycle(direction: 1 | -1): void {
		const ids = this.#registry
			.getSessions()
			.filter(session => session.kind === "subagent")
			.map(session => session.id);
		if (ids.length < 2) return;
		const current = ids.indexOf(this.#selectedSessionId ?? "");
		this.#selectedSessionId = ids[(current + direction + ids.length) % ids.length];
		this.#cache = undefined;
		this.resetSourceState();
		this.#refreshCurrentSource();
	}
	#entries(): readonly TranscriptViewerEntry[] {
		return this.#cache?.projectedOutput ?? [];
	}
	#headerLines(): string[] {
		const session = this.#registry.getSessions().find(candidate => candidate.id === this.#selectedSessionId);
		if (!session) return [theme.fg("dim", "Session no longer available.")];
		const ids = this.#registry
			.getSessions()
			.filter(candidate => candidate.kind === "subagent")
			.map(candidate => candidate.id);
		const position = ids.length > 1 ? theme.fg("dim", ` (${ids.indexOf(session.id) + 1}/${ids.length})`) : "";
		const color = session.status === "active" ? "success" : session.status === "failed" ? "error" : "dim";
		const model = this.#cache?.model ? theme.fg("muted", ` · ${this.#cache.model}`) : "";
		return [
			`${theme.bold(session.label)} ${theme.fg(color, `[${session.status}]`)}${session.agent ? theme.fg("dim", ` ${session.agent}`) : ""}${position}${model}`,
		];
	}
	#footerLines(): string[] {
		const session = this.#registry.getSessions().find(candidate => candidate.id === this.#selectedSessionId);
		const progress = session?.progress;
		if (!progress) return [];
		const stats: string[] = [];
		if (progress.toolCount > 0) stats.push(`${formatNumber(progress.toolCount)} tools`);
		if (progress.contextTokens && progress.contextTokens > 0) {
			stats.push(
				progress.contextWindow && progress.contextWindow > 0
					? `${formatNumber(progress.contextTokens)}/${formatNumber(progress.contextWindow)} ctx`
					: `${formatNumber(progress.contextTokens)} ctx`,
			);
			if (progress.tokens > 0) stats.push(`Σ${formatNumber(progress.tokens)}`);
		} else if (progress.tokens > 0) stats.push(`Σ${formatNumber(progress.tokens)}`);
		if (progress.durationMs > 0) stats.push(formatDuration(progress.durationMs));
		if (progress.cost > 0) stats.push(`$${progress.cost.toFixed(2)}`);
		return stats.length ? [theme.fg("dim", stats.join(theme.sep.dot))] : [];
	}
	#load(filePath: string): boolean {
		if (this.#cache && this.#cache.path !== filePath) {
			this.#cache = undefined;
			this.resetSourceState();
		}

		const cache = this.#cache;
		const read = readStableSnapshot(filePath, cache?.completeOffset ?? 0);
		if (read.status === "unstable") return cache !== undefined;
		if (read.status === "unavailable") {
			if (cache) this.#clearSource();
			return false;
		}
		const snapshot = read.snapshot;
		const canAppend =
			cache &&
			!snapshot.offsetReset &&
			sameIdentity(cache.identity, snapshot.identity) &&
			snapshot.size >= cache.completeOffset &&
			digest(snapshot.prefix) === cache.prefixDigest;
		if (canAppend) return this.#appendStable(cache, snapshot);

		const candidate = cacheEntries(filePath, asFullSnapshot(snapshot));
		if (!candidate) {
			this.#clearSource();
			return false;
		}
		this.#cache = candidate;
		if (cache) this.resetSourceState();
		return false;
	}
	#appendStable(cache: ObserverCache, snapshot: StableSnapshot): boolean {
		const complete = completePrefix(snapshot.tail);
		if (!complete) {
			if (!isValidUtf8Prefix(snapshot.tail)) {
				this.#clearSource();
				return false;
			}
			return true;
		}
		const remainder = snapshot.tail.subarray(complete.bytes.length);
		if (!isValidUtf8Prefix(remainder)) {
			this.#clearSource();
			return false;
		}
		const parsed = parseCompleteEntries(complete.bytes);
		if (!parsed) {
			this.#clearSource();
			return false;
		}
		if (parsed.hasPatchRecords) {
			const candidate = cacheEntries(cache.path, asFullSnapshot(snapshot));
			if (!candidate) {
				this.#clearSource();
				return false;
			}
			this.#cache = candidate;
			return false;
		}

		const entries = [...cache.entries, ...parsed.entries];
		const projection = this.#appendProjection(cache, parsed.entries);
		this.#cache = {
			...cache,
			completeOffset: cache.completeOffset + complete.bytes.length,
			prefixDigest: crypto.createHash("sha256").update(snapshot.prefix).update(complete.bytes).digest("hex"),
			entries,
			model: parsed.model ?? cache.model,
			...projection.state,
		};
		return projection.preserveLayoutCache;
	}
	#appendProjection(cache: ObserverCache, suffix: readonly SessionMessageEntry[]): ProjectionUpdate {
		if (suffix.length === 0) {
			return {
				state: projectionState(cache),
				preserveLayoutCache: true,
			};
		}
		if (!cache.projectionSafe || cache.projectedCount !== cache.entries.length) {
			return {
				state: fullProjection([...cache.entries, ...suffix]),
				preserveLayoutCache: false,
			};
		}

		const projectedOutput = [...cache.projectedOutput];
		const toolCallOutputIndex = new Map(cache.toolCallOutputIndex);
		const patchedIds: string[] = [];
		let appendedCount = 0;
		let patchCount = 0;
		for (const entry of suffix) {
			const message = entry.message;
			if (message.role === "toolResult") {
				const index = toolCallOutputIndex.get(message.toolCallId);
				const existing = index === undefined ? undefined : projectedOutput[index];
				const source = existing?.payload.source;
				const call = isToolProjectionSource(source) ? source.call : undefined;
				if (index === undefined || !call) {
					return {
						state: fullProjection([...cache.entries, ...suffix]),
						preserveLayoutCache: false,
					};
				}
				projectedOutput[index] = toolEntry(call, message);
				patchedIds.push(projectedOutput[index].id);
				patchCount++;
				continue;
			}

			const appended = entriesFromMessages([entry]);
			for (const outputEntry of appended) {
				if (outputEntry.id.startsWith("tool:")) {
					const callId = outputEntry.id.slice("tool:".length);
					if (toolCallOutputIndex.has(callId)) {
						return {
							state: fullProjection([...cache.entries, ...suffix]),
							preserveLayoutCache: false,
						};
					}
					toolCallOutputIndex.set(callId, projectedOutput.length);
				}
				projectedOutput.push(outputEntry);
			}
			appendedCount += appended.length;
		}
		if (patchedIds.length > 0) this.invalidateLayoutEntries(patchedIds);
		recordProjectionCounter("projectionIncrementalRuns");
		recordProjectionCounter("sourceMessagesProjected", suffix.length);
		recordProjectionCounter("projectedEntriesAppended", appendedCount);
		recordProjectionCounter("resultPatchCount", patchCount);
		return {
			state: {
				projectedCount: cache.projectedCount + suffix.length,
				projectedOutput,
				toolCallOutputIndex,
				projectionSafe: true,
			},
			preserveLayoutCache: true,
		};
	}
	#clearSource(): void {
		if (this.#cache) this.resetSourceState();
		this.#cache = undefined;
	}
}

type ToolProjectionSource = { call: ToolCall; result?: ToolResultMessage };

function isToolProjectionSource(source: unknown): source is ToolProjectionSource {
	if (!source || typeof source !== "object" || !("call" in source)) return false;
	const call = source.call;
	return Boolean(call && typeof call === "object" && "type" in call && call.type === "toolCall");
}

function projectionState(cache: ObserverCache): ProjectionState {
	return {
		projectedCount: cache.projectedCount,
		projectedOutput: cache.projectedOutput,
		toolCallOutputIndex: cache.toolCallOutputIndex,
		projectionSafe: cache.projectionSafe,
	};
}

function fullProjection(
	entries: readonly SessionMessageEntry[],
): Pick<ObserverCache, "projectedCount" | "projectedOutput" | "toolCallOutputIndex" | "projectionSafe"> {
	const projectedOutput = entriesFromMessages(entries);
	const toolCallOutputIndex = new Map<string, number>();
	let projectionSafe = true;
	const knownToolCallIds = new Set<string>();
	const unresolvedToolResultIds = new Set<string>();
	for (const entry of entries) {
		const message = entry.message;
		if (message.role === "assistant") {
			for (const content of message.content) if (content.type === "toolCall") knownToolCallIds.add(content.id);
		} else if (message.role === "toolResult") unresolvedToolResultIds.add(message.toolCallId);
	}
	for (const callId of knownToolCallIds) unresolvedToolResultIds.delete(callId);
	if (unresolvedToolResultIds.size > 0) projectionSafe = false;
	for (let index = 0; index < projectedOutput.length; index++) {
		const id = projectedOutput[index].id;
		if (!id.startsWith("tool:")) continue;
		const callId = id.slice("tool:".length);
		if (toolCallOutputIndex.has(callId)) projectionSafe = false;
		else toolCallOutputIndex.set(callId, index);
	}
	recordProjectionCounter("projectionFullRuns");
	recordProjectionCounter("sourceMessagesProjected", entries.length);
	return { projectedCount: entries.length, projectedOutput, toolCallOutputIndex, projectionSafe };
}

function toolEntry(call: ToolCall, result?: ToolResultMessage): TranscriptViewerEntry {
	const resultText =
		result?.content
			.filter(part => part.type === "text")
			.map(part => part.text)
			.join("\n")
			.trim() ?? "";
	const hasResult = result !== undefined;
	const canonicalPayload = {
		text: composeToolText({
			name: call.name,
			args: call.arguments,
			intent: call.intent,
			resultText,
			isError: result?.isError ?? false,
			hasResult,
		}),
		metadata: {
			name: call.name,
			arguments: call.arguments,
			intent: call.intent,
			resultText,
			isError: result?.isError ?? false,
			hasResult,
			detailsData: result?.details,
		},
		source: { call, result },
	};
	return buildToolTranscriptEntry({
		canonicalPayload,
		renderDescriptor: createToolTranscriptRenderDescriptor({
			name: call.name,
			args: call.arguments,
			intent: call.intent,
			resultContent: resultText,
			isError: result?.isError,
			hasResult,
			detailsData: result?.details,
		}),
		capabilities: { copyable: true, foldable: true, rawViewable: true },
		identity: { id: `tool:${call.id}`, label: call.name, display: "full" },
	});
}

/**
 * This deliberately remains the eager full-history projection. PR2 owns projection
 * virtualization/incrementalization; source acquisition above only controls snapshot safety.
 */
export function entriesFromMessages(entries: readonly SessionMessageEntry[]): TranscriptViewerEntry[] {
	const results = new Map<string, ToolResultMessage>();
	for (const entry of entries)
		if (entry.message.role === "toolResult") results.set(entry.message.toolCallId, entry.message);
	const output: TranscriptViewerEntry[] = [];
	for (const entry of entries) {
		const message = entry.message;
		if (message.role === "assistant") {
			if (message.errorMessage && !isSilentAbort(message.errorMessage))
				output.push({
					id: `${entry.id}:error`,
					kind: "text",
					label: "✗ Error:",
					payload: { text: message.errorMessage, metadata: {}, source: message },
					foldable: true,
				});
			message.content.forEach((content, contentIndex) => {
				if (content.type === "thinking" && content.thinking.trim())
					output.push({
						id: `${entry.id}:thinking:${contentIndex}`,
						kind: "thinking",
						label: "Thinking",
						payload: { text: content.thinking, metadata: {}, source: content },
						foldable: true,
						getDisplayText: expanded => truncateThinking(content.thinking, expanded),
					});
				if (content.type === "text" && content.text.trim())
					output.push({
						id: `${entry.id}:text:${contentIndex}`,
						kind: "text",
						label: "Response",
						payload: { text: content.text, metadata: {}, source: content },
						foldable: true,
					});
				if (content.type === "toolCall") output.push(toolEntry(content, results.get(content.id)));
			});
		}
		if (message.role === "user" || message.role === "developer") {
			const text =
				typeof message.content === "string"
					? message.content
					: message.content
							.filter(part => part.type === "text")
							.map(part => part.text)
							.join("\n");
			if (text.trim())
				output.push({
					id: entry.id,
					kind: "user",
					label: message.role === "developer" ? "System" : "User",
					payload: { text, metadata: {}, source: message },
					foldable: true,
				});
		}
	}
	return output;
}

function truncateThinking(text: string, expanded: boolean): string {
	const limit = expanded ? 4_000 : 200;
	return text.length > limit ? `${text.slice(0, limit)}...` : text;
}

function readStableSnapshot(filePath: string, completeOffset: number): SnapshotReadResult {
	let fd: number | undefined;
	try {
		fd = fs.openSync(filePath, "r");
		const before = fs.fstatSync(fd, { bigint: true });
		if (before.size > BigInt(Number.MAX_SAFE_INTEGER)) return { status: "unavailable" };
		const size = Number(before.size);
		const offsetReset = completeOffset > size;
		const offset = offsetReset ? 0 : completeOffset;
		const prefix = readExactly(fd, 0, offset);
		const tail = readExactly(fd, offset, size - offset);
		const after = fs.fstatSync(fd, { bigint: true });
		if (
			before.dev !== after.dev ||
			before.ino !== after.ino ||
			before.size !== after.size ||
			before.mtimeNs !== after.mtimeNs ||
			before.ctimeNs !== after.ctimeNs
		)
			return { status: "unstable" };
		return {
			status: "stable",
			snapshot: { identity: { dev: before.dev, ino: before.ino }, size, prefix, tail, offsetReset },
		};
	} catch (err) {
		return err instanceof UnstableSnapshotError ? { status: "unstable" } : { status: "unavailable" };
	} finally {
		if (fd !== undefined) fs.closeSync(fd);
	}
}

function asFullSnapshot(snapshot: StableSnapshot): StableSnapshot {
	if (snapshot.prefix.length === 0) return snapshot;
	return {
		...snapshot,
		prefix: Buffer.alloc(0),
		tail: Buffer.concat([snapshot.prefix, snapshot.tail]),
		offsetReset: true,
	};
}

function readExactly(fd: number, position: number, length: number): Buffer {
	const buffer = Buffer.alloc(length);
	let offset = 0;
	while (offset < length) {
		const bytesRead = fs.readSync(fd, buffer, offset, length - offset, position + offset);
		if (bytesRead === 0) throw new UnstableSnapshotError("Short session file read");
		offset += bytesRead;
	}
	return buffer;
}

function sameIdentity(left: FileIdentity, right: FileIdentity): boolean {
	return left.dev === right.dev && left.ino === right.ino;
}

function digest(bytes: Buffer): string {
	return crypto.createHash("sha256").update(bytes).digest("hex");
}

function completePrefix(bytes: Buffer): { bytes: Buffer } | undefined {
	const newline = bytes.lastIndexOf(0x0a);
	return newline < 0 ? undefined : { bytes: bytes.subarray(0, newline + 1) };
}

function parseCompleteEntries(
	bytes: Buffer,
): { entries: SessionMessageEntry[]; model?: string; hasPatchRecords: boolean } | null {
	try {
		const text = FATAL_UTF8_DECODER.decode(bytes);
		let hasPatchRecords = false;
		for (const line of text.split("\n")) {
			if (!line.trim()) continue;
			const record: unknown = JSON.parse(line);
			if (
				record !== null &&
				typeof record === "object" &&
				"type" in record &&
				(record.type === "entry_patch" || record.type === "header_patch")
			)
				hasPatchRecords = true;
		}
		const parsed = parseSessionEntries(text);
		return {
			entries: parsed.filter((entry): entry is SessionMessageEntry => entry.type === "message"),
			model: modelFromEntries(parsed),
			hasPatchRecords,
		};
	} catch {
		return null;
	}
}

function modelFromEntries(entries: readonly FileEntry[]): string | undefined {
	let model: string | undefined;
	for (const entry of entries) {
		if (entry.type === "model_change") model = entry.model;
		else if (entry.type === "message" && entry.message.role === "assistant" && entry.message.model)
			model = entry.message.model;
	}
	return model;
}

function isValidUtf8Prefix(bytes: Buffer): boolean {
	try {
		new TextDecoder("utf-8", { fatal: true }).decode(bytes, { stream: true });
		return true;
	} catch {
		return false;
	}
}

function cacheEntries(filePath: string, snapshot: StableSnapshot): ObserverCache | null {
	const complete = completePrefix(snapshot.tail);
	if (!complete) {
		if (!isValidUtf8Prefix(snapshot.tail)) return null;
		return {
			path: filePath,
			identity: snapshot.identity,
			completeOffset: 0,
			prefixDigest: digest(Buffer.alloc(0)),
			entries: [],
			...fullProjection([]),
		};
	}
	const remainder = snapshot.tail.subarray(complete.bytes.length);
	if (!isValidUtf8Prefix(remainder)) return null;
	const parsed = parseCompleteEntries(complete.bytes);
	if (!parsed) return null;
	return {
		path: filePath,
		identity: snapshot.identity,
		completeOffset: complete.bytes.length,
		prefixDigest: digest(complete.bytes),
		entries: parsed.entries,
		model: parsed.model,
		...fullProjection(parsed.entries),
	};
}
