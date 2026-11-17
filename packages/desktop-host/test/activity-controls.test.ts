import { afterEach, describe, expect, test, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { AuthStorage, getBundledModel } from "@gajae-code/ai";
import {
	ActivityControlError,
	ActivityControls,
	approvalGate,
	type CreateAgentSessionResult,
	createAgentSession,
	discoverAuthStorage,
	executionGate,
	JobObservationError,
	type JobObservationSnapshot,
	type JobObservationTarget,
	questionToGate,
	Settings,
	type WorkflowGateEmitter,
} from "@gajae-code/coding-agent/sdk";
import {
	createDesktopActivityController,
	DESKTOP_ACTIVITY_LIMITS,
	type DesktopActivityController,
} from "../src/activity-controls";
import type {
	DesktopActivityAcknowledgement,
	DesktopActivityRef,
	DesktopActivitySnapshot,
} from "../src/activity-protocol";

const controllers: DesktopActivityController[] = [];
const cleanups: Array<() => Promise<void>> = [];

/** A deterministic public observation contract, consumed by the real SDK ActivityControls. */
async function fixture(redact: (text: string) => string = text => text, available = true) {
	// ActivityControls captures credential storage as well as the owner-scoped observation.
	// Use genuine storage so SDK redaction runs before its own display-field caps.
	const authStorage = await AuthStorage.create(":memory:");
	await authStorage.set("activity-fixture", { type: "api_key", key: "secret" });
	cleanups.push(async () => {
		authStorage.close();
	});
	const state: JobObservationSnapshot = {
		failureRevision: "failure-1",
		unsettledJobs: [],
		unsettledCrons: [],
		jobs: [
			{
				id: "private-monitor-id",
				generation: "job-1",
				kind: "bash",
				label: "monitor secret",
				status: "running",
				backgrounded: false,
				deliveryState: "pending",
			},
		],
		monitors: [
			{ id: "private-monitor-id", generation: "job-1", label: "monitor secret", status: "running", startTime: 0 },
		],
		tasks: [
			{
				id: "task-a",
				target: { id: "task-a", generation: "task-1" },
				capabilities: { cancel: true, pause: true, resume: false },
				status: "running",
				currentJobId: null,
				requestedModel: "requested secret",
				effectiveModel: "effective secret",
			},
		],
		crons: [
			{
				id: "private-cron-id",
				createdAt: 1,
				humanSchedule: "every minute secret",
				cronExpression: "* * * * *",
				prompt: "private prompt",
				recurring: true,
				firing: true,
				nextFireAt: 12,
			},
		],
		activeMonitorCount: 1,
		activeCronCount: 1,
		worstState: "running",
		failedUnacknowledged: false,
	};
	const listeners = new Set<() => void>();
	const observationListeners = new Set<() => void>();
	const lifecycle = { generation: 0, transitioning: false, disposed: false };
	const manager = { getSessionId: () => "logical-session" };
	const session = {
		sessionLifecycle: lifecycle,
		sessionId: "provider-session",
		sessionManager: manager,
		modelRegistry: { authStorage },
		getAgentId: () => "factory-owner",
		getGoalModeState: () => undefined,
		getEffectiveActiveWorkflowSkillState: () => undefined,
		getWorkflowGateEmitter: (): WorkflowGateEmitter | undefined => undefined,
		subscribe(listener: () => void) {
			listeners.add(listener);
			return () => {
				listeners.delete(listener);
			};
		},
	};
	const observation = {
		getSnapshot: vi.fn(() => structuredClone(state)),
		getMonitorOutput: vi.fn(() => "output secret"),
		cancelMonitor: vi.fn((target: JobObservationTarget) => {
			if (state.foldedJobs?.some(row => row.id === target.id && row.generation === target.generation))
				throw new JobObservationError("read_only");
			return true;
		}),
		cancelTask: vi.fn(),
		pauseTask: vi.fn(() => ({ status: "paused" as const })),
		resumeTask: vi.fn(() => ({ status: "running" as const, queued: false })),
		deleteCron: vi.fn(),
		acknowledgeFailures: vi.fn((revision: string) => {
			if (revision !== state.failureRevision) throw new JobObservationError("stale_generation");
			state.failedUnacknowledged = false;
		}),
		onChange(listener: () => void) {
			observationListeners.add(listener);
			return () => {
				observationListeners.delete(listener);
			};
		},
		dispose: vi.fn(),
	};
	const result: Pick<CreateAgentSessionResult, "session" | "jobObservation"> = {
		session: session as unknown as CreateAgentSessionResult["session"],
		jobObservation: available
			? (observation as unknown as NonNullable<CreateAgentSessionResult["jobObservation"]>)
			: undefined,
	};
	const options = { connectionGeneration: crypto.randomUUID(), redact };
	const controller = createDesktopActivityController(result, options);
	controllers.push(controller);
	return {
		state,
		lifecycle,
		session,
		manager,
		observation,
		listeners,
		observationListeners,
		result,
		options,
		controller,
	};
}

function snapshot(controller: DesktopActivityController): Extract<DesktopActivitySnapshot, { available: true }> {
	const value = controller.getSnapshot();
	if (!value.available) throw new Error(value.reason);
	return value;
}

function gateRef(controller: DesktopActivityController): DesktopActivityRef {
	const gates = controller.getSnapshot().sessionState?.gates;
	if (!gates?.available || !gates.pending[0]) throw new Error("Expected a pending public gate");
	return gates.pending[0].ref;
}

type RemoteEmitter = WorkflowGateEmitter &
	Required<
		Pick<WorkflowGateEmitter, "listPendingGates" | "registerGateTerminalController" | "resolveGate" | "onGateEmitted">
	>;

async function gateFixture(terminalController = true, redact: (text: string) => string = text => text) {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "desktop-public-activity-"));
	await Bun.write(path.join(root, "model-presets", "control.json"), JSON.stringify({ version: 1, disabled: true }));
	const settings = Settings.isolated({ "compaction.enabled": false, "todo.enabled": false });
	const auth = await discoverAuthStorage(root);
	let result: CreateAgentSessionResult | undefined;
	cleanups.push(async () => {
		await result?.session.dispose();
		await settings.close();
		auth.close();
		await fs.rm(root, { recursive: true, force: true });
	});
	result = await createAgentSession({
		cwd: root,
		agentDir: root,
		settings,
		authStorage: auth,
		model: getBundledModel("openai", "gpt-4o-mini"),
		disableExtensionDiscovery: true,
		enableMcpAutoload: false,
		enableLsp: false,
		toolNames: [],
		skills: [],
		contextFiles: [],
		promptTemplates: [],
		slashCommands: [],
	});
	const emitter = result.session.getWorkflowGateEmitter();
	if (
		!emitter?.listPendingGates ||
		!emitter.registerGateTerminalController ||
		!emitter.resolveGate ||
		!emitter.onGateEmitted
	)
		throw new Error("Expected the real public session remote-answer emitter");
	const remote = emitter as RemoteEmitter;
	const presented = new Set<string>();
	const retired: string[] = [];
	const unsubscribe = remote.onGateEmitted?.(gate => {
		presented.add(gate.gate_id);
	});
	const unregister = terminalController
		? remote.registerGateTerminalController({
				completeGateInteractions(gateId) {
					if (!presented.delete(gateId)) throw new Error("Presentation is no longer owned");
					retired.push(gateId);
					return "retired";
				},
				cancelGateInteractions(gateId) {
					presented.delete(gateId);
				},
			})
		: undefined;
	const controller = createDesktopActivityController(result, { connectionGeneration: crypto.randomUUID(), redact });
	controllers.push(controller);
	cleanups.push(async () => {
		controller.dispose();
		unsubscribe?.();
		unregister?.();
	});
	return { result, controller, emitter: remote, retired };
}

