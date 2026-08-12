import { createHash, randomUUID } from "node:crypto";
import type { Dirent, Stats } from "node:fs";
import type { FileHandle } from "node:fs/promises";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { withFileLock } from "../config/file-lock";
import {
	assertCanonicalMasterName,
	assertPathWithinMasterRoot,
	ensurePrivateFileMode,
	ensurePrivateMasterLayout,
	getMasterPaths,
	isCanonicalMasterName,
	type MasterPathOptions,
	type MasterPaths,
} from "./paths";
import {
	assertCapacityInvariant,
	assertExactActiveWorkerCount,
	assertPositiveSafeInteger,
	canAdmitWorker,
	computeCapacityState,
	countActiveWorkerLeases,
	nextUserDispatchStreak,
	selectNextTask,
	selectRequestedTask,
	validateQueueState,
	validateTaskRecord,
} from "./queue";
import {
	masterEventFrameSchema,
	providerPresentationOutcomeValidator,
	providerProvisionOutcomeValidator,
} from "./sdk-contract";
import {
	type BindingIntentReceipt,
	type ChannelSnapshot,
	type ClaimApprovalInput,
	type ClaimApprovalResult,
	type ClaimAuthorizationMintInput,
	type ClaimRequestAuthorization,
	type ConfigureCapacityResult,
	type CreateBindingIntentInput,
	DEFAULT_MAX_CONCURRENT_WORKERS,
	type DecisionRecordInput,
	type EnqueueReceipt,
	type EnqueueTaskInput,
	type EscalationInput,
	type EventDraft,
	type LeaseReceipt,
	MASTER_PROTOCOL_VERSION,
	MASTER_SCHEMA_VERSION,
	type MasterChannelsDocument,
	type MasterClaimsDocument,
	type MasterCommitManifest,
	type MasterDomainStoreOptions,
	type MasterEventFrame,
	MasterIdempotencyConflictError,
	type MasterIngress,
	type MasterListItem,
	type MasterOutboxDocument,
	type MasterOwnershipDocument,
	type MasterProvider,
	type MasterQueueDocument,
	type MasterRecord,
	type MasterSnapshot,
	MasterStoreCorruptionError,
	MasterStoreError,
	MasterStoreNotFoundError,
	type MasterStoreState,
	type MasterWorkersDocument,
	type MemoryActivity,
	type ModelClaimRequestInput,
	type ObserveWorkerInput,
	type OwnershipClaim,
	type PersistedMasterEvent,
	type PresentationContent,
	type PresentationOutboxRow,
	type PromptPendingInput,
	type PromptPendingReceipt,
	type PromptReconcileInput,
	type PromptReconcileReceipt,
	type ProviderEffectLease,
	type ProviderEffectLeaseInput,
	type ProviderEffectLeaseRecord,
	type ProviderEffectOutcome,
	type ProviderEffectResultInput,
	type ProviderEffectResultReceipt,
	type ProviderHealth,
	type ProviderPresentationOutcome,
	type ProviderProvisionOutcome,
	type ProviderWorkerLease,
	type ProviderWorkerRegistrationInput,
	type ProviderWorkerRegistrationReceipt,
	type QueueStateSummary,
	type ReconcileBindingInput,
	type ReconcileBindingReceipt,
	type ReleaseReceipt,
	type ReleaseWorkerInput,
	type TaskRecord,
	type TaskSummary,
	type UserWorkerReceipt,
	type WorkerCreateIntent,
	type WorkerCreateReceipt,
	type WorkerCreateReconcileInput,
	type WorkerLease,
	type WorkerLifecycleReceipt,
	type WorkerObservation,
	type WorkerObservationReceipt,
} from "./types";

interface TransactionResult<T> {
	value: T;
	event?: EventDraft;
	events?: EventDraft[];
	persist?: boolean;
	returnLastEvent?: boolean;
}

interface JsonObject {
	[key: string]: unknown;
}

function isNodeError(error: unknown, code: string): boolean {
	return error instanceof Error && "code" in error && error.code === code;
}

