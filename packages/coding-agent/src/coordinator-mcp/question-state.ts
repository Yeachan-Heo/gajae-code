import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { withFileLock } from "../config/file-lock";
import { ensureCoordinatorDirectory, syncCoordinatorDirectory, writeCoordinatorAtomic } from "./durability";
import type { PrivateAskGateCodecV1, PublicReason } from "./question-gate-codec";

export type CoordinatorSessionState =
	| "booting"
	/** Live and endpoint-addressable, but withholding readiness until activation. */
	| "prepared"
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
		sidecar_verifier: { key_id: string; public_key: string };
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
	runtime_provenance: RuntimeProvenanceTokenV1 | null;
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
export interface RuntimeProvenanceTokenV1 {
	namespace_id: string;
	session_id: string;
	endpoint_incarnation: string;
	coordinator_turn_id: string;
	runtime_turn_id: string;
	gate_created_at: string;
	schema_hash: string;
	stage: string;
	kind: string;
}
export type GateAuthorityEntryV1 = {
	authority: { namespace_id: string; session_id: string; endpoint_incarnation: string; gate_id: string };
	observation:
		| {
				kind: "valid";
				first_provenance: RuntimeProvenanceTokenV1;
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
	/** Retain prompt and source turn until the delegate's outer response is durable. */
	delegate_response_pending?: boolean;
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
export type PublicDeliveryStateV1 = "pending" | "claimed" | "acknowledged";
export interface PublicDeliveryV1 {
	public_event_id: string;
	state: PublicDeliveryStateV1;
	claim_fence: number | null;
	claim_expires_at: string | null;
	journal_seq: number | null;
	acknowledged_at: string | null;
}
export interface OutboxEventV1 {
	id: string;
	transaction_revision: number;
	kind: string;
	entity: "turn" | "question" | "report" | "session" | "deletion";
	entity_id: string;
	payload: Record<string, string | number | boolean | null>;
	emitted: boolean;
	/** Stable public id; it is independent from journal sequence allocation. */
	public_event_id: string;
	public_delivery: PublicDeliveryV1;
}
function isOutboxEntity(value: unknown): value is OutboxEventV1["entity"] {
	return value === "turn" || value === "question" || value === "report" || value === "session" || value === "deletion";
}
export interface CoordinatorSessionTransactionV1 {
	schema_version: 1;
	/** Digest of the canonical creation intent that produced this WAL. */
	creation_intent_digest: string;
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
		/** Session-WAL-first scheduler repair markers. */
		scheduler_pending_revision?: number;
		scheduler_applied_revision?: number;
		scheduler_digest?: string;
	};
	recovery: { prompt_watermark_at: string | null; last_repaired_at: string | null };
}
interface CoordinatorSessionHistoryV1 {
	schema_version: 1;
	session_id: string;
	endpoint_incarnation: string | null;
	turns: Record<string, CanonicalTurnSnapshotV1>;
	questions: Record<string, PrivateQuestionV1>;
	gate_authorities: Record<string, GateAuthorityEntryV1>;
	reports: Record<string, CanonicalReportSnapshotV1>;
	prompts: Record<string, PromptRequestV1>;
	answers: Record<string, AnswerRequestV1>;
	operations: Record<string, OperationRequestV1>;
	outbox: Record<string, OutboxEventV1>;
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
			workflow: "plan" | "execute";
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
	phase: "claimed" | "remote_started" | "wal_committed" | "projected" | "completed" | "uncertain" | "retired";
	canonical_create_intent: CanonicalCreateIntentV1 | null;
	remote_create_key: string;
	session_id: string | null;
	endpoint_incarnation: string | null;
	sidecar_verifier: { key_id: string; public_key: string } | null;
	/** Retirement is staged before the broker effect so a post-effect crash can replay safely. */
	retirement_intent?: CreationRetirementIntentV1;
	wal_revision?: number;
	wal_digest?: string;
	safe_response?: Record<string, unknown>;
	created_at: string;
	updated_at: string;
}
export interface CreationRetirementProofV1 {
	session_id: string;
	cwd: string;
	state_root: string;
	endpoint_generation: number;
	endpoint_mtime_ms: number;
	process_incarnation: string;
	host_incarnation: string;
	lifecycle_request_id: string;
	remote_create_key: string;
}
export interface CreationRetirementBrokerProofV1 {
	session_id: string;
	retired: true;
	ledger_state: "terminal_error";
	index_type: "session_closed";
	state_root: string;
	endpoint_generation: number;
	endpoint_mtime_ms: number;
	process_incarnation: string;
	host_incarnation: string;
	lifecycle_request_id: string;
	remote_create_key: string;
}
export interface CreationRetirementIntentV1 {
	phase: "intent" | "pre_effect_rejected" | "broker_retired";
	proof: CreationRetirementProofV1;
	retirement_key_digest?: string;
	broker_proof?: CreationRetirementBrokerProofV1;
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
	cleanup: {
		wal: boolean;
		turns: boolean;
		reports: boolean;
		session: boolean;
		events: boolean;
		/** Exact projection targets captured before the canonical WAL is removed. */
		turn_ids?: string[];
		report_ids?: string[];
	};
	authority_digest: string;
	created_at: string;
	updated_at: string;
}
export interface NamespaceRegistryV1 {
	schema_version: 1;
	namespace_id: string;
	creations: Record<string, CreationRequestV1>;
	deletions: Record<string, NamespaceDeletionEntryV1>;
	/** Durable bounded scheduler hints. Lifecycle authority remains in session WALs. */
	roster?: Record<
		string,
		{ session_id: string; revision: number; digest: string; active: boolean; dirty: boolean; updated_at: string }
	>;
	scheduler_revision?: number;
	scheduler_cursor?: string;
	retained_sessions?: Record<string, { session_id: string; updated_at: string }>;
	delivery_discovery_cursor?: string;
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
const PUBLIC_CLAIM_LEASE_MS = 30_000;
export const COORDINATOR_SESSION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
export const COORDINATOR_REPORT_ID_PATTERN = /^report-[a-f0-9]{64}$/;
const digest = (value: string): string => createHash("sha256").update(value).digest("hex");
const canonicalJson = (value: unknown): string => {
	if (value === null || typeof value !== "object") return JSON.stringify(value);
	if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
	const record = value as Record<string, unknown>;
	return `{${Object.keys(record)
		.sort()
		.map(key => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
		.join(",")}}`;
};
const lockOptions = (signal?: AbortSignal) => (signal ? { signal } : undefined);

function publicDeliveryFor(event: OutboxEventV1): PublicDeliveryV1 {
	const candidate = event.public_delivery;
	if (
		candidate &&
		(candidate.state === "pending" || candidate.state === "claimed" || candidate.state === "acknowledged") &&
		(typeof candidate.public_event_id === "string" || typeof event.public_event_id === "string")
	) {
		return {
			public_event_id: candidate.public_event_id || event.public_event_id || event.id,
			state: candidate.state,
			claim_fence: Number.isSafeInteger(candidate.claim_fence) ? candidate.claim_fence : null,
			claim_expires_at: typeof candidate.claim_expires_at === "string" ? candidate.claim_expires_at : null,
			journal_seq: Number.isSafeInteger(candidate.journal_seq) ? candidate.journal_seq : null,
			acknowledged_at: typeof candidate.acknowledged_at === "string" ? candidate.acknowledged_at : null,
		};
	}
	return {
		public_event_id: event.public_event_id || event.id,
		state: "pending",
		claim_fence: null,
		claim_expires_at: null,
		journal_seq: null,
		acknowledged_at: null,
	};
}

function normalizeOutbox(transaction: CoordinatorSessionTransactionV1): void {
	for (const event of Object.values(transaction.outbox)) {
		if (!event.public_event_id) event.public_event_id = event.id;
		event.public_delivery = publicDeliveryFor(event);
	}
}
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
	if (!COORDINATOR_SESSION_ID_PATTERN.test(sessionId)) throw new Error("state_corrupt");
	return sessionId;
}
export function transactionPath(paths: CoordinatorStatePaths, sessionId: string): string {
	return path.join(paths.sessions, safeSessionId(sessionId), "transaction.v1.json");
}
export function transactionLockPath(paths: CoordinatorStatePaths, sessionId: string): string {
	return path.join(paths.sessions, safeSessionId(sessionId), "transaction.lock");
}
async function ensureNamespaceParents(paths: CoordinatorStatePaths): Promise<void> {
	await ensureCoordinatorDirectory(paths.root);
}

async function removeCoordinatorStateFile(file: string): Promise<void> {
	try {
		await fs.lstat(file);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		try {
			await fs.stat(path.dirname(file));
		} catch (parentError) {
			if ((parentError as NodeJS.ErrnoException).code === "ENOENT") return;
			throw parentError;
		}
		await syncCoordinatorDirectory(path.dirname(file));
		return;
	}
	await fs.rm(file);
	await syncCoordinatorDirectory(path.dirname(file));
}

async function writeAtomic(file: string, value: unknown): Promise<void> {
	await writeCoordinatorAtomic(file, JSON.stringify(value));
}

function sessionHistoryPath(
	paths: CoordinatorStatePaths,
	sessionId: string,
	endpointIncarnation: string | null,
): string {
	const partition = endpointIncarnation?.replace(/[^A-Za-z0-9._-]/g, "_") || "legacy";
	return path.join(path.dirname(transactionPath(paths, sessionId)), `history.${partition}.v1.json`);
}

function emptySessionHistory(transaction: CoordinatorSessionTransactionV1): CoordinatorSessionHistoryV1 {
	return {
		schema_version: 1,
		session_id: transaction.session_id,
		endpoint_incarnation: transaction.endpoint?.incarnation ?? null,
		turns: {},
		questions: {},
		gate_authorities: {},
		reports: {},
		prompts: {},
		answers: {},
		operations: {},
		outbox: {},
	};
}

function copyRemovedHistory<T>(before: Record<string, T>, after: Record<string, T>, target: Record<string, T>): void {
	for (const [id, value] of Object.entries(before)) if (!(id in after) && !(id in target)) target[id] = value;
}

async function archiveCompactedHistory(
	paths: CoordinatorStatePaths,
	before: CoordinatorSessionTransactionV1,
	after: CoordinatorSessionTransactionV1,
): Promise<void> {
	const history = emptySessionHistory(before);
	copyRemovedHistory(before.canonical.turns, after.canonical.turns, history.turns);
	copyRemovedHistory(before.canonical.questions, after.canonical.questions, history.questions);
	copyRemovedHistory(before.canonical.gate_authorities, after.canonical.gate_authorities, history.gate_authorities);
	copyRemovedHistory(before.canonical.reports, after.canonical.reports, history.reports);
	copyRemovedHistory(before.requests.prompts, after.requests.prompts, history.prompts);
	copyRemovedHistory(before.requests.answers, after.requests.answers, history.answers);
	copyRemovedHistory(before.requests.operations, after.requests.operations, history.operations);
	copyRemovedHistory(before.outbox, after.outbox, history.outbox);
	const hasNewHistory = Object.values(history).some(value =>
		value && typeof value === "object" && !Array.isArray(value) ? Object.keys(value).length > 0 : false,
	);
	if (!hasNewHistory) return;
	const endpointIncarnation = before.endpoint?.incarnation ?? null;
	const file = sessionHistoryPath(paths, before.session_id, endpointIncarnation);
	const legacyFile = path.join(path.dirname(file), "history.v1.json");
	const partitioned = await readJson<CoordinatorSessionHistoryV1>(file);
	const legacy = partitioned ? null : await readJson<CoordinatorSessionHistoryV1>(legacyFile);
	const existing = partitioned ?? (legacy?.endpoint_incarnation === endpointIncarnation ? legacy : null);
	if (existing && (existing.schema_version !== 1 || existing.session_id !== before.session_id))
		throw new Error("state_corrupt");
	const archive = existing ?? emptySessionHistory(before);
	copyRemovedHistory(history.turns, {}, archive.turns);
	copyRemovedHistory(history.questions, {}, archive.questions);
	copyRemovedHistory(history.gate_authorities, {}, archive.gate_authorities);
	copyRemovedHistory(history.reports, {}, archive.reports);
	copyRemovedHistory(history.prompts, {}, archive.prompts);
	copyRemovedHistory(history.answers, {}, archive.answers);
	copyRemovedHistory(history.operations, {}, archive.operations);
	copyRemovedHistory(history.outbox, {}, archive.outbox);
	await writeAtomic(file, archive);
}

async function readJson<T>(file: string): Promise<T | null> {
	try {
		return JSON.parse(await fs.readFile(file, "utf8")) as T;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
		if (error instanceof SyntaxError) throw new Error("state_corrupt");
		throw error;
	}
}

/** Reads an authoritative WAL without conflating an absent file with JSON null or another scalar root. */
async function readTransactionJson<T>(file: string): Promise<T | null> {
	let source: string;
	try {
		source = await fs.readFile(file, "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
		throw new Error("state_corrupt");
	}
	try {
		const value: unknown = JSON.parse(source);
		if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("invalid_root");
		return value as T;
	} catch {
		throw new Error("state_corrupt");
	}
}
function migrateLegacyTransactionV1(transaction: CoordinatorSessionTransactionV1): void {
	const record = transaction as unknown as Record<string, unknown>;
	if (record.schema_version !== 1 || !record.canonical || !record.outbox || !record.requests) return;
	if (!Object.hasOwn(record, "creation_intent_digest")) {
		record.creation_intent_digest = digest(
			canonicalJson({
				kind: "legacy-v1",
				namespace_id: record.namespace_id,
				session_id: record.session_id,
				canonical: record.canonical,
			}),
		);
	}
	const canonical = record.canonical as Record<string, unknown>;
	const session = canonical.session as Record<string, unknown> | undefined;
	const broker = session?.broker as Record<string, unknown> | undefined;
	if (broker && (!broker.sidecar_verifier || typeof broker.sidecar_verifier !== "object")) {
		// Pre-signing WALs have no runtime private key to recover. Assign an
		// unowned verifier so their historical state remains readable while all
		// future sidecar updates fail closed until the runtime is re-established.
		const keyId = digest(`legacy-sidecar-verifier\0${record.namespace_id}\0${record.session_id}`);
		broker.sidecar_verifier = {
			key_id: keyId,
			public_key: Buffer.from(keyId, "hex").toString("base64"),
		};
	}
	const authorities = canonical.gate_authorities;
	const endpointIncarnation = typeof broker?.endpoint_incarnation === "string" ? broker.endpoint_incarnation : null;
	if (authorities && typeof authorities === "object" && !Array.isArray(authorities)) {
		for (const authority of Object.values(authorities as Record<string, unknown>)) {
			if (!authority || typeof authority !== "object" || Array.isArray(authority)) continue;
			const entry = authority as Record<string, unknown>;
			const observation = entry.observation;
			if (!observation || typeof observation !== "object" || Array.isArray(observation)) continue;
			const provenance = (observation as Record<string, unknown>).first_provenance;
			if (!provenance || typeof provenance !== "object" || Array.isArray(provenance)) continue;
			const token = provenance as Record<string, unknown>;
			if (token.namespace_id === undefined && typeof record.namespace_id === "string")
				token.namespace_id = record.namespace_id;
			if (token.session_id === undefined && typeof record.session_id === "string")
				token.session_id = record.session_id;
			if (token.endpoint_incarnation === undefined && endpointIncarnation !== null)
				token.endpoint_incarnation = endpointIncarnation;
			if (token.coordinator_turn_id === undefined) {
				const outcome = entry.outcome as Record<string, unknown> | undefined;
				const turnId = outcome && typeof outcome.turn_id === "string" ? outcome.turn_id : "";
				token.coordinator_turn_id = turnId;
			}
		}
	}
	normalizeOutbox(transaction);
}

function assertTransaction(transaction: CoordinatorSessionTransactionV1, namespaceId: string, sessionId: string): void {
	const isRecord = (value: unknown): value is Record<string, unknown> =>
		typeof value === "object" && value !== null && !Array.isArray(value);
	migrateLegacyTransactionV1(transaction);
	const isTime = (value: unknown) => typeof value === "string" && Number.isFinite(Date.parse(value));
	const safeId = (value: unknown) => typeof value === "string" && /^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,127}$/.test(value);
	const turnStatuses = new Set([
		"queued",
		"delivering",
		"active",
		"waiting_for_answer",
		"completing",
		"completed",
		"failed",
		"cancelled",
		"superseded",
	]);
	const activeStatuses = new Set(["delivering", "active", "waiting_for_answer", "completing"]);
	const terminalStatuses = new Set(["completed", "failed", "cancelled", "superseded"]);
	const promptPhases = new Set([
		"claimed",
		"remote_started",
		"accepted",
		"linked",
		"terminal",
		"completed",
		"uncertain",
	]);
	const validStates = new Set([
		"booting",
		"prepared",
		"ready_for_input",
		"running",
		"needs_user_input",
		"completed",
		"errored",
		"stale",
		"unknown",
	]);
	const turns = transaction.canonical?.turns;
	const prompts = transaction.requests?.prompts;
	const invalidDelivery = (delivery: unknown) => {
		if (
			!isRecord(delivery) ||
			typeof delivery.delivered !== "boolean" ||
			typeof delivery.queued !== "boolean" ||
			(delivery.target !== null && typeof delivery.target !== "string") ||
			!Array.isArray(delivery.attempts) ||
			(delivery.prompt_acknowledged !== undefined && typeof delivery.prompt_acknowledged !== "boolean") ||
			(delivery.state !== undefined &&
				!["queued", "tmux_keys_sent", "acknowledged", "unavailable", "unacknowledged"].includes(
					String(delivery.state),
				))
		)
			return true;
		if (delivery.tmux_keys_sent !== undefined && typeof delivery.tmux_keys_sent !== "boolean") return true;
		if (delivery.runtime_command_id !== undefined && !safeId(delivery.runtime_command_id)) return true;
		if (delivery.runtime_turn_id !== undefined && !safeId(delivery.runtime_turn_id)) return true;
		if (
			delivery.attempts.some(
				attempt =>
					!isRecord(attempt) ||
					typeof attempt.delivered !== "boolean" ||
					!isTime(attempt.created_at) ||
					(attempt.reason !== null && typeof attempt.reason !== "string") ||
					(attempt.channel !== undefined &&
						attempt.channel !== "tmux_keys" &&
						attempt.channel !== "runtime_ack") ||
					(attempt.tmux_keys_sent !== undefined && typeof attempt.tmux_keys_sent !== "boolean"),
			)
		)
			return true;
		return (
			delivery.prompt_acknowledged === true &&
			(delivery.state !== "acknowledged" ||
				!safeId(delivery.runtime_command_id) ||
				!safeId(delivery.runtime_turn_id))
		);
	};
	const invalidProvenance = (value: unknown, turnId: string) =>
		value != null &&
		(!isRecord(value) ||
			value.namespace_id !== namespaceId ||
			value.session_id !== sessionId ||
			value.coordinator_turn_id !== turnId ||
			!safeId(value.endpoint_incarnation) ||
			!safeId(value.runtime_turn_id) ||
			!isTime(value.gate_created_at) ||
			typeof value.schema_hash !== "string" ||
			value.schema_hash.length === 0 ||
			typeof value.stage !== "string" ||
			value.stage.length === 0 ||
			typeof value.kind !== "string" ||
			value.kind.length === 0);
	const invalidAuthorityProvenance = (value: unknown) =>
		!isRecord(value) ||
		value.namespace_id !== namespaceId ||
		value.session_id !== sessionId ||
		(value.coordinator_turn_id !== "" && !safeId(value.coordinator_turn_id)) ||
		!safeId(value.endpoint_incarnation) ||
		!safeId(value.runtime_turn_id) ||
		!isTime(value.gate_created_at) ||
		typeof value.schema_hash !== "string" ||
		value.schema_hash.length === 0 ||
		typeof value.stage !== "string" ||
		value.stage.length === 0 ||
		typeof value.kind !== "string" ||
		value.kind.length === 0;
	const invalidTurn = ([turnId, turn]: [string, CanonicalTurnSnapshotV1]) => {
		if (
			!isRecord(turn) ||
			turn.schema_version !== 1 ||
			turnId !== turn.turn_id ||
			turn.session_id !== sessionId ||
			turn.namespace_id !== namespaceId ||
			!turnStatuses.has(String(turn.status)) ||
			!isRecord(turn.prompt) ||
			typeof turn.prompt.text !== "string" ||
			!isTime(turn.prompt.created_at) ||
			typeof turn.prompt.source !== "string" ||
			invalidDelivery(turn.delivery) ||
			invalidProvenance(turn.runtime_provenance, turnId) ||
			!Array.isArray(turn.question_ids) ||
			new Set(turn.question_ids).size !== turn.question_ids.length ||
			turn.question_ids.some(id => typeof id !== "string" || id.length === 0) ||
			!isRecord(turn.final_response) ||
			(turn.final_response.text !== null && typeof turn.final_response.text !== "string") ||
			turn.final_response.format !== "markdown" ||
			(turn.final_response.source !== null && typeof turn.final_response.source !== "string") ||
			(turn.final_response.artifact_path !== null && typeof turn.final_response.artifact_path !== "string") ||
			typeof turn.final_response.truncated !== "boolean" ||
			(turn.evidence !== undefined &&
				(!Array.isArray(turn.evidence) || turn.evidence.some(value => !isRecord(value)))) ||
			(turn.error !== undefined &&
				turn.error !== null &&
				(!isRecord(turn.error) ||
					typeof turn.error.code !== "string" ||
					typeof turn.error.message !== "string" ||
					typeof turn.error.recoverable !== "boolean")) ||
			(turn.liveness !== undefined &&
				(!isRecord(turn.liveness) ||
					(turn.liveness.checked_at !== null &&
						turn.liveness.checked_at !== undefined &&
						!isTime(turn.liveness.checked_at)) ||
					(turn.liveness.live !== null &&
						turn.liveness.live !== undefined &&
						typeof turn.liveness.live !== "boolean") ||
					(turn.liveness.reason !== null &&
						turn.liveness.reason !== undefined &&
						typeof turn.liveness.reason !== "string"))) ||
			!isTime(turn.created_at) ||
			!isTime(turn.updated_at) ||
			(turn.started_at !== null && !isTime(turn.started_at)) ||
			(turn.completed_at !== null && !isTime(turn.completed_at))
		)
			return true;
		if (turn.status === "queued")
			return turn.started_at !== null || turn.completed_at !== null || turn.terminal_fence !== null;
		if (terminalStatuses.has(turn.status))
			return (
				!isTime(turn.completed_at) ||
				!isRecord(turn.terminal_fence) ||
				!Number.isSafeInteger(turn.terminal_fence.epoch) ||
				turn.terminal_fence.epoch < 1 ||
				turn.terminal_fence.status !== turn.status ||
				!isTime(turn.terminal_fence.at) ||
				(turn.terminal_fence.reason !== null && typeof turn.terminal_fence.reason !== "string")
			);
		return !isTime(turn.started_at) || turn.completed_at !== null || turn.terminal_fence !== null;
	};
	const receiptFor = (turn: CanonicalTurnSnapshotV1) =>
		Object.values(prompts).some(
			request =>
				request.coordinator_turn_id === turn.turn_id &&
				["accepted", "linked", "terminal", "completed"].includes(request.phase) &&
				request.runtime_receipt?.accepted === true &&
				request.runtime_receipt.command_id === (turn.delivery as Record<string, unknown>).runtime_command_id &&
				request.runtime_receipt.turn_id === (turn.delivery as Record<string, unknown>).runtime_turn_id,
		);
	const invalidPrompt = ([key, request]: [string, PromptRequestV1]) =>
		!isRecord(request) ||
		key !== request.key_digest ||
		!safeId(request.request_id) ||
		!safeId(request.key_digest) ||
		!safeId(request.request_digest) ||
		(request.operation !== "turn.prompt" &&
			request.operation !== "turn.follow_up" &&
			request.operation !== "turn.abort_and_prompt") ||
		!isRecord(request.canonical_prompt) ||
		typeof request.canonical_prompt.text !== "string" ||
		!safeId(request.sdk_idempotency_key) ||
		!promptPhases.has(String(request.phase)) ||
		(request.delegate_response_pending !== undefined && typeof request.delegate_response_pending !== "boolean") ||
		!isTime(request.created_at) ||
		!isTime(request.updated_at) ||
		(request.coordinator_turn_id !== undefined &&
			(!safeId(request.coordinator_turn_id) || !turns[request.coordinator_turn_id])) ||
		(request.runtime_receipt !== undefined &&
			(!isRecord(request.runtime_receipt) ||
				request.runtime_receipt.accepted !== true ||
				!safeId(request.runtime_receipt.command_id) ||
				!safeId(request.runtime_receipt.turn_id))) ||
		(["accepted", "linked", "terminal", "completed"].includes(request.phase) &&
			request.coordinator_turn_id !== undefined &&
			request.runtime_receipt === undefined) ||
		(request.safe_response !== undefined && !isRecord(request.safe_response)) ||
		(request.error_code !== undefined && typeof request.error_code !== "string");
	const queue = transaction.canonical?.queue;
	const reports = transaction.canonical?.reports;
	const authorities = transaction.canonical?.gate_authorities;
	const questions = transaction.canonical?.questions;
	const answers = transaction.requests?.answers;
	const operations = transaction.requests?.operations;
	const outbox = transaction.outbox;
	const projection = transaction.projection;
	const recovery = transaction.recovery;
	const invalidReport = ([reportId, report]: [string, CanonicalReportSnapshotV1]) =>
		!isRecord(report) ||
		!COORDINATOR_REPORT_ID_PATTERN.test(reportId) ||
		report.report_id !== reportId ||
		report.schema_version !== 1 ||
		report.session_id !== sessionId ||
		!safeId(report.operation_id) ||
		(report.turn_id !== "" && (!safeId(report.turn_id) || !turns[report.turn_id])) ||
		typeof report.status !== "string" ||
		typeof report.summary !== "string" ||
		(report.blocker !== null && typeof report.blocker !== "string") ||
		(report.pr_url !== null && typeof report.pr_url !== "string") ||
		!Array.isArray(report.evidence_paths) ||
		new Set(report.evidence_paths).size !== report.evidence_paths.length ||
		report.evidence_paths.some(value => typeof value !== "string") ||
		!isTime(report.created_at);
	const invalidAuthority = ([authorityId, authority]: [string, GateAuthorityEntryV1]) => {
		if (
			!isRecord(authority) ||
			!safeId(authorityId) ||
			!isRecord(authority.authority) ||
			authority.authority.namespace_id !== namespaceId ||
			authority.authority.session_id !== sessionId ||
			typeof authority.authority.endpoint_incarnation !== "string" ||
			authority.authority.endpoint_incarnation.length === 0 ||
			!safeId(authority.authority.gate_id) ||
			!isRecord(authority.observation) ||
			!isRecord(authority.outcome) ||
			!isTime(authority.first_seen_at) ||
			!isTime(authority.updated_at)
		)
			return true;
		const outcome = authority.outcome as Record<string, unknown>;
		if (authority.observation.kind === "valid") {
			const provenance = authority.observation.first_provenance;
			if (outcome.state === "deferred_link") {
				if (
					!isRecord(provenance) ||
					provenance.namespace_id !== namespaceId ||
					provenance.session_id !== sessionId ||
					provenance.coordinator_turn_id !== "" ||
					!safeId(provenance.endpoint_incarnation) ||
					!safeId(provenance.runtime_turn_id) ||
					!isTime(provenance.gate_created_at) ||
					typeof provenance.schema_hash !== "string" ||
					provenance.schema_hash.length === 0 ||
					typeof provenance.stage !== "string" ||
					provenance.stage.length === 0 ||
					typeof provenance.kind !== "string" ||
					provenance.kind.length === 0
				)
					return true;
			} else if (
				(outcome.state === "pending" || outcome.state === "answered") &&
				invalidProvenance(provenance, String(outcome.turn_id ?? ""))
			) {
				return true;
			} else if (
				outcome.state !== "pending" &&
				outcome.state !== "answered" &&
				invalidAuthorityProvenance(provenance)
			) {
				return true;
			}
		} else if (
			authority.observation.kind !== "malformed" ||
			!/^[a-f0-9]{64}$/.test(String(authority.observation.immutable_observation_digest ?? "")) ||
			!["missing_runtime_turn", "invalid_runtime_turn", "invalid_gate_row", "wrong_session"].includes(
				String(authority.observation.malformed),
			)
		)
			return true;
		if (
			![
				"deferred_link",
				"pending",
				"answered",
				"stale",
				"uncertain",
				"ownership_unavailable",
				"ownership_conflict",
			].includes(String(outcome.state))
		)
			return true;
		if (outcome.state === "pending" || outcome.state === "answered") {
			const question = questions[String(outcome.question_id)];
			if (
				typeof outcome.turn_id !== "string" ||
				!safeId(outcome.turn_id) ||
				typeof outcome.question_id !== "string" ||
				!safeId(outcome.question_id) ||
				!turns[outcome.turn_id] ||
				!question ||
				question.authority_id !== authorityId ||
				question.turn_id !== outcome.turn_id
			)
				return true;
		}
		return (
			(outcome.state === "deferred_link" && !isTime(outcome.first_seen_at)) ||
			(["stale", "uncertain", "ownership_unavailable", "ownership_conflict"].includes(String(outcome.state)) &&
				typeof outcome.reason !== "string")
		);
	};
	const invalidQuestion = ([questionId, question]: [string, PrivateQuestionV1]) => {
		if (
			!isRecord(question) ||
			question.question_id !== questionId ||
			!safeId(questionId) ||
			!safeId(question.authority_id) ||
			!authorities[question.authority_id] ||
			question.session_id !== sessionId ||
			!safeId(question.turn_id) ||
			!turns[question.turn_id] ||
			question.endpoint_incarnation !== transaction.canonical.session.broker.endpoint_incarnation ||
			typeof question.stage !== "string" ||
			typeof question.kind !== "string" ||
			typeof question.prompt !== "string" ||
			!["pending", "resolving", "answered", "stale", "uncertain"].includes(question.status) ||
			typeof question.binding_plaintext !== "string" ||
			!/^[a-f0-9]{64}$/.test(question.binding_sha256) ||
			!isRecord(question.codec) ||
			!Array.isArray(question.history) ||
			!isTime(question.created_at) ||
			!isTime(question.updated_at) ||
			(question.answered_at !== null && !isTime(question.answered_at))
		)
			return true;
		if (question.binding_sha256 !== digest(question.binding_plaintext)) return true;
		if (
			question.claim_fence_epoch !== null &&
			(!Number.isSafeInteger(question.claim_fence_epoch) || question.claim_fence_epoch < 1)
		)
			return true;
		if (
			question.answer_request_id !== null &&
			(!safeId(question.answer_request_id) ||
				(question.status === "resolving" &&
					!Object.values(answers).some(request => request.request_id === question.answer_request_id)))
		)
			return true;
		if (
			question.history.some(
				item =>
					!isRecord(item) ||
					!isTime(item.at) ||
					!["pending", "resolving", "answered", "stale", "uncertain"].includes(String(item.status)) ||
					(item.reason !== null && typeof item.reason !== "string"),
			)
		)
			return true;
		if (question.status === "pending")
			return question.claim_fence_epoch !== null || question.answer_request_id !== null;
		if (question.status === "resolving")
			return question.claim_fence_epoch === null || question.answer_request_id === null;
		return question.status === "answered" && question.answered_at === null;
	};
	const invalidAnswer = ([answerKey, request]: [string, AnswerRequestV1]) => {
		if (
			!isRecord(request) ||
			request.key_digest !== answerKey ||
			!safeId(request.request_id) ||
			!safeId(request.key_digest) ||
			!safeId(request.request_digest) ||
			!/^[a-f0-9]{64}$/.test(request.answer_hash) ||
			!/^[a-f0-9]{64}$/.test(request.answer_binding_sha256) ||
			!safeId(request.authority_id) ||
			!safeId(request.question_id) ||
			!safeId(request.turn_id) ||
			!safeId(request.endpoint_incarnation) ||
			!safeId(request.sdk_idempotency_key) ||
			!Number.isSafeInteger(request.claim_fence_epoch) ||
			request.claim_fence_epoch < 1 ||
			!["claimed", "remote_started", "accepted", "rejected", "completed", "uncertain"].includes(request.phase) ||
			!isTime(request.created_at) ||
			!isTime(request.updated_at)
		)
			return true;
		const question = questions[request.question_id];
		if (
			!question ||
			question.authority_id !== request.authority_id ||
			question.turn_id !== request.turn_id ||
			question.endpoint_incarnation !== request.endpoint_incarnation
		)
			return true;
		// A rejected receipt is immutable evidence of a completed historical attempt.
		// It must remain replayable after a corrected attempt changes the question's active link.
		const rejectedHistorical = request.phase === "rejected";
		if (
			rejectedHistorical
				? request.safe_receipt?.status !== "rejected"
				: question.answer_request_id !== request.request_id ||
					question.claim_fence_epoch !== request.claim_fence_epoch
		)
			return true;
		if (
			request.safe_receipt !== undefined &&
			(!isRecord(request.safe_receipt) ||
				!["accepted", "rejected"].includes(String(request.safe_receipt.status)) ||
				request.safe_receipt.answer_hash !== request.answer_hash ||
				request.safe_receipt.answer_binding_sha256 !== request.answer_binding_sha256 ||
				request.safe_receipt.authority_id !== request.authority_id ||
				request.safe_receipt.turn_id !== request.turn_id ||
				request.safe_receipt.endpoint_incarnation !== request.endpoint_incarnation ||
				request.safe_receipt.claim_fence_epoch !== request.claim_fence_epoch ||
				!isTime(request.safe_receipt.resolved_at))
		)
			return true;
		if (
			(request.phase === "rejected" && request.safe_receipt?.status !== "rejected") ||
			(request.phase === "completed" && request.safe_receipt?.status !== "accepted") ||
			(!["rejected", "completed"].includes(request.phase) && request.safe_receipt !== undefined)
		)
			return true;
		return request.error_code !== undefined && typeof request.error_code !== "string";
	};
	const invalidOperation = ([operationId, operation]: [string, OperationRequestV1]) =>
		!isRecord(operation) ||
		operation.operation_id !== operationId ||
		!safeId(operationId) ||
		typeof operation.tool !== "string" ||
		!safeId(operation.key_digest) ||
		!safeId(operation.request_digest) ||
		!safeId(operation.local_id) ||
		(operation.remote_id !== undefined && !safeId(operation.remote_id)) ||
		!["claimed", "remote_started", "completed", "uncertain"].includes(operation.phase) ||
		!isRecord(operation.intent) ||
		!isTime(operation.created_at) ||
		!isTime(operation.updated_at) ||
		(operation.safe_response !== undefined && !isRecord(operation.safe_response)) ||
		(operation.error_code !== undefined && typeof operation.error_code !== "string");
	const invalidOutbox = ([eventId, event]: [string, OutboxEventV1]) => {
		const safePublicEventId = (value: unknown): value is string =>
			typeof value === "string" && /^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,511}$/.test(value);
		if (
			!isRecord(event) ||
			event.id !== eventId ||
			typeof eventId !== "string" ||
			eventId.length === 0 ||
			!Number.isSafeInteger(event.transaction_revision) ||
			event.transaction_revision < 1 ||
			event.transaction_revision > transaction.revision ||
			typeof event.kind !== "string" ||
			event.kind.length === 0 ||
			!isOutboxEntity(event.entity) ||
			typeof event.entity_id !== "string" ||
			event.entity_id.length === 0 ||
			!isRecord(event.payload) ||
			Object.values(event.payload).some(
				value => value !== null && !["string", "number", "boolean"].includes(typeof value),
			) ||
			typeof event.emitted !== "boolean" ||
			!safePublicEventId(event.public_event_id) ||
			!isRecord(event.public_delivery)
		)
			return true;
		const delivery = event.public_delivery;
		if (
			delivery.public_event_id !== event.public_event_id ||
			!["pending", "claimed", "acknowledged"].includes(delivery.state) ||
			(delivery.claim_fence !== null && (!Number.isSafeInteger(delivery.claim_fence) || delivery.claim_fence < 1)) ||
			(delivery.claim_expires_at !== null && !isTime(delivery.claim_expires_at)) ||
			(delivery.journal_seq !== null && (!Number.isSafeInteger(delivery.journal_seq) || delivery.journal_seq < 1)) ||
			(delivery.acknowledged_at !== null && !isTime(delivery.acknowledged_at))
		)
			return true;
		return (
			(delivery.state === "pending" &&
				(delivery.claim_fence !== null ||
					delivery.claim_expires_at !== null ||
					delivery.journal_seq !== null ||
					delivery.acknowledged_at !== null)) ||
			(delivery.state === "claimed" &&
				(delivery.claim_fence === null ||
					delivery.claim_expires_at === null ||
					delivery.journal_seq !== null ||
					delivery.acknowledged_at !== null)) ||
			(delivery.state === "acknowledged" && (delivery.claim_expires_at !== null || delivery.journal_seq === null))
		);
	};
	if (
		!isRecord(transaction) ||
		transaction.schema_version !== 1 ||
		typeof transaction.creation_intent_digest !== "string" ||
		!/^[a-f0-9]{64}$/.test(transaction.creation_intent_digest) ||
		transaction.namespace_id !== namespaceId ||
		transaction.session_id !== sessionId ||
		!isRecord(transaction.canonical) ||
		!isRecord(transaction.requests) ||
		!isRecord(turns) ||
		!isRecord(prompts) ||
		!isRecord(answers) ||
		!isRecord(operations) ||
		!isRecord(reports) ||
		!isRecord(authorities) ||
		!isRecord(questions) ||
		!isRecord(outbox) ||
		!isRecord(projection) ||
		!isRecord(recovery) ||
		!isRecord(queue) ||
		!isRecord(transaction.canonical.session) ||
		transaction.canonical.session.namespace_id !== namespaceId ||
		transaction.canonical.session.session_id !== sessionId ||
		typeof transaction.canonical.session.cwd !== "string" ||
		transaction.canonical.session.cwd.length === 0 ||
		!isTime(transaction.canonical.session.created_at) ||
		!isTime(transaction.canonical.session.updated_at) ||
		!isRecord(transaction.canonical.session.broker) ||
		!isRecord(transaction.canonical.session.broker.sidecar_verifier) ||
		!/^[a-f0-9]{64}$/.test(String(transaction.canonical.session.broker.sidecar_verifier.key_id ?? "")) ||
		typeof transaction.canonical.session.broker.sidecar_verifier.public_key !== "string" ||
		!validStates.has(String(transaction.canonical.desired_session_state)) ||
		Object.entries(turns).some(invalidTurn) ||
		Object.entries(prompts).some(invalidPrompt) ||
		new Set(Object.values(prompts).map(request => request.request_id)).size !== Object.keys(prompts).length ||
		Object.entries(authorities).some(invalidAuthority) ||
		Object.entries(questions).some(invalidQuestion) ||
		Object.entries(answers).some(invalidAnswer) ||
		new Set(Object.values(answers).map(request => request.request_id)).size !== Object.keys(answers).length ||
		Object.entries(operations).some(invalidOperation) ||
		new Set(Object.values(operations).map(request => request.operation_id)).size !== Object.keys(operations).length ||
		Object.entries(outbox).some(invalidOutbox) ||
		new Set(Object.values(outbox).map(event => event.public_event_id)).size !== Object.keys(outbox).length ||
		Object.entries(reports).some(invalidReport) ||
		new Set(Object.values(reports).map(report => report.operation_id)).size !== Object.keys(reports).length ||
		!Array.isArray(queue.ordered_turn_ids) ||
		new Set(queue.ordered_turn_ids).size !== queue.ordered_turn_ids.length ||
		queue.ordered_turn_ids.some(
			turnId => typeof turnId !== "string" || !turns[turnId] || turns[turnId].status !== "queued",
		) ||
		(queue.active_turn_id !== null &&
			(!safeId(queue.active_turn_id) ||
				!turns[queue.active_turn_id] ||
				!activeStatuses.has(turns[queue.active_turn_id].status))) ||
		!Number.isSafeInteger(transaction.revision) ||
		transaction.revision < 1 ||
		(transaction.endpoint !== null &&
			(!isRecord(transaction.endpoint) ||
				!safeId(transaction.endpoint.incarnation) ||
				!isTime(transaction.endpoint.observed_at))) ||
		[
			projection.applied_turns_revision,
			projection.applied_reports_revision,
			projection.applied_session_revision,
			projection.applied_active_revision,
			projection.applied_events_revision,
			projection.scheduler_pending_revision,
			projection.scheduler_applied_revision,
		].some(
			value => value !== undefined && (!Number.isSafeInteger(value) || value < 0 || value > transaction.revision),
		) ||
		(projection.scheduler_digest !== undefined &&
			(typeof projection.scheduler_digest !== "string" || projection.scheduler_digest.length === 0)) ||
		(recovery.prompt_watermark_at !== null && !isTime(recovery.prompt_watermark_at)) ||
		(recovery.last_repaired_at !== null && !isTime(recovery.last_repaired_at)) ||
		(queue.selected_promotion !== null &&
			(!isRecord(queue.selected_promotion) ||
				!safeId(queue.selected_promotion.from_turn_id) ||
				!safeId(queue.selected_promotion.to_turn_id) ||
				!Number.isSafeInteger(queue.selected_promotion.revision) ||
				!turns[queue.selected_promotion.from_turn_id] ||
				!turns[queue.selected_promotion.to_turn_id])) ||
		Object.values(turns).some(
			turn =>
				activeStatuses.has(turn.status) &&
				(turn.delivery as Record<string, unknown>).prompt_acknowledged === true &&
				!receiptFor(turn),
		)
	)
		throw new Error("state_corrupt");
}
export async function initializeCoordinatorNamespace(paths: CoordinatorStatePaths): Promise<void> {
	await ensureNamespaceParents(paths);
	await ensureCoordinatorDirectory(paths.sessions);
	await ensureCoordinatorDirectory(path.dirname(paths.journal));
	await withFileLock(paths.registryLock, async () => {
		const existing = await readJson<NamespaceRegistryV1>(paths.registry);
		if (existing === null)
			await writeAtomic(paths.registry, {
				schema_version: 1,
				namespace_id: path.basename(paths.root),
				creations: {},
				deletions: {},
				roster: {},
				scheduler_revision: 0,
				scheduler_cursor: "",
				retained_sessions: {},
				delivery_discovery_cursor: "@session:",
			});
		else if (existing.schema_version !== 1 || existing.namespace_id !== path.basename(paths.root))
			throw new Error("state_corrupt");
	});
}
export async function withNamespaceRegistry<T>(
	paths: CoordinatorStatePaths,
	operation: (registry: NamespaceRegistryV1) => Promise<T>,
	options: { signal?: AbortSignal } = {},
): Promise<T> {
	await ensureNamespaceParents(paths);
	return await withFileLock(
		paths.registryLock,
		async () => {
			const registry = await readJson<NamespaceRegistryV1>(paths.registry);
			if (registry?.schema_version !== 1 || registry.namespace_id !== path.basename(paths.root))
				throw new Error("state_corrupt");
			registry.roster ??= {};
			registry.scheduler_revision ??= 0;
			registry.scheduler_cursor ??= "";
			registry.retained_sessions ??= {};
			registry.delivery_discovery_cursor ??= "@session:";
			const result = await operation(registry);
			await writeAtomic(paths.registry, registry);
			return result;
		},
		lockOptions(options.signal),
	);
}
export async function ensureSchedulerRoster(
	paths: CoordinatorStatePaths,
	sessionId: string,
	options: { signal?: AbortSignal } = {},
): Promise<void> {
	const transaction = await readTransactionJson<CoordinatorSessionTransactionV1>(transactionPath(paths, sessionId));
	if (!transaction) return;
	await withNamespaceRegistry(
		paths,
		async registry => {
			registry.roster ??= {};
			const existing = registry.roster[sessionId];
			registry.scheduler_revision = Math.max(registry.scheduler_revision ?? 0, transaction.revision);
			registry.roster[sessionId] = {
				session_id: sessionId,
				revision: transaction.revision,
				digest: digest(JSON.stringify(transaction.canonical.queue)),
				active:
					transaction.canonical.queue.active_turn_id !== null ||
					Object.values(transaction.canonical.turns).some(turn =>
						["queued", "delivering", "active", "waiting_for_answer", "completing"].includes(turn.status),
					) ||
					transaction.canonical.desired_session_state === "needs_user_input",
				dirty: existing?.dirty ?? false,
				updated_at: new Date().toISOString(),
			};
		},
		options,
	);
}

