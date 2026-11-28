import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { managedSessionTransactionLocksDirectory } from "../src/session/internal/managed-session-scope";
import { ManagedLockTestHooks } from "../src/session/internal/managed-session-storage";
import {
	ManagedSessionReleaseError,
	managedSessionTransactionLockName,
	withManagedSessionTransaction,
} from "../src/session/internal/managed-session-transaction";
import { type SessionDestination, SessionManager, SessionManagerTestHooks } from "../src/session/session-manager";

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

	it("holds the session transaction through async hydration", async () => {
		const { seed, destination, parent, file, bytes } = await fixture();
		const entered = Promise.withResolvers<void>();
		const resume = Promise.withResolvers<void>();
		SessionManagerTestHooks.beforeExistingSessionHydration = async candidate => {
			if (candidate !== file) return;
			// The open has captured its strict identity and entries, but has not completed
			// async blob hydration or the terminal identity check.
			entered.resolve();
			await resume.promise;
		};
		const lockName = `${managedSessionTransactionLockName(seed.getSessionId())}.lock`;
		const opening = open(file, destination).then(
			manager => ({ manager }),
			error => ({ error }),
		);
		let transaction: Promise<string> | undefined;
		try {
			await Promise.race([
				entered.promise,
				opening.then(() => {
					throw new Error("Open settled before hydration barrier");
				}),
			]);
			const contended = Promise.withResolvers<"contended">();
			ManagedLockTestHooks.beforeContentionWait = candidate => {
				if (path.basename(candidate) === lockName) contended.resolve("contended");
			};
			transaction = withManagedSessionTransaction(
				{
					locksDirectory: managedSessionTransactionLocksDirectory(path.dirname(file)),
					sessionId: seed.getSessionId(),
				},
				async () => "acquired",
			);
			const ordering = await Promise.race([contended.promise, transaction]);
			// Release on either path, so a regression reports its ordering rather than hanging.
			resume.resolve();
			const opened = await opening;
			if ("error" in opened) throw opened.error;
			expect(ordering).toBe("contended");
			expect(opened.manager.getSessionId()).toBe(seed.getSessionId());
			expect(opened.manager.getLeafId()).toBe(parent);
			expect(await transaction).toBe("acquired");
			expect(await Bun.file(file).text()).toBe(bytes);
		} finally {
			resume.resolve();
			await opening;
			await transaction;
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
