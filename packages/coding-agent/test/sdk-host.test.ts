import { describe, expect, test } from "bun:test";
import fc from "fast-check";
import { FileLockAcquireError } from "../src/config/file-lock";
import { type EventReplayGap, SessionEventStream, SessionSdkHost, shouldHostSdk } from "../src/sdk/host";
import { RESPONSE_CEILING_BYTES } from "../src/sdk/host/query/handlers";

describe("session SDK event stream", () => {
	test("replays retained events and emits a resync gap for lagged subscribers", () => {
		const stream = new SessionEventStream({ ringSize: 2, resyncQueryIds: ["Q01"] });
		stream.emit({ name: "one" });
		stream.emit({ name: "two" });
		stream.emit({ name: "three" });
		const replay = stream.replay(0);
		expect(replay.events.map(frame => frame.seq)).toEqual([2, 3]);
		expect(replay.gap).toEqual({ kind: "sequence_gap", fromSeq: 1, toSeq: 1, resyncQueries: ["Q01"] });
		stream.restart();
		expect(stream.generation).toBe(1);
		expect(stream.replay(3, 0)).toEqual({
			events: [],
			gap: { kind: "generation_reset", fromGeneration: 0, toGeneration: 1, resyncQueries: ["Q01"] },
		});
	});
});

