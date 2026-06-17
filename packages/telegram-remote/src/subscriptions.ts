import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, normalize, sep } from "node:path";

const DEFAULT_FOLLOW_TTL_MS = 86_400_000;
const DEFAULT_MAX_SUBSCRIPTIONS = 1000;
/** Fixed gateway-owned state file name inside the validated state dir. */
export const STATE_FILE_NAME = "telegram-remote-state.json";

export interface Subscription {
	sessionId: string;
	chatId: string;
	userId: string | null;
	expiresAt: number;
	updatedAt: number;
}

export interface SubscriptionStoreState {
	version: 1;
	watchCursor: number;
	subscriptions: Subscription[];
}

export interface SubscriptionStoreOptions {
	filePath: string;
	followTtlMs?: number;
	maxSubscriptions?: number;
	now?: () => number;
}

export function resolveStateDir(dir: string): string {
	if (dir.includes("\0")) throw new Error("telegram_remote_invalid_state_dir");
	if (!isAbsolute(dir)) throw new Error("telegram_remote_invalid_state_dir");
	if (dir.split(sep).includes("..")) throw new Error("telegram_remote_invalid_state_dir");
	const normalized = normalize(dir);
	const parts = normalized.split(sep);
	if (parts.includes("..")) throw new Error("telegram_remote_invalid_state_dir");
	return normalized;
}

function emptyState(): SubscriptionStoreState {
	return { version: 1, watchCursor: 0, subscriptions: [] };
}

function isSubscription(value: unknown): value is Subscription {
	if (typeof value !== "object" || value === null) return false;
	const record = value as Record<string, unknown>;
	return (
		typeof record.sessionId === "string" &&
		typeof record.chatId === "string" &&
		(typeof record.userId === "string" || record.userId === null) &&
		typeof record.expiresAt === "number" &&
		Number.isFinite(record.expiresAt) &&
		typeof record.updatedAt === "number" &&
		Number.isFinite(record.updatedAt)
	);
}

function parseState(text: string): SubscriptionStoreState {
	const parsed: unknown = JSON.parse(text);
	if (typeof parsed !== "object" || parsed === null) throw new Error("invalid_state");
	const record = parsed as Record<string, unknown>;
	if (record.version !== 1) throw new Error("invalid_state");
	if (typeof record.watchCursor !== "number" || !Number.isFinite(record.watchCursor)) throw new Error("invalid_state");
	if (!Array.isArray(record.subscriptions) || !record.subscriptions.every(isSubscription))
		throw new Error("invalid_state");
	return {
		version: 1,
		watchCursor: record.watchCursor,
		// Normalize to EXACTLY the routing fields: drop any extra/nested keys (metadata, events,
		// payload_ref, …) so a seeded/legacy file can never reintroduce a shadow event store on persist.
		subscriptions: record.subscriptions.map(entry => {
			const subscription = entry as Subscription;
			return {
				sessionId: subscription.sessionId,
				chatId: subscription.chatId,
				userId: subscription.userId,
				expiresAt: subscription.expiresAt,
				updatedAt: subscription.updatedAt,
			};
		}),
	};
}

export class SubscriptionStore {
	readonly #filePath: string;
	readonly #followTtlMs: number;
	readonly #maxSubscriptions: number;
	readonly #now: () => number;
	#state: SubscriptionStoreState;

	private constructor(options: Required<SubscriptionStoreOptions>, state: SubscriptionStoreState) {
		this.#filePath = options.filePath;
		this.#followTtlMs = options.followTtlMs;
		this.#maxSubscriptions = options.maxSubscriptions;
		this.#now = options.now;
		this.#state = state;
	}

