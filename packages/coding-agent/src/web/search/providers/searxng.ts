/**
 * SearXNG Web Search Provider
 *
 * Calls a SearXNG instance's JSON search API and maps results into the unified
 * SearchResponse shape used by the web search tool.
 *
 * SearXNG is a free, open-source metasearch engine that aggregates results from
 * multiple sources without tracking users. It supports self-hosted instances
 * and various authentication methods (bearer token, basic auth, or none).
 *
 * Configuration via settings:
 *   searxng.endpoint      - Base URL of the SearXNG instance (e.g. https://searx.example.org)
 *   searxng.token         - Optional bearer token for authentication
 *   searxng.basicUsername - Optional RFC 7617 Basic auth username
 *   searxng.basicPassword - Optional RFC 7617 Basic auth password
 *   searxng.categories    - Optional comma-separated categories filter
 *   searxng.language      - Optional language code (e.g. en, zh-CN)
 *
 * Environment variable fallbacks:
 *   SEARXNG_ENDPOINT       - Base URL of the SearXNG instance
 *   SEARXNG_TOKEN          - Optional bearer token
 *   SEARXNG_BASIC_USERNAME - Optional RFC 7617 Basic auth username
 *   SEARXNG_BASIC_PASSWORD - Optional RFC 7617 Basic auth password
 *
 * A project settings endpoint must not receive a credential that exists only in
 * the operator environment. The project file can still authenticate with a
 * credential it sets itself, and an operator endpoint still receives an
 * operator environment credential.
 *
 * Reference: https://docs.searxng.org/dev/search_api.html
 */

import * as path from "node:path";
import type { AuthStorage } from "@gajae-code/ai/core";
import { $credentialEnv, parseEnvFile } from "@gajae-code/utils";
import type { Settings } from "../../../config/settings";
import { settings } from "../../../config/settings";
import type { SearchResponse, SearchSource } from "../../../web/search/types";
import { SearchProviderError } from "../../../web/search/types";
import { clampNumResults, dateToAgeSeconds } from "../utils";
import {
	SEARXNG_BASIC_CREDENTIAL_PREFIX,
	SEARXNG_BEARER_CREDENTIAL_PREFIX,
	type SearchParams,
	SearchProvider,
	type SearchProviderSettings,
} from "./base";
import { classifyProviderHttpError, withHardTimeout } from "./utils";

const DEFAULT_NUM_RESULTS = 10;
const MAX_NUM_RESULTS = 20;

/** Map our recency filter to SearXNG time_range parameter.
 *  SearXNG only supports day/month/year, so week maps to month. */
const RECENCY_MAP: Record<"day" | "week" | "month" | "year", string> = {
	day: "day",
	week: "month",
	month: "month",
	year: "year",
};

/** SearXNG JSON API response types */
interface SearXNGResult {
	title?: string;
	url?: string;
	content?: string;
	engine?: string;
	publishedDate?: string;
	/** SearXNG sometimes uses publishedDate, sometimes just date */
	published_date?: string;
	score?: number;
}

interface SearXNGResponse {
	query?: string;
	number_of_results?: number;
	results?: SearXNGResult[];
	suggestions?: string[];
	corrections?: string[];
	unresponsive_engines?: Array<[string, string]>;
}

interface SearXNGAuth {
	type: "basic" | "bearer";
	value: string;
}

/**
 * SearXNG environment value, from trusted sources only, preserving an
 * intentionally empty setting.
 *
 * These four names decide where search requests go and what credential they
 * carry, and `$env` merges the caller's `cwd/.env` into `process.env`, so a
 * repository could otherwise redirect the search and hand over the basic-auth
 * material.
 *
 * `$credentialEnv` is the resolver for that boundary, but it collapses an empty
 * value to `undefined` — and SearXNG basic auth treats "set but empty" as
 * meaningful (`alice:` and `:s3cret` are both valid). So an empty value is
 * recovered explicitly, and only when the project `.env` is not what set it.
 */
