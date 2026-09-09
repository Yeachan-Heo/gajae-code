import { spawn as childProcessSpawn } from "node:child_process";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { nativeProcessBindings } from "@gajae-code/utils/native-process";

type NativeChatDaemonBindings = Pick<typeof import("@gajae-code/natives"), "exactUnlink">;
let nativeChatDaemonBindings: NativeChatDaemonBindings | undefined;

function nativeChatDaemon(): NativeChatDaemonBindings {
	if (!nativeChatDaemonBindings) nativeChatDaemonBindings = require("@gajae-code/natives") as NativeChatDaemonBindings;
	return nativeChatDaemonBindings;
}

import { isEnoent } from "@gajae-code/utils/fs-error";
import type { Settings } from "../../config/settings";
import type {
	BuiltInDaemonController,
	DaemonHealth,
	DaemonOperationOptions,
	DaemonOperationResult,
	DaemonRuntimeInfo,
	DaemonStatus,
} from "../../daemon/control-types";
import { resolveGjcRuntimeSpawnInfo } from "../../daemon/runtime";
import { isProcessIncarnation, processIncarnation } from "../broker/process-incarnation";
import { CHAT_DAEMON_DIRECTORY, CHAT_DAEMON_FILES, canonicalServiceRootDigest } from "../service-artifact-paths";
import { getNotificationConfig, isDiscordComplete, isProviderEffectivelyEnabled, isSlackComplete } from "./config";
import { withDaemonStartupExclusion } from "./daemon-startup-exclusion";
import { type DoctorDaemonControlRequest, isDoctorDaemonControlRequest } from "./doctor-daemon-restart";

export type ChatDaemonKind = "discord" | "slack";
export type ChatDaemonAction = "stop" | "reload";

/**
 * Operational generations of the Discord/Slack daemon lifecycle contracts.
 * These are intentionally separate from per-session endpoint generations.
 * Generation 6 carries the retained managed filesystem authority boundary.
 * Generation 7 restores macOS daemon signaling (kill(2) with a start-time
 * incarnation recheck) so a live/hung owner can be replaced without an external
 * `kill -9`. Generation 8 adopts Windows expected-identity ACL verification and
 * repair for shared native authority. Generation 9 refreshes the shared native
 * authority declaration contract with bounded frame-delivery acknowledgement.
 * Generation 11 accepts typed retained exact-unlink cleanup authority — a
 * concrete detached quarantine plus a proven-absent canonical lock pathname —
 * when deleting an observed owner-lock lease. Generation 12 refreshes retained
 * native path and process authority semantics. Generation 13 rejects special
 * files before retained native authority opens. Generation 14 reloads shared
 * chat daemons after notification configuration parsing changes. Generation 15
 * applies the current notification configuration directly when starting chat
 * daemon transports. Generation 16 applies Telegram sound-policy configuration
 * through shared notification parsing. Generation 17 bound managed-session
 * replacement to exact native filesystem authority; generation 18 retired that
 * binding, and generation 19 binds exact cleanup to parent/link-count authority
 * while also adding durable provider-intent admission without changing lifecycle
 * behavior. Generation 20 discovers isolated chat-only session endpoints when
 * Telegram identity ownership is blocked. Discord generation 21 applies rustfmt
 * and clippy-equivalent cleanup to the pi-shell process-tree authority (#3682).
 * Discord generation 22 / slack generation 21 refreshes retained cleanup
 * semantics; discord generation 23 / slack generation 22 hardens exact Bash
 * process-tree ownership shared by chat daemon cleanup.
 * Discord generation 24 / slack generation 23 apply provider-completeness and
 * effective-enable admission to chat daemon lifecycle controls. Discord
 * generation 25 / slack generation 24 apply identity-bound exact replacement
 * cleanup shared by managed-session and daemon filesystem authority. Discord
 * generation 26 / slack generation 25 add the in-place operator command channel:
 * an owner serves per-request commands inside its own serving loop and answers
 * them against an exact owner tuple, so an owner at an earlier generation may
 * not serve or answer a request captured against this contract. Discord
 * generation 27 / slack generation 26 move shared exact unlink and process-
 * incarnation authority behind lazy native bindings. Discord generation 28 /
 * slack generation 27 dial attached-session clients on the long-lived session
 * reconnect budget, so an owner at an earlier generation gives up reconnecting
 * before the host heartbeat TTL expires and permanently loses its attachment. Discord
 * generation 29 / slack generation 28 advance the replay cursor only after a frame is
 * published, so an owner at an earlier generation acknowledges an event before delivering
 * it and loses that event for good the first time a surface refuses it. Discord generation 30 /
 * slack generation 29 move lifecycle and attachment authority into SDK core; generation 30 also
 * isolates per-session Router attachment failures so one stale endpoint cannot block healthy sessions.
 * Discord generation 31 bounds one REST operation across response parsing and multi-request flows.
 * Slack generation 30 bounds shutdown, tracks outbound work, and fences late effect commits.
 * Slack generation 31 fences late post admission and tracks close-marker shutdown work.
 * Slack generation 32 bounds provider teardown and preserves close markers after Router revocation.
 * Slack generation 33 bounds lifecycle predecessors under the shutdown deadline.
 * Slack generation 34 CAS-fences cleanup mapping commits against successors.
 * Slack generation 35 identity-fences detached startup cleanup from restarted daemon state.
 * Slack generation 36 retains stop ownership for every detached lifecycle generation.
 * Discord generation 32 / Slack generation 37 bind cleanup to the removed attachment generation.
 * Discord generation 33 / Slack generation 38 identity-fence cleanup callbacks on exact attachments.
 * Discord generation 34 / Slack generation 39 clear stale attachment identity before provider reassignment.
 * Discord generation 35 / Slack generation 40 capture provider ownership before cleanup awaits.
 * Discord generation 36 / Slack generation 41 drain prior cleanup before provider restart.
 * Discord generation 37 / Slack generation 42 serialize successor attachment visibility after cleanup.
 * Discord generation 38 / Slack generation 43 hold successor frames behind cleanup settlement.
 * Discord generation 39 / Slack generation 44 recover durable cleanup before attachment publication.
 * Slack generation 45 persists exact pending cleanup intent through recovery.
 * Discord generation 40 bounds provider lifecycle joins before Router revocation.
 * Discord generation 41 / Slack generation 46 revoke Router authority despite provider shutdown failure.
 * Discord generation 42 / Slack generation 47 retain daemon objects across restart to preserve detached lifecycle fences.
 * Discord generation 43 / Slack generation 48 fence Router attachment publication and Broker-adopted endpoint authority.
 * Discord generation 44 / Slack generation 49 retain provider shutdown tails and rejected lifecycle errors so no successor transport starts before ownership settles.
 * Discord generation 45 / Slack generation 50 clean predecessor presentation authority before exact Router replacement and reject post-stop Discord callbacks.
 * Discord generation 46 / Slack generation 51 establish replay barriers before reconnect awaits, distinguish replacement from terminal cleanup, and await lifecycle-fenced Discord inbound work.
 * Discord generation 47 / Slack generation 52 preserve presentation continuity across replacement while exact opaque authority fences stale work.
 * Discord generation 48 / Slack generation 53 allow exact publication-time requests without reconciliation deadlock.
 * Discord generation 49 / Slack generation 54 revalidate endpoint authority before exact publication-time requests.
 * Discord generation 50 / Slack generation 55 terminalize predecessor routes only for a changed same-generation endpoint incarnation.
 * Slack generation 56 clears predecessor inbound receipts before same-generation successor publication.
 * Discord generation 51 / Slack generation 57 persist restart-stable Router endpoint-incarnation authority in provider mappings.
 * Discord generation 52 / Slack generation 58 classify reconnect-time endpoint changes before provider retirement.
 * Discord generation 53 / Slack generation 59 serialize successor attach behind predecessor provider retirement.
 * Discord generation 54 / Slack generation 60 version-fence attaches already in flight when retirement begins.
 * Discord generation 55 / Slack generation 61 fence durable inbound work by exact attachment identity.
 * Discord generation 56 / Slack generation 62 fence durable provider-post and thread-effect recovery by attachment identity.
 * Discord generation 57 removes missing-authority wildcard behavior from durable binding checks.
 * Discord generation 58 preserves exact authority through unarchive replacement fallback.
 * Discord generation 59 / Slack generation 63 derive attachment authority ids from one Router function so persisted provider bindings and live attachments cannot drift apart.
 * Discord generation 62 / Slack generation 65 fence the Windows process-incarnation
 * authority change (#4362): the native binding fallback no longer spawns powershell.exe.
 * Discord generation 63 / Slack generation 66 retain the shared ownership fence
 * unless a zero-signal process probe returns ESRCH. EPERM and unknown failures are
 * indeterminate, so earlier owners must not reclaim, replace, or spawn through them.
 * Discord generation 64 / Slack generation 67 contain synchronous provider-
 * subscription admission and ready-hook failures without revoking shared Router
 * attachment authority.
 * Discord generation 65 / Slack generation 68 fence the off-reconcile-tail
 * initial attachment replay introduced by #4542 so pre-upgrade daemon owners
 * cannot retain the earlier SessionRouter attachment contract.
 * The Discord 67 / Slack 70 fence covers the SessionRouter idle-poll/change-stamp
 * rollout (#4689). Both daemons construct a
 * SessionRouter whose idle tick no longer re-acquires the machine-global
 * session-index lock every 2s; staleness retirement moved to a 30s sweep and
 * lease heartbeats no longer force an authority reconcile. A pre-upgrade owner
 * would retain the old hot polling loop, so replacement is required.
 * Discord generation 72 / Slack generation 75 serialize same-generation
 * successor attachment admission behind predecessor provider retirement, so a
 * pre-upgrade owner cannot retain the queue race fixed by #5120.
 * Slack generation 80 persists and fences the inbound SDK dispatch boundary so
 * crashes, recovery, and attachment retirement cannot replay ambiguous work.
 */
