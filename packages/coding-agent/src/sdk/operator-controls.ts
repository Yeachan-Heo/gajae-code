import type { AgentSession } from "../session/agent-session";

export const SDK_OPERATOR_LIMITS = {
	inputChars: 65_536,
	outputChars: 16_384,
	deltaChunks: 128,
	operations: 32,
} as const;

import type { SdkOperatorOperation } from "./protocol/client-control-contracts";

export {
	isSdkOperatorOperation,
	isSdkOperatorQueryOperation,
	type SdkOperatorOperation,
	type SdkOperatorQueryOperation,
} from "./protocol/client-control-contracts";
export type SdkOperatorKind = "bash" | "python";
export type SdkOperatorStatus = "running" | "cancel_requested" | "completed" | "cancelled" | "failed";
export type SdkOperatorErrorCode =
	| "invalid_input"
	| "busy"
	| "disposed"
	| "stale_session"
	| "session_transitioning"
	| "not_found"
	| "already_terminal"
	| "stale_cursor"
	| "backend_failure";

const reasons: Record<SdkOperatorErrorCode, string> = {
	invalid_input: "Invalid operator input. Only the documented parameters are accepted.",
	busy: "An operator execution is still running in this session.",
	disposed: "Operator controls or their session have been disposed.",
	stale_session: "The operator controls belong to an earlier session identity.",
	session_transitioning: "The session is transitioning; retry after it settles.",
	not_found: "The operation does not belong to these controls, or has expired.",
	already_terminal: "The operator execution has already settled.",
	stale_cursor: "The output cursor has expired; read without a cursor to obtain the retained snapshot.",
	backend_failure: "The session executor failed. Successful completion was not proven.",
};

export class SdkOperatorError extends Error {
	constructor(readonly code: SdkOperatorErrorCode) {
		super(reasons[code]);
		this.name = "SdkOperatorError";
	}
}

export interface SdkOperatorExecuteInput {
	/** !/!! select Bash; $/$$ select Python. Doubled prefixes exclude LLM context. */
	text: string;
}

export interface SdkOperatorReference {
	operationId: string;
}

export interface SdkOperatorReadInput extends SdkOperatorReference {
	/** Last consumed delta cursor, scoped to this operation. Omit to recover retained output. */
	cursor?: number;
}

export interface SdkOperatorSnapshot {
	operationId: string;
	sessionGeneration: number;
	kind: SdkOperatorKind;
	excludeFromContext: boolean;
	status: SdkOperatorStatus;
	/** Terminality is executor settlement, never merely admission or an abort acknowledgement. */
	terminal: boolean;
	/** Controls currently available for this exact admitted execution. */
	controls: { cancel: boolean };
	output: string;
	outputTruncated: boolean;
	exitCode?: number;
	signal?: string;
	error?: { code: SdkOperatorErrorCode; message: string };
}

export interface SdkOperatorAccepted {
	admission: "accepted";
	operation: SdkOperatorSnapshot;
}

export interface SdkOperatorDelta {
	cursor: number;
	text: string;
}

export interface SdkOperatorReadResult {
	operation: SdkOperatorSnapshot;
	/** Callback deltas only; the terminal snapshot is authoritative if the executor transforms output. */
	deltas: SdkOperatorDelta[];
	nextCursor: number;
	/** Earlier callbacks were dropped from bounded retention. */
	deltasTruncated: boolean;
}

export type SdkOperatorResult = SdkOperatorAccepted | SdkOperatorSnapshot | SdkOperatorReadResult;

interface ExecutionResult {
	output: string;
	exitCode: number | undefined;
	cancelled: boolean;
	truncated: boolean;
	signal?: string;
}

interface Execution {
	controller: AbortController;
	snapshot: Omit<SdkOperatorSnapshot, "controls">;
	deltas: SdkOperatorDelta[];
	deltaChars: number;
	cursor: number;
	oldestCursor: number;
	deltasTruncated: boolean;
}

// Retirement and cancellation do not release admission: only the actual session
// executor promise settling can release it, even across service instances.
const executions = new WeakMap<AgentSession, Execution>();

