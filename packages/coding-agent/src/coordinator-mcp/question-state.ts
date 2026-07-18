import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { withFileLock } from "../config/file-lock";
import type { PrivateAskGateCodecV1, PublicReason } from "./question-gate-codec";

export type CoordinatorSessionState =
	| "booting"
	| "ready_for_input"
	| "running"
	| "needs_user_input"
	| "completed"
	| "errored"
	| "stale"
	| "unknown";
export interface CanonicalSessionSnapshotV1 {
	schema_version: 1;
	namespace_id: string;
	session_id: string;
	cwd: string;
	created_at: string;
	updated_at: string;
	mpreset: string | null;
	source: string | null;
	model: string | null;
	tmux: { session: string | null; window: string | null; pane: string | null };
	broker: {
		workspace: string | null;
		endpoint_url: string;
		endpoint_generation: number;
		endpoint_incarnation: string;
	};
	ephemeral: boolean;
	visible: boolean;
}
export interface CanonicalTurnSnapshotV1 {
	schema_version: 1;
	turn_id: string;
	session_id: string;
	namespace_id: string;
	status: string;
	prompt: { text: string; created_at: string; source: string };
	delivery: Record<string, unknown>;
	question_ids: string[];
	final_response: Record<string, unknown>;
	evidence: Record<string, unknown>[];
	error: Record<string, unknown> | null;
	liveness: Record<string, unknown>;
	created_at: string;
	updated_at: string;
	started_at: string | null;
	completed_at: string | null;
	terminal_fence: { epoch: number; status: string; reason: PublicReason | null; at: string } | null;
}
export interface CanonicalReportSnapshotV1 {
	schema_version: 1;
	report_id: string;
	operation_id: string;
	session_id: string;
	turn_id: string;
	status: string;
	summary: string;
	blocker: string | null;
	pr_url: string | null;
	evidence_paths: string[];
	created_at: string;
}
export type GateAuthorityEntryV1 = {
	authority: { namespace_id: string; session_id: string; endpoint_incarnation: string; gate_id: string };
	observation:
		| {
				kind: "valid";
				first_provenance: {
					runtime_turn_id: string;
					gate_created_at: string;
					schema_hash: string;
					stage: string;
					kind: string;
				};
		  }
		| {
				kind: "malformed";
				immutable_observation_digest: string;
				malformed: "missing_runtime_turn" | "invalid_runtime_turn" | "invalid_gate_row" | "wrong_session";
		  };
	outcome:
		| { state: "deferred_link"; first_seen_at: string }
		| { state: "pending" | "answered"; turn_id: string; question_id: string }
		| { state: "stale" | "uncertain"; reason: PublicReason; turn_id?: string; question_id?: string }
		| { state: "ownership_unavailable"; reason: "ownership_unavailable" }
		| { state: "ownership_conflict"; reason: "ownership_conflict" };
	first_seen_at: string;
	updated_at: string;
};
export interface PrivateQuestionV1 {
	question_id: string;
	authority_id: string;
	session_id: string;
	turn_id: string;
	endpoint_incarnation: string;
	stage: string;
	kind: string;
	prompt: string;
	status: "pending" | "resolving" | "answered" | "stale" | "uncertain";
	binding_plaintext: string;
	binding_sha256: string;
	codec: PrivateAskGateCodecV1;
	claim_fence_epoch: number | null;
	answer_request_id: string | null;
	created_at: string;
	updated_at: string;
	answered_at: string | null;
	history: Array<{
		at: string;
		status: "pending" | "resolving" | "answered" | "stale" | "uncertain";
		reason: PublicReason | null;
	}>;
}
export interface AnswerRequestV1 {
	request_id: string;
	key_digest: string;
	request_digest: string;
	answer_hash: string;
	answer_binding_sha256: string;
	authority_id: string;
	question_id: string;
	turn_id: string;
	endpoint_incarnation: string;
	sdk_idempotency_key: string;
	claim_fence_epoch: number;
	phase: "claimed" | "remote_started" | "accepted" | "rejected" | "completed" | "uncertain";
	safe_receipt?: {
		status: "accepted" | "rejected";
		answer_hash: string;
		answer_binding_sha256: string;
		authority_id: string;
		turn_id: string;
		endpoint_incarnation: string;
		claim_fence_epoch: number;
		resolved_at: string;
	};
	error_code?: PublicReason | "idempotency_conflict";
	created_at: string;
	updated_at: string;
}
export interface PromptRequestV1 {
	request_id: string;
	key_digest: string;
	request_digest: string;
	operation: "turn.prompt" | "turn.follow_up" | "turn.abort_and_prompt";
	canonical_prompt: { text: string };
	sdk_idempotency_key: string;
	phase: "claimed" | "remote_started" | "accepted" | "linked" | "terminal" | "completed" | "uncertain";
	runtime_receipt?: { accepted: true; command_id: string; turn_id: string };
	coordinator_turn_id?: string;
	safe_response?: Record<string, unknown>;
	error_code?: PublicReason | "idempotency_conflict";
	created_at: string;
	updated_at: string;
}
export interface OperationRequestV1 {
	operation_id: string;
	tool: string;
	key_digest: string;
	request_digest: string;
	local_id: string;
	remote_id?: string;
	phase: "claimed" | "remote_started" | "completed" | "uncertain";
	intent: Record<string, unknown>;
	safe_response?: Record<string, unknown>;
	error_code?: PublicReason | "idempotency_conflict";
	created_at: string;
	updated_at: string;
}
export interface OutboxEventV1 {
	id: string;
	transaction_revision: number;
	kind: string;
	entity: "turn" | "question" | "report" | "session" | "deletion";
	entity_id: string;
	payload: Record<string, string | number | boolean | null>;
	emitted: boolean;
}
export interface CoordinatorSessionTransactionV1 {
	schema_version: 1;
	namespace_id: string;
	session_id: string;
	revision: number;
	endpoint: { incarnation: string; observed_at: string } | null;
	canonical: {
		session: CanonicalSessionSnapshotV1;
		turns: Record<string, CanonicalTurnSnapshotV1>;
		queue: {
			ordered_turn_ids: string[];
			active_turn_id: string | null;
			selected_promotion: { from_turn_id: string; to_turn_id: string; revision: number } | null;
		};
		desired_session_state: CoordinatorSessionState;
		reports: Record<string, CanonicalReportSnapshotV1>;
		gate_authorities: Record<string, GateAuthorityEntryV1>;
		questions: Record<string, PrivateQuestionV1>;
	};
	requests: {
		prompts: Record<string, PromptRequestV1>;
		answers: Record<string, AnswerRequestV1>;
		operations: Record<string, OperationRequestV1>;
	};
	outbox: Record<string, OutboxEventV1>;
	projection: {
		applied_turns_revision: number;
		applied_reports_revision: number;
		applied_session_revision: number;
		applied_active_revision: number;
		applied_events_revision: number;
	};
	recovery: { prompt_watermark_at: string | null; last_repaired_at: string | null };
}
export type CanonicalCreateIntentV1 =
	| {
			kind: "register";
			session: CanonicalSessionSnapshotV1;
			initial_state: CoordinatorSessionState;
			initial_events: Record<string, string | number | boolean | null>[];
	  }
	| {
			kind: "start";
			session: CanonicalSessionSnapshotV1;
			remote_create_key: string;
			initial_state: CoordinatorSessionState;
			initial_prompt: { text: string; caller_key_digest: string } | null;
			initial_events: Record<string, string | number | boolean | null>[];
	  }
	| {
			kind: "delegate";
			workflow: "plan" | "execute" | "team";
			session: CanonicalSessionSnapshotV1;
			remote_create_key: string;
			initial_state: CoordinatorSessionState;
			initial_prompt: { text: string; caller_key_digest: string };
			initial_events: Record<string, string | number | boolean | null>[];
	  };
