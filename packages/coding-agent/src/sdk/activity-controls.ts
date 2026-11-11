import type { JobsWorstState } from "../modes/jobs-observer";
import {
	type MCPServerControlAction,
	MCPServerControlError,
	type MCPServerControlTarget,
} from "../runtime-mcp/manager";
import {
	JobObservationError,
	type JobObservationErrorCode,
	type JobObservationSnapshot,
	type TaskPauseResult,
	type TaskResumeResult,
} from "./job-observation";
import type { CreateAgentSessionResult } from "./session";

export const ACTIVITY_CONTROL_LIMITS = {
	entries: 100,
	fieldChars: 1024,
	outputChars: 16_384,
	messageChars: 16_384,
} as const;

import { type ActivityControlOperation, isActivityControlOperation } from "./protocol/client-control-contracts";

export {
	type ActivityControlOperation,
	type ActivityControlQueryOperation,
	isActivityControlOperation,
	isActivityControlQueryOperation,
} from "./protocol/client-control-contracts";

export type ActivityControlErrorCode =
	| JobObservationErrorCode
	| "invalid_input"
	| "stale_session"
	| "session_transitioning"
	| "stale_target"
	| "busy"
	| "unavailable"
	| "unsupported"
	| "unknown_effect"
	| "backend_failure";

/** Backend messages/configuration never cross the control boundary. */
export class ActivityControlError extends Error {
	constructor(readonly code: ActivityControlErrorCode) {
		super(`SDK activity control: ${code}`);
		this.name = "ActivityControlError";
	}
}

export interface ActivityEntry {
	ref: string;
	kind: "job" | "task" | "cron";
	label: string;
	status: string;
	controls: Array<"cancel" | "pause" | "resume" | "delete">;
	readable: boolean;
	jobKind?: string;
	backgrounded?: boolean;
	deliveryState?: "pending" | "delivered" | "failed-visible";
	requestedModel?: string;
	effectiveModel?: string;
	cronExpression?: string;
	prompt?: string;
	recurring?: boolean;
	nextFireAt?: number;
}

export interface ActivitySnapshot {
	/** Opaque snapshot reference required for acknowledging this view's failure latch. */
	ref: string;
	jobs: ActivityEntry[];
	tasks: ActivityEntry[];
	crons: ActivityEntry[];
	truncated: { jobs: boolean; tasks: boolean; crons: boolean };
	activeMonitorCount: number;
	activeCronCount: number;
	worstState: JobsWorstState;
	failedUnacknowledged: boolean;
}

export interface ActivityDetail {
	entry: ActivityEntry;
	/** Only monitor output is readable through the existing facade. */
	output?: string;
	outputTruncated?: boolean;
}

export interface ActivityMcpServer {
	ref: string;
	label: string;
	state: "connected" | "connecting" | "disconnected" | "suspended" | "unknown";
	transport: "stdio" | "http" | "sse" | "unknown";
	sharing: "shared" | "per-session" | "unknown";
	toolCount: number;
	controls: MCPServerControlAction[];
}

export interface ActivityMcpSnapshot {
	/** The factory manager can be caller-owned/shared; this is not exclusive server ownership. */
	scope: "factory_manager_may_be_shared";
	servers: ActivityMcpServer[];
	truncated: boolean;
}

export interface ActivityMcpResult {
	status: "suspended" | "resumed" | "reconnected";
	/** Backend completion does not certify remote termination or catalog publication. */
	cleanup: "not_certified";
}

export type ActivityControlResult =
	| ActivitySnapshot
	| ActivityDetail
	| ActivityMcpSnapshot
	| ActivityMcpResult
	| TaskPauseResult
	| TaskResumeResult
	| { acknowledged: true }
	| { cancelled: true }
	| { deleted: true };

type FactoryResult = Pick<CreateAgentSessionResult, "session" | "jobObservation" | "mcpManager">;
type Target =
	| { kind: "job"; id: string; generation: string }
	| { kind: "task"; id: string; generation: string }
	| { kind: "cron"; id: string; createdAt: number };
type ActivityAction = "cancel" | "pause" | "resume" | "delete";

