import { randomUUID } from "node:crypto";
/**
 * Per-session forum-topic registry for the threaded session surface.
 *
 * Each GJC session owns one active Telegram forum topic. Remote archive closes
 * daemon-created topics without deleting their durable records; rotated
 * successors move inactive records into retained history before creating a new
 * active authority. The registry also tracks whether the one-time identity
 * header has already been pinned.
 *
 * State is a plain serialisable map persisted beside the daemon state files;
 * topic creation is injected so this module is pure and unit-testable without a
 * live Bot API.
 */

/** Persisted record for one session's topic. */
export type TopicLifecycleState =
	| "active"
	| "disconnect_grace"
	| "archive_pending"
	| "archive_exhausted"
	| "inactive"
	| "legacy_quarantined"
	/** Read-only input compatibility; normalized to archive_pending during load. */
	| "delete_pending";

/** Persisted record for one immutable session identity's topic. */
export interface TopicRecord {
	/** Telegram forum topic id (message_thread_id). */
	topicId: string;
	/** Whether Telegram created this topic for the daemon or it was explicitly adopted from a user. */
	topicOrigin: "daemon_created" | "user_created";
	/** Immutable UUID record identity; never derive authority from a title or PID. */
	sessionUuid?: string;
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
	/** Durable non-destructive lifecycle state. */
	authorityState?: TopicLifecycleState;
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
	/** Shared-authority lease owner (installation UUID), heartbeat, and expiry. */
	leaseOwner?: string;
	leaseHeartbeatAt?: number;
	leaseExpiresAt?: number;
	/** Durable archive initiator; a live foreign owner cannot be displaced. */
	archiveHostId?: string;
	/** Authority epoch captured by the archive initiator when it published the fence. */
	archiveLeaseEpoch?: number;
	disconnectGraceExpiresAt?: number;
	/** True when persisted binding fields were present but malformed; recovery must fail closed. */
	bindingMalformed?: true;
}
/** Durable claim published before invoking createForumTopic. */
export interface TopicCreateClaim {
	sessionId: string;
	hostId?: string;
	leaseOwner?: string;
	authorityEpoch: number;
	createdAt: number;
	binding?: TopicEndpointBinding;
}

export interface ArchiveJob {
	sessionId: string;
	topicId: string;
	/** Number of archive calls that have returned an ambiguous outcome. */
	attempt: number;
	/** First ambiguous result; bounds retry lifetime. */
	firstAttemptAt?: number;
	/** Compatibility read for pre-journal snapshots; normalized to `attempt`. */
	retryCount?: number;
	backoffMs: number;
	nextAttemptAt: number;
	safeDiagnostic?: string;
}

/** Serialisable shape persisted to disk. */
export interface TopicRegistryState {
	/** Writer format. Missing is the quarantined legacy format; future versions fail closed. */
	version?: 2;
	/** Monotonically increasing snapshot generation used by shared CAS stores. */
	registryGeneration?: number;
	/** sessionId -> record. */
	topics: Record<string, TopicRecord>;
	/** Durable lifecycle epochs retained after an archive starts. */
	fences?: Record<string, number>;
	/** Closed transport endpoint leases; unchanged endpoint discovery remains fenced across restart. */
	closedEndpoints?: Record<string, TopicEndpointBinding>;
	/** Persistent host identity used to distinguish concurrent installations. */
	installationHostId?: string;
	/** Bounded durable archive work; no topic record is physically deleted. */
	archiveJobs?: Record<string, ArchiveJob>;
	/** Durable create claims. A claim fences concurrent creators before remote I/O. */
	createClaims?: Record<string, TopicCreateClaim>;
	/** Retained inactive predecessors keyed by logical session id. */
	retiredTopics?: Record<string, TopicRecord[]>;
}
/**
 * Shared registry authority. Filesystem atomic rename is sufficient for a single
 * installation, but it cannot serialize two hosts sharing a state volume.
 */
