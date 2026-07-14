/**
 * Provenance and lifecycle primitives for tmux-resident GJC owners.
 * This module intentionally accepts and stores only opaque identifiers and
 * process/cgroup metadata; it never reads panes, prompts, environment, or logs.
 */

import { Database } from "bun:sqlite";

import * as crypto from "node:crypto";
import * as fsSync from "node:fs";
import * as fs from "node:fs/promises";

import * as path from "node:path";
import { isCompiledBinary } from "@gajae-code/utils/env";

export const TMUX_OWNER_ISOLATION_SCHEMA_VERSION = 1;
export const TMUX_OWNER_ISOLATION_MAX_LINE_BYTES = 16 * 1024;
export const TMUX_OWNER_ISOLATION_MAX_DIAGNOSTIC_CHARS = 512;

const TMUX_OWNER_ISOLATION_CLI_FLAG = "--internal-tmux-owner-isolation";

export function tmuxOwnerIsolationBootstrapArgv(): string[] {
	if (isCompiledBinary()) return [process.execPath, TMUX_OWNER_ISOLATION_CLI_FLAG];
	const entry = process.argv[1];
	if (entry && /\.(?:[cm]?js|ts)$/.test(entry) && !/\.test\.[^.]+$/.test(entry)) {
		return [process.execPath, entry, TMUX_OWNER_ISOLATION_CLI_FLAG];
	}
	return [process.execPath, path.resolve(import.meta.dir, "../../bin/gjc.js"), TMUX_OWNER_ISOLATION_CLI_FLAG];
}

function scopedExecutionArgv(expectedScope: string): string[] {
	return [
		"systemd-run",
		"--user",
		"--scope",
		"--quiet",
		"--unit",
		expectedScope,
		...tmuxOwnerIsolationBootstrapArgv(),
	];
}

export type CgroupClassification = "not_applicable" | "safe" | "unsafe_service" | "unverifiable";
export type ServerState = "absent" | "safe" | "unsafe" | "unverifiable";
export type PlanErrorCode =
	| "scope_unavailable"
	| "server_unsafe"
	| "server_unverifiable"
	| "server_race"
	| "scope_bootstrap_failed";
export type ExpectedTerminalResult = "owner_term_then_session_cleanup";
export type TerminalSignal = "SIGTERM" | "SIGHUP" | "SIGINT" | "SIGKILL" | "EXIT" | "MANUAL" | "UNKNOWN";
export type VerdictClassification = "expected_operator_shutdown" | "unexpected_owner_loss" | "non_operator_cleanup";
export type TerminalObserver = "sidecar" | "raw_monitor";

export interface CgroupInfo {
	classification: CgroupClassification;
	scope?: string;
	diagnostic?: string;
}

/** Classify only public cgroup path metadata; malformed Linux data fails closed. */
export function classifyCgroup(input: { platform: NodeJS.Platform; cgroupText?: string | null }): CgroupInfo {
	if (input.platform !== "linux") return { classification: "not_applicable" };
	const text = input.cgroupText?.trim();
	if (!text)
		return {
			classification: "unverifiable",
			diagnostic: "cgroup_metadata_missing",
		};
	const paths = text
		.split("\n")
		.map(line => line.split(":").at(-1)?.trim())
		.filter((value): value is string => Boolean(value));
	if (paths.length === 0 || paths.some(value => !value.startsWith("/")))
		return {
			classification: "unverifiable",
			diagnostic: "cgroup_metadata_malformed",
		};
	const hasUnrelatedService = paths.some(value =>
		value.split("/").some(component => component.endsWith(".service") && !/^user@\d+\.service$/.test(component)),
	);
	if (hasUnrelatedService)
		return {
			classification: "unsafe_service",
			diagnostic: "service_cgroup_inheritance",
		};
	const scope = paths.find(value => /(?:^|\/)(?:user|session|app|init|gjc)[^/]*\.scope(?:\/|$)/.test(value));
	const vteScope = paths.find(value =>
		/^\/user\.slice\/user-(\d+)\.slice\/user@\1\.service(?:\/[^/]+)*\/vte-spawn-[A-Za-z0-9_.-]+\.scope$/.test(value),
	);
	if (scope || vteScope) return { classification: "safe", scope: scope ?? vteScope };
	if (paths.every(value => value === "/")) return { classification: "safe", scope: "/" };
	return {
		classification: "unverifiable",
		diagnostic: "cgroup_ownership_unproven",
	};
}

export function ownerProcessStartTime(platform: NodeJS.Platform, stat: string | null): string | null {
	if (platform !== "linux") return "not_applicable";
	if (!stat) return null;
	const close = stat.lastIndexOf(")");
	if (close < 0) return null;
	const startTime = stat
		.slice(close + 2)
		.trim()
		.split(/\s+/)[19];
	return startTime && /^\d+$/.test(startTime) ? startTime : null;
}

export interface TmuxServerProof {
	state: ServerState;
	pid?: number;
	startTime?: string;
	cgroup?: CgroupInfo;
	sessionNames?: string[];
}

export interface PlanRequest {
	schema_version: 1;
	op: "plan";
	platform: NodeJS.Platform;
	session_id: string;
	owner_generation: string;
	cwd: string;
	state_dir: string;
	socket_key: string;
	tmux_argv: string[];
	baseline: OwnerGenerationBaseline;
}

export interface PublishGenerationRequest {
	schema_version: 1;
	op: "publish_generation";
	session_id: string;
	owner_generation: string;
	state_dir: string;
	baseline: OwnerGenerationBaseline;
}

export interface PublishGenerationResult {
	schema_version: 1;
	ok: true;
	code: "generation_published";
	generation: string;
}

export interface AttemptCapability {
	token: string;
	session_name: string;
	socket_key: string;
	server_absent_before: boolean;
	baseline: OwnerGenerationBaseline;
	expires_at: string;
}

interface PersistedAttempt extends AttemptCapability {
	schema_version: 1;
	generation: string;
	session_id: string;
	created_at: string;
}

export interface DirectExecution {
	mode: "direct";
	argv: string[];
	attempt_session: string;
	server_key: string;
	server_absent_before: boolean;
	server_pid?: number;
	server_start_time?: string;
}
export interface ScopedExecution {
	mode: "scoped";
	argv: string[];
	stdin_line: string;
	expected_scope: string;
	attempt: AttemptCapability;
	attempt_session: string;
	server_key: string;
	server_absent_before: true;
}
export type PlanExecution = DirectExecution | ScopedExecution;
export interface PlanSuccess {
	schema_version: 1;
	ok: true;
	code: "not_required" | "unsafe_scope_required";
	execution: PlanExecution;
	classification: CgroupInfo;
	server_state: ServerState;
}
export interface TmuxOwnerIsolationExecutionSuccess {
	ok: true;
	code: "executed";
	execution: PlanExecution;
	server: TmuxServerProof;
	server_key: string;
	server_pid: number;
	server_start_time: string;
	server_session: string;
	native_session_id?: string;
}
export interface PlanFailure {
	schema_version: 1;
	ok: false;
	code: PlanErrorCode;
	diagnostic: string;
}
export type PlanResponse = PlanSuccess | PlanFailure;

export interface OwnerIsolationProbe {
	readCallerCgroup(): Promise<string | null>;
	probeServer(socketKey: string, tmuxArgv?: string[]): Promise<TmuxServerProof>;
}

/** Synchronous probe boundary for managed launch paths. */
export interface OwnerIsolationProbeSync {
	readCallerCgroup(): string | null;
	probeServer(socketKey: string): TmuxServerProof;
	recordAttempt(input: { stateDir: string; sessionId: string; generation: string; attempt: AttemptCapability }): void;
}

export interface TmuxOwnerIsolationExecutionFailure {
	ok: false;
	code: PlanErrorCode;
	diagnostic: string;
}
export type TmuxOwnerIsolationExecutionResult = TmuxOwnerIsolationExecutionSuccess | TmuxOwnerIsolationExecutionFailure;

/** Synchronous spawn boundary; callers pass argv and scoped stdin unchanged. */
export interface TmuxOwnerIsolationExecutionDependencies {
	socketKey: string;
	spawn(argv: string[], stdinLine?: string): { exitCode: number | null; stdout?: string };
	probeServer(socketKey: string): TmuxServerProof;
	/** Reads the published owner generation immediately around direct execution. */
	isCurrentGeneration?(): boolean;
	cleanupSpawned?(input: { execution: DirectExecution; nativeSessionId: string; server: TmuxServerProof }): void;
}

function nativeTmuxSessionId(value: unknown): value is string {
	return typeof value === "string" && /^\$\d+$/.test(value);
}