function object(
	value: unknown,
	required: readonly string[],
	optional: readonly string[] = [],
): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new SdkOperatorError("invalid_input");
	const prototype: unknown = Object.getPrototypeOf(value);
	if (prototype !== Object.prototype && prototype !== null) throw new SdkOperatorError("invalid_input");
	const keys = Reflect.ownKeys(value);
	if (
		keys.some(key => typeof key !== "string" || (!required.includes(key) && !optional.includes(key))) ||
		required.some(key => !keys.includes(key))
	)
		throw new SdkOperatorError("invalid_input");
	const result: Record<string, unknown> = {};
	for (const key of keys) {
		const descriptor = Object.getOwnPropertyDescriptor(value, key);
		if (typeof key !== "string" || !descriptor || !descriptor.enumerable || !("value" in descriptor))
			throw new SdkOperatorError("invalid_input");
		result[key] = descriptor.value;
	}
	return result;
}

function parse(value: unknown): { kind: SdkOperatorKind; source: string; excludeFromContext: boolean } {
	const { text } = object(value, ["text"]);
	if (typeof text !== "string" || text.length > SDK_OPERATOR_LIMITS.inputChars || text.includes("\0"))
		throw new SdkOperatorError("invalid_input");
	const submitted = text.trim();
	const kind = submitted.startsWith("!") ? "bash" : submitted.startsWith("$") ? "python" : undefined;
	if (!kind) throw new SdkOperatorError("invalid_input");
	const excludeFromContext = submitted.startsWith("!!") || submitted.startsWith("$$");
	const source = submitted.slice(excludeFromContext ? 2 : 1).trim();
	if (!source) throw new SdkOperatorError("invalid_input");
	return { kind, source, excludeFromContext };
}

function copy(execution: Execution, session: AgentSession): SdkOperatorSnapshot {
	return {
		...execution.snapshot,
		controls: {
			cancel:
				!execution.snapshot.terminal &&
				executions.get(session) === execution &&
				!execution.controller.signal.aborted,
		},
		...(execution.snapshot.error ? { error: { ...execution.snapshot.error } } : {}),
	};
}

/**
 * Trusted, session-bound operator service. All execution and cancellation use
 * AgentSession, never an independent shell or interpreter. Poll read() while an
 * accepted execution is running; transports need not block on executor completion.
 */
export class SdkOperatorControls {
	readonly #session: AgentSession;
	readonly #sessionId: string;
	readonly #manager: AgentSession["sessionManager"];
	readonly #managerId: string;
	readonly #managerGeneration: number;
	readonly #agent: AgentSession["agent"];
	readonly #generation: number;
	readonly #operations = new Map<string, Execution>();
	#retired: "disposed" | "stale_session" | undefined;
	#unregisterDispose: (() => void) | undefined;
	#unregisterTransition: (() => void) | undefined;

