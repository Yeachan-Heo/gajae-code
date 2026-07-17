/**
 * Index of rich messages the daemon sent, mapping `${chat_id}:${message_id}` to
 * the original markdown. Telegram does not echo a `sendRichMessage` message's
 * text in a reply's `reply_to_message`, so a user replying to a rich final
 * answer would otherwise strand the agent without the quoted context. The daemon
 * records the markdown on every promoted send and looks it up on inbound replies
 * to restore that context.
 *
 * Fail-closed and off-path-neutral: nothing is recorded unless a send was
 * actually promoted to rich, `record` is a no-op on any error (the in-memory map
 * is only mutated after the atomic persist succeeds), and `lookup` returns
 * undefined on any miss or error, so a bad index write/read never kills the
 * daemon.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { daemonPaths } from "./daemon-paths";

/** Max distinct (chat, message) entries retained; oldest-by-timestamp evicted past this. */
const MAX_ENTRIES = 1000;
/** Max stored characters of the original markdown per entry. */
const MAX_TEXT_LENGTH = 2000;
/** Persisted index filename under the notifications directory. */
const INDEX_FILENAME = "telegram-rich-sent-index.json";

/**
 * Minimal async filesystem surface the store needs. Structurally a subset of the
 * daemon's `TelegramDaemonFs`, so the daemon can pass its own `fs` straight
 * through and tests can inject a fake.
 */
export interface ReplySentStoreFs {
	mkdir(path: string, opts?: fs.MakeDirectoryOptions): Promise<unknown>;
	readFile(path: string, encoding: BufferEncoding): Promise<string>;
	writeFile(path: string, data: string, opts?: fs.WriteFileOptions): Promise<void>;
	rename(oldPath: string, newPath: string): Promise<void>;
	chmod(path: string, mode: number): Promise<void>;
}

const nodeFs: ReplySentStoreFs = fs.promises as unknown as ReplySentStoreFs;

interface StoredEntry {
	text: string;
	ts: number;
}

interface PersistShape {
	version: 1;
	entries: Record<string, StoredEntry>;
}

/** Compose the stable per-message key. */
function keyFor(chatId: string | number, messageId: number): string {
	return `${chatId}:${messageId}`;
}

/** Drop oldest-by-timestamp entries until at most {@link MAX_ENTRIES} remain. */
function evictToCap(entries: Map<string, StoredEntry>): void {
	if (entries.size <= MAX_ENTRIES) return;
	// Stable sort keeps insertion order among equal timestamps, so the oldest
	// inserted entry is evicted first when timestamps tie.
	const oldestFirst = [...entries.entries()].sort((a, b) => a[1].ts - b[1].ts);
	const overflow = entries.size - MAX_ENTRIES;
	for (let i = 0; i < overflow; i++) entries.delete(oldestFirst[i]![0]);
}

export class ReplySentStore {
	readonly #dir: string;
	readonly #file: string;
	readonly #fsImpl: ReplySentStoreFs;
	readonly #now: () => number;
	#entries = new Map<string, StoredEntry>();

	constructor(input: { agentDir: string; fs?: ReplySentStoreFs; now?: () => number }) {
		this.#dir = daemonPaths(input.agentDir).dir;
		this.#file = path.join(this.#dir, INDEX_FILENAME);
		this.#fsImpl = input.fs ?? nodeFs;
		this.#now = input.now ?? Date.now;
	}

	/** Restore the persisted index into memory. No-op on a missing or corrupt file. */
	async load(): Promise<void> {
		try {
			const parsed = JSON.parse(await this.#fsImpl.readFile(this.#file, "utf8")) as Partial<PersistShape>;
			const restored = new Map<string, StoredEntry>();
			for (const [key, value] of Object.entries(parsed?.entries ?? {})) {
				if (value && typeof value.text === "string" && typeof value.ts === "number") {
					restored.set(key, { text: value.text, ts: value.ts });
				}
			}
			evictToCap(restored);
			this.#entries = restored;
		} catch {
			// Missing/corrupt index: keep the current in-memory map (empty on first load).
		}
	}

	/**
	 * Record the original markdown of a rich message the daemon just sent. The
	 * text is capped at {@link MAX_TEXT_LENGTH}; the index is capped at
	 * {@link MAX_ENTRIES} (oldest-by-timestamp evicted). No-op on any failure: the
	 * in-memory map is only replaced after the atomic persist succeeds.
	 */
	async record(input: { chatId: string | number; messageId: number; text: string }): Promise<void> {
		try {
			const text = input.text.length > MAX_TEXT_LENGTH ? input.text.slice(0, MAX_TEXT_LENGTH) : input.text;
			const next = new Map(this.#entries);
			next.set(keyFor(input.chatId, input.messageId), { text, ts: this.#now() });
			evictToCap(next);
			await this.#persist(next);
			this.#entries = next;
		} catch {
			// Best-effort: never let an index write kill the daemon.
		}
	}

	/** Look up the original markdown for a message the daemon sent. undefined on miss or failure. */
	lookup(input: { chatId: string | number; messageId: number }): string | undefined {
		try {
			return this.#entries.get(keyFor(input.chatId, input.messageId))?.text;
		} catch {
			return undefined;
		}
	}

	async #persist(entries: Map<string, StoredEntry>): Promise<void> {
		await this.#fsImpl.mkdir(this.#dir, { recursive: true, mode: 0o700 });
		const payload: PersistShape = { version: 1, entries: Object.fromEntries(entries) };
		const tmp = `${this.#file}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`;
		await this.#fsImpl.writeFile(tmp, `${JSON.stringify(payload, null, 2)}\n`, { mode: 0o600 });
		await this.#fsImpl.chmod(tmp, 0o600).catch(() => undefined);
		await this.#fsImpl.rename(tmp, this.#file);
	}
}
