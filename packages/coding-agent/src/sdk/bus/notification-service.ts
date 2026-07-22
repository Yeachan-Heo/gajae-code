/**
 * Shared notification service contract.
 *
 * Transport-agnostic, secret-safe operations consumed by BOTH the `gjc notify`
 * CLI and the cross-mode `/notify` slash command (TUI + ACP). Every result is
 * free of raw secrets: bot tokens are only ever shown masked (`maskToken`) or
 * as a non-reversible fingerprint (`tokenFingerprint`).
 *
 * Daemon-ownership protection: `recoverNotifications` only ever removes
 * artifacts belonging to a DEAD owner (dead-PID / explicitly-stale). It never
 * touches a live owner's lock/state and never kills a process.
 */
import * as crypto from "node:crypto";
import type { WriteFileOptions } from "node:fs";
import * as fsSync from "node:fs";
import * as fsPromises from "node:fs/promises";
import * as path from "node:path";
import * as native from "@gajae-code/natives";
import type { Settings } from "../../config/settings";
import { isProcessIncarnation, processIncarnation } from "../broker/process-incarnation";
import {
	getNotificationConfig,
	isDiscordConfigured,
	isGloballyConfigured,
	isTelegramConfigured,
	maskToken,
	type NotificationConfig,
	tokenFingerprint,
} from "./config";
import { type DaemonPaths, daemonPaths, HEARTBEAT_TTL_MS } from "./daemon-paths";
import { DAEMON_GENERATION } from "./telegram-daemon-contract";

const DEFAULT_API_BASE = "https://api.telegram.org";

/**
 * Telegram bot-token shape: `<digits>:<base64url-ish>`. Used to redact a
 * token-shaped substring from a diagnostic even when the exact configured token
 * is not known to the caller (e.g. a token echoed inside a fetch error URL).
 */
const TELEGRAM_TOKEN_PATTERN = /\d{6,}:[A-Za-z0-9_-]{20,}/g;

/**
 * Strip secrets from a human-facing diagnostic string. Redacts the configured
 * bot token (exact match) and any token-shaped substring so health/test details
 * can never leak a credential regardless of where the string originated.
 */
export function sanitizeDiagnostic(text: string, token?: string): string {
	let out = text;
	const trimmed = token?.trim();
	if (trimmed) out = out.split(trimmed).join("<redacted>");
	return out.replace(TELEGRAM_TOKEN_PATTERN, "<redacted>");
}

/** Identity evidence required to remove precisely the endpoint that was inspected. */
export interface NotificationEndpointFileIdentity {
	dev: bigint;
	ino: bigint;
	size: bigint;
	mtimeNs: bigint;
	sha256: string;
}

export interface NotificationEndpointFile {
	bytes: Buffer;
	identity: NotificationEndpointFileIdentity;
}

export interface NotificationExactUnlinkResult {
	ok: boolean;
	code?: string;
	detachedPath?: string;
	/** A live publisher successor retained after an exact-unlink race. */
	retainedSuccessorPath?: string;
	/** An internal exchange placeholder whose verified cleanup failed. */
	retainedPlaceholderPath?: string;
	/** A cleanup entry whose identity could not be verified after a race. */
	retainedUnknownPath?: string;
}

/** Read one regular file together with the identity required for exact removal. */
export async function readNotificationEndpointFile(file: string): Promise<NotificationEndpointFile> {
	const before = await fsPromises.lstat(file, { bigint: true });
	if (!before.isFile() || before.isSymbolicLink()) throw new Error("Endpoint is not a regular file");
	const noFollow = fsSync.constants.O_NOFOLLOW;
	const handle = await fsPromises.open(file, fsSync.constants.O_RDONLY | (noFollow ?? 0));
	try {
		const opened = await handle.stat({ bigint: true });
		if (!opened.isFile() || !sameEndpointFileMetadata(before, opened))
			throw new Error("Endpoint changed before it was opened");
		const bytes = await handle.readFile();
		const after = await handle.stat({ bigint: true });
		const pathname = await fsPromises.lstat(file, { bigint: true });
		if (
			!after.isFile() ||
			!pathname.isFile() ||
			pathname.isSymbolicLink() ||
			!sameEndpointFileMetadata(opened, after) ||
			!sameEndpointFileMetadata(opened, pathname)
		)
			throw new Error("Endpoint changed while it was read");
		return {
			bytes,
			identity: {
				dev: opened.dev,
				ino: opened.ino,
				size: opened.size,
				mtimeNs: opened.mtimeNs,
				sha256: crypto.createHash("sha256").update(bytes).digest("hex"),
			},
		};
	} finally {
		await handle.close();
	}
}
/** Bump when the native exact-deletion identity contract changes. */
export const NATIVE_PATH_IDENTITY_CONTRACT_VERSION = 1;

export function exactUnlinkNotificationFile(
	file: string,
	identity: NotificationEndpointFileIdentity,
	quarantineName: string,
): NotificationExactUnlinkResult {
	const result = native.exactUnlink(file, { ...identity, quarantineName });
	return {
		ok: result.ok,
		code: result.code,
		detachedPath: result.detachedPath,
		retainedSuccessorPath: result.retainedSuccessorPath,
		retainedPlaceholderPath: result.retainedPlaceholderPath,
		retainedUnknownPath: result.retainedUnknownPath,
	};
}

/** Minimal filesystem surface the service needs; injectable for tests. */
export interface NotificationServiceFs {
	readdir(dir: string): Promise<string[]>;
	readFile(file: string, encoding: "utf8"): Promise<string>;
	readEndpointFile(file: string): Promise<NotificationEndpointFile>;
	exactUnlink(file: string, identity: NotificationEndpointFileIdentity): Promise<NotificationExactUnlinkResult>;
	unlink(file: string): Promise<void>;
	writeFile?(file: string, data: string, opts?: WriteFileOptions): Promise<void>;
	stat?(file: string): Promise<{ mtimeMs: number }>;
}

