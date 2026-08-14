import { randomUUID } from "node:crypto";
import * as fsSync from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { withFileLock } from "../../config/file-lock";
import { assertSupportedStateVersion, SDK_STATE_VERSION } from "../broker/state-version";
import { ElevationAudit, type ElevationAuditEntry } from "./audit";
import {
	ELEVATION_OPERATION_KINDS,
	type ElevationOperation,
	elevationRequestDigest,
	isKnownElevationOperation,
} from "./digest";
import {
	claimReceipt,
	dispatchReceipt,
	type ElevationAnswerAuthority,
	type ElevationClaimIdentity,
	type ElevationDispatchOutcome,
	type ElevationDispatchReceipt,
	isElevationAnswerAuthority,
	isElevationClaimIdentity,
	isElevationDispatchOutcome,
	isElevationDispatchReceipt,
	isElevationRequestId,
	receiptClaimMatches,
	uncertainReceipt,
} from "./dispatch-receipt";
import {
	type BrokerOwnerPrincipal,
	classifyProcessIncarnationLiveness,
	isBrokerOwnerPrincipal,
	sameBrokerOwnerPrincipal,
} from "./owner";

/**
 * Broker-owned elevation grant ledger.
 *
 * Durable state machine (per elevation request):
 * `requested -> granted -> claimed -> dispatched(outcome)`; terminal
 * `denied`/`expired`/`misused`/`target_unavailable`; crash truth
 * `consumed` (claimed but outcome unknown). Grants are single-use: the claim
 * CAS consumes the grant before dispatch, and a crash between consume and
 * dispatch is replayed truthfully as `consumed` with outcome `unknown`
 * (retry requires a new grant — fail closed).
 *
 * All mutations and reads serialize on one elevation-local
 * `withFileLock` transaction covering grants (`grants.jsonl`), dispatch
 * receipts (`receipts.jsonl`), the issue index (`index.json`), and the
 * audit trail (`audit.jsonl`), so a claim, its receipt, and the issue
 * sequence commit together.
 *
 * The answer boundary is internal operator-only: there is no public
 * `elevation.answer` operation; answers are admitted only from the internal
 * operator attestation, so requester self-approval is impossible by
 * construction.
 */
export type ElevationGrantState =
	| "requested"
	| "granted"
	| "claimed"
	| "dispatched"
	| "consumed"
	| "denied"
	| "expired"
	| "misused"
	| "target_unavailable";

export interface ElevationSessionIdentity {
	sessionId: string;
	/** Exact endpoint state root bound at issue time; never the repo root. */
	endpointStateRoot: string;
	endpointGeneration: number;
	endpointIncarnation: string;
}

/** Audit-only requester binding; never an identity claim. */
export interface ElevationRequester {
	source: "broker_connection";
	connectionId: string;
}

export interface ElevationGrantRecord {
	version: typeof SDK_STATE_VERSION;
	/** Durable correlation ID; UUID, path-safe. */
	elevationRequestId: string;
	/** Monotonic path-safe issue sequence, allocated under the ledger lock. */
	issueIndex: number;
	state: ElevationGrantState;
	operation: ElevationOperation;
	requestDigest: string;
	sessionIdentity: ElevationSessionIdentity;
	principal: BrokerOwnerPrincipal;
	requester: ElevationRequester;
	requestedAt: number;
	expiresAt: number;
	outcome?: ElevationDispatchOutcome;
	ts: number;
}

export type ElevationErrorCode =
	| "not_found"
	| "invalid_input"
	| "idempotency_conflict"
	| "grant_spent"
	| "elevation_claim_in_progress"
	| "elevation_required"
	| "elevation_unavailable"
	| "elevation_not_required"
	| "endpoint_stale"
	| "target_unavailable"
	| "expired"
	| "misused"
	| "duplicate_answer"
	| "terminal_uncertain"
	| (string & {});

export type ElevationResult<T> =
	| { ok: true; value: T }
	| { ok: false; error: { code: ElevationErrorCode; message: string } };

export interface ElevationIssueParams {
	/** Optional caller-supplied correlation ID for idempotent retry; the broker generates a UUID otherwise. */
	elevationRequestId?: string;
	operation: ElevationOperation;
	input: Record<string, unknown>;
	sessionIdentity: ElevationSessionIdentity;
	principal: BrokerOwnerPrincipal;
	requester: ElevationRequester;
	expiresInMs?: number;
}

export interface ElevationIssueValue {
	replay: boolean;
	elevationRequestId: string;
	issueIndex: number;
	requestDigest: string;
	state: ElevationGrantState;
	requestedAt: number;
	expiresAt: number;
	grant: ElevationGrantRecord;
}

export interface ElevationAnswerParams {
	elevationRequestId: string;
	answer: "approve" | "deny";
	/** Digest the answering surface presented from the gate payload. */
	presentedDigest: string;
	/** Broker-owner principal attesting the answer authority. */
	principal: BrokerOwnerPrincipal;
	answerer: ElevationAnswerAuthority;
	/** Current broker-resolved target identity; undefined means the session is unreachable. */
	currentSessionIdentity?: ElevationSessionIdentity;
}

export type ElevationAnswerOutcome =
	| "granted"
	| "denied"
	| "expired"
	| "misused"
	| "target_unavailable"
	| "duplicate_answer";

export interface ElevationAnswerValue {
	outcome: ElevationAnswerOutcome;
	grant: ElevationGrantRecord;
}

export interface ElevationClaimParams {
	elevationRequestId: string;
	claimIdentity: ElevationClaimIdentity;
	/** Current broker-resolved target identity; undefined means the session is unreachable. */
	currentSessionIdentity?: ElevationSessionIdentity;
}

