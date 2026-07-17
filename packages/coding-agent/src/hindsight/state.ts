import { createHash } from "node:crypto";

import { logger } from "@gajae-code/utils";
import type { AgentSession } from "../session/agent-session";
import { type BankScope, ensureBankMission } from "./bank";
import type { HindsightApi, MemoryItemInput } from "./client";
import type { HindsightConfig } from "./config";
import {
	composeRecallQuery,
	formatMemories,
	type HindsightMessage,
	prepareRetentionTranscript,
	sliceLastTurnsByUserBoundary,
	truncateRecallQuery,
} from "./content";
import {
	ensureMentalModels,
	loadMentalModelsBlock,
	MENTAL_MODEL_FIRST_TURN_DEADLINE_MS,
	resolveSeedsForScope,
} from "./mental-models";
import { extractMessages } from "./transcript";

const RETAIN_FLUSH_BATCH_SIZE = 16;
const RETAIN_FLUSH_INTERVAL_MS = 5_000;

interface PendingRetainItem {
	content: string;
	context?: string;
}

interface RecallOutcome {
	context: string | null;
	ok: boolean;
}

export interface HindsightSessionStateOptions {
	/** Session id used for retain-queue metadata. */
	sessionId: string;
	client: HindsightApi;
	bankId: string;
	/** Tags applied to every retain — non-empty in per-project-tagged mode. */
	retainTags?: string[];
	/** Tag filter applied to every recall/reflect — non-empty in per-project-tagged mode. */
	recallTags?: string[];
	recallTagsMatch?: "any" | "all" | "any_strict" | "all_strict";
	config: HindsightConfig;
	session: AgentSession;
	missionsSet: Set<string>;
	lastRetainedTurn?: number;
	hasRecalledForFirstTurn?: boolean;
	/**
	 * When set, this entry is a subagent alias that reuses the parent's bank,
	 * scope, config, client, and missionsSet. Aliases skip auto-recall and
	 * auto-retain — those run on the parent only — but the recall/retain/reflect
	 * tools resolve via the alias so they persist to the same bank as the parent.
	 */
	aliasOf?: HindsightSessionState;
}

/**
 * Debounced batch queue for tool-initiated `retain` calls owned by one
 * Hindsight session state instance.
 *
 * Auto-retain (`HindsightSessionState.retainSession`) is intentionally not
 * routed through this queue — it submits a full transcript as one large item
 * and already runs `async: true` server-side.
 */
export class HindsightRetainQueue {
	readonly #state: HindsightSessionState;
	#items: PendingRetainItem[] = [];
	#timer?: NodeJS.Timeout;
	#flushing?: Promise<void>;
	#closed = false;

	constructor(state: HindsightSessionState) {
		this.#state = state;
	}

	get depth(): number {
		return this.#items.length;
	}

