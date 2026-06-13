/**
 * Append-only context mode — stabilizes the byte prefix sent to the LLM
 * across turns so provider prefix caches (DeepSeek, Anthropic, etc.)
 * hit at the maximum possible rate.
 *
 * Two mechanisms:
 *
 * 1. **StablePrefix** — system prompt + tool specs are computed once
 *    and frozen. Subsequent turns reuse the exact same byte sequence
 *    unless `invalidate()` is called (e.g. after MCP reconnect).
 *
 * 2. **AppendOnlyLog** — messages only grow; prior turns are never
 *    re-serialized. Combined with a stable prefix, only the user's new
 *    message delta is a cache miss each turn.
 */

import type { Context, Message, Tool } from "@gajae-code/ai";
import { normalizeTools } from "./agent-loop";
import type { AgentContext } from "./types";

// ---------------------------------------------------------------------------
// StablePrefix (formerly ImmutablePrefix)
// ---------------------------------------------------------------------------

/** Frozen system prompt + tool spec snapshot. */
export interface StablePrefixSnapshot {
	systemPrompt: string[];
	tools: Tool[];
	fingerprint: string;
}

/** Options threaded through `build()` so the snapshot reflects loop-time settings. */
export interface BuildOptions {
	/** Inject the `_i` intent field into tool schemas (must match agent-loop's normalizeTools). */
	intentTracing: boolean;
}

/**
 * A frozen prefix (system prompt + tools) that produces stable byte
 * sequences across `build()` calls.
 *
 * The first `build()` snapshots the live state. Subsequent calls reuse
 * the cached copy until `invalidate()` is called or the live state's
 * fingerprint changes.
 */
export class StablePrefix {
	#snapshot: StablePrefixSnapshot | null = null;
	#version = 0;
	#sourceSystemPrompt: readonly string[] | null = null;
	#sourceTools: AgentContext["tools"] | null = null;
	#sourceIntentTracing: boolean | null = null;

	get fingerprint(): string {
		return this.#snapshot?.fingerprint ?? "<unbuilt>";
	}
	get version(): number {
		return this.#version;
	}
	get built(): boolean {
		return this.#snapshot !== null;
	}

	exportSnapshot(): StablePrefixSnapshot | null {
		return this.#snapshot ? cloneJson(this.#snapshot) : null;
	}

	importSnapshot(snapshot: StablePrefixSnapshot, options: BuildOptions): void {
		const systemPrompt = cloneJson(snapshot.systemPrompt);
		const tools = normalizeImportedTools(snapshot.tools, options);
		const fingerprint = computeFingerprint(systemPrompt, tools, options);
		this.#sourceSystemPrompt = null;
		this.#sourceTools = null;
		this.#sourceIntentTracing = null;
		if (fingerprint !== snapshot.fingerprint) {
			throw new Error(
				`StablePrefix.importSnapshot() fingerprint mismatch: expected ${fingerprint}, received ${snapshot.fingerprint}`,
			);
		}
		this.#snapshot = { systemPrompt, tools, fingerprint };
		this.#version++;
	}

