import { describe, expect, test } from "bun:test";

import {
	createLazyService,
	LazyServiceDisabledError,
	LazyServiceDisposedError,
	LazyServiceFailedError,
	LazyServiceReentrantDisposeError,
} from "./lazy-service";

function deferred<T>(): {
	promise: Promise<T>;
	resolve(value: T): void;
	reject(cause: unknown): void;
} {
	let resolvePromise!: (value: T) => void;
	let rejectPromise!: (cause: unknown) => void;
	const promise = new Promise<T>((resolve, reject) => {
		resolvePromise = resolve;
		rejectPromise = reject;
	});
	return { promise, resolve: resolvePromise, reject: rejectPromise };
}

describe("createLazyService", () => {
	test("dispose racing get aborts initialization and tears down a late result", async () => {
		const gate = deferred<void>();
		let signal: AbortSignal | undefined;
		let teardownCount = 0;
		const service = createLazyService({
			id: "race-get",
			initialize: async ctx => {
				signal = ctx.signal;
				await gate.promise;
				return {
					value: { live: true },
					dispose: () => {
						teardownCount += 1;
					},
				};
			},
		});

		const getPromise = service.get("first-get");
		await Promise.resolve();
		expect(service.status().state).toBe("initializing");
		const disposePromise = service.dispose();
		expect(signal?.aborted).toBe(true);
		gate.resolve(undefined);

		await expect(getPromise).rejects.toBeInstanceOf(LazyServiceDisposedError);
		await disposePromise;
		expect(teardownCount).toBe(1);
		expect(service.status().state).toBe("disposed");
		expect(service.peek()).toBeUndefined();
	});

	test("dispose racing prewarm never throws and waits for late teardown", async () => {
		const gate = deferred<void>();
		let teardownCount = 0;
		const service = createLazyService({
			id: "race-prewarm",
			initialize: async () => {
				await gate.promise;
				return {
					value: "resource",
					dispose: () => {
						teardownCount += 1;
					},
				};
			},
		});

		const prewarmPromise = service.prewarm("startup");
		await Promise.resolve();
		const disposePromise = service.dispose();
		gate.resolve(undefined);

		await prewarmPromise;
		await disposePromise;
		expect(teardownCount).toBe(1);
		expect(service.status().state).toBe("disposed");
	});

	test("initializer failure during disposal remains a typed diagnostic, with disabled and failed states", async () => {
		const gate = deferred<void>();
		const original = new Error("initializer failed");
		const service = createLazyService({
			id: "failure-race",
			initialize: async () => {
				await gate.promise;
				throw original;
			},
		});

		const getPromise = service.get("failure");
		await Promise.resolve();
		const disposePromise = service.dispose();
		gate.resolve(undefined);

		let getError: unknown;
		try {
			await getPromise;
		} catch (cause) {
			getError = cause;
		}
		expect(getError).toBeInstanceOf(LazyServiceFailedError);
		expect((getError as LazyServiceFailedError).cause).toBe(original);
		let disposeError: unknown;
		try {
			await disposePromise;
		} catch (cause) {
			disposeError = cause;
		}
		expect(disposeError).toBeInstanceOf(LazyServiceFailedError);
		expect((disposeError as LazyServiceFailedError).cause).toBe(original);
		expect(service.status().state).toBe("disposed");
		expect(service.status().error).toBeInstanceOf(LazyServiceFailedError);

		const failed = createLazyService({
			id: "failed",
			initialize: async () => {
				throw original;
			},
		});
		let failedError: unknown;
		try {
			await failed.get("first");
		} catch (cause) {
			failedError = cause;
		}
		expect(failedError).toBeInstanceOf(LazyServiceFailedError);
		expect((failedError as LazyServiceFailedError).cause).toBe(original);
		await failed.prewarm("retry-is-not-a-retry");
		expect(failed.status().state).toBe("failed");
		expect(failed.status().error).toBeInstanceOf(LazyServiceFailedError);
		await failed.dispose();
	});

	test("re-entrant dispose rejects without deadlocking initialization", async () => {
		let service!: ReturnType<typeof createLazyService<string>>;
		let reentrantError: unknown;
		service = createLazyService({
			id: "reentrant-dispose",
			initialize: async () => {
				try {
					await service.dispose();
				} catch (cause) {
					reentrantError = cause;
					throw cause;
				}
				return { value: "never" };
			},
		});

		let result: unknown;
		try {
			await Promise.race([
				service.get("reentrant"),
				new Promise<never>((_, reject) => setTimeout(() => reject(new Error("timed out")), 250)),
			]);
		} catch (cause) {
			result = cause;
		}
		expect(reentrantError).toBeInstanceOf(LazyServiceReentrantDisposeError);
		expect(result).toBeInstanceOf(LazyServiceFailedError);
		expect((result as LazyServiceFailedError).cause).toBeInstanceOf(LazyServiceReentrantDisposeError);
		expect(service.status().state).toBe("failed");
		await service.dispose();
		expect(service.status().state).toBe("disposed");
	});

	test("concurrent dispose calls observe one teardown promise", async () => {
		const teardownGate = deferred<void>();
		let teardownCount = 0;
		const service = createLazyService({
			id: "dispose-once",
			initialize: async () => ({
				value: "ready",
				dispose: async () => {
					teardownCount += 1;
					await teardownGate.promise;
				},
			}),
		});

		await service.get("ready");
		const firstDispose = service.dispose();
		const secondDispose = service.dispose();
		await Promise.resolve();
		expect(secondDispose).toBe(firstDispose);
		expect(teardownCount).toBe(1);
		teardownGate.resolve(undefined);
		await Promise.all([firstDispose, secondDispose]);
		expect(service.status().state).toBe("disposed");
		expect(service.peek()).toBeUndefined();
	});

	test("dispose resolving cannot leave a late ready value or live resource", async () => {
		const gate = deferred<void>();
		let live = false;
		let teardownCount = 0;
		const service = createLazyService({
			id: "no-late-ready",
			initialize: async () => {
				await gate.promise;
				live = true;
				return {
					value: { live: true },
					dispose: () => {
						live = false;
						teardownCount += 1;
					},
				};
			},
		});

		const getPromise = service.get("late");
		await Promise.resolve();
		const disposePromise = service.dispose();
		gate.resolve(undefined);
		await expect(getPromise).rejects.toBeInstanceOf(LazyServiceDisposedError);
		await disposePromise;

		expect(live).toBe(false);
		expect(teardownCount).toBe(1);
		expect(service.peek()).toBeUndefined();
		expect(service.status().state).toBe("disposed");
	});

	test("N concurrent gets share one initializer, while disabled is typed and terminal", async () => {
		let initializeCount = 0;
		const service = createLazyService({
			id: "single-flight",
			initialize: async ({ trigger }) => {
				initializeCount += 1;
				return { value: { trigger } };
			},
		});

		const values = await Promise.all(Array.from({ length: 16 }, (_, index) => service.get(`trigger-${index}`)));
		expect(initializeCount).toBe(1);
		expect(values.every(value => value.trigger === "trigger-0")).toBe(true);
		expect(service.status().state).toBe("ready");
		expect(service.status().trigger).toBe("trigger-0");
		expect(service.status().initializedAt).toBeNumber();
		await service.dispose();

		const disabled = createLazyService({
			id: "config.lazy.disabled",
			enabled: () => false,
			initialize: async () => ({ value: "never" }),
		});
		await expect(disabled.get("disabled")).rejects.toBeInstanceOf(LazyServiceDisabledError);
		expect(disabled.status().state).toBe("disabled");
		await disabled.prewarm("still-disabled");
		await disabled.dispose();
		expect(disabled.status().state).toBe("disposed");
		await disabled.prewarm("after-dispose");
		expect(disabled.status().error).toBeInstanceOf(LazyServiceDisposedError);
		await expect(disabled.get("after-dispose")).rejects.toBeInstanceOf(LazyServiceDisposedError);
	});
});
