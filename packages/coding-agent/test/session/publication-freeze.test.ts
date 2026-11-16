import { afterEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { managedSessionTransactionLocksDirectory } from "../../src/session/internal/managed-session-scope";
import { managedSessionTransactionLockName } from "../../src/session/internal/managed-session-transaction";
import { PublicationBarrier } from "../../src/session/publication-freeze";
import { type FileEntry, SessionManager, SessionManagerTestHooks } from "../../src/session/session-manager";
import {
	FileSessionStorage,
	MemorySessionStorage,
	type SessionStorageWriter,
	type SessionStorageWriterOpenOptions,
} from "../../src/session/session-storage";

class ProbeStorage extends MemorySessionStorage {
	stageGate: PromiseWithResolvers<void> | undefined;
	readonly stageEntered = Promise.withResolvers<void>();
	stageWrites = 0;
	fsyncError: Error | undefined;
	flushGate: PromiseWithResolvers<void> | undefined;

	override openWriter(file: string, options?: SessionStorageWriterOpenOptions): SessionStorageWriter {
		const writer = super.openWriter(file, options);
		return {
			writeLine: async line => {
				if (file.endsWith(".default-selection.tmp")) {
					this.stageWrites++;
					this.stageEntered.resolve();
					await this.stageGate?.promise;
				}
				await writer.writeLine(line);
			},
			writeLineSync: line => writer.writeLineSync(line),
			flush: async () => {
				await this.flushGate?.promise;
				await writer.flush();
			},
			fsync: async () => {
				if (this.fsyncError) throw this.fsyncError;
				await writer.fsync();
			},
			fsyncSync: () => writer.fsyncSync?.(),
			statSync: writer.statSync ? () => writer.statSync!() : undefined,
			close: () => writer.close(),
			closeSync: () => writer.closeSync(),
			getError: () => writer.getError(),
			getCloseState: () => writer.getCloseState(),
			getCloseError: () => writer.getCloseError(),
		};
	}
}

const managers: SessionManager[] = [];
const directories: string[] = [];

afterEach(async () => {
	SessionManagerTestHooks.beforeTitlePatchPersistence = undefined;
	SessionManagerTestHooks.beforeTitleRewriteFence = undefined;
	vi.restoreAllMocks();
	for (const manager of managers.splice(0)) await manager.closeStrict();
	for (const directory of directories.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

async function fixture(storage = new ProbeStorage()) {
	const manager = SessionManager.create("/cwd", "/sessions", storage);
	managers.push(manager);
	manager.setSessionMemoryMode("off");
	await manager.ensureOnDisk();
	const rootId = manager.appendMessage({ role: "user", content: "root", timestamp: 1 });
	await manager.flush();
	const file = manager.getSessionFile();
	if (!file) throw new Error("Missing fixture transcript");
	return { manager, storage, file, rootId };
}

async function managedFixture() {
	const directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "gjc-publication-freeze-")));
	directories.push(directory);
	const cwd = path.join(directory, "workspace");
	fs.mkdirSync(cwd, { mode: 0o700 });
	const storage = new FileSessionStorage();
	const destination = SessionManager.managedDestination(cwd, path.join(directory, "agent"), storage);
	const manager = SessionManager.create(cwd, destination, storage);
	managers.push(manager);
	manager.setSessionMemoryMode("enabled");
	await manager.ensureOnDisk();
	const file = manager.getSessionFile();
	if (!file) throw new Error("Missing managed transcript");
	return { directory, manager, file };
}

function records(storage: MemorySessionStorage, file: string): FileEntry[] {
	return storage
		.readTextSync(file)
		.trimEnd()
		.split("\n")
		.map(line => JSON.parse(line) as FileEntry);
}

async function microtasks(): Promise<void> {
	for (let index = 0; index < 30; index++) await Promise.resolve();
}

function observe<T>(promise: Promise<T>): () => boolean {
	let settled = false;
	void promise.then(
		() => {
			settled = true;
		},
		() => {
			settled = true;
		},
	);
	return () => settled;
}

function sidecarBytes(directory: string): Record<string, string> {
	const result: Record<string, string> = {};
	const visit = (current: string): void => {
		for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
			const file = path.join(current, entry.name);
			if (entry.isDirectory()) visit(file);
			else if (entry.name.includes(".spill."))
				result[path.relative(directory, file)] = fs.readFileSync(file).toString("base64");
		}
	};
	visit(directory);
	return result;
}

