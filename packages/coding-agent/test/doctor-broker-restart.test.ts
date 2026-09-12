import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import path from "node:path";
import { Broker } from "../src/sdk/broker/broker";
import { launchAuthorizedBrokerSuccessor } from "../src/sdk/broker/daemon-entry";
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
