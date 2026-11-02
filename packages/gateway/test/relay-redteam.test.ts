import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OpRefRejectedError } from "@gajae-gateway/subsession";
import { DeliveryService } from "../src/delivery/delivery";
import { RelayStreamUnwrittenError, type SessionRelayStream } from "../src/orchestrator/broker";
import { LaneGovernor } from "../src/orchestrator/lane-governor";
import { PersonaSessionManager } from "../src/orchestrator/persona-session";
import { BrokerSessionPort } from "../src/orchestrator/session-port";
import {
	deterministicInterimDeliveryId,
	RelayClosedError,
	RelayRequestTimeoutError,
	TailCapacityError,
	type TailFrame,
	TailRunner,
} from "../src/orchestrator/tail-runner";
import { WorkLaneManager } from "../src/orchestrator/work-lane";
import { Store } from "../src/store";
import {
	attachTestBrokerOwnership,
	createOwnedSessionFixture,
	initializeTestBrokerAuthority,
	ScriptedSessionPort,
} from "./session-port.fake";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
const origin = { platform: "discord", kind: "channel", conversationId: "redteam" } as const;
const key = "discord/channel/redteam";
const ids = { commandId: "command-current", turnId: "turn-current" };
async function until(check: () => boolean) {
	for (let i = 0; i < 200 && !check(); i++) await Bun.sleep(5);
	expect(check()).toBe(true);
}
class Host implements SessionRelayStream {
	readonly written: Record<string, unknown>[] = [];
	readonly queue: Array<string | null> = [];
	readonly waiters: Array<(line: string | null) => void> = [];
	closed = false;
	constructor(
		readonly reply?: (frame: Record<string, unknown>, host: Host) => void,
		readonly hello = true,
		readonly connectionId = "connection-owned",
	) {}
	readonly lines: AsyncIterable<string> = {
		[Symbol.asyncIterator]: () => ({
			next: async () => {
				const line = this.queue.length
					? this.queue.shift()!
					: await new Promise<string | null>((resolve) => this.waiters.push(resolve));
				return line === null ? { done: true, value: undefined } : { done: false, value: line };
			},
		}),
	};
	raw(line: string | null) {
		const waiter = this.waiters.shift();
		if (waiter) waiter(line);
		else this.queue.push(line);
	}
	host(frame: Record<string, unknown>) {
		this.raw(JSON.stringify(frame));
	}
	write(line: string) {
		if (this.closed) throw new RelayStreamUnwrittenError("closed");
		const frame = JSON.parse(line) as Record<string, unknown>;
		this.written.push(frame);
		if (frame.type === "hello" && this.hello) this.host({ type: "hello", connectionId: this.connectionId });
		else this.reply?.(frame, this);
	}
	answer(frame: Record<string, unknown>, result: Record<string, unknown>, code?: string) {
		this.host({
			type: frame.type === "query_request" ? "query_response" : "control_response",
			id: frame.id,
			ok: !code,
			...(code ? { error: { code } } : { result }),
		});
	}
	close() {
		if (!this.closed) {
			this.closed = true;
			this.raw(null);
		}
	}
}
function message(text: string, correlation: Record<string, string> = ids) {
	return {
		type: "event",
		kind: "message_end",
		...correlation,
		payload: { event: { message: { id: `message-${text}`, role: "assistant", content: [{ type: "text", text }] } } },
	};
}
function runner(host: Host, extra: Partial<ConstructorParameters<typeof TailRunner>[0]> = {}) {
	return new TailRunner({ stream: () => host, repo: "/tmp", log: () => {}, ...extra });
}
async function attached(host: Host, onFrame?: (frame: TailFrame) => void | Promise<void>) {
	const tail = runner(host);
	const handle = await tail.attach({ sessionId: "s", brokerGeneration: 1, repo: "/tmp", onFrame });
	cleanups.push(() => handle.close());
	handle.beginTurn("op", ids);
	return handle;
}
async function database() {
	const home = await mkdtemp(join(tmpdir(), "relay-redteam-"));
	const db = await Store.open(join(home, "gateway.db"));
	cleanups.push(async () => {
		db.close();
		await rm(home, { recursive: true, force: true });
	});
	return { db, home };
}
async function broker(host: Host, extra: Partial<ConstructorParameters<typeof BrokerSessionPort>[0]> = {}) {
	const { db, home } = await database();
	const authority = initializeTestBrokerAuthority(db, join(home, "agent"));
	await createOwnedSessionFixture(db, authority, { sessionId: "s", originKey: key, epoch: 0, repo: home });
	const tail = runner(host, { requestTimeoutMs: 5 });
	const port = new BrokerSessionPort({
		database: db,
		authority,
		tailRunner: tail,
		cli: async () => {
			throw new Error("unexpected CLI");
		},
		...extra,
	});
	const handle = await port.attachTail({ sessionId: "s", brokerGeneration: 1, repo: home });
	cleanups.push(() => handle.close());
	return { port, handle, input: { sessionId: "s", repo: home, opRef: "redteam-op", text: "work", relay: handle } };
}
async function actor(port = new ScriptedSessionPort()) {
	const { db, home } = await database();
	attachTestBrokerOwnership(db, port, join(home, "agent"));
	const logs: string[] = [];
	const terminal: string[] = [];
	const speech: string[] = [];
	const released: string[] = [];
	const failures: string[] = [];
	const manager = new PersonaSessionManager({
		database: db,
		port,
		instanceId: "redteam",
		repo: home,
		log: (line) => logs.push(line),
		onTurnStart: ({ trigger }) => ({
			text: trigger.body,
			onFrame: ({ frame }) => {
				if (frame.assistantText) speech.push(frame.assistantText);
			},
			onTerminal: ({ text }) => {
				terminal.push(text);
			},
			onFailure: ({ error }) => {
				failures.push(error.message);
			},
			onReleased: ({ turn }) => {
				released.push(turn.opRef);
			},
		}),
	});
	cleanups.push(() => manager.stop());
	const enqueue = (id: string) => {
		db.transaction((tx) =>
			db.inbox.enqueue(tx, { messageId: id, originKey: key, originRefJson: JSON.stringify(origin), body: id }),
		);
		return manager.notifyInbound(key);
	};
	return { db, port, manager, logs, terminal, speech, released, failures, enqueue };
}

