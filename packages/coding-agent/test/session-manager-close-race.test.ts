/**
 * Regression for the "Writer closed" race between `SessionManager.close()`
 * and a concurrent `appendMessage()`.
 *
 * Repro shape (pre-fix):
 *   1. `close()` queues `#closePersistWriterInternal()` on the persist chain.
 *   2. The task runs and awaits `#persistWriter.close()`, which sets `#closing
 *      = true` synchronously before yielding on `flush()` / its inner writer
 *      `close()`.
 *   3. A synchronous `appendMessage()` lands in the yield window. `_persist`
 *      reaches the hot path, `#ensurePersistWriter()` returns the still-cached
 *      (but now closing) writer, and `writeSync` throws `Error("Writer closed")`.
 *   4. The throw is captured into `#persistError`. The next async caller
 *      (`flush()` or a later `appendMessage()`) re-throws it, producing an
 *      unhandled rejection with the original line-1282 stack.
 *
 * Fix: `NdjsonFileWriter.isOpen()` is consulted; mid-close writers cause
 * `_persist` to route the entry through the async `#rewriteFile()` cold path.
 *
 * To pin the race deterministically, the test wraps `MemorySessionStorage`
 * and parks every underlying writer `close()` on a deferred. The race window
 * opens the moment `NdjsonFileWriter.close()` flips `#closing = true` and
 * yields on its inner writer `close()` — which is our parked promise.
 */

import { describe, expect, it } from "bun:test";
import { getBundledModel } from "@gajae-code/ai/models";
import { SessionManager, type SessionManagerCloseOutcome } from "@gajae-code/coding-agent/session/session-manager";
import {
	MemorySessionStorage,
	type SessionStorage,
	type SessionStorageWriter,
	type SessionStorageWriterCloseState,
	type SessionStorageWriterOpenOptions,
	SessionStorageWriterRetryableCloseError,
} from "@gajae-code/coding-agent/session/session-storage";

class CloseHoldingStorage implements SessionStorage {
	readonly #inner = new MemorySessionStorage();
	readonly #closeGates: Array<PromiseWithResolvers<void>> = [];

	openWriter(path: string, options?: { flags?: "a" | "w"; onError?: (err: Error) => void }): SessionStorageWriter {
		const inner = this.#inner.openWriter(path, options);
		const gates = this.#closeGates;
		return {
			writeLine(line) {
				return inner.writeLine(line);
			},
			writeLineSync(line) {
				inner.writeLineSync(line);
			},
			flush() {
				return inner.flush();
			},
			fsync() {
				return inner.fsync();
			},
			async close() {
				const gate = Promise.withResolvers<void>();
				gates.push(gate);
				await gate.promise;
				return inner.close();
			},
			closeSync() {
				// Sync close (cold-rewrite path) delegates directly; only the async
				// close parks on a gate to open the race window.
				inner.closeSync();
			},
			getError() {
				return inner.getError();
			},
			getCloseState() {
				return inner.getCloseState();
			},
			getCloseError() {
				return inner.getCloseError();
			},
		};
	}

	releaseNextClose(): boolean {
		const next = this.#closeGates.shift();
		if (!next) return false;
		next.resolve();
		return true;
	}

	hasPendingClose(): boolean {
		return this.#closeGates.length > 0;
	}

	// Delegate the rest of the SessionStorage surface to the in-memory impl.
	ensureDirSync(dir: string): void {
		this.#inner.ensureDirSync(dir);
	}
	existsSync(p: string): boolean {
		return this.#inner.existsSync(p);
	}
	writeTextSync(p: string, content: string): void {
		this.#inner.writeTextSync(p, content);
	}
	readTextSync(p: string): string {
		return this.#inner.readTextSync(p);
	}
	statSync(p: string) {
		return this.#inner.statSync(p);
	}
	listFilesSync(dir: string, pattern: string): string[] {
		return this.#inner.listFilesSync(dir, pattern);
	}
	exists(p: string): Promise<boolean> {
		return this.#inner.exists(p);
	}
	readText(p: string): Promise<string> {
		return this.#inner.readText(p);
	}
	readTextPrefix(p: string, maxBytes: number): Promise<string> {
		return this.#inner.readTextPrefix(p, maxBytes);
	}
	writeText(p: string, content: string): Promise<void> {
		return this.#inner.writeText(p, content);
	}
	rename(p: string, nextPath: string): Promise<void> {
		return this.#inner.rename(p, nextPath);
	}
	renameSync(p: string, nextPath: string): void {
		return this.#inner.renameSync(p, nextPath);
	}
	unlink(p: string): Promise<void> {
		return this.#inner.unlink(p);
	}
	unlinkSync(p: string): void {
		return this.#inner.unlinkSync(p);
	}
	deleteSessionWithArtifacts(sessionPath: string): Promise<void> {
		return this.#inner.deleteSessionWithArtifacts(sessionPath);
	}
}