export interface CreationRequestV1 {
	key_digest: string;
	request_digest: string;
	tool: string;
	phase: "claimed" | "remote_started" | "wal_committed" | "projected" | "completed" | "uncertain";
	canonical_create_intent: CanonicalCreateIntentV1 | null;
	remote_create_key: string;
	session_id: string | null;
	endpoint_incarnation: string | null;
	wal_revision?: number;
	wal_digest?: string;
	safe_response?: Record<string, unknown>;
	created_at: string;
	updated_at: string;
}
export interface NamespaceDeletionEntryV1 {
	deletion_id: string;
	session_id: string;
	endpoint_incarnation: string;
	operation_id: string;
	key_digest: string;
	request_digest: string;
	close_key: string;
	phase: "intent" | "broker_closed" | "cleanup_pending" | "completed" | "uncertain";
	safe_response?: Record<string, unknown>;
	cleanup: { wal: boolean; turns: boolean; reports: boolean; session: boolean; events: boolean };
	authority_digest: string;
	created_at: string;
	updated_at: string;
}
export interface NamespaceRegistryV1 {
	schema_version: 1;
	namespace_id: string;
	creations: Record<string, CreationRequestV1>;
	deletions: Record<string, NamespaceDeletionEntryV1>;
}
export interface CoordinatorStatePaths {
	root: string;
	registry: string;
	registryLock: string;
	journal: string;
	journalLock: string;
	sessions: string;
}
const MAX_NORMAL_BYTES = 1024 * 1024;
const EMERGENCY_BYTES = 128 * 1024;
const RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
const digest = (value: string): string => createHash("sha256").update(value).digest("hex");
export function coordinatorStatePaths(stateRoot: string, namespaceId: string): CoordinatorStatePaths {
	const root = path.join(stateRoot, "v1", namespaceId);
	return {
		root,
		registry: path.join(root, "namespace-registry.v1.json"),
		registryLock: path.join(root, "namespace-registry.lock"),
		journal: path.join(root, "events", "event-journal.jsonl"),
		journalLock: path.join(root, "events", "event-journal.lock"),
		sessions: path.join(root, "sessions"),
	};
}
function safeSessionId(sessionId: string): string {
	if (!/^[A-Za-z0-9._-]{1,256}$/.test(sessionId)) throw new Error("state_corrupt");
	return sessionId;
}
export function transactionPath(paths: CoordinatorStatePaths, sessionId: string): string {
	return path.join(paths.sessions, safeSessionId(sessionId), "transaction.v1.json");
}
export function transactionLockPath(paths: CoordinatorStatePaths, sessionId: string): string {
	return path.join(paths.sessions, safeSessionId(sessionId), "transaction.lock");
}
async function fsyncDirectory(directory: string): Promise<void> {
	const handle = await fs.open(directory, "r");
	try {
		await handle.sync();
	} finally {
		await handle.close();
	}
}
async function ensureNamespaceParents(paths: CoordinatorStatePaths): Promise<void> {
	await fs.mkdir(paths.root, { recursive: true, mode: 0o700 });
}

