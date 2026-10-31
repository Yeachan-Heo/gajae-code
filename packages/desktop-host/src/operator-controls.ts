import type { CreateAgentSessionResult } from "@gajae-code/coding-agent/sdk";
import type {
	DesktopOperatorErrorCode,
	DesktopOperatorEvent,
	DesktopOperatorFoldResult,
	DesktopOperatorKind,
	DesktopOperatorOperation,
} from "./operator-protocol";

export const DESKTOP_OPERATOR_LIMITS = { inputChars: 65_536, outputChars: 16_384, operations: 32 } as const;

const REASONS: Record<DesktopOperatorErrorCode, string> = {
	invalid_input: "Invalid operator input. Only the documented parameters are accepted.",
	busy: "An operator execution is already running. Inspect or cancel it before starting another.",
	disposed: "Operator controls or their session have been disposed.",
	stale_session: "The session has changed; reopen operator controls.",
	session_transitioning: "The session is transitioning; retry after it settles.",
	not_found: "This operation does not belong to these operator controls, or has expired.",
	already_terminal: "The operator execution has already settled.",
	unsupported: "This session does not support the requested operator capability.",
	backend_failure: "The SDK operator execution failed. Completion was not proven.",
	redaction_failed: "Operator output redaction failed; content was withheld.",
};

export class DesktopOperatorError extends Error {
	constructor(readonly code: DesktopOperatorErrorCode) {
		super(REASONS[code]);
		this.name = "DesktopOperatorError";
	}
}

/** A host-owned, per-operation redactor. push must retain incomplete secret matches. */
export interface DesktopOperatorStreamRedactor {
	push(chunk: string): string;
	finish(): string;
}

export interface DesktopOperatorOptions {
	connectionGeneration: string;
	/** Must remove host-known secrets. Invoked before output truncation. */
	redact(text: string): string;
	emit(event: DesktopOperatorEvent): void;
	/** Without this capability only status is streamed; content waits for the final result. */
	createStreamRedactor?: () => DesktopOperatorStreamRedactor;
}

type Session = CreateAgentSessionResult["session"];
interface ExecutionResult {
	output: string;
	exitCode: number | undefined;
	cancelled: boolean;
	truncated: boolean;
	signal?: string;
}
interface Operation {
	dto: DesktopOperatorOperation;
	stream?: DesktopOperatorStreamRedactor;
	privacyFailed: boolean;
}

// A second controller cannot start work while a disposed predecessor's executor
// is still unwinding. Only the actual SDK promise's finally releases this lease.
const executions = new WeakMap<Session, Operation>();

function object(value: unknown, keys: readonly string[]): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new DesktopOperatorError("invalid_input");
	const prototype: unknown = Object.getPrototypeOf(value);
	if (prototype !== Object.prototype && prototype !== null) throw new DesktopOperatorError("invalid_input");
	const names = Reflect.ownKeys(value);
	if (names.length !== keys.length || names.some(key => typeof key !== "string" || !keys.includes(key)))
		throw new DesktopOperatorError("invalid_input");
	for (const key of keys) {
		const descriptor = Object.getOwnPropertyDescriptor(value, key);
		if (!descriptor || !descriptor.enumerable || !("value" in descriptor))
			throw new DesktopOperatorError("invalid_input");
	}
	return value as Record<string, unknown>;
}

function input(value: unknown): { kind: DesktopOperatorKind; source: string; excludeFromContext: boolean } {
	const { text } = object(value, ["text"]);
	if (typeof text !== "string" || text.length > DESKTOP_OPERATOR_LIMITS.inputChars || text.includes("\0"))
		throw new DesktopOperatorError("invalid_input");
	const submitted = text.trim();
	const kind = submitted.startsWith("!") ? "bash" : submitted.startsWith("$") ? "python" : undefined;
	if (!kind) throw new DesktopOperatorError("invalid_input");
	const excludeFromContext = submitted.startsWith("!!") || submitted.startsWith("$$");
	const source = submitted.slice(excludeFromContext ? 2 : 1).trim();
	if (!source) throw new DesktopOperatorError("invalid_input");
	return { kind, source, excludeFromContext };
}

