/**
 * Issue #5669: a turn that emitted a plan, ran a tool, then went silent was killed by the
 * inactivity watchdog and reported as a bare `-32603 {code: "prompt_abandoned"}`. Six plan
 * steps were still pending, but the wrapper could not tell "the agent finished" from "the
 * agent stopped with work left", so it published an unverified diff as a finished change.
 *
 * The last plan the turn published is exactly that evidence, so settlement now carries it.
 * These assert on the wire `data`, never on message text.
 */
import { describe, expect, it, setDefaultTimeout } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import {
	type AgentSideConnection,
	type PromptRequest,
	RequestError,
	type SessionNotification,
} from "@agentclientprotocol/sdk";
import { TempDir } from "@gajae-code/utils";
import packageJson from "../../package.json" with { type: "json" };
import { AcpAgent, acpRequestFailure } from "../../src/modes/acp/acp-agent";
import { writeBrokerDiscovery } from "../../src/sdk/broker/discovery";
import { SessionIndex } from "../../src/sdk/broker/session-index";
import { ACP_PROMPT_INFERENCE_TIMEOUT_MS } from "../../src/sdk/prompt-watchdog";

setDefaultTimeout(20_000);

// The internal statuses a `todo_reminder` carries, which is a superset of ACP's three-value plan
// status: `/todo drop` produces `abandoned`, and the mapper projects that onto the wire.
type TodoStatus = "pending" | "in_progress" | "completed" | "abandoned";
type Todo = { content: string; status: TodoStatus };

/** Virtual timer source: the watchdog only fires when the test says it does. */
class VirtualClock {
	#now = 0;
	#nextId = 1;
	readonly #timers = new Map<number, { at: number; handler: () => void }>();

	now(): number {
		return this.#now;
	}

	schedule(handler: () => void, delayMs: number): () => void {
		const id = this.#nextId++;
		this.#timers.set(id, { at: this.#now + delayMs, handler });
		return () => {
			this.#timers.delete(id);
		};
	}

	advance(ms: number): void {
		const target = this.#now + ms;
		for (;;) {
			let dueId: number | undefined;
			let dueAt = Number.POSITIVE_INFINITY;
			for (const [id, timer] of this.#timers) {
				if (timer.at <= target && timer.at < dueAt) {
					dueId = id;
					dueAt = timer.at;
				}
			}
			if (dueId === undefined) break;
			const timer = this.#timers.get(dueId);
			this.#timers.delete(dueId);
			this.#now = dueAt;
			timer?.handler();
		}
		this.#now = target;
	}
}

type Fixture = {
	agent: AcpAgent;
	sessionId: string;
	updates: SessionNotification[];
	clock: VirtualClock;
	/** Publishes a `plan` update for the live turn, the way `todo_write`/`todo_reminder` do. */
	sendPlan(todos: Todo[]): void;
	/** Publishes the empty plan `todo_auto_clear` emits. */
	sendPlanCleared(): void;
	dispose(): void;
};

async function bounded<T>(promise: Promise<T>, label: string): Promise<T> {
	return await Promise.race([
		promise,
		Bun.sleep(10_000).then(() => {
			throw new Error(`Timed out waiting for ${label}`);
		}),
	]);
}

async function waitFor(predicate: () => boolean, label: string): Promise<void> {
	const deadline = Date.now() + 10_000;
	while (Date.now() < deadline) {
		if (predicate()) return;
		await Bun.sleep(5);
	}
	throw new Error(`Timed out waiting for ${label}`);
}

function phaseUpdates(updates: SessionNotification[], phase: string): number {
	return updates.filter(
		update =>
			update.update.sessionUpdate === "session_info_update" &&
			(update.update as { _meta?: { gjcPhase?: string } })._meta?.gjcPhase === phase,
	).length;
}

function planUpdates(updates: SessionNotification[]): number {
	return updates.filter(update => update.update.sessionUpdate === "plan").length;
}