describe("SessionSdkHost", () => {
	// The notifications bus delivers awaiting_input live-only and never retains it;
	// this pins the host gate so a retained one could still not leak to clients
	// that lack the dedicated capability.
	test("a retained awaiting_input event requires its own capability rather than tool activity or frame claims", async () => {
		let receive!: (connectionId: string, frame: Record<string, unknown>) => void;
		const sent: Array<{ connectionId: string; frame: Record<string, unknown> }> = [];
		const host = new SessionSdkHost({
			sessionId: "awaiting-capabilities",
			stateRoot: "/tmp/awaiting-capabilities",
			token: "token",
			connectionCapabilities: connectionId =>
				connectionId === "awaiting" ? new Set(["awaiting_input_v1"]) : new Set(["tool_activity_v2"]),
			sendFrame: (connectionId, frame) => {
				sent.push({ connectionId, frame });
				return "written";
			},
			onFrame: handler => {
				receive = handler;
				return () => {};
			},
		});
		await host.start();
		try {
			host.emitEvent({ kind: "awaiting_input", payload: { type: "awaiting_input", toolCallId: "call-1" } });
			host.emitEvent({ kind: "tool_activity", payload: { type: "tool_activity" } });
			receive("awaiting", { type: "event_replay", id: "awaiting", sinceSeq: 0, capabilities: [] });
			await Bun.sleep(0);
			expect((sent.at(-1)!.frame.events as Array<{ kind: string }>).slice(1).map(event => event.kind)).toEqual([
				"awaiting_input",
			]);
			receive("tool-only", {
				type: "event_replay",
				id: "tool-only",
				sinceSeq: 0,
				capabilities: ["awaiting_input_v1"],
			});
			await Bun.sleep(0);
			expect((sent.at(-1)!.frame.events as Array<{ kind: string }>).slice(1).map(event => event.kind)).toEqual([
				"tool_activity",
			]);
		} finally {
			await host.stop();
		}
	});

	test("replay authorization uses negotiated connection capabilities, not frame claims", async () => {
		let receive!: (connectionId: string, frame: Record<string, unknown>) => void;
		const sent: Array<{ connectionId: string; frame: Record<string, unknown> }> = [];
		const host = new SessionSdkHost({
			sessionId: "replay-capabilities",
			stateRoot: "/tmp/replay-capabilities",
			token: "token",
			connectionCapabilities: connectionId =>
				connectionId === "authorized"
					? new Set(["tool_activity_v2"])
					: connectionId === "initial"
						? undefined
						: new Set(),
			sendFrame: (connectionId, frame) => {
				sent.push({ connectionId, frame });
				return "written";
			},
			onFrame: handler => {
				receive = handler;
				return () => {};
			},
		});
		await host.start();
		host.emitEvent({ kind: "tool_activity" });
		host.emitEvent({ kind: "reasoning_summary" });
		host.emitEvent({ kind: "activity" });

		receive("forged", {
			type: "event_replay",
			id: "forged",
			sinceSeq: 0,
			capabilities: ["tool_activity_v1"],
		});
		await new Promise(resolve => setTimeout(resolve, 0));
		expect((sent.at(-1)!.frame.events as Array<{ kind: string }>).slice(1).map(event => event.kind)).toEqual([
			"activity",
		]);

		receive("authorized", { type: "event_replay", id: "authorized", sinceSeq: 0, capabilities: [] });
		await new Promise(resolve => setTimeout(resolve, 0));
		expect((sent.at(-1)!.frame.events as Array<{ kind: string }>).slice(1).map(event => event.kind)).toEqual([
			"tool_activity",
			"reasoning_summary",
			"activity",
		]);

		receive("initial", {
			type: "event_replay",
			id: "initial",
			sinceSeq: 0,
			capabilities: ["tool_activity_v1"],
		});
		await new Promise(resolve => setTimeout(resolve, 0));
		expect((sent.at(-1)!.frame.events as Array<{ kind: string }>).slice(1).map(event => event.kind)).toEqual([
			"activity",
		]);
		await host.stop();
	});

	test("lifecycle is idempotent and registers with the broker", async () => {
		let handler: ((connectionId: string, frame: Record<string, unknown>) => void) | undefined;
		const registered: number[] = [];
		let issued = 0;
		const host = new SessionSdkHost({
			sessionId: "s",
			stateRoot: "/tmp/s",
			token: "t",
			allocateEventGeneration: async (_sessionId, floor) => (issued = Math.max(issued + 1, floor)),
			sendFrame: () => {
				return "written";
			},
			onFrame: value => {
				handler = value;
				return () => {
					handler = undefined;
				};
			},
		});
		await host.registerWithBroker({
			register: ({ endpointGeneration }) => {
				registered.push(endpointGeneration);
			},
		});
		expect(await host.start()).toBe("started");
		expect(await host.start()).toBe("already");
		const firstGeneration = host.generation;
		expect(firstGeneration).toBe(issued);
		expect(registered).toEqual([firstGeneration]);
		expect(handler).toBeDefined();
		expect(await host.stop()).toBe("stopped");
		expect(await host.stop()).toBe("already");
		expect(await host.start()).toBe("started");
		expect(host.generation).toBeGreaterThan(firstGeneration);
		expect(host.generation).toBe(issued);
		expect(registered).toEqual([firstGeneration, host.generation]);
	});

	test("a recreated host takes its event namespace from the generation authority", async () => {
		let issued = 0;
		const createHost = () =>
			new SessionSdkHost({
				sessionId: "resumed",
				stateRoot: "/tmp/resumed",
				token: "t",
				allocateEventGeneration: async (_sessionId, floor) => (issued = Math.max(issued + 1, floor)),
				sendFrame: () => "written",
				onFrame: () => () => {},
			});
		const first = createHost();
		await first.start();
		expect(first.generation).toBe(issued);
		const firstEvent = first.emitEvent({ kind: "notice", payload: { type: "notice", message: "first" } });
		await first.stop();
		const resumed = createHost();
		await resumed.start();
		expect(resumed.generation).toBe(issued);
		const resumedEvent = resumed.emitEvent({ kind: "notice", payload: { type: "notice", message: "resumed" } });
		// Each process restarts its sequence, so only the generation keeps the
		// resumed host's (generation, seq) coordinates apart from the closed host's.
		expect(resumedEvent.seq).toBe(firstEvent.seq);
		expect(firstEvent.generation).toBe(first.generation);
		expect(resumedEvent.generation).toBeGreaterThan(firstEvent.generation);
		expect(resumedEvent.generation).toBe(resumed.generation);
		await resumed.stop();

		// Without an authority the generation only advances inside the host's own stream.
		const local = new SessionSdkHost({
			sessionId: "local",
			stateRoot: "/tmp/local",
			token: "t",
			sendFrame: () => "written",
			onFrame: () => () => {},
		});
		await local.start();
		expect(local.generation).toBe(1);
		await local.stop();
		await local.start();
		expect(local.generation).toBe(2);
		await local.stop();
	});

	test("an unreserved generation serves locally and is published only once the authority reserves it", async () => {
		const floors: number[] = [];
		let authority: (floor: number) => number = () => {
			throw new Error("generation authority unavailable");
		};
		const registered: number[] = [];
		const host = new SessionSdkHost({
			sessionId: "unreserved",
			stateRoot: "/tmp/unreserved",
			token: "t",
			allocateEventGeneration: async (_sessionId, floor) => {
				floors.push(floor);
				return authority(floor);
			},
			sendFrame: () => "written",
			onFrame: () => () => {},
		});
		const before = Date.now();
		expect(await host.start()).toBe("started");
		const generation = host.generation;
		expect(generation).toBeGreaterThanOrEqual(before);
		expect(host.events.replay(0).events).toMatchObject([{ name: "session_ready", generation }]);

		const writer = {
			register: ({ endpointGeneration }: { endpointGeneration: number }) => void registered.push(endpointGeneration),
		};
		await expect(host.registerWithBroker(writer)).rejects.toThrow("generation authority unavailable");
		// The authority already issued this generation to another host.
		authority = floor => floor + 1;
		await expect(host.registerWithBroker(writer)).rejects.toThrow(
			`SDK event generation ${generation} was superseded by ${generation + 1}`,
		);
		expect(registered).toEqual([]);

		authority = floor => floor;
		await host.registerWithBroker(writer);
		await host.registerWithBroker(writer);
		expect(registered).toEqual([generation, generation]);
		// Start floors are wall time; reservations ask for exactly the served generation, once.
		expect(floors.slice(1)).toEqual([generation, generation, generation]);
		await host.stop();
	});

	test("concurrent starts share one allocation and a stop during allocation stops that start", async () => {
		const allocation = Promise.withResolvers<number>();
		let allocations = 0;
		let allocationFloor = 0;
		const registered: number[] = [];
		const unregistered: number[] = [];
		const host = new SessionSdkHost({
			sessionId: "pending-allocation",
			stateRoot: "/tmp/pending-allocation",
			token: "t",
			allocateEventGeneration: (_sessionId, floor) => {
				allocations++;
				allocationFloor = floor;
				return allocation.promise;
			},
			sendFrame: () => "written",
			onFrame: () => () => {},
		});
		await host.registerWithBroker({
			register: ({ endpointGeneration }) => void registered.push(endpointGeneration),
			unregister: ({ endpointGeneration }) => void unregistered.push(endpointGeneration),
		});
		const first = host.start();
		const second = host.start();
		const stopped = host.stop();
		allocation.resolve(allocationFloor);
		expect(await first).toBe("started");
		expect(await second).toBe("already");
		expect(await stopped).toBe("stopped");
		expect(allocations).toBe(1);
		expect(registered).toEqual([allocationFloor]);
		expect(unregistered).toEqual([allocationFloor]);
		expect(host.started).toBe(false);
	});

	test("reports the idle host state and only records activity transitions", async () => {
		const activity: Array<{ state: "active" | "idle"; at: number }> = [];
		const host = new SessionSdkHost({
			sessionId: "activity",
			stateRoot: "/tmp/activity",
			token: "t",
			sendFrame: () => "written",
			onFrame: () => () => {},
		});
		await host.start();
		await host.registerWithBroker({
			register: () => {},
			heartbeat: input => {
				activity.push(input.activity);
			},
		});
		await Bun.sleep(0);
		await host.reportActivity("active", 100);
		await host.reportActivity("active", 200);
		await host.reportActivity("idle", 300);
		await host.stop();

		expect(activity).toEqual([
			{ state: "idle", at: expect.any(Number) },
			{ state: "active", at: 100 },
			{ state: "idle", at: 300 },
		]);
	});

	test("serializes a held active report before the successor idle transition", async () => {
		const activity: Array<{ state: "active" | "idle"; at: number }> = [];
		const activeStarted = Promise.withResolvers<void>();
		const releaseActive = Promise.withResolvers<void>();
		let holdActive = true;
		const host = new SessionSdkHost({
			sessionId: "activity-active-idle",
			stateRoot: "/tmp/activity-active-idle",
			token: "t",
			sendFrame: () => "written",
			onFrame: () => () => {},
		});
		await host.registerWithBroker({
			register: () => {},
			heartbeat: async input => {
				activity.push(input.activity);
				if (holdActive && input.activity.state === "active") {
					holdActive = false;
					activeStarted.resolve();
					await releaseActive.promise;
				}
			},
		});
		await host.start();
		const active = host.reportActivity("active", 100);
		await activeStarted.promise;
		const idle = host.reportActivity("idle", 200);
		releaseActive.resolve();
		await Promise.all([active, idle]);
		await host.reportActivity("idle", 300);
		await host.stop();

		expect(activity).toEqual([
			{ state: "idle", at: expect.any(Number) },
			{ state: "active", at: 100 },
			{ state: "idle", at: 200 },
		]);
	});

	test("serializes a held idle report before the successor active transition", async () => {
		const activity: Array<{ state: "active" | "idle"; at: number }> = [];
		const idleStarted = Promise.withResolvers<void>();
		const releaseIdle = Promise.withResolvers<void>();
		let holdIdle = false;
		const host = new SessionSdkHost({
			sessionId: "activity-idle-active",
			stateRoot: "/tmp/activity-idle-active",
			token: "t",
			sendFrame: () => "written",
			onFrame: () => () => {},
		});
		await host.registerWithBroker({
			register: () => {},
			heartbeat: async input => {
				activity.push(input.activity);
				if (holdIdle && input.activity.state === "idle") {
					holdIdle = false;
					idleStarted.resolve();
					await releaseIdle.promise;
				}
			},
		});
		await host.start();
		await host.reportActivity("active", 100);
		holdIdle = true;
		const idle = host.reportActivity("idle", 200);
		await idleStarted.promise;
		const successorActive = host.reportActivity("active", 300);
		releaseIdle.resolve();
		await Promise.all([idle, successorActive]);
		await host.reportActivity("active", 400);
		await host.stop();

		expect(activity).toEqual([
			{ state: "idle", at: expect.any(Number) },
			{ state: "active", at: 100 },
			{ state: "idle", at: 200 },
			{ state: "active", at: 300 },
		]);
	});

	test("retries broker unregister after a fail-once owner release", async () => {
		let unsubscribeAttempts = 0;
		let unregisterAttempts = 0;
		const host = new SessionSdkHost({
			sessionId: "retry-stop",
			stateRoot: "/tmp/retry-stop",
			token: "t",
			sendFrame: () => {
				return "written";
			},
			onFrame: () => () => {
				unsubscribeAttempts++;
			},
		});
		await host.registerWithBroker({
			register: () => {},
			unregister: () => {
				unregisterAttempts++;
				if (unregisterAttempts === 1) throw new Error("unregister failed once");
			},
		});
		await host.start();

		await expect(host.stop()).rejects.toThrow("unregister failed once");
		expect(host.started).toBe(true);
		expect(unsubscribeAttempts).toBe(1);
		expect(unregisterAttempts).toBe(1);

		expect(await host.stop()).toBe("stopped");
		expect(host.started).toBe(false);
		expect(unsubscribeAttempts).toBe(1);
		expect(unregisterAttempts).toBe(2);
		expect(await host.stop()).toBe("already");
		expect(unregisterAttempts).toBe(2);
	});

	test("passes detached-idle provenance through broker unregister", async () => {
		let reason: string | undefined;
		const host = new SessionSdkHost({
			sessionId: "detached-idle-stop",
			stateRoot: "/tmp/detached-idle-stop",
			token: "t",
			sendFrame: () => "written",
			onFrame: () => () => {},
		});
		await host.registerWithBroker({
			register: () => {},
			unregister: input => {
				reason = input.reason;
			},
		});
		await host.start();
		await host.stop({ unregisterReason: "detached_idle" });
		expect(reason).toBe("detached_idle");
	});

	test("does not fail shutdown when the session-index lock is held by a live broker", async () => {
		const host = new SessionSdkHost({
			sessionId: "contended-stop",
			stateRoot: "/tmp/contended-stop",
			token: "t",
			sendFrame: () => "written",
			onFrame: () => () => {},
		});
		await host.start();
		await host.registerWithBroker({
			register: () => {},
			unregister: () => {
				const error = new FileLockAcquireError(
					"/tmp/index.jsonl",
					"/tmp/index.jsonl.lock",
					600,
					"held by pid 123 (live)",
				);
				error.message = "operator wording can change";
				throw error;
			},
		});

		await expect(host.stop({ allowLockContention: true })).resolves.toBe("stopped");
		expect(host.started).toBe(false);
	});

	test("does not suppress access-denied publication failures as lock contention", async () => {
		const error = new FileLockAcquireError(
			"/tmp/index.jsonl",
			"/tmp/index.jsonl.lock",
			3,
			"publication failed with access_denied",
			"acquire_timeout",
			undefined,
			undefined,
			"access_denied",
		);
		const host = new SessionSdkHost({
			sessionId: "access-denied-stop",
			stateRoot: "/tmp/access-denied-stop",
			token: "t",
			sendFrame: () => "written",
			onFrame: () => () => {},
		});
		await host.start();
		await host.registerWithBroker({
			register: () => {},
			unregister: () => {
				throw error;
			},
		});

		await expect(host.stop({ allowLockContention: true })).rejects.toBe(error);
		expect(host.started).toBe(true);
	});

	test("allows access-denied lock contention during shutdown when a holder is proven live", async () => {
		const error = new FileLockAcquireError(
			"/tmp/index.jsonl",
			"/tmp/index.jsonl.lock",
			3,
			"held by pid 123 (live)",
			"acquire_timeout",
			undefined,
			undefined,
			"access_denied",
			true,
		);
		const host = new SessionSdkHost({
			sessionId: "live-access-denied-stop",
			stateRoot: "/tmp/live-access-denied-stop",
			token: "t",
			sendFrame: () => "written",
			onFrame: () => () => {},
		});
		await host.start();
		await host.registerWithBroker({
			register: () => {},
			unregister: () => {
				throw error;
			},
		});

		await expect(host.stop({ allowLockContention: true })).resolves.toBe("stopped");
		expect(host.started).toBe(false);
	});

	test("does not swallow orphan transition errors as allowed lock contention", async () => {
		const host = new SessionSdkHost({
			sessionId: "orphan-stop",
			stateRoot: "/tmp/orphan-stop",
			token: "t",
			sendFrame: () => "written",
			onFrame: () => () => {},
		});
		await host.start();
		await host.registerWithBroker({
			register: () => {},
			unregister: () => {
				throw new FileLockAcquireError(
					"/tmp/index.jsonl",
					"/tmp/index.jsonl.lock",
					1,
					"orphan transition retained at /tmp/index.jsonl.lock.removing",
					"orphan_transition",
					"/tmp/index.jsonl.lock.removing",
				);
			},
		});

		await expect(host.stop({ allowLockContention: true })).rejects.toBeInstanceOf(FileLockAcquireError);
		expect(host.started).toBe(true);
	});

	test("does not defer a non-lock error even when its message resembles contention", async () => {
		const error = new Error("Failed to acquire lock for an unrelated operation");
		const host = new SessionSdkHost({
			sessionId: "non-lock-stop",
			stateRoot: "/tmp/non-lock-stop",
			token: "t",
			sendFrame: () => "written",
			onFrame: () => () => {},
		});
		await host.registerWithBroker({
			register: () => {},
			unregister: () => {
				throw error;
			},
		});
		await host.start();
		await expect(host.stop({ allowLockContention: true })).rejects.toBe(error);
		expect(host.started).toBe(true);
	});

	test("keeps lock contention retryable during session replacement", async () => {
		let unregisterAttempts = 0;
		const host = new SessionSdkHost({
			sessionId: "replacement-stop",
			stateRoot: "/tmp/replacement-stop",
			token: "t",
			sendFrame: () => "written",
			onFrame: () => () => {},
		});
		await host.registerWithBroker({
			register: () => {},
			unregister: () => {
				unregisterAttempts++;
				if (unregisterAttempts === 1)
					throw new FileLockAcquireError(
						"/tmp/index.jsonl",
						"/tmp/index.jsonl.lock",
						600,
						"held by pid 123 (live)",
					);
			},
		});
		await host.start();

		await expect(host.stop()).rejects.toThrow(FileLockAcquireError);
		expect(host.started).toBe(true);
		expect(unregisterAttempts).toBe(1);
		expect(await host.stop()).toBe("stopped");
		expect(unregisterAttempts).toBe(2);
	});

	test("shares one broker unregister across concurrent stop callers", async () => {
		let unsubscribeAttempts = 0;
		let unregisterAttempts = 0;
		const unregister = Promise.withResolvers<void>();
		const host = new SessionSdkHost({
			sessionId: "concurrent-stop",
			stateRoot: "/tmp/concurrent-stop",
			token: "t",
			sendFrame: () => {
				return "written";
			},
			onFrame: () => () => {
				unsubscribeAttempts++;
			},
		});
		await host.registerWithBroker({
			register: () => {},
			unregister: () => {
				unregisterAttempts++;
				return unregister.promise;
			},
		});
		await host.start();

		const first = host.stop();
		const concurrent = host.stop();
		await Bun.sleep(0);
		expect(unsubscribeAttempts).toBe(1);
		expect(unregisterAttempts).toBe(1);

		unregister.resolve();
		expect(await Promise.all([first, concurrent])).toEqual(["stopped", "stopped"]);
		expect(host.started).toBe(false);
		expect(unsubscribeAttempts).toBe(1);
		expect(unregisterAttempts).toBe(1);
	});

	test("hosts root sessions unless explicitly disabled", () => {
		expect(shouldHostSdk({ notifications: { enabled: false } }, true, {})).toBe(true);
		expect(shouldHostSdk({}, false, {})).toBe(false);
		expect(shouldHostSdk({}, true, { GJC_SDK_DISABLE: "1" })).toBe(false);
	});

	test("routes reverse ingress with Rust-aligned frames and records session readiness", async () => {
		let receive!: (connectionId: string, frame: Record<string, unknown>) => void;
		const sent: Array<{ connectionId: string; frame: Record<string, unknown> }> = [];
		const host = new SessionSdkHost({
			sessionId: "s",
			stateRoot: "/tmp/s",
			token: "t",
			sendFrame: (connectionId, frame) => {
				sent.push({ connectionId, frame });
				return "written";
			},
			onFrame: handler => {
				receive = handler;
				return () => {};
			},
		});
		await host.start();
		expect(host.events.replay(0).events).toMatchObject([{ type: "event", name: "session_ready", sessionId: "s" }]);
		receive("replay", { type: "event_replay", id: "replay-current", sinceGeneration: host.generation, sinceSeq: 0 });
		await new Promise(resolve => setTimeout(resolve, 0));
		expect(sent.at(-1)).toMatchObject({
			connectionId: "replay",
			frame: {
				type: "event_replay_result",
				id: "replay-current",
				ok: true,
				generation: 1,
				lastSeq: 1,
				events: [{ type: "event", seq: 1 }],
			},
		});
		host.events.restart();
		receive("replay", { type: "event_replay", id: "replay-gap", sinceGeneration: 1, sinceSeq: 1 });
		await new Promise(resolve => setTimeout(resolve, 0));
		expect(sent.at(-1)).toMatchObject({
			connectionId: "replay",
			frame: {
				type: "event_replay_result",
				id: "replay-gap",
				ok: true,
				generation: 2,
				lastSeq: 0,
				gap: { kind: "generation_reset", fromGeneration: 1, toGeneration: 2, resyncQueries: ["Q01", "Q02", "Q03"] },
				events: [],
			},
		});
		receive("provider", {
			type: "register_provider",
			id: "register-1",
			connectionId: "provider",
			capability: "host_tools",
			definitions: [{ name: "read", description: "Read a file.", parameters: {} }],
		});
		await new Promise(resolve => setTimeout(resolve, 0));
		const leaseId = host.reverse.getLease("host_tools")!.leaseId;
		expect(sent[2]).toMatchObject({
			connectionId: "provider",
			frame: {
				type: "register_provider_result",
				registeredNames: ["read"],
				leaseId,
				leaseExpiresAt: expect.any(String),
			},
		});
		receive("provider", { type: "provider_heartbeat", connectionId: "provider", leaseId });
		await new Promise(resolve => setTimeout(resolve, 0));
		receive("other", { type: "lease_release", connectionId: "other", leaseId });
		await new Promise(resolve => setTimeout(resolve, 0));
		expect(sent[3]).toMatchObject({ frame: { type: "lease_state", id: "", active: true, leaseId } });
		expect(sent[4]).toMatchObject({
			connectionId: "other",
			frame: {
				type: "reverse_response",
				id: "",
				ok: false,
				error: { code: "not_lease_owner", message: "not_lease_owner" },
			},
		});
		await host.stop();
	});

	// Retention is bounded by event count, so retained `agent_end` final texts
	// alone can outgrow the directed-frame ceiling; the native writer then
	// rejected the whole replay as `oversized_frame` and the client never
	// completed its replay barrier.
	describe("event replay under the directed-frame ceiling", () => {
		// 40,000 Hangul syllables are 120,000 UTF-8 bytes but only 40,000 UTF-16
		// units, so the bound must count bytes the way the native writer does.
		const finalText = "가".repeat(40_000);
		const resyncQueries = ["Q01", "Q02", "Q03"];
		type ReplayResult = { events: Array<{ seq: number; kind?: unknown }>; gap?: EventReplayGap };

		async function startReplayHost(
			sessionId: string,
			capabilities: ReadonlySet<string> = new Set(),
			ceilingBytes?: number | null,
		) {
			let receive!: (connectionId: string, frame: Record<string, unknown>) => void;
			const sent: Array<{ frame: Record<string, unknown>; bytes: number }> = [];
			const host = new SessionSdkHost({
				sessionId,
				stateRoot: `/tmp/${sessionId}`,
				token: "token",
				...(ceilingBytes === undefined ? {} : { directedFrameCeilingBytes: ceilingBytes }),
				connectionCapabilities: () => capabilities,
				sendFrame: (_connectionId, frame) => {
					sent.push({ frame, bytes: Buffer.byteLength(JSON.stringify(frame)) });
					return "written";
				},
				onFrame: handler => {
					receive = handler;
					return () => {};
				},
			});
			await host.start();
			const replay = async (id: string, request: Record<string, unknown>) => {
				receive("client", { type: "event_replay", id, ...request });
				await Bun.sleep(0);
				const { frame, bytes } = sent.at(-1)!;
				expect(frame).toMatchObject({ type: "event_replay_result", id, ok: true, lastSeq: host.events.sequence });
				if (ceilingBytes !== null) expect(bytes).toBeLessThanOrEqual(ceilingBytes ?? RESPONSE_CEILING_BYTES);
				return { ...(frame as ReplayResult), bytes };
			};
			return { host, replay };
		}

		function emitTurns(host: SessionSdkHost, turns: number): void {
			for (let turn = 0; turn < turns; turn++) {
				host.emitEvent({ kind: "agent_start", payload: { type: "agent_start" } });
				host.emitEvent({ kind: "tool_activity", payload: { type: "tool_activity" } });
				host.emitEvent({ kind: "agent_end", payload: { type: "agent_end", finalText } });
			}
		}

		/** The result keeps the newest visible events and drops only as many as the ceiling requires. */
		function expectNewestThatFit(
			host: SessionSdkHost,
			result: ReplayResult & { bytes: number },
			hiddenKind?: string,
		): void {
			const gap = result.gap;
			if (gap?.kind !== "sequence_gap") throw new Error("expected a sequence gap");
			const newestVisible = host.events
				.replay(0)
				.events.filter(event => event.kind !== hiddenKind)
				.at(-1);
			expect(result.events.at(-1)?.seq).toBe(newestVisible?.seq);
			expect(result.events.every(event => event.seq > gap.toSeq)).toBe(true);
			const lastDropped = host.events.replay(0).events.find(event => event.seq === gap.toSeq)!;
			expect(result.bytes + Buffer.byteLength(JSON.stringify(lastDropped)) + 1).toBeGreaterThan(
				RESPONSE_CEILING_BYTES,
			);
		}

		test("concedes the oldest events as a new sequence gap", async () => {
			const { host, replay } = await startReplayHost("replay-ceiling-gap", new Set(["tool_activity_v2"]));
			try {
				emitTurns(host, 12);
				const fromStart = await replay("from-start", { sinceSeq: 0 });
				const firstKept = fromStart.events[0]!.seq;
				expect(fromStart.gap).toEqual({ kind: "sequence_gap", fromSeq: 1, toSeq: firstKept - 1, resyncQueries });
				expect(fromStart.events.map(event => event.seq)).toEqual(
					Array.from({ length: host.events.sequence - firstKept + 1 }, (_, index) => firstKept + index),
				);
				expectNewestThatFit(host, fromStart);

				const resumed = await replay("resumed", { sinceGeneration: host.generation, sinceSeq: 2 });
				expect(resumed.gap).toMatchObject({ kind: "sequence_gap", fromSeq: 3 });
				expectNewestThatFit(host, resumed);

				const reset = await replay("reset", { sinceGeneration: host.generation - 1, sinceSeq: 0 });
				expect(reset.gap).toEqual({
					kind: "generation_reset",
					fromGeneration: host.generation - 1,
					toGeneration: host.generation,
					resyncQueries,
				});
				expect(reset.events.at(-1)?.seq).toBe(host.events.sequence);
			} finally {
				await host.stop();
			}
		});

		test("extends the retention gap the ring already reports", async () => {
			const { host, replay } = await startReplayHost("replay-ceiling-retention", new Set(["tool_activity_v2"]));
			try {
				for (let index = 0; index < 240; index++)
					host.emitEvent({ kind: "activity", payload: { type: "activity" } });
				emitTurns(host, 12);
				const retentionGap = host.events.replay(0).gap;
				if (retentionGap?.kind !== "sequence_gap") throw new Error("expected the ring to overflow");
				const result = await replay("retention", { sinceSeq: 0 });
				expect(result.gap).toMatchObject({ kind: "sequence_gap", fromSeq: 1, resyncQueries });
				expect((result.gap as { toSeq: number }).toSeq).toBeGreaterThan(retentionGap.toSeq);
				expectNewestThatFit(host, result);
			} finally {
				await host.stop();
			}
		});

		test("ends the gap at the last dropped event the connection may see", async () => {
			const { host, replay } = await startReplayHost("replay-ceiling-capability");
			try {
				// A large hidden event right after each `agent_end`: counting its bytes, or
				// ending the gap just before the first kept event, both land on it.
				for (let turn = 0; turn < 12; turn++) {
					host.emitEvent({ kind: "agent_start", payload: { type: "agent_start" } });
					host.emitEvent({ kind: "agent_end", payload: { type: "agent_end", finalText } });
					host.emitEvent({
						kind: "tool_activity",
						payload: { type: "tool_activity", output: "가".repeat(30_000) },
					});
				}
				const result = await replay("capability", { sinceSeq: 0 });
				expect(result.events.some(event => event.kind === "tool_activity")).toBe(false);
				const gap = result.gap as { toSeq: number };
				expect(host.events.replay(0).events.find(event => event.seq === gap.toSeq)?.kind).not.toBe("tool_activity");
				expectNewestThatFit(host, result, "tool_activity");
			} finally {
				await host.stop();
			}
		});

		// The SDK-only JS WebSocket transport declares that it has no frame ceiling,
		// so its clients keep receiving the whole retained replay.
		test("replies intact on a transport that declares no ceiling", async () => {
			const { host, replay } = await startReplayHost("replay-no-ceiling", new Set(["tool_activity_v2"]), null);
			try {
				emitTurns(host, 12);
				const result = await replay("no-ceiling", { sinceSeq: 0 });
				expect(result.bytes).toBeGreaterThan(RESPONSE_CEILING_BYTES);
				expect(result.gap).toBeUndefined();
				expect(result.events.map(event => event.seq)).toEqual(host.events.replay(0).events.map(event => event.seq));
			} finally {
				await host.stop();
			}
		});

		test("keeps the newest visible suffix that fits any ceiling and states the exact gap", async () => {
			const event = fc.record({
				kind: fc.constantFrom("agent_start", "agent_end", "tool_activity", "notice"),
				text: fc.string({ unit: "binary", maxLength: 600 }),
			});
			await fc.assert(
				fc.asyncProperty(
					fc.array(event, { minLength: 1, maxLength: 40 }),
					fc.integer({ min: 600, max: 12_000 }),
					fc.nat({ max: 45 }),
					// 260 small events overflow the 256-event ring first, so an early position replays across a retention gap.
					fc.constantFrom(0, 260),
					fc.boolean(),
					async (emitted, ceilingBytes, since, prefill, previousGeneration) => {
						const { host, replay } = await startReplayHost("replay-ceiling-property", new Set(), ceilingBytes);
						try {
							for (let index = 0; index < prefill; index++)
								host.emitEvent({ kind: "notice", payload: { type: "notice" } });
							for (const { kind, text } of emitted) host.emitEvent({ kind, payload: { type: kind, text } });
							const sinceGeneration = previousGeneration ? host.generation - 1 : host.generation;
							const sinceSeq = Math.min(since, host.events.sequence);
							const unbounded = host.events.replay(sinceSeq, sinceGeneration);
							const visible = unbounded.events.filter(candidate => candidate.kind !== "tool_activity");
							const result = await replay("property", { sinceGeneration, sinceSeq });
							const keptSeqs = result.events.map(kept => kept.seq);
							const dropped = visible.length - keptSeqs.length;
							// The kept events are the newest visible events, in order.
							expect(keptSeqs).toEqual(visible.slice(dropped).map(kept => kept.seq));
							if (dropped === 0 || unbounded.gap?.kind === "generation_reset") {
								// A generation reset already mandates a full resync and is kept as is.
								expect(result.gap).toEqual(unbounded.gap);
							} else {
								// The gap runs from the requested position, or the retention gap's start,
								// through the last dropped visible event.
								expect(result.gap).toEqual({
									kind: "sequence_gap",
									fromSeq: unbounded.gap?.kind === "sequence_gap" ? unbounded.gap.fromSeq : sinceSeq + 1,
									toSeq: visible[dropped - 1]!.seq,
									resyncQueries,
								});
							}
							if (dropped > 0) {
								// Minimal: keeping the last dropped event as well would not fit.
								const lastDropped = Buffer.byteLength(JSON.stringify(visible[dropped - 1])) + 1;
								expect(result.bytes + lastDropped).toBeGreaterThan(ceilingBytes);
							}
						} finally {
							await host.stop();
						}
					},
				),
				{ seed: 7564, numRuns: 160 },
			);
		});

		test("refuses a ceiling that is not a positive safe integer", () => {
			// A JS caller can pass anything; a numeric string must not be coerced into a ceiling.
			const notANumber: unknown = "1000";
			for (const directedFrameCeilingBytes of [
				Number.NaN,
				0,
				-1,
				1.5,
				Number.POSITIVE_INFINITY,
				notANumber as number,
			])
				expect(
					() =>
						new SessionSdkHost({
							sessionId: "replay-ceiling-invalid",
							stateRoot: "/tmp/replay-ceiling-invalid",
							token: "token",
							directedFrameCeilingBytes,
							sendFrame: () => "written",
							onFrame: () => undefined,
						}),
				).toThrow("directedFrameCeilingBytes must be a positive safe integer.");
		});

		test("concedes every event when the newest alone exceeds the ceiling", async () => {
			const { host, replay } = await startReplayHost("replay-ceiling-single");
			try {
				host.emitEvent({ kind: "agent_end", payload: { type: "agent_end", finalText: "가".repeat(400_000) } });
				const result = await replay("single", { sinceSeq: 0 });
				expect(result.events).toEqual([]);
				expect(result.gap).toEqual({
					kind: "sequence_gap",
					fromSeq: 1,
					toSeq: host.events.sequence,
					resyncQueries,
				});
			} finally {
				await host.stop();
			}
		});
	});

	test("contains disconnected structured-error delivery failures without unhandled rejections", async () => {
		let receive!: (connectionId: string, frame: Record<string, unknown>) => void;
		let failSends = 0;
		const host = new SessionSdkHost({
			sessionId: "sess-disconnect",
			stateRoot: "/tmp/gjc-sdk-host-disconnect",
			token: "tok",
			sendFrame: () => {
				// Fail the success response and the subsequent structured-error delivery.
				if (failSends < 2) {
					failSends += 1;
					throw new Error("connection closed");
				}
				return "written";
			},
			onFrame: handler => {
				receive = handler;
				return () => {};
			},
		});
		await host.start();
		const unhandled: unknown[] = [];
		const onUnhandled = (reason: unknown) => {
			unhandled.push(reason);
		};
		process.on("unhandledRejection", onUnhandled);
		try {
			receive("c1", { type: "event_replay", id: "r1", sinceGeneration: 0, sinceSeq: 0 });
			await new Promise(resolve => setTimeout(resolve, 0));
			await new Promise(resolve => setTimeout(resolve, 0));
			expect(failSends).toBe(2);
			expect(unhandled).toEqual([]);
		} finally {
			process.off("unhandledRejection", onUnhandled);
			await host.stop();
		}
	});
	test("beforeControlResponse gates terminal delivery until the successor hook resolves", async () => {
		let receive!: (connectionId: string, frame: Record<string, unknown>) => void;
		const sent: Array<Record<string, unknown>> = [];
		const successorReady = Promise.withResolvers<void>();
		const order: string[] = [];
		const deliveries: string[] = [];
		let afterRan = false;
		const host = new SessionSdkHost({
			sessionId: "control-drain-order",
			stateRoot: "/tmp/control-drain-order",
			token: "token",
			sendFrame: (_connectionId, frame) => {
				order.push("send");
				sent.push(frame);
				return "written";
			},
			onFrame: handler => {
				receive = handler;
				return () => {};
			},
			control: (_connectionId, frame) => ({ id: frame.id, ok: true, result: {} }),
			beforeControlResponse: async (_connectionId, _request, _response, sendTerminal) => {
				order.push("before");
				await successorReady.promise;
				order.push("ready");
				await sendTerminal();
			},
			onControlResponseDelivery: async (_connectionId, _request, _response, outcome) => {
				deliveries.push(outcome);
			},
			afterControlResponse: async () => {
				afterRan = true;
			},
		});
		await host.start();
		receive("client", { type: "control_request", id: "c1", operation: "session.switch", input: {} });
		await new Promise(resolve => setTimeout(resolve, 0));
		expect(sent).toEqual([]);
		expect(order).toEqual(["before"]);
		successorReady.resolve();
		await new Promise(resolve => setTimeout(resolve, 0));
		await new Promise(resolve => setTimeout(resolve, 0));
		expect(sent).toEqual([expect.objectContaining({ type: "control_response", id: "c1", ok: true })]);
		expect(order).toEqual(["before", "ready", "send"]);
		// The EARLY send (inside beforeControlResponse) is classified as written —
		// the fallback repeat call must not report a false dropped — and the
		// post-write hook runs for the written response.
		expect(deliveries).toEqual(["written"]);
		expect(afterRan).toBe(true);
		await host.stop();
	});
});
