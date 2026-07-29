/**
 * Session-scoped durable store for kind-aware invocation reconciliation (#3032/#3035).
 *
 * Path is always a private sibling of the transcript, never under artifactsDir:
 *   <dirname(sessionFile)>/.sdk-reconciliation/<safeSessionId>.json
 *
 * Safe session ids only: /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/
 * Atomic write: temp + fsync + rename + 0600. Corrupt → quarantine + empty.
 * Non-terminal skill records settle to failed/process_restart on bootstrap; prompt
 * records finalize their pending outcome or a prompt_failed fallback.
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { PromptReconciliationStatus, SdkPromptTerminalOutcome } from "../prompt-status";
import type { PromptCorrelation } from "./prompt-reconciliation";

export const RECONCILIATION_STORE_VERSION = 1;
export const RECONCILIATION_SESSION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
export const RECONCILIATION_DIR_NAME = ".sdk-reconciliation";

export type ReconciliationKind = "prompt" | "skill";

export interface DurableReconciliationRecord extends PromptCorrelation {
	kind: ReconciliationKind;
	clientRef?: string;
	status: PromptReconciliationStatus;
	error?: { code: string; message: string };
	acceptedAt: number;
	startedAt?: number;
	terminalAt?: number;
	outcome?: SdkPromptTerminalOutcome;
	pendingOutcome?: SdkPromptTerminalOutcome;
	/** Skill-only safe token; never skill args bodies. */
	skillName?: string;
}

export interface ReconciliationStoreDocument {
	version: typeof RECONCILIATION_STORE_VERSION;
	sessionId: string;
	records: DurableReconciliationRecord[];
}

export interface ReconciliationStoreFs {
	mkdir(directory: string, options: { recursive: true; mode: number }): Promise<unknown>;
	readFile(file: string, encoding: "utf8"): Promise<string>;
	writeFile(file: string, data: string, options: { mode: number }): Promise<void>;
	rename(from: string, to: string): Promise<void>;
	unlink(file: string): Promise<void>;
	open(
		file: string,
		flags: string,
	): Promise<{
		sync(): Promise<void>;
		close(): Promise<void>;
		writeFile(data: string, encoding: "utf8"): Promise<void>;
	}>;
}

const nodeFs: ReconciliationStoreFs = {
	mkdir: fs.mkdir,
	readFile: fs.readFile,
	writeFile: fs.writeFile,
	rename: fs.rename,
	unlink: fs.unlink,
	open: fs.open as ReconciliationStoreFs["open"],
};

export function isSafeReconciliationSessionId(sessionId: string): boolean {
	return RECONCILIATION_SESSION_ID_PATTERN.test(sessionId);
}