	constructor(session: AgentSession) {
		this.#session = session;
		this.#sessionId = session.sessionId;
		this.#manager = session.sessionManager;
		this.#managerId = this.#manager.getSessionId();
		this.#managerGeneration = this.#manager.getSessionIdentityGeneration();
		this.#agent = session.agent;
		this.#generation = session.sessionLifecycle.generation;
		this.#assertCurrent();
		this.#unregisterDispose = session.registerToolSessionCleanup(() => this.dispose());
		this.#unregisterTransition = session.registerToolSessionTransitionCleanup(() =>
			this.#retire(session.sessionLifecycle.disposed ? "disposed" : "stale_session"),
		);
	}

	/** Admission remains held after retirement until the captured executor settles. */
	isBusy(): boolean {
		return executions.has(this.#session);
	}

	/** Retired instances never reopen, including after a rolled-back transition. */
	get disposed(): boolean {
		return this.#retired !== undefined;
	}

	#ownsIdentity(): boolean {
		return (
			this.#session.sessionLifecycle.generation === this.#generation &&
			this.#session.sessionId === this.#sessionId &&
			this.#session.sessionManager === this.#manager &&
			this.#manager.getSessionId() === this.#managerId &&
			this.#manager.getSessionIdentityGeneration() === this.#managerGeneration &&
			this.#session.agent === this.#agent
		);
	}

	#assertCurrent(): void {
		if (this.#session.sessionLifecycle.disposed) {
			this.#retire("disposed");
			throw new SdkOperatorError("disposed");
		}
		if (this.#retired) throw new SdkOperatorError(this.#retired);
		if (!this.#ownsIdentity()) {
			this.#retire("stale_session");
			throw new SdkOperatorError("stale_session");
		}
		if (this.#session.sessionLifecycle.transitioning) throw new SdkOperatorError("session_transitioning");
	}

	#find(input: Record<string, unknown>): Execution {
		this.#assertCurrent();
		const { operationId } = input;
		if (typeof operationId !== "string" || !operationId || operationId.length > 128)
			throw new SdkOperatorError("invalid_input");
		const execution = this.#operations.get(operationId);
		if (!execution) throw new SdkOperatorError("not_found");
		return execution;
	}

	execute(value: unknown): SdkOperatorAccepted {
		this.#assertCurrent();
		const parsed = parse(value);
		this.#assertCurrent();
		if (executions.has(this.#session) || this.#session.isBashRunning || this.#session.isEvalRunning)
			throw new SdkOperatorError("busy");
		const execution: Execution = {
			controller: new AbortController(),
			snapshot: {
				operationId: crypto.randomUUID(),
				sessionGeneration: this.#generation,
				kind: parsed.kind,
				excludeFromContext: parsed.excludeFromContext,
				status: "running",
				terminal: false,
				output: "",
				outputTruncated: false,
			},
			deltas: [],
			deltaChars: 0,
			cursor: 0,
			oldestCursor: 0,
			deltasTruncated: false,
		};
		while (this.#operations.size >= SDK_OPERATOR_LIMITS.operations) {
			const oldest = this.#operations.keys().next().value;
			if (oldest === undefined) break;
			this.#operations.delete(oldest);
		}
		this.#operations.set(execution.snapshot.operationId, execution);
		executions.set(this.#session, execution);
		// Capture admission before synchronous hooks/chunks can re-enter the service.
		const admitted: SdkOperatorAccepted = { admission: "accepted", operation: copy(execution, this.#session) };
		void this.#run(execution, parsed.source, parsed.excludeFromContext);
		return admitted;
	}

	#chunk(execution: Execution, text: string): void {
		if (
			this.#retired ||
			this.#session.sessionLifecycle.disposed ||
			!this.#ownsIdentity() ||
			executions.get(this.#session) !== execution ||
			execution.snapshot.terminal ||
			!text
		)
			return;
		execution.cursor++;
		const retained = text.slice(-SDK_OPERATOR_LIMITS.outputChars);
		if (retained.length !== text.length) {
			// A cursor before this partial callback cannot certify lossless delivery.
			execution.oldestCursor = execution.cursor;
			execution.deltasTruncated = true;
		}
		execution.deltas.push({ cursor: execution.cursor, text: retained });
		execution.deltaChars += retained.length;
		while (
			execution.deltas.length > SDK_OPERATOR_LIMITS.deltaChunks ||
			execution.deltaChars > SDK_OPERATOR_LIMITS.outputChars
		) {
			const removed = execution.deltas.shift();
			if (!removed) break;
			execution.deltaChars -= removed.text.length;
			execution.oldestCursor = Math.max(execution.oldestCursor, removed.cursor);
			execution.deltasTruncated = true;
		}
		const combined = execution.snapshot.output + retained;
		execution.snapshot.outputTruncated ||=
			text.length > retained.length || combined.length > SDK_OPERATOR_LIMITS.outputChars;
		execution.snapshot.output = combined.slice(-SDK_OPERATOR_LIMITS.outputChars);
	}

	async #run(execution: Execution, source: string, excludeFromContext: boolean): Promise<void> {
		try {
			const onChunk = (chunk: string) => this.#chunk(execution, chunk);
			const result: ExecutionResult =
				execution.snapshot.kind === "bash"
					? await this.#session.executeBash(source, onChunk, {
							excludeFromContext,
							signal: execution.controller.signal,
						})
					: await this.#session.executePython(source, onChunk, {
							excludeFromContext,
							signal: execution.controller.signal,
						});
			if (this.#retired || !this.#ownsIdentity() || this.#session.sessionLifecycle.disposed) return;
			execution.snapshot.output = result.output.slice(-SDK_OPERATOR_LIMITS.outputChars);
			execution.snapshot.outputTruncated ||=
				result.truncated || result.output.length > SDK_OPERATOR_LIMITS.outputChars;
			if (result.exitCode !== undefined) execution.snapshot.exitCode = result.exitCode;
			if (result.signal !== undefined) execution.snapshot.signal = result.signal.slice(0, 128);
			execution.snapshot.status = result.cancelled ? "cancelled" : "completed";
			execution.snapshot.terminal = true;
		} catch (error) {
			if (!this.#retired && this.#ownsIdentity() && !this.#session.sessionLifecycle.disposed) {
				const cancelled = execution.controller.signal.aborted && error === execution.controller.signal.reason;
				execution.snapshot.status = cancelled ? "cancelled" : "failed";
				execution.snapshot.terminal = true;
				if (!cancelled) execution.snapshot.error = { code: "backend_failure", message: reasons.backend_failure };
			}
		} finally {
			if (executions.get(this.#session) === execution) executions.delete(this.#session);
		}
	}

	read(value: unknown): SdkOperatorReadResult {
		this.#assertCurrent();
		const input = object(value, ["operationId"], ["cursor"]);
		const execution = this.#find(input);
		const cursor = input.cursor;
		if (cursor !== undefined && (typeof cursor !== "number" || !Number.isSafeInteger(cursor) || cursor < 0))
			throw new SdkOperatorError("invalid_input");
		if (typeof cursor === "number") {
			if (cursor > execution.cursor) throw new SdkOperatorError("invalid_input");
			if (cursor < execution.oldestCursor) throw new SdkOperatorError("stale_cursor");
		}
		return {
			operation: copy(execution, this.#session),
			deltas: execution.deltas
				.filter(delta => cursor === undefined || delta.cursor > cursor)
				.map(delta => ({ ...delta })),
			nextCursor: execution.cursor,
			deltasTruncated: execution.deltasTruncated,
		};
	}

	cancel(value: unknown): SdkOperatorSnapshot {
		this.#assertCurrent();
		const execution = this.#find(object(value, ["operationId"]));
		if (execution.snapshot.terminal) throw new SdkOperatorError("already_terminal");
		if (executions.get(this.#session) !== execution) throw new SdkOperatorError("not_found");
		if (execution.snapshot.status === "cancel_requested") return copy(execution, this.#session);
		try {
			this.#abort(execution);
		} catch {
			throw new SdkOperatorError("backend_failure");
		}
		// A request is not proof of process completion or release of admission.
		execution.snapshot.status = "cancel_requested";
		return copy(execution, this.#session);
	}

	dispatch(operation: SdkOperatorOperation, input: unknown): SdkOperatorResult {
		switch (operation) {
			case "operator.execute":
				return this.execute(input);
			case "operator.read":
				return this.read(input);
			case "operator.cancel":
				return this.cancel(input);
			default:
				throw new SdkOperatorError("invalid_input");
		}
	}

	#abort(execution: Execution): void {
		execution.controller.abort();
	}

	#retire(reason: "disposed" | "stale_session"): void {
		if (this.#retired) return;
		const active = executions.get(this.#session);
		const canAbort = active && this.#operations.get(active.snapshot.operationId) === active;
		this.#retired = reason;
		if (canAbort && active) {
			try {
				this.#abort(active);
			} catch {
				// Cleanup cannot claim cancellation succeeded or release the lease.
			}
		}
		this.#operations.clear();
		this.#unregisterDispose?.();
		this.#unregisterTransition?.();
		this.#unregisterDispose = undefined;
		this.#unregisterTransition = undefined;
	}

	dispose(): void {
		this.#retire("disposed");
	}
}

export function createSdkOperatorControls(session: AgentSession): SdkOperatorControls {
	return new SdkOperatorControls(session);
}