const nodeServiceFs: NotificationServiceFs = {
	readdir: dir => fsPromises.readdir(dir),
	readFile: (file, encoding) => fsPromises.readFile(file, encoding),
	readEndpointFile: readNotificationEndpointFile,
	exactUnlink: async (file, identity) =>
		exactUnlinkNotificationFile(file, identity, `.gjc-delete-notification-endpoint-${crypto.randomUUID()}.json`),
	unlink: file => fsPromises.unlink(file),
	writeFile: (file, data, opts) => fsPromises.writeFile(file, data, opts),
	stat: file => fsPromises.stat(file),
};

/** Injectable dependencies shared across service operations. */
export interface NotificationServiceDeps {
	fs?: NotificationServiceFs;
	now?: () => number;
	pidAlive?: (pid: number) => boolean;
	fetchImpl?: typeof fetch;
	apiBase?: string;
}

function defaultPidAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (err) {
		// EPERM means the process exists but is owned by another user: still alive.
		return (err as NodeJS.ErrnoException).code === "EPERM";
	}
}

function defaultStateRoot(): string {
	return path.join(process.cwd(), ".gjc", "state");
}

function endpointDir(stateRoot: string): string {
	return path.join(stateRoot, "sdk");
}

// --- status -------------------------------------------------------------

export interface AdapterConfigView {
	botTokenMasked: string;
	channel: string | undefined;
	configured: boolean;
}

export interface NotificationStatusReport {
	enabled: boolean;
	redact: boolean;
	verbosity: "lean" | "verbose";
	globallyConfigured: boolean;
	telegram: AdapterConfigView & { tokenFingerprint: string | undefined };
	discord: AdapterConfigView;
	slack: AdapterConfigView;
}

function adapterConfigured(token: string | undefined, channel: string | undefined): boolean {
	return Boolean(token?.trim()) && Boolean(channel?.trim());
}

/** Build a secret-safe structured status snapshot from settings. */
export function buildNotificationStatusReport(settings: Settings): NotificationStatusReport {
	const cfg = getNotificationConfig(settings);
	return {
		enabled: cfg.enabled,
		redact: cfg.redact,
		verbosity: cfg.verbosity,
		globallyConfigured: isGloballyConfigured(cfg),
		telegram: {
			botTokenMasked: maskToken(cfg.botToken),
			channel: cfg.chatId,
			configured: isTelegramConfigured(cfg),
			tokenFingerprint: cfg.botToken?.trim() ? tokenFingerprint(cfg.botToken) : undefined,
		},
		discord: {
			botTokenMasked: maskToken(cfg.discord.botToken),
			channel: cfg.discord.parentChannelId,
			configured: isDiscordConfigured(cfg),
		},
		slack: {
			botTokenMasked: maskToken(cfg.slack.botToken),
			channel: cfg.slack.channelId,
			configured: adapterConfigured(cfg.slack.botToken, cfg.slack.channelId),
		},
	};
}

/** Render a status report as human-readable lines (no secrets). */
export function formatNotificationStatusReport(report: NotificationStatusReport): string {
	const yesNo = (v: boolean): string => (v ? "yes" : "no");
	return [
		"Notifications",
		`  enabled: ${report.enabled}`,
		`  globally configured: ${yesNo(report.globallyConfigured)}`,
		`  redact: ${report.redact}`,
		`  verbosity: ${report.verbosity}`,
		`  telegram.botToken: ${report.telegram.botTokenMasked}`,
		`  telegram.chatId: ${report.telegram.channel ?? "(unset)"}`,
		`  telegram.fingerprint: ${report.telegram.tokenFingerprint ?? "(unset)"}`,
		`  telegram.configured: ${yesNo(report.telegram.configured)}`,
		`  discord.botToken: ${report.discord.botTokenMasked}`,
		`  discord.parentChannelId: ${report.discord.channel ?? "(unset)"}`,
		`  slack.botToken: ${report.slack.botTokenMasked}`,
		`  slack.channelId: ${report.slack.channel ?? "(unset)"}`,
	].join("\n");
}

// --- endpoint / daemon file readers -------------------------------------

export interface NotificationEndpointView {
	sessionId: string;
	pid: number | undefined;
	stale: boolean;
}

export type NotificationEndpointLiveness = "live" | "dead" | "unknown";

/**
 * Classification used by recovery and startup takeover. A file is an endpoint
 * only when it has endpoint authority fields; lifecycle/audit records are never
 * candidates for endpoint cleanup.
 */
export type NotificationEndpointClassification =
	| {
			kind: "endpoint";
			view: NotificationEndpointView;
			liveness: NotificationEndpointLiveness;
			identity: NotificationEndpointFileIdentity;
	  }
	| { kind: "non-endpoint" }
	| { kind: "unreadable" };

/**
 * Classify an endpoint using owner-proof semantics. An endpoint is only `dead`
 * with positive proof: an explicit `stale` tombstone, or a recorded pid that is
 * confirmed not alive. A PID-less endpoint is `unknown` (not provably dead) and
 * must never be treated as dead — removing it could delete a live session's
 * discovery file that simply omitted a pid.
 */
export function notificationEndpointLiveness(
	view: NotificationEndpointView,
	pidAlive: (pid: number) => boolean,
): NotificationEndpointLiveness {
	if (view.stale) return "dead";
	if (view.pid === undefined) return "unknown";
	return pidAlive(view.pid) ? "live" : "dead";
}

