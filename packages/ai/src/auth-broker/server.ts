/**
 * Auth broker HTTP server.
 *
 * Wraps an {@link AuthStorage} (backed by a SQLite store on the broker host)
 * and exposes a minimal REST API for snapshot pulls and explicit refresh /
 * disable operations. Background refresh of expiring credentials lives in
 * {@link AuthBrokerRefresher}.
 *
 * Transport security is delegated to the operator (Tailscale / Wireguard);
 * the server only checks a bearer token against an allow-list per request.
 */
import { logger } from "@gajae-code/utils";
import type { AuthStorage } from "../auth-storage";
import { parseBind } from "../utils/parse-bind";
import { AuthBrokerRefresher, type AuthBrokerRefresherSchedule } from "./refresher";
import type {
	CredentialDisableResponse,
	CredentialIfAbsentUploadResponse,
	CredentialRefreshResponse,
	CredentialUploadResponse,
	HealthzResponse,
	RefresherSchedule,
	SnapshotEntry,
	SnapshotResponse,
	SnapshotStreamEntryEvent,
	SnapshotStreamRemovedEvent,
	SnapshotStreamSnapshotEvent,
} from "./types";
import {
	DEFAULT_AUTH_BROKER_BIND,
	DEFAULT_REFRESH_INTERVAL_MS,
	DEFAULT_REFRESH_SKEW_MS,
	DEFAULT_SERVER_IDLE_TIMEOUT_S,
	DEFAULT_STREAM_KEEPALIVE_MS,
} from "./types";
import { credentialDisableRequestSchema, credentialUploadRequestSchema } from "./wire-schemas";

export interface AuthBrokerServerOptions {
	/** Underlying credential storage (wraps the local SQLite store on the broker). */
	storage: AuthStorage;
	/** Listen address; accepts `host:port` or just `port`. */
	bind?: string;
	/** Accept any of these bearer tokens. Empty disables auth (loopback only). */
	bearerTokens: string[];
	/** Broker version string surfaced on `/v1/healthz`. */
	version?: string;
	/** Refresh credentials expiring within this window. Default 5 min. */
	refreshSkewMs?: number;
	/** Background refresh cadence. Default 60s. */
	refreshIntervalMs?: number;
	/** Disable the background refresher (e.g. for tests). */
	disableRefresher?: boolean;
	/**
	 * Override SSE keepalive cadence in milliseconds for `/v1/snapshot/stream`.
	 * Internal-only — tests use a short interval so they can assert heartbeats
	 * without long sleeps. Default {@link DEFAULT_STREAM_KEEPALIVE_MS}.
	 */
	streamKeepaliveMs?: number;
}

export interface AuthBrokerServerHandle {
	/** Bound URL (`http://host:port`). */
	url: string;
	port: number;
	hostname: string;
	close(): Promise<void>;
}

function json(status: number, body: unknown, headers?: Record<string, string>): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "Content-Type": "application/json", ...(headers ?? {}) },
	});
}

function empty(status: number, headers?: Record<string, string>): Response {
	return new Response(null, { status, headers });
}

function isAuthorized(req: Request, tokens: ReadonlySet<string>): boolean {
	if (tokens.size === 0) return true;
	const header = req.headers.get("authorization");
	if (!header) return false;
	const match = header.match(/^Bearer\s+(.+)$/i);
	if (!match) return false;
	return tokens.has(match[1].trim());
}

/**
 * Parse + validate a JSON request body against a Zod schema. Returns a
 * `Response` (400) on parse/validation failure so handlers can early-return.
 * When `allowEmpty` is set, an empty request body is validated against `{}`.
 */
async function parseBody<T>(
	req: Request,
	schema: { safeParse(input: unknown): { success: true; data: T } | { success: false; error: { message: string } } },
	options: { allowEmpty?: boolean } = {},
): Promise<{ ok: true; data: T } | { ok: false; response: Response }> {
	let raw: string;
	try {
		raw = await req.text();
	} catch (error) {
		return { ok: false, response: json(400, { error: `Invalid request body: ${String(error)}` }) };
	}
	if (raw.length === 0 && !options.allowEmpty) {
		return { ok: false, response: json(400, { error: "Request body required" }) };
	}
	let parsed: unknown;
	try {
		parsed = raw.length === 0 ? {} : JSON.parse(raw);
	} catch (error) {
		return { ok: false, response: json(400, { error: `Invalid JSON body: ${String(error)}` }) };
	}
	const result = schema.safeParse(parsed);
	if (!result.success) {
		return { ok: false, response: json(400, { error: result.error.message }) };
	}
	return { ok: true, data: result.data };
}