function signal(): AbortSignal {
	return new AbortController().signal;
}

afterEach(async () => {
	for (const controller of controllers.splice(0)) controller.dispose();
	while (cleanups.length) await cleanups.pop()?.();
	vi.restoreAllMocks();
});

describe("desktop public SDK activity projection", () => {
	test("masks host credentials reconstructed by ANSI and control normalization", async () => {
		const secret = "alpha-key";
		const f = await fixture(text => text.replaceAll(secret, "[redacted]"));
		f.state.jobs[0]!.label = "alpha-\x1b[31mkey";
		const view = snapshot(f.controller);
		expect(view.jobs[0]?.label).toBe("[redacted]");
		f.observation.getMonitorOutput.mockReturnValue("alpha-\x00key");
		const detail = f.controller.getDetail(view.jobs[0]!.ref);
		expect(detail.output).toMatchObject({ text: "[redacted]", truncated: false });
		expect(JSON.stringify({ view, detail })).not.toContain(secret);
	});

	for (const { name, source, secrets, expected } of [
		{
			name: "raw credentials crossing an ANSI boundary",
			source: "\x1b[31mvery-private",
			secrets: ["31mvery-private"],
			expected: "[redacted]",
		},
		{
			name: "overlapping raw and control-reconstructed credentials",
			source: "overlap-left-shared-right-\x00private",
			secrets: ["overlap-left-shared", "shared-right-private"],
			expected: "[redacted]",
		},
		{
			name: "ordinary public ANSI metadata",
			source: "\x1b[32mpublic label\x1b[0m\x00",
			secrets: ["31mvery-private", "overlap-left-shared", "shared-right-private"],
			expected: "public label",
		},
	]) {
		test(`normalization protects ${name} without changing canonical SDK data`, async () => {
			const f = await fixture(text => secrets.reduce((safe, secret) => safe.replaceAll(secret, "[redacted]"), text));
			f.state.jobs[0]!.label = source;
			f.observation.getMonitorOutput.mockReturnValue(source);
			const original = structuredClone(f.state);
			const view = snapshot(f.controller);
			expect(view.jobs[0]?.label).toBe(expected);
			const detail = f.controller.getDetail(view.jobs[0]!.ref);
			expect(detail.output).toEqual({ text: expected, truncated: false });
			expect(detail.entry).toMatchObject({ label: expected });
			expect(f.state).toEqual(original);
			expect(f.observation.getMonitorOutput.mock.results[0]?.value).toBe(source);
		});
	}

	test("uses actual SDK references, capability verbs and public display fields", async () => {
		const sdkSnapshot = vi.spyOn(ActivityControls.prototype, "getActivitySnapshot");
		// Identity host policy exercises the SDK's own captured-credential masking.
		const f = await fixture();
		const view = snapshot(f.controller);
		expect(sdkSnapshot).toHaveBeenCalledTimes(1);
		expect(view.jobs[0]).toMatchObject({
			type: "job",
			kind: "bash",
			label: expect.stringContaining("monitor "),
			status: "running",
			outputAvailable: true,
			controls: ["cancel"],
		});
		expect(view.tasks[0]).toMatchObject({
			id: "task-a",
			controls: ["stop", "pause"],
			requestedModel: expect.stringContaining("requested "),
			effectiveModel: expect.stringContaining("effective "),
		});
		expect(view.crons[0]).toMatchObject({
			schedule: expect.stringContaining("every minute "),
			firing: true,
			recurring: true,
			nextFireAt: 12,
			controls: ["delete"],
		});
		expect(view.jobs[0]!.id).toBe(view.jobs[0]!.ref.key);
		expect(view.crons[0]!.id).toBe(view.crons[0]!.ref.key);
		for (const hidden of [
			"secret",
			"private-monitor-id",
			"private-cron-id",
			"private prompt",
			"factory-owner",
			"logical-session",
			"provider-session",
			"failure-1",
			"job-1",
			"task-1",
		])
			expect(JSON.stringify(view)).not.toContain(hidden);
		const detail = f.controller.getDetail(view.jobs[0]!.ref);
		expect(detail.output).toMatchObject({ text: expect.stringContaining("output "), truncated: false });
		expect(JSON.stringify(detail)).not.toContain("secret");
		expect(f.observation.getMonitorOutput).toHaveBeenCalledWith({
			kind: "job",
			id: "private-monitor-id",
			generation: "job-1",
		});
	});

	test("maps each desktop operation to the real SDK service without forwarding display IDs", async () => {
		const operation = vi.spyOn(ActivityControls.prototype, "operateActivity");
		const f = await fixture();
		const view = snapshot(f.controller);
		const job = view.jobs[0]!.ref;
		const task = view.tasks[0]!.ref;
		const cron = view.crons[0]!.ref;
		f.controller.operate(job, "cancel");
		f.controller.operate(task, "stop");
		f.controller.operate(task, "pause");
		f.state.tasks[0]!.capabilities = { cancel: true, pause: false, resume: true };
		f.state.tasks[0]!.status = "paused";
		f.controller.operate(task, "resume");
		f.controller.operate(cron, "delete");
		expect(operation.mock.calls).toEqual([
			[{ ref: job.key }, "cancel"],
			[{ ref: task.key }, "cancel"],
			[{ ref: task.key }, "pause"],
			[{ ref: task.key }, "resume"],
			[{ ref: cron.key }, "delete"],
		]);
		expect(f.observation.cancelMonitor).toHaveBeenCalledTimes(1);
		expect(f.observation.cancelTask).toHaveBeenCalledTimes(1);
		expect(f.observation.pauseTask).toHaveBeenCalledTimes(1);
		expect(f.observation.resumeTask).toHaveBeenCalledTimes(1);
		expect(f.observation.deleteCron).toHaveBeenCalledWith({ kind: "cron", id: "private-cron-id", createdAt: 1 });
		for (const [ref, action] of [
			[job, "stop"],
			[task, "cancel"],
			[cron, "pause"],
		] as const)
			expect(() => f.controller.operate(ref, action)).toThrow(expect.objectContaining({ code: "unsupported" }));
	});

	test("native SDK checks reject changed owners, stale generations and replaced entries", async () => {
		const f = await fixture();
		const ref = snapshot(f.controller).jobs[0]!.ref;
		f.state.jobs[0]!.generation = "replacement";
		expect(() => f.controller.operate(ref, "cancel")).toThrow(expect.objectContaining({ code: "stale_generation" }));
		expect(f.observation.cancelMonitor).not.toHaveBeenCalled();
		const fresh = snapshot(f.controller).jobs[0]!.ref;
		f.session.getAgentId = () => "successor-owner";
		expect(() => f.controller.operate(fresh, "cancel")).toThrow(expect.objectContaining({ code: "stale_session" }));
		f.session.getAgentId = () => "factory-owner";
		expect(() => f.controller.getDetail(fresh)).toThrow(expect.objectContaining({ code: "stale_session" }));
		const other = await fixture();
		const otherRef = snapshot(other.controller).jobs[0]!.ref;
		other.lifecycle.generation++;
		expect(() => other.controller.operate(otherRef, "cancel")).toThrow(
			expect.objectContaining({ code: "stale_session" }),
		);
	});

	test("connection wrappers never grant authority to forged or other SDK references", async () => {
		const f = await fixture();
		const view = snapshot(f.controller);
		const ref = view.jobs[0]!.ref;
		expect(() => f.controller.operate({ ...ref, connectionGeneration: "old" }, "cancel")).toThrow(
			expect.objectContaining({ code: "stale_connection" }),
		);
		expect(() => f.controller.operate({ ...ref, sessionGeneration: "old" }, "cancel")).toThrow(
			expect.objectContaining({ code: "stale_session" }),
		);
		expect(() => f.controller.operate({ ...ref, key: "private-monitor-id" }, "cancel")).toThrow(
			expect.objectContaining({ code: "not_found" }),
		);
		const other = createDesktopActivityController(f.result, f.options);
		controllers.push(other);
		const otherRef = snapshot(other).jobs[0]!.ref;
		expect(() => f.controller.operate({ ...ref, key: otherRef.key }, "cancel")).toThrow(
			expect.objectContaining({ code: "not_found" }),
		);
		expect(f.observation.cancelMonitor).not.toHaveBeenCalled();
	});

	test("a background snapshot cannot retarget a delayed acknowledgement to an unseen failure", async () => {
		const acknowledge = vi.spyOn(ActivityControls.prototype, "acknowledge");
		const f = await fixture();
		f.state.jobs[0]!.status = "failed";
		f.state.worstState = "failed";
		f.state.failedUnacknowledged = true;
		const displayed = snapshot(f.controller);
		expect(displayed.jobs[0]).toMatchObject({ status: "failed" });
		f.state.jobs.push({
			...f.state.jobs[0]!,
			id: "private-failure-b-id",
			generation: "job-b",
			label: "new unseen failure",
		});
		f.state.failureRevision = "failure-2";
		const refreshed = snapshot(f.controller);
		expect(refreshed.jobs).toHaveLength(2);
		expect(refreshed.jobs[1]).toMatchObject({ label: "new unseen failure", status: "failed" });
		expect(refreshed.acknowledgement).not.toBe(displayed.acknowledgement);
		expect(() => f.controller.acknowledgeFailures(displayed)).toThrow(expect.objectContaining({ code: "not_found" }));
		expect(acknowledge).not.toHaveBeenCalled();
		expect(f.observation.acknowledgeFailures).not.toHaveBeenCalled();
		expect(f.state.failedUnacknowledged).toBe(true);
		expect(f.controller.acknowledgeFailures(refreshed)).toMatchObject({
			available: true,
			failedUnacknowledged: false,
		});
		expect(acknowledge.mock.calls).toEqual([[{ ref: refreshed.acknowledgement }]]);
		expect(f.observation.acknowledgeFailures.mock.calls).toEqual([["failure-2"]]);
		expect(() => f.controller.acknowledgeFailures(refreshed)).toThrow(expect.objectContaining({ code: "not_found" }));
		expect(acknowledge).toHaveBeenCalledTimes(1);
		expect(f.observation.acknowledgeFailures).toHaveBeenCalledTimes(1);
		for (const hidden of ["factory-owner", "private-failure-b-id", "job-b", "failure-2"])
			expect(JSON.stringify(refreshed)).not.toContain(hidden);
	});

	test("malformed, forged and wrong-scope acknowledgements preserve the exact valid token", async () => {
		const acknowledge = vi.spyOn(ActivityControls.prototype, "acknowledge");
		const f = await fixture();
		f.state.failedUnacknowledged = true;
		const view = snapshot(f.controller);
		for (const acknowledgement of [undefined, null, 1, {}, "", "x".repeat(129)]) {
			expect(() =>
				f.controller.acknowledgeFailures({ ...view, acknowledgement } as DesktopActivityAcknowledgement),
			).toThrow(expect.objectContaining({ code: "invalid_reference" }));
		}
		for (const acknowledgement of ["factory-owner", "private-monitor-id", "failure-1", view.jobs[0]!.ref.key]) {
			expect(() => f.controller.acknowledgeFailures({ ...view, acknowledgement })).toThrow(
				expect.objectContaining({ code: "not_found" }),
			);
		}
		expect(() => f.controller.acknowledgeFailures({ ...view, connectionGeneration: "old" })).toThrow(
			expect.objectContaining({ code: "stale_connection" }),
		);
		expect(() => f.controller.acknowledgeFailures({ ...view, sessionGeneration: "old" })).toThrow(
			expect.objectContaining({ code: "stale_session" }),
		);
		const other = createDesktopActivityController(f.result, f.options);
		controllers.push(other);
		const otherView = snapshot(other);
		expect(() => f.controller.acknowledgeFailures({ ...view, acknowledgement: otherView.acknowledgement })).toThrow(
			expect.objectContaining({ code: "not_found" }),
		);
		expect(acknowledge).not.toHaveBeenCalled();
		expect(f.observation.acknowledgeFailures).not.toHaveBeenCalled();
		expect(f.state.failedUnacknowledged).toBe(true);
		expect(f.controller.acknowledgeFailures(view)).toMatchObject({
			available: true,
			failedUnacknowledged: false,
		});
		expect(acknowledge.mock.calls).toEqual([[{ ref: view.acknowledgement }]]);
		expect(f.observation.acknowledgeFailures.mock.calls).toEqual([["failure-1"]]);
	});

	test("acknowledges exactly the displayed SDK failure revision, consumed even on rejection", async () => {
		const acknowledge = vi.spyOn(ActivityControls.prototype, "acknowledge");
		const f = await fixture();
		f.state.failedUnacknowledged = true;
		const view = snapshot(f.controller);
		f.state.failureRevision = "failure-2";
		expect(() => f.controller.acknowledgeFailures(view)).toThrow(
			expect.objectContaining({ code: "stale_generation" }),
		);
		expect(acknowledge.mock.calls[0]?.[0]).toEqual({ ref: view.acknowledgement });
		expect(f.observation.acknowledgeFailures).toHaveBeenCalledWith("failure-1");
		expect(() => f.controller.acknowledgeFailures(view)).toThrow(expect.objectContaining({ code: "not_found" }));
		const refreshed = snapshot(f.controller);
		expect(f.controller.acknowledgeFailures(refreshed)).toMatchObject({
			available: true,
			failedUnacknowledged: false,
		});
		expect(f.observation.acknowledgeFailures).toHaveBeenLastCalledWith("failure-2");
	});

	test("redaction cannot advance the SDK acknowledgement to an unseen failure revision", async () => {
		let duringProjection: (() => void) | undefined;
		const f = await fixture(text => {
			duringProjection?.();
			return text;
		});
		f.state.failedUnacknowledged = true;
		duringProjection = () => {
			duringProjection = undefined;
			f.state.failureRevision = "new-unseen-failure";
		};
		const displayed = snapshot(f.controller);
		expect(() => f.controller.acknowledgeFailures(displayed)).toThrow(
			expect.objectContaining({ code: "stale_generation" }),
		);
		expect(f.observation.acknowledgeFailures).toHaveBeenCalledWith("failure-1");
	});

	test("read-only folded jobs use SDK visibility and never regain output or control", async () => {
		const f = await fixture();
		const row = f.state.jobs[0]!;
		f.state.foldedJobs = [{ ...row, backgrounded: true, errorText: "private error" }];
		f.state.jobs = [];
		const job = snapshot(f.controller).jobs[0]!;
		expect(job).toMatchObject({ outputAvailable: false, backgrounded: true, controls: [] });
		// Native ActivityEntry intentionally omits raw errorText, even for failed/folded jobs.
		expect(job).not.toHaveProperty("error");
		expect(job).not.toHaveProperty("errorText");
		expect(JSON.stringify(job)).not.toContain("private error");
		expect(f.controller.getDetail(job.ref)).not.toHaveProperty("output");
		expect(() => f.controller.operate(job.ref, "cancel")).toThrow(expect.objectContaining({ code: "unsupported" }));
		expect(f.observation.getMonitorOutput).not.toHaveBeenCalled();
	});

	test("unavailable is explicit, errors are sanitized and SDK error codes are deliberately mapped", async () => {
		const missing = await fixture(text => text, false);
		expect(missing.controller.getSnapshot()).toMatchObject({
			available: false,
			reason: expect.stringContaining("no public job"),
		});
		expect(missing.controller.getSnapshot()).not.toHaveProperty("jobs");
		const f = await fixture();
		const ref = snapshot(f.controller).jobs[0]!.ref;
		for (const [sdkCode, desktopCode] of [
			["session_transitioning", "control_busy"],
			["busy", "control_busy"],
			["disposed", "disposed"],
			["already_terminal", "already_terminal"],
			["read_only", "unsupported"],
		] as const) {
			const spy = vi.spyOn(ActivityControls.prototype, "operateActivity").mockImplementationOnce(() => {
				throw new ActivityControlError(sdkCode);
			});
			expect(() => f.controller.operate(ref, "cancel")).toThrow(expect.objectContaining({ code: desktopCode }));
			spy.mockRestore();
		}
		vi.spyOn(ActivityControls.prototype, "operateActivity").mockImplementationOnce(() => {
			throw new Error("private secret backend text");
		});
		let failure: unknown;
		try {
			f.controller.operate(ref, "cancel");
		} catch (error) {
			failure = error;
		}
		expect(failure).toMatchObject({ code: "backend_failure" });
		expect(String(failure)).not.toContain("secret");
	});

	test("preserves SDK output truncation and redaction failures fail closed", async () => {
		const f = await fixture();
		f.observation.getMonitorOutput.mockReturnValue("x".repeat(DESKTOP_ACTIVITY_LIMITS.outputChars + 1));
		const ref = snapshot(f.controller).jobs[0]!.ref;
		expect(f.controller.getDetail(ref).output).toEqual({
			text: "x".repeat(DESKTOP_ACTIVITY_LIMITS.outputChars),
			truncated: true,
		});
		const failed = await fixture(() => {
			throw new Error("private redactor error");
		});
		expect(failed.controller.getSnapshot()).toMatchObject({
			available: false,
			reason: expect.stringContaining("redaction failed"),
		});
	});

	test("bounds entries while retaining SDK truncation and isolates subscriptions on detach", async () => {
		const f = await fixture();
		const first = f.state.jobs[0]!;
		f.state.jobs = Array.from({ length: DESKTOP_ACTIVITY_LIMITS.entries + 1 }, (_, index) => ({
			...first,
			id: `job-${index}`,
		}));
		const view = snapshot(f.controller);
		expect(view.jobs).toHaveLength(DESKTOP_ACTIVITY_LIMITS.entries);
		expect(view.truncated.jobs).toBe(true);
		let changes = 0;
		f.controller.onChange(() => {
			throw new Error("isolated listener");
		});
		const unsubscribe = f.controller.onChange(() => {
			changes++;
		});
		for (const listener of f.observationListeners) listener();
		expect(changes).toBe(1);
		unsubscribe();
		for (const listener of f.observationListeners) listener();
		expect(changes).toBe(1);
		f.controller.dispose();
		expect(f.listeners.size).toBe(0);
		expect(f.observationListeners.size).toBe(0);
		expect(f.observation.dispose).not.toHaveBeenCalled();
		expect(f.controller.getSnapshot()).toMatchObject({
			available: false,
			reason: expect.stringContaining("disposed"),
		});
	});

	test("redactor reentrancy cannot publish detail after SDK owner retirement or local disposal", async () => {
		let reenter: (() => void) | undefined;
		const f = await fixture(text => {
			reenter?.();
			return text;
		});
		const ref = snapshot(f.controller).jobs[0]!.ref;
		reenter = () => {
			f.session.getAgentId = () => "retired";
		};
		expect(() => f.controller.getDetail(ref)).toThrow(expect.objectContaining({ code: "stale_session" }));
		const second = await fixture(text => {
			reenter?.();
			return text;
		});
		reenter = undefined;
		const secondRef = snapshot(second.controller).jobs[0]!.ref;
		reenter = () => second.controller.dispose();
		expect(() => second.controller.getDetail(secondRef)).toThrow(expect.objectContaining({ code: "disposed" }));
	});
});