function sameEndpointFileMetadata(
	left: { dev: bigint; ino: bigint; size: bigint; mtimeNs: bigint },
	right: { dev: bigint; ino: bigint; size: bigint; mtimeNs: bigint },
): boolean {
	return (
		left.dev === right.dev && left.ino === right.ino && left.size === right.size && left.mtimeNs === right.mtimeNs
	);
}

function isLifecycleArtifact(record: Record<string, unknown>): boolean {
	const keys = Object.keys(record);
	const isEffectMarker =
		typeof record.pid === "number" &&
		Number.isSafeInteger(record.pid) &&
		record.pid > 0 &&
		typeof record.effectMarker === "string" &&
		record.effectMarker.length > 0 &&
		typeof record.incarnation === "string" &&
		record.incarnation.length > 0;
	if (isEffectMarker && keys.length === 3) return true;
	return (
		isEffectMarker &&
		typeof record.phase === "string" &&
		typeof record.reason === "string" &&
		typeof record.message === "string" &&
		typeof record.rollback === "object" &&
		record.rollback !== null
	);
}
function isCanonicalLifecycleArtifactName(name: string): boolean {
	return (
		name.endsWith(".lifecycle.json") ||
		name.endsWith(".lifecycle.ready.json") ||
		/^.+\.lifecycle\.failure\.[A-Za-z0-9._-]{1,128}\.json$/.test(name)
	);
}

function unreadableEndpointResult(file: string): NotificationEndpointClassification {
	return isCanonicalLifecycleArtifactName(path.basename(file)) ? { kind: "non-endpoint" } : { kind: "unreadable" };
}

/**
 * Read and classify one endpoint candidate. The returned identity belongs to
 * exactly the bytes inspected and is required for any later deletion.
 */
export async function classifyNotificationEndpoint(
	fs: Pick<NotificationServiceFs, "readEndpointFile">,
	file: string,
	pidAlive: (pid: number) => boolean,
): Promise<NotificationEndpointClassification> {
	let endpoint: NotificationEndpointFile;
	let raw: string;
	try {
		endpoint = await fs.readEndpointFile(file);
		raw = endpoint.bytes.toString("utf8");
	} catch {
		return unreadableEndpointResult(file);
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		return unreadableEndpointResult(file);
	}
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return { kind: "non-endpoint" };
	if (path.basename(file) === "broker.json") return { kind: "non-endpoint" };
	const rec = parsed as Record<string, unknown>;
	if (isLifecycleArtifact(rec) || typeof rec.url !== "string" || typeof rec.token !== "string")
		return { kind: "non-endpoint" };
	const view: NotificationEndpointView = {
		sessionId: typeof rec.sessionId === "string" ? rec.sessionId : path.basename(file, ".json"),
		pid: safePositiveInteger(rec.pid),
		stale: rec.stale === true,
	};
	return {
		kind: "endpoint",
		view,
		liveness: notificationEndpointLiveness(view, pidAlive),
		identity: endpoint.identity,
	};
}

interface NormalizedDaemonState {
	pid: number;
	ownerId: string;
	tokenFingerprint: string | undefined;
	chatId: string | undefined;
	startedAt: number | undefined;
	heartbeatAt: number | undefined;
	stoppedAt: number | undefined;
	roots: string[] | undefined;
	generation: number | undefined;
	generationStatus: "missing" | "valid" | "invalid";
}

