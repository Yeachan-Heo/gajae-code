import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { Broker } from "../src/sdk/broker/broker";
import {
	releaseForcedStaleWorktreeForTest,
	setProcessIncarnationForTest,
	worktreeOccupantForTest,
} from "../src/sdk/broker/lifecycle";
import { type IndexedSession, SessionIndex } from "../src/sdk/broker/session-index";

const WORKTREE = "/repos/app.gajae-code-worktrees/main-0d6e4079";
const alive = () => "alive" as const;
const uncertain = () => "uncertain" as const;

// The helper only touches `broker.index` and reads incarnations through
// `processIncarnationForBroker`, which resolves the reader from a WeakMap keyed by
// the broker object. A plain `{ index }` stand-in registered with
// `setProcessIncarnationForTest` therefore exercises the real code path without
// standing up a full broker.
function fakeBroker(index: SessionIndex, incarnationReader: (pid: number) => string | undefined): Broker {
	const broker = { index } as unknown as Broker;
	setProcessIncarnationForTest(broker, incarnationReader);
	return broker;
}

const registration = (
	sessionId: string,
	stateRoot: string,
	overrides: {
		endpointGeneration: number;
		pid: number;
		incarnation: string;
		worktreeRoot?: string | null;
	},
) => ({
	type: "host_registered" as const,
	sessionId,
	locator: { cwd: WORKTREE, worktreeRoot: overrides.worktreeRoot ?? WORKTREE, stateRoot },
	endpointGeneration: overrides.endpointGeneration,
	pid: overrides.pid,
	processIncarnation: overrides.incarnation,
	hostIncarnation: overrides.incarnation,
});

const brokers: Broker[] = [];
const dirs: string[] = [];

async function scenario(): Promise<{ index: SessionIndex; stateRoot: string }> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-forced-stale-release-"));
	dirs.push(dir);
	return { index: new SessionIndex(dir), stateRoot: path.join(dir, "state") };
}

afterEach(async () => {
	for (const broker of brokers.splice(0)) setProcessIncarnationForTest(broker, undefined);
	await Promise.all(dirs.splice(0).map(dir => fs.rm(dir, { recursive: true, force: true })));
});

