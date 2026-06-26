/**
 * Per-session forum-topic registry for the threaded session surface.
 *
 * Each GJC session owns exactly one Telegram forum topic in the paired private
 * DM. The topic is created once (via `createForumTopic`) and REUSED on resume,
 * keyed by session id, so a resumed session streams back into its existing
 * thread/history. The registry also tracks whether the one-time identity header
 * has already been pinned, so it is sent exactly once per topic even across
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
	/** Last applied topic title (for rename detection). */
	name?: string;
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
		this.topics = new Map(Object.entries(state.topics ?? {}));
		for (const [sessionId, record] of this.topics) this.byTopic.set(record.topicId, sessionId);
	}

	/** Merge a serialized state into this registry, preserving all persisted fields. */
	load(state: TopicRegistryState): void {
		for (const [sessionId, record] of Object.entries(state.topics ?? {})) {
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
	 * Return the existing topic for `sessionId`, or create one via `create`
	 * (called only on first use). Reuse-on-resume: an existing record is
	 * returned without invoking `create`.
	 */
	async getOrCreateTopic(
		sessionId: string,
		create: () => Promise<string>,
		now: () => number = Date.now,
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
			const record: TopicRecord = { topicId, identitySent: false, createdAt: now() };
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

	/**
	 * Record the topic's applied title. Returns `true` when it changed (so the
	 * caller should `editForumTopic`), `false` when already current or unknown.
	 */
	applyName(sessionId: string, name: string): boolean {
		const record = this.topics.get(sessionId);
		if (!record || record.name === name) return false;
		record.name = name;
		return true;
	}

	/** Serialise for atomic persistence beside the daemon state. */
	serialize(): TopicRegistryState {
		return { topics: Object.fromEntries(this.topics) };
	}
}
