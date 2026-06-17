import { createHash } from "node:crypto";
import type {
	RpcExtensionUIRequest,
	RpcExtensionUIResponse,
	RpcWorkflowGate,
	RpcWorkflowGateOption,
} from "@gajae-code/coding-agent/modes/rpc/rpc-types";
import { escapeHtml } from "./projection";
import type { CallbackTokenStore } from "./tokens";
import type { ChatReply, RpcBackendPort, TelegramInlineKeyboardButton } from "./types";

const DEFAULT_TTL_MS = 5 * 60 * 1000;
const TEXT_MAX_LEN = 4000;
const TITLE_MAX_LEN = 160;
const OPTION_MAX_LEN = 48;

export interface RpcUiBridgeBinding {
	chatId: string;
	userId: string | null;
}

export interface RpcUiBridgeOptions {
	backend: RpcBackendPort;
	tokens: CallbackTokenStore;
	binding: RpcUiBridgeBinding;
	now?: () => number;
	ttlMs?: number;
	onMessage?: (reply: ChatReply) => void | Promise<void>;
}

interface PendingTextResponse {
	requestId: string;
	chatId: string;
	userId: string | null;
	expiresAt: number;
	method: "input" | "editor";
}

export class RpcUiBridge {
	readonly #backend: RpcBackendPort;
	readonly #tokens: CallbackTokenStore;
	readonly #binding: RpcUiBridgeBinding;
	readonly #now: () => number;
	readonly #ttlMs: number;
	readonly #onMessage?: (reply: ChatReply) => void | Promise<void>;
	readonly #pendingText = new Map<string, PendingTextResponse>();
	#unsubscribeUi: (() => void) | null = null;
	#unsubscribeGate: (() => void) | null = null;

	constructor(options: RpcUiBridgeOptions) {
		this.#backend = options.backend;
		this.#tokens = options.tokens;
		this.#binding = options.binding;
		this.#now = options.now ?? Date.now;
		this.#ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
		this.#onMessage = options.onMessage;
	}

