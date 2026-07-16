/**
 * Wires the authenticated Rust control endpoint (NotificationControlServer) to
 * the lifecycle orchestrator with REAL daemon-side effects: a daemon-safe tmux
 * launcher (create / cold-restart), force-close, and reattach-or-cold-restart
 * resume. Kept separate from telegram-daemon.ts so the effects + wiring are
 * unit-testable; the daemon calls {@link attachLifecycleControl} once it owns
 * the control server.
 */
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as fsPromises from "node:fs/promises";
import * as path from "node:path";
import type { NotificationControlServer as NativeNotificationControlServer } from "@gajae-code/natives";
import { tmuxRuntimeSessionPath } from "../../gjc-runtime/session-layout";
import {
	GJC_COORDINATOR_SESSION_ID_ENV,
	GJC_COORDINATOR_SESSION_STATE_FILE_ENV,
	GJC_TMUX_OWNER_GENERATION_ENV,
	GJC_TMUX_OWNER_SERVER_KEY_ENV,
	GJC_TMUX_OWNER_STATE_DIR_ENV,
} from "../../gjc-runtime/session-state-sidecar";
import {
	buildGjcTmuxProfileCommands,
	buildGjcTmuxSessionSlug,
	resolveGjcTmuxBinary,
	resolveGjcTmuxCommand,
} from "../../gjc-runtime/tmux-common";
import {
	captureOwnerGenerationBaseline,
	classifyCgroup,
	isExactScopedBootstrapSuccessReceipt,
	type OwnerGenerationBaseline,
	type OwnerIsolationProbe,
	planTmuxOwnerIsolation,
	replaceOwnerGeneration,
	type TmuxServerProof,
} from "../../gjc-runtime/tmux-owner-isolation";
import {
	findGjcTmuxSessionByName,
	forceCloseGjcTmuxSession,
	type GjcTmuxSessionStatus,
	listGjcTmuxSessions,
} from "../../gjc-runtime/tmux-sessions";
import type {
	LifecycleErrorReason,
	ResumeCandidate,
	SessionCreateFrame,
	SessionLifecycleRequest,
	SessionLifecycleResponse,
} from "./index";
import { normalizeLifecyclePath } from "./lifecycle-commands";
import {
	type AuditEvent,
	type CreateEffectResult,
	handleLifecycleRequest,
	type LedgerDoc,
	type LedgerEntry,
	type LedgerStore,
	type LifecycleOutcome,
	type OrchestratorDeps,
	type ResumeEffectResult,
} from "./lifecycle-orchestrator";
import { listRecentSessions } from "./recent-activity";

type NativeControlServerConstructor = new (
	token: string,
	ownerId: string,
	agentDir?: string,
) => NativeNotificationControlServer;

interface NativeControlServerModule {
	NotificationControlServer: NativeControlServerConstructor;
}

/** Minimal view of the native control server this runtime depends on. */
export interface ControlServerLike {
	onLifecycleRequest(
		cb: (err: Error | null, req: { kind: string; requestId: string; payloadJson: string }) => void,
	): void;
	respond(responseJson: string): void;
}

/**
 * A startable control server (the native NotificationControlServer, or a fake in
 * tests). Extends {@link ControlServerLike} with the start/stop lifecycle the
 * daemon owns.
 */
export interface LifecycleControlServer extends ControlServerLike {
	start(): Promise<unknown>;
	stop(): void;
}

/** Factory the daemon uses to construct a control server bound to its ownership. */
export type LifecycleControlServerFactory = (input: {
	token: string;
	ownerId: string;
	agentDir: string;
}) => LifecycleControlServer;
const lifecycleErrorReasons = new Set<LifecycleErrorReason>([
	"unauthorized",
	"rate_limited",
	"duplicate_conflict",
	"invalid_target",
	"ambiguous_target",
	"spawn_failed",
	"discovery_timeout",
	"readiness_timeout",
	"close_refused",
	"not_found",
	"terminal_uncertain",
	"unsupported_platform",
]);

function isLifecycleErrorReason(value: unknown): value is LifecycleErrorReason {
	return typeof value === "string" && lifecycleErrorReasons.has(value as LifecycleErrorReason);
}

/** Atomic + fsynced file-backed idempotency ledger store. */
function ledgerReadError(error: unknown): Error {
	const errorCode = (error as NodeJS.ErrnoException | undefined)?.code;
	const code = typeof errorCode === "string" ? errorCode : "invalid";
	return new Error(`gjc_lifecycle_ledger_read_failed:${code.slice(0, 32)}`);
}

function isLedgerDoc(value: unknown): value is LedgerDoc {
	if (!value || typeof value !== "object" || Array.isArray(value)) return false;
	const doc = value as { version?: unknown; entries?: unknown };
	if (doc.version !== 1 || !doc.entries || typeof doc.entries !== "object" || Array.isArray(doc.entries)) return false;
	return Object.values(doc.entries).every(entry => {
		if (!entry || typeof entry !== "object" || Array.isArray(entry)) return false;
		const candidate = entry as Partial<LedgerEntry>;
		const isBaseEntry =
			typeof candidate.requestHash === "string" &&
			(candidate.state === "in_progress" ||
				candidate.state === "success" ||
				candidate.state === "failure" ||
				candidate.state === "terminal_uncertain") &&
			typeof candidate.requestId === "string" &&
			(candidate.verb === "session_create" ||
				candidate.verb === "session_close" ||
				candidate.verb === "session_resume") &&
			typeof candidate.createdAt === "number" &&
			typeof candidate.updatedAt === "number" &&
			!!candidate.targetSummary &&
			typeof candidate.targetSummary === "object" &&
			!Array.isArray(candidate.targetSummary);
		if (!isBaseEntry) return false;
		if (candidate.state === "failure" || candidate.state === "terminal_uncertain")
			return isLifecycleErrorReason(candidate.reason);
		if (candidate.state !== "success") return true;
		switch (candidate.verb) {
			case "session_create":
				return (
					typeof candidate.intendedSessionId === "string" &&
					typeof candidate.sessionId === "string" &&
					typeof candidate.tmuxSession === "string" &&
					typeof candidate.endpointUrl === "string"
				);
			case "session_close":
				return typeof candidate.sessionId === "string" && typeof candidate.processGone === "boolean";
			case "session_resume":
				return (
					typeof candidate.sessionId === "string" &&
					typeof candidate.tmuxSession === "string" &&
					typeof candidate.endpointUrl === "string" &&
					(candidate.resumeMode === undefined ||
						candidate.resumeMode === "reattached" ||
						candidate.resumeMode === "cold_restarted")
				);
		}
		return false;
	});
}