export interface ElevationClaimValue {
	grant: ElevationGrantRecord;
	receipt: ElevationDispatchReceipt;
}

export interface ElevationDispatchParams {
	elevationRequestId: string;
	dispatchIdentity: ElevationClaimIdentity;
	outcome: ElevationDispatchOutcome;
}

export interface ElevationDispatchValue {
	grant: ElevationGrantRecord;
	receipt: ElevationDispatchReceipt;
}

export interface ElevationReadValue {
	grant: ElevationGrantRecord;
	receipt?: ElevationDispatchReceipt;
}

export interface ElevationListValue {
	grants: ElevationReadValue[];
}

export interface ElevationLedgerOptions {
	/** Defaults to the GJC_SDK_ELEVATION_ENABLED environment flag. */
	enabled?: boolean;
	/** Request lifetime before the grant expires. */
	ttlMs?: number;
	/** Injectable clock. */
	now?: () => number;
	/**
	 * Injectable tri-state process-incarnation liveness classifier (defaults to
	 * `classifyProcessIncarnationLiveness`). Test seam for crash-state replay:
	 * "unknown" must always fail closed as `elevation_claim_in_progress`.
	 */
	classifyLiveness?: typeof classifyProcessIncarnationLiveness;
}

const ELEVATION_DIR_NAME = "elevation";
const MAX_ELEVATION_FILE_BYTES = 64 * 1024 * 1024;
const MAX_ELEVATION_LINE_BYTES = 8 * 1024 * 1024;
const ELEVATION_REQUEST_TTL_MS = 60_000;
const SHA256_HEX = /^[a-f0-9]{64}$/;
const CANONICAL_SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const ELEVATION_GRANT_STATES = [
	"requested",
	"granted",
	"claimed",
	"dispatched",
	"consumed",
	"denied",
	"expired",
	"misused",
	"target_unavailable",
] as const;

const elevationUtf8Decoder = new TextDecoder("utf-8", { fatal: true });

function parseElevationJson(bytes: Uint8Array): unknown {
	return JSON.parse(elevationUtf8Decoder.decode(bytes));
}

function elevationEnabledByDefault(): boolean {
	const raw = (process.env.GJC_SDK_ELEVATION_ENABLED ?? "").trim().toLowerCase();
	return raw === "1" || raw === "true";
}

function elevationFailure<T>(code: ElevationErrorCode, message: string): ElevationResult<T> {
	return { ok: false, error: { code, message } };
}

function isElevationOperation(value: unknown): value is ElevationOperation {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
	const operation = value as { kind?: unknown; sdkId?: unknown };
	return (
		typeof operation.kind === "string" &&
		(ELEVATION_OPERATION_KINDS as readonly string[]).includes(operation.kind) &&
		typeof operation.sdkId === "string" &&
		operation.sdkId.length > 0 &&
		operation.sdkId.length <= 128 &&
		isKnownElevationOperation(operation.kind, operation.sdkId)
	);
}

function isElevationGrantState(value: unknown): value is ElevationGrantState {
	return typeof value === "string" && (ELEVATION_GRANT_STATES as readonly string[]).includes(value);
}

function isElevationSessionIdentity(value: unknown): value is ElevationSessionIdentity {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
	const identity = value as {
		sessionId?: unknown;
		endpointStateRoot?: unknown;
		endpointGeneration?: unknown;
		endpointIncarnation?: unknown;
	};
	return (
		typeof identity.sessionId === "string" &&
		CANONICAL_SESSION_ID.test(identity.sessionId) &&
		typeof identity.endpointStateRoot === "string" &&
		identity.endpointStateRoot.length > 0 &&
		Number.isSafeInteger(identity.endpointGeneration) &&
		(identity.endpointGeneration as number) > 0 &&
		typeof identity.endpointIncarnation === "string" &&
		SHA256_HEX.test(identity.endpointIncarnation)
	);
}

function isElevationRequester(value: unknown): value is ElevationRequester {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
	const requester = value as { source?: unknown; connectionId?: unknown };
	return (
		requester.source === "broker_connection" &&
		typeof requester.connectionId === "string" &&
		requester.connectionId.length > 0
	);
}

function isElevationGrantRecord(value: unknown): value is ElevationGrantRecord {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
	const record = value as Partial<ElevationGrantRecord>;
	if (
		record.version !== SDK_STATE_VERSION ||
		!isElevationRequestId(record.elevationRequestId) ||
		!Number.isSafeInteger(record.issueIndex) ||
		(record.issueIndex as number) <= 0 ||
		!isElevationGrantState(record.state) ||
		!isElevationOperation(record.operation) ||
		typeof record.requestDigest !== "string" ||
		!SHA256_HEX.test(record.requestDigest) ||
		!isElevationSessionIdentity(record.sessionIdentity) ||
		!isBrokerOwnerPrincipal(record.principal) ||
		!isElevationRequester(record.requester) ||
		!Number.isSafeInteger(record.requestedAt) ||
		(record.requestedAt as number) <= 0 ||
		!Number.isSafeInteger(record.expiresAt) ||
		(record.expiresAt as number) <= 0 ||
		!Number.isSafeInteger(record.ts) ||
		(record.ts as number) <= 0
	)
		return false;
	const outcome = record.outcome;
	if (record.state === "dispatched") return isElevationDispatchOutcome(outcome) && outcome.status !== "unknown";
	if (record.state === "consumed") return isElevationDispatchOutcome(outcome) && outcome.status === "unknown";
	return outcome === undefined;
}

