/**
 * Deterministic lifecycle-close admission tests.
 *
 * `CloseHoldingStorage` parks the underlying writer close so appends can be
 * attempted while a lifecycle transition is in flight.
 */

import { describe, expect, it } from "bun:test";
import { getBundledModel } from "@gajae-code/ai/models";
import { SessionManager } from "@gajae-code/coding-agent/session/session-manager";
import {
	MemorySessionStorage,
	type SessionStorage,
	type SessionStorageWriter,
} from "@gajae-code/coding-agent/session/session-storage";

class CloseHoldingStorage implements SessionStorage {
	readonly #inner = new MemorySessionStorage();
	readonly #closeGates: Array<PromiseWithResolvers<void>> = [];
	#hideExistingFiles = false;
	#failNextRead = false;
	#failNextRename = false;

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
			getError() {
				return inner.getError();
			},
		};
	}

	releaseNextClose(): boolean {
		const next = this.#closeGates.shift();
		if (!next) return false;
		next.resolve();
		return true;
	}

	hideExistingFilesForMove(): void {
		this.#hideExistingFiles = true;
	}

	failNextRead(): void {
		this.#failNextRead = true;
	}

	failNextRename(): void {
		this.#failNextRename = true;
	}

	hasPendingClose(): boolean {
		return this.#closeGates.length > 0;
	}

	// Delegate the rest of the SessionStorage surface to the in-memory impl.
	ensureDirSync(dir: string): void {
		this.#inner.ensureDirSync(dir);
	}
	existsSync(p: string): boolean {
		return !this.#hideExistingFiles && this.#inner.existsSync(p);
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
	async readText(p: string): Promise<string> {
		if (this.#failNextRead) {
			this.#failNextRead = false;
			const error = new Error("Injected read EIO") as Error & { code: string };
			error.code = "EIO";
			throw error;
		}
		return this.#inner.readText(p);
	}
	readTextPrefix(p: string, maxBytes: number): Promise<string> {
		return this.#inner.readTextPrefix(p, maxBytes);
	}
	writeText(p: string, content: string): Promise<void> {
		return this.#inner.writeText(p, content);
	}
	async rename(p: string, nextPath: string): Promise<void> {
		if (this.#failNextRename) {
			this.#failNextRename = false;
			const error = new Error("Injected rename EIO") as Error & { code: string };
			error.code = "EIO";
			throw error;
		}
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
		await Bun.sleep(0);
	}
	if (!done) throw new Error("settle() did not converge — promise stayed pending");
	if (error) throw error;
	return value as T;
}

function appendUser(sm: SessionManager, content: string): void {
	sm.appendMessage({
		role: "user",
		content,
		timestamp: Date.now(),
	});
}

async function createPrimedSession(): Promise<{ sm: SessionManager; storage: CloseHoldingStorage }> {
	const storage = new CloseHoldingStorage();
	const sm = SessionManager.create("/cwd", "/sessions", storage);
	const model = getBundledModel("anthropic", "claude-sonnet-4-5");
	if (!model) throw new Error("Expected built-in anthropic model to exist");

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

	appendUser(sm, "prime");
	await settle(sm.flush(), storage);
	return { sm, storage };
}

async function waitForHeldClose(storage: CloseHoldingStorage): Promise<void> {
	for (let i = 0; i < 200; i++) {
		if (storage.hasPendingClose()) return;
		await Promise.resolve();
	}
	throw new Error("Expected transition to begin closing its writer");
}

