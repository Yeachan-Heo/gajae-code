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

import {
	type NativeOwnerOnlyFileReadResult,
	openRecoveryFsRoot,
	type RecoveryFsRoot,
	readOwnerOnlyFile,
	verifyOwnerOnlyPathSecurity,
} from "@gajae-code/natives";
import { isCompiledBinary } from "@gajae-code/utils/env";
import { observeProcessIncarnation, type ProcessIncarnationObservation } from "../sdk/broker/process-incarnation";
import { parseLinuxProcStartTime } from "./linux-proc";
import {
	isManagedOwnerAdmittedChild,
	isManagedOwnerBinding,
	isManagedOwnerChildExit,
	isManagedOwnerCooperativeReady,
	isManagedOwnerRelayRecord,
	isManagedOwnerShutdownCause,
	isManagedOwnerSigabrtReceipt,
	isManagedOwnerSupervisorIndex,
	MANAGED_OWNER_COOPERATIVE_SIGNAL,
	type ManagedOwnerBinding,
	type ManagedOwnerChildExit,
	type ManagedOwnerCooperativeReady,
	type ManagedOwnerRelayRecord,
	type ManagedOwnerShutdownCause,
	managedOwnerAdmittedChildPid,
} from "./managed-owner-binding";
import { ensureOwnerLifecycleDirectorySync, isPlainOwnerLifecycleFile } from "./owner-lifecycle-path";

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
	return parseLinuxProcStartTime(stat);
}