export function isExactScopedBootstrapSuccessReceipt(stdout: string): boolean {
	if (Buffer.byteLength(stdout) > TMUX_OWNER_ISOLATION_MAX_LINE_BYTES) return false;
	const line = stdout.endsWith("\n") ? stdout.slice(0, -1) : stdout;
	if (!line || line.includes("\n") || line.includes("\r")) return false;
	try {
		const receipt = JSON.parse(line) as Record<string, unknown>;
		return (
			Object.keys(receipt).length === 7 &&
			receipt.schema_version === 1 &&
			receipt.ok === true &&
			receipt.code === "bootstrapped" &&
			nativeTmuxSessionId(receipt.native_session_id) &&
			typeof receipt.server_pid === "number" &&
			Number.isSafeInteger(receipt.server_pid) &&
			receipt.server_pid > 0 &&
			nonEmpty(receipt.server_start_time) &&
			nonEmpty(receipt.session_name)
		);
	} catch {
		return false;
	}
}

function safeDiagnostic(value: string): string {
	return value.replace(/[^\x20-\x7e]/g, "?").slice(0, TMUX_OWNER_ISOLATION_MAX_DIAGNOSTIC_CHARS);
}
function failure(code: PlanErrorCode, diagnostic: string): PlanFailure {
	return {
		schema_version: 1,
		ok: false,
		code,
		diagnostic: safeDiagnostic(diagnostic),
	};
}
function tmuxControlArgv(tmuxArgv: string[]): string[] {
	const command = canonicalNewSession(tmuxArgv);
	return command ? tmuxArgv.slice(0, command.index) : [];
}

/** Accept exactly one tmux new-session command with exactly one explicit session target. */
function canonicalNewSession(tmuxArgv: string[]): { index: number; session: string } | null {
	const commands = tmuxArgv.map((arg, index) => ({ arg, index })).filter(({ arg }) => arg === "new-session");
	if (commands.length !== 1 || commands[0]!.index < 1) return null;
	let session: string | null = null;
	for (let index = commands[0]!.index + 1; index < tmuxArgv.length; index += 1) {
		const arg = tmuxArgv[index];
		if (arg !== "-s" && arg !== "--session-name") continue;
		const value = tmuxArgv[index + 1];
		if (!nonEmpty(value) || session !== null) return null;
		session = value;
		index += 1;
	}
	return session ? { index: commands[0]!.index, session } : null;
}

function tmuxAttemptSession(tmuxArgv: string[]): string | null {
	return canonicalNewSession(tmuxArgv)?.session ?? null;
}

function validArgv(argv: unknown): argv is string[] {
	return (
		Array.isArray(argv) &&
		argv.length > 0 &&
		typeof argv[0] === "string" &&
		argv[0].length > 0 &&
		!argv[0].includes("\0") &&
		argv.slice(1).every(value => typeof value === "string" && !value.includes("\0"))
	);
}

function isSafeServerProof(
	server: TmuxServerProof,
	platform: NodeJS.Platform = "linux",
): server is TmuxServerProof & {
	state: "safe";
	pid: number;
	startTime: string;
	cgroup: CgroupInfo;
} {
	return (
		server.state === "safe" &&
		typeof server.pid === "number" &&
		Number.isSafeInteger(server.pid) &&
		server.pid > 0 &&
		nonEmpty(server.startTime) &&
		(server.cgroup?.classification === "safe" ||
			(platform !== "linux" && server.cgroup?.classification === "not_applicable"))
	);
}
/**
 * Synchronous equivalent of the target-server truth table for managed callers.
 * Attempt persistence is injected so a caller can use its existing atomic state writer.
 */
export function planTmuxOwnerIsolationSync(request: PlanRequest, probe: OwnerIsolationProbeSync): PlanResponse {
	if (!isPlanRequest(request)) return failure("scope_unavailable", "invalid_plan_request");
	const attemptSession = tmuxAttemptSession(request.tmux_argv);
	if (!attemptSession) return failure("scope_unavailable", "attempt_session_missing");
	if (!isOwnerGenerationBaselineCurrentSync(request.state_dir, request.session_id, request.baseline))
		return failure("scope_unavailable", "owner_generation_stale");
	try {
		const server = probe.probeServer(request.socket_key);
		if (server.state === "unsafe") return failure("server_unsafe", "target_server_unsafe");
		if (server.state === "unverifiable") return failure("server_unverifiable", "target_server_unverifiable");
		if (server.state === "safe" && !isSafeServerProof(server, request.platform))
			return failure("server_unverifiable", "target_server_unverifiable");
		if (server.state === "safe") {
			return {
				schema_version: 1,
				ok: true,
				code: "not_required",
				execution: {
					mode: "direct",
					argv: [...request.tmux_argv],
					attempt_session: attemptSession,
					server_key: request.socket_key,
					server_absent_before: false,
					server_pid: server.pid,
					server_start_time: server.startTime,
				},
				classification: server.cgroup ?? { classification: "safe" },
				server_state: "safe",
			};
		}
		const classification = classifyCgroup({
			platform: request.platform,
			cgroupText: probe.readCallerCgroup(),
		});
		if (classification.classification === "unverifiable")
			return failure("server_unverifiable", classification.diagnostic ?? "caller_cgroup_unverifiable");
		if (classification.classification !== "unsafe_service") {
			return {
				schema_version: 1,
				ok: true,
				code: "not_required",
				execution: {
					mode: "direct",
					argv: [...request.tmux_argv],
					attempt_session: attemptSession,
					server_key: request.socket_key,
					server_absent_before: true,
				},
				classification,
				server_state: "absent",
			};
		}
		const baseline = request.baseline;
		const token = crypto.randomUUID();
		const attempt: AttemptCapability = {
			token,
			session_name: attemptSession,
			socket_key: request.socket_key,
			server_absent_before: true,
			baseline,
			expires_at: new Date(Date.now() + 7_000).toISOString(),
		};

		probe.recordAttempt({
			stateDir: request.state_dir,
			sessionId: request.session_id,
			generation: request.owner_generation,
			attempt,
		});
		const expectedScope = `gjc-owner-${token}.scope`;
		const bootstrap: BootstrapRequest = {
			schema_version: 1,
			op: "bootstrap",
			session_id: request.session_id,
			owner_generation: request.owner_generation,
			state_dir: request.state_dir,
			socket_key: request.socket_key,
			expected_scope: expectedScope,
			tmux_argv: [...request.tmux_argv],
			attempt,
		};
		const stdinLine = JSON.stringify(bootstrap);
		return {
			schema_version: 1,
			ok: true,
			code: "unsafe_scope_required",
			execution: {
				mode: "scoped",
				argv: scopedExecutionArgv(expectedScope),
				stdin_line: stdinLine,
				expected_scope: expectedScope,
				attempt,
				attempt_session: attemptSession,
				server_key: request.socket_key,
				server_absent_before: true,
			},
			classification,
			server_state: "absent",
		};
	} catch {
		return failure("scope_unavailable", "synchronous_probe_failed");
	}
}

/**
 * Runs one planned argv exactly and re-proves the target server before callers
 * perform profile, attach, or cleanup operations.
 */
export function executeTmuxOwnerIsolationPlanSync(
	plan: PlanResponse,
	deps: TmuxOwnerIsolationExecutionDependencies,
): TmuxOwnerIsolationExecutionResult {
	if (!plan.ok) return { ok: false, code: plan.code, diagnostic: plan.diagnostic };
	try {
		const execution = plan.execution;
		if (execution.mode === "direct" && deps.isCurrentGeneration && !deps.isCurrentGeneration())
			return {
				ok: false,
				code: "scope_bootstrap_failed",
				diagnostic: "owner_generation_stale",
			};
		const result =
			execution.mode === "direct"
				? deps.spawn([...execution.argv])
				: deps.spawn([...execution.argv], execution.stdin_line);
		if (result.exitCode !== 0)
			return {
				ok: false,
				code: "scope_bootstrap_failed",
				diagnostic: "planned_spawn_failed",
			};
		if (execution.mode === "scoped" && !isExactScopedBootstrapSuccessReceipt(result.stdout ?? ""))
			return {
				ok: false,
				code: "scope_bootstrap_failed",
				diagnostic: "scoped_bootstrap_receipt_invalid",
			};
		const nativeSessionId =
			execution.mode === "scoped"
				? (JSON.parse(result.stdout!.trim()) as { native_session_id: string }).native_session_id
				: nativeTmuxSessionId(result.stdout?.trim())
					? result.stdout!.trim()
					: undefined;
		const directGenerationStale =
			execution.mode === "direct" && Boolean(deps.isCurrentGeneration && !deps.isCurrentGeneration());
		let server: TmuxServerProof;
		try {
			server = deps.probeServer(
				plan.execution.mode === "scoped" ? plan.execution.attempt.socket_key : deps.socketKey,
			);
		} catch (error) {
			if (directGenerationStale)
				return {
					ok: false,
					code: "scope_bootstrap_failed",
					diagnostic: "owner_generation_stale_cleanup_uncertain",
				};
			throw error;
		}
		if (server.state === "unsafe")
			return directGenerationStale
				? {
						ok: false,
						code: "scope_bootstrap_failed",
						diagnostic: "owner_generation_stale_cleanup_uncertain",
					}
				: {
						ok: false,
						code: "server_unsafe",
						diagnostic: "target_server_unsafe",
					};
		if (!isSafeServerProof(server, plan.classification.classification === "not_applicable" ? "darwin" : "linux"))
			return directGenerationStale
				? {
						ok: false,
						code: "scope_bootstrap_failed",
						diagnostic: "owner_generation_stale_cleanup_uncertain",
					}
				: {
						ok: false,
						code: "server_unverifiable",
						diagnostic: "target_server_unverifiable",
					};
		if (execution.mode === "scoped") {
			const receipt = JSON.parse(result.stdout!.trim()) as {
				server_pid: number;
				server_start_time: string;
				session_name: string;
			};
			if (
				receipt.server_pid !== server.pid ||
				receipt.server_start_time !== server.startTime ||
				receipt.session_name !== execution.attempt_session
			)
				return {
					ok: false,
					code: "server_race",
					diagnostic: "bootstrap_server_identity_changed",
				};
		}
		if (directGenerationStale) {
			if (execution.server_absent_before)
				return {
					ok: false,
					code: "scope_bootstrap_failed",
					diagnostic: "owner_generation_stale_cleanup_uncertain",
				};
			if (server.pid !== execution.server_pid || server.startTime !== execution.server_start_time)
				return {
					ok: false,
					code: "scope_bootstrap_failed",
					diagnostic: "owner_generation_stale_cleanup_uncertain",
				};
			if (!nativeSessionId || !deps.cleanupSpawned)
				return {
					ok: false,
					code: "scope_bootstrap_failed",
					diagnostic: "owner_generation_stale_cleanup_uncertain",
				};
			try {
				deps.cleanupSpawned({ execution, nativeSessionId, server });
			} catch {
				return {
					ok: false,
					code: "scope_bootstrap_failed",
					diagnostic: "owner_generation_stale_cleanup_uncertain",
				};
			}
			return {
				ok: false,
				code: "scope_bootstrap_failed",
				diagnostic: "owner_generation_stale",
			};
		}
		if (
			execution.mode === "direct" &&
			!execution.server_absent_before &&
			(server.pid !== execution.server_pid || server.startTime !== execution.server_start_time)
		)
			return {
				ok: false,
				code: "server_race",
				diagnostic: "target_server_identity_changed",
			};
		return {
			ok: true,
			code: "executed",
			execution,
			server,
			server_key: execution.server_key,
			server_pid: server.pid,
			server_start_time: server.startTime,
			server_session: execution.attempt_session,
			...(nativeSessionId ? { native_session_id: nativeSessionId } : {}),
		};
	} catch {
		return {
			ok: false,
			code: "scope_bootstrap_failed",
			diagnostic: "synchronous_execution_failed",
		};
	}
}

