import { type ChildProcess, spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import * as fsSync from "node:fs";
import * as fs from "node:fs/promises";
import path from "node:path";
import type { NativeExactUnlinkResult } from "@gajae-code/natives";

let nativeLifecycleBindings: typeof import("@gajae-code/natives") | undefined;

function nativeLifecycle(): typeof import("@gajae-code/natives") {
	if (!nativeLifecycleBindings)
		nativeLifecycleBindings = require("@gajae-code/natives") as typeof import("@gajae-code/natives");
	return nativeLifecycleBindings;
}

import { $credentialEnv, logger, resolveEquivalentPath } from "@gajae-code/utils";
import {
	loadAcceptedModelPresetRegistry,
	loadAcceptedModelPresetRegistryAsync,
} from "../../config/model-preset-registry";
import {
	isModelProfileError,
	type ModelProfileErrorDetails,
	validateModelProfileName,
} from "../../config/model-profile-contract";
import { mergeModelProfiles } from "../../config/model-profiles";
import { ModelsConfigFile } from "../../config/model-registry";
import {
	DependencyPreparationTimeoutError,
	ensureLaunchWorktreeCancellable,
	ensureReusableNodeModulesCancellable,
	type GjcLaunchWorktreePlan,
	planLaunchWorktree,
	removeOwnedLaunchWorktree,
	WorktreePreparationTimeoutError,
} from "../../gjc-runtime/launch-worktree";
import { probeLinuxProcPidSync } from "../../gjc-runtime/linux-proc";
import {
	GJC_COORDINATOR_SESSION_BRANCH_ENV,
	GJC_COORDINATOR_SESSION_ID_ENV,
	GJC_COORDINATOR_SESSION_STATE_FILE_ENV,
	GJC_COORDINATOR_SIDECAR_KEY_ID_ENV,
	GJC_COORDINATOR_SIDECAR_SIGNATURE_REQUIRED_ENV,
	GJC_COORDINATOR_SIDECAR_SIGNING_KEY_ENV,
} from "../../gjc-runtime/session-state-sidecar";
import { validateManagedArtifactTree } from "../../session/internal/managed-session-storage";
import {
	FileSessionStorage,
	SessionDeleteVerificationError,
	type SessionStorageFileIdentity,
	type SessionStorageSnapshot,
	type VerifiedSessionDeleteResult,
	type VerifiedSessionDeleteTarget,
} from "../../session/session-storage";
import type { SessionLifecycleMcpServer } from "../acp/mcp";
import { SdkClient, SdkClientError } from "../client/client";
import { BROKER_RUNTIME_CLOSE_CAPABILITY_FIELD } from "../host/control/runtime-gate";
import { SESSION_PREPARED_EVENT } from "../host/host";
import {
	type LogicalSessionCandidate,
	listManagedSessionCandidates,
	type ManagedSessionScope,
	resolveManagedSessionScope,
} from "../session-directory";
import {
	normalizeSdkStartupFailure,
	type SdkStartupFailure,
	type SdkStartupRollbackResult,
	sanitizeSdkStartupMessage,
} from "../startup-capability";
import type { Broker, BrokerCleanupEvidence, BrokerCleanupIdentity, BrokerResponse } from "./broker";
import { matchesIndexedEndpointFile, readEndpointFile } from "./endpoint-authority";
import { decodeLifecycleUtf8, parseLifecycleJson } from "./lifecycle-codec";
import type {
	LifecycleCleanupProof,
	LifecycleDurableEffectsReceipt,
	LifecycleEffectIntent,
	LifecycleStartupFailureReceipt,
	LifecycleWorktreeIntent,
} from "./lifecycle-ledger";
import {
	type ProcessIncarnationCommandRunner,
	type ProcessIncarnationOptions,
	parseDarwinProcessIncarnation,
	processIncarnation,
} from "./process-incarnation";
import { resolveSdkInternalSpawnCommand, type SdkInternalSpawnCommand } from "./runtime";
import {
	type IndexedSession,
	isSessionAuthorityEligible,
	resolveSessionLocator,
	type SessionLocatorV2,
} from "./session-index";
import {
	cancellableSleep,
	DEFAULT_READINESS_TIMEOUT_MS,
	deriveLifecycleOuterDeadlines,
	isValidReadinessTimeoutMs,
	PREPARATION_TIMEOUT_INVALID_MESSAGE,
	READINESS_TIMEOUT_INVALID_MESSAGE,
	readPreparationTimeouts,
	startupQueueWaitMs,
} from "./startup-budget";
import { worktreeOccupant } from "./worktree-occupancy";

export {
	type ProcessIncarnationCommandRunner,
	type ProcessIncarnationOptions,
	parseDarwinProcessIncarnation,
	processIncarnation,
};

const POLL_MS = 50;
const CLOSE_TIMEOUT_MS = 2_000;
const MAX_RECEIVED_AT_SKEW_MS = 5_000;
const MAX_LIFECYCLE_METADATA_BYTES = 4096;
const MAX_EFFECT_MARKER_LENGTH = 128;
const MAX_PROCESS_INCARNATION_LENGTH = 256;
const DEAD_LIFECYCLE_MARKER_EXPIRY_MS = 60 * 60 * 1000;
const READY_THEN_EXIT_MESSAGE = "became ready then exited before live admission";

function readyThenExitedResponse(id: string, child?: ChildProcess): BrokerResponse {
	const parts = [`Session ${id} ${READY_THEN_EXIT_MESSAGE}.`];
	if (child && child.exitCode !== null) parts.push(`exit=${child.exitCode}`);
	if (child?.signalCode) parts.push(`signal=${child.signalCode}`);
	// Host stderr is deliberately excluded: the detached host receives launch
	// configuration and inherited credentials, and no pattern-based redaction can
	// prove arbitrary child output free of that material; its stderr is discarded
	// by the OS and never captured (#4712 review).
	return fail("ready_then_exited", parts.join(" "));
}

const STARTUP_CLEANUP_UNCERTAIN_MESSAGE =
	"Lifecycle startup cleanup could not be proven; retained artifacts require reconciliation.";

export function terminalUncertainStartupMessage(response: BrokerResponse): string {
	if (response.ok || response.error.code !== "spawn_failed") return STARTUP_CLEANUP_UNCERTAIN_MESSAGE;
	logger.warn("sdk broker retained a sanitized launch failure after uncertain startup cleanup", {
		message: sanitizeSdkStartupMessage(response.error.message),
	});
	return `${STARTUP_CLEANUP_UNCERTAIN_MESSAGE} Original launch failure: SDK internal process could not be started.`;
}

export async function waitForChildSpawn(
	spawned: Pick<ChildProcess, "off" | "on" | "once">,
	onPostSpawnError: (error: Error) => void = error =>
		logger.warn("sdk session child emitted an error after successful spawn", {
			message: sanitizeSdkStartupMessage(error),
		}),
): Promise<void> {
	const spawnOutcome = Promise.withResolvers<void>();
	const onSpawn = () => {
		spawned.off("error", onError);
		spawned.on("error", onPostSpawnError);
		spawnOutcome.resolve();
	};
	const onError = (error: Error) => {
		spawned.off("spawn", onSpawn);
		spawnOutcome.reject(error);
	};
	spawned.once("spawn", onSpawn);
	spawned.once("error", onError);
	await spawnOutcome.promise;
}

export interface LifecycleDeadlines {
	receivedAt: number;
	requestedReadinessTimeoutMs: number;
	semanticReadyDeadlineAt: number;
	terminationStartDeadlineAt: number;
	lifecycleCleanupDeadlineAt: number;
}

export function deriveLifecycleDeadlines(receivedAt: number, requestedReadinessTimeoutMs: number): LifecycleDeadlines {
	if (!Number.isSafeInteger(receivedAt) || !isValidReadinessTimeoutMs(requestedReadinessTimeoutMs))
		throw new Error("Lifecycle timing values must be safe integers in the approved readiness range.");
	const phaseWindowMs = Math.min(1_000, Math.max(500, Math.floor(requestedReadinessTimeoutMs / 4)));
	const lifecycleCleanupDeadlineAt = receivedAt + requestedReadinessTimeoutMs;
	const semanticReadyDeadlineAt = lifecycleCleanupDeadlineAt - phaseWindowMs * 2;
	const terminationStartDeadlineAt = lifecycleCleanupDeadlineAt - phaseWindowMs;
	if (
		!Number.isSafeInteger(phaseWindowMs) ||
		!Number.isSafeInteger(lifecycleCleanupDeadlineAt) ||
		!Number.isSafeInteger(semanticReadyDeadlineAt) ||
		!Number.isSafeInteger(terminationStartDeadlineAt)
	)
		throw new Error("Lifecycle timing values overflow the safe integer range.");
	return {
		receivedAt,
		requestedReadinessTimeoutMs,
		semanticReadyDeadlineAt,
		terminationStartDeadlineAt,
		lifecycleCleanupDeadlineAt,
	};
}

export interface LifecycleTiming {
	now(): number;
	sleep(ms: number, signal?: AbortSignal): Promise<void>;
}

const defaultLifecycleTiming: LifecycleTiming = { now: Date.now, sleep: cancellableSleep };
const lifecycleTimingsForTest = new WeakMap<Broker, LifecycleTiming>();
type LifecycleCommand = SdkInternalSpawnCommand | { file: string; args: string[] };
type LifecycleCommandResolver = () => LifecycleCommand;
const lifecycleCommandResolversForTest = new WeakMap<Broker, LifecycleCommandResolver>();
const lifecycleCleanupHooksForTest = new WeakMap<Broker, () => void>();
const startupAdmittedInputs = new WeakSet<Input>();
const startupLaunchInputs = new WeakMap<Input, SessionLaunch>();
type EnsureLaunchWorktreeForTest = (
	plan: GjcLaunchWorktreePlan,
	opts: { signal: AbortSignal; deadlineAt: number },
) => Promise<SessionLifecycleWorktreeReceipt & { createdBranch: boolean }>;
type EnsureReusableNodeModulesForTest = (
	sourceRoot: string,
	worktreePath: string,
	opts: { signal: AbortSignal; deadlineAt: number },
) => Promise<"symlink" | "present" | "missing">;
let ensureLaunchWorktreeForTest: EnsureLaunchWorktreeForTest | undefined;
let ensureReusableNodeModulesForTest: EnsureReusableNodeModulesForTest | undefined;

/** Test-only hook for simulating a crash immediately after one exact lifecycle detach. */
export function setLifecycleCleanupHookForTest(broker: Broker, hook: (() => void) | undefined): void {
	if (hook) lifecycleCleanupHooksForTest.set(broker, hook);
	else lifecycleCleanupHooksForTest.delete(broker);
}

export function setLifecycleCommandResolverForTest(
	broker: Broker,
	resolver: LifecycleCommandResolver | undefined,
): void {
	if (resolver) lifecycleCommandResolversForTest.set(broker, resolver);
	else lifecycleCommandResolversForTest.delete(broker);
}

export function setLifecycleTimingForTest(broker: Broker, timing: LifecycleTiming | undefined): void {
	if (timing) lifecycleTimingsForTest.set(broker, timing);
	else lifecycleTimingsForTest.delete(broker);
}
export function setEnsureLaunchWorktreeForTest(
	_broker: Broker | undefined,
	fn?: EnsureLaunchWorktreeForTest | undefined,
): void {
	ensureLaunchWorktreeForTest = typeof _broker === "function" ? (_broker as EnsureLaunchWorktreeForTest) : fn;
}

export function setEnsureReusableNodeModulesForTest(
	_broker: Broker | undefined,
	fn?: EnsureReusableNodeModulesForTest | undefined,
): void {
	ensureReusableNodeModulesForTest =
		typeof _broker === "function" ? (_broker as EnsureReusableNodeModulesForTest) : fn;
}

let lifecycleHostPlatformForTest: NodeJS.Platform | undefined;

/** Deterministic platform seam for Windows-only ready-then-exit tolerance. */
export function setLifecycleHostPlatformForTest(platform: NodeJS.Platform | undefined): void {
	lifecycleHostPlatformForTest = platform;
}

function lifecycleHostPlatform(): NodeJS.Platform {
	return lifecycleHostPlatformForTest ?? process.platform;
}

function readyThenExitToleranceEnabled(): boolean {
	return lifecycleHostPlatform() === "win32";
}

export function readyThenExitToleranceEnabledForTest(): boolean {
	return readyThenExitToleranceEnabled();
}

function lifecycleTiming(broker: Broker): LifecycleTiming {
	return lifecycleTimingsForTest.get(broker) ?? defaultLifecycleTiming;
}

type LifecycleProofBudget = {
	timing: LifecycleTiming;
	deadlineAt: number;
};

function lifecycleProofWithinDeadline(budget: LifecycleProofBudget | undefined): boolean {
	return budget === undefined || budget.timing.now() < budget.deadlineAt;
}

export function hasValidLifecycleDeadlines(value: LifecycleDeadlines, now = Date.now()): boolean {
	const {
		receivedAt,
		requestedReadinessTimeoutMs,
		semanticReadyDeadlineAt,
		terminationStartDeadlineAt,
		lifecycleCleanupDeadlineAt,
	} = value;
	if (
		!Number.isSafeInteger(receivedAt) ||
		!Number.isSafeInteger(requestedReadinessTimeoutMs) ||
		!Number.isSafeInteger(semanticReadyDeadlineAt) ||
		!Number.isSafeInteger(terminationStartDeadlineAt) ||
		!Number.isSafeInteger(lifecycleCleanupDeadlineAt) ||
		!Number.isSafeInteger(now) ||
		(receivedAt > now && receivedAt - now > MAX_RECEIVED_AT_SKEW_MS)
	)
		return false;
	try {
		const expected = deriveLifecycleDeadlines(receivedAt, requestedReadinessTimeoutMs);
		return (
			semanticReadyDeadlineAt === expected.semanticReadyDeadlineAt &&
			terminationStartDeadlineAt === expected.terminationStartDeadlineAt &&
			lifecycleCleanupDeadlineAt === expected.lifecycleCleanupDeadlineAt
		);
	} catch {
		return false;
	}
}
type Input = Record<string, unknown>;
// The admitted launch deadline must survive the response phase: executeLifecycle
// receives the caller's original input after startup admission has expanded it.
type LifecycleEffectIntentWithDeadline = LifecycleEffectIntent & { lifecycleCleanupDeadlineAt?: number };
export const isCanonicalSessionId = (value: string): boolean => /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value);
const defaultStateRoot = (cwd: string) => path.join(path.resolve(cwd), ".gjc", "state");
const hasDefaultStateRoot = (cwd: string, root: string) => path.resolve(root) === defaultStateRoot(cwd);

export interface SessionLifecycleWorktreeTarget {
	enabled: true;
	name?: string;
}

export interface SessionLifecycleWorktreeReceipt {
	enabled: true;
	cwd: string;
	created: boolean;
	reused: boolean;
	createdBranch: boolean;
	branch?: string;
}

export interface SessionLifecycleTranscriptIdentity {
	dev: string;
	ino: string;
	size: number;
	mtimeMs: number;
	mtimeNs: string;
	sha256: string;
}

/**
 * When a lifecycle-managed session publishes its replayable readiness signal.
 *
 * `immediate` is the stock contract. `deferred` prepares the session instead:
 * the child publishes a distinct prepared signal, keeps `session_ready`
 * withheld, and stays unusable for input until it is explicitly activated. It
 * is broker-issued and session-scoped precisely so a prepared session can never
 * be produced by an inherited process-global flag.
 */
export type SessionLifecycleReadiness = "immediate" | "deferred";
export interface SessionLifecycleLaunchRequestBase {
	operation: "session.create" | "session.fork" | "session.resume";
	sessionId: string;
	cwd: string;
	stateRoot: string;
	sourceSessionId?: string;
	sourceSessionPath?: string;
	sourceSessionIdentity?: SessionLifecycleTranscriptIdentity;
	sourceCwd?: string;
	sessionPath?: string;
	sessionIdentity?: SessionLifecycleTranscriptIdentity;
	/** Broker-issued effect marker which the child echoes only after host readiness. */
	effectMarker?: string;
	/**
	 * Explicit `provider/model` pin with `gjc --model` grammar (#4707). The
	 * coordinator resolves it before the broker; the session host applies it
	 * exactly like a CLI `--model` selection, so it wins over `modelPreset`
	 * (mirroring CLI precedence where an explicit `--model` overrides
	 * activated profiles).
	 */
	modelId?: string;
	modelPreset?: string;
	mcpServers?: SessionLifecycleMcpServer[];
	worktree?: SessionLifecycleWorktreeTarget;
	/** Absent means the stock immediate contract; `deferred` prepares the session. */
	readiness?: SessionLifecycleReadiness;
	receivedAt: number;
	requestedReadinessTimeoutMs: number;
	semanticReadyDeadlineAt: number;
	terminationStartDeadlineAt: number;
	lifecycleCleanupDeadlineAt: number;
	coordinatorSessionId?: string;
	coordinatorSessionBranch?: string;
}

export type SessionLifecycleLaunchRequest = SessionLifecycleLaunchRequestBase &
	(
		| {
				coordinatorStateDir?: undefined;
				coordinatorSidecarSigningKey?: undefined;
				coordinatorSidecarKeyId?: undefined;
		  }
		| {
				/** Coordinator namespace dir; broker computes the state file path from launch.id. */
				coordinatorStateDir: string;
				/** Public Coordinator signing authority metadata. */
				coordinatorSidecarKeyId: string;
				coordinatorSidecarSigningKey?: undefined;
		  }
	);

function hasValidCoordinatorSidecarTarget(stateDir: unknown, keyId?: unknown): boolean {
	if (stateDir === undefined && keyId === undefined) return true;
	return (
		typeof stateDir === "string" &&
		stateDir.length > 0 &&
		typeof keyId === "string" &&
		/^[a-f0-9]{64}$/.test(keyId) &&
		stateDir.length <= 4096
	);
}

function hasValidCoordinatorSidecarLaunchTarget(stateDir: unknown, signingKey: unknown, keyId?: unknown): boolean {
	if (stateDir === undefined && signingKey === undefined && keyId === undefined) return true;
	return (
		typeof stateDir === "string" &&
		stateDir.length > 0 &&
		typeof signingKey === "string" &&
		signingKey.length > 0 &&
		typeof keyId === "string" &&
		/^[a-f0-9]{64}$/.test(keyId) &&
		stateDir.length <= 4096
	);
}

function isSessionLifecycleTranscriptIdentity(value: unknown): value is SessionLifecycleTranscriptIdentity {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
	const identity = value as Record<string, unknown>;
	return (
		typeof identity.dev === "string" &&
		/^\d+$/.test(identity.dev) &&
		typeof identity.ino === "string" &&
		/^\d+$/.test(identity.ino) &&
		typeof identity.size === "number" &&
		Number.isSafeInteger(identity.size) &&
		identity.size >= 0 &&
		typeof identity.mtimeMs === "number" &&
		Number.isFinite(identity.mtimeMs) &&
		identity.mtimeMs >= 0 &&
		typeof identity.mtimeNs === "string" &&
		/^\d+$/.test(identity.mtimeNs) &&
		typeof identity.sha256 === "string" &&
		/^[a-f0-9]{64}$/.test(identity.sha256)
	);
}

function hasValidTranscriptAuthority(path: unknown, identity: unknown): path is string {
	return typeof path === "string" && path.length > 0 && isSessionLifecycleTranscriptIdentity(identity);
}

function isSessionLifecycleMcpServer(value: unknown): value is SessionLifecycleMcpServer {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
	const server = value as Record<string, unknown>;
	if (server.type === "http" || server.type === "sse") {
		if (
			!Object.keys(server).every(key => key === "type" || key === "name" || key === "url" || key === "headers") ||
			typeof server.name !== "string" ||
			!/^[A-Za-z0-9_.-]{1,100}$/.test(server.name) ||
			typeof server.url !== "string" ||
			server.url.length > 8_192
		)
			return false;
		try {
			const url = new URL(server.url);
			if (url.protocol !== "http:" && url.protocol !== "https:") return false;
		} catch {
			return false;
		}
		if (server.headers === undefined) return true;
		if (typeof server.headers !== "object" || server.headers === null || Array.isArray(server.headers)) return false;
		const headers = server.headers as Record<string, unknown>;
		return (
			Object.keys(headers).length <= 100 &&
			Object.entries(headers).every(
				([name, headerValue]) =>
					name.length > 0 &&
					name.length <= 256 &&
					!name.includes("\r") &&
					!name.includes("\n") &&
					typeof headerValue === "string" &&
					headerValue.length <= 8_192 &&
					!headerValue.includes("\r") &&
					!headerValue.includes("\n"),
			)
		);
	}
	const env = server.env;
	return (
		Object.keys(server).every(
			key => key === "type" || key === "name" || key === "command" || key === "args" || key === "env",
		) &&
		(server.type === undefined || server.type === "stdio") &&
		typeof server.name === "string" &&
		/^[A-Za-z0-9_.-]{1,100}$/.test(server.name) &&
		typeof server.command === "string" &&
		server.command.length <= 4_096 &&
		path.isAbsolute(server.command) &&
		Array.isArray(server.args) &&
		server.args.length <= 100 &&
		server.args.every(argument => typeof argument === "string" && argument.length <= 8_192) &&
		(env === undefined ||
			(typeof env === "object" &&
				env !== null &&
				!Array.isArray(env) &&
				Object.keys(env).length <= 100 &&
				Object.entries(env).every(
					([name, envValue]) =>
						/^[A-Za-z_][A-Za-z0-9_]*$/.test(name) && typeof envValue === "string" && envValue.length <= 32_768,
				)))
	);
}

function isSessionLifecycleMcpServers(value: unknown): value is SessionLifecycleMcpServer[] {
	return (
		Array.isArray(value) &&
		value.length <= 64 &&
		value.every(isSessionLifecycleMcpServer) &&
		new Set(value.map(server => server.name)).size === value.length
	);
}

export function readSessionLifecycleLaunchRequest(
	value: string | undefined,
	now = Date.now(),
): SessionLifecycleLaunchRequest {
	if (!value) throw new Error("GJC_SDK_LIFECYCLE_REQUEST is required.");
	const request = JSON.parse(value) as Partial<SessionLifecycleLaunchRequest>;
	if (
		(request.operation !== "session.create" &&
			request.operation !== "session.fork" &&
			request.operation !== "session.resume") ||
		typeof request.sessionId !== "string" ||
		!isCanonicalSessionId(request.sessionId) ||
		typeof request.cwd !== "string" ||
		!request.cwd ||
		typeof request.stateRoot !== "string" ||
		!request.stateRoot ||
		!hasDefaultStateRoot(request.cwd, request.stateRoot) ||
		(request.sourceSessionId !== undefined &&
			(typeof request.sourceSessionId !== "string" || !isCanonicalSessionId(request.sourceSessionId))) ||
		(request.sourceSessionPath !== undefined &&
			!hasValidTranscriptAuthority(request.sourceSessionPath, request.sourceSessionIdentity)) ||
		(request.sourceSessionIdentity !== undefined &&
			!isSessionLifecycleTranscriptIdentity(request.sourceSessionIdentity)) ||
		(request.sourceCwd !== undefined && (typeof request.sourceCwd !== "string" || !request.sourceCwd)) ||
		(request.sessionPath !== undefined &&
			!hasValidTranscriptAuthority(request.sessionPath, request.sessionIdentity)) ||
		(request.sessionIdentity !== undefined && !isSessionLifecycleTranscriptIdentity(request.sessionIdentity)) ||
		(request.effectMarker !== undefined &&
			(typeof request.effectMarker !== "string" || !/^[A-Za-z0-9._-]{1,128}$/.test(request.effectMarker))) ||
		(request.modelId !== undefined && (typeof request.modelId !== "string" || !request.modelId.trim())) ||
		(request.modelPreset !== undefined && (typeof request.modelPreset !== "string" || !request.modelPreset)) ||
		(request.mcpServers !== undefined && !isSessionLifecycleMcpServers(request.mcpServers)) ||
		!hasValidLifecycleDeadlines(
			{
				receivedAt: request.receivedAt as number,
				requestedReadinessTimeoutMs: request.requestedReadinessTimeoutMs as number,
				semanticReadyDeadlineAt: request.semanticReadyDeadlineAt as number,
				terminationStartDeadlineAt: request.terminationStartDeadlineAt as number,
				lifecycleCleanupDeadlineAt: request.lifecycleCleanupDeadlineAt as number,
			},
			now,
		) ||
		(request.worktree !== undefined && !isLifecycleWorktreeTarget(request.worktree)) ||
		(request.readiness !== undefined && request.readiness !== "immediate" && request.readiness !== "deferred") ||
		(request.readiness === "deferred" && request.operation !== "session.create") ||
		(request.operation === "session.resume" &&
			!hasValidTranscriptAuthority(request.sessionPath, request.sessionIdentity)) ||
		(request.operation === "session.fork" &&
			(!hasValidTranscriptAuthority(request.sourceSessionPath, request.sourceSessionIdentity) ||
				request.sourceSessionId === undefined)) ||
		request.coordinatorSidecarSigningKey !== undefined ||
		!hasValidCoordinatorSidecarTarget(request.coordinatorStateDir, request.coordinatorSidecarKeyId) ||
		(request.coordinatorSessionId !== undefined &&
			(typeof request.coordinatorSessionId !== "string" ||
				!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(request.coordinatorSessionId))) ||
		(request.coordinatorSessionBranch !== undefined &&
			(typeof request.coordinatorSessionBranch !== "string" || request.coordinatorSessionBranch.length > 512))
	)
		throw new Error("GJC_SDK_LIFECYCLE_REQUEST is invalid.");
	return request as SessionLifecycleLaunchRequest;
}

type SessionLaunch = {
	id: string;
	cwd: string;
	root: string;
	sourceSessionId?: string;
	sourceSessionPath?: string;
	sourceSessionIdentity?: SessionLifecycleTranscriptIdentity;
	sourceCwd?: string;
	sessionPath?: string;
	sessionIdentity?: SessionLifecycleTranscriptIdentity;
	/**
	 * Explicit `provider/model` pin with `gjc --model` grammar (#4707). Applied
	 * by the session host exactly like a CLI `--model` selection, so it wins
	 * over `modelPreset` (mirroring CLI precedence where an explicit `--model`
	 * overrides activated profiles).
	 */
	modelId?: string;
	modelPreset?: string;
	mcpServers?: SessionLifecycleMcpServer[];
	/** Coordinator namespace dir; broker computes the state file path from launch.id (#2549). */
	coordinatorStateDir?: string;
	coordinatorSessionId?: string;
	coordinatorSessionBranch?: string;
	coordinatorSidecarSigningKey?: string;
	coordinatorSidecarKeyId?: string;
	worktree?: SessionLifecycleWorktreeTarget;
	readiness?: SessionLifecycleReadiness;
	worktreePlan?: GjcLaunchWorktreePlan;
};

type CleanupEvidence = BrokerCleanupEvidence;
type CleanupIdentity = {
	dev: bigint;
	ino: bigint;
	nlink?: bigint;
	size: number;
	mtimeNs: bigint;
	sha256: string;
};

function serializeCleanupIdentity(identity: CleanupIdentity): BrokerCleanupIdentity {
	return {
		dev: identity.dev.toString(),
		ino: identity.ino.toString(),
		...(identity.nlink !== undefined ? { nlink: identity.nlink.toString() } : {}),
		size: identity.size,
		mtimeNs: identity.mtimeNs.toString(),
		sha256: identity.sha256,
	};
}

const fail = (
	code: string,
	message: string,
	cleanup?: CleanupEvidence,
	details?: ModelProfileErrorDetails,
): BrokerResponse => ({
	ok: false,
	error: { code: code as never, message, ...(details ? { details } : {}), ...(cleanup ? { cleanup } : {}) },
});
function text(value: unknown): string | undefined {
	return typeof value === "string" && value ? value : undefined;
}

export function validateBrokerModelPresetSync(agentDir: string, requestedProfile: string): string | BrokerResponse {
	const modelsConfigFile = ModelsConfigFile.relocate(path.join(agentDir, "models.yml"));
	modelsConfigFile.invalidate();
	const loaded = modelsConfigFile.tryLoad();
	const accepted = loadAcceptedModelPresetRegistry(agentDir);
	const profiles = mergeModelProfiles(loaded.status === "ok" ? loaded.value.profiles : undefined, accepted.profiles);
	try {
		return validateModelProfileName(
			requestedProfile,
			profiles,
			accepted.error ?? (loaded.status === "error" ? loaded.error : undefined),
		);
	} catch (error) {
		if (isModelProfileError(error)) return fail(error.code, error.message, undefined, error.details);
		throw error;
	}
}

async function validateBrokerModelPreset(agentDir: string, requestedProfile: string): Promise<string | BrokerResponse> {
	const modelsConfigFile = ModelsConfigFile.relocate(path.join(agentDir, "models.yml"));
	modelsConfigFile.invalidate();
	const loaded = modelsConfigFile.tryLoad();
	const accepted = await loadAcceptedModelPresetRegistryAsync(agentDir);
	const profiles = mergeModelProfiles(loaded.status === "ok" ? loaded.value.profiles : undefined, accepted.profiles);
	try {
		return validateModelProfileName(
			requestedProfile,
			profiles,
			accepted.error ?? (loaded.status === "error" ? loaded.error : undefined),
		);
	} catch (error) {
		if (isModelProfileError(error)) return fail(error.code, error.message, undefined, error.details);
		throw error;
	}
}

export function validateBrokerModelPresetForTest(agentDir: string, requestedProfile: string): string | BrokerResponse {
	return validateBrokerModelPresetSync(agentDir, requestedProfile);
}

function readinessTimeout(input: Input): number | BrokerResponse {
	const value = input.readinessTimeoutMs;
	if (value === undefined) return DEFAULT_READINESS_TIMEOUT_MS;
	if (!isValidReadinessTimeoutMs(value)) return fail("invalid_input", READINESS_TIMEOUT_INVALID_MESSAGE);
	return value;
}

function lifecycleDeadlines(input: Input, now: number): LifecycleDeadlines | BrokerResponse {
	const supplied = [
		input.receivedAt,
		input.requestedReadinessTimeoutMs,
		input.semanticReadyDeadlineAt,
		input.terminationStartDeadlineAt,
		input.lifecycleCleanupDeadlineAt,
	];
	if (supplied.some(value => value !== undefined)) {
		if (!supplied.every(value => typeof value === "number" && Number.isSafeInteger(value)))
			return fail("invalid_input", "Lifecycle deadline fields must be supplied together as safe integers.");
		const value: LifecycleDeadlines = {
			receivedAt: input.receivedAt as number,
			requestedReadinessTimeoutMs: input.requestedReadinessTimeoutMs as number,
			semanticReadyDeadlineAt: input.semanticReadyDeadlineAt as number,
			terminationStartDeadlineAt: input.terminationStartDeadlineAt as number,
			lifecycleCleanupDeadlineAt: input.lifecycleCleanupDeadlineAt as number,
		};
		return hasValidLifecycleDeadlines(value, now)
			? value
			: fail("invalid_input", "Lifecycle deadlines do not satisfy the exact approved timing contract.");
	}
	const timeout = readinessTimeout(input);
	return typeof timeout === "number" ? deriveLifecycleDeadlines(now, timeout) : timeout;
}

function lifecycleProofBudgetFromInput(broker: Broker, input: Input): LifecycleProofBudget | undefined {
	return typeof input.lifecycleCleanupDeadlineAt === "number" && Number.isSafeInteger(input.lifecycleCleanupDeadlineAt)
		? { timing: lifecycleTiming(broker), deadlineAt: input.lifecycleCleanupDeadlineAt }
		: undefined;
}

function lifecycleProofBudgetFromEffectIntent(
	broker: Broker,
	effectIntent: LifecycleEffectIntent | undefined,
): LifecycleProofBudget | undefined {
	const deadlineAt = (effectIntent as LifecycleEffectIntentWithDeadline | undefined)?.lifecycleCleanupDeadlineAt;
	return typeof deadlineAt === "number" && Number.isSafeInteger(deadlineAt)
		? { timing: lifecycleTiming(broker), deadlineAt }
		: undefined;
}

function sessionId(input: Input): string | undefined {
	return text(input.sessionId) ?? text(input.id);
}
function lifecycleCwd(input: Input): string | undefined {
	const target = input.target as Record<string, unknown> | undefined;
	const cwd = text(input.cwd) ?? text(input.path) ?? text(target?.path);
	return cwd ? path.resolve(cwd) : undefined;
}
function stateRoot(input: Input, cwd: string | undefined): string | undefined {
	const target = input.target as Record<string, unknown> | undefined;
	const root = text(input.stateRoot) ?? text(target?.stateRoot);
	if (root) return path.resolve(root);
	return cwd ? path.join(cwd, ".gjc", "state") : undefined;
}

function isLifecycleWorktreeTarget(value: unknown): value is SessionLifecycleWorktreeTarget {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
	const target = value as Record<string, unknown>;
	return (
		target.enabled === true &&
		(target.name === undefined || (typeof target.name === "string" && target.name.length > 0))
	);
}

function lifecycleWorktreeTarget(input: Input): SessionLifecycleWorktreeTarget | null | undefined {
	const target = input.target as Record<string, unknown> | undefined;
	const worktree = target?.worktree ?? input.worktree;
	if (worktree === undefined) return undefined;
	return isLifecycleWorktreeTarget(worktree) ? worktree : null;
}

type LiveResumeRecord = {
	sessionId: string;
	locator: SessionLocatorV2;
	endpointGeneration: number;
	pid: number;
	endpointMtimeMs?: number;
	endpointFileId?: string;
	processIncarnation?: string;
	hostIncarnation?: string;
	live: boolean;
	ambiguous: boolean;
};
type ResumeScope = {
	cwd: string;
	stateRoot: string;
	sessionPath: string;
	sessionIdentity: {
		dev: bigint;
		ino: bigint;
		size: number;
		mtimeMs: number;
		mtimeNs: bigint;
		sha256: string;
	};
};
function sameResumeLocator(record: LiveResumeRecord, cwd: string, root: string): boolean {
	return (
		resolveEquivalentPath(record.locator.cwd) === resolveEquivalentPath(cwd) &&
		resolveEquivalentPath(record.locator.stateRoot) === resolveEquivalentPath(root)
	);
}
function sameResumeSessionIdentity(left: ResumeScope, right: ResumeScope): boolean {
	return (
		left.sessionPath === right.sessionPath &&
		left.sessionIdentity.dev === right.sessionIdentity.dev &&
		left.sessionIdentity.ino === right.sessionIdentity.ino &&
		left.sessionIdentity.size === right.sessionIdentity.size &&
		left.sessionIdentity.mtimeMs === right.sessionIdentity.mtimeMs &&
		left.sessionIdentity.mtimeNs === right.sessionIdentity.mtimeNs &&
		left.sessionIdentity.sha256 === right.sessionIdentity.sha256
	);
}
function sameLiveResumeRecord(expected: LiveResumeRecord, current: LiveResumeRecord): boolean {
	return (
		current.live &&
		isSessionAuthorityEligible(current) &&
		current.endpointGeneration === expected.endpointGeneration &&
		current.pid === expected.pid &&
		current.endpointMtimeMs === expected.endpointMtimeMs &&
		current.endpointFileId === expected.endpointFileId &&
		(current.hostIncarnation ?? current.processIncarnation) ===
			(expected.hostIncarnation ?? expected.processIncarnation) &&
		sameResumeLocator(current, expected.locator.cwd, expected.locator.stateRoot)
	);
}