	enqueue(content: string, context?: string): void {
		if (this.#closed) {
			throw new Error("Hindsight retain queue is closed.");
		}
		this.#items.push({ content, context });

		if (this.#items.length >= RETAIN_FLUSH_BATCH_SIZE) {
			void this.flush();
			return;
		}
		if (!this.#timer) {
			this.#timer = setTimeout(() => {
				void this.flush();
			}, RETAIN_FLUSH_INTERVAL_MS);
			// Don't pin the event loop alive just for a pending retain flush.
			this.#timer.unref?.();
		}
	}

	async flush(): Promise<void> {
		if (this.#timer) {
			clearTimeout(this.#timer);
			this.#timer = undefined;
		}

		if (this.#flushing) return this.#flushing;
		if (this.#items.length === 0) return;

		this.#flushing = this.#flushLoop();
		try {
			await this.#flushing;
		} finally {
			this.#flushing = undefined;
		}
	}

	async #flushLoop(): Promise<void> {
		while (this.#items.length > 0) {
			const items = this.#items.splice(0);
			await this.#doFlush(items);
		}
	}

	async dispose(): Promise<void> {
		this.#closed = true;
		if (this.#timer) {
			clearTimeout(this.#timer);
			this.#timer = undefined;
		}
		await this.flush();
	}

	async #doFlush(items: PendingRetainItem[]): Promise<void> {
		const state = this.#state;
		const sessionId = state.sessionId;
		if (state.session.getHindsightSessionState() !== state) {
			// Session went away before we could flush. We can't notify anyone, so
			// log and drop — these are best-effort facts, not transactional writes.
			logger.warn("Hindsight retain queue: session vanished, dropping batch", {
				sessionId,
				items: items.length,
			});
			return;
		}

		try {
			await ensureBankMission(state.client, state.bankId, state.config, state.missionsSet);
			const batch: MemoryItemInput[] = items.map(item => ({
				content: item.content,
				context: item.context ?? state.config.retainContext,
				metadata: { session_id: sessionId },
				tags: state.retainTags,
			}));
			await state.client.retainBatch(state.bankId, batch, { async: true });
			if (state.config.debug) {
				logger.debug("Hindsight retain queue: batch flushed", {
					sessionId,
					bankId: state.bankId,
					items: items.length,
				});
			}
		} catch (err) {
			const errorText = err instanceof Error ? err.message : String(err);
			logger.warn("Hindsight retain queue: batch flush failed", {
				sessionId,
				bankId: state.bankId,
				items: items.length,
				error: errorText,
			});
			this.#notifyRetainFailure(items.length, errorText);
		}
	}

	#notifyRetainFailure(count: number, errorText: string): void {
		const noun = count === 1 ? "memory" : "memories";
		this.#state.session.emitNotice(
			"warning",
			`Memory retention failed for ${count} ${noun}: ${errorText}`,
			"Hindsight",
		);
	}
}

/** Per-session Hindsight runtime state owned by its AgentSession. */
export class HindsightSessionState {
	/** Session id used for retain-queue metadata. */
	sessionId: string;
	client: HindsightApi;
	bankId: string;
	/** Tags applied to every retain — non-empty in per-project-tagged mode. */
	retainTags?: string[];
	/** Tag filter applied to every recall/reflect — non-empty in per-project-tagged mode. */
	recallTags?: string[];
	recallTagsMatch?: "any" | "all" | "any_strict" | "all_strict";
	config: HindsightConfig;
	session: AgentSession;
	missionsSet: Set<string>;
	lastRetainedTurn: number;
	hasRecalledForFirstTurn: boolean;
	lastRecallSnippet?: string;
	lastInjectedRecallSnippetHash?: string;
	/** Cached `<mental_models>` block injected into developer instructions. */
	mentalModelsSnippet?: string;
	/** When the cached snippet was last refreshed; gates the agent_end re-list. */
	mentalModelsLoadedAt?: number;
	/**
	 * In-flight ensure+load promise. `beforeAgentStartPrompt` awaits this on
	 * the first turn so the MM block lands in the system prompt before the
	 * LLM generates, even though `start()` returns before the load completes.
	 */
	mentalModelsLoadPromise?: Promise<void>;
	unsubscribe?: () => void;
	/** Alias states delegate persistence config to a primary parent state. */
	aliasOf?: HindsightSessionState;
	/** One auto-retain may run at a time; one later agent_end is coalesced. */
	#autoRetainInFlight?: Promise<void>;
	#autoRetainPending = false;
	readonly retainQueue: HindsightRetainQueue;

	constructor(options: HindsightSessionStateOptions) {
		this.sessionId = options.sessionId;
		this.client = options.client;
		this.bankId = options.bankId;
		this.retainTags = options.retainTags;
		this.recallTags = options.recallTags;
		this.recallTagsMatch = options.recallTagsMatch;
		this.config = options.config;
		this.session = options.session;
		this.missionsSet = options.missionsSet;
		this.lastRetainedTurn = options.lastRetainedTurn ?? 0;
		this.hasRecalledForFirstTurn = options.hasRecalledForFirstTurn ?? false;
		this.aliasOf = options.aliasOf;
		this.retainQueue = new HindsightRetainQueue(this);
	}

