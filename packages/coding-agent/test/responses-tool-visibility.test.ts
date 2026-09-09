import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { agentLoop } from "@gajae-code/agent-core/agent-loop";
import { isNonDispatchedToolEvent } from "@gajae-code/agent-core/tool-dispatch-identity";
import type { AgentTool } from "@gajae-code/agent-core/types";
import { processResponsesStream } from "@gajae-code/ai/providers/openai-responses-shared";
import type { AssistantMessage, AssistantMessageEvent, Message, Model } from "@gajae-code/ai/types";
import { AssistantMessageEventStream } from "@gajae-code/ai/utils/event-stream";
import { Container, Text, TUI } from "@gajae-code/tui";
import type { ResponseStreamEvent } from "openai/resources/responses/responses";
import * as z from "zod/v4";
import { VirtualTerminal } from "../../tui/test/virtual-terminal";
import { resetSettingsForTest, Settings } from "../src/config/settings";
import { EventController } from "../src/modes/controllers/event-controller";
import { initTheme } from "../src/modes/theme/theme";
import type { InteractiveModeContext } from "../src/modes/types";

beforeEach(async () => {
	resetSettingsForTest();
	await Settings.init({ inMemory: true });
	await initTheme(false);
});
afterEach(() => resetSettingsForTest());

const model: Model<"openai-responses"> = {
	id: "visibility-test",
	name: "Visibility test",
	api: "openai-responses",
	provider: "openai",
	baseUrl: "https://example.invalid/v1",
	reasoning: true,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 128000,
	maxTokens: 8192,
};

function makeMessage(): AssistantMessage {
	return {
		role: "assistant",
		content: [],
		api: model.api,
		provider: model.provider,
		model: model.id,
		stopReason: "stop",
		timestamp: 1,
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
	};
}

// Only drain scheduled frames; never request a render, send input, resize, or
// force a full repaint here. A missing controller render must remain observable.
async function expectVisible(terminal: VirtualTerminal, ...needles: string[]): Promise<void> {
	let viewport = "";
	for (let frame = 0; frame < 5; frame++) {
		await terminal.waitForRender();
		viewport = terminal.getViewport().join("\n");
		if (needles.every(needle => viewport.includes(needle))) return;
	}
	for (const needle of needles) expect(viewport).toContain(needle);
}

function createFixture(historyRows: number) {
	const terminal = new VirtualTerminal(100, 32, { isProcessTerminal: true });
	const ui = new TUI(terminal);
	const chatContainer = new Container();
	if (historyRows > 0) {
		chatContainer.addChild(
			new Text(Array.from({ length: historyRows }, (_, index) => `history-row-${index}`).join("\n"), 0, 0),
		);
	}
	const statusLine = new Text("STATUS-PINNED", 0, 0);
	ui.addChild(chatContainer);
	ui.setViewportAnchorComponent(chatContainer);
	ui.addChild(statusLine);
	ui.addChild(new Text("> EDITOR-PINNED", 0, 0));
	ui.setBottomPinnedComponent(statusLine);
	const identity = "session:responses-visibility";
	let revision = 0n;
	ui.setViewportOutputSource({ identity, revision });
	const ctx = {
		isInitialized: true,
		isBackgrounded: false,
		ui,
		chatContainer,
		statusLine,
		pendingTools: new Map(),
		pendingBashComponents: [],
		pendingPythonComponents: [],
		hideThinkingBlock: false,
		toolOutputExpanded: true,
		session: {
			getToolByName: () => undefined,
			isTtsrAbortPending: false,
			retryAttempt: 0,
		},
		sessionManager: { getCwd: () => process.cwd() },
		updateEditorTopBorder() {},
		recordVisibleTranscriptMutation() {
			revision += 1n;
			ui.setViewportOutputSource({ identity, revision });
		},
	} as unknown as InteractiveModeContext;
	const controller = new EventController(ctx);
	return { terminal, ui, chatContainer, ctx, controller };
}