const REFRESH_ROUTE = /^\/v1\/credential\/(\d+)\/refresh$/;
const DISABLE_ROUTE = /^\/v1\/credential\/(\d+)\/disable$/;

const MAX_SNAPSHOT_WAIT_MS = 30_000;
const DISABLED_NEXT_SWEEP_IN_MS = Number.MAX_SAFE_INTEGER;

function snapshotHeaders(generation: number): Record<string, string> {
	return {
		ETag: `"${generation}"`,
		"Cache-Control": "no-store",
	};
}

function parseGenerationTag(header: string | null): number | undefined {
	if (!header) return undefined;
	let value = header.trim();
	if (value.startsWith("W/")) value = value.slice(2).trim();
	if (value.startsWith('"') && value.endsWith('"') && value.length >= 2) {
		value = value.slice(1, -1);
	}
	const generation = Number(value);
	if (!Number.isInteger(generation) || generation < 0) return undefined;
	return generation;
}

function parseWaitMs(url: URL): number {
	const raw = url.searchParams.get("wait");
	if (raw === null) return 0;
	const parsed = Number(raw);
	if (!Number.isFinite(parsed)) return 0;
	return Math.max(0, Math.min(MAX_SNAPSHOT_WAIT_MS, Math.trunc(parsed)));
}

function delayResult(ms: number): { promise: Promise<"timeout">; cancel: () => void } {
	const done = Promise.withResolvers<"timeout">();
	const timer = setTimeout(() => done.resolve("timeout"), ms);
	timer.unref?.();
	return {
		promise: done.promise,
		cancel: () => clearTimeout(timer),
	};
}

class GenerationGate {
	readonly #storage: AuthStorage;
	readonly #unsubscribe: () => void;
	#waiters: Map<number, Set<() => void>> = new Map();

	constructor(storage: AuthStorage) {
		this.#storage = storage;
		this.#unsubscribe = storage.onGenerationChanged(generation => this.#wake(generation));
	}

