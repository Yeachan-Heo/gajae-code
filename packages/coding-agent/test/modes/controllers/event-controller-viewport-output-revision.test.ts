import { afterEach, beforeEach, describe, expect, it, type Mock, vi } from "bun:test";
import type { AssistantMessage } from "@gajae-code/ai";
import { resetSettingsForTest, Settings } from "@gajae-code/coding-agent/config/settings";
import { EDIT_MODE_STRATEGIES, type PerFileDiffPreview } from "@gajae-code/coding-agent/edit";
import { AssistantMessageComponent } from "@gajae-code/coding-agent/modes/components/assistant-message";
import type {
	ToolExecutionComponent,
	ToolExecutionHandle,
} from "@gajae-code/coding-agent/modes/components/tool-execution";
import { EventController } from "@gajae-code/coding-agent/modes/controllers/event-controller";
import { initTheme } from "@gajae-code/coding-agent/modes/theme/theme";
import type { InteractiveModeContext } from "@gajae-code/coding-agent/modes/types";
import { type Component, Container, Editor, Text, TUI } from "@gajae-code/tui";
import { renderMetrics } from "../../../../tui/src/metrics";
import { defaultEditorTheme } from "../../../../tui/test/test-themes";
import { VirtualTerminal } from "../../../../tui/test/virtual-terminal";

function createContext(handle: ToolExecutionHandle): {
	ctx: InteractiveModeContext;
	addMessageToChat: Mock<() => Component[]>;
	recordVisibleTranscriptMutation: Mock<() => void>;
	drain: () => void;
} {
	const addMessageToChat = vi.fn<() => Component[]>(() => []);
	const recordVisibleTranscriptMutation = vi.fn();
	const preparations = new Set<() => void>();
	const ctx = {
		isInitialized: true,
		statusLine: { invalidate: vi.fn() },
		updateEditorTopBorder: vi.fn(),
		ui: {
			requestRender: vi.fn(),
			enqueueBeforeRender: (callback: () => void) => {
				preparations.add(callback);
				return () => {
					preparations.delete(callback);
				};
			},
		},
		pendingTools: new Map([["tool-1", handle]]),
		addMessageToChat,
		recordVisibleTranscriptMutation,
		settings: { get: () => true },
		toolOutputExpanded: false,
		chatContainer: new Container(),
		session: { getToolByName: vi.fn(), agent: { appendMessage: vi.fn() } },
		sessionManager: { getCwd: vi.fn(() => process.cwd()), appendMessage: vi.fn() },
	} as unknown as InteractiveModeContext;
	return {
		ctx,
		addMessageToChat,
		recordVisibleTranscriptMutation,
		drain: () => {
			for (const callback of [...preparations]) {
				preparations.delete(callback);
				callback();
			}
		},
	};
}

async function waitFor(condition: () => boolean): Promise<void> {
	for (let attempts = 0; attempts < 50; attempts++) {
		if (condition()) return;
		await Promise.resolve();
	}
	throw new Error("Preview computation did not reach the expected state");
}

const applyPatch = [
	"*** Begin Patch",
	"*** Update File: preview.ts",
	"@@",
	"-const value = 1;",
	"+const value = 2;",
	"*** End Patch",
].join("\n");

const preview: PerFileDiffPreview[] = [
	{ path: "preview.ts", diff: "@@ -1 +1 @@\n-const value = 1;\n+const value = 2;" },
];