async function createFixture(): Promise<Fixture> {
	const tempDir = TempDir.createSync("@acp-abandon-plan-");
	const agentDir = path.join(tempDir.path(), "agent");
	const cwd = path.join(tempDir.path(), "workspace");
	const token = "acp-abandon-plan-token";
	const sessionId = "abandon-plan-session";
	const commandId = "abandon-plan-command";
	const turnId = "abandon-plan-turn";
	const updates: SessionNotification[] = [];
	const clock = new VirtualClock();
	const abort = new AbortController();
	let promptSocket: { send(message: string): void } | undefined;
	let server!: ReturnType<typeof Bun.serve>;

	// A `todo_reminder` agent-wire event is the shortest path to the same `plan` session
	// update `todo_write` produces; both land in the mapper's plan branch.
	const sendTodoEvent = (event: Record<string, unknown>): void => {
		if (!promptSocket) throw new Error("Expected a prompt socket");
		promptSocket.send(
			JSON.stringify({
				type: "event",
				sessionId,
				commandId,
				turnId,
				payload: { event_type: event.type, event },
			}),
		);
	};

	server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		fetch(request, server) {
			if (new URL(request.url).searchParams.get("token") !== token)
				return new Response("Unauthorized", { status: 401 });
			if (!server.upgrade(request, { data: undefined })) return new Response("Upgrade failed", { status: 400 });
		},
		websocket: {
			open(socket) {
				socket.send(JSON.stringify({ type: "hello", connectionId: "acp-abandon-plan" }));
			},
			async message(socket, raw) {
				const frame = JSON.parse(String(raw)) as Record<string, unknown>;
				if (frame.type === "event_replay") {
					socket.send(JSON.stringify({ type: "event_replay_result", id: frame.id, events: [] }));
					return;
				}
				if (frame.type === "register_provider") {
					socket.send(
						JSON.stringify({ type: "register_provider_result", id: frame.id, ok: true, leaseId: "lease" }),
					);
					return;
				}
				if (frame.type === "broker_request") {
					const endpointMtimeMs = 1;
					if (frame.operation === "session.create") {
						const endpointPath = path.join(cwd, ".gjc", "state", "sdk", `${sessionId}.json`);
						await fs.mkdir(path.dirname(endpointPath), { recursive: true });
						await Bun.write(
							endpointPath,
							JSON.stringify({ sessionId, pid: process.pid, url: `ws://127.0.0.1:${server.port}`, token }),
						);
						await fs.utimes(endpointPath, 0.001, 0.001);
						const index = await new SessionIndex(agentDir).open();
						await index.append({
							type: "host_registered",
							sessionId,
							locator: { cwd, worktreeRoot: null, stateRoot: path.join(cwd, ".gjc", "state") },
							endpointGeneration: 1,
							pid: process.pid,
							endpointMtimeMs: (await fs.stat(endpointPath)).mtimeMs,
						});
					}
					socket.send(
						JSON.stringify({
							type: "broker_response",
							id: frame.id,
							ok: true,
							result:
								frame.operation === "session.create"
									? {
											sessionId,
											endpointGeneration: 1,
											pid: process.pid,
											endpointMtimeMs,
											endpoint: { sessionId, pid: process.pid, url: `ws://127.0.0.1:${server.port}`, token },
										}
									: {},
						}),
					);
					return;
				}
				if (frame.type === "query_request") {
					const items =
						frame.query === "config.list/get"
							? [{ mode: "default", model: "openai/gpt", thinking: "medium" }]
							: frame.query === "models.list/current"
								? [{ provider: "openai", id: "gpt", name: "GPT" }]
								: frame.query === "providers.list/active"
									? [{ providerId: "openai", connectionKind: "credential" }]
									: [];
					const result =
						frame.query === "runtime.capabilities"
							? { promptTerminalOutcomeVersion: 1, primaryControlSurface: "sdk" }
							: frame.query === "context.get"
								? { usage: { tokens: 0, contextWindow: 200_000, percent: 0, source: "test" } }
								: { page: { items, complete: true } };
					socket.send(JSON.stringify({ type: "query_response", id: frame.id, ok: true, result }));
					return;
				}
				if (frame.type !== "control_request") return;
				if (frame.operation === "turn.prompt") promptSocket = socket;
				socket.send(
					JSON.stringify({
						type: "control_response",
						id: frame.id,
						ok: true,
						result:
							frame.operation === "turn.prompt"
								? { commandId, turnId, accepted: true }
								: frame.operation === "turn.abort"
									? { aborted: true }
									: {},
					}),
				);
				// FIFO on the socket, so the acknowledged correlation is recorded first.
				if (frame.operation === "turn.prompt")
					socket.send(JSON.stringify({ type: "agent_start", sessionId, commandId, turnId }));
			},
		},
	});
	const port = server.port;
	if (port === undefined) throw new Error("Expected an ACP fixture server port");
	await writeBrokerDiscovery(agentDir, {
		version: 1,
		protocolVersion: 3,
		packageGeneration: packageJson.version,
		ownerId: "test-owner",
		pid: process.pid,
		host: "127.0.0.1",
		port,
		url: `ws://127.0.0.1:${port}`,
		token,
		startedAt: Date.now(),
		heartbeatAt: Date.now(),
	});
	const agent = new AcpAgent(
		{
			sessionUpdate: async (update: SessionNotification) => {
				updates.push(update);
			},
			signal: abort.signal,
			closed: Promise.withResolvers<void>().promise,
		} as unknown as AgentSideConnection,
		{ agentDir, promptWatchdogClock: clock },
	);
	const created = await bounded(agent.newSession({ cwd, mcpServers: [] }), "new session");
	await waitFor(() => phaseUpdates(updates, "idle") > 0, "bootstrap update");

	return {
		agent,
		sessionId: created.sessionId,
		updates,
		clock,
		sendPlan: (todos: Todo[]) => sendTodoEvent({ type: "todo_reminder", turnId, todos, attempt: 1, maxAttempts: 3 }),
		sendPlanCleared: () => sendTodoEvent({ type: "todo_auto_clear", turnId }),
		dispose: () => {
			abort.abort();
			server.stop(true);
			tempDir.removeSync();
		},
	};
}

