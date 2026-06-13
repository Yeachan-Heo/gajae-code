import type { FetchImpl, ModelRequestTransform } from "../types";

const PROTECTED_EXTRA_BODY_KEYS = new Set([
	"model",
	"messages",
	"input",
	"instructions",
	"stream",
	"stream_options",
	"store",
	"max_tokens",
	"max_completion_tokens",
	"max_output_tokens",
	"temperature",
	"top_p",
	"presence_penalty",
	"frequency_penalty",
	"reasoning",
	"reasoning_effort",
	"prompt_cache_key",
	"prompt_cache_retention",
	"service_tier",
	"stop",
	"tools",
	"tool_choice",
	"parallel_tool_calls",
]);

const OPENAI_PROXY_STRIP_HEADERS = [
	"x-stainless-arch",
	"x-stainless-async",
	"x-stainless-lang",
	"x-stainless-os",
	"x-stainless-package-version",
	"x-stainless-retry-count",
	"x-stainless-runtime",
	"x-stainless-runtime-version",
	"x-stainless-timeout",
	"x-stainless-helper-method",
	"openai-organization",
	"openai-project",
	"openai-beta",
] as const;

function resolveRequestTransform(
	transform: ModelRequestTransform | undefined,
	profileUserAgent: string,
): ModelRequestTransform | undefined {
	if (!transform) return undefined;
	const profileTransform: ModelRequestTransform =
		transform.profile === "openai-proxy"
			? {
					stripHeaders: [...OPENAI_PROXY_STRIP_HEADERS],
					setHeaders: { "User-Agent": profileUserAgent },
				}
			: {};
	return {
		...profileTransform,
		...transform,
		stripHeaders: transform.stripHeaders ?? profileTransform.stripHeaders,
		setHeaders: transform.setHeaders
			? { ...(profileTransform.setHeaders ?? {}), ...transform.setHeaders }
			: profileTransform.setHeaders,
		extraBody: transform.extraBody,
	};
}

function deleteHeaders(headers: Headers, names: readonly string[] | undefined): void {
	for (const name of names ?? []) {
		headers.delete(name);
	}
}

function setHeaders(headers: Headers, values: Record<string, string | null> | undefined): void {
	for (const [name, value] of Object.entries(values ?? {})) {
		if (value === null) {
			headers.delete(name);
		} else {
			headers.set(name, value);
		}
	}
}

function transformHeaders(
	headers: RequestInit["headers"] | undefined,
	transform: ModelRequestTransform | undefined,
): Headers {
	const result = new Headers(headers);
	deleteHeaders(result, transform?.stripHeaders);
	setHeaders(result, transform?.setHeaders);
	return result;
}

export function applyOpenAIRequestTransformHeaders(
	headers: Record<string, string>,
	transform: ModelRequestTransform | undefined,
	profileUserAgent: string,
): Record<string, string> {
	const resolved = resolveRequestTransform(transform, profileUserAgent);
	if (!resolved) return headers;
	return Object.fromEntries(transformHeaders(headers, resolved).entries());
}

export function applyOpenAIRequestTransformBody(params: object, transform: ModelRequestTransform | undefined): void {
	if (!transform?.extraBody) return;
	const body = params as Record<string, unknown>;
	for (const [key, value] of Object.entries(transform.extraBody)) {
		if (!PROTECTED_EXTRA_BODY_KEYS.has(key) && !(key in body)) {
			body[key] = value;
		}
	}
}

export function wrapFetchForOpenAIRequestTransform(
	baseFetch: FetchImpl,
	transform: ModelRequestTransform | undefined,
	profileUserAgent: string,
): FetchImpl {
	const resolved = resolveRequestTransform(transform, profileUserAgent);
	if (!resolved) return baseFetch;
	return Object.assign(
		async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
			if (input instanceof Request) {
				const request = new Request(input, init);
				deleteHeaders(request.headers, resolved.stripHeaders);
				setHeaders(request.headers, resolved.setHeaders);
				return baseFetch(request);
			}
			return baseFetch(input, {
				...init,
				headers: transformHeaders(init?.headers, resolved),
			});
		},
		baseFetch.preconnect ? { preconnect: baseFetch.preconnect } : {},
	);
}