function sameSessionIdentity(left: ElevationSessionIdentity, right: ElevationSessionIdentity): boolean {
	return (
		left.sessionId === right.sessionId &&
		path.resolve(left.endpointStateRoot) === path.resolve(right.endpointStateRoot) &&
		left.endpointGeneration === right.endpointGeneration &&
		left.endpointIncarnation === right.endpointIncarnation
	);
}

type ReconcileOutcome = "ok" | "expired" | "uncertain" | "in_progress";
export class ElevationLedger {
	#dir: string;
	#agentDir: string;
	#grantsFile: string;
	#receiptsFile: string;
	#indexFile: string;
	#audit: ElevationAudit;
	#enabled: boolean;
	#ttlMs: number;
	#now: () => number;
	#grants: ElevationGrantRecord[] = [];
	#receipts: ElevationDispatchReceipt[] = [];
	#byRequestId = new Map<string, ElevationGrantRecord>();
	#byReceiptRequestId = new Map<string, ElevationDispatchReceipt>();
	#nextIssueIndex = 1;
	#warnings: string[] = [];
	#classifyLiveness: typeof classifyProcessIncarnationLiveness;

	constructor(agentDir: string, options: ElevationLedgerOptions = {}) {
		this.#agentDir = agentDir;
		this.#dir = path.join(agentDir, "sdk", ELEVATION_DIR_NAME);
		this.#grantsFile = path.join(this.#dir, "grants.jsonl");
		this.#receiptsFile = path.join(this.#dir, "receipts.jsonl");
		this.#indexFile = path.join(this.#dir, "index.json");
		this.#audit = new ElevationAudit(agentDir, { now: options.now, classifyLiveness: options.classifyLiveness });
		this.#enabled = options.enabled ?? elevationEnabledByDefault();
		this.#ttlMs = options.ttlMs ?? ELEVATION_REQUEST_TTL_MS;
		this.#now = options.now ?? Date.now;
		this.#classifyLiveness = options.classifyLiveness ?? classifyProcessIncarnationLiveness;
	}

	get warnings(): readonly string[] {
		return this.#warnings;
	}

	/**
	 * One elevation-local lock serializes grants, receipts, and the issue
	 * index: the same transaction covers every file the ledger owns.
	 */
	async #mutate<T>(operation: () => Promise<T>): Promise<T> {
		return withFileLock(this.#grantsFile, operation);
	}

	async open(): Promise<this> {
		await this.#mutate(async () => this.#openUnderLock());
		return this;
	}

