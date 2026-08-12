import { randomUUID } from "node:crypto";
import {
	type MasterClientFrame,
	type ProviderEffectLease,
	type ProviderEffectResultFrame,
	type ProviderPresentationOutcome,
	type ProviderProvisionOutcome,
	providerEffectLeaseValidator,
	providerPresentationOutcomeValidator,
	providerProvisionOutcomeValidator,
} from "../../master/sdk-contract";
import type { MasterDaemonWorkerClientLike } from "./master-daemon-client";

import type { BotApi } from "./telegram-daemon";

type TelegramProvisionEffect = Extract<ProviderEffectLease, { kind: "provision_channel" }> & { provider: "telegram" };
type TelegramPresentationEffect = Extract<ProviderEffectLease, { kind: "present_event" }> & { provider: "telegram" };
export type TelegramMasterChannelEffect = TelegramProvisionEffect | TelegramPresentationEffect;

function isTelegramEffect(effect: ProviderEffectLease): effect is TelegramMasterChannelEffect {
	return effect.provider === "telegram";
}

/**
 * Provider seam for master-channel effects. The high-level methods are the
 * preferred seam; `call` lets the existing TelegramBotTransport be injected
 * without giving this worker any credential or daemon-state authority.
 */
export interface TelegramMasterChannelAdapter {
	provisionChannel?(input: {
		channelName: string;
		name: string;
		nonce: string;
		operation: TelegramProvisionEffect["operation"];
		previousRemoteChannelId: string | null;
		effect: TelegramProvisionEffect;
	}): Promise<unknown>;
	provision?(input: {
		channelName: string;
		name: string;
		nonce: string;
		operation: TelegramProvisionEffect["operation"];
		previousRemoteChannelId: string | null;
		effect: TelegramProvisionEffect;
	}): Promise<unknown>;
	readonly chatId?: string | number;
	createTopic?(input: {
		channelName: string;
		name: string;
		nonce: string;
		operation: TelegramProvisionEffect["operation"];
		previousRemoteChannelId: string | null;
		effect: TelegramProvisionEffect;
	}): Promise<unknown>;
	createForumTopic?(input: {
		channelName: string;
		name: string;
		nonce: string;
		operation: TelegramProvisionEffect["operation"];
		previousRemoteChannelId: string | null;
		effect: TelegramProvisionEffect;
	}): Promise<unknown>;
	findTopicByNonce?(input: {
		channelName: string;
		nonce: string;
		previousRemoteChannelId: string | null;
		effect: TelegramProvisionEffect;
	}): Promise<unknown | null>;
	reconcileTopic?(input: {
		channelName: string;
		nonce: string;
		previousRemoteChannelId: string | null;
		effect: TelegramProvisionEffect;
	}): Promise<unknown | null>;
	present?(input: {
		remoteChannelId: string;
		text: string;
		nonce: string;
		effect: TelegramPresentationEffect;
	}): Promise<unknown>;
	presentEvent?(input: {
		remoteChannelId: string;
		text: string;
		nonce: string;
		effect: TelegramPresentationEffect;
	}): Promise<unknown>;
	sendMessage?(input: {
		remoteChannelId: string;
		text: string;
		nonce: string;
		effect: TelegramPresentationEffect;
	}): Promise<unknown>;
	findMessageByNonce?(input: {
		remoteChannelId: string;
		nonce: string;
		effect: TelegramPresentationEffect;
	}): Promise<unknown | null>;
	call?: BotApi["call"];
}

export type TelegramMasterChannelProvider = TelegramMasterChannelAdapter;

export type MasterProviderWorkerClient = MasterDaemonWorkerClientLike;

export interface TelegramMasterChannelWorkerOptions {
	client: MasterDaemonWorkerClientLike;

	provider: TelegramMasterChannelAdapter;
	workerId?: string;
	chatId?: string | number;
	requestId?: () => string;
	resolveRemoteChannelId?: (input: {
		provider: "telegram";
		masterName: string;
		bindingId: string;
	}) => string | undefined | Promise<string | undefined>;
	now?: () => number;
}

function stringValue(value: unknown): string | undefined {
	if (typeof value === "string" && value.length > 0) return value;
	if (typeof value === "number" && Number.isSafeInteger(value) && value > 0) return String(value);
	return undefined;
}

