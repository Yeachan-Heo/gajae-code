import * as crypto from "node:crypto";
import * as fs from "node:fs";
import type { ToolResultMessage } from "@gajae-code/ai";
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
type StableSnapshot = { identity: FileIdentity; size: number; prefix: Buffer; tail: Buffer };
type ObserverCache = {
	path: string;
	identity: FileIdentity;
	completeOffset: number;
	prefixDigest: string;
	entries: SessionMessageEntry[];
	model?: string;
};

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
		this.refresh();
	}

	refreshFromRegistry(): void {
		this.refresh();
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
		this.refresh();
	}
	#entries(): readonly TranscriptViewerEntry[] {
		const session = this.#registry.getSessions().find(candidate => candidate.id === this.#selectedSessionId);
		if (!session?.sessionFile) return [];
		return entriesFromMessages(this.#load(session.sessionFile));
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
	#load(filePath: string): SessionMessageEntry[] {
		if (this.#cache && this.#cache.path !== filePath) {
			this.#cache = undefined;
			this.resetSourceState();
		}

		const cache = this.#cache;
		const snapshot = readStableSnapshot(filePath, cache?.completeOffset ?? 0);
		if (!snapshot) {
			// An unreadable source is never allowed to keep presenting a prior file as current.
			if (cache) this.#clearSource();
			return [];
		}

		const canAppend =
			cache &&
			sameIdentity(cache.identity, snapshot.identity) &&
			snapshot.size >= cache.completeOffset &&
			digest(snapshot.prefix) === cache.prefixDigest;
		if (canAppend) return this.#appendStable(cache, snapshot);

		// A changed fd identity, changed committed bytes, or a shrink is a replacement.
		// Validate the entire candidate before it replaces the visible transcript.
		const replacement = readStableSnapshot(filePath, 0);
		if (!replacement) {
			this.#clearSource();
			return [];
		}
		const candidate = cacheEntries(filePath, replacement);
		if (!candidate) {
			this.#clearSource();
			return [];
		}
		this.#cache = candidate;
		if (cache) this.resetSourceState();
		return candidate.entries;
	}
	#appendStable(cache: ObserverCache, snapshot: StableSnapshot): SessionMessageEntry[] {
		const complete = completePrefix(snapshot.tail);
		if (!complete) {
			if (!isValidUtf8Prefix(snapshot.tail)) {
				this.#clearSource();
				return [];
			}
			return cache.entries;
		}
		const remainder = snapshot.tail.subarray(complete.bytes.length);
		if (!isValidUtf8Prefix(remainder)) {
			this.#clearSource();
			return [];
		}
		const parsed = parseCompleteEntries(complete.bytes);
		if (!parsed) {
			this.#clearSource();
			return [];
		}
		const entries = [...cache.entries, ...parsed.entries];
		this.#cache = {
			...cache,
			completeOffset: cache.completeOffset + complete.bytes.length,
			prefixDigest: digest(Buffer.concat([snapshot.prefix, complete.bytes])),
			entries,
			model: parsed.model ?? cache.model,
		};
		return entries;
	}
	#clearSource(): void {
		if (this.#cache) this.resetSourceState();
		this.#cache = undefined;
	}
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
				if (content.type === "toolCall") {
					const result = results.get(content.id);
					const resultText =
						result?.content
							.filter(part => part.type === "text")
							.map(part => part.text)
							.join("\n")
							.trim() ?? "";
					const canonicalPayload = {
						text: composeToolText({
							name: content.name,
							args: content.arguments,
							intent: content.intent,
							resultText,
							isError: result?.isError ?? false,
							hasResult: results.has(content.id),
						}),
						metadata: {
							name: content.name,
							arguments: content.arguments,
							intent: content.intent,
							resultText,
							isError: result?.isError ?? false,
							hasResult: results.has(content.id),
							detailsData: result?.details,
						},
						source: { call: content, result },
					};
					output.push(
						buildToolTranscriptEntry({
							canonicalPayload,
							renderDescriptor: createToolTranscriptRenderDescriptor({
								name: content.name,
								args: content.arguments,
								intent: content.intent,
								resultContent: resultText,
								isError: result?.isError,
								hasResult: results.has(content.id),
								detailsData: result?.details,
							}),
							capabilities: { copyable: true, foldable: true, rawViewable: true },
							identity: { id: `tool:${content.id}`, label: content.name, display: "full" },
						}),
					);
				}
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

function readStableSnapshot(filePath: string, completeOffset: number): StableSnapshot | null {
	let fd: number | undefined;
	try {
		fd = fs.openSync(filePath, "r");
		const before = fs.fstatSync(fd, { bigint: true });
		if (before.size > BigInt(Number.MAX_SAFE_INTEGER) || completeOffset > Number(before.size)) return null;
		const size = Number(before.size);
		const prefix = readExactly(fd, 0, completeOffset);
		const tail = readExactly(fd, completeOffset, size - completeOffset);
		const after = fs.fstatSync(fd, { bigint: true });
		if (
			before.dev !== after.dev ||
			before.ino !== after.ino ||
			before.size !== after.size ||
			before.mtimeNs !== after.mtimeNs ||
			before.ctimeNs !== after.ctimeNs
		)
			return null;
		return { identity: { dev: before.dev, ino: before.ino }, size, prefix, tail };
	} catch {
		return null;
	} finally {
		if (fd !== undefined) fs.closeSync(fd);
	}
}

function readExactly(fd: number, position: number, length: number): Buffer {
	const buffer = Buffer.alloc(length);
	let offset = 0;
	while (offset < length) {
		const bytesRead = fs.readSync(fd, buffer, offset, length - offset, position + offset);
		if (bytesRead === 0) throw new Error("Short session file read");
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

function parseCompleteEntries(bytes: Buffer): { entries: SessionMessageEntry[]; model?: string } | null {
	try {
		const text = FATAL_UTF8_DECODER.decode(bytes);
		for (const line of text.split("\n")) if (line.trim()) JSON.parse(line);
		const parsed = parseSessionEntries(text);
		return {
			entries: parsed.filter((entry): entry is SessionMessageEntry => entry.type === "message"),
			model: modelFromEntries(parsed),
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
	};
}
