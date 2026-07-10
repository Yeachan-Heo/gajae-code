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
}

/** Serialisable shape persisted to disk. */
export interface TopicRegistryState {
	/** sessionId -> record. */
	topics: Record<string, TopicRecord>;
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
	/** In-flight create promises, keyed by session, to dedupe concurrent creates. */
	private readonly inflight = new Map<string, Promise<TopicRecord>>();

	constructor(state: TopicRegistryState = emptyTopicRegistryState()) {
		this.topics = new Map();
		this.load(state);
	}

	/** Merge serialized state and normalize authority fields from older releases. */
	load(state: TopicRegistryState): void {
		for (const [sessionId, raw] of Object.entries(state.topics ?? {})) {
			if (!raw || typeof raw.topicId !== "string") continue;
			const hasValidUserAuthority =
				raw.nameOwner === "user" &&
				typeof raw.name === "string" &&
				raw.name.trim().length > 0 &&
				typeof raw.userNameUpdateId === "number" &&
				Number.isSafeInteger(raw.userNameUpdateId) &&
				raw.userNameUpdateId >= 0;
			const record: TopicRecord = {
				topicId: raw.topicId,
				identitySent: raw.identitySent === true,
				createdAt: typeof raw.createdAt === "number" ? raw.createdAt : 0,
				...(typeof raw.name === "string" ? { name: raw.name } : {}),
				...(hasValidUserAuthority ? { nameOwner: "user" as const } : {}),
				...(hasValidUserAuthority && raw.nameReconcilePending === true ? { nameReconcilePending: true } : {}),
				...(hasValidUserAuthority ? { userNameUpdateId: raw.userNameUpdateId } : {}),
				...(typeof raw.identityKey === "string" ? { identityKey: raw.identityKey } : {}),
			};
			this.topics.set(sessionId, record);
			this.byTopic.set(record.topicId, sessionId);
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
		create: () => Promise<string>,
		now: () => number = Date.now,
		name?: string,
	): Promise<TopicRecord> {
		const existing = this.topics.get(sessionId);
		if (existing) return existing;
		// Concurrency guard: many session frames (identity/idle/turn/ask) can race
		// to first-use the same session. Without this, each call passes the
		// `existing` check before `create()` resolves and creates a DUPLICATE
		// forum topic. Share a single in-flight create per session id.
		const pending = this.inflight.get(sessionId);
		if (pending) return pending;
		const promise = (async () => {
			const topicId = await create();
			const record: TopicRecord = { topicId, name, identitySent: false, createdAt: now() };
			this.topics.set(sessionId, record);
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

	/** Remove a session topic record after Telegram deletes the topic. */
	delete(sessionId: string): boolean {
		const record = this.topics.get(sessionId);
		if (!record) return false;
		this.topics.delete(sessionId);
		this.byTopic.delete(record.topicId);
		return true;
	}

	/** Serialise for atomic persistence beside the daemon state. */
	serialize(): TopicRegistryState {
		return { topics: Object.fromEntries(this.topics) };
	}
}
