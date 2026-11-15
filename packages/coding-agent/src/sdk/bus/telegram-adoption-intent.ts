/**
 * Durable provider-local reservations for Telegram topic adoption.
 *
 * A reservation is keyed by the stable provider request identity, never by a
 * preallocated Broker SessionId.  Broker allocates the SessionId; the daemon
 * CAS-binds that opaque value only after the lifecycle service returns it.
 * This store owns only presentation mappings and pending-topic authorization.
 */

import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { isRecord, logger } from "@gajae-code/utils";
import { isUnsupportedDirectoryBarrierError } from "./conversation-store";
import { daemonPaths } from "./daemon-paths";
import type { SessionCreateTarget } from "./index";

export const TELEGRAM_ADOPTION_INTENT_VERSION = 2;
const LEGACY_TELEGRAM_ADOPTION_INTENT_VERSION = 1 as const;
export type TelegramAdoptionTarget = Extract<SessionCreateTarget, { kind: "existing_path" }>;
export const DEFAULT_ADOPTION_INTENT_TTL_MS = 10 * 60 * 1000;
const INTENT_FILE_SUFFIX = ".adoption-intent.json";
const PENDING_TOPIC_FILE_SUFFIX = ".pending-topic.json";
const MIGRATION_DIAGNOSTIC_MAX_LENGTH = 256;

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

/** Persisted before create; `sessionId` is added only by bindSession. */
export interface TelegramAdoptionIntent {
	readonly providerRequestKey: string;
	readonly topicId: number;
	readonly chatId: string;
	readonly target: TelegramAdoptionTarget;
	readonly createdAt: number;
	readonly expiresAt: number;
	readonly sessionId?: string;
}

interface PersistedIntent {
	version: typeof TELEGRAM_ADOPTION_INTENT_VERSION;
	intent: TelegramAdoptionIntent;
}

interface LegacyTelegramAdoptionIntent {
	readonly intendedSessionId: string;
	readonly topicId: number;
	readonly chatId: string;
	readonly target: TelegramAdoptionTarget;
	readonly createdAt: number;
	readonly expiresAt: number;
}

interface LegacyPersistedIntent {
	version: typeof LEGACY_TELEGRAM_ADOPTION_INTENT_VERSION;
	intent: LegacyTelegramAdoptionIntent;
}

type PersistedIntentRecord = PersistedIntent | LegacyPersistedIntent;

export interface TelegramPendingTopic {
	readonly topicId: number;
	readonly chatId: string;
	readonly createdAt: number;
	readonly expiresAt: number;
}

interface PersistedPendingTopic {
	version: typeof TELEGRAM_ADOPTION_INTENT_VERSION;
	pendingTopic: TelegramPendingTopic;
}

interface LegacyPersistedPendingTopic {
	version: typeof LEGACY_TELEGRAM_ADOPTION_INTENT_VERSION;
	pendingTopic: TelegramPendingTopic;
}

type PersistedPendingTopicRecord = PersistedPendingTopic | LegacyPersistedPendingTopic;

function isSessionCreateTarget(value: unknown): value is TelegramAdoptionTarget {
	return isRecord(value) && value.kind === "existing_path" && typeof value.path === "string";
}

