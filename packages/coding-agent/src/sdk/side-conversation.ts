import { randomUUID } from "node:crypto";
import { extractStructuredApiKeyToken } from "@gajae-code/ai/core";
import { redactCrashSecrets } from "@gajae-code/utils";
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

import { collectSdkStoredSecrets } from "./credential-secrets";
import type { SideConversationOperation } from "./protocol/client-control-contracts";
export const SIDE_CONVERSATION_MAX_DELTA_CHUNKS = 256;
export const SIDE_CONVERSATION_MAX_DELTA_CHARS = 32 * 1024;
export interface SideConversationTurn {
	id: string;
	question: string;
	answer: string;
	status: "running" | "completed" | "cancelled" | "failed" | "unknown_effect";
	/** Only the actual native owner barrier can certify provider cleanup. */
	cleanup: "pending" | "settled" | "unknown_effect";
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
	manager: AgentSession["sessionManager"];
	identity: number;
	cleanupSettled: boolean;
	question: string;
	answer: string;
	observedBytes: number;
	redactor: SideOutputRedactor | undefined;
	abort: AbortController;
}
interface Conversation {
	dto: Omit<SideConversationSnapshot, "deltas" | "nextCursor" | "deltasTruncated">;
	scope: BtwConversationScope | undefined;
	exchanges: BtwTextExchange[];
	secrets: readonly string[];
	active?: ActiveTurn;
	deltas: Array<{ sequence: number; turnId: string; text: string }>;
	deltaChars: number;
	sequence: number;
	droppedThrough: number;
}
// A service can retire while its public turn has settled but provider cleanup has not.
// Keep admission on the session itself, across replacement control services.
const sideTurnOwners = new WeakMap<AgentSession, ActiveTurn>();

export type SdkSideConversationErrorCode =
	| "invalid_input"
	| "resource_gone"
	| "busy"
	| "unknown_effect"
	| "redaction_failed"
	| "stale_session";

export class SdkSideConversationError extends Error {
	constructor(
		readonly code: SdkSideConversationErrorCode,
		message: string,
	) {
		super(message);
		this.name = "SdkSideConversationError";
	}
}

function fail(code: SdkSideConversationErrorCode, message: string): never {
	throw new SdkSideConversationError(code, message);
}
function fields(input: Record<string, unknown>, required: readonly string[], optional: readonly string[] = []): void {
	if (Object.keys(input).some(key => !required.includes(key) && !optional.includes(key)))
		fail("invalid_input", "Unknown side conversation field.");
	for (const key of required)
		if (typeof input[key] !== "string" || !input[key]) fail("invalid_input", `Missing ${key}.`);
}

const REDACTED = "«redacted»";
const SENSITIVE_PATH_PART =
	/^(?:\.env(?:\..*)?|\.envrc|\.git|\.gjc|\.pi|\.ssh|\.aws|\.azure|\.gnupg|\.docker|\.netrc|_netrc|\.npmrc|\.pypirc|\.git-credentials|auth\.(?:db|json)(?:[-.].*)?|credentials(?:\..*)?|application_default_credentials\.json|.*\.(?:pem|key|p12|pfx|kdbx|db|sqlite|sqlite3)(?:[-.].*)?)$/i;

