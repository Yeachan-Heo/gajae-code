import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { $credentialEnv } from "@gajae-code/utils/env";
import { withFileLock } from "../config/file-lock";
import { writeCoordinatorAtomic } from "./durability";

/**
 * Opt-in webhook delivery of existing coordinator `watch_events` journal rows
 * (issue #4706). Delivery is a durable outbox keyed by the journal row's stable
 * `id`: each delivered row is recorded once, retried with bounded exponential
 * backoff, and never blocks or rewrites the journal append path.
 */

export interface EventWebhookConfig {
	url: string;
	tokenFile: string | null;
	sessionIds: Set<string> | null;
	timeoutMs: number;
	maxAttempts: number;
}

interface WebhookDeliveryRecord {
	schema_version: 1;
	event_id: string;
	status: "pending" | "delivered" | "failed";
	attempts: number;
	created_at: string;
	updated_at: string;
	last_error: string | null;
}

function isWebhookDeliveryRecord(value: unknown, eventId: string): value is WebhookDeliveryRecord {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
	const record = value as Record<string, unknown>;
	return (
		record.schema_version === 1 &&
		record.event_id === eventId &&
		(record.status === "pending" || record.status === "delivered" || record.status === "failed") &&
		typeof record.attempts === "number" &&
		Number.isSafeInteger(record.attempts) &&
		record.attempts >= 0 &&
		typeof record.created_at === "string" &&
		typeof record.updated_at === "string" &&
		(record.last_error === null || typeof record.last_error === "string")
	);
}

/** Result of one webhook POST attempt; 2xx is ok, anything else carries the reason. */
interface WebhookPostOutcome {
	ok: boolean;
	status: number | null;
	error: string | null;
}

export interface WebhookDelivery {
	/** Called with the exact JSON body to POST and per-attempt request options. */
	post(
		body: string,
		options: { url: string; token: string | null; timeoutMs: number; signal: AbortSignal },
	): Promise<WebhookPostOutcome>;
	/** Test seam: delay between retries; default is `Bun.sleep`. */
	sleep(ms: number): Promise<void>;
	/** Monotonic-ish clock for deadline math; default is `Date.now`. */
	now(): number;
}

/** Default `WebhookDelivery` over `fetch`: POST, 2xx = ok, no redirects, abort on timeout. */
export function createDefaultEventWebhookDelivery(): WebhookDelivery {
	return {
		async post(body, options) {
			const response = await fetch(options.url, {
				method: "POST",
				redirect: "error",
				signal: options.signal,
				headers: {
					"content-type": "application/json",
					...(options.token ? { authorization: `Bearer ${options.token}` } : {}),
				},
				body,
			});
			// Drain the body so the socket is reusable, then treat non-2xx as failure.
			await response.text().catch(() => "");
			if (!response.ok) return { ok: false, status: response.status, error: `http_${response.status}` };
			return { ok: true, status: response.status, error: null };
		},
		sleep: async ms => {
			await Bun.sleep(ms);
		},
		now: () => Date.now(),
	};
}

export const DEFAULT_EVENT_WEBHOOK_TIMEOUT_MS = 5_000;
export const MAX_EVENT_WEBHOOK_TIMEOUT_MS = 30_000;
export const DEFAULT_EVENT_WEBHOOK_MAX_ATTEMPTS = 5;
export const MAX_EVENT_WEBHOOK_MAX_ATTEMPTS = 10;
const WEBHOOK_BACKOFF_BASE_MS = 500;
const WEBHOOK_BACKOFF_CAP_MS = 15_000;
const WEBHOOK_ERROR_CAP = 240;
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "::1", "localhost"]);

/**
 * Trusted-source resolution for the five webhook variables. Egress destination
 * and the token-file path must never come from the caller's cwd `.env` overlay:
 * Bun loads that overlay into `process.env`, so a raw `process.env` read would
 * let any repository select where coordinator journal rows are POSTed.
 * `$credentialEnv` consults only the inherited environment and GJC/user-owned
 * env files, exactly like the crash relay's DSN. Callers that own a fully
 * controlled environment (tests, rendered hermes blocks) pass `explicitEnv`;
 * production entry points must omit it and resolve through the trusted source.
 */