export const CHAT_DAEMON_GENERATIONS: Readonly<Record<ChatDaemonKind, number>> = {
	discord: 75,
	slack: 82,
};

export function chatDaemonGeneration(kind: ChatDaemonKind): number {
	return CHAT_DAEMON_GENERATIONS[kind];
}

export interface ChatDaemonState {
	version: 1;
	kind: ChatDaemonKind;
	pid: number;
	ownerId: string;
	identity: string;
	incarnation: string;
	startedAt: number;
	heartbeatAt: number;
	transportHealthy: boolean;
	generation: number;
	stoppedAt?: number;
	/**
	 * Digest of the canonical (symlink-resolved) agent root this record was
	 * published for. Legacy records omit it and remain non-authorizing for the
	 * D9 cross-bind check: a state record without a matching rootDigest can
	 * never be treated as this root's live owner for that check, even though it
	 * is still valid for every other pre-existing owner check in this module.
	 */
	rootDigest?: string;
}

/**
 * State files are untrusted persisted input. A record must be completely valid
 * before its PID can be treated as an owner, stopped, or safe to replace.
 */
/** A legacy owner is recognized only when the sole missing field is generation. */
export function isRecognizedLegacyGeneration(value: unknown): value is undefined {
	return value === undefined;
}

function hasProcessIncarnationAuthority(incarnation: unknown): incarnation is string {
	return typeof incarnation === "string" && isProcessIncarnation(incarnation);
}

function hasSafeChatDaemonOwnerShape(
	value: unknown,
): value is Omit<ChatDaemonState, "generation"> & { generation?: unknown } {
	if (!value || typeof value !== "object" || Array.isArray(value)) return false;
	const state = value as Record<string, unknown>;
	return (
		state.version === 1 &&
		(state.kind === "discord" || state.kind === "slack") &&
		typeof state.pid === "number" &&
		Number.isSafeInteger(state.pid) &&
		state.pid > 0 &&
		typeof state.ownerId === "string" &&
		state.ownerId.length > 0 &&
		typeof state.identity === "string" &&
		state.identity.length > 0 &&
		hasProcessIncarnationAuthority(state.incarnation) &&
		typeof state.startedAt === "number" &&
		Number.isFinite(state.startedAt) &&
		typeof state.heartbeatAt === "number" &&
		Number.isFinite(state.heartbeatAt) &&
		typeof state.transportHealthy === "boolean" &&
		(state.stoppedAt === undefined || (typeof state.stoppedAt === "number" && Number.isFinite(state.stoppedAt)))
	);
}

export function hasSafeChatDaemonStateShape(value: unknown): value is ChatDaemonState {
	if (!hasSafeChatDaemonOwnerShape(value)) return false;
	const state = value as Record<string, unknown>;
	return typeof state.generation === "number" && Number.isSafeInteger(state.generation) && state.generation >= 0;
}

/**
 * Versions before immutable process provenance persisted this single sentinel.
 * Recover it only after proving its recorded PID is dead; every other malformed
 * record remains fail-closed.
 */
function isExactPreUpgradeUnavailableChatDaemonState(
	value: unknown,
): value is Omit<ChatDaemonState, "generation" | "incarnation"> & { incarnation: "unavailable" } {
	if (!value || typeof value !== "object" || Array.isArray(value)) return false;
	const state = value as Record<string, unknown>;
	const keys = Object.keys(state);
	if (
		keys.some(
			key =>
				key !== "version" &&
				key !== "kind" &&
				key !== "pid" &&
				key !== "ownerId" &&
				key !== "identity" &&
				key !== "incarnation" &&
				key !== "startedAt" &&
				key !== "heartbeatAt" &&
				key !== "transportHealthy" &&
				key !== "stoppedAt",
		)
	)
		return false;
	return (
		state.version === 1 &&
		(state.kind === "discord" || state.kind === "slack") &&
		typeof state.pid === "number" &&
		Number.isSafeInteger(state.pid) &&
		state.pid > 0 &&
		typeof state.ownerId === "string" &&
		state.ownerId.length > 0 &&
		typeof state.identity === "string" &&
		state.identity.length > 0 &&
		state.incarnation === "unavailable" &&
		typeof state.startedAt === "number" &&
		Number.isFinite(state.startedAt) &&
		typeof state.heartbeatAt === "number" &&
		Number.isFinite(state.heartbeatAt) &&
		typeof state.transportHealthy === "boolean" &&
		(state.stoppedAt === undefined || (typeof state.stoppedAt === "number" && Number.isFinite(state.stoppedAt)))
	);
}

function hasChatDaemonStatePid(value: unknown): value is { pid: number } {
	return (
		!!value &&
		typeof value === "object" &&
		typeof (value as { pid?: unknown }).pid === "number" &&
		Number.isSafeInteger((value as { pid: number }).pid) &&
		(value as { pid: number }).pid > 0
	);
}

export interface ChatDaemonControlRequest {
	version: 1;
	requestId: string;
	action: ChatDaemonAction;
	ownerId: string;
	pid: number;
	createdAt: number;
	incarnation: string;
}

export interface ChatDaemonProcessReference {
	incarnation: string;
	signalRoot(signal: NodeJS.Signals): void;
}

function defaultProcessReference(pid: number, platform = os.platform()): ChatDaemonProcessReference | undefined {
	try {
		const processRef = nativeProcessBindings().Process.fromPid(pid);
		if (!processRef || !hasProcessIncarnationAuthority(processRef.incarnation)) return undefined;
		const incarnation = processRef.incarnation;
		return {
			incarnation,
			signalRoot: signal => {
				const nativeSignal = os.constants.signals[signal];
				if (nativeSignal === undefined) throw new Error(`Unsupported signal: ${signal}`);
				// macOS exposes no pidfd and the native signal_root is a no-op there, so
				// the daemon control plane previously had NO way to signal a live owner —
				// every stop/reload of a live/hung daemon refused, and only an external
				// `kill -9` could recover it. Signal by numeric PID via kill(2), but
				// re-read the immutable start-time incarnation immediately beforehand so a
				// PID that exited and was reused since capture is never signaled.
				if (platform === "darwin") {
					const current = nativeProcessBindings().Process.fromPid(pid) as { incarnation?: unknown } | null;
					if (!current || current.incarnation !== incarnation) throw new Error("Pinned process is already gone");
					process.kill(pid, signal);
					return;
				}
				const rootProcess = processRef as typeof processRef & { signalRoot(signal: number): boolean };
				if (!rootProcess.signalRoot(nativeSignal)) throw new Error("Pinned process is already gone");
			},
		};
	} catch {
		return undefined;
	}
}

