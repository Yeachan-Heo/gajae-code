/**
 * QuickJS (wasm) sandbox for JS eval cells (`eval.jsRuntime = "quickjs"`).
 *
 * User code runs inside a QuickJS context that has no host bindings except the bridge
 * object handed to the prelude: `tool.<name>(args)` (forwarded to the host's
 * `callSessionTool` path through `RuntimeHooks.callTool`), console/display output, the pure
 * text helpers, and a deadline-bounded `sleep`. There is no module loader, so `import()`
 * rejects; there is no `fetch`, `require`, `process`, `Bun`, filesystem, or environment.
 *
 * Values cross the boundary only as JSON strings (parsed on the other side by intrinsics
 * captured before user code runs), so no host object or host function is ever reachable from
 * the guest. Async host work settles QuickJS deferred promises; the cell is driven by
 * pumping pending jobs until its completion promise settles.
 *
 * Limits: `setMemoryLimit` bounds the guest heap and an interrupt handler stops execution at
 * the cell's wall-clock deadline. Both surface as cell errors; the context survives.
 */
import RELEASE_SYNC from "@jitl/quickjs-wasmfile-release-sync";
import quickjsWasmPath from "@jitl/quickjs-wasmfile-release-sync/wasm" with { type: "file" };
import {
	newQuickJSWASMModuleFromVariant,
	newVariant,
	type QuickJSContext,
	type QuickJSDeferredPromise,
	type QuickJSHandle,
	type QuickJSRuntime,
	type QuickJSWASMModule,
	type VmCallResult,
} from "quickjs-emscripten-core";
import { ToolError } from "../../../tools/tool-errors";
import { createHelpers, type HelperBundle } from "../shared/helpers";
import { wrapCode } from "../shared/rewrite-imports";
import { emitDisplayValue, type RuntimeHooks } from "../shared/runtime";
import QUICKJS_PRELUDE_SOURCE from "./prelude.txt" with { type: "text" };

/** Guest heap cap. Allocation past it throws an `out of memory` InternalError in the guest. */
export const QUICKJS_MEMORY_LIMIT_BYTES = 256 * 1024 * 1024;
/**
 * Guest stack cap. QuickJS raises a catchable `stack overflow` before the wasm frames exhaust
 * the host thread's stack (1 MiB already overflows a Bun worker thread first).
 */
const QUICKJS_MAX_STACK_BYTES = 512 * 1024;

/** Pure helpers the guest may run on the host; they take and return plain data only. */
const PURE_HELPERS = new Set(["sortText", "uniqText", "counter"] as const);
type PureHelperName = "sortText" | "uniqText" | "counter";

/** Raised when a cell exceeds its wall-clock deadline. Mapped to a timed-out (cancelled) cell. */
export class QuickJsTimeoutError extends Error {
	constructor(message = "JS cell exceeded its wall-time limit") {
		super(message);
		this.name = "TimeoutError";
	}
}

/** An exception thrown by guest code, converted to a host error. */
class QuickJsGuestError extends Error {}

let modulePromise: Promise<QuickJSWASMModule> | undefined;

