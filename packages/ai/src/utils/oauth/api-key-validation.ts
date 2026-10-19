import { sanitizeDisplayLine } from "@gajae-code/utils";

type OpenAICompatibleValidationOptions = {
	provider: string;
	apiKey: string;
	baseUrl: string;
	model: string;
	signal?: AbortSignal;
	fetch?: typeof globalThis.fetch;
	requireInferenceResponse?: boolean;
	timeoutMs?: number;
};

type ModelListValidationOptions = {
	provider: string;
	apiKey: string;
	modelsUrl: string;
	signal?: AbortSignal;
	fetch?: typeof globalThis.fetch;
	timeoutMs?: number;
};

const VALIDATION_TIMEOUT_MS = 15_000;

/** Most characters of an upstream body echoed into a validation error. */
const VALIDATION_DETAILS_LIMIT = 200;
const VALIDATION_BODY_LIMIT = 64 * 1024;

function redactSecrets(text: string, apiKey: string): string {
	let safe = text.replace(/\u001b\[[0-?]*[ -/]*[@-~]/gu, "");
	if (apiKey) {
		const escaped = [...apiKey].map(char => char.replace(/[\\^$.*+?()[\]{}|]/g, "\\$&"));
		const interspersed = new RegExp(escaped.join("[\\s\\x00-\\x1f\\x7f-\\x9f]*"), "gu");
		safe = safe.replace(interspersed, "[REDACTED]");
	}
	safe = sanitizeDisplayLine(safe);
	safe = safe.replace(/[\x00-\x1f\x7f-\x9f]/gu, " ");
	if (apiKey) safe = safe.replaceAll(apiKey, "[REDACTED]");
	// Upstream errors sometimes echo credentials under a field name instead of
	// returning the exact bearer value. Redact those values before retaining any
	// bounded diagnostic snippet.
	safe = safe
		.replace(/(Bearer\s+)([^\s,}"']+)/giu, "$1[REDACTED]")
		.replace(
			/(["']?(?:authorization|proxy-authorization|api[-_ ]?key|access[-_ ]?token|refresh[-_ ]?token|token|secret|password)["']?\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s,}\]]+)/giu,
			"$1[REDACTED]",
		);
	return safe;
}

function boundedDetails(text: string, apiKey: string): string {
	const trimmed = redactSecrets(text, apiKey).trim();
	return trimmed.length > VALIDATION_DETAILS_LIMIT ? `${trimmed.slice(0, VALIDATION_DETAILS_LIMIT)}…` : trimmed;
}

type BoundedBody = { text: string; truncated: boolean };

async function readBoundedBody(response: Response, signal: AbortSignal): Promise<BoundedBody> {
	if (signal.aborted) throw new Error("Login cancelled");
	const contentLength = Number(response.headers.get("content-length"));
	if (Number.isFinite(contentLength) && contentLength > VALIDATION_BODY_LIMIT) {
		await response.body?.cancel().catch(() => {});
		return { text: "", truncated: true };
	}
	if (!response.body) return { text: "", truncated: false };
	const reader = response.body.getReader();
	const chunks: Uint8Array[] = [];
	let total = 0;
	let truncated = false;
	try {
		while (!truncated && total <= VALIDATION_BODY_LIMIT) {
			if (signal.aborted) throw new Error("Login cancelled");
			const { promise, resolve, reject } = Promise.withResolvers<{ done: boolean; value?: Uint8Array }>();
			const onAbort = () => reject(new Error("Login cancelled"));
			signal.addEventListener("abort", onAbort, { once: true });
			reader
				.read()
				.then(value => resolve(value), reject)
				.finally(() => signal.removeEventListener("abort", onAbort));
			const { done, value } = await promise;
			if (done) break;
			if (value) {
				const remaining = VALIDATION_BODY_LIMIT - total;
				if (value.byteLength > remaining) truncated = true;
				chunks.push(value.byteLength > remaining ? value.subarray(0, remaining) : value);
				total += Math.min(value.byteLength, remaining);
			}
		}
	} finally {
		await reader.cancel().catch(() => {});
	}
	const bytes = new Uint8Array(Math.min(total, VALIDATION_BODY_LIMIT));
	let offset = 0;
	for (const chunk of chunks) {
		const take = Math.min(chunk.byteLength, bytes.length - offset);
		if (take <= 0) break;
		bytes.set(chunk.subarray(0, take), offset);
		offset += take;
	}
	return { text: new TextDecoder().decode(bytes), truncated };
}

function abortFailure(
	provider: string,
	apiKey: string,
	callerSignal: AbortSignal | undefined,
	timeoutSignal: AbortSignal,
): Error | undefined {
	if (callerSignal?.aborted) return new Error("Login cancelled");
	if (timeoutSignal.aborted) return validationFailure(provider, apiKey, "validation request timed out");
}

function errorDetails(error: unknown, apiKey: string): string {
	return boundedDetails(error instanceof Error ? error.message : String(error), apiKey);
}

function validationFailure(provider: string, apiKey: string, suffix: string): Error {
	const details = boundedDetails(suffix, apiKey);
	return new Error(
		details ? `${provider} API key validation failed: ${details}` : `${provider} API key validation failed`,
	);
}

/**
 * Validate an API key against an OpenAI-compatible chat completions endpoint.
 *
 * Performs a minimal request to verify credentials and endpoint access.
 */
export async function validateOpenAICompatibleApiKey(options: OpenAICompatibleValidationOptions): Promise<void> {
	const timeoutSignal = AbortSignal.timeout(options.timeoutMs ?? VALIDATION_TIMEOUT_MS);
	const signal = options.signal ? AbortSignal.any([options.signal, timeoutSignal]) : timeoutSignal;
	const fetchImpl = options.fetch ?? globalThis.fetch;
	if (signal.aborted) throw new Error("Login cancelled");
	if (/[\x00-\x1f\x7f-\x9f]/u.test(options.apiKey))
		throw new Error(`${options.provider} API key contains unsupported control characters`);

	let response: Response;
	try {
		response = await fetchImpl(`${options.baseUrl}/chat/completions`, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Authorization: `Bearer ${options.apiKey}`,
			},
			body: JSON.stringify({
				model: options.model,
				messages: [{ role: "user", content: "ping" }],
				max_tokens: 1,
				temperature: 0,
			}),
			signal,
		});
	} catch (error) {
		const abortError = abortFailure(options.provider, options.apiKey, options.signal, timeoutSignal);
		if (abortError) throw abortError;
		throw validationFailure(
			options.provider,
			options.apiKey,
			`request failed (${errorDetails(error, options.apiKey)})`,
		);
	}

	if (response.ok) {
		if (options.requireInferenceResponse) {
			let body: string;
			try {
				const bounded = await readBoundedBody(response, signal);
				if (bounded.truncated) throw new Error("inference probe response exceeded validation limit");
				body = bounded.text;
			} catch (error) {
				const abortError = abortFailure(options.provider, options.apiKey, options.signal, timeoutSignal);
				if (abortError) throw abortError;
				if (error instanceof Error && error.message === "Login cancelled") throw error;
				if (error instanceof Error && error.message === "inference probe response exceeded validation limit")
					throw validationFailure(options.provider, options.apiKey, error.message);
				throw validationFailure(
					options.provider,
					options.apiKey,
					`the inference probe response could not be read (${errorDetails(error, options.apiKey)})`,
				);
			}
			let parsed: unknown;
			try {
				parsed = JSON.parse(body);
			} catch {
				throw validationFailure(
					options.provider,
					options.apiKey,
					`the inference probe returned a non-JSON response (${boundedDetails(body, options.apiKey)})`,
				);
			}
			const choices =
				typeof parsed === "object" && parsed !== null && "choices" in parsed
					? (parsed as { choices?: unknown }).choices
					: undefined;
			if (!Array.isArray(choices) || choices.length === 0) {
				throw validationFailure(options.provider, options.apiKey, "the inference probe returned no choices");
			}
			const firstChoice: unknown = choices[0];
			if (
				typeof firstChoice !== "object" ||
				firstChoice === null ||
				Array.isArray(firstChoice) ||
				!("message" in firstChoice)
			) {
				throw validationFailure(
					options.provider,
					options.apiKey,
					"the inference probe returned choices without a valid message",
				);
			}
			const choice = firstChoice as Record<string, unknown>;
			const rawMessage = choice.message;
			if (typeof rawMessage !== "object" || rawMessage === null || Array.isArray(rawMessage)) {
				throw validationFailure(
					options.provider,
					options.apiKey,
					"the inference probe returned choices without a valid message",
				);
			}
			const message = rawMessage as Record<string, unknown>;
			const hasContent = typeof message.content === "string" && message.content.trim().length > 0;
			const hasReasoningContent =
				typeof message.reasoning_content === "string" && message.reasoning_content.trim().length > 0;
			if (!hasContent && !hasReasoningContent && choice.finish_reason !== "length") {
				throw validationFailure(
					options.provider,
					options.apiKey,
					"the inference probe returned choices with empty content",
				);
			}
		}
		return;
	}

	let details = "";
	try {
		const bounded = await readBoundedBody(response, signal);
		details = bounded.truncated
			? "response body exceeded validation limit"
			: boundedDetails(bounded.text, options.apiKey);
	} catch {
		const abortError = abortFailure(options.provider, options.apiKey, options.signal, timeoutSignal);
		if (abortError) throw abortError;
		// ignore body parse errors, status is enough
	}

	const message = details
		? `${options.provider} API key validation failed (${response.status}): ${details}`
		: `${options.provider} API key validation failed (${response.status})`;
	throw new Error(message);
}
/**
 * Whether a 200 body is a recognizable model list. OpenAI-compatible endpoints
 * return `{"object":"list","data":[...]}`; some gateways answer with a bare
 * array or `{"models":[...]}`. Anything else — including valid JSON without a
 * list — is not evidence that the credential reached a models endpoint.
 */
function isModelList(parsed: unknown): boolean {
	const isModelArray = (value: unknown): boolean => {
		if (!Array.isArray(value)) return false;
		if (value.length === 0) return true;
		return value.some(
			item =>
				typeof item === "object" &&
				item !== null &&
				typeof (item as { id?: unknown }).id === "string" &&
				(item as { id: string }).id.trim().length > 0,
		);
	};
	if (Array.isArray(parsed)) return isModelArray(parsed);
	if (typeof parsed !== "object" || parsed === null) return false;
	const record = parsed as { data?: unknown; models?: unknown };
	return isModelArray(record.data) || isModelArray(record.models);
}

/**
 * Validate a provider models endpoint's reachability and response shape.
 *
 * Useful for providers where access to specific models may vary by plan and
 * should not block login; an available model list is not proof that an
 * authenticated inference request will succeed for the supplied key.
 *
 * A 200 status alone is NOT accepted: a captive portal, misrouting proxy, or
 * broken gateway can answer 200 with an HTML page or an empty JSON object.
 * The body must parse as JSON and carry a recognizable model list before the
 * endpoint is considered reachable. This catalog check is not proof that
 * authenticated inference is entitled to use the supplied key.
 */
export async function validateApiKeyAgainstModelsEndpoint(options: ModelListValidationOptions): Promise<void> {
	const timeoutSignal = AbortSignal.timeout(options.timeoutMs ?? VALIDATION_TIMEOUT_MS);
	const signal = options.signal ? AbortSignal.any([options.signal, timeoutSignal]) : timeoutSignal;
	const fetchImpl = options.fetch ?? globalThis.fetch;
	if (signal.aborted) throw new Error("Login cancelled");
	if (/[\x00-\x1f\x7f-\x9f]/u.test(options.apiKey))
		throw new Error(`${options.provider} API key contains unsupported control characters`);

	let response: Response;
	try {
		response = await fetchImpl(options.modelsUrl, {
			method: "GET",
			headers: {
				Authorization: `Bearer ${options.apiKey}`,
			},
			signal,
		});
	} catch (error) {
		const abortError = abortFailure(options.provider, options.apiKey, options.signal, timeoutSignal);
		if (abortError) throw abortError;
		throw validationFailure(
			options.provider,
			options.apiKey,
			`request failed (${errorDetails(error, options.apiKey)})`,
		);
	}

	if (response.ok) {
		let body: string;
		try {
			const bounded = await readBoundedBody(response, signal);
			if (bounded.truncated) throw new Error("response body exceeded validation limit");
			body = bounded.text;
		} catch (error) {
			const abortError = abortFailure(options.provider, options.apiKey, options.signal, timeoutSignal);
			if (abortError) throw abortError;
			if (error instanceof Error && error.message === "Login cancelled") throw error;
			throw validationFailure(
				options.provider,
				options.apiKey,
				`the models endpoint response body could not be read (${errorDetails(error, options.apiKey)})`,
			);
		}
		let parsed: unknown;
		try {
			parsed = JSON.parse(body);
		} catch {
			throw new Error(
				`${options.provider} API key validation failed: the models endpoint returned ${response.status} with a non-JSON body` +
					`${body.trim() ? ` (${boundedDetails(body, options.apiKey)})` : ""}. Refusing to accept the key on status alone.`,
			);
		}
		if (!isModelList(parsed)) {
			throw new Error(
				`${options.provider} API key validation failed: the models endpoint returned ${response.status} without a recognizable ` +
					`model list. Refusing to accept the key on status alone.`,
			);
		}
		return;
	}

	let details = "";
	try {
		const bounded = await readBoundedBody(response, signal);
		details = bounded.truncated
			? "response body exceeded validation limit"
			: boundedDetails(bounded.text, options.apiKey);
	} catch {
		const abortError = abortFailure(options.provider, options.apiKey, options.signal, timeoutSignal);
		if (abortError) throw abortError;
		// ignore body parse errors, status is enough
	}

	const message = details
		? `${options.provider} API key validation failed (${response.status}): ${details}`
		: `${options.provider} API key validation failed (${response.status})`;
	throw new Error(message);
}
