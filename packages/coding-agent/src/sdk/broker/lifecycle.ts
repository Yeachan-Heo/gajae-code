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

import { $credentialEnv, resolveEquivalentPath } from "@gajae-code/utils";

import {
	isModelProfileError,
	type ModelProfileErrorDetails,
	validateModelProfileName,
} from "../../config/model-profile-contract";
import { mergeModelProfiles } from "../../config/model-profiles";
import { ModelsConfigFile } from "../../config/model-registry";
import {
	ensureLaunchWorktree,
	ensureReusableNodeModules,
	type GjcLaunchWorktreePlan,
	planLaunchWorktree,
} from "../../gjc-runtime/launch-worktree";
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
import { SESSION_PREPARED_EVENT } from "../host/host";
import {
	type LogicalSessionCandidate,
	listManagedSessionCandidates,
	type ManagedSessionScope,
	resolveManagedSessionScope,
} from "../session-directory";
import type { SdkStartupFailure, SdkStartupRollbackResult } from "../startup-capability";
import type { Broker, BrokerCleanupEvidence, BrokerCleanupIdentity, BrokerResponse } from "./broker";
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

export {
	type ProcessIncarnationCommandRunner,
	type ProcessIncarnationOptions,
	parseDarwinProcessIncarnation,
	processIncarnation,
};

const READY_TIMEOUT_MS = 10_000;
const MIN_READY_TIMEOUT_MS = 4_000;
const MAX_READY_TIMEOUT_MS = 60_000;
const POLL_MS = 50;
const CLOSE_TIMEOUT_MS = 2_000;
const MAX_RECEIVED_AT_SKEW_MS = 5_000;
const MAX_LIFECYCLE_METADATA_BYTES = 4096;
const MAX_EFFECT_MARKER_LENGTH = 128;
const MAX_PROCESS_INCARNATION_LENGTH = 256;

export interface LifecycleDeadlines {
	receivedAt: number;
	requestedReadinessTimeoutMs: number;
	semanticReadyDeadlineAt: number;
	terminationStartDeadlineAt: number;
	lifecycleCleanupDeadlineAt: number;
}

export function deriveLifecycleDeadlines(receivedAt: number, requestedReadinessTimeoutMs: number): LifecycleDeadlines {
	if (
		!Number.isSafeInteger(receivedAt) ||
		!Number.isSafeInteger(requestedReadinessTimeoutMs) ||
		requestedReadinessTimeoutMs < MIN_READY_TIMEOUT_MS ||
		requestedReadinessTimeoutMs > MAX_READY_TIMEOUT_MS
	)
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
	sleep(ms: number): Promise<void>;
}

const defaultLifecycleTiming: LifecycleTiming = {
	now: Date.now,
	sleep: ms => new Promise(resolve => setTimeout(resolve, ms)),
};
const lifecycleTimingsForTest = new WeakMap<Broker, LifecycleTiming>();
type LifecycleCommand = SdkInternalSpawnCommand | { file: string; args: string[] };
type LifecycleCommandResolver = () => LifecycleCommand;
const lifecycleCommandResolversForTest = new WeakMap<Broker, LifecycleCommandResolver>();
const lifecycleCleanupHooksForTest = new WeakMap<Broker, () => void>();

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

function lifecycleTiming(broker: Broker): LifecycleTiming {
	return lifecycleTimingsForTest.get(broker) ?? defaultLifecycleTiming;
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
export interface SessionLifecycleLaunchRequest {
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
				request.sourceSessionId === undefined))
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
	modelPreset?: string;
	mcpServers?: SessionLifecycleMcpServer[];
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

function validateBrokerModelPreset(agentDir: string, requestedProfile: string): string | BrokerResponse {
	const modelsConfigFile = ModelsConfigFile.relocate(path.join(agentDir, "models.yml"));
	modelsConfigFile.invalidate();
	const loaded = modelsConfigFile.tryLoad();
	const profiles = mergeModelProfiles(loaded.status === "ok" ? loaded.value.profiles : undefined);
	try {
		return validateModelProfileName(requestedProfile, profiles, loaded.status === "error" ? loaded.error : undefined);
	} catch (error) {
		if (isModelProfileError(error)) return fail(error.code, error.message, undefined, error.details);
		throw error;
	}
}

