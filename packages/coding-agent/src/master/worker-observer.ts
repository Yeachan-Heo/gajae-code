import { createHash, randomUUID } from "node:crypto";
import type { MasterCoordinatorGateway } from "./coordinator-gateway";
import type { MasterDomainStore } from "./domain-store";
import type {
	LeaseReceipt,
	ObserveWorkerInput,
	PromptPendingReceipt,
	PromptReconcileReceipt,
	WorkerCreateIntent,
	WorkerCreateReceipt,
	WorkerObservationReceipt,
} from "./types";

export interface WorkerObserverCoordinator {
	startSession?(input: {
		cwd: string;
		idempotency_key: string;
		allow_mutation?: true;
	}): Promise<Record<string, unknown>>;
	sendPrompt?(input: {
		session_id: string;
		prompt: string;
		idempotency_key: string;
		queue?: boolean;
		force?: boolean;
		allow_mutation?: true;
	}): Promise<Record<string, unknown>>;
	awaitTurn?(input: { turn_id: string; session_id?: string; timeout_ms?: number }): Promise<Record<string, unknown>>;
	callTool?(name: string, input: Record<string, unknown>): Promise<Record<string, unknown>>;
}

export interface WorkerObserverStore {
	admitNextTask?(input?: {
		leaseId?: string;
		intentId?: string;
		canonicalCwd?: string;
		createIdempotencyKey?: string;
		promptDigest?: string;
		taskId?: string;
	}): Promise<LeaseReceipt | null>;
	admit?(input?: Record<string, unknown>): Promise<LeaseReceipt | null>;
	admitTask?(input?: Record<string, unknown>): Promise<LeaseReceipt | null>;
	leaseNext?(input?: Record<string, unknown>): Promise<LeaseReceipt | null>;
	readQueue?(): Promise<{ tasks: Array<{ taskId: string; summary: string; workdir: string | null }> }>;
	readWorkerIntents?(): Promise<readonly WorkerCreateIntent[]>;
	readWorkerIntent?(intentId: string): Promise<WorkerCreateIntent | null>;
	readWorkers?(): Promise<{
		workers: Array<{
			intentId: string;
			workerSessionId: string | null;
			lifecycle: string | null;
		}>;
	}>;
	reconcileCreate?(input: {
		intentId: string;
		workerSessionId?: string;
		sessionId?: string;
		response?: Record<string, unknown>;
		outcome?: "created" | "uncertain" | "unknown";
		status?: "created" | "uncertain" | "unknown";
	}): Promise<WorkerCreateReceipt>;
	reconcileWorkerCreate?(input: Record<string, unknown>): Promise<WorkerCreateReceipt>;
	commitCoordinatorCreate?(input: Record<string, unknown>): Promise<WorkerCreateReceipt>;
	markCreateUncertain?(intentId: string): Promise<WorkerCreateReceipt>;
	markPromptPending?(input: {
		leaseId?: string;
		intentId?: string;
		promptIdempotencyKey?: string;
	}): Promise<PromptPendingReceipt>;
	beginPrompt?(input: Record<string, unknown>): Promise<PromptPendingReceipt>;
	reconcilePrompt?(input: {
		leaseId?: string;
		intentId?: string;
		promptIdempotencyKey?: string;
		proven: boolean;
		promptTurnId?: string;
	}): Promise<PromptReconcileReceipt>;
	reconcileWorkerPrompt?(input: Record<string, unknown>): Promise<PromptReconcileReceipt>;
	reconcilePromptDelivery?(input: Record<string, unknown>): Promise<PromptReconcileReceipt>;
	observe?(input: ObserveWorkerInput): Promise<WorkerObservationReceipt>;
	observeWorker?(input: ObserveWorkerInput): Promise<WorkerObservationReceipt>;
	recordWorkerObservation?(input: ObserveWorkerInput): Promise<WorkerObservationReceipt>;
	recordWorkerEvent?(input: ObserveWorkerInput): Promise<WorkerObservationReceipt>;
	registerUserWorker?(input: string | { workerSessionId: string }): Promise<unknown>;
	registerUserSession?(input: string | { workerSessionId: string }): Promise<unknown>;
}