/** Derive private store path; throws if sessionId is unsafe (path escape). */
export function reconciliationStorePath(sessionFile: string, sessionId: string): string {
	if (!isSafeReconciliationSessionId(sessionId))
		throw Object.assign(new Error("Unsafe session id for reconciliation store path."), {
			code: "invalid_input",
		});
	return path.join(path.dirname(sessionFile), RECONCILIATION_DIR_NAME, `${sessionId}.json`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Record-level validation: JSON-valid but malformed entries must be quarantined too. */
function isValidRecord(value: unknown): boolean {
	if (!isRecord(value)) return false;
	const { kind, commandId, turnId, status, acceptedAt, terminalAt, outcome, pendingOutcome } = value;
	if (kind !== "prompt" && kind !== "skill") return false;
	if (typeof commandId !== "string" || !commandId || typeof turnId !== "string" || !turnId) return false;
	if (status !== "accepted" && status !== "in_flight" && status !== "terminal_ok" && status !== "failed") return false;
	if (typeof acceptedAt !== "number" || !Number.isFinite(acceptedAt)) return false;
	if (terminalAt !== undefined && (typeof terminalAt !== "number" || !Number.isFinite(terminalAt))) return false;
	// Durable invariants: only prompts carry a pending claim, a finalized record has no
	// pending claim left, and terminal/active status must agree with `terminalAt`.
	if (pendingOutcome !== undefined && kind !== "prompt") return false;
	if (pendingOutcome !== undefined && terminalAt !== undefined) return false;
	const isTerminalStatus = status === "terminal_ok" || status === "failed";
	if (isTerminalStatus !== (terminalAt !== undefined)) return false;
	if (outcome !== undefined && !isTerminalStatus) return false;
	if (
		outcome !== undefined &&
		((status === "terminal_ok" && (!isRecord(outcome) || outcome.kind !== "stopped")) ||
			(status === "failed" && (!isRecord(outcome) || outcome.kind !== "failed")))
	)
		return false;
	if (value.startedAt !== undefined && (typeof value.startedAt !== "number" || !Number.isFinite(value.startedAt)))
		return false;
	if (value.clientRef !== undefined && typeof value.clientRef !== "string") return false;
	if (value.skillName !== undefined && typeof value.skillName !== "string") return false;
	if (value.error !== undefined) {
		if (!isRecord(value.error)) return false;
		if (typeof value.error.code !== "string" || typeof value.error.message !== "string") return false;
	}
	return [outcome, pendingOutcome].every(candidate => {
		if (candidate === undefined) return true;
		if (!isRecord(candidate)) return false;
		if (candidate.kind === "stopped")
			return (
				["end_turn", "max_tokens", "max_turn_requests", "refusal", "cancelled"].includes(
					candidate.reason as string,
				) && ["agent", "client_cancel"].includes(candidate.provenance as string)
			);
		return (
			candidate.kind === "failed" &&
			["prompt_failed", "prompt_deadline_exceeded"].includes(candidate.code as string) &&
			typeof candidate.message === "string" &&
			["agent_failed", "deadline"].includes(candidate.provenance as string)
		);
	});
}

function parseDocument(raw: string, expectedSessionId: string): ReconciliationStoreDocument {
	const value = JSON.parse(raw) as unknown;
	if (!isRecord(value) || value.version !== RECONCILIATION_STORE_VERSION)
		throw new Error("invalid reconciliation store version");
	if (value.sessionId !== expectedSessionId) throw new Error("session id mismatch");
	if (!Array.isArray(value.records)) throw new Error("invalid records");
	if (!value.records.every(isValidRecord)) throw new Error("invalid reconciliation record");
	return value as unknown as ReconciliationStoreDocument;
}

/**
 * Settle non-terminal durable records after process death.
 * Prompt records preserve a durable pending outcome; skills retain the existing
 * reconciliation-incomplete result.
 */
export function settleProcessRestart(
	records: DurableReconciliationRecord[],
	now: number,
): DurableReconciliationRecord[] {
	return records.map(record => {
		if (record.terminalAt !== undefined) return record;
		if (record.kind === "prompt") {
			const outcome: SdkPromptTerminalOutcome = record.pendingOutcome ?? {
				kind: "failed",
				code: "prompt_failed",
				message: "Prompt did not complete before process restart.",
				provenance: "agent_failed",
			};
			return {
				...record,
				status: outcome.kind === "stopped" ? "terminal_ok" : "failed",
				terminalAt: now,
				outcome,
				pendingOutcome: undefined,
				...(outcome.kind === "failed" ? { error: { code: outcome.code, message: outcome.message } } : {}),
			};
		}
		return {
			...record,
			status: "failed",
			terminalAt: now,
			error: { code: "process_restart", message: "Reconciliation incomplete after process restart." },
		};
	});
}

export interface ReconciliationStore {
	readonly path: string | null;
	readonly sessionId: string;
	/** Serialize mutations; reload not required for single-process host (in-memory + write). */
	transact(mutator: (records: DurableReconciliationRecord[]) => DurableReconciliationRecord[]): Promise<void>;
	load(): Promise<DurableReconciliationRecord[]>;
	/** Snapshot currently held in memory after last load/transact. */
	snapshot(): DurableReconciliationRecord[];
	delete(): Promise<void>;
}

export function createReconciliationStore(options: {
	sessionFile: string | null | undefined;
	sessionId: string;
	fs?: ReconciliationStoreFs;
	now?: () => number;
}): ReconciliationStore {
	const fileFs = options.fs ?? nodeFs;
	const now = options.now ?? Date.now;
	const sessionId = options.sessionId;
	const filePath =
		options.sessionFile && isSafeReconciliationSessionId(sessionId)
			? reconciliationStorePath(options.sessionFile, sessionId)
			: null;

	let memory: DurableReconciliationRecord[] = [];
	let chain: Promise<void> = Promise.resolve();

	const writeAtomic = async (document: ReconciliationStoreDocument): Promise<void> => {
		if (!filePath) return;
		const directory = path.dirname(filePath);
		await fileFs.mkdir(directory, { recursive: true, mode: 0o700 });
		const temporary = `${filePath}.${process.pid}.${Date.now()}.tmp`;
		try {
			await fileFs.writeFile(temporary, `${JSON.stringify(document)}\n`, { mode: 0o600 });
			try {
				const handle = await fileFs.open(temporary, "r+");
				try {
					await handle.sync();
				} finally {
					await handle.close();
				}
			} catch {
				// fsync optional on some fs seams
			}
			await fileFs.rename(temporary, filePath);
		} catch (error) {
			await fileFs.unlink(temporary).catch(() => {});
			throw Object.assign(error instanceof Error ? error : new Error("reconciliation persist failed"), {
				code: "reconciliation_persist_failed",
			});
		}
	};

	const load = async (): Promise<DurableReconciliationRecord[]> => {
		if (!filePath) {
			memory = [];
			return memory;
		}
		let raw: string;
		try {
			raw = await fileFs.readFile(filePath, "utf8");
		} catch (error) {
			// Only a missing file is an empty store. Permission/IO failures must propagate
			// so the endpoint never becomes ready as if no prompt had been accepted.
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
			memory = [];
			return memory;
		}
		let document: ReconciliationStoreDocument;
		try {
			document = parseDocument(raw, sessionId);
		} catch {
			// Corrupt → quarantine
			try {
				await fileFs.rename(filePath, `${filePath}.corrupt.${now()}`);
			} catch {
				// ignore
			}
			memory = [];
			return memory;
		}
		const settled = settleProcessRestart(document.records, now());
		// Restart settlement must be durable before it is observable: a failed rewrite
		// propagates so the endpoint stays unready instead of serving empty state as if
		// no prompt had ever been accepted.
		if (settled.some((record, index) => record !== document.records[index]))
			await writeAtomic({ version: RECONCILIATION_STORE_VERSION, sessionId, records: settled });
		memory = settled;
		return memory;
	};

	const transact = async (
		mutator: (records: DurableReconciliationRecord[]) => DurableReconciliationRecord[],
	): Promise<void> => {
		const run = async () => {
			const next = mutator(memory.map(r => ({ ...r })));
			await writeAtomic({ version: RECONCILIATION_STORE_VERSION, sessionId, records: next });
			memory = next;
		};
		const pending = chain.then(run, run);
		chain = pending.then(
			() => undefined,
			() => undefined,
		);
		await pending;
	};

	const deleteStore = async (): Promise<void> => {
		memory = [];
		if (!filePath) return;
		await fileFs.unlink(filePath).catch(error => {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		});
	};

	return {
		path: filePath,
		sessionId,
		transact,
		load,
		snapshot: () => memory.map(r => ({ ...r })),
		delete: deleteStore,
	};
}