export async function listCanonicalActiveSessions(
	paths: CoordinatorStatePaths,
	options: { signal?: AbortSignal } = {},
): Promise<string[]> {
	await ensureNamespaceParents(paths);
	const sessionIds = await withFileLock(
		paths.registryLock,
		async () => {
			const registry = await readJson<NamespaceRegistryV1>(paths.registry);
			if (registry?.schema_version !== 1 || registry.namespace_id !== path.basename(paths.root))
				throw new Error("state_corrupt");
			return Object.values(registry.roster ?? {})
				.filter(entry => entry.active || entry.dirty)
				.map(entry => entry.session_id)
				.sort();
		},
		lockOptions(options.signal),
	);
	const active: string[] = [];
	for (const sessionId of sessionIds) {
		if (options.signal?.aborted) throw options.signal.reason ?? new Error("aborted");
		const transaction = await readTransactionJson<CoordinatorSessionTransactionV1>(transactionPath(paths, sessionId));
		if (!transaction) continue;
		assertTransaction(transaction, path.basename(paths.root), sessionId);
		const hasActiveTurn = Object.values(transaction.canonical.turns).some(turn =>
			["queued", "delivering", "active", "waiting_for_answer", "completing"].includes(turn.status),
		);
		if (
			hasActiveTurn ||
			transaction.canonical.queue.active_turn_id !== null ||
			transaction.canonical.desired_session_state === "needs_user_input"
		)
			active.push(sessionId);
	}
	return active;
}