export interface ChatDaemonControlDeps {
	pidAlive?: (pid: number) => boolean;
	processReference?: (pid: number) => ChatDaemonProcessReference | undefined;
	spawn?: (command: string, args: string[], opts: { detached: boolean; stdio: "ignore" }) => { unref?: () => void };
	execPath?: string;
	ownerPid?: number;
	randomId?: () => string;
	pidIncarnation?: (pid: number) => string | undefined;
	/** Test seam for platform-specific default stable-process authority. */
	platform?: NodeJS.Platform;
	sleep?: (ms: number) => Promise<void>;
	spawnReadyTimeoutMs?: number;
}

const HEARTBEAT_TTL_MS = 20_000;
const DEFAULT_GRACEFUL_TIMEOUT_MS = 8_000;
const DEFAULT_KILL_TIMEOUT_MS = 3_000;
/** Covers Discord READY plus its first 5-second heartbeat; tests inject a smaller timeout. */
const DEFAULT_SPAWN_READY_TIMEOUT_MS = 8_000;

/**
 * `version`/`ownerId`/`rootDigest` are the D9 cross-bind receipt delta: a
 * legacy lock predating this generation omits them. Legacy records remain
 * valid, signalable owner locks for every existing check in this module —
 * they are simply non-authorizing for a D9 cross-bind check that requires a
 * matching `ownerId`/`rootDigest` against the sibling state record.
 */
export interface ChatDaemonOwnerLock {
	version?: 1;
	pid: number;
	incarnation: string;
	createdAt: number;
	ownerId?: string;
	rootDigest?: string;
}

export interface ChatDaemonOwnerLockLease {
	content: string;
	dev: bigint;
	ino: bigint;
	size: bigint;
	mtimeNs: bigint;
	nlink: bigint;
	parentDev: bigint;
	parentIno: bigint;
	sha256: string;
}

/** Result of a bounded, no-follow owner-lock lease capture. Only `"absent"` (ENOENT) means the lock currently does not exist; every other failure is `"unreadable"` and must never be treated as absence. */
export type ChatDaemonOwnerLockLeaseResult =
	| { status: "present"; lease: ChatDaemonOwnerLockLease }
	| { status: "absent" }
	| { status: "unreadable" };

const CHAT_DAEMON_OWNER_LOCK_LEASE_MAX_BYTES = 64 * 1024;

/** Matches the canonical no-follow, non-blocking lock-info open flags used by config/file-lock.ts. */
const CHAT_DAEMON_OWNER_LOCK_OPEN_FLAGS =
	fs.constants.O_RDONLY |
	(process.platform === "win32" ? 0 : (fs.constants.O_NOFOLLOW ?? 0) | (fs.constants.O_NONBLOCK ?? 0));

interface ChatDaemonOwnershipProbe {
	pidAlive(pid: number): boolean;
	pidIncarnation(pid: number): string | undefined;
}

export function chatDaemonPaths(
	agentDir: string,
	kind: ChatDaemonKind,
): { dir: string; lock: string; state: string; control: string } {
	const dir = path.join(agentDir, CHAT_DAEMON_DIRECTORY, kind);
	return {
		dir,
		lock: path.join(dir, CHAT_DAEMON_FILES.ownerLock),
		state: path.join(dir, CHAT_DAEMON_FILES.state),
		control: path.join(dir, CHAT_DAEMON_FILES.control),
	};
}

export function chatDoctorControlRequestPath(agentDir: string, kind: ChatDaemonKind): string {
	return path.join(chatDaemonPaths(agentDir, kind).dir, "doctor-restart.control.json");
}

export async function readChatDoctorControlRequest(
	agentDir: string,
	kind: ChatDaemonKind,
): Promise<DoctorDaemonControlRequest | undefined> {
	try {
		const parsed = JSON.parse(
			await fs.promises.readFile(chatDoctorControlRequestPath(agentDir, kind), "utf8"),
		) as unknown;
		return isDoctorDaemonControlRequest(parsed) && parsed.owner === kind ? parsed : undefined;
	} catch {
		return undefined;
	}
}

export async function writeChatDoctorControlRequest(
	agentDir: string,
	kind: ChatDaemonKind,
	request: DoctorDaemonControlRequest,
): Promise<void> {
	if (request.owner !== kind) throw new Error(`${kind} doctor request owner mismatch`);
	const file = chatDoctorControlRequestPath(agentDir, kind);
	await fs.promises.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
	const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
	await fs.promises.writeFile(tmp, `${JSON.stringify(request)}\n`, { mode: 0o600 });
	await fs.promises.rename(tmp, file);
}

export async function clearChatDoctorControlRequest(
	agentDir: string,
	kind: ChatDaemonKind,
	requestId?: string,
): Promise<void> {
	const file = chatDoctorControlRequestPath(agentDir, kind);
	if (requestId && (await readChatDoctorControlRequest(agentDir, kind))?.requestId !== requestId) return;
	await fs.promises.unlink(file).catch(() => undefined);
}

/**
 * Configuration fingerprint that identifies which settings a daemon owner was
 * started for. `undefined` means the current settings cannot configure that
 * transport at all, so no owner can be authorized against them.
 */
export function chatDaemonIdentity(settings: Settings, kind: ChatDaemonKind): string | undefined {
	return identityFor(settings, kind);
}

function identityFor(settings: Settings, kind: ChatDaemonKind): string | undefined {
	const cfg = getNotificationConfig(settings);
	if (kind === "discord") {
		if (!isDiscordComplete(cfg)) return undefined;
		return fingerprint([
			cfg.discord.botToken,
			cfg.discord.applicationId,
			cfg.discord.guildId,
			cfg.discord.parentChannelId,
			String(cfg.redact),
			cfg.verbosity,
		]);
	}
	if (!isSlackComplete(cfg)) return undefined;
	return fingerprint([
		cfg.slack.botToken,
		cfg.slack.appToken,
		cfg.slack.workspaceId,
		cfg.slack.channelId,
		cfg.slack.authorizedUserId ?? "",
		String(cfg.redact),
		cfg.verbosity,
	]);
}

function fingerprint(values: string[]): string {
	return crypto.createHash("sha256").update(values.join("\0")).digest("hex").slice(0, 16);
}
function defaultPidAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		// Only ESRCH proves the process is gone. EPERM and other probe failures are
		// indeterminate and must retain ownership rather than permit replacement.
		return (error as NodeJS.ErrnoException).code !== "ESRCH";
	}
}
/** Windows process ownership uses immutable StartTime/FileTime provenance through
 * the shared native/platform authority. Without authority, numeric PIDs are never trusted. */
function defaultPidIncarnation(pid: number): string | undefined {
	return processIncarnation(pid);
}
function runtimeInfo(execPath?: string): DaemonRuntimeInfo {
	const rt = resolveGjcRuntimeSpawnInfo(execPath ?? process.execPath);
	return {
		mode: rt.mode,
		execPath: rt.execPath,
		reloadPicksUpSourceEdits: rt.reloadPicksUpSourceEdits,
		warning: rt.warning,
	};
}

const stateWriteTails = new Map<string, Promise<void>>();

