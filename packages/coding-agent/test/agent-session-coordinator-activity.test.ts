import { afterEach, describe, expect, it, setSystemTime } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Agent, type AgentTool, bindDispatchedToolIdentity } from "@gajae-code/agent-core";
import type { AssistantMessage, Model, StopReason, ToolCall } from "@gajae-code/ai";
import { AssistantMessageEventStream } from "@gajae-code/ai/utils/event-stream";
import * as z from "zod/v4";
import { Settings } from "../src/config/settings";
import {
	__sessionStateSidecarPerfCounters,
	GJC_COORDINATOR_SESSION_STATE_FILE_ENV,
	persistCoordinatorRuntimeStateFromEvent,
} from "../src/gjc-runtime/session-state-sidecar";
import { AgentSession } from "../src/session/agent-session";
import { SessionManager } from "../src/session/session-manager";
import { installExactIdentityNatives } from "./helpers/exact-identity-natives";

// The agent loop emits the raw model-supplied `toolCall.name`, including for a
// call it is about to reject as unknown. Only a label proven against the ACTIVE
// TOOL OBJECT — one this session built from a built-in descriptor — may reach
// the coordinator-visible state file. A registry name alone proves nothing.
//
// An event produced OUTSIDE the loop carries exactly what its producer bound: the
// object it ran. Nothing downstream re-resolves the name, so an unbound external
// event stays `custom` no matter which tool currently holds that name.

const ORIGINAL_STATE_FILE = process.env[GJC_COORDINATOR_SESSION_STATE_FILE_ENV];
const tempDirs: string[] = [];
const sessions: AgentSession[] = [];
// Every activity write serializes on the coordinator state lock, whose removals go through
// identity-bound native primitives. Point them at a working implementation so these tests
// exercise label provenance rather than the compiled addon's availability.
installExactIdentityNatives();

afterEach(async () => {
	setSystemTime();
	for (const session of sessions.splice(0)) await session.dispose();
	if (ORIGINAL_STATE_FILE === undefined) delete process.env[GJC_COORDINATOR_SESSION_STATE_FILE_ENV];
	else process.env[GJC_COORDINATOR_SESSION_STATE_FILE_ENV] = ORIGINAL_STATE_FILE;
	__sessionStateSidecarPerfCounters.reset();
	await Promise.all(tempDirs.splice(0).map(dir => fs.rm(dir, { recursive: true, force: true })));
});

function createModel(): Model<"openai-responses"> {
	return {
		id: "mock",
		name: "mock",
		api: "openai-responses",
		provider: "openai",
		baseUrl: "https://example.invalid",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 8192,
		maxTokens: 2048,
	};
}

function createTool(name: string, extra: Partial<AgentTool> = {}): AgentTool {
	return {
		name,
		label: name,
		description: `${name} tool`,
		parameters: z.object({ value: z.string().optional() }),
		strict: true,
		async execute() {
			return { content: [{ type: "text", text: `${name} executed` }] };
		},
		...extra,
	} as AgentTool;
}

/**
 * @param options.overrides extra tools registered AFTER the built-ins, exactly as an SDK
 * extension/custom/MCP tool overrides a registry name. They carry no built-in provenance
 * even when they claim a built-in name or wire name.
 * @param options.inactive registry names withheld from the ACTIVE tool list. A registered
 * but inactive tool is one the model cannot call, so it can never be what ran.
 */
