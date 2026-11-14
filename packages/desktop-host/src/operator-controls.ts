import {
	type CreateAgentSessionResult,
	createSdkOperatorControls,
	SDK_OPERATOR_LIMITS,
	type SdkOperatorControls,
	SdkOperatorError,
	type SdkOperatorReadResult,
	type SdkOperatorSnapshot,
} from "@gajae-code/coding-agent/sdk";
import type {
	DesktopOperatorErrorCode,
	DesktopOperatorEvent,
	DesktopOperatorFoldResult,
	DesktopOperatorOperation,
} from "./operator-protocol";

export const DESKTOP_OPERATOR_LIMITS = SDK_OPERATOR_LIMITS;

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

/** A host-owned privacy overlay; SDK controls retain execution and cancellation authority. */
export interface DesktopOperatorStreamRedactor {
	push(chunk: string): string;
	finish(): string;
}

export interface DesktopOperatorOptions {
	connectionGeneration: string;
	redact(text: string): string;
	emit(event: DesktopOperatorEvent): void;
	createStreamRedactor?: () => DesktopOperatorStreamRedactor;
}

type Session = CreateAgentSessionResult["session"];
interface Operation {
	dto: DesktopOperatorOperation;
	stream?: DesktopOperatorStreamRedactor;
	cursor: number;
	privacyFailed: boolean;
	terminal: boolean;
	published?: string;
}

function mapped(error: unknown): DesktopOperatorError {
	if (error instanceof DesktopOperatorError) return error;
	if (error instanceof SdkOperatorError)
		return new DesktopOperatorError(error.code === "stale_cursor" ? "backend_failure" : error.code);
	return new DesktopOperatorError("backend_failure");
}

function reference(value: unknown): string {
	try {
		if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error();
		const prototype: unknown = Object.getPrototypeOf(value);
		if (prototype !== Object.prototype && prototype !== null) throw new Error();
		const keys = Reflect.ownKeys(value);
		const descriptor = Object.getOwnPropertyDescriptor(value, "operationId");
		if (
			keys.length !== 1 ||
			keys[0] !== "operationId" ||
			!descriptor ||
			!descriptor.enumerable ||
			!("value" in descriptor) ||
			typeof descriptor.value !== "string" ||
			!descriptor.value ||
			descriptor.value.length > 128
		)
			throw new Error();
		return descriptor.value;
	} catch {
		throw new DesktopOperatorError("invalid_input");
	}
}

function copy(operation: Operation): DesktopOperatorOperation {
	return { ...operation.dto, ...(operation.dto.error ? { error: { ...operation.dto.error } } : {}) };
}

/** Connection-local wire projection. SDK controls alone own operations, admission and cancellation. */
export class DesktopOperatorController {
	readonly #session: Session;
	readonly #sdk: SdkOperatorControls;
	readonly #options: DesktopOperatorOptions;
	readonly #operations = new Map<string, Operation>();
	// Only the foreground-fold capability gap needs a captured native identity.
	readonly #generation: number;
	readonly #sessionId: string;
	readonly #manager: Session["sessionManager"];
	readonly #identity: number;
	#disposed = false;
	#folding = false;
	#calling = false;

	constructor(session: Session, options: DesktopOperatorOptions) {
		if (
			typeof options.connectionGeneration !== "string" ||
			!options.connectionGeneration ||
			options.connectionGeneration.length > 128 ||
			typeof options.redact !== "function" ||
			typeof options.emit !== "function" ||
			(options.createStreamRedactor !== undefined && typeof options.createStreamRedactor !== "function")
		)
			throw new DesktopOperatorError("invalid_input");
		this.#session = session;
		this.#options = { ...options };
		this.#generation = session.sessionLifecycle.generation;
		this.#sessionId = session.sessionId;
		this.#manager = session.sessionManager;
		this.#identity = this.#manager.getSessionIdentityGeneration();
		try {
			this.#sdk = createSdkOperatorControls(session);
		} catch (error) {
			throw mapped(error);
		}
	}

