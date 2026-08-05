import { AsyncLocalStorage } from "node:async_hooks";

const initializerContext = new AsyncLocalStorage<symbol>();

export type LazyServiceState = "idle" | "initializing" | "ready" | "failed" | "disabled" | "disposed";

export interface LazyServiceStatus {
	id: string;
	state: LazyServiceState;
	trigger?: string;
	initializedAt?: number;
	error?: unknown;
}

export interface LazyService<T> {
	status(): LazyServiceStatus;
	peek(): T | undefined;
	get(trigger: string): Promise<T>;
	prewarm(trigger?: string): Promise<void>;
	dispose(): Promise<void>;
}

export interface LazyServiceOptions<T> {
	id: string;
	enabled?: () => boolean;
	initialize: (ctx: { trigger: string; signal: AbortSignal }) => Promise<{
		value: T;
		dispose?: () => void | Promise<void>;
	}>;
}

export class LazyServiceDisabledError extends Error {
	readonly id: string;

	constructor(id: string) {
		super(`Lazy service "${id}" is disabled.`);
		this.name = "LazyServiceDisabledError";
		this.id = id;
	}
}

export class LazyServiceFailedError extends Error {
	readonly id: string;
	declare readonly cause: unknown;

	constructor(id: string, cause: unknown) {
		super(`Lazy service "${id}" failed to initialize.`, { cause });
		this.name = "LazyServiceFailedError";
		this.id = id;
	}
}

export class LazyServiceDisposedError extends Error {
	readonly id: string;

	constructor(id: string) {
		super(`Lazy service "${id}" has been disposed.`);
		this.name = "LazyServiceDisposedError";
		this.id = id;
	}
}
export class LazyServiceReentrantDisposeError extends Error {
	readonly id: string;

	constructor(id: string) {
		super(`Lazy service "${id}" cannot be disposed from its initializer.`);
		this.name = "LazyServiceReentrantDisposeError";
		this.id = id;
	}
}

type InitializationResult<T> = Awaited<ReturnType<LazyServiceOptions<T>["initialize"]>>;

