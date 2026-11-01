import { afterEach, describe, expect, test, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Agent } from "@gajae-code/agent-core";
import { getBundledModel } from "@gajae-code/ai";
import { AsyncJobManager, type SubagentRunOutcome } from "@gajae-code/coding-agent/async/job-manager";
import { setModelPresetRegistryDisabled } from "@gajae-code/coding-agent/config/model-preset-registry";
import { ModelRegistry } from "@gajae-code/coding-agent/config/model-registry";
import { Settings } from "@gajae-code/coding-agent/config/settings";
import {
	type ExtensionFactory,
	ExtensionRunner,
	loadExtensionFromFactory,
} from "@gajae-code/coding-agent/extensibility/extensions";
import { ExtensionRuntime } from "@gajae-code/coding-agent/extensibility/extensions/loader";
import type { CreateAgentSessionResult } from "@gajae-code/coding-agent/sdk";
import {
	JobObservation,
	JobObservationError,
	type JobObservationErrorCode,
} from "@gajae-code/coding-agent/sdk/job-observation";
import {
	approvalGate,
	executionGate,
	questionToGate,
	type WorkflowGateEmitter,
} from "@gajae-code/coding-agent/sdk/workflow-gates";
import { AgentSession } from "@gajae-code/coding-agent/session/agent-session";
import { AuthStorage } from "@gajae-code/coding-agent/session/auth-storage";
import { SessionManager } from "@gajae-code/coding-agent/session/session-manager";
import type { ToolSession } from "@gajae-code/coding-agent/tools";
import { CronTool } from "@gajae-code/coding-agent/tools/cron";
import { EventBus } from "@gajae-code/coding-agent/utils/event-bus";
import {
	createDesktopActivityController,
	DESKTOP_ACTIVITY_LIMITS,
	type DesktopActivityController,
	type DesktopActivityError,
} from "../src/activity-controls";
import type { DesktopActivityErrorCode, DesktopActivityRef, DesktopActivitySnapshot } from "../src/activity-protocol";

const managers: AsyncJobManager[] = [];
const observations: JobObservation[] = [];
const controllers: DesktopActivityController[] = [];
const gateCleanups: Array<() => Promise<void>> = [];

function manager(retentionMs?: number, maxRunningJobs = 200): AsyncJobManager {
	const value = new AsyncJobManager({ onJobComplete: () => {}, retentionMs, maxRunningJobs });
	managers.push(value);
	return value;
}

/** Real public observation, with a session lifecycle seam; never a provider or global manager. */
function fixture(
	value = manager(),
	owner: string = crypto.randomUUID(),
	redact: (text: string) => string = text => text,
) {
	const observation = new JobObservation(value, owner);
	observations.push(observation);
	const listeners = new Set<() => void>();
	const cleanups = new Set<() => void>();
	const transitions = new Set<() => void>();
	const managerSessionId = crypto.randomUUID();
	const lifecycle = { generation: 0, transitioning: false };
	const session = {
		get sessionLifecycle(): {
			readonly generation: number;
			readonly transitioning: boolean;
			readonly disposed: boolean;
		} {
			return Object.freeze({ ...lifecycle, disposed: session.isDisposed });
		},
		sessionManager: { getSessionId: (): string => managerSessionId },
		sessionId: crypto.randomUUID() as string,
		isDisposed: false,
		getGoalModeState: () => undefined,
		getEffectiveActiveWorkflowSkillState: () => undefined,
		getWorkflowGateEmitter: (): WorkflowGateEmitter | undefined => undefined,
		subscribe: (listener: () => void) => {
			listeners.add(listener);
			return () => {
				listeners.delete(listener);
			};
		},
		registerToolSessionCleanup: (cleanup: () => void) => {
			cleanups.add(cleanup);
			return () => {
				cleanups.delete(cleanup);
			};
		},
		registerToolSessionTransitionCleanup: (cleanup: () => void) => {
			transitions.add(cleanup);
			return () => {
				transitions.delete(cleanup);
			};
		},
	};
	const result: Pick<CreateAgentSessionResult, "session" | "jobObservation"> = {
		session: session as unknown as CreateAgentSessionResult["session"],
		jobObservation: observation,
	};
	const options = { connectionGeneration: crypto.randomUUID(), redact };
	const controller = createDesktopActivityController(result, options);
	controllers.push(controller);
	return {
		value,
		owner,
		observation,
		session,
		result,
		options,
		controller,
		listeners,
		cleanups,
		transitions,
		lifecycle,
		disposeSession() {
			session.isDisposed = true;
			observation.dispose();
			for (const cleanup of [...cleanups]) cleanup();
		},
		transition() {
			for (const cleanup of [...transitions]) cleanup();
			transitions.clear();
		},
	};
}

type RemoteEmitter = WorkflowGateEmitter &
	Required<Pick<WorkflowGateEmitter, "listPendingGates" | "registerGateTerminalController" | "resolveGate">>;

function assertRemoteEmitter(emitter: WorkflowGateEmitter | undefined): asserts emitter is RemoteEmitter {
	if (!emitter?.listPendingGates || !emitter.registerGateTerminalController || !emitter.resolveGate)
		throw new Error("Expected the public AgentSession default remote emitter");
}

async function gateFixture(
	terminalController = true,
	redact: (text: string) => string = text => text,
	options: { extensionFactory?: ExtensionFactory; compactable?: boolean } = {},
) {
	const f = fixture(manager(), crypto.randomUUID(), redact);
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "desktop-activity-gates-"));
	await setModelPresetRegistryDisabled({ agentDir: root, disabled: true });
	const auth = await AuthStorage.create(path.join(root, "auth.db"));
	const settings = Settings.isolated({ "compaction.enabled": false, "compaction.keepRecentTokens": 1 });
	const registry = new ModelRegistry(auth, path.join(root, "models.yml"), settings, { agentDir: root });
	const sessionManager = SessionManager.inMemory(root);
	if (options.compactable) {
		for (const content of ["Earlier conversation " + "history ".repeat(100), "Recent conversation"])
			sessionManager.appendMessage({ role: "user", content, timestamp: Date.now() });
	}
	let extensionRunner: ExtensionRunner | undefined;
	if (options.extensionFactory) {
		const runtime = new ExtensionRuntime();
		const extension = await loadExtensionFromFactory(options.extensionFactory, root, new EventBus(), runtime);
		extensionRunner = new ExtensionRunner([extension], runtime, root, sessionManager, registry);
	}
	const session = new AgentSession({
		agent: new Agent({
			initialState: {
				tools: [],
				messages: sessionManager.buildSessionContext().messages,
				systemPrompt: [],
				...(options.compactable ? { model: getBundledModel("anthropic", "claude-sonnet-4-5") } : {}),
			},
			getApiKey: () => {
				throw new Error("No provider turns in activity tests");
			},
			streamFn: () => {
				throw new Error("No provider turns in activity tests");
			},
		}),
		sessionManager,
		settings,
		modelRegistry: registry,
		extensionRunner,
		agentDir: root,
		workflowGatePublication: "local",
		ownedAsyncJobManager: f.value,
		agentId: f.owner,
		disposeAsyncJobManager: false,
	});
	gateCleanups.push(async () => {
		await session.dispose();
		await registry.dispose();
		await settings.close();
		auth.close();
		await fs.rm(root, { recursive: true, force: true });
	});
	const emitter = session.getWorkflowGateEmitter();
	assertRemoteEmitter(emitter);
	const presented = new Set<string>();
	const retired: string[] = [];
	const unsubscribe = emitter.onGateEmitted?.(gate => {
		presented.add(gate.gate_id);
	});
	const unregister = terminalController
		? emitter.registerGateTerminalController({
				completeGateInteractions: gateId => {
					if (!presented.delete(gateId)) throw new Error("Fixture no longer owns the gate presentation");
					retired.push(gateId);
					return "retired";
				},
				cancelGateInteractions: gateId => {
					presented.delete(gateId);
				},
			})
		: undefined;
	const result: Pick<CreateAgentSessionResult, "session" | "jobObservation"> = {
		session,
		jobObservation: f.observation,
	};
	const controller = createDesktopActivityController(result, f.options);
	controllers.push(controller);
	gateCleanups.push(async () => {
		controller.dispose();
		unsubscribe?.();
		unregister?.();
	});
	return {
		...f,
		session,
		result,
		controller,
		emitter,
		retired,
		extensionRunner,
		disposeSession() {
			void session.dispose();
		},
	};
}