function webhookEnvValue(explicitEnv: NodeJS.ProcessEnv | undefined, name: string): string | undefined {
	const explicit = explicitEnv?.[name]?.trim();
	if (explicit) return explicit;
	return $credentialEnv(name)?.trim() || undefined;
}

// Number.parseInt reads a leading digit prefix ("1.5" -> 1, "1e4" -> 1,
// "10s" -> 10), which would silently turn a timeout into one millisecond or a
// retry budget into a single attempt. Only plain decimal digits count; anything
// else falls back to the default, matching the coordinator policy env values.
function boundedWebhookEnvInt(raw: string | undefined, fallback: number, max: number): number {
	if (raw === undefined || !/^\d+$/.test(raw)) return fallback;
	const parsed = Number.parseInt(raw, 10);
	// An oversized digit string still means "as large as allowed", so it caps.
	return parsed > 0 ? Math.min(parsed, max) : fallback;
}

export function parseEventWebhookConfig(explicitEnv?: NodeJS.ProcessEnv): EventWebhookConfig | null {
	const rawUrl = webhookEnvValue(explicitEnv, "GJC_COORDINATOR_MCP_EVENT_WEBHOOK_URL");
	if (!rawUrl) return null;
	let parsed: URL;
	try {
		parsed = new URL(rawUrl);
	} catch {
		throw new Error("coordinator_event_webhook_url_invalid");
	}
	const hostname = parsed.hostname.replace(/^\[|\]$/g, "").toLowerCase();
	if (parsed.protocol !== "https:" && !(parsed.protocol === "http:" && LOOPBACK_HOSTS.has(hostname)))
		throw new Error("coordinator_event_webhook_url_not_allowed");
	const rawSessions = webhookEnvValue(explicitEnv, "GJC_COORDINATOR_MCP_EVENT_WEBHOOK_SESSION_IDS");
	const sessionIds = rawSessions
		? new Set(
				rawSessions
					.split(",")
					.map(value => value.trim())
					.filter(value => /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/.test(value)),
			)
		: null;
	const tokenFile = webhookEnvValue(explicitEnv, "GJC_COORDINATOR_MCP_EVENT_WEBHOOK_TOKEN_FILE") ?? "";
	if (tokenFile !== "" && !path.isAbsolute(tokenFile)) throw new Error("coordinator_event_webhook_token_file_invalid");
	const timeoutMs = boundedWebhookEnvInt(
		webhookEnvValue(explicitEnv, "GJC_COORDINATOR_MCP_EVENT_WEBHOOK_TIMEOUT_MS"),
		DEFAULT_EVENT_WEBHOOK_TIMEOUT_MS,
		MAX_EVENT_WEBHOOK_TIMEOUT_MS,
	);
	const maxAttempts = boundedWebhookEnvInt(
		webhookEnvValue(explicitEnv, "GJC_COORDINATOR_MCP_EVENT_WEBHOOK_MAX_ATTEMPTS"),
		DEFAULT_EVENT_WEBHOOK_MAX_ATTEMPTS,
		MAX_EVENT_WEBHOOK_MAX_ATTEMPTS,
	);
	return { url: rawUrl, tokenFile: tokenFile || null, sessionIds, timeoutMs, maxAttempts };
}

function eventWebhookScopeApplies(config: EventWebhookConfig, event: { session_id?: string }): boolean {
	return config.sessionIds === null || (event.session_id !== undefined && config.sessionIds.has(event.session_id));
}