export async function readDeliveryDiscoveryCursor(
	paths: CoordinatorStatePaths,
	options: { signal?: AbortSignal } = {},
): Promise<string> {
	await ensureNamespaceParents(paths);
	return await withFileLock(
		paths.registryLock,
		async () => {
			const registry = await readJson<NamespaceRegistryV1>(paths.registry);
			if (registry?.schema_version !== 1 || registry.namespace_id !== path.basename(paths.root))
				throw new Error("state_corrupt");
			return registry.delivery_discovery_cursor ?? "";
		},
		lockOptions(options.signal),
	);
}

export async function advanceDeliveryDiscoveryCursor(
	paths: CoordinatorStatePaths,
	cursor: string,
	options: { signal?: AbortSignal } = {},
): Promise<void> {
	await withNamespaceRegistry(
		paths,
		async registry => {
			registry.delivery_discovery_cursor = cursor;
		},
		options,
	);
}

export async function readSchedulerRoster(
	paths: CoordinatorStatePaths,
	options: { signal?: AbortSignal } = {},
): Promise<{
	roster: Array<{
		session_id: string;
		revision: number;
		digest: string;
		active: boolean;
		dirty: boolean;
		updated_at: string;
	}>;
	cursor: string;
}> {
	await ensureNamespaceParents(paths);
	return await withFileLock(
		paths.registryLock,
		async () => {
			const registry = await readJson<NamespaceRegistryV1>(paths.registry);
			if (registry?.schema_version !== 1 || registry.namespace_id !== path.basename(paths.root))
				throw new Error("state_corrupt");
			return {
				roster: Object.values(registry.roster ?? {}).sort((left, right) =>
					left.session_id.localeCompare(right.session_id),
				),
				cursor: registry.scheduler_cursor ?? "",
			};
		},
		lockOptions(options.signal),
	);
}

