import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { daemonPaths } from "../src/sdk/bus/daemon-paths";
import type { TelegramDaemonFs } from "../src/sdk/bus/telegram-daemon";
import {
	type OrphanReapDecision,
	reapTelegramDaemonOrphans,
	type TelegramOrphanReapDeps,
	writeTelegramOrphanRecoveryReceipt,
} from "../src/sdk/bus/telegram-daemon-orphan-reap";
import { writeTelegramOwnerMarker } from "../src/sdk/bus/telegram-daemon-owner-registry";

function tempAgentDir(): string {
	return fs.mkdtempSync(path.join(os.tmpdir(), "gjc-4403-reap-"));
}

function digest(dir: string): string {
	const { agentDirDigest } = require("../src/sdk/bus/daemon-paths") as {
		agentDirDigest: (dir: string) => string;
	};
	return agentDirDigest(dir);
}

async function writeMarker(
	fsImpl: TelegramDaemonFs,
	agentDir: string,
	fields: {
		ownerId: string;
		acquisitionId: string;
		pid: number;
		incarnation: string;
	},
): Promise<void> {
	await writeTelegramOwnerMarker(fsImpl, agentDir, {
		version: 1,
		agentDir,
		agentDirDigest: digest(agentDir),
		createdAt: Date.now() - 60_000,
		startedAt: Date.now() - 60_000,
		...fields,
	} as never);
}

/** Build mock deps from an alive set. terminateTree kills by deleting from the set. */
function makeDeps(aliveSet: Set<number>): TelegramOrphanReapDeps {
	return {
		pidAlive: (pid: number) => aliveSet.has(pid),
		pidIncarnation: (pid: number) => (aliveSet.has(pid) ? `linux:${pid}` : undefined),
		processReference: (pid: number) =>
			aliveSet.has(pid)
				? {
						incarnation: `linux:${pid}`,
						terminateTree: () => {
							aliveSet.delete(pid);
							return true;
						},
					}
				: undefined,
		now: () => Date.now(),
	};
}

/**
 * Issue #4403 acceptance successor — full blocker matrix.
 */