export function createLazyService<T>(options: LazyServiceOptions<T>): LazyService<T> {
	let state: LazyServiceState = "idle";
	let firstTrigger: string | undefined;
	let initializedAt: number | undefined;
	let diagnostic: unknown;
	let value: T | undefined;
	let teardown: (() => void | Promise<void>) | undefined;
	let teardownPromise: Promise<void> | undefined;
	let initializationController: AbortController | undefined;
	let initializationResultPromise: Promise<InitializationResult<T>> | undefined;
	let sharedPromise: Promise<T> | undefined;
	let disposalStarted = false;
	let disposalPromise: Promise<void> | undefined;
	let initializationToken: symbol | undefined;

	const disabledError = (): LazyServiceDisabledError => new LazyServiceDisabledError(options.id);
	const disposedError = (): LazyServiceDisposedError => new LazyServiceDisposedError(options.id);

	const runTeardown = (dispose?: () => void | Promise<void>): Promise<void> => {
		if (teardownPromise) return teardownPromise;
		teardownPromise = dispose ? Promise.resolve().then(() => dispose()) : Promise.resolve();
		return teardownPromise;
	};

	const startInitialization = (trigger: string): Promise<T> => {
		if (disposalStarted || state === "disposed") return Promise.reject(disposedError());
		firstTrigger = trigger;
		state = "initializing";

		const controller = new AbortController();
		initializationController = controller;

		initializationToken = Symbol(options.id);
		const resultPromise = Promise.resolve().then(() =>
			initializerContext.run(initializationToken!, () => options.initialize({ trigger, signal: controller.signal })),
		);
		initializationResultPromise = resultPromise;

		const result = resultPromise.then(
			initialized => {
				if (!disposalStarted) {
					value = initialized.value;
					teardown = initialized.dispose;
					initializedAt = Date.now();
					state = "ready";
					return initialized.value;
				}
				const failure = disposedError();
				diagnostic = failure;
				throw failure;
			},
			cause => {
				const failure = new LazyServiceFailedError(options.id, cause);
				diagnostic = failure;
				state = "failed";
				throw failure;
			},
		);
		sharedPromise = result;
		return result;
	};

	const get = (trigger: string): Promise<T> => {
		if (state === "disposed" || disposalStarted) {
			const failure = disposedError();
			diagnostic ??= failure;
			return Promise.reject(failure);
		}
		if (state === "disabled") {
			const failure = disabledError();
			diagnostic ??= failure;
			return Promise.reject(failure);
		}
		if (state === "failed") {
			const failure =
				diagnostic instanceof LazyServiceFailedError
					? diagnostic
					: new LazyServiceFailedError(options.id, diagnostic);
			return Promise.reject(failure);
		}
		if (sharedPromise) return sharedPromise;
		if (state === "idle") {
			const enabled = options.enabled ? options.enabled() : true;
			if (disposalStarted) return Promise.reject(disposedError());
			if (!enabled) {
				state = "disabled";
				const failure = disabledError();
				diagnostic = failure;
				return Promise.reject(failure);
			}
			return startInitialization(trigger);
		}
		return Promise.reject(new Error(`Lazy service "${options.id}" is in an invalid state.`));
	};

	const dispose = (): Promise<void> => {
		if (
			state === "initializing" &&
			initializationToken !== undefined &&
			initializerContext.getStore() === initializationToken
		) {
			const error = new LazyServiceReentrantDisposeError(options.id);
			const rejected = Promise.reject(error);
			void rejected.catch(() => undefined);
			return rejected;
		}
		if (disposalPromise) return disposalPromise;
		disposalStarted = true;
		disposalPromise = (async () => {
			if (state === "idle" || state === "disabled") {
				state = "disposed";
				return;
			}
			if (state === "failed") {
				state = "disposed";
				return;
			}
			if (state === "initializing") {
				initializationController?.abort();
				let initialized: InitializationResult<T> | undefined;
				let failure: unknown;
				try {
					initialized = await initializationResultPromise;
				} catch (cause) {
					failure =
						diagnostic instanceof LazyServiceFailedError
							? diagnostic
							: new LazyServiceFailedError(options.id, cause);
					diagnostic = failure;
				}
				let teardownFailure: unknown;
				if (initialized) {
					try {
						await runTeardown(initialized.dispose);
					} catch (cause) {
						teardownFailure = cause;
						diagnostic ??= cause;
					}
				}
				value = undefined;
				teardown = undefined;
				state = "disposed";
				if (failure !== undefined) throw failure;
				if (teardownFailure !== undefined) throw teardownFailure;
				return;
			}
			if (state === "ready") {
				let teardownFailure: unknown;
				try {
					await runTeardown(teardown);
				} catch (cause) {
					teardownFailure = cause;
					diagnostic ??= cause;
				}
				value = undefined;
				teardown = undefined;
				state = "disposed";
				if (teardownFailure !== undefined) throw teardownFailure;
				return;
			}
		})();
		return disposalPromise;
	};

	return {
		status(): LazyServiceStatus {
			return {
				id: options.id,
				state,
				...(firstTrigger === undefined ? {} : { trigger: firstTrigger }),
				...(initializedAt === undefined ? {} : { initializedAt }),
				...(diagnostic === undefined ? {} : { error: diagnostic }),
			};
		},
		peek(): T | undefined {
			return state === "ready" ? value : undefined;
		},
		get,
		async prewarm(trigger = "prewarm"): Promise<void> {
			try {
				await get(trigger);
			} catch (cause) {
				// Prewarm is fire-and-forget, so it never throws during shutdown; retain the typed diagnostic instead.
				diagnostic = cause;
			}
		},
		dispose,
	};
}