async function newSession(
	options: {
		overrides?: AgentTool[];
		inactive?: readonly string[];
		reloadSshTool?: () => Promise<AgentTool | null>;
	} = {},
): Promise<{
	session: AgentSession;
	stateFile: string;
	tools: { edit: AgentTool; bash: AgentTool; read: AgentTool; mcp: AgentTool };
}> {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-activity-boundary-"));
	tempDirs.push(root);
	const stateFile = path.join(root, "runtime-state.json");
	process.env[GJC_COORDINATOR_SESSION_STATE_FILE_ENV] = stateFile;

	// `edit` presents itself to some models under the wire name `apply_patch`.
	const editTool = createTool("edit", { customWireName: "apply_patch" } as Partial<AgentTool>);
	const bashTool = createTool("bash");
	const mcpTool = createTool("mcp__nucleus_search");
	const readTool = createTool("read");
	const builtins = [editTool, bashTool, readTool];
	// Only the built-in objects get provenance; the MCP tool and every override do not.
	const builtinToolIdentities = new Set<object>(builtins);
	const registry = new Map<string, AgentTool>(
		[...builtins, mcpTool, ...(options.overrides ?? [])].map(tool => [tool.name, tool]),
	);
	const inactive = new Set(options.inactive ?? []);
	const agent = new Agent({
		initialState: {
			model: createModel(),
			systemPrompt: ["initial"],
			tools: [...registry.values()].filter(tool => !inactive.has(tool.name)),
			messages: [],
		},
	});
	const sessionManager = SessionManager.inMemory();
	const session = new AgentSession({
		agent,
		sessionManager,
		settings: Settings.isolated({ "compaction.enabled": false }),
		modelRegistry: {} as never,
		toolRegistry: registry,
		builtinToolIdentities,
		...(options.reloadSshTool ? { reloadSshTool: options.reloadSshTool } : {}),
	});
	sessions.push(session);
	await persistCoordinatorRuntimeStateFromEvent(
		{ type: "turn_start" },
		{ sessionId: session.sessionId, cwd: sessionManager.getCwd(), sessionFile: sessionManager.getSessionFile() },
	);
	return { session, stateFile, tools: { edit: editTool, bash: bashTool, read: readTool, mcp: mcpTool } };
}

function toolCall(id: string, name: string): ToolCall {
	return { type: "toolCall", id, name, arguments: {} };
}

function assistantMessage(content: AssistantMessage["content"], stopReason: StopReason): AssistantMessage {
	return {
		role: "assistant",
		content,
		api: "openai-responses",
		provider: "openai",
		model: "mock",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason,
		timestamp: Date.now(),
	};
}

/** One assistant turn that calls every tool in `calls`, then a plain stop turn. */
function streamCalling(calls: ToolCall[]): Agent["streamFn"] {
	let turn = 0;
	return () => {
		const stream = new AssistantMessageEventStream();
		queueMicrotask(() => {
			if (turn++ > 0) {
				stream.push({
					type: "done",
					reason: "stop",
					message: assistantMessage([{ type: "text", text: "done" }], "stop"),
				});
				return;
			}
			stream.push({ type: "start", partial: assistantMessage([], "stop") });
			calls.forEach((call, contentIndex) => {
				const partial = assistantMessage(calls.slice(0, contentIndex + 1), "stop");
				stream.push({ type: "toolcall_start", contentIndex, partial });
				stream.push({ type: "toolcall_end", contentIndex, toolCall: call, partial });
			});
			stream.push({ type: "done", reason: "toolUse", message: assistantMessage(calls, "toolUse") });
		});
		return stream;
	};
}

/**
 * Turn 1 dispatches `calls` for real. Turn 2 puts `undispatched` on the wire and then ends
 * the turn with `stopReason`, which is how a provider fault or a cancellation leaves tool
 * calls behind that no `Tool.execute` will ever be entered for.
 */
function streamCallingThenFailedTurn(
	calls: ToolCall[],
	undispatched: ToolCall[],
	stopReason: "error" | "aborted",
): Agent["streamFn"] {
	let turn = 0;
	return () => {
		const stream = new AssistantMessageEventStream();
		const failing = turn++ > 0;
		const turnCalls = failing ? undispatched : calls;
		queueMicrotask(() => {
			stream.push({ type: "start", partial: assistantMessage([], "stop") });
			turnCalls.forEach((call, contentIndex) => {
				const partial = assistantMessage(turnCalls.slice(0, contentIndex + 1), "stop");
				stream.push({ type: "toolcall_start", contentIndex, partial });
				stream.push({ type: "toolcall_end", contentIndex, toolCall: call, partial });
			});
			if (failing) {
				stream.push({ type: "error", reason: stopReason, error: assistantMessage(turnCalls, stopReason) });
				return;
			}
			stream.push({ type: "done", reason: "toolUse", message: assistantMessage(turnCalls, "toolUse") });
		});
		return stream;
	};
}

/**
 * A session driven by a REAL prompt: the agent loop resolves each call against the run's
 * tool snapshot and emits the start event itself, so nothing about the label under test is
 * injected by the test.
 */
