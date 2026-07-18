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
	/** An uncertain delete fences future creation and inbound routing. */
	authorityState?: "active" | "delete_pending";
}

/** Serialisable shape persisted to disk. */
export interface TopicRegistryState {
	/** sessionId -> record. */
	topics: Record<string, TopicRecord>;
	/** Durable deletion epochs retained after a definite delete. */
	fences?: Record<string, number>;
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
	/** Monotonic authority epochs, including deletion fences for absent records. */
	private readonly epochs = new Map<string, number>();

	constructor(state: TopicRegistryState = emptyTopicRegistryState()) {
		this.topics = new Map();
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
				typeof raw.userNameUpdateId === "number" &&
				Number.isSafeInteger(raw.userNameUpdateId) &&
				raw.userNameUpdateId >= 0;
			const hasValidReplayCursor =
				typeof raw.replayGeneration === "number" &&
				Number.isSafeInteger(raw.replayGeneration) &&
				raw.replayGeneration >= 1 &&
				typeof raw.replaySeq === "number" &&
				Number.isSafeInteger(raw.replaySeq) &&
				raw.replaySeq >= 0;
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
				...(hasValidUserAuthority ? { userNameUpdateId: raw.userNameUpdateId } : {}),
				...(typeof raw.identityKey === "string" ? { identityKey: raw.identityKey } : {}),
				...(hasValidReplayCursor ? { replayGeneration: raw.replayGeneration, replaySeq: raw.replaySeq } : {}),
				...(Number.isSafeInteger(raw.authorityEpoch) && raw.authorityEpoch! >= 0
					? { authorityEpoch: raw.authorityEpoch }
					: {}),
				...(raw.authorityState === "delete_pending" ? { authorityState: "delete_pending" as const } : {}),
			};
			this.epochs.set(sessionId, Math.max(this.epochs.get(sessionId) ?? 0, record.authorityEpoch ?? 0));

			this.topics.set(sessionId, record);
		}
		this.rebuildInboundRoutes();
	}

	private rebuildInboundRoutes(): void {
		this.byTopic.clear();
		this.#ambiguousTopicIds.clear();
		const activeByTopic = new Map<string, string>();

		for (const [sessionId, record] of this.topics) {
			if (record.authorityState === "delete_pending") {
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

	/** The existing topic record for a session, if any. */
	get(sessionId: string): TopicRecord | undefined {
		return this.topics.get(sessionId);
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
	): Promise<TopicRecord> {
		const existing = this.topics.get(sessionId);
		if (existing?.authorityState === "delete_pending") throw new Error("topic authority is deletion-fenced");
		if (existing) return existing;
		const pending = this.inflight.get(sessionId);
		if (pending) return pending;
		const epoch = this.epochs.get(sessionId) ?? 0;
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
				...(revoked ? { authorityState: "delete_pending" as const } : {}),
			};
			this.topics.set(sessionId, record);
			if (revoked) throw new Error("topic authority was revoked during creation");
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

	/** Serialise for atomic persistence beside the daemon state. */
	serialize(): TopicRegistryState {
		return { topics: Object.fromEntries(this.topics), fences: Object.fromEntries(this.epochs) };
	}
}
