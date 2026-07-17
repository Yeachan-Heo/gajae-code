import * as fs from "node:fs";
import type { ToolResultMessage } from "@gajae-code/ai";
import { matchesKey } from "@gajae-code/tui";
import { formatDuration, formatNumber } from "@gajae-code/utils";
import type { KeyId } from "../../config/keybindings";
import { isSilentAbort } from "../../session/messages";
import type { SessionMessageEntry } from "../../session/session-manager";
import { parseSessionEntries } from "../../session/session-manager";
import type { ObservableSession, SessionObserverRegistry } from "../session-observer-registry";
import { theme } from "../theme/theme";
import { type TranscriptViewerEntry, TranscriptViewerOverlay } from "./transcript-viewer-overlay";

const MAX_TOOL_ARGS_CHARS = 500;

/** Session-observer adapter. The shared viewer owns navigation and fold state. */
export class SessionObserverOverlayComponent extends TranscriptViewerOverlay {
	#registry: SessionObserverRegistry;
	#onDone: () => void;
	#observeKeys: readonly KeyId[];
	#selectedSessionId?: string;
	#cache?: { path: string; bytesRead: number; entries: SessionMessageEntry[]; model?: string };

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
		if (this.#cache?.path !== filePath) this.#cache = undefined;
		const fromByte = this.#cache?.bytesRead ?? 0;
		const result = readFileIncremental(filePath, fromByte);
		if (!result) return this.#cache?.entries ?? [];
		if (result.newSize < fromByte) {
			this.#cache = undefined;
			return this.#load(filePath);
		}
		if (!this.#cache) this.#cache = { path: filePath, bytesRead: 0, entries: [] };
		if (result.text) {
			const lastNewline = result.text.lastIndexOf("\n");
			if (lastNewline >= 0) {
				const complete = result.text.slice(0, lastNewline + 1);
				for (const entry of parseSessionEntries(complete)) {
					if (entry.type === "message") {
						this.#cache.entries.push(entry);
						if (!this.#cache.model && entry.message.role === "assistant") this.#cache.model = entry.message.model;
					} else if (entry.type === "model_change") this.#cache.model = entry.model;
				}
				this.#cache.bytesRead = fromByte + Buffer.byteLength(complete, "utf-8");
			}
		}
		return this.#cache.entries;
	}
}

function entriesFromMessages(entries: readonly SessionMessageEntry[]): TranscriptViewerEntry[] {
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
					const summary = formatToolArgs(content.name, content.arguments);
					const callText = [summary, content.intent].filter(Boolean).join("\n");
					const resultDisplay = result?.isError ? `✗ ${resultText || "Error"}` : resultText || "✓ done";
					output.push({
						id: `tool:${content.id}`,
						kind: "tool",
						label: content.name,
						payload: {
							text: [callText, resultDisplay].filter(Boolean).join("\n"),
							metadata: {
								name: content.name,
								arguments: content.arguments,
								intent: content.intent,
								isError: result?.isError ?? false,
							},
							source: { call: content, result },
						},
						foldable: true,
					});
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

function formatToolArgs(name: string, args: Record<string, unknown>): string {
	if (name === "read" || name === "write" || name === "edit") return args.path ? `path: ${args.path}` : "";
	if (name === "bash") return typeof args.command === "string" ? args.command.replaceAll("\t", "    ") : "";
	if (name === "search")
		return [
			args.pattern ? `pattern: ${args.pattern}` : "",
			Array.isArray(args.paths) ? `paths: ${args.paths.join(", ")}` : "",
		]
			.filter(Boolean)
			.join(", ");
	return Object.entries(args)
		.filter(([key]) => !key.startsWith("_"))
		.map(([key, value]) => `${key}: ${typeof value === "string" ? value : JSON.stringify(value)}`)
		.join(", ")
		.slice(0, MAX_TOOL_ARGS_CHARS);
}

function truncateThinking(text: string, expanded: boolean): string {
	const limit = expanded ? 4_000 : 200;
	return text.length > limit ? `${text.slice(0, limit)}...` : text;
}

function readFileIncremental(filePath: string, fromByte: number): { text: string; newSize: number } | null {
	try {
		const stat = fs.statSync(filePath);
		if (stat.size <= fromByte) return { text: "", newSize: stat.size };
		const buffer = Buffer.alloc(stat.size - fromByte);
		const fd = fs.openSync(filePath, "r");
		try {
			fs.readSync(fd, buffer, 0, buffer.length, fromByte);
		} finally {
			fs.closeSync(fd);
		}
		return { text: buffer.toString("utf-8"), newSize: stat.size };
	} catch {
		return null;
	}
}