test("RT01 duplicate message_end reaches callback twice but deterministic ledger permits one delivery", async () => {
	const { db } = await database();
	const service = new DeliveryService(db);
	const host = new Host();
	const delivered: string[] = [];
	let callbacks = 0;
	await attached(host, (frame) => {
		if (!frame.assistantText) return;
		callbacks++;
		const id = deterministicInterimDeliveryId(key, "trigger", frame.assistantText, 0);
		const payload = service.prepare("turn", origin, frame.assistantText, undefined, id);
		if (payload) {
			service.markInflight(id);
			delivered.push(payload.text);
		}
	});
	host.host(message("same"));
	host.host(message("same"));
	await until(() => callbacks === 2);
	expect(delivered).toEqual(["same"]);
	expect(db.outbox.rows()).toHaveLength(1);
});

test("RT02 every contradictory correlation is dropped; only uncorrelated idle survives", async () => {
	const host = new Host();
	const frames: TailFrame[] = [];
	await attached(host, (frame) => {
		frames.push(frame);
	});
	host.host(message("both wrong", { commandId: "other", turnId: "other" }));
	host.host(message("command wrong", { ...ids, commandId: "other" }));
	host.host(message("turn wrong", { ...ids, turnId: "other" }));
	host.host(message("uncorrelated", {}));
	host.host({ type: "activity", state: "idle" });
	host.host(message("sentinel"));
	await until(() => frames.some((frame) => frame.assistantText === "sentinel"));
	expect(frames.map((frame) => frame.assistantText ?? frame.rawKind)).toEqual(["activity", "sentinel"]);
});