export async function advanceSchedulerCursor(
	paths: CoordinatorStatePaths,
	cursor: string,
	options: { signal?: AbortSignal } = {},
): Promise<void> {
	await withNamespaceRegistry(
		paths,
		async registry => {
			registry.scheduler_cursor = cursor;
		},
		options,
	);
}

export async function readSessionTransaction(
	paths: CoordinatorStatePaths,
	sessionId: string,
): Promise<CoordinatorSessionTransactionV1 | null> {
	const transaction = await readTransactionJson<CoordinatorSessionTransactionV1>(transactionPath(paths, sessionId));
	if (!transaction) return null;
	assertTransaction(transaction, path.basename(paths.root), sessionId);
	normalizeOutbox(transaction);
	return transaction;
}

export async function withSessionTransaction<T>(
	paths: CoordinatorStatePaths,
	sessionId: string,
	operation: (transaction: CoordinatorSessionTransactionV1) => Promise<T>,
	options: { signal?: AbortSignal } = {},
): Promise<T> {
	const file = transactionPath(paths, sessionId);
	await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
	return await withFileLock(
		transactionLockPath(paths, sessionId),
		async () => {
			const transaction = await readTransactionJson<CoordinatorSessionTransactionV1>(file);
			if (!transaction) throw new Error("resource_gone");
			assertTransaction(transaction, path.basename(paths.root), sessionId);
			const beforeDigest = digest(JSON.stringify(transaction));
			normalizeOutbox(transaction);
			const result = await operation(transaction);
			normalizeOutbox(transaction);
			const beforeCompaction = JSON.parse(JSON.stringify(transaction)) as CoordinatorSessionTransactionV1;
			compactTransaction(transaction);
			await archiveCompactedHistory(paths, beforeCompaction, transaction);
			if (digest(JSON.stringify(transaction)) === beforeDigest) return result;
			transaction.projection.scheduler_pending_revision = transaction.revision + 1;
			transaction.projection.scheduler_digest = digest(
				JSON.stringify({
					session_id: transaction.session_id,
					revision: transaction.revision + 1,
					active: transaction.canonical.queue.active_turn_id !== null,
					state: transaction.canonical.desired_session_state,
				}),
			);
			transaction.revision++;
			// Callers mutate this authoritative object in place. Validate the complete
			// post-image after compaction and revision/projection updates so malformed
			// ingress can never poison the WAL.
			assertTransaction(transaction, path.basename(paths.root), sessionId);
			await writeAtomic(file, transaction);
			return result;
		},
		lockOptions(options.signal),
	);
}