function inputObject(
	input: unknown,
	required: readonly string[],
	optional: readonly string[] = [],
): Record<string, unknown> {
	if (!input || typeof input !== "object" || Array.isArray(input)) throw new ActivityControlError("invalid_input");
	const prototype: unknown = Object.getPrototypeOf(input);
	if (prototype !== null && prototype !== Object.prototype) throw new ActivityControlError("invalid_input");
	const descriptors = Object.getOwnPropertyDescriptors(input);
	if (
		Reflect.ownKeys(input).some(
			key => typeof key !== "string" || (!required.includes(key) && !optional.includes(key)),
		) ||
		required.some(key => !descriptors[key]) ||
		Object.values(descriptors).some(descriptor => !descriptor.enumerable || !("value" in descriptor))
	) {
		throw new ActivityControlError("invalid_input");
	}
	const parsed: Record<string, unknown> = {};
	for (const key of [...required, ...optional]) {
		const descriptor = descriptors[key];
		if (descriptor) parsed[key] = descriptor.value;
	}
	return parsed;
}

function refInput(input: unknown, resume = false): { ref: string; message?: string } {
	const parsed = inputObject(input, ["ref"], resume ? ["message"] : []);
	if (typeof parsed.ref !== "string" || !parsed.ref || parsed.ref.length > 128)
		throw new ActivityControlError("invalid_input");
	if (
		Object.hasOwn(parsed, "message") &&
		(typeof parsed.message !== "string" || parsed.message.length > ACTIVITY_CONTROL_LIMITS.messageChars)
	) {
		throw new ActivityControlError("invalid_input");
	}
	return { ref: parsed.ref, ...(typeof parsed.message === "string" ? { message: parsed.message } : {}) };
}

function failure(error: unknown): ActivityControlError {
	if (error instanceof ActivityControlError) return error;
	if (error instanceof JobObservationError) return new ActivityControlError(error.code);
	if (error instanceof MCPServerControlError) {
		return new ActivityControlError(error.code === "invalid_target" ? "invalid_input" : error.code);
	}
	const descriptor = error && typeof error === "object" ? Object.getOwnPropertyDescriptor(error, "code") : undefined;
	const code: unknown = descriptor && "value" in descriptor ? descriptor.value : undefined;
	if (code === "resource_gone") return new ActivityControlError("stale_session");
	if (code === "busy" || code === "MCP_MANAGER_LIFECYCLE_CLOSED") return new ActivityControlError("busy");
	return new ActivityControlError("backend_failure");
}

function text(value: string): string {
	return value.slice(0, ACTIVITY_CONTROL_LIMITS.fieldChars);
}

function count(value: number): number {
	return Number.isFinite(value) ? Math.max(0, Math.min(Number.MAX_SAFE_INTEGER, value)) : 0;
}

function observedJobs(snapshot: JobObservationSnapshot): JobObservationSnapshot["jobs"] {
	const jobs = [...snapshot.jobs];
	for (const folded of snapshot.foldedJobs ?? []) {
		if (!jobs.some(job => job.id === folded.id && job.generation === folded.generation)) jobs.push(folded);
	}
	return jobs;
}

/**
 * Trusted-host service over the factory's actual session-owned facades. Construct
 * once per session lifecycle/connection and dispose on detach. Request data can
 * name only issued opaque references, never owners, managers, or backend targets.
 * No workflow-gate or presentation authority is added here.
 */
export class ActivityControls {
	readonly #result: FactoryResult;
	readonly #session: FactoryResult["session"];
	readonly #sessionManager: FactoryResult["session"]["sessionManager"];
	readonly #sessionId: string;
	readonly #managerSessionId: string;
	readonly #owner: string | undefined;
	readonly #generation: number;
	readonly #observation: FactoryResult["jobObservation"];
	readonly #manager: FactoryResult["mcpManager"];
	readonly #references = new Map<string, Target>();
	readonly #mcpReferences = new Map<string, MCPServerControlTarget>();
	readonly #subscriptions = new Set<() => void>();
	readonly #abort = new AbortController();
	#snapshotRef: string | undefined;
	#disposed = false;
	#stale = false;

	constructor(result: FactoryResult) {
		const lifecycle = result.session.sessionLifecycle;
		if (lifecycle.disposed) throw new ActivityControlError("disposed");
		if (lifecycle.transitioning) throw new ActivityControlError("session_transitioning");
		this.#result = result;
		this.#session = result.session;
		this.#sessionManager = result.session.sessionManager;
		this.#sessionId = result.session.sessionId;
		this.#managerSessionId = this.#sessionManager.getSessionId();
		this.#owner = result.session.getAgentId();
		this.#generation = lifecycle.generation;
		this.#observation = result.jobObservation;
		this.#manager = result.mcpManager;
		this.#assertCurrent();
	}