test("RT03 stale pre-receipt agent_end is adopted but receipt replaces both correlation ids", async () => {
	const host = new Host();
	const frames: TailFrame[] = [];
	const handle = await attached(host, (frame) => {
		frames.push(frame);
	});
	handle.beginTurn("next");
	host.host({ type: "agent_end", commandId: "old-command", turnId: "old-turn" });
	await until(() => frames.length === 1);
	expect(frames[0]?.idle).toBe(true);
	handle.correlate("next", ids);
	host.host(message("real"));
	host.host(message("old", { commandId: "old-command", turnId: "old-turn" }));
	await until(() => frames.length === 2);
	expect(frames.map((frame) => frame.assistantText ?? frame.rawKind)).toEqual(["agent_end", "real"]);
});

test("RT03b an uncorrelated agent_end on a correlated turn reaches the actor only as an uncorrelated idle frame", async () => {
	const host = new Host();
	const frames: TailFrame[] = [];
	await attached(host, (frame) => {
		frames.push(frame);
	});
	host.host(message("mid-work"));
	host.host({ type: "agent_end" });
	host.host(message("sentinel"));
	await until(() => frames.some((frame) => frame.assistantText === "sentinel"));
	const end = frames.find((frame) => frame.rawKind === "agent_end");
	expect(frames.map((frame) => frame.assistantText ?? frame.rawKind)).toEqual(["mid-work", "agent_end", "sentinel"]);
	expect(end).toMatchObject({ idle: true });
	expect(end?.commandId).toBeUndefined();
	expect(end?.turnId).toBeUndefined();
});

test("RT04 relay death rejects in-flight send before receipt", async () => {
	const host = new Host((frame, stream) => {
		if (frame.type === "control_request") stream.close();
	});
	const { port, input } = await broker(host);
	await expect(port.send(input)).rejects.toBeInstanceOf(RelayClosedError);
	expect(host.written.filter((frame) => frame.type === "control_request")).toHaveLength(1);
});
for (const state of ["unknown", "accepted", "in_flight"] as const) {
	test(`RT04 actor reconciles ${state} before any resend after torn send`, async () => {
		const port = new ScriptedSessionPort();
		const sequence: string[] = [];
		port.send = async (input) => {
			port.sendAttempts.push(input);
			sequence.push("send");
			throw new RelayClosedError(input.sessionId, "before receipt", true);
		};
		port.status = async (input) => {
			sequence.push("status");
			return { operationRef: input.opRef, status: { status: state }, summaryCompleted: false };
		};
		const f = await actor(port);
		await f.enqueue("trigger");
		expect(sequence).toEqual(["send", "status"]);
		const op = port.sendAttempts[0]!.opRef;
		expect(f.db.inbox.turnRow(op)?.turn_state).toBe(state === "unknown" ? "bound" : "accepted");
		if (state === "unknown") expect(f.logs.some((line) => line.includes("operation_state_unknown"))).toBe(true);
		expect(f.released).toEqual([]);
	});
}

test("RT05 relay loss after interim settles original output once without replaying interim", async () => {
	const f = await actor();
	await f.enqueue("trigger");
	const send = f.port.sends[0]!;
	f.port.emitAssistant(send.sessionId, "interim");
	await until(() => f.speech.length === 1);
	f.port.loseRelay(send.opRef);
	await until(() => f.logs.some((line) => line.includes("reason=relay_lost_mid_turn")));
	f.port.seedOperation(send.opRef, send.sessionId, "terminal_ok", "final");
	await f.manager.reconcile(key);
	await f.manager.reconcile(key);
	expect(f.terminal).toEqual(["final"]);
	expect(f.speech).toEqual(["interim"]);
	expect(f.port.workerOutputReads).toHaveLength(1);
	expect(f.port.sends).toHaveLength(1);
});