/** Remove a retained-session hint once its WAL has no unacknowledged deliveries. */
async function pruneRetainedSessionIfEmpty(
	paths: CoordinatorStatePaths,
	sessionId: string,
	options: { signal?: AbortSignal } = {},
): Promise<void> {
	await withNamespaceRegistry(
		paths,
		async registry =>
			await withFileLock(
				transactionLockPath(paths, sessionId),
				async () => {
					const transaction = await readTransactionJson<CoordinatorSessionTransactionV1>(
						transactionPath(paths, sessionId),
					);
					if (transaction) normalizeOutbox(transaction);
					if (
						!transaction ||
						!Object.values(transaction.outbox).some(event => event.public_delivery.state !== "acknowledged")
					)
						delete registry.retained_sessions?.[sessionId];
				},
				lockOptions(options.signal),
			),
		options,
	);
}

/** Atomically admits a session close against the canonical WAL and registry. */
export async function admitSessionClose(
	paths: CoordinatorStatePaths,
	entry: NamespaceDeletionEntryV1,
	options: { signal?: AbortSignal; idleBeforeMs?: number } = {},
): Promise<CoordinatorSessionTransactionV1> {
	return await withNamespaceRegistry(
		paths,
		async registry =>
			await withFileLock(
				transactionLockPath(paths, entry.session_id),
				async () => {
					const transaction = await readTransactionJson<CoordinatorSessionTransactionV1>(
						transactionPath(paths, entry.session_id),
					);
					if (!transaction) throw new Error("resource_gone");
					assertTransaction(transaction, path.basename(paths.root), entry.session_id);
					const existing = registry.deletions[entry.deletion_id];
					if (
						existing &&
						(existing.key_digest !== entry.key_digest || existing.request_digest !== entry.request_digest)
					)
						throw new Error("idempotency_conflict");
					const active = Object.values(transaction.canonical.turns).find(turn =>
						["delivering", "active", "waiting_for_answer", "completing"].includes(turn.status),
					);
					const reservedPrompt = Object.values(transaction.requests.prompts).some(
						request =>
							request.operation !== "turn.follow_up" &&
							["claimed", "remote_started", "accepted"].includes(request.phase),
					);
					if (active || transaction.canonical.queue.active_turn_id !== null || reservedPrompt)
						throw new Error("active_turn_exists");
					if (options.idleBeforeMs !== undefined) {
						const activityAt =
							transaction.recovery.prompt_watermark_at ?? transaction.canonical.session.updated_at;
						const activityMs = Date.parse(activityAt);
						if (!Number.isFinite(activityMs) || activityMs > options.idleBeforeMs)
							throw new Error("session_not_idle");
					}
					registry.deletions[entry.deletion_id] = existing ?? entry;
					return transaction;
				},
				lockOptions(options.signal),
			),
		options,
	);
}

/** Serializes a session mutation with namespace close admission. */
export async function withAdmittedSessionTransaction<T>(
	paths: CoordinatorStatePaths,
	sessionId: string,
	operation: (transaction: CoordinatorSessionTransactionV1) => Promise<T>,
	options: { signal?: AbortSignal } = {},
): Promise<T> {
	return await withNamespaceRegistry(
		paths,
		async registry => {
			const latest: { value: CoordinatorSessionTransactionV1 | null } = { value: null };
			const result = await withSessionTransaction(
				paths,
				sessionId,
				async transaction => {
					assertCloseAdmission(registry, transaction);
					const value = await operation(transaction);
					latest.value = transaction;
					return value;
				},
				options,
			);
			if (latest.value) {
				registry.roster ??= {};
				registry.scheduler_revision = Math.max(registry.scheduler_revision ?? 0, latest.value.revision);
				registry.roster[sessionId] = {
					session_id: sessionId,
					revision: latest.value.revision,
					digest: digest(JSON.stringify(latest.value.canonical.queue)),
					active:
						latest.value.canonical.queue.active_turn_id !== null ||
						Object.values(latest.value.canonical.turns).some(turn =>
							["queued", "delivering", "active", "waiting_for_answer", "completing"].includes(turn.status),
						) ||
						latest.value.canonical.desired_session_state === "needs_user_input",
					dirty: true,
					updated_at: new Date().toISOString(),
				};
				registry.retained_sessions ??= {};
				if (Object.values(latest.value.outbox).some(event => event.public_delivery.state !== "acknowledged"))
					registry.retained_sessions[sessionId] = {
						session_id: sessionId,
						updated_at: new Date().toISOString(),
					};
				else delete registry.retained_sessions?.[sessionId];
			}
			return result;
		},
		options,
	);
}

/** Claims a caller-visible creation request before any remote work or projection. */
export async function claimCreationRequest(
	paths: CoordinatorStatePaths,
	input: {
		key_digest: string;
		request_digest: string;
		tool: string;
		sidecar_verifier: { key_id: string; public_key: string };
	},
): Promise<CreationRequestV1> {
	return await withNamespaceRegistry(paths, async registry => {
		const existing = registry.creations[input.key_digest];
		if (existing) {
			if (existing.request_digest !== input.request_digest || existing.tool !== input.tool)
				throw new Error("idempotency_conflict");
			if (!existing.sidecar_verifier || !/^[a-f0-9]{64}$/.test(existing.sidecar_verifier.key_id))
				throw new Error("state_corrupt");
			return existing;
		}
		if (!/^[a-f0-9]{64}$/.test(input.sidecar_verifier.key_id) || !input.sidecar_verifier.public_key)
			throw new Error("state_corrupt");
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
			sidecar_verifier: input.sidecar_verifier,
			created_at: now,
			updated_at: now,
		};
		registry.creations[input.key_digest] = request;
		return request;
	});
}

/**
 * Replaces a claimed creation's verifier before any remote effect.  A server
 * restart intentionally loses the private half, so only this pre-effect phase
 * may acquire a new authority.
 */
export async function rotateClaimedCreationVerifier(
	paths: CoordinatorStatePaths,
	keyDigest: string,
	expectedKeyId: string,
	sidecarVerifier: { key_id: string; public_key: string },
): Promise<CreationRequestV1> {
	return await withNamespaceRegistry(paths, async registry => {
		const request = registry.creations[keyDigest];
		if (!request) throw new Error("state_corrupt");
		if (request.phase === "claimed" && request.sidecar_verifier?.key_id === expectedKeyId) {
			if (!/^[a-f0-9]{64}$/.test(sidecarVerifier.key_id) || !sidecarVerifier.public_key)
				throw new Error("state_corrupt");
			request.sidecar_verifier = sidecarVerifier;
			request.updated_at = new Date().toISOString();
		}
		return request;
	});
}

/**
 * Fences a creation before a broker-visible effect. The durable verifier is the
 * only signing authority a recovery may retain until the broker proves a
 * different candidate actually launched.
 */
export async function startCreationRemote(
	paths: CoordinatorStatePaths,
	keyDigest: string,
	expectedVerifier: { key_id: string; public_key: string },
): Promise<CreationRequestV1> {
	return await withNamespaceRegistry(paths, async registry => {
		const request = registry.creations[keyDigest];
		if (!request?.sidecar_verifier) throw new Error("state_corrupt");
		if (
			request.phase === "claimed" &&
			(request.sidecar_verifier.key_id !== expectedVerifier.key_id ||
				request.sidecar_verifier.public_key !== expectedVerifier.public_key)
		)
			throw new Error("state_corrupt");
		if (request.phase === "claimed") request.phase = "remote_started";
		if (request.phase !== "remote_started") throw new Error("terminal_uncertain");
		request.updated_at = new Date().toISOString();
		return request;
	});
}

/**
 * Reconciles an attempted launch against broker-persisted public evidence. A
 * replay retains its original verifier; only proof that the candidate key was
 * used may rotate the durable verifier.
 */
export async function reconcileCreationRemoteVerifier(
	paths: CoordinatorStatePaths,
	keyDigest: string,
	candidate: { key_id: string; public_key: string },
	usedKeyId: string,
): Promise<CreationRequestV1> {
	return await withNamespaceRegistry(paths, async registry => {
		const request = registry.creations[keyDigest];
		if (!request?.sidecar_verifier || request.phase !== "remote_started") throw new Error("terminal_uncertain");
		if (!/^[a-f0-9]{64}$/.test(usedKeyId)) throw new Error("terminal_uncertain");
		if (usedKeyId === candidate.key_id) request.sidecar_verifier = candidate;
		else if (usedKeyId !== request.sidecar_verifier.key_id) throw new Error("terminal_uncertain");
		request.updated_at = new Date().toISOString();
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
				request.endpoint_incarnation !== session.broker.endpoint_incarnation ||
				request.sidecar_verifier?.key_id !== session.broker.sidecar_verifier.key_id)
		)
			throw new Error("state_corrupt");
		// A broker-created session is reconciled before binding. Binding must never
		// infer signer authority from a remotely claimed phase or snapshot. Local
		// registration has no remote create effect and retains its existing binding.
		if (
			!request.session_id &&
			request.phase !== "claimed" &&
			request.sidecar_verifier?.key_id !== session.broker.sidecar_verifier.key_id
		)
			throw new Error("terminal_uncertain");
		if (!request.session_id && request.phase === "claimed")
			request.sidecar_verifier = session.broker.sidecar_verifier;
		if (
			Object.values(registry.deletions).some(
				entry =>
					entry.session_id === session.session_id &&
					entry.endpoint_incarnation === session.broker.endpoint_incarnation,
			)
		)
			throw new Error("session_closing");
		if (request.canonical_create_intent && canonicalJson(request.canonical_create_intent) !== canonicalJson(intent))
			throw new Error("idempotency_conflict");
		request.canonical_create_intent ??= intent;
		request.session_id = session.session_id;
		request.endpoint_incarnation = session.broker.endpoint_incarnation;
		if (request.phase === "claimed") request.phase = "remote_started";
		request.updated_at = new Date().toISOString();
		return request;
	});
}