	#clearReferences(): void {
		this.#references.clear();
		this.#mcpReferences.clear();
		this.#snapshotRef = undefined;
	}

	#assertCurrent(allowTransition = false): void {
		const lifecycle = this.#session.sessionLifecycle;
		if (lifecycle.generation !== this.#generation) this.#stale = true;
		if (this.#stale) {
			this.#clearReferences();
			throw new ActivityControlError("stale_session");
		}
		if (this.#disposed || lifecycle.disposed) throw new ActivityControlError("disposed");
		if (lifecycle.transitioning) {
			if (!allowTransition) throw new ActivityControlError("session_transitioning");
			return;
		}
		if (
			this.#session.sessionManager !== this.#sessionManager ||
			this.#session.sessionId !== this.#sessionId ||
			this.#sessionManager.getSessionId() !== this.#managerSessionId ||
			this.#session.getAgentId() !== this.#owner ||
			this.#result.mcpManager !== this.#manager ||
			this.#result.jobObservation !== this.#observation
		) {
			this.#stale = true;
			this.#clearReferences();
			throw new ActivityControlError("stale_session");
		}
	}

	#view(): NonNullable<FactoryResult["jobObservation"]> {
		if (!this.#observation) throw new ActivityControlError("unavailable");
		return this.#observation;
	}

	#reference(target: Target, retained: Set<string>): string {
		const identity = JSON.stringify(target);
		let key: string | undefined;
		for (const [ref, current] of this.#references) {
			if (JSON.stringify(current) === identity) {
				key = ref;
				break;
			}
		}
		if (!key) {
			key = crypto.randomUUID();
			this.#references.set(key, target);
		}
		retained.add(key);
		return key;
	}

	#entry(
		target: Target,
		snapshot: JobObservationSnapshot,
		ref: string,
		jobs: JobObservationSnapshot["jobs"] = observedJobs(snapshot),
	): ActivityEntry {
		const controls: ActivityAction[] = [];
		let label: string;
		let status: string;
		let readable = false;
		let fields: Partial<ActivityEntry> = {};
		if (target.kind === "job") {
			const job = jobs.find(row => row.id === target.id && row.generation === target.generation);
			if (!job)
				throw new ActivityControlError(jobs.some(row => row.id === target.id) ? "stale_generation" : "not_found");
			label = job.label;
			status = job.status;
			fields = { jobKind: text(job.kind), backgrounded: job.backgrounded, deliveryState: job.deliveryState };
			readable =
				job.kind === "bash" &&
				!job.backgrounded &&
				snapshot.monitors.some(row => row.id === target.id && row.generation === target.generation) &&
				!snapshot.foldedJobs?.some(row => row.id === target.id && row.generation === target.generation);
			if (readable && job.status === "running") controls.push("cancel");
		} else if (target.kind === "task") {
			const task = snapshot.tasks.find(row => row.target.id === target.id);
			if (!task) throw new ActivityControlError("not_found");
			if (task.target.generation !== target.generation) throw new ActivityControlError("stale_generation");
			label = task.id;
			status = task.status;
			fields = {
				...(task.requestedModel === undefined ? {} : { requestedModel: text(task.requestedModel) }),
				...(task.effectiveModel === undefined ? {} : { effectiveModel: text(task.effectiveModel) }),
			};
			if (task.capabilities.cancel) controls.push("cancel");
			if (task.capabilities.pause) controls.push("pause");
			if (task.capabilities.resume) controls.push("resume");
		} else {
			const cron = snapshot.crons.find(row => row.id === target.id);
			if (!cron) throw new ActivityControlError("not_found");
			if (cron.createdAt !== target.createdAt) throw new ActivityControlError("stale_generation");
			label = cron.humanSchedule;
			status = cron.firing ? "firing" : "scheduled";
			fields = {
				cronExpression: text(cron.cronExpression),
				prompt: text(cron.prompt),
				recurring: cron.recurring,
				...(cron.nextFireAt === undefined ? {} : { nextFireAt: count(cron.nextFireAt) }),
			};
			controls.push("delete");
		}
		return {
			...fields,
			ref,
			kind: target.kind,
			label: text(label),
			status,
			controls: this.#session.sessionLifecycle.transitioning ? [] : controls,
			readable,
		};
	}

	getActivitySnapshot(): ActivitySnapshot {
		try {
			this.#assertCurrent(true);
			const snapshot = this.#view().getSnapshot();
			const retained = new Set<string>();
			const allJobs = observedJobs(snapshot);
			const project = (target: Target): ActivityEntry =>
				this.#entry(target, snapshot, this.#reference(target, retained), allJobs);
			const jobs = allJobs
				.slice(0, ACTIVITY_CONTROL_LIMITS.entries)
				.map(row => project({ kind: "job", id: row.id, generation: row.generation }));
			const tasks = snapshot.tasks
				.slice(0, ACTIVITY_CONTROL_LIMITS.entries)
				.map(row => project({ kind: "task", id: row.target.id, generation: row.target.generation }));
			const crons = snapshot.crons
				.slice(0, ACTIVITY_CONTROL_LIMITS.entries)
				.map(row => project({ kind: "cron", id: row.id, createdAt: row.createdAt }));
			for (const ref of this.#references.keys()) if (!retained.has(ref)) this.#references.delete(ref);
			this.#assertCurrent(true);
			this.#snapshotRef = crypto.randomUUID();
			return {
				ref: this.#snapshotRef,
				jobs,
				tasks,
				crons,
				truncated: {
					jobs: allJobs.length > jobs.length,
					tasks: snapshot.tasks.length > tasks.length,
					crons: snapshot.crons.length > crons.length,
				},
				activeMonitorCount: count(snapshot.activeMonitorCount),
				activeCronCount: count(snapshot.activeCronCount),
				worstState: snapshot.worstState,
				failedUnacknowledged: snapshot.failedUnacknowledged,
			};
		} catch (error) {
			throw failure(error);
		}
	}

	#resolve(ref: string): { target: Target; entry: ActivityEntry } {
		this.#assertCurrent();
		const target = this.#references.get(ref);
		if (!target) throw new ActivityControlError("not_found");
		const entry = this.#entry(target, this.#view().getSnapshot(), ref);
		this.#assertCurrent();
		return { target, entry };
	}

	getDetail(input: unknown): ActivityDetail {
		try {
			const { ref } = refInput(input);
			const { target, entry } = this.#resolve(ref);
			let detail: ActivityDetail = { entry };
			if (target.kind === "job" && entry.readable) {
				const output = this.#view().getMonitorOutput(target);
				detail = {
					entry,
					output: output.slice(0, ACTIVITY_CONTROL_LIMITS.outputChars),
					outputTruncated: output.length > ACTIVITY_CONTROL_LIMITS.outputChars,
				};
			}
			this.#assertCurrent();
			return detail;
		} catch (error) {
			throw failure(error);
		}
	}

	operateActivity(
		input: unknown,
		action: ActivityAction,
	): TaskPauseResult | TaskResumeResult | { cancelled: true } | { deleted: true } {
		try {
			const { ref, message } = refInput(input, action === "resume");
			const { target, entry } = this.#resolve(ref);
			const view = this.#view();
			if (target.kind === "job" && action === "cancel") {
				// Delegate terminal/read-only distinctions and final owner/generation CAS to the facade.
				view.cancelMonitor(target);
				return { cancelled: true };
			}
			if (target.kind === "cron" && action === "delete") {
				view.deleteCron(target);
				return { deleted: true };
			}
			if (target.kind === "task") {
				if (action === "cancel") {
					view.cancelTask(target);
					return { cancelled: true };
				}
				if (action === "pause") return view.pauseTask(target);
				if (action === "resume") return view.resumeTask(target, message);
			}
			throw new ActivityControlError(entry.controls.length ? "unsupported" : "read_only");
		} catch (error) {
			throw failure(error);
		}
	}

	acknowledge(input: unknown): { acknowledged: true } {
		try {
			const { ref } = refInput(input);
			this.#assertCurrent();
			if (ref !== this.#snapshotRef) throw new ActivityControlError("not_found");
			this.#view().acknowledgeFailures();
			return { acknowledged: true };
		} catch (error) {
			throw failure(error);
		}
	}

	getMcpSnapshot(): ActivityMcpSnapshot {
		try {
			this.#assertCurrent(true);
			if (!this.#manager) throw new ActivityControlError("unavailable");
			const snapshot = this.#manager.getServerControlSnapshot();
			const retained = new Set<string>();
			const servers = snapshot.slice(0, ACTIVITY_CONTROL_LIMITS.entries).map(server => {
				let ref: string | undefined;
				for (const [key, target] of this.#mcpReferences) {
					if (
						target.name === server.target.name &&
						target.binding === server.target.binding &&
						target.generation === server.target.generation
					) {
						ref = key;
						break;
					}
				}
				if (!ref) {
					ref = crypto.randomUUID();
					this.#mcpReferences.set(ref, { ...server.target });
				}
				retained.add(ref);
				return {
					ref,
					label: text(server.target.name),
					state: server.state,
					transport: server.transport,
					sharing: server.sharing,
					toolCount: count(server.toolCount),
					controls: this.#session.sessionLifecycle.transitioning ? [] : [...server.controls],
				};
			});
			for (const ref of this.#mcpReferences.keys()) if (!retained.has(ref)) this.#mcpReferences.delete(ref);
			this.#assertCurrent(true);
			return { scope: "factory_manager_may_be_shared", servers, truncated: snapshot.length > servers.length };
		} catch (error) {
			throw failure(error);
		}
	}

	async operateMcp(input: unknown, action: MCPServerControlAction): Promise<ActivityMcpResult> {
		try {
			const { ref } = refInput(input);
			this.#assertCurrent();
			const target = this.#mcpReferences.get(ref);
			if (!target) throw new ActivityControlError("not_found");
			const manager = this.#manager;
			if (!manager) throw new ActivityControlError("unavailable");
			const result = await this.#session.withMcpControlAdmission(this.#generation, signal => {
				this.#assertCurrent(true);
				// Atomic manager admission validates binding+generation before its first await.
				return manager.controlServer(target, action, { signal: AbortSignal.any([signal, this.#abort.signal]) });
			});
			this.#assertCurrent();
			return { status: result.status, cleanup: result.cleanup };
		} catch (error) {
			throw failure(error);
		}
	}

	/** Closed bridge dispatch; query IDs are separately identifiable for host routing. */
	async control(operation: ActivityControlOperation, input: Record<string, unknown>): Promise<ActivityControlResult> {
		try {
			if (!isActivityControlOperation(operation)) throw new ActivityControlError("unsupported");
			switch (operation) {
				case "activity.snapshot":
					inputObject(input, []);
					return this.getActivitySnapshot();
				case "activity.detail":
					return this.getDetail(input);
				case "activity.cancel":
					return this.operateActivity(input, "cancel");
				case "activity.pause":
					return this.operateActivity(input, "pause");
				case "activity.resume":
					return this.operateActivity(input, "resume");
				case "activity.delete":
					return this.operateActivity(input, "delete");
				case "activity.acknowledge":
					return this.acknowledge(input);
				case "mcp.snapshot":
					inputObject(input, []);
					return this.getMcpSnapshot();
				case "mcp.suspend":
					return this.operateMcp(input, "suspend");
				case "mcp.resume":
					return this.operateMcp(input, "resume");
				case "mcp.reconnect":
					return this.operateMcp(input, "reconnect");
			}
		} catch (error) {
			throw failure(error);
		}
	}

	/** Payload-free wakeups; listeners cannot grant or renew authority. */
	onChange(listener: () => void): () => void {
		this.#assertCurrent(true);
		const wake = (): void => {
			if (this.#disposed) return;
			try {
				listener();
			} catch {
				/* Isolated subscriber. */
			}
		};
		const unsubscribers: Array<() => void> = [];
		const unsubscribe = (): void => {
			this.#subscriptions.delete(unsubscribe);
			for (const dispose of unsubscribers.splice(0)) dispose();
		};
		try {
			unsubscribers.push(this.#session.subscribe(wake));
			if (this.#observation) unsubscribers.push(this.#observation.onChange(wake));
			if (this.#manager) {
				unsubscribers.push(this.#manager.subscribeToServerControlsChanged(wake));
				unsubscribers.push(this.#manager.subscribeToToolsChanged(wake));
			}
			this.#assertCurrent(true);
			this.#subscriptions.add(unsubscribe);
			return unsubscribe;
		} catch (error) {
			unsubscribe();
			throw failure(error);
		}
	}

	/** Detach only. Factory/session lifecycle remains sole backend owner. */
	dispose(): void {
		if (this.#disposed) return;
		this.#disposed = true;
		this.#abort.abort();
		this.#clearReferences();
		for (const unsubscribe of this.#subscriptions) unsubscribe();
	}
}

export function createActivityControls(result: FactoryResult): ActivityControls {
	return new ActivityControls(result);
}
