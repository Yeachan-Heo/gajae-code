/**
 * Tests for AgentSession concurrent prompt guard.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Agent, AgentBusyError, type AgentTool } from "@gajae-code/agent-core";
import { type AssistantMessage, getBundledModel, type Message, type ToolCall } from "@gajae-code/ai";
import { createMockModel } from "@gajae-code/ai/providers/mock";
import { AssistantMessageEventStream } from "@gajae-code/ai/utils/event-stream";
import { createAppendOnlyContextManager } from "@gajae-code/coding-agent/append-only-mode";
import { AsyncJobManager } from "@gajae-code/coding-agent/async";
import type { Rule } from "@gajae-code/coding-agent/capability/rule";
import { ModelRegistry } from "@gajae-code/coding-agent/config/model-registry";
import { Settings } from "@gajae-code/coding-agent/config/settings";
import { TtsrManager } from "@gajae-code/coding-agent/export/ttsr";
import type { ExtensionRunner } from "@gajae-code/coding-agent/extensibility/extensions/runner";
import { submitInteractiveInput } from "@gajae-code/coding-agent/main";
import type { SubmittedUserInput } from "@gajae-code/coding-agent/modes/types";
import { AgentSession } from "@gajae-code/coding-agent/session/agent-session";
import { AuthStorage } from "@gajae-code/coding-agent/session/auth-storage";
import { convertToLlm } from "@gajae-code/coding-agent/session/messages";
import { SessionManager } from "@gajae-code/coding-agent/session/session-manager";
import { Snowflake } from "@gajae-code/utils";
import * as z from "zod/v4";
import { createAssistantMessage } from "./helpers/agent-session-setup";

// Mock stream that mimics AssistantMessageEventStream

describe("AgentSession concurrent prompt guard", () => {
	let session: AgentSession;
	let tempDir: string;
	const authStorages: AuthStorage[] = [];

	beforeEach(() => {
		tempDir = path.join(os.tmpdir(), `pi-concurrent-test-${Snowflake.next()}`);
		fs.mkdirSync(tempDir, { recursive: true });
	});

	afterEach(async () => {
		if (session) {
			await session.dispose();
		}
		for (const authStorage of authStorages.splice(0)) {
			authStorage.close();
		}
		if (tempDir && fs.existsSync(tempDir)) {
			fs.rmSync(tempDir, { recursive: true });
		}
		vi.restoreAllMocks();
		AsyncJobManager.resetForTests();
	});

	async function createSession() {
		const model = getBundledModel("anthropic", "claude-sonnet-4-5")!;
		let abortSignal: AbortSignal | undefined;

		// Use a stream function that responds to abort
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: {
				model,
				systemPrompt: ["Test"],
				tools: [],
			},
			streamFn: (_model, _context, options) => {
				abortSignal = options?.signal;
				const stream = new AssistantMessageEventStream();
				queueMicrotask(() => {
					stream.push({ type: "start", partial: createAssistantMessage("") });
					if (abortSignal) {
						abortSignal.addEventListener(
							"abort",
							() => {
								stream.push({ type: "error", reason: "aborted", error: createAssistantMessage("Aborted") });
							},
							{ once: true },
						);
					}
				});
				return stream;
			},
		});

		const sessionManager = SessionManager.inMemory();
		const settings = Settings.isolated();
		const authStorage = await AuthStorage.create(path.join(tempDir, "testauth.db"));
		authStorages.push(authStorage);
		const modelRegistry = new ModelRegistry(authStorage, path.join(tempDir, "models.yml"));
		authStorage.setRuntimeApiKey("anthropic", "test-key");

		session = new AgentSession({
			agent,
			sessionManager,
			settings,
			modelRegistry,
		});

		return session;
	}

	async function waitFor(predicate: () => boolean, timeoutMs = 500): Promise<void> {
		const deadline = Date.now() + timeoutMs;
		while (Date.now() < deadline) {
			if (predicate()) return;
			await Bun.sleep(10);
		}

		throw new Error("Timed out waiting for condition");
	}

	it("should throw when prompt() called while streaming", async () => {
		await createSession();

		// Start first prompt (don't await, it will block until abort)
		const firstPrompt = session.prompt("First message");

		await waitFor(() => session.agent.state.isStreaming);

		// Second prompt should reject
		await expect(session.prompt("Second message")).rejects.toBeInstanceOf(AgentBusyError);

		// Cleanup
		await session.abort();
		await firstPrompt.catch(() => {}); // Ignore abort error
	});

	it("aborts stalled API-key preflight, clears the submission, and accepts the next prompt", async () => {
		const model = getBundledModel("anthropic", "claude-sonnet-4-5")!;
		let streamCalls = 0;
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model, systemPrompt: ["Test"], tools: [] },
			streamFn: () => {
				streamCalls += 1;
				const stream = new AssistantMessageEventStream();
				queueMicrotask(() => {
					const message = createAssistantMessage("ok");
					stream.push({ type: "start", partial: message });
					stream.push({ type: "done", reason: "stop", message });
				});
				return stream;
			},
		});
		const sessionManager = SessionManager.inMemory();
		const authStorage = await AuthStorage.create(path.join(tempDir, "testauth-preflight-cancel.db"));
		authStorages.push(authStorage);
		const modelRegistry = new ModelRegistry(authStorage, path.join(tempDir, "models.yml"));
		const apiKeyGate = Promise.withResolvers<string | undefined>();
		let stallApiKey = true;
		let preflightSignal: AbortSignal | undefined;
		vi.spyOn(modelRegistry, "getApiKey").mockImplementation(async (_model, _sessionId, options) => {
			preflightSignal = options?.signal;
			return stallApiKey ? apiKeyGate.promise : "test-key";
		});
		session = new AgentSession({ agent, sessionManager, settings: Settings.isolated(), modelRegistry });

		const mode = {
			markPendingSubmissionStarted: vi.fn(() => true),
			finishPendingSubmission: vi.fn(),
			showError: vi.fn(),
			checkShutdownRequested: vi.fn(async () => {}),
			waitForAgentEnd: vi.fn(() => ({
				promise: Promise.withResolvers<void>().promise,
				dispose: vi.fn(),
			})),
		};
		const input: SubmittedUserInput = {
			text: "cancel during auth",
			images: undefined,
			cancelled: false,
			started: false,
		};
		const submission = submitInteractiveInput(mode, session, input);
		const submissionOutcome = submission.then(() => "settled" as const);
		let abort: Promise<void> | undefined;
		try {
			await waitFor(() => preflightSignal !== undefined);

			abort = session.abort();
			const outcome = await Promise.race([submissionOutcome, Bun.sleep(100).then(() => "pending" as const)]);
			apiKeyGate.resolve("test-key");
			await submission;
			await abort;

			expect(outcome).toBe("settled");
			expect(preflightSignal?.aborted).toBe(true);
			expect(mode.finishPendingSubmission).toHaveBeenCalledWith(input);
			expect(mode.showError).not.toHaveBeenCalled();
			expect(session.isStreaming).toBe(false);
			expect(
				agent.state.messages.filter(message => message.role === "user" || message.role === "assistant"),
			).toEqual([]);

			stallApiKey = false;
			await session.prompt("after abort");

			expect(streamCalls).toBe(1);
			expect(agent.state.messages.filter(message => message.role === "user")).toHaveLength(1);
			expect(agent.state.messages.filter(message => message.role === "assistant")).toHaveLength(1);
		} finally {
			apiKeyGate.resolve("test-key");
			await Promise.allSettled(abort ? [submission, abort] : [submission]);
		}
	});

	it("should allow steer() while streaming", async () => {
		await createSession();

		// Start first prompt
		const firstPrompt = session.prompt("First message");
		await waitFor(() => session.agent.state.isStreaming);

		// steer should work while streaming. Capture the queued state before
		// awaiting steer(): async steering may immediately resume/consume the
		// queued message on fast runners once the promise settles.
		const steering = session.steer("Steering message");
		expect(session.queuedMessageCount).toBe(1);
		await expect(steering).resolves.toBeUndefined();

		// Cleanup
		await session.abort();
		await firstPrompt.catch(() => {});
	});

	it("should allow followUp() while streaming", async () => {
		await createSession();

		// Start first prompt
		const firstPrompt = session.prompt("First message");
		await waitFor(() => session.agent.state.isStreaming);

		// followUp should work while streaming
		expect(() => session.followUp("Follow-up message")).not.toThrow();
		expect(session.queuedMessageCount).toBe(1);

		// Cleanup
		await session.abort();
		await firstPrompt.catch(() => {});
	});

	it("sendUserMessage with no deliverAs steers while streaming instead of throwing", async () => {
		await createSession();

		// Start first prompt (blocks until abort)
		const firstPrompt = session.prompt("First message");
		await waitFor(() => session.agent.state.isStreaming);

		// With no explicit deliverAs, a busy session should queue as steering
		// rather than throw AgentBusyError.
		const send = session.sendUserMessage("Busy message");
		expect(session.getQueuedMessages()).toEqual({ steering: ["Busy message"], followUp: [] });
		await expect(send).resolves.toBeUndefined();

		// Cleanup
		await session.abort();
		await firstPrompt.catch(() => {});
	});

	it("sendUserMessage with no deliverAs starts a fresh turn when idle", async () => {
		await createSession();

		expect(session.isStreaming).toBe(false);
		const send = session.sendUserMessage("Idle message");
		await waitFor(() => session.agent.state.isStreaming);
		expect(session.queuedMessageCount).toBe(0);

		// Cleanup
		await session.abort();
		await send.catch(() => {});
	});
	it("immediate sendUserMessage after abort starts a successor turn instead of parking in steer", async () => {
		const model = getBundledModel("anthropic", "claude-sonnet-4-5")!;
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model, systemPrompt: ["Test"], tools: [] },
			// Branch on the newest user message, NOT a stream-call counter: the
			// session reports `isStreaming` before `streamFn` runs, so the aborted
			// turn's dispatch races the abort. Keyed on a counter, the SUCCESSOR turn
			// could take the blocking branch and hang the test whenever the first
			// turn's dispatch had not landed yet.
			streamFn: (_model, context, options) => {
				const lastUser = [...(context?.messages ?? [])].reverse().find(message => message.role === "user");
				const text =
					lastUser && Array.isArray(lastUser.content)
						? lastUser.content
								.map(part => (typeof part === "object" && part.type === "text" ? part.text : ""))
								.join("")
						: "";
				const signal = options?.signal;
				const stream = new AssistantMessageEventStream();
				queueMicrotask(() => {
					if (text === "First message") {
						stream.push({ type: "start", partial: createAssistantMessage("") });
						const abortStream = () => {
							stream.push({
								type: "error",
								reason: "aborted",
								error: createAssistantMessage("Aborted"),
							});
						};
						if (signal?.aborted) {
							abortStream();
							return;
						}
						signal?.addEventListener("abort", abortStream, { once: true });
						return;
					}
					const message = createAssistantMessage("successor ok");
					stream.push({ type: "start", partial: message });
					stream.push({ type: "done", reason: "stop", message });
				});
				return stream;
			},
		});
		const sessionManager = SessionManager.inMemory();
		const authStorage = await AuthStorage.create(path.join(tempDir, "testauth-abort-immediate.db"));
		authStorages.push(authStorage);
		const modelRegistry = new ModelRegistry(authStorage, path.join(tempDir, "models.yml"));
		authStorage.setRuntimeApiKey("anthropic", "test-key");
		session = new AgentSession({ agent, sessionManager, settings: Settings.isolated(), modelRegistry });

		const firstPrompt = session.prompt("First message");
		await waitFor(() => session.agent.state.isStreaming);
		const aborting = session.abort();
		let promoted = 0;
		const successor = session.sendUserMessage("successor after abort", {
			queuedAtDispatch: true,
			onQueuedPromoted: () => {
				promoted += 1;
			},
		});
		await aborting;
		await waitFor(() => {
			const lastUser = [...agent.state.messages].reverse().find(message => message.role === "user");
			const content = lastUser?.content[0];
			return Boolean(
				content && typeof content === "object" && "text" in content && content.text === "successor after abort",
			);
		}, 3_000);
		expect(session.getQueuedMessages()).toEqual({ steering: [], followUp: [] });
		expect(promoted).toBe(1);
		await successor.catch(() => {});
		await firstPrompt.catch(() => {});
	}, 15_000);

	/**
	 * Session for abort-lifecycle ordering. The turn whose newest user message is
	 * `BLOCKING_PROMPT` streams until aborted; any other turn terminates on its
	 * own. Dispatch is keyed on message CONTENT rather than a call counter: the
	 * provider dispatch for the aborted turn races the abort itself, so a counter
	 * cannot reliably identify which turn a stream belongs to. `dispatched`
	 * therefore doubles as the exact list of turns that actually reached the
	 * provider, which is what "no successor started" has to assert.
	 * `successorOutcome` selects whether a successor turn completes or errors.
	 */
	const BLOCKING_PROMPT = "First message";
	async function createAbortLifecycleSession(
		dbName: string,
		successorOutcome: "complete" | "error" = "complete",
	): Promise<{
		agent: Agent;
		dispatched: () => string[];
		userTexts: () => string[];
	}> {
		const model = getBundledModel("anthropic", "claude-sonnet-4-5")!;
		const dispatched: string[] = [];
		const textOf = (message: Message | undefined): string =>
			message && Array.isArray(message.content)
				? message.content.map(part => (typeof part === "object" && part.type === "text" ? part.text : "")).join("")
				: "";
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model, systemPrompt: ["Test"], tools: [] },
			streamFn: (_model, context, options) => {
				const text = textOf([...(context?.messages ?? [])].reverse().find(message => message.role === "user"));
				dispatched.push(text);
				const signal = options?.signal;
				const stream = new AssistantMessageEventStream();
				queueMicrotask(() => {
					if (text === BLOCKING_PROMPT) {
						stream.push({ type: "start", partial: createAssistantMessage("") });
						const abortStream = () => {
							stream.push({ type: "error", reason: "aborted", error: createAssistantMessage("Aborted") });
						};
						if (signal?.aborted) abortStream();
						else signal?.addEventListener("abort", abortStream, { once: true });
						return;
					}
					const message = createAssistantMessage("successor ok");
					stream.push({ type: "start", partial: message });
					if (successorOutcome === "error") {
						stream.push({ type: "error", reason: "error", error: createAssistantMessage("successor failed") });
						return;
					}
					stream.push({ type: "done", reason: "stop", message });
				});
				return stream;
			},
		});
		const authStorage = await AuthStorage.create(path.join(tempDir, dbName));
		authStorages.push(authStorage);
		const modelRegistry = new ModelRegistry(authStorage, path.join(tempDir, "models.yml"));
		authStorage.setRuntimeApiKey("anthropic", "test-key");
		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings: Settings.isolated(),
			modelRegistry,
		});
		return {
			agent,
			dispatched: () => [...dispatched],
			userTexts: () => agent.state.messages.filter(message => message.role === "user").map(textOf),
		};
	}

	/**
	 * The #4753 overlapping-abort regression. Abort A installs the unwind, prompt P
	 * is admitted and parks on it, then abort B shares that same physical unwind.
	 * All three enter synchronously in one tick, so the interleaving is exact and
	 * does not depend on timers. Before the abort-admission fence, B acknowledged
	 * success and P then refreshed its generation and started a successor turn:
	 * the user aborted twice and work began anyway.
	 */
	it("a second abort fences a prompt retained by the first abort's unwind (#4753 overlapping abort)", async () => {
		const { dispatched, userTexts } = await createAbortLifecycleSession("testauth-overlap-abort.db");

		const firstPrompt = session.prompt(BLOCKING_PROMPT);
		await waitFor(() => session.agent.state.isStreaming);

		const abortA = session.abort({ cause: "user_interrupt" });
		const retained = session.sendUserMessage("retained prompt", { queuedAtDispatch: true });
		const abortB = session.abort({ cause: "user_interrupt" });

		// Both aborts acknowledge; abort stays terminal for the prompt between them.
		await abortA;
		await abortB;
		await expect(retained).rejects.toMatchObject({ name: "PromptPreflightCancelledError" });

		// No successor: the retained prompt never reached the provider and never
		// entered the transcript.
		await session.waitForIdle();
		await Bun.sleep(50);
		expect(dispatched()).not.toContain("retained prompt");
		expect(userTexts()).not.toContain("retained prompt");
		expect(session.getQueuedMessages()).toEqual({ steering: [], followUp: [] });
		expect(session.isStreaming).toBe(false);

		await firstPrompt.catch(() => {});
	}, 15_000);

	it("a retained prompt survives a single abort and is delivered exactly once (#4753)", async () => {
		const { dispatched, userTexts } = await createAbortLifecycleSession("testauth-retained-once.db");

		const firstPrompt = session.prompt(BLOCKING_PROMPT);
		await waitFor(() => session.agent.state.isStreaming);

		const aborting = session.abort({ cause: "user_interrupt" });
		let promoted = 0;
		const retained = session.sendUserMessage("retained prompt", {
			queuedAtDispatch: true,
			onQueuedPromoted: () => {
				promoted += 1;
			},
		});

		await aborting;
		await retained;
		await session.waitForIdle();
		await Bun.sleep(50);

		// Delivered once, as exactly one successor turn that reached the provider once.
		expect(userTexts().filter(text => text === "retained prompt")).toEqual(["retained prompt"]);
		expect(dispatched().filter(text => text === "retained prompt")).toEqual(["retained prompt"]);
		expect(promoted).toBe(1);
		expect(session.getQueuedMessages()).toEqual({ steering: [], followUp: [] });

		await firstPrompt.catch(() => {});
	}, 20_000);

	it("a queued SDK prompt after an aborted toolResult tail starts a fresh run", async () => {
		const model = getBundledModel("anthropic", "claude-sonnet-4-5")!;
		const toolStarted = Promise.withResolvers<void>();
		const secondProviderStarted = Promise.withResolvers<void>();
		const toolCall: ToolCall = {
			type: "toolCall",
			id: "call_abort_tail",
			name: "abort_tail_tool",
			arguments: {},
		};
		const tool: AgentTool = {
			name: "abort_tail_tool",
			label: "Abort tail tool",
			description: "Creates a toolResult tail before the turn is aborted.",
			parameters: z.object({}),
			execute: async () => {
				toolStarted.resolve();
				return { content: [{ type: "text" as const, text: "tool result" }] };
			},
		};
		let streamCalls = 0;
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model, systemPrompt: ["Test"], tools: [tool] },
			streamFn: (_model, _context, options) => {
				streamCalls += 1;
				const stream = new AssistantMessageEventStream();
				queueMicrotask(() => {
					if (streamCalls === 1) {
						const partial: AssistantMessage = {
							role: "assistant",
							content: [toolCall],
							api: "anthropic-messages",
							provider: "anthropic",
							model: "mock",
							usage: {
								input: 0,
								output: 0,
								cacheRead: 0,
								cacheWrite: 0,
								totalTokens: 0,
								cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
							},
							stopReason: "toolUse",
							timestamp: Date.now(),
						};
						stream.push({ type: "start", partial });
						stream.push({ type: "toolcall_start", contentIndex: 0, partial });
						stream.push({ type: "toolcall_end", contentIndex: 0, toolCall, partial });
						stream.push({ type: "done", reason: "toolUse", message: partial });
						return;
					}
					if (streamCalls === 2) {
						secondProviderStarted.resolve();
						options?.signal?.addEventListener(
							"abort",
							() => stream.push({ type: "error", reason: "aborted", error: createAssistantMessage("Aborted") }),
							{ once: true },
						);
						return;
					}
					const successor = createAssistantMessage("successor complete");
					stream.push({ type: "start", partial: successor });
					stream.push({ type: "done", reason: "stop", message: successor });
				});
				return stream;
			},
		});
		const authStorage = await AuthStorage.create(path.join(tempDir, "testauth-abort-tool-tail.db"));
		authStorages.push(authStorage);
		const modelRegistry = new ModelRegistry(authStorage, path.join(tempDir, "models.yml"));
		authStorage.setRuntimeApiKey("anthropic", "test-key");
		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings: Settings.isolated(),
			modelRegistry,
		});

		const firstPrompt = session.prompt("First message");
		await toolStarted.promise;
		await secondProviderStarted.promise;
		expect(agent.state.messages.at(-1)?.role).toBe("toolResult");

		const aborting = session.abort({ cause: "user_interrupt" });
		let promoted = 0;
		const successor = session.sendUserMessage("queued after tool abort", {
			queuedAtDispatch: true,
			onQueuedPromoted: () => {
				promoted += 1;
			},
		});
		await aborting;
		await successor;
		await session.waitForIdle();
		await firstPrompt.catch(() => {});

		expect(streamCalls).toBe(3);
		expect(
			agent.state.messages.filter(
				message =>
					message.role === "user" &&
					Array.isArray(message.content) &&
					message.content.some(
						content =>
							typeof content === "object" &&
							content.type === "text" &&
							content.text === "queued after tool abort",
					),
			),
		).toHaveLength(1);
		expect(promoted).toBe(1);
		expect(session.getQueuedMessages()).toEqual({ steering: [], followUp: [] });
	}, 20_000);

	it("queued steering is still resumed after an abort unwind (#4753)", async () => {
		const { userTexts } = await createAbortLifecycleSession("testauth-abort-steering.db");

		const firstPrompt = session.prompt(BLOCKING_PROMPT);
		await waitFor(() => session.agent.state.isStreaming);

		// Explicit steering is delivered into the aborted turn's queue, then the
		// abort's user_interrupt resume path promotes it to its own turn.
		await session.sendUserMessage("queued steer", { deliverAs: "steer" });
		await session.abort({ cause: "user_interrupt" });
		await firstPrompt.catch(() => {});
		await waitFor(() => userTexts().includes("queued steer"), 5_000);
		await session.waitForIdle();

		expect(userTexts().filter(text => text === "queued steer")).toEqual(["queued steer"]);
		expect(session.getQueuedMessages()).toEqual({ steering: [], followUp: [] });
	}, 20_000);

	it("rapid repeated aborts all settle and leave the session idle (#4753)", async () => {
		const { dispatched } = await createAbortLifecycleSession("testauth-rapid-abort.db");

		const firstPrompt = session.prompt(BLOCKING_PROMPT);
		await waitFor(() => session.agent.state.isStreaming);

		// Four same-tick aborts share one physical unwind; each must still settle.
		const aborts = [
			session.abort({ cause: "user_interrupt" }),
			session.abort({ cause: "user_interrupt" }),
			session.abort({ cause: "user_interrupt" }),
			session.abort({ cause: "user_interrupt" }),
		];
		for (const settled of await Promise.allSettled(aborts)) expect(settled.status).toBe("fulfilled");
		// A later abort, after the shared unwind completed, is still terminal.
		await session.abort({ cause: "user_interrupt" });

		await session.waitForIdle();
		expect(session.isStreaming).toBe(false);
		// No turn other than the aborted one ever reached the provider.
		expect(dispatched().filter(text => text !== BLOCKING_PROMPT)).toEqual([]);
		expect(session.getQueuedMessages()).toEqual({ steering: [], followUp: [] });

		await firstPrompt.catch(() => {});
	}, 15_000);

	it("a prompt admitted after the abort settled runs to execution completion (#4753)", async () => {
		const { dispatched, userTexts } = await createAbortLifecycleSession("testauth-post-abort.db");

		const firstPrompt = session.prompt(BLOCKING_PROMPT);
		await waitFor(() => session.agent.state.isStreaming);
		await session.abort({ cause: "user_interrupt" });
		await firstPrompt.catch(() => {});

		// The fence is terminal only for prompts admitted BEFORE an abort; a prompt
		// admitted after it settled runs a normal turn to completion.
		await session.sendUserMessage("after abort settled");
		await session.waitForIdle();

		expect(userTexts()).toContain("after abort settled");
		expect(dispatched().filter(text => text !== BLOCKING_PROMPT)).toEqual(["after abort settled"]);
		expect(session.isStreaming).toBe(false);
	}, 15_000);

	it("a successor turn that errors leaves the session idle and abortable (#4753)", async () => {
		const { dispatched, userTexts } = await createAbortLifecycleSession("testauth-successor-error.db", "error");

		const firstPrompt = session.prompt(BLOCKING_PROMPT);
		await waitFor(() => session.agent.state.isStreaming);
		await session.abort({ cause: "user_interrupt" });
		await firstPrompt.catch(() => {});

		// The successor is admitted and started, then its execution fails.
		await session.sendUserMessage("failing successor").catch(() => {});
		await session.waitForIdle();

		expect(userTexts()).toContain("failing successor");
		expect(dispatched().filter(text => text !== BLOCKING_PROMPT)).toEqual(["failing successor"]);
		expect(session.isStreaming).toBe(false);
		// An execution error is not an abort: a later abort still settles cleanly.
		await session.abort({ cause: "user_interrupt" });
		expect(session.getQueuedMessages()).toEqual({ steering: [], followUp: [] });
	}, 15_000);

	it("sendUserMessage rejects absent content with a typed invalid_input error without crashing", async () => {
		await createSession();

		// undefined content (the exact #4393 crash vector: previously a TypeError)
		await expect(session.sendUserMessage(undefined as never)).rejects.toMatchObject({
			code: "invalid_input",
		});

		// null content (typeof null === "object", also entered the iterable branch)
		await expect(session.sendUserMessage(null as never)).rejects.toMatchObject({
			code: "invalid_input",
		});

		// The session is still usable after the rejected submissions.
		expect(session.isStreaming).toBe(false);
		expect(session.queuedMessageCount).toBe(0);
	});

	it("sendUserMessage rejects absent content even while streaming (active-turn steering race)", async () => {
		await createSession();

		// Start a turn that blocks until abort.
		const firstPrompt = session.prompt("First message");
		await waitFor(() => session.agent.state.isStreaming);

		// The exact crash path: SDK steering during an active turn with absent content.
		// Previously this threw TypeError synchronously inside the promise, crashing the
		// resident process. It must now reject as a typed nonfatal control error.
		await expect(session.sendUserMessage(undefined as never, { deliverAs: "steer" })).rejects.toMatchObject({
			code: "invalid_input",
		});
		await expect(session.sendUserMessage(null as never, { deliverAs: "followUp" })).rejects.toMatchObject({
			code: "invalid_input",
		});

		// No crash, no queue pollution: session continuity preserved.
		expect(session.isStreaming).toBe(true);
		expect(session.queuedMessageCount).toBe(0);

		// Cleanup
		await session.abort();
		await firstPrompt.catch(() => {});
	});

	it("delivers hidden nextTurn stop reactions through the next LLM call without exposing them in the visible queue", async () => {
		const model = getBundledModel("anthropic", "claude-sonnet-4-5")!;
		const firstTurn = Promise.withResolvers<void>();
		const callMessages: Message[][] = [];

		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: {
				model,
				systemPrompt: ["Test"],
				tools: [],
			},
			convertToLlm,
			streamFn: (_model, context) => {
				callMessages.push([...context.messages]);
				const callIndex = callMessages.length;
				const stream = new AssistantMessageEventStream();
				queueMicrotask(() => {
					void (async () => {
						stream.push({ type: "start", partial: createAssistantMessage("") });
						if (callIndex === 1) await firstTurn.promise;
						stream.push({
							type: "done",
							reason: "stop",
							message: createAssistantMessage(callIndex === 1 ? "Done" : "Resumed"),
						});
					})();
				});
				return stream;
			},
		});

		const sessionManager = SessionManager.inMemory();
		const settings = Settings.isolated();
		const authStorage = await AuthStorage.create(path.join(tempDir, "testauth.db"));
		authStorages.push(authStorage);
		const modelRegistry = new ModelRegistry(authStorage, path.join(tempDir, "models.yml"));
		authStorage.setRuntimeApiKey("anthropic", "test-key");

		session = new AgentSession({
			agent,
			sessionManager,
			settings,
			modelRegistry,
		});

		const firstPrompt = session.prompt("First message");
		await waitFor(() => session.isStreaming && callMessages.length === 1);

		const hiddenTurn = session.sendCustomMessage(
			{
				customType: "autoresearch-resume",
				content: "Hidden stop reaction",
				display: false,
				attribution: "agent",
			},
			{ deliverAs: "nextTurn", triggerTurn: true },
		);

		expect(session.queuedMessageCount).toBe(0);
		expect(session.getQueuedMessages()).toEqual({ steering: [], followUp: [] });

		firstTurn.resolve();
		await hiddenTurn;
		await firstPrompt;
		await session.waitForIdle();

		expect(callMessages).toHaveLength(2);
		expect(
			callMessages[1]?.some(message => {
				if (typeof message.content === "string") {
					return message.content.includes("Hidden stop reaction");
				}

				return message.content.some(
					content => content.type === "text" && content.text.includes("Hidden stop reaction"),
				);
			}),
		).toBe(true);
	});

	it("excludes undrained hidden nextTurn context from the drainable queue count after the turn settles", async () => {
		// The busy-recovery UI gate (#4741) must see only queues its restore/clear
		// handlers can return. A hidden nextTurn entry queued without triggerTurn
		// deliberately survives turn completion, so the aggregate count stays
		// nonzero forever; the drainable count must not, or every Esc/Ctrl+C would
		// perform a no-op abort and lock the user out of their own input.
		const model = getBundledModel("anthropic", "claude-sonnet-4-5")!;
		const firstTurn = Promise.withResolvers<void>();
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model, systemPrompt: ["Test"], tools: [] },
			streamFn: () => {
				const stream = new AssistantMessageEventStream();
				queueMicrotask(() => {
					void (async () => {
						stream.push({ type: "start", partial: createAssistantMessage("") });
						await firstTurn.promise;
						stream.push({ type: "done", reason: "stop", message: createAssistantMessage("Done") });
					})();
				});
				return stream;
			},
		});

		const authStorage = await AuthStorage.create(path.join(tempDir, "testauth-drainable.db"));
		authStorages.push(authStorage);
		authStorage.setRuntimeApiKey("anthropic", "test-key");
		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings: Settings.isolated(),
			modelRegistry: new ModelRegistry(authStorage, path.join(tempDir, "models.yml")),
		});

		const firstPrompt = session.prompt("First message");
		await waitFor(() => session.agent.state.isStreaming);

		// Mirrors the todo_write failure reminder: hidden, agent-attributed, and
		// explicitly not triggering a turn of its own.
		session.sendCustomMessage(
			{
				customType: "todo-write-failure",
				content: "Hidden todo reminder",
				display: false,
				attribution: "agent",
			},
			{ deliverAs: "nextTurn", triggerTurn: false },
		);

		firstTurn.resolve();
		await firstPrompt;
		await session.waitForIdle();

		// The turn settled and the hidden entry was never delivered or drained.
		expect(session.isStreaming).toBe(false);
		expect(session.pendingMessageCounts).toEqual({ steering: 0, followUp: 0, nextTurn: 1 });
		expect(session.queuedMessageCount).toBe(1);
		// What the recovery gate reads: nothing a key press could drain.
		expect(session.drainableQueuedMessageCount).toBe(0);
		// And the drain handlers confirm it: they return nothing and leave it in place.
		expect(session.getQueuedMessageEntries()).toEqual([]);
		expect(session.popLastQueuedMessage()).toBeUndefined();
		expect(session.clearQueue()).toEqual({ steering: [], followUp: [] });
		expect(session.pendingMessageCounts.nextTurn).toBe(1);
		expect(session.getPendingNextTurnMessagesForTests()).toHaveLength(1);
	});

	it("counts steering and follow-up entries as drainable while hidden context coexists", async () => {
		await createSession();

		const firstPrompt = session.prompt("First message");
		await waitFor(() => session.agent.state.isStreaming);

		session.sendCustomMessage(
			{
				customType: "todo-write-failure",
				content: "Hidden todo reminder",
				display: false,
				attribution: "agent",
			},
			{ deliverAs: "nextTurn", triggerTurn: false },
		);
		session.steer("visible steer");
		session.followUp("visible follow-up");

		expect(session.pendingMessageCounts).toEqual({ steering: 1, followUp: 1, nextTurn: 1 });
		expect(session.queuedMessageCount).toBe(3);
		// Both visible queues are drainable; the hidden one is not.
		expect(session.drainableQueuedMessageCount).toBe(2);

		// Draining returns exactly the drainable entries and preserves hidden order.
		expect(session.clearQueue()).toEqual({ steering: ["visible steer"], followUp: ["visible follow-up"] });
		expect(session.drainableQueuedMessageCount).toBe(0);
		expect(session.pendingMessageCounts.nextTurn).toBe(1);

		session.abort();
		await firstPrompt.catch(() => {});
	});

	it("should allow prompt() after previous completes", async () => {
		// Create session with a stream that completes immediately
		const model = getBundledModel("anthropic", "claude-sonnet-4-5")!;
		const mock = createMockModel({ handler: () => ({ content: ["Done"] }) });
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: {
				model,
				systemPrompt: ["Test"],
				tools: [],
			},
			streamFn: mock.stream,
		});

		const sessionManager = SessionManager.inMemory();
		const settings = Settings.isolated();
		const authStorage = await AuthStorage.create(path.join(tempDir, "testauth.db"));
		authStorages.push(authStorage);
		const modelRegistry = new ModelRegistry(authStorage, path.join(tempDir, "models.yml"));
		authStorage.setRuntimeApiKey("anthropic", "test-key");

		session = new AgentSession({
			agent,
			sessionManager,
			settings,
			modelRegistry,
		});

		// First prompt completes
		await session.prompt("First message");

		// Should not be streaming anymore
		expect(session.isStreaming).toBe(false);

		// Second prompt should work
		await expect(session.prompt("Second message")).resolves.toBeUndefined();
	});
	it("queues extension follow-up user messages on an idle session without starting a turn", async () => {
		const model = getBundledModel("anthropic", "claude-sonnet-4-5")!;
		const mock = createMockModel({ handler: () => ({ content: ["Done"] }) });
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: {
				model,
				systemPrompt: ["Test"],
				tools: [],
			},
			streamFn: mock.stream,
		});

		const sessionManager = SessionManager.inMemory();
		const settings = Settings.isolated();
		const authStorage = await AuthStorage.create(path.join(tempDir, "testauth-idle-followup.db"));
		authStorages.push(authStorage);
		const modelRegistry = new ModelRegistry(authStorage, path.join(tempDir, "models-idle-followup.yml"));
		authStorage.setRuntimeApiKey("anthropic", "test-key");

		session = new AgentSession({
			agent,
			sessionManager,
			settings,
			modelRegistry,
		});

		await session.sendUserMessage("hello from session_start", { deliverAs: "followUp" });

		expect(mock.calls).toHaveLength(0);
		expect(session.queuedMessageCount).toBe(1);
	});

	it("keeps session_switch hook-queued steering deliverable after clearing pre-switch queues", async () => {
		const model = getBundledModel("anthropic", "claude-sonnet-4-5")!;
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model, systemPrompt: ["Test"], tools: [] },
			appendOnlyContext: createAppendOnlyContextManager(model.provider),
		});
		const currentSessionManager = SessionManager.create(tempDir, tempDir);
		const targetSessionManager = SessionManager.create(tempDir, tempDir);
		targetSessionManager.appendMessage({ role: "user", content: "target session", timestamp: Date.now() });
		await targetSessionManager.flush();
		const targetSessionFile = targetSessionManager.getSessionFile();
		await targetSessionManager.close();
		if (!targetSessionFile) throw new Error("Expected target session file");

		const settings = Settings.isolated();
		const authStorage = await AuthStorage.create(path.join(tempDir, "testauth-switch-hook.db"));
		authStorages.push(authStorage);
		authStorage.setRuntimeApiKey("anthropic", "test-key");
		const modelRegistry = new ModelRegistry(authStorage, path.join(tempDir, "models-switch-hook.yml"));
		const extensionRunner = {
			hasHandlers: vi.fn(() => false),
			emit: vi.fn(async (event: { type: string }) => {
				if (event.type === "session_switch") {
					await session.sendUserMessage("queued by switch hook", { deliverAs: "steer" });
				}
			}),
		} as unknown as ExtensionRunner;

		session = new AgentSession({
			agent,
			sessionManager: currentSessionManager,
			settings,
			modelRegistry,
			extensionRunner,
		});
		const appendOnly = agent.appendOnlyContext;
		expect(appendOnly).not.toBeUndefined();
		appendOnly?.syncMessages([{ role: "user", content: "switch-provider-marker" }]);
		expect(appendOnly?.log.length).toBe(1);
		// Idle session: a steer has no live run to be admitted into, so the
		// session routes it as a follow-up owned by the next turn.
		await session.steer("pre-switch steering");
		expect(session.getQueuedMessages().followUp).toEqual(["pre-switch steering"]);
		expect(agent.snapshotFollowUp()).toHaveLength(1);

		expect(await session.switchSession(targetSessionFile)).toBe(true);
		expect(appendOnly?.log.length).toBe(0);

		expect(session.getQueuedMessages().followUp).toEqual(["queued by switch hook"]);
		expect(agent.snapshotFollowUp()).toHaveLength(1);
	});

	// Regression: a subscriber that fires the next prompt synchronously from the
	// agent_end listener (the shape every wire transport ends up in — rpc-mode
	// stdout subscriber, ACP bridge, Cursor exec) must not collide with the
	// outgoing turn's still-unwinding in-flight bookkeeping. Before the wire-level
	// agent_end was deferred until #promptInFlightCount drops to 0, the
	// subscriber observed agent_end while Session.isStreaming was still true (the
	// agent's own `isStreaming` had flipped, but #promptWithMessage's finally had
	// not yet decremented the prompt-in-flight counter), and the next prompt
	// threw AgentBusyError. Wire clients then received an error that the agent was
	// already processing.
	it("subscriber may prompt() synchronously from agent_end without AgentBusyError", async () => {
		const model = getBundledModel("anthropic", "claude-sonnet-4-5")!;
		const mock = createMockModel({ handler: () => ({ content: ["Done"] }) });
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model, systemPrompt: ["Test"], tools: [] },
			streamFn: mock.stream,
		});

		const sessionManager = SessionManager.inMemory();
		const settings = Settings.isolated();
		const authStorage = await AuthStorage.create(path.join(tempDir, "testauth.db"));
		authStorages.push(authStorage);
		const modelRegistry = new ModelRegistry(authStorage, path.join(tempDir, "models.yml"));
		authStorage.setRuntimeApiKey("anthropic", "test-key");

		session = new AgentSession({ agent, sessionManager, settings, modelRegistry });

		const observedIsStreamingAtAgentEnd: boolean[] = [];
		const reentrantPromptResults: Array<"resolved" | { error: string }> = [];
		let reentrantPrompted = false;

		session.subscribe(event => {
			if (event.type !== "agent_end") return;
			observedIsStreamingAtAgentEnd.push(session.isStreaming);
			if (reentrantPrompted) return;
			reentrantPrompted = true;
			void session
				.prompt("Second message")
				.then(() => reentrantPromptResults.push("resolved"))
				.catch((err: Error) => reentrantPromptResults.push({ error: err.message }));
		});

		await session.prompt("First message");
		await waitFor(() => reentrantPromptResults.length > 0, 2000);
		await session.waitForIdle();

		expect(observedIsStreamingAtAgentEnd).not.toContain(true);
		expect(reentrantPromptResults).toEqual(["resolved"]);
	});

	it("queues idle ACP client-triggered custom messages instead of starting an ownerless turn", async () => {
		const model = getBundledModel("anthropic", "claude-sonnet-4-5")!;
		const mock = createMockModel({ handler: () => ({ content: ["Done"] }) });
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: {
				model,
				systemPrompt: ["Test"],
				tools: [],
			},
			convertToLlm,
			streamFn: mock.stream,
		});

		const sessionManager = SessionManager.inMemory();
		const settings = Settings.isolated();
		const authStorage = await AuthStorage.create(path.join(tempDir, "testauth-acp-idle.db"));
		authStorages.push(authStorage);
		const modelRegistry = new ModelRegistry(authStorage, path.join(tempDir, "models-acp-idle.yml"));
		authStorage.setRuntimeApiKey("anthropic", "test-key");

		session = new AgentSession({
			agent,
			sessionManager,
			settings,
			modelRegistry,
		});
		session.setClientBridge({
			capabilities: {},
			deferAgentInitiatedTurns: true,
		});

		await session.prompt("First message");
		expect(session.isStreaming).toBe(false);
		const callsAfterFirstPrompt = mock.calls.length;

		await session.sendCustomMessage(
			{
				customType: "async-result",
				content: "Background result",
				display: true,
				attribution: "agent",
			},
			{ deliverAs: "followUp", triggerTurn: true },
		);

		expect(mock.calls).toHaveLength(callsAfterFirstPrompt);
		expect(session.isStreaming).toBe(false);

		await session.prompt("Next user prompt");
		await session.dispose();
		session = undefined as unknown as AgentSession;
		expect(mock.calls).toHaveLength(callsAfterFirstPrompt + 1);
		expect(
			mock.calls.at(-1)?.context.messages.some(message => {
				if (typeof message.content === "string") {
					return message.content.includes("Background result");
				}

				return message.content.some(
					content => content.type === "text" && content.text.includes("Background result"),
				);
			}),
		).toBe(true);
	});

	it("runs drained ACP async completions as owned follow-up turns despite deferred client turns", async () => {
		const model = getBundledModel("anthropic", "claude-sonnet-4-5")!;
		const mock = createMockModel({ handler: () => ({ content: ["Done"] }) });
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: {
				model,
				systemPrompt: ["Test"],
				tools: [],
			},
			convertToLlm,
			streamFn: mock.stream,
		});

		const sessionManager = SessionManager.inMemory();
		const settings = Settings.isolated();
		const authStorage = await AuthStorage.create(path.join(tempDir, "testauth-acp-async.db"));
		authStorages.push(authStorage);
		const modelRegistry = new ModelRegistry(authStorage, path.join(tempDir, "models-acp-async.yml"));
		authStorage.setRuntimeApiKey("anthropic", "test-key");

		const ownerId = "acp-session-a";
		const deliveryGate = Promise.withResolvers<void>();
		let deliveryStarted = false;
		const asyncJobManager = new AsyncJobManager({
			maxRunningJobs: 2,
			retentionMs: 1_000,
			onJobComplete: async () => {
				deliveryStarted = true;
				await deliveryGate.promise;
				await session.sendCustomMessage(
					{
						customType: "async-result",
						content: "Background result",
						display: true,
						attribution: "agent",
					},
					{ deliverAs: "followUp", triggerTurn: true },
				);
			},
		});
		AsyncJobManager.setInstance(asyncJobManager);

		session = new AgentSession({
			agent,
			sessionManager,
			settings,
			modelRegistry,
			agentId: ownerId,
			ownedAsyncJobManager: asyncJobManager,
		});
		session.setClientBridge({
			capabilities: {},
			deferAgentInitiatedTurns: true,
		});

		await session.prompt("First message");
		expect(session.isStreaming).toBe(false);
		const callsAfterFirstPrompt = mock.calls.length;

		try {
			asyncJobManager.register("bash", "owned job", async () => "Background result", {
				id: "owned-job",
				ownerId,
			});
			await waitFor(() => deliveryStarted);

			const drainedPromise = session.drainAsyncJobDeliveriesForAcp({ timeoutMs: 1_000 });
			await waitFor(() => asyncJobManager.getDeliveryState({ ownerId }).delivering);
			deliveryGate.resolve();

			await expect(drainedPromise).resolves.toBe(true);
			await session.waitForIdle();

			expect(mock.calls).toHaveLength(callsAfterFirstPrompt + 1);
			expect(
				mock.calls.at(-1)?.context.messages.some(message => {
					if (typeof message.content === "string") {
						return message.content.includes("Background result");
					}

					return message.content.some(
						content => content.type === "text" && content.text.includes("Background result"),
					);
				}),
			).toBe(true);
		} finally {
			deliveryGate.resolve();
		}
	});

	it("scopes ACP async job snapshots and drains to the owning session id", async () => {
		const model = getBundledModel("anthropic", "claude-sonnet-4-5")!;
		const authStorage = await AuthStorage.create(path.join(tempDir, "testauth-acp-scope.db"));
		authStorages.push(authStorage);
		const modelRegistry = new ModelRegistry(authStorage, path.join(tempDir, "models-acp-scope.yml"));
		authStorage.setRuntimeApiKey("anthropic", "test-key");
		const settings = Settings.isolated();
		const deliveryGate = Promise.withResolvers<void>();
		const delivered: string[] = [];
		const started = new Set<string>();
		const asyncJobManager = new AsyncJobManager({
			maxRunningJobs: 3,
			retentionMs: 1_000,
			onJobComplete: async jobId => {
				started.add(jobId);
				if (jobId === "job-a") {
					await deliveryGate.promise;
				}
				delivered.push(jobId);
			},
		});
		AsyncJobManager.setInstance(asyncJobManager);

		const agentA = new Agent({
			getApiKey: () => "test-key",
			initialState: { model, systemPrompt: ["Test"], tools: [] },
			streamFn: createMockModel({ handler: () => ({ content: ["Done"] }) }).stream,
		});
		const agentB = new Agent({
			getApiKey: () => "test-key",
			initialState: { model, systemPrompt: ["Test"], tools: [] },
			streamFn: createMockModel({ handler: () => ({ content: ["Done"] }) }).stream,
		});
		const sessionB = new AgentSession({
			agent: agentB,
			sessionManager: SessionManager.inMemory(),
			settings,
			modelRegistry,
			agentId: "acp-session-b",
		});
		session = new AgentSession({
			agent: agentA,
			sessionManager: SessionManager.inMemory(),
			settings,
			modelRegistry,
			agentId: "acp-session-a",
			ownedAsyncJobManager: asyncJobManager,
		});

		try {
			asyncJobManager.register("bash", "A", async () => "A", { id: "job-a", ownerId: "acp-session-a" });
			await waitFor(() => started.has("job-a"));
			asyncJobManager.register("bash", "B", async () => "B", { id: "job-b", ownerId: "acp-session-b" });
			await waitFor(() => asyncJobManager.getDeliveryState({ ownerId: "acp-session-b" }).queued > 0);

			expect(sessionB.getAsyncJobSnapshot()?.delivery.pendingJobIds).not.toContain("job-a");
			await expect(sessionB.drainAsyncJobDeliveriesForAcp({ timeoutMs: 1_000 })).resolves.toBe(true);
			expect(delivered).toEqual(["job-b"]);
		} finally {
			deliveryGate.resolve();
			await sessionB.dispose();
		}
	});
});

