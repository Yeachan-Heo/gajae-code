import * as fs from "node:fs";
import { createRequire } from "node:module";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import * as util from "node:util";

import * as logger from "@gajae-code/utils/logger";

import { ToolError } from "../../../tools/tool-errors";
import { createHelpers, type HelperBundle } from "./helpers";
import { awaitMaybePromise, indirectEval } from "./indirect-eval";
import { JAVASCRIPT_PRELUDE_SOURCE } from "./prelude";
import { wrapCode } from "./rewrite-imports";
import type { JsDisplayOutput, JsStatusEvent } from "./types";

/**
 * Per-run callbacks. Returned by `getHooks()` on each helper/tool/display invocation so
 * the embedding worker can route emissions to the currently active run. Returning `null`
 * makes status/display/tool calls reject with an error — useful for guarding against
 * helpers being invoked outside a run window.
 */
export interface RuntimeHooks {
	onText(chunk: string): void;
	onDisplay(output: JsDisplayOutput): void;
	callTool(name: string, args: unknown): Promise<unknown>;
}

export interface RuntimeOptions {
	initialCwd: string;
	sessionId: string;
	/** Resolve hooks for the run currently in flight, or `null` if nothing is active. */
	getHooks(): RuntimeHooks | null;
	/**
	 * Extra globals installed alongside `__gjc_helpers__` / prelude. Use for stable, lifetime-
	 * of-the-worker bindings (e.g. browser's `page`, `browser`). Per-run scope should be set
	 * via `setRunScope()` instead.
	 */
	extraGlobals?: Record<string, unknown>;
}

// Strict base64: characters from the standard alphabet plus optional `=` padding, and a
// length that is a multiple of four. URL-safe base64 and embedded whitespace are not
// accepted — the Anthropic API only honors strict base64 in image sources.
const BASE64_STRICT_RE = /^[A-Za-z0-9+/]+={0,2}$/;
const DECIMAL_CSV_RE = /^\d{1,3}(?:,\d{1,3})*$/;

function isStrictBase64(s: string): boolean {
	if (s.length === 0 || s.length % 4 !== 0) return false;
	return BASE64_STRICT_RE.test(s);
}

/**
 * Normalize the `data` field of an `{ type: "image", data, mimeType }` display payload
 * into strict base64. Accepts:
 *   - already-valid base64 strings (passed through verbatim)
 *   - `Uint8Array` / `Buffer` / `ArrayBuffer` / typed array views
 *   - `{ type: "Buffer", data: number[] }` (the shape Node serializes Buffers to via
 *     `JSON.stringify`)
 *   - decimal-CSV byte strings (the output of `uint8array.toString("base64")`, which
 *     silently ignores the encoding argument and returns `Array.prototype.toString` —
 *     a footgun for callers expecting `Buffer.toString` semantics)
 * Returns `null` if no recovery is possible.
 */
function coerceImageBase64(data: unknown): string | null {
	if (typeof data === "string") {
		if (isStrictBase64(data)) return data;
		if (DECIMAL_CSV_RE.test(data)) {
			const parts = data.split(",");
			const bytes = new Uint8Array(parts.length);
			for (let i = 0; i < parts.length; i++) {
				const n = Number(parts[i]);
				if (!Number.isInteger(n) || n < 0 || n > 255) return null;
				bytes[i] = n;
			}
			return Buffer.from(bytes).toString("base64");
		}
		return null;
	}
	if (data instanceof Uint8Array) return Buffer.from(data).toString("base64");
	if (data instanceof ArrayBuffer) return Buffer.from(data).toString("base64");
	if (ArrayBuffer.isView(data)) {
		const view = data as ArrayBufferView;
		return Buffer.from(view.buffer, view.byteOffset, view.byteLength).toString("base64");
	}
	if (data && typeof data === "object") {
		const obj = data as { type?: unknown; data?: unknown };
		if (obj.type === "Buffer" && Array.isArray(obj.data)) {
			const arr = obj.data as unknown[];
			const bytes = new Uint8Array(arr.length);
			for (let i = 0; i < arr.length; i++) {
				const n = arr[i];
				if (typeof n !== "number" || !Number.isInteger(n) || n < 0 || n > 255) return null;
				bytes[i] = n;
			}
			return Buffer.from(bytes).toString("base64");
		}
	}
	return null;
}