/**
 * Creation provenance must bind all semantic launch inputs while allowing idempotent
 * recovery to regenerate observation timestamps.
 */
function creationIntentDigest(intent: CanonicalCreateIntentV1): string {
	const { created_at: _createdAt, updated_at: _updatedAt, ...session } = intent.session;
	const initial_events = intent.initial_events.map(({ created_at: _eventCreatedAt, ...event }) => event);
	return digest(canonicalJson({ ...intent, session, initial_events }));
}

/** Creates the durable session WAL for an already claimed creation request. */
export async function commitCreationWal(
	paths: CoordinatorStatePaths,
	keyDigest: string,
	intent: CanonicalCreateIntentV1,
): Promise<CoordinatorSessionTransactionV1> {
	const intentDigest = creationIntentDigest(intent);
	// Validate an existing WAL before binding, so a creation-intent mismatch cannot
	// update the registry receipt or any other durable state.
	const preexisting = await readTransactionJson<CoordinatorSessionTransactionV1>(
		transactionPath(paths, intent.session.session_id),
	);
	if (preexisting) {
		assertTransaction(preexisting, intent.session.namespace_id, intent.session.session_id);
		if (
			preexisting.canonical.session.broker.endpoint_incarnation === intent.session.broker.endpoint_incarnation &&
			preexisting.creation_intent_digest !== intentDigest
		)
			throw new Error("idempotency_conflict");
	}
	await bindCreationRequest(paths, keyDigest, intent);
	return await withNamespaceRegistry(paths, async registry => {
		const session = intent.session;
		return await withFileLock(transactionLockPath(paths, session.session_id), async () => {
			const request = registry.creations[keyDigest];
			if (!request || request.canonical_create_intent === null) throw new Error("state_corrupt");
			let existing = await readTransactionJson<CoordinatorSessionTransactionV1>(
				transactionPath(paths, session.session_id),
			);
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
					// Keep the session lock held while the new WAL atomically replaces the
					// old-incarnation record. Never unlink the canonical path first: a crash
					// in that gap would expose a missing session and permit a successor to
					// race the replacement.
					existing = null;
				} else if (existing.creation_intent_digest !== intentDigest) {
					throw new Error("idempotency_conflict");
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
				creation_intent_digest: intentDigest,
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
				outbox: initialCreationOutbox(intent, 1),
				projection: {
					applied_turns_revision: 0,
					applied_reports_revision: 0,
					applied_session_revision: 0,
					applied_active_revision: 0,
					applied_events_revision: 0,
					scheduler_pending_revision: 1,
					scheduler_applied_revision: 0,
					scheduler_digest: digest(JSON.stringify({ session_id: session.session_id, revision: 1 })),
				},
				recovery: { prompt_watermark_at: null, last_repaired_at: null },
			};
			assertTransaction(transaction, session.namespace_id, session.session_id);
			await writeAtomic(transactionPath(paths, session.session_id), transaction);
			request.phase = "wal_committed";
			request.wal_revision = transaction.revision;
			request.wal_digest = digest(JSON.stringify(transaction));
			request.updated_at = now;
			registry.roster ??= {};
			registry.scheduler_revision = Math.max(registry.scheduler_revision ?? 0, transaction.revision);
			registry.roster[session.session_id] = {
				session_id: session.session_id,
				revision: transaction.revision,
				digest: digest(JSON.stringify(transaction.canonical.queue)),
				active: transaction.canonical.queue.active_turn_id !== null,
				dirty: true,
				updated_at: now,
			};
			return transaction;
		});
	});
}
/** A validated pre-WAL projection imported in the same registry/transaction commit as its first canonical WAL. */
export interface LegacyProjectionImportV1 {
	turns: Record<string, CanonicalTurnSnapshotV1>;
	queue: CoordinatorSessionTransactionV1["canonical"]["queue"];
	desired_session_state: CoordinatorSessionState;
	reports: Record<string, CanonicalReportSnapshotV1>;
	gate_authorities: Record<string, GateAuthorityEntryV1>;
	questions: Record<string, PrivateQuestionV1>;
	/** A legacy projection has no durable answer request claim; start with an explicit empty ledger. */
	requests: CoordinatorSessionTransactionV1["requests"];
}