describe("issue #4403 acceptance successor — reap safety matrix", () => {
	// ---- Blocker 1a: process-group cleanup (terminateTree, not signalRoot) ----
	test("process-group termination is requested via terminateTree", async () => {
		const agentDir = tempAgentDir();
		try {
			const fsImpl = fs.promises as unknown as TelegramDaemonFs;
			await fs.promises.mkdir(daemonPaths(agentDir).ownerRegistry, { recursive: true });
			const stalePid = 40001;
			await writeMarker(fsImpl, agentDir, {
				ownerId: "stale",
				acquisitionId: "stale-acq",
				pid: stalePid,
				incarnation: `linux:${stalePid}`,
			});
			const aliveSet = new Set([stalePid]);
			const deps = makeDeps(aliveSet);
			const { decisions } = await reapTelegramDaemonOrphans({
				agentDir,
				currentOwnerId: "cur",
				currentAcquisitionId: "cur-acq",
				currentPid: 99999,
				currentIncarnation: "linux:99999",
				fsImpl,
				deps,
			});
			expect(aliveSet.has(stalePid)).toBe(false);
			expect(decisions.some(d => d.kind === "reaped" && d.pid === stalePid)).toBe(true);
		} finally {
			fs.rmSync(agentDir, { recursive: true, force: true });
		}
	});

	// ---- Blocker 1b: PID-reuse race closure ----
	test("PID-reused marker (incarnation mismatch) is inert, never signaled", async () => {
		const agentDir = tempAgentDir();
		try {
			const fsImpl = fs.promises as unknown as TelegramDaemonFs;
			await fs.promises.mkdir(daemonPaths(agentDir).ownerRegistry, { recursive: true });
			const reusedPid = 40002;
			await writeMarker(fsImpl, agentDir, {
				ownerId: "reused",
				acquisitionId: "reused-acq",
				pid: reusedPid,
				incarnation: "linux:11111",
			});
			let terminateCalled = false;
			const { decisions } = await reapTelegramDaemonOrphans({
				agentDir,
				currentOwnerId: "cur",
				currentAcquisitionId: "cur-acq",
				currentPid: 99998,
				currentIncarnation: "linux:99998",
				fsImpl,
				deps: {
					pidAlive: () => true,
					pidIncarnation: () => "linux:99999",
					processReference: () => ({
						incarnation: "linux:99999",
						terminateTree: () => {
							terminateCalled = true;
							return true;
						},
					}),
					now: () => Date.now(),
				},
			});
			expect(terminateCalled).toBe(false);
			expect(decisions.find(d => d.acquisitionId === "reused-acq")?.kind).toBe("inert");
		} finally {
			fs.rmSync(agentDir, { recursive: true, force: true });
		}
	});

	// ---- Blocker 1c: zombie / dead process is inert without signaling ----
	test("dead/zombie PID is inert without any signaling attempt", async () => {
		const agentDir = tempAgentDir();
		try {
			const fsImpl = fs.promises as unknown as TelegramDaemonFs;
			await fs.promises.mkdir(daemonPaths(agentDir).ownerRegistry, { recursive: true });
			const deadPid = 40003;
			await writeMarker(fsImpl, agentDir, {
				ownerId: "dead",
				acquisitionId: "dead-acq",
				pid: deadPid,
				incarnation: `linux:${deadPid}`,
			});
			let terminateCalled = false;
			const { decisions } = await reapTelegramDaemonOrphans({
				agentDir,
				currentOwnerId: "cur",
				currentAcquisitionId: "cur-acq",
				currentPid: 99997,
				currentIncarnation: "linux:99997",
				fsImpl,
				deps: {
					pidAlive: (pid: number) => pid !== deadPid,
					pidIncarnation: () => `linux:${deadPid}`,
					processReference: () => ({
						incarnation: `linux:${deadPid}`,
						terminateTree: () => {
							terminateCalled = true;
							return true;
						},
					}),
					now: () => Date.now(),
				},
			});
			expect(terminateCalled).toBe(false);
			expect(decisions.find(d => d.acquisitionId === "dead-acq")?.kind).toBe("inert");
		} finally {
			fs.rmSync(agentDir, { recursive: true, force: true });
		}
	});

	// ---- Blocker 1d: bounded registry ----
	test("registry exceeding MAX_REAP_CANDIDATES is bounded and overflow is recorded", async () => {
		const agentDir = tempAgentDir();
		try {
			const fsImpl = fs.promises as unknown as TelegramDaemonFs;
			await fs.promises.mkdir(daemonPaths(agentDir).ownerRegistry, { recursive: true });
			const aliveSet = new Set<number>();
			for (let i = 0; i < 70; i++) {
				const pid = 50000 + i;
				aliveSet.add(pid);
				await writeMarker(fsImpl, agentDir, {
					ownerId: `stale-${i}`,
					acquisitionId: `stale-acq-${i}`,
					pid,
					incarnation: `linux:${pid}`,
				});
			}
			const { receipt } = await reapTelegramDaemonOrphans({
				agentDir,
				currentOwnerId: "cur",
				currentAcquisitionId: "cur-acq",
				currentPid: 99996,
				currentIncarnation: "linux:99996",
				fsImpl,
				deps: makeDeps(aliveSet),
			});
			expect(receipt.candidates).toBe(70);
			expect(receipt.reasons.registry_overflow).toBe(70);
			expect(receipt.terminated).toBeLessThanOrEqual(64);
		} finally {
			fs.rmSync(agentDir, { recursive: true, force: true });
		}
	});

	// ---- Blocker 1e: native signal failure fail-closed ----
	test("native signal failure (terminateTree returns false) is refused, not reaped", async () => {
		const agentDir = tempAgentDir();
		try {
			const fsImpl = fs.promises as unknown as TelegramDaemonFs;
			await fs.promises.mkdir(daemonPaths(agentDir).ownerRegistry, { recursive: true });
			const failPid = 40005;
			await writeMarker(fsImpl, agentDir, {
				ownerId: "fail",
				acquisitionId: "fail-acq",
				pid: failPid,
				incarnation: `linux:${failPid}`,
			});
			const { decisions, receipt } = await reapTelegramDaemonOrphans({
				agentDir,
				currentOwnerId: "cur",
				currentAcquisitionId: "cur-acq",
				currentPid: 99994,
				currentIncarnation: "linux:99994",
				fsImpl,
				deps: {
					pidAlive: () => true,
					pidIncarnation: () => `linux:${failPid}`,
					processReference: () => ({
						incarnation: `linux:${failPid}`,
						terminateTree: () => false,
					}),
					now: () => Date.now(),
				},
			});
			expect(decisions.find(d => d.acquisitionId === "fail-acq")?.kind).toBe("refused");
			expect((decisions.find(d => d.acquisitionId === "fail-acq") as { reason?: string })?.reason).toBe(
				"termination_failed",
			);
			expect(receipt.refused).toBe(1);
		} finally {
			fs.rmSync(agentDir, { recursive: true, force: true });
		}
	});

	// ---- Blocker 1f: self-fencing — current owner never reaped ----
	test("current owner is never terminated even if it appears in the registry", async () => {
		const agentDir = tempAgentDir();
		try {
			const fsImpl = fs.promises as unknown as TelegramDaemonFs;
			await fs.promises.mkdir(daemonPaths(agentDir).ownerRegistry, { recursive: true });
			const curPid = 40006;
			const curAcq = "cur-acq";
			const curInc = `linux:${curPid}`;
			await writeMarker(fsImpl, agentDir, {
				ownerId: "cur",
				acquisitionId: curAcq,
				pid: curPid,
				incarnation: curInc,
			});
			let terminateCalled = false;
			const { decisions } = await reapTelegramDaemonOrphans({
				agentDir,
				currentOwnerId: "cur",
				currentAcquisitionId: curAcq,
				currentPid: curPid,
				currentIncarnation: curInc,
				fsImpl,
				deps: {
					pidAlive: () => true,
					pidIncarnation: () => curInc,
					processReference: () => ({
						incarnation: curInc,
						terminateTree: () => {
							terminateCalled = true;
							return true;
						},
					}),
					now: () => Date.now(),
				},
			});
			expect(terminateCalled).toBe(false);
			expect(decisions.every(d => d.kind !== "reaped")).toBe(true);
		} finally {
			fs.rmSync(agentDir, { recursive: true, force: true });
		}
	});

	// ---- Blocker 1g: incarnation unavailable → fail closed ----
	test("incarnation unavailable on a live PID is refused (fail-closed)", async () => {
		const agentDir = tempAgentDir();
		try {
			const fsImpl = fs.promises as unknown as TelegramDaemonFs;
			await fs.promises.mkdir(daemonPaths(agentDir).ownerRegistry, { recursive: true });
			const unknownPid = 40007;
			await writeMarker(fsImpl, agentDir, {
				ownerId: "unknown",
				acquisitionId: "unknown-acq",
				pid: unknownPid,
				incarnation: `linux:${unknownPid}`,
			});
			const { decisions } = await reapTelegramDaemonOrphans({
				agentDir,
				currentOwnerId: "cur",
				currentAcquisitionId: "cur-acq",
				currentPid: 99993,
				currentIncarnation: "linux:99993",
				fsImpl,
				deps: {
					pidAlive: () => true,
					pidIncarnation: () => undefined,
					now: () => Date.now(),
				},
			});
			const d = decisions.find(d => d.acquisitionId === "unknown-acq") as { kind: string; reason?: string };
			expect(d?.kind).toBe("refused");
			expect(d?.reason).toBe("incarnation_unavailable");
		} finally {
			fs.rmSync(agentDir, { recursive: true, force: true });
		}
	});

	// ---- Blocker 1h: foreign agent-dir marker is never listed ----
	test("foreign agent-dir markers are not in the candidate list", async () => {
		const agentDir = tempAgentDir();
		const foreignDir = tempAgentDir();
		try {
			const fsImpl = fs.promises as unknown as TelegramDaemonFs;
			await fs.promises.mkdir(daemonPaths(agentDir).ownerRegistry, { recursive: true });
			await fs.promises.mkdir(daemonPaths(foreignDir).ownerRegistry, { recursive: true });
			await writeMarker(fsImpl, agentDir, {
				ownerId: "local",
				acquisitionId: "local-acq",
				pid: 40008,
				incarnation: "linux:40008",
			});
			await writeMarker(fsImpl, foreignDir, {
				ownerId: "foreign",
				acquisitionId: "foreign-acq",
				pid: 40009,
				incarnation: "linux:40009",
			});
			const { decisions } = await reapTelegramDaemonOrphans({
				agentDir,
				currentOwnerId: "cur",
				currentAcquisitionId: "cur-acq",
				currentPid: 99992,
				currentIncarnation: "linux:99992",
				fsImpl,
				deps: { pidAlive: () => true, pidIncarnation: () => "linux:40008", now: () => Date.now() },
			});
			expect(decisions.some(d => d.acquisitionId === "foreign-acq")).toBe(false);
		} finally {
			fs.rmSync(agentDir, { recursive: true, force: true });
			fs.rmSync(foreignDir, { recursive: true, force: true });
		}
	});

	// ---- Blocker 1i: malformed marker is refused ----
	test("malformed marker (bad JSON) is refused", async () => {
		const agentDir = tempAgentDir();
		try {
			const fsImpl = fs.promises as unknown as TelegramDaemonFs;
			const registry = daemonPaths(agentDir).ownerRegistry;
			await fs.promises.mkdir(registry, { recursive: true });
			await fs.promises.writeFile(path.join(registry, "malformed-acq.json"), "not-json{");
			const { decisions, receipt } = await reapTelegramDaemonOrphans({
				agentDir,
				currentOwnerId: "cur",
				currentAcquisitionId: "cur-acq",
				currentPid: 99991,
				currentIncarnation: "linux:99991",
				fsImpl,
				deps: { pidAlive: () => false, pidIncarnation: () => undefined, now: () => Date.now() },
			});
			const malformed = decisions.find(d => d.acquisitionId === "malformed-acq");
			expect(malformed?.kind).toBe("refused");
			expect(receipt.reasons.malformed_or_foreign).toBe(1);
		} finally {
			fs.rmSync(agentDir, { recursive: true, force: true });
		}
	});

	// ---- Receipt is bounded and secret-free ----
	test("recovery receipt is bounded and secret-free", async () => {
		const agentDir = tempAgentDir();
		try {
			const fsImpl = fs.promises as unknown as TelegramDaemonFs;
			const receipt = {
				version: 1 as const,
				agentDir,
				currentOwnerId: "cur",
				currentAcquisitionId: "cur-acq",
				currentPid: 1,
				createdAt: Date.now(),
				candidates: 2,
				terminated: 1,
				refused: 1,
				inert: 0,
				reasons: { malformed_or_foreign: 1 },
			};
			await writeTelegramOrphanRecoveryReceipt(fsImpl, agentDir, receipt);
			const raw = await fs.promises.readFile(daemonPaths(agentDir).recoveryReceipt, "utf8");
			expect(raw.length).toBeLessThan(4096);
			expect(raw).not.toContain("botToken");
			expect(raw).not.toContain("chatId");
		} finally {
			fs.rmSync(agentDir, { recursive: true, force: true });
		}
	});

	// ---- Concurrent startup: two reap calls converge safely ----
	test("two concurrent reap calls on the same registry converge safely", async () => {
		const agentDir = tempAgentDir();
		try {
			const fsImpl = fs.promises as unknown as TelegramDaemonFs;
			await fs.promises.mkdir(daemonPaths(agentDir).ownerRegistry, { recursive: true });
			const pids = [40010, 40011, 40012, 40013];
			const aliveSet = new Set(pids);
			for (const pid of pids) {
				await writeMarker(fsImpl, agentDir, {
					ownerId: `s-${pid}`,
					acquisitionId: `acq-${pid}`,
					pid,
					incarnation: `linux:${pid}`,
				});
			}
			const deps = makeDeps(aliveSet);
			const [r1, r2] = await Promise.all([
				reapTelegramDaemonOrphans({
					agentDir,
					currentOwnerId: "cur",
					currentAcquisitionId: "cur-acq",
					currentPid: 99990,
					currentIncarnation: "linux:99990",
					fsImpl,
					deps,
				}),
				reapTelegramDaemonOrphans({
					agentDir,
					currentOwnerId: "cur",
					currentAcquisitionId: "cur-acq",
					currentPid: 99990,
					currentIncarnation: "linux:99990",
					fsImpl,
					deps,
				}),
			]);
			// All pids eventually dead; markers removed by whichever call wins the race
			const allDecisions: OrphanReapDecision[] = [...r1.decisions, ...r2.decisions];
			// Every pid was either reaped or became inert (already removed by sibling)
			const accounted = allDecisions.filter(d => d.kind === "reaped" || d.kind === "inert" || d.kind === "refused");
			// No double-reaping: at most 4 "reaped" total (some may be inert/refused if sibling won)
			const reapedCount = allDecisions.filter(d => d.kind === "reaped").length;
			expect(reapedCount).toBeLessThanOrEqual(4);
			expect(accounted.length).toBeGreaterThanOrEqual(4);
			expect(aliveSet.size).toBe(0);
		} finally {
			fs.rmSync(agentDir, { recursive: true, force: true });
		}
	});

	// ---- Platform safety: process-group termination works without signalRoot ----
	test("platform safety: terminateTree works for darwin incarnation format", async () => {
		const agentDir = tempAgentDir();
		try {
			const fsImpl = fs.promises as unknown as TelegramDaemonFs;
			await fs.promises.mkdir(daemonPaths(agentDir).ownerRegistry, { recursive: true });
			const macPid = 40014;
			await writeMarker(fsImpl, agentDir, {
				ownerId: "mac",
				acquisitionId: "mac-acq",
				pid: macPid,
				incarnation: `darwin:${macPid}:123456`,
			});
			const aliveSet = new Set([macPid]);
			const { decisions } = await reapTelegramDaemonOrphans({
				agentDir,
				currentOwnerId: "cur",
				currentAcquisitionId: "cur-acq",
				currentPid: 99989,
				currentIncarnation: "linux:99989",
				fsImpl,
				deps: {
					pidAlive: (pid: number) => aliveSet.has(pid),
					pidIncarnation: (pid: number) => (aliveSet.has(pid) ? `darwin:${pid}:123456` : undefined),
					processReference: (pid: number) =>
						aliveSet.has(pid)
							? {
									incarnation: `darwin:${pid}:123456`,
									terminateTree: () => {
										aliveSet.delete(pid);
										return true;
									},
								}
							: undefined,
					platform: "darwin",
					now: () => Date.now(),
				},
			});
			expect(decisions.find(d => d.acquisitionId === "mac-acq")?.kind).toBe("reaped");
		} finally {
			fs.rmSync(agentDir, { recursive: true, force: true });
		}
	});

	// ---- TERM→KILL hung escalation ----
	test("hung process: TERM fails to kill, KILL escalates and succeeds", async () => {
		const agentDir = tempAgentDir();
		try {
			const fsImpl = fs.promises as unknown as TelegramDaemonFs;
			await fs.promises.mkdir(daemonPaths(agentDir).ownerRegistry, { recursive: true });
			const hungPid = 40004;
			await writeMarker(fsImpl, agentDir, {
				ownerId: "hung",
				acquisitionId: "hung-acq",
				pid: hungPid,
				incarnation: `linux:${hungPid}`,
			});
			let killedViaKill = false;
			const { decisions } = await reapTelegramDaemonOrphans({
				agentDir,
				currentOwnerId: "cur",
				currentAcquisitionId: "cur-acq",
				currentPid: 99995,
				currentIncarnation: "linux:99995",
				fsImpl,
				deps: {
					// Process ignores TERM (stays alive) until KILL is sent
					pidAlive: () => !killedViaKill,
					pidIncarnation: () => `linux:${hungPid}`,
					processReference: () => ({
						incarnation: `linux:${hungPid}`,
						terminateTree: (sig?: NodeJS.Signals) => {
							if (sig === "SIGKILL") {
								killedViaKill = true;
								return true;
							}
							return false; // TERM doesn't kill
						},
					}),
					// Use real clock so bounded wait runs
					now: () => Date.now(),
				},
			});
			expect(killedViaKill).toBe(true);
			expect(decisions.find(d => d.acquisitionId === "hung-acq")?.kind).toBe("reaped");
		} finally {
			fs.rmSync(agentDir, { recursive: true, force: true });
		}
	});
});