test("RT05b (#228) an idle broadcast on a reopened relay never settles the turn with its mid-work line as the answer", async () => {
	const f = await actor();
	await f.enqueue("trigger");
	const send = f.port.sends[0]!;
	f.port.emitAssistant(send.sessionId, "Now canonicalizing.");
	await until(() => f.speech.length === 1);
	f.port.loseRelay(send.opRef);
	await until(() => f.logs.some((line) => line.includes("reason=relay_lost_mid_turn")));
	// The final body was streamed while the relay was down; the reopened
	// connection is not the turn's owner and only sees the session going idle.
	const body = "FINAL ".repeat(3000).trim();
	f.port.seedOperation(send.opRef, send.sessionId, "terminal_ok", body);
	for (const tail of f.port.tailsOf(send.sessionId))
		tail.emit({ kind: "activity", rawKind: "activity", payload: { state: "idle" }, steerEcho: false, idle: true });
	await until(() => f.terminal.length === 1);
	expect(f.terminal).toEqual([body]);
	expect(f.port.workerOutputReads).toHaveLength(1);
	expect(f.logs.some((line) => line.includes("tail_evidence=unavailable"))).toBe(true);
});

test("RT05c an uncorrelated agent_end on the live owner relay never settles the turn with its mid-work line as the answer", async () => {
	const f = await actor();
	await f.enqueue("trigger");
	const send = f.port.sends[0]!;
	f.port.emitAssistant(send.sessionId, "Now canonicalizing.");
	await until(() => f.speech.length === 1);
	// The relay is still the turn's owner, but the host's lifecycle end arrives
	// without commandId/turnId and the final message never reached this relay.
	const body = "FINAL ".repeat(3000).trim();
	f.port.seedOperation(send.opRef, send.sessionId, "terminal_ok", body);
	for (const tail of f.port.tailsOf(send.sessionId))
		tail.emit({
			kind: "agent_end",
			rawKind: "agent_end",
			payload: { outcome: { reason: "end_turn" } },
			steerEcho: false,
			idle: true,
		});
	await until(() => f.terminal.length === 1);
	expect(f.terminal).toEqual([body]);
	expect(f.port.workerOutputReads).toHaveLength(1);
	expect(f.logs.some((line) => line.includes("tail_evidence=unavailable"))).toBe(true);
});

test("RT05d a correlated agent_end on the owner relay still settles from the tail without a status grace", async () => {
	const f = await actor();
	await f.enqueue("trigger");
	const send = f.port.sends[0]!;
	f.port.complete(send.opRef, "final from tail");
	await until(() => f.terminal.length === 1);
	expect(f.terminal).toEqual(["final from tail"]);
	expect(f.port.workerOutputReads).toHaveLength(0);
	expect(f.logs.some((line) => line.includes("tail_evidence=unavailable"))).toBe(false);
	expect(f.logs.some((line) => line.includes("reason=tail_terminal_evidence_unavailable"))).toBe(false);
});

test("RT05e an uncorrelated agent_failed on the owner relay fails the turn once, from status", async () => {
	const f = await actor();
	await f.enqueue("trigger");
	const send = f.port.sends[0]!;
	f.port.emitAssistant(send.sessionId, "Checking the order.");
	await until(() => f.speech.length === 1);
	f.port.seedOperation(send.opRef, send.sessionId, "failed");
	for (const tail of f.port.tailsOf(send.sessionId))
		tail.emit({
			kind: "agent_failed",
			rawKind: "agent_failed",
			payload: { error: { code: "sdk_failed" } },
			steerEcho: false,
			idle: true,
		});
	await until(() => f.failures.length === 1);
	// The failure settled after the status grace; later reconciles must not fail the turn again.
	await Bun.sleep(400);
	await f.manager.reconcile(key);
	expect(f.failures).toHaveLength(1);
	expect(f.terminal).toEqual([]);
	expect(f.logs.some((line) => line.includes("reason=tail_terminal_evidence_unavailable"))).toBe(true);
});

