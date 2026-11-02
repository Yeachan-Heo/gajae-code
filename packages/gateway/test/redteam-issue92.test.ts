import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BrokerSession } from "@gajae-gateway/subsession";
import { OpRefRejectedError } from "@gajae-gateway/subsession";
import { parseConfigFile } from "../src/config";
import { PersonaSessionManager, personaTurnOpRef } from "../src/orchestrator/persona-session";
import type { SessionSendInput, SessionSteerInput } from "../src/orchestrator/session-port";
import { RelayRefusedError } from "../src/orchestrator/tail-runner";
import { Store } from "../src/store";
import type { InboundTurn } from "../src/store/groups/inbox";
import { attachTestBrokerOwnership, ScriptedSessionPort, steerRefused } from "./session-port.fake";

const ORIGIN = { platform: "loopback", kind: "loopback", conversationId: "issue92-redteam" } as const;
const ORIGIN_KEY = "loopback/loopback/issue92-redteam";
const SOURCE_ROOT = join(import.meta.dir, "../src");

type Fixture = {
	readonly home: string;
	readonly database: Store;
	readonly manager: PersonaSessionManager;
	readonly port: ScriptedSessionPort;
	readonly turns: Map<string, InboundTurn>;
	readonly discarded: string[];
	readonly logs: string[];
	readonly terminal: string[];
	close(): Promise<void>;
};

type FixtureOptions = {
	readonly port?: ScriptedSessionPort;
	readonly now?: () => number;
	readonly setTimeout?: (work: () => void, delayMs: number) => unknown;
	readonly clearTimeout?: (timer: unknown) => void;
	readonly brokerGeneration?: () => number;
};

async function eventually(predicate: () => boolean, message: string): Promise<void> {
	for (let attempt = 0; attempt < 400; attempt++) {
		if (predicate()) return;
		await Bun.sleep(5);
	}
	expect(predicate(), message).toBe(true);
}

function required<T>(value: T | undefined, message: string): T {
	if (value === undefined) throw new Error(message);
	return value;
}

async function fixture(options: FixtureOptions = {}): Promise<Fixture> {
	const home = await mkdtemp(join(tmpdir(), "gajaeway-issue92-redteam-"));
	const database = await Store.open(join(home, "gateway.db"));
	const port =
		options.port ?? new ScriptedSessionPort({ onBind: (input) => `${input.originKey}-session-${input.epoch}` });
	attachTestBrokerOwnership(database, port, join(home, "canonical-agent"));
	const turns = new Map<string, InboundTurn>();
	const discarded: string[] = [];
	const logs: string[] = [];
	const terminal: string[] = [];
	const manager = new PersonaSessionManager({
		database,
		port,
		instanceId: "issue92-redteam",
		repo: join(home, "workspace"),
		...(options.now ? { now: options.now } : {}),
		...(options.setTimeout ? { setTimeout: options.setTimeout } : {}),
		...(options.clearTimeout ? { clearTimeout: options.clearTimeout } : {}),
		...(options.brokerGeneration ? { brokerGeneration: options.brokerGeneration } : {}),
		onTurnStart: ({ turn, trigger }) => {
			turns.set(turn.opRef, turn);
			return {
				text: trigger.body,
				onTerminal: ({ text }) => {
					terminal.push(text);
				},
			};
		},
		onInboundDiscard: (messageIds) => {
			discarded.push(...messageIds);
		},
		log: (line) => {
			logs.push(line);
		},
	});
	return {
		home,
		database,
		manager,
		port,
		turns,
		discarded,
		logs,
		terminal,
		async close() {
			await manager.stop();
			database.close();
			await rm(home, { recursive: true, force: true });
		},
	};
}

function enqueue(target: Fixture, messageId: string, body: string, receivedAt = new Date().toISOString()): void {
	expect(
		target.database.transaction((tx) =>
			target.database.inbox.enqueue(tx, {
				messageId,
				originKey: ORIGIN_KEY,
				originRefJson: JSON.stringify(ORIGIN),
				body,
				receivedAt,
			}),
		),
	).toBe(true);
}

function assertCoverage(target: Fixture, messageIds: readonly string[]): void {
	const rows = [...target.turns.values()].flatMap((turn) => target.database.inbox.turnRows(turn.opRef));
	expect(rows.map((row) => row.message_id).sort()).toEqual([...messageIds].sort());
	expect(new Set(rows.map((row) => row.message_id)).size).toBe(messageIds.length);
	for (const row of rows)
		expect(row).toMatchObject({
			state: "done",
			turn_state: "done",
			turn_op_ref: expect.any(String),
		});
	expect(target.database.inbox.pendingCount(ORIGIN_KEY)).toBe(0);
}

class FailFirstSteerPort extends ScriptedSessionPort {
	steerAttempts = 0;

	constructor() {
		// Epoch-keyed binds: a rebound epoch gets a NEW session, as the broker does.
		super({ onBind: (input) => `${input.originKey}-session-${input.epoch}` });
	}

	async steer(input: SessionSteerInput): Promise<void> {
		this.steerAttempts++;
		if (this.steerAttempts === 1) throw steerRefused("session rejected the steer");
		await super.steer(input);
	}
}

class IntermittentSteerPort extends ScriptedSessionPort {
	readonly #failAttempts: ReadonlySet<number>;
	steerAttempts = 0;

	constructor(failAttempts: ReadonlySet<number>) {
		super({ onBind: (input) => `${input.originKey}-session-${input.epoch}` });
		this.#failAttempts = failAttempts;
	}

	async steer(input: SessionSteerInput): Promise<void> {
		this.steerAttempts++;
		if (this.#failAttempts.has(this.steerAttempts)) throw steerRefused(`scripted refusal ${this.steerAttempts}`);
		await super.steer(input);
	}
}

class ConflictUnknownPort extends ScriptedSessionPort {
	attempts = 0;