function record(value: unknown): Record<string, unknown> | undefined {
	return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function unwrap(value: unknown): unknown {
	const object = record(value);
	if (!object) return value;
	if ("outcome" in object) return object.outcome;
	if ("result" in object && object.result !== undefined) return object.result;
	return value;
}

function messageFromError(error: unknown): string {
	if (error instanceof Error && error.message) return error.message;
	if (typeof error === "string" && error) return error;
	return "Telegram provider effect failed.";
}

function errorCode(error: unknown): string | undefined {
	const object = record(error);
	const code = object?.code ?? object?.error_code ?? object?.status;
	return typeof code === "string" || typeof code === "number" ? String(code).toLowerCase() : undefined;
}

function isRetryableCode(
	code: string | undefined,
	message: string,
): "rate_limited" | "provider_busy" | "transport_unavailable" | undefined {
	if (code === "429" || /rate[ -]?limit|too many requests/i.test(message)) return "rate_limited";
	if (/busy|temporar|overloaded/i.test(message) || code === "503" || code === "502") return "provider_busy";
	if (/network|timeout|timed out|fetch|socket|disconnect|unavailable|econn|reset/i.test(message))
		return "transport_unavailable";
	return undefined;
}

function terminalCode(
	code: string | undefined,
	message: string,
): "forum_topics_unsupported" | "permission_denied" | "provider_not_configured" | "channel_deleted" | undefined {
	if (/permission|forbidden|unauthori[sz]ed|403/i.test(message) || code === "403") return "permission_denied";
	if (/not configured|missing token|credentials/i.test(message)) return "provider_not_configured";
	if (/deleted|chat not found|not found|unknown channel/i.test(message) || code === "404") return "channel_deleted";
	if (
		/forum topics? unsupported|topics? are not supported|thread mode (?:is )?disabled/i.test(message) ||
		code === "400"
	)
		return "forum_topics_unsupported";
	return undefined;
}

function provisionOutcome(value: unknown): ProviderProvisionOutcome | undefined {
	const candidate = record(unwrap(value));
	const parsed = providerProvisionOutcomeValidator.safeParse(
		candidate && typeof candidate.status === "string" && candidate.effectKind === undefined
			? { ...candidate, effectKind: "provision_channel" }
			: unwrap(value),
	);
	return parsed.success ? parsed.data : undefined;
}

function presentationOutcome(value: unknown): ProviderPresentationOutcome | undefined {
	const candidate = record(unwrap(value));
	const parsed = providerPresentationOutcomeValidator.safeParse(
		candidate && typeof candidate.status === "string" && candidate.effectKind === undefined
			? { ...candidate, effectKind: "present_event" }
			: unwrap(value),
	);
	return parsed.success ? parsed.data : undefined;
}

function remoteChannelId(value: unknown): string | undefined {
	const object = record(unwrap(value));
	return (
		stringValue(object?.remoteChannelId) ??
		stringValue(object?.message_thread_id) ??
		stringValue(object?.threadId) ??
		stringValue(object?.topicId) ??
		stringValue(object?.id)
	);
}
function remoteChannelFromSnapshot(value: unknown, effect: TelegramPresentationEffect): string | undefined {
	const root = record(value);
	const masters = root?.masters;
	if (!Array.isArray(masters)) return undefined;
	for (const master of masters) {
		const candidate = record(master);
		if (candidate?.masterName !== effect.masterName || !Array.isArray(candidate.channels)) continue;
		for (const channel of candidate.channels) {
			const binding = record(channel);
			if (
				binding?.provider === "telegram" &&
				binding.state === "active" &&
				binding.bindingId === effect.bindingId &&
				typeof binding.remoteChannelId === "string" &&
				binding.remoteChannelId.length > 0
			)
				return binding.remoteChannelId;
		}
	}
	return undefined;
}

function remoteMessageId(value: unknown): string | undefined {
	const object = record(unwrap(value));
	return (
		stringValue(object?.remoteMessageId) ??
		stringValue(object?.message_id) ??
		stringValue(object?.messageId) ??
		stringValue(object?.id)
	);
}

function telegramProvisionFailure(error: unknown, unknownCreate = true): ProviderProvisionOutcome {
	const message = messageFromError(error);
	const code = errorCode(error);
	const terminal = terminalCode(code, message);
	if (terminal) return { effectKind: "provision_channel", status: "terminal", code: terminal, message };
	const retryable = isRetryableCode(code, message);
	if (retryable && !unknownCreate)
		return { effectKind: "provision_channel", status: "retryable", code: retryable, retryAfterMs: null, message };
	return { effectKind: "provision_channel", status: "unknown", code: "create_uncertain", message };
}

function telegramPresentationFailure(error: unknown): ProviderPresentationOutcome {
	const message = messageFromError(error);
	const code = errorCode(error);
	const terminal = terminalCode(code, message);
	if (terminal === "permission_denied" || terminal === "provider_not_configured" || terminal === "channel_deleted")
		return { effectKind: "present_event", status: "terminal", code: terminal, message };
	const retryable = isRetryableCode(code, message);
	if (retryable)
		return { effectKind: "present_event", status: "retryable", code: retryable, retryAfterMs: null, message };
	return { effectKind: "present_event", status: "unknown", code: "post_uncertain", message };
}

function successfulProvision(value: unknown, reconciled = false): ProviderProvisionOutcome | undefined {
	const explicit = provisionOutcome(value);
	if (explicit) return explicit.status === "succeeded" ? { ...explicit, reconciled } : explicit;
	const id = remoteChannelId(value);
	if (!id) return undefined;
	const object = record(unwrap(value));
	return {
		effectKind: "provision_channel",
		status: "succeeded",
		remoteEffectId: stringValue(object?.remoteEffectId) ?? `telegram-topic:${id}`,
		remoteChannelId: id,
		reconciled,
	};
}

function successfulPresentation(value: unknown, reconciled = false): ProviderPresentationOutcome | undefined {
	const explicit = presentationOutcome(value);
	if (explicit) return explicit.status === "succeeded" ? { ...explicit, reconciled } : explicit;
	const id = remoteMessageId(value);
	if (!id) return undefined;
	const object = record(unwrap(value));
	return {
		effectKind: "present_event",
		status: "succeeded",
		remoteEffectId: stringValue(object?.remoteEffectId) ?? `telegram-message:${id}`,
		remoteMessageId: id,
		reconciled,
	};
}

function hasAcceptedTelegramResponse(value: unknown): boolean {
	const object = record(value);
	return object?.ok === true;
}

function topicIdFromTelegramResponse(value: unknown): string | undefined {
	const object = record(value);
	const result = record(object?.result);
	return stringValue(result?.message_thread_id);
}

function messageIdFromTelegramResponse(value: unknown): string | undefined {
	const object = record(value);
	const result = record(object?.result);
	return stringValue(result?.message_id);
}

/** Leased Telegram provider-effect worker for the master aggregate endpoint. */
export class TelegramMasterChannelWorker {
	readonly #client: MasterDaemonWorkerClientLike;

	readonly #provider: TelegramMasterChannelAdapter;
	readonly #chatId: string | number | undefined;
	readonly #workerId: string;
	readonly #requestIdFactory: () => string;
	#unsubscribe: (() => void) | undefined;
	#started = false;
	#queue: Promise<void> = Promise.resolve();
	readonly #now: () => number;
	readonly #resolveRemoteChannelId:
		| ((input: {
				provider: "telegram";
				masterName: string;
				bindingId: string;
		  }) => string | undefined | Promise<string | undefined>)
		| undefined;
	readonly #leases = new Map<string, { leaseId: string; fence: number; expiresAt: number }>();

	constructor(options: TelegramMasterChannelWorkerOptions);
	constructor(
		client: MasterDaemonWorkerClientLike,
		provider: TelegramMasterChannelAdapter,
		options?: Omit<TelegramMasterChannelWorkerOptions, "client" | "provider">,
	);
	constructor(
		input: TelegramMasterChannelWorkerOptions | MasterDaemonWorkerClientLike,
		provider?: TelegramMasterChannelAdapter,
		options: Omit<TelegramMasterChannelWorkerOptions, "client" | "provider"> = {},
	) {
		if (provider !== undefined) {
			this.#client = input as MasterDaemonWorkerClientLike;
			this.#provider = provider;
			this.#chatId = options.chatId ?? provider.chatId;
			this.#workerId = options.workerId ?? `telegram-master-worker-${randomUUID()}`;
			this.#requestIdFactory = options.requestId ?? (() => `telegram-effect-${randomUUID()}`);
			this.#resolveRemoteChannelId = options.resolveRemoteChannelId;
			this.#now = options.now ?? Date.now;
		} else {
			const resolved = input as TelegramMasterChannelWorkerOptions;
			this.#client = resolved.client;
			this.#provider = resolved.provider;
			this.#chatId = resolved.chatId ?? resolved.provider.chatId;
			this.#workerId = resolved.workerId ?? `telegram-master-worker-${randomUUID()}`;
			this.#requestIdFactory = resolved.requestId ?? (() => `telegram-effect-${randomUUID()}`);
			this.#resolveRemoteChannelId = resolved.resolveRemoteChannelId;
			this.#now = resolved.now ?? Date.now;
		}
	}

	get workerId(): string {
		return this.#workerId;
	}

	async start(): Promise<void> {
		if (this.#started) return;
		await this.#client.connect?.();
		this.#unsubscribe = this.#client.onFrame(frame => {
			if (frame.type !== "provider_effect") return;
			const effect = frame.effect;
			if (!isTelegramEffect(effect)) return;

			this.#queue = this.#queue
				.then(() => this.handleEffect(effect))
				.then(() => undefined)
				.catch(() => undefined);
		});
		if (this.#client.registerProviderWorker) await this.#client.registerProviderWorker("telegram", this.#workerId);
		else if (this.#client.request || this.#client.send) {
			const hello: MasterClientFrame = {
				type: "provider_worker_hello",
				requestId: this.#requestIdFactory(),
				provider: "telegram",
				workerId: this.#workerId,
			};
			if (this.#client.request) await this.#client.request(hello);
			else await this.#client.send!(hello);
		}
		this.#started = true;
	}

	async stop(): Promise<void> {
		this.#started = false;
		this.#unsubscribe?.();
		this.#unsubscribe = undefined;
		await this.#queue;
	}
	#reserveLease(effect: TelegramMasterChannelEffect): void {
		const expiresAt = Date.parse(effect.expiresAt);
		const now = this.#now();
		if (!Number.isFinite(expiresAt) || expiresAt <= now)
			throw Object.assign(new Error("Telegram provider effect lease is expired."), { code: "stale_effect_lease" });
		const current = this.#leases.get(effect.effectId);
		if (current && current.expiresAt > now) {
			if (current.leaseId === effect.leaseId && current.fence === effect.fence)
				throw Object.assign(new Error("Telegram provider effect lease is already being dispatched."), {
					code: "duplicate_effect_lease",
				});
			throw Object.assign(new Error("Telegram provider effect has another unexpired lease owner."), {
				code: "duplicate_effect_lease",
			});
		}
		this.#leases.set(effect.effectId, { leaseId: effect.leaseId, fence: effect.fence, expiresAt });
	}

	async #remoteChannelId(effect: TelegramPresentationEffect): Promise<string> {
		const resolver = this.#resolveRemoteChannelId ?? this.#client.resolveRemoteChannelId;
		let remote = resolver
			? await resolver({ provider: "telegram", masterName: effect.masterName, bindingId: effect.bindingId })
			: undefined;
		if (!remote && this.#client.request) {
			const response = await this.#client.request({
				type: "get_snapshot",
				requestId: this.#requestIdFactory(),
			});
			remote = remoteChannelFromSnapshot(response, effect);
		}
		if (!remote)
			throw Object.assign(new Error("Telegram presentation has no durable remote topic binding."), {
				code: "channel_deleted",
			});
		return remote;
	}

	async handleEffect(effect: TelegramMasterChannelEffect): Promise<ProviderEffectResultFrame> {
		const parsed = providerEffectLeaseValidator.safeParse(effect);
		if (!parsed.success || !isTelegramEffect(parsed.data))
			throw new Error("Telegram worker received an invalid or non-Telegram effect");
		const leased = parsed.data;
		this.#reserveLease(leased);
		if (leased.kind === "provision_channel") {
			const outcome = await this.#provision(leased);
			const frame: Extract<ProviderEffectResultFrame, { effectKind: "provision_channel" }> = {
				type: "provider_effect_result",
				requestId: this.#requestIdFactory(),
				effectId: leased.effectId,
				intentId: leased.intentId,
				leaseId: leased.leaseId,
				fence: leased.fence,
				nonce: leased.nonce,
				effectKind: "provision_channel",
				outcome,
			};
			await this.#submit(frame);
			this.#leases.delete(leased.effectId);
			return frame;
		}
		const outcome = await this.#present(leased);
		const frame: Extract<ProviderEffectResultFrame, { effectKind: "present_event" }> = {
			type: "provider_effect_result",
			requestId: this.#requestIdFactory(),
			effectId: leased.effectId,
			intentId: leased.intentId,
			leaseId: leased.leaseId,
			fence: leased.fence,
			nonce: leased.nonce,
			effectKind: "present_event",
			outcome,
		};
		await this.#submit(frame);
		this.#leases.delete(leased.effectId);
		return frame;
	}

	async #submit(frame: ProviderEffectResultFrame): Promise<void> {
		if (this.#client.submitEffectResult) {
			await this.#client.submitEffectResult(frame);
			return;
		}
		if (this.#client.request) {
			await this.#client.request(frame);
			return;
		}
		if (this.#client.send) {
			await this.#client.send(frame);
			return;
		}
		throw new Error("master worker client cannot submit provider results");
	}

	async #provision(effect: TelegramProvisionEffect): Promise<ProviderProvisionOutcome> {
		const input = {
			...effect,
			channelName: effect.channelName,
			name: effect.channelName,
			nonce: effect.nonce,
			operation: effect.operation,
			previousRemoteChannelId: effect.previousRemoteChannelId,
			effect,
		};

		// Telegram topic creation has no provider nonce. A create is therefore one
		// attempt only; an absent/invalid receipt is unknown, never an uncorrelated
		// second create. Reconciliation is an explicit lease operation.
		try {
			let raw: unknown;
			if (effect.operation === "reconcile") {
				const reconcile = this.#provider.reconcileTopic ?? this.#provider.findTopicByNonce;
				if (!reconcile)
					return {
						effectKind: "provision_channel",
						status: "unknown",
						code: "create_uncertain",
						message: "Telegram topic reconciliation is unavailable.",
					};
				raw = await reconcile({
					channelName: effect.channelName,
					nonce: effect.nonce,
					previousRemoteChannelId: effect.previousRemoteChannelId,
					effect,
				} as Parameters<typeof reconcile>[0]);
				if (raw === null || raw === undefined)
					return {
						effectKind: "provision_channel",
						status: "unknown",
						code: "create_uncertain",
						message: "Telegram topic was not found for reconciliation.",
					};
			} else if (this.#provider.provisionChannel) raw = await this.#provider.provisionChannel(input);
			else if (this.#provider.provision) raw = await this.#provider.provision(input);
			else if (this.#provider.createTopic) raw = await this.#provider.createTopic(input);
			else if (this.#provider.createForumTopic) raw = await this.#provider.createForumTopic(input);
			else if (this.#provider.call) {
				if (this.#chatId === undefined)
					return {
						effectKind: "provision_channel",
						status: "terminal",
						code: "provider_not_configured",
						message: "Telegram chat is not configured.",
					};
				raw = await this.#provider.call("createForumTopic", { chat_id: this.#chatId, name: effect.channelName });
				if (!hasAcceptedTelegramResponse(raw)) {
					const response = record(raw);
					const error = Object.assign(
						new Error(String(response?.description ?? "Telegram topic creation was rejected.")),
						{
							code: response?.error_code,
						},
					);
					return telegramProvisionFailure(error, false);
				}
				if (!topicIdFromTelegramResponse(raw))
					return {
						effectKind: "provision_channel",
						status: "unknown",
						code: "create_uncertain",
						message: "Telegram accepted topic creation without a usable topic identifier.",
					};
			} else
				return {
					effectKind: "provision_channel",
					status: "terminal",
					code: "provider_not_configured",
					message: "Telegram topic adapter is not configured.",
				};
			const succeeded = successfulProvision(raw, true);
			if (succeeded) return succeeded;
			if (effect.operation === "reconcile") {
				const id = remoteChannelId(raw);
				if (id)
					return {
						effectKind: "provision_channel",
						status: "succeeded",
						remoteEffectId: `telegram-topic:${id}`,
						remoteChannelId: id,
						reconciled: true,
					};
			}
			return {
				effectKind: "provision_channel",
				status: "unknown",
				code: "create_uncertain",
				message: "Telegram topic creation returned no usable receipt.",
			};
		} catch (error) {
			return telegramProvisionFailure(error, effect.operation !== "reconcile");
		}
	}

	/**
	 * Telegram exposes no reliable lookup for a message this worker may already
	 * have posted. Re-leasing such an effect would duplicate a user-visible master
	 * event, so an uncorrelatable post fails closed for explicit recovery unless a
	 * nonce lookup is configured to prove the outcome.
	 */
	#unverifiablePresentation(message: string): ProviderPresentationOutcome {
		if (this.#provider.findMessageByNonce)
			return { effectKind: "present_event", status: "unknown", code: "post_uncertain", message };
		return {
			effectKind: "present_event",
			status: "terminal",
			code: "post_unverifiable",
			message: `${message} Telegram exposes no nonce lookup, so this presentation cannot be safely retried.`,
		};
	}

	async #present(effect: TelegramPresentationEffect): Promise<ProviderPresentationOutcome> {
		try {
			const remoteChannelId = await this.#remoteChannelId(effect);
			const input = { ...effect, remoteChannelId, text: effect.content.text, nonce: effect.nonce, effect };
			if (this.#provider.findMessageByNonce) {
				const existing = await this.#provider.findMessageByNonce(input);
				const id = remoteMessageId(existing);
				if (id)
					return {
						effectKind: "present_event",
						status: "succeeded",
						remoteEffectId: `telegram-message:${id}`,
						remoteMessageId: id,
						reconciled: true,
					};
			}

			let raw: unknown;
			if (this.#provider.presentEvent) raw = await this.#provider.presentEvent(input);
			else if (this.#provider.present) raw = await this.#provider.present(input);
			else if (this.#provider.sendMessage) raw = await this.#provider.sendMessage(input);
			else if (this.#provider.call) {
				if (this.#chatId === undefined)
					return {
						effectKind: "present_event",
						status: "terminal",
						code: "provider_not_configured",
						message: "Telegram chat is not configured.",
					};
				const thread = /^\d+$/.test(remoteChannelId) ? Number(remoteChannelId) : remoteChannelId;
				raw = await this.#provider.call("sendMessage", {
					chat_id: this.#chatId,
					message_thread_id: thread,
					text: effect.content.text,
				});
				if (!hasAcceptedTelegramResponse(raw)) {
					const response = record(raw);
					const error = Object.assign(
						new Error(String(response?.description ?? "Telegram presentation was rejected.")),
						{ code: response?.error_code },
					);
					return telegramPresentationFailure(error);
				}
				if (!messageIdFromTelegramResponse(raw))
					return this.#unverifiablePresentation(
						"Telegram accepted presentation without a usable message identifier.",
					);
			} else
				return {
					effectKind: "present_event",
					status: "terminal",
					code: "provider_not_configured",
					message: "Telegram presentation adapter is not configured.",
				};

			const normalized = successfulPresentation(raw, true);
			if (normalized) {
				if (normalized.status === "unknown" && this.#provider.findMessageByNonce) {
					const reconciled = await this.#provider.findMessageByNonce(input).catch(() => null);
					const id = remoteMessageId(reconciled);
					if (id)
						return {
							effectKind: "present_event",
							status: "succeeded",
							remoteEffectId: `telegram-message:${id}`,
							remoteMessageId: id,
							reconciled: true,
						};
				}
				if (normalized.status === "unknown") return this.#unverifiablePresentation(normalized.message);
				return normalized;
			}
			return this.#unverifiablePresentation("Telegram presentation returned no usable receipt.");
		} catch (error) {
			const remoteChannelId = await this.#remoteChannelId(effect).catch(() => undefined);
			const reconciled =
				remoteChannelId && this.#provider.findMessageByNonce
					? await this.#provider
							.findMessageByNonce({
								...effect,
								remoteChannelId,
								nonce: effect.nonce,
								effect,
							})
							.catch(() => null)
					: null;
			const id = remoteMessageId(reconciled);
			if (id)
				return {
					effectKind: "present_event",
					status: "succeeded",
					remoteEffectId: `telegram-message:${id}`,
					remoteMessageId: id,
					reconciled: true,
				};
			return telegramPresentationFailure(error);
		}
	}
}

export const TelegramMasterProviderWorker = TelegramMasterChannelWorker;