function migrateLegacyLedger(doc: LedgerDoc): LedgerDoc {
	for (const entry of Object.values(doc.entries)) {
		if (entry.state === "success" && entry.verb === "session_resume" && entry.resumeMode === undefined) {
			entry.resumeMode = "reattached";
		}
	}
	return doc;
}

function isUnsupportedDirectorySyncError(error: unknown): boolean {
	const code = (error as NodeJS.ErrnoException | undefined)?.code;
	return code === "EINVAL" || code === "ENOTSUP" || code === "EOPNOTSUPP";
}

function recordDirectorySyncCompatibilityDiagnostic(): void {
	try {
		process.stderr.write("gjc lifecycle ledger directory sync unsupported\n");
	} catch {
		// Compatibility diagnostics must not alter ledger durability semantics.
	}
}

function fsyncLedgerParentDirectory(directory: string): void {
	const dirFd = fs.openSync(directory, "r");
	let syncFailure: unknown;
	let closeFailure: unknown;
	try {
		fs.fsyncSync(dirFd);
	} catch (error) {
		if (isUnsupportedDirectorySyncError(error)) recordDirectorySyncCompatibilityDiagnostic();
		else syncFailure = error;
	} finally {
		try {
			fs.closeSync(dirFd);
		} catch (error) {
			closeFailure = error;
		}
	}
	if (syncFailure !== undefined && closeFailure !== undefined)
		throw new AggregateError([syncFailure, closeFailure], "ledger directory sync failed");
	if (syncFailure !== undefined) throw syncFailure;
	if (closeFailure !== undefined) throw closeFailure;
}

export function fileLedgerStore(idempotencyFile: string): LedgerStore {
	return {
		async read(): Promise<LedgerDoc> {
			let contents: string;
			try {
				contents = fs.readFileSync(idempotencyFile, "utf8");
			} catch (error) {
				const code = (error as NodeJS.ErrnoException).code;
				if (code === "ENOENT") return { version: 1, entries: {} };
				throw ledgerReadError(error);
			}
			try {
				const doc = JSON.parse(contents) as unknown;
				if (!isLedgerDoc(doc)) throw new Error("invalid");
				return migrateLegacyLedger(doc);
			} catch (error) {
				throw ledgerReadError(error);
			}
		},
		async write(doc: LedgerDoc): Promise<void> {
			fs.mkdirSync(path.dirname(idempotencyFile), { recursive: true });
			const tmp = `${idempotencyFile}.${process.pid}.${Date.now()}.tmp`;
			let fd: number | undefined;
			let writeFailure: unknown;
			let closeFailure: unknown;
			try {
				fd = fs.openSync(tmp, "w", 0o600);
				const encodedDoc = Buffer.from(JSON.stringify(doc), "utf8");
				let offset = 0;
				while (offset < encodedDoc.length) {
					const written = fs.writeSync(fd, encodedDoc, offset, encodedDoc.length - offset);
					if (written === 0) throw new Error("Short write");
					offset += written;
				}
				fs.fsyncSync(fd);
			} catch (error) {
				writeFailure = error;
			} finally {
				if (fd !== undefined) {
					try {
						fs.closeSync(fd);
					} catch (error) {
						closeFailure = error;
					}
				}
			}
			if (writeFailure !== undefined || closeFailure !== undefined) {
				try {
					fs.unlinkSync(tmp);
				} catch {
					// The failed temporary file is never published.
				}
				if (writeFailure !== undefined && closeFailure !== undefined)
					throw new AggregateError([writeFailure, closeFailure], "ledger temporary write failed");
				throw writeFailure ?? closeFailure;
			}
			fs.renameSync(tmp, idempotencyFile);
			// The temp-file fsync does not persist the rename's directory entry.
			fsyncLedgerParentDirectory(path.dirname(idempotencyFile));
		},
	};
}

/** Append-only JSONL audit sink (0600). Never receives tokens or raw prompts. */
export function fileAudit(auditPath: string): (e: AuditEvent) => void {
	return (e: AuditEvent) => {
		fs.mkdirSync(path.dirname(auditPath), { recursive: true });
		fs.appendFileSync(auditPath, `${JSON.stringify(e)}\n`, { mode: 0o600 });
	};
}

/** Simple per-chat sliding-window create rate limiter. */
export function createRateLimiter(maxPerWindow: number, windowMs: number): (chatId: string, nowMs: number) => boolean {
	const hits = new Map<string, number[]>();
	return (chatId: string, nowMs: number) => {
		const arr = (hits.get(chatId) ?? []).filter(t => nowMs - t < windowMs);
		if (arr.length >= maxPerWindow) {
			hits.set(chatId, arr);
			return false;
		}
		arr.push(nowMs);
		hits.set(chatId, arr);
		return true;
	};
}

function tmuxSessionNameFor(sessionId: string): string {
	return `gjc_lc_${sessionId}`;
}

/** Build the `gjc` argv for a create target (existing path / worktree / dir).
 *
 *  The launched session id is carried via `GJC_SESSION_ID` in the child env (see
 *  {@link daemonSpawnCreate}); the root `gjc` launcher has no `--session-id`
 *  flag, so it must never appear in argv. Only flags the launch parser actually
 *  supports are emitted (`--worktree <branch>` for worktree targets,
 *  `--mpreset <profile>` for model presets). */
export function buildCreateArgv(
	frame: SessionCreateFrame,
	_ids: { intendedSessionId: string; startupPromptRef?: string },
): { cwd: string; args: string[] } {
	const extraArgs: string[] = [];
	if (frame.modelPreset) {
		extraArgs.push("--mpreset", frame.modelPreset);
	}
	if (frame.target.kind === "worktree") {
		const cwd = normalizeLifecyclePath(frame.target.repo);
		if (!cwd) throw new Error("invalid_lifecycle_repo_path");
		// Use the `--worktree=<branch>` form so the branch is a single argv token:
		// a flag-shaped branch (e.g. `-x`) can never be mis-parsed as a separate
		// launcher flag / detached-mode trigger.
		return { cwd, args: [`--worktree=${frame.target.branch}`, ...extraArgs] };
	}
	const cwd = normalizeLifecyclePath(frame.target.path);
	if (!cwd) throw new Error("invalid_lifecycle_path");
	return { cwd, args: extraArgs };
}

function isKnownNoServerDiagnostic(stderr: string): boolean {
	const diagnostic = stderr.trim().toLowerCase();
	return (
		diagnostic.length > 0 &&
		diagnostic.length <= 512 &&
		/no server running|failed to connect to server|error connecting to/.test(diagnostic)
	);
}