export interface WorkerObserverPromptInput {
	readonly leaseId?: string;
	readonly intentId?: string;
	readonly workerSessionId?: string;
	readonly taskId?: string;
	readonly prompt?: string;
	readonly queue?: boolean;
	readonly force?: boolean;
	readonly promptIdempotencyKey?: string;
	readonly createIdempotencyKey?: string;
	readonly canonicalCwd?: string;
}

export interface WorkerDispatchResult {
	readonly lease: LeaseReceipt;
	readonly create: WorkerCreateReceipt | null;
	readonly promptPending: PromptPendingReceipt | null;
	readonly prompt: PromptReconcileReceipt | null;
	readonly workerSessionId: string | null;
	readonly promptResponse?: Record<string, unknown>;
	readonly error?: unknown;
}

export interface WorkerObserverOptions {
	readonly masterName: string;
	readonly domainStore: WorkerObserverStore | MasterDomainStore;
	readonly coordinatorGateway?: WorkerObserverCoordinator | MasterCoordinatorGateway;
	readonly coordinator?: WorkerObserverCoordinator | MasterCoordinatorGateway;
	readonly promptForTask?: (
		task: { taskId: string; summary: string; workdir: string | null },
		intent?: WorkerCreateIntent,
	) => string | Promise<string>;
	readonly onMasterObservation?: (receipt: WorkerObservationReceipt) => void | Promise<void>;
	readonly onUserObservation?: (receipt: WorkerObservationReceipt) => void | Promise<void>;
	readonly onQuarantinedObservation?: (receipt: WorkerObservationReceipt) => void | Promise<void>;
	readonly now?: () => Date;
}

export interface WorkerDispatchBatch {
	readonly dispatched: readonly WorkerDispatchResult[];
	readonly errors: readonly unknown[];
}

