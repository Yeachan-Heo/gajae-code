import { createHash, randomBytes } from "node:crypto";
import * as fs from "node:fs/promises";
import path from "node:path";
import type { NativeDirectoryTreeSnapshot } from "@gajae-code/natives";
import {
	type DirectoryMigrationPolicy,
	listManagedSessionCandidates,
	resolveManagedSessionScope,
} from "../session-directory";
import {
	BROKER_HEARTBEAT_TTL_MS,
	type BrokerDiscovery,
	brokerDiscoveryPath,
	brokerProcessIncarnation,
	isPidAlive,
	newBrokerToken,
	readBrokerDiscovery,
	redactBrokerDiscovery,
	writeBrokerDiscovery,
} from "./discovery";
import { deriveIdempotencyIdentity } from "./identity";
import { executeLifecycle, isCanonicalSessionId } from "./lifecycle";

import {
	type LifecycleDurableEffectsReceipt,
	LifecycleLedger,
	type LifecycleStartupFailureReceipt,
} from "./lifecycle-ledger";
import { type IndexedSession, SessionIndex } from "./session-index";
import { BrokerTransport } from "./transport";

export interface BrokerSettings {
	agentDir: string;
	packageGeneration?: string;
	port?: number;
	heartbeatTtlMs?: number;
	/** Broker-owned migration policy. Client lifecycle frames cannot select it. */
	resolveDirectoryMigration?: (_cwd: string) => Promise<DirectoryMigrationPolicy>;
}

type ResolvedBrokerSettings = {
	agentDir: string;
	packageGeneration: string;
	port: number;
	heartbeatTtlMs: number;
	resolveDirectoryMigration: (_cwd: string) => Promise<DirectoryMigrationPolicy>;
};

export type BrokerErrorCode =
	| "idempotency_conflict"
	| "terminal_uncertain"
	| "broker_restarting"
	| "unavailable"
	| "endpoint_stale"
	| "resource_gone"
	| "invalid_input"
	| "spawn_failed"
	| "readiness_timeout"
	| "close_refused"
	| "not_found"
	| "live_session"
	| "cleanup_pending"
	| (string & {});

export type BrokerCleanupIdentity = {
	dev: string;
	ino: string;
	size: number;
	mtimeNs: string;
	sha256: string;
};

/** Exact retry evidence; detached paths are managed-receipt references, never caller authority. */
export type BrokerLifecycleCleanupFile = {
	/** Original lifecycle-owned path, retained only for exact identity validation. */
	path: string;
	identity: BrokerCleanupIdentity;
	/** Monotonic append-only cleanup attempt. */
	attempt?: number;
	/** Immutable no-replace quarantine destination persisted before native detach. */
	plannedPath: string;
	/** Native-returned detached path, persisted after a failed post-detach cleanup. */
	detachedPath?: string;
	/** Append-only terminal proof for this exact artifact; completed entries are never retried. */
	completed?: true;
};

/** Durable root-tree authority for broker artifact cleanup. */
export type BrokerArtifactTree = {
	identity: BrokerCleanupIdentity;
	snapshot: NativeDirectoryTreeSnapshot;
	plannedPath: string;
	detachedPath?: string;
	completed?: true;
};

