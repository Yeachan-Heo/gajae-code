/**
 * Per-session forum-topic registry for the threaded session surface.
 *
 * Each GJC session owns one active Telegram forum topic in the paired private
 * DM. The topic is created via `createForumTopic`, reused while the session
 * remains active, and removed from the registry when the daemon deletes it on
 * shutdown. The registry also tracks whether the one-time identity header has
 * already been pinned, so it is sent exactly once per active topic, even across
 * reconnects.
 *
 * State is a plain serialisable map persisted beside the daemon state files;
 * topic creation is injected so this module is pure and unit-testable without a
 * live Bot API.
 */

/** Persisted record for one session's topic. */
export interface TopicRecord {
	/** Telegram forum topic id (message_thread_id). */
	topicId: string;
	/** Whether the one-time identity header has been sent/pinned. */
	identitySent: boolean;
	/** Creation timestamp (ms epoch). */
	createdAt: number;
	/** First positive observation that the owning endpoint is stale, dead, or missing. */
	orphanedAt?: number;
	/** Last applied or observed Telegram topic title. */
	name?: string;
	/** Naming authority. Missing values are legacy daemon-owned records. */
	nameOwner?: "user";
	/** Whether a user-owned name still needs a best-effort Telegram re-assert. */
	nameReconcilePending?: boolean;
	/** Last accepted Telegram update id for a user-owned name. */
	userNameUpdateId?: number;
	/** Stable repo/branch identity used when topic names are user-owned or customized. */
	identityKey?: string;
	/** Last SDK event generation durably consumed by the notification daemon. */
	replayGeneration?: number;
	/** Last SDK event sequence durably consumed within replayGeneration. */
	replaySeq?: number;
	/** Serialized authority epoch; a late create may commit only in its starting epoch. */
	authorityEpoch?: number;
	/** Immutable authority epoch held when this remote topic create began. */
	creationLeaseEpoch?: number;
	/** An uncertain delete fences future creation and inbound routing. */
	authorityState?: "active" | "delete_pending";
	/** Telegram chat and endpoint authority last proven to use this topic. */
	chatId?: string;
	/** Canonical endpoint tuple (URL + token) that currently holds the lease. */
	endpointKey?: string;
	/** Authenticated endpoint authority digest, excluding transport presentation. */
	endpointDigest?: string;
	/** SDK event generation associated with the current endpoint lease. */
	endpointGeneration?: number;
	/** Monotonic authenticated endpoint handoffs; legacy bindings begin at zero. */
	endpointIncarnation?: number;
	/** True when persisted binding fields were present but malformed; recovery must fail closed. */
	bindingMalformed?: true;
}

/** Serialisable shape persisted to disk. */
export interface TopicRegistryState {
	/** sessionId -> record. */
	topics: Record<string, TopicRecord>;
	/** Durable deletion epochs retained after a definite delete. */
	fences?: Record<string, number>;
	/** Closed transport endpoint leases; unchanged endpoint discovery remains fenced across restart. */
	closedEndpoints?: Record<string, TopicEndpointBinding>;
}

/** Authenticated runtime binding for a durable topic lease. */
export interface TopicEndpointBinding {
	chatId: string;
	endpointKey: string;
	endpointDigest: string;
	endpointGeneration?: number;
}

/** Discriminated durable endpoint authority for identity-less replay admission. */
export type TopicEndpointAuthority =
	| { state: "none" }
	| { state: "unique"; sessionId: string }
	| { state: "ambiguous" };

/** Conditional rollback token for a delete fence publication. */
export interface TopicDeleteAuthoritySnapshot {
	sessionId: string;
	topicId?: string;
	authorityEpoch?: number;
	authorityState?: TopicRecord["authorityState"];
	fenceEpoch?: number;
	/** Exact fenced record, retained to restore an in-memory tombstone after a failed clear publication. */
	record?: TopicRecord;
}

function isValidBindingString(value: unknown): value is string {
	return typeof value === "string" && value.trim().length > 0;
}

function isValidBindingGeneration(value: unknown): value is number {
	return Number.isSafeInteger(value) && (value as number) >= 0;
}
function hasAnyBinding(record: TopicRecord): boolean {
	return (
		record.chatId !== undefined ||
		record.endpointKey !== undefined ||
		record.endpointDigest !== undefined ||
		record.endpointGeneration !== undefined ||
		record.endpointIncarnation !== undefined
	);
}