	waitForChange(afterGeneration: number, signal: AbortSignal): Promise<"changed" | "aborted"> {
		if (this.#storage.getGeneration() !== afterGeneration) return Promise.resolve("changed");
		if (signal.aborted) return Promise.resolve("aborted");

		const done = Promise.withResolvers<"changed" | "aborted">();
		let settled = false;
		const waiters = this.#waiters.get(afterGeneration) ?? new Set<() => void>();
		this.#waiters.set(afterGeneration, waiters);

		const cleanup = (): void => {
			signal.removeEventListener("abort", onAbort);
			waiters.delete(resolveChanged);
			if (waiters.size === 0) this.#waiters.delete(afterGeneration);
		};
		const settle = (result: "changed" | "aborted"): void => {
			if (settled) return;
			settled = true;
			cleanup();
			done.resolve(result);
		};
		const resolveChanged = (): void => settle("changed");
		const onAbort = (): void => settle("aborted");

		waiters.add(resolveChanged);
		signal.addEventListener("abort", onAbort, { once: true });
		return done.promise;
	}

	close(): void {
		this.#unsubscribe();
		for (const waiters of this.#waiters.values()) {
			for (const resolve of waiters) resolve();
		}
		this.#waiters.clear();
	}

	#wake(generation: number): void {
		for (const [waitingFor, waiters] of [...this.#waiters]) {
			if (generation <= waitingFor) continue;
			for (const resolve of [...waiters]) resolve();
		}
	}
}

function resolveRefresherSchedule(
	refresher: AuthBrokerRefresher | undefined,
	serverNowMs: number,
): { wire: RefresherSchedule; nextSweepAt: number } {
	if (!refresher) {
		return {
			wire: {
				enabled: false,
				intervalMs: 0,
				skewMs: 0,
				nextSweepInMs: DISABLED_NEXT_SWEEP_IN_MS,
			},
			nextSweepAt: DISABLED_NEXT_SWEEP_IN_MS,
		};
	}
	const schedule: AuthBrokerRefresherSchedule = refresher.getSchedule();
	return {
		wire: {
			enabled: schedule.enabled,
			intervalMs: schedule.intervalMs,
			skewMs: schedule.skewMs,
			nextSweepInMs: Math.max(0, schedule.nextSweepAt - serverNowMs),
		},
		nextSweepAt: schedule.nextSweepAt,
	};
}

function computeRotatesInMs(
	entry: { credential: { type: string; expires?: number } },
	schedule: RefresherSchedule,
	nextSweepAt: number,
	serverNowMs: number,
): number | null {
	if (!schedule.enabled || entry.credential.type !== "oauth") return null;
	const expires = entry.credential.expires;
	if (typeof expires !== "number" || !Number.isFinite(expires)) return null;
	if (!Number.isFinite(nextSweepAt) || !Number.isFinite(schedule.intervalMs) || schedule.intervalMs <= 0) return null;

	const dueAt = expires - schedule.skewMs;
	const eligibleAt = Math.max(serverNowMs, dueAt);
	if (dueAt <= serverNowMs && nextSweepAt <= serverNowMs) return 0;
	if (nextSweepAt >= eligibleAt) return Math.max(0, nextSweepAt - serverNowMs);
	const steps = Math.ceil((eligibleAt - nextSweepAt) / schedule.intervalMs);
	const rotatesAt = nextSweepAt + steps * schedule.intervalMs;
	return Math.max(0, rotatesAt - serverNowMs);
}

function buildSnapshot(storage: AuthStorage, refresher: AuthBrokerRefresher | undefined): SnapshotResponse {
	const serverNowMs = Date.now();
	const base = storage.exportSnapshot();
	const { wire, nextSweepAt } = resolveRefresherSchedule(refresher, serverNowMs);
	const credentials: SnapshotEntry[] = base.credentials.map(entry => ({
		...entry,
		rotatesInMs: computeRotatesInMs(entry, wire, nextSweepAt, serverNowMs),
	}));
	return {
		generation: base.generation,
		generatedAt: base.generatedAt,
		serverNowMs,
		refresher: wire,
		credentials,
	};
}

async function serveSnapshot(
	req: Request,
	url: URL,
	storage: AuthStorage,
	gate: GenerationGate,
	refresher: AuthBrokerRefresher | undefined,
	peer: string,
): Promise<Response> {
	await storage.reload();
	let currentGeneration = storage.getGeneration();
	const clientGeneration = parseGenerationTag(req.headers.get("if-none-match"));
	const waitMs = parseWaitMs(url);

	if (clientGeneration === undefined || currentGeneration !== clientGeneration || waitMs <= 0) {
		const body = buildSnapshot(storage, refresher);
		logger.info("auth-broker snapshot served", {
			peer,
			credentials: body.credentials.length,
			generation: body.generation,
		});
		return json(200, body, snapshotHeaders(body.generation));
	}

	const delay = delayResult(waitMs);
	const waitController = new AbortController();
	const waitSignal = AbortSignal.any([req.signal, waitController.signal]);
	const result = await Promise.race([gate.waitForChange(clientGeneration, waitSignal), delay.promise]);
	delay.cancel();
	waitController.abort();
	if (result === "aborted" || req.signal.aborted) return empty(499, snapshotHeaders(currentGeneration));

	await storage.reload();
	currentGeneration = storage.getGeneration();
	if (currentGeneration !== clientGeneration) {
		const body = buildSnapshot(storage, refresher);
		logger.info("auth-broker snapshot long-poll changed", {
			peer,
			credentials: body.credentials.length,
			generation: body.generation,
		});
		return json(200, body, snapshotHeaders(body.generation));
	}

	logger.info("auth-broker snapshot long-poll unchanged", { peer, generation: currentGeneration });
	return empty(304, snapshotHeaders(currentGeneration));
}

/**
 * Stable per-credential fingerprint for SSE delta detection. Field order is
 * fixed by this serializer (NOT by entry insertion order) so a credential
 * built by two different paths still produces the same fingerprint.
 *
 * `rotatesInMs` is intentionally part of the fingerprint: when it shifts we
 * want the client to recompute its `prepareForRequest` deadline rather than
 * keep the stale projection.
 */
function fingerprintEntry(entry: SnapshotEntry): string {
	return JSON.stringify([entry.id, entry.provider, entry.identityKey, entry.rotatesInMs, entry.credential]);
}

function sseEvent(event: string, body: unknown): string {
	return `event: ${event}\ndata: ${JSON.stringify(body)}\n\n`;
}

function serveSnapshotStream(
	req: Request,
	storage: AuthStorage,
	refresher: AuthBrokerRefresher | undefined,
	peer: string,
	keepaliveMs: number,
): Response {
	const encoder = new TextEncoder();
	const openedAt = Date.now();
	const lastByCredId = new Map<number, string>();
	let controller: ReadableStreamDefaultController<Uint8Array> | null = null;
	let unsubscribe: (() => void) | null = null;
	let keepaliveTimer: NodeJS.Timeout | undefined;
	let abortHandler: (() => void) | null = null;
	let processing = false;
	let pendingBumps = 0;
	let closed = false;
	let lastGeneration = -1;

	const cleanup = (): void => {
		if (closed) return;
		closed = true;
		if (keepaliveTimer !== undefined) {
			clearInterval(keepaliveTimer);
			keepaliveTimer = undefined;
		}
		if (unsubscribe) {
			unsubscribe();
			unsubscribe = null;
		}
		if (abortHandler) {
			req.signal.removeEventListener("abort", abortHandler);
			abortHandler = null;
		}
		try {
			controller?.close();
		} catch {
			// Already closed by Bun on client disconnect; harmless.
		}
		logger.info("auth-broker stream closed", { peer, durationMs: Date.now() - openedAt });
	};

	const write = (chunk: string): boolean => {
		if (closed || !controller) return false;
		try {
			controller.enqueue(encoder.encode(chunk));
			return true;
		} catch (err) {
			logger.debug("auth-broker stream enqueue failed", { peer, error: String(err) });
			cleanup();
			return false;
		}
	};

	const processGenerationBump = async (): Promise<void> => {
		if (closed) return;
		if (processing) {
			pendingBumps += 1;
			return;
		}
		processing = true;
		try {
			do {
				pendingBumps = 0;
				await storage.reload();
				if (closed) return;
				const snapshot = buildSnapshot(storage, refresher);
				// Generation must move forward; a duplicate listener firing without a
				// real bump is a no-op below (fingerprints unchanged).
				if (snapshot.generation < lastGeneration) {
					logger.warn("auth-broker stream generation went backwards", {
						peer,
						previous: lastGeneration,
						current: snapshot.generation,
					});
				}
				lastGeneration = snapshot.generation;
				const seenIds = new Set<number>();
				for (const entry of snapshot.credentials) {
					seenIds.add(entry.id);
					const fp = fingerprintEntry(entry);
					if (lastByCredId.get(entry.id) === fp) continue;
					lastByCredId.set(entry.id, fp);
					const payload: SnapshotStreamEntryEvent = {
						kind: "entry",
						generation: snapshot.generation,
						serverNowMs: snapshot.serverNowMs,
						refresher: snapshot.refresher,
						entry,
					};
					if (!write(sseEvent("entry", payload))) return;
					logger.debug("auth-broker stream entry", {
						peer,
						id: entry.id,
						provider: entry.provider,
						generation: snapshot.generation,
					});
				}
				for (const id of [...lastByCredId.keys()]) {
					if (seenIds.has(id)) continue;
					lastByCredId.delete(id);
					const payload: SnapshotStreamRemovedEvent = {
						kind: "removed",
						generation: snapshot.generation,
						serverNowMs: snapshot.serverNowMs,
						refresher: snapshot.refresher,
						id,
					};
					if (!write(sseEvent("removed", payload))) return;
					logger.debug("auth-broker stream removed", { peer, id, generation: snapshot.generation });
				}
			} while (pendingBumps > 0 && !closed);
		} finally {
			processing = false;
		}
	};

	const stream = new ReadableStream<Uint8Array>({
		async start(c) {
			controller = c;
			await storage.reload();
			const initial = buildSnapshot(storage, refresher);
			lastGeneration = initial.generation;
			for (const entry of initial.credentials) lastByCredId.set(entry.id, fingerprintEntry(entry));
			const initialEvent: SnapshotStreamSnapshotEvent = { kind: "snapshot", ...initial };
			if (!write(sseEvent("snapshot", initialEvent))) return;
			keepaliveTimer = setInterval(() => {
				write(": keepalive\n\n");
			}, keepaliveMs);
			keepaliveTimer.unref?.();
			unsubscribe = storage.onGenerationChanged(() => {
				void processGenerationBump();
			});
			abortHandler = (): void => cleanup();
			req.signal.addEventListener("abort", abortHandler);
			logger.info("auth-broker stream opened", { peer, generation: initial.generation });
		},
		cancel() {
			cleanup();
		},
	});

	return new Response(stream, {
		status: 200,
		headers: {
			"Content-Type": "text/event-stream; charset=utf-8",
			"Cache-Control": "no-cache",
			Connection: "keep-alive",
			"X-Accel-Buffering": "no",
		},
	});
}

/** Boot the broker. Caller owns lifecycle; `handle.close()` to stop. */
export function startAuthBroker(opts: AuthBrokerServerOptions): AuthBrokerServerHandle {
	const bind = parseBind(opts.bind ?? DEFAULT_AUTH_BROKER_BIND);
	const tokens = new Set<string>(opts.bearerTokens);
	const version = opts.version;
	const streamKeepaliveMs = opts.streamKeepaliveMs ?? DEFAULT_STREAM_KEEPALIVE_MS;

	const refresher = opts.disableRefresher
		? undefined
		: new AuthBrokerRefresher({
				storage: opts.storage,
				refreshSkewMs: opts.refreshSkewMs ?? DEFAULT_REFRESH_SKEW_MS,
				refreshIntervalMs: opts.refreshIntervalMs ?? DEFAULT_REFRESH_INTERVAL_MS,
			});
	refresher?.start();
	const generationGate = new GenerationGate(opts.storage);

	const server = Bun.serve({
		hostname: bind.hostname,
		port: bind.port,
		idleTimeout: DEFAULT_SERVER_IDLE_TIMEOUT_S,
		fetch: async (req): Promise<Response> => {
			const url = new URL(req.url);
			const pathname = url.pathname;
			const peer =
				req.headers.get("x-forwarded-for")?.split(",")[0].trim() || req.headers.get("x-real-ip") || "unknown";
			try {
				if (req.method === "GET" && pathname === "/v1/healthz") {
					const body: HealthzResponse = { ok: true, version };
					return json(200, body);
				}
				if (!isAuthorized(req, tokens)) {
					logger.info("auth-broker request unauthorized", { method: req.method, path: pathname, peer });
					return json(401, { error: "unauthorized" });
				}
				if (req.method === "GET" && pathname === "/v1/snapshot/stream") {
					return serveSnapshotStream(req, opts.storage, refresher, peer, streamKeepaliveMs);
				}
				if (req.method === "GET" && pathname === "/v1/snapshot") {
					return serveSnapshot(req, url, opts.storage, generationGate, refresher, peer);
				}
				if (req.method === "GET" && pathname === "/v1/usage") {
					try {
						// AuthStorage caches usage reports internally with a 5-minute per-credential
						// TTL (USAGE_REPORT_TTL_MS) so back-to-back widget polls re-use the
						// last fetch instead of hitting provider endpoints repeatedly.
						// `req.signal` propagates HTTP-client disconnects all the way to the
						// per-caller cancel without touching the shared upstream fetch.
						const reports = (await opts.storage.fetchUsageReports?.({ signal: req.signal })) ?? [];
						// Drop the `raw` field — it's the provider-specific upstream body,
						// large and unstable. Everything UI-relevant lives in `limits` and
						// `metadata`.
						const trimmed = reports.map(({ raw: _raw, ...rest }) => rest);
						logger.info("auth-broker usage served", { peer, reports: trimmed.length });
						return json(200, { generatedAt: Date.now(), reports: trimmed });
					} catch (error) {
						const message = error instanceof Error ? error.message : String(error);
						logger.warn("auth-broker usage fetch failed", { peer, error: message });
						return json(502, { error: message });
					}
				}
				const refreshMatch = req.method === "POST" ? pathname.match(REFRESH_ROUTE) : null;
				if (refreshMatch) {
					const id = Number.parseInt(refreshMatch[1], 10);
					try {
						const entry = await opts.storage.refreshCredentialById(id, req.signal);
						const body: CredentialRefreshResponse = { entry };
						logger.info("auth-broker credential refreshed", {
							id,
							provider: entry.provider,
							peer,
							expires: entry.credential.type === "oauth" ? entry.credential.expires : undefined,
						});
						return json(200, body);
					} catch (error) {
						const message = error instanceof Error ? error.message : String(error);
						logger.warn("auth-broker refresh failed", { id, peer, error: message });
						const status = message.includes("No credential with id") ? 404 : 500;
						return json(status, { error: message });
					}
				}
				const disableMatch = req.method === "POST" ? pathname.match(DISABLE_ROUTE) : null;
				if (disableMatch) {
					const id = Number.parseInt(disableMatch[1], 10);
					const parsed = await parseBody(req, credentialDisableRequestSchema, { allowEmpty: true });
					if (!parsed.ok) return parsed.response;
					const cause =
						parsed.data.cause && parsed.data.cause.length > 0 ? parsed.data.cause : "disabled via auth-broker";
					const ok = opts.storage.disableCredentialById(id, cause);
					if (!ok) {
						logger.info("auth-broker disable miss", { id, peer, cause });
						return json(404, { error: `No credential with id=${id}` });
					}
					logger.info("auth-broker credential disabled", { id, peer, cause });
					const response: CredentialDisableResponse = { ok: true };
					return json(200, response);
				}
				if (req.method === "POST" && pathname === "/v1/credential/if-absent") {
					const parsed = await parseBody(req, credentialUploadRequestSchema);
					if (!parsed.ok) return parsed.response;
					const { provider, credential } = parsed.data;
					try {
						const result = await opts.storage.importCredentialIfAbsent(provider, credential);
						logger.info("auth-broker credential import-if-absent", {
							provider,
							type: credential.type,
							inserted: result.inserted,
							reason: result.reason,
							providerTotal: result.entries.length,
							peer,
						});
						const response: CredentialIfAbsentUploadResponse = {
							inserted: result.inserted,
							reason: result.reason,
							entries: result.entries,
						};
						return json(200, response);
					} catch (error) {
						const message = error instanceof Error ? error.message : String(error);
						logger.warn("auth-broker upload-if-absent failed", { provider, type: credential.type, peer });
						return json(500, { error: message });
					}
				}
				if (req.method === "POST" && pathname === "/v1/credential") {
					const parsed = await parseBody(req, credentialUploadRequestSchema);
					if (!parsed.ok) return parsed.response;
					const { provider, credential } = parsed.data;
					try {
						const entries = opts.storage.upsertCredential(provider, credential);
						const identity =
							credential.type === "oauth"
								? (credential.email ?? credential.accountId ?? credential.projectId ?? "(no identity)")
								: "(api key)";
						logger.info("auth-broker credential upserted", {
							provider,
							type: credential.type,
							identity,
							peer,
							providerTotal: entries.length,
						});
						const response: CredentialUploadResponse = { entries };
						return json(200, response);
					} catch (error) {
						const message = error instanceof Error ? error.message : String(error);
						logger.warn("auth-broker upload failed", { provider, peer, error: message });
						return json(500, { error: message });
					}
				}
				return json(404, { error: `No route: ${req.method} ${pathname}` });
			} catch (error) {
				logger.error("auth-broker handler crashed", {
					method: req.method,
					path: pathname,
					error: String(error),
				});
				return json(500, { error: "internal error" });
			}
		},
	});

	const boundHost = server.hostname ?? bind.hostname;
	const boundPort = server.port ?? bind.port;
	return {
		url: `http://${boundHost}:${boundPort}`,
		port: boundPort,
		hostname: boundHost,
		close: async () => {
			refresher?.stop();
			generationGate.close();
			server.stop(true);
		},
	};
}