function gateRef(controller: DesktopActivityController): DesktopActivityRef {
	const gates = controller.getSnapshot().sessionState?.gates;
	if (!gates?.available || !gates.pending[0]) throw new Error("No fixture gate");
	return gates.pending[0].ref;
}

function monitor(value: AsyncJobManager, ownerId: string, id?: string, label = "monitor"): string {
	return value.register(
		"bash",
		label,
		({ signal }) => {
			const gate = Promise.withResolvers<string>();
			if (signal.aborted) gate.resolve("aborted");
			else signal.addEventListener("abort", () => gate.resolve("aborted"), { once: true });
			return gate.promise;
		},
		{ id, ownerId, metadata: { monitor: true } },
	);
}

function snapshot(controller: DesktopActivityController): Extract<DesktopActivitySnapshot, { available: true }> {
	const result = controller.getSnapshot();
	if (!result.available) throw new Error(result.reason);
	return result;
}

function refFor(controller: DesktopActivityController, id: string): DesktopActivityRef {
	const ref = snapshot(controller).jobs.find(job => job.id === id)?.ref;
	if (!ref) throw new Error(`Missing fixture job ${id}`);
	return ref;
}

function taskRef(controller: DesktopActivityController, id: string): DesktopActivityRef {
	const task = snapshot(controller).tasks.find(task => task.id === id);
	if (!task) throw new Error(`Missing fixture task ${id}`);
	return task.ref;
}

function runningTask(value: AsyncJobManager, ownerId: string, id: string) {
	const gate = Promise.withResolvers<SubagentRunOutcome>();
	const jobId = value.register(
		"task",
		id,
		({ signal }) => {
			signal.addEventListener("abort", () => gate.resolve({ kind: "completed", text: "stopped" }), { once: true });
			return gate.promise;
		},
		{ ownerId },
	);
	value.registerSubagentRecord({
		subagentId: id,
		ownerId,
		status: "running",
		currentJobId: jobId,
		historicalJobIds: [jobId],
		sessionFile: null,
		resumable: true,
	});
	return { gate, job: value.getJob(jobId)! };
}

function expectCode(action: () => unknown, code: DesktopActivityErrorCode): void {
	expect(action).toThrow(
		expect.objectContaining({ name: "DesktopActivityError", code } satisfies Partial<DesktopActivityError>),
	);
}

afterEach(async () => {
	vi.restoreAllMocks();
	while (gateCleanups.length) await gateCleanups.pop()?.();
	for (const controller of controllers.splice(0)) controller.dispose();
	for (const observation of observations.splice(0)) observation.dispose();
	for (const value of managers.splice(0)) await value.dispose();
});