function trustedSearxngEnv(name: string): string | null {
	const trusted = $credentialEnv(name);
	if (trusted !== undefined) return trusted;

	const raw = process.env[name];
	if (raw === undefined || raw.trim().length > 0) return null;
	// Empty-but-set. Honour it unless the project `.env` is the source.
	const projectValue = parseEnvFile(path.join(process.cwd(), ".env"))[name];
	if (projectValue !== undefined && projectValue.trim().length === 0) return null;
	return "";
}

/** Test seam: the SearXNG endpoint and auth material as resolved from trusted env. */
export function resolveSearxngConfigForTest(): {
	endpoint: string | null;
	token: string | null;
	basicUsername: string | null;
	basicPassword: string | null;
} {
	return {
		endpoint: findEndpoint(),
		token: findToken(),
		basicUsername: findBasicUsername(),
		basicPassword: findBasicPassword(),
	};
}

/** Find SearXNG endpoint from settings or environment. */
function findEndpoint(activeSettings?: Settings): string | null {
	try {
		const endpoint = (activeSettings ?? settings).get("searxng.endpoint");
		if (endpoint) return endpoint;
	} catch {
		// Settings not initialized yet
	}
	return trustedSearxngEnv("SEARXNG_ENDPOINT");
}

/**
 * True when `endpoint` is the value supplied by the project settings layer.
 *
 * `get` is global, then project, then runtime override. `getOverride` and
 * `getGlobal` are the layers a project file cannot write, so a value that is
 * present, not overridden, and different from the global layer came from the
 * project file. An equal global value is the operator endpoint even if the
 * project file repeats it.
 */
function endpointComesFromProjectLayer(activeSettings: Settings | undefined, endpoint: string | null): boolean {
	if (!endpoint) return false;
	try {
		const active = activeSettings ?? settings;
		if (active.getOverride("searxng.endpoint") !== undefined) return false;
		if (!active.has("searxng.endpoint")) return false;
		const effective = active.get("searxng.endpoint");
		if (effective !== endpoint) return false;
		const globalValue = active.getGlobal("searxng.endpoint");
		return globalValue === undefined || globalValue !== effective;
	} catch {
		return false;
	}
}

/** Find SearXNG bearer token from settings or environment. */
function findToken(activeSettings?: Settings, allowEnvironment = true): string | null {
	try {
		const token = (activeSettings ?? settings).get("searxng.token");
		if (token) return token;
	} catch {
		// Settings not initialized yet
		return allowEnvironment ? trustedSearxngEnv("SEARXNG_TOKEN") : null;
	}
	if (!allowEnvironment) return null;
	return trustedSearxngEnv("SEARXNG_TOKEN");
}

/** Find SearXNG Basic auth username from settings or environment. */
function findBasicUsername(activeSettings?: Settings, allowEnvironment = true): string | null {
	try {
		const username = (activeSettings ?? settings).get("searxng.basicUsername");
		if (username !== undefined) return username;
	} catch {
		// Settings not initialized yet
		return allowEnvironment ? trustedSearxngEnv("SEARXNG_BASIC_USERNAME") : null;
	}
	if (!allowEnvironment) return null;
	return trustedSearxngEnv("SEARXNG_BASIC_USERNAME");
}

/** Find SearXNG Basic auth password from settings or environment. */
function findBasicPassword(activeSettings?: Settings, allowEnvironment = true): string | null {
	try {
		const password = (activeSettings ?? settings).get("searxng.basicPassword");
		if (password !== undefined) return password;
	} catch {
		// Settings not initialized yet
		return allowEnvironment ? trustedSearxngEnv("SEARXNG_BASIC_PASSWORD") : null;
	}
	if (!allowEnvironment) return null;
	return trustedSearxngEnv("SEARXNG_BASIC_PASSWORD");
}

/** Build the RFC 7617 Basic auth credential using UTF-8 bytes. */
function buildBasicAuthValue(username: string, password: string): string {
	return Buffer.from(`${username}:${password}`, "utf-8").toString("base64");
}

/** RFC 7617 forbids C0 and C1 control characters in Basic auth credentials. */
function hasControlCharacters(value: string): boolean {
	return /[\u0000-\u001F\u007F-\u009F]/u.test(value);
}

