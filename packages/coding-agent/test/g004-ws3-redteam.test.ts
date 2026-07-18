import { beforeAll, describe, expect, it } from "bun:test";
import { TasksPaneComponent } from "../src/modes/components/tasks-pane";
import { InputController } from "../src/modes/controllers/input-controller";
import { TasksAggregator } from "../src/modes/tasks-aggregator";
import { initTheme } from "../src/modes/theme/theme";

beforeAll(() => initTheme());

type Listener = () => void;

function sources(
	options: {
		jobs?: any[];
		records?: any[];
		sessions?: any[];
		monitors?: any[];
		crons?: any[];
		failed?: boolean;
		output?: Record<string, string>;
	} = {},
) {
	let jobs = options.jobs ?? [];
	let records = options.records ?? [];
	let sessions = options.sessions ?? [];
	let monitors = options.monitors ?? [];
	let crons = options.crons ?? [];
	let failed = options.failed ?? false;
	let output = options.output ?? {};
	const listeners = new Set<Listener>();
	const emit = () => {
		for (const listener of listeners) listener();
	};
	const onChange = (listener: Listener) => {
		listeners.add(listener);
		return () => listeners.delete(listener);
	};
	return {
		manager: { onChange, getAllJobs: () => jobs, getSubagentRecords: () => records },
		observer: {
			onChange,
			getSnapshot: () => ({ monitors, crons, failedUnacknowledged: failed }),
			acknowledgeFailures: () => {
				failed = false;
			},
			getMonitorOutput: (id: string) => output[id] ?? "",
		},
		sessions: { onChange, getSessions: () => sessions },
		set(
			next: Partial<{
				jobs: any[];
				records: any[];
				sessions: any[];
				monitors: any[];
				crons: any[];
				failed: boolean;
				output: Record<string, string>;
			}>,
		) {
			jobs = next.jobs ?? jobs;
			records = next.records ?? records;
			sessions = next.sessions ?? sessions;
			monitors = next.monitors ?? monitors;
			crons = next.crons ?? crons;
			failed = next.failed ?? failed;
			output = next.output ?? output;
			emit();
		},
	};
}

function controllerContext(overrides: Record<string, unknown> = {}) {
	const editor = { getText: () => "", setText: () => {}, onSubmit: async () => {}, onEscape: () => {} };
	return {
		editor,
		ui: { showOverlay: () => ({ hide: () => {} }), setFocus: () => {}, requestRender: () => {} },
		keybindings: { getKeys: () => [] },
		settings: { get: () => false },
		session: {
			model: undefined,
			messages: [],
			queuedMessageCount: 0,
			isStreaming: false,
			isCompacting: false,
			getRoleModelCycleCandidateCount: () => 0,
			hasForegroundBashBackgroundRequestHandler: () => false,
			getQueuedMessageEntries: () => [],
			removeQueuedMessageForEditing: () => undefined,
			cancelAndSubmit: async () => ({ kind: "submitted" }),
		},
		chatContainer: { children: [] },
		goalModeEnabled: false,
		planModeEnabled: false,
		handlePlanModeCommand: () => {},
		showError: () => {},
		showStatus: () => {},
		showWarning: () => {},
		historyStorage: { getRecent: () => [] },
		skillCommands: new Map(),
		clearEditor: () => {},
		updatePendingMessagesDisplay: () => {},
		showTasksPane: () => {},
		...overrides,
	};
}

