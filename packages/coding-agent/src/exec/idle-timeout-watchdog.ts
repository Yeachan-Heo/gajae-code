export type ExecutionAbortReason = "idle-timeout" | "signal";

export interface IdleTimeoutWatchdogOptions {
	timeoutMs?: number;
	signal?: AbortSignal;
	hardTimeoutGraceMs: number;
	onAbort?: (reason: ExecutionAbortReason) => void;
}

export class IdleTimeoutWatchdog {
	#abortController = new AbortController();
	#abortReason?: ExecutionAbortReason;
	#hardTimeoutDeferred = Promise.withResolvers<"hard-timeout">();
	#hardTimeoutGraceMs: number;
	#hardTimeoutTimer?: NodeJS.Timeout;
	#idleTimer?: NodeJS.Timeout;
	#onAbort?: (reason: ExecutionAbortReason) => void;
	#signal?: AbortSignal;
	#signalAbortHandler?: () => void;
	#timeoutMs?: number;

	constructor(options: IdleTimeoutWatchdogOptions) {
		this.#timeoutMs = options.timeoutMs;
		this.#hardTimeoutGraceMs = options.hardTimeoutGraceMs;
		this.#onAbort = options.onAbort;
		this.#signal = options.signal;

		if (this.#signal) {
			if (this.#signal.aborted) {
				this.#abort("signal");
				return;
			}

			this.#signalAbortHandler = () => {
				this.#abort("signal");
			};
			this.#signal.addEventListener("abort", this.#signalAbortHandler, { once: true });
		}

		this.touch();
	}

	get abortedBySignal(): boolean {
		return this.#abortReason === "signal";
	}

	get hardTimeoutPromise(): Promise<"hard-timeout"> {
		return this.#hardTimeoutDeferred.promise;
	}

	get signal(): AbortSignal {
		return this.#abortController.signal;
	}

	get timedOut(): boolean {
		return this.#abortReason === "idle-timeout";
	}

	touch(): void {
		if (this.#abortReason || this.#timeoutMs === undefined || this.#timeoutMs <= 0) {
			return;
		}

		if (this.#idleTimer) {
			clearTimeout(this.#idleTimer);
		}

		this.#idleTimer = setTimeout(() => {
			this.#abort("idle-timeout");
		}, this.#timeoutMs);
	}

	dispose(): void {
		if (this.#idleTimer) {
			clearTimeout(this.#idleTimer);
			this.#idleTimer = undefined;
		}
		if (this.#hardTimeoutTimer) {
			clearTimeout(this.#hardTimeoutTimer);
			this.#hardTimeoutTimer = undefined;
		}
		if (this.#signal && this.#signalAbortHandler) {
			this.#signal.removeEventListener("abort", this.#signalAbortHandler);
			this.#signalAbortHandler = undefined;
		}
		//resolve hardTimeoutDeferred on dispose to prevent promise leak
		this.#hardTimeoutDeferred.resolve("hard-timeout");
	}

	#abort(reason: ExecutionAbortReason): void {
		if (this.#abortReason) {
			return;
		}

		this.#abortReason = reason;

		if (this.#idleTimer) {
			clearTimeout(this.#idleTimer);
			this.#idleTimer = undefined;
		}

		if (!this.#abortController.signal.aborted) {
			this.#abortController.abort(reason);
		}

		this.#onAbort?.(reason);
		this.#armHardTimeout();
	}

	#armHardTimeout(): void {
		if (this.#hardTimeoutTimer || this.#hardTimeoutGraceMs <= 0) {
			return;
		}

		this.#hardTimeoutTimer = setTimeout(() => {
			this.#hardTimeoutDeferred.resolve("hard-timeout");
		}, this.#hardTimeoutGraceMs);
	}
}

export function formatIdleTimeoutMessage(timeoutMs?: number): string {
	if (timeoutMs === undefined) {
		return "Command timed out without output";
	}

	const seconds = Math.max(1, Math.round(timeoutMs / 1000));
	return `Command timed out after ${seconds} seconds without output`;
}