async function writeAtomic(file: string, value: unknown): Promise<void> {
	await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
	const temp = `${file}.${process.pid}.${Date.now()}.tmp`;
	const handle = await fs.open(temp, "wx", 0o600);
	try {
		await handle.writeFile(JSON.stringify(value));
		await handle.sync();
	} finally {
		await handle.close();
	}
	await fs.rename(temp, file);
	await fsyncDirectory(path.dirname(file));
}
async function readJson<T>(file: string): Promise<T | null> {
	try {
		return JSON.parse(await fs.readFile(file, "utf8")) as T;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
		throw new Error("state_corrupt");
	}
}
function assertTransaction(transaction: CoordinatorSessionTransactionV1, namespaceId: string, sessionId: string): void {
	if (
		transaction.schema_version !== 1 ||
		transaction.namespace_id !== namespaceId ||
		transaction.session_id !== sessionId ||
		transaction.canonical.session.namespace_id !== namespaceId ||
		transaction.canonical.session.session_id !== sessionId ||
		transaction.canonical.session.cwd !== path.resolve(transaction.canonical.session.cwd)
	)
		throw new Error("state_corrupt");
}
export async function initializeCoordinatorNamespace(paths: CoordinatorStatePaths): Promise<void> {
	await ensureNamespaceParents(paths);
	await fs.mkdir(paths.sessions, { recursive: true, mode: 0o700 });
	await fs.mkdir(path.dirname(paths.journal), { recursive: true, mode: 0o700 });
	await withFileLock(paths.registryLock, async () => {
		const existing = await readJson<NamespaceRegistryV1>(paths.registry);
		if (existing === null)
			await writeAtomic(paths.registry, {
				schema_version: 1,
				namespace_id: path.basename(paths.root),
				creations: {},
				deletions: {},
			});
		else if (existing.schema_version !== 1 || existing.namespace_id !== path.basename(paths.root))
			throw new Error("state_corrupt");
	});
}
export async function withNamespaceRegistry<T>(
	paths: CoordinatorStatePaths,
	operation: (registry: NamespaceRegistryV1) => Promise<T>,
): Promise<T> {
	await ensureNamespaceParents(paths);
	return await withFileLock(paths.registryLock, async () => {
		const registry = await readJson<NamespaceRegistryV1>(paths.registry);
		if (registry?.schema_version !== 1 || registry.namespace_id !== path.basename(paths.root))
			throw new Error("state_corrupt");
		const result = await operation(registry);
		await writeAtomic(paths.registry, registry);
		return result;
	});
}
export async function withSessionTransaction<T>(
	paths: CoordinatorStatePaths,
	sessionId: string,
	operation: (transaction: CoordinatorSessionTransactionV1) => Promise<T>,
): Promise<T> {
	const file = transactionPath(paths, sessionId);
	await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
	return await withFileLock(transactionLockPath(paths, sessionId), async () => {
		const transaction = await readJson<CoordinatorSessionTransactionV1>(file);
		if (!transaction) throw new Error("resource_gone");
		assertTransaction(transaction, path.basename(paths.root), sessionId);
		const result = await operation(transaction);
		transaction.revision++;
		await writeAtomic(file, transaction);
		return result;
	});
}