function lifecycleOwnerIsolationProbe(tmux: string, env: NodeJS.ProcessEnv): OwnerIsolationProbe {
	return {
		readCallerCgroup: async () =>
			process.platform === "linux" ? await fsPromises.readFile("/proc/self/cgroup", "utf8").catch(() => null) : null,
		probeServer: async (serverKey: string): Promise<TmuxServerProof> => {
			const result = Bun.spawnSync([tmux, "-L", serverKey, "list-sessions", "-F", "#{pid}\t#{session_name}"], {
				stdout: "pipe",
				stderr: "pipe",
				env,
			});
			const stderr = result.stderr.toString();
			if (result.exitCode !== 0)
				return isKnownNoServerDiagnostic(stderr) ? { state: "absent" } : { state: "unverifiable" };
			const lines = result.stdout
				.toString()
				.split("\n")
				.map(line => line.trim())
				.filter(Boolean);
			const [pidText] = lines[0]?.split("\t") ?? [];
			const pid = Number(pidText);
			const sessionNames = lines.map(line => line.split("\t")[1]).filter((name): name is string => Boolean(name));
			if (!Number.isSafeInteger(pid) || pid <= 0) return { state: "unverifiable" };
			if (process.platform !== "linux")
				return {
					state: "safe",
					pid,
					startTime: "not_applicable",
					cgroup: { classification: "not_applicable" },
					sessionNames,
				};
			const [cgroupText, stat] = await Promise.all([
				fsPromises.readFile(`/proc/${pid}/cgroup`, "utf8").catch(() => null),
				fsPromises.readFile(`/proc/${pid}/stat`, "utf8").catch(() => null),
			]);
			const cgroup = classifyCgroup({ platform: process.platform, cgroupText });
			const startTime = stat
				?.slice(stat.lastIndexOf(")") + 2)
				.trim()
				.split(/\s+/)[19];
			if (!startTime) return { state: "unverifiable", pid, cgroup, sessionNames };
			return {
				state:
					cgroup.classification === "safe"
						? "safe"
						: cgroup.classification === "unsafe_service"
							? "unsafe"
							: "unverifiable",
				pid,
				startTime,
				cgroup,
				sessionNames,
			};
		},
	};
}

function lifecycleRuntimeStateFile(cwd: string, sessionId: string, tmuxSession: string): string {
	return tmuxRuntimeSessionPath(cwd, sessionId, buildGjcTmuxSessionSlug(tmuxSession));
}

async function preflightLifecycleTmuxOwner(input: {
	tmux: string;
	env: NodeJS.ProcessEnv;
	ownerIsolationProbe?: OwnerIsolationProbe;
}): Promise<void> {
	const probe = input.ownerIsolationProbe ?? lifecycleOwnerIsolationProbe(input.tmux, input.env);
	let server: TmuxServerProof;
	try {
		server = await probe.probeServer("default");
	} catch {
		throw new Error("gjc_lifecycle_owner_server_unverifiable");
	}
	if (server.state === "unsafe") throw new Error("gjc_lifecycle_owner_server_unsafe");
	if (server.state === "unverifiable") throw new Error("gjc_lifecycle_owner_server_unverifiable");
	if (
		server.state === "safe" &&
		(!server.pid || !server.startTime || (process.platform === "linux" && server.cgroup?.classification !== "safe"))
	)
		throw new Error("gjc_lifecycle_owner_server_unverifiable");
	if (server.state === "absent") {
		try {
			if (
				classifyCgroup({ platform: process.platform, cgroupText: await probe.readCallerCgroup() })
					.classification === "unverifiable"
			)
				throw new Error("gjc_lifecycle_owner_server_unverifiable");
		} catch (error) {
			if (error instanceof Error && error.message === "gjc_lifecycle_owner_server_unverifiable") throw error;
			throw new Error("gjc_lifecycle_owner_server_unverifiable");
		}
	}
}

interface LifecycleAttemptExecution {
	attemptCreated: true;
	serverKey: string;
	serverPid?: number;
	serverStartTime?: string;
	nativeSessionId?: string;
	attemptSession: string;
}

function nativeTmuxSessionIdFromSpawn(stdout: string): string | undefined {
	const value = stdout.endsWith("\n") ? stdout.slice(0, -1) : stdout;
	return !value.includes("\n") && !value.includes("\r") && /^\$\d+$/.test(value) ? value : undefined;
}

async function isLifecycleGenerationUnchanged(
	stateDir: string,
	sessionId: string,
	previousBaseline: OwnerGenerationBaseline,
): Promise<boolean> {
	try {
		return (
			JSON.stringify(await captureOwnerGenerationBaseline(stateDir, sessionId)) === JSON.stringify(previousBaseline)
		);
	} catch {
		return false;
	}
}