	start(): void {
		this.#unsubscribeUi =
			this.#backend.onExtensionUiRequest?.(request => {
				void this.handleExtensionUiRequest(request as RpcExtensionUIRequest);
			}) ?? null;
		this.#unsubscribeGate =
			this.#backend.onWorkflowGate?.(gate => {
				void this.renderWorkflowGate(gate as RpcWorkflowGate);
			}) ?? null;
	}

	stop(): void {
		this.#unsubscribeUi?.();
		this.#unsubscribeGate?.();
		this.#unsubscribeUi = null;
		this.#unsubscribeGate = null;
		this.#pendingText.clear();
	}

	async replayPendingWorkflowGates(): Promise<void> {
		const gates = (await this.#backend.getPendingWorkflowGates?.()) as RpcWorkflowGate[] | undefined;
		for (const gate of gates ?? []) await this.renderWorkflowGate(gate);
	}

	async handleExtensionUiRequest(request: RpcExtensionUIRequest): Promise<ChatReply | null> {
		switch (request.method) {
			case "select":
				return this.#emit(this.#renderSelect(request));
			case "confirm":
				return this.#emit(this.#renderConfirm(request));
			case "input":
			case "editor":
				return this.#emit(this.#renderTextPrompt(request));
			case "open_url":
				this.#backend.respondExtensionUi?.({ type: "extension_ui_response", id: request.id, cancelled: true });
				return null;
			case "cancel":
				this.#pendingText.delete(request.targetId);
				return null;
			case "notify":
			case "setStatus":
			case "setWidget":
			case "setTitle":
			case "set_editor_text":
				return null;
		}
	}

	async renderWorkflowGate(gate: RpcWorkflowGate): Promise<ChatReply> {
		const options = gate.options && gate.options.length > 0 ? gate.options : defaultGateOptions(gate);
		const rows = options.map((option, index) => [this.#gateButton(gate, option, index)]);
		return this.#emit({
			kind: "chat",
			parseMode: "HTML",
			text: `<b>${escapeHtml(gate.kind)}</b>: ${escapeHtml(sanitizeLine(gate.context.prompt ?? gate.context.title ?? gate.gate_id, TITLE_MAX_LEN))}`,
			replyMarkup: { inline_keyboard: rows },
		});
	}

	consumeTextResponse(input: { chatId: string; userId: string | null; text: string }): "sent" | "failed" | null {
		for (const [requestId, pending] of this.#pendingText) {
			if (pending.chatId !== input.chatId) continue;
			if (pending.userId !== null && pending.userId !== input.userId) continue;
			if (this.#now() >= pending.expiresAt) {
				this.#pendingText.delete(requestId);
				continue;
			}
			// RpcClient.respondExtensionUi only writes an extension_ui_response frame; input/editor has no
			// protocol ack. Write FIRST and delete the pending request ONLY after a non-throwing write so a
			// failed write retains the pending request for retry instead of silently dropping the text.
			try {
				this.#backend.respondExtensionUi?.({
					type: "extension_ui_response",
					id: requestId,
					value: sanitizeValue(input.text, TEXT_MAX_LEN),
				});
			} catch {
				return "failed";
			}
			this.#pendingText.delete(requestId);
			return "sent";
		}
		return null;
	}

	#renderSelect(request: Extract<RpcExtensionUIRequest, { method: "select" }>): ChatReply {
		const rows = request.options.map((option, index) => [
			this.#uiButton(sanitizeLine(option, OPTION_MAX_LEN), {
				action: "ui_select",
				requestId: request.id,
				value: option,
				optionIndex: index,
			}),
		]);
		return {
			kind: "chat",
			parseMode: "HTML",
			text: `<b>${escapeHtml(sanitizeLine(request.title, TITLE_MAX_LEN))}</b>`,
			replyMarkup: { inline_keyboard: rows },
		};
	}

	#renderConfirm(request: Extract<RpcExtensionUIRequest, { method: "confirm" }>): ChatReply {
		return {
			kind: "chat",
			parseMode: "HTML",
			text: `<b>${escapeHtml(sanitizeLine(request.title, TITLE_MAX_LEN))}</b>\n${escapeHtml(sanitizeLine(request.message, TEXT_MAX_LEN))}`,
			replyMarkup: {
				inline_keyboard: [
					[
						this.#uiButton("Yes", { action: "ui_confirm", requestId: request.id, confirmed: true }),
						this.#uiButton("No", { action: "ui_confirm", requestId: request.id, confirmed: false }),
					],
				],
			},
		};
	}

	#renderTextPrompt(request: Extract<RpcExtensionUIRequest, { method: "input" | "editor" }>): ChatReply {
		this.#pendingText.set(request.id, {
			requestId: request.id,
			chatId: this.#binding.chatId,
			userId: this.#binding.userId,
			expiresAt: this.#now() + this.#ttlMs,
			method: request.method,
		});
		const hint =
			request.method === "editor"
				? "Send the replacement text as the next message."
				: "Send the answer as the next message.";
		return {
			kind: "chat",
			parseMode: "HTML",
			text: `<b>${escapeHtml(sanitizeLine(request.title, TITLE_MAX_LEN))}</b>\n${hint}`,
		};
	}

	#uiButton(
		text: string,
		payload:
			| { action: "ui_select"; requestId: string; value: string; optionIndex: number }
			| { action: "ui_confirm"; requestId: string; confirmed: boolean },
	): TelegramInlineKeyboardButton {
		return {
			text,
			callbackData: this.#tokens.issue({
				...payload,
				chatId: this.#binding.chatId,
				userId: this.#binding.userId,
				ttlMs: this.#ttlMs,
			}),
		};
	}

	#gateButton(
		gate: RpcWorkflowGate,
		option: RpcWorkflowGateOption,
		optionIndex: number,
	): TelegramInlineKeyboardButton {
		const answer = option.value ?? option.label;
		const actionKey = `gate_answer:${gate.gate_id}:${optionIndex}:${hashValue(answer)}`;
		return {
			text: sanitizeLine(option.label ?? `Option ${optionIndex + 1}`, OPTION_MAX_LEN),
			callbackData: this.#tokens.issue({
				action: "gate_answer",
				gateId: gate.gate_id,
				answer,
				optionIndex,
				idempotencyKey: deriveGateIdempotencyKey({ chatId: this.#binding.chatId, gateId: gate.gate_id, actionKey }),
				chatId: this.#binding.chatId,
				userId: this.#binding.userId,
				ttlMs: this.#ttlMs,
			}),
		};
	}

	async #emit(reply: ChatReply): Promise<ChatReply> {
		await this.#onMessage?.(reply);
		return reply;
	}
}

export function extensionUiResponseFromToken(
	record:
		| { action: "ui_select"; requestId: string; value: string }
		| { action: "ui_confirm"; requestId: string; confirmed: boolean },
): RpcExtensionUIResponse {
	// Select/confirm callbacks share the extension_ui fire-and-forget contract; the gateway can only report "Sent."
	if (record.action === "ui_confirm") {
		return { type: "extension_ui_response", id: record.requestId, confirmed: record.confirmed };
	}
	return { type: "extension_ui_response", id: record.requestId, value: record.value };
}

export function deriveGateIdempotencyKey(input: { chatId: string; gateId: string; actionKey: string }): string {
	return `tg:${createHash("sha256").update(`${input.chatId}\0${input.gateId}\0${input.actionKey}`).digest("base64url").slice(0, 32)}`;
}

function defaultGateOptions(gate: RpcWorkflowGate): RpcWorkflowGateOption[] {
	if (gate.kind === "approval") {
		return [
			{ label: "Approve", value: "approve" },
			{ label: "Reject", value: "reject" },
		];
	}
	return [{ label: "Continue", value: true }];
}

function sanitizeLine(value: string, maxLen: number): string {
	return (
		value
			.replace(/[\u0000-\u001f\u007f]/g, " ")
			.replace(/\s+/g, " ")
			.trim()
			.slice(0, maxLen) || "Action required"
	);
}

function sanitizeValue(value: string, maxLen: number): string {
	return value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "").slice(0, maxLen);
}

function hashValue(value: unknown): string {
	return createHash("sha256").update(JSON.stringify(value)).digest("base64url").slice(0, 12);
}
