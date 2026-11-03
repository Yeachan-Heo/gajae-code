import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, stat, symlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { FileLockAcquireError, FileLockTestHooks, withFileLock } from "../../src/config/file-lock";
import { resolveOwner } from "../../src/harness-control-plane/owner";
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
	it("maps typed acquisition exhaustion to lease_lock_timeout", async () => {
		const filePath = sessionPaths(root, SID).lease;
		await withFileLock(filePath, async () => {
			const attempt = releaseLease(root, SID, "owner-a");
			await expect(attempt).rejects.toBeInstanceOf(LeaseError);
			await expect(attempt).rejects.toMatchObject({ code: "lease_lock_timeout" });
		});
	});

	it("preserves access-denied publication failures instead of mapping them to lease timeout", async () => {
		const filePath = sessionPaths(root, SID).lease;
		const error = new FileLockAcquireError(
			filePath,
			`${filePath}.lock`,
			3,
			"publication failed with access_denied",
			"acquire_timeout",
			undefined,
			undefined,
			"access_denied",
		);
		FileLockTestHooks.afterParentMkdir = () => {
			throw error;
		};
		try {
			await expect(releaseLease(root, SID, "owner-a")).rejects.toBe(error);
		} finally {
			FileLockTestHooks.afterParentMkdir = undefined;
		}
	});

	it("heals a scrubbed dead-owner removal transition through the lease lock", async () => {
		const filePath = sessionPaths(root, SID).lease;
		const orphanPath = `${filePath}.lock.removing`;
		const infoPath = path.join(orphanPath, "info");
		await mkdir(orphanPath, { recursive: true });
		await writeFile(infoPath, "", "utf8");
		const transition = await stat(orphanPath, { bigint: true });
		// The remover record is kept beside the scrubbed tree so recovery can prove
		// this exact generation is dead without treating an ownerless empty info as proof.
		await writeFile(
			`${orphanPath}.owner`,
			JSON.stringify({
				owner: { pid: 2_147_483_647, timestamp: Date.now(), owner_token: "dead-remover" },
				rootDev: transition.dev.toString(),
				rootIno: transition.ino.toString(),
			}),
			"utf8",
		);
		await writeFile(filePath, JSON.stringify({ ownerId: "owner-a" }), "utf8");

		await releaseLease(root, SID, "owner-a");

		expect(
			await stat(orphanPath).then(
				() => true,
				() => false,
			),
		).toBe(false);
		expect(
			await stat(`${orphanPath}.owner`).then(
				() => true,
				() => false,
			),
		).toBe(false);
		expect(
			await stat(filePath).then(
				() => true,
				() => false,
			),
		).toBe(false);
	});

	it("does not release through a scrubbed transition with a live remover", async () => {
		const filePath = sessionPaths(root, SID).lease;
		const orphanPath = `${filePath}.lock.removing`;
		const infoPath = path.join(orphanPath, "info");
		const leaseBytes = JSON.stringify({ ownerId: "owner-a" });
		await mkdir(orphanPath, { recursive: true });
		await writeFile(infoPath, "", "utf8");
		const transition = await stat(orphanPath, { bigint: true });
		const ownerRecord = JSON.stringify({
			owner: { pid: process.pid, timestamp: Date.now(), owner_token: "live-remover" },
			rootDev: transition.dev.toString(),
			rootIno: transition.ino.toString(),
		});
		await writeFile(`${orphanPath}.owner`, ownerRecord, "utf8");
		await writeFile(filePath, leaseBytes, "utf8");

		await expect(releaseLease(root, SID, "owner-a")).rejects.toMatchObject({ code: "lease_lock_timeout" });
		expect(await readFile(filePath, "utf8")).toBe(leaseBytes);
		expect(await readFile(infoPath, "utf8")).toBe("");
		expect(await readFile(`${orphanPath}.owner`, "utf8")).toBe(ownerRecord);
	});

	it("preserves a refused orphan transition diagnostic instead of mapping it to lease timeout", async () => {
		const filePath = sessionPaths(root, SID).lease;
		const orphanPath = `${filePath}.lock.removing`;
		const infoPath = path.join(orphanPath, "info");
		await mkdir(orphanPath, { recursive: true });
		await writeFile(infoPath, "", "utf8");
		// A zero-byte info file has no parsed owner identity. Age alone cannot
		// prove that this ownerless transition was scrubbed, so it must remain
		// fail-closed and retain the typed diagnostic.
		await writeFile(filePath, JSON.stringify({ ownerId: "owner-a" }), "utf8");
		const old = new Date(Date.now() - 120_000);
		await utimes(infoPath, old, old);

		const failure = await releaseLease(root, SID, "owner-a").catch(error => error);
		if (!(failure instanceof FileLockAcquireError)) throw new Error("Expected an orphan transition lock failure");
		expect(failure).toMatchObject({
			code: "orphan_transition",
			reason: "orphan_transition",
			orphanPath,
		});
	});

	it("propagates a non-lock failure unchanged even with a contention-like message", async () => {
		const error = new Error("Failed to acquire lock for an unrelated operation");
		FileLockTestHooks.afterParentMkdir = () => {
			throw error;
		};
		try {
			await expect(releaseLease(root, SID, "owner-a")).rejects.toBe(error);
		} finally {
			FileLockTestHooks.afterParentMkdir = undefined;
		}
	});
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

	it("takes over a dead lease whose unix endpoint path is not a string", async () => {
		const badPaths: unknown[] = [null, 1, { nested: true }];
		const missing = {
			ownerId: "owner-a",
			sessionId: SID,
			pid: 1,
			leaseTokenHash: "ab".repeat(32),
			endpoint: { kind: "unix-socket" },
			eventsPath: "e",
			heartbeatAt: new Date().toISOString(),
			expiresAt: new Date(Date.now() + 60_000).toISOString(),
			leaseEpoch: 1,
			writer: { ownerId: "owner-a", leaseEpoch: 1 },
		};
		await mkdir(path.dirname(sessionPaths(root, SID).lease), { recursive: true });
		for (const endpointPath of badPaths) {
			const lease = { ...missing, endpoint: { kind: "unix-socket", path: endpointPath } };
			await writeFile(sessionPaths(root, SID).lease, `${JSON.stringify(lease)}\n`, "utf8");
			const taken = await acquireLease(root, SID, {
				ownerId: "owner-b",
				pid: 2,
				eventsPath: "e",
				endpoint: { kind: "unix-socket", path: controlSocketPath(root, SID) },
				ttlMs: 10_000,
				probe: deadProbe,
			});
			expect(taken.lease.ownerId).toBe("owner-b");
			expect(taken.lease.leaseEpoch).toBe(2);
		}
		await writeFile(sessionPaths(root, SID).lease, `${JSON.stringify(missing)}\n`, "utf8");
		const taken = await acquireLease(root, SID, {
			ownerId: "owner-b",
			pid: 2,
			eventsPath: "e",
			endpoint: { kind: "unix-socket", path: controlSocketPath(root, SID) },
			ttlMs: 10_000,
			probe: deadProbe,
		});
		expect(taken.lease.ownerId).toBe("owner-b");
		expect(taken.lease.leaseEpoch).toBe(2);
	});

	it("does not route a live lease whose unix endpoint path is not a string", async () => {
		const lease = {
			ownerId: "owner-a",
			sessionId: SID,
			pid: process.pid,
			leaseTokenHash: "ab".repeat(32),
			endpoint: { kind: "unix-socket", path: null },
			eventsPath: "e",
			heartbeatAt: new Date().toISOString(),
			expiresAt: new Date(Date.now() + 60_000).toISOString(),
			leaseEpoch: 1,
			writer: { ownerId: "owner-a", leaseEpoch: 1 },
		};
		await mkdir(path.dirname(sessionPaths(root, SID).lease), { recursive: true });
		await writeFile(sessionPaths(root, SID).lease, `${JSON.stringify(lease)}\n`, "utf8");
		expect((await resolveOwner(root, SID)).socketPath).toBeNull();
	});

	it("keeps holding a live lease whose unix endpoint is outside the private socket", async () => {
		const foreign = path.join(root, "outside.sock");
		await acquireLease(root, SID, {
			ownerId: "owner-a",
			pid: 1,
			eventsPath: "e",
			endpoint: { kind: "unix-socket", path: foreign },
			ttlMs: 10_000,
			probe: aliveProbe,
		});
		await expect(
			acquireLease(root, SID, {
				ownerId: "owner-b",
				pid: 2,
				eventsPath: "e",
				endpoint: { kind: "unix-socket", path: controlSocketPath(root, SID) },
				ttlMs: 10_000,
				probe: aliveProbe,
			}),
		).rejects.toThrow(/lease_held/);
	});

	it("keeps holding a live lease on the private owner socket", async () => {
		const canonical = controlSocketPath(root, SID);
		await acquireLease(root, SID, {
			ownerId: "owner-a",
			pid: 1,
			eventsPath: "e",
			endpoint: { kind: "unix-socket", path: canonical },
			ttlMs: 10_000,
			probe: aliveProbe,
		});
		await expect(
			acquireLease(root, SID, {
				ownerId: "owner-b",
				pid: 2,
				eventsPath: "e",
				endpoint: { kind: "unix-socket", path: canonical },
				ttlMs: 10_000,
				probe: aliveProbe,
			}),
		).rejects.toThrow(/lease_held/);
	});

	it("keeps holding a live lease when the endpoint uses dot segments", async () => {
		const canonical = controlSocketPath(root, SID);
		const dotted = `${canonical}${path.sep}..${path.sep}${path.basename(canonical)}`;
		await acquireLease(root, SID, {
			ownerId: "owner-a",
			pid: 1,
			eventsPath: "e",
			endpoint: { kind: "unix-socket", path: dotted },
			ttlMs: 10_000,
			probe: aliveProbe,
		});
		await expect(
			acquireLease(root, SID, {
				ownerId: "owner-b",
				pid: 2,
				eventsPath: "e",
				endpoint: { kind: "unix-socket", path: canonical },
				ttlMs: 10_000,
				probe: aliveProbe,
			}),
		).rejects.toThrow(/lease_held/);
	});

	it("keeps holding a live fifo endpoint", async () => {
		await acquireLease(root, SID, {
			ownerId: "owner-a",
			pid: 1,
			eventsPath: "e",
			endpoint: { kind: "fifo", path: path.join(root, "control.fifo") },
			ttlMs: 10_000,
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

describe("owner socket lookup under a configured temp dir", () => {
	const tempDirs: string[] = [];

	afterEach(async () => {
		await Promise.all(tempDirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })));
	});

	async function shortTempDir(): Promise<string> {
		const dir = await mkdtemp(path.join(tmpdir(), "hlt-"));
		tempDirs.push(dir);
		return dir;
	}

	function computedSocket(tempRoot: string): string {
		const digest = createHash("sha256").update(`${root}\0${SID}`).digest("hex").slice(0, 16);
		return path.join(tempRoot, `gjch${process.getuid?.()}`, `c-${digest}.sock`);
	}

	async function resolveWithTmpdir(tempRoot: string, endpointPath: string) {
		const lease = {
			ownerId: "owner-a",
			sessionId: SID,
			pid: process.pid,
			leaseTokenHash: "ab".repeat(32),
			endpoint: { kind: "unix-socket", path: endpointPath },
			eventsPath: "e",
			heartbeatAt: new Date().toISOString(),
			expiresAt: new Date(Date.now() + 60_000).toISOString(),
			leaseEpoch: 1,
			writer: { ownerId: "owner-a", leaseEpoch: 1 },
		};
		await mkdir(path.dirname(sessionPaths(root, SID).lease), { recursive: true });
		await writeFile(sessionPaths(root, SID).lease, `${JSON.stringify(lease)}\n`, "utf8");
		const saved = { TMPDIR: process.env.TMPDIR, GJC_HARNESS_SOCKET_DIR: process.env.GJC_HARNESS_SOCKET_DIR };
		process.env.TMPDIR = tempRoot;
		delete process.env.GJC_HARNESS_SOCKET_DIR;
		try {
			return await resolveOwner(root, SID);
		} finally {
			for (const [key, value] of Object.entries(saved)) {
				if (value === undefined) delete process.env[key];
				else process.env[key] = value;
			}
		}
	}

	it.skipIf(process.platform === "win32")(
		"does not chmod or trust a symlinked socket directory during lookup",
		async () => {
			const tempRoot = await shortTempDir();
			const target = await shortTempDir();
			await chmod(target, 0o755);
			await symlink(target, path.join(tempRoot, `gjch${process.getuid?.()}`));
			const owner = await resolveWithTmpdir(tempRoot, computedSocket(tempRoot));
			expect(owner.live).toBe(true);
			expect(owner.socketPath).toBeNull();
			expect((await stat(target)).mode & 0o777).toBe(0o755);
			expect(await readdir(target)).toEqual([]);
		},
	);

	it.skipIf(process.platform === "win32")("still routes to a private socket directory", async () => {
		const tempRoot = await shortTempDir();
		const base = path.join(tempRoot, `gjch${process.getuid?.()}`);
		await mkdir(base, { mode: 0o700 });
		await chmod(base, 0o700);
		const socketPath = computedSocket(tempRoot);
		const owner = await resolveWithTmpdir(tempRoot, socketPath);
		expect(owner.socketPath).toBe(socketPath);
		expect(await readdir(base)).toEqual([]);
	});
});
