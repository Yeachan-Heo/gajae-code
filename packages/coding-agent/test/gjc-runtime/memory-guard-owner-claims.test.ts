import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { LinuxProcPidProbeResult } from "@gajae-code/coding-agent/gjc-runtime/linux-proc";
import {
	acquireMemoryGuardClaims,
	type MemoryGuardClaimOwner,
	type MemoryGuardOwnerClaimsDeps,
	probeMemoryGuardClaimsReleased,
	readMemoryGuardClaimsForTest,
	releaseMemoryGuardClaims,
} from "@gajae-code/coding-agent/gjc-runtime/memory-guard-owner-claims";

function owner(overrides: Partial<MemoryGuardClaimOwner> = {}): MemoryGuardClaimOwner {
	return {
		sessionId: "session-2681",
		generation: "generation-2681",
		runId: "run-2681",
		childToken: "child-2681",
		pid: 2681,
		processStartTime: "111",
		ttyDevice: "222",
		...overrides,
	};
}

function deps(results: Map<number, LinuxProcPidProbeResult>): MemoryGuardOwnerClaimsDeps {
	return {
		probePid: async pid => results.get(pid) ?? { kind: "absent" },
		now: () => "2026-07-23T00:00:00.000Z",
	};
}

async function tempStateDir(): Promise<string> {
	return fs.mkdtemp(path.join(os.tmpdir(), "gjc-memory-guard-claims-"));
}

