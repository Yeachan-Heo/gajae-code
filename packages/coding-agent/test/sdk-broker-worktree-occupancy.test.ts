import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { reserveLaunchWorktreeForTest } from "../src/commands/launch";
import {
	type LaunchWorktreeReservation,
	launchWorktreeReservationDirectoryForTest,
	releaseLaunchWorktreeReservationAfterRegistration,
} from "../src/gjc-runtime/launch-worktree-reservation";
import { lifecycleTargetForTest } from "../src/sdk/broker/broker";
import { worktreeOccupantForTest } from "../src/sdk/broker/lifecycle";
import { type IndexedSession, SessionIndex } from "../src/sdk/broker/session-index";

const WORKTREE = "/repos/app.gajae-code-worktrees/main-0d6e4079";
const OTHER_WORKTREE = "/repos/app.gajae-code-worktrees/task-b-1a2b3c4d";

function session(
	overrides: Partial<IndexedSession> & { sessionId: string; repo: string; worktreeRoot?: string | null },
): IndexedSession {
	const { repo, worktreeRoot = repo, ...rest } = overrides;
	return {
		locator: { cwd: repo, worktreeRoot, stateRoot: `${repo}/.gjc/state` },
		endpointGeneration: 1,
		pid: 4242,
		live: true,
		indexSeq: 1,
		identityProvenance: "composite",
		ambiguous: false,
		terminal: false,
		...rest,
	};
}

const alive = () => "alive" as const;
const exited = () => "exited" as const;
const uncertain = () => "uncertain" as const;

describe("worktree occupancy", () => {
	it("serializes same-worktree lifecycle launches together", () => {
		const source = "/repos/app";
		expect(lifecycleTargetForTest("session.create", { cwd: source, worktree: { name: "same-worktree" } })).toEqual(
			lifecycleTargetForTest("session.create", { cwd: source, worktree: { name: "same-worktree" } }),
		);
		expect(
			lifecycleTargetForTest("session.create", { cwd: source, worktree: { name: "same-worktree" } }),
		).not.toEqual(lifecycleTargetForTest("session.create", { cwd: source, worktree: { name: "other-worktree" } }));
	});

	it("reports the live session holding the worktree", () => {
		const sessions = [session({ sessionId: "holder", repo: WORKTREE })];

		expect(worktreeOccupantForTest(sessions, WORKTREE, alive)).toBe("holder");
	});

	it("ignores sessions in a different worktree", () => {
		const sessions = [session({ sessionId: "elsewhere", repo: OTHER_WORKTREE })];

		expect(worktreeOccupantForTest(sessions, WORKTREE, alive)).toBeNull();
	});

	it("matches worktrees that differ only by path spelling", () => {
		const sessions = [
			session({
				sessionId: "holder",
				repo: `${WORKTREE}/nested/..`,
				worktreeRoot: `${WORKTREE}/../${path.basename(WORKTREE)}`,
			}),
		];

		expect(worktreeOccupantForTest(sessions, WORKTREE, alive)).toBe("holder");
	});

	it("matches a session whose cwd is nested below its canonical worktree root", () => {
		const sessions = [
			session({ sessionId: "holder", repo: `${WORKTREE}/packages/coding-agent`, worktreeRoot: WORKTREE }),
		];

		expect(worktreeOccupantForTest(sessions, WORKTREE, alive)).toBe("holder");
	});

	it("matches an existing worktree through a symlink alias", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-worktree-occupancy-"));
		const worktree = path.join(root, "worktree");
		const alias = path.join(root, "worktree-alias");
		try {
			await fs.mkdir(worktree);
			await fs.symlink(worktree, alias);
			expect(worktreeOccupantForTest([session({ sessionId: "holder", repo: alias })], worktree, alive)).toBe(
				"holder",
			);
		} finally {
			await fs.rm(root, { recursive: true, force: true });
		}
	});

	it("uses the host incarnation when probing a composite holder", () => {
		const holder = session({
			sessionId: "holder",
			repo: WORKTREE,
			processIncarnation: "process-incarnation",
			hostIncarnation: "host-incarnation",
		});
		const observed: string[] = [];

		expect(
			worktreeOccupantForTest([holder], WORKTREE, (_pid, incarnation) => {
				if (incarnation) observed.push(incarnation);
				return "alive";
			}),
		).toBe("holder");
		expect(observed).toEqual(["host-incarnation"]);
	});

	it("releases the worktree once the owning process has exited", () => {
		// This is the common case: a crashed or killed session must not park the
		// worktree forever, which is why liveness is observed and not assumed.
		const sessions = [session({ sessionId: "crashed", repo: WORKTREE })];

		expect(worktreeOccupantForTest(sessions, WORKTREE, exited)).toBeNull();
	});

	it("releases the worktree when the recorded process incarnation has changed", () => {
		const holder = session({
			sessionId: "reused-pid",
			repo: WORKTREE,
			processIncarnation: "old-process-incarnation",
		});
		const observed: Array<{ pid: number; incarnation: string | undefined }> = [];

		expect(
			worktreeOccupantForTest([holder], WORKTREE, (pid, incarnation) => {
				observed.push({ pid, incarnation });
				return "exited";
			}),
		).toBeNull();
		expect(observed).toEqual([{ pid: 4242, incarnation: "old-process-incarnation" }]);
	});

	it("treats an unverifiable process as still holding the worktree", () => {
		// Refusing a launch is recoverable by choosing another worktree name;
		// two live sessions sharing one checkout corrupts work already done.
		const sessions = [session({ sessionId: "unverifiable", repo: WORKTREE })];

		expect(worktreeOccupantForTest(sessions, WORKTREE, uncertain)).toBe("unverifiable");
	});

	it("keeps a stale-heartbeat session occupied while its process is still alive", () => {
		const stale = session({ sessionId: "stale-heartbeat", repo: WORKTREE, live: false });

		expect(worktreeOccupantForTest([stale], WORKTREE, alive)).toBe("stale-heartbeat");
	});

	it("ignores terminal and non-worktree rows", () => {
		const sessions = [
			session({ sessionId: "terminal", repo: WORKTREE, terminal: true }),
			session({ sessionId: "not-a-worktree", repo: WORKTREE, worktreeRoot: null }),
		];

		expect(worktreeOccupantForTest(sessions, WORKTREE, alive)).toBeNull();
	});

	it("finds the holder after positively exited stale rows", () => {
		const sessions = [
			session({ sessionId: "stale-1", repo: WORKTREE, live: false }),
			session({ sessionId: "stale-2", repo: WORKTREE, terminal: true }),
			session({ sessionId: "holder", repo: WORKTREE, pid: 4343 }),
		];

		expect(worktreeOccupantForTest(sessions, WORKTREE, pid => (pid === 4242 ? "exited" : "alive"))).toBe("holder");
	});
});

