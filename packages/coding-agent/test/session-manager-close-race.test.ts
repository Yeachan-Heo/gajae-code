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

import { describe, expect, it, vi } from "bun:test";
import { getBundledModel } from "@gajae-code/ai/models";
import type { SessionStorageSnapshot } from "@gajae-code/coding-agent/sdk/session-readonly/storage";
import {
	SessionManager,
	type SessionManagerCloseOutcome,
	type SessionMessageEntry,
} from "@gajae-code/coding-agent/session/session-manager";
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
	onSyncClose: (() => void) | undefined;

	openWriter(path: string, options?: { flags?: "a" | "w"; onError?: (err: Error) => void }): SessionStorageWriter {
		const inner = this.#inner.openWriter(path, options);
		const gates = this.#closeGates;
		const storage = this;
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
			fsyncSync() {
				inner.fsyncSync?.();
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
				storage.onSyncClose?.();
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
	readBytesSync(p: string): Uint8Array {
		return this.#inner.readBytesSync!(p);
	}
	readSnapshotSync(p: string): SessionStorageSnapshot {
		return this.#inner.readSnapshotSync!(p);
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

	it("closeStrict rejects a late canonical append before releasing normal-session state", async () => {
		const storage = new CloseHoldingStorage();
		const sm = SessionManager.create("/cwd", "/sessions", storage);
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected built-in anthropic model to exist");
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
		sm.appendMessage({ role: "user", content: "prime", timestamp: Date.now() });
		await settle(sm.flush(), storage);

		expect(sm.getStrictCloseState()).toEqual({ kind: "none_started" });
		const closing = sm.closeStrict();
		expect(sm.getStrictCloseState()).toEqual({ kind: "in_flight" });
		expect(sm.closeStrict()).toBe(closing);
		for (let i = 0; i < 200; i++) {
			if (storage.hasPendingClose()) break;
			await Promise.resolve();
		}
		expect(storage.hasPendingClose()).toBe(true);
		expect(() => sm.appendMessage({ role: "user", content: "late", timestamp: Date.now() })).toThrow(
			"Session manager is closing.",
		);
		storage.releaseNextClose();
		expect(await settle(closing, storage)).toEqual({ kind: "closed" });
		expect(sm.getStrictCloseState()).toEqual({ kind: "closed" });
		expect(await sm.closeStrict()).toEqual({ kind: "closed" });
		expect(storage.hasPendingClose()).toBe(false);
		expect(() => sm.appendCustomEntry("after-close")).toThrow("Session manager is closing.");
		expect(sm.getBranch()).toEqual([]);
	});

	it("closeStrict publishes a migrated mutation before rejecting a late append", async () => {
		const storage = new CloseHoldingStorage();
		const filePath = "/sessions/legacy-close-gate.jsonl";
		storage.writeTextSync(
			filePath,
			`${JSON.stringify({ type: "session", id: "legacy-close-gate", timestamp: new Date(0).toISOString(), cwd: "/cwd", version: 2 })}\n${JSON.stringify({ type: "message", id: "legacy-message", parentId: null, timestamp: new Date(0).toISOString(), message: { role: "user", content: "legacy", timestamp: 0 } })}\n`,
		);
		const inspection = await SessionManager.inspectSessionTailReadOnly(filePath, storage);
		if (inspection.kind === "error") throw new Error("Expected legacy inspection");
		const opened = await SessionManager.openExistingStrict(inspection.identity, "/sessions", storage);
		if (opened.kind === "error") throw new Error("Expected strict open");
		const entry = opened.manager.getBranch().find(candidate => candidate.type === "message");
		if (entry?.type !== "message") throw new Error("Expected legacy message");
		const updatedEntry: SessionMessageEntry = {
			...entry,
			message: { role: "user", content: [{ type: "text", text: "updated" }], timestamp: 0 },
		};
		opened.manager.applyEntryMessageUpdates([updatedEntry]);

		let lateMutationError: unknown;
		storage.onSyncClose = () => {
			try {
				opened.manager.appendMessage({
					role: "user",
					content: [{ type: "text", text: "late" }],
					timestamp: Date.now(),
				});
			} catch (error) {
				lateMutationError = error;
			}
		};
		const outcome = await opened.manager.closeStrict();
		storage.onSyncClose = undefined;
		expect(outcome).toEqual({ kind: "closed" });
		expect(lateMutationError).toMatchObject({ message: "Session manager is closing." });
		expect(opened.manager.getBranch()).toEqual([]);
		const rewritten = storage
			.readTextSync(filePath)
			.trim()
			.split("\n")
			.map(line => JSON.parse(line));
		expect(rewritten[0]).toMatchObject({ type: "session", version: 5 });
		expect(rewritten[1]).toMatchObject({
			type: "message",
			message: { content: [{ type: "text", text: "updated" }] },
		});
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
	it("releases in-memory resident state after a rewrite-required mutation", async () => {
		const sm = SessionManager.inMemory();
		const id = sm.appendCustomMessageEntry("test", "before", true);
		const entry = sm.getBranch().find(candidate => candidate.id === id);
		if (entry?.type !== "custom_message") throw new Error("Expected custom message entry");

		sm.applyCustomMessageEntryUpdates([{ ...entry, content: "after" }]);
		const outcome = await sm.closeStrict();
		expect(outcome.kind).toBe("closed");
	});

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
		expect(sm.getStrictCloseState().kind).toBe("close_failed_retryable");
		expect(() => sm.appendCustomEntry("after-retryable-close")).toThrow("Session manager is closing.");
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
		expect(sm.getStrictCloseState()).toEqual({ kind: "closed" });
	});

	it.each([
		false,
		true,
	])("settles a retained retryable close and rewrite without retiring unrelated errors (unrelated=%s)", async unrelated => {
		const storage = new RetryableFirstCloseStorage();
		const openWriter = storage.openWriter.bind(storage);
		const independentError = unrelated ? new Error("independent append persistence failure") : undefined;
		let appendWriter: SessionStorageWriter | undefined;
		let reportAppendError: ((error: Error) => void) | undefined;
		let appendWriters = 0;
		const replacementWriters: SessionStorageWriter[] = [];
		const spy = vi.spyOn(storage, "openWriter").mockImplementation((file, options) => {
			const writer = openWriter(file, options);
			if (options?.flags === "w") replacementWriters.push(writer);
			else {
				appendWriters++;
				appendWriter = writer;
				reportAppendError = options?.onError;
			}
			return writer;
		});
		try {
			const manager = SessionManager.create("/cwd", "/sessions", storage);
			manager.appendMessage({ role: "user", content: "seed", timestamp: 1 });
			await manager.ensureOnDisk();
			const id = manager.appendCustomMessageEntry("rewrite", "before", true);
			manager.appendMessage({ role: "user", content: "hot", timestamp: 2 });
			await manager.flush();
			const writer = appendWriter;
			if (!writer || !reportAppendError) throw new Error("Missing retained append writer");
			const entry = manager.getBranch().find(value => value.id === id);
			if (entry?.type !== "custom_message") throw new Error("Missing custom message");
			const file = manager.getSessionFile()!;
			const before = storage.readTextSync(file);
			const updated = { ...entry, content: "after" };
			const expected = before.replace(`${JSON.stringify(entry)}\n`, `${JSON.stringify(updated)}\n`);
			expect(expected).not.toBe(before);
			manager.applyCustomMessageEntryUpdates([updated]);
			const baseline = replacementWriters.length;
			if (independentError) reportAppendError(independentError);

			const first = await manager.closeStrict();
			expect(first.kind).toBe("close_failed_retryable");
			if (first.kind !== "close_failed_retryable") throw new Error("Expected certified retryable close");
			const retryOrigin = writer.getCloseError();
			expect(retryOrigin).toBeInstanceOf(SessionStorageWriterRetryableCloseError);
			if (!retryOrigin) throw new Error("Expected the certified retry-origin error");
			expect(first.error).toBe(independentError ?? retryOrigin);
			expect(manager.getStrictCloseState()).toBe(first);
			expect(writer.getCloseState()).toBe("close_failed_retryable");
			expect(storage.closeAttempts).toBe(1);
			expect(storage.successfulCloses).toBe(0);
			expect(appendWriters).toBe(1);
			expect(replacementWriters).toHaveLength(baseline);
			expect(storage.readTextSync(file)).toBe(before);
			expect(manager.getBranch().find(value => value.id === id)).toMatchObject({ content: "after" });
			expect(() => manager.appendCustomEntry("after-retryable-close")).toThrow("Session manager is closing.");

			let final = await manager.closeStrict();
			if (independentError) {
				// Confirmed writer closure still reports its independent drain error.
				// A further pass may publish the rewrite, but must not erase that error.
				expect(final).toEqual({ kind: "close_failed_retryable", error: independentError });
				expect(writer.getCloseState()).toBe("closed");
				expect(storage.closeAttempts).toBe(2);
				expect(storage.successfulCloses).toBe(1);
				expect(replacementWriters).toHaveLength(baseline);
				expect(storage.readTextSync(file)).toBe(before);
				final = await manager.closeStrict();
			}
			expect(final).toEqual(
				independentError ? { kind: "close_unknown", error: independentError } : { kind: "closed" },
			);
			expect(manager.getStrictCloseState()).toBe(final);
			expect(await manager.closeStrict()).toBe(final);
			expect(writer.getCloseState()).toBe("closed");
			expect(storage.closeAttempts).toBe(2);
			expect(storage.successfulCloses).toBe(1);
			expect(appendWriters).toBe(1);
			expect(replacementWriters).toHaveLength(baseline + 1);
			expect(replacementWriters.at(-1)?.getCloseState()).toBe("closed");
			expect(storage.readTextSync(file)).toBe(expected);
			expect(persistedMessageTexts(storage.readTextSync(file))).toEqual(["seed", "hot"]);
			if (!independentError) expect(manager.getBranch()).toEqual([]);
		} finally {
			spy.mockRestore();
		}
	});

	it("retains a later rename failure after the exact retryable rewrite-close origin settles", async () => {
		const storage = new RetryableFirstCloseStorage();
		const openWriter = storage.openWriter.bind(storage);
		const renameSync = storage.renameSync.bind(storage);
		const failure = new Error("independent replacement rename failure");
		const trace: string[] = [];
		let appendWriter: SessionStorageWriter | undefined;
		let appendWriters = 0;
		const replacementWriters: SessionStorageWriter[] = [];
		const openSpy = vi.spyOn(storage, "openWriter").mockImplementation((file, options) => {
			const writer = openWriter(file, options);
			if (options?.flags === "w") {
				replacementWriters.push(writer);
				const closeSync = writer.closeSync.bind(writer);
				vi.spyOn(writer, "closeSync").mockImplementation(() => {
					closeSync();
					trace.push(`replacement:${writer.getCloseState()}`);
				});
			} else {
				appendWriters++;
				appendWriter = writer;
				const close = writer.close.bind(writer);
				vi.spyOn(writer, "close").mockImplementation(async () => {
					try {
						await close();
					} finally {
						trace.push(`append:${writer.getCloseState()}`);
					}
				});
			}
			return writer;
		});
		let failRename = false;
		const renameSpy = vi.spyOn(storage, "renameSync").mockImplementation((file, target) => {
			if (failRename) {
				failRename = false;
				trace.push("rename:failed-before-dispatch");
				throw failure;
			}
			renameSync(file, target);
			trace.push("rename:replaced");
		});
		try {
			const manager = SessionManager.create("/cwd", "/sessions", storage);
			manager.appendMessage({ role: "user", content: "seed", timestamp: 1 });
			await manager.ensureOnDisk();
			const id = manager.appendCustomMessageEntry("rewrite", "before", true);
			manager.appendMessage({ role: "user", content: "hot", timestamp: 2 });
			await manager.flush();
			const writer = appendWriter;
			if (!writer) throw new Error("Missing retained append writer");
			const entry = manager.getBranch().find(value => value.id === id);
			if (entry?.type !== "custom_message") throw new Error("Missing custom message");
			const file = manager.getSessionFile()!;
			const before = storage.readTextSync(file);
			const updated = { ...entry, content: "after" };
			const expected = before.replace(`${JSON.stringify(entry)}\n`, `${JSON.stringify(updated)}\n`);
			expect(expected).not.toBe(before);
			manager.applyCustomMessageEntryUpdates([updated]);
			const baseline = replacementWriters.length;
			trace.length = 0;

			const first = await manager.closeStrict();
			if (first.kind !== "close_failed_retryable") throw new Error("Expected certified retryable close");
			const origin = writer.getCloseError();
			expect(origin).toBeInstanceOf(SessionStorageWriterRetryableCloseError);
			if (!origin) throw new Error("Expected the certified retry-origin error");
			expect(first.error).toBe(origin);
			expect(manager.getStrictCloseState()).toBe(first);
			expect(trace).toEqual(["append:close_failed_retryable"]);
			expect(storage.closeAttempts).toBe(1);
			expect(storage.successfulCloses).toBe(0);
			expect(replacementWriters).toHaveLength(baseline);

			failRename = true;
			const second = await manager.closeStrict();
			expect(second.kind).toBe("close_failed_retryable");
			if (second.kind !== "close_failed_retryable") throw new Error("Expected retryable rename failure");
			expect(second.error).toBe(failure);
			expect(second.error).not.toBe(origin);
			expect(manager.getStrictCloseState()).toBe(second);
			expect(writer.getCloseState()).toBe("closed");
			expect(writer.getCloseError()).toBeUndefined();
			expect(storage.closeAttempts).toBe(2);
			expect(storage.successfulCloses).toBe(1);
			expect(appendWriters).toBe(1);
			expect(replacementWriters).toHaveLength(baseline + 1);
			expect(trace).toEqual([
				"append:close_failed_retryable",
				"append:closed",
				"replacement:closed",
				"rename:failed-before-dispatch",
			]);
			expect(storage.readTextSync(file)).toBe(before);
			expect(manager.getBranch().find(value => value.id === id)).toMatchObject({ content: "after" });
			expect(() => manager.appendCustomEntry("closed-admission")).toThrow("Session manager is closing.");

			// A successful publication retry cannot erase the independently retained F.
			const final = await manager.closeStrict();
			expect(final.kind).toBe("close_unknown");
			if (final.kind !== "close_unknown") throw new Error("Expected retained persistence failure");
			expect(final.error).toBe(failure);
			expect(manager.getStrictCloseState()).toBe(final);
			expect(await manager.closeStrict()).toBe(final);
			expect(await manager.closeStrict()).toBe(final);
			expect(storage.closeAttempts).toBe(2);
			expect(storage.successfulCloses).toBe(1);
			expect(appendWriters).toBe(1);
			expect(replacementWriters).toHaveLength(baseline + 2);
			expect(trace).toEqual([
				"append:close_failed_retryable",
				"append:closed",
				"replacement:closed",
				"rename:failed-before-dispatch",
				"replacement:closed",
				"rename:replaced",
			]);
			expect(storage.readTextSync(file)).toBe(expected);
			expect(persistedMessageTexts(storage.readTextSync(file))).toEqual(["seed", "hot"]);
		} finally {
			openSpy.mockRestore();
			renameSpy.mockRestore();
		}
	});

	it("keeps a dispatched unknown close terminal while rewrite debt remains, without retry or replacement", async () => {
		const storage = new MemorySessionStorage();
		const openWriter = storage.openWriter.bind(storage);
		const failure = new Error("rewrite close dispatched but outcome uncertain");
		let closeCalls = 0;
		let replacementWriters = 0;
		const spy = vi.spyOn(storage, "openWriter").mockImplementation((file, options) => {
			const writer = openWriter(file, options);
			if (options?.flags === "w") {
				replacementWriters++;
				return writer;
			}
			const close = writer.close.bind(writer);
			const state = writer.getCloseState.bind(writer);
			let dispatched = false;
			vi.spyOn(writer, "close").mockImplementation(async () => {
				closeCalls++;
				await close();
				dispatched = true;
				throw failure;
			});
			vi.spyOn(writer, "getCloseState").mockImplementation(() => (dispatched ? "close_unknown" : state()));
			vi.spyOn(writer, "getCloseError").mockImplementation(() => (dispatched ? failure : undefined));
			return writer;
		});
		try {
			const manager = SessionManager.create("/cwd", "/sessions", storage);
			manager.appendMessage({ role: "user", content: "seed", timestamp: 1 });
			await manager.ensureOnDisk();
			const id = manager.appendCustomMessageEntry("rewrite", "before", true);
			await manager.flush();
			const entry = manager.getBranch().find(value => value.id === id);
			if (entry?.type !== "custom_message") throw new Error("Missing custom message");
			manager.applyCustomMessageEntryUpdates([{ ...entry, content: "after" }]);
			const file = manager.getSessionFile()!;
			const before = storage.readTextSync(file);
			const baseline = replacementWriters;
			const outcome = await manager.closeStrict();
			expect(outcome).toEqual({ kind: "close_unknown", error: failure });
			expect(manager.getStrictCloseState()).toBe(outcome);
			expect(await manager.closeStrict()).toBe(outcome);
			expect(await manager.closeStrict()).toBe(outcome);
			expect(closeCalls).toBe(1);
			expect(replacementWriters).toBe(baseline);
			expect(storage.readTextSync(file)).toBe(before);
			expect(() => manager.appendCustomEntry("closed-admission")).toThrow("Session manager is closing.");
		} finally {
			spy.mockRestore();
			vi.restoreAllMocks();
		}
	});

	it("retains a terminal unknown outcome rather than inferring closed from the released writer", async () => {
		const storage = new MemorySessionStorage();
		const openWriter = storage.openWriter.bind(storage);
		const failure = new Error("post-dispatch close uncertainty");
		let closeCalls = 0;
		const spy = vi.spyOn(storage, "openWriter").mockImplementation((file, options) => {
			const writer = openWriter(file, options);
			if (options?.flags === "w") return writer;
			const close = writer.close.bind(writer);
			let dispatched = false;
			const getCloseState = writer.getCloseState.bind(writer);
			const getCloseError = writer.getCloseError.bind(writer);
			vi.spyOn(writer, "close").mockImplementation(async () => {
				closeCalls++;
				await close();
				dispatched = true;
				throw failure;
			});
			vi.spyOn(writer, "getCloseState").mockImplementation(() => (dispatched ? "close_unknown" : getCloseState()));
			vi.spyOn(writer, "getCloseError").mockImplementation(() => (dispatched ? failure : getCloseError()));
			return writer;
		});
		try {
			const manager = SessionManager.create("/cwd", "/sessions", storage);
			manager.appendMessage({ role: "user", content: "seed", timestamp: 1 });
			await manager.ensureOnDisk();
			manager.appendMessage({ role: "user", content: "hot", timestamp: 2 });
			await manager.flush();
			const outcome = await manager.closeStrict();
			expect(outcome).toEqual({ kind: "close_unknown", error: failure });
			expect(manager.getStrictCloseState()).toBe(outcome);
			expect(await manager.closeStrict()).toBe(outcome);
			expect(closeCalls).toBe(1);
			expect(() => manager.appendCustomEntry("after-unknown-close")).toThrow("Session manager is closing.");
		} finally {
			spy.mockRestore();
			vi.restoreAllMocks();
		}
	});
});
