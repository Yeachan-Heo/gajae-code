/**
 * Server-side opaque callback-token store.
 *
 * Inline-keyboard `callback_data` is only `gtr:v1:<token>` — never the session id.
 * The exact raw coordinator `session_id` lives in server-side token metadata, so
 * long/punctuation-heavy ids never breach Telegram's 64-byte callback_data cap and
 * are never leaked to chat. Tokens are bound to chat (and user when captured), are
 * TTL-bound, and mutating confirmations are single-use — resisting replay and
 * forwarded-button abuse (docs/telegram-remote.md rich-message plan §5.2).
 */
import { randomBytes } from "node:crypto";
import type { SessionFilter } from "./types";

export type SessionCallbackAction =
	| "observe"
	| "refresh_observe"
	| "follow"
	| "mute"
	| "stop_arm"
	| "stop_confirm"
	| "cancel";
export type ListCallbackAction = "sessions_page" | "sessions_filter";
export type PresetCallbackAction = "preset_start";
export type RpcCallbackAction = "ui_select" | "ui_confirm" | "gate_answer" | "steer_held" | "cancel_steer" | "abort";
export type CallbackAction = SessionCallbackAction | ListCallbackAction | PresetCallbackAction | RpcCallbackAction;

export interface BaseCallbackTokenRecord {
	chatId: string;
	/** Captured originating user id; null binds to chat only. */
	userId: string | null;
	expiresAt: number;
	/** One-shot guard for mutating confirmations. */
	used: boolean;
	messageId?: string | number;
}

export interface RevokeMatchingCriteria {
	action: CallbackAction;
	chatId?: string;
	sessionId?: string;
	heldTextId?: string;
}

export interface SessionCallbackPayload {
	action: SessionCallbackAction;
	/** Exact raw coordinator session_id, stored unchanged (never truncated). */
	sessionId: string;
}

export interface ListCallbackPayload {
	action: ListCallbackAction;
	filter: SessionFilter;
	query: string | null;
	page: number;
}

export interface PresetCallbackPayload {
	action: PresetCallbackAction;
	presetId: string;
}

export interface RpcUiSelectPayload {
	action: "ui_select";
	requestId: string;
	optionIndex: number;
	value: string;
}

export interface RpcUiConfirmPayload {
	action: "ui_confirm";
	requestId: string;
	confirmed: boolean;
}

export interface RpcGateAnswerPayload {
	action: "gate_answer";
	gateId: string;
	optionIndex: number;
	answer: unknown;
	idempotencyKey: string;
}

export interface RpcSteerHeldPayload {
	action: "steer_held";
	heldTextId: string;
}

export interface RpcCancelSteerPayload {
	action: "cancel_steer";
	heldTextId: string;
}

export interface RpcAbortPayload {
	action: "abort";
}

export type CallbackTokenRecord = BaseCallbackTokenRecord &
	(
		| SessionCallbackPayload
		| ListCallbackPayload
		| PresetCallbackPayload
		| RpcUiSelectPayload
		| RpcUiConfirmPayload
		| RpcGateAnswerPayload
		| RpcSteerHeldPayload
		| RpcCancelSteerPayload
		| RpcAbortPayload
	);

export const CALLBACK_PREFIX = "gtr:v1:";
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;

export type CallbackResolveFailure = "unknown" | "expired" | "used" | "wrong_chat" | "wrong_user";

export type CallbackResolution =
	| { ok: true; token: string; record: CallbackTokenRecord }
	| { ok: false; reason: CallbackResolveFailure };

/** Extract the token portion from `gtr:v1:<token>`, or null if the shape is wrong. */
export function parseCallbackData(data: string): string | null {
	if (!data.startsWith(CALLBACK_PREFIX)) return null;
	const token = data.slice(CALLBACK_PREFIX.length);
	return TOKEN_PATTERN.test(token) ? token : null;
}