/** Implements the target-server truth table before any tmux operation. */
export async function planTmuxOwnerIsolation(request: PlanRequest, probe: OwnerIsolationProbe): Promise<PlanResponse> {
	if (!isPlanRequest(request)) return failure("scope_unavailable", "invalid_plan_request");
	const attemptSession = tmuxAttemptSession(request.tmux_argv);
	if (!attemptSession) return failure("scope_unavailable", "attempt_session_missing");
	const currentBaseline = await captureOwnerGenerationBaseline(request.state_dir, request.session_id);
	if (!sameOwnerGenerationBaseline(currentBaseline, request.baseline))
		return failure("scope_unavailable", "owner_generation_stale");
	try {
		const server = await probe.probeServer(request.socket_key, tmuxControlArgv(request.tmux_argv));
		if (server.state === "unsafe") return failure("server_unsafe", "target_server_unsafe");
		if (server.state === "unverifiable") return failure("server_unverifiable", "target_server_unverifiable");
		if (server.state === "safe" && !isSafeServerProof(server, request.platform))
			return failure("server_unverifiable", "target_server_unverifiable");
		if (server.state === "safe") {
			return {
				schema_version: 1,
				ok: true,
				code: "not_required",
				execution: {
					mode: "direct",
					argv: [...request.tmux_argv],
					attempt_session: attemptSession,
					server_key: request.socket_key,
					server_absent_before: false,
					server_pid: server.pid,
					server_start_time: server.startTime,
				},
				classification: server.cgroup ?? { classification: "safe" },
				server_state: "safe",
			};
		}
		const classification = classifyCgroup({
			platform: request.platform,
			cgroupText: await probe.readCallerCgroup(),
		});
		if (classification.classification === "unverifiable")
			return failure("server_unverifiable", classification.diagnostic ?? "caller_cgroup_unverifiable");
		if (classification.classification !== "unsafe_service") {
			return {
				schema_version: 1,
				ok: true,
				code: "not_required",
				execution: {
					mode: "direct",
					argv: [...request.tmux_argv],
					attempt_session: attemptSession,
					server_key: request.socket_key,
					server_absent_before: true,
				},
				classification,
				server_state: "absent",
			};
		}
		const baseline = request.baseline;
		const token = crypto.randomUUID();
		const attempt: AttemptCapability = {
			token,
			session_name: attemptSession,
			socket_key: request.socket_key,
			server_absent_before: true,
			baseline,
			expires_at: new Date(Date.now() + 7_000).toISOString(),
		};
		await writeAttempt(request.state_dir, request.session_id, request.owner_generation, attempt);
		const expectedScope = `gjc-owner-${token}.scope`;
		const bootstrap: BootstrapRequest = {
			schema_version: 1,
			op: "bootstrap",
			session_id: request.session_id,
			owner_generation: request.owner_generation,
			state_dir: request.state_dir,
			socket_key: request.socket_key,
			expected_scope: expectedScope,
			tmux_argv: [...request.tmux_argv],
			attempt,
		};
		const stdinLine = JSON.stringify(bootstrap);
		return {
			schema_version: 1,
			ok: true,
			code: "unsafe_scope_required",
			execution: {
				mode: "scoped",
				argv: scopedExecutionArgv(expectedScope),
				stdin_line: stdinLine,
				expected_scope: expectedScope,
				attempt,
				attempt_session: attemptSession,
				server_key: request.socket_key,
				server_absent_before: true,
			},
			classification,
			server_state: "absent",
		};
	} catch {
		return failure("scope_unavailable", "asynchronous_probe_failed");
	}
}

export interface BootstrapRequest {
	schema_version: 1;
	op: "bootstrap";
	session_id: string;
	owner_generation: string;
	state_dir: string;
	socket_key: string;
	expected_scope: string;
	tmux_argv: string[];
	attempt: AttemptCapability;
}
export interface BootstrapResult {
	schema_version: 1;
	ok: boolean;
	code: "bootstrapped" | "scope_bootstrap_failed";
	native_session_id?: string;
	server_pid?: number;
	server_start_time?: string;
	session_name?: string;
	diagnostic?: string;
}

export interface BootstrapDependencies {
	readSelfCgroup(): Promise<string | null>;
	spawn(argv: string[]): { exitCode: number | null; stdout?: string };
	probeServer(socketKey: string, tmuxControlArgv?: string[]): Promise<TmuxServerProof>;
}

