import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import {
	acquireLease,
	canWriteEvents,
	classifyLeaseStatus,
	heartbeat,
	isOwnerAlive,
	isStale,
	LeaseError,
	readLease,
	reapDeadOwnerArtifacts,
	releaseLease,
} from "../../src/harness-control-plane/session-lease";
import { controlSocketPath, sessionPaths } from "../../src/harness-control-plane/storage";

let root: string;
const SID = "h-lease";
const aliveProbe = () => true;
const deadProbe = () => false;

beforeEach(async () => {
	root = await mkdtemp(path.join(tmpdir(), "harness-lease-"));
});
afterEach(async () => {
	await rm(root, { recursive: true, force: true });
});

describe("SessionLease", () => {
	it("classifies lease status from expiry and injected pid status", () => {
		const clock = () => 10_000;
		const liveLease = {
			ownerId: "owner-a",
			sessionId: SID,
			pid: 1,
			leaseTokenHash: "hash",
			endpoint: null,
			eventsPath: "e",
			heartbeatAt: new Date(9_000).toISOString(),
			expiresAt: new Date(20_000).toISOString(),
			leaseEpoch: 1,
			writer: { ownerId: "owner-a", leaseEpoch: 1 },
		};
		const expiredLease = { ...liveLease, expiresAt: new Date(10_000).toISOString() };
		expect(classifyLeaseStatus(null, { clock })).toBe("missing");
		expect(classifyLeaseStatus(liveLease, { clock, probe: () => "alive" })).toBe("live");
		expect(classifyLeaseStatus(expiredLease, { clock, probe: () => "alive" })).toBe("expiredAlive");
		expect(classifyLeaseStatus(liveLease, { clock, probe: () => "dead" })).toBe("dead");
		expect(classifyLeaseStatus(liveLease, { clock, probe: () => "eperm" })).toBe("epermAlive");
	});

	it("acquires a fresh lease at epoch 1 and persists it", async () => {
		const { lease, token } = await acquireLease(root, SID, {
			ownerId: "owner-a",
			pid: 1234,
			eventsPath: "events.jsonl",
			ttlMs: 10_000,
		});
		expect(lease.leaseEpoch).toBe(1);
		expect(lease.ownerId).toBe("owner-a");
		expect(typeof token).toBe("string");
		const reread = await readLease(root, SID);
		expect(reread?.ownerId).toBe("owner-a");
	});

	it("rejects a second acquire while a live, unexpired lease is held by another owner", async () => {
		await acquireLease(root, SID, { ownerId: "owner-a", pid: 1, eventsPath: "e", ttlMs: 10_000, probe: aliveProbe });
		await expect(
			acquireLease(root, SID, { ownerId: "owner-b", pid: 2, eventsPath: "e", ttlMs: 10_000, probe: aliveProbe }),
		).rejects.toThrow(LeaseError);
	});

	it("allows takeover of a stale (dead owner) lease and increments the epoch", async () => {
		await acquireLease(root, SID, { ownerId: "owner-a", pid: 1, eventsPath: "e", ttlMs: 10_000, probe: aliveProbe });
		const taken = await acquireLease(root, SID, {
			ownerId: "owner-b",
			pid: 2,
			eventsPath: "e",
			ttlMs: 10_000,
			probe: deadProbe, // prior owner is dead -> stale -> takeover
		});
		expect(taken.lease.ownerId).toBe("owner-b");
		expect(taken.lease.leaseEpoch).toBe(2);
	});

	it("recovers stale mutation lock directories whose holder pid is dead", async () => {
		const paths = sessionPaths(root, SID);
		const lockPath = `${paths.lease}.lock`;
		const token = "deadlock";
		await mkdir(lockPath, { recursive: true });
		await writeFile(
			path.join(lockPath, `${token}.json`),
			`${JSON.stringify({ pid: 2_147_483_646, token })}\n`,
			"utf8",
		);

		const taken = await acquireLease(root, SID, { ownerId: "owner-a", pid: 1, eventsPath: "e", ttlMs: 10_000 });

		expect(taken.lease.ownerId).toBe("owner-a");
		expect(taken.lease.leaseEpoch).toBe(1);
		await expect(readdir(lockPath)).rejects.toThrow();
	});

	it("recovers stale legacy mutation lock files whose holder pid is dead", async () => {
		const paths = sessionPaths(root, SID);
		const lockPath = `${paths.lease}.lock`;
		const token = "legacydead";
		await mkdir(path.dirname(lockPath), { recursive: true });
		await writeFile(lockPath, `${JSON.stringify({ pid: 2_147_483_646, token })}\n`, "utf8");

		const taken = await acquireLease(root, SID, { ownerId: "owner-a", pid: 1, eventsPath: "e", ttlMs: 10_000 });

		expect(taken.lease.ownerId).toBe("owner-a");
		expect(taken.lease.leaseEpoch).toBe(1);
		await expect(readdir(lockPath)).rejects.toThrow();
	});

	it("does not steal a mutation lock held by a live pid", async () => {
		const paths = sessionPaths(root, SID);
		const lockPath = `${paths.lease}.lock`;
		const token = "livelock";
		let settled = false;
		await mkdir(lockPath, { recursive: true });
		await writeFile(path.join(lockPath, `${token}.json`), `${JSON.stringify({ pid: process.pid, token })}\n`, "utf8");

		const acquiring = acquireLease(root, SID, { ownerId: "owner-a", pid: 1, eventsPath: "e", ttlMs: 10_000 }).then(
			result => {
				settled = true;
				return result;
			},
			error => {
				settled = true;
				throw error;
			},
		);

		await Bun.sleep(60);
		expect(settled).toBe(false);
		await rm(lockPath, { recursive: true, force: true });
		const taken = await acquiring;
		expect(taken.lease.ownerId).toBe("owner-a");
	});

	it("does not recover malformed, mismatched, or multi-entry mutation locks", async () => {
		const paths = sessionPaths(root, SID);
		for (const [suffix, entries] of [
			["malformed", [{ name: "bad.json", content: "not json" }]],
			["mismatch", [{ name: "wrong.json", content: JSON.stringify({ pid: 2_147_483_646, token: "right" }) }]],
			[
				"multiple",
				[
					{ name: "dead.json", content: JSON.stringify({ pid: 2_147_483_646, token: "dead" }) },
					{ name: "live.json", content: JSON.stringify({ pid: process.pid, token: "live" }) },
				],
			],
		] as const) {
			const sid = `${SID}-${suffix}`;
			const lockPath = `${sessionPaths(root, sid).lease}.lock`;
			await mkdir(lockPath, { recursive: true });
			for (const entry of entries) await writeFile(path.join(lockPath, entry.name), `${entry.content}\n`, "utf8");
			let settled = false;
			const acquiring = acquireLease(root, sid, {
				ownerId: "owner-a",
				pid: 1,
				eventsPath: paths.events,
				ttlMs: 10_000,
			}).then(
				result => {
					settled = true;
					return result;
				},
				error => {
					settled = true;
					throw error;
				},
			);

			await Bun.sleep(60);
			expect(settled).toBe(false);
			const before = await Promise.all(entries.map(entry => readFile(path.join(lockPath, entry.name), "utf8")));
			expect(before.map(content => content.trim())).toEqual(entries.map(entry => entry.content));
			await rm(lockPath, { recursive: true, force: true });
			const taken = await acquiring;
			expect(taken.lease.ownerId).toBe("owner-a");
		}
	});

	it("does not reap fifo endpoint artifacts", async () => {
		const fifoPath = path.join(root, "control.fifo");
		await acquireLease(root, SID, {
			ownerId: "owner-a",
			pid: 1,
			eventsPath: "e",
			endpoint: { kind: "fifo", path: fifoPath },
			ttlMs: 10_000,
			probe: aliveProbe,
		});
		await writeFile(fifoPath, "fifo", "utf8");

		expect(await reapDeadOwnerArtifacts(root, SID, "owner-a", 1, { probe: () => "dead" })).toBe(true);

		expect(await readFile(fifoPath, "utf8")).toBe("fifo");
	});
	it("fails closed for an expired lease whose owner is still alive", async () => {
		const past = () => 1_000;
		await acquireLease(root, SID, {
			ownerId: "owner-a",
			pid: 1,
			eventsPath: "e",
			ttlMs: 1,
			clock: past,
			probe: aliveProbe,
		});
		await expect(
			acquireLease(root, SID, {
				ownerId: "owner-b",
				pid: 2,
				eventsPath: "e",
				ttlMs: 10_000,
				probe: aliveProbe,
			}),
		).rejects.toThrow(/lease_held/);
	});

	it("fails closed for a lease whose owner returns eperm", async () => {
		await acquireLease(root, SID, { ownerId: "owner-a", pid: 1, eventsPath: "e", ttlMs: 10_000, probe: aliveProbe });
		await expect(
			acquireLease(root, SID, { ownerId: "owner-b", pid: 2, eventsPath: "e", ttlMs: 10_000, probe: () => "eperm" }),
		).rejects.toThrow(/lease_held/);
	});

	it("heartbeat is single-writer: only the holder may refresh", async () => {
		await acquireLease(root, SID, { ownerId: "owner-a", pid: 1, eventsPath: "e", ttlMs: 10_000, probe: aliveProbe });
		const refreshed = await heartbeat(root, SID, "owner-a", 20_000);
		expect(Date.parse(refreshed.expiresAt)).toBeGreaterThan(Date.parse(refreshed.heartbeatAt));
		await expect(heartbeat(root, SID, "owner-b", 20_000)).rejects.toThrow(/not_lease_holder/);
	});

	it("canWriteEvents only for the live, unexpired holder", async () => {
		const { lease } = await acquireLease(root, SID, {
			ownerId: "owner-a",
			pid: 1,
			eventsPath: "e",
			ttlMs: 10_000,
			probe: aliveProbe,
		});
		expect(canWriteEvents(lease, "owner-a")).toBe(true);
		expect(canWriteEvents(lease, "owner-b")).toBe(false);
	});

	it("isStale reflects expiry and liveness; releaseLease requires the holder", async () => {
		const { lease } = await acquireLease(root, SID, { ownerId: "owner-a", pid: 1, eventsPath: "e", ttlMs: 10_000 });
		expect(isStale(lease, { probe: deadProbe })).toBe(true);
		expect(isStale(lease, { probe: aliveProbe })).toBe(false);
		await expect(releaseLease(root, SID, "owner-b")).rejects.toThrow(/not_lease_holder/);
		await releaseLease(root, SID, "owner-a");
		expect(await readLease(root, SID)).toBeNull();
	});

	it("reaps dead owner artifacts only for matching dead owner, epoch, and owned endpoint path", async () => {
		const ownedSocket = controlSocketPath(root, SID);
		await acquireLease(root, SID, {
			ownerId: "owner-a",
			pid: 1,
			eventsPath: "e",
			endpoint: { kind: "unix-socket", path: ownedSocket },
			ttlMs: 10_000,
			probe: aliveProbe,
		});
		const paths = sessionPaths(root, SID);
		await writeFile(paths.controlSock, "sock", "utf8");
		await writeFile(ownedSocket, "sock", "utf8");
		expect(await reapDeadOwnerArtifacts(root, SID, "owner-a", 2, { probe: () => "dead" })).toBe(false);
		expect(await readLease(root, SID)).not.toBeNull();
		expect(await reapDeadOwnerArtifacts(root, SID, "owner-a", 1, { probe: () => "alive" })).toBe(false);
		expect(await readLease(root, SID)).not.toBeNull();
		expect(await reapDeadOwnerArtifacts(root, SID, "owner-a", 1, { probe: () => "dead" })).toBe(true);
		expect(await readLease(root, SID)).toBeNull();
		await expect(readFile(ownedSocket, "utf8")).rejects.toThrow();
	});

	it("does not remove an unowned endpoint path while reaping a dead owner lease", async () => {
		const paths = sessionPaths(root, SID);
		const unownedSocket = path.join(root, "unowned.sock");
		await acquireLease(root, SID, {
			ownerId: "owner-a",
			pid: 1,
			eventsPath: "e",
			endpoint: { kind: "unix-socket", path: unownedSocket },
			ttlMs: 10_000,
			probe: aliveProbe,
		});
		await writeFile(paths.controlSock, "sock", "utf8");
		await writeFile(unownedSocket, "sock", "utf8");

		expect(await reapDeadOwnerArtifacts(root, SID, "owner-a", 1, { probe: () => "dead" })).toBe(true);

		expect(await readFile(unownedSocket, "utf8")).toBe("sock");
		await expect(readFile(paths.controlSock, "utf8")).rejects.toThrow();
	});

	it("does not signal pids while reaping dead owner artifacts", async () => {
		await acquireLease(root, SID, { ownerId: "owner-a", pid: 1, eventsPath: "e", ttlMs: 10_000, probe: aliveProbe });
		let probes = 0;
		const reaped = await reapDeadOwnerArtifacts(root, SID, "owner-a", 1, {
			probe: () => {
				probes++;
				return "dead";
			},
		});
		expect(reaped).toBe(true);
		expect(probes).toBe(1);
	});

	it("isOwnerAlive returns false for an obviously dead pid", () => {
		expect(isOwnerAlive(2_147_483_646)).toBe(false);
	});
});