	async #openUnderLock(): Promise<void> {
		await fs.mkdir(this.#dir, { recursive: true, mode: 0o700 });
		this.#audit = await new ElevationAudit(this.#agentDir, {
			now: this.#now,
			classifyLiveness: this.#classifyLiveness,
		}).open();
		this.#grants = [];
		this.#receipts = [];
		this.#byRequestId.clear();
		this.#byReceiptRequestId.clear();
		this.#warnings = [];
		this.#warnings.push(...this.#audit.warnings);
		let nextIssueIndex = 1;
		const indexRaw = await this.#readIndex();
		if (indexRaw !== undefined) {
			let parsed: unknown;
			try {
				parsed = JSON.parse(indexRaw);
			} catch {
				throw new Error("Invalid elevation issue index");
			}
			assertSupportedStateVersion(this.#indexFile, parsed);
			const index = parsed as { nextIssueIndex?: unknown };
			if (!Number.isSafeInteger(index.nextIssueIndex) || (index.nextIssueIndex as number) < 1)
				throw new Error("Invalid elevation issue index");
			nextIssueIndex = index.nextIssueIndex as number;
		}
		const grantSource = await this.#readBoundedSource(this.#grantsFile);
		let maxIssueIndex = 0;
		if (grantSource) maxIssueIndex = await this.#loadGrantRows(grantSource);
		const receiptSource = await this.#readBoundedSource(this.#receiptsFile);
		if (receiptSource) await this.#loadReceiptRows(receiptSource);
		// Grants are the source of truth for issued indexes: a crash between
		// appending a grant row and rewriting index.json must never reuse it.
		const healed = Math.max(nextIssueIndex, maxIssueIndex + 1);
		if (healed !== nextIssueIndex) await this.#writeIndex(healed);
		this.#nextIssueIndex = healed;
	}

	async assertSupportedStateVersions(): Promise<void> {
		for (const file of [this.#grantsFile, this.#receiptsFile]) {
			const source = await this.#readBoundedSource(file);
			if (!source) continue;
			let lineStart = 0;
			for (let offset = 0; offset <= source.length; offset += 1) {
				if (offset !== source.length && source[offset] !== 0x0a) continue;
				const line = source.subarray(lineStart, offset);
				lineStart = offset + 1;
				if (line.length === 0 || line.length > MAX_ELEVATION_LINE_BYTES) continue;
				try {
					assertSupportedStateVersion(file, parseElevationJson(line));
				} catch (error) {
					if (error instanceof Error && "code" in error && error.code === "unsupported_state_version") throw error;
				}
			}
		}
	}

	async #readIndex(): Promise<string | undefined> {
		let handle: fs.FileHandle | undefined;
		try {
			handle = await fs.open(this.#indexFile, fsSync.constants.O_RDONLY | fsSync.constants.O_NOFOLLOW);
			const stat = await handle.stat();
			if (!stat.isFile()) throw new Error("Elevation issue index is not a regular file");
			if (stat.size > MAX_ELEVATION_LINE_BYTES)
				throw new Error("Elevation issue index exceeds the maximum byte length");
			const bytes = Buffer.alloc(stat.size + 1);
			const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0);
			return elevationUtf8Decoder.decode(bytes.subarray(0, bytesRead));
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
			throw error;
		} finally {
			if (handle) await handle.close();
		}
	}

	async #readBoundedSource(file: string): Promise<Buffer | undefined> {
		let handle: fs.FileHandle | undefined;
		try {
			handle = await fs.open(file, fsSync.constants.O_RDONLY | fsSync.constants.O_NOFOLLOW);
			const stat = await handle.stat({ bigint: true });
			if (!stat.isFile()) throw new Error(`Elevation ledger target is not a regular file: ${file}`);
			if (stat.size > BigInt(MAX_ELEVATION_FILE_BYTES))
				throw new Error(`Elevation ledger file exceeds the maximum byte length: ${file}`);
			const bytes = Buffer.alloc(Number(stat.size) + 1);
			const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0);
			return bytes.subarray(0, bytesRead);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
			throw error;
		} finally {
			if (handle) await handle.close();
		}
	}

	async #loadGrantRows(source: Buffer): Promise<number> {
		let maxIssueIndex = 0;
		const tornTail = source.length > 0 && source.at(-1) !== 0x0a;
		let lineStart = 0;
		for (let offset = 0; offset <= source.length; offset += 1) {
			if (offset !== source.length && source[offset] !== 0x0a) continue;
			const line = source.subarray(lineStart, offset);
			lineStart = offset + 1;
			if (line.length === 0) continue;
			if (line.length > MAX_ELEVATION_LINE_BYTES)
				throw new Error("Elevation grant row exceeds the maximum byte length");
			try {
				const value = parseElevationJson(line);
				assertSupportedStateVersion(this.#grantsFile, value);
				if (!isElevationGrantRecord(value)) throw new Error("invalid elevation grant record");
				this.#grants.push(value);
				this.#byRequestId.set(value.elevationRequestId, value);
				if (value.issueIndex > maxIssueIndex) maxIssueIndex = value.issueIndex;
			} catch (error) {
				if (error instanceof Error && "code" in error && error.code === "unsupported_state_version") throw error;
				await this.#quarantine(this.#grantsFile, line);
			}
		}
		if (tornTail) await this.#sealTornTail(this.#grantsFile);
		return maxIssueIndex;
	}

	async #loadReceiptRows(source: Buffer): Promise<void> {
		const tornTail = source.length > 0 && source.at(-1) !== 0x0a;
		let lineStart = 0;
		for (let offset = 0; offset <= source.length; offset += 1) {
			if (offset !== source.length && source[offset] !== 0x0a) continue;
			const line = source.subarray(lineStart, offset);
			lineStart = offset + 1;
			if (line.length === 0) continue;
			if (line.length > MAX_ELEVATION_LINE_BYTES)
				throw new Error("Elevation receipt row exceeds the maximum byte length");
			try {
				const value = parseElevationJson(line);
				assertSupportedStateVersion(this.#receiptsFile, value);
				if (!isElevationDispatchReceipt(value)) throw new Error("invalid elevation dispatch receipt");
				this.#receipts.push(value);
				this.#byReceiptRequestId.set(value.elevationRequestId, value);
			} catch (error) {
				if (error instanceof Error && "code" in error && error.code === "unsupported_state_version") throw error;
				await this.#quarantine(this.#receiptsFile, line);
			}
		}
		if (tornTail) await this.#sealTornTail(this.#receiptsFile);
	}

	async #openAppendRegular(file: string): Promise<fs.FileHandle> {
		const handle = await fs.open(
			file,
			fsSync.constants.O_WRONLY | fsSync.constants.O_APPEND | fsSync.constants.O_CREAT | fsSync.constants.O_NOFOLLOW,
			0o600,
		);
		try {
			if (!(await handle.stat()).isFile()) throw new Error("Elevation ledger write target is not a regular file.");
			return handle;
		} catch (error) {
			await handle.close();
			throw error;
		}
	}

	async #sealTornTail(file: string): Promise<void> {
		const h = await this.#openAppendRegular(file);
		try {
			await h.writeFile("\n");
			await h.sync();
		} finally {
			await h.close();
		}
	}

	async #quarantine(file: string, line: Uint8Array): Promise<void> {
		const h = await this.#openAppendRegular(`${file}.corrupt`);
		try {
			await h.writeFile(line);
			await h.writeFile("\n");
			await h.sync();
		} finally {
			await h.close();
		}
		this.#warnings.push("Malformed elevation ledger entry quarantined");
	}

	async #syncDirectory(): Promise<void> {
		const directory = await fs.open(this.#dir, fsSync.constants.O_RDONLY);
		try {
			await directory.sync();
		} finally {
			await directory.close();
		}
	}

	async #writeIndex(nextIssueIndex: number): Promise<void> {
		const contents = Buffer.from(`${JSON.stringify({ version: SDK_STATE_VERSION, nextIssueIndex })}\n`);
		const temporary = path.join(
			this.#dir,
			`.index.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`,
		);
		let renamed = false;
		try {
			const h = await fs.open(
				temporary,
				fsSync.constants.O_WRONLY |
					fsSync.constants.O_CREAT |
					fsSync.constants.O_EXCL |
					fsSync.constants.O_NOFOLLOW,
				0o600,
			);
			try {
				await h.writeFile(contents);
				await h.sync();
			} finally {
				await h.close();
			}
			await fs.rename(temporary, this.#indexFile);
			renamed = true;
			await this.#syncDirectory();
		} finally {
			if (!renamed) await fs.unlink(temporary).catch(() => {});
		}
	}

	async #appendGrant(record: ElevationGrantRecord): Promise<void> {
		const line = Buffer.from(`${JSON.stringify(record)}\n`);
		if (line.length - 1 > MAX_ELEVATION_LINE_BYTES)
			throw new Error("Elevation grant row exceeds the maximum byte length");
		const h = await this.#openAppendRegular(this.#grantsFile);
		try {
			await h.writeFile(line);
			await h.sync();
		} finally {
			await h.close();
		}
		this.#grants.push(record);
		this.#byRequestId.set(record.elevationRequestId, record);
	}

	async #appendReceipt(receipt: ElevationDispatchReceipt): Promise<void> {
		const line = Buffer.from(`${JSON.stringify(receipt)}\n`);
		if (line.length - 1 > MAX_ELEVATION_LINE_BYTES)
			throw new Error("Elevation receipt row exceeds the maximum byte length");
		const h = await this.#openAppendRegular(this.#receiptsFile);
		try {
			await h.writeFile(line);
			await h.sync();
		} finally {
			await h.close();
		}
		this.#receipts.push(receipt);
		this.#byReceiptRequestId.set(receipt.elevationRequestId, receipt);
	}

	/**
	 * Appends one audit row for an elevation transition. Must be called under
	 * the same elevation-local lock as the grant/receipt appends so the audit
	 * row and the durable grant row commit together.
	 */
	async #appendAudit(entry: Omit<ElevationAuditEntry, "version">): Promise<void> {
		await this.#audit.append(entry);
	}

	/**
	 * Truthful reconciliation before any access: heals a grant row that a
	 * crash left behind a terminal receipt, lazily expires overdue requests,
	 * and terminalizes claims left by provably dead broker tenures to
	 * `consumed`/`uncertain`. Unknown liveness always resolves to
	 * `in_progress` (fail closed — never fabricate an outcome).
	 */
	async #reconcile(
		grant: ElevationGrantRecord,
		receipt: ElevationDispatchReceipt | undefined,
		claimIdentity: ElevationClaimIdentity,
		now: number,
	): Promise<ReconcileOutcome> {
		if (receipt?.state === "dispatched") {
			if (grant.state !== "dispatched")
				await this.#appendGrant({ ...grant, state: "dispatched", outcome: receipt.outcome, ts: now });
			return "ok";
		}
		if (receipt?.state === "uncertain") {
			if (grant.state !== "consumed")
				await this.#appendGrant({ ...grant, state: "consumed", outcome: receipt.outcome, ts: now });
			return "uncertain";
		}
		if (receipt?.state === "claimed") {
			if (receiptClaimMatches(receipt, claimIdentity)) return "in_progress";
			const liveness = this.#classifyLiveness(receipt.claim.pid, receipt.claim.incarnation);
			if (liveness === "dead") {
				if (grant.state !== "consumed")
					await this.#appendGrant({
						...grant,
						state: "consumed",
						outcome: {
							status: "unknown",
							message: "Claiming broker tenure ended before dispatch outcome was recorded",
							dispatchedAt: now,
						},
						ts: now,
					});
				await this.#appendReceipt(uncertainReceipt(receipt, now));
				await this.#appendAudit({
					ts: now,
					elevationRequestId: grant.elevationRequestId,
					issueIndex: grant.issueIndex,
					event: {
						kind: "consumed",
						message: "Claiming broker tenure ended before dispatch outcome was recorded",
					},
				});
				return "uncertain";
			}
			// Alive or unknown liveness: the claim may still be in flight.
			return "in_progress";
		}
		if ((grant.state === "requested" || grant.state === "granted") && now > grant.expiresAt) {
			await this.#appendGrant({ ...grant, state: "expired", ts: now });
			await this.#appendAudit({
				ts: now,
				elevationRequestId: grant.elevationRequestId,
				issueIndex: grant.issueIndex,
				event: { kind: "expired" },
			});
			return "expired";
		}
		return "ok";
	}

	async issue(params: ElevationIssueParams): Promise<ElevationResult<ElevationIssueValue>> {
		if (!this.#enabled)
			return elevationFailure("elevation_unavailable", "Elevation is not enabled (GJC_SDK_ELEVATION_ENABLED)");
		if (!isElevationOperation(params.operation))
			return elevationFailure("invalid_input", "operation must be an allowlisted control/query/global operation");
		if (typeof params.input !== "object" || params.input === null || Array.isArray(params.input))
			return elevationFailure("invalid_input", "input must be a JSON object");
		if (!isElevationSessionIdentity(params.sessionIdentity))
			return elevationFailure("invalid_input", "sessionIdentity is malformed");
		if (!isBrokerOwnerPrincipal(params.principal))
			return elevationFailure("invalid_input", "principal must be the broker-owner principal");
		if (!isElevationRequester(params.requester)) return elevationFailure("invalid_input", "requester is malformed");
		if (params.elevationRequestId !== undefined && !isElevationRequestId(params.elevationRequestId))
			return elevationFailure("invalid_input", "elevationRequestId must be a UUID");
		if (
			params.expiresInMs !== undefined &&
			(!Number.isSafeInteger(params.expiresInMs) || params.expiresInMs <= 0 || params.expiresInMs > 15 * 60_000)
		)
			return elevationFailure(
				"invalid_input",
				"expiresInMs must be a positive safe integer no greater than 15 minutes",
			);
		const digestResult = elevationRequestDigest({
			kind: params.operation.kind,
			sdkId: params.operation.sdkId,
			input: params.input,
		});
		if (!digestResult.ok)
			return elevationFailure(digestResult.error.code as ElevationErrorCode, digestResult.error.message);
		const ttlMs = params.expiresInMs ?? this.#ttlMs;
		const requestId = params.elevationRequestId ?? randomUUID();
		return this.#mutate(async () => {
			const now = this.#now();
			const existing = this.#byRequestId.get(requestId);
			if (existing) {
				const identical =
					existing.requestDigest === digestResult.digest &&
					existing.operation.kind === params.operation.kind &&
					existing.operation.sdkId === params.operation.sdkId &&
					sameSessionIdentity(existing.sessionIdentity, params.sessionIdentity) &&
					sameBrokerOwnerPrincipal(existing.principal, params.principal);
				if (!identical)
					return elevationFailure(
						"idempotency_conflict",
						"elevationRequestId was used with different request content",
					);
				return {
					ok: true,
					value: {
						replay: true,
						elevationRequestId: existing.elevationRequestId,
						issueIndex: existing.issueIndex,
						requestDigest: existing.requestDigest,
						state: existing.state,
						requestedAt: existing.requestedAt,
						expiresAt: existing.expiresAt,
						grant: existing,
					},
				};
			}
			const grant: ElevationGrantRecord = {
				version: SDK_STATE_VERSION,
				elevationRequestId: requestId,
				issueIndex: this.#nextIssueIndex,
				state: "requested",
				operation: params.operation,
				requestDigest: digestResult.digest,
				sessionIdentity: params.sessionIdentity,
				principal: params.principal,
				requester: params.requester,
				requestedAt: now,
				expiresAt: now + ttlMs,
				ts: now,
			};
			this.#nextIssueIndex += 1;
			await this.#appendGrant(grant);
			await this.#appendAudit({
				ts: now,
				elevationRequestId: grant.elevationRequestId,
				issueIndex: grant.issueIndex,
				event: { kind: "issued" },
			});
			await this.#writeIndex(this.#nextIssueIndex);
			return {
				ok: true,
				value: {
					replay: false,
					elevationRequestId: grant.elevationRequestId,
					issueIndex: grant.issueIndex,
					requestDigest: grant.requestDigest,
					state: grant.state,
					requestedAt: grant.requestedAt,
					expiresAt: grant.expiresAt,
					grant,
				},
			};
		});
	}

	async answer(params: ElevationAnswerParams): Promise<ElevationResult<ElevationAnswerValue>> {
		if (!this.#enabled)
			return elevationFailure("elevation_unavailable", "Elevation is not enabled (GJC_SDK_ELEVATION_ENABLED)");
		if (!isElevationRequestId(params.elevationRequestId))
			return elevationFailure("invalid_input", "elevationRequestId must be a UUID");
		if (params.answer !== "approve" && params.answer !== "deny")
			return elevationFailure("invalid_input", "answer must be approve or deny");
		if (typeof params.presentedDigest !== "string" || !SHA256_HEX.test(params.presentedDigest))
			return elevationFailure("invalid_input", "presentedDigest must be a SHA-256 hash");
		if (!isBrokerOwnerPrincipal(params.principal))
			return elevationFailure("invalid_input", "principal must be the broker-owner principal");
		if (!isElevationAnswerAuthority(params.answerer))
			return elevationFailure("invalid_input", "answerer is malformed");
		if (params.currentSessionIdentity !== undefined && !isElevationSessionIdentity(params.currentSessionIdentity))
			return elevationFailure("invalid_input", "currentSessionIdentity is malformed");
		return this.#mutate(async () => {
			const now = this.#now();
			const grant = this.#byRequestId.get(params.elevationRequestId);
			if (!grant) return elevationFailure("not_found", "elevation request was not found");
			const receipt = this.#byReceiptRequestId.get(params.elevationRequestId);
			if (receipt !== undefined) {
				await this.#appendAudit({
					ts: now,
					elevationRequestId: grant.elevationRequestId,
					issueIndex: grant.issueIndex,
					event: { kind: "duplicate_answer" },
				});
				return { ok: true, value: { outcome: "duplicate_answer", grant } };
			}
			if ((grant.state === "requested" || grant.state === "granted") && now > grant.expiresAt) {
				const expired: ElevationGrantRecord = { ...grant, state: "expired", ts: now };
				await this.#appendGrant(expired);
				await this.#appendAudit({
					ts: now,
					elevationRequestId: grant.elevationRequestId,
					issueIndex: grant.issueIndex,
					event: { kind: "answered", outcome: "expired" },
				});
				return { ok: true, value: { outcome: "expired", grant: expired } };
			}
			if (grant.state !== "requested") {
				await this.#appendAudit({
					ts: now,
					elevationRequestId: grant.elevationRequestId,
					issueIndex: grant.issueIndex,
					event: { kind: "duplicate_answer" },
				});
				return { ok: true, value: { outcome: "duplicate_answer", grant } };
			}
			if (!sameBrokerOwnerPrincipal(params.principal, grant.principal)) {
				const misused: ElevationGrantRecord = { ...grant, state: "misused", ts: now };
				await this.#appendGrant(misused);
				await this.#appendAudit({
					ts: now,
					elevationRequestId: grant.elevationRequestId,
					issueIndex: grant.issueIndex,
					event: { kind: "answered", outcome: "misused" },
				});
				return { ok: true, value: { outcome: "misused", grant: misused } };
			}
			if (params.presentedDigest !== grant.requestDigest) {
				const misused: ElevationGrantRecord = { ...grant, state: "misused", ts: now };
				await this.#appendGrant(misused);
				await this.#appendAudit({
					ts: now,
					elevationRequestId: grant.elevationRequestId,
					issueIndex: grant.issueIndex,
					event: { kind: "answered", outcome: "misused" },
				});
				return { ok: true, value: { outcome: "misused", grant: misused } };
			}
			if (params.currentSessionIdentity === undefined) {
				const unavailable: ElevationGrantRecord = { ...grant, state: "target_unavailable", ts: now };
				await this.#appendGrant(unavailable);
				await this.#appendAudit({
					ts: now,
					elevationRequestId: grant.elevationRequestId,
					issueIndex: grant.issueIndex,
					event: { kind: "answered", outcome: "target_unavailable" },
				});
				return { ok: true, value: { outcome: "target_unavailable", grant: unavailable } };
			}
			if (!sameSessionIdentity(params.currentSessionIdentity, grant.sessionIdentity)) {
				const misused: ElevationGrantRecord = { ...grant, state: "misused", ts: now };
				await this.#appendGrant(misused);
				await this.#appendAudit({
					ts: now,
					elevationRequestId: grant.elevationRequestId,
					issueIndex: grant.issueIndex,
					event: { kind: "answered", outcome: "misused" },
				});
				return { ok: true, value: { outcome: "misused", grant: misused } };
			}
			if (params.answer === "deny") {
				const denied: ElevationGrantRecord = { ...grant, state: "denied", ts: now };
				await this.#appendGrant(denied);
				await this.#appendAudit({
					ts: now,
					elevationRequestId: grant.elevationRequestId,
					issueIndex: grant.issueIndex,
					event: { kind: "answered", outcome: "denied" },
				});
				return { ok: true, value: { outcome: "denied", grant: denied } };
			}
			const granted: ElevationGrantRecord = { ...grant, state: "granted", ts: now };
			await this.#appendGrant(granted);
			await this.#appendAudit({
				ts: now,
				elevationRequestId: grant.elevationRequestId,
				issueIndex: grant.issueIndex,
				event: { kind: "answered", outcome: "granted" },
			});
			return { ok: true, value: { outcome: "granted", grant: granted } };
		});
	}

	async claim(params: ElevationClaimParams): Promise<ElevationResult<ElevationClaimValue>> {
		if (!isElevationRequestId(params.elevationRequestId))
			return elevationFailure("invalid_input", "elevationRequestId must be a UUID");
		if (!isElevationClaimIdentity(params.claimIdentity))
			return elevationFailure("invalid_input", "claimIdentity is malformed");
		if (params.currentSessionIdentity !== undefined && !isElevationSessionIdentity(params.currentSessionIdentity))
			return elevationFailure("invalid_input", "currentSessionIdentity is malformed");
		return this.#mutate(async () => {
			const now = this.#now();
			const grant = this.#byRequestId.get(params.elevationRequestId);
			if (!grant) return elevationFailure("not_found", "elevation request was not found");
			const receipt = this.#byReceiptRequestId.get(params.elevationRequestId);
			const reconciled = await this.#reconcile(grant, receipt, params.claimIdentity, now);
			if (reconciled === "in_progress")
				return elevationFailure("elevation_claim_in_progress", "elevation claim is already in progress");
			if (reconciled === "uncertain")
				return elevationFailure(
					"terminal_uncertain",
					"elevation grant was consumed with an unknown dispatch outcome; retry requires a new grant",
				);
			if (reconciled === "expired") return elevationFailure("expired", "elevation grant has expired");
			const current = this.#byRequestId.get(params.elevationRequestId) ?? grant;
			if (current.state === "requested")
				return elevationFailure("elevation_required", "elevation request has not been granted");
			if (current.state === "claimed")
				return elevationFailure("elevation_claim_in_progress", "elevation claim is already in progress");
			if (current.state !== "granted")
				return elevationFailure("grant_spent", "elevation grant is already spent or terminal");
			if (params.currentSessionIdentity === undefined)
				return elevationFailure("target_unavailable", "session endpoint is unreachable at claim time");
			if (!sameSessionIdentity(params.currentSessionIdentity, current.sessionIdentity))
				return elevationFailure(
					"endpoint_stale",
					"session endpoint identity no longer matches the elevation grant",
				);
			const claimed: ElevationGrantRecord = { ...current, state: "claimed", ts: now };
			// Receipt before grant: if a crash lands between the two appends
			// the receipt is authoritative, and the next access truthfully
			// terminalizes the claim.
			const receiptRecord = claimReceipt(current.elevationRequestId, current.issueIndex, params.claimIdentity, now);
			await this.#appendReceipt(receiptRecord);
			await this.#appendGrant(claimed);
			await this.#appendAudit({
				ts: now,
				elevationRequestId: current.elevationRequestId,
				issueIndex: current.issueIndex,
				event: {
					kind: "claimed",
					claim: {
						ownerId: params.claimIdentity.ownerId,
						epoch: params.claimIdentity.epoch,
						pid: params.claimIdentity.pid,
						incarnation: params.claimIdentity.incarnation,
					},
				},
			});
			return { ok: true, value: { grant: claimed, receipt: receiptRecord } };
		});
	}

	async dispatch(params: ElevationDispatchParams): Promise<ElevationResult<ElevationDispatchValue>> {
		if (!isElevationRequestId(params.elevationRequestId))
			return elevationFailure("invalid_input", "elevationRequestId must be a UUID");
		if (!isElevationClaimIdentity(params.dispatchIdentity))
			return elevationFailure("invalid_input", "dispatchIdentity is malformed");
		if (!isElevationDispatchOutcome(params.outcome)) return elevationFailure("invalid_input", "outcome is malformed");
		if (params.outcome.status === "unknown")
			return elevationFailure("invalid_input", "dispatch outcome unknown is reserved for crash replay");
		return this.#mutate(async () => {
			const now = this.#now();
			const grant = this.#byRequestId.get(params.elevationRequestId);
			if (!grant) return elevationFailure("not_found", "elevation request was not found");
			const receipt = this.#byReceiptRequestId.get(params.elevationRequestId);
			if (!receipt)
				return elevationFailure("elevation_claim_in_progress", "elevation grant was not claimed before dispatch");
			if (receipt.state === "claimed" && !receiptClaimMatches(receipt, params.dispatchIdentity)) {
				const liveness = this.#classifyLiveness(receipt.claim.pid, receipt.claim.incarnation);
				if (liveness === "dead") {
					if (grant.state !== "consumed")
						await this.#appendGrant({
							...grant,
							state: "consumed",
							outcome: {
								status: "unknown",
								message: "Claiming broker tenure ended before dispatch outcome was recorded",
								dispatchedAt: now,
							},
							ts: now,
						});
					await this.#appendReceipt(uncertainReceipt(receipt, now));
					await this.#appendAudit({
						ts: now,
						elevationRequestId: grant.elevationRequestId,
						issueIndex: grant.issueIndex,
						event: {
							kind: "consumed",
							message: "Claiming broker tenure ended before dispatch outcome was recorded",
						},
					});
					return elevationFailure(
						"terminal_uncertain",
						"elevation grant dispatch outcome is unknown; retry requires a new grant",
					);
				}
				return elevationFailure(
					"elevation_claim_in_progress",
					"elevation grant is claimed by another broker tenure",
				);
			}
			if (receipt.state === "dispatched") {
				if (
					receipt.dispatch === undefined ||
					receipt.dispatch.ownerId !== params.dispatchIdentity.ownerId ||
					receipt.dispatch.epoch !== params.dispatchIdentity.epoch
				)
					return elevationFailure("grant_spent", "elevation grant was dispatched by another broker tenure");
				return { ok: true, value: { grant, receipt } };
			}
			if (receipt.state === "uncertain")
				return elevationFailure(
					"terminal_uncertain",
					"elevation grant dispatch outcome is unknown; retry requires a new grant",
				);
			if (grant.state !== "claimed")
				return elevationFailure("grant_spent", "elevation grant is not in the claimed state");
			const dispatchedGrant: ElevationGrantRecord = {
				...grant,
				state: "dispatched",
				outcome: params.outcome,
				ts: now,
			};
			const dispatchedReceipt = dispatchReceipt(
				receipt,
				{
					ownerId: params.dispatchIdentity.ownerId,
					epoch: params.dispatchIdentity.epoch,
					dispatchedAt: now,
				},
				params.outcome,
			);
			await this.#appendReceipt(dispatchedReceipt);
			await this.#appendGrant(dispatchedGrant);
			await this.#appendAudit({
				ts: now,
				elevationRequestId: grant.elevationRequestId,
				issueIndex: grant.issueIndex,
				event: {
					kind: "dispatched",
					dispatch: {
						ownerId: params.dispatchIdentity.ownerId,
						epoch: params.dispatchIdentity.epoch,
						dispatchedAt: now,
					},
					outcome:
						params.outcome.status === "ok"
							? { status: "ok", dispatchedAt: params.outcome.dispatchedAt }
							: {
									status: "failed",
									code: params.outcome.status === "failed" ? params.outcome.code : "dispatch_failed",
									message: params.outcome.message,
									dispatchedAt: params.outcome.dispatchedAt,
								},
				},
			});
			return { ok: true, value: { grant: dispatchedGrant, receipt: dispatchedReceipt } };
		});
	}

	/** Pure read without reconciliation writes; used before actions. */
	async get(elevationRequestId: string): Promise<ElevationResult<ElevationReadValue>> {
		if (!isElevationRequestId(elevationRequestId))
			return elevationFailure("invalid_input", "elevationRequestId must be a UUID");
		return this.#mutate(async () => {
			const grant = this.#byRequestId.get(elevationRequestId);
			if (!grant) return elevationFailure("not_found", "elevation request was not found");
			return { ok: true, value: { grant, receipt: this.#byReceiptRequestId.get(elevationRequestId) } };
		});
	}

	/** Truthful read: reconciles expiry and crash-state claims before returning. */
	async resolve(
		elevationRequestId: string,
		claimIdentity: ElevationClaimIdentity,
	): Promise<ElevationResult<ElevationReadValue>> {
		if (!isElevationRequestId(elevationRequestId))
			return elevationFailure("invalid_input", "elevationRequestId must be a UUID");
		if (!isElevationClaimIdentity(claimIdentity))
			return elevationFailure("invalid_input", "claimIdentity is malformed");
		return this.#mutate(async () => {
			const grant = this.#byRequestId.get(elevationRequestId);
			if (!grant) return elevationFailure("not_found", "elevation request was not found");
			const receipt = this.#byReceiptRequestId.get(elevationRequestId);
			await this.#reconcile(grant, receipt, claimIdentity, this.#now());
			const current = this.#byRequestId.get(elevationRequestId) ?? grant;
			return { ok: true, value: { grant: current, receipt: this.#byReceiptRequestId.get(elevationRequestId) } };
		});
	}

	/** Truthful listing: reconciles every grant before returning. */
	async list(claimIdentity: ElevationClaimIdentity): Promise<ElevationResult<ElevationListValue>> {
		if (!isElevationClaimIdentity(claimIdentity))
			return elevationFailure("invalid_input", "claimIdentity is malformed");
		return this.#mutate(async () => {
			const now = this.#now();
			const items: ElevationReadValue[] = [];
			for (const grant of this.#byRequestId.values()) {
				const receipt = this.#byReceiptRequestId.get(grant.elevationRequestId);
				await this.#reconcile(grant, receipt, claimIdentity, now);
				const current = this.#byRequestId.get(grant.elevationRequestId) ?? grant;
				items.push({ grant: current, receipt: this.#byReceiptRequestId.get(grant.elevationRequestId) });
			}
			return { ok: true, value: { grants: items } };
		});
	}
}

export { isElevationGrantRecord, isElevationOperation };
