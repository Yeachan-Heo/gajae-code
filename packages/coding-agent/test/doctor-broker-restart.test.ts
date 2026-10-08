import { describe, expect, it, spyOn } from "bun:test";
import * as fs from "node:fs/promises";
import path from "node:path";
import { type NativeExactUnlinkResult, snapshotDirectoryTree } from "@gajae-code/natives";
import { FileLockTestHooks } from "../src/config/file-lock";
import { Broker } from "../src/sdk/broker/broker";
import { readBrokerExitRecord, readBrokerStartupExitRecord } from "../src/sdk/broker/broker-exit";
import { launchAuthorizedBrokerSuccessor, oldOwnerConfirmedExited } from "../src/sdk/broker/daemon-entry";
import { brokerRestartIntentPath, publishBrokerDiscovery, readBrokerRestartIntent } from "../src/sdk/broker/discovery";
import { restartBrokerForDoctor } from "../src/sdk/broker/doctor-restart";

async function fixture() {
	const dir = await fs.mkdtemp(path.join(process.env.TMPDIR ?? "/tmp", "gjc-doctor-restart-"));
	const broker = new Broker({ agentDir: dir });
	const discovery = await broker.start();
	return { dir, broker, discovery };
}

describe("doctor broker restart protocol", () => {
	it("distinguishes absent intent from malformed durable intent, at the independent root slot", async () => {
		const dir = await fs.mkdtemp(path.join(process.env.TMPDIR ?? "/tmp", "gjc-doctor-intent-"));
		expect(await readBrokerRestartIntent(dir)).toBeNull();
		await fs.mkdir(path.join(dir, "sdk"), { recursive: true });
		await fs.writeFile(brokerRestartIntentPath(dir), "{");
		await expect(readBrokerRestartIntent(dir)).rejects.toThrow("Malformed broker restart intent.");
	});

	it("prepares and commits an idle owner with exact identity, and the durable intent survives lock removal", async () => {
		const { dir, broker, discovery } = await fixture();
		const requestId = "doctor-idle";
		const prepared = await broker.prepareRestart({
			ownerId: discovery.ownerId,
			generation: discovery.packageGeneration,
			pid: discovery.pid,
			incarnation: discovery.incarnation,
			requestId,
			deadlineAt: Date.now() + 2_000,
		});
		expect(prepared.ok).toBe(true);
		if (!prepared.ok) return;
		const lease = prepared.result as { lease: string; occupancyEpoch: number; expiresAt: number };

		// The intent is prepared beneath sdk/, not sdk/broker.lock/, so it
		// durably survives a stale-lock reclaim renaming the lock directory
		// aside -- simulate exactly that here.
		const readAfterPrepare = await readBrokerRestartIntent(dir);
		expect(readAfterPrepare?.requestId).toBe(requestId);
		expect(readAfterPrepare?.phase).toBe("prepared");
		await fs.rename(path.join(dir, "sdk", "broker.lock"), path.join(dir, "sdk", "broker.lock.quarantined"));
		const readAfterLockReclaim = await readBrokerRestartIntent(dir);
		expect(readAfterLockReclaim?.requestId).toBe(requestId);
		await fs.rename(path.join(dir, "sdk", "broker.lock.quarantined"), path.join(dir, "sdk", "broker.lock"));

		const committed = await broker.commitRestart({
			ownerId: discovery.ownerId,
			generation: discovery.packageGeneration,
			pid: discovery.pid,
			incarnation: discovery.incarnation,
			requestId,
			deadlineAt: lease.expiresAt,
			lease: lease.lease,
			occupancyEpoch: lease.occupancyEpoch,
		});
		expect(committed.ok).toBe(true);
		const readAfterCommit = await readBrokerRestartIntent(dir);
		expect(readAfterCommit?.phase).toBe("committed");
		await broker.completion;
	});

	it("refuses busy occupancy while preparing (a live nonterminal session blocks idle restart)", async () => {
		const { dir, broker, discovery } = await fixture();
		const stateRoot = path.join(dir, "state");
		await broker.index.append({
			type: "host_registered",
			sessionId: "attached-live",
			locator: { cwd: dir, worktreeRoot: null, stateRoot },
			endpointGeneration: 1,
			pid: process.pid,
		});
		const prepared = await broker.prepareRestart({
			ownerId: discovery.ownerId,
			generation: discovery.packageGeneration,
			pid: discovery.pid,
			incarnation: discovery.incarnation,
			requestId: "busy",
			deadlineAt: Date.now() + 500,
		});
		expect(prepared.ok).toBe(false);
		if (!prepared.ok) expect(prepared.error.code).toBe("restart_busy");
		expect(await readBrokerRestartIntent(dir)).toBeNull();
		await broker.stop();
	});

	it("rejects prepare gate against new work and against owner/generation/request mismatch", async () => {
		const { broker, discovery } = await fixture();
		const prepared = await broker.prepareRestart({
			...discovery,
			generation: discovery.packageGeneration,
			requestId: "gate",
			deadlineAt: Date.now() + 2_000,
		});
		expect(prepared.ok).toBe(true);
		// New work is refused while the admission gate is closed.
		expect((await broker.handleRequest("session.list", {})).ok).toBe(false);
		// A second concurrent prepare with a different requestId is refused.
		expect(
			(
				await broker.prepareRestart({
					...discovery,
					generation: discovery.packageGeneration,
					requestId: "other",
					deadlineAt: Date.now() + 2_000,
				})
			).ok,
		).toBe(false);
		// Owner/generation mismatch is refused.
		expect(
			(
				await broker.prepareRestart({
					...discovery,
					generation: discovery.packageGeneration,
					ownerId: "wrong-owner",
					requestId: "gate",
					deadlineAt: Date.now() + 2_000,
				})
			).ok,
		).toBe(false);
		expect(
			(
				await broker.prepareRestart({
					...discovery,
					generation: "wrong-generation",
					requestId: "gate",
					deadlineAt: Date.now() + 2_000,
				})
			).ok,
		).toBe(false);
		expect((await broker.cancelRestart("gate")).ok).toBe(true);
		await broker.stop();
	});

	it("lease cancellation reopens admission, clears the durable intent, and a stale commit proof cannot replay", async () => {
		const { dir, broker, discovery } = await fixture();
		const prepared = await broker.prepareRestart({
			...discovery,
			generation: discovery.packageGeneration,
			requestId: "lease",
			deadlineAt: Date.now() + 2_000,
		});
		expect(prepared.ok).toBe(true);
		expect(await readBrokerRestartIntent(dir)).not.toBeNull();
		expect((await broker.cancelRestart("lease")).ok).toBe(true);
		expect(await readBrokerRestartIntent(dir)).toBeNull();
		// New work is admitted again after cancellation.
		expect((await broker.handleRequest("session.list", {})).ok).toBe(true);
		// A stale/forged commit proof against the cancelled request is refused.
		expect(
			(
				await broker.commitRestart({
					...discovery,
					generation: discovery.packageGeneration,
					requestId: "lease",
					deadlineAt: Date.now() + 2_000,
					lease: "bad",
					occupancyEpoch: 0,
				})
			).ok,
		).toBe(false);
		await broker.stop();
	});

	it("restart lease expiry releases its reservation without exiting the owner", async () => {
		const { dir, broker, discovery } = await fixture();
		const prepared = await broker.prepareRestart({
			...discovery,
			generation: discovery.packageGeneration,
			requestId: "lease-expiry",
			deadlineAt: Date.now() + 100,
		});
		expect(prepared.ok).toBe(true);
		expect(await readBrokerRestartIntent(dir)).not.toBeNull();

		await Bun.sleep(150);
		expect(await readBrokerRestartIntent(dir)).toBeNull();
		expect((await broker.handleRequest("session.list", {})).ok).toBe(true);
		expect(
			await Promise.race([
				broker.completion.then(
					() => true,
					() => true,
				),
				Bun.sleep(20).then(() => false),
			]),
		).toBe(false);
		await broker.stop();
	});

	it("successor clears a predecessor's durable intent only by exact existing file identity", async () => {
		const { dir, broker, discovery } = await fixture();
		const prepared = await broker.prepareRestart({
			ownerId: discovery.ownerId,
			generation: discovery.packageGeneration,
			pid: discovery.pid,
			incarnation: discovery.incarnation,
			requestId: "successor",
			deadlineAt: Date.now() + 2_000,
		});
		expect(prepared.ok).toBe(true);
		const read = await readBrokerRestartIntent(dir);
		expect(read).not.toBeNull();
		if (!read) return;

		// A successor never itself prepared this slot; it only holds the existing
		// platform file identity it observed. A wrong identity must be refused.
		const successor = await publishBrokerDiscovery(dir, discovery);
		try {
			expect(
				await successor.clearForeignRestartIntent({ dev: read.identity.dev + 1n, ino: read.identity.ino }),
			).toBe(false);
			expect(await readBrokerRestartIntent(dir)).not.toBeNull();

			// The exact existing identity clears it.
			expect(await successor.clearForeignRestartIntent(read.identity)).toBe(true);
			expect(await readBrokerRestartIntent(dir)).toBeNull();
		} finally {
			successor.close();
		}
		await broker.stop();
	});

	it("a real successor Broker.start() clears the exact committed intent it was launched for, never a mismatched one", async () => {
		const { dir, broker, discovery } = await fixture();
		const requestId = "successor-start";
		const prepared = await broker.prepareRestart({
			ownerId: discovery.ownerId,
			generation: discovery.packageGeneration,
			pid: discovery.pid,
			incarnation: discovery.incarnation,
			requestId,
			deadlineAt: Date.now() + 5_000,
		});
		expect(prepared.ok).toBe(true);
		if (!prepared.ok) return;
		const lease = prepared.result as { lease: string; occupancyEpoch: number; expiresAt: number };
		const committed = await broker.commitRestart({
			ownerId: discovery.ownerId,
			generation: discovery.packageGeneration,
			pid: discovery.pid,
			incarnation: discovery.incarnation,
			requestId,
			deadlineAt: lease.expiresAt,
			lease: lease.lease,
			occupancyEpoch: lease.occupancyEpoch,
		});
		expect(committed.ok).toBe(true);
		await broker.completion;
		expect(await readBrokerExitRecord(dir)).toMatchObject({ mode: "owned-root", reason: "restart-committed" });
		expect((await readBrokerRestartIntent(dir))?.phase).toBe("committed");

		// A successor Broker whose settings carry a DIFFERENT restartRequestId must
		// never clear another request's committed intent.
		const mismatchedSuccessor = new Broker({ agentDir: dir, restartRequestId: "unrelated-request" });
		await mismatchedSuccessor.start();
		try {
			expect((await readBrokerRestartIntent(dir))?.requestId).toBe(requestId);
		} finally {
			await mismatchedSuccessor.stop();
		}

		// The exact authorized successor clears it only after its own publication
		// has proven ownership (Broker#start() has already returned).
		const successor = new Broker({ agentDir: dir, restartRequestId: requestId });
		await successor.start();
		try {
			expect(await readBrokerRestartIntent(dir)).toBeNull();
		} finally {
			await successor.stop();
		}
	});

	it("restartBrokerForDoctor reports owner_unavailable without throwing when no broker is published", async () => {
		const dir = await fs.mkdtemp(path.join(process.env.TMPDIR ?? "/tmp", "gjc-doctor-no-owner-"));
		const outcome = await restartBrokerForDoctor({ agentDir: dir, deadlineMs: 500 });
		expect(outcome.kind).toBe("owner_unavailable");
		if (outcome.kind === "owner_unavailable") expect(outcome.reason).toBe("no_discovery");
	});

	it("authorized successors honor the committed lease for long session-index transactions", async () => {
		const { dir, broker, discovery } = await fixture();
		const lockPath = path.join(dir, "sdk", "sessions", "index.jsonl.lock");
		const requestId = "doctor-long-index-lock";
		let successorPid: number | undefined;
		let cleanupFailed = false;
		let cleanupError: unknown;
		try {
			const prepared = await broker.prepareRestart({
				ownerId: discovery.ownerId,
				generation: discovery.packageGeneration,
				pid: discovery.pid,
				incarnation: discovery.incarnation,
				requestId,
				deadlineAt: Date.now() + 30_000,
			});
			expect(prepared.ok).toBe(true);
			if (!prepared.ok) return;
			const lease = prepared.result as { lease: string; occupancyEpoch: number; expiresAt: number };
			const committed = await broker.commitRestart({
				ownerId: discovery.ownerId,
				generation: discovery.packageGeneration,
				pid: discovery.pid,
				incarnation: discovery.incarnation,
				requestId,
				deadlineAt: lease.expiresAt,
				lease: lease.lease,
				occupancyEpoch: lease.occupancyEpoch,
			});
			expect(committed.ok).toBe(true);
			if (!committed.ok) return;
			await broker.completion;
			expect(await readBrokerRestartIntent(dir)).toMatchObject({ phase: "committed", requestId });

			await fs.mkdir(lockPath, { recursive: true });
			await fs.writeFile(
				path.join(lockPath, "info"),
				JSON.stringify({ pid: process.pid, timestamp: Date.now(), owner_token: "live-index-owner" }),
			);
			const successorAttempt = launchAuthorizedBrokerSuccessor({
				agentDir: dir,
				requestId,
				deadlineAt: lease.expiresAt,
				packageGeneration: discovery.packageGeneration,
			}).then(
				result => ({ kind: "result" as const, result }),
				error => ({ kind: "error" as const, error }),
			);
			await Bun.sleep(21_000);
			await fs.rm(lockPath, { recursive: true, force: true });
			const outcome = await successorAttempt;
			expect(outcome.kind).toBe("result");
			if (outcome.kind === "error") throw outcome.error;
			expect(outcome.result.kind).toBe("spawned");
			if (outcome.result.kind !== "spawned")
				throw new Error("Authorized successor was not spawned after the lock became available.");
			successorPid = outcome.result.discovery.pid;
			expect(outcome.result.discovery.restartRequestId).toBe(requestId);
			let retainedIntent = await readBrokerRestartIntent(dir);
			const clearDeadline = Date.now() + 2_000;
			while (retainedIntent !== null && Date.now() < clearDeadline) {
				await Bun.sleep(25);
				retainedIntent = await readBrokerRestartIntent(dir);
			}
			expect(retainedIntent).toBeNull();
		} finally {
			await fs.rm(lockPath, { recursive: true, force: true });
			const startupExit = await readBrokerStartupExitRecord(dir);
			successorPid ??= startupExit?.pid;
			if (successorPid !== undefined && !oldOwnerConfirmedExited(successorPid)) {
				try {
					process.kill(successorPid, "SIGTERM");
				} catch (error) {
					if ((error as NodeJS.ErrnoException).code !== "ESRCH") {
						cleanupFailed = true;
						cleanupError = error;
					}
				}
				const stopDeadline = Date.now() + 2_000;
				while (Date.now() < stopDeadline && !oldOwnerConfirmedExited(successorPid)) await Bun.sleep(25);
				if (!oldOwnerConfirmedExited(successorPid) && process.platform !== "win32") {
					process.kill(successorPid, "SIGKILL");
					const killDeadline = Date.now() + 1_000;
					while (Date.now() < killDeadline && !oldOwnerConfirmedExited(successorPid)) await Bun.sleep(25);
				}
			}
			await broker.stop();
			await fs.rm(dir, { recursive: true, force: true });
		}
		if (cleanupFailed) throw cleanupError;
	}, 45_000);

	it("restartBrokerForDoctor returns a busy owner's refusal as prepare_refused through the SDK client", async () => {
		const { dir, broker } = await fixture();
		await broker.index.append({
			type: "host_registered",
			sessionId: "attached-live",
			locator: { cwd: dir, worktreeRoot: null, stateRoot: path.join(dir, "state") },
			endpointGeneration: 1,
			pid: process.pid,
		});
		const outcome = await restartBrokerForDoctor({ agentDir: dir, deadlineMs: 1_000 });
		expect(outcome).toMatchObject({ kind: "prepare_refused", code: "restart_busy" });
		// Nothing was prepared: no durable intent, and new work is admitted again.
		expect(await readBrokerRestartIntent(dir)).toBeNull();
		expect((await broker.handleRequest("session.list", {})).ok).toBe(true);
		await broker.stop();
	});

	it("launchAuthorizedBrokerSuccessor refuses to spawn when no intent was ever committed for the request", async () => {
		const dir = await fs.mkdtemp(path.join(process.env.TMPDIR ?? "/tmp", "gjc-doctor-no-intent-"));
		const result = await launchAuthorizedBrokerSuccessor({
			agentDir: dir,
			requestId: "never-committed",
			deadlineAt: Date.now() + 500,
			packageGeneration: "test-generation",
		});
		expect(result.kind).toBe("refused");
		if (result.kind === "refused") expect(result.reason).toBe("intent_not_committed");
	});

	it("launchAuthorizedBrokerSuccessor maps a retained orphan transition to a startup-lock refusal", async () => {
		const dir = await fs.mkdtemp(path.join(process.env.TMPDIR ?? "/tmp", "gjc-doctor-orphan-lock-"));
		const transitionPath = path.join(dir, "sdk", "broker.startup.lock.removing");
		await fs.mkdir(transitionPath, { recursive: true });
		await fs.writeFile(
			path.join(transitionPath, "info"),
			JSON.stringify({ pid: 525_252, timestamp: Date.now() - 120_000, owner_token: "dead-owner" }),
		);
		FileLockTestHooks.nativeQuarantineBindings = () => ({
			snapshotDirectoryTree,
			exactRemoveDirectoryTree: () => ({ ok: false, code: "identity_mismatch" }) as NativeExactUnlinkResult,
		});
		const sleep = spyOn(Bun, "sleep").mockImplementation(async () => undefined);
		try {
			const result = await launchAuthorizedBrokerSuccessor({
				agentDir: dir,
				requestId: "retained-orphan-lock",
				deadlineAt: Date.now() + 30_000,
				packageGeneration: "test-generation",
			});
			expect(result).toMatchObject({ kind: "refused", reason: "startup_lock_unavailable" });
			if (result.kind === "refused") expect(result.detail).toContain("blocked by retained removal transition");
		} finally {
			sleep.mockRestore();
			FileLockTestHooks.nativeQuarantineBindings = undefined;
			await fs.rm(dir, { recursive: true, force: true });
		}
	});

	it("retry/successor race: adopting an already-prepared request replays the same lease instead of double-preparing", async () => {
		const { broker, discovery } = await fixture();
		const options = {
			ownerId: discovery.ownerId,
			generation: discovery.packageGeneration,
			pid: discovery.pid,
			incarnation: discovery.incarnation,
			requestId: "retry",
			deadlineAt: Date.now() + 2_000,
		};
		const first = await broker.prepareRestart(options);
		const second = await broker.prepareRestart(options);
		expect(first.ok).toBe(true);
		expect(second.ok).toBe(true);
		if (first.ok && second.ok) {
			const firstLease = (first.result as { lease: string }).lease;
			const secondLease = (second.result as { lease: string }).lease;
			expect(secondLease).toBe(firstLease);
		}
		expect((await broker.cancelRestart("retry")).ok).toBe(true);
		await broker.stop();
	});
});
