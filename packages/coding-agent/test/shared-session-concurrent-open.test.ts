import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { ManagedLockTestHooks } from "../src/session/internal/managed-session-storage";
import {
	ManagedSessionReleaseError,
	managedSessionTransactionLockName,
} from "../src/session/internal/managed-session-transaction";
import {
	type SessionDestination,
	SessionManager,
	SessionManagerTestHooks,
	type SharedAppendOutcome,
} from "../src/session/session-manager";

const roots: string[] = [];
const managers: SessionManager[] = [];

afterEach(async () => {
	SessionManagerTestHooks.beforeExistingSessionHydration = undefined;
	ManagedLockTestHooks.beforeContentionWait = undefined;
	ManagedLockTestHooks.afterReleaseDurable = undefined;
	for (const manager of managers.splice(0)) await manager.closeStrict();
	for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
});

const user = (content: string, timestamp: number) => ({ role: "user" as const, content, timestamp });

async function fixture() {
	const root = await fs.mkdtemp(path.join(import.meta.dirname, ".tmp-concurrent-open-"));
	roots.push(root);
	const cwd = path.join(root, "workspace");
	const agentDir = path.join(root, "agent");
	await fs.mkdir(cwd, { recursive: true });
	await fs.mkdir(agentDir, { recursive: true, mode: 0o700 });
	const destination = SessionManager.managedDestination(cwd, agentDir);
	const seed = SessionManager.create(cwd, destination);
	managers.push(seed);
	const parent = seed.appendMessage(user("shared parent", 1));
	await seed.ensureOnDisk();
	const file = seed.getSessionFile()!;
	const bytes = await Bun.file(file).text();
	return { seed, destination, parent, file, bytes };
}

async function open(file: string, destination: SessionDestination) {
	const manager = await SessionManager.open(file, destination);
	managers.push(manager);
	return manager;
}