describe("desktop session-owned activity", () => {
	test("isolates owners and rejects forged, cross-session and cross-connection references", () => {
		const first = fixture();
		const second = fixture(first.value);
		const owned = monitor(first.value, first.owner);
		const foreign = monitor(first.value, second.owner);
		first.value.appendOutput(owned, "owned output");
		first.value.appendOutput(foreign, "private foreign output");
		const ref = refFor(first.controller, owned);
		const foreignRef = refFor(second.controller, foreign);
		expect(snapshot(first.controller).jobs.map(job => job.id)).toEqual([owned]);
		expect(first.controller.getDetail(ref).output?.text).toBe("owned output");
		expectCode(() => first.controller.operate(foreignRef, "cancel"), "stale_connection");
		expectCode(
			() => first.controller.operate({ ...foreignRef, connectionGeneration: ref.connectionGeneration }, "cancel"),
			"stale_session",
		);
		expectCode(() => first.controller.operate({ ...ref, key: foreignRef.key }, "cancel"), "not_found");
		expectCode(() => first.controller.operate({ ...ref, key: "forged" }, "cancel"), "not_found");
		expectCode(() => first.controller.getDetail({ ...ref, key: "x".repeat(129) }), "invalid_reference");
		// Renderer-supplied owner fields have no effect on the captured SDK owner.
		const forgedOwner = { ...ref, ownerId: second.owner };
		first.controller.operate(forgedOwner, "cancel");
		expect(first.value.getJob(owned)?.status).toBe("cancelled");
		expect(first.value.getJob(foreign)?.status).toBe("running");
	});

	test("does not let mutated DTOs alter references, capabilities or backend records", () => {
		const { controller, value, owner } = fixture();
		const id = monitor(value, owner);
		const dto = snapshot(controller);
		const original = { ...dto.jobs[0]!.ref };
		dto.jobs[0]!.ref.key = "tampered";
		dto.jobs[0]!.label = "tampered";
		dto.jobs[0]!.controls.length = 0;
		dto.jobs.length = 0;
		expect(snapshot(controller).jobs[0]).toMatchObject({ label: "monitor", controls: ["cancel"], ref: original });
		controller.operate(original, "cancel");
		expect(value.getJob(id)?.status).toBe("cancelled");
	});

	test("retains the SDK's generation check across actual job ID reuse", async () => {
		const { controller, value, owner } = fixture(manager(0));
		const id = monitor(value, owner, "reused-monitor");
		const ref = refFor(controller, id);
		const completion = value.getJob(id)!.promise;
		controller.operate(ref, "cancel");
		await completion;
		await value.drainDeliveries({ timeoutMs: 1000 });
		monitor(value, owner, id);
		// A fresh list retires the old reference; it must never control the successor.
		snapshot(controller);
		expectCode(() => controller.operate(ref, "cancel"), "not_found");
		expect(value.getJob(id)?.status).toBe("running");
		const successor = refFor(controller, id);
		expect(successor.key).not.toBe(ref.key);
		controller.operate(successor, "cancel");
		expect(value.getJob(id)?.status).toBe("cancelled");
	});

	test("rejects replaced generations even before the next list retires a reference", async () => {
		const { controller, observation, value, owner } = fixture(manager(0));
		const id = monitor(value, owner, "replaced-monitor");
		const ref = refFor(controller, id);
		const job = value.getJob(id)!;
		observation.cancelMonitor({ id, generation: job.generation });
		await job.promise;
		await value.drainDeliveries({ timeoutMs: 1000 });
		monitor(value, owner, id);
		expectCode(() => controller.getDetail(ref), "stale_generation");
		expectCode(() => controller.operate(ref, "cancel"), "stale_generation");
		expect(value.getJob(id)?.status).toBe("running");
	});

	test("adapter disposal detaches subscriptions without disposing the shared observation or cancelling jobs", async () => {
		const f = fixture();
		const id = monitor(f.value, f.owner);
		const ref = refFor(f.controller, id);
		let changes = 0;
		f.controller.onChange(() => {
			changes++;
		});
		f.controller.dispose();
		f.controller.dispose();
		monitor(f.value, f.owner);
		await Bun.sleep(0);
		expect(changes).toBe(0);
		expect(f.listeners.size).toBe(0);
		expect(f.cleanups.size).toBe(0);
		expect(f.transitions.size).toBe(0);
		expect(f.observation.getSnapshot().jobs).toHaveLength(2);
		expect(f.value.getJob(id)?.status).toBe("running");
		expect(f.controller.getSnapshot()).toMatchObject({
			available: false,
			reason: expect.stringContaining("disposed"),
		});
		expectCode(() => f.controller.getDetail(ref), "disposed");
		expectCode(() => f.controller.operate(ref, "cancel"), "disposed");
	});

	test("SDK observation and session disposal refuse controls rather than returning an idle list", () => {
		const f = fixture();
		const id = monitor(f.value, f.owner);
		const ref = refFor(f.controller, id);
		f.observation.dispose();
		expectCode(() => f.controller.operate(ref, "cancel"), "disposed");
		expect(f.controller.getSnapshot()).toMatchObject({
			available: false,
			reason: expect.stringContaining("disposed"),
		});
		expect("jobs" in f.controller.getSnapshot()).toBe(false);
		f.disposeSession();
		expectCode(() => f.controller.acknowledgeFailures(ref), "disposed");
		expect(f.value.getJob(id)?.status).toBe("running");
	});

	test("observed illegal same-generation identity replacement permanently fences old references, including A-B-A", () => {
		const f = fixture();
		const id = monitor(f.value, f.owner);
		const ref = refFor(f.controller, id);
		const original = f.session.sessionId;
		f.session.sessionId = "successor";
		expectCode(() => f.controller.operate(ref, "cancel"), "stale_session");
		f.transition();
		f.session.sessionId = original;
		expectCode(() => f.controller.operate(ref, "cancel"), "stale_session");
		expect(f.value.getJob(id)?.status).toBe("running");
	});

	test("notifications without a committed SDK generation preserve exact task, monitor and gate refs", async () => {
		const f = await gateFixture();
		const id = monitor(f.value, f.owner);
		f.value.registerSubagentRecord({
			subagentId: "notice-task",
			ownerId: f.owner,
			status: "paused",
			currentJobId: null,
			historicalJobIds: [],
			sessionFile: null,
			resumable: false,
		});
		const job = refFor(f.controller, id);
		const task = taskRef(f.controller, "notice-task");
		const pending = f.emitter.emitGate(approvalGate());
		void pending.catch(() => {});
		const gate = gateRef(f.controller);
		const generation = f.session.sessionLifecycle.generation;
		let wakes = 0;
		f.controller.onChange(() => {
			wakes++;
		});
		f.session.emitNotice("info", "Catalog notification without transition", "test");
		expect(wakes).toBeGreaterThan(0);
		expect(f.session.sessionLifecycle.generation).toBe(generation);
		expect(f.controller.getDetail(job).entry.ref).toEqual(job);
		expect(f.controller.getDetail(task).entry.ref).toEqual(task);
		expect(f.controller.getGate(gate).ref).toEqual(gate);
		f.controller.operate(task, "stop");
		f.controller.operate(job, "cancel");
		await f.controller.answerGate(gate, { kind: "json", json: '{"decision":"reject"}' });
		await expect(pending).resolves.toEqual({ decision: "reject" });
	});

	test("unchanged compaction temporarily refuses activity and preserves exact refs after real SDK completion", async () => {
		const entered = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		const extensionFactory: ExtensionFactory = api => {
			api.on("session_before_compact", async event => {
				entered.resolve();
				await release.promise;
				return {
					compaction: {
						summary: "Provider-free hook compaction",
						firstKeptEntryId: event.preparation.firstKeptEntryId,
						tokensBefore: event.preparation.tokensBefore,
						details: {},
					},
				};
			});
		};
		const f = await gateFixture(true, text => text, { extensionFactory, compactable: true });
		const id = monitor(f.value, f.owner);
		const ref = refFor(f.controller, id);
		const lifecycle = f.session.sessionLifecycle;
		const compaction = f.session.compact();
		await entered.promise;
		expect(f.session.sessionLifecycle).toMatchObject({
			generation: lifecycle.generation,
			transitioning: true,
			disposed: false,
		});
		expectCode(() => f.controller.operate(ref, "cancel"), "control_busy");
		expect(f.controller.getSnapshot()).toMatchObject({
			available: false,
			reason: expect.stringContaining("lifecycle is changing"),
		});
		release.resolve();
		expect((await compaction).summary).toBe("Provider-free hook compaction");
		expect(f.session.sessionLifecycle).toEqual(lifecycle);
		expect(f.controller.getDetail(ref).entry.ref).toEqual(ref);
		f.controller.operate(ref, "cancel");
		expect(f.value.getJob(id)?.status).toBe("cancelled");
	});

	test("cancelled real session preparation does not revoke old monitor or gate refs", async () => {
		const entered = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		const extensionFactory: ExtensionFactory = api => {
			api.on("session_before_switch", async () => {
				entered.resolve();
				await release.promise;
				return { cancel: true };
			});
		};
		const f = await gateFixture(true, text => text, { extensionFactory });
		const id = monitor(f.value, f.owner);
		const ref = refFor(f.controller, id);
		const pending = f.emitter.emitGate(approvalGate());
		void pending.catch(() => {});
		const gate = gateRef(f.controller);
		f.controller.getGate(gate);
		const lifecycle = f.session.sessionLifecycle;
		const preparation = f.session.newSession();
		await entered.promise;
		expect(f.session.sessionLifecycle).toMatchObject({ generation: lifecycle.generation, transitioning: true });
		expectCode(() => f.controller.getGatePresentation(gate), "control_busy");
		await expect(
			f.controller.answerGate(gate, { kind: "json", json: '{"decision":"approve"}' }),
		).rejects.toMatchObject({ code: "control_busy" });
		release.resolve();
		expect(await preparation).toBe(false);
		expect(f.session.sessionLifecycle).toEqual(lifecycle);
		f.controller.operate(ref, "cancel");
		await f.controller.answerGate(gate, { kind: "json", json: '{"decision":"reject"}' });
		await expect(pending).resolves.toEqual({ decision: "reject" });
	});

	test("failed real preparation retains the committed binding and can still control the original work", async () => {
		const extensionFactory: ExtensionFactory = api => {
			api.on("session_before_switch", async () => undefined);
		};
		const f = await gateFixture(true, text => text, { extensionFactory });
		if (!f.extensionRunner) throw new Error("Expected the real constructed extension runner");
		// Hook exceptions are intentionally isolated by ExtensionRunner. Exercise
		// a runner dispatch failure on the genuine instance, not a fake runner.
		vi.spyOn(f.extensionRunner, "emit").mockRejectedValueOnce(new Error("controlled preparation failure"));
		const id = monitor(f.value, f.owner);
		const ref = refFor(f.controller, id);
		const lifecycle = f.session.sessionLifecycle;
		await expect(f.session.newSession()).rejects.toThrow("controlled preparation failure");
		expect(f.session.sessionLifecycle).toEqual(lifecycle);
		expect(f.controller.getDetail(ref).entry.ref).toEqual(ref);
		f.controller.operate(ref, "cancel");
		expect(f.value.getJob(id)?.status).toBe("cancelled");
	});

	test("same-ID clear permanently revokes old refs by committed generation, including repeated clear ABA", async () => {
		const f = await gateFixture();
		const id = monitor(f.value, f.owner);
		const ref = refFor(f.controller, id);
		const pending = f.emitter.emitGate(approvalGate());
		void pending.catch(() => {});
		const gate = gateRef(f.controller);
		const originalId = f.session.sessionId;
		const originalGeneration = f.session.sessionLifecycle.generation;
		expect(await f.session.clearContext()).toBe(true);
		expect(f.session.sessionId).toBe(originalId);
		expect(f.session.sessionLifecycle.generation).toBeGreaterThan(originalGeneration);
		expectCode(() => f.controller.getDetail(ref), "stale_session");
		expectCode(() => f.controller.getGatePresentation(gate), "stale_session");
		expect(await f.session.clearContext()).toBe(true);
		expect(f.session.sessionId).toBe(originalId);
		expectCode(() => f.controller.operate(ref, "cancel"), "stale_session");
		await expect(
			f.controller.answerGate(gate, { kind: "json", json: '{"decision":"approve"}' }),
		).rejects.toMatchObject({ code: "stale_session" });
	});

	test("cleanup notifications alone cannot permanently revoke unchanged generation, but observed illegal identity ABA can", () => {
		const f = fixture();
		const id = monitor(f.value, f.owner);
		const ref = refFor(f.controller, id);
		f.lifecycle.transitioning = true;
		f.transition();
		expectCode(() => f.controller.operate(ref, "cancel"), "control_busy");
		f.lifecycle.transitioning = false;
		expect(f.controller.getDetail(ref).entry.ref).toEqual(ref);
		const original = f.session.sessionId;
		f.session.sessionId = "illegal-uncommitted-identity";
		expectCode(() => f.controller.getDetail(ref), "stale_session");
		f.session.sessionId = original;
		expectCode(() => f.controller.operate(ref, "cancel"), "stale_session");
		expect(f.value.getJob(id)?.status).toBe("running");
	});

	test("request getters cannot change scope/target or bypass disposal", () => {
		const f = fixture();
		const id = monitor(f.value, f.owner);
		const ref = refFor(f.controller, id);
		let reads = 0;
		const request = {
			...ref,
			get key() {
				reads++;
				return reads === 1 ? ref.key : "forged";
			},
		};
		f.controller.operate(request, "cancel");
		expect(reads).toBe(1);
		const second = monitor(f.value, f.owner);
		const secondRef = refFor(f.controller, second);
		expectCode(
			() =>
				f.controller.operate(
					{
						...secondRef,
						get key() {
							f.disposeSession();
							return secondRef.key;
						},
					},
					"cancel",
				),
			"disposed",
		);
		expect(f.value.getJob(second)?.status).toBe("running");
	});

	test("ordinary and folded jobs stay read-only while task controls follow exact SDK capabilities", () => {
		const f = fixture();
		const live = monitor(f.value, f.owner);
		const folded = monitor(f.value, f.owner);
		f.value.markBackgrounded(folded, f.value.getJob(folded)!.generation, "sdk_control");
		const plain = f.value.register("bash", "ordinary", async () => "done", { ownerId: f.owner });
		const task = f.value.register("task", "detached", async () => "done", { ownerId: f.owner });
		f.value.registerSubagentRecord({
			subagentId: "paused-task",
			ownerId: f.owner,
			status: "paused",
			currentJobId: null,
			historicalJobIds: [],
			sessionFile: "/private/session.jsonl",
			resumable: true,
		});
		const dto = snapshot(f.controller);
		expect(dto.jobs.find(job => job.id === live)).toMatchObject({ controls: ["cancel"], outputAvailable: true });
		for (const id of [folded, plain, task]) {
			const job = dto.jobs.find(job => job.id === id)!;
			expect(job).toMatchObject({ controls: [], outputAvailable: false });
			expect(f.controller.getDetail(job.ref).output).toBeUndefined();
			expectCode(() => f.controller.operate(job.ref, "cancel"), "unsupported");
		}
		const paused = dto.tasks[0]!;
		expect(paused).toMatchObject({ status: "paused", controls: ["stop"] });
		for (const operation of ["pause", "resume"] as const)
			expectCode(() => f.controller.operate(paused.ref, operation), "unsupported");
		for (const operation of ["stop", "pause", "resume"] as const)
			expectCode(() => f.controller.operate(dto.jobs.find(job => job.id === live)!.ref, operation), "unsupported");
		expect(JSON.stringify(dto)).not.toContain("/private/session.jsonl");
		expect(f.value.getJob(live)?.status).toBe("running");
	});

	test("task pause is cooperative, resume uses captured authority, and stop aborts the actual resumed job", async () => {
		const f = fixture();
		const run = runningTask(f.value, f.owner, "task-lifecycle");
		let pauseRequested = false;
		f.value.registerLiveHandle("task-lifecycle", {
			requestPause: () => {
				pauseRequested = true;
			},
			injectMessage: async () => {},
		});
		let resumedJob: string | undefined;
		f.value.registerResumeDescriptor(
			{ subagentId: "task-lifecycle", ownerId: f.owner, data: { secret: "private-resume-payload" } },
			id => {
				resumedJob = f.value.register(
					"task",
					id,
					({ signal }) => {
						const stopped = Promise.withResolvers<string>();
						signal.addEventListener("abort", () => stopped.resolve("stopped"), { once: true });
						return stopped.promise;
					},
					{ ownerId: f.owner },
				);
				return resumedJob;
			},
		);
		const running = snapshot(f.controller).tasks[0]!;
		expect(running.controls).toEqual(["stop", "pause"]);
		f.controller.operate(running.ref, "pause");
		expect(pauseRequested).toBe(true);
		expect(run.job.abortController.signal.aborted).toBe(false);
		expect(snapshot(f.controller).tasks[0]?.status).toBe("running");
		run.gate.resolve({ kind: "paused", note: "safe boundary" });
		await run.job.promise;
		const paused = snapshot(f.controller).tasks[0]!;
		expect(paused.controls).toEqual(["stop", "resume"]);
		f.controller.operate(paused.ref, "resume");
		expect(f.value.getSubagentRecord("task-lifecycle")?.status).toBe("running");
		expectCode(() => f.controller.operate(paused.ref, "stop"), "not_found");
		const active = taskRef(f.controller, "task-lifecycle");
		f.controller.operate(active, "stop");
		expect(f.value.getJob(resumedJob!)?.abortController.signal.aborted).toBe(true);
		await f.value.getJob(resumedJob!)!.promise;
		expect(snapshot(f.controller).tasks[0]?.status).toBe("cancelled");
		expect(JSON.stringify(f.controller.getSnapshot())).not.toContain("private-resume-payload");
	});

	test("task refs exclude foreign owner authority, reject record replacement and cannot be modified through DTOs", () => {
		const f = fixture();
		const foreign = fixture(f.value);
		for (const [owner, id] of [
			[f.owner, "owned-task"],
			[foreign.owner, "foreign-task"],
		] as const) {
			f.value.registerSubagentRecord({
				subagentId: id,
				ownerId: owner,
				status: "paused",
				currentJobId: null,
				historicalJobIds: [],
				sessionFile: null,
				resumable: false,
			});
		}
		const ref = taskRef(f.controller, "owned-task");
		const other = taskRef(foreign.controller, "foreign-task");
		expectCode(() => f.controller.operate({ ...ref, key: other.key }, "stop"), "not_found");
		const dto = snapshot(f.controller).tasks[0]!;
		dto.controls.length = 0;
		dto.ref.key = "forged";
		expect(snapshot(f.controller).tasks[0]?.controls).toEqual(["stop"]);
		f.value.registerSubagentRecord({
			subagentId: "owned-task",
			ownerId: f.owner,
			status: "paused",
			currentJobId: null,
			historicalJobIds: [],
			sessionFile: null,
			resumable: false,
		});
		expectCode(() => f.controller.operate(ref, "stop"), "stale_generation");
		expect(f.value.getSubagentRecord("owned-task")?.status).toBe("paused");
		f.controller.operate(taskRef(f.controller, "owned-task"), "stop");
		expect(f.value.getSubagentRecord("foreign-task")?.status).toBe("paused");
	});

	test("task mutation failures and unsupported resume context do not falsely stop or launch work", () => {
		const f = fixture();
		const run = runningTask(f.value, f.owner, "task-failures");
		f.value.registerLiveHandle("task-failures", {
			requestPause: () => {
				throw new Error("private-pause-failure");
			},
			injectMessage: async () => {},
		});
		const old = taskRef(f.controller, "task-failures");
		expectCode(() => f.controller.operate(old, "pause"), "backend_failure");
		expectCode(() => f.controller.operate(old, "stop"), "stale_generation");
		expect(run.job.abortController.signal.aborted).toBe(false);
		f.value.registerSubagentRecord({
			subagentId: "no-runner",
			ownerId: f.owner,
			status: "paused",
			currentJobId: null,
			historicalJobIds: [],
			sessionFile: "/private/retained.jsonl",
			resumable: true,
		});
		const noRunner = snapshot(f.controller).tasks.find(task => task.id === "no-runner")!;
		expect(noRunner.controls).toEqual(["stop"]);
		expectCode(() => f.controller.operate(noRunner.ref, "resume"), "unsupported");
		f.value.registerResumeDescriptor({ subagentId: "no-runner", ownerId: f.owner, data: {} }, () => {
			throw new Error("private-admission-failure");
		});
		const current = taskRef(f.controller, "no-runner");
		expectCode(() => f.controller.operate(current, "resume"), "backend_failure");
		expect(f.value.getSubagentRecord("no-runner")?.status).toBe("paused");
	});

	test("queued task stop cancels admission without launching a successor", async () => {
		const f = fixture(manager(undefined, 1));
		const busy = runningTask(f.value, f.owner, "busy-task");
		f.value.registerSubagentRecord({
			subagentId: "queued-task",
			ownerId: f.owner,
			status: "paused",
			currentJobId: null,
			historicalJobIds: [],
			sessionFile: null,
			resumable: true,
		});
		let launches = 0;
		f.value.registerResumeDescriptor({ subagentId: "queued-task", ownerId: f.owner, data: {} }, () => {
			launches++;
			return undefined;
		});
		f.controller.operate(taskRef(f.controller, "queued-task"), "resume");
		const queued = snapshot(f.controller).tasks.find(task => task.id === "queued-task")!;
		expect(queued).toMatchObject({ status: "queued", controls: ["stop"] });
		f.controller.operate(queued.ref, "stop");
		busy.gate.resolve({ kind: "completed", text: "done" });
		await busy.job.promise;
		expect(launches).toBe(0);
		expect(f.value.getSubagentRecord("queued-task")?.status).toBe("cancelled");
	});

	test("all SDK lifecycle failure codes map explicitly to safe desktop errors", () => {
		const f = fixture();
		f.value.registerSubagentRecord({
			subagentId: "error-mapping",
			ownerId: f.owner,
			status: "paused",
			currentJobId: null,
			historicalJobIds: [],
			sessionFile: null,
			resumable: false,
		});
		const ref = taskRef(f.controller, "error-mapping");
		const expected: Record<JobObservationErrorCode, DesktopActivityErrorCode> = {
			invalid_owner: "unavailable",
			read_only: "unsupported",
			no_live_job: "unsupported",
			not_running: "unsupported",
			no_live_handle: "unsupported",
			already_running: "unsupported",
			already_queued: "unsupported",
			context_unavailable: "unsupported",
			no_runner: "unsupported",
			control_in_progress: "control_busy",
			owner_shutdown_in_progress: "control_busy",
			resume_failed: "backend_failure",
			disposed: "disposed",
			not_found: "not_found",
			stale_generation: "stale_generation",
			already_terminal: "already_terminal",
		};
		const cancel = vi.spyOn(f.observation, "cancelTask");
		for (const code of Object.keys(expected) as JobObservationErrorCode[]) {
			cancel.mockImplementation(() => {
				throw new JobObservationError(code);
			});
			expectCode(() => f.controller.operate(ref, "stop"), expected[code]);
		}
		expect(f.value.getSubagentRecord("error-mapping")?.status).toBe("paused");
	});

	test("task manager scope revocation rejects old refs after endpoint A-B-A rebind", () => {
		const value = manager();
		const endpointA = crypto.randomUUID();
		const endpointB = crypto.randomUUID();
		expect(AsyncJobManager.registerForEndpoint(endpointA, value)).toBe(true);
		const f = fixture(value);
		value.registerSubagentRecord({
			subagentId: "revoked",
			ownerId: f.owner,
			status: "paused",
			currentJobId: null,
			historicalJobIds: [],
			sessionFile: null,
			resumable: false,
		});
		const ref = taskRef(f.controller, "revoked");
		expect(AsyncJobManager.rekeyForEndpoint(endpointA, endpointB, value)).toBe(true);
		expect(AsyncJobManager.rekeyForEndpoint(endpointB, endpointA, value)).toBe(true);
		expectCode(() => f.controller.operate(ref, "stop"), "stale_generation");
		expect(f.controller.getSnapshot()).toMatchObject({
			available: false,
			reason: expect.stringContaining("replaced"),
		});
		expect(value.getSubagentRecord("revoked")?.status).toBe("paused");
	});

	test("retained completed monitor output remains readable, but cancellation fails explicitly", async () => {
		const f = fixture();
		const id = f.value.register("bash", "finished", async () => "done", {
			ownerId: f.owner,
			metadata: { monitor: true },
		});
		f.value.appendOutput(id, "final output");
		await f.value.getJob(id)!.promise;
		await f.value.drainDeliveries({ timeoutMs: 1000 });
		const job = snapshot(f.controller).jobs.find(job => job.id === id)!;
		expect(job).toMatchObject({ outputAvailable: true, controls: [] });
		expect(f.controller.getDetail(job.ref).output?.text).toBe("final output");
		expectCode(() => f.controller.operate(job.ref, "cancel"), "already_terminal");
	});

	test("redacts before truncation, bounds fields/output, and never serializes backend authorities", () => {
		const secret = "host-secret-credential";
		const f = fixture(manager(), "private-owner", text => text.replaceAll(secret, "[redacted]"));
		const id = monitor(f.value, f.owner, undefined, `${secret}\x1b[31m${"x".repeat(2000)}`);
		f.value.appendOutput(id, `${"z".repeat(DESKTOP_ACTIVITY_LIMITS.outputChars - 4)}${secret}${"z".repeat(1000)}`);
		const dto = snapshot(f.controller);
		const detail = f.controller.getDetail(dto.jobs[0]!.ref);
		expect(dto.jobs[0]!.label).toHaveLength(DESKTOP_ACTIVITY_LIMITS.fieldChars);
		expect(dto.jobs[0]!.label).toStartWith("[redacted]");
		expect(detail.output?.text).toHaveLength(DESKTOP_ACTIVITY_LIMITS.outputChars);
		expect(detail.output?.truncated).toBe(true);
		const serialized = JSON.stringify({ dto, detail });
		for (const forbidden of [
			secret,
			"private-owner",
			"abortController",
			"ownerId",
			"sessionFile",
			"generation",
			"\x1b",
		])
			expect(serialized).not.toContain(forbidden);
	});

	test("bounds snapshot arrays and keeps excluded references unaddressable", () => {
		const f = fixture();
		for (let i = 0; i < DESKTOP_ACTIVITY_LIMITS.entries + 3; i++) {
			monitor(f.value, f.owner, `job-${i}`);
			f.value.registerSubagentRecord({
				subagentId: `task-${i}`,
				ownerId: f.owner,
				status: "paused",
				currentJobId: null,
				historicalJobIds: [],
				sessionFile: null,
				resumable: false,
			});
		}
		const dto = snapshot(f.controller);
		expect(dto.jobs).toHaveLength(DESKTOP_ACTIVITY_LIMITS.entries);
		expect(dto.tasks).toHaveLength(DESKTOP_ACTIVITY_LIMITS.entries);
		expect(dto.truncated).toEqual({ jobs: true, tasks: true, crons: false });
		expectCode(() => f.controller.getDetail({ ...dto, key: "job-102" }), "not_found");
	});

	test("redaction failures fail closed and reentrant disposal cannot return content or mutate jobs", () => {
		const f = fixture();
		const id = monitor(f.value, f.owner);
		const ref = refFor(f.controller, id);
		const failing = createDesktopActivityController(f.result, {
			...f.options,
			redact: () => {
				throw new Error("private-redactor-secret");
			},
		});
		controllers.push(failing);
		expect(failing.getSnapshot()).toMatchObject({
			available: false,
			reason: expect.stringContaining("redaction failed"),
		});
		expect(JSON.stringify(failing.getSnapshot())).not.toContain("private-redactor-secret");
		let dispose = false;
		const reentrant = createDesktopActivityController(f.result, {
			...f.options,
			redact: text => {
				if (dispose) f.disposeSession();
				return text;
			},
		});
		controllers.push(reentrant);
		const reentrantRef = refFor(reentrant, id);
		dispose = true;
		expectCode(() => reentrant.getDetail(reentrantRef), "disposed");
		expectCode(() => f.controller.operate(ref, "cancel"), "disposed");
		expect(f.value.getJob(id)?.status).toBe("running");
	});

	test("mutation failures are surfaced without secret backend diagnostics or false success", () => {
		const f = fixture();
		const id = monitor(f.value, f.owner);
		const ref = refFor(f.controller, id);
		vi.spyOn(f.observation, "cancelMonitor").mockImplementation(() => {
			throw new Error("credential=private-backend-secret");
		});
		expectCode(() => f.controller.operate(ref, "cancel"), "backend_failure");
		try {
			f.controller.operate(ref, "cancel");
		} catch (error) {
			expect(error).toMatchObject({ message: "The activity backend operation failed." });
		}
		expect(f.value.getJob(id)?.status).toBe("running");
		expect(snapshot(f.controller).jobs[0]?.status).toBe("running");
	});

	test("failure acknowledgement is view-local and validates connection/session scope", async () => {
		const f = fixture();
		const other = fixture(f.value, f.owner);
		const id = f.value.register(
			"bash",
			"failed",
			async () => {
				throw new Error("fixture failure");
			},
			{ ownerId: f.owner, metadata: { monitor: true } },
		);
		await f.value.getJob(id)!.promise;
		await f.value.drainDeliveries({ timeoutMs: 1000 });
		const dto = snapshot(f.controller);
		expect(dto.failedUnacknowledged).toBe(true);
		expectCode(() => f.controller.acknowledgeFailures({ ...dto, connectionGeneration: "old" }), "stale_connection");
		expectCode(() => f.controller.acknowledgeFailures({ ...dto, sessionGeneration: "old" }), "stale_session");
		f.controller.acknowledgeFailures(dto);
		expect(snapshot(f.controller).failedUnacknowledged).toBe(false);
		expect(snapshot(other.controller).failedUnacknowledged).toBe(true);
	});

	test("cron deletion uses the observation's captured owner and schedule identity, without exposing prompts", async () => {
		const f = fixture();
		const other = fixture(f.value);
		async function cron(owner: string) {
			const session = {
				cwd: process.cwd(),
				hasUI: false,
				getSessionId: () => "cron-fixture",
				getAgentId: () => owner,
				getAsyncJobManager: () => f.value,
				sendCustomMessage: async () => {},
				allocateOutputArtifact: async () => ({}),
			} as unknown as ToolSession;
			await new CronTool(session).execute("cron-fixture", {
				op: "create",
				cron_expression: "0 * * * *",
				prompt: "private cron prompt",
				recurring: true,
			});
		}
		await cron(f.owner);
		await cron(other.owner);
		const dto = snapshot(f.controller);
		const foreign = snapshot(other.controller);
		expect(dto.crons).toHaveLength(1);
		expect(dto.crons[0]?.controls).toEqual(["delete"]);
		expect(JSON.stringify(dto)).not.toContain("private cron prompt");
		expectCode(
			() => f.controller.operate({ ...dto.crons[0]!.ref, key: foreign.crons[0]!.ref.key }, "delete"),
			"not_found",
		);
		f.controller.operate(dto.crons[0]!.ref, "delete");
		expect(snapshot(f.controller).crons).toHaveLength(0);
		expect(snapshot(other.controller).crons).toHaveLength(1);
		expectCode(() => f.controller.operate(dto.crons[0]!.ref, "delete"), "not_found");
	});

	test("missing observation is unavailable, with real read-only session summaries rather than fabricated jobs", async () => {
		const f = await gateFixture(false);
		f.session.setGoalModeState({
			enabled: true,
			mode: "active",
			goal: {
				id: "private-goal-id",
				objective: "private goal objective",
				status: "paused",
				tokensUsed: 12,
				timeUsedSeconds: 5,
				createdAt: Date.now(),
				updatedAt: Date.now(),
			},
		});
		vi.spyOn(f.session, "getEffectiveActiveWorkflowSkillState").mockReturnValue({
			skill: "ralplan",
			sessionId: f.session.sessionManager.getSessionId(),
		});
		vi.spyOn(f.emitter, "supportsRemoteGateAnswers").mockReturnValue(false);
		const pending = f.emitter.emitGate(approvalGate({ plan: "private plan" }));
		void pending.catch(() => {});
		const controller = createDesktopActivityController({ session: f.session }, f.options);
		controllers.push(controller);
		const dto = controller.getSnapshot();
		expect(dto).toMatchObject({
			available: false,
			reason: expect.stringContaining("no public job observation"),
			sessionState: {
				goal: { enabled: true, status: "paused", tokensUsed: 12 },
				workflow: { skill: "ralplan" },
				gates: { available: true, pending: [{ kind: "approval", stage: "ralplan", answerable: false }] },
			},
		});
		expect("jobs" in dto).toBe(false);
		expect(JSON.stringify(dto)).not.toContain("private");
		expectCode(() => controller.acknowledgeFailures(dto), "unavailable");
	});

	test("does not read the lazy observation getter after session disposal", () => {
		const f = fixture();
		f.session.isDisposed = true;
		let reads = 0;
		const controller = createDesktopActivityController(
			{
				session: f.result.session,
				get jobObservation(): JobObservation | undefined {
					reads++;
					throw new Error("must not instantiate after disposal");
				},
			},
			f.options,
		);
		controllers.push(controller);
		expect(reads).toBe(0);
		expect(controller.getSnapshot()).toMatchObject({ available: false, reason: expect.stringContaining("disposed") });
	});

	test("trusted-host gate presentation binds the exact SDK identity without exposing it in browser DTOs or retiring UI", async () => {
		const secret = "private-sdk-gate";
		const f = await gateFixture(true, text => text.replaceAll(secret, "[redacted]"));
		const pending = f.emitter.emitGate(approvalGate({ title: secret, plan: "Complete plan" }));
		void pending.catch(() => {});
		const ref = gateRef(f.controller);
		const originalId = f.emitter.listPendingGates()[0]!.gate_id;
		const presentation = f.controller.getGatePresentation(ref);
		expect(presentation.gateId).toBe(originalId);
		expect(presentation.gate).toMatchObject({
			ref,
			truncated: false,
			content: { title: "[redacted]", plan: "Complete plan" },
		});
		expect(JSON.stringify(presentation.gate)).not.toContain(originalId);
		expect(JSON.stringify(f.controller.getSnapshot())).not.toContain(originalId);
		expect(f.retired).toHaveLength(0);
		expect(f.emitter.listPendingGates()).toHaveLength(1);
		// Preview/presentation alone cannot claim SDK acceptance or terminal proof.
		const stillPending = vi.fn();
		void pending.then(stillPending, () => {});
		await Promise.resolve();
		expect(stillPending).not.toHaveBeenCalled();
		await f.controller.answerGate(ref, { kind: "json", json: '{"decision":"reject"}' });
		await expect(pending).resolves.toEqual({ decision: "reject" });
		expect(f.retired).toEqual([originalId]);
	});

	test("trusted-host presentation refuses foreign refs, stale emitters, changed content and disposed sessions", async () => {
		const f = await gateFixture();
		const other = await gateFixture();
		const pending = f.emitter.emitGate(approvalGate());
		void pending.catch(() => {});
		const foreignPending = other.emitter.emitGate(approvalGate());
		void foreignPending.catch(() => {});
		const ref = gateRef(f.controller);
		const foreignRef = gateRef(other.controller);
		expectCode(() => f.controller.getGatePresentation(foreignRef), "stale_connection");
		expectCode(() => f.controller.getGatePresentation({ ...ref, key: foreignRef.key }), "not_found");
		const original = f.emitter.listPendingGates()[0]!;
		const list = vi
			.spyOn(f.emitter, "listPendingGates")
			.mockReturnValue([{ ...original, context: { plan: "successor plan" } }]);
		expectCode(() => f.controller.getGatePresentation(ref), "stale_generation");
		list.mockRestore();
		const emitter = vi.spyOn(f.session, "getWorkflowGateEmitter").mockReturnValue(other.emitter);
		expectCode(() => f.controller.getGatePresentation(ref), "stale_generation");
		emitter.mockRestore();
		f.disposeSession();
		expectCode(() => f.controller.getGatePresentation(ref), "disposed");
		expect(f.retired).toHaveLength(0);
		expect(other.retired).toHaveLength(0);
	});

	test("trusted-host presentation rechecks binding after redaction and never returns a truncated gate identity", async () => {
		let replace: (() => void) | undefined;
		const f = await gateFixture(true, text => {
			replace?.();
			return text;
		});
		const other = await gateFixture();
		const pending = f.emitter.emitGate(approvalGate());
		void pending.catch(() => {});
		const ref = gateRef(f.controller);
		const emitter = vi.spyOn(f.session, "getWorkflowGateEmitter");
		replace = () => {
			replace = undefined;
			emitter.mockReturnValue(other.emitter);
		};
		expectCode(() => f.controller.getGatePresentation(ref), "stale_generation");
		emitter.mockRestore();
		replace = undefined;
		const bounded = await gateFixture();
		const large = bounded.emitter.emitGate(
			approvalGate({ plan: "x".repeat(DESKTOP_ACTIVITY_LIMITS.gateContentChars + 1) }),
		);
		void large.catch(() => {});
		expectCode(() => bounded.controller.getGatePresentation(gateRef(bounded.controller)), "gate_content_too_large");
		expect(bounded.retired).toHaveLength(0);
	});

	test("answers actual structured approval and execution gates without treating decline as approval", async () => {
		const f = await gateFixture();
		const approval = f.emitter.emitGate(approvalGate({ title: "Review this plan", plan: "Exact plan content" }));
		void approval.catch(() => {});
		const ref = gateRef(f.controller);
		await expect(
			f.controller.answerGate(ref, { kind: "json", json: '{"decision":"approve"}' }),
		).rejects.toMatchObject({ code: "gate_not_presented" });
		const gate = f.controller.getGate(ref);
		expect(gate).toMatchObject({
			kind: "approval",
			answerable: true,
			truncated: false,
			content: { plan: "Exact plan content" },
		});
		// Canonical producers advertise complete answer objects, never primitive decisions.
		expect(gate.choices.map(choice => choice.label)).toEqual(["approve", "reject"]);
		expect(gate.optionLabels.map(option => option.label)).toEqual(["approve", "reject"]);
		const rejection = gate.choices.find(choice => choice.label === "reject")!;
		await expect(f.controller.answerGate(ref, { kind: "choice", choiceKey: rejection.key })).resolves.toEqual({
			status: "accepted",
		});
		await expect(approval).resolves.toEqual({ decision: "reject" });
		expect(f.retired).toHaveLength(1);
		expectCode(() => f.controller.getGate(ref), "not_found");
		const execution = f.emitter.emitGate(executionGate({ summary: "Run only after sign-off" }));
		void execution.catch(() => {});
		const next = gateRef(f.controller);
		const executionPresentation = f.controller.getGate(next);
		expect(executionPresentation.choices.map(choice => choice.label)).toEqual(["approve", "decline"]);
		const decline = executionPresentation.choices.find(choice => choice.label === "decline")!;
		await expect(f.controller.answerGate(next, { kind: "choice", choiceKey: decline.key })).resolves.toEqual({
			status: "accepted",
		});
		await expect(execution).resolves.toEqual({ decision: "decline" });
		expect(f.retired).toHaveLength(2);
	});

	test("answers real structured ask selections, custom answers and clarification without made-up choice shapes", async () => {
		const f = await gateFixture();
		for (const answer of [
			{ selected: ["SDK only"] },
			{ selected: ["Shell"] },
			{ selected: [], other: true, custom: "Different scope" },
			{ action: "clarify", question: "Which SDK?" },
		]) {
			const pending = f.emitter.emitGate(
				questionToGate({
					id: "scope",
					question: "Choose the scope",
					options: [{ label: "SDK only" }, { label: "Shell" }],
				}),
			);
			void pending.catch(() => {});
			const ref = gateRef(f.controller);
			const gate = f.controller.getGate(ref);
			expect(gate.content.prompt).toBe("Choose the scope");
			expect(gate.choices.map(choice => choice.label)).toEqual(["SDK only", "Shell"]);
			for (const invalid of [
				"SDK only",
				{ selected: ["Unknown"] },
				{ selected: [], other: true, custom: "   " },
				{ action: "clarify", question: "   " },
			]) {
				await expect(
					f.controller.answerGate(ref, { kind: "json", json: JSON.stringify(invalid) }),
				).rejects.toMatchObject({ code: "invalid_answer" });
			}
			const selected = "selected" in answer ? answer.selected?.[0] : undefined;
			const choice = gate.choices.find(option => option.label === selected);
			const request = choice
				? { kind: "choice" as const, choiceKey: choice.key }
				: { kind: "json" as const, json: JSON.stringify(answer) };
			await expect(f.controller.answerGate(ref, request)).resolves.toEqual({ status: "accepted" });
			await expect(pending).resolves.toEqual(answer);
		}
	});

	test("opaque choice refs submit only original schema-valid whole values and never redact the submitted value", async () => {
		const f = await gateFixture(true, text => text.replaceAll("secret", "[redacted]"));
		const pending = f.emitter.emitGate({
			stage: "ralplan",
			kind: "approval",
			schema: { type: "string", enum: ["secret-value", "reject"] },
			options: [
				{ value: "secret-value", label: "secret label" },
				{ value: "invalid", label: "invalid whole answer" },
			],
			context: { summary: "secret context" },
		});
		void pending.catch(() => {});
		const ref = gateRef(f.controller);
		const gate = f.controller.getGate(ref);
		expect(gate.choices).toHaveLength(1);
		expect(JSON.stringify(gate)).not.toContain("secret");
		expect(gate.choices[0]?.label).toBe("[redacted] label");
		await expect(f.controller.answerGate(ref, { kind: "choice", choiceKey: "forged" })).rejects.toMatchObject({
			code: "invalid_answer",
		});
		await expect(f.controller.answerGate(ref, { kind: "choice", choiceKey: gate.choices[0]!.key })).resolves.toEqual({
			status: "accepted",
		});
		await expect(pending).resolves.toBe("secret-value");
	});

	test("schema display redacts secrets before JSON escaping while choice answers retain original bytes", async () => {
		const secret = 'credential"with\nnewline';
		const f = await gateFixture(true, text => text.replaceAll(secret, "[redacted]"));
		const pending = f.emitter.emitGate({
			stage: "ralplan",
			kind: "approval",
			schema: { type: "string", enum: [secret] },
			options: [{ label: secret, value: secret }],
		});
		void pending.catch(() => {});
		const ref = gateRef(f.controller);
		const gate = f.controller.getGate(ref);
		expect(JSON.parse(gate.schemaJson).enum).toEqual(["[redacted]"]);
		expect(gate.choices[0]?.label).toBe("[redacted]");
		await f.controller.answerGate(ref, { kind: "choice", choiceKey: gate.choices[0]!.key });
		await expect(pending).resolves.toBe(secret);
	});

	test("invalid JSON/schema answers never consume the live gate; backend rejection remains explicit", async () => {
		const f = await gateFixture();
		const pending = f.emitter.emitGate(approvalGate());
		void pending.catch(() => {});
		const ref = gateRef(f.controller);
		f.controller.getGate(ref);
		for (const json of [
			"{broken",
			'"approve"',
			'{"decision":"unknown"}',
			'{"decision":"request-changes"}',
			'{"decision":"request-changes","comments":"   "}',
			"x".repeat(DESKTOP_ACTIVITY_LIMITS.answerBytes + 1),
			"[".repeat(18) + "0" + "]".repeat(18),
			"1e400",
		]) {
			await expect(f.controller.answerGate(ref, { kind: "json", json })).rejects.toMatchObject({
				code: "invalid_answer",
			});
		}
		expect(f.emitter.listPendingGates()).toHaveLength(1);
		const resolve = vi.spyOn(f.emitter, "resolveGate").mockResolvedValueOnce({
			gate_id: "private",
			status: "rejected",
			answer_hash: "private",
			resolved_at: "private",
		});
		await expect(f.controller.answerGate(ref, { kind: "json", json: '{"decision":"approve"}' })).resolves.toEqual({
			status: "rejected",
			reason: expect.stringContaining("original gate schema"),
		});
		resolve.mockRestore();
		await f.controller.answerGate(ref, { kind: "json", json: '{"decision":"approve"}' });
		await expect(pending).resolves.toEqual({ decision: "approve" });
	});

	test("gate answering does not require a background manager when the session exposes its remote emitter", async () => {
		const f = await gateFixture();
		const controller = createDesktopActivityController({ session: f.result.session }, f.options);
		controllers.push(controller);
		const pending = f.emitter.emitGate(approvalGate());
		void pending.catch(() => {});
		const ref = gateRef(controller);
		expect(controller.getSnapshot()).toMatchObject({
			available: false,
			sessionState: { gates: { available: true } },
		});
		controller.getGate(ref);
		await controller.answerGate(ref, {
			kind: "json",
			json: '{"decision":"request-changes","comments":"Tighten scope"}',
		});
		await expect(pending).resolves.toEqual({ decision: "request-changes", comments: "Tighten scope" });
	});

	test("gate refs fence emitter replacement, mutated schema/content/runtime lineage and forged scopes", async () => {
		const f = await gateFixture();
		const pending = f.emitter.emitGate({ ...approvalGate(), runtimeTurnId: "original-turn" });
		void pending.catch(() => {});
		const ref = gateRef(f.controller);
		f.controller.getGate(ref);
		await expect(
			f.controller.answerGate(
				{ ...ref, connectionGeneration: "old" },
				{ kind: "json", json: '{"decision":"approve"}' },
			),
		).rejects.toMatchObject({ code: "stale_connection" });
		await expect(
			f.controller.answerGate(
				{ ...ref, sessionGeneration: "old" },
				{ kind: "json", json: '{"decision":"approve"}' },
			),
		).rejects.toMatchObject({ code: "stale_session" });
		await expect(
			f.controller.answerGate({ ...ref, key: "forged" }, { kind: "json", json: '{"decision":"approve"}' }),
		).rejects.toMatchObject({ code: "not_found" });
		const original = f.emitter.listPendingGates()[0]!;
		const list = vi
			.spyOn(f.emitter, "listPendingGates")
			.mockReturnValue([{ ...original, runtime_turn_id: "successor-turn" }]);
		expectCode(() => f.controller.getGate(ref), "stale_generation");
		list.mockReturnValue([{ ...original, context: { title: "changed plan" } }]);
		await expect(
			f.controller.answerGate(ref, { kind: "json", json: '{"decision":"approve"}' }),
		).rejects.toMatchObject({ code: "stale_generation" });
		list.mockReturnValue([{ ...original, schema: { type: "boolean" } }]);
		expectCode(() => f.controller.getGate(ref), "stale_generation");
		list.mockRestore();
		const successor = await gateFixture();
		vi.spyOn(f.session, "getWorkflowGateEmitter").mockReturnValue(successor.emitter);
		await expect(
			f.controller.answerGate(ref, { kind: "json", json: '{"decision":"approve"}' }),
		).rejects.toMatchObject({ code: "stale_generation" });
		expect(f.retired).toHaveLength(0);
	});

	test("persisted session identity changes fence gates even when the provider-facing session ID does not change", async () => {
		const f = await gateFixture();
		const pending = f.emitter.emitGate(approvalGate());
		void pending.catch(() => {});
		const ref = gateRef(f.controller);
		f.controller.getGate(ref);
		const managerIdentity = vi
			.spyOn(f.session.sessionManager, "getSessionId")
			.mockReturnValue("successor-session-manager-id");
		await expect(
			f.controller.answerGate(ref, { kind: "json", json: '{"decision":"approve"}' }),
		).rejects.toMatchObject({ code: "stale_session" });
		managerIdentity.mockRestore();
		expectCode(() => f.controller.getGatePresentation(ref), "stale_session");
		expect(f.retired).toHaveLength(0);
	});

	test("truncated content cannot become approval authority, and gate DTOs remain detached", async () => {
		const f = await gateFixture();
		const pending = f.emitter.emitGate(
			approvalGate({ plan: "x".repeat(DESKTOP_ACTIVITY_LIMITS.gateContentChars + 1) }),
		);
		void pending.catch(() => {});
		const ref = gateRef(f.controller);
		const dto = f.controller.getGate(ref);
		expect(dto).toMatchObject({
			answerable: false,
			truncated: true,
			reason: expect.stringContaining("safe display limits"),
		});
		dto.answerable = true;
		dto.content.plan = "edited";
		await expect(
			f.controller.answerGate(ref, { kind: "json", json: '{"decision":"approve"}' }),
		).rejects.toMatchObject({ code: "gate_not_presented" });
		expect(f.emitter.listPendingGates()).toHaveLength(1);
		expect(f.retired).toHaveLength(0);
	});

	test("remote capability denial is live, and missing terminal-controller integration is not false success", async () => {
		const f = await gateFixture(false);
		const pending = f.emitter.emitGate(approvalGate());
		void pending.catch(() => {});
		const ref = gateRef(f.controller);
		const remote = vi.spyOn(f.emitter, "supportsRemoteGateAnswers").mockReturnValue(false);
		expect(f.controller.getGate(ref)).toMatchObject({
			answerable: false,
			reason: expect.stringContaining("does not advertise"),
		});
		await expect(
			f.controller.answerGate(ref, { kind: "json", json: '{"decision":"approve"}' }),
		).rejects.toMatchObject({ code: "unsupported" });
		remote.mockRestore();
		f.controller.getGate(ref);
		await expect(
			f.controller.answerGate(ref, { kind: "json", json: '{"decision":"approve"}' }),
		).rejects.toMatchObject({ code: "gate_resolution_failed" });
		await expect(pending).rejects.toThrow("continuation was fenced");
		expect(f.emitter.listPendingGates()).toHaveLength(0);
	});

	test("in-flight gate answers are single-flight and post-await disposal cannot report success", async () => {
		const f = await gateFixture();
		const pending = f.emitter.emitGate(approvalGate());
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
		await expect(
			f.controller.answerGate(ref, { kind: "json", json: '{"decision":"approve"}' }),
		).rejects.toMatchObject({ code: "gate_busy" });
		f.disposeSession();
		release.resolve();
		await expect(answering).rejects.toMatchObject({ code: "disposed" });
	});

	test("gate redaction and request getter reentrancy cannot bypass final disposal fences", async () => {
		let dispose: (() => void) | undefined;
		const f = await gateFixture(true, text => {
			dispose?.();
			return text;
		});
		const pending = f.emitter.emitGate(approvalGate());
		void pending.catch(() => {});
		const ref = gateRef(f.controller);
		dispose = () => f.disposeSession();
		expectCode(() => f.controller.getGate(ref), "disposed");
		expect(f.retired).toHaveLength(0);
		const second = await gateFixture();
		const pendingSecond = second.emitter.emitGate(approvalGate());
		void pendingSecond.catch(() => {});
		const secondRef = gateRef(second.controller);
		second.controller.getGate(secondRef);
		await expect(
			second.controller.answerGate(secondRef, {
				kind: "json",
				get json() {
					second.disposeSession();
					return '{"decision":"approve"}';
				},
			}),
		).rejects.toMatchObject({ code: "disposed" });
		expect(second.retired).toHaveLength(0);
	});

	test("synchronous gate replay cannot leak subscriptions when its listener disposes the adapter", () => {
		const f = fixture();
		let gateSubscriptions = 0;
		const session = {
			...f.session,
			getWorkflowGateEmitter: () => ({
				onGateEmitted: (listener: () => void) => {
					gateSubscriptions++;
					listener();
					return () => {
						gateSubscriptions--;
					};
				},
			}),
		};
		const controller = createDesktopActivityController(
			{ session: session as unknown as CreateAgentSessionResult["session"], jobObservation: f.observation },
			f.options,
		);
		controllers.push(controller);
		expectCode(() => controller.onChange(() => controller.dispose()), "disposed");
		expect(f.listeners.size).toBe(0);
		expect(gateSubscriptions).toBe(0);
	});

	test("payload-free change subscriptions isolate listeners and can be removed", async () => {
		const f = fixture();
		let changes = 0;
		f.controller.onChange(() => {
			throw new Error("subscriber failure");
		});
		const unsubscribe = f.controller.onChange(() => {
			changes++;
		});
		monitor(f.value, f.owner);
		await Bun.sleep(0);
		expect(changes).toBeGreaterThan(0);
		unsubscribe();
		const count = changes;
		monitor(f.value, f.owner);
		await Bun.sleep(0);
		expect(changes).toBe(count);
	});
});
