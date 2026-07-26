/**
 * Session-scoped durable store for kind-aware invocation reconciliation (#3032/#3035).
 *
 * Path is always a private sibling of the transcript, never under artifactsDir:
 *   <dirname(sessionFile)>/.sdk-reconciliation/<safeSessionId>.json
 *
 * Safe session ids only: /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/
 * Atomic write: temp + fsync + rename + 0600. Corrupt → quarantine + empty.
 * Non-terminal records settle to failed/process_restart on bootstrap (recon incomplete).
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { PromptCorrelation, PromptReconciliationStatus } from "./prompt-reconciliation";

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

function parseDocument(raw: string, expectedSessionId: string): ReconciliationStoreDocument {
	const value = JSON.parse(raw) as unknown;
	if (!isRecord(value) || value.version !== RECONCILIATION_STORE_VERSION)
		throw new Error("invalid reconciliation store version");
	if (value.sessionId !== expectedSessionId) throw new Error("session id mismatch");
	if (!Array.isArray(value.records)) throw new Error("invalid records");
	return value as unknown as ReconciliationStoreDocument;
}

/**
 * Settle non-terminal durable records after process death: failed/process_restart.
 * Meaning: reconciliation incomplete — not proof of agent failure.
 */
export function settleProcessRestart(
	records: DurableReconciliationRecord[],
	now: number,
): DurableReconciliationRecord[] {
	return records.map(record => {
		if (record.terminalAt !== undefined) return record;
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
		try {
			const raw = await fileFs.readFile(filePath, "utf8");
			const document = parseDocument(raw, sessionId);
			memory = settleProcessRestart(document.records, now());
			// Persist settled state so restart is sticky.
			if (memory.some((r, i) => r !== document.records[i]))
				await writeAtomic({ version: RECONCILIATION_STORE_VERSION, sessionId, records: memory });
			return memory;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") {
				memory = [];
				return memory;
			}
			// Corrupt → quarantine
			try {
				await fileFs.rename(filePath, `${filePath}.corrupt.${now()}`);
			} catch {
				// ignore
			}
			memory = [];
			return memory;
		}
	};

	const transact = async (
		mutator: (records: DurableReconciliationRecord[]) => DurableReconciliationRecord[],
	): Promise<void> => {
		const run = async () => {
			const next = mutator(memory.map(r => ({ ...r })));
			memory = next;
			await writeAtomic({ version: RECONCILIATION_STORE_VERSION, sessionId, records: memory });
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
