import * as crypto from "node:crypto";
import { btw, type CreateAgentSessionResult } from "@gajae-code/coding-agent/sdk";
import type { DesktopBtwConversation, DesktopBtwEvent, DesktopBtwTurn } from "./btw-protocol";

const ERRORS = {
	invalid_request: "Invalid side-chat request.",
	not_found: "The side conversation or turn is no longer available.",
	control_busy: "A side turn or session lifecycle operation is already in progress.",
	disposed: "Side-chat controls have been disposed.",
	stale_session: "The session has changed; reopen side-chat controls.",
	backend_failure: "The side-chat request failed; provider cleanup may be incomplete.",
	redaction_failed: "Side-chat redaction failed; output was withheld.",
} as const;

type ErrorCode = keyof typeof ERRORS;
type Session = CreateAgentSessionResult["session"];
interface StreamRedactor {
	push(chunk: string): string;
	finish(): string;
}

export class DesktopBtwError extends Error {
	constructor(readonly code: ErrorCode) {
		super(ERRORS[code]);
		this.name = "DesktopBtwError";
	}
}

export interface DesktopBtwOptions {
	redact: (text: string) => string;
	emit: (event: DesktopBtwEvent) => void;
	createStreamRedactor?: () => StreamRedactor;
}

interface ActiveTurn {
	dto: DesktopBtwTurn;
	capture: btw.BtwTurnCapture;
	context: btw.BtwTextExchange[];
	abort: AbortController;
	redactor?: StreamRedactor;
	pendingUnicode: string;
	observedBytes: number;
	redactionFailed: boolean;
}

interface Conversation {
	dto: DesktopBtwConversation;
	scope: btw.BtwConversationScope | undefined;
	exchanges: btw.BtwTextExchange[];
	active?: ActiveTurn;
}

/** Inspect descriptors, not values: transport objects cannot invoke accessors or inherit authority. */
function fields(value: unknown, keys: readonly string[]): Record<string, string> {
	try {
		if (!value || typeof value !== "object" || Array.isArray(value)) throw new DesktopBtwError("invalid_request");
		const prototype: unknown = Object.getPrototypeOf(value);
		if (prototype !== Object.prototype && prototype !== null) throw new DesktopBtwError("invalid_request");
		const ownKeys = Reflect.ownKeys(value);
		if (ownKeys.length !== keys.length || ownKeys.some(key => typeof key !== "string" || !keys.includes(key)))
			throw new DesktopBtwError("invalid_request");
		const result: Record<string, string> = Object.create(null);
		for (const key of keys) {
			const descriptor = Object.getOwnPropertyDescriptor(value, key);
			if (!descriptor || !("value" in descriptor) || typeof descriptor.value !== "string")
				throw new DesktopBtwError("invalid_request");
			result[key] = descriptor.value;
		}
		return result;
	} catch {
		throw new DesktopBtwError("invalid_request");
	}
}

function question(value: string | undefined): string {
	if (
		value === undefined ||
		!value.trim() ||
		!value.isWellFormed() ||
		btw.utf8ByteLength(value) > btw.BTW_MAX_QUESTION_UTF8_BYTES
	)
		throw new DesktopBtwError("invalid_request");
	return value;
}

function id(value: string | undefined): string {
	if (value === undefined || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value))
		throw new DesktopBtwError("invalid_request");
	return value;
}

function copy(dto: DesktopBtwConversation): DesktopBtwConversation {
	return {
		conversationId: dto.conversationId,
		sessionGeneration: dto.sessionGeneration,
		revision: dto.revision,
		turns: dto.turns.map(turn => ({ ...turn, ...(turn.error ? { error: { ...turn.error } } : {}) })),
	};
}

/** A connection-local text projection. The SDK, never this adapter, owns provider execution. */
export class DesktopBtwController {
	readonly #session: Session;
	readonly #generation: number;
	readonly #sessionId: string;
	readonly #manager: Session["sessionManager"];
	readonly #managerSessionId: string;
	readonly #options: DesktopBtwOptions;
	readonly #unsubscribers: Array<() => void> = [];
	#conversation: Conversation | undefined;
	#disposed = false;
	#stale = false;
	#controlling = false;
	#calling = false;

	constructor(session: Session, options: DesktopBtwOptions) {
		this.#session = session;
		this.#options = { ...options };
		this.#generation = session.sessionLifecycle.generation;
		this.#sessionId = session.sessionId;
		this.#manager = session.sessionManager;
		this.#managerSessionId = this.#manager.getSessionId();
		this.#assertLive();
		try {
			this.#unsubscribers.push(session.registerToolSessionCleanup(() => this.dispose()));
			this.#unsubscribers.push(session.registerToolSessionTransitionCleanup(() => this.#clear(true)));
			this.#assertLive();
		} catch {
			this.dispose();
			throw new DesktopBtwError("backend_failure");
		}
	}

