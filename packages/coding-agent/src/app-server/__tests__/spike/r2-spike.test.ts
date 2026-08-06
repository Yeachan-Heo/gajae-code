import { expect, test } from "bun:test";
import { SessionSdkHost } from "../../../sdk/host";
import { SessionEventStream } from "../../../sdk/host/events";

const tick = () => new Promise(resolve => setTimeout(resolve, 0));

test("(a) child-session isolation remains keyed by independently sequenced event streams", () => {
	const first = new SessionEventStream();
	const second = new SessionEventStream();
	first.emit({ kind: "message_update", payload: { token: "one" } });
	second.emit({ kind: "message_update", payload: { token: "two" } });
	expect(first.replay(0).events).toMatchObject([{ seq: 1, payload: { token: "one" } }]);
	expect(second.replay(0).events).toMatchObject([{ seq: 1, payload: { token: "two" } }]);
});

test.skip("(b) P2 ThreadRuntimeManager will prove attached detach preserves the runtime while spawned terminate closes it", () => {});

test.skip("(c) P2 ThreadRuntimeManager will prove lifecycle close remains a distinct destructive operation", () => {});

test("(e) SessionSdkHost installs a permission reverse lease, heartbeats it, and completes a reverse request", async () => {
	let receive!: (connectionId: string, frame: Record<string, unknown>) => void;
	const installed: unknown[] = [];
	const sent: Array<{ connectionId: string; frame: Record<string, unknown> }> = [];
	const host = new SessionSdkHost({
		sessionId: "r2-permission",
		stateRoot: "/tmp/r2-permission",
		token: "token",
		installProviderDefinitions: (capability, definitions) => {
			if (capability === "permission") installed.push(definitions);
		},
		sendFrame: (connectionId, frame) => {
			sent.push({ connectionId, frame });
			if (frame.type === "reverse_request")
				receive(connectionId, {
					type: "reverse_response",
					id: frame.id,
					connectionId,
					leaseId: frame.leaseId,
					ok: true,
					result: { decision: "allow" },
				});
		},
		onFrame: handler => {
			receive = handler;
			return () => {};
		},
	});
	try {
		await host.start();
		receive("permission-client", {
			type: "register_provider",
			id: "register-permission",
			connectionId: "permission-client",
			capability: "permission",
			definitions: [{ name: "request" }],
		});
		await tick();
		const lease = host.reverse.getLease("permission");
		if (!lease) throw new Error("Expected permission provider lease.");
		expect(host.getProviderDefinitions("permission")).toEqual([{ name: "request" }]);
		expect(installed).toEqual([[{ name: "request" }]]);
		receive("permission-client", {
			type: "provider_heartbeat",
			connectionId: "permission-client",
			leaseId: lease.leaseId,
		});
		await tick();
		await expect(host.reverse.request("permission", "request", { tool: "shell" })).resolves.toEqual({
			decision: "allow",
		});
		expect(sent).toContainEqual(
			expect.objectContaining({
				connectionId: "permission-client",
				frame: expect.objectContaining({ type: "reverse_request" }),
			}),
		);
	} finally {
		await host.stop();
	}
});

test("(g) SessionSdkHost replays sequenced abandoned prompt events only to their requester", async () => {
	let receive!: (connectionId: string, frame: Record<string, unknown>) => void;
	const sent: Array<{ connectionId: string; frame: Record<string, unknown> }> = [];
	const host = new SessionSdkHost({
		sessionId: "r2-prompt-audience",
		stateRoot: "/tmp/r2-prompt-audience",
		token: "token",
		sendFrame: (connectionId, frame) => void sent.push({ connectionId, frame }),
		onFrame: handler => {
			receive = handler;
			return () => {};
		},
	});
	try {
		await host.start();
		const publicEvent = host.emitEvent({ kind: "turn_progress", payload: { visibility: "public" } });
		const abandonedForRequester = host.emitEvent({
			kind: "prompt_abandoned",
			payload: { promptId: "abandoned-one" },
			audience: { requesterRef: "requester-one" },
		});
		const abandonedForOtherRequester = host.emitEvent({
			kind: "prompt_abandoned",
			payload: { promptId: "abandoned-two" },
			audience: { requesterRef: "requester-two" },
		});
		expect([publicEvent, abandonedForRequester, abandonedForOtherRequester]).toEqual([
			expect.objectContaining({ generation: host.generation, seq: 2 }),
			expect.objectContaining({ generation: host.generation, seq: 3 }),
			expect.objectContaining({ generation: host.generation, seq: 4 }),
		]);

		const replayToken = host.issueReplayToken("requester-one");
		receive("requester-one-connection", {
			type: "event_replay",
			id: "scoped-replay",
			sinceSeq: 0,
			requesterRef: "requester-one",
			replayToken,
		});
		await tick();
		expect(
			(sent.at(-1)?.frame.events as Array<{ payload?: { promptId?: string; visibility?: string } }>).map(
				event => event.payload,
			),
		).toEqual([undefined, { visibility: "public" }, { promptId: "abandoned-one" }]);

		receive("unscoped-connection", { type: "event_replay", id: "unscoped-replay", sinceSeq: 0 });
		await tick();
		expect(
			(sent.at(-1)?.frame.events as Array<{ payload?: { promptId?: string; visibility?: string } }>).map(
				event => event.payload,
			),
		).toEqual([undefined, { visibility: "public" }]);
	} finally {
		await host.stop();
	}
});