async function executeLifecycleTmuxOwnerPlan(input: {
	tmux: string;
	env: NodeJS.ProcessEnv;
	sessionId: string;
	generation: string;
	stateDir: string;
	cwd: string;
	argv: string[];
	sessionName: string;
	ownerIsolationProbe?: OwnerIsolationProbe;
	prepareSpawn?: () => void;
	onAttemptCreated?: (attempt: LifecycleAttemptExecution) => void;
	previousBaseline: OwnerGenerationBaseline;
}): Promise<LifecycleAttemptExecution> {
	const probe = input.ownerIsolationProbe ?? lifecycleOwnerIsolationProbe(input.tmux, input.env);
	await preflightLifecycleTmuxOwner(input);
	if (!(await isLifecycleGenerationUnchanged(input.stateDir, input.sessionId, input.previousBaseline)))
		throw new Error("gjc_lifecycle_owner_generation_changed");
	const plan = await planTmuxOwnerIsolation(
		{
			schema_version: 1,
			op: "plan",
			platform: process.platform,
			session_id: input.sessionId,
			owner_generation: input.generation,
			baseline: input.previousBaseline,
			cwd: input.cwd,
			state_dir: input.stateDir,
			socket_key: "default",
			tmux_argv: input.argv,
		},
		probe,
	);
	if (!plan.ok) throw new Error(`gjc_lifecycle_owner_${plan.code}`);
	const preSpawnProof =
		plan.execution.mode === "direct" && plan.server_state === "safe"
			? await probe.probeServer(plan.execution.server_key)
			: undefined;
	if (
		preSpawnProof &&
		(preSpawnProof.state !== "safe" ||
			!preSpawnProof.pid ||
			!preSpawnProof.startTime ||
			(process.platform === "linux" && preSpawnProof.cgroup?.classification !== "safe"))
	)
		throw new Error("gjc_lifecycle_owner_server_unverifiable");
	input.prepareSpawn?.();
	if (!(await isLifecycleGenerationUnchanged(input.stateDir, input.sessionId, input.previousBaseline)))
		throw new Error("gjc_lifecycle_owner_generation_changed");
	const created = Bun.spawnSync(plan.execution.argv, {
		stdout: "pipe",
		stderr: "pipe",
		env: input.env,
		...(plan.execution.mode === "scoped" ? { stdin: new TextEncoder().encode(plan.execution.stdin_line) } : {}),
	});
	const rawStdout = created.stdout.toString();
	const rawScopedReceipt =
		plan.execution.mode === "scoped" && isExactScopedBootstrapSuccessReceipt(rawStdout)
			? (JSON.parse(rawStdout.endsWith("\n") ? rawStdout.slice(0, -1) : rawStdout) as {
					native_session_id: string;
					server_pid: number;
					server_start_time: string;
					session_name: string;
				})
			: undefined;
	const scopedReceipt =
		rawScopedReceipt?.session_name === plan.execution.attempt_session ? rawScopedReceipt : undefined;
	const attempt: LifecycleAttemptExecution = {
		attemptCreated: true,
		serverKey: plan.execution.server_key,
		nativeSessionId:
			plan.execution.mode === "scoped" ? scopedReceipt?.native_session_id : nativeTmuxSessionIdFromSpawn(rawStdout),
		attemptSession: plan.execution.attempt_session,
		...(scopedReceipt
			? { serverPid: scopedReceipt.server_pid, serverStartTime: scopedReceipt.server_start_time }
			: preSpawnProof
				? { serverPid: preSpawnProof.pid, serverStartTime: preSpawnProof.startTime }
				: {}),
	};
	input.onAttemptCreated?.(attempt);
	if (created.exitCode !== 0) {
		if (!attempt.nativeSessionId || attempt.serverPid === undefined || attempt.serverStartTime === undefined)
			throw new Error("gjc_lifecycle_spawn_failed_cleanup_uncertain");
		throw new Error("gjc_lifecycle_spawn_failed");
	}
	if (!attempt.nativeSessionId) throw new Error("gjc_lifecycle_spawn_failed_cleanup_uncertain");
	const proof = await probe.probeServer(plan.execution.server_key);
	if (
		proof.state !== "safe" ||
		!proof.pid ||
		!proof.startTime ||
		!proof.sessionNames?.includes(plan.execution.attempt_session) ||
		(process.platform === "linux" && proof.cgroup?.classification !== "safe") ||
		(preSpawnProof && (proof.pid !== preSpawnProof.pid || proof.startTime !== preSpawnProof.startTime)) ||
		(scopedReceipt && (proof.pid !== scopedReceipt.server_pid || proof.startTime !== scopedReceipt.server_start_time))
	)
		throw new Error("gjc_lifecycle_owner_server_unverifiable");
	attempt.serverPid = proof.pid;
	attempt.serverStartTime = proof.startTime;
	if (
		!(await reproveLifecycleAttempt({
			tmux: input.tmux,
			env: input.env,
			serverKey: attempt.serverKey,
			nativeSessionId: attempt.nativeSessionId,
			attemptSession: attempt.attemptSession,
			expectedServerPid: attempt.serverPid,
			expectedServerStartTime: attempt.serverStartTime,
			ownerIsolationProbe: input.ownerIsolationProbe,
		}))
	)
		throw new Error("gjc_lifecycle_owner_server_unverifiable");

	if (!(await isLifecycleGenerationUnchanged(input.stateDir, input.sessionId, input.previousBaseline)))
		throw new Error("gjc_lifecycle_owner_generation_changed");
	return attempt;
}

function hasExactNativeSessionBinding(input: {
	tmux: string;
	env: NodeJS.ProcessEnv;
	serverKey: string;
	nativeSessionId: string;
	attemptSession: string;
}): boolean {
	const result = Bun.spawnSync(
		[
			input.tmux,
			"-L",
			input.serverKey,
			"display-message",
			"-p",
			"-t",
			input.nativeSessionId,
			"#{session_id}\t#{session_name}",
		],
		{ stdout: "pipe", stderr: "pipe", env: input.env },
	);
	if (result.exitCode !== 0) return false;
	const output = result.stdout.toString();
	const line = output.endsWith("\n") ? output.slice(0, -1) : output;
	return line === `${input.nativeSessionId}\t${input.attemptSession}`;
}

function cleanupUncertain(): Error {
	return new Error("gjc_lifecycle_cleanup_uncertain");
}

async function reproveLifecycleAttempt(input: {
	tmux: string;
	env: NodeJS.ProcessEnv;
	serverKey: string;
	nativeSessionId: string;
	attemptSession: string;
	expectedServerPid: number;
	expectedServerStartTime: string;
	ownerIsolationProbe?: OwnerIsolationProbe;
}): Promise<boolean> {
	const probe = input.ownerIsolationProbe ?? lifecycleOwnerIsolationProbe(input.tmux, input.env);
	const isExpectedServer = (proof: TmuxServerProof): boolean =>
		proof.state === "safe" &&
		proof.pid === input.expectedServerPid &&
		proof.startTime === input.expectedServerStartTime &&
		proof.sessionNames?.includes(input.attemptSession) === true &&
		(process.platform !== "linux" || proof.cgroup?.classification === "safe");
	let proof: TmuxServerProof;
	try {
		proof = await probe.probeServer(input.serverKey);
	} catch {
		return false;
	}
	if (!isExpectedServer(proof) || !hasExactNativeSessionBinding(input)) return false;
	try {
		proof = await probe.probeServer(input.serverKey);
	} catch {
		return false;
	}
	return isExpectedServer(proof);
}

async function cleanupLifecycleAttempt(input: {
	tmux: string;
	env: NodeJS.ProcessEnv;
	serverKey: string;
	nativeSessionId?: string;
	attemptSession: string;
	expectedServerPid?: number;
	expectedServerStartTime?: string;
	ownerIsolationProbe?: OwnerIsolationProbe;
}): Promise<void> {
	if (!input.nativeSessionId || input.expectedServerPid === undefined || input.expectedServerStartTime === undefined)
		throw cleanupUncertain();
	// External reproof narrows the window and detects obvious replacement before
	// mutation, but the server evaluates the identity predicate atomically.
	if (
		!(await reproveLifecycleAttempt({
			tmux: input.tmux,
			env: input.env,
			serverKey: input.serverKey,
			nativeSessionId: input.nativeSessionId,
			attemptSession: input.attemptSession,
			expectedServerPid: input.expectedServerPid,
			expectedServerStartTime: input.expectedServerStartTime,
			ownerIsolationProbe: input.ownerIsolationProbe,
		}))
	)
		throw cleanupUncertain();
	const guarded = Bun.spawnSync(
		[
			input.tmux,
			"-L",
			input.serverKey,
			"if-shell",
			"-t",
			input.nativeSessionId,
			"-F",
			lifecycleMetadataPredicate(input.expectedServerPid, input.nativeSessionId, input.attemptSession),
			`kill-session -t '${input.nativeSessionId}' ; display-message -p __gjc_lifecycle_cleanup_ok__`,
			"display-message -p __gjc_lifecycle_cleanup_refused__",
		],
		{ stdout: "pipe", stderr: "pipe", env: input.env },
	);
	if (guarded.exitCode !== 0 || guarded.stdout.toString().trim() !== "__gjc_lifecycle_cleanup_ok__")
		throw cleanupUncertain();
}

