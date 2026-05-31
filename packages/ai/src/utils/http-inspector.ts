import * as path from "node:path";
import { extractHttpStatusFromError, getLogsDir } from "@gajae-code/utils";
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
	const filePath = path.join(getLogsDir(), "http-400-requests", fileName);

	try {
		await Bun.write(filePath, `${JSON.stringify(sanitizedDump, null, 2)}\n`);
		return `${message}\nraw-http-request=${filePath}`;
	} catch (writeError) {
		const writeMessage = writeError instanceof Error ? writeError.message : String(writeError);
		return `${message}\nraw-http-request-save-failed=${writeMessage}`;
	}
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