	async send(input: SessionSendInput) {
		this.attempts++;
		if (this.attempts === 1) {
			this.sendAttempts.push(input);
			throw new OpRefRejectedError(input.opRef, "client_ref_conflict", { code: "client_ref_conflict" });
		}
		return await super.send(input);
	}

	async queueEmpty(): Promise<boolean> {
		return true;
	}
}

class IdleRecoveryPort extends ScriptedSessionPort {
	readonly calls: string[] = [];

	async resume(input: Parameters<ScriptedSessionPort["resume"]>[0]) {
		this.calls.push(`resume:${input.sessionId}`);
		return await super.resume(input);
	}

	async send(input: SessionSendInput) {
		this.calls.push(`send:${input.sessionId}`);
		return await super.send(input);
	}
}

class InspectUnavailableIdleRecoveryPort extends IdleRecoveryPort {
	async inspect(input: Parameters<ScriptedSessionPort["inspect"]>[0]): Promise<BrokerSession | undefined> {
		await super.inspect(input);
		throw new Error("scripted inspect transport outage");
	}
}

async function sourceFiles(directory: string): Promise<string[]> {
	const entries = await readdir(directory, { withFileTypes: true });
	const files: string[] = [];
	for (const entry of entries) {
		const path = join(directory, entry.name);
		if (entry.isDirectory()) files.push(...(await sourceFiles(path)));
		else if (entry.isFile() && path.endsWith(".ts")) files.push(path);
	}
	return files;
}

test("red-team: relay loss holds the accepted turn until status and turn.result settle it", async () => {
	const port = new ScriptedSessionPort({ onBind: (input) => `${input.originKey}-session-${input.epoch}` });
	const target = await fixture({ port });
	try {
		enqueue(target, "lost-relay-trigger", "keep the turn open");
		await target.manager.notifyInbound(ORIGIN_KEY);
		await eventually(() => port.sends.length === 1, "initial batch did not start");
		const send = required(port.sends[0], "initial send missing");
		const batch = target.turns.values().next().value as InboundTurn;

		port.loseRelay(send.opRef);
		await eventually(
			() =>
				target.logs.some((line) => line.startsWith("recovery_hold ") && line.includes("reason=relay_lost_mid_turn")),
			"relay loss was not observed",
		);
		expect(target.manager.state(ORIGIN_KEY)).toBe("turn-running");
		expect(port.sends).toHaveLength(1);
		expect(target.database.inbox.turnRows(batch.opRef)).toEqual(
			expect.arrayContaining([expect.objectContaining({ state: "pending", turn_state: "accepted" })]),
		);

		port.completeWithoutAnswerFrame(send.opRef, "terminal result evidence");
		await target.manager.tick(ORIGIN_KEY);
		await eventually(
			() => target.database.inbox.pendingCount(ORIGIN_KEY) === 0,
			"lost relay turn did not settle from status",
		);
		expect(target.terminal).toEqual(["terminal result evidence"]);
		expect(port.workerOutputReads.some((input) => input.opRef === send.opRef)).toBe(true);
		expect(port.sends).toHaveLength(1);
		assertCoverage(target, ["lost-relay-trigger"]);
	} finally {
		await target.close();
	}
});

test("red-team: a stale death notice from a finished turn's relay never detaches the next turn's live relay", async () => {
	const port = new ScriptedSessionPort({ onBind: (input) => `${input.originKey}-session-${input.epoch}` });
	const target = await fixture({ port });
	try {
		enqueue(target, "first-trigger", "first");
		await target.manager.notifyInbound(ORIGIN_KEY);
		await eventually(() => port.sends.length === 1, "first send missing");
		const first = required(port.sends[0], "first send missing");
		const firstRelay = port.tailsOf(first.sessionId)[0];
		const lateDeath = firstRelay!.captureDeathNotice();
		port.complete(first.opRef, "first answer");
		await eventually(() => target.database.inbox.pendingCount(ORIGIN_KEY) === 0, "first turn did not settle");

		enqueue(target, "second-trigger", "second");
		await target.manager.notifyInbound(ORIGIN_KEY);
		await eventually(() => port.sends.length === 2, "second send missing");
		const second = required(port.sends[1], "second send missing");
		expect(second.sessionId).toBe(first.sessionId);
		// The same connection can be reused; the notice still carries the turn
		// identity from when transport failure was received, before the successor.
		lateDeath();
		await Bun.sleep(20);
		expect(target.logs.filter((line) => line.includes("reason=relay_dead"))).toEqual([]);
		// The live turn still streams and completes over its own relay.
		port.emitAssistant(second.sessionId, "second interim");
		port.complete(second.opRef, "second answer");
		await eventually(() => target.database.inbox.pendingCount(ORIGIN_KEY) === 0, "second turn did not settle");
		expect(target.terminal).toEqual(["first answer", "second answer"]);
		expect(target.logs.filter((line) => line.includes("terminal_status_reconciled"))).toEqual([]);
		expect(port.sends).toHaveLength(2);
	} finally {
		await target.close();
	}
});

test("red-team: a relay refused at attach (endpoint_stale) rebinds on a fresh epoch and never holds the message", async () => {
	class StaleFirstPort extends ScriptedSessionPort {
		refusals = 0;
		override async attachTail(input: Parameters<ScriptedSessionPort["attachTail"]>[0]) {
			if (this.refusals === 0) {
				this.refusals += 1;
				throw new RelayRefusedError(input.sessionId, "endpoint_stale", "endpoint is not live");
			}
			return await super.attachTail(input);
		}
	}
	const port = new StaleFirstPort({ onBind: (input) => `${input.originKey}-session-${input.epoch}` });
	const target = await fixture({ port });
	try {
		enqueue(target, "stale-attach-trigger", "hello after a stale endpoint");
		await target.manager.notifyInbound(ORIGIN_KEY);
		await eventually(() => port.sends.length === 1, "the message was not dispatched after the stale relay");
		expect(port.refusals).toBe(1);
		expect(target.logs.some((line) => line.startsWith("send_session_disowned action=inline_rebind stage=attach"))).toBe(
			true,
		);
		// The stale session's binding was rotated: the send rode a NEW session.
		expect(port.sends[0]!.sessionId).toBe(`${ORIGIN_KEY}-session-1`);
		port.complete(port.sends[0]!.opRef, "answer on the fresh session");
		await eventually(() => target.database.inbox.pendingCount(ORIGIN_KEY) === 0, "turn did not settle");
		expect(target.terminal).toEqual(["answer on the fresh session"]);
		expect(target.logs.some((line) => line.includes("host hello did not arrive"))).toBe(false);
	} finally {
		await target.close();
	}
});

test("red-team: a relay declared dead settles the turn from CLI status without a tick and never re-sends", async () => {
	const port = new ScriptedSessionPort({ onBind: (input) => `${input.originKey}-session-${input.epoch}` });
	const target = await fixture({ port });
	try {
		enqueue(target, "dead-relay-trigger", "keep the turn open");
		await target.manager.notifyInbound(ORIGIN_KEY);
		await eventually(() => port.sends.length === 1, "initial batch did not start");
		const send = required(port.sends[0], "initial send missing");

		port.killRelay(send.opRef);
		await eventually(
			() => target.logs.some((line) => line.startsWith("recovery_hold ") && line.includes("reason=relay_dead")),
			"relay death was not observed",
		);
		expect(target.manager.state(ORIGIN_KEY)).toBe("turn-running");
		// The turn's end arrives only through status; no relay will announce it
		// and no explicit tick is issued: the actor's own recheck must find it.
		port.completeWithoutAnswerFrame(send.opRef, "terminal after relay death");
		await eventually(
			() => target.database.inbox.pendingCount(ORIGIN_KEY) === 0,
			"dead-relay turn did not settle from status on its own recheck",
		);
		expect(target.terminal).toEqual(["terminal after relay death"]);
		expect(port.sends).toHaveLength(1);
		expect(target.logs.filter((line) => line.includes("status_unavailable"))).toEqual([]);
		assertCoverage(target, ["dead-relay-trigger"]);
	} finally {
		await target.close();
	}
});

test("canonical: a refused steer stays pending until the running turn terminates, then sends exactly once on the same session", async () => {
	const port = new FailFirstSteerPort();
	const target = await fixture({ port });
	try {
		enqueue(target, "steer-trigger", "initial prompt");
		await target.manager.notifyInbound(ORIGIN_KEY);
		await eventually(() => port.sends.length === 1, "initial batch did not start");
		const first = required(port.sends[0], "initial steer send missing");
		const firstEpoch = required(target.turns.values().next().value, "first batch missing").epoch;

		enqueue(target, "steer-after-death", "must remain durable");
		await target.manager.notifyInbound(ORIGIN_KEY);
		expect(port.steerAttempts).toBe(1);
		expect(port.steers).toEqual([]);
		expect(target.logs.filter((line) => line.startsWith("steer_failed"))).toHaveLength(1);
		expect(target.logs.filter((line) => line.startsWith("session_rebound_after_steer_failure"))).toHaveLength(0);
		expect(port.sends).toHaveLength(1);
		expect(port.binds.map((bind) => bind.epoch)).toEqual([firstEpoch]);
		expect(target.database.inbox.turnRow(first.opRef)?.turn_state).toBe("accepted");
		expect(target.database.inbox.pendingOldest(ORIGIN_KEY)).toMatchObject({ message_id: "steer-after-death" });
		await target.manager.onBrokerGeneration(2);
		expect(port.sends).toHaveLength(1);
		port.complete(first.opRef, "first terminal");
		await target.manager.tick(ORIGIN_KEY);
		await eventually(() => target.terminal.includes("first terminal"), "current turn's answer was dropped");
		await eventually(() => port.sends.length === 2, "refused steer row was not sent after terminal");
		const second = required(port.sends[1], "pending send missing");
		expect(second.text).toBe("must remain durable");
		expect(second.sessionId).toBe(first.sessionId);
		expect(port.binds.map((bind) => bind.epoch)).toEqual([firstEpoch]);
		expect(port.sendAttempts.map((input) => input.opRef)).toHaveLength(2);
		port.complete(second.opRef, "second terminal");
		await eventually(
			() => target.database.inbox.pendingCount(ORIGIN_KEY) === 0,
			"steer-failure sequence left pending rows",
		);
		expect(target.terminal).toEqual(["first terminal", "second terminal"]);
		assertCoverage(target, ["steer-trigger", "steer-after-death"]);
	} finally {
		await target.close();
	}
});

test("canonical: a stream of 500ms fragments never waits - the first is the turn, each later one is steered in arrival order, and all are attributed", async () => {
	const port = new ScriptedSessionPort({ onBind: (input) => `${input.originKey}-session-${input.epoch}` });
	const target = await fixture({ port });
	try {
		const base = Date.now();
		for (const [offset, id] of [
			[0, "fragment-0"],
			[500, "fragment-1"],
			[1_000, "fragment-2"],
			[1_500, "fragment-3"],
			[2_000, "fragment-4"],
		] as const) {
			enqueue(target, id, id, new Date(base + offset).toISOString());
			await target.manager.notifyInbound(ORIGIN_KEY);
			await eventually(() => port.sends.length === 1, `fragment ${id} left the origin without a running turn`);
		}
		expect(required(port.sends[0], "first send missing").text).toBe("fragment-0");
		expect(port.steers.map((steer) => steer.text.split("\n").at(-1))).toEqual([
			"fragment-1",
			"fragment-2",
			"fragment-3",
			"fragment-4",
		]);
		port.complete(required(port.sends[0], "first send missing").opRef, "one response");
		await eventually(() => target.database.inbox.pendingCount(ORIGIN_KEY) === 0, "fragments did not complete");
		expect(port.sends).toHaveLength(1);
		expect(target.terminal).toEqual(["one response"]);
		assertCoverage(target, ["fragment-0", "fragment-1", "fragment-2", "fragment-3", "fragment-4"]);
	} finally {
		await target.close();
	}
});

test("red-team: restart after broker acceptance but before durable acceptance reconciles the same op-ref without another send", async () => {
	const port = new ScriptedSessionPort({ onBind: (input) => `${input.originKey}-session-${input.epoch}` });
	const target = await fixture({ port });
	try {
		const receivedAt = new Date().toISOString();
		const repo = join(target.home, "workspace");
		const binding = await port.bind({ originKey: ORIGIN_KEY, epoch: 0, repo });
		expect(target.database.bindings.getSessionRecord(ORIGIN_KEY)).toEqual({ sessionId: binding.sessionId, epoch: 0 });
		enqueue(target, "crash-window", "accepted before attribution", receivedAt);
		const opRef = personaTurnOpRef("issue92-redteam", ORIGIN_KEY, 0, "crash-window");
		target.database.transaction((tx) =>
			target.database.inbox.bindTurn(tx, {
				messageId: "crash-window",
				originKey: ORIGIN_KEY,
				epoch: 0,
				opRef,
				sessionId: binding.sessionId,
			}),
		);
		target.database.transaction((tx) => target.database.inbox.markSendAttempted(tx, opRef));
		port.seedAcceptedSend({ sessionId: binding.sessionId, repo, text: "accepted before attribution", opRef });

		await target.manager.recover();
		expect(port.sendAttempts).toHaveLength(1);
		expect(target.database.inbox.turnRows(opRef)).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ state: "pending", turn_state: "accepted", turn_op_ref: opRef }),
			]),
		);
		port.complete(opRef, "reconciled terminal");
		await target.manager.tick(ORIGIN_KEY);
		await eventually(
			() => target.database.inbox.pendingCount(ORIGIN_KEY) === 0,
			"accepted crash-window batch did not reconcile",
		);
		assertCoverage(target, ["crash-window"]);
	} finally {
		await target.close();
	}
});

