import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import {
	acquireLease,
	canWriteEvents,
	heartbeat,
	isOwnerAlive,
	isStale,
	LeaseError,
	readLease,
	releaseLease,
} from "../../src/harness-control-plane/session-lease";

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

	it("allows takeover of an expired lease and increments the epoch", async () => {
		const past = () => 1_000; // acquire far in the past
		await acquireLease(root, SID, {
			ownerId: "owner-a",
			pid: 1,
			eventsPath: "e",
			ttlMs: 1,
			clock: past,
			probe: aliveProbe,
		});
		const taken = await acquireLease(root, SID, {
			ownerId: "owner-b",
			pid: 2,
			eventsPath: "e",
			ttlMs: 10_000,
			probe: aliveProbe, // alive, but prior lease expired
		});
		expect(taken.lease.leaseEpoch).toBe(2);
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

	it("isOwnerAlive returns false for an obviously dead pid", () => {
		expect(isOwnerAlive(2_147_483_646)).toBe(false);
	});
});
