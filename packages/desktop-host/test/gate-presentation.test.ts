import { afterEach, describe, expect, test, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Agent } from "@gajae-code/agent-core";
import { getBundledModel } from "@gajae-code/ai";
import { AsyncJobManager } from "@gajae-code/coding-agent/async/job-manager";
import { setModelPresetRegistryDisabled } from "@gajae-code/coding-agent/config/model-preset-registry";
import { ModelRegistry } from "@gajae-code/coding-agent/config/model-registry";
import { Settings } from "@gajae-code/coding-agent/config/settings";
import {
	type ExtensionFactory,
	ExtensionRunner,
	loadExtensionFromFactory,
} from "@gajae-code/coding-agent/extensibility/extensions";
import { ExtensionRuntime } from "@gajae-code/coding-agent/extensibility/extensions/loader";
import { JobObservation } from "@gajae-code/coding-agent/sdk/job-observation";
import {
	approvalGate,
	executionGate,
	type OpenGateInput,
	type WorkflowGateEmitter,
	type WorkflowGateTerminalController,
} from "@gajae-code/coding-agent/sdk/workflow-gates";
import { AgentSession } from "@gajae-code/coding-agent/session/agent-session";
import { AuthStorage } from "@gajae-code/coding-agent/session/auth-storage";
import { SessionManager } from "@gajae-code/coding-agent/session/session-manager";
import { EventBus } from "@gajae-code/coding-agent/utils/event-bus";
import { createDesktopActivityController, DESKTOP_ACTIVITY_LIMITS } from "../src/activity-controls";
import type { DesktopActivityRef } from "../src/activity-protocol";
import {
	createDesktopGatePresenter,
	DESKTOP_GATE_PRESENTATION_LIMITS,
	type DesktopGatePresenter,
	type DesktopGatePresenterOptions,
} from "../src/gate-presentation";
import type { DesktopGatePresentation, DesktopGatePresentationEvent } from "../src/gate-presentation-protocol";

type RemoteEmitter = WorkflowGateEmitter &
	Required<
		Pick<
			WorkflowGateEmitter,
			"listPendingGates" | "listWorkflowGateQueryRecords" | "registerGateTerminalController" | "resolveGate"
		>
	>;
type RetireEvent = Extract<DesktopGatePresentationEvent, { type: "retire" }>;
const cleanups: Array<() => Promise<void>> = [];

function assertRemote(emitter: WorkflowGateEmitter | undefined): asserts emitter is RemoteEmitter {
	if (
		!emitter?.listPendingGates ||
		!emitter.listWorkflowGateQueryRecords ||
		!emitter.registerGateTerminalController ||
		!emitter.resolveGate
	)
		throw new Error("Expected a genuine public AgentSession default broker emitter");
}

/** An explicit owner commit seam, NOT browser/DOM evidence. Production React QA is separate. */
class CommittedOwner {
	readonly events: DesktopGatePresentationEvent[] = [];
	readonly mounted = new Set<string>();
	readonly #retireQueue: RetireEvent[] = [];
	readonly #retireWaiters: Array<(event: RetireEvent) => void> = [];
	failDelivery = false;
	onEvent?: (event: DesktopGatePresentationEvent) => void;

	emit = (event: DesktopGatePresentationEvent): void => {
		this.events.push(event);
		this.onEvent?.(event);
		if (this.failDelivery) throw new Error("private transport failure must not escape");
		if (event.type === "retire") {
			const waiter = this.#retireWaiters.shift();
			if (waiter) waiter(event);
			else this.#retireQueue.push(event);
		}
	};

	commitPresented(presenter: DesktopGatePresenter, presentation: DesktopGatePresentation): void {
		if (!this.events.some(event => event.type === "presented" && event.presentation.id === presentation.id))
			throw new Error("Cannot commit a surface that was not delivered");
		this.mounted.add(presentation.id);
		presenter.acknowledgePresented(presentation.id);
	}

	commitRetired(presenter: DesktopGatePresenter, event: RetireEvent): void {
		this.mounted.delete(event.presentationId);
		presenter.acknowledgeRetired(event.presentationId, event.nonce);
	}

	nextRetirement(): Promise<RetireEvent> {
		const queued = this.#retireQueue.shift();
		if (queued) return Promise.resolve(queued);
		const waiter = Promise.withResolvers<RetireEvent>();
		this.#retireWaiters.push(waiter.resolve);
		return waiter.promise;
	}
}

async function fixture(
	options: {
		redact?: (text: string) => string;
		retirementTimeoutMs?: number;
		extensionFactory?: ExtensionFactory;
		compactable?: boolean;
	} = {},
) {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "desktop-gate-presentation-"));
	await setModelPresetRegistryDisabled({ agentDir: root, disabled: true });
	const auth = await AuthStorage.create(path.join(root, "auth.db"));
	const settings = Settings.isolated({ "compaction.enabled": false, "compaction.keepRecentTokens": 1 });
	const registry = new ModelRegistry(auth, path.join(root, "models.yml"), settings, { agentDir: root });
	const jobs = new AsyncJobManager({ onJobComplete: () => {} });
	const ownerId = crypto.randomUUID();
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
				throw new Error("No provider turns in gate presentation tests");
			},
			streamFn: () => {
				throw new Error("No provider turns in gate presentation tests");
			},
		}),
		sessionManager,
		settings,
		modelRegistry: registry,
		extensionRunner,
		agentDir: root,
		workflowGatePublication: "local",
		ownedAsyncJobManager: jobs,
		agentId: ownerId,
		disposeAsyncJobManager: false,
	});
	const emitter = session.getWorkflowGateEmitter();
	assertRemote(emitter);
	const observation = new JobObservation(jobs, ownerId);
	const connectionGeneration = crypto.randomUUID();
	const catalogSessionId = crypto.randomUUID();
	const activity = createDesktopActivityController(
		{ session, jobObservation: observation },
		{
			connectionGeneration,
			redact: options.redact ?? (text => text),
		},
	);
	const ui = new CommittedOwner();
	const binding: { connectionGeneration: string; catalogSessionId: string; alive: boolean } = {
		connectionGeneration,
		catalogSessionId,
		alive: true,
	};
	const presenterOptions: DesktopGatePresenterOptions = {
		session,
		activity,
		connectionGeneration,
		catalogSessionId,
		isCurrent: (connection, catalog) =>
			binding.alive && connection === binding.connectionGeneration && catalog === binding.catalogSessionId,
		emit: ui.emit,
		retirementTimeoutMs: options.retirementTimeoutMs,
	};
	let terminal: WorkflowGateTerminalController | undefined;
	const register = emitter.registerGateTerminalController.bind(emitter);
	vi.spyOn(emitter, "registerGateTerminalController").mockImplementation(controller => {
		const unregister = register(controller);
		terminal = controller;
		return unregister;
	});
	const presenter = createDesktopGatePresenter(presenterOptions);
	cleanups.push(async () => {
		presenter.dispose();
		activity.dispose();
		observation.dispose();
		await session.dispose();
		await jobs.dispose();
		await registry.dispose();
		await settings.close();
		auth.close();
		await fs.rm(root, { recursive: true, force: true });
	});
	return {
		session,
		emitter,
		activity,
		presenter,
		presenterOptions,
		ui,
		binding,
		extensionRunner,
		terminal(): WorkflowGateTerminalController {
			if (!terminal) throw new Error("The genuine broker did not register a terminal controller");
			return terminal;
		},
	};
}