describe("launch worktree reservation", () => {
	it("allows exactly one overlapping preflight for a deterministic worktree path", async () => {
		const agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-launch-worktree-reservation-"));
		const worktreePath = path.join(agentDir, "worktree");
		let winner: LaunchWorktreeReservation | undefined;
		try {
			const results = await Promise.allSettled([
				reserveLaunchWorktreeForTest(agentDir, worktreePath),
				reserveLaunchWorktreeForTest(agentDir, worktreePath),
			]);
			const fulfilled = results.filter(
				(result): result is PromiseFulfilledResult<LaunchWorktreeReservation> => result.status === "fulfilled",
			);
			const rejected = results.filter(result => result.status === "rejected");

			expect(fulfilled).toHaveLength(1);
			expect(rejected).toHaveLength(1);
			winner = fulfilled[0]?.value;
			if (!winner) throw new Error("Expected one worktree reservation winner.");
			const loser = rejected[0];
			if (!loser || loser.status !== "rejected") throw new Error("Expected one worktree reservation loser.");
			const message = loser.reason instanceof Error ? loser.reason.message : String(loser.reason);
			expect(message).toStartWith(`worktree_in_use:${worktreePath}`);
		} finally {
			await winner?.release();
			await fs.rm(agentDir, { recursive: true, force: true });
		}
	});

	it("releases the reservation once the launched host is registered", async () => {
		const agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-launch-worktree-registered-reservation-"));
		const targetRoot = path.join(agentDir, "target");
		const aliasRoot = path.join(agentDir, "alias");
		const worktreePath = path.join(aliasRoot, "worktree");
		const registeredWorktreePath = path.join(targetRoot, "worktree");
		const lockInfo = path.join(launchWorktreeReservationDirectoryForTest(agentDir, worktreePath), "info");
		let reservation: LaunchWorktreeReservation | undefined;
		try {
			await fs.mkdir(targetRoot);
			await fs.symlink(targetRoot, aliasRoot, process.platform === "win32" ? "junction" : "dir");
			reservation = await reserveLaunchWorktreeForTest(agentDir, worktreePath);
			await fs.mkdir(registeredWorktreePath);
			await new SessionIndex(agentDir).append({
				type: "host_registered",
				sessionId: "launch-holder",
				locator: {
					cwd: registeredWorktreePath,
					worktreeRoot: registeredWorktreePath,
					stateRoot: path.join(agentDir, "state"),
				},
				endpointGeneration: 1,
				pid: process.pid,
			});
			await releaseLaunchWorktreeReservationAfterRegistration(agentDir, registeredWorktreePath);

			expect(await Bun.file(lockInfo).exists()).toBe(false);
		} finally {
			await reservation?.release();
			await fs.rm(agentDir, { recursive: true, force: true });
		}
	});

	it("reclaims a reservation whose owner pid has exited", async () => {
		const agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-launch-worktree-stale-reservation-"));
		const worktreePath = path.join(agentDir, "worktree");
		const lockDir = launchWorktreeReservationDirectoryForTest(agentDir, worktreePath);
		try {
			await fs.mkdir(lockDir, { recursive: true, mode: 0o700 });
			await Bun.write(
				path.join(lockDir, "info"),
				JSON.stringify({
					version: 1,
					worktreePath,
					pid: 525_252,
					start_time: "dead-owner",
					processIncarnation: "dead-owner",
					timestamp: Date.now(),
					reservationId: "stale-reservation",
				}),
			);

			const reservation = await reserveLaunchWorktreeForTest(agentDir, worktreePath);
			expect(await Bun.file(path.join(lockDir, "info")).exists()).toBe(true);
			await reservation.release();
			expect(await Bun.file(path.join(lockDir, "info")).exists()).toBe(false);
		} finally {
			await fs.rm(agentDir, { recursive: true, force: true });
		}
	});
});
