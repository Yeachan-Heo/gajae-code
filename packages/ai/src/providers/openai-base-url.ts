import { type EndpointConfiguration, isDefaultOpenAIBaseUrl, readEndpointConfiguration } from "@gajae-code/utils";

export const OPENAI_DEFAULT_BASE_URL = "https://api.openai.com/v1";
const OPENAI_DEFAULT_BASE_URL_HOST = "api.openai.com";

/** Single trusted-routing classifier; re-exported so provider call sites keep one authority. */
export { isDefaultOpenAIBaseUrl };

export function isOpenAIHostBaseUrl(baseUrl: string): boolean {
	try {
		const url = new URL(baseUrl);
		return url.hostname === OPENAI_DEFAULT_BASE_URL_HOST;
	} catch {
		return baseUrl.toLowerCase().startsWith(OPENAI_DEFAULT_BASE_URL);
	}
}

export function resolveOpenAIProviderBaseUrl(
	baseUrl: string | undefined,
	authCredentialType: "api_key" | "oauth" | undefined,
	endpointConfiguration?: EndpointConfiguration,
): string {
	if (authCredentialType === "oauth") return OPENAI_DEFAULT_BASE_URL;
	// Trusted sources only: this base URL becomes the request endpoint that carries
	// the OpenAI credential, and `$env` merges the caller's `cwd/.env`, so reading it
	// there would let repository content redirect authenticated traffic. A supplied
	// capture is read instead of live state so the request keeps the routing it was
	// admitted with.
	const envBaseUrl = readEndpointConfiguration(endpointConfiguration, "OPENAI_BASE_URL");
	const configuredBaseUrl = baseUrl?.trim();
	if (envBaseUrl && (!configuredBaseUrl || isDefaultOpenAIBaseUrl(configuredBaseUrl))) {
		return envBaseUrl;
	}
	return configuredBaseUrl || envBaseUrl || OPENAI_DEFAULT_BASE_URL;
}

export type OpenAIRequestQuery = string;

export function appendUrlPath(baseUrl: string | undefined, path: string): string | undefined {
	if (!baseUrl) return undefined;
	const normalizedPath = path.replace(/^\/+/g, "");
	try {
		const parsed = new URL(baseUrl);
		parsed.pathname = `${parsed.pathname.replace(/\/+$/g, "")}/${normalizedPath}`;
		return parsed.toString();
	} catch {
		return `${baseUrl.replace(/\/+$/g, "")}/${normalizedPath}`;
	}
}

export function splitBaseUrlQuery(baseUrl: string | undefined): {
	baseUrl: string | undefined;
	query?: OpenAIRequestQuery;
} {
	if (!baseUrl) return { baseUrl };
	try {
		const parsed = new URL(baseUrl);
		if (!parsed.search) return { baseUrl };
		const queryStart = baseUrl.indexOf("?");
		const fragmentStart = baseUrl.indexOf("#", queryStart);
		const query = baseUrl.slice(queryStart + 1, fragmentStart === -1 ? undefined : fragmentStart);
		if (!query) return { baseUrl };
		parsed.search = "";
		return {
			baseUrl: parsed.toString(),
			query,
		};
	} catch {
		return { baseUrl };
	}
}

export function hasQueryParameter(query: OpenAIRequestQuery | undefined, name: string): boolean {
	return query ? new URLSearchParams(query).has(name) : false;
}

function appendRawQuery(url: string, query: OpenAIRequestQuery | undefined): string {
	if (!query) return url;
	const fragmentStart = url.indexOf("#");
	const beforeFragment = fragmentStart === -1 ? url : url.slice(0, fragmentStart);
	const fragment = fragmentStart === -1 ? "" : url.slice(fragmentStart);
	return `${beforeFragment}${beforeFragment.includes("?") ? "&" : "?"}${query}${fragment}`;
}

export function buildRequestUrl(
	baseUrl: string | undefined,
	path: string,
	query?: OpenAIRequestQuery,
): string | undefined {
	const url = appendUrlPath(baseUrl, path);
	return url ? appendRawQuery(url, query) : undefined;
}

export function appendQueryToRequest(
	input: string | URL | Request,
	query?: OpenAIRequestQuery,
): string | URL | Request {
	if (!query) return input;
	const url = appendRawQuery(input instanceof Request ? input.url : String(input), query);
	if (input instanceof Request) return new Request(url, input as unknown as RequestInit);
	return url;
}