test("RT05f an uncorrelated agent_end whose status read fails settles on a later reconcile, not from the mid-work line", async () => {
	const port = new ScriptedSessionPort();
	const status = port.status.bind(port);
	let statusFailures = 1;
	port.status = async (input) => {
		if (statusFailures > 0) {
			statusFailures--;
			throw new Error("status relay unavailable");
		}
		return status(input);
	};
	const f = await actor(port);
	await f.enqueue("trigger");
	const send = f.port.sends[0]!;
	f.port.emitAssistant(send.sessionId, "Now canonicalizing.");
	await until(() => f.speech.length === 1);
	const body = "final from the operation";
	f.port.seedOperation(send.opRef, send.sessionId, "terminal_ok", body);
	for (const tail of f.port.tailsOf(send.sessionId))
		tail.emit({
			kind: "agent_end",
			rawKind: "agent_end",
			payload: { outcome: { reason: "end_turn" } },
			steerEcho: false,
			idle: true,
		});
	await until(() => statusFailures === 0);
	await Bun.sleep(50);
	expect(f.terminal).toEqual([]);
	await f.manager.reconcile(key);
	await until(() => f.terminal.length === 1);
	expect(f.terminal).toEqual([body]);
});

test("RT04 unknown bound operation survives repeated live-idle sweeps until its original native terminal", async () => {
	const port = new ScriptedSessionPort();
	Object.assign(port, { queueEmpty: async () => true });
	let statuses = 0;
	let firstOp = "";
	const send = port.send.bind(port);
	port.send = async (input) => {
		if (firstOp) return send(input);
		firstOp = input.opRef;
		port.sendAttempts.push(input);
		throw new RelayClosedError(input.sessionId, "before receipt", true);
	};
	const status = port.status.bind(port);
	port.status = async (input) => {
		statuses++;
		return status(input);
	};
	const f = await actor(port);
	await f.enqueue("trigger");
	expect(statuses).toBe(1);
	expect(f.released).toEqual([]);
	expect(port.sendAttempts).toHaveLength(1);
	const first = port.sendAttempts[0]!;
	for (let sweep = 0; sweep < 3; sweep++) await f.manager.reconcile(key);
	expect(statuses).toBeGreaterThanOrEqual(4);
	expect(f.released).toEqual([]);
	expect(f.terminal).toEqual([]);
	expect(port.sendAttempts).toHaveLength(1);
	expect(port.sends).toEqual([]);
	expect(port.binds).toHaveLength(1);
	expect(f.db.inbox.turnRow(firstOp)).toMatchObject({
		state: "pending",
		turn_state: "bound",
		turn_op_ref: firstOp,
		bound_session_id: first.sessionId,
		turn_epoch: 0,
	});
	expect(f.db.bindings.getSessionRecord(key)).toMatchObject({ epoch: 0, sessionId: first.sessionId });
	expect(f.db.inbox.pendingCount(key)).toBe(1);
	port.seedOperation(firstOp, first.sessionId, "terminal_ok", "original native output");
	await f.manager.reconcile(key);
	await f.manager.reconcile(key);
	await until(() => f.terminal.length === 1);
	await f.manager.reconcile(key);
	expect(f.terminal).toEqual(["original native output"]);
	expect(port.workerOutputReads).toHaveLength(1);
	expect(port.workerOutputReads[0]).toMatchObject({ sessionId: first.sessionId, opRef: firstOp });
	expect(f.db.inbox.turnRow(firstOp)?.turn_state).toBe("done");
	expect(f.db.inbox.pendingCount(key)).toBe(0);
	expect(port.sendAttempts).toHaveLength(1);
	expect(f.released).toEqual([]);
});