async function newDispatchSession(options: {
	activeTools: AgentTool[];
	builtins: readonly AgentTool[];
	calls?: ToolCall[];
	streamFn?: Agent["streamFn"];
	transformToolCallArguments?: (args: Record<string, unknown>, toolName: string) => Record<string, unknown>;
}): Promise<{ session: AgentSession; stateFile: string }> {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-activity-dispatch-"));
	tempDirs.push(root);
	const stateFile = path.join(root, "runtime-state.json");
	process.env[GJC_COORDINATOR_SESSION_STATE_FILE_ENV] = stateFile;
	const agent = new Agent({
		getApiKey: () => "test-key",
		initialState: { model: createModel(), systemPrompt: ["initial"], tools: options.activeTools, messages: [] },
		streamFn: options.streamFn ?? streamCalling(options.calls ?? []),
		...(options.transformToolCallArguments ? { transformToolCallArguments: options.transformToolCallArguments } : {}),
	});
	const sessionManager = SessionManager.inMemory();
	const session = new AgentSession({
		agent,
		sessionManager,
		settings: Settings.isolated({ "compaction.enabled": false }),
		modelRegistry: {} as never,
		toolRegistry: new Map(options.activeTools.map(tool => [tool.name, tool])),
		builtinToolIdentities: new Set<object>(options.builtins),
	});
	sessions.push(session);
	await persistCoordinatorRuntimeStateFromEvent(
		{ type: "turn_start" },
		{ sessionId: session.sessionId, cwd: sessionManager.getCwd(), sessionFile: sessionManager.getSessionFile() },
	);
	return { session, stateFile };
}

function toolStart(toolCallId: string, toolName: string): never {
	return { type: "tool_execution_start", toolCallId, toolName, args: {} } as never;
}

/**
 * Emit a start event the way an OUTSIDE producer does: it binds the object it selected and
 * executed, then hands the event over. `dispatchedTool` omitted means the producer executed
 * no AgentTool at all, so the call carries no provenance to read.
 */
function emitExternalStart(
	session: AgentSession,
	toolCallId: string,
	toolName: string,
	dispatchedTool?: AgentTool,
): void {
	const event = toolStart(toolCallId, toolName);
	bindDispatchedToolIdentity(event, dispatchedTool);
	session.agent.emitExternalEvent(event);
}

async function activityAfterSeq(stateFile: string, seq: number): Promise<Record<string, unknown>> {
	for (let attempt = 0; attempt < 200; attempt++) {
		let payload: Record<string, unknown>;
		try {
			payload = JSON.parse(await Bun.file(stateFile).text()) as Record<string, unknown>;
		} catch {
			await Bun.sleep(5);
			continue;
		}
		const activity = payload.activity as Record<string, unknown> | undefined;
		if (activity && activity.seq === seq) return activity;
		await Bun.sleep(5);
	}
	throw new Error(`activity sequence ${seq} was never persisted`);
}

async function readActivity(stateFile: string): Promise<Record<string, unknown> | undefined> {
	for (let attempt = 0; attempt < 200; attempt++) {
		try {
			const payload = JSON.parse(await Bun.file(stateFile).text()) as Record<string, unknown>;
			return payload.activity as Record<string, unknown> | undefined;
		} catch {
			await Bun.sleep(5);
		}
	}
	throw new Error("coordinator activity snapshot was never readable");
}

/** Wait until the sidecar stops writing, so the LAST published snapshot can be asserted. */
async function settledActivity(stateFile: string): Promise<Record<string, unknown> | undefined> {
	let previous = JSON.stringify(await readActivity(stateFile));
	for (let quiet = 0; quiet < 20; quiet++) {
		await Bun.sleep(10);
		const current = JSON.stringify(await readActivity(stateFile));
		if (current !== previous) quiet = 0;
		previous = current;
	}
	return await readActivity(stateFile);
}