/** Self-proves the scope and synchronously invokes the exact supplied argv. */
export async function bootstrapTmuxOwnerIsolation(
	request: BootstrapRequest,
	deps: BootstrapDependencies,
): Promise<BootstrapResult> {
	if (!isBootstrapRequest(request))
		return {
			schema_version: 1,
			ok: false,
			code: "scope_bootstrap_failed",
			diagnostic: "invalid_bootstrap_request",
		};
	const paths = lifecyclePaths(request.state_dir, request.session_id, request.owner_generation);
	const generationLockToken = await acquireOwnerGenerationLock(paths, request.session_id);
	if (!generationLockToken)
		return {
			schema_version: 1,
			ok: false,
			code: "scope_bootstrap_failed",
			diagnostic: "generation_lock_contended",
		};
	let spawnedOwner = false;
	try {
		const attemptFile = path.join(paths.root, `attempt-${request.attempt.token}.json`);
		const recordedAttempt = await readJson<PersistedAttempt>(attemptFile);
		const currentBaseline = await captureOwnerGenerationBaseline(request.state_dir, request.session_id);
		const baselineMatches = sameOwnerGenerationBaseline(currentBaseline, request.attempt.baseline);
		const derivedSession = tmuxAttemptSession(request.tmux_argv);
		if (
			!baselineMatches ||
			!validPersistedAttempt(recordedAttempt, request) ||
			derivedSession !== request.attempt.session_name ||
			request.expected_scope !== `gjc-owner-${request.attempt.token}.scope`
		)
			return {
				schema_version: 1,
				ok: false,
				code: "scope_bootstrap_failed",
				diagnostic: "attempt_capability_invalid",
			};

		const expiresAt = Date.parse(recordedAttempt.expires_at);
		if (!Number.isFinite(expiresAt) || expiresAt <= Date.now() || expiresAt > Date.now() + 7_000)
			return {
				schema_version: 1,
				ok: false,
				code: "scope_bootstrap_failed",
				diagnostic: "attempt_capability_expired",
			};
		try {
			await fs.rename(attemptFile, `${attemptFile}.consumed`);
		} catch {
			return {
				schema_version: 1,
				ok: false,
				code: "scope_bootstrap_failed",
				diagnostic: "attempt_capability_replayed",
			};
		}
	} finally {
		await releaseVerdictLock(generationLockToken);
	}
	try {
		const controlArgv = tmuxControlArgv(request.tmux_argv);
		if (!controlArgv.length)
			return {
				schema_version: 1,
				ok: false,
				code: "scope_bootstrap_failed",
				diagnostic: "tmux_control_argv_invalid",
			};
		const cgroup = classifyCgroup({
			platform: "linux",
			cgroupText: await deps.readSelfCgroup(),
		});
		if (cgroup.classification !== "safe" || !cgroup.scope?.split("/").includes(request.expected_scope))
			return {
				schema_version: 1,
				ok: false,
				code: "scope_bootstrap_failed",
				diagnostic: "scope_self_proof_failed",
			};
		const spawnLockToken = await acquireOwnerGenerationLock(paths, request.session_id);
		if (!spawnLockToken)
			return {
				schema_version: 1,
				ok: false,
				code: "scope_bootstrap_failed",
				diagnostic: "generation_lock_contended",
			};
		let result: { exitCode: number | null; stdout?: string } | null = null;
		try {
			const currentBaseline = await captureOwnerGenerationBaseline(request.state_dir, request.session_id);
			const baselineMatches = sameOwnerGenerationBaseline(currentBaseline, request.attempt.baseline);
			if (!baselineMatches)
				return {
					schema_version: 1,
					ok: false,
					code: "scope_bootstrap_failed",
					diagnostic: "attempt_capability_invalid",
				};
			result = deps.spawn([...request.tmux_argv]);
		} finally {
			await releaseVerdictLock(spawnLockToken);
		}
		spawnedOwner = result?.exitCode === 0;
		if (result?.exitCode !== 0)
			return {
				schema_version: 1,
				ok: false,
				code: "scope_bootstrap_failed",
				diagnostic: "tmux_spawn_failed",
			};
		const nativeSessionId = result?.stdout?.trim();
		if (!nativeTmuxSessionId(nativeSessionId))
			return {
				schema_version: 1,
				ok: false,
				code: "scope_bootstrap_failed",
				diagnostic: "native_session_identity_unavailable_cleanup_uncertain",
			};
		const proof = await deps.probeServer(request.socket_key, controlArgv);
		if (!isSafeServerProof(proof))
			return {
				schema_version: 1,
				ok: false,
				code: "scope_bootstrap_failed",
				diagnostic: "server_proof_failed_cleanup_uncertain",
			};
		return {
			schema_version: 1,
			ok: true,
			code: "bootstrapped",
			native_session_id: nativeSessionId,
			server_pid: proof.pid,
			server_start_time: proof.startTime,
			session_name: request.attempt.session_name,
		};
	} catch {
		return {
			schema_version: 1,
			ok: false,
			code: "scope_bootstrap_failed",
			diagnostic: spawnedOwner ? "bootstrap_cleanup_uncertain" : "bootstrap_execution_failed",
		};
	}
}

export interface OwnerIntent {
	schema_version: 1;
	intent_id: string;
	generation: string;
	session_id: string;
	server_key: string;
	expected_terminal: { signal: "SIGTERM"; result: ExpectedTerminalResult };
	dispatch_id: string;
	created_at: string;
	expires_at: string;
	state: "pending";
}
export interface OwnerVerdict {
	schema_version: 1;
	generation: string;
	session_id: string;
	server_key: string;
	observed_at: string;
	signal: TerminalSignal;
	exit_code: number | null;
	result: string;
	observer: TerminalObserver;
	classification: VerdictClassification;
	reason: string;
	intent_id?: string;
	dedupe_key: string;
}
export interface OwnerIncident {
	schema_version: 1;
	generation: string;
	session_id: string;
	dedupe_key: string;
	created_at: string;
	classification: "unexpected_owner_loss";
}
export interface ObserveTerminalRequest {
	schema_version: 1;
	op: "observe_terminal";
	session_id: string;
	owner_generation: string;
	state_dir: string;
	socket_key: string;
	observer: TerminalObserver;
	observed_at: string;
	signal: TerminalSignal;
	exit_code: number | null;
	exit_kind: string;
	reason: string;
	operator_dispatch_id?: string;
}
export interface LifecyclePaths {
	root: string;
	generation: string;
	generationFile: string;
	generationMarkerFile: string;
	intentFile: string;
	verdictFile: string;
	verdictAliasFile: string;
	incidentFile: string;
	lockDatabaseFile: string;
	journalFile: string;
}
export function lifecyclePaths(stateDir: string, sessionId: string, generation: string): LifecyclePaths {
	const root = path.join(stateDir, sessionId, "owner-lifecycle");
	return {
		root,
		generation,
		generationFile: path.join(root, "generation.json"),
		generationMarkerFile: path.join(root, `generation-${encodeURIComponent(generation)}.published.json`),
		intentFile: path.join(root, `intent-${generation}.json`),
		verdictFile: path.join(root, `verdict-${generation}.json`),
		verdictAliasFile: path.join(root, "verdict.json"),

		incidentFile: path.join(root, `incident-${generation}.json`),
		lockDatabaseFile: path.join(root, "owner-locks.sqlite"),
		journalFile: path.join(root, `verdict-${generation}.journal`),
	};
}

export async function replaceOwnerGeneration(
	stateDir: string,
	sessionId: string,
	generation: string = crypto.randomUUID(),
	expectedBaseline?: OwnerGenerationBaseline,
): Promise<string> {
	const paths = lifecyclePaths(stateDir, sessionId, generation);
	const token = await acquireOwnerGenerationLock(paths, sessionId);
	if (!token) throw new Error("generation_lock_contended");
	try {
		const previous = await captureOwnerGenerationBaseline(stateDir, sessionId);
		if (expectedBaseline && !sameOwnerGenerationBaseline(previous, expectedBaseline))
			throw new Error("generation_baseline_changed");
		const published = {
			schema_version: 1 as const,
			generation,
			session_id: sessionId,
			published_at: new Date().toISOString(),
		};
		await publishImmutableGenerationMarker(paths.generationMarkerFile, published);
		if (previous.state === "current" && previous.generation !== generation)
			await ensureGenerationMarker(
				lifecyclePaths(stateDir, sessionId, previous.generation).generationMarkerFile,
				generationPublicationRecord(previous),
			);
		await atomicWrite(paths.generationFile, published);
		if (previous.state === "current" && previous.generation !== generation) {
			const prior = lifecyclePaths(stateDir, sessionId, previous.generation);
			const intent = await readJson<OwnerIntent>(prior.intentFile);
			if (intent?.state === "pending")
				await fs.rename(prior.intentFile, `${prior.intentFile}.invalidated`).catch(() => undefined);
		}
		return generation;
	} finally {
		await releaseVerdictLock(token);
	}
}

export type OwnerGenerationBaseline =
	| { state: "absent" }
	| {
			state: "current";
			schema_version: 1;
			generation: string;
			session_id: string;
			published_at: string;
	  };

function isOwnerGenerationBaseline(value: unknown): value is OwnerGenerationBaseline {
	return (
		isRecord(value) &&
		((Object.keys(value).length === 1 && value.state === "absent") ||
			(hasOnlyKeys(value, ["state", "schema_version", "generation", "session_id", "published_at"]) &&
				value.state === "current" &&
				value.schema_version === 1 &&
				nonEmpty(value.generation) &&
				nonEmpty(value.session_id) &&
				isCanonicalUtcTimestamp(value.published_at)))
	);
}

function generationPublicationRecord(baseline: Extract<OwnerGenerationBaseline, { state: "current" }>): {
	schema_version: 1;
	generation: string;
	session_id: string;
	published_at: string;
} {
	return {
		schema_version: baseline.schema_version,
		generation: baseline.generation,
		session_id: baseline.session_id,
		published_at: baseline.published_at,
	};
}

function sameOwnerGenerationBaseline(left: OwnerGenerationBaseline, right: OwnerGenerationBaseline): boolean {
	return (
		left.state === right.state &&
		(left.state === "absent" ||
			(right.state === "current" &&
				left.schema_version === right.schema_version &&
				left.generation === right.generation &&
				left.session_id === right.session_id &&
				left.published_at === right.published_at))
	);
}

export async function captureOwnerGenerationBaseline(
	stateDir: string,
	sessionId: string,
): Promise<OwnerGenerationBaseline> {
	const file = lifecyclePaths(stateDir, sessionId, "baseline").generationFile;
	try {
		await fs.access(file);
	} catch {
		return { state: "absent" };
	}
	const record = await readJson<unknown>(file);
	if (
		!isRecord(record) ||
		!hasOnlyKeys(record, ["schema_version", "generation", "session_id", "published_at"]) ||
		record.schema_version !== 1 ||
		record.session_id !== sessionId ||
		!nonEmpty(record.generation) ||
		!isCanonicalUtcTimestamp(record.published_at)
	)
		throw new Error("baseline_generation_corrupt");
	return {
		state: "current",
		schema_version: record.schema_version,
		generation: record.generation,
		session_id: record.session_id,
		published_at: record.published_at,
	};
}

