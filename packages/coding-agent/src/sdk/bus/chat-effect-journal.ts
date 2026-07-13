import { isDeepStrictEqual } from "node:util";

import {
	type ConversationRecord,
	ConversationStore,
	type ConversationStoreFs,
	conversationStorePath,
} from "./conversation-store";

export const CHAT_EFFECT_JOURNAL_VERSION = 1;
export const MAX_TERMINAL_CHAT_EFFECTS = 128;

export function chatEffectJournalPath(agentDir: string, transport: "discord" | "slack"): string {
	return conversationStorePath(agentDir, transport, "effects.json");
}

export type ChatEffectState = "pending" | "leased" | "accepted" | "uncertain" | "terminal";

/** Provider receipts are identifiers/status only. Never put request or response bodies here. */
export interface ChatEffectReceipt {
	provider?: string;
	messageId?: string;
	channelId?: string;
	threadId?: string;
	timestamp?: string;
	status?: string;
}

/**
 * A protected, generation-bound provider-visible effect. Payload is deliberately
 * owned by this journal; conversation mappings may retain only `effectId`.
 */
export interface ChatEffect<TPayload = unknown> extends ConversationRecord {
	id: string;
	kind: string;
	transport: "discord" | "slack";
	sessionId?: string;
	endpointGeneration: number;
	payload: TPayload;
	state: ChatEffectState;
	owner?: string;
	leaseExpiresAt?: number;
	epoch: number;
	createdAt: number;
	updatedAt: number;
	receipt?: ChatEffectReceipt;
}

export interface EnqueueChatEffect<TPayload> {
	id: string;
	kind: string;
	transport: "discord" | "slack";
	sessionId?: string;
	endpointGeneration: number;
	payload: TPayload;
	receipt?: ChatEffectReceipt;
}

export interface ChatEffectLease {
	owner: string;
	epoch: number;
}

type EffectReferenceMapping = ConversationRecord & Record<string, unknown>;

function hasImmutableEnqueueIdentity<TPayload>(
	effect: ChatEffect<TPayload>,
	input: EnqueueChatEffect<TPayload>,
): boolean {
	return (
		effect.transport === input.transport &&
		effect.kind === input.kind &&
		effect.sessionId === input.sessionId &&
		effect.endpointGeneration === input.endpointGeneration &&
		isDeepStrictEqual(effect.payload, input.payload)
	);
}

function requireImmutableEnqueueIdentity<TPayload>(
	effect: ChatEffect<TPayload>,
	input: EnqueueChatEffect<TPayload>,
): void {
	if (!hasImmutableEnqueueIdentity(effect, input))
		throw new Error(`Chat effect ${input.id} already exists with a different immutable identity`);
}

function collectEffectReferences(value: unknown, references: Set<string>): void {
	if (Array.isArray(value)) {
		for (const entry of value) collectEffectReferences(entry, references);
		return;
	}
	if (!value || typeof value !== "object") return;
	for (const [key, candidate] of Object.entries(value)) {
		if ((key === "effectId" || key.endsWith("EffectId")) && typeof candidate === "string") references.add(candidate);
		else collectEffectReferences(candidate, references);
	}
}

function nonEmpty(value: string, name: string): void {
	if (!value) throw new Error(`Chat effect ${name} is required`);
}

function canClaim(effect: ChatEffect, now: number): boolean {
	return (
		effect.state === "pending" ||
		effect.state === "accepted" ||
		(effect.state === "uncertain" && !effect.kind.includes(".inbound.")) ||
		(effect.state === "leased" && (effect.leaseExpiresAt ?? 0) <= now)
	);
}

/**
 * One journal per transport. It uses the same 0600, fsynced atomic persistence
 * and cross-process exclusive locking as mappings, but stores payloads in a
 * separate protected file (`effects.json`). Terminal history is compacted only
 * after terminal state is durably recorded; nonterminal effects are never evicted.
 */
export class ChatEffectJournal {
	readonly #store: ConversationStore<ChatEffect>;
	readonly #mappings: ConversationStore<EffectReferenceMapping>;

