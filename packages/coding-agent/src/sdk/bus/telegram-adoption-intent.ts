/**
 * Durable, non-routable sidecar store for "adopt a user-created Telegram forum
 * topic into a preallocated session" intents.
 *
 * When a user creates a new forum topic, the daemon first records durable
 * pending-topic authorization. After folder selection it preallocates an
 * `intendedSessionId` and records an adoption intent here *before* spawning.
 * Later, the authenticated `ensureTopic` create callback reads that intent and
 * returns the user's existing topicId to `TopicRegistry.getOrCreateTopic`, which
 * is the only authority that commits a topic binding. This keeps the intent out
 * of routing/endpoint authority until commit, so a failed spawn or a late socket
 * never deletes the user's topic and never strands a duplicate.
 *
 * Invariants (see `pending-approval.md`):
 * - One file per intent, named `<intendedSessionId>.adoption-intent.json` under
 *   the daemon notifications dir. Sweep touches files only; never the Telegram API.
 * - Only `{ intendedSessionId, topicId, chatId, target, createdAt, expiresAt }`
 *   is persisted. Bot/control tokens and endpoint digests are never stored.
 * - Owner-only dir (0o700) and 0o600 files; atomic temp→fsync→chmod→rename→parent sync.
 * - `tryClaim` is a synchronous, in-memory claim keyed by topicId; it excludes a
 *   second `intendedSessionId` from winning the same topic across awaits. It
 *   does not delete the sidecar; `releaseClaim` re-enables retry on commit failure.
 */

import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { daemonPaths } from "./daemon-paths";
import type { SessionCreateTarget } from "./index";

/** Persisted document version. */
export const TELEGRAM_ADOPTION_INTENT_VERSION = 1;
export type TelegramAdoptionTarget = Extract<SessionCreateTarget, { kind: "existing_path" }>;
/** Default intent TTL (configurable at write time). Plan starts at 10 minutes. */
export const DEFAULT_ADOPTION_INTENT_TTL_MS = 10 * 60 * 1000;
/** Per-intent filename prefix/suffix under the notifications dir. */
const INTENT_FILE_SUFFIX = ".adoption-intent.json";
const PENDING_TOPIC_FILE_SUFFIX = ".pending-topic.json";

/**
 * Minimal async filesystem surface the store needs. Structurally a subset of the
 * daemon's `TelegramDaemonFs` / `ConversationStoreFs`, so the daemon can pass its
 * own `fs` straight through and tests can inject a fake. `open`/`sync`/`close`
 * mirror `ConversationStoreFileHandle` so the atomic fsync path reuses the same
 * shape as the conversation store.
 */
export interface AdoptionIntentFs {
	mkdir(directory: string, options: { recursive: true; mode: number }): Promise<unknown>;
	chmod(target: string, mode: number): Promise<void>;
	readFile(file: string, encoding: "utf8"): Promise<string>;
	writeFile(file: string, data: string, options: { mode: number }): Promise<void>;
	rename(from: string, to: string): Promise<void>;
	unlink(file: string): Promise<unknown>;
	readdir(directory: string): Promise<readonly string[]>;
	open(file: string, flags: string): Promise<AdoptionIntentFileHandle>;
}

export interface AdoptionIntentFileHandle {
	sync(): Promise<void>;
	close(): Promise<void>;
}

const nodeFs: AdoptionIntentFs = {
	mkdir: (dir, opts) => fs.promises.mkdir(dir, opts),
	chmod: (target, mode) => fs.promises.chmod(target, mode),
	readFile: (file, encoding) => fs.promises.readFile(file, encoding),
	writeFile: (file, data, opts) => fs.promises.writeFile(file, data, opts),
	rename: (from, to) => fs.promises.rename(from, to),
	unlink: file => fs.promises.unlink(file),
	readdir: dir => fs.promises.readdir(dir),
	open: async (file, flags) => fs.promises.open(file, flags),
};