function redactSideOutput(text: string, secrets: readonly string[], maskPartial = false): string {
	// Mask the union: replacing one literal first could hide an overlapping match.
	const masks = new Uint8Array(text.length);
	for (const secret of secrets) {
		for (let start = text.indexOf(secret); start !== -1; start = text.indexOf(secret, start + 1))
			masks.fill(1, start, start + secret.length);
		if (!maskPartial) continue;
		// Native replies are already bounded. Match a possibly cut-off suffix in
		// linear time, even for long credentials with repetitive prefixes.
		const prefixes = new Uint32Array(secret.length);
		for (let index = 1, matched = 0; index < secret.length; index++) {
			while (matched && secret[index] !== secret[matched]) matched = prefixes[matched - 1]!;
			if (secret[index] === secret[matched]) matched++;
			prefixes[index] = matched;
		}
		let matched = 0;
		for (let index = Math.max(0, text.length - secret.length + 1); index < text.length; index++) {
			while (matched && text[index] !== secret[matched]) matched = prefixes[matched - 1]!;
			if (text[index] === secret[matched]) matched++;
		}
		if (matched) masks.fill(1, text.length - matched);
	}
	// A mask must not leave the other half of a UTF-16 pair publicly visible.
	for (let index = 0; index + 1 < text.length; index++) {
		const first = text.charCodeAt(index);
		const second = text.charCodeAt(index + 1);
		if (
			first >= 0xd800 &&
			first <= 0xdbff &&
			second >= 0xdc00 &&
			second <= 0xdfff &&
			(masks[index] || masks[index + 1])
		) {
			masks[index] = 1;
			masks[index + 1] = 1;
		}
	}
	const parts: string[] = [];
	for (let index = 0; index < text.length; ) {
		const start = index;
		const masked = masks[index];
		while (index < text.length && masks[index] === masked) index++;
		parts.push(masked ? REDACTED : text.slice(start, index));
	}
	return redactCrashSecrets(parts.join(""))
		.replace(/[^\s"'`<>]+/g, token =>
			token.split(/[\\/]/).some(part => SENSITIVE_PATH_PART.test(part.replace(/^[([{]+|[)\]},;:.]+$/g, "")))
				? REDACTED
				: token,
		)
		.toWellFormed();
}

/**
 * Complete records, not provider chunks, are the generic-redaction boundary. A
 * trailing credential/path fragment is never published speculatively. Structured
 * and multiline values stay private until settlement so PEM/YAML/container rules
 * can inspect them whole. Native turns bound the raw input independently.
 */
class SideOutputRedactor {
	readonly #secrets: readonly string[];
	readonly #overlap: number;
	#pending = "";
	#multiline = false;
	constructor(secrets: readonly string[]) {
		this.#secrets = secrets;
		this.#overlap = secrets.reduce((overlap, secret) => Math.max(overlap, secret.length - 1), 0);
	}
	push(chunk: string): string {
		this.#pending += chunk;
		this.#multiline ||= /-----BEGIN|[[{]|[|>][+-]?[ \t]*(?:#[^\n]*)?(?:\r?\n|$)/.test(this.#pending);
		if (this.#multiline) return "";
		const available = Math.max(0, this.#pending.length - this.#overlap);
		let release = available ? this.#pending.lastIndexOf("\n", available - 1) + 1 : 0;
		// Never cut a literal match, including overlapping or newline-bearing secrets.
		let previous: number;
		do {
			previous = release;
			for (const secret of this.#secrets) {
				for (let start = this.#pending.indexOf(secret); start !== -1 && start < release; ) {
					if (start + secret.length > release) {
						release = start ? this.#pending.lastIndexOf("\n", start - 1) + 1 : 0;
						break;
					}
					start = this.#pending.indexOf(secret, start + 1);
				}
			}
		} while (previous !== release);
		const safe = redactSideOutput(this.#pending.slice(0, release), this.#secrets, false);
		this.#pending = this.#pending.slice(release);
		return safe;
	}
	finish(maskPartial: boolean): string {
		const safe = redactSideOutput(this.#pending, this.#secrets, maskPartial);
		this.#pending = "";
		return safe;
	}
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
		// Maintenance fences new ingress, not an already-admitted owner's callbacks.
		return !this.#retired() && this.#conversation === conversation && conversation.active === active;
	}
	#assertAdmission(): void {
		const owner = sideTurnOwners.get(this.#session);
		if (!owner) return;
		// A rejected cleanup barrier is not a release. Only a true native identity
		// retirement can discard its poison, and never while actual work is pending.
		if (
			owner.cleanupSettled &&
			(this.#session.sessionManager !== owner.manager ||
				owner.manager.getSessionIdentityGeneration() !== owner.identity)
		) {
			sideTurnOwners.delete(this.#session);
			return;
		}
		if (owner.turn.cleanup === "unknown_effect")
			fail("unknown_effect", "Side provider cleanup is unresolved; new side questions are refused.");
		fail("busy", "A side question is still running.");
	}
	#releaseScope(conversation: Conversation): void {
		if (conversation.scope) this.#session.releaseBtwConversationScope(conversation.scope);
		conversation.scope = undefined;
	}
	#append(conversation: Conversation, active: ActiveTurn, text: string): void {
		const turn = active.turn;
		const answer = truncateUtf8(turn.answer + text, BTW_MAX_ANSWER_UTF8_BYTES);
		const delta = answer.slice(turn.answer.length);
		if (!delta) return;
		turn.answer = answer;
		conversation.deltas.push({ sequence: ++conversation.sequence, turnId: turn.id, text: delta });
		conversation.deltaChars += delta.length;
		conversation.dto.revision++;
		this.#bound(conversation);
	}
	#finishStream(conversation: Conversation, active: ActiveTurn, maskPartial = true): void {
		const redactor = active.redactor;
		active.redactor = undefined;
		if (redactor) this.#append(conversation, active, redactor.finish(maskPartial));
	}
	async #run(conversation: Conversation, active: ActiveTurn): Promise<void> {
		const turn = active.turn;
		try {
			const result = await this.#session.runEphemeralTurn({
				purpose: "btw",
				turn: { question: active.question, scope: conversation.scope },
				contextExchanges: structuredClone(conversation.exchanges),
				signal: active.abort.signal,
				onProviderCredential: apiKey => {
					if (!this.#current(conversation, active) || active.abort.signal.aborted)
						fail("stale_session", "The side conversation owner was retired before provider admission.");
					const token = extractStructuredApiKeyToken(apiKey);
					conversation.secrets = [...new Set([...conversation.secrets, apiKey, ...(token ? [token] : [])])];
					// No provider text exists yet. Initialize overlap from the actual key
					// lengths, retaining earlier frozen/history protection across turns.
					active.redactor = new SideOutputRedactor(conversation.secrets);
					turn.question = truncateUtf8(
						redactSideOutput(active.question, conversation.secrets),
						BTW_MAX_QUESTION_UTF8_BYTES,
					);
				},
				onTextDelta: text => {
					if (!this.#current(conversation, active) || active.abort.signal.aborted) return;
					active.observedBytes += utf8ByteLength(text);
					if (active.redactor) this.#append(conversation, active, active.redactor.push(text));
				},
			});
			if (this.#current(conversation, active)) {
				const observedBytes = Math.max(active.observedBytes, utf8ByteLength(result.replyText));
				// UTF-8 truncation may leave up to three bytes unused at a code-point boundary.
				const maskPartial =
					active.abort.signal.aborted ||
					(observedBytes >= BTW_MAX_ANSWER_UTF8_BYTES - 3 && observedBytes <= BTW_MAX_ANSWER_UTF8_BYTES);
				this.#finishStream(conversation, active, maskPartial);
				turn.status = active.abort.signal.aborted ? "cancelled" : "completed";
				if (turn.status === "completed") {
					active.answer = result.replyText;
					turn.answer = truncateUtf8(
						redactSideOutput(result.replyText, conversation.secrets, maskPartial),
						BTW_MAX_ANSWER_UTF8_BYTES,
					);
				}
				conversation.dto.revision++;
				this.#bound(conversation);
			}
		} catch (error) {
			if (this.#current(conversation, active)) {
				const unknown =
					typeof error === "object" && error !== null && "code" in error && error.code === "unknown_effect";
				turn.status = unknown ? "unknown_effect" : active.abort.signal.aborted ? "cancelled" : "failed";
				if (unknown) turn.cleanup = "unknown_effect";
				conversation.dto.revision++;
			}
		} finally {
			if (this.#current(conversation, active)) this.#finishStream(conversation, active);
			active.redactor = undefined;
			// runEphemeralTurn has a bounded cancellation join. Only this actual owner
			// barrier certifies that no retained preflight/iterator work can overlap a retry.
			let cleanupFailed = false;
			try {
				await this.#session.joinBtwTurnsForControl();
			} catch {
				cleanupFailed = true;
			} finally {
				active.cleanupSettled = true;
			}
			// Keep the owner even after disposal so replacing the facade cannot
			// turn uncertified native cleanup into permission for more effects.
			turn.cleanup = cleanupFailed ? "unknown_effect" : "settled";
			if (cleanupFailed) turn.status = "unknown_effect";
			else if (turn.status === "unknown_effect") turn.status = active.abort.signal.aborted ? "cancelled" : "failed";
			if (!cleanupFailed && sideTurnOwners.get(this.#session) === active) sideTurnOwners.delete(this.#session);
			const current = this.#current(conversation, active);
			if (conversation.active === active) conversation.active = undefined;
			if (current) {
				if (turn.status === "completed") {
					conversation.exchanges = boundBtwExchanges([
						...conversation.exchanges,
						{ question: active.question, answer: active.answer },
					]);
				}
				conversation.dto.revision++;
				this.#bound(conversation);
			}
			active.question = "";
			active.answer = "";
			if (this.#conversation !== conversation || this.#retired()) this.#releaseScope(conversation);
		}
	}
	#storedSecrets(): string[] {
		// Storage only: never resolve a provider key or refresh OAuth for redaction.
		try {
			return collectSdkStoredSecrets(this.#session.modelRegistry.authStorage).filter(Boolean);
		} catch {
			fail("redaction_failed", "Side conversation redaction failed; output was withheld.");
		}
	}
	#start(conversation: Conversation, value: unknown): void {
		this.#assertAdmission();
		if (conversation.active) fail("busy", "A side question is still running.");
		if (
			typeof value !== "string" ||
			!value.trim() ||
			!value.isWellFormed() ||
			utf8ByteLength(value) > BTW_MAX_QUESTION_UTF8_BYTES
		)
			fail("invalid_input", "Side question must be nonempty and within its UTF-8 limit.");
		// Refresh before retaining a public question or admitting provider work. Keep
		// earlier values: frozen context and raw follow-up history still contain them.
		conversation.secrets = [...new Set([...conversation.secrets, ...this.#storedSecrets()])];
		const turn: SideConversationTurn = {
			id: randomUUID(),
			question: truncateUtf8(redactSideOutput(value, conversation.secrets), BTW_MAX_QUESTION_UTF8_BYTES),
			answer: "",
			status: "running",
			cleanup: "pending",
		};
		const active: ActiveTurn = {
			turn,
			manager: this.#manager,
			identity: this.#identity,
			cleanupSettled: false,
			question: value,
			answer: "",
			observedBytes: 0,
			redactor: new SideOutputRedactor(conversation.secrets),
			abort: new AbortController(),
		};
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
			this.#assertAdmission();
			const secrets = this.#storedSecrets();
			const scope = this.#session.createBtwConversationScope(btwUserPrompt);
			const conversation: Conversation = {
				dto: { id: randomUUID(), generation: this.#generation, revision: 0, turns: [] },
				scope,
				exchanges: [],
				secrets,
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
			this.#finishStream(conversation, active);
			if (active.turn.status !== "unknown_effect") active.turn.status = "cancelled";
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
