import { randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { isProcessIncarnation, processIncarnation } from "../broker/process-incarnation";

export const CONVERSATION_STORE_VERSION = 1;
export const MAX_DEDUPE_IDS = 128;

export interface ConversationRecord {
	generation: number;
}

export interface ConversationStoreDocument<T extends ConversationRecord> {
	version: typeof CONVERSATION_STORE_VERSION;
	conversations: Record<string, T>;
}

export interface ConversationStoreFileHandle {
	sync(): Promise<void>;
	close(): Promise<void>;
	writeFile(data: string, encoding: "utf8"): Promise<void>;
}

/** Minimal persistence seam; callers can inject it to make durability failures deterministic. */
export interface ConversationStoreFs {
	mkdir(directory: string, options: { recursive: true; mode: number }): Promise<unknown>;
	chmod(target: string, mode: number): Promise<void>;
	readFile(file: string, encoding: "utf8"): Promise<string>;
	writeFile(file: string, data: string, options: { mode: number }): Promise<void>;
	rename(from: string, to: string): Promise<void>;
	unlink(file: string): Promise<void>;
	open(file: string, flags: string): Promise<ConversationStoreFileHandle>;
	stat?(file: string): Promise<{ mtimeMs: number }>;
}

export class ConversationLockTimeoutError extends Error {
	constructor(
		readonly lockFile: string,
		readonly timeoutMs: number,
	) {
		super(`Timed out waiting ${timeoutMs}ms for conversation store lock: ${lockFile}`);
		this.name = "ConversationLockTimeoutError";
	}
}

interface ConversationStoreLock {
	pid: number;
	incarnation: string;
	timestamp: number;
}

const nodeFs: ConversationStoreFs = fs;
const UNPUBLISHED_LOCK_STALE_MS = 30_000;

export function conversationStorePath(agentDir: string, kind: string, fileName = "conversations.json"): string {
	return path.join(agentDir, "sdk", "daemons", kind, fileName);
}

export function boundedDedupe(ids: readonly string[], limit = MAX_DEDUPE_IDS): string[] {
	const unique: string[] = [];
	const seen = new Set<string>();
	for (const id of ids) {
		if (!id || seen.has(id)) continue;
		seen.add(id);
		unique.push(id);
	}
	return unique.length <= limit ? unique : unique.slice(unique.length - limit);
}

function emptyDocument<T extends ConversationRecord>(): ConversationStoreDocument<T> {
	return { version: CONVERSATION_STORE_VERSION, conversations: {} };
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Durable, per-transport mapping store. Every mutation takes an exclusive
 * lock file shared across processes and reloads the on-disk document before
 * applying its monotonic-generation compare-and-swap, preventing either stale
 * writers or unrelated-key updates from replacing newer mappings.
 */
export class ConversationStore<T extends ConversationRecord> {
	readonly #directory: string;
	readonly #file: string;
	readonly #fs: ConversationStoreFs;
	readonly #clock: () => number;
	readonly #locks = new Map<string, Promise<void>>();
	readonly #pid: number;
	readonly #pidIncarnation: (pid: number) => string | undefined;
	readonly #pidAlive: (pid: number) => boolean;
	readonly #sleep: (ms: number) => Promise<void>;
	readonly #lockTimeoutMs: number;

	constructor(input: {
		agentDir: string;
		kind: string;
		fileName?: string;
		fs?: ConversationStoreFs;
		now?: () => number;
		pid?: number;
		pidIncarnation?: (pid: number) => string | undefined;
		pidAlive?: (pid: number) => boolean;
		sleep?: (ms: number) => Promise<void>;
		lockTimeoutMs?: number;
	}) {
		this.#file = conversationStorePath(input.agentDir, input.kind, input.fileName);
		this.#directory = path.dirname(this.#file);
		this.#fs = input.fs ?? nodeFs;
		this.#clock = input.now ?? Date.now;
		this.#pid = input.pid ?? process.pid;
		this.#pidIncarnation = input.pidIncarnation ?? processIncarnation;
		this.#pidAlive = input.pidAlive ?? defaultPidAlive;
		this.#sleep = input.sleep ?? (async ms => await Bun.sleep(ms));
		this.#lockTimeoutMs = input.lockTimeoutMs ?? 1_000;
	}

	get filePath(): string {
		return this.#file;
	}

	async load(): Promise<ConversationStoreDocument<T>> {
		return this.#readDocument();
	}

	async read(key: string): Promise<T | undefined> {
		return (await this.#readDocument()).conversations[key];
	}

	/**
	 * Atomically write one mapping when its observed generation still matches.
	 * `undefined` only creates an absent mapping; successful writes must advance
	 * the generation by exactly one.
	 */
	async write(key: string, expectedGeneration: number | undefined, record: T): Promise<boolean> {
		return this.#withLock(async () => {
			const document = await this.#readDocument();
			const current = document.conversations[key];
			if (current?.generation !== expectedGeneration) return false;
			if (!current && expectedGeneration !== undefined) return false;
			const nextGeneration = (expectedGeneration ?? 0) + 1;
			if (record.generation !== nextGeneration) {
				throw new Error(`Conversation generation must advance to ${nextGeneration}`);
			}
			document.conversations[key] = record;
			await this.#persist(document);
			return true;
		});
	}
	async delete(key: string, expectedGeneration: number): Promise<boolean> {
		return this.#withLock(async () => {
			const document = await this.#readDocument();
			const current = document.conversations[key];
			if (!current || current.generation !== expectedGeneration) return false;
			delete document.conversations[key];
			await this.#persist(document);
			return true;
		});
	}

	/** Apply a synchronous update under the mapping lock, retrying no stale state. */
	async transact(key: string, update: (current: T | undefined) => T | undefined): Promise<T | undefined> {
		return this.#withLock(async () => {
			const document = await this.#readDocument();
			const current = document.conversations[key];
			const next = update(current);
			if (!next || next === current) return current;
			const expectedGeneration = current?.generation;
			const expectedNext = (expectedGeneration ?? 0) + 1;
			if (next.generation !== expectedNext) {
				throw new Error(`Conversation generation must advance to ${expectedNext}`);
			}
			document.conversations[key] = next;
			await this.#persist(document);
			return next;
		});
	}

	async #withLock<R>(operation: () => Promise<R>): Promise<R> {
		const previous = this.#locks.get(this.#file) ?? Promise.resolve();
		const gate = Promise.withResolvers<void>();
		const tail = previous.then(() => gate.promise);
		this.#locks.set(this.#file, tail);
		await previous;
		let fileLock: ConversationStoreFileHandle | undefined;
		try {
			fileLock = await this.#acquireFileLock();
			return await operation();
		} finally {
			try {
				await fileLock?.close();
				if (fileLock)
					await this.#fs.unlink(`${this.#file}.lock`).catch(error => {
						if (!isMissing(error)) throw error;
					});
			} finally {
				gate.resolve();
				if (this.#locks.get(this.#file) === tail) this.#locks.delete(this.#file);
			}
		}
	}

	async #acquireFileLock(): Promise<ConversationStoreFileHandle> {
		const lockFile = `${this.#file}.lock`;
		const deadline = Date.now() + this.#lockTimeoutMs;
		await this.#fs.mkdir(this.#directory, { recursive: true, mode: 0o700 });
		for (;;) {
			try {
				const handle = await this.#fs.open(lockFile, "wx");
				try {
					const lock: ConversationStoreLock = {
						pid: this.#pid,
						incarnation: this.#pidIncarnation(this.#pid) ?? "unavailable",
						timestamp: this.#clock(),
					};
					await handle.writeFile(`${JSON.stringify(lock)}\n`, "utf8");
					await handle.sync();
					return handle;
				} catch (error) {
					await handle.close().catch(() => undefined);
					await this.#fs.unlink(lockFile).catch(() => undefined);
					throw error;
				}
			} catch (error) {
				if (!isAlreadyExists(error)) throw error;
				if (await this.#reclaimStaleLock(lockFile)) continue;
				if (Date.now() >= deadline) throw new ConversationLockTimeoutError(lockFile, this.#lockTimeoutMs);
				await this.#sleep(Math.min(10, Math.max(1, deadline - Date.now())));
			}
		}
	}

	async #reclaimStaleLock(lockFile: string): Promise<boolean> {
		if (!(await this.#isStaleLock(lockFile))) return false;
		const reclaimFile = `${lockFile}.reclaim`;
		const reclaimLock = await this.#acquireReclaimLock(reclaimFile);
		if (!reclaimLock) return false;
		try {
			if (!(await this.#isStaleLock(lockFile))) return false;
			await this.#fs.unlink(lockFile).catch(() => undefined);
			return true;
		} finally {
			await reclaimLock.close().catch(() => undefined);
			await this.#fs.unlink(reclaimFile).catch(() => undefined);
		}
	}
	async #acquireReclaimLock(reclaimFile: string): Promise<ConversationStoreFileHandle | undefined> {
		try {
			return await this.#createLockFile(reclaimFile);
		} catch (error) {
			if (!isAlreadyExists(error) || !(await this.#isStaleLock(reclaimFile))) return undefined;
			await this.#fs.unlink(reclaimFile).catch(() => undefined);
			try {
				return await this.#createLockFile(reclaimFile);
			} catch (retryError) {
				if (isAlreadyExists(retryError)) return undefined;
				throw retryError;
			}
		}
	}
	async #createLockFile(lockFile: string): Promise<ConversationStoreFileHandle> {
		const handle = await this.#fs.open(lockFile, "wx");
		try {
			const lock: ConversationStoreLock = {
				pid: this.#pid,
				incarnation: this.#pidIncarnation(this.#pid) ?? "unavailable",
				timestamp: this.#clock(),
			};
			await handle.writeFile(`${JSON.stringify(lock)}\n`, "utf8");
			await handle.sync();
			return handle;
		} catch (error) {
			await handle.close().catch(() => undefined);
			await this.#fs.unlink(lockFile).catch(() => undefined);
			throw error;
		}
	}
	async #isStaleLock(lockFile: string): Promise<boolean> {
		let parsed: unknown;
		try {
			parsed = JSON.parse(await this.#fs.readFile(lockFile, "utf8"));
		} catch (error) {
			if (isMissing(error)) return true;
			return await this.#isExpiredUnpublishedLock(lockFile);
		}
		if (!isConversationStoreLock(parsed)) return await this.#isExpiredUnpublishedLock(lockFile);
		const currentIncarnation = this.#pidIncarnation(parsed.pid);
		return (
			!this.#pidAlive(parsed.pid) ||
			(parsed.incarnation !== "unavailable" &&
				(!isProcessIncarnation(parsed.incarnation) ||
					(currentIncarnation !== undefined && currentIncarnation !== parsed.incarnation)))
		);
	}
	async #isExpiredUnpublishedLock(lockFile: string): Promise<boolean> {
		const stat = this.#fs.stat ? await this.#fs.stat(lockFile).catch(() => undefined) : undefined;
		return Boolean(stat && this.#clock() - stat.mtimeMs >= UNPUBLISHED_LOCK_STALE_MS);
	}

	async #readDocument(): Promise<ConversationStoreDocument<T>> {
		try {
			const parsed: unknown = JSON.parse(await this.#fs.readFile(this.#file, "utf8"));
			if (!isRecord(parsed) || parsed.version !== CONVERSATION_STORE_VERSION || !isRecord(parsed.conversations)) {
				throw new Error("Invalid conversation store document");
			}
			return { version: CONVERSATION_STORE_VERSION, conversations: parsed.conversations as Record<string, T> };
		} catch (error) {
			if (isMissing(error)) return emptyDocument<T>();
			throw error;
		}
	}

	async #persist(document: ConversationStoreDocument<T>): Promise<void> {
		await this.#fs.mkdir(this.#directory, { recursive: true, mode: 0o700 });
		await this.#fs.chmod(this.#directory, 0o700);
		const temporary = `${this.#file}.${process.pid}.${randomUUID()}.tmp`;
		try {
			await this.#fs.writeFile(temporary, `${JSON.stringify(document)}\n`, { mode: 0o600 });
			await this.#fs.chmod(temporary, 0o600);
			const handle = await this.#fs.open(temporary, "r");
			try {
				await handle.sync();
			} finally {
				await handle.close();
			}
			await this.#fs.rename(temporary, this.#file);
			const directory = await this.#fs.open(this.#directory, "r");
			try {
				await directory.sync();
			} finally {
				await directory.close();
			}
		} catch (error) {
			await this.#fs.unlink(temporary).catch(() => undefined);
			throw error;
		}
	}
}

function isMissing(error: unknown): error is NodeJS.ErrnoException {
	return isRecord(error) && error.code === "ENOENT";
}

function isAlreadyExists(error: unknown): error is NodeJS.ErrnoException {
	return isRecord(error) && error.code === "EEXIST";
}

function defaultPidAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

function isConversationStoreLock(value: unknown): value is ConversationStoreLock {
	return (
		isRecord(value) &&
		typeof value.pid === "number" &&
		Number.isSafeInteger(value.pid) &&
		value.pid > 0 &&
		typeof value.incarnation === "string" &&
		typeof value.timestamp === "number"
	);
}