/** Serializes a session mutation with namespace close admission. */
export async function withAdmittedSessionTransaction<T>(
	paths: CoordinatorStatePaths,
	sessionId: string,
	operation: (transaction: CoordinatorSessionTransactionV1) => Promise<T>,
): Promise<T> {
	return await withNamespaceRegistry(
		paths,
		async registry =>
			await withSessionTransaction(paths, sessionId, async transaction => {
				assertCloseAdmission(registry, transaction);
				return await operation(transaction);
			}),
	);
}

/** Claims a caller-visible creation request before any remote work or projection. */
export async function claimCreationRequest(
	paths: CoordinatorStatePaths,
	input: { key_digest: string; request_digest: string; tool: string },
): Promise<CreationRequestV1> {
	return await withNamespaceRegistry(paths, async registry => {
		const existing = registry.creations[input.key_digest];
		if (existing) {
			if (existing.request_digest !== input.request_digest || existing.tool !== input.tool)
				throw new Error("idempotency_conflict");
			return existing;
		}
		const now = new Date().toISOString();
		const request: CreationRequestV1 = {
			key_digest: input.key_digest,
			request_digest: input.request_digest,
			tool: input.tool,
			phase: "claimed",
			canonical_create_intent: null,
			remote_create_key: `remote_${input.key_digest}`,
			session_id: null,
			endpoint_incarnation: null,
			created_at: now,
			updated_at: now,
		};
		registry.creations[input.key_digest] = request;
		return request;
	});
}

