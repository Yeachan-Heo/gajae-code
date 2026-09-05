import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";

import {
	type ConversationRecord,
	ConversationStore,
	type ConversationStoreFs,
	conversationStorePath,
} from "./conversation-store";

export const CHAT_EFFECT_JOURNAL_VERSION = 1;
export const MAX_TERMINAL_CHAT_EFFECTS = 128;

/** Test-only failure seam for durable authority migration regressions. */
export const __chatEffectJournalTestHooks: {
	beforeAuthorityMigrationEffect?: (effectId: string) => void | Promise<void>;
} = {};

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

function sessionMutationGateFileName(sessionId: string): string {
	return `.authority-gate-${createHash("sha256").update(sessionId).digest("hex")}.json`;
}

function mappingAcceptsAuthority(mapping: EffectReferenceMapping, authorityId: string | undefined): boolean {
	return (
		mapping.attachmentAuthorityId === authorityId ||
		(mapping.attachmentAuthorityMigrationFromId !== undefined &&
			mapping.attachmentAuthorityMigrationFromId === authorityId)
	);
}

function collectAttachmentAuthorityIds(value: unknown, authorities: Set<string | undefined>): boolean {
	if (Array.isArray(value)) {
		let found = false;
		for (const entry of value) found ||= collectAttachmentAuthorityIds(entry, authorities);
		return found;
	}
	if (!value || typeof value !== "object") return false;
	let found = false;
	for (const [key, candidate] of Object.entries(value)) {
		if (key === "attachmentAuthorityId") {
			authorities.add(typeof candidate === "string" ? candidate : undefined);
			found = true;
			continue;
		}
		found ||= collectAttachmentAuthorityIds(candidate, authorities);
	}
	return found;
}

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