async function assertLifecycleTmuxServerSafe(input: {
	tmux: string;
	env: NodeJS.ProcessEnv;
	ownerIsolationProbe?: OwnerIsolationProbe;
}): Promise<void> {
	const proof = await (input.ownerIsolationProbe ?? lifecycleOwnerIsolationProbe(input.tmux, input.env)).probeServer(
		"default",
	);
	if (
		proof.state !== "safe" ||
		!proof.pid ||
		!proof.startTime ||
		(process.platform === "linux" && proof.cgroup?.classification !== "safe")
	)
		throw new Error(`gjc_lifecycle_owner_${proof.state === "unsafe" ? "server_unsafe" : "server_unverifiable"}`);
}

async function completeLifecycleSpawnTransaction(input: {
	tmux: string;
	env: NodeJS.ProcessEnv;
	sessionId: string;
	generation: string;
	stateDir: string;
	cwd: string;
	sessionName: string;
	sessionStateFile: string;
	argv: string[];
	ownerIsolationProbe?: OwnerIsolationProbe;
	prepareSpawn?: () => void;
}): Promise<void> {
	const previousBaseline = await captureOwnerGenerationBaseline(input.stateDir, input.sessionId);
	let ownerExecution: LifecycleAttemptExecution | undefined;
	try {
		ownerExecution = await executeLifecycleTmuxOwnerPlan({
			...input,
			previousBaseline,
			onAttemptCreated: attempt => {
				ownerExecution = attempt;
			},
		});
		if (
			!ownerExecution.nativeSessionId ||
			ownerExecution.serverPid === undefined ||
			ownerExecution.serverStartTime === undefined
		)
			throw new Error("gjc_lifecycle_owner_server_unverifiable");
		await applyRequiredLifecycleTmuxMetadata(
			input.tmux,
			`${ownerExecution.nativeSessionId}:`,
			input.env,
			{
				sessionId: input.sessionId,
				sessionStateFile: input.sessionStateFile,
				project: input.cwd,
				ownerGeneration: input.generation,
				ownerServerKey: ownerExecution.serverKey,
			},
			{
				nativeSessionId: ownerExecution.nativeSessionId,
				attemptSession: ownerExecution.attemptSession,
				serverPid: ownerExecution.serverPid,
			},
		);
		if (
			!(await reproveLifecycleAttempt({
				tmux: input.tmux,
				env: input.env,
				serverKey: ownerExecution.serverKey,
				nativeSessionId: ownerExecution.nativeSessionId,
				attemptSession: ownerExecution.attemptSession,
				expectedServerPid: ownerExecution.serverPid,
				expectedServerStartTime: ownerExecution.serverStartTime,
				ownerIsolationProbe: input.ownerIsolationProbe,
			}))
		)
			throw new Error("gjc_lifecycle_owner_server_unverifiable");
		if (!(await isLifecycleGenerationUnchanged(input.stateDir, input.sessionId, previousBaseline)))
			throw new Error("gjc_lifecycle_owner_generation_changed");
		await replaceOwnerGeneration(input.stateDir, input.sessionId, input.generation, previousBaseline);
	} catch (error) {
		let cleanupFailure: unknown;
		if (ownerExecution?.attemptCreated) {
			try {
				await cleanupLifecycleAttempt({
					tmux: input.tmux,
					env: input.env,
					serverKey: ownerExecution.serverKey,
					nativeSessionId: ownerExecution.nativeSessionId,
					attemptSession: ownerExecution.attemptSession,
					expectedServerPid: ownerExecution.serverPid,
					expectedServerStartTime: ownerExecution.serverStartTime,
					ownerIsolationProbe: input.ownerIsolationProbe,
				});
			} catch (cleanupError) {
				cleanupFailure = cleanupError;
			}
		}
		if (cleanupFailure !== undefined)
			throw new AggregateError([error, cleanupFailure], "gjc_lifecycle_cleanup_uncertain");
		throw error;
	}
}
/** Real daemon-safe tmux launcher: canonical owner-isolation plan + GJC tags. */
export function daemonSpawnCreate(
	env: NodeJS.ProcessEnv = process.env,
	opts: { ownerIsolationProbe?: OwnerIsolationProbe } = {},
) {
	return async (
		frame: SessionCreateFrame,
		ids: { lifecycleRequestId: string; intendedSessionId: string; startupPromptRef?: string },
	): Promise<CreateEffectResult> => {
		const tmuxBinary = resolveGjcTmuxBinary({ env });
		if (tmuxBinary.isPsmux) throw new Error("gjc_lifecycle_psmux_unsupported");
		const tmux = tmuxBinary.command;
		const name = tmuxSessionNameFor(ids.intendedSessionId);
		const { cwd, args } = buildCreateArgv(frame, ids);
		const sessionStateFile = lifecycleRuntimeStateFile(cwd, ids.intendedSessionId, name);
		const stateDir = path.dirname(sessionStateFile);
		const generation = crypto.randomUUID();
		// Detached: no interactive TTY needed (daemon-safe). These values contain
		// only opaque ids and paths needed by the resident sidecar to publish its
		// exact-owner terminal verdict.
		const childEnv: Record<string, string> = {
			GJC_TMUX_LAUNCHED: "1",
			GJC_NOTIFICATIONS: "1",
			GJC_SESSION_ID: ids.intendedSessionId,
			GJC_LIFECYCLE_REQUEST_ID: ids.lifecycleRequestId,
			[GJC_COORDINATOR_SESSION_ID_ENV]: ids.intendedSessionId,
			[GJC_COORDINATOR_SESSION_STATE_FILE_ENV]: sessionStateFile,
			[GJC_TMUX_OWNER_GENERATION_ENV]: generation,
			[GJC_TMUX_OWNER_STATE_DIR_ENV]: stateDir,
			[GJC_TMUX_OWNER_SERVER_KEY_ENV]: "default",
		};
		if (ids.startupPromptRef) childEnv.GJC_STARTUP_PROMPT_REF = ids.startupPromptRef;
		const envPairs = Object.entries(childEnv)
			.map(([key, value]) => `${key}=${shellQuote(value)}`)
			.join(" ");
		const command = `cd ${shellQuote(cwd)} && exec env ${envPairs} gjc ${args.map(shellQuote).join(" ")}`;
		await completeLifecycleSpawnTransaction({
			tmux,
			env,
			sessionId: ids.intendedSessionId,
			generation,
			stateDir,
			cwd,
			sessionName: name,
			sessionStateFile,
			argv: [tmux, "new-session", "-d", "-P", "-F", "#{session_id}", "-s", name, "sh", "-c", command],
			ownerIsolationProbe: opts.ownerIsolationProbe,
			prepareSpawn: () => {
				if (frame.target.kind === "plain_dir") fs.mkdirSync(cwd, { recursive: true });
			},
		});

		return {
			sessionId: ids.intendedSessionId,
			tmuxSession: name,
			sessionStateFile,
			endpointUrl: "",
			topicThreadId: "",
		};
	};
}

