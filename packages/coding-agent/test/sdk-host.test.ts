import { describe, expect, test } from "bun:test";
import { PROMPT_REPLAY_TOKEN_CAPACITY, SessionEventStream, SessionSdkHost, shouldHostSdk } from "../src/sdk/host";

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

	test("unscoped replay filters audience-scoped events while scoped replay requires a token", async () => {
		let receive!: (connectionId: string, frame: Record<string, unknown>) => void;
		const sent: Array<{ connectionId: string; frame: Record<string, unknown> }> = [];
		const host = new SessionSdkHost({
			sessionId: "audience-replay",
			stateRoot: "/tmp/audience-replay",
			token: "token",
			sendFrame: (connectionId, frame) => {
				sent.push({ connectionId, frame });
			},
			onFrame: handler => {
				receive = handler;
				return () => {};
			},
		});
		await host.start();
		host.emitEvent({ kind: "public", payload: "public" });
		host.emitEvent({ kind: "private", payload: "one", audience: { requesterRef: "requester-one" } });
		host.emitEvent({ kind: "private", payload: "two", audience: { requesterRef: "requester-two" } });
		const replay = (connectionId: string, id: string, requesterRef?: string, replayToken?: string) => {
			receive(connectionId, { type: "event_replay", id, sinceSeq: 0, ...(requesterRef ? { requesterRef } : {}), ...(replayToken ? { replayToken } : {}) });
		};
		replay("same-connection", "unscoped");
		await new Promise(resolve => setTimeout(resolve, 0));
		expect(sent.at(-1)?.frame).toMatchObject({ type: "event_replay_result", id: "unscoped", ok: true });
		expect(
			(sent.at(-1)?.frame.events as Array<{ payload?: string }>).map(event => event.payload).filter(Boolean),
		).toEqual(["public"]);
		const requesterOneToken = host.issueReplayToken("requester-one");
		replay("same-connection", "same", "requester-one", requesterOneToken);
		await new Promise(resolve => setTimeout(resolve, 0));
		expect(
			(sent.at(-1)?.frame.events as Array<{ payload?: string }>).map(event => event.payload).filter(Boolean),
		).toEqual(["public", "one"]);
		replay("reconnected", "reconnect", "requester-one", requesterOneToken);
		await new Promise(resolve => setTimeout(resolve, 0));
		expect(
			(sent.at(-1)?.frame.events as Array<{ payload?: string }>).map(event => event.payload).filter(Boolean),
		).toEqual(["public", "one"]);
		replay("wrong-connection", "wrong", "requester-three", "guessed-token");
		await new Promise(resolve => setTimeout(resolve, 0));
		expect(sent.at(-1)?.frame).toMatchObject({ ok: false, error: { code: "audience_forbidden" } });
		await host.stop();
	});