	readonly #now: () => number;

	constructor(input: {
		agentDir: string;
		transport: "discord" | "slack";
		fs?: ConversationStoreFs;
		now?: () => number;
		pid?: number;
		pidAlive?: (pid: number) => boolean;
		pidIncarnation?: (pid: number) => string | undefined;
		sleep?: (ms: number) => Promise<void>;
		lockTimeoutMs?: number;
	}) {
		this.#store = new ConversationStore<ChatEffect>({ ...input, kind: input.transport, fileName: "effects.json" });
		this.#mappings = new ConversationStore<EffectReferenceMapping>({ ...input, kind: input.transport });

		this.#now = input.now ?? Date.now;
	}

	get filePath(): string {
		return this.#store.filePath;
	}

	async read<TPayload = unknown>(id: string): Promise<ChatEffect<TPayload> | undefined> {
		return (await this.#store.read(id)) as ChatEffect<TPayload> | undefined;
	}

	async list(): Promise<ChatEffect[]> {
		return Object.values((await this.#store.load()).conversations);
	}

	async replayable(transport: "discord" | "slack", endpointGeneration: number): Promise<ChatEffect[]> {
		const now = this.#now();
		return (await this.list()).filter(
			effect =>
				effect.transport === transport && effect.endpointGeneration === endpointGeneration && canClaim(effect, now),
		);
	}

	async enqueue<TPayload>(input: EnqueueChatEffect<TPayload>): Promise<ChatEffect<TPayload>> {
		nonEmpty(input.id, "id");
		nonEmpty(input.kind, "kind");
		const existing = await this.read<TPayload>(input.id);
		if (existing) {
			requireImmutableEnqueueIdentity(existing, input);
			return existing;
		}

		const now = this.#now();
		const effect: ChatEffect<TPayload> = {
			...input,
			generation: 1,
			state: "pending",
			epoch: 0,
			createdAt: now,
			updatedAt: now,
		};
		if (await this.#store.write(input.id, undefined, effect)) return effect;
		const raced = await this.read<TPayload>(input.id);
		if (!raced) throw new Error(`Unable to enqueue chat effect ${input.id}`);
		requireImmutableEnqueueIdentity(raced, input);
		return raced;
	}

	/**
	 * Inserts an effect directly into a live lease. Recovery can never observe a
	 * newly persisted effect as claimable before its owner has authority to act.
	 * Existing effects are left untouched and report no acquired lease.
	 */
	async enqueueAndClaim<TPayload>(
		input: EnqueueChatEffect<TPayload>,
		owner: string,
		leaseMs: number,
	): Promise<ChatEffect<TPayload> | undefined> {
		nonEmpty(input.id, "id");
		nonEmpty(input.kind, "kind");
		nonEmpty(owner, "owner");
		if (!Number.isFinite(leaseMs) || leaseMs <= 0) throw new Error("Chat effect lease duration must be positive");
		let claimed: ChatEffect<TPayload> | undefined;
		const now = this.#now();
		await this.#store.transact(input.id, current => {
			if (current) {
				requireImmutableEnqueueIdentity(current as ChatEffect<TPayload>, input);
				return current;
			}

			claimed = {
				...input,
				generation: 1,
				state: "leased",
				owner,
				epoch: 1,
				leaseExpiresAt: now + leaseMs,
				createdAt: now,
				updatedAt: now,
			};
			return claimed;
		});
		return claimed;
	}

	async claim<TPayload = unknown>(
		id: string,
		owner: string,
		leaseMs: number,
	): Promise<ChatEffect<TPayload> | undefined> {
		nonEmpty(owner, "owner");
		if (!Number.isFinite(leaseMs) || leaseMs <= 0) throw new Error("Chat effect lease duration must be positive");
		let claimed: ChatEffect<TPayload> | undefined;
		const now = this.#now();
		await this.#store.transact(id, current => {
			if (!current || !canClaim(current, now)) return current;
			claimed = {
				...current,
				generation: current.generation + 1,
				state: "leased",
				owner,
				epoch: current.epoch + 1,
				leaseExpiresAt: now + leaseMs,
				updatedAt: now,
			} as ChatEffect<TPayload>;
			return claimed;
		});
		return claimed;
	}