describe("SessionManager lifecycle close/appendMessage race", () => {
	it("rejects an append during public close but remains reusable after close", async () => {
		const { sm, storage } = await createPrimedSession();
		const closePromise = sm.close();
		await waitForHeldClose(storage);

		expect(() => appendUser(sm, "during-close")).toThrow("Session manager close is in progress");

		await settle(closePromise, storage);
		appendUser(sm, "after-close");
		await expect(settle(sm.flush(), storage)).resolves.toBeUndefined();
	});

	for (const transition of [
		{ name: "newSession", start: (sm: SessionManager) => sm.newSession() },
		{
			name: "dropSession",
			start: (sm: SessionManager) => sm.dropSession(sm.getSessionFile() as string),
		},
		{ name: "fork", start: (sm: SessionManager) => sm.fork() },
		{
			name: "moveTo",
			start: (sm: SessionManager, storage: CloseHoldingStorage) => {
				storage.hideExistingFilesForMove();
				return sm.moveTo("/next-cwd");
			},
		},
	]) {
		it(`rejects appendMessage while ${transition.name} closes the writer`, async () => {
			const { sm, storage } = await createPrimedSession();
			const previousSessionId = sm.getSessionId();
			const previousSessionFile = sm.getSessionFile();
			const transitionPromise = transition.start(sm, storage);
			await waitForHeldClose(storage);

			expect(() => appendUser(sm, `during-${transition.name}`)).toThrow("Session manager close is in progress");
			if (transition.name === "moveTo") {
				expect(storage.releaseNextClose()).toBe(true);
				await Promise.resolve();
				expect(() => appendUser(sm, "after-close-before-move-completes")).toThrow(
					"Session manager close is in progress",
				);
			}

			await settle<unknown>(transitionPromise, storage);
			if (transition.name === "newSession" || transition.name === "dropSession" || transition.name === "fork") {
				expect(sm.getSessionId()).not.toBe(previousSessionId);
			} else if (transition.name === "moveTo") {
				expect(sm.getCwd()).toBe("/next-cwd");
				expect(sm.getSessionFile()).not.toBe(previousSessionFile);
			} else {
				expect(sm.getSessionId()).toBe(previousSessionId);
			}

			const afterTransition = `after-${transition.name}`;
			appendUser(sm, afterTransition);
			await expect(settle(sm.flush(), storage)).resolves.toBeUndefined();
			expect(sm.getEntries().at(-1)).toMatchObject({
				type: "message",
				message: { role: "user", content: afterTransition },
			});
		});
	}
	it("serializes overlapping setSessionFile transitions", async () => {
		const { sm, storage } = await createPrimedSession();
		const firstTarget = await settle(sm.newSession(), storage);
		await settle(sm.ensureOnDisk(), storage);
		const secondTarget = await settle(sm.newSession(), storage);
		await settle(sm.ensureOnDisk(), storage);
		appendUser(sm, "prime-second-target");
		await settle(sm.flush(), storage);

		const first = sm.setSessionFile(firstTarget as string);
		await waitForHeldClose(storage);
		const second = sm.setSessionFile(secondTarget as string);
		expect(() => appendUser(sm, "during-overlap")).toThrow("Session manager close is in progress");

		await settle(first, storage);
		await settle(second, storage);
		expect(sm.getSessionFile()).toBe(secondTarget);
		appendUser(sm, "after-overlap");
		await expect(settle(sm.flush(), storage)).resolves.toBeUndefined();
	});
	it("restores the old session after setSessionFile read EIO", async () => {
		const { sm, storage } = await createPrimedSession();
		const oldPath = sm.getSessionFile() as string;
		const oldId = sm.getSessionId();
		const adoptedArtifactManager = sm.getArtifactManager();
		if (!adoptedArtifactManager) throw new Error("Expected persistent artifact manager");
		sm.adoptArtifactManager(adoptedArtifactManager);
		storage.failNextRead();

		await expect(settle(sm.setSessionFile(oldPath), storage)).rejects.toThrow("Injected read EIO");
		expect(sm.getSessionFile()).toBe(oldPath);
		expect(sm.getSessionId()).toBe(oldId);
		expect(sm.getArtifactManager()).toBe(adoptedArtifactManager);

		appendUser(sm, "after-read-eio");
		await expect(settle(sm.flush(), storage)).resolves.toBeUndefined();
		expect(storage.readTextSync(oldPath)).toContain("after-read-eio");
		expect(sm.getEntries().at(-1)).toMatchObject({ message: { content: "after-read-eio" } });
	});

	it("resets only an active dropped session to a valid persisted session", async () => {
		const { sm, storage } = await createPrimedSession();
		const activePath = sm.getSessionFile() as string;
		const activeId = sm.getSessionId();
		await settle(sm.dropSession(activePath), storage);

		const replacementPath = sm.getSessionFile() as string;
		expect(replacementPath).not.toBe(activePath);
		expect(sm.getSessionId()).not.toBe(activeId);
		appendUser(sm, "after-active-drop");
		await expect(settle(sm.flush(), storage)).resolves.toBeUndefined();
		const replacementLines = storage.readTextSync(replacementPath).trim().split("\n");
		expect(JSON.parse(replacementLines[0])).toMatchObject({ type: "session", id: sm.getSessionId() });
		expect(replacementLines.join("\n")).toContain("after-active-drop");

		const beforeNonActiveDropPath = sm.getSessionFile();
		await settle(sm.dropSession(activePath), storage);
		expect(sm.getSessionFile()).toBe(beforeNonActiveDropPath);
	});

	it("restores the old session after fork target rename failure", async () => {
		const { sm, storage } = await createPrimedSession();
		const oldPath = sm.getSessionFile() as string;
		const oldId = sm.getSessionId();
		const oldEntries = sm.getEntries();
		storage.failNextRename();

		await expect(settle(sm.fork(), storage)).rejects.toThrow("Injected rename EIO");
		expect(sm.getSessionFile()).toBe(oldPath);
		expect(sm.getSessionId()).toBe(oldId);
		expect(sm.getEntries()).toEqual(oldEntries);

		appendUser(sm, "after-fork-eio");
		await expect(settle(sm.flush(), storage)).resolves.toBeUndefined();
		expect(storage.readTextSync(oldPath)).toContain("after-fork-eio");
	});
});