/** Captures the full immutable generation record for a planned owner launch. */
export function captureOwnerGenerationBaselineSync(stateDir: string, sessionId: string): OwnerGenerationBaseline {
	const paths = lifecyclePaths(stateDir, sessionId, "baseline");
	if (!fsSync.existsSync(paths.generationFile)) return { state: "absent" };
	let record: unknown;
	try {
		record = JSON.parse(fsSync.readFileSync(paths.generationFile, "utf8"));
	} catch {
		throw new Error("baseline_generation_corrupt");
	}
	if (
		!isRecord(record) ||
		!hasOnlyKeys(record, ["schema_version", "generation", "session_id", "published_at"]) ||
		record.schema_version !== 1 ||
		record.session_id !== sessionId ||
		!nonEmpty(record.generation) ||
		!isCanonicalUtcTimestamp(record.published_at)
	)
		throw new Error("baseline_generation_corrupt");
	return {
		state: "current",
		schema_version: record.schema_version,
		generation: record.generation,
		session_id: record.session_id,
		published_at: record.published_at,
	};
}

export function isOwnerGenerationBaselineCurrentSync(
	stateDir: string,
	sessionId: string,
	baseline: OwnerGenerationBaseline,
): boolean {
	try {
		const current = captureOwnerGenerationBaselineSync(stateDir, sessionId);
		if (baseline.state === "absent") return current.state === "absent";
		return (
			current.state === "current" &&
			baseline.schema_version === current.schema_version &&
			baseline.generation === current.generation &&
			baseline.session_id === current.session_id &&
			baseline.published_at === current.published_at
		);
	} catch {
		return false;
	}
}

/** Synchronous publication for managed launch paths, serialized by a SQLite write transaction. */
export function replaceOwnerGenerationSync(
	stateDir: string,
	sessionId: string,
	generation: string,
	expectedBaseline: OwnerGenerationBaseline,
): string {
	const paths = lifecyclePaths(stateDir, sessionId, generation);
	const db = acquireSqliteLockSync(paths, 7_000);
	if (!db) throw new Error("generation_lock_contended");
	const temporaryGeneration = `${paths.generationFile}.${crypto.randomUUID()}.tmp`;
	try {
		if (!isOwnerGenerationBaselineCurrentSync(stateDir, sessionId, expectedBaseline))
			throw new Error("baseline_generation_changed");
		const previous = captureOwnerGenerationBaselineSync(stateDir, sessionId);
		const published = {
			schema_version: 1 as const,
			generation,
			session_id: sessionId,
			published_at: new Date().toISOString(),
		};
		publishImmutableGenerationMarkerSync(paths.generationMarkerFile, published);
		if (previous.state === "current" && previous.generation !== generation)
			ensureGenerationMarkerSync(
				lifecyclePaths(stateDir, sessionId, previous.generation).generationMarkerFile,
				generationPublicationRecord(previous),
			);
		fsSync.writeFileSync(temporaryGeneration, `${JSON.stringify(published)}\n`, { mode: 0o600, flag: "wx" });
		fsSync.renameSync(temporaryGeneration, paths.generationFile);
		if (previous.state === "current" && previous.generation !== generation) {
			const priorIntent = lifecyclePaths(stateDir, sessionId, previous.generation).intentFile;
			try {
				const intent = JSON.parse(fsSync.readFileSync(priorIntent, "utf8")) as { state?: unknown };
				if (intent.state === "pending") fsSync.renameSync(priorIntent, `${priorIntent}.invalidated`);
			} catch {}
		}
		db.exec("COMMIT");
		return generation;
	} catch (error) {
		try {
			db.exec("ROLLBACK");
		} catch {}

		throw error;
	} finally {
		try {
			fsSync.unlinkSync(temporaryGeneration);
		} catch {}
		db.close();
	}
}

/** Publishes a raw-owner generation through the canonical SQLite-serialized CAS path. */
export function publishOwnerGenerationSync(request: PublishGenerationRequest): PublishGenerationResult {
	const generation = replaceOwnerGenerationSync(
		request.state_dir,
		request.session_id,
		request.owner_generation,
		request.baseline,
	);
	return { schema_version: 1, ok: true, code: "generation_published", generation };
}

export async function createOwnerIntent(
	stateDir: string,
	input: Omit<OwnerIntent, "schema_version" | "intent_id" | "state">,
): Promise<OwnerIntent> {
	const intent: OwnerIntent = {
		schema_version: 1,
		intent_id: crypto.randomUUID(),
		state: "pending",
		...input,
	};
	if (!isValidOwnerIntent(intent)) throw new Error("owner_intent_invalid");
	const paths = lifecyclePaths(stateDir, input.session_id, input.generation);
	await fs.mkdir(paths.root, { recursive: true });
	const priorIntent = await Promise.any(
		["", ".consumed", ".cancelled", ".expired", ".invalidated"].map(suffix =>
			fs.access(`${paths.intentFile}${suffix}`),
		),
	)
		.then(() => true)
		.catch(() => false);
	if (priorIntent) throw new Error("owner_intent_replay");
	const handle = await fs.open(paths.intentFile, "wx", 0o600).catch(error => {
		if (isCode(error, "EEXIST")) throw new Error("owner_intent_replay");
		throw error;
	});
	try {
		await handle.writeFile(`${JSON.stringify(intent)}\n`);
		await handle.sync();
	} finally {
		await handle.close();
	}
	await fsyncDirectory(paths.root);
	return intent;
}

const VERDICT_LOCK_WAIT_TIMEOUT_MS = 250;
const GENERATION_LOCK_WAIT_TIMEOUT_MS = 7_000;

interface LiveSqliteLock {
	database: Database;
	file: string;
	active: boolean;
}

const liveSqliteLocks = new Map<string, LiveSqliteLock>();

function configureLockDatabase(database: Database, waitMs: number): void {
	database.exec(`PRAGMA busy_timeout = ${waitMs}`);
}

function setLockDatabaseMode(file: string): void {
	try {
		fsSync.chmodSync(file, 0o600);
	} catch {}
}

async function acquireSqliteLock(paths: LifecyclePaths, waitMs: number): Promise<string | null> {
	const deadline = Date.now() + waitMs;
	try {
		await fs.mkdir(paths.root, { recursive: true, mode: 0o700 });
	} catch {
		return null;
	}
	while (Date.now() <= deadline) {
		if ([...liveSqliteLocks.values()].some(lock => lock.active && lock.file === paths.lockDatabaseFile)) {
			await Bun.sleep(Math.min(10, Math.max(0, deadline - Date.now())));
			continue;
		}
		try {
			const database = new Database(paths.lockDatabaseFile);
			try {
				setLockDatabaseMode(paths.lockDatabaseFile);
				configureLockDatabase(database, Math.max(0, deadline - Date.now()));
				database.exec("BEGIN IMMEDIATE");
				const token = crypto.randomUUID();
				liveSqliteLocks.set(token, { database, file: paths.lockDatabaseFile, active: true });
				return token;
			} catch {
				database.close();
			}
		} catch {}
		if (Date.now() < deadline) await Bun.sleep(Math.min(10, deadline - Date.now()));
	}
	return null;
}

function acquireSqliteLockSync(paths: LifecyclePaths, waitMs: number): Database | null {
	try {
		fsSync.mkdirSync(paths.root, { recursive: true, mode: 0o700 });
		const database = new Database(paths.lockDatabaseFile);
		try {
			setLockDatabaseMode(paths.lockDatabaseFile);
			configureLockDatabase(database, waitMs);
			database.exec("BEGIN IMMEDIATE");
			return database;
		} catch {
			database.close();
			return null;
		}
	} catch {
		return null;
	}
}

async function acquireVerdictLock(paths: LifecyclePaths, _serverKey: string): Promise<string | null> {
	return acquireSqliteLock(paths, VERDICT_LOCK_WAIT_TIMEOUT_MS);
}

async function acquireOwnerGenerationLock(paths: LifecyclePaths, _sessionId: string): Promise<string | null> {
	return acquireSqliteLock(paths, GENERATION_LOCK_WAIT_TIMEOUT_MS);
}

async function ownsVerdictLock(token: string): Promise<boolean> {
	return liveSqliteLocks.get(token)?.active === true;
}

async function releaseVerdictLock(token: string): Promise<void> {
	const lock = liveSqliteLocks.get(token);
	if (!lock?.active) return;
	lock.active = false;
	liveSqliteLocks.delete(token);
	try {
		lock.database.exec("COMMIT");
	} catch {
		try {
			lock.database.exec("ROLLBACK");
		} catch {}
	} finally {
		lock.database.close();
	}
}

const ALLOWED_TERMINAL_EXIT_KINDS = new Set(["owner_lost", "cleanup", "process_postmortem", "exit"]);
const ALLOWED_TERMINAL_REASONS = new Set([
	"tmux_session_missing",
	"process_postmortem",
	"owner_exit",
	"sidecar",
	"integration",
	"test",
	"raw_terminal",
	"terminal_observation",
]);

function normalizeTerminalObservation(request: ObserveTerminalRequest): ObserveTerminalRequest {
	return {
		...request,
		exit_kind: ALLOWED_TERMINAL_EXIT_KINDS.has(request.exit_kind) ? request.exit_kind : "unknown_terminal",
		reason: ALLOWED_TERMINAL_REASONS.has(request.reason) ? request.reason : "terminal_observation",
	};
}