	setSessionId(sessionId: string): void {
		this.sessionId = sessionId;
	}

	resetConversationTracking(): void {
		this.lastRetainedTurn = 0;
		this.hasRecalledForFirstTurn = false;
		this.lastRecallSnippet = undefined;
		this.lastInjectedRecallSnippetHash = undefined;
	}

	/** Return the current recall payload, resolving subagent aliases to their primary state. */
	getRecallSnippet(): string | undefined {
		return this.aliasOf ? this.aliasOf.getRecallSnippet() : this.lastRecallSnippet;
	}
	/** Return the current recall payload without consuming its one-shot injection eligibility. */
	getRecallSnippetForInjection(): string | undefined {
		if (this.aliasOf) return this.aliasOf.getRecallSnippetForInjection();
		const snippet = this.lastRecallSnippet;
		if (!snippet) return undefined;
		const hash = createHash("sha256").update(snippet).digest("hex");
		return hash === this.lastInjectedRecallSnippetHash ? undefined : snippet;
	}

	/** Mark a recall payload consumed only after it has been accepted for provider injection. */
	markRecallSnippetInjected(snippet: string): boolean {
		if (this.aliasOf) return this.aliasOf.markRecallSnippetInjected(snippet);
		if (snippet !== this.lastRecallSnippet) return false;
		const hash = createHash("sha256").update(snippet).digest("hex");
		if (hash === this.lastInjectedRecallSnippetHash) return false;
		this.lastInjectedRecallSnippetHash = hash;
		return true;
	}

	enqueueRetain(content: string, context?: string): void {
		this.retainQueue.enqueue(content, context);
	}

	async flushRetainQueue(): Promise<void> {
		await this.retainQueue.flush();
	}

	async recallForContext(query: string, signal?: AbortSignal): Promise<RecallOutcome> {
		try {
			const response = await this.client.recall(this.bankId, query, {
				budget: this.config.recallBudget,
				maxTokens: this.config.recallMaxTokens,
				types: this.config.recallTypes.length > 0 ? this.config.recallTypes : undefined,
				tags: this.recallTags,
				tagsMatch: this.recallTagsMatch,
			});
			if (signal?.aborted) return { context: null, ok: false };
			const results = response.results ?? [];
			if (results.length === 0) return { context: null, ok: true };
			const formatted = formatMemories(results);
			const block = `<memories>\n${this.config.recallPromptPreamble}\n\n${formatted}\n</memories>`;
			return { context: block, ok: true };
		} catch (err) {
			if (this.config.debug) {
				logger.debug("Hindsight: recall failed", { bankId: this.bankId, error: String(err) });
			}
			return { context: null, ok: false };
		}
	}

	async retainSession(messages: HindsightMessage[]): Promise<boolean> {
		const retainFullWindow = this.config.retainMode === "full-session";
		let target: HindsightMessage[];
		let documentId: string;

		if (retainFullWindow) {
			target = sliceMessagesAfterUserTurns(messages, this.lastRetainedTurn);
			if (target.length === 0) return false;
			documentId = this.sessionId;
		} else {
			const windowTurns = this.config.retainEveryNTurns + this.config.retainOverlapTurns;
			target = sliceLastTurnsByUserBoundary(messages, windowTurns);
			documentId = `${this.sessionId}-${Date.now()}`;
		}

		const { transcript } = prepareRetentionTranscript(target, true);
		if (!transcript) return false;

		await ensureBankMission(this.client, this.bankId, this.config, this.missionsSet);
		await this.client.retain(this.bankId, transcript, {
			documentId,
			updateMode: "append",
			context: this.config.retainContext,
			metadata: { session_id: this.sessionId },
			tags: this.retainTags,
			async: true,
		});
		return true;
	}