function finiteNonNegativeNumber(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function safePositiveInteger(value: unknown): number | undefined {
	return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

function safeNonNegativeInteger(value: unknown): number | undefined {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

function stringArray(value: unknown): string[] | undefined {
	return Array.isArray(value) && value.every(item => typeof item === "string") ? value : undefined;
}

function parseDaemonState(raw: string): NormalizedDaemonState | undefined {
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		return undefined;
	}
	if (!parsed || typeof parsed !== "object") return undefined;
	const rec = parsed as Record<string, unknown>;
	const pid = safePositiveInteger(rec.pid);
	if (pid === undefined || typeof rec.ownerId !== "string" || rec.ownerId.length === 0) return undefined;

	const generation = safeNonNegativeInteger(rec.generation);
	const generationStatus = !Object.hasOwn(rec, "generation")
		? "missing"
		: generation === undefined
			? "invalid"
			: "valid";
	return {
		pid,
		ownerId: rec.ownerId,
		tokenFingerprint: typeof rec.tokenFingerprint === "string" ? rec.tokenFingerprint : undefined,
		chatId: typeof rec.chatId === "string" ? rec.chatId : undefined,
		startedAt: finiteNonNegativeNumber(rec.startedAt),
		heartbeatAt: finiteNonNegativeNumber(rec.heartbeatAt),
		stoppedAt: finiteNonNegativeNumber(rec.stoppedAt),
		roots: stringArray(rec.roots),
		generation,
		generationStatus,
	};
}

async function readDaemonStateFile(
	fs: NotificationServiceFs,
	file: string,
): Promise<NormalizedDaemonState | undefined> {
	try {
		return parseDaemonState(await fs.readFile(file, "utf8"));
	} catch {
		return undefined;
	}
}

function isSharedSdkArtifact(name: string): boolean {
	return name === "broker.json";
}

async function listEndpointFiles(fs: NotificationServiceFs, dir: string): Promise<string[]> {
	try {
		return (await fs.readdir(dir)).filter(name => name.endsWith(".json") && !isSharedSdkArtifact(name));
	} catch {
		return [];
	}
}

// --- health -------------------------------------------------------------

export type HealthLevel = "ok" | "warn" | "error";

export interface HealthCheck {
	name: string;
	level: HealthLevel;
	detail: string;
}

export interface DaemonHealth {
	present: boolean;
	ownerId: string | undefined;
	pid: number | undefined;
	alive: boolean;
	heartbeatFresh: boolean;
	identityMatches: boolean;
	stopped: boolean;
	heartbeatAt: number | undefined;
	heartbeatAgeMs: number | undefined;
	generation: number | undefined;
	currentGeneration: number;
	generationRelation: DaemonGenerationRelation;
}

export type DaemonGenerationRelation = "pre_generation" | "older" | "current" | "newer" | "unknown";

function daemonGenerationRelation(state: NormalizedDaemonState | undefined): DaemonGenerationRelation {
	if (!state) return "unknown";
	if (state.generationStatus === "missing") return "pre_generation";
	if (state.generation === undefined) return "unknown";
	if (state.generation < DAEMON_GENERATION) return "older";
	if (state.generation === DAEMON_GENERATION) return "current";
	return "newer";
}

function displayHeartbeatAgeMs(now: number, heartbeatAt: number): number | undefined {
	const age = now - heartbeatAt;
	return Number.isFinite(age) ? Math.max(0, age) : undefined;
}
export interface EndpointHealth {
	total: number;
	live: number;
	dead: number;
	unknown: number;
	unreadable: number;
}

export interface NotificationHealthReport {
	overall: HealthLevel;
	configured: boolean;
	checks: HealthCheck[];
	daemon: DaemonHealth;
	endpoints: EndpointHealth;
	reachability: { probed: boolean; ok: boolean; detail: string };
}

export interface HealthOptions {
	settings: Settings;
	stateRoot?: string;
	deps?: NotificationServiceDeps;
	/** When true and Telegram is configured, probe the Bot API (getMe) for reachability. */
	probe?: boolean;
}

async function probeTelegramReachability(
	fetchImpl: typeof fetch,
	apiBase: string,
	token: string,
): Promise<{ ok: boolean; detail: string }> {
	try {
		const response = await fetchImpl(`${apiBase.replace(/\/$/, "")}/bot${token}/getMe`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: "{}",
		});
		const payload = (await response.json().catch(() => undefined)) as
			| { ok?: boolean; description?: string; result?: { username?: string } }
			| undefined;
		if (response.ok && payload?.ok) {
			const username = payload.result?.username;
			return { ok: true, detail: username ? `reachable as @${username}` : "reachable" };
		}
		return {
			ok: false,
			detail: sanitizeDiagnostic(payload?.description ?? `Telegram getMe failed (HTTP ${response.status})`, token),
		};
	} catch (err) {
		return { ok: false, detail: sanitizeDiagnostic(err instanceof Error ? err.message : "network error", token) };
	}
}

function worst(a: HealthLevel, b: HealthLevel): HealthLevel {
	const rank: Record<HealthLevel, number> = { ok: 0, warn: 1, error: 2 };
	return rank[a] >= rank[b] ? a : b;
}

/** Structural (offline-by-default) health of the notification subsystem. */
export async function checkNotificationHealth(opts: HealthOptions): Promise<NotificationHealthReport> {
	const deps = opts.deps ?? {};
	const fs = deps.fs ?? nodeServiceFs;
	const now = (deps.now ?? Date.now)();
	const pidAlive = deps.pidAlive ?? defaultPidAlive;
	const stateRoot = opts.stateRoot ?? defaultStateRoot();

	const cfg: NotificationConfig = getNotificationConfig(opts.settings);
	const configured = isGloballyConfigured(cfg);
	const telegramConfigured = isTelegramConfigured(cfg);
	const checks: HealthCheck[] = [];

	if (!cfg.enabled) {
		checks.push({
			name: "config",
			level: "warn",
			detail: "notifications are disabled (notifications.enabled=false)",
		});
	} else if (!configured) {
		checks.push({ name: "config", level: "warn", detail: "no notification adapter is fully configured" });
	} else {
		checks.push({ name: "config", level: "ok", detail: "enabled with at least one configured adapter" });
	}

	// Daemon ownership state (offline; read the persisted state file directly).
	const paths = daemonPaths(opts.settings.getAgentDir());
	const state = await readDaemonStateFile(fs, paths.state);
	const heartbeatAt = state?.heartbeatAt;
	const daemon: DaemonHealth = {
		present: Boolean(state),
		ownerId: state?.ownerId,
		pid: state?.pid,
		alive: state ? pidAlive(state.pid) : false,
		heartbeatFresh: heartbeatAt !== undefined ? now - heartbeatAt <= HEARTBEAT_TTL_MS : false,
		identityMatches:
			Boolean(state) &&
			telegramConfigured &&
			state?.tokenFingerprint === tokenFingerprint(cfg.botToken) &&
			state?.chatId === cfg.chatId,
		stopped: state?.stoppedAt !== undefined,
		heartbeatAt,
		heartbeatAgeMs: heartbeatAt === undefined ? undefined : displayHeartbeatAgeMs(now, heartbeatAt),
		generation: state?.generation,
		currentGeneration: DAEMON_GENERATION,
		generationRelation: daemonGenerationRelation(state),
	};
	if (!state) {
		checks.push({ name: "daemon", level: "ok", detail: "no daemon ownership record (none running)" });
	} else if (!daemon.alive) {
		checks.push({
			name: "daemon",
			level: "warn",
			detail: `daemon owner pid ${daemon.pid} is not alive; run recovery to clear the stale lock`,
		});
	} else if (!daemon.heartbeatFresh) {
		checks.push({ name: "daemon", level: "warn", detail: `daemon pid ${daemon.pid} heartbeat is stale` });
	} else if (telegramConfigured && !daemon.identityMatches) {
		checks.push({
			name: "daemon",
			level: "warn",
			detail: "a live daemon owns a different bot token or chat id",
		});
	} else {
		checks.push({ name: "daemon", level: "ok", detail: `daemon pid ${daemon.pid} alive with a fresh heartbeat` });
	}

	// Per-session endpoint discovery files.
	const dir = endpointDir(stateRoot);
	const files = await listEndpointFiles(fs, dir);
	let live = 0;
	let dead = 0;
	let unknownEndpoints = 0;
	let unreadable = 0;
	for (const name of files) {
		const record = await classifyNotificationEndpoint(fs, path.join(dir, name), pidAlive);
		if (record.kind === "non-endpoint") continue;
		if (record.kind === "unreadable") {
			unreadable += 1;
			continue;
		}
		switch (record.liveness) {
			case "live":
				live += 1;
				break;
			case "dead":
				dead += 1;
				break;
			default:
				unknownEndpoints += 1;
				break;
		}
	}
	const endpoints: EndpointHealth = {
		total: live + dead + unknownEndpoints + unreadable,
		live,
		dead,
		unknown: unknownEndpoints,
		unreadable,
	};
	if (dead > 0 || unreadable > 0) {
		checks.push({
			name: "endpoints",
			level: "warn",
			detail: `${dead} dead / ${unreadable} unreadable of ${endpoints.total} endpoint file(s); run recovery`,
		});
	} else {
		checks.push({
			name: "endpoints",
			level: "ok",
			detail: `${live} live, ${unknownEndpoints} unverified endpoint file(s)`,
		});
	}
	if (
		telegramConfigured &&
		daemon.present &&
		daemon.alive &&
		daemon.heartbeatFresh &&
		daemon.identityMatches &&
		!daemon.stopped &&
		endpoints.total === 0
	) {
		checks.push({
			name: "local_endpoint",
			level: "warn",
			detail:
				"No local notification endpoint for this working directory. In this GJC terminal run /notify on; if it does not report notifications enabled, start a new local GJC session. Do not re-pair Telegram.",
		});
	}

	// Optional network reachability probe.
	let reachability = { probed: false, ok: false, detail: "not probed" };
	if (opts.probe && telegramConfigured) {
		const result = await probeTelegramReachability(
			deps.fetchImpl ?? globalThis.fetch,
			deps.apiBase ?? DEFAULT_API_BASE,
			cfg.botToken,
		);
		reachability = { probed: true, ...result };
		checks.push({
			name: "reachability",
			level: result.ok ? "ok" : "error",
			detail: `Telegram: ${result.detail}`,
		});
	}

	const overall = checks.reduce<HealthLevel>((acc, check) => worst(acc, check.level), "ok");
	return { overall, configured, checks, daemon, endpoints, reachability };
}

/** Render a health report as human-readable lines (no secrets). */
export function formatNotificationHealthReport(report: NotificationHealthReport): string {
	const icon: Record<HealthLevel, string> = { ok: "[ok]", warn: "[warn]", error: "[error]" };
	const lines = [`Notification health: ${report.overall.toUpperCase()}`];
	for (const check of report.checks) {
		lines.push(`  ${icon[check.level]} ${check.name}: ${check.detail}`);
	}
	return lines.join("\n");
}

// --- test ---------------------------------------------------------------

export interface NotificationTestResult {
	ok: boolean;
	adapter: "telegram";
	chatId: string | undefined;
	detail: string;
}

export interface TestOptions {
	settings: Settings;
	deps?: NotificationServiceDeps;
	text?: string;
}

/** Send a one-off test notification through the configured Telegram adapter. */
export async function sendNotificationTest(opts: TestOptions): Promise<NotificationTestResult> {
	const deps = opts.deps ?? {};
	const cfg = getNotificationConfig(opts.settings);
	if (!isTelegramConfigured(cfg)) {
		return {
			ok: false,
			adapter: "telegram",
			chatId: cfg.chatId,
			detail: "Telegram is not configured (need notifications.enabled + botToken + chatId). Run `gjc notify setup`.",
		};
	}
	const fetchImpl = deps.fetchImpl ?? globalThis.fetch;
	const apiBase = (deps.apiBase ?? DEFAULT_API_BASE).replace(/\/$/, "");
	const text = opts.text ?? "GJC notifications test message. If you can read this, delivery works.";
	try {
		const response = await fetchImpl(`${apiBase}/bot${cfg.botToken}/sendMessage`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ chat_id: cfg.chatId, text }),
		});
		const payload = (await response.json().catch(() => undefined)) as
			| { ok?: boolean; description?: string }
			| undefined;
		if (response.ok && payload?.ok) {
			return { ok: true, adapter: "telegram", chatId: cfg.chatId, detail: `delivered to chat ${cfg.chatId}` };
		}
		return {
			ok: false,
			adapter: "telegram",
			chatId: cfg.chatId,
			detail: sanitizeDiagnostic(
				payload?.description ?? `Telegram sendMessage failed (HTTP ${response.status})`,
				cfg.botToken,
			),
		};
	} catch (err) {
		return {
			ok: false,
			adapter: "telegram",
			chatId: cfg.chatId,
			detail: sanitizeDiagnostic(err instanceof Error ? err.message : "network error", cfg.botToken),
		};
	}
}