/** Publish exactly one terminal verdict. Existing valid verdicts always win. */
export async function observeOwnerTerminal(request: ObserveTerminalRequest): Promise<OwnerVerdict> {
	if (!isObserveTerminalRequest(request)) throw new Error("terminal_observation_invalid");
	const paths = lifecyclePaths(request.state_dir, request.session_id, request.owner_generation);
	let observation = normalizeTerminalObservation(request);
	const deadline = Date.now() + VERDICT_LOCK_WAIT_TIMEOUT_MS;
	let token: string | null = null;
	while (!token) {
		const current = await readJson<{ generation?: string }>(paths.generationFile);
		if (current?.generation !== request.owner_generation) throw new Error("generation_mismatch");
		token = await acquireVerdictLock(paths, request.socket_key);
		if (token) break;
		if (Date.now() >= deadline) throw new Error("verdict_lock_contended");
		await Bun.sleep(Math.min(10, Math.max(0, deadline - Date.now())));
	}
	if (!token) throw new Error("verdict_lock_contended");
	try {
		const current = await readJson<{ generation?: string }>(paths.generationFile);
		if (current?.generation !== request.owner_generation) throw new Error("generation_mismatch");
		const published = await readJson<OwnerVerdict>(paths.verdictFile);
		if (published && isValidOwnerVerdict(published, request)) return reconcileTerminalArtifacts(paths, published);
		const recoveredJournal = await readJson<{
			schema_version?: number;
			observation?: unknown;
		}>(paths.journalFile);
		if (recoveredJournal?.schema_version === 1 && isObserveTerminalRequest(recoveredJournal.observation)) {
			const recovered = recoveredJournal.observation;
			if (
				recovered.session_id === request.session_id &&
				recovered.owner_generation === request.owner_generation &&
				recovered.state_dir === request.state_dir &&
				recovered.socket_key === request.socket_key
			)
				observation = normalizeTerminalObservation(recovered);
		}
		await atomicWrite(paths.journalFile, {
			schema_version: 1,
			observation,
			token,
		});
		const intent = await readJson<OwnerIntent>(paths.intentFile);
		const expected = isExpectedIntent(intent, observation);
		const verdict: OwnerVerdict = {
			schema_version: 1,
			generation: observation.owner_generation,
			session_id: observation.session_id,
			server_key: observation.socket_key,
			observed_at: observation.observed_at,
			signal: observation.signal,
			exit_code: observation.exit_code,
			result: expected ? "owner_term_then_session_cleanup" : observation.exit_kind,
			observer: observation.observer,
			classification: expected
				? "expected_operator_shutdown"
				: observation.exit_kind === "cleanup"
					? "non_operator_cleanup"
					: "unexpected_owner_loss",
			reason: observation.reason,
			...(expected && intent ? { intent_id: intent.intent_id } : {}),
			dedupe_key: `owner-loss:${observation.session_id}:${observation.owner_generation}`,
		};
		if (!(await ownsVerdictLock(token))) throw new Error("verdict_lock_lost");
		let winner: OwnerVerdict;
		try {
			winner = await publishImmutableVerdict(paths.verdictFile, verdict, observation);
		} catch (error) {
			if (verdict.classification === "unexpected_owner_loss")
				await publishImmutableIncident(paths.incidentFile, {
					schema_version: 1,
					generation: verdict.generation,
					session_id: verdict.session_id,
					dedupe_key: verdict.dedupe_key,
					created_at: verdict.observed_at,
					classification: "unexpected_owner_loss",
				});
			throw error;
		}
		if (winner !== verdict) return reconcileTerminalArtifacts(paths, winner);
		if (expected && intent) {
			try {
				await fs.rename(paths.intentFile, `${paths.intentFile}.consumed`);
			} catch (error) {
				if (!isCode(error, "ENOENT")) throw new Error("owner_intent_consumption_failed");
				const consumed = await readJson<OwnerIntent>(`${paths.intentFile}.consumed`);
				if (!consumed || !isValidOwnerIntent(consumed, observation))
					throw new Error("owner_intent_consumption_failed");
			}
		}

		if (verdict.classification === "unexpected_owner_loss")
			await publishImmutableIncident(paths.incidentFile, {
				schema_version: 1,
				generation: verdict.generation,
				session_id: verdict.session_id,
				dedupe_key: verdict.dedupe_key,
				created_at: verdict.observed_at,
				classification: "unexpected_owner_loss",
			});
		await publishCurrentVerdictAlias(paths, verdict);
		await fs.unlink(paths.journalFile).catch(() => undefined);
		return verdict;
	} finally {
		await releaseVerdictLock(token);
	}
}

async function publishCurrentVerdictAlias(paths: LifecyclePaths, verdict: OwnerVerdict): Promise<void> {
	const current = await readJson<{
		schema_version?: number;
		session_id?: string;
		generation?: string;
	}>(paths.generationFile);
	if (
		current?.schema_version !== 1 ||
		current.session_id !== verdict.session_id ||
		current.generation !== verdict.generation
	)
		throw new Error("generation_mismatch");
	await atomicWrite(paths.verdictAliasFile, {
		...verdict,
		owner_generation: verdict.generation,
	});
}
async function reconcileTerminalArtifacts(paths: LifecyclePaths, verdict: OwnerVerdict): Promise<OwnerVerdict> {
	if (verdict.classification === "expected_operator_shutdown" && verdict.intent_id) {
		const intent = await readJson<OwnerIntent>(paths.intentFile);
		if (intent?.intent_id === verdict.intent_id) {
			try {
				await fs.rename(paths.intentFile, `${paths.intentFile}.consumed`);
			} catch {
				throw new Error("owner_intent_consumption_failed");
			}
		}
	}
	if (verdict.classification === "unexpected_owner_loss")
		await publishImmutableIncident(paths.incidentFile, {
			schema_version: 1,
			generation: verdict.generation,
			session_id: verdict.session_id,
			dedupe_key: verdict.dedupe_key,
			created_at: verdict.observed_at,
			classification: "unexpected_owner_loss",
		});
	await publishCurrentVerdictAlias(paths, verdict);
	await fs.unlink(paths.journalFile).catch(() => undefined);
	return verdict;
}

/** Strictly validate the persisted authorization, optionally against its terminal observation. */
export function isValidOwnerIntent(intent: unknown, request?: ObserveTerminalRequest): intent is OwnerIntent {
	if (
		!isRecord(intent) ||
		!hasOnlyKeys(intent, [
			"schema_version",
			"intent_id",
			"generation",
			"session_id",
			"server_key",
			"expected_terminal",
			"dispatch_id",
			"created_at",
			"expires_at",
			"state",
		]) ||
		intent.schema_version !== 1 ||
		!nonEmpty(intent.intent_id) ||
		!nonEmpty(intent.generation) ||
		!nonEmpty(intent.session_id) ||
		!nonEmpty(intent.server_key) ||
		!isRecord(intent.expected_terminal) ||
		!hasOnlyKeys(intent.expected_terminal, ["signal", "result"]) ||
		intent.expected_terminal.signal !== "SIGTERM" ||
		intent.expected_terminal.result !== "owner_term_then_session_cleanup" ||
		!nonEmpty(intent.dispatch_id) ||
		!nonEmpty(intent.created_at) ||
		!nonEmpty(intent.expires_at) ||
		intent.state !== "pending"
	)
		return false;
	const createdAt = Date.parse(intent.created_at);
	const expiresAt = Date.parse(intent.expires_at);
	if (!Number.isFinite(createdAt) || !Number.isFinite(expiresAt) || createdAt > expiresAt) return false;
	if (!request) return true;
	const observedAt = Date.parse(request.observed_at);
	return (
		Number.isFinite(observedAt) &&
		createdAt <= observedAt &&
		observedAt < expiresAt &&
		intent.generation === request.owner_generation &&
		intent.session_id === request.session_id &&
		intent.server_key === request.socket_key &&
		(request.operator_dispatch_id === undefined || intent.dispatch_id === request.operator_dispatch_id) &&
		request.signal === "SIGTERM"
	);
}

function isExpectedIntent(intent: OwnerIntent | null, request: ObserveTerminalRequest): boolean {
	return isValidOwnerIntent(intent, request);
}
/** Accept only real UTC timestamps in the canonical evidence serialization. */
export function isCanonicalUtcTimestamp(value: unknown): value is string {
	if (typeof value !== "string") return false;
	const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{3}))?Z$/.exec(value);
	if (!match) return false;
	const [, yearText, monthText, dayText, hourText, minuteText, secondText] = match;
	const year = Number(yearText);
	const month = Number(monthText);
	const day = Number(dayText);
	const hour = Number(hourText);
	const minute = Number(minuteText);
	const second = Number(secondText);
	if (month < 1 || month > 12 || hour > 23 || minute > 59 || second > 59) return false;
	const daysInMonth =
		month === 2
			? year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0)
				? 29
				: 28
			: [4, 6, 9, 11].includes(month)
				? 30
				: 31;
	return day >= 1 && day <= daysInMonth;
}