function terminal(operation: Operation): boolean {
	return operation.dto.status !== "running" && operation.dto.status !== "cancel_requested";
}

function copy(operation: Operation): DesktopOperatorOperation {
	return { ...operation.dto, ...(operation.dto.error ? { error: { ...operation.dto.error } } : {}) };
}

/** Connection-local controls over the real session executors; never a prompt or process surrogate. */
export class DesktopOperatorController {
	readonly #session: Session;
	readonly #sessionId: string;
	readonly #managerSessionId: string;
	readonly #generation: number;
	readonly #connectionGeneration: string;
	readonly #redact: (text: string) => string;
	readonly #emit: (event: DesktopOperatorEvent) => void;
	readonly #createStreamRedactor: (() => DesktopOperatorStreamRedactor) | undefined;
	readonly #operations = new Map<string, Operation>();
	#disposed = false;
	#stale = false;
	#folding = false;

	constructor(session: Session, options: DesktopOperatorOptions) {
		if (
			typeof options.connectionGeneration !== "string" ||
			!options.connectionGeneration ||
			options.connectionGeneration.length > 128
		)
			throw new DesktopOperatorError("invalid_input");
		if (
			typeof options.redact !== "function" ||
			typeof options.emit !== "function" ||
			(options.createStreamRedactor !== undefined && typeof options.createStreamRedactor !== "function")
		)
			throw new DesktopOperatorError("invalid_input");
		this.#session = session;
		this.#sessionId = session.sessionId;
		this.#managerSessionId = session.sessionManager.getSessionId();
		this.#generation = session.sessionLifecycle.generation;
		this.#connectionGeneration = options.connectionGeneration;
		this.#redact = options.redact;
		this.#emit = options.emit;
		this.#createStreamRedactor = options.createStreamRedactor;
		this.#assertCurrent();
	}

	#assertCurrent(allowTransition = false): void {
		const lifecycle = this.#session.sessionLifecycle;
		if (this.#disposed || lifecycle.disposed) throw new DesktopOperatorError("disposed");
		if (
			this.#stale ||
			lifecycle.generation !== this.#generation ||
			this.#session.sessionId !== this.#sessionId ||
			this.#session.sessionManager.getSessionId() !== this.#managerSessionId
		) {
			this.#stale = true;
			throw new DesktopOperatorError("stale_session");
		}
		if (lifecycle.transitioning && !allowTransition) throw new DesktopOperatorError("session_transitioning");
	}

