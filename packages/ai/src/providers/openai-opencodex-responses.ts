import * as fs from "node:fs/promises";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";

import type { Model } from "../types";

export const OPENCODEX_DEFAULT_PORT = 10100;
export const OPENCODEX_PROBE_TIMEOUT_MS = 750;
export const OPENCODEX_MODEL_CACHE_TTL_MS = 5 * 60 * 1000;

interface RuntimePortFile {
	hostname?: unknown;
	host?: unknown;
	port?: unknown;
}

interface HealthPayload {
	ok?: unknown;
	pid?: unknown;
	port?: unknown;
	version?: unknown;
}

interface CatalogRow {
	id?: unknown;
	model?: unknown;
	name?: unknown;
	displayName?: unknown;
	contextWindow?: unknown;
	maxTokens?: unknown;
	reasoning?: unknown;
	input?: unknown;
}

export interface OpenCodexEndpoint {
	baseUrl: string;
}

function timeoutSignal(signal?: AbortSignal): AbortSignal {
	return signal
		? AbortSignal.any([signal, AbortSignal.timeout(OPENCODEX_PROBE_TIMEOUT_MS)])
		: AbortSignal.timeout(OPENCODEX_PROBE_TIMEOUT_MS);
}

function normalizeEndpoint(hostname: string, port: number): string | undefined {
	if (!Number.isInteger(port) || port < 1 || port > 65535) return undefined;
	const host = normalizeLoopbackHost(hostname);
	if (!host) return undefined;
	return `http://${formatEndpointHost(host)}:${port}`;
}

function normalizeLoopbackHost(hostname: string): string | undefined {
	const host = hostname.trim().toLowerCase();
	if (net.isIP(host) === 4 && host.startsWith("127.")) return host;
	if (host === "::1") return host;
	return undefined;
}

function formatEndpointHost(host: string): string {
	return host.includes(":") ? `[${host}]` : host;
}

function healthPort(endpoint: string): number {
	return Number(new URL(endpoint).port);
}

async function readRuntimeEndpoint(): Promise<string | undefined> {
	const home = process.env.OPENCODEX_HOME?.trim() || path.join(os.homedir(), ".opencodex");
	try {
		const raw = JSON.parse(await fs.readFile(path.join(home, "runtime-port.json"), "utf8")) as RuntimePortFile;
		const hostname =
			typeof raw.hostname === "string" ? raw.hostname : typeof raw.host === "string" ? raw.host : "127.0.0.1";
		const port = typeof raw.port === "number" ? raw.port : typeof raw.port === "string" ? Number(raw.port) : NaN;
		return normalizeEndpoint(hostname, port);
	} catch {
		return undefined;
	}
}

function candidateEndpoints(runtimeEndpoint: string | undefined): string[] {
	const candidates = runtimeEndpoint ? [runtimeEndpoint] : [];
	const fallback = normalizeEndpoint("127.0.0.1", OPENCODEX_DEFAULT_PORT);
	if (fallback && !candidates.includes(fallback)) candidates.push(fallback);
	return candidates;
}

async function fetchJson(url: string, signal?: AbortSignal): Promise<unknown> {
	const response = await fetch(url, {
		headers: { Accept: "application/json" },
		redirect: "error",
		signal: timeoutSignal(signal),
	});
	if (!response.ok) return undefined;
	return response.json();
}

function isOpenCodexHealth(payload: unknown, expectedPort: number): boolean {
	if (!payload || typeof payload !== "object" || Array.isArray(payload)) return false;
	const health = payload as HealthPayload;
	return health.ok === true && health.version === "opencodex" && health.port === expectedPort;
}

export async function resolveOpenCodexEndpoint(signal?: AbortSignal): Promise<OpenCodexEndpoint | undefined> {
	const runtimeEndpoint = await readRuntimeEndpoint();
	for (const candidate of candidateEndpoints(runtimeEndpoint)) {
		try {
			const health = await fetchJson(`${candidate}/healthz`, signal);
			if (isOpenCodexHealth(health, healthPort(candidate))) return { baseUrl: candidate };
		} catch {
			// An unavailable or foreign listener is a normal provider absence.
		}
	}
	return undefined;
}

function asPositiveNumber(value: unknown, fallback: number): number {
	return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : fallback;
}

function normalizeCatalogPayload(payload: unknown): CatalogRow[] {
	if (Array.isArray(payload)) return payload as CatalogRow[];
	if (payload && typeof payload === "object" && Array.isArray((payload as { models?: unknown }).models)) {
		return (payload as { models: CatalogRow[] }).models;
	}
	return [];
}

function normalizeModel(row: CatalogRow, endpoint: OpenCodexEndpoint): Model<"openai-responses"> | undefined {
	const rawId = typeof row.id === "string" ? row.id.trim() : typeof row.model === "string" ? row.model.trim() : "";
	if (!rawId || rawId.includes("\n")) return undefined;
	const publicId = `opencodex/${rawId}`;
	const input =
		Array.isArray(row.input) && row.input.every(value => value === "text" || value === "image")
			? row.input
			: ["text"];
	return {
		id: publicId,
		wireModelId: rawId,
		name: typeof row.displayName === "string" ? row.displayName : typeof row.name === "string" ? row.name : rawId,
		api: "openai-responses",
		provider: "opencodex",
		baseUrl: `${endpoint.baseUrl}/v1`,
		reasoning: row.reasoning !== false,
		input,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: asPositiveNumber(row.contextWindow, 128_000),
		maxTokens: asPositiveNumber(row.maxTokens, 16_384),
	};
}

export async function fetchOpenCodexModels(): Promise<readonly Model<"openai-responses">[] | null> {
	const endpoint = await resolveOpenCodexEndpoint();
	if (!endpoint) return null;
	try {
		const rows = normalizeCatalogPayload(await fetchJson(`${endpoint.baseUrl}/api/models`));
		const models = rows
			.map(row => normalizeModel(row, endpoint))
			.filter((model): model is Model<"openai-responses"> => model !== undefined);
		return models.length > 0 ? models : null;
	} catch {
		return null;
	}
}

export async function checkOpenCodexStatus(onProgress?: (message: string) => void): Promise<void> {
	const endpoint = await resolveOpenCodexEndpoint();
	if (endpoint) {
		onProgress?.(`OpenCodex is available at ${endpoint.baseUrl}`);
		return;
	}
	onProgress?.("OpenCodex is unavailable; no identity-checked local proxy was found.");
}