function describeDataType(data: unknown): string {
	if (data === null) return "null";
	if (data instanceof Uint8Array) return "Uint8Array";
	if (data instanceof ArrayBuffer) return "ArrayBuffer";
	if (ArrayBuffer.isView(data)) return data.constructor.name;
	if (typeof data === "string") return `string(${data.length})`;
	return typeof data;
}

/**
 * Shared JS runtime for the eval worker and the browser tab worker. Owns the prelude,
 * helper bag, console bridge, and indirect-eval execution. Emits text/display/tool-call
 * back through `RuntimeHooks` that the embedder supplies — wire format is the embedder's
 * concern.
 */
export class JsRuntime {
	readonly helpers: HelperBundle;
	#cwd: string;
	readonly sessionId: string;
	#env: Map<string, string>;
	#getHooks: () => RuntimeHooks | null;
	#finalExpressionSet = false;
	#finalExpressionValue: unknown;

	constructor(opts: RuntimeOptions) {
		this.#cwd = opts.initialCwd;
		this.sessionId = opts.sessionId;
		this.#env = new Map();
		this.#getHooks = opts.getHooks;
		this.helpers = createHelpers({
			cwd: () => this.#cwd,
			env: this.#env,
			emitStatus: event => this.#getHooks()?.onDisplay({ type: "status", event }),
		});
		this.#install(opts.extraGlobals);
	}

	get cwd(): string {
		return this.#cwd;
	}

	setCwd(cwd: string): void {
		this.#cwd = cwd;
		const session = (globalThis as { __gjc_session__?: { cwd?: string } }).__gjc_session__;
		if (session) session.cwd = cwd;
	}

	/**
	 * Install per-run globals. Intended for run-scoped state (browser's `tab`, `display`
	 * overrides, etc.). Overwrites previous assignments — caller is responsible for any
	 * cleanup it wants.
	 */
	setRunScope(scope: Record<string, unknown>): void {
		Object.assign(globalThis, scope);
	}

	async run(code: string, filename?: string): Promise<unknown> {
		this.#finalExpressionSet = false;
		this.#finalExpressionValue = undefined;
		const wrapped = wrapCode(code);
		const value = indirectEval(wrapped.source, filename);
		if (wrapped.finalExpressionReturned) {
			const awaited = await awaitMaybePromise(value);
			if (this.#finalExpressionSet) {
				const finalValue = this.#finalExpressionValue;
				this.#finalExpressionSet = false;
				this.#finalExpressionValue = undefined;
				const resolved = await awaitMaybePromise(finalValue);
				return resolved;
			}
			return awaited;
		}
		return await awaitMaybePromise(value);
	}

	displayValue(value: unknown): void {
		if (value === undefined) return;
		const hooks = this.#getHooks();
		if (!hooks) return;
		if (value && typeof value === "object") {
			const record = value as Record<string, unknown>;
			if (record.type === "image" && typeof record.mimeType === "string") {
				const data = coerceImageBase64(record.data);
				if (data !== null) {
					hooks.onDisplay({ type: "image", data, mimeType: record.mimeType });
					return;
				}
				logger.warn("js displayValue: dropping image with unrecognized data shape", {
					mimeType: record.mimeType,
					dataType: describeDataType(record.data),
				});
				hooks.onText(
					`[display: image dropped — \`data\` must be a base64 string, Uint8Array/Buffer, or ArrayBuffer; got ${describeDataType(record.data)}]\n`,
				);
				return;
			}
			try {
				hooks.onDisplay({ type: "json", data: structuredClone(value) });
			} catch (err) {
				logger.debug("js displayValue: value is not structured-cloneable, falling back to text", {
					error: err instanceof Error ? err.message : String(err),
				});
				hooks.onText(`${Object.prototype.toString.call(value)}\n`);
			}
			return;
		}
		hooks.onText(`${String(value)}\n`);
	}

