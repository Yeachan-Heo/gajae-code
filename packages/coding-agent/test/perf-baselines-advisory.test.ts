// Advisory perf baselines: recording only; hard gating deferred to perf-gates.test.ts.
import { afterEach, beforeAll, describe, expect, it, mock, spyOn } from "bun:test";
import * as fsSync from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

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