	#live(): void {
		if (this.#disposed || this.#session.sessionLifecycle.disposed) throw new DesktopOperatorError("disposed");
		if (this.#session.sessionLifecycle.transitioning) throw new DesktopOperatorError("session_transitioning");
		if (this.#calling) throw new DesktopOperatorError("busy");
	}

	#external<T>(action: () => T): T {
		this.#calling = true;
		try {
			return action();
		} finally {
			this.#calling = false;
		}
	}

	#text(text: string): string {
		const safe: unknown = this.#external(() => this.#options.redact(text));
		if (typeof safe !== "string") throw new DesktopOperatorError("redaction_failed");
		return safe
			.toWellFormed()
			.replace(/\x1b\][\s\S]*?(?:\x07|\x1b\\)/g, "")
			.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
			.replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, "");
	}

	#publish(operation: Operation): void {
		if (this.#disposed || this.#sdk.disposed || this.#session.sessionLifecycle.transitioning) return;
		const published = JSON.stringify(operation.dto);
		if (operation.published === published) return;
		operation.published = published;
		try {
			this.#external(() => this.#options.emit({ type: "operator.updated", operation: copy(operation) }));
		} catch {
			/* A transport observer cannot alter SDK settlement. */
		}
	}

	#project(operation: Operation, snapshot: SdkOperatorSnapshot): void {
		operation.terminal = snapshot.terminal;
		operation.dto.status = snapshot.status;
		operation.dto.outputTruncated ||= snapshot.outputTruncated;
		if (snapshot.error) {
			const code = mapped(new SdkOperatorError(snapshot.error.code)).code;
			operation.dto.error = { code, message: REASONS[code] };
		}
		if (!snapshot.terminal) return;
		try {
			if (operation.stream) {
				const tail: unknown = this.#external(() => operation.stream!.finish());
				if (typeof tail !== "string") throw new Error();
				this.#text(tail);
			}
			if (operation.privacyFailed) throw new Error();
			// The SDK retains bounded raw output. A cut-through host secret cannot be
			// reconstructed by this overlay, so never publish a truncated raw snapshot.
			let safe = "";
			if (!snapshot.outputTruncated) {
				let text = snapshot.output;
				if (this.#options.createStreamRedactor) {
					text = this.#external(() => {
						const stream = this.#options.createStreamRedactor!();
						const head: unknown = stream.push(text);
						const tail: unknown = stream.finish();
						if (typeof head !== "string" || typeof tail !== "string") throw new Error();
						return head + tail;
					});
				}
				safe = this.#text(text);
			} else operation.dto.liveOutput = "withheld";
			operation.dto.output = safe.slice(-DESKTOP_OPERATOR_LIMITS.outputChars);
			operation.dto.outputTruncated ||= safe.length > DESKTOP_OPERATOR_LIMITS.outputChars;
			if (snapshot.exitCode !== undefined) operation.dto.exitCode = snapshot.exitCode;
			// SDK signal strings are also bounded before this host-only privacy overlay.
			if (snapshot.signal !== undefined && snapshot.signal.length < 128)
				operation.dto.signal = this.#text(snapshot.signal).slice(0, 128);
		} catch {
			operation.privacyFailed = true;
			operation.dto.output = "";
			operation.dto.liveOutput = "withheld";
			operation.dto.status = "failed";
			operation.dto.error = { code: "redaction_failed", message: REASONS.redaction_failed };
		} finally {
			operation.stream = undefined;
		}
	}

	#refresh(operation: Operation): void {
		if (operation.terminal) {
			// Even cached terminal projections must pass the SDK's identity fence.
			this.#sdk.read({ operationId: operation.dto.operationId });
			return;
		}
		let read: SdkOperatorReadResult;
		try {
			read = this.#sdk.read({ operationId: operation.dto.operationId, cursor: operation.cursor });
		} catch (error) {
			if (!(error instanceof SdkOperatorError) || error.code !== "stale_cursor") throw error;
			// A missing chunk breaks host-secret overlap. Withhold live text until the authoritative final snapshot.
			operation.stream = undefined;
			operation.dto.output = "";
			operation.dto.liveOutput = "withheld";
			read = this.#sdk.read({ operationId: operation.dto.operationId });
		}
		if (read.deltasTruncated || read.operation.outputTruncated) {
			operation.stream = undefined;
			operation.dto.output = "";
			operation.dto.liveOutput = "withheld";
		}
		if (!read.operation.terminal && operation.stream && !operation.privacyFailed) {
			try {
				for (const delta of read.deltas) {
					const safe: unknown = this.#external(() => operation.stream!.push(delta.text));
					if (typeof safe !== "string") throw new Error();
					const combined = operation.dto.output + this.#text(safe);
					operation.dto.outputTruncated ||= combined.length > DESKTOP_OPERATOR_LIMITS.outputChars;
					operation.dto.output = combined.slice(-DESKTOP_OPERATOR_LIMITS.outputChars);
				}
			} catch {
				operation.privacyFailed = true;
				operation.stream = undefined;
				operation.dto.output = "";
				operation.dto.liveOutput = "withheld";
			}
		}
		operation.cursor = read.nextCursor;
		this.#project(operation, read.operation);
	}

	async #watch(operation: Operation): Promise<void> {
		while (!this.#disposed && !this.#sdk.disposed && !operation.terminal) {
			await Bun.sleep(25);
			if (this.#disposed || this.#sdk.disposed) return;
			try {
				this.#refresh(operation);
				this.#publish(operation);
			} catch (error) {
				if (error instanceof SdkOperatorError && error.code === "session_transitioning") continue;
				return;
			}
		}
	}

	execute(value: unknown): DesktopOperatorOperation {
		this.#live();
		try {
			let stream: DesktopOperatorStreamRedactor | undefined;
			try {
				stream = this.#external(() => this.#options.createStreamRedactor?.());
				if (
					this.#options.createStreamRedactor &&
					(!stream || typeof stream.push !== "function" || typeof stream.finish !== "function")
				)
					throw new Error();
			} catch {
				throw new DesktopOperatorError("redaction_failed");
			}
			this.#live();
			const snapshot = this.#sdk.execute(value).operation;
			const operation: Operation = {
				dto: {
					operationId: snapshot.operationId,
					connectionGeneration: this.#options.connectionGeneration,
					sessionGeneration: snapshot.sessionGeneration,
					kind: snapshot.kind,
					excludeFromContext: snapshot.excludeFromContext,
					status: snapshot.status,
					output: "",
					outputTruncated: false,
					liveOutput: stream ? "redacted" : "withheld",
				},
				stream,
				cursor: 0,
				privacyFailed: false,
				terminal: false,
			};
			while (this.#operations.size >= DESKTOP_OPERATOR_LIMITS.operations) {
				const oldest = this.#operations.keys().next().value;
				if (oldest === undefined) break;
				this.#operations.delete(oldest);
			}
			this.#operations.set(snapshot.operationId, operation);
			const admitted = copy(operation);
			void this.#watch(operation);
			this.#publish(operation);
			return admitted;
		} catch (error) {
			throw mapped(error);
		}
	}

	isBusy(): boolean {
		return this.#sdk.isBusy();
	}

	getOperation(value: unknown): DesktopOperatorOperation {
		this.#live();
		try {
			const operationId = reference(value);
			const operation = this.#operations.get(operationId);
			if (!operation) {
				// SDK identity errors take precedence over a missing local projection.
				this.#sdk.read({ operationId });
				throw new DesktopOperatorError("not_found");
			}
			this.#refresh(operation);
			this.#live();
			return copy(operation);
		} catch (error) {
			throw mapped(error);
		}
	}

	abort(value: unknown): DesktopOperatorOperation {
		this.#live();
		try {
			const operationId = reference(value);
			const snapshot = this.#sdk.cancel({ operationId });
			const operation = this.#operations.get(operationId);
			if (!operation) throw new DesktopOperatorError("not_found");
			this.#project(operation, snapshot);
			this.#publish(operation);
			return copy(operation);
		} catch (error) {
			throw mapped(error);
		}
	}

	/** SDK gap: local exported operator controls have no bash.background operation. */
	async fold(value: unknown): Promise<DesktopOperatorFoldResult> {
		this.#live();
		const assertCurrent = () => {
			this.#live();
			if (this.#session.sessionLifecycle.disposed) throw new DesktopOperatorError("disposed");
			if (
				this.#session.sessionLifecycle.generation !== this.#generation ||
				this.#session.sessionId !== this.#sessionId ||
				this.#session.sessionManager !== this.#manager ||
				this.#manager.getSessionIdentityGeneration() !== this.#identity
			)
				throw new DesktopOperatorError("stale_session");
			if (this.#session.sessionLifecycle.transitioning) throw new DesktopOperatorError("session_transitioning");
		};
		assertCurrent();
		try {
			if (
				!value ||
				typeof value !== "object" ||
				Array.isArray(value) ||
				![Object.prototype, null].includes(Object.getPrototypeOf(value)) ||
				Reflect.ownKeys(value).length
			)
				throw new DesktopOperatorError("invalid_input");
		} catch {
			throw new DesktopOperatorError("invalid_input");
		}
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
			assertCurrent();
			return outcome.status === "folded" || outcome.status === "already_backgrounded"
				? { target: "current_foreground_tool", status: outcome.status }
				: unsupported;
		} catch (error) {
			throw mapped(error);
		} finally {
			this.#folding = false;
		}
	}

	dispose(): void {
		if (this.#disposed) return;
		this.#disposed = true;
		this.#sdk.dispose();
		this.#operations.clear();
	}
}

export function createDesktopOperatorController(
	session: Session,
	options: DesktopOperatorOptions,
): DesktopOperatorController {
	return new DesktopOperatorController(session, options);
}
