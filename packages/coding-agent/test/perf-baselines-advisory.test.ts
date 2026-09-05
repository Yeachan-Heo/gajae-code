// Advisory perf baselines: recording only; hard gating deferred to perf-gates.test.ts.
import { afterEach, beforeAll, describe, expect, it, mock, spyOn } from "bun:test";
import * as fsSync from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { installExactIdentityNatives } from "./helpers/exact-identity-natives";

const originalStateFileEnv = process.env.GJC_COORDINATOR_SESSION_STATE_FILE;
const originalSessionIdEnv = process.env.GJC_COORDINATOR_SESSION_ID;

let getProjectDir: typeof import("@gajae-code/utils").getProjectDir;
let setProjectDir: typeof import("@gajae-code/utils").setProjectDir;
let originalProjectDir: string;
let StatusLineComponent: typeof import("../src/modes/components/tool-status-header").StatusLineComponent;
let gitUtils: typeof import("../src/modes/components/status-line/git-utils");
let ToolExecutionComponent: typeof import("../src/modes/components/tool-execution").ToolExecutionComponent;
let EventController: typeof import("../src/modes/controllers/event-controller").EventController;
let eventControllerPerfCounters: typeof import("../src/modes/controllers/event-controller").__eventControllerPerfCounters;
let persistCoordinatorRuntimeStateFromEvent: typeof import("../src/gjc-runtime/session-state-sidecar").persistCoordinatorRuntimeStateFromEvent;

beforeAll(async () => {
	const utils = await import("@gajae-code/utils");
	getProjectDir = utils.getProjectDir;
	setProjectDir = utils.setProjectDir;
	originalProjectDir = getProjectDir();
	const { Settings } = await import("../src/config/settings");
	await Settings.init({ inMemory: true, cwd: os.tmpdir() });
	({ StatusLineComponent } = await import("../src/modes/components/tool-status-header"));
	gitUtils = await import("../src/modes/components/status-line/git-utils");
	({ ToolExecutionComponent } = await import("../src/modes/components/tool-execution"));
	({ EventController, __eventControllerPerfCounters: eventControllerPerfCounters } = await import(
		"../src/modes/controllers/event-controller"
	));
	({ persistCoordinatorRuntimeStateFromEvent } = await import("../src/gjc-runtime/session-state-sidecar"));
	// Coordinator state writes serialize on a lock whose removals go through identity-bound
	// native primitives; point them at a working implementation.
	installExactIdentityNatives();
	const { initTheme } = await import("../src/modes/theme/theme");
	await initTheme();
});

afterEach(() => {
	if (setProjectDir && originalProjectDir) setProjectDir(originalProjectDir);
	if (originalStateFileEnv === undefined) delete process.env.GJC_COORDINATOR_SESSION_STATE_FILE;
	else process.env.GJC_COORDINATOR_SESSION_STATE_FILE = originalStateFileEnv;
	if (originalSessionIdEnv === undefined) delete process.env.GJC_COORDINATOR_SESSION_ID;
	else process.env.GJC_COORDINATOR_SESSION_ID = originalSessionIdEnv;
	mock.restore();
	eventControllerPerfCounters?.reset();
});

function logBaseline(name: string, data: Record<string, unknown>): void {
	console.log(`[perf-baseline] ${name} ${JSON.stringify(data)}`);
}

function expectFiniteNonNegative(value: number): void {
	expect(Number.isFinite(value)).toBe(true);
	expect(value).toBeGreaterThanOrEqual(0);
}

function expectPositiveFinite(value: number): void {
	expect(Number.isFinite(value)).toBe(true);
	expect(value).toBeGreaterThan(0);
}

async function withEventControllerPerfCounters(run: () => Promise<void>): Promise<void> {
	const countersWereEnabled = eventControllerPerfCounters.enabled;
	eventControllerPerfCounters.enable();
	eventControllerPerfCounters.reset();
	try {
		await run();
	} finally {
		eventControllerPerfCounters.reset();
		if (countersWereEnabled) eventControllerPerfCounters.enable();
		else eventControllerPerfCounters.disable();
	}
}