/** Strictly validate a complete persisted verdict, optionally against its observation. */
export function isValidOwnerVerdict(verdict: unknown, request?: ObserveTerminalRequest): verdict is OwnerVerdict {
	if (
		!isRecord(verdict) ||
		!hasOnlyKeys(verdict, [
			"schema_version",
			"generation",
			"session_id",
			"server_key",
			"observed_at",
			"signal",
			"exit_code",
			"result",
			"observer",
			"classification",
			"reason",
			"intent_id",
			"dedupe_key",
		]) ||
		verdict.schema_version !== 1 ||
		!nonEmpty(verdict.generation) ||
		!nonEmpty(verdict.session_id) ||
		!nonEmpty(verdict.server_key) ||
		!isCanonicalUtcTimestamp(verdict.observed_at) ||
		!isTerminalSignal(verdict.signal) ||
		(verdict.exit_code !== null && !Number.isSafeInteger(verdict.exit_code)) ||
		!nonEmpty(verdict.result) ||
		verdict.result.length > 64 ||
		!isTerminalObserver(verdict.observer) ||
		(verdict.classification !== "expected_operator_shutdown" &&
			verdict.classification !== "unexpected_owner_loss" &&
			verdict.classification !== "non_operator_cleanup") ||
		!nonEmpty(verdict.reason) ||
		!ALLOWED_TERMINAL_REASONS.has(verdict.reason) ||
		(verdict.intent_id !== undefined && !nonEmpty(verdict.intent_id)) ||
		verdict.dedupe_key !== `owner-loss:${verdict.session_id}:${verdict.generation}`
	)
		return false;
	const expected = verdict.classification === "expected_operator_shutdown";
	if (
		(expected &&
			(verdict.signal !== "SIGTERM" ||
				verdict.result !== "owner_term_then_session_cleanup" ||
				!nonEmpty(verdict.intent_id))) ||
		(!expected && verdict.intent_id !== undefined) ||
		(verdict.classification === "non_operator_cleanup" && verdict.result !== "cleanup") ||
		(verdict.classification === "unexpected_owner_loss" &&
			!ALLOWED_TERMINAL_EXIT_KINDS.has(verdict.result) &&
			verdict.result !== "unknown_terminal")
	)
		return false;
	return (
		!request ||
		(verdict.generation === request.owner_generation &&
			verdict.session_id === request.session_id &&
			verdict.server_key === request.socket_key)
	);
}

export interface ExactOwnerCloseRequest {
	stateDir: string;
	sessionId: string;
	generation: string;
	serverKey: string;
	pid: number;
	startTime: string;
	dispatchId: string;
	createdAt: string;
	expiresAt: string;
}
export interface ExactOwnerCloseDependencies {
	readStartTime(pid: number): Promise<string | null>;
	sendSigterm(pid: number): Promise<void>;
	waitForVerdict(): Promise<OwnerVerdict | null>;
	cleanupSession(): Promise<void>;
}

async function isCurrentOwnerGeneration(stateDir: string, sessionId: string, generation: string): Promise<boolean> {
	return (
		(await readJson<{ generation?: string }>(lifecyclePaths(stateDir, sessionId, generation).generationFile))
			?.generation === generation
	);
}

/** Authorizes only an exact, start-time-validated SIGTERM before compatibility cleanup. */
export async function closeExactTmuxOwner(
	request: ExactOwnerCloseRequest,
	deps: ExactOwnerCloseDependencies,
): Promise<OwnerVerdict> {
	const paths = lifecyclePaths(request.stateDir, request.sessionId, request.generation);
	const generationLockToken = await acquireOwnerGenerationLock(paths, request.sessionId);
	if (!generationLockToken) throw new Error("generation_lock_contended");
	let intent: OwnerIntent;
	try {
		if ((await deps.readStartTime(request.pid)) !== request.startTime) throw new Error("owner_pid_identity_mismatch");
		if (!(await isCurrentOwnerGeneration(request.stateDir, request.sessionId, request.generation)))
			throw new Error("owner_generation_mismatch");
		intent = await createOwnerIntent(request.stateDir, {
			generation: request.generation,
			session_id: request.sessionId,
			server_key: request.serverKey,
			expected_terminal: {
				signal: "SIGTERM",
				result: "owner_term_then_session_cleanup",
			},
			dispatch_id: request.dispatchId,
			created_at: request.createdAt,
			expires_at: request.expiresAt,
		});
		if (!(await isCurrentOwnerGeneration(request.stateDir, request.sessionId, request.generation))) {
			await fs.rename(paths.intentFile, `${paths.intentFile}.cancelled`).catch(() => undefined);
			throw new Error("owner_generation_mismatch");
		}
		if (!Number.isFinite(Date.parse(intent.expires_at)) || Date.parse(intent.expires_at) <= Date.now()) {
			await fs.rename(paths.intentFile, `${paths.intentFile}.expired`).catch(() => undefined);
			throw new Error("owner_term_verdict_timeout");
		}
		try {
			// The lock spans the final start-time proof and dispatch so replacement cannot revoke authorization between them.
			if ((await deps.readStartTime(request.pid)) !== request.startTime)
				throw new Error("owner_pid_identity_mismatch");
			if (!(await isCurrentOwnerGeneration(request.stateDir, request.sessionId, request.generation)))
				throw new Error("owner_generation_mismatch");
			await deps.sendSigterm(request.pid);
		} catch (error: unknown) {
			await fs.rename(paths.intentFile, `${paths.intentFile}.cancelled`).catch(() => undefined);
			throw error;
		}
	} finally {
		await releaseVerdictLock(generationLockToken);
	}
	const verdict = await deps.waitForVerdict();
	if (!verdict || verdict.intent_id !== intent.intent_id || verdict.classification !== "expected_operator_shutdown") {
		await fs.rename(paths.intentFile, `${paths.intentFile}.expired`).catch(() => undefined);
		throw new Error("owner_term_verdict_timeout");
	}
	await deps.cleanupSession();
	return verdict;
}

export function parseOwnerIsolationRequest(
	line: string,
): PlanRequest | BootstrapRequest | PublishGenerationRequest | ObserveTerminalRequest | null {
	if (Buffer.byteLength(line) > TMUX_OWNER_ISOLATION_MAX_LINE_BYTES || line.includes("\n")) return null;
	try {
		const parsed: unknown = JSON.parse(line);
		if (!isRecord(parsed)) return null;
		if (
			isPlanRequest(parsed) ||
			isBootstrapRequest(parsed) ||
			isPublishGenerationRequest(parsed) ||
			isObserveTerminalRequest(parsed)
		)
			return parsed;
		return null;
	} catch {
		return null;
	}
}
export function serializeOwnerIsolationResponse(
	response: PlanResponse | BootstrapResult | PublishGenerationResult | OwnerVerdict,
): string {
	const serialized = JSON.stringify(response);
	if (Buffer.byteLength(serialized) < TMUX_OWNER_ISOLATION_MAX_LINE_BYTES) return serialized;
	return JSON.stringify({
		schema_version: 1,
		ok: false,
		code: "scope_unavailable",
		diagnostic: "response_too_large",
	} satisfies PlanFailure);
}
function isPlanRequest(request: unknown): request is PlanRequest {
	return (
		isRecord(request) &&
		hasOnlyKeys(request, [
			"schema_version",
			"op",
			"platform",
			"session_id",
			"owner_generation",
			"cwd",
			"state_dir",
			"socket_key",
			"tmux_argv",
			"baseline",
		]) &&
		request.schema_version === 1 &&
		request.op === "plan" &&
		isPlatform(request.platform) &&
		typeof request.cwd === "string" &&
		nonEmpty(request.session_id) &&
		nonEmpty(request.owner_generation) &&
		nonEmpty(request.state_dir) &&
		nonEmpty(request.socket_key) &&
		isOwnerGenerationBaseline(request.baseline) &&
		validArgv(request.tmux_argv)
	);
}
function isBootstrapRequest(request: unknown): request is BootstrapRequest {
	return (
		isRecord(request) &&
		hasOnlyKeys(request, [
			"schema_version",
			"op",
			"session_id",
			"owner_generation",
			"state_dir",
			"socket_key",
			"expected_scope",
			"tmux_argv",
			"attempt",
		]) &&
		request.schema_version === 1 &&
		request.op === "bootstrap" &&
		nonEmpty(request.session_id) &&
		nonEmpty(request.owner_generation) &&
		nonEmpty(request.state_dir) &&
		nonEmpty(request.socket_key) &&
		nonEmpty(request.expected_scope) &&
		validArgv(request.tmux_argv) &&
		isAttemptCapability(request.attempt) &&
		request.attempt.socket_key === request.socket_key &&
		request.attempt.server_absent_before
	);
}
function isPublishGenerationRequest(request: unknown): request is PublishGenerationRequest {
	return (
		isRecord(request) &&
		hasOnlyKeys(request, ["schema_version", "op", "session_id", "owner_generation", "state_dir", "baseline"]) &&
		request.schema_version === 1 &&
		request.op === "publish_generation" &&
		nonEmpty(request.session_id) &&
		nonEmpty(request.owner_generation) &&
		nonEmpty(request.state_dir) &&
		isOwnerGenerationBaseline(request.baseline)
	);
}

