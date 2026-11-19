import { afterEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Agent, type AgentEvent, type AgentTool } from "@gajae-code/agent-core";
import type { AssistantMessage, Context, ToolResultMessage, UserMessage } from "@gajae-code/ai";
import { createMockModel, type MockModel, type MockResponse, registerMockApi } from "@gajae-code/ai/providers/mock";
import { AssistantMessageEventStream } from "@gajae-code/ai/utils/event-stream";
import { AsyncJobManager } from "@gajae-code/coding-agent/async";
import type { Rule } from "@gajae-code/coding-agent/capability/rule";
import { Settings } from "@gajae-code/coding-agent/config/settings";
import { TtsrManager } from "@gajae-code/coding-agent/export/ttsr";
import { loadExtensions } from "@gajae-code/coding-agent/extensibility/extensions/loader";
import { ExtensionRunner } from "@gajae-code/coding-agent/extensibility/extensions/runner";
import { AgentSession, type AgentSessionEvent } from "@gajae-code/coding-agent/session/agent-session";
import { convertToLlm } from "@gajae-code/coding-agent/session/messages";
import { SESSION_RECAP_ENTRY } from "@gajae-code/coding-agent/session/recap";
import { SessionManager } from "@gajae-code/coding-agent/session/session-manager";
import { getProjectAgentDir, logger, TempDir } from "@gajae-code/utils";
import * as z from "zod/v4";

registerMockApi();

type RecapReply = (request: string) => MockResponse | Promise<MockResponse>;

interface Harness {
	session: AgentSession;
	manager: SessionManager;
	settings: Settings;
	model: MockModel;
	altModel: MockModel;
	/** Outbound recap request bodies, in call order. */
	recapRequests: string[];
	/** Last-user-message bodies of main-turn model calls, in call order. */
	mainRequests: string[];
	script: {
		main: MockResponse | undefined;
		/** Main-turn replies consumed one per call before falling back to `main`. */
		mainQueue: MockResponse[];
		/** Runs inside the main-turn provider call (1-based call number), before it replies. */
		onMain: ((call: number) => void) | undefined;
		recap: RecapReply;
	};
}

interface HarnessOptions {
	enabled?: boolean;
	manager?: SessionManager;
	/** Turn on provider-error retry with a tiny backoff cap so a retry-after hint sets the delay. */
	retry?: boolean;
	tools?: AgentTool[];
	/** Turns on threshold auto-compaction with auto-continue; pair with `extensionRunner` to skip the summary model call. */
	compaction?: boolean;
	extensionRunner?: ExtensionRunner;
	ttsrManager?: TtsrManager;
	/** Replaces the provider stream of a main-turn call (1-based, counting every call the Agent makes). */
	interceptMain?: (call: number, signal: AbortSignal | undefined) => AssistantMessageEventStream | undefined;
}

const sessions: AgentSession[] = [];
const tempDirs: string[] = [];

afterEach(async () => {
	const errors: unknown[] = [];
	for (const session of sessions.splice(0)) {
		try {
			await session.dispose();
		} catch (error) {
			errors.push(error);
		}
	}
	AsyncJobManager.resetForTests();
	vi.restoreAllMocks();
	for (const dir of tempDirs.splice(0)) {
		try {
			await fs.rm(dir, { recursive: true, force: true });
		} catch (error) {
			errors.push(error);
		}
	}
	if (errors.length > 0) throw new AggregateError(errors, "Recap fixture cleanup failed");
});

function isRecapContext(context: Context): boolean {
	return JSON.stringify(context.systemPrompt).includes("session-turn");
}

function lastUserText(context: Context): string {
	const last = context.messages.at(-1);
	if (last?.role !== "user") return "";
	return typeof last.content === "string" ? last.content : JSON.stringify(last.content);
}

function createHarness(options: HarnessOptions = {}): Harness {
	const recapRequests: string[] = [];
	const mainRequests: string[] = [];
	const script: Harness["script"] = {
		main: undefined,
		mainQueue: [],
		onMain: undefined,
		recap: () => ({ content: [`recap-${recapRequests.length}`] }),
	};
	const handler = async (context: Context): Promise<MockResponse> => {
		if (isRecapContext(context)) {
			const request = lastUserText(context);
			recapRequests.push(request);
			return await script.recap(request);
		}
		mainRequests.push(lastUserText(context));
		script.onMain?.(mainRequests.length);
		return script.mainQueue.shift() ?? script.main ?? { content: [`main answer ${mainRequests.length}`] };
	};
	const model = createMockModel({ handler });
	const altModel = createMockModel({ id: "mock-alt", handler });
	const settings = Settings.isolated({
		"compaction.enabled": options.compaction === true,
		...(options.compaction === true
			? { "compaction.autoContinue": true, "contextPromotion.enabled": false, "todo.reminders": false }
			: {}),
		"retry.enabled": options.retry === true,
		...(options.retry === true ? { "retry.baseDelayMs": 5, "retry.maxDelayMs": 60_000 } : {}),
		...(options.enabled === false ? {} : { "recap.enabled": true }),
	});
	let manager = options.manager;
	if (!manager) {
		const cwd = TempDir.createSync("@pi-agent-session-recap-").path();
		tempDirs.push(cwd);
		manager = SessionManager.inMemory(cwd);
	}
	let agentCalls = 0;
	const agent = new Agent({
		getApiKey: () => "test-key",
		initialState: { model, systemPrompt: ["system"], tools: options.tools ?? [], messages: [] },
		streamFn: (requested, context, streamOptions) => {
			agentCalls++;
			return (
				options.interceptMain?.(agentCalls, streamOptions?.signal) ??
				model.stream(requested, context, streamOptions)
			);
		},
		convertToLlm,
	});
	const session = new AgentSession({
		agent,
		sessionManager: manager,
		settings,
		modelRegistry: {
			authStorage: undefined,
			getApiKey: async () => "test-key",
			getAvailable: () => [model, altModel],
			getAuthStorageOwner: () => ({}),
			withConsumerLease: async <T>(body: () => T | Promise<T>): Promise<T> => await body(),
		} as never,
		convertToLlm: async messages => convertToLlm(messages),
		extensionRunner: options.extensionRunner,
		ttsrManager: options.ttsrManager,
	});
	sessions.push(session);
	return { session, manager, settings, model, altModel, recapRequests, mainRequests, script };
}

