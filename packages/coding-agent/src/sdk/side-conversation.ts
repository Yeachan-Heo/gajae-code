import { randomUUID } from "node:crypto";
import btwUserPrompt from "../prompts/system/btw-user.md" with { type: "text" };
import type { AgentSession, BtwConversationScope } from "../session/agent-session";
import {
	BTW_MAX_ANSWER_UTF8_BYTES,
	BTW_MAX_CONTEXT_TURNS,
	BTW_MAX_CONTEXT_UTF8_BYTES,
	BTW_MAX_QUESTION_UTF8_BYTES,
	type BtwTextExchange,
	boundBtwExchanges,
	truncateUtf8,
	utf8ByteLength,
} from "../session/btw-contract";

export {
	isSideConversationOperation,
	SIDE_CONVERSATION_MUTATIONS,
	SIDE_CONVERSATION_QUERIES,
	type SideConversationOperation,
} from "./protocol/client-control-contracts";

import type { SideConversationOperation } from "./protocol/client-control-contracts";
export const SIDE_CONVERSATION_MAX_DELTA_CHUNKS = 256;
export const SIDE_CONVERSATION_MAX_DELTA_CHARS = 32 * 1024;
export interface SideConversationTurn {
	id: string;
	question: string;
	answer: string;
	status: "running" | "completed" | "cancelled" | "failed";
}
export interface SideConversationDelta {
	turnId: string;
	text: string;
	cursor: string;
}
export interface SideConversationSnapshot {
	id: string;
	generation: number;
	revision: number;
	turns: SideConversationTurn[];
	deltas: SideConversationDelta[];
	nextCursor: string;
	deltasTruncated: boolean;
}
interface ActiveTurn {
	turn: SideConversationTurn;
	abort: AbortController;
}
interface Conversation {
	dto: Omit<SideConversationSnapshot, "deltas" | "nextCursor" | "deltasTruncated">;
	scope: BtwConversationScope | undefined;
	exchanges: BtwTextExchange[];
	active?: ActiveTurn;
	deltas: Array<{ sequence: number; turnId: string; text: string }>;
	deltaChars: number;
	sequence: number;
	droppedThrough: number;
}
// A service can retire while its public turn has settled but provider cleanup has not.
// Keep admission on the session itself, across replacement control services.
const sideTurnOwners = new WeakMap<AgentSession, ActiveTurn>();

function fail(code: string, message: string): never {
	throw Object.assign(new Error(message), { code });
}
function fields(input: Record<string, unknown>, required: readonly string[], optional: readonly string[] = []): void {
	if (Object.keys(input).some(key => !required.includes(key) && !optional.includes(key)))
		fail("invalid_input", "Unknown side conversation field.");
	for (const key of required)
		if (typeof input[key] !== "string" || !input[key]) fail("invalid_input", `Missing ${key}.`);
}

