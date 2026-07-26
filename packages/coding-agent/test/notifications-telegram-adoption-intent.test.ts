import { describe, expect, test } from "bun:test";
import * as fsSync from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { daemonPaths } from "../src/sdk/bus/daemon-paths";
import {
	ADOPTION_INTENT_FILENAME_SUFFIX,
	type AdoptionIntentFileHandle,
	type AdoptionIntentFs,
	adoptionIntentFilePath,
	buildAdoptionIntent,
	DEFAULT_ADOPTION_INTENT_TTL_MS,
	pendingTopicFilePath,
	type TelegramAdoptionIntent,
	TelegramAdoptionIntentStore,
	type TelegramAdoptionTarget,
	type TelegramPendingTopic,
} from "../src/sdk/bus/telegram-adoption-intent";

function tempAgentDir(): string {
	return fsSync.mkdtempSync(path.join(os.tmpdir(), "gjc-adoption-intent-test-"));
}

const TARGET_EXISTING: TelegramAdoptionTarget = { kind: "existing_path", path: "/home/me/work" };

function intent(overrides: Partial<TelegramAdoptionIntent> & { intendedSessionId: string }): TelegramAdoptionIntent {
	const createdAt = overrides.createdAt ?? 1_000_000;
	return {
		intendedSessionId: overrides.intendedSessionId,
		topicId: overrides.topicId ?? 42,
		chatId: overrides.chatId ?? "chat-7",
		target: overrides.target ?? TARGET_EXISTING,
		createdAt,
		expiresAt: overrides.expiresAt ?? createdAt + DEFAULT_ADOPTION_INTENT_TTL_MS,
	};
}

/**
 * In-memory filesystem modeling the store's atomic tmp-write + fsync + chmod +
 * rename + parent-sync, with toggles to fail writes/renames on demand. Tracks
 * modes so permission tests can assert 0600/0700 without real-disk permissions.
 */
class FakeFs implements AdoptionIntentFs {
	readonly files = new Map<string, string>();
	readonly modes = new Map<string, number>();
	readonly dirs = new Set<string>();
	readonly syncedFiles = new Set<string>();
	readonly syncedDirs = new Set<string>();
	failWrites = false;
	failRename = false;
	failChmod = false;
	failReads = false;
	failReaddir = false;
	failUnlink = false;
	unlinked = [] as string[];

	async mkdir(directory: string, options: { recursive: true; mode: number }): Promise<unknown> {
		this.dirs.add(directory);
		this.modes.set(directory, options.mode);
		return undefined;
	}
	async chmod(target: string, mode: number): Promise<void> {
		if (this.failChmod) throw new Error("simulated chmod failure");
		this.modes.set(target, mode);
	}
	async readFile(file: string): Promise<string> {
		if (this.failReads) throw new Error("simulated read failure");
		const value = this.files.get(file);
		if (value === undefined) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
		return value;
	}
	async writeFile(file: string, data: string, options: { mode: number }): Promise<void> {
		if (this.failWrites) throw new Error("simulated disk failure");
		this.files.set(file, data);
		this.modes.set(file, options.mode);
	}
	async rename(from: string, to: string): Promise<void> {
		if (this.failRename) throw new Error("simulated rename failure");
		const value = this.files.get(from);
		if (value === undefined) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
		this.files.delete(from);
		this.modes.delete(from);
		this.files.set(to, value);
	}
	async unlink(file: string): Promise<unknown> {
		if (this.failUnlink) throw new Error("simulated unlink failure");
		if (!this.files.has(file)) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
		this.files.delete(file);
		this.modes.delete(file);
		this.unlinked.push(file);
		return undefined;
	}
	async readdir(directory: string): Promise<readonly string[]> {
		if (this.failReaddir) throw new Error("simulated readdir failure");
		if (!this.dirs.has(directory)) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
		const prefix = directory + path.sep;
		const names = new Set<string>();
		for (const f of this.files.keys()) {
			if (!f.startsWith(prefix)) continue;
			const rest = f.slice(prefix.length);
			if (rest.includes(path.sep)) continue;
			names.add(rest);
		}
		return [...names];
	}
	async open(file: string): Promise<AdoptionIntentFileHandle> {
		if (!this.files.has(file) && !this.dirs.has(file)) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
		const target = file;
		return {
			sync: async () => {
				if (this.dirs.has(target)) this.syncedDirs.add(target);
				else this.syncedFiles.add(target);
			},
			close: async () => {},
		};
	}
}