export interface TopicRegistryCasAuthority {
	read(): Promise<TopicRegistryState | undefined>;
	compareAndSet(expectedGeneration: number, next: TopicRegistryState): Promise<boolean>;
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
export interface TopicArchiveAuthoritySnapshot {
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
function nextAuthorityEpoch(current: number): number {
	return current >= Number.MAX_SAFE_INTEGER ? Number.MAX_SAFE_INTEGER : current + 1;
}

export function emptyTopicRegistryState(): TopicRegistryState {
	return { version: 2, topics: {} };
}
/**
 * Reject snapshots written by a newer daemon. Missing versions are preserved as
 * evidence but quarantined: legacy records must never route or mutate remotely.
 */
export function parseTopicRegistryState(value: unknown): TopicRegistryState | undefined {
	if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
	const state = value as TopicRegistryState;
	if (state.version !== undefined && state.version !== 2) throw new Error("unsupported future Telegram topic state");
	if (!state.topics || typeof state.topics !== "object" || Array.isArray(state.topics)) return undefined;
	if (state.version === undefined) {
		if (state.registryGeneration !== undefined) throw new Error("malformed Telegram topic state");
		return parseTopicRegistryState({
			...state,
			version: 2,
			registryGeneration: 0,
			topics: Object.fromEntries(
				Object.entries(state.topics).map(([sessionId, record]) => [
					sessionId,
					record && typeof record === "object"
						? {
								...record,
								topicOrigin: (record as TopicRecord).topicOrigin ?? "daemon_created",
								authorityState: "legacy_quarantined",
							}
						: record,
				]),
			),
		});
	}

	const isObject = (candidate: unknown): candidate is Record<string, unknown> =>
		!!candidate && typeof candidate === "object" && !Array.isArray(candidate);
	const validTimestamp = (candidate: unknown): candidate is number =>
		typeof candidate === "number" && Number.isFinite(candidate) && candidate >= 0;
	const validEpoch = (candidate: unknown): candidate is number =>
		typeof candidate === "number" && Number.isSafeInteger(candidate) && candidate >= 0;
	const validOptionalString = (candidate: unknown): boolean =>
		candidate === undefined || isValidBindingString(candidate);
	const validBinding = (candidate: unknown): candidate is TopicEndpointBinding =>
		isObject(candidate) &&
		isValidBindingString(candidate.chatId) &&
		isValidBindingString(candidate.endpointKey) &&
		isValidBindingString(candidate.endpointDigest) &&
		(candidate.endpointGeneration === undefined || isValidBindingGeneration(candidate.endpointGeneration));
	const malformed = (): never => {
		throw new Error("malformed Telegram topic state");
	};

	if (
		(state.registryGeneration !== undefined && !validEpoch(state.registryGeneration)) ||
		!isObject(state.topics) ||
		[state.fences, state.closedEndpoints, state.archiveJobs, state.createClaims, state.retiredTopics].some(
			nested => nested !== undefined && !isObject(nested),
		)
	)
		malformed();
	for (const [sessionId, raw] of Object.entries(state.topics)) {
		if (!isValidBindingString(sessionId) || !isObject(raw) || !isValidTopicId(raw.topicId)) malformed();
		if (typeof raw.identitySent !== "boolean" || !validTimestamp(raw.createdAt)) malformed();
		if (
			!validOptionalString(raw.sessionUuid) ||
			(raw.orphanedAt !== undefined && !validTimestamp(raw.orphanedAt)) ||
			(raw.name !== undefined && typeof raw.name !== "string") ||
			(raw.topicOrigin !== "daemon_created" && raw.topicOrigin !== "user_created") ||
			(raw.nameOwner !== undefined && raw.nameOwner !== "user") ||
			(raw.nameReconcilePending !== undefined && typeof raw.nameReconcilePending !== "boolean") ||
			(raw.userNameUpdateId !== undefined && !validEpoch(raw.userNameUpdateId)) ||
			!validOptionalString(raw.identityKey) ||
			(raw.replayGeneration !== undefined &&
				(!Number.isSafeInteger(raw.replayGeneration) || raw.replayGeneration < 1)) ||
			(raw.replaySeq !== undefined && !validEpoch(raw.replaySeq)) ||
			(raw.authorityEpoch !== undefined && !validEpoch(raw.authorityEpoch)) ||
			(raw.creationLeaseEpoch !== undefined && !validEpoch(raw.creationLeaseEpoch)) ||
			(raw.authorityState !== undefined &&
				![
					"active",
					"disconnect_grace",
					"archive_pending",
					"archive_exhausted",
					"inactive",
					"legacy_quarantined",
					"delete_pending",
				].includes(raw.authorityState as string)) ||
			!validOptionalString(raw.leaseOwner) ||
			(raw.leaseHeartbeatAt !== undefined && !validTimestamp(raw.leaseHeartbeatAt)) ||
			(raw.leaseExpiresAt !== undefined && !validTimestamp(raw.leaseExpiresAt)) ||
			!validOptionalString(raw.archiveHostId) ||
			(raw.archiveLeaseEpoch !== undefined && !validEpoch(raw.archiveLeaseEpoch)) ||
			(raw.disconnectGraceExpiresAt !== undefined && !validTimestamp(raw.disconnectGraceExpiresAt)) ||
			(raw.bindingMalformed !== undefined && raw.bindingMalformed !== true)
		)
			malformed();
		const leaseFieldCount = [raw.leaseOwner, raw.leaseHeartbeatAt, raw.leaseExpiresAt].filter(
			value => value !== undefined,
		).length;
		if (leaseFieldCount !== 0 && leaseFieldCount !== 3) malformed();
		if (
			raw.authorityState === "disconnect_grace"
				? raw.disconnectGraceExpiresAt === undefined || raw.orphanedAt === undefined
				: raw.disconnectGraceExpiresAt !== undefined
		)
			malformed();
		const hasBinding = hasAnyBinding(raw);
		const hasArchiveOnlyChatIdentity =
			(raw.authorityState === "archive_pending" ||
				raw.authorityState === "archive_exhausted" ||
				raw.authorityState === "inactive") &&
			isValidBindingString(raw.chatId) &&
			raw.endpointKey === undefined &&
			raw.endpointDigest === undefined &&
			raw.endpointGeneration === undefined &&
			raw.endpointIncarnation === undefined;
		if (
			hasBinding &&
			!hasArchiveOnlyChatIdentity &&
			(!isValidBindingString(raw.chatId) ||
				!isValidBindingString(raw.endpointKey) ||
				!isValidBindingString(raw.endpointDigest) ||
				(raw.endpointGeneration !== undefined && !isValidBindingGeneration(raw.endpointGeneration)) ||
				(raw.endpointIncarnation !== undefined && !isValidBindingGeneration(raw.endpointIncarnation)))
		)
			malformed();
	}
	for (const [sessionId, records] of Object.entries(state.retiredTopics ?? {})) {
		if (!isValidBindingString(sessionId) || !Array.isArray(records)) malformed();
		for (const [index, record] of records.entries()) {
			parseTopicRegistryState({
				version: 2,
				registryGeneration: 0,
				topics: { [`${sessionId}:retired:${index}`]: record },
			});
		}
	}
	for (const [sessionId, epoch] of Object.entries(state.fences ?? {}))
		if (!isValidBindingString(sessionId) || !validEpoch(epoch)) malformed();
	for (const [sessionId, claim] of Object.entries(state.createClaims ?? {})) {
		if (
			!isValidBindingString(sessionId) ||
			!isObject(claim) ||
			claim.sessionId !== sessionId ||
			!validEpoch(claim.authorityEpoch) ||
			!validTimestamp(claim.createdAt) ||
			!validOptionalString(claim.hostId) ||
			!validOptionalString(claim.leaseOwner) ||
			(claim.binding !== undefined && !validBinding(claim.binding))
		)
			malformed();
	}
	for (const [sessionId, job] of Object.entries(state.archiveJobs ?? {})) {
		if (
			!isValidBindingString(sessionId) ||
			!isObject(job) ||
			job.sessionId !== sessionId ||
			!isValidTopicId(job.topicId) ||
			!validEpoch(job.attempt) ||
			!validEpoch(job.backoffMs) ||
			!validTimestamp(job.nextAttemptAt) ||
			(job.firstAttemptAt !== undefined && !validTimestamp(job.firstAttemptAt)) ||
			(job.retryCount !== undefined && !validEpoch(job.retryCount)) ||
			(job.safeDiagnostic !== undefined && typeof job.safeDiagnostic !== "string")
		)
			malformed();
	}
	for (const [sessionId, binding] of Object.entries(state.closedEndpoints ?? {}))
		if (!isValidBindingString(sessionId) || !validBinding(binding)) malformed();
	return state;
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
	/** Archive work is retained and retryable; records are never physically removed. */
	private readonly archiveJobs = new Map<string, ArchiveJob>();
	/** Durable pre-create claims; remote creation is forbidden until published. */
	private readonly createClaims = new Map<string, TopicCreateClaim>();
	/** Inactive predecessor evidence retained across successor generations. */
	private readonly retiredTopics = new Map<string, TopicRecord[]>();
	/** Generation of the last loaded/published snapshot. */
	private registryGeneration = 0;

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
		this.archiveJobs.clear();
		this.createClaims.clear();
		this.retiredTopics.clear();
		this.load(state);
	}