function isObserveTerminalRequest(request: unknown): request is ObserveTerminalRequest {
	return (
		isRecord(request) &&
		hasOnlyKeys(request, [
			"schema_version",
			"op",
			"session_id",
			"owner_generation",
			"state_dir",
			"socket_key",
			"observer",
			"observed_at",
			"signal",
			"exit_code",
			"exit_kind",
			"reason",
			"operator_dispatch_id",
		]) &&
		request.schema_version === 1 &&
		request.op === "observe_terminal" &&
		nonEmpty(request.session_id) &&
		nonEmpty(request.owner_generation) &&
		nonEmpty(request.state_dir) &&
		nonEmpty(request.socket_key) &&
		isTerminalObserver(request.observer) &&
		isCanonicalUtcTimestamp(request.observed_at) &&
		isTerminalSignal(request.signal) &&
		nonEmpty(request.exit_kind) &&
		request.exit_kind.length <= 64 &&
		nonEmpty(request.reason) &&
		request.reason.length <= 64 &&
		(request.exit_code === null || Number.isSafeInteger(request.exit_code)) &&
		(request.operator_dispatch_id === undefined || nonEmpty(request.operator_dispatch_id))
	);
}
function isAttemptCapability(value: unknown): value is AttemptCapability {
	return (
		isRecord(value) &&
		hasOnlyKeys(value, ["token", "session_name", "socket_key", "server_absent_before", "baseline", "expires_at"]) &&
		nonEmpty(value.token) &&
		nonEmpty(value.session_name) &&
		nonEmpty(value.socket_key) &&
		typeof value.server_absent_before === "boolean" &&
		isOwnerGenerationBaseline(value.baseline) &&
		nonEmpty(value.expires_at) &&
		Number.isFinite(Date.parse(value.expires_at))
	);
}

function isPlatform(value: unknown): value is NodeJS.Platform {
	return (
		value === "aix" ||
		value === "android" ||
		value === "darwin" ||
		value === "freebsd" ||
		value === "haiku" ||
		value === "linux" ||
		value === "netbsd" ||
		value === "openbsd" ||
		value === "sunos" ||
		value === "win32" ||
		value === "cygwin"
	);
}
function isTerminalSignal(value: unknown): value is TerminalSignal {
	return (
		value === "SIGTERM" ||
		value === "SIGHUP" ||
		value === "SIGINT" ||
		value === "SIGKILL" ||
		value === "EXIT" ||
		value === "MANUAL" ||
		value === "UNKNOWN"
	);
}
function validPersistedAttempt(value: PersistedAttempt | null, request: BootstrapRequest): value is PersistedAttempt {
	return Boolean(
		value &&
			isOwnerGenerationBaseline(value.baseline) &&
			value.schema_version === 1 &&
			value.generation === request.owner_generation &&
			value.session_id === request.session_id &&
			value.token === request.attempt.token &&
			value.session_name === request.attempt.session_name &&
			value.socket_key === request.socket_key &&
			value.server_absent_before === true &&
			sameOwnerGenerationBaseline(value.baseline, request.attempt.baseline) &&
			value.expires_at === request.attempt.expires_at &&
			nonEmpty(value.created_at),
	);
}

function isTerminalObserver(value: unknown): value is TerminalObserver {
	return value === "sidecar" || value === "raw_monitor";
}
function hasOnlyKeys(record: Record<string, unknown>, allowed: string[]): boolean {
	return Object.keys(record).every(key => allowed.includes(key));
}
function nonEmpty(value: unknown): value is string {
	return typeof value === "string" && value.length > 0;
}
function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
function isCode(error: unknown, code: string): boolean {
	return isRecord(error) && error.code === code;
}
async function readJson<T>(file: string): Promise<T | null> {
	try {
		const parsed: unknown = JSON.parse(await fs.readFile(file, "utf8"));
		return isRecord(parsed) ? (parsed as T) : null;
	} catch {
		return null;
	}
}
async function publishImmutableVerdict(
	file: string,
	verdict: OwnerVerdict,
	request: ObserveTerminalRequest,
): Promise<OwnerVerdict> {
	const handle = await fs.open(file, "wx", 0o600).catch(async error => {
		if (!isCode(error, "EEXIST")) throw error;
		const existing = await readJson<OwnerVerdict>(file);
		if (!existing) throw new Error("immutable_record_corrupt");
		if (!isValidOwnerVerdict(existing, request)) throw new Error("immutable_record_conflict");
		return null;
	});
	if (!handle) {
		const existing = await readJson<OwnerVerdict>(file);
		if (!existing) throw new Error("immutable_record_corrupt");
		if (!isValidOwnerVerdict(existing, request)) throw new Error("immutable_record_conflict");
		return existing;
	}
	try {
		await handle.writeFile(`${JSON.stringify(verdict)}\n`);
		await handle.sync();
	} finally {
		await handle.close();
	}
	await fsyncDirectory(path.dirname(file));
	return verdict;
}
async function publishImmutableIncident(file: string, incident: OwnerIncident): Promise<OwnerIncident> {
	const handle = await fs.open(file, "wx", 0o600).catch(async error => {
		if (!isCode(error, "EEXIST")) throw error;
		const existing = await readJson<OwnerIncident>(file);
		if (!existing) throw new Error("immutable_record_corrupt");
		if (JSON.stringify(existing) !== JSON.stringify(incident)) throw new Error("immutable_record_conflict");
		return null;
	});
	if (!handle) return incident;
	try {
		await handle.writeFile(`${JSON.stringify(incident)}\n`);
		await handle.sync();
	} finally {
		await handle.close();
	}
	await fsyncDirectory(path.dirname(file));
	return incident;
}

async function publishImmutableGenerationMarker(
	file: string,
	generation: { schema_version: 1; generation: string; session_id: string; published_at: string },
): Promise<void> {
	const handle = await fs.open(file, "wx", 0o600).catch(error => {
		if (isCode(error, "EEXIST")) throw new Error("generation_replay");
		throw error;
	});
	try {
		await handle.writeFile(`${JSON.stringify(generation)}\n`);
		await handle.sync();
	} finally {
		await handle.close();
	}
	await fsyncDirectory(path.dirname(file));
}

function publishImmutableGenerationMarkerSync(
	file: string,
	generation: { schema_version: 1; generation: string; session_id: string; published_at: string },
): void {
	try {
		fsSync.writeFileSync(file, `${JSON.stringify(generation)}\n`, { mode: 0o600, flag: "wx" });
	} catch (error) {
		if (isCode(error, "EEXIST")) throw new Error("generation_replay");
		throw error;
	}
}

async function ensureGenerationMarker(
	file: string,
	generation: { schema_version: 1; generation: string; session_id: string; published_at: string },
): Promise<void> {
	try {
		await publishImmutableGenerationMarker(file, generation);
	} catch (error) {
		if ((error as Error).message !== "generation_replay") throw error;
		const existing = await readJson<typeof generation>(file);
		if (JSON.stringify(existing) !== JSON.stringify(generation)) throw error;
	}
}

function ensureGenerationMarkerSync(
	file: string,
	generation: { schema_version: 1; generation: string; session_id: string; published_at: string },
): void {
	try {
		publishImmutableGenerationMarkerSync(file, generation);
	} catch (error) {
		if ((error as Error).message !== "generation_replay") throw error;
		let existing: unknown;
		try {
			existing = JSON.parse(fsSync.readFileSync(file, "utf8"));
		} catch {
			throw error;
		}
		if (JSON.stringify(existing) !== JSON.stringify(generation)) throw error;
	}
}

async function atomicWrite(file: string, data: object): Promise<void> {
	const temp = `${file}.${crypto.randomUUID()}.tmp`;
	const handle = await fs.open(temp, "wx", 0o600);
	try {
		await handle.writeFile(`${JSON.stringify(data)}\n`);
		await handle.sync();
	} finally {
		await handle.close();
	}
	await fs.rename(temp, file);
	await fsyncDirectory(path.dirname(file));
}
async function fsyncDirectory(directoryPath: string): Promise<void> {
	const directory = await fs.open(directoryPath, "r");
	try {
		await directory.sync();
	} finally {
		await directory.close();
	}
}
async function writeAttempt(
	stateDir: string,
	sessionId: string,
	generation: string,
	attempt: AttemptCapability,
): Promise<void> {
	const root = lifecyclePaths(stateDir, sessionId, generation).root;
	await fs.mkdir(root, { recursive: true, mode: 0o700 });
	const file = path.join(root, `attempt-${attempt.token}.json`);
	const handle = await fs.open(file, "wx", 0o600);
	try {
		await handle.writeFile(
			`${JSON.stringify({
				schema_version: 1,
				generation,
				session_id: sessionId,
				...attempt,
				created_at: new Date().toISOString(),
			} satisfies PersistedAttempt)}\n`,
		);
		await handle.sync();
	} finally {
		await handle.close();
	}
	await fsyncDirectory(root);
}
