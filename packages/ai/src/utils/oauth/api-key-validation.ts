type OpenAICompatibleValidationOptions = {
	provider: string;
	apiKey: string;
	baseUrl: string;
	model: string;
	signal?: AbortSignal;
};

type ModelListValidationOptions = {
	provider: string;
	apiKey: string;
	modelsUrl: string;
	signal?: AbortSignal;
};

const VALIDATION_TIMEOUT_MS = 15_000;

/** Most characters of an upstream body echoed into a validation error. */
const VALIDATION_DETAILS_LIMIT = 200;

function boundedDetails(text: string): string {
	const trimmed = text.trim();
	return trimmed.length > VALIDATION_DETAILS_LIMIT ? `${trimmed.slice(0, VALIDATION_DETAILS_LIMIT)}…` : trimmed;
}

/**
 * Validate an API key against an OpenAI-compatible chat completions endpoint.
 *
 * Performs a minimal request to verify credentials and endpoint access.
 */
export async function validateOpenAICompatibleApiKey(options: OpenAICompatibleValidationOptions): Promise<void> {
	const timeoutSignal = AbortSignal.timeout(VALIDATION_TIMEOUT_MS);
	const signal = options.signal ? AbortSignal.any([options.signal, timeoutSignal]) : timeoutSignal;

	const response = await fetch(`${options.baseUrl}/chat/completions`, {
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

	if (response.ok) {
		return;
	}

	let details = "";
	try {
		details = boundedDetails(await response.text());
	} catch {
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
	if (Array.isArray(parsed)) return true;
	if (typeof parsed !== "object" || parsed === null) return false;
	const record = parsed as { data?: unknown; models?: unknown };
	return Array.isArray(record.data) || Array.isArray(record.models);
}

/**
 * Validate an API key against a provider models endpoint.
 *
 * Useful for providers where access to specific models may vary by plan and
 * should not block key validation.
 *
 * A 200 status alone is NOT accepted: a captive portal, misrouting proxy, or
 * broken gateway can answer 200 with an HTML page or an empty JSON object, and
 * accepting the key on status alone would store a credential that was never
 * actually checked. The body must parse as JSON and carry a recognizable model
 * list before the key is considered validated.
 */
export async function validateApiKeyAgainstModelsEndpoint(options: ModelListValidationOptions): Promise<void> {
	const timeoutSignal = AbortSignal.timeout(VALIDATION_TIMEOUT_MS);
	const signal = options.signal ? AbortSignal.any([options.signal, timeoutSignal]) : timeoutSignal;

	const response = await fetch(options.modelsUrl, {
		method: "GET",
		headers: {
			Authorization: `Bearer ${options.apiKey}`,
		},
		signal,
	});

	if (response.ok) {
		let body: string;
		try {
			body = await response.text();
		} catch (error) {
			throw new Error(
				`${options.provider} API key validation failed: the models endpoint response body could not be read (${
					error instanceof Error ? error.message : String(error)
				})`,
			);
		}
		let parsed: unknown;
		try {
			parsed = JSON.parse(body);
		} catch {
			throw new Error(
				`${options.provider} API key validation failed: the models endpoint returned ${response.status} with a non-JSON body` +
					`${body.trim() ? ` (${boundedDetails(body)})` : ""}. Refusing to accept the key on status alone.`,
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
		details = boundedDetails(await response.text());
	} catch {
		// ignore body parse errors, status is enough
	}

	const message = details
		? `${options.provider} API key validation failed (${response.status}): ${details}`
		: `${options.provider} API key validation failed (${response.status})`;
	throw new Error(message);
}