test("red-team: /new preserves an accepted batch, discards only unbatched pre-floor work, and fences stale output", async () => {
	const base = Date.parse("2026-09-02T00:00:00.000Z");
	let now = base;
	const port = new ScriptedSessionPort({ onBind: (input) => `${input.originKey}-session-${input.epoch}` });
	const target = await fixture({ port, now: () => now });
	try {
		enqueue(target, "old-trigger", "old accepted", new Date(base).toISOString());
		await target.manager.notifyInbound(ORIGIN_KEY);
		await eventually(() => port.sends.length === 1, "old batch did not start");
		const old = required(port.sends[0], "old epoch send missing");
		const oldBatch = target.turns.values().next().value as InboundTurn;

		enqueue(target, "discard-before-new", "must be discarded", new Date(base + 1).toISOString());
		now = base + 2;
		await target.manager.reset(ORIGIN_KEY, JSON.stringify(ORIGIN), new Date(now).toISOString());
		expect(target.discarded).toEqual(["discard-before-new"]);
		expect(target.database.inbox.turnRows(oldBatch.opRef)).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ message_id: "old-trigger", state: "pending", turn_state: "accepted" }),
			]),
		);

		now = base + 3;
		enqueue(target, "new-trigger", "new epoch", new Date(now).toISOString());
		await target.manager.notifyInbound(ORIGIN_KEY);
		await eventually(() => port.sends.length === 2, "new epoch was blocked by accepted retired work");
		const fresh = required(port.sends[1], "new epoch send missing");
		port.complete(old.opRef, "stale old output");
		port.complete(fresh.opRef, "fresh output");
		await target.manager.tick(ORIGIN_KEY);
		await eventually(
			() => target.database.inbox.pendingCount(ORIGIN_KEY) === 0,
			"/new sequence did not reconcile both batches",
		);
		expect(target.terminal).toEqual(["fresh output"]);
		expect(target.database.inbox.turnRows(oldBatch.opRef)).toEqual(
			expect.arrayContaining([expect.objectContaining({ state: "done", turn_state: "done" })]),
		);
		assertCoverage(target, ["old-trigger", "new-trigger"]);
	} finally {
		await target.close();
	}
});