function hasCompleteBinding(record: TopicRecord): boolean {
	return (
		isValidBindingString(record.chatId) &&
		isValidBindingString(record.endpointKey) &&
		isValidBindingString(record.endpointDigest) &&
		(record.endpointGeneration === undefined || isValidBindingGeneration(record.endpointGeneration)) &&
		(record.endpointIncarnation === undefined || isValidBindingGeneration(record.endpointIncarnation))
	);
}

function hasValidBinding(binding: TopicEndpointBinding): boolean {
	return (
		isValidBindingString(binding.chatId) &&
		isValidBindingString(binding.endpointKey) &&
		isValidBindingString(binding.endpointDigest) &&
		(binding.endpointGeneration === undefined || isValidBindingGeneration(binding.endpointGeneration))
	);
}

function isValidTopicId(value: unknown): value is string {
	return (
		typeof value === "string" && /^[1-9]\d*$/.test(value) && Number.isSafeInteger(Number(value)) && Number(value) > 0
	);
}

export function emptyTopicRegistryState(): TopicRegistryState {
	return { topics: {} };
}

/**
 * In-memory registry over a serialisable state. Topic creation is injected via
 * `getOrCreateTopic`'s `create` callback (the daemon supplies a real
 * `createForumTopic` call); reuse-on-resume is automatic when a record exists.
 */
export class TopicRegistry {
	private readonly topics: Map<string, TopicRecord>;
	/** Maps topicId -> sessionId for fast inbound routing. */
	private readonly byTopic = new Map<string, string>();
	/** Persisted collisions are ambiguous and must never authorize inbound routing. */
	readonly #ambiguousTopicIds = new Set<string>();
	/** In-flight create promises, keyed by session, to dedupe concurrent creates. */
	private readonly inflight = new Map<string, Promise<TopicRecord>>();
	/** Newly-created records being durably published; never routable until committed. */
	private readonly staged = new Map<string, TopicRecord>();
	/** Socket-specific provenance for transient endpoint claims. */
	private readonly transientClaimants = new Map<string, object | undefined>();
	/** Endpoint claims registered before a remote topic create can publish a record. */
	private readonly creatingBindings = new Map<string, TopicEndpointBinding>();
	/** Monotonic authority epochs, including deletion fences for absent records. */
	private readonly epochs = new Map<string, number>();

	constructor(state: TopicRegistryState = emptyTopicRegistryState()) {
		this.topics = new Map();
		this.load(state);
	}

	/** Replace all runtime state after a successfully persisted staged publication. */
	replace(state: TopicRegistryState): void {
		this.topics.clear();
		this.byTopic.clear();
		this.#ambiguousTopicIds.clear();
		this.epochs.clear();
		this.load(state);
	}

