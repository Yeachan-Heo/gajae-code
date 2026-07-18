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
import * as fsSync from "node:fs";
import * as fsPromises from "node:fs/promises";
import * as path from "node:path";
import * as native from "@gajae-code/natives";
import type { Settings } from "../../config/settings";
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
}

/** Minimal filesystem surface the service needs; injectable for tests. */
export interface NotificationServiceFs {
	readdir(dir: string): Promise<string[]>;
	readFile(file: string, encoding: "utf8"): Promise<string>;
	readEndpointFile(file: string): Promise<NotificationEndpointFile>;
	exactUnlink(file: string, identity: NotificationEndpointFileIdentity): Promise<NotificationExactUnlinkResult>;
	unlink(file: string): Promise<void>;
	/**
	 * Atomically create `file` with O_EXCL semantics: resolves `true` when this
	 * call created it, `false` when it already existed. Used to hold the daemon
	 * steal-mutex ({@link DaemonPaths.steal}) during owner-bound lock removal so
	 * recovery and a concurrent daemon takeover are mutually exclusive.
	 */
	createExclusive(file: string): Promise<boolean>;
}

const nodeServiceFs: NotificationServiceFs = {
	readdir: dir => fsPromises.readdir(dir),
	readFile: (file, encoding) => fsPromises.readFile(file, encoding),
	readEndpointFile: async file => {
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
	},
	exactUnlink: async (file, identity) => {
		const result = native.exactUnlink(file, {
			...identity,
			quarantineName: `.gjc-delete-notification-endpoint-${crypto.randomUUID()}.json`,
		});
		return { ok: result.ok, code: result.code, detachedPath: result.detachedPath };
	},
	unlink: file => fsPromises.unlink(file),
	createExclusive: async file => {
		try {
			const handle = await fsPromises.open(file, "wx", 0o600);
			await handle.close();
			return true;
		} catch {
			return false;
		}
	},
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

interface EndpointView {
	sessionId: string;
	pid: number | undefined;
	stale: boolean;
}

type EndpointFileRead =
	| { kind: "endpoint"; view: EndpointView; identity: NotificationEndpointFileIdentity }
	| { kind: "non-endpoint" }
	| { kind: "unreadable" };

type EndpointLiveness = "live" | "dead" | "unknown";

/**
 * Classify an endpoint using owner-proof semantics. An endpoint is only `dead`
 * with positive proof: an explicit `stale` tombstone, or a recorded pid that is
 * confirmed not alive. A PID-less endpoint is `unknown` (not provably dead) and
 * must never be treated as dead — removing it could delete a live session's
 * discovery file that simply omitted a pid.
 */
function endpointLiveness(view: EndpointView, pidAlive: (pid: number) => boolean): EndpointLiveness {
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

function unreadableEndpointResult(file: string): EndpointFileRead {
	return isCanonicalLifecycleArtifactName(path.basename(file)) ? { kind: "non-endpoint" } : { kind: "unreadable" };
}

async function readEndpointView(fs: NotificationServiceFs, file: string): Promise<EndpointFileRead> {
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
	const rec = parsed as Record<string, unknown>;
	if (isLifecycleArtifact(rec) || typeof rec.url !== "string" || typeof rec.token !== "string")
		return { kind: "non-endpoint" };
	return {
		kind: "endpoint",
		view: {
			sessionId: typeof rec.sessionId === "string" ? rec.sessionId : path.basename(file, ".json"),
			pid: safePositiveInteger(rec.pid),
			stale: rec.stale === true,
		},
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
		const record = await readEndpointView(fs, path.join(dir, name));
		if (record.kind === "non-endpoint") continue;
		if (record.kind === "unreadable") {
			unreadable += 1;
			continue;
		}
		const view = record.view;
		switch (endpointLiveness(view, pidAlive)) {
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
	if (!(await fs.createExclusive(paths.steal))) return "contended";
	try {
		const current = await readDaemonStateFile(fs, paths.state);
		if (!current || current.ownerId !== expected.ownerId || current.pid !== expected.pid) {
			return "superseded";
		}
		if (pidAlive(current.pid)) return "now-alive";
		try {
			await fs.unlink(paths.lock);
			return "cleared";
		} catch {
			return "unlink-failed";
		}
	} finally {
		await fs.unlink(paths.steal).catch(() => undefined);
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
	let kept = 0;
	let unreadable = 0;
	for (const name of files) {
		const file = path.join(dir, name);
		const record = await readEndpointView(fs, file);
		if (record.kind === "non-endpoint") continue;
		if (record.kind === "unreadable") {
			// Leave unparseable files untouched: they may be mid-write by a live server.
			unreadable += 1;
			continue;
		}
		const view = record.view;
		if (endpointLiveness(view, pidAlive) !== "dead") {
			// Keep live AND unknown (PID-less) endpoints: only positive proof of
			// death (a stale tombstone or a dead pid) authorizes removal.
			kept += 1;
			continue;
		}
		try {
			const result = await fs.exactUnlink(file, record.identity);
			if (!result.ok) {
				if (result.detachedPath) detached.push(result.detachedPath);
				else kept += 1;
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
		endpointsScanned: removed.length + kept + unreadable + detached.length,
		endpointsRemoved: removed,
		endpointsKept: kept,
		endpointsUnreadable: unreadable,
		endpointsDetached: detached,
		daemon,
	};
}

/** Render a recovery report as human-readable lines (no secrets). */
export function formatNotificationRecoveryReport(report: NotificationRecoveryReport): string {
	const lines = ["Notification recovery"];
	lines.push(
		`  endpoints: scanned ${report.endpointsScanned}, removed ${report.endpointsRemoved.length}, kept ${report.endpointsKept}, unreadable ${report.endpointsUnreadable}, detached ${report.endpointsDetached?.length ?? 0}`,
	);
	for (const ep of report.endpointsRemoved) {
		lines.push(`    - removed ${ep.sessionId} (pid ${ep.pid ?? "?"}, ${ep.reason})`);
	}
	for (const detached of report.endpointsDetached ?? []) lines.push(`    - retained detached endpoint ${detached}`);
	lines.push(`  daemon: ${report.daemon.action} — ${report.daemon.detail}`);
	return lines.join("\n");
}