test("red-team: a stall on a retired hold does not abort it, block the next epoch, or deliver stale output", async () => {
	const port = new ScriptedSessionPort({ onBind: (input) => `${input.originKey}-session-${input.epoch}` });
	const target = await fixture({ port });
	try {
		enqueue(target, "retired-trigger", "old generation");
		await target.manager.notifyInbound(ORIGIN_KEY);
		await eventually(() => port.sends.length === 1, "retired candidate did not start");
		const old = required(port.sends[0], "retired send missing");

		await target.manager.reset(ORIGIN_KEY, JSON.stringify(ORIGIN));
		await Bun.sleep(30);
		port.emitStall(old.sessionId, 120_000);
		await eventually(
			() => target.logs.some((line) => line.includes("reason=stall")),
			"retired stall did not become a durable hold",
		);
		await target.manager.recover();
		enqueue(target, "post-retired-stall", "new generation can proceed");
		await target.manager.notifyInbound(ORIGIN_KEY);
		await eventually(() => port.sends.length === 2, "retired hold blocked new generation");
		const fresh = required(port.sends[1], "post-stall send missing");
		port.complete(fresh.opRef, "fresh generation output");
		port.complete(old.opRef, "stale generation output");
		await target.manager.tick(ORIGIN_KEY);
		await eventually(
			() => target.database.inbox.pendingCount(ORIGIN_KEY) === 0,
			"retired hold did not reconcile terminal",
		);
		expect(target.terminal).toEqual(["fresh generation output"]);
		assertCoverage(target, ["retired-trigger", "post-retired-stall"]);
	} finally {
		await target.close();
	}
});