	#assertLive(): void {
		const lifecycle = this.#session.sessionLifecycle;
		if (this.#disposed || lifecycle.disposed || this.#session.isDisposed) {
			this.dispose();
			throw new DesktopBtwError("disposed");
		}
		if (lifecycle.generation !== this.#generation) this.#stale = true;
		// Preparation can stage identities temporarily, but grants no control authority.
		if (lifecycle.transitioning) throw new DesktopBtwError("control_busy");
		if (
			this.#session.sessionManager !== this.#manager ||
			this.#session.sessionId !== this.#sessionId ||
			this.#manager.getSessionId() !== this.#managerSessionId
		)
			this.#stale = true;
		if (this.#stale) {
			this.#clear(false);
			throw new DesktopBtwError("stale_session");
		}
	}

	#control<T>(action: () => T): T {
		if (this.#controlling || this.#calling) throw new DesktopBtwError("control_busy");
		this.#controlling = true;
		try {
			this.#assertLive();
			const result = action();
			this.#assertLive();
			return result;
		} catch (error) {
			if (error instanceof DesktopBtwError) throw error;
			throw new DesktopBtwError("backend_failure");
		} finally {
			this.#controlling = false;
		}
	}

	#external<T>(action: () => T): T {
		if (this.#calling) throw new DesktopBtwError("redaction_failed");
		this.#calling = true;
		try {
			return action();
		} finally {
			this.#calling = false;
		}
	}

