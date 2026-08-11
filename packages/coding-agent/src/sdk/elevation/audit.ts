import * as fsSync from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { assertSupportedStateVersion, SDK_STATE_VERSION } from "../broker/state-version";
import { classifyProcessIncarnationLiveness } from "./owner";

/**
 * Durable elevation audit trail.
 *
 * Append-only JSONL under the same elevation-local lock as the grant ledger,
 * mode 0600. Every state transition of a grant — issue, operator answer,
 * expiry, misuse, duplicate answer, claim, and dispatch outcome — is
 * recorded with the exact identity evidence the transition consumed, so an
 * auditor can reproduce why a grant reached its terminal state without
 * trusting in-memory state.
 *
 * The audit stream is an evidence trail, never an authority: audit rows are
 * append-only, are never re-read to drive decisions, and a corrupted row is
 * quarantined (like ledger rows) instead of failing the ledger.
 */
export type ElevationAuditEvent =
	| { kind: "issued" }
	| {
			kind: "answered";
			outcome: "granted" | "denied" | "expired" | "misused" | "target_unavailable" | "duplicate_answer";
	  }
	| { kind: "expired" }
	| { kind: "misused" }
	| { kind: "duplicate_answer" }
	| { kind: "claimed"; claim: { ownerId: string; epoch: number; pid: number; incarnation: string } }
	| {
			kind: "dispatched";
			dispatch: { ownerId: string; epoch: number; dispatchedAt: number };
			outcome: { status: "ok" | "failed"; code?: string; message?: string; dispatchedAt: number };
	  }
	| { kind: "consumed"; message: string }
	| { kind: "unavailable"; reason: string };

export interface ElevationAuditEntry {
	version: typeof SDK_STATE_VERSION;
	ts: number;
	elevationRequestId: string;
	issueIndex: number;
	event: ElevationAuditEvent;
}

export type ElevationAuditEventName = ElevationAuditEvent["kind"];

export function isElevationAuditEntry(value: unknown): value is ElevationAuditEntry {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
	const entry = value as {
		version?: unknown;
		ts?: unknown;
		elevationRequestId?: unknown;
		issueIndex?: unknown;
		event?: unknown;
	};
	if (
		entry.version !== SDK_STATE_VERSION ||
		!Number.isSafeInteger(entry.ts) ||
		(entry.ts as number) <= 0 ||
		typeof entry.elevationRequestId !== "string" ||
		entry.elevationRequestId.length === 0 ||
		!Number.isSafeInteger(entry.issueIndex) ||
		(entry.issueIndex as number) <= 0 ||
		typeof entry.event !== "object" ||
		entry.event === null ||
		Array.isArray(entry.event)
	)
		return false;
	const event = entry.event as { kind?: unknown };
	return typeof event.kind === "string" && event.kind.length > 0;
}

const AUDIT_FILE_NAME = "audit.jsonl";
const MAX_AUDIT_FILE_BYTES = 64 * 1024 * 1024;
const MAX_AUDIT_LINE_BYTES = 8 * 1024 * 1024;

export interface ElevationAuditOptions {
	/** Injectable clock. */
	now?: () => number;
	/**
	 * Injectable tri-state process-incarnation liveness classifier, defaulting
	 * to `classifyProcessIncarnationLiveness`. The audit trail records the
	 * liveness verdict behind `consumed`/`unavailable` settlements so the
	 * crash-truth settlement is reproducible; the verdict never drives the
	 * settlement itself (that lives in the ledger).
	 */
	classifyLiveness?: typeof classifyProcessIncarnationLiveness;
}

export class ElevationAudit {
	readonly #dir: string;
	readonly #file: string;
	#now: () => number;
	#classifyLiveness: typeof classifyProcessIncarnationLiveness;
	#warnings: string[] = [];

	constructor(agentDir: string, options: ElevationAuditOptions = {}) {
		this.#dir = path.join(agentDir, "sdk", "elevation");
		this.#file = path.join(this.#dir, AUDIT_FILE_NAME);
		this.#now = options.now ?? Date.now;
		this.#classifyLiveness = options.classifyLiveness ?? classifyProcessIncarnationLiveness;
	}

