import { type ChildProcess, spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import * as fsSync from "node:fs";
import * as fs from "node:fs/promises";
import path from "node:path";
import { getSessionsDir, resolveEquivalentPath } from "@gajae-code/utils";

import {
	ensureLaunchWorktree,
	ensureReusableNodeModules,
	type GjcLaunchWorktreePlan,
	planLaunchWorktree,
} from "../../gjc-runtime/launch-worktree";

import { SessionManager } from "../../session/session-manager";
import {
	FileSessionStorage,
	SessionDeleteVerificationError,
	type VerifiedSessionDeleteTarget,
} from "../../session/session-storage";
import { SdkClient, SdkClientError } from "../client/client";
import type { SdkStartupFailure, SdkStartupRollbackResult } from "../startup-capability";

import type { Broker, BrokerCleanupEvidence, BrokerResponse } from "./broker";

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
import { resolveSdkInternalSpawnCommand } from "./runtime";

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
}

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
	worktree?: SessionLifecycleWorktreeTarget;
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
		/^\d+$/.test(identity.mtimeNs)
	);
}

function hasValidTranscriptAuthority(path: unknown, identity: unknown): path is string {
	return typeof path === "string" && path.length > 0 && isSessionLifecycleTranscriptIdentity(identity);
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
	worktree?: SessionLifecycleWorktreeTarget;
	worktreePlan?: GjcLaunchWorktreePlan;
};

type CleanupEvidence = BrokerCleanupEvidence;

const fail = (code: string, message: string, cleanup?: CleanupEvidence): BrokerResponse => ({
	ok: false,
	error: { code: code as never, message, ...(cleanup ? { cleanup } : {}) },
});
function text(value: unknown): string | undefined {
	return typeof value === "string" && value ? value : undefined;
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
		left.sessionIdentity.mtimeNs === right.sessionIdentity.mtimeNs
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
}): SessionLifecycleTranscriptIdentity {
	return {
		dev: identity.dev.toString(),
		ino: identity.ino.toString(),
		size: identity.size,
		mtimeMs: identity.mtimeMs,
		mtimeNs: identity.mtimeNs.toString(),
	};
}

