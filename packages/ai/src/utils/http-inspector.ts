import * as fs from "node:fs/promises";
import * as path from "node:path";
import { APP_NAME, extractHttpStatusFromError, getLogsDir } from "@gajae-code/utils";
import { isCopilotTransientModelError } from "./retry.js";
import { formatErrorMessageWithRetryAfter } from "./retry-after.js";

export type RawHttpRequestDump = {
	provider: string;
	api: string;
	model: string;
	method?: string;
	url?: string;
	headers?: Record<string, string>;
	body?: unknown;
};

export type CapturedHttpErrorResponse = {
	status: number;
	headers?: Headers;
	bodyText?: string;
	bodyJson?: unknown;
};

type ErrorWithStatus = {
	status?: unknown;
};

const SENSITIVE_HEADERS = ["authorization", "x-api-key", "api-key", "cookie", "set-cookie", "proxy-authorization"];

/**
 * Connection-level failure codes, meaning the request never reached the
 * provider and no HTTP status exists. Bun reports the first group for `fetch`;
 * the `E*`/`UND_ERR_*` group comes from Node-style DNS and socket errors.
 *
 * Deliberately excludes aborts and TLS/certificate codes: an abort is a
 * user/watchdog outcome with its own display path, and its message must keep
 * matching the abort normalizers in `modes/utils/abort-message`.
 */
const TRANSPORT_FAILURE_CODES: ReadonlySet<string> = new Set([
	"ConnectionClosed",
	"ConnectionRefused",
	"ConnectionReset",
	"ConnectionTimeout",
	"FailedToOpenSocket",
	"HTTP2Unsupported",
	"EAI_AGAIN",
	"ECONNREFUSED",
	"ECONNRESET",
	"EHOSTUNREACH",
	"ENETUNREACH",
	"ENOTFOUND",
	"EPIPE",
	"ETIMEDOUT",
	"UND_ERR_CONNECT_TIMEOUT",
	"UND_ERR_SOCKET",
]);

/**
 * Privacy note appended next to a saved raw HTTP request dump. The dump is
 * sanitized (secrets/thinking redacted) but can still contain prompt content
 * and request metadata, so we explicitly discourage pasting it into public
 * channels (issue #438).
 */
const RAW_HTTP_REQUEST_PRIVACY_NOTE =
	"note: this local file is for your own debugging and may contain prompt content or request metadata — review it before sharing and do not paste its contents into public channels (issues, Discord, etc.).";

/**
 * Patterns that indicate the configured model is unavailable on the provider
 * (e.g. OpenAI's "The requested model '...' does not exist."). Used to surface
 * actionable model/provider guidance instead of only a raw 400 + log path.
 */
const MODEL_UNAVAILABLE_PATTERNS: readonly RegExp[] = [
	/\bmodel\b[^\n]*\bdoes not exist\b/i,
	/\bdoes not exist\b[^\n]*\bmodel\b/i,
	/\bmodel\b[^\n]*\b(not found|unavailable|not supported|no access|does not have access)\b/i,
	/\b(unknown|unsupported|invalid)\s+model\b/i,
];

/** Whether `message` (from a 400 response) signals an unavailable/unknown model. */
export function isModelUnavailableError(message: string, error: unknown): boolean {
	if (extractHttpStatusFromError(error) !== 400) return false;
	return MODEL_UNAVAILABLE_PATTERNS.some(pattern => pattern.test(message));
}

/** Actionable guidance for selecting an available model/provider. */
export function formatModelUnavailableGuidance(dump: RawHttpRequestDump | undefined): string {
	const modelPart = dump?.model ? ` '${dump.model}'` : "";
	const providerPart = dump?.provider ? ` on provider '${dump.provider}'` : "";
	return [
		`The configured model${modelPart}${providerPart} is not available on this account/provider.`,
		"Pick an available model before retrying:",
		`  • List available models:  ${APP_NAME} --list-models`,
		`  • Run with a model:        ${APP_NAME} --model <model>`,
		`  • Configure a provider:    ${APP_NAME} setup provider`,
	].join("\n");
}

/**
 * Cap on retained HTTP 400 request dumps.
 *
 * Each dump carries the full sanitized request body, so they are large: a
 * developer machine accumulated 27,249 files totalling 7.0 GB, averaging 264 KB
 * each, because nothing ever removed them. The rotating application log already
 * bounds itself (`maxSize: 10m`, `maxFiles: 5`); these diagnostics get the same
 * treatment so the newest failures stay available without unbounded growth.
 */
const MAX_RETAINED_DUMPS = 50;

/** Directory holding the retained HTTP 400 dumps. */
export function httpRequestDumpDir(): string {
	return path.join(getLogsDir(), "http-400-requests");
}

/**
 * Drop the oldest dumps beyond the cap. Best-effort: diagnostics must never turn
 * a request failure into a second failure, so every step swallows its error.
 *
 * File names are `${Date.now()}-${hash}.json`, so a lexical sort is chronological
 * for the millisecond timestamps this writer produces.
 */