describe("EventController viewport output revision", () => {
	beforeEach(async () => {
		resetSettingsForTest();
		await initTheme(false);
	});

	afterEach(() => {
		vi.restoreAllMocks();
		resetSettingsForTest();
	});

	for (const mode of ["normal", "forced", "input"] as const) {
		for (const reject of [false, true]) {
			for (const independentDirty of [false, true]) {
				it(`publishes text before ${mode} frame during ${reject ? "rejected" : "resolved"} reload, independent dirty=${independentDirty}`, async () => {
					await Settings.init({ inMemory: true });
					const handle: ToolExecutionHandle = {
						updateArgs: vi.fn(),
						updateResult: vi.fn(),
						setArgsComplete: vi.fn(),
						setExpanded: vi.fn(),
					};
					const { ctx, recordVisibleTranscriptMutation } = createContext(handle);
					const terminal = new VirtualTerminal(80, 20);
					const tui = new TUI(terminal);
					const metricsEnabled = renderMetrics.enabled;
					renderMetrics.enable();
					const commits = vi.spyOn(renderMetrics, "recordRender");
					ctx.ui = tui;
					let revision = 0n;
					tui.setViewportOutputSource({ identity: "test-session", revision });
					recordVisibleTranscriptMutation.mockImplementation(() => {
						tui.setViewportOutputSource({ identity: "test-session", revision: ++revision });
					});
					tui.addChild(ctx.chatContainer);
					const editor = new Editor(defaultEditorTheme);
					tui.addChild(editor);
					tui.setFocus(editor);
					const controller = new EventController(ctx);
					tui.setRenderPreparationLifecycleCallbacks({
						invalidate: () => controller.suspendAssistantTextPresentation(),
						beforeStart: () => controller.resumeAssistantTextPresentation(),
					});
					const gate = Promise.withResolvers<void>();
					const entered = Promise.withResolvers<void>();
					ctx.reloadTodos = vi.fn(() => {
						entered.resolve();
						return gate.promise;
					});
					try {
						tui.start();
						await terminal.waitForRender();
						await controller.handleEvent({ type: "message_start", message: assistantMessage("historical") });
						const historical = ctx.streamingComponent!;
						await controller.handleEvent({ type: "message_end", message: assistantMessage("historical") });
						await controller.handleEvent({ type: "message_start", message: assistantMessage("") });
						await tui.waitForRenderCommit(tui.requestRenderWithGeneration(true));
						const drainScheduler = async () => {
							// Probe for forbidden follow-up work only after a real commit barrier.
							// Do not use this fake-clock probe to establish a required commit.
							for (let turn = 0; turn < 3; turn++) {
								await Promise.resolve();
								await new Promise<void>(resolve => process.nextTick(resolve));
								vi.advanceTimersByTime(100);
								await Promise.resolve();
							}
						};
						recordVisibleTranscriptMutation.mockClear();
						const component = ctx.streamingComponent!;
						const projection = vi.spyOn(component, "updateContent");
						const latest = assistantMessage("prepared while reload waits");
						const commitsBeforeQueue = commits.mock.calls.length;
						await controller.handleEvent({
							type: "message_update",
							message: latest,
							assistantMessageEvent: { type: "text_delta", contentIndex: 0 },
						} as never);
						const pending = controller.handleEvent({ type: "todo_auto_clear" } as never);
						// Attach the rejection observer before rejecting, without changing dispatch semantics.
						const settled = pending.then(
							() => undefined,
							error => error,
						);
						await entered.promise;
						if (independentDirty)
							historical.updateContent(assistantMessage("independent historical image equivalent"), {
								streaming: false,
							});
						expect(recordVisibleTranscriptMutation).not.toHaveBeenCalled();
						const seen: number[] = [];
						const originalRender = component.render.bind(component);
						vi.spyOn(component, "render").mockImplementation(width => {
							seen.push(recordVisibleTranscriptMutation.mock.calls.length);
							return originalRender(width);
						});
						const generation = tui.requestRenderWithGeneration(mode === "forced");
						if (mode === "input") terminal.sendInput("x");
						expect(await tui.waitForRenderCommit(generation)).toBe(true);
						expect(commits).toHaveBeenCalledTimes(commitsBeforeQueue + 1);
						expect(projection).toHaveBeenCalledTimes(1);
						expect(seen.length).toBeGreaterThan(0);
						expect(seen.every(count => count === 1)).toBe(true);
						expect(terminal.getWriteLog().join("")).toContain("prepared while reload waits");
						const renderedBeforeSettlement = seen.length;
						const commitsBeforeSettlement = commits.mock.calls.length;
						const writesBeforeSettlement = [...terminal.getWriteLog()];
						// No-dirty settlements must not request any frame. Install the controlled
						// clock before settlement to detect such work without creating a barrier.
						if (!independentDirty || reject) vi.useFakeTimers();
						if (reject) gate.reject(new Error("reload failed"));
						else gate.resolve();
						const result = await settled;
						if (reject) expect(result).toBeInstanceOf(Error);
						else expect(result).toBeUndefined();
						expect(recordVisibleTranscriptMutation).toHaveBeenCalledTimes(independentDirty && !reject ? 2 : 1);
						expect(projection).toHaveBeenCalledTimes(1);
						if (!independentDirty || reject) {
							await drainScheduler();
							expect(seen).toHaveLength(renderedBeforeSettlement);
							expect(commits).toHaveBeenCalledTimes(commitsBeforeSettlement);
							expect(terminal.getWriteLog()).toEqual(writesBeforeSettlement);
						} else {
							// Publication is asserted above. Drain its legitimate render request via
							// a real generation barrier, not fake elapsed time: TUI's frame budget
							// uses performance.now(), which need not share the fake timer clock.
							const settledGeneration = tui.requestRenderWithGeneration(true);
							expect(await tui.waitForRenderCommit(settledGeneration)).toBe(true);
							expect(projection).toHaveBeenCalledTimes(1);
							vi.useFakeTimers();
						}
						const quiescentReads = seen.length;
						const quiescentCommits = commits.mock.calls.length;
						const quiescentWrites = [...terminal.getWriteLog()];
						await drainScheduler();
						expect(seen).toHaveLength(quiescentReads);
						expect(commits).toHaveBeenCalledTimes(quiescentCommits);
						expect(terminal.getWriteLog()).toEqual(quiescentWrites);
						expect(projection).toHaveBeenCalledTimes(1);
					} finally {
						gate.resolve();
						tui.setRenderPreparationLifecycleCallbacks(undefined);
						controller.dispose();
						tui.stop();
						vi.useRealTimers();
						commits.mockRestore();
						if (!metricsEnabled) renderMetrics.disable();
					}
				});
			}
		}
	}

	it("restores the exact-component publication scope after a throwing projection", async () => {
		await Settings.init({ inMemory: true });
		const handle: ToolExecutionHandle = {
			updateArgs: vi.fn(),
			updateResult: vi.fn(),
			setArgsComplete: vi.fn(),
			setExpanded: vi.fn(),
		};
		const { ctx, drain, recordVisibleTranscriptMutation } = createContext(handle);
		const controller = new EventController(ctx);
		await controller.handleEvent({ type: "message_start", message: assistantMessage("") });
		const component = ctx.streamingComponent!;
		const originalUpdate = component.updateContent.bind(component);
		const projection = vi.spyOn(component, "updateContent").mockImplementationOnce(() => {
			throw new Error("projection failed");
		});
		await controller.handleEvent({
			type: "message_update",
			message: assistantMessage("queued"),
			assistantMessageEvent: { type: "text_delta", contentIndex: 0 },
		} as never);
		const gate = Promise.withResolvers<void>();
		const entered = Promise.withResolvers<void>();
		ctx.reloadTodos = vi.fn(() => {
			entered.resolve();
			return gate.promise;
		});
		const pending = controller.handleEvent({ type: "todo_auto_clear" } as never);
		await entered.promise;
		expect(() => drain()).toThrow("projection failed");
		projection.mockRestore();
		originalUpdate(assistantMessage("event owned after exception"), { streaming: true });
		expect(recordVisibleTranscriptMutation).not.toHaveBeenCalled();
		gate.resolve();
		await pending;
		expect(recordVisibleTranscriptMutation).toHaveBeenCalledTimes(1);
	});

	it("does not classify another component's synchronous callback as prepared text", async () => {
		await Settings.init({ inMemory: true });
		const handle: ToolExecutionHandle = {
			updateArgs: vi.fn(),
			updateResult: vi.fn(),
			setArgsComplete: vi.fn(),
			setExpanded: vi.fn(),
		};
		const { ctx, drain, recordVisibleTranscriptMutation } = createContext(handle);
		ctx.pendingTools.clear();
		const controller = new EventController(ctx);
		await controller.handleEvent({ type: "message_start", message: assistantMessage("history") });
		const historical = ctx.streamingComponent!;
		await controller.handleEvent({ type: "message_end", message: assistantMessage("history") });
		await controller.handleEvent({ type: "message_start", message: assistantMessage("") });
		const current = ctx.streamingComponent!;
		const update = current.updateContent.bind(current);
		vi.spyOn(current, "updateContent").mockImplementation((message, options) => {
			historical.updateContent(assistantMessage("unrelated synchronous output"), { streaming: false });
			update(message, options);
		});
		recordVisibleTranscriptMutation.mockClear();
		await controller.handleEvent({
			type: "message_update",
			message: assistantMessage("latest"),
			assistantMessageEvent: { type: "text_delta", contentIndex: 0 },
		} as never);
		const gate = Promise.withResolvers<void>();
		const entered = Promise.withResolvers<void>();
		ctx.reloadTodos = vi.fn(() => {
			entered.resolve();
			return gate.promise;
		});
		const pending = controller.handleEvent({ type: "todo_auto_clear" } as never);
		await entered.promise;
		drain();
		expect(recordVisibleTranscriptMutation).toHaveBeenCalledTimes(1);
		gate.resolve();
		await pending;
		expect(recordVisibleTranscriptMutation).toHaveBeenCalledTimes(2);
	});

	it("does not publish a revision for an unchanged deferred text signature", async () => {
		await Settings.init({ inMemory: true });
		const handle: ToolExecutionHandle = {
			updateArgs: vi.fn(),
			updateResult: vi.fn(),
			setArgsComplete: vi.fn(),
			setExpanded: vi.fn(),
		};
		const { ctx, drain, recordVisibleTranscriptMutation } = createContext(handle);
		const controller = new EventController(ctx);
		const message = assistantMessage("same source");
		await controller.handleEvent({ type: "message_start", message });
		recordVisibleTranscriptMutation.mockClear();
		await controller.handleEvent({
			type: "message_update",
			message,
			assistantMessageEvent: { type: "text_delta", contentIndex: 0 },
		} as never);
		drain();
		expect(recordVisibleTranscriptMutation).not.toHaveBeenCalled();
	});

	it("does not record a controller revision when an observed apply_patch preview resolves absent", async () => {
		await Settings.init({ inMemory: true });
		const requests: Array<PromiseWithResolvers<PerFileDiffPreview[] | null | undefined>> = [];
		vi.spyOn(EDIT_MODE_STRATEGIES.apply_patch, "computeDiffPreview").mockImplementation(() => {
			const request = Promise.withResolvers<PerFileDiffPreview[] | null | undefined>();
			requests.push(request);
			return request.promise as Promise<PerFileDiffPreview[] | null>;
		});
		const placeholder: ToolExecutionHandle = {
			updateArgs: vi.fn(),
			updateResult: vi.fn(),
			setArgsComplete: vi.fn(),
			setExpanded: vi.fn(),
		};
		const { ctx, recordVisibleTranscriptMutation } = createContext(placeholder);
		ctx.pendingTools = new Map();
		const controller = new EventController(ctx);

		await controller.handleEvent({
			type: "tool_execution_start",
			toolName: "apply_patch",
			toolCallId: "preview-1",
			args: { input: applyPatch },
		} as never);
		const component = ctx.pendingTools.get("preview-1") as ToolExecutionComponent;
		component.setExpanded(true);
		await waitFor(() => requests.length === 1);
		recordVisibleTranscriptMutation.mockClear();
		requests[0]!.resolve(preview);
		await waitFor(() => recordVisibleTranscriptMutation.mock.calls.length === 1);
		const visibleBefore = component.render(80);
		recordVisibleTranscriptMutation.mockClear();
		expect(component.consumeVisibleTranscriptChange()).toBe(false);

		component.updateArgs({ input: `${applyPatch}\n` });
		await waitFor(() => requests.length === 2);
		expect(component.consumeVisibleTranscriptChange()).toBe(false);
		requests[1]!.resolve(undefined);
		await Promise.resolve();

		expect(component.render(80)).toEqual(visibleBefore);
		expect(recordVisibleTranscriptMutation).not.toHaveBeenCalled();
		expect(component.consumeVisibleTranscriptChange()).toBe(false);
	});

	it("records one revision for a synchronous event only when its handle reports visible output", async () => {
		const handle: ToolExecutionHandle = {
			updateArgs: vi.fn(),
			updateResult: vi.fn(),
			setArgsComplete: vi.fn(),
			setExpanded: vi.fn(),
			consumeVisibleTranscriptChange: vi.fn(() => true),
		};
		const { ctx, recordVisibleTranscriptMutation } = createContext(handle);
		const controller = new EventController(ctx);

		await controller.handleEvent({
			type: "tool_execution_update",
			toolCallId: "tool-1",
			partialResult: { content: [], details: {} },
		} as never);

		expect(recordVisibleTranscriptMutation).toHaveBeenCalledTimes(1);
		expect(handle.updateResult).toHaveBeenCalledTimes(1);
		expect(handle.consumeVisibleTranscriptChange).toHaveBeenCalledTimes(1);
	});

	it("retains orphan assistant output and publishes its committed viewport revision", async () => {
		await Settings.init({ inMemory: true });
		const handle: ToolExecutionHandle = {
			updateArgs: vi.fn(),
			updateResult: vi.fn(),
			setArgsComplete: vi.fn(),
			setExpanded: vi.fn(),
		};
		const { ctx, recordVisibleTranscriptMutation } = createContext(handle);
		ctx.pendingTools.clear();
		ctx.setWorkingMessage = vi.fn();
		ctx.updateEditorBorderColor = vi.fn();
		ctx.editor = { getText: () => "" } as never;
		ctx.session = {
			isCompacting: false,
			isStreaming: false,
			getLastAssistantMessage: vi.fn(() => undefined),
			agent: { appendMessage: vi.fn(), state: { messages: [] } },
		} as never;
		ctx.sessionManager = {
			appendMessage: vi.fn(),
			getSessionName: vi.fn(() => ""),
			getCwd: vi.fn(() => process.cwd()),
		} as never;
		ctx.planModeController = { flushPendingModelSwitch: vi.fn(async () => {}) } as never;
		const controller = new EventController(ctx);
		vi.spyOn(controller, "sendCompletionNotification").mockImplementation(() => {});

		await controller.handleEvent({ type: "message_start", message: assistantMessage("") });
		const component = ctx.streamingComponent!;
		const partial = assistantMessage("orphan partial output");
		await controller.handleEvent({
			type: "message_update",
			message: partial,
			assistantMessageEvent: { type: "text_delta", contentIndex: 0 },
		} as never);
		expect(recordVisibleTranscriptMutation).not.toHaveBeenCalled();

		await controller.handleEvent({ type: "agent_end", messages: [] } as never);

		expect(ctx.chatContainer.hasLiveChild(component)).toBe(true);
		expect(Bun.stripANSI(component.render(80).join("\n"))).toContain("orphan partial output");
		expect(ctx.streamingComponent).toBeUndefined();
		expect(recordVisibleTranscriptMutation).toHaveBeenCalledTimes(1);
	});

	it("reconciles a pending assistant delta onto the reattached owner and advances one revision", async () => {
		await Settings.init({ inMemory: true });
		const handle: ToolExecutionHandle = {
			updateArgs: vi.fn(),
			updateResult: vi.fn(),
			setArgsComplete: vi.fn(),
			setExpanded: vi.fn(),
		};
		const { ctx, drain, recordVisibleTranscriptMutation } = createContext(handle);
		ctx.pendingTools.clear();
		const controller = new EventController(ctx);
		await controller.handleEvent({ type: "message_start", message: assistantMessage("") });
		const component = ctx.streamingComponent!;
		const projection = vi.spyOn(component, "updateContent");
		await controller.handleEvent({
			type: "message_update",
			message: assistantMessage("before reconcile"),
			assistantMessageEvent: { type: "text_delta", contentIndex: 0 },
		} as never);
		recordVisibleTranscriptMutation.mockClear();
		ctx.chatContainer.detachChild(component);
		controller.resetAssistantTextPresentation();
		ctx.chatContainer.clear();
		ctx.chatContainer.addChild(component);
		controller.rebindAssistantTextPresentation();
		const latest = assistantMessage("after reconcile");
		await controller.handleEvent({
			type: "message_update",
			message: latest,
			assistantMessageEvent: { type: "text_delta", contentIndex: 0 },
		} as never);

		drain();

		expect(ctx.chatContainer.hasLiveChild(component)).toBe(true);
		expect(projection).toHaveBeenCalledTimes(1);
		expect(projection).toHaveBeenLastCalledWith(latest, { streaming: true });
		expect(Bun.stripANSI(component.render(80).join("\n"))).toContain("after reconcile");
		expect(recordVisibleTranscriptMutation).toHaveBeenCalledTimes(1);
	});

	it("does not revise for a synchronous no-op projection", async () => {
		const handle: ToolExecutionHandle = {
			updateArgs: vi.fn(),
			updateResult: vi.fn(),
			setArgsComplete: vi.fn(),
			setExpanded: vi.fn(),
			consumeVisibleTranscriptChange: vi.fn(() => false),
		};
		const { ctx, recordVisibleTranscriptMutation } = createContext(handle);
		const controller = new EventController(ctx);

		await controller.handleEvent({
			type: "tool_execution_update",
			toolCallId: "tool-1",
			partialResult: { content: [], details: {} },
		} as never);

		expect(recordVisibleTranscriptMutation).not.toHaveBeenCalled();
	});

	it("serializes overlapping changed and no-op events so each flush retains its own change state", async () => {
		const handle: ToolExecutionHandle = {
			updateArgs: vi.fn(),
			updateResult: vi.fn(),
			setArgsComplete: vi.fn(),
			setExpanded: vi.fn(),
			consumeVisibleTranscriptChange: vi
				.fn(() => true)
				.mockReturnValueOnce(true)
				.mockReturnValueOnce(false),
		};
		const { ctx, recordVisibleTranscriptMutation } = createContext(handle);
		const initialization = Promise.withResolvers<void>();
		ctx.isInitialized = false;
		ctx.init = vi.fn(async () => {
			await initialization.promise;
			ctx.isInitialized = true;
		});
		const controller = new EventController(ctx);
		const event = {
			type: "tool_execution_update",
			toolCallId: "tool-1",
			partialResult: { content: [], details: {} },
		};

		const changed = controller.handleEvent(event as never);
		const noOp = controller.handleEvent(event as never);
		await Promise.resolve();
		initialization.resolve();
		await Promise.all([changed, noOp]);

		expect(handle.updateResult).toHaveBeenCalledTimes(2);
		expect(recordVisibleTranscriptMutation).toHaveBeenCalledTimes(1);
	});

	it("does not revise duplicate read args or results, but records a changed read result once", async () => {
		const handle: ToolExecutionHandle = {
			updateArgs: vi.fn(),
			updateResult: vi.fn(),
			setArgsComplete: vi.fn(),
			setExpanded: vi.fn(),
		};
		const { ctx, recordVisibleTranscriptMutation } = createContext(handle);
		await Settings.init({ inMemory: true });
		ctx.pendingTools = new Map();
		const controller = new EventController(ctx);
		const start = {
			type: "tool_execution_start",
			toolName: "read",
			toolCallId: "read-1",
			args: { path: "/tmp/example.ts" },
		};
		const result = {
			type: "tool_execution_end",
			toolName: "read",
			toolCallId: "read-1",
			result: { content: [{ type: "text", text: "updated content" }] },
			isError: false,
		};

		await controller.handleEvent(start as never);
		expect(recordVisibleTranscriptMutation).toHaveBeenCalledTimes(1);
		recordVisibleTranscriptMutation.mockClear();

		await controller.handleEvent(start as never);
		expect(recordVisibleTranscriptMutation).not.toHaveBeenCalled();

		await controller.handleEvent(result as never);
		expect(recordVisibleTranscriptMutation).toHaveBeenCalledTimes(1);
		recordVisibleTranscriptMutation.mockClear();

		await controller.handleEvent(result as never);
		expect(recordVisibleTranscriptMutation).not.toHaveBeenCalled();
	});

	describe("message start visible revisions", () => {
		it("records a displayed custom message once", async () => {
			const handle: ToolExecutionHandle = {
				updateArgs: vi.fn(),
				updateResult: vi.fn(),
				setArgsComplete: vi.fn(),
				setExpanded: vi.fn(),
			};
			const { ctx, addMessageToChat, recordVisibleTranscriptMutation } = createContext(handle);
			addMessageToChat.mockReturnValue([new Text("hook output", 1, 0)]);
			const controller = new EventController(ctx);

			await controller.handleEvent({
				type: "message_start",
				message: { role: "custom", customType: "hook", timestamp: 1, content: "hook output", display: true },
			} as never);
			await controller.handleEvent({
				type: "message_start",
				message: { role: "custom", customType: "hook", timestamp: 1, content: "hook output", display: true },
			} as never);

			expect(ctx.addMessageToChat).toHaveBeenCalledTimes(1);
			expect(recordVisibleTranscriptMutation).toHaveBeenCalledTimes(1);
		});

		it("does not revise a hidden custom message", async () => {
			const handle: ToolExecutionHandle = {
				updateArgs: vi.fn(),
				updateResult: vi.fn(),
				setArgsComplete: vi.fn(),
				setExpanded: vi.fn(),
			};
			const { ctx, addMessageToChat, recordVisibleTranscriptMutation } = createContext(handle);
			addMessageToChat.mockReturnValue([]);
			const controller = new EventController(ctx);

			await controller.handleEvent({
				type: "message_start",
				message: {
					role: "custom",
					customType: "hook",
					timestamp: 2,
					content: "hidden hook output",
					display: false,
				},
			} as never);

			expect(ctx.addMessageToChat).toHaveBeenCalledTimes(1);
			expect(recordVisibleTranscriptMutation).not.toHaveBeenCalled();
		});

		it("does not revise an empty assistant mount until visible content arrives", async () => {
			await Settings.init({ inMemory: true });
			const handle: ToolExecutionHandle = {
				updateArgs: vi.fn(),
				updateResult: vi.fn(),
				setArgsComplete: vi.fn(),
				setExpanded: vi.fn(),
			};
			const { ctx, recordVisibleTranscriptMutation } = createContext(handle);
			const controller = new EventController(ctx);
			const empty = assistantMessage("");
			const visible = assistantMessage("visible text");

			await controller.handleEvent({ type: "message_start", message: empty } as never);
			expect(recordVisibleTranscriptMutation).not.toHaveBeenCalled();
			await controller.handleEvent({ type: "message_update", message: visible } as never);
			expect(recordVisibleTranscriptMutation).toHaveBeenCalledTimes(1);
		});
	});

	it("records a message_update read group once after message_start when args are duplicated", async () => {
		const handle: ToolExecutionHandle = {
			updateArgs: vi.fn(),
			updateResult: vi.fn(),
			setArgsComplete: vi.fn(),
			setExpanded: vi.fn(),
		};
		const { ctx, recordVisibleTranscriptMutation } = createContext(handle);
		await Settings.init({ inMemory: true });
		ctx.pendingTools = new Map();
		const message = assistantMessage("");
		message.content = [
			{
				type: "toolCall",
				id: "read-message-update",
				name: "read",
				arguments: { path: "/tmp/example.ts" },
			},
		] as never;
		const controller = new EventController(ctx);

		await controller.handleEvent({ type: "message_start", message } as never);
		recordVisibleTranscriptMutation.mockClear();
		await controller.handleEvent({ type: "message_update", message } as never);
		expect(recordVisibleTranscriptMutation).toHaveBeenCalledTimes(1);
		recordVisibleTranscriptMutation.mockClear();

		await controller.handleEvent({ type: "message_update", message } as never);
		expect(recordVisibleTranscriptMutation).not.toHaveBeenCalled();
	});
});