/** Render a test result as a single human-readable line (no secrets). */
export function formatNotificationTestResult(result: NotificationTestResult): string {
	return `Notification test (${result.adapter}): ${result.ok ? "OK" : "FAILED"} — ${result.detail}`;
}

// --- recovery -----------------------------------------------------------

export interface RecoveredEndpoint {
	sessionId: string;
	pid: number | undefined;
	reason: "stale-flag" | "dead-pid";
}

export type DaemonRecoveryAction =
	| "none"
	| "cleared-dead-owner-lock"
	| "left-active"
	| "left-contended"
	| "owner-superseded"
	| "orphan-lock-left";

export interface NotificationRecoveryReport {
	endpointsScanned: number;
	endpointsRemoved: RecoveredEndpoint[];
	endpointsKept: number;
	endpointsUnreadable: number;
	endpointsDetached?: string[];
	/** Successor paths retained after an exact-unlink race, distinct from stale quarantines. */
	endpointsRetainedSuccessors?: string[];
	/** Internal exchange placeholders retained after verified cleanup failure. */
	endpointsRetainedPlaceholders?: string[];
	/** Cleanup entries retained with unverified or mismatching identity. */
	endpointsRetainedUnknown?: string[];
	daemon: {
		action: DaemonRecoveryAction;
		detail: string;
		ownerId: string | undefined;
		pid: number | undefined;
	};
}