export async function createSessionTransaction(
	paths: CoordinatorStatePaths,
	intent: CanonicalCreateIntentV1,
	legacyProjection?: LegacyProjectionImportV1,
): Promise<CoordinatorSessionTransactionV1> {
	const session = intent.session;
	return await withNamespaceRegistry(paths, async registry => {
		return await withFileLock(transactionLockPath(paths, session.session_id), async () => {
			const key = digest(`${intent.kind}\0${session.session_id}\0${session.broker.endpoint_incarnation}`);
			const intentDigest = creationIntentDigest(intent);
			if (
				Object.values(registry.deletions).some(
					entry =>
						entry.session_id === session.session_id &&
						entry.endpoint_incarnation === session.broker.endpoint_incarnation,
				)
			)
				throw new Error("session_closing");
			const prior = registry.creations[key];
			const existing = await readTransactionJson<CoordinatorSessionTransactionV1>(
				transactionPath(paths, session.session_id),
			);
			if (existing) {
				assertTransaction(existing, session.namespace_id, session.session_id);
				if (existing.canonical.session.broker.endpoint_incarnation !== session.broker.endpoint_incarnation) {
					const priorDeleted = Object.values(registry.deletions).some(
						entry =>
							entry.session_id === session.session_id &&
							entry.endpoint_incarnation === existing.canonical.session.broker.endpoint_incarnation &&
							entry.phase === "completed",
					);
					if (!priorDeleted) throw new Error("session_closing");
				} else if (existing.creation_intent_digest !== intentDigest) {
					throw new Error("idempotency_conflict");
				} else if (
					prior?.phase === "completed" ||
					prior?.phase === "projected" ||
					prior?.phase === "wal_committed"
				) {
					return existing;
				}
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
				sidecar_verifier: session.broker.sidecar_verifier,
				created_at: now,
				updated_at: now,
			};
			const transaction: CoordinatorSessionTransactionV1 = {
				schema_version: 1,
				creation_intent_digest: intentDigest,
				namespace_id: session.namespace_id,
				session_id: session.session_id,
				revision: 1,
				endpoint: { incarnation: session.broker.endpoint_incarnation, observed_at: now },
				canonical: {
					session,
					turns: legacyProjection?.turns ?? {},
					queue: legacyProjection?.queue ?? {
						ordered_turn_ids: [],
						active_turn_id: null,
						selected_promotion: null,
					},
					desired_session_state: legacyProjection?.desired_session_state ?? intent.initial_state,
					reports: legacyProjection?.reports ?? {},
					gate_authorities: legacyProjection?.gate_authorities ?? {},
					questions: legacyProjection?.questions ?? {},
				},
				requests: legacyProjection?.requests ?? { prompts: {}, answers: {}, operations: {} },
				outbox: initialCreationOutbox(intent, 1),
				projection: {
					applied_turns_revision: 0,
					applied_reports_revision: 0,
					applied_session_revision: 0,
					applied_active_revision: 0,
					applied_events_revision: 0,
					scheduler_pending_revision: 1,
					scheduler_applied_revision: 0,
					scheduler_digest: digest(JSON.stringify({ session_id: session.session_id, revision: 1 })),
				},
				recovery: { prompt_watermark_at: null, last_repaired_at: null },
			};
			// Legacy projections become authority only after the same deep validation
			// required for an existing canonical WAL.
			assertTransaction(transaction, session.namespace_id, session.session_id);
			await writeAtomic(transactionPath(paths, session.session_id), transaction);
			registry.creations[key]!.phase = "wal_committed";
			registry.creations[key]!.wal_revision = transaction.revision;
			registry.creations[key]!.wal_digest = digest(JSON.stringify(transaction));
			registry.creations[key]!.updated_at = now;
			registry.roster ??= {};
			registry.scheduler_revision = Math.max(registry.scheduler_revision ?? 0, transaction.revision);
			registry.roster[session.session_id] = {
				session_id: session.session_id,
				revision: transaction.revision,
				digest: digest(JSON.stringify(transaction.canonical.queue)),
				active: transaction.canonical.queue.active_turn_id !== null,
				dirty: true,
				updated_at: now,
			};
			return transaction;
		});
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
	endpointIncarnation?: string,
): string {
	const full = `txn:${sessionId}:${revision}:${kind}:${entity}:${entityId}${endpointIncarnation ? `:inc:${endpointIncarnation}` : ""}`;
	return full.length <= 512 ? full : `txn:${createHash("sha256").update(full).digest("hex")}`;
}

function initialCreationOutbox(
	intent: CanonicalCreateIntentV1,
	transactionRevision: number,
): Record<string, OutboxEventV1> {
	const outbox: Record<string, OutboxEventV1> = {};
	for (const initial of intent.initial_events) {
		const kind = typeof initial.kind === "string" && initial.kind.length > 0 ? initial.kind : null;
		if (!kind) continue;
		const entityCandidate = initial.entity;
		const entity: OutboxEventV1["entity"] =
			entityCandidate === "turn" ||
			entityCandidate === "question" ||
			entityCandidate === "report" ||
			entityCandidate === "deletion"
				? entityCandidate
				: "session";
		const entityId =
			typeof initial.entity_id === "string" && initial.entity_id.length > 0
				? initial.entity_id
				: intent.session.session_id;
		const id = deterministicOutboxId(
			intent.session.session_id,
			transactionRevision,
			kind,
			entity,
			entityId,
			intent.session.broker.endpoint_incarnation,
		);
		const payload = Object.fromEntries(
			Object.entries(initial).filter(([key]) => key !== "kind" && key !== "entity" && key !== "entity_id"),
		) as OutboxEventV1["payload"];
		outbox[id] = {
			id,
			transaction_revision: transactionRevision,
			kind,
			entity,
			entity_id: entityId,
			payload: { session_id: intent.session.session_id, ...payload },
			emitted: false,
			public_event_id: id,
			public_delivery: {
				public_event_id: id,
				state: "pending",
				claim_fence: null,
				claim_expires_at: null,
				journal_seq: null,
				acknowledged_at: null,
			},
		};
	}
	return outbox;
}

export async function appendOutboxEvents(
	paths: CoordinatorStatePaths,
	transaction: CoordinatorSessionTransactionV1,
	options: { signal?: AbortSignal } = {},
): Promise<void> {
	/*
	 * `emitted` is a private projection marker, not public-delivery acknowledgement.
	 * Public rows are appended by the coordinator event journal exporter after a
	 * canonical claim. Keeping this phase journal-free prevents private payloads from
	 * becoming malformed public JSONL rows and leaves delivery recoverable after a
	 * projection/export crash.
	 */
	normalizeOutbox(transaction);
	void paths;
	void options;
	for (const event of Object.values(transaction.outbox)) event.emitted = true;
	transaction.projection.applied_events_revision = transaction.revision + 1;
}

export interface PublicDeliveryClaimV1 {
	event: OutboxEventV1;
	claim_fence: number;
	endpoint_incarnation?: string;
}

const DELIVERY_REVISION_WIDTH = 20;

function deliveryOrderKey(sessionId: string, event: OutboxEventV1): string {
	return `${sessionId}\0${String(event.transaction_revision).padStart(DELIVERY_REVISION_WIDTH, "0")}\0${event.public_event_id}`;
}

function claimExpired(delivery: PublicDeliveryV1, now: number): boolean {
	return (
		delivery.state === "claimed" &&
		typeof delivery.claim_expires_at === "string" &&
		Date.parse(delivery.claim_expires_at) <= now
	);
}

/** Claim one session's retained public intents; claims are fenced and lease based. */
export async function claimPublicDelivery(
	paths: CoordinatorStatePaths,
	sessionId: string,
	options: {
		signal?: AbortSignal;
		limit?: number;
		leaseMs?: number;
		after_order_key?: string;
	} = {},
): Promise<PublicDeliveryClaimV1[]> {
	const limit = Math.max(1, Math.min(options.limit ?? 16, 128));
	const leaseMs = Math.max(1_000, Math.min(options.leaseMs ?? PUBLIC_CLAIM_LEASE_MS, 5 * 60_000));
	const now = Date.now();
	const claims = await withSessionTransaction(
		paths,
		sessionId,
		async transaction => {
			normalizeOutbox(transaction);
			const claimed: PublicDeliveryClaimV1[] = [];
			for (const event of Object.values(transaction.outbox).sort(
				(a, b) =>
					a.transaction_revision - b.transaction_revision || a.public_event_id.localeCompare(b.public_event_id),
			)) {
				const delivery = event.public_delivery;
				if (delivery.state === "acknowledged") continue;
				if (options.after_order_key && deliveryOrderKey(sessionId, event) <= options.after_order_key) continue;
				if (delivery.state === "claimed" && !claimExpired(delivery, now)) continue;
				const fence = transaction.revision + claimed.length + 1;
				delivery.state = "claimed";
				delivery.claim_fence = fence;
				delivery.claim_expires_at = new Date(now + leaseMs).toISOString();
				claimed.push({ event: structuredClone(event), claim_fence: fence });
				if (claimed.length >= limit) break;
			}
			return claimed;
		},
		options,
	);
	// Pruning is post-claim housekeeping. It must not observe the caller's
	// abort signal after the claim WAL has committed, or the caller loses the
	// exact fenced batch needed to release it.
	await pruneRetainedSessionIfEmpty(paths, sessionId);
	return claims;
}

/** Recover expired claims in-place without changing their stable public id. */
export async function recoverExpiredPublicDelivery(
	paths: CoordinatorStatePaths,
	sessionId: string,
	options: { signal?: AbortSignal } = {},
): Promise<number> {
	const recovered = await withSessionTransaction(
		paths,
		sessionId,
		async transaction => {
			const now = Date.now();
			let recovered = 0;
			for (const event of Object.values(transaction.outbox)) {
				if (!claimExpired(event.public_delivery, now)) continue;
				event.public_delivery.state = "pending";
				event.public_delivery.claim_fence = null;
				event.public_delivery.claim_expires_at = null;
				recovered++;
			}
			return recovered;
		},
		options,
	);
	await pruneRetainedSessionIfEmpty(paths, sessionId, options);
	return recovered;
}

/** Exact acknowledgement prevents a late exporter from acknowledging a newer claim. */
export async function acknowledgePublicDelivery(
	paths: CoordinatorStatePaths,
	sessionId: string,
	input: { public_event_id: string; claim_fence: number; journal_seq: number },
	options: { signal?: AbortSignal } = {},
): Promise<OutboxEventV1> {
	const acknowledged = await withSessionTransaction(
		paths,
		sessionId,
		async transaction => {
			const event = Object.values(transaction.outbox).find(item => item.public_event_id === input.public_event_id);
			if (!event) throw new Error("resource_gone");
			if (event.public_delivery.state === "acknowledged") {
				if (event.public_delivery.journal_seq !== input.journal_seq) throw new Error("terminal_uncertain");
				return structuredClone(event);
			}
			if (event.public_delivery.state !== "claimed" || event.public_delivery.claim_fence !== input.claim_fence)
				throw new Error("terminal_uncertain");
			event.public_delivery.state = "acknowledged";
			event.public_delivery.journal_seq = input.journal_seq;
			event.public_delivery.claim_expires_at = null;
			event.public_delivery.acknowledged_at = new Date().toISOString();
			return structuredClone(event);
		},
		options,
	);
	await pruneRetainedSessionIfEmpty(paths, sessionId, options);
	return acknowledged;
}

/** Releases an exporter claim when delivery aborts before acknowledgement. */
export async function releasePublicDeliveryClaim(
	paths: CoordinatorStatePaths,
	sessionId: string,
	input: { public_event_id: string; claim_fence: number },
): Promise<void> {
	await withSessionTransaction(paths, sessionId, async transaction => {
		const event = Object.values(transaction.outbox).find(item => item.public_event_id === input.public_event_id);
		if (!event) return;
		const delivery = event.public_delivery;
		if (delivery.state !== "claimed" || delivery.claim_fence !== input.claim_fence) return;
		delivery.state = "pending";
		delivery.claim_fence = null;
		delivery.claim_expires_at = null;
	});
}

/** Enumerate retained intents independently of the active session roster. */
export async function enumeratePublicDeliveries(
	paths: CoordinatorStatePaths,
	cursor = "",
	limit = 64,
	options: { signal?: AbortSignal } = {},
): Promise<{
	claims: Array<PublicDeliveryClaimV1 & { session_id: string }>;
	next_cursor: string | null;
}> {
	const boundedLimit = Math.max(1, Math.min(limit, 128));
	const sessions = await withFileLock(
		paths.registryLock,
		async () => {
			const registry = await readJson<NamespaceRegistryV1>(paths.registry);
			if (registry?.schema_version !== 1 || registry.namespace_id !== path.basename(paths.root))
				throw new Error("state_corrupt");
			return [...new Set([...Object.keys(registry.roster ?? {}), ...Object.keys(registry.retained_sessions ?? {})])]
				.filter(name => COORDINATOR_SESSION_ID_PATTERN.test(name))
				.sort();
		},
		lockOptions(options.signal),
	);
	const roundRobin = cursor.startsWith("@session:");
	const roundRobinSession = roundRobin ? cursor.slice("@session:".length) : "";
	const cursorSeparator = cursor.indexOf("\0");
	const cursorSession = cursorSeparator >= 0 ? cursor.slice(0, cursorSeparator) : cursor;
	const cursorOrderKey = cursor || "";
	const orderedSessions = roundRobin
		? (() => {
				const start = sessions.indexOf(roundRobinSession);
				return start < 0 ? sessions : [...sessions.slice(start + 1), ...sessions.slice(0, start + 1)];
			})()
		: sessions;
	const boundedSessions = orderedSessions.slice(0, Math.max(1, boundedLimit * 2));
	const claims: Array<PublicDeliveryClaimV1 & { session_id: string }> = [];
	let lastVisitedSession: string | null = null;
	try {
		for (const sessionId of boundedSessions) {
			lastVisitedSession = sessionId;
			if (options.signal?.aborted) throw options.signal.reason ?? new Error("aborted");
			// A round-robin cursor selects the next session to visit; it is not a
			// delivery order key. Applying it as a lexical delivery filter starves
			// sessions whose IDs sort before the cursor (including UUID/numeric IDs).
			if (!roundRobin && cursorSession && sessionId < cursorSession) continue;
			const afterOrderKey = !roundRobin && sessionId === cursorSession ? cursorOrderKey : undefined;
			let batch: PublicDeliveryClaimV1[] = [];
			const remaining = boundedLimit - claims.length;
			if (remaining <= 0) break;
			try {
				batch = await claimPublicDelivery(paths, sessionId, {
					...options,
					limit: remaining,
					after_order_key: afterOrderKey,
				});
			} catch (error) {
				if (!(error instanceof Error) || error.message !== "resource_gone") throw error;
			}
			const endpointIncarnation = (await readSessionTransaction(paths, sessionId))?.canonical.session.broker
				.endpoint_incarnation;
			for (const claim of batch)
				claims.push({
					...claim,
					session_id: sessionId,
					...(endpointIncarnation ? { endpoint_incarnation: endpointIncarnation } : {}),
				});
			if (claims.length >= boundedLimit) break;
		}
	} catch (error) {
		for (const claim of claims)
			await releasePublicDeliveryClaim(paths, claim.session_id, {
				public_event_id: claim.event.public_event_id,
				claim_fence: claim.claim_fence,
			});
		throw error;
	}
	const filtered = (
		roundRobin ? claims : claims.filter(claim => deliveryOrderKey(claim.session_id, claim.event) > cursor)
	).slice(0, boundedLimit);
	const last = filtered.at(-1);
	return {
		claims: filtered,
		next_cursor: roundRobin
			? lastVisitedSession
				? `@session:${lastVisitedSession}`
				: cursor
			: last
				? deliveryOrderKey(last.session_id, last.event)
				: null,
	};
}

export function compactTransaction(transaction: CoordinatorSessionTransactionV1, now = Date.now()): void {
	normalizeOutbox(transaction);
	const old = (time: string): boolean => Date.parse(time) + RETENTION_MS < now;
	// Prompt acceptance/canonical finalization precedes the outer delegate receipt.
	// Neither retention nor pressure compaction may erase that recovery authority.
	const pinnedPrompts = Object.values(transaction.requests.prompts).filter(
		request => request.delegate_response_pending === true,
	);
	const pinnedRequests = new Set<object>(pinnedPrompts);
	const pinnedTurns = new Set(pinnedPrompts.map(request => request.coordinator_turn_id));
	for (const [id, event] of Object.entries(transaction.outbox))
		if (
			event.emitted &&
			event.public_delivery.state === "acknowledged" &&
			event.transaction_revision < transaction.revision &&
			old(String(event.payload.created_at ?? ""))
		)
			delete transaction.outbox[id];
	for (const group of [transaction.requests.prompts, transaction.requests.answers, transaction.requests.operations])
		for (const [id, request] of Object.entries(group))
			if (
				request.phase === "completed" &&
				!pinnedRequests.has(request) &&
				old(request.updated_at) &&
				JSON.stringify(transaction.canonical).includes(id) === false
			)
				delete group[id];
	if (Buffer.byteLength(JSON.stringify(transaction)) > MAX_NORMAL_BYTES) {
		const terminalTurnIds = Object.values(transaction.canonical.turns)
			.filter(turn => ["completed", "failed", "cancelled", "superseded"].includes(turn.status))
			.sort(
				(left, right) =>
					left.updated_at.localeCompare(right.updated_at) || left.turn_id.localeCompare(right.turn_id),
			)
			.map(turn => turn.turn_id);
		for (const turnId of terminalTurnIds) {
			const turn = transaction.canonical.turns[turnId];
			if (!turn) continue;
			if (pinnedTurns.has(turnId)) continue;
			// Both promotion endpoints stay addressable for later projection repair;
			// deleting either would corrupt the WAL instead of completing at capacity.
			if (
				transaction.canonical.queue.selected_promotion?.from_turn_id === turnId ||
				transaction.canonical.queue.selected_promotion?.to_turn_id === turnId
			)
				continue;
			// An unsealed operation still needs its source turn, report state, and
			// intent to persist the safe response after this commit.
			if (
				Object.values(transaction.requests.operations).some(
					request =>
						request.intent.turn_id === turnId &&
						(request.phase !== "completed" || (request.safe_response !== undefined && !old(request.updated_at))),
				)
			)
				continue;
			delete transaction.canonical.turns[turnId];
			for (const questionId of turn.question_ids) delete transaction.canonical.questions[questionId];
			for (const [authorityId, authority] of Object.entries(transaction.canonical.gate_authorities))
				if ("turn_id" in authority.outcome && authority.outcome.turn_id === turnId)
					delete transaction.canonical.gate_authorities[authorityId];
			for (const [id, request] of Object.entries(transaction.requests.prompts))
				if (request.coordinator_turn_id === turnId) delete transaction.requests.prompts[id];
			for (const [id, request] of Object.entries(transaction.requests.answers))
				if (request.turn_id === turnId) delete transaction.requests.answers[id];
			for (const [id, request] of Object.entries(transaction.requests.operations))
				if (request.intent.turn_id === turnId) delete transaction.requests.operations[id];
			for (const [id, report] of Object.entries(transaction.canonical.reports))
				if (report.turn_id === turnId) delete transaction.canonical.reports[id];
			if (Buffer.byteLength(JSON.stringify(transaction)) <= MAX_NORMAL_BYTES) break;
		}
	}
	if (Buffer.byteLength(JSON.stringify(transaction)) > MAX_NORMAL_BYTES + EMERGENCY_BYTES)
		throw new Error("query_unavailable");
}

/** Records projection repair after projecting complete canonical snapshots. */
export async function repairProjections(
	paths: CoordinatorStatePaths,
	sessionId: string,
	project: (canonical: CoordinatorSessionTransactionV1["canonical"]) => Promise<void>,
	options: { signal?: AbortSignal } = {},
): Promise<void> {
	let repairedRevision = 0;
	let repairedDigest = "";
	let repairedActive = false;
	await withSessionTransaction(
		paths,
		sessionId,
		async transaction => {
			await project(transaction.canonical);
			await appendOutboxEvents(paths, transaction);
			transaction.projection.applied_turns_revision = transaction.revision + 1;
			transaction.projection.applied_reports_revision = transaction.revision + 1;
			transaction.projection.applied_session_revision = transaction.revision + 1;
			transaction.projection.applied_active_revision = transaction.revision + 1;
			transaction.projection.scheduler_applied_revision = transaction.revision + 1;
			transaction.recovery.last_repaired_at = new Date().toISOString();
			repairedRevision = transaction.revision + 1;
			repairedDigest =
				transaction.projection.scheduler_digest ?? digest(JSON.stringify(transaction.canonical.queue));
			repairedActive = transaction.canonical.queue.active_turn_id !== null;
		},
		options,
	);
	await withNamespaceRegistry(paths, async registry => {
		registry.roster ??= {};
		registry.scheduler_revision = Math.max(registry.scheduler_revision ?? 0, repairedRevision);
		registry.roster[sessionId] = {
			session_id: sessionId,
			revision: repairedRevision,
			digest: repairedDigest,
			active: repairedActive,
			dirty: false,
			updated_at: new Date().toISOString(),
		};
	});
}

function sameCreationRetirementProof(left: CreationRetirementProofV1, right: CreationRetirementProofV1): boolean {
	return canonicalJson(left) === canonicalJson(right);
}

function assertCreationRetirementProofMatches(
	request: CreationRequestV1,
	proof: CreationRetirementProofV1,
	includeStaged = true,
): void {
	if (
		!proof.session_id ||
		!proof.cwd ||
		!proof.state_root ||
		!Number.isSafeInteger(proof.endpoint_generation) ||
		proof.endpoint_generation <= 0 ||
		!Number.isFinite(proof.endpoint_mtime_ms) ||
		proof.endpoint_mtime_ms <= 0 ||
		!proof.process_incarnation ||
		!proof.host_incarnation ||
		!proof.lifecycle_request_id ||
		!proof.remote_create_key
	)
		throw new Error("invalid_input");
	if (request.remote_create_key !== proof.remote_create_key) throw new Error("idempotency_conflict");
	if (request.session_id !== null && request.session_id !== proof.session_id) throw new Error("idempotency_conflict");
	const intent = request.canonical_create_intent;
	if (intent) {
		const session = intent.session;
		if (
			session.session_id !== proof.session_id ||
			path.resolve(session.cwd) !== path.resolve(proof.cwd) ||
			path.resolve(session.cwd, ".gjc", "state") !== path.resolve(proof.state_root) ||
			session.broker.endpoint_generation !== proof.endpoint_generation ||
			intent.kind === "register" ||
			intent.remote_create_key !== proof.remote_create_key
		)
			throw new Error("idempotency_conflict");
	}
	const staged = includeStaged ? request.retirement_intent : undefined;
	if (staged && !sameCreationRetirementProof(staged.proof, proof)) throw new Error("idempotency_conflict");
}

/** Claims retirement under the creation receipt before any broker effect. */
export async function recordCreationRetirementIntent(
	paths: CoordinatorStatePaths,
	keyDigest: string,
	proof: CreationRetirementProofV1,
	retirementKeyDigest?: string,
): Promise<CreationRequestV1> {
	return await withNamespaceRegistry(paths, async registry => {
		const request = registry.creations[keyDigest];
		if (!request) throw new Error("state_corrupt");
		if (request.phase !== "remote_started" && request.phase !== "uncertain" && request.phase !== "retired")
			throw new Error("retire_not_allowed");
		assertCreationRetirementProofMatches(request, proof, request.retirement_intent?.phase !== "pre_effect_rejected");
		if (
			request.retirement_intent?.phase !== "pre_effect_rejected" &&
			retirementKeyDigest &&
			request.retirement_intent?.retirement_key_digest &&
			request.retirement_intent.retirement_key_digest !== retirementKeyDigest
		)
			throw new Error("idempotency_conflict");
		if (!request.retirement_intent) {
			request.retirement_intent = {
				phase: "intent",
				proof,
				...(retirementKeyDigest ? { retirement_key_digest: retirementKeyDigest } : {}),
				updated_at: new Date().toISOString(),
			};
			request.updated_at = new Date().toISOString();
		} else if (request.retirement_intent.phase === "pre_effect_rejected") {
			request.retirement_intent.phase = "intent";
			request.retirement_intent.proof = proof;
			if (retirementKeyDigest) request.retirement_intent.retirement_key_digest = retirementKeyDigest;
			request.retirement_intent.updated_at = new Date().toISOString();
			request.updated_at = request.retirement_intent.updated_at;
		} else if (retirementKeyDigest && !request.retirement_intent.retirement_key_digest) {
			request.retirement_intent.retirement_key_digest = retirementKeyDigest;
			request.retirement_intent.updated_at = new Date().toISOString();
			request.updated_at = new Date().toISOString();
		}
		return request;
	});
}

/** Replaces only a pre-effect retirement proof after an explicit broker rejection. */
export async function replaceCreationRetirementIntent(
	paths: CoordinatorStatePaths,
	keyDigest: string,
	proof: CreationRetirementProofV1,
	retirementKeyDigest: string,
): Promise<CreationRequestV1> {
	return await withNamespaceRegistry(paths, async registry => {
		const request = registry.creations[keyDigest];
		if (!request) throw new Error("state_corrupt");
		if (request.phase !== "remote_started" && request.phase !== "uncertain" && request.phase !== "retired")
			throw new Error("retire_not_allowed");
		const staged = request.retirement_intent;
		if (staged?.phase !== "intent" || staged.broker_proof) throw new Error("state_corrupt");
		if (staged.retirement_key_digest !== retirementKeyDigest) throw new Error("idempotency_conflict");
		assertCreationRetirementProofMatches(request, proof, false);
		staged.phase = "pre_effect_rejected";
		staged.updated_at = new Date().toISOString();
		request.updated_at = staged.updated_at;
		return request;
	});
}

/** Records the bounded broker proof before receipt advancement or idempotency sealing. */
export async function recordCreationRetirementBrokerProof(
	paths: CoordinatorStatePaths,
	keyDigest: string,
	proof: CreationRetirementProofV1,
	brokerProof: CreationRetirementBrokerProofV1,
): Promise<CreationRequestV1> {
	return await withNamespaceRegistry(paths, async registry => {
		const request = registry.creations[keyDigest];
		if (!request) throw new Error("state_corrupt");
		if (request.phase !== "remote_started" && request.phase !== "uncertain" && request.phase !== "retired")
			throw new Error("retire_not_allowed");
		assertCreationRetirementProofMatches(request, proof);
		if (
			brokerProof.session_id !== proof.session_id ||
			brokerProof.state_root !== proof.state_root ||
			brokerProof.endpoint_generation !== proof.endpoint_generation ||
			brokerProof.endpoint_mtime_ms !== proof.endpoint_mtime_ms ||
			brokerProof.process_incarnation !== proof.process_incarnation ||
			brokerProof.host_incarnation !== proof.host_incarnation ||
			brokerProof.lifecycle_request_id !== proof.lifecycle_request_id ||
			brokerProof.remote_create_key !== proof.remote_create_key ||
			brokerProof.retired !== true ||
			brokerProof.ledger_state !== "terminal_error" ||
			brokerProof.index_type !== "session_closed"
		)
			throw new Error("protocol_error");
		const staged = request.retirement_intent;
		if (staged?.broker_proof) {
			if (canonicalJson(staged.broker_proof) !== canonicalJson(brokerProof)) throw new Error("state_corrupt");
			return request;
		}
		if (!staged) {
			request.retirement_intent = {
				phase: "broker_retired",
				proof,
				broker_proof: brokerProof,
				updated_at: new Date().toISOString(),
			};
		} else {
			staged.phase = "broker_retired";
			staged.broker_proof = brokerProof;
			staged.updated_at = new Date().toISOString();
		}
		request.updated_at = new Date().toISOString();
		return request;
	});
}

/** Advances a creation receipt only after its WAL or projection authority exists. */
export async function assertCreationRetirementIdentity(
	paths: CoordinatorStatePaths,
	keyDigest: string,
	proof: CreationRetirementProofV1,
): Promise<CreationRequestV1> {
	return await withNamespaceRegistry(paths, async registry => {
		const request = registry.creations[keyDigest];
		if (!request) throw new Error("state_corrupt");
		if (request.phase !== "remote_started" && request.phase !== "uncertain" && request.phase !== "retired")
			throw new Error("retire_not_allowed");
		assertCreationRetirementProofMatches(request, proof, request.retirement_intent?.phase !== "pre_effect_rejected");
		return request;
	});
}

export async function advanceCreationReceipt(
	paths: CoordinatorStatePaths,
	keyDigest: string,
	phase: "projected" | "completed" | "uncertain" | "retired",
	safeResponse?: Record<string, unknown>,
	proof?: CreationRetirementProofV1,
): Promise<void> {
	await withNamespaceRegistry(paths, async registry => {
		const request = registry.creations[keyDigest];
		if (!request) throw new Error("state_corrupt");
		if (proof) assertCreationRetirementProofMatches(request, proof);
		if (request.phase === phase) {
			if (phase === "retired" && safeResponse) {
				request.safe_response = safeResponse;
				if (request.retirement_intent) request.retirement_intent.updated_at = new Date().toISOString();
				request.updated_at = new Date().toISOString();
			}
			return;
		}
		if (
			phase === "retired" &&
			(request.phase === "completed" || request.phase === "retired" || request.phase === "claimed")
		)
			throw new Error("state_corrupt");
		if (
			phase !== "uncertain" &&
			phase !== "retired" &&
			request.phase !== "wal_committed" &&
			request.phase !== "projected"
		)
			throw new Error("state_corrupt");
		request.phase = phase;
		request.safe_response = safeResponse;
		if (phase === "retired" && proof && !request.retirement_intent) {
			request.retirement_intent = {
				phase: "intent",
				proof,
				updated_at: new Date().toISOString(),
			};
		}
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

/** Remove one incarnation's canonical WAL only after broker close is proven. */
export async function removeSessionTransaction(
	paths: CoordinatorStatePaths,
	sessionId: string,
	endpointIncarnation: string,
): Promise<boolean> {
	return await withNamespaceRegistry(
		paths,
		async registry =>
			await withFileLock(transactionLockPath(paths, sessionId), async () => {
				const file = transactionPath(paths, sessionId);
				const transaction = await readTransactionJson<CoordinatorSessionTransactionV1>(file);
				// A deletion retry may observe the unlink before its registry checkpoint;
				// clear scheduler hints here as part of the same retry so a completed
				// deletion cannot leave a missing WAL discoverable forever. False lets
				// the caller distinguish an already-removed WAL from a still-present
				// incarnation without recreating it.
				if (!transaction) {
					delete registry.roster?.[sessionId];
					delete registry.retained_sessions?.[sessionId];
					return false;
				}
				assertTransaction(transaction, path.basename(paths.root), sessionId);
				normalizeOutbox(transaction);
				if (transaction.endpoint?.incarnation !== endpointIncarnation) throw new Error("endpoint_stale");
				// The canonical WAL remains the delivery authority until every retained
				// intent is acknowledged. Reapers must retry cleanup after any competing
				// exporter lease expires instead of deleting an undelivered event.
				if (Object.values(transaction.outbox).some(event => event.public_delivery.state !== "acknowledged"))
					return false;
				await removeCoordinatorStateFile(file);
				delete registry.roster?.[sessionId];
				delete registry.retained_sessions?.[sessionId];
				return true;
			}),
	);
}