/** Persists the remote result needed to resume a creation after a crash. */
export async function bindCreationRequest(
	paths: CoordinatorStatePaths,
	keyDigest: string,
	intent: CanonicalCreateIntentV1,
): Promise<CreationRequestV1> {
	return await withNamespaceRegistry(paths, async registry => {
		const request = registry.creations[keyDigest];
		if (!request) throw new Error("state_corrupt");
		const session = intent.session;
		if (
			request.session_id &&
			(request.session_id !== session.session_id ||
				request.endpoint_incarnation !== session.broker.endpoint_incarnation)
		)
			throw new Error("state_corrupt");
		if (
			Object.values(registry.deletions).some(
				entry =>
					entry.session_id === session.session_id &&
					entry.endpoint_incarnation === session.broker.endpoint_incarnation,
			)
		)
			throw new Error("session_closing");
		request.canonical_create_intent = intent;
		request.session_id = session.session_id;
		request.endpoint_incarnation = session.broker.endpoint_incarnation;
		if (request.phase === "claimed") request.phase = "remote_started";
		request.updated_at = new Date().toISOString();
		return request;
	});
}

/** Creates the durable session WAL for an already claimed creation request. */
export async function commitCreationWal(
	paths: CoordinatorStatePaths,
	keyDigest: string,
	intent: CanonicalCreateIntentV1,
): Promise<CoordinatorSessionTransactionV1> {
	await bindCreationRequest(paths, keyDigest, intent);
	return await withNamespaceRegistry(paths, async registry => {
		const request = registry.creations[keyDigest];
		if (!request || request.canonical_create_intent === null) throw new Error("state_corrupt");
		const session = intent.session;
		let existing = await readJson<CoordinatorSessionTransactionV1>(transactionPath(paths, session.session_id));
		if (existing) {
			assertTransaction(existing, session.namespace_id, session.session_id);
			if (existing.canonical.session.broker.endpoint_incarnation !== session.broker.endpoint_incarnation) {
				const priorDeleted = Object.values(registry.deletions).some(
					entry =>
						entry.session_id === session.session_id &&
						entry.endpoint_incarnation === existing!.canonical.session.broker.endpoint_incarnation &&
						entry.phase === "completed",
				);
				if (!priorDeleted) throw new Error("session_closing");
				await fs.rm(transactionPath(paths, session.session_id), { force: true });
				existing = null;
			}
			if (existing) {
				request.phase = "wal_committed";
				request.wal_revision = existing.revision;
				request.wal_digest = digest(JSON.stringify(existing));
				request.updated_at = new Date().toISOString();
				return existing;
			}
		}
		const now = new Date().toISOString();
		const transaction: CoordinatorSessionTransactionV1 = {
			schema_version: 1,
			namespace_id: session.namespace_id,
			session_id: session.session_id,
			revision: 1,
			endpoint: { incarnation: session.broker.endpoint_incarnation, observed_at: now },
			canonical: {
				session,
				turns: {},
				queue: { ordered_turn_ids: [], active_turn_id: null, selected_promotion: null },
				desired_session_state: intent.initial_state,
				reports: {},
				gate_authorities: {},
				questions: {},
			},
			requests: { prompts: {}, answers: {}, operations: {} },
			outbox: {},
			projection: {
				applied_turns_revision: 0,
				applied_reports_revision: 0,
				applied_session_revision: 0,
				applied_active_revision: 0,
				applied_events_revision: 0,
			},
			recovery: { prompt_watermark_at: null, last_repaired_at: null },
		};
		await writeAtomic(transactionPath(paths, session.session_id), transaction);
		request.phase = "wal_committed";
		request.wal_revision = transaction.revision;
		request.wal_digest = digest(JSON.stringify(transaction));
		request.updated_at = now;
		return transaction;
	});
}
export async function createSessionTransaction(
	paths: CoordinatorStatePaths,
	intent: CanonicalCreateIntentV1,
): Promise<CoordinatorSessionTransactionV1> {
	const session = intent.session;
	return await withNamespaceRegistry(paths, async registry => {
		const key = digest(`${intent.kind}\0${session.session_id}\0${session.broker.endpoint_incarnation}`);
		if (
			Object.values(registry.deletions).some(
				entry =>
					entry.session_id === session.session_id &&
					entry.endpoint_incarnation === session.broker.endpoint_incarnation,
			)
		)
			throw new Error("session_closing");
		const prior = registry.creations[key];
		if (prior?.phase === "completed" || prior?.phase === "projected" || prior?.phase === "wal_committed") {
			const existing = await readJson<CoordinatorSessionTransactionV1>(transactionPath(paths, session.session_id));
			if (!existing) throw new Error("state_corrupt");
			return existing;
		}
		const now = new Date().toISOString();
		registry.creations[key] = {
			key_digest: key,
			request_digest: key,
			tool: intent.kind,
			phase: "claimed",
			canonical_create_intent: intent,
			remote_create_key: `remote_${key}`,
			session_id: session.session_id,
			endpoint_incarnation: session.broker.endpoint_incarnation,
			created_at: now,
			updated_at: now,
		};
		const transaction: CoordinatorSessionTransactionV1 = {
			schema_version: 1,
			namespace_id: session.namespace_id,
			session_id: session.session_id,
			revision: 1,
			endpoint: { incarnation: session.broker.endpoint_incarnation, observed_at: now },
			canonical: {
				session,
				turns: {},
				queue: { ordered_turn_ids: [], active_turn_id: null, selected_promotion: null },
				desired_session_state: intent.initial_state,
				reports: {},
				gate_authorities: {},
				questions: {},
			},
			requests: { prompts: {}, answers: {}, operations: {} },
			outbox: {},
			projection: {
				applied_turns_revision: 0,
				applied_reports_revision: 0,
				applied_session_revision: 0,
				applied_active_revision: 0,
				applied_events_revision: 0,
			},
			recovery: { prompt_watermark_at: null, last_repaired_at: null },
		};
		await writeAtomic(transactionPath(paths, session.session_id), transaction);
		registry.creations[key]!.phase = "wal_committed";
		registry.creations[key]!.wal_revision = transaction.revision;
		registry.creations[key]!.wal_digest = digest(JSON.stringify(transaction));
		registry.creations[key]!.updated_at = now;
		return transaction;
	});
}
export function assertCloseAdmission(
	registry: NamespaceRegistryV1,
	transaction: CoordinatorSessionTransactionV1,
): void {
	if (
		Object.values(registry.deletions).some(
			entry =>
				entry.session_id === transaction.session_id &&
				entry.endpoint_incarnation === transaction.endpoint?.incarnation,
		) ||
		Object.values(transaction.requests.operations).some(
			request =>
				(request.intent.kind === "stop" || request.intent.kind === "reap") && request.phase === "remote_started",
		)
	)
		throw new Error("session_closing");
}
export function deterministicOutboxId(
	sessionId: string,
	revision: number,
	kind: string,
	entity: OutboxEventV1["entity"],
	entityId: string,
): string {
	return `txn:${sessionId}:${revision}:${kind}:${entity}:${entityId}`;
}
export async function appendOutboxEvents(
	paths: CoordinatorStatePaths,
	transaction: CoordinatorSessionTransactionV1,
): Promise<void> {
	await fs.mkdir(path.dirname(paths.journal), { recursive: true, mode: 0o700 });
	await withFileLock(paths.journalLock, async () => {
		const existing = await fs.readFile(paths.journal, "utf8").catch(error => {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return "";
			throw error;
		});
		const ids = new Set(
			existing
				.split("\n")
				.filter(Boolean)
				.map(line => {
					try {
						return (JSON.parse(line) as { id?: unknown }).id;
					} catch {
						return null;
					}
				})
				.filter((id): id is string => typeof id === "string"),
		);
		const events = Object.values(transaction.outbox).filter(event => !event.emitted && !ids.has(event.id));
		if (events.length > 0) {
			const handle = await fs.open(paths.journal, "a", 0o600);
			try {
				await handle.writeFile(`${events.map(event => JSON.stringify(event)).join("\n")}\n`);
				await handle.sync();
			} finally {
				await handle.close();
			}
		}
		for (const event of Object.values(transaction.outbox)) event.emitted = true;
		transaction.projection.applied_events_revision = transaction.revision;
	});
}
export function compactTransaction(transaction: CoordinatorSessionTransactionV1, now = Date.now()): void {
	const old = (time: string): boolean => Date.parse(time) + RETENTION_MS < now;
	for (const [id, event] of Object.entries(transaction.outbox))
		if (
			event.emitted &&
			event.transaction_revision < transaction.revision &&
			old(String(event.payload.created_at ?? ""))
		)
			delete transaction.outbox[id];
	for (const group of [transaction.requests.prompts, transaction.requests.answers, transaction.requests.operations])
		for (const [id, request] of Object.entries(group))
			if (
				request.phase === "completed" &&
				old(request.updated_at) &&
				JSON.stringify(transaction.canonical).includes(id) === false
			)
				delete group[id];
	if (Buffer.byteLength(JSON.stringify(transaction)) > MAX_NORMAL_BYTES + EMERGENCY_BYTES)
		throw new Error("query_unavailable");
}