export class CallbackTokenStore {
	private readonly tokens = new Map<string, CallbackTokenRecord>();
	private readonly now: () => number;
	private readonly maxTokens: number;

	constructor(options: { now?: () => number; maxTokens?: number } = {}) {
		this.now = options.now ?? Date.now;
		this.maxTokens = options.maxTokens && options.maxTokens > 0 ? options.maxTokens : 500;
	}

	/** Issue a token for an action and return the opaque `gtr:v1:<token>` callback data. */
	issue(
		record: Omit<BaseCallbackTokenRecord, "expiresAt" | "used"> &
			(
				| SessionCallbackPayload
				| ListCallbackPayload
				| PresetCallbackPayload
				| RpcUiSelectPayload
				| RpcUiConfirmPayload
				| RpcGateAnswerPayload
				| RpcSteerHeldPayload
				| RpcCancelSteerPayload
				| RpcAbortPayload
			) & { ttlMs: number },
	): string {
		this.evictExpired();
		const token = randomBytes(16).toString("base64url");
		const { ttlMs, ...rest } = record;
		this.tokens.set(token, { ...rest, expiresAt: this.now() + ttlMs, used: false } as CallbackTokenRecord);
		this.enforceCap();
		return `${CALLBACK_PREFIX}${token}`;
	}

	/** Resolve callback data against chat/user binding, TTL, and one-shot state. */
	resolve(data: string, context: { chatId: string; userId: string | null }): CallbackResolution {
		const token = parseCallbackData(data);
		if (!token) return { ok: false, reason: "unknown" };
		const record = this.tokens.get(token);
		if (!record) return { ok: false, reason: "unknown" };
		if (this.now() >= record.expiresAt) {
			this.tokens.delete(token);
			return { ok: false, reason: "expired" };
		}
		if (record.chatId !== context.chatId) return { ok: false, reason: "wrong_chat" };
		if (record.userId !== null && record.userId !== context.userId) return { ok: false, reason: "wrong_user" };
		if (record.used) return { ok: false, reason: "used" };
		return { ok: true, token, record };
	}

	/** Mark a one-shot token consumed (mutating confirmations). */
	markUsed(token: string): void {
		const record = this.tokens.get(token);
		if (record) record.used = true;
	}

	/** Invalidate a token (used by `cancel`). */
	delete(token: string): void {
		this.tokens.delete(token);
	}

	/** Invalidate every token matching the supplied server-side binding criteria. */
	revokeMatching(action: CallbackAction, chatId: string, sessionId: string): void;
	revokeMatching(criteria: RevokeMatchingCriteria): void;
	revokeMatching(
		actionOrCriteria: CallbackAction | RevokeMatchingCriteria,
		chatId?: string,
		sessionId?: string,
	): void {
		const criteria: RevokeMatchingCriteria =
			typeof actionOrCriteria === "string" ? { action: actionOrCriteria, chatId, sessionId } : actionOrCriteria;
		for (const [token, record] of this.tokens) {
			if (record.action !== criteria.action) continue;
			if (criteria.chatId !== undefined && record.chatId !== criteria.chatId) continue;
			if (
				criteria.sessionId !== undefined &&
				(!("sessionId" in record) || record.sessionId !== criteria.sessionId)
			) {
				continue;
			}
			if (
				criteria.heldTextId !== undefined &&
				(!("heldTextId" in record) || record.heldTextId !== criteria.heldTextId)
			) {
				continue;
			}
			this.tokens.delete(token);
		}
	}

	size(): number {
		return this.tokens.size;
	}

	private evictExpired(): void {
		const now = this.now();
		for (const [token, record] of this.tokens) {
			if (now >= record.expiresAt) this.tokens.delete(token);
		}
	}

	/** Cap store size: oldest entries (insertion order) are dropped first. */
	private enforceCap(): void {
		while (this.tokens.size > this.maxTokens) {
			const oldest = this.tokens.keys().next().value;
			if (oldest === undefined) break;
			this.tokens.delete(oldest);
		}
	}
}