test("RT06 status query timeout keeps actor accepted and held", async () => {
	const host = new Host();
	const real = await broker(host);
	await expect(real.port.status(real.input)).rejects.toBeInstanceOf(RelayRequestTimeoutError);
	const f = await actor();
	await f.enqueue("trigger");
	let sawRelay = false;
	f.port.status = async (input) => {
		sawRelay ||= "relay" in input;
		return real.port.status(real.input);
	};
	await f.manager.reconcile(key);
	expect(sawRelay).toBe(true);
	expect(f.logs.some((line) => line.includes("reason=status_unavailable"))).toBe(true);
	expect(f.db.inbox.turnRow(f.port.sends[0]!.opRef)?.turn_state).toBe("accepted");
	expect(f.port.sends).toHaveLength(1);
	expect(f.released).toEqual([]);
});

for (const accepts of [true, false]) {
	test(`RT07 busy retries retain clientRef; accepts=${accepts}`, async () => {
		let now = 0;
		let attempts = 0;
		let accepted = 0;
		const host = new Host((frame, stream) => {
			if (frame.type !== "control_request") return;
			attempts++;
			const ok = accepts && attempts === 3;
			if (ok) accepted++;
			stream.answer(frame, { accepted: true, ...ids }, ok ? undefined : "busy");
		});
		const { port, input } = await broker(host, {
			now: () => now,
			sleep: async (ms) => {
				now += ms;
			},
		});
		if (accepts) expect(await port.send({ ...input, busyWaitMs: 4000 })).toMatchObject(ids);
		else await expect(port.send({ ...input, busyWaitMs: 4000 })).rejects.toThrow("busy");
		expect(attempts).toBe(3);
		expect(accepted).toBe(accepts ? 1 : 0);
		expect(host.written.filter((frame) => frame.type === "control_request").map((frame) => frame.input)).toEqual(
			Array.from({ length: 3 }, () => ({ text: "work", clientRef: input.opRef })),
		);
	});
}

test("RT08 client_ref_conflict is typed and actor queries status without resending", async () => {
	const host = new Host((frame, stream) => stream.answer(frame, {}, "client_ref_conflict"));
	const real = await broker(host);
	await expect(real.port.send(real.input)).rejects.toMatchObject({
		name: "OpRefRejectedError",
		code: "client_ref_conflict",
	});
	const port = new ScriptedSessionPort();
	let statuses = 0;
	port.send = async (input) => {
		port.sendAttempts.push(input);
		throw new OpRefRejectedError(input.opRef, "client_ref_conflict", {});
	};
	port.status = async (input) => {
		statuses++;
		return { operationRef: input.opRef, status: { status: "in_flight" }, summaryCompleted: false };
	};
	const f = await actor(port);
	await f.enqueue("trigger");
	expect(statuses).toBe(1);
	expect(port.sendAttempts).toHaveLength(1);
	expect(f.logs.some((line) => line.includes("recovery_client_ref_conflict"))).toBe(true);
});

test("RT09 steer uses owned connection and held steer replay retains clientRef without owned relay", async () => {
	const host = new Host((frame, stream) => {
		const input = frame.input as Record<string, unknown>;
		stream.answer(frame, { accepted: true, clientRef: input.clientRef });
	});
	const real = await broker(host);
	await real.port.steer({ ...real.input, clientRef: "steer-ref" });
	expect(host.written.at(-1)).toMatchObject({
		type: "control_request",
		operation: "turn.steer",
		connectionId: "connection-owned",
		input: { clientRef: "steer-ref" },
	});
	expect(host.closed).toBe(false);
	let accept = false;
	const port = new ScriptedSessionPort({
		onSteer: () => {
			if (!accept) throw new RelayClosedError("s", "torn", true);
		},
	});
	const f = await actor(port);
	await f.enqueue("trigger");
	await f.enqueue("steer");
	expect(port.steers.length).toBeGreaterThan(1);
	expect(port.steers[0]?.relay).toBe(port.sends[0]?.relay);
	accept = true;
	port.complete(port.sends[0]!.opRef, "done");
	await until(() => f.terminal.length === 1);
	await f.manager.reconcile(key);
	expect(new Set(port.steers.map((input) => input.clientRef)).size).toBe(1);
	expect(port.steers.at(-1)?.relay).toBeUndefined();
});

