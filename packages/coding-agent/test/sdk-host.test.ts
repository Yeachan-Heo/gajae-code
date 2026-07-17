import { describe, expect, test } from "bun:test";
import { SessionEventStream, SessionSdkHost, shouldHostSdk } from "../src/sdk/host";

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
	test("lifecycle is idempotent and registers with the broker", async () => {
		let handler: ((connectionId: string, frame: Record<string, unknown>) => void) | undefined;
		const registered: number[] = [];
		const host = new SessionSdkHost({
			sessionId: "s",
			stateRoot: "/tmp/s",
			token: "t",
			sendFrame: () => {},
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
		expect(registered).toEqual([1]);
		expect(handler).toBeDefined();
		expect(await host.stop()).toBe("stopped");
		expect(await host.stop()).toBe("already");
		expect(await host.start()).toBe("started");
		expect(registered).toEqual([1, 2]);
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
});
