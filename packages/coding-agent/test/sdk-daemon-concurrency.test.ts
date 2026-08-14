import { describe, expect, test } from "bun:test";
import { isProcessIncarnation, processIncarnation } from "../src/sdk/broker/process-incarnation";
import { ChatEffectJournal, MAX_TERMINAL_CHAT_EFFECTS } from "../src/sdk/bus/chat-effect-journal";
import {
	boundedDedupe,
	ConversationLockTimeoutError,
	type ConversationRecord,
	ConversationStore,
	conversationStorePath,
	MAX_DEDUPE_IDS,
} from "../src/sdk/bus/conversation-store";
import type { SlackConversation } from "../src/sdk/bus/slack-conversation";
import { MemoryConversationStoreFs } from "./fixtures/chat-daemon-stores";

interface TestConversation extends ConversationRecord {
	state: "creating" | "active";
	seenEventIds: string[];
}

function record(generation: number, state: TestConversation["state"] = "creating"): TestConversation {
	return { generation, state, seenEventIds: [] };
}

class LockMetadataFs extends MemoryConversationStoreFs {
	lockMetadata?: string;

	override async open(file: string, flags: string) {
		const handle = await super.open(file, flags);
		if (flags !== "wx" || !file.endsWith(".pending")) return handle;
		return {
			...handle,
			writeFile: async (data: string, encoding: "utf8") => {
				this.lockMetadata = data.trim();
				await handle.writeFile(data, encoding);
			},
		};
	}
}

async function captureLockMetadata(): Promise<string> {
	const fs = new LockMetadataFs();
	const store = new ConversationStore<TestConversation>({ agentDir: "/capture", kind: "discord", fs });
	await store.write("capture", undefined, record(1));
	const metadata = fs.lockMetadata;
	if (!metadata) throw new Error("lock metadata was not captured");
	return metadata;
}