test("a guessed requester reference cannot replay another connection's correlated events", async () => {
	let receive!: (connectionId: string, frame: Record<string, unknown>) => void;
	const sent: Array<{ connectionId: string; frame: Record<string, unknown> }> = [];
	const host = new SessionSdkHost({
		sessionId: "replay-token",
		stateRoot: "/tmp/replay-token",
		token: "token",
		sendFrame: (connectionId, frame) => void sent.push({ connectionId, frame }),
		onFrame: handler => {
			receive = handler;
			return () => {};
		},
		control: () => ({ id: "submit", ok: true }),
	});
	await host.start();
	receive("connection-a", { type: "control_request", id: "submit", operation: "turn.prompt", input: { clientRef: "a-ref" } });
	await new Promise(resolve => setTimeout(resolve, 0));
	host.emitEvent({ kind: "private", payload: "A only", audience: { requesterRef: "a-ref" } });
	receive("connection-b", { type: "event_replay", id: "guess", sinceSeq: 0, requesterRef: "a-ref" });
	await new Promise(resolve => setTimeout(resolve, 0));
	expect(sent.at(-1)).toMatchObject({ connectionId: "connection-b", frame: { ok: false, error: { code: "audience_forbidden" } } });
	expect(JSON.stringify(sent.at(-1))).not.toContain("A only");
	await host.stop();
});
	test("prompt audience claims bind token issuance to the successful requester acknowledgement", async () => {
		let receive!: (connectionId: string, frame: Record<string, unknown>) => void;
		const sent: Array<{ connectionId: string; frame: Record<string, unknown> }> = [];
		const controls: Array<{ connectionId: string; frame: Record<string, unknown> }> = [];
		const host = new SessionSdkHost({
			sessionId: "prompt-audience",
			stateRoot: "/tmp/prompt-audience",
			token: "token",
			sendFrame: (connectionId, frame) => void sent.push({ connectionId, frame }),
			onFrame: handler => {
				receive = handler;
				return () => {};
			},
			control: (connectionId, frame) => {
				controls.push({ connectionId, frame });
				return { id: frame.id, ok: true, result: { accepted: true } };
			},
		});
		await host.start();
		receive("connection-a", {
			type: "control_request",
			id: "a-submit",
			operation: "turn.prompt",
			input: { clientRef: "a-ref" },
		});
		await new Promise(resolve => setTimeout(resolve, 0));
		const acknowledgement = sent.at(-1)?.frame as { replayToken?: string };
		expect(acknowledgement.replayToken).toEqual(expect.any(String));
		const replayToken = acknowledgement.replayToken!;
		host.emitEvent({ kind: "private", payload: "A only", audience: { requesterRef: "a-ref" } });
		receive("connection-b", {
			type: "control_request",
			id: "b-submit",
			operation: "turn.prompt",
			input: { clientRef: "a-ref" },
		});
		await new Promise(resolve => setTimeout(resolve, 0));
		expect(sent.at(-1)).toMatchObject({
			connectionId: "connection-b",
			frame: { id: "b-submit", ok: false, error: { code: "audience_forbidden" } },
		});
		expect(sent.at(-1)?.frame).not.toHaveProperty("replayToken");
		expect(controls.map(control => control.connectionId)).toEqual(["connection-a"]);
		for (const [id, token] of [
			["missing", undefined],
			["wrong", "wrong-token"],
		] as const) {
			receive("connection-b", { type: "event_replay", id, sinceSeq: 0, requesterRef: "a-ref", ...(token ? { replayToken: token } : {}) });
			await new Promise(resolve => setTimeout(resolve, 0));
			expect(sent.at(-1)).toMatchObject({ connectionId: "connection-b", frame: { id, ok: false, error: { code: "audience_forbidden" } } });
			expect(JSON.stringify(sent.at(-1))).not.toContain("A only");
		}
		receive("connection-a-reconnected", {
			type: "event_replay",
			id: "reconnect",
			sinceSeq: 0,
			requesterRef: "a-ref",
			replayToken,
		});
		await new Promise(resolve => setTimeout(resolve, 0));
		expect(sent.at(-1)).toMatchObject({
			connectionId: "connection-a-reconnected",
			frame: {
				id: "reconnect",
				ok: true,
				events: expect.arrayContaining([expect.objectContaining({ payload: "A only" })]),
			},
		});
		await host.stop();
	});

	test("pending prompt audience claims reject tokenless replay and release after acknowledgement failure", async () => {
		let receive!: (connectionId: string, frame: Record<string, unknown>) => void;
		let resolveAcknowledgement!: (response: { id: unknown; ok: boolean }) => void;
		const sent: Array<{ connectionId: string; frame: Record<string, unknown> }> = [];
		const controls: Array<{ connectionId: string; frame: Record<string, unknown> }> = [];
		const acknowledgement = new Promise<{ id: unknown; ok: boolean }>(resolve => {
			resolveAcknowledgement = resolve;
		});
		const host = new SessionSdkHost({
			sessionId: "pending-prompt-audience",
			stateRoot: "/tmp/pending-prompt-audience",
			token: "token",
			sendFrame: (connectionId, frame) => void sent.push({ connectionId, frame }),
			onFrame: handler => {
				receive = handler;
				return () => {};
			},
			control: (connectionId, frame) => {
				controls.push({ connectionId, frame });
				if (connectionId === "connection-a") return acknowledgement;
				return { id: frame.id, ok: connectionId !== "failed-claimant" };
			},
		});
		await host.start();
		receive("connection-a", {
			type: "control_request",
			id: "a-submit",
			operation: "turn.prompt",
			input: { clientRef: "a-ref" },
		});
		await new Promise(resolve => setTimeout(resolve, 0));
		host.emitEvent({ kind: "private", payload: "A only", audience: { requesterRef: "a-ref" } });
		receive("connection-b", { type: "event_replay", id: "tokenless-replay", sinceSeq: 0, requesterRef: "a-ref" });
		await new Promise(resolve => setTimeout(resolve, 0));
		expect(sent.at(-1)).toMatchObject({
			connectionId: "connection-b",
			frame: { id: "tokenless-replay", ok: false, error: { code: "audience_forbidden" } },
		});
		expect(JSON.stringify(sent.at(-1))).not.toContain("A only");
		receive("connection-b", {
			type: "control_request",
			id: "b-submit",
			operation: "turn.prompt",
			input: { clientRef: "a-ref" },
		});
		await new Promise(resolve => setTimeout(resolve, 0));
		expect(sent.at(-1)).toMatchObject({
			connectionId: "connection-b",
			frame: { id: "b-submit", ok: false, error: { code: "audience_forbidden" } },
		});
		expect(sent.at(-1)?.frame).not.toHaveProperty("replayToken");
		expect(controls.map(control => control.connectionId)).toEqual(["connection-a"]);

		resolveAcknowledgement({ id: "a-submit", ok: true });
		await new Promise(resolve => setTimeout(resolve, 0));
		const replayToken = (sent.at(-1)?.frame as { replayToken?: string }).replayToken;
		expect(replayToken).toEqual(expect.any(String));
		receive("connection-a-reconnected", {
			type: "event_replay",
			id: "authenticated-replay",
			sinceSeq: 0,
			requesterRef: "a-ref",
			replayToken,
		});
		await new Promise(resolve => setTimeout(resolve, 0));
		expect(sent.at(-1)).toMatchObject({
			connectionId: "connection-a-reconnected",
			frame: { id: "authenticated-replay", ok: true, events: expect.arrayContaining([expect.objectContaining({ payload: "A only" })]) },
		});

		receive("failed-claimant", {
			type: "control_request",
			id: "failed-submit",
			operation: "turn.prompt",
			input: { clientRef: "released-ref" },
		});
		await new Promise(resolve => setTimeout(resolve, 0));
		expect(sent.at(-1)).toMatchObject({ connectionId: "failed-claimant", frame: { id: "failed-submit", ok: false } });
		receive("legitimate-claimant", {
			type: "control_request",
			id: "legitimate-submit",
			operation: "turn.prompt",
			input: { clientRef: "released-ref" },
		});
		await new Promise(resolve => setTimeout(resolve, 0));
		expect(sent.at(-1)).toMatchObject({
			connectionId: "legitimate-claimant",
			frame: { id: "legitimate-submit", ok: true, replayToken: expect.any(String) },
		});
		await host.stop();
	});

	test("bounds replay tokens oldest-first without evicting an in-flight audience", async () => {
		let receive!: (connectionId: string, frame: Record<string, unknown>) => void;
		let releaseControl!: () => void;
		const sent: Array<{ connectionId: string; frame: Record<string, unknown> }> = [];
		const host = new SessionSdkHost({
			sessionId: "bounded-replay-tokens",
			stateRoot: "/tmp/bounded-replay-tokens",
			token: "token",
			sendFrame: (connectionId, frame) => void sent.push({ connectionId, frame }),
			onFrame: handler => {
				receive = handler;
				return () => {};
			},
			control: () => new Promise<void>(resolve => (releaseControl = resolve)),
		});
		await host.start();
		const oldestToken = host.issueReplayToken("token-0");
		for (let index = 1; index < PROMPT_REPLAY_TOKEN_CAPACITY - 1; index++) host.issueReplayToken(`token-${index}`);
		const activeToken = host.issueReplayToken("active");
		receive("active-connection", {
			type: "control_request",
			id: "active-prompt",
			operation: "turn.prompt",
			input: { clientRef: "active" },
			replayToken: activeToken,
		});
		await new Promise(resolve => setTimeout(resolve, 0));
		for (let index = 0; index < 2; index++) host.issueReplayToken(`pressure-${index}`);
		host.emitEvent({ kind: "private", payload: "active survives", audience: { requesterRef: "active" } });
		receive("active-connection", {
			type: "event_replay",
			id: "active-replay",
			sinceSeq: 0,
			requesterRef: "active",
			replayToken: activeToken,
		});
		await new Promise(resolve => setTimeout(resolve, 0));
		expect(sent.at(-1)).toMatchObject({
			connectionId: "active-connection",
			frame: { ok: true, events: expect.arrayContaining([expect.objectContaining({ payload: "active survives" })]) },
		});
		receive("evicted", {
			type: "event_replay",
			id: "evicted-replay",
			sinceSeq: 0,
			requesterRef: "token-0",
			replayToken: oldestToken,
		});
		await new Promise(resolve => setTimeout(resolve, 0));
		expect(sent.at(-1)).toMatchObject({ frame: { ok: false, error: { code: "audience_forbidden" } } });
		releaseControl();
		await new Promise(resolve => setTimeout(resolve, 0));
		await host.stop();
	});

	test("fails closed when every replay token owner has a live pending audience claim", async () => {
		let receive!: (connectionId: string, frame: Record<string, unknown>) => void;
		const sent: Array<{ connectionId: string; frame: Record<string, unknown> }> = [];
		const host = new SessionSdkHost({
			sessionId: "saturated-replay-tokens",
			stateRoot: "/tmp/saturated-replay-tokens",
			token: "token",
			sendFrame: (connectionId, frame) => void sent.push({ connectionId, frame }),
			onFrame: handler => {
				receive = handler;
				return () => {};
			},
			control: () => new Promise<void>(() => {}),
		});
		await host.start();
		const tokens = Array.from({ length: PROMPT_REPLAY_TOKEN_CAPACITY }, (_, index) => host.issueReplayToken(`requester-${index}`));
		const savedToken = tokens[0];
		for (let index = 0; index < PROMPT_REPLAY_TOKEN_CAPACITY; index++) {
			receive(`connection-${index}`, {
				type: "control_request",
				id: `claim-${index}`,
				operation: "turn.prompt",
				input: { clientRef: `requester-${index}` },
				replayToken: tokens[index],
			});
			await new Promise(resolve => setTimeout(resolve, 0));
		}
		try {
			host.issueReplayToken("requester-overflow");
			expect.unreachable("Expected saturated replay-token issuance to fail.");
		} catch (error) {
			expect(error).toMatchObject({ code: "busy" });
		}
		host.emitEvent({ kind: "private", payload: "saved token survives", audience: { requesterRef: "requester-0" } });
		receive("saved-connection", {
			type: "event_replay",
			id: "saved-replay",
			sinceSeq: 0,
			requesterRef: "requester-0",
			replayToken: savedToken,
		});
		await new Promise(resolve => setTimeout(resolve, 0));
		expect(sent.at(-1)).toMatchObject({
			connectionId: "saved-connection",
			frame: { ok: true, events: expect.arrayContaining([expect.objectContaining({ payload: "saved token survives" })]) },
		});
		await host.stop();
	});

	test("expires pending audience claims before recovering replay-token capacity", async () => {
		let receive!: (connectionId: string, frame: Record<string, unknown>) => void;
		const host = new SessionSdkHost({
			sessionId: "expired-replay-claims",
			stateRoot: "/tmp/expired-replay-claims",
			token: "token",
			sendFrame: () => {},
			onFrame: handler => {
				receive = handler;
				return () => {};
			},
			control: () => new Promise<void>(() => {}),
		});
		await host.start();
		const tokens = Array.from({ length: PROMPT_REPLAY_TOKEN_CAPACITY }, (_, index) => host.issueReplayToken(`requester-${index}`));
		for (let index = 0; index < PROMPT_REPLAY_TOKEN_CAPACITY; index++) {
			receive(`connection-${index}`, {
				type: "control_request",
				id: `claim-${index}`,
				operation: "turn.prompt",
				input: { clientRef: `requester-${index}` },
				replayToken: tokens[index],
			});
			await new Promise(resolve => setTimeout(resolve, 0));
		}
		const realNow = Date.now;
		try {
			Date.now = () => realNow() + 5 * 60_000 + 1;
			const recoveredToken = host.issueReplayToken("requester-recovered");
			expect(recoveredToken).toEqual(expect.any(String));
		} finally {
			Date.now = realNow;
		}
		await host.stop();
	});

	test("does not evict other audiences when a matching token owner binds again", async () => {
		let receive!: (connectionId: string, frame: Record<string, unknown>) => void;
		const sent: Array<{ connectionId: string; frame: Record<string, unknown> }> = [];
		const host = new SessionSdkHost({
			sessionId: "matching-token-rebind",
			stateRoot: "/tmp/matching-token-rebind",
			token: "token",
			sendFrame: (connectionId, frame) => void sent.push({ connectionId, frame }),
			onFrame: handler => {
				receive = handler;
				return () => {};
			},
			control: (_connectionId, frame) =>
				frame.id === "bind" ? { id: frame.id, ok: true } : new Promise<void>(() => {}),
		});
		await host.start();
		const ownerToken = host.issueReplayToken("owner");
		const firstSavedToken = host.issueReplayToken("saved-one");
		const secondSavedToken = host.issueReplayToken("saved-two");
		for (let index = 3; index < PROMPT_REPLAY_TOKEN_CAPACITY; index++) host.issueReplayToken(`requester-${index}`);
		receive("owner-connection", {
			type: "control_request",
			id: "held",
			operation: "turn.prompt",
			input: { clientRef: "owner" },
			replayToken: ownerToken,
		});
		await new Promise(resolve => setTimeout(resolve, 0));
		receive("owner-connection", {
			type: "control_request",
			id: "bind",
			operation: "turn.prompt",
			input: { clientRef: "owner" },
			replayToken: ownerToken,
		});
		await new Promise(resolve => setTimeout(resolve, 0));
		host.emitEvent({ kind: "private", payload: "first saved audience", audience: { requesterRef: "saved-one" } });
		host.emitEvent({ kind: "private", payload: "second saved audience", audience: { requesterRef: "saved-two" } });
		for (const [requesterRef, replayToken, payload] of [
			["saved-one", firstSavedToken, "first saved audience"],
			["saved-two", secondSavedToken, "second saved audience"],
		] as const) {
			receive(`${requesterRef}-connection`, { type: "event_replay", id: `${requesterRef}-replay`, sinceSeq: 0, requesterRef, replayToken });
			await new Promise(resolve => setTimeout(resolve, 0));
			expect(sent.at(-1)).toMatchObject({
				connectionId: `${requesterRef}-connection`,
				frame: { ok: true, events: expect.arrayContaining([expect.objectContaining({ payload })]) },
			});
		}
		await host.stop();
	});

	test("recovers a lost successful prompt acknowledgement only for its claiming connection", async () => {
		let receive!: (connectionId: string, frame: Record<string, unknown>) => void;
		let failAcknowledgement = true;
		const sent: Array<{ connectionId: string; frame: Record<string, unknown> }> = [];
		const controls: string[] = [];
		const host = new SessionSdkHost({
			sessionId: "lost-prompt-acknowledgement",
			stateRoot: "/tmp/lost-prompt-acknowledgement",
			token: "token",
			sendFrame: (connectionId, frame) => {
				if (failAcknowledgement && frame.type === "control_response") {
					failAcknowledgement = false;
					throw new Error("connection closed during acknowledgement");
				}
				sent.push({ connectionId, frame });
			},
			onFrame: handler => {
				receive = handler;
				return () => {};
			},
			control: (connectionId, frame) => {
				controls.push(connectionId);
				return { id: frame.id, ok: true };
			},
		});
		await host.start();
		receive("claimant", { type: "control_request", id: "first", operation: "turn.prompt", input: { clientRef: "lost-ack" } });
		await new Promise(resolve => setTimeout(resolve, 0));
		receive("intruder", { type: "control_request", id: "intruder", operation: "turn.prompt", input: { clientRef: "lost-ack" } });
		await new Promise(resolve => setTimeout(resolve, 0));
		expect(sent.at(-1)).toMatchObject({ connectionId: "intruder", frame: { ok: false, error: { code: "audience_forbidden" } } });
		receive("claimant", { type: "control_request", id: "recovered", operation: "turn.prompt", input: { clientRef: "lost-ack" } });
		await new Promise(resolve => setTimeout(resolve, 0));
		const replayToken = (sent.at(-1)?.frame as { replayToken?: string }).replayToken;
		expect(replayToken).toEqual(expect.any(String));
		host.emitEvent({ kind: "private", payload: "recovered audience", audience: { requesterRef: "lost-ack" } });
		const realNow = Date.now;
		try {
			Date.now = () => realNow() + 6 * 60_000;
			receive("claimant", { type: "event_replay", id: "replay", sinceSeq: 0, requesterRef: "lost-ack", replayToken });
			await new Promise(resolve => setTimeout(resolve, 0));
			expect(sent.at(-1)).toMatchObject({ connectionId: "claimant", frame: { ok: true, events: expect.arrayContaining([expect.objectContaining({ payload: "recovered audience" })]) } });
		} finally {
			Date.now = realNow;
		}
		expect(controls).toEqual(["claimant"]);
		await host.stop();
	});

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

	test("retries broker unregister after a fail-once owner release", async () => {
		let unsubscribeAttempts = 0;
		let unregisterAttempts = 0;
		const host = new SessionSdkHost({
			sessionId: "retry-stop",
			stateRoot: "/tmp/retry-stop",
			token: "t",
			sendFrame: () => {},
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

	test("shares one broker unregister across concurrent stop callers", async () => {
		let unsubscribeAttempts = 0;
		let unregisterAttempts = 0;
		const unregister = Promise.withResolvers<void>();
		const host = new SessionSdkHost({
			sessionId: "concurrent-stop",
			stateRoot: "/tmp/concurrent-stop",
			token: "t",
			sendFrame: () => {},
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
	test("beforeControlResponse gates terminal delivery until the successor hook resolves", async () => {
		let receive!: (connectionId: string, frame: Record<string, unknown>) => void;
		const sent: Array<Record<string, unknown>> = [];
		const successorReady = Promise.withResolvers<void>();
		const order: string[] = [];
		const host = new SessionSdkHost({
			sessionId: "control-drain-order",
			stateRoot: "/tmp/control-drain-order",
			token: "token",
			sendFrame: (_connectionId, frame) => {
				order.push("send");
				sent.push(frame);
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
		await host.stop();
	});
});
