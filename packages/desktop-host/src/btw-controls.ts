import {
	btw,
	type CreateAgentSessionResult,
	SdkSideConversationError,
	SideConversationControls,
	type SideConversationSnapshot,
} from "@gajae-code/coding-agent/sdk";
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

/** Transport objects cannot invoke accessors or inherit authority. */
function fields(value: unknown, keys: readonly string[]): Record<string, string> {
	try {
		if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error();
		const prototype: unknown = Object.getPrototypeOf(value);
		if (prototype !== Object.prototype && prototype !== null) throw new Error();
		const ownKeys = Reflect.ownKeys(value);
		if (ownKeys.length !== keys.length || ownKeys.some(key => typeof key !== "string" || !keys.includes(key)))
			throw new Error();
		const result: Record<string, string> = Object.create(null);
		for (const key of keys) {
			const descriptor = Object.getOwnPropertyDescriptor(value, key);
			if (!descriptor || !("value" in descriptor) || typeof descriptor.value !== "string") throw new Error();
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
	return { ...dto, turns: dto.turns.map(turn => ({ ...turn, ...(turn.error ? { error: { ...turn.error } } : {}) })) };
}

/** Wire/privacy projection only. The SDK owns frozen context, history, turn refs and cleanup. */
export class DesktopBtwController {
	readonly #session: Session;
	readonly #sdk: SideConversationControls;
	readonly #options: DesktopBtwOptions;
	readonly #unsubscribers: Array<() => void> = [];
	#conversation: DesktopBtwConversation | undefined;
	#disposed = false;
	#stale = false;
	#controlling = false;
	#calling = false;
	#watching = false;
	#privacyFailed = false;
	#published: string | undefined;
	readonly #cancelRequested = new Set<string>();

	constructor(session: Session, options: DesktopBtwOptions) {
		this.#session = session;
		this.#options = { ...options };
		this.#live();
		this.#sdk = new SideConversationControls(session);
		this.#unsubscribers.push(session.registerToolSessionCleanup(() => this.dispose()));
		this.#unsubscribers.push(
			session.registerToolSessionTransitionCleanup(() => {
				this.#stale = true;
				this.#clear();
			}),
		);
	}

	#live(): void {
		if (this.#disposed || this.#session.sessionLifecycle.disposed) throw new DesktopBtwError("disposed");
		if (this.#stale) throw new DesktopBtwError("stale_session");
		if (this.#session.sessionLifecycle.transitioning) throw new DesktopBtwError("control_busy");
	}

	#map(error: unknown): DesktopBtwError {
		if (error instanceof DesktopBtwError) return error;
		if (error instanceof SdkSideConversationError) {
			switch (error.code) {
				case "invalid_input":
					return new DesktopBtwError("invalid_request");
				case "resource_gone":
					return new DesktopBtwError("not_found");
				case "busy":
					return new DesktopBtwError("control_busy");
				case "redaction_failed":
					return new DesktopBtwError("redaction_failed");
				case "stale_session":
					return new DesktopBtwError("stale_session");
				case "unknown_effect":
					return new DesktopBtwError("backend_failure");
			}
		}
		return new DesktopBtwError("backend_failure");
	}

	#control<T>(action: () => T): T {
		if (this.#controlling || this.#calling) throw new DesktopBtwError("control_busy");
		this.#controlling = true;
		try {
			this.#live();
			const result = action();
			this.#live();
			return result;
		} catch (error) {
			this.#live();
			throw this.#map(error);
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

	#text(text: string): string {
		try {
			const safe: unknown = this.#external(() => this.#options.redact(text));
			if (typeof safe !== "string") throw new Error();
			return safe.toWellFormed();
		} catch {
			throw new DesktopBtwError("redaction_failed");
		}
	}

	#answer(text: string, settled: boolean): string {
		if (!this.#options.createStreamRedactor) return settled ? this.#text(text) : "";
		try {
			// Replaying the SDK's bounded safe snapshot avoids owning a second delta/context buffer.
			const safe = this.#external(() => {
				const stream = this.#options.createStreamRedactor!();
				if (!stream || typeof stream.push !== "function" || typeof stream.finish !== "function") throw new Error();
				const head: unknown = stream.push(text);
				const tail: unknown = settled ? stream.finish() : "";
				if (typeof head !== "string" || typeof tail !== "string") throw new Error();
				return head + tail;
			});
			return this.#text(safe);
		} catch {
			throw new DesktopBtwError("redaction_failed");
		}
	}

	#snapshot(result: SideConversationSnapshot | { closed: true }): SideConversationSnapshot {
		if (!("id" in result)) throw new DesktopBtwError("backend_failure");
		return result;
	}

	#project(snapshot: SideConversationSnapshot): DesktopBtwConversation {
		const retained = new Set(snapshot.turns.map(turn => turn.id));
		for (const turnId of this.#cancelRequested) if (!retained.has(turnId)) this.#cancelRequested.delete(turnId);
		const turns: DesktopBtwTurn[] = snapshot.turns.map(turn => {
			const pending = turn.cleanup === "pending";
			if (!pending) this.#cancelRequested.delete(turn.id);
			const failed =
				turn.status === "failed" || turn.status === "unknown_effect" || turn.cleanup === "unknown_effect";
			// A provider's terminal reply/cancel acknowledgement is not its cleanup barrier.
			const status: DesktopBtwTurn["status"] = pending
				? this.#cancelRequested.has(turn.id)
					? "cancel_requested"
					: "running"
				: failed
					? "failed"
					: turn.status === "cancelled"
						? "cancelled"
						: turn.status === "completed"
							? "completed"
							: "running";
			// Native answers are bounded before this host-only overlay. At the byte
			// ceiling a cut-through host secret cannot be proven safe.
			const atCeiling = btw.utf8ByteLength(turn.answer) >= btw.BTW_MAX_ANSWER_UTF8_BYTES - 3;
			const safe = failed || atCeiling ? "" : this.#answer(turn.answer, !pending && turn.cleanup === "settled");
			return {
				turnId: turn.id,
				question: btw.truncateUtf8(this.#text(turn.question), btw.BTW_MAX_QUESTION_UTF8_BYTES),
				answer: btw.truncateUtf8(safe, btw.BTW_MAX_ANSWER_UTF8_BYTES),
				status,
				cleanup: turn.cleanup,
				// SDK bounds its answer but does not expose a truncation bit. The ceiling is conservative evidence only.
				answerTruncated: safe !== btw.truncateUtf8(safe, btw.BTW_MAX_ANSWER_UTF8_BYTES) || atCeiling,
				...(failed ? { error: { code: "backend_failure", message: ERRORS.backend_failure } } : {}),
			};
		});
		this.#live();
		return {
			conversationId: snapshot.id,
			sessionGeneration: snapshot.generation,
			revision: snapshot.revision,
			turns,
		};
	}

	#emit(): void {
		if (this.#disposed && this.#conversation) return;
		const event: DesktopBtwEvent = { conversation: this.#conversation ? copy(this.#conversation) : null };
		const published = JSON.stringify(event);
		if (this.#published === published) return;
		this.#published = published;
		try {
			this.#external(() => this.#options.emit(event));
		} catch {
			/* Transport observers cannot affect native cleanup. */
		}
	}

	#resolve(conversationId: string): DesktopBtwConversation {
		if (!this.#conversation || this.#conversation.conversationId !== conversationId)
			throw new DesktopBtwError("not_found");
		return this.#conversation;
	}

	#read(): void {
		const conversation = this.#conversation;
		if (!conversation || this.#privacyFailed) return;
		const snapshot = this.#snapshot(this.#sdk.control("btw.read", { conversationId: conversation.conversationId }));
		try {
			const projected = this.#project(snapshot);
			if (this.#conversation === conversation) this.#conversation = projected;
		} catch (error) {
			if (!(error instanceof DesktopBtwError) || error.code !== "redaction_failed") throw error;
			// Do not retain successful native follow-up history after a host policy failure.
			this.#sdk.control("btw.close", { conversationId: conversation.conversationId });
			this.#privacyFailed = true;
			conversation.turns = snapshot.turns.map(turn => ({
				turnId: turn.id,
				question: conversation.turns.find(previous => previous.turnId === turn.id)?.question ?? "",
				answer: "",
				answerTruncated: false,
				status: "failed",
				cleanup: turn.cleanup === "settled" ? "settled" : "unknown_effect",
				error: { code: "redaction_failed", message: ERRORS.redaction_failed },
			}));
			conversation.revision++;
		}
	}

	async #watch(): Promise<void> {
		if (this.#watching) return;
		this.#watching = true;
		try {
			while (!this.#disposed && !this.#stale && this.#conversation && !this.#privacyFailed) {
				await Bun.sleep(25);
				if (this.#disposed || this.#stale || !this.#conversation) return;
				try {
					this.#read();
					this.#emit();
					if (!this.#conversation?.turns.some(turn => turn.cleanup === "pending")) return;
				} catch (error) {
					if (
						(error instanceof SdkSideConversationError && error.code === "busy") ||
						(error instanceof DesktopBtwError && error.code === "control_busy")
					)
						continue;
					this.#stale = true;
					this.#clear();
					return;
				}
			}
		} finally {
			this.#watching = false;
		}
	}

	open(value: unknown): DesktopBtwConversation {
		return this.#control(() => {
			const raw = question(fields(value, ["question"]).question);
			if (this.#conversation && !this.#privacyFailed) throw new DesktopBtwError("control_busy");
			if (this.#privacyFailed) this.#clear();
			this.#text(raw);
			this.#answer("", false);
			this.#live();
			const snapshot = this.#snapshot(this.#sdk.control("btw.open", { question: raw }));
			this.#conversation = {
				conversationId: snapshot.id,
				sessionGeneration: snapshot.generation,
				revision: snapshot.revision,
				turns: [],
			};
			this.#privacyFailed = false;
			this.#read();
			void this.#watch();
			return copy(this.#conversation);
		});
	}

	submit(value: unknown): DesktopBtwConversation {
		return this.#control(() => {
			const parsed = fields(value, ["conversationId", "question"]);
			const conversation = this.#resolve(id(parsed.conversationId));
			if (this.#privacyFailed) throw new DesktopBtwError("redaction_failed");
			const raw = question(parsed.question);
			this.#text(raw);
			this.#live();
			this.#sdk.control("btw.submit", { conversationId: conversation.conversationId, question: raw });
			this.#read();
			void this.#watch();
			return copy(this.#conversation!);
		});
	}

	get(): DesktopBtwConversation | null {
		return this.#control(() => {
			this.#read();
			return this.#conversation ? copy(this.#conversation) : null;
		});
	}

	cancel(value: unknown): DesktopBtwConversation {
		return this.#control(() => {
			const parsed = fields(value, ["conversationId", "turnId"]);
			const conversation = this.#resolve(id(parsed.conversationId));
			const turnId = id(parsed.turnId);
			if (this.#privacyFailed) throw new DesktopBtwError("not_found");
			this.#sdk.control("btw.cancel", { conversationId: conversation.conversationId, turnId });
			this.#cancelRequested.add(turnId);
			this.#read();
			this.#emit();
			void this.#watch();
			return copy(this.#conversation!);
		});
	}

	close(value: unknown): void {
		this.#control(() => {
			const conversation = this.#resolve(id(fields(value, ["conversationId"]).conversationId));
			if (!this.#privacyFailed) this.#sdk.control("btw.close", { conversationId: conversation.conversationId });
			this.#clear();
		});
	}

	#clear(): void {
		this.#conversation = undefined;
		this.#cancelRequested.clear();
		this.#privacyFailed = false;
		if (this.#calling)
			queueMicrotask(() => {
				if (!this.#conversation) this.#emit();
			});
		else this.#emit();
	}

	dispose(): void {
		if (this.#disposed) return;
		this.#disposed = true;
		this.#sdk.dispose();
		this.#clear();
		for (const unsubscribe of this.#unsubscribers.splice(0)) unsubscribe();
	}
}

export function createDesktopBtwController(session: Session, options: DesktopBtwOptions): DesktopBtwController {
	return new DesktopBtwController(session, options);
}
