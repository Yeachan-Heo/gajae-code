/**
 * A daemon that dies must stop claiming to be ready.
 *
 * Ownership was only ever surrendered by `releaseDaemonOwnership`, which runs
 * after a fully quiesced, fully persisted shutdown. Observed in the field: a
 * daemon wrote one heartbeat 559 ms after readiness, died on an uncaught
 * topic-registry error, and eight hours later `ownershipPhase` was still
 * "ready" with the ownership lock held. Every reader that trusted that state
 * attached to a process that had not existed since the previous evening.
 *
 * These cases pin the fenced marker that records the death: it must be honest
 * about this owner, silent about anyone else's, and incapable of making a
 * dying process louder than it already is.
 */
import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { processIncarnation } from "../src/sdk/broker/process-incarnation";
import { daemonPaths, markDaemonOwnerStopped, readDaemonState } from "../src/sdk/bus/telegram-daemon";

function tempAgentDir(): string {
	return fs.mkdtempSync(path.join(os.tmpdir(), "gjc-tg-postmortem-"));
}

/**
 * Both functions under test take `Pick<Settings, "getAgentDir">`, so the whole
 * settings stack — and the native addon it loads — stays out of these cases.
 */
function settings(agentDir: string): { getAgentDir: () => string } {
	return { getAgentDir: () => agentDir };
}

const OWNER = "owner-a";
const PID = process.pid;

type Overrides = Record<string, unknown>;

/** A ready owner on disk, with the lock that makes it authoritative. */
function seedReadyOwner(agentDir: string, overrides: Overrides = {}): void {
	const paths = daemonPaths(agentDir);
	fs.mkdirSync(paths.dir, { recursive: true });
	const state = {
		pid: PID,
		incarnation: processIncarnation(PID),
		ownerId: OWNER,
		acquisitionId: OWNER,
		ownershipPhase: "ready",
		tokenFingerprint: "fp",
		chatId: "42",
		startedAt: 1_000,
		heartbeatAt: 1_500,
		roots: [],
		version: 1,
		generation: 7,
		servingEpoch: 1,
		...overrides,
	};
	fs.writeFileSync(paths.state, JSON.stringify(state));
	fs.writeFileSync(
		paths.lock,
		JSON.stringify({
			pid: state.pid,
			incarnation: state.incarnation,
			ownerId: state.ownerId,
			acquisitionId: state.acquisitionId,
			startedAt: state.startedAt,
		}),
	);
}

function mark(agentDir: string, input: Overrides = {}): Promise<boolean> {
	return markDaemonOwnerStopped({
		settings: settings(agentDir),
		ownerId: OWNER,
		acquisitionId: OWNER,
		pid: PID,
		now: () => 9_999,
		...input,
	});
}

describe("telegram daemon owner postmortem", () => {
	test("a dying owner records that it stopped", async () => {
		const agentDir = tempAgentDir();
		seedReadyOwner(agentDir);

		expect(await mark(agentDir)).toBe(true);

		const state = await readDaemonState(settings(agentDir));
		expect(state?.stoppedAt).toBe(9_999);
		// Freshness turns on stoppedAt, so this is the field that ends the lie.
		expect(state?.ownershipPhase).toBe("ready");
	});

	test("the ownership lock is left for the reclaim path to adjudicate", async () => {
		const agentDir = tempAgentDir();
		seedReadyOwner(agentDir);
		const paths = daemonPaths(agentDir);

		await mark(agentDir);

		// A corpse must not decide who owns the daemon next; unlinking here would
		// hand the lock to whoever raced in first.
		expect(fs.existsSync(paths.lock)).toBe(true);
	});

	test("a successor's state is never marked stopped", async () => {
		const agentDir = tempAgentDir();
		seedReadyOwner(agentDir, { ownerId: "owner-b", acquisitionId: "owner-b" });

		expect(await mark(agentDir)).toBe(false);
		expect((await readDaemonState(settings(agentDir)))?.stoppedAt).toBeUndefined();
	});

	test("a rebound pid does not let a dead owner mark a live one", async () => {
		const agentDir = tempAgentDir();
		seedReadyOwner(agentDir, { pid: PID + 1, incarnation: processIncarnation(PID + 1) });

		expect(await mark(agentDir)).toBe(false);
		expect((await readDaemonState(settings(agentDir)))?.stoppedAt).toBeUndefined();
	});

	test("a recycled pid with a different incarnation is refused", async () => {
		const agentDir = tempAgentDir();
		seedReadyOwner(agentDir, { incarnation: "linux:1" });

		expect(await mark(agentDir)).toBe(false);
		expect((await readDaemonState(settings(agentDir)))?.stoppedAt).toBeUndefined();
	});

	test("a generation this build does not serve is refused", async () => {
		const agentDir = tempAgentDir();
		seedReadyOwner(agentDir);

		expect(await mark(agentDir, { generation: 99 })).toBe(false);
		expect((await readDaemonState(settings(agentDir)))?.stoppedAt).toBeUndefined();
	});

	test("a lock that no longer matches the state means someone else moved on", async () => {
		const agentDir = tempAgentDir();
		seedReadyOwner(agentDir);
		const paths = daemonPaths(agentDir);
		fs.writeFileSync(
			paths.lock,
			JSON.stringify({ pid: PID, incarnation: processIncarnation(PID), ownerId: "owner-b", startedAt: 1_000 }),
		);

		expect(await mark(agentDir)).toBe(false);
		expect((await readDaemonState(settings(agentDir)))?.stoppedAt).toBeUndefined();
	});

	test("an already stopped owner is not restamped", async () => {
		const agentDir = tempAgentDir();
		seedReadyOwner(agentDir, { stoppedAt: 4_242 });

		expect(await mark(agentDir)).toBe(false);
		expect((await readDaemonState(settings(agentDir)))?.stoppedAt).toBe(4_242);
	});

	test("absent state is not resurrected as a stopped owner", async () => {
		const agentDir = tempAgentDir();
		fs.mkdirSync(daemonPaths(agentDir).dir, { recursive: true });

		expect(await mark(agentDir)).toBe(false);
		expect(fs.existsSync(daemonPaths(agentDir).state)).toBe(false);
	});

	test("unreadable state fails quietly rather than throwing out of a fatal handler", async () => {
		const agentDir = tempAgentDir();
		const paths = daemonPaths(agentDir);
		fs.mkdirSync(paths.dir, { recursive: true });
		fs.writeFileSync(paths.state, "{ not json");

		expect(await mark(agentDir)).toBe(false);
	});
});