	/** Merge serialized state and normalize authority fields from older releases. */
	load(state: TopicRegistryState): void {
		for (const [sessionId, epoch] of Object.entries(state.fences ?? {})) {
			if (Number.isSafeInteger(epoch) && epoch >= 0) this.epochs.set(sessionId, epoch);
		}

		for (const [sessionId, raw] of Object.entries(state.topics ?? {})) {
			if (!raw || !isValidTopicId(raw.topicId)) continue;
			const hasValidUserAuthority =
				raw.nameOwner === "user" &&
				typeof raw.name === "string" &&
				raw.name.trim().length > 0 &&
				(raw.userNameUpdateId === undefined ||
					(typeof raw.userNameUpdateId === "number" &&
						Number.isSafeInteger(raw.userNameUpdateId) &&
						raw.userNameUpdateId >= 0));
			const hasValidReplayCursor =
				typeof raw.replayGeneration === "number" &&
				Number.isSafeInteger(raw.replayGeneration) &&
				raw.replayGeneration >= 1 &&
				typeof raw.replaySeq === "number" &&
				Number.isSafeInteger(raw.replaySeq) &&
				raw.replaySeq >= 0;
			const legacyUnbound = !hasAnyBinding(raw);
			const bindingMalformed = raw.bindingMalformed === true || (!legacyUnbound && !hasCompleteBinding(raw));
			const candidateAuthorityEpoch = raw.authorityEpoch;
			const rawAuthorityEpoch: number =
				typeof candidateAuthorityEpoch === "number" &&
				Number.isSafeInteger(candidateAuthorityEpoch) &&
				candidateAuthorityEpoch >= 0
					? candidateAuthorityEpoch
					: 0;
			// A fence is the durable authority source. A mixed snapshot can contain an
			// older active record alongside a newer fence; never rebuild its inbound route.
			const fenceEpoch = this.epochs.get(sessionId) ?? 0;
			const fenceSupersedesRecord = fenceEpoch > rawAuthorityEpoch;
			const record: TopicRecord = {
				topicId: raw.topicId,
				identitySent: raw.identitySent === true,
				createdAt: typeof raw.createdAt === "number" ? raw.createdAt : 0,
				...(typeof raw.name === "string" ? { name: raw.name } : {}),
				...(typeof raw.orphanedAt === "number" && Number.isFinite(raw.orphanedAt) && raw.orphanedAt >= 0
					? { orphanedAt: raw.orphanedAt }
					: {}),
				...(hasValidUserAuthority ? { nameOwner: "user" as const } : {}),
				...(hasValidUserAuthority && raw.nameReconcilePending === true ? { nameReconcilePending: true } : {}),
				...(hasValidUserAuthority && typeof raw.userNameUpdateId === "number"
					? { userNameUpdateId: raw.userNameUpdateId }
					: {}),
				...(typeof raw.identityKey === "string" ? { identityKey: raw.identityKey } : {}),
				...(typeof raw.creationLeaseEpoch === "number" &&
				Number.isSafeInteger(raw.creationLeaseEpoch) &&
				raw.creationLeaseEpoch >= 0
					? { creationLeaseEpoch: raw.creationLeaseEpoch }
					: {}),
				...(hasValidReplayCursor ? { replayGeneration: raw.replayGeneration, replaySeq: raw.replaySeq } : {}),
				authorityEpoch: Math.max(rawAuthorityEpoch, fenceEpoch),
				...(raw.authorityState === "delete_pending" || fenceSupersedesRecord
					? { authorityState: "delete_pending" as const }
					: {}),
				...(isValidBindingString(raw.chatId) ? { chatId: raw.chatId } : {}),
				...(isValidBindingString(raw.endpointKey) ? { endpointKey: raw.endpointKey } : {}),
				...(isValidBindingString(raw.endpointDigest) ? { endpointDigest: raw.endpointDigest } : {}),
				...(isValidBindingGeneration(raw.endpointGeneration) ? { endpointGeneration: raw.endpointGeneration } : {}),
				...(isValidBindingGeneration(raw.endpointIncarnation)
					? { endpointIncarnation: raw.endpointIncarnation }
					: {}),
				...(bindingMalformed ? { bindingMalformed: true as const } : {}),
			};
			this.epochs.set(sessionId, Math.max(fenceEpoch, record.authorityEpoch ?? 0));
			// Pre-generation-17 records have no endpoint authority. Retire them locally:
			// their unknown remote topic must neither be rebound nor deleted cross-chat.
			if (legacyUnbound) continue;

			this.topics.set(sessionId, record);
		}
		this.rebuildInboundRoutes();
	}