/**
 * Find SearXNG authentication from settings or environment. Basic auth takes
 * precedence over bearer tokens.
 *
 * When `endpoint` came from the project settings layer, environment credentials
 * are omitted. A complete basic-auth pair or token set in settings is still used,
 * including one the project file set itself. An incomplete basic-auth pair is not
 * filled from the environment: the search continues with a project token, or with
 * no Authorization header, instead of failing closed on the missing half.
 */
function findAuth(activeSettings?: Settings, endpoint?: string | null): SearXNGAuth | null {
	const resolvedEndpoint = endpoint === undefined ? findEndpoint(activeSettings) : endpoint;
	const allowEnvironment = !endpointComesFromProjectLayer(activeSettings, resolvedEndpoint);
	const username = findBasicUsername(activeSettings, allowEnvironment);
	const password = findBasicPassword(activeSettings, allowEnvironment);
	const token = findToken(activeSettings, allowEnvironment);
	if (!allowEnvironment && (username === null) !== (password === null)) {
		return token ? { type: "bearer", value: token } : null;
	}
	return resolveBasicOrBearerAuth(username, password, token);
}

function resolveBasicOrBearerAuth(
	basicUsername: string | null,
	basicPassword: string | null,
	token: string | null,
): SearXNGAuth | null {
	if (basicUsername !== null || basicPassword !== null) {
		if (basicUsername === null || basicPassword === null) {
			throw new Error(
				"SearXNG Basic auth requires both searxng.basicUsername and searxng.basicPassword, or SEARXNG_BASIC_USERNAME and SEARXNG_BASIC_PASSWORD.",
			);
		}
		if (basicUsername.includes(":")) {
			throw new Error("SearXNG Basic auth username cannot contain ':' because RFC 7617 uses it as the separator.");
		}
		if (hasControlCharacters(basicUsername) || hasControlCharacters(basicPassword)) {
			throw new Error("SearXNG Basic auth credentials must not contain RFC 7617 control characters.");
		}
		return { type: "basic", value: buildBasicAuthValue(basicUsername, basicPassword) };
	}

	return token ? { type: "bearer", value: token } : null;
}

async function findAuthFromStorage(authStorage: AuthStorage): Promise<SearXNGAuth | null> {
	const encoded = await authStorage.getApiKey("searxng");
	if (!encoded) return null;
	if (encoded.startsWith(SEARXNG_BASIC_CREDENTIAL_PREFIX)) {
		try {
			const parsed = JSON.parse(
				Buffer.from(encoded.slice(SEARXNG_BASIC_CREDENTIAL_PREFIX.length), "base64").toString("utf8"),
			) as { username?: unknown; password?: unknown };
			const username = typeof parsed.username === "string" ? parsed.username : null;
			const password = typeof parsed.password === "string" ? parsed.password : null;
			return resolveBasicOrBearerAuth(username, password, null);
		} catch {
			throw new Error("Invalid SearXNG Basic auth credential in the session auth broker.");
		}
	}
	if (encoded.startsWith(SEARXNG_BEARER_CREDENTIAL_PREFIX)) {
		return { type: "bearer", value: encoded.slice(SEARXNG_BEARER_CREDENTIAL_PREFIX.length) };
	}
	return { type: "bearer", value: encoded };
}

/** Build the search URL and headers for a SearXNG request */
function buildRequest(
	endpoint: string,
	params: {
		query: string;
		num_results?: number;
		recency?: "day" | "week" | "month" | "year";
		categories?: string;
		language?: string;
		signal?: AbortSignal;
	},
	auth: SearXNGAuth | null,
): { url: URL; headers: Record<string, string> } {
	const base = endpoint.replace(/\/+$/, "");
	const url = new URL(`${base}/search`);

	url.searchParams.set("q", params.query);
	url.searchParams.set("format", "json");

	if (params.num_results) {
		url.searchParams.set("pageno", "1");
	}

	if (params.recency) {
		url.searchParams.set("time_range", RECENCY_MAP[params.recency]);
	}

	if (params.categories) {
		url.searchParams.set("categories", params.categories);
	}

	if (params.language) {
		url.searchParams.set("language", params.language);
	}

	const headers: Record<string, string> = {
		Accept: "application/json",
	};

	if (auth?.type === "basic") {
		headers.Authorization = `Basic ${auth.value}`;
	} else if (auth?.type === "bearer") {
		headers.Authorization = `Bearer ${auth.value}`;
	}

	return { url, headers };
}