function record(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringValue(value: unknown): string | null {
	return typeof value === "string" && value.length > 0 ? value : null;
}

function responseSessionId(response: Record<string, unknown>): string | null {
	for (const value of [
		response.session_id,
		response.sessionId,
		response.worker_session_id,
		response.workerSessionId,
		response.id,
	]) {
		const direct = stringValue(value);
		if (direct !== null) return direct;
	}
	for (const key of ["session", "worker", "result", "data"]) {
		const nested = response[key];
		if (record(nested)) {
			const id = responseSessionId(nested);
			if (id !== null) return id;
		}
	}
	return null;
}

function promptWasAccepted(response: Record<string, unknown>): boolean {
	for (const key of ["ok", "accepted", "delivered", "queued", "reconciled"]) {
		if (response[key] === false) return false;
	}
	return (
		response.turn_id !== undefined ||
		response.turnId !== undefined ||
		response.accepted === true ||
		response.delivered === true ||
		response.ok === true ||
		response.queued === true ||
		response.reconciled === true
	);
}

/** Extracts the Coordinator turn id a prompt response proved, if any. */
function promptTurnFields(response: Record<string, unknown>): { promptTurnId?: string } {
	const turnId = stringValue(response.turn_id) ?? stringValue(response.turnId);
	return turnId === null ? {} : { promptTurnId: turnId };
}

function digestPrompt(prompt: string): string {
	return createHash("sha256").update(prompt, "utf8").digest("hex");
}

/**
 * Normalizes a frozen-Coordinator `await_turn` response into the durable worker
 * observation the master reasons over. A terminal turn is reported as such so
 * the master can release the worker instead of polling a finished session; a
 * turn that stopped for input keeps `action_needed`.
 */
export function coordinatorTurnObservation(
	turn: Record<string, unknown>,
	requestedAction?: string,
): Record<string, unknown> {
	const status = stringValue(turn.status) ?? stringValue(turn.state);
	const stopReason = stringValue(turn.stop_reason) ?? stringValue(turn.stopReason);
	const terminal =
		status === "completed" ||
		status === "failed" ||
		status === "cancelled" ||
		status === "terminated" ||
		turn.terminal === true;
	const needsAction = stopReason === "action_needed" || turn.action_needed === true || turn.actionNeeded === true;
	const action = terminal && !needsAction ? "worker_terminal" : (requestedAction ?? "action_needed");
	const output = stringValue(turn.output) ?? stringValue(turn.text) ?? stringValue(turn.response);
	const turnId = stringValue(turn.turn_id) ?? stringValue(turn.turnId);
	return {
		action,
		source: "coordinator_await_turn",
		...(status === null ? {} : { status }),
		...(stopReason === null ? {} : { stopReason }),
		...(turnId === null ? {} : { turnId }),
		...(output === null ? {} : { output }),
		terminal,
	};
}

export class MasterWorkerObserver {
	readonly masterName: string;
	readonly domainStore: WorkerObserverStore | MasterDomainStore;
	readonly coordinator: WorkerObserverCoordinator | MasterCoordinatorGateway | undefined;
	readonly #options: WorkerObserverOptions;
	readonly #prompts = new Map<string, string>();
	readonly #turnIds = new Map<string, string>();

	constructor(options: WorkerObserverOptions) {
		if (!/^[a-z][a-z0-9-]{0,62}$/.test(options.masterName))
			throw new Error("masterName must match [a-z][a-z0-9-]{0,62}.");
		this.masterName = options.masterName;
		this.domainStore = options.domainStore;
		this.coordinator = options.coordinatorGateway ?? options.coordinator;
		this.#options = options;
	}

	async dispatchNext(input: WorkerObserverPromptInput = {}): Promise<WorkerDispatchResult | null> {
		const lease = await this.#admit(input);
		if (lease === null) return null;
		return await this.dispatchLease(lease, input);
	}

	async dispatch(input: WorkerObserverPromptInput = {}): Promise<WorkerDispatchResult | null> {
		return await this.dispatchNext(input);
	}

	async createWorker(input: WorkerObserverPromptInput = {}): Promise<WorkerDispatchResult | null> {
		return await this.dispatchNext(input);
	}

	async dispatchAvailable(options: { readonly limit?: number } = {}): Promise<WorkerDispatchBatch> {
		const limit = options.limit === undefined ? Number.POSITIVE_INFINITY : Math.max(0, options.limit);
		const dispatched: WorkerDispatchResult[] = [];
		const errors: unknown[] = [];
		while (dispatched.length < limit) {
			try {
				const result = await this.dispatchNext();
				if (result === null) break;
				dispatched.push(result);
				if (result.error !== undefined) errors.push(result.error);
			} catch (error) {
				errors.push(error);
				break;
			}
		}
		return { dispatched, errors };
	}

	async recover(): Promise<WorkerDispatchBatch> {
		if (typeof this.domainStore.readWorkerIntents !== "function") return { dispatched: [], errors: [] };
		const intents = (await this.#callStore("readWorkerIntents")) as readonly WorkerCreateIntent[];
		const workersValue =
			typeof this.domainStore.readWorkers === "function"
				? await this.#callStore("readWorkers").catch(() => ({ workers: [] }))
				: { workers: [] };
		const workers = record(workersValue) && Array.isArray(workersValue.workers) ? workersValue.workers : [];
		const dispatched: WorkerDispatchResult[] = [];
		const errors: unknown[] = [];
		for (const intent of intents) {
			if (intent.state === "terminal" || intent.state === "active") continue;
			const worker = workers.find(candidate => record(candidate) && candidate.intentId === intent.intentId);
			const workerSessionId = record(worker) ? (stringValue(worker.workerSessionId) ?? undefined) : undefined;
			try {
				const result = await this.#reconcileIntent(intent, workerSessionId);
				if (result !== null) dispatched.push(result);
			} catch (error) {
				errors.push(error);
			}
		}
		return { dispatched, errors };
	}

	async observe(input: ObserveWorkerInput): Promise<WorkerObservationReceipt> {
		const receipt = await this.#observe(input);
		if (receipt.disposition === "master") await this.#options.onMasterObservation?.(receipt);
		else if (receipt.disposition === "user") await this.#options.onUserObservation?.(receipt);
		else await this.#options.onQuarantinedObservation?.(receipt);
		return receipt;
	}

	async observeWorker(input: ObserveWorkerInput): Promise<WorkerObservationReceipt> {
		return await this.observe(input);
	}

	async route(input: ObserveWorkerInput): Promise<WorkerObservationReceipt> {
		return await this.observe(input);
	}

	/**
	 * Observes a worker from its actual Coordinator turn rather than from an
	 * action the caller guessed. The frozen Coordinator `await_turn` operation is
	 * the only worker-state source the master is permitted to read, so the
	 * observation the master durably records is the real turn outcome: whether the
	 * worker needs action, produced output, or reached a terminal state.
	 *
	 * When no Coordinator is injected the caller-supplied action is still recorded,
	 * so in-process tests and adapter overrides keep working.
	 */
	async observeFromCoordinator(input: {
		readonly workerSessionId: string;
		readonly action?: string;
		readonly timeoutMs?: number;
		readonly observationId?: string;
	}): Promise<WorkerObservationReceipt> {
		const turn = await this.#awaitTurn(input.workerSessionId, input.timeoutMs);
		if (turn === null)
			return await this.observe({
				workerSessionId: input.workerSessionId,
				event: { action: input.action ?? "action_needed" },
				...(input.observationId === undefined ? {} : { observationId: input.observationId }),
			});
		return await this.observe({
			workerSessionId: input.workerSessionId,
			event: coordinatorTurnObservation(turn, input.action),
			...(input.observationId === undefined ? {} : { observationId: input.observationId }),
		});
	}

	async #awaitTurn(workerSessionId: string, timeoutMs?: number): Promise<Record<string, unknown> | null> {
		const coordinator = this.coordinator;
		if (!coordinator) return null;
		// `await_turn` is turn-scoped. Without the turn id proven by this worker's
		// prompt delivery there is no real turn to read, so fall back rather than
		// inventing one. Memory is only a cache; the durable intent is authoritative
		// so observation still works after a daemon restart.
		const turnId = this.#turnIds.get(workerSessionId) ?? (await this.#durableTurnId(workerSessionId));
		if (turnId === undefined) return null;
		const args = {
			turn_id: turnId,
			session_id: workerSessionId,
			...(timeoutMs === undefined ? {} : { timeout_ms: timeoutMs }),
		};
		if (typeof coordinator.awaitTurn === "function") return await coordinator.awaitTurn(args);
		if (typeof coordinator.callTool === "function")
			return await coordinator.callTool("gjc_coordinator_await_turn", args);
		return null;
	}

	/** Records the turn id proven by a prompt delivery so observation can read it. */
	#rememberTurn(workerSessionId: string | null, response: Record<string, unknown>): void {
		if (workerSessionId === null) return;
		const turnId = stringValue(response.turn_id) ?? stringValue(response.turnId);
		if (turnId !== null) this.#turnIds.set(workerSessionId, turnId);
	}

	/** Reads the durably retained prompt turn for a worker session. */
	async #durableTurnId(workerSessionId: string): Promise<string | undefined> {
		if (typeof this.domainStore.readWorkers !== "function") return undefined;
		if (typeof this.domainStore.readWorkerIntents !== "function") return undefined;
		const workers = await this.domainStore.readWorkers();
		const worker = workers.workers.find(candidate => candidate.workerSessionId === workerSessionId);
		if (worker === undefined) return undefined;
		const intents = await this.domainStore.readWorkerIntents();
		const turnId = intents.find(candidate => candidate.intentId === worker.intentId)?.promptTurnId;
		if (turnId === null || turnId === undefined) return undefined;
		this.#turnIds.set(workerSessionId, turnId);
		return turnId;
	}

	async registerUserWorker(workerSessionId: string): Promise<unknown> {
		if (typeof this.domainStore.registerUserWorker === "function")
			return await this.domainStore.registerUserWorker({ workerSessionId });
		if (typeof this.domainStore.registerUserSession === "function")
			return await this.domainStore.registerUserSession({ workerSessionId });
		throw new Error("Durable store does not implement user worker registration.");
	}

	/** @internal Test seam for proving a turn id without a full dispatch cycle. */
	async sendPromptForTest(
		workerSessionId: string,
		prompt: string,
		idempotencyKey: string,
	): Promise<Record<string, unknown>> {
		return await this.#sendPrompt(workerSessionId, prompt, idempotencyKey, {});
	}

	async #admit(input: WorkerObserverPromptInput): Promise<LeaseReceipt | null> {
		const args = {
			...(input.leaseId === undefined ? {} : { leaseId: input.leaseId }),
			...(input.intentId === undefined ? {} : { intentId: input.intentId }),
			...(input.createIdempotencyKey === undefined ? {} : { createIdempotencyKey: input.createIdempotencyKey }),
			...(input.canonicalCwd === undefined ? {} : { canonicalCwd: input.canonicalCwd }),
			...(input.prompt === undefined ? {} : { promptDigest: digestPrompt(input.prompt) }),
			// A requested task must reach admission; dropping it lets the store select a
			// different queued task and bind it to this prompt/workdir/worker.
			...(input.taskId === undefined ? {} : { taskId: input.taskId }),
		};
		for (const method of ["admitNextTask", "admit", "admitTask", "leaseNext"] as const) {
			const candidate = this.domainStore[method];
			if (typeof candidate === "function") return await candidate.call(this.domainStore, args);
		}
		throw new Error("Durable store does not implement worker admission.");
	}

	async dispatchLease(lease: LeaseReceipt, input: WorkerObserverPromptInput = {}): Promise<WorkerDispatchResult> {
		const intent = await this.#readIntent(lease.intentId);
		const prompt = await this.#resolvePrompt(lease, intent, input.prompt);
		this.#prompts.set(lease.intentId, prompt);
		try {
			if (lease.workerSessionId !== null && intent?.state === "active") {
				return { lease, create: null, promptPending: null, prompt: null, workerSessionId: lease.workerSessionId };
			}
			if (lease.workerSessionId !== null) {
				const create = await this.#reconcileCreate({
					intentId: lease.intentId,
					workerSessionId: lease.workerSessionId,
					outcome: "created",
				});
				const promptPending = await this.#markPromptPending({
					intentId: lease.intentId,
					promptIdempotencyKey: intent?.promptIdempotencyKey ?? input.promptIdempotencyKey,
				});
				const promptResponse = await this.#sendPrompt(
					lease.workerSessionId,
					prompt,
					promptPending.promptIdempotencyKey,
					input,
				);
				const promptReceipt = await this.#reconcilePrompt({
					intentId: lease.intentId,
					promptIdempotencyKey: promptPending.promptIdempotencyKey,
					proven: promptWasAccepted(promptResponse),
					...promptTurnFields(promptResponse),
				});
				return {
					lease,
					create,
					promptPending,
					prompt: promptReceipt,
					workerSessionId: lease.workerSessionId,
					promptResponse,
				};
			}
			const createResponse = await this.#startSession(lease, intent);
			const workerSessionId = responseSessionId(createResponse);
			if (workerSessionId === null) {
				await this.#markCreateUncertain(lease.intentId);
				return {
					lease,
					create: null,
					promptPending: null,
					prompt: null,
					workerSessionId: null,
					error: new Error("Coordinator create response did not contain a worker session ID."),
				};
			}
			const create = await this.#reconcileCreate({
				intentId: lease.intentId,
				workerSessionId,
				response: createResponse,
				outcome: "created",
			});
			const promptPending = await this.#markPromptPending({
				intentId: lease.intentId,
				promptIdempotencyKey: input.promptIdempotencyKey,
			});
			const promptResponse = await this.#sendPrompt(
				workerSessionId,
				prompt,
				promptPending.promptIdempotencyKey,
				input,
			);
			const promptReceipt = await this.#reconcilePrompt({
				intentId: lease.intentId,
				promptIdempotencyKey: promptPending.promptIdempotencyKey,
				proven: promptWasAccepted(promptResponse),
				...promptTurnFields(promptResponse),
			});
			return { lease, create, promptPending, prompt: promptReceipt, workerSessionId, promptResponse };
		} catch (error) {
			const currentIntent = await this.#readIntent(lease.intentId).catch(() => undefined);
			if (currentIntent?.state === "reserved" || currentIntent?.state === "create_uncertain") {
				await this.#markCreateUncertain(lease.intentId).catch(() => undefined);
			}
			return {
				lease,
				create: null,
				promptPending: null,
				prompt: null,
				workerSessionId: lease.workerSessionId,
				error,
			};
		}
	}

	async #reconcileIntent(intent: WorkerCreateIntent, workerSessionId?: string): Promise<WorkerDispatchResult | null> {
		const lease = await this.#findLease(intent.intentId);
		if (lease === null) return null;
		const prompt = this.#prompts.get(intent.intentId) ?? (await this.#resolvePrompt(lease, intent));
		this.#prompts.set(intent.intentId, prompt);
		if (workerSessionId === undefined) return await this.dispatchLease(lease, { intentId: intent.intentId, prompt });
		const create = await this.#reconcileCreate({ intentId: intent.intentId, workerSessionId, outcome: "created" });
		const promptPending = await this.#markPromptPending({
			intentId: intent.intentId,
			promptIdempotencyKey: intent.promptIdempotencyKey ?? undefined,
		});
		const promptResponse = await this.#sendPrompt(workerSessionId, prompt, promptPending.promptIdempotencyKey, {});
		const promptReceipt = await this.#reconcilePrompt({
			intentId: intent.intentId,
			promptIdempotencyKey: promptPending.promptIdempotencyKey,
			proven: promptWasAccepted(promptResponse),
			...promptTurnFields(promptResponse),
		});
		return { lease, create, promptPending, prompt: promptReceipt, workerSessionId, promptResponse };
	}

	async #readIntent(intentId: string): Promise<WorkerCreateIntent | undefined> {
		if (typeof this.domainStore.readWorkerIntent === "function")
			return (await this.domainStore.readWorkerIntent(intentId)) ?? undefined;
		const intents = (await this.#callStore("readWorkerIntents")) as readonly WorkerCreateIntent[];
		return intents.find(intent => intent.intentId === intentId);
	}

	async #findLease(intentId: string): Promise<LeaseReceipt | null> {
		const workersValue = await this.#callStore("readWorkers");
		if (!record(workersValue) || !Array.isArray(workersValue.workers)) return null;
		const worker = workersValue.workers.find(candidate => record(candidate) && candidate.intentId === intentId);
		if (!record(worker)) return null;
		return {
			leaseId: String(worker.leaseId),
			intentId,
			taskId: String(worker.taskId),
			workerSessionId: stringValue(worker.workerSessionId),
			attempt: typeof worker.attempt === "number" ? worker.attempt : 1,
			state: "leased",
			idempotent: true,
			canonicalCwd: "",
			createIdempotencyKey: "",
			promptDigest: "",
		};
	}

	async #resolvePrompt(
		lease: LeaseReceipt,
		intent: WorkerCreateIntent | undefined,
		explicit?: string,
	): Promise<string> {
		if (explicit !== undefined && explicit.length > 0) return explicit;
		const queueValue = await this.#callStore("readQueue");
		const task =
			record(queueValue) && Array.isArray(queueValue.tasks)
				? queueValue.tasks.find(candidate => record(candidate) && candidate.taskId === lease.taskId)
				: undefined;
		if (record(task)) {
			const normalized = {
				taskId: String(task.taskId),
				summary: String(task.summary ?? ""),
				workdir: task.workdir === null ? null : String(task.workdir ?? ""),
			};
			if (this.#options.promptForTask) return await this.#options.promptForTask(normalized, intent);
			return normalized.summary;
		}
		return intent ? `Continue task ${intent.taskId}.` : `Continue task ${lease.taskId}.`;
	}

	async #startSession(lease: LeaseReceipt, intent?: WorkerCreateIntent): Promise<Record<string, unknown>> {
		if (!this.coordinator) throw new Error("Coordinator gateway is required for worker creation.");
		const input = {
			cwd: intent?.canonicalCwd ?? lease.canonicalCwd,
			idempotency_key: intent?.createIdempotencyKey ?? lease.createIdempotencyKey,
			allow_mutation: true as const,
		};
		if (typeof this.coordinator.startSession === "function") return await this.coordinator.startSession(input);
		if (typeof this.coordinator.callTool === "function")
			return await this.coordinator.callTool("gjc_coordinator_start_session", input);
		throw new Error("Coordinator gateway does not implement startSession.");
	}

	async #sendPrompt(
		workerSessionId: string,
		prompt: string,
		idempotencyKey: string,
		input: WorkerObserverPromptInput,
	): Promise<Record<string, unknown>> {
		if (!this.coordinator) throw new Error("Coordinator gateway is required for worker prompts.");
		const request = {
			session_id: workerSessionId,
			prompt,
			idempotency_key: idempotencyKey,
			allow_mutation: true as const,
			...(input.queue === true ? { queue: true } : {}),
			...(input.force === true ? { force: true } : {}),
		};
		const response =
			typeof this.coordinator.sendPrompt === "function"
				? await this.coordinator.sendPrompt(request)
				: typeof this.coordinator.callTool === "function"
					? await this.coordinator.callTool("gjc_coordinator_send_prompt", request)
					: null;
		if (response === null) throw new Error("Coordinator gateway does not implement sendPrompt.");
		this.#rememberTurn(workerSessionId, response);
		return response;
	}

	async #reconcileCreate(
		input: Parameters<NonNullable<WorkerObserverStore["reconcileCreate"]>>[0],
	): Promise<WorkerCreateReceipt> {
		for (const method of ["reconcileCreate", "reconcileWorkerCreate", "commitCoordinatorCreate"] as const) {
			const candidate = this.domainStore[method];
			if (typeof candidate === "function") return await candidate.call(this.domainStore, input as never);
		}
		throw new Error("Durable store does not implement create reconciliation.");
	}

	async #markCreateUncertain(intentId: string): Promise<WorkerCreateReceipt> {
		if (typeof this.domainStore.markCreateUncertain === "function")
			return await this.domainStore.markCreateUncertain(intentId);
		return await this.#reconcileCreate({ intentId, outcome: "uncertain" });
	}

	async #markPromptPending(input: { intentId: string; promptIdempotencyKey?: string }): Promise<PromptPendingReceipt> {
		for (const method of ["markPromptPending", "beginPrompt"] as const) {
			const candidate = this.domainStore[method];
			if (typeof candidate === "function") return await candidate.call(this.domainStore, input);
		}
		throw new Error("Durable store does not implement prompt intent reconciliation.");
	}

	async #reconcilePrompt(input: {
		intentId: string;
		promptIdempotencyKey: string;
		proven: boolean;
	}): Promise<PromptReconcileReceipt> {
		for (const method of ["reconcilePrompt", "reconcileWorkerPrompt", "reconcilePromptDelivery"] as const) {
			const candidate = this.domainStore[method];
			if (typeof candidate === "function") return await candidate.call(this.domainStore, input);
		}
		throw new Error("Durable store does not implement prompt reconciliation.");
	}

	async #observe(input: ObserveWorkerInput): Promise<WorkerObservationReceipt> {
		for (const method of ["observe", "observeWorker", "recordWorkerObservation", "recordWorkerEvent"] as const) {
			const candidate = this.domainStore[method];
			if (typeof candidate === "function") return await candidate.call(this.domainStore, input);
		}
		throw new Error("Durable store does not implement worker observation.");
	}

	async #callStore(method: string): Promise<unknown> {
		const candidate = this.domainStore[method as keyof WorkerObserverStore];
		if (typeof candidate !== "function") throw new Error(`Durable store does not implement ${method}.`);
		return await (candidate as (...args: never[]) => Promise<unknown>).call(this.domainStore);
	}
}

export const WorkerObserver = MasterWorkerObserver;
export const MasterWorkerObserverRuntime = MasterWorkerObserver;
export function createMasterWorkerObserver(options: WorkerObserverOptions): MasterWorkerObserver {
	return new MasterWorkerObserver(options);
}
export const createWorkerObserver = createMasterWorkerObserver;
export function workerObservationEvent(
	workerSessionId: string,
	event: unknown,
	observationId = randomUUID(),
): ObserveWorkerInput {
	return { workerSessionId, event, observationId };
}