describe("memory guard owner claims", () => {
	it("acquires writer then tty epochs and releases only the exact owner tuple", async () => {
		const stateDir = await tempStateDir();
		const claimOwner = owner();
		try {
			const lease = await acquireMemoryGuardClaims(
				stateDir,
				claimOwner,
				deps(
					new Map([
						[
							claimOwner.pid,
							{ kind: "live", startTime: claimOwner.processStartTime, ttyDevice: claimOwner.ttyDevice },
						],
					]),
				),
			);
			expect(lease.writerEpoch).toBe(1);
			expect(lease.ttyEpoch).toBe(2);
			const acquired = await readMemoryGuardClaimsForTest(stateDir, claimOwner.sessionId);
			expect(acquired.epoch).toBe(2);
			expect(acquired.claims.map(row => [row.resource, row.epoch])).toEqual([
				["tty", 2],
				["writer", 1],
			]);
			await expect(
				releaseMemoryGuardClaims(stateDir, { ...lease, writerEpoch: lease.writerEpoch + 10 }),
			).rejects.toThrow("memory_guard_claim_release_mismatch");
			const unchanged = await readMemoryGuardClaimsForTest(stateDir, claimOwner.sessionId);
			expect(unchanged.claims).toHaveLength(2);
			await releaseMemoryGuardClaims(stateDir, lease);
			const released = await readMemoryGuardClaimsForTest(stateDir, claimOwner.sessionId);
			expect(released.epoch).toBe(2);
			expect(released.claims).toHaveLength(0);
		} finally {
			await fs.rm(stateDir, { recursive: true, force: true });
		}
	});

	it("rejects live contention and reclaims only absent or reincarnated owners", async () => {
		const stateDir = await tempStateDir();
		const incumbent = owner();
		const challenger = owner({ childToken: "child-2682", pid: 2682, processStartTime: "333" });
		try {
			const incumbentDeps = deps(
				new Map([
					[incumbent.pid, { kind: "live", startTime: incumbent.processStartTime, ttyDevice: incumbent.ttyDevice }],
				]),
			);
			const incumbentLease = await acquireMemoryGuardClaims(stateDir, incumbent, incumbentDeps);
			const liveDeps = deps(
				new Map([
					[incumbent.pid, { kind: "live", startTime: incumbent.processStartTime, ttyDevice: incumbent.ttyDevice }],
					[
						challenger.pid,
						{ kind: "live", startTime: challenger.processStartTime, ttyDevice: challenger.ttyDevice },
					],
				]),
			);
			await expect(acquireMemoryGuardClaims(stateDir, challenger, liveDeps)).rejects.toThrow(
				"memory_guard_claim_live_contention:",
			);
			await releaseMemoryGuardClaims(stateDir, incumbentLease);
			await acquireMemoryGuardClaims(
				stateDir,
				incumbent,
				deps(
					new Map([
						[
							incumbent.pid,
							{ kind: "live", startTime: incumbent.processStartTime, ttyDevice: incumbent.ttyDevice },
						],
					]),
				),
			);
			const reclaimed = await acquireMemoryGuardClaims(
				stateDir,
				challenger,
				deps(
					new Map([
						[incumbent.pid, { kind: "live", startTime: "999", ttyDevice: incumbent.ttyDevice }],
						[
							challenger.pid,
							{ kind: "live", startTime: challenger.processStartTime, ttyDevice: challenger.ttyDevice },
						],
					]),
				),
			);
			expect(reclaimed.writerEpoch).toBe(5);
			expect(reclaimed.ttyEpoch).toBe(6);
			const snapshot = await readMemoryGuardClaimsForTest(stateDir, challenger.sessionId);
			expect(snapshot.epoch).toBe(6);
			expect(snapshot.claims.every(row => row.child_token === challenger.childToken)).toBe(true);
		} finally {
			await fs.rm(stateDir, { recursive: true, force: true });
		}
	});

	it("fails closed when an existing owner cannot be verified", async () => {
		const stateDir = await tempStateDir();
		const incumbent = owner();
		const challenger = owner({ childToken: "child-2682", pid: 2682, processStartTime: "333" });
		try {
			await acquireMemoryGuardClaims(
				stateDir,
				incumbent,
				deps(
					new Map([
						[
							incumbent.pid,
							{ kind: "live", startTime: incumbent.processStartTime, ttyDevice: incumbent.ttyDevice },
						],
					]),
				),
			);
			await expect(
				acquireMemoryGuardClaims(
					stateDir,
					challenger,
					deps(
						new Map([
							[incumbent.pid, { kind: "unverifiable", reason: "permission_denied" }],
							[
								challenger.pid,
								{ kind: "live", startTime: challenger.processStartTime, ttyDevice: challenger.ttyDevice },
							],
						]),
					),
				),
			).rejects.toThrow("memory_guard_claim_existing_owner_unverifiable:permission_denied");
		} finally {
			await fs.rm(stateDir, { recursive: true, force: true });
		}
	});

	it("proves claims released by fencing epochs and exact-releasing them", async () => {
		const stateDir = await tempStateDir();
		const probeOwner = owner({ childToken: "probe-2681", pid: 3000, processStartTime: "444", ttyDevice: "555" });
		const staleOwner = owner({ childToken: "stale-2681", pid: 4000, processStartTime: "666" });
		try {
			await acquireMemoryGuardClaims(
				stateDir,
				staleOwner,
				deps(
					new Map([
						[
							staleOwner.pid,
							{ kind: "live", startTime: staleOwner.processStartTime, ttyDevice: staleOwner.ttyDevice },
						],
					]),
				),
			);
			const proof = await probeMemoryGuardClaimsReleased(
				stateDir,
				probeOwner,
				deps(
					new Map([
						[staleOwner.pid, { kind: "absent" }],
						[
							probeOwner.pid,
							{ kind: "live", startTime: probeOwner.processStartTime, ttyDevice: probeOwner.ttyDevice },
						],
					]),
				),
			);
			expect(proof.writerEpoch).toBe(3);
			expect(proof.ttyEpoch).toBe(4);
			const snapshot = await readMemoryGuardClaimsForTest(stateDir, probeOwner.sessionId);
			expect(snapshot.epoch).toBe(4);
			expect(snapshot.claims).toHaveLength(0);
		} finally {
			await fs.rm(stateDir, { recursive: true, force: true });
		}
	});
});
