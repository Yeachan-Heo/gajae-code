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
import type { DiscordMessageComponent, DiscordProvider, DiscordThread } from "./discord-provider";
import type { MasterDaemonWorkerClientLike } from "./master-daemon-client";

type DiscordProvisionEffect = Extract<ProviderEffectLease, { kind: "provision_channel" }> & { provider: "discord" };
type DiscordPresentationEffect = Extract<ProviderEffectLease, { kind: "present_event" }> & { provider: "discord" };
export type DiscordMasterChannelEffect = DiscordProvisionEffect | DiscordPresentationEffect;

function isDiscordEffect(effect: ProviderEffectLease): effect is DiscordMasterChannelEffect {
	return effect.provider === "discord";
}

/**
 * Discord master-channel adapter. The existing DiscordProvider is accepted
 * directly; high-level methods are available for adapters that already own
 * guild/parent binding and provider-specific persistence.
 */
export interface DiscordMasterChannelAdapter {
	provision?(input: {
		channelName: string;
		name: string;
		nonce: string;
		operation: DiscordProvisionEffect["operation"];
		previousRemoteChannelId: string | null;
		effect: DiscordProvisionEffect;
	}): Promise<unknown>;
	readonly guildId?: string;
	readonly parentChannelId?: string;
	readonly applicationId?: string;
	readonly botUserId?: string;
	createThread?: DiscordProvider["createThread"];
	findThreadByNonce?: DiscordProvider["findThreadByNonce"];
	postMessage?: DiscordProvider["postMessage"];
	findMessageByNonce?: DiscordProvider["findMessageByNonce"];
	unarchiveThread?: DiscordProvider["unarchiveThread"];
	provisionChannel?(input: {
		channelName: string;
		name: string;
		nonce: string;
		operation: DiscordProvisionEffect["operation"];
		previousRemoteChannelId: string | null;
		effect: DiscordProvisionEffect;
	}): Promise<unknown>;
	createMasterChannel?(input: {
		channelName: string;
		name: string;
		nonce: string;
		operation: DiscordProvisionEffect["operation"];
		previousRemoteChannelId: string | null;
		effect: DiscordProvisionEffect;
	}): Promise<unknown>;
	reconcileChannel?(input: {
		channelName: string;
		nonce: string;
		previousRemoteChannelId: string | null;
		effect: DiscordProvisionEffect;
	}): Promise<unknown | null>;
	present?(input: {
		remoteChannelId: string;
		text: string;
		nonce: string;
		effect: DiscordPresentationEffect;
	}): Promise<unknown>;
	presentEvent?(input: {
		remoteChannelId: string;
		text: string;
		nonce: string;
		effect: DiscordPresentationEffect;
	}): Promise<unknown>;
	postEvent?(input: {
		remoteChannelId: string;
		text: string;
		nonce: string;
		effect: DiscordPresentationEffect;
	}): Promise<unknown>;
	confirmThreadDeleted?(input: { threadId: string; effect: DiscordProvisionEffect }): Promise<boolean>;
	isThreadDeleted?(input: { threadId: string; effect: DiscordProvisionEffect }): Promise<boolean>;
	/** Optional adapter-specific check used to authorize a replacement relocation. */
	confirmedDeleted?: (input: { threadId: string; effect: DiscordProvisionEffect }) => Promise<boolean>;
}

export type DiscordMasterChannelProvider = DiscordMasterChannelAdapter;

export interface DiscordMasterChannelWorkerOptions {
	client: MasterDaemonWorkerClientLike;

