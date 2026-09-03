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

type NativeExactUnlinkBinding = typeof import("@gajae-code/natives")["exactUnlink"];
type NativeNotificationBindings = typeof import("@gajae-code/natives") & {
	exactUnlinkDirect: NativeExactUnlinkBinding;
};

let nativeNotificationBindings: NativeNotificationBindings | undefined;

function nativeNotification(): NativeNotificationBindings {
	if (!nativeNotificationBindings)
		nativeNotificationBindings = require("@gajae-code/natives") as NativeNotificationBindings;
	return nativeNotificationBindings;
}

import type { Settings } from "../../config/settings";
import { isProcessIncarnation, processIncarnation } from "../broker/process-incarnation";
import {
	getNotificationConfig,
	hasAnyCompleteProvider,
	hasAnyEffectivelyEnabledProvider,
	isDiscordComplete,
	isProviderEffectivelyEnabled,
	isSlackComplete,
	isTelegramComplete,
	maskToken,
	type NotificationConfig,
	type NotificationProvider,
	type NotificationRuntime,
	type ProviderResolution,
	resolveNotificationProvider,
	tokenFingerprint,
} from "./config";
import { type DaemonPaths, daemonPaths, HEARTBEAT_TTL_MS } from "./daemon-paths";
import { DiscordLiveProvider } from "./discord-live-provider";
import type { DiscordDiagnosticProvider } from "./discord-provider";
import { SlackLiveProvider } from "./slack-live-provider";
import type { SlackDiagnosticProvider } from "./slack-provider";
import { type OwnerFreshnessSnapshot, readOwnerFreshnessSnapshot, type TelegramDaemonFs } from "./telegram-daemon";
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

export interface NotificationDiagnosticEvent {
	timestamp: string;
	operation: string;
	phase: string;
	outcome: string;
	reason: string;
	pid?: number;
	incarnation?: string;
	ageMs?: number;
	detail?: string;
}

/** Append a bounded, private, secret-safe daemon diagnostic event. */
export async function writeNotificationDiagnostic(
	settings: Pick<Settings, "getAgentDir">,
	event: Omit<NotificationDiagnosticEvent, "timestamp"> & { timestamp?: string },
): Promise<void> {
	const file = daemonPaths(settings.getAgentDir()).diagnostic;
	const dir = path.dirname(file);
	let events: NotificationDiagnosticEvent[] = [];
	try {
		const parsed = JSON.parse(await fsPromises.readFile(file, "utf8")) as { events?: unknown };
		if (Array.isArray(parsed.events)) events = parsed.events as NotificationDiagnosticEvent[];
	} catch {
		// A missing or corrupt diagnostic history must not block notification recovery.
	}
	const safe: NotificationDiagnosticEvent = {
		timestamp: event.timestamp ?? new Date().toISOString(),
		operation: event.operation.slice(0, 80),
		phase: event.phase.slice(0, 80),
		outcome: event.outcome.slice(0, 80),
		reason: event.reason.slice(0, 120),
		...(event.pid === undefined ? {} : { pid: event.pid }),
		...(event.incarnation === undefined ? {} : { incarnation: event.incarnation.slice(0, 120) }),
		...(event.ageMs === undefined ? {} : { ageMs: Math.max(0, Math.floor(event.ageMs)) }),
		...(event.detail === undefined ? {} : { detail: sanitizeDiagnostic(event.detail).slice(0, 512) }),
	};
	await fsPromises.mkdir(dir, { recursive: true, mode: 0o700 });
	await fsPromises.writeFile(file, `${JSON.stringify({ version: 1, events: [...events, safe].slice(-64) })}\n`, {
		mode: 0o600,
	});
}

