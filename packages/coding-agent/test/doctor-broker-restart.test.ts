import { describe, expect, it, spyOn } from "bun:test";
import * as childProcess from "node:child_process";
import * as fs from "node:fs/promises";
import path from "node:path";
import { FILE_LOCK_ORPHAN_TRANSITION_ADOPTION_AGE_MS, FileLockAcquireError } from "../src/config/file-lock";
import { Broker } from "../src/sdk/broker/broker";
import { readBrokerExitRecord, readBrokerStartupExitRecord } from "../src/sdk/broker/broker-exit";
import { launchAuthorizedBrokerSuccessor, oldOwnerConfirmedExited } from "../src/sdk/broker/daemon-entry";
import type { BrokerDiscovery, BrokerRestartIntentWithIdentity } from "../src/sdk/broker/discovery";
import * as brokerDiscovery from "../src/sdk/broker/discovery";
import {
	brokerRestartIntentPath,
	publishBrokerDiscovery,
	readBrokerDiscovery,
	readBrokerRestartIntent,
} from "../src/sdk/broker/discovery";
import { restartBrokerForDoctor } from "../src/sdk/broker/doctor-restart";
import * as brokerEnsure from "../src/sdk/broker/ensure";
import { SessionIndex, sessionIndexStartupLockOptions } from "../src/sdk/broker/session-index";

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
		const leaseDurationMs = 2_000;
		const prepared = await broker.prepareRestart({
			...discovery,
			generation: discovery.packageGeneration,
			requestId: "lease-expiry",
			deadlineAt: Date.now() + leaseDurationMs,
		});
		expect(prepared.ok).toBe(true);
		expect(await readBrokerRestartIntent(dir)).not.toBeNull();

		await Bun.sleep(leaseDurationMs + 100);
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

		// A Broker with a different request ID must not publish into another
		// request's committed restart window.
		const mismatchedSuccessor = new Broker({ agentDir: dir, restartRequestId: "unrelated-request" });
		await expect(mismatchedSuccessor.start()).rejects.toThrow(
			"A committed SDK broker restart is active; startup requires its exact request ID.",
		);
		expect((await readBrokerRestartIntent(dir))?.requestId).toBe(requestId);
		expect(await readBrokerDiscovery(dir)).toBeNull();

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
			if (!outcome.result.discovery) throw new Error("Authorized successor discovery was not populated.");
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

	it("does not publish an authorized successor after a short committed lease expires", async () => {
		const { dir, broker, discovery } = await fixture();
		const lockPath = path.join(dir, "sdk", "sessions", "index.jsonl.lock");
		const requestId = "doctor-short-index-lock";
		let successorPid: number | undefined;
		let cleanupError: unknown;
		try {
			const prepared = await broker.prepareRestart({
				ownerId: discovery.ownerId,
				generation: discovery.packageGeneration,
				pid: discovery.pid,
				incarnation: discovery.incarnation,
				requestId,
				deadlineAt: Date.now() + 8_000,
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

			await fs.mkdir(lockPath, { recursive: true });
			await fs.writeFile(
				path.join(lockPath, "info"),
				JSON.stringify({ pid: process.pid, timestamp: Date.now(), owner_token: "live-short-index-owner" }),
			);
			const outcome = await launchAuthorizedBrokerSuccessor({
				agentDir: dir,
				requestId,
				deadlineAt: lease.expiresAt,
				packageGeneration: discovery.packageGeneration,
			});
			if (outcome.kind === "spawned") successorPid = outcome.realBrokerPid ?? outcome.discovery?.pid;
			expect(outcome.kind).toBe("refused");
			if (outcome.kind === "refused")
				expect(["spawn_exited_before_publication", "publication_timeout"]).toContain(outcome.reason);
			expect(Date.now()).toBeLessThanOrEqual(lease.expiresAt + 1_000);
			expect(await readBrokerDiscovery(dir)).toBeNull();
			expect(await readBrokerRestartIntent(dir)).toMatchObject({ phase: "committed", requestId });
		} finally {
			await fs.rm(lockPath, { recursive: true, force: true });
			const startupExit = await readBrokerStartupExitRecord(dir);
			successorPid ??= startupExit?.pid;
			if (successorPid !== undefined && !oldOwnerConfirmedExited(successorPid)) {
				try {
					process.kill(successorPid, "SIGTERM");
				} catch (error) {
					if ((error as NodeJS.ErrnoException).code !== "ESRCH") cleanupError = error;
				}
				const stopDeadline = Date.now() + 2_000;
				while (Date.now() < stopDeadline && !oldOwnerConfirmedExited(successorPid)) await Bun.sleep(25);
				if (!oldOwnerConfirmedExited(successorPid) && process.platform !== "win32") {
					try {
						process.kill(successorPid, "SIGKILL");
					} catch (error) {
						if ((error as NodeJS.ErrnoException).code !== "ESRCH") cleanupError = error;
					}
					const killDeadline = Date.now() + 1_000;
					while (Date.now() < killDeadline && !oldOwnerConfirmedExited(successorPid)) await Bun.sleep(25);
				}
			}
			await broker.stop();
			await fs.rm(dir, { recursive: true, force: true });
		}
		if (cleanupError !== undefined) throw cleanupError;
	}, 18_000);

	it("restartBrokerForDoctor refuses in attach-only mode and leaves the live owner untouched", async () => {
		const { dir, broker, discovery } = await fixture();
		const prior = process.env.GJC_SDK_BROKER_AUTOSTART;
		process.env.GJC_SDK_BROKER_AUTOSTART = "0";
		try {
			const outcome = await restartBrokerForDoctor({ agentDir: dir, requestId: "attach-only", deadlineMs: 1_000 });
			expect(outcome).toEqual({ kind: "attach_only_refused", reason: "supervisor_owned" });
			// No restart was prepared or committed: no durable intent, the same owner keeps serving.
			expect(await readBrokerRestartIntent(dir)).toBeNull();
			expect((await broker.handleRequest("session.list", {})).ok).toBe(true);
			expect(discovery.pid).toBe(process.pid);
		} finally {
			if (prior === undefined) delete process.env.GJC_SDK_BROKER_AUTOSTART;
			else process.env.GJC_SDK_BROKER_AUTOSTART = prior;
			await broker.stop();
		}
	});

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

	it("bounds restart intent reads by the successor deadline", async () => {
		const dir = await fs.mkdtemp(path.join(process.env.TMPDIR ?? "/tmp", "gjc-doctor-stalled-intent-"));
		const stalledRead = Promise.withResolvers<BrokerRestartIntentWithIdentity | null>();
		const readIntent = spyOn(brokerDiscovery, "readBrokerRestartIntent").mockImplementation(
			() => stalledRead.promise,
		);
		const startedAt = Date.now();
		try {
			const result = await launchAuthorizedBrokerSuccessor({
				agentDir: dir,
				requestId: "stalled-intent",
				deadlineAt: startedAt + 1_000,
				packageGeneration: "test-generation",
			});
			expect(result).toEqual({ kind: "refused", reason: "deadline_elapsed" });
			expect(Date.now() - startedAt).toBeLessThan(2_000);
			expect(readIntent).toHaveBeenCalledTimes(1);
		} finally {
			readIntent.mockRestore();
			stalledRead.resolve(null);
			await fs.rm(dir, { recursive: true, force: true });
		}
	}, 5_000);

	it("retries successor validation after an operation deadline while its lease remains", async () => {
		const { dir, broker, discovery } = await fixture();
		const requestId = "retry-successor-validation";
		const matchingDiscovery = { ...discovery, restartRequestId: requestId };
		let lockAttempts = 0;
		let discoveryReadAttempts = 0;
		const startupLock = spyOn(brokerEnsure, "withBrokerStartupLock").mockImplementation(
			async (_agentDir, operation) => {
				lockAttempts++;
				return operation(Date.now() + (lockAttempts === 1 ? 25 : 250));
			},
		);
		const discoveryRead = spyOn(brokerDiscovery, "readBrokerDiscovery").mockImplementation(async () => {
			discoveryReadAttempts++;
			if (discoveryReadAttempts === 1) {
				await Bun.sleep(75);
				return null;
			}
			return matchingDiscovery;
		});
		try {
			const result = await launchAuthorizedBrokerSuccessor({
				agentDir: dir,
				requestId,
				deadlineAt: Date.now() + 500,
				packageGeneration: discovery.packageGeneration,
			});
			expect(result).toEqual({ kind: "adopted", discovery: matchingDiscovery });
			expect(lockAttempts).toBe(2);
			expect(discoveryReadAttempts).toBe(2);
		} finally {
			discoveryRead.mockRestore();
			startupLock.mockRestore();
			await broker.stop();
			await fs.rm(dir, { recursive: true, force: true });
		}
	}, 5_000);

	it("bounds stalled successor discovery reads by the committed lease and reaps the child", async () => {
		const dir = await fs.mkdtemp(path.join(process.env.TMPDIR ?? "/tmp", "gjc-doctor-stalled-publication-"));
		const requestId = "stalled-successor-publication";
		const deadlineAt = Date.now() + 1_000;
		const stalledRead = Promise.withResolvers<BrokerDiscovery | null>();
		let discoveryReads = 0;
		let launcher: childProcess.ChildProcess | undefined;
		await fs.mkdir(path.join(dir, "sdk"), { recursive: true });
		await fs.writeFile(
			brokerRestartIntentPath(dir),
			JSON.stringify({ phase: "committed", requestId, expiresAt: deadlineAt, lease: "successor-lease" }),
		);
		const launchMode = spyOn(brokerEnsure, "resolveBrokerLaunchMode").mockReturnValue("posix-trampoline");
		const launch = spyOn(brokerEnsure, "launchBrokerViaPosixTrampoline").mockImplementation(async () => {
			launcher = childProcess.spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
			const pid = launcher.pid;
			if (pid === undefined) throw new Error("successor fixture did not start");
			const incarnation = brokerDiscovery.brokerProcessIncarnation(pid);
			if (incarnation === undefined) throw new Error("successor fixture incarnation is unavailable");
			return { process: launcher, realBrokerPid: pid, realBrokerIncarnation: incarnation, error: undefined };
		});
		const discoveryRead = spyOn(brokerDiscovery, "readBrokerDiscovery").mockImplementation(async () => {
			discoveryReads++;
			return discoveryReads === 1 ? null : await stalledRead.promise;
		});
		try {
			const result = await launchAuthorizedBrokerSuccessor({
				agentDir: dir,
				requestId,
				deadlineAt,
				packageGeneration: "test-generation",
			});
			expect(result).toMatchObject({ kind: "refused", reason: "publication_timeout" });
			expect(discoveryReads).toBe(2);
			expect(Date.now()).toBeLessThan(deadlineAt + 1_000);
			if (launcher?.pid !== undefined) expect(oldOwnerConfirmedExited(launcher.pid)).toBe(true);
		} finally {
			stalledRead.resolve(null);
			discoveryRead.mockRestore();
			launch.mockRestore();
			launchMode.mockRestore();
			if (launcher?.pid !== undefined && !oldOwnerConfirmedExited(launcher.pid)) launcher.kill("SIGKILL");
			await fs.rm(dir, { recursive: true, force: true });
		}
	}, 5_000);

	it("retries a retained startup transition and revalidates the committed successor", async () => {
		const dir = await fs.mkdtemp(path.join(process.env.TMPDIR ?? "/tmp", "gjc-doctor-orphan-lock-"));
		const requestId = "retained-orphan-lock";
		const expiresAt = Date.now() + 30_000;
		await fs.mkdir(path.join(dir, "sdk"), { recursive: true });
		await fs.writeFile(
			brokerRestartIntentPath(dir),
			JSON.stringify({ phase: "committed", requestId, expiresAt, lease: "successor-lease" }),
		);
		const broker = new Broker({ agentDir: dir, restartRequestId: requestId });
		const discovery = await broker.start();
		const transitionPath = path.join(dir, "sdk", "broker.startup.lock.removing");
		let attempts = 0;
		const lock = spyOn(brokerEnsure, "withBrokerStartupLock").mockImplementation(
			async (_agentDir, operation, lockOptions) => {
				attempts++;
				expect(lockOptions?.deadlineAt).toBe(expiresAt);
				if (attempts === 1)
					throw new FileLockAcquireError(
						path.join(dir, "sdk", "broker.startup"),
						`${path.join(dir, "sdk", "broker.startup")}.lock`,
						180,
						`orphan transition retained at ${transitionPath}`,
						"orphan_transition",
						transitionPath,
					);
				return await operation(Date.now() + 20_000);
			},
		);
		try {
			const result = await launchAuthorizedBrokerSuccessor({
				agentDir: dir,
				requestId,
				deadlineAt: expiresAt,
				packageGeneration: discovery.packageGeneration,
			});
			expect(attempts).toBe(2);
			expect(result).toMatchObject({
				kind: "adopted",
				discovery: { ownerId: discovery.ownerId, restartRequestId: requestId },
			});
		} finally {
			lock.mockRestore();
			await broker.stop();
			await fs.rm(dir, { recursive: true, force: true });
		}
	});

	it("stops retrying startup-lock acquisition at the committed deadline", async () => {
		const dir = await fs.mkdtemp(path.join(process.env.TMPDIR ?? "/tmp", "gjc-doctor-deadline-"));
		let now = Date.now();
		const deadlineAt = now + 100;
		const dateNow = spyOn(Date, "now").mockImplementation(() => now);
		const sleep = spyOn(Bun, "sleep").mockImplementation(async milliseconds => {
			now += typeof milliseconds === "number" ? milliseconds : Math.max(0, milliseconds.getTime() - now);
		});
		const lock = spyOn(brokerEnsure, "withBrokerStartupLock").mockRejectedValue(
			new FileLockAcquireError(
				path.join(dir, "sdk", "broker.startup"),
				`${path.join(dir, "sdk", "broker.startup")}.lock`,
				180,
				"orphan transition retained",
				"orphan_transition",
				path.join(dir, "sdk", "broker.startup.lock.removing"),
			),
		);
		try {
			const result = await launchAuthorizedBrokerSuccessor({
				agentDir: dir,
				requestId: "deadline-lock-retry",
				deadlineAt,
				packageGeneration: "test-generation",
			});
			expect(result).toMatchObject({
				kind: "refused",
				reason: "startup_lock_unavailable",
				detail: expect.stringContaining("blocked by retained removal transition"),
			});
			expect(lock).toHaveBeenCalledTimes(2);
			expect(now).toBe(deadlineAt);
		} finally {
			lock.mockRestore();
			sleep.mockRestore();
			dateNow.mockRestore();
			await fs.rm(dir, { recursive: true, force: true });
		}
	});

	it("clears an old lock refusal after reacquiring the startup fence", async () => {
		const dir = await fs.mkdtemp(path.join(process.env.TMPDIR ?? "/tmp", "gjc-doctor-reacquired-lock-"));
		let now = Date.now();
		const deadlineAt = now + 60;
		const dateNow = spyOn(Date, "now").mockImplementation(() => now);
		const sleep = spyOn(Bun, "sleep").mockImplementation(async milliseconds => {
			now += typeof milliseconds === "number" ? milliseconds : Math.max(0, milliseconds.getTime() - now);
		});
		let attempts = 0;
		const lock = spyOn(brokerEnsure, "withBrokerStartupLock").mockImplementation(async (_agentDir, operation) => {
			attempts++;
			if (attempts === 1)
				throw new FileLockAcquireError(
					path.join(dir, "sdk", "broker.startup"),
					`${path.join(dir, "sdk", "broker.startup")}.lock`,
					180,
					"startup lock was temporarily unavailable",
				);
			return await operation(Date.now() - 1);
		});
		try {
			const result = await launchAuthorizedBrokerSuccessor({
				agentDir: dir,
				requestId: "reacquired-lock-deadline",
				deadlineAt,
				packageGeneration: "test-generation",
			});
			expect(result).toMatchObject({ kind: "refused", reason: "deadline_elapsed" });
			expect(attempts).toBe(2);
			expect(now).toBe(deadlineAt);
		} finally {
			lock.mockRestore();
			sleep.mockRestore();
			dateNow.mockRestore();
			await fs.rm(dir, { recursive: true, force: true });
		}
	});

	it("accepts a published successor when handoff release completes after its deadline", async () => {
		const { dir, broker, discovery } = await fixture();
		const requestId = "late-handoff-release";
		let successorBroker: Broker | undefined;
		let launcher: childProcess.ChildProcess | undefined;
		const handoffReleaseStarted = Promise.withResolvers<void>();
		const handoffReleaseGate = Promise.withResolvers<void>();
		const launchMode = spyOn(brokerEnsure, "resolveBrokerLaunchMode").mockReturnValue("darwin-trampoline");
		const launch = spyOn(brokerEnsure, "launchBrokerViaPosixTrampoline").mockImplementation(
			async (agentDir, launchOptions) => {
				const successorRequestId = launchOptions.env.GJC_BROKER_RESTART_REQUEST;
				if (!successorRequestId) throw new Error("missing successor request id");
				successorBroker = new Broker({ agentDir, restartRequestId: successorRequestId });
				const successorDiscovery = await successorBroker.start();
				launcher = childProcess.spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
					stdio: "ignore",
				});
				return {
					process: launcher,
					realBrokerPid: successorDiscovery.pid,
					realBrokerIncarnation: successorDiscovery.incarnation,
					error: undefined,
					handoff: {
						release: async () => {
							handoffReleaseStarted.resolve();
							await handoffReleaseGate.promise;
						},
						terminate: async () => {
							handoffReleaseGate.resolve();
						},
					},
				};
			},
		);
		try {
			const prepared = await broker.prepareRestart({
				ownerId: discovery.ownerId,
				generation: discovery.packageGeneration,
				pid: discovery.pid,
				incarnation: discovery.incarnation,
				requestId,
				deadlineAt: Date.now() + 2_500,
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

			const resultTask = launchAuthorizedBrokerSuccessor({
				agentDir: dir,
				requestId,
				deadlineAt: lease.expiresAt,
				packageGeneration: discovery.packageGeneration,
			});
			await handoffReleaseStarted.promise;
			expect(Date.now()).toBeLessThan(lease.expiresAt);
			await Bun.sleep(Math.max(0, lease.expiresAt - Date.now() + 10));
			handoffReleaseGate.resolve();

			const result = await resultTask;
			expect(result).toMatchObject({
				kind: "spawned",
				discovery: { restartRequestId: requestId, packageGeneration: discovery.packageGeneration },
			});
			expect(Date.now()).toBeGreaterThanOrEqual(lease.expiresAt);
		} finally {
			handoffReleaseGate.resolve();
			launch.mockRestore();
			launchMode.mockRestore();
			if (successorBroker) await successorBroker.stop();
			if (launcher && launcher.exitCode === null && launcher.signalCode === null) {
				const exited = Promise.withResolvers<void>();
				launcher.once("exit", () => exited.resolve());
				launcher.kill("SIGTERM");
				await Promise.race([exited.promise, Bun.sleep(1_000)]);
				if (launcher.exitCode === null && launcher.signalCode === null) launcher.kill("SIGKILL");
			}
			await broker.stop();
			await fs.rm(dir, { recursive: true, force: true });
		}
	}, 10_000);

	it.skipIf(process.platform === "win32")(
		"ordinary session-index startup waits until a fresh removal transition is reclaimable",
		async () => {
			const dir = await fs.mkdtemp(path.join(process.env.TMPDIR ?? "/tmp", "gjc-doctor-fresh-index-transition-"));
			const indexPath = path.join(dir, "sdk", "sessions", "index.jsonl");
			const transitionPath = `${indexPath}.lock.removing`;
			await fs.mkdir(transitionPath, { recursive: true });
			const initialTime = Date.now();
			let now = initialTime;
			const dateNow = spyOn(Date, "now").mockImplementation(() => now);
			const sleep = spyOn(Bun, "sleep").mockImplementation(async milliseconds => {
				now += typeof milliseconds === "number" ? milliseconds : Math.max(0, milliseconds.getTime() - now);
			});
			try {
				const options = sessionIndexStartupLockOptions(performance.now() + 30_000, undefined, "ordinary");
				const index = await new SessionIndex(dir).open(options);
				expect(index.indexSeq).toBe(0);
				expect(now - initialTime).toBeGreaterThanOrEqual(FILE_LOCK_ORPHAN_TRANSITION_ADOPTION_AGE_MS);
				const transitionPresent = await fs.stat(transitionPath).then(
					() => true,
					error => {
						if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
						throw error;
					},
				);
				expect(transitionPresent).toBe(false);
			} finally {
				sleep.mockRestore();
				dateNow.mockRestore();
				await fs.rm(dir, { recursive: true, force: true });
			}
		},
	);

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