test("RT10 retired capacity refuses while current attach waits for running owner to close", async () => {
	const hosts: Host[] = [];
	const tail = new TailRunner({
		repo: "/tmp",
		maxTailProcesses: 1,
		log: () => {},
		stream: () => {
			const host = new Host();
			hosts.push(host);
			return host;
		},
	});
	const first = await tail.attach({ sessionId: "first", brokerGeneration: 1, repo: "/tmp" });
	cleanups.push(() => first.close());
	first.setTurnRunning(true);
	await expect(
		tail.attach({ sessionId: "retired", brokerGeneration: 1, repo: "/tmp", priority: "retired" }),
	).rejects.toBeInstanceOf(TailCapacityError);
	let done = false;
	const pending = tail.attach({ sessionId: "current", brokerGeneration: 1, repo: "/tmp" }).then((handle) => {
		done = true;
		return handle;
	});
	await Bun.sleep(5);
	expect(done).toBe(false);
	await first.close();
	const second = await pending;
	cleanups.push(() => second.close());
	expect(hosts).toHaveLength(2);
});

test("RT11 malformed and oversized stdout lines do not prevent later frames", async () => {
	const host = new Host();
	const speech: string[] = [];
	await attached(host, (frame) => {
		if (frame.assistantText) speech.push(frame.assistantText);
	});
	host.raw("{not-json");
	host.host({ type: "ignored", padding: "x".repeat(256 * 1024 + 1) });
	host.host(message("after"));
	await until(() => speech.length === 1);
	expect(speech).toEqual(["after"]);
	expect(host.closed).toBe(false);
});

test("RT12 stream ends without hello and pre-hello eviction both reject readiness", async () => {
	const host = new Host(undefined, false);
	const pending = runner(host).attach({ sessionId: "s", brokerGeneration: 1, repo: "/tmp" });
	await until(() => host.written.length === 1);
	host.close();
	await expect(pending).rejects.toThrow("hello");
	const first = new Host(undefined, false);
	const second = new Host();
	let spawns = 0;
	const tail = new TailRunner({ repo: "/tmp", maxTailProcesses: 1, stream: () => (++spawns === 1 ? first : second) });
	const unready = tail.attach({ sessionId: "unready", brokerGeneration: 1, repo: "/tmp" }).then(
		() => undefined,
		(error: unknown) => error,
	);
	await until(() => first.written.length === 1);
	const ready = await tail.attach({ sessionId: "ready", brokerGeneration: 1, repo: "/tmp" });
	cleanups.push(() => ready.close());
	expect(await unready).toMatchObject({ message: "tail unready was closed before readiness" });
});

test("RT13 fifty synchronous frames preserve order through a slow asynchronous consumer", async () => {
	const host = new Host();
	const seen: number[] = [];
	await attached(host, async (frame) => {
		const n = Number(frame.assistantText);
		if (n % 3 === 0) await Bun.sleep(2);
		seen.push(n);
	});
	for (let i = 0; i < 50; i++) host.host(message(String(i)));
	await until(() => seen.length === 50);
	expect(seen).toEqual(Array.from({ length: 50 }, (_, index) => index));
});

test("RT14 work start survives observer spawn failure, sends once without relay and settles by status", async () => {
	const { db, home } = await database();
	const gajaewayHome = join(home, "gajaeway");
	const port = new ScriptedSessionPort({ sessionIdForBind: () => crypto.randomUUID() });
	attachTestBrokerOwnership(db, port, join(home, "agent"));
	port.attachTail = async () => {
		throw new Error("spawner failed");
	};
	const manager = new WorkLaneManager({
		database: db,
		port,
		lanes: new LaneGovernor({ database: db, sessionPort: port, laneRoot: gajaewayHome, maxLanes: 1 }),
		gajaewayHome,
		serviceDirectory: join(home, "service"),
		pollMs: 5,
		waitTimeoutMs: 1000,
	});
	cleanups.push(() => manager.stop());
	const result = await manager.start({ name: "redteam", text: "work", cwd: home });
	expect(result.started).toBe(true);
	if (!result.started) throw new Error("work held");
	expect(port.sends).toHaveLength(1);
	expect(port.sends[0]?.relay).toBeUndefined();
	port.seedOperation(result.opRef, result.sessionId, "terminal_ok", "work result");
	await until(() => db.work.workAttemptGet(result.opRef)?.settledAt != null);
	expect(port.sendAttempts).toHaveLength(1);
	expect(port.workerOutputReads).toHaveLength(1);
});