/** Drive microtasks while releasing every parked close until `promise` settles. */
async function settle<T>(promise: Promise<T>, storage: CloseHoldingStorage): Promise<T> {
	let done = false;
	let value: T | undefined;
	let error: unknown;
	promise.then(
		v => {
			value = v;
			done = true;
		},
		e => {
			error = e;
			done = true;
		},
	);
	for (let safety = 0; safety < 1000; safety++) {
		if (done) break;
		storage.releaseNextClose();
		await Promise.resolve();
	}
	if (!done) throw new Error("settle() did not converge — promise stayed pending");
	if (error) throw error;
	return value as T;
}

/**
 * Extract the persisted text of every `message` entry from a JSONL transcript,
 * in on-disk order. Used to prove raced appends actually landed durably
 * (present AND ordered) rather than merely being accepted without throwing.
 */
function persistedMessageTexts(jsonl: string): string[] {
	const texts: string[] = [];
	for (const raw of jsonl.split("\n")) {
		const line = raw.trim();
		if (!line) continue;
		let parsed: unknown;
		try {
			parsed = JSON.parse(line);
		} catch {
			continue;
		}
		if (typeof parsed !== "object" || parsed === null) continue;
		const entry = parsed as { type?: unknown; message?: unknown };
		if (entry.type !== "message") continue;
		texts.push(extractMessageText(entry.message));
	}
	return texts;
}

function extractMessageText(message: unknown): string {
	if (typeof message !== "object" || message === null) return "";
	const content = (message as { content?: unknown }).content;
	if (typeof content === "string") return content;
	if (Array.isArray(content)) {
		return content
			.map(part =>
				typeof part === "object" && part !== null && "text" in part
					? String((part as { text?: unknown }).text ?? "")
					: "",
			)
			.join("");
	}
	return "";
}

describe("SessionManager close/appendMessage race", () => {
	it("appendMessage during in-flight close() does not stash a persistError", async () => {
		const storage = new CloseHoldingStorage();
		const sm = SessionManager.create("/cwd", "/sessions", storage);
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected built-in anthropic model to exist");

		// Seed an assistant message so persist activates (the `#ensuredOnDisk`
		// guard gates the first write on the first assistant entry). This
		// first append takes the cold `#rewriteFile` path.
		sm.appendMessage({
			role: "assistant",
			content: [{ type: "text", text: "hello" }],
			api: model.api,
			provider: model.provider,
			model: model.id,
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop",
			timestamp: Date.now(),
		});
		await settle(sm.flush(), storage);

		// Drive a hot-path append so `#ensurePersistWriter()` instantiates and
		// caches `#persistWriter`. The first assistant write took the cold
		// `#rewriteFile` path (which leaves no cached writer); only after
		// `#flushed = true` does a subsequent append open the hot writeSync
		// path that the race relies on.
		sm.appendMessage({
			role: "user",
			content: "prime",
			timestamp: Date.now(),
		});
		// `appendMessage` is sync; hot-path writeSync already ran. No queued
		// task to settle, but flushing the writer is still wise — it leaves
		// `#persistWriter` cached and ready for the close-race window.
		await settle(sm.flush(), storage);

		// Start close — its inner writer.close() parks on our gate. The
		// outer NdjsonFileWriter.close() has already flipped `#closing = true`
		// synchronously by the time the gate is hit.
		const closePromise = sm.close();
		// Spin microtasks until the parked close shows up.
		for (let i = 0; i < 200; i++) {
			if (storage.hasPendingClose()) break;
			await Promise.resolve();
		}
		expect(storage.hasPendingClose()).toBe(true);

		// Synchronous append in the yield window — must not record a
		// persistError. Pre-fix this stashes Error("Writer closed").
		expect(() => {
			sm.appendMessage({
				role: "user",
				content: "during-close",
				timestamp: Date.now(),
			});
		}).not.toThrow();

		// Drain everything.
		await settle(closePromise, storage);
		// Pre-fix `flush()` rejects with the stashed Error("Writer closed").
		await expect(settle(sm.flush(), storage)).resolves.toBeUndefined();

		// And a subsequent append on the same SessionManager must remain
		// healthy — pre-fix the persistError sentinel turns this into a
		// synchronous re-throw at `_persist`'s entry guard.
		expect(() => {
			sm.appendMessage({
				role: "user",
				content: "after-close",
				timestamp: Date.now(),
			});
		}).not.toThrow();
		await expect(settle(sm.flush(), storage)).resolves.toBeUndefined();
		// Durability: the raced appends must be present AND ordered in the
		// persisted JSONL — not merely accepted without throwing. Reopen the
		// transcript from storage and verify every message survived in order.
		const sessionFile = sm.getSessionFile();
		expect(sessionFile).toBeDefined();
		const onDisk = persistedMessageTexts(storage.readTextSync(sessionFile!));
		expect(onDisk).toEqual(["hello", "prime", "during-close", "after-close"]);
	});
});