function assertUnknownOperationHeld(target: Fixture, first: InboundTurn): void {
	expect(target.database.inbox.turnRow(first.opRef)).toMatchObject({
		state: "pending",
		turn_state: "bound",
		turn_op_ref: first.opRef,
		bound_session_id: first.sessionId,
		turn_epoch: first.epoch,
	});
	expect(target.database.bindings.getSessionRecord(ORIGIN_KEY)).toMatchObject({
		epoch: first.epoch,
		sessionId: first.sessionId,
	});
	expect(target.database.inbox.pendingCount(ORIGIN_KEY)).toBe(1);
	expect(target.port.sendAttempts).toHaveLength(1);
	expect(target.port.sends).toEqual([]);
	expect(target.port.binds).toHaveLength(1);
	expect(target.terminal).toEqual([]);
	expect(target.logs.some((line) => line.startsWith("accepted_turn_closed"))).toBe(false);
	expect(target.logs.some((line) => line.includes("unknown_op_on_live_idle_session"))).toBe(false);
	expect(target.logs.some((line) => line.includes("unobserved_answer_delivered"))).toBe(false);
}

async function settleOriginalUnknownOperation(target: Fixture, first: InboundTurn): Promise<void> {
	const sessionId = required(first.sessionId ?? undefined, "original session missing");
	target.port.seedOperation(first.opRef, sessionId, "terminal_ok", "exact original native output");
	await target.manager.tick(ORIGIN_KEY);
	await target.manager.tick(ORIGIN_KEY);
	await eventually(() => target.terminal.length === 1, "original native operation did not settle");
	await target.manager.tick(ORIGIN_KEY);
	expect(target.terminal).toEqual(["exact original native output"]);
	expect(target.database.inbox.turnRow(first.opRef)?.turn_state).toBe("done");
	expect(target.database.inbox.pendingCount(ORIGIN_KEY)).toBe(0);
	expect(target.port.workerOutputReads).toHaveLength(1);
	expect(target.port.workerOutputReads[0]).toMatchObject({ sessionId, opRef: first.opRef });
	expect(target.port.sendAttempts).toHaveLength(1);
	expect(target.port.sends).toEqual([]);
	expect(target.port.binds).toHaveLength(1);
}

test("red-team: an unknown unaccepted send preserves its operation and epoch through repeated live-idle sweeps", async () => {
	const port = new ConflictUnknownPort({ onBind: (input) => `${input.originKey}-session-${input.epoch}` });
	const target = await fixture({ port });
	try {
		enqueue(target, "conflict-trigger", "operation identity is unknown");
		await target.manager.notifyInbound(ORIGIN_KEY);
		await eventually(
			() => target.logs.some((line) => line.startsWith(`recovery_client_ref_conflict origin=${ORIGIN_KEY}`)),
			"client_ref_conflict was not reconciled",
		);
		const first = target.database.inbox.nonterminalTurns(ORIGIN_KEY)[0]!;
		expect(target.database.inbox.turnRows(first.opRef)).toEqual(
			expect.arrayContaining([expect.objectContaining({ message_id: "conflict-trigger", turn_state: "bound" })]),
		);
		expect(target.logs.some((line) => line.includes("reason=operation_state_unknown sweeps=1"))).toBe(true);
		expect(port.sends).toEqual([]);

		// Missing acknowledgement and an empty live queue do not prove non-admission.
		for (let sweep = 0; sweep < 3; sweep++) await target.manager.tick(ORIGIN_KEY);
		assertUnknownOperationHeld(target, first);
		await settleOriginalUnknownOperation(target, first);
	} finally {
		await target.close();
	}
});

class UnobservedAnswerPort extends ConflictUnknownPort {
	/** The answer the persona wrote while the gateway's view of the session was dark. */
	answer: { text: string; atMs: number } | undefined;
	probes = 0;

	async fetchAssistantSince(input: { sessionId: string; repo: string; notBeforeMs: number }) {
		this.probes++;
		if (!this.answer || this.answer.atMs < input.notBeforeMs) return undefined;
		return { text: this.answer.text, pages: 1, complete: true };
	}
}

test("red-team: a post-dispatch transcript timestamp cannot settle or release an unknown native operation", async () => {
	// A session-wide answer is neither native terminal proof nor exact operation output.
	const port = new UnobservedAnswerPort({ onBind: (input) => `${input.originKey}-session-${input.epoch}` });
	const target = await fixture({ port });
	try {
		enqueue(target, "dark-trigger", "answer me while the ring is dark");
		await target.manager.notifyInbound(ORIGIN_KEY);
		await eventually(
			() => target.logs.some((line) => line.startsWith(`recovery_client_ref_conflict origin=${ORIGIN_KEY}`)),
			"client_ref_conflict was not reconciled",
		);
		const first = target.database.inbox.nonterminalTurns(ORIGIN_KEY)[0]!;
		// Even a recent answer could belong to a different invocation.
		port.answer = { text: "written while you were not looking", atMs: Date.now() + 1 };
		for (let sweep = 0; sweep < 3; sweep++) await target.manager.tick(ORIGIN_KEY);
		assertUnknownOperationHeld(target, first);
		expect(port.probes).toBe(0);
		await settleOriginalUnknownOperation(target, first);
		expect(port.probes).toBe(0);
	} finally {
		await target.close();
	}
});