	provider: DiscordMasterChannelAdapter;
	workerId?: string;
	guildId?: string;
	parentChannelId?: string;
	requestId?: () => string;
	resolveRemoteChannelId?: (input: {
		provider: "discord";
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
	return "Discord provider effect failed.";
}

function errorCode(error: unknown): string | undefined {
	const object = record(error);
	const code = object?.code ?? object?.status;
	return typeof code === "string" || typeof code === "number" ? String(code).toLowerCase() : undefined;
}

function retryableCode(
	code: string | undefined,
	message: string,
): "rate_limited" | "provider_busy" | "transport_unavailable" | undefined {
	if (code === "429" || /rate[ -]?limit|too many requests/i.test(message)) return "rate_limited";
	if (/busy|temporar|overloaded/i.test(message) || code === "502" || code === "503") return "provider_busy";
	if (/network|timeout|timed out|fetch|socket|disconnect|unavailable|econn|reset/i.test(message))
		return "transport_unavailable";
	return undefined;
}

function terminalCode(
	code: string | undefined,
	message: string,
): "permission_denied" | "provider_not_configured" | "channel_deleted" | undefined {
	if (/permission|forbidden|unauthori[sz]ed/i.test(message) || code === "403" || code === "401")
		return "permission_denied";
	if (/not configured|missing token|credentials/i.test(message)) return "provider_not_configured";
	if (/deleted|unknown channel|not found|unrecoverable/i.test(message) || code === "404") return "channel_deleted";
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

function threadFromValue(value: unknown): DiscordThread | undefined {
	const object = record(unwrap(value));
	const id = stringValue(object?.remoteChannelId) ?? stringValue(object?.threadId) ?? stringValue(object?.id);
	if (!id) return undefined;
	return {
		id,
		guildId: stringValue(object?.guildId) ?? "",
		parentId: stringValue(object?.parentId) ?? "",
		archived: object?.archived === true,
		...(object?.locked === true ? { locked: true } : {}),
	};
}

function messageIdFromValue(value: unknown): string | undefined {
	const object = record(unwrap(value));
	return stringValue(object?.remoteMessageId) ?? stringValue(object?.messageId) ?? stringValue(object?.id);
}
function remoteChannelFromSnapshot(value: unknown, effect: DiscordPresentationEffect): string | undefined {
	const root = record(value);
	const masters = root?.masters;
	if (!Array.isArray(masters)) return undefined;
	for (const master of masters) {
		const candidate = record(master);
		if (candidate?.masterName !== effect.masterName || !Array.isArray(candidate.channels)) continue;
		for (const channel of candidate.channels) {
			const binding = record(channel);
			if (
				binding?.provider === "discord" &&
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

function discordProvisionFailure(error: unknown, unknownCreate = true): ProviderProvisionOutcome {
	const message = messageFromError(error);
	const code = errorCode(error);
	const terminal = terminalCode(code, message);
	if (terminal) return { effectKind: "provision_channel", status: "terminal", code: terminal, message };
	const retryable = retryableCode(code, message);
	if (retryable && !unknownCreate)
		return { effectKind: "provision_channel", status: "retryable", code: retryable, retryAfterMs: null, message };
	return { effectKind: "provision_channel", status: "unknown", code: "create_uncertain", message };
}

function discordPresentationFailure(error: unknown): ProviderPresentationOutcome {
	const message = messageFromError(error);
	const code = errorCode(error);
	const terminal = terminalCode(code, message);
	if (terminal === "permission_denied" || terminal === "provider_not_configured" || terminal === "channel_deleted")
		return { effectKind: "present_event", status: "terminal", code: terminal, message };
	const retryable = retryableCode(code, message);
	if (retryable)
		return { effectKind: "present_event", status: "retryable", code: retryable, retryAfterMs: null, message };
	return { effectKind: "present_event", status: "unknown", code: "post_uncertain", message };
}

function successfulProvision(value: unknown, reconciled: boolean): ProviderProvisionOutcome | undefined {
	const explicit = provisionOutcome(value);
	if (explicit) return explicit.status === "succeeded" ? { ...explicit, reconciled } : explicit;
	const thread = threadFromValue(value);
	if (!thread) return undefined;
	const object = record(unwrap(value));
	return {
		effectKind: "provision_channel",
		status: "succeeded",
		remoteEffectId: stringValue(object?.remoteEffectId) ?? `discord-thread:${thread.id}`,
		remoteChannelId: thread.id,
		reconciled,
	};
}

function successfulPresentation(value: unknown, reconciled: boolean): ProviderPresentationOutcome | undefined {
	const explicit = presentationOutcome(value);
	if (explicit) return explicit.status === "succeeded" ? { ...explicit, reconciled } : explicit;
	const id = messageIdFromValue(value);
	if (!id) return undefined;
	const object = record(unwrap(value));
	return {
		effectKind: "present_event",
		status: "succeeded",
		remoteEffectId: stringValue(object?.remoteEffectId) ?? `discord-message:${id}`,
		remoteMessageId: id,
		reconciled,
	};
}

/** Leased Discord provider-effect worker for the master aggregate endpoint. */
export class DiscordMasterChannelWorker {
	readonly #client: MasterDaemonWorkerClientLike;

	readonly #provider: DiscordMasterChannelAdapter;
	readonly #guildId: string | undefined;
	readonly #parentChannelId: string | undefined;
	readonly #workerId: string;
	readonly #requestIdFactory: () => string;
	#unsubscribe: (() => void) | undefined;
	#started = false;
	#queue: Promise<void> = Promise.resolve();
	readonly #now: () => number;
	readonly #resolveRemoteChannelId:
		| ((input: {
				provider: "discord";
				masterName: string;
				bindingId: string;
		  }) => string | undefined | Promise<string | undefined>)
		| undefined;
	readonly #leases = new Map<string, { leaseId: string; fence: number; expiresAt: number }>();

	constructor(options: DiscordMasterChannelWorkerOptions);
	constructor(
		client: MasterDaemonWorkerClientLike,
		provider: DiscordMasterChannelAdapter,
		options?: Omit<DiscordMasterChannelWorkerOptions, "client" | "provider">,
	);
	constructor(
		input: DiscordMasterChannelWorkerOptions | MasterDaemonWorkerClientLike,
		provider?: DiscordMasterChannelAdapter,
		options: Omit<DiscordMasterChannelWorkerOptions, "client" | "provider"> = {},
	) {
		if (provider !== undefined) {
			this.#client = input as MasterDaemonWorkerClientLike;
			this.#provider = provider;
			this.#guildId = options.guildId ?? provider.guildId;
			this.#parentChannelId = options.parentChannelId ?? provider.parentChannelId;
			this.#workerId = options.workerId ?? `discord-master-worker-${randomUUID()}`;
			this.#requestIdFactory = options.requestId ?? (() => `discord-effect-${randomUUID()}`);
			this.#resolveRemoteChannelId = options.resolveRemoteChannelId;
			this.#now = options.now ?? Date.now;
		} else {
			const resolved = input as DiscordMasterChannelWorkerOptions;
			this.#client = resolved.client;
			this.#provider = resolved.provider;
			this.#guildId = resolved.guildId ?? resolved.provider.guildId;
			this.#parentChannelId = resolved.parentChannelId ?? resolved.provider.parentChannelId;
			this.#workerId = resolved.workerId ?? `discord-master-worker-${randomUUID()}`;
			this.#requestIdFactory = resolved.requestId ?? (() => `discord-effect-${randomUUID()}`);
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
			if (!isDiscordEffect(effect)) return;

			this.#queue = this.#queue
				.then(() => this.handleEffect(effect))
				.then(() => undefined)
				.catch(() => undefined);
		});
		if (this.#client.registerProviderWorker) await this.#client.registerProviderWorker("discord", this.#workerId);
		else if (this.#client.request || this.#client.send) {
			const hello: MasterClientFrame = {
				type: "provider_worker_hello",
				requestId: this.#requestIdFactory(),
				provider: "discord",
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

	#reserveLease(effect: DiscordMasterChannelEffect): void {
		const expiresAt = Date.parse(effect.expiresAt);
		const now = this.#now();
		if (!Number.isFinite(expiresAt) || expiresAt <= now)
			throw Object.assign(new Error("Discord provider effect lease is expired."), { code: "stale_effect_lease" });
		const current = this.#leases.get(effect.effectId);
		if (current && current.expiresAt > now) {
			if (current.leaseId === effect.leaseId && current.fence === effect.fence)
				throw Object.assign(new Error("Discord provider effect lease is already being dispatched."), {
					code: "duplicate_effect_lease",
				});
			throw Object.assign(new Error("Discord provider effect has another unexpired lease owner."), {
				code: "duplicate_effect_lease",
			});
		}
		this.#leases.set(effect.effectId, { leaseId: effect.leaseId, fence: effect.fence, expiresAt });
	}

	async #remoteChannelId(effect: DiscordPresentationEffect): Promise<string> {
		const resolver = this.#resolveRemoteChannelId ?? this.#client.resolveRemoteChannelId;
		let remote = resolver
			? await resolver({ provider: "discord", masterName: effect.masterName, bindingId: effect.bindingId })
			: undefined;
		if (!remote && this.#client.request) {
			const response = await this.#client.request({
				type: "get_snapshot",
				requestId: this.#requestIdFactory(),
			});
			remote = remoteChannelFromSnapshot(response, effect);
		}
		if (!remote)
			throw Object.assign(new Error("Discord presentation has no durable remote thread binding."), {
				code: "channel_deleted",
			});
		return remote;
	}

	async handleEffect(effect: DiscordMasterChannelEffect): Promise<ProviderEffectResultFrame> {
		const parsed = providerEffectLeaseValidator.safeParse(effect);
		if (!parsed.success || !isDiscordEffect(parsed.data))
			throw new Error("Discord worker received an invalid or non-Discord effect");
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

	async #findThread(effect: DiscordProvisionEffect): Promise<DiscordThread | null> {
		const finder = this.#provider.findThreadByNonce;
		if (!finder || this.#guildId === undefined || this.#parentChannelId === undefined) return null;
		const found = await finder({ guildId: this.#guildId, parentId: this.#parentChannelId, nonce: effect.nonce });
		return found;
	}

	async #unarchiveIfRetained(thread: DiscordThread): Promise<void> {
		if (!thread.archived) return;
		if (!this.#provider.unarchiveThread)
			throw Object.assign(new Error("Discord retained thread is archived."), { code: "permission_denied" });
		await this.#provider.unarchiveThread({ threadId: thread.id });
	}

	async #confirmedDeleted(effect: DiscordProvisionEffect): Promise<boolean> {
		const previous = effect.previousRemoteChannelId;
		if (!previous) return true;
		const checker =
			this.#provider.confirmThreadDeleted ?? this.#provider.isThreadDeleted ?? this.#provider.confirmedDeleted;
		if (!checker) return false;
		return await checker({ threadId: previous, effect });
	}

	async #provision(effect: DiscordProvisionEffect): Promise<ProviderProvisionOutcome> {
		const input = {
			...effect,
			channelName: effect.channelName,
			name: effect.channelName,
			nonce: effect.nonce,
			operation: effect.operation,
			previousRemoteChannelId: effect.previousRemoteChannelId,
			effect,
		};
		try {
			if (effect.operation === "reconcile" && this.#provider.reconcileChannel) {
				const raw = await this.#provider.reconcileChannel({
					channelName: effect.channelName,
					nonce: effect.nonce,
					previousRemoteChannelId: effect.previousRemoteChannelId,
					effect,
				});
				if (raw === null || raw === undefined)
					return {
						effectKind: "provision_channel",
						status: "unknown",
						code: "create_uncertain",
						message: "Discord thread was not found for nonce reconciliation.",
					};
				const succeeded = successfulProvision(raw, true);
				if (succeeded) {
					const thread = threadFromValue(raw);
					if (thread) await this.#unarchiveIfRetained(thread);
					return succeeded;
				}
				return {
					effectKind: "provision_channel",
					status: "unknown",
					code: "create_uncertain",
					message: "Discord reconciliation returned no usable thread receipt.",
				};
			}
			if (this.#provider.provisionChannel || this.#provider.createMasterChannel || this.#provider.provision) {
				if (effect.operation === "replace" && !(await this.#confirmedDeleted(effect)))
					return {
						effectKind: "provision_channel",
						status: "unknown",
						code: "create_uncertain",
						message: "Discord replacement requires confirmed deletion of the retained thread.",
					};
				const raw = this.#provider.provisionChannel
					? await this.#provider.provisionChannel(input)
					: this.#provider.createMasterChannel
						? await this.#provider.createMasterChannel(input)
						: await this.#provider.provision!(input);
				const succeeded = successfulProvision(raw, true);
				if (succeeded) {
					const thread = threadFromValue(raw);
					if (thread) await this.#unarchiveIfRetained(thread);
					return succeeded;
				}
				return {
					effectKind: "provision_channel",
					status: "unknown",
					code: "create_uncertain",
					message: "Discord channel adapter returned no usable thread receipt.",
				};
			}

			if (effect.operation === "replace" && !(await this.#confirmedDeleted(effect)))
				return {
					effectKind: "provision_channel",
					status: "unknown",
					code: "create_uncertain",
					message: "Discord replacement requires confirmed deletion of the retained thread.",
				};

			if (effect.operation !== "replace") {
				const existing = await this.#findThread(effect);
				if (existing) {
					await this.#unarchiveIfRetained(existing);
					return {
						effectKind: "provision_channel",
						status: "succeeded",
						remoteEffectId: `discord-thread:${existing.id}`,
						remoteChannelId: existing.id,
						reconciled: true,
					};
				}
				if (effect.operation === "reconcile")
					return {
						effectKind: "provision_channel",
						status: "unknown",
						code: "create_uncertain",
						message: "Discord thread was not found for nonce reconciliation.",
					};
			}

			if (!this.#provider.createThread || this.#guildId === undefined || this.#parentChannelId === undefined)
				return {
					effectKind: "provision_channel",
					status: "terminal",
					code: "provider_not_configured",
					message: "Discord thread adapter is not configured.",
				};
			let created: DiscordThread;
			try {
				created = await this.#provider.createThread({
					guildId: this.#guildId,
					parentId: this.#parentChannelId,
					name: effect.channelName,
					nonce: effect.nonce,
				});
			} catch (error) {
				// Discord's create operation is nonce-bound. A transport exception may
				// have accepted the thread, so reconcile the exact nonce before emitting
				// an unknown result; never issue a second create with a new identity.
				const reconciled = await this.#findThread(effect).catch(() => null);
				if (reconciled) {
					await this.#unarchiveIfRetained(reconciled);
					return {
						effectKind: "provision_channel",
						status: "succeeded",
						remoteEffectId: `discord-thread:${reconciled.id}`,
						remoteChannelId: reconciled.id,
						reconciled: true,
					};
				}
				return discordProvisionFailure(error, true);
			}
			await this.#unarchiveIfRetained(created);
			return {
				effectKind: "provision_channel",
				status: "succeeded",
				remoteEffectId: `discord-thread:${created.id}`,
				remoteChannelId: created.id,
				reconciled: false,
			};
		} catch (error) {
			return discordProvisionFailure(error, false);
		}
	}

	async #present(effect: DiscordPresentationEffect): Promise<ProviderPresentationOutcome> {
		try {
			const remoteChannelId = await this.#remoteChannelId(effect);
			const input = { ...effect, remoteChannelId, text: effect.content.text, nonce: effect.nonce, effect };
			if (this.#provider.findMessageByNonce) {
				const existing = await this.#provider.findMessageByNonce({
					threadId: remoteChannelId,
					nonce: effect.nonce,
				});
				const id = messageIdFromValue(existing);
				if (id)
					return {
						effectKind: "present_event",
						status: "succeeded",
						remoteEffectId: `discord-message:${id}`,
						remoteMessageId: id,
						reconciled: true,
					};
			}
			let raw: unknown;
			if (this.#provider.presentEvent) raw = await this.#provider.presentEvent(input);
			else if (this.#provider.present) raw = await this.#provider.present(input);
			else if (this.#provider.postEvent) raw = await this.#provider.postEvent(input);
			else if (this.#provider.postMessage)
				raw = await this.#provider.postMessage({
					threadId: remoteChannelId,
					content: effect.content.text,
					nonce: effect.nonce,
				});
			else
				return {
					effectKind: "present_event",
					status: "terminal",
					code: "provider_not_configured",
					message: "Discord presentation adapter is not configured.",
				};

			const normalized = successfulPresentation(raw, true);
			if (normalized) {
				if (normalized.status === "unknown" && this.#provider.findMessageByNonce) {
					const reconciled = await this.#provider
						.findMessageByNonce({ threadId: remoteChannelId, nonce: effect.nonce })
						.catch(() => null);
					const id = messageIdFromValue(reconciled);
					if (id)
						return {
							effectKind: "present_event",
							status: "succeeded",
							remoteEffectId: `discord-message:${id}`,
							remoteMessageId: id,
							reconciled: true,
						};
				}
				return normalized;
			}
			return {
				effectKind: "present_event",
				status: "unknown",
				code: "post_uncertain",
				message: "Discord presentation returned no usable message receipt.",
			};
		} catch (error) {
			const remoteChannelId = await this.#remoteChannelId(effect).catch(() => undefined);
			const reconciled =
				remoteChannelId && this.#provider.findMessageByNonce
					? await this.#provider
							.findMessageByNonce({ threadId: remoteChannelId, nonce: effect.nonce })
							.catch(() => null)
					: null;
			const id = messageIdFromValue(reconciled);
			if (id)
				return {
					effectKind: "present_event",
					status: "succeeded",
					remoteEffectId: `discord-message:${id}`,
					remoteMessageId: id,
					reconciled: true,
				};
			return discordPresentationFailure(error);
		}
	}
}

export const DiscordMasterProviderWorker = DiscordMasterChannelWorker;
export type { DiscordMessageComponent };