export interface RecoveryOptions {
	settings: Settings;
	stateRoot?: string;
	deps?: NotificationServiceDeps;
}

export interface DaemonTransitionLock {
	pid: number;
	incarnation: string;
	createdAt: number;
	/** Unique fencing generation for this particular transition acquisition. */
	token: string;
}

function isDaemonTransitionLock(value: unknown): value is DaemonTransitionLock {
	if (!value || typeof value !== "object") return false;
	const candidate = value as Record<string, unknown>;
	return (
		Number.isSafeInteger(candidate.pid) &&
		(candidate.pid as number) > 0 &&
		typeof candidate.incarnation === "string" &&
		typeof candidate.createdAt === "number" &&
		typeof candidate.token === "string" &&
		candidate.token.length > 0
	);
}

interface TransitionMarkerSnapshot {
	raw: string;
	identity?: NotificationEndpointFileIdentity;
}

type TransitionMarkerFs = {
	readFile(file: string, encoding: "utf8"): Promise<string>;
	writeFile?(file: string, data: string, opts?: WriteFileOptions): Promise<void>;
	readEndpointFile?(file: string): Promise<NotificationEndpointFile>;
	exactUnlink?(file: string, identity: NotificationEndpointFileIdentity): Promise<NotificationExactUnlinkResult>;
};

async function readTransitionMarker(
	fs: TransitionMarkerFs,
	path: string,
): Promise<TransitionMarkerSnapshot | undefined> {
	if (fs.readEndpointFile) {
		const exact = await fs.readEndpointFile(path).catch(() => undefined);
		if (!exact) return undefined;
		return { raw: exact.bytes.toString("utf8"), identity: exact.identity };
	}
	const raw = await fs.readFile(path, "utf8").catch(() => undefined);
	if (raw === undefined) return undefined;
	return { raw };
}

function transitionMarkerMatchesLock(snapshot: TransitionMarkerSnapshot, lock: DaemonTransitionLock): boolean {
	try {
		const current = JSON.parse(snapshot.raw);
		return (
			isDaemonTransitionLock(current) &&
			current.pid === lock.pid &&
			current.incarnation === lock.incarnation &&
			current.token === lock.token
		);
	} catch {
		return false;
	}
}

/** True only while the exact transition acquisition still occupies the marker path. */
export async function daemonTransitionLockIsHeld(input: {
	fs: Pick<TransitionMarkerFs, "readFile" | "readEndpointFile">;
	path: string;
	lock: DaemonTransitionLock;
}): Promise<boolean> {
	const snapshot = await readTransitionMarker(input.fs, input.path);
	return Boolean(snapshot && transitionMarkerMatchesLock(snapshot, input.lock));
}

/** Atomically detaches only the captured transition marker, never a pathname successor. */
async function detachTransitionMarker(
	fs: TransitionMarkerFs,
	path: string,
	snapshot: TransitionMarkerSnapshot,
): Promise<boolean> {
	if (!snapshot.identity || !fs.exactUnlink) return false;
	try {
		const removed = await fs.exactUnlink(path, snapshot.identity);
		if (removed.ok) return true;
		// Accept only typed retained authority: a concrete detached quarantine plus
		// a proven-absent canonical marker pathname. Anything else stays fail-closed.
		return (
			removed.code === "cleanup_pending" &&
			typeof removed.detachedPath === "string" &&
			removed.detachedPath.length > 0 &&
			(await fs.readFile(path, "utf8").catch(() => undefined)) === undefined
		);
	} catch {
		return false;
	}
}

/** Removes only the caller's exact marker through the identity-bound detach primitive. */
export async function releaseDaemonTransitionLock(input: {
	fs: TransitionMarkerFs;
	path: string;
	lock: DaemonTransitionLock;
}): Promise<boolean> {
	const snapshot = await readTransitionMarker(input.fs, input.path);
	if (!snapshot || !transitionMarkerMatchesLock(snapshot, input.lock)) return false;
	return await detachTransitionMarker(input.fs, input.path, snapshot);
}

/**
 * Acquire the daemon lifecycle transition lock using durable owner metadata.
 * The full marker is published in the single O_EXCL write which reserves it;
 * canonical markers are detached only through their captured filesystem identity.
 *
 * Malformed and empty markers deliberately remain blocked regardless of age. They
 * have no owner provenance, so reclaiming them could detach a generation-6 empty
 * reservation while its paused legacy writer can still resume. Operators must
 * manually clean up such legacy debris after confirming no legacy process remains.
 */