function loadQuickJsModule(): Promise<QuickJSWASMModule> {
	modulePromise ??= newQuickJSWASMModuleFromVariant(
		newVariant(RELEASE_SYNC, { wasmBinary: async () => await Bun.file(quickjsWasmPath).arrayBuffer() }),
	).catch((error: unknown) => {
		modulePromise = undefined;
		throw error;
	});
	return modulePromise;
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function toJsonText(value: unknown): string {
	const json = JSON.stringify(value, (_key, item: unknown) => (typeof item === "bigint" ? `${item}` : item));
	return json ?? "null";
}

function isInterruptedError(value: unknown): boolean {
	if (!value || typeof value !== "object") return false;
	const record = value as { name?: unknown; message?: unknown };
	return record.name === "InternalError" && record.message === "interrupted";
}

export interface QuickJsCellRuntimeOptions {
	getHooks(): RuntimeHooks | null;
	memoryLimitBytes?: number;
}

export class QuickJsCellRuntime {
	readonly kind = "quickjs";
	#runtime: QuickJSRuntime;
	#context: QuickJSContext;
	#present: QuickJSHandle;
	#parse: QuickJSHandle;
	#getHooks: () => RuntimeHooks | null;
	#helpers: HelperBundle;
	#deadline = Number.POSITIVE_INFINITY;
	#pending = new Set<QuickJSDeferredPromise>();
	#wake: PromiseWithResolvers<void> | undefined;
	#final: QuickJSHandle | undefined;
	/** Identifies the running cell's final-expression report; earlier cells' continuations are ignored. */
	#cellToken = 0;
	/** Cell result handles held across awaits; freed by dispose() if a run is still waiting. */
	#inflight = new Set<QuickJSHandle>();
	#alive = true;

	static async create(options: QuickJsCellRuntimeOptions): Promise<QuickJsCellRuntime> {
		return new QuickJsCellRuntime(await loadQuickJsModule(), options);
	}

	constructor(module: QuickJSWASMModule, options: QuickJsCellRuntimeOptions) {
		this.#getHooks = options.getHooks;
		this.#helpers = createHelpers({
			cwd: () => "/",
			env: new Map(),
			emitStatus: event => this.#getHooks()?.onDisplay({ type: "status", event }),
		});
		this.#runtime = module.newRuntime();
		this.#runtime.setMemoryLimit(options.memoryLimitBytes ?? QUICKJS_MEMORY_LIMIT_BYTES);
		this.#runtime.setMaxStackSize(QUICKJS_MAX_STACK_BYTES);
		this.#runtime.setInterruptHandler(() => Date.now() > this.#deadline);
		this.#context = this.#runtime.newContext();
		const exports = this.#bootstrap();
		try {
			this.#present = this.#context.getProp(exports, "present");
			this.#parse = this.#context.getProp(exports, "parse");
		} finally {
			exports.dispose();
		}
	}

	get alive(): boolean {
		return this.#alive;
	}

	/** The sandbox has no filesystem; tools resolve paths against the host session cwd. */
	setCwd(_cwd: string): void {}

	async runCell(code: string, filename: string, deadlineMs: number | undefined): Promise<void> {
		if (!this.#alive) throw new ToolError("QuickJS runtime is disposed");
		this.#deadline = deadlineMs ?? Number.POSITIVE_INFINITY;
		this.#clearFinal();
		const cellToken = ++this.#cellToken;
		try {
			const wrapped = wrapCode(code, { finalExpressionToken: cellToken });
			const evaluated = this.#context.evalCode(wrapped.source, filename, { type: "global" });
			if (evaluated.error) throw this.#takeGuestError(evaluated.error);
			let value = await this.#settle(evaluated.value);
			const final = this.#final;
			if (wrapped.finalExpressionReturned && final) {
				this.#final = undefined;
				value.dispose();
				value = await this.#settle(final);
			}
			try {
				this.#call(this.#present, value);
			} finally {
				value.dispose();
			}
		} catch (error) {
			if (error instanceof QuickJsGuestError || error instanceof QuickJsTimeoutError || error instanceof ToolError) {
				throw error;
			}
			// A host-level failure (wasm abort, host stack exhaustion) leaves the module state
			// unknown. Drop it; the next cell starts a fresh sandbox.
			this.#crash();
			throw new ToolError(
				`QuickJS runtime failed: ${errorMessage(error)}. The JS context was discarded; the next cell starts a fresh sandbox.`,
			);
		} finally {
			if (this.#alive) {
				this.#rejectPending();
				this.#clearFinal();
			}
			this.#deadline = Number.POSITIVE_INFINITY;
		}
	}

	/**
	 * Free every host-held handle, then the context and runtime. QuickJS aborts the wasm module
	 * when a runtime is freed with live objects, so a failure here drops the shared module and
	 * rethrows: the next runtime loads a fresh one.
	 */
	dispose(): void {
		if (!this.#alive) return;
		this.#alive = false;
		this.#wake?.resolve();
		try {
			for (const handle of this.#inflight) if (handle.alive) handle.dispose();
			this.#inflight.clear();
			for (const deferred of this.#pending) deferred.dispose();
			this.#pending.clear();
			this.#clearFinal();
			this.#present.dispose();
			this.#parse.dispose();
			this.#context.dispose();
			this.#runtime.dispose();
		} catch (error) {
			modulePromise = undefined;
			throw new ToolError(`QuickJS runtime disposal failed: ${errorMessage(error)}`);
		}
	}

	#bootstrap(): QuickJSHandle {
		const context = this.#context;
		const host = context.newObject();
		try {
			this.#defineHostFunction(host, "callTool", (nameHandle, argsHandle) => {
				const hooks = this.#requireHooks();
				const name = this.#requireString(nameHandle, "tool name");
				const args: unknown = JSON.parse(this.#requireString(argsHandle, "tool arguments"));
				return this.#hostPromise(hooks.callTool(name, args), value => this.#toGuest(value));
			});
			this.#defineHostFunction(host, "text", textHandle => {
				this.#requireHooks().onText(this.#requireString(textHandle, "text"));
			});
			this.#defineHostFunction(host, "display", jsonHandle => {
				const value: unknown = JSON.parse(this.#requireString(jsonHandle, "display value"));
				emitDisplayValue(value, this.#requireHooks());
			});
			this.#defineHostFunction(host, "pure", (nameHandle, argsHandle) => {
				const name = this.#requireString(nameHandle, "helper name");
				if (!PURE_HELPERS.has(name as PureHelperName)) throw new ToolError(`Unknown helper: ${name}`);
				const args: unknown = JSON.parse(this.#requireString(argsHandle, "helper arguments"));
				if (!Array.isArray(args)) throw new ToolError("helper arguments must be an array");
				const helper = this.#helpers[name as PureHelperName] as (...helperArgs: unknown[]) => unknown;
				return this.#toGuest(helper(...args));
			});
			this.#defineHostFunction(host, "sleep", msHandle => {
				this.#requireHooks();
				const requested = context.typeof(msHandle) === "number" ? context.getNumber(msHandle) : 0;
				// A sleep that ends past the deadline can only end in the timeout, so it never wakes
				// the cell; the wait loop raises the timeout and the run end rejects it.
				const wait =
					requested > this.#deadline - Date.now()
						? Promise.withResolvers<void>().promise
						: Bun.sleep(Math.max(0, requested));
				return this.#hostPromise(wait, () => undefined);
			});
			this.#defineHostFunction(host, "setFinal", (valueHandle, tokenHandle) => {
				const token = tokenHandle && context.typeof(tokenHandle) === "number" ? context.getNumber(tokenHandle) : -1;
				if (token !== this.#cellToken) return;
				this.#clearFinal();
				this.#final = valueHandle.dup();
			});
			const prelude = context.evalCode(QUICKJS_PRELUDE_SOURCE, "gjc-quickjs-prelude.js", { type: "global" });
			const factory = context.unwrapResult(prelude);
			try {
				return context.unwrapResult(context.callFunction(factory, context.undefined, host));
			} finally {
				factory.dispose();
			}
		} finally {
			host.dispose();
		}
	}

	#defineHostFunction(
		target: QuickJSHandle,
		name: string,
		impl: (...args: QuickJSHandle[]) => QuickJSHandle | undefined,
	): void {
		const fn = this.#context.newFunction(name, (...args): QuickJSHandle | VmCallResult<QuickJSHandle> | undefined => {
			try {
				return impl(...args);
			} catch (error) {
				// Only name + message cross over: host stack traces stay on the host.
				return { error: this.#newGuestError(error) };
			}
		});
		try {
			this.#context.setProp(target, name, fn);
		} finally {
			fn.dispose();
		}
	}

	#requireHooks(): RuntimeHooks {
		const hooks = this.#getHooks();
		if (!hooks) throw new ToolError("Host calls are only valid inside an active run");
		return hooks;
	}

	#requireString(handle: QuickJSHandle | undefined, what: string): string {
		if (!handle || this.#context.typeof(handle) !== "string") throw new TypeError(`${what} must be a string`);
		return this.#context.getString(handle);
	}

	#newGuestError(error: unknown): QuickJSHandle {
		const name = error instanceof Error ? error.name : "Error";
		return this.#context.newError({ name, message: errorMessage(error) });
	}

	/** Build a guest value from host data via the captured guest `JSON.parse` (own properties only). */
	#toGuest(value: unknown): QuickJSHandle {
		if (value === undefined) return this.#context.undefined;
		const text = this.#context.newString(toJsonText(value));
		try {
			const parsed = this.#context.callFunction(this.#parse, this.#context.undefined, text);
			if (parsed.error) throw this.#takeGuestError(parsed.error);
			return parsed.value;
		} finally {
			text.dispose();
		}
	}

	/** Return a guest promise settled by `work`. Guest code observes it only via the handle. */
	#hostPromise<T>(work: Promise<T>, toHandle: (value: T) => QuickJSHandle | undefined): QuickJSHandle {
		const deferred = this.#context.newPromise();
		this.#pending.add(deferred);
		work.then(
			value => this.#settleDeferred(deferred, () => toHandle(value), true),
			(error: unknown) => this.#settleDeferred(deferred, () => this.#newGuestError(error), false),
		);
		return deferred.handle;
	}

	#settleDeferred(deferred: QuickJSDeferredPromise, make: () => QuickJSHandle | undefined, ok: boolean): void {
		// A run that already ended rejected this deferred; late host results are dropped.
		if (!this.#alive || !this.#pending.delete(deferred)) return;
		let handle: QuickJSHandle | undefined;
		let fulfilled = ok;
		try {
			handle = make();
		} catch (error) {
			handle = this.#newGuestError(error);
			fulfilled = false;
		}
		try {
			if (fulfilled) deferred.resolve(handle);
			else deferred.reject(handle);
		} finally {
			if (handle?.alive) handle.dispose();
			deferred.dispose();
			this.#notify();
		}
	}

	#rejectPending(): void {
		for (const deferred of [...this.#pending]) {
			this.#pending.delete(deferred);
			const error = this.#newGuestError(new ToolError("JS run ended"));
			try {
				deferred.reject(error);
			} finally {
				error.dispose();
				deferred.dispose();
			}
		}
	}

	#notify(): void {
		const wake = this.#wake;
		this.#wake = undefined;
		wake?.resolve();
	}

	#clearFinal(): void {
		const final = this.#final;
		this.#final = undefined;
		if (final?.alive) final.dispose();
	}

	#call(fn: QuickJSHandle, arg: QuickJSHandle): void {
		const result = this.#context.callFunction(fn, this.#context.undefined, arg);
		if (result.error) throw this.#takeGuestError(result.error);
		result.value.dispose();
	}

	#drainJobs(): void {
		const result = this.#runtime.executePendingJobs(-1);
		if (result.error) throw this.#takeGuestError(result.error);
	}

	/** Drive pending jobs until `handle` settles; takes ownership of `handle`. */
	async #settle(handle: QuickJSHandle): Promise<QuickJSHandle> {
		this.#inflight.add(handle);
		try {
			for (;;) {
				this.#drainJobs();
				const state = this.#context.getPromiseState(handle);
				if (state.type === "fulfilled") {
					if (state.notAPromise) return handle;
					handle.dispose();
					return state.value;
				}
				if (state.type === "rejected") throw this.#takeGuestError(state.error);
				if (this.#pending.size === 0) {
					throw new ToolError(
						"JS cell is awaiting a promise that can never settle: no tool call or sleep() is in flight.",
					);
				}
				await this.#waitForHost();
			}
		} catch (error) {
			// After dispose() the context is gone and dispose() already freed this handle.
			if (this.#alive && handle.alive) handle.dispose();
			throw error;
		} finally {
			this.#inflight.delete(handle);
		}
	}

	async #waitForHost(): Promise<void> {
		const remaining = this.#deadline - Date.now();
		if (remaining < 0) throw new QuickJsTimeoutError();
		const wake = Promise.withResolvers<void>();
		this.#wake = wake;
		const timer = Number.isFinite(remaining) ? setTimeout(() => wake.resolve(), remaining + 1) : undefined;
		try {
			await wake.promise;
		} finally {
			clearTimeout(timer);
			if (this.#wake === wake) this.#wake = undefined;
		}
		if (!this.#alive) throw new ToolError("QuickJS runtime is disposed");
		if (Date.now() > this.#deadline) throw new QuickJsTimeoutError();
	}

	/** Convert a guest exception handle into a host error; disposes the handle. */
	#takeGuestError(handle: QuickJSHandle): Error {
		let dumped: unknown;
		try {
			dumped = this.#context.dump(handle);
		} catch (error) {
			dumped = errorMessage(error);
		} finally {
			if (handle.alive) handle.dispose();
		}
		if (isInterruptedError(dumped) && Date.now() > this.#deadline) return new QuickJsTimeoutError();
		if (dumped && typeof dumped === "object" && "message" in dumped) {
			const record = dumped as { name?: unknown; message?: unknown; stack?: unknown };
			const error = new QuickJsGuestError(String(record.message));
			error.name = typeof record.name === "string" ? record.name : "Error";
			const frames = typeof record.stack === "string" ? record.stack.trimEnd() : "";
			error.stack = frames ? `${error.name}: ${error.message}\n${frames}` : `${error.name}: ${error.message}`;
			return error;
		}
		const error = new QuickJsGuestError(typeof dumped === "string" ? dumped : toJsonText(dumped));
		error.name = "Error";
		error.stack = `Uncaught ${error.message}`;
		return error;
	}

	#crash(): void {
		this.#alive = false;
		this.#pending.clear();
		this.#final = undefined;
		modulePromise = undefined;
	}
}