export type BrokerCleanupEvidence = {
	phase: "artifacts" | "transcript" | "metadata" | "lifecycle";
	/** Ledger-bound deletion target; never reconstructed from a retry request. */
	sessionsRoot?: string;
	transcriptPath?: string;
	cwd?: string;
	metadataRoot?: string;
	sessionId?: string;
	artifactsIdentity?: BrokerCleanupIdentity;
	transcriptIdentity?: BrokerCleanupIdentity;
	/** Identity-bound lifecycle metadata marker retained when exact cleanup is deferred. */
	metadataIdentity?: BrokerCleanupIdentity;
	metadataPath?: string;
	/** Monotonic append-only cleanup attempt. */
	metadataAttempt?: number;
	/** No-replace quarantine destination persisted before lifecycle metadata detach. */
	plannedMetadataPath?: string;
	/** Native-returned metadata quarantine path retained until identity-bound reconciliation succeeds. */
	detachedMetadataPath?: string;
	/** Append-only terminal proof for lifecycle metadata cleanup. */
	metadataCompleted?: true;
	detachedArtifactsPath?: string;
	detachedTranscriptPath?: string;
	/** Durable proof that artifact cleanup completed before transcript mutation. */
	artifactsRemoved?: boolean;
	/** Preauthorized no-replace artifact quarantine path persisted before detach. */
	plannedArtifactsPath?: string;
	/** Identity-bound artifact tree authority persisted before broker detach and replayed exactly. */
	artifactTree?: BrokerArtifactTree;
	/** Preauthorized no-replace transcript quarantine path persisted before detach. */
	plannedTranscriptPath?: string;
	/** Fully identity-bound startup-failure cleanup plan, persisted before any detach. */
	lifecycleFiles?: BrokerLifecycleCleanupFile[];
};
export type BrokerResponse =
	| { ok: true; result?: unknown; indexSeq?: number }
	| {
			ok: false;
			error: {
				code: BrokerErrorCode;
				message: string;
				endpoint?: "unavailable";
				cleanup?: BrokerCleanupEvidence;
			};
			indexSeq?: number;
			durableEffects?: LifecycleDurableEffectsReceipt;
			startupFailure?: LifecycleStartupFailureReceipt;
	  };
const error = (code: BrokerErrorCode, message: string): BrokerResponse => ({ ok: false, error: { code, message } });

type InputNormalization = { input: Record<string, unknown> } | BrokerResponse;

function isBrokerResponse(value: InputNormalization): value is BrokerResponse {
	return "ok" in value;
}

function normalizeAliasedString(
	input: Record<string, unknown>,
	canonical: string,
	aliases: readonly string[],
	normalize = (value: string) => value,
): { value: string | undefined; error?: string } {
	const supplied = [canonical, ...aliases].filter(name => input[name] !== undefined).map(name => input[name]);
	if (supplied.length === 0) return { value: undefined };
	if (supplied.some(value => typeof value !== "string" || value.length === 0))
		return { value: undefined, error: `${canonical} must be a non-empty string` };
	const values = supplied.map(value => normalize(value as string));
	if (values.some(value => value !== values[0])) return { value: undefined, error: `${canonical} aliases conflict` };
	return { value: values[0] };
}