export function validateBrokerModelPresetForTest(agentDir: string, requestedProfile: string): string | BrokerResponse {
	return validateBrokerModelPreset(agentDir, requestedProfile);
}

function readinessTimeout(input: Input): number | BrokerResponse {
	const value = input.readinessTimeoutMs;
	if (value === undefined) return READY_TIMEOUT_MS;
	if (
		typeof value !== "number" ||
		!Number.isSafeInteger(value) ||
		value < MIN_READY_TIMEOUT_MS ||
		value > MAX_READY_TIMEOUT_MS
	)
		return fail(
			"invalid_input",
			`readinessTimeoutMs must be an integer between ${MIN_READY_TIMEOUT_MS} and ${MAX_READY_TIMEOUT_MS}.`,
		);
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
	const worktree = target?.worktree;
	if (worktree === undefined) return undefined;
	return isLifecycleWorktreeTarget(worktree) ? worktree : null;
}

type LiveResumeRecord = {
	locator: { repo: string; stateRoot: string };
	endpointGeneration: number;
	pid: number;
	endpointMtimeMs?: number;
	live: boolean;
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
		resolveEquivalentPath(record.locator.repo) === resolveEquivalentPath(cwd) &&
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
		current.endpointGeneration === expected.endpointGeneration &&
		current.pid === expected.pid &&
		current.endpointMtimeMs === expected.endpointMtimeMs &&
		sameResumeLocator(current, expected.locator.repo, expected.locator.stateRoot)
	);
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
async function reconcileReadyScope(broker: Broker, id: string, scope: string | undefined): Promise<void> {
	if (!scope) return;
	await broker.index.refresh();
	const record = broker.index.listSessions().sessions.find(session => session.sessionId === id);
	if (!record || record.locator.repo === scope) return;
	// The host records its physical cwd, which Darwin canonicalizes from /var to
	// /private/var. Preserve the lifecycle caller's lexical cwd for ACP's scoped
	// listing while retaining the host-provided state root for endpoint binding.
	await broker.index.append({
		type: "record_reconciled",
		sessionId: id,
		locator: { ...record.locator, repo: scope },
		endpointGeneration: record.endpointGeneration,
		pid: record.pid,
		endpointMtimeMs: record.endpointMtimeMs,
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

const lifecycleMarkerPath = (root: string, id: string) => path.join(root, "sdk", `${id}.lifecycle.json`);
const lifecycleReadyPath = (root: string, id: string) => path.join(root, "sdk", `${id}.lifecycle.ready.json`);
const lifecycleFailurePath = (root: string, id: string, effectMarker: string) =>
	path.join(root, "sdk", `${id}.lifecycle.failure.${effectMarker}.json`);
type EffectMarker = { pid: number; effectMarker: string; incarnation: string };
type ReadyAuthority = {
	endpoint: Record<string, unknown>;
	endpointSource: string;
	endpointMtimeMs: number;
	endpointGeneration: number;
};
type ReadinessResult =
	| { kind: "ready"; authority: ReadyAuthority }
	| { kind: "startup_failed"; failure: SdkStartupFailure }
	| { kind: "child_exited" }
	| { kind: "timeout" };
const processIncarnationReadersForTest = new WeakMap<Broker, (pid: number) => string | undefined>();

export function setProcessIncarnationForTest(
	broker: Broker,
	value: ((pid: number) => string | undefined) | undefined,
): void {
	if (value) processIncarnationReadersForTest.set(broker, value);
	else processIncarnationReadersForTest.delete(broker);
}

function processIncarnationForBroker(broker: Broker, pid: number): string | undefined {
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
	try {
		process.kill(pid, 0);
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "ESRCH" ? "exited" : "uncertain";
	}
	if (!expectedIncarnation) return "uncertain";
	const actualIncarnation = readIncarnation(pid);
	if (!actualIncarnation) return "uncertain";
	return actualIncarnation === expectedIncarnation ? "alive" : "exited";
}

function hasObservedProcessExit(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return false;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "ESRCH";
	}
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
	await fs.mkdir(path.join(root, "sdk"), { recursive: true, mode: 0o700 });
	await fs.writeFile(lifecycleReadyPath(root, id), canonicalJson({ pid: process.pid, effectMarker, incarnation }), {
		mode: 0o600,
	});
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
	const handle = await fs.open(directory, fsSync.constants.O_RDONLY);
	try {
		await handle.sync();
	} finally {
		await handle.close();
	}
}

/** The child writes bounded startup diagnostics before exiting without readiness. */
export async function writeSessionLifecycleFailure(
	root: string,
	id: string,
	effectMarker: string,
	failure: SdkStartupFailure,
	rollback: SdkStartupRollbackResult,
	transcript?: LifecycleTranscriptEvidence,
	ownerIncarnation?: string,
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
		pid: process.pid,
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
	]);
	const parentIdentity = record.lifecycleParentIdentity as Record<string, unknown> | undefined;
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
		record.lifecycleFiles.length > 0 &&
		record.lifecycleFiles.length <= 4 &&
		(record.lifecycleDeleteMetadata === undefined || record.lifecycleDeleteMetadata === true) &&
		record.lifecycleFiles.every(isLifecycleCleanupFile)
	);
}