	#redact(text: string): string {
		try {
			const result: unknown = this.#external(() => this.#options.redact(text));
			if (typeof result !== "string") throw new DesktopBtwError("redaction_failed");
			return result.toWellFormed();
		} catch {
			throw new DesktopBtwError("redaction_failed");
		}
	}

	#stream(): StreamRedactor | undefined {
		const factory = this.#options.createStreamRedactor;
		if (!factory) return undefined;
		try {
			return this.#external(() => {
				const stream = factory();
				if (!stream || typeof stream.push !== "function" || typeof stream.finish !== "function")
					throw new DesktopBtwError("redaction_failed");
				return stream;
			});
		} catch {
			throw new DesktopBtwError("redaction_failed");
		}
	}

	#streamText(action: () => string): string {
		try {
			const result: unknown = this.#external(action);
			if (typeof result !== "string") throw new DesktopBtwError("redaction_failed");
			return result;
		} catch {
			throw new DesktopBtwError("redaction_failed");
		}
	}

	#current(conversation: Conversation, active?: ActiveTurn): boolean {
		try {
			this.#assertLive();
		} catch {
			if (this.#conversation === conversation) this.#clear(false);
			return false;
		}
		return this.#conversation === conversation && (!active || conversation.active === active);
	}

	#emit(conversation: Conversation): void {
		if (!this.#current(conversation)) return;
		const event: DesktopBtwEvent = { conversation: copy(conversation.dto) };
		try {
			this.#external(() => this.#options.emit(event));
		} catch {
			/* A transport observer cannot break SDK cleanup or side-turn settlement. */
		}
	}

	#changed(conversation: Conversation): void {
		if (!this.#current(conversation)) return;
		this.#bound(conversation);
		conversation.dto.revision++;
		this.#emit(conversation);
	}

	#bound(conversation: Conversation): void {
		const turns = conversation.dto.turns;
		let bytes = turns.reduce(
			(total, turn) => total + btw.utf8ByteLength(turn.question) + btw.utf8ByteLength(turn.answer),
			0,
		);
		while (turns.length > 1 && (turns.length > btw.BTW_MAX_CONTEXT_TURNS || bytes > btw.BTW_MAX_CONTEXT_UTF8_BYTES)) {
			const removed = turns.shift()!;
			bytes -= btw.utf8ByteLength(removed.question) + btw.utf8ByteLength(removed.answer);
		}
	}

	#resolve(conversationId: string): Conversation {
		const conversation = this.#conversation;
		if (!conversation || conversation.dto.conversationId !== conversationId) throw new DesktopBtwError("not_found");
		return conversation;
	}

	open(value: unknown): DesktopBtwConversation {
		return this.#control(() => {
			const rawQuestion = question(fields(value, ["question"]).question);
			if (this.#conversation) throw new DesktopBtwError("control_busy");
			const safeQuestion = btw.truncateUtf8(this.#redact(rawQuestion), btw.BTW_MAX_QUESTION_UTF8_BYTES);
			this.#assertLive();
			const scope = this.#session.createBtwConversationScope(btw.instruction);
			this.#assertLive();
			const conversation: Conversation = {
				dto: { conversationId: crypto.randomUUID(), sessionGeneration: this.#generation, revision: 0, turns: [] },
				scope,
				exchanges: [],
			};
			this.#conversation = conversation;
			return this.#admit(conversation, rawQuestion, safeQuestion);
		});
	}

	submit(value: unknown): DesktopBtwConversation {
		return this.#control(() => {
			const parsed = fields(value, ["conversationId", "question"]);
			const conversation = this.#resolve(id(parsed.conversationId));
			const rawQuestion = question(parsed.question);
			if (conversation.active) throw new DesktopBtwError("control_busy");
			const safeQuestion = btw.truncateUtf8(this.#redact(rawQuestion), btw.BTW_MAX_QUESTION_UTF8_BYTES);
			this.#assertLive();
			if (this.#conversation !== conversation) throw new DesktopBtwError("not_found");
			return this.#admit(conversation, rawQuestion, safeQuestion);
		});
	}

	#admit(conversation: Conversation, rawQuestion: string, safeQuestion: string): DesktopBtwConversation {
		const dto: DesktopBtwTurn = {
			turnId: crypto.randomUUID(),
			question: safeQuestion,
			answer: "",
			status: "running",
			answerTruncated: false,
		};
		const active: ActiveTurn = {
			dto,
			capture: { question: rawQuestion, scope: conversation.scope },
			context: btw.boundBtwExchanges(conversation.exchanges),
			abort: new AbortController(),
			pendingUnicode: "",
			observedBytes: 0,
			redactionFailed: false,
		};
		conversation.active = active;
		conversation.dto.turns.push(dto);
		this.#bound(conversation);
		conversation.dto.revision++;
		const admitted = copy(conversation.dto);
		queueMicrotask(() => {
			void this.#execute(conversation, active);
		});
		return admitted;
	}

	get(): DesktopBtwConversation | null {
		return this.#control(() => (this.#conversation ? copy(this.#conversation.dto) : null));
	}

	cancel(value: unknown): DesktopBtwConversation {
		return this.#control(() => {
			const parsed = fields(value, ["conversationId", "turnId"]);
			const conversation = this.#resolve(id(parsed.conversationId));
			const turnId = id(parsed.turnId);
			const active = conversation.active;
			if (!active || active.dto.turnId !== turnId) throw new DesktopBtwError("not_found");
			if (active.dto.status === "running") {
				active.dto.status = "cancel_requested";
				active.abort.abort();
				this.#changed(conversation);
			}
			return copy(conversation.dto);
		});
	}

	close(value: unknown): void {
		this.#control(() => {
			this.#resolve(id(fields(value, ["conversationId"]).conversationId));
			this.#clear(true);
		});
	}

	#append(active: ActiveTurn, chunk: string): void {
		let safe = active.pendingUnicode + chunk;
		active.pendingUnicode = "";
		const last = safe.charCodeAt(safe.length - 1);
		if (last >= 0xd800 && last <= 0xdbff) {
			active.pendingUnicode = safe.slice(-1);
			safe = safe.slice(0, -1);
		}
		safe = safe.toWellFormed();
		const combined = active.dto.answer + safe;
		const bounded = btw.truncateUtf8(combined, btw.BTW_MAX_ANSWER_UTF8_BYTES);
		active.dto.answerTruncated ||= bounded !== combined;
		active.dto.answer = bounded;
	}

	#delta(conversation: Conversation, active: ActiveTurn, chunk: string): void {
		if (!this.#current(conversation, active) || active.dto.status !== "running") return;
		try {
			if (typeof chunk !== "string") throw new DesktopBtwError("backend_failure");
			active.observedBytes = Math.min(
				btw.BTW_MAX_ANSWER_UTF8_BYTES,
				active.observedBytes + btw.utf8ByteLength(chunk),
			);
			// Without a boundary-aware redactor, even the first chunk of a secret is withheld.
			const stream = active.redactor;
			if (!stream) return;
			const safe = this.#streamText(() => stream.push(chunk));
			if (!this.#current(conversation, active) || active.dto.status !== "running") return;
			this.#append(active, safe);
			this.#changed(conversation);
		} catch (error) {
			if (!this.#current(conversation, active)) return;
			this.#fail(active, error instanceof DesktopBtwError ? error.code : "redaction_failed");
			active.abort.abort();
			this.#changed(conversation);
		}
	}

	#fail(active: ActiveTurn, code: ErrorCode): void {
		active.redactionFailed ||= code === "redaction_failed";
		active.dto.answer = "";
		active.dto.answerTruncated = false;
		active.dto.status = "failed";
		active.dto.error = { code, message: ERRORS[code] };
		active.pendingUnicode = "";
		active.redactor = undefined;
	}

	async #execute(conversation: Conversation, active: ActiveTurn): Promise<void> {
		try {
			if (!this.#current(conversation, active)) return;
			this.#emit(conversation);
			if (!this.#current(conversation, active)) return;
			if (active.abort.signal.aborted) {
				active.dto.status = "cancelled";
				return;
			}
			active.redactor = this.#stream();
			if (!this.#current(conversation, active)) return;
			const result = await this.#session.runEphemeralTurn({
				purpose: "btw",
				turn: active.capture,
				contextExchanges: active.context,
				signal: active.abort.signal,
				onTextDelta: chunk => this.#delta(conversation, active, chunk),
			});
			if (!this.#current(conversation, active) || active.dto.status === "failed") return;
			if (active.abort.signal.aborted) {
				active.dto.status = "cancelled";
				return;
			}
			if (typeof result.replyText !== "string") throw new DesktopBtwError("backend_failure");
			let safe: string;
			if (active.redactor) {
				const stream = active.redactor;
				this.#streamText(() => stream.finish());
				if (!this.#current(conversation, active) || active.dto.status !== "running") return;
				// Replay the authoritative final text through a fresh boundary-aware policy.
				// The final SDK text can differ from deltas (for example, whitespace trimming).
				const finalStream = this.#stream();
				if (!this.#current(conversation, active) || active.dto.status !== "running") return;
				if (!finalStream) throw new DesktopBtwError("redaction_failed");
				safe = this.#streamText(() => finalStream.push(result.replyText));
				if (!this.#current(conversation, active) || active.dto.status !== "running") return;
				safe += this.#streamText(() => finalStream.finish());
				safe = safe.toWellFormed();
			} else safe = this.#redact(result.replyText);
			if (!this.#current(conversation, active) || active.dto.status !== "running") return;
			const answer = btw.truncateUtf8(safe, btw.BTW_MAX_ANSWER_UTF8_BYTES);
			active.dto.answer = answer;
			// SDK text is itself bounded; reaching its ceiling cannot certify untruncated output.
			active.dto.answerTruncated ||=
				answer !== safe ||
				active.observedBytes >= btw.BTW_MAX_ANSWER_UTF8_BYTES ||
				btw.utf8ByteLength(result.replyText) >= btw.BTW_MAX_ANSWER_UTF8_BYTES;
			active.dto.status = "completed";
			conversation.exchanges = btw.boundBtwExchanges([
				...conversation.exchanges,
				{ question: active.capture.question, answer: result.replyText },
			]);
		} catch (error) {
			if (!this.#current(conversation, active)) return;
			if (active.dto.status === "failed") return;
			if (active.abort.signal.aborted && !active.redactionFailed) active.dto.status = "cancelled";
			else this.#fail(active, error instanceof DesktopBtwError ? error.code : "backend_failure");
		} finally {
			const current = this.#current(conversation, active);
			active.capture.scope = undefined;
			active.capture.question = "";
			active.context.length = 0;
			active.redactor = undefined;
			active.pendingUnicode = "";
			if (current) {
				conversation.active = undefined;
				this.#changed(conversation);
			}
		}
	}

	#clear(notify: boolean): void {
		const conversation = this.#conversation;
		this.#conversation = undefined;
		if (!conversation) return;
		conversation.scope = undefined;
		conversation.exchanges = [];
		conversation.dto.turns = [];
		const active = conversation.active;
		conversation.active = undefined;
		if (active) {
			active.capture.scope = undefined;
			active.capture.question = "";
			active.context.length = 0;
			active.redactor = undefined;
			active.pendingUnicode = "";
			active.dto.question = "";
			active.dto.answer = "";
			active.abort.abort();
		}
		if (notify) {
			if (this.#calling) queueMicrotask(() => this.#emitCleared());
			else this.#emitCleared();
		}
	}

	#emitCleared(): void {
		// A deferred invalidation must not hide an already-open replacement.
		if (this.#conversation) return;
		try {
			this.#external(() => this.#options.emit({ conversation: null }));
		} catch {
			/* Null invalidation is best-effort; all authority is already scrubbed. */
		}
	}

	dispose(): void {
		if (this.#disposed) return;
		this.#disposed = true;
		this.#clear(true);
		for (const unsubscribe of this.#unsubscribers.splice(0)) {
			try {
				unsubscribe();
			} catch {
				/* Detach every registered lifecycle hook. */
			}
		}
	}
}

export function createDesktopBtwController(session: Session, options: DesktopBtwOptions): DesktopBtwController {
	return new DesktopBtwController(session, options);
}