export async function pruneHttpRequestDumps(dir: string = httpRequestDumpDir()): Promise<number> {
	const entries = await fs.readdir(dir).catch(() => undefined);
	if (!entries) return 0;

	const dumps = entries.filter(name => name.endsWith(".json")).sort();
	if (dumps.length <= MAX_RETAINED_DUMPS) return 0;

	let removed = 0;
	for (const name of dumps.slice(0, dumps.length - MAX_RETAINED_DUMPS)) {
		if (
			await fs.rm(path.join(dir, name), { force: true }).then(
				() => true,
				() => false,
			)
		)
			removed++;
	}
	return removed;
}

export async function appendRawHttpRequestDumpFor400(
	message: string,
	error: unknown,
	dump: RawHttpRequestDump | undefined,
): Promise<string> {
	if (!dump || extractHttpStatusFromError(error) !== 400) {
		return message;
	}

	const sanitizedDump = sanitizeDump(dump);
	const fileName = `${Date.now()}-${Bun.hash(JSON.stringify(sanitizedDump)).toString(36)}.json`;
	const dumpDir = httpRequestDumpDir();
	const filePath = path.join(dumpDir, fileName);

	try {
		await Bun.write(filePath, `${JSON.stringify(sanitizedDump, null, 2)}\n`);
		await pruneHttpRequestDumps(dumpDir);
		return `${message}\nraw-http-request=${filePath}\n${RAW_HTTP_REQUEST_PRIVACY_NOTE}`;
	} catch (writeError) {
		const writeMessage = writeError instanceof Error ? writeError.message : String(writeError);
		return `${message}\nraw-http-request-save-failed=${writeMessage}`;
	}
}

/** Origin and path of `value`, dropping query, fragment, and credentials so a
 *  key carried in the request URL (Google `?key=`, signed URLs) never lands in
 *  a user-visible error string. */
function redactRequestUrl(value: unknown): string | undefined {
	if (typeof value !== "string" || value.trim().length === 0) return undefined;
	try {
		const url = new URL(value);
		return `${url.origin}${url.pathname}`;
	} catch {
		return undefined;
	}
}

function findTransportFailure(error: unknown, depth: number): { code: string; url?: string } | undefined {
	if (!error || typeof error !== "object" || depth > 2) return undefined;
	const info = error as { code?: unknown; path?: unknown; url?: unknown; cause?: unknown };
	if (typeof info.code === "string" && TRANSPORT_FAILURE_CODES.has(info.code)) {
		return { code: info.code, url: redactRequestUrl(info.path) ?? redactRequestUrl(info.url) };
	}
	return findTransportFailure(info.cause, depth + 1);
}

/**
 * Name the failed connection when the request never produced an HTTP status.
 *
 * Bun raises DNS and socket failures as a bare `Error` whose message is a
 * standalone hint ("Was there a typo in the url or port?", "Unable to connect.
 * Is the computer able to access the url?") while the actionable facts live on
 * `code` and `path`. Those properties are dropped when only `message` reaches
 * the assistant message, so a provider outage, a local DNS failure, and a
 * mistyped custom base URL all render as the same context-free sentence.
 * Appending the code and the target URL tells the user which host failed and
 * whether the fault is theirs.
 */
export function appendTransportFailureContext(
	message: string,
	error: unknown,
	rawRequestDump: RawHttpRequestDump | undefined,
): string {
	if (extractHttpStatusFromError(error) !== undefined) return message;
	const failure = findTransportFailure(error, 0);
	if (!failure) return message;

	const url = failure.url ?? redactRequestUrl(rawRequestDump?.url);
	const context = url ? `transport=${failure.code} url=${url}` : `transport=${failure.code}`;
	return message.includes(context) ? message : `${message} (${context})`;
}

export async function finalizeErrorMessage(
	error: unknown,
	rawRequestDump: RawHttpRequestDump | undefined,
	capturedErrorResponse?: CapturedHttpErrorResponse,
): Promise<string> {
	let message = formatErrorMessageWithRetryAfter(error, capturedErrorResponse?.headers);
	const capturedMessage = formatCapturedHttpError(capturedErrorResponse);
	if (capturedMessage) {
		if (/\bstatus code\s*\(no body\)/i.test(message)) {
			message = `${capturedErrorResponse?.status ?? "HTTP"} status code: ${capturedMessage}`;
		} else if (!message.includes(capturedMessage)) {
			message = `${message}\n${capturedMessage}`;
		}
	}
	if (isModelUnavailableError(message, error)) {
		message = `${message}\n\n${formatModelUnavailableGuidance(rawRequestDump)}`;
	}
	message = appendTransportFailureContext(message, error, rawRequestDump);
	return appendRawHttpRequestDumpFor400(message, error, rawRequestDump);
}

export function withHttpStatus(error: unknown, status: number): Error {
	const wrapped = error instanceof Error ? error : new Error(String(error));
	(wrapped as ErrorWithStatus).status = status;
	return wrapped;
}