/** What gets persisted per intent. No tokens, no digests. */
export interface TelegramAdoptionIntent {
	intendedSessionId: string;
	topicId: number;
	chatId: string;
	target: TelegramAdoptionTarget;
	createdAt: number;
	expiresAt: number;
}

interface PersistedIntent {
	version: typeof TELEGRAM_ADOPTION_INTENT_VERSION;
	intent: TelegramAdoptionIntent;
}

/** Durable authorization that a topic was observed through forum_topic_created. */
export interface TelegramPendingTopic {
	topicId: number;
	chatId: string;
	createdAt: number;
	expiresAt: number;
}

interface PersistedPendingTopic {
	version: typeof TELEGRAM_ADOPTION_INTENT_VERSION;
	pendingTopic: TelegramPendingTopic;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isSessionCreateTarget(value: unknown): value is TelegramAdoptionTarget {
	return isRecord(value) && value.kind === "existing_path" && typeof value.path === "string";
}

function isPersistedIntent(value: unknown): value is PersistedIntent {
	if (!isRecord(value)) return false;
	if (value.version !== TELEGRAM_ADOPTION_INTENT_VERSION) return false;
	const intent = value.intent;
	if (!isRecord(intent)) return false;
	return (
		typeof intent.intendedSessionId === "string" &&
		intent.intendedSessionId.length > 0 &&
		typeof intent.topicId === "number" &&
		Number.isSafeInteger(intent.topicId) &&
		intent.topicId > 0 &&
		typeof intent.chatId === "string" &&
		typeof intent.createdAt === "number" &&
		Number.isFinite(intent.createdAt) &&
		typeof intent.expiresAt === "number" &&
		Number.isFinite(intent.expiresAt) &&
		intent.expiresAt > intent.createdAt &&
		isSessionCreateTarget(intent.target)
	);
}

function isPersistedPendingTopic(value: unknown): value is PersistedPendingTopic {
	if (!isRecord(value) || value.version !== TELEGRAM_ADOPTION_INTENT_VERSION) return false;
	const pending = value.pendingTopic;
	return (
		isRecord(pending) &&
		typeof pending.topicId === "number" &&
		Number.isSafeInteger(pending.topicId) &&
		pending.topicId > 0 &&
		typeof pending.chatId === "string" &&
		typeof pending.createdAt === "number" &&
		Number.isFinite(pending.createdAt) &&
		typeof pending.expiresAt === "number" &&
		Number.isFinite(pending.expiresAt) &&
		pending.expiresAt > pending.createdAt
	);
}

/** Compose the per-intent sidecar path. Public so callers/tests can inspect it. */
export function adoptionIntentFilePath(agentDir: string, intendedSessionId: string): string {
	return path.join(daemonPaths(agentDir).dir, `${intendedSessionId}${INTENT_FILE_SUFFIX}`);
}

/** Compose the sidecar path for a user-created topic awaiting a folder choice. */
export function pendingTopicFilePath(agentDir: string, topicId: number): string {
	return path.join(daemonPaths(agentDir).dir, `${topicId}${PENDING_TOPIC_FILE_SUFFIX}`);
}

/** Build a fresh intent with `createdAt`/`expiresAt` derived from `now`/`ttlMs`. */
export function buildAdoptionIntent(input: {
	intendedSessionId: string;
	topicId: number;
	chatId: string;
	target: TelegramAdoptionTarget;
	now?: number;
	ttlMs?: number;
}): TelegramAdoptionIntent {
	const createdAt = input.now ?? Date.now();
	const ttl = input.ttlMs ?? DEFAULT_ADOPTION_INTENT_TTL_MS;
	return {
		intendedSessionId: input.intendedSessionId,
		topicId: input.topicId,
		chatId: input.chatId,
		target: input.target,
		createdAt,
		expiresAt: createdAt + ttl,
	};
}

/** Test-only: filename suffix used to recognize intent sidecars in a directory listing. */
export const ADOPTION_INTENT_FILENAME_SUFFIX = INTENT_FILE_SUFFIX;
export const PENDING_TOPIC_FILENAME_SUFFIX = PENDING_TOPIC_FILE_SUFFIX;

/**
 * Durable, non-routable adoption-intent store. Owns durable sidecar files and
 * the synchronous in-memory topicId claim table. The daemon owns Telegram and
 * lifecycle wiring; this store never calls the Telegram API.
 */
export class TelegramAdoptionIntentStore {
	readonly #agentDir: string;
	readonly #dir: string;
	readonly #fsImpl: AdoptionIntentFs;
	readonly #now: () => number;
	readonly #platform: NodeJS.Platform;
	/** intendedSessionId -> intent, rehydrated from disk. */
	readonly #intents = new Map<string, TelegramAdoptionIntent>();
	/** topicId -> intendedSessionId currently holding the synchronous claim. */
	readonly #claims = new Map<number, string>();
	/** topicId -> durable authorization observed from forum_topic_created. */
	readonly #pendingTopics = new Map<number, TelegramPendingTopic>();