function normalizeBrokerInput(operation: string, input: Record<string, unknown>): InputNormalization {
	const normalized: Record<string, unknown> = { ...input };
	const session = normalizeAliasedString(input, "sessionId", ["id"]);
	if (session.error) return error("invalid_input", session.error);
	if (session.value !== undefined) {
		if (!isCanonicalSessionId(session.value))
			return error("invalid_input", "sessionId must be a canonical safe identifier");
		normalized.sessionId = session.value;
		delete normalized.id;
	}
	const source = normalizeAliasedString(input, "sourceSessionId", ["sourceId"]);
	if (source.error) return error("invalid_input", source.error);
	if (source.value !== undefined) {
		if (!isCanonicalSessionId(source.value))
			return error("invalid_input", "sourceSessionId must be a canonical safe identifier");
		normalized.sourceSessionId = source.value;
		delete normalized.sourceId;
	}
	if (input.directoryMigration !== undefined)
		return error("invalid_input", "directoryMigration is broker-managed and cannot be selected by clients.");

	if (operation === "session.list") {
		const resolved = input.resolveSessionId;
		if (resolved !== undefined && (typeof resolved !== "string" || !isCanonicalSessionId(resolved)))
			return error("invalid_input", "resolveSessionId must be a canonical safe identifier");
		return { input: normalized };
	}
	if (
		operation !== "session.create" &&
		operation !== "session.fork" &&
		operation !== "session.resume" &&
		operation !== "session.close" &&
		operation !== "session.delete"
	)
		return { input: normalized };

	const target =
		typeof input.target === "object" && input.target !== null && !Array.isArray(input.target)
			? (input.target as Record<string, unknown>)
			: undefined;
	const cwd = normalizeAliasedString(
		{ cwd: input.cwd, path: input.path, targetPath: target?.path },
		"cwd",
		["path", "targetPath"],
		value => path.resolve(value),
	);
	if (cwd.error) return error("invalid_input", cwd.error);
	if (cwd.value !== undefined) {
		normalized.cwd = cwd.value;
		delete normalized.path;
	}
	const stateRoot = normalizeAliasedString(
		{ stateRoot: input.stateRoot, targetStateRoot: target?.stateRoot },
		"stateRoot",
		["targetStateRoot"],
		value => path.resolve(value),
	);
	if (stateRoot.error) return error("invalid_input", stateRoot.error);
	if (stateRoot.value !== undefined && (!cwd.value || stateRoot.value !== path.join(cwd.value, ".gjc", "state")))
		return error("invalid_input", "stateRoot must be the default .gjc/state for cwd.");
	if (cwd.value !== undefined) normalized.stateRoot = path.join(cwd.value, ".gjc", "state");
	else if (stateRoot.value !== undefined) return error("invalid_input", "stateRoot requires cwd.");

	if (target) {
		const normalizedTarget = { ...target };
		delete normalizedTarget.path;
		delete normalizedTarget.stateRoot;
		if (Object.keys(normalizedTarget).length > 0) normalized.target = normalizedTarget;
		else delete normalized.target;
	}
	return { input: normalized };
}
function canonicalJson(value: unknown): string {
	if (value === null || typeof value !== "object") return JSON.stringify(value);
	if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
	const record = value as Record<string, unknown>;
	return `{${Object.keys(record)
		.sort()
		.map(key => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
		.join(",")}}`;
}

type EndpointAuthority = { endpointGeneration?: number; endpointIncarnation?: string };
function endpointIncarnation(
	record: Pick<IndexedSession, "endpointGeneration" | "endpointMtimeMs" | "pid">,
	sessionId: string,
): string | undefined {
	if (
		!Number.isSafeInteger(record.endpointGeneration) ||
		record.endpointGeneration <= 0 ||
		!Number.isSafeInteger(record.pid) ||
		record.pid <= 0 ||
		typeof record.endpointMtimeMs !== "number" ||
		!Number.isFinite(record.endpointMtimeMs) ||
		record.endpointMtimeMs <= 0
	)
		return undefined;
	return createHash("sha256")
		.update(
			canonicalJson({
				endpointGeneration: record.endpointGeneration,
				endpointMtimeMs: record.endpointMtimeMs,
				pid: record.pid,
				sessionId,
			}),
		)
		.digest("hex");
}
function expectedEndpointAuthority(input: Record<string, unknown>): EndpointAuthority | BrokerResponse {
	const endpointGeneration = input.endpointGeneration;
	const endpointIncarnation = input.endpointIncarnation;
	if (
		endpointGeneration !== undefined &&
		(typeof endpointGeneration !== "number" || !Number.isSafeInteger(endpointGeneration) || endpointGeneration <= 0)
	)
		return error("invalid_input", "endpointGeneration must be a positive safe integer");
	if (
		endpointIncarnation !== undefined &&
		(typeof endpointIncarnation !== "string" || !/^[a-f0-9]{64}$/.test(endpointIncarnation))
	)
		return error("invalid_input", "endpointIncarnation must be a SHA-256 hash");
	if (endpointIncarnation !== undefined && endpointGeneration === undefined)
		return error("invalid_input", "endpointIncarnation requires endpointGeneration");
	return { endpointGeneration, endpointIncarnation };
}
function matchesEndpointAuthority(record: IndexedSession, authority: EndpointAuthority): boolean {
	return (
		(authority.endpointGeneration === undefined || authority.endpointGeneration === record.endpointGeneration) &&
		(authority.endpointIncarnation === undefined ||
			authority.endpointIncarnation === endpointIncarnation(record, record.sessionId))
	);
}
function sameEndpointRecord(expected: IndexedSession, current: IndexedSession): boolean {
	return (
		current.live &&
		current.endpointGeneration === expected.endpointGeneration &&
		current.pid === expected.pid &&
		current.endpointMtimeMs === expected.endpointMtimeMs &&
		path.resolve(current.locator.repo) === path.resolve(expected.locator.repo) &&
		path.resolve(current.locator.stateRoot) === path.resolve(expected.locator.stateRoot)
	);
}