function recordPath(namespaceDir: string, eventId: string): string {
	if (!/^[a-zA-Z0-9][a-zA-Z0-9_.:-]*$/.test(eventId)) throw new Error("coordinator_event_webhook_event_id_invalid");
	// Stable IDs can exceed filesystem component limits. The complete identifier
	// remains in the record and this fixed-size digest is only its outbox key.
	const digest = createHash("sha256").update(eventId).digest("hex");
	return path.join(namespaceDir, "webhook-outbox", `${digest}.json`);
}

async function readRecord(file: string, eventId: string): Promise<WebhookDeliveryRecord | null> {
	let source: string;
	try {
		source = await fs.readFile(file, "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
		throw error;
	}
	try {
		const parsed: unknown = JSON.parse(source);
		return isWebhookDeliveryRecord(parsed, eventId) ? parsed : null;
	} catch (error) {
		if (error instanceof SyntaxError) return null;
		throw error;
	}
}

async function writeRecord(file: string, record: WebhookDeliveryRecord): Promise<void> {
	await writeCoordinatorAtomic(file, JSON.stringify(record));
}

function webhookErrorSummary(error: string | null): string | null {
	if (error === null) return null;
	const normalized = error.replace(/[\r\n]+/g, " ").trim();
	return normalized.length > WEBHOOK_ERROR_CAP ? `${normalized.slice(0, WEBHOOK_ERROR_CAP - 3)}...` : normalized;
}

function backoffDelayMs(attempt: number): number {
	return Math.min(WEBHOOK_BACKOFF_BASE_MS * 2 ** (attempt - 1), WEBHOOK_BACKOFF_CAP_MS);
}

async function readWebhookToken(tokenFile: string | null): Promise<string | null> {
	if (tokenFile === null) return null;
	try {
		return (await fs.readFile(tokenFile, "utf8")).trim();
	} catch {
		throw new Error("coordinator_event_webhook_token_file_unreadable");
	}
}

/**
 * Records the row in the durable outbox and, unless the row is already
 * delivered or exhausted, performs one bounded delivery attempt series. The
 * returned promise settles only after bounded attempts/backoff, so a dead sink
 * can never wedge the caller's persistence; callers run it off the append path.
 */
export async function deliverEventWebhook(
	namespaceDir: string,
	config: EventWebhookConfig,
	event: { id: string; session_id?: string },
	renderBody: () => string,
	delivery: WebhookDelivery,
): Promise<void> {
	if (!eventWebhookScopeApplies(config, event)) return;
	const file = recordPath(namespaceDir, event.id);
	return await withFileLock(file, async () => {
		const now0 = delivery.now();
		let record = await readRecord(file, event.id);
		if (record === null) {
			record = {
				schema_version: 1,
				event_id: event.id,
				status: "pending",
				attempts: 0,
				created_at: new Date(now0).toISOString(),
				updated_at: new Date(now0).toISOString(),
				last_error: null,
			};
			await writeRecord(file, record);
		} else if (record.status !== "pending") {
			return;
		}
		const token = await readWebhookToken(config.tokenFile);
		const body = renderBody();
		while (record.attempts < config.maxAttempts) {
			record.attempts += 1;
			const controller = new AbortController();
			const timer = setTimeout(() => controller.abort(), config.timeoutMs);
			timer.unref?.();
			let outcome: WebhookPostOutcome;
			try {
				outcome = await delivery.post(body, {
					url: config.url,
					token,
					timeoutMs: config.timeoutMs,
					signal: controller.signal,
				});
			} catch (error) {
				outcome = { ok: false, status: null, error: error instanceof Error ? error.message : String(error) };
			} finally {
				clearTimeout(timer);
			}
			const ts = new Date(delivery.now()).toISOString();
			record.updated_at = ts;
			record.last_error = outcome.ok ? null : webhookErrorSummary(outcome.error);
			if (outcome.ok) {
				record.status = "delivered";
				await writeRecord(file, record);
				return;
			}
			if (record.attempts >= config.maxAttempts) {
				record.status = "failed";
				await writeRecord(file, record);
				return;
			}
			await writeRecord(file, record);
			await delivery.sleep(backoffDelayMs(record.attempts));
		}
	});
}