describe("Responses tools remain visible during uninterrupted reasoning", () => {
	for (const historyRows of [0, 10000]) {
		it(`paints streamed calls and execution results before interruption (${historyRows} history rows)`, async () => {
			const { terminal, ui, chatContainer, ctx, controller } = createFixture(historyRows);
			const output = makeMessage();
			const pending: AssistantMessageEvent[] = [];
			const emittedTypes: string[] = [];
			// Snapshot at the provider boundary: processResponsesStream mutates its
			// output in place. Delivery is serialized like the session event bridge,
			// rather than letting later deltas overwrite earlier test observations.
			const sink = {
				push(event: AssistantMessageEvent) {
					pending.push(structuredClone(event));
					emittedTypes.push(event.type);
				},
			} as unknown as AssistantMessageEventStream;
			async function deliver() {
				for (const event of pending.splice(0)) {
					if (!("partial" in event)) throw new Error(`Unexpected terminal provider event: ${event.type}`);
					await controller.handleEvent({
						type: "message_update",
						message: event.partial,
						assistantMessageEvent: event,
					});
				}
			}
			const toolItem = {
				type: "function_call",
				id: "fc_visibility",
				call_id: "call_visibility",
				name: "bash",
				arguments: "",
			};
			const args = { command: "printf TOOL-CALL-VISIBLE" };
			let toolCallId = "";
			const result = (text: string) => ({ content: [{ type: "text" as const, text }], details: {} });
			// Checkpoints run while the converter is still consuming the wire stream.
			// No response.completed, message_end, agent_end, or keyboard event can
			// rescue a stale frame before these assertions.
			const steps: Array<object | (() => Promise<void>)> = [
				{
					type: "response.output_item.added",
					output_index: 0,
					item: { type: "reasoning", id: "rs_first", summary: [] },
				},
				{
					type: "response.reasoning_summary_part.added",
					item_id: "rs_first",
					output_index: 0,
					summary_index: 0,
					part: { type: "summary_text", text: "" },
				},
				{
					type: "response.reasoning_summary_text.delta",
					item_id: "rs_first",
					output_index: 0,
					summary_index: 0,
					delta: "**Inspecting tools**\n\nChecking the visible stream.",
				},
				async () => {
					await expectVisible(terminal, "Inspecting tools", "STATUS-PINNED", "EDITOR-PINNED");
					if (historyRows > 0) expect(terminal.getViewport().join("\n")).not.toContain("history-row-0\n");
				},
				{ type: "response.output_item.added", output_index: 1, item: toolItem },
				{
					type: "response.function_call_arguments.delta",
					item_id: toolItem.id,
					output_index: 1,
					delta: '{"command":"printf TOOL-',
				},
				{
					type: "response.function_call_arguments.delta",
					item_id: toolItem.id,
					output_index: 1,
					delta: 'CALL-VISIBLE"}',
				},
				async () => {
					await expectVisible(terminal, "TOOL-CALL-VISIBLE", "STATUS-PINNED");
				},
				{
					type: "response.output_item.done",
					output_index: 1,
					item: { ...toolItem, arguments: JSON.stringify(args), status: "completed" },
				},
				async () => {
					const call = output.content.find(block => block.type === "toolCall");
					if (call?.type !== "toolCall") throw new Error("Converter did not emit the tool call");
					toolCallId = call.id;
					await controller.handleEvent({ type: "tool_execution_start", toolCallId, toolName: "bash", args });
					await expectVisible(terminal, "TOOL-CALL-VISIBLE");
					await controller.handleEvent({
						type: "tool_execution_update",
						toolCallId,
						toolName: "bash",
						args,
						partialResult: result("RESULT-PARTIAL-VISIBLE"),
					});
					await expectVisible(terminal, "TOOL-CALL-VISIBLE", "RESULT-PARTIAL-VISIBLE");
					await controller.handleEvent({
						type: "tool_execution_end",
						toolCallId,
						toolName: "bash",
						result: result("RESULT-FINAL-VISIBLE"),
						isError: false,
					});
					await expectVisible(terminal, "TOOL-CALL-VISIBLE", "RESULT-FINAL-VISIBLE");
				},
				{
					type: "response.output_item.added",
					output_index: 2,
					item: { type: "reasoning", id: "rs_next", summary: [] },
				},
				{
					type: "response.reasoning_summary_part.added",
					item_id: "rs_next",
					output_index: 2,
					summary_index: 0,
					part: { type: "summary_text", text: "" },
				},
				{
					type: "response.reasoning_summary_text.delta",
					item_id: "rs_next",
					output_index: 2,
					summary_index: 0,
					delta: "**Reviewing results**\n\nContinuing without input.",
				},
				async () => {
					await expectVisible(
						terminal,
						"Reviewing results",
						"TOOL-CALL-VISIBLE",
						"RESULT-FINAL-VISIBLE",
						"EDITOR-PINNED",
					);
					expect(ctx.streamingComponent).toBeDefined();
					expect(ctx.pendingTools.size).toBe(0);
				},
			];
			async function* wire(): AsyncIterable<ResponseStreamEvent> {
				for (const step of steps) {
					await deliver();
					if (typeof step === "function") await step();
					else yield step as ResponseStreamEvent;
				}
				await deliver();
			}
			try {
				ui.start();
				await controller.handleEvent({ type: "message_start", message: output });
				await processResponsesStream(wire(), output, sink, model);
				expect(emittedTypes).toContain("reasoning_summary_delta");
				expect(emittedTypes).toContain("toolcall_delta");
				expect(emittedTypes).toContain("toolcall_end");

				// Only now simulate interruption. Queue an unpainted text delta and
				// immediately replace it with the authoritative aborted message.
				const draft = structuredClone(output);
				const contentIndex = draft.content.length;
				draft.content.push({ type: "text", text: "STALE-DRAFT-MUST-NOT-APPEAR" });
				await controller.handleEvent({
					type: "message_update",
					message: draft,
					assistantMessageEvent: {
						type: "text_delta",
						contentIndex,
						delta: "STALE-DRAFT-MUST-NOT-APPEAR",
						partial: draft,
					},
				});
				await controller.handleEvent({
					type: "message_end",
					message: { ...structuredClone(output), stopReason: "aborted" },
				});
				await expectVisible(terminal, "Reviewing results", "RESULT-FINAL-VISIBLE");
				expect(ctx.streamingComponent).toBeUndefined();
				expect(ctx.streamingMessage).toBeUndefined();
				controller.resumeAssistantTextPresentation();
				await terminal.waitForRender();
				expect(terminal.getScrollBuffer().join("\n")).not.toContain("STALE-DRAFT-MUST-NOT-APPEAR");
			} finally {
				controller.dispose();
				chatContainer.clear();
				ui.stop();
				await terminal.flush();
			}
		});
	}
});

