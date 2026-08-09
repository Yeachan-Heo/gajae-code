import { afterEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import path from "node:path";
import { logger } from "@gajae-code/utils";
import {
	BROKER_LOCK_ARTIFACT_GRACE_MS,
	Broker,
	reapStaleBrokerLockArtifacts,
	setLockArtifactGraceForTest,
} from "../src/sdk/broker/broker";
import { brokerProcessIncarnation, writeBrokerDiscovery } from "../src/sdk/broker/discovery";
import { ensureBroker } from "../src/sdk/broker/ensure";
import { LifecycleLedger } from "../src/sdk/broker/lifecycle-ledger";

const HOUR_MS = 60 * 60 * 1_000;

/** Temp state roots created by this file; `~/.gjc` is never touched. */
const roots: string[] = [];
/** Paths chmod-ed to 0 that must be reopened before the temp root can be removed. */
const restoreModes: string[] = [];

async function makeAgentDir(): Promise<string> {
	const dir = await fs.mkdtemp(path.join(process.env.TMPDIR ?? "/tmp", "gjc-broker-artifacts-"));
	roots.push(dir);
	await fs.mkdir(path.join(dir, "sdk"), { recursive: true, mode: 0o700 });
	return dir;
}

async function ageTo(target: string, ageMs: number, now: number): Promise<void> {
	const stamp = new Date(now - ageMs);
	await fs.utimes(target, stamp, stamp);
}

/** Materialize one lock artifact directory with an optional owner record. */
async function writeArtifact(
	agentDir: string,
	name: string,
	owner: { pid: number } | "no-record" | "unparseable",
	ageMs: number,
	now: number,
): Promise<string> {
	const target = path.join(agentDir, "sdk", name);
	await fs.mkdir(target, { recursive: true, mode: 0o700 });
	if (owner === "unparseable") await Bun.write(path.join(target, "owner.json"), "{not json");
	else if (owner !== "no-record")
		await Bun.write(
			path.join(target, "owner.json"),
			JSON.stringify({ version: 1, ownerId: "owner-a", pid: owner.pid, acquiredAt: now - ageMs }),
		);
	await ageTo(target, ageMs, now);
	return target;
}

async function exists(target: string): Promise<boolean> {
	try {
		await fs.lstat(target);
		return true;
	} catch {
		return false;
	}
}

const isRoot = process.getuid?.() === 0;

afterEach(async () => {
	vi.restoreAllMocks();
	for (const target of restoreModes.splice(0)) await fs.chmod(target, 0o700).catch(() => {});
	for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
});

describe("broker lock artifact reaper", () => {
	it("removes tombstones past the grace bound and keeps newer ones", async () => {
		const now = Date.now();
		const agentDir = await makeAgentDir();
		const stale = await writeArtifact(agentDir, ".broker.lock.stale-aaaa", { pid: 999_999 }, 4 * HOUR_MS, now);
		const fresh = await writeArtifact(agentDir, ".broker.lock.stale-bbbb", { pid: 999_998 }, 5 * 60_000, now);

		const result = await reapStaleBrokerLockArtifacts({
			agentDir,
			now,
			graceMs: HOUR_MS,
			pidAlive: () => false,
		});

		expect(result.removed).toEqual([stale]);
		expect(result.retained).toEqual([{ path: fresh, reason: "within-grace" }]);
		expect(await exists(stale)).toBe(false);
		expect(await exists(fresh)).toBe(true);
	});

	it("never removes a tombstone whose owner pid is alive", async () => {
		const now = Date.now();
		const agentDir = await makeAgentDir();
		const warn = vi.spyOn(logger, "warn").mockImplementation(() => {});
		const live = await writeArtifact(agentDir, ".broker.lock.stale-live", { pid: process.pid }, 30 * HOUR_MS, now);

		const result = await reapStaleBrokerLockArtifacts({
			agentDir,
			now,
			graceMs: HOUR_MS,
			pidAlive: pid => pid === process.pid,
		});

		expect(result.removed).toEqual([]);
		expect(result.retained).toEqual([{ path: live, reason: "owner-alive" }]);
		expect(await exists(path.join(live, "owner.json"))).toBe(true);
		expect(warn.mock.calls.map(call => String(call[0]))).toEqual([
			"sdk broker: retained stale lock artifact .broker.lock.stale-live (owner-alive)",
		]);
	});

	it("keeps a tombstone whose owner record cannot be parsed", async () => {
		const now = Date.now();
		const agentDir = await makeAgentDir();
		const warn = vi.spyOn(logger, "warn").mockImplementation(() => {});
		const broken = await writeArtifact(agentDir, ".broker.lock.stale-broken", "unparseable", 30 * HOUR_MS, now);

		const result = await reapStaleBrokerLockArtifacts({ agentDir, now, graceMs: HOUR_MS, pidAlive: () => false });

		expect(result.removed).toEqual([]);
		expect(result.retained).toEqual([{ path: broken, reason: "owner-record-unreadable" }]);
		expect(await exists(broken)).toBe(true);
		expect(warn).toHaveBeenCalledWith(
			"sdk broker: retained stale lock artifact .broker.lock.stale-broken (owner-record-unreadable)",
		);
	});

	it("keeps a tombstone whose owner record is missing", async () => {
		const now = Date.now();
		const agentDir = await makeAgentDir();
		const orphan = await writeArtifact(agentDir, ".broker.lock.stale-orphan", "no-record", 30 * HOUR_MS, now);

		const result = await reapStaleBrokerLockArtifacts({ agentDir, now, graceMs: HOUR_MS, pidAlive: () => false });

		expect(result.removed).toEqual([]);
		expect(result.retained).toEqual([{ path: orphan, reason: "owner-record-missing" }]);
		expect(await exists(orphan)).toBe(true);
	});

	it.skipIf(isRoot)("keeps a permission-denied entry, logs it, and still reaps the rest of the pass", async () => {
		const now = Date.now();
		const agentDir = await makeAgentDir();
		const warn = vi.spyOn(logger, "warn").mockImplementation(() => {});
		const denied = await writeArtifact(agentDir, ".broker.lock.stale-denied", { pid: 999_999 }, 30 * HOUR_MS, now);
		const reapable = await writeArtifact(agentDir, ".broker.lock.stale-open", { pid: 999_998 }, 30 * HOUR_MS, now);
		await fs.chmod(denied, 0o000);
		restoreModes.push(denied);
		await ageTo(denied, 30 * HOUR_MS, now);

		const result = await reapStaleBrokerLockArtifacts({ agentDir, now, graceMs: HOUR_MS, pidAlive: () => false });

		expect(result.removed).toEqual([reapable]);
		expect(result.retained).toEqual([{ path: denied, reason: "owner-record-unreadable" }]);
		expect(await exists(denied)).toBe(true);
		expect(warn).toHaveBeenCalledWith(
			"sdk broker: retained stale lock artifact .broker.lock.stale-denied (owner-record-unreadable)",
		);
	});

	it("removes legacy restart and stale backups that carry no owner record", async () => {
		const now = Date.now();
		const agentDir = await makeAgentDir();
		const restart = await writeArtifact(
			agentDir,
			"broker-restart-backup-20260722-223542",
			"no-record",
			30 * HOUR_MS,
			now,
		);
		const staleBackup = await writeArtifact(
			agentDir,
			"broker-stale-backup-20260722-221524",
			"no-record",
			30 * HOUR_MS,
			now,
		);
		// Backups carry arbitrary salvaged state, not an owner record.
		await Bun.write(path.join(restart, "broker.json"), "{}");
		await ageTo(restart, 30 * HOUR_MS, now);

		const result = await reapStaleBrokerLockArtifacts({ agentDir, now, graceMs: HOUR_MS, pidAlive: () => false });

		expect(result.removed.toSorted()).toEqual([restart, staleBackup].toSorted());
		expect(await exists(restart)).toBe(false);
		expect(await exists(staleBackup)).toBe(false);
	});

	it("never follows a symlink shaped like a tombstone", async () => {
		const now = Date.now();
		const agentDir = await makeAgentDir();
		const victim = path.join(agentDir, "victim");
		await fs.mkdir(victim, { recursive: true });
		await Bun.write(path.join(victim, "keep.txt"), "keep");
		const link = path.join(agentDir, "sdk", ".broker.lock.stale-link");
		await fs.symlink(victim, link);

		const result = await reapStaleBrokerLockArtifacts({ agentDir, now, graceMs: 0, pidAlive: () => false });

		expect(result.removed).toEqual([]);
		expect(result.retained).toEqual([{ path: link, reason: "not-a-directory" }]);
		expect(await exists(path.join(victim, "keep.txt"))).toBe(true);
	});

	it("leaves live broker state in the sdk directory untouched", async () => {
		const now = Date.now();
		const agentDir = await makeAgentDir();
		const lock = path.join(agentDir, "sdk", "broker.lock");
		await fs.mkdir(lock, { recursive: true });
		await Bun.write(path.join(lock, "owner.json"), JSON.stringify({ version: 1, pid: 4, ownerId: "a" }));
		await Bun.write(path.join(agentDir, "sdk", "broker.json"), "{}");
		await Bun.write(path.join(agentDir, "sdk", "lifecycle-ledger.jsonl"), "");
		await ageTo(lock, 30 * HOUR_MS, now);

		const result = await reapStaleBrokerLockArtifacts({ agentDir, now, graceMs: HOUR_MS, pidAlive: () => false });

		expect(result).toEqual({ removed: [], retained: [] });
		expect(await exists(path.join(lock, "owner.json"))).toBe(true);
		expect(await exists(path.join(agentDir, "sdk", "broker.json"))).toBe(true);
	});

	it("returns empty for a state root that has no sdk directory yet", async () => {
		const agentDir = await fs.mkdtemp(path.join(process.env.TMPDIR ?? "/tmp", "gjc-broker-artifacts-"));
		roots.push(agentDir);

		expect(await reapStaleBrokerLockArtifacts({ agentDir })).toEqual({ removed: [], retained: [] });
	});

	it("bounds the default grace window to one day", () => {
		expect(BROKER_LOCK_ARTIFACT_GRACE_MS).toBe(24 * HOUR_MS);
	});

	it("reaps stale tombstones on broker startup and keeps newer ones", async () => {
		const now = Date.now();
		const agentDir = await makeAgentDir();
		const stale = await writeArtifact(agentDir, ".broker.lock.stale-startup", { pid: 999_999 }, 4 * HOUR_MS, now);
		const fresh = await writeArtifact(agentDir, ".broker.lock.stale-recent", { pid: 999_998 }, 60_000, now);
		const broker = new Broker({ agentDir });
		setLockArtifactGraceForTest(broker, HOUR_MS);

		try {
			await broker.start();
			expect(broker.ownsDiscovery).toBe(true);
		} finally {
			await broker.stop();
		}

		expect(await exists(stale)).toBe(false);
		expect(await exists(fresh)).toBe(true);
	});
});

describe("broker clean-exit lock contention diagnostics", () => {
	it("names lock contention when yielding to a live broker owner", async () => {
		const agentDir = await makeAgentDir();
		const info = vi.spyOn(logger, "info").mockImplementation(() => {});
		const lock = path.join(agentDir, "sdk", "broker.lock");
		await fs.mkdir(lock, { recursive: true, mode: 0o700 });
		await Bun.write(
			path.join(lock, "owner.json"),
			JSON.stringify({ version: 1, ownerId: "foreign-owner", pid: process.pid, acquiredAt: Date.now() }),
		);
		await writeBrokerDiscovery(agentDir, {
			version: 1,
			protocolVersion: 3,
			packageGeneration: "test",
			ownerId: "foreign-owner",
			pid: process.pid,
			incarnation: brokerProcessIncarnation(process.pid) ?? "",
			host: "127.0.0.1",
			port: 1,
			url: "ws://127.0.0.1:1",
			token: "t".repeat(64),
			startedAt: Date.now(),
			heartbeatAt: Date.now(),
		});

		const broker = new Broker({ agentDir });
		const discovery = await broker.start();

		expect(discovery.ownerId).toBe("foreign-owner");
		expect(broker.ownsDiscovery).toBe(false);
		const contention = info.mock.calls
			.map(call => String(call[0]))
			.filter(message => message.includes("lock contention"));
		expect(contention).toHaveLength(1);
		expect(contention[0]).toContain("yielding to the live broker owner");
		expect(contention[0]).toContain("ownerId=foreign-owner");
		expect(contention[0]).toContain("exits without owning discovery");
	});

	it("warns with the holding pid before refusing a lock held by a live owner", async () => {
		const agentDir = await makeAgentDir();
		const warn = vi.spyOn(logger, "warn").mockImplementation(() => {});
		const lock = path.join(agentDir, "sdk", "broker.lock");
		await fs.mkdir(lock, { recursive: true, mode: 0o700 });
		await Bun.write(
			path.join(lock, "owner.json"),
			JSON.stringify({ version: 1, ownerId: "holder", pid: process.pid, acquiredAt: Date.now() }),
		);

		const broker = new Broker({ agentDir });

		await expect(broker.start()).rejects.toThrow(`Broker lock is held by a live owner (pid ${process.pid})`);

		const refusals = warn.mock.calls
			.map(call => String(call[0]))
			.filter(message => message.includes("lock contention"));
		expect(refusals).toHaveLength(1);
		expect(refusals[0]).toContain("refusing to start");
		expect(refusals[0]).toContain(`live pid ${process.pid}`);
	});
});

describe("detached broker spawn diagnostics", () => {
	it("folds the spawned broker's stderr into the exited-before-discovery failure", async () => {
		const agentDir = await makeAgentDir();
		// An unsupported session-index snapshot makes the spawned broker's start()
		// reject, so it exits before publishing discovery. Under `stdio: "ignore"`
		// the caller saw only an exit code; the reason must now reach the error.
		await fs.mkdir(path.join(agentDir, "sdk", "sessions"), { recursive: true });
		await Bun.write(path.join(agentDir, "sdk", "sessions", "index.snapshot.json"), JSON.stringify({ version: 99 }));

		const failure = await ensureBroker({ agentDir }).then(
			() => undefined,
			(error: unknown) => (error instanceof Error ? error : new Error(String(error))),
		);
		expect(failure?.message).toMatch(/exited before discovery[\s\S]*Broker stderr:/);
		expect(failure?.message).toContain("index.snapshot.json");

		// The sink is per-spawn and removed once folded into the failure, so the
		// diagnostic lives in the error and leaves no retained artifact behind.
		const retained = await fs.readdir(path.join(agentDir, "sdk"));
		expect(retained.filter(name => name.startsWith("broker-spawn"))).toEqual([]);
	}, 20_000);
});

describe("lifecycle ledger quarantine bound", () => {
	/** A syntactically valid row that fails entry validation, so `open()` quarantines it. */
	function badRow(index: number, padBytes: number): string {
		return `${JSON.stringify({ version: 1, identity: "", requestHash: `r${index}`, state: "accepted", ts: index, pad: "x".repeat(padBytes) })}\n`;
	}

	it("rotates the corrupt sidecar instead of growing past its cap", async () => {
		const agentDir = await makeAgentDir();
		const ledgerFile = path.join(agentDir, "sdk", "lifecycle-ledger.jsonl");
		const corrupt = `${ledgerFile}.corrupt`;
		const maxCorruptBytes = 4_096;
		await Bun.write(ledgerFile, Array.from({ length: 12 }, (_, index) => badRow(index, 512)).join(""));

		for (let pass = 0; pass < 4; pass++) {
			await new LifecycleLedger(agentDir, { maxCorruptBytes }).open();
			expect(Bun.file(corrupt).size).toBeLessThanOrEqual(maxCorruptBytes + 1);
		}

		expect(Bun.file(`${corrupt}.1`).size).toBeGreaterThan(0);
		expect(Bun.file(`${corrupt}.1`).size).toBeLessThanOrEqual(maxCorruptBytes + 1);
	});

	it("clips a single oversized quarantined row to the cap and marks the truncation", async () => {
		const agentDir = await makeAgentDir();
		const ledgerFile = path.join(agentDir, "sdk", "lifecycle-ledger.jsonl");
		const corrupt = `${ledgerFile}.corrupt`;
		const maxCorruptBytes = 256;
		await Bun.write(ledgerFile, badRow(0, 4_096));

		await new LifecycleLedger(agentDir, { maxCorruptBytes }).open();

		const quarantined = await Bun.file(corrupt).text();
		expect(quarantined).toContain("[gjc: quarantined row truncated at the corrupt-ledger cap]");
		expect(Bun.file(corrupt).size).toBeLessThan(maxCorruptBytes + 128);
	});

	it("appends within the cap without rotating", async () => {
		const agentDir = await makeAgentDir();
		const ledgerFile = path.join(agentDir, "sdk", "lifecycle-ledger.jsonl");
		const corrupt = `${ledgerFile}.corrupt`;
		await Bun.write(ledgerFile, badRow(0, 16));

		await new LifecycleLedger(agentDir, { maxCorruptBytes: 64 * 1024 }).open();

		expect(Bun.file(corrupt).size).toBeGreaterThan(0);
		expect(await Bun.file(`${corrupt}.1`).exists()).toBe(false);
	});
});