	/**
	 * Build or rebuild from live context.
	 * Returns `true` if the prefix actually changed (cache miss imminent).
	 */
	build(context: AgentContext, options: BuildOptions): boolean {
		if (
			this.#snapshot &&
			this.#sourceSystemPrompt === context.systemPrompt &&
			this.#sourceTools === context.tools &&
			this.#sourceIntentTracing === options.intentTracing
		) {
			const sourceFingerprint = takeSnapshot(context, options).fingerprint;
			if (this.#snapshot.fingerprint === sourceFingerprint) return false;
		}
		const snapshot = takeSnapshot(context, options);
		if (this.#snapshot && this.#snapshot.fingerprint === snapshot.fingerprint) {
			this.#sourceSystemPrompt = context.systemPrompt;
			this.#sourceTools = context.tools;
			this.#sourceIntentTracing = options.intentTracing;
			return false;
		}
		this.#snapshot = snapshot;
		this.#sourceSystemPrompt = context.systemPrompt;
		this.#sourceTools = context.tools;
		this.#sourceIntentTracing = options.intentTracing;
		this.#version++;
		return true;
	}

	/** Force rebuild on the next `build()` call. */
	invalidate(): void {
		this.#snapshot = null;
		this.#sourceSystemPrompt = null;
		this.#sourceTools = null;
		this.#sourceIntentTracing = null;
	}

	/**
	 * Returns the cached prefix.
	 * @throws if `build()` was never called.
	 */
	toContext(): { systemPrompt: string[]; tools: Tool[] } {
		const s = this.#snapshot;
		if (!s) throw new Error("StablePrefix.toContext() called before build()");
		return { systemPrompt: cloneJson(s.systemPrompt), tools: cloneJson(s.tools) };
	}
}

// ---------------------------------------------------------------------------
// AppendOnlyLog
// ---------------------------------------------------------------------------

/**
 * Append-only message log at the `Message[]` (provider-level) layer.
 *
 * The only mutation path is `replaceTail()`, reserved for compaction.
 * Every other operation is append-only.
 */
export class AppendOnlyLog {
	#entries: Message[] = [];

	get length(): number {
		return this.#entries.length;
	}

	append(message: any): void {
		this.#entries.push(message);
	}

	extend(messages: any[]): void {
		for (const m of messages) this.#entries.push(m);
	}

	/** Replace the last entry — only legal for compaction. */
	replaceTail(replacement: any): void {
		const idx = this.#entries.length - 1;
		if (idx >= 0) this.#entries[idx] = replacement;
	}

	/** Returns a shallow copy of all entries. */
	toMessages(): Message[] {
		return this.#entries.slice();
	}

	/** Direct readonly access for in-place inspection. */
	entries(): readonly Message[] {
		return this.#entries;
	}

	clear(): void {
		this.#entries = [];
	}
}

// ---------------------------------------------------------------------------
// AppendOnlyContextManager
// ---------------------------------------------------------------------------

/**
 * Manages a stable prefix + append-only log for the agent loop.
 *
 * Call `build(context)` each turn to get a `Context` with stable
 * `systemPrompt` and `tools` and append-only messages. Call
 * `syncMessages(normalizedMessages)` after `convertToLlm` each
 * turn to keep the log in sync.
 *
 * Example:
 * ```
 * const mgr = new AppendOnlyContextManager();
 * const ctx = mgr.build(context);  // first call snapshots prefix
 * mgr.syncMessages(normalized);    // grow the log
 * ctx = mgr.build(context);        // subsequent calls use cache
 * ```
 */
export class AppendOnlyContextManager {
	readonly prefix = new StablePrefix();
	readonly log = new AppendOnlyLog();
	/** How many normalized messages were synced into the log as of the last sync. */
	#lastSyncCount = 0;
	/** Fingerprint plus source bytes of synced message content — detects in-place rewrites with no hash-only equality. */
	#syncedDigest = emptyMessageDigest();
	/** Number of provider-normalized messages that were seeded before child-local messages. */
	#seededPrefixCount = 0;

	static forkFromSeed(args: {
		prefixSnapshot?: StablePrefixSnapshot;
		messages?: readonly Message[];
		options: BuildOptions;
	}): AppendOnlyContextManager {
		const manager = new AppendOnlyContextManager();
		if (args.prefixSnapshot) {
			manager.prefix.importSnapshot(args.prefixSnapshot, args.options);
		}
		if (args.messages) {
			manager.seedNormalizedMessages(args.messages);
		}
		return manager;
	}

	build(context: AgentContext, options: BuildOptions): Context {
		this.prefix.build(context, options);
		const { systemPrompt, tools } = this.prefix.toContext();
		return { systemPrompt, messages: this.log.toMessages(), tools };
	}