describe("forced stale-endpoint worktree release", () => {
	it("releases the worktree only when the captured stale identity is definitively exited", async () => {
		// The forced release fails closed on everything but a proven exit. A readable,
		// changed incarnation for the still-live pid resolves `exited`, so the terminal
		// claim is recorded and the worktree is freed.
		const { index, stateRoot } = await scenario();
		const broker = fakeBroker(index, () => "rotated-incarnation");
		brokers.push(broker);
		await index.append(
			registration("stale", stateRoot, {
				endpointGeneration: 7,
				pid: process.pid,
				incarnation: "stale-incarnation",
			}),
		);
		const expected = index.listSessions().sessions.find(session => session.sessionId === "stale") as IndexedSession;
		expect(worktreeOccupantForTest(index.listSessions().sessions, WORKTREE, uncertain)).toBe("stale");

		await releaseForcedStaleWorktreeForTest(broker, "stale", expected);

		const released = index.listSessions().sessions.find(session => session.sessionId === "stale");
		expect(released?.terminalUncertain).toBe(true);
		expect(released?.forcedStaleRelease).toBe(true);
		expect(worktreeOccupantForTest(index.listSessions().sessions, WORKTREE, uncertain)).toBeNull();
	});

	it("releases the worktree when the forced stale process state is uncertain (#5581)", async () => {
		// pid reuse makes the stale process read `uncertain` forever, so it can never be
		// proven exited. For a force-stopped stale endpoint, withholding the release then
		// leaves the row occupied indefinitely and refuses every follow-up delegate launch
		// into the same checkout. Record the terminal-uncertain claim and free the worktree;
		// the captured-identity guards keep a live successor from being caught by this.
		const { index, stateRoot } = await scenario();
		const broker = fakeBroker(index, () => undefined);
		brokers.push(broker);
		await index.append(
			registration("uncertain", stateRoot, {
				endpointGeneration: 7,
				pid: process.pid,
				incarnation: "stale-incarnation",
			}),
		);
		const expected = index
			.listSessions()
			.sessions.find(session => session.sessionId === "uncertain") as IndexedSession;

		await releaseForcedStaleWorktreeForTest(broker, "uncertain", expected);

		const released = index.listSessions().sessions.find(session => session.sessionId === "uncertain");
		expect(released?.terminalUncertain).toBe(true);
		expect(released?.forcedStaleRelease).toBe(true);
		expect(worktreeOccupantForTest(index.listSessions().sessions, WORKTREE, uncertain)).toBeNull();
	});

	it("keeps the worktree occupied for a fail-closed teardown that never proved the child gone", async () => {
		// `recordTerminalUncertain` writes the same lifecycle_terminal row shape at the
		// tail of an ordinary signal-escalated teardown, without the forced marker. That
		// process was SIGKILLed but never proven gone, so it may still be writing in the
		// checkout: only the forced stale release frees a worktree.
		const { index, stateRoot } = await scenario();
		await index.append(
			registration("fail-closed", stateRoot, {
				endpointGeneration: 4,
				pid: process.pid,
				incarnation: "teardown-incarnation",
			}),
		);
		await index.append({
			type: "lifecycle_terminal" as const,
			sessionId: "fail-closed",
			locator: { cwd: WORKTREE, worktreeRoot: WORKTREE, stateRoot },
			endpointGeneration: 4,
			pid: process.pid,
			processIncarnation: "teardown-incarnation",
			hostIncarnation: "teardown-incarnation",
			terminalUncertain: true,
		});

		const row = index.listSessions().sessions.find(session => session.sessionId === "fail-closed");
		expect(row?.terminalUncertain).toBe(true);
		expect(row?.forcedStaleRelease).toBeUndefined();
		expect(worktreeOccupantForTest(index.listSessions().sessions, WORKTREE, uncertain)).toBe("fail-closed");
	});

	it("does not claim terminal state when a successor rotated in under the same id", async () => {
		// Finding 1: the caller captured the old authority, but a successor incarnation
		// re-registered at a higher generation before the forced release ran. The
		// claim must be bound to the captured identity so the live successor — the
		// current row — is left untouched and keeps its worktree.
		const { index, stateRoot } = await scenario();
		const broker = fakeBroker(index, () => undefined);
		brokers.push(broker);
		await index.append(
			registration("rotated", stateRoot, {
				endpointGeneration: 7,
				pid: process.pid,
				incarnation: "stale-incarnation",
			}),
		);
		const captured = index.listSessions().sessions.find(session => session.sessionId === "rotated") as IndexedSession;
		await index.append(
			registration("rotated", stateRoot, {
				endpointGeneration: 8,
				pid: 999_001,
				incarnation: "successor-incarnation",
			}),
		);

		await releaseForcedStaleWorktreeForTest(broker, "rotated", captured);

		const successor = index.listSessions().sessions.find(session => session.sessionId === "rotated");
		expect(successor?.endpointGeneration).toBe(8);
		expect(successor?.terminalUncertain).toBeFalsy();
		expect(worktreeOccupantForTest(index.listSessions().sessions, WORKTREE, alive)).toBe("rotated");
	});

	it("keeps a live successor holding the worktree even if the old-generation claim lands during rotation", async () => {
		// Finding 2: the compare and append share one refresh boundary, but even a
		// terminal claim keyed to the OLD generation that races the successor's
		// registration cannot fence it — the successor's higher generation always
		// outranks the terminal row in the projection.
		const { index, stateRoot } = await scenario();
		await index.append(
			registration("racing", stateRoot, {
				endpointGeneration: 7,
				pid: process.pid,
				incarnation: "stale-incarnation",
			}),
		);
		await index.append(
			registration("racing", stateRoot, {
				endpointGeneration: 8,
				pid: 999_002,
				incarnation: "successor-incarnation",
			}),
		);
		// The forced claim lands for the stale generation the caller targeted.
		await index.append({
			type: "lifecycle_terminal" as const,
			sessionId: "racing",
			locator: { cwd: WORKTREE, worktreeRoot: WORKTREE, stateRoot },
			endpointGeneration: 7,
			pid: process.pid,
			processIncarnation: "stale-incarnation",
			hostIncarnation: "stale-incarnation",
			terminalUncertain: true,
		});

		const successor = index.listSessions().sessions.find(session => session.sessionId === "racing");
		expect(successor?.endpointGeneration).toBe(8);
		expect(successor?.terminalUncertain).toBeFalsy();
		expect(worktreeOccupantForTest(index.listSessions().sessions, WORKTREE, alive)).toBe("racing");
	});

	it("leaves an observably-alive owner's worktree occupied", async () => {
		// The forced-release contract still refuses to release a checkout whose owning
		// process is observably alive, even under force.
		const { index, stateRoot } = await scenario();
		const broker = fakeBroker(index, () => "live-incarnation");
		brokers.push(broker);
		await index.append(
			registration("live", stateRoot, { endpointGeneration: 3, pid: process.pid, incarnation: "live-incarnation" }),
		);
		const expected = index.listSessions().sessions.find(session => session.sessionId === "live") as IndexedSession;

		await releaseForcedStaleWorktreeForTest(broker, "live", expected);

		const owner = index.listSessions().sessions.find(session => session.sessionId === "live");
		expect(owner?.terminalUncertain).toBeFalsy();
		expect(worktreeOccupantForTest(index.listSessions().sessions, WORKTREE, uncertain)).toBe("live");
	});
});