async function waitUntil(predicate: () => boolean, label: string): Promise<void> {
	const deadline = Date.now() + 4000;
	while (!predicate()) {
		if (Date.now() > deadline) throw new Error(`Timed out waiting for ${label}`);
		await Bun.sleep(5);
	}
}

/** Lets any wrongly scheduled work run so a negative assertion is meaningful. */
async function settle(): Promise<void> {
	await Bun.sleep(60);
}

async function runTurn(harness: Harness, text: string): Promise<void> {
	await harness.session.prompt(text);
	await harness.session.waitForIdle();
}

function recapEntries(manager: SessionManager) {
	return manager.getEntries().filter(entry => entry.type === "custom" && entry.customType === SESSION_RECAP_ENTRY);
}

function messageEntryIds(manager: SessionManager, role: "user" | "assistant"): string[] {
	return manager
		.getEntries()
		.flatMap(entry => (entry.type === "message" && entry.message.role === role ? [entry.id] : []));
}

/** Holds the next recap reply until released, so tests can mutate the session while it is pending. */
function holdRecap(harness: Harness): { release: () => void } {
	const gate = Promise.withResolvers<void>();
	harness.script.recap = async () => {
		await gate.promise;
		return { content: ["late recap"] };
	};
	return { release: () => gate.resolve() };
}

async function startPendingRecap(harness: Harness): Promise<{ release: () => void }> {
	const gate = holdRecap(harness);
	await runTurn(harness, "first request");
	await waitUntil(() => harness.recapRequests.length === 1, "recap request");
	return gate;
}