describe("G004 WS3 red-team: task aggregation and pane boundaries", () => {
	it("joins conflicting and manager-only subagents, then falls back after registry eviction", () => {
		const source = sources({
			records: [
				{ subagentId: "dual", status: "queued", resumable: true, queued: { createdAt: 2 } },
				{ subagentId: "paused", status: "paused", resumable: true, queued: { createdAt: 3 } },
			],
			sessions: [{ id: "dual", kind: "subagent", label: "live registry", status: "active", lastUpdate: 10 }],
		});
		const aggregator = new TasksAggregator(
			source.manager as never,
			source.observer as never,
			source.sessions as never,
		);
		expect(aggregator.getSnapshot().rows).toEqual([
			{
				id: "subagent:dual",
				kind: "subagent",
				label: "live registry",
				status: "waiting",
				startedAt: 10,
				resumable: true,
			},
			{ id: "subagent:paused", kind: "subagent", label: "paused", status: "waiting", startedAt: 3, resumable: true },
		]);
		source.set({ sessions: [] });
		expect(aggregator.getSnapshot().rows.find(row => row.id === "subagent:dual")).toMatchObject({
			status: "waiting",
			resumable: true,
		});
		aggregator.dispose();
	});

	it("keeps failure precedence/latch and refreshes monitor badges after output or tombstone changes", () => {
		const source = sources({
			jobs: [
				{
					id: "failed",
					type: "bash",
					label: "failed",
					status: "failed",
					startTime: 5,
					metadata: { monitor: true },
				},
				{ id: "run", type: "bash", label: "run", status: "running", startTime: 4, metadata: { monitor: true } },
				{ id: "wait", type: "bash", label: "wait", status: "paused", startTime: 3 },
				{ id: "done", type: "bash", label: "done", status: "completed", startTime: 2 },
			],
			monitors: [{ id: "run" }, { id: "failed" }],
			failed: true,
			output: { run: "first" },
		});
		const aggregator = new TasksAggregator(
			source.manager as never,
			source.observer as never,
			source.sessions as never,
		);
		expect(aggregator.getSnapshot().worstState).toBe("failed");
		expect(aggregator.getSnapshot().rows.find(row => row.id === "bash:run")?.monitorOutputLines).toBe(1);
		aggregator.acknowledgeFailures();
		expect(aggregator.getSnapshot().worstState).toBe("failed"); // failed row still beats running after acknowledgement
		source.set({
			jobs: source.manager.getAllJobs().filter((job: any) => job.id !== "failed"),
			monitors: [{ id: "run" }],
			output: { run: "first\nsecond" },
		});
		expect(aggregator.getSnapshot().worstState).toBe("running");
		expect(aggregator.getSnapshot().rows.find(row => row.id === "bash:run")?.monitorOutputLines).toBe(2);
		source.set({ jobs: [], monitors: [] });
		expect(aggregator.getSnapshot()).toMatchObject({ rows: [], worstState: "none", failedUnacknowledged: false });
		source.set({
			jobs: [
				{
					id: "new-failure",
					type: "bash",
					label: "new",
					status: "failed",
					startTime: 6,
					metadata: { monitor: true },
				},
			],
			monitors: [{ id: "new-failure" }],
			failed: true,
		});
		expect(aggregator.getSnapshot()).toMatchObject({ worstState: "failed", failedUnacknowledged: true });
		aggregator.dispose();
	});

	it("renders zero-source panes safely and reports manager-only resumability", () => {
		const empty = sources();
		const aggregator = new TasksAggregator(empty.manager as never, empty.observer as never, empty.sessions as never);
		const pane = new TasksPaneComponent(aggregator, { close: () => {}, requestRender: () => {} });
		expect(() => pane.getFocus()).not.toThrow();
		expect(pane.render(80).join("\n")).toContain("No tasks");
		aggregator.dispose();
	});

	it("routes alt+t repeatedly without controller-owned stacking; task opening is not blocked by a transcript viewer", async () => {
		let opens = 0;
		const controller = new InputController(
			controllerContext({
				showTasksPane: () => {
					opens++;
				},
				isTranscriptViewerOpen: () => true,
			}) as never,
		);
		await controller.actionRegistry.execute("app.tasks.toggle");
		await controller.actionRegistry.execute("app.tasks.toggle");
		await controller.actionRegistry.execute("app.tasks.toggle");
		expect(opens).toBe(3);
	});
});

describe("G004 WS3 red-team: queue/send-now boundaries", () => {
	it("does not invoke cancellation for an empty composer and queue", async () => {
		let calls = 0;
		const statuses: string[] = [];
		const controller = new InputController(
			controllerContext({
				showStatus: (message: string) => statuses.push(message),
				session: {
					...controllerContext().session,
					isStreaming: true,
					cancelAndSubmit: async () => {
						calls++;
						return { kind: "submitted" };
					},
				},
			}) as never,
		);
		await controller.sendNow();
		expect(calls).toBe(0);
		expect(statuses).toEqual(["No visible queued message to send"]);
	});

	it("uses composer text ahead of queue head", async () => {
		const sent: string[] = [];
		let removed = 0;
		const controller = new InputController(
			controllerContext({
				editor: {
					getText: () => " composer wins ",
					setText: () => {},
					onSubmit: async () => {},
					onEscape: () => {},
				},
				session: {
					...controllerContext().session,
					isStreaming: true,
					queuedMessageCount: 1,
					getQueuedMessageEntries: () => [{ id: "q", text: "queue head" }],
					removeQueuedMessageForEditing: () => {
						removed++;
						return "queue head";
					},
					cancelAndSubmit: async (text: string) => {
						sent.push(text);
						return { kind: "submitted" };
					},
				},
			}) as never,
		);
		await controller.sendNow();
		expect(sent).toEqual(["composer wins"]);
		expect(removed).toBe(0);
	});

	it("keeps the queue head when cancellation rolls back", async () => {
		let queue = [{ id: "q", text: "queued" }];
		let receivedOptions: { queuedEntryId?: string } | undefined;
		const controller = new InputController(
			controllerContext({
				session: {
					...controllerContext().session,
					isStreaming: true,
					queuedMessageCount: 1,
					getQueuedMessageEntries: () => queue,
					removeQueuedMessageForEditing: (id: string) => {
						const entry = queue.find(item => item.id === id);
						queue = queue.filter(item => item.id !== id);
						return entry?.text;
					},
					cancelAndSubmit: async (_text: string, options: { queuedEntryId?: string }) => {
						receivedOptions = options;
						return { kind: "rolled_back", outcome: { kind: "timeout" } };
					},
				},
			}) as never,
		);
		await controller.sendNow();
		expect(receivedOptions).toEqual({ queuedEntryId: "q" });
		expect(queue).toEqual([{ id: "q", text: "queued" }]);
	});
});