	static async load(options: SubscriptionStoreOptions): Promise<SubscriptionStore> {
		const resolvedOptions: Required<SubscriptionStoreOptions> = {
			filePath: options.filePath,
			followTtlMs: options.followTtlMs ?? DEFAULT_FOLLOW_TTL_MS,
			maxSubscriptions: options.maxSubscriptions ?? DEFAULT_MAX_SUBSCRIPTIONS,
			now: options.now ?? Date.now,
		};
		let state = emptyState();
		try {
			state = parseState(await readFile(options.filePath, "utf8"));
		} catch (error) {
			if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) state = emptyState();
		}
		const store = new SubscriptionStore(resolvedOptions, state);
		store.pruneExpired();
		store.enforceMaxSubscriptions();
		return store;
	}

	/**
	 * Safe factory: validate the state directory and use the fixed state file name so a
	 * raw/untrusted filePath cannot escape the configured gateway state directory.
	 */
	static async open(
		options: { stateDir: string } & Omit<SubscriptionStoreOptions, "filePath">,
	): Promise<SubscriptionStore> {
		const dir = resolveStateDir(options.stateDir);
		return SubscriptionStore.load({
			filePath: join(dir, STATE_FILE_NAME),
			followTtlMs: options.followTtlMs,
			maxSubscriptions: options.maxSubscriptions,
			now: options.now,
		});
	}

	async follow(input: { sessionId: string; chatId: string; userId: string | null }): Promise<void> {
		const now = this.#now();
		this.pruneExpired(now);
		const next: Subscription = {
			sessionId: input.sessionId,
			chatId: input.chatId,
			userId: input.userId,
			expiresAt: now + this.#followTtlMs,
			updatedAt: now,
		};
		const index = this.#state.subscriptions.findIndex(
			subscription => subscription.sessionId === input.sessionId && subscription.chatId === input.chatId,
		);
		if (index >= 0) this.#state.subscriptions[index] = next;
		else this.#state.subscriptions.push(next);
		this.enforceMaxSubscriptions();
		await this.persist();
	}

	async mute(input: { sessionId: string; chatId: string }): Promise<void> {
		this.pruneExpired();
		this.#state.subscriptions = this.#state.subscriptions.filter(
			subscription => !(subscription.sessionId === input.sessionId && subscription.chatId === input.chatId),
		);
		await this.persist();
	}

	async followers(sessionId: string): Promise<Subscription[]> {
		const changed = this.pruneExpired();
		if (changed) await this.persist();
		return this.#state.subscriptions
			.filter(subscription => subscription.sessionId === sessionId)
			.map(subscription => ({ ...subscription }));
	}

	async setCursor(seq: number): Promise<void> {
		const next = Math.max(this.#state.watchCursor, seq);
		if (next === this.#state.watchCursor) return;
		this.#state.watchCursor = next;
		await this.persist();
	}

	getCursor(): number {
		return this.#state.watchCursor;
	}

	snapshotState(): SubscriptionStoreState {
		return {
			version: 1,
			watchCursor: this.#state.watchCursor,
			subscriptions: this.#state.subscriptions.map(subscription => ({ ...subscription })),
		};
	}

	private pruneExpired(now = this.#now()): boolean {
		const before = this.#state.subscriptions.length;
		this.#state.subscriptions = this.#state.subscriptions.filter(subscription => subscription.expiresAt > now);
		return this.#state.subscriptions.length !== before;
	}

	private enforceMaxSubscriptions(): boolean {
		if (this.#state.subscriptions.length <= this.#maxSubscriptions) return false;
		this.#state.subscriptions.sort((a, b) => b.updatedAt - a.updatedAt);
		this.#state.subscriptions = this.#state.subscriptions.slice(0, this.#maxSubscriptions);
		return true;
	}

	private async persist(): Promise<void> {
		this.pruneExpired();
		this.enforceMaxSubscriptions();
		const state: SubscriptionStoreState = {
			version: 1,
			watchCursor: this.#state.watchCursor,
			subscriptions: this.#state.subscriptions,
		};
		await mkdir(dirname(this.#filePath), { recursive: true });
		const tmpPath = `${this.#filePath}.tmp`;
		await writeFile(tmpPath, `${JSON.stringify(state)}\n`, "utf8");
		await rename(tmpPath, this.#filePath);
	}
}