export async function acquireDaemonTransitionLock(input: {
	fs: TransitionMarkerFs;
	path: string;
	pid: number;
	pidAlive: (pid: number) => boolean;
	pidIncarnation: (pid: number) => string | undefined;
	now?: () => number;
	sleep?: (ms: number) => Promise<void>;
	retries?: number;
	retryDelayMs?: number;
	randomToken?: () => string;
}): Promise<DaemonTransitionLock | undefined> {
	const sleep = input.sleep ?? (async (ms: number) => await Bun.sleep(ms));
	const now = input.now ?? Date.now;
	const retries = Math.max(input.retries ?? 5, 0);
	const retryDelayMs = Math.max(input.retryDelayMs ?? 20, 0);
	const incarnation = input.pidIncarnation(input.pid);
	if (!isProcessIncarnation(incarnation)) return undefined;
	const token = input.randomToken?.() ?? crypto.randomUUID();
	if (!token || !input.fs.writeFile || !input.fs.readEndpointFile || !input.fs.exactUnlink) return undefined;
	const owner: DaemonTransitionLock = { pid: input.pid, incarnation, createdAt: now(), token };
	for (let attempt = 0; attempt <= retries; attempt++) {
		try {
			await input.fs.writeFile(input.path, `${JSON.stringify(owner)}\n`, { mode: 0o600, flag: "wx" });
			return owner;
		} catch (error) {
			if (["EEXIST", "ENOENT"].includes((error as NodeJS.ErrnoException).code ?? "")) {
				if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
			} else throw error;
		}
		const snapshot = await readTransitionMarker(input.fs, input.path);
		let current: unknown;
		try {
			current = snapshot === undefined ? undefined : JSON.parse(snapshot.raw);
		} catch {
			current = undefined;
		}
		// Only canonical owner records prove which process may be reclaimed. An
		// unreadable or empty legacy reservation is intentionally not age-reclaimed:
		// it may belong to a paused generation-6 two-step publisher.
		const ownerAlive = isDaemonTransitionLock(current) && input.pidAlive(current.pid);
		const ownerIncarnation = isDaemonTransitionLock(current) ? input.pidIncarnation(current.pid) : undefined;
		const reclaimable =
			isDaemonTransitionLock(current) &&
			(!ownerAlive ||
				(isProcessIncarnation(current.incarnation) &&
					isProcessIncarnation(ownerIncarnation) &&
					ownerIncarnation !== current.incarnation));
		if (snapshot && reclaimable) await detachTransitionMarker(input.fs, input.path, snapshot);
		if (attempt < retries) await sleep(retryDelayMs);
	}
	return undefined;
}

function defaultTransitionPidAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (err) {
		return (err as NodeJS.ErrnoException).code === "EPERM";
	}
}

function defaultTransitionPidIncarnation(pid: number): string | undefined {
	return processIncarnation(pid);
}

/**
 * Owner-bound removal of a dead daemon's lock. Closes the classic
 * check-then-unlink TOCTOU: a naive `unlink(lock)` after observing a dead owner
 * can delete a *new* live owner's lock if a daemon took over in between. This
 * primitive re-checks ownership while holding the same steal-mutex the daemon's
 * own takeover path uses ({@link DaemonPaths.steal}), so the two are mutually
 * exclusive, and unlinks only when the recorded owner is still the same
 * confirmed-dead process.
 */
async function removeDeadOwnerLock(
	fs: NotificationServiceFs,
	paths: DaemonPaths,
	pidAlive: (pid: number) => boolean,
	expected: NormalizedDaemonState,
): Promise<"cleared" | "contended" | "superseded" | "now-alive" | "unlink-failed"> {
	const transition = await acquireDaemonTransitionLock({
		fs,
		path: paths.steal,
		pid: process.pid,
		pidAlive: defaultTransitionPidAlive,
		pidIncarnation: defaultTransitionPidIncarnation,
	});
	if (!transition) return "contended";
	try {
		const current = await readDaemonStateFile(fs, paths.state);
		if (!current || current.ownerId !== expected.ownerId || current.pid !== expected.pid) {
			return "superseded";
		}
		if (pidAlive(current.pid)) return "now-alive";
		if (!(await daemonTransitionLockIsHeld({ fs, path: paths.steal, lock: transition }))) return "contended";
		try {
			await fs.unlink(paths.lock);
			return "cleared";
		} catch {
			return "unlink-failed";
		}
	} finally {
		await releaseDaemonTransitionLock({ fs, path: paths.steal, lock: transition });
	}
}

/**
 * Ownership-protected cleanup. Removes only DEAD-owner artifacts:
 * per-session endpoint files with positive proof of death (a stale tombstone or
 * a dead recorded pid), and a daemon lock whose recorded owner is confirmed
 * dead. A PID-less endpoint is treated as unknown (not dead) and kept. The
 * daemon lock is removed through {@link removeDeadOwnerLock}, an owner-bound
 * primitive that re-checks ownership under the daemon steal-mutex so it can
 * never race a concurrent takeover. Never removes a live owner's lock, never
 * deletes unreadable files, and never kills a process.
 */