function assistantMessage(text: string): AssistantMessage {
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
		stopReason: "stop",
		timestamp: Date.now(),
	};
}

describe("completion visible revisions", () => {
	it("consumes each completed tool projection once when it changed", async () => {
		const handle: ToolExecutionHandle = {
			updateArgs: vi.fn(),
			updateResult: vi.fn(),
			setArgsComplete: vi.fn(),
			setExpanded: vi.fn(),
			consumeVisibleTranscriptChange: vi.fn(() => true),
		};
		const { ctx, recordVisibleTranscriptMutation } = createContext(handle);
		const message = assistantMessage("done");
		ctx.streamingMessage = message;
		ctx.streamingComponent = { updateContent: vi.fn(), setUsageInfo: vi.fn() } as never;
		const controller = new EventController(ctx);

		await controller.handleEvent({ type: "message_end", message } as never);

		expect(handle.setArgsComplete).toHaveBeenCalledWith("tool-1");
		expect(handle.consumeVisibleTranscriptChange).toHaveBeenCalledTimes(1);
		expect(recordVisibleTranscriptMutation).toHaveBeenCalledTimes(1);
	});

	it("does not revise completion for an unchanged tool projection", async () => {
		const handle: ToolExecutionHandle = {
			updateArgs: vi.fn(),
			updateResult: vi.fn(),
			setArgsComplete: vi.fn(),
			setExpanded: vi.fn(),
			consumeVisibleTranscriptChange: vi.fn(() => false),
		};
		const { ctx, recordVisibleTranscriptMutation } = createContext(handle);
		const message = assistantMessage("done");
		ctx.streamingMessage = message;
		ctx.streamingComponent = { updateContent: vi.fn(), setUsageInfo: vi.fn() } as never;
		const controller = new EventController(ctx);

		await controller.handleEvent({ type: "message_end", message } as never);

		expect(handle.setArgsComplete).toHaveBeenCalledWith("tool-1");
		expect(handle.consumeVisibleTranscriptChange).toHaveBeenCalledTimes(1);
		expect(recordVisibleTranscriptMutation).not.toHaveBeenCalled();
	});

	it("reports final Markdown semantics for the same source when usage is hidden", async () => {
		await Settings.init({ inMemory: true });
		const message = assistantMessage("same markdown source");
		const onVisibleMutation = vi.fn();
		const component = new AssistantMessageComponent(message, false, undefined, undefined, onVisibleMutation);

		component.updateContent(message, { streaming: true });
		onVisibleMutation.mockClear();
		component.updateContent(message, { streaming: false });

		expect(onVisibleMutation).toHaveBeenCalledTimes(1);
	});
});