/** Records projection repair after projecting complete canonical snapshots. */
export async function repairProjections(
	paths: CoordinatorStatePaths,
	sessionId: string,
	project: (canonical: CoordinatorSessionTransactionV1["canonical"]) => Promise<void>,
): Promise<void> {
	await withSessionTransaction(paths, sessionId, async transaction => {
		await project(transaction.canonical);
		await appendOutboxEvents(paths, transaction);
		transaction.projection.applied_turns_revision = transaction.revision;
		transaction.projection.applied_reports_revision = transaction.revision;
		transaction.projection.applied_session_revision = transaction.revision;
		transaction.projection.applied_active_revision = transaction.revision;
		transaction.recovery.last_repaired_at = new Date().toISOString();
	});
}

/** Advances a creation receipt only after its WAL or projection authority exists. */
export async function advanceCreationReceipt(
	paths: CoordinatorStatePaths,
	keyDigest: string,
	phase: "projected" | "completed" | "uncertain",
	safeResponse?: Record<string, unknown>,
): Promise<void> {
	await withNamespaceRegistry(paths, async registry => {
		const request = registry.creations[keyDigest];
		if (!request) throw new Error("state_corrupt");
		if (request.phase === phase) return;
		if (phase !== "uncertain" && request.phase !== "wal_committed" && request.phase !== "projected")
			throw new Error("state_corrupt");
		request.phase = phase;
		request.safe_response = safeResponse;
		request.updated_at = new Date().toISOString();
	});
}