async function within<T>(promise: Promise<T>, label: string): Promise<T> {
	const timeout = Promise.withResolvers<never>();
	const timer: NodeJS.Timeout = setTimeout(() => timeout.reject(new Error(`Timed out: ${label}`)), 2000);
	try {
		return await Promise.race([promise, timeout.promise]);
	} finally {
		clearTimeout(timer);
	}
}

for (const [abortBeforeDone, toolOnly, description] of [
	[
		false,
		false,
		"publishes reasoning/tool-only updates before provider done and results before the next response ends",
	],
	[true, false, "abort before provider done retains visible reasoning and tool call without execution"],
	[false, true, "publishes tool-only response before provider done"],
] as const) {
	it(`agentLoop ${description}`, async () => {
		const { terminal, ui, chatContainer, ctx, controller } = createFixture(10000);
		const abort = new AbortController();
		const firstReady = Promise.withResolvers<void>();
		const firstRelease = Promise.withResolvers<void>();
		const secondReady = Promise.withResolvers<void>();
		const secondRelease = Promise.withResolvers<void>();
		const toolReady = Promise.withResolvers<void>();
		const toolRelease = Promise.withResolvers<void>();
		const providerTasks: Promise<void>[] = [];
		const seen: string[] = [];
		const cancelledPair: Array<{ type: string; nonDispatched: boolean }> = [];
		let executions = 0;
		const schema = z.object({ command: z.string() });
		const tool: AgentTool<typeof schema> = {
			name: "bash",
			label: "Bash",
			description: "Deterministic visibility fixture; never executes a shell",
			parameters: schema,
			async execute(_id, _args, _signal, onUpdate) {
				executions += 1;
				onUpdate?.({ content: [{ type: "text", text: "LOOP-PARTIAL-VISIBLE" }], details: {} });
				toolReady.resolve();
				await toolRelease.promise;
				return { content: [{ type: "text", text: "LOOP-FINAL-VISIBLE" }], details: {} };
			},
		};
		let calls = 0;
		let consumerError: unknown;
		let consume: Promise<void> | undefined;
		try {
			ui.start();
			const events = agentLoop(
				[{ role: "user", content: "Check tool visibility", timestamp: 1 }],
				{ systemPrompt: [""], messages: [], tools: [tool] },
				{ model, convertToLlm: messages => messages as Message[], fallbackManaged: false },
				abort.signal,
				() => {
					const response = ++calls;
					const stream = new AssistantMessageEventStream();
					const output = makeMessage();
					const task = (async () => {
						try {
							const reasoningId = `rs_loop_${response}`;
							async function* wire(): AsyncIterable<ResponseStreamEvent> {
								const events: object[] = [
									{
										type: "response.output_item.added",
										output_index: 0,
										item: { type: "reasoning", id: reasoningId, summary: [] },
									},
									{
										type: "response.reasoning_summary_part.added",
										item_id: reasoningId,
										output_index: 0,
										summary_index: 0,
										part: { type: "summary_text", text: "" },
									},
									{
										type: "response.reasoning_summary_text.delta",
										item_id: reasoningId,
										output_index: 0,
										summary_index: 0,
										delta: response === 1 ? "**Loop inspecting tools**" : "**Loop reviewing results**",
									},
								];
								if (toolOnly && response === 1) events.length = 0;
								if (response === 1) {
									const item = {
										type: "function_call",
										id: "fc_loop",
										call_id: "call_loop",
										name: "bash",
										arguments: "",
									};
									const outputIndex = toolOnly ? 0 : 1;
									events.push(
										{ type: "response.output_item.added", output_index: outputIndex, item },
										{
											type: "response.function_call_arguments.delta",
											item_id: item.id,
											output_index: outputIndex,
											delta: '{"command":"printf LOOP-CALL-VISIBLE"}',
										},
										{
											type: "response.output_item.done",
											output_index: outputIndex,
											item: {
												...item,
												arguments: '{"command":"printf LOOP-CALL-VISIBLE"}',
												status: "completed",
											},
										},
									);
								}
								for (const event of events) yield event as ResponseStreamEvent;
							}
							stream.push({ type: "start", partial: output });
							await processResponsesStream(wire(), output, stream, model);
							const ready = response === 1 ? firstReady : secondReady;
							const release = response === 1 ? firstRelease : secondRelease;
							ready.resolve();
							await release.promise;
							if (abort.signal.aborted) {
								output.stopReason = "aborted";
								stream.push({ type: "error", reason: "aborted", error: output });
							} else {
								output.stopReason = response === 1 ? "toolUse" : "stop";
								stream.push({ type: "done", reason: output.stopReason, message: output });
							}
						} catch (error) {
							output.stopReason = "error";
							output.errorMessage = String(error);
							stream.push({ type: "error", reason: "error", error: output });
							firstReady.reject(error);
							secondReady.resolve();
						} finally {
							stream.end();
						}
					})();
					providerTasks.push(task);
					return stream;
				},
			);
			consume = (async () => {
				for await (const event of events) {
					seen.push(
						event.type === "message_start" || event.type === "message_end"
							? `${event.message.role}:${event.type}`
							: event.type,
					);
					if (event.type === "tool_execution_start" || event.type === "tool_execution_end") {
						cancelledPair.push({ type: event.type, nonDispatched: isNonDispatchedToolEvent(event) });
					}
					// The full loop and tool dispatcher are real. Only unrelated root-mode
					// activity/user-message chrome is omitted from this focused bridge.
					if (
						((event.type === "message_start" || event.type === "message_end") &&
							event.message.role === "assistant") ||
						event.type === "message_update" ||
						event.type === "tool_execution_start" ||
						event.type === "tool_execution_update" ||
						event.type === "tool_execution_end"
					)
						await controller.handleEvent(event);
				}
			})().catch(error => {
				consumerError = error;
			});

			await within(firstReady.promise, "first provider deltas");
			const firstVisible = toolOnly
				? ["LOOP-CALL-VISIBLE", "EDITOR-PINNED"]
				: ["Loop inspecting tools", "LOOP-CALL-VISIBLE", "EDITOR-PINNED"];
			await expectVisible(terminal, ...firstVisible);
			expect(executions).toBe(0);
			if (abortBeforeDone) {
				// Publication precedes interruption; abort must retain that output
				// without accepting or executing the still-unfinished response.
				expect(seen).not.toContain("assistant:message_end");
				expect(seen).not.toContain("tool_execution_start");
				expect(executions).toBe(0);
				abort.abort();
				firstRelease.resolve();
				await within(consume, "abort before provider completion");
				expect(consumerError).toBeUndefined();
				await expectVisible(terminal, ...firstVisible);
				expect(executions).toBe(0);
				expect(cancelledPair).toEqual([
					{ type: "tool_execution_start", nonDispatched: true },
					{ type: "tool_execution_end", nonDispatched: true },
				]);
				expect(seen).toContain("agent_end");
				expect(ctx.streamingComponent).toBeUndefined();
				expect(ctx.streamingMessage).toBeUndefined();
				return;
			}
			// A tool cannot execute before response acceptance. Its *streamed call*
			// must nevertheless be visible before provider done releases the loop.
			expect(seen).not.toContain("assistant:message_end");
			expect(seen).not.toContain("tool_execution_start");
			firstRelease.resolve();
			await within(toolReady.promise, "tool partial update");
			await expectVisible(terminal, "LOOP-CALL-VISIBLE", "LOOP-PARTIAL-VISIBLE");
			toolRelease.resolve();
			await within(secondReady.promise, "next reasoning response");
			await expectVisible(terminal, "Loop reviewing results", "LOOP-FINAL-VISIBLE", "EDITOR-PINNED");
			expect(seen).not.toContain("agent_end");
			expect(ctx.pendingTools.size).toBe(0);
			// Abort the still-open second response only after all live visibility checks.
			abort.abort();
			secondRelease.resolve();
			await within(consume, "interrupted loop cleanup");
			expect(consumerError).toBeUndefined();
			expect(ctx.streamingComponent).toBeUndefined();
			expect(ctx.streamingMessage).toBeUndefined();
			await expectVisible(terminal, "Operation aborted", "LOOP-FINAL-VISIBLE");
		} finally {
			abort.abort();
			firstRelease.resolve();
			secondRelease.resolve();
			toolRelease.resolve();
			try {
				await within(Promise.all([consume, ...providerTasks]), "fixture teardown");
			} finally {
				controller.dispose();
				chatContainer.clear();
				ui.stop();
				await terminal.flush();
			}
		}
	});
}