function validateLifecycleCleanupShape(cleanup: CleanupEvidence): BrokerResponse | undefined {
	if (
		!isLifecycleCleanupEvidence(cleanup) ||
		lifecycleCleanupHasMixedMetadataSchema(cleanup) ||
		(cleanup.lifecycleDeleteMetadata === true && cleanup.lifecycleFiles!.length > 2)
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
): Promise<BrokerResponse> {
	const shapeValidation = validateLifecycleCleanupShape(cleanup);
	if (shapeValidation) return shapeValidation;
	let activeCleanup =
		cleanup.lifecycleDeleteMetadata === true || completion.ok
			? { ...cleanup, lifecycleDeleteMetadata: true as const }
			: cleanup;
	const metadataReplayValidation = validateLifecycleMetadataReplay(activeCleanup);
	if (metadataReplayValidation) return metadataReplayValidation;
	for (let index = 0; index < activeCleanup.lifecycleFiles!.length; index++) {
		const file = activeCleanup.lifecycleFiles![index];
		if (!validateLifecycleCleanupFile(activeCleanup.metadataRoot!, activeCleanup.sessionId!, file))
			return fail("terminal_uncertain", "Lifecycle cleanup replay contains an invalid path authority.");
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
			continue;
		}
		let activePath: string | undefined;
		let captured: LifecycleFileCapture | undefined;
		let foundUnauthorized = false;
		for (const candidate of candidates) {
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
		}
		const currentFile = activeCleanup.lifecycleFiles![index];
		const result = nativeLifecycle().exactUnlink(activePath, {
			...captured.identity,
			parentDev: BigInt(activeCleanup.lifecycleParentIdentity!.dev),
			parentIno: BigInt(activeCleanup.lifecycleParentIdentity!.ino),
			quarantineName: path.basename(currentFile.plannedPath),
		});
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
	}
	await syncDirectory(path.join(activeCleanup.metadataRoot!, "sdk"));
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

async function hasDurableProcessIdentity(
	root: string,
	id: string,
	pid: number,
	expected?: EffectMarker,
): Promise<boolean> {
	const marker = await readEffectMarker(lifecycleMarkerPath(root, id));
	if (!marker || marker.pid !== pid || (expected && !sameEffectMarker(marker, expected))) return false;
	return marker.incarnation === processIncarnation(pid);
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

type LifecycleFileCapture = {
	bytes: Buffer;
	identity: { dev: bigint; ino: bigint; size: bigint; mtimeNs: bigint; sha256: string; nlink: bigint };
	digest: string;
};

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

async function removeOwnedLifecycleArtifacts(root: string, id: string, expected: EffectMarker): Promise<boolean> {
	const marker = await readEffectMarker(lifecycleMarkerPath(root, id));
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
	const endpointParent = endpointSource ? lifecycleParentIdentity(path.dirname(endpointSource)) : undefined;
	if (endpoint && endpointSource && endpointParent) {
		let parsed: { pid?: unknown };
		try {
			parsed = parseLifecycleJson(endpoint.bytes) as { pid?: unknown };
		} catch {
			return false;
		}
		if (parsed.pid !== expected.pid || !hasObservedProcessExit(expected.pid)) return false;
		if (createHash("sha256").update(endpoint.bytes).digest("hex") !== endpoint.digest) return false;
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
		if (!endpointRemoval.ok) return false;
	}
	const currentMarker = await readEffectMarker(lifecycleMarkerPath(root, id));
	if (!currentMarker || !sameEffectMarker(currentMarker, expected)) return false;
	const readyPath = lifecycleReadyPath(root, id);
	const ready = captureLifecycleFile(readyPath, true, true);
	if (ready && createHash("sha256").update(ready.bytes).digest("hex") !== ready.digest) return false;
	// Readiness mutation is deferred to the same ledger-backed cleanup transaction.
	return true;
}

async function recordTerminalUncertain(broker: Broker, id: string, root: string, pid: number): Promise<void> {
	await broker.index.refresh();
	const registered = broker.index.listSessions().sessions.find(session => session.sessionId === id);
	if (registered)
		await broker.index.append({
			type: "lifecycle_terminal",
			sessionId: id,
			locator: registered.locator,
			endpointGeneration: registered.endpointGeneration,
			pid: registered.pid,
			terminalUncertain: true,
		});
	else
		await broker.index.append({
			type: "lifecycle_terminal",
			sessionId: id,
			locator: { repo: "unknown", stateRoot: root },
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
	await broker.index.refresh();
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
	if (observation === "alive") {
		await waitUntil(timing, terminationStartDeadlineAt);
		observation = observe();
	}
	if (observation === "alive") {
		if (!(await signalVerifiedSession({ locator: { stateRoot: root }, pid }, id, "SIGTERM", expected))) {
			observation = observe();
			if (observation !== "exited") {
				await recordTerminalUncertain(broker, id, root, pid);
				return false;
			}
		} else {
			const remaining = Math.max(0, deadline - timing.now());
			const gracefulDeadline = timing.now() + Math.min(CLOSE_TIMEOUT_MS, Math.floor(remaining / 2));
			observation = await waitForExit(gracefulDeadline);
		}
	}
	if (observation === "alive") {
		if (!(await signalVerifiedSession({ locator: { stateRoot: root }, pid }, id, "SIGKILL", expected))) {
			observation = observe();
			if (observation !== "exited") {
				await recordTerminalUncertain(broker, id, root, pid);
				return false;
			}
		} else {
			observation = await waitForExit(deadline);
		}
	}
	if (observation !== "exited") {
		await recordTerminalUncertain(broker, id, root, pid);
		return false;
	}
	let rollbackGeneration: number | null | undefined;
	if (expected) {
		const failure = await readLifecycleFailureArtifact(
			lifecycleFailurePath(root, id, expected.effectMarker),
			expected,
		);
		if (
			!failure?.artifact.rollback.fenced ||
			!failure.artifact.rollback.runtimeRemoved ||
			!failure.artifact.rollback.hostStopped ||
			!failure.artifact.rollback.brokerRegistrationReleased
		) {
			await recordTerminalUncertain(broker, id, root, pid);
			return false;
		}
		rollbackGeneration = failure.artifact.rollback.endpointGeneration;
	}
	if (expected && !(await removeOwnedLifecycleArtifacts(root, id, expected))) {
		await recordTerminalUncertain(broker, id, root, pid);
		return false;
	}
	await broker.index.refresh();
	if (
		rollbackGeneration === null &&
		expected &&
		!broker.index.hasHostRegistrationForLifecycle(id, pid, expected.effectMarker)
	)
		return true;
	const registeredBeforeTermination =
		rollbackGeneration === undefined || rollbackGeneration === null
			? undefined
			: broker.index.findHostRegistration(id, rollbackGeneration, pid, expected?.effectMarker);
	const unregistered = registeredBeforeTermination
		? broker.index.hostUnregisteredAfter(registeredBeforeTermination)
		: undefined;
	if (!registeredBeforeTermination || !unregistered) {
		await recordTerminalUncertain(broker, id, root, pid);
		return false;
	}
	return endpointRemoved(root, id);
}

async function signalVerifiedSession(
	record: { locator: { stateRoot: string }; pid: number },
	id: string,
	signal: NodeJS.Signals,
	expected?: EffectMarker,
): Promise<boolean> {
	if (!(await hasDurableProcessIdentity(record.locator.stateRoot, id, record.pid, expected))) return false;
	try {
		if (!(await hasDurableProcessIdentity(record.locator.stateRoot, id, record.pid, expected))) return false;
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

async function waitForClose(
	broker: Broker,
	id: string,
	record: { locator: { stateRoot: string }; endpointGeneration: number; pid: number; lifecycleRequestId?: string },
	timeoutMs: number,
): Promise<boolean> {
	const timing = lifecycleTiming(broker);
	const deadline = timing.now() + timeoutMs;
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
			hasObservedProcessExit(record.pid)
		)
			return true;
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
		const [endpointSource, endpointMetadata] = await Promise.all([
			fs.readFile(endpointPath, "utf8"),
			fs.stat(endpointPath),
		]);
		const endpoint = JSON.parse(endpointSource) as {
			sessionId?: unknown;
			url?: unknown;
			token?: unknown;
			pid?: unknown;
		};
		await broker.index.refresh();
		const record = broker.index.listSessions().sessions.find(session => session.sessionId === id);
		if (
			!record?.live ||
			record.pid !== expected.pid ||
			resolveEquivalentPath(record.locator.stateRoot) !== resolveEquivalentPath(root) ||
			record.endpointMtimeMs !== endpointMetadata.mtimeMs ||
			endpoint.pid !== expected.pid ||
			endpoint.sessionId !== id ||
			typeof endpoint.url !== "string" ||
			typeof endpoint.token !== "string"
		)
			return undefined;
		return {
			endpoint: endpoint as Record<string, unknown>,
			endpointSource,
			endpointMtimeMs: endpointMetadata.mtimeMs,
			endpointGeneration: record.endpointGeneration,
		};
	} catch {
		return undefined;
	}
}

function sameReadyAuthority(left: ReadyAuthority, right: ReadyAuthority): boolean {
	return (
		left.endpointSource === right.endpointSource &&
		left.endpointMtimeMs === right.endpointMtimeMs &&
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
	while (timing.now() < deadline) {
		const startupFailure = await readSessionLifecycleFailure(root, id, expected);
		if (startupFailure) return { kind: "startup_failed", failure: startupFailure };
		if (
			observeProcess(expected.pid, expected.incarnation, value => processIncarnationForBroker(broker, value)) ===
			"exited"
		) {
			const finalStartupFailure = await readSessionLifecycleFailure(root, id, expected);
			return finalStartupFailure
				? { kind: "startup_failed", failure: finalStartupFailure }
				: { kind: "child_exited" };
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

function preparePlannedWorktree(plan: GjcLaunchWorktreePlan): SessionLifecycleWorktreeReceipt {
	const prepared = ensureLaunchWorktree(plan);
	if (!prepared.enabled || path.resolve(prepared.worktreePath) !== path.resolve(plan.worktreePath))
		throw new Error("Lifecycle worktree preparation did not preserve the durable worktree identity.");
	return {
		enabled: true,
		cwd: path.resolve(prepared.worktreePath),
		created: prepared.created,
		reused: prepared.reused,
		...(prepared.branchName ? { branch: prepared.branchName } : {}),
	};
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
		const validatedModelPreset = validateBrokerModelPreset(broker.settings.agentDir, modelPreset);
		if (typeof validatedModelPreset !== "string") return validatedModelPreset;
		modelPreset = validatedModelPreset;
	}
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

	if (operation === "session.create")
		return {
			id: randomUUID(),
			cwd,
			root: resolvedRoot,
			modelPreset,
			mcpServers,
			worktree,
			worktreePlan,
			...(readiness ? { readiness } : {}),
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
			sessionIdentity: saved.identity,
			modelPreset,
			mcpServers,
			worktree,
			worktreePlan,
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
		modelPreset,
		mcpServers,
		worktree,
		worktreePlan,
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
	record: { locator: { repo: string; stateRoot: string } } | undefined,
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
		(canonicalExistingPath(record.locator.repo) !== cwd ||
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
	locator: { repo: string; stateRoot: string };
	endpointGeneration: number;
	pid: number;
	endpointMtimeMs?: number;
	lifecycleRequestId?: string;
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
			JSON.stringify({
				endpointGeneration: record.endpointGeneration,
				endpointMtimeMs: record.endpointMtimeMs,
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

function sameCloseProcessIdentity(expected: CloseRecord, current: CloseRecord & { live: boolean }): boolean {
	return (
		current.live &&
		current.pid === expected.pid &&
		typeof expected.lifecycleRequestId === "string" &&
		expected.lifecycleRequestId.length > 0 &&
		current.lifecycleRequestId === expected.lifecycleRequestId &&
		path.resolve(current.locator.repo) === path.resolve(expected.locator.repo) &&
		path.resolve(current.locator.stateRoot) === path.resolve(expected.locator.stateRoot)
	);
}

function sameCloseGeneration(expected: CloseRecord, current: CloseRecord & { live: boolean }): boolean {
	return (
		current.live &&
		current.endpointGeneration === expected.endpointGeneration &&
		current.pid === expected.pid &&
		current.endpointMtimeMs === expected.endpointMtimeMs &&
		path.resolve(current.locator.repo) === path.resolve(expected.locator.repo) &&
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
	return current &&
		sameCloseGeneration(expected, current) &&
		(!authority || sameCloseAuthority(authority, current, id))
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
		if (operation === "session.resume") {
			const requestedSessionId = sessionId(input);
			const existing = requestedSessionId
				? broker.index.listSessions().sessions.find(session => session.sessionId === requestedSessionId)
				: undefined;
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
				await broker.index.refresh();
				const current = broker.index
					.listSessions()
					.sessions.find(session => session.sessionId === requestedSessionId);
				if (!current || !sameLiveResumeRecord(existing, current))
					return fail("endpoint_stale", "Live session changed while its resume authority was being verified.");
				const finalScope = await validateLiveResumeScope(broker, input, requestedSessionId!, current);
				if ("ok" in finalScope) return finalScope;
				if (!sameResumeSessionIdentity(initialScope, finalScope))
					return fail("endpoint_stale", "Saved session changed while its resume authority was being verified.");
				return {
					ok: true,
					result: {
						sessionId: requestedSessionId,
						cwd: finalScope.cwd,
						endpointGeneration: current.endpointGeneration,
						endpoint: endpoint.result,
						reused: true,
					},
				};
			}
		}
		const timing = lifecycleTiming(broker);

		const deadlines = lifecycleDeadlines(input, timing.now());

		if ("ok" in deadlines) return deadlines;
		const lifecycleDeadline = deadlines.lifecycleCleanupDeadlineAt;
		const readinessDeadline = deadlines.semanticReadyDeadlineAt;
		const terminationStartDeadline = deadlines.terminationStartDeadlineAt;

		const launch = await launchInput(broker, operation, input);
		if ("ok" in launch) return launch;
		if (!hasProcessIncarnationAuthority())
			return fail(
				"incarnation_unavailable",
				"OS process incarnation authority is unavailable; refusing to spawn a lifecycle session.",
			);
		const effectMarker = randomUUID();
		const plannedWorktreeIntent = worktreeIntent(launch.worktreePlan);
		const effectIntent: LifecycleEffectIntent = {
			sessionId: launch.id,
			stateRoot: launch.root,
			childOwnershipEstablished: false,
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
				worktreeReceipt = preparePlannedWorktree(launch.worktreePlan);
				const worktree = {
					cwdDigest: createHash("sha256").update(worktreeReceipt.cwd, "utf8").digest("hex"),
					created: worktreeReceipt.created,
					reused: worktreeReceipt.reused,
					...(worktreeReceipt.branch
						? { branchDigest: createHash("sha256").update(worktreeReceipt.branch, "utf8").digest("hex") }
						: {}),
				};
				const durableEffects: LifecycleDurableEffectsReceipt = {
					worktree,
					digest: createHash("sha256").update(canonicalJson({ worktree })).digest("hex"),
				};
				await broker.ledger.transition(identity, "effect_started", { durableEffects });
				ensureReusableNodeModules(launch.worktreePlan.repoRoot, launch.worktreePlan.worktreePath);
			}
		} catch (error) {
			return fail(
				"spawn_failed",
				`Unable to prepare lifecycle worktree: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
		if (timing.now() >= readinessDeadline)
			return fail(
				"readiness_timeout",
				"Lifecycle preparation exhausted the semantic readiness deadline before spawning.",
			);
		if (!hasProcessIncarnationAuthority())
			return fail(
				"incarnation_unavailable",
				"OS process incarnation authority is unavailable; refusing to spawn a lifecycle session.",
			);

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
			...(launch.mcpServers ? { mcpServers: launch.mcpServers } : {}),
			...(launch.worktree ? { worktree: launch.worktree } : {}),
			...(launch.readiness ? { readiness: launch.readiness } : {}),
		};
		let child: ChildProcess | undefined;
		let spawnedAuthority: EffectMarker | undefined;
		try {
			const cmd = command(broker);
			const spawned = spawn(cmd.file, cmd.args, {
				cwd: launch.cwd,
				detached: true,
				stdio: "ignore",
				env: {
					...("kind" in cmd ? cmd.env : process.env),
					GJC_AGENT_DIR: broker.settings.agentDir,
					GJC_CODING_AGENT_DIR: broker.settings.agentDir,
					GJC_SESSION_ID: launch.id,
					GJC_STATE_ROOT: launch.root,
					GJC_LIFECYCLE_REQUEST_ID: effectMarker,
					GJC_SDK_LIFECYCLE_REQUEST: JSON.stringify(request),
				},
			});
			child = spawned;
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
			const terminated = child
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
		if (!child || !spawnedAuthority)
			return fail("spawn_failed", "Unable to retain the spawned session process identity.");
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
				return fail(
					"terminal_uncertain",
					`Session ${launch.id} did not become ready and its spawned process could not be verified dead.`,
				);
			return readiness.kind === "startup_failed"
				? fail(
						readiness.failure.code ?? "spawn_failed",
						readiness.failure.message,
						undefined,
						readiness.failure.details,
					)
				: readiness.kind === "child_exited"
					? fail("spawn_failed", `Session ${launch.id} exited before registering readiness.`)
					: fail(
							"readiness_timeout",
							`Session ${launch.id} did not register an endpoint before the readiness timeout.`,
						);
		}
		await reconcileReadyScope(broker, launch.id, launch.cwd);
		const verified = await currentReadyAuthority(broker, launch.id, launch.root, spawnedAuthority);
		if (!verified || !sameReadyAuthority(readiness.authority, verified)) {
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
				endpoint: verified.endpoint,
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
		const requestedAuthority = requestedCloseAuthority(input);
		if ("error" in requestedAuthority) return requestedAuthority.error;
		if (requestedAuthority.authority && !sameCloseAuthority(requestedAuthority.authority, record, id))
			return fail("endpoint_stale", "session endpoint is stale");
		await broker.ledger.transition(identity, "effect_started", { intendedSessionId: id, effectMarker: randomUUID() });

		let usedSignalFallback = false;
		let note: string | undefined;
		let endpointResult = await broker.handleRequest("session.get_endpoint", {
			sessionId: id,
			endpointGeneration: record.endpointGeneration,
		});
		if (!endpointResult.ok && endpointResult.error.code === "endpoint_stale" && !requestedAuthority.authority) {
			await broker.index.refresh();
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
				const refreshedEndpointResult = await broker.handleRequest("session.get_endpoint", {
					sessionId: id,
					endpointGeneration: record.endpointGeneration,
				});
				if (!refreshedEndpointResult.ok) return refreshedEndpointResult;
				const refreshedEndpoint = closeEndpoint(refreshedEndpointResult.result);
				if (
					!refreshedEndpoint ||
					refreshedEndpoint.url !== endpoint.url ||
					refreshedEndpoint.token !== endpoint.token
				)
					return fail("endpoint_stale", "session endpoint is stale");
				const stale = await revalidateCloseGeneration(broker, id, record, requestedAuthority.authority);
				if (stale) return stale;
				const response = await client.control("session.close");
				if ((response as { ok?: unknown }).ok !== true)
					return fail("close_refused", "Session endpoint rejected session.close.");
			} catch (error) {
				if (isTransportFailure(error)) usedSignalFallback = true;
				else if (error instanceof SdkClientError) return fail(error.code, error.message);
				else
					return fail(
						"close_refused",
						`Session endpoint close failed: ${error instanceof Error ? error.message : String(error)}`,
					);
			} finally {
				await client?.close();
			}
		}

		if (usedSignalFallback) {
			const stale = await revalidateCloseGeneration(broker, id, record, requestedAuthority.authority);
			if (stale) return stale;
			if (!(await signalVerifiedSession(record, id, "SIGTERM")))
				return fail(
					"close_refused",
					"Session endpoint is unavailable and its durable process identity could not be verified.",
				);
			note = "Endpoint close was unreachable; sent SIGTERM to the durably identified session process.";
		}

		let closed = await waitForClose(broker, id, record, CLOSE_TIMEOUT_MS);
		if (!closed && !usedSignalFallback) {
			const stale = await revalidateCloseGeneration(broker, id, record, requestedAuthority.authority);
			if (stale) return stale;
			if (!(await signalVerifiedSession(record, id, "SIGTERM"))) {
				await recordTerminalUncertain(broker, id, record.locator.stateRoot, record.pid);
				return fail(
					"terminal_uncertain",
					"Session acknowledged session.close but its durable process identity could not be verified for shutdown escalation.",
				);
			}
			note =
				"Session acknowledged session.close but graceful teardown did not complete within the bounded deadline; sent SIGTERM to the durably identified session process.";
			closed = await waitForClose(broker, id, record, CLOSE_TIMEOUT_MS);
		}
		if (!closed) {
			const stale = await revalidateCloseGeneration(broker, id, record, requestedAuthority.authority);
			if (stale) return stale;
			if (!(await signalVerifiedSession(record, id, "SIGKILL"))) {
				await recordTerminalUncertain(broker, id, record.locator.stateRoot, record.pid);
				return fail(
					"terminal_uncertain",
					"Session did not close after SIGTERM and its durable process identity could not be verified for SIGKILL.",
				);
			}
			note =
				"Session teardown did not complete after SIGTERM within the bounded deadline; sent SIGKILL to the durably identified session process.";
			closed = await waitForClose(broker, id, record, CLOSE_TIMEOUT_MS);
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
		if (record)
			await broker.index.append({
				type: "session_closed",
				sessionId: id,
				locator: record.locator,
				endpointGeneration: record.endpointGeneration,
				pid: record.pid,
			});
		return completion;
	}
	return fail("invalid_input", "Unknown lifecycle operation.");
}

async function exactCleanupProof(
	broker: Broker,
	root: string | undefined,
	id: string | undefined,
	expected: EffectMarker | undefined,
	evidence: { artifact: LifecycleFailureArtifact } | undefined,
): Promise<LifecycleCleanupProof | undefined> {
	const rollback = evidence?.artifact.rollback;
	if (
		!root ||
		!id ||
		!expected ||
		!rollback?.fenced ||
		!rollback.runtimeRemoved ||
		!rollback.hostStopped ||
		!rollback.brokerRegistrationReleased ||
		observeProcess(expected.pid, expected.incarnation, value => processIncarnationForBroker(broker, value)) !==
			"exited" ||
		!(await endpointRemoved(root, id))
	)
		return undefined;
	await broker.index.refresh();
	if (rollback.endpointGeneration === null) {
		if (broker.index.hasHostRegistrationForLifecycle(id, expected.pid, expected.effectMarker)) return undefined;
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
	return hostUnregistered
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
			response: await reconcileLifecycleCleanup(broker, identity, migrated, {
				ok: true,
				result: { sessionId: migrated.sessionId },
			}),
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
			),
		};
	}
	const response = await executeLifecycleResponse(broker, operation, input, identity, cleanup);
	const entry = broker.ledger.get(identity);
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
	const cleanupProof = await exactCleanupProof(broker, root, entry?.intendedSessionId, expected, evidence);
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
					await broker.ledger.transition(identity, "effect_started", {
						response: fail(
							"cleanup_pending",
							"Lifecycle failure cleanup is preauthorized for durable reconciliation.",
							cleanupIntent,
						),
					});
					return reconcileLifecycleCleanup(broker, identity, cleanupIntent);
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
	const terminalResponse: BrokerResponse =
		!response.ok &&
		entry?.effectMarker &&
		(operation === "session.create" || operation === "session.fork" || operation === "session.resume")
			? entry.effectIntent?.childOwnershipEstablished === false
				? response
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
										message: "No ready SDK endpoint remains available.",
										endpoint: "unavailable" as const,
									},
							...(durableEffects ? { durableEffects } : {}),
							startupFailure,
						}
					: {
							ok: false,
							error: {
								code: "terminal_uncertain",
								message:
									"Lifecycle startup cleanup could not be proven; retained artifacts require reconciliation.",
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