export function hasEmergencyCapacity(
	transaction: CoordinatorSessionTransactionV1,
	incomingBytes: number,
	essential: boolean,
): boolean {
	const current = Buffer.byteLength(JSON.stringify(transaction));
	return (
		current + incomingBytes <= MAX_NORMAL_BYTES ||
		(essential && current + incomingBytes <= MAX_NORMAL_BYTES + EMERGENCY_BYTES)
	);
}

export async function recordDeletionIntent(
	paths: CoordinatorStatePaths,
	entry: NamespaceDeletionEntryV1,
): Promise<void> {
	await withNamespaceRegistry(paths, async registry => {
		const existing = registry.deletions[entry.deletion_id];
		if (existing && (existing.key_digest !== entry.key_digest || existing.request_digest !== entry.request_digest))
			throw new Error("idempotency_conflict");
		registry.deletions[entry.deletion_id] = existing ?? entry;
	});
}

export async function advanceDeletion(
	paths: CoordinatorStatePaths,
	deletionId: string,
	phase: NamespaceDeletionEntryV1["phase"],
	cleanup?: Partial<NamespaceDeletionEntryV1["cleanup"]>,
	safeResponse?: Record<string, unknown>,
): Promise<void> {
	await withNamespaceRegistry(paths, async registry => {
		const entry = registry.deletions[deletionId];
		if (!entry) throw new Error("resource_gone");
		entry.phase = phase;
		entry.cleanup = { ...entry.cleanup, ...cleanup };
		entry.updated_at = new Date().toISOString();
		if (safeResponse) entry.safe_response = safeResponse;
	});
}