function lifecycleTarget(operation: string, input: Record<string, unknown>): unknown {
	const target = input.target as Record<string, unknown> | undefined;
	const string = (...values: unknown[]): string | undefined =>
		values.find((value): value is string => typeof value === "string" && value.length > 0);
	const explicitRoot = string(input.stateRoot, target?.stateRoot);
	const root =
		explicitRoot ??
		(() => {
			const cwd = string(input.cwd, input.path, target?.path);
			return cwd ? path.join(cwd, ".gjc", "state") : undefined;
		})();
	const id = string(input.sessionId, input.id);
	switch (operation) {
		case "session.create":
			return { root };
		case "session.fork":
			return {
				root,
				sourceSessionId: string(input.sourceSessionId, input.sourceId),
				sourceSessionPath: string(input.sourceSessionPath, input.sourcePath, input.sessionPath),
			};
		case "session.resume":
		case "session.close":
		case "session.delete":
			return { sessionId: id };
		default:
			return { operation, root, sessionId: id };
	}
}

const BROKER_LOCK_RECORD = "owner.json";
const BROKER_LOCK_STARTUP_WAIT_MS = 1_000;
const BROKER_LOCK_RETRY_MS = 10;

type BrokerLockSnapshot = {
	ownerId?: string;
	pid: number;
	identity: string;
};

const terminalPersistenceHooksForTest = new WeakMap<Broker, () => void>();