describe("ConversationStore", () => {
	test("creates the transport store under the SDK daemon path and permits one concurrent creator", async () => {
		const fs = new MemoryConversationStoreFs();
		const store = new ConversationStore<TestConversation>({ agentDir: "/agent", kind: "discord", fs, now: () => 1 });
		expect(store.filePath).toBe(conversationStorePath("/agent", "discord"));
		const [first, second] = await Promise.all([
			store.write("mapping", undefined, record(1)),
			store.write("mapping", undefined, record(1)),
		]);
		expect([first, second].filter(Boolean)).toHaveLength(1);
		expect(await store.read("mapping")).toEqual(record(1));
		expect(fs.modes.get(store.filePath)).toBe(0o600);
		expect(fs.modes.get("/agent/sdk/daemons/discord")).toBe(0o700);
	});
	test("closes and removes an unpublished lock when metadata construction fails", async () => {
		const fs = new MemoryConversationStoreFs();
		const metadataError = new Error("pid incarnation failed");
		const store = new ConversationStore<TestConversation>({
			agentDir: "/agent",
			kind: "discord",
			fs,
			pidIncarnation: () => {
				throw metadataError;
			},
		});
		await expect(store.write("mapping", undefined, record(1))).rejects.toBe(metadataError);
		const lockFile = `${store.filePath}.lock`;
		const pendingClose = fs.calls.find(call => call.startsWith(`close:${lockFile}.`) && call.endsWith(".pending"));
		expect(pendingClose).toBeDefined();
		expect([...fs.files.keys()].some(file => file.endsWith(".pending"))).toBe(false);
		expect(fs.files.has(lockFile)).toBe(false);
	});
	test("cleans the pending alias but keeps the primary marker when its unlink fails", async () => {
		const primaryError = new Error("primary lock unlink failed");
		const pendingError = new Error("pending lock unlink failed");
		class CleanupFailingFs extends MemoryConversationStoreFs {
			pendingUnlinkAttempts = 0;
			primaryUnlinkAttempts = 0;

			override async unlink(file: string) {
				if (file.endsWith(".pending")) {
					this.pendingUnlinkAttempts++;
					if (this.pendingUnlinkAttempts === 1) throw pendingError;
				}
				if (file.endsWith("conversations.json.lock")) {
					this.primaryUnlinkAttempts++;
					if (this.primaryUnlinkAttempts === 1) throw primaryError;
				}
				await super.unlink(file);
			}
		}
		const fs = new CleanupFailingFs();
		const store = new ConversationStore<TestConversation>({ agentDir: "/agent", kind: "discord", fs });
		const lockFile = `${store.filePath}.lock`;

		await expect(store.write("mapping", undefined, record(1))).rejects.toBe(primaryError);
		expect(fs.pendingUnlinkAttempts).toBe(2);
		expect(fs.primaryUnlinkAttempts).toBe(1);
		expect([...fs.files.keys()].some(file => file.endsWith(".pending"))).toBe(false);
		expect(fs.files.has(lockFile)).toBe(true);
	});
	test("cleans the pending lock when metadata write fails", async () => {
		const fs = new MemoryConversationStoreFs();
		fs.failLockWrite = true;
		const store = new ConversationStore<TestConversation>({ agentDir: "/agent", kind: "discord", fs });
		const lockFile = `${store.filePath}.lock`;

		await expect(store.write("mapping", undefined, record(1))).rejects.toThrow("lock write failed");
		expect([...fs.files.keys()].some(file => file.endsWith(".pending"))).toBe(false);
		expect(fs.files.has(lockFile)).toBe(false);
	});

	test("cleans the pending lock when metadata sync fails", async () => {
		const fs = new MemoryConversationStoreFs();
		fs.failLockSync = true;
		const store = new ConversationStore<TestConversation>({ agentDir: "/agent", kind: "discord", fs });
		const lockFile = `${store.filePath}.lock`;

		await expect(store.write("mapping", undefined, record(1))).rejects.toThrow("sync failed");
		expect([...fs.files.keys()].some(file => file.endsWith(".pending"))).toBe(false);
		expect(fs.files.has(lockFile)).toBe(false);
	});

	test("cleans the pending lock when hard-link publication fails without EEXIST", async () => {
		const fs = new MemoryConversationStoreFs();
		fs.failLockLink = true;
		const store = new ConversationStore<TestConversation>({ agentDir: "/agent", kind: "discord", fs });
		const lockFile = `${store.filePath}.lock`;

		await expect(store.write("mapping", undefined, record(1))).rejects.toMatchObject({ code: "EPERM" });
		expect(fs.calls.some(call => call.startsWith(`link:${lockFile}.`) && call.endsWith(`:${lockFile}`))).toBe(true);
		expect([...fs.files.keys()].some(file => file.endsWith(".pending"))).toBe(false);
		expect(fs.files.has(lockFile)).toBe(false);
	});

	test("keeps the primary lock path absent until complete metadata is synced", async () => {
		const entered = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		let paused = false;
		class PausingFs extends MemoryConversationStoreFs {
			override async open(file: string, flags: string) {
				const handle = await super.open(file, flags);
				if (flags === "wx" && file.endsWith(".pending") && !paused) {
					paused = true;
					entered.resolve();
					await release.promise;
				}
				return handle;
			}
		}
		const fs = new PausingFs();
		const store = new ConversationStore<TestConversation>({
			agentDir: "/agent",
			kind: "discord",
			fs,
			pid: 101,
			pidAlive: () => true,
		});
		const write = store.write("mapping", undefined, record(1));
		await entered.promise;
		const lockFile = `${store.filePath}.lock`;
		expect(fs.files.has(lockFile)).toBe(false);
		expect([...fs.files.keys()].some(file => file.endsWith(".pending"))).toBe(true);
		release.resolve();
		await expect(write).resolves.toBe(true);
		expect(fs.files.has(lockFile)).toBe(false);
		expect(fs.calls.some(call => call.startsWith(`link:${lockFile}.`) && call.endsWith(`:${lockFile}`))).toBe(true);
	});
	test("publishes complete synced metadata before admitting a same-process successor", async () => {
		const enteredLink = Promise.withResolvers<void>();
		const releaseLink = Promise.withResolvers<void>();
		let firstLink = true;
		class PublicationBarrierFs extends MemoryConversationStoreFs {
			override async link(from: string, to: string): Promise<void> {
				if (!firstLink) return await super.link(from, to);
				firstLink = false;
				const metadata = this.files.get(from);
				expect(metadata).toBeDefined();
				expect(JSON.parse(metadata!.trim())).toEqual({
					pid: 101,
					incarnation: "unavailable",
					isolateId: expect.any(String),
					timestamp: 1,
					nonce: expect.any(String),
				});
				expect(this.calls.at(-1)).toBe(`sync:${from}`);
				await super.link(from, to);
				enteredLink.resolve();
				await releaseLink.promise;
			}
		}
		const fs = new PublicationBarrierFs();
		const first = new ConversationStore<TestConversation>({
			agentDir: "/agent",
			kind: "discord",
			fs,
			pid: 101,
			pidIncarnation: () => undefined,
			pidAlive: () => true,
			now: () => 1,
		});
		const second = new ConversationStore<TestConversation>({
			agentDir: "/agent",
			kind: "discord",
			fs,
			pid: 101,
			pidIncarnation: () => undefined,
			pidAlive: () => true,
			lockTimeoutMs: 0,
		});
		const lockFile = `${first.filePath}.lock`;
		const firstWrite = first.write("mapping", undefined, record(1));
		await enteredLink.promise;
		expect(fs.files.has(lockFile)).toBe(true);
		await expect(second.write("mapping", undefined, record(1))).rejects.toBeInstanceOf(ConversationLockTimeoutError);
		releaseLink.resolve();
		await expect(firstWrite).resolves.toBe(true);
		const pendingSync = fs.calls.findIndex(call => call.startsWith(`sync:${lockFile}.`) && call.endsWith(".pending"));
		const publication = fs.calls.findIndex(
			call => call.startsWith(`link:${lockFile}.`) && call.endsWith(`:${lockFile}`),
		);
		expect(pendingSync).toBeGreaterThanOrEqual(0);
		expect(publication).toBeGreaterThan(pendingSync);
		expect([...fs.files.keys()].some(file => file.endsWith(".pending"))).toBe(false);
		expect(fs.files.has(lockFile)).toBe(false);
	});
	test("keeps a failed published lock registered until cleanup cannot remove a successor", async () => {
		const closeEntered = Promise.withResolvers<void>();
		const releaseClose = Promise.withResolvers<void>();
		let paused = false;
		class PausingCloseFs extends MemoryConversationStoreFs {
			override async open(file: string, flags: string) {
				const handle = await super.open(file, flags);
				if (flags !== "wx" || !file.includes("conversations.json.lock.") || !file.endsWith(".pending"))
					return handle;
				return {
					...handle,
					close: async () => {
						if (!paused) {
							paused = true;
							closeEntered.resolve();
							await releaseClose.promise;
						}
						await handle.close();
					},
				};
			}
		}
		const fs = new PausingCloseFs();
		fs.failWrite = true;
		const first = new ConversationStore<TestConversation>({
			agentDir: "/agent",
			kind: "discord",
			fs,
			pid: process.pid,
		});
		const second = new ConversationStore<TestConversation>({
			agentDir: "/agent",
			kind: "discord",
			fs,
			pid: process.pid,
		});
		const failedWrite = first.write("one", undefined, record(1));
		await closeEntered.promise;
		let secondSettled = false;
		const secondWrite = second.write("two", undefined, record(1)).finally(() => {
			secondSettled = true;
		});
		await Bun.sleep(25);
		expect(secondSettled).toBe(false);
		releaseClose.resolve();
		await expect(failedWrite).rejects.toThrow("write failed");
		fs.failWrite = false;
		await expect(secondWrite).resolves.toBe(true);
		expect(await second.read("two")).toEqual(record(1));
	});

	test("recovers a lock whose recorded owner is dead", async () => {
		const fs = new MemoryConversationStoreFs();
		const store = new ConversationStore<TestConversation>({
			agentDir: "/agent",
			kind: "discord",
			fs,
			pid: 202,
			pidAlive: pid => pid === 202,
		});
		fs.files.set(`${store.filePath}.lock`, JSON.stringify({ pid: 101, incarnation: "old", timestamp: 1 }));
		expect(await store.write("mapping", undefined, record(1))).toBe(true);
	});
	test("times out when a stale lock cannot be unlinked", async () => {
		class UnlinkFailingFs extends MemoryConversationStoreFs {
			override async unlink(file: string) {
				if (file.endsWith("conversations.json.lock")) {
					throw Object.assign(new Error("stale lock unlink failed"), { code: "EPERM" });
				}
				await super.unlink(file);
			}
		}
		const fs = new UnlinkFailingFs();
		const store = new ConversationStore<TestConversation>({
			agentDir: "/agent",
			kind: "discord",
			fs,
			pid: 202,
			pidAlive: pid => pid === 202,
			lockTimeoutMs: 0,
		});
		fs.files.set(`${store.filePath}.lock`, JSON.stringify({ pid: 101, incarnation: "old", timestamp: 1 }));
		await expect(store.write("mapping", undefined, record(1))).rejects.toBeInstanceOf(ConversationLockTimeoutError);
	});
	test("recovers an abandoned reclaim lock owned by a reused PID", async () => {
		const fs = new MemoryConversationStoreFs();
		const store = new ConversationStore<TestConversation>({
			agentDir: "/agent",
			kind: "discord",
			fs,
			pid: 202,
			pidAlive: () => true,
			pidIncarnation: pid => (pid === 101 ? "current" : "writer"),
		});
		fs.files.set(`${store.filePath}.lock`, JSON.stringify({ pid: 101, incarnation: "old", timestamp: 1 }));
		fs.files.set(`${store.filePath}.lock.reclaim`, JSON.stringify({ pid: 101, incarnation: "old", timestamp: 1 }));
		await expect(store.write("mapping", undefined, record(1))).resolves.toBe(true);
		expect(fs.files.has(`${store.filePath}.lock.reclaim`)).toBe(false);
	});
	test("does not reclaim an expired unreadable legacy lock", async () => {
		class ExpiredLockFs extends MemoryConversationStoreFs {
			async stat(_file: string) {
				return { mtimeMs: 0 };
			}
		}
		const fs = new ExpiredLockFs();
		const store = new ConversationStore<TestConversation>({
			agentDir: "/agent",
			kind: "discord",
			fs,
			now: () => 30_000,
			pid: 202,
			pidAlive: pid => pid === 202,
			lockTimeoutMs: 0,
		});
		const lockFile = `${store.filePath}.lock`;
		fs.files.set(lockFile, "");
		await expect(store.write("mapping", undefined, record(1))).rejects.toBeInstanceOf(ConversationLockTimeoutError);
		expect(fs.files.get(lockFile)).toBe("");
		expect(fs.calls).not.toContain(`unlink:${lockFile}`);
		expect([...fs.files.keys()].some(file => file.endsWith(".reclaim"))).toBe(false);
	});

	test("does not steal a fresh live reclaim lock or bypass the lock timeout", async () => {
		const fs = new MemoryConversationStoreFs();
		const store = new ConversationStore<TestConversation>({
			agentDir: "/agent",
			kind: "discord",
			fs,
			pid: 202,
			pidAlive: pid => pid !== 101,
			pidIncarnation: pid => (pid === 303 ? "darwin:1700000000:123456" : "darwin:1700000000:654321"),
			lockTimeoutMs: 0,
		});
		fs.files.set(
			`${store.filePath}.lock`,
			JSON.stringify({ pid: 101, incarnation: "darwin:1700000000:999999", timestamp: 1 }),
		);
		fs.files.set(
			`${store.filePath}.lock.reclaim`,
			JSON.stringify({ pid: 303, incarnation: "darwin:1700000000:123456", timestamp: 1 }),
		);
		await expect(store.write("mapping", undefined, record(1))).rejects.toBeInstanceOf(ConversationLockTimeoutError);
		expect(fs.files.get(`${store.filePath}.lock.reclaim`)).toBe(
			JSON.stringify({ pid: 303, incarnation: "darwin:1700000000:123456", timestamp: 1 }),
		);
	});

	test("heals a leaked lock this process wrote instead of timing out", async () => {
		const fs = new MemoryConversationStoreFs();
		const store = new ConversationStore<TestConversation>({
			agentDir: "/agent",
			kind: "discord",
			fs,
			pid: process.pid,
			pidAlive: () => true,
		});
		// Simulate a release that failed between close() and unlink(): a
		// well-formed lock whose recorded pid is still this (live) process. The
		// recorded owner being alive makes it unstale, so only the evidence-based
		// same-process leak heal can recover it without raising the timeout.
		const leaked = await captureLockMetadata();
		fs.files.set(`${store.filePath}.lock`, leaked);
		const started = performance.now();
		await expect(store.write("mapping", undefined, record(1))).resolves.toBe(true);
		expect(performance.now() - started).toBeLessThan(900);
		expect(fs.files.has(`${store.filePath}.lock`)).toBe(false);
	});
	test("does not reclaim a matching-PID lock from a different worker isolate", async () => {
		const fs = new MemoryConversationStoreFs();
		const store = new ConversationStore<TestConversation>({
			agentDir: "/agent",
			kind: "discord",
			fs,
			pid: process.pid,
			pidAlive: () => true,
			lockTimeoutMs: 0,
		});
		const lockFile = `${store.filePath}.lock`;
		const foreign = JSON.stringify({
			pid: process.pid,
			incarnation: processIncarnation(process.pid),
			isolateId: "different-worker-isolate",
			timestamp: 1,
			nonce: "foreign-lock",
		});
		fs.files.set(lockFile, foreign);

		await expect(store.write("mapping", undefined, record(1))).rejects.toBeInstanceOf(ConversationLockTimeoutError);
		expect(fs.files.get(lockFile)).toBe(foreign);
		expect(fs.calls).not.toContain(`unlink:${lockFile}`);
	});

	test("does not reclaim a legacy same-PID lock without isolate identity", async () => {
		const fs = new MemoryConversationStoreFs();
		const store = new ConversationStore<TestConversation>({
			agentDir: "/agent",
			kind: "discord",
			fs,
			pid: process.pid,
			pidAlive: () => true,
			lockTimeoutMs: 0,
		});
		const lockFile = `${store.filePath}.lock`;
		const legacy = JSON.stringify({
			pid: process.pid,
			incarnation: processIncarnation(process.pid),
			timestamp: 1,
		});
		fs.files.set(lockFile, legacy);

		await expect(store.write("mapping", undefined, record(1))).rejects.toBeInstanceOf(ConversationLockTimeoutError);
		expect(fs.files.get(lockFile)).toBe(legacy);
		expect(fs.calls).not.toContain(`unlink:${lockFile}`);
	});
	test("removes its lock when closing the lock handle fails", async () => {
		class CloseFailingLockFs extends MemoryConversationStoreFs {
			override async open(file: string, flags: string) {
				const handle = await super.open(file, flags);
				if (flags !== "wx" || !file.includes("conversations.json.lock.") || !file.endsWith(".pending"))
					return handle;
				return {
					...handle,
					close: async () => {
						await handle.close();
						throw new Error("lock close failed");
					},
				};
			}
		}
		const fs = new CloseFailingLockFs();
		const store = new ConversationStore<TestConversation>({ agentDir: "/agent", kind: "discord", fs });
		await expect(store.write("mapping", undefined, record(1))).resolves.toBe(true);
		expect(fs.files.has(`${store.filePath}.lock`)).toBe(false);
		await expect(store.write("mapping", 1, record(2))).resolves.toBe(true);
	});
	test("times out instead of spinning when a leaked lock cannot be unlinked", async () => {
		class UnlinkFailingFs extends MemoryConversationStoreFs {
			primaryUnlinkAttempts = 0;

			override async unlink(file: string) {
				if (file.endsWith("conversations.json.lock")) {
					this.primaryUnlinkAttempts++;
					throw Object.assign(new Error("lock unlink failed"), { code: "EPERM" });
				}
				await super.unlink(file);
			}
		}
		const fs = new UnlinkFailingFs();
		const store = new ConversationStore<TestConversation>({
			agentDir: "/agent",
			kind: "discord",
			fs,
			pid: process.pid,
			pidAlive: () => true,
			lockTimeoutMs: 0,
		});
		fs.files.set(`${store.filePath}.lock`, await captureLockMetadata());
		await expect(store.write("mapping", undefined, record(1))).rejects.toBeInstanceOf(ConversationLockTimeoutError);
		expect(fs.primaryUnlinkAttempts).toBe(1);
		expect(fs.files.has(`${store.filePath}.lock`)).toBe(true);
	});

	test("serializes concurrent healing before either waiter can acquire a replacement lock", async () => {
		const enteredUnlink = Promise.withResolvers<void>();
		const releaseUnlink = Promise.withResolvers<void>();
		let paused = false;
		class HealingBarrierFs extends MemoryConversationStoreFs {
			override async unlink(file: string) {
				if (file.endsWith("conversations.json.lock") && !paused) {
					paused = true;
					enteredUnlink.resolve();
					await releaseUnlink.promise;
				}
				await super.unlink(file);
			}
		}
		const fs = new HealingBarrierFs();
		const first = new ConversationStore<TestConversation>({
			agentDir: "/agent",
			kind: "discord",
			fs,
			pid: process.pid,
			pidAlive: () => true,
		});
		const second = new ConversationStore<TestConversation>({
			agentDir: "/agent",
			kind: "discord",
			fs,
			pid: process.pid,
			pidAlive: () => true,
		});
		fs.files.set(`${first.filePath}.lock`, await captureLockMetadata());
		const firstWrite = first.write("one", undefined, record(1));
		await enteredUnlink.promise;
		const secondWrite = second.write("two", undefined, record(1));
		releaseUnlink.resolve();
		await expect(Promise.all([firstWrite, secondWrite])).resolves.toEqual([true, true]);
		expect((await first.load()).conversations).toEqual({ one: record(1), two: record(1) });
	});

	test("does not heal a lock a same-process instance currently holds", async () => {
		const entered = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		let paused = false;
		class PausingFs extends MemoryConversationStoreFs {
			override async rename(from: string, to: string) {
				if (!paused) {
					paused = true;
					entered.resolve();
					await release.promise;
				}
				await super.rename(from, to);
			}
		}
		const fs = new PausingFs();
		const first = new ConversationStore<TestConversation>({
			agentDir: "/agent",
			kind: "discord",
			fs,
			pid: process.pid,
			pidAlive: () => true,
		});
		const second = new ConversationStore<TestConversation>({
			agentDir: "/agent",
			kind: "discord",
			fs,
			pid: process.pid,
			pidAlive: () => true,
		});
		const firstWrite = first.write("one", undefined, record(1));
		await entered.promise;
		let secondSettled = false;
		const secondWrite = second.write("two", undefined, record(1)).finally(() => {
			secondSettled = true;
		});
		await Bun.sleep(25);
		// The live holder is registered, so the waiter must wait rather than heal.
		expect(secondSettled).toBe(false);
		release.resolve();
		await expect(Promise.all([firstWrite, secondWrite])).resolves.toEqual([true, true]);
		expect((await first.load()).conversations).toEqual({ one: record(1), two: record(1) });
	});

	test("does not heal a well-formed lock held by another live process", async () => {
		const fs = new MemoryConversationStoreFs();
		const store = new ConversationStore<TestConversation>({
			agentDir: "/agent",
			kind: "discord",
			fs,
			pid: 202,
			pidAlive: () => true,
			pidIncarnation: pid => (pid === 303 ? "linux:102" : "linux:101"),
			lockTimeoutMs: 0,
		});
		const foreign = JSON.stringify({
			pid: 303,
			incarnation: "linux:102",
			isolateId: "foreign-process-isolate",
			timestamp: 1,
			nonce: "foreign-lock",
		});
		fs.files.set(`${store.filePath}.lock`, foreign);
		await expect(store.write("mapping", undefined, record(1))).rejects.toBeInstanceOf(ConversationLockTimeoutError);
		expect(fs.files.get(`${store.filePath}.lock`)).toBe(foreign);
	});

	test("default-path lock uses canonical processIncarnation format", async () => {
		let capturedLock: string | undefined;
		class CapturingFs extends MemoryConversationStoreFs {
			override async open(file: string, flags: string) {
				const handle = await super.open(file, flags);
				if (flags === "wx" && file.endsWith(".pending")) {
					return {
						...handle,
						writeFile: async (data: string, encoding: "utf8") => {
							capturedLock = data.trim();
							await handle.writeFile(data, encoding);
						},
					};
				}
				return handle;
			}
		}
		const capturingFs = new CapturingFs();
		const store = new ConversationStore<TestConversation>({
			agentDir: "/agent",
			kind: "discord",
			fs: capturingFs,
			pid: process.pid,
			pidAlive: () => true,
		});
		await store.write("mapping", undefined, record(1));
		expect(capturedLock).toBeDefined();
		const lock = JSON.parse(capturedLock!);
		expect(lock.pid).toBe(process.pid);
		expect(lock.isolateId).toEqual(expect.any(String));
		// The incarnation must be canonical (not a locale-dependent lstart string).
		expect(isProcessIncarnation(lock.incarnation)).toBe(true);
		expect(lock.incarnation).toBe(processIncarnation(process.pid));
	});

	test("reclaims a non-canonical locale-dependent Darwin lock as not-owned", async () => {
		const fs = new MemoryConversationStoreFs();
		const store = new ConversationStore<TestConversation>({
			agentDir: "/agent",
			kind: "discord",
			fs,
			pid: 202,
			pidAlive: () => true,
			pidIncarnation: () => "darwin:1700000000:123456",
		});
		// Simulate a stale lock written by the old locale-dependent defaultPidIncarnation.
		fs.files.set(
			`${store.filePath}.lock`,
			JSON.stringify({ pid: 101, incarnation: "darwin:Thu Jul 17 10:00:00 2025", timestamp: 1 }),
		);
		expect(await store.write("mapping", undefined, record(1))).toBe(true);
	});

	test("serializes separate store instances so independent mapping updates do not overwrite one another", async () => {
		const fs = new MemoryConversationStoreFs();
		const first = new ConversationStore<TestConversation>({ agentDir: "/agent", kind: "slack", fs, now: () => 2 });
		const second = new ConversationStore<TestConversation>({ agentDir: "/agent", kind: "slack", fs, now: () => 2 });
		await Promise.all([first.write("one", undefined, record(1)), second.write("two", undefined, record(1))]);
		expect((await first.load()).conversations).toEqual({ one: record(1), two: record(1) });
	});

	test("rejects a stale generation and restores persisted mappings after restart", async () => {
		const fs = new MemoryConversationStoreFs();
		const initial = new ConversationStore<TestConversation>({ agentDir: "/agent", kind: "slack", fs, now: () => 2 });
		expect(await initial.write("mapping", undefined, record(1))).toBe(true);
		expect(await initial.write("mapping", 1, record(2, "active"))).toBe(true);
		expect(await initial.write("mapping", 1, record(2, "active"))).toBe(false);
		const restarted = new ConversationStore<TestConversation>({
			agentDir: "/agent",
			kind: "slack",
			fs,
			now: () => 3,
		});
		expect(await restarted.read("mapping")).toEqual(record(2, "active"));
	});

	test("bounds durable dedupe identifiers without retaining duplicate values", () => {
		const ids = Array.from({ length: MAX_DEDUPE_IDS + 2 }, (_, index) => `event-${index}`);
		const bounded = boundedDedupe(["event-0", ...ids, "event-1"]);
		expect(bounded).toHaveLength(MAX_DEDUPE_IDS);
		expect(bounded[0]).toBe("event-2");
		expect(bounded.at(-1)).toBe(`event-${MAX_DEDUPE_IDS + 1}`);
	});

	test("opens staged documents writable before fsync for Windows compatibility", async () => {
		class WindowsFsyncFs extends MemoryConversationStoreFs {
			temporaryOpenFlags: string | undefined;

			override async open(file: string, flags: string) {
				const handle = await super.open(file, flags);
				if (!file.endsWith(".tmp")) return handle;
				this.temporaryOpenFlags = flags;
				return {
					...handle,
					sync: async () => {
						if (!flags.includes("+")) {
							throw Object.assign(new Error("EPERM: operation not permitted, fsync"), { code: "EPERM" });
						}
						await handle.sync();
					},
				};
			}
		}

		const fs = new WindowsFsyncFs();
		const store = new ConversationStore<TestConversation>({ agentDir: "/agent", kind: "discord", fs, now: () => 4 });
		await expect(store.write("mapping", undefined, record(1))).resolves.toBe(true);
		expect(fs.temporaryOpenFlags).toBe("r+");
	});
	test("keeps the prior document intact when staged document fsync or rename fails", async () => {
		const fs = new MemoryConversationStoreFs();
		const store = new ConversationStore<TestConversation>({ agentDir: "/agent", kind: "discord", fs, now: () => 4 });
		await store.write("mapping", undefined, record(1));
		const callsBeforeSecondWrite = fs.calls.length;
		fs.failDocumentSync = true;
		await expect(store.write("mapping", 1, record(2))).rejects.toThrow("sync failed");
		const failedWriteCalls = fs.calls.slice(callsBeforeSecondWrite);
		const lockSync = failedWriteCalls.findIndex(call => call.startsWith("sync:") && call.endsWith(".pending"));
		const documentSync = failedWriteCalls.findIndex(
			call => call.startsWith(`sync:${store.filePath}.`) && call.endsWith(".tmp"),
		);
		expect(lockSync).toBeGreaterThanOrEqual(0);
		expect(documentSync).toBeGreaterThan(lockSync);
		fs.failDocumentSync = false;
		fs.failRename = true;
		await expect(store.write("mapping", 1, record(2))).rejects.toThrow("rename failed");
		expect(await store.read("mapping")).toEqual(record(1));
	});
	class DirectoryBarrierFs extends MemoryConversationStoreFs {
		directoryOpenError?: Error;
		directorySyncError?: Error;
		directoryCloseError?: Error;

		override async open(file: string, flags: string) {
			if (file === "/agent/sdk/daemons/discord" && this.directoryOpenError) throw this.directoryOpenError;
			const handle = await super.open(file, flags);
			if (file !== "/agent/sdk/daemons/discord") return handle;
			return {
				...handle,
				sync: async () => {
					await handle.sync();
					if (this.directorySyncError) throw this.directorySyncError;
				},
				close: async () => {
					await handle.close();
					if (this.directoryCloseError) throw this.directoryCloseError;
				},
			};
		}
	}

	function barrierError(message: string, code?: string): Error {
		return code === undefined ? new Error(message) : Object.assign(new Error(message), { code });
	}

	test("tolerates unsupported Windows parent open and sync errors after durable temp sync and rename", async () => {
		for (const code of ["EINVAL", "ENOTSUP", "EOPNOTSUPP", "EPERM"]) {
			for (const phase of ["open", "sync"] as const) {
				const fs = new DirectoryBarrierFs();
				const error = barrierError(`${phase} ${code}`, code);
				fs[phase === "open" ? "directoryOpenError" : "directorySyncError"] = error;
				const store = new ConversationStore<TestConversation>({
					agentDir: "/agent",
					kind: "discord",
					fs,
					now: () => 5,
					platform: "win32",
				});
				await expect(store.write("mapping", undefined, record(1))).resolves.toBe(true);
				const tempSync = fs.calls.findIndex(call =>
					call.startsWith("sync:/agent/sdk/daemons/discord/conversations.json."),
				);
				const rename = fs.calls.findIndex(call => call.startsWith("rename:"));
				expect(tempSync).toBeGreaterThanOrEqual(0);
				expect(rename).toBeGreaterThan(tempSync);
				if (phase === "sync") {
					const parentSync = fs.calls.indexOf("sync:/agent/sdk/daemons/discord");
					const parentClose = fs.calls.indexOf("close:/agent/sdk/daemons/discord");
					expect(parentSync).toBeGreaterThan(rename);
					expect(parentClose).toBeGreaterThan(parentSync);
				}
			}
		}
	});

	test("rejects parent open and sync errors without supported Windows codes", async () => {
		for (const phase of ["open", "sync"] as const) {
			const fs = new DirectoryBarrierFs();
			const error = barrierError(`no code ${phase}`);
			fs[phase === "open" ? "directoryOpenError" : "directorySyncError"] = error;
			const store = new ConversationStore<TestConversation>({
				agentDir: "/agent",
				kind: "discord",
				fs,
				platform: "win32",
			});
			await expect(store.write("mapping", undefined, record(1))).rejects.toBe(error);
			const tempSync = fs.calls.findIndex(call =>
				call.startsWith("sync:/agent/sdk/daemons/discord/conversations.json."),
			);
			const rename = fs.calls.findIndex(call => call.startsWith("rename:"));
			expect(rename).toBeGreaterThan(tempSync);
			if (phase === "sync") expect(fs.calls).toContain("close:/agent/sdk/daemons/discord");
		}
	});

	test("rejects EACCES parent open and sync errors on Windows", async () => {
		for (const phase of ["open", "sync"] as const) {
			const fs = new DirectoryBarrierFs();
			const error = barrierError(`access ${phase}`, "EACCES");
			fs[phase === "open" ? "directoryOpenError" : "directorySyncError"] = error;
			const store = new ConversationStore<TestConversation>({
				agentDir: "/agent",
				kind: "discord",
				fs,
				platform: "win32",
			});
			await expect(store.write("mapping", undefined, record(1))).rejects.toBe(error);
			const tempSync = fs.calls.findIndex(call =>
				call.startsWith("sync:/agent/sdk/daemons/discord/conversations.json."),
			);
			expect(fs.calls.findIndex(call => call.startsWith("rename:"))).toBeGreaterThan(tempSync);
			if (phase === "sync") expect(fs.calls).toContain("close:/agent/sdk/daemons/discord");
		}
	});

	test("rejects unsupported Linux parent open and sync errors", async () => {
		for (const code of ["EINVAL", "ENOTSUP", "EOPNOTSUPP", "EPERM"]) {
			for (const phase of ["open", "sync"] as const) {
				const fs = new DirectoryBarrierFs();
				const error = barrierError(`linux ${phase} ${code}`, code);
				fs[phase === "open" ? "directoryOpenError" : "directorySyncError"] = error;
				const store = new ConversationStore<TestConversation>({
					agentDir: "/agent",
					kind: "discord",
					fs,
					platform: "linux",
				});
				await expect(store.write("mapping", undefined, record(1))).rejects.toBe(error);
				const tempSync = fs.calls.findIndex(call =>
					call.startsWith("sync:/agent/sdk/daemons/discord/conversations.json."),
				);
				const rename = fs.calls.findIndex(call => call.startsWith("rename:"));
				expect(tempSync).toBeGreaterThanOrEqual(0);
				expect(rename).toBeGreaterThan(tempSync);
				if (phase === "sync") {
					const parentSync = fs.calls.indexOf("sync:/agent/sdk/daemons/discord");
					const parentClose = fs.calls.indexOf("close:/agent/sdk/daemons/discord");
					expect(parentSync).toBeGreaterThan(rename);
					expect(parentClose).toBeGreaterThan(parentSync);
				}
			}
		}
	});

	test("rejects parent close errors", async () => {
		const fs = new DirectoryBarrierFs();
		const error = barrierError("close failed", "EIO");
		fs.directoryCloseError = error;
		const store = new ConversationStore<TestConversation>({
			agentDir: "/agent",
			kind: "discord",
			fs,
			platform: "win32",
		});
		await expect(store.write("mapping", undefined, record(1))).rejects.toBe(error);
	});

	test("rejects parent close errors after tolerating supported Windows parent sync errors", async () => {
		const fs = new DirectoryBarrierFs();
		const syncError = barrierError("sync unsupported", "EPERM");
		const closeError = barrierError("close failed", "EIO");
		fs.directorySyncError = syncError;
		fs.directoryCloseError = closeError;
		const store = new ConversationStore<TestConversation>({
			agentDir: "/agent",
			kind: "discord",
			fs,
			platform: "win32",
		});
		await expect(store.write("mapping", undefined, record(1))).rejects.toBe(closeError);
		expect(fs.calls).toContain("close:/agent/sdk/daemons/discord");
	});
	test("aggregates unexpected parent sync and close errors", async () => {
		const fs = new DirectoryBarrierFs();
		const syncError = barrierError("sync failed", "EIO");
		const closeError = barrierError("close failed", "EIO");
		fs.directorySyncError = syncError;
		fs.directoryCloseError = closeError;
		const store = new ConversationStore<TestConversation>({
			agentDir: "/agent",
			kind: "discord",
			fs,
			platform: "win32",
		});
		await expect(store.write("mapping", undefined, record(1))).rejects.toMatchObject({
			errors: [syncError, closeError],
		});
		const rename = fs.calls.findIndex(call => call.startsWith("rename:"));
		const parentSync = fs.calls.indexOf("sync:/agent/sdk/daemons/discord");
		const parentClose = fs.calls.indexOf("close:/agent/sdk/daemons/discord");
		expect(parentSync).toBeGreaterThan(rename);
		expect(parentClose).toBeGreaterThan(parentSync);
	});
});
describe("ChatEffectJournal", () => {
	test("keeps provider payloads out of mappings while replaying the protected journal after restart", async () => {
		const fs = new MemoryConversationStoreFs();
		const mappings = new ConversationStore<SlackConversation>({ agentDir: "/agent", kind: "slack", fs });
		const journal = new ChatEffectJournal({ agentDir: "/agent", transport: "slack", fs, now: () => 1 });
		await journal.enqueue({
			id: "inbound:evt-1",
			kind: "command",
			transport: "slack",
			sessionId: "session",
			endpointGeneration: 4,
			payload: { content: "/sdk secret-command", token: "super-secret" },
		});
		await mappings.write("team:channel:root", undefined, {
			generation: 1,
			state: "active",
			teamId: "team",
			channelId: "channel",
			rootTs: "root",
			sessionId: "session",
			endpointGeneration: 4,
			updatedAt: 1,
			seenEventIds: [],
			seenContextIds: [],
			seenRetryKeys: [],
			seenInteractionIds: [],
			inboundDispatches: [
				{
					key: "evt-1",
					eventId: "evt-1",
					interactionId: "interaction",
					retryKey: "retry",
					kind: "command",
					endpointGeneration: 4,
					effectId: "inbound:evt-1",
					idempotencyKey: "inbound:evt-1",
				},
			],
		});
		const mappingBody = fs.files.get(mappings.filePath) ?? "";
		expect(mappingBody).not.toContain("secret-command");
		expect(mappingBody).not.toContain("super-secret");
		expect(fs.modes.get(journal.filePath)).toBe(0o600);
		const restarted = new ChatEffectJournal({ agentDir: "/agent", transport: "slack", fs, now: () => 2 });
		expect(await restarted.replayable("slack", 4)).toEqual([
			expect.objectContaining({
				id: "inbound:evt-1",
				payload: { content: "/sdk secret-command", token: "super-secret" },
			}),
		]);
	});

	test("takes over expired leases and fences stale owners from terminal commits", async () => {
		const fs = new MemoryConversationStoreFs();
		const first = new ChatEffectJournal({ agentDir: "/agent", transport: "discord", fs, now: () => 1 });
		await first.enqueue({
			id: "effect",
			kind: "reply",
			transport: "discord",
			endpointGeneration: 2,
			payload: { answer: "body" },
		});
		const oldLease = await first.claim("effect", "old", 5);
		expect(oldLease).toMatchObject({ state: "leased", epoch: 1 });
		const second = new ChatEffectJournal({ agentDir: "/agent", transport: "discord", fs, now: () => 7 });
		const newLease = await second.claim("effect", "new", 5);
		expect(newLease).toMatchObject({ state: "leased", owner: "new", epoch: 2 });
		expect(await first.record("effect", { owner: "old", epoch: oldLease!.epoch }, "terminal")).toBeUndefined();
		expect(
			await second.record("effect", { owner: "new", epoch: newLease!.epoch }, "terminal", { messageId: "remote" }),
		).toMatchObject({ state: "terminal", receipt: { messageId: "remote" } });
	});

	test("retains more than 128 nonterminal effects while bounding terminal history", async () => {
		const fs = new MemoryConversationStoreFs();
		const journal = new ChatEffectJournal({ agentDir: "/agent", transport: "discord", fs, now: () => 1 });
		for (let index = 0; index < 130; index++)
			await journal.enqueue({
				id: `pending-${index}`,
				kind: "reply",
				transport: "discord",
				endpointGeneration: 1,
				payload: { index },
			});
		for (let index = 0; index < 130; index++) {
			await journal.enqueue({
				id: `terminal-${index}`,
				kind: "reply",
				transport: "discord",
				endpointGeneration: 1,
				payload: { index },
			});
			const lease = await journal.claim(`terminal-${index}`, "owner", 10);
			await journal.record(`terminal-${index}`, { owner: "owner", epoch: lease!.epoch }, "terminal");
		}
		const effects = await journal.list();
		expect(effects.filter(effect => effect.state !== "terminal")).toHaveLength(130);
		expect(effects.filter(effect => effect.state === "terminal")).toHaveLength(MAX_TERMINAL_CHAT_EFFECTS);
	});
});