describe("concurrent managed opens", () => {
	// Recorded finding: bypassing only the transaction wrapper produced the same
	// authoritative candidate rejection for EOF and leading-blank inputs. The
	// advisory reader must tolerate those frames, but must not expand inventory
	// authority. CRLF succeeds through the existing end-to-end managed-open path.
	for (const framing of ["eof", "blank", "crlf"] as const) {
		it(`preserves managed candidate authority and bytes for ${framing} framing`, async () => {
			const { seed, destination, file, bytes } = await fixture();
			const header = bytes.split("\n")[0]!;
			const framed = framing === "eof" ? header : framing === "blank" ? `\n\n${bytes}` : `${header}\r\n`;
			await Bun.write(file, framed);
			if (framing === "crlf") {
				const opened = await open(file, destination);
				expect(opened.getSessionId()).toBe(seed.getSessionId());
				expect(await Bun.file(file).text()).toBe(framed);
				await opened.closeStrict();
			} else {
				await expect(open(file, destination)).rejects.toThrow("not an authorized managed candidate");
			}
			expect(await Bun.file(file).text()).toBe(framed);
		});
	}

	for (const malformed of ["\n{broken", "\r\n{}", "\n\n", '{"type":"message","id":"wrong"}']) {
		it(`rejects malformed advisory framing ${JSON.stringify(malformed)} without changing bytes`, async () => {
			const { destination, file } = await fixture();
			await Bun.write(file, malformed);
			const result = await open(file, destination).then(
				() => "opened",
				() => "rejected",
			);
			expect(result).toBe("rejected");
			expect(await Bun.file(file).text()).toBe(malformed);
		});
	}

	it("releases the transaction when hydration rejects", async () => {
		const { destination, file, bytes } = await fixture();
		const injected = new Error("hydration-failure");
		SessionManagerTestHooks.beforeExistingSessionHydration = () => {
			throw injected;
		};
		try {
			const result = await open(file, destination).then(
				() => undefined,
				error => error,
			);
			expect(result).toBe(injected);
		} finally {
			SessionManagerTestHooks.beforeExistingSessionHydration = undefined;
		}
		await open(file, destination);
		expect(await Bun.file(file).text()).toBe(bytes);
	});

	it("disposes an accepted manager without publishing when transaction release fails", async () => {
		const { destination, file, bytes: currentBytes, parent } = await fixture();
		const records = Bun.JSONL.parse(currentBytes) as Array<Record<string, unknown>>;
		records[0]!.version = 4;
		const bytes = `${records.map(record => JSON.stringify(record)).join("\n")}\n`;
		await Bun.write(file, bytes);
		const injected = new Error("release-after-acceptance");
		ManagedLockTestHooks.afterReleaseDurable = () => {
			throw injected;
		};
		try {
			const result = await SessionManager.open(file, destination).then(
				manager => ({ manager }),
				error => ({ error }),
			);
			if (!("error" in result)) throw new Error("Expected release failure");
			expect(result.error).toBeInstanceOf(ManagedSessionReleaseError);
			const failure = result.error as ManagedSessionReleaseError;
			expect(failure.cause).toBe(injected);
			expect(failure.outcome).toBeInstanceOf(SessionManager);
			const disposed = failure.outcome as SessionManager;
			// Rejected-open cleanup clears the resident graph instead of flushing it.
			expect(disposed.getEntry(parent)).toBeUndefined();
			expect(await Bun.file(file).text()).toBe(bytes);
		} finally {
			ManagedLockTestHooks.afterReleaseDurable = undefined;
		}
		const recovered = await open(file, destination);
		expect(recovered.getEntry(parent)?.id).toBe(parent);
		expect(await Bun.file(file).text()).toBe(bytes);
	});

	it("excludes a peer publication during async hydration, then preserves both local branches and the original bytes", async () => {
		const { seed, destination, parent, file, bytes } = await fixture();
		const entered = Promise.withResolvers<void>();
		const resume = Promise.withResolvers<void>();
		let hydrations = 0;
		SessionManagerTestHooks.beforeExistingSessionHydration = async candidate => {
			if (candidate !== file || ++hydrations !== 2) return;
			// The second open has captured its strict identity and entries, but has
			// not completed async blob hydration or the terminal identity check.
			entered.resolve();
			await resume.promise;
		};
		const lockName = `${managedSessionTransactionLockName(seed.getSessionId())}.lock`;

		// Start BOTH opens before awaiting either. No staggered-open workaround.
		const first = open(file, destination).then(
			manager => ({ manager, index: 0 }),
			error => ({ error, index: 0 }),
		);
		const second = open(file, destination).then(
			manager => ({ manager, index: 1 }),
			error => ({ error, index: 1 }),
		);
		// Attach a rejection handler immediately; the unfixed implementation fails
		// the second acceptance after the peer publishes during this pause.
		let paused = second;
		let publication: Promise<SharedAppendOutcome> | undefined;
		try {
			const completed = await Promise.race([first, second]);
			if ("error" in completed) throw completed.error;
			const a = completed.manager;
			paused = completed.index === 0 ? second : first;
			await Promise.race([
				entered.promise,
				paused.then(() => {
					throw new Error("Open settled before hydration barrier");
				}),
			]);
			// Ignore contention from the second OPEN; observe the append specifically.
			const appendContended = Promise.withResolvers<"contended">();
			ManagedLockTestHooks.beforeContentionWait = candidate => {
				if (path.basename(candidate) === lockName) appendContended.resolve("contended");
			};
			publication = a.appendMessageSharingSession(user("branch A", 2));
			const ordering = await Promise.race([appendContended.promise, publication.then(() => "published" as const)]);
			// Release on either path, so the unfixed code reports its identity failure
			// rather than merely hanging. There are no elapsed-time ordering guesses.
			resume.resolve();
			const opened = await paused;
			if ("error" in opened) throw opened.error;
			const b = opened.manager;
			expect(ordering).toBe("contended");
			expect(a.getSessionId()).toBe(seed.getSessionId());
			expect(b.getSessionId()).toBe(seed.getSessionId());
			expect(b.getLeafId()).toBe(parent);
			const aResult = await publication;
			expect(aResult.kind).toBe("committed");
			if (aResult.kind !== "committed") throw new Error("A did not commit");
			// Finalization is a separate short transaction, not nested in open. A
			// stale opener must not overwrite the committed peer's branch.
			const afterA = await Bun.file(file).text();
			expect(await b.finalizeWritableOpen()).toBe("stale");
			expect(await Bun.file(file).text()).toBe(afterA);
			const bResult = await b.appendMessageSharingSession(user("branch B", 3));
			expect(bResult.kind).toBe("committed");
			if (bResult.kind !== "committed") throw new Error("B did not commit");
			const committed = await Bun.file(file).text();
			expect(committed.startsWith(afterA)).toBe(true);
			expect(afterA.startsWith(bytes)).toBe(true);
			const records = Bun.JSONL.parse(committed) as Array<{ type: string; id: string; parentId?: string }>;
			expect(records.filter(record => record.type === "session")).toHaveLength(1);
			expect(records.filter(record => record.id === aResult.id)).toHaveLength(1);
			expect(records.filter(record => record.id === bResult.id)).toHaveLength(1);
			expect(records.find(record => record.id === aResult.id)?.parentId).toBe(parent);
			expect(records.find(record => record.id === bResult.id)?.parentId).toBe(parent);
			expect(a.getLeafId()).toBe(aResult.id);
			expect(b.getLeafId()).toBe(bResult.id);
			expect(await b.finalizeWritableOpen()).toBe("unchanged");
			expect(await Bun.file(file).text()).toBe(committed);
		} finally {
			resume.resolve();
			await Promise.all([first, second]);
			await publication;
		}
	});

	it("still rejects a nonparticipating writer changing the strict hydration snapshot", async () => {
		const { seed, destination, file, bytes } = await fixture();
		const entered = Promise.withResolvers<void>();
		const resume = Promise.withResolvers<void>();
		SessionManagerTestHooks.beforeExistingSessionHydration = async candidate => {
			if (candidate !== file) return;
			entered.resolve();
			await resume.promise;
		};
		const opening = open(file, destination).then(
			manager => ({ manager }),
			error => ({ error }),
		);
		try {
			await Promise.race([
				entered.promise,
				opening.then(() => {
					throw new Error("Open settled before hydration barrier");
				}),
			]);
			// This legacy mutation deliberately does NOT acquire the shared transaction.
			seed.appendMessage(user("outside the transaction", 2));
			await seed.flush();
			const changed = await Bun.file(file).text();
			expect(changed.startsWith(bytes)).toBe(true);
			expect(changed).not.toBe(bytes);
			resume.resolve();
			const result = await opening;
			expect("error" in result).toBe(true);
			if (!("error" in result)) throw new Error("Unfenced mutation was accepted");
			expect(String(result.error)).toContain("identity-mismatch");
			expect(await Bun.file(file).text()).toBe(changed);
		} finally {
			resume.resolve();
			await opening;
		}
	});
});
