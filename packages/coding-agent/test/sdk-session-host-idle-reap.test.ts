import { expect, test, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { logger } from "@gajae-code/utils";
import { watchSessionHostClientAttachment } from "../src/commands/sdk";
import {
	publishSessionHostRuntimeEvidence,
	reapDeadSessionRegistrations,
	sessionHostAttachedClients,
	sessionHostWorkInFlight,
} from "../src/sdk/broker/lifecycle";
import { SessionIndex } from "../src/sdk/broker/session-index";

const HALT = "halt-attachment-watch";

/**
 * Drives the watcher until it either resolves or the fake clock has advanced
 * past `polls` iterations. Returns "reaped" only when the watcher decided the
 * host is abandoned.
 */
async function runUntilStable(
	deps: Parameters<typeof watchSessionHostClientAttachment>[0] & { sleep?: never },
	polls: number,
	clock: { nowMs: number },
): Promise<"reaped" | "still-running"> {
	let seen = 0;
	try {
		await watchSessionHostClientAttachment({
			...deps,
			now: () => clock.nowMs,
			sleep: async ms => {
				clock.nowMs += ms;
				seen += 1;
				if (seen >= polls) throw new Error(HALT);
			},
		});
		return "reaped";
	} catch (error) {
		if (error instanceof Error && error.message === HALT) return "still-running";
		throw error;
	}
}

test("a session host is reaped only after its last client has stayed detached for the full idle grace", async () => {
	let nowMs = 0;
	// One attached observation, two detached polls, a reattachment that resets
	// the window, then three detached polls whose last crosses the 20ms grace.
	const observations = [1, 0, 0, 1, 0, 0, 0];
	let reads = 0;
	await watchSessionHostClientAttachment({
		readAttachedClients: () => {
			const observed = observations[reads] ?? 0;
			reads += 1;
			return observed;
		},
		now: () => nowMs,
		sleep: async ms => {
			nowMs += ms;
		},
		idleGraceMs: 20,
		firstAttachGraceMs: 1_000,
		pollMs: 10,
	});
	expect(reads).toBe(7);
	expect(nowMs).toBe(60);
});

test("a session host with an attached client is never reaped, however long it runs", async () => {
	const clock = { nowMs: 0 };
	const outcome = await runUntilStable(
		{ readAttachedClients: () => 1, idleGraceMs: 20, firstAttachGraceMs: 40, pollMs: 10 },
		500,
		clock,
	);
	expect(outcome).toBe("still-running");
	// 500 polls is 250x the idle grace and 125x the first-attach grace.
	expect(clock.nowMs).toBe(5_000);
});

test("a freshly spawned session host is held by the longer first-attach grace, not the idle grace", async () => {
	let nowMs = 0;
	let reads = 0;
	await watchSessionHostClientAttachment({
		readAttachedClients: () => {
			reads += 1;
			return 0;
		},
		now: () => nowMs,
		sleep: async ms => {
			nowMs += ms;
		},
		idleGraceMs: 20,
		firstAttachGraceMs: 40,
		pollMs: 10,
	});
	// Reaping at 20ms would mean the idle grace was wrongly applied to a host
	// that never saw a client; only the 40ms first-attach grace may end it.
	expect(nowMs).toBe(40);
	expect(reads).toBe(5);
});

test("missing endpoint evidence is not detachment for a host that has already served a client", async () => {
	const clock = { nowMs: 0 };
	let reads = 0;
	const outcome = await runUntilStable(
		{
			readAttachedClients: () => {
				reads += 1;
				return reads === 1 ? 1 : undefined;
			},
			idleGraceMs: 20,
			firstAttachGraceMs: 40,
			pollMs: 10,
		},
		200,
		clock,
	);
	expect(outcome).toBe("still-running");
	expect(clock.nowMs).toBe(2_000);
});

test("a host whose SDK endpoint never publishes attachment evidence still exits at the first-attach bound", async () => {
	let nowMs = 0;
	await watchSessionHostClientAttachment({
		readAttachedClients: () => undefined,
		now: () => nowMs,
		sleep: async ms => {
			nowMs += ms;
		},
		idleGraceMs: 20,
		firstAttachGraceMs: 40,
		pollMs: 10,
	});
	expect(nowMs).toBe(40);
});

test("a host with clients attached but never observed attached is not reaped while work is in flight", async () => {
	const clock = { nowMs: 0 };
	// The client connected, prompted and dropped its socket between two polls, so
	// the count is never observed above zero — but the turn it asked for is running.
	const outcome = await runUntilStable(
		{
			readAttachedClients: () => undefined,
			readWorkInFlight: () => true,
			idleGraceMs: 20,
			firstAttachGraceMs: 40,
			pollMs: 10,
		},
		200,
		clock,
	);
	expect(outcome).toBe("still-running");
	expect(clock.nowMs).toBe(2_000);
});

test("work in flight defers the first-attach bound to the end of the work, it does not remove it", async () => {
	let nowMs = 0;
	await watchSessionHostClientAttachment({
		readAttachedClients: () => undefined,
		readWorkInFlight: () => nowMs < 20,
		now: () => nowMs,
		sleep: async ms => {
			nowMs += ms;
		},
		idleGraceMs: 20,
		firstAttachGraceMs: 40,
		pollMs: 10,
	});
	// Last work seen at 10ms; the full first-attach grace runs from there, not from start.
	expect(nowMs).toBe(50);
});

test("a host whose SDK runtime never came up reports no work and still exits at the first-attach bound", async () => {
	let nowMs = 0;
	await watchSessionHostClientAttachment({
		readAttachedClients: () => undefined,
		readWorkInFlight: () => false,
		now: () => nowMs,
		sleep: async ms => {
			nowMs += ms;
		},
		idleGraceMs: 20,
		firstAttachGraceMs: 40,
		pollMs: 10,
	});
	expect(nowMs).toBe(40);
});

test("published runtime evidence is the host's own client count and work, and retracts to no-evidence", () => {
	// Shard peers may legitimately hold their own publications; every assertion is
	// relative to that baseline, since a foreign publication is exactly what the
	// identity-scoped registry must leave untouched.
	const baseClients = sessionHostAttachedClients();
	const baseWork = sessionHostWorkInFlight();
	let clients = 3;
	let busy = false;
	const publication = publishSessionHostRuntimeEvidence({
		attachedClients: () => clients,
		workInFlight: () => busy,
	});
	try {
		expect(sessionHostAttachedClients()).toBe((baseClients ?? 0) + 3);
		expect(sessionHostWorkInFlight()).toBe(baseWork || false);
		clients = 0;
		busy = true;
		expect(sessionHostAttachedClients()).toBe((baseClients ?? 0) + 0);
		expect(sessionHostWorkInFlight()).toBe(true);
	} finally {
		publication.retract();
	}
	expect(sessionHostAttachedClients()).toEqual(baseClients);
	expect(sessionHostWorkInFlight()).toBe(baseWork);
	// Retraction is idempotent and still owns nothing else.
	publication.retract();
	expect(sessionHostAttachedClients()).toEqual(baseClients);
});

test("a retracting runtime cannot clear the evidence of the runtime that succeeded it", () => {
	const baseClients = sessionHostAttachedClients();
	const predecessor = publishSessionHostRuntimeEvidence({
		attachedClients: () => 2,
		workInFlight: () => false,
	});
	const successor = publishSessionHostRuntimeEvidence({
		attachedClients: () => 1,
		workInFlight: () => true,
	});
	try {
		expect(sessionHostAttachedClients()).toBe((baseClients ?? 0) + 3);
		// The predecessor's deferred teardown runs late, while the successor serves.
		predecessor.retract();
		expect(sessionHostAttachedClients()).toBe((baseClients ?? 0) + 1);
		expect(sessionHostWorkInFlight()).toBe(true);
		predecessor.retract();
		expect(sessionHostAttachedClients()).toBe((baseClients ?? 0) + 1);
	} finally {
		successor.retract();
	}
	expect(sessionHostAttachedClients()).toEqual(baseClients);
});

test("a reader that fails is no evidence, and never fakes attachment or work for a sibling", () => {
	const baseClients = sessionHostAttachedClients();
	const baseWork = sessionHostWorkInFlight();
	const broken = publishSessionHostRuntimeEvidence({
		attachedClients: () => {
			throw new Error("native server is gone");
		},
		workInFlight: () => {
			throw new Error("native server is gone");
		},
	});
	try {
		expect(sessionHostAttachedClients()).toEqual(baseClients);
		expect(sessionHostWorkInFlight()).toBe(baseWork);
		const healthy = publishSessionHostRuntimeEvidence({
			attachedClients: () => 4,
			workInFlight: () => true,
		});
		try {
			expect(sessionHostAttachedClients()).toBe((baseClients ?? 0) + 4);
			expect(sessionHostWorkInFlight()).toBe(true);
		} finally {
			healthy.retract();
		}
	} finally {
		broken.retract();
	}
	expect(sessionHostAttachedClients()).toEqual(baseClients);
});

test("the broker drops registrations whose host process is gone, keeps live ones, and logs each reap", async () => {
	const agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-host-reap-"));
	// A pid beyond any platform's allocation range: process.kill must report ESRCH.
	const deadPid = 4_194_304;
	expect(() => process.kill(deadPid, 0)).toThrow();
	const warn = vi.spyOn(logger, "warn").mockImplementation(() => {});
	try {
		const index = await new SessionIndex(agentDir).open();
		const locator = { repo: agentDir, stateRoot: agentDir };
		await index.append({
			type: "host_registered",
			sessionId: "live",
			locator,
			endpointGeneration: 1,
			pid: process.pid,
		});
		await index.append({
			type: "host_registered",
			sessionId: "leaked",
			locator,
			endpointGeneration: 2,
			pid: deadPid,
			lifecycleRequestId: "request-leaked",
		});
		await index.append({
			type: "lifecycle_terminal",
			sessionId: "uncertain",
			locator,
			endpointGeneration: 3,
			pid: deadPid,
			terminalUncertain: true,
		});

		const reaped = await reapDeadSessionRegistrations({ index });
		expect(reaped).toEqual([{ sessionId: "leaked", pid: deadPid, endpointGeneration: 2 }]);
		expect(
			index
				.listSessions()
				.sessions.map(session => session.sessionId)
				.sort(),
		).toEqual(["live", "uncertain"]);
		expect(warn.mock.calls.filter(call => String(call[0]).includes("reaped a session registration")).length).toBe(1);

		// A second sweep has nothing left to prove gone.
		expect(await reapDeadSessionRegistrations({ index })).toEqual([]);
		expect(
			index
				.listSessions()
				.sessions.map(session => session.sessionId)
				.sort(),
		).toEqual(["live", "uncertain"]);
	} finally {
		warn.mockRestore();
		await fs.rm(agentDir, { recursive: true, force: true });
	}
});