function isRecord(value: unknown): value is JsonObject {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function clone<T>(value: T): T {
	return structuredClone(value);
}

function sha256(value: string): string {
	return createHash("sha256").update(value, "utf8").digest("hex");
}

const DEFAULT_AUTHORITY_FINGERPRINT = sha256("unbound-coordinator-authority");
const FINGERPRINT_PATTERN = /^[0-9a-f]{64}$/;

const MASTER_PROVIDERS: readonly MasterProvider[] = ["telegram", "discord"];
const DEFAULT_PROVIDER_LEASE_MS = 30_000;
const MAX_PROVIDER_LEASE_MS = 86_400_000;
const MAX_CLAIM_TTL_MS = 86_400_000;

function assertProvider(value: unknown, field = "provider"): asserts value is MasterProvider {
	if (value !== "telegram" && value !== "discord")
		throw new MasterStoreError("INVALID_PROVIDER", `${field} must be telegram or discord.`);
}

function normalizeProviders(value: readonly MasterProvider[] | undefined): MasterProvider[] {
	const providers = value === undefined ? [] : [...value];
	if (providers.length > MASTER_PROVIDERS.length || new Set(providers).size !== providers.length)
		throw new MasterStoreError(
			"INVALID_PROVIDER",
			"configuredProviders must contain unique Telegram/Discord providers.",
		);
	for (const provider of providers) assertProvider(provider);
	return providers.sort((left, right) => MASTER_PROVIDERS.indexOf(left) - MASTER_PROVIDERS.indexOf(right));
}

function providerEffectDigest(outcome: ProviderEffectOutcome): string {
	return sha256(canonicalJson(outcome));
}

function providerEffectNonce(effectId: string, fence: number): string {
	return `nonce:${sha256(`${effectId}:fence:${fence}`).slice(0, 48)}`;
}

function providerBindingId(provider: MasterProvider, intentId: string): string {
	return `binding:${provider}:${sha256(intentId).slice(0, 32)}`;
}

function providerIntentId(masterName: string, provider: MasterProvider): string {
	return `${masterName}:binding-intent:${provider}`;
}

function providerChannelName(masterName: string, provider: MasterProvider): string {
	return provider === "telegram" ? `Master · ${masterName}` : `master-${masterName}`;
}

function isPresentationRequiredEvent(event: PersistedMasterEvent): boolean {
	return event.type !== "channel_updated";
}

function presentationContent(event: PersistedMasterEvent): PresentationContent {
	const payload = event.payload as Record<string, unknown>;
	const task = isRecord(payload.task) ? payload.task : undefined;
	const activity = isRecord(payload.activity) ? payload.activity : undefined;
	return {
		text: `${event.type}: ${JSON.stringify(event.payload)}`,
		workerSessionId:
			typeof payload.workerSessionId === "string"
				? payload.workerSessionId
				: typeof task?.workerSessionId === "string"
					? task.workerSessionId
					: null,
		taskId:
			typeof payload.taskId === "string" ? payload.taskId : typeof task?.taskId === "string" ? task.taskId : null,
		decisionId: typeof payload.decisionId === "string" ? payload.decisionId : null,
		memoryActivityId:
			typeof payload.memoryActivityId === "string"
				? payload.memoryActivityId
				: typeof activity?.activityId === "string"
					? activity.activityId
					: null,
	};
}

function canonicalJson(value: unknown): string {
	const encoded = JSON.stringify(value);
	if (encoded === undefined) throw new MasterStoreError("INVALID_JSON", "Value cannot be serialized as JSON.");
	return encoded;
}

function nowIso(now: () => Date): string {
	const value = now().toISOString();
	if (!value.endsWith("Z")) throw new MasterStoreError("INVALID_CLOCK", "Clock must return a UTC timestamp.");
	return value;
}

function assertNonEmptyText(value: unknown, field: string, maxBytes = 4096): asserts value is string {
	if (typeof value !== "string" || value.length === 0 || new TextEncoder().encode(value).byteLength > maxBytes)
		throw new MasterStoreError("INVALID_INPUT", `${field} must be non-empty and at most ${maxBytes} bytes.`);
}

function assertOpaqueId(value: unknown, field: string): asserts value is string {
	assertNonEmptyText(value, field, 128);
	if (!/^[\x20-\x7e]+$/.test(value))
		throw new MasterStoreError("INVALID_INPUT", `${field} must contain printable ASCII.`);
}
function isValidIngress(value: unknown): value is MasterIngress {
	if (!isRecord(value) || (value.kind !== "provider" && value.kind !== "local")) return false;
	if (value.kind === "provider") {
		return (
			(value.provider === "telegram" || value.provider === "discord") &&
			typeof value.channelId === "string" &&
			typeof value.messageId === "string" &&
			typeof value.actorId === "string"
		);
	}
	return typeof value.actorId === "string" && typeof value.sourceId === "string";
}

function assertIngress(value: unknown, field = "ingress"): asserts value is MasterIngress {
	if (!isValidIngress(value)) throw new MasterStoreError("INVALID_INGRESS", `${field} is invalid.`);
	if (value.kind === "provider") {
		if (Object.keys(value).length !== 5)
			throw new MasterStoreError("INVALID_INGRESS", `${field} contains extra fields.`);
		assertOpaqueId(value.channelId, `${field}.channelId`);
		assertOpaqueId(value.messageId, `${field}.messageId`);
		assertOpaqueId(value.actorId, `${field}.actorId`);
	} else {
		if (Object.keys(value).length !== 3)
			throw new MasterStoreError("INVALID_INGRESS", `${field} contains extra fields.`);
		assertOpaqueId(value.actorId, `${field}.actorId`);
		assertOpaqueId(value.sourceId, `${field}.sourceId`);
	}
}

function sameOwner(
	left: { kind: "master"; masterName: string } | { kind: "user" },
	right: { kind: "master"; masterName: string } | { kind: "user" },
): boolean {
	if (left.kind !== right.kind) return false;
	if (left.kind === "user" || right.kind === "user") return true;
	return left.masterName === right.masterName;
}

function assertTimestamp(value: unknown, field: string): asserts value is string {
	if (typeof value !== "string" || !value.endsWith("Z") || Number.isNaN(Date.parse(value)))
		throw new MasterStoreCorruptionError(`${field} is not a UTC timestamp.`);
}

function isAbsoluteNormalizedPath(value: string): boolean {
	return path.isAbsolute(value) && path.resolve(value) === value;
}

function isPathWithin(root: string, candidate: string): boolean {
	const relative = path.relative(path.resolve(root), path.resolve(candidate));
	return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

function errorAsMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

async function lstatIfPresent(filePath: string): Promise<Stats | null> {
	try {
		return await fs.lstat(filePath);
	} catch (error) {
		if (isNodeError(error, "ENOENT")) return null;
		throw error;
	}
}

async function fsyncDirectory(directory: string): Promise<void> {
	if (process.platform === "win32") return;
	let handle: FileHandle | null = null;
	try {
		handle = await fs.open(directory, "r");
		await handle.sync();
	} catch (error) {
		const code = error instanceof Error && "code" in error ? error.code : undefined;
		if (code !== "EINVAL" && code !== "ENOTSUP" && code !== "EOPNOTSUPP") throw error;
	} finally {
		if (handle !== null) await handle.close();
	}
}

async function atomicWriteText(filePath: string, text: string, root: string): Promise<void> {
	assertPathWithinMasterRoot(root, filePath);
	const parent = path.dirname(filePath);
	await fs.mkdir(parent, { recursive: true, mode: 0o700 });
	const parentStat = await fs.lstat(parent);
	if (!parentStat.isDirectory() || parentStat.isSymbolicLink())
		throw new MasterStoreError("MASTER_PATH_INVALID", `Invalid parent directory ${parent}.`);
	const existing = await lstatIfPresent(filePath);
	if (existing?.isSymbolicLink())
		throw new MasterStoreError("MASTER_PATH_INVALID", `Refusing to replace symlink ${filePath}.`);
	const temporary = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
	let handle: FileHandle | null = null;
	try {
		handle = await fs.open(temporary, "wx", 0o600);
		await handle.writeFile(text, "utf8");
		await handle.sync();
		await handle.chmod(0o600);
		await handle.close();
		handle = null;
		await fs.rename(temporary, filePath);
		await ensurePrivateFileMode(filePath);
		await fsyncDirectory(parent);
	} catch (error) {
		if (handle !== null) await handle.close().catch(() => undefined);
		await fs.unlink(temporary).catch(() => undefined);
		throw error;
	}
}

async function atomicWriteJson(filePath: string, value: unknown, root: string): Promise<void> {
	await atomicWriteText(filePath, `${JSON.stringify(value, null, 2)}\n`, root);
}

async function appendDurableLine(filePath: string, line: string, root: string): Promise<void> {
	assertPathWithinMasterRoot(root, filePath);
	const parent = path.dirname(filePath);
	await fs.mkdir(parent, { recursive: true, mode: 0o700 });
	const stat = await lstatIfPresent(filePath);
	if (stat?.isSymbolicLink() || (stat !== null && !stat.isFile()))
		throw new MasterStoreError("MASTER_PATH_INVALID", `Invalid event log ${filePath}.`);
	const handle = await fs.open(filePath, "a", 0o600);
	try {
		await handle.write(line, undefined, "utf8");
		await handle.sync();
		await handle.chmod(0o600);
	} finally {
		await handle.close();
	}
	await fsyncDirectory(parent);
}

async function readJson(filePath: string): Promise<unknown> {
	let text: string;
	try {
		text = await fs.readFile(filePath, "utf8");
	} catch (error) {
		if (isNodeError(error, "ENOENT")) throw new MasterStoreNotFoundError(path.basename(path.dirname(filePath)));
		throw error;
	}
	try {
		return JSON.parse(text) as unknown;
	} catch (error) {
		throw new MasterStoreCorruptionError(`Malformed JSON at ${filePath}: ${errorAsMessage(error)}`);
	}
}

async function readOptionalJson(filePath: string): Promise<unknown | null> {
	try {
		return JSON.parse(await fs.readFile(filePath, "utf8")) as unknown;
	} catch (error) {
		if (isNodeError(error, "ENOENT")) return null;
		if (error instanceof SyntaxError) throw new MasterStoreCorruptionError(`Malformed JSON at ${filePath}.`);
		throw error;
	}
}

function validateCommitManifest(value: unknown, masterName: string): asserts value is MasterCommitManifest {
	assertVersioned(value, "master_commit_manifest");
	const manifest = value as Partial<MasterCommitManifest>;
	if (
		manifest.masterName !== masterName ||
		typeof manifest.generation !== "number" ||
		!Number.isSafeInteger(manifest.generation) ||
		manifest.generation < 1
	)
		throw new MasterStoreCorruptionError("Commit manifest identity or generation is invalid.");
	if (manifest.status !== "pending" && manifest.status !== "committed")
		throw new MasterStoreCorruptionError("Commit manifest status is invalid.");
	if (!isRecord(manifest.state)) throw new MasterStoreCorruptionError("Commit manifest state is missing.");
	if (manifest.event !== null && manifest.event !== undefined) {
		if (!isRecord(manifest.event)) throw new MasterStoreCorruptionError("Commit manifest event is malformed.");
		validateEvent(manifest.event, masterName, null);
	}
}

async function readGlobalJournal(journalPath: string, checkpointPath: string): Promise<PersistedMasterEvent[]> {
	let text: string;
	try {
		text = await fs.readFile(journalPath, "utf8");
	} catch (error) {
		if (isNodeError(error, "ENOENT")) return [];
		throw error;
	}
	if (text.length > 0 && !text.endsWith("\n"))
		throw new MasterStoreCorruptionError("Global event journal is not newline terminated.");
	const events: PersistedMasterEvent[] = [];
	for (const line of text.length === 0 ? [] : text.split("\n").slice(0, -1)) {
		if (line.length === 0) throw new MasterStoreCorruptionError("Global event journal contains an empty record.");
		let parsed: unknown;
		try {
			parsed = JSON.parse(line) as unknown;
		} catch (error) {
			throw new MasterStoreCorruptionError(`Malformed global event JSON: ${errorAsMessage(error)}`);
		}
		validateEvent(parsed, null, events.length + 1);
		events.push(parsed);
	}
	const checkpointValue = await readOptionalJson(checkpointPath);
	if (checkpointValue !== null) {
		assertVersioned(checkpointValue, "master_event_checkpoint");
		const checkpoint = checkpointValue as Partial<{ lastSeq: number }>;
		if (!Number.isSafeInteger(checkpoint.lastSeq) || (checkpoint.lastSeq ?? -1) > events.length)
			throw new MasterStoreCorruptionError("Global event checkpoint is invalid.");
	}
	return events;
}

function assertVersioned(value: unknown, kind: string): asserts value is JsonObject {
	if (
		!isRecord(value) ||
		value.version !== MASTER_SCHEMA_VERSION ||
		value.schema_version !== MASTER_SCHEMA_VERSION ||
		value.kind !== kind
	)
		throw new MasterStoreCorruptionError(`Unsupported or malformed ${kind} record.`);
}

function validateMasterRecord(value: unknown, masterName: string): asserts value is MasterRecord {
	assertVersioned(value, "master_record");
	const record = value as Partial<MasterRecord>;
	if (
		record.masterName !== masterName ||
		typeof record.defaultWorkdir !== "string" ||
		!isAbsoluteNormalizedPath(record.defaultWorkdir)
	)
		throw new MasterStoreCorruptionError("Master record identity or workdir is invalid.");
	assertPositiveSafeInteger(record.maxConcurrentWorkers, "maxConcurrentWorkers");
	assertCapacityInvariant(record.activeWorkerCount, record.maxConcurrentWorkers, record.capacityState);
	if (
		typeof record.queueRevision !== "number" ||
		!Number.isSafeInteger(record.queueRevision) ||
		record.queueRevision < 0
	)
		throw new MasterStoreCorruptionError("Master record queueRevision is invalid.");
	if (
		typeof record.userDispatchStreak !== "number" ||
		!Number.isSafeInteger(record.userDispatchStreak) ||
		record.userDispatchStreak < 0
	)
		throw new MasterStoreCorruptionError("Master record userDispatchStreak is invalid.");
	if (typeof record.authorityFingerprint !== "string" || !FINGERPRINT_PATTERN.test(record.authorityFingerprint))
		throw new MasterStoreCorruptionError("Master record authority fingerprint is invalid.");
	assertTimestamp(record.createdAt, "createdAt");
	assertTimestamp(record.updatedAt, "updatedAt");
}

function validateWorkerDocument(value: unknown, masterName: string): asserts value is MasterWorkersDocument {
	assertVersioned(value, "master_workers");
	const document = value as Partial<MasterWorkersDocument>;
	if (document.masterName !== masterName || !Array.isArray(document.intents) || !Array.isArray(document.workers))
		throw new MasterStoreCorruptionError("Worker document identity or collections are invalid.");
	const intentIds = new Set<string>();
	const intentTasks = new Set<string>();
	const createKeys = new Set<string>();
	for (const value of document.intents) {
		if (!isRecord(value)) throw new MasterStoreCorruptionError("Worker create intent is malformed.");
		const intent = value as Partial<WorkerCreateIntent>;
		assertOpaqueId(intent.intentId, "intentId");
		assertOpaqueId(intent.masterName, "intent.masterName");
		assertOpaqueId(intent.taskId, "taskId");
		if (intent.masterName !== masterName || !isAbsoluteNormalizedPath(intent.canonicalCwd ?? ""))
			throw new MasterStoreCorruptionError("Worker create intent identity or cwd is invalid.");
		assertOpaqueId(intent.createIdempotencyKey, "createIdempotencyKey");
		if (typeof intent.promptDigest !== "string" || !FINGERPRINT_PATTERN.test(intent.promptDigest))
			throw new MasterStoreCorruptionError("Worker prompt digest is invalid.");
		if (
			!isRecord(intent.intendedOwner) ||
			intent.intendedOwner.kind !== "master" ||
			intent.intendedOwner.masterName !== masterName ||
			Object.keys(intent.intendedOwner).length !== 2
		)
			throw new MasterStoreCorruptionError("Worker intended owner is invalid.");
		if (
			intent.state !== "reserved" &&
			intent.state !== "create_uncertain" &&
			intent.state !== "created" &&
			intent.state !== "prompt_pending" &&
			intent.state !== "active" &&
			intent.state !== "terminal"
		)
			throw new MasterStoreCorruptionError("Worker create intent state is invalid.");
		if (intent.promptIdempotencyKey !== null) assertOpaqueId(intent.promptIdempotencyKey, "promptIdempotencyKey");
		if (!Array.isArray(intent.followUps))
			throw new MasterStoreCorruptionError("Worker follow-up intents are invalid.");
		for (const followUp of intent.followUps) {
			if (!isRecord(followUp)) throw new MasterStoreCorruptionError("Worker follow-up intent is malformed.");
			assertOpaqueId(followUp.idempotencyKey, "followUp.idempotencyKey");
			if (typeof followUp.promptDigest !== "string" || !FINGERPRINT_PATTERN.test(followUp.promptDigest))
				throw new MasterStoreCorruptionError("Worker follow-up digest is invalid.");
			if (followUp.state !== "pending" && followUp.state !== "delivered" && followUp.state !== "uncertain")
				throw new MasterStoreCorruptionError("Worker follow-up state is invalid.");
			assertTimestamp(followUp.createdAt, "followUp.createdAt");
			assertTimestamp(followUp.updatedAt, "followUp.updatedAt");
		}
		if ((intent.state === "prompt_pending" || intent.state === "active") && intent.promptIdempotencyKey === null)
			throw new MasterStoreCorruptionError("Prompt lifecycle state has no idempotency key.");
		assertTimestamp(intent.createdAt, "intent.createdAt");
		assertTimestamp(intent.updatedAt, "intent.updatedAt");
		if (
			intentIds.has(intent.intentId) ||
			intentTasks.has(intent.taskId) ||
			createKeys.has(intent.createIdempotencyKey)
		)
			throw new MasterStoreCorruptionError("Worker create intent identity is duplicated.");
		intentIds.add(intent.intentId);
		intentTasks.add(intent.taskId);
		createKeys.add(intent.createIdempotencyKey);
	}
	const leases = new Set<string>();
	const sessions = new Set<string>();
	const tasks = new Set<string>();
	for (const value of document.workers) {
		if (!isRecord(value)) throw new MasterStoreCorruptionError("Worker lease is malformed.");
		const lease = value as Partial<WorkerLease>;
		assertOpaqueId(lease.leaseId, "leaseId");
		assertOpaqueId(lease.intentId, "intentId");
		assertOpaqueId(lease.taskId, "taskId");
		if (lease.workerSessionId !== null) assertOpaqueId(lease.workerSessionId, "workerSessionId");
		if (typeof lease.attempt !== "number" || !Number.isSafeInteger(lease.attempt) || lease.attempt < 1)
			throw new MasterStoreCorruptionError("Worker attempt is invalid.");
		if (lease.state !== "leased" && lease.state !== "assigned" && lease.state !== "terminal")
			throw new MasterStoreCorruptionError("Worker state is invalid.");
		if (
			lease.lifecycle !== null &&
			lease.lifecycle !== "owned_unprompted" &&
			lease.lifecycle !== "prompt_pending" &&
			lease.lifecycle !== "active" &&
			lease.lifecycle !== "terminal"
		)
			throw new MasterStoreCorruptionError("Worker lifecycle is invalid.");
		if (lease.state === "leased" && (lease.workerSessionId !== null || lease.lifecycle !== null))
			throw new MasterStoreCorruptionError("Reserved worker lease has a session or lifecycle.");
		if (
			lease.state === "assigned" &&
			(lease.workerSessionId === null || lease.lifecycle === null || lease.lifecycle === "terminal")
		)
			throw new MasterStoreCorruptionError("Assigned worker lease is not owned.");
		if (
			lease.state === "terminal" &&
			(lease.terminalState === null || (lease.lifecycle !== null && lease.lifecycle !== "terminal"))
		)
			throw new MasterStoreCorruptionError("Terminal worker lifecycle is invalid.");
		if (
			lease.terminalState !== null &&
			lease.terminalState !== "completed" &&
			lease.terminalState !== "failed" &&
			lease.terminalState !== "blocked"
		)
			throw new MasterStoreCorruptionError("Worker terminal state is invalid.");
		if (lease.state !== "terminal" && lease.terminalState !== null)
			throw new MasterStoreCorruptionError("Active worker has terminal state.");
		if (
			!Array.isArray(lease.quarantine) ||
			!Array.isArray(lease.observations) ||
			typeof lease.nextObservationSequence !== "number" ||
			!Number.isSafeInteger(lease.nextObservationSequence) ||
			lease.nextObservationSequence < 1
		)
			throw new MasterStoreCorruptionError("Worker observations are invalid.");
		for (const observation of [...lease.quarantine, ...lease.observations]) {
			if (
				!isRecord(observation) ||
				typeof observation.observationId !== "string" ||
				!/^[\x20-\x7e]{1,128}$/.test(observation.observationId) ||
				!Number.isSafeInteger(observation.sequence) ||
				observation.sequence < 1
			)
				throw new MasterStoreCorruptionError("Worker observation is invalid.");
			assertTimestamp(observation.occurredAt, "observation.occurredAt");
		}
		assertTimestamp(lease.createdAt, "worker.createdAt");
		assertTimestamp(lease.updatedAt, "worker.updatedAt");
		if (lease.terminalAt !== null) assertTimestamp(lease.terminalAt, "worker.terminalAt");
		if (
			leases.has(lease.leaseId) ||
			tasks.has(lease.taskId) ||
			intentIds.has(lease.intentId) === false ||
			sessions.has(lease.workerSessionId ?? "")
		)
			throw new MasterStoreCorruptionError("Worker lease identity is duplicated or references an unknown intent.");
		leases.add(lease.leaseId);
		tasks.add(lease.taskId);
		if (lease.workerSessionId !== null) sessions.add(lease.workerSessionId);
	}
}

function validateSimpleDocument(value: unknown, kind: string, masterName: string): asserts value is JsonObject {
	assertVersioned(value, kind);
	if (value.masterName !== masterName) throw new MasterStoreCorruptionError(`${kind} masterName is invalid.`);
}
function validateClaimsDocument(value: unknown, masterName: string): asserts value is MasterClaimsDocument {
	validateSimpleDocument(value, "master_claims", masterName);
	const document = value as unknown as MasterClaimsDocument;
	if (
		!isRecord(document.authorizations) ||
		!isRecord(document.claims) ||
		!isRecord(document.mintIdempotency) ||
		!isRecord(document.approvalIdempotency)
	)
		throw new MasterStoreCorruptionError("Claims maps are invalid.");
	for (const authorization of Object.values(document.authorizations)) {
		if (
			!isRecord(authorization) ||
			authorization.requestedMasterName !== masterName ||
			(authorization.state !== "unused" && authorization.state !== "consumed" && authorization.state !== "expired")
		)
			throw new MasterStoreCorruptionError("Claim authorization is malformed.");
		assertOpaqueId(authorization.authorizationId, "authorizationId");
		assertOpaqueId(authorization.workerSessionId, "workerSessionId");
		assertIngress(authorization.ingress, "authorization.ingress");
		if (authorization.ingress.kind !== "provider")
			throw new MasterStoreCorruptionError("Claim authorization ingress is not a provider.");
		assertTimestamp(authorization.issuedAt, "authorization.issuedAt");
		assertTimestamp(authorization.expiresAt, "authorization.expiresAt");
	}
	for (const claim of Object.values(document.claims)) {
		if (!isRecord(claim) || claim.requestedMasterName !== masterName)
			throw new MasterStoreCorruptionError("Ownership claim is malformed.");
		assertOpaqueId(claim.claimId, "claimId");
		assertOpaqueId(claim.workerSessionId, "workerSessionId");
		assertIngress(claim.requestIngress, "claim.requestIngress");
		if (
			claim.status !== "pending_approval" &&
			claim.status !== "approved" &&
			claim.status !== "expired" &&
			claim.status !== "rejected"
		)
			throw new MasterStoreCorruptionError("Ownership claim status is invalid.");
		assertTimestamp(claim.requestedAt, "claim.requestedAt");
		assertTimestamp(claim.expiresAt, "claim.expiresAt");
		if (claim.approvalIngress !== null) assertIngress(claim.approvalIngress, "claim.approvalIngress");
		if (claim.approvedAt !== null) assertTimestamp(claim.approvedAt, "claim.approvedAt");
	}
}

function validateEvent(
	value: unknown,
	masterName: string | null,
	expectedSeq: number | null,
): asserts value is PersistedMasterEvent {
	if (!isRecord(value)) throw new MasterStoreCorruptionError("Event record is malformed.");
	if (
		value.protocolVersion !== MASTER_PROTOCOL_VERSION ||
		(masterName !== null && value.masterName !== masterName) ||
		(expectedSeq !== null && value.seq !== expectedSeq)
	)
		throw new MasterStoreCorruptionError("Event version, master, or sequence is invalid.");
	if (typeof value.seq !== "number" || !Number.isSafeInteger(value.seq) || value.seq < 1)
		throw new MasterStoreCorruptionError("Event sequence is invalid.");
	if (typeof value.masterName !== "string") throw new MasterStoreCorruptionError("Event masterName is invalid.");
	try {
		assertCanonicalMasterName(value.masterName);
	} catch (error) {
		throw new MasterStoreCorruptionError(`Event masterName is invalid: ${errorAsMessage(error)}`);
	}
	if (typeof value.eventId !== "string" || !/^[\x20-\x7e]{1,128}$/.test(value.eventId))
		throw new MasterStoreCorruptionError("Event ID is invalid.");
	if (
		typeof value.occurredAt !== "string" ||
		!value.occurredAt.endsWith("Z") ||
		Number.isNaN(Date.parse(value.occurredAt))
	)
		throw new MasterStoreCorruptionError("Event timestamp is invalid.");
	if (
		value.type !== "queue_updated" &&
		value.type !== "ownership_updated" &&
		value.type !== "decision_logged" &&
		value.type !== "memory_activity" &&
		value.type !== "master_status" &&
		value.type !== "channel_updated"
	)
		throw new MasterStoreCorruptionError("Event type is invalid.");
	if (typeof value.checksum !== "string" || !/^[0-9a-f]{64}$/.test(value.checksum))
		throw new MasterStoreCorruptionError("Event checksum is invalid.");
	const { checksum, ...base } = value;
	if (sha256(canonicalJson(base)) !== checksum)
		throw new MasterStoreCorruptionError("Event checksum does not match payload.");
	if (value.type === "queue_updated") {
		if (!isRecord(value.payload) || !isRecord(value.payload.queue))
			throw new MasterStoreCorruptionError("Queue event payload is malformed.");
		try {
			const summary = value.payload.queue as unknown;
			if (!Number.isSafeInteger((summary as QueueStateSummary).queueRevision)) throw new Error("queueRevision");
			assertCapacityInvariant(
				(summary as QueueStateSummary).activeWorkerCount,
				(summary as QueueStateSummary).maxConcurrentWorkers,
				(summary as QueueStateSummary).capacityState,
			);
		} catch (error) {
			throw new MasterStoreCorruptionError(`Queue event summary is invalid: ${errorAsMessage(error)}`);
		}
	}
}

function assertEventDraft(draft: EventDraft): void {
	if (!isRecord(draft) || typeof draft.type !== "string" || !isRecord(draft.payload))
		throw new MasterStoreError("INVALID_EVENT", "Event draft payload is invalid.");
	if (
		draft.type !== "queue_updated" &&
		draft.type !== "ownership_updated" &&
		draft.type !== "decision_logged" &&
		draft.type !== "memory_activity" &&
		draft.type !== "master_status" &&
		draft.type !== "channel_updated"
	)
		throw new MasterStoreError("INVALID_EVENT", "Event draft type is invalid.");
	if (draft.type === "decision_logged") {
		if (typeof draft.payload.decisionId !== "string" || typeof draft.payload.reason !== "string")
			throw new MasterStoreError("INVALID_EVENT", "Decision event payload is invalid.");
	}
	if (draft.type === "memory_activity") {
		if (!isRecord(draft.payload.activity) || typeof draft.payload.activity.activityId !== "string")
			throw new MasterStoreError("INVALID_EVENT", "Memory event payload is invalid.");
	}
}

function eventBase(draft: EventDraft, masterName: string, seq: number, occurredAt: string): MasterEventFrame {
	if (draft.type === "queue_updated")
		return {
			protocolVersion: MASTER_PROTOCOL_VERSION,
			seq,
			eventId: `${masterName}:event:${seq}`,
			masterName,
			occurredAt,
			type: draft.type,
			payload: draft.payload,
		};
	if (draft.type === "ownership_updated")
		return {
			protocolVersion: MASTER_PROTOCOL_VERSION,
			seq,
			eventId: `${masterName}:event:${seq}`,
			masterName,
			occurredAt,
			type: draft.type,
			payload: draft.payload,
		};
	if (draft.type === "decision_logged")
		return {
			protocolVersion: MASTER_PROTOCOL_VERSION,
			seq,
			eventId: `${masterName}:event:${seq}`,
			masterName,
			occurredAt,
			type: draft.type,
			payload: draft.payload,
		};
	if (draft.type === "memory_activity")
		return {
			protocolVersion: MASTER_PROTOCOL_VERSION,
			seq,
			eventId: `${masterName}:event:${seq}`,
			masterName,
			occurredAt,
			type: draft.type,
			payload: draft.payload,
		};
	if (draft.type === "master_status")
		return {
			protocolVersion: MASTER_PROTOCOL_VERSION,
			seq,
			eventId: `${masterName}:event:${seq}`,
			masterName,
			occurredAt,
			type: draft.type,
			payload: draft.payload,
		};
	return {
		protocolVersion: MASTER_PROTOCOL_VERSION,
		seq,
		eventId: `${masterName}:event:${seq}`,
		masterName,
		occurredAt,
		type: draft.type,
		payload: draft.payload,
	};
}

function queueSummary(queue: MasterQueueDocument): QueueStateSummary {
	return {
		queueRevision: queue.queueRevision,
		pendingCount: queue.tasks.filter(task => task.state === "queued" || task.state === "retry_pending").length,
		activeWorkerCount: queue.activeWorkerCount,
		maxConcurrentWorkers: queue.maxConcurrentWorkers,
		capacityState: queue.capacityState,
		userDispatchStreak: queue.userDispatchStreak,
	};
}

function taskSummary(task: TaskRecord): TaskSummary {
	return {
		taskId: task.taskId,
		enqueueSeq: task.enqueueSeq,
		priority: task.priority,
		source: task.source,
		state: task.state,
		attempt: task.attempt,
		summary: task.summary,
		createdAt: task.createdAt,
		updatedAt: task.updatedAt,
		workerSessionId: task.workerSessionId,
	};
}

function normalizeOptions(
	options: MasterDomainStoreOptions | string,
	pathOptions: MasterPathOptions = {},
): MasterDomainStoreOptions {
	if (typeof options === "string") return { masterName: options, ...pathOptions };
	return options;
}

export class MasterDomainStore {
	readonly masterName: string;
	readonly paths: MasterPaths;
	readonly masterRootDir: string;
	readonly #now: () => Date;
	readonly #defaultWorkdir: string;
	readonly #configuredMaxWorkers: number;
	readonly #configuredProviders: MasterProvider[];
	readonly #authorityFingerprint: string;
	readonly #expectedAuthorityFingerprint: string | null;

	constructor(options: MasterDomainStoreOptions | string, pathOptions: MasterPathOptions = {}) {
		const normalized = normalizeOptions(options, pathOptions);
		assertCanonicalMasterName(normalized.masterName);
		this.masterName = normalized.masterName;
		const configuredRoot = normalized.rootDir === undefined ? undefined : path.resolve(normalized.rootDir);
		const inferredMasterRoot =
			normalized.masterRootDir ??
			(configuredRoot !== undefined && path.basename(configuredRoot) === "master" ? configuredRoot : undefined);
		const pathOptionsForStore: MasterPathOptions = {
			configRootDir: inferredMasterRoot === undefined ? (normalized.configRootDir ?? normalized.rootDir) : undefined,
			masterRootDir: inferredMasterRoot,
		};
		this.paths = getMasterPaths(this.masterName, pathOptionsForStore);
		this.masterRootDir = this.paths.root;
		this.#now = normalized.now ?? (() => new Date());
		this.#defaultWorkdir = path.resolve(normalized.defaultWorkdir ?? process.cwd());
		if (!isAbsoluteNormalizedPath(this.#defaultWorkdir))
			throw new MasterStoreError("INVALID_WORKDIR", "defaultWorkdir must be absolute and normalized.");
		this.#configuredMaxWorkers = normalized.maxConcurrentWorkers ?? DEFAULT_MAX_CONCURRENT_WORKERS;
		assertPositiveSafeInteger(this.#configuredMaxWorkers, "maxConcurrentWorkers");
		this.#configuredProviders = normalizeProviders(normalized.configuredProviders);
		const fingerprints = [
			normalized.authorityFingerprint,
			normalized.expectedAuthorityFingerprint,
			normalized.coordinatorAuthorityFingerprint,
		].filter((value): value is string => value !== undefined);
		if (new Set(fingerprints).size > 1)
			throw new MasterStoreError("AUTHORITY_MISMATCH", "Coordinator authority fingerprint aliases disagree.");
		const fingerprint = fingerprints[0] ?? DEFAULT_AUTHORITY_FINGERPRINT;
		if (!FINGERPRINT_PATTERN.test(fingerprint))
			throw new MasterStoreError(
				"INVALID_AUTHORITY_FINGERPRINT",
				"Coordinator authority fingerprint must be 64 lowercase hexadecimal characters.",
			);
		this.#authorityFingerprint = fingerprint;
		this.#expectedAuthorityFingerprint = fingerprints.length === 0 ? null : fingerprint;
	}

	static async create(
		options: MasterDomainStoreOptions | string,
		pathOptions: MasterPathOptions = {},
	): Promise<MasterDomainStore> {
		const store = new MasterDomainStore(options, pathOptions);
		await store.initialize();
		return store;
	}

	static async open(
		options: MasterDomainStoreOptions | string,
		pathOptions: MasterPathOptions = {},
	): Promise<MasterDomainStore> {
		const store = new MasterDomainStore(options, pathOptions);
		const stat = await lstatIfPresent(store.paths.recordPath);
		if (stat === null) throw new MasterStoreNotFoundError(store.masterName);
		if (!stat.isFile() || stat.isSymbolicLink())
			throw new MasterStoreCorruptionError("Master record is not a regular file.");
		await store.#withLock(async state => ({ value: state.record }));
		return store;
	}

	static async exists(
		options: MasterDomainStoreOptions | string,
		pathOptions: MasterPathOptions = {},
	): Promise<boolean> {
		const store = new MasterDomainStore(options, pathOptions);
		const stat = await lstatIfPresent(store.paths.recordPath);
		return stat?.isFile() === true && !stat.isSymbolicLink();
	}

	static async list(options: Omit<MasterDomainStoreOptions, "masterName"> = {}): Promise<MasterListItem[]> {
		const configuredRoot = options.rootDir === undefined ? undefined : path.resolve(options.rootDir);
		const inferredMasterRoot =
			options.masterRootDir ??
			(configuredRoot !== undefined && path.basename(configuredRoot) === "master" ? configuredRoot : undefined);
		const roots = getMasterPaths("a", {
			configRootDir: inferredMasterRoot === undefined ? (options.configRootDir ?? options.rootDir) : undefined,
			masterRootDir: inferredMasterRoot,
		});
		const masterRoot = roots.mastersDir;
		let entries: Dirent[];
		try {
			entries = await fs.readdir(masterRoot, { withFileTypes: true });
		} catch (error) {
			if (isNodeError(error, "ENOENT")) return [];
			throw error;
		}
		const result: MasterListItem[] = [];
		for (const entry of entries) {
			if (!entry.isDirectory() || entry.isSymbolicLink() || !isCanonicalMasterName(entry.name)) continue;
			const recordPath = path.join(masterRoot, entry.name, "record.json");
			const recordValue = await readJson(recordPath);
			validateMasterRecord(recordValue, entry.name);
			const expectedAuthorityFingerprint =
				options.expectedAuthorityFingerprint ?? options.authorityFingerprint ?? recordValue.authorityFingerprint;
			const store = await MasterDomainStore.open({
				...options,
				masterName: entry.name,
				expectedAuthorityFingerprint,
			});
			const record = await store.readRecord();
			result.push({
				masterName: record.masterName,
				defaultWorkdir: record.defaultWorkdir,
				maxConcurrentWorkers: record.maxConcurrentWorkers,
				capacityState: record.capacityState,
				activeWorkerCount: record.activeWorkerCount,
				updatedAt: record.updatedAt,
			});
		}
		return result.sort((left, right) => left.masterName.localeCompare(right.masterName));
	}

	async initialize(): Promise<void> {
		await ensurePrivateMasterLayout(this.paths);
		await withFileLock(this.paths.lockPath, async () => {
			const existing = await lstatIfPresent(this.paths.recordPath);
			if (existing !== null)
				throw new MasterStoreError("MASTER_EXISTS", `Master ${this.masterName} already exists.`);
			const entries = await fs.readdir(this.paths.masterDir, { withFileTypes: true });
			if (entries.some(entry => entry.isFile() || entry.isSymbolicLink()))
				throw new MasterStoreCorruptionError(`Partial master state exists for ${this.masterName}.`);
			const createdAt = nowIso(this.#now);
			const maxConcurrentWorkers = this.#configuredMaxConcurrentWorkers();
			const record: MasterRecord = {
				version: MASTER_SCHEMA_VERSION,
				schema_version: MASTER_SCHEMA_VERSION,
				kind: "master_record",
				masterName: this.masterName,
				defaultWorkdir: this.#defaultWorkdir,
				maxConcurrentWorkers,
				capacityState: "within_limit",
				activeWorkerCount: 0,
				queueRevision: 0,
				userDispatchStreak: 0,
				authorityFingerprint: this.#authorityFingerprint,

				createdAt,
				updatedAt: createdAt,
			};
			const queue: MasterQueueDocument = {
				version: MASTER_SCHEMA_VERSION,
				schema_version: MASTER_SCHEMA_VERSION,
				kind: "master_queue",
				masterName: this.masterName,
				queueRevision: 0,
				nextEnqueueSeq: 1,
				userDispatchStreak: 0,
				activeWorkerCount: 0,
				maxConcurrentWorkers,
				capacityState: "within_limit",
				tasks: [],
				idempotencyReceipts: {},
				releaseReceipts: {},
			};
			const workers: MasterWorkersDocument = {
				version: MASTER_SCHEMA_VERSION,
				schema_version: MASTER_SCHEMA_VERSION,
				kind: "master_workers",
				masterName: this.masterName,
				intents: [],
				workers: [],
			};
			const ownership: MasterOwnershipDocument = {
				version: MASTER_SCHEMA_VERSION,
				schema_version: MASTER_SCHEMA_VERSION,
				kind: "master_ownership",
				masterName: this.masterName,
				owners: {},
			};
			const claims: MasterClaimsDocument = {
				version: MASTER_SCHEMA_VERSION,
				schema_version: MASTER_SCHEMA_VERSION,
				kind: "master_claims",
				masterName: this.masterName,
				authorizations: {},
				claims: {},
				mintIdempotency: {},
				approvalIdempotency: {},
			};
			const channels: MasterChannelsDocument = {
				version: MASTER_SCHEMA_VERSION,
				schema_version: MASTER_SCHEMA_VERSION,
				kind: "master_channels",
				masterName: this.masterName,
				configuredProviders: [...this.#configuredProviders],
				receiptCursors: {},
				workerLeases: [],
				effectLeases: [],
				channels: this.#configuredProviders.map(provider => ({
					provider,
					state: "provisioning" as const,
					intentId: providerIntentId(this.masterName, provider),
					bindingId: null,
					remoteChannelId: null,
					fence: 0,
					pendingPresentationCount: 0,
					deliveryHealth: "healthy" as const,
				})),
			};
			const outbox: MasterOutboxDocument = {
				version: MASTER_SCHEMA_VERSION,
				schema_version: MASTER_SCHEMA_VERSION,
				kind: "master_presentation_outbox",
				masterName: this.masterName,
				rows: [],
			};
			const initialState: MasterStoreState = {
				record,
				queue,
				workers,
				ownership,
				claims,
				channels,
				outbox,
				events: [],
			};
			await withFileLock(this.paths.eventJournalLockPath, async () => {
				const globalJournal = await lstatIfPresent(this.paths.eventJournalPath);
				if (globalJournal?.isSymbolicLink() || (globalJournal !== null && !globalJournal.isFile()))
					throw new MasterStoreError("MASTER_PATH_INVALID", "Global event journal is not a regular file.");
				if (globalJournal === null) await atomicWriteText(this.paths.eventJournalPath, "", this.paths.root);
				await this.#commitAggregateLocked(initialState, null);
			});
			await atomicWriteText(this.paths.doctrinePath, "", this.paths.root);
		});
	}

	getPaths(): MasterPaths {
		return this.paths;
	}

	getRootDir(): string {
		return this.masterRootDir;
	}

	async readRecord(): Promise<MasterRecord> {
		return await this.#withLock(async state => ({ value: clone(state.record) }));
	}

	async readQueue(): Promise<MasterQueueDocument> {
		return await this.#withLock(async state => ({ value: clone(state.queue) }));
	}

	async readWorkers(): Promise<MasterWorkersDocument> {
		return await this.#withLock(async state => ({ value: clone(state.workers) }));
	}

	async readWorkerIntents(): Promise<readonly WorkerCreateIntent[]> {
		return await this.#withLock(async state => ({ value: clone(state.workers.intents) }));
	}

	async readWorkerIntent(intentId: string): Promise<WorkerCreateIntent | null> {
		assertOpaqueId(intentId, "intentId");
		return await this.#withLock(async state => ({
			value: clone(state.workers.intents.find(intent => intent.intentId === intentId) ?? null),
		}));
	}
	async readWorkerCreateIntents(): Promise<readonly WorkerCreateIntent[]> {
		return await this.readWorkerIntents();
	}

	async readOwnership(): Promise<MasterOwnershipDocument> {
		return await this.#withLock(async state => ({ value: clone(state.ownership) }));
	}

	async readChannels(): Promise<MasterChannelsDocument> {
		return await this.#withLock(async state => ({ value: clone(state.channels) }));
	}

	async getChannels(): Promise<readonly ChannelSnapshot[]> {
		return await this.#withLock(async state => ({ value: clone(state.channels.channels) }));
	}

	async readOutbox(): Promise<MasterOutboxDocument> {
		return await this.#withLock(async state => ({ value: clone(state.outbox) }));
	}

	async getOutbox(): Promise<readonly PresentationOutboxRow[]> {
		return await this.#withLock(async state => ({ value: clone(state.outbox.rows) }));
	}

	async readProviderHealth(): Promise<ProviderHealth> {
		return await this.#withLock(async state => ({ value: clone(this.#providerHealth(state)) }));
	}

	async providerHealth(): Promise<ProviderHealth> {
		return await this.readProviderHealth();
	}

	async readProviderWorkerLeases(): Promise<readonly ProviderWorkerLease[]> {
		return await this.#withLock(async state => ({ value: clone(state.channels.workerLeases) }));
	}

	async readEffectLeases(): Promise<readonly ProviderEffectLeaseRecord[]> {
		return await this.#withLock(async state => ({ value: clone(state.channels.effectLeases) }));
	}

	async readQueueSummary(): Promise<QueueStateSummary> {
		return await this.#withLock(async state => ({ value: queueSummary(state.queue) }));
	}

	async getQueueState(): Promise<QueueStateSummary> {
		return await this.readQueueSummary();
	}

	async readEvents(afterSeq = 0): Promise<PersistedMasterEvent[]> {
		if (!Number.isSafeInteger(afterSeq) || afterSeq < 0)
			throw new MasterStoreError("INVALID_CURSOR", "afterSeq must be a non-negative safe integer.");
		return await this.#withLock(async state => ({
			value: clone(state.events.filter(event => event.seq > afterSeq)),
		}));
	}

	async readGlobalEvents(afterSeq = 0): Promise<PersistedMasterEvent[]> {
		if (!Number.isSafeInteger(afterSeq) || afterSeq < 0)
			throw new MasterStoreError("INVALID_CURSOR", "afterSeq must be a non-negative safe integer.");
		return await this.#withLock(async _state => ({
			value: clone(
				(await readGlobalJournal(this.paths.eventJournalPath, this.paths.eventCheckpointPath)).filter(
					event => event.seq > afterSeq,
				),
			),
		}));
	}

	async events(afterSeq = 0): Promise<PersistedMasterEvent[]> {
		return await this.readEvents(afterSeq);
	}

	async getEventSequence(): Promise<number> {
		return await this.#withLock(async _state => ({
			value: (await readGlobalJournal(this.paths.eventJournalPath, this.paths.eventCheckpointPath)).length,
		}));
	}

	async appendEvent(event: EventDraft): Promise<PersistedMasterEvent> {
		if (!isRecord(event)) throw new MasterStoreError("INVALID_EVENT", "Event draft must be an object.");
		assertEventDraft(event);
		return await this.#withLock(async _state => ({ value: null as never, events: [event], returnLastEvent: true }));
	}

	async recordEvent(event: EventDraft): Promise<PersistedMasterEvent> {
		return await this.appendEvent(event);
	}

	async recordDecision(input: DecisionRecordInput): Promise<{
		decisionId: string;
		eventId: string;
		outcome: DecisionRecordInput["outcome"];
	}> {
		if (!isRecord(input)) throw new MasterStoreError("INVALID_INPUT", "Decision input must be an object.");
		const decisionId = input.decisionId ?? randomUUID();
		assertOpaqueId(decisionId, "decisionId");
		assertNonEmptyText(input.reason, "reason", 16_384);
		if (!isRecord(input.trigger) || typeof input.trigger.kind !== "string")
			throw new MasterStoreError("INVALID_INPUT", "Decision trigger is invalid.");
		if (!["follow_up", "escalated", "assigned", "completed", "blocked"].includes(input.outcome))
			throw new MasterStoreError("INVALID_INPUT", "Decision outcome is invalid.");
		if (
			!isRecord(input.doctrine) ||
			typeof input.doctrine.revision !== "string" ||
			!FINGERPRINT_PATTERN.test(String(input.doctrine.sha256))
		)
			throw new MasterStoreError("INVALID_INPUT", "Decision doctrine evidence is invalid.");
		if (
			!isRecord(input.memory) ||
			(input.memory.availability !== "available" && input.memory.availability !== "unavailable") ||
			!Array.isArray(input.memory.activityIds)
		)
			throw new MasterStoreError("INVALID_INPUT", "Decision memory evidence is invalid.");
		const prior = (await this.readEvents()).find(
			event => event.type === "decision_logged" && event.payload.decisionId === decisionId,
		);
		if (prior !== undefined) {
			if (
				prior.type !== "decision_logged" ||
				prior.payload.outcome !== input.outcome ||
				prior.payload.reason !== input.reason
			)
				throw new MasterIdempotencyConflictError(decisionId);
			return { decisionId, eventId: prior.eventId, outcome: prior.payload.outcome };
		}
		const persisted = await this.appendEvent({
			type: "decision_logged",
			payload: {
				decisionId,
				trigger: clone(input.trigger),
				outcome: input.outcome,
				reason: input.reason,
				doctrine: clone(input.doctrine),
				memory: clone(input.memory),
			},
		});
		return { decisionId, eventId: persisted.eventId, outcome: input.outcome };
	}

	async recordMemoryActivity(activity: MemoryActivity): Promise<PersistedMasterEvent> {
		if (!isRecord(activity)) throw new MasterStoreError("INVALID_INPUT", "Memory activity must be an object.");
		if (activity.masterName !== this.masterName)
			throw new MasterStoreError("MASTER_MISMATCH", "Memory activity belongs to another master.");
		assertOpaqueId(activity.activityId, "activityId");
		if (activity.operation !== "read" && activity.operation !== "write")
			throw new MasterStoreError("INVALID_INPUT", "Memory activity operation is invalid.");
		assertNonEmptyText(activity.summary, "summary", 16_384);
		assertTimestamp(activity.occurredAt, "occurredAt");
		const prior = (await this.readEvents()).find(
			event => event.type === "memory_activity" && event.payload.activity.activityId === activity.activityId,
		);
		if (prior !== undefined) return clone(prior);
		return await this.appendEvent({ type: "memory_activity", payload: { activity: clone(activity) } });
	}

	async escalate(input: EscalationInput): Promise<{ decisionId: string; eventId: string; outcome: "escalated" }> {
		if (!isRecord(input)) throw new MasterStoreError("INVALID_INPUT", "Escalation input must be an object.");
		assertNonEmptyText(input.reason, "reason", 16_384);
		const decisionId = input.decisionId ?? randomUUID();
		assertOpaqueId(decisionId, "decisionId");
		const result = await this.recordDecision({
			decisionId,
			trigger:
				input.trigger ??
				(input.taskId === undefined
					? { kind: "daemon_recovery", recoveryId: decisionId }
					: { kind: "task_dispatch", taskId: input.taskId }),
			outcome: "escalated",
			reason: input.reason,
			doctrine: input.doctrine ?? { revision: "unavailable", sha256: sha256("") },
			memory: input.memory ?? { availability: "unavailable", activityIds: [] },
		});
		return { decisionId: result.decisionId, eventId: result.eventId, outcome: "escalated" };
	}

	async createBindingIntents(input: CreateBindingIntentInput = {}): Promise<BindingIntentReceipt[]> {
		const providers =
			input.providers === undefined
				? input.provider === undefined
					? undefined
					: [input.provider]
				: [...input.providers];
		if (providers !== undefined) for (const provider of providers) assertProvider(provider);
		if (input.intentId !== undefined) assertOpaqueId(input.intentId, "intentId");
		if (input.channelName !== undefined) assertNonEmptyText(input.channelName, "channelName", 128);
		return await this.#withLock(async state => {
			const configured = state.channels.configuredProviders;
			const targets = providers === undefined ? configured : providers;
			for (const provider of targets) this.#assertConfiguredProvider(state, provider);
			const receipts: BindingIntentReceipt[] = [];
			const events: EventDraft[] = [];
			for (const provider of targets) {
				const existing = state.channels.channels.find(channel => channel.provider === provider);
				if (existing !== undefined) {
					if (input.intentId !== undefined && existing.intentId !== input.intentId)
						throw new MasterStoreError(
							"BINDING_INTENT_CONFLICT",
							`Binding intent for ${provider} already exists.`,
						);
					receipts.push({
						provider,
						intentId: existing.intentId,
						fence: existing.fence,
						state: "provisioning",
						channelName: input.channelName ?? providerChannelName(this.masterName, provider),
					});
					continue;
				}
				const intentId = input.intentId ?? providerIntentId(this.masterName, provider);
				const channelName = input.channelName ?? providerChannelName(this.masterName, provider);
				const channel: ChannelSnapshot = {
					provider,
					state: "provisioning",
					intentId,
					bindingId: null,
					remoteChannelId: null,
					fence: 0,
					pendingPresentationCount: 0,
					deliveryHealth: "healthy",
				};
				state.channels.channels.push(channel);
				receipts.push({ provider, intentId, fence: 0, state: "provisioning", channelName });
				events.push({
					type: "channel_updated",
					payload: {
						transition: "binding_intent_created",
						provider,
						intentId,
						fence: 0,
						state: "provisioning",
						channelName,
					},
				});
			}
			return { value: receipts, events };
		});
	}

	async createChannelBindingIntents(input: CreateBindingIntentInput = {}): Promise<BindingIntentReceipt[]> {
		return await this.createBindingIntents(input);
	}

	async ensureChannelBindingIntents(input: CreateBindingIntentInput = {}): Promise<BindingIntentReceipt[]> {
		return await this.createBindingIntents(input);
	}

	async createChannelBindingIntent(provider: MasterProvider, channelName?: string): Promise<BindingIntentReceipt> {
		return (await this.createBindingIntents({ provider, channelName }))[0]!;
	}

	async registerProviderWorker(input: ProviderWorkerRegistrationInput): Promise<ProviderWorkerRegistrationReceipt> {
		if (!isRecord(input))
			throw new MasterStoreError("INVALID_INPUT", "Provider worker registration must be an object.");
		assertProvider(input.provider);
		assertOpaqueId(input.workerId, "workerId");
		if (input.leaseId !== undefined) assertOpaqueId(input.leaseId, "leaseId");
		const ttlMs = input.ttlMs ?? DEFAULT_PROVIDER_LEASE_MS;
		if (!Number.isSafeInteger(ttlMs) || ttlMs < 1 || ttlMs > MAX_PROVIDER_LEASE_MS)
			throw new MasterStoreError("INVALID_INPUT", "Provider worker lease TTL is invalid.");
		return await this.#withLock<ProviderWorkerRegistrationReceipt>(async state => {
			this.#assertConfiguredProvider(state, input.provider);
			const timestamp = nowIso(this.#now);
			const existing = state.channels.workerLeases.find(
				lease => lease.provider === input.provider && lease.workerId === input.workerId,
			);
			if (existing !== undefined && Date.parse(existing.expiresAt) > Date.parse(timestamp)) {
				if (input.leaseId !== undefined && existing.leaseId !== input.leaseId)
					throw new MasterStoreError(
						"WORKER_LEASE_CONFLICT",
						"Provider worker already has a different active lease.",
					);
				existing.expiresAt = new Date(Date.parse(timestamp) + ttlMs).toISOString();
				existing.updatedAt = timestamp;
				return {
					value: {
						provider: input.provider,
						workerId: input.workerId,
						leaseId: existing.leaseId,
						expiresAt: existing.expiresAt,
						state: "already_registered" as const,
					},
					persist: true,
				};
			}
			const lease: ProviderWorkerLease = {
				provider: input.provider,
				workerId: input.workerId,
				leaseId: input.leaseId ?? randomUUID(),
				expiresAt: new Date(Date.parse(timestamp) + ttlMs).toISOString(),
				state: "active",
				createdAt: timestamp,
				updatedAt: timestamp,
			};
			if (existing === undefined) state.channels.workerLeases.push(lease);
			else Object.assign(existing, lease);
			return {
				value: {
					provider: lease.provider,
					workerId: lease.workerId,
					leaseId: lease.leaseId,
					expiresAt: lease.expiresAt,
					state: "registered" as const,
				},
				persist: true,
			};
		});
	}

	async registerProvider(input: ProviderWorkerRegistrationInput): Promise<ProviderWorkerRegistrationReceipt> {
		return await this.registerProviderWorker(input);
	}

	async leaseProviderEffect(input: ProviderEffectLeaseInput): Promise<ProviderEffectLease | null> {
		if (!isRecord(input))
			throw new MasterStoreError("INVALID_INPUT", "Provider effect lease input must be an object.");
		assertProvider(input.provider);
		if (input.workerId !== undefined) assertOpaqueId(input.workerId, "workerId");
		if (input.workerLeaseId !== undefined) assertOpaqueId(input.workerLeaseId, "workerLeaseId");
		return await this.#withLock(async state => {
			this.#assertConfiguredProvider(state, input.provider);
			this.#expireProviderLeases(state);
			const workerLease = this.#assertProviderWorkerLease(
				state,
				input.provider,
				input.workerId,
				input.workerLeaseId,
			);
			return {
				value: this.#leaseProviderEffectLocked(state, input.provider, workerLease.workerId, workerLease.leaseId),
				persist: true,
			};
		});
	}

	async leaseNextProviderEffect(input: ProviderEffectLeaseInput): Promise<ProviderEffectLease | null> {
		return await this.leaseProviderEffect(input);
	}

	async acquireProviderEffect(input: ProviderEffectLeaseInput): Promise<ProviderEffectLease | null> {
		return await this.leaseProviderEffect(input);
	}

	async reconcileProviderEffect(input: ProviderEffectResultInput): Promise<ProviderEffectResultReceipt> {
		return await this.#reconcileProviderEffect(input);
	}

	async recordProviderEffectResult(input: ProviderEffectResultInput): Promise<ProviderEffectResultReceipt> {
		return await this.reconcileProviderEffect(input);
	}

	async applyProviderEffectResult(input: ProviderEffectResultInput): Promise<ProviderEffectResultReceipt> {
		return await this.reconcileProviderEffect(input);
	}

	async reconcileBinding(input: ReconcileBindingInput): Promise<ReconcileBindingReceipt> {
		const result = await this.reconcileProviderEffect(input);
		const channels = await this.readChannels();
		const channel = channels.channels.find(candidate => candidate.provider === input.provider);
		if (channel === undefined)
			throw new MasterStoreCorruptionError("Binding channel disappeared during reconciliation.");
		return {
			provider: input.provider,
			intentId: input.intentId,
			bindingId: channel.bindingId,
			remoteChannelId: channel.remoteChannelId,
			state: channel.state,
			fence: channel.fence,
			idempotent: result.disposition === "already_recorded",
		};
	}

	async reconcileChannelBinding(input: ReconcileBindingInput): Promise<ReconcileBindingReceipt> {
		return await this.reconcileBinding(input);
	}

	async readDoctrine(): Promise<string> {
		return await withFileLock(this.paths.lockPath, async () => {
			try {
				return await fs.readFile(this.paths.doctrinePath, "utf8");
			} catch (error) {
				if (isNodeError(error, "ENOENT")) throw new MasterStoreCorruptionError("Doctrine file is missing.");
				throw error;
			}
		});
	}

	async writeDoctrine(doctrine: string): Promise<void> {
		assertNonEmptyText(doctrine, "doctrine", 1_048_576);
		await withFileLock(this.paths.lockPath, async () => {
			await this.#readState();
			await atomicWriteText(this.paths.doctrinePath, doctrine, this.paths.root);
		});
	}

	async enqueueTask(input: EnqueueTaskInput): Promise<EnqueueReceipt> {
		this.#validateEnqueueInput(input);
		return await this.#withLock<EnqueueReceipt>(async state => {
			if (input.ingress !== undefined) this.#assertActiveProviderIngress(state, input.ingress);
			const digest = this.#enqueueDigest(input);
			const existing = state.queue.idempotencyReceipts[input.idempotencyKey];
			if (existing !== undefined) {
				if (existing.bodyDigest !== digest) throw new MasterIdempotencyConflictError(input.idempotencyKey);
				return {
					value: {
						kind: "task",
						taskId: existing.taskId,
						enqueueSeq: existing.enqueueSeq,
						state: "queued",
						idempotent: true,
					},
				};
			}
			const timestamp = nowIso(this.#now);
			const task: TaskRecord = {
				logicalTaskId: input.taskId ?? undefined,
				taskId: input.taskId ?? randomUUID(),
				enqueueSeq: state.queue.nextEnqueueSeq,
				priority: input.priority,
				source: input.source,
				state: "queued",
				attempt: 1,
				summary: input.summary,
				createdAt: timestamp,
				updatedAt: timestamp,
				workerSessionId: null,
				idempotencyKey: input.idempotencyKey,
				bodyDigest: digest,
				leaseId: null,
				workdir: input.workdir ?? null,
			};
			if (state.queue.tasks.some(candidate => candidate.taskId === task.taskId))
				throw new MasterStoreError("TASK_EXISTS", `Task ${task.taskId} already exists.`);
			state.queue.tasks.push(task);
			state.queue.nextEnqueueSeq += 1;
			state.queue.queueRevision += 1;
			state.queue.idempotencyReceipts[input.idempotencyKey] = {
				idempotencyKey: input.idempotencyKey,
				bodyDigest: digest,
				taskId: task.taskId,
				enqueueSeq: task.enqueueSeq,
				state: "queued",
			};
			this.#syncDerived(state, timestamp);
			return {
				value: {
					kind: "task",
					taskId: task.taskId,
					enqueueSeq: task.enqueueSeq,
					state: "queued",
					idempotent: false,
				},
				event: {
					type: "queue_updated",
					payload: {
						action: "enqueued",
						cause: input.source === "user" ? "user_ingress" : "master_autonomous",
						task: taskSummary(task) as TaskSummary & { state: "queued" },
						queue: queueSummary(state.queue),
					},
				},
			};
		});
	}

	async enqueue(input: EnqueueTaskInput): Promise<EnqueueReceipt> {
		return await this.enqueueTask(input);
	}

	async admitNextTask(
		input: {
			leaseId?: string;
			intentId?: string;
			canonicalCwd?: string;
			createIdempotencyKey?: string;
			promptDigest?: string;
			/** Admit exactly this queued task instead of the queue's own next selection. */
			taskId?: string;
		} = {},
	): Promise<LeaseReceipt | null> {
		if (Object.hasOwn(input as object, "workerSessionId"))
			throw new MasterStoreError(
				"UNSAFE_WORKER_SESSION_ID",
				"Admission cannot invent or accept a worker session ID.",
			);
		if (input.leaseId !== undefined) assertOpaqueId(input.leaseId, "leaseId");
		if (input.intentId !== undefined) assertOpaqueId(input.intentId, "intentId");
		if (input.canonicalCwd !== undefined) assertNonEmptyText(input.canonicalCwd, "canonicalCwd", 4096);
		if (input.createIdempotencyKey !== undefined) assertOpaqueId(input.createIdempotencyKey, "createIdempotencyKey");
		if (input.promptDigest !== undefined && !FINGERPRINT_PATTERN.test(input.promptDigest))
			throw new MasterStoreError("INVALID_INPUT", "promptDigest must be a 64-character lowercase SHA-256 digest.");
		if (input.taskId !== undefined) assertOpaqueId(input.taskId, "taskId");
		return await this.#withLock<LeaseReceipt | null>(async state => {
			let existing: WorkerCreateIntent | undefined;
			if (input.leaseId !== undefined) {
				const existingWorker = state.workers.workers.find(worker => worker.leaseId === input.leaseId);
				if (existingWorker !== undefined)
					existing = state.workers.intents.find(intent => intent.intentId === existingWorker.intentId);
			} else if (input.intentId !== undefined) {
				existing = state.workers.intents.find(intent => intent.intentId === input.intentId);
			} else if (input.createIdempotencyKey !== undefined) {
				existing = state.workers.intents.find(intent => intent.createIdempotencyKey === input.createIdempotencyKey);
			}
			if (existing !== undefined) {
				const existingWorker = state.workers.workers.find(worker => worker.intentId === existing.intentId);
				if (existingWorker === undefined)
					throw new MasterStoreCorruptionError("Worker create intent has no capacity lease.");
				if (
					input.createIdempotencyKey !== undefined &&
					existing.createIdempotencyKey !== input.createIdempotencyKey
				)
					throw new MasterIdempotencyConflictError(input.createIdempotencyKey);
				if (input.canonicalCwd !== undefined && existing.canonicalCwd !== input.canonicalCwd)
					throw new MasterIdempotencyConflictError(existing.createIdempotencyKey);
				if (input.promptDigest !== undefined && existing.promptDigest !== input.promptDigest)
					throw new MasterIdempotencyConflictError(existing.createIdempotencyKey);
				if (input.taskId !== undefined && existingWorker.taskId !== input.taskId)
					throw new MasterIdempotencyConflictError(existing.createIdempotencyKey);
				if (existingWorker.state === "terminal") return { value: null };
				return {
					value: {
						leaseId: existingWorker.leaseId,
						intentId: existing.intentId,
						taskId: existingWorker.taskId,
						workerSessionId: existingWorker.workerSessionId,
						attempt: existingWorker.attempt,
						state: "leased" as const,
						idempotent: true,
						canonicalCwd: existing.canonicalCwd,
						createIdempotencyKey: existing.createIdempotencyKey,
						promptDigest: existing.promptDigest,
					},
				};
			}
			const summary = queueSummary(state.queue);
			if (!canAdmitWorker(summary)) return { value: null };
			// An explicit task selection must bind that exact task; falling back to the
			// queue's own ordering would give this prompt/workdir/worker to another task.
			const selected =
				input.taskId === undefined
					? selectNextTask(state.queue.tasks, state.queue.userDispatchStreak)
					: selectRequestedTask(state.queue.tasks, input.taskId);
			if (selected === null) {
				if (input.taskId === undefined) return { value: null };
				throw new MasterStoreError(
					"TASK_NOT_ADMISSIBLE",
					"Requested task is unknown or is not queued/retry-pending.",
				);
			}
			const timestamp = nowIso(this.#now);
			const canonicalCwd = input.canonicalCwd ?? selected.workdir ?? this.#defaultWorkdir;
			if (!isAbsoluteNormalizedPath(canonicalCwd) || !isPathWithin(this.#defaultWorkdir, canonicalCwd))
				throw new MasterStoreError(
					"INVALID_WORKDIR",
					"Worker canonicalCwd must be an absolute path under the master default workdir.",
				);
			const promptDigest =
				input.promptDigest ??
				sha256(canonicalJson({ taskId: selected.taskId, summary: selected.summary, canonicalCwd }));
			if (!FINGERPRINT_PATTERN.test(promptDigest))
				throw new MasterStoreError(
					"INVALID_INPUT",
					"promptDigest must be a 64-character lowercase SHA-256 digest.",
				);
			const leaseId = input.leaseId ?? randomUUID();
			const intentId = input.intentId ?? randomUUID();
			const createIdempotencyKey = input.createIdempotencyKey ?? `${this.masterName}:worker-create:${intentId}`;
			assertOpaqueId(leaseId, "leaseId");
			assertOpaqueId(intentId, "intentId");
			assertOpaqueId(createIdempotencyKey, "createIdempotencyKey");
			if (
				state.workers.intents.some(
					intent => intent.intentId === intentId || intent.createIdempotencyKey === createIdempotencyKey,
				)
			)
				throw new MasterStoreError("INTENT_EXISTS", "Worker create intent already exists.");
			selected.state = "leased";
			selected.workerSessionId = null;
			selected.leaseId = leaseId;
			selected.updatedAt = timestamp;
			const intent: WorkerCreateIntent = {
				intentId,
				masterName: this.masterName,
				taskId: selected.taskId,
				canonicalCwd,
				createIdempotencyKey,
				promptDigest,
				intendedOwner: { kind: "master", masterName: this.masterName },
				state: "reserved",
				promptIdempotencyKey: null,
				promptTurnId: null,
				followUps: [],
				createdAt: timestamp,
				updatedAt: timestamp,
			};
			const worker: WorkerLease = {
				leaseId,
				workerSessionId: null,
				intentId,
				taskId: selected.taskId,
				attempt: selected.attempt,
				state: "leased",
				lifecycle: null,
				promptIdempotencyKey: null,
				terminalState: null,
				createdAt: timestamp,
				updatedAt: timestamp,
				terminalAt: null,
				quarantine: [],
				observations: [],
				nextObservationSequence: 1,
			};
			state.workers.intents.push(intent);
			state.workers.workers.push(worker);
			state.queue.activeWorkerCount = countActiveWorkerLeases(state.workers.workers);
			state.queue.userDispatchStreak = nextUserDispatchStreak(state.queue.userDispatchStreak, selected);
			state.queue.queueRevision += 1;
			this.#syncDerived(state, timestamp);
			return {
				value: {
					leaseId,
					intentId,
					taskId: selected.taskId,
					workerSessionId: null,
					attempt: selected.attempt,
					state: "leased",
					idempotent: false,
					canonicalCwd,
					createIdempotencyKey,
					promptDigest,
				},
				event: {
					type: "queue_updated",
					payload: {
						action: "leased",
						cause: "dispatcher",
						task: taskSummary(selected) as TaskSummary & { state: "leased" },
						queue: queueSummary(state.queue),
					},
				},
			};
		});
	}

	async admit(
		input: {
			leaseId?: string;
			intentId?: string;
			canonicalCwd?: string;
			createIdempotencyKey?: string;
			promptDigest?: string;
		} = {},
	): Promise<LeaseReceipt | null> {
		return await this.admitNextTask(input);
	}

	async admitTask(
		input: {
			leaseId?: string;
			intentId?: string;
			canonicalCwd?: string;
			createIdempotencyKey?: string;
			promptDigest?: string;
		} = {},
	): Promise<LeaseReceipt | null> {
		return await this.admitNextTask(input);
	}

	async leaseNext(
		input: {
			leaseId?: string;
			intentId?: string;
			canonicalCwd?: string;
			createIdempotencyKey?: string;
			promptDigest?: string;
		} = {},
	): Promise<LeaseReceipt | null> {
		return await this.admitNextTask(input);
	}

	async reconcileCreate(input: WorkerCreateReconcileInput): Promise<WorkerCreateReceipt> {
		if (!isRecord(input))
			throw new MasterStoreError("INVALID_INPUT", "Create reconciliation input must be an object.");
		assertOpaqueId(input.intentId, "intentId");
		const workerSessionId =
			input.workerSessionId ??
			input.sessionId ??
			(isRecord(input.response)
				? typeof input.response.session_id === "string"
					? input.response.session_id
					: typeof input.response.sessionId === "string"
						? input.response.sessionId
						: undefined
				: undefined);
		if (workerSessionId !== undefined) assertOpaqueId(workerSessionId, "workerSessionId");
		const outcome = input.outcome ?? input.status;
		return await this.#withLock(async state => {
			const intent = state.workers.intents.find(candidate => candidate.intentId === input.intentId);
			if (intent === undefined)
				throw new MasterStoreError("INTENT_NOT_FOUND", `Worker create intent ${input.intentId} does not exist.`);
			const worker = state.workers.workers.find(candidate => candidate.intentId === intent.intentId);
			if (worker === undefined) throw new MasterStoreCorruptionError("Worker create intent has no capacity lease.");
			if (workerSessionId === undefined || outcome === "uncertain" || outcome === "unknown") {
				if (intent.state === "terminal") return { value: this.#workerCreateReceipt(worker, intent, false) };
				const timestamp = nowIso(this.#now);
				intent.state = "create_uncertain";
				intent.updatedAt = timestamp;
				return { value: this.#workerCreateReceipt(worker, intent, false), persist: true };
			}
			if (intent.state === "terminal")
				throw new MasterStoreError("WORKER_TERMINAL", "A terminal worker cannot be reconciled.");
			if (worker.workerSessionId === workerSessionId && worker.lifecycle !== null)
				return { value: this.#workerCreateReceipt(worker, intent, false) };
			if (worker.workerSessionId !== null && worker.workerSessionId !== workerSessionId)
				throw new MasterStoreError(
					"WORKER_SESSION_CONFLICT",
					"Worker create reconciliation returned a different session ID.",
				);
			const existingOwner = state.ownership.owners[workerSessionId];
			if (
				existingOwner !== undefined &&
				(existingOwner.kind !== "master" || existingOwner.masterName !== this.masterName)
			)
				throw new MasterStoreError("WORKER_OWNER_CONFLICT", `Worker ${workerSessionId} is already user-owned.`);
			const duplicate = state.workers.workers.find(
				candidate => candidate.workerSessionId === workerSessionId && candidate.intentId !== intent.intentId,
			);
			if (duplicate !== undefined)
				throw new MasterStoreError(
					"WORKER_SESSION_CONFLICT",
					`Worker ${workerSessionId} is already committed to another intent.`,
				);
			const task = state.queue.tasks.find(candidate => candidate.taskId === worker.taskId);
			if (task === undefined) throw new MasterStoreCorruptionError("Worker task is missing.");
			const timestamp = nowIso(this.#now);
			worker.workerSessionId = workerSessionId;
			worker.lifecycle = "owned_unprompted";
			worker.state = "assigned";
			worker.updatedAt = timestamp;
			task.workerSessionId = workerSessionId;
			task.state = "assigned";
			task.updatedAt = timestamp;
			intent.state = "created";
			intent.updatedAt = timestamp;
			state.ownership.owners[workerSessionId] = { kind: "master", masterName: this.masterName };
			state.queue.queueRevision += 1;
			this.#syncDerived(state, timestamp);
			return {
				value: this.#workerCreateReceipt(worker, intent, true),
				event: {
					type: "ownership_updated",
					payload: {
						action: "owner_assigned",
						cause: "worker_created",
						workerSessionId,
						previousOwner: null,
						nextOwner: { kind: "master", masterName: this.masterName },
					},
				},
			};
		});
	}

	async reconcileWorkerCreate(input: WorkerCreateReconcileInput): Promise<WorkerCreateReceipt> {
		return await this.reconcileCreate(input);
	}

	async commitCoordinatorCreate(input: WorkerCreateReconcileInput): Promise<WorkerCreateReceipt> {
		return await this.reconcileCreate(input);
	}

	async markCreateUncertain(intentId: string): Promise<WorkerCreateReceipt> {
		return await this.reconcileCreate({ intentId, outcome: "uncertain" });
	}

	async markPromptPending(input: PromptPendingInput): Promise<PromptPendingReceipt> {
		if (!isRecord(input)) throw new MasterStoreError("INVALID_INPUT", "Prompt pending input must be an object.");
		if (input.leaseId !== undefined) assertOpaqueId(input.leaseId, "leaseId");
		if (input.intentId !== undefined) assertOpaqueId(input.intentId, "intentId");
		if (input.leaseId === undefined && input.intentId === undefined)
			throw new MasterStoreError("INVALID_INPUT", "Prompt pending requires leaseId or intentId.");
		if (input.promptIdempotencyKey !== undefined) assertOpaqueId(input.promptIdempotencyKey, "promptIdempotencyKey");
		return await this.#withLock(async state => {
			const worker =
				input.leaseId === undefined
					? state.workers.workers.find(candidate => candidate.intentId === input.intentId)
					: state.workers.workers.find(candidate => candidate.leaseId === input.leaseId);
			if (worker === undefined) throw new MasterStoreError("LEASE_NOT_FOUND", "Worker lease does not exist.");
			const intent = state.workers.intents.find(candidate => candidate.intentId === worker.intentId);
			if (intent === undefined) throw new MasterStoreCorruptionError("Worker lease intent is missing.");
			if (worker.workerSessionId === null || worker.lifecycle === null)
				throw new MasterStoreError(
					"WORKER_NOT_CREATED",
					"Prompt cannot be sent before Coordinator returns a session ID.",
				);
			if (
				intent.promptIdempotencyKey !== null &&
				input.promptIdempotencyKey !== undefined &&
				intent.promptIdempotencyKey !== input.promptIdempotencyKey
			)
				throw new MasterIdempotencyConflictError(intent.promptIdempotencyKey);
			if (intent.state === "terminal" || worker.lifecycle === "terminal")
				throw new MasterStoreError("WORKER_TERMINAL", "A terminal worker cannot receive a prompt.");
			if (worker.lifecycle === "active" || worker.lifecycle === "prompt_pending")
				return { value: this.#promptPendingReceipt(worker, intent) };
			if (worker.lifecycle !== "owned_unprompted")
				throw new MasterStoreError("INVALID_WORKER_LIFECYCLE", "Worker is not ready for prompt delivery.");
			const timestamp = nowIso(this.#now);
			const promptIdempotencyKey = input.promptIdempotencyKey ?? `master:worker-prompt:${intent.intentId}`;
			assertOpaqueId(promptIdempotencyKey, "promptIdempotencyKey");
			intent.promptIdempotencyKey = promptIdempotencyKey;
			intent.state = "prompt_pending";
			intent.updatedAt = timestamp;
			worker.lifecycle = "prompt_pending";
			worker.updatedAt = timestamp;
			return { value: this.#promptPendingReceipt(worker, intent), persist: true };
		});
	}

	async beginPrompt(input: PromptPendingInput): Promise<PromptPendingReceipt> {
		return await this.markPromptPending(input);
	}

	async reconcilePrompt(input: PromptReconcileInput): Promise<PromptReconcileReceipt> {
		if (!isRecord(input))
			throw new MasterStoreError("INVALID_INPUT", "Prompt reconciliation input must be an object.");
		if (input.leaseId !== undefined) assertOpaqueId(input.leaseId, "leaseId");
		if (input.intentId !== undefined) assertOpaqueId(input.intentId, "intentId");
		if (input.leaseId === undefined && input.intentId === undefined)
			throw new MasterStoreError("INVALID_INPUT", "Prompt reconciliation requires leaseId or intentId.");
		if (typeof input.proven !== "boolean")
			throw new MasterStoreError("INVALID_INPUT", "Prompt reconciliation requires proven delivery evidence.");
		if (input.promptIdempotencyKey !== undefined) assertOpaqueId(input.promptIdempotencyKey, "promptIdempotencyKey");
		if (input.promptTurnId !== undefined) assertOpaqueId(input.promptTurnId, "promptTurnId");
		return await this.#withLock(async state => {
			const worker =
				input.leaseId === undefined
					? state.workers.workers.find(candidate => candidate.intentId === input.intentId)
					: state.workers.workers.find(candidate => candidate.leaseId === input.leaseId);
			if (worker === undefined) throw new MasterStoreError("LEASE_NOT_FOUND", "Worker lease does not exist.");
			const intent = state.workers.intents.find(candidate => candidate.intentId === worker.intentId);
			if (intent === undefined) throw new MasterStoreCorruptionError("Worker lease intent is missing.");
			if (input.promptIdempotencyKey !== undefined && intent.promptIdempotencyKey !== input.promptIdempotencyKey)
				throw new MasterIdempotencyConflictError(input.promptIdempotencyKey);
			if (!input.proven)
				return {
					value: { ...this.#promptReconcileReceipt(worker, intent, false, []), proven: false, drained: [] },
				};
			if (worker.lifecycle === "active") return { value: this.#promptReconcileReceipt(worker, intent, true, []) };
			if (worker.lifecycle !== "prompt_pending" || intent.promptIdempotencyKey === null)
				throw new MasterStoreError(
					"PROMPT_NOT_PENDING",
					"Prompt delivery cannot activate this worker before a durable prompt-pending key.",
				);
			const timestamp = nowIso(this.#now);
			const drained = clone(worker.quarantine);
			worker.quarantine = [];
			worker.lifecycle = "active";
			worker.updatedAt = timestamp;
			intent.state = "active";
			// Retain the proven turn so observation still works after a restart.
			if (input.promptTurnId !== undefined) intent.promptTurnId = input.promptTurnId;
			intent.updatedAt = timestamp;
			return { value: this.#promptReconcileReceipt(worker, intent, true, drained), persist: true };
		});
	}

	async reconcileWorkerPrompt(input: PromptReconcileInput): Promise<PromptReconcileReceipt> {
		return await this.reconcilePrompt(input);
	}
	async reconcilePromptDelivery(input: PromptReconcileInput): Promise<PromptReconcileReceipt> {
		return await this.reconcilePrompt(input);
	}
	async recordFollowUpIntent(input: {
		workerSessionId: string;
		prompt: string;
		idempotencyKey: string;
	}): Promise<{ idempotencyKey: string; state: "pending" | "delivered" | "uncertain" }> {
		assertOpaqueId(input.workerSessionId, "workerSessionId");
		assertOpaqueId(input.idempotencyKey, "idempotencyKey");
		if (typeof input.prompt !== "string" || input.prompt.length === 0)
			throw new MasterStoreError("INVALID_INPUT", "Follow-up prompt must be non-empty.");
		const promptDigest = sha256(input.prompt);
		return await this.#withLock(async state => {
			const worker = state.workers.workers.find(candidate => candidate.workerSessionId === input.workerSessionId);
			if (worker === undefined || worker.lifecycle !== "active")
				throw new MasterStoreError("WORKER_NOT_ACTIVE", "Follow-up target is not an active master-owned worker.");
			const intent = state.workers.intents.find(candidate => candidate.intentId === worker.intentId);
			if (intent === undefined) throw new MasterStoreCorruptionError("Active worker intent is missing.");
			const existing = intent.followUps.find(candidate => candidate.idempotencyKey === input.idempotencyKey);
			if (existing) {
				if (existing.promptDigest !== promptDigest) throw new MasterIdempotencyConflictError(input.idempotencyKey);
				return { value: { idempotencyKey: existing.idempotencyKey, state: existing.state } };
			}
			const timestamp = nowIso(this.#now);
			intent.followUps.push({
				idempotencyKey: input.idempotencyKey,
				promptDigest,
				state: "pending",
				createdAt: timestamp,
				updatedAt: timestamp,
			});
			intent.updatedAt = timestamp;
			return { value: { idempotencyKey: input.idempotencyKey, state: "pending" as const }, persist: true };
		});
	}

	async reconcileFollowUpIntent(input: {
		workerSessionId: string;
		idempotencyKey: string;
		proven: boolean;
	}): Promise<{ idempotencyKey: string; state: "delivered" | "uncertain" }> {
		assertOpaqueId(input.workerSessionId, "workerSessionId");
		assertOpaqueId(input.idempotencyKey, "idempotencyKey");
		return await this.#withLock(async state => {
			const worker = state.workers.workers.find(candidate => candidate.workerSessionId === input.workerSessionId);
			if (worker === undefined) throw new MasterStoreError("WORKER_NOT_FOUND", "Follow-up target is unknown.");
			const intent = state.workers.intents.find(candidate => candidate.intentId === worker.intentId);
			const followUp = intent?.followUps.find(candidate => candidate.idempotencyKey === input.idempotencyKey);
			if (followUp === undefined) throw new MasterStoreError("FOLLOW_UP_NOT_FOUND", "Follow-up intent is unknown.");
			const nextState = input.proven ? "delivered" : "uncertain";
			if (followUp.state !== nextState) {
				followUp.state = nextState;
				followUp.updatedAt = nowIso(this.#now);
			}
			return { value: { idempotencyKey: followUp.idempotencyKey, state: nextState }, persist: true };
		});
	}
	async activateWorker(input: {
		leaseId?: string;
		intentId?: string;
		promptIdempotencyKey?: string;
	}): Promise<PromptReconcileReceipt> {
		return await this.reconcilePrompt({ ...input, proven: true });
	}

	async observe(input: ObserveWorkerInput): Promise<WorkerObservationReceipt> {
		if (!isRecord(input)) throw new MasterStoreError("INVALID_INPUT", "Worker observation input must be an object.");
		assertOpaqueId(input.workerSessionId, "workerSessionId");
		if (input.observationId !== undefined) assertOpaqueId(input.observationId, "observationId");
		return await this.#withLock<WorkerObservationReceipt>(async state => {
			const owner = state.ownership.owners[input.workerSessionId];
			if (owner === undefined)
				throw new MasterStoreError("WORKER_OWNER_UNKNOWN", `Worker ${input.workerSessionId} has no durable owner.`);
			const observationId = input.observationId ?? randomUUID();
			if (owner.kind === "user")
				return {
					value: {
						workerSessionId: input.workerSessionId,
						observationId,
						sequence: 0,
						disposition: "user" as const,
						owner: { kind: "user" } as const,
						quarantineId: null,
						event: clone(input.event),
					},
				};
			const worker = state.workers.workers.find(candidate => candidate.workerSessionId === input.workerSessionId);
			if (worker === undefined || worker.lifecycle === null)
				throw new MasterStoreCorruptionError("Master-owned worker has no durable lifecycle.");
			if (worker.lifecycle === "terminal")
				throw new MasterStoreError("WORKER_TERMINAL", "Terminal workers cannot accept observations.");
			const timestamp = nowIso(this.#now);
			const sequence = worker.nextObservationSequence;
			worker.nextObservationSequence += 1;
			const observation: WorkerObservation = {
				observationId,
				sequence,
				occurredAt: timestamp,
				event: clone(input.event),
			};
			if (worker.lifecycle === "owned_unprompted" || worker.lifecycle === "prompt_pending") {
				worker.quarantine.push(observation);
				worker.updatedAt = timestamp;
				return {
					value: {
						workerSessionId: input.workerSessionId,
						observationId,
						sequence,
						disposition: "quarantined" as const,
						owner: { kind: "master", masterName: this.masterName },
						quarantineId: `quarantine:${sha256(`${input.workerSessionId}:${sequence}:${observationId}`).slice(0, 32)}`,
						event: clone(input.event),
					},
					persist: true,
				};
			}
			worker.observations.push(observation);
			worker.updatedAt = timestamp;
			return {
				value: {
					workerSessionId: input.workerSessionId,
					observationId,
					sequence,
					disposition: "master" as const,
					owner: { kind: "master", masterName: this.masterName },
					quarantineId: null,
					event: clone(input.event),
				},
				persist: true,
			};
		});
	}

	async observeWorker(input: ObserveWorkerInput): Promise<WorkerObservationReceipt> {
		return await this.observe(input);
	}

	async recordWorkerObservation(input: ObserveWorkerInput): Promise<WorkerObservationReceipt> {
		return await this.observe(input);
	}
	async recordWorkerEvent(input: ObserveWorkerInput): Promise<WorkerObservationReceipt> {
		return await this.observe(input);
	}

	async registerUserWorker(input: string | { workerSessionId: string }): Promise<UserWorkerReceipt> {
		const workerSessionId = typeof input === "string" ? input : input.workerSessionId;
		assertOpaqueId(workerSessionId, "workerSessionId");
		return await this.#withLock(async state => {
			const existing = state.ownership.owners[workerSessionId];
			if (existing !== undefined) {
				if (existing.kind !== "user")
					throw new MasterStoreError(
						"WORKER_OWNER_CONFLICT",
						`Worker ${workerSessionId} is already master-owned.`,
					);
				return {
					value: { workerSessionId, owner: { kind: "user" } as const, lifecycle: "user_registered" as const },
				};
			}
			if (state.workers.workers.some(worker => worker.workerSessionId === workerSessionId))
				throw new MasterStoreError("WORKER_OWNER_CONFLICT", `Worker ${workerSessionId} is already master-owned.`);
			state.ownership.owners[workerSessionId] = { kind: "user" };
			return {
				value: { workerSessionId, owner: { kind: "user" } as const, lifecycle: "user_registered" as const },
				event: {
					type: "ownership_updated",
					payload: {
						action: "owner_assigned",
						cause: "user_registered",
						workerSessionId,
						previousOwner: null,
						nextOwner: { kind: "user" },
					},
				},
			};
		});
	}

	async registerUserSession(input: string | { workerSessionId: string }): Promise<UserWorkerReceipt> {
		return await this.registerUserWorker(input);
	}

	async assignWorker(_leaseId: string): Promise<LeaseReceipt> {
		throw new MasterStoreError(
			"UNSAFE_OWNER_COMMIT",
			"A worker owner cannot be committed without the actual Coordinator session ID.",
		);
	}

	async commitWorkerOwner(_leaseId: string): Promise<LeaseReceipt> {
		throw new MasterStoreError(
			"UNSAFE_OWNER_COMMIT",
			"A worker owner cannot be committed without the actual Coordinator session ID.",
		);
	}

	async releaseWorker(input: ReleaseWorkerInput): Promise<ReleaseReceipt> {
		if (input.leaseId !== undefined) assertOpaqueId(input.leaseId, "leaseId");
		if (input.taskId !== undefined) assertOpaqueId(input.taskId, "taskId");
		if (input.workerSessionId !== undefined) assertOpaqueId(input.workerSessionId, "workerSessionId");
		const terminalState = input.state ?? "completed";
		if (terminalState !== "completed" && terminalState !== "failed" && terminalState !== "blocked")
			throw new MasterStoreError("INVALID_INPUT", "Invalid terminal state.");
		return await this.#withLock(async state => {
			const worker = state.workers.workers.find(
				candidate =>
					(input.leaseId !== undefined && candidate.leaseId === input.leaseId) ||
					(input.taskId !== undefined && candidate.taskId === input.taskId) ||
					(input.workerSessionId !== undefined && candidate.workerSessionId === input.workerSessionId),
			);
			if (worker === undefined) throw new MasterStoreError("LEASE_NOT_FOUND", "Worker lease does not exist.");
			const existing = state.queue.releaseReceipts[worker.leaseId];
			if (worker.state === "terminal") {
				if (existing !== undefined) return { value: { ...existing, alreadyReleased: true } };
				if (worker.terminalState === null)
					throw new MasterStoreCorruptionError("Terminal worker has no release receipt.");
				const task = state.queue.tasks.find(candidate => candidate.taskId === worker.taskId);
				if (task === undefined) throw new MasterStoreCorruptionError("Worker task is missing.");
				return {
					value: {
						leaseId: worker.leaseId,
						taskId: worker.taskId,
						workerSessionId: worker.workerSessionId,
						state: worker.terminalState,
						activeWorkerCount: state.queue.activeWorkerCount,
						alreadyReleased: true,
					},
				};
			}
			const task = state.queue.tasks.find(candidate => candidate.taskId === worker.taskId);
			if (task === undefined) throw new MasterStoreCorruptionError("Worker task is missing.");
			const timestamp = nowIso(this.#now);
			const intent = state.workers.intents.find(candidate => candidate.intentId === worker.intentId);
			if (intent === undefined) throw new MasterStoreCorruptionError("Worker lease intent is missing.");

			worker.state = "terminal";
			worker.terminalState = terminalState;
			worker.terminalAt = timestamp;
			worker.updatedAt = timestamp;
			worker.lifecycle = worker.workerSessionId === null ? null : "terminal";
			intent.state = "terminal";
			intent.updatedAt = timestamp;
			task.state = terminalState;
			task.updatedAt = timestamp;
			state.queue.activeWorkerCount = countActiveWorkerLeases(state.workers.workers);
			state.queue.queueRevision += 1;
			this.#syncDerived(state, timestamp);
			const receipt: ReleaseReceipt = {
				leaseId: worker.leaseId,
				taskId: task.taskId,
				workerSessionId: worker.workerSessionId,
				state: terminalState,
				activeWorkerCount: state.queue.activeWorkerCount,
				alreadyReleased: false,
			};
			state.queue.releaseReceipts[worker.leaseId] = receipt;
			const payload =
				terminalState === "failed"
					? {
							action: "failed" as const,
							cause: "worker_terminal" as const,
							task: taskSummary(task) as TaskSummary & { state: "failed" },
							queue: queueSummary(state.queue),
							reason: input.reason ?? "worker_failed",
						}
					: terminalState === "blocked"
						? {
								action: "blocked" as const,
								cause: "coordinator" as const,
								task: taskSummary(task) as TaskSummary & { state: "blocked" },
								queue: queueSummary(state.queue),
								reason: input.reason ?? "worker_blocked",
							}
						: {
								action: "completed" as const,
								cause: "worker_terminal" as const,
								task: taskSummary(task) as TaskSummary & { state: "completed" },
								queue: queueSummary(state.queue),
							};
			return { value: receipt, event: { type: "queue_updated", payload } };
		});
	}

	async release(input: ReleaseWorkerInput): Promise<ReleaseReceipt> {
		return await this.releaseWorker(input);
	}

	async releaseLease(input: ReleaseWorkerInput): Promise<ReleaseReceipt> {
		return await this.releaseWorker(input);
	}

	async terminalRelease(input: ReleaseWorkerInput): Promise<ReleaseReceipt> {
		return await this.releaseWorker(input);
	}

	async completeWorker(leaseId: string): Promise<ReleaseReceipt> {
		return await this.releaseWorker({ leaseId, state: "completed" });
	}

	async failWorker(leaseId: string, reason?: string): Promise<ReleaseReceipt> {
		return await this.releaseWorker({ leaseId, state: "failed", reason });
	}

	async retryTask(taskId: string, reason = "retry_requested"): Promise<TaskSummary> {
		assertOpaqueId(taskId, "taskId");
		assertNonEmptyText(reason, "reason", 4096);
		return await this.#withLock(async state => {
			const task = state.queue.tasks.find(candidate => candidate.taskId === taskId);
			if (task === undefined) throw new MasterStoreError("TASK_NOT_FOUND", `Task ${taskId} does not exist.`);
			if (task.state !== "failed" && task.state !== "blocked")
				throw new MasterStoreError("INVALID_TASK_STATE", "Only terminal tasks can be retried.");
			const timestamp = nowIso(this.#now);
			const nextTaskId = randomUUID();
			const nextAttempt = task.attempt + 1;
			const existingRetry = state.queue.tasks.find(
				candidate =>
					candidate.taskId !== task.taskId &&
					(candidate.logicalTaskId ?? candidate.taskId) === (task.logicalTaskId ?? task.taskId) &&
					candidate.attempt === nextAttempt,
			);
			if (existingRetry !== undefined) return { value: clone(taskSummary(existingRetry)) };
			const nextTask: TaskRecord = {
				taskId: nextTaskId,
				logicalTaskId: task.logicalTaskId ?? task.taskId,
				enqueueSeq: state.queue.nextEnqueueSeq,
				priority: task.priority,
				source: task.source,
				state: "retry_pending",
				attempt: nextAttempt,
				summary: task.summary,
				createdAt: timestamp,
				updatedAt: timestamp,
				workerSessionId: null,
				idempotencyKey: `retry:${task.taskId}:${nextAttempt}:${randomUUID()}`,
				bodyDigest: task.bodyDigest,
				leaseId: null,
				workdir: task.workdir,
			};
			state.queue.tasks.push(nextTask);
			state.queue.nextEnqueueSeq += 1;
			state.queue.queueRevision += 1;
			this.#syncDerived(state, timestamp);
			return {
				value: clone(taskSummary(nextTask)),
				event: {
					type: "queue_updated",
					payload: {
						action: "retry_scheduled",
						cause: "worker_terminal",
						task: taskSummary(nextTask) as TaskSummary & { state: "retry_pending" },
						queue: queueSummary(state.queue),
						reason,
					},
				},
			};
		});
	}

	async configureMaxConcurrentWorkers(maxConcurrentWorkers: number): Promise<ConfigureCapacityResult> {
		assertPositiveSafeInteger(maxConcurrentWorkers, "maxConcurrentWorkers");
		return await this.#withLock(async state => {
			const previousMaxConcurrentWorkers = state.queue.maxConcurrentWorkers;
			if (previousMaxConcurrentWorkers === maxConcurrentWorkers)
				return {
					value: {
						previousMaxConcurrentWorkers,
						maxConcurrentWorkers,
						capacityState: state.queue.capacityState,
						activeWorkerCount: state.queue.activeWorkerCount,
					},
				};
			const timestamp = nowIso(this.#now);
			state.queue.maxConcurrentWorkers = maxConcurrentWorkers;
			state.queue.capacityState = computeCapacityState(state.queue.activeWorkerCount, maxConcurrentWorkers);
			state.queue.queueRevision += 1;
			this.#syncDerived(state, timestamp);
			return {
				value: {
					previousMaxConcurrentWorkers,
					maxConcurrentWorkers,
					capacityState: state.queue.capacityState,
					activeWorkerCount: state.queue.activeWorkerCount,
				},
				event: {
					type: "queue_updated",
					payload: {
						action: "capacity_reconfigured",
						cause: "operator",
						previousMaxConcurrentWorkers,
						queue: queueSummary(state.queue),
					},
				},
			};
		});
	}

	async configure(maxConcurrentWorkers: number): Promise<ConfigureCapacityResult> {
		return await this.configureMaxConcurrentWorkers(maxConcurrentWorkers);
	}

	async configureCapacity(maxConcurrentWorkers: number): Promise<ConfigureCapacityResult> {
		return await this.configureMaxConcurrentWorkers(maxConcurrentWorkers);
	}

	async setMaxConcurrentWorkers(maxConcurrentWorkers: number): Promise<ConfigureCapacityResult> {
		return await this.configureMaxConcurrentWorkers(maxConcurrentWorkers);
	}

	async snapshot(): Promise<MasterSnapshot> {
		return await this.#withLock(async state => {
			const workers = state.workers.workers
				.filter(worker => worker.workerSessionId !== null)
				.map(worker => {
					if (worker.workerSessionId === null || worker.lifecycle === null)
						throw new MasterStoreCorruptionError("Committed worker has no session lifecycle.");
					const owner = state.ownership.owners[worker.workerSessionId];
					if (owner === undefined) throw new MasterStoreCorruptionError("Committed worker has no owner.");
					return {
						workerSessionId: worker.workerSessionId,
						owner,
						lifecycle: worker.lifecycle,
						taskId: worker.taskId,
					};
				});
			const recentDecisions = state.events
				.filter(event => event.type === "decision_logged")
				.slice(-32)
				.map(event => {
					if (event.type !== "decision_logged")
						throw new MasterStoreCorruptionError("Decision event narrowing failed.");
					return {
						decisionId: event.payload.decisionId,
						outcome: event.payload.outcome,
						occurredAt: event.occurredAt,
						reason: event.payload.reason,
					};
				});
			const latestStatusEvent = [...state.events]
				.reverse()
				.find(event => event.type === "master_status" && event.payload.transition === "state_changed");
			const latestMemoryEvent = [...state.events].reverse().find(event => event.type === "memory_activity");
			const latestStatus =
				latestStatusEvent?.type === "master_status" && latestStatusEvent.payload.transition === "state_changed"
					? latestStatusEvent
					: null;
			const latestMemory = latestMemoryEvent?.type === "memory_activity" ? latestMemoryEvent.payload.activity : null;
			const statusSince = latestStatus?.occurredAt ?? state.record.updatedAt;
			const providerHealth = this.#providerHealth(state);
			return {
				value: {
					masterName: state.record.masterName,
					defaultWorkdir: state.record.defaultWorkdir,
					status: latestStatus?.payload.status ?? (providerHealth.operational ? "idle" : "channel_blocked"),
					statusSince,
					providerHealth,
					queue: queueSummary(state.queue),
					workerCount: workers.length,
					workers,
					workersTruncated: false,
					channels: clone(state.channels.channels),
					recentDecisions,
					memory: {
						availability:
							latestStatus?.payload.transition === "state_changed"
								? (latestStatus.payload.memoryAvailability ??
									(latestMemory === null ? "unavailable" : "available"))
								: latestMemory === null
									? "unavailable"
									: "available",
						latestActivity: latestMemory === null ? null : clone(latestMemory),
					},
				},
			};
		});
	}

	async readSnapshot(): Promise<MasterSnapshot> {
		return await this.snapshot();
	}

	async enqueueUser(input: Omit<EnqueueTaskInput, "source">): Promise<EnqueueReceipt> {
		return await this.enqueueTask({ ...input, source: "user" });
	}

	async enqueueAutonomous(input: Omit<EnqueueTaskInput, "source" | "priority">): Promise<EnqueueReceipt> {
		return await this.enqueueTask({ ...input, source: "master", priority: "autonomous" });
	}

	async readClaims(): Promise<MasterClaimsDocument> {
		return await this.#withLock(async state => ({ value: clone(state.claims) }));
	}

	async mint(input: ClaimAuthorizationMintInput): Promise<ClaimRequestAuthorization> {
		return await this.mintClaimAuthorization(input);
	}

	async mintClaimAuthorization(input: ClaimAuthorizationMintInput): Promise<ClaimRequestAuthorization> {
		if (!isRecord(input)) throw new MasterStoreError("INVALID_INPUT", "Claim authorization input must be an object.");
		assertOpaqueId(input.workerSessionId, "workerSessionId");
		assertCanonicalMasterName(input.requestedMasterName);
		if (input.requestedMasterName !== this.masterName)
			throw new MasterStoreError("MASTER_MISMATCH", "Claim authorization targets another master.");
		assertIngress(input.ingress, "ingress");
		if (input.ingress.kind !== "provider")
			throw new MasterStoreError("INVALID_INGRESS", "Claims require provider ingress.");
		if (
			input.ttlMs !== undefined &&
			(!Number.isSafeInteger(input.ttlMs) || input.ttlMs < 1 || input.ttlMs > MAX_CLAIM_TTL_MS)
		)
			throw new MasterStoreError("INVALID_INPUT", "Claim authorization TTL is invalid.");
		if (input.expiresAt !== undefined) assertTimestamp(input.expiresAt, "expiresAt");
		if (input.idempotencyKey !== undefined) assertOpaqueId(input.idempotencyKey, "idempotencyKey");
		return await this.#withLock(async state => {
			this.#assertActiveProviderIngress(state, input.ingress);
			const timestamp = nowIso(this.#now);
			const expiresAt = input.expiresAt ?? new Date(Date.parse(timestamp) + (input.ttlMs ?? 300_000)).toISOString();
			if (Date.parse(expiresAt) <= Date.parse(timestamp))
				throw new MasterStoreError(
					"CLAIM_AUTHORIZATION_EXPIRED",
					"Claim authorization expiry must be in the future.",
				);
			// The digest must cover only caller-supplied request identity. A retry after a
			// lost acknowledgement carries the same idempotency key but arrives later, so
			// folding a server-generated expiry in here would turn a safe replay into an
			// idempotency conflict. Caller-supplied expiry/TTL stays part of the request.
			const digest = sha256(
				canonicalJson({
					workerSessionId: input.workerSessionId,
					requestedMasterName: input.requestedMasterName,
					ingress: input.ingress,
					expiresAt: input.expiresAt ?? null,
					ttlMs: input.ttlMs ?? null,
				}),
			);
			if (input.idempotencyKey !== undefined) {
				const prior = state.claims.mintIdempotency[input.idempotencyKey];
				if (prior !== undefined) {
					if (prior.digest !== digest) throw new MasterIdempotencyConflictError(input.idempotencyKey);
					const authorization = state.claims.authorizations[prior.authorizationId];
					if (authorization === undefined)
						throw new MasterStoreCorruptionError("Claim idempotency references a missing authorization.");
					return { value: clone(authorization) };
				}
			}
			const authorization: ClaimRequestAuthorization = {
				authorizationId: randomUUID(),
				workerSessionId: input.workerSessionId,
				requestedMasterName: this.masterName,
				ingress: clone(input.ingress),
				actorId: input.ingress.actorId,
				channelId: input.ingress.channelId,
				messageId: input.ingress.messageId,
				issuedAt: timestamp,
				expiresAt,
				state: "unused",
			};
			state.claims.authorizations[authorization.authorizationId] = authorization;
			if (input.idempotencyKey !== undefined)
				state.claims.mintIdempotency[input.idempotencyKey] = {
					digest,
					authorizationId: authorization.authorizationId,
				};
			return { value: clone(authorization), persist: true };
		});
	}

	async requestClaimAuthorization(input: ClaimAuthorizationMintInput): Promise<ClaimRequestAuthorization> {
		return await this.mintClaimAuthorization(input);
	}

	async consumeClaimAuthorization(input: ModelClaimRequestInput): Promise<OwnershipClaim> {
		if (!isRecord(input)) throw new MasterStoreError("INVALID_INPUT", "Claim request input must be an object.");
		if (input.actorKind !== undefined && input.actorKind !== "model")
			throw new MasterStoreError(
				"CLAIM_REQUEST_ACTOR_INVALID",
				"Claim request consumption is reserved for the model path.",
			);
		assertOpaqueId(input.authorizationId, "authorizationId");
		assertOpaqueId(input.workerSessionId, "workerSessionId");
		assertCanonicalMasterName(input.requestedMasterName);
		if (input.requestedMasterName !== this.masterName)
			throw new MasterStoreError("MASTER_MISMATCH", "Claim request targets another master.");
		const result = await this.#withLock<OwnershipClaim | { expired: true }>(async state => {
			const authorization = state.claims.authorizations[input.authorizationId];
			if (authorization === undefined)
				throw new MasterStoreError("CLAIM_AUTHORIZATION_INVALID", "Claim authorization is unknown or forged.");
			const timestamp = nowIso(this.#now);
			if (Date.parse(authorization.expiresAt) <= Date.parse(timestamp)) {
				authorization.state = "expired";
				return { value: { expired: true }, persist: true };
			}
			if (authorization.state !== "unused")
				throw new MasterStoreError("CLAIM_AUTHORIZATION_CONSUMED", "Claim authorization was already consumed.");
			if (
				authorization.workerSessionId !== input.workerSessionId ||
				authorization.requestedMasterName !== this.masterName
			)
				throw new MasterStoreError(
					"CLAIM_AUTHORIZATION_MISMATCH",
					"Claim authorization target does not match the requested worker/master.",
				);
			const previousOwner = state.ownership.owners[input.workerSessionId] ?? { kind: "user" as const };
			const claim: OwnershipClaim = {
				claimId: randomUUID(),
				authorizationId: authorization.authorizationId,
				workerSessionId: authorization.workerSessionId,
				requestedMasterName: authorization.requestedMasterName,
				requestIngress: clone(authorization.ingress),
				requestedAt: timestamp,
				expiresAt: authorization.expiresAt,
				previousOwner: clone(previousOwner),
				status: "pending_approval",
				approvalIngress: null,
				approvedAt: null,
			};
			authorization.state = "consumed";
			state.claims.claims[claim.claimId] = claim;
			return {
				value: clone(claim),
				persist: true,
				event: {
					type: "ownership_updated",
					payload: {
						action: "claim_requested",
						workerSessionId: claim.workerSessionId,
						claimId: claim.claimId,
						authorizationId: claim.authorizationId,
						requestedMasterName: claim.requestedMasterName,
						previousOwner: claim.previousOwner,
						nextOwner: claim.previousOwner,
						expiresAt: claim.expiresAt,
					},
				},
			};
		});
		if ("expired" in result)
			throw new MasterStoreError("CLAIM_AUTHORIZATION_EXPIRED", "Claim authorization has expired.");
		return result;
	}

	async requestClaim(input: ModelClaimRequestInput): Promise<OwnershipClaim> {
		return await this.consumeClaimAuthorization(input);
	}

	async consumeForModel(input: ModelClaimRequestInput): Promise<OwnershipClaim> {
		return await this.consumeClaimAuthorization(input);
	}

	async approveClaim(input: ClaimApprovalInput): Promise<ClaimApprovalResult> {
		if (!isRecord(input)) throw new MasterStoreError("INVALID_INPUT", "Claim approval input must be an object.");
		if (
			input.actorKind === "model" ||
			(input.actorKind !== undefined && input.actorKind !== "user") ||
			input.authenticated !== true
		)
			throw new MasterStoreError(
				"CLAIM_APPROVAL_FORBIDDEN",
				"Only authenticated users may approve ownership claims.",
			);
		assertOpaqueId(input.claimId, "claimId");
		assertIngress(input.ingress, "ingress");
		if (input.ingress.kind !== "provider")
			throw new MasterStoreError("INVALID_INGRESS", "Claim approval requires provider ingress.");
		if (input.idempotencyKey !== undefined) assertOpaqueId(input.idempotencyKey, "idempotencyKey");
		const result = await this.#withLock<ClaimApprovalResult | { expired: true }>(async state => {
			this.#assertActiveProviderIngress(state, input.ingress);
			const claim = state.claims.claims[input.claimId];
			if (claim === undefined) throw new MasterStoreError("CLAIM_NOT_FOUND", "Ownership claim is unknown.");
			const digest = sha256(canonicalJson({ claimId: input.claimId, ingress: input.ingress }));
			if (input.idempotencyKey !== undefined) {
				const prior = state.claims.approvalIdempotency[input.idempotencyKey];
				if (prior !== undefined) {
					if (prior.digest !== digest) throw new MasterIdempotencyConflictError(input.idempotencyKey);
					return { value: clone(prior.result) };
				}
			}
			const timestamp = nowIso(this.#now);
			if (Date.parse(claim.expiresAt) <= Date.parse(timestamp)) {
				claim.status = "expired";
				return { value: { expired: true }, persist: true };
			}
			if (
				claim.requestIngress.provider !== input.ingress.provider ||
				claim.requestIngress.channelId !== input.ingress.channelId ||
				claim.requestIngress.actorId !== input.ingress.actorId
			)
				throw new MasterStoreError(
					"CLAIM_APPROVAL_ACTOR_MISMATCH",
					"Claim approval actor/channel does not match the requesting actor.",
				);
			if (claim.requestIngress.messageId === input.ingress.messageId)
				throw new MasterStoreError(
					"CLAIM_APPROVAL_NOT_DISTINCT",
					"Claim approval must use a distinct authenticated interaction.",
				);
			if (claim.status === "approved") {
				const result: ClaimApprovalResult = {
					claimId: claim.claimId,
					status: "already_approved",
					owner: { kind: "master", masterName: claim.requestedMasterName },
				};
				if (input.idempotencyKey !== undefined)
					state.claims.approvalIdempotency[input.idempotencyKey] = { digest, result };
				return { value: clone(result), persist: input.idempotencyKey !== undefined };
			}
			if (claim.status !== "pending_approval")
				throw new MasterStoreError("CLAIM_NOT_PENDING", "Ownership claim is not awaiting approval.");
			const currentOwner = state.ownership.owners[claim.workerSessionId];
			if (currentOwner !== undefined && !sameOwner(currentOwner, claim.previousOwner))
				throw new MasterStoreError("CLAIM_OWNER_CONFLICT", "Worker ownership changed before claim approval.");
			const nextOwner = { kind: "master" as const, masterName: claim.requestedMasterName };
			state.ownership.owners[claim.workerSessionId] = nextOwner;
			claim.status = "approved";
			claim.approvalIngress = clone(input.ingress);
			claim.approvedAt = timestamp;
			const result: ClaimApprovalResult = { claimId: claim.claimId, status: "approved", owner: nextOwner };
			if (input.idempotencyKey !== undefined)
				state.claims.approvalIdempotency[input.idempotencyKey] = { digest, result };
			return {
				value: clone(result),
				persist: true,
				event: {
					type: "ownership_updated",
					payload: {
						action: "claim_approved",
						workerSessionId: claim.workerSessionId,
						claimId: claim.claimId,
						approvalActorId: input.ingress.actorId,
						previousOwner: claim.previousOwner,
						nextOwner,
					},
				},
			};
		});
		if ("expired" in result)
			throw new MasterStoreError("CLAIM_AUTHORIZATION_EXPIRED", "Ownership claim has expired.");
		return result;
	}

	async approve(input: ClaimApprovalInput): Promise<ClaimApprovalResult> {
		return await this.approveClaim(input);
	}

	async approveOwnershipClaim(input: ClaimApprovalInput): Promise<ClaimApprovalResult> {
		return await this.approveClaim(input);
	}

	async getClaimAuthorization(authorizationId: string): Promise<ClaimRequestAuthorization | null> {
		assertOpaqueId(authorizationId, "authorizationId");
		return await this.#withLock(async state => ({
			value: clone(state.claims.authorizations[authorizationId] ?? null),
		}));
	}

	async getAuthorization(authorizationId: string): Promise<ClaimRequestAuthorization | null> {
		return await this.getClaimAuthorization(authorizationId);
	}

	async getClaim(claimId: string): Promise<OwnershipClaim | null> {
		assertOpaqueId(claimId, "claimId");
		return await this.#withLock(async state => ({ value: clone(state.claims.claims[claimId] ?? null) }));
	}

	async listClaims(): Promise<readonly OwnershipClaim[]> {
		return await this.#withLock(async state => ({
			value: Object.values(state.claims.claims).map(claim => clone(claim)),
		}));
	}

	async #withLock<T>(mutator: (state: MasterStoreState) => Promise<TransactionResult<T>>): Promise<T> {
		await ensurePrivateMasterLayout(this.paths);
		return await withFileLock(this.paths.lockPath, async () => {
			const state = await this.#readState();
			const previousChannelsAtStart = clone(state.channels.channels);
			const result = await mutator(state);
			const drafts = [...(result.events ?? []), ...(result.event === undefined ? [] : [result.event])];
			if (drafts.length === 0 && result.persist !== true) return result.value;
			return await withFileLock(this.paths.eventJournalLockPath, async () => {
				let previousChannels = previousChannelsAtStart;
				let firstPersistedEvent: PersistedMasterEvent | null = null;
				const pendingDrafts = drafts.slice();
				while (pendingDrafts.length > 0) {
					const draft = pendingDrafts.shift()!;
					assertEventDraft(draft);
					const globalEvents = await readGlobalJournal(
						this.paths.eventJournalPath,
						this.paths.eventCheckpointPath,
					);
					const frame = eventBase(draft, this.masterName, globalEvents.length + 1, nowIso(this.#now));
					if (!masterEventFrameSchema.safeParse(frame).success)
						throw new MasterStoreError(
							"INVALID_EVENT",
							"Durable master event violates the strict protocol schema.",
						);
					const persisted = { ...frame, checksum: sha256(canonicalJson(frame)) } as PersistedMasterEvent;
					if (firstPersistedEvent === null) firstPersistedEvent = persisted;
					state.events.push(persisted);
					this.#appendOutboxRows(state, persisted);
					this.#syncChannelProjection(state);
					pendingDrafts.push(...this.#providerTransitionEvents(previousChannels, state));
					previousChannels = clone(state.channels.channels);
					await this.#commitAggregateLocked(state, persisted);
				}
				if (drafts.length === 0 && result.persist === true) await this.#commitAggregateLocked(state, null);
				if (result.returnLastEvent) {
					if (firstPersistedEvent === null)
						throw new MasterStoreCorruptionError("Transaction requested an event receipt without an event.");
					return clone(firstPersistedEvent) as T;
				}
				return result.value;
			});
		});
	}

	async #recoverPendingManifest(): Promise<void> {
		const value = await readOptionalJson(this.paths.commitManifestPath);
		if (value === null) throw new MasterStoreCorruptionError("Commit manifest is missing.");
		validateCommitManifest(value, this.masterName);
		const manifestRecord = isRecord(value.state) && isRecord(value.state.record) ? value.state.record : null;
		if (manifestRecord === null)
			throw new MasterStoreCorruptionError("Pending commit manifest has no master record.");
		validateMasterRecord(manifestRecord, this.masterName);
		this.#assertExpectedAuthorityFingerprint(manifestRecord.authorityFingerprint);
		if (value.status !== "pending") return;
		await withFileLock(this.paths.eventJournalLockPath, async () => {
			const globalEvents = await readGlobalJournal(this.paths.eventJournalPath, this.paths.eventCheckpointPath);
			if (value.event !== null) {
				if (value.event.seq > globalEvents.length + 1)
					throw new MasterStoreCorruptionError("Pending event sequence has a gap.");
				if (value.event.seq === globalEvents.length + 1) {
					await appendDurableLine(
						this.paths.eventJournalPath,
						`${JSON.stringify(value.event)}\n`,
						this.paths.root,
					);
				} else if (
					globalEvents[value.event.seq - 1] === undefined ||
					canonicalJson(globalEvents[value.event.seq - 1]) !== canonicalJson(value.event)
				) {
					throw new MasterStoreCorruptionError("Pending event conflicts with global journal.");
				}
			}
			await this.#writeLeafDocuments(value.state);
			const currentGlobal = await readGlobalJournal(this.paths.eventJournalPath, this.paths.eventCheckpointPath);
			await atomicWriteJson(
				this.paths.eventCheckpointPath,
				{
					version: MASTER_SCHEMA_VERSION,
					schema_version: MASTER_SCHEMA_VERSION,
					kind: "master_event_checkpoint",
					lastSeq: currentGlobal.length,
				},
				this.paths.root,
			);
			await atomicWriteJson(this.paths.commitManifestPath, { ...value, status: "committed" }, this.paths.root);
		});
	}

	async #readCommittedManifest(): Promise<MasterCommitManifest> {
		const value = await readJson(this.paths.commitManifestPath);
		validateCommitManifest(value, this.masterName);
		if (value.status !== "committed") throw new MasterStoreCorruptionError("Commit manifest did not recover.");
		return value;
	}
	async #readState(): Promise<MasterStoreState> {
		await this.#recoverPendingManifest();
		const manifest = await this.#readCommittedManifest();
		const record = await readJson(this.paths.recordPath);
		validateMasterRecord(record, this.masterName);
		this.#assertExpectedAuthorityFingerprint(record.authorityFingerprint);

		const queueValue = await readJson(this.paths.queuePath);
		try {
			validateQueueState(queueValue);
		} catch (error) {
			throw new MasterStoreCorruptionError(`Queue state is invalid: ${errorAsMessage(error)}`);
		}
		const queue = queueValue;
		const workersValue = await readJson(this.paths.workersPath);
		validateWorkerDocument(workersValue, this.masterName);
		const workers = workersValue;
		const ownershipValue = await readJson(this.paths.ownershipPath);
		validateSimpleDocument(ownershipValue, "master_ownership", this.masterName);
		const ownership = ownershipValue as unknown as MasterOwnershipDocument;
		if (!isRecord(ownership.owners)) throw new MasterStoreCorruptionError("Ownership map is invalid.");
		for (const [workerSessionId, owner] of Object.entries(ownership.owners)) {
			assertOpaqueId(workerSessionId, "workerSessionId");
			if (!isRecord(owner) || (owner.kind !== "master" && owner.kind !== "user"))
				throw new MasterStoreCorruptionError("Ownership entry is invalid.");
			if (owner.kind === "master" && owner.masterName !== this.masterName)
				throw new MasterStoreCorruptionError("Ownership masterName is invalid.");
		}
		const claimsValue = await readJson(this.paths.claimsPath);
		validateClaimsDocument(claimsValue, this.masterName);
		const claims = claimsValue as unknown as MasterClaimsDocument;
		const channelsValue = await readJson(this.paths.channelsPath);
		validateSimpleDocument(channelsValue, "master_channels", this.masterName);
		const channels = channelsValue as unknown as MasterChannelsDocument;
		if (!Array.isArray(channels.channels)) throw new MasterStoreCorruptionError("Channels list is invalid.");
		if (!Array.isArray(channels.configuredProviders)) channels.configuredProviders = [...this.#configuredProviders];
		for (const provider of channels.configuredProviders) assertProvider(provider);
		if (
			this.#configuredProviders.length > 0 &&
			canonicalJson(this.#configuredProviders) !== canonicalJson(channels.configuredProviders)
		)
			throw new MasterStoreError(
				"PROVIDER_CONFIGURATION_CONFLICT",
				"Configured provider set changed for this master.",
			);
		if (!isRecord(channels.receiptCursors)) channels.receiptCursors = {};
		if (!Array.isArray(channels.workerLeases)) channels.workerLeases = [];
		if (!Array.isArray(channels.effectLeases)) channels.effectLeases = [];
		for (const channel of channels.channels) this.#validateChannelSnapshot(channel);
		if (new Set(channels.channels.map(channel => channel.provider)).size !== channels.channels.length)
			throw new MasterStoreCorruptionError("Channel providers are duplicated.");
		const outboxValue = await readJson(this.paths.presentationOutboxPath);
		validateSimpleDocument(outboxValue, "master_presentation_outbox", this.masterName);
		const outbox = outboxValue as unknown as MasterOutboxDocument;
		if (!Array.isArray(outbox.rows)) throw new MasterStoreCorruptionError("Outbox rows are invalid.");
		for (const row of outbox.rows) this.#validatePresentationRow(row);
		const events = await this.#readEvents();
		assertExactActiveWorkerCount(queue.activeWorkerCount, workers.workers);
		if (
			record.activeWorkerCount !== queue.activeWorkerCount ||
			record.maxConcurrentWorkers !== queue.maxConcurrentWorkers ||
			record.capacityState !== queue.capacityState ||
			record.queueRevision !== queue.queueRevision ||
			record.userDispatchStreak !== queue.userDispatchStreak
		)
			throw new MasterStoreCorruptionError("Record and queue summaries disagree.");
		for (const task of queue.tasks) validateTaskRecord(task);
		for (const worker of workers.workers) {
			const task = queue.tasks.find(candidate => candidate.taskId === worker.taskId);
			const intent = workers.intents.find(candidate => candidate.intentId === worker.intentId);
			if (
				task === undefined ||
				intent === undefined ||
				intent.taskId !== worker.taskId ||
				task.leaseId !== worker.leaseId
			)
				throw new MasterStoreCorruptionError("Worker, intent, and task lease indexes disagree.");
			if (worker.state === "leased" && intent.state !== "reserved" && intent.state !== "create_uncertain")
				throw new MasterStoreCorruptionError("Reserved worker intent state is invalid.");
			if (
				worker.state === "assigned" &&
				intent.state !== "created" &&
				intent.state !== "prompt_pending" &&
				intent.state !== "active"
			)
				throw new MasterStoreCorruptionError("Assigned worker intent state is invalid.");
			if (worker.state === "terminal" && intent.state !== "terminal")
				throw new MasterStoreCorruptionError("Terminal worker intent state is invalid.");
			if (worker.workerSessionId === null) {
				if (task.workerSessionId !== null || worker.lifecycle !== null)
					throw new MasterStoreCorruptionError("Reserved worker has an owner or task session.");
			} else {
				if (
					task.workerSessionId !== worker.workerSessionId ||
					ownership.owners[worker.workerSessionId] === undefined
				)
					throw new MasterStoreCorruptionError("Known worker has no matching owner or task session.");
			}
		}
		if (queue.capacityState === "draining_over_capacity") {
			const reduced = events.some(
				event =>
					event.type === "queue_updated" &&
					event.payload.action === "capacity_reconfigured" &&
					event.payload.queue.capacityState === "draining_over_capacity" &&
					event.payload.queue.maxConcurrentWorkers === queue.maxConcurrentWorkers &&
					event.payload.previousMaxConcurrentWorkers > queue.maxConcurrentWorkers,
			);
			if (!reduced) throw new MasterStoreCorruptionError("Draining state has no persisted capacity reduction.");
		}
		const { globalEvents, checkpointValue } = await withFileLock(this.paths.eventJournalLockPath, async () => ({
			globalEvents: await readGlobalJournal(this.paths.eventJournalPath, this.paths.eventCheckpointPath),
			checkpointValue: await readOptionalJson(this.paths.eventCheckpointPath),
		}));
		if (checkpointValue === null) throw new MasterStoreCorruptionError("Global event checkpoint is missing.");
		assertVersioned(checkpointValue, "master_event_checkpoint");
		if ((checkpointValue as { lastSeq?: unknown }).lastSeq !== globalEvents.length)
			throw new MasterStoreCorruptionError("Global event checkpoint disagrees with journal.");
		for (const event of events) {
			const global = globalEvents[event.seq - 1];
			if (global === undefined || canonicalJson(global) !== canonicalJson(event))
				throw new MasterStoreCorruptionError("Per-master event projection disagrees with global journal.");
		}
		const manifestState = manifest.state;
		if (
			canonicalJson(manifestState.record) !== canonicalJson(record) ||
			canonicalJson(manifestState.queue) !== canonicalJson(queue) ||
			canonicalJson(manifestState.workers) !== canonicalJson(workers) ||
			canonicalJson(manifestState.ownership) !== canonicalJson(ownership) ||
			canonicalJson(manifestState.claims) !== canonicalJson(claims) ||
			canonicalJson(manifestState.channels) !== canonicalJson(channels) ||
			canonicalJson(manifestState.outbox) !== canonicalJson(outbox) ||
			canonicalJson(manifestState.events) !== canonicalJson(events)
		)
			throw new MasterStoreCorruptionError("Commit manifest disagrees with state projections.");
		return { record, queue, workers, ownership, claims, channels, outbox, events };
	}

	async #readEvents(): Promise<PersistedMasterEvent[]> {
		let text: string;
		try {
			text = await fs.readFile(this.paths.decisionsPath, "utf8");
		} catch (error) {
			if (isNodeError(error, "ENOENT")) throw new MasterStoreCorruptionError("Event log is missing.");
			throw error;
		}
		if (text.length === 0) return [];
		const events: PersistedMasterEvent[] = [];
		const lines = text.split("\n");
		if (lines.at(-1) !== "") throw new MasterStoreCorruptionError("Event log is not newline terminated.");
		let previousSeq = 0;
		for (const line of lines.slice(0, -1)) {
			if (line.length === 0) throw new MasterStoreCorruptionError("Event log contains an empty record.");
			let parsed: unknown;
			try {
				parsed = JSON.parse(line) as unknown;
			} catch (error) {
				throw new MasterStoreCorruptionError(`Malformed event JSON: ${errorAsMessage(error)}`);
			}
			validateEvent(parsed, this.masterName, null);
			if (parsed.seq <= previousSeq)
				throw new MasterStoreCorruptionError("Per-master event projection is not ordered.");
			previousSeq = parsed.seq;
			events.push(parsed);
		}
		return events;
	}

	async #writeLeafDocuments(state: MasterStoreState): Promise<void> {
		await atomicWriteJson(this.paths.recordPath, state.record, this.paths.root);
		await atomicWriteJson(this.paths.queuePath, state.queue, this.paths.root);
		await atomicWriteJson(this.paths.workersPath, state.workers, this.paths.root);
		await atomicWriteJson(this.paths.ownershipPath, state.ownership, this.paths.root);
		await atomicWriteJson(this.paths.claimsPath, state.claims, this.paths.root);
		await atomicWriteJson(this.paths.channelsPath, state.channels, this.paths.root);
		await atomicWriteJson(this.paths.presentationOutboxPath, state.outbox, this.paths.root);
		const eventText = state.events.map(event => JSON.stringify(event)).join("\n");
		await atomicWriteText(this.paths.decisionsPath, eventText.length === 0 ? "" : `${eventText}\n`, this.paths.root);
	}

	async #commitAggregateLocked(state: MasterStoreState, event: PersistedMasterEvent | null): Promise<void> {
		const previousValue = await readOptionalJson(this.paths.commitManifestPath);
		let generation = 1;
		if (previousValue !== null) {
			validateCommitManifest(previousValue, this.masterName);
			generation = previousValue.generation + 1;
		}
		const pending: MasterCommitManifest = {
			version: MASTER_SCHEMA_VERSION,
			schema_version: MASTER_SCHEMA_VERSION,
			kind: "master_commit_manifest",
			masterName: this.masterName,
			generation,
			status: "pending",
			state: clone(state),
			event: event === null ? null : clone(event),
		};
		await atomicWriteJson(this.paths.commitManifestPath, pending, this.paths.root);
		if (event !== null) {
			const globalEvents = await readGlobalJournal(this.paths.eventJournalPath, this.paths.eventCheckpointPath);
			if (event.seq !== globalEvents.length + 1)
				throw new MasterStoreCorruptionError("Event sequence is not contiguous at commit.");
			await appendDurableLine(this.paths.eventJournalPath, `${JSON.stringify(event)}\n`, this.paths.root);
		}
		await this.#writeLeafDocuments(state);
		const currentGlobal = await readGlobalJournal(this.paths.eventJournalPath, this.paths.eventCheckpointPath);
		await atomicWriteJson(
			this.paths.eventCheckpointPath,
			{
				version: MASTER_SCHEMA_VERSION,
				schema_version: MASTER_SCHEMA_VERSION,
				kind: "master_event_checkpoint",
				lastSeq: currentGlobal.length,
			},
			this.paths.root,
		);
		await atomicWriteJson(this.paths.commitManifestPath, { ...pending, status: "committed" }, this.paths.root);
	}

	#providerHealth(state: MasterStoreState): ProviderHealth {
		const configuredProviders = [...state.channels.configuredProviders];
		const activeProviders = state.channels.channels
			.filter(
				channel => channel.state === "active" && channel.bindingId !== null && channel.remoteChannelId !== null,
			)
			.map(channel => channel.provider);
		const degradedProviders = configuredProviders.filter(provider => {
			const channel = state.channels.channels.find(candidate => candidate.provider === provider);
			return (
				channel === undefined ||
				channel.state !== "active" ||
				channel.bindingId === null ||
				channel.remoteChannelId === null ||
				channel.pendingPresentationCount > 0
			);
		});
		return { configuredProviders, activeProviders, degradedProviders, operational: activeProviders.length >= 1 };
	}

	#assertConfiguredProvider(state: MasterStoreState, provider: MasterProvider): void {
		assertProvider(provider);
		if (!state.channels.configuredProviders.includes(provider))
			throw new MasterStoreError(
				"PROVIDER_NOT_CONFIGURED",
				`Provider ${provider} is not configured for this master.`,
			);
	}
	#assertActiveProviderIngress(state: MasterStoreState, ingress: MasterIngress): void {
		assertIngress(ingress);
		if (ingress.kind !== "provider") return;
		this.#assertConfiguredProvider(state, ingress.provider);
		const channel = state.channels.channels.find(candidate => candidate.provider === ingress.provider);
		if (
			channel === undefined ||
			channel.state !== "active" ||
			channel.bindingId === null ||
			channel.remoteChannelId === null ||
			channel.remoteChannelId !== ingress.channelId
		)
			throw new MasterStoreError("CHANNEL_NOT_BOUND", "Ingress channel is not actively bound to this master.");
	}

	#validateChannelSnapshot(channel: ChannelSnapshot): void {
		if (!isRecord(channel)) throw new MasterStoreCorruptionError("Channel binding is malformed.");
		assertProvider(channel.provider);
		if (
			channel.state !== "provisioning" &&
			channel.state !== "active" &&
			channel.state !== "blocked" &&
			channel.state !== "unknown" &&
			channel.state !== "relocating"
		)
			throw new MasterStoreCorruptionError("Channel binding state is invalid.");
		assertOpaqueId(channel.intentId, "channel.intentId");
		if (channel.bindingId !== null) assertOpaqueId(channel.bindingId, "channel.bindingId");
		if (channel.remoteChannelId !== null) assertOpaqueId(channel.remoteChannelId, "channel.remoteChannelId");
		if (
			!Number.isSafeInteger(channel.fence) ||
			channel.fence < 0 ||
			!Number.isSafeInteger(channel.pendingPresentationCount) ||
			channel.pendingPresentationCount < 0
		)
			throw new MasterStoreCorruptionError("Channel binding counters are invalid.");
		if (channel.deliveryHealth !== "healthy" && channel.deliveryHealth !== "degraded")
			throw new MasterStoreCorruptionError("Channel delivery health is invalid.");
	}

	#validatePresentationRow(row: PresentationOutboxRow): void {
		if (!isRecord(row)) throw new MasterStoreCorruptionError("Presentation outbox row is malformed.");
		assertProvider(row.provider);
		assertOpaqueId(row.eventId, "outbox.eventId");
		assertOpaqueId(row.effectId, "outbox.effectId");
		assertOpaqueId(row.intentId, "outbox.intentId");
		if (row.bindingId !== null) assertOpaqueId(row.bindingId, "outbox.bindingId");
		if (!Number.isSafeInteger(row.eventSeq) || row.eventSeq < 1 || !Number.isSafeInteger(row.fence) || row.fence < 0)
			throw new MasterStoreCorruptionError("Presentation outbox sequence or fence is invalid.");
		assertOpaqueId(row.nonce, "outbox.nonce");
		if (row.state !== "pending" && row.state !== "leased" && row.state !== "reconciled" && row.state !== "blocked")
			throw new MasterStoreCorruptionError("Presentation outbox state is invalid.");
		if (row.leaseId !== null) assertOpaqueId(row.leaseId, "outbox.leaseId");
		if (row.leaseExpiresAt !== null) assertTimestamp(row.leaseExpiresAt, "outbox.leaseExpiresAt");
		if (row.remoteEffectId !== null) assertOpaqueId(row.remoteEffectId, "outbox.remoteEffectId");
		if (row.remoteMessageId !== null) assertOpaqueId(row.remoteMessageId, "outbox.remoteMessageId");
		assertTimestamp(row.createdAt, "outbox.createdAt");
		assertTimestamp(row.updatedAt, "outbox.updatedAt");
		if (!isRecord(row.content) || typeof row.content.text !== "string")
			throw new MasterStoreCorruptionError("Presentation outbox content is invalid.");
	}

	#syncChannelProjection(state: MasterStoreState): void {
		for (const channel of state.channels.channels) {
			const pending = state.outbox.rows.filter(
				row => row.provider === channel.provider && row.state !== "reconciled",
			).length;
			channel.pendingPresentationCount = pending;
			channel.deliveryHealth =
				channel.state === "active" && pending === 0
					? "healthy"
					: pending > 0 || channel.state !== "active"
						? "degraded"
						: "healthy";
		}
	}

	#appendOutboxRows(state: MasterStoreState, event: PersistedMasterEvent): void {
		if (!isPresentationRequiredEvent(event)) return;
		const content = presentationContent(event);
		for (const provider of state.channels.configuredProviders) {
			if (state.outbox.rows.some(row => row.provider === provider && row.eventId === event.eventId)) continue;
			const channel = state.channels.channels.find(candidate => candidate.provider === provider);
			const intentId = channel?.intentId ?? providerIntentId(this.masterName, provider);
			const fence = channel?.fence ?? 0;
			const effectId = `present:${provider}:${event.eventId}`;
			state.outbox.rows.push({
				provider,
				eventId: event.eventId,
				eventSeq: event.seq,
				effectId,
				intentId,
				bindingId: channel?.bindingId ?? null,
				fence,
				nonce: providerEffectNonce(effectId, fence),
				state: "pending",
				leaseId: null,
				leaseExpiresAt: null,
				workerId: null,
				workerLeaseId: null,
				retryAt: null,
				remoteEffectId: null,
				remoteMessageId: null,
				lastOutcomeDigest: null,
				lastOutcome: null,
				content,
				createdAt: event.occurredAt,
				updatedAt: event.occurredAt,
			});
		}
	}

	#providerTransitionEvents(previousChannels: readonly ChannelSnapshot[], state: MasterStoreState): EventDraft[] {
		const nextHealth = this.#providerHealth(state);
		const events: EventDraft[] = [];
		for (const channel of state.channels.channels) {
			const previous = previousChannels.find(candidate => candidate.provider === channel.provider);
			const previousPending = previous?.pendingPresentationCount ?? 0;
			if (
				channel.state === "active" &&
				channel.bindingId !== null &&
				channel.pendingPresentationCount > 0 &&
				(previousPending === 0 || previous?.state !== "active")
			)
				events.push({
					type: "channel_updated",
					payload: {
						transition: "provider_degraded",
						provider: channel.provider,
						bindingId: channel.bindingId,
						state: "active",
						deliveryHealth: "degraded",
						activeProviderCount: nextHealth.activeProviders.length,
						degradedProviderCount: nextHealth.degradedProviders.length,
						pendingPresentationCount: channel.pendingPresentationCount,
						reason: "presentation_pending",
					},
				});
			if (
				(channel.state === "blocked" || channel.state === "unknown") &&
				(previous?.state !== channel.state || previousPending === 0)
			)
				events.push({
					type: "channel_updated",
					payload: {
						transition: "provider_degraded",
						provider: channel.provider,
						bindingId: channel.bindingId,
						state: channel.state,
						deliveryHealth: "degraded",
						activeProviderCount: nextHealth.activeProviders.length,
						degradedProviderCount: nextHealth.degradedProviders.length,
						pendingPresentationCount: channel.pendingPresentationCount,
						reason: "binding_unavailable",
					},
				});
			if (
				channel.state === "active" &&
				channel.bindingId !== null &&
				channel.pendingPresentationCount === 0 &&
				previous?.state === "active" &&
				previousPending > 0
			)
				events.push({
					type: "channel_updated",
					payload: {
						transition: "provider_recovered",
						provider: channel.provider,
						bindingId: channel.bindingId,
						state: "active",
						deliveryHealth: "healthy",
						activeProviderCount: nextHealth.activeProviders.length,
						degradedProviderCount: nextHealth.degradedProviders.length,
						replayPendingCount: 0,
					},
				});
		}
		return events;
	}

	#expireProviderLeases(state: MasterStoreState): void {
		const timestamp = Date.parse(nowIso(this.#now));
		for (const lease of state.channels.workerLeases)
			if (lease.state === "active" && Date.parse(lease.expiresAt) <= timestamp) lease.state = "expired";
		for (const lease of state.channels.effectLeases)
			if (lease.state === "leased" && Date.parse(lease.expiresAt) <= timestamp) {
				lease.state = "pending";
				lease.workerId = "expired";
				lease.workerLeaseId = "expired";
			}
		for (const row of state.outbox.rows)
			if (row.state === "leased" && row.leaseExpiresAt !== null && Date.parse(row.leaseExpiresAt) <= timestamp) {
				row.state = "pending";
				row.leaseId = null;
				row.leaseExpiresAt = null;
				row.workerId = null;
				row.workerLeaseId = null;
			}
	}

	#assertProviderWorkerLease(
		state: MasterStoreState,
		provider: MasterProvider,
		workerId?: string,
		workerLeaseId?: string,
	): ProviderWorkerLease {
		if (workerId === undefined || workerLeaseId === undefined)
			throw new MasterStoreError("STALE_PROVIDER_WORKER_LEASE", "Provider worker identity and lease are required.");
		const lease = state.channels.workerLeases.find(
			candidate =>
				candidate.provider === provider && candidate.leaseId === workerLeaseId && candidate.workerId === workerId,
		);
		if (
			lease === undefined ||
			lease.state !== "active" ||
			Date.parse(lease.expiresAt) <= Date.parse(nowIso(this.#now))
		)
			throw new MasterStoreError(
				"STALE_PROVIDER_WORKER_LEASE",
				"Provider worker registration lease is stale or unknown.",
			);
		return lease;
	}

	#leaseProviderEffectLocked(
		state: MasterStoreState,
		provider: MasterProvider,
		workerId: string,
		workerLeaseId: string,
	): ProviderEffectLease | null {
		const timestamp = nowIso(this.#now);
		const channel = state.channels.channels.find(candidate => candidate.provider === provider);
		if (channel === undefined) return null;
		if (channel.state !== "active" || channel.bindingId === null || channel.remoteChannelId === null) {
			const effectId = `provision:${provider}:${channel.intentId}`;
			const existing = state.channels.effectLeases.find(lease => lease.effectId === effectId);
			if (
				existing !== undefined &&
				existing.state === "leased" &&
				Date.parse(existing.expiresAt) > Date.parse(timestamp)
			)
				return null;
			if (
				existing?.retryAt !== null &&
				existing?.retryAt !== undefined &&
				Date.parse(existing.retryAt) > Date.parse(timestamp)
			)
				return null;
			if (existing?.state === "blocked" || existing?.state === "reconciled") return null;
			const leaseId = randomUUID();
			const record: ProviderEffectLeaseRecord = {
				effectId,
				intentId: channel.intentId,
				provider,
				kind: "provision_channel",
				eventId: null,
				bindingId: channel.bindingId,
				leaseId,
				fence: channel.fence,
				nonce: providerEffectNonce(effectId, channel.fence),
				workerId,
				workerLeaseId,
				retryAt: null,
				expiresAt: new Date(Date.parse(timestamp) + DEFAULT_PROVIDER_LEASE_MS).toISOString(),
				state: "leased",
				outcomeDigest: existing?.outcomeDigest ?? null,
				outcome: existing?.outcome ?? null,
			};
			if (existing === undefined) state.channels.effectLeases.push(record);
			else Object.assign(existing, record);
			return {
				effectId,
				intentId: channel.intentId,
				leaseId,
				masterName: this.masterName,
				provider,
				fence: channel.fence,
				nonce: record.nonce,
				expiresAt: record.expiresAt,
				kind: "provision_channel",
				operation: channel.state === "unknown" || channel.state === "blocked" ? "reconcile" : "create",
				channelName: providerChannelName(this.masterName, provider),
				previousRemoteChannelId: channel.remoteChannelId,
			};
		}
		const row = state.outbox.rows
			.filter(
				candidate =>
					candidate.provider === provider && (candidate.state === "pending" || candidate.state === "leased"),
			)
			.sort((left, right) => left.eventSeq - right.eventSeq)[0];
		if (row === undefined) return null;
		if (row.retryAt !== null && Date.parse(row.retryAt) > Date.parse(timestamp)) return null;
		if (
			row.state === "leased" &&
			row.leaseId !== null &&
			row.leaseExpiresAt !== null &&
			Date.parse(row.leaseExpiresAt) > Date.parse(timestamp)
		)
			return null;
		row.bindingId = channel.bindingId;
		row.fence = channel.fence;
		row.nonce = providerEffectNonce(row.effectId, row.fence);
		row.leaseId = randomUUID();
		row.leaseExpiresAt = new Date(Date.parse(timestamp) + DEFAULT_PROVIDER_LEASE_MS).toISOString();
		row.workerId = workerId;
		row.workerLeaseId = workerLeaseId;
		row.retryAt = null;
		row.state = "leased";
		row.updatedAt = timestamp;
		return {
			effectId: row.effectId,
			intentId: row.intentId,
			leaseId: row.leaseId,
			masterName: this.masterName,
			provider,
			fence: row.fence,
			nonce: row.nonce,
			expiresAt: row.leaseExpiresAt,
			kind: "present_event",
			eventId: row.eventId,
			bindingId: channel.bindingId,
			content: clone(row.content),
		};
	}

	async #reconcileProviderEffect(input: ProviderEffectResultInput): Promise<ProviderEffectResultReceipt> {
		if (!isRecord(input)) throw new MasterStoreError("INVALID_INPUT", "Provider effect result must be an object.");
		assertProvider(input.provider);
		assertOpaqueId(input.effectId, "effectId");
		assertOpaqueId(input.intentId, "intentId");
		assertOpaqueId(input.leaseId, "leaseId");
		assertOpaqueId(input.nonce, "nonce");
		if (input.workerId === undefined || input.workerLeaseId === undefined)
			throw new MasterStoreError("STALE_PROVIDER_WORKER_LEASE", "Provider effect result owner is required.");
		assertOpaqueId(input.workerId, "workerId");
		assertOpaqueId(input.workerLeaseId, "workerLeaseId");
		if (!Number.isSafeInteger(input.fence) || input.fence < 0)
			throw new MasterStoreError("INVALID_INPUT", "Effect fence is invalid.");
		if (
			!isRecord(input.outcome) ||
			(input.outcome.effectKind !== "provision_channel" && input.outcome.effectKind !== "present_event")
		)
			throw new MasterStoreError("INVALID_INPUT", "Effect outcome kind is invalid.");
		const outcomeValid =
			input.outcome.effectKind === "provision_channel"
				? providerProvisionOutcomeValidator.safeParse(input.outcome).success
				: providerPresentationOutcomeValidator.safeParse(input.outcome).success;
		if (!outcomeValid) throw new MasterStoreError("INVALID_INPUT", "Provider effect outcome is invalid.");
		return await this.#withLock<ProviderEffectResultReceipt>(async state => {
			this.#assertConfiguredProvider(state, input.provider);
			const digest = providerEffectDigest(input.outcome);
			const row = state.outbox.rows.find(candidate => candidate.effectId === input.effectId);
			const effect = state.channels.effectLeases.find(candidate => candidate.effectId === input.effectId);
			if (row === undefined && effect === undefined)
				throw new MasterStoreError("EFFECT_NOT_FOUND", `Provider effect ${input.effectId} does not exist.`);
			if (row !== undefined) {
				if (
					input.outcome.effectKind !== "present_event" ||
					row.provider !== input.provider ||
					row.intentId !== input.intentId ||
					row.fence !== input.fence ||
					row.workerId !== input.workerId ||
					row.workerLeaseId !== input.workerLeaseId ||
					row.nonce !== input.nonce
				)
					throw new MasterStoreError(
						"EFFECT_RESULT_CONFLICT",
						"Provider presentation result does not match the durable effect fence.",
					);
				if (row.lastOutcomeDigest !== null && row.lastOutcomeDigest === digest) {
					return {
						value: {
							effectId: row.effectId,
							provider: row.provider,
							disposition: "already_recorded" as const,
							nextState:
								row.state === "reconciled"
									? ("reconciled" as const)
									: row.state === "blocked"
										? ("blocked" as const)
										: ("pending" as const),
							receiptCursor: state.channels.receiptCursors[row.provider] ?? 0,
						},
					};
				}
				if (row.leaseId !== input.leaseId) {
					if (row.lastOutcomeDigest !== null)
						throw new MasterStoreError(
							"EFFECT_RESULT_CONFLICT",
							"Conflicting provider presentation result for an existing effect.",
						);
					throw new MasterStoreError("STALE_EFFECT_LEASE", "Provider presentation lease is stale.");
				}
				if (row.state !== "leased")
					throw new MasterStoreError("STALE_EFFECT_LEASE", "Provider presentation lease is stale.");
				const timestamp = nowIso(this.#now);
				row.lastOutcomeDigest = digest;
				row.lastOutcome = clone(input.outcome) as ProviderPresentationOutcome;
				row.updatedAt = timestamp;
				const outcome = input.outcome as ProviderPresentationOutcome;
				if (outcome.status === "succeeded" && outcome.reconciled) {
					const channel = state.channels.channels.find(candidate => candidate.provider === row.provider);
					if (row.bindingId === null || channel?.bindingId !== row.bindingId)
						throw new MasterStoreError(
							"EFFECT_RESULT_CONFLICT",
							"Presentation result binding no longer matches the active binding.",
						);
					row.state = "reconciled";
					row.remoteEffectId = outcome.remoteEffectId;
					row.remoteMessageId = outcome.remoteMessageId;
					row.leaseExpiresAt = null;
					row.retryAt = null;
					this.#syncChannelProjection(state);
					const cursor = this.#advanceReceiptCursor(state, row.provider);
					return {
						value: {
							effectId: row.effectId,
							provider: row.provider,
							disposition: "recorded" as const,
							nextState: "reconciled" as const,
							receiptCursor: cursor,
						},
						event: {
							type: "channel_updated",
							payload: {
								transition: "presentation_reconciled",
								provider: row.provider,
								eventId: row.eventId,
								effectId: row.effectId,
								bindingId: row.bindingId,
								remoteMessageId: outcome.remoteMessageId,
								fence: row.fence,
								state: "active",
							},
						},
					};
				}
				row.state = outcome.status === "terminal" ? "blocked" : "pending";
				row.leaseId = null;
				row.leaseExpiresAt = null;
				row.workerId = null;
				row.workerLeaseId = null;
				row.retryAt =
					outcome.status === "retryable"
						? new Date(Date.parse(timestamp) + (outcome.retryAfterMs ?? 5_000)).toISOString()
						: outcome.status === "unknown"
							? new Date(Date.parse(timestamp) + 30_000).toISOString()
							: null;
				this.#syncChannelProjection(state);
				return {
					value: {
						effectId: row.effectId,
						provider: row.provider,
						disposition: "recorded" as const,
						nextState: row.state === "blocked" ? ("blocked" as const) : ("pending" as const),
						receiptCursor: state.channels.receiptCursors[row.provider] ?? 0,
					},
					persist: true,
				};
			}
			if (
				effect === undefined ||
				effect.kind !== "provision_channel" ||
				input.outcome.effectKind !== "provision_channel" ||
				effect.provider !== input.provider ||
				effect.intentId !== input.intentId ||
				effect.fence !== input.fence ||
				effect.workerId !== input.workerId ||
				effect.workerLeaseId !== input.workerLeaseId ||
				effect.nonce !== input.nonce
			)
				throw new MasterStoreError(
					"EFFECT_RESULT_CONFLICT",
					"Provider provisioning result does not match the durable effect fence.",
				);
			if (effect.outcomeDigest !== null && effect.outcomeDigest === digest)
				return {
					value: {
						effectId: effect.effectId,
						provider: effect.provider,
						disposition: "already_recorded" as const,
						nextState:
							effect.state === "reconciled"
								? ("reconciled" as const)
								: effect.state === "blocked"
									? ("blocked" as const)
									: ("pending" as const),
						receiptCursor: state.channels.receiptCursors[effect.provider] ?? 0,
					},
				};
			if (effect.state !== "leased" || effect.leaseId !== input.leaseId) {
				if (effect.outcomeDigest !== null)
					throw new MasterStoreError(
						"EFFECT_RESULT_CONFLICT",
						"Conflicting provider provisioning result for an existing effect.",
					);
				throw new MasterStoreError("STALE_EFFECT_LEASE", "Provider provisioning lease is stale.");
			}
			const channel = state.channels.channels.find(
				candidate => candidate.provider === input.provider && candidate.intentId === input.intentId,
			);
			if (channel === undefined)
				throw new MasterStoreError("BINDING_INTENT_NOT_FOUND", "Provider binding intent is unknown.");
			const timestamp = nowIso(this.#now);
			effect.outcomeDigest = digest;
			effect.outcome = clone(input.outcome);
			effect.expiresAt = timestamp;
			const outcome = input.outcome as ProviderProvisionOutcome;
			if (outcome.status === "succeeded" && outcome.reconciled) {
				channel.state = "active";
				channel.bindingId = providerBindingId(input.provider, input.intentId);
				channel.remoteChannelId = outcome.remoteChannelId;
				effect.state = "reconciled";
				effect.retryAt = null;
				for (const pending of state.outbox.rows.filter(
					row => row.provider === input.provider && row.bindingId === null,
				)) {
					pending.bindingId = channel.bindingId;
					pending.fence = channel.fence;
					pending.nonce = providerEffectNonce(pending.effectId, channel.fence);
				}
				this.#syncChannelProjection(state);
				return {
					value: {
						effectId: effect.effectId,
						provider: effect.provider,
						disposition: "recorded" as const,
						nextState: "reconciled" as const,
						receiptCursor: state.channels.receiptCursors[effect.provider] ?? 0,
					},
					event: {
						type: "channel_updated",
						payload: {
							transition: "binding_active",
							provider: input.provider,
							intentId: input.intentId,
							bindingId: channel.bindingId,
							remoteChannelId: channel.remoteChannelId,
							fence: channel.fence,
							state: "active",
						},
					},
				};
			}
			channel.state = outcome.status === "unknown" ? "unknown" : "blocked";
			channel.deliveryHealth = "degraded";
			effect.state = outcome.status === "terminal" ? "blocked" : "pending";
			effect.workerId = "released";
			effect.workerLeaseId = "released";
			effect.retryAt =
				outcome.status === "retryable"
					? new Date(Date.parse(timestamp) + (outcome.retryAfterMs ?? 5_000)).toISOString()
					: outcome.status === "unknown"
						? new Date(Date.parse(timestamp) + 30_000).toISOString()
						: null;
			this.#syncChannelProjection(state);
			return {
				value: {
					effectId: effect.effectId,
					provider: effect.provider,
					disposition: "recorded" as const,
					nextState: effect.state === "blocked" ? ("blocked" as const) : ("pending" as const),
					receiptCursor: state.channels.receiptCursors[effect.provider] ?? 0,
				},
				event: {
					type: "channel_updated",
					payload: {
						transition: "binding_blocked",
						provider: input.provider,
						intentId: input.intentId,
						fence: channel.fence,
						state: channel.state === "unknown" ? "unknown" : "blocked",
						code:
							outcome.status === "unknown"
								? "create_uncertain"
								: outcome.status === "terminal"
									? "provider_terminal"
									: "provider_unavailable",
					},
				},
			};
		});
	}

	#advanceReceiptCursor(state: MasterStoreState, provider: MasterProvider): number {
		const rows = state.outbox.rows
			.filter(row => row.provider === provider)
			.sort((left, right) => left.eventSeq - right.eventSeq);
		const firstPending = rows.find(row => row.state !== "reconciled");
		const cursor =
			firstPending === undefined
				? (rows.at(-1)?.eventSeq ?? 0)
				: (rows.filter(row => row.eventSeq < firstPending.eventSeq && row.state === "reconciled").at(-1)
						?.eventSeq ?? 0);
		state.channels.receiptCursors[provider] = Math.max(state.channels.receiptCursors[provider] ?? 0, cursor);
		return state.channels.receiptCursors[provider];
	}

	#assertExpectedAuthorityFingerprint(fingerprint: string): void {
		if (fingerprint !== this.#authorityFingerprint)
			throw new MasterStoreError(
				"AUTHORITY_MISMATCH",
				"Coordinator authority fingerprint changed from the frozen master authority.",
			);
	}

	#workerLifecycleReceipt(worker: WorkerLease, intent: WorkerCreateIntent): WorkerLifecycleReceipt {
		return {
			leaseId: worker.leaseId,
			intentId: intent.intentId,
			taskId: worker.taskId,
			workerSessionId: worker.workerSessionId,
			lifecycle: worker.lifecycle,
			promptIdempotencyKey: intent.promptIdempotencyKey,
			quarantined: clone(worker.quarantine),
		};
	}

	#workerCreateReceipt(worker: WorkerLease, intent: WorkerCreateIntent, created: boolean): WorkerCreateReceipt {
		return { ...this.#workerLifecycleReceipt(worker, intent), created };
	}

	#promptPendingReceipt(worker: WorkerLease, intent: WorkerCreateIntent): PromptPendingReceipt {
		if (intent.promptIdempotencyKey === null)
			throw new MasterStoreCorruptionError("Prompt-pending worker has no idempotency key.");
		return { ...this.#workerLifecycleReceipt(worker, intent), promptIdempotencyKey: intent.promptIdempotencyKey };
	}

	#promptReconcileReceipt(
		worker: WorkerLease,
		intent: WorkerCreateIntent,
		proven: boolean,
		drained: readonly WorkerObservation[],
	): PromptReconcileReceipt {
		return { ...this.#workerLifecycleReceipt(worker, intent), proven, drained: clone(drained) };
	}

	#syncDerived(state: MasterStoreState, timestamp: string): void {
		state.queue.activeWorkerCount = countActiveWorkerLeases(state.workers.workers);
		state.queue.capacityState = computeCapacityState(state.queue.activeWorkerCount, state.queue.maxConcurrentWorkers);
		state.record.activeWorkerCount = state.queue.activeWorkerCount;
		state.record.maxConcurrentWorkers = state.queue.maxConcurrentWorkers;
		state.record.capacityState = state.queue.capacityState;
		state.record.queueRevision = state.queue.queueRevision;
		state.record.userDispatchStreak = state.queue.userDispatchStreak;
		state.record.updatedAt = timestamp;
	}

	#configuredMaxConcurrentWorkers(): number {
		return this.#configuredMaxWorkers;
	}

	#validateEnqueueInput(input: EnqueueTaskInput): void {
		if (!isRecord(input)) throw new MasterStoreError("INVALID_INPUT", "Enqueue input must be an object.");
		assertOpaqueId(input.idempotencyKey, "idempotencyKey");
		assertNonEmptyText(input.summary, "summary", 16_384);
		if (input.priority !== "urgent_user" && input.priority !== "user" && input.priority !== "autonomous")
			throw new MasterStoreError("INVALID_INPUT", "Invalid task priority.");
		if (input.source !== "user" && input.source !== "master")
			throw new MasterStoreError("INVALID_INPUT", "Invalid task source.");
		if (input.source === "master" && input.priority !== "autonomous")
			throw new MasterStoreError("INVALID_INPUT", "Master tasks must use autonomous priority.");
		if (input.source === "user" && input.priority === "autonomous")
			throw new MasterStoreError("INVALID_INPUT", "User tasks cannot use autonomous priority.");
		if (
			input.workdir !== undefined &&
			input.workdir !== null &&
			(!isAbsoluteNormalizedPath(input.workdir) || !isPathWithin(this.#defaultWorkdir, input.workdir))
		)
			throw new MasterStoreError(
				"INVALID_WORKDIR",
				"Task workdir must be an absolute path under the master default workdir.",
			);
		if (input.taskId !== undefined) assertOpaqueId(input.taskId, "taskId");
		if (input.ingress !== undefined) assertIngress(input.ingress, "ingress");
		if (input.source === "master" && input.ingress !== undefined)
			throw new MasterStoreError("INVALID_INGRESS", "Master autonomous work cannot carry provider ingress.");
	}

	#enqueueDigest(input: EnqueueTaskInput): string {
		return sha256(
			canonicalJson({
				priority: input.priority,
				source: input.source,
				summary: input.summary,
				workdir: input.workdir ?? null,
				ingress: input.ingress ?? null,
			}),
		);
	}
}

export const MasterStore = MasterDomainStore;