test("red-team: a pre-dispatch transcript row cannot prove an unknown native operation was unaccepted", async () => {
	const port = new UnobservedAnswerPort({ onBind: (input) => `${input.originKey}-session-${input.epoch}` });
	const target = await fixture({ port });
	try {
		port.answer = { text: "the previous turn's answer", atMs: Date.now() - 60_000 };
		enqueue(target, "dark-trigger-2", "nothing new was written");
		await target.manager.notifyInbound(ORIGIN_KEY);
		await eventually(
			() => target.logs.some((line) => line.startsWith(`recovery_client_ref_conflict origin=${ORIGIN_KEY}`)),
			"client_ref_conflict was not reconciled",
		);
		const first = target.database.inbox.nonterminalTurns(ORIGIN_KEY)[0]!;
		for (let sweep = 0; sweep < 3; sweep++) await target.manager.tick(ORIGIN_KEY);
		assertUnknownOperationHeld(target, first);
		expect(port.probes).toBe(0);
		await settleOriginalUnknownOperation(target, first);
		expect(port.probes).toBe(0);
	} finally {
		await target.close();
	}
});

test("red-team: a terminal tail frame arriving during the status grace wins once without status-fallback delivery", async () => {
	const base = Date.parse("2026-09-02T00:00:00.000Z");
	const now = base;
	const timers: Array<{ readonly work: () => void; readonly delayMs: number }> = [];
	const port = new ScriptedSessionPort({ onBind: (input) => `${input.originKey}-session-${input.epoch}` });
	const target = await fixture({
		port,
		now: () => now,
		setTimeout: (work, delayMs) => {
			timers.push({ work, delayMs });
			return timers.length;
		},
		clearTimeout: () => {},
	});
	try {
		enqueue(target, "grace-tail-trigger", "tail frame must win", new Date(now).toISOString());
		await target.manager.notifyInbound(ORIGIN_KEY);
		await target.manager.tick(ORIGIN_KEY);
		await eventually(() => port.sends.length === 1, "grace test did not start its first turn");
		const send = required(port.sends[0], "grace test send missing");
		const batch = required(target.turns.values().next().value, "grace test batch missing");

		port.seedOperation(send.opRef, send.sessionId, "terminal_ok", "status reported terminal first");
		await target.manager.tick(ORIGIN_KEY);
		const grace = required(
			timers.find((timer) => timer.delayMs === 250),
			"terminal grace was not scheduled",
		);
		expect(target.manager.state(ORIGIN_KEY)).toBe("turn-running");
		expect(target.terminal).toEqual([]);
		expect(target.logs.some((line) => line.includes("reason=tail_terminal_evidence_unavailable"))).toBe(true);
		expect(target.database.inbox.turnRows(batch.opRef)[0]).toMatchObject({
			state: "pending",
			turn_state: "accepted",
		});

		// The owner relay then streams the turn's own final message and end, both
		// stamped with the command the send was accepted under, as the host does.
		const correlation = { commandId: `command-${send.opRef}`, turnId: `turn-${send.opRef}` };
		const owner = required(
			port.tailsOf(send.sessionId).find((tail) => tail.opRef === send.opRef),
			"grace test owner relay missing",
		);
		owner.emit({
			kind: "message_end",
			rawKind: "message_end",
			...correlation,
			eventId: `final-${send.opRef}`,
			payload: { role: "assistant", content: [{ text: "tail terminal arrived during grace" }] },
			assistantText: "tail terminal arrived during grace",
			steerEcho: false,
			idle: false,
		});
		owner.emit({
			kind: "agent_end",
			rawKind: "agent_end",
			...correlation,
			payload: { outcome: { reason: "end_turn" } },
			steerEcho: false,
			idle: true,
		});
		await eventually(() => target.terminal.length === 1, "terminal tail did not settle the held batch");
		expect(target.terminal).toEqual(["tail terminal arrived during grace"]);
		expect(target.logs.some((line) => line.startsWith("terminal_status_reconciled"))).toBe(false);
		expect(target.database.inbox.turnRows(batch.opRef)[0]).toMatchObject({ state: "done", turn_state: "done" });

		grace.work();
		await Bun.sleep(20);
		expect(target.terminal).toEqual(["tail terminal arrived during grace"]);
		expect(target.logs.some((line) => line.startsWith("terminal_status_reconciled"))).toBe(false);
	} finally {
		await target.close();
	}
});

class EndedTurnRejectsSteerPort extends ScriptedSessionPort {
	/** gjc refuses turn.steer once the turn has ended; the test flips this when it seeds the terminal status. */
	turnEnded = false;
	steerAttempts = 0;

	async steer(input: SessionSteerInput): Promise<void> {
		this.steerAttempts++;
		if (this.turnEnded) throw steerRefused("no running turn");
		await super.steer(input);
	}
}