/**
 * Runs a turn to its acknowledged, started state, publishes `plans` in order, then lets the
 * inactivity watchdog abandon it and returns the wire `data` an ACP client would see.
 *
 * Each plan is awaited into `updates` before the next is sent, so the assertions describe a
 * known publication order rather than whatever the socket happened to interleave.
 */
async function abandonWithPlans(plans: Array<Todo[] | "cleared">): Promise<Record<string, unknown>> {
	const fixture = await createFixture();
	try {
		const started = phaseUpdates(fixture.updates, "working");
		const pending = fixture.agent.prompt({
			sessionId: fixture.sessionId,
			messageId: "00000000-0000-4000-8000-000000000001",
			prompt: [{ type: "text", text: "a turn that goes silent" }],
		} as PromptRequest) as Promise<unknown>;
		const settled = pending.then(
			resolved => ({ resolved }),
			(error: unknown) => ({ rejected: error }),
		);
		await waitFor(() => phaseUpdates(fixture.updates, "working") > started, "turn start");

		for (const [index, plan] of plans.entries()) {
			if (plan === "cleared") fixture.sendPlanCleared();
			else fixture.sendPlan(plan);
			await waitFor(() => planUpdates(fixture.updates) > index, `plan update ${index + 1}`);
		}

		// The turn died while awaiting the model (nothing cleared `agent_start`'s inference
		// state), so the inference bound is the one that catches it.
		fixture.clock.advance(ACP_PROMPT_INFERENCE_TIMEOUT_MS);
		const outcome = (await bounded(settled, "watchdog settlement")) as { rejected?: unknown };
		expect(outcome.rejected).toBeDefined();
		expect(outcome.rejected).toMatchObject({ code: "prompt_abandoned" });

		const failure = acpRequestFailure(outcome.rejected);
		expect(failure).toBeInstanceOf(RequestError);
		return (failure as RequestError).data as Record<string, unknown>;
	} finally {
		fixture.dispose();
	}
}