/**
 * Storage wrapper whose first APPEND-writer close certifiably fails BEFORE the
 * underlying close is dispatched — it throws
 * `SessionStorageWriterRetryableCloseError` without ever calling the inner
 * close — then permits the retry to dispatch a real, successful close. Temp
 * `"w"` writers (atomic-rewrite path) close normally so seeding/reopen work.
 *
 * Counts close attempts and successful underlying dispatches so the
 * `closeStrict()` retry-ownership contract is observable: a certified
 * pre-dispatch failure must retain the writer so the retry can actually
 * re-dispatch the OS close, and exactly one successful dispatch may occur.
 */
class RetryableFirstCloseStorage implements SessionStorage {
	readonly #inner = new MemorySessionStorage();
	#closeAttempts = 0;
	#successfulCloses = 0;

	get closeAttempts(): number {
		return this.#closeAttempts;
	}

	get successfulCloses(): number {
		return this.#successfulCloses;
	}

	recordCloseAttempt(): void {
		this.#closeAttempts++;
	}

	recordSuccessfulClose(): void {
		this.#successfulCloses++;
	}

	openWriter(path: string, options?: SessionStorageWriterOpenOptions): SessionStorageWriter {
		const inner = this.#inner.openWriter(path, options);
		// Only the long-lived append writer (the cached `#persistWriter`) exhibits
		// the retryable-first-close behavior; temp `"w"` writers from the atomic
		// rewrite path must close normally so seeding/reopen still succeed.
		if (options?.flags === "w") return inner;
		return new RetryableFirstCloseWriter(inner, this);
	}

	ensureDirSync(dir: string): void {
		this.#inner.ensureDirSync(dir);
	}
	existsSync(p: string): boolean {
		return this.#inner.existsSync(p);
	}
	writeTextSync(p: string, content: string): void {
		this.#inner.writeTextSync(p, content);
	}
	readTextSync(p: string): string {
		return this.#inner.readTextSync(p);
	}
	statSync(p: string) {
		return this.#inner.statSync(p);
	}
	listFilesSync(dir: string, pattern: string): string[] {
		return this.#inner.listFilesSync(dir, pattern);
	}
	exists(p: string): Promise<boolean> {
		return this.#inner.exists(p);
	}
	readText(p: string): Promise<string> {
		return this.#inner.readText(p);
	}
	readTextPrefix(p: string, maxBytes: number): Promise<string> {
		return this.#inner.readTextPrefix(p, maxBytes);
	}
	writeText(p: string, content: string): Promise<void> {
		return this.#inner.writeText(p, content);
	}
	rename(p: string, nextPath: string): Promise<void> {
		return this.#inner.rename(p, nextPath);
	}
	renameSync(p: string, nextPath: string): void {
		return this.#inner.renameSync(p, nextPath);
	}
	unlink(p: string): Promise<void> {
		return this.#inner.unlink(p);
	}
	unlinkSync(p: string): void {
		return this.#inner.unlinkSync(p);
	}
	deleteSessionWithArtifacts(sessionPath: string): Promise<void> {
		return this.#inner.deleteSessionWithArtifacts(sessionPath);
	}
}

