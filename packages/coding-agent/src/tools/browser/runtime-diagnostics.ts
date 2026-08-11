import { createHash } from "node:crypto";
import type { CDPSession, Page } from "puppeteer-core";

const MAX_RUNTIME_DIAGNOSTICS = 20;

/** Hard cap on the `url` field (chars). Truncation is visible: the value ends in `…`. */
const MAX_RUNTIME_DIAGNOSTIC_URL_CHARS = 256;

/** Hard cap on the serialized diagnostics block (UTF-8 bytes) emitted into tool results. */
const MAX_RUNTIME_DIAGNOSTICS_BLOCK_BYTES = 4 * 1024;

/**
 * Fixed allowlist of built-in error class names. Page-controlled class names (anything
 * defined by page scripts, e.g. `CustomerAlice123`) are never echoed: a diagnostic's
 * `class` field is emitted only when it matches one of these fixed names.
 */
const ERROR_CLASS_ALLOWLIST = new Set([
	"Error",
	"EvalError",
	"RangeError",
	"ReferenceError",
	"SyntaxError",
	"TypeError",
	"URIError",
	"AggregateError",
	"InternalError",
	"DOMException",
	"AbortError",
	"CompileError",
	"DataError",
	"EncodingError",
	"HierarchyRequestError",
	"IndexSizeError",
	"InvalidAccessError",
	"InvalidCharacterError",
	"InvalidModificationError",
	"InvalidNodeTypeError",
	"InvalidStateError",
	"LinkError",
	"NamespaceError",
	"NetworkError",
	"NoModificationAllowedError",
	"NotFoundError",
	"NotReadableError",
	"NotSupportedError",
	"OperationError",
	"QuotaExceededError",
	"ReadOnlyError",
	"RuntimeError",
	"SecurityError",
	"TimeoutError",
	"TransactionInactiveError",
	"VersionError",
	"WrongDocumentError",
]);

/**
 * Fixed, page-uncontrollable script-URL literals that V8 reports in stack frames and
 * exception details. These are safe to surface verbatim; anything else that is not a
 * parseable URL is emitted as an irreversible hash so a raw path/token cannot leak.
 */
const SAFE_NON_URL_LITERALS = new Set([
	"",
	"eval",
	"anonymous",
	"script",
	"[native code]",
	"__puppeteer_evaluation_script__",
]);

/** `about:` paths are page-navigable, so keep only browser-fixed safe names. */
const SAFE_ABOUT_PATH = /^[A-Za-z0-9._-]{1,32}$/;

export interface BrowserRuntimeDiagnostic {
	kind: "pageerror" | "console-error";
	at: string;
	url: string;
	line?: number;
	column?: number;
	class?: string;
}

interface ExceptionThrownEvent {
	exceptionDetails?: {
		url?: string;
		lineNumber?: number;
		columnNumber?: number;
		exception?: { className?: string };
	};
}

interface ConsoleCalledEvent {
	type?: string;
	stackTrace?: { callFrames?: Array<{ url?: string; lineNumber?: number; columnNumber?: number }> };
}

function sha256Hex(value: string): string {
	return createHash("sha256").update(value).digest("hex");
}

/**
 * Reduce a runtime-event URL to a persisted-safe location.
 *
 * http(s) URLs are emitted origin-only: path segments routinely carry tokens (signed
 * URLs, invite/reset links, per-tenant identifiers), and diagnostics end up in tool
 * results that are persisted and shareable. Non-parseable values are never echoed
 * verbatim — known engine literals pass through, everything else becomes an
 * irreversible bounded hash so entries stay correlatable without leaking.
 */
export function maskBrowserRuntimeUrl(value: string): string {
	let url: URL | undefined;
	try {
		url = new URL(value);
	} catch {
		url = undefined;
	}
	if (url) {
		if (url.protocol === "http:" || url.protocol === "https:") {
			return boundUrlField(url.origin);
		}
		if (url.protocol === "about:") {
			const path = url.pathname && SAFE_ABOUT_PATH.test(url.pathname) ? `about:${url.pathname}` : "about:…";
			return boundUrlField(path);
		}
		return boundUrlField(`${url.protocol}…`);
	}
	if (SAFE_NON_URL_LITERALS.has(value)) return value;
	return `[non-url:${sha256Hex(value).slice(0, 8)}]`;
}