async function callSearXNGSearch(
	endpoint: string,
	params: {
		query: string;
		num_results?: number;
		recency?: "day" | "week" | "month" | "year";
		categories?: string;
		language?: string;
		signal?: AbortSignal;
	},
	auth: SearXNGAuth | null,
): Promise<SearXNGResponse> {
	const { url, headers } = buildRequest(endpoint, params, auth);

	const response = await fetch(url, {
		headers,
		signal: withHardTimeout(params.signal, "api"),
	});

	if (!response.ok) {
		const errorText = await response.text();
		const classified = classifyProviderHttpError("searxng", response.status, errorText);
		if (classified) throw classified;
		throw new SearchProviderError("searxng", `SearXNG API error (${response.status}): ${errorText}`, response.status);
	}

	return (await response.json()) as SearXNGResponse;
}

/** Execute SearXNG web search. */
export async function searchSearXNG(params: {
	query: string;
	num_results?: number;
	recency?: "day" | "week" | "month" | "year";
	signal?: AbortSignal;
	settings?: Settings;
	providerSettings?: SearchProviderSettings;
	authStorage?: AuthStorage;
}): Promise<SearchResponse> {
	const numResults = clampNumResults(params.num_results, DEFAULT_NUM_RESULTS, MAX_NUM_RESULTS);

	const endpoint = params.providerSettings?.searxng?.endpoint ?? findEndpoint(params.settings);
	if (!endpoint) {
		throw new Error(
			"SearXNG endpoint not configured. Set searxng.endpoint in settings or SEARXNG_ENDPOINT in environment.",
		);
	}

	const auth = params.authStorage
		? await findAuthFromStorage(params.authStorage)
		: findAuth(params.settings, endpoint);

	let categories: string | undefined;
	let language: string | undefined;
	try {
		categories = params.providerSettings?.searxng?.categories ?? undefined;
		language = params.providerSettings?.searxng?.language ?? undefined;
		if (params.providerSettings === undefined) {
			const activeSettings = params.settings ?? settings;
			categories = activeSettings.get("searxng.categories") ?? undefined;
			language = activeSettings.get("searxng.language") ?? undefined;
		}
	} catch {
		// Settings not initialized yet
	}

	const response = await callSearXNGSearch(
		endpoint,
		{
			...params,
			categories,
			language,
		},
		auth,
	);

	const sources: SearchSource[] = [];

	for (const result of response.results ?? []) {
		if (!result.url) continue;
		const publishedDate = result.publishedDate ?? result.published_date;
		sources.push({
			title: result.title ?? result.url,
			url: result.url,
			snippet: result.content?.trim() || undefined,
			publishedDate: publishedDate ?? undefined,
			ageSeconds: dateToAgeSeconds(publishedDate),
		});
	}

	return {
		provider: "searxng",
		sources: sources.slice(0, numResults),
		relatedQuestions: response.suggestions?.length ? response.suggestions : undefined,
	};
}

/** Search provider for SearXNG web search. */
export class SearXNGProvider extends SearchProvider {
	readonly id = "searxng";
	readonly label = "SearXNG";

	isAvailable(_authStorage: AuthStorage, activeSettings?: SearchProviderSettings): boolean {
		try {
			return !!(activeSettings?.searxng?.endpoint ?? trustedSearxngEnv("SEARXNG_ENDPOINT"));
		} catch {
			return false;
		}
	}

	search(params: SearchParams): Promise<SearchResponse> {
		return searchSearXNG({
			query: params.query,
			num_results: params.numSearchResults ?? params.limit,
			recency: params.recency,
			signal: params.signal,
			providerSettings: params.settings,
			authStorage: params.authStorage,
		});
	}
}