class RetryableFirstCloseWriter implements SessionStorageWriter {
	readonly #inner: SessionStorageWriter;
	readonly #storage: RetryableFirstCloseStorage;
	#closeState: SessionStorageWriterCloseState = "open";
	#closeError: Error | undefined;
	#closed = false;

	constructor(inner: SessionStorageWriter, storage: RetryableFirstCloseStorage) {
		this.#inner = inner;
		this.#storage = storage;
	}

	writeLine(line: string): Promise<void> {
		return this.#inner.writeLine(line);
	}
	writeLineSync(line: string): void {
		this.#inner.writeLineSync(line);
	}
	flush(): Promise<void> {
		return this.#inner.flush();
	}
	fsync(): Promise<void> {
		return this.#inner.fsync();
	}

	async close(): Promise<void> {
		this.#attemptClose();
	}
	closeSync(): void {
		this.#attemptClose();
	}

	#attemptClose(): void {
		if (this.#closed) return;
		this.#storage.recordCloseAttempt();
		if (this.#closeState !== "close_failed_retryable") {
			// Certified PRE-dispatch failure: throw before delegating to the
			// underlying close, so ownership of the descriptor stays proven and a
			// later retry is safe.
			this.#closeState = "close_failed_retryable";
			this.#closeError = new SessionStorageWriterRetryableCloseError();
			throw this.#closeError;
		}
		// Retry after a certified pre-dispatch failure: dispatch the real close.
		this.#inner.closeSync();
		this.#closeState = "closed";
		this.#closeError = undefined;
		this.#closed = true;
		this.#storage.recordSuccessfulClose();
	}

	getError(): Error | undefined {
		return this.#inner.getError();
	}
	getCloseState(): SessionStorageWriterCloseState {
		return this.#closeState;
	}
	getCloseError(): Error | undefined {
		return this.#closeError;
	}
}

describe("SessionManager closeStrict retryable-close ownership", () => {
	it("retains ownership across a certified pre-dispatch failure and closes on retry", async () => {
		const storage = new RetryableFirstCloseStorage();
		const sm = SessionManager.create("/cwd", "/sessions", storage);
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected built-in anthropic model to exist");

		// Seed an assistant message (cold atomic rewrite via a temp "w" writer,
		// which closes normally) so persist is active and `#flushed` is true.
		sm.appendMessage({
			role: "assistant",
			content: [{ type: "text", text: "seed" }],
			api: model.api,
			provider: model.provider,
			model: model.id,
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop",
			timestamp: Date.now(),
		});

		// Hot-path append instantiates and caches the append writer
		// (`#persistWriter`) that `closeStrict()` will operate on.
		sm.appendMessage({
			role: "user",
			content: "prime",
			timestamp: Date.now(),
		});
		await sm.flush();

		// First close: the append writer's close throws
		// `SessionStorageWriterRetryableCloseError` BEFORE dispatching the
		// underlying close. The manager must surface the retryable failure
		// (never manufacture `closed`) and RETAIN the writer.
		const r1: SessionManagerCloseOutcome = await sm.flushAndCloseStrict();
		expect(r1.kind).toBe("close_failed_retryable");
		// The failure was certified pre-dispatch: no successful close ran.
		expect(storage.closeAttempts).toBe(1);
		expect(storage.successfulCloses).toBe(0);

		// Retry: the retained writer is re-closed, dispatching the real close,
		// which now succeeds. (If ownership had been released after r1, the
		// manager would find no writer and return `closed` with zero
		// dispatches — so the successful dispatch below proves retention.)
		const r2: SessionManagerCloseOutcome = await sm.flushAndCloseStrict();
		expect(r2.kind).toBe("closed");

		// Exactly one successful underlying close dispatch across the lifecycle:
		// the first attempt threw pre-dispatch, the retry dispatched and closed.
		expect(storage.closeAttempts).toBe(2);
		expect(storage.successfulCloses).toBe(1);
	});
});