function sanitizeProviderDiagnostic(text: string, cfg: NotificationConfig, provider: NotificationProvider): string {
	const secrets =
		provider === "telegram"
			? [cfg.botToken]
			: provider === "discord"
				? [cfg.discord.botToken]
				: [cfg.slack.botToken, cfg.slack.appToken];
	let detail = text;
	for (const secret of secrets) detail = sanitizeDiagnostic(detail, secret);
	return detail;
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

/**
 * Remove exactly the inspected regular file.
 *
 * Intermediate directory symlinks (e.g. multi-account layouts that share
 * `notifications/` via a directory symlink) are resolved before the native
 * no-follow unlink. Only the parent path is canonicalized; the final basename
 * is rejoined so native exact_unlink still applies AT_SYMLINK_NOFOLLOW to the
 * final path component at mutation time. A final-component file symlink stays
 * `reparse_point` (including TOCTOU replacement after JS preflight).
 */

function exactUnlinkNotificationFileAtBoundary(
	file: string,
	identity: NotificationEndpointFileIdentity,
	quarantineName: string,
	direct: boolean,
): NotificationExactUnlinkResult {
	let target = file;
	try {
		const st = fsSync.lstatSync(file);
		if (st.isSymbolicLink()) {
			return { ok: false, code: "reparse_point" };
		}
		// Native exact_unlink walks every path component with O_NOFOLLOW and
		// rejects intermediate directory reparse points. Resolve only the
		// directory prefix so a shared notifications dir still unlinks by
		// inode, while the final basename remains subject to no-follow.
		const parent = path.dirname(file);
		const base = path.basename(file);
		const resolvedParent = fsSync.realpathSync(parent);
		target = path.join(resolvedParent, base);
	} catch {
		// Missing/unreadable paths fall through; the native call reports the failure.
	}
	const native = nativeNotification();
	if (direct && typeof native.exactUnlinkDirect !== "function") return { ok: false, code: "native_unavailable" };
	const result = (direct ? native.exactUnlinkDirect : native.exactUnlink)(target, { ...identity, quarantineName });
	return {
		ok: result.ok,
		code: result.code,
		detachedPath: result.detachedPath,
		retainedSuccessorPath: result.retainedSuccessorPath,
		retainedPlaceholderPath: result.retainedPlaceholderPath,
		retainedUnknownPath: result.retainedUnknownPath,
	};
}

export function exactUnlinkNotificationFile(
	file: string,
	identity: NotificationEndpointFileIdentity,
	quarantineName: string,
): NotificationExactUnlinkResult {
	return exactUnlinkNotificationFileAtBoundary(file, identity, quarantineName, false);
}

/** Remove inert debris without routing it through native exchange cleanup. */
function exactUnlinkNotificationDebrisFile(
	file: string,
	identity: NotificationEndpointFileIdentity,
): NotificationExactUnlinkResult {
	return exactUnlinkNotificationFileAtBoundary(file, identity, `.gjc-direct-unlink-${crypto.randomUUID()}`, true);
}

/** Minimal filesystem surface the service needs; injectable for tests. */
export interface NotificationServiceFs {
	readdir(dir: string): Promise<string[]>;
	readFile(file: string, encoding: "utf8"): Promise<string>;
	readEndpointFile(file: string): Promise<NotificationEndpointFile>;
	exactUnlink(file: string, identity: NotificationEndpointFileIdentity): Promise<NotificationExactUnlinkResult>;
	/** Identity-bound direct unlink reserved for inert exchange debris. */
	unlinkExact(file: string, identity: NotificationEndpointFileIdentity): Promise<NotificationExactUnlinkResult>;
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
	unlinkExact: async (file, identity) => exactUnlinkNotificationDebrisFile(file, identity),
	unlink: file => fsPromises.unlink(file),
	writeFile: (file, data, opts) => fsPromises.writeFile(file, data, opts),
	stat: file => fsPromises.stat(file),
};

/** Injectable dependencies shared across service operations. */
export interface NotificationServiceDeps {
	fs?: NotificationServiceFs;
	now?: () => number;
	pidAlive?: (pid: number) => boolean;
	pidIncarnation?: (pid: number) => string | undefined;
	fetchImpl?: typeof fetch;
	apiBase?: string;
	createDiscordDiagnostic?: (config: { applicationId: string; botToken: string }) => DiscordDiagnosticProvider;
	createSlackDiagnostic?: (config: { appToken: string; botToken: string }) => SlackDiagnosticProvider;
	providerRuntimeStatus?: (provider: NotificationProvider) => Promise<NotificationRuntime> | NotificationRuntime;
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
	quarantined: boolean;
	desiredEnabled: boolean;
	desiredSource: ProviderResolution["desiredSource"];
	effectiveEnabled: boolean;
	issues: ProviderResolution["issues"];
	runtime?: NotificationRuntime;
}

export interface NotificationStatusReport {
	enabled: boolean;
	redact: boolean;
	verbosity: "lean" | "verbose";
	globallyConfigured: boolean;
	anyProviderComplete: boolean;
	anyProviderEffective: boolean;
	telegram: AdapterConfigView & { tokenFingerprint: string | undefined };
	discord: AdapterConfigView;
	slack: AdapterConfigView;
}

function adapterView(
	cfg: NotificationConfig,
	provider: NotificationProvider,
	token: string | undefined,
	channel: string | undefined,
): AdapterConfigView {
	const resolution = resolveNotificationProvider(cfg, provider);
	return {
		botTokenMasked: maskToken(token),
		channel,
		configured: resolution.configured,
		quarantined: resolution.quarantined,
		desiredEnabled: resolution.desiredEnabled,
		desiredSource: resolution.desiredSource,
		effectiveEnabled: resolution.effectiveEnabled,
		issues: resolution.issues,
	};
}

/** Build a secret-safe structured status snapshot from settings. */
export function buildNotificationStatusReport(settings: Settings): NotificationStatusReport {
	const cfg = getNotificationConfig(settings);
	return {
		enabled: cfg.enabled,
		redact: cfg.redact,
		verbosity: cfg.verbosity,
		globallyConfigured: cfg.enabled && hasAnyCompleteProvider(cfg),
		anyProviderComplete: hasAnyCompleteProvider(cfg),
		anyProviderEffective: hasAnyEffectivelyEnabledProvider(cfg),
		telegram: {
			...adapterView(cfg, "telegram", cfg.botToken, cfg.chatId),
			tokenFingerprint: cfg.botToken?.trim() ? tokenFingerprint(cfg.botToken) : undefined,
		},
		discord: adapterView(cfg, "discord", cfg.discord.botToken, cfg.discord.parentChannelId),
		slack: adapterView(cfg, "slack", cfg.slack.botToken, cfg.slack.channelId),
	};
}

/** Render a status report as human-readable lines (no secrets). */
export function formatNotificationStatusReport(report: NotificationStatusReport): string {
	const yesNo = (value: boolean): string => (value ? "yes" : "no");
	const provider = (name: NotificationProvider, view: AdapterConfigView): string[] => [
		`  ${name}.configured: ${yesNo(view.configured)}`,
		`  ${name}.needsRepair: ${yesNo(view.quarantined)}`,
		`  ${name}.desired: ${view.desiredEnabled ? "on" : "off"} (${view.desiredSource})`,
		`  ${name}.effective: ${yesNo(view.effectiveEnabled)}`,
		`  ${name}.botToken: ${view.botTokenMasked}`,
		`  ${name}.destination: ${view.channel ?? "(unset)"}`,
	];
	return [
		"Notifications",
		`  enabled: ${report.enabled}`,
		`  any provider effective: ${yesNo(report.anyProviderEffective)}`,
		`  any provider complete: ${yesNo(report.anyProviderComplete)}`,
		`  redact: ${report.redact}`,
		`  verbosity: ${report.verbosity}`,
		...provider("telegram", report.telegram),
		`  telegram.fingerprint: ${report.telegram.tokenFingerprint ?? "(unset)"}`,
		...provider("discord", report.discord),
		...provider("slack", report.slack),
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

function isEndpointRecordForFile(name: string, record: Record<string, unknown>): boolean {
	if (isLifecycleArtifact(record) || typeof record.url !== "string" || typeof record.token !== "string") return false;
	if (!isNativeExchangeDebrisName(name)) return true;
	// A quarantine-shaped basename is only a debris hint. A publisher successor
	// may legitimately occupy that pathname, so retain endpoint authority when
	// the payload proves that it belongs to the current filename. Detached
	// endpoint bytes retain their original sessionId and therefore fail closed as
	// debris instead of being re-quarantined.
	const declaredSessionId = record.sessionId;
	return declaredSessionId === undefined || declaredSessionId === path.basename(name, ".json");
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
		return isNativeExchangeDebrisName(path.basename(file))
			? { kind: "non-endpoint" }
			: unreadableEndpointResult(file);
	}
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return { kind: "non-endpoint" };
	if (path.basename(file) === "broker.json") return { kind: "non-endpoint" };
	const rec = parsed as Record<string, unknown>;
	if (!isEndpointRecordForFile(path.basename(file), rec)) return { kind: "non-endpoint" };
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

// --- native exchange debris patterns ---------------------------------------
//
// The native exact-unlink exchange always detaches a target into a fresh
// quarantine destination (e.g. `.gjc-delete-notification-endpoint-<uuid>.json`)
// and, on the durable-failure paths, leaves `.gjc-exact-unlink-placeholder-*`
// retained records behind. These names are DEBRIS owned by the exact-unlink
// exchange's cleanup, never live notification publications, and must never be
// routed back through the exchange (each exchange pass manufactures fresh
// quarantine/placeholder debris and can re-attack a live successor). Recovery
// therefore excludes them from the endpoint scan, and the debris sweep removes
// them directly instead of re-quarantining them.

const UUID_PATTERN = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
/** Quarantine target of a detached daemon transition marker (telegram-daemon exact unlink). */
const DEBRIS_TRANSITION_QUARANTINE = new RegExp(`^transition-${UUID_PATTERN}$`);
/** Quarantine target of a detached notification endpoint file. */
const DEBRIS_ENDPOINT_QUARANTINE = new RegExp(`^\\.gjc-delete-notification-endpoint-${UUID_PATTERN}\\.json$`);
/** Native exact-unlink exchange placeholder left behind by a failed verified cleanup. */
const DEBRIS_UNLINK_PLACEHOLDER = /^\.gjc-exact-unlink-placeholder-/;
/** Atomic-write staging file: `<canonical>.<pid>.<epochMs>.<random>.tmp`. */
const DEBRIS_STAGING_TMP = /\.([0-9]{1,10})\.[0-9]{1,16}\.[a-z0-9]{1,24}\.tmp$/;

/**
 * True when a basename is a native exact-unlink exchange artifact (a detached
 * quarantine target or a retained exchange placeholder). These are never live
 * endpoint publications: recovery must not classify or re-quarantine them.
 */
function isNativeExchangeDebrisName(name: string): boolean {
	return DEBRIS_ENDPOINT_QUARANTINE.test(name) || DEBRIS_UNLINK_PLACEHOLDER.test(name);
}

async function listEndpointFiles(fs: NotificationServiceFs, dir: string): Promise<string[]> {
	try {
		// Do not exclude quarantine-shaped names here. A live endpoint successor
		// can reuse one of those names; classification below decides whether the
		// bytes are a publication or detached debris from the exchange.
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

	/**
	 * Session endpoints the live owner reported an OPEN socket to in its latest
	 * matching heartbeat sidecar. `undefined` means the owner never published the
	 * field (older daemon, no stable owner tag, no matching sidecar): unknown, not zero.
	 */
	attachedEndpoints: number | undefined;
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
	provider?: NotificationProvider;
	resolution?: ProviderResolution;
	checks: HealthCheck[];
	daemon: DaemonHealth;
	endpoints: EndpointHealth;
	reachability: { probed: boolean; ok: boolean; detail: string };
}

export interface HealthOptions {
	settings: Settings;
	stateRoot?: string;
	deps?: NotificationServiceDeps;
	provider?: NotificationProvider;
	/** When true, use the selected provider's REST-only diagnostic path. */
	probe?: boolean;
	signal?: AbortSignal;
}

async function probeTelegramReachability(
	fetchImpl: typeof fetch,
	apiBase: string,
	token: string,
	signal?: AbortSignal,
): Promise<{ ok: boolean; detail: string }> {
	if (signal?.aborted) return { ok: false, detail: "Telegram probe cancelled." };
	try {
		const response = await fetchImpl(`${apiBase.replace(/\/$/, "")}/bot${token}/getMe`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: "{}",
			signal,
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
	} catch (error) {
		if (signal?.aborted) return { ok: false, detail: "Telegram probe cancelled." };
		return { ok: false, detail: sanitizeDiagnostic(error instanceof Error ? error.message : "network error", token) };
	}
}

function effectiveProviders(cfg: NotificationConfig): NotificationProvider[] {
	return (["telegram", "discord", "slack"] as const).filter(provider => isProviderEffectivelyEnabled(cfg, provider));
}

function selectNotificationProvider(
	cfg: NotificationConfig,
	requested: NotificationProvider | undefined,
): NotificationProvider | undefined {
	if (requested) return requested;
	const effective = effectiveProviders(cfg);
	return effective.length === 1 ? effective[0] : undefined;
}

async function probeSelectedProvider(
	cfg: NotificationConfig,
	provider: NotificationProvider,
	deps: NotificationServiceDeps,
	signal?: AbortSignal,
): Promise<{ ok: boolean; detail: string }> {
	try {
		let result: { ok: boolean; detail: string };
		if (provider === "telegram" && isTelegramComplete(cfg)) {
			result = await probeTelegramReachability(
				deps.fetchImpl ?? globalThis.fetch,
				deps.apiBase ?? DEFAULT_API_BASE,
				cfg.botToken,
				signal,
			);
		} else if (provider === "discord" && isDiscordComplete(cfg)) {
			const adapter =
				deps.createDiscordDiagnostic?.({
					applicationId: cfg.discord.applicationId,
					botToken: cfg.discord.botToken,
				}) ??
				new DiscordLiveProvider({
					applicationId: cfg.discord.applicationId,
					botToken: cfg.discord.botToken,
					fetchImpl: deps.fetchImpl,
				});
			result = await adapter.probeConfiguration(signal);
		} else if (provider === "slack" && isSlackComplete(cfg)) {
			const adapter =
				deps.createSlackDiagnostic?.({ appToken: cfg.slack.appToken, botToken: cfg.slack.botToken }) ??
				new SlackLiveProvider({
					appToken: cfg.slack.appToken,
					botToken: cfg.slack.botToken,
					fetch: deps.fetchImpl,
				});
			const probe = await adapter.probeConfiguration(signal);
			result =
				probe.ok && (!probe.teamId || probe.teamId !== cfg.slack.workspaceId)
					? { ok: false, detail: "Slack workspace identity does not match the configured workspace ID." }
					: probe;
		} else {
			result = { ok: false, detail: `${provider} configuration is unavailable.` };
		}
		return { ...result, detail: sanitizeProviderDiagnostic(result.detail, cfg, provider) };
	} catch (error) {
		return {
			ok: false,
			detail: sanitizeProviderDiagnostic(
				error instanceof Error ? error.message : `${provider} diagnostic failed.`,
				cfg,
				provider,
			),
		};
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
	const provider = selectNotificationProvider(cfg, opts.provider);
	const resolution = provider ? resolveNotificationProvider(cfg, provider) : undefined;
	const configured = resolution?.configured ?? hasAnyCompleteProvider(cfg);
	const telegramConfigured = isTelegramComplete(cfg);
	const checks: HealthCheck[] = [];

	if (provider && resolution?.quarantined) {
		checks.push({ name: "config", level: "error", detail: `${provider} configuration needs repair` });
	} else if (provider && !resolution?.configured) {
		checks.push({ name: "config", level: "warn", detail: `${provider} is not fully configured` });
	} else if (provider && !resolution?.desiredEnabled) {
		checks.push({ name: "intent", level: "warn", detail: `${provider} desired intent is off` });
	} else if (provider && !resolution?.effectiveEnabled) {
		checks.push({
			name: "config",
			level: "warn",
			detail: `${provider} is not effective while the global master is off`,
		});
	} else if (!cfg.enabled) {
		checks.push({
			name: "config",
			level: "warn",
			detail: "notifications are disabled (notifications.enabled=false)",
		});
	} else if (!configured) {
		checks.push({ name: "config", level: "warn", detail: "no notification adapter is fully configured" });
	} else if (!provider && effectiveProviders(cfg).length === 0) {
		checks.push({
			name: "config",
			level: "warn",
			detail: "no configured provider currently has desired intent enabled",
		});
	} else if (!provider && effectiveProviders(cfg).length > 1) {
		checks.push({
			name: "selection",
			level: "warn",
			detail: "select a provider because multiple providers are effective",
		});
	} else {
		checks.push({
			name: "config",
			level: "ok",
			detail: provider ? `${provider} is effective` : "enabled with one configured adapter",
		});
	}

	// Daemon ownership state (offline; corrupt or unreadable state degrades to a
	// warning instead of making the health command itself fail).
	let daemonStateUnreadable = false;
	let snapshot: OwnerFreshnessSnapshot;
	try {
		snapshot = await readOwnerFreshnessSnapshot({
			settings: opts.settings,
			fs: fs as unknown as TelegramDaemonFs,
		});
	} catch {
		daemonStateUnreadable = true;
		snapshot = {
			ownerTag: null,
			effectiveHeartbeatAt: undefined,
			legacyEmbedded: false,
			attachedEndpoints: undefined,
			state: undefined,
		};
	}
	const state = snapshot.state ? parseDaemonState(JSON.stringify(snapshot.state)) : undefined;
	const heartbeatAt = finiteNonNegativeNumber(snapshot.effectiveHeartbeatAt);
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
		attachedEndpoints: snapshot.attachedEndpoints,
		generation: state?.generation,
		currentGeneration: DAEMON_GENERATION,
		generationRelation: daemonGenerationRelation(state),
	};
	if (!provider || provider === "telegram") {
		if (daemonStateUnreadable) {
			checks.push({ name: "daemon", level: "warn", detail: "daemon ownership record is corrupt or unreadable" });
		} else if (!state) {
			checks.push({ name: "daemon", level: "ok", detail: "no daemon ownership record (none running)" });
		} else if (!daemon.alive) {
			let lockPresent = false;
			try {
				const daemonDir = daemonPaths(opts.settings.getAgentDir()).dir;
				const files = await fs.readdir(daemonDir);
				const lockName = path.basename(daemonPaths(opts.settings.getAgentDir()).lock);
				lockPresent = files.includes(lockName);
			} catch {
				lockPresent = false;
			}
			if (lockPresent) {
				checks.push({
					name: "daemon",
					level: "warn",
					detail: `daemon owner pid ${daemon.pid} is not alive; run recovery to clear the stale lock`,
				});
			} else {
				checks.push({
					name: "daemon",
					level: "warn",
					detail: `daemon owner pid ${daemon.pid} is not alive; no lock present (daemon exited cleanly)`,
				});
			}
		} else if (!daemon.heartbeatFresh) {
			checks.push({ name: "daemon", level: "warn", detail: `daemon pid ${daemon.pid} heartbeat is stale` });
		} else if (telegramConfigured && !daemon.identityMatches) {
			checks.push({
				name: "daemon",
				level: "warn",
				detail: "a live daemon owns a different bot token or chat id",
			});
		} else if (telegramConfigured && !daemon.stopped && daemon.generationRelation !== "current") {
			// Liveness is not serviceability. `isCurrentCompatibleOwner` refuses to attach
			// a session to an owner whose generation is not this build's, and
			// `acquireDaemonOwnership` then answers `provisional`, which `ensureTelegramDaemonRunning`
			// reports as `blocked_identity`: no transport is ever attached and no
			// notification is ever published, while the owner keeps heartbeating. Reporting
			// that as OK is what makes the outage invisible. Recovery is platform-dependent,
			// so health identifies the condition without prescribing an unsupported command.
			checks.push({
				name: "daemon",
				level: "warn",
				detail: `daemon pid ${daemon.pid} serves generation ${daemon.generation ?? "unknown"} but this build attaches only to generation ${daemon.currentGeneration}; it cannot attach a session transport — inspect daemon lifecycle status before attempting recovery`,
			});
		} else {
			checks.push({ name: "daemon", level: "ok", detail: `daemon pid ${daemon.pid} alive with a fresh heartbeat` });
		}
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
	if (!provider || provider === "telegram") {
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
		// Endpoint files are registrations, not deliveries: a live owner that
		// reports zero OPEN sockets cannot deliver to any of them. An owner that
		// never published a count is unknown, and unknown is never treated as zero.
		if (
			telegramConfigured &&
			daemon.present &&
			daemon.alive &&
			daemon.heartbeatFresh &&
			daemon.identityMatches &&
			!daemon.stopped &&
			endpoints.total > 0 &&
			daemon.attachedEndpoints === 0
		) {
			checks.push({
				name: "endpoint_attachment",
				level: "warn",
				detail: `${endpoints.total} endpoint file(s) registered but daemon pid ${daemon.pid} reports 0 attached session(s); the daemon cannot deliver to any registered endpoint`,
			});
		}
	}

	// Optional selected REST-only reachability probe.
	let reachability = { probed: false, ok: false, detail: "not probed" };
	if (opts.probe) {
		if (!provider) {
			reachability = { probed: false, ok: false, detail: "provider selection required" };
			checks.push({ name: "reachability", level: "error", detail: "provider selection required" });
		} else if (!resolution?.configured || resolution.quarantined) {
			reachability = { probed: false, ok: false, detail: `${provider} is unavailable` };
			checks.push({ name: "reachability", level: "error", detail: `${provider} is unavailable` });
		} else {
			const result = await probeSelectedProvider(cfg, provider, deps, opts.signal);
			reachability = { probed: true, ...result };
			checks.push({
				name: "reachability",
				level: result.ok ? "ok" : "error",
				detail: `${provider}: ${result.detail}`,
			});
		}
	}

	const overall = checks.reduce<HealthLevel>((acc, check) => worst(acc, check.level), "ok");
	return {
		overall,
		configured,
		...(provider ? { provider, resolution } : {}),
		checks,
		daemon,
		endpoints,
		reachability,
	};
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
	adapter?: NotificationProvider;
	destination?: string;
	detail: string;
	uncertain?: boolean;
}

export interface TestOptions {
	settings: Settings;
	deps?: NotificationServiceDeps;
	provider?: NotificationProvider;
	text?: string;
	signal?: AbortSignal;
}

async function selectedProviderRuntimeReady(
	provider: NotificationProvider,
	deps: NotificationServiceDeps,
): Promise<boolean> {
	if (!deps.providerRuntimeStatus) return false;
	const status = await deps.providerRuntimeStatus(provider);
	return status === "ready" || status === "attached";
}

/** Send a one-off test through exactly one durable, effective provider. */
export async function sendNotificationTest(opts: TestOptions): Promise<NotificationTestResult> {
	const deps = opts.deps ?? {};
	const cfg = getNotificationConfig(opts.settings);
	const provider = selectNotificationProvider(cfg, opts.provider);
	if (!provider) {
		return {
			ok: false,
			detail:
				effectiveProviders(cfg).length === 0
					? "No notification provider is effective. Configure and enable one provider first."
					: "Multiple notification providers are effective; select one with --provider.",
		};
	}
	const resolution = resolveNotificationProvider(cfg, provider);
	if (!resolution.effectiveEnabled) {
		return {
			ok: false,
			adapter: provider,
			detail: resolution.quarantined
				? `${provider} configuration needs repair.`
				: `${provider} is unavailable because configuration, desired intent, or the global master is off.`,
		};
	}
	try {
		if (!(await selectedProviderRuntimeReady(provider, deps))) {
			return { ok: false, adapter: provider, detail: `${provider} runtime is not ready or attached.` };
		}
	} catch (error) {
		return {
			ok: false,
			adapter: provider,
			detail: sanitizeProviderDiagnostic(
				error instanceof Error ? error.message : `${provider} runtime readiness check failed.`,
				cfg,
				provider,
			),
		};
	}
	if (opts.signal?.aborted)
		return { ok: false, adapter: provider, detail: `${provider} notification test cancelled.` };
	const text = opts.text ?? "GJC notifications test message. If you can read this, delivery works.";
	if (provider === "telegram" && isTelegramComplete(cfg)) {
		const fetchImpl = deps.fetchImpl ?? globalThis.fetch;
		const apiBase = (deps.apiBase ?? DEFAULT_API_BASE).replace(/\/$/, "");
		try {
			const response = await fetchImpl(`${apiBase}/bot${cfg.botToken}/sendMessage`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ chat_id: cfg.chatId, text }),
				signal: opts.signal,
			});
			const payload = (await response.json().catch(() => undefined)) as
				| { ok?: boolean; description?: string; result?: { message_id?: unknown } }
				| undefined;
			const messageId = payload?.result?.message_id;
			if (response.ok && payload?.ok === true && typeof messageId === "number" && Number.isSafeInteger(messageId)) {
				return {
					ok: true,
					adapter: "telegram",
					destination: cfg.chatId,
					detail: `delivered to chat ${cfg.chatId}`,
				};
			}
			const uncertain = response.ok && payload?.ok !== false;
			return {
				ok: false,
				adapter: "telegram",
				destination: cfg.chatId,
				...(uncertain ? { uncertain: true } : {}),
				detail: sanitizeDiagnostic(
					uncertain
						? "Telegram may have accepted the message but returned no usable message receipt."
						: (payload?.description ?? `Telegram sendMessage failed (HTTP ${response.status})`),
					cfg.botToken,
				),
			};
		} catch (error) {
			return {
				ok: false,
				adapter: "telegram",
				destination: cfg.chatId,
				uncertain: true,
				detail: opts.signal?.aborted
					? "Telegram notification delivery is uncertain because cancellation raced with dispatch."
					: sanitizeDiagnostic(error instanceof Error ? error.message : "network error", cfg.botToken),
			};
		}
	}
	if (provider === "discord" && isDiscordComplete(cfg)) {
		try {
			const adapter =
				deps.createDiscordDiagnostic?.({
					applicationId: cfg.discord.applicationId,
					botToken: cfg.discord.botToken,
				}) ??
				new DiscordLiveProvider({
					applicationId: cfg.discord.applicationId,
					botToken: cfg.discord.botToken,
					fetchImpl: deps.fetchImpl,
				});
			const result = await adapter.sendOneShotTest({
				channelId: cfg.discord.parentChannelId,
				message: text,
				signal: opts.signal,
			});
			return {
				ok: result.ok,
				adapter: "discord",
				destination: cfg.discord.parentChannelId,
				detail: sanitizeProviderDiagnostic(result.detail, cfg, "discord"),
				...(result.uncertain ? { uncertain: true } : {}),
			};
		} catch (error) {
			return {
				ok: false,
				adapter: "discord",
				destination: cfg.discord.parentChannelId,
				uncertain: true,
				detail: sanitizeProviderDiagnostic(
					error instanceof Error ? error.message : "Discord notification delivery failed.",
					cfg,
					"discord",
				),
			};
		}
	}
	if (provider === "slack" && isSlackComplete(cfg)) {
		try {
			const adapter =
				deps.createSlackDiagnostic?.({ appToken: cfg.slack.appToken, botToken: cfg.slack.botToken }) ??
				new SlackLiveProvider({
					appToken: cfg.slack.appToken,
					botToken: cfg.slack.botToken,
					fetch: deps.fetchImpl,
				});
			const result = await adapter.sendOneShotTest({
				channel: cfg.slack.channelId,
				message: text,
				idempotencyKey: crypto.randomUUID(),
				signal: opts.signal,
			});
			return {
				ok: result.ok,
				adapter: "slack",
				destination: cfg.slack.channelId,
				detail: sanitizeProviderDiagnostic(result.detail, cfg, "slack"),
				...(result.uncertain ? { uncertain: true } : {}),
			};
		} catch (error) {
			return {
				ok: false,
				adapter: "slack",
				destination: cfg.slack.channelId,
				uncertain: true,
				detail: sanitizeProviderDiagnostic(
					error instanceof Error ? error.message : "Slack notification delivery failed.",
					cfg,
					"slack",
				),
			};
		}
	}
	return { ok: false, adapter: provider, detail: `${provider} configuration is unavailable.` };
}

/** Render a test result as a single human-readable line (no secrets). */
export function formatNotificationTestResult(result: NotificationTestResult): string {
	return `Notification test (${result.adapter ?? "unselected"}): ${result.ok ? "OK" : result.uncertain ? "UNCERTAIN" : "FAILED"} — ${result.detail}`;
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
	/** Stale quarantine/staging debris removed from the endpoint and daemon dirs. */
	debrisRemoved?: string[];
	/** Debris candidates retained by policy (young, live writer). */
	debrisKept?: number;
	/** Debris removals attempted without conclusive success (identity/unlink). */
	debrisFailures?: number;
	/** At least one debris directory listing failed; the sweep was not exhaustive. */
	debrisScanFailed?: boolean;
	daemon: {
		action: DaemonRecoveryAction;
		detail: string;
		ownerId: string | undefined;
		blockingReason?: string;
		markerAgeMs?: number;
		forceCommand?: string;
		pid: number | undefined;
	};
}

export interface RecoveryOptions {
	settings: Settings;
	stateRoot?: string;
	deps?: NotificationServiceDeps;
	forceDaemonLock?: boolean;
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
	stat?(file: string): Promise<{ mtimeMs: number }>;
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

const TRANSITION_MARKER_GRACE_MS = 3 * HEARTBEAT_TTL_MS;

async function detachStaleTransitionMarker(input: {
	fs: TransitionMarkerFs;
	path: string;
	now: number;
	pidAlive: (pid: number) => boolean;
	pidIncarnation: (pid: number) => string | undefined;
}): Promise<boolean> {
	const snapshot = await readTransitionMarker(input.fs, input.path);
	if (!snapshot) return false;
	let marker: unknown;
	try {
		marker = JSON.parse(snapshot.raw);
	} catch {
		return false;
	}
	if (!isDaemonTransitionLock(marker)) return false;
	const currentIncarnation = input.pidIncarnation(marker.pid);
	if (
		input.pidAlive(marker.pid) ||
		!isProcessIncarnation(marker.incarnation) ||
		(isProcessIncarnation(currentIncarnation) && currentIncarnation === marker.incarnation)
	)
		return false;
	const ageMs = input.now - marker.createdAt;
	if (!Number.isFinite(ageMs) || ageMs <= TRANSITION_MARKER_GRACE_MS) return false;
	return await detachTransitionMarker(input.fs, input.path, snapshot);
}

// --- stale debris sweep ---------------------------------------------------

/**
 * Minimum age before age-based debris removal. Quarantine artifacts are inert
 * the moment they are detached, but the age bound keeps the sweep clear of any
 * recovery pass still holding a `detachedPath` reference in its report.
 */
export const NOTIFICATION_DEBRIS_MIN_AGE_MS = 60 * 60 * 1_000;

export interface NotificationDebrisSweepReport {
	/** Basenames removed from the swept directory. */
	removed: string[];
	/** Debris candidates retained (young, live writer, or identity/unlink refusal). */
	kept: number;
	/**
	 * Candidates whose removal was ATTEMPTED and did not conclusively succeed
	 * (identity mismatch, unreadable candidate, unlink error). Distinct from
	 * `kept`-by-policy so a caller can see that a sweep was not fully effective.
	 */
	failures: number;
	/** The directory listing itself failed; nothing could be inspected. */
	scanFailed?: boolean;
}

/**
 * Remove inert filesystem debris from a notification/state directory:
 * quarantine targets of already-detached markers and endpoints, exact-unlink
 * exchange placeholders, and leaked atomic-write staging files.
 *
 * Removal requires positive staleness proof — a dead recorded writer pid for
 * staging files, or an mtime older than {@link NOTIFICATION_DEBRIS_MIN_AGE_MS}
 * for everything else. Canonical files can never match the debris patterns, and
 * a young staging file with a live writer is kept.
 *
 * Age, terminal-scrub proof, and the delete identity all come from ONE
 * no-follow snapshot of the candidate. Judging age from a separate `stat` would
 * prove one pathname stale and then bind the delete to whatever occupied that
 * pathname afterwards, so a live successor could be removed on a predecessor's
 * staleness. A candidate replaced after the snapshot fails the identity match
 * and is retained; a symlinked, non-regular, or unreadable candidate is refused
 * outright. Every inconclusive attempt is counted in `failures` rather than
 * silently folded into `kept`.
 */
export async function sweepNotificationDebris(input: {
	dir: string;
	deps?: NotificationServiceDeps;
	minAgeMs?: number;
}): Promise<NotificationDebrisSweepReport> {
	const deps = input.deps ?? {};
	const fs = deps.fs ?? nodeServiceFs;
	const pidAlive = deps.pidAlive ?? defaultPidAlive;
	const now = deps.now ?? Date.now;
	const minAgeMs = input.minAgeMs ?? NOTIFICATION_DEBRIS_MIN_AGE_MS;
	const removed: string[] = [];
	let kept = 0;
	let failures = 0;
	let names: string[] = [];
	try {
		names = await fs.readdir(input.dir);
	} catch {
		return { removed, kept, failures, scanFailed: true };
	}
	for (const name of names) {
		const staging = DEBRIS_STAGING_TMP.exec(name);
		const placeholder = DEBRIS_UNLINK_PLACEHOLDER.test(name);
		const quarantineLike =
			DEBRIS_TRANSITION_QUARANTINE.test(name) || DEBRIS_ENDPOINT_QUARANTINE.test(name) || placeholder;
		if (!staging && !quarantineLike) continue;
		const file = path.join(input.dir, name);
		// ONE no-follow snapshot decides everything: age, terminal-scrub proof, and
		// the identity the delete is bound to. Reading mtime separately (e.g. via
		// `stat`) would judge the age of one pathname and then delete whatever
		// occupied it afterwards — the exact-unlink identity would faithfully bind
		// to a successor that was never proved stale.
		const candidate = await fs.readEndpointFile(file).catch(() => undefined);
		if (!candidate) {
			// Unreadable, symlinked, or non-regular: never a pathname unlink, and
			// an operational failure rather than silent policy retention.
			failures += 1;
			continue;
		}
		if (DEBRIS_ENDPOINT_QUARANTINE.test(name)) {
			let parsed: unknown;
			try {
				parsed = JSON.parse(candidate.bytes.toString("utf8"));
			} catch {
				parsed = undefined;
			}
			if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
				// A valid endpoint publication wins over the basename hint. Recovery's
				// endpoint pass owns its liveness decision; the debris sweep must not
				// delete a live successor merely because its name resembles quarantine.
				if (isEndpointRecordForFile(name, parsed as Record<string, unknown>)) {
					kept += 1;
					continue;
				}
			}
		}
		const mtimeMs = Number(candidate.identity.mtimeNs / 1_000_000n);
		const olderThanMinAge = Number.isFinite(mtimeMs) && now() - mtimeMs > minAgeMs;
		const deadWriter =
			staging !== null &&
			(() => {
				const writerPid = Number.parseInt(staging[1] ?? "", 10);
				return Number.isSafeInteger(writerPid) && writerPid > 0 && !pidAlive(writerPid);
			})();
		if (!deadWriter && !olderThanMinAge) {
			kept += 1;
			continue;
		}
		if (placeholder && candidate.bytes.length > 0) {
			// A native exchange placeholder is inert only once it is the terminal
			// scrubbed remnant. A NONEMPTY placeholder may still carry the retained
			// cleanup evidence for an endpoint whose verified removal failed.
			kept += 1;
			continue;
		}
		// Never re-run the exact-unlink exchange on a native debris object: the
		// exchange would detach it into a fresh quarantine destination and leave a
		// new retained placeholder, re-manufacturing the very debris being
		// reconciled and re-attacking a live successor. A positively-stale inert
		// scrub remnant is removed directly, bound to the single snapshot identity
		// and re-verified at mutation time so a live object that replaced the
		// pathname is retained, not unlinked.
		try {
			const recheck = await fs.readEndpointFile(file).catch(() => undefined);
			if (
				!recheck ||
				recheck.identity.dev !== candidate.identity.dev ||
				recheck.identity.ino !== candidate.identity.ino ||
				recheck.identity.size !== candidate.identity.size ||
				recheck.identity.mtimeNs !== candidate.identity.mtimeNs ||
				recheck.identity.sha256 !== candidate.identity.sha256
			) {
				// The pathname now names different bytes/a different inode — a successor
				// replaced the aged debris (or it became unreadable). Retain it as a
				// failure; never unlink a live object.
				failures += 1;
				continue;
			}
			const removedResult = await fs.unlinkExact(file, candidate.identity);
			if (!removedResult.ok) {
				failures += 1;
				continue;
			}
			removed.push(name);
		} catch {
			failures += 1;
		}
	}
	return { removed, kept, failures };
}

/**
 * Operator-authorized detach of a provenance-less blocking transition marker.
 *
 * The normal reclaim path (`detachStaleTransitionMarker`) refuses malformed and
 * empty markers because they carry no owner proof. `--force-daemon-lock` is the
 * documented operator confirmation that no legacy writer remains, so under that
 * flag a marker that is unparseable AND older than the transition grace window
 * may be detached through the identity-bound primitive. Valid markers are never
 * force-detached here — dead-owner reclaim already covers them, and a live
 * owner's marker must stay untouchable even under force.
 */
async function forceDetachBlockedTransitionMarker(input: {
	fs: TransitionMarkerFs;
	path: string;
	now: number;
}): Promise<boolean> {
	const snapshot = await readTransitionMarker(input.fs, input.path);
	if (!snapshot) return false;
	try {
		if (isDaemonTransitionLock(JSON.parse(snapshot.raw))) return false;
	} catch {
		// Unparseable marker: exactly the class force is for.
	}
	if (!input.fs.stat) return false;
	const st = await input.fs.stat(input.path).catch(() => undefined);
	if (!st || !Number.isFinite(st.mtimeMs)) return false;
	if (input.now - st.mtimeMs <= TRANSITION_MARKER_GRACE_MS) return false;
	return await detachTransitionMarker(input.fs, input.path, snapshot);
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
	now: () => number,
	pidIncarnation: (pid: number) => string | undefined,
	forceDaemonLock = false,
): Promise<"cleared" | "contended" | "superseded" | "now-alive" | "unlink-failed"> {
	let transition = await acquireDaemonTransitionLock({
		fs,
		path: paths.steal,
		pid: process.pid,
		pidAlive: defaultTransitionPidAlive,
		pidIncarnation: defaultTransitionPidIncarnation,
	});
	if (!transition) {
		await detachStaleTransitionMarker({
			fs,
			path: paths.steal,
			now: now(),
			pidAlive,
			pidIncarnation,
		});
		if (forceDaemonLock) await forceDetachBlockedTransitionMarker({ fs, path: paths.steal, now: now() });
		transition = await acquireDaemonTransitionLock({
			fs,
			path: paths.steal,
			pid: process.pid,
			pidAlive: defaultTransitionPidAlive,
			pidIncarnation: defaultTransitionPidIncarnation,
		});
	}
	if (!transition) return "contended";
	try {
		const current = await readDaemonStateFile(fs, paths.state);
		if (!current || current.ownerId !== expected.ownerId || current.pid !== expected.pid) return "superseded";
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
	const now = deps.now ?? Date.now;
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
		const outcome = await removeDeadOwnerLock(
			fs,
			paths,
			pidAlive,
			state,
			now,
			deps.pidIncarnation ?? defaultTransitionPidIncarnation,
			opts.forceDaemonLock === true,
		);
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
							? `recovery blocked by transition marker; lock left untouched${opts.forceDaemonLock ? " even after forced stale-marker retry" : ""}`
							: `could not remove lock of dead owner pid ${state.pid}`;
		const blockingReason = outcome === "contended" ? "transition-marker-unavailable-or-contended" : undefined;
		const markerAgeMs =
			blockingReason && fs.stat
				? (await fs.stat(paths.steal).catch(() => undefined))?.mtimeMs
					? now() - (await fs.stat(paths.steal).catch(() => undefined))!.mtimeMs
					: undefined
				: undefined;
		if (blockingReason) {
			await writeNotificationDiagnostic(opts.settings, {
				operation: "notify.recovery",
				phase: "recovery",
				outcome: action,
				reason: blockingReason,
				pid: state.pid,
				ageMs: markerAgeMs,
				detail,
			});
		}
		daemon = {
			action,
			detail,
			ownerId: state.ownerId,
			pid: state.pid,
			...(blockingReason
				? { blockingReason, markerAgeMs, forceCommand: "gjc notify recovery --force-daemon-lock" }
				: {}),
		};
	} else {
		daemon = {
			action: "none",
			detail: `dead owner pid ${state.pid} recorded but no lock present`,
			ownerId: state.ownerId,
			pid: state.pid,
		};
	}

	// Stale debris (quarantine targets, exchange placeholders, leaked staging
	// tmp files) accumulates in both the endpoint dir and the daemon dir and
	// slows every later scan; sweep it with positive staleness proof only.
	const debrisRemoved: string[] = [];
	let debrisKept = 0;
	let debrisFailures = 0;
	let debrisScanFailed = false;
	for (const sweepDir of new Set([dir, paths.dir])) {
		const swept = await sweepNotificationDebris({ dir: sweepDir, deps });
		debrisRemoved.push(...swept.removed);
		debrisKept += swept.kept;
		debrisFailures += swept.failures;
		debrisScanFailed ||= swept.scanFailed === true;
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
		debrisRemoved,
		debrisKept,
		debrisFailures,
		...(debrisScanFailed ? { debrisScanFailed } : {}),
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
	if (report.debrisRemoved !== undefined || report.debrisKept !== undefined)
		lines.push(
			`  debris: removed ${report.debrisRemoved?.length ?? 0}, kept ${report.debrisKept ?? 0}, failed ${report.debrisFailures ?? 0}${report.debrisScanFailed ? ", scan failed" : ""}`,
		);
	lines.push(`  daemon: ${report.daemon.action} — ${report.daemon.detail}`);
	if (report.daemon.blockingReason) lines.push(`    - blocking reason: ${report.daemon.blockingReason}`);
	if (report.daemon.markerAgeMs !== undefined)
		lines.push(`    - transition marker age: ${report.daemon.markerAgeMs}ms`);
	if (report.daemon.forceCommand) lines.push(`    - safe escape: ${report.daemon.forceCommand}`);
	return lines.join("\n");
}
