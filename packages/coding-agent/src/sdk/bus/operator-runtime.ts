export interface NotificationOperatorTimerDeps {
	now?: () => number;
	setTimeoutImpl?: typeof setTimeout;
	clearTimeoutImpl?: typeof clearTimeout;
	setIntervalImpl?: typeof setInterval;
	clearIntervalImpl?: typeof clearInterval;
}

export interface NotificationOperatorRuntimeState {
	running: boolean;
	stopRequested: boolean;
	activeAbort: boolean;
}

export interface OperatorBackoffOptions {
	initialMs: number;
	maxMs: number;
	factor?: number;
}

type OperatorIntervalHandle = number | NodeJS.Timeout;

export class OperatorBackoffPolicy {
	#currentMs = 0;
	#opts: OperatorBackoffOptions;

	constructor(opts: OperatorBackoffOptions) {
		this.#opts = opts;
	}

	next(): number {
		this.#currentMs =
			this.#currentMs === 0
				? this.#opts.initialMs
				: Math.min(this.#currentMs * (this.#opts.factor ?? 2), this.#opts.maxMs);
		return this.#currentMs;
	}

	reset(): void {
		this.#currentMs = 0;
	}

	get currentMs(): number {
		return this.#currentMs;
	}
}

export interface OperatorRoute<TContext> {
	name: string;
	matches(event: Record<string, unknown>): boolean;
	handle(context: TContext, event: Record<string, unknown>): Promise<void> | void;
}

export class OperatorEventRouter<TContext> {
	readonly routes: OperatorRoute<TContext>[] = [];

	add(input: OperatorRoute<TContext>): this {
		this.routes.push(input);
		return this;
	}

	async dispatch(context: TContext, event: Record<string, unknown>): Promise<boolean> {
		for (const route of this.routes) {
			if (!route.matches(event)) continue;
			await route.handle(context, event);
			return true;
		}
		return false;
	}
}

export class NotificationOperatorRuntime {
	#running = false;
	#stopRequested = false;
	#activeAbort: AbortController | undefined;
	#intervals = new Map<string, OperatorIntervalHandle>();
	#exclusive = new Set<string>();

	#deps: NotificationOperatorTimerDeps;

	constructor(deps: NotificationOperatorTimerDeps = {}) {
		this.#deps = deps;
	}

	get state(): NotificationOperatorRuntimeState {
		return {
			running: this.#running,
			stopRequested: this.#stopRequested,
			activeAbort: this.#activeAbort !== undefined,
		};
	}

	start(): void {
		this.#running = true;
		this.#stopRequested = false;
	}

	stop(): void {
		this.#running = false;
	}

	requestStop(): void {
		this.#stopRequested = true;
		this.#running = false;
		this.#activeAbort?.abort();
	}

	get running(): boolean {
		return this.#running;
	}

	get stopRequested(): boolean {
		return this.#stopRequested;
	}

	createAbortController(): AbortController {
		this.#activeAbort = new AbortController();
		return this.#activeAbort;
	}

	clearAbortController(controller: AbortController): void {
		if (this.#activeAbort === controller) this.#activeAbort = undefined;
	}

	startInterval(name: string, intervalMs: number, tick: () => void): void {
		if (this.#intervals.has(name)) return;
		const setIntervalImpl = this.#deps.setIntervalImpl ?? setInterval;
		this.#intervals.set(name, setIntervalImpl(tick, intervalMs) as OperatorIntervalHandle);
	}

	stopInterval(name: string): void {
		const timer = this.#intervals.get(name);
		if (!timer) return;
		const clearIntervalImpl = this.#deps.clearIntervalImpl ?? clearInterval;
		clearIntervalImpl(timer);
		this.#intervals.delete(name);
	}

	stopAllIntervals(): void {
		for (const name of [...this.#intervals.keys()]) this.stopInterval(name);
	}

	async runExclusive(name: string, fn: () => Promise<void>): Promise<void> {
		if (this.#exclusive.has(name)) return;
		this.#exclusive.add(name);
		try {
			await fn();
		} finally {
			this.#exclusive.delete(name);
		}
	}

	sleep(ms: number, signal?: AbortSignal): Promise<void> {
		return new Promise<void>(resolve => {
			if (signal?.aborted) return resolve();
			const timer = (this.#deps.setTimeoutImpl ?? setTimeout)(() => resolve(), ms);
			signal?.addEventListener(
				"abort",
				() => {
					(this.#deps.clearTimeoutImpl ?? clearTimeout)(timer);
					resolve();
				},
				{ once: true },
			);
		});
	}

	now(): number {
		return (this.#deps.now ?? Date.now)();
	}
}