function rewriteAttachmentAuthorityIds(value: unknown, previous: string, current: string): unknown {
	if (Array.isArray(value)) {
		let changed = false;
		const rewritten = value.map(entry => {
			const next = rewriteAttachmentAuthorityIds(entry, previous, current);
			changed ||= next !== entry;
			return next;
		});
		return changed ? rewritten : value;
	}
	if (!value || typeof value !== "object") return value;
	let changed = false;
	const rewritten = Object.fromEntries(
		Object.entries(value).map(([key, entry]) => {
			const next =
				key === "attachmentAuthorityId" && entry === previous
					? current
					: rewriteAttachmentAuthorityIds(entry, previous, current);
			changed ||= next !== entry;
			return [key, next];
		}),
	);
	return changed ? rewritten : value;
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
	readonly #sessionGateStores = new Map<string, ConversationStore<ConversationRecord>>();
	readonly #createSessionGateStore: (sessionId: string) => ConversationStore<ConversationRecord>;
	readonly #maxTerminalEffects: number;

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
		maxTerminalEffects?: number;
	}) {
		this.#store = new ConversationStore<ChatEffect>({ ...input, kind: input.transport, fileName: "effects.json" });
		this.#mappings = new ConversationStore<EffectReferenceMapping>({ ...input, kind: input.transport });
		this.#createSessionGateStore = sessionId =>
			new ConversationStore<ConversationRecord>({
				agentDir: input.agentDir,
				kind: input.transport,
				fileName: sessionMutationGateFileName(sessionId),
				fs: input.fs,
				now: input.now,
				pid: input.pid,
				pidAlive: input.pidAlive,
				pidIncarnation: input.pidIncarnation,
				sleep: input.sleep,
				lockTimeoutMs: input.lockTimeoutMs,
			});

		if (
			input.maxTerminalEffects !== undefined &&
			(!Number.isSafeInteger(input.maxTerminalEffects) || input.maxTerminalEffects < 1)
		)
			throw new Error("Chat effect terminal retention must be a positive safe integer");
		this.#maxTerminalEffects = input.maxTerminalEffects ?? MAX_TERMINAL_CHAT_EFFECTS;
		this.#now = input.now ?? Date.now;
	}

	get filePath(): string {
		return this.#store.filePath;
	}

	/**
	 * Serialize every durable mutation that can publish an effect for one
	 * session. The gate is a separate ConversationStore file so its lock is
	 * shared by mapping and journal writers without widening either store's
	 * existing document lock. Callers must keep provider/network work outside
	 * the gate and use the gate-held variants for nested journal mutations.
	 */
	async withSessionMutationGate<T>(sessionId: string, operation: () => Promise<T>): Promise<T> {
		nonEmpty(sessionId, "sessionId");
		let gateStore = this.#sessionGateStores.get(sessionId);
		if (!gateStore) {
			gateStore = this.#createSessionGateStore(sessionId);
			this.#sessionGateStores.set(sessionId, gateStore);
		}
		let result!: T;
		await gateStore.transactWithSnapshot("gate", async current => {
			result = await operation();
			return { generation: (current?.generation ?? 0) + 1 };
		});
		return result;
	}

	async read<TPayload = unknown>(id: string): Promise<ChatEffect<TPayload> | undefined> {
		return (await this.#store.read(id)) as ChatEffect<TPayload> | undefined;
	}

	async list(): Promise<ChatEffect[]> {
		return Object.values((await this.#store.load()).conversations);
	}

	/** Rewrite pre-device-binding effect payloads after Router proves the current endpoint. */
	async migrateAttachmentAuthorityId(
		sessionId: string,
		endpointGeneration: number,
		previousAuthorityId: string,
		currentAuthorityId: string,
	): Promise<void> {
		await this.withSessionMutationGate(sessionId, async () => {
			await this.migrateAttachmentAuthorityIdWhileHoldingGate(
				sessionId,
				endpointGeneration,
				previousAuthorityId,
				currentAuthorityId,
			);
		});
	}

	/** Performs effect migration for a caller that already holds the session gate. */
	async migrateAttachmentAuthorityIdWhileHoldingGate(
		sessionId: string,
		endpointGeneration: number,
		previousAuthorityId: string,
		currentAuthorityId: string,
	): Promise<void> {
		if (!previousAuthorityId || !currentAuthorityId || previousAuthorityId === currentAuthorityId) return;
		for (const effect of await this.list()) {
			if (effect.sessionId !== sessionId || effect.endpointGeneration !== endpointGeneration) continue;
			await __chatEffectJournalTestHooks.beforeAuthorityMigrationEffect?.(effect.id);
			await this.#store.transact(effect.id, current => {
				if (!current || current.sessionId !== sessionId || current.endpointGeneration !== endpointGeneration)
					return current;
				const payload = rewriteAttachmentAuthorityIds(current.payload, previousAuthorityId, currentAuthorityId);
				if (payload === current.payload) return current;
				return {
					...current,
					generation: current.generation + 1,
					payload,
					updatedAt: this.#now(),
				};
			});
		}
	}

	async replayable(transport: "discord" | "slack", endpointGeneration: number): Promise<ChatEffect[]> {
		const now = this.#now();
		return (await this.list()).filter(
			effect =>
				effect.transport === transport && effect.endpointGeneration === endpointGeneration && canClaim(effect, now),
		);
	}

	async enqueue<TPayload>(input: EnqueueChatEffect<TPayload>): Promise<ChatEffect<TPayload>> {
		if (input.sessionId === undefined) return await this.enqueueWhileHoldingSessionMutationGate(input);
		return await this.withSessionMutationGate(input.sessionId, async () => {
			return await this.enqueueWhileHoldingSessionMutationGate(input);
		});
	}

	/** Enqueue variant for a caller that already holds the session mutation gate. */
	async enqueueWhileHoldingSessionMutationGate<TPayload>(
		input: EnqueueChatEffect<TPayload>,
	): Promise<ChatEffect<TPayload>> {
		nonEmpty(input.id, "id");
		nonEmpty(input.kind, "kind");
		const prepared = await this.#prepareEnqueue(input);
		const existing = await this.read<TPayload>(prepared.id);
		if (existing) {
			requireImmutableEnqueueIdentity(existing, prepared);
			return existing;
		}

		const now = this.#now();
		const effect: ChatEffect<TPayload> = {
			...prepared,
			generation: 1,
			state: "pending",
			epoch: 0,
			createdAt: now,
			updatedAt: now,
		};
		if (await this.#store.write(prepared.id, undefined, effect)) return effect;
		const raced = await this.read<TPayload>(prepared.id);
		if (!raced) throw new Error(`Unable to enqueue chat effect ${input.id}`);
		requireImmutableEnqueueIdentity(raced, prepared);
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
		if (input.sessionId === undefined)
			return await this.enqueueAndClaimWhileHoldingSessionMutationGate(input, owner, leaseMs);
		return await this.withSessionMutationGate(input.sessionId, async () => {
			return await this.enqueueAndClaimWhileHoldingSessionMutationGate(input, owner, leaseMs);
		});
	}

	/** Enqueue-and-claim variant for a caller that already holds the session gate. */
	async enqueueAndClaimWhileHoldingSessionMutationGate<TPayload>(
		input: EnqueueChatEffect<TPayload>,
		owner: string,
		leaseMs: number,
	): Promise<ChatEffect<TPayload> | undefined> {
		nonEmpty(input.id, "id");
		nonEmpty(input.kind, "kind");
		nonEmpty(owner, "owner");
		if (!Number.isFinite(leaseMs) || leaseMs <= 0) throw new Error("Chat effect lease duration must be positive");
		const prepared = await this.#prepareEnqueue(input);
		let claimed: ChatEffect<TPayload> | undefined;
		const now = this.#now();
		await this.#store.transact(prepared.id, current => {
			if (current) {
				requireImmutableEnqueueIdentity(current as ChatEffect<TPayload>, prepared);
				return current;
			}

			claimed = {
				...prepared,
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

	async #prepareEnqueue<TPayload>(input: EnqueueChatEffect<TPayload>): Promise<EnqueueChatEffect<TPayload>> {
		if (input.sessionId === undefined) return input;
		const mappings = Object.values((await this.#mappings.load()).conversations).filter(
			mapping => mapping.sessionId === input.sessionId && mapping.endpointGeneration === input.endpointGeneration,
		);
		if (mappings.length === 0) return input;
		const authorities = new Set<string | undefined>();
		if (!collectAttachmentAuthorityIds(input.payload, authorities)) return input;
		for (const authorityId of authorities) {
			if (!mappings.some(mapping => mappingAcceptsAuthority(mapping, authorityId)))
				throw new Error(`Chat effect ${input.id} attachment authority is no longer accepted`);
		}
		return input;
	}

	async #pruneTerminal(): Promise<void> {
		const terminal = (await this.list())
			.filter(effect => effect.state === "terminal")
			.sort((left, right) => left.updatedAt - right.updatedAt);
		if (terminal.length <= this.#maxTerminalEffects) return;

		const referenced = new Set<string>();
		for (const mapping of Object.values((await this.#mappings.load()).conversations))
			collectEffectReferences(mapping, referenced);
		for (const effect of terminal.slice(0, terminal.length - this.#maxTerminalEffects)) {
			if (!referenced.has(effect.id)) await this.#store.delete(effect.id, effect.generation);
		}
	}
}