function validateSavedTranscript(
	broker: Broker,
	cwd: string,
	suppliedPath: string | undefined,
	expectedSessionId: string | undefined,
	label: "Saved" | "Source",
): ValidatedTranscript | BrokerResponse {
	const inventory = SessionManager.inventorySessionsStrict(cwd, {
		sessionDir: SessionManager.getDefaultSessionDir(cwd, broker.settings.agentDir),
	});
	if (inventory.kind !== "complete")
		return fail("invalid_input", `${label} session storage could not be verified for the requested workspace.`);
	const canonicalPath = suppliedPath ? path.resolve(suppliedPath) : undefined;
	const matches = inventory.candidates.filter(
		candidate =>
			(canonicalPath === undefined || candidate.path === canonicalPath) &&
			(expectedSessionId === undefined || candidate.id === expectedSessionId),
	);
	if (matches.length !== 1 || !isCanonicalSessionId(matches[0]!.id))
		return fail("invalid_input", `${label} saved session does not match the requested workspace and session id.`);
	const match = matches[0]!;
	return { path: match.path, id: match.id, identity: serializeTranscriptIdentity(match.identity) };
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
	const inventory = SessionManager.inventorySessionsStrict(cwd, {
		sessionDir: SessionManager.getDefaultSessionDir(cwd, broker.settings.agentDir),
	});
	if (inventory.kind !== "complete")
		return fail("endpoint_stale", "Requested saved session could not be verified for the requested workspace.");
	const canonicalSessionPath = path.resolve(sessionPath);
	const matches = inventory.candidates.filter(
		candidate => candidate.id === requestedSessionId && candidate.path === canonicalSessionPath,
	);
	if (matches.length !== 1)
		return fail("endpoint_stale", "Requested saved session does not match the live session scope.");
	const session = matches[0]!;
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

function command(): { file: string; args: string[] } {
	const configured = process.env.GJC_SDK_SESSION_COMMAND;
	if (configured) {
		const [file, ...args] = configured.trim().split(/\s+/);
		if (file) return { file, args };
	}
	return resolveSdkInternalSpawnCommand("session-host-internal");
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
	| { kind: "startup_failed"; message: string }
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
	const marker = value as Partial<EffectMarker>;
	return (
		typeof marker.pid === "number" &&
		Number.isSafeInteger(marker.pid) &&
		marker.pid > 0 &&
		typeof marker.effectMarker === "string" &&
		marker.effectMarker.length > 0 &&
		typeof marker.incarnation === "string" &&
		marker.incarnation.length > 0
	);
}

function sameEffectMarker(left: EffectMarker, right: EffectMarker): boolean {
	return left.pid === right.pid && left.effectMarker === right.effectMarker && left.incarnation === right.incarnation;
}

async function readEffectMarker(file: string): Promise<EffectMarker | undefined> {
	try {
		const marker: unknown = JSON.parse(await fs.readFile(file, "utf8"));
		return isEffectMarker(marker) ? marker : undefined;
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
	await fs.writeFile(lifecycleReadyPath(root, id), JSON.stringify({ pid: process.pid, effectMarker, incarnation }), {
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
		isSessionLifecycleTranscriptIdentity(record.identity)
	);
}

function isSdkStartupFailure(value: unknown): value is SdkStartupFailure {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
	const failure = value as Record<string, unknown>;
	return (
		Object.keys(failure).length === 3 &&
		(failure.phase === "registration" || failure.phase === "startup") &&
		(failure.reason === "disabled" ||
			failure.reason === "ineligible" ||
			failure.reason === "factory_absent" ||
			failure.reason === "runner_absent" ||
			failure.reason === "pending" ||
			failure.reason === "failed") &&
		typeof failure.message === "string" &&
		Buffer.byteLength(failure.message) > 0 &&
		Buffer.byteLength(failure.message) <= 512
	);
}

function isLifecycleFailureArtifact(value: unknown): value is LifecycleFailureArtifact {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
	const record = value as Record<string, unknown>;
	if (!isEffectMarker(record)) return false;
	const artifact = value as LifecycleFailureArtifact;
	return (
		Object.keys(record).length === (artifact.transcript === undefined ? 7 : 8) &&
		isSdkStartupFailure({ phase: artifact.phase, reason: artifact.reason, message: artifact.message }) &&
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
): Promise<{ artifact: LifecycleFailureArtifact; bytes: Buffer; digest: string } | undefined> {
	let handle: fs.FileHandle | undefined;
	try {
		handle = await fs.open(file, fsSync.constants.O_RDONLY | fsSync.constants.O_NOFOLLOW);
		const stat = await handle.stat();
		if (!stat.isFile() || stat.size > 4096) return undefined;
		const bytes = Buffer.alloc(stat.size + 1);
		const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0);
		if (bytesRead > 4096) return undefined;
		const raw = bytes.subarray(0, bytesRead);
		const value: unknown = JSON.parse(raw.toString("utf8"));
		if (
			!isLifecycleFailureArtifact(value) ||
			!sameEffectMarker(value, expected) ||
			canonicalJson(value) !== raw.toString("utf8")
		)
			return undefined;
		return { artifact: value, bytes: raw, digest: createHash("sha256").update(raw).digest("hex") };
	} catch {
		return undefined;
	} finally {
		if (handle) await handle.close();
	}
}

async function readSessionLifecycleFailure(
	root: string,
	id: string,
	expected: EffectMarker,
): Promise<LifecycleFailureArtifact | undefined> {
	return (await readLifecycleFailureArtifact(lifecycleFailurePath(root, id, expected.effectMarker), expected))
		?.artifact;
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

async function removeOwnedLifecycleArtifacts(root: string, id: string, expected: EffectMarker): Promise<boolean> {
	const marker = await readEffectMarker(lifecycleMarkerPath(root, id));
	if (!marker || !sameEffectMarker(marker, expected)) return false;
	const endpointPath = path.join(root, "sdk", `${id}.json`);
	try {
		const endpoint = JSON.parse(await fs.readFile(endpointPath, "utf8")) as { pid?: unknown };
		if (endpoint.pid !== expected.pid || !hasObservedProcessExit(expected.pid)) return false;
		await fs.rm(endpointPath);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") return false;
	}
	if (!(await endpointRemoved(root, id))) return false;
	const currentMarker = await readEffectMarker(lifecycleMarkerPath(root, id));
	if (!currentMarker || !sameEffectMarker(currentMarker, expected)) return false;
	try {
		await fs.rm(lifecycleReadyPath(root, id), { force: true });
	} catch {
		return false;
	}
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
		return endpointRemoved(root, id);
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

async function waitForReady(
	broker: Broker,
	id: string,
	root: string,
	deadline: number,
	expected: EffectMarker,
	timing: LifecycleTiming,
): Promise<ReadinessResult> {
	while (timing.now() < deadline) {
		const startupFailure = await readSessionLifecycleFailure(root, id, expected);
		if (startupFailure) return { kind: "startup_failed", message: startupFailure.message };
		if (
			observeProcess(expected.pid, expected.incarnation, value => processIncarnationForBroker(broker, value)) ===
			"exited"
		) {
			const finalStartupFailure = await readSessionLifecycleFailure(root, id, expected);
			return finalStartupFailure
				? { kind: "startup_failed", message: finalStartupFailure.message }
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
							frame.name === "session_ready" &&
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
	const modelPreset = text(input.modelPreset);

	if (operation === "session.create")
		return { id: randomUUID(), cwd, root: resolvedRoot, modelPreset, worktree, worktreePlan };
	if (operation === "session.resume") {
		if (!requested) return fail("invalid_input", "sessionId is required to resume a saved session.");
		const savedPath = text(input.sessionPath);
		if (!savedPath) return fail("invalid_input", "sessionPath is required to resume a saved session.");
		const saved = validateSavedTranscript(broker, cwd, savedPath, requested, "Saved");
		if ("ok" in saved) return saved;
		return {
			id: requested,
			cwd,
			root: resolvedRoot,
			sessionPath: saved.path,
			sessionIdentity: saved.identity,
			modelPreset,
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
	const source = validateSavedTranscript(broker, sourceCwd, sourceSessionPath, sourceSessionId, "Source");
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
		worktree,
		worktreePlan,
	};
}

function within(root: string, candidate: string): boolean {
	const relative = path.relative(root, candidate);
	return relative !== "" && !relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative);
}
type ValidatedDelete = {
	storage: FileSessionStorage;
	target: VerifiedSessionDeleteTarget;
	metadataRoot: string;
};

async function validateDeletePath(
	broker: Broker,
	input: Input,
	id: string,
	record: { locator: { repo: string; stateRoot: string } } | undefined,
): Promise<ValidatedDelete | BrokerResponse> {
	const sessionPath = text(input.sessionPath);
	const cwd = lifecycleCwd(input);
	if (!sessionPath || !cwd)
		return fail("invalid_input", "session.delete requires sessionPath and its configured cwd.");
	const requestedRoot = stateRoot(input, cwd);
	if (!requestedRoot || !hasDefaultStateRoot(cwd, requestedRoot))
		return fail("invalid_input", "stateRoot must be the default .gjc/state for cwd.");
	if (
		record &&
		(path.resolve(record.locator.repo) !== cwd || path.resolve(record.locator.stateRoot) !== requestedRoot)
	)
		return fail("invalid_input", "session.delete locator does not match the indexed session.");

	const unresolved = path.resolve(sessionPath);
	const storageRoot = await fs
		.realpath(getSessionsDir(broker.settings.agentDir))
		.catch(() => path.resolve(getSessionsDir(broker.settings.agentDir)));
	const canonicalParent = await fs.realpath(path.dirname(unresolved)).catch(() => path.dirname(unresolved));
	const candidate = path.join(canonicalParent, path.basename(unresolved));
	if (!candidate.endsWith(".jsonl") || !within(storageRoot, candidate))
		return fail("invalid_input", "session.delete path is outside the configured session storage root.");
	try {
		if ((await fs.lstat(candidate)).isSymbolicLink())
			return fail("invalid_input", "session.delete path is a symlink.");
	} catch {
		return fail("not_found", "Requested saved session does not exist.");
	}
	let resolved: string;
	try {
		resolved = await fs.realpath(candidate);
	} catch {
		return fail("not_found", "Requested saved session does not exist.");
	}
	if (!within(storageRoot, resolved))
		return fail("invalid_input", "session.delete path resolves outside the configured session storage root.");

	const storage = new FileSessionStorage();
	let snapshot: ReturnType<FileSessionStorage["readSnapshotSync"]>;
	try {
		snapshot = storage.readSnapshotSync(resolved);
	} catch {
		return fail("not_found", "Requested saved session does not exist or cannot be read.");
	}
	try {
		const newline = snapshot.bytes.indexOf(0x0a);
		const firstLine = Buffer.from(
			snapshot.bytes.subarray(0, newline === -1 ? snapshot.bytes.length : newline),
		).toString("utf8");
		const header = JSON.parse(firstLine) as { type?: unknown; id?: unknown; cwd?: unknown };
		if (header.type !== "session" || header.id !== id)
			return fail("invalid_input", "session.delete path does not contain the requested session.");
		if (typeof header.cwd !== "string")
			return fail("invalid_input", "session.delete transcript cwd does not match the configured cwd.");
		const transcriptCwd = header.cwd;
		const headerCwd = await fs.realpath(transcriptCwd).catch(() => path.resolve(transcriptCwd));
		const requestedCwd = await fs.realpath(cwd).catch(() => cwd);
		if (headerCwd !== requestedCwd)
			return fail("invalid_input", "session.delete transcript cwd does not match the configured cwd.");
	} catch {
		return fail("invalid_input", "Requested saved session has an invalid header.");
	}
	return {
		storage,
		target: {
			sessionsRoot: storageRoot,
			transcriptPath: resolved,
			sessionId: id,
			cwd,
			transcriptIdentity: { dev: snapshot.stat.dev, ino: snapshot.stat.ino },
		},
		metadataRoot: requestedRoot,
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
): Promise<BrokerResponse> {
	const requestedSessionId = sessionId(input);
	if (requestedSessionId !== undefined && !isCanonicalSessionId(requestedSessionId))
		return fail("invalid_input", "sessionId must be a canonical safe identifier.");
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
		const cmd = command();
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
			...(launch.worktree ? { worktree: launch.worktree } : {}),
		};
		let child: ChildProcess | undefined;
		let spawnedAuthority: EffectMarker | undefined;
		try {
			const spawned = spawn(cmd.file, cmd.args, {
				cwd: launch.cwd,
				detached: true,
				stdio: "ignore",
				env: {
					...process.env,
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
		const readiness = await waitForReady(broker, launch.id, launch.root, readinessDeadline, spawnedAuthority, timing);

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
				? fail("spawn_failed", readiness.message)
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
				...(worktreeReceipt ? { worktree: worktreeReceipt } : {}),
			},
		};
	}

	const id = sessionId(input);
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
		const validated = await validateDeletePath(broker, input, id, record);
		if ("ok" in validated) return validated;
		await broker.ledger.transition(identity, "effect_started", { intendedSessionId: id, effectMarker: randomUUID() });
		let deleted: Awaited<ReturnType<FileSessionStorage["deleteSessionVerified"]>>;
		try {
			deleted = await validated.storage.deleteSessionVerified(validated.target);
		} catch (error) {
			if (error instanceof SessionDeleteVerificationError)
				return fail(
					"invalid_input",
					`Saved session deletion verification failed (${error.kind}): ${error.message}`,
				);
			return fail(
				"unavailable",
				`Unable to delete saved session artifacts: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
		if (deleted.kind === "cleanup_pending")
			return fail(
				"cleanup_pending",
				`Saved session cleanup is pending in ${deleted.phase}: ${deleted.error.message}`,
				{
					phase: deleted.phase,
					transcriptIdentity: {
						dev: deleted.transcriptIdentity.dev.toString(),
						ino: deleted.transcriptIdentity.ino.toString(),
					},
					...(deleted.phase === "artifacts" && deleted.artifactsIdentity
						? {
								artifactsIdentity: {
									dev: deleted.artifactsIdentity.dev.toString(),
									ino: deleted.artifactsIdentity.ino.toString(),
								},
							}
						: {}),
				},
			);

		if (record)
			await broker.index.append({
				type: "session_closed",
				sessionId: id,
				locator: record.locator,
				endpointGeneration: record.endpointGeneration,
				pid: record.pid,
			});
		try {
			await fs.rm(lifecycleMarkerPath(validated.metadataRoot, id), { force: true });
		} catch (error) {
			return fail(
				"cleanup_pending",
				`Saved session was deleted but lifecycle metadata cleanup is pending: ${
					error instanceof Error ? error.message : String(error)
				}`,
				{ phase: "metadata" },
			);
		}
		return { ok: true, result: { sessionId: id } };
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
): Promise<LifecycleExecutionOutcome> {
	const response = await executeLifecycleResponse(broker, operation, input, identity);
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
	const terminalResponse: BrokerResponse =
		!response.ok &&
		entry?.effectMarker &&
		(operation === "session.create" || operation === "session.fork" || operation === "session.resume")
			? entry.effectIntent?.childOwnershipEstablished === false
				? response
				: startupFailure && cleanupProof
					? {
							ok: false,
							error: {
								code: "spawn_failed",
								message: "No ready SDK endpoint remains available.",
								endpoint: "unavailable",
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
		...(evidence && root && entry?.intendedSessionId && cleanupProof
			? {
					deferredArtifactCleanup: async () => {
						const current = await readLifecycleFailureArtifact(
							lifecycleFailurePath(root, entry.intendedSessionId!, evidence.artifact.effectMarker),
							evidence.artifact,
						);
						const marker = await readEffectMarker(lifecycleMarkerPath(root, entry.intendedSessionId!));
						if (current?.digest !== evidence.digest || !marker || !sameEffectMarker(marker, evidence.artifact))
							return;
						await fs.rm(lifecycleFailurePath(root, entry.intendedSessionId!, evidence.artifact.effectMarker));
						await fs.rm(lifecycleMarkerPath(root, entry.intendedSessionId!));
						await syncDirectory(path.join(root, "sdk"));
					},
				}
			: {}),
	};
}