	async renew<TPayload = unknown>(
		id: string,
		lease: ChatEffectLease,
		leaseMs: number,
	): Promise<ChatEffect<TPayload> | undefined> {
		if (!Number.isFinite(leaseMs) || leaseMs <= 0) throw new Error("Chat effect lease duration must be positive");
		let renewed: ChatEffect<TPayload> | undefined;
		const now = this.#now();
		await this.#store.transact(id, current => {
			if (current?.state !== "leased" || current.owner !== lease.owner || current.epoch !== lease.epoch)
				return current;
			renewed = {
				...current,
				generation: current.generation + 1,
				leaseExpiresAt: now + leaseMs,
				updatedAt: now,
			} as ChatEffect<TPayload>;
			return renewed;
		});
		return renewed;
	}

	/** Persists provider progress without releasing the owner/epoch fence. */
	async recordReceipt<TPayload = unknown>(
		id: string,
		lease: ChatEffectLease,
		receipt: ChatEffectReceipt,
	): Promise<ChatEffect<TPayload> | undefined> {
		let recorded: ChatEffect<TPayload> | undefined;
		const now = this.#now();
		await this.#store.transact(id, current => {
			if (current?.state !== "leased" || current.owner !== lease.owner || current.epoch !== lease.epoch)
				return current;
			recorded = {
				...current,
				generation: current.generation + 1,
				receipt,
				updatedAt: now,
			} as ChatEffect<TPayload>;
			return recorded;
		});
		return recorded;
	}

	async record<TPayload = unknown>(
		id: string,
		lease: ChatEffectLease,
		state: Exclude<ChatEffectState, "pending" | "leased">,
		receipt?: ChatEffectReceipt,
	): Promise<ChatEffect<TPayload> | undefined> {
		let recorded: ChatEffect<TPayload> | undefined;
		const now = this.#now();
		await this.#store.transact(id, current => {
			if (current?.state !== "leased" || current.owner !== lease.owner || current.epoch !== lease.epoch)
				return current;
			recorded = {
				...current,
				generation: current.generation + 1,
				state,
				owner: undefined,
				leaseExpiresAt: undefined,
				receipt,
				updatedAt: now,
			} as ChatEffect<TPayload>;
			return recorded;
		});
		if (recorded?.state === "terminal") await this.#pruneTerminal();
		return recorded;
	}

	/** Irreversibly rejects an effect whose mapping never accepted its authority. */
	async terminalize(id: string, receipt: ChatEffectReceipt, lease?: ChatEffectLease): Promise<ChatEffect | undefined> {
		let terminalized: ChatEffect | undefined;
		const now = this.#now();
		await this.#store.transact(id, current => {
			if (!current || current.state === "terminal") return current;
			if (current.state === "leased" && (!lease || current.owner !== lease.owner || current.epoch !== lease.epoch))
				return current;

			terminalized = {
				...current,
				generation: current.generation + 1,
				state: "terminal",
				owner: undefined,
				leaseExpiresAt: undefined,
				receipt,
				updatedAt: now,
			};
			return terminalized;
		});
		if (terminalized) await this.#pruneTerminal();
		return terminalized;
	}

	async #pruneTerminal(): Promise<void> {
		const referenced = new Set<string>();
		for (const mapping of Object.values((await this.#mappings.load()).conversations))
			collectEffectReferences(mapping, referenced);
		const terminal = (await this.list())
			.filter(effect => effect.state === "terminal")
			.sort((left, right) => left.updatedAt - right.updatedAt);
		for (const effect of terminal.slice(0, Math.max(0, terminal.length - MAX_TERMINAL_CHAT_EFFECTS))) {
			if (!referenced.has(effect.id)) await this.#store.delete(effect.id, effect.generation);
		}
	}
}