describe("manager-local reversible publication freeze", () => {
	it("stages synchronous IDs and immediate parents, then publishes held FIFO before parked preparation", async () => {
		const { manager, storage, file, rootId } = await fixture();
		const before = storage.readTextSync(file);
		const generation = manager.capturePublicationGeneration();
		const freeze = await manager.quiesceNonterminalPublication(Symbol("owner"));
		try {
			const first = manager.appendMessage({ role: "user", content: "first", timestamp: 2 });
			const second = manager.appendMessage({ role: "user", content: "second", timestamp: 3 });
			const parked = manager.appendMessageDurably({ role: "user", content: "parked", timestamp: 4 });
			const settled = observe(parked);
			await microtasks();
			expect(settled()).toBe(false);
			expect(storage.readTextSync(file)).toBe(before);
			expect(manager.getLeafId()).toBe(second);
			const debt = freeze.debt();
			expect(debt.heldIds).toEqual([first, second]);
			expect(debt.rewriteDebt).toBe(false);
			expect(debt.heldReason).toBe("freeze_parked");
			expect(debt.generation.fileEntriesIndex).toBe(generation.fileEntriesIndex + 2);
			expect(debt.generation.entryRevision).toBe(generation.entryRevision + 2);
			expect(debt.entries.slice(-2).map(entry => ("parentId" in entry ? entry.parentId : null))).toEqual([
				rootId,
				first,
			]);
			await freeze.thaw();
			const outcome = await parked;
			expect(outcome.kind).toBe("accepted");
			await manager.flush();
			const published = records(storage, file).filter(entry => entry.type !== "session");
			expect(published.map(entry => entry.id).slice(0, 3)).toEqual([rootId, first, second]);
			expect(new Set(published.map(entry => entry.id)).size).toBe(published.length);
			expect(published.at(-1)?.parentId).toBe(second);
		} finally {
			// A successful thaw invalidates this capability; cleanup must not reopen a successor.
			await freeze.thaw().catch(() => {});
		}
	});

	it("drains an admitted preparation paused before promotion and parks new preparation before temp writes", async () => {
		const { manager, storage, file } = await fixture();
		storage.stageGate = Promise.withResolvers<void>();
		const stagePromise = manager.stageDefaultModelSelection("model-a", undefined, { appendThinkingLevel: false });
		await storage.stageEntered.promise;
		const freezing = manager.quiesceNonterminalPublication(Symbol("owner"));
		const ready = observe(freezing);
		const parked = manager.stageDefaultModelSelection("model-b", undefined, { appendThinkingLevel: false });
		const parkedSettled = observe(parked);
		await microtasks();
		expect(ready()).toBe(false);
		expect(parkedSettled()).toBe(false);
		expect(storage.stageWrites).toBe(1);
		storage.stageGate.resolve();
		const stage = await stagePromise;
		const freeze = await freezing;
		try {
			const before = storage.readTextSync(file);
			expect(manager.promoteDefaultModelSelection(stage)).toMatchObject({
				kind: "not_promoted",
				error: { message: "publication_freeze_parked" },
			});
			expect(storage.readTextSync(file)).toBe(before);
			await freeze.drain();
		} finally {
			await freeze.thaw();
		}
		const secondStage = await parked;
		// The original prepared stage remains intact and retryable, not reported as a success.
		expect(manager.promoteDefaultModelSelection(stage).kind).toBe("promoted");
		await manager.discardDefaultModelSelectionStage(secondStage);
		expect(records(storage, file).some(entry => entry.type === "model_change" && entry.model === "model-a")).toBe(
			true,
		);
	});

	it("drains preparation at the final gate without waiting on held completion or queued successors", async () => {
		const { manager, storage, file } = await fixture();
		const entered = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		SessionManagerTestHooks.beforeTitlePatchPersistence = async () => {
			entered.resolve();
			await release.promise;
		};
		const first = manager.setSessionName("first", "user");
		await entered.promise;
		const second = manager.setSessionName("second", "user");
		const before = storage.readTextSync(file);
		const freezing = manager.quiesceNonterminalPublication(Symbol("owner"));
		release.resolve();
		const freeze = await freezing;
		try {
			expect(storage.readTextSync(file)).toBe(before);
			expect(observe(first)()).toBe(false);
			await freeze.drain();
		} finally {
			await freeze.thaw();
		}
		expect(await first).toBe(true);
		expect(await second).toBe(true);
		expect(manager.getSessionName()).toBe("second");
		const text = storage.readTextSync(file);
		expect(text.indexOf('"title":"first"')).toBeLessThan(text.indexOf('"title":"second"'));
	});

	it("joins already dispatched writer I/O rather than assuming it can be canceled", async () => {
		const { manager, storage } = await fixture();
		storage.flushGate = Promise.withResolvers<void>();
		const flushing = manager.flush();
		await microtasks();
		const successor = manager.flush();
		const successorSettled = observe(successor);
		const freezing = manager.quiesceNonterminalPublication(Symbol("owner"));
		const ready = observe(freezing);
		await microtasks();
		expect(ready()).toBe(false);
		storage.flushGate.resolve();
		await flushing;
		const freeze = await freezing;
		expect(successorSettled()).toBe(false);
		await freeze.thaw();
		await successor;
	});

	it("does not claim managed canonical bytes or sidecar durability for a frozen append", async () => {
		const { directory, manager, file } = await managedFixture();
		const before = fs.readFileSync(file);
		const sidecars = sidecarBytes(directory);
		const freeze = await manager.quiesceNonterminalPublication(Symbol("owner"));
		let id: string;
		let preparedJson: string;
		try {
			id = manager.appendMessage({
				role: "user",
				content: [{ type: "image", data: Buffer.alloc(40_000, 5).toString("base64"), mimeType: "image/png" }],
				timestamp: 2,
			});
			const debt = freeze.debt();
			expect(debt.heldIds).toEqual([id]);
			const prepared = debt.preparedEntries.find(record => record.entry.id === id);
			if (!prepared) throw new Error("Missing prepared image record");
			preparedJson = prepared.json;
			expect(prepared.json).toContain("blob:sha256:");
			expect(prepared.sha256).toBe(new Bun.SHA256().update(prepared.json).digest("hex"));
			expect(fs.readFileSync(file).equals(before)).toBe(true);
			expect(sidecarBytes(directory)).toEqual(sidecars);
		} finally {
			await freeze.thaw();
		}
		await manager.flush();
		const read = await manager.captureCommittedSnapshot();
		expect(read.kind).toBe("snapshot");
		if (read.kind === "snapshot") expect(read.snapshot.entryIds.filter(entryId => entryId === id!)).toHaveLength(1);
		expect(fs.readFileSync(file, "utf8").split("\n")).toContain(preparedJson!);
	});

	it("keeps held resident references and the cursor intact across cold-view materialization", async () => {
		const { manager, storage, file } = await fixture();
		manager.appendMessage({ role: "user", content: "cold ".repeat(40_000), timestamp: 2 });
		const kept = manager.appendMessage({ role: "user", content: "kept", timestamp: 3 });
		manager.appendCompaction("summary", undefined, kept, 10_000);
		manager.setSessionMemoryMode("enabled");
		expect(manager.getSessionMemoryStats().coldRetirementActive).toBe(true);
		const sidecars = ["idx", "tail", "commit"].map(kind => `${file.slice(0, -6)}/.session-memory.spill.${kind}`);
		const before = sidecars.map(sidecar => storage.readTextSync(sidecar));
		const freeze = await manager.quiesceNonterminalPublication(Symbol("owner"));
		let first: string;
		let second: string;
		try {
			first = manager.appendMessage({ role: "user", content: "held ".repeat(24_000), timestamp: 4 });
			second = manager.appendCustomEntry("last", {});
			const entries = manager.getEntriesForExport();
			expect(entries.slice(-2).map(entry => entry.id)).toEqual([first, second]);
			expect(manager.getLeafId()).toBe(second);
			expect(sidecars.map(sidecar => storage.readTextSync(sidecar))).toEqual(before);
			expect(freeze.debt().heldIds).toEqual([first, second]);
		} finally {
			await freeze.thaw();
		}
		await manager.flush();
		const published = records(storage, file).filter(entry => entry.type !== "session");
		expect(published.slice(-2).map(entry => entry.id)).toEqual([first!, second!]);
		expect(published.at(-1)?.parentId).toBe(first!);
		expect(manager.getLeafId()).toBe(second!);
	});

	it("releases a direct shared lease before parking and revalidates publication after thaw", async () => {
		const { manager, file } = await managedFixture();
		const entered = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		const capture = manager.captureCommittedSnapshot.bind(manager);
		let firstCapture = true;
		vi.spyOn(manager, "captureCommittedSnapshot").mockImplementation(async () => {
			if (firstCapture) {
				firstCapture = false;
				entered.resolve();
				await release.promise;
			}
			return capture();
		});
		const before = fs.readFileSync(file);
		const publishing = manager.appendCustomEntrySharingSession("shared", { value: 1 });
		await entered.promise;
		const freezing = manager.quiesceNonterminalPublication(Symbol("owner"));
		release.resolve();
		const freeze = await freezing;
		try {
			const lock = path.join(
				managedSessionTransactionLocksDirectory(path.dirname(file)),
				managedSessionTransactionLockName(manager.getSessionId()),
			);
			expect(fs.existsSync(lock)).toBe(false);
			expect(fs.readFileSync(file).equals(before)).toBe(true);
			expect(observe(publishing)()).toBe(false);
		} finally {
			await freeze.thaw();
		}
		const outcome = await publishing;
		expect(outcome.kind).toBe("committed");
		if (outcome.kind === "committed") {
			const read = await capture();
			if (read.kind !== "snapshot") throw new Error("Missing shared publication");
			expect(read.snapshot.entryIds.filter(id => id === outcome.id)).toHaveLength(1);
		}
	});

	it("retains real rewrite debt while frozen and clears it only after actual publication", async () => {
		const { manager, storage, file, rootId } = await fixture();
		const entry = manager.getEntry(rootId);
		if (entry?.type !== "message") throw new Error("Missing root message");
		manager.applyEntryMessageUpdates([{ ...entry, message: { role: "user", content: "edited", timestamp: 1 } }]);
		const before = storage.readTextSync(file);
		const freeze = await manager.quiesceNonterminalPublication(Symbol("owner"));
		const first = manager.appendCustomEntry("rewrite-held-one", {});
		const second = manager.appendCustomEntry("rewrite-held-two", {});
		const rewriting = manager.rewriteEntries();
		try {
			expect(freeze.debt().rewriteDebt).toBe(true);
			expect(freeze.debt().heldReason).toBe("rewrite_debt");
			expect(storage.readTextSync(file)).toBe(before);
		} finally {
			await freeze.thaw();
		}
		await rewriting;
		const next = await manager.quiesceNonterminalPublication(Symbol("next"));
		try {
			expect(next.debt().rewriteDebt).toBe(false);
		} finally {
			await next.thaw();
		}
		expect(storage.readTextSync(file)).toContain("edited");
		const published = records(storage, file).filter(entry => entry.type !== "session");
		expect(published.filter(entry => entry.id === first)).toHaveLength(1);
		expect(published.filter(entry => entry.id === second)).toHaveLength(1);
		expect(published.at(-1)?.parentId).toBe(first);
		expect(manager.getLeafId()).toBe(second);
	});

	it("preserves held entries and the exact sticky persistence error after thaw", async () => {
		const { manager, storage, file } = await fixture();
		const error = new Error("injected fsync failure");
		storage.fsyncError = error;
		await expect(manager.flush()).rejects.toBe(error);
		const before = storage.readTextSync(file);
		const freeze = await manager.quiesceNonterminalPublication(Symbol("owner"));
		const first = manager.appendCustomEntry("held-one", { value: 1 });
		const second = manager.appendCustomEntry("held-two", { value: 2 });
		expect(freeze.debt().persistError).toBe(error);
		await freeze.thaw();
		await expect(manager.flush()).rejects.toBe(error);
		expect(storage.readTextSync(file)).toBe(before);
		const next = await manager.quiesceNonterminalPublication(Symbol("next"));
		try {
			const debt = next.debt();
			expect(debt.persistError).toBe(error);
			expect(debt.heldReason).toBe("persist_debt");
			expect(debt.heldIds).toEqual([first, second]);
			expect(debt.entries.slice(-2).map(entry => entry.id)).toEqual([first, second]);
		} finally {
			await next.thaw();
		}
	});

	it("materializes a detached debt snapshot without moving the leaf", async () => {
		const { manager } = await fixture();
		const freeze = await manager.quiesceNonterminalPublication(Symbol("owner"));
		try {
			const text = "resident text ".repeat(12_000);
			const id = manager.appendMessage({ role: "user", content: text, timestamp: 5 });
			const snapshot = freeze.debt();
			const copied = snapshot.entries.find(entry => entry.id === id);
			if (copied?.type !== "message" || copied.message.role !== "user")
				throw new Error("Missing materialized entry");
			expect(copied.message.content).toBe(text);
			copied.message.content = "mutated snapshot";
			const fresh = freeze.debt().entries.find(entry => entry.id === id);
			expect(fresh).toMatchObject({ message: { content: text } });
			expect(manager.getLeafId()).toBe(id);
		} finally {
			await freeze.thaw();
		}
	});

	it("releases the same owned freeze after recovery invalidates lifecycle and throws", async () => {
		let lifecycle = "before";
		const barrier = new PublicationBarrier(
			() => lifecycle,
			heldIds => ({
				generation: { fileEntriesIndex: 0, entryRevision: 0 },
				entries: [],
				preparedEntries: [],
				rewriteDebt: false,
				heldIds: [...heldIds],
			}),
		);
		const freeze = await barrier.quiesce(Symbol("owner"));
		const failure = new Error("recovery failed after lifecycle invalidation");
		await expect(
			freeze.runRecovery(async () => {
				lifecycle = "after";
				throw failure;
			}),
		).rejects.toBe(failure);
		await freeze.thaw();
		expect(barrier.active).toBe(false);
		let admitted = false;
		await barrier.prepare(async () => {
			admitted = true;
		});
		expect(admitted).toBe(true);
		await barrier.joinClose();
	});

	it("retains invalidated publication debt and never lets an old freeze release its successor", async () => {
		let lifecycle = "before";
		const failure = new Error("original persistence debt");
		const barrier = new PublicationBarrier(
			() => lifecycle,
			heldIds => ({
				generation: { fileEntriesIndex: 1, entryRevision: 1 },
				entries: [],
				preparedEntries: [],
				rewriteDebt: true,
				persistError: failure,
				heldIds: [...heldIds],
			}),
		);
		const freeze = await barrier.quiesce(Symbol("owner"));
		let dispatched = 0;
		await freeze.runRecovery(async () => {
			lifecycle = "after";
			expect(
				barrier.holdSync(() => {
					dispatched++;
					throw failure;
				}, "held"),
			).toBe(true);
		});
		await expect(freeze.drain()).rejects.toThrow("publication_freeze_stale_handle");
		expect(() => freeze.debt()).toThrow("publication_freeze_stale_handle");
		await freeze.thaw();
		expect(dispatched).toBe(0);
		const successor = await barrier.quiesce(Symbol("successor"));
		try {
			expect(successor.debt()).toMatchObject({ heldIds: ["held"], rewriteDebt: true, persistError: failure });
			expect(successor.debt().persistError).toBe(failure);
			await expect(freeze.thaw()).rejects.toThrow("publication_freeze_stale_handle");
			await expect(freeze.runRecovery(async () => {})).rejects.toThrow("publication_freeze_stale_handle");
			expect(barrier.active).toBe(true);
			expect(dispatched).toBe(0);
			barrier.beginClose();
			const closing = barrier.joinClose();
			const settled = observe(closing);
			await microtasks();
			expect(settled()).toBe(false);
			await successor.thaw();
			await closing;
			expect(dispatched).toBe(1);
			expect(barrier.active).toBe(false);
		} finally {
			await successor.thaw().catch(() => {});
		}
	});

	it("thaws in finally after a recovery exception and keeps another manager's capability isolated", async () => {
		const { manager, storage, file } = await fixture();
		const other = await fixture();
		const freeze = await manager.quiesceNonterminalPublication(Symbol("owner"));
		const foreign = await other.manager.quiesceNonterminalPublication(Symbol("other"));
		const id = manager.appendCustomEntry("held", {});
		try {
			await expect(
				freeze.runRecovery(async () => {
					await manager.flush(); // nested owner capability must not park against itself
					throw new Error("recovery body failed");
				}),
			).rejects.toThrow("recovery body failed");
			await foreign.thaw();
			expect(records(storage, file).some(entry => entry.id === id)).toBe(false);
		} finally {
			await freeze.thaw();
		}
		expect(records(storage, file).filter(entry => entry.id === id)).toHaveLength(1);
		const successor = await manager.quiesceNonterminalPublication(Symbol("successor"));
		try {
			await expect(freeze.thaw()).rejects.toThrow("publication_freeze_stale_handle");
			await expect(freeze.runRecovery(async () => {})).rejects.toThrow("publication_freeze_stale_handle");
			expect(successor.freezeId).not.toBe(freeze.freezeId);
		} finally {
			await successor.thaw();
		}
	});

	it("close starts irreversible admission, joins freeze ownership, and drains held work without reopening callers", async () => {
		const { manager, storage, file, rootId } = await fixture();
		const freeze = await manager.quiesceNonterminalPublication(Symbol("owner"));
		try {
			const first = manager.appendCustomEntry("held-first", {});
			const second = manager.appendCustomEntry("held-second", {});
			const parked = manager.appendMessageDurably({ role: "user", content: "must not stage", timestamp: 6 });
			const closing = manager.closeStrict();
			// Bun's rejection matcher waits eagerly: close must reject admission before asserting it.
			await expect(parked).rejects.toThrow("closing");
			expect(manager.getStrictCloseCompletion()).toBe(closing);
			expect(manager.closeStrict()).toBe(closing);
			const settled = observe(closing);
			await microtasks();
			expect(settled()).toBe(false);
			expect(manager.getLeafId()).toBe(second);
			expect(freeze.debt().heldIds).toEqual([first, second]);
			expect(() => manager.appendCustomEntry("late", {})).toThrow("closing");
			expect(() => manager.setSessionMemoryMode("enabled")).toThrow("closing");
			await expect(
				manager.appendMessageDurably({ role: "user", content: "late async", timestamp: 7 }),
			).rejects.toThrow("closing");
			await Promise.all([freeze.thaw(), freeze.thaw()]);
			expect((await closing).kind).toBe("closed");
			const published = records(storage, file).filter(entry => entry.type !== "session");
			expect(published.map(entry => entry.id)).toEqual([rootId, first, second]);
			expect(published.map(entry => entry.parentId)).toEqual([null, rootId, first]);
			expect(new Set(published.map(entry => entry.id)).size).toBe(published.length);
			expect(storage.readTextSync(file)).not.toContain("must not stage");
			expect(manager.getStrictCloseCompletion()).toBeUndefined();
			const closedBytes = storage.readTextSync(file);
			expect(() => manager.setSessionMemoryMode("enabled")).toThrow("closing");
			await expect(manager.ensureOnDisk()).rejects.toThrow("closing");
			await expect(manager.quiesceNonterminalPublication(Symbol("late"))).rejects.toThrow("closing");
			await microtasks();
			expect(storage.readTextSync(file)).toBe(closedBytes);
		} finally {
			// Assertion failures must not leave teardown waiting on an unreleased freeze.
			await freeze.thaw().catch(() => {});
		}
	});

	it("adds no transcript materialization or scan to open hot appends and generation capture", async () => {
		const { manager, storage } = await fixture();
		const read = vi.spyOn(storage, "readTextSync");
		const readBytes = vi.spyOn(storage, "readBytesSync");
		const entries = vi.spyOn(manager, "getEntriesForExport");
		const generation = manager.capturePublicationGeneration();
		manager.appendCustomEntry("hot", {});
		expect(manager.capturePublicationGeneration().entryRevision).toBe(generation.entryRevision + 1);
		expect(read).not.toHaveBeenCalled();
		expect(readBytes).not.toHaveBeenCalled();
		expect(entries).not.toHaveBeenCalled();
	});
});