function assistantMessage(
	content: AssistantMessage["content"],
	stopReason: AssistantMessage["stopReason"],
): AssistantMessage {
	return {
		role: "assistant",
		content,
		api: "mock",
		provider: "mock",
		model: "mock-model",
		usage: {
			input: 1,
			output: 1,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 2,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason,
		timestamp: Date.now(),
	};
}

function userMessage(text: string): UserMessage {
	return { role: "user", content: text, timestamp: Date.now() };
}

function toolResult(toolCallId: string, text: string): ToolResultMessage {
	return {
		role: "toolResult",
		toolCallId,
		toolName: "read",
		content: [{ type: "text", text }],
		isError: false,
		timestamp: Date.now(),
	};
}

/** A first answer that is cut mid-stream by a TTSR interrupt: it streams a rule-matching delta, then ends only once aborted. */
function ttsrInterruptibleStream(signal: AbortSignal | undefined): AssistantMessageEventStream {
	const stream = new AssistantMessageEventStream();
	queueMicrotask(() => {
		const text = "let value = result.unwrap(";
		stream.push({ type: "start", partial: assistantMessage([{ type: "text", text: "" }], "stop") });
		stream.push({
			type: "text_delta",
			contentIndex: 0,
			delta: text,
			partial: assistantMessage([{ type: "text", text }], "stop"),
		});
		const abort = (): void => {
			stream.push({
				type: "error",
				reason: "aborted",
				error: assistantMessage([{ type: "text", text }], "aborted"),
			});
		};
		if (signal?.aborted) abort();
		else signal?.addEventListener("abort", abort, { once: true });
	});
	return stream;
}

const noUnwrapRule: Rule = {
	name: "no-unwrap",
	path: "/tmp/no-unwrap.md",
	content: "Do not use .unwrap()",
	condition: ["\\.unwrap\\("],
	_source: { provider: "test", providerName: "test", path: "/tmp/no-unwrap.md", level: "project" },
};

describe("AgentSession turn-end recap", () => {
	describe("generation", () => {
		it("makes no recap call and stores nothing while the opt-in is off", async () => {
			const harness = createHarness({ enabled: false });

			await runTurn(harness, "fix the login redirect bug");
			await settle();

			expect(harness.mainRequests).toHaveLength(1);
			expect(harness.recapRequests).toEqual([]);
			expect(recapEntries(harness.manager)).toHaveLength(0);
			expect(harness.manager.getSessionRecap()).toBeUndefined();
		});

		it("generates one recap per completed turn and links it to the real request and answer entries", async () => {
			const harness = createHarness();

			await runTurn(harness, "fix the login redirect bug");
			await waitUntil(() => harness.manager.getSessionRecap() !== undefined, "recap commit");

			const [requestEntryId] = messageEntryIds(harness.manager, "user");
			const [sourceEntryId] = messageEntryIds(harness.manager, "assistant");
			const recap = harness.manager.getSessionRecap();
			expect(recap).toMatchObject({
				schemaVersion: 1,
				text: "recap-1",
				sourceEntryId,
				requestEntryId,
				model: { provider: "mock", id: "mock-model" },
			});
			expect(Number.isNaN(Date.parse(recap?.generatedAt ?? ""))).toBe(false);
			expect(harness.recapRequests).toHaveLength(1);
			expect(harness.recapRequests[0]).toContain("fix the login redirect bug");
			expect(harness.recapRequests[0]).toContain("main answer 1");
			expect(recapEntries(harness.manager)).toHaveLength(1);
		});

		it("keeps recap text out of the transcript messages and model context", async () => {
			const harness = createHarness();
			const recapText = "로그인 리다이렉트를 고친 요약 전용 문장입니다.";
			harness.script.recap = () => ({ content: [recapText] });

			await runTurn(harness, "fix the login redirect bug");
			await waitUntil(() => harness.manager.getSessionRecap() !== undefined, "recap commit");

			expect(harness.manager.getSessionRecap()?.text).toBe(recapText);
			expect(JSON.stringify(harness.session.agent.state.messages)).not.toContain(recapText);
			expect(JSON.stringify(harness.manager.buildSessionContext().messages)).not.toContain(recapText);
			expect(harness.mainRequests).toHaveLength(1);
		});

		it("does not wait for generation before the turn completes", async () => {
			const harness = createHarness();
			const gate = holdRecap(harness);

			await runTurn(harness, "fix the login redirect bug");
			await waitUntil(() => harness.recapRequests.length === 1, "recap request");

			expect(harness.session.isStreaming).toBe(false);
			expect(messageEntryIds(harness.manager, "assistant")).toHaveLength(1);
			expect(harness.manager.getSessionRecap()).toBeUndefined();
			gate.release();
			await waitUntil(() => harness.manager.getSessionRecap() !== undefined, "recap commit");
		});

		it("reading the recap or entries never triggers another model call", async () => {
			const harness = createHarness();
			await runTurn(harness, "fix the login redirect bug");
			await waitUntil(() => harness.manager.getSessionRecap() !== undefined, "recap commit");
			const entryCount = harness.manager.getEntries().length;

			for (let index = 0; index < 3; index++) {
				harness.manager.getSessionRecap();
				harness.manager.getEntries();
				harness.session.sessionManager.getBranch();
			}
			await settle();

			expect(harness.recapRequests).toHaveLength(1);
			expect(harness.manager.getEntries()).toHaveLength(entryCount);
		});

		it("summarizes the admitted request and the final answer, never steering text or tool output", async () => {
			const harness = createHarness();
			const emit = (event: AgentEvent): void => harness.session.agent.emitExternalEvent(event);
			const toolCall = { type: "toolCall" as const, id: "call-1", name: "read", arguments: { path: "a.ts" } };
			harness.script.onMain = () => {
				emit({ type: "message_end", message: assistantMessage([toolCall], "toolUse") });
				emit({ type: "message_end", message: toolResult("call-1", "TOOL_OUTPUT_SENTINEL") });
				emit({ type: "message_end", message: userMessage("STEERING_TEXT also add a test") });
			};
			harness.script.main = { content: ["FINAL_ANSWER the redirect is fixed"] };

			await runTurn(harness, "ORIGINAL_REQUEST fix the redirect");
			await waitUntil(() => harness.manager.getSessionRecap() !== undefined, "recap commit");

			const userIds = messageEntryIds(harness.manager, "user");
			const assistantIds = messageEntryIds(harness.manager, "assistant");
			expect(userIds).toHaveLength(2);
			expect(harness.manager.getSessionRecap()).toMatchObject({
				requestEntryId: userIds[0],
				sourceEntryId: assistantIds.at(-1),
			});
			expect(harness.recapRequests).toHaveLength(1);
			expect(harness.recapRequests[0]).toContain("ORIGINAL_REQUEST");
			expect(harness.recapRequests[0]).toContain("FINAL_ANSWER");
			expect(harness.recapRequests[0]).not.toContain("STEERING_TEXT");
			expect(harness.recapRequests[0]).not.toContain("TOOL_OUTPUT_SENTINEL");
		});

		it("ignores a replayed agent_end for an already summarized turn", async () => {
			const harness = createHarness();
			await runTurn(harness, "fix the login redirect bug");
			await waitUntil(() => harness.manager.getSessionRecap() !== undefined, "recap commit");
			const messages = [...harness.session.agent.state.messages];

			harness.session.agent.emitExternalEvent({ type: "agent_end", messages });
			harness.session.agent.emitExternalEvent({ type: "agent_end", messages });
			await settle();

			expect(harness.recapRequests).toHaveLength(1);
			expect(recapEntries(harness.manager)).toHaveLength(1);
		});
	});

	describe("turns that must not be summarized", () => {
		it("skips a turn that ended on a length stop", async () => {
			const harness = createHarness();
			harness.script.main = { content: ["cut off"], stopReason: "length" };

			await runTurn(harness, "write a long essay");
			await settle();

			expect(harness.recapRequests).toEqual([]);
			expect(recapEntries(harness.manager)).toHaveLength(0);
		});

		it("skips a turn that ended in a provider error without failing the session", async () => {
			const harness = createHarness();
			harness.script.main = { throw: "provider exploded" };

			await runTurn(harness, "do something");
			await settle();

			expect(harness.recapRequests).toEqual([]);
			expect(recapEntries(harness.manager)).toHaveLength(0);
		});

		it("skips an aborted turn", async () => {
			const harness = createHarness();
			harness.script.main = { content: ["never delivered"], delayMs: 60_000 };

			const run = harness.session.prompt("abort me");
			await waitUntil(() => harness.mainRequests.length === 1, "main request");
			await harness.session.abort();
			await run.catch(() => undefined);
			await settle();

			expect(harness.recapRequests).toEqual([]);
			expect(recapEntries(harness.manager)).toHaveLength(0);
		});

		it("skips a turn whose only user message is synthetic", async () => {
			const harness = createHarness();
			const emit = (event: AgentEvent): void => harness.session.agent.emitExternalEvent(event);

			emit({ type: "message_end", message: { ...userMessage("auto-continue"), synthetic: true } });
			emit({ type: "message_end", message: assistantMessage([{ type: "text", text: "done" }], "stop") });
			emit({ type: "agent_end", messages: [] });
			await settle();

			expect(harness.recapRequests).toEqual([]);
			expect(recapEntries(harness.manager)).toHaveLength(0);
		});
	});

	describe("request lifecycle", () => {
		const overloaded = (retryAfterMs: number): MockResponse => ({
			throw: `503 service unavailable: overloaded_error retry-after-ms=${retryAfterMs}`,
		});

		interface ParkedRetry {
			/** The still-pending first prompt. Wrapped so `await`ing the helper never awaits the prompt itself. */
			run: Promise<void>;
			retryEnds: Array<Extract<AgentSessionEvent, { type: "auto_retry_end" }>>;
		}

		/** Starts a retry that is parked in a long backoff, with R1 admitted and nothing answered yet. */
		async function parkInRetryBackoff(harness: Harness): Promise<ParkedRetry> {
			harness.script.mainQueue.push(overloaded(60_000));
			const retryEnds: ParkedRetry["retryEnds"] = [];
			let retryStarted = false;
			harness.session.subscribe(event => {
				if (event.type === "auto_retry_start") retryStarted = true;
				if (event.type === "auto_retry_end") retryEnds.push(event);
			});
			const run = harness.session.prompt("FIRST_REQUEST fix the login redirect");
			await waitUntil(() => retryStarted, "auto_retry_start");
			expect(harness.mainRequests).toHaveLength(1);
			return { run, retryEnds };
		}

		async function expectNextTurnOwnsItsRecap(harness: Harness): Promise<void> {
			await runTurn(harness, "SECOND_REQUEST add a regression test");
			await waitUntil(() => harness.manager.getSessionRecap() !== undefined, "second recap commit");
			const userIds = messageEntryIds(harness.manager, "user");
			const assistantIds = messageEntryIds(harness.manager, "assistant");
			expect(harness.recapRequests).toHaveLength(1);
			expect(harness.recapRequests[0]).toContain("SECOND_REQUEST");
			expect(harness.recapRequests[0]).not.toContain("FIRST_REQUEST");
			expect(harness.manager.getSessionRecap()).toMatchObject({
				requestEntryId: userIds.at(-1),
				sourceEntryId: assistantIds.at(-1),
			});
			expect(userIds).toHaveLength(2);
			expect(recapEntries(harness.manager)).toHaveLength(1);
		}

		it("completes a provider-error retry with one recap of the original request and the retried answer", async () => {
			const harness = createHarness({ retry: true });
			harness.script.mainQueue.push(overloaded(5));

			await runTurn(harness, "FIRST_REQUEST fix the login redirect");
			await waitUntil(() => harness.manager.getSessionRecap() !== undefined, "recap commit");
			await settle();

			expect(harness.mainRequests).toHaveLength(2);
			expect(harness.recapRequests).toHaveLength(1);
			expect(harness.recapRequests[0]).toContain("FIRST_REQUEST");
			expect(harness.recapRequests[0]).toContain("main answer 2");
			expect(messageEntryIds(harness.manager, "user")).toHaveLength(1);
			expect(harness.manager.getSessionRecap()).toMatchObject({
				requestEntryId: messageEntryIds(harness.manager, "user")[0],
				sourceEntryId: messageEntryIds(harness.manager, "assistant").at(-1),
			});
			expect(recapEntries(harness.manager)).toHaveLength(1);
		});

		it("does not revive the first request after abortRetry cancels the retry backoff", async () => {
			const harness = createHarness({ retry: true });
			const { run, retryEnds } = await parkInRetryBackoff(harness);

			harness.session.abortRetry();
			await run;
			await harness.session.waitForIdle();
			await settle();
			expect(retryEnds).toHaveLength(1);
			expect(retryEnds[0]?.success).toBe(false);
			expect(harness.session.isStreaming).toBe(false);
			expect(harness.mainRequests).toHaveLength(1);
			expect(harness.recapRequests).toEqual([]);
			expect(recapEntries(harness.manager)).toHaveLength(0);

			// The next genuine prompt must be summarized on its own request, never R1 + A2.
			await expectNextTurnOwnsItsRecap(harness);
		});

		it("does not revive the first request after abort cancels the retry backoff", async () => {
			const harness = createHarness({ retry: true });
			const { run, retryEnds } = await parkInRetryBackoff(harness);

			const [outcome] = await Promise.allSettled([run, harness.session.abort()]);
			// Cancelling the parked prompt may reject it; any other failure is a real bug.
			if (outcome.status === "rejected") expect(String(outcome.reason)).toMatch(/abort|cancel/i);
			await harness.session.waitForIdle();
			await settle();
			expect(retryEnds.every(event => !event.success)).toBe(true);
			expect(harness.session.isStreaming).toBe(false);
			expect(harness.mainRequests).toHaveLength(1);
			expect(harness.recapRequests).toEqual([]);
			expect(recapEntries(harness.manager)).toHaveLength(0);

			await expectNextTurnOwnsItsRecap(harness);
		});

		it("drops the request of a turn whose mid-run maintenance was aborted without a final answer", async () => {
			const noop: AgentTool = {
				name: "noop",
				label: "Noop",
				description: "Does nothing so the run reaches the mid-run maintenance checkpoint",
				parameters: z.object({}),
				execute: async () => ({ content: [{ type: "text" as const, text: "done" }] }),
			};
			const harness = createHarness({ tools: [noop] });
			// The loop consults maintenance after the tool results of a run that already got a model
			// response. "aborted" is what abortCompaction() alone produces: the run ends with the
			// maintenance terminal and no final answer, and no abort handler ever runs.
			let maintenanceCalls = 0;
			harness.session.agent.setMaintainContext(async () => (++maintenanceCalls === 1 ? "aborted" : "not-needed"));
			const maintenanceTerminals: AgentEvent[] = [];
			harness.session.agent.subscribe(event => {
				if (event.type === "agent_end" && event.stopReason === "maintenance") maintenanceTerminals.push(event);
			});
			harness.script.mainQueue.push({ content: [{ type: "toolCall", name: "noop", arguments: {} }] });

			await runTurn(harness, "FIRST_REQUEST fix the login redirect");
			await settle();

			// Premise: the run really ended through the maintenance-aborted terminal, after one model call.
			expect(maintenanceTerminals).toHaveLength(1);
			expect(maintenanceTerminals[0]).toMatchObject({ stopReason: "maintenance", maintenanceOutcome: "aborted" });
			expect(harness.mainRequests).toHaveLength(1);
			expect(messageEntryIds(harness.manager, "assistant")).toHaveLength(1);
			expect(harness.recapRequests).toEqual([]);
			expect(recapEntries(harness.manager)).toHaveLength(0);

			await expectNextTurnOwnsItsRecap(harness);
		});

		it("publishes one recap from the final answer of a todo-reminder continuation, not the first stop", async () => {
			const harness = createHarness();
			const unfinished = [{ name: "Work", tasks: [{ content: "Finish the fix", status: "in_progress" as const }] }];
			harness.session.setTodoPhases(unfinished);
			harness.script.onMain = call => {
				if (call === 2) {
					harness.session.setTodoPhases([
						{ name: "Work", tasks: [{ content: "Finish the fix", status: "completed" as const }] },
					]);
				}
			};
			harness.script.main = undefined;

			await runTurn(harness, "FIRST_REQUEST fix the login redirect");
			await waitUntil(() => harness.manager.getSessionRecap() !== undefined, "recap commit");
			await settle();

			expect(harness.mainRequests).toHaveLength(2);
			expect(harness.recapRequests).toHaveLength(1);
			expect(harness.recapRequests[0]).toContain("FIRST_REQUEST");
			expect(harness.recapRequests[0]).toContain("main answer 2");
			expect(harness.recapRequests[0]).not.toContain("main answer 1");
			expect(harness.manager.getSessionRecap()).toMatchObject({
				requestEntryId: messageEntryIds(harness.manager, "user")[0],
				sourceEntryId: messageEntryIds(harness.manager, "assistant").at(-1),
			});
		});

		it("publishes one recap from the final answer when threshold compaction auto-continues the turn", async () => {
			const dir = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-agent-session-recap-compaction-"));
			tempDirs.push(dir);
			const extensionPath = path.join(getProjectAgentDir(dir), "extensions", "short-circuit-compaction.ts");
			await fs.mkdir(path.dirname(extensionPath), { recursive: true });
			await Bun.write(
				extensionPath,
				[
					"export default function(pi) {",
					'\tpi.on("session_before_compact", async (event) => {',
					'\t\treturn { compaction: { summary: "compacted", shortSummary: undefined, firstKeptEntryId: event.preparation.firstKeptEntryId, tokensBefore: event.preparation.tokensBefore, details: {} } };',
					"\t});",
					"}",
				].join("\n"),
			);
			const manager = SessionManager.inMemory(dir);
			const loaded = await loadExtensions([extensionPath], dir);
			const extensionRunner = new ExtensionRunner(loaded.extensions, loaded.runtime, dir, manager, {} as never);
			const harness = createHarness({ manager, compaction: true, extensionRunner });
			const unfinished = [{ name: "Work", tasks: [{ content: "Finish the fix", status: "in_progress" as const }] }];
			harness.session.setTodoPhases(unfinished);
			harness.script.onMain = call => {
				if (call === 2) {
					harness.session.setTodoPhases([
						{ name: "Work", tasks: [{ content: "Finish the fix", status: "completed" as const }] },
					]);
				}
			};
			// The first answer reports a context size over the compaction threshold, so its terminal compacts and
			// auto-continues the same turn with a synthetic developer prompt.
			harness.script.mainQueue.push({
				content: ["main answer 1"],
				usage: { input: 190_000, output: 1_000, totalTokens: 191_000 },
			});

			await runTurn(harness, "FIRST_REQUEST fix the login redirect");
			await waitUntil(() => harness.manager.getSessionRecap() !== undefined, "recap commit");
			await settle();

			// Premise: a real auto-continuation ran a second model call.
			expect(harness.mainRequests).toHaveLength(2);
			expect(harness.recapRequests).toHaveLength(1);
			expect(harness.recapRequests[0]).toContain("FIRST_REQUEST");
			expect(harness.recapRequests[0]).toContain("main answer 2");
			expect(harness.recapRequests[0]).not.toContain("main answer 1");
			expect(recapEntries(harness.manager)).toHaveLength(1);
			expect(harness.manager.getSessionRecap()).toMatchObject({
				requestEntryId: messageEntryIds(harness.manager, "user")[0],
				sourceEntryId: messageEntryIds(harness.manager, "assistant").at(-1),
			});
		});

		it("publishes one recap of the final answer when threshold compaction has no unfinished work to continue", async () => {
			const dir = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-agent-session-recap-compaction-idle-"));
			tempDirs.push(dir);
			const extensionPath = path.join(getProjectAgentDir(dir), "extensions", "short-circuit-compaction.ts");
			await fs.mkdir(path.dirname(extensionPath), { recursive: true });
			await Bun.write(
				extensionPath,
				[
					"export default function(pi) {",
					'\tpi.on("session_before_compact", async (event) => {',
					'\t\treturn { compaction: { summary: "compacted", shortSummary: undefined, firstKeptEntryId: event.preparation.firstKeptEntryId, tokensBefore: event.preparation.tokensBefore, details: {} } };',
					"\t});",
					"}",
				].join("\n"),
			);
			const manager = SessionManager.inMemory(dir);
			const loaded = await loadExtensions([extensionPath], dir);
			const extensionRunner = new ExtensionRunner(loaded.extensions, loaded.runtime, dir, manager, {} as never);
			const harness = createHarness({ manager, compaction: true, extensionRunner });
			// No todo, goal, workflow, or queued work: the compaction's auto-continue is denied, so the first
			// answer is the real final answer and must not lose its recap with the consumed request.
			harness.script.mainQueue.push({
				content: ["main answer 1"],
				usage: { input: 190_000, output: 1_000, totalTokens: 191_000 },
			});

			await runTurn(harness, "FIRST_REQUEST fix the login redirect");
			await waitUntil(() => harness.manager.getSessionRecap() !== undefined, "recap commit");
			await settle();

			expect(harness.mainRequests).toHaveLength(1);
			expect(harness.recapRequests).toHaveLength(1);
			expect(harness.recapRequests[0]).toContain("FIRST_REQUEST");
			expect(harness.recapRequests[0]).toContain("main answer 1");
			expect(recapEntries(harness.manager)).toHaveLength(1);
			expect(harness.manager.getSessionRecap()).toMatchObject({
				requestEntryId: messageEntryIds(harness.manager, "user")[0],
				sourceEntryId: messageEntryIds(harness.manager, "assistant").at(-1),
			});
		});

		it("never recaps an aborted threshold-compaction terminal and links the next genuine request to its own recap", async () => {
			const dir = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-agent-session-recap-compaction-abort-"));
			tempDirs.push(dir);
			const extensionPath = path.join(getProjectAgentDir(dir), "extensions", "short-circuit-compaction.ts");
			await fs.mkdir(path.dirname(extensionPath), { recursive: true });
			await Bun.write(
				extensionPath,
				[
					"export default function(pi) {",
					'\tpi.on("session_before_compact", async (event) => {',
					'\t\treturn { compaction: { summary: "compacted", shortSummary: undefined, firstKeptEntryId: event.preparation.firstKeptEntryId, tokensBefore: event.preparation.tokensBefore, details: {} } };',
					"\t});",
					"}",
				].join("\n"),
			);
			const manager = SessionManager.inMemory(dir);
			const loaded = await loadExtensions([extensionPath], dir);
			const extensionRunner = new ExtensionRunner(loaded.extensions, loaded.runtime, dir, manager, {} as never);
			const harness = createHarness({ manager, compaction: true, extensionRunner });
			harness.script.mainQueue.push({
				content: ["main answer 1"],
				usage: { input: 190_000, output: 1_000, totalTokens: 191_000 },
			});
			// The abort lands at auto_compaction_end, before the auto-continue authorization runs: the first
			// terminal is invalidated and must never be summarized, even though no continuation is admitted.
			let aborted = false;
			harness.session.subscribe(event => {
				if (event.type === "auto_compaction_end" && !aborted) {
					aborted = true;
					void harness.session.abort();
				}
			});

			await runTurn(harness, "FIRST_REQUEST fix the login redirect");
			await settle();
			expect(aborted).toBe(true);
			expect(harness.recapRequests).toEqual([]);
			expect(recapEntries(harness.manager)).toHaveLength(0);

			await runTurn(harness, "SECOND_REQUEST add a test");
			await waitUntil(() => harness.manager.getSessionRecap() !== undefined, "recap commit");
			await settle();

			expect(harness.recapRequests).toHaveLength(1);
			expect(harness.recapRequests[0]).toContain("SECOND_REQUEST");
			expect(harness.recapRequests[0]).not.toContain("FIRST_REQUEST");
			expect(harness.recapRequests[0]).not.toContain("main answer 1");
			expect(recapEntries(harness.manager)).toHaveLength(1);
			expect(harness.manager.getSessionRecap()).toMatchObject({
				requestEntryId: messageEntryIds(harness.manager, "user").at(-1),
				sourceEntryId: messageEntryIds(harness.manager, "assistant").at(-1),
			});
		});

		it("recaps only the final answer after a TTSR interrupt resumes the turn", async () => {
			const ttsrManager = new TtsrManager({
				enabled: true,
				contextMode: "discard",
				interruptMode: "always",
				repeatMode: "once",
				repeatGap: 10,
			});
			ttsrManager.addRule(noUnwrapRule);
			const harness = createHarness({
				ttsrManager,
				interceptMain: (call, signal) => (call === 1 ? ttsrInterruptibleStream(signal) : undefined),
			});
			let recapsWhenResumed = -1;
			harness.script.onMain = () => {
				recapsWhenResumed = harness.recapRequests.length;
			};

			await runTurn(harness, "FIRST_REQUEST fix the login redirect");
			await waitUntil(() => harness.manager.getSessionRecap() !== undefined, "recap commit");
			await settle();

			// Premise: the interrupted first answer never reached the mock provider; only the resume did.
			expect(harness.mainRequests).toHaveLength(1);
			// The aborted half summarized nothing; the resume's final answer summarized once.
			expect(recapsWhenResumed).toBe(0);
			expect(harness.recapRequests).toHaveLength(1);
			expect(harness.recapRequests[0]).toContain("FIRST_REQUEST");
			expect(harness.recapRequests[0]).toContain("main answer 1");
			expect(harness.recapRequests[0]).not.toContain("unwrap(");
			expect(recapEntries(harness.manager)).toHaveLength(1);
			expect(harness.manager.getSessionRecap()).toMatchObject({
				requestEntryId: messageEntryIds(harness.manager, "user")[0],
				sourceEntryId: messageEntryIds(harness.manager, "assistant").at(-1),
			});
		});

		it("never attaches a cancelled first request to a follow-up queued in the same generation", async () => {
			const harness = createHarness({ retry: true });
			const { run, retryEnds } = await parkInRetryBackoff(harness);
			const [firstUserId] = messageEntryIds(harness.manager, "user");

			await harness.session.prompt("FOLLOWUP_TEXT add a regression test", { streamingBehavior: "followUp" });
			harness.session.abortRetry();
			await run;
			await harness.session.waitForIdle();
			await settle();

			expect(retryEnds.every(event => !event.success)).toBe(true);
			for (const request of harness.recapRequests) expect(request).not.toContain("FIRST_REQUEST");
			expect(harness.manager.getSessionRecap()?.requestEntryId).not.toBe(firstUserId ?? "");
		});

		it("never promotes a steering user message to the request when the opt-in is turned on mid-run", async () => {
			const harness = createHarness({ enabled: false });
			harness.script.onMain = () => {
				harness.settings.set("recap.enabled", true);
				harness.session.agent.emitExternalEvent({
					type: "message_end",
					message: userMessage("STEERING_TEXT also add a test"),
				});
			};

			await runTurn(harness, "ORIGINAL_REQUEST fix the redirect");
			await settle();

			expect(messageEntryIds(harness.manager, "user")).toHaveLength(2);
			expect(harness.recapRequests).toEqual([]);
			expect(recapEntries(harness.manager)).toHaveLength(0);
		});

		for (const [name, options] of [
			["a synthetic", { synthetic: true }],
			["an agent-attributed", { attribution: "agent" as const }],
		] as const) {
			it(`gives ${name} prompt no recap`, async () => {
				const harness = createHarness();

				await harness.session.prompt("internal housekeeping step", options);
				await harness.session.waitForIdle();
				await settle();

				expect(harness.recapRequests).toEqual([]);
				expect(recapEntries(harness.manager)).toHaveLength(0);
			});
		}

		it("gives an image-only request no recap, as there is no user text to summarize", async () => {
			const harness = createHarness();

			await harness.session.prompt(" ", {
				images: [{ type: "image", data: "iVBORw0KGgo=", mimeType: "image/png" }],
			});
			await harness.session.waitForIdle();
			await settle();

			expect(harness.recapRequests).toEqual([]);
			expect(recapEntries(harness.manager)).toHaveLength(0);
		});

		it("keeps a pending recap alive when a prompt is rejected during preflight", async () => {
			const harness = createHarness();
			const gate = await startPendingRecap(harness);
			const cancelled = new AbortController();
			cancelled.abort();

			await harness.session.prompt("never admitted", { preflightSignal: cancelled.signal }).catch(() => undefined);
			gate.release();
			await waitUntil(() => harness.manager.getSessionRecap() !== undefined, "recap commit");

			expect(harness.manager.getSessionRecap()?.text).toBe("late recap");
			expect(recapEntries(harness.manager)).toHaveLength(1);
		});

		it("publishes nothing when the session state changes while the terminal's post-turn work awaits", async () => {
			const harness = createHarness();
			harness.session.setClientBridge({ capabilities: {}, deferAgentInitiatedTurns: true });
			harness.session.setTodoPhases([
				{ name: "Work", tasks: [{ content: "Finish the fix", status: "in_progress" }] },
			]);
			// The advisory todo event is emitted from inside the agent_end handler, after its first awaits.
			harness.session.subscribe(event => {
				if (event.type === "todo_reminder") harness.settings.set("ui.language", "ko");
			});

			await runTurn(harness, "FIRST_REQUEST fix the login redirect");
			await settle();

			expect(harness.mainRequests).toHaveLength(1);
			expect(harness.recapRequests).toEqual([]);
			expect(recapEntries(harness.manager)).toHaveLength(0);
		});

		it("reports a persistence failure as a warning that carries no request, answer, recap, or error text", async () => {
			const harness = createHarness();
			const warn = vi.spyOn(logger, "warn").mockImplementation(() => undefined);
			vi.spyOn(harness.manager, "appendSessionRecap").mockImplementation(() => {
				throw new Error("disk full SECRET_ERROR_BODY");
			});
			try {
				harness.script.main = { content: ["ANSWER_SENTINEL fixed"] };
				harness.script.recap = () => ({ content: ["RECAP_SENTINEL"] });

				await runTurn(harness, "REQUEST_SENTINEL fix the redirect");
				const ours = () => warn.mock.calls.filter(call => call[0] === "session recap persistence failed");
				await waitUntil(() => ours().length > 0, "persistence warning");

				expect(ours()).toHaveLength(1);
				const logged = JSON.stringify(ours());
				for (const secret of ["SECRET_ERROR_BODY", "REQUEST_SENTINEL", "ANSWER_SENTINEL", "RECAP_SENTINEL"]) {
					expect(logged).not.toContain(secret);
				}
				expect(recapEntries(harness.manager)).toHaveLength(0);
				expect(harness.session.isStreaming).toBe(false);
			} finally {
				vi.restoreAllMocks();
			}
		});
	});

	describe("failed generation", () => {
		const failures: Array<[string, MockResponse]> = [
			["a truncated response", { content: ["cut off recap"], stopReason: "length" }],
			["an empty response", { content: ["   "] }],
			["an over-length response", { content: ["a".repeat(121)] }],
			["a multi-line response", { content: ["first line\nsecond line"] }],
			["a tool call", { content: [{ type: "toolCall", name: "read", arguments: { path: "x" } }] }],
			["a provider error", { throw: "provider exploded" }],
		];

		for (const [name, reply] of failures) {
			it(`leaves no recap and does not retry after ${name}`, async () => {
				const harness = createHarness();
				harness.script.recap = () => reply;

				await runTurn(harness, "fix the login redirect bug");
				await waitUntil(() => harness.recapRequests.length === 1, "recap request");
				await settle();
				harness.session.agent.emitExternalEvent({
					type: "agent_end",
					messages: [...harness.session.agent.state.messages],
				});
				await settle();

				expect(harness.recapRequests).toHaveLength(1);
				expect(harness.mainRequests).toHaveLength(1);
				expect(recapEntries(harness.manager)).toHaveLength(0);
				expect(harness.manager.getSessionRecap()).toBeUndefined();
				expect(messageEntryIds(harness.manager, "assistant")).toHaveLength(1);
			});
		}
	});

	describe("pending generation is discarded", () => {
		it("when a new turn starts", async () => {
			const harness = createHarness();
			const gate = await startPendingRecap(harness);
			harness.script.recap = () => ({ content: ["second recap"] });

			await runTurn(harness, "second request");
			await waitUntil(() => harness.manager.getSessionRecap() !== undefined, "second recap commit");
			gate.release();
			await settle();

			const assistantIds = messageEntryIds(harness.manager, "assistant");
			expect(harness.recapRequests).toHaveLength(2);
			expect(recapEntries(harness.manager)).toHaveLength(1);
			expect(harness.manager.getSessionRecap()).toMatchObject({
				text: "second recap",
				sourceEntryId: assistantIds[1],
			});
		});

		it("when the main turn is aborted", async () => {
			const harness = createHarness();
			const gate = await startPendingRecap(harness);

			await harness.session.abort();
			gate.release();
			await settle();

			expect(recapEntries(harness.manager)).toHaveLength(0);
			expect(harness.recapRequests).toHaveLength(1);
		});

		it("when the opt-in is turned off", async () => {
			const harness = createHarness();
			const gate = await startPendingRecap(harness);

			harness.settings.set("recap.enabled", false);
			gate.release();
			await settle();

			expect(recapEntries(harness.manager)).toHaveLength(0);
			expect(harness.recapRequests).toHaveLength(1);
		});

		it("when the language changes", async () => {
			const harness = createHarness();
			const gate = await startPendingRecap(harness);

			harness.settings.set("ui.language", "ko");
			gate.release();
			await settle();

			expect(recapEntries(harness.manager)).toHaveLength(0);
			expect(harness.recapRequests).toHaveLength(1);
		});

		it("when the recap model selection changes", async () => {
			const harness = createHarness();
			const gate = await startPendingRecap(harness);

			harness.settings.overrideModelRoles({ default: `${harness.altModel.provider}/${harness.altModel.id}` });
			gate.release();
			await settle();

			expect(recapEntries(harness.manager)).toHaveLength(0);
			expect(harness.recapRequests).toHaveLength(1);
		});

		it("when the leaf moves off the summarized turn", async () => {
			const harness = createHarness();
			const gate = await startPendingRecap(harness);
			const [requestEntryId] = messageEntryIds(harness.manager, "user");

			harness.manager.branch(requestEntryId ?? "");
			gate.release();
			await settle();

			expect(recapEntries(harness.manager)).toHaveLength(0);
			expect(harness.manager.getLeafId()).toBe(requestEntryId ?? null);
		});

		it("when the session is replaced", async () => {
			const harness = createHarness();
			const gate = await startPendingRecap(harness);

			await harness.session.newSession();
			gate.release();
			await settle();

			expect(recapEntries(harness.manager)).toHaveLength(0);
			expect(harness.manager.getSessionRecap()).toBeUndefined();
			expect(harness.recapRequests).toHaveLength(1);
		});

		it("when the session is disposed", async () => {
			const harness = createHarness();
			const gate = await startPendingRecap(harness);

			await harness.session.dispose();
			gate.release();
			await settle();

			expect(recapEntries(harness.manager)).toHaveLength(0);
			expect(harness.recapRequests).toHaveLength(1);
		});
	});

	describe("resume", () => {
		it("reads the persisted recap after reopening without generating anything", async () => {
			const dir = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-agent-session-recap-"));
			tempDirs.push(dir);
			const sessionsDir = path.join(dir, "sessions");
			const manager = SessionManager.create(dir, sessionsDir);
			const harness = createHarness({ manager });
			await runTurn(harness, "persist this request");
			await waitUntil(() => manager.getSessionRecap() !== undefined, "recap commit");
			const saved = manager.getSessionRecap();
			await manager.flush();
			const sessionFile = manager.getSessionFile();
			if (!saved || !sessionFile) throw new Error("Expected a persisted recap and session file");
			await harness.session.dispose();
			await manager.close();

			const reopened = await SessionManager.open(sessionFile, dir);
			const resumed = createHarness({ manager: reopened });
			await SessionManager.list(dir, sessionsDir);
			await settle();

			expect(resumed.recapRequests).toEqual([]);
			expect(resumed.mainRequests).toEqual([]);
			expect(reopened.getSessionRecap()).toEqual(saved);
			expect(recapEntries(reopened)).toHaveLength(1);
			await resumed.session.dispose();
			await reopened.close();
		});
	});
});