export class Broker {
	readonly settings: ResolvedBrokerSettings;
	readonly index: SessionIndex;
	readonly ledger: LifecycleLedger;
	discovery: BrokerDiscovery | null = null;
	#lock: string;
	#owner = randomBytes(12).toString("hex");
	#chains = new Map<string, Promise<void>>();
	#stopping = false;
	#transport: BrokerTransport | null = null;
	#heartbeatTimer: ReturnType<typeof setInterval> | null = null;
	#heartbeatWrite: Promise<void> = Promise.resolve();
	constructor(settings: BrokerSettings) {
		this.settings = {
			agentDir: settings.agentDir,
			packageGeneration: settings.packageGeneration ?? "unknown",
			port: settings.port ?? 0,
			heartbeatTtlMs: settings.heartbeatTtlMs ?? BROKER_HEARTBEAT_TTL_MS,
			resolveDirectoryMigration: settings.resolveDirectoryMigration ?? (async () => "copy-retain"),
		};
		this.index = new SessionIndex(settings.agentDir);
		this.ledger = new LifecycleLedger(settings.agentDir);
		this.#lock = path.join(settings.agentDir, "sdk", "broker.lock");
	}
	#lockRecordPath(): string {
		return path.join(this.#lock, BROKER_LOCK_RECORD);
	}
	#lockSnapshot(raw: string): BrokerLockSnapshot {
		try {
			const lock = JSON.parse(raw) as { ownerId?: unknown; pid?: unknown };
			if (
				typeof lock.ownerId === "string" &&
				lock.ownerId.length > 0 &&
				typeof lock.pid === "number" &&
				Number.isInteger(lock.pid) &&
				lock.pid > 0
			)
				return { ownerId: lock.ownerId, pid: lock.pid, identity: `owner:${lock.ownerId}` };
		} catch {}
		return { pid: 0, identity: `contents:${createHash("sha256").update(raw).digest("hex")}` };
	}
	async #readLock(): Promise<BrokerLockSnapshot | null> {
		try {
			return this.#lockSnapshot(await fs.readFile(this.#lockRecordPath(), "utf8"));
		} catch (e) {
			const code = (e as NodeJS.ErrnoException).code;
			if (code === "ENOTDIR") {
				try {
					return this.#lockSnapshot(await fs.readFile(this.#lock, "utf8"));
				} catch (legacyError) {
					if ((legacyError as NodeJS.ErrnoException).code === "ENOENT") return null;
					throw legacyError;
				}
			}
			if (code !== "ENOENT") throw e;
		}
		try {
			const lock = await fs.stat(this.#lock);
			return lock.isDirectory() ? { pid: 0, identity: `directory:${lock.dev}:${lock.ino}` } : null;
		} catch (e) {
			if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
			throw e;
		}
	}
	async #createLock(): Promise<void> {
		await fs.mkdir(this.#lock, { mode: 0o700 });
		try {
			await fs.writeFile(
				this.#lockRecordPath(),
				JSON.stringify({ version: 1, ownerId: this.#owner, pid: process.pid, acquiredAt: Date.now() }),
				{ flag: "wx", mode: 0o600 },
			);
		} catch (e) {
			try {
				await fs.rmdir(this.#lock);
			} catch {}
			throw e;
		}
	}
	async #waitForBrokerDiscovery(): Promise<BrokerDiscovery | null> {
		const deadline = Date.now() + BROKER_LOCK_STARTUP_WAIT_MS;
		while (Date.now() < deadline) {
			const live = await readBrokerDiscovery(this.settings.agentDir, this.settings.heartbeatTtlMs);
			if (live) return live;
			await Bun.sleep(BROKER_LOCK_RETRY_MS);
		}
		return readBrokerDiscovery(this.settings.agentDir, this.settings.heartbeatTtlMs);
	}
	async #reclaimStaleLock(snapshot: BrokerLockSnapshot): Promise<void> {
		const current = await this.#readLock();
		if (!current || current.identity !== snapshot.identity || (current.pid > 0 && isPidAlive(current.pid))) return;

		// Keep the tombstone: its immutable-owner-derived pathname prevents a contender
		// holding an old snapshot from renaming a newly-created directory lock.
		const tombstone = path.join(
			path.dirname(this.#lock),
			`.broker.lock.stale-${createHash("sha256").update(snapshot.identity).digest("hex")}`,
		);
		try {
			await fs.rename(this.#lock, tombstone);
		} catch (e) {
			const code = (e as NodeJS.ErrnoException).code;
			if (["ENOENT", "EEXIST", "ENOTEMPTY", "EISDIR", "ENOTDIR"].includes(code ?? "")) return;
			if (code === "EPERM") {
				try {
					await fs.lstat(tombstone);
					return;
				} catch (statError) {
					if ((statError as NodeJS.ErrnoException).code !== "ENOENT") throw statError;
				}
			}
			throw e;
		}
	}
	async start(): Promise<BrokerDiscovery> {
		this.#stopping = false;
		await Promise.all([
			this.index.assertSupportedStateVersions(),
			this.ledger.assertSupportedStateVersions(),
			readBrokerDiscovery(this.settings.agentDir),
		]);
		await fs.mkdir(path.dirname(this.#lock), { recursive: true, mode: 0o700 });
		for (;;) {
			try {
				await this.#createLock();
				break;
			} catch (e) {
				if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
			}

			const live = await readBrokerDiscovery(this.settings.agentDir, this.settings.heartbeatTtlMs);
			if (live) {
				this.discovery = live;
				return live;
			}
			const snapshot = await this.#readLock();
			if (!snapshot) continue;
			if (snapshot.pid > 0 && isPidAlive(snapshot.pid)) {
				const starting = await this.#waitForBrokerDiscovery();
				if (starting) {
					this.discovery = starting;
					return starting;
				}
				const current = await this.#readLock();
				if (current && current.identity === snapshot.identity && current.pid > 0 && isPidAlive(current.pid))
					throw new Error("Broker lock is held by a live owner");
				continue;
			}
			await this.#reclaimStaleLock(snapshot);
		}
		await this.index.open();
		await this.ledger.open();
		const now = Date.now();
		const incarnation = brokerProcessIncarnation(process.pid);
		if (!incarnation) throw new Error("Broker process incarnation is unavailable.");
		const token = newBrokerToken();
		this.#transport = new BrokerTransport(this, token, this.settings.port);
		const port = await this.#transport.start();
		this.discovery = {
			version: 1,
			protocolVersion: 3,
			packageGeneration: this.settings.packageGeneration,
			ownerId: this.#owner,
			pid: process.pid,
			incarnation,
			host: "127.0.0.1",
			port,
			url: `ws://127.0.0.1:${port}`,
			token,
			startedAt: now,
			heartbeatAt: now,
		};
		await writeBrokerDiscovery(this.settings.agentDir, this.discovery);
		this.#heartbeatTimer = setInterval(
			() => void this.heartbeat(),
			Math.max(1, Math.floor(this.settings.heartbeatTtlMs / 3)),
		);
		return this.discovery;
	}
	get ownsDiscovery(): boolean {
		return this.discovery?.ownerId === this.#owner;
	}
	status(): ReturnType<typeof redactBrokerDiscovery> | null {
		return this.discovery ? redactBrokerDiscovery(this.discovery) : null;
	}
	async heartbeat(): Promise<void> {
		if (!this.discovery || this.discovery.ownerId !== this.#owner) return;
		this.discovery = { ...this.discovery, heartbeatAt: Date.now() };
		const discovery = this.discovery;
		this.#heartbeatWrite = this.#heartbeatWrite.then(() => writeBrokerDiscovery(this.settings.agentDir, discovery));
		await this.#heartbeatWrite;
	}
	async stop(): Promise<void> {
		this.#stopping = true;
		if (this.#heartbeatTimer) {
			clearInterval(this.#heartbeatTimer);
			this.#heartbeatTimer = null;
		}
		await this.#heartbeatWrite;
		await Promise.allSettled(this.#chains.values());
		await this.#transport?.stop();
		this.#transport = null;
		if (this.discovery?.ownerId === this.#owner) {
			try {
				const disk = JSON.parse(await fs.readFile(brokerDiscoveryPath(this.settings.agentDir), "utf8")) as {
					ownerId?: string;
				};
				if (disk.ownerId === this.#owner) await fs.unlink(brokerDiscoveryPath(this.settings.agentDir));
			} catch (e) {
				if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
			}
			try {
				const lock = await this.#readLock();
				if (lock?.ownerId === this.#owner) {
					await fs.unlink(this.#lockRecordPath());
					await fs.rmdir(this.#lock);
				}
			} catch (e) {
				if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
			}
		}
		this.discovery = null;
	}
	async #endpoint(input: Record<string, unknown>): Promise<BrokerResponse> {
		const sessionId = input.sessionId;
		if (typeof sessionId !== "string" || !isCanonicalSessionId(sessionId))
			return error("invalid_input", "sessionId must be a canonical safe identifier");
		const authority = expectedEndpointAuthority(input);
		if ("ok" in authority) return authority;
		await this.index.refresh();
		const record = this.index.listSessions().sessions.find(session => session.sessionId === sessionId);
		if (!record) return error("resource_gone", "session is not indexed");
		if (!record.live || !matchesEndpointAuthority(record, authority))
			return error("endpoint_stale", "session endpoint is stale");
		return this.#readEndpoint(record, authority);
	}
	async #readEndpoint(record: IndexedSession, authority: EndpointAuthority): Promise<BrokerResponse> {
		if (!isCanonicalSessionId(record.sessionId))
			return error("invalid_input", "indexed sessionId is not a canonical safe identifier");

		try {
			const endpointPath = path.join(record.locator.stateRoot, "sdk", `${record.sessionId}.json`);
			const [source, metadata] = await Promise.all([fs.readFile(endpointPath, "utf8"), fs.stat(endpointPath)]);
			const endpoint = JSON.parse(source) as Record<string, unknown>;
			if (
				endpoint.sessionId !== record.sessionId ||
				endpoint.pid !== record.pid ||
				endpoint.stale === true ||
				record.endpointMtimeMs === undefined ||
				metadata.mtimeMs !== record.endpointMtimeMs
			)
				return error("endpoint_stale", "session endpoint is stale");
			await this.index.refresh();
			const current = this.index.listSessions().sessions.find(session => session.sessionId === record.sessionId);
			if (!current || !sameEndpointRecord(record, current) || !matchesEndpointAuthority(current, authority))
				return error("endpoint_stale", "session endpoint is stale");
			return { ok: true, result: endpoint };
		} catch (e) {
			if ((e as NodeJS.ErrnoException).code === "ENOENT")
				return error("resource_gone", "session endpoint record is gone");
			throw e;
		}
	}
	async handleRequest(
		operation: string,
		input: Record<string, unknown>,
		idempotencyKey?: string,
	): Promise<BrokerResponse> {
		if (this.#stopping) return error("broker_restarting", "broker is stopping");
		const normalization = normalizeBrokerInput(operation, input);
		if (isBrokerResponse(normalization)) return normalization;
		input = normalization.input;
		if (operation === "session.list") {
			await this.index.refresh();
			const result = this.index.listSessions();
			const resolveSessionId = typeof input.resolveSessionId === "string" ? input.resolveSessionId : undefined;
			const cwd = typeof input.cwd === "string" ? input.cwd : undefined;
			if (resolveSessionId && cwd) {
				const scope = await resolveManagedSessionScope({ cwd, agentDir: this.settings.agentDir });
				const listed =
					scope.kind === "resolved" ? await listManagedSessionCandidates({ scope: scope.scope }) : undefined;
				const matches =
					listed?.kind === "complete"
						? listed.owned.filter(candidate => candidate.sessionId === resolveSessionId)
						: [];
				const match = matches.length === 1 ? matches[0] : undefined;
				return {
					ok: true,
					result: {
						...result,
						savedSession:
							match && match.sessionId === resolveSessionId
								? { id: match.sessionId, path: match.path }
								: undefined,
					},
					indexSeq: result.indexSeq,
				};
			}
			return { ok: true, result, indexSeq: result.indexSeq };
		}
		if (operation === "session.get_endpoint") return this.#endpoint(input);
		if (!idempotencyKey) return error("invalid_input", "idempotencyKey is required for lifecycle operations");
		const target = createHash("sha256")
			.update(canonicalJson(lifecycleTarget(operation, input)))
			.digest("hex");
		const identity = await deriveIdempotencyIdentity(this.settings.agentDir, operation, idempotencyKey, target);
		const requestHash = createHash("sha256").update(canonicalJson({ operation, input })).digest("hex");
		const prev = this.#chains.get(target) ?? Promise.resolve();
		let release!: () => void;
		const current = new Promise<void>(resolve => (release = resolve));
		this.#chains.set(
			target,
			prev.then(() => current),
		);
		await prev;
		try {
			const beforeBegin = this.ledger.get(identity);
			const begun = await this.ledger.begin(identity, requestHash);
			if (begun.kind === "replay") {
				const replay = begun.entry.response as BrokerResponse;
				if (!(!replay.ok && replay.error.cleanup)) return replay;
				const cleanup = replay.error.cleanup;
				const outcome = await executeLifecycle(this, operation, input, identity, cleanup);
				const response = outcome.response;
				await this.ledger.transition(identity, response.ok ? "terminal_ok" : "terminal_error", {
					response,
					responseDigest: createHash("sha256").update(canonicalJson(response)).digest("hex"),
					...(outcome.durableEffects ? { durableEffects: outcome.durableEffects } : {}),
					...(outcome.startupFailure ? { startupFailure: outcome.startupFailure } : {}),
				});
				return response;
			}
			if (begun.kind === "idempotency_conflict")
				return error("idempotency_conflict", "idempotency key was used with a different request");
			if (begun.kind === "terminal_uncertain") {
				const replay = (begun.entry.response ?? beforeBegin?.response) as BrokerResponse | undefined;
				if (!replay || replay.ok || !replay.error.cleanup)
					return replay ?? error("terminal_uncertain", "prior lifecycle operation outcome is uncertain");
				const outcome = await executeLifecycle(this, operation, input, identity, replay.error.cleanup);
				const response = outcome.response;
				await this.ledger.transition(identity, response.ok ? "terminal_ok" : "terminal_error", {
					response,
					responseDigest: createHash("sha256").update(canonicalJson(response)).digest("hex"),
					...(outcome.durableEffects ? { durableEffects: outcome.durableEffects } : {}),
					...(outcome.startupFailure ? { startupFailure: outcome.startupFailure } : {}),
				});
				return response;
			}
			if (begun.kind === "in_progress") return error("broker_restarting", "lifecycle operation is in progress");
			const outcome = await executeLifecycle(this, operation, input, identity);
			const response = outcome.response;
			await this.ledger.transition(
				identity,
				response.ok
					? "terminal_ok"
					: response.error.code === "terminal_uncertain"
						? "terminal_uncertain"
						: "terminal_error",
				{
					resultSessionId:
						response.ok && typeof (response.result as { sessionId?: unknown } | undefined)?.sessionId === "string"
							? (response.result as { sessionId: string }).sessionId
							: undefined,
					response,
					responseDigest: createHash("sha256").update(canonicalJson(response)).digest("hex"),
					...(outcome.durableEffects ? { durableEffects: outcome.durableEffects } : {}),
					...(outcome.startupFailure ? { startupFailure: outcome.startupFailure } : {}),
				},
			);
			const reopenedLedger = await new LifecycleLedger(this.settings.agentDir).open();
			const persisted = reopenedLedger.get(identity);
			const expectedResponseDigest = createHash("sha256").update(canonicalJson(response)).digest("hex");
			const persistenceVerified =
				persisted?.responseDigest === expectedResponseDigest &&
				canonicalJson(persisted.response) === canonicalJson(response) &&
				canonicalJson(persisted.durableEffects) === canonicalJson(outcome.durableEffects) &&
				canonicalJson(persisted.startupFailure) === canonicalJson(outcome.startupFailure);
			if (!persistenceVerified) {
				const uncertain = error(
					"terminal_uncertain",
					"Lifecycle terminal evidence could not be verified after persistence; retained artifacts require reconciliation.",
				);
				await this.ledger.transition(identity, "terminal_uncertain", {
					response: uncertain,
					responseDigest: createHash("sha256").update(canonicalJson(uncertain)).digest("hex"),
					...(outcome.durableEffects ? { durableEffects: outcome.durableEffects } : {}),
					...(outcome.startupFailure ? { startupFailure: outcome.startupFailure } : {}),
				});
				return uncertain;
			}
			terminalPersistenceHooksForTest.get(this)?.();
			await outcome.deferredArtifactCleanup?.();
			return response;
		} finally {
			release();
			if (this.#chains.get(target) === current) this.#chains.delete(target);
		}
	}
}

/** Test-only hook for simulating a process crash after terminal persistence verification. */
export function setTerminalPersistenceHookForTest(broker: Broker, hook: (() => void) | undefined): void {
	if (hook) terminalPersistenceHooksForTest.set(broker, hook);
	else terminalPersistenceHooksForTest.delete(broker);
}