	#current(allowTransition = false): boolean {
		try {
			this.#assertCurrent(allowTransition);
			return true;
		} catch {
			return false;
		}
	}

	#publish(operation: Operation): void {
		if (!this.#current()) return;
		// Transport failure is not execution failure or completion evidence.
		try {
			this.#emit({ type: "operator.updated", operation: copy(operation) });
		} catch {
			/* The host owns transport recovery. */
		}
	}

	#text(text: string): string {
		const redacted: unknown = this.#redact(text);
		if (typeof redacted !== "string") throw new DesktopOperatorError("redaction_failed");
		return redacted
			.replace(/\x1b\][\s\S]*?(?:\x07|\x1b\\)/g, "")
			.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
			.replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, "");
	}

	#withhold(operation: Operation): void {
		operation.privacyFailed = true;
		operation.stream = undefined;
		operation.dto.output = "";
		operation.dto.liveOutput = "withheld";
	}

	#chunk(operation: Operation, chunk: string): void {
		if (!this.#current(true) || !operation.stream || operation.privacyFailed) return;
		try {
			const safe: unknown = operation.stream.push(chunk);
			if (typeof safe !== "string") throw new DesktopOperatorError("redaction_failed");
			const text = this.#text(safe);
			if (!text) return;
			const combined = operation.dto.output + text;
			operation.dto.outputTruncated ||= combined.length > DESKTOP_OPERATOR_LIMITS.outputChars;
			operation.dto.output = combined.slice(-DESKTOP_OPERATOR_LIMITS.outputChars);
		} catch {
			this.#withhold(operation);
		}
		this.#publish(operation);
	}

	#find(value: unknown): Operation {
		this.#assertCurrent();
		const { operationId } = object(value, ["operationId"]);
		if (typeof operationId !== "string" || !operationId || operationId.length > 128)
			throw new DesktopOperatorError("invalid_input");
		const operation = this.#operations.get(operationId);
		if (!operation) throw new DesktopOperatorError("not_found");
		return operation;
	}

	/** Starts synchronously and returns immediately, keeping detail/abort/fold reachable. */
	execute(value: unknown): DesktopOperatorOperation {
		this.#assertCurrent();
		const parsed = input(value);
		if (executions.has(this.#session) || this.#session.isBashRunning || this.#session.isEvalRunning)
			throw new DesktopOperatorError("busy");
		if (
			(parsed.kind === "bash" && typeof this.#session.executeBash !== "function") ||
			(parsed.kind === "python" && typeof this.#session.executePython !== "function")
		)
			throw new DesktopOperatorError("unsupported");
		let stream: DesktopOperatorStreamRedactor | undefined;
		try {
			stream = this.#createStreamRedactor?.();
			if (
				this.#createStreamRedactor &&
				(!stream || typeof stream.push !== "function" || typeof stream.finish !== "function")
			)
				throw new DesktopOperatorError("redaction_failed");
		} catch {
			throw new DesktopOperatorError("redaction_failed");
		}
		this.#assertCurrent();
		if (executions.has(this.#session) || this.#session.isBashRunning || this.#session.isEvalRunning)
			throw new DesktopOperatorError("busy");
		const operation: Operation = {
			dto: {
				operationId: crypto.randomUUID(),
				connectionGeneration: this.#connectionGeneration,
				sessionGeneration: this.#generation,
				kind: parsed.kind,
				excludeFromContext: parsed.excludeFromContext,
				status: "running",
				output: "",
				outputTruncated: false,
				liveOutput: stream ? "redacted" : "withheld",
			},
			stream,
			privacyFailed: false,
		};
		while (this.#operations.size >= DESKTOP_OPERATOR_LIMITS.operations) {
			const oldest = this.#operations.keys().next().value;
			if (oldest === undefined) break;
			this.#operations.delete(oldest);
		}
		this.#operations.set(operation.dto.operationId, operation);
		executions.set(this.#session, operation);
		// Capture the admitted state before emit can re-enter host code.
		const admitted = copy(operation);
		void this.#run(operation, parsed.source, parsed.excludeFromContext);
		this.#publish(operation);
		return admitted;
	}

	async #run(operation: Operation, source: string, excludeFromContext: boolean): Promise<void> {
		try {
			this.#assertCurrent();
			const onChunk = (chunk: string) => this.#chunk(operation, chunk);
			const result: ExecutionResult =
				operation.dto.kind === "bash"
					? await this.#session.executeBash(source, onChunk, { excludeFromContext })
					: await this.#session.executePython(source, onChunk, { excludeFromContext });
			// Keep settlement private during preparation: a rolled-back transition
			// must not strand a finished operation as running. Publication and every
			// control still require non-transitioning authority.
			if (!this.#current(true)) return;
			try {
				if (operation.stream) {
					const tail: unknown = operation.stream.finish();
					if (typeof tail !== "string") throw new DesktopOperatorError("redaction_failed");
					// Validate all released content even though the SDK final result replaces the preview.
					this.#text(tail);
				}
				if (operation.privacyFailed) throw new DesktopOperatorError("redaction_failed");
				const text = this.#text(result.output);
				operation.dto.outputTruncated = result.truncated || text.length > DESKTOP_OPERATOR_LIMITS.outputChars;
				operation.dto.output = text.slice(-DESKTOP_OPERATOR_LIMITS.outputChars);
				operation.dto.exitCode = result.exitCode;
				if (result.signal !== undefined) operation.dto.signal = this.#text(result.signal).slice(0, 128);
				operation.dto.status = result.cancelled ? "cancelled" : "completed";
			} catch {
				this.#withhold(operation);
				this.#fail(operation, "redaction_failed");
			}
		} catch {
			if (this.#current(true))
				this.#fail(operation, operation.privacyFailed ? "redaction_failed" : "backend_failure");
		} finally {
			// Neither disposal, an abort request, nor a fold is settlement proof.
			if (executions.get(this.#session) === operation) executions.delete(this.#session);
			operation.stream = undefined;
			this.#publish(operation);
		}
	}

	#fail(operation: Operation, code: DesktopOperatorErrorCode): void {
		operation.dto.status = "failed";
		operation.dto.error = { code, message: REASONS[code] };
	}

	/**
	 * Host admission signal for this captured session, including other controllers.
	 * Remains readable after disposal/staleness and clears only when the admitted
	 * SDK execution promise settles. It does not certify physical resource cleanup.
	 */
	isBusy(): boolean {
		return executions.has(this.#session);
	}

	getOperation(value: unknown): DesktopOperatorOperation {
		return copy(this.#find(value));
	}

	abort(value: unknown): DesktopOperatorOperation {
		const operation = this.#find(value);
		if (terminal(operation)) throw new DesktopOperatorError("already_terminal");
		if (executions.get(this.#session) !== operation) throw new DesktopOperatorError("not_found");
		try {
			if (operation.dto.kind === "bash") this.#session.abortBash();
			else this.#session.abortEval();
		} catch {
			throw new DesktopOperatorError("backend_failure");
		}
		operation.dto.status = "cancel_requested";
		this.#publish(operation);
		return copy(operation);
	}

	/** Canonical managed foreground-tool control, deliberately not operation-ID scoped. */
	async fold(value: unknown): Promise<DesktopOperatorFoldResult> {
		this.#assertCurrent();
		object(value, []);
		if (this.#folding) throw new DesktopOperatorError("busy");
		const unsupported: DesktopOperatorFoldResult = { target: "current_foreground_tool", status: "unsupported" };
		if (
			typeof this.#session.hasForegroundBashBackgroundRequestHandler !== "function" ||
			typeof this.#session.requestForegroundBashBackgroundOutcome !== "function" ||
			!this.#session.hasForegroundBashBackgroundRequestHandler()
		)
			return unsupported;
		this.#folding = true;
		try {
			const outcome = await this.#session.requestForegroundBashBackgroundOutcome("sdk_control");
			this.#assertCurrent();
			if (outcome.status === "folded" || outcome.status === "already_backgrounded")
				return { target: "current_foreground_tool", status: outcome.status };
			return unsupported;
		} catch (error) {
			if (error instanceof DesktopOperatorError) throw error;
			throw new DesktopOperatorError("backend_failure");
		} finally {
			this.#folding = false;
		}
	}

	dispose(): void {
		if (this.#disposed) return;
		const current = this.#current();
		this.#disposed = true;
		const active = executions.get(this.#session);
		if (current && active && this.#operations.get(active.dto.operationId) === active) {
			try {
				if (active.dto.kind === "bash") this.#session.abortBash();
				else this.#session.abortEval();
			} catch {
				/* Disposal is not a successful abort acknowledgement. */
			}
		}
		this.#operations.clear();
	}
}

export function createDesktopOperatorController(
	session: Session,
	options: DesktopOperatorOptions,
): DesktopOperatorController {
	return new DesktopOperatorController(session, options);
}