function tmuxCommandArgument(value: string): string {
	return `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"').replaceAll("$", "\\$").replaceAll("`", "\\`")}"`;
}

function lifecycleMetadataPredicate(expectedPid: number, nativeSessionId: string, attemptSession: string): string {
	return `#{&&:#{==:#{pid},${expectedPid}},#{&&:#{==:#{session_id},${nativeSessionId}},#{==:#{session_name},${attemptSession}}}}`;
}

async function applyRequiredLifecycleTmuxMetadata(
	tmux: string,
	target: string,
	env: NodeJS.ProcessEnv,
	metadata: {
		sessionId: string;
		sessionStateFile: string;
		project: string;
		ownerGeneration: string;
		ownerServerKey: string;
	},
	attempt: { nativeSessionId: string; attemptSession: string; serverPid: number },
): Promise<void> {
	if (
		!metadata.sessionId.trim() ||
		!metadata.sessionStateFile.trim() ||
		!metadata.project.trim() ||
		!metadata.ownerGeneration.trim() ||
		!metadata.ownerServerKey.trim()
	)
		throw new Error("gjc_lifecycle_metadata_required_missing");
	const commands = buildGjcTmuxProfileCommands(target, env, metadata)
		.map(command => command.args.map(tmuxCommandArgument).join(" "))
		.join(" ; ");
	const result = Bun.spawnSync(
		[
			tmux,
			"-L",
			metadata.ownerServerKey,
			"if-shell",
			"-t",
			attempt.nativeSessionId,
			"-F",
			lifecycleMetadataPredicate(attempt.serverPid, attempt.nativeSessionId, attempt.attemptSession),
			`${commands} ; display-message -p __gjc_lifecycle_metadata_ok__`,
			"display-message -p __gjc_lifecycle_metadata_refused__",
		],
		{ stdout: "pipe", stderr: "pipe", env },
	);
	if (result.exitCode !== 0 || result.stdout.toString().trim() !== "__gjc_lifecycle_metadata_ok__")
		throw new Error("gjc_lifecycle_metadata_write_failed");
}

/** Real force-close effect (GJC-managed only, id-matched). */
export function daemonCloseSession(
	env: NodeJS.ProcessEnv = process.env,
	deps: {
		forceClose?: (
			name: string,
			env: NodeJS.ProcessEnv,
			expectedSessionId?: string,
			sessionStateFile?: string,
		) => Promise<void>;
		findSession?: (name: string, env: NodeJS.ProcessEnv) => GjcTmuxSessionStatus | undefined;
	} = {},
) {
	return async (target: { sessionId: string; tmuxSession?: string; sessionStateFile?: string }) => {
		const name = target.tmuxSession ?? tmuxSessionNameFor(target.sessionId);
		await (deps.forceClose ?? forceCloseGjcTmuxSession)(name, env, target.sessionId, target.sessionStateFile);
		return { processGone: (deps.findSession ?? findGjcTmuxSessionByName)(name, env) === undefined };
	};
}

/** Real resume effect: reattach if a live GJC session matches; else resolve the
 *  prefix against saved history and fail closed (`ambiguous`/`notFound`) before
 *  cold-restarting exactly one resolved session via the daemon-safe launcher. */
export function daemonResumeSession(
	env: NodeJS.ProcessEnv = process.env,
	opts: {
		agentDir?: string;
		/** Explicit managed root for isolated tests. */
		sessionsRoot?: string;
		listSessions?: (env: NodeJS.ProcessEnv) => GjcTmuxSessionStatus[];
		ownerIsolationProbe?: OwnerIsolationProbe;
	} = {},
) {
	return async (target: {
		sessionIdOrPrefix: string;
		path?: string;
	}): Promise<ResumeEffectResult | { ambiguous: ResumeCandidate[] } | { notFound: true }> => {
		const tmuxBinary = resolveGjcTmuxBinary({ env });
		if (tmuxBinary.isPsmux) throw new Error("gjc_lifecycle_psmux_unsupported");
		const live = (opts.listSessions?.(env) ?? listGjcTmuxSessions(env)).filter(
			s => s.sessionId === target.sessionIdOrPrefix || s.sessionId?.startsWith(target.sessionIdOrPrefix),
		);
		if (live.length > 1) {
			return {
				ambiguous: live.map(s => ({ sessionId: s.sessionId ?? s.name, path: s.project })),
			};
		}
		if (live.length === 1) {
			const s = live[0]!;
			await assertLifecycleTmuxServerSafe({
				tmux: resolveGjcTmuxCommand(env),
				env,
				ownerIsolationProbe: opts.ownerIsolationProbe,
			});
			return {
				sessionId: s.sessionId ?? s.name,
				tmuxSession: s.name,
				sessionStateFile: s.sessionStateFile,
				endpointUrl: "",
				topicThreadId: "",
				mode: "reattached",
			};
		}
		// Dead: resolve the id/prefix against saved session history BEFORE cold
		// restart, so an unknown or ambiguous prefix fails closed instead of
		// blindly spawning `gjc --resume <prefix>` against a non-authoritative id.
		let resumeId = target.sessionIdOrPrefix;
		let resumeCwd = target.path;
		if (!target.path && !opts.agentDir && !opts.sessionsRoot) return { notFound: true };
		const recent = await listRecentSessions({
			cwd: target.path ?? opts.agentDir ?? opts.sessionsRoot ?? "",
			agentDir: opts.agentDir,
			sessionsRoot: opts.sessionsRoot,
			allWorkspaces: target.path === undefined,
			limit: 1000,
		});
		if (recent.kind === "error") throw new Error(`gjc_lifecycle_saved_sessions_unavailable: ${recent.message}`);
		const saved = recent.entries;
		const prefixed = saved.filter(
			s => s.sessionId === target.sessionIdOrPrefix || s.sessionId.startsWith(target.sessionIdOrPrefix),
		);
		const exact = prefixed.filter(s => s.sessionId === target.sessionIdOrPrefix);
		const resolved = exact.length > 0 ? exact : prefixed;
		if (resolved.length === 0) return { notFound: true };
		if (resolved.length > 1) {
			return { ambiguous: resolved.map(s => ({ sessionId: s.sessionId, path: s.path })) };
		}
		const selected = resolved[0]!;
		resumeId = selected.sessionId;
		resumeCwd = selected.path;
		const resolvedResumeCwd = resumeCwd ? path.resolve(resumeCwd) : undefined;
		const resumeCwdStat = resolvedResumeCwd ? fs.statSync(resolvedResumeCwd, { throwIfNoEntry: false }) : undefined;
		if (typeof resolvedResumeCwd !== "string" || !resumeCwdStat?.isDirectory()) {
			throw new Error(`gjc_lifecycle_resume_cwd_unavailable: ${resolvedResumeCwd ?? "(missing)"}`);
		}
		const tmux = tmuxBinary.command;
		const name = tmuxSessionNameFor(resumeId);
		const sessionStateFile = lifecycleRuntimeStateFile(resolvedResumeCwd, resumeId, name);
		const stateDir = path.dirname(sessionStateFile);
		const generation = crypto.randomUUID();
		const childEnv: Record<string, string> = {
			GJC_TMUX_LAUNCHED: "1",
			GJC_NOTIFICATIONS: "1",
			[GJC_COORDINATOR_SESSION_ID_ENV]: resumeId,
			[GJC_COORDINATOR_SESSION_STATE_FILE_ENV]: sessionStateFile,
			[GJC_TMUX_OWNER_GENERATION_ENV]: generation,
			[GJC_TMUX_OWNER_STATE_DIR_ENV]: stateDir,
			[GJC_TMUX_OWNER_SERVER_KEY_ENV]: "default",
		};
		const envPairs = Object.entries(childEnv)
			.map(([key, value]) => `${key}=${shellQuote(value)}`)
			.join(" ");
		const command = `cd ${shellQuote(resolvedResumeCwd)} && exec env ${envPairs} gjc --resume ${shellQuote(resumeId)}`;
		await completeLifecycleSpawnTransaction({
			tmux,
			env,
			sessionId: resumeId,
			generation,
			stateDir,
			cwd: resolvedResumeCwd,
			sessionName: name,
			sessionStateFile,
			argv: [tmux, "new-session", "-d", "-P", "-F", "#{session_id}", "-s", name, "sh", "-c", command],
			ownerIsolationProbe: opts.ownerIsolationProbe,
		});

		return {
			sessionId: resumeId,
			tmuxSession: name,
			sessionStateFile,
			endpointUrl: "",
			topicThreadId: "",
			mode: "cold_restarted",
		};
	};
}