function liveResumeAuthority(
	sessions: readonly LiveResumeRecord[],
	sessionId: string,
): { kind: "none" } | { kind: "ambiguous" } | { kind: "live"; record: LiveResumeRecord } {
	const indexedCandidates = sessions.filter(session => session.sessionId === sessionId);
	if (indexedCandidates.some(session => !isSessionAuthorityEligible(session))) return { kind: "ambiguous" };
	const liveCandidates = indexedCandidates.filter(session => session.live);
	if (liveCandidates.length > 1) return { kind: "ambiguous" };
	const record = liveCandidates[0];
	return record ? { kind: "live", record } : { kind: "none" };
}

type ValidatedTranscript = {
	path: string;
	id: string;
	identity: SessionLifecycleTranscriptIdentity;
};

function serializeTranscriptIdentity(identity: {
	dev: bigint;
	ino: bigint;
	size: number;
	mtimeMs: number;
	mtimeNs: bigint;
	sha256: string;
}): SessionLifecycleTranscriptIdentity {
	return {
		dev: identity.dev.toString(),
		ino: identity.ino.toString(),
		size: identity.size,
		mtimeMs: identity.mtimeMs,
		mtimeNs: identity.mtimeNs.toString(),
		sha256: identity.sha256,
	};
}
async function managedCandidates(
	broker: Broker,
	cwd: string,
	label: "Saved" | "Source",
): Promise<
	| {
			candidates: readonly LogicalSessionCandidate[];
			migrationPolicy: "copy-retain" | "disabled";
			scope: ManagedSessionScope;
	  }
	| BrokerResponse
> {
	const resolved = await resolveManagedSessionScope({ cwd, agentDir: broker.settings.agentDir });
	if (resolved.kind !== "resolved")
		return fail("invalid_input", `${label} session scope is invalid: ${resolved.message}`);
	const migration = await broker.settings.resolveDirectoryMigration(cwd);
	if (migration !== "copy-retain" && migration !== "disabled")
		return fail("invalid_input", "Broker directory migration policy is invalid.");
	const listed = await listManagedSessionCandidates({ scope: resolved.scope });
	if (listed.kind !== "complete")
		return fail("invalid_input", `${label} session storage could not be verified for the requested workspace.`);
	return { candidates: listed.owned, migrationPolicy: migration, scope: resolved.scope };
}

async function validateSavedTranscript(
	broker: Broker,
	cwd: string,
	suppliedPath: string | undefined,
	expectedSessionId: string | undefined,
	label: "Saved" | "Source",
): Promise<ValidatedTranscript | BrokerResponse> {
	const inventory = await managedCandidates(broker, cwd, label);
	if ("ok" in inventory) return inventory;
	const canonicalPath = suppliedPath ? path.resolve(suppliedPath) : undefined;
	const matches = inventory.candidates.filter(
		candidate =>
			(canonicalPath === undefined || candidate.path === canonicalPath) &&
			(expectedSessionId === undefined || candidate.sessionId === expectedSessionId),
	);
	if (matches.length !== 1 || !isCanonicalSessionId(matches[0]!.sessionId))
		return fail("invalid_input", `${label} saved session does not match the requested workspace and session id.`);
	const match = matches[0]!;
	if (inventory.migrationPolicy === "disabled" && match.provenance === "legacy")
		return fail("legacy_migration_disabled", `${label} legacy session migration is disabled for this workspace.`);
	return { path: match.path, id: match.sessionId, identity: serializeTranscriptIdentity(match.identity) };
}