	/**
	 * Sync normalized (provider-level) messages into the append-only log.
	 *
	 * Detects both compaction (shorter array) and in-place rewrites
	 * (same length, changed content via a rolling digest).
	 */
	syncMessages(normalizedMessages: any[]): void {
		const seededPrefixLength = this.#seededPrefixCount;
		const includesSeedPrefix =
			seededPrefixLength > 0 &&
			normalizedMessages.length >= seededPrefixLength &&
			this.#computeDigestRange(normalizedMessages, 0, seededPrefixLength).source ===
				this.#computeDigestRange(this.log.entries(), 0, seededPrefixLength).source;
		const messagesToSync =
			seededPrefixLength > 0 && !includesSeedPrefix
				? [...this.log.entries().slice(0, seededPrefixLength), ...normalizedMessages]
				: normalizedMessages;

		// Detect in-place rewrites of already-synced messages.
		if (
			this.#lastSyncCount > 0 &&
			this.#lastSyncCount <= messagesToSync.length &&
			this.#computeDigestRange(messagesToSync, 0, this.#lastSyncCount).source !== this.#syncedDigest.source
		) {
			if (this.#seededPrefixCount > 0) {
				throw new Error("AppendOnlyContextManager.syncMessages() seed prefix changed");
			}
			this.log.clear();
			this.#lastSyncCount = 0;
		}

		// Compaction — array shrunk. Seeded forks preserve the inherited prefix
		// and append child-local deltas, so a shorter child message array is not a
		// compaction signal while a seed prefix is active.
		if (messagesToSync.length < this.#lastSyncCount) {
			if (this.#seededPrefixCount > 0) {
				throw new Error("AppendOnlyContextManager.syncMessages() cannot compact a seeded fork without reset");
			}
			this.log.clear();
			this.#lastSyncCount = 0;
		}

		const newMsgs = messagesToSync.slice(this.#lastSyncCount);
		for (const msg of newMsgs) {
			this.log.append(msg);
		}

		this.#lastSyncCount = messagesToSync.length;
		this.#syncedDigest = this.#computeDigest(messagesToSync);
	}

	seedNormalizedMessages(messages: readonly Message[], options?: { reset?: boolean }): void {
		if (this.log.length > 0 && options?.reset !== true) {
			throw new Error("AppendOnlyContextManager.seedNormalizedMessages() cannot seed a non-empty log without reset");
		}
		const clonedMessages = cloneJson([...messages]);
		this.log.clear();
		this.log.extend(clonedMessages);
		this.#lastSyncCount = clonedMessages.length;
		this.#syncedDigest = this.#computeDigest(clonedMessages);
		this.#seededPrefixCount = clonedMessages.length;
	}

	/** Reset prefix + log for a model/provider switch while mode stays active. */
	invalidateForModelChange(): void {
		this.prefix.invalidate();
		this.log.clear();
		this.#lastSyncCount = 0;
		this.#syncedDigest = emptyMessageDigest();
		this.#seededPrefixCount = 0;
	}

	/** Reset the sync cursor AND clear the log. */
	resetSyncCursor(): void {
		this.log.clear();
		this.#lastSyncCount = 0;
		this.#syncedDigest = emptyMessageDigest();
		this.#seededPrefixCount = 0;
	}

	appendMessage(message: any): void {
		this.log.append(message);
	}

	replaceTailMessage(message: any): void {
		this.log.replaceTail(message);
	}

	invalidate(): void {
		this.prefix.invalidate();
	}

	reset(context: AgentContext, options: BuildOptions): void {
		this.prefix.invalidate();
		this.log.clear();
		this.#lastSyncCount = 0;
		this.#syncedDigest = emptyMessageDigest();
		this.#seededPrefixCount = 0;
		this.prefix.build(context, options);
	}

	/**
	 * Deterministic digest over the provider-visible message payload. The source
	 * string is kept and compared for equality so the hash is only a fast summary,
	 * never the authority for accepting append-only sync state.
	 */
	#computeDigest(messages: readonly unknown[]): MessageDigest {
		return this.#computeDigestRange(messages, 0, messages.length);
	}