describe("an abandoned prompt reports its unfinished plan (issue #5669)", () => {
	it("publishes the pending steps a silent turn left behind", async () => {
		const data = await abandonWithPlans([
			[
				{ content: "apply the patch", status: "completed" },
				{ content: "run tests", status: "in_progress" },
				{ content: "lint", status: "pending" },
				{ content: "open the PR", status: "pending" },
			],
		]);

		expect(data).toMatchObject({
			code: "prompt_abandoned",
			planIncomplete: "true",
			planPendingCount: "3",
			planTotalCount: "4",
		});
		// `in_progress` is unfinished work too: a step the turn was mid-way through is
		// exactly the one a wrapper must not treat as done.
		expect(JSON.parse(String(data.planPending))).toEqual(["run tests", "lint", "open the PR"]);
	});

	it("reports a fully completed plan as complete rather than as pending work", async () => {
		const data = await abandonWithPlans([
			[
				{ content: "apply the patch", status: "completed" },
				{ content: "run tests", status: "completed" },
			],
		]);

		expect(data).toMatchObject({ planIncomplete: "false", planPendingCount: "0", planTotalCount: "2" });
		expect(JSON.parse(String(data.planPending))).toEqual([]);
	});

	it("counts a plan of nothing but dropped steps as unfinished work", async () => {
		const data = await abandonWithPlans([
			[
				{ content: "rewrite the parser", status: "abandoned" },
				{ content: "migrate the callers", status: "abandoned" },
			],
		]);

		// `/todo drop` marks a step `abandoned`, and ACP's plan status has no such member, so the
		// wire entry says `completed` for the client's plan UI. Reading that rendering as evidence
		// reported this turn as finished with zero pending steps — dropped work is not done work.
		expect(data).toMatchObject({ planIncomplete: "true", planPendingCount: "2", planTotalCount: "2" });
		expect(JSON.parse(String(data.planPending))).toEqual(["rewrite the parser", "migrate the callers"]);
	});

	it("separates a dropped step from a genuinely completed one in a mixed plan", async () => {
		const data = await abandonWithPlans([
			[
				{ content: "apply the patch", status: "completed" },
				{ content: "rewrite the parser", status: "abandoned" },
				{ content: "run tests", status: "pending" },
			],
		]);

		expect(data).toMatchObject({ planIncomplete: "true", planPendingCount: "2", planTotalCount: "3" });
		// List order, and the completed step stays out of it: the fix must not collapse into
		// "everything is unfinished".
		expect(JSON.parse(String(data.planPending))).toEqual(["rewrite the parser", "run tests"]);
	});

	it("omits the plan fields entirely when no plan was ever observed", async () => {
		const data = await abandonWithPlans([]);

		// Absence is the claim "there is no plan evidence", which is not the claim "the plan
		// was complete". It must never be guessed into either, or nulled.
		for (const field of ["planIncomplete", "planPending", "planPendingCount", "planTotalCount"])
			expect(data).not.toHaveProperty(field);
		// Today's payload, unchanged: the abandon still carries only its code and details.
		expect(Object.keys(data).sort()).toEqual(["code", "details"]);
		expect(data.code).toBe("prompt_abandoned");
		expect(String(data.details)).toContain("stopped producing frames");
	});

	it("bounds how much model-authored plan text reaches the wire", async () => {
		const overlong = `${"step ".repeat(100)}end`;
		const data = await abandonWithPlans([
			[
				{ content: overlong, status: "pending" },
				...Array.from({ length: 14 }, (_, index) => ({ content: `step ${index}`, status: "pending" as const })),
			],
		]);

		// The counts stay exact — truncation is a wire bound, not a recount.
		expect(data).toMatchObject({ planIncomplete: "true", planPendingCount: "15", planTotalCount: "15" });
		const pending = JSON.parse(String(data.planPending)) as string[];
		expect(pending).toHaveLength(10);
		expect(overlong.length).toBeGreaterThan(200);
		expect(pending[0]).toHaveLength(200);
		expect(pending[0]).toBe(overlong.slice(0, 200));
	});

	it("describes the last plan the turn published, not the first", async () => {
		const data = await abandonWithPlans([
			[
				{ content: "draft the approach", status: "in_progress" },
				{ content: "write it up", status: "pending" },
			],
			[
				{ content: "draft the approach", status: "completed" },
				{ content: "write it up", status: "completed" },
				{ content: "ship it", status: "pending" },
			],
		]);

		// A plan update is the whole list, so the newest one replaces the retained snapshot
		// instead of accumulating with it.
		expect(data).toMatchObject({ planIncomplete: "true", planPendingCount: "1", planTotalCount: "3" });
		expect(JSON.parse(String(data.planPending))).toEqual(["ship it"]);
	});

	it("lets an emptied plan clear the pending work it used to report", async () => {
		const data = await abandonWithPlans([
			[
				{ content: "run tests", status: "pending" },
				{ content: "open the PR", status: "pending" },
			],
			"cleared",
		]);

		// `todo_auto_clear` publishes an empty `entries`, which is still an observed plan —
		// it just has nothing left outstanding, so the stale pending steps must not survive.
		expect(data).toMatchObject({ planIncomplete: "false", planPendingCount: "0", planTotalCount: "0" });
		expect(JSON.parse(String(data.planPending))).toEqual([]);
	});
});
