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
		const snapshot = takeSnapshot(context, options);
		if (this.#snapshot && this.#snapshot.fingerprint === snapshot.fingerprint) {
			return false;
		}
		this.#snapshot = snapshot;
		this.#version++;
		return true;
	}

	/** Force rebuild on the next `build()` call. */
	invalidate(): void {
		this.#snapshot = null;
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
	/** Rolling digest of synced message content — detects in-place rewrites. */
	#syncedDigest = 0;
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
		const seededPrefix = this.#seededPrefixCount > 0 ? this.log.toMessages().slice(0, this.#seededPrefixCount) : [];
		const includesSeedPrefix =
			seededPrefix.length > 0 &&
			normalizedMessages.length >= seededPrefix.length &&
			this.#computeDigest(normalizedMessages.slice(0, seededPrefix.length)) === this.#computeDigest(seededPrefix);
		const messagesToSync =
			seededPrefix.length > 0 && !includesSeedPrefix ? [...seededPrefix, ...normalizedMessages] : normalizedMessages;

		// Detect in-place rewrites of already-synced messages.
		if (
			this.#lastSyncCount > 0 &&
			this.#lastSyncCount <= messagesToSync.length &&
			this.#computeDigest(messagesToSync.slice(0, this.#lastSyncCount)) !== this.#syncedDigest
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
		this.#syncedDigest = 0;
		this.#seededPrefixCount = 0;
	}

	/** Reset the sync cursor AND clear the log. */
	resetSyncCursor(): void {
		this.log.clear();
		this.#lastSyncCount = 0;
		this.#syncedDigest = 0;
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
		this.#syncedDigest = 0;
		this.#seededPrefixCount = 0;
		this.prefix.build(context, options);
	}

	/**
	 * Deterministic digest over every field the provider may serialize — role,
	 * content, tool calls (both `toolCalls` and OpenAI-wire `tool_calls`),
	 * `tool_call_id`, `name`, `id`. Hashed with the same FNV-style rolling
	 * accumulator so in-place rewrites of *any* of these fields are visible.
	 */
	#computeDigest(messages: readonly unknown[]): number {
		let hash = 0;
		for (let i = 0; i < messages.length; i++) {
			const msg = messages[i];
			if (!msg || typeof msg !== "object") continue;
			const m = msg as Record<string, unknown>;
			const payload = JSON.stringify({
				r: m.role ?? null,
				c: m.content ?? null,
				tc: m.toolCalls ?? m.tool_calls ?? null,
				tcid: m.tool_call_id ?? null,
				n: m.name ?? null,
				id: m.id ?? null,
			});
			for (let j = 0; j < payload.length; j++) {
				hash = ((hash << 5) - hash + payload.charCodeAt(j)) | 0;
			}
		}
		return hash >>> 0;
	}
}

// ---------------------------------------------------------------------------
// Snapshot helpers
// ---------------------------------------------------------------------------

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

function cloneJson<T>(value: T): T {
	return JSON.parse(JSON.stringify(value)) as T;
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