async function withStateWriteLock<T>(file: string, operation: () => Promise<T>): Promise<T> {
	const previous = stateWriteTails.get(file) ?? Promise.resolve();
	const gate = Promise.withResolvers<void>();
	const tail = previous.then(() => gate.promise);
	stateWriteTails.set(file, tail);
	await previous;
	try {
		return await operation();
	} finally {
		gate.resolve();
		if (stateWriteTails.get(file) === tail) stateWriteTails.delete(file);
	}
}

async function readJson<T>(file: string): Promise<T | undefined> {
	try {
		return JSON.parse(await fs.promises.readFile(file, "utf8")) as T;
	} catch {
		return undefined;
	}
}
async function writeJson(file: string, value: unknown): Promise<void> {
	await fs.promises.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
	const tmp = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`;
	try {
		await fs.promises.writeFile(tmp, `${JSON.stringify(value)}\n`, { mode: 0o600 });
		await fs.promises.rename(tmp, file);
	} catch (error) {
		await fs.promises.unlink(tmp).catch(() => undefined);
		throw error;
	}
}

export async function readChatDaemonState(
	agentDir: string,
	kind: ChatDaemonKind,
): Promise<ChatDaemonState | undefined> {
	return await readJson(chatDaemonPaths(agentDir, kind).state);
}
export async function readChatDaemonControlRequest(
	agentDir: string,
	kind: ChatDaemonKind,
): Promise<ChatDaemonControlRequest | undefined> {
	return await readJson(chatDaemonPaths(agentDir, kind).control);
}
export async function writeChatDaemonControlRequest(
	agentDir: string,
	kind: ChatDaemonKind,
	request: ChatDaemonControlRequest,
): Promise<void> {
	await writeJson(chatDaemonPaths(agentDir, kind).control, request);
}
export async function clearChatDaemonControlRequest(
	agentDir: string,
	kind: ChatDaemonKind,
	requestId?: string,
): Promise<void> {
	const paths = chatDaemonPaths(agentDir, kind);
	if (requestId && (await readChatDaemonControlRequest(agentDir, kind))?.requestId !== requestId) return;
	await fs.promises.unlink(paths.control).catch(() => undefined);
}

export function buildChatDaemonSpawnArgs(input: {
	kind: ChatDaemonKind;
	ownerId: string;
	agentDir: string;
	execPath?: string;
}): { command: string; args: string[]; runtime: DaemonRuntimeInfo } {
	const rt = resolveGjcRuntimeSpawnInfo(input.execPath ?? process.execPath);
	return {
		command: rt.execPath,
		args: [
			...rt.argsPrefix,
			"daemon",
			`${input.kind}-internal`,
			"--owner-id",
			input.ownerId,
			"--agent-dir",
			input.agentDir,
		],
		runtime: runtimeInfo(input.execPath),
	};
}

type ChatDaemonStateClassification =
	| "absent"
	| "replaceable"
	| "compatible"
	| "newer"
	| "malformed"
	| "unauthorized"
	| "stopped";

export class ChatDaemonController implements BuiltInDaemonController {
	readonly kind: ChatDaemonKind;
	constructor(
		private readonly settings: Settings,
		kind: ChatDaemonKind,
		private readonly deps: ChatDaemonControlDeps = {},
	) {
		this.kind = kind;
	}
	private identity(): string | undefined {
		return identityFor(this.settings, this.kind);
	}
	private effectivelyEnabled(): boolean {
		return isProviderEffectivelyEnabled(getNotificationConfig(this.settings), this.kind);
	}
	private alive(pid: number): boolean {
		return (this.deps.pidAlive ?? defaultPidAlive)(pid);
	}
	async status(): Promise<DaemonStatus> {
		const runtime = runtimeInfo(this.deps.execPath);
		const identity = this.identity();
		const state = await readChatDaemonState(this.settings.getAgentDir(), this.kind);
		if (!identity) return { kind: this.kind, configured: false, health: "not_configured", runtime };
		const health: DaemonHealth = this.stateHealth(state, identity);
		return {
			kind: this.kind,
			configured: true,
			health,
			pid: state?.pid,
			ownerId: state?.ownerId,
			startedAt: state?.startedAt,
			heartbeatAt: state?.heartbeatAt,
			runtime,
		};
	}
	async stop(opts: DaemonOperationOptions = {}): Promise<DaemonOperationResult> {
		return await this.operate("stop", opts);
	}
	async reload(opts: DaemonOperationOptions = {}): Promise<DaemonOperationResult> {
		return await this.operate("reload", opts);
	}
	async ensure(): Promise<EnsureChatDaemonResult> {
		if (!this.effectivelyEnabled()) return "disabled";
		const identity = this.identity();
		if (!identity) return "disabled";
		const existing = await readChatDaemonState(this.settings.getAgentDir(), this.kind);
		const classification = this.classify(existing, identity);
		if (classification === "malformed" || classification === "unauthorized")
			throw new Error(`Unable to replace unauthorized ${this.kind} daemon owner`);
		if (existing && this.isSignalableMatchingOwner(existing)) {
			if (classification === "compatible" || classification === "newer") {
				// A compatible, physically-live owner may be mid-startup: a concurrent
				// ensure can have just acquired ownership and published transportHealthy:false
				// before its transport heartbeats healthy. Wait bounded for that owner to
				// become attachable instead of failing a racing startup outright.
				if (this.isHealthyFreshState(existing) || (await this.waitForOwnership(existing.ownerId, identity)))
					return "attached";
				if (classification === "newer")
					throw new Error(`Unable to replace newer ${this.kind} daemon owner; upgrade this controller`);
				throw new Error(`Unable to replace unhealthy ${this.kind} daemon owner`);
			}
			await this.stopForReplacement(existing);
		}
		const spawned = await this.spawn();
		if (spawned) return "owner_spawned";
		const replacement = await readChatDaemonState(this.settings.getAgentDir(), this.kind);
		if (replacement && this.isCurrentCompatibleState(replacement, identity)) return "attached";
		throw new Error(`Unable to attach or spawn ${this.kind} daemon owner`);
	}

	private async operate(action: ChatDaemonAction, opts: DaemonOperationOptions): Promise<DaemonOperationResult> {
		const before = await this.status();
		const warnings = before.runtime.warning ? [before.runtime.warning] : [];
		if (!before.configured)
			return this.result(action, false, `${this.kind} notifications are not configured`, before, before, warnings);
		if (action === "reload" && !this.effectivelyEnabled() && !opts.allowDisabledNoop) {
			return this.result(action, false, `${this.kind} notifications are not enabled`, before, before, warnings);
		}
		if (action === "reload" && !this.effectivelyEnabled())
			return this.result(
				action,
				true,
				`${this.kind} notifications are disabled; leaving daemon stopped`,
				before,
				before,
				warnings,
			);
		const state = await readChatDaemonState(this.settings.getAgentDir(), this.kind);
		const classification = this.classify(state, this.identity());
		if (classification === "newer")
			return this.result(
				action,
				false,
				`${this.kind} daemon is newer than this controller; upgrade this controller before ${action}`,
				before,
				before,
				warnings,
			);
		if (classification === "malformed" || classification === "unauthorized")
			return this.result(
				action,
				false,
				`${this.kind} daemon ownership changed; refusing to signal`,
				before,
				await this.status(),
				warnings,
			);
		if (!state || !this.isSignalableMatchingOwner(state)) {
			if (action === "stop") {
				if (state && this.isAmbiguouslyLiveState(state))
					return this.result(
						action,
						false,
						`${this.kind} daemon ownership changed; refusing to signal`,
						before,
						before,
						warnings,
					);
				return this.result(action, true, `no running ${this.kind} daemon`, before, before, warnings);
			}
			if (opts.spawnIfStopped === false)
				return this.result(action, true, `no running ${this.kind} daemon to reload`, before, before, warnings);
			if (!this.effectivelyEnabled())
				return this.result(action, false, `${this.kind} notifications are not enabled`, before, before, warnings);
			const spawned = await this.spawn();
			return this.result(
				action,
				spawned,
				spawned
					? `spawned fresh ${this.kind} daemon`
					: `${this.kind} daemon did not publish ownership after spawning`,
				before,
				await this.status(),
				warnings,
			);
		}
		if (state.identity !== this.identity() || !this.ownsCapturedState(state, before))
			return this.result(
				action,
				false,
				`${this.kind} daemon ownership changed; refusing to signal`,
				before,
				await this.status(),
				warnings,
			);
		const requestId = this.deps.randomId?.() ?? crypto.randomUUID();
		await writeChatDaemonControlRequest(this.settings.getAgentDir(), this.kind, {
			version: 1,
			requestId,
			action,
			ownerId: state.ownerId,
			pid: state.pid,
			incarnation: state.incarnation,
			createdAt: Date.now(),
		});
		if (!(await this.signalIfOwner(state, "SIGTERM"))) return this.ownerChanged(action, requestId, before, warnings);
		let dead = await this.waitForDeath(state.pid, opts.gracefulTimeoutMs ?? DEFAULT_GRACEFUL_TIMEOUT_MS);
		if (!dead && opts.force) {
			if (!(await this.signalIfOwner(state, "SIGKILL")))
				return this.ownerChanged(action, requestId, before, warnings);
			dead = await this.waitForDeath(state.pid, opts.killTimeoutMs ?? DEFAULT_KILL_TIMEOUT_MS);
		}
		if (!dead) {
			await clearChatDaemonControlRequest(this.settings.getAgentDir(), this.kind, requestId);
			const after = await this.status();
			return this.result(
				action,
				false,
				opts.force ? "old daemon did not exit after SIGKILL" : "old daemon did not exit; rerun with --force",
				before,
				after,
				warnings,
			);
		}
		await clearChatDaemonControlRequest(this.settings.getAgentDir(), this.kind, requestId);
		if (action === "stop")
			return this.result(action, true, `stopped ${this.kind} daemon`, before, await this.status(), warnings);
		if (!this.effectivelyEnabled())
			return this.result(
				action,
				false,
				`${this.kind} notifications are not enabled`,
				before,
				await this.status(),
				warnings,
			);
		const spawned = await this.spawn();
		return this.result(
			action,
			spawned,
			spawned ? `reloaded ${this.kind} daemon` : `a live ${this.kind} owner already exists`,
			before,
			await this.status(),
			warnings,
		);
	}
	private incarnation(pid: number): string | undefined {
		return (this.deps.pidIncarnation ?? processIncarnation)(pid);
	}
	private processReference(pid: number): ChatDaemonProcessReference | undefined {
		return this.deps.processReference
			? this.deps.processReference(pid)
			: defaultProcessReference(pid, this.deps.platform);
	}
	private isDefinitelyStoppedState(state: ChatDaemonState | undefined): boolean {
		if (isExactPreUpgradeUnavailableChatDaemonState(state)) return !this.alive(state.pid);
		if (!state || !hasSafeChatDaemonOwnerShape(state)) return false;
		if (!this.alive(state.pid)) return true;
		// Proven PID reuse means this persisted owner is gone. The distinct live PID
		// remains nonsignalable because isSignalableMatchingOwner requires equality.
		const incarnation = this.incarnation(state.pid);
		return hasProcessIncarnationAuthority(incarnation) && incarnation !== state.incarnation;
	}
	private stateHealth(state: ChatDaemonState | undefined, identity: string): DaemonHealth {
		if (!state || this.isDefinitelyStoppedState(state)) return "stopped";
		if (this.isCurrentCompatibleState(state, identity)) return "running";
		// A PID that is live but cannot prove a matching current incarnation is
		// ambiguous: do not report it ready or overwrite it.
		return "stale";
	}
	private isSignalableMatchingOwner(state: ChatDaemonState): boolean {
		const incarnation = this.incarnation(state.pid);
		return (
			hasSafeChatDaemonOwnerShape(state) &&
			state.kind === this.kind &&
			state.stoppedAt === undefined &&
			this.alive(state.pid) &&
			hasProcessIncarnationAuthority(incarnation) &&
			incarnation === state.incarnation
		);
	}
	/** A live PID with an invalid ownership record is never safe to overwrite. */
	private isAmbiguouslyLiveState(state: ChatDaemonState): boolean {
		return !this.isDefinitelyStoppedState(state) && !this.isSignalableMatchingOwner(state);
	}

	private isHealthyFreshState(state: ChatDaemonState): boolean {
		return (
			hasSafeChatDaemonStateShape(state) &&
			state.transportHealthy &&
			Date.now() - state.heartbeatAt <= HEARTBEAT_TTL_MS
		);
	}
	private classify(state: ChatDaemonState | undefined, identity: string | undefined): ChatDaemonStateClassification {
		if (!state) return "absent";
		if (isExactPreUpgradeUnavailableChatDaemonState(state)) return this.alive(state.pid) ? "malformed" : "stopped";
		if (!hasSafeChatDaemonOwnerShape(state)) return "malformed";
		if (this.isDefinitelyStoppedState(state)) return "stopped";
		if (!identity || state.kind !== this.kind || state.identity !== identity) return "unauthorized";
		if (hasSafeChatDaemonStateShape(state)) {
			if (state.generation < chatDaemonGeneration(this.kind)) return "replaceable";
			return state.generation > chatDaemonGeneration(this.kind) ? "newer" : "compatible";
		}
		const generation = (state as { generation?: unknown }).generation;
		return isRecognizedLegacyGeneration(generation) ? "replaceable" : "malformed";
	}
	private isCurrentCompatibleState(state: ChatDaemonState, identity: string): boolean {
		const classification = this.classify(state, identity);
		return (
			this.isSignalableMatchingOwner(state) &&
			this.isHealthyFreshState(state) &&
			(classification === "compatible" || classification === "newer")
		);
	}

	private async stopForReplacement(state: ChatDaemonState): Promise<void> {
		if (!this.isSignalableMatchingOwner(state)) return;

		const requestId = this.deps.randomId?.() ?? crypto.randomUUID();
		await writeChatDaemonControlRequest(this.settings.getAgentDir(), this.kind, {
			version: 1,
			requestId,
			action: "reload",
			ownerId: state.ownerId,
			pid: state.pid,
			incarnation: state.incarnation,
			createdAt: Date.now(),
		});
		try {
			if (!(await this.signalIfOwner(state, "SIGTERM")))
				throw new Error(`${this.kind} daemon ownership changed; refusing replacement`);
			let dead = await this.waitForDeath(state.pid, DEFAULT_GRACEFUL_TIMEOUT_MS);
			if (!dead) {
				if (!(await this.signalIfOwner(state, "SIGKILL")))
					throw new Error(`${this.kind} daemon ownership changed; refusing replacement`);
				dead = await this.waitForDeath(state.pid, DEFAULT_KILL_TIMEOUT_MS);
			}
			if (!dead) throw new Error(`Old ${this.kind} daemon did not exit before replacement`);
		} finally {
			await clearChatDaemonControlRequest(this.settings.getAgentDir(), this.kind, requestId);
		}
	}

	private ownsCapturedState(state: ChatDaemonState, before: DaemonStatus): boolean {
		return (
			state.ownerId === before.ownerId &&
			state.pid === before.pid &&
			Boolean(state.incarnation) &&
			this.isSignalableMatchingOwner(state)
		);
	}
	private async signalIfOwner(state: ChatDaemonState, signal: NodeJS.Signals): Promise<boolean> {
		const current = await readChatDaemonState(this.settings.getAgentDir(), this.kind);
		const identity = this.identity();
		const classification = this.classify(current, identity);
		if (
			!identity ||
			!current ||
			current.ownerId !== state.ownerId ||
			current.pid !== state.pid ||
			current.identity !== state.identity ||
			current.incarnation !== state.incarnation ||
			current.generation !== state.generation ||
			(classification !== "compatible" && classification !== "replaceable") ||
			!this.isSignalableMatchingOwner(current)
		)
			return false;
		const processRef = this.processReference(state.pid);
		// Numeric PIDs can be reused after the ordinary provenance recheck. Only the
		// native stable reference may perform this privileged signal operation.
		if (!processRef || processRef.incarnation !== state.incarnation) return false;
		try {
			processRef.signalRoot(signal);
			return true;
		} catch {
			return false;
		}
	}
	private async ownerChanged(
		action: ChatDaemonAction,
		requestId: string,
		before: DaemonStatus,
		warnings: string[],
	): Promise<DaemonOperationResult> {
		await clearChatDaemonControlRequest(this.settings.getAgentDir(), this.kind, requestId);
		return this.result(
			action,
			false,
			`${this.kind} daemon ownership changed; refusing to signal`,
			before,
			await this.status(),
			warnings,
		);
	}
	private result(
		action: ChatDaemonAction,
		ok: boolean,
		message: string,
		before: DaemonStatus,
		after: DaemonStatus,
		warnings: string[],
	): DaemonOperationResult {
		return { kind: this.kind, action, ok, message, before, after, warnings };
	}
	private async waitForDeath(pid: number, timeout: number): Promise<boolean> {
		const until = Date.now() + timeout;
		while (this.alive(pid) && Date.now() < until) await this.sleep(25);
		return !this.alive(pid);
	}
	private sleep(ms: number): Promise<void> {
		return this.deps.sleep ? this.deps.sleep(ms) : new Promise(resolve => setTimeout(resolve, ms));
	}
	private async spawn(): Promise<boolean> {
		if (!this.effectivelyEnabled()) return false;
		const identity = this.identity();
		if (!identity) return false;
		const paths = chatDaemonPaths(this.settings.getAgentDir(), this.kind);
		await fs.promises.mkdir(paths.dir, { recursive: true, mode: 0o700 });
		const existing = await readChatDaemonState(this.settings.getAgentDir(), this.kind);
		const classification = this.classify(existing, identity);
		if (classification === "malformed" || classification === "unauthorized") return false;
		if (existing && (this.isSignalableMatchingOwner(existing) || this.isAmbiguouslyLiveState(existing))) return false;

		const ownerId = `${this.deps.ownerPid ?? process.ppid}-${this.deps.randomId?.() ?? crypto.randomUUID()}`;
		const { command, args } = buildChatDaemonSpawnArgs({
			kind: this.kind,
			ownerId,
			agentDir: this.settings.getAgentDir(),
			execPath: this.deps.execPath,
		});
		if (!this.effectivelyEnabled() || this.identity() !== identity) return false;
		(this.deps.spawn ?? ((command, args, opts) => childProcessSpawn(command, args, opts)))(command, args, {
			detached: true,
			stdio: "ignore",
		}).unref?.();
		return await this.waitForOwnership(ownerId, identity);
	}
	private async waitForOwnership(ownerId: string, identity: string): Promise<boolean> {
		const timeoutMs = Math.max(this.deps.spawnReadyTimeoutMs ?? DEFAULT_SPAWN_READY_TIMEOUT_MS, 0);
		const until = Date.now() + timeoutMs;
		const maxPolls = Math.ceil(timeoutMs / 25);
		for (let poll = 0; poll <= maxPolls; poll++) {
			const state = await readChatDaemonState(this.settings.getAgentDir(), this.kind);
			const classification = state ? this.classify(state, identity) : undefined;
			if (
				state &&
				state.ownerId === ownerId &&
				(classification === "compatible" || classification === "newer") &&
				this.isCurrentCompatibleState(state, identity)
			)
				return true;
			if (Date.now() >= until || poll === maxPolls) return false;
			await this.sleep(25);
		}
		return false;
	}
}

export type EnsureChatDaemonResult = "disabled" | "owner_spawned" | "attached";

async function ensureChatDaemon(
	kind: ChatDaemonKind,
	settings: Settings,
	deps: ChatDaemonControlDeps = {},
): Promise<EnsureChatDaemonResult> {
	return await new ChatDaemonController(settings, kind, deps).ensure();
}

export async function ensureDiscordDaemon(
	settings: Settings,
	deps: ChatDaemonControlDeps = {},
): Promise<EnsureChatDaemonResult> {
	return await ensureChatDaemon("discord", settings, deps);
}

export async function ensureSlackDaemon(
	settings: Settings,
	deps: ChatDaemonControlDeps = {},
): Promise<EnsureChatDaemonResult> {
	return await ensureChatDaemon("slack", settings, deps);
}

export interface AcquireChatDaemonOwnershipInput {
	agentDir: string;
	kind: ChatDaemonKind;
	ownerId: string;
	pid?: number;
	identity: string;
	incarnation?: string;
	pidAlive?: (pid: number) => boolean;
	pidIncarnation?: (pid: number) => string | undefined;
}

/**
 * Actual publication body. Runs ONLY inside {@link withDaemonStartupExclusion}
 * (see {@link acquireChatDaemonOwnership}); never call this directly, and
 * never call it from inside another already-held startup-exclusion guard for
 * the same `(agentDir, kind)` — that would be a self-deadlocking reacquisition
 * of a non-reentrant lock.
 */
async function acquireChatDaemonOwnershipLocked(input: AcquireChatDaemonOwnershipInput): Promise<boolean> {
	const paths = chatDaemonPaths(input.agentDir, input.kind);
	const pid = input.pid ?? process.pid;
	const probe: ChatDaemonOwnershipProbe = {
		pidAlive: input.pidAlive ?? defaultPidAlive,
		pidIncarnation: input.pidIncarnation ?? processIncarnation,
	};
	const incarnation = input.incarnation ?? probe.pidIncarnation(pid);
	if (!hasProcessIncarnationAuthority(incarnation)) return false;

	await fs.promises.mkdir(paths.dir, { recursive: true, mode: 0o700 });
	const existing = await readJson<unknown>(paths.state);
	// A live record remains fenced unless authoritative provenance proves the PID
	// was reused. This permits recovery without ever signaling that replacement.
	if (hasChatDaemonStatePid(existing) && probe.pidAlive(existing.pid)) {
		const current = probe.pidIncarnation(existing.pid);
		if (
			!hasSafeChatDaemonOwnerShape(existing) ||
			!hasProcessIncarnationAuthority(current) ||
			current === existing.incarnation
		)
			return false;
	}
	// Existing root: withDaemonStartupExclusion has already acquired its guard
	// under this same agentDir, so the directory chain up to it exists.
	const rootDigest = await canonicalServiceRootDigest(input.agentDir);
	const owner: ChatDaemonOwnerLock = {
		version: 1,
		pid,
		incarnation,
		createdAt: Date.now(),
		ownerId: input.ownerId,
		rootDigest,
	};
	let lock = await createChatDaemonOwnerLock(paths.lock, owner);
	if (!lock) {
		if (!(await reclaimChatDaemonOwnerLock(paths.lock, paths.state, probe))) return false;
		lock = await createChatDaemonOwnerLock(paths.lock, owner);
		if (!lock) return false;
	}
	return await withStateWriteLock(paths.state, async () => {
		if (!(await ownsChatDaemonOwnerLock(paths.lock, lock))) return false;
		await writeJson(paths.state, {
			version: 1,
			kind: input.kind,
			pid,
			ownerId: input.ownerId,
			identity: input.identity,
			incarnation,
			startedAt: Date.now(),
			heartbeatAt: Date.now(),
			transportHealthy: false,
			generation: chatDaemonGeneration(input.kind),
			rootDigest,
		} satisfies ChatDaemonState);
		return true;
	});
}

/**
 * Publishes this process as the `(agentDir, kind)` chat daemon owner
 * (owner.lock + state.json). Runs behind the shared cross-process startup
 * exclusion so it can never race a doctor startup/maintenance repair that
 * holds the same guard (e.g. detaching a stale owner-lock quarantine) — the
 * guard is acquired here and released before returning; the actual
 * lock-creation/state-publication logic lives in the unlocked
 * {@link acquireChatDaemonOwnershipLocked} so the guard is never held across
 * a nested reacquisition of itself.
 */
export async function acquireChatDaemonOwnership(input: AcquireChatDaemonOwnershipInput): Promise<boolean> {
	return await withDaemonStartupExclusion(input.agentDir, input.kind, () => acquireChatDaemonOwnershipLocked(input));
}

async function createChatDaemonOwnerLock(
	lock: string,
	owner: ChatDaemonOwnerLock,
): Promise<ChatDaemonOwnerLockLease | undefined> {
	const content = `${JSON.stringify(owner)}\n`;
	const temporary = `${lock}.${process.pid}.${crypto.randomUUID()}.tmp`;
	try {
		const handle = await fs.promises.open(temporary, "wx", 0o600);
		try {
			await handle.writeFile(content, "utf8");
			await handle.sync();
		} finally {
			await handle.close();
		}
		try {
			await fs.promises.link(temporary, lock);
		} catch (error) {
			if (isAlreadyExists(error)) return undefined;
			throw error;
		}
		await fs.promises.unlink(temporary);
		return await captureChatDaemonOwnerLockLeaseOrUndefined(lock);
	} finally {
		await fs.promises.unlink(temporary).catch(() => undefined);
	}
}

/**
 * Bounded, no-follow, non-blocking owner-lock lease capture. Opens with the
 * same `O_NOFOLLOW|O_NONBLOCK` posture as the canonical lock-info reader in
 * config/file-lock.ts, reads at most {@link CHAT_DAEMON_OWNER_LOCK_LEASE_MAX_BYTES}
 * bytes through the open descriptor (never an unbounded `readFile`), and
 * revalidates identity/parent-directory metadata before and after the read so a
 * TOCTOU replacement during the read is detected rather than silently trusted.
 *
 * Only `ENOENT` on the initial open means the lock is currently absent.
 * SYMLINK, FIFO/special-file, oversize, and any other I/O failure are all
 * `"unreadable"` — distinct from absence, and callers must not treat them as
 * "no lock exists".
 */
export async function captureChatDaemonOwnerLockLease(lock: string): Promise<ChatDaemonOwnerLockLeaseResult> {
	let handle: fs.promises.FileHandle | undefined;
	try {
		try {
			handle = await fs.promises.open(lock, CHAT_DAEMON_OWNER_LOCK_OPEN_FLAGS);
		} catch (error) {
			if (isEnoent(error)) return { status: "absent" };
			return { status: "unreadable" };
		}
		const before = await handle.stat({ bigint: true });
		const parentBefore = await fs.promises.lstat(path.dirname(lock), { bigint: true });
		if (!before.isFile() || before.size > BigInt(CHAT_DAEMON_OWNER_LOCK_LEASE_MAX_BYTES))
			return { status: "unreadable" };
		const buffer = Buffer.alloc(CHAT_DAEMON_OWNER_LOCK_LEASE_MAX_BYTES);
		let length = 0;
		while (length < buffer.length) {
			const read = await handle.read(buffer, length, buffer.length - length, length);
			if (read.bytesRead === 0) break;
			length += read.bytesRead;
		}
		const content = buffer.subarray(0, length).toString("utf8");
		const after = await handle.stat({ bigint: true });
		let pathname: fs.BigIntStats;
		let parentAfter: fs.BigIntStats;
		try {
			pathname = await fs.promises.lstat(lock, { bigint: true });
			parentAfter = await fs.promises.lstat(path.dirname(lock), { bigint: true });
		} catch {
			return { status: "unreadable" };
		}
		if (
			!after.isFile() ||
			!pathname.isFile() ||
			pathname.isSymbolicLink() ||
			before.nlink !== 1n ||
			pathname.nlink !== 1n ||
			!parentBefore.isDirectory() ||
			parentBefore.isSymbolicLink() ||
			parentBefore.dev !== parentAfter.dev ||
			parentBefore.ino !== parentAfter.ino ||
			before.dev !== after.dev ||
			before.ino !== after.ino ||
			before.size !== after.size ||
			before.mtimeNs !== after.mtimeNs ||
			before.dev !== pathname.dev ||
			before.ino !== pathname.ino ||
			before.size !== pathname.size ||
			before.mtimeNs !== pathname.mtimeNs ||
			after.size > BigInt(CHAT_DAEMON_OWNER_LOCK_LEASE_MAX_BYTES)
		)
			return { status: "unreadable" };
		return {
			status: "present",
			lease: {
				content,
				dev: before.dev,
				ino: before.ino,
				size: before.size,
				mtimeNs: before.mtimeNs,
				nlink: before.nlink,
				parentDev: parentBefore.dev,
				parentIno: parentBefore.ino,
				sha256: crypto.createHash("sha256").update(content).digest("hex"),
			},
		};
	} catch {
		return { status: "unreadable" };
	} finally {
		await handle?.close();
	}
}

/** Convenience wrapper for existing call sites that only need the lease or `undefined` (absent or unreadable alike). */
async function captureChatDaemonOwnerLockLeaseOrUndefined(lock: string): Promise<ChatDaemonOwnerLockLease | undefined> {
	const result = await captureChatDaemonOwnerLockLease(lock);
	return result.status === "present" ? result.lease : undefined;
}

async function ownsChatDaemonOwnerLock(lock: string, lease: ChatDaemonOwnerLockLease): Promise<boolean> {
	const current = await captureChatDaemonOwnerLockLeaseOrUndefined(lock);
	return (
		current?.dev === lease.dev &&
		current.ino === lease.ino &&
		current.size === lease.size &&
		current.mtimeNs === lease.mtimeNs &&
		current.nlink === lease.nlink &&
		current.parentDev === lease.parentDev &&
		current.parentIno === lease.parentIno &&
		current.content === lease.content
	);
}

/** Deletes only the exact lease observed by this contender; a successor is retained. */
function unlinkExactChatDaemonOwnerLock(lock: string, lease: ChatDaemonOwnerLockLease): boolean {
	try {
		const removed = nativeChatDaemon().exactUnlink(lock, {
			dev: lease.dev,
			ino: lease.ino,
			size: lease.size,
			mtimeNs: lease.mtimeNs,
			nlink: lease.nlink,
			parentDev: lease.parentDev,
			parentIno: lease.parentIno,
			sha256: lease.sha256,
			quarantineName: `.gjc-delete-chat-daemon-lock-${crypto.randomUUID()}`,
		});
		if (removed.ok) return true;
		// Accept only typed retained authority: a concrete detached quarantine plus
		// a proven-absent canonical lock pathname. Anything else stays fail-closed.
		return (
			removed.code === "cleanup_pending" &&
			typeof removed.detachedPath === "string" &&
			removed.detachedPath.length > 0 &&
			!fs.existsSync(lock)
		);
	} catch {
		return false;
	}
}

async function reclaimChatDaemonOwnerLock(
	lock: string,
	stateFile: string,
	probe: ChatDaemonOwnershipProbe,
): Promise<boolean> {
	if (!(await canReclaimChatDaemonOwnerLock(lock, stateFile, probe))) return false;
	const reclaimFile = `${lock}.reclaim`;
	const reclaimLock = await acquireChatDaemonReclaimLock(reclaimFile, probe);
	if (!reclaimLock) return false;
	try {
		const ownerLock = await canReclaimChatDaemonOwnerLock(lock, stateFile, probe);
		return !!ownerLock && unlinkExactChatDaemonOwnerLock(lock, ownerLock);
	} finally {
		unlinkExactChatDaemonOwnerLock(reclaimFile, reclaimLock);
	}
}

async function acquireChatDaemonReclaimLock(
	reclaimFile: string,
	probe: ChatDaemonOwnershipProbe,
): Promise<ChatDaemonOwnerLockLease | undefined> {
	const incarnation = probe.pidIncarnation(process.pid);
	if (!hasProcessIncarnationAuthority(incarnation)) return undefined;
	const owner: ChatDaemonOwnerLock = { pid: process.pid, incarnation, createdAt: Date.now() };
	const created = await createChatDaemonOwnerLock(reclaimFile, owner);
	if (created) return created;
	const stale = await staleChatDaemonLockLease(reclaimFile, probe);
	if (!stale || !unlinkExactChatDaemonOwnerLock(reclaimFile, stale)) return undefined;
	return await createChatDaemonOwnerLock(reclaimFile, owner);
}

async function staleChatDaemonLockLease(
	lock: string,
	probe: ChatDaemonOwnershipProbe,
): Promise<ChatDaemonOwnerLockLease | undefined> {
	const lease = await captureChatDaemonOwnerLockLeaseOrUndefined(lock);
	if (!lease) return undefined;
	let owner: unknown;
	try {
		owner = JSON.parse(lease.content);
	} catch {
		return undefined;
	}
	if (!isChatDaemonOwnerLock(owner)) return undefined;
	if (!probe.pidAlive(owner.pid)) return lease;
	if (!hasProcessIncarnationAuthority(owner.incarnation)) return undefined;
	const currentIncarnation = probe.pidIncarnation(owner.pid);
	return hasProcessIncarnationAuthority(currentIncarnation) && currentIncarnation !== owner.incarnation
		? lease
		: undefined;
}

async function canReclaimChatDaemonOwnerLock(
	lock: string,
	stateFile: string,
	probe: ChatDaemonOwnershipProbe,
): Promise<ChatDaemonOwnerLockLease | undefined> {
	const state = await readJson<unknown>(stateFile);
	if (hasChatDaemonStatePid(state) && probe.pidAlive(state.pid)) {
		const current = probe.pidIncarnation(state.pid);
		if (
			!hasSafeChatDaemonOwnerShape(state) ||
			!hasProcessIncarnationAuthority(current) ||
			current === state.incarnation
		)
			return undefined;
	}
	return await staleChatDaemonLockLease(lock, probe);
}

/**
 * Strict: `pid`/`incarnation`/`createdAt` are always required. `version`,
 * `ownerId`, and `rootDigest` are individually optional (legacy locks omit
 * them), but any one that IS present must be well-formed — a malformed
 * optional field is never silently ignored.
 */
export function isChatDaemonOwnerLock(value: unknown): value is ChatDaemonOwnerLock {
	if (typeof value !== "object" || value === null) return false;
	const candidate = value as Record<string, unknown>;
	if (
		typeof candidate.pid !== "number" ||
		!Number.isSafeInteger(candidate.pid) ||
		candidate.pid <= 0 ||
		typeof candidate.incarnation !== "string" ||
		candidate.incarnation.length === 0 ||
		typeof candidate.createdAt !== "number" ||
		!Number.isFinite(candidate.createdAt)
	)
		return false;
	if (candidate.version !== undefined && candidate.version !== 1) return false;
	if (
		candidate.ownerId !== undefined &&
		(typeof candidate.ownerId !== "string" || candidate.ownerId.length === 0 || candidate.ownerId.length > 256)
	)
		return false;
	if (candidate.rootDigest !== undefined && !/^[0-9a-f]{64}$/.test(candidate.rootDigest as string)) return false;
	return true;
}

function isAlreadyExists(error: unknown): error is NodeJS.ErrnoException {
	return typeof error === "object" && error !== null && (error as NodeJS.ErrnoException).code === "EEXIST";
}
export interface RenewChatDaemonHeartbeatInput {
	agentDir: string;
	kind: ChatDaemonKind;
	ownerId: string;
	pid?: number;
	incarnation?: string;
	transportHealthy: boolean;
	pidAlive?: (pid: number) => boolean;
	pidIncarnation?: (pid: number) => string | undefined;
}

/** Actual body; runs ONLY inside {@link withDaemonStartupExclusion} (see {@link renewChatDaemonHeartbeat}). */
async function renewChatDaemonHeartbeatLocked(input: RenewChatDaemonHeartbeatInput): Promise<boolean> {
	const paths = chatDaemonPaths(input.agentDir, input.kind);
	const pidAlive = input.pidAlive ?? defaultPidAlive;
	const pidIncarnation = input.pidIncarnation ?? defaultPidIncarnation;
	return await withStateWriteLock(paths.state, async () => {
		const state = await readJson<unknown>(paths.state);
		if (!hasSafeChatDaemonStateShape(state)) return false;
		const pid = input.pid ?? state.pid;
		const currentIncarnation = pidIncarnation(pid);
		if (
			state.ownerId !== input.ownerId ||
			pid !== state.pid ||
			!hasProcessIncarnationAuthority(input.incarnation) ||
			state.incarnation !== input.incarnation ||
			!pidAlive(pid) ||
			!hasProcessIncarnationAuthority(currentIncarnation) ||
			currentIncarnation !== input.incarnation
		)
			return false;
		await writeJson(paths.state, { ...state, heartbeatAt: Date.now(), transportHealthy: input.transportHealthy });
		return true;
	});
}

/**
 * Renews the exact-owner heartbeat for `(agentDir, kind)`. Runs behind the
 * shared cross-process startup exclusion so a heartbeat can never publish in
 * the middle of a doctor startup/maintenance repair holding the same guard;
 * the actual re-check-and-write logic lives in the unlocked
 * {@link renewChatDaemonHeartbeatLocked}.
 */
export async function renewChatDaemonHeartbeat(input: RenewChatDaemonHeartbeatInput): Promise<boolean> {
	return await withDaemonStartupExclusion(input.agentDir, input.kind, () => renewChatDaemonHeartbeatLocked(input));
}

export interface ReleaseChatDaemonOwnershipInput {
	agentDir: string;
	kind: ChatDaemonKind;
	ownerId: string;
	pid: number;
	incarnation: string;
	pidAlive?: (pid: number) => boolean;
	pidIncarnation?: (pid: number) => string | undefined;
}

/** Actual body; runs ONLY inside {@link withDaemonStartupExclusion} (see {@link releaseChatDaemonOwnership}). */
async function releaseChatDaemonOwnershipLocked(input: ReleaseChatDaemonOwnershipInput): Promise<void> {
	const paths = chatDaemonPaths(input.agentDir, input.kind);
	const pidAlive = input.pidAlive ?? defaultPidAlive;
	const pidIncarnation = input.pidIncarnation ?? defaultPidIncarnation;
	await withStateWriteLock(paths.state, async () => {
		const state = await readJson<unknown>(paths.state);
		const currentIncarnation = pidIncarnation(input.pid);
		if (
			!hasSafeChatDaemonStateShape(state) ||
			!hasProcessIncarnationAuthority(input.incarnation) ||
			state.ownerId !== input.ownerId ||
			state.pid !== input.pid ||
			state.incarnation !== input.incarnation ||
			!pidAlive(input.pid) ||
			!hasProcessIncarnationAuthority(currentIncarnation) ||
			currentIncarnation !== input.incarnation
		)
			return;
		await writeJson(paths.state, { ...state, stoppedAt: Date.now(), transportHealthy: false });
		const lock = await captureChatDaemonOwnerLockLeaseOrUndefined(paths.lock);
		let owner: unknown;
		try {
			owner = lock && JSON.parse(lock.content);
		} catch {}
		if (lock && isChatDaemonOwnerLock(owner) && owner.pid === state.pid && owner.incarnation === state.incarnation)
			unlinkExactChatDaemonOwnerLock(paths.lock, lock);
	});
}

/**
 * Releases this process's `(agentDir, kind)` chat daemon ownership. Runs
 * behind the shared cross-process startup exclusion for the same reason as
 * {@link acquireChatDaemonOwnership}; the actual re-check-and-unpublish logic
 * lives in the unlocked {@link releaseChatDaemonOwnershipLocked}.
 */
export async function releaseChatDaemonOwnership(input: ReleaseChatDaemonOwnershipInput): Promise<void> {
	await withDaemonStartupExclusion(input.agentDir, input.kind, () => releaseChatDaemonOwnershipLocked(input));
}