async function validateLiveResumeScope(
	broker: Broker,
	input: Input,
	requestedSessionId: string,
	record: LiveResumeRecord,
): Promise<ResumeScope | BrokerResponse> {
	const requestedCwd = lifecycleCwd(input);
	if (!requestedCwd) return fail("invalid_input", "A target path is required.");
	const suppliedRoot = stateRoot(input, requestedCwd);
	if (!suppliedRoot || !hasDefaultStateRoot(requestedCwd, suppliedRoot))
		return fail("invalid_input", "stateRoot must be the default .gjc/state for cwd.");
	try {
		if (!(await fs.stat(requestedCwd)).isDirectory())
			return fail("invalid_input", "Lifecycle worktree must be a directory.");
	} catch {
		return fail("invalid_input", "Lifecycle worktree does not exist.");
	}
	const worktree = lifecycleWorktreeTarget(input);
	if (worktree === null) return fail("invalid_input", "Lifecycle worktree target is invalid.");
	let cwd = requestedCwd;
	if (worktree) {
		try {
			const planned = planLaunchWorktree(
				requestedCwd,
				worktree.name
					? { enabled: true, detached: false, name: worktree.name }
					: { enabled: true, detached: true, name: null },
			);
			if (!planned.enabled) return fail("invalid_input", "Lifecycle worktree target is invalid.");
			cwd = path.resolve(planned.worktreePath);
		} catch (error) {
			return fail(
				"invalid_input",
				`Unable to validate lifecycle worktree: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
	}
	const root = defaultStateRoot(cwd);
	if (!sameResumeLocator(record, cwd, root))
		return fail("endpoint_stale", "Live session does not match the requested resume scope.");
	const sessionPath = text(input.sessionPath);
	if (!sessionPath) return fail("invalid_input", "sessionPath is required to resume a saved session.");
	const inventory = await managedCandidates(broker, cwd, "Saved");
	if ("ok" in inventory)
		return fail("endpoint_stale", "Requested saved session could not be verified for the requested workspace.");
	const canonicalSessionPath = path.resolve(sessionPath);
	const matches = inventory.candidates.filter(
		candidate => candidate.sessionId === requestedSessionId && candidate.path === canonicalSessionPath,
	);
	if (matches.length !== 1)
		return fail("endpoint_stale", "Requested saved session does not match the live session scope.");
	const session = matches[0]!;
	if (inventory.migrationPolicy === "disabled" && matches[0]!.provenance === "legacy")
		return fail("legacy_migration_disabled", "Saved legacy session migration is disabled for this workspace.");
	return {
		cwd,
		stateRoot: root,
		sessionPath: canonicalSessionPath,
		sessionIdentity: session.identity,
	};
}
async function reconcileReadyScope(
	broker: Broker,
	id: string,
	scope: string | undefined,
	root: string,
	expected: EffectMarker,
): Promise<void> {
	if (!scope) return;
	await broker.index.refresh();
	const record = broker.index
		.listSessions()
		.sessions.find(
			session =>
				session.sessionId === id &&
				resolveEquivalentPath(session.locator.stateRoot) === resolveEquivalentPath(root) &&
				session.pid === expected.pid &&
				(session.hostIncarnation ?? session.processIncarnation) === expected.incarnation &&
				session.lifecycleRequestId === expected.effectMarker,
		);
	if (!record) return;
	const cwd = canonicalExistingPath(scope);
	if (record.locator.cwd === cwd) return;
	// Locator cwd is canonical everywhere. Reconcile only a pre-existing host row
	// whose canonical registration race observed a different path; it never retains
	// a caller's lexical spelling for ACP or any other scope consumer.
	const locator = await resolveSessionLocator(scope, record.locator.stateRoot);
	await broker.index.append({
		type: "record_reconciled",
		sessionId: id,
		locator,
		endpointGeneration: record.endpointGeneration,
		pid: record.pid,
		// Reconciliation only re-scopes the locator, so every identity fact the host
		// published about its own process has to survive it: dropping the incarnation
		// here would silently disarm the teardown fence for every lifecycle session.
		...(record.processIncarnation === undefined ? {} : { processIncarnation: record.processIncarnation }),
		...(record.hostIncarnation === undefined ? {} : { hostIncarnation: record.hostIncarnation }),
		...(record.lifecycleRequestId === undefined ? {} : { lifecycleRequestId: record.lifecycleRequestId }),
		endpointMtimeMs: record.endpointMtimeMs,
		...(record.endpointFileId === undefined ? {} : { endpointFileId: record.endpointFileId }),
		...(record.masterRole === undefined ? {} : { masterRole: record.masterRole }),
	});
}

/**
 * Operator override for the session-host command, resolved from trusted
 * environment sources only.
 *
 * The result is spawned directly, so whatever can set it chooses which binary
 * the broker runs. `$env` merges the caller's `cwd/.env` into `process.env`, so
 * reading it there would let repository content replace the session host;
 * resolve it the same way provider credentials are (launching shell plus
 * GJC/user-owned `.env` files, never the project `.env`).
 */
function sdkSessionCommandOverride(): { file: string; args: string[] } | undefined {
	const configured = $credentialEnv("GJC_SDK_SESSION_COMMAND");
	if (!configured) return undefined;
	const [file, ...args] = configured.trim().split(/\s+/);
	return file ? { file, args } : undefined;
}

/** Test seam: the session-host command override as resolved from trusted env. */
export function sdkSessionCommandOverrideForTest(): { file: string; args: string[] } | undefined {
	return sdkSessionCommandOverride();
}

function command(broker: Broker): LifecycleCommand {
	const configured = sdkSessionCommandOverride();
	if (configured) return configured;
	return lifecycleCommandResolversForTest.get(broker)?.() ?? resolveSdkInternalSpawnCommand("session-host-internal");
}

/**
 * Reuses the ordinary lifecycle host bootstrap without performing its direct
 * process spawn. Broker-owned substrate providers receive this exact argv and
 * split inherited/child-specific environment contract as their only launch
 * authority for session.spawn.
 */
export type SpawnChildHostLaunch = {
	childId: string;
	cwd: string;
	stateRoot: string;
	argv: readonly string[];
	inheritedEnv: Readonly<Record<string, string>>;
	env: Readonly<Record<string, string>>;
	effectMarker: string;
};

export function prepareSpawnChildHostLaunch(
	broker: Broker,
	input: { cwd: string; modelId?: string; modelPreset?: string; childId?: string; receivedAt?: number },
): SpawnChildHostLaunch {
	const cwd = path.resolve(input.cwd);
	const childId = input.childId ?? randomUUID();
	const stateRoot = defaultStateRoot(cwd);
	const effectMarker = randomUUID();
	const deadlines = deriveLifecycleDeadlines(input.receivedAt ?? Date.now(), DEFAULT_READINESS_TIMEOUT_MS);
	const request: SessionLifecycleLaunchRequest = {
		operation: "session.create",
		sessionId: childId,
		cwd,
		stateRoot,
		effectMarker,
		...deadlines,
		...(input.modelId === undefined ? {} : { modelId: input.modelId }),
		...(input.modelPreset === undefined ? {} : { modelPreset: input.modelPreset }),
	};
	const cmd = command(broker);
	const inherited = "kind" in cmd ? cmd.env : process.env;
	const inheritedEnv = Object.fromEntries(
		Object.entries(inherited).filter(
			(entry): entry is [string, string] => entry[0] !== "GJC_MASTER_CAPABILITY" && typeof entry[1] === "string",
		),
	);
	return {
		childId,
		cwd,
		stateRoot,
		argv: [cmd.file, ...cmd.args],
		inheritedEnv,
		env: {
			GJC_AGENT_DIR: broker.settings.agentDir,
			GJC_CODING_AGENT_DIR: broker.settings.agentDir,
			GJC_SESSION_ID: childId,
			GJC_STATE_ROOT: stateRoot,
			GJC_LIFECYCLE_REQUEST_ID: effectMarker,
			GJC_SDK_LIFECYCLE_REQUEST: JSON.stringify(request),
		},
		effectMarker,
	};
}

const lifecycleMarkerPath = (root: string, id: string) => path.join(root, "sdk", `${id}.lifecycle.json`);
const lifecycleReadyPath = (root: string, id: string) => path.join(root, "sdk", `${id}.lifecycle.ready.json`);
const lifecycleFailurePath = (root: string, id: string, effectMarker: string) =>
	path.join(root, "sdk", `${id}.lifecycle.failure.${effectMarker}.json`);
type EffectMarker = { pid: number; effectMarker: string; incarnation: string };
type ReadyAuthority = {
	endpoint: Record<string, unknown>;
	endpointSource: string;
	endpointMtimeMs: number;
	endpointFileId?: string;
	endpointGeneration: number;
};
type ReadinessResult =
	| { kind: "ready"; authority: ReadyAuthority }
	| { kind: "startup_failed"; failure: SdkStartupFailure }
	| { kind: "ready_then_exited" }
	| { kind: "ready_probe_failed"; probe: ReadyAuthorityProbe }
	| { kind: "child_exited" }
	| { kind: "timeout" };
type BrokerIndex = Pick<Broker, "index">;
const processIncarnationReadersForTest = new WeakMap<BrokerIndex, (pid: number) => string | undefined>();

export function setProcessIncarnationForTest(
	broker: Broker,
	value: ((pid: number) => string | undefined) | undefined,
): void {
	if (value) processIncarnationReadersForTest.set(broker, value);
	else processIncarnationReadersForTest.delete(broker);
}

function processIncarnationForBroker(broker: BrokerIndex, pid: number): string | undefined {
	const reader = processIncarnationReadersForTest.get(broker);
	return reader ? reader(pid) : processIncarnation(pid);
}
function hasProcessIncarnationAuthority(): boolean {
	return processIncarnation(process.pid) !== undefined;
}

type ProcessObservation = "alive" | "exited" | "uncertain";

/** Only ESRCH or a changed, readable incarnation proves the owned process exited. */
function observeProcess(
	pid: number,
	expectedIncarnation: string | undefined,
	readIncarnation: (pid: number) => string | undefined = processIncarnation,
): ProcessObservation {
	if (process.platform === "win32") {
		try {
			const reference = nativeLifecycle().Process.fromPid(pid);
			if (reference?.status() !== "running") return "exited";
		} catch {
			return "uncertain";
		}
		if (!expectedIncarnation) return "uncertain";
		const actualIncarnation = readIncarnation(pid);
		if (!actualIncarnation) return "uncertain";
		return actualIncarnation === expectedIncarnation ? "alive" : "exited";
	}
	try {
		process.kill(pid, 0);
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "ESRCH" ? "exited" : "uncertain";
	}
	if (process.platform === "linux") {
		const probe = probeLinuxProcPidSync(pid);
		if (probe.kind === "live" && probe.state === "Z" && expectedIncarnation === `linux:${probe.startTime}`)
			return "exited";
	}
	if (!expectedIncarnation) return "uncertain";
	const actualIncarnation = readIncarnation(pid);
	if (!actualIncarnation) return "uncertain";
	return actualIncarnation === expectedIncarnation ? "alive" : "exited";
}

/** Test seam for the lifecycle-owned process observation boundary. */
export function observeProcessForTest(
	pid: number,
	expectedIncarnation: string | undefined,
	readIncarnation: (pid: number) => string | undefined = processIncarnation,
): ProcessObservation {
	return observeProcess(pid, expectedIncarnation, readIncarnation);
}

function hasObservedProcessExit(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return false;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "ESRCH";
	}
}

type StableProcessExitObserver = {
	hasExited(): boolean;
};

/**
 * Pin the indexed process before shutdown so exit remains observable after it
 * becomes a zombie. `kill(pid, 0)` and `/proc/<pid>/stat` continue to describe
 * an unreaped zombie as present, which otherwise makes a timely SIGTERM exit
 * look unverifiable and incorrectly escalates the close to terminal uncertainty.
 */
function stableProcessExitObserver(record: CloseRecord): StableProcessExitObserver | undefined {
	if (!record.processIncarnation) return undefined;
	try {
		const reference = nativeLifecycle().Process.fromPid(record.pid);
		if (!reference || reference.incarnation !== record.processIncarnation) return undefined;
		return { hasExited: () => reference.status() === "exited" };
	} catch {
		return undefined;
	}
}

function observedProcessExited(
	pid: number,
	expectedIncarnation: string | undefined,
	observer: StableProcessExitObserver | undefined,
): boolean {
	try {
		if (observer?.hasExited()) return true;
	} catch {}
	if (hasObservedProcessExit(pid)) return true;
	if (process.platform !== "linux" || !expectedIncarnation?.startsWith("linux:")) return false;
	const probe = probeLinuxProcPidSync(pid);
	return probe.kind === "live" && probe.state === "Z" && `linux:${probe.startTime}` === expectedIncarnation;
}

function isEffectMarker(value: unknown): value is EffectMarker {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
	const marker = value as Record<string, unknown>;
	return (
		typeof marker.pid === "number" &&
		Number.isSafeInteger(marker.pid) &&
		marker.pid > 0 &&
		typeof marker.effectMarker === "string" &&
		/^[A-Za-z0-9._-]+$/.test(marker.effectMarker) &&
		marker.effectMarker.length <= MAX_EFFECT_MARKER_LENGTH &&
		typeof marker.incarnation === "string" &&
		marker.incarnation.length > 0 &&
		marker.incarnation.length <= MAX_PROCESS_INCARNATION_LENGTH
	);
}

function isExactEffectMarker(value: unknown): value is EffectMarker {
	return (
		isEffectMarker(value) &&
		Object.keys(value).length === 3 &&
		Object.keys(value).every(key => key === "pid" || key === "effectMarker" || key === "incarnation")
	);
}

function sameEffectMarker(left: EffectMarker, right: EffectMarker): boolean {
	return left.pid === right.pid && left.effectMarker === right.effectMarker && left.incarnation === right.incarnation;
}

async function readEffectMarker(file: string): Promise<EffectMarker | undefined> {
	try {
		const captured = captureLifecycleFile(file, true, true);
		if (!captured) return undefined;
		const marker: unknown = parseLifecycleJson(captured.bytes);
		return isExactEffectMarker(marker) ? marker : undefined;
	} catch {
		return undefined;
	}
}

/**
 * Retires stale lifecycle markers only when their exact owner is proven gone. These
 * files are launch bookkeeping, not authority for a future process: retaining
 * an abandoned marker indefinitely turns unrelated launch failures into
 * cleanup uncertainty. Unreadable, malformed, linked, and live markers are
 * deliberately left untouched.
 */
export async function reapDeadLifecycleMarkers(
	root: string,
	limit = BROKER_DEAD_REGISTRATION_SWEEP_LIMIT,
): Promise<number> {
	let directory: string;
	let directoryIdentity: { dev: bigint; ino: bigint };
	try {
		const canonicalRoot = fsSync.realpathSync(root);
		directory = path.join(canonicalRoot, "sdk");
		const directoryStat = fsSync.lstatSync(directory, { bigint: true });
		if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink()) return 0;
		directoryIdentity = { dev: directoryStat.dev, ino: directoryStat.ino };
	} catch {
		return 0;
	}
	const inspectionLimit = Math.max(0, limit);
	if (inspectionLimit === 0) return 0;
	let directoryHandle: fsSync.Dir;
	try {
		directoryHandle = await fs.opendir(directory);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return 0;
		return 0;
	}
	let reaped = 0;
	let inspected = 0;
	for await (const entry of directoryHandle) {
		if (inspected >= inspectionLimit) break;
		inspected += 1;
		const name = entry.name;
		if (!entry.isFile() || !name.endsWith(".lifecycle.json")) continue;
		const id = name.slice(0, -".lifecycle.json".length);
		if (!isCanonicalSessionId(id)) continue;
		const markerPath = path.join(directory, name);
		const marker = await readEffectMarker(markerPath);
		if (!marker || observeProcess(marker.pid, marker.incarnation) !== "exited") continue;
		const primary = captureLifecycleFile(markerPath, true, true);
		if (!primary || Date.now() - Number(primary.identity.mtimeNs / 1_000_000n) < DEAD_LIFECYCLE_MARKER_EXPIRY_MS)
			continue;
		const readyPath = lifecycleReadyPath(path.dirname(directory), id);
		const ready = captureLifecycleFile(readyPath, true, true);
		if (ready) {
			try {
				const readyMarker = parseLifecycleJson(ready.bytes);
				if (!isExactEffectMarker(readyMarker) || !sameEffectMarker(readyMarker, marker)) continue;
			} catch {
				continue;
			}
		}
		try {
			const currentParent = lifecycleParentIdentity(directory);
			if (
				!currentParent ||
				BigInt(currentParent.dev) !== directoryIdentity.dev ||
				BigInt(currentParent.ino) !== directoryIdentity.ino
			)
				continue;
			const currentPrimary = captureLifecycleFile(markerPath, true, true);
			const currentReady = ready ? captureLifecycleFile(readyPath, true, true)?.identity : undefined;
			if (
				!currentPrimary ||
				!sameLifecycleCleanupIdentity(
					currentPrimary.identity,
					serializeCleanupIdentity({ ...primary.identity, size: Number(primary.identity.size) }),
				) ||
				(ready &&
					(!currentReady ||
						!sameLifecycleCleanupIdentity(
							currentReady,
							serializeCleanupIdentity({ ...ready.identity, size: Number(ready.identity.size) }),
						)))
			)
				continue;
			const currentMarker = parseLifecycleJson(currentPrimary.bytes);
			if (!isExactEffectMarker(currentMarker) || !sameEffectMarker(currentMarker, marker)) continue;
			if (
				ready &&
				!nativeLifecycle().exactUnlinkDirect(readyPath, {
					...ready.identity,
					parentDev: directoryIdentity.dev,
					parentIno: directoryIdentity.ino,
					quarantineName: `.gjc-reap-${randomUUID()}-${path.basename(readyPath)}`,
				}).ok
			)
				continue;
			if (
				!nativeLifecycle().exactUnlinkDirect(markerPath, {
					...primary.identity,
					parentDev: directoryIdentity.dev,
					parentIno: directoryIdentity.ino,
					quarantineName: `.gjc-reap-${randomUUID()}-${name}`,
				}).ok
			)
				continue;
		} catch {
			continue;
		}
		reaped += 1;
	}
	return reaped;
}

async function writeEffectMarker(root: string, id: string, marker: EffectMarker): Promise<void> {
	const directory = path.join(root, "sdk");
	await fs.mkdir(directory, { recursive: true, mode: 0o700 });
	const temporary = path.join(directory, `.${id}.lifecycle.${randomUUID()}.tmp`);
	const handle = await fs.open(
		temporary,
		fsSync.constants.O_CREAT | fsSync.constants.O_EXCL | fsSync.constants.O_WRONLY,
		0o600,
	);
	try {
		await handle.writeFile(canonicalJson(marker));
		await handle.sync();
	} finally {
		await handle.close();
	}
	try {
		await fs.rename(temporary, lifecycleMarkerPath(root, id));
		await syncDirectory(directory);
	} finally {
		await fs.rm(temporary, { force: true });
	}
}

/** The child writes this only after its endpoint and semantic ready event are both live. */
export async function writeSessionLifecycleReady(root: string, id: string, effectMarker: string): Promise<void> {
	const incarnation = processIncarnation(process.pid);
	if (!incarnation) throw new Error("Lifecycle child has no readable OS incarnation.");
	const directory = path.join(root, "sdk");
	await fs.mkdir(directory, { recursive: true, mode: 0o700 });
	const temporary = path.join(directory, `.${id}.lifecycle.ready.${randomUUID()}.tmp`);
	const handle = await fs.open(
		temporary,
		fsSync.constants.O_CREAT | fsSync.constants.O_EXCL | fsSync.constants.O_WRONLY,
		0o600,
	);
	try {
		await handle.writeFile(canonicalJson({ pid: process.pid, effectMarker, incarnation }));
		await handle.sync();
	} finally {
		await handle.close();
	}
	try {
		await fs.rename(temporary, lifecycleReadyPath(root, id));
		await syncDirectory(directory);
	} finally {
		await fs.rm(temporary, { force: true });
	}
}

export interface LifecycleTranscriptEvidence {
	digest: string;
	identity: SessionLifecycleTranscriptIdentity;
}

type LifecycleFailureArtifact = EffectMarker &
	SdkStartupFailure & {
		rollback: SdkStartupRollbackResult;
		transcript?: LifecycleTranscriptEvidence;
	};

function canonicalJson(value: unknown): string {
	if (value === null || typeof value !== "object") return JSON.stringify(value);
	if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
	const record = value as Record<string, unknown>;
	return `{${Object.keys(record)
		.sort()
		.map(key => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
		.join(",")}}`;
}

function isRollbackResult(value: unknown): value is SdkStartupRollbackResult {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
	const record = value as Record<string, unknown>;
	return (
		Object.keys(record).length === 5 &&
		(record.endpointGeneration === null ||
			(typeof record.endpointGeneration === "number" &&
				Number.isSafeInteger(record.endpointGeneration) &&
				record.endpointGeneration > 0)) &&
		typeof record.fenced === "boolean" &&
		typeof record.runtimeRemoved === "boolean" &&
		typeof record.hostStopped === "boolean" &&
		typeof record.brokerRegistrationReleased === "boolean"
	);
}

function isLifecycleTranscriptEvidence(value: unknown): value is LifecycleTranscriptEvidence {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
	const record = value as Record<string, unknown>;
	return (
		Object.keys(record).length === 2 &&
		typeof record.digest === "string" &&
		/^[a-f0-9]{64}$/.test(record.digest) &&
		isSessionLifecycleTranscriptIdentity(record.identity) &&
		record.digest === record.identity.sha256
	);
}

function isSdkStartupFailure(value: unknown): value is SdkStartupFailure {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
	const failure = value as Record<string, unknown>;
	const keys = Object.keys(failure);
	if (
		!keys.every(
			key => key === "phase" || key === "reason" || key === "message" || key === "code" || key === "details",
		) ||
		(failure.phase !== "registration" && failure.phase !== "startup") ||
		(failure.reason !== "disabled" &&
			failure.reason !== "ineligible" &&
			failure.reason !== "factory_absent" &&
			failure.reason !== "runner_absent" &&
			failure.reason !== "admission_timeout" &&
			failure.reason !== "pending" &&
			failure.reason !== "failed") ||
		typeof failure.message !== "string" ||
		Buffer.byteLength(failure.message) === 0 ||
		Buffer.byteLength(failure.message) > 512
	)
		return false;
	if (failure.code === undefined && failure.details === undefined) return keys.length === 3;
	return keys.length === 5 && isModelProfileError(failure);
}

function isLifecycleFailureArtifact(value: unknown): value is LifecycleFailureArtifact {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
	const record = value as Record<string, unknown>;
	if (!isEffectMarker(record)) return false;
	const artifact = value as LifecycleFailureArtifact;
	return (
		Object.keys(record).length ===
			7 + (artifact.code === undefined ? 0 : 2) + (artifact.transcript === undefined ? 0 : 1) &&
		isSdkStartupFailure({
			phase: artifact.phase,
			reason: artifact.reason,
			message: artifact.message,
			...(artifact.code === undefined ? {} : { code: artifact.code, details: artifact.details }),
		}) &&
		isRollbackResult(artifact.rollback) &&
		(artifact.transcript === undefined || isLifecycleTranscriptEvidence(artifact.transcript))
	);
}

async function syncDirectory(directory: string): Promise<void> {
	// Windows does not support fsync on directory handles. File contents and
	// lifecycle markers are still written through the normal atomic path; the
	// directory durability barrier is a POSIX-only operation.
	if (process.platform === "win32") return;
	const handle = await fs.open(directory, fsSync.constants.O_RDONLY);
	try {
		await handle.sync();
	} finally {
		await handle.close();
	}
}

/** Writes bounded startup diagnostics. The child stamps its own pid; the broker may stamp a proven child identity. */
export async function writeSessionLifecycleFailure(
	root: string,
	id: string,
	effectMarker: string,
	failure: SdkStartupFailure,
	rollback: SdkStartupRollbackResult,
	transcript?: LifecycleTranscriptEvidence,
	ownerIncarnation?: string,
	ownerPid?: number,
): Promise<void> {
	if (!isSdkStartupFailure(failure))
		throw new Error("Lifecycle startup failure does not satisfy the canonical failure contract.");
	if (transcript && !isLifecycleTranscriptEvidence(transcript))
		throw new Error(
			"Lifecycle startup failure transcript evidence does not bind its content digest to its identity.",
		);

	const incarnation = ownerIncarnation ?? processIncarnation(process.pid);
	if (!incarnation) return;
	const directory = path.join(root, "sdk");
	await fs.mkdir(directory, { recursive: true, mode: 0o700 });
	await fs.chmod(directory, 0o700);
	const artifact: LifecycleFailureArtifact = {
		pid: ownerPid ?? process.pid,
		effectMarker,
		incarnation,
		...failure,
		rollback,
		...(transcript ? { transcript } : {}),
	};
	const bytes = Buffer.from(canonicalJson(artifact), "utf8");
	if (bytes.length > MAX_LIFECYCLE_METADATA_BYTES)
		throw new Error("Lifecycle startup failure exceeds the metadata size ceiling.");
	const target = lifecycleFailurePath(root, id, effectMarker);
	const temporary = path.join(directory, `.${id}.lifecycle.failure.${effectMarker}.${randomUUID()}.tmp`);
	let published = false;
	try {
		const handle = await fs.open(
			temporary,
			fsSync.constants.O_CREAT | fsSync.constants.O_EXCL | fsSync.constants.O_WRONLY,
			0o600,
		);
		try {
			await handle.writeFile(bytes);
			await handle.sync();
		} finally {
			await handle.close();
		}
		try {
			await fs.link(temporary, target);
			published = true;
		} catch (writeError) {
			if ((writeError as NodeJS.ErrnoException).code !== "EEXIST") throw writeError;
			const existing = await readLifecycleFailureArtifact(target, artifact);
			if (!existing?.bytes.equals(bytes)) throw new Error("Lifecycle startup failure artifact collision.");
		}
	} finally {
		await fs.rm(temporary, { force: true });
		if (published) await syncDirectory(directory);
	}
}

async function readLifecycleFailureArtifact(
	file: string,
	expected: EffectMarker,
): Promise<
	| {
			artifact: LifecycleFailureArtifact;
			bytes: Buffer;
			digest: string;
			identity: { dev: bigint; ino: bigint; size: bigint; mtimeNs: bigint; sha256: string; nlink: bigint };
	  }
	| undefined
> {
	let handle: fs.FileHandle | undefined;
	try {
		handle = await fs.open(file, fsSync.constants.O_RDONLY | fsSync.constants.O_NOFOLLOW);
		const stat = await handle.stat({ bigint: true });
		if (!stat.isFile() || stat.nlink !== 1n || stat.size > 4096n) return undefined;
		const bytes = Buffer.alloc(Number(stat.size) + 1);
		const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0);
		if (bytesRead > 4096) return undefined;
		const raw = bytes.subarray(0, bytesRead);
		const value: unknown = parseLifecycleJson(raw);
		if (
			!isLifecycleFailureArtifact(value) ||
			!sameEffectMarker(value, expected) ||
			canonicalJson(value) !== decodeLifecycleUtf8(raw)
		)
			return undefined;
		return {
			artifact: value,
			bytes: raw,
			digest: createHash("sha256").update(raw).digest("hex"),
			identity: {
				dev: stat.dev,
				ino: stat.ino,
				nlink: stat.nlink,
				size: stat.size,
				mtimeNs: stat.mtimeNs,
				sha256: createHash("sha256").update(raw).digest("hex"),
			},
		};
	} catch {
		return undefined;
	} finally {
		if (handle) await handle.close();
	}
}

function exactUnlinkLifecycleFile(
	file: string,
	identity: { dev: bigint; ino: bigint; size: bigint; mtimeNs: bigint; sha256: string; nlink: bigint },
	plannedPath: string,
	parentIdentity?: { dev: bigint; ino: bigint },
): NativeExactUnlinkResult {
	return nativeLifecycle().exactUnlink(file, {
		...identity,
		quarantineName: path.basename(plannedPath),
		...(parentIdentity ? { parentDev: parentIdentity.dev, parentIno: parentIdentity.ino } : {}),
	});
}

type LifecycleCleanupFile = NonNullable<BrokerCleanupEvidence["lifecycleFiles"]>[number];

function sameLifecycleCleanupIdentity(
	left: { dev: bigint; ino: bigint; size: bigint; mtimeNs: bigint; sha256: string; nlink: bigint },
	right: BrokerCleanupIdentity,
): boolean {
	return (
		left.dev.toString() === right.dev &&
		left.ino.toString() === right.ino &&
		left.size === BigInt(right.size) &&
		left.mtimeNs.toString() === right.mtimeNs &&
		left.sha256 === right.sha256 &&
		(right.nlink === undefined || left.nlink.toString() === right.nlink)
	);
}

function lifecycleParentIdentity(directory: string): { dev: string; ino: string } | undefined {
	try {
		const stat = fsSync.lstatSync(directory, { bigint: true });
		if (!stat.isDirectory()) return undefined;
		return { dev: stat.dev.toString(), ino: stat.ino.toString() };
	} catch {
		return undefined;
	}
}

function lifecycleCleanupPlan(
	root: string,
	id: string,
	expected: EffectMarker,
	evidence: { identity: { dev: bigint; ino: bigint; size: bigint; mtimeNs: bigint; sha256: string; nlink: bigint } },
): CleanupEvidence {
	const directory = path.join(root, "sdk");
	const parentIdentity = lifecycleParentIdentity(directory);
	if (!parentIdentity) throw new Error("Lifecycle cleanup parent identity is unavailable.");
	const candidates = [
		lifecycleFailurePath(root, id, expected.effectMarker),
		path.join(directory, `${id}.json`),
		lifecycleReadyPath(root, id),
		lifecycleMarkerPath(root, id),
	];
	const files: LifecycleCleanupFile[] = candidates.flatMap(file => {
		const captured = captureLifecycleFile(
			file,
			true,
			file === lifecycleMarkerPath(root, id) || file === lifecycleReadyPath(root, id),
		);

		if (!captured) return [];
		if (file === lifecycleMarkerPath(root, id) || file === lifecycleReadyPath(root, id)) {
			let marker: unknown;
			try {
				marker = parseLifecycleJson(captured.bytes);
			} catch {
				throw new Error("Lifecycle marker changed before cleanup intent persistence.");
			}
			if (!isExactEffectMarker(marker) || !sameEffectMarker(marker, expected))
				throw new Error("Lifecycle marker changed before cleanup intent persistence.");
		}
		if (file.endsWith(`${id}.json`)) {
			let endpoint: { pid?: unknown };
			try {
				endpoint = parseLifecycleJson(captured.bytes) as { pid?: unknown };
			} catch {
				throw new Error("Lifecycle endpoint changed before cleanup intent persistence.");
			}
			if (endpoint.pid !== expected.pid)
				throw new Error("Lifecycle endpoint changed before cleanup intent persistence.");
		}
		const identity = file === candidates[0] ? evidence.identity : captured.identity;
		if (
			file === candidates[0] &&
			!sameLifecycleCleanupIdentity(
				captured.identity,
				serializeCleanupIdentity({ ...identity, size: Number(identity.size) }),
			)
		)
			throw new Error("Lifecycle failure artifact changed before cleanup intent persistence.");
		const attempt = 1;
		const suffix = randomUUID();
		return [
			{
				path: file,
				identity: serializeCleanupIdentity({ ...identity, size: Number(identity.size) }),
				attempt,
				plannedPath: path.join(directory, `.gjc-delete-${suffix}-${path.basename(file)}`),
			},
		];
	});
	return {
		phase: "lifecycle",
		sessionId: id,
		metadataRoot: root,
		lifecycleParentIdentity: parentIdentity,
		lifecycleFiles: files,
	};
}

function escapeRegExp(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function isCanonicalLifecycleCleanupOriginal(root: string, id: string, original: string): boolean {
	const directory = path.join(path.resolve(root), "sdk");
	if (path.dirname(original) !== directory) return false;
	const basename = path.basename(original);
	return (
		basename === `${id}.json` ||
		basename === `${id}.lifecycle.json` ||
		basename === `${id}.lifecycle.ready.json` ||
		new RegExp(`^${escapeRegExp(id)}\\.lifecycle\\.failure\\.[A-Za-z0-9._-]{1,128}\\.json$`).test(basename)
	);
}

function lifecycleCleanupHasMixedMetadataSchema(cleanup: CleanupEvidence): boolean {
	return [
		cleanup.metadataIdentity,
		cleanup.metadataPath,
		cleanup.metadataAttempt,
		cleanup.plannedMetadataPath,
		cleanup.detachedMetadataPath,
		cleanup.metadataCompleted,
	].some(value => value !== undefined);
}

function isCleanupIdentity(value: unknown): value is BrokerCleanupIdentity {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
	const identity = value as Record<string, unknown>;
	return (
		(Object.keys(identity).length === 5 || Object.keys(identity).length === 6) &&
		Object.keys(identity).every(
			key =>
				key === "dev" ||
				key === "ino" ||
				key === "nlink" ||
				key === "size" ||
				key === "mtimeNs" ||
				key === "sha256",
		) &&
		typeof identity.dev === "string" &&
		/^\d+$/.test(identity.dev) &&
		typeof identity.ino === "string" &&
		/^\d+$/.test(identity.ino) &&
		(identity.nlink === undefined || (typeof identity.nlink === "string" && /^\d+$/.test(identity.nlink))) &&
		typeof identity.size === "number" &&
		Number.isSafeInteger(identity.size) &&
		identity.size >= 0 &&
		typeof identity.mtimeNs === "string" &&
		/^\d+$/.test(identity.mtimeNs) &&
		typeof identity.sha256 === "string" &&
		/^[a-f0-9]{64}$/.test(identity.sha256)
	);
}

function isLifecycleCleanupFile(value: unknown): value is LifecycleCleanupFile {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
	const file = value as Record<string, unknown>;
	const allowed = new Set(["path", "identity", "attempt", "plannedPath", "detachedPath", "completed"]);
	return (
		Object.keys(file).every(key => allowed.has(key)) &&
		typeof file.path === "string" &&
		file.path.length > 0 &&
		typeof file.plannedPath === "string" &&
		file.plannedPath.length > 0 &&
		isCleanupIdentity(file.identity) &&
		typeof file.attempt === "number" &&
		(file.completed === true ||
			(typeof (file.identity as BrokerCleanupIdentity).nlink === "string" &&
				(file.identity as BrokerCleanupIdentity).nlink === "1")) &&
		Number.isSafeInteger(file.attempt) &&
		file.attempt > 0 &&
		(file.detachedPath === undefined || (typeof file.detachedPath === "string" && file.detachedPath.length > 0)) &&
		(file.completed === undefined || file.completed === true)
	);
}

function isLifecycleCleanupEvidence(cleanup: CleanupEvidence): boolean {
	if (typeof cleanup !== "object" || cleanup === null || Array.isArray(cleanup)) return false;
	const record = cleanup as Record<string, unknown>;
	const allowed = new Set([
		"phase",
		"sessionId",
		"metadataRoot",
		"lifecycleDeleteMetadata",
		"lifecycleParentIdentity",
		"lifecycleFiles",
		"uncertainRetirement",
	]);
	const parentIdentity = record.lifecycleParentIdentity as Record<string, unknown> | undefined;
	const filesValid = Array.isArray(record.lifecycleFiles) && record.lifecycleFiles.every(isLifecycleCleanupFile);
	const receiptValid =
		record.uncertainRetirement === undefined || isLifecycleRetirementReceipt(record.uncertainRetirement);
	return (
		Object.keys(record).every(key => allowed.has(key)) &&
		record.phase === "lifecycle" &&
		typeof record.sessionId === "string" &&
		isCanonicalSessionId(record.sessionId) &&
		typeof record.metadataRoot === "string" &&
		record.metadataRoot.length > 0 &&
		!!parentIdentity &&
		typeof parentIdentity.dev === "string" &&
		/^\d+$/.test(parentIdentity.dev) &&
		typeof parentIdentity.ino === "string" &&
		/^\d+$/.test(parentIdentity.ino) &&
		Array.isArray(record.lifecycleFiles) &&
		(record.lifecycleFiles.length > 0 || isLifecycleRetirementCleanup(cleanup)) &&
		record.lifecycleFiles.length <= 4 &&
		(record.lifecycleDeleteMetadata === undefined || record.lifecycleDeleteMetadata === true) &&
		receiptValid &&
		filesValid
	);
}

function validateLifecycleCleanupShape(cleanup: CleanupEvidence): BrokerResponse | undefined {
	const retirement = isLifecycleRetirementCleanup(cleanup) ? cleanup.uncertainRetirement : undefined;
	if (
		!isLifecycleCleanupEvidence(cleanup) ||
		lifecycleCleanupHasMixedMetadataSchema(cleanup) ||
		(cleanup.lifecycleDeleteMetadata === true && cleanup.lifecycleFiles!.length > 2) ||
		(retirement !== undefined && cleanup.lifecycleDeleteMetadata === true) ||
		(retirement !== undefined && cleanup.sessionId !== retirement.identity.sessionId) ||
		(retirement !== undefined && path.resolve(cleanup.metadataRoot!) !== path.resolve(retirement.identity.stateRoot))
	)
		return fail("terminal_uncertain", "Lifecycle cleanup replay lacks a complete unambiguous schema.");
	const files = cleanup.lifecycleFiles!;
	const paths = new Set<string>();
	for (const file of files) {
		if (!validateLifecycleCleanupFile(cleanup.metadataRoot!, cleanup.sessionId!, file))
			return fail("terminal_uncertain", "Lifecycle cleanup replay contains an invalid path authority.");
		const entryPaths = new Map<string, "path" | "plannedPath" | "detachedPath">();
		for (const [field, candidate] of [
			["path", file.path],
			["plannedPath", file.plannedPath],
			["detachedPath", file.detachedPath],
		] as const) {
			if (candidate === undefined) continue;
			const resolved = path.resolve(candidate);
			const previousField = entryPaths.get(resolved);
			if (previousField !== undefined) {
				if (
					(previousField === "plannedPath" && field === "detachedPath") ||
					(previousField === "detachedPath" && field === "plannedPath")
				)
					continue;
				return fail("terminal_uncertain", "Lifecycle cleanup replay contains duplicate path authority.");
			}
			entryPaths.set(resolved, field);
			if (paths.has(resolved))
				return fail("terminal_uncertain", "Lifecycle cleanup replay contains duplicate path authority.");
			paths.add(resolved);
		}
	}
	return undefined;
}

function retirementCleanupFromResponse(value: unknown): LifecycleRetirementCleanup | undefined {
	if (typeof value !== "object" || value === null || (value as { ok?: unknown }).ok !== false) return undefined;
	const cleanup = (value as { error?: { cleanup?: unknown } }).error?.cleanup;
	return isLifecycleRetirementCleanup(cleanup) ? cleanup : undefined;
}

function exactLifecycleRootIdentity(root: string): { dev: string; ino: string } | undefined {
	try {
		const rootStat = fsSync.lstatSync(root, { bigint: true });
		const sdk = fsSync.lstatSync(path.join(root, "sdk"), { bigint: true });
		if (!rootStat.isDirectory() || rootStat.isSymbolicLink() || !sdk.isDirectory() || sdk.isSymbolicLink())
			return undefined;
		return { dev: sdk.dev.toString(), ino: sdk.ino.toString() };
	} catch {
		return undefined;
	}
}

/** Only ENOENT under the exact, non-symlinked sdk parent proves endpoint absence. */
function exactLifecycleEndpointAbsent(root: string, id: string): boolean {
	if (!exactLifecycleRootIdentity(root)) return false;
	try {
		fsSync.lstatSync(path.join(root, "sdk", `${id}.json`));
		return false;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "ENOENT";
	}
}

function sameRetirementIdentityAsRecord(identity: LifecycleRetirementIdentity, record: IndexedSession): boolean {
	return (
		identity.sessionId === record.sessionId &&
		path.resolve(identity.stateRoot) === path.resolve(record.locator.stateRoot) &&
		identity.endpointGeneration === record.endpointGeneration &&
		identity.endpointMtimeMs === record.endpointMtimeMs &&
		identity.endpointFileId === record.endpointFileId &&
		identity.pid === record.pid &&
		identity.processIncarnation === record.processIncarnation &&
		identity.hostIncarnation === record.hostIncarnation &&
		identity.lifecycleRequestId === record.lifecycleRequestId
	);
}

function findRetirementRecord(
	broker: Broker,
	id: string,
	receipt: LifecycleRetirementReceipt | undefined,
): IndexedSession | undefined {
	if (receipt !== undefined) {
		const historical = broker.index.findHistoricalSessionIdentity(receipt.identity);
		if (historical) return historical;
		// A later registration may make a same-ID successor the public authority.
		// Receipt replay must search the retained identity set first so the
		// successor can never shadow the exact staged retirement identity.
		const staged = broker.index
			.listSessionIdentities()
			.find(session => session.sessionId === id && sameRetirementIdentityAsRecord(receipt.identity, session));
		if (staged) return staged;
	}
	const current = broker.index.listSessions().sessions.find(session => session.sessionId === id);
	return current;
}

function retirementMarkerCapture(
	root: string,
	id: string,
	pathName: string,
	expected: EffectMarker,
): LifecycleFileCapture | undefined {
	const capture = captureLifecycleFile(pathName, true, true);
	if (!capture) return undefined;
	let parsed: unknown;
	try {
		parsed = parseLifecycleJson(capture.bytes);
	} catch {
		throw new Error("Lifecycle retirement marker is malformed.");
	}
	if (
		!isExactEffectMarker(parsed) ||
		!sameEffectMarker(parsed, expected) ||
		canonicalJson(parsed) !== decodeLifecycleUtf8(capture.bytes) ||
		path.dirname(path.resolve(pathName)) !== path.join(path.resolve(root), "sdk") ||
		path.basename(pathName) !==
			path.basename(
				pathName === lifecycleMarkerPath(root, id) ? lifecycleMarkerPath(root, id) : lifecycleReadyPath(root, id),
			)
	)
		throw new Error("Lifecycle retirement marker identity is incomplete.");
	return capture;
}

function retirementCleanupPlan(
	root: string,
	id: string,
	create: { identity: string; effectMarker?: string },
	identity: LifecycleRetirementIdentity,
): LifecycleRetirementCleanup | BrokerResponse {
	const parentIdentity = exactLifecycleRootIdentity(root);
	if (!parentIdentity) return fail("terminal_uncertain", "Lifecycle metadata root or parent identity is unavailable.");
	if (!create.effectMarker || create.effectMarker !== identity.lifecycleRequestId)
		return fail("terminal_uncertain", "Create ledger identity lacks the indexed lifecycle request marker.");
	const expected: EffectMarker = {
		pid: identity.pid,
		effectMarker: identity.lifecycleRequestId,
		incarnation: identity.processIncarnation,
	};
	const markerPath = lifecycleMarkerPath(root, id);
	const readyPath = lifecycleReadyPath(root, id);
	let marker: LifecycleFileCapture | undefined;
	let ready: LifecycleFileCapture | undefined;
	try {
		marker = retirementMarkerCapture(root, id, markerPath, expected);
		ready = retirementMarkerCapture(root, id, readyPath, expected);
	} catch {
		return fail("terminal_uncertain", "Lifecycle marker or readiness evidence is malformed or replaced.");
	}
	// A readiness sibling without its canonical marker is never an authority. A
	// fresh retirement must also retain both captures so the owner chain is
	// complete; the staged replay receipt is the only path that may proceed with
	// both siblings already detached.
	if (!marker || !ready) return fail("terminal_uncertain", "Lifecycle marker and readiness evidence are incomplete.");
	const directory = path.join(root, "sdk");
	const files: LifecycleCleanupFile[] = [
		{
			path: markerPath,
			identity: serializeCleanupIdentity({ ...marker.identity, size: Number(marker.identity.size) }),
			attempt: 1,
			plannedPath: path.join(directory, `.gjc-delete-${randomUUID()}-${path.basename(markerPath)}`),
		},
		{
			path: readyPath,
			identity: serializeCleanupIdentity({ ...ready.identity, size: Number(ready.identity.size) }),
			attempt: 1,
			plannedPath: path.join(directory, `.gjc-delete-${randomUUID()}-${path.basename(readyPath)}`),
		},
	];
	return {
		phase: "lifecycle",
		sessionId: id,
		metadataRoot: root,
		lifecycleParentIdentity: parentIdentity,
		lifecycleFiles: files,
		uncertainRetirement: {
			version: 1,
			stage: "cleanup",
			identity,
		},
	};
}

function retirementCleanupSettled(cleanup: LifecycleRetirementCleanup): boolean {
	const expectedParent = cleanup.lifecycleParentIdentity;
	if (!expectedParent || !cleanup.metadataRoot) return false;
	const parent = lifecycleParentIdentity(path.join(cleanup.metadataRoot, "sdk"));
	if (!parent || parent.dev !== expectedParent.dev || parent.ino !== expectedParent.ino) return false;
	for (const file of cleanup.lifecycleFiles ?? []) {
		try {
			fsSync.lstatSync(file.path);
			return false;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") return false;
		}
		for (const candidate of [file.detachedPath, file.plannedPath]) {
			if (!candidate) continue;
			try {
				const stat = fsSync.lstatSync(candidate, { bigint: true });
				if (!stat.isFile() || stat.isSymbolicLink() || stat.size !== 0n) return false;
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "ENOENT") return false;
			}
		}
	}
	return true;
}

function retirementCleanupParentMatches(cleanup: LifecycleRetirementCleanup): boolean {
	const expectedParent = cleanup.lifecycleParentIdentity;
	if (!expectedParent || !cleanup.metadataRoot) return false;
	const parent = lifecycleParentIdentity(path.join(cleanup.metadataRoot, "sdk"));
	return parent !== undefined && parent.dev === expectedParent.dev && parent.ino === expectedParent.ino;
}

function retirementIdentityFromInput(
	input: Input,
	record: IndexedSession,
	createIdentity: string,
): LifecycleRetirementIdentity | BrokerResponse {
	const stateRoot = text(input.stateRoot);
	const lifecycleRequestId = text(input.lifecycleRequestId);
	const processIdentity = text(input.processIncarnation);
	const hostIdentity = text(input.hostIncarnation);
	const remoteCreateKey = text(input.remoteCreateKey);
	const endpointFileId = text(input.endpointFileId);
	const endpointGeneration = input.endpointGeneration;
	const endpointMtimeMs = input.endpointMtimeMs;
	if (
		!stateRoot ||
		!path.isAbsolute(stateRoot) ||
		!lifecycleRequestId ||
		!processIdentity ||
		!hostIdentity ||
		!remoteCreateKey ||
		(input.endpointFileId !== undefined && endpointFileId === undefined) ||
		typeof endpointGeneration !== "number" ||
		!Number.isSafeInteger(endpointGeneration) ||
		endpointGeneration <= 0 ||
		typeof endpointMtimeMs !== "number" ||
		!Number.isFinite(endpointMtimeMs) ||
		endpointMtimeMs <= 0 ||
		!boundedRetirementString(lifecycleRequestId, MAX_EFFECT_MARKER_LENGTH) ||
		!/^[A-Za-z0-9._-]+$/.test(lifecycleRequestId) ||
		!boundedRetirementString(processIdentity, MAX_PROCESS_INCARNATION_LENGTH) ||
		!boundedRetirementString(hostIdentity, MAX_PROCESS_INCARNATION_LENGTH)
	)
		return fail("invalid_input", "Retirement requires the complete indexed identity proof.");
	const identity: LifecycleRetirementIdentity = {
		sessionId: record.sessionId,
		stateRoot,
		endpointGeneration,
		endpointMtimeMs,
		...(endpointFileId === undefined ? {} : { endpointFileId }),
		pid: record.pid,
		processIncarnation: processIdentity,
		hostIncarnation: hostIdentity,
		lifecycleRequestId,
		createIdentity,
		remoteCreateKey,
	};
	if (!isLifecycleRetirementIdentity(identity))
		return fail("invalid_input", "Retirement identity is malformed or exceeds the bounded proof schema.");
	if (
		path.resolve(record.locator.stateRoot) !== path.resolve(stateRoot) ||
		record.endpointGeneration !== endpointGeneration ||
		record.endpointMtimeMs !== endpointMtimeMs ||
		record.endpointFileId !== endpointFileId ||
		record.lifecycleRequestId !== lifecycleRequestId ||
		(record.processIncarnation ?? record.hostIncarnation) !== processIdentity ||
		(record.hostIncarnation ?? record.processIncarnation) !== hostIdentity
	)
		return fail(
			"retirement_proof_stale",
			"Retirement proof does not match the indexed session authority before effect start.",
		);
	return identity;
}

function retirementProof(identity: LifecycleRetirementIdentity, indexSeq?: number): BrokerResponse {
	return {
		ok: true,
		result: {
			sessionId: identity.sessionId,
			retired: true,
			ledgerState: "terminal_error",
			indexType: "session_closed",
			stateRoot: identity.stateRoot,
			endpointGeneration: identity.endpointGeneration,
			endpointMtimeMs: identity.endpointMtimeMs,
			...(identity.endpointFileId === undefined ? {} : { endpointFileId: identity.endpointFileId }),
			processIncarnation: identity.processIncarnation,
			hostIncarnation: identity.hostIncarnation,
			lifecycleRequestId: identity.lifecycleRequestId,
			remoteCreateKey: identity.remoteCreateKey,
			...(indexSeq === undefined ? {} : { indexSeq }),
		},
	};
}

function isLifecycleBrokerResponse(value: unknown): value is BrokerResponse {
	return (
		typeof value === "object" &&
		value !== null &&
		"ok" in value &&
		typeof (value as { ok?: unknown }).ok === "boolean"
	);
}

async function executeUncertainRetirement(
	broker: Broker,
	input: Input,
	identity: string,
	cleanup?: LifecycleRetirementCleanup,
): Promise<BrokerResponse> {
	const id = sessionId(input);
	if (!id) return fail("invalid_input", "sessionId is required.");
	if (!isCanonicalSessionId(id)) return fail("invalid_input", "sessionId must be a canonical safe identifier.");
	await broker.index.refresh();
	let receipt = cleanup?.uncertainRetirement;
	let record = findRetirementRecord(broker, id, receipt);
	if (!record) return fail("not_found", "session is not indexed");
	let retirementIdentity: LifecycleRetirementIdentity;
	let create = receipt ? broker.ledger.get(receipt.identity.createIdentity) : undefined;
	if (receipt) {
		const suppliedIdentity = retirementIdentityFromInput(input, record, receipt.identity.createIdentity);
		if (isLifecycleBrokerResponse(suppliedIdentity)) return suppliedIdentity;
		if (
			receipt.identity.sessionId !== id ||
			canonicalJson(suppliedIdentity) !== canonicalJson(receipt.identity) ||
			!sameRetirementIdentityAsRecord(receipt.identity, record)
		)
			return fail(
				"endpoint_stale",
				"Staged retirement identity no longer matches the indexed session authority.",
				cleanup,
			);
		retirementIdentity = suppliedIdentity;
		if (!create) return fail("terminal_uncertain", "Staged retirement create identity is no longer present.");
	} else {
		if (record.ambiguous || !isSessionAuthorityEligible(record))
			return fail("endpoint_stale", "Session authority is ambiguous and cannot be retired safely.");
		if (record.terminalUncertain !== true)
			return fail("invalid_input", "session.reconcile_uncertain only accepts terminalUncertain create rows.");
		const lifecycleRequestId = text(input.lifecycleRequestId);
		const remoteCreateKey = text(input.remoteCreateKey);
		if (remoteCreateKey === undefined)
			return fail("invalid_input", "remoteCreateKey must be a bounded non-empty string.");
		const matches = broker.ledger.listUncertainCreatesBySessionId(id, lifecycleRequestId, remoteCreateKey);
		if (matches.length === 0) {
			const markerCandidates = broker.ledger.listUncertainCreatesBySessionId(id, undefined, remoteCreateKey);
			if (markerCandidates.length === 1 && markerCandidates[0]!.effectMarker !== lifecycleRequestId)
				return fail(
					"retirement_proof_stale",
					"Retirement lifecycle marker does not match the indexed create identity before effect start.",
				);
			return fail("not_found", "No complete terminal_uncertain create identity matches this session.");
		}
		if (matches.length !== 1)
			return fail("terminal_uncertain", "Multiple terminal_uncertain create identities match this session.");
		create = matches[0]!;
		const proof = retirementIdentityFromInput(input, record, create.identity);
		if (isLifecycleBrokerResponse(proof)) return proof;
		retirementIdentity = proof;
		if (
			create.effectMarker !== retirementIdentity.lifecycleRequestId ||
			create.effectIntent?.sessionId !== id ||
			path.resolve(create.effectIntent.stateRoot) !== path.resolve(retirementIdentity.stateRoot)
		)
			return fail("terminal_uncertain", "Create ledger identity does not match the indexed lifecycle authority.");
		if (observeProcess(record.pid, retirementIdentity.hostIncarnation) !== "exited")
			return fail("terminal_uncertain", "Session host exit could not be proven.");
		if (!exactLifecycleEndpointAbsent(retirementIdentity.stateRoot, id))
			return fail("terminal_uncertain", "The indexed session endpoint still exists or is unsafe to inspect.");
		const planned = retirementCleanupPlan(retirementIdentity.stateRoot, id, create, retirementIdentity);
		if (isLifecycleBrokerResponse(planned)) return planned;
		cleanup = planned;
		await broker.ledger.transition(identity, "effect_started", {
			intendedSessionId: id,
			effectMarker: retirementIdentity.lifecycleRequestId,
			response: fail(
				"cleanup_pending",
				"Uncertain session retirement is staged for exact lifecycle cleanup.",
				cleanup,
			),
		});
		receipt = cleanup.uncertainRetirement;
	}

	if (!create || !receipt || !cleanup) return fail("terminal_uncertain", "Retirement receipt is incomplete.");
	if (create.state !== "terminal_uncertain" && !(create.state === "terminal_error" && receipt.stage === "ledger"))
		return fail("terminal_uncertain", "Create ledger identity is no longer an uncertain retirement candidate.");
	if (receipt.stage === "cleanup") {
		if (cleanup.lifecycleFiles?.length) {
			const cleanupResponse = await reconcileLifecycleCleanup(
				broker,
				identity,
				cleanup,
				fail("cleanup_pending", "Uncertain session retirement cleanup remains staged.", cleanup),
			);
			if (!cleanupResponse.ok && cleanupResponse.error.code !== "cleanup_pending") return cleanupResponse;
			const persisted =
				retirementCleanupFromResponse(cleanupResponse) ??
				retirementCleanupFromResponse(broker.ledger.get(identity)?.response);
			if (!persisted || !retirementCleanupSettled(persisted)) return cleanupResponse;
			cleanup = persisted;
		}
		if (!exactLifecycleEndpointAbsent(retirementIdentity.stateRoot, id))
			return fail(
				"cleanup_pending",
				"Uncertain session retirement is pending because the endpoint reappeared.",
				cleanup,
			);
		for (const candidate of [
			lifecycleMarkerPath(retirementIdentity.stateRoot, id),
			lifecycleReadyPath(retirementIdentity.stateRoot, id),
		]) {
			if (!exactLifecycleEndpointAbsent(retirementIdentity.stateRoot, id))
				return fail(
					"cleanup_pending",
					"Uncertain session retirement is pending because lifecycle authority reappeared.",
					cleanup,
				);
			try {
				if (fsSync.lstatSync(candidate))
					return fail(
						"cleanup_pending",
						"Uncertain session retirement is pending because lifecycle authority reappeared.",
						cleanup,
					);
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "ENOENT")
					return fail(
						"cleanup_pending",
						"Uncertain session retirement could not prove lifecycle authority absence.",
						cleanup,
					);
			}
		}
		if (!retirementCleanupParentMatches(cleanup))
			return fail(
				"cleanup_pending",
				"Uncertain session retirement is pending because the lifecycle parent identity changed.",
				cleanup,
			);
		const staged: LifecycleRetirementCleanup = {
			...cleanup,
			uncertainRetirement: { ...receipt, stage: "index" },
		};
		await broker.ledger.transition(identity, "effect_started", {
			intendedSessionId: id,
			response: fail("cleanup_pending", "Uncertain session retirement is staged before index closure.", staged),
		});
		cleanup = staged;
		receipt = staged.uncertainRetirement;
	}
	if (!retirementCleanupSettled(cleanup))
		return fail(
			"cleanup_pending",
			"Uncertain session retirement is pending because lifecycle cleanup is not durably settled.",
			cleanup,
		);

	await broker.index.refresh();
	record = findRetirementRecord(broker, id, receipt);
	if (!record || !sameRetirementIdentityAsRecord(retirementIdentity, record))
		return fail("endpoint_stale", "Session authority changed before retirement index closure.", cleanup);
	if (!exactLifecycleEndpointAbsent(retirementIdentity.stateRoot, id))
		return fail(
			"cleanup_pending",
			"Uncertain session retirement is pending because the endpoint reappeared.",
			cleanup,
		);
	if (!retirementCleanupParentMatches(cleanup))
		return fail(
			"cleanup_pending",
			"Uncertain session retirement is pending because the lifecycle parent identity changed.",
			cleanup,
		);
	if (
		receipt.stage === "ledger" &&
		(!receipt.indexSeq ||
			!record.terminal ||
			record.indexSeq < receipt.indexSeq ||
			broker.index.findSessionClosedEvidence(record) === undefined)
	)
		return fail(
			"terminal_uncertain",
			"Uncertain session retirement ledger replay lacks the durable session_closed index proof.",
			cleanup,
		);
	if (receipt.stage === "index") {
		let indexSeq = receipt.indexSeq;
		const sessionClosedEvidence = broker.index.findSessionClosedEvidence(record);
		if (sessionClosedEvidence !== undefined) indexSeq ??= sessionClosedEvidence;
		else if (broker.index.findSessionTerminalEvidence(record)?.type === "session_deleted")
			return fail(
				"terminal_uncertain",
				"Uncertain session retirement cannot certify session closure after a deletion tombstone.",
				cleanup,
			);
		else {
			try {
				await broker.index.append({
					type: "session_closed",
					sessionId: id,
					locator: record.locator,
					endpointGeneration: record.endpointGeneration,
					pid: record.pid,
					...(record.processIncarnation === undefined ? {} : { processIncarnation: record.processIncarnation }),
					...(record.hostIncarnation === undefined ? {} : { hostIncarnation: record.hostIncarnation }),
					...(record.endpointMtimeMs === undefined ? {} : { endpointMtimeMs: record.endpointMtimeMs }),
					...(record.endpointFileId === undefined ? {} : { endpointFileId: record.endpointFileId }),
					...(record.lifecycleRequestId === undefined ? {} : { lifecycleRequestId: record.lifecycleRequestId }),
				});
				const verifiedIndexSeq = broker.index.findSessionClosedEvidence(record);
				if (verifiedIndexSeq === undefined)
					return fail(
						"terminal_uncertain",
						"Uncertain session retirement could not verify the appended session closure against the current index.",
						cleanup,
					);
				indexSeq = verifiedIndexSeq;
			} catch {
				return fail("cleanup_pending", "Uncertain session retirement is staged before index closure.", cleanup);
			}
		}
		const staged: LifecycleRetirementCleanup = {
			...cleanup,
			uncertainRetirement: { ...receipt, stage: "ledger", ...(indexSeq === undefined ? {} : { indexSeq }) },
		};
		try {
			await broker.ledger.transition(identity, "effect_started", {
				intendedSessionId: id,
				response: fail("cleanup_pending", "Uncertain session retirement is staged before ledger closure.", staged),
			});
		} catch {
			return fail("cleanup_pending", "Uncertain session retirement remains staged after index closure.", staged);
		}
		cleanup = staged;
		receipt = staged.uncertainRetirement;
	}

	if (create.state !== "terminal_error") {
		try {
			await broker.ledger.transition(create.identity, "terminal_error", {
				intendedSessionId: id,
				response: fail("terminal_uncertain", "Uncertain create retired after exact identity proof."),
			});
		} catch {
			return fail("cleanup_pending", "Uncertain session retirement remains staged after index closure.", cleanup);
		}
	}
	return retirementProof(retirementIdentity, receipt.indexSeq);
}

function validateLifecycleCleanupFile(root: string, id: string, file: LifecycleCleanupFile): boolean {
	const directory = path.join(path.resolve(root), "sdk");
	const original = path.resolve(file.path);
	const planned = path.resolve(file.plannedPath);
	if (
		!isCanonicalLifecycleCleanupOriginal(root, id, original) ||
		path.dirname(planned) !== directory ||
		!path.basename(planned).startsWith(".gjc-delete-") ||
		(file.detachedPath !== undefined && path.dirname(path.resolve(file.detachedPath)) !== directory)
	)
		return false;
	return isCleanupIdentity(file.identity);
}

function lifecycleCleanupCandidates(file: LifecycleCleanupFile): string[] {
	return [file.path, file.detachedPath, file.plannedPath].filter(
		(value, index, values): value is string => typeof value === "string" && values.indexOf(value) === index,
	);
}

function lifecycleMetadataReplayFiles(cleanup: CleanupEvidence): LifecycleCleanupFile[] | undefined {
	if (cleanup.lifecycleDeleteMetadata !== true) return undefined;
	return cleanup.lifecycleFiles?.length ? cleanup.lifecycleFiles : undefined;
}

function isLifecycleCleanupResponse(value: LifecycleFileCapture | BrokerResponse | undefined): value is BrokerResponse {
	return typeof value === "object" && value !== null && "ok" in value;
}

function validateLifecycleMetadataReplay(cleanup: CleanupEvidence): BrokerResponse | undefined {
	const files = lifecycleMetadataReplayFiles(cleanup);
	if (!files) return undefined;
	const root = path.resolve(cleanup.metadataRoot!);
	const id = cleanup.sessionId!;
	const markerPath = lifecycleMarkerPath(root, id);
	const readyPath = lifecycleReadyPath(root, id);
	const authorities = new Set<string>();
	const candidates = new Set<string>();
	for (const file of files) {
		const authority = path.resolve(file.path);
		if ((authority !== markerPath && authority !== readyPath) || authorities.has(authority))
			return fail("terminal_uncertain", "Lifecycle metadata replay contains duplicate or non-canonical authority.");
		authorities.add(authority);
		for (const candidate of lifecycleCleanupCandidates(file)) {
			const resolved = path.resolve(candidate);
			if (candidates.has(resolved))
				return fail("terminal_uncertain", "Lifecycle metadata replay contains duplicate candidate authority.");
			candidates.add(resolved);
		}
	}
	const markerEntry = files.find(file => path.resolve(file.path) === markerPath);
	const readyEntry = files.find(file => path.resolve(file.path) === readyPath);
	const capture = (file: string): LifecycleFileCapture | undefined | BrokerResponse => {
		try {
			return captureLifecycleFile(file, true, true);
		} catch {
			return fail("terminal_uncertain", "Lifecycle metadata sibling could not be safely inspected.");
		}
	};
	const marker = capture(markerPath);
	const ready = capture(readyPath);
	if (isLifecycleCleanupResponse(marker)) return marker;
	if (isLifecycleCleanupResponse(ready)) return ready;
	if (marker && (!markerEntry || !sameLifecycleCleanupIdentity(marker.identity, markerEntry.identity)))
		return fail("terminal_uncertain", "Lifecycle marker sibling lacks exact replay authority.");
	if (ready && (!readyEntry || !sameLifecycleCleanupIdentity(ready.identity, readyEntry.identity)))
		return fail("terminal_uncertain", "Lifecycle readiness sibling lacks exact replay authority.");
	for (const file of files) {
		let activeCandidates = 0;
		for (const candidate of lifecycleCleanupCandidates(file)) {
			let current: LifecycleFileCapture | undefined;
			try {
				current = captureLifecycleFile(candidate, true, true);
			} catch {
				if (
					file.completed &&
					[file.detachedPath, file.plannedPath].some(
						bound => bound && path.resolve(candidate) === path.resolve(bound),
					)
				) {
					try {
						const stat = fsSync.lstatSync(candidate);
						if (stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1 && stat.size === 0) continue;
					} catch (error) {
						if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
					}
				}
				return fail("terminal_uncertain", "Lifecycle metadata candidate could not be safely inspected.");
			}
			if (!current) continue;
			if (!sameLifecycleCleanupIdentity(current.identity, file.identity))
				return fail("terminal_uncertain", "Lifecycle metadata candidate lacks exact replay authority.");
			// A completed file's recorded retained quarantine is receipt-bound durable
			// evidence; anything else that remains is an active survivor.
			if (file.completed && file.detachedPath && path.resolve(candidate) === path.resolve(file.detachedPath))
				continue;
			activeCandidates++;
		}
		if (file.completed && activeCandidates > 0)
			return fail(
				"terminal_uncertain",
				"Lifecycle cleanup receipt marks a metadata target complete while a candidate remains.",
			);
		if (!file.completed && activeCandidates > 1)
			return fail("terminal_uncertain", "Lifecycle metadata replay has multiple active candidates.");
	}
	if (ready && !markerEntry)
		return fail("terminal_uncertain", "Lifecycle readiness metadata lacks canonical marker authority.");
	if (!ready) return undefined;
	let readyMarker: EffectMarker;
	try {
		const value: unknown = parseLifecycleJson(ready.bytes);
		if (!isExactEffectMarker(value)) throw new Error("invalid ready marker");

		readyMarker = value;
	} catch {
		return fail("terminal_uncertain", "Lifecycle readiness metadata ownership could not be verified.");
	}
	if (!markerEntry)
		return fail("terminal_uncertain", "Lifecycle readiness metadata lacks canonical marker authority.");
	if (!marker) {
		if (createHash("sha256").update(ready.bytes).digest("hex") !== markerEntry.identity.sha256)
			return fail(
				"terminal_uncertain",
				"Lifecycle readiness metadata is not bound to the completed marker authority.",
			);
		return undefined;
	}
	try {
		const value: unknown = parseLifecycleJson(marker.bytes);
		if (!isExactEffectMarker(value) || !sameEffectMarker(value, readyMarker)) throw new Error("mismatched marker");
	} catch {
		return fail("terminal_uncertain", "Lifecycle metadata siblings do not share one owner marker.");
	}
	return undefined;
}

/**
 * Base dev persisted metadata cleanup one file at a time. Accept only its
 * identity-bound marker receipt and translate it into the current replay plan.
 */
function hasExactLegacyMetadataCleanupKeys(cleanup: CleanupEvidence): boolean {
	if (typeof cleanup !== "object" || cleanup === null || Array.isArray(cleanup)) return false;
	const allowed = new Set([
		"phase",
		"sessionId",
		"metadataRoot",
		"metadataIdentity",
		"metadataPath",
		"metadataAttempt",
		"plannedMetadataPath",
		"detachedMetadataPath",
		"metadataCompleted",
	]);
	return Object.keys(cleanup as Record<string, unknown>).every(key => allowed.has(key));
}

function legacyMetadataCleanupPlan(cleanup: CleanupEvidence): CleanupEvidence | undefined {
	if (
		!hasExactLegacyMetadataCleanupKeys(cleanup) ||
		cleanup.phase !== "metadata" ||
		typeof cleanup.sessionId !== "string" ||
		!isCanonicalSessionId(cleanup.sessionId) ||
		typeof cleanup.metadataRoot !== "string" ||
		cleanup.metadataRoot.length === 0 ||
		typeof cleanup.metadataPath !== "string" ||
		cleanup.metadataPath.length === 0 ||
		!cleanup.metadataIdentity ||
		typeof cleanup.plannedMetadataPath !== "string" ||
		cleanup.plannedMetadataPath.length === 0 ||
		(cleanup.detachedMetadataPath !== undefined &&
			(typeof cleanup.detachedMetadataPath !== "string" || cleanup.detachedMetadataPath.length === 0)) ||
		(cleanup.metadataCompleted !== undefined && cleanup.metadataCompleted !== true)
	)
		return undefined;
	const root = path.resolve(cleanup.metadataRoot);
	const directory = path.join(root, "sdk");
	const parentIdentity = lifecycleParentIdentity(directory);
	if (!parentIdentity) return undefined;
	const markerPath = lifecycleMarkerPath(root, cleanup.sessionId);
	const readyPath = lifecycleReadyPath(root, cleanup.sessionId);
	const metadataPath = path.resolve(cleanup.metadataPath);
	const plannedPath = path.resolve(cleanup.plannedMetadataPath);
	const detachedPath = cleanup.detachedMetadataPath && path.resolve(cleanup.detachedMetadataPath);
	if (
		metadataPath !== markerPath ||
		path.dirname(plannedPath) !== directory ||
		!path.basename(plannedPath).startsWith(".gjc-delete-") ||
		(detachedPath !== undefined && path.dirname(detachedPath) !== directory) ||
		(cleanup.metadataAttempt !== undefined &&
			(!Number.isSafeInteger(cleanup.metadataAttempt) || cleanup.metadataAttempt < 1))
	)
		return undefined;
	const persistedIdentity = cleanupIdentity(cleanup.metadataIdentity, false, false);
	if (!persistedIdentity) return undefined;

	const captureExactRegular = (
		file: string,
	): { kind: "absent" } | { kind: "present"; capture: LifecycleFileCapture } | undefined => {
		try {
			const stat = fsSync.lstatSync(file);
			if (stat.isSymbolicLink() || !stat.isFile()) return undefined;
			const capture = captureLifecycleFile(file, true, true);

			return capture ? { kind: "present", capture } : undefined;
		} catch (error) {
			return (error as NodeJS.ErrnoException).code === "ENOENT" ? { kind: "absent" } : undefined;
		}
	};

	const markerCandidates = [metadataPath, detachedPath, plannedPath].filter(
		(candidate, index, candidates): candidate is string =>
			typeof candidate === "string" && candidates.indexOf(candidate) === index,
	);
	let activeMarker: LifecycleFileCapture | undefined;
	for (const candidate of markerCandidates) {
		const current = captureExactRegular(candidate);
		if (!current) return undefined;
		if (current.kind === "absent") continue;
		if (!sameLifecycleCleanupIdentity(current.capture.identity, serializeCleanupIdentity(persistedIdentity)))
			return undefined;
		if (activeMarker) return undefined;
		activeMarker = current.capture;
	}
	const markerCompleted = !activeMarker;
	// Legacy receipts can crash after exact marker unlink and before recording metadataCompleted.
	// With every authorized marker candidate absent, only the persisted marker digest may bind a ready sibling.
	let marker: EffectMarker | undefined;
	if (activeMarker) {
		try {
			const value: unknown = parseLifecycleJson(activeMarker.bytes);
			if (!isExactEffectMarker(value)) return undefined;

			marker = value;
		} catch {
			return undefined;
		}
	}

	const ready = captureExactRegular(readyPath);
	if (!ready) return undefined;
	let readyMarker: EffectMarker | undefined;
	if (ready.kind === "present") {
		try {
			const value: unknown = parseLifecycleJson(ready.capture.bytes);
			if (!isExactEffectMarker(value)) return undefined;

			readyMarker = value;
		} catch {
			return undefined;
		}
		if (marker && !sameEffectMarker(marker, readyMarker)) return undefined;
		if (!marker && createHash("sha256").update(ready.capture.bytes).digest("hex") !== persistedIdentity.sha256)
			return undefined;
	}

	return {
		phase: "lifecycle",
		sessionId: cleanup.sessionId,
		metadataRoot: root,
		lifecycleDeleteMetadata: true,
		lifecycleParentIdentity: parentIdentity,
		lifecycleFiles: [
			{
				path: metadataPath,
				identity: serializeCleanupIdentity({
					...(activeMarker?.identity ?? persistedIdentity),
					size: Number((activeMarker?.identity ?? persistedIdentity).size),
				}),
				attempt: cleanup.metadataAttempt ?? 1,
				plannedPath,
				...(detachedPath ? { detachedPath } : {}),
				...(markerCompleted ? { completed: true as const } : {}),
			},
			...(ready.kind === "present"
				? [
						{
							path: readyPath,
							identity: serializeCleanupIdentity({
								...ready.capture.identity,
								size: Number(ready.capture.identity.size),
							}),
							attempt: 1,
							plannedPath: path.join(directory, `.gjc-delete-${randomUUID()}-${path.basename(readyPath)}`),
						},
					]
				: []),
		],
	};
}

function lifecycleDeleteMetadataCleanupPlan(
	metadataRoot: string,
	id: string,
	files: ReadonlyArray<{ metadataPath: string; metadata: LifecycleFileCapture }>,
): CleanupEvidence {
	if (files.length === 0)
		return {
			phase: "lifecycle",
			sessionId: id,
			metadataRoot,
			lifecycleDeleteMetadata: true,
			lifecycleFiles: [],
		};
	const parentIdentity = lifecycleParentIdentity(path.join(metadataRoot, "sdk"));
	if (!parentIdentity) throw new Error("Lifecycle cleanup parent identity is unavailable.");
	return {
		phase: "lifecycle",
		sessionId: id,
		metadataRoot,
		lifecycleDeleteMetadata: true,
		lifecycleParentIdentity: parentIdentity,
		lifecycleFiles: files.map(({ metadataPath, metadata }) => ({
			path: metadataPath,
			identity: serializeCleanupIdentity({
				dev: metadata.identity.dev,
				ino: metadata.identity.ino,
				nlink: metadata.identity.nlink,
				size: Number(metadata.identity.size),
				mtimeNs: metadata.identity.mtimeNs,
				sha256: metadata.identity.sha256,
			}),
			attempt: 1,
			plannedPath: path.join(
				path.dirname(metadataPath),
				`.gjc-delete-${randomUUID()}-${path.basename(metadataPath)}`,
			),
		})),
	};
}

type LifecycleDeleteMetadataPreflight = { cleanup: CleanupEvidence } | BrokerResponse;

/**
 * Capture lifecycle metadata before deleting any saved user data. A fresh delete
 * may only clean metadata owned by one dead lifecycle process.
 */
function preflightLifecycleDeleteMetadata(
	root: string,
	id: string,
	record: { pid: number } | undefined,
	readIncarnation: (pid: number) => string | undefined,
): LifecycleDeleteMetadataPreflight {
	const metadataPaths = [lifecycleMarkerPath(root, id), lifecycleReadyPath(root, id)];
	const lifecycleMetadata: Array<{
		metadataPath: string;
		metadata: LifecycleFileCapture;
		marker: EffectMarker;
	}> = [];
	for (const metadataPath of metadataPaths) {
		let metadata: LifecycleFileCapture | undefined;
		try {
			metadata = captureLifecycleFile(metadataPath, true, true);
		} catch {
			return fail("terminal_uncertain", "Lifecycle metadata path is occupied by an unsafe object.");
		}
		if (!metadata) continue;
		let marker: unknown;
		try {
			marker = parseLifecycleJson(metadata.bytes);
		} catch {
			return fail("terminal_uncertain", "Lifecycle metadata ownership could not be verified.");
		}
		if (
			!isExactEffectMarker(marker) ||
			(record && marker.pid !== record.pid) ||
			observeProcess(marker.pid, marker.incarnation, readIncarnation) !== "exited"
		)
			return fail("terminal_uncertain", "Lifecycle metadata ownership could not be verified.");
		lifecycleMetadata.push({ metadataPath, metadata, marker });
	}
	const canonicalLifecycleMarker = lifecycleMetadata.find(
		metadata => metadata.metadataPath === lifecycleMarkerPath(root, id),
	);
	const lifecycleReadyMarker = lifecycleMetadata.find(
		metadata => metadata.metadataPath === lifecycleReadyPath(root, id),
	);
	if (lifecycleReadyMarker && !canonicalLifecycleMarker)
		return fail(
			"terminal_uncertain",
			"Lifecycle readiness metadata lacks canonical marker authority for fresh cleanup.",
		);
	if (
		canonicalLifecycleMarker &&
		lifecycleReadyMarker &&
		!sameEffectMarker(canonicalLifecycleMarker.marker, lifecycleReadyMarker.marker)
	)
		return fail("terminal_uncertain", "Lifecycle metadata siblings do not share one owner marker.");
	return { cleanup: lifecycleDeleteMetadataCleanupPlan(root, id, lifecycleMetadata) };
}

async function reconcileLifecycleCleanup(
	broker: Broker,
	identity: string,
	cleanup: CleanupEvidence,
	completion: BrokerResponse = fail("spawn_failed", "No ready SDK endpoint remains available."),
	proofBudget?: LifecycleProofBudget,
): Promise<BrokerResponse> {
	if (!lifecycleProofWithinDeadline(proofBudget))
		return fail("terminal_uncertain", "Lifecycle cleanup proof exceeded its cleanup deadline.", cleanup);
	const shapeValidation = validateLifecycleCleanupShape(cleanup);
	if (shapeValidation) return shapeValidation;
	let activeCleanup =
		cleanup.lifecycleDeleteMetadata === true || completion.ok
			? { ...cleanup, lifecycleDeleteMetadata: true as const }
			: cleanup;
	const metadataReplayValidation = validateLifecycleMetadataReplay(activeCleanup);
	if (metadataReplayValidation) return metadataReplayValidation;
	const deadlineFailure = (): BrokerResponse =>
		fail("terminal_uncertain", "Lifecycle cleanup proof exceeded its cleanup deadline.", activeCleanup);
	for (let index = 0; index < activeCleanup.lifecycleFiles!.length; index++) {
		if (!lifecycleProofWithinDeadline(proofBudget)) return deadlineFailure();
		const file = activeCleanup.lifecycleFiles![index];
		if (!validateLifecycleCleanupFile(activeCleanup.metadataRoot!, activeCleanup.sessionId!, file))
			return fail("terminal_uncertain", "Lifecycle cleanup replay contains an invalid path authority.");
		if (!lifecycleProofWithinDeadline(proofBudget)) return deadlineFailure();
		const candidates = lifecycleCleanupCandidates(file);
		if (file.completed) {
			for (const candidate of candidates) {
				let stat: ReturnType<typeof fsSync.lstatSync>;
				try {
					stat = fsSync.lstatSync(candidate);
				} catch (error) {
					if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
					return fail("terminal_uncertain", "Lifecycle cleanup completion could not be safely inspected.");
				}
				// A completed file's recorded retained quarantine is durable evidence,
				// not a survivor — accept it only at its receipt-bound path and identity.
				if (
					file.detachedPath &&
					path.resolve(candidate) === path.resolve(file.detachedPath) &&
					stat.isFile() &&
					!stat.isSymbolicLink() &&
					stat.nlink === 1 &&
					stat.size === 0
				)
					continue;
				return fail(
					"terminal_uncertain",
					"Lifecycle cleanup receipt marks a target complete while an authorized candidate remains.",
				);
			}
			if (!lifecycleProofWithinDeadline(proofBudget)) return deadlineFailure();
			continue;
		}
		let activePath: string | undefined;
		let captured: LifecycleFileCapture | undefined;
		let foundUnauthorized = false;
		for (const candidate of candidates) {
			if (!lifecycleProofWithinDeadline(proofBudget)) return deadlineFailure();
			if (path.resolve(candidate) !== path.resolve(file.path)) {
				try {
					const quarantineStat = fsSync.lstatSync(candidate, { bigint: true });
					if (quarantineStat.isFile() && quarantineStat.size === 0n) continue;
				} catch (error) {
					if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
				}
			}
			try {
				const stat = fsSync.lstatSync(candidate);
				if (stat.isSymbolicLink() || !stat.isFile()) {
					foundUnauthorized = true;
					continue;
				}
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
				foundUnauthorized = true;
				continue;
			}
			const current = captureLifecycleFile(candidate, true, true);
			if (!lifecycleProofWithinDeadline(proofBudget)) return deadlineFailure();

			if (!current) {
				foundUnauthorized = true;
				continue;
			}
			if (sameLifecycleCleanupIdentity(current.identity, file.identity) && !activePath) {
				activePath = candidate;
				captured = current;
			} else {
				foundUnauthorized = true;
			}
		}
		if (foundUnauthorized)
			return fail("terminal_uncertain", "Lifecycle cleanup target identity changed before reconciliation.");
		if (!captured || !activePath) {
			const lifecycleFiles = activeCleanup.lifecycleFiles!.map((candidate, candidateIndex) =>
				candidateIndex === index ? { ...candidate, completed: true as const } : candidate,
			);
			activeCleanup = { ...activeCleanup, lifecycleFiles };
			await broker.ledger.transition(identity, "effect_started", {
				response: fail("cleanup_pending", "Lifecycle cleanup completion was durably reconciled.", activeCleanup),
			});
			if (!lifecycleProofWithinDeadline(proofBudget)) return deadlineFailure();
			continue;
		}

		if (file.detachedPath || activePath === file.plannedPath) {
			const nextFile: LifecycleCleanupFile = {
				...file,
				detachedPath: activePath,
				attempt: (file.attempt ?? 1) + 1,
				plannedPath: path.join(path.dirname(file.path), `.gjc-delete-${randomUUID()}-${path.basename(file.path)}`),
			};
			const lifecycleFiles = activeCleanup.lifecycleFiles!.map((candidate, candidateIndex) =>
				candidateIndex === index ? nextFile : candidate,
			);
			activeCleanup = { ...activeCleanup, lifecycleFiles };
			await broker.ledger.transition(identity, "effect_started", {
				response: fail(
					"cleanup_pending",
					"Lifecycle retry cleanup is preauthorized for durable reconciliation.",
					activeCleanup,
				),
			});
			if (!lifecycleProofWithinDeadline(proofBudget)) return deadlineFailure();
		}
		const currentFile = activeCleanup.lifecycleFiles![index];
		if (!lifecycleProofWithinDeadline(proofBudget)) return deadlineFailure();
		const result = nativeLifecycle().exactUnlink(activePath, {
			...captured.identity,
			parentDev: BigInt(activeCleanup.lifecycleParentIdentity!.dev),
			parentIno: BigInt(activeCleanup.lifecycleParentIdentity!.ino),
			quarantineName: path.basename(currentFile.plannedPath),
		});
		if (!lifecycleProofWithinDeadline(proofBudget)) return deadlineFailure();
		if (!result.ok) {
			if (result.code === "cleanup_pending" && result.detachedPath === currentFile.plannedPath) {
				// Typed retained authority: the native verified the exact identity-bound
				// detach and retained the quarantine as durable evidence. Record the
				// evidence and advance — never claim a terminal byte deletion.
				const lifecycleFiles = activeCleanup.lifecycleFiles!.map((candidate, candidateIndex) =>
					candidateIndex === index
						? { ...candidate, detachedPath: result.detachedPath, completed: true as const }
						: candidate,
				);
				activeCleanup = { ...activeCleanup, lifecycleFiles };
				await broker.ledger.transition(identity, "effect_started", {
					response: fail("cleanup_pending", "Lifecycle cleanup completion was durably reconciled.", activeCleanup),
				});
				lifecycleCleanupHooksForTest.get(broker)?.();
				if (!lifecycleProofWithinDeadline(proofBudget)) return deadlineFailure();
				continue;
			}
			const lifecycleFiles = activeCleanup.lifecycleFiles!.map((candidate, candidateIndex) =>
				candidateIndex === index && result.detachedPath
					? { ...candidate, detachedPath: result.detachedPath }
					: candidate,
			);
			return fail("cleanup_pending", `Lifecycle cleanup remains pending: ${result.code ?? "unknown"}`, {
				...activeCleanup,
				lifecycleFiles,
			});
		}
		const lifecycleFiles = activeCleanup.lifecycleFiles!.map((candidate, candidateIndex) =>
			candidateIndex === index ? { ...candidate, detachedPath: undefined, completed: true as const } : candidate,
		);
		activeCleanup = { ...activeCleanup, lifecycleFiles };
		await broker.ledger.transition(identity, "effect_started", {
			response: fail("cleanup_pending", "Lifecycle cleanup completion was durably reconciled.", activeCleanup),
		});
		lifecycleCleanupHooksForTest.get(broker)?.();
		if (!lifecycleProofWithinDeadline(proofBudget)) return deadlineFailure();
	}
	await syncDirectory(path.join(activeCleanup.metadataRoot!, "sdk"));
	if (!lifecycleProofWithinDeadline(proofBudget)) return deadlineFailure();
	return completion;
}

async function readSessionLifecycleFailure(
	root: string,
	id: string,
	expected: EffectMarker,
): Promise<LifecycleFailureArtifact | undefined> {
	return (await readLifecycleFailureArtifact(lifecycleFailurePath(root, id, expected.effectMarker), expected))
		?.artifact;
}

export async function readSessionLifecycleFailureForTest(
	root: string,
	id: string,
	expected: { pid: number; effectMarker: string; incarnation: string },
): Promise<SdkStartupFailure | undefined> {
	const artifact = await readSessionLifecycleFailure(root, id, expected);
	return artifact
		? {
				phase: artifact.phase,
				reason: artifact.reason,
				message: artifact.message,
				...(artifact.code === undefined ? {} : { code: artifact.code, details: artifact.details }),
			}
		: undefined;
}

/** Everything a signal target must prove about itself before it can be signalled. */
type SignalTarget = {
	locator: { stateRoot: string };
	pid: number;
	lifecycleRequestId?: string;
	processIncarnation?: string;
};

/**
 * The spawn-time marker is the strongest evidence — the broker itself wrote it for
 * exactly this pid — but it lives in the session's own workspace state root. A
 * workspace deleted while its host keeps running takes that evidence with it, and
 * the host then survives every later `session.close` as an orphan still serving the
 * source it started with. The registration its host published into the broker-owned
 * index carries the same pid-to-incarnation binding, outlives the workspace, and is
 * therefore consulted when the marker is absent. A marker naming a different process
 * is contradiction rather than absence and still refuses the signal, and either
 * source is only accepted while the pid's current OS incarnation still matches it.
 */
async function hasDurableProcessIdentity(target: SignalTarget, id: string, expected?: EffectMarker): Promise<boolean> {
	const marker = await readEffectMarker(lifecycleMarkerPath(target.locator.stateRoot, id));
	if (marker)
		return (
			marker.pid === target.pid &&
			(!expected || sameEffectMarker(marker, expected)) &&
			marker.incarnation === processIncarnation(target.pid)
		);
	if (expected && (expected.pid !== target.pid || target.lifecycleRequestId !== expected.effectMarker)) return false;
	return target.processIncarnation !== undefined && target.processIncarnation === processIncarnation(target.pid);
}

async function hasOwnedReadinessEvidence(
	broker: Broker,
	root: string,
	id: string,
	expected: EffectMarker,
): Promise<boolean> {
	if (
		observeProcess(expected.pid, expected.incarnation, value => processIncarnationForBroker(broker, value)) !==
		"alive"
	)
		return false;
	const [effect, ready] = await Promise.all([
		readEffectMarker(lifecycleMarkerPath(root, id)),
		readEffectMarker(lifecycleReadyPath(root, id)),
	]);
	return (
		effect !== undefined &&
		ready !== undefined &&
		sameEffectMarker(effect, expected) &&
		sameEffectMarker(ready, expected)
	);
}

/**
 * Typed ready-then-exit probe for a dead child (#4712 review: the earlier
 * boolean collapsed EACCES/EIO/malformed JSON into "absent", routing the
 * teardown decision through the secondary authority and finally surfacing as
 * a false `spawn_failed` claim that the child "exited before registering
 * readiness" when the real failure was reading the endpoint).
 *
 * A host that died hard leaves its endpoint file on disk; a host that tore
 * down gracefully removed it first. `matched` requires the owned marker +
 * ready marker chain to still name exactly this child and the endpoint file
 * to still name the same pid and session. `absent_indexed` means the endpoint
 * file is gone (ENOENT only) and the broker's own session index recorded a
 * host registration for exactly this incarnation — the sole permitted
 * fallback authority. `malformed` and `io_error` are their own fail-closed
 * outcomes: they feed no teardown decision and assert nothing about the
 * child process.
 */
type ReadyAuthorityProbe =
	| { kind: "matched" }
	| { kind: "absent_indexed" }
	| { kind: "absent_unindexed" }
	| { kind: "not_published" }
	| { kind: "malformed" }
	| { kind: "io_error"; code: string };

async function probePublishedReadyAuthority(
	root: string,
	id: string,
	expected: EffectMarker,
	index?: BrokerIndex,
): Promise<ReadyAuthorityProbe> {
	const [effect, ready] = await Promise.all([
		readEffectMarker(lifecycleMarkerPath(root, id)),
		readEffectMarker(lifecycleReadyPath(root, id)),
	]);
	if (!effect || !ready || !sameEffectMarker(effect, expected) || !sameEffectMarker(ready, expected))
		return { kind: "not_published" };
	let endpointText: string;
	try {
		endpointText = await fs.readFile(path.join(root, "sdk", `${id}.json`), "utf8");
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code;
		// Only a missing endpoint means "gracefully removed"; anything else
		// (EACCES, EIO, ...) is its own condition and must not silently route the
		// teardown decision to the secondary authority.
		if (code !== "ENOENT") return { kind: "io_error", code: code ?? "unknown" };
		if (!index) return { kind: "absent_unindexed" };
		const sessionIndex = index.index;
		await sessionIndex.refresh();
		return sessionIndex
			.listSessions()
			.sessions.some(
				session =>
					session.sessionId === id &&
					session.pid === expected.pid &&
					(session.hostIncarnation ?? session.processIncarnation) === expected.incarnation,
			)
			? { kind: "absent_indexed" }
			: { kind: "absent_unindexed" };
	}
	let endpoint: { sessionId?: unknown; pid?: unknown };
	try {
		endpoint = JSON.parse(endpointText) as { sessionId?: unknown; pid?: unknown };
	} catch {
		return { kind: "malformed" };
	}
	return endpoint.pid === expected.pid && endpoint.sessionId === id ? { kind: "matched" } : { kind: "not_published" };
}

/** Test seam for the typed ready-authority probe boundary (#4712 review). */
export async function probePublishedReadyAuthorityForTest(
	root: string,
	id: string,
	expected: EffectMarker,
): Promise<ReadyAuthorityProbe> {
	return probePublishedReadyAuthority(root, id, expected);
}

/** Human-readable, honest description of a fail-closed probe outcome. */
function describeReadyProbeFailure(probe: ReadyAuthorityProbe): string {
	return probe.kind === "io_error" ? `endpoint read failed (${probe.code})` : "endpoint file is malformed";
}

type LifecycleFileCapture = {
	bytes: Buffer;
	identity: { dev: bigint; ino: bigint; size: bigint; mtimeNs: bigint; sha256: string; nlink: bigint };
	digest: string;
};

/**
 * Identity-bound receipt for the three durable retirement boundaries.  This is
 * carried inside the ordinary lifecycle cleanup response so a broker restart
 * enters the same replay path as every other identity-bound cleanup receipt.
 * It is deliberately credential-free and bounded: it contains only the
 * indexed process/session identity and the ledger/index stage.
 */
type LifecycleRetirementIdentity = {
	sessionId: string;
	stateRoot: string;
	endpointGeneration: number;
	endpointMtimeMs: number;
	endpointFileId?: string;
	pid: number;
	processIncarnation: string;
	hostIncarnation: string;
	lifecycleRequestId: string;
	createIdentity: string;
	remoteCreateKey?: string;
};

type LifecycleRetirementStage = "cleanup" | "index" | "ledger";

type LifecycleRetirementReceipt = {
	version: 1;
	stage: LifecycleRetirementStage;
	identity: LifecycleRetirementIdentity;
	indexSeq?: number;
};

type LifecycleRetirementCleanup = CleanupEvidence & {
	uncertainRetirement: LifecycleRetirementReceipt;
};

function boundedRetirementString(value: unknown, max: number): value is string {
	return typeof value === "string" && value.length > 0 && value.length <= max && !/[\u0000-\u001f\u007f]/.test(value);
}

function isLifecycleRetirementIdentity(value: unknown): value is LifecycleRetirementIdentity {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
	const identity = value as Record<string, unknown>;
	const keys = Object.keys(identity);
	if (
		keys.some(
			key =>
				!new Set([
					"sessionId",
					"stateRoot",
					"endpointGeneration",
					"endpointMtimeMs",
					"endpointFileId",
					"pid",
					"processIncarnation",
					"hostIncarnation",
					"lifecycleRequestId",
					"createIdentity",
					"remoteCreateKey",
				]).has(key),
		)
	) {
		return false;
	}
	const stateRoot = identity.stateRoot;
	if (typeof stateRoot !== "string" || !boundedRetirementString(stateRoot, 4096) || !path.isAbsolute(stateRoot))
		return false;
	return (
		typeof identity.sessionId === "string" &&
		isCanonicalSessionId(identity.sessionId) &&
		typeof identity.endpointGeneration === "number" &&
		Number.isSafeInteger(identity.endpointGeneration) &&
		identity.endpointGeneration > 0 &&
		typeof identity.endpointMtimeMs === "number" &&
		Number.isFinite(identity.endpointMtimeMs) &&
		identity.endpointMtimeMs > 0 &&
		(identity.endpointFileId === undefined || boundedRetirementString(identity.endpointFileId, 256)) &&
		typeof identity.pid === "number" &&
		Number.isSafeInteger(identity.pid) &&
		identity.pid > 0 &&
		boundedRetirementString(identity.processIncarnation, MAX_PROCESS_INCARNATION_LENGTH) &&
		boundedRetirementString(identity.hostIncarnation, MAX_PROCESS_INCARNATION_LENGTH) &&
		boundedRetirementString(identity.lifecycleRequestId, MAX_EFFECT_MARKER_LENGTH) &&
		typeof identity.lifecycleRequestId === "string" &&
		/^[A-Za-z0-9._-]+$/.test(identity.lifecycleRequestId) &&
		boundedRetirementString(identity.createIdentity, 256) &&
		boundedRetirementString(identity.remoteCreateKey, 256)
	);
}

function isLifecycleRetirementReceipt(value: unknown): value is LifecycleRetirementReceipt {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
	const receipt = value as Record<string, unknown>;
	if (
		Object.keys(receipt).some(key => !new Set(["version", "stage", "identity", "indexSeq"]).has(key)) ||
		receipt.version !== 1 ||
		(receipt.stage !== "cleanup" && receipt.stage !== "index" && receipt.stage !== "ledger") ||
		!isLifecycleRetirementIdentity(receipt.identity)
	)
		return false;
	return (
		receipt.indexSeq === undefined ||
		(typeof receipt.indexSeq === "number" && Number.isSafeInteger(receipt.indexSeq) && receipt.indexSeq > 0)
	);
}

function isLifecycleRetirementCleanup(value: unknown): value is LifecycleRetirementCleanup {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
	return isLifecycleRetirementReceipt((value as Record<string, unknown>).uncertainRetirement);
}

function captureLifecycleFile(file: string, requireRegular = false, bounded = false): LifecycleFileCapture | undefined {
	let descriptor: number | undefined;
	try {
		const preflight = bounded ? fsSync.lstatSync(file, { bigint: true }) : undefined;
		if (
			preflight &&
			(!preflight.isFile() || preflight.size === 0n || preflight.size > BigInt(MAX_LIFECYCLE_METADATA_BYTES))
		) {
			if (requireRegular) throw new Error("Lifecycle metadata is not a bounded regular file.");
			return undefined;
		}
		descriptor = fsSync.openSync(file, fsSync.constants.O_RDONLY | fsSync.constants.O_NOFOLLOW);
		const stat = fsSync.fstatSync(descriptor, { bigint: true });
		if (
			!stat.isFile() ||
			stat.nlink !== 1n ||
			(bounded &&
				(stat.size === 0n ||
					stat.size > BigInt(MAX_LIFECYCLE_METADATA_BYTES) ||
					!preflight ||
					stat.dev !== preflight.dev ||
					stat.ino !== preflight.ino))
		) {
			if (requireRegular) throw new Error("Lifecycle cleanup candidate is not an exact bounded regular file.");
			return undefined;
		}
		const bytes = fsSync.readFileSync(descriptor);
		const current = fsSync.fstatSync(descriptor, { bigint: true });
		if (
			!current.isFile() ||
			current.dev !== stat.dev ||
			current.ino !== stat.ino ||
			current.size !== stat.size ||
			current.mtimeNs !== stat.mtimeNs
		)
			return undefined;
		return {
			bytes,
			identity: {
				dev: stat.dev,
				ino: stat.ino,
				size: stat.size,
				nlink: stat.nlink,
				mtimeNs: stat.mtimeNs,
				sha256: createHash("sha256").update(bytes).digest("hex"),
			},
			digest: createHash("sha256").update(bytes).digest("hex"),
		};
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
		throw error;
	} finally {
		if (descriptor !== undefined) fsSync.closeSync(descriptor);
	}
}

async function removeOwnedLifecycleArtifacts(
	root: string,
	id: string,
	expected: EffectMarker,
	onRetainedUnknown?: () => void,
	onDurablePlaceholder?: (file: string) => void,
	proofBudget?: LifecycleProofBudget,
): Promise<boolean> {
	if (!lifecycleProofWithinDeadline(proofBudget)) return false;
	const marker = await readEffectMarker(lifecycleMarkerPath(root, id));
	if (!lifecycleProofWithinDeadline(proofBudget)) return false;
	if (!marker || !sameEffectMarker(marker, expected)) return false;
	const endpointPath = path.join(root, "sdk", `${id}.json`);
	const plannedEndpointPath = path.join(
		path.dirname(endpointPath),
		`.gjc-delete-endpoint-${expected.effectMarker}-${path.basename(endpointPath)}`,
	);
	const retryEndpointPath = path.join(
		path.dirname(endpointPath),
		`.gjc-delete-endpoint-retry-${expected.effectMarker}-${path.basename(endpointPath)}`,
	);
	const finalEndpointPath = path.join(
		path.dirname(endpointPath),
		`.gjc-delete-endpoint-final-${expected.effectMarker}-${path.basename(endpointPath)}`,
	);
	const endpointSource = [endpointPath, plannedEndpointPath, retryEndpointPath, finalEndpointPath].find(candidate => {
		try {
			return fsSync.lstatSync(candidate).isFile();
		} catch {
			return false;
		}
	});
	const endpoint = endpointSource ? captureLifecycleFile(endpointSource) : undefined;
	if (!lifecycleProofWithinDeadline(proofBudget)) return false;
	const endpointParent = endpointSource ? lifecycleParentIdentity(path.dirname(endpointSource)) : undefined;
	if (endpoint && endpointSource && endpointParent) {
		let parsed: { pid?: unknown };
		try {
			parsed = parseLifecycleJson(endpoint.bytes) as { pid?: unknown };
		} catch {
			return false;
		}
		if (parsed.pid !== expected.pid || observeProcess(expected.pid, expected.incarnation) !== "exited") return false;
		if (createHash("sha256").update(endpoint.bytes).digest("hex") !== endpoint.digest) return false;
		// Bind the deletion to the expected process incarnation and endpoint
		// identity, rechecking immediately before unlink: a successor launch for
		// this session rewrites the lifecycle marker through the broker before its
		// child can publish anything, so a marker that no longer matches `expected`
		// means this endpoint file is no longer provably the dead child's — it may
		// belong to a PID-reusing successor and must not be unlinked (#4712
		// review: PID-reuse race must not delete a successor endpoint).
		const preUnlinkMarker = await readEffectMarker(lifecycleMarkerPath(root, id));
		if (!lifecycleProofWithinDeadline(proofBudget)) return false;
		if (!preUnlinkMarker || !sameEffectMarker(preUnlinkMarker, expected)) return false;
		const endpointRemoval = exactUnlinkLifecycleFile(
			endpointSource,
			endpoint.identity,
			endpointSource === endpointPath
				? plannedEndpointPath
				: endpointSource === plannedEndpointPath
					? retryEndpointPath
					: finalEndpointPath,
			{ dev: BigInt(endpointParent.dev), ino: BigInt(endpointParent.ino) },
		);
		if (!lifecycleProofWithinDeadline(proofBudget)) return false;
		if (!endpointRemoval.ok) {
			if (endpointRemoval.retainedUnknownPath) {
				onRetainedUnknown?.();
				return false;
			}
			if (endpointRemoval.code !== "cleanup_pending") return false;
			if (endpointRemoval.retainedPlaceholderPath) {
				if (endpointRemoval.payloadDurable !== true) return false;
				onDurablePlaceholder?.(path.resolve(endpointRemoval.retainedPlaceholderPath));
				for (const candidate of [endpointSource, plannedEndpointPath, retryEndpointPath, finalEndpointPath]) {
					try {
						if (fsSync.lstatSync(candidate).size === 0) onDurablePlaceholder?.(path.resolve(candidate));
					} catch {
						// Absent aliases carry no retained authority.
					}
				}
			}
			// A payload-durable POSIX detach has scrubbed its quarantine payload to a
			// zero-byte placeholder, so the original identity cannot authorize a retry.
			if (
				endpointRemoval.detachedPath &&
				endpointRemoval.payloadDurable !== true &&
				fsSync.existsSync(endpointRemoval.detachedPath)
			) {
				const detachedPath = path.resolve(endpointRemoval.detachedPath);
				if (path.dirname(detachedPath) !== path.dirname(path.resolve(endpointPath))) return false;
				let detachedRemoval: NativeExactUnlinkResult;
				try {
					detachedRemoval = exactUnlinkLifecycleFile(
						detachedPath,
						endpoint.identity,
						path.join(
							path.dirname(detachedPath),
							`.gjc-delete-endpoint-detached-${expected.effectMarker}-${path.basename(endpointPath)}`,
						),
						{ dev: BigInt(endpointParent.dev), ino: BigInt(endpointParent.ino) },
					);
				} catch {
					return false;
				}
				if (!lifecycleProofWithinDeadline(proofBudget)) return false;
				if (!detachedRemoval.ok && detachedRemoval.code !== "not_found") return false;
			}
		}
	}
	const currentMarker = await readEffectMarker(lifecycleMarkerPath(root, id));
	if (!lifecycleProofWithinDeadline(proofBudget)) return false;
	if (!currentMarker || !sameEffectMarker(currentMarker, expected)) return false;
	const readyPath = lifecycleReadyPath(root, id);
	const ready = captureLifecycleFile(readyPath, true, true);
	if (!lifecycleProofWithinDeadline(proofBudget)) return false;
	if (ready && createHash("sha256").update(ready.bytes).digest("hex") !== ready.digest) return false;
	// Readiness mutation is deferred to the same ledger-backed cleanup transaction.
	return lifecycleProofWithinDeadline(proofBudget);
}

/**
 * Test seam for the PID-reuse deletion boundary: a successor launch rewriting
 * the lifecycle marker must stop the unlink of an endpoint that only matches
 * by a reused pid (#4712 review).
 */
export async function removeOwnedLifecycleArtifactsForTest(
	root: string,
	id: string,
	expected: EffectMarker,
): Promise<boolean> {
	return removeOwnedLifecycleArtifacts(root, id, expected);
}

async function recordTerminalUncertain(
	broker: Broker,
	id: string,
	root: string,
	pid: number,
	expected?: EffectMarker,
): Promise<void> {
	await broker.index.refresh();
	const registered = broker.index.listSessions().sessions.find(session => session.sessionId === id);
	if (registered)
		await broker.index.append({
			type: "lifecycle_terminal",
			sessionId: id,
			locator: registered.locator,
			endpointGeneration: registered.endpointGeneration,
			pid: registered.pid,
			...(registered.processIncarnation === undefined ? {} : { processIncarnation: registered.processIncarnation }),
			...(registered.hostIncarnation === undefined ? {} : { hostIncarnation: registered.hostIncarnation }),
			...(registered.endpointMtimeMs === undefined ? {} : { endpointMtimeMs: registered.endpointMtimeMs }),
			...(registered.endpointFileId === undefined ? {} : { endpointFileId: registered.endpointFileId }),
			...(registered.lifecycleRequestId === undefined
				? expected?.effectMarker === undefined
					? {}
					: { lifecycleRequestId: expected.effectMarker }
				: { lifecycleRequestId: registered.lifecycleRequestId }),
			terminalUncertain: true,
		});
	else
		await broker.index.append({
			type: "lifecycle_terminal",
			sessionId: id,
			locator: { cwd: "unknown", worktreeRoot: null, stateRoot: root },
			endpointGeneration: 0,
			pid,
			terminalUncertain: true,
		});
}

async function waitUntil(timing: LifecycleTiming, deadline: number): Promise<void> {
	while (timing.now() < deadline) await timing.sleep(Math.max(0, Math.min(POLL_MS, deadline - timing.now())));
}

async function terminateSpawnedChild(
	child: ChildProcess,
	broker: Broker,
	id: string,
	root: string,
	deadline: number,
	terminationStartDeadlineAt: number,
	expected: EffectMarker | undefined,
	timing: LifecycleTiming,
): Promise<boolean> {
	const pid = child.pid;
	if (!pid || (expected && pid !== expected.pid)) return false;
	const incarnation = expected?.incarnation ?? processIncarnationForBroker(broker, pid);
	const proofBudget: LifecycleProofBudget = { timing, deadlineAt: deadline };
	const failClosed = async (): Promise<boolean> => {
		await recordTerminalUncertain(broker, id, root, pid, expected);
		return false;
	};
	if (!lifecycleProofWithinDeadline(proofBudget)) return failClosed();
	await broker.index.refresh();
	if (!lifecycleProofWithinDeadline(proofBudget)) return failClosed();
	const registered = expected ? broker.index.hasHostRegistrationForLifecycle(id, pid, expected.effectMarker) : false;
	// Keep one poll interval inside the lifecycle deadline for the final exact
	// cleanup proof. Registered sessions retain the original deadline partition;
	// only an unregistered child needs this extra bounded margin.
	const processExitDeadlineAt = expected && !registered ? deadline - POLL_MS : deadline;
	const unregisteredTerminationDeadlineAt =
		processExitDeadlineAt - Math.max(POLL_MS, Math.floor((processExitDeadlineAt - terminationStartDeadlineAt) / 2));
	const observe = (): ProcessObservation =>
		child.exitCode !== null
			? "exited"
			: observeProcess(pid, incarnation, value => processIncarnationForBroker(broker, value));
	const waitForExit = async (until: number): Promise<ProcessObservation> => {
		let observation = observe();
		while (observation !== "exited" && timing.now() < until) {
			await timing.sleep(Math.max(0, Math.min(POLL_MS, until - timing.now())));
			observation = observe();
		}

		return observation;
	};

	let observation = observe();
	const recheckOwnedExitObservation = async (): Promise<void> => {
		if (observation !== "uncertain") return;
		// This direct ChildProcess is owned by this broker invocation. A process-incarnation
		// read can briefly lag its exit event, so recheck only this owned child before failing.
		observation = await waitForExit(processExitDeadlineAt);
	};
	if (observation === "alive") {
		if (expected && !registered) {
			// A child that has not registered yet owns the cutoff receipt. Give it
			// the bounded pre-registration window to publish that proof, but reserve
			// the final proof interval for post-signal observation inside the request
			// deadline. A valid receipt does not interrupt the child's own rollback.
			while (timing.now() < unregisteredTerminationDeadlineAt) {
				if (await readLifecycleFailureArtifact(lifecycleFailurePath(root, id, expected.effectMarker), expected))
					await waitUntil(timing, unregisteredTerminationDeadlineAt);
				else await timing.sleep(Math.max(0, Math.min(POLL_MS, unregisteredTerminationDeadlineAt - timing.now())));
			}
		} else {
			await waitUntil(timing, terminationStartDeadlineAt);
		}
		observation = observe();
	}
	if (observation === "alive") {
		if (!(await signalVerifiedSession({ locator: { stateRoot: root }, pid }, id, "SIGTERM", expected))) {
			observation = observe();
			await recheckOwnedExitObservation();
			if (observation !== "exited") {
				await recordTerminalUncertain(broker, id, root, pid);
				return false;
			}
		} else {
			const remaining = Math.max(0, processExitDeadlineAt - timing.now());
			const gracefulDeadline = timing.now() + Math.min(CLOSE_TIMEOUT_MS, Math.floor(remaining / 2));
			observation = await waitForExit(gracefulDeadline);
		}
	}
	if (observation === "alive") {
		if (!(await signalVerifiedSession({ locator: { stateRoot: root }, pid }, id, "SIGKILL", expected))) {
			observation = observe();
			await recheckOwnedExitObservation();
			if (observation !== "exited") {
				await recordTerminalUncertain(broker, id, root, pid);
				return false;
			}
		} else {
			observation = await waitForExit(processExitDeadlineAt);
		}
	}
	await recheckOwnedExitObservation();
	if (observation !== "exited" || !lifecycleProofWithinDeadline(proofBudget)) return failClosed();
	let rollbackGeneration: number | null | undefined;
	if (expected) {
		const failure = await readLifecycleFailureArtifact(
			lifecycleFailurePath(root, id, expected.effectMarker),
			expected,
		);
		if (!lifecycleProofWithinDeadline(proofBudget)) return failClosed();
		const rollbackComplete =
			failure?.artifact.rollback.fenced === true &&
			failure.artifact.rollback.runtimeRemoved &&
			failure.artifact.rollback.hostStopped &&
			failure.artifact.rollback.brokerRegistrationReleased;
		if (!rollbackComplete) {
			if (!readyThenExitToleranceEnabled()) {
				return failClosed();
			}
			if (!lifecycleProofWithinDeadline(proofBudget)) return failClosed();
			const publishedReady = (await probePublishedReadyAuthority(root, id, expected)).kind === "matched";
			if (!lifecycleProofWithinDeadline(proofBudget)) return failClosed();
			const artifactsRemoved = await removeOwnedLifecycleArtifacts(
				root,
				id,
				expected,
				undefined,
				undefined,
				proofBudget,
			);
			if (!lifecycleProofWithinDeadline(proofBudget)) return failClosed();
			await broker.index.refresh();
			if (!lifecycleProofWithinDeadline(proofBudget)) return failClosed();
			const registered = broker.index
				.listSessions()
				.sessions.find(session => session.sessionId === id && session.pid === pid);
			const registeredRowTerminal = registered?.terminal === true || registered?.terminalUncertain === true;
			let registrationReleased =
				!broker.index.hasHostRegistrationForLifecycle(id, pid, expected.effectMarker) || registeredRowTerminal;
			if (registered && !registrationReleased) {
				if (!lifecycleProofWithinDeadline(proofBudget)) return failClosed();
				registrationReleased = await broker.index.unregisterIfCurrent(registered);
				if (!lifecycleProofWithinDeadline(proofBudget)) return failClosed();
				await broker.index.refresh();
				if (!lifecycleProofWithinDeadline(proofBudget)) return failClosed();
				registrationReleased =
					registrationReleased || !broker.index.hasHostRegistrationForLifecycle(id, pid, expected.effectMarker);
			}
			const stillExited =
				observeProcess(pid, expected.incarnation, value => processIncarnationForBroker(broker, value)) === "exited";
			if (!lifecycleProofWithinDeadline(proofBudget)) return failClosed();
			const endpointGone = await endpointRemoved(root, id);
			if (!lifecycleProofWithinDeadline(proofBudget)) return failClosed();
			try {
				if (publishedReady && !failure) {
					await writeSessionLifecycleFailure(
						root,
						id,
						expected.effectMarker,
						{
							phase: "startup",
							reason: "failed",
							message: `Session ${id} ${READY_THEN_EXIT_MESSAGE}.`,
						},
						{
							endpointGeneration: registered?.endpointGeneration ?? null,
							fenced: stillExited && registrationReleased,
							runtimeRemoved: artifactsRemoved && endpointGone,
							hostStopped: stillExited,
							brokerRegistrationReleased: registrationReleased,
						},
						undefined,
						expected.incarnation,
						expected.pid,
					);
				}
			} catch {
				// A missing broker-authored receipt must not hide a proven dead child.
			}
			if (
				stillExited &&
				artifactsRemoved &&
				endpointGone &&
				registrationReleased &&
				lifecycleProofWithinDeadline(proofBudget)
			)
				return true;
			return failClosed();
		}
		rollbackGeneration = failure.artifact.rollback.endpointGeneration;
	}
	if (expected && !(await removeOwnedLifecycleArtifacts(root, id, expected, undefined, undefined, proofBudget)))
		return failClosed();
	if (!lifecycleProofWithinDeadline(proofBudget)) return failClosed();
	await broker.index.refresh();
	if (!lifecycleProofWithinDeadline(proofBudget)) return failClosed();
	if (
		rollbackGeneration === null &&
		expected &&
		!broker.index.hasHostRegistrationForLifecycle(id, pid, expected.effectMarker)
	)
		return lifecycleProofWithinDeadline(proofBudget) ? true : failClosed();
	const registeredBeforeTermination =
		rollbackGeneration === undefined || rollbackGeneration === null
			? undefined
			: broker.index.findHostRegistration(id, rollbackGeneration, pid, expected?.effectMarker);
	const unregistered = registeredBeforeTermination
		? broker.index.hostUnregisteredAfter(registeredBeforeTermination)
		: undefined;
	if (!registeredBeforeTermination || !unregistered) {
		return failClosed();
	}
	if (!lifecycleProofWithinDeadline(proofBudget)) return failClosed();
	const endpointGone = await endpointRemoved(root, id);
	return endpointGone && lifecycleProofWithinDeadline(proofBudget) ? true : failClosed();
}

async function signalVerifiedSession(
	record: SignalTarget,
	id: string,
	signal: NodeJS.Signals,
	expected?: EffectMarker,
): Promise<boolean> {
	if (!(await hasDurableProcessIdentity(record, id, expected))) return false;
	try {
		if (!(await hasDurableProcessIdentity(record, id, expected))) return false;
		process.kill(record.pid, signal);
		return true;
	} catch {
		return false;
	}
}

async function endpointRemoved(root: string, id: string): Promise<boolean> {
	try {
		await fs.access(path.join(root, "sdk", `${id}.json`));
		return false;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "ENOENT";
	}
}

async function removeExactDeadSessionEndpoint(
	broker: Broker,
	id: string,
	record: CloseRecord,
	attempt = 0,
	authorizedSource?: string,
	durablePlaceholders?: Set<string>,
): Promise<boolean> {
	if (record.endpointMtimeMs === undefined) return await endpointRemoved(record.locator.stateRoot, id);
	await broker.index.refresh();
	const current = broker.index.listSessions().sessions.find(session => session.sessionId === id);
	if (
		!current ||
		current.endpointGeneration !== record.endpointGeneration ||
		current.pid !== record.pid ||
		current.endpointMtimeMs !== record.endpointMtimeMs ||
		current.endpointFileId !== record.endpointFileId ||
		current.lifecycleRequestId !== record.lifecycleRequestId ||
		current.processIncarnation !== record.processIncarnation ||
		path.resolve(current.locator.stateRoot) !== path.resolve(record.locator.stateRoot)
	)
		return false;
	const endpointPath = path.join(record.locator.stateRoot, "sdk", `${id}.json`);
	const suffix = `${id}-${record.endpointGeneration}-${record.pid}-${String(record.endpointMtimeMs).replaceAll(".", "_")}.json`;
	const plannedEndpointPath = path.join(path.dirname(endpointPath), `.gjc-dead-endpoint-${suffix}`);
	const retryEndpointPath = path.join(path.dirname(endpointPath), `.gjc-dead-endpoint-retry-${suffix}`);
	const finalEndpointPath = path.join(path.dirname(endpointPath), `.gjc-dead-endpoint-final-${suffix}`);
	const ownedEndpointPaths = record.lifecycleRequestId
		? [
				`.gjc-delete-endpoint-detached-${record.lifecycleRequestId}-${path.basename(endpointPath)}`,
				`.gjc-delete-endpoint-final-${record.lifecycleRequestId}-${path.basename(endpointPath)}`,
				`.gjc-delete-endpoint-retry-${record.lifecycleRequestId}-${path.basename(endpointPath)}`,
				`.gjc-delete-endpoint-${record.lifecycleRequestId}-${path.basename(endpointPath)}`,
			].map(name => path.join(path.dirname(endpointPath), name))
		: [];
	const ownedPayloadPaths: string[] = [];
	for (const ownedPath of ownedEndpointPaths) {
		let size: number;
		try {
			size = fsSync.lstatSync(ownedPath).size;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
			return false;
		}
		if (size > 0) ownedPayloadPaths.push(ownedPath);
	}
	const candidates = [...ownedPayloadPaths, finalEndpointPath, retryEndpointPath, plannedEndpointPath, endpointPath];
	let authorizedDetachedSource: string | undefined;
	if (authorizedSource && path.dirname(path.resolve(authorizedSource)) === path.dirname(path.resolve(endpointPath))) {
		try {
			if (fsSync.lstatSync(authorizedSource).size > 0) authorizedDetachedSource = authorizedSource;
		} catch {
			// The detached source was already retired; deterministic candidates remain authoritative.
		}
	}
	const endpointSource =
		authorizedDetachedSource && fsSync.existsSync(authorizedDetachedSource)
			? authorizedDetachedSource
			: candidates.find(candidate => {
					try {
						return fsSync.lstatSync(candidate).isFile();
					} catch {
						return false;
					}
				});
	if (!endpointSource) return await endpointRemoved(record.locator.stateRoot, id);
	const plannedPath =
		endpointSource === endpointPath
			? plannedEndpointPath
			: endpointSource === plannedEndpointPath
				? retryEndpointPath
				: finalEndpointPath;
	let handle: fs.FileHandle | undefined;
	try {
		handle = await fs.open(
			endpointSource,
			fsSync.constants.O_RDONLY | (fsSync.constants.O_NOFOLLOW ?? 0) | (fsSync.constants.O_NONBLOCK ?? 0),
		);
		const metadata = await handle.stat({ bigint: true });
		if (!metadata.isFile() || metadata.nlink !== 1n || metadata.size > 4096n) return false;
		const bytes = Buffer.alloc(Number(metadata.size) + 1);
		const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0);
		if (bytesRead !== Number(metadata.size)) return false;
		const source = bytes.subarray(0, bytesRead);
		const endpoint = JSON.parse(source.toString("utf8")) as { sessionId?: unknown; pid?: unknown; stale?: unknown };
		const indexedEndpointMtimeMs = Math.trunc(record.endpointMtimeMs);
		if (
			endpoint.sessionId !== id ||
			endpoint.pid !== record.pid ||
			endpoint.stale === true ||
			!Number.isSafeInteger(indexedEndpointMtimeMs) ||
			metadata.mtimeNs / 1_000_000n !== BigInt(indexedEndpointMtimeMs)
		)
			return false;
		await handle.close();
		handle = undefined;
		const removed = exactUnlinkLifecycleFile(
			endpointSource,
			{
				dev: metadata.dev,
				ino: metadata.ino,
				nlink: metadata.nlink,
				size: metadata.size,
				mtimeNs: metadata.mtimeNs,
				sha256: createHash("sha256").update(source).digest("hex"),
			},
			plannedPath,
			(() => {
				const parent = lifecycleParentIdentity(path.dirname(endpointSource));
				return parent ? { dev: BigInt(parent.dev), ino: BigInt(parent.ino) } : undefined;
			})(),
		);
		if (removed.ok || removed.code === "not_found") return true;
		if (removed.code === "cleanup_pending" && removed.retainedUnknownPath) return false;
		if (removed.code === "cleanup_pending" && removed.retainedPlaceholderPath) {
			if (removed.payloadDurable !== true) return false;
			durablePlaceholders?.add(path.resolve(removed.retainedPlaceholderPath));
			for (const candidate of [endpointSource, plannedEndpointPath, retryEndpointPath, finalEndpointPath]) {
				try {
					if (fsSync.lstatSync(candidate).size === 0) durablePlaceholders?.add(path.resolve(candidate));
				} catch {
					// Absent aliases carry no retained authority.
				}
			}
		}
		if (removed.code === "cleanup_pending" && attempt < 4)
			return await removeExactDeadSessionEndpoint(
				broker,
				id,
				record,
				attempt + 1,
				removed.detachedPath,
				durablePlaceholders,
			);
		return false;
	} catch {
		return false;
	} finally {
		await handle?.close();
	}
}

async function hasOwnedEndpointPayload(
	root: string,
	id: string,
	effectMarker: string,
	durablePlaceholders: ReadonlySet<string>,
): Promise<boolean> {
	const directory = path.join(root, "sdk");
	const endpointName = `${id}.json`;
	let names: string[];
	try {
		names = await fs.readdir(directory);
	} catch (error) {
		return (error as NodeJS.ErrnoException).code !== "ENOENT";
	}
	for (const name of names) {
		if (!name.startsWith(".gjc-delete-endpoint-") || !name.includes(effectMarker) || !name.includes(endpointName))
			continue;
		try {
			const candidate = path.join(directory, name);
			const metadata = await fs.lstat(candidate);
			if (
				!metadata.isFile() ||
				metadata.size > 0 ||
				(metadata.size === 0 && !durablePlaceholders.has(path.resolve(candidate)))
			)
				return true;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") return true;
		}
	}
	return false;
}
async function waitForClose(
	broker: Broker,
	id: string,
	record: CloseRecord,
	timeoutMs: number,
	processExitObserver?: StableProcessExitObserver,
): Promise<boolean> {
	const timing = lifecycleTiming(broker);
	const deadline = timing.now() + timeoutMs;
	const durablePlaceholders = new Set<string>();
	while (timing.now() < deadline) {
		await broker.index.refresh();
		const registration = broker.index.findHostRegistration(
			id,
			record.endpointGeneration,
			record.pid,
			record.lifecycleRequestId,
		);
		if (
			registration &&
			broker.index.hostUnregisteredAfter(registration) &&
			(await endpointRemoved(record.locator.stateRoot, id)) &&
			observedProcessExited(record.pid, record.processIncarnation, processExitObserver) &&
			(!record.lifecycleRequestId ||
				!(await hasOwnedEndpointPayload(
					record.locator.stateRoot,
					id,
					record.lifecycleRequestId,
					durablePlaceholders,
				)))
		)
			return true;
		// A host that dies before it can withdraw its own registration — killed
		// mid-teardown, or unable to finish one because its workspace is gone —
		// leaves the index advertising a session whose process is provably absent.
		// That is exactly the evidence the dead-registration sweep retires records
		// on, so retire it here too instead of escalating signals at a pid that no
		// longer exists and then reporting the teardown as unfinished.
		if (registration && observedProcessExited(record.pid, record.processIncarnation, processExitObserver)) {
			const expected =
				typeof record.lifecycleRequestId === "string" && typeof record.processIncarnation === "string"
					? {
							pid: record.pid,
							effectMarker: record.lifecycleRequestId,
							incarnation: record.processIncarnation,
						}
					: undefined;
			let retainedUnknown = false;
			if (expected)
				await removeOwnedLifecycleArtifacts(
					record.locator.stateRoot,
					id,
					expected,
					() => {
						retainedUnknown = true;
					},
					file => durablePlaceholders.add(path.resolve(file)),
				);
			if (retainedUnknown) return false;
			if (!(await removeExactDeadSessionEndpoint(broker, id, record, 0, undefined, durablePlaceholders)))
				return false;
			if (
				expected &&
				(await hasOwnedEndpointPayload(record.locator.stateRoot, id, expected.effectMarker, durablePlaceholders))
			)
				return false;
			if (!(await broker.index.unregisterIfCurrent(registration))) return false;
			return await endpointRemoved(record.locator.stateRoot, id);
		}
		await timing.sleep(POLL_MS);
	}
	return false;
}

async function currentReadyAuthority(
	broker: Broker,
	id: string,
	root: string,
	expected: EffectMarker,
): Promise<ReadyAuthority | undefined> {
	if (!(await hasOwnedReadinessEvidence(broker, root, id, expected))) return undefined;
	const endpointPath = path.join(root, "sdk", `${id}.json`);
	try {
		const endpointFile = await readEndpointFile(endpointPath);
		if (!endpointFile) return undefined;
		const endpointSource = endpointFile.source;
		const endpoint = JSON.parse(endpointSource) as {
			sessionId?: unknown;
			url?: unknown;
			token?: unknown;
			pid?: unknown;
		};
		// Native-alive owned readiness is the admission authority. `record.live`
		// also requires a fresh index heartbeat projection, which can lag a just-
		// registered detached Windows host. Never admit a terminal/uncertain or
		// native-dead child; do not refuse a native-alive ready host for a stale live bit.
		await broker.heartbeatSessions();
		await broker.index.refresh();
		const record = broker.index
			.listSessions()
			.sessions.find(
				session =>
					session.sessionId === id &&
					session.pid === expected.pid &&
					resolveEquivalentPath(session.locator.stateRoot) === resolveEquivalentPath(root) &&
					(session.hostIncarnation ?? session.processIncarnation) === expected.incarnation &&
					session.lifecycleRequestId === expected.effectMarker,
			);
		if (
			!record ||
			record.terminal ||
			record.terminalUncertain ||
			record.pid !== expected.pid ||
			resolveEquivalentPath(record.locator.stateRoot) !== resolveEquivalentPath(root) ||
			(record.hostIncarnation ?? record.processIncarnation) !== expected.incarnation ||
			!matchesIndexedEndpointFile(endpointFile, record) ||
			endpoint.pid !== expected.pid ||
			endpoint.sessionId !== id ||
			typeof endpoint.url !== "string" ||
			typeof endpoint.token !== "string"
		)
			return undefined;
		if (
			observeProcess(expected.pid, expected.incarnation, value => processIncarnationForBroker(broker, value)) !==
			"alive"
		)
			return undefined;
		return {
			endpoint: endpoint as Record<string, unknown>,
			endpointSource,
			// Lifecycle responses are Router adoption inputs. Publish the index's
			// canonical millisecond representation so the provisional attachment
			// mints the same persisted authority ID as ordinary reattachment. The
			// descriptor itself was already matched to this row above.
			endpointMtimeMs: record.endpointMtimeMs!,
			...(record.endpointFileId === undefined ? {} : { endpointFileId: record.endpointFileId }),
			endpointGeneration: record.endpointGeneration,
		};
	} catch {
		return undefined;
	}
}

function sameReadyAuthority(left: ReadyAuthority, right: ReadyAuthority): boolean {
	return (
		left.endpointSource === right.endpointSource &&
		Math.abs(left.endpointMtimeMs - right.endpointMtimeMs) <= 0.001 &&
		left.endpointFileId === right.endpointFileId &&
		left.endpointGeneration === right.endpointGeneration
	);
}

/**
 * Wait for the child's semantic completion signal at exactly this endpoint.
 *
 * `session_ready` is the stock signal. A deferred launch waits on
 * `session_prepared` instead: it is the same authenticated, replayable proof
 * that the child finished initializing and owns its endpoint, minus the
 * readiness no consumer may act on yet. Both are additionally bound to the
 * owner-proved lifecycle receipt through `currentReadyAuthority`, so an
 * endpoint file appearing on its own never satisfies either wait.
 */
async function waitForReady(
	broker: Broker,
	id: string,
	root: string,
	deadline: number,
	expected: EffectMarker,
	timing: LifecycleTiming,
	signal: "session_ready" | typeof SESSION_PREPARED_EVENT = "session_ready",
): Promise<ReadinessResult> {
	const classifyExitedAfterReady = async (): Promise<ReadinessResult> => {
		const probe = await probePublishedReadyAuthority(root, id, expected, broker);
		if (probe.kind === "malformed" || probe.kind === "io_error") return { kind: "ready_probe_failed", probe };
		const publishedReady = probe.kind === "matched" || probe.kind === "absent_indexed";
		return publishedReady && readyThenExitToleranceEnabled()
			? { kind: "ready_then_exited" }
			: { kind: "child_exited" };
	};
	while (timing.now() < deadline) {
		const startupFailure = await readSessionLifecycleFailure(root, id, expected);
		if (startupFailure) {
			if (
				observeProcess(expected.pid, expected.incarnation, value => processIncarnationForBroker(broker, value)) ===
				"exited"
			) {
				const afterReady = await classifyExitedAfterReady();
				if (afterReady.kind !== "child_exited") return afterReady;
			}
			return { kind: "startup_failed", failure: startupFailure };
		}
		if (
			observeProcess(expected.pid, expected.incarnation, value => processIncarnationForBroker(broker, value)) ===
			"exited"
		) {
			const finalStartupFailure = await readSessionLifecycleFailure(root, id, expected);
			if (finalStartupFailure) {
				const afterReady = await classifyExitedAfterReady();
				if (afterReady.kind !== "child_exited") return afterReady;
				return { kind: "startup_failed", failure: finalStartupFailure };
			}
			// A malformed or unreadable endpoint is its own fail-closed outcome: it
			// never feeds the teardown decision and never claims the child "exited
			// before registering readiness" (#4712 review).
			return classifyExitedAfterReady();
		}
		try {
			const authority = await currentReadyAuthority(broker, id, root, expected);
			if (!authority) {
				const remaining = deadline - timing.now();
				if (remaining > 0) await timing.sleep(Math.min(POLL_MS, remaining));

				continue;
			}
			const connectionTimeoutMs = Math.min(2_000, deadline - timing.now());

			if (connectionTimeoutMs <= 0) break;
			const endpoint = authority.endpoint as { url: string; token: string };
			const client = await SdkClient.connect(endpoint.url, endpoint.token, {
				timeoutMs: connectionTimeoutMs,
				deadline,
				reconnectAttempts: 0,
			});
			try {
				const requestTimeoutMs = Math.min(2_000, deadline - timing.now());

				if (requestTimeoutMs <= 0) break;
				const replay = await client.request(
					{
						type: "event_replay",
						sinceGeneration: authority.endpointGeneration,
						sinceSeq: 0,
					},
					{ timeoutMs: requestTimeoutMs },
				);
				const events = (replay.events as unknown[]) ?? [];
				if (
					events.some(event => {
						const frame = event as Record<string, unknown>;
						return (
							frame.type === "event" &&
							frame.name === signal &&
							frame.sessionId === id &&
							frame.generation === authority.endpointGeneration
						);
					})
				) {
					const current = await currentReadyAuthority(broker, id, root, expected);
					if (current && sameReadyAuthority(authority, current)) return { kind: "ready", authority: current };
				}
			} finally {
				await client.close();
			}
		} catch {
			// A partially initialized or unauthenticated endpoint is not ready yet.
		}
		const remaining = deadline - timing.now();
		if (remaining > 0) await timing.sleep(Math.min(POLL_MS, remaining));
	}
	return { kind: "timeout" };
}

function worktreeIntent(plan: GjcLaunchWorktreePlan | undefined): LifecycleWorktreeIntent | undefined {
	if (!plan) return undefined;
	return {
		repoRoot: path.resolve(plan.repoRoot),
		worktreePath: path.resolve(plan.worktreePath),
		detached: plan.detached,
		baseRef: plan.baseRef,
		...(plan.branchName ? { branchName: plan.branchName } : {}),
	};
}

/** Test seam for the worktree occupancy boundary. */
export function worktreeOccupantForTest(
	sessions: IndexedSession[],
	worktreePath: string,
	observe: (pid: number, expectedIncarnation: string | undefined) => ProcessObservation = observeProcess,
): string | null {
	return worktreeOccupant(sessions, worktreePath, observe);
}

async function preparePlannedWorktree(
	plan: GjcLaunchWorktreePlan,
	opts: { signal: AbortSignal; deadlineAt: number; now: () => number },
): Promise<SessionLifecycleWorktreeReceipt> {
	const hooked = ensureLaunchWorktreeForTest;
	if (hooked) {
		const receipt = await hooked(plan, { signal: opts.signal, deadlineAt: opts.deadlineAt });
		if (!receipt.enabled || path.resolve(receipt.cwd) !== path.resolve(plan.worktreePath))
			throw new Error("Lifecycle worktree preparation did not preserve the durable worktree identity.");
		return receipt;
	}
	const prepared = await ensureLaunchWorktreeCancellable(plan, {
		signal: opts.signal,
		deadlineAt: opts.deadlineAt,
		now: opts.now,
	});
	if (!prepared.enabled || path.resolve(prepared.worktreePath) !== path.resolve(plan.worktreePath))
		throw new Error("Lifecycle worktree preparation did not preserve the durable worktree identity.");
	return {
		enabled: true,
		cwd: path.resolve(prepared.worktreePath),
		created: prepared.created,
		reused: prepared.reused,
		createdBranch: prepared.createdBranch,
		...(prepared.branchName ? { branch: prepared.branchName } : {}),
	};
}

function mapPreparationFailure(error: unknown): BrokerResponse {
	const message = sanitizeSdkStartupMessage(error);
	if (
		error instanceof WorktreePreparationTimeoutError ||
		(error as { code?: string }).code === "worktree_preparation_timeout"
	) {
		return fail("worktree_preparation_timeout", message);
	}
	if (
		error instanceof DependencyPreparationTimeoutError ||
		(error as { code?: string }).code === "dependency_preparation_timeout"
	) {
		return fail("dependency_preparation_timeout", message);
	}
	return fail("spawn_failed", `Unable to prepare lifecycle worktree: ${message}`);
}

function abortWhenDue(
	controller: AbortController,
	deadlineAt: number,
	now: () => number,
): ReturnType<typeof setInterval> {
	const tick = (): void => {
		if (now() >= deadlineAt && !controller.signal.aborted) controller.abort();
	};
	tick();
	return setInterval(tick, 10);
}

function durableWorktreeEffects(
	receipt: SessionLifecycleWorktreeReceipt,
	timings: { worktreePreparationMs?: number; dependencyPreparationMs?: number; spawnAuthorizedAtOffsetMs?: number },
): LifecycleDurableEffectsReceipt {
	const worktree = {
		cwdDigest: createHash("sha256").update(receipt.cwd, "utf8").digest("hex"),
		created: receipt.created,
		reused: receipt.reused,
		createdBranch: receipt.createdBranch,
		...(receipt.branch ? { branchDigest: createHash("sha256").update(receipt.branch, "utf8").digest("hex") } : {}),
	};
	return {
		worktree,
		timings,
		digest: createHash("sha256").update(canonicalJson({ worktree, timings })).digest("hex"),
	};
}

function deadlineFieldsPresent(input: Input): boolean {
	return [
		input.receivedAt,
		input.requestedReadinessTimeoutMs,
		input.semanticReadyDeadlineAt,
		input.terminationStartDeadlineAt,
		input.lifecycleCleanupDeadlineAt,
	].some(value => value !== undefined);
}
async function launchInput(
	broker: Broker,
	operation: "session.create" | "session.fork" | "session.resume",
	input: Input,
): Promise<SessionLaunch | BrokerResponse> {
	const requestedCwd = lifecycleCwd(input);
	if (!requestedCwd) return fail("invalid_input", "A target path is required.");
	const sourceCwd = requestedCwd;
	const suppliedRoot = stateRoot(input, requestedCwd);
	if (!suppliedRoot || !hasDefaultStateRoot(requestedCwd, suppliedRoot))
		return fail("invalid_input", "stateRoot must be the default .gjc/state for cwd.");

	try {
		if (!(await fs.stat(sourceCwd)).isDirectory())
			return fail("invalid_input", "Lifecycle worktree must be a directory.");
	} catch {
		return fail("invalid_input", "Lifecycle worktree does not exist.");
	}
	let modelPreset = text(input.modelPreset);
	if (input.modelPreset !== undefined && (typeof input.modelPreset !== "string" || input.modelPreset.length === 0))
		return fail("invalid_input", "modelPreset must be a non-empty exact profile ID.");
	if (modelPreset !== undefined) {
		const validatedModelPreset = await validateBrokerModelPreset(broker.settings.agentDir, modelPreset);
		if (typeof validatedModelPreset !== "string") return validatedModelPreset;
		modelPreset = validatedModelPreset;
	}
	// An explicit model pin (#4707) is coordinator-resolved before it reaches
	// the broker; the broker only guards shape here. It deliberately does NOT
	// shadow modelPreset: both are threaded to the child, whose startup applies
	// the profile first and then overrides it with the explicit model exactly
	// like `gjc --mpreset p --model m` behaves on the CLI.
	const modelId = text(input.modelId)?.trim();
	if (input.modelId !== undefined && !modelId)
		return fail("invalid_input", "modelId must be a non-empty explicit provider/model selector.");
	const worktree = lifecycleWorktreeTarget(input);
	if (worktree === null || (worktree !== undefined && requestedCwd === undefined))
		return fail("invalid_input", "Lifecycle worktree target is invalid.");
	let cwd = sourceCwd;
	let worktreePlan: GjcLaunchWorktreePlan | undefined;
	if (worktree) {
		try {
			const planned = planLaunchWorktree(
				sourceCwd,
				worktree.name
					? { enabled: true, detached: false, name: worktree.name }
					: { enabled: true, detached: true, name: null },
			);
			if (!planned.enabled) return fail("invalid_input", "Lifecycle worktree target is invalid.");
			worktreePlan = planned;
			cwd = path.resolve(planned.worktreePath);
		} catch (error) {
			return fail(
				"invalid_input",
				`Unable to plan lifecycle worktree: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
	}
	const resolvedRoot = defaultStateRoot(cwd);

	const requested = sessionId(input);
	if (requested !== undefined && !isCanonicalSessionId(requested))
		return fail("invalid_input", "sessionId must be a canonical safe identifier.");
	if (input.mcpServers !== undefined && !isSessionLifecycleMcpServers(input.mcpServers))
		return fail("invalid_input", "mcpServers must contain unique valid stdio, HTTP, or SSE server definitions.");
	const mcpServers = input.mcpServers as SessionLifecycleMcpServer[] | undefined;

	/**
	 * Prepared readiness is an explicit creation-only intent. Only the two exact
	 * enum values are admissible, and a foreign value is refused rather than
	 * collapsed into the stock immediate contract.
	 */
	if (input.readiness !== undefined && input.readiness !== "immediate" && input.readiness !== "deferred")
		return fail("invalid_input", "readiness must be either immediate or deferred.");
	const readiness = input.readiness as SessionLifecycleReadiness | undefined;
	if (readiness === "deferred" && operation !== "session.create")
		return fail("invalid_input", "readiness deferred is only supported for session.create.");

	// Coordinator-correlation env scoped to this designated launch only (#2549).
	// The coordinator passes these so the broker-spawned runtime writes terminal
	// state to the coordinator-shared file instead of an unread session-local
	// fallback. They are threaded into the child env, not exported broadly.
	const coordinatorStateDir = text(input.coordinatorStateDir);
	const coordinatorSessionId = text(input.coordinatorSessionId);
	const coordinatorSessionBranch = text(input.coordinatorSessionBranch);
	const coordinatorSidecarSigningKey =
		typeof input.coordinatorSidecarSigningKey === "string" ? input.coordinatorSidecarSigningKey : undefined;
	const coordinatorSidecarKeyId =
		typeof input.coordinatorSidecarKeyId === "string" ? input.coordinatorSidecarKeyId : undefined;
	if (
		(input.coordinatorStateDir !== undefined && !coordinatorStateDir) ||
		(input.coordinatorSidecarSigningKey !== undefined && !coordinatorSidecarSigningKey) ||
		!hasValidCoordinatorSidecarLaunchTarget(
			coordinatorStateDir,
			coordinatorSidecarSigningKey,
			coordinatorSidecarKeyId,
		)
	)
		return fail(
			"invalid_input",
			"Coordinator state directory, signing key, and verifier id must be supplied together as a valid target.",
		);
	const coordinatorAuthority =
		coordinatorSidecarSigningKey && coordinatorSidecarKeyId
			? { coordinatorSidecarSigningKey, coordinatorSidecarKeyId }
			: {};

	if (operation === "session.create")
		return {
			id: randomUUID(),
			cwd,
			root: resolvedRoot,
			modelId,
			modelPreset,
			mcpServers,
			worktree,
			worktreePlan,
			...(readiness ? { readiness } : {}),
			...(coordinatorStateDir ? { coordinatorStateDir } : {}),
			...(coordinatorSessionId ? { coordinatorSessionId } : {}),
			...(coordinatorSessionBranch ? { coordinatorSessionBranch } : {}),
			...coordinatorAuthority,
		};
	if (operation === "session.resume") {
		if (!requested) return fail("invalid_input", "sessionId is required to resume a saved session.");
		const savedPath = text(input.sessionPath);
		if (!savedPath) return fail("invalid_input", "sessionPath is required to resume a saved session.");
		const saved = await validateSavedTranscript(broker, cwd, savedPath, requested, "Saved");
		if ("ok" in saved) return saved;
		return {
			id: requested,
			cwd,
			root: resolvedRoot,
			sessionPath: saved.path,
			modelId,
			sessionIdentity: saved.identity,
			modelPreset,
			mcpServers,
			worktree,
			worktreePlan,
			...(coordinatorStateDir ? { coordinatorStateDir } : {}),
			...(coordinatorSessionId ? { coordinatorSessionId } : {}),
			...(coordinatorSessionBranch ? { coordinatorSessionBranch } : {}),
			...coordinatorAuthority,
		};
	}
	const sourceSessionId = text(input.sourceSessionId) ?? text(input.sourceId);
	if (sourceSessionId !== undefined && !isCanonicalSessionId(sourceSessionId))
		return fail("invalid_input", "sourceSessionId must be a canonical safe identifier.");
	const sourceSessionPath = text(input.sourceSessionPath) ?? text(input.sourcePath) ?? text(input.sessionPath);
	if (!sourceSessionId && !sourceSessionPath)
		return fail("invalid_input", "sourceSessionId or sourceSessionPath is required to fork a session.");
	const source = await validateSavedTranscript(broker, sourceCwd, sourceSessionPath, sourceSessionId, "Source");
	if ("ok" in source) return source;
	return {
		id: randomUUID(),
		cwd,
		root: resolvedRoot,
		sourceSessionId: source.id,
		sourceSessionPath: source.path,
		sourceSessionIdentity: source.identity,
		sourceCwd,
		modelId,
		modelPreset,
		mcpServers,
		worktree,
		worktreePlan,
		...(coordinatorStateDir ? { coordinatorStateDir } : {}),
		...(coordinatorSessionId ? { coordinatorSessionId } : {}),
		...(coordinatorSessionBranch ? { coordinatorSessionBranch } : {}),
		...coordinatorAuthority,
	};
}

type ValidatedDelete = {
	storage: FileSessionStorage;
	target: VerifiedSessionDeleteTarget;
	metadataRoot: string;
	transcriptParentIdentity: { dev: string; ino: string };
};
function cleanupIdentity(
	identity: BrokerCleanupEvidence["transcriptIdentity"],
	allowEmptySha256 = false,
	requireNlink = true,
): CleanupIdentity | undefined {
	if (
		!identity ||
		!/^[0-9]+$/.test(identity.dev) ||
		!/^[0-9]+$/.test(identity.ino) ||
		(requireNlink && (typeof identity.nlink !== "string" || !/^[0-9]+$/.test(identity.nlink))) ||
		!Number.isSafeInteger(identity.size) ||
		identity.size < 0 ||
		!/^[0-9]+$/.test(identity.mtimeNs) ||
		(!allowEmptySha256 && !/^[a-f0-9]{64}$/.test(identity.sha256)) ||
		(allowEmptySha256 && identity.sha256 !== "" && !/^[a-f0-9]{64}$/.test(identity.sha256))
	)
		return undefined;
	return {
		dev: BigInt(identity.dev),
		ino: BigInt(identity.ino),
		...(typeof identity.nlink === "string" ? { nlink: BigInt(identity.nlink) } : {}),
		size: identity.size,
		mtimeNs: BigInt(identity.mtimeNs),
		sha256: identity.sha256,
	};
}

function replayDeleteTarget(cleanup: CleanupEvidence): ValidatedDelete | BrokerResponse {
	const parsedTranscriptIdentity = cleanupIdentity(cleanup.transcriptIdentity);
	const transcriptIdentity: SessionStorageFileIdentity | undefined =
		parsedTranscriptIdentity?.nlink !== undefined
			? { ...parsedTranscriptIdentity, nlink: parsedTranscriptIdentity.nlink }
			: undefined;
	const transcriptParentIdentity = cleanup.transcriptParentIdentity;
	if (
		(cleanup.phase !== "artifacts" && cleanup.phase !== "transcript") ||
		!cleanup.sessionId ||
		!isCanonicalSessionId(cleanup.sessionId) ||
		!cleanup.sessionsRoot ||
		!cleanup.transcriptPath ||
		!cleanup.cwd ||
		!cleanup.metadataRoot ||
		!transcriptIdentity ||
		!transcriptParentIdentity ||
		!/^[0-9]+$/.test(transcriptParentIdentity.dev) ||
		!/^[0-9]+$/.test(transcriptParentIdentity.ino)
	) {
		return fail("terminal_uncertain", "Cleanup replay lacks a complete ledger-bound deletion target.");
	}
	const artifactsIdentity = cleanupIdentity(cleanup.artifactsIdentity, true, false);
	const artifactTreeIdentity = cleanup.artifactTree
		? cleanupIdentity(cleanup.artifactTree.identity, true, false)
		: undefined;
	if (cleanup.artifactsAbsentAtAuthorization !== undefined && cleanup.artifactsAbsentAtAuthorization !== true)
		return fail("terminal_uncertain", "Artifact absence authority is malformed.");
	if (
		cleanup.artifactsAbsentAtAuthorization === true &&
		(cleanup.artifactsRemoved === true || artifactsIdentity !== undefined || cleanup.artifactTree !== undefined)
	)
		return fail("terminal_uncertain", "Artifact absence authority contradicts retained or completed artifacts.");
	if (cleanup.artifactTree && !artifactTreeIdentity)
		return fail("terminal_uncertain", "Artifact tree cleanup lacks its ledger-bound identity.");
	if (cleanup.artifactsRemoved !== true && (artifactsIdentity !== undefined) !== (artifactTreeIdentity !== undefined))
		return fail("terminal_uncertain", "Artifact cleanup receipt lacks its immutable tree snapshot.");
	if (cleanup.artifactsRemoved === true && (artifactsIdentity !== undefined) !== (artifactTreeIdentity !== undefined))
		return fail("terminal_uncertain", "Artifacts-removed cleanup receipt dropped its immutable tree authority.");
	if (
		artifactsIdentity &&
		artifactTreeIdentity &&
		(artifactsIdentity.dev !== artifactTreeIdentity.dev || artifactsIdentity.ino !== artifactTreeIdentity.ino)
	)
		return fail("terminal_uncertain", "Artifact cleanup tree does not match its ledger-bound root identity.");
	if (cleanup.phase === "artifacts" && cleanup.artifactsRemoved === true)
		return fail("terminal_uncertain", "Artifacts-phase cleanup receipt falsely claims artifact completion.");
	if (
		cleanup.artifactsRemoved === true &&
		cleanup.artifactTree &&
		(cleanup.artifactTree.completed !== true || cleanup.artifactTree.detachedPath !== undefined)
	)
		return fail("terminal_uncertain", "Artifacts-removed cleanup receipt retains unfinished nested authority.");
	if (cleanup.phase === "transcript" && cleanup.artifactsRemoved !== true)
		return fail("terminal_uncertain", "Transcript cleanup lacks durable artifact completion proof.");

	const retainedArtifactSidePaths = [
		cleanup.retainedArtifactsSuccessorPath,
		cleanup.retainedArtifactsPlaceholderPath,
		cleanup.retainedArtifactsUnknownPath,
	];
	const retainedArtifactSideAuthority = cleanup.retainedArtifactsSideAuthority;
	const cleanupReceiptVersion = cleanup.cleanupReceiptVersion;
	const hasRetainedArtifactSidePath = retainedArtifactSidePaths.some(
		candidate => typeof candidate === "string" && candidate.length > 0,
	);
	if ((cleanup.phase === "artifacts" || cleanup.phase === "transcript") && cleanupReceiptVersion !== 1)
		return fail("terminal_uncertain", "Cleanup replay lacks supported versioned authority.");
	if (
		cleanup.artifactsRemoved === true &&
		(cleanup.detachedArtifactsPath !== undefined ||
			retainedArtifactSidePaths.some(Boolean) ||
			retainedArtifactSideAuthority === "retained")
	)
		return fail("terminal_uncertain", "Artifacts-removed cleanup receipt retains contradictory artifact authority.");
	if (
		cleanup.artifactsRemoved !== true &&
		((retainedArtifactSideAuthority !== "none" && retainedArtifactSideAuthority !== "retained") ||
			(retainedArtifactSideAuthority === "retained") !== hasRetainedArtifactSidePath)
	)
		return fail("terminal_uncertain", "Retained artifact side authority receipt is incomplete or corrupt.");
	if ((cleanup.detachedArtifactsPath || retainedArtifactSidePaths.some(Boolean)) && !artifactsIdentity)
		return fail("terminal_uncertain", "Retained artifact cleanup lacks its ledger-bound identity.");
	const plannedArtifactsPath = cleanup.plannedArtifactsPath;
	const plannedTranscriptPath = cleanup.plannedTranscriptPath;
	if (
		(plannedArtifactsPath &&
			(path.dirname(plannedArtifactsPath) !== path.dirname(cleanup.transcriptPath) ||
				!path.basename(plannedArtifactsPath).startsWith(".gjc-delete-"))) ||
		(plannedTranscriptPath &&
			(path.dirname(plannedTranscriptPath) !== path.dirname(cleanup.transcriptPath) ||
				!path.basename(plannedTranscriptPath).startsWith(".gjc-delete-"))) ||
		(cleanup.artifactTree &&
			(path.dirname(cleanup.artifactTree.plannedPath) !== path.dirname(cleanup.transcriptPath) ||
				!path.basename(cleanup.artifactTree.plannedPath).startsWith(".gjc-delete-") ||
				(cleanup.artifactTree.detachedPath !== undefined &&
					path.dirname(cleanup.artifactTree.detachedPath) !== path.dirname(cleanup.transcriptPath)))) ||
		retainedArtifactSidePaths.some(
			candidate =>
				typeof candidate === "string" && path.dirname(candidate) !== path.dirname(cleanup.transcriptPath!),
		)
	)
		return fail("terminal_uncertain", "Cleanup replay has invalid preauthorized quarantine paths.");
	const artifactRemovingPath =
		cleanup.artifactsRemoved === true
			? undefined
			: cleanup.artifactTree
				? `${cleanup.artifactTree.plannedPath}.removing`
				: plannedArtifactsPath
					? `${plannedArtifactsPath}.removing`
					: undefined;
	const recoveredDetachedArtifactsPath =
		cleanup.detachedArtifactsPath && fsSync.existsSync(cleanup.detachedArtifactsPath)
			? cleanup.detachedArtifactsPath
			: artifactRemovingPath && fsSync.existsSync(artifactRemovingPath)
				? artifactRemovingPath
				: plannedArtifactsPath &&
						!fsSync.existsSync(cleanup.transcriptPath.slice(0, -6)) &&
						fsSync.existsSync(plannedArtifactsPath)
					? plannedArtifactsPath
					: undefined;
	const replayPlannedArtifactsPath =
		plannedArtifactsPath !== recoveredDetachedArtifactsPath ? plannedArtifactsPath : undefined;
	const recoveredDetachedTranscriptPath =
		cleanup.detachedTranscriptPath && fsSync.existsSync(cleanup.detachedTranscriptPath)
			? cleanup.detachedTranscriptPath
			: plannedTranscriptPath &&
					!fsSync.existsSync(cleanup.transcriptPath) &&
					fsSync.existsSync(plannedTranscriptPath)
				? plannedTranscriptPath
				: undefined;
	return {
		storage: new FileSessionStorage(),
		target: {
			sessionsRoot: cleanup.sessionsRoot,
			transcriptPath: cleanup.transcriptPath,
			sessionId: cleanup.sessionId,
			cwd: cleanup.cwd,
			transcriptIdentity,
			transcriptParentIdentity: {
				dev: BigInt(cleanup.transcriptParentIdentity!.dev),
				ino: BigInt(cleanup.transcriptParentIdentity!.ino),
			},
			...(cleanup.artifactsRemoved === true ? { artifactsRemoved: true } : {}),
			...(cleanup.artifactsAbsentAtAuthorization === true ? { artifactsAbsentAtAuthorization: true as const } : {}),
			...(cleanup.artifactsRemoved !== true && artifactsIdentity
				? { expectedArtifactsIdentity: artifactsIdentity }
				: {}),
			...(cleanup.artifactsRemoved !== true && recoveredDetachedArtifactsPath
				? { detachedArtifactsPath: recoveredDetachedArtifactsPath }
				: {}),
			...(cleanup.artifactsRemoved !== true && cleanup.retainedArtifactsSuccessorPath
				? { retainedArtifactsSuccessorPath: cleanup.retainedArtifactsSuccessorPath }
				: {}),
			...(cleanup.artifactsRemoved !== true && cleanup.retainedArtifactsPlaceholderPath
				? { retainedArtifactsPlaceholderPath: cleanup.retainedArtifactsPlaceholderPath }
				: {}),
			...(cleanup.artifactsRemoved !== true && cleanup.retainedArtifactsUnknownPath
				? { retainedArtifactsUnknownPath: cleanup.retainedArtifactsUnknownPath }
				: {}),
			...(recoveredDetachedTranscriptPath ? { detachedTranscriptPath: recoveredDetachedTranscriptPath } : {}),
			...(cleanup.retainedTranscriptSuccessorPath
				? { retainedTranscriptSuccessorPath: cleanup.retainedTranscriptSuccessorPath }
				: {}),
			...(cleanup.retainedTranscriptPlaceholderPath
				? { retainedTranscriptPlaceholderPath: cleanup.retainedTranscriptPlaceholderPath }
				: {}),
			...(cleanup.retainedTranscriptUnknownPath
				? { retainedTranscriptUnknownPath: cleanup.retainedTranscriptUnknownPath }
				: {}),
			...(replayPlannedArtifactsPath ? { plannedArtifactsPath: replayPlannedArtifactsPath } : {}),
			...(plannedTranscriptPath ? { plannedTranscriptPath } : {}),
			...(cleanup.artifactsRemoved !== true && cleanup.artifactTree && artifactTreeIdentity
				? {
						expectedArtifactsIdentity: artifactTreeIdentity,
						expectedArtifactsTree: cleanup.artifactTree.snapshot,
						detachedArtifactsPath: cleanup.artifactTree.detachedPath ?? recoveredDetachedArtifactsPath,
						...(replayPlannedArtifactsPath ? { plannedArtifactsPath: replayPlannedArtifactsPath } : {}),
					}
				: {}),
		},
		metadataRoot: cleanup.metadataRoot,
		transcriptParentIdentity: cleanup.transcriptParentIdentity!,
	};
}

function canonicalExistingPath(pathname: string): string {
	try {
		return fsSync.realpathSync.native(pathname);
	} catch {
		return path.resolve(pathname);
	}
}

export function canonicalDeleteLocatorPath(pathname: string): string {
	let current = path.resolve(pathname);
	const suffix: string[] = [];
	for (;;) {
		try {
			return path.join(fsSync.realpathSync.native(current), ...suffix.reverse());
		} catch {
			const parent = path.dirname(current);
			if (parent === current) return path.resolve(pathname);
			suffix.push(path.basename(current));
			current = parent;
		}
	}
}

async function validateDeletePath(
	broker: Broker,
	input: Input,
	id: string,
	record: { locator: SessionLocatorV2 } | undefined,
	cleanup?: CleanupEvidence,
): Promise<ValidatedDelete | BrokerResponse> {
	const sessionPath = text(input.sessionPath);
	const lexicalCwd = lifecycleCwd(input);
	if (!sessionPath || !lexicalCwd)
		return fail("invalid_input", "session.delete requires sessionPath and its configured cwd.");
	const requestedRoot = stateRoot(input, lexicalCwd);
	if (!requestedRoot || !hasDefaultStateRoot(lexicalCwd, requestedRoot))
		return fail("invalid_input", "stateRoot must be the default .gjc/state for cwd.");
	const cwd = canonicalExistingPath(lexicalCwd);
	const canonicalRequestedRoot = canonicalExistingPath(requestedRoot);
	if (
		record &&
		(canonicalExistingPath(record.locator.cwd) !== cwd ||
			canonicalExistingPath(record.locator.stateRoot) !== canonicalRequestedRoot)
	)
		return fail("invalid_input", "session.delete locator does not match the indexed session.");
	const candidatePath = canonicalDeleteLocatorPath(sessionPath);
	let transcriptParentStat: fsSync.BigIntStats;
	try {
		transcriptParentStat = fsSync.lstatSync(path.dirname(candidatePath), { bigint: true });
		if (!transcriptParentStat.isDirectory())
			return fail("invalid_input", "session.delete transcript parent is not a directory.");
	} catch {
		return fail("invalid_input", "session.delete transcript parent cannot be authorized.");
	}
	if (cleanup) {
		const replay = replayDeleteTarget(cleanup);
		if ("ok" in replay) return replay;
		if (
			replay.target.sessionId !== id ||
			canonicalDeleteLocatorPath(replay.target.transcriptPath) !== candidatePath ||
			canonicalExistingPath(replay.target.cwd) !== cwd ||
			canonicalExistingPath(replay.metadataRoot) !== canonicalRequestedRoot
		)
			return fail("invalid_input", "Cleanup receipt does not match the requested saved-session locator.");
		return replay;
	}
	const inventory = await managedCandidates(broker, cwd, "Saved");
	if ("ok" in inventory) return inventory;
	const matches = inventory.candidates.filter(
		candidate => canonicalExistingPath(candidate.path) === candidatePath && candidate.sessionId === id,
	);
	if (matches.length !== 1)
		return fail("invalid_input", "session.delete path is not an owned managed session for the configured cwd.");
	const match = matches[0]!;
	if (inventory.migrationPolicy === "disabled" && match.provenance === "legacy")
		return fail("legacy_migration_disabled", "Saved legacy session migration is disabled for this workspace.");

	const storage = new FileSessionStorage();
	let snapshot: SessionStorageSnapshot;
	try {
		snapshot = storage.readSnapshotSync(candidatePath);
	} catch {
		return fail("not_found", "Requested saved session does not exist or cannot be read.");
	}
	const digest = createHash("sha256").update(snapshot.bytes).digest("hex");
	if (
		snapshot.stat.dev !== match.identity.dev ||
		snapshot.stat.ino !== match.identity.ino ||
		snapshot.stat.nlink !== 1n ||
		snapshot.stat.size !== match.identity.size ||
		snapshot.stat.mtimeNs !== match.identity.mtimeNs ||
		digest !== match.identity.sha256
	)
		return fail("invalid_input", "session.delete session changed after managed ownership was verified.");
	try {
		const currentParent = fsSync.lstatSync(path.dirname(candidatePath), { bigint: true });
		if (
			!currentParent.isDirectory() ||
			currentParent.dev !== transcriptParentStat.dev ||
			currentParent.ino !== transcriptParentStat.ino
		)
			return fail("invalid_input", "session.delete transcript parent changed during authorization.");
	} catch {
		return fail("invalid_input", "session.delete transcript parent changed during authorization.");
	}
	return {
		storage,
		target: {
			sessionsRoot: canonicalExistingPath(inventory.scope.sessionsRoot),
			transcriptPath: candidatePath,
			sessionId: id,
			cwd,
			transcriptIdentity: {
				dev: snapshot.stat.dev,
				ino: snapshot.stat.ino,
				nlink: snapshot.stat.nlink,
				size: snapshot.stat.size,
				mtimeNs: snapshot.stat.mtimeNs,
				sha256: digest,
			},
			transcriptParentIdentity: { dev: transcriptParentStat.dev, ino: transcriptParentStat.ino },
		},
		metadataRoot: canonicalRequestedRoot,
		transcriptParentIdentity: {
			dev: transcriptParentStat.dev.toString(),
			ino: transcriptParentStat.ino.toString(),
		},
	};
}
type CloseAuthority = { endpointGeneration: number; endpointIncarnation: string };
type CloseRecord = {
	locator: SessionLocatorV2;
	endpointGeneration: number;
	pid: number;
	endpointMtimeMs?: number;
	endpointFileId?: string;
	lifecycleRequestId?: string;
	processIncarnation?: string;
};

function endpointIncarnation(record: CloseRecord, sessionId: string): string | undefined {
	if (
		!Number.isSafeInteger(record.endpointGeneration) ||
		record.endpointGeneration <= 0 ||
		!Number.isSafeInteger(record.pid) ||
		record.pid <= 0 ||
		typeof record.endpointMtimeMs !== "number" ||
		!Number.isFinite(record.endpointMtimeMs) ||
		record.endpointMtimeMs <= 0
	)
		return undefined;
	return createHash("sha256")
		.update(
			canonicalJson({
				endpointGeneration: record.endpointGeneration,
				endpointMtimeMs: record.endpointMtimeMs,
				...(record.endpointFileId === undefined ? {} : { endpointFileId: record.endpointFileId }),
				pid: record.pid,
				sessionId,
			}),
		)
		.digest("hex");
}

function requestedCloseAuthority(input: Input): { authority: CloseAuthority | undefined } | { error: BrokerResponse } {
	const endpointGeneration = input.endpointGeneration;
	const endpointIncarnation = input.endpointIncarnation;
	if (endpointGeneration === undefined && endpointIncarnation === undefined) return { authority: undefined };
	if (
		typeof endpointGeneration !== "number" ||
		!Number.isSafeInteger(endpointGeneration) ||
		endpointGeneration <= 0 ||
		typeof endpointIncarnation !== "string" ||
		!/^[a-f0-9]{64}$/.test(endpointIncarnation)
	)
		return {
			error: fail("invalid_input", "session.close endpoint authority is invalid"),
		};
	return { authority: { endpointGeneration, endpointIncarnation } };
}

function sameCloseAuthority(authority: CloseAuthority, record: CloseRecord, sessionId: string): boolean {
	return (
		authority.endpointGeneration === record.endpointGeneration &&
		authority.endpointIncarnation === endpointIncarnation(record, sessionId)
	);
}

function sameCloseStoredProcessIdentity(expected: CloseRecord, current: CloseRecord): boolean {
	return (
		current.pid === expected.pid &&
		current.endpointFileId === expected.endpointFileId &&
		typeof expected.processIncarnation === "string" &&
		expected.processIncarnation.length > 0 &&
		current.processIncarnation === expected.processIncarnation &&
		typeof expected.lifecycleRequestId === "string" &&
		expected.lifecycleRequestId.length > 0 &&
		current.lifecycleRequestId === expected.lifecycleRequestId &&
		path.resolve(current.locator.cwd) === path.resolve(expected.locator.cwd) &&
		path.resolve(current.locator.stateRoot) === path.resolve(expected.locator.stateRoot)
	);
}

/**
 * Endpoint control remains safe without a durable signal identity: the caller has
 * just read and re-read this exact generation before connecting. This narrower
 * identity is never sufficient for signal fallback, but permits the host's typed
 * close response to remain observable instead of being masked as stale.
 */
function sameCloseEndpointIdentity(expected: CloseRecord, current: CloseRecord): boolean {
	return (
		current.endpointGeneration === expected.endpointGeneration &&
		current.pid === expected.pid &&
		current.endpointMtimeMs !== undefined &&
		expected.endpointMtimeMs !== undefined &&
		current.endpointFileId === expected.endpointFileId &&
		current.lifecycleRequestId === expected.lifecycleRequestId &&
		path.resolve(current.locator.cwd) === path.resolve(expected.locator.cwd) &&
		path.resolve(current.locator.stateRoot) === path.resolve(expected.locator.stateRoot)
	);
}

function sameCloseProcessIdentity(expected: CloseRecord, current: CloseRecord & { live: boolean }): boolean {
	return current.live && sameCloseStoredProcessIdentity(expected, current);
}

function sameCloseGeneration(expected: CloseRecord, current: CloseRecord & { live: boolean }): boolean {
	return (
		current.live &&
		current.endpointGeneration === expected.endpointGeneration &&
		current.pid === expected.pid &&
		current.endpointMtimeMs === expected.endpointMtimeMs &&
		current.endpointFileId === expected.endpointFileId &&
		current.lifecycleRequestId === expected.lifecycleRequestId &&
		current.processIncarnation === expected.processIncarnation &&
		path.resolve(current.locator.cwd) === path.resolve(expected.locator.cwd) &&
		path.resolve(current.locator.stateRoot) === path.resolve(expected.locator.stateRoot)
	);
}

async function revalidateCloseGeneration(
	broker: Broker,
	id: string,
	expected: CloseRecord,
	authority: CloseAuthority | undefined,
): Promise<BrokerResponse | undefined> {
	await broker.index.refresh();
	const current = broker.index.listSessions().sessions.find(session => session.sessionId === id);
	if (
		!authority &&
		current &&
		(sameCloseEndpointIdentity(expected, current) || sameCloseStoredProcessIdentity(expected, current))
	) {
		expected.endpointMtimeMs = current.endpointMtimeMs;
		return undefined;
	}
	return authority && current && sameCloseGeneration(expected, current) && sameCloseAuthority(authority, current, id)
		? undefined
		: fail("endpoint_stale", "session endpoint is stale");
}

function isTransportFailure(error: unknown): error is SdkClientError {
	return (
		error instanceof SdkClientError &&
		["unavailable", "timeout", "connection_closed", "reconnect_exhausted"].includes(error.code)
	);
}

function closeEndpoint(endpoint: unknown): { url: string; token: string } | undefined {
	if (typeof endpoint !== "object" || endpoint === null) return undefined;
	const value = endpoint as { url?: unknown; token?: unknown };
	return typeof value.url === "string" && typeof value.token === "string"
		? { url: value.url, token: value.token }
		: undefined;
}

/** Executes broker-owned global lifecycle effects. */
async function executeLifecycleResponse(
	broker: Broker,
	operation: string,
	input: Input,
	identity: string,
	cleanup?: CleanupEvidence,
): Promise<BrokerResponse> {
	const requestedSessionId = cleanup && operation === "session.delete" ? cleanup.sessionId : sessionId(input);
	if (requestedSessionId !== undefined && !isCanonicalSessionId(requestedSessionId))
		return fail("invalid_input", "sessionId must be a canonical safe identifier.");
	if (
		operation === "session.delete" &&
		requestedSessionId &&
		broker.ledger.hasUncertainCleanupForSession(requestedSessionId, identity)
	)
		return fail("terminal_uncertain", "Prior cleanup authority for this session is corrupt or incomplete.");
	const requestedSourceSessionId = text(input.sourceSessionId) ?? text(input.sourceId);
	if (requestedSourceSessionId !== undefined && !isCanonicalSessionId(requestedSourceSessionId))
		return fail("invalid_input", "sourceSessionId must be a canonical safe identifier.");
	if (operation === "session.create" || operation === "session.fork" || operation === "session.resume") {
		await broker.index.refresh();
		await broker.heartbeatSessions();
		await broker.index.refresh();
		if (operation === "session.resume") {
			const requestedSessionId = sessionId(input);
			const authority = requestedSessionId
				? liveResumeAuthority(broker.index.listSessions().sessions, requestedSessionId)
				: { kind: "none" as const };
			if (authority.kind === "ambiguous")
				return fail("endpoint_stale", "Session authority is ambiguous and cannot be resumed safely.");
			const existing = authority.kind === "live" ? authority.record : undefined;
			if (existing?.live) {
				const initialScope = await validateLiveResumeScope(broker, input, requestedSessionId!, existing);
				if ("ok" in initialScope) return initialScope;
				const initialIncarnation = endpointIncarnation(existing, requestedSessionId!);
				if (!initialIncarnation)
					return fail("live_session", "Session is already live but its endpoint incarnation is unavailable.");
				const endpoint = await broker.handleRequest("session.get_endpoint", {
					sessionId: requestedSessionId,
					endpointGeneration: existing.endpointGeneration,
					endpointIncarnation: initialIncarnation,
				});
				if (!endpoint.ok)
					return fail(
						"live_session",
						"Session is already live but its incarnation-bound endpoint is unavailable.",
					);
				const finalScope = await validateLiveResumeScope(broker, input, requestedSessionId!, existing);
				if ("ok" in finalScope) return finalScope;
				if (!sameResumeSessionIdentity(initialScope, finalScope))
					return fail("endpoint_stale", "Saved session changed while its resume authority was being verified.");
				await broker.index.refresh();
				const finalAuthority = liveResumeAuthority(broker.index.listSessions().sessions, requestedSessionId!);
				if (finalAuthority.kind === "ambiguous")
					return fail("endpoint_stale", "Session authority became ambiguous while it was being verified.");
				const current = finalAuthority.kind === "live" ? finalAuthority.record : undefined;
				if (!current || !sameLiveResumeRecord(existing, current))
					return fail("endpoint_stale", "Live session changed while its resume authority was being verified.");
				if (current.endpointMtimeMs === undefined)
					return fail("endpoint_stale", "Live session endpoint authority is incomplete.");
				return {
					ok: true,
					result: {
						sessionId: requestedSessionId,
						cwd: finalScope.cwd,
						endpointGeneration: current.endpointGeneration,
						pid: current.pid,
						endpointMtimeMs: current.endpointMtimeMs,
						...(current.endpointFileId === undefined ? {} : { endpointFileId: current.endpointFileId }),
						endpoint: endpoint.result,
						reused: true,
					},
				};
			}
		}
		const timing = lifecycleTiming(broker);
		const admissionGranted = startupAdmittedInputs.has(input);
		if (!admissionGranted) {
			const suppliedDeadlineFields = [
				input.receivedAt,
				input.requestedReadinessTimeoutMs,
				input.semanticReadyDeadlineAt,
				input.terminationStartDeadlineAt,
				input.lifecycleCleanupDeadlineAt,
			];
			let requestedReadinessTimeoutMs: number;
			if (suppliedDeadlineFields.some(value => value !== undefined)) {
				const supplied = lifecycleDeadlines(input, timing.now());
				if ("ok" in supplied) return supplied;
				requestedReadinessTimeoutMs = supplied.requestedReadinessTimeoutMs;
			} else {
				const timeout = readinessTimeout(input);
				if (typeof timeout !== "number") return timeout;
				requestedReadinessTimeoutMs = timeout;
			}
			const queueWaitMs = startupQueueWaitMs(requestedReadinessTimeoutMs);
			const launch = await launchInput(broker, operation, input);
			if ("ok" in launch) return launch;
			if (launch.worktreePlan && deadlineFieldsPresent(input)) {
				return fail(
					"invalid_input",
					"Lifecycle worktree launches cannot carry a caller-supplied child deadline tuple.",
				);
			}
			const admitted = await broker.runStartup(queueWaitMs, timing, async admittedAt => {
				const admittedInput = launch.worktreePlan
					? { ...input, admittedAt, requestedReadinessTimeoutMs }
					: { ...input, ...deriveLifecycleDeadlines(admittedAt, requestedReadinessTimeoutMs) };
				startupAdmittedInputs.add(admittedInput);
				startupLaunchInputs.set(admittedInput, launch);
				try {
					return await executeLifecycleResponse(broker, operation, admittedInput, identity, cleanup);
				} finally {
					startupLaunchInputs.delete(admittedInput);
					startupAdmittedInputs.delete(admittedInput);
				}
			});
			if (admitted.status === "completed") return admitted.value;
			if (admitted.status === "admission_refused")
				return fail(
					"startup_admission_refused",
					"SDK host startup was refused because the broker no longer owns the session root.",
				);
			const failure = normalizeSdkStartupFailure("startup", admitted.reason);
			return fail("startup_admission_timeout", failure.message);
		}

		const launch = startupLaunchInputs.get(input) ?? (await launchInput(broker, operation, input));
		if ("ok" in launch) return launch;
		if (launch.worktreePlan && deadlineFieldsPresent(input) && input.admittedAt === undefined) {
			return fail(
				"invalid_input",
				"Lifecycle worktree launches cannot carry a caller-supplied child deadline tuple.",
			);
		}

		let childDeadlines: LifecycleDeadlines | undefined;
		let lifecycleDeadline: number;
		let readinessDeadline: number;
		let terminationStartDeadline: number;
		let outerCleanupDeadlineAt: number | undefined;
		if (launch.worktreePlan) {
			const prepTimeouts = readPreparationTimeouts(input);
			if (!prepTimeouts.ok) return fail("invalid_input", PREPARATION_TIMEOUT_INVALID_MESSAGE);
			const admittedAt =
				typeof input.admittedAt === "number" && Number.isSafeInteger(input.admittedAt)
					? input.admittedAt
					: timing.now();
			const requestedReadinessTimeoutMs =
				typeof input.requestedReadinessTimeoutMs === "number" &&
				isValidReadinessTimeoutMs(input.requestedReadinessTimeoutMs)
					? input.requestedReadinessTimeoutMs
					: readinessTimeout(input);
			if (typeof requestedReadinessTimeoutMs !== "number") return requestedReadinessTimeoutMs;
			const outer = deriveLifecycleOuterDeadlines({
				admittedAt,
				worktreePrepTimeoutMs: prepTimeouts.worktreePrepTimeoutMs,
				dependencyPrepTimeoutMs: prepTimeouts.dependencyPrepTimeoutMs,
				requestedReadinessTimeoutMs,
			});
			outerCleanupDeadlineAt = outer.lifecycleCleanupDeadlineAt;
			lifecycleDeadline = outer.lifecycleCleanupDeadlineAt;
			readinessDeadline = outer.lifecycleCleanupDeadlineAt;
			terminationStartDeadline = outer.lifecycleCleanupDeadlineAt;
		} else {
			const deadlines = lifecycleDeadlines(input, input.receivedAt as number);
			if ("ok" in deadlines) return deadlines;
			childDeadlines = deadlines;
			lifecycleDeadline = deadlines.lifecycleCleanupDeadlineAt;
			readinessDeadline = deadlines.semanticReadyDeadlineAt;
			terminationStartDeadline = deadlines.terminationStartDeadlineAt;
		}

		if (!hasProcessIncarnationAuthority())
			return fail(
				"incarnation_unavailable",
				"OS process incarnation authority is unavailable; refusing to spawn a lifecycle session.",
			);
		if (launch.worktreePlan) {
			const occupant = worktreeOccupant(broker.index.listSessions().sessions, launch.worktreePlan.worktreePath);
			if (occupant && occupant !== launch.id)
				return fail(
					"worktree_in_use",
					`The requested worktree is already held by session ${occupant}. Choose another worktree name or stop that session.`,
				);
		}
		const effectMarker = randomUUID();
		const plannedWorktreeIntent = worktreeIntent(launch.worktreePlan);
		const effectIntent: LifecycleEffectIntentWithDeadline = {
			sessionId: launch.id,
			stateRoot: launch.root,
			childOwnershipEstablished: false,
			lifecycleCleanupDeadlineAt:
				outerCleanupDeadlineAt ?? (childDeadlines as LifecycleDeadlines).lifecycleCleanupDeadlineAt,
			...(plannedWorktreeIntent ? { worktree: plannedWorktreeIntent } : {}),
		};

		await broker.ledger.transition(identity, "effect_started", {
			intendedSessionId: launch.id,
			effectMarker,
			effectIntent,
		});
		if (!hasProcessIncarnationAuthority())
			return fail(
				"incarnation_unavailable",
				"OS process incarnation authority is unavailable; refusing to prepare a lifecycle worktree.",
			);
		let worktreeReceipt: SessionLifecycleWorktreeReceipt | undefined;
		try {
			if (launch.worktreePlan) {
				const prepTimeouts = readPreparationTimeouts(input);
				if (!prepTimeouts.ok) return fail("invalid_input", PREPARATION_TIMEOUT_INVALID_MESSAGE);
				const admittedAt =
					typeof input.admittedAt === "number" && Number.isSafeInteger(input.admittedAt)
						? input.admittedAt
						: timing.now();
				const requestedReadinessTimeoutMs =
					typeof input.requestedReadinessTimeoutMs === "number" &&
					isValidReadinessTimeoutMs(input.requestedReadinessTimeoutMs)
						? input.requestedReadinessTimeoutMs
						: readinessTimeout(input);
				if (typeof requestedReadinessTimeoutMs !== "number") return requestedReadinessTimeoutMs;
				const outer = deriveLifecycleOuterDeadlines({
					admittedAt,
					worktreePrepTimeoutMs: prepTimeouts.worktreePrepTimeoutMs,
					dependencyPrepTimeoutMs: prepTimeouts.dependencyPrepTimeoutMs,
					requestedReadinessTimeoutMs,
				});
				const controller = new AbortController();
				const worktreeStartedAt = timing.now();
				const worktreeWatch = abortWhenDue(controller, outer.worktreePreparationDeadlineAt, () => timing.now());
				try {
					worktreeReceipt = await preparePlannedWorktree(launch.worktreePlan, {
						signal: controller.signal,
						deadlineAt: outer.worktreePreparationDeadlineAt,
						now: () => timing.now(),
					});
				} finally {
					clearInterval(worktreeWatch);
				}
				const worktreeDoneAt = timing.now();
				const worktreePreparationMs = Math.max(0, worktreeDoneAt - worktreeStartedAt);
				await broker.ledger.transition(identity, "effect_started", {
					durableEffects: durableWorktreeEffects(worktreeReceipt, { worktreePreparationMs }),
				});
				const remainingDepBudget = Math.min(
					prepTimeouts.dependencyPrepTimeoutMs,
					Math.max(0, outer.lifecycleCleanupDeadlineAt - worktreeDoneAt - requestedReadinessTimeoutMs),
				);
				const dependencyDeadlineAt = worktreeDoneAt + remainingDepBudget;
				if (timing.now() >= dependencyDeadlineAt) throw new DependencyPreparationTimeoutError();
				const depWatch = abortWhenDue(controller, dependencyDeadlineAt, () => timing.now());
				const depHook = ensureReusableNodeModulesForTest;
				const dependencyStartedAt = timing.now();
				try {
					if (depHook) {
						await depHook(launch.worktreePlan.repoRoot, launch.worktreePlan.worktreePath, {
							signal: controller.signal,
							deadlineAt: dependencyDeadlineAt,
						});
					} else {
						await ensureReusableNodeModulesCancellable(
							launch.worktreePlan.repoRoot,
							launch.worktreePlan.worktreePath,
							{
								signal: controller.signal,
								deadlineAt: dependencyDeadlineAt,
								now: () => timing.now(),
							},
						);
					}
				} finally {
					clearInterval(depWatch);
				}
				const dependencyPreparationMs = Math.max(0, timing.now() - dependencyStartedAt);
				await broker.ledger.transition(identity, "effect_started", {
					durableEffects: durableWorktreeEffects(worktreeReceipt, {
						worktreePreparationMs,
						dependencyPreparationMs,
						spawnAuthorizedAtOffsetMs: Math.max(0, timing.now() - admittedAt),
					}),
				});
				const prepSucceededAt = timing.now();
				childDeadlines = deriveLifecycleDeadlines(prepSucceededAt, requestedReadinessTimeoutMs);
				readinessDeadline = childDeadlines.semanticReadyDeadlineAt;
				terminationStartDeadline = childDeadlines.terminationStartDeadlineAt;
				lifecycleDeadline = childDeadlines.lifecycleCleanupDeadlineAt;
			}
			await reapDeadLifecycleMarkers(launch.root);
		} catch (error) {
			if (launch.worktreePlan && worktreeReceipt?.created && !worktreeReceipt.reused) {
				removeOwnedLaunchWorktree(launch.worktreePlan, worktreeReceipt);
			}
			return mapPreparationFailure(error);
		}
		if (!launch.worktreePlan && timing.now() >= readinessDeadline)
			return fail(
				"readiness_timeout",
				"Lifecycle preparation exhausted the semantic readiness deadline before spawning.",
			);
		if (launch.worktreePlan && !childDeadlines)
			return fail(
				worktreeReceipt ? "dependency_preparation_timeout" : "worktree_preparation_timeout",
				worktreeReceipt
					? "Dependency preparation exceeded its deadline before the session host was spawned."
					: "Worktree preparation exceeded its deadline before the session host was spawned.",
			);
		if (!hasProcessIncarnationAuthority())
			return fail(
				"incarnation_unavailable",
				"OS process incarnation authority is unavailable; refusing to spawn a lifecycle session.",
			);
		const deadlines = childDeadlines as LifecycleDeadlines;

		const coordinatorSidecarTarget =
			typeof launch.coordinatorStateDir === "string" && typeof launch.coordinatorSidecarKeyId === "string"
				? {
						coordinatorStateDir: launch.coordinatorStateDir,
						coordinatorSidecarKeyId: launch.coordinatorSidecarKeyId,
					}
				: {};
		const request: SessionLifecycleLaunchRequest = {
			operation,
			sessionId: launch.id,
			cwd: launch.cwd,
			stateRoot: launch.root,
			effectMarker,
			receivedAt: deadlines.receivedAt,
			requestedReadinessTimeoutMs: deadlines.requestedReadinessTimeoutMs,
			semanticReadyDeadlineAt: deadlines.semanticReadyDeadlineAt,
			terminationStartDeadlineAt: deadlines.terminationStartDeadlineAt,
			lifecycleCleanupDeadlineAt: deadlines.lifecycleCleanupDeadlineAt,
			...(launch.sourceSessionId ? { sourceSessionId: launch.sourceSessionId } : {}),
			...(launch.sourceSessionPath ? { sourceSessionPath: launch.sourceSessionPath } : {}),
			...(launch.sourceSessionIdentity ? { sourceSessionIdentity: launch.sourceSessionIdentity } : {}),
			...(launch.sourceCwd ? { sourceCwd: launch.sourceCwd } : {}),
			...(launch.sessionPath ? { sessionPath: launch.sessionPath } : {}),
			...(launch.sessionIdentity ? { sessionIdentity: launch.sessionIdentity } : {}),
			...(launch.modelPreset ? { modelPreset: launch.modelPreset } : {}),
			...(launch.modelId ? { modelId: launch.modelId } : {}),
			...(launch.mcpServers ? { mcpServers: launch.mcpServers } : {}),
			...(launch.worktree ? { worktree: launch.worktree } : {}),
			...(launch.readiness ? { readiness: launch.readiness } : {}),
			...coordinatorSidecarTarget,
			...(launch.coordinatorSessionId ? { coordinatorSessionId: launch.coordinatorSessionId } : {}),
			...(launch.coordinatorSessionBranch ? { coordinatorSessionBranch: launch.coordinatorSessionBranch } : {}),
		};
		let child: ChildProcess | undefined;
		let spawnedAuthority: EffectMarker | undefined;
		let childSpawned = false;
		try {
			const authorizedSpawn = broker.runSynchronousEffectWithFreshPublicationAuthority(() => {
				const cmd = command(broker);
				return spawn(cmd.file, cmd.args, {
					cwd: launch.cwd,
					detached: true,
					// stdio stays "ignore": `unref()` does not detach an active
					// stdio handle, so a parent-owned stderr pipe would keep the
					// broker process alive for the host's whole lifetime (retention
					// through restart/shutdown). Host stderr is therefore discarded
					// by the OS rather than captured (#4712 review).
					stdio: "ignore",
					env: {
						// Master capability is process-local to direct Bash children and must
						// never cross a broker lifecycle launch boundary.
						...Object.fromEntries(
							Object.entries("kind" in cmd ? cmd.env : process.env).filter(
								([key]) => key !== "GJC_MASTER_CAPABILITY",
							),
						),
						GJC_AGENT_DIR: broker.settings.agentDir,
						GJC_CODING_AGENT_DIR: broker.settings.agentDir,
						GJC_SESSION_ID: launch.id,
						GJC_STATE_ROOT: launch.root,
						GJC_LIFECYCLE_REQUEST_ID: effectMarker,
						GJC_SDK_LIFECYCLE_REQUEST: JSON.stringify(request),
						// Coordinator-correlation env scoped to this designated launch only (#2549).
						// The runtime sidecar reads these to write terminal state to the
						// coordinator-shared file instead of an unread session-local fallback.
						// The broker computes the file path from coordinatorStateDir + launch.id
						// because the session ID is generated at spawn time.
						...(launch.coordinatorStateDir
							? {
									[GJC_COORDINATOR_SESSION_STATE_FILE_ENV]: path.join(
										launch.coordinatorStateDir,
										"session-states",
										`${launch.id}.json`,
									),
								}
							: {}),
						...(launch.coordinatorSessionId
							? { [GJC_COORDINATOR_SESSION_ID_ENV]: launch.coordinatorSessionId }
							: {}),
						...(launch.coordinatorSessionBranch
							? { [GJC_COORDINATOR_SESSION_BRANCH_ENV]: launch.coordinatorSessionBranch }
							: {}),
						...(launch.coordinatorSidecarSigningKey
							? {
									[GJC_COORDINATOR_SIDECAR_SIGNATURE_REQUIRED_ENV]: "true",
									[GJC_COORDINATOR_SIDECAR_SIGNING_KEY_ENV]: launch.coordinatorSidecarSigningKey,
									[GJC_COORDINATOR_SIDECAR_KEY_ID_ENV]: launch.coordinatorSidecarKeyId,
								}
							: {}),
					},
				});
			});
			if (!authorizedSpawn.authorized) {
				return fail(
					"startup_admission_refused",
					"SDK host startup was refused because the broker no longer owns the session root.",
				);
			}
			const spawned = authorizedSpawn.value;
			child = spawned;
			await waitForChildSpawn(spawned);
			childSpawned = true;
			const pid = spawned.pid;
			if (!pid) throw new Error("spawned session has no pid");
			const incarnation = processIncarnationForBroker(broker, pid);
			if (!incarnation) throw new Error("spawned session has no readable OS incarnation");
			spawnedAuthority = { pid, effectMarker, incarnation };
			await broker.ledger.transition(identity, "effect_started", {
				effectIntent: { ...effectIntent, childOwnershipEstablished: true },
			});
			await writeEffectMarker(launch.root, launch.id, spawnedAuthority);
			spawned.unref();
		} catch (error) {
			const terminated =
				child && childSpawned
					? await terminateSpawnedChild(
							child,
							broker,
							launch.id,
							launch.root,
							lifecycleDeadline,
							terminationStartDeadline,
							spawnedAuthority,
							timing,
						)
					: true;

			return terminated
				? fail("spawn_failed", `Unable to spawn session: ${error instanceof Error ? error.message : String(error)}`)
				: fail(
						"terminal_uncertain",
						`Unable to establish spawned-session ownership and could not prove the child dead: ${error instanceof Error ? error.message : String(error)}`,
					);
		}
		if (!child || !spawnedAuthority) {
			return fail("spawn_failed", "Unable to retain the spawned session process identity.");
		}
		await broker.ledger.transition(identity, "awaiting_ready", { intendedSessionId: launch.id, effectMarker });
		const readiness = await waitForReady(
			broker,
			launch.id,
			launch.root,
			readinessDeadline,
			spawnedAuthority,
			timing,
			launch.readiness === "deferred" ? SESSION_PREPARED_EVENT : "session_ready",
		);

		if (readiness.kind !== "ready") {
			const terminated = await terminateSpawnedChild(
				child,
				broker,
				launch.id,
				launch.root,
				lifecycleDeadline,
				terminationStartDeadline,
				spawnedAuthority,
				timing,
			);

			if (!terminated)
				return readiness.kind === "ready_probe_failed"
					? fail(
							"endpoint_unreadable",
							`Session ${launch.id} exited, and its readiness could not be determined: ${describeReadyProbeFailure(readiness.probe)}; cleanup could not be proven.`,
						)
					: fail(
							"terminal_uncertain",
							`Session ${launch.id} did not become ready and its spawned process could not be verified dead.`,
						);
			// Host stderr never reaches caller-visible error strings: the detached
			// host handles launch configuration and inherited credentials, so its
			// output cannot be proven free of secret material — it is discarded at
			// the OS level (stdio "ignore"), never captured (#4712 review).
			return readiness.kind === "startup_failed"
				? fail(
						readiness.failure.code ?? "spawn_failed",
						readiness.failure.message,
						undefined,
						readiness.failure.details,
					)
				: readiness.kind === "ready_then_exited"
					? readyThenExitedResponse(launch.id, child)
					: readiness.kind === "ready_probe_failed"
						? fail(
								"endpoint_unreadable",
								`Session ${launch.id} exited, and its readiness could not be determined: ${describeReadyProbeFailure(readiness.probe)}.`,
							)
						: readiness.kind === "child_exited"
							? fail("spawn_failed", `Session ${launch.id} exited before registering readiness.`)
							: fail(
									"readiness_timeout",
									`Session ${launch.id} did not register an endpoint before the readiness timeout.`,
								);
		}
		await reconcileReadyScope(broker, launch.id, launch.cwd, launch.root, spawnedAuthority);
		const verified = await currentReadyAuthority(broker, launch.id, launch.root, spawnedAuthority);
		if (!verified || !sameReadyAuthority(readiness.authority, verified)) {
			const exited =
				child.exitCode !== null ||
				observeProcess(spawnedAuthority.pid, spawnedAuthority.incarnation, value =>
					processIncarnationForBroker(broker, value),
				) === "exited";
			const terminated = await terminateSpawnedChild(
				child,
				broker,
				launch.id,
				launch.root,
				lifecycleDeadline,
				terminationStartDeadline,
				spawnedAuthority,
				timing,
			);
			if (exited && readyThenExitToleranceEnabled())
				return terminated
					? readyThenExitedResponse(launch.id, child)
					: fail(
							"terminal_uncertain",
							`Session ${launch.id} ${READY_THEN_EXIT_MESSAGE} and cleanup could not be proven.`,
						);
			return terminated
				? fail("endpoint_stale", "Session endpoint changed while lifecycle readiness was being verified.")
				: fail(
						"terminal_uncertain",
						"Session readiness authority changed and its spawned process could not be verified dead.",
					);
		}
		return {
			ok: true,
			result: {
				sessionId: launch.id,
				cwd: launch.cwd,
				endpointGeneration: verified.endpointGeneration,
				pid: verified.endpoint.pid,
				endpointMtimeMs: verified.endpointMtimeMs,
				...(verified.endpointFileId === undefined ? {} : { endpointFileId: verified.endpointFileId }),
				endpoint: verified.endpoint,
				// Public, ledger-replayable evidence of the bootstrap authority that
				// reached this runtime. The private key never enters the response.
				...(launch.coordinatorSidecarKeyId ? { coordinatorSidecarKeyId: launch.coordinatorSidecarKeyId } : {}),
				...(launch.readiness === "deferred" ? { readiness: "prepared" as const } : {}),
				...(worktreeReceipt ? { worktree: worktreeReceipt } : {}),
			},
		};
	}

	const id = cleanup && operation === "session.delete" ? cleanup.sessionId : sessionId(input);
	if (!id) return fail("invalid_input", "sessionId is required.");
	if (!isCanonicalSessionId(id)) return fail("invalid_input", "sessionId must be a canonical safe identifier.");
	await broker.index.refresh();
	let record = broker.index.listSessions().sessions.find(session => session.sessionId === id);
	if (operation === "session.close") {
		if (!record) return fail("not_found", "session is not indexed");
		if (record.terminalUncertain)
			return fail("terminal_uncertain", "Session ownership is uncertain and cannot be closed safely.");
		if (!isSessionAuthorityEligible(record))
			return fail("endpoint_stale", "Session authority is ambiguous and cannot be closed safely.");
		if (!record.live && !record.terminal) {
			await broker.heartbeatSessions();
			await broker.index.refresh();
			record = broker.index.listSessions().sessions.find(session => session.sessionId === id);
			if (!record) return fail("not_found", "session is not indexed");
			if (record.terminalUncertain)
				return fail("terminal_uncertain", "Session ownership is uncertain and cannot be closed safely.");
			if (!isSessionAuthorityEligible(record))
				return fail("endpoint_stale", "Session authority is ambiguous and cannot be closed safely.");
		}
		const requestedAuthority = requestedCloseAuthority(input);
		if ("error" in requestedAuthority) return requestedAuthority.error;
		if (requestedAuthority.authority && !sameCloseAuthority(requestedAuthority.authority, record, id))
			return fail("endpoint_stale", "session endpoint is stale");
		await broker.ledger.transition(identity, "effect_started", { intendedSessionId: id, effectMarker: randomUUID() });
		const signalAuthority: EffectMarker | undefined =
			typeof record.lifecycleRequestId === "string" && typeof record.processIncarnation === "string"
				? { pid: record.pid, effectMarker: record.lifecycleRequestId, incarnation: record.processIncarnation }
				: undefined;
		let processExitObserver = stableProcessExitObserver(record);

		let usedSignalFallback = false;
		let note: string | undefined;
		let endpointResult = await broker.handleRequest("session.get_endpoint", {
			sessionId: id,
			endpointGeneration: record.endpointGeneration,
		});
		if (!endpointResult.ok && endpointResult.error.code === "endpoint_stale" && !requestedAuthority.authority) {
			await broker.index.refresh();
			await broker.heartbeatSessions();
			const refreshed = broker.index.listSessions().sessions.find(session => session.sessionId === id);
			if (refreshed && sameCloseProcessIdentity(record, refreshed)) {
				record = refreshed;
				endpointResult = await broker.handleRequest("session.get_endpoint", {
					sessionId: id,
					endpointGeneration: record.endpointGeneration,
				});
			}
		}
		if (!endpointResult.ok) {
			if (endpointResult.error.code === "endpoint_stale") return endpointResult;
			if (endpointResult.error.code !== "resource_gone") return endpointResult;
			usedSignalFallback = true;
		} else {
			const endpoint = closeEndpoint(endpointResult.result);
			if (!endpoint) return fail("close_refused", "Session endpoint is malformed.");
			let client: SdkClient | undefined;
			try {
				client = await SdkClient.connect(endpoint.url, endpoint.token, {
					timeoutMs: 2_000,
					reconnectAttempts: 0,
				});
				let refreshedEndpointResult = await broker.handleRequest("session.get_endpoint", {
					sessionId: id,
					endpointGeneration: record.endpointGeneration,
				});
				if (
					!refreshedEndpointResult.ok &&
					refreshedEndpointResult.error.code === "endpoint_stale" &&
					!requestedAuthority.authority
				) {
					await broker.index.refresh();
					const heartbeatRecord = broker.index.listSessions().sessions.find(session => session.sessionId === id);
					if (
						heartbeatRecord &&
						heartbeatRecord.endpointGeneration === record.endpointGeneration &&
						sameCloseProcessIdentity(record, heartbeatRecord)
					) {
						record = heartbeatRecord;
						refreshedEndpointResult = await broker.handleRequest("session.get_endpoint", {
							sessionId: id,
							endpointGeneration: record.endpointGeneration,
						});
					}
				}
				if (!refreshedEndpointResult.ok) return refreshedEndpointResult;
				await broker.index.refresh();
				const refreshedRecord = broker.index.listSessions().sessions.find(session => session.sessionId === id);
				if (!refreshedRecord || !sameCloseEndpointIdentity(record, refreshedRecord))
					return fail("endpoint_stale", "session endpoint is stale");
				record = refreshedRecord;
				const refreshedEndpoint = closeEndpoint(refreshedEndpointResult.result);
				if (
					!refreshedEndpoint ||
					refreshedEndpoint.url !== endpoint.url ||
					refreshedEndpoint.token !== endpoint.token
				)
					return fail("endpoint_stale", "session endpoint is stale");
				const stale = await revalidateCloseGeneration(broker, id, record, requestedAuthority.authority);
				if (stale) return stale;
				if (record.lifecycleRequestId === undefined) {
					usedSignalFallback = true;
				} else {
					processExitObserver ??= stableProcessExitObserver(record);
					const response = await client.control("session.close", {
						[BROKER_RUNTIME_CLOSE_CAPABILITY_FIELD]: record.lifecycleRequestId,
					});
					if ((response as { ok?: unknown }).ok !== true) {
						const closeError = (response as { error?: { code?: unknown } }).error;
						if (closeError?.code === "operation_prohibited") usedSignalFallback = true;
						else return fail("close_refused", "Session endpoint rejected session.close.");
					}
				}
			} catch (error) {
				if (isTransportFailure(error)) usedSignalFallback = true;
				else if (error instanceof SdkClientError && error.code === "operation_prohibited")
					usedSignalFallback = true;
				else if (error instanceof SdkClientError) return fail(error.code, error.message);
				else
					return fail(
						"close_refused",
						`Session endpoint close failed: ${error instanceof Error ? error.message : String(error)}`,
					);
			} finally {
				await client
					?.close()
					.catch(error =>
						logger.warn(
							`SDK session-close client cleanup failed after control dispatch: ${error instanceof Error ? error.message : String(error)}`,
						),
					);
			}
		}

		if (usedSignalFallback) {
			const stale = await revalidateCloseGeneration(broker, id, record, requestedAuthority.authority);
			if (stale) return stale;
			processExitObserver ??= stableProcessExitObserver(record);
			const exited =
				typeof record.processIncarnation === "string" &&
				observeProcess(record.pid, record.processIncarnation, value =>
					processIncarnationForBroker(broker, value),
				) === "exited";
			if (!exited) {
				if (!(await signalVerifiedSession(record, id, "SIGTERM", signalAuthority)))
					return fail(
						"close_refused",
						"Session endpoint is unavailable and its durable process identity could not be verified.",
					);
				note = "Endpoint close was unreachable; sent SIGTERM to the durably identified session process.";
			}
		}

		let closed = await waitForClose(broker, id, record, CLOSE_TIMEOUT_MS, processExitObserver);
		if (!closed && !usedSignalFallback) {
			const stale = await revalidateCloseGeneration(broker, id, record, requestedAuthority.authority);
			if (stale) return stale;
			if (!(await signalVerifiedSession(record, id, "SIGTERM", signalAuthority))) {
				await recordTerminalUncertain(broker, id, record.locator.stateRoot, record.pid);
				return fail(
					"terminal_uncertain",
					"Session acknowledged session.close but its durable process identity could not be verified for shutdown escalation.",
				);
			}
			note =
				"Session acknowledged session.close but graceful teardown did not complete within the bounded deadline; sent SIGTERM to the durably identified session process.";
			closed = await waitForClose(broker, id, record, CLOSE_TIMEOUT_MS, processExitObserver);
		}
		if (!closed) {
			const stale = await revalidateCloseGeneration(broker, id, record, requestedAuthority.authority);
			if (stale) return stale;
			if (!(await signalVerifiedSession(record, id, "SIGKILL", signalAuthority))) {
				await recordTerminalUncertain(broker, id, record.locator.stateRoot, record.pid);
				return fail(
					"terminal_uncertain",
					"Session did not close after SIGTERM and its durable process identity could not be verified for SIGKILL.",
				);
			}
			note =
				"Session teardown did not complete after SIGTERM within the bounded deadline; sent SIGKILL to the durably identified session process.";
			closed = await waitForClose(broker, id, record, CLOSE_TIMEOUT_MS, processExitObserver);
		}
		if (!closed) {
			await recordTerminalUncertain(broker, id, record.locator.stateRoot, record.pid);
			return fail(
				"terminal_uncertain",
				"Session did not unregister, remove its endpoint, and exit after bounded shutdown escalation.",
			);
		}

		return { ok: true, result: { sessionId: id, ...(note ? { note } : {}) } };
	}
	if (operation === "session.delete") {
		if (record?.terminalUncertain)
			return fail("terminal_uncertain", "Session ownership is uncertain and cannot be deleted safely.");
		if (record && !isSessionAuthorityEligible(record))
			return fail("endpoint_stale", "Session authority is ambiguous and cannot be deleted safely.");
		if (record?.live) return fail("live_session", "Refusing to delete a live session; close it first.");
		if (cleanup === undefined) {
			const requestedTranscriptPath = text(input.sessionPath);
			const requestedCwd = lifecycleCwd(input);
			if (requestedTranscriptPath && requestedCwd) {
				const transcriptPath = canonicalExistingPath(requestedTranscriptPath);
				const foreignCleanup = broker.ledger.findCleanupPendingByDeleteTarget(
					{
						sessionId: id,
						transcriptPath,
						cwd: canonicalExistingPath(requestedCwd),
					},
					identity,
				);
				if (foreignCleanup) {
					const response = foreignCleanup.response as BrokerResponse | undefined;
					if (!response || response.ok || response.error.code !== "cleanup_pending" || !response.error.cleanup)
						return fail("terminal_uncertain", "Session cleanup authority is incomplete or corrupt.");
					return response;
				}
			}
		}
		const validated = await validateDeletePath(broker, input, id, record, cleanup);
		if ("ok" in validated) return validated;
		const metadataPreflight = preflightLifecycleDeleteMetadata(validated.metadataRoot, id, record, value =>
			processIncarnationForBroker(broker, value),
		);
		if ("ok" in metadataPreflight) return metadataPreflight;
		const metadataCleanup = metadataPreflight.cleanup;
		let cleanupTarget: VerifiedSessionDeleteTarget = {
			...validated.target,
			...(validated.target.plannedArtifactsPath &&
			validated.target.detachedArtifactsPath !== validated.target.plannedArtifactsPath
				? {}
				: {
						plannedArtifactsPath: path.join(
							path.dirname(validated.target.transcriptPath),
							`.gjc-delete-${randomUUID()}-artifacts`,
						),
					}),
			...(validated.target.plannedTranscriptPath &&
			validated.target.detachedTranscriptPath !== validated.target.plannedTranscriptPath
				? {}
				: {
						plannedTranscriptPath: path.join(
							path.dirname(validated.target.transcriptPath),
							`.gjc-delete-${randomUUID()}-transcript`,
						),
					}),
		};
		if (!cleanupTarget.artifactsRemoved && !cleanupTarget.expectedArtifactsIdentity) {
			const artifactsPath = cleanupTarget.transcriptPath.slice(0, -6);
			try {
				const stat = fsSync.lstatSync(artifactsPath, { bigint: true });
				if (stat.isSymbolicLink() || !stat.isDirectory())
					return fail("terminal_uncertain", "Artifact cleanup target is not an exact directory.");
				validateManagedArtifactTree(artifactsPath);
				const tree = nativeLifecycle().snapshotDirectoryTree(artifactsPath);
				if (!tree.ok || !tree.snapshot)
					return fail(
						"terminal_uncertain",
						`Artifact tree authority could not be captured: ${tree.code ?? "unknown"}`,
					);
				cleanupTarget = {
					...cleanupTarget,
					expectedArtifactsIdentity: {
						dev: stat.dev,
						ino: stat.ino,
						size: Number(stat.size),
						mtimeNs: stat.mtimeNs,
						sha256: "",
					},
					expectedArtifactsTree: tree.snapshot,
				};
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
				cleanupTarget = { ...cleanupTarget, artifactsAbsentAtAuthorization: true };
			}
		}
		const pathIsAbsent = (candidate: string | undefined): boolean => {
			if (!candidate) return true;
			try {
				fsSync.lstatSync(candidate);
				return false;
			} catch (error) {
				return (error as NodeJS.ErrnoException).code === "ENOENT";
			}
		};
		try {
			const currentTranscript = fsSync.lstatSync(cleanupTarget.transcriptPath, { bigint: true });
			if (
				currentTranscript.isFile() &&
				!currentTranscript.isSymbolicLink() &&
				currentTranscript.dev === cleanupTarget.transcriptIdentity.dev &&
				currentTranscript.ino === cleanupTarget.transcriptIdentity.ino
			)
				cleanupTarget.transcriptIdentity = {
					...cleanupTarget.transcriptIdentity,
					nlink: currentTranscript.nlink,
				};
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		}
		const transcriptParentIdentity = cleanup?.transcriptParentIdentity ?? validated.transcriptParentIdentity;
		const durableArtifactsPlan =
			cleanup?.artifactTree?.plannedPath ?? cleanup?.plannedArtifactsPath ?? cleanupTarget.plannedArtifactsPath;
		const preauthorizedCleanup: CleanupEvidence = {
			cleanupReceiptVersion: 1,
			phase: cleanupTarget.artifactsRemoved ? "transcript" : "artifacts",
			sessionId: cleanupTarget.sessionId,
			sessionsRoot: cleanupTarget.sessionsRoot,
			transcriptPath: cleanupTarget.transcriptPath,
			cwd: cleanupTarget.cwd,
			...(cleanupTarget.artifactsRemoved ? { artifactsRemoved: true } : {}),
			...(cleanupTarget.artifactsAbsentAtAuthorization ? { artifactsAbsentAtAuthorization: true as const } : {}),
			metadataRoot: validated.metadataRoot,
			transcriptIdentity: serializeCleanupIdentity(cleanupTarget.transcriptIdentity),
			transcriptParentIdentity,
			...(cleanupTarget.expectedArtifactsIdentity
				? { artifactsIdentity: serializeCleanupIdentity(cleanupTarget.expectedArtifactsIdentity) }
				: {}),
			...(cleanupTarget.expectedArtifactsIdentity && durableArtifactsPlan
				? {
						artifactTree: {
							identity: serializeCleanupIdentity(cleanupTarget.expectedArtifactsIdentity),
							snapshot: cleanupTarget.expectedArtifactsTree!,
							plannedPath: durableArtifactsPlan,
							...(cleanupTarget.detachedArtifactsPath
								? { detachedPath: cleanupTarget.detachedArtifactsPath }
								: {}),
						},
					}
				: {}),
			...(cleanup?.artifactTree ? { artifactTree: cleanup.artifactTree } : {}),
			...(cleanup?.artifactsIdentity ? { artifactsIdentity: cleanup.artifactsIdentity } : {}),
			...(cleanupTarget.retainedArtifactsSuccessorPath
				? { retainedArtifactsSuccessorPath: cleanupTarget.retainedArtifactsSuccessorPath }
				: {}),
			...(cleanupTarget.retainedArtifactsPlaceholderPath
				? { retainedArtifactsPlaceholderPath: cleanupTarget.retainedArtifactsPlaceholderPath }
				: {}),
			...(cleanupTarget.retainedArtifactsUnknownPath
				? { retainedArtifactsUnknownPath: cleanupTarget.retainedArtifactsUnknownPath }
				: {}),
			retainedArtifactsSideAuthority: [
				cleanupTarget.retainedArtifactsSuccessorPath,
				cleanupTarget.retainedArtifactsPlaceholderPath,
				cleanupTarget.retainedArtifactsUnknownPath,
			].some(candidate => candidate !== undefined)
				? "retained"
				: "none",
			...(cleanupTarget.detachedTranscriptPath
				? { detachedTranscriptPath: cleanupTarget.detachedTranscriptPath }
				: {}),
			...(cleanupTarget.retainedTranscriptSuccessorPath
				? { retainedTranscriptSuccessorPath: cleanupTarget.retainedTranscriptSuccessorPath }
				: {}),
			...(cleanupTarget.retainedTranscriptPlaceholderPath
				? { retainedTranscriptPlaceholderPath: cleanupTarget.retainedTranscriptPlaceholderPath }
				: {}),
			...(cleanupTarget.retainedTranscriptUnknownPath
				? { retainedTranscriptUnknownPath: cleanupTarget.retainedTranscriptUnknownPath }
				: {}),

			...(cleanupTarget.plannedArtifactsPath ? { plannedArtifactsPath: cleanupTarget.plannedArtifactsPath } : {}),
			...(cleanupTarget.plannedTranscriptPath ? { plannedTranscriptPath: cleanupTarget.plannedTranscriptPath } : {}),
		};
		const publishChangedArtifactRoot = async (
			retainedPath: string | undefined,
			message = "Saved session cleanup is pending in artifacts: retained artifact root changed before exact removal.",
		): Promise<BrokerResponse> => {
			const artifactPhaseCleanup: CleanupEvidence = {
				...preauthorizedCleanup,
				phase: "artifacts",
				...(retainedPath ? { detachedArtifactsPath: retainedPath } : {}),
				...(retainedPath && preauthorizedCleanup.artifactTree
					? {
							artifactTree: {
								...preauthorizedCleanup.artifactTree,
								detachedPath: retainedPath,
							},
						}
					: {}),
			};
			const changedRoot = fail("cleanup_pending", message, artifactPhaseCleanup);
			await broker.ledger.transition(identity, "effect_started", {
				intendedSessionId: id,
				response: changedRoot,
			});
			return changedRoot;
		};
		const publishCanonicalArtifactReappearance = async (
			transcriptPhaseCleanup: CleanupEvidence,
			message = "Saved session cleanup is pending in artifacts: canonical artifact path reappeared before transcript reconciliation.",
		): Promise<BrokerResponse> => {
			const pending = fail("cleanup_pending", message, transcriptPhaseCleanup);
			await broker.ledger.transition(identity, "effect_started", {
				intendedSessionId: id,
				response: pending,
			});
			return pending;
		};
		const publishRetainedTranscriptSideAuthority = async (): Promise<BrokerResponse> => {
			const pending = fail(
				"cleanup_pending",
				"Saved session cleanup is pending in transcript side authority.",
				preauthorizedCleanup,
			);
			await broker.ledger.transition(identity, "effect_started", {
				intendedSessionId: id,
				response: pending,
			});
			return pending;
		};
		const canonicalArtifactsPath = cleanupTarget.transcriptPath.slice(0, -6);
		const transcriptCleanupAuthorityIsAbsent = (): boolean =>
			[
				cleanupTarget.transcriptPath,
				cleanupTarget.detachedTranscriptPath,
				cleanupTarget.plannedTranscriptPath,
				cleanupTarget.plannedTranscriptPath ? `${cleanupTarget.plannedTranscriptPath}.removing` : undefined,
				cleanupTarget.retainedTranscriptSuccessorPath,
				cleanupTarget.retainedTranscriptPlaceholderPath,
				cleanupTarget.retainedTranscriptUnknownPath,
			].every(pathIsAbsent);
		const artifactQuarantineAliasesAreAbsent = (allowDetachedRoot: boolean): boolean => {
			const authorizedPlans = [
				cleanup?.plannedArtifactsPath,
				cleanup?.artifactTree?.plannedPath,
				cleanupTarget.plannedArtifactsPath,
			].filter((candidate): candidate is string => candidate !== undefined);
			return authorizedPlans.every(plannedPath =>
				[plannedPath, `${plannedPath}.removing`].every(
					aliasPath =>
						(allowDetachedRoot && aliasPath === cleanupTarget.detachedArtifactsPath) || pathIsAbsent(aliasPath),
				),
			);
		};
		const retainedArtifactReplayHasNoSideAuthority = [
			cleanupTarget.retainedArtifactsSuccessorPath,
			cleanupTarget.retainedArtifactsPlaceholderPath,
			cleanupTarget.retainedArtifactsUnknownPath,
		].every(candidate => candidate === undefined);
		if (cleanup && !retainedArtifactReplayHasNoSideAuthority) {
			const retainedPath = cleanupTarget.detachedArtifactsPath;
			return await publishChangedArtifactRoot(
				retainedPath,
				"Saved session cleanup is pending in artifacts: retained artifact side authority remains before transcript cleanup.",
			);
		}
		const retainedTranscriptSidePaths = [
			cleanupTarget.retainedTranscriptSuccessorPath,
			cleanupTarget.retainedTranscriptPlaceholderPath,
			cleanupTarget.retainedTranscriptUnknownPath,
		];
		const transcriptParentMatchesPersistedIdentity = (): boolean => {
			const expectedParent = preauthorizedCleanup.transcriptParentIdentity;
			try {
				const stat = fsSync.lstatSync(path.dirname(cleanupTarget.transcriptPath), { bigint: true });
				return (
					stat.isDirectory() &&
					expectedParent !== undefined &&
					stat.dev.toString() === expectedParent.dev &&
					stat.ino.toString() === expectedParent.ino
				);
			} catch {
				return false;
			}
		};
		const retainedTranscriptIdentityIsAbsentFromParent = (): boolean => {
			const transcriptParent = path.dirname(cleanupTarget.transcriptPath);
			const expectedParent = preauthorizedCleanup.transcriptParentIdentity;
			const pendingDirectories = [transcriptParent];
			const snapshots: Array<{ path: string; stat: fsSync.BigIntStats }> = [];
			let entryCount = 0;
			try {
				while (pendingDirectories.length > 0) {
					const directory = pendingDirectories.pop();
					if (!directory) return false;
					const before = fsSync.lstatSync(directory, { bigint: true });
					if (!before.isDirectory()) return false;
					if (
						directory === transcriptParent &&
						(!expectedParent ||
							before.dev.toString() !== expectedParent.dev ||
							before.ino.toString() !== expectedParent.ino)
					)
						return false;
					snapshots.push({ path: directory, stat: before });
					const entries = fsSync.readdirSync(directory);
					entryCount += entries.length;
					if (entryCount > 10_000) return false;
					for (const entry of entries) {
						const pathname = path.join(directory, entry);
						let stat: fsSync.BigIntStats;
						try {
							stat = fsSync.lstatSync(pathname, { bigint: true });
						} catch {
							return false;
						}
						if (
							stat.dev === cleanupTarget.transcriptIdentity.dev &&
							stat.ino === cleanupTarget.transcriptIdentity.ino
						)
							return false;
						if (stat.isDirectory()) pendingDirectories.push(pathname);
					}
				}
				for (const snapshot of snapshots) {
					const after = fsSync.lstatSync(snapshot.path, { bigint: true });
					if (
						!after.isDirectory() ||
						after.dev !== snapshot.stat.dev ||
						after.ino !== snapshot.stat.ino ||
						after.mtimeNs !== snapshot.stat.mtimeNs ||
						after.ctimeNs !== snapshot.stat.ctimeNs
					)
						return false;
				}
				return true;
			} catch {
				return false;
			}
		};
		const retainedTranscriptReplayHasNoSideAuthority = retainedTranscriptSidePaths.every(
			candidate => candidate === undefined,
		);
		if (cleanup && !retainedTranscriptReplayHasNoSideAuthority) {
			const successorOrUnknownRemains = [
				cleanupTarget.retainedTranscriptSuccessorPath,
				cleanupTarget.retainedTranscriptUnknownPath,
			].some(candidate => candidate !== undefined && !pathIsAbsent(candidate));
			if (
				successorOrUnknownRemains ||
				!pathIsAbsent(cleanupTarget.retainedTranscriptPlaceholderPath) ||
				(!cleanupTarget.detachedTranscriptPath && !retainedTranscriptIdentityIsAbsentFromParent())
			)
				return await publishRetainedTranscriptSideAuthority();
			cleanupTarget.retainedTranscriptSuccessorPath = undefined;
			cleanupTarget.retainedTranscriptPlaceholderPath = undefined;
			cleanupTarget.retainedTranscriptUnknownPath = undefined;
			preauthorizedCleanup.retainedTranscriptSuccessorPath = undefined;
			preauthorizedCleanup.retainedTranscriptPlaceholderPath = undefined;
			preauthorizedCleanup.retainedTranscriptUnknownPath = undefined;
		}
		if (cleanup?.phase === "artifacts" && !artifactQuarantineAliasesAreAbsent(true))
			return await publishChangedArtifactRoot(
				cleanupTarget.detachedArtifactsPath,
				"Saved session cleanup is pending in artifacts: another authorized quarantine alias remains.",
			);
		if (cleanup?.phase === "transcript" && !artifactQuarantineAliasesAreAbsent(false))
			return await publishCanonicalArtifactReappearance(
				preauthorizedCleanup,
				"Saved session cleanup is pending in artifacts: a planned quarantine alias reappeared before transcript reconciliation.",
			);
		await broker.ledger.transition(identity, "effect_started", {
			intendedSessionId: id,
			effectMarker: randomUUID(),
			response: fail(
				"cleanup_pending",
				"Saved session cleanup is preauthorized for durable reconciliation.",
				preauthorizedCleanup,
			),
		});
		let deleted: VerifiedSessionDeleteResult;
		try {
			const completedArtifactReplay = cleanup?.phase === "transcript" && cleanup.artifactsRemoved === true;
			if (completedArtifactReplay && !pathIsAbsent(canonicalArtifactsPath))
				return await publishCanonicalArtifactReappearance(preauthorizedCleanup);
			if (
				completedArtifactReplay &&
				transcriptCleanupAuthorityIsAbsent() &&
				retainedTranscriptIdentityIsAbsentFromParent()
			)
				return fail(
					"cleanup_pending",
					"Saved session cleanup remains pending because transcript authority disappeared without native deletion proof.",
					preauthorizedCleanup,
				);
			else {
				if (!transcriptParentMatchesPersistedIdentity())
					return fail(
						"cleanup_pending",
						"Saved session cleanup is pending because transcript parent identity changed before exact mutation.",
						preauthorizedCleanup,
					);
				deleted = await validated.storage.deleteSessionVerified(cleanupTarget);
			}
		} catch (error) {
			if (error instanceof SessionDeleteVerificationError) {
				if (cleanup?.phase === "artifacts")
					return await publishChangedArtifactRoot(
						cleanupTarget.detachedArtifactsPath,
						`Saved session cleanup remains pending in exact artifact authority: ${error.message}`,
					);
				if (cleanup?.phase === "transcript" && cleanup.artifactsRemoved === true && error.kind === "artifacts")
					return await publishCanonicalArtifactReappearance(preauthorizedCleanup);
				return fail(
					"invalid_input",
					`Saved session deletion verification failed (${error.kind}): ${error.message}`,
				);
			}
			return fail(
				"unavailable",
				`Unable to delete saved session artifacts: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
		if (
			deleted.kind === "deleted" &&
			cleanup?.phase === "transcript" &&
			cleanup.artifactsRemoved === true &&
			!pathIsAbsent(canonicalArtifactsPath)
		)
			return await publishCanonicalArtifactReappearance(preauthorizedCleanup);
		if (
			deleted.kind === "deleted" &&
			cleanup?.phase === "transcript" &&
			cleanup.artifactsRemoved === true &&
			!artifactQuarantineAliasesAreAbsent(false)
		)
			return await publishCanonicalArtifactReappearance(
				preauthorizedCleanup,
				"Saved session cleanup is pending in artifacts: a planned quarantine alias reappeared during transcript cleanup.",
			);
		if (deleted.kind === "artifacts_removed") {
			if (!artifactQuarantineAliasesAreAbsent(false))
				return await publishChangedArtifactRoot(
					cleanupTarget.detachedArtifactsPath,
					"Saved session cleanup is pending in artifacts: an authorized quarantine alias remains after exact removal.",
				);
			const transcriptPhaseCleanup: CleanupEvidence = {
				...preauthorizedCleanup,
				phase: "transcript",
				artifactsRemoved: true,
				detachedArtifactsPath: undefined,
				retainedArtifactsSuccessorPath: undefined,
				retainedArtifactsPlaceholderPath: undefined,
				retainedArtifactsUnknownPath: undefined,
				retainedArtifactsSideAuthority: "none",
				...(preauthorizedCleanup.artifactTree
					? {
							artifactTree: {
								...preauthorizedCleanup.artifactTree,
								detachedPath: undefined,
								completed: true as const,
							},
						}
					: {}),
			};

			await broker.ledger.transition(identity, "effect_started", {
				intendedSessionId: id,
				response: fail(
					"cleanup_pending",
					"Saved session artifacts were removed; transcript cleanup is preauthorized.",
					transcriptPhaseCleanup,
				),
			});
			if (!pathIsAbsent(canonicalArtifactsPath))
				return await publishCanonicalArtifactReappearance(transcriptPhaseCleanup);
			if (transcriptCleanupAuthorityIsAbsent() && retainedTranscriptIdentityIsAbsentFromParent())
				return fail(
					"cleanup_pending",
					"Saved session cleanup remains pending because transcript authority disappeared without native deletion proof.",
					transcriptPhaseCleanup,
				);
			else {
				if (!transcriptParentMatchesPersistedIdentity())
					return fail(
						"cleanup_pending",
						"Saved session cleanup is pending because transcript parent identity changed before exact mutation.",
						transcriptPhaseCleanup,
					);
				try {
					deleted = await validated.storage.deleteSessionVerified({
						...cleanupTarget,
						expectedArtifactsIdentity: undefined,
						detachedArtifactsPath: undefined,
						artifactsRemoved: true,
					});
				} catch (error) {
					if (error instanceof SessionDeleteVerificationError && error.kind === "artifacts")
						return await publishCanonicalArtifactReappearance(transcriptPhaseCleanup);
					if (error instanceof SessionDeleteVerificationError)
						return fail(
							"invalid_input",
							`Saved session deletion verification failed (${error.kind}): ${error.message}`,
						);
					return fail(
						"unavailable",
						`Unable to delete saved session transcript: ${error instanceof Error ? error.message : String(error)}`,
					);
				}
			}
			if (deleted.kind === "deleted" && !pathIsAbsent(canonicalArtifactsPath))
				return await publishCanonicalArtifactReappearance(transcriptPhaseCleanup);
			if (deleted.kind === "deleted" && !artifactQuarantineAliasesAreAbsent(false))
				return await publishCanonicalArtifactReappearance(
					transcriptPhaseCleanup,
					"Saved session cleanup is pending in artifacts: a planned quarantine alias reappeared during transcript cleanup.",
				);
		}
		if (deleted.kind === "deleted" && !artifactQuarantineAliasesAreAbsent(false))
			return await publishCanonicalArtifactReappearance(
				preauthorizedCleanup,
				"Saved session cleanup is pending in artifacts: a planned quarantine alias remains before terminal completion.",
			);
		const retainedRootArtifactsPlan = durableArtifactsPlan;
		if (deleted.kind === "cleanup_pending")
			return fail(
				"cleanup_pending",
				`Saved session cleanup is pending in ${deleted.phase}: ${deleted.error.message}`,
				{
					cleanupReceiptVersion: 1,
					phase: deleted.phase,
					sessionId: validated.target.sessionId,
					sessionsRoot: validated.target.sessionsRoot,
					transcriptPath: validated.target.transcriptPath,
					cwd: validated.target.cwd,
					metadataRoot: validated.metadataRoot,
					transcriptIdentity: serializeCleanupIdentity(deleted.transcriptIdentity),
					transcriptParentIdentity: preauthorizedCleanup.transcriptParentIdentity,
					...(deleted.phase === "artifacts" && deleted.artifactsIdentity
						? { artifactsIdentity: serializeCleanupIdentity(deleted.artifactsIdentity) }
						: {}),
					...(deleted.phase === "artifacts" && deleted.artifactsIdentity && durableArtifactsPlan
						? {
								artifactTree: {
									identity: serializeCleanupIdentity(deleted.artifactsIdentity),
									snapshot: deleted.artifactsTree,
									plannedPath: durableArtifactsPlan,
									...(deleted.detachedArtifactsPath ? { detachedPath: deleted.detachedArtifactsPath } : {}),
								},
							}
						: {}),
					...(deleted.phase === "artifacts" ? { detachedArtifactsPath: deleted.detachedArtifactsPath } : {}),
					...(deleted.phase === "artifacts" && deleted.retainedSuccessorPath
						? { retainedArtifactsSuccessorPath: deleted.retainedSuccessorPath }
						: {}),
					...(deleted.phase === "artifacts" && deleted.retainedPlaceholderPath
						? { retainedArtifactsPlaceholderPath: deleted.retainedPlaceholderPath }
						: {}),
					...(deleted.phase === "artifacts" && deleted.retainedUnknownPath
						? { retainedArtifactsUnknownPath: deleted.retainedUnknownPath }
						: {}),
					...(deleted.phase === "artifacts"
						? {
								retainedArtifactsSideAuthority: [
									deleted.retainedSuccessorPath,
									deleted.retainedPlaceholderPath,
									deleted.retainedUnknownPath,
								].some(candidate => candidate !== undefined)
									? ("retained" as const)
									: ("none" as const),
							}
						: {}),
					...(deleted.phase === "transcript" && deleted.detachedTranscriptPath
						? { detachedTranscriptPath: deleted.detachedTranscriptPath }
						: {}),
					...(deleted.phase === "transcript" && deleted.retainedSuccessorPath
						? { retainedTranscriptSuccessorPath: deleted.retainedSuccessorPath }
						: {}),
					...(deleted.phase === "transcript" && deleted.retainedPlaceholderPath
						? { retainedTranscriptPlaceholderPath: deleted.retainedPlaceholderPath }
						: {}),
					...(deleted.phase === "transcript" && deleted.retainedUnknownPath
						? { retainedTranscriptUnknownPath: deleted.retainedUnknownPath }
						: {}),
					...(deleted.phase === "transcript" ? { artifactsRemoved: true } : {}),
					...(deleted.phase === "transcript" &&
					retainedRootArtifactsPlan &&
					cleanupTarget.expectedArtifactsIdentity
						? {
								artifactTree: {
									identity: serializeCleanupIdentity(cleanupTarget.expectedArtifactsIdentity),
									snapshot: cleanupTarget.expectedArtifactsTree!,
									plannedPath: retainedRootArtifactsPlan,
									completed: true as const,
								},
							}
						: {}),
					...(deleted.phase === "transcript" && preauthorizedCleanup.artifactTree
						? {
								artifactTree: {
									...preauthorizedCleanup.artifactTree,
									detachedPath: undefined,
									completed: true as const,
								},
							}
						: {}),
					...(cleanupTarget.plannedArtifactsPath
						? { plannedArtifactsPath: cleanupTarget.plannedArtifactsPath }
						: {}),
					...(cleanupTarget.plannedTranscriptPath
						? { plannedTranscriptPath: cleanupTarget.plannedTranscriptPath }
						: {}),
				},
			);

		const completion = { ok: true, result: { sessionId: id } } as const;
		if (metadataCleanup.lifecycleFiles?.length) {
			await broker.ledger.transition(identity, "effect_started", {
				intendedSessionId: id,
				response: fail(
					"cleanup_pending",
					"Lifecycle metadata cleanup is preauthorized for durable reconciliation.",
					metadataCleanup,
				),
			});
			const reconciled = await reconcileLifecycleCleanup(broker, identity, metadataCleanup, completion);
			if (!reconciled.ok) return reconciled;
		}
		// Persist exact retirement authority in the broker-owned index only. These
		// identity fields are deliberately not added to `completion`, so the public
		// lifecycle response remains the credential-free `{ sessionId }` contract.
		if (record) await appendSessionDeletedEvidence(broker, record);
		return completion;
	}
	if (operation === "session.reconcile_uncertain") {
		return await executeUncertainRetirement(broker, input, identity, undefined);
	}
	return fail("invalid_input", "Unknown lifecycle operation.");
}

async function appendSessionDeletedEvidence(broker: Broker, record: IndexedSession): Promise<void> {
	await broker.index.append({
		type: "session_deleted",
		sessionId: record.sessionId,
		locator: record.locator,
		endpointGeneration: record.endpointGeneration,
		pid: record.pid,
		...(record.processIncarnation === undefined ? {} : { processIncarnation: record.processIncarnation }),
		...(record.hostIncarnation === undefined ? {} : { hostIncarnation: record.hostIncarnation }),
		...(record.endpointMtimeMs === undefined ? {} : { endpointMtimeMs: record.endpointMtimeMs }),
		...(record.endpointFileId === undefined ? {} : { endpointFileId: record.endpointFileId }),
		...(record.lifecycleRequestId === undefined ? {} : { lifecycleRequestId: record.lifecycleRequestId }),
	});
}

async function exactCleanupProof(
	broker: Broker,
	root: string | undefined,
	id: string | undefined,
	expected: EffectMarker | undefined,
	evidence: { artifact: LifecycleFailureArtifact } | undefined,
	proofBudget?: LifecycleProofBudget,
): Promise<LifecycleCleanupProof | undefined> {
	const rollback = evidence?.artifact.rollback;
	if (!lifecycleProofWithinDeadline(proofBudget)) return undefined;
	if (
		!root ||
		!id ||
		!expected ||
		!rollback?.fenced ||
		!rollback.runtimeRemoved ||
		!rollback.hostStopped ||
		!rollback.brokerRegistrationReleased ||
		observeProcess(expected.pid, expected.incarnation, value => processIncarnationForBroker(broker, value)) !==
			"exited"
	)
		return undefined;
	if (!lifecycleProofWithinDeadline(proofBudget)) return undefined;
	if (!(await endpointRemoved(root, id))) return undefined;
	if (!lifecycleProofWithinDeadline(proofBudget)) return undefined;
	await broker.index.refresh();
	if (!lifecycleProofWithinDeadline(proofBudget)) return undefined;
	if (rollback.endpointGeneration === null) {
		if (broker.index.hasHostRegistrationForLifecycle(id, expected.pid, expected.effectMarker)) return undefined;
		if (!lifecycleProofWithinDeadline(proofBudget)) return undefined;
		return {
			processExited: true,
			endpointRemoved: true,
			hostUnregistered: { state: "not_registered" },
			rollback: {
				endpointGeneration: null,
				fenced: true,
				runtimeRemoved: true,
				hostStopped: true,
				brokerRegistrationReleased: true,
			},
		};
	}
	const registration = broker.index.findHostRegistration(
		id,
		rollback.endpointGeneration,
		expected.pid,
		expected.effectMarker,
	);
	const hostUnregistered = registration ? broker.index.hostUnregisteredAfter(registration) : undefined;
	return hostUnregistered && lifecycleProofWithinDeadline(proofBudget)
		? {
				processExited: true,
				endpointRemoved: true,
				hostUnregistered: { state: "unregistered", ...hostUnregistered },
				rollback: {
					endpointGeneration: rollback.endpointGeneration,
					fenced: true,
					runtimeRemoved: true,
					hostStopped: true,
					brokerRegistrationReleased: true,
				},
			}
		: undefined;
}

function validateLifecycleDeleteMetadataBinding(
	broker: Broker,
	operation: string,
	input: Input,
	identity: string,
	cleanup: CleanupEvidence,
): BrokerResponse | undefined {
	if (operation !== "session.delete")
		return fail("terminal_uncertain", "Lifecycle delete metadata cleanup is not authorized for this operation.");
	const requestedId = sessionId(input);
	const cwd = lifecycleCwd(input);
	const requestedRoot = stateRoot(input, cwd);
	const canonicalRequestedRoot = requestedRoot ? canonicalExistingPath(requestedRoot) : undefined;
	if (
		!requestedId ||
		!isCanonicalSessionId(requestedId) ||
		!cwd ||
		!requestedRoot ||
		!hasDefaultStateRoot(cwd, requestedRoot) ||
		!canonicalRequestedRoot ||
		cleanup.sessionId !== requestedId ||
		!cleanup.metadataRoot ||
		canonicalExistingPath(cleanup.metadataRoot) !== canonicalRequestedRoot
	)
		return fail("terminal_uncertain", "Lifecycle delete metadata cleanup does not match the normalized request.");
	const recordedRoot = broker.ledger.get(identity)?.effectIntent?.stateRoot;
	if (recordedRoot && canonicalExistingPath(recordedRoot) !== canonicalRequestedRoot)
		return fail("terminal_uncertain", "Lifecycle delete metadata cleanup does not match the recorded workspace.");
	return undefined;
}

export interface LifecycleExecutionOutcome {
	response: BrokerResponse;
	durableEffects?: LifecycleDurableEffectsReceipt;
	startupFailure?: LifecycleStartupFailureReceipt;
	deferredArtifactCleanup?: () => Promise<void>;
}

/** Returns the response together with every durable lifecycle fact needed for truthful replay. */
export async function executeLifecycle(
	broker: Broker,
	operation: string,
	input: Input,
	identity: string,
	cleanup?: CleanupEvidence,
): Promise<LifecycleExecutionOutcome> {
	let proofBudget = lifecycleProofBudgetFromInput(broker, input);
	if (!proofBudget)
		proofBudget = lifecycleProofBudgetFromEffectIntent(broker, broker.ledger.get(identity)?.effectIntent);
	if (operation === "session.reconcile_uncertain" && cleanup && isLifecycleRetirementCleanup(cleanup)) {
		const shapeValidation = validateLifecycleCleanupShape(cleanup);
		if (shapeValidation) return { response: shapeValidation };
		return { response: await executeUncertainRetirement(broker, input, identity, cleanup) };
	}
	if (cleanup?.phase === "metadata") {
		if (operation !== "session.delete")
			return {
				response: fail(
					"terminal_uncertain",
					"Legacy metadata cleanup is not authorized for this lifecycle operation.",
				),
			};
		const migrated = legacyMetadataCleanupPlan(cleanup);
		if (!migrated)
			return {
				response: fail(
					"terminal_uncertain",
					"Legacy metadata cleanup replay lacks immutable identity-bound intent.",
				),
			};
		const binding = validateLifecycleDeleteMetadataBinding(broker, operation, input, identity, migrated);
		if (binding) return { response: binding };
		await broker.ledger.transition(identity, "effect_started", {
			response: fail(
				"cleanup_pending",
				"Legacy lifecycle metadata cleanup is preauthorized for durable reconciliation.",
				migrated,
			),
		});
		return {
			response: await reconcileLifecycleCleanup(
				broker,
				identity,
				migrated,
				{
					ok: true,
					result: { sessionId: migrated.sessionId },
				},
				proofBudget,
			),
		};
	}
	if (cleanup?.phase === "lifecycle") {
		const shapeValidation = validateLifecycleCleanupShape(cleanup);
		if (shapeValidation) return { response: shapeValidation };
		if (cleanup.lifecycleDeleteMetadata === true || operation === "session.delete") {
			const binding = validateLifecycleDeleteMetadataBinding(broker, operation, input, identity, cleanup);
			if (binding) return { response: binding };
		}
		return {
			response: await reconcileLifecycleCleanup(
				broker,
				identity,
				cleanup,
				operation === "session.delete"
					? { ok: true, result: { sessionId: cleanup.sessionId } }
					: fail("spawn_failed", "No ready SDK endpoint remains available."),
				proofBudget,
			),
		};
	}
	const response = await executeLifecycleResponse(broker, operation, input, identity, cleanup);
	const entry = broker.ledger.get(identity);
	if (!proofBudget) proofBudget = lifecycleProofBudgetFromEffectIntent(broker, entry?.effectIntent);
	const priorDurableEffects = entry?.durableEffects;
	const evidenceCwd = entry?.effectIntent?.worktree?.worktreePath ?? lifecycleCwd(input);
	const root = entry?.effectIntent?.stateRoot ?? stateRoot(input, evidenceCwd);
	const marker =
		entry?.effectMarker && entry.intendedSessionId && root
			? await readEffectMarker(lifecycleMarkerPath(root, entry.intendedSessionId))
			: undefined;
	const expected = marker && marker.effectMarker === entry?.effectMarker ? marker : undefined;
	const evidence =
		root && entry?.intendedSessionId && expected
			? await readLifecycleFailureArtifact(
					lifecycleFailurePath(root, entry.intendedSessionId, expected.effectMarker),
					expected,
				)
			: undefined;
	const cleanupProof = await exactCleanupProof(
		broker,
		root,
		entry?.intendedSessionId,
		expected,
		evidence,
		proofBudget,
	);
	const startupFailure: LifecycleStartupFailureReceipt | undefined = evidence
		? {
				artifactDigest: evidence.digest,
				phase: evidence.artifact.phase,
				reason: evidence.artifact.reason,
				message: evidence.artifact.message,
				...(evidence.artifact.code === undefined
					? {}
					: { code: evidence.artifact.code, details: evidence.artifact.details }),
				rollback: {
					endpointGeneration: evidence.artifact.rollback.endpointGeneration,
					fenced: evidence.artifact.rollback.fenced,
					runtimeRemoved: evidence.artifact.rollback.runtimeRemoved,
					hostStopped: evidence.artifact.rollback.hostStopped,
					brokerRegistrationReleased: evidence.artifact.rollback.brokerRegistrationReleased,
				},
				...(cleanupProof ? { cleanupProof } : {}),
			}
		: undefined;
	const durableEffectsBody: Omit<LifecycleDurableEffectsReceipt, "digest"> = {
		...(priorDurableEffects?.worktree ? { worktree: priorDurableEffects.worktree } : {}),
		...(evidence?.artifact.transcript
			? {
					transcript: {
						identityDigest: createHash("sha256")
							.update(canonicalJson(evidence.artifact.transcript.identity))
							.digest("hex"),
						contentDigest: evidence.artifact.transcript.digest,
					},
				}
			: {}),
		...(startupFailure ? { startup: startupFailure } : {}),
	};
	const durableEffects =
		Object.keys(durableEffectsBody).length > 0
			? {
					...durableEffectsBody,
					digest: createHash("sha256").update(canonicalJson(durableEffectsBody)).digest("hex"),
				}
			: undefined;
	const lifecycleCleanupResponse =
		evidence && root && entry?.intendedSessionId && expected && cleanupProof
			? await (async () => {
					const cleanupIntent = lifecycleCleanupPlan(root, entry.intendedSessionId!, expected, evidence);
					if (!lifecycleProofWithinDeadline(proofBudget))
						return fail(
							"terminal_uncertain",
							"Lifecycle cleanup proof exceeded its cleanup deadline.",
							cleanupIntent,
						);
					await broker.ledger.transition(identity, "effect_started", {
						response: fail(
							"cleanup_pending",
							"Lifecycle failure cleanup is preauthorized for durable reconciliation.",
							cleanupIntent,
						),
					});
					if (!lifecycleProofWithinDeadline(proofBudget))
						return fail(
							"terminal_uncertain",
							"Lifecycle cleanup proof exceeded its cleanup deadline.",
							cleanupIntent,
						);
					return reconcileLifecycleCleanup(broker, identity, cleanupIntent, undefined, proofBudget);
				})()
			: undefined;
	if (
		lifecycleCleanupResponse &&
		!lifecycleCleanupResponse.ok &&
		lifecycleCleanupResponse.error.code !== "spawn_failed"
	)
		return {
			response: lifecycleCleanupResponse,
			...(durableEffects ? { durableEffects } : {}),
			...(startupFailure ? { startupFailure } : {}),
		};
	const provenExpected = expected;
	const provenRoot = root;
	const provenId = entry?.intendedSessionId;
	let provenDeadCleanup = false;
	if (provenExpected && provenRoot && provenId && lifecycleProofWithinDeadline(proofBudget)) {
		const processExited =
			observeProcess(provenExpected!.pid, provenExpected!.incarnation, value =>
				processIncarnationForBroker(broker, value),
			) === "exited";
		if (processExited && lifecycleProofWithinDeadline(proofBudget)) {
			const endpointGone = await endpointRemoved(provenRoot!, provenId!);
			provenDeadCleanup = endpointGone && lifecycleProofWithinDeadline(proofBudget);
		}
	}
	const terminalResponse: BrokerResponse =
		!response.ok &&
		entry?.effectMarker &&
		(operation === "session.create" || operation === "session.fork" || operation === "session.resume")
			? entry.effectIntent?.childOwnershipEstablished === false
				? response
				: response.error.code === "endpoint_unreadable"
					? response
					: // An unreadable/corrupt endpoint is already the fail-closed honest
						// terminal classification (it names the artifact, not the
						// child); the reconciliation wrapper must not erase it.
						response.error.code === "ready_then_exited" && (cleanupProof || provenDeadCleanup)
						? {
								...response,
								...(durableEffects ? { durableEffects } : {}),
								...(startupFailure ? { startupFailure } : {}),
							}
						: startupFailure && cleanupProof
							? {
									ok: false,
									error: startupFailure.code
										? {
												code: startupFailure.code,
												message: startupFailure.message,
												details: startupFailure.details!,
												endpoint: "unavailable" as const,
											}
										: {
												code: "spawn_failed",
												message: startupFailure.message,
												endpoint: "unavailable" as const,
											},
									...(durableEffects ? { durableEffects } : {}),
									startupFailure,
								}
							: provenDeadCleanup && response.error.code !== "terminal_uncertain"
								? response
								: {
										ok: false,
										error: {
											code: "terminal_uncertain",
											message: terminalUncertainStartupMessage(response),
										},
										...(durableEffects ? { durableEffects } : {}),
										...(startupFailure ? { startupFailure } : {}),
									}
			: response;
	return {
		response: terminalResponse,
		...(durableEffects ? { durableEffects } : {}),
		...(startupFailure ? { startupFailure } : {}),
	};
}

/**
 * The live client/socket subscription count of the SDK session endpoint this
 * process serves, or `undefined` while this process serves no endpoint.
 *
 * Only the SDK session runtime owns the real socket table, so it publishes a
 * reader here instead of every consumer re-deriving attachment from the OS.
 * Consumers must treat `undefined` as "no evidence" and never as "detached".
 */
export type SessionHostAttachmentReader = () => number;

/** What one serving runtime reports about itself while its transport is up. */
export interface SessionHostRuntimeEvidence {
	/** This runtime's own live SDK client/socket subscription count. */
	attachedClients: SessionHostAttachmentReader;
	/** Whether this runtime currently has agent work in flight. */
	workInFlight: () => boolean;
}

/** One runtime's live publication, retractable only by its owner. */
export interface SessionHostRuntimePublication {
	/**
	 * Withdraws the evidence this handle published. Idempotent, and never able
	 * to touch a sibling runtime's evidence.
	 */
	retract(): void;
}

/**
 * Every runtime in this process that currently serves an SDK endpoint.
 *
 * A process can serve more than one at a time: an identity-rotating control op
 * starts the successor before the predecessor's deferred stop runs. A single
 * global slot let that predecessor's teardown retract the live successor's
 * reader and manufacture "no evidence" for a host with clients attached, so
 * publications are held per runtime and retracted only through their own handle.
 */
const sessionHostRuntimes = new Set<SessionHostRuntimeEvidence>();

/**
 * Publishes this runtime's own liveness evidence for the lifetime of its
 * transport. Retraction goes through the returned handle, so a runtime can only
 * ever withdraw evidence it owns.
 */
export function publishSessionHostRuntimeEvidence(evidence: SessionHostRuntimeEvidence): SessionHostRuntimePublication {
	const published: SessionHostRuntimeEvidence = { ...evidence };
	sessionHostRuntimes.add(published);
	return {
		retract(): void {
			sessionHostRuntimes.delete(published);
		},
	};
}

/**
 * This process's currently attached SDK client count, summed across every
 * serving runtime, or `undefined` when no runtime publishes a readable count
 * (before startup, after teardown, or when every reader itself fails). Never
 * guesses: absence of a reader is absence of evidence.
 */
export function sessionHostAttachedClients(): number | undefined {
	let total: number | undefined;
	for (const { attachedClients } of sessionHostRuntimes) {
		let count: number;
		try {
			count = attachedClients();
		} catch {
			continue;
		}
		if (!Number.isSafeInteger(count) || count < 0) continue;
		total = (total ?? 0) + count;
	}
	return total;
}

/**
 * Whether any runtime in this process has agent work in flight right now.
 *
 * Positive evidence only: a runtime that publishes nothing, or whose reader
 * fails, reports no work, so this can never keep an abandoned host alive.
 */
export function sessionHostWorkInFlight(): boolean {
	for (const { workInFlight } of sessionHostRuntimes) {
		try {
			if (workInFlight()) return true;
		} catch {}
	}
	return false;
}

/**
 * How often a live broker re-checks its own session registrations against OS
 * process liveness.
 *
 * This sweep can never disturb healthy work: a registration is dropped only when
 * `observeProcess` proves its exact published process identity exited. A live
 * replacement at the same pid retires the stale registration without being
 * signaled. One minute keeps `gjc_sessions`/`session.get_endpoint` from
 * advertising a corpse for longer than a single poll while costing one index
 * refresh per minute on an otherwise idle broker.
 */
export const BROKER_DEAD_REGISTRATION_SWEEP_MS = 60_000;

/**
 * Registrations reaped per sweep. Every reap is its own locked index transaction,
 * so an uncapped sweep over a long-lived index turns one broker into a continuous
 * holder of the shared session-index lock and starves unrelated `gjc` launches out
 * of their bounded retry budget. Surplus dead rows are reaped by later sweeps.
 */
export const BROKER_DEAD_REGISTRATION_SWEEP_LIMIT = 64;

/** One reaped registration, as recorded by {@link reapDeadSessionRegistrations}. */
export interface ReapedSessionRegistration {
	sessionId: string;
	pid: number;
	endpointGeneration: number;
}

/**
 * Drops every indexed session registration whose host process is provably gone.
 *
 * Proof of death is positive, never inferred from a missing liveness proof:
 * `observeProcess` reports "exited" only on ESRCH or on a readable OS process
 * incarnation that differs from the recorded one (a reused pid). A stale or
 * missing heartbeat merely makes a session read as not-live — the host may
 * still be running ahead of the next heartbeat checkpoint pass, so it is never
 * grounds for a reap. EPERM and unreadable incarnations stay "uncertain", so an
 * alien or unreadable process is never mistaken for a dead one. Terminal and
 * terminal-uncertain identities are retained. Identity-level rows let the sweep
 * retire a dead losing root without disturbing the surviving authority.
 */
export async function reapDeadSessionRegistrations(
	broker: BrokerIndex,
	limit = BROKER_DEAD_REGISTRATION_SWEEP_LIMIT,
): Promise<ReapedSessionRegistration[]> {
	await broker.index.refresh();
	const dead = broker.index
		.listSessionIdentities()
		.filter(session => {
			if (session.terminal || session.terminalUncertain) return false;
			const recordedIncarnation = session.hostIncarnation ?? session.processIncarnation;
			return (
				observeProcess(session.pid, recordedIncarnation, pid => processIncarnationForBroker(broker, pid)) ===
				"exited"
			);
		})
		.slice(0, Math.max(0, limit));
	const reaped: ReapedSessionRegistration[] = [];
	for (const session of dead) {
		if (!(await broker.index.unregisterIfCurrent(session))) continue;
		const record = {
			sessionId: session.sessionId,
			pid: session.pid,
			endpointGeneration: session.endpointGeneration,
		};
		reaped.push(record);
		logger.warn("sdk broker reaped a session registration whose host process is gone", record);
	}
	return reaped;
}

/**
 * Runs {@link reapDeadSessionRegistrations} on {@link BROKER_DEAD_REGISTRATION_SWEEP_MS}.
 * The timer is unref'd, so it never keeps an otherwise idle broker process alive.
 * Returns a disposer.
 */
export function startBrokerDeadRegistrationSweep(
	broker: Pick<Broker, "index">,
	intervalMs = BROKER_DEAD_REGISTRATION_SWEEP_MS,
): () => void {
	let running = false;
	const timer = setInterval(() => {
		if (running) return;
		running = true;
		void reapDeadSessionRegistrations(broker)
			.catch(error => {
				logger.warn("sdk broker dead-registration sweep failed", { error: String(error) });
			})
			.finally(() => {
				running = false;
			});
	}, intervalMs);
	timer.unref();
	return () => clearInterval(timer);
}