describe("AgentSession coordinator activity labels", () => {
	it("skips coordinator persistence for memory-only sessions without a state sink", async () => {
		delete process.env[GJC_COORDINATOR_SESSION_STATE_FILE_ENV];
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-activity-memory-only-"));
		tempDirs.push(root);
		const agent = new Agent({
			initialState: { model: createModel(), systemPrompt: ["initial"], tools: [], messages: [] },
		});
		const session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(root),
			settings: Settings.isolated({ "compaction.enabled": false }),
			modelRegistry: {} as never,
		});
		sessions.push(session);
		__sessionStateSidecarPerfCounters.reset();
		await session.queueCoordinatorRuntimeStatePersistForTests({ type: "turn_start" }, Promise.resolve());

		expect(__sessionStateSidecarPerfCounters.persistFromEventCalls).toBe(0);
	});

	it("publishes only canonical labels proven against the session's registered tools", async () => {
		const { session, stateFile, tools } = await newSession();

		// A producer that executed no AgentTool: nothing proves what ran.
		emitExternalStart(session, "call-unknown", "PROMPT_SECRET_123");
		expect(await activityAfterSeq(stateFile, 1)).toMatchObject({ tool: "custom" });

		// The producer ran the built-in `edit` object, reported under its wire name.
		emitExternalStart(session, "call-wire-name", "apply_patch", tools.edit);
		expect(await activityAfterSeq(stateFile, 2)).toMatchObject({ tool: "edit" });

		// A registered MCP object is proven to have run, but it is not a built-in.
		emitExternalStart(session, "call-mcp", "mcp__nucleus_search", tools.mcp);
		expect(await activityAfterSeq(stateFile, 3)).toMatchObject({ tool: "custom" });

		session.agent.emitExternalEvent({
			type: "tool_execution_end",
			toolCallId: "call-unknown",
			toolName: "PROMPT_SECRET_123",
			result: { content: [] },
			isError: true,
		} as never);
		const finished = await activityAfterSeq(stateFile, 4);
		expect(finished).toMatchObject({ tool: "custom", phase: "finished", outcome: "failure" });

		const raw = await Bun.file(stateFile).text();
		expect(raw).not.toContain("PROMPT_SECRET_123");
		expect(raw).not.toContain("apply_patch");
		expect(raw).not.toContain("mcp__nucleus_search");
	});

	it("reports a colliding custom tool as custom even under a built-in name", async () => {
		// SDK extension/custom tools that overwrite the built-in registry entries for
		// `bash` and `edit` — including the built-in `apply_patch` wire name. Neither
		// the registry name nor the wire name is provenance.
		const collidingBash = createTool("bash", { label: "impostor" });
		const collidingEdit = createTool("edit", { customWireName: "apply_patch" } as Partial<AgentTool>);
		const { session, stateFile, tools } = await newSession({ overrides: [collidingBash, collidingEdit] });

		emitExternalStart(session, "call-colliding-bash", "bash", collidingBash);
		expect(await activityAfterSeq(stateFile, 1)).toMatchObject({ tool: "custom" });

		emitExternalStart(session, "call-colliding-wire-name", "apply_patch", collidingEdit);
		expect(await activityAfterSeq(stateFile, 2)).toMatchObject({ tool: "custom" });

		// A built-in that was not overridden is still proven and still labeled.
		emitExternalStart(session, "call-builtin-read", "read", tools.read);
		expect(await activityAfterSeq(stateFile, 3)).toMatchObject({ tool: "read" });

		const raw = await Bun.file(stateFile).text();
		expect(raw).not.toContain("impostor");
		expect(raw).not.toContain("apply_patch");
	});

	it("reports every tool as custom when the session was given no provenance", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-activity-no-provenance-"));
		tempDirs.push(root);
		const stateFile = path.join(root, "runtime-state.json");
		process.env[GJC_COORDINATOR_SESSION_STATE_FILE_ENV] = stateFile;
		const bashTool = createTool("bash");
		const agent = new Agent({
			initialState: { model: createModel(), systemPrompt: ["initial"], tools: [bashTool], messages: [] },
		});
		const sessionManager = SessionManager.inMemory();
		const session = new AgentSession({
			agent,
			sessionManager,
			settings: Settings.isolated({ "compaction.enabled": false }),
			modelRegistry: {} as never,
			toolRegistry: new Map([[bashTool.name, bashTool]]),
		});
		sessions.push(session);
		await persistCoordinatorRuntimeStateFromEvent(
			{ type: "turn_start" },
			{ sessionId: session.sessionId, cwd: sessionManager.getCwd(), sessionFile: sessionManager.getSessionFile() },
		);

		emitExternalStart(session, "call-unproven", "bash", bashTool);
		expect(await activityAfterSeq(stateFile, 1)).toMatchObject({ tool: "custom" });
	});

	it("labels from the object a producer proved it ran, not from the name it reported", async () => {
		// The registry still holds the PROVEN built-in `edit`, but it is not active. What the
		// producer ran is the custom tool, whatever name the event carries.
		const customEditor = createTool("custom_editor", { customWireName: "edit" } as Partial<AgentTool>);
		const { session, stateFile, tools } = await newSession({ overrides: [customEditor], inactive: ["edit"] });

		emitExternalStart(session, "call-shadowed-builtin", "edit", customEditor);
		expect(await activityAfterSeq(stateFile, 1)).toMatchObject({ tool: "custom" });

		// A built-in wire name with no proven object behind it stays unproven.
		emitExternalStart(session, "call-inactive-wire-name", "apply_patch");
		expect(await activityAfterSeq(stateFile, 2)).toMatchObject({ tool: "custom" });

		// Nor does a name no tool carries become provenance.
		emitExternalStart(session, "call-padded", " bash ");
		expect(await activityAfterSeq(stateFile, 3)).toMatchObject({ tool: "custom" });

		// The built-in object the producer really ran keeps its canonical label.
		emitExternalStart(session, "call-active-bash", "bash", tools.bash);
		expect(await activityAfterSeq(stateFile, 4)).toMatchObject({ tool: "bash" });
	});

	it("fences queued sidecar writes once dispose starts", async () => {
		const { session, stateFile, tools } = await newSession();

		// Tool activity is enqueued, never awaited by its emitter, so only dispose can
		// prove the queue is empty. A write that outlives its session runs under the
		// identity-bound state-file lock with no owner left to answer for it.
		emitExternalStart(session, "call-drained", "bash", tools.bash);
		await session.dispose();

		// Disposal invalidates events admitted before its generation fence. Read once,
		// without polling: a still-queued write would appear after dispose returned.
		const settled = await Bun.file(stateFile).text();
		expect((JSON.parse(settled) as { activity?: Record<string, unknown> }).activity).toBeUndefined();

		await Bun.sleep(50);
		expect(await Bun.file(stateFile).text()).toBe(settled);
	});

	it("closes a call under the label its own start proved", async () => {
		const { session, stateFile, tools } = await newSession();

		emitExternalStart(session, "call-bash", "bash", tools.bash);
		expect(await activityAfterSeq(stateFile, 1)).toMatchObject({ tool: "bash" });

		// The active set is replaced mid-call: `bash` now resolves to a custom tool with
		// no provenance. Relabelling at the end would report one call under two labels.
		const impostor = createTool("bash", { label: "impostor" });
		session.agent.setTools([impostor]);

		session.agent.emitExternalEvent({
			type: "tool_execution_end",
			toolCallId: "call-bash",
			toolName: "bash",
			result: { content: [] },
			isError: false,
		} as never);

		expect(await activityAfterSeq(stateFile, 2)).toMatchObject({
			tool: "bash",
			phase: "finished",
			outcome: "success",
			active_tool_count: 0,
		});
	});

	it("keeps observation order and timestamps under a reentrant subscriber", async () => {
		const { session, stateFile, tools } = await newSession();
		setSystemTime(new Date("2026-03-01T00:00:01.000Z"));

		let reentered = false;
		session.subscribe(event => {
			if (event.type !== "tool_execution_start" || reentered) return;
			reentered = true;
			// A subscriber that both burns wall clock and emits its own event. Neither may
			// reach back into the event it is being notified about.
			setSystemTime(new Date("2026-03-01T00:00:09.000Z"));
			emitExternalStart(session, "call-second", "read", tools.read);
		});
		emitExternalStart(session, "call-first", "bash", tools.bash);

		const settled = await activityAfterSeq(stateFile, 2);
		expect(settled).toMatchObject({
			tool: "read",
			last_activity_at: "2026-03-01T00:00:09.000Z",
			active_tool_count: 2,
			active_tools: [
				{ tool: "bash", started_at: "2026-03-01T00:00:01.000Z" },
				{ tool: "read", started_at: "2026-03-01T00:00:09.000Z" },
			],
		});
	});

	it("proves provenance for a built-in tool object created after construction", async () => {
		const sshTool = createTool("ssh");
		// `refreshSshTool` replaces the registry entry with a NEW object; without
		// re-recording provenance every later `ssh` call would report as `custom`.
		const { session, stateFile } = await newSession({ reloadSshTool: async () => sshTool });
		await session.refreshSshTool({ activateIfAvailable: true });
		expect(session.getActiveToolNames()).toContain("ssh");

		emitExternalStart(session, "call-ssh", "ssh", sshTool);
		expect(await activityAfterSeq(stateFile, 1)).toMatchObject({ tool: "ssh" });
	});

	// A real run: the model emits two calls, the first tool refreshes the active tool
	// set mid-run, and the second call still dispatches the object the loop resolved
	// from the run's immutable snapshot. Whatever holds the wire name by the time the
	// start event is consumed is NOT what ran.
	it("labels a dispatched call from the tool object the loop ran, not a mid-run replacement", async () => {
		const impostorDispatched = Promise.withResolvers<void>();
		const releaseImpostor = Promise.withResolvers<void>();
		let refreshTools: () => void = () => {};

		const provenBash = createTool("bash", { concurrency: "exclusive" } as Partial<AgentTool>);
		const impostorBash = createTool("bash", {
			concurrency: "exclusive",
			label: "impostor",
			async execute() {
				impostorDispatched.resolve();
				// Hold the call open so the start event is observed while this object is
				// provably the one executing.
				await releaseImpostor.promise;
				return { content: [] };
			},
		} as Partial<AgentTool>);
		const refresher = createTool("read", {
			concurrency: "exclusive",
			async execute() {
				refreshTools();
				return { content: [] };
			},
		} as Partial<AgentTool>);

		const { session, stateFile } = await newDispatchSession({
			activeTools: [refresher, impostorBash],
			builtins: [refresher, provenBash],
			calls: [toolCall("call-refresh", "read"), toolCall("call-bash", "bash")],
		});
		// After the refresh the wire name `bash` resolves to a PROVEN built-in object,
		// while the call in flight is the custom impostor captured by the run snapshot.
		refreshTools = () => session.agent.setTools([refresher, provenBash]);

		const run = session.agent.prompt("run both tools");
		await impostorDispatched.promise;

		// seq 1 = refresher start, seq 2 = refresher end, seq 3 = the dispatched `bash`.
		expect(await activityAfterSeq(stateFile, 3)).toMatchObject({ tool: "custom", phase: "started" });

		releaseImpostor.resolve();
		await run;
		expect(await Bun.file(stateFile).text()).not.toContain("impostor");
	});

	it("keeps a dispatched built-in's label when a custom tool takes its wire name mid-run", async () => {
		const builtinDispatched = Promise.withResolvers<void>();
		const releaseBuiltin = Promise.withResolvers<void>();
		let refreshTools: () => void = () => {};

		const impostorBash = createTool("bash", { concurrency: "exclusive", label: "impostor" } as Partial<AgentTool>);
		const provenBash = createTool("bash", {
			concurrency: "exclusive",
			async execute() {
				builtinDispatched.resolve();
				await releaseBuiltin.promise;
				return { content: [] };
			},
		} as Partial<AgentTool>);
		const refresher = createTool("read", {
			concurrency: "exclusive",
			async execute() {
				refreshTools();
				return { content: [] };
			},
		} as Partial<AgentTool>);

		const { session, stateFile } = await newDispatchSession({
			activeTools: [refresher, provenBash],
			builtins: [refresher, provenBash],
			calls: [toolCall("call-refresh", "read"), toolCall("call-bash", "bash")],
		});
		refreshTools = () => session.agent.setTools([refresher, impostorBash]);

		const run = session.agent.prompt("run both tools");
		await builtinDispatched.promise;

		expect(await activityAfterSeq(stateFile, 3)).toMatchObject({ tool: "bash", phase: "started" });

		releaseBuiltin.resolve();
		await run;
	});

	/**
	 * A call that the loop never dispatched still gets a start/end PAIR, because every
	 * consumer of the event stream is built around results arriving in pairs. That pairing
	 * is a stream-shape obligation, not evidence that anything ran — and coordinator
	 * activity is a claim about what IS running. Publishing it would let `read_status`
	 * report a built-in as active in the window between the two synthetic writes, for a
	 * tool whose `execute` was never called.
	 */
	it("never publishes activity for a synthetic pairing whose call was never dispatched", async () => {
		const dispatched = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		let neverRunsExecuted = false;

		const runner = createTool("read", {
			concurrency: "exclusive",
			async execute() {
				dispatched.resolve();
				await release.promise;
				return { content: [] };
			},
		} as Partial<AgentTool>);
		// A proven built-in, so a published label would be the canonical `bash` — exactly
		// the "a built-in is active" claim that must never appear for an unrun call.
		const neverRuns = createTool("bash", {
			concurrency: "exclusive",
			async execute() {
				neverRunsExecuted = true;
				return { content: [] };
			},
		} as Partial<AgentTool>);

		const { session, stateFile } = await newDispatchSession({
			activeTools: [runner, neverRuns],
			builtins: [runner, neverRuns],
			calls: [toolCall("call-runs", "read"), toolCall("call-never", "bash")],
		});

		const delivered: string[] = [];
		const syntheticPaired = Promise.withResolvers<void>();
		session.subscribe(event => {
			if (event.type !== "tool_execution_start" && event.type !== "tool_execution_end") return;
			delivered.push(`${event.type}:${(event as { toolCallId?: string }).toolCallId}`);
			if (delivered.at(-1) === "tool_execution_end:call-never") syntheticPaired.resolve();
		});

		// Sampled continuously, so a claim that exists only BETWEEN the synthetic start and
		// its end is still caught rather than hidden by the end write that follows it.
		const samples: Array<Record<string, unknown>> = [];
		let sampling = true;
		const sampler = (async () => {
			while (sampling) {
				const activity = await readActivity(stateFile);
				if (activity) samples.push(activity);
				await Bun.sleep(2);
			}
		})();

		const run = session.agent.prompt("run both tools");
		await dispatched.promise;
		expect(await activityAfterSeq(stateFile, 1)).toMatchObject({ tool: "read", phase: "started" });

		// Steering interrupts the run: every call the loop has not reached yet is finished
		// with a result pair it never earned by executing. `neverRuns.execute` is therefore
		// provably never entered, which is exactly what the published activity must reflect.
		session.agent.steer({ role: "user", content: "stop after this one", timestamp: Date.now() });
		release.resolve();
		await syntheticPaired.promise;
		await run;
		const settled = await settledActivity(stateFile);
		sampling = false;
		await sampler;

		expect(neverRunsExecuted).toBe(false);
		// The pairing still reaches ordinary subscribers: nothing about event delivery,
		// history, or result shape changes.
		expect(delivered).toContain("tool_execution_start:call-never");
		expect(delivered).toContain("tool_execution_end:call-never");

		// Exactly two activity writes ever happened — the real start and the real end.
		// A synthetic start would be seq 3 and its end seq 4.
		expect(settled).toMatchObject({ seq: 2, tool: "read", phase: "finished", active_tool_count: 0 });
		expect(settled?.active_tools).toEqual([]);
		// And at no observed instant did the file claim the undispatched built-in.
		expect(samples.filter(activity => activity.tool === "bash")).toEqual([]);
		expect(samples.filter(activity => (activity.active_tool_count as number) > 1)).toEqual([]);
		expect(await Bun.file(stateFile).text()).not.toContain("call-never");
	});

	/**
	 * The same obligation on the other route into it: a turn that ends in `error` (or
	 * `aborted`) never dispatches the tool calls it already put on the wire, and the loop
	 * synthesizes one placeholder pair per call so the API's tool_use/tool_result pairing
	 * survives. Durable activity is a claim about what IS running, so those pairs must
	 * neither advance the sequence nor leave a built-in looking active.
	 */
	it("never publishes activity for the pairing an errored turn owes its undispatched calls", async () => {
		let neverRunsExecuted = false;
		const runner = createTool("read", { concurrency: "exclusive" } as Partial<AgentTool>);
		const neverRuns = createTool("bash", {
			concurrency: "exclusive",
			async execute() {
				neverRunsExecuted = true;
				return { content: [] };
			},
		} as Partial<AgentTool>);

		const { session, stateFile } = await newDispatchSession({
			activeTools: [runner, neverRuns],
			builtins: [runner, neverRuns],
			streamFn: streamCallingThenFailedTurn(
				[toolCall("call-runs", "read")],
				[toolCall("call-never", "bash")],
				"error",
			),
		});

		const delivered: string[] = [];
		session.subscribe(event => {
			if (event.type !== "tool_execution_start" && event.type !== "tool_execution_end") return;
			delivered.push(`${event.type}:${(event as { toolCallId?: string }).toolCallId}`);
		});

		const samples: Array<Record<string, unknown>> = [];
		let sampling = true;
		const sampler = (async () => {
			while (sampling) {
				const activity = await readActivity(stateFile);
				if (activity) samples.push(activity);
				await Bun.sleep(2);
			}
		})();

		await session.agent.prompt("run a tool, then fail the next turn");
		await session.awaitSessionSettlement();
		const settled = await settledActivity(stateFile);
		sampling = false;
		await sampler;

		expect(neverRunsExecuted).toBe(false);
		// The pairing still reaches ordinary subscribers, exactly as before.
		expect(delivered).toContain("tool_execution_start:call-never");
		expect(delivered).toContain("tool_execution_end:call-never");

		// Only the real dispatch was ever published: its start and its end.
		expect(settled).toMatchObject({ seq: 2, tool: "read", phase: "finished", active_tool_count: 0 });
		expect(settled?.active_tools).toEqual([]);
		expect(samples.filter(activity => activity.tool === "bash")).toEqual([]);
		expect(samples.filter(activity => (activity.active_tool_count as number) > 1)).toEqual([]);
		expect(await Bun.file(stateFile).text()).not.toContain("call-never");
	});
	/**
	 * The third route into the same obligation, and the one the loop reaches most often: a
	 * call that IS dispatched to the scheduler but never reaches the selected
	 * `Tool.execute`, because a gate rejects it first — truncated arguments, a name no
	 * active tool answers to, a schema the tool itself refuses, or a blocking
	 * `beforeToolCall`. Each still owes the stream a pair, and none of them is a tool
	 * running.
	 *
	 * The proof is the persisted file itself rather than "execute was not called": the
	 * coordinator reads these BYTES to answer "what is this session doing right now", so
	 * an unchanged snapshot is the only thing that rules out a published claim — including
	 * one that exists solely between a start write and the end write that overwrites it.
	 */
	it("never publishes activity for a call rejected before Tool.execute is entered", async () => {
		let entered = 0;
		const strictBash = createTool("bash", {
			concurrency: "exclusive",
			parameters: z.object({ command: z.string() }),
			async execute() {
				entered++;
				return { content: [] };
			},
		} as Partial<AgentTool>);
		const read = createTool("read", {
			concurrency: "exclusive",
			async execute() {
				entered++;
				return { content: [] };
			},
		} as Partial<AgentTool>);

		// One turn of calls per prompt, so the blocked call below lands on its own prompt
		// with the hook already installed.
		let pendingCalls: ToolCall[] = [
			// Truncated by the provider's output-token limit.
			{ type: "toolCall", id: "call-incomplete", name: "bash", arguments: {}, incompleteArguments: true },
			// A name the run's tool snapshot never had.
			{ type: "toolCall", id: "call-unknown", name: "not_a_tool", arguments: {} },
			// Arguments the tool's own schema rejects.
			{ type: "toolCall", id: "call-invalid", name: "bash", arguments: {} },
		];
		let rejectTransform = false;
		const { session, stateFile } = await newDispatchSession({
			activeTools: [strictBash, read],
			builtins: [strictBash, read],
			transformToolCallArguments: args => {
				if (rejectTransform) throw new Error("argument transform rejected");
				return args;
			},
			streamFn: () => {
				const stream = new AssistantMessageEventStream();
				const calls = pendingCalls;
				pendingCalls = [];
				queueMicrotask(() => {
					if (calls.length === 0) {
						stream.push({
							type: "done",
							reason: "stop",
							message: assistantMessage([{ type: "text", text: "done" }], "stop"),
						});
						return;
					}
					stream.push({ type: "start", partial: assistantMessage([], "stop") });
					calls.forEach((call, contentIndex) => {
						const partial = assistantMessage(calls.slice(0, contentIndex + 1), "stop");
						stream.push({ type: "toolcall_start", contentIndex, partial });
						stream.push({ type: "toolcall_end", contentIndex, toolCall: call, partial });
					});
					stream.push({ type: "done", reason: "toolUse", message: assistantMessage(calls, "toolUse") });
				});
				return stream;
			},
		});

		const baseline = JSON.stringify(await readActivity(stateFile));

		const samples: string[] = [];
		let sampling = true;
		const sampler = (async () => {
			while (sampling) {
				samples.push(JSON.stringify(await readActivity(stateFile)));
				await Bun.sleep(2);
			}
		})();

		await session.agent.prompt("emit three calls no tool can run");

		// A pre-dispatch block, on a call that is otherwise perfectly valid.
		session.agent.beforeToolCall = () => ({ block: true, reason: "blocked by policy" });
		pendingCalls = [toolCall("call-blocked", "read")];
		await session.agent.prompt("emit a call the hook blocks");

		// Argument transformation also runs before Tool.execute and may reject the call.
		session.agent.beforeToolCall = undefined;
		rejectTransform = true;
		pendingCalls = [toolCall("call-transform-rejected", "read")];
		await session.agent.prompt("emit a call the argument transform rejects");

		const settled = JSON.stringify(await settledActivity(stateFile));
		sampling = false;
		await sampler;

		expect(entered).toBe(0);
		// Not one byte of the activity snapshot moved: no seq, no label, no active list.
		expect(settled).toBe(baseline);
		expect([...new Set(samples)]).toEqual([baseline]);
		const raw = await Bun.file(stateFile).text();
		for (const callId of [
			"call-incomplete",
			"call-unknown",
			"call-invalid",
			"call-blocked",
			"call-transform-rejected",
		]) {
			expect(raw).not.toContain(callId);
		}
		expect(raw).not.toContain("not_a_tool");
	});
});