export async function recoverNotifications(opts: RecoveryOptions): Promise<NotificationRecoveryReport> {
	const deps = opts.deps ?? {};
	const fs = deps.fs ?? nodeServiceFs;
	const pidAlive = deps.pidAlive ?? defaultPidAlive;
	const stateRoot = opts.stateRoot ?? defaultStateRoot();

	const dir = endpointDir(stateRoot);
	const files = await listEndpointFiles(fs, dir);
	const removed: RecoveredEndpoint[] = [];
	const detached: string[] = [];
	const retainedSuccessors: string[] = [];
	const retainedPlaceholders: string[] = [];
	const retainedUnknown: string[] = [];
	let recoveryFailures = 0;
	let kept = 0;
	let unreadable = 0;
	for (const name of files) {
		const file = path.join(dir, name);
		const record = await classifyNotificationEndpoint(fs, file, pidAlive);
		if (record.kind === "non-endpoint") continue;
		if (record.kind === "unreadable") {
			// Leave unparseable files untouched: they may be mid-write by a live server.
			unreadable += 1;
			continue;
		}
		const view = record.view;
		if (record.liveness !== "dead") {
			// Keep live AND unknown (PID-less) endpoints: only positive proof of
			// death (a stale tombstone or a dead pid) authorizes removal.
			kept += 1;
			continue;
		}
		try {
			const result = await fs.exactUnlink(file, record.identity);
			if (!result.ok) {
				if (result.detachedPath) detached.push(result.detachedPath);
				if (result.retainedSuccessorPath) retainedSuccessors.push(result.retainedSuccessorPath);
				if (result.retainedPlaceholderPath) retainedPlaceholders.push(result.retainedPlaceholderPath);
				if (result.retainedUnknownPath) retainedUnknown.push(result.retainedUnknownPath);
				// Typed retained authority with a concrete quarantine and a proven-absent
				// canonical endpoint counts as removed; the detached path above is the
				// durable evidence. Anything else is a genuine recovery failure.
				const retainedRemoved =
					result.code === "cleanup_pending" &&
					typeof result.detachedPath === "string" &&
					result.detachedPath.length > 0 &&
					(await fs.readFile(file, "utf8").catch(() => undefined)) === undefined;
				if (retainedRemoved) {
					removed.push({
						sessionId: view.sessionId,
						pid: view.pid,
						reason: view.stale ? "stale-flag" : "dead-pid",
					});
					continue;
				}
				recoveryFailures += 1;
				if (
					!result.detachedPath &&
					!result.retainedSuccessorPath &&
					!result.retainedPlaceholderPath &&
					!result.retainedUnknownPath
				)
					kept += 1;
				continue;
			}
			removed.push({
				sessionId: view.sessionId,
				pid: view.pid,
				reason: view.stale ? "stale-flag" : "dead-pid",
			});
		} catch {
			kept += 1;
		}
	}

	// Daemon lock: clear only when the recorded owner process is dead.
	const paths = daemonPaths(opts.settings.getAgentDir());
	let daemonFiles: string[] = [];
	try {
		daemonFiles = await fs.readdir(paths.dir);
	} catch {
		// directory absent: nothing to recover
	}
	const hasLock = daemonFiles.includes(path.basename(paths.lock));
	const state = await readDaemonStateFile(fs, paths.state);
	let daemon: NotificationRecoveryReport["daemon"];
	if (!state) {
		daemon = hasLock
			? {
					action: "orphan-lock-left",
					detail: "daemon lock present without an ownership record; left untouched to protect a starting owner",
					ownerId: undefined,
					pid: undefined,
				}
			: { action: "none", detail: "no daemon ownership record", ownerId: undefined, pid: undefined };
	} else if (pidAlive(state.pid)) {
		daemon = {
			action: "left-active",
			detail: `live daemon owned by pid ${state.pid} left untouched`,
			ownerId: state.ownerId,
			pid: state.pid,
		};
	} else if (hasLock) {
		const outcome = await removeDeadOwnerLock(fs, paths, pidAlive, state);
		const action: DaemonRecoveryAction =
			outcome === "cleared"
				? "cleared-dead-owner-lock"
				: outcome === "now-alive"
					? "left-active"
					: outcome === "superseded"
						? "owner-superseded"
						: outcome === "contended"
							? "left-contended"
							: "orphan-lock-left";
		const detail =
			outcome === "cleared"
				? `cleared lock of dead owner pid ${state.pid}`
				: outcome === "now-alive"
					? `owner pid ${state.pid} became live during recovery; lock left untouched`
					: outcome === "superseded"
						? "a new daemon owner took over during recovery; lock left untouched"
						: outcome === "contended"
							? "another daemon is starting or stealing the lock; lock left untouched"
							: `could not remove lock of dead owner pid ${state.pid}`;
		daemon = { action, detail, ownerId: state.ownerId, pid: state.pid };
	} else {
		daemon = {
			action: "none",
			detail: `dead owner pid ${state.pid} recorded but no lock present`,
			ownerId: state.ownerId,
			pid: state.pid,
		};
	}

	return {
		endpointsScanned: removed.length + kept + unreadable + recoveryFailures,
		endpointsRemoved: removed,
		endpointsKept: kept,
		endpointsUnreadable: unreadable,
		endpointsDetached: detached,
		endpointsRetainedSuccessors: retainedSuccessors,
		endpointsRetainedPlaceholders: retainedPlaceholders,
		endpointsRetainedUnknown: retainedUnknown,
		daemon,
	};
}

/** Render a recovery report as human-readable lines (no secrets). */
export function formatNotificationRecoveryReport(report: NotificationRecoveryReport): string {
	const lines = ["Notification recovery"];
	lines.push(
		`  endpoints: scanned ${report.endpointsScanned}, removed ${report.endpointsRemoved.length}, kept ${report.endpointsKept}, unreadable ${report.endpointsUnreadable}, detached ${report.endpointsDetached?.length ?? 0}, retained successors ${report.endpointsRetainedSuccessors?.length ?? 0}, retained placeholders ${report.endpointsRetainedPlaceholders?.length ?? 0}, retained unknown ${report.endpointsRetainedUnknown?.length ?? 0}`,
	);
	for (const ep of report.endpointsRemoved) {
		lines.push(`    - removed ${ep.sessionId} (pid ${ep.pid ?? "?"}, ${ep.reason})`);
	}
	for (const detached of report.endpointsDetached ?? []) lines.push(`    - retained detached endpoint ${detached}`);
	for (const successor of report.endpointsRetainedSuccessors ?? [])
		lines.push(`    - retained successor endpoint ${successor}`);
	for (const placeholder of report.endpointsRetainedPlaceholders ?? [])
		lines.push(`    - retained exchange placeholder cleanup path ${placeholder}`);
	for (const unknown of report.endpointsRetainedUnknown ?? [])
		lines.push(`    - retained unverified cleanup path ${unknown}`);
	lines.push(`  daemon: ${report.daemon.action} — ${report.daemon.detail}`);
	return lines.join("\n");
}