	private rebuildInboundRoutes(): void {
		this.byTopic.clear();
		this.#ambiguousTopicIds.clear();
		const activeByTopic = new Map<string, string>();

		for (const [sessionId, record] of this.topics) {
			if (record.authorityState === "delete_pending" || record.bindingMalformed) {
				this.#ambiguousTopicIds.add(record.topicId);
				continue;
			}
			if (activeByTopic.has(record.topicId)) {
				this.#ambiguousTopicIds.add(record.topicId);
				continue;
			}
			activeByTopic.set(record.topicId, sessionId);
		}

		for (const [topicId, sessionId] of activeByTopic) {
			if (!this.#ambiguousTopicIds.has(topicId)) this.byTopic.set(topicId, sessionId);
		}
	}

	/** Resolve the owning session for a topic id (for fail-closed inbound routing). */
	sessionForTopic(topicId: string): string | undefined {
		return this.byTopic.get(topicId);
	}

	/** All session ids with a persisted topic record. */
	sessionIds(): string[] {
		return [...this.topics.keys()];
	}

	/** Persisted remote deletes that must be reconciled before recovery can proceed. */
	deletePendingSessionIds(): string[] {
		return [...this.topics].flatMap(([sessionId, record]) =>
			record.authorityState === "delete_pending" ? [sessionId] : [],
		);
	}

	/** The existing topic record for a session, if any. */
	get(sessionId: string): TopicRecord | undefined {
		return this.topics.get(sessionId);
	}

	/** Current immutable authority epoch for a creation lease. */
	authorityEpoch(sessionId: string): number {
		return Math.max(this.epochs.get(sessionId) ?? 0, this.topics.get(sessionId)?.authorityEpoch ?? 0);
	}

	/** Whether this session has an active, unambiguous topic authority. */
	isActiveUnambiguous(sessionId: string): boolean {
		const record = this.topics.get(sessionId);
		return record?.authorityState !== "delete_pending" && this.byTopic.get(record?.topicId ?? "") === sessionId;
	}

	/**
	 * Resolve endpoint authority for identity-less replay. An endpoint may bootstrap
	 * only when no committed, staged, or pre-create claim can own it; malformed
	 * partial bindings and deletion fences deliberately fail closed.
	 */
	endpointAuthority(binding: TopicEndpointBinding, excludedTransientClaimant?: object): TopicEndpointAuthority {
		if (!hasValidBinding(binding)) return { state: "ambiguous" };
		const canClaim = (record: Pick<TopicRecord, "chatId" | "endpointKey" | "endpointDigest">): boolean =>
			(record.chatId === undefined || record.chatId === binding.chatId) &&
			(record.endpointKey === undefined || record.endpointKey === binding.endpointKey) &&
			(record.endpointDigest === undefined || record.endpointDigest === binding.endpointDigest);
		const committed = [...this.topics].filter(([, record]) => canClaim(record));
		const excludesClaimant = (sessionId: string): boolean =>
			excludedTransientClaimant !== undefined &&
			this.transientClaimants.get(sessionId) === excludedTransientClaimant;
		const staged = [...this.staged].filter(([sessionId, record]) => canClaim(record) && !excludesClaimant(sessionId));
		const creating = [...this.creatingBindings].filter(
			([sessionId, claim]) => canClaim(claim) && !excludesClaimant(sessionId),
		);
		if (committed.length === 0 && staged.length === 0 && creating.length === 0) return { state: "none" };
		if (committed.length !== 1 || staged.length !== 0 || creating.length !== 0) return { state: "ambiguous" };
		const [sessionId, record] = committed[0]!;
		return record.chatId === binding.chatId &&
			record.endpointKey === binding.endpointKey &&
			record.endpointDigest === binding.endpointDigest &&
			this.isActiveUnambiguous(sessionId) &&
			!record.bindingMalformed
			? { state: "unique", sessionId }
			: { state: "ambiguous" };
	}

	/** Resolve a uniquely bound logical owner for callers that only need the owner. */
	uniqueSessionForEndpoint(binding: TopicEndpointBinding): string | undefined {
		const authority = this.endpointAuthority(binding);
		return authority.state === "unique" ? authority.sessionId : undefined;
	}

	/** Whether this exact session owns the complete durable endpoint binding. */
	matchesEndpoint(sessionId: string, binding: TopicEndpointBinding): boolean {
		const record = this.topics.get(sessionId);
		return (
			this.isActiveUnambiguous(sessionId) &&
			!record?.bindingMalformed &&
			record?.chatId === binding.chatId &&
			record.endpointKey === binding.endpointKey &&
			record.endpointDigest === binding.endpointDigest
		);
	}

	/**
	 * Rebind an existing topic to an authenticated successor endpoint. The exact
	 * logical session id is proved by replay before this method is called. A
	 * rotated credential may replace only an inactive incumbent; concurrent
	 * incumbents, cross-chat records, malformed evidence, collisions, and delete
	 * fences remain fail-closed.
	 */
	bindEndpoint(
		sessionId: string,
		binding: TopicEndpointBinding,
		activeEndpointKeys: ReadonlySet<string> = new Set(),
		allowEndpointRotation = false,
	): "bound" | "unchanged" | "rejected" {
		const record = this.topics.get(sessionId);
		if (
			!record ||
			record.authorityState === "delete_pending" ||
			record.bindingMalformed ||
			!hasValidBinding(binding) ||
			!this.isActiveUnambiguous(sessionId)
		)
			return "rejected";
		if (hasAnyBinding(record) && !hasCompleteBinding(record)) return "rejected";
		// A topic id without chat affinity may belong to any prior paired chat.
		// Do not bind it to the current chat merely because a resumed endpoint
		// authenticated its logical session id.
		if (record.chatId === undefined || record.chatId !== binding.chatId) return "rejected";

		const sameEndpoint =
			record.endpointKey === binding.endpointKey && record.endpointDigest === binding.endpointDigest;
		if (
			sameEndpoint &&
			record.endpointGeneration !== undefined &&
			binding.endpointGeneration !== undefined &&
			binding.endpointGeneration < record.endpointGeneration
		)
			return "rejected";
		if (
			!sameEndpoint &&
			hasAnyBinding(record) &&
			(!allowEndpointRotation || (record.endpointKey !== undefined && activeEndpointKeys.has(record.endpointKey)))
		)
			return "rejected";

		const changed =
			record.chatId !== binding.chatId ||
			record.endpointKey !== binding.endpointKey ||
			record.endpointDigest !== binding.endpointDigest ||
			record.endpointGeneration !== binding.endpointGeneration;
		if (!changed) return "unchanged";
		record.chatId = binding.chatId;
		record.endpointKey = binding.endpointKey;
		record.endpointDigest = binding.endpointDigest;
		record.endpointGeneration = binding.endpointGeneration;
		if (!sameEndpoint) record.endpointIncarnation = (record.endpointIncarnation ?? 0) + 1;
		return "bound";
	}

	/** Undo a failed durable endpoint migration without disturbing concurrent metadata writers. */
	restoreEndpointBinding(
		sessionId: string,
		expected: TopicEndpointBinding,
		previous: Pick<
			TopicRecord,
			"chatId" | "endpointKey" | "endpointDigest" | "endpointGeneration" | "endpointIncarnation"
		>,
	): boolean {
		const record = this.topics.get(sessionId);
		if (
			!record ||
			record.chatId !== expected.chatId ||
			record.endpointKey !== expected.endpointKey ||
			record.endpointDigest !== expected.endpointDigest ||
			record.endpointGeneration !== expected.endpointGeneration
		)
			return false;
		record.chatId = previous.chatId;
		record.endpointKey = previous.endpointKey;
		record.endpointDigest = previous.endpointDigest;
		if (previous.endpointGeneration === undefined) delete record.endpointGeneration;
		else record.endpointGeneration = previous.endpointGeneration;
		if (previous.endpointIncarnation === undefined) delete record.endpointIncarnation;
		else record.endpointIncarnation = previous.endpointIncarnation;
		return true;
	}

	/**
	 * Return the existing active topic for `sessionId`, or create one via
	 * `create` (called only on first use).
	 */
	async getOrCreateTopic(
		sessionId: string,
		create: () => Promise<unknown>,
		now: () => number = Date.now,
		name?: string,
		binding?: TopicEndpointBinding,
		commit?: () => Promise<void>,
		transientClaimant?: object,
	): Promise<TopicRecord> {
		const existing = this.topics.get(sessionId);
		if (existing?.authorityState === "delete_pending") throw new Error("topic authority is deletion-fenced");
		if (existing?.bindingMalformed) throw new Error("topic authority binding is quarantined");
		if (existing) return existing;
		const pending = this.inflight.get(sessionId);
		if (pending) return pending;
		const epoch = this.epochs.get(sessionId) ?? 0;
		// Publish the compatible endpoint claim before invoking `create`: the callback
		// may immediately begin a remote create and identity-less recovery must never
		// observe a false absence during that await.
		if (binding) this.creatingBindings.set(sessionId, binding);
		this.transientClaimants.set(sessionId, transientClaimant);
		const promise = (async () => {
			const topicId = await create();
			if (!isValidTopicId(topicId)) throw new Error("createForumTopic: invalid message_thread_id");
			const revoked = (this.epochs.get(sessionId) ?? 0) !== epoch;
			const record: TopicRecord = {
				topicId,
				name,
				identitySent: false,
				createdAt: now(),
				authorityEpoch: revoked ? (this.epochs.get(sessionId) ?? 0) : epoch,
				creationLeaseEpoch: epoch,
				...(binding
					? {
							chatId: binding.chatId,
							endpointKey: binding.endpointKey,
							endpointDigest: binding.endpointDigest,
							endpointIncarnation: 0,
							...(binding.endpointGeneration === undefined
								? {}
								: { endpointGeneration: binding.endpointGeneration }),
						}
					: {}),
				...(revoked ? { authorityState: "delete_pending" as const } : {}),
			};
			if (revoked) {
				this.topics.set(sessionId, record);
				throw new Error("topic authority was revoked during creation");
			}
			this.staged.set(sessionId, record);
			try {
				await commit?.();
			} catch (error) {
				this.staged.delete(sessionId);
				throw error;
			}
			this.staged.delete(sessionId);
			if ((this.epochs.get(sessionId) ?? 0) !== epoch) {
				record.authorityEpoch = this.epochs.get(sessionId) ?? 0;
				record.authorityState = "delete_pending";
				this.topics.set(sessionId, record);
				throw new Error("topic authority was revoked during creation");
			}
			this.topics.set(sessionId, record);
			if (this.#ambiguousTopicIds.has(topicId)) return record;
			if (this.byTopic.has(topicId)) {
				this.byTopic.delete(topicId);
				this.#ambiguousTopicIds.add(topicId);
				return record;
			}
			this.byTopic.set(topicId, sessionId);
			return record;
		})();
		this.inflight.set(sessionId, promise);
		try {
			return await promise;
		} finally {
			this.inflight.delete(sessionId);
			this.creatingBindings.delete(sessionId);
			this.transientClaimants.delete(sessionId);
		}
	}

	/** Mark the identity header as sent for a session. Idempotent. */
	markIdentitySent(sessionId: string): void {
		const record = this.topics.get(sessionId);
		if (record) record.identitySent = true;
	}

	/** Whether the identity header still needs sending for this session. */
	needsIdentity(sessionId: string): boolean {
		const record = this.topics.get(sessionId);
		return record ? !record.identitySent : true;
	}

	/** Remember stable repo/branch identity independently of the displayed name. */
	markIdentityKey(sessionId: string, identityKey: string): boolean {
		const record = this.topics.get(sessionId);
		if (!record || record.identityKey === identityKey) return false;
		record.identityKey = identityKey;
		return true;
	}
	/** Start the orphan grace clock on the first positive liveness-loss observation. */
	markOrphaned(sessionId: string, now: number): boolean {
		const record = this.topics.get(sessionId);
		if (!record || record.orphanedAt !== undefined) return false;
		record.orphanedAt = now;
		return true;
	}

	/** Clear a prior orphan observation after the endpoint is positively live again. */
	clearOrphaned(sessionId: string): boolean {
		const record = this.topics.get(sessionId);
		if (!record || record.orphanedAt === undefined) return false;
		delete record.orphanedAt;
		return true;
	}

	/** Last durably consumed SDK event cursor for reconnect replay. */
	replayCursor(sessionId: string): { generation: number; seq: number } | undefined {
		const record = this.topics.get(sessionId);
		return record?.replayGeneration !== undefined && record.replaySeq !== undefined
			? { generation: record.replayGeneration, seq: record.replaySeq }
			: undefined;
	}

	/** Advance the durable reconnect cursor without allowing stale responses to move it backwards. */
	markReplayCursor(sessionId: string, generation: number, seq: number): boolean {
		const record = this.topics.get(sessionId);
		if (!record) return false;
		const currentGeneration = record.replayGeneration ?? 0;
		const currentSeq = record.replaySeq ?? 0;
		if (generation < currentGeneration || (generation === currentGeneration && seq <= currentSeq)) return false;
		record.replayGeneration = generation;
		record.replaySeq = seq;
		return true;
	}

	/** Whether daemon identity reconciliation should apply `name`. */
	needsRename(sessionId: string, name: string): boolean {
		const record = this.topics.get(sessionId);
		return record !== undefined && record.nameOwner !== "user" && record.name !== name;
	}

	/** The user-owned name that must be preserved, when one exists. */
	userOwnedName(sessionId: string): string | undefined {
		const record = this.topics.get(sessionId);
		return record?.nameOwner === "user" ? record.name : undefined;
	}

	/** A user-owned name whose Telegram reconciliation is still pending. */
	userNameToReconcile(sessionId: string): string | undefined {
		const record = this.topics.get(sessionId);
		return record?.nameOwner === "user" && record.nameReconcilePending ? record.name : undefined;
	}

	/** Record an explicit Telegram-side user rename, rejecting stale update ids. */
	markUserName(sessionId: string, name: string, updateId: number): "updated" | "duplicate" | "stale" {
		const record = this.topics.get(sessionId);
		if (!record) return "stale";
		if (record.userNameUpdateId !== undefined && updateId < record.userNameUpdateId) return "stale";
		if (record.userNameUpdateId === updateId) return "duplicate";
		record.name = name;
		record.nameOwner = "user";
		record.nameReconcilePending = true;
		record.userNameUpdateId = updateId;
		return "updated";
	}

	/** Mark the matching preserved user name as reconciled with Telegram. */
	markUserNameReconciled(sessionId: string, name: string): boolean {
		const record = this.topics.get(sessionId);
		if (record?.nameOwner !== "user" || record.name !== name || !record.nameReconcilePending) return false;
		record.nameReconcilePending = false;
		return true;
	}

	/** Restore retryable reconciliation after a failed pending-clear persistence. */
	markUserNamePending(sessionId: string, name: string): boolean {
		const record = this.topics.get(sessionId);
		if (record?.nameOwner !== "user" || record.name !== name || record.nameReconcilePending) return false;
		record.nameReconcilePending = true;
		return true;
	}

	/** Commit a successfully-applied daemon topic title. */
	markNameApplied(sessionId: string, name: string): void {
		const record = this.topics.get(sessionId);
		if (!record || record.nameOwner === "user") return;
		record.name = name;
		record.nameReconcilePending = false;
	}

	/** Capture only authority fields that a failed delete publication may restore. */
	captureDeleteAuthority(sessionId: string): TopicDeleteAuthoritySnapshot {
		const record = this.topics.get(sessionId);
		return {
			sessionId,
			topicId: record?.topicId,
			authorityEpoch: record?.authorityEpoch,
			authorityState: record?.authorityState,
			fenceEpoch: this.epochs.get(sessionId),
			...(record ? { record: { ...record } } : {}),
		};
	}

	/** Restore a failed delete fence only while its exact authority mutation remains current. */
	restoreDeleteAuthority(snapshot: TopicDeleteAuthoritySnapshot): boolean {
		const record = this.topics.get(snapshot.sessionId);
		const deleteEpoch = Math.max(snapshot.fenceEpoch ?? 0, snapshot.authorityEpoch ?? 0) + 1;
		if (this.epochs.get(snapshot.sessionId) !== deleteEpoch) return false;
		if (snapshot.topicId === undefined) {
			if (record) return false;
		} else if (
			!record ||
			record.topicId !== snapshot.topicId ||
			record.authorityState !== "delete_pending" ||
			record.authorityEpoch !== deleteEpoch
		) {
			return false;
		} else {
			record.authorityEpoch = snapshot.authorityEpoch;
			record.authorityState = snapshot.authorityState;
			this.rebuildInboundRoutes();
		}
		if (snapshot.fenceEpoch === undefined) this.epochs.delete(snapshot.sessionId);
		else this.epochs.set(snapshot.sessionId, snapshot.fenceEpoch);
		return true;
	}

	/** Restore the exact delete fence after a failed compensation publication. */
	restoreDeleteFence(snapshot: TopicDeleteAuthoritySnapshot): boolean {
		const record = this.topics.get(snapshot.sessionId);
		const deleteEpoch = Math.max(snapshot.fenceEpoch ?? 0, snapshot.authorityEpoch ?? 0) + 1;
		if (snapshot.topicId === undefined) {
			if (record) return false;
		} else if (!record) {
			if (!snapshot.record) return false;
			this.topics.set(snapshot.sessionId, {
				...snapshot.record,
				authorityEpoch: deleteEpoch,
				authorityState: "delete_pending",
			});
		} else if (record.topicId !== snapshot.topicId) {
			return false;
		} else {
			record.authorityEpoch = deleteEpoch;
			record.authorityState = "delete_pending";
			if (this.byTopic.get(record.topicId) === snapshot.sessionId) this.byTopic.delete(record.topicId);
		}
		this.epochs.set(snapshot.sessionId, deleteEpoch);
		return true;
	}

	/** Fence new work before the remote delete starts, including an absent in-flight create. */
	beginDelete(sessionId: string): TopicRecord | undefined {
		const record = this.topics.get(sessionId);
		const epoch = Math.max(this.epochs.get(sessionId) ?? 0, record?.authorityEpoch ?? 0) + 1;
		this.epochs.set(sessionId, epoch);
		if (!record) return undefined;
		record.authorityEpoch = epoch;
		record.authorityState = "delete_pending";
		if (this.byTopic.get(record.topicId) === sessionId) this.byTopic.delete(record.topicId);
		return record;
	}

	/** Retain an accepted create as deletion-fenced before remote compensation can begin. */
	fenceAcceptedCreate(
		sessionId: string,
		topicId: string,
		now: () => number = Date.now,
		name?: string,
		binding?: TopicEndpointBinding,
	): TopicRecord {
		const epoch = Math.max(this.epochs.get(sessionId) ?? 0, this.topics.get(sessionId)?.authorityEpoch ?? 0);
		const record: TopicRecord = {
			topicId,
			name,
			identitySent: false,
			createdAt: now(),
			authorityEpoch: epoch,
			authorityState: "delete_pending",
			...(binding
				? {
						chatId: binding.chatId,
						endpointKey: binding.endpointKey,
						endpointDigest: binding.endpointDigest,
						endpointIncarnation: 0,
						...(binding.endpointGeneration === undefined
							? {}
							: { endpointGeneration: binding.endpointGeneration }),
					}
				: {}),
		};
		this.topics.set(sessionId, record);
		if (this.byTopic.get(topicId) === sessionId) this.byTopic.delete(topicId);
		this.#ambiguousTopicIds.add(topicId);
		return record;
	}

	/** Fence an accepted create only when its exact creator lease still owns the record. */
	fenceAcceptedCreateForLease(
		sessionId: string,
		topicId: string,
		creationLeaseEpoch: number,
		now: () => number = Date.now,
		name?: string,
		binding?: TopicEndpointBinding,
	): TopicRecord | undefined {
		const record = this.topics.get(sessionId);
		const matchesBinding =
			record?.chatId === binding?.chatId &&
			record?.endpointKey === binding?.endpointKey &&
			record?.endpointDigest === binding?.endpointDigest &&
			record?.endpointGeneration === binding?.endpointGeneration;
		if (
			record
				? record.topicId !== topicId || record.creationLeaseEpoch !== creationLeaseEpoch || !matchesBinding
				: (this.epochs.get(sessionId) ?? 0) !== creationLeaseEpoch
		)
			return undefined;
		this.beginDelete(sessionId);
		const fenced = this.fenceAcceptedCreate(sessionId, topicId, now, name, binding);
		fenced.creationLeaseEpoch = creationLeaseEpoch;
		return fenced;
	}

	/** Wait for a revoked create to settle before admitting a later lifecycle epoch. */
	async awaitInflight(sessionId: string): Promise<void> {
		await this.inflight.get(sessionId)?.catch(() => undefined);
	}

	/** Remove only after a definite remote deletion; ambiguity deliberately retains its fence. */
	settleDelete(sessionId: string, topicId: string): boolean {
		const record = this.topics.get(sessionId);
		if (!record || record.topicId !== topicId || record.authorityState !== "delete_pending") return false;
		this.topics.delete(sessionId);
		return true;
	}

	/** Remove a topic record immediately for local/test cleanup compatibility. */
	delete(sessionId: string): boolean {
		const record = this.topics.get(sessionId);
		if (!record) return false;
		this.epochs.set(sessionId, Math.max(this.epochs.get(sessionId) ?? 0, record.authorityEpoch ?? 0) + 1);
		if (this.byTopic.get(record.topicId) === sessionId) this.byTopic.delete(record.topicId);
		return this.topics.delete(sessionId);
	}

	/** Serialise active records plus unpublished staged creates for atomic commit. */
	serialize(): TopicRegistryState {
		return { topics: Object.fromEntries([...this.topics, ...this.staged]), fences: Object.fromEntries(this.epochs) };
	}
}