const AGENT = "/virtual/agent";
const sidecarPath = (agentDir: string, id: string): string => adoptionIntentFilePath(agentDir, id);

describe("TelegramAdoptionIntentStore", () => {
	describe("put / bySession round-trip and rehydrate", () => {
		test("put then bySession returns the stored intent", async () => {
			const store = new TelegramAdoptionIntentStore({ agentDir: AGENT, fs: new FakeFs(), now: () => 100 });
			await store.put(intent({ intendedSessionId: "sAAA", topicId: 91 }));
			const got = store.bySession("sAAA");
			expect(got).toBeDefined();
			expect(got!.intendedSessionId).toBe("sAAA");
			expect(got!.topicId).toBe(91);
			expect(got!.chatId).toBe("chat-7");
			expect(got!.target).toEqual(TARGET_EXISTING);
		});

		test("bySession misses for an absent intendedSessionId", () => {
			const store = new TelegramAdoptionIntentStore({ agentDir: AGENT, fs: new FakeFs(), now: () => 100 });
			expect(store.bySession("missing")).toBeUndefined();
		});

		test("bySession returns undefined once the intent expires", async () => {
			const clock = { t: 1_000_000 };
			const store = new TelegramAdoptionIntentStore({
				agentDir: AGENT,
				fs: new FakeFs(),
				now: () => clock.t,
			});
			await store.put(intent({ intendedSessionId: "sEXP", expiresAt: 1_000_000 + 5_000 }));
			expect(store.bySession("sEXP")).toBeDefined();
			clock.t = 1_000_000 + 5_001;
			expect(store.bySession("sEXP")).toBeUndefined();
		});

		test("byTopic returns the single non-expired intent for a topic", async () => {
			const store = new TelegramAdoptionIntentStore({ agentDir: AGENT, fs: new FakeFs(), now: () => 100 });
			await store.put(intent({ intendedSessionId: "sT1", topicId: 555 }));
			expect(store.byTopic(555)?.intendedSessionId).toBe("sT1");
			expect(store.hasNonExpiredTopic(555)).toBe(true);
			expect(store.byTopic(999)).toBeUndefined();
			expect(store.hasNonExpiredTopic(999)).toBe(false);
		});

		test("a fresh store rehydrates non-expired intents from disk only", async () => {
			const clock = { t: 5_000_000 };
			const fake = new FakeFs();
			const writer = new TelegramAdoptionIntentStore({ agentDir: AGENT, fs: fake, now: () => clock.t });
			await writer.put(
				intent({ intendedSessionId: "sLIVE", topicId: 12, createdAt: 5_000_000, expiresAt: 5_000_000 + 60_000 }),
			);
			await writer.put(
				intent({ intendedSessionId: "sDEAD", topicId: 13, createdAt: 5_000_000, expiresAt: 5_000_000 + 1_000 }),
			);

			// Simulate a restart: new store instance, same fake fs, clock advanced.
			clock.t = 5_000_000 + 2_000;
			const reader = new TelegramAdoptionIntentStore({ agentDir: AGENT, fs: fake, now: () => clock.t });
			expect(reader.bySession("sLIVE")).toBeUndefined(); // not loaded yet
			const loaded = await reader.rehydrate();
			expect(loaded).toBe(1);
			expect(reader.bySession("sLIVE")?.topicId).toBe(12);
			expect(reader.bySession("sDEAD")).toBeUndefined(); // expired sidecar skipped
		});

		test("rehydrate skips corrupt and foreign files", async () => {
			const fake = new FakeFs();
			fake.files.set(sidecarPath(AGENT, "sCORRUPT"), "{ not json");
			fake.files.set(
				sidecarPath(AGENT, "sBADSHAPE"),
				JSON.stringify({ version: 1, intent: { intendedSessionId: "x" } }),
			);
			fake.files.set(path.join(daemonPaths(AGENT).dir, "unrelated.json"), "{}");
			// A valid one still lands.
			const writer = new TelegramAdoptionIntentStore({ agentDir: AGENT, fs: fake, now: () => 100 });
			await writer.put(intent({ intendedSessionId: "sOK", topicId: 1 }));
			const reader = new TelegramAdoptionIntentStore({ agentDir: AGENT, fs: fake, now: () => 100 });
			const loaded = await reader.rehydrate();
			expect(loaded).toBe(1);
			expect(reader.bySession("sOK")).toBeDefined();
			expect(reader.bySession("sCORRUPT")).toBeUndefined();
			expect(reader.bySession("sBADSHAPE")).toBeUndefined();
		});

		test("rehydrate rejects filename/payload session mismatches and unsafe topic ids", async () => {
			const fake = new FakeFs();
			fake.dirs.add(daemonPaths(AGENT).dir);
			fake.files.set(
				sidecarPath(AGENT, "sFILE"),
				JSON.stringify({
					version: 1,
					intent: intent({ intendedSessionId: "sPAYLOAD", topicId: 7 }),
				}),
			);
			fake.files.set(
				sidecarPath(AGENT, "sUNSAFE"),
				JSON.stringify({
					version: 1,
					intent: intent({ intendedSessionId: "sUNSAFE", topicId: Number.MAX_SAFE_INTEGER + 1 }),
				}),
			);
			const reader = new TelegramAdoptionIntentStore({ agentDir: AGENT, fs: fake, now: () => 100 });
			expect(await reader.rehydrate()).toBe(0);
			expect(reader.bySession("sFILE")).toBeUndefined();
			expect(reader.bySession("sPAYLOAD")).toBeUndefined();
			expect(reader.bySession("sUNSAFE")).toBeUndefined();
		});

		test("pending-topic authorization persists, rehydrates, and expires", async () => {
			const clock = { t: 1_000 };
			const fake = new FakeFs();
			const writer = new TelegramAdoptionIntentStore({ agentDir: AGENT, fs: fake, now: () => clock.t });
			const pending: TelegramPendingTopic = {
				topicId: 77,
				chatId: "chat-7",
				createdAt: 1_000,
				expiresAt: 2_000,
			};
			await writer.putPendingTopic(pending);
			expect(writer.hasPendingTopic(77, "chat-7")).toBe(true);
			expect(fake.files.has(pendingTopicFilePath(AGENT, 77))).toBe(true);

			const reader = new TelegramAdoptionIntentStore({ agentDir: AGENT, fs: fake, now: () => clock.t });
			expect(await reader.rehydrate()).toBe(1);
			expect(reader.pendingTopic(77)).toEqual(pending);
			clock.t = 2_001;
			expect(await reader.sweepExpired()).toBe(1);
			expect(reader.pendingTopic(77)).toBeUndefined();
			expect(fake.files.has(pendingTopicFilePath(AGENT, 77))).toBe(false);
		});

		test("rehydrate on a missing dir is a harmless zero", async () => {
			const fake = new FakeFs(); // no mkdir called yet
			const store = new TelegramAdoptionIntentStore({ agentDir: AGENT, fs: fake, now: () => 100 });
			expect(await store.rehydrate()).toBe(0);
		});

		test("sidecar path uses the per-intent filename suffix under daemonPaths dir", () => {
			const store = new TelegramAdoptionIntentStore({ agentDir: AGENT, fs: new FakeFs(), now: () => 100 });
			expect(store.directory).toBe(daemonPaths(AGENT).dir);
			expect(sidecarPath(AGENT, "sX")).toBe(
				path.join(daemonPaths(AGENT).dir, `sX${ADOPTION_INTENT_FILENAME_SUFFIX}`),
			);
		});
		test("rehydrate and readIntent propagate non-missing filesystem failures", async () => {
			const fake = new FakeFs();
			const store = new TelegramAdoptionIntentStore({ agentDir: AGENT, fs: fake, now: () => 100 });
			fake.dirs.add(daemonPaths(AGENT).dir);
			fake.failReaddir = true;
			await expect(store.rehydrate()).rejects.toThrow("simulated readdir failure");
			fake.failReaddir = false;
			fake.files.set(sidecarPath(AGENT, "sIO"), "{}");
			fake.failReads = true;
			await expect(store.readIntent("sIO")).rejects.toThrow("simulated read failure");
		});
	});

	describe("buildAdoptionIntent helper", () => {
		test("derives createdAt/expiresAt from now and ttl", () => {
			const a = buildAdoptionIntent({
				intendedSessionId: "s1",
				topicId: 7,
				chatId: "c",
				target: TARGET_EXISTING,
				now: 1000,
				ttlMs: 60_000,
			});
			expect(a.createdAt).toBe(1000);
			expect(a.expiresAt).toBe(61_000);
			expect(a.target).toEqual(TARGET_EXISTING);
		});

		test("defaults to Date.now and the 10-minute TTL", () => {
			const before = Date.now();
			const a = buildAdoptionIntent({
				intendedSessionId: "s2",
				topicId: 8,
				chatId: "c",
				target: TARGET_EXISTING,
			});
			const after = Date.now();
			expect(a.createdAt).toBeGreaterThanOrEqual(before);
			expect(a.createdAt).toBeLessThanOrEqual(after);
			expect(a.expiresAt - a.createdAt).toBe(DEFAULT_ADOPTION_INTENT_TTL_MS);
		});
	});

	describe("expiry and sweep", () => {
		test("sweepExpired removes only expired sidecars and returns the count", async () => {
			const clock = { t: 1_000_000 };
			const fake = new FakeFs();
			const store = new TelegramAdoptionIntentStore({ agentDir: AGENT, fs: fake, now: () => clock.t });
			await store.put(intent({ intendedSessionId: "sKEEP", topicId: 1, expiresAt: 1_000_000 + 60_000 }));
			await store.put(intent({ intendedSessionId: "sGONE", topicId: 2, expiresAt: 1_000_000 + 1_000 }));

			clock.t = 1_000_000 + 2_000;
			const removed = await store.sweepExpired();
			expect(removed).toBe(1);
			expect(fake.files.has(sidecarPath(AGENT, "sKEEP"))).toBe(true);
			expect(fake.files.has(sidecarPath(AGENT, "sGONE"))).toBe(false);
			expect(store.bySession("sKEEP")).toBeDefined();
			expect(store.bySession("sGONE")).toBeUndefined();
		});

		test("sweepExpired drops the in-memory entry and claim of an expired intent", async () => {
			const clock = { t: 1_000_000 };
			const fake = new FakeFs();
			const store = new TelegramAdoptionIntentStore({ agentDir: AGENT, fs: fake, now: () => clock.t });
			await store.put(intent({ intendedSessionId: "sC", topicId: 77, expiresAt: 1_000_000 + 1_000 }));
			expect(store.tryClaim(77, "sC")).toBe(true);

			clock.t = 1_000_000 + 2_000;
			await store.sweepExpired();
			// Claim released as part of expiry cleanup.
			expect(store.tryClaim(77, "sOTHER")).toBe(true);
		});

		test("sweepExpired never calls the Telegram API (files only)", async () => {
			const fake = new FakeFs();
			const store = new TelegramAdoptionIntentStore({ agentDir: AGENT, fs: fake, now: () => 999 });
			// Drop an expired sidecar directly on the fake fs.
			const expired = buildAdoptionIntent({
				intendedSessionId: "sRAW",
				topicId: 5,
				chatId: "c",
				target: TARGET_EXISTING,
				now: 0,
				ttlMs: 1,
			});
			const payload = JSON.stringify({ version: 1, intent: expired });
			fake.dirs.add(daemonPaths(AGENT).dir);
			fake.files.set(sidecarPath(AGENT, "sRAW"), payload);
			const removed = await store.sweepExpired();
			expect(removed).toBe(1);
			expect(fake.unlinked).toEqual([sidecarPath(AGENT, "sRAW")]);
		});

		test("sweepExpired on a missing dir returns 0", async () => {
			const fake = new FakeFs();
			const store = new TelegramAdoptionIntentStore({ agentDir: AGENT, fs: fake, now: () => 100 });
			expect(await store.sweepExpired()).toBe(0);
		});

		test("sweepExpired removes a corrupt sidecar (treats it as not-live)", async () => {
			const fake = new FakeFs();
			fake.dirs.add(daemonPaths(AGENT).dir);
			fake.files.set(sidecarPath(AGENT, "sCORRUPT2"), "garbage");
			const store = new TelegramAdoptionIntentStore({ agentDir: AGENT, fs: fake, now: () => 100 });
			const removed = await store.sweepExpired();
			expect(removed).toBe(1);
			expect(fake.files.has(sidecarPath(AGENT, "sCORRUPT2"))).toBe(false);
		});
	});

	describe("permissions and atomicity", () => {
		test("put writes the sidecar with 0600 and the dir with 0700", async () => {
			const fake = new FakeFs();
			const store = new TelegramAdoptionIntentStore({ agentDir: AGENT, fs: fake, now: () => 100 });
			await store.put(intent({ intendedSessionId: "sPERM" }));
			expect(fake.modes.get(daemonPaths(AGENT).dir)).toBe(0o700);
			expect(fake.modes.get(sidecarPath(AGENT, "sPERM"))).toBe(0o600);
		});

		test("put fsyncs the temp file and the parent dir before returning", async () => {
			const fake = new FakeFs();
			const store = new TelegramAdoptionIntentStore({ agentDir: AGENT, fs: fake, now: () => 100 });
			await store.put(intent({ intendedSessionId: "sSYNC" }));
			// At least one file sync (temp) and the parent dir sync happened.
			expect(fake.syncedFiles.size).toBeGreaterThanOrEqual(1);
			expect(fake.syncedDirs.has(daemonPaths(AGENT).dir)).toBe(true);
		});

		test("put fails closed when the filesystem cannot fsync", async () => {
			const fake = new FakeFs();
			const open = fake.open.bind(fake);
			fake.open = async file => {
				const handle = await open(file);
				return { close: handle.close } as AdoptionIntentFileHandle;
			};
			const store = new TelegramAdoptionIntentStore({ agentDir: AGENT, fs: fake, now: () => 100 });
			await expect(store.put(intent({ intendedSessionId: "sNOSYNC" }))).rejects.toThrow(
				"durability requires filesystem sync support",
			);
			expect(store.bySession("sNOSYNC")).toBeUndefined();
			expect(fake.files.has(sidecarPath(AGENT, "sNOSYNC"))).toBe(false);
		});

		test("a write failure leaves no sidecar and does not mutate memory", async () => {
			const fake = new FakeFs();
			const store = new TelegramAdoptionIntentStore({ agentDir: AGENT, fs: fake, now: () => 100 });
			await store.put(intent({ intendedSessionId: "sOK" }));
			fake.failWrites = true;
			await expect(store.put(intent({ intendedSessionId: "sFAIL" }))).rejects.toThrow("simulated disk failure");
			expect(store.bySession("sFAIL")).toBeUndefined();
			expect(store.bySession("sOK")).toBeDefined();
			// No stray temp files left behind under the dir.
			const leftover = [...fake.files.keys()].filter(f => f.endsWith(".tmp"));
			expect(leftover).toEqual([]);
		});

		test("put persists to the real fs with owner-only file and a fresh store restores it", async () => {
			const agentDir = tempAgentDir();
			const writer = new TelegramAdoptionIntentStore({ agentDir, now: () => 100 });
			await writer.put(intent({ intendedSessionId: "sREAL", topicId: 314, target: TARGET_EXISTING }));

			const file = sidecarPath(agentDir, "sREAL");
			expect(fsSync.existsSync(file)).toBe(true);
			if (process.platform !== "win32") {
				const stat = fsSync.statSync(file);
				// 0600 mask: no group/other bits.
				expect(stat.mode & 0o077).toBe(0);
				expect(stat.mode & 0o600).toBe(0o600);
			}

			// A fresh store rehydrates the non-expired intent.
			const reader = new TelegramAdoptionIntentStore({ agentDir, now: () => 100 });
			expect(reader.bySession("sREAL")).toBeUndefined();
			const loaded = await reader.rehydrate();
			expect(loaded).toBe(1);
			expect(reader.bySession("sREAL")?.topicId).toBe(314);
			expect(reader.bySession("sREAL")?.target).toEqual(TARGET_EXISTING);
		});
		test("permission enforcement failures reject without publishing an intent", async () => {
			const fake = new FakeFs();
			fake.failChmod = true;
			const store = new TelegramAdoptionIntentStore({ agentDir: AGENT, fs: fake, now: () => 100 });
			await expect(store.put(intent({ intendedSessionId: "sCHMOD" }))).rejects.toThrow("simulated chmod failure");
			expect(store.bySession("sCHMOD")).toBeUndefined();
		});
		test("post-rename permission failure removes the committed sidecar", async () => {
			const fake = new FakeFs();
			const committed = sidecarPath(AGENT, "sFINAL");
			const chmod = fake.chmod.bind(fake);
			fake.chmod = async (target, mode) => {
				if (target === committed) throw new Error("simulated final chmod failure");
				await chmod(target, mode);
			};
			const store = new TelegramAdoptionIntentStore({ agentDir: AGENT, fs: fake, now: () => 100 });
			await expect(store.put(intent({ intendedSessionId: "sFINAL" }))).rejects.toThrow(
				"simulated final chmod failure",
			);
			expect(fake.files.has(committed)).toBe(false);
			expect(store.bySession("sFINAL")).toBeUndefined();
		});
	});

	describe("synchronous topicId claims: cross-session exclusion", () => {
		test("tryClaim grants the first session and excludes a second session on the same topic", async () => {
			const store = new TelegramAdoptionIntentStore({ agentDir: AGENT, fs: new FakeFs(), now: () => 100 });
			await store.put(intent({ intendedSessionId: "sA", topicId: 200 }));
			expect(store.tryClaim(200, "sA")).toBe(true);
			// A different intendedSessionId cannot claim the same topic.
			expect(store.tryClaim(200, "sB")).toBe(false);
		});

		test("tryClaim is idempotent for the same session/topic", async () => {
			const store = new TelegramAdoptionIntentStore({ agentDir: AGENT, fs: new FakeFs(), now: () => 100 });
			expect(store.tryClaim(201, "sA")).toBe(true);
			expect(store.tryClaim(201, "sA")).toBe(true);
		});

		test("two pre-spawn intents for the same topic exclude each other even without a prior claim", async () => {
			// Both intents exist in memory (e.g. rehydrated) but neither has claimed yet.
			const store = new TelegramAdoptionIntentStore({ agentDir: AGENT, fs: new FakeFs(), now: () => 100 });
			await store.put(intent({ intendedSessionId: "sA", topicId: 300 }));
			await store.put(intent({ intendedSessionId: "sB", topicId: 300 }));
			// Whoever claims first wins; the loser is refused across awaits.
			expect(store.tryClaim(300, "sA")).toBe(true);
			expect(store.tryClaim(300, "sB")).toBe(false);
		});

		test("different topics do not interfere", async () => {
			const store = new TelegramAdoptionIntentStore({ agentDir: AGENT, fs: new FakeFs(), now: () => 100 });
			expect(store.tryClaim(301, "sA")).toBe(true);
			expect(store.tryClaim(302, "sB")).toBe(true);
		});

		test("releaseClaim allows the same or another session to reclaim the topic", async () => {
			const store = new TelegramAdoptionIntentStore({ agentDir: AGENT, fs: new FakeFs(), now: () => 100 });
			expect(store.tryClaim(400, "sA")).toBe(true);
			store.releaseClaim(400, "sA");
			// After release, a different session can claim (commit-failed retry path).
			expect(store.tryClaim(400, "sB")).toBe(true);
			expect(store.tryClaim(400, "sA")).toBe(false);
		});

		test("releaseClaim is a no-op for a non-holder", async () => {
			const store = new TelegramAdoptionIntentStore({ agentDir: AGENT, fs: new FakeFs(), now: () => 100 });
			expect(store.tryClaim(401, "sA")).toBe(true);
			// sB never held it; releasing as sB must not drop sA's claim.
			store.releaseClaim(401, "sB");
			expect(store.tryClaim(401, "sB")).toBe(false);
			expect(store.tryClaim(401, "sA")).toBe(true);
		});

		test("releaseClaim is a no-op when nothing is claimed", () => {
			const store = new TelegramAdoptionIntentStore({ agentDir: AGENT, fs: new FakeFs(), now: () => 100 });
			store.releaseClaim(999, "sNOPE"); // does not throw
			expect(store.tryClaim(999, "sFIRST")).toBe(true);
		});
	});

	describe("remove", () => {
		test("remove deletes the sidecar and drops memory + claim", async () => {
			const fake = new FakeFs();
			const store = new TelegramAdoptionIntentStore({ agentDir: AGENT, fs: fake, now: () => 100 });
			await store.put(intent({ intendedSessionId: "sRM", topicId: 500 }));
			expect(store.tryClaim(500, "sRM")).toBe(true);
			await store.remove("sRM");
			expect(fake.files.has(sidecarPath(AGENT, "sRM"))).toBe(false);
			expect(store.bySession("sRM")).toBeUndefined();
			// Claim cleared, so another session can take it.
			expect(store.tryClaim(500, "sOTHER")).toBe(true);
		});

		test("remove is idempotent on a missing file (no ENOENT throw)", async () => {
			const store = new TelegramAdoptionIntentStore({ agentDir: AGENT, fs: new FakeFs(), now: () => 100 });
			await expect(store.remove("neverExisted")).resolves.toBeUndefined();
		});

		test("readIntent loads a single sidecar and skips expired", async () => {
			const clock = { t: 1_000_000 };
			const fake = new FakeFs();
			const writer = new TelegramAdoptionIntentStore({ agentDir: AGENT, fs: fake, now: () => clock.t });
			await writer.put(intent({ intendedSessionId: "sONE", topicId: 9, expiresAt: 1_000_000 + 60_000 }));
			await writer.put(intent({ intendedSessionId: "sEXP", topicId: 10, expiresAt: 1_000_000 + 1_000 }));

			clock.t = 1_000_000 + 2_000;
			const reader = new TelegramAdoptionIntentStore({ agentDir: AGENT, fs: fake, now: () => clock.t });
			expect(await reader.readIntent("sONE")).toBeDefined();
			expect(reader.bySession("sONE")?.topicId).toBe(9);
			expect(await reader.readIntent("sEXP")).toBeUndefined();
			expect(await reader.readIntent("absent")).toBeUndefined();
		});
		test("remove and sweep propagate non-missing filesystem failures", async () => {
			const fake = new FakeFs();
			const store = new TelegramAdoptionIntentStore({ agentDir: AGENT, fs: fake, now: () => 100 });
			await store.put(intent({ intendedSessionId: "sRMFAIL", createdAt: 100, expiresAt: 200 }));
			fake.failUnlink = true;
			await expect(store.remove("sRMFAIL")).rejects.toThrow("simulated unlink failure");
			expect(store.bySession("sRMFAIL")).toBeDefined();
			fake.failUnlink = false;
			fake.failReaddir = true;
			await expect(store.sweepExpired()).rejects.toThrow("simulated readdir failure");
		});
	});

	describe("secret-field absence", () => {
		test("persisted sidecar contains only the allowlisted fields", async () => {
			const fake = new FakeFs();
			const store = new TelegramAdoptionIntentStore({ agentDir: AGENT, fs: fake, now: () => 100 });
			const a = intent({ intendedSessionId: "sSECRET", topicId: 42, target: TARGET_EXISTING });
			await store.put(a);

			const raw = fake.files.get(sidecarPath(AGENT, "sSECRET"))!;
			const parsed = JSON.parse(raw) as { version: number; intent: Record<string, unknown> };
			expect(parsed.version).toBe(1);
			const keys = Object.keys(parsed.intent).sort();
			expect(keys).toEqual(["chatId", "createdAt", "expiresAt", "intendedSessionId", "target", "topicId"].sort());
			// Forbidden fields never appear.
			expect(parsed.intent.token).toBeUndefined();
			expect(parsed.intent.controlToken).toBeUndefined();
			expect(parsed.intent.endpointDigest).toBeUndefined();
			expect(parsed.intent.endpointKey).toBeUndefined();
			expect(parsed.intent.leaseToken).toBeUndefined();
			expect(parsed.intent.botToken).toBeUndefined();
		});

		test("sidecar file text has no token/digest substrings even when the caller had them", async () => {
			const fake = new FakeFs();
			const store = new TelegramAdoptionIntentStore({ agentDir: AGENT, fs: fake, now: () => 100 });
			const a = {
				...buildAdoptionIntent({
					intendedSessionId: "sNOLEAK",
					topicId: 5,
					chatId: "chat-7",
					target: TARGET_EXISTING,
					now: 1,
					ttlMs: 1000,
				}),
				token: "secret-token-value",
				endpointDigest: "secret-digest-value",
				endpointKey: "secret-endpoint-value",
			} as TelegramAdoptionIntent;
			await store.put(a);
			const raw = fake.files.get(sidecarPath(AGENT, "sNOLEAK"))!;
			expect(raw).not.toContain("token");
			expect(raw).not.toContain("digest");
			expect(raw).not.toContain("secret");
			expect(raw).not.toContain("endpointKey");
			expect(raw).not.toContain("secret-token-value");
			expect(raw).not.toContain("secret-digest-value");
			expect(raw).not.toContain("secret-endpoint-value");
		});

		test("target is copied into the canonical existing-path shape", async () => {
			const fake = new FakeFs();
			const store = new TelegramAdoptionIntentStore({ agentDir: AGENT, fs: fake, now: () => 100 });
			const target = { ...TARGET_EXISTING, ignored: "not-persisted" };
			await store.put(intent({ intendedSessionId: "sK", topicId: 1, target }));
			expect(store.bySession("sK")?.target).toEqual(TARGET_EXISTING);
			expect(fake.files.get(sidecarPath(AGENT, "sK"))).not.toContain("not-persisted");
		});
	});
});
