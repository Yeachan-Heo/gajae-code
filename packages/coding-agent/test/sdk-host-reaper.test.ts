import { describe, expect, it } from "bun:test";
import {
	isLauncherAlive,
	type LauncherProbe,
	parseLauncherIdentity,
	shouldReclaimHost,
} from "@gajae-code/coding-agent/sdk/bus";

const INCARNATION = "darwin:1785086779:411797";
const OTHER_INCARNATION = "darwin:1785099999:222222";

function request(identity: unknown): string {
	return JSON.stringify({ launcherIdentity: identity });
}

/** A launcher that exists and still reports the incarnation the initiator recorded. */
function livingLauncher(incarnation: string = INCARNATION): LauncherProbe {
	return { signal: () => {}, incarnation: () => incarnation };
}

/** A launcher whose process is gone: signalling it throws ESRCH. */
function deadLauncher(): LauncherProbe {
	return {
		signal: () => {
			const error = new Error("no such process") as NodeJS.ErrnoException;
			error.code = "ESRCH";
			throw error;
		},
		incarnation: () => undefined,
	};
}

const RECLAIMABLE = {
	launcherAlive: false,
	negotiatedConnections: 0,
	handshakingConnections: 0,
	busy: false,
	pendingPrompts: 0,
	unusedSince: 1_000,
	now: 1_000 + 30 * 60_000,
	idleReapMs: 30 * 60_000,
} as const;

describe("session host launcher identity", () => {
	it("reads a well-formed identity out of the lifecycle request", () => {
		expect(parseLauncherIdentity(request({ pid: 4242, incarnation: INCARNATION }))).toEqual({
			pid: 4242,
			incarnation: INCARNATION,
		});
	});

	// Anything malformed must degrade to "unknown", which fails open below. A partially
	// trusted identity would be worse than none: it could point at the wrong process.
	it.each([
		["absent request", undefined],
		["unparseable json", "{"],
		["no identity field", JSON.stringify({})],
		["missing incarnation", request({ pid: 4242 })],
		["missing pid", request({ incarnation: INCARNATION })],
		["zero pid", request({ pid: 0, incarnation: INCARNATION })],
		["negative pid", request({ pid: -1, incarnation: INCARNATION })],
		["fractional pid", request({ pid: 1.5, incarnation: INCARNATION })],
		["string pid", request({ pid: "4242", incarnation: INCARNATION })],
		["empty incarnation", request({ pid: 4242, incarnation: "" })],
	])("returns undefined for %s", (_label, value) => {
		expect(parseLauncherIdentity(value)).toBeUndefined();
	});

	// The reaper only ever trusts the per-request identity. A detached broker can carry a
	// stale ambient GJC_SDK_CLIENT_PID belonging to an unrelated client, and honouring it
	// would point the host at the wrong process.
	it("ignores an ambient client pid that is not part of the request", () => {
		expect(parseLauncherIdentity(JSON.stringify({ clientPid: 4242 }))).toBeUndefined();
	});

	it("reports a launcher alive while its pid still holds the recorded incarnation", () => {
		expect(isLauncherAlive({ pid: 4242, incarnation: INCARNATION }, livingLauncher())).toBe(true);
	});

	it("reports a launcher dead once its process is gone", () => {
		expect(isLauncherAlive({ pid: 4242, incarnation: INCARNATION }, deadLauncher())).toBe(false);
	});

	// The whole reason identity is a tuple: the pid is signalable again because the OS
	// recycled it, but it is a different process, so the original client is gone.
	it("treats a reused pid as dead even though signalling it succeeds", () => {
		expect(isLauncherAlive({ pid: 4242, incarnation: INCARNATION }, livingLauncher(OTHER_INCARNATION))).toBe(false);
	});

	it("treats an unreadable incarnation on a live pid as dead", () => {
		expect(
			isLauncherAlive({ pid: 4242, incarnation: INCARNATION }, { signal: () => {}, incarnation: () => undefined }),
		).toBe(false);
	});

	// EPERM means the pid exists but belongs to another user, so it is alive.
	it("treats EPERM as alive", () => {
		const probe: LauncherProbe = {
			signal: () => {
				const error = new Error("operation not permitted") as NodeJS.ErrnoException;
				error.code = "EPERM";
				throw error;
			},
			incarnation: () => undefined,
		};
		expect(isLauncherAlive({ pid: 4242, incarnation: INCARNATION }, probe)).toBe(true);
	});

	// Fail-open is deliberate: leaking a host is recoverable, reclaiming a live session is not.
	it("fails open when the identity is unknown", () => {
		expect(isLauncherAlive(undefined, deadLauncher())).toBe(true);
	});
});

describe("session host reclaim decision", () => {
	it("reclaims once the launcher is gone, nothing is connected, and the grace elapsed", () => {
		expect(shouldReclaimHost(RECLAIMABLE)).toBe(true);
	});

	it("never reclaims while the launcher is alive", () => {
		expect(shouldReclaimHost({ ...RECLAIMABLE, launcherAlive: true })).toBe(false);
	});

	it("never reclaims while a client is negotiated, even with a dead launcher", () => {
		expect(shouldReclaimHost({ ...RECLAIMABLE, negotiatedConnections: 1 })).toBe(false);
	});

	// The grace-boundary race: a reconnecting client has a socket but has not yet
	// negotiated capabilities. Counting only negotiated connections would reap it
	// mid-handshake.
	it("never reclaims while a client is still handshaking", () => {
		expect(shouldReclaimHost({ ...RECLAIMABLE, handshakingConnections: 1 })).toBe(false);
	});

	it("never reclaims while a turn is running", () => {
		expect(shouldReclaimHost({ ...RECLAIMABLE, busy: true })).toBe(false);
	});

	it("never reclaims while a prompt correlation is pending", () => {
		expect(shouldReclaimHost({ ...RECLAIMABLE, pendingPrompts: 1 })).toBe(false);
	});

	it("never reclaims before the idle grace has elapsed", () => {
		expect(shouldReclaimHost({ ...RECLAIMABLE, now: RECLAIMABLE.unusedSince + 30 * 60_000 - 1 })).toBe(false);
	});

	it("never reclaims a host that was never observed unused", () => {
		expect(shouldReclaimHost({ ...RECLAIMABLE, unusedSince: undefined })).toBe(false);
	});
});