	/** Merge serialized state and normalize authority fields from older releases. */
	load(state: TopicRegistryState): void {
		for (const [sessionId, records] of Object.entries(state.retiredTopics ?? {}))
			if (Array.isArray(records))
				this.retiredTopics.set(
					sessionId,
					records.map(record => ({ ...record })),
				);
		for (const [sessionId, job] of Object.entries(state.archiveJobs ?? {})) {
			const attempt =
				job && Number.isSafeInteger(job.attempt) && job.attempt >= 0
					? job.attempt
					: job &&
							typeof job.retryCount === "number" &&
							Number.isSafeInteger(job.retryCount) &&
							job.retryCount >= 0
						? job.retryCount
						: undefined;
			if (
				job &&
				job.sessionId === sessionId &&
				isValidTopicId(job.topicId) &&
				attempt !== undefined &&
				Number.isFinite(job.nextAttemptAt)
			)
				this.archiveJobs.set(sessionId, {
					sessionId,
					topicId: job.topicId,
					attempt: Math.min(8, attempt),
					firstAttemptAt:
						typeof job.firstAttemptAt === "number" && Number.isFinite(job.firstAttemptAt)
							? job.firstAttemptAt
							: job.nextAttemptAt,
					backoffMs:
						Number.isSafeInteger(job.backoffMs) && job.backoffMs >= 0
							? Math.min(60_000, job.backoffMs)
							: Math.min(60_000, 250 * 2 ** Math.min(8, attempt)),
					nextAttemptAt: job.nextAttemptAt,
					...(typeof job.safeDiagnostic === "string" ? { safeDiagnostic: job.safeDiagnostic.slice(0, 256) } : {}),
				});
		}
		if (Number.isSafeInteger(state.registryGeneration) && (state.registryGeneration ?? -1) >= 0)
			this.registryGeneration = Math.max(this.registryGeneration, state.registryGeneration!);
		for (const [sessionId, epoch] of Object.entries(state.fences ?? {})) {
			if (Number.isSafeInteger(epoch) && epoch >= 0) this.epochs.set(sessionId, epoch);
		}
		for (const [sessionId, claim] of Object.entries(state.createClaims ?? {})) {
			if (
				claim &&
				claim.sessionId === sessionId &&
				Number.isSafeInteger(claim.authorityEpoch) &&
				claim.authorityEpoch >= 0 &&
				Number.isFinite(claim.createdAt) &&
				(claim.binding === undefined || hasValidBinding(claim.binding))
			)
				this.createClaims.set(sessionId, {
					sessionId,
					authorityEpoch: claim.authorityEpoch,
					createdAt: claim.createdAt,
					...(isValidBindingString(claim.hostId) ? { hostId: claim.hostId } : {}),
					...(isValidBindingString(claim.leaseOwner) ? { leaseOwner: claim.leaseOwner } : {}),
					...(claim.binding ? { binding: claim.binding } : {}),
				});
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
			const legacyDeletePending = (raw as { authorityState?: unknown }).authorityState === "delete_pending";
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
				topicOrigin: raw.topicOrigin === "user_created" ? "user_created" : "daemon_created",
				sessionUuid:
					typeof raw.sessionUuid === "string" && raw.sessionUuid.length > 0 ? raw.sessionUuid : randomUUID(),
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
				...(raw.authorityState === "disconnect_grace" ||
				raw.authorityState === "archive_pending" ||
				raw.authorityState === "archive_exhausted" ||
				raw.authorityState === "inactive" ||
				raw.authorityState === "legacy_quarantined" ||
				legacyDeletePending ||
				fenceSupersedesRecord
					? {
							authorityState:
								raw.authorityState === "inactive"
									? ("inactive" as const)
									: raw.authorityState === "legacy_quarantined"
										? ("legacy_quarantined" as const)
										: raw.authorityState === "archive_exhausted"
											? ("archive_exhausted" as const)
											: raw.authorityState === "disconnect_grace" && !fenceSupersedesRecord
												? ("disconnect_grace" as const)
												: ("archive_pending" as const),
						}
					: { authorityState: "active" as const }),
				...(isValidBindingString(raw.chatId) ? { chatId: raw.chatId } : {}),
				...(isValidBindingString(raw.endpointKey) ? { endpointKey: raw.endpointKey } : {}),
				...(isValidBindingString(raw.endpointDigest) ? { endpointDigest: raw.endpointDigest } : {}),
				...(isValidBindingGeneration(raw.endpointGeneration) ? { endpointGeneration: raw.endpointGeneration } : {}),
				...(isValidBindingGeneration(raw.endpointIncarnation)
					? { endpointIncarnation: raw.endpointIncarnation }
					: {}),
				...(isValidBindingString(raw.leaseOwner) ? { leaseOwner: raw.leaseOwner } : {}),
				...(typeof raw.leaseHeartbeatAt === "number" && Number.isFinite(raw.leaseHeartbeatAt)
					? { leaseHeartbeatAt: raw.leaseHeartbeatAt }
					: {}),
				...(typeof raw.leaseExpiresAt === "number" && Number.isFinite(raw.leaseExpiresAt)
					? { leaseExpiresAt: raw.leaseExpiresAt }
					: {}),
				...(isValidBindingString(raw.archiveHostId) ? { archiveHostId: raw.archiveHostId } : {}),
				...(isValidBindingGeneration(raw.archiveLeaseEpoch) ? { archiveLeaseEpoch: raw.archiveLeaseEpoch } : {}),
				...(typeof raw.disconnectGraceExpiresAt === "number" && Number.isFinite(raw.disconnectGraceExpiresAt)
					? { disconnectGraceExpiresAt: raw.disconnectGraceExpiresAt }
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
			if (record.authorityState !== "active" || record.bindingMalformed) {
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
	/** Durable claims restored from disk require explicit authoritative reconciliation. */
	pendingCreateClaims(): TopicCreateClaim[] {
		return [...this.createClaims.values()].map(claim => ({
			...claim,
			...(claim.binding ? { binding: { ...claim.binding } } : {}),
		}));
	}

	/**
	 * Resolve a durable pre-create claim only with authoritative topic evidence.
	 * An absent or malformed topic deliberately leaves the claim in place, fencing
	 * subsequent creators after a crash.
	 */
	reconcileCreateClaim(sessionId: string, topic?: TopicRecord): boolean {
		const claim = this.createClaims.get(sessionId);
		if (!claim || !topic || !isValidTopicId(topic.topicId) || topic.authorityState !== "active") return false;
		if (topic.authorityEpoch !== claim.authorityEpoch) return false;
		if (
			claim.binding &&
			(!hasCompleteBinding(topic) ||
				!hasValidBinding(claim.binding) ||
				topic.chatId !== claim.binding.chatId ||
				topic.endpointKey !== claim.binding.endpointKey ||
				topic.endpointDigest !== claim.binding.endpointDigest ||
				topic.endpointGeneration !== claim.binding.endpointGeneration)
		)
			return false;
		this.topics.set(sessionId, { ...topic });
		this.createClaims.delete(sessionId);
		this.rebuildInboundRoutes();
		return true;
	}
	/** Clear a claim only when the local create attempt proved no remote topic was accepted. */
	abandonCreateClaim(sessionId: string, authorityEpoch: number): boolean {
		const claim = this.createClaims.get(sessionId);
		if (!claim || claim.authorityEpoch !== authorityEpoch) return false;
		this.createClaims.delete(sessionId);
		this.creatingBindings.delete(sessionId);
		return true;
	}

	/** Current immutable authority epoch for a creation lease. */
	authorityEpoch(sessionId: string): number {
		return Math.max(this.epochs.get(sessionId) ?? 0, this.topics.get(sessionId)?.authorityEpoch ?? 0);
	}

	/** Whether this session has an active, unambiguous topic authority. */
	isActiveUnambiguous(sessionId: string): boolean {
		const record = this.topics.get(sessionId);
		return record?.authorityState === "active" && this.byTopic.get(record?.topicId ?? "") === sessionId;
	}
	/**
	 * Pure read-only availability check for user-topic adoption. Rejects invalid
	 * ids and any id already committed, delete-pending/fenced, staged, or
	 * ambiguous, without mutating maps, epochs, or persistence. Used inside the
	 * {@link getOrCreateTopic} create callback to fail-closed before adopting a
	 * user-created topic id.
	 */
	isTopicIdAvailable(topicId: string): boolean {
		if (!isValidTopicId(topicId)) return false;
		if (this.#ambiguousTopicIds.has(topicId)) return false;
		if (this.byTopic.has(topicId)) return false;
		for (const record of this.topics.values()) if (record.topicId === topicId) return false;
		for (const record of this.staged.values()) if (record.topicId === topicId) return false;
		return true;
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
		const durableClaims = [...this.createClaims].filter(
			([sessionId, claim]) => claim.binding !== undefined && canClaim(claim.binding) && !excludesClaimant(sessionId),
		);
		if (committed.length === 0 && staged.length === 0 && creating.length === 0 && durableClaims.length === 0)
			return { state: "none" };
		if (committed.length !== 1 || staged.length !== 0 || creating.length !== 0 || durableClaims.length !== 0)
			return { state: "ambiguous" };
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
	 * Retire a remotely settled inactive topic only when an authenticated
	 * successor proves a different endpoint authority. The inactive predecessor
	 * is serialized into retained history before the active slot is released.
	 */
	retireInactiveEndpointForSuccessor(sessionId: string, binding: TopicEndpointBinding): boolean {
		const record = this.topics.get(sessionId);
		if (
			record?.authorityState !== "inactive" ||
			record.bindingMalformed ||
			!hasCompleteBinding(record) ||
			!hasValidBinding(binding) ||
			(record.endpointKey === binding.endpointKey && record.endpointDigest === binding.endpointDigest)
		)
			return false;
		const history = this.retiredTopics.get(sessionId) ?? [];
		history.push({ ...record });
		this.retiredTopics.set(sessionId, history);
		this.topics.delete(sessionId);
		this.byTopic.delete(record.topicId);
		this.archiveJobs.delete(sessionId);
		this.createClaims.delete(sessionId);
		return true;
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
			(record?.authorityState !== "active" && record?.authorityState !== "disconnect_grace") ||
			record.bindingMalformed ||
			!hasValidBinding(binding) ||
			(record.authorityState === "active" && !this.isActiveUnambiguous(sessionId))
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
		if (!changed && record.authorityState === "active") return "unchanged";
		record.chatId = binding.chatId;
		record.endpointKey = binding.endpointKey;
		record.endpointDigest = binding.endpointDigest;
		record.endpointGeneration = binding.endpointGeneration;
		if (!sameEndpoint) record.endpointIncarnation = (record.endpointIncarnation ?? 0) + 1;
		if (record.authorityState === "disconnect_grace") {
			record.authorityState = "active";
			delete record.orphanedAt;
			delete record.disconnectGraceExpiresAt;
			this.rebuildInboundRoutes();
		}
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
		topicOrigin?: TopicRecord["topicOrigin"],
	): Promise<TopicRecord> {
		const existing = this.topics.get(sessionId);
		if (existing && existing.authorityState !== "active") throw new Error("topic authority is archive-fenced");
		if (existing?.bindingMalformed) throw new Error("topic authority binding is quarantined");
		if (existing) return existing;
		const pending = this.inflight.get(sessionId);
		if (pending) return pending;
		// A claim loaded after a crash proves a create may have reached Telegram.
		// It must not be replaced or retried until explicit authoritative recovery.
		if (this.createClaims.has(sessionId)) throw new Error("topic create claim requires reconciliation");
		const epoch = this.epochs.get(sessionId) ?? 0;
		if (epoch >= Number.MAX_SAFE_INTEGER) throw new Error("topic authority epoch is exhausted");
		// Publish the compatible endpoint claim before invoking `create`: the callback
		// may immediately begin a remote create and identity-less recovery must never
		// observe a false absence during that await.
		if (binding) this.creatingBindings.set(sessionId, binding);
		this.transientClaimants.set(sessionId, transientClaimant);
		this.createClaims.set(sessionId, {
			sessionId,
			authorityEpoch: epoch,
			createdAt: now(),
			...(binding ? { binding } : {}),
		});
		const promise = (async () => {
			// Persist this ambiguity before createForumTopic; a crash must fence,
			// rather than silently permit, a duplicate remote topic.
			await commit?.();
			const topicId = await create();
			if (!isValidTopicId(topicId)) throw new Error("createForumTopic: invalid message_thread_id");
			const revoked = (this.epochs.get(sessionId) ?? 0) !== epoch;
			const record: TopicRecord = {
				topicId,
				topicOrigin: topicOrigin ?? "daemon_created",
				sessionUuid: randomUUID(),
				name,
				identitySent: false,
				createdAt: now(),
				authorityEpoch: revoked ? (this.epochs.get(sessionId) ?? 0) : epoch,
				creationLeaseEpoch: epoch,
				authorityState: revoked ? "archive_pending" : "active",
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
			if (revoked) {
				this.topics.set(sessionId, record);
				throw new Error("topic authority was revoked during creation");
			}
			this.staged.set(sessionId, record);
			this.createClaims.delete(sessionId);
			try {
				await commit?.();
			} catch (error) {
				this.staged.delete(sessionId);
				throw error;
			}
			this.staged.delete(sessionId);
			if ((this.epochs.get(sessionId) ?? 0) !== epoch) {
				record.authorityEpoch = this.epochs.get(sessionId) ?? 0;
				record.authorityState = "archive_pending";
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
			if (this.topics.has(sessionId)) this.createClaims.delete(sessionId);
		}
	}

	/** Mark the identity header as sent for a session. Idempotent. */
	markIdentitySent(sessionId: string): void {
		const record = this.topics.get(sessionId);
		if (record) record.identitySent = true;
	}
	/** Generation used as the compare value for a shared CAS publication. */
	registryVersion(): number {
		return this.registryGeneration;
	}

	/** Advance only after a successful shared compare-and-set publication. */
	markRegistryPublished(generation: number): void {
		if (!Number.isSafeInteger(generation) || generation < this.registryGeneration)
			throw new Error("invalid topic registry generation");
		this.registryGeneration = generation;
	}

	/**
	 * Acquire or renew a host lease. Another unexpired host is never displaced;
	 * a disconnected owner may resume the exact topic during its grace window.
	 */
	acquireLease(sessionId: string, hostId: string, now: number, ttlMs: number, graceMs: number): boolean {
		const record = this.topics.get(sessionId);
		if (
			!record ||
			!isValidBindingString(hostId) ||
			!Number.isFinite(now) ||
			ttlMs <= 0 ||
			graceMs < 0 ||
			record.authorityState === "archive_pending" ||
			record.authorityState === "archive_exhausted" ||
			record.authorityState === "inactive" ||
			record.authorityState === "legacy_quarantined"
		)
			return false;
		if (record.leaseOwner !== undefined && record.leaseOwner !== hostId && (record.leaseExpiresAt ?? 0) > now)
			return false;
		if (
			record.authorityState === "disconnect_grace" &&
			record.disconnectGraceExpiresAt !== undefined &&
			record.disconnectGraceExpiresAt < now
		)
			return false;
		record.leaseOwner = hostId;
		record.leaseHeartbeatAt = now;
		record.leaseExpiresAt = now + ttlMs;
		if (record.authorityState === "disconnect_grace") {
			record.authorityState = "active";
			delete record.orphanedAt;
			delete record.disconnectGraceExpiresAt;
			this.rebuildInboundRoutes();
		}
		return true;
	}

	/** Record a disconnect without losing the topic identity needed for a grace resume. */
	releaseLeaseToGrace(sessionId: string, hostId: string, now: number, graceMs: number): boolean {
		const record = this.topics.get(sessionId);
		if (!record || record.leaseOwner !== hostId || record.authorityState !== "active" || graceMs < 0) return false;
		record.authorityState = "disconnect_grace";
		record.orphanedAt = now;
		record.leaseHeartbeatAt = now;
		record.leaseExpiresAt = now;
		record.disconnectGraceExpiresAt = now + graceMs;
		this.rebuildInboundRoutes();
		return true;
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
		if (record?.authorityState !== "active" || record.orphanedAt !== undefined) return false;
		record.orphanedAt = now;
		record.authorityState = "disconnect_grace";
		record.disconnectGraceExpiresAt = now + 30_000;
		this.rebuildInboundRoutes();
		return true;
	}

	/** Clear a prior orphan observation after the endpoint is positively live again. */
	clearOrphaned(sessionId: string): boolean {
		const record = this.topics.get(sessionId);
		if (record?.authorityState !== "disconnect_grace" || record.orphanedAt === undefined) return false;
		record.authorityState = "active";
		delete record.disconnectGraceExpiresAt;
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

	/** Capture only authority fields that a failed archive-fence publication may restore. */
	captureArchiveAuthority(sessionId: string): TopicArchiveAuthoritySnapshot {
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

	/** Restore a failed archive fence only while its exact authority mutation remains current. */
	restoreArchiveAuthority(snapshot: TopicArchiveAuthoritySnapshot): boolean {
		const record = this.topics.get(snapshot.sessionId);
		const authorityBase = Math.max(snapshot.fenceEpoch ?? 0, snapshot.authorityEpoch ?? 0);
		if (authorityBase >= Number.MAX_SAFE_INTEGER) return false;
		const deleteEpoch = nextAuthorityEpoch(authorityBase);
		if (this.epochs.get(snapshot.sessionId) !== deleteEpoch) return false;
		if (snapshot.topicId === undefined) {
			if (record) return false;
		} else if (
			!record ||
			record.topicId !== snapshot.topicId ||
			record.authorityState !== "archive_pending" ||
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

	/** Restore the exact archive fence after a failed compensation publication. */
	restoreArchiveFence(snapshot: TopicArchiveAuthoritySnapshot): boolean {
		const record = this.topics.get(snapshot.sessionId);
		const authorityBase = Math.max(snapshot.fenceEpoch ?? 0, snapshot.authorityEpoch ?? 0);
		if (authorityBase >= Number.MAX_SAFE_INTEGER) return false;
		const deleteEpoch = nextAuthorityEpoch(authorityBase);
		if (this.epochs.get(snapshot.sessionId) !== deleteEpoch) return false;
		if (snapshot.topicId === undefined) {
			if (record) return false;
		} else if (!record) {
			if (!snapshot.record) return false;
			this.topics.set(snapshot.sessionId, {
				...snapshot.record,
				authorityEpoch: deleteEpoch,
				authorityState: "archive_pending",
			});
		} else if (record.topicId !== snapshot.topicId) {
			return false;
		} else {
			record.authorityEpoch = deleteEpoch;
			record.authorityState = "archive_pending";
			if (this.byTopic.get(record.topicId) === snapshot.sessionId) this.byTopic.delete(record.topicId);
		}
		this.epochs.set(snapshot.sessionId, deleteEpoch);
		return true;
	}

	/** Fence new work before the remote archive starts, including an absent in-flight create. */
	beginArchive(sessionId: string, hostId?: string, now = Date.now()): TopicRecord | undefined {
		const record = this.topics.get(sessionId);
		if (
			record?.topicOrigin === "user_created" ||
			((record?.archiveHostId !== undefined || record?.leaseOwner !== undefined) &&
				record.archiveHostId !== hostId &&
				record.leaseOwner !== hostId &&
				(record.leaseExpiresAt ?? 0) > now)
		)
			return undefined;
		const authorityBase = Math.max(this.epochs.get(sessionId) ?? 0, record?.authorityEpoch ?? 0);
		if (authorityBase >= Number.MAX_SAFE_INTEGER) {
			this.epochs.set(sessionId, Number.MAX_SAFE_INTEGER);
			if (record) {
				record.authorityEpoch = Number.MAX_SAFE_INTEGER;
				record.authorityState = "archive_exhausted";
				if (this.byTopic.get(record.topicId) === sessionId) this.byTopic.delete(record.topicId);
			}
			return undefined;
		}
		const epoch = nextAuthorityEpoch(authorityBase);
		this.epochs.set(sessionId, epoch);
		if (!record) return undefined;
		record.authorityEpoch = epoch;
		record.authorityState = "archive_pending";
		if (hostId) record.archiveHostId = hostId;
		record.archiveLeaseEpoch = epoch;
		if (this.byTopic.get(record.topicId) === sessionId) this.byTopic.delete(record.topicId);
		return record;
	}
	/** Verify the durable archive initiator immediately before remote dispatch. */
	archiveAuthorityAllows(sessionId: string, hostId: string, pairedChatId: string, now: number): boolean;
	/** @deprecated Production dispatch must provide the current paired chat id. */
	archiveAuthorityAllows(sessionId: string, hostId: string, now: number): boolean;
	archiveAuthorityAllows(
		sessionId: string,
		hostId: string,
		pairedChatIdOrNow: string | number,
		suppliedNow?: number,
	): boolean {
		const record = this.topics.get(sessionId);
		const pairedChatId = typeof pairedChatIdOrNow === "string" ? pairedChatIdOrNow : record?.chatId;
		const now = typeof pairedChatIdOrNow === "number" ? pairedChatIdOrNow : suppliedNow;
		return (
			record?.topicOrigin === "daemon_created" &&
			record.chatId === pairedChatId &&
			typeof now === "number" &&
			record.authorityState === "archive_pending" &&
			record.archiveHostId === hostId &&
			record.archiveLeaseEpoch === record.authorityEpoch &&
			(record.authorityEpoch ?? Number.MAX_SAFE_INTEGER) < Number.MAX_SAFE_INTEGER &&
			(record.leaseOwner === undefined || record.leaseOwner === hostId || (record.leaseExpiresAt ?? 0) <= now)
		);
	}

	/** Retain an accepted create as deletion-fenced before remote compensation can begin. */
	fenceAcceptedCreate(
		sessionId: string,
		topicId: string,
		now: () => number = Date.now,
		name?: string,
		binding?: TopicEndpointBinding,
		topicOrigin?: TopicRecord["topicOrigin"],
		archiveChatId?: string,
	): TopicRecord {
		const epoch = Math.max(this.epochs.get(sessionId) ?? 0, this.topics.get(sessionId)?.authorityEpoch ?? 0);
		const record: TopicRecord = {
			topicId,
			topicOrigin: topicOrigin ?? this.topics.get(sessionId)?.topicOrigin ?? "daemon_created",
			sessionUuid: randomUUID(),
			name,
			identitySent: false,
			createdAt: now(),
			authorityEpoch: epoch,
			authorityState: "archive_pending",
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
				: archiveChatId
					? { chatId: archiveChatId }
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
		hostId: string,
		now: () => number = Date.now,
		name?: string,
		binding?: TopicEndpointBinding,
		topicOrigin?: TopicRecord["topicOrigin"],
		archiveChatId?: string,
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
		const archiveFence = this.beginArchive(sessionId, hostId, now());
		if (record && !archiveFence) return undefined;
		const fenced = this.fenceAcceptedCreate(sessionId, topicId, now, name, binding, topicOrigin, archiveChatId);
		fenced.creationLeaseEpoch = creationLeaseEpoch;
		fenced.archiveHostId = hostId;
		fenced.archiveLeaseEpoch = fenced.authorityEpoch;
		return fenced;
	}

	/** Wait for a revoked create to settle before admitting a later lifecycle epoch. */
	async awaitInflight(sessionId: string): Promise<void> {
		await this.inflight.get(sessionId)?.catch(() => undefined);
	}

	/**
	 * Retain a topic record after a definite remote archive only while the exact
	 * dispatched authority epoch is still current.
	 */
	settleArchive(sessionId: string, topicId: string, dispatchedAuthorityEpoch: number): boolean {
		if (
			!Number.isSafeInteger(dispatchedAuthorityEpoch) ||
			dispatchedAuthorityEpoch < 0 ||
			dispatchedAuthorityEpoch >= Number.MAX_SAFE_INTEGER
		)
			return false;
		const record = this.topics.get(sessionId);
		if (
			!record ||
			record.topicId !== topicId ||
			record.authorityState !== "archive_pending" ||
			record.authorityEpoch !== dispatchedAuthorityEpoch ||
			this.authorityEpoch(sessionId) !== dispatchedAuthorityEpoch
		)
			return false;
		record.authorityState = "inactive";
		if (this.byTopic.get(record.topicId) === sessionId) this.byTopic.delete(record.topicId);
		this.archiveJobs.delete(sessionId);
		return true;
	}

	/** Durable archive jobs that are eligible for a retry at `now`. */
	archivePendingSessionIds(now = Date.now()): string[] {
		return [...this.topics].flatMap(([sessionId, record]) => {
			if (record.authorityState === "archive_exhausted") {
				const currentEpoch = Math.max(this.epochs.get(sessionId) ?? 0, record.authorityEpoch ?? 0);
				if (currentEpoch < Number.MAX_SAFE_INTEGER) {
					const epoch = Math.min(currentEpoch + 1, Number.MAX_SAFE_INTEGER - 1);
					record.authorityEpoch = epoch;
					record.archiveLeaseEpoch = epoch;
					record.authorityState = "archive_pending";
				}
			}
			return (record.authorityState === "archive_pending" || record.authorityState === "archive_exhausted") &&
				(this.archiveJobs.get(sessionId)?.nextAttemptAt ?? 0) <= now
				? [sessionId]
				: [];
		});
	}
	/** Durable/manual recovery candidates that exceeded the automatic archive retry budget. */
	archiveExhaustedSessionIds(): string[] {
		return [...this.topics].flatMap(([sessionId, record]) =>
			record.authorityState === "archive_exhausted" ? [sessionId] : [],
		);
	}

	/** Persist an indefinitely discoverable retry after an ambiguous archive result. */
	scheduleArchiveRetry(sessionId: string, now: number, diagnostic?: string): ArchiveJob | undefined {
		const record = this.topics.get(sessionId);
		if (record?.authorityState !== "archive_pending" && record?.authorityState !== "archive_exhausted")
			return undefined;
		const previous = this.archiveJobs.get(sessionId);
		const firstAttemptAt = previous?.firstAttemptAt ?? now;
		const attempt = (previous?.attempt ?? 0) + 1;
		const exhausted = attempt > 8 || now - firstAttemptAt > 24 * 60 * 60 * 1000;
		const effectiveAttempt = Math.min(attempt, 8);
		const backoffMs = exhausted ? 1_000 : Math.min(60_000, 250 * 2 ** effectiveAttempt);
		const job = {
			sessionId,
			topicId: record.topicId,
			attempt: effectiveAttempt,
			firstAttemptAt,
			backoffMs,
			nextAttemptAt: now + backoffMs,
			...(diagnostic ? { safeDiagnostic: diagnostic.slice(0, 256) } : {}),
			...(exhausted ? { safeDiagnostic: "archive retry remains discoverable after retry budget" } : {}),
		};
		record.authorityState = "archive_pending";
		this.archiveJobs.set(sessionId, job);
		return job;
	}

	/** Serialise active records plus unpublished staged creates for atomic commit. */
	serialize(): TopicRegistryState {
		return {
			version: 2,
			registryGeneration: this.registryGeneration,
			topics: Object.fromEntries([...this.topics, ...this.staged]),
			fences: Object.fromEntries(this.epochs),
			archiveJobs: Object.fromEntries(this.archiveJobs),
			createClaims: Object.fromEntries(this.createClaims),
			retiredTopics: Object.fromEntries(this.retiredTopics),
		};
	}
}