	async maybeRetainOnAgentEnd(): Promise<void> {
		if (this.#autoRetainInFlight) {
			this.#autoRetainPending = true;
			return;
		}

		const retain = this.#maybeRetainOnAgentEnd();
		this.#autoRetainInFlight = retain;
		try {
			await retain;
		} finally {
			this.#autoRetainInFlight = undefined;
			if (this.#autoRetainPending) {
				this.#autoRetainPending = false;
				void this.maybeRetainOnAgentEnd();
			}
		}
	}

	async #maybeRetainOnAgentEnd(): Promise<void> {
		if (!this.config.autoRetain) return;
		const messages = extractMessages(this.session.sessionManager);
		if (messages.length === 0) return;
		const userTurns = messages.filter(m => m.role === "user").length;
		if (userTurns - this.lastRetainedTurn < this.config.retainEveryNTurns) return;

		try {
			const retained = await this.retainSession(messages);
			if (!retained) return;
			this.lastRetainedTurn = userTurns;
			if (this.config.debug) {
				logger.debug("Hindsight: auto-retain succeeded", {
					sessionId: this.sessionId,
					bankId: this.bankId,
					userTurns,
					messages: messages.length,
				});
			}
		} catch (err) {
			logger.warn("Hindsight: auto-retain failed", {
				sessionId: this.sessionId,
				bankId: this.bankId,
				error: String(err),
			});
		}
	}

	async forceRetainCurrentSession(): Promise<void> {
		const messages = extractMessages(this.session.sessionManager);
		if (messages.length === 0) return;
		try {
			const retained = await this.retainSession(messages);
			if (!retained) return;
			this.lastRetainedTurn = messages.filter(m => m.role === "user").length;
		} catch (err) {
			logger.warn("Hindsight: forced retain failed", {
				sessionId: this.sessionId,
				bankId: this.bankId,
				error: String(err),
			});
		}
	}

	async maybeRecallOnAgentStart(): Promise<void> {
		if (!this.config.autoRecall || this.hasRecalledForFirstTurn) return;
		const messages = extractMessages(this.session.sessionManager);
		const lastUser = messages.findLast(m => m.role === "user");
		if (!lastUser) return;

		const query = composeRecallQuery(lastUser.content, messages, this.config.recallContextTurns);
		const truncated = truncateRecallQuery(query, lastUser.content, this.config.recallMaxQueryChars);
		const { context, ok } = await this.recallForContext(truncated);
		if (!ok) return;

		this.hasRecalledForFirstTurn = true;
		if (!context) return;

		this.lastRecallSnippet = context;
	}

	async beforeAgentStartPrompt(promptText: string): Promise<string | undefined> {
		if (this.config.mentalModelsEnabled && this.mentalModelsLoadPromise && this.mentalModelsLoadedAt === undefined) {
			await Promise.race([this.mentalModelsLoadPromise, Bun.sleep(MENTAL_MODEL_FIRST_TURN_DEADLINE_MS)]);
		}

		if (!this.config.autoRecall || this.hasRecalledForFirstTurn) return undefined;

		const latestPrompt = promptText.trim();
		if (!latestPrompt) return undefined;

		const history = extractMessages(this.session.sessionManager);
		const queryMessages = [...history, { role: "user" as const, content: latestPrompt }];
		const query = composeRecallQuery(latestPrompt, queryMessages, this.config.recallContextTurns);
		const truncated = truncateRecallQuery(query, latestPrompt, this.config.recallMaxQueryChars);
		const { context, ok } = await this.recallForContext(truncated);
		if (!ok) return undefined;

		this.hasRecalledForFirstTurn = true;
		if (!context) return undefined;

		this.lastRecallSnippet = context;
		return context;
	}

	async recallForCompaction(messages: HindsightMessage[]): Promise<string | undefined> {
		const lastUser = messages.findLast(m => m.role === "user");
		if (!lastUser) return undefined;

		const query = composeRecallQuery(lastUser.content, messages, this.config.recallContextTurns);
		const truncated = truncateRecallQuery(query, lastUser.content, this.config.recallMaxQueryChars);
		const { context } = await this.recallForContext(truncated);
		return context ?? undefined;
	}

	async runMentalModelLoad(scope: BankScope): Promise<void> {
		if (!this.config.mentalModelsEnabled) return;

		// Seeding is opt-in (`hindsight.mentalModelAutoSeed`). Default behaviour is
		// read-only: we surface whatever models the operator has curated on the
		// bank, but we do NOT POST to create new ones unless they explicitly
		// asked. `/memory mm seed` remains the explicit-write entry point.
		if (this.config.mentalModelAutoSeed) {
			const seeds = resolveSeedsForScope(scope, this.config.scoping);
			if (seeds.length > 0) {
				await ensureMentalModels(this.client, this.bankId, seeds, this.config.debug);
			}
		}

		const changed = await this.refreshMentalModelsSnippet();
		if (changed) await this.#refreshBaseSystemPromptAfter("MM load");
	}

	async refreshMentalModelsSnippet(): Promise<boolean> {
		const snippet = await loadMentalModelsBlock(this.client, this.bankId, this.config.mentalModelMaxRenderChars);
		const changed = contentHash(snippet) !== contentHash(this.mentalModelsSnippet);
		this.mentalModelsSnippet = snippet;
		this.mentalModelsLoadedAt = Date.now();
		return changed;
	}

	async reloadMentalModels(): Promise<boolean> {
		if (this.aliasOf) return false;
		if (!this.config.mentalModelsEnabled) return false;
		const changed = await this.refreshMentalModelsSnippet();
		if (changed) await this.#refreshBaseSystemPromptAfter("MM reload");
		return true;
	}

	attachSessionListeners(): void {
		this.unsubscribe?.();
		this.unsubscribe = this.session.subscribe(event => {
			if (event.type === "agent_start") {
				void this.maybeRecallOnAgentStart();
			} else if (event.type === "agent_end") {
				void this.maybeRetainOnAgentEnd();
				// Drain any queued tool-initiated retain calls now that the turn
				// is settled. The queue is also debounced/size-bounded, but
				// flushing here keeps the bank fresh between turns.
				void this.flushRetainQueue();
				// MM TTL refresh: re-list once we're past the cache deadline. List
				// is cheap (no reflect call); the LLM doesn't see this happen.
				if (
					this.config.mentalModelsEnabled &&
					this.mentalModelsLoadedAt !== undefined &&
					Date.now() - this.mentalModelsLoadedAt >= this.config.mentalModelRefreshIntervalMs
				) {
					void this.refreshMentalModelsSnippet().then(async changed => {
						if (changed) await this.#refreshBaseSystemPromptAfter("MM TTL reload");
					});
				}
			}
		});
	}

	async dispose(): Promise<void> {
		this.unsubscribe?.();
		this.unsubscribe = undefined;
		await this.retainQueue.dispose();
	}

	async #refreshBaseSystemPromptAfter(reason: "MM load" | "MM reload" | "MM TTL reload"): Promise<void> {
		try {
			await this.session.refreshBaseSystemPrompt();
		} catch (err) {
			logger.debug(`Hindsight: refreshBaseSystemPrompt after ${reason} failed`, { error: String(err) });
		}
	}
}

/** Return the tail beginning with the first user turn after `retainedTurns`. */
function sliceMessagesAfterUserTurns(messages: HindsightMessage[], retainedTurns: number): HindsightMessage[] {
	if (retainedTurns <= 0) return messages;

	let seenTurns = 0;
	for (let i = 0; i < messages.length; i++) {
		if (messages[i].role !== "user") continue;
		seenTurns += 1;
		if (seenTurns > retainedTurns) return messages.slice(i);
	}
	return [];
}

function contentHash(content: string | undefined): string {
	return Bun.hash(content ?? "").toString(16);
}