function createStatusSession() {
	return {
		state: { messages: [], model: { contextWindow: 200_000 } },
		systemPrompt: [],
		agent: { state: { tools: [] } },
		skills: [],
		model: { id: "mock", contextWindow: 200_000 },
		isFastModeEnabled: () => false,
		modelRegistry: { isUsingOAuth: () => false },
		sessionManager: {
			getUsageStatistics: () => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, premiumRequests: 0, cost: 0 }),
			getSessionName: () => "perf-baseline",
		},
		getAsyncJobSnapshot: () => ({ running: [], completed: [] }),
	};
}

function largeDiff(repetitions: number): string {
	return Array.from({ length: repetitions }, (_, index) => `-old line ${index}\n+new line ${index}`).join("\n");
}

describe("advisory performance baselines", () => {
	it("records real assistant projection and terminal commits across text workloads", async () => {
		const { Container, Editor, TUI } = await import("@gajae-code/tui");
		const { renderMetrics } = await import("../../tui/src/metrics");
		const { VirtualTerminal } = await import("../../tui/test/virtual-terminal");
		const { defaultEditorTheme } = await import("../../tui/test/test-themes");
		const { AssistantMessageComponent } = await import("../src/modes/components/assistant-message");
		type AssistantMessage = import("@gajae-code/ai").AssistantMessage;
		type Event = Parameters<InstanceType<typeof EventController>["handleEvent"]>[0];
		const distribution = (samples: number[]) => {
			const sorted = [...samples].sort((a, b) => a - b);
			return {
				count: samples.length,
				totalMs: samples.reduce((sum, value) => sum + value, 0),
				p50Ms: sorted[Math.floor((sorted.length - 1) * 0.5)] ?? null,
				p95Ms: sorted[Math.ceil((sorted.length - 1) * 0.95)] ?? null,
			};
		};
		const metricsWereEnabled = renderMetrics.enabled;
		renderMetrics.enable();
		try {
			await withEventControllerPerfCounters(async () => {
				// 24 cells, each with one discarded warmup and five recorded repetitions.
				// Two bursts separated by a real commit exercise a pause without a streaming timer.
				for (const size of ["short", "long"] as const) {
					for (const deltas of [1, 10, 100]) {
						for (const identity of ["mutable", "replacement"] as const) {
							for (const mixed of [false, true]) {
								let expectedFinal: string[] | undefined;
								for (let repetition = -1; repetition < 5; repetition++) {
									const term = new VirtualTerminal(100, 32);
									const ui = new TUI(term);
									const chatContainer = new Container();
									const editor = new Editor(defaultEditorTheme);
									ui.addChild(chatContainer);
									ui.addChild(editor);
									ui.setFocus(editor);
									let revision = 0n;
									let semanticPasses = 0;
									const ctx = {
										isInitialized: true,
										init: async () => {},
										ui,
										chatContainer,
										editor,
										statusLine: { invalidate: () => {} },
										updateEditorTopBorder: () => {
											semanticPasses++;
										},
										pendingTools: new Map(),
										session: { getToolByName: () => undefined, retryAttempt: 0 },
										sessionManager: { getCwd: () => os.tmpdir() },
										settings: { get: () => false },
										hideThinkingBlock: false,
										toolOutputExpanded: false,
										setWorkingMessage: () => {},
										getAssistantViewportAnchorId: () => "perf-assistant",
										recordVisibleTranscriptMutation: () => {
											ui.setViewportOutputSource({ identity: "perf-session", revision: ++revision });
										},
									} as any;
									const controller = new EventController(ctx);
									const projections: Array<{ streaming: boolean; ms: number }> = [];
									const realUpdate = AssistantMessageComponent.prototype.updateContent;
									const projectionSpy = spyOn(
										AssistantMessageComponent.prototype,
										"updateContent",
									).mockImplementation(function (
										this: InstanceType<typeof AssistantMessageComponent>,
										message,
										options,
									) {
										const started = performance.now();
										try {
											return realUpdate.call(this, message, options);
										} finally {
											projections.push({
												streaming: options?.streaming ?? false,
												ms: performance.now() - started,
											});
										}
									});
									const controllerMs: number[] = [];
									const eventToCommitMs: number[] = [];
									const inputToCommitMs: number[] = [];
									const commits: Array<{ generation: number; writes: number; bytes: number }> = [];
									const submitted: Record<string, number> = {};
									const dispatch = async (event: Event) => {
										const started = performance.now();
										submitted[event.type] = (submitted[event.type] ?? 0) + 1;
										await controller.handleEvent(event);
										controllerMs.push(performance.now() - started);
									};
									const commit = async () => {
										const generation = ui.requestRenderWithGeneration(false, "perf.assistant.commit");
										expect(await ui.waitForRenderCommit(generation, 2_000)).toBe(true);
										const committedAt = performance.now();
										await term.flush();
										const writes = term.getWriteLog();
										commits.push({
											generation,
											writes: writes.length,
											bytes: writes.reduce((sum, text) => sum + Buffer.byteLength(text), 0),
										});
										term.clearWriteLog();
										return committedAt;
									};
									let message: AssistantMessage = {
										role: "assistant",
										api: "anthropic-messages",
										provider: "anthropic",
										model: "perf-fixture",
										timestamp: 1,
										stopReason: "stop",
										usage: {
											input: 0,
											output: 0,
											cacheRead: 0,
											cacheWrite: 0,
											totalTokens: 0,
											cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
										},
										content: [{ type: "text", text: "## Projection baseline\n\n" }],
									};
									const update = async (type: string, contentIndex: number, delta: string) => {
										await dispatch({
											type: "message_update",
											message,
											assistantMessageEvent: { type, contentIndex, delta, partial: message },
										} as Event);
										expect(ctx.streamingMessage).toBe(message);
									};
									try {
										ui.start();
										await commit();
										commits.length = 0;
										renderMetrics.reset();
										eventControllerPerfCounters.reset();
										await dispatch({ type: "message_start", message } as Event);
										const assistant = ctx.streamingComponent as InstanceType<
											typeof AssistantMessageComponent
										>;
										await commit();
										for (let burst = 0; burst < 2; burst++) {
											const eventStarts: number[] = [];
											for (let delta = 0; delta < deltas; delta++) {
												if (identity === "replacement")
													message = { ...message, content: message.content.map(block => ({ ...block })) };
												const text = message.content[0];
												if (text.type !== "text") throw new Error("fixture lost text block");
												const chunk =
													size === "short"
														? `word${burst}_${delta} `
														: `\n- **item ${burst}_${delta}**: ${"growing Markdown content ".repeat(12)}\n`;
												text.text += chunk;
												eventStarts.push(performance.now());
												await update("text_delta", 0, chunk);
											}
											let inputStarted: number | undefined;
											if (mixed) {
												message.content[1] = { type: "thinking", thinking: `Thinking boundary ${burst}` };
												await update("thinking_delta", 1, `Thinking boundary ${burst}`);
												message.content[2] = {
													type: "toolCall",
													id: "perf-tool",
													name: "bash",
													arguments: { command: `echo boundary${burst}` },
												};
												await update("toolcall_delta", 2, `boundary${burst}`);
												inputStarted = performance.now();
												term.sendInput(burst === 0 ? "Q" : "X");
											}
											const committedAt = await commit();
											for (const started of eventStarts) eventToCommitMs.push(committedAt - started);
											if (inputStarted !== undefined) {
												inputToCommitMs.push(committedAt - inputStarted);
												expect(term.getViewport().join("\n")).toContain(burst === 0 ? "Q" : "QX");
											}
										}
										message = {
											...message,
											content: [...message.content, { type: "text", text: "\n\nFINAL-ANCHOR\n" }],
										};
										await dispatch({ type: "message_end", message } as Event);
										await commit();
										const metrics = renderMetrics.snapshot();
										const finalOutput = assistant.render(100);
										expect(finalOutput.join("\n")).toContain("FINAL-ANCHOR");
										expect(term.getViewport().join("\n")).toContain("FINAL-ANCHOR");
										expect(ctx.streamingMessage).toBeUndefined();
										expect(ctx.streamingComponent).toBeUndefined();
										expect(editor.getText()).toBe(mixed ? "QX" : "");
										expect(eventControllerPerfCounters.messageUpdateContentVisits).toBe(
											2 * deltas + (mixed ? 4 : 0),
										);
										expect(semanticPasses).toBe(controllerMs.length + 1); // message_end also refreshes the border.
										expect(revision > 0n).toBe(true);
										expect(projections.length).toBeGreaterThanOrEqual(2);
										if (expectedFinal) expect(finalOutput).toEqual(expectedFinal);
										else expectedFinal = finalOutput;
										if (repetition >= 0)
											logBaseline("assistant.real-text-frame", {
												size,
												deltasPerBurst: deltas,
												bursts: 2,
												identity,
												mixed,
												repetition,
												warmups: 1,
												repetitions: 5,
												width: 100,
												rows: 32,
												bun: Bun.version,
												platform: process.platform,
												arch: process.arch,
												semantic: {
													submitted,
													borderPasses: semanticPasses,
													contentVisits: eventControllerPerfCounters.messageUpdateContentVisits,
													visibleRevisions: String(revision),
												},
												projection: {
													...distribution(projections.map(sample => sample.ms)),
													streamingCalls: projections.filter(sample => sample.streaming).length,
												},
												controller: distribution(controllerMs),
												eventToObservedCommit: distribution(eventToCommitMs),
												inputToObservedCommit: distribution(inputToCommitMs),
												commits,
												render: metrics,
												finalOutput,
												preparationCount: {
													available: false,
													reason: "No cross-revision public preparation metric",
												},
												lexerCount: { available: false, reason: "No lexer instrumentation installed" },
												latencyScope:
													"Generation waiter observation, not exact first-write timestamp; includes controller completion and mixed boundaries",
											});
									} finally {
										controller.dispose();
										ui.stop();
										ui.dispose();
										projectionSpy.mockRestore();
									}
								}
							}
						}
					}
				}
			});
		} finally {
			renderMetrics.reset();
			if (!metricsWereEnabled) renderMetrics.disable();
		}
	}, 120_000);

	it("records status-line branch resolver calls across simulated renders", () => {
		const renders = 12;
		setProjectDir(os.tmpdir());
		const branchSpy = spyOn(gitUtils, "resolveCurrentBranch").mockImplementation(cwd => ({
			branch: "baseline",
			repoId: cwd,
		}));

		const statusLine = new StatusLineComponent(createStatusSession() as any);
		statusLine.updateSettings({
			preset: "custom",
			leftSegments: ["git"],
			rightSegments: [],
			showSkillHud: false,
			showHookStatus: false,
			segmentOptions: { git: { showBranch: true, showStaged: false, showUnstaged: false, showUntracked: false } },
		});

		for (let i = 0; i < renders; i++) statusLine.render(120);

		const count = branchSpy.mock.calls.length;
		logBaseline("status-line.branch-resolver", { renders, resolveCurrentBranchCalls: count });
		expectPositiveFinite(count);
	});

	it("keeps custom tool renderers on conservative cloned args", () => {
		const sourceArgs = { nested: { value: "original" } };
		const received: unknown[] = [];
		const customTool = {
			renderCall: (args: any) => {
				received.push(args);
				args.nested.value = "mutated-by-renderer";
				return { render: () => [] } as any;
			},
		};
		new ToolExecutionComponent(
			"custom_tool",
			sourceArgs,
			{},
			customTool as any,
			{ requestRender: () => {} } as any,
			os.tmpdir(),
		);
		expect(received.length).toBeGreaterThan(0);
		expect(received[0]).not.toBe(sourceArgs);
		expect(sourceArgs.nested.value).toBe("original");
	});

	it("records event-controller full content scan counts for streamed tool updates", async () => {
		await withEventControllerPerfCounters(async () => {
			const toolCallCount = 9;
			const updates = 10;
			let updateArgsCalls = 0;
			const pendingTools = new Map<string, { updateArgs: () => void }>();
			for (let i = 0; i < toolCallCount; i++)
				pendingTools.set(`call_${i}`, {
					updateArgs: () => {
						updateArgsCalls += 1;
					},
				});
			const ctx = {
				isInitialized: true,
				init: async () => {},
				streamingComponent: { updateContent: () => {} },
				statusLine: { invalidate: () => {} },
				updateEditorTopBorder: () => {},
				pendingTools,
				session: { getToolByName: () => undefined },
				ui: { requestRender: () => {} },
				chatContainer: { addChild: () => {} },
				settings: { get: () => false },
				sessionManager: { getCwd: () => os.tmpdir() },
				toolOutputExpanded: false,
				setWorkingMessage: () => {},
			} as any;
			const controller = new EventController(ctx);
			eventControllerPerfCounters.reset();
			for (let i = 0; i < updates; i++) {
				await controller.handleEvent({
					type: "message_update",
					message: {
						role: "assistant",
						content: Array.from({ length: toolCallCount }, (_, index) => ({
							type: "toolCall",
							id: `call_${index}`,
							name: "edit",
							arguments: { path: "sample.txt", diff: largeDiff(i + index + 1) },
						})),
					},
				} as any);
			}
			const fullContentScanVisits = eventControllerPerfCounters.messageUpdateContentVisits;
			logBaseline("event-controller.message-update-full-scan", {
				updates,
				toolCallCount,
				fullContentScanVisits,
				updateArgsCalls,
			});
			expectFiniteNonNegative(fullContentScanVisits);
			expectPositiveFinite(updateArgsCalls);
		});
	});

	it("uses contentIndex metadata to avoid full content rescans during streamed tool updates", async () => {
		await withEventControllerPerfCounters(async () => {
			const toolCallCount = 9;
			const updates = 10;
			let updateArgsCalls = 0;
			const pendingTools = new Map<string, { updateArgs: () => void }>();
			for (let i = 0; i < toolCallCount; i++)
				pendingTools.set(`call_${i}`, {
					updateArgs: () => {
						updateArgsCalls += 1;
					},
				});
			const content = Array.from({ length: toolCallCount }, (_, index) => ({
				type: "toolCall",
				id: `call_${index}`,
				name: "edit",
				arguments: { path: "sample.txt", diff: "" },
			}));
			const ctx = {
				isInitialized: true,
				init: async () => {},
				streamingComponent: { updateContent: () => {} },
				statusLine: { invalidate: () => {} },
				updateEditorTopBorder: () => {},
				pendingTools,
				session: { getToolByName: () => undefined },
				ui: { requestRender: () => {} },
				chatContainer: { addChild: () => {} },
				settings: { get: () => false },
				sessionManager: { getCwd: () => os.tmpdir() },
				toolOutputExpanded: false,
				setWorkingMessage: () => {},
			} as any;
			const controller = new EventController(ctx);
			eventControllerPerfCounters.reset();
			for (let i = 0; i < updates; i++) {
				content[4].arguments = { path: "sample.txt", diff: largeDiff(i + 1) };
				await controller.handleEvent({
					type: "message_update",
					message: { role: "assistant", content },
					assistantMessageEvent: {
						type: "toolcall_delta",
						contentIndex: 4,
						delta: "x",
						partial: { role: "assistant", content },
					},
				} as any);
			}
			expect(eventControllerPerfCounters.messageUpdateContentVisits).toBe(updates);
			expect(updateArgsCalls).toBe(updates);
		});
	});

	it("records sidecar sync readFileSync invocations per state-mapped event", async () => {
		const tempDir = fsSync.mkdtempSync(path.join(os.tmpdir(), "gjc-perf-sidecar-"));
		const stateFile = path.join(tempDir, "runtime-state.json");
		process.env.GJC_COORDINATOR_SESSION_STATE_FILE = stateFile;
		process.env.GJC_COORDINATOR_SESSION_ID = "session-sidecar-baseline";
		const realReadFileSync = fsSync.readFileSync;
		let readFileSyncCalls = 0;
		spyOn(fsSync, "readFileSync").mockImplementation(((...args: Parameters<typeof fsSync.readFileSync>) => {
			readFileSyncCalls += 1;
			return realReadFileSync(...args);
		}) as typeof fsSync.readFileSync);

		try {
			const events = [
				{ type: "agent_start" },
				{ type: "turn_start" },
				{
					type: "agent_end",
					messages: [{ role: "assistant", content: [{ type: "text", text: "done" }], stopReason: "stop" }],
				},
			];
			for (const event of events)
				await persistCoordinatorRuntimeStateFromEvent(event, {
					sessionId: "session-sidecar-baseline",
					cwd: tempDir,
					sessionFile: path.join(tempDir, "session.json"),
				});
			logBaseline("sidecar.state-mapped-events", { events: events.length, readFileSyncCalls });
			// Value may legitimately drop to 0 when the corresponding REPORT.md fix lands.
			expectFiniteNonNegative(readFileSyncCalls);
		} finally {
			fsSync.rmSync(tempDir, { recursive: true, force: true });
		}
	});
});