export interface TmuxServerProof {
	state: ServerState;
	pid?: number;
	startTime?: string;
	cgroup?: CgroupInfo;
	sessionNames?: string[];
	/**
	 * Whether `pid` is kernel-proved evidence about the live tmux server.
	 *
	 * Only Linux can prove a server PID (`/proc` + cgroup classification), so
	 * probes on other platforms may report a placeholder PID with this flag set
	 * to `false`. Guards must not build a `#{pid}` predicate from an unproven
	 * PID: no live tmux server can ever satisfy it. Omitted means proven, which
	 * keeps every probe that reads a real `#{pid}` unchanged.
	 */
	pidProven?: boolean;
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
	spawn(argv: string[], stdinLine?: string): { exitCode: number | null; stdout?: string; stderr?: string };
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

export function isSafeServerProof(
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

/** Compares the stable identity fields of independently observed tmux servers. */
export function sameServerIdentity(left: TmuxServerProof, right: TmuxServerProof): boolean {
	return (
		left.pid === right.pid &&
		left.startTime === right.startTime &&
		left.cgroup?.classification === right.cgroup?.classification &&
		left.cgroup?.scope === right.cgroup?.scope &&
		left.cgroup?.diagnostic === right.cgroup?.diagnostic
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
		if (result.exitCode !== 0) {
			if (execution.mode === "scoped") {
				try {
					const failure = JSON.parse(result.stdout ?? "") as { ok?: boolean; diagnostic?: unknown };
					if (failure.ok === false && typeof failure.diagnostic === "string")
						return {
							ok: false,
							code: "scope_bootstrap_failed",
							diagnostic: safeDiagnostic(failure.diagnostic),
						};
				} catch {
					return { ok: false, code: "scope_bootstrap_failed", diagnostic: "scoped_bootstrap_receipt_invalid" };
				}
				return { ok: false, code: "scope_bootstrap_failed", diagnostic: "scoped_bootstrap_receipt_invalid" };
			}
			return {
				ok: false,
				code: "scope_bootstrap_failed",
				diagnostic: safeDiagnostic(`planned_spawn_failed${result.stderr?.trim() ? `: ${result.stderr}` : ""}`),
			};
		}
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
	/** Darwin: names the one supervisor binding of this generation (no directory scan). */
	supervisorIndexFile: string;
	/** Darwin: durable proof that the exact supervisor delivered its cooperative signal for one intent. */
	relayFile: string;
	/** Darwin: published before delivery; removed once a confirmed delivery publishes `relayFile`. */
	relayPendingFile: string;
	/** Darwin: SQLite lock its closer holds for as long as it waits on the intent. */
	closerLockFile: string;
	/** Darwin: the admitted child installed its cooperative signal handler. */
	cooperativeReadyFile: string;
	/** Darwin: the child's first handled termination cause, created exclusively. */
	shutdownCauseFile: string;
	/** Darwin: the supervisor's reconciliation of the relayed child's actual exit. */
	childExitFile: string;
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
		supervisorIndexFile: path.join(root, `supervisor-${generation}.json`),
		relayFile: path.join(root, `relay-${generation}.json`),
		relayPendingFile: path.join(root, `relay-${generation}.pending.json`),
		closerLockFile: path.join(root, `closer-${generation}.sqlite`),
		cooperativeReadyFile: path.join(root, `cooperative-ready-${generation}.json`),
		shutdownCauseFile: path.join(root, `shutdown-cause-${generation}.json`),
		// Not `child-*`: that prefix is reserved for bindings in predecessor resolution.
		childExitFile: path.join(root, `supervised-exit-${generation}.json`),
	};
}

export interface MemoryGuardClaimPaths {
	root: string;
	databaseFile: string;
	walFile: string;
	shmFile: string;
}

export function memoryGuardClaimPaths(stateDir: string, sessionId: string): MemoryGuardClaimPaths {
	const root = path.join(stateDir, "memory-guard-claims", sessionId);
	const databaseFile = path.join(root, "claims.sqlite");
	return {
		root,
		databaseFile,
		walFile: `${databaseFile}-wal`,
		shmFile: `${databaseFile}-shm`,
	};
}

/**
 * A new generation's publication time, never earlier than the evidence it succeeds.
 * Predecessor proof compares the prior generation and its terminal against this
 * immutable timestamp, so a backward wall-clock correction between launches must
 * not make a genuine predecessor look newer. Runs under the generation lock.
 */
function monotonicGenerationPublishedAt(paths: LifecyclePaths, previous: OwnerGenerationBaseline): string {
	let floor = previous.state === "current" ? Date.parse(previous.published_at) : Number.NaN;
	try {
		const alias = JSON.parse(fsSync.readFileSync(paths.verdictAliasFile, "utf8")) as { observed_at?: unknown };
		if (typeof alias.observed_at === "string" && isCanonicalUtcTimestamp(alias.observed_at))
			floor = Number.isNaN(floor) ? Date.parse(alias.observed_at) : Math.max(floor, Date.parse(alias.observed_at));
	} catch {
		// Missing or unreadable history imposes no floor; predecessor proof still fails closed.
	}
	const now = Date.now();
	return new Date(Number.isNaN(floor) || now > floor ? now : floor + 1).toISOString();
}

/**
 * Every publication replaces the current generation only after its predecessor
 * check, inside the publication's own generation lock. The child admission fence
 * reads the current generation under that same lock, so a predecessor child is
 * either already bound (and refused here while its supervisor lives) or refused at
 * admission once replaced. No caller can publish around the check.
 */
function assertOwnerGenerationReplaceable(
	stateDir: string,
	sessionId: string,
	generation: string,
	previous: OwnerGenerationBaseline,
	observe: (pid: number) => ProcessIncarnationObservation,
): void {
	if (previous.state === "current" && previous.generation === generation) return;
	scanManagedOwnerPredecessor(stateDir, sessionId, previous, observe, generation);
}

/** Names a generation baseline for `MANAGED_OWNER_LAUNCH_BASELINE_ENV`. */
export function launchBaselineToken(baseline: OwnerGenerationBaseline): string {
	return generationToken(baseline.state === "current" ? baseline.generation : undefined);
}
function generationToken(generation: string | undefined): string {
	return generation === undefined ? "absent" : `current:${generation}`;
}

export async function replaceOwnerGeneration(
	stateDir: string,
	sessionId: string,
	generation: string = crypto.randomUUID(),
	expectedBaseline?: OwnerGenerationBaseline,
	observe: (pid: number) => ProcessIncarnationObservation = observeProcessIncarnation,
): Promise<string> {
	const paths = lifecyclePaths(stateDir, sessionId, generation);
	const token = await acquireOwnerGenerationLock(paths, sessionId);
	if (!token) throw new Error("generation_lock_contended");
	try {
		const previous = await captureOwnerGenerationBaseline(stateDir, sessionId);
		if (expectedBaseline && !sameOwnerGenerationBaseline(previous, expectedBaseline))
			throw new Error("generation_baseline_changed");
		assertOwnerGenerationReplaceable(stateDir, sessionId, generation, previous, observe);
		const published = {
			schema_version: 1 as const,
			generation,
			session_id: sessionId,
			published_at: monotonicGenerationPublishedAt(paths, previous),
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

export interface ManagedOwnerPredecessorEvidence {
	generation: string;
	sessionId: string;
	runId: string;
	incarnation: string;
	predecessorToken: string;
}

function exactManagedOwnerJson(authority: RecoveryFsRoot, name: string): unknown {
	const first = authority.read(name, 64 * 1024);
	if (!first.ok || !first.data) throw new Error("managed_owner_replacement_evidence_unavailable");
	const second = authority.read(name, 64 * 1024);
	if (
		!second.ok ||
		!second.data ||
		Buffer.compare(Buffer.from(first.data), Buffer.from(second.data)) !== 0 ||
		JSON.stringify(first.identity) !== JSON.stringify(second.identity)
	)
		throw new Error("managed_owner_replacement_evidence_changed");
	const content = Buffer.from(first.data).toString("utf8");
	if (!content.endsWith("\n") || content.indexOf("\n") !== content.length - 1)
		throw new Error("managed_owner_replacement_evidence_untrusted");
	return JSON.parse(content);
}

/** Resolve one SIGABRT predecessor from the retained exact prior-generation root. */
export function resolveManagedOwnerPredecessorSync(
	stateDir: string,
	sessionId: string,
	baseline: OwnerGenerationBaseline,
	observe: (pid: number) => ProcessIncarnationObservation = observeProcessIncarnation,
): ManagedOwnerPredecessorEvidence | undefined {
	return scanManagedOwnerPredecessor(stateDir, sessionId, baseline, observe);
}

/**
 * `publishing` names the generation being published, whose own binding (its session
 * exists before publication) is not a predecessor.
 */
function scanManagedOwnerPredecessor(
	stateDir: string,
	sessionId: string,
	baseline: OwnerGenerationBaseline,
	observe: (pid: number) => ProcessIncarnationObservation,
	publishing?: string,
): ManagedOwnerPredecessorEvidence | undefined {
	// Off Linux an absent baseline still needs the scan: a launch that crashed before the
	// first publication can leave a live owner behind.
	if (baseline.state === "absent" && process.platform === "linux") return undefined;
	const root = lifecyclePaths(stateDir, sessionId, "").root;
	let entries: string[];
	try {
		entries = fsSync.readdirSync(root);
	} catch (error) {
		if (baseline.state === "absent" && isCode(error, "ENOENT")) return undefined;
		throw new Error("managed_owner_replacement_evidence_unavailable");
	}
	const bindings = new Set<string>();
	const receipts = new Set<string>();
	for (const entry of entries) {
		const binding = /^child-([^/]+)\.binding\.json$/.exec(entry);
		const receipt = /^sigabrt-([^/]+)\.receipt\.json$/.exec(entry);
		if (entry.startsWith("child-") && !binding) throw new Error("managed_owner_replacement_evidence_untrusted");
		if (entry.startsWith("sigabrt-") && !receipt) throw new Error("managed_owner_replacement_evidence_untrusted");
		if (binding) bindings.add(binding[1]!);
		if (receipt) receipts.add(receipt[1]!);
	}
	if (bindings.size === 0 && receipts.size === 0) return undefined;
	// SIGABRT receipts are a Linux-only capability. Elsewhere a binding without a receipt
	// is history only once its exact supervisor and every process admitted through it
	// have positively exited. That holds for every generation in the root, not only the
	// baseline: a launch that crashed before publishing leaves a binding of a generation
	// that never became current, whose owner may still be live.
	if (receipts.size === 0 && process.platform !== "linux") {
		for (const token of bindings) assertPriorOwnerExited(root, entries, publishing, sessionId, token, observe);
		return undefined;
	}
	if (baseline.state === "absent") throw new Error("managed_owner_replacement_evidence_unavailable");
	const tokens = [...bindings].filter(token => receipts.has(token));
	if (tokens.length !== 1 || receipts.size !== 1) throw new Error("managed_owner_replacement_evidence_ambiguous");
	const predecessorToken = tokens[0]!;
	if (!/^[A-Za-z0-9._-]+$/.test(predecessorToken)) throw new Error("managed_owner_replacement_evidence_untrusted");
	if (process.platform !== "linux") throw new Error("managed_owner_replacement_evidence_unavailable");
	const authority = openRecoveryFsRoot(root);
	try {
		const binding = exactManagedOwnerJson(authority, `child-${predecessorToken}.binding.json`);
		const receipt = exactManagedOwnerJson(authority, `sigabrt-${predecessorToken}.receipt.json`);
		if (
			!isManagedOwnerBinding(binding) ||
			binding.binding_kind !== "recoverable" ||
			binding.generation !== baseline.generation ||
			binding.session_id !== sessionId ||
			binding.child_token !== predecessorToken ||
			!isManagedOwnerSigabrtReceipt(receipt, binding)
		)
			throw new Error("managed_owner_replacement_evidence_untrusted");
		return {
			generation: baseline.generation,
			sessionId,
			runId: binding.run_id,
			incarnation: binding.endpoint_incarnation,
			predecessorToken,
		};
	} finally {
		authority.close();
	}
}

/** Proves a binding's supervisor and every process admitted through it gone, unless it is the publisher's own. */
function assertPriorOwnerExited(
	root: string,
	entries: readonly string[],
	publishing: string | undefined,
	sessionId: string,
	token: string,
	observe: (pid: number) => ProcessIncarnationObservation,
): void {
	if (!/^[A-Za-z0-9._-]+$/.test(token)) throw new Error("managed_owner_replacement_evidence_untrusted");
	const binding = readSecureOwnerJson(path.join(root, `child-${token}.binding.json`));
	if (!isManagedOwnerBinding(binding) || binding.session_id !== sessionId || binding.child_token !== token)
		throw new Error("managed_owner_replacement_evidence_untrusted");
	if (binding.generation === publishing) return;
	// A live or unobservable predecessor supervisor still owns its generation.
	assertProcessExited(observe(binding.supervisor_pid), binding.supervisor_start_time);
	// A supervisor killed after admission never reconciled its child, so every process
	// admitted through this binding must also be gone. One that has not recorded itself
	// yet is refused at its fence, which needs its launch baseline still current.
	for (const entry of entries) {
		const pid = managedOwnerAdmittedChildPid(token, entry);
		if (pid === undefined) continue;
		let admitted: unknown;
		try {
			admitted = readSecureOwnerJson(path.join(root, entry));
		} catch {
			throw new Error("managed_owner_replacement_evidence_untrusted");
		}
		if (!isManagedOwnerAdmittedChild(admitted, binding, entry))
			throw new Error("managed_owner_replacement_evidence_untrusted");
		assertProcessExited(observe(pid), admitted.child_incarnation);
	}
}

function assertProcessExited(observation: ProcessIncarnationObservation, incarnation: string): void {
	if (observation.status === "absent") return;
	// A reused pid is a different process.
	if (observation.status === "present" && observation.incarnation !== incarnation) return;
	throw new Error(
		observation.status === "present"
			? "managed_owner_predecessor_live"
			: "managed_owner_replacement_evidence_unavailable",
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
	observe: (pid: number) => ProcessIncarnationObservation = observeProcessIncarnation,
): string {
	const paths = lifecyclePaths(stateDir, sessionId, generation);
	const db = acquireSqliteLockSync(paths, 7_000);
	if (!db) throw new Error("generation_lock_contended");
	const temporaryGeneration = `${paths.generationFile}.${crypto.randomUUID()}.tmp`;
	try {
		if (!isOwnerGenerationBaselineCurrentSync(stateDir, sessionId, expectedBaseline))
			throw new Error("baseline_generation_changed");
		const previous = captureOwnerGenerationBaselineSync(stateDir, sessionId);
		assertOwnerGenerationReplaceable(stateDir, sessionId, generation, previous, observe);
		const published = {
			schema_version: 1 as const,
			generation,
			session_id: sessionId,
			published_at: monotonicGenerationPublishedAt(paths, previous),
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

/**
 * Child admission fence. Once a generation is published (its immutable marker
 * exists), its child is admitted only while that generation is still current,
 * read under the generation lock that also holds a relaunch's predecessor check
 * and publication. So either the relaunch saw this child's binding and refused a
 * live predecessor, or it replaced the generation first and this child is
 * refused: no admitted child is left behind a generation that close no longer
 * reaches. On Linux a child of a generation not yet published is admitted; its
 * launcher's publication then fails the baseline check against any replacement and
 * removes the session. Off Linux that cleanup is not relied on, because the
 * launcher may have died: such a child, which recorded itself before this fence,
 * is admitted only while `launchBaseline` (`launchBaselineToken` of the baseline
 * its launcher captured) is still current under the lock. A relaunch that
 * publishes later scans under that lock and finds the child's record.
 */
export function assertManagedOwnerGenerationNotReplaced(
	stateDir: string,
	sessionId: string,
	generation: string,
	launchBaseline: string | undefined,
): void {
	const paths = lifecyclePaths(stateDir, sessionId, generation);
	if (!lifecycleEntryExists(paths.generationMarkerFile)) {
		if (process.platform === "linux") return;
		if (launchBaseline === undefined) throw new Error("owner_generation_unverifiable");
		// No publisher has taken the lock, so nothing was published since an absent
		// baseline; one that does scans after taking it and finds this child's record.
		if (!lifecycleEntryExists(paths.lockDatabaseFile)) {
			if (launchBaseline === generationToken(undefined)) return;
			throw new Error("owner_generation_unverifiable");
		}
	}
	const db = acquireSqliteLockSync(paths, GENERATION_LOCK_WAIT_TIMEOUT_MS, true);
	if (!db) throw new Error("owner_generation_unverifiable");
	try {
		const published = lifecycleEntryExists(paths.generationMarkerFile);
		let current: unknown;
		try {
			current = lifecycleEntryExists(paths.generationFile) ? readSecureOwnerJson(paths.generationFile) : undefined;
		} catch {
			throw new Error("owner_generation_unverifiable");
		}
		if (
			current !== undefined &&
			(!isRecord(current) || current.session_id !== sessionId || !nonEmpty(current.generation))
		)
			throw new Error("owner_generation_unverifiable");
		const currentGeneration = current === undefined ? undefined : (current as { generation: string }).generation;
		if (published) {
			if (currentGeneration === undefined) throw new Error("owner_generation_unverifiable");
			if (currentGeneration !== generation) throw new Error("owner_generation_stale");
			return;
		}
		if (generationToken(currentGeneration) !== launchBaseline) throw new Error("owner_generation_stale");
	} finally {
		try {
			db.exec("COMMIT");
		} catch {
		} finally {
			db.close();
		}
	}
}

function lifecycleEntryExists(file: string): boolean {
	try {
		fsSync.lstatSync(file);
		return true;
	} catch (error) {
		if (isCode(error, "ENOENT")) return false;
		throw new Error("owner_generation_unverifiable");
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

function ownerIntentRecord(input: Omit<OwnerIntent, "schema_version" | "intent_id" | "state">): OwnerIntent {
	return {
		schema_version: 1,
		intent_id: crypto.randomUUID(),
		state: "pending",
		...input,
	};
}

export async function createOwnerIntent(
	stateDir: string,
	input: Omit<OwnerIntent, "schema_version" | "intent_id" | "state">,
): Promise<OwnerIntent> {
	const intent = ownerIntentRecord(input);
	if (!isValidOwnerIntent(intent)) throw new Error("owner_intent_invalid");
	const paths = lifecyclePaths(stateDir, input.session_id, input.generation);
	if (!ensureOwnerLifecycleDirectorySync(paths.root)) throw new Error("owner_lifecycle_root_unsafe");
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
/**
 * Darwin: a supervisor holds the generation lock across one relay (pending record,
 * signal, confirmed record, directory sync). A signaled child's observer that finds
 * that relay in flight waits for it to settle instead of failing on transient
 * contention; the bound stays inside the default postmortem cleanup deadline.
 */
const RELAY_SETTLE_WAIT_TIMEOUT_MS = 3_000;
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

/**
 * Open a lifecycle lock database only as a plain file in its root. A missing one
 * is created exclusively, mode 0600, so it is never created at a link's target,
 * and SQLite opens it with `create: false`. The checks never open a descriptor
 * on an existing database: closing one would drop the POSIX locks this process
 * already holds on it through SQLite.
 */
function openOwnerLockDatabase(file: string, create: boolean): Database | null {
	if (create) {
		try {
			fsSync.closeSync(fsSync.openSync(file, "wx", 0o600));
		} catch (error) {
			if (!isCode(error, "EEXIST")) return null;
		}
	}
	if (!isPlainOwnerLifecycleFile(file)) return null;
	return new Database(file, { readwrite: true, create: false });
}

async function acquireSqliteLock(paths: LifecyclePaths, waitMs: number): Promise<string | null> {
	const deadline = Date.now() + waitMs;
	if (!ensureOwnerLifecycleDirectorySync(paths.root)) return null;
	while (Date.now() <= deadline) {
		if ([...liveSqliteLocks.values()].some(lock => lock.active && lock.file === paths.lockDatabaseFile)) {
			await Bun.sleep(Math.min(10, Math.max(0, deadline - Date.now())));
			continue;
		}
		try {
			const database = openOwnerLockDatabase(paths.lockDatabaseFile, true);
			if (!database) return null;
			try {
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

/**
 * Darwin: the closer holds this lock from before its intent is visible until it stops
 * waiting. The OS releases it when the closer exits or crashes, so "a closer is still
 * waiting" never depends on a wall clock.
 */
function holdCloserLock(paths: LifecyclePaths): Database | null {
	try {
		// Never open or chmod a path that is not already this owner's private file: a
		// missing lock is created exclusively without following links.
		try {
			fsSync.lstatSync(paths.closerLockFile);
		} catch (error) {
			if (!isCode(error, "ENOENT")) return null;
			const { O_CREAT, O_EXCL, O_NOFOLLOW, O_RDWR } = fsSync.constants;
			fsSync.closeSync(fsSync.openSync(paths.closerLockFile, O_CREAT | O_EXCL | O_NOFOLLOW | O_RDWR, 0o600));
		}
		if (!verifyOwnerOnlyPathSecurity(paths.closerLockFile, "file").ok) return null;
		const database = new Database(paths.closerLockFile, { readwrite: true, create: false });
		try {
			configureLockDatabase(database, 0);
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

function releaseCloserLock(database: Database): void {
	try {
		database.exec("ROLLBACK");
	} catch {
	} finally {
		database.close();
	}
}

/** Darwin: whether the closer that published this generation's intent is still waiting. */
function closerWaiting(paths: LifecyclePaths): boolean {
	if (!verifyOwnerOnlyPathSecurity(paths.closerLockFile, "file").ok) return false;
	let database: Database;
	try {
		database = new Database(paths.closerLockFile, { readwrite: true, create: false });
	} catch {
		return false;
	}
	try {
		configureLockDatabase(database, 0);
		database.exec("BEGIN IMMEDIATE");
		database.exec("ROLLBACK");
		return false;
	} catch (error) {
		return (error as { code?: unknown }).code === "SQLITE_BUSY";
	} finally {
		database.close();
	}
}

function acquireSqliteLockSync(paths: LifecyclePaths, waitMs: number, existingOnly = false): Database | null {
	try {
		if (existingOnly) {
			if (
				!verifyOwnerOnlyPathSecurity(paths.root, "directory").ok ||
				!verifyOwnerOnlyPathSecurity(paths.lockDatabaseFile, "file").ok
			)
				return null;
		} else if (!ensureOwnerLifecycleDirectorySync(paths.root)) return null;
		const database = openOwnerLockDatabase(paths.lockDatabaseFile, !existingOnly);
		if (!database) return null;
		try {
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

/** One process must not race its own duplicate terminal observers through SQLite. */
const liveOwnerTerminalObservations = new Map<string, Promise<OwnerVerdict>>();

/** Publish exactly one terminal verdict. Existing valid verdicts always win. */
export async function observeOwnerTerminal(request: ObserveTerminalRequest): Promise<OwnerVerdict> {
	if (!isObserveTerminalRequest(request)) throw new Error("terminal_observation_invalid");
	const paths = lifecyclePaths(request.state_dir, request.session_id, request.owner_generation);
	const observationKey = JSON.stringify([paths.verdictFile, request.socket_key]);
	const existing = liveOwnerTerminalObservations.get(observationKey);
	if (existing) return existing;
	const observation = observeOwnerTerminalExclusive(request);
	liveOwnerTerminalObservations.set(observationKey, observation);
	try {
		return await observation;
	} finally {
		if (liveOwnerTerminalObservations.get(observationKey) === observation)
			liveOwnerTerminalObservations.delete(observationKey);
	}
}

/** Publish exactly one terminal verdict. Existing valid verdicts always win. */
async function observeOwnerTerminalExclusive(request: ObserveTerminalRequest): Promise<OwnerVerdict> {
	if (!isObserveTerminalRequest(request)) throw new Error("terminal_observation_invalid");
	const paths = lifecyclePaths(request.state_dir, request.session_id, request.owner_generation);
	let observation = normalizeTerminalObservation(request);
	const started = Date.now();
	let deadline = started + VERDICT_LOCK_WAIT_TIMEOUT_MS;
	let token: string | null = null;
	while (!token) {
		const current = await readJson<{ generation?: string }>(paths.generationFile);
		if (current?.generation !== request.owner_generation) throw new Error("generation_mismatch");
		token = await acquireVerdictLock(paths, request.socket_key);
		if (token) break;
		if (Date.now() >= deadline && relayInFlight(paths)) deadline = started + RELAY_SETTLE_WAIT_TIMEOUT_MS;
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
		const expected = isExpectedOwnerTerminal(paths, intent, observation);
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
		request.operator_dispatch_id !== undefined &&
		intent.dispatch_id === request.operator_dispatch_id &&
		request.signal === "SIGTERM"
	);
}

/**
 * Whether a terminal observation is the expected result of this exact intent.
 *
 * Without a cooperative supervisor index (Linux) the closer itself delivers SIGTERM
 * right after publishing the intent, so the intent must be live at observation.
 *
 * With an index (Darwin) only the exact supervisor delivers, and a pending intent
 * alone does not explain a SIGTERM: an unrelated signal can arrive while it is still
 * unconsumed. The supervisor's confirmed relay record must exist for this intent, its
 * `relayed_at` (sampled immediately before delivery) must fall inside the intent's
 * window, and the observation must not precede it, so an earlier unrelated signal
 * is never attributed to a later relay. A timely relay still explains an observation
 * made after expiry, for example by a child that was stopped and handled the signal
 * late. A Darwin closer never signals, so a missing index is never evidence there.
 * Delivery and timestamps still do not prove causation: an unrelated SIGTERM can
 * start the child's shutdown between `relayed_at` and delivery. The index's exact
 * child must also have recorded the cooperative signal as the first termination
 * cause it handled, which an earlier SIGTERM, SIGHUP or SIGINT always preempts.
 */
function isExpectedOwnerTerminal(
	paths: LifecyclePaths,
	intent: OwnerIntent | null,
	request: ObserveTerminalRequest,
): boolean {
	try {
		fsSync.lstatSync(paths.supervisorIndexFile);
	} catch (error) {
		if (isCode(error, "ENOENT") && process.platform !== "darwin") return isValidOwnerIntent(intent, request);
		return false;
	}
	if (!isValidOwnerIntent(intent)) return false;
	let relay: ManagedOwnerRelayRecord | null;
	try {
		relay = readCooperativeRelayRecord(paths, intent);
	} catch {
		return false;
	}
	if (!relay || !isCanonicalUtcTimestamp(relay.relayed_at)) return false;
	// Delivery alone is not causation: the child must have handled the relay first.
	const index = readSupervisorIndex(paths, intent);
	if (!index || relay.child_token !== index.child_token || !managedOwnerCooperativeCause(paths, index)) return false;
	const observedAt = Date.parse(request.observed_at);
	return (
		Number.isFinite(observedAt) &&
		observedAt >= Date.parse(relay.relayed_at) &&
		isValidOwnerIntent(intent, { ...request, observed_at: relay.relayed_at })
	);
}

/**
 * Whether the supervisor has already published a pending or confirmed relay record
 * for this exact intent. Where a supervisor relays (Darwin, or any generation with a
 * supervisor index) it publishes the pending record durably before signaling, so a
 * terminal captured while neither record exists cannot be that relay's signal,
 * whatever the wall clock says. A Linux generation without an index has no relay:
 * its closer signals directly.
 */
export function cooperativeRelayVisible(paths: LifecyclePaths, intent: OwnerIntent): boolean {
	try {
		fsSync.lstatSync(paths.supervisorIndexFile);
	} catch (error) {
		return isCode(error, "ENOENT") && process.platform !== "darwin";
	}
	// The supervisor publishes the confirmed record before removing the pending one.
	for (const file of [paths.relayPendingFile, paths.relayFile])
		try {
			const record = readSecureOwnerJson(file);
			if (
				isRecord(record) &&
				record.intent_id === intent.intent_id &&
				record.dispatch_id === intent.dispatch_id &&
				record.generation === intent.generation
			)
				return true;
		} catch {}
	return false;
}

/**
 * A Darwin supervisor is relaying under the generation lock: its pending record is
 * published, or its confirmed record is published and the lock is still held for the
 * final directory flush.
 */
function relayInFlight(paths: LifecyclePaths): boolean {
	for (const file of [paths.relayPendingFile, paths.relayFile])
		try {
			fsSync.lstatSync(file);
			return true;
		} catch {}
	return false;
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
	shutdown:
		| { kind: "kernel_signal"; sendSigterm(pid: number): Promise<void> }
		| {
				kind: "cooperative_intent";
				assertCooperativeOwner(): void;
				/**
				 * Publishes `file` under the private lifecycle `root` without replacement, running
				 * `assertOwned` immediately before the commit. Injected so this module, reachable from
				 * machine entrypoints, does not depend on session storage.
				 */
				publishNoReplace(root: string, file: string, bytes: Uint8Array, assertOwned: () => void): Promise<void>;
		  };
	waitForVerdict(intent: OwnerIntent): Promise<OwnerVerdict | null>;
	cleanupSession(): Promise<void>;
}

/** Bounded native evidence reads; never reopen through a pathname fallback. */
export function readSecureOwnerJson(file: string): unknown {
	const result = readOwnerOnlyFileSettled(file, 65536);
	if (!result.ok || !result.data) throw new Error("owner_evidence_unavailable");
	return parseExactOwnerJson(result.data, "owner_evidence_framing_invalid");
}

const OWNER_READ_SETTLE_ATTEMPTS = 8;
const OWNER_READ_SETTLE_DELAY_MS = 2;

/**
 * The native reader requires the file and its private parent directory to keep
 * identical metadata across the whole read window. Launcher and supervisor
 * legitimately publish sibling evidence in the same lifecycle root (generation
 * marker, SQLite lock journal, bindings), which changes the parent's mtime and
 * fails an otherwise exact read with `metadata_changed`. Only that transient code
 * is retried, a bounded number of times; every attempt re-acquires the complete
 * descriptor authority, so identity, ownership, link-count and security failures
 * still fail closed on the first observation.
 */
export function readOwnerOnlyFileSettled(file: string, maxBytes: number): NativeOwnerOnlyFileReadResult {
	let result = readOwnerOnlyFile(file, maxBytes);
	for (
		let attempt = 1;
		attempt < OWNER_READ_SETTLE_ATTEMPTS && !result.ok && result.code === "metadata_changed";
		attempt++
	) {
		Bun.sleepSync(OWNER_READ_SETTLE_DELAY_MS);
		result = readOwnerOnlyFile(file, maxBytes);
	}
	return result;
}

export function parseExactOwnerJson(
	data: Uint8Array,
	framingError: "owner_evidence_framing_invalid" | "managed_owner_json_framing_invalid",
): unknown {
	const text = Buffer.from(data).toString("utf8");
	if (!text.endsWith("\n") || text.indexOf("\n") !== text.length - 1 || text.includes("\r"))
		throw new Error(framingError);
	return JSON.parse(text);
}

function assertSecureGeneration(paths: LifecyclePaths, sessionId: string): void {
	const generation = readSecureOwnerJson(paths.generationFile);
	if (
		!isRecord(generation) ||
		Object.keys(generation).length !== 4 ||
		generation.schema_version !== 1 ||
		generation.session_id !== sessionId ||
		generation.generation !== paths.generation ||
		!isCanonicalUtcTimestamp(generation.published_at)
	)
		throw new Error("owner_generation_mismatch");
}

function assertNoIntentHistory(paths: LifecyclePaths, includeCanonical: boolean): void {
	const files = [
		...(includeCanonical ? [paths.intentFile] : []),
		...[".consumed", ".cancelled", ".expired", ".invalidated"].map(suffix => `${paths.intentFile}${suffix}`),
		// One relay attempt per generation: pending or confirmed records are permanent history.
		paths.relayPendingFile,
		paths.relayFile,
	];
	for (const file of files) {
		try {
			fsSync.lstatSync(file);
		} catch (error) {
			if (isCode(error, "ENOENT")) continue;
			throw error;
		}
		throw new Error("owner_intent_replay");
	}
}

/**
 * Exclusive, owner-only creation inside the verified private lifecycle root. A
 * failure, including an existing record, publishes nothing new.
 */
function createOwnerOnlyRecordSync(root: string, file: string, value: unknown): boolean {
	if (!verifyOwnerOnlyPathSecurity(root, "directory").ok) return false;
	const { O_CREAT, O_EXCL, O_NOFOLLOW, O_WRONLY } = fsSync.constants;
	let descriptor: number;
	try {
		descriptor = fsSync.openSync(file, O_CREAT | O_EXCL | O_NOFOLLOW | O_WRONLY, 0o600);
	} catch {
		return false;
	}
	try {
		fsSync.writeSync(descriptor, `${JSON.stringify(value)}\n`);
		fsSync.fsyncSync(descriptor);
	} catch {
		// A partial record never validates, so readers fail closed on it.
		return false;
	} finally {
		fsSync.closeSync(descriptor);
	}
	try {
		const directory = fsSync.openSync(root, "r");
		try {
			fsSync.fsyncSync(directory);
		} finally {
			fsSync.closeSync(directory);
		}
	} catch {}
	return true;
}

/**
 * Darwin, in an admitted managed child, before the CLI starts: record the first
 * termination cause this process handles, and accept the supervisor's cooperative
 * signal only as that first cause. The cooperative signal then starts the ordinary
 * SIGTERM shutdown. Signals carry no sender identity, so this ordering, not a
 * timestamp, is what lets a verdict attribute the shutdown to the relay: a SIGTERM,
 * SIGHUP or SIGINT handled first wins the exclusive record, and the relay is ignored.
 * The readiness record is published only after the handlers are installed; without
 * it the supervisor never relays. Returns whether readiness was published.
 */
export function installManagedOwnerCooperativeShutdown(input: {
	stateDir: string;
	sessionId: string;
	generation: string;
	childToken: string;
	/**
	 * Whether this process already began shutting down. A termination signal handled
	 * before the recorders existed left no cause record, so such a child never
	 * announces readiness and is never relayed to.
	 */
	shutdownStarted(): boolean;
}): boolean {
	if (process.platform !== "darwin" || input.shutdownStarted()) return false;
	const paths = lifecyclePaths(input.stateDir, input.sessionId, input.generation);
	const identity = {
		schema_version: 1 as const,
		generation: input.generation,
		session_id: input.sessionId,
		child_token: input.childToken,
		child_pid: process.pid,
	};
	const recordCause = (cause: ManagedOwnerShutdownCause["cause"], signal: string): boolean =>
		createOwnerOnlyRecordSync(paths.root, paths.shutdownCauseFile, {
			...identity,
			cause,
			signal,
			recorded_at: new Date().toISOString(),
		} satisfies ManagedOwnerShutdownCause);
	process.on(MANAGED_OWNER_COOPERATIVE_SIGNAL, () => {
		if (recordCause("cooperative", MANAGED_OWNER_COOPERATIVE_SIGNAL)) process.kill(process.pid, "SIGTERM");
	});
	for (const signal of ["SIGTERM", "SIGHUP", "SIGINT"] as const)
		process.on(signal, () => {
			recordCause("signal", signal);
		});
	return createOwnerOnlyRecordSync(paths.root, paths.cooperativeReadyFile, {
		...identity,
		signal: MANAGED_OWNER_COOPERATIVE_SIGNAL,
	} satisfies ManagedOwnerCooperativeReady);
}

/** Darwin: whether this exact child published readiness for the cooperative signal. */
export function managedOwnerCooperativeReady(
	paths: LifecyclePaths,
	binding: Pick<ManagedOwnerBinding, "session_id" | "generation" | "child_token">,
	childPid: number,
): boolean {
	try {
		const ready = readSecureOwnerJson(paths.cooperativeReadyFile);
		return (
			isManagedOwnerCooperativeReady(ready) &&
			ready.session_id === binding.session_id &&
			ready.generation === binding.generation &&
			ready.child_token === binding.child_token &&
			ready.child_pid === childPid
		);
	} catch {
		return false;
	}
}

/** Darwin: the generation's exact child recorded the cooperative signal as its first cause. */
export function managedOwnerCooperativeCause(
	paths: LifecyclePaths,
	binding: Pick<ManagedOwnerBinding, "session_id" | "generation" | "child_token">,
	childPid?: number,
): boolean {
	try {
		const cause = readSecureOwnerJson(paths.shutdownCauseFile);
		return (
			isManagedOwnerShutdownCause(cause) &&
			cause.cause === "cooperative" &&
			cause.session_id === binding.session_id &&
			cause.generation === binding.generation &&
			cause.child_token === binding.child_token &&
			(childPid === undefined || cause.child_pid === childPid)
		);
	} catch {
		return false;
	}
}

/** Darwin: the generation's one supervisor index, or null when it is unusable. */
function readSupervisorIndex(paths: LifecyclePaths, intent: OwnerIntent) {
	try {
		const index = readSecureOwnerJson(paths.supervisorIndexFile);
		return isManagedOwnerSupervisorIndex(index) &&
			index.generation === intent.generation &&
			index.session_id === intent.session_id
			? index
			: null;
	} catch {
		return null;
	}
}

/**
 * Darwin: the supervisor's reconciliation of the relayed child's exit, recorded
 * after its own terminal observation. Written exclusively; an unexplained exit also
 * publishes the generation's owner-loss incident, because an expected verdict the
 * child published before it died stays history and never makes the close successful.
 */
export async function recordManagedOwnerChildExit(stateDir: string, record: ManagedOwnerChildExit): Promise<void> {
	if (!isManagedOwnerChildExit(record)) throw new Error("managed_owner_child_exit_invalid");
	const paths = lifecyclePaths(stateDir, record.session_id, record.generation);
	// The incident below is written by pathname, so the root is verified first.
	if (!verifyOwnerOnlyPathSecurity(paths.root, "directory").ok) throw new Error("managed_owner_child_exit_unrecorded");
	if (!record.explained) {
		// The incident is durable before the record that ends reconciliation, so a
		// supervisor killed in between never leaves an unexplained exit without it.
		// It reuses the existing verdict's key and time: an unexpected verdict already
		// published this exact incident, an expected one did not. Without a valid
		// verdict nothing is reconciled, and no exit record is written.
		const verdict = await readJson<OwnerVerdict>(paths.verdictFile);
		if (
			!isValidOwnerVerdict(verdict) ||
			verdict.generation !== record.generation ||
			verdict.session_id !== record.session_id
		)
			throw new Error("managed_owner_child_exit_unreconciled");
		await publishImmutableIncident(paths.incidentFile, {
			schema_version: 1,
			generation: record.generation,
			session_id: record.session_id,
			dedupe_key: verdict.dedupe_key,
			created_at: verdict.observed_at,
			classification: "unexpected_owner_loss",
		});
	}
	if (!createOwnerOnlyRecordSync(paths.root, paths.childExitFile, record))
		throw new Error("managed_owner_child_exit_unrecorded");
}

/** Darwin: only an explained child exit for this exact intent completes a cooperative close. */
function managedOwnerChildExitExplained(paths: LifecyclePaths, intent: OwnerIntent): boolean {
	const index = readSupervisorIndex(paths, intent);
	if (!index) return false;
	try {
		const exit = readSecureOwnerJson(paths.childExitFile);
		return (
			isManagedOwnerChildExit(exit) &&
			exit.explained &&
			exit.intent_id === intent.intent_id &&
			exit.dispatch_id === intent.dispatch_id &&
			exit.generation === intent.generation &&
			exit.session_id === intent.session_id &&
			exit.child_token === index.child_token
		);
	} catch {
		return false;
	}
}

/**
 * Darwin relay evidence for exactly this intent, or null when none exists.
 * An unreadable or mismatched record is never treated as absent.
 */
export function readCooperativeRelayRecord(paths: LifecyclePaths, intent: OwnerIntent): ManagedOwnerRelayRecord | null {
	try {
		fsSync.lstatSync(paths.relayFile);
	} catch (error) {
		if (isCode(error, "ENOENT")) return null;
		throw error;
	}
	const record = readSecureOwnerJson(paths.relayFile);
	if (
		!isManagedOwnerRelayRecord(record) ||
		record.intent_id !== intent.intent_id ||
		record.dispatch_id !== intent.dispatch_id ||
		record.generation !== intent.generation ||
		record.session_id !== intent.session_id ||
		record.server_key !== intent.server_key
	)
		throw new Error("owner_relay_evidence_mismatch");
	return record;
}

/**
 * Darwin: retire this generation's canonical intent when it is provably undelivered,
 * so a later close can rearm. Runs under the generation lock that the supervisor also
 * takes for its expiry check and relay-record publication. An intent that is expired,
 * has no relay record and no verdict can therefore never be relayed: the supervisor
 * refuses expired intents under the same lock, and the retired name is not the
 * canonical intent it reads. Anything else stays as uncertain evidence.
 */
function retireUndeliveredCooperativeIntent(
	paths: LifecyclePaths,
	sessionId: string,
	serverKey: string,
	closerGaveUp = false,
): void {
	try {
		fsSync.lstatSync(paths.intentFile);
	} catch (error) {
		if (isCode(error, "ENOENT")) return;
		throw error;
	}
	const intent = readSecureOwnerJson(paths.intentFile);
	if (
		!isValidOwnerIntent(intent) ||
		!isCanonicalUtcTimestamp(intent.expires_at) ||
		intent.generation !== paths.generation ||
		intent.session_id !== sessionId ||
		intent.server_key !== serverKey ||
		(!closerGaveUp && Date.now() < Date.parse(intent.expires_at))
	)
		return;
	if (readCooperativeRelayRecord(paths, intent)) return;
	// A pending record without confirmation means delivery is uncertain (for example a
	// supervisor crash between publication and signal): keep the intent.
	for (const file of [paths.relayPendingFile, paths.verdictFile])
		try {
			fsSync.lstatSync(file);
			return;
		} catch (error) {
			if (!isCode(error, "ENOENT")) throw error;
		}
	// The intent id is unique, so the retired name never collides.
	fsSync.renameSync(
		paths.intentFile,
		path.join(paths.root, `intent-${paths.generation}.${intent.intent_id}.undelivered`),
	);
}

/**
 * Darwin: a closer that gave up retires its own intent at once when it is provably
 * undelivered (no pending or confirmed relay, no verdict), under the generation lock
 * the supervisor takes before relaying. Expiry then no longer depends on the wall
 * clock: a stalled supervisor resumed after a clock rollback finds no canonical
 * intent to relay. Contention or uncertain delivery leaves the intent in place.
 */
function retireAbandonedCooperativeIntent(
	paths: LifecyclePaths,
	sessionId: string,
	serverKey: string,
	intent: OwnerIntent,
): void {
	const db = acquireSqliteLockSync(paths, 250, true);
	if (!db) return;
	try {
		if (JSON.stringify(readSecureOwnerJson(paths.intentFile)) !== JSON.stringify(intent)) return;
		retireUndeliveredCooperativeIntent(paths, sessionId, serverKey, true);
	} catch {
		// Unavailable evidence keeps the intent as uncertain history.
	} finally {
		try {
			db.exec("COMMIT");
		} catch {
		} finally {
			db.close();
		}
	}
}

function assertNoConflictingOwnerTerminal(paths: LifecyclePaths, sessionId: string): void {
	try {
		fsSync.lstatSync(paths.verdictFile);
		throw new Error("owner_terminal_conflict");
	} catch (error) {
		if (!isCode(error, "ENOENT")) throw error;
	}
	try {
		fsSync.lstatSync(paths.verdictAliasFile);
	} catch (error) {
		if (isCode(error, "ENOENT")) return;
		throw error;
	}
	const alias = readSecureOwnerJson(paths.verdictAliasFile);
	if (!isRecord(alias)) throw new Error("owner_terminal_conflict");
	const { owner_generation: aliasGeneration, ...verdict } = alias;
	if (
		!isValidOwnerVerdict(verdict) ||
		aliasGeneration !== verdict.generation ||
		verdict.session_id !== sessionId ||
		verdict.generation === paths.generation
	)
		throw new Error("owner_terminal_conflict");
	// A different generation alone is not predecessor proof: require its exact
	// immutable publication marker and evidence predating the current generation.
	const prior = readSecureOwnerJson(
		path.join(paths.root, `generation-${encodeURIComponent(verdict.generation)}.published.json`),
	);
	const current = readSecureOwnerJson(paths.generationFile);
	if (
		!isRecord(prior) ||
		Object.keys(prior).length !== 4 ||
		prior.schema_version !== 1 ||
		prior.session_id !== sessionId ||
		prior.generation !== verdict.generation ||
		!isCanonicalUtcTimestamp(prior.published_at) ||
		!isRecord(current) ||
		!isCanonicalUtcTimestamp(current.published_at) ||
		Date.parse(prior.published_at) > Date.parse(current.published_at) ||
		Date.parse(verdict.observed_at) > Date.parse(current.published_at)
	)
		throw new Error("owner_terminal_conflict");
}

/** One short critical section on the existing generation lock, including relay. */
export function consumeCooperativeOwnerIntent(input: {
	stateDir: string;
	binding: ManagedOwnerBinding;
	serverKey: string;
	/** The supervisor's direct child; it must have published cooperative readiness. */
	childPid: number;
	/** Whether the exact child can still receive a relay right now. */
	canRelay(): boolean;
	/** Delivers the cooperative signal; returns true only when it was actually sent. */
	relay(intent: OwnerIntent, observedAt: string): boolean;
	/**
	 * Durable no-replace publication inside the private lifecycle root. Injected by
	 * the supervisor so managed session storage stays out of this module's graph
	 * (it is reachable from the MCP machine entrypoint).
	 */
	publishNoReplace(file: string, bytes: Uint8Array): void;
}): void {
	if (process.platform !== "darwin") return;
	const binding = input.binding;
	const paths = lifecyclePaths(input.stateDir, binding.session_id, binding.generation);
	const db = acquireSqliteLockSync(paths, 1, true);
	if (!db) return;
	try {
		assertSecureGeneration(paths, binding.session_id);
		const persisted = readSecureOwnerJson(path.join(paths.root, `child-${binding.child_token}.binding.json`));
		if (!isManagedOwnerBinding(persisted) || JSON.stringify(persisted) !== JSON.stringify(binding)) return;
		assertNoIntentHistory(paths, false);
		assertNoConflictingOwnerTerminal(paths, binding.session_id);
		const intent = readSecureOwnerJson(paths.intentFile);
		const now = new Date().toISOString();
		if (
			!isValidOwnerIntent(intent) ||
			!isCanonicalUtcTimestamp(intent.created_at) ||
			!isCanonicalUtcTimestamp(intent.expires_at) ||
			intent.session_id !== binding.session_id ||
			intent.generation !== binding.generation ||
			intent.server_key !== input.serverKey ||
			Date.parse(intent.created_at) > Date.parse(now) ||
			Date.now() >= Date.parse(intent.expires_at)
		)
			return;
		// An intent whose closer stopped waiting (gave up, exited or crashed) is never
		// relayed, whatever the wall clock says.
		if (!input.canRelay() || !closerWaiting(paths)) return;
		// A child that never installed its cooperative handler would die from the
		// signal's default action, which no verdict could attribute.
		if (!managedOwnerCooperativeReady(paths, binding, input.childPid)) return;
		const relayRecord: ManagedOwnerRelayRecord = {
			schema_version: 1,
			intent_id: intent.intent_id,
			dispatch_id: intent.dispatch_id,
			generation: binding.generation,
			session_id: binding.session_id,
			server_key: input.serverKey,
			child_token: binding.child_token,
			supervisor_pid: binding.supervisor_pid,
			supervisor_start_time: binding.supervisor_start_time,
			relayed_at: now,
		};
		// Two phases under the generation lock, which observers also take before
		// classifying. The pending record is durable before delivery so a crash
		// leaves uncertain evidence (no retirement, no rearm); only a confirmed
		// delivery publishes the record an operator-shutdown verdict requires.
		const bytes = Buffer.from(`${JSON.stringify(relayRecord)}\n`);
		input.publishNoReplace(paths.relayPendingFile, bytes);
		const recorded = readOwnerOnlyFileSettled(paths.relayPendingFile, 65536);
		// The confirmed `relayed_at` is sampled after the pending record is durable and
		// immediately before delivery, so an observation earlier than it cannot be this
		// relay's. Expiry is checked on that same instant: a supervisor that stalled
		// during publication must not deliver after the closer has given up.
		const signaledAt = new Date();
		const delivered =
			recorded.ok &&
			!!recorded.data &&
			bytes.equals(Buffer.from(recorded.data)) &&
			signaledAt.getTime() < Date.parse(intent.expires_at) &&
			closerWaiting(paths) &&
			input.relay(intent, signaledAt.toISOString());
		if (delivered) {
			input.publishNoReplace(
				paths.relayFile,
				Buffer.from(`${JSON.stringify({ ...relayRecord, relayed_at: signaledAt.toISOString() })}\n`),
			);
			fsSync.unlinkSync(paths.relayPendingFile);
		} else fsSync.renameSync(paths.relayPendingFile, `${paths.relayPendingFile}.${intent.intent_id}.unsent`);
		const directory = fsSync.openSync(paths.root, "r");
		try {
			fsSync.fsyncSync(directory);
		} finally {
			fsSync.closeSync(directory);
		}
	} catch {
		// Unavailable evidence and lock contention never authorize delivery.
	} finally {
		try {
			db.exec("COMMIT");
		} catch {
		} finally {
			db.close();
		}
	}
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
	const intentInput = () => ({
		generation: request.generation,
		session_id: request.sessionId,
		server_key: request.serverKey,
		expected_terminal: { signal: "SIGTERM" as const, result: "owner_term_then_session_cleanup" as const },
		dispatch_id: request.dispatchId,
		created_at: request.createdAt,
		expires_at: request.expiresAt,
	});
	if (deps.shutdown.kind === "cooperative_intent") {
		if (process.platform !== "darwin") throw new Error("cooperative_owner_platform_unsupported");
		const db = acquireSqliteLockSync(paths, 250, true);
		if (!db) throw new Error("generation_lock_contended");
		// Held before the intent is visible; a concurrent closer of this generation
		// cannot take it.
		const closer = holdCloserLock(paths);
		if (!closer) {
			try {
				db.exec("COMMIT");
			} finally {
				db.close();
			}
			throw new Error("generation_lock_contended");
		}
		const intent = ownerIntentRecord(intentInput());
		const shutdown = deps.shutdown;
		const assertOwned = () => {
			if (
				!isValidOwnerIntent(intent) ||
				!isCanonicalUtcTimestamp(intent.created_at) ||
				!isCanonicalUtcTimestamp(intent.expires_at) ||
				Date.parse(intent.created_at) > Date.now() ||
				Date.parse(intent.expires_at) <= Date.now()
			)
				throw new Error("owner_term_verdict_timeout");
			assertNoIntentHistory(paths, true);
			assertSecureGeneration(paths, request.sessionId);
			assertNoConflictingOwnerTerminal(paths, request.sessionId);
			shutdown.assertCooperativeOwner();
			assertSecureGeneration(paths, request.sessionId);
			if (Date.now() >= Date.parse(intent.expires_at)) throw new Error("owner_term_verdict_timeout");
		};
		try {
			try {
				assertSecureGeneration(paths, request.sessionId);
				retireUndeliveredCooperativeIntent(paths, request.sessionId, request.serverKey);
				assertOwned();
				await shutdown.publishNoReplace(
					paths.root,
					paths.intentFile,
					Buffer.from(`${JSON.stringify(intent)}\n`),
					assertOwned,
				);
				if (JSON.stringify(readSecureOwnerJson(paths.intentFile)) !== JSON.stringify(intent))
					throw new Error("owner_intent_publication_uncertain");
			} finally {
				// Namespace publication cannot be undone by a SQLite rollback or error.
				try {
					db.exec("COMMIT");
				} finally {
					db.close();
				}
			}
			const giveUp = (code = "owner_term_verdict_timeout"): never => {
				retireAbandonedCooperativeIntent(paths, request.sessionId, request.serverKey, intent);
				throw new Error(code);
			};
			let verdict: OwnerVerdict | null;
			try {
				verdict = await deps.waitForVerdict(intent);
			} catch {
				return giveUp();
			}
			// The caller's verdict wait owns the deadline on its monotonic clock, and the
			// relay was authorized inside the intent window; a wall-clock step during the
			// child's cleanup must not reject a timely verdict.
			if (
				!isValidOwnerVerdict(verdict) ||
				verdict.intent_id !== intent.intent_id ||
				verdict.generation !== request.generation ||
				verdict.session_id !== request.sessionId ||
				verdict.server_key !== request.serverKey ||
				verdict.classification !== "expected_operator_shutdown"
			)
				return giveUp();
			// Only the exact supervisor's relay of this intent makes the shutdown expected,
			// and only an explained child exit makes it a successful close.
			if (!readCooperativeRelayRecord(paths, intent)) return giveUp();
			if (!managedOwnerChildExitExplained(paths, intent)) return giveUp("owner_term_child_exit_unexplained");
			await deps.cleanupSession();
			return verdict;
		} finally {
			// The supervisor relays only while this lock is held: once the closer stops
			// waiting, even an intent it could not retire is never delivered.
			releaseCloserLock(closer);
		}
	}
	const generationLockToken = await acquireOwnerGenerationLock(paths, request.sessionId);
	if (!generationLockToken) throw new Error("generation_lock_contended");
	let intent: OwnerIntent;
	try {
		if ((await deps.readStartTime(request.pid)) !== request.startTime) throw new Error("owner_pid_identity_mismatch");
		if (!(await isCurrentOwnerGeneration(request.stateDir, request.sessionId, request.generation)))
			throw new Error("owner_generation_mismatch");
		intent = await createOwnerIntent(request.stateDir, intentInput());
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
			await deps.shutdown.sendSigterm(request.pid);
		} catch (error: unknown) {
			await fs.rename(paths.intentFile, `${paths.intentFile}.cancelled`).catch(() => undefined);
			throw error;
		}
	} finally {
		await releaseVerdictLock(generationLockToken);
	}
	const verdict = await deps.waitForVerdict(intent);
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
	} catch (error) {
		if (process.platform !== "win32" || (error as NodeJS.ErrnoException).code !== "EPERM") throw error;
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
	if (!ensureOwnerLifecycleDirectorySync(root)) throw new Error("owner_lifecycle_root_unsafe");
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