	get warnings(): readonly string[] {
		return this.#warnings;
	}

	/**
	 * Appends one audit row for an elevation grant transition. Callers MUST
	 * hold the same elevation-local lock that guards the grant ledger; the
	 * audit row and the grant row therefore commit together.
	 */
	async append(entry: Omit<ElevationAuditEntry, "version">): Promise<void> {
		const record: ElevationAuditEntry = { version: SDK_STATE_VERSION, ...entry };
		const line = Buffer.from(`${JSON.stringify(record)}\n`);
		if (line.length - 1 > MAX_AUDIT_LINE_BYTES)
			throw new Error("Elevation audit row exceeds the maximum byte length");
		const handle = await fs.open(
			this.#file,
			fsSync.constants.O_WRONLY | fsSync.constants.O_APPEND | fsSync.constants.O_CREAT | fsSync.constants.O_NOFOLLOW,
			0o600,
		);
		try {
			if (!(await handle.stat()).isFile()) throw new Error("Elevation audit target is not a regular file.");
			await handle.writeFile(line);
			await handle.sync();
		} finally {
			await handle.close();
		}
	}

	/**
	 * Opens the audit stream: creates the 0600 directory/file if absent and
	 * quarantines any corrupt tail so subsequent appends are always readable.
	 * Called under the same lock as `ElevationLedger.open()`.
	 */
	async open(): Promise<this> {
		await fs.mkdir(this.#dir, { recursive: true, mode: 0o700 });
		let source: Buffer | undefined;
		let handle: fs.FileHandle | undefined;
		try {
			handle = await fs.open(this.#file, fsSync.constants.O_RDONLY | fsSync.constants.O_NOFOLLOW);
			const stat = await handle.stat({ bigint: true });
			if (!stat.isFile()) throw new Error(`Elevation audit target is not a regular file: ${this.#file}`);
			if (stat.size > BigInt(MAX_AUDIT_FILE_BYTES))
				throw new Error(`Elevation audit file exceeds the maximum byte length: ${this.#file}`);
			const bytes = Buffer.alloc(Number(stat.size) + 1);
			const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0);
			source = bytes.subarray(0, bytesRead);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		} finally {
			if (handle) await handle.close();
		}
		if (!source) return this;
		const tornTail = source.length > 0 && source.at(-1) !== 0x0a;
		let lineStart = 0;
		for (let offset = 0; offset <= source.length; offset += 1) {
			if (offset !== source.length && source[offset] !== 0x0a) continue;
			const line = source.subarray(lineStart, offset);
			lineStart = offset + 1;
			if (line.length === 0) continue;
			if (line.length > MAX_AUDIT_LINE_BYTES) throw new Error("Elevation audit row exceeds the maximum byte length");
			try {
				const value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(line));
				assertSupportedStateVersion(this.#file, value);
				if (!isElevationAuditEntry(value)) throw new Error("invalid elevation audit entry");
			} catch (error) {
				if (error instanceof Error && "code" in error && error.code === "unsupported_state_version") throw error;
				const quarantine = await fs.open(
					`${this.#file}.corrupt`,
					fsSync.constants.O_WRONLY |
						fsSync.constants.O_APPEND |
						fsSync.constants.O_CREAT |
						fsSync.constants.O_NOFOLLOW,
					0o600,
				);
				try {
					await quarantine.writeFile(line);
					await quarantine.writeFile("\n");
					await quarantine.sync();
				} finally {
					await quarantine.close();
				}
				this.#warnings.push("Malformed elevation audit entry quarantined");
			}
		}
		if (tornTail) {
			const seal = await fs.open(
				this.#file,
				fsSync.constants.O_WRONLY |
					fsSync.constants.O_APPEND |
					fsSync.constants.O_CREAT |
					fsSync.constants.O_NOFOLLOW,
				0o600,
			);
			try {
				await seal.writeFile("\n");
				await seal.sync();
			} finally {
				await seal.close();
			}
		}
		return this;
	}
}