function isPersistedIntent(value: unknown): value is PersistedIntentRecord {
	if (!isRecord(value) || !isRecord(value.intent)) return false;
	if (value.version === TELEGRAM_ADOPTION_INTENT_VERSION) {
		const intent = value.intent;
		return (
			typeof intent.providerRequestKey === "string" &&
			intent.providerRequestKey.length > 0 &&
			typeof intent.topicId === "number" &&
			Number.isSafeInteger(intent.topicId) &&
			intent.topicId > 0 &&
			typeof intent.chatId === "string" &&
			typeof intent.createdAt === "number" &&
			Number.isFinite(intent.createdAt) &&
			typeof intent.expiresAt === "number" &&
			Number.isFinite(intent.expiresAt) &&
			intent.expiresAt > intent.createdAt &&
			(intent.sessionId === undefined || (typeof intent.sessionId === "string" && intent.sessionId.length > 0)) &&
			isSessionCreateTarget(intent.target)
		);
	}
	if (value.version !== LEGACY_TELEGRAM_ADOPTION_INTENT_VERSION) return false;
	const intent = value.intent;
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

function normalizePersistedIntent(value: unknown): { intent: TelegramAdoptionIntent; legacy: boolean } | undefined {
	if (!isPersistedIntent(value)) return undefined;
	if (value.version === TELEGRAM_ADOPTION_INTENT_VERSION) return { intent: value.intent, legacy: false };
	return {
		legacy: true,
		intent: {
			providerRequestKey: `legacy:v1:${value.intent.intendedSessionId}`,
			topicId: value.intent.topicId,
			chatId: value.intent.chatId,
			target: value.intent.target,
			createdAt: value.intent.createdAt,
			expiresAt: value.intent.expiresAt,
		},
	};
}

function isPersistedPendingTopic(value: unknown): value is PersistedPendingTopicRecord {
	if (!isRecord(value) || !isRecord(value.pendingTopic)) return false;
	if (value.version !== TELEGRAM_ADOPTION_INTENT_VERSION && value.version !== LEGACY_TELEGRAM_ADOPTION_INTENT_VERSION)
		return false;
	const pending = value.pendingTopic;
	return (
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

/** Sidecar names are opaque, deterministic encodings of provider request keys. */
function encodeProviderRequestKey(providerRequestKey: string): string {
	return Buffer.from(providerRequestKey, "utf8").toString("base64url");
}

function decodeProviderRequestKey(value: string): string | undefined {
	try {
		return Buffer.from(value, "base64url").toString("utf8");
	} catch {
		return undefined;
	}
}

export function adoptionIntentFilePath(agentDir: string, providerRequestKey: string): string {
	return path.join(daemonPaths(agentDir).dir, `${encodeProviderRequestKey(providerRequestKey)}${INTENT_FILE_SUFFIX}`);
}

export function pendingTopicFilePath(agentDir: string, topicId: number): string {
	return path.join(daemonPaths(agentDir).dir, `${topicId}${PENDING_TOPIC_FILE_SUFFIX}`);
}

export function buildAdoptionIntent(input: {
	providerRequestKey: string;
	topicId: number;
	chatId: string;
	target: TelegramAdoptionTarget;
	now?: number;
	ttlMs?: number;
}): TelegramAdoptionIntent {
	const createdAt = input.now ?? Date.now();
	return {
		providerRequestKey: input.providerRequestKey,
		topicId: input.topicId,
		chatId: input.chatId,
		target: input.target,
		createdAt,
		expiresAt: createdAt + (input.ttlMs ?? DEFAULT_ADOPTION_INTENT_TTL_MS),
	};
}

export const ADOPTION_INTENT_FILENAME_SUFFIX = INTENT_FILE_SUFFIX;
export const PENDING_TOPIC_FILENAME_SUFFIX = PENDING_TOPIC_FILE_SUFFIX;

export class TelegramAdoptionIntentStore {
	readonly #agentDir: string;
	readonly #dir: string;
	readonly #fsImpl: AdoptionIntentFs;
	readonly #now: () => number;
	readonly #platform: NodeJS.Platform;
	readonly #intents = new Map<string, TelegramAdoptionIntent>();
	readonly #claims = new Map<number, string>();
	readonly #pendingTopics = new Map<number, TelegramPendingTopic>();
	readonly #bindingKeys = new Set<string>();

	constructor(input: { agentDir: string; fs?: AdoptionIntentFs; now?: () => number; platform?: NodeJS.Platform }) {
		this.#agentDir = input.agentDir;
		this.#dir = daemonPaths(input.agentDir).dir;
		this.#fsImpl = input.fs ?? nodeFs;
		this.#now = input.now ?? Date.now;
		this.#platform = input.platform ?? process.platform;
	}

	get directory(): string {
		return this.#dir;
	}

	byProviderRequestKey(providerRequestKey: string): TelegramAdoptionIntent | undefined {
		const intent = this.#intents.get(providerRequestKey);
		return intent && this.#now() < intent.expiresAt ? intent : undefined;
	}

	/** Only a post-create CAS binding makes a reservation visible by SessionId. */
	bySession(sessionId: string): TelegramAdoptionIntent | undefined {
		for (const intent of this.#intents.values()) {
			if (intent.sessionId === sessionId && this.#now() < intent.expiresAt) return intent;
		}
		return undefined;
	}

	byTopic(topicId: number): TelegramAdoptionIntent | undefined {
		for (const intent of this.#intents.values()) {
			if (intent.topicId === topicId && this.#now() < intent.expiresAt) return intent;
		}
		return undefined;
	}

	hasNonExpiredTopic(topicId: number): boolean {
		return this.byTopic(topicId) !== undefined;
	}

	pendingTopic(topicId: number): TelegramPendingTopic | undefined {
		const pending = this.#pendingTopics.get(topicId);
		return pending && this.#now() < pending.expiresAt ? pending : undefined;
	}

	hasPendingTopic(topicId: number, chatId: string): boolean {
		return this.pendingTopic(topicId)?.chatId === chatId;
	}

	/** Synchronous fail-closed topic claim keyed by provider request identity. */
	tryClaim(topicId: number, providerRequestKey: string): boolean {
		const holder = this.#claims.get(topicId);
		if (holder !== undefined) return holder === providerRequestKey;
		const existing = this.byTopic(topicId);
		if (existing !== undefined && existing.providerRequestKey !== providerRequestKey) return false;
		this.#claims.set(topicId, providerRequestKey);
		return true;
	}

	releaseClaim(topicId: number, providerRequestKey: string): void {
		if (this.#claims.get(topicId) === providerRequestKey) this.#claims.delete(topicId);
	}

	async put(intent: TelegramAdoptionIntent): Promise<void> {
		const current =
			this.#intents.get(intent.providerRequestKey) ?? (await this.readIntent(intent.providerRequestKey));
		if (
			current &&
			(current.topicId !== intent.topicId ||
				current.chatId !== intent.chatId ||
				current.target.path !== intent.target.path)
		)
			throw new Error("provider request key is already reserved for a different topic or target");
		const stored: TelegramAdoptionIntent = {
			providerRequestKey: intent.providerRequestKey,
			topicId: intent.topicId,
			chatId: intent.chatId,
			target: { kind: "existing_path", path: intent.target.path },
			createdAt: intent.createdAt,
			expiresAt: intent.expiresAt,
			...((intent.sessionId ?? current?.sessionId) ? { sessionId: intent.sessionId ?? current?.sessionId } : {}),
		};
		const file = adoptionIntentFilePath(this.#agentDir, stored.providerRequestKey);
		await this.#writeSidecar(file, { version: TELEGRAM_ADOPTION_INTENT_VERSION, intent: stored });
		this.#intents.set(stored.providerRequestKey, stored);
	}

	/** CAS-bind the Broker-returned opaque SessionId exactly once. */
	async bindSession(providerRequestKey: string, sessionId: string): Promise<boolean> {
		if (!sessionId || this.#bindingKeys.has(providerRequestKey)) return false;
		const current = this.byProviderRequestKey(providerRequestKey);
		if (!current) return false;
		if (current.sessionId !== undefined) return current.sessionId === sessionId;
		this.#bindingKeys.add(providerRequestKey);
		try {
			const onDisk = await this.readIntent(providerRequestKey);
			if (!onDisk || (onDisk.sessionId !== undefined && onDisk.sessionId !== sessionId)) return false;
			const bound: TelegramAdoptionIntent = { ...current, sessionId };
			await this.#writeSidecar(adoptionIntentFilePath(this.#agentDir, providerRequestKey), {
				version: TELEGRAM_ADOPTION_INTENT_VERSION,
				intent: bound,
			});
			this.#intents.set(providerRequestKey, bound);
			return true;
		} finally {
			this.#bindingKeys.delete(providerRequestKey);
		}
	}

	async putPendingTopic(pendingTopic: TelegramPendingTopic): Promise<void> {
		const stored = { ...pendingTopic };
		await this.#writeSidecar(pendingTopicFilePath(this.#agentDir, stored.topicId), {
			version: TELEGRAM_ADOPTION_INTENT_VERSION,
			pendingTopic: stored,
		});
		this.#pendingTopics.set(stored.topicId, stored);
	}

	async #writeSidecar(
		file: string,
		payload: PersistedIntent | PersistedPendingTopic,
		retainRenamedFileOnFailure = false,
	): Promise<void> {
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
			if (renamed && retainRenamedFileOnFailure) throw new SidecarDurabilityUncertainError(error);
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

	async readIntent(providerRequestKey: string): Promise<TelegramAdoptionIntent | undefined> {
		const file = adoptionIntentFilePath(this.#agentDir, providerRequestKey);
		const record = await this.#readSidecarRecord(file);
		const parsed = record?.intent;
		if (!record || !parsed || parsed.providerRequestKey !== providerRequestKey || this.#now() >= parsed.expiresAt)
			return undefined;
		this.#intents.set(providerRequestKey, parsed);
		if (record.legacy) await this.#migrateIntentSidecar(file, parsed);
		return parsed;
	}

	async readPendingTopic(topicId: number): Promise<TelegramPendingTopic | undefined> {
		const file = pendingTopicFilePath(this.#agentDir, topicId);
		const record = await this.#readPendingSidecarRecord(file);
		const pending = record?.pendingTopic;
		if (!record || !pending || pending.topicId !== topicId || this.#now() >= pending.expiresAt) return undefined;
		this.#pendingTopics.set(topicId, pending);
		if (record.legacy) await this.#migratePendingTopicSidecar(file, pending);
		return pending;
	}

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
			const file = path.join(this.#dir, name);
			if (name.endsWith(INTENT_FILE_SUFFIX)) {
				const encoded = name.slice(0, -INTENT_FILE_SUFFIX.length);
				const key = decodeProviderRequestKey(encoded);
				const record = await this.#readSidecarRecord(file);
				const intent = record?.intent;
				if (!intent || this.#now() >= intent.expiresAt) continue;
				if (!record.legacy && (!key || intent.providerRequestKey !== key)) continue;
				this.#intents.set(intent.providerRequestKey, intent);
				if (record.legacy) await this.#migrateIntentSidecar(file, intent);
				loaded++;
				continue;
			}
			if (!name.endsWith(PENDING_TOPIC_FILE_SUFFIX)) continue;
			const topicId = Number(name.slice(0, -PENDING_TOPIC_FILE_SUFFIX.length));
			if (!Number.isSafeInteger(topicId) || topicId <= 0) continue;
			const record = await this.#readPendingSidecarRecord(file);
			const pending = record?.pendingTopic;
			if (!pending || pending.topicId !== topicId || this.#now() >= pending.expiresAt) continue;
			this.#pendingTopics.set(topicId, pending);
			if (record.legacy) await this.#migratePendingTopicSidecar(file, pending);
			loaded++;
		}
		return loaded;
	}

	async remove(providerRequestKey: string): Promise<void> {
		try {
			await this.#fsImpl.unlink(adoptionIntentFilePath(this.#agentDir, providerRequestKey));
		} catch (error) {
			if (!isMissing(error)) throw error;
		}
		const intent = this.#intents.get(providerRequestKey);
		this.#intents.delete(providerRequestKey);
		if (intent) this.releaseClaim(intent.topicId, providerRequestKey);
	}

	async removePendingTopic(topicId: number): Promise<void> {
		try {
			await this.#fsImpl.unlink(pendingTopicFilePath(this.#agentDir, topicId));
		} catch (error) {
			if (!isMissing(error)) throw error;
		}
		this.#pendingTopics.delete(topicId);
	}

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
				const record = await this.#readSidecarRecord(file);
				const intent = record?.intent;
				if (intent && now < intent.expiresAt) continue;
				try {
					await this.#fsImpl.unlink(file);
					removed++;
				} catch (error) {
					if (!isMissing(error)) throw error;
				}
				if (intent) {
					this.#intents.delete(intent.providerRequestKey);
					this.releaseClaim(intent.topicId, intent.providerRequestKey);
				}
				continue;
			}
			if (!name.endsWith(PENDING_TOPIC_FILE_SUFFIX)) continue;
			const topicId = Number(name.slice(0, -PENDING_TOPIC_FILE_SUFFIX.length));
			const pending = (await this.#readPendingSidecarRecord(file))?.pendingTopic;
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

	async #readSidecarRecord(file: string): Promise<{ intent: TelegramAdoptionIntent; legacy: boolean } | undefined> {
		let raw: string;
		try {
			raw = await this.#fsImpl.readFile(file, "utf8");
		} catch (error) {
			if (isMissing(error)) return undefined;
			throw error;
		}
		try {
			return normalizePersistedIntent(JSON.parse(raw) as unknown);
		} catch {
			return undefined;
		}
	}

	async #readPendingSidecarRecord(
		file: string,
	): Promise<{ pendingTopic: TelegramPendingTopic; legacy: boolean } | undefined> {
		let raw: string;
		try {
			raw = await this.#fsImpl.readFile(file, "utf8");
		} catch (error) {
			if (isMissing(error)) return undefined;
			throw error;
		}
		try {
			const parsed: unknown = JSON.parse(raw);
			if (!isPersistedPendingTopic(parsed)) return undefined;
			return {
				pendingTopic: parsed.pendingTopic,
				legacy: parsed.version === LEGACY_TELEGRAM_ADOPTION_INTENT_VERSION,
			};
		} catch {
			return undefined;
		}
	}

	async #migrateIntentSidecar(file: string, intent: TelegramAdoptionIntent): Promise<void> {
		const destination = adoptionIntentFilePath(this.#agentDir, intent.providerRequestKey);
		try {
			await this.#writeSidecar(
				destination,
				{ version: TELEGRAM_ADOPTION_INTENT_VERSION, intent },
				destination === file,
			);
		} catch (error) {
			if (error instanceof SidecarDurabilityUncertainError) logMigrationDurabilityUncertain("intent", error);
			else logMigrationFailure("intent", "write", error);
			return;
		}
		if (destination === file) return;
		try {
			await this.#fsImpl.unlink(file);
		} catch (error) {
			logMigrationFailure("intent", "unlink", error);
		}
	}

	async #migratePendingTopicSidecar(file: string, pendingTopic: TelegramPendingTopic): Promise<void> {
		const destination = pendingTopicFilePath(this.#agentDir, pendingTopic.topicId);
		try {
			await this.#writeSidecar(
				destination,
				{ version: TELEGRAM_ADOPTION_INTENT_VERSION, pendingTopic },
				destination === file,
			);
		} catch (error) {
			if (error instanceof SidecarDurabilityUncertainError) logMigrationDurabilityUncertain("pending_topic", error);
			else logMigrationFailure("pending_topic", "write", error);
			return;
		}
		if (destination === file) return;
		try {
			await this.#fsImpl.unlink(file);
		} catch (error) {
			logMigrationFailure("pending_topic", "unlink", error);
		}
	}

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

function migrationFailureMessage(error: unknown): string {
	const message =
		error instanceof Error ? error.message : typeof error === "string" ? error : "non-error migration failure";
	return message.length <= MIGRATION_DIAGNOSTIC_MAX_LENGTH
		? message
		: `${message.slice(0, MIGRATION_DIAGNOSTIC_MAX_LENGTH - 1)}…`;
}

class SidecarDurabilityUncertainError extends Error {
	constructor(error: unknown) {
		super(migrationFailureMessage(error));
		this.name = "SidecarDurabilityUncertainError";
	}
}

function logMigrationDurabilityUncertain(sidecar: "intent" | "pending_topic", error: unknown): void {
	logger.warn(
		"notifications: Telegram adoption sidecar migration durability is uncertain; retained migrated v2 sidecar",
		{
			sidecar,
			stage: "durability",
			error: migrationFailureMessage(error),
		},
	);
}

function logMigrationFailure(sidecar: "intent" | "pending_topic", stage: "write" | "unlink", error: unknown): void {
	logger.warn("notifications: Telegram adoption sidecar migration failed; retaining legacy sidecar", {
		sidecar,
		stage,
		error: migrationFailureMessage(error),
	});
}

async function syncRequired(handle: AdoptionIntentFileHandle): Promise<void> {
	if (typeof handle.sync !== "function")
		throw new Error("adoption sidecar durability requires filesystem sync support");
	await handle.sync();
}

function isMissing(error: unknown): error is NodeJS.ErrnoException {
	return isRecord(error) && error.code === "ENOENT";
}