	#install(extraGlobals: Record<string, unknown> | undefined): void {
		const injected: Record<string, unknown> = {
			__gjc_session__: { cwd: this.#cwd, sessionId: this.sessionId },
			__gjc_helpers__: this.helpers,
			__gjc_call_tool__: async (name: string, args: unknown) => {
				const hooks = this.#getHooks();
				if (!hooks) throw new ToolError("Tool calls are only valid inside an active run");
				return await hooks.callTool(name, args);
			},
			__gjc_import__: async (source: string, options?: ImportCallOptions) => {
				const target = resolveImportSpecifier(this.#cwd, source);
				// Always invalidate cached module records for user-owned source files so edits
				// between cells are picked up. Bun ignores query-string busting on `file:` URLs
				// but honors `delete require.cache[absPath]`; bare specifiers and URL schemes are
				// left alone to keep package identity stable across cells.
				if (isLocalPathSpecifier(source) && path.isAbsolute(target)) {
					delete require.cache[target];
				}
				return options !== undefined ? await import(target, options) : await import(target);
			},
			__gjc_emit_status__: (op: string, data: Record<string, unknown> = {}) => {
				const event: JsStatusEvent = { op, ...data };
				this.#getHooks()?.onDisplay({ type: "status", event });
			},
			__gjc_log__: (level: string, ...args: unknown[]) => {
				const prefix = level === "error" ? "[error] " : level === "warn" ? "[warn] " : "";
				const text = `${prefix}${formatConsoleArgs(args)}`;
				this.#getHooks()?.onText(text.endsWith("\n") ? text : `${text}\n`);
			},
			__gjc_display__: (value: unknown) => this.displayValue(value),
			__gjc_set_final_expr__: (value: unknown) => {
				this.#finalExpressionSet = true;
				this.#finalExpressionValue = value;
			},
			webcrypto: crypto,
			// `process` is intentionally not overridden — user code gets the host worker's real
			// `process` object. Subsetting it caused segfaults in workers that share state with
			// puppeteer/worker_threads internals.
			require: buildRequire(this.#cwd),
			createRequire,
			fs,
		};
		Object.assign(globalThis, injected, extraGlobals ?? {});
		// Prelude assigns console bridge + short aliases (`read`, `write`, `tool`, `display`, ...)
		// onto globalThis. Must run after helpers are in place.
		indirectEval(JAVASCRIPT_PRELUDE_SOURCE);
	}
}

function formatConsoleArgs(args: unknown[]): string {
	return args
		.map(arg => (typeof arg === "string" ? arg : util.inspect(arg, { depth: 6, colors: false, breakLength: 120 })))
		.join(" ");
}

function buildRequire(cwd: string): NodeJS.Require {
	return createRequire(pathToFileURL(path.join(cwd, "[eval]")).href);
}

/**
 * Resolve an import specifier emitted by `rewriteImports` against the active session
 * cwd. Relative paths (`./`, `../`, `/`) and bare specifiers (`pkg`, `@scope/pkg`) both go
 * through `Bun.resolveSync` rooted at the cwd so user-pasted ESM behaves as if it lived in
 * the project — not next to the worker module. URL-like specifiers (`file://`, `data:`,
 * `node:`, `http:`) are passed through unchanged.
 */
function resolveImportSpecifier(cwd: string, source: string): string {
	if (/^[a-z][a-z0-9+.-]*:/i.test(source)) return source;
	try {
		return Bun.resolveSync(source, cwd);
	} catch {
		return source;
	}
}

/**
 * Returns true when the original specifier is a relative or absolute filesystem path
 * (i.e. user-owned source the agent is iterating on). Bare specifiers and URL schemes
 * are excluded — `node:` built-ins cannot be reloaded, and busting bare packages would
 * defeat module identity for every cell while bringing no editing benefit.
 */
function isLocalPathSpecifier(source: string): boolean {
	return (
		source.startsWith("./") ||
		source.startsWith("../") ||
		source === "." ||
		source === ".." ||
		source.startsWith("/") ||
		source.startsWith("~/") ||
		/^[a-zA-Z]:[\\/]/.test(source)
	);
}