function shellQuote(value: string): string {
	return `'${value.replaceAll("'", "'\\''")}'`;
}

/** Translate an orchestrator outcome into a wire response frame. */
export function outcomeToResponse(frame: SessionLifecycleRequest, outcome: LifecycleOutcome): SessionLifecycleResponse {
	if (outcome.status === "error" || outcome.status === "pending") {
		const reason = outcome.status === "pending" ? "terminal_uncertain" : outcome.reason;
		return {
			type: "session_lifecycle_error",
			requestId: frame.requestId,
			status: "error",
			reason,
			message: outcome.status === "pending" ? "request already in progress" : outcome.message,
			...(outcome.status === "error" && outcome.candidates ? { candidates: outcome.candidates } : {}),
		};
	}
	const e = outcome.entry;
	if (e.state !== "success") throw new Error("invalid lifecycle success ledger entry");
	if (frame.type === "session_create") {
		if (typeof e.sessionId !== "string" || typeof e.endpointUrl !== "string")
			throw new Error("invalid create success ledger entry");
		return {
			type: "session_create_response",
			requestId: frame.requestId,
			status: "ok",
			lifecycleRequestId: frame.lifecycleRequestId,
			sessionId: e.sessionId,
			matchedBy: "spawn_marker",
			endpoint: { url: e.endpointUrl, token: "" },
			topic: { chatId: frame.chatId, threadId: "" },
			target: frame.target,
		};
	}
	if (frame.type === "session_close") {
		if (typeof e.sessionId !== "string" || typeof e.processGone !== "boolean")
			throw new Error("invalid close success ledger entry");
		return {
			type: "session_close_response",
			requestId: frame.requestId,
			status: "ok",
			sessionId: e.sessionId,
			processGone: e.processGone,
			historyPreserved: true,
			// The killed session's per-session endpoint record is reaped by the
			// daemon's dead-PID scan (scanRoots), so it is effectively stale.
			endpointStale: e.processGone,
		};
	}
	if (
		typeof e.sessionId !== "string" ||
		typeof e.endpointUrl !== "string" ||
		(e.resumeMode !== "reattached" && e.resumeMode !== "cold_restarted")
	)
		throw new Error("invalid resume success ledger entry");
	return {
		type: "session_resume_response",
		requestId: frame.requestId,
		status: "ok",
		sessionId: e.sessionId,
		mode: outcome.mode ?? e.resumeMode,
		endpoint: { url: e.endpointUrl, token: "" },
		topic: { chatId: frame.chatId, threadId: "" },
	};
}

const MAX_LIFECYCLE_REQUEST_ID_BYTES = 128;

function hasLoneUtf16Surrogate(value: string): boolean {
	for (let index = 0; index < value.length; index += 1) {
		const codeUnit = value.charCodeAt(index);
		if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
			if (index + 1 >= value.length || value.charCodeAt(index + 1) < 0xdc00 || value.charCodeAt(index + 1) > 0xdfff)
				return true;
			index += 1;
		} else if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) {
			return true;
		}
	}
	return false;
}

function boundedLifecycleRequestId(requestId: unknown): string {
	if (typeof requestId !== "string" || hasLoneUtf16Surrogate(requestId)) return "";
	let bounded = "";
	let byteLength = 0;
	for (const codePoint of requestId) {
		const codePointBytes = Buffer.byteLength(codePoint, "utf8");
		if (byteLength + codePointBytes > MAX_LIFECYCLE_REQUEST_ID_BYTES) break;
		bounded += codePoint;
		byteLength += codePointBytes;
	}
	return bounded;
}

function lifecycleFailureResponse(requestId: unknown): SessionLifecycleResponse {
	return {
		type: "session_lifecycle_error",
		requestId: boundedLifecycleRequestId(requestId),
		status: "error",
		reason: "terminal_uncertain",
		message: "request could not be processed",
	};
}