test("work session activity survives loss of the submitting relay without claiming turn ownership", async () => {
	const { db, home } = await database();
	const gajaewayHome = join(home, "gajaeway");
	const port = new ScriptedSessionPort({ sessionIdForBind: () => crypto.randomUUID() });
	attachTestBrokerOwnership(db, port, join(home, "agent"));
	const hosts: Host[] = [];
	const tail = new TailRunner({
		repo: home,
		sleep: async () => {},
		stream: () => {
			const host = new Host(undefined, true, `connection-${hosts.length}`);
			hosts.push(host);
			return host;
		},
	});
	port.attachTail = (input) => tail.attach(input);
	let now = Date.now();
	const manager = new WorkLaneManager({
		database: db,
		port,
		lanes: new LaneGovernor({ database: db, sessionPort: port, laneRoot: gajaewayHome, maxLanes: 1 }),
		gajaewayHome,
		serviceDirectory: join(home, "service"),
		pollMs: 5,
		now: () => now,
	});
	cleanups.push(() => manager.stop());
	const result = await manager.start({ name: "relay-activity", text: "work", cwd: home });
	if (!result.started) throw new Error("work held");
	await until(() => hosts.length === 1 && port.sends.length === 1);
	const correlation = { commandId: `command-${result.opRef}`, turnId: `turn-${result.opRef}` };
	const activity = () =>
		db.bindings.workLaneRows().find((row) => row.origin_key === result.sessionKey)!.last_activity_at;
	// The original submitter receives correlated content and advances activity.
	now += 2_000;
	hosts[0]!.host(message("owned", correlation));
	await until(() => activity() === new Date(now).toISOString());
	const beforeLoss = activity();
	hosts[0]!.close();
	await until(() => hosts.length === 2 && hosts[1]!.written.some((frame) => frame.type === "hello"));
	// SDK publishContentFrames keeps the old invocation connectionId. A fresh
	// connection only gets an uncorrelated copy if BOTH observer caps were offered.
	now += 2_000;
	const hello = hosts[1]!.written.find((frame) => frame.type === "hello")!;
	const caps = hello.capabilities as string[];
	if (caps.includes("turn_stream") && caps.includes("session_host_observer_v1"))
		hosts[1]!.host({ type: "event", kind: "tool_execution_end", payload: { toolCallId: "after-reopen" } });
	await until(() => activity() !== beforeLoss);
	expect(activity()).toBe(new Date(now).toISOString());
	expect(db.work.workAttemptGet(result.opRef)).toMatchObject({ settledAt: null });
	expect(db.work.workAttemptGet(result.opRef)?.turnEndObservedAt).toBeUndefined();
	expect(port.sendAttempts).toHaveLength(1);
	expect(port.workerOutputReads).toHaveLength(0);
	// Observation, hello, and lifecycle broadcasts are not execution progress.
	const observed = activity();
	now += 2_000;
	hosts[1]!.host({ type: "activity", state: "active", at: now });
	hosts[1]!.host({ type: "agent_end" });
	hosts[1]!.host(message("foreign", { commandId: "foreign", turnId: "foreign" }));
	await Bun.sleep(25);
	expect(activity()).toBe(observed);
	expect(db.work.workAttemptGet(result.opRef)?.settledAt).toBeNull();
	expect(db.work.workAttemptGet(result.opRef)?.turnEndObservedAt).toBeUndefined();
});