	#computeDigestRange(messages: readonly unknown[], start: number, end: number): MessageDigest {
		let source = "[";
		for (let i = start; i < end; i++) {
			if (i > start) source += ",";
			source += JSON.stringify(messages[i]) ?? "null";
		}
		source += "]";
		return { hash: hashSource(source), source };
	}
}

// ---------------------------------------------------------------------------
// Snapshot helpers
// ---------------------------------------------------------------------------

type MessageDigest = {
	hash: number | bigint;
	source: string;
};

function emptyMessageDigest(): MessageDigest {
	return { hash: hashSource("[]"), source: "[]" };
}

function hashSource(source: string): number | bigint {
	return typeof Bun !== "undefined" ? Bun.hash(source) : hashString32(source);
}

function hashString32(value: string): number {
	let hash = 0;
	for (let i = 0; i < value.length; i++) {
		hash = ((hash << 5) - hash + value.charCodeAt(i)) | 0;
	}
	return hash >>> 0;
}

function takeSnapshot(context: AgentContext, options: BuildOptions): StablePrefixSnapshot {
	const systemPrompt = [...context.systemPrompt];
	const tools = normalizeTools(context.tools, options.intentTracing) ?? [];
	return {
		systemPrompt,
		tools,
		fingerprint: computeFingerprint(systemPrompt, tools, options),
	};
}

function normalizeImportedTools(tools: readonly Tool[], options: BuildOptions): Tool[] {
	const clonedTools = cloneJson(tools);
	const normalizedTools = normalizeTools(clonedTools as AgentContext["tools"], options.intentTracing) ?? [];
	return cloneJson(normalizedTools);
}

export function cloneJson<T>(value: T): T {
	return cloneJsonValue(value) as T;
}

function cloneJsonValue(value: unknown, key = "", applyToJson = true): unknown {
	if (value === null) return null;
	const type = typeof value;
	if (type === "number") return Number.isFinite(value) ? value : null;
	// JSON.stringify drops function/symbol/undefined values (object props
	// omitted, array elements become null via the array walk below).
	if (type === "undefined" || type === "function" || type === "symbol") return undefined;
	if (type !== "object") return value;
	if (applyToJson) {
		// JSON.stringify performs a single Get of `toJSON` per holder/key and
		// serializes the returned replacement WITHOUT re-dispatching the
		// replacement's own toJSON at the same level (nested properties still
		// dispatch normally). Mirror that exactly to keep byte parity.
		const toJSON = (value as { toJSON?: unknown }).toJSON;
		if (typeof toJSON === "function") {
			return cloneJsonValue(toJSON.call(value, key), key, false);
		}
	}
	if (Array.isArray(value)) {
		const cloned: unknown[] = new Array(value.length);
		for (let i = 0; i < value.length; i++) {
			const item = Object.hasOwn(value, i) ? cloneJsonValue(value[i], String(i)) : undefined;
			cloned[i] = item === undefined ? null : item;
		}
		return cloned;
	}
	const cloned: Record<string, unknown> = {};
	for (const key of Object.keys(value as object)) {
		const clonedValue = cloneJsonValue((value as Record<string, unknown>)[key], key);
		if (clonedValue !== undefined) cloned[key] = clonedValue;
	}
	return cloned;
}

function computeFingerprint(systemPrompt: string[], tools: Tool[], options: BuildOptions): string {
	const payload = JSON.stringify({
		s: systemPrompt,
		t: tools.map(t => ({
			n: t.name,
			d: t.description,
			p: t.parameters,
			s: t.strict,
			cf: t.customFormat,
			cw: t.customWireName,
		})),
		i: options.intentTracing,
	});
	let hash = 0;
	for (let i = 0; i < payload.length; i++) {
		hash = ((hash << 5) - hash + payload.charCodeAt(i)) | 0;
	}
	return (hash >>> 0).toString(36);
}