describe("AgentSession TTSR resume gate", () => {
	let session: AgentSession;
	let tempDir: string;
	const authStorages: AuthStorage[] = [];

	beforeEach(() => {
		tempDir = path.join(os.tmpdir(), `pi-ttsr-gate-test-${Snowflake.next()}`);
		fs.mkdirSync(tempDir, { recursive: true });
	});

	afterEach(async () => {
		if (session) {
			await session.dispose();
		}
		for (const authStorage of authStorages.splice(0)) {
			authStorage.close();
		}
		if (tempDir && fs.existsSync(tempDir)) {
			fs.rmSync(tempDir, { recursive: true });
		}
	});

	async function waitFor(predicate: () => boolean, timeoutMs = 500): Promise<void> {
		const deadline = Date.now() + timeoutMs;
		while (Date.now() < deadline) {
			if (predicate()) return;
			await Bun.sleep(10);
		}

		throw new Error("Timed out waiting for condition");
	}
	const testRule: Rule = {
		name: "no-unwrap",
		path: "/tmp/no-unwrap.md",
		content: "Do not use .unwrap()",
		condition: ["\\.unwrap\\("],
		_source: { provider: "test", providerName: "test", path: "/tmp/no-unwrap.md", level: "project" },
	};

	function makeMsg(text: string, stopReason: "stop" | "aborted" = "stop"): AssistantMessage {
		return {
			role: "assistant",
			content: [{ type: "text", text }],
			api: "anthropic-messages",
			provider: "anthropic",
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

	function pushContinuationStream(stream: AssistantMessageEventStream, onComplete: () => void): void {
		queueMicrotask(() => {
			const partial = makeMsg("");
			stream.push({ type: "start", partial });
			onComplete();
			stream.push({
				type: "done",
				reason: "stop",
				message: makeMsg('Fixed: let val = result.expect("msg")'),
			});
		});
	}

	function pushAbortableTtsrStream(stream: AssistantMessageEventStream, signal: AbortSignal | undefined): void {
		queueMicrotask(() => {
			const partial = makeMsg("");
			stream.push({ type: "start", partial });
			stream.push({
				type: "text_delta",
				contentIndex: 0,
				delta: "let val = result.unwrap(",
				partial: makeMsg("let val = result.unwrap("),
			});
			if (signal) {
				signal.addEventListener(
					"abort",
					() => {
						stream.push({
							type: "error",
							reason: "aborted",
							error: makeMsg("let val = result.unwrap(", "aborted"),
						});
					},
					{ once: true },
				);
			}
		});
	}

	it("prompt() blocks until TTSR interrupt continuation completes", async () => {
		const model = getBundledModel("anthropic", "claude-sonnet-4-5")!;
		let streamCallCount = 0;
		let continuationCompleted = false;

		const ttsrManager = new TtsrManager({
			enabled: true,
			contextMode: "discard",
			interruptMode: "always",
			repeatMode: "once",
			repeatGap: 10,
		});
		ttsrManager.addRule(testRule);

		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model, systemPrompt: ["Test"], tools: [] },
			streamFn: (_model, _context, options) => {
				streamCallCount++;
				const stream = new AssistantMessageEventStream();
				const signal = options?.signal;

				if (streamCallCount === 1) {
					// First stream: emit text that triggers TTSR, then respond to abort
					pushAbortableTtsrStream(stream, signal);
				} else {
					// Continuation stream: complete normally after a delay
					pushContinuationStream(stream, () => {
						continuationCompleted = true;
					});
				}

				return stream;
			},
		});

		const sessionManager = SessionManager.inMemory(tempDir);
		const settings = Settings.isolated();
		const authStorage = await AuthStorage.create(path.join(tempDir, "testauth-int.db"));
		authStorages.push(authStorage);
		const modelRegistry = new ModelRegistry(authStorage, path.join(tempDir, "models.yml"));
		authStorage.setRuntimeApiKey("anthropic", "test-key");

		session = new AgentSession({
			agent,
			sessionManager,
			settings,
			modelRegistry,
			ttsrManager,
		});

		// prompt() must block until the TTSR continuation completes
		await session.prompt("Write some Rust code");

		// By the time prompt() returns, the continuation must have finished
		expect(continuationCompleted).toBe(true);
		expect(streamCallCount).toBeGreaterThanOrEqual(2);
		expect(session.isStreaming).toBe(false);
	});

	it("prompt() blocks until TTSR deferred continuation completes", async () => {
		const model = getBundledModel("anthropic", "claude-sonnet-4-5")!;
		let streamCallCount = 0;
		let continuationCompleted = false;

		// interruptMode: "never" -> TTSR match queues deferred injection instead of aborting
		const ttsrManager = new TtsrManager({
			enabled: true,
			contextMode: "discard",
			interruptMode: "never",
			repeatMode: "once",
			repeatGap: 10,
		});
		ttsrManager.addRule(testRule);

		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model, systemPrompt: ["Test"], tools: [] },
			streamFn: (_model, _context, _options) => {
				streamCallCount++;
				const stream = new AssistantMessageEventStream();

				if (streamCallCount === 1) {
					// First stream: emit matching text and complete normally
					queueMicrotask(() => {
						const partial = makeMsg("");
						stream.push({ type: "start", partial });
						stream.push({
							type: "text_delta",
							contentIndex: 0,
							delta: "let val = result.unwrap(",
							partial: makeMsg("let val = result.unwrap("),
						});
						// Complete normally (no abort) -- deferred path
						stream.push({
							type: "done",
							reason: "stop",
							message: makeMsg("let val = result.unwrap()"),
						});
					});
				} else {
					// Continuation stream after deferred TTSR injection
					pushContinuationStream(stream, () => {
						continuationCompleted = true;
					});
				}

				return stream;
			},
		});

		const sessionManager = SessionManager.inMemory(tempDir);
		const settings = Settings.isolated();
		const authStorage = await AuthStorage.create(path.join(tempDir, "testauth-def.db"));
		authStorages.push(authStorage);
		const modelRegistry = new ModelRegistry(authStorage, path.join(tempDir, "models.yml"));
		authStorage.setRuntimeApiKey("anthropic", "test-key");

		session = new AgentSession({
			agent,
			sessionManager,
			settings,
			modelRegistry,
			ttsrManager,
		});

		// prompt() must block until the deferred TTSR continuation completes
		await session.prompt("Write some Rust code");

		// By the time prompt() returns, the deferred continuation must have finished
		expect(continuationCompleted).toBe(true);
		expect(streamCallCount).toBeGreaterThanOrEqual(2);
		expect(session.isStreaming).toBe(false);
	});

	it("prompt() returns immediately when session is aborted during TTSR wait", async () => {
		const model = getBundledModel("anthropic", "claude-sonnet-4-5")!;

		const ttsrManager = new TtsrManager({
			enabled: true,
			contextMode: "discard",
			interruptMode: "always",
			repeatMode: "once",
			repeatGap: 10,
		});
		ttsrManager.addRule(testRule);

		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model, systemPrompt: ["Test"], tools: [] },
			streamFn: (_model, _context, options) => {
				const stream = new AssistantMessageEventStream();
				const signal = options?.signal;

				queueMicrotask(() => {
					const partial = makeMsg("");
					stream.push({ type: "start", partial });
					stream.push({
						type: "text_delta",
						contentIndex: 0,
						delta: "result.unwrap(",
						partial: makeMsg("result.unwrap("),
					});
					if (signal) {
						signal.addEventListener(
							"abort",
							() => {
								stream.push({
									type: "error",
									reason: "aborted",
									error: makeMsg("result.unwrap(", "aborted"),
								});
							},
							{ once: true },
						);
					}
				});

				return stream;
			},
		});

		const sessionManager = SessionManager.inMemory(tempDir);
		const settings = Settings.isolated();
		const authStorage = await AuthStorage.create(path.join(tempDir, "testauth-abt.db"));
		authStorages.push(authStorage);
		const modelRegistry = new ModelRegistry(authStorage, path.join(tempDir, "models.yml"));
		authStorage.setRuntimeApiKey("anthropic", "test-key");

		session = new AgentSession({
			agent,
			sessionManager,
			settings,
			modelRegistry,
			ttsrManager,
		});

		// Start prompt (will trigger TTSR and create resume gate)
		const promptPromise = session.prompt("Write some Rust code");
		await waitFor(() => session.agent.state.isStreaming);

		// Abort session — prompt() should unblock
		await session.abort();
		await promptPromise;

		expect(session.isStreaming).toBe(false);
	});

	it("prompt() waits for TTSR continuation with tool calls to finish", async () => {
		const model = getBundledModel("anthropic", "claude-sonnet-4-5")!;
		let streamCallCount = 0;
		let toolExecutionFinished = false;
		let allTurnsCompleted = false;

		const ttsrManager = new TtsrManager({
			enabled: true,
			contextMode: "discard",
			interruptMode: "always",
			repeatMode: "once",
			repeatGap: 10,
		});
		ttsrManager.addRule(testRule);

		const mockTool: AgentTool = {
			name: "mock_edit",
			label: "Mock Edit",
			description: "A mock edit tool",
			parameters: z.object({}),
			execute: async () => {
				toolExecutionFinished = true;
				return { content: [{ type: "text" as const, text: "edit applied" }] };
			},
		};

		const toolCallContent: ToolCall = {
			type: "toolCall",
			id: "call_test_001",
			name: "mock_edit",
			arguments: {},
		};

		function makeToolCallMsg(): AssistantMessage {
			return {
				role: "assistant",
				content: [toolCallContent],
				api: "anthropic-messages",
				provider: "anthropic",
				model: "mock",
				usage: {
					input: 0,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 0,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
				stopReason: "toolUse",
				timestamp: Date.now(),
			};
		}

		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model, systemPrompt: ["Test"], tools: [mockTool] },
			streamFn: (_model, _context, options) => {
				streamCallCount++;
				const stream = new AssistantMessageEventStream();
				const signal = options?.signal;

				if (streamCallCount === 1) {
					// First stream: emit text that triggers TTSR, then respond to abort
					pushAbortableTtsrStream(stream, signal);
				} else if (streamCallCount === 2) {
					// Continuation: return assistant message with a tool call
					queueMicrotask(() => {
						const msg = makeToolCallMsg();
						stream.push({ type: "start", partial: msg });
						stream.push({ type: "done", reason: "toolUse", message: msg });
					});
				} else {
					// After tool execution: return final response
					queueMicrotask(() => {
						allTurnsCompleted = true;
						const msg = makeMsg('Fixed: let val = result.expect("msg")');
						stream.push({ type: "start", partial: msg });
						stream.push({ type: "done", reason: "stop", message: msg });
					});
				}

				return stream;
			},
		});

		const sessionManager = SessionManager.inMemory(tempDir);
		const settings = Settings.isolated();
		const authStorage = await AuthStorage.create(path.join(tempDir, "testauth-tool.db"));
		authStorages.push(authStorage);
		const modelRegistry = new ModelRegistry(authStorage, path.join(tempDir, "models.yml"));
		authStorage.setRuntimeApiKey("anthropic", "test-key");

		session = new AgentSession({
			agent,
			sessionManager,
			settings,
			modelRegistry,
			ttsrManager,
		});

		// prompt() must block until the TTSR continuation (including tool execution) completes.
		// Before the fix, prompt() returned after the continuation's first assistant message_end,
		// while the agent was still executing tool calls in the background.
		await session.prompt("Write some Rust code");

		// By the time prompt() returns, ALL turns must have completed
		expect(toolExecutionFinished).toBe(true);
		expect(allTurnsCompleted).toBe(true);
		expect(streamCallCount).toBeGreaterThanOrEqual(3);
		expect(session.isStreaming).toBe(false);
	});
	it("interruptMode never folds tool-match reminder into the toolResult instead of driving an extra turn", async () => {
		const model = getBundledModel("anthropic", "claude-sonnet-4-5")!;
		let streamCallCount = 0;
		let toolExecuted = false;

		const ttsrManager = new TtsrManager({
			enabled: true,
			contextMode: "discard",
			interruptMode: "never",
			repeatMode: "once",
			repeatGap: 10,
		});
		ttsrManager.addRule(testRule);

		const mockTool: AgentTool = {
			name: "mock_edit",
			label: "Mock Edit",
			description: "A mock edit tool",
			parameters: z.object({ snippet: z.string().optional() }),
			execute: async () => {
				toolExecuted = true;
				return { content: [{ type: "text" as const, text: "edit applied" }] };
			},
		};

		const toolCallContent: ToolCall = {
			type: "toolCall",
			id: "call_never_001",
			name: "mock_edit",
			arguments: { snippet: "let val = result.unwrap()" },
		};

		const makeToolCallMsg = (): AssistantMessage => ({
			role: "assistant",
			content: [toolCallContent],
			api: "anthropic-messages",
			provider: "anthropic",
			model: "mock",
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "toolUse",
			timestamp: Date.now(),
		});

		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model, systemPrompt: ["Test"], tools: [mockTool] },
			streamFn: () => {
				streamCallCount++;
				const stream = new AssistantMessageEventStream();
				if (streamCallCount === 1) {
					// Emit a tool call whose argument delta matches the TTSR rule.
					queueMicrotask(() => {
						const partial = makeToolCallMsg();
						stream.push({ type: "start", partial });
						stream.push({ type: "toolcall_start", contentIndex: 0, partial });
						stream.push({
							type: "toolcall_delta",
							contentIndex: 0,
							delta: 'let val = result.unwrap("oops")',
							partial,
						});
						stream.push({ type: "toolcall_end", contentIndex: 0, toolCall: toolCallContent, partial });
						stream.push({ type: "done", reason: "toolUse", message: partial });
					});
				} else {
					// Continuation after tool result; finish cleanly.
					queueMicrotask(() => {
						const done = makeMsg("ok");
						stream.push({ type: "start", partial: done });
						stream.push({ type: "done", reason: "stop", message: done });
					});
				}
				return stream;
			},
		});

		const sessionManager = SessionManager.inMemory(tempDir);
		const settings = Settings.isolated();
		const authStorage = await AuthStorage.create(path.join(tempDir, "testauth-never-tool.db"));
		authStorages.push(authStorage);
		const modelRegistry = new ModelRegistry(authStorage, path.join(tempDir, "models.yml"));
		authStorage.setRuntimeApiKey("anthropic", "test-key");

		session = new AgentSession({
			agent,
			sessionManager,
			settings,
			modelRegistry,
			ttsrManager,
		});

		await session.prompt("Write some Rust code");

		// Tool ran (no interrupt) and the loop didn't spawn an extra follow-up turn for injection.
		expect(toolExecuted).toBe(true);
		expect(streamCallCount).toBe(2);

		// The matched tool's result must carry the in-band reminder.
		const toolResult = agent.state.messages.find(
			(m): m is Extract<typeof m, { role: "toolResult" }> =>
				m.role === "toolResult" && m.toolCallId === toolCallContent.id,
		);
		expect(toolResult).toBeDefined();
		const text = Array.isArray(toolResult?.content)
			? toolResult.content
					.filter((c): c is { type: "text"; text: string } => c.type === "text")
					.map(c => c.text)
					.join("\n")
			: "";
		expect(text).toContain("<system-reminder");
		expect(text).toContain('rule="no-unwrap"');
		expect(text).toContain("Do not use .unwrap()");
		expect(text.indexOf("<system-reminder")).toBeLessThan(text.indexOf("edit applied"));
	});

	it("interruptMode never deduplicates the reminder across sibling tool calls in one batch", async () => {
		const model = getBundledModel("anthropic", "claude-sonnet-4-5")!;
		let streamCallCount = 0;
		let executedCount = 0;

		const ttsrManager = new TtsrManager({
			enabled: true,
			contextMode: "discard",
			interruptMode: "never",
			repeatMode: "once",
			repeatGap: 10,
		});
		ttsrManager.addRule(testRule);

		const mockTool: AgentTool = {
			name: "mock_edit",
			label: "Mock Edit",
			description: "A mock edit tool",
			parameters: z.object({ snippet: z.string().optional() }),
			execute: async () => {
				executedCount++;
				return { content: [{ type: "text" as const, text: "edit applied" }] };
			},
		};

		const toolCallA: ToolCall = {
			type: "toolCall",
			id: "call_dup_A",
			name: "mock_edit",
			arguments: { snippet: "a.unwrap()" },
		};
		const toolCallB: ToolCall = {
			type: "toolCall",
			id: "call_dup_B",
			name: "mock_edit",
			arguments: { snippet: "b.unwrap()" },
		};
		const toolCallC: ToolCall = {
			type: "toolCall",
			id: "call_dup_C",
			name: "mock_edit",
			arguments: { snippet: "c.unwrap()" },
		};

		const makeBatchMsg = (): AssistantMessage => ({
			role: "assistant",
			content: [toolCallA, toolCallB, toolCallC],
			api: "anthropic-messages",
			provider: "anthropic",
			model: "mock",
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "toolUse",
			timestamp: Date.now(),
		});

		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model, systemPrompt: ["Test"], tools: [mockTool] },
			streamFn: () => {
				streamCallCount++;
				const stream = new AssistantMessageEventStream();
				if (streamCallCount === 1) {
					queueMicrotask(() => {
						const partial = makeBatchMsg();
						stream.push({ type: "start", partial });
						const calls: ToolCall[] = [toolCallA, toolCallB, toolCallC];
						for (let i = 0; i < calls.length; i++) {
							const call = calls[i]!;
							stream.push({ type: "toolcall_start", contentIndex: i, partial });
							stream.push({
								type: "toolcall_delta",
								contentIndex: i,
								delta: `let val = result.unwrap("oops-${call.id}")`,
								partial,
							});
							stream.push({ type: "toolcall_end", contentIndex: i, toolCall: call, partial });
						}
						stream.push({ type: "done", reason: "toolUse", message: partial });
					});
				} else {
					queueMicrotask(() => {
						const done = makeMsg("ok");
						stream.push({ type: "start", partial: done });
						stream.push({ type: "done", reason: "stop", message: done });
					});
				}
				return stream;
			},
		});

		const sessionManager = SessionManager.inMemory(tempDir);
		const settings = Settings.isolated();
		const authStorage = await AuthStorage.create(path.join(tempDir, "testauth-dup.db"));
		authStorages.push(authStorage);
		const modelRegistry = new ModelRegistry(authStorage, path.join(tempDir, "models.yml"));
		authStorage.setRuntimeApiKey("anthropic", "test-key");

		session = new AgentSession({
			agent,
			sessionManager,
			settings,
			modelRegistry,
			ttsrManager,
		});

		await session.prompt("Write some Rust code");

		expect(executedCount).toBe(3);
		const toolResults = agent.state.messages.filter(
			(m): m is Extract<typeof m, { role: "toolResult" }> => m.role === "toolResult",
		);
		expect(toolResults).toHaveLength(3);
		const withReminder = toolResults.filter(r =>
			Array.isArray(r.content)
				? r.content.some(c => c.type === "text" && c.text.includes("<system-reminder"))
				: false,
		);
		expect(withReminder).toHaveLength(1);
	});

	it("prompt() waits for context-promotion continuation to finish", async () => {
		const authStorage = await AuthStorage.create(path.join(tempDir, "testauth-promo.db"));
		authStorages.push(authStorage);
		authStorage.setRuntimeApiKey("openai-codex", "test-key");
		const modelRegistry = new ModelRegistry(authStorage, path.join(tempDir, "models.yml"));

		const sparkModel = modelRegistry.find("openai-codex", "gpt-5.3-codex-spark");
		const codexModel = modelRegistry.find("openai-codex", "gpt-5.5");
		if (!sparkModel || !codexModel) {
			throw new Error("Expected codex spark and codex models to exist");
		}

		let streamCallCount = 0;
		let continuationCompleted = false;

		const makeOverflowMessage = (): AssistantMessage => ({
			role: "assistant",
			content: [{ type: "text", text: "" }],
			api: sparkModel.api,
			provider: sparkModel.provider,
			model: sparkModel.id,
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "error",
			errorMessage: "context_length_exceeded: Your input exceeds the context window of this model.",
			timestamp: Date.now(),
		});

		const makeSuccessMessage = (): AssistantMessage => ({
			role: "assistant",
			content: [{ type: "text", text: "Recovered after promotion" }],
			api: codexModel.api,
			provider: codexModel.provider,
			model: codexModel.id,
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop",
			timestamp: Date.now(),
		});

		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model: sparkModel, systemPrompt: ["Test"], tools: [] },
			streamFn: () => {
				streamCallCount++;
				const stream = new AssistantMessageEventStream();
				if (streamCallCount === 1) {
					queueMicrotask(() => {
						const message = makeOverflowMessage();
						stream.push({ type: "start", partial: message });
						stream.push({ type: "error", reason: "error", error: message });
					});
				} else {
					queueMicrotask(() => {
						continuationCompleted = true;
						const message = makeSuccessMessage();
						stream.push({ type: "start", partial: message });
						stream.push({ type: "done", reason: "stop", message });
					});
				}
				return stream;
			},
		});

		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(tempDir),
			settings: Settings.isolated({ "compaction.enabled": false, "contextPromotion.enabled": true }),
			modelRegistry,
		});

		await session.prompt("Handle overflow");

		expect(continuationCompleted).toBe(true);
		expect(streamCallCount).toBeGreaterThanOrEqual(2);
		expect(session.model?.id).toBe(codexModel.id);
		expect(session.isStreaming).toBe(false);
	});
});