test("canonical: a message arriving while the ended turn's tail is late is steered at once; the refusal settles the ended turn from status and the message is sent next", async () => {
	const base = Date.parse("2026-09-02T00:01:00.000Z");
	let now = base;
	const timers: Array<{ readonly work: () => void; readonly delayMs: number }> = [];
	const port = new EndedTurnRejectsSteerPort({ onBind: (input) => `${input.originKey}-session-${input.epoch}` });
	const target = await fixture({
		port,
		now: () => now,
		setTimeout: (work, delayMs) => {
			timers.push({ work, delayMs });
			return timers.length;
		},
		clearTimeout: () => {},
	});
	try {
		enqueue(target, "slow-tail-trigger", "status is terminal but tail is late", new Date(now).toISOString());
		await target.manager.notifyInbound(ORIGIN_KEY);
		await target.manager.tick(ORIGIN_KEY);
		await eventually(() => port.sends.length === 1, "slow-tail test did not start its first turn");
		const first = required(port.sends[0], "slow-tail first send missing");
		const firstBatch = required(target.turns.values().next().value, "slow-tail first batch missing");

		port.seedOperation(first.opRef, first.sessionId, "terminal_ok", "status-only terminal");
		port.turnEnded = true;
		await target.manager.tick(ORIGIN_KEY);
		const grace = required(
			timers.find((timer) => timer.delayMs === 250),
			"slow-tail terminal grace was not scheduled",
		);
		expect(target.terminal).toEqual([]);
		expect(target.manager.state(ORIGIN_KEY)).toBe("turn-running");
		expect(target.database.inbox.turnRows(firstBatch.opRef)[0]).toMatchObject({
			state: "pending",
			turn_state: "accepted",
		});

		now++;
		enqueue(target, "arrived-during-grace", "reaches the model as the next send", new Date(now).toISOString());
		await target.manager.notifyInbound(ORIGIN_KEY);
		// The undecided turn never gags ingestion: the steer is attempted at
		// once. The session refuses it (turn over), so the row is NOT consumed
		// by the old batch. The refusal is a second reconcile after the bounded
		// hold: status - the reconcile authority - completes the ended turn on
		// the spot instead of waiting out the grace, and the row is sent next.
		expect(port.steerAttempts).toBe(1);
		expect(port.steers).toEqual([]);
		expect(target.logs.filter((line) => line.startsWith("steer_failed"))).toHaveLength(1);
		expect(target.logs.some((line) => line.startsWith("session_rebound_after_steer_failure"))).toBe(false);
		expect(target.terminal).toEqual(["status-only terminal"]);
		expect(target.logs.filter((line) => line.startsWith("terminal_status_reconciled"))).toHaveLength(1);
		expect(target.database.inbox.turnRows(firstBatch.opRef)[0]).toMatchObject({
			state: "done",
			turn_state: "done",
		});
		// The grace timer that was armed for the hold is now a no-op.
		grace.work();
		await Bun.sleep(20);
		expect(target.terminal).toEqual(["status-only terminal"]);
		expect(target.logs.filter((line) => line.startsWith("terminal_status_reconciled"))).toHaveLength(1);

		port.complete(first.opRef, "late tail must not deliver twice");
		await Bun.sleep(20);
		expect(target.terminal).toEqual(["status-only terminal"]);
		await target.manager.tick(ORIGIN_KEY);
		await eventually(() => port.sends.length === 2, "row refused by the ended turn did not become the next send");
		const second = required(port.sends[1], "slow-tail second send missing");
		expect(second.sessionId).toBe(first.sessionId);
		expect(second.text).toBe("reaches the model as the next send");
		port.turnEnded = false;
		port.complete(second.opRef, "next turn terminal");
		await eventually(
			() => target.database.inbox.pendingCount(ORIGIN_KEY) === 0,
			"slow-tail sequence left a row orphaned",
		);
		assertCoverage(target, ["slow-tail-trigger", "arrived-during-grace"]);
	} finally {
		await target.close();
	}
});

test("red-team: stopping during terminal-status grace cancels the grace callback so nothing touches a closed database", async () => {
	const port = new ScriptedSessionPort({ onBind: (input) => `${input.originKey}-session-${input.epoch}` });
	const target = await fixture({ port });
	let closed = false;
	try {
		enqueue(target, "shutdown-grace-trigger", "do not touch storage after stop");
		await target.manager.notifyInbound(ORIGIN_KEY);
		await eventually(() => port.sends.length === 1, "shutdown-grace turn did not start");
		const send = required(port.sends[0], "shutdown-grace send missing");
		port.seedOperation(send.opRef, send.sessionId, "terminal_ok", "status terminal before shutdown");
		await target.manager.tick(ORIGIN_KEY);
		expect(target.logs.some((line) => line.includes("reason=tail_terminal_evidence_unavailable"))).toBe(true);

		await target.close();
		closed = true;
		// The grace timer is owned by the actor and cancelled at stop(); a stale
		// callback must never reconcile against the closed database.
		await Bun.sleep(400);
		expect(target.logs.some((line) => line.startsWith("persona_reconcile_grace_failed"))).toBe(false);
		expect(target.logs.some((line) => line.includes("Cannot use a closed database"))).toBe(false);
	} finally {
		if (!closed) await target.close();
	}
});

test("red-team coverage fuzz: exact-boundary fragments plus steer-failure and broker-generation interleavings leave no orphaned ids", async () => {
	for (let seed = 0; seed < 12; seed++) {
		const base = Date.parse("2026-09-02T00:00:00.000Z") + seed * 10_000;
		let now = base;
		let generation = 1;
		const port = new IntermittentSteerPort(new Set([1 + (seed % 2), 3 + (seed % 3)]));
		const target = await fixture({
			port,
			now: () => now,
			setTimeout: () => 0,
			clearTimeout: () => {},
			brokerGeneration: () => generation,
		});
		const ids = Array.from({ length: 8 }, (_, index) => `fuzz-${seed}-${index}`);
		try {
			for (const [index, offset] of [0, 25, 50, 75, 100].entries()) {
				now = base + offset;
				const id = required(ids[index], `seed ${seed} initial id ${index} missing`);
				enqueue(target, id, id, new Date(now).toISOString());
				await target.manager.notifyInbound(ORIGIN_KEY);
			}
			await eventually(() => port.sends.length >= 1, `seed ${seed} did not dispatch its first row`);

			for (let index = 5; index < ids.length; index++) {
				if ((seed + index) % 2 === 0) {
					generation++;
					await target.manager.onBrokerGeneration(generation);
				}
				now++;
				const id = required(ids[index], `seed ${seed} post-fire id ${index} missing`);
				enqueue(target, id, id, new Date(now).toISOString());
				await target.manager.notifyInbound(ORIGIN_KEY);
			}

			// Drain sequentially: refusal leaves the current turn intact and later
			// rows pending until its terminal. Every row must retain attribution.
			let completedSends = 0;
			for (let round = 0; target.database.inbox.pendingCount(ORIGIN_KEY) > 0; round++) {
				if (round > 32) throw new Error(`seed ${seed} did not drain`);
				await eventually(() => port.sends.length > completedSends, `seed ${seed} left pending rows without a turn`);
				expect(port.sends).toHaveLength(completedSends + 1);
				expect(target.database.inbox.nonterminalTurns(ORIGIN_KEY)).toHaveLength(1);
				expect(new Set(port.sends.map((send) => send.sessionId)).size).toBe(1);
				const send = required(port.sends[completedSends], `seed ${seed} send ${completedSends} missing`);
				port.complete(send.opRef, `terminal-${seed}-${completedSends}`);
				await target.manager.tick(ORIGIN_KEY);
				completedSends++;
				await eventually(
					() => target.database.inbox.turnRow(send.opRef)?.turn_state === "done",
					`seed ${seed} did not reconcile terminal send ${completedSends}`,
				);
				now += 100;
				await target.manager.tick(ORIGIN_KEY);
			}
			assertCoverage(target, ids);
		} finally {
			await target.close();
		}
	}
});