/** Session-owned frozen context and bounded history. No main transcript or turn is mutated. */
export class SideConversationControls {
	readonly #session: AgentSession;
	readonly #generation: number;
	readonly #sessionId: string;
	readonly #manager: AgentSession["sessionManager"];
	readonly #identity: number;
	readonly #cleanup: Array<() => void> = [];
	#conversation?: Conversation;
	#disposed = false;
	constructor(session: AgentSession) {
		this.#session = session;
		this.#generation = session.sessionLifecycle.generation;
		this.#sessionId = session.sessionId;
		this.#manager = session.sessionManager;
		this.#identity = this.#manager.getSessionIdentityGeneration();
		this.#cleanup.push(session.registerToolSessionCleanup(() => this.dispose()));
		this.#cleanup.push(session.registerToolSessionTransitionCleanup(() => this.dispose()));
	}
	#retired(): boolean {
		const lifecycle = this.#session.sessionLifecycle;
		return (
			this.#disposed ||
			lifecycle.disposed ||
			lifecycle.generation !== this.#generation ||
			this.#session.sessionId !== this.#sessionId ||
			this.#session.sessionManager !== this.#manager ||
			this.#manager.getSessionIdentityGeneration() !== this.#identity
		);
	}
	#live(): void {
		if (this.#retired()) fail("resource_gone", "Side conversation owner has retired.");
		if (this.#session.sessionLifecycle.transitioning) fail("busy", "Session lifecycle is changing.");
	}
	#resolve(input: Record<string, unknown>): Conversation {
		this.#live();
		const conversation = this.#conversation;
		if (!conversation || conversation.dto.id !== input.conversationId)
			fail("resource_gone", "Side conversation is no longer available.");
		return conversation;
	}
	#cursor(conversation: Conversation, sequence: number): string {
		return `${conversation.dto.id}:${sequence}`;
	}
	#copy(conversation: Conversation, cursor?: unknown): SideConversationSnapshot {
		let after = conversation.droppedThrough;
		if (cursor !== undefined) {
			if (
				typeof cursor !== "string" ||
				!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}:(0|[1-9][0-9]*)$/.test(cursor)
			)
				fail("invalid_input", "Malformed side conversation cursor.");
			const separator = cursor.lastIndexOf(":");
			if (cursor.slice(0, separator) !== conversation.dto.id)
				fail("resource_gone", "Side conversation cursor belongs to another conversation.");
			after = Number(cursor.slice(separator + 1));
			if (!Number.isSafeInteger(after) || after > conversation.sequence)
				fail("invalid_input", "Side conversation cursor is ahead of the stream.");
			if (after < conversation.droppedThrough)
				fail("resource_gone", "Side conversation cursor has expired; omit cursor to recover the snapshot.");
		}
		return {
			...structuredClone(conversation.dto),
			deltas: conversation.deltas
				.filter(delta => delta.sequence > after)
				.map(delta => ({
					turnId: delta.turnId,
					text: delta.text,
					cursor: this.#cursor(conversation, delta.sequence),
				})),
			nextCursor: this.#cursor(conversation, conversation.sequence),
			deltasTruncated: cursor === undefined && conversation.droppedThrough > 0,
		};
	}
	#dropDelta(conversation: Conversation): void {
		const delta = conversation.deltas.shift();
		if (!delta) return;
		conversation.deltaChars -= delta.text.length;
		conversation.droppedThrough = delta.sequence;
	}
	#bound(conversation: Conversation): void {
		const turns = conversation.dto.turns;
		let bytes = turns.reduce((sum, turn) => sum + utf8ByteLength(turn.question) + utf8ByteLength(turn.answer), 0);
		while (turns.length > 1 && (turns.length > BTW_MAX_CONTEXT_TURNS || bytes > BTW_MAX_CONTEXT_UTF8_BYTES)) {
			const turn = turns.shift()!;
			bytes -= utf8ByteLength(turn.question) + utf8ByteLength(turn.answer);
			while (conversation.deltas[0]?.turnId === turn.id) this.#dropDelta(conversation);
		}
		while (
			conversation.deltas.length > SIDE_CONVERSATION_MAX_DELTA_CHUNKS ||
			conversation.deltaChars > SIDE_CONVERSATION_MAX_DELTA_CHARS
		)
			this.#dropDelta(conversation);
	}
	#current(conversation: Conversation, active: ActiveTurn): boolean {
		try {
			this.#live();
		} catch {
			return false;
		}
		return this.#conversation === conversation && conversation.active === active;
	}
	#releaseScope(conversation: Conversation): void {
		if (conversation.scope) this.#session.releaseBtwConversationScope(conversation.scope);
		conversation.scope = undefined;
	}
	async #run(conversation: Conversation, active: ActiveTurn): Promise<void> {
		const turn = active.turn;
		try {
			const result = await this.#session.runEphemeralTurn({
				purpose: "btw",
				turn: { question: turn.question, scope: conversation.scope },
				contextExchanges: structuredClone(conversation.exchanges),
				signal: active.abort.signal,
				onTextDelta: text => {
					if (!this.#current(conversation, active) || active.abort.signal.aborted) return;
					const answer = truncateUtf8(turn.answer + text, BTW_MAX_ANSWER_UTF8_BYTES);
					const delta = answer.slice(turn.answer.length);
					if (!delta) return;
					turn.answer = answer;
					conversation.deltas.push({ sequence: ++conversation.sequence, turnId: turn.id, text: delta });
					conversation.deltaChars += delta.length;
					conversation.dto.revision++;
					this.#bound(conversation);
				},
			});
			if (this.#current(conversation, active)) {
				turn.status = active.abort.signal.aborted ? "cancelled" : "completed";
				if (turn.status === "completed") {
					turn.answer = truncateUtf8(result.replyText, BTW_MAX_ANSWER_UTF8_BYTES);
				}
				conversation.dto.revision++;
				this.#bound(conversation);
			}
		} catch {
			if (this.#current(conversation, active)) {
				turn.status = active.abort.signal.aborted ? "cancelled" : "failed";
				conversation.dto.revision++;
			}
		} finally {
			// runEphemeralTurn has a bounded cancellation join. Only this actual owner
			// barrier certifies that no retained preflight/iterator work can overlap a retry.
			try {
				await this.#session.joinBtwTurnsForControl();
			} catch {
				if (this.#current(conversation, active)) {
					turn.status = active.abort.signal.aborted ? "cancelled" : "failed";
					conversation.dto.revision++;
				}
			}
			if (sideTurnOwners.get(this.#session) === active) sideTurnOwners.delete(this.#session);
			const current = this.#current(conversation, active);
			if (conversation.active === active) conversation.active = undefined;
			if (current) {
				if (turn.status === "completed") {
					conversation.exchanges = boundBtwExchanges([
						...conversation.exchanges,
						{ question: turn.question, answer: turn.answer },
					]);
				}
				conversation.dto.revision++;
				this.#bound(conversation);
			}
			if (this.#conversation !== conversation || this.#retired()) this.#releaseScope(conversation);
		}
	}
	#start(conversation: Conversation, value: unknown): void {
		if (conversation.active || sideTurnOwners.has(this.#session)) fail("busy", "A side question is still running.");
		if (
			typeof value !== "string" ||
			!value.trim() ||
			!value.isWellFormed() ||
			utf8ByteLength(value) > BTW_MAX_QUESTION_UTF8_BYTES
		)
			fail("invalid_input", "Side question must be nonempty and within its UTF-8 limit.");
		const turn: SideConversationTurn = { id: randomUUID(), question: value, answer: "", status: "running" };
		const active = { turn, abort: new AbortController() };
		conversation.active = active;
		sideTurnOwners.set(this.#session, active);
		conversation.dto.turns.push(turn);
		conversation.dto.revision++;
		this.#bound(conversation);
		void this.#run(conversation, active);
	}
	control(
		operation: SideConversationOperation,
		input: Record<string, unknown>,
	): SideConversationSnapshot | { closed: true } {
		this.#live();
		if (operation === "btw.open") {
			fields(input, [], ["question"]);
			if (this.#conversation) fail("busy", "Close the current side conversation before opening another.");
			if (sideTurnOwners.has(this.#session)) fail("busy", "A side question is still running.");
			const scope = this.#session.createBtwConversationScope(btwUserPrompt);
			const conversation: Conversation = {
				dto: { id: randomUUID(), generation: this.#generation, revision: 0, turns: [] },
				scope,
				exchanges: [],
				deltas: [],
				deltaChars: 0,
				sequence: 0,
				droppedThrough: 0,
			};
			this.#conversation = conversation;
			try {
				if (input.question !== undefined) this.#start(conversation, input.question);
			} catch (error) {
				this.#clear();
				throw error;
			}
			return this.#copy(conversation);
		}
		fields(
			input,
			["conversationId"],
			operation === "btw.submit"
				? ["question"]
				: operation === "btw.cancel"
					? ["turnId"]
					: operation === "btw.read"
						? ["cursor"]
						: [],
		);
		const conversation = this.#resolve(input);
		if (operation === "btw.close") {
			this.#clear();
			return { closed: true };
		}
		if (operation === "btw.submit") this.#start(conversation, input.question);
		if (operation === "btw.cancel") {
			const active = conversation.active;
			if (!active || active.turn.id !== input.turnId)
				fail("resource_gone", "The specified side turn is not running.");
			active.abort.abort();
			active.turn.status = "cancelled";
			conversation.dto.revision++;
		}
		return this.#copy(conversation, operation === "btw.read" ? input.cursor : undefined);
	}
	#clear(): void {
		const conversation = this.#conversation;
		this.#conversation = undefined;
		if (!conversation) return;
		conversation.active?.abort.abort();
		if (!conversation.active) this.#releaseScope(conversation);
		conversation.exchanges.length = 0;
		conversation.dto.turns.length = 0;
		conversation.deltas.length = 0;
		conversation.deltaChars = 0;
	}
	dispose(): void {
		if (this.#disposed) return;
		this.#disposed = true;
		this.#clear();
		for (const cleanup of this.#cleanup.splice(0)) cleanup();
	}
}