describe("desktop public workflow-gate presentation", () => {
	test("uses the real session emitter for complete approval presentation and terminalization", async () => {
		const f = await gateFixture();
		const pending = f.emitter.emitGate(approvalGate({ plan: "Complete plan" }), { signal: signal() });
		void pending.catch(() => {});
		const ref = gateRef(f.controller);
		await expect(
			f.controller.answerGate(ref, { kind: "json", json: '{"decision":"approve"}' }),
		).rejects.toMatchObject({ code: "gate_not_presented" });
		const presentation = f.controller.getGatePresentation(ref);
		expect(presentation.gate).toMatchObject({
			kind: "approval",
			answerable: true,
			truncated: false,
			content: { plan: "Complete plan" },
		});
		expect(presentation.gateId).toBe(f.emitter.listPendingGates()[0]!.gate_id);
		await expect(f.controller.answerGate(ref, { kind: "json", json: '{"decision":"approve"}' })).resolves.toEqual({
			status: "accepted",
		});
		expect(await pending).toEqual({ decision: "approve" });
		expect(f.retired).toEqual([presentation.gateId]);
	}, 30_000);

	test("complete original-schema validation rejects malformed and oversize answers", async () => {
		const f = await gateFixture();
		const pending = f.emitter.emitGate(executionGate(), { signal: signal() });
		void pending.catch(() => {});
		const ref = gateRef(f.controller);
		f.controller.getGate(ref);
		for (const json of [
			"not json",
			"{}",
			'{"decision":"reject"}',
			`"${"x".repeat(DESKTOP_ACTIVITY_LIMITS.answerBytes)}"`,
		])
			await expect(f.controller.answerGate(ref, { kind: "json", json })).rejects.toMatchObject({
				code: "invalid_answer",
			});
		expect(f.emitter.listPendingGates()).toHaveLength(1);
		expect(f.retired).toHaveLength(0);
	}, 30_000);

	test("question choices use original complete values rather than redacted labels", async () => {
		const f = await gateFixture(true, text => text.replaceAll("secret", "[redacted]"));
		const gate = questionToGate({ id: "question", question: "Choose secret", options: [{ label: "secret answer" }] });
		const pending = f.emitter.emitGate(gate, { signal: signal() });
		void pending.catch(() => {});
		const ref = gateRef(f.controller);
		const dto = f.controller.getGate(ref);
		expect(dto.content.prompt).toContain("Choose ");
		expect(JSON.stringify(dto)).not.toContain("secret");
		const choice = dto.choices[0];
		if (!choice) throw new Error("Expected a complete public question answer choice");
		await expect(f.controller.answerGate(ref, { kind: "choice", choiceKey: choice.key })).resolves.toEqual({
			status: "accepted",
		});
		expect(await pending).toEqual({ selected: ["secret answer"] });
	}, 30_000);

	test("truncated presentations and detached DTO edits never authorize an answer", async () => {
		const f = await gateFixture();
		const pending = f.emitter.emitGate(
			approvalGate({ plan: "x".repeat(DESKTOP_ACTIVITY_LIMITS.gateContentChars + 1) }),
			{ signal: signal() },
		);
		void pending.catch(() => {});
		const ref = gateRef(f.controller);
		const dto = f.controller.getGate(ref);
		expect(dto).toMatchObject({ truncated: true, answerable: false });
		dto.answerable = true;
		dto.content.plan = "edited";
		await expect(
			f.controller.answerGate(ref, { kind: "json", json: '{"decision":"approve"}' }),
		).rejects.toMatchObject({ code: "gate_not_presented" });
		expect(f.emitter.listPendingGates()).toHaveLength(1);
		expect(f.retired).toHaveLength(0);
	}, 30_000);

	test("missing terminal-controller integration never reports false success", async () => {
		const f = await gateFixture(false);
		const pending = f.emitter.emitGate(approvalGate(), { signal: signal() });
		void pending.catch(() => {});
		const ref = gateRef(f.controller);
		const remote = vi.spyOn(f.emitter, "supportsRemoteGateAnswers").mockReturnValue(false);
		expect(f.controller.getGate(ref)).toMatchObject({ answerable: false });
		await expect(
			f.controller.answerGate(ref, { kind: "json", json: '{"decision":"approve"}' }),
		).rejects.toMatchObject({ code: "unsupported" });
		remote.mockRestore();
		f.controller.getGate(ref);
		await expect(
			f.controller.answerGate(ref, { kind: "json", json: '{"decision":"approve"}' }),
		).rejects.toMatchObject({ code: "gate_resolution_failed" });
		await expect(pending).rejects.toThrow("continuation was fenced");
		expect(f.retired).toHaveLength(0);
	}, 30_000);

	test("committed native lifecycle changes revoke old gate presentations", async () => {
		const f = await gateFixture();
		const pending = f.emitter.emitGate(approvalGate(), { signal: signal() });
		void pending.catch(() => {});
		const ref = gateRef(f.controller);
		f.controller.getGate(ref);
		expect(await f.result.session.clearContext()).toBe(true);
		expect(() => f.controller.getGate(ref)).toThrow(expect.objectContaining({ code: "stale_session" }));
		await expect(
			f.controller.answerGate(ref, { kind: "json", json: '{"decision":"approve"}' }),
		).rejects.toMatchObject({ code: "stale_session" });
		expect(f.retired).toHaveLength(0);
	}, 30_000);

	test("synchronous public gate replay cannot leak subscriptions on reentrant disposal", async () => {
		const f = await gateFixture();
		const pending = f.emitter.emitGate(approvalGate(), { signal: signal() });
		void pending.catch(() => {});
		const gate = f.emitter.listPendingGates()[0]!;
		let subscriptions = 0;
		vi.spyOn(f.emitter, "onGateEmitted").mockImplementation(listener => {
			subscriptions++;
			listener(gate);
			return () => {
				subscriptions--;
			};
		});
		expect(() => f.controller.onChange(() => f.controller.dispose())).toThrow(
			expect.objectContaining({ code: "disposed" }),
		);
		expect(subscriptions).toBe(0);
	}, 30_000);

	test("in-flight gate answers are single-flight and disposal cannot report success", async () => {
		const f = await gateFixture();
		const pending = f.emitter.emitGate(approvalGate(), { signal: signal() });
		void pending.catch(() => {});
		const ref = gateRef(f.controller);
		f.controller.getGate(ref);
		const entered = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		vi.spyOn(f.emitter, "resolveGate").mockImplementation(async response => {
			entered.resolve();
			await release.promise;
			return { gate_id: response.gate_id, status: "accepted", answer_hash: "private", resolved_at: "private" };
		});
		const answering = f.controller.answerGate(ref, { kind: "json", json: '{"decision":"approve"}' });
		await entered.promise;
		try {
			await expect(
				f.controller.answerGate(ref, { kind: "json", json: '{"decision":"approve"}' }),
			).rejects.toMatchObject({ code: "gate_busy" });
			f.controller.dispose();
		} finally {
			release.resolve();
		}
		await expect(answering).rejects.toMatchObject({ code: "disposed" });
	}, 30_000);
});