test("red-team non-goal probes: no running-turn abort or coexistence control remains, and inbound persistence has only ratified turn metadata", async () => {
	const source = (await Promise.all((await sourceFiles(SOURCE_ROOT)).map((path) => readFile(path, "utf8")))).join("\n");
	for (const forbidden of ["turn.abort", "turn.replace", "--resume", "keyed-queue"])
		expect(source).not.toContain(forbidden);
	for (const field of ["legacyTurn", "persistentTurn", "turnPath", "turnMode", "turnTransport"] as const) {
		const parsed = parseConfigFile({ schemaVersion: 1, [field]: true });
		expect(parsed).not.toHaveProperty(field);
	}

	const home = await mkdtemp(join(tmpdir(), "gajaeway-issue92-persistence-"));
	const path = join(home, "gateway.db");
	try {
		const database = await Store.open(path);
		database.close();
		const raw = new Database(path, { readonly: true });
		const columns = raw
			.query<{ name: string }, []>("PRAGMA table_info(inbound_messages)")
			.all()
			.map((column) => column.name);
		raw.close();
		expect(columns.filter((column) => /transcript|receipt|pending_op_ref/i.test(column))).toEqual([]);
		expect(columns).toEqual(
			expect.arrayContaining([
				"turn_role",
				"turn_epoch",
				"turn_state",
				"turn_op_ref",
				"bound_session_id",
				"dispatched_at",
				"terminal_delivery_id",
			]),
		);
	} finally {
		await rm(home, { recursive: true, force: true });
	}
});

test("red-team evidence: compaction observation is wired from production monitor composition through the SessionPort", async () => {
	const [tailRunner, sessionPort, propagator, server] = await Promise.all(
		[
			"../src/orchestrator/tail-runner.ts",
			"../src/orchestrator/session-port.ts",
			"../src/monitors/propagate.ts",
			"../src/server/server.ts",
		].map((relativePath) => readFile(join(import.meta.dir, relativePath), "utf8")),
	);
	expect(tailRunner).toContain("recordCompactionReceipt");
	expect(sessionPort).toContain("runCompaction(input");
	expect(sessionPort).toContain("recordCompactionReceipt");
	expect(propagator).toContain("this.#compaction = options.compaction ?? unavailableCompactionPort");
	expect(propagator).not.toContain("this.#sessionPort.runCompaction");
	expect(server).toContain("new MonitorPropagator({");
	// AC7: the production composition root supplies the ONE compaction seam.
	expect(server).toContain("compaction: {");
	expect(server).toContain("sessionPort.runCompaction({");
});

test("red-team: an idle binding whose session died is resumed exactly once before the next send", async () => {
	const port = new IdleRecoveryPort({
		onBind: (input) => `${input.originKey}-session-${input.epoch}`,
		onSend: (input, scripted) => scripted.complete(input.opRef, "reply"),
	});
	const target = await fixture({ port });
	try {
		enqueue(target, "idle-1", "first turn");
		await target.manager.notifyInbound(ORIGIN_KEY);
		await eventually(() => port.sends.length === 1, "first turn did not send");
		const sessionId = required(port.sends[0], "first send missing").sessionId;
		await eventually(() => target.database.inbox.pendingCount(ORIGIN_KEY) === 0, "first turn did not complete");
		// Broker restarted while idle: saved authority exists but the host is dead.
		port.setSessionState(sessionId, { live: false });
		enqueue(target, "idle-2", "second turn");
		await target.manager.notifyInbound(ORIGIN_KEY);
		await eventually(() => port.sends.length === 2, "second turn did not send");
		expect(required(port.sends[1], "second send missing").sessionId).toBe(sessionId);
		// Contract: dead+saved => session.resume, then ONE send; never a send to a dead binding.
		expect(port.calls.filter((call) => call.startsWith("resume:"))).toEqual([`resume:${sessionId}`]);
		expect(port.calls.indexOf(`resume:${sessionId}`)).toBeLessThan(port.calls.lastIndexOf(`send:${sessionId}`));
	} finally {
		await target.close();
	}
});

test("red-team: an inspect outage on an idle binding never blocks the send and never fabricates a resume", async () => {
	const port = new InspectUnavailableIdleRecoveryPort({
		onBind: (input) => `${input.originKey}-session-${input.epoch}`,
		onSend: (input, scripted) => scripted.complete(input.opRef, "reply"),
	});
	const target = await fixture({ port });
	try {
		enqueue(target, "outage-1", "first turn");
		await target.manager.notifyInbound(ORIGIN_KEY);
		await eventually(() => port.sends.length === 1, "first turn did not send");
		await eventually(() => target.database.inbox.pendingCount(ORIGIN_KEY) === 0, "first turn did not complete");
		enqueue(target, "outage-2", "second turn");
		await target.manager.notifyInbound(ORIGIN_KEY);
		await eventually(() => port.sends.length === 2, "second turn was blocked by the inspect outage");
		expect(port.calls.filter((call) => call.startsWith("resume:"))).toEqual([]);
	} finally {
		await target.close();
	}
});