function recordLifecycleControlDiagnostic(): void {
	try {
		process.stderr.write("gjc lifecycle control request failed\n");
	} catch {
		// Diagnostics must not suppress the fixed wire failure response or recovery.
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return !!value && typeof value === "object" && !Array.isArray(value);
}

function isSafeLifecycleId(value: unknown): value is string {
	return typeof value === "string" && !hasLoneUtf16Surrogate(value);
}

function isNonEmptySafeLifecycleId(value: unknown): value is string {
	return isSafeLifecycleId(value) && value.length > 0;
}

/** The native server authenticates callbacks before redacting the control token. */
type AuthenticatedNativeLifecycleRequest =
	| Omit<SessionCreateFrame, "token">
	| Omit<Extract<SessionLifecycleRequest, { type: "session_close" }>, "token">
	| Omit<Extract<SessionLifecycleRequest, { type: "session_resume" }>, "token">;

function isBoundedRequestFrame(frame: unknown): frame is AuthenticatedNativeLifecycleRequest {
	if (
		!isRecord(frame) ||
		!isSafeLifecycleId(frame.requestId) ||
		Buffer.byteLength(frame.requestId, "utf8") > MAX_LIFECYCLE_REQUEST_ID_BYTES
	)
		return false;
	if (
		!isSafeLifecycleId(frame.chatId) ||
		(typeof frame.token !== "undefined" && typeof frame.token !== "string") ||
		!Number.isSafeInteger(frame.updateId)
	)
		return false;
	if (!isRecord(frame.target)) return false;
	switch (frame.type) {
		case "session_create":
			return (
				isNonEmptySafeLifecycleId(frame.lifecycleRequestId) &&
				isNonEmptySafeLifecycleId(frame.intendedSessionId) &&
				(typeof frame.startupPromptRef === "undefined" || typeof frame.startupPromptRef === "string") &&
				(typeof frame.modelPreset === "undefined" || typeof frame.modelPreset === "string") &&
				((frame.target.kind === "worktree" &&
					typeof frame.target.repo === "string" &&
					typeof frame.target.branch === "string") ||
					((frame.target.kind === "existing_path" || frame.target.kind === "plain_dir") &&
						typeof frame.target.path === "string"))
			);
		case "session_close":
			return (
				isSafeLifecycleId(frame.target.sessionId) &&
				(typeof frame.target.tmuxSession === "undefined" || isSafeLifecycleId(frame.target.tmuxSession)) &&
				(typeof frame.target.sessionStateFile === "undefined" ||
					typeof frame.target.sessionStateFile === "string") &&
				(typeof frame.force === "undefined" || typeof frame.force === "boolean")
			);
		case "session_resume":
			return (
				isSafeLifecycleId(frame.target.sessionIdOrPrefix) &&
				(typeof frame.target.path === "undefined" || typeof frame.target.path === "string") &&
				(typeof frame.startupPromptRef === "undefined" || typeof frame.startupPromptRef === "string")
			);
		default:
			return false;
	}
}

/**
 * Wire a control server's lifecycle requests through the orchestrator.
 *
 * Handlers run on a single serial queue (a promise chain): the daemon owns the
 * one control endpoint, so serializing here makes each request's ledger
 * read -> classify -> write atomic with respect to every other request. Two
 * identical updates that arrive nearly simultaneously can no longer both
 * classify as `new` and both spawn — the second sees the first's persisted
 * `in_progress`/`success` entry and re-acks instead.
 */
export function attachLifecycleControl(server: ControlServerLike, deps: OrchestratorDeps): void {
	let queue: Promise<void> = Promise.resolve();
	server.onLifecycleRequest((err, req) => {
		if (err) {
			recordLifecycleControlDiagnostic();
			return;
		}
		const envelopeRequestId = boundedLifecycleRequestId(req.requestId);
		const run = async (): Promise<void> => {
			let frame: AuthenticatedNativeLifecycleRequest | undefined;

			try {
				const parsed = JSON.parse(req.payloadJson) as unknown;
				if (!isBoundedRequestFrame(parsed)) throw new Error("invalid lifecycle frame");
				frame = parsed;
				const outcome = await handleLifecycleRequest(frame as SessionLifecycleRequest, deps);

				server.respond(
					JSON.stringify(
						outcome.status === "error" && outcome.reason === "terminal_uncertain"
							? lifecycleFailureResponse(frame.requestId)
							: outcomeToResponse(frame as SessionLifecycleRequest, outcome),
					),
				);
			} catch {
				recordLifecycleControlDiagnostic();
				// A valid frame preserves its immutable request id; malformed frames use
				// only the bounded native envelope id.
				server.respond(JSON.stringify(lifecycleFailureResponse(frame?.requestId ?? envelopeRequestId)));
			}
		};
		// Recover queue liveness only after this request has attempted its own
		// failure response. A response transport failure cannot poison later work.
		queue = queue.then(run, run).catch(() => {
			recordLifecycleControlDiagnostic();
		});
	});
}

/** Assemble real orchestrator deps for the daemon (ledger/audit under agentDir). */
export function buildOrchestratorDeps(input: {
	pairedChatId: string;
	agentNotificationsDir: string;
	/** Required in-memory, 32-byte audit-v2 redaction key. */
	auditRedactionKey: Uint8Array;
	/** Root of saved session histories (`<agentDir>/sessions`), for resume resolution. */
	sessionsRoot?: string;
	/** Agent directory used for readonly managed-session resume resolution. */
	agentDir?: string;
	env?: NodeJS.ProcessEnv;
}): OrchestratorDeps {
	if (input.auditRedactionKey.byteLength !== 32) throw new Error("invalid_audit_redaction_key");
	const env = input.env ?? process.env;
	return {
		pairedChatId: input.pairedChatId,
		auditRedactionKey: input.auditRedactionKey,
		now: () => Date.now(),
		store: fileLedgerStore(path.join(input.agentNotificationsDir, "telegram-lifecycle-idempotency.json")),
		audit: fileAudit(path.join(input.agentNotificationsDir, "telegram-lifecycle-audit.jsonl")),
		isPsmuxProvider: () => resolveGjcTmuxBinary({ env }).isPsmux,
		allowCreate: createRateLimiter(3, 10 * 60 * 1000),
		writeStartupPrompt: async (_requestId, prompt, _persistRef) => {
			if (prompt === undefined) return undefined;
			throw new Error("startup_prompt_capability_transport_unavailable");
		},
		spawnCreate: daemonSpawnCreate(env),
		closeSession: daemonCloseSession(env),
		resumeSession: daemonResumeSession(env, {
			agentDir: input.agentDir ?? path.dirname(input.agentNotificationsDir),
		}),
	};
}

/**
 * Default production factory: a real native NotificationControlServer bound to
 * the daemon's control token, owner id, and agent dir.
 */
export const createNativeControlServer: LifecycleControlServerFactory = ({ token, ownerId, agentDir }) => {
	// Lazy require so loading this module (for the orchestrator / wiring / tests)
	// never eagerly resolves the native addon — only a real production start does.
	const { NotificationControlServer } = require("@gajae-code/natives") as NativeControlServerModule;
	return new NotificationControlServer(token, ownerId, agentDir);
};