/**
 * Rewrite error message for GitHub Copilot request failures.
 * Must run AFTER finalizeErrorMessage since it replaces the message entirely.
 *
 * 400 `model_not_supported` = Copilot routing rollout gap for our OAuth client.
 *        A preview model (gpt-5.3-OpenAI code backend, gpt-5.4*, ...) flaps between 200 and
 *        400 because only some of Copilot's backends have the model. After the
 *        in-request retry exhausts, surface guidance rather than the raw error.
 * 401 = token invalid/expired → credential removal is safe, prompt re-login.
 * 403 = token valid but access denied (plan, model policy, org restriction) →
 *       do NOT reuse the auth-failed string (which triggers credential removal).
 */
export function rewriteCopilotError(errorMessage: string, error: unknown, provider: string): string {
	if (provider !== "github-copilot") return errorMessage;
	const status = extractHttpStatusFromError(error);
	if (status === 401) {
		return `GitHub Copilot authentication failed (HTTP 401). Your token may have been revoked. Please re-login with /login github-copilot`;
	}
	if (status === 403) {
		return `GitHub Copilot access denied (HTTP 403). Your account may not have access to this model or feature. Check your Copilot plan or model policy settings.`;
	}
	if (isCopilotTransientModelError(error)) {
		return `GitHub Copilot rejected this model (HTTP 400 model_not_supported) after retries. This is a known intermittent rollout gap for preview models on OAuth clients other than VS Code. Try again in a few seconds, switch to a GA model (gpt-5-mini, gpt-5.2), or run this model from VS Code.`;
	}
	return errorMessage;
}

function sanitizeDump(dump: RawHttpRequestDump): RawHttpRequestDump {
	return {
		...dump,
		url: redactRequestUrl(dump.url),
		headers: redactHeaders(dump.headers),
		body: sanitizeDumpBody(dump.body),
	};
}

function sanitizeDumpBody(value: unknown): unknown {
	if (Array.isArray(value)) {
		return value.map(item => sanitizeDumpBody(item));
	}
	if (!isObject(value)) {
		return value;
	}

	const type = typeof value.type === "string" ? value.type : undefined;
	const redactedKeys = getRedactedBodyKeys(type);
	const sanitized: Record<string, unknown> = {};
	for (const [key, property] of Object.entries(value)) {
		if (redactedKeys.has(key)) {
			sanitized[key] = "[redacted]";
			continue;
		}
		sanitized[key] = sanitizeDumpBody(property);
	}
	return sanitized;
}

function getRedactedBodyKeys(type: string | undefined): Set<string> {
	const keys = new Set<string>();
	if (type === "thinking") {
		keys.add("thinking");
		keys.add("signature");
		keys.add("thinkingSignature");
		keys.add("thoughtSignature");
	}
	if (type === "redacted_thinking" || type === "redactedThinking") {
		keys.add("data");
	}
	return keys;
}

function redactHeaders(headers: Record<string, string> | undefined): Record<string, string> | undefined {
	if (!headers) {
		return undefined;
	}

	const redacted: Record<string, string> = {};
	for (const [key, value] of Object.entries(headers)) {
		if (SENSITIVE_HEADERS.includes(key.toLowerCase())) {
			redacted[key] = "[redacted]";
			continue;
		}
		redacted[key] = value;
	}
	return redacted;
}

function formatCapturedHttpError(captured: CapturedHttpErrorResponse | undefined): string | undefined {
	if (!captured) return undefined;
	const bodyText = captured.bodyText?.trim();
	if (!bodyText) return undefined;
	const payload = parseCapturedErrorPayload(captured);
	if (!payload) return bodyText;

	const errorPayload = getObjectProperty(payload, "error") ?? payload;
	// {"error": "string"} — the error value is a plain string, not a nested object.
	// Fall back to it when the structured fields ("message", etc.) are absent.
	const stringError = errorPayload === payload ? getStringProperty(payload, "error") : undefined;
	const message =
		getStringProperty(errorPayload, "message") ?? getStringProperty(payload, "message") ?? stringError ?? bodyText;
	const extras = [
		getStringProperty(errorPayload, "type") ?? getStringProperty(payload, "type"),
		getStringProperty(errorPayload, "param") ?? getStringProperty(payload, "param"),
		getStringProperty(errorPayload, "code") ?? getStringProperty(payload, "code"),
	]
		.filter(Boolean)
		.map((value, index) => {
			if (index === 0) return `type=${value}`;
			if (index === 1) return `param=${value}`;
			return `code=${value}`;
		});
	return extras.length > 0 ? `${message} (${extras.join(" ")})` : message;
}

function parseCapturedErrorPayload(captured: CapturedHttpErrorResponse): Record<string, unknown> | undefined {
	if (isObject(captured.bodyJson)) {
		return captured.bodyJson;
	}
	if (!captured.bodyText) return undefined;
	try {
		const parsed = JSON.parse(captured.bodyText);
		return isObject(parsed) ? parsed : undefined;
	} catch {
		return undefined;
	}
}

function getObjectProperty(value: Record<string, unknown>, key: string): Record<string, unknown> | undefined {
	const property = value[key];
	return isObject(property) ? property : undefined;
}

function getStringProperty(value: Record<string, unknown>, key: string): string | undefined {
	const property = value[key];
	return typeof property === "string" && property.trim().length > 0 ? property : undefined;
}

function isObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