	constructor(input: {
		agentDir: string;
		fs?: AdoptionIntentFs;
		now?: () => number;
		platform?: NodeJS.Platform;
	}) {
		this.#agentDir = input.agentDir;
		this.#dir = daemonPaths(input.agentDir).dir;
		this.#fsImpl = input.fs ?? nodeFs;
		this.#now = input.now ?? Date.now;
		this.#platform = input.platform ?? process.platform;
	}

	/** Directory holding the sidecar files. */
	get directory(): string {
		return this.#dir;
	}

	/** In-memory lookup by intendedSessionId (no disk read). undefined if absent/expired. */
	bySession(intendedSessionId: string): TelegramAdoptionIntent | undefined {
		const intent = this.#intents.get(intendedSessionId);
		if (intent === undefined) return undefined;
		return this.#now() < intent.expiresAt ? intent : undefined;
	}

	/** In-memory lookup of the (single) non-expired intent for a topicId. */
	byTopic(topicId: number): TelegramAdoptionIntent | undefined {
		for (const intent of this.#intents.values()) {
			if (intent.topicId !== topicId) continue;
			if (this.#now() >= intent.expiresAt) continue;
			return intent;
		}
		return undefined;
	}

	/** `true` if a non-expired intent already references `topicId`. */
	hasNonExpiredTopic(topicId: number): boolean {
		return this.byTopic(topicId) !== undefined;
	}

	/** Durable authorization for an observed user-created topic, if still live. */
	pendingTopic(topicId: number): TelegramPendingTopic | undefined {
		const pending = this.#pendingTopics.get(topicId);
		return pending !== undefined && this.#now() < pending.expiresAt ? pending : undefined;
	}

	hasPendingTopic(topicId: number, chatId: string): boolean {
		return this.pendingTopic(topicId)?.chatId === chatId;
	}

	/**
	 * Synchronously claim `topicId` for `intendedSessionId`. Returns false if a
	 * *different* non-expired intendedSessionId already holds the claim (or has a
	 * non-expired intent for the topic). Same intendedSessionId re-claiming its
	 * own topic is idempotent and succeeds. The claim is in-memory only; it never
	 * deletes the sidecar, so a commit failure can `releaseClaim` and retry.
	 */
	tryClaim(topicId: number, intendedSessionId: string): boolean {
		const holder = this.#claims.get(topicId);
		if (holder !== undefined) return holder === intendedSessionId;
		// No live claim yet: refuse if a *different* non-expired intent already
		// targets this topic (race between two pre-spawn intents on one topic).
		const existing = this.byTopic(topicId);
		if (existing !== undefined && existing.intendedSessionId !== intendedSessionId) return false;
		this.#claims.set(topicId, intendedSessionId);
		return true;
	}

	/** Release a claim held by `intendedSessionId` on `topicId`. No-op otherwise. */
	releaseClaim(topicId: number, intendedSessionId: string): void {
		if (this.#claims.get(topicId) === intendedSessionId) this.#claims.delete(topicId);
	}

	/**
	 * Durable write of one intent: temp→write→fsync→chmod(0600)→atomic rename→
	 * chmod(final, 0600)→parent-dir fsync, then track it in memory. The dir is
	 * created owner-only (0700). chmod-ing the final path after the rename makes
	 * the 0600 contract durable regardless of whether the platform's rename
	 * preserves the source mode (POSIX does; some test/network filesystems and
	 * the in-memory test double model rename as copy+delete and would otherwise
	 * drop it). The rename is still the atomic commit point; the final chmod only
	 * tightens permissions on the already-durable file. The in-memory map is only
	 * mutated after the atomic persist succeeds. Rejects (does not swallow) so the
	 * daemon can decide fail-closed behavior.
	 */
	async put(intent: TelegramAdoptionIntent): Promise<void> {
		const stored: TelegramAdoptionIntent = {
			intendedSessionId: intent.intendedSessionId,
			topicId: intent.topicId,
			chatId: intent.chatId,
			target: { kind: "existing_path", path: intent.target.path },
			createdAt: intent.createdAt,
			expiresAt: intent.expiresAt,
		};
		const file = adoptionIntentFilePath(this.#agentDir, stored.intendedSessionId);
		const payload: PersistedIntent = { version: TELEGRAM_ADOPTION_INTENT_VERSION, intent: stored };
		if (!isPersistedIntent(payload)) throw new Error("invalid Telegram adoption intent");
		await this.#writeSidecar(file, payload);
		this.#intents.set(stored.intendedSessionId, stored);
	}

	/** Persist authorization for a topic observed through forum_topic_created. */
	async putPendingTopic(pendingTopic: TelegramPendingTopic): Promise<void> {
		const stored: TelegramPendingTopic = {
			topicId: pendingTopic.topicId,
			chatId: pendingTopic.chatId,
			createdAt: pendingTopic.createdAt,
			expiresAt: pendingTopic.expiresAt,
		};
		const file = pendingTopicFilePath(this.#agentDir, stored.topicId);
		const payload: PersistedPendingTopic = {
			version: TELEGRAM_ADOPTION_INTENT_VERSION,
			pendingTopic: stored,
		};
		if (!isPersistedPendingTopic(payload)) throw new Error("invalid Telegram pending topic");
		await this.#writeSidecar(file, payload);
		this.#pendingTopics.set(stored.topicId, stored);
	}

	async #writeSidecar(file: string, payload: PersistedIntent | PersistedPendingTopic): Promise<void> {
		await this.#fsImpl.mkdir(this.#dir, { recursive: true, mode: 0o700 });
		await this.#fsImpl.chmod(this.#dir, 0o700);
		const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
		let renamed = false;
		try {
			await this.#fsImpl.writeFile(temporary, `${JSON.stringify(payload)}\n`, { mode: 0o600 });
			await this.#fsImpl.chmod(temporary, 0o600);
			const handle = await this.#fsImpl.open(temporary, "r+");
			try {
				await syncRequired(handle);
			} finally {
				await handle.close();
			}
			await this.#fsImpl.rename(temporary, file);
			renamed = true;
			await this.#fsImpl.chmod(file, 0o600);
			await this.#syncParentDirectory();
		} catch (error) {
			const cleanupTarget = renamed ? file : temporary;
			let cleanupError: unknown;
			try {
				await this.#fsImpl.unlink(cleanupTarget);
				if (renamed) await this.#syncParentDirectory();
			} catch (candidate) {
				if (!isMissing(candidate)) cleanupError = candidate;
			}
			if (cleanupError) throw new AggregateError([error, cleanupError], "Adoption sidecar write and cleanup failed");
			throw error;
		}
	}

	/**
	 * Read a single intent sidecar from disk and track it if it is non-expired
	 * and well-formed. Returns the parsed intent (or undefined). Used by
	 * `rehydrate`; callers normally use `rehydrate` / `bySession`.
	 */
	async readIntent(intendedSessionId: string): Promise<TelegramAdoptionIntent | undefined> {
		const file = adoptionIntentFilePath(this.#agentDir, intendedSessionId);
		let raw: string;
		try {
			raw = await this.#fsImpl.readFile(file, "utf8");
		} catch (error) {
			if (isMissing(error)) return undefined;
			throw error;
		}
		let parsed: unknown;
		try {
			parsed = JSON.parse(raw);
		} catch {
			return undefined;
		}
		if (!isPersistedIntent(parsed) || parsed.intent.intendedSessionId !== intendedSessionId) return undefined;
		if (this.#now() >= parsed.intent.expiresAt) return undefined;
		this.#intents.set(intendedSessionId, parsed.intent);
		return parsed.intent;
	}

	async readPendingTopic(topicId: number): Promise<TelegramPendingTopic | undefined> {
		const file = pendingTopicFilePath(this.#agentDir, topicId);
		const pending = await this.#readPendingSidecar(file);
		if (!pending || pending.topicId !== topicId || this.#now() >= pending.expiresAt) return undefined;
		this.#pendingTopics.set(topicId, pending);
		return pending;
	}

	/**
	 * Rehydrate all non-expired intents from the notifications dir. Files are the
	 * only source: missing/corrupt/expired entries are skipped (never thrown).
	 * Returns the count of live intents loaded.
	 */
	async rehydrate(): Promise<number> {
		let names: readonly string[];
		try {
			names = await this.#fsImpl.readdir(this.#dir);
		} catch (error) {
			if (isMissing(error)) return 0;
			throw error;
		}
		let loaded = 0;
		for (const name of names) {
			if (name.endsWith(INTENT_FILE_SUFFIX)) {
				const intendedSessionId = name.slice(0, -INTENT_FILE_SUFFIX.length);
				if (!intendedSessionId) continue;
				const intent = await this.readIntent(intendedSessionId);
				if (intent) loaded++;
				continue;
			}
			if (!name.endsWith(PENDING_TOPIC_FILE_SUFFIX)) continue;
			const rawTopicId = name.slice(0, -PENDING_TOPIC_FILE_SUFFIX.length);
			const topicId = Number(rawTopicId);
			if (!Number.isSafeInteger(topicId) || topicId <= 0) continue;
			const pending = await this.readPendingTopic(topicId);
			if (pending) loaded++;
		}
		return loaded;
	}

	/**
	 * Remove a single intent sidecar and drop its in-memory entry. Safe to call
	 * after a successful registry commit or a definite spawn failure. Missing
	 * files are not an error. Never calls the Telegram API.
	 */
	async remove(intendedSessionId: string): Promise<void> {
		const file = adoptionIntentFilePath(this.#agentDir, intendedSessionId);
		try {
			await this.#fsImpl.unlink(file);
		} catch (error) {
			if (!isMissing(error)) throw error;
		}
		const intent = this.#intents.get(intendedSessionId);
		this.#intents.delete(intendedSessionId);
		if (intent) this.releaseClaim(intent.topicId, intendedSessionId);
	}

	/** Remove a pending-topic authorization after an adoption intent is durable. */
	async removePendingTopic(topicId: number): Promise<void> {
		const file = pendingTopicFilePath(this.#agentDir, topicId);
		try {
			await this.#fsImpl.unlink(file);
		} catch (error) {
			if (!isMissing(error)) throw error;
		}
		this.#pendingTopics.delete(topicId);
	}

	/**
	 * Sweep expired intent sidecars from disk. Touches files only. Returns the
	 * count of expired sidecars removed. Safe to run at startup and periodically.
	 */
	async sweepExpired(): Promise<number> {
		let names: readonly string[];
		try {
			names = await this.#fsImpl.readdir(this.#dir);
		} catch (error) {
			if (isMissing(error)) return 0;
			throw error;
		}
		const now = this.#now();
		let removed = 0;
		for (const name of names) {
			const file = path.join(this.#dir, name);
			if (name.endsWith(INTENT_FILE_SUFFIX)) {
				const intendedSessionId = name.slice(0, -INTENT_FILE_SUFFIX.length);
				if (!intendedSessionId) continue;
				const intent = await this.#readSidecar(file);
				if (intent && intent.intendedSessionId === intendedSessionId && now < intent.expiresAt) continue;
				try {
					await this.#fsImpl.unlink(file);
					removed++;
				} catch (error) {
					if (!isMissing(error)) throw error;
				}
				if (intent) {
					this.#intents.delete(intent.intendedSessionId);
					this.releaseClaim(intent.topicId, intent.intendedSessionId);
				}
				continue;
			}
			if (!name.endsWith(PENDING_TOPIC_FILE_SUFFIX)) continue;
			const rawTopicId = name.slice(0, -PENDING_TOPIC_FILE_SUFFIX.length);
			const topicId = Number(rawTopicId);
			const pending = await this.#readPendingSidecar(file);
			if (Number.isSafeInteger(topicId) && topicId > 0 && pending?.topicId === topicId && now < pending.expiresAt)
				continue;
			try {
				await this.#fsImpl.unlink(file);
				removed++;
			} catch (error) {
				if (!isMissing(error)) throw error;
			}
			if (Number.isSafeInteger(topicId)) this.#pendingTopics.delete(topicId);
		}
		return removed;
	}

	/** Read and validate a sidecar at an arbitrary path (used by sweep). */
	async #readSidecar(file: string): Promise<TelegramAdoptionIntent | undefined> {
		let raw: string;
		try {
			raw = await this.#fsImpl.readFile(file, "utf8");
		} catch (error) {
			if (isMissing(error)) return undefined;
			throw error;
		}
		let parsed: unknown;
		try {
			parsed = JSON.parse(raw);
		} catch {
			return undefined;
		}
		return isPersistedIntent(parsed) ? parsed.intent : undefined;
	}

	async #readPendingSidecar(file: string): Promise<TelegramPendingTopic | undefined> {
		let raw: string;
		try {
			raw = await this.#fsImpl.readFile(file, "utf8");
		} catch (error) {
			if (isMissing(error)) return undefined;
			throw error;
		}
		let parsed: unknown;
		try {
			parsed = JSON.parse(raw);
		} catch {
			return undefined;
		}
		return isPersistedPendingTopic(parsed) ? parsed.pendingTopic : undefined;
	}

	/** fsync the parent dir so the rename survives a crash; best-effort on win32. */
	async #syncParentDirectory(): Promise<void> {
		let handle: AdoptionIntentFileHandle;
		try {
			handle = await this.#fsImpl.open(this.#dir, "r");
		} catch (error) {
			if (this.#platform === "win32" && isUnsupportedDirectoryBarrierError(error)) return;
			throw error;
		}
		let syncError: unknown;
		try {
			await syncRequired(handle);
		} catch (error) {
			if (!(this.#platform === "win32" && isUnsupportedDirectoryBarrierError(error))) syncError = error;
		}
		let closeError: unknown;
		try {
			await handle.close();
		} catch (error) {
			closeError = error;
		}
		if (syncError && closeError)
			throw new AggregateError([syncError, closeError], "Parent directory sync and close failed");
		if (syncError) throw syncError;
		if (closeError) throw closeError;
	}
}

async function syncRequired(handle: AdoptionIntentFileHandle): Promise<void> {
	if (typeof handle.sync !== "function")
		throw new Error("adoption sidecar durability requires filesystem sync support");
	await handle.sync();
}

function isMissing(error: unknown): error is NodeJS.ErrnoException {
	return isRecord(error) && error.code === "ENOENT";
}

function isUnsupportedDirectoryBarrierError(error: unknown): boolean {
	return (
		isRecord(error) &&
		(error.code === "EINVAL" || error.code === "ENOTSUP" || error.code === "EOPNOTSUPP" || error.code === "EPERM")
	);
}