function finite(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

export function pageErrorDiagnostic(event: ExceptionThrownEvent, fallbackUrl: string): BrowserRuntimeDiagnostic {
	const details = event.exceptionDetails;
	const className = details?.exception?.className;
	return {
		kind: "pageerror",
		at: new Date().toISOString(),
		url: maskBrowserRuntimeUrl(details?.url || fallbackUrl),
		...(finite(details?.lineNumber) === undefined ? {} : { line: details?.lineNumber }),
		...(finite(details?.columnNumber) === undefined ? {} : { column: details?.columnNumber }),
		...(typeof className === "string" && ERROR_CLASS_ALLOWLIST.has(className) ? { class: className } : {}),
	};
}

export function consoleErrorDiagnostic(
	event: ConsoleCalledEvent,
	fallbackUrl: string,
): BrowserRuntimeDiagnostic | undefined {
	if (event.type !== "error") return undefined;
	const frame = event.stackTrace?.callFrames?.[0];
	return {
		kind: "console-error",
		at: new Date().toISOString(),
		url: maskBrowserRuntimeUrl(frame?.url || fallbackUrl),
		...(finite(frame?.lineNumber) === undefined ? {} : { line: frame?.lineNumber }),
		...(finite(frame?.columnNumber) === undefined ? {} : { column: frame?.columnNumber }),
	};
}

function boundUrlField(url: string): string {
	if (url.length <= MAX_RUNTIME_DIAGNOSTIC_URL_CHARS) return url;
	return `${url.slice(0, MAX_RUNTIME_DIAGNOSTIC_URL_CHARS - 1)}…`;
}

/**
 * Serialize a drained mailbox into the tool-result text block.
 *
 * - Per-field: `url` is capped with a visible `…` marker; every other field is
 *   structurally bounded (ISO timestamp, finite integers, allowlisted class).
 * - Total: the serialized block is capped at `MAX_RUNTIME_DIAGNOSTICS_BLOCK_BYTES`.
 *   When the budget is tight the oldest entries are shed (newest survive) and the
 *   block carries an explicit `runtimeDiagnosticsTruncated: true` — truncation is
 *   never silent.
 */
export function serializeRuntimeDiagnostics(drained: {
	runtimeDiagnostics: BrowserRuntimeDiagnostic[];
	runtimeDiagnosticsDropped: number;
}): string {
	const { runtimeDiagnostics, runtimeDiagnosticsDropped } = drained;
	const bounded = runtimeDiagnostics.map(entry => ({ ...entry, url: boundUrlField(entry.url) }));
	const encoder = new TextEncoder();
	const render = (entries: BrowserRuntimeDiagnostic[], truncated: boolean): string =>
		JSON.stringify(
			{
				runtimeDiagnostics: entries,
				runtimeDiagnosticsDropped,
				...(truncated ? { runtimeDiagnosticsTruncated: true } : {}),
			},
			null,
			2,
		);
	let kept = bounded;
	let text = render(kept, false);
	while (encoder.encode(text).byteLength > MAX_RUNTIME_DIAGNOSTICS_BLOCK_BYTES && kept.length > 1) {
		kept = kept.slice(1);
		text = render(kept, true);
	}
	// A single entry can exceed the budget only on type-violating input (every field is
	// structurally bounded); the block still surfaces the entry, but truncation is
	// never silent — flag the over-budget block explicitly.
	if (encoder.encode(text).byteLength > MAX_RUNTIME_DIAGNOSTICS_BLOCK_BYTES) {
		text = render(kept, true);
	}
	return text;
}

export class BrowserRuntimeDiagnosticsMailbox {
	#entries: BrowserRuntimeDiagnostic[] = [];
	#dropped = 0;

	push(entry: BrowserRuntimeDiagnostic): void {
		if (this.#entries.length === MAX_RUNTIME_DIAGNOSTICS) {
			this.#entries.shift();
			this.#dropped += 1;
		}
		this.#entries.push(entry);
	}

	drain(): { runtimeDiagnostics: BrowserRuntimeDiagnostic[]; runtimeDiagnosticsDropped: number } {
		const runtimeDiagnostics = this.#entries.splice(0);
		const runtimeDiagnosticsDropped = this.#dropped;
		this.#dropped = 0;
		return { runtimeDiagnostics, runtimeDiagnosticsDropped };
	}
}

export async function instrumentBrowserRuntimeDiagnostics(
	page: Page,
	mailbox: BrowserRuntimeDiagnosticsMailbox,
): Promise<CDPSession> {
	const session = await page.target().createCDPSession();
	session.on("Runtime.exceptionThrown", event => {
		mailbox.push(pageErrorDiagnostic(event, page.url()));
	});
	session.on("Runtime.consoleAPICalled", event => {
		const diagnostic = consoleErrorDiagnostic(event, page.url());
		if (diagnostic) mailbox.push(diagnostic);
	});
	try {
		await session.send("Runtime.enable");
		return session;
	} catch (error) {
		await session.detach().catch(() => undefined);
		throw error;
	}
}