function ref(activity: {
	getSnapshot(): {
		sessionState?: {
			gates: { available: false; reason: string } | { available: true; pending: Array<{ ref: DesktopActivityRef }> };
		};
	};
}): DesktopActivityRef {
	const gates = activity.getSnapshot().sessionState?.gates;
	if (!gates?.available || !gates.pending[0]) throw new Error("Missing genuine emitted workflow gate");
	return gates.pending[0].ref;
}

function observe(emitter: WorkflowGateEmitter, input: OpenGateInput = approvalGate()) {
	const outcome = { advanced: false, answer: undefined as unknown, rejected: false };
	const promise = emitter.emitGate(input).then(
		answer => {
			outcome.advanced = true;
			outcome.answer = answer;
			return answer;
		},
		error => {
			outcome.rejected = true;
			throw error;
		},
	);
	void promise.catch(() => undefined);
	return { outcome, promise };
}

async function flush(): Promise<void> {
	for (let index = 0; index < 12; index++) await Promise.resolve();
}

afterEach(async () => {
	while (cleanups.length) await cleanups.pop()?.();
	vi.restoreAllMocks();
});

describe("real desktop workflow gate presentation", () => {
	for (const decision of ["approve", "decline"] as const) {
		test(`${decision} is accepted only after explicit retirement and preserves its semantic answer`, async () => {
			const f = await fixture();
			const workflow = observe(f.emitter, executionGate({ summary: "Exact execution boundary" }));
			const presentation = f.presenter.present(ref(f.activity));
			f.ui.commitPresented(f.presenter, presentation);
			const answering = f.presenter.answer(presentation.id, {
				kind: "json",
				json: JSON.stringify({ decision, reason: "Operator decision" }),
			});
			const retirement = await f.ui.nextRetirement();
			expect(f.ui.mounted.has(presentation.id)).toBe(true);
			expect(workflow.outcome).toMatchObject({ advanced: false, rejected: false });
			expect(f.emitter.listWorkflowGateQueryRecords()[0]).toMatchObject({
				tag: "accepted",
				post_accept_disposition: "accepted",
			});
			await flush();
			expect(workflow.outcome.advanced).toBe(false);
			f.ui.commitRetired(f.presenter, retirement);
			await expect(answering).resolves.toEqual({ status: "accepted" });
			await expect(workflow.promise).resolves.toEqual({ decision, reason: "Operator decision" });
			expect(workflow.outcome.answer).toEqual({ decision, reason: "Operator decision" });
			expect(f.ui.mounted.size).toBe(0);
			expect(f.emitter.listWorkflowGateQueryRecords()[0]).toMatchObject({
				tag: "accepted",
				post_accept_disposition: "advanced",
			});
		});
	}

	test("GET/read previews, emitted events and forged commit IDs are not presentation or retirement proof", async () => {
		const f = await fixture();
		const workflow = observe(f.emitter);
		const gateRef = ref(f.activity);
		f.activity.getGate(gateRef);
		f.activity.getGatePresentation(gateRef);
		expect(() => f.presenter.acknowledgePresented("forged")).toThrow(
			expect.objectContaining({ code: "invalid_presentation" }),
		);
		const presentation = f.presenter.present(gateRef);
		await expect(
			f.presenter.answer(presentation.id, { kind: "json", json: '{"decision":"approve"}' }),
		).rejects.toMatchObject({ code: "not_presented" });
		expect(() => f.presenter.acknowledgeRetired(presentation.id, "retired")).toThrow(
			expect.objectContaining({ code: "invalid_retirement" }),
		);
		expect(workflow.outcome).toMatchObject({ advanced: false, rejected: false });
	});

	test("wrong nonce, wrong surface, duplicate acknowledgement and foreign-session IDs cannot retire a gate", async () => {
		const f = await fixture();
		const foreign = await fixture();
		const workflow = observe(f.emitter);
		const foreignWorkflow = observe(foreign.emitter);
		const presentation = f.presenter.present(ref(f.activity));
		const other = foreign.presenter.present(ref(foreign.activity));
		f.ui.commitPresented(f.presenter, presentation);
		foreign.ui.commitPresented(foreign.presenter, other);
		await expect(
			f.presenter.answer(other.id, { kind: "json", json: '{"decision":"approve"}' }),
		).rejects.toMatchObject({ code: "invalid_presentation" });
		const answering = f.presenter.answer(presentation.id, { kind: "json", json: '{"decision":"approve"}' });
		const retirement = await f.ui.nextRetirement();
		expect(() => f.presenter.acknowledgeRetired(presentation.id, crypto.randomUUID())).toThrow(
			expect.objectContaining({ code: "invalid_retirement" }),
		);
		expect(() => foreign.presenter.acknowledgeRetired(presentation.id, retirement.nonce)).toThrow(
			expect.objectContaining({ code: "invalid_presentation" }),
		);
		expect(() => f.presenter.acknowledgeRetired(other.id, retirement.nonce)).toThrow(
			expect.objectContaining({ code: "invalid_presentation" }),
		);
		await flush();
		expect(workflow.outcome.advanced).toBe(false);
		expect(foreignWorkflow.outcome.advanced).toBe(false);
		f.ui.commitRetired(f.presenter, retirement);
		await expect(answering).resolves.toEqual({ status: "accepted" });
		expect(() => f.presenter.acknowledgeRetired(presentation.id, retirement.nonce)).toThrow(
			expect.objectContaining({ code: "invalid_retirement" }),
		);
	});

	test("all issued surfaces, including an uncommitted one, must retire before continuation", async () => {
		const f = await fixture();
		const workflow = observe(f.emitter);
		const gateRef = ref(f.activity);
		const first = f.presenter.present(gateRef);
		const second = f.presenter.present(gateRef);
		const neverCommitted = f.presenter.present(gateRef);
		expect(new Set([first.id, second.id, neverCommitted.id]).size).toBe(3);
		f.ui.commitPresented(f.presenter, first);
		f.ui.commitPresented(f.presenter, second);
		const answering = f.presenter.answer(first.id, { kind: "json", json: '{"decision":"approve"}' });
		const retirements = [await f.ui.nextRetirement(), await f.ui.nextRetirement(), await f.ui.nextRetirement()];
		expect(retirements.map(event => event.presentationId).sort()).toEqual(
			[first.id, second.id, neverCommitted.id].sort(),
		);
		f.ui.commitRetired(f.presenter, retirements[1]!);
		f.ui.commitRetired(f.presenter, retirements[0]!);
		await flush();
		expect(workflow.outcome.advanced).toBe(false);
		await expect(
			f.presenter.answer(second.id, { kind: "json", json: '{"decision":"reject"}' }),
		).rejects.toMatchObject({ code: "not_presented" });
		f.ui.commitRetired(f.presenter, retirements[2]!);
		await expect(answering).resolves.toEqual({ status: "accepted" });
		await expect(workflow.promise).resolves.toEqual({ decision: "approve" });
		await expect(
			f.terminal().completeGateInteractions(f.emitter.listWorkflowGateQueryRecords()[0]!.gate_id),
		).resolves.toBe("already_terminal");
	});

	test("withdrawal hides one exact surface without answering and allows a fresh presentation", async () => {
		const f = await fixture();
		const workflow = observe(f.emitter);
		const gateRef = ref(f.activity);
		const first = f.presenter.present(gateRef);
		f.ui.commitPresented(f.presenter, first);
		const withdrawing = f.presenter.withdraw(first.id);
		const withdrawal = await f.ui.nextRetirement();
		f.ui.commitRetired(f.presenter, withdrawal);
		await withdrawing;
		expect(workflow.outcome).toMatchObject({ advanced: false, rejected: false });
		expect(f.emitter.listPendingGates()).toHaveLength(1);
		const reopened = f.presenter.present(gateRef);
		expect(reopened.id).not.toBe(first.id);
		await expect(
			f.presenter.answer(first.id, { kind: "json", json: '{"decision":"approve"}' }),
		).rejects.toMatchObject({ code: "not_presented" });
		f.ui.commitPresented(f.presenter, reopened);
		const answering = f.presenter.answer(reopened.id, {
			kind: "json",
			json: '{"decision":"reject","comments":"Not approved"}',
		});
		f.ui.commitRetired(f.presenter, await f.ui.nextRetirement());
		await expect(answering).resolves.toEqual({ status: "accepted" });
		await expect(workflow.promise).resolves.toEqual({ decision: "reject", comments: "Not approved" });
	});

	test("withdrawAll waits for every exact issued surface across gates without answering workflows", async () => {
		const f = await fixture();
		const firstWorkflow = observe(f.emitter);
		const gateRef = ref(f.activity);
		const first = f.presenter.present(gateRef);
		const second = f.presenter.present(gateRef);
		f.ui.commitPresented(f.presenter, first);
		const secondWorkflow = observe(f.emitter, executionGate());
		const gates = f.activity.getSnapshot().sessionState?.gates;
		if (!gates?.available || !gates.pending[1]) throw new Error("Missing second genuine gate");
		const third = f.presenter.present(gates.pending[1].ref);
		f.ui.commitPresented(f.presenter, third);
		// An already pending single-surface withdrawal must retain its exact nonce.
		const single = f.presenter.withdraw(first.id);
		const initialRetirement = await f.ui.nextRetirement();
		let completed = false;
		const all = f.presenter.withdrawAll().then(() => {
			completed = true;
		});
		const secondRetirement = await f.ui.nextRetirement();
		const thirdRetirement = await f.ui.nextRetirement();
		expect(
			new Set([initialRetirement.presentationId, secondRetirement.presentationId, thirdRetirement.presentationId]),
		).toEqual(new Set([first.id, second.id, third.id]));
		expect(f.ui.events.filter(event => event.type === "retire")).toHaveLength(3);
		expect(() => f.presenter.present(gateRef)).toThrow(expect.objectContaining({ code: "busy" }));
		await expect(
			f.presenter.answer(third.id, { kind: "json", json: '{"decision":"approve"}' }),
		).rejects.toMatchObject({ code: "busy" });
		await expect(f.presenter.withdrawAll()).rejects.toMatchObject({ code: "busy" });
		expect(() => f.presenter.acknowledgeRetired(secondRetirement.presentationId, initialRetirement.nonce)).toThrow(
			expect.objectContaining({ code: "invalid_retirement" }),
		);
		f.ui.commitRetired(f.presenter, thirdRetirement);
		f.ui.commitRetired(f.presenter, initialRetirement);
		await single;
		await flush();
		expect(completed).toBe(false);
		f.ui.commitRetired(f.presenter, secondRetirement);
		await all;
		expect(completed).toBe(true);
		expect(f.ui.mounted.size).toBe(0);
		expect(firstWorkflow.outcome).toMatchObject({ advanced: false, rejected: false });
		expect(secondWorkflow.outcome).toMatchObject({ advanced: false, rejected: false });
		expect(f.emitter.listPendingGates()).toHaveLength(2);
		const count = f.ui.events.length;
		await f.presenter.withdrawAll();
		expect(f.ui.events).toHaveLength(count);
		// Withdrawal is not a workflow disposition; fresh opaque representations may reopen.
		expect(f.presenter.present(gateRef).id).not.toBe(first.id);
	});

	test("withdrawAll leaves failed/unproven evidence blocking instead of releasing on a deadline", async () => {
		const f = await fixture({ retirementTimeoutMs: 20 });
		const workflow = observe(f.emitter);
		const presentation = f.presenter.present(ref(f.activity));
		f.ui.commitPresented(f.presenter, presentation);
		const all = f.presenter.withdrawAll();
		const retirement = await f.ui.nextRetirement();
		await expect(all).rejects.toMatchObject({ code: "retirement_timeout" });
		await expect(f.presenter.withdrawAll()).rejects.toMatchObject({ code: "invalid_retirement" });
		expect(() => f.presenter.acknowledgeRetired(presentation.id, retirement.nonce)).toThrow(
			expect.objectContaining({ code: "invalid_retirement" }),
		);
		expect(workflow.outcome).toMatchObject({ advanced: false, rejected: false });
		expect(f.emitter.listPendingGates()).toHaveLength(1);
		expect(f.ui.mounted.has(presentation.id)).toBe(true);
	});

	test("withdrawAll disposal rejects outstanding waits and never releases the live controller slot", async () => {
		const f = await fixture();
		const workflow = observe(f.emitter);
		const presentation = f.presenter.present(ref(f.activity));
		f.ui.commitPresented(f.presenter, presentation);
		const all = f.presenter.withdrawAll();
		const retirement = await f.ui.nextRetirement();
		f.presenter.dispose();
		await expect(all).rejects.toMatchObject({ code: "revoked" });
		expect(() => f.presenter.acknowledgeRetired(presentation.id, retirement.nonce)).toThrow(
			expect.objectContaining({ code: "revoked" }),
		);
		expect(() => createDesktopGatePresenter(f.presenterOptions)).toThrow(
			expect.objectContaining({ code: "registration_failed" }),
		);
		expect(workflow.outcome.advanced).toBe(false);
	});

	test("withdrawAll before same-ID clear retires genuine surfaces before committed revocation", async () => {
		const f = await fixture();
		const workflow = observe(f.emitter);
		const presentation = f.presenter.present(ref(f.activity));
		f.ui.commitPresented(f.presenter, presentation);
		const all = f.presenter.withdrawAll();
		const retirement = await f.ui.nextRetirement();
		f.ui.commitRetired(f.presenter, retirement);
		await all;
		expect(f.ui.mounted.size).toBe(0);
		expect(workflow.outcome.advanced).toBe(false);
		const id = f.session.sessionId;
		expect(await f.session.clearContext()).toBe(true);
		expect(f.session.sessionId).toBe(id);
		expect(() => f.presenter.acknowledgeRetired(presentation.id, retirement.nonce)).toThrow(
			expect.objectContaining({ code: "revoked" }),
		);
		// Context clear preserves SDK gate ownership; hiding did not answer it.
		expect(workflow.outcome).toMatchObject({ advanced: false, rejected: false });
	});

	test("same-generation cancelled preparation leaves an in-flight retirement nonce pending for later authentic ack", async () => {
		const entered = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		const f = await fixture({
			extensionFactory: api => {
				api.on("session_before_switch", async () => {
					entered.resolve();
					await release.promise;
					return { cancel: true };
				});
			},
		});
		const workflow = observe(f.emitter);
		const presentation = f.presenter.present(ref(f.activity));
		f.ui.commitPresented(f.presenter, presentation);
		const all = f.presenter.withdrawAll();
		const retirement = await f.ui.nextRetirement();
		const preparing = f.session.newSession();
		await entered.promise;
		f.session.emitNotice("info", "Preparing while a retirement is outstanding", "test");
		expect(() => f.presenter.acknowledgeRetired(presentation.id, retirement.nonce)).toThrow(
			expect.objectContaining({ code: "busy" }),
		);
		release.resolve();
		expect(await preparing).toBe(false);
		f.ui.commitRetired(f.presenter, retirement);
		await all;
		expect(workflow.outcome).toMatchObject({ advanced: false, rejected: false });
		expect(f.ui.mounted.size).toBe(0);
	});

	test("missing acknowledgements time out into canonical quarantine, never workflow continuation", async () => {
		const f = await fixture({ retirementTimeoutMs: 20 });
		const workflow = observe(f.emitter);
		const presentation = f.presenter.present(ref(f.activity));
		f.ui.commitPresented(f.presenter, presentation);
		const answering = f.presenter.answer(presentation.id, { kind: "json", json: '{"decision":"approve"}' });
		const retirement = await f.ui.nextRetirement();
		await expect(answering).rejects.toMatchObject({ code: "gate_resolution_failed" });
		await expect(workflow.promise).rejects.toThrow("continuation was fenced");
		expect(workflow.outcome.advanced).toBe(false);
		expect(f.emitter.listWorkflowGateQueryRecords()[0]).toMatchObject({ tag: "quarantined", answer_recorded: true });
		expect(() => f.presenter.acknowledgeRetired(presentation.id, retirement.nonce)).toThrow();
		expect(f.ui.mounted.has(presentation.id)).toBe(true);
	});

	for (const teardown of ["presenter", "session", "activity", "connection", "catalog"] as const) {
		test(`${teardown} teardown during retirement rejects rather than synthesizing proof`, async () => {
			const f = await fixture();
			const workflow = observe(f.emitter);
			const presentation = f.presenter.present(ref(f.activity));
			f.ui.commitPresented(f.presenter, presentation);
			const answering = f.presenter.answer(presentation.id, { kind: "json", json: '{"decision":"approve"}' });
			void answering.catch(() => undefined);
			const retirement = await f.ui.nextRetirement();
			if (teardown === "session") await f.session.dispose();
			else if (teardown === "presenter") f.presenter.dispose();
			else if (teardown === "activity") {
				f.activity.dispose();
				expect(() => f.presenter.acknowledgeRetired(presentation.id, retirement.nonce)).toThrow(
					expect.objectContaining({ code: "revoked" }),
				);
			} else {
				if (teardown === "connection") f.binding.connectionGeneration = crypto.randomUUID();
				else f.binding.catalogSessionId = crypto.randomUUID();
				expect(() => f.presenter.acknowledgeRetired(presentation.id, retirement.nonce)).toThrow(
					expect.objectContaining({ code: "revoked" }),
				);
				// A -> B -> A must not revive an observed/revoked binding.
				f.binding.connectionGeneration = f.presenterOptions.connectionGeneration;
				f.binding.catalogSessionId = f.presenterOptions.catalogSessionId;
			}
			await expect(answering).rejects.toThrow();
			await expect(workflow.promise).rejects.toThrow("continuation was fenced");
			expect(workflow.outcome.advanced).toBe(false);
			expect(() => f.presenter.acknowledgeRetired(presentation.id, retirement.nonce)).toThrow(
				expect.objectContaining({ code: "revoked" }),
			);
		});
	}

	test("generic SDK notifications preserve the committed presentation and its genuine terminal controller", async () => {
		const f = await fixture();
		const workflow = observe(f.emitter);
		const gateRef = ref(f.activity);
		const presentation = f.presenter.present(gateRef);
		f.ui.commitPresented(f.presenter, presentation);
		const lifecycle = f.session.sessionLifecycle;
		f.session.emitNotice("info", "Ordinary observer notification", "test");
		await f.session.notifySessionIdentityChanged();
		expect(f.session.sessionLifecycle).toEqual(lifecycle);
		expect(f.ui.events.filter(event => event.type === "retire")).toEqual([]);
		const answering = f.presenter.answer(presentation.id, { kind: "json", json: '{"decision":"reject"}' });
		f.ui.commitRetired(f.presenter, await f.ui.nextRetirement());
		await expect(answering).resolves.toEqual({ status: "accepted" });
		await expect(workflow.promise).resolves.toEqual({ decision: "reject" });
	});

	test("cancelled real preparation is temporarily busy without deleting committed presentation evidence", async () => {
		const entered = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		const f = await fixture({
			extensionFactory: api => {
				api.on("session_before_switch", async () => {
					entered.resolve();
					await release.promise;
					return { cancel: true };
				});
			},
		});
		const workflow = observe(f.emitter);
		const gateRef = ref(f.activity);
		const presentation = f.presenter.present(gateRef);
		f.ui.commitPresented(f.presenter, presentation);
		const lifecycle = f.session.sessionLifecycle;
		const preparing = f.session.newSession();
		await entered.promise;
		expect(f.session.sessionLifecycle).toMatchObject({ generation: lifecycle.generation, transitioning: true });
		f.session.emitNotice("info", "Preparation still owns the transition", "test");
		expect(() => createDesktopGatePresenter(f.presenterOptions)).toThrow(expect.objectContaining({ code: "busy" }));
		expect(() => f.presenter.present(gateRef)).toThrow(expect.objectContaining({ code: "busy" }));
		expect(() => f.presenter.acknowledgePresented(presentation.id)).toThrow(
			expect.objectContaining({ code: "busy" }),
		);
		await expect(
			f.presenter.answer(presentation.id, { kind: "json", json: '{"decision":"approve"}' }),
		).rejects.toMatchObject({ code: "busy" });
		await expect(f.presenter.withdrawAll()).rejects.toMatchObject({ code: "busy" });
		expect(f.ui.events.filter(event => event.type === "retire")).toEqual([]);
		release.resolve();
		expect(await preparing).toBe(false);
		expect(f.session.sessionLifecycle).toEqual(lifecycle);
		const answering = f.presenter.answer(presentation.id, { kind: "json", json: '{"decision":"reject"}' });
		f.ui.commitRetired(f.presenter, await f.ui.nextRetirement());
		await expect(answering).resolves.toEqual({ status: "accepted" });
		await expect(workflow.promise).resolves.toEqual({ decision: "reject" });
	});

	test("failed genuine preparation preserves the exact presentation after rollback", async () => {
		const f = await fixture({
			extensionFactory: api => {
				api.on("session_before_switch", async () => undefined);
			},
		});
		if (!f.extensionRunner) throw new Error("Expected the genuine extension runner");
		const workflow = observe(f.emitter);
		const presentation = f.presenter.present(ref(f.activity));
		f.ui.commitPresented(f.presenter, presentation);
		const lifecycle = f.session.sessionLifecycle;
		vi.spyOn(f.extensionRunner, "emit").mockRejectedValueOnce(new Error("controlled preparation failure"));
		await expect(f.session.newSession()).rejects.toThrow("controlled preparation failure");
		expect(f.session.sessionLifecycle).toEqual(lifecycle);
		f.session.emitNotice("info", "Unchanged committed owner after failure", "test");
		const answering = f.presenter.answer(presentation.id, { kind: "json", json: '{"decision":"approve"}' });
		f.ui.commitRetired(f.presenter, await f.ui.nextRetirement());
		await expect(answering).resolves.toEqual({ status: "accepted" });
		await expect(workflow.promise).resolves.toEqual({ decision: "approve" });
	});

	test("unchanged genuine compaction temporarily refuses gate controls and preserves issued evidence", async () => {
		const entered = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		const f = await fixture({
			compactable: true,
			extensionFactory: api => {
				api.on("session_before_compact", async event => {
					entered.resolve();
					await release.promise;
					return {
						compaction: {
							summary: "Provider-free gate continuity compaction",
							firstKeptEntryId: event.preparation.firstKeptEntryId,
							tokensBefore: event.preparation.tokensBefore,
							details: {},
						},
					};
				});
			},
		});
		const workflow = observe(f.emitter);
		const gateRef = ref(f.activity);
		const presentation = f.presenter.present(gateRef);
		f.ui.commitPresented(f.presenter, presentation);
		const lifecycle = f.session.sessionLifecycle;
		const compacting = f.session.compact();
		await entered.promise;
		f.session.emitNotice("info", "Notification during unchanged compaction", "test");
		expect(f.session.sessionLifecycle).toMatchObject({ generation: lifecycle.generation, transitioning: true });
		expect(() => f.presenter.present(gateRef)).toThrow(expect.objectContaining({ code: "busy" }));
		await expect(
			f.presenter.answer(presentation.id, { kind: "json", json: '{"decision":"approve"}' }),
		).rejects.toMatchObject({ code: "busy" });
		expect(f.ui.events.filter(event => event.type === "retire")).toEqual([]);
		release.resolve();
		expect((await compacting).summary).toBe("Provider-free gate continuity compaction");
		expect(f.session.sessionLifecycle).toEqual(lifecycle);
		expect(f.session.getWorkflowGateEmitter()).toBe(f.emitter);
		const answering = f.presenter.answer(presentation.id, { kind: "json", json: '{"decision":"reject"}' });
		f.ui.commitRetired(f.presenter, await f.ui.nextRetirement());
		await expect(answering).resolves.toEqual({ status: "accepted" });
		await expect(workflow.promise).resolves.toEqual({ decision: "reject" });
	});

	test("same-ID clear changes committed SDK generation and never revives an old presentation", async () => {
		const f = await fixture();
		const workflow = observe(f.emitter);
		const gateRef = ref(f.activity);
		const presentation = f.presenter.present(gateRef);
		f.ui.commitPresented(f.presenter, presentation);
		const id = f.session.sessionId;
		const generation = f.session.sessionLifecycle.generation;
		expect(await f.session.clearContext()).toBe(true);
		expect(f.session.sessionId).toBe(id);
		expect(f.session.sessionLifecycle.generation).toBeGreaterThan(generation);
		expect(() => f.presenter.acknowledgePresented(presentation.id)).toThrow(
			expect.objectContaining({ code: "revoked" }),
		);
		await expect(
			f.presenter.answer(presentation.id, { kind: "json", json: '{"decision":"approve"}' }),
		).rejects.toMatchObject({ code: "revoked" });
		expect(() => f.presenter.acknowledgeRetired(presentation.id, "forged")).toThrow(
			expect.objectContaining({ code: "revoked" }),
		);
		expect(await f.session.clearContext()).toBe(true);
		expect(() => f.presenter.present(gateRef)).toThrow(expect.objectContaining({ code: "revoked" }));
		expect(workflow.outcome).toMatchObject({ advanced: false, rejected: false });
	});

	test("same-string SessionManager replacement outside preparation permanently fences observed ABA", async () => {
		const f = await fixture();
		const workflow = observe(f.emitter);
		const presentation = f.presenter.present(ref(f.activity));
		f.ui.commitPresented(f.presenter, presentation);
		const original = f.session.sessionManager;
		const replacement = SessionManager.inMemory(original.getCwd());
		vi.spyOn(replacement, "getSessionId").mockReturnValue(original.getSessionId());
		f.session.sessionManager = replacement;
		f.session.emitNotice("info", "Changed manager object without a transition", "test");
		f.session.sessionManager = original;
		await expect(
			f.presenter.answer(presentation.id, { kind: "json", json: '{"decision":"approve"}' }),
		).rejects.toMatchObject({ code: "revoked" });
		expect(workflow.outcome.advanced).toBe(false);
	});

	test("real session transitions permanently invalidate the presenter and captured references", async () => {
		const f = await fixture();
		const workflow = observe(f.emitter);
		const gateRef = ref(f.activity);
		const presentation = f.presenter.present(gateRef);
		f.ui.commitPresented(f.presenter, presentation);
		await expect(f.session.newSession()).resolves.toBe(true);
		expect(() => f.presenter.present(gateRef)).toThrow(expect.objectContaining({ code: "revoked" }));
		await expect(
			f.presenter.answer(presentation.id, { kind: "json", json: '{"decision":"approve"}' }),
		).rejects.toMatchObject({ code: "revoked" });
		await expect(workflow.promise).rejects.toThrow("continuation was fenced");
		expect(workflow.outcome.advanced).toBe(false);
	});

	test("emitter replacement is latched across A -> B -> A and cannot finish pending retirement", async () => {
		const f = await fixture();
		const other = await fixture();
		const workflow = observe(f.emitter);
		const presentation = f.presenter.present(ref(f.activity));
		f.ui.commitPresented(f.presenter, presentation);
		const answering = f.presenter.answer(presentation.id, { kind: "json", json: '{"decision":"approve"}' });
		const retirement = await f.ui.nextRetirement();
		f.session.setWorkflowGateEmitter(other.emitter);
		expect(() => f.presenter.acknowledgeRetired(presentation.id, retirement.nonce)).toThrow(
			expect.objectContaining({ code: "revoked" }),
		);
		f.session.setWorkflowGateEmitter(f.emitter);
		expect(() => f.presenter.acknowledgeRetired(presentation.id, retirement.nonce)).toThrow(
			expect.objectContaining({ code: "revoked" }),
		);
		await expect(answering).rejects.toThrow();
		await expect(workflow.promise).rejects.toThrow("continuation was fenced");
		expect(workflow.outcome.advanced).toBe(false);
	});

	test("post-ack identity change before the awaited proof settles still fails closed", async () => {
		const f = await fixture();
		const workflow = observe(f.emitter);
		const presentation = f.presenter.present(ref(f.activity));
		f.ui.commitPresented(f.presenter, presentation);
		const answering = f.presenter.answer(presentation.id, { kind: "json", json: '{"decision":"approve"}' });
		const retirement = await f.ui.nextRetirement();
		f.ui.commitRetired(f.presenter, retirement);
		f.binding.alive = false;
		await expect(answering).rejects.toThrow();
		await expect(workflow.promise).rejects.toThrow("continuation was fenced");
		expect(workflow.outcome.advanced).toBe(false);
	});

	test("an existing genuine controller is never displaced by a second presenter", async () => {
		const f = await fixture();
		expect(() => createDesktopGatePresenter(f.presenterOptions)).toThrow(
			expect.objectContaining({ code: "registration_failed" }),
		);
		const workflow = observe(f.emitter);
		const presentation = f.presenter.present(ref(f.activity));
		f.ui.commitPresented(f.presenter, presentation);
		const answering = f.presenter.answer(presentation.id, { kind: "json", json: '{"decision":"approve"}' });
		f.ui.commitRetired(f.presenter, await f.ui.nextRetirement());
		await expect(answering).resolves.toEqual({ status: "accepted" });
		await expect(workflow.promise).resolves.toEqual({ decision: "approve" });
	});

	test("missing public emitter capability is explicit rather than a fabricated terminal controller", async () => {
		const f = await fixture();
		f.presenter.dispose();
		const unavailable = vi.spyOn(f.session, "getWorkflowGateEmitter").mockReturnValue(undefined);
		expect(() => createDesktopGatePresenter(f.presenterOptions)).toThrow(
			expect.objectContaining({ code: "unavailable" }),
		);
		unavailable.mockRestore();
		expect(f.ui.events).toEqual([]);
	});

	test("unknown/unissued gates reject rather than producing not_published from read-only observation", async () => {
		const f = await fixture();
		const workflow = observe(f.emitter);
		f.activity.getGatePresentation(ref(f.activity));
		const gate = f.emitter.listPendingGates()[0]!;
		await expect(f.terminal().completeGateInteractions(gate.gate_id)).rejects.toMatchObject({
			code: "invalid_presentation",
		});
		await expect(f.terminal().completeGateInteractions("foreign-backend-id")).rejects.toMatchObject({
			code: "invalid_presentation",
		});
		await expect(f.emitter.resolveGate({ gate_id: gate.gate_id, answer: { decision: "approve" } })).rejects.toThrow();
		await expect(workflow.promise).rejects.toThrow("continuation was fenced");
		expect(f.ui.events).toEqual([]);
		expect(workflow.outcome.advanced).toBe(false);
	});

	test("cancellation retires only the exact gate's surfaces without claiming workflow acceptance", async () => {
		const f = await fixture();
		const firstWorkflow = observe(f.emitter);
		const firstGate = f.emitter.listPendingGates()[0]!;
		const first = f.presenter.present(ref(f.activity));
		const secondWorkflow = observe(f.emitter, executionGate());
		const gates = f.activity.getSnapshot().sessionState?.gates;
		if (!gates?.available || !gates.pending[1]) throw new Error("Missing second gate");
		const second = f.presenter.present(gates.pending[1].ref);
		f.ui.commitPresented(f.presenter, first);
		f.ui.commitPresented(f.presenter, second);
		const cancel = f.terminal().cancelGateInteractions(firstGate.gate_id, "cancel exact representation");
		const retirement = await f.ui.nextRetirement();
		expect(retirement.presentationId).toBe(first.id);
		f.ui.commitRetired(f.presenter, retirement);
		await cancel;
		expect(f.ui.mounted.has(second.id)).toBe(true);
		expect(firstWorkflow.outcome).toMatchObject({ advanced: false, rejected: false });
		expect(secondWorkflow.outcome).toMatchObject({ advanced: false, rejected: false });
		expect(f.emitter.listPendingGates()).toHaveLength(2);
	});

	test("projection is bounded/redacted and never exposes backend IDs, original schema or authority", async () => {
		const secret = 'credential"with\nnewline';
		const f = await fixture({ redact: text => text.replaceAll(secret, "[redacted]") });
		const workflow = observe(f.emitter, {
			stage: "ralplan",
			kind: "approval",
			schema: { type: "string", enum: [secret, "reject"] },
			options: [
				{ value: secret, label: secret },
				{ value: "reject", label: "Reject" },
			],
			context: { summary: secret, artifact_refs: [{ kind: "evidence", path: secret }] },
		});
		const gateId = f.emitter.listPendingGates()[0]!.gate_id;
		const gateRef = ref(f.activity);
		const presentation = f.presenter.present(gateRef);
		const another = f.presenter.present(gateRef);
		const wire = JSON.stringify(f.ui.events);
		expect(wire).not.toContain(gateId);
		expect(wire).not.toContain("gate_id");
		expect(wire).not.toContain("schema_hash");
		expect(wire).not.toContain("credential");
		expect(wire).not.toContain("idempotency");
		expect(JSON.parse(presentation.gate.schemaJson).enum).toEqual(["[redacted]", "reject"]);
		f.ui.commitPresented(f.presenter, presentation);
		// A read/re-presentation rotates adapter keys, not the issued option's original value.
		f.activity.getGate(gateRef);
		const answering = f.presenter.answer(presentation.id, {
			kind: "choice",
			choiceKey: presentation.gate.choices[0]!.key,
		});
		const retirementA = await f.ui.nextRetirement();
		const retirementB = await f.ui.nextRetirement();
		expect(new Set([retirementA.presentationId, retirementB.presentationId])).toEqual(
			new Set([presentation.id, another.id]),
		);
		f.ui.commitRetired(f.presenter, retirementA);
		f.ui.commitRetired(f.presenter, retirementB);
		await expect(answering).resolves.toEqual({ status: "accepted" });
		await expect(workflow.promise).resolves.toBe(secret);
		expect(JSON.stringify(f.ui.events)).not.toContain(gateId);
	});

	test("truncation and failed redaction cannot issue an answerable surface", async () => {
		const large = await fixture();
		const largeWorkflow = observe(
			large.emitter,
			approvalGate({ plan: "x".repeat(DESKTOP_ACTIVITY_LIMITS.gateContentChars + 1) }),
		);
		expect(() => large.presenter.present(ref(large.activity))).toThrow(
			expect.objectContaining({ code: "gate_content_too_large" }),
		);
		expect(large.ui.events).toEqual([]);
		expect(largeWorkflow.outcome.advanced).toBe(false);
		let fail = false;
		const redaction = await fixture({
			redact: text => {
				if (fail && text.includes("sensitive")) throw new Error("sensitive");
				return text;
			},
		});
		const redactedWorkflow = observe(redaction.emitter, approvalGate({ plan: "sensitive" }));
		const gateRef = ref(redaction.activity);
		fail = true;
		expect(() => redaction.presenter.present(gateRef)).toThrow(expect.objectContaining({ code: "redaction_failed" }));
		expect(redaction.ui.events).toEqual([]);
		expect(redactedWorkflow.outcome.advanced).toBe(false);
	});

	test("renderer DTO/ref/option mutation and mutable constructor options cannot retarget authority", async () => {
		const f = await fixture();
		const foreign = await fixture();
		const workflow = observe(f.emitter);
		const otherWorkflow = observe(foreign.emitter);
		const gateRef = ref(f.activity);
		const presentation = f.presenter.present(gateRef);
		const id = presentation.id;
		gateRef.key = "forged";
		presentation.gate.ref.key = "forged";
		presentation.gate.content.plan = "Changed by renderer";
		f.presenterOptions.session = foreign.session;
		f.presenterOptions.activity = foreign.activity;
		f.presenterOptions.connectionGeneration = foreign.presenterOptions.connectionGeneration;
		f.presenterOptions.catalogSessionId = foreign.presenterOptions.catalogSessionId;
		f.presenterOptions.isCurrent = () => false;
		f.presenterOptions.emit = foreign.ui.emit;
		f.ui.commitPresented(f.presenter, presentation);
		const answering = f.presenter.answer(id, { kind: "json", json: '{"decision":"approve"}' });
		f.ui.commitRetired(f.presenter, await f.ui.nextRetirement());
		await expect(answering).resolves.toEqual({ status: "accepted" });
		await expect(workflow.promise).resolves.toEqual({ decision: "approve" });
		expect(otherWorkflow.outcome.advanced).toBe(false);
		expect(foreign.ui.events).toEqual([]);
	});

	test("changed original gate or changed redacted display cannot answer an old committed surface", async () => {
		let redactionEpoch = 0;
		const f = await fixture({ redact: text => (text === "original plan" ? `${text} ${redactionEpoch}` : text) });
		const workflow = observe(f.emitter, approvalGate({ plan: "original plan" }));
		const gate = f.emitter.listPendingGates()[0]!;
		const presentation = f.presenter.present(ref(f.activity));
		f.ui.commitPresented(f.presenter, presentation);
		redactionEpoch++;
		await expect(
			f.presenter.answer(presentation.id, { kind: "json", json: '{"decision":"approve"}' }),
		).rejects.toMatchObject({ code: "stale_presentation" });
		redactionEpoch--;
		vi.spyOn(f.emitter, "listPendingGates").mockReturnValue([{ ...gate, context: { plan: "successor" } }]);
		await expect(
			f.presenter.answer(presentation.id, { kind: "json", json: '{"decision":"approve"}' }),
		).rejects.toMatchObject({ code: "stale_presentation" });
		expect(workflow.outcome.advanced).toBe(false);
		expect(() => f.presenter.acknowledgePresented(presentation.id)).toThrow(
			expect.objectContaining({ code: "revoked" }),
		);
	});

	test("accepted gate fingerprints are rechecked after awaiting authentic retirement", async () => {
		const f = await fixture();
		const workflow = observe(f.emitter);
		const presentation = f.presenter.present(ref(f.activity));
		f.ui.commitPresented(f.presenter, presentation);
		const answering = f.presenter.answer(presentation.id, { kind: "json", json: '{"decision":"approve"}' });
		const retirement = await f.ui.nextRetirement();
		f.ui.commitRetired(f.presenter, retirement);
		const query = f.emitter.listWorkflowGateQueryRecords.bind(f.emitter);
		const changed = vi
			.spyOn(f.emitter, "listWorkflowGateQueryRecords")
			.mockImplementation(() => query().map(row => ({ ...row, context: { plan: "replacement after ack" } })));
		await expect(answering).rejects.toThrow();
		await expect(workflow.promise).rejects.toThrow("continuation was fenced");
		expect(workflow.outcome.advanced).toBe(false);
		changed.mockRestore();
	});

	test("revoked unproven surfaces retain controller ownership so replacement cannot forget them", async () => {
		const f = await fixture();
		const workflow = observe(f.emitter);
		const presentation = f.presenter.present(ref(f.activity));
		f.ui.commitPresented(f.presenter, presentation);
		f.presenter.dispose();
		expect(() => createDesktopGatePresenter(f.presenterOptions)).toThrow(
			expect.objectContaining({ code: "registration_failed" }),
		);
		expect(workflow.outcome.advanced).toBe(false);
		const gate = f.emitter.listPendingGates()[0]!;
		await expect(f.emitter.resolveGate({ gate_id: gate.gate_id, answer: { decision: "approve" } })).rejects.toThrow();
		await expect(workflow.promise).rejects.toThrow("continuation was fenced");
		expect(workflow.outcome.advanced).toBe(false);
	});

	for (const phase of ["presented", "retire"] as const) {
		test(`${phase} callback failure is explicit and cannot manufacture terminal proof`, async () => {
			const f = await fixture();
			const workflow = observe(f.emitter);
			if (phase === "presented") {
				f.ui.failDelivery = true;
				expect(() => f.presenter.present(ref(f.activity))).toThrow(
					expect.objectContaining({ code: "callback_failed" }),
				);
				expect(workflow.outcome.advanced).toBe(false);
				expect(() => f.presenter.present(ref(f.activity))).toThrow(expect.objectContaining({ code: "revoked" }));
			} else {
				const presentation = f.presenter.present(ref(f.activity));
				f.ui.commitPresented(f.presenter, presentation);
				f.ui.failDelivery = true;
				await expect(
					f.presenter.answer(presentation.id, { kind: "json", json: '{"decision":"approve"}' }),
				).rejects.toThrow();
				await expect(workflow.promise).rejects.toThrow("continuation was fenced");
				expect(workflow.outcome.advanced).toBe(false);
			}
		});
	}

	test("synchronous event/ack reentrancy is rejected, not mistaken for an authentic UI commit", async () => {
		const f = await fixture();
		const workflow = observe(f.emitter);
		const presentation = f.presenter.present(ref(f.activity));
		f.ui.commitPresented(f.presenter, presentation);
		f.ui.onEvent = event => {
			if (event.type === "retire") f.presenter.acknowledgeRetired(event.presentationId, event.nonce);
		};
		await expect(
			f.presenter.answer(presentation.id, { kind: "json", json: '{"decision":"approve"}' }),
		).rejects.toThrow();
		await expect(workflow.promise).rejects.toThrow("continuation was fenced");
		expect(workflow.outcome.advanced).toBe(false);
	});

	test("request getter reentrancy cannot revoke then sneak an answer through final checks", async () => {
		const f = await fixture();
		const workflow = observe(f.emitter);
		const presentation = f.presenter.present(ref(f.activity));
		f.ui.commitPresented(f.presenter, presentation);
		await expect(
			f.presenter.answer(presentation.id, {
				kind: "json",
				get json() {
					f.presenter.revoke();
					return '{"decision":"approve"}';
				},
			}),
		).rejects.toMatchObject({ code: "revoked" });
		expect(workflow.outcome.advanced).toBe(false);
	});

	test("invalid whole answers and forged choice keys never enter broker retirement", async () => {
		const f = await fixture();
		const workflow = observe(f.emitter);
		const presentation = f.presenter.present(ref(f.activity));
		f.ui.commitPresented(f.presenter, presentation);
		for (const json of ['{"decision":"invented"}', '"approve"', '{"decision":"approve","extra":true}', "{"])
			await expect(f.presenter.answer(presentation.id, { kind: "json", json })).rejects.toMatchObject({
				code: "invalid_answer",
			});
		await expect(f.presenter.answer(presentation.id, { kind: "choice", choiceKey: "forged" })).rejects.toMatchObject({
			code: "invalid_answer",
		});
		expect(f.ui.events.filter(event => event.type === "retire")).toEqual([]);
		expect(workflow.outcome).toMatchObject({ advanced: false, rejected: false });
	});

	test("capacity refuses new representations instead of evicting terminal evidence", async () => {
		const f = await fixture();
		const workflow = observe(f.emitter);
		const gateRef = ref(f.activity);
		let first: DesktopGatePresentation | undefined;
		for (let index = 0; index < DESKTOP_GATE_PRESENTATION_LIMITS.presentations; index++) {
			const presentation = f.presenter.present(gateRef);
			first ??= presentation;
			const withdrawing = f.presenter.withdraw(presentation.id);
			f.ui.commitRetired(f.presenter, await f.ui.nextRetirement());
			await withdrawing;
		}
		expect(() => f.presenter.present(gateRef)).toThrow(expect.objectContaining({ code: "capacity" }));
		expect(f.ui.events.filter(event => event.type === "presented")).toHaveLength(
			DESKTOP_GATE_PRESENTATION_LIMITS.presentations,
		);
		if (!first) throw new Error("Missing first retained presentation");
		await expect(
			f.presenter.answer(first.id, { kind: "json", json: '{"decision":"approve"}' }),
		).rejects.toMatchObject({ code: "not_presented" });
		await expect(f.terminal().completeGateInteractions(f.emitter.listPendingGates()[0]!.gate_id)).resolves.toBe(
			"already_terminal",
		);
		expect(workflow.outcome).toMatchObject({ advanced: false, rejected: false });
	});
});
