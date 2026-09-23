import { createHash } from "node:crypto";
import * as nodeFs from "node:fs";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { logger, postmortem } from "@gajae-code/utils";
import { Args, CliParseError, Command, Flags } from "@gajae-code/utils/cli";
import type { Args as ParsedArgs } from "../cli/args";
import { isSafeSdkInternalAgentDir, scanPublicCommand } from "../cli/public-command-entry";
import { PublicCommandFailure } from "../cli/public-command-errors";
import { parseModelString } from "../config/model-resolver";
import { Settings } from "../config/settings";
import { applyStartupModelProfiles, createSessionManager } from "../main";
import { initializeExtensions } from "../modes/runtime-init";
import { initTheme } from "../modes/theme/theme";
import { ACP_MCP_REQUEST_TIMEOUT_MS, ACP_MCP_STARTUP_HEADROOM_MS } from "../sdk/acp/mcp";
import { Broker } from "../sdk/broker/broker";
import {
	type BrokerStartupExitRecord,
	type BrokerStartupExitWriteStatus,
	writeBrokerStartupExitRecordBounded,
	writeBrokerStartupExitRecordSynchronously,
} from "../sdk/broker/broker-exit";
import { readBrokerDiscovery } from "../sdk/broker/discovery";
import {
	emitBrokerStartupTestSignal,
	reconcileBrokerGenerationForStartup,
	withBrokerStartupLock,
} from "../sdk/broker/ensure";
import {
	LifecycleReadinessCleanupError,
	type LifecycleTranscriptEvidence,
	readSessionLifecycleLaunchRequest,
	type SessionLifecycleLaunchRequest,
	type SessionLifecycleTranscriptIdentity,
	sessionHostAttachedClients,
	sessionHostWorkLeaseActive,
	startBrokerDeadRegistrationSweep,
	writeSessionLifecycleFailure,
	writeSessionLifecycleReady,
} from "../sdk/broker/lifecycle";
import { processIncarnation } from "../sdk/broker/process-incarnation";
import { writeBrokerStartupFailureMarker } from "../sdk/broker/startup-failure";
import { runSdkStderrDrainer } from "../sdk/broker/stderr-drainer";
import { renderSdkSearchTable, runSdkSearch, runSdkSessionCli } from "../sdk/cli";
import { renderSpawnTable, runSdkSpawn, SdkMasterCliError } from "../sdk/cli/master-cli";
import { runSdkGuidesCli } from "../sdk/guides/cli";
import {
	type CreateLifecycleAgentSessionResult,
	createLifecycleAgentSession,
	type SdkLifecycleStartupOwner,
} from "../sdk/lifecycle-session";
import { listManagedSessionCandidates, resolveManagedSessionScope } from "../sdk/session-directory";
import {
	SdkStartupCapability,
	type SdkStartupFailure,
	type SdkStartupResult,
	type SdkStartupRollbackResult,
	SdkStartupRollbackTracker,
} from "../sdk/startup-capability";
import { runSdkServe, SdkServeError } from "../sdk/transport/serve-cli";
import { isSessionDisposalIncompleteError } from "../session/agent-session";
import {
	type CapturedSessionTranscriptSnapshot,
	type ResumeSessionIdentity,
	SessionManager,
} from "../session/session-manager";

export async function lifecycleArgs(
	request: SessionLifecycleLaunchRequest,
	cwd: string,
	agentDir: string,
): Promise<ParsedArgs> {
	const targetScope = await resolveManagedSessionScope({ cwd, agentDir });
	if (targetScope.kind !== "resolved") throw new Error(`Lifecycle session scope is invalid: ${targetScope.message}`);
	const forkSessionDir =
		request.operation === "session.fork" ? SessionManager.getDefaultSessionDir(cwd, agentDir) : undefined;
	return {
		messages: [],
		fileArgs: [],
		unknownFlags: new Map(),
		...(process.env.GJC_SDK_TEST_IN_MEMORY_SESSION === "1" ? { noSession: true } : {}),
		...(request.operation === "session.resume" ? { resume: request.sessionPath } : {}),
		...(request.modelPreset ? { mpreset: request.modelPreset } : {}),
		// Explicit model pin (#4707): coordinator-resolved `provider/model`
		// selector applied exactly like CLI `--model`. createAgentSession
		// resolves it through the same staged selector resolver, and startup
		// model-profile application then overrides the activated profile with
		// this explicit selection (main.ts applyStartupModelProfilesWithPolicy),
		// matching `gjc --mpreset p --model m` precedence.
		...(request.modelId ? { model: request.modelId } : {}),
		...(request.operation === "session.fork"
			? {
					fork: request.sourceSessionPath ?? request.sourceSessionId,
					sessionDir: forkSessionDir,
				}
			: {}),
	};
}

/**
 * How long a session host tolerates losing the broker it was launched under
 * before treating itself as orphaned.
 *
 * A host is reachable only through its own broker: routing lives in the broker
 * process and a replacement broker never adopts hosts from an earlier
 * incarnation, so a host that outlives its broker is stranded no matter how
 * healthy the agent directory looks afterwards. The grace still has to outlast
 * a restart-shaped gap, because a broker that is merely slow to republish must
 * never cost a live host — but it must stay finite, or every crashed or
 * torn-down broker leaks a detached multi-hundred-megabyte host forever.
 */
export const SESSION_HOST_BROKER_ABSENCE_GRACE_MS = 10 * 60_000;
const SESSION_HOST_BROKER_POLL_MS = 15_000;
const BROKER_STARTUP_MARKER_WRITE_TIMEOUT_MS = 1_000;

async function writeBrokerStartupFailureMarkerBounded(
	agentDir: string,
	failure: { reason: string; exitCode: number | null; signal: string | null; pid: number; incarnation?: string },
): Promise<boolean> {
	const settled = Promise.withResolvers<boolean>();
	const abortController = new AbortController();
	const timer = setTimeout(() => {
		abortController.abort();
		settled.resolve(false);
	}, BROKER_STARTUP_MARKER_WRITE_TIMEOUT_MS);
	void writeBrokerStartupFailureMarker(agentDir, failure, abortController.signal).then(
		written => settled.resolve(written),
		() => settled.resolve(false),
	);
	const written = await settled.promise;
	clearTimeout(timer);
	return written;
}

async function waitForBrokerStartupTestGate(gateFile: string): Promise<void> {
	if (await Bun.file(gateFile).exists()) return;
	const directory = path.dirname(gateFile);
	const filename = path.basename(gateFile);
	await new Promise<void>((resolve, reject) => {
		let settled = false;
		let watcher: nodeFs.FSWatcher | undefined;
		const finish = (error?: unknown): void => {
			if (settled) return;
			settled = true;
			watcher?.close();
			if (error === undefined) resolve();
			else reject(error);
		};
		try {
			watcher = nodeFs.watch(directory, (_eventType, changed) => {
				if (String(changed) !== filename) return;
				void Bun.file(gateFile)
					.exists()
					.then(exists => {
						if (exists) finish();
					})
					.catch(finish);
			});
		} catch (error) {
			finish(error);
			return;
		}
		void Bun.file(gateFile)
			.exists()
			.then(exists => {
				if (exists) finish();
			})
			.catch(finish);
	});
}

/**
 * Identity of the broker incarnation an observation describes, or `null` when
 * it carries no usable identity.
 *
 * Two observations with different identities are two different brokers, never
 * the same broker seen twice: `incarnation` is start-time derived, so it
 * separates a genuine survivor from a successor that merely reused the pid.
 */
function brokerPublicationIdentity(observation: unknown): string | null {
	if (!observation || typeof observation !== "object") return null;
	const { ownerId, pid, incarnation } = observation as {
		ownerId?: unknown;
		pid?: unknown;
		incarnation?: unknown;
	};
	const parts = [
		typeof ownerId === "string" ? ownerId : "",
		Number.isSafeInteger(pid) ? String(pid) : "",
		typeof incarnation === "string" ? incarnation : "",
	];
	return parts.some(part => part !== "") ? parts.join(":") : null;
}

/**
 * Resolves only once the broker this host was launched under has been
 * unobservable for the full grace window.
 *
 * The first identifiable publication pins that broker. A later publication from
 * a different incarnation is a replacement, and a replacement cannot route to
 * this host — observing one is evidence of being stranded, not of being alive —
 * so it accrues against the bound instead of resetting it. Only the pinned
 * broker reappearing resets the window. An unreadable or unidentifiable
 * publication is not proof of orphanhood but accrues against the same bound.
 */
export async function watchSessionHostBrokerLiveness(deps: {
	agentDir: string;
	now?: () => number;
	sleep?: (ms: number) => Promise<void>;
	readDiscovery?: (agentDir: string) => Promise<unknown>;
	graceMs?: number;
	pollMs?: number;
}): Promise<void> {
	const now = deps.now ?? Date.now;
	const sleep = deps.sleep ?? (async ms => await Bun.sleep(ms));
	const readDiscovery = deps.readDiscovery ?? readBrokerDiscovery;
	const graceMs = deps.graceMs ?? SESSION_HOST_BROKER_ABSENCE_GRACE_MS;
	const pollMs = deps.pollMs ?? SESSION_HOST_BROKER_POLL_MS;
	let absentSince: number | null = null;
	let ownBroker: string | null = null;
	for (;;) {
		let live: unknown = null;
		try {
			live = await readDiscovery(deps.agentDir);
		} catch {
			// Transient read failures are ambiguity, not proof of orphanhood.
		}
		const identity = brokerPublicationIdentity(live);
		if (identity !== null && (ownBroker === null || identity === ownBroker)) {
			ownBroker ??= identity;
			absentSince = null;
		} else {
			absentSince ??= now();
			if (now() - absentSince >= graceMs) return;
		}
		await sleep(pollMs);
	}
}

/**
 * How long a session host that has served at least one client tolerates having
 * no client attached before treating itself as abandoned.
 *
 * This cannot fire during healthy work. "Attached" is the host's own live
 * demand count: observer-only sockets (such as an idle chat daemon) do not
 * reset the window, while an in-flight turn is reported separately. Only a
 * client that is actually demanding the host opens it, and 30 minutes is far
 * longer than any client
 * reconnect budget (ACP's is seconds), so a crashed-and-restarted client
 * reattaches long before the window closes.
 */
export const SESSION_HOST_DETACHED_IDLE_GRACE_MS = 30 * 60_000;

/**
 * How long a freshly spawned session host waits for its very first client
 * before treating itself as abandoned.
 *
 * A host is ready before its client has finished dialing, so a host that has
 * never seen an attachment must not be judged by the detached window above. One
 * hour is orders of magnitude beyond the slowest observed cold start (worktree
 * preparation, MCP server launch, model-profile application) and beyond any
 * lifecycle readiness deadline the broker will wait on, so it can only elapse
 * for a host nobody ever came for.
 */
export const SESSION_HOST_FIRST_ATTACH_GRACE_MS = 60 * 60_000;

const SESSION_HOST_ATTACHMENT_POLL_MS = 30_000;

/**
 * Resolves once the host is provably abandoned: either it has been detached
 * from every client for a full idle grace, or nobody has come for it at all
 * for a full first-attach grace.
 *
 * `readAttachedClients` reports the host's own live demanding-client count;
 * `undefined` means the SDK endpoint publishes no such evidence — before
 * startup, after teardown, or when every reader itself fails. That ambiguity is
 * never instant detachment: it cannot reap on the poll that first sees it, it
 * can only open a window. Which window depends on what was already observed. A
 * host never seen attached accrues against the first-attach bound. A host that
 * was seen attached and has since lost its evidence is in the *more* suspicious
 * state — a runtime that retracted its registration during teardown looks
 * exactly like this — so it accrues against the detached idle bound, alongside
 * an observed count of zero. Every reachable state therefore carries a finite
 * bound.
 *
 * `readWorkLease` reports whether the host's authoritative session-work lease
 * is held. A lease is positive proof a client did come for this host: a prompt
 * can only arrive over an endpoint a client dialed. Live work therefore
 * restarts both windows, which is what keeps a mid-prompt host alive whether
 * its count reads zero or stops being readable at all. That still bounds a
 * host whose SDK runtime never came up: with no transport it can never receive
 * a prompt, so it never acquires work and its window keeps running from process
 * start. Releasing the lease resumes the applicable bound.
 */
export async function watchSessionHostClientAttachment(deps: {
	readAttachedClients: () => number | undefined;
	readWorkLease?: () => boolean;
	now?: () => number;
	sleep?: (ms: number) => Promise<void>;
	idleGraceMs?: number;
	firstAttachGraceMs?: number;
	pollMs?: number;
}): Promise<"detached_idle"> {
	const now = deps.now ?? Date.now;
	const sleep = deps.sleep ?? (async ms => await Bun.sleep(ms));
	const readWorkLease = deps.readWorkLease ?? (() => false);
	const idleGraceMs = deps.idleGraceMs ?? SESSION_HOST_DETACHED_IDLE_GRACE_MS;
	const firstAttachGraceMs = deps.firstAttachGraceMs ?? SESSION_HOST_FIRST_ATTACH_GRACE_MS;
	const pollMs = deps.pollMs ?? SESSION_HOST_ATTACHMENT_POLL_MS;
	let everAttached = false;
	let detachedSince: number | null = null;
	/** Start of the current window in which nobody has been shown to want this host. */
	let unattendedSince = now();
	for (;;) {
		const attached = deps.readAttachedClients();
		if (readWorkLease()) {
			unattendedSince = now();
			detachedSince = null;
		}
		if (attached !== undefined && attached > 0) {
			everAttached = true;
			detachedSince = null;
		} else if (everAttached) {
			// An observed zero and no readable evidence at all are the same
			// absence once a client has been seen: a runtime that retracted its
			// registration stops publishing a count instead of reporting zero.
			// Both accrue against the idle bound rather than running forever.
			detachedSince ??= now();
			if (now() - detachedSince >= idleGraceMs) return "detached_idle";
		} else if (now() - unattendedSince >= firstAttachGraceMs) {
			return "detached_idle";
		}
		await sleep(pollMs);
	}
}

type LifecycleTranscriptSource = {
	cwd: string;
	path: string;
	id: string;
	identity: SessionLifecycleTranscriptIdentity;
};

function sameTranscriptIdentity(
	actual: { dev: bigint; ino: bigint; size: number; mtimeMs: number; mtimeNs: bigint; sha256: string },
	expected: SessionLifecycleTranscriptIdentity,
): boolean {
	return (
		actual.dev.toString() === expected.dev &&
		actual.ino.toString() === expected.ino &&
		actual.size === expected.size &&
		actual.mtimeMs === expected.mtimeMs &&
		actual.mtimeNs.toString() === expected.mtimeNs &&
		actual.sha256 === expected.sha256
	);
}

function lifecycleTranscriptSource(request: SessionLifecycleLaunchRequest, cwd: string): LifecycleTranscriptSource {
	if (request.operation === "session.resume") {
		return {
			cwd,
			path: request.sessionPath!,
			id: request.sessionId,
			identity: request.sessionIdentity!,
		};
	}
	if (request.operation === "session.fork") {
		return {
			cwd: path.resolve(request.sourceCwd ?? cwd),
			path: request.sourceSessionPath!,
			id: request.sourceSessionId!,
			identity: request.sourceSessionIdentity!,
		};
	}
	throw new Error("A new lifecycle session has no persisted transcript authority.");
}

async function captureLifecycleTranscript(
	request: SessionLifecycleLaunchRequest,
	cwd: string,
	agentDir: string,
	migrationPolicy: "copy-retain" | "disabled",
): Promise<CapturedSessionTranscriptSnapshot> {
	const source = lifecycleTranscriptSource(request, cwd);
	const scope = await resolveManagedSessionScope({ cwd: source.cwd, agentDir });
	if (scope.kind !== "resolved")
		throw new Error("Lifecycle saved session storage could not be verified for the requested workspace.");
	const inventory = await listManagedSessionCandidates({ scope: scope.scope });
	if (inventory.kind !== "complete")
		throw new Error("Lifecycle saved session storage could not be verified for the requested workspace.");
	const captured = SessionManager.captureTranscriptStrict(source.path);
	if (
		captured.kind !== "captured" ||
		captured.snapshot.sourcePath !== path.resolve(source.path) ||
		captured.snapshot.identity.sessionId !== source.id ||
		!sameTranscriptIdentity(captured.snapshot.identity, source.identity)
	)
		throw new Error("Lifecycle saved session authority changed before the session host consumed it.");
	const matches = inventory.owned.filter(
		candidate =>
			candidate.path === captured.snapshot.sourcePath &&
			candidate.sessionId === source.id &&
			sameLifecycleTranscriptSnapshot(candidate.identity, captured.snapshot.identity),
	);
	if (matches.length !== 1)
		throw new Error("Lifecycle saved session authority changed before the session host started.");
	if (matches[0]!.provenance === "legacy" && migrationPolicy === "disabled")
		throw new Error("Lifecycle legacy session migration is disabled by policy.");
	return captured.snapshot;
}

function sameLifecycleTranscriptSnapshot(left: ResumeSessionIdentity, right: ResumeSessionIdentity): boolean {
	return (
		left.canonicalPath === right.canonicalPath &&
		left.sessionId === right.sessionId &&
		left.dev === right.dev &&
		left.ino === right.ino &&
		left.size === right.size &&
		left.mtimeMs === right.mtimeMs &&
		left.mtimeNs === right.mtimeNs &&
		left.sha256 === right.sha256
	);
}

async function revalidateLifecycleTranscript(snapshot: ResumeSessionIdentity): Promise<void> {
	const inspected = await SessionManager.inspectSessionTailReadOnly(snapshot.canonicalPath);
	if (inspected.kind === "error" || !sameLifecycleTranscriptSnapshot(snapshot, inspected.identity))
		throw new Error("Lifecycle saved session authority changed while the session host opened it.");
}

/** Opens lifecycle-authorized history without letting replacement content reach readiness. */
export async function openLifecycleSessionManager(
	request: SessionLifecycleLaunchRequest,
	cwd: string,
	agentDir: string,
): Promise<{ parsed: ParsedArgs; sessionManager: SessionManager | undefined }> {
	const parsed = await lifecycleArgs(request, cwd, agentDir);
	const lifecycleSettings = await Settings.loadForScope({ cwd, agentDir });
	let sessionManager: SessionManager | undefined;
	let result: { parsed: ParsedArgs; sessionManager: SessionManager | undefined } | undefined;
	let operationError: unknown;
	try {
		const migrationPolicy =
			lifecycleSettings.get("session.directoryMigration") === "disabled" ? "disabled" : "copy-retain";
		if (request.operation === "session.create") {
			sessionManager = await createSessionManager(parsed, cwd, lifecycleSettings);
		} else {
			const snapshot = await captureLifecycleTranscript(request, cwd, agentDir, migrationPolicy);
			if (request.operation === "session.resume") {
				const opened = await SessionManager.openExistingStrict(
					snapshot.identity,
					SessionManager.managedDestination(cwd, agentDir),
					undefined,
					migrationPolicy,
					lifecycleSettings.get("sessionMemory.mode"),
				);
				if (opened.kind === "error")
					throw new Error("Lifecycle saved session authority changed while the session host opened it.");
				sessionManager = opened.manager;
				try {
					await revalidateLifecycleTranscript(snapshot.identity);
				} catch (error) {
					await sessionManager.close();
					throw error;
				}
			} else {
				const forked = await SessionManager.forkFromCaptured(
					snapshot,
					cwd,
					SessionManager.managedDestination(cwd, agentDir),
					migrationPolicy,
					lifecycleSettings.get("sessionMemory.mode"),
				);
				if (forked.kind === "error")
					throw new Error("Lifecycle saved session authority changed while the session host forked it.");
				sessionManager = forked.manager;
			}
		}
		result = { parsed, sessionManager };
	} catch (error) {
		operationError = error;
	}
	let cleanupError: unknown;
	try {
		await lifecycleSettings.close();
	} catch (error) {
		cleanupError = error;
		await sessionManager?.close().catch(() => undefined);
	}
	if (cleanupError !== undefined) throw cleanupError;
	if (operationError !== undefined) throw operationError;
	if (!result) throw new Error("Lifecycle session manager result was not produced.");
	return result;
}

/**
 * Starts the memory backend a lifecycle session deferred past its readiness
 * window.
 *
 * Deliberately not awaited: the local backend summarises every queued rollout
 * through the model, so its duration scales with the backlog and would eat the
 * broker's readiness budget. The session is already published as ready here, so
 * a failure is a degraded-memory condition, not a startup failure — it is
 * logged and swallowed instead of surfacing as an unhandled rejection.
 */
export function startMemoryBackendAfterReadiness(start: () => Promise<void>): void {
	void start().catch(error => {
		logger.warn("Deferred memory backend startup failed after readiness", { error: String(error) });
	});
}

/** Runs the same persisted AgentSession bootstrap used by the production CLI. */
export async function runSessionHost(
	timing: {
		now?: () => number;
		sleep?: (ms: number) => Promise<void>;
		cwd?: string;
		processIncarnation?: (pid: number) => string | undefined;
		applyStartupModelProfiles?: typeof applyStartupModelProfiles;
		initTheme?: typeof initTheme;
		createLifecycleAgentSession?: typeof createLifecycleAgentSession;
		writeSessionLifecycleReady?: typeof writeSessionLifecycleReady;
		writeMcpConfig?: (filePath: string, contents: string) => Promise<number>;
	} = {},
): Promise<void> {
	const now = timing.now ?? Date.now;
	const sleep = timing.sleep ?? (async ms => await Bun.sleep(ms));
	const readIncarnation = timing.processIncarnation ?? processIncarnation;
	const applyModelProfiles = timing.applyStartupModelProfiles ?? applyStartupModelProfiles;
	const initializeTheme = timing.initTheme ?? initTheme;
	const createLifecycleSession = timing.createLifecycleAgentSession ?? createLifecycleAgentSession;
	const writeLifecycleReady = timing.writeSessionLifecycleReady ?? writeSessionLifecycleReady;
	const writeMcpConfig = timing.writeMcpConfig ?? ((filePath, contents) => Bun.write(filePath, contents));
	const request = readSessionLifecycleLaunchRequest(process.env.GJC_SDK_LIFECYCLE_REQUEST, now());
	const agentDir = process.env.GJC_AGENT_DIR;
	if (!agentDir) throw new Error("GJC_AGENT_DIR is required for sdk session-host-internal.");
	const cwd = timing.cwd ?? process.cwd();
	if ((await fs.realpath(request.cwd)) !== (await fs.realpath(cwd)))
		throw new Error(`Lifecycle worktree mismatch: expected ${request.cwd}, got ${cwd}.`);
	if (
		process.env.GJC_STATE_ROOT !== undefined &&
		path.resolve(process.env.GJC_STATE_ROOT) !== path.resolve(request.stateRoot)
	)
		throw new Error("Lifecycle state root does not match the broker-issued request.");
	if (request.effectMarker && process.env.GJC_LIFECYCLE_REQUEST_ID !== request.effectMarker)
		throw new Error("Lifecycle effect marker does not match the broker-issued request.");
	if (!request.effectMarker) throw new Error("Lifecycle effect marker is required.");
	const effectMarker = request.effectMarker;
	const markerPath = path.join(request.stateRoot, "sdk", `${request.sessionId}.lifecycle.json`);
	let marker: { pid?: unknown; effectMarker?: unknown; incarnation?: unknown } | undefined;
	do {
		try {
			const candidate = JSON.parse(await fs.readFile(markerPath, "utf8")) as {
				pid?: unknown;
				effectMarker?: unknown;
				incarnation?: unknown;
			};
			const incarnation = readIncarnation(process.pid);
			if (
				request.effectMarker &&
				Number.isSafeInteger(candidate.pid) &&
				candidate.pid === process.pid &&
				typeof candidate.effectMarker === "string" &&
				candidate.effectMarker === request.effectMarker &&
				typeof candidate.incarnation === "string" &&
				incarnation &&
				candidate.incarnation === incarnation
			)
				marker = candidate;
		} catch {
			// Marker publication may be observed between write and rename; retry until cutoff.
		}
		if (!marker && now() < request.semanticReadyDeadlineAt)
			await sleep(Math.min(10, Math.max(0, request.semanticReadyDeadlineAt - now())));
	} while (!marker && now() < request.semanticReadyDeadlineAt);
	if (!marker) throw new Error("Lifecycle owner-bound marker authority was not published before readiness cutoff.");
	const incarnation = readIncarnation(process.pid);
	if (!incarnation) throw new Error("Lifecycle owner-bound marker authority is invalid.");

	const writeFailure = async (
		failure: SdkStartupFailure,
		rollback: SdkStartupRollbackResult,
		transcript?: LifecycleTranscriptEvidence,
	): Promise<void> => {
		if (!request.effectMarker) return;
		await writeSessionLifecycleFailure(
			request.stateRoot,
			request.sessionId,
			effectMarker,
			failure,
			rollback,
			transcript,
			incarnation,
		);
	};

	if (now() >= request.semanticReadyDeadlineAt) {
		const absent = new SdkStartupRollbackTracker();
		absent.recordAbsent();
		await writeFailure(
			{
				phase: "startup",
				reason: "pending",
				message: "SDK startup did not complete before readiness cutoff.",
			},
			absent.result,
		);

		throw new Error("SDK startup did not complete before readiness cutoff.");
	}

	const rollback = new SdkStartupRollbackTracker();
	const capability = new SdkStartupCapability(rollback, request.readiness ?? "immediate", effectMarker);
	const startupOwner: SdkLifecycleStartupOwner = { capability, rollback };
	let startupComplete = false;
	let readinessPublicationCleanupComplete = true;
	let revokePendingReadinessMarker: (() => Promise<boolean>) | undefined;
	let readinessRevocation: Promise<boolean> | undefined;
	let startupInterruption: SdkStartupFailure | undefined;
	const interrupted = Promise.withResolvers<SdkStartupFailure>();
	const startReadinessRevocation = (revoke: () => Promise<boolean>): void => {
		readinessPublicationCleanupComplete = false;
		readinessRevocation ??= Promise.resolve()
			.then(revoke)
			.then(
				revoked => {
					readinessPublicationCleanupComplete = revoked;
					if (revoked) revokePendingReadinessMarker = undefined;
					return revoked;
				},
				() => {
					readinessPublicationCleanupComplete = false;
					return false;
				},
			);
	};
	const interruptStartup = (failure: SdkStartupFailure): void => {
		if (startupInterruption !== undefined) return;
		startupInterruption = failure;
		capability.cancel(failure);
		if (revokePendingReadinessMarker) startReadinessRevocation(revokePendingReadinessMarker);
		interrupted.resolve(failure);
	};
	const cutoffFailure = (): SdkStartupFailure => capability.normalizeFailure("startup", "pending");
	const onStartupSignal = (): void => {
		interruptStartup(capability.normalizeFailure("startup", "failed", "SDK lifecycle host terminated."));
	};
	const removeStartupSignalHandlers = (): void => {
		process.removeListener("SIGTERM", onStartupSignal);
		process.removeListener("SIGINT", onStartupSignal);
	};
	process.once("SIGTERM", onStartupSignal);
	process.once("SIGINT", onStartupSignal);
	void sleep(Math.max(0, request.semanticReadyDeadlineAt - now())).then(
		() => {
			if (!startupComplete) interruptStartup(cutoffFailure());
		},
		error => {
			if (!startupComplete) interruptStartup(capability.normalizeFailure("startup", "failed", error));
		},
	);
	const interruptedStageCleanupGraceMs = 100;
	const throwIfStartupInterrupted = (): void => {
		if (startupInterruption !== undefined) throw startupInterruption;
		if (now() >= request.semanticReadyDeadlineAt) {
			interruptStartup(cutoffFailure());
			throw startupInterruption;
		}
	};
	const beforeCutoff = async <T>(
		stage: () => Promise<T>,
		cleanupLateResult?: (value: T) => Promise<void>,
		options: { processLocalOnly?: boolean } = {},
	): Promise<T> => {
		throwIfStartupInterrupted();
		const pending = Promise.resolve()
			.then(stage)
			.then(
				value => ({ value }) as const,
				error => ({ error }) as const,
			);
		const result = await Promise.race([
			pending.then(settlement => ({ settlement }) as const),
			interrupted.promise.then(failure => ({ failure }) as const),
		]);
		const cleanupLateStage = async (lateStage: typeof pending): Promise<void> => {
			if (options.processLocalOnly) return;
			if (!cleanupLateResult) {
				constructionCleanupComplete = false;
				return;
			}
			const cleanup = lateStage
				.then(async late => {
					if ("error" in late) {
						constructionCleanupComplete = false;
						return;
					}
					try {
						await cleanupLateResult(late.value);
					} catch {
						constructionCleanupComplete = false;
						logger.warn(
							"Late lifecycle stage cleanup failed after startup interruption; rollback remains incomplete.",
						);
					}
				})
				.catch(() => {
					constructionCleanupComplete = false;
				});
			const cleanupCompleted = await Promise.race([
				cleanup.then(() => true),
				Bun.sleep(interruptedStageCleanupGraceMs).then(() => false),
			]);
			if (!cleanupCompleted) constructionCleanupComplete = false;
		};
		if ("failure" in result) {
			await cleanupLateStage(pending);
			throw result.failure;
		}
		const settlement = result.settlement;
		if (startupInterruption !== undefined || now() >= request.semanticReadyDeadlineAt) {
			const failure = startupInterruption ?? cutoffFailure();
			interruptStartup(failure);
			await cleanupLateStage(Promise.resolve(settlement));
			throw failure;
		}
		if ("error" in settlement) throw settlement.error;
		return settlement.value;
	};
	let constructionCleanupComplete = true;
	const runBoundedStartupCleanup = async (cleanup: () => Promise<void>): Promise<boolean> => {
		const completed = await Promise.race([
			Promise.resolve()
				.then(cleanup)
				.then(
					() => true,
					() => false,
				),
			Bun.sleep(interruptedStageCleanupGraceMs).then(() => false),
		]);
		if (!completed) constructionCleanupComplete = false;
		return completed;
	};
	const constructionFailure = (error: unknown): SdkStartupFailure => {
		if (error && typeof error === "object" && "phase" in error && "reason" in error && "message" in error)
			return error as SdkStartupFailure;
		return capability.normalizeFailure("registration", "failed", error);
	};

	let opened: { parsed: ParsedArgs; sessionManager: SessionManager | undefined };
	let openedSessionManager: SessionManager | undefined;
	let sessionManagerTransferred = false;
	let created: CreateLifecycleAgentSessionResult;
	let mcpConfigDirectory: string | undefined;
	try {
		let mcpConfigPath: string | undefined;
		opened = await beforeCutoff(
			() => openLifecycleSessionManager(request, cwd, agentDir),
			async late => {
				try {
					await late.sessionManager?.close();
				} catch (error) {
					constructionCleanupComplete = false;
					throw error;
				}
			},
		);
		openedSessionManager = opened.sessionManager;
		throwIfStartupInterrupted();
		if (request.mcpServers && request.mcpServers.length > 0) {
			const temporaryDirectory = await beforeCutoff(
				() => fs.mkdtemp(path.join(os.tmpdir(), "gjc-acp-mcp-")),
				async late => {
					if (!(await runBoundedStartupCleanup(() => fs.rm(late, { recursive: true, force: true }))))
						throw new Error("Late MCP configuration directory cleanup did not complete.");
				},
			);
			mcpConfigDirectory = temporaryDirectory;
			const canonicalDirectory = await beforeCutoff(
				() => fs.realpath(temporaryDirectory),
				async late => {
					if (!(await runBoundedStartupCleanup(() => fs.rm(late, { recursive: true, force: true }))))
						throw new Error("Late MCP configuration path cleanup did not complete.");
				},
			);
			mcpConfigDirectory = canonicalDirectory;
			const configPath = path.join(canonicalDirectory, "mcp.json");
			mcpConfigPath = configPath;
			const configContents = JSON.stringify({
				mcpServers: Object.fromEntries(
					request.mcpServers.map(server => [
						server.name,
						"url" in server
							? {
									type: server.type,
									url: server.url,
									...(server.headers ? { headers: server.headers } : {}),
									timeout: ACP_MCP_REQUEST_TIMEOUT_MS,
								}
							: {
									type: server.type,
									command: server.command,
									args: server.args,
									...(server.env ? { env: server.env } : {}),
									noInheritEnv: true,
									timeout: ACP_MCP_REQUEST_TIMEOUT_MS,
								},
					]),
				),
			});
			await beforeCutoff(
				() => writeMcpConfig(configPath, configContents),
				async () => {
					if (!(await runBoundedStartupCleanup(() => fs.rm(canonicalDirectory, { recursive: true, force: true }))))
						throw new Error("Late MCP configuration write cleanup did not complete.");
				},
			);
			throwIfStartupInterrupted();
		}

		await beforeCutoff(() => initializeTheme(false), undefined, { processLocalOnly: true });

		// The longer MCP startup ceiling is scoped to ACP lifecycle launches only:
		// it applies when this request actually carried `mcpServers`. Ordinary
		// CLI/SDK `mcpConfigPath` consumers keep the manager's short default.
		//
		// Session-manager open, MCP config write, and theme initialization already
		// consumed part of the budget. Refuse session construction when the remaining
		// time cannot preserve the MCP startup headroom.
		let mcpStartupTimeoutMs: number | undefined;
		if (mcpConfigPath !== undefined) {
			const remaining = request.semanticReadyDeadlineAt - now() - ACP_MCP_STARTUP_HEADROOM_MS;
			if (remaining <= 0) {
				const failure = cutoffFailure();
				interruptStartup(failure);
				throw failure;
			}
			mcpStartupTimeoutMs = remaining;
		}

		created = await beforeCutoff(
			async () => {
				sessionManagerTransferred = true;
				const result = await createLifecycleSession(
					{
						cwd,
						agentDir,
						sessionManager: opened.sessionManager,
						...(mcpConfigPath ? { mcpConfigPath } : {}),
						...(mcpStartupTimeoutMs !== undefined ? { mcpStartupTimeoutMs } : {}),
						...(request.readiness ? { readiness: request.readiness } : {}),
						...(request.modelId ? { modelId: request.modelId } : {}),
						lifecycleRequestId: effectMarker,
					},
					startupOwner,
				);
				if (mcpConfigDirectory) {
					await fs.rm(mcpConfigDirectory, { recursive: true, force: true });
					mcpConfigDirectory = undefined;
				}
				return result;
			},
			async late => {
				if ("failure" in late) return;
				try {
					await late.session.dispose();
				} catch (error) {
					if (!isSessionDisposalIncompleteError(error)) {
						constructionCleanupComplete = false;
						throw error;
					}
					await late.session.awaitDisposeCompletion();
				}
			},
		);
	} catch (error) {
		removeStartupSignalHandlers();
		if (!sessionManagerTransferred && openedSessionManager) {
			const manager = openedSessionManager;
			await runBoundedStartupCleanup(() => manager.close());
		}
		if (mcpConfigDirectory) {
			const directory = mcpConfigDirectory;
			mcpConfigDirectory = undefined;
			await runBoundedStartupCleanup(() => fs.rm(directory, { recursive: true, force: true }));
		}
		const failure = constructionFailure(error);
		const settled = capability.settleFailure(failure);
		const durableFailure = settled.status === "failed" ? settled.failure : failure;
		if (rollback.generation === undefined && constructionCleanupComplete) rollback.recordAbsent();
		await writeFailure(durableFailure, rollback.result);
		throw error;
	}
	if ("failure" in created) {
		removeStartupSignalHandlers();
		created.rollback.recordAbsent();
		capability.settleFailure(created.failure);
		await writeFailure(created.failure, created.rollback.result);
		throw created.failure;
	}
	if (created.capability !== capability || created.rollback !== rollback) {
		removeStartupSignalHandlers();
		try {
			await created.session.dispose();
		} catch (error) {
			if (!isSessionDisposalIncompleteError(error)) throw error;
			await created.session.awaitDisposeCompletion();
		}
		const failure = capability.normalizeFailure(
			"registration",
			"failed",
			"Lifecycle startup owner changed during construction.",
		);
		if (rollback.generation === undefined) rollback.recordAbsent();
		await writeFailure(failure, rollback.result);
		throw failure;
	}
	const { parsed } = opened;
	const { session, startDeferredMemoryBackend } = created;
	let lifecycleTranscriptPath: string | undefined;
	session.registerToolSessionTransitionCleanup(async () => {
		await session.sessionManager.ensureOnDisk();
		lifecycleTranscriptPath = session.sessionManager.getSessionFile();
	});
	let sessionDisposal: Promise<void> | undefined;
	const disposeSession = (reason?: "detached_idle"): Promise<void> => {
		sessionDisposal ??= (async () => {
			try {
				await session.dispose(reason === undefined ? {} : { sessionShutdownReason: reason });
			} catch (error) {
				if (!isSessionDisposalIncompleteError(error)) throw error;
				await session.awaitDisposeCompletion();
			}
		})();
		return sessionDisposal;
	};
	let disposal: Promise<LifecycleTranscriptEvidence | undefined> | undefined;
	const disposeAndCapture = (): Promise<LifecycleTranscriptEvidence | undefined> => {
		disposal ??= (async () => {
			await disposeSession();
			if (!lifecycleTranscriptPath) return undefined;
			try {
				const [bytes, stat] = await Promise.all([
					fs.readFile(lifecycleTranscriptPath),
					fs.stat(lifecycleTranscriptPath, { bigint: true }),
				]);
				const digest = createHash("sha256").update(bytes).digest("hex");
				return {
					digest,
					identity: {
						dev: stat.dev.toString(),
						ino: stat.ino.toString(),
						size: Number(stat.size),
						mtimeMs: Number(stat.mtimeMs),
						mtimeNs: stat.mtimeNs.toString(),
						sha256: digest,
					},
				};
			} catch {
				return undefined;
			}
		})();
		return disposal ?? Promise.resolve(undefined);
	};
	let failureRollback: Promise<void> | undefined;
	const failAfterRollback = (failure: SdkStartupFailure): Promise<void> => {
		failureRollback ??= (async () => {
			if (readinessRevocation) {
				const revoked = await Promise.race([
					readinessRevocation,
					Bun.sleep(interruptedStageCleanupGraceMs).then(() => false),
				]);
				if (!revoked) readinessPublicationCleanupComplete = false;
			}
			const transcript = await disposeAndCapture();
			if (rollback.generation === undefined && readinessPublicationCleanupComplete) rollback.recordAbsent();
			await writeFailure(failure, rollback.result, transcript);
		})();
		return failureRollback;
	};
	const sessionEndpointPath = path.join(request.stateRoot, "sdk", `${request.sessionId}.json`);
	const exitAfterSessionDisposal = async (reason?: "detached_idle"): Promise<void> => {
		await disposeSession(reason);
		let failure: SdkStartupFailure | undefined;
		try {
			const endpoint = JSON.parse(await fs.readFile(sessionEndpointPath, "utf8")) as {
				pid?: unknown;
				sessionId?: unknown;
			};
			if (endpoint.pid === process.pid && endpoint.sessionId === request.sessionId)
				failure = {
					phase: "startup",
					reason: "failed",
					message: `SDK host endpoint remained after graceful shutdown: ${request.sessionId}`,
				};
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
				failure = {
					phase: "startup",
					reason: "failed",
					message: `SDK host endpoint cleanup could not be verified: ${request.sessionId}`,
				};
			}
		}
		if (failure) {
			process.exitCode = 1;
			process.stderr.write(`${failure.message}\n`);
			await writeFailure(failure, rollback.result).catch(() => {});
		}
		process.exit(process.exitCode ?? 0);
	};
	let stopping = false;
	const stop = (reason?: "detached_idle") => {
		if (startupComplete) {
			if (stopping) return;
			stopping = true;
			void exitAfterSessionDisposal(reason);
			return;
		}
		const failure = capability.normalizeFailure("startup", "failed", "SDK lifecycle host terminated.");
		interruptStartup(failure);
	};
	const onReadySignal = (): void => stop();

	try {
		const startupThinkingLevel = request.modelId ? parseModelString(request.modelId)?.thinkingLevel : undefined;
		await beforeCutoff(() =>
			process.env.GJC_SDK_TEST_HANG_MODEL_PROFILE === cwd
				? new Promise<void>(() => {})
				: applyModelProfiles({
						session,
						settings: session.settings,
						modelRegistry: session.modelRegistry,
						parsedArgs: parsed,
						startupThinkingLevel,
						preferCachedModels: true,
						preferCachedDefaultProfile: true,
					}),
		);
		await beforeCutoff(() =>
			initializeExtensions(session, {
				reportSendError: () => {},
				reportRuntimeError: () => {},
				onShutdown: stop,
			}),
		);
		throwIfStartupInterrupted();
		if (session.sessionManager.getSessionId() !== request.sessionId)
			throw new Error(
				`Lifecycle session id mismatch: expected ${request.sessionId}, got ${session.sessionManager.getSessionId()}.`,
			);
		const startup = await beforeCutoff<SdkStartupResult>(() => capability.promise);
		if (startup.status !== "started") throw startup.failure;
		throwIfStartupInterrupted();
		if (process.env.GJC_SDK_TEST_FAIL_AFTER_REGISTRATION === cwd)
			throw new Error("Lifecycle test failure after SDK host registration.");

		await beforeCutoff(() => session.sessionManager.ensureOnDisk());
		throwIfStartupInterrupted();
		let readinessPublished = false;
		readinessPublicationCleanupComplete = false;
		const readinessOutcome = await beforeCutoff(
			async () => {
				try {
					await writeLifecycleReady(
						request.stateRoot,
						request.sessionId,
						effectMarker,
						() => startupInterruption === undefined && now() < request.semanticReadyDeadlineAt,
						revoke => {
							revokePendingReadinessMarker = revoke;
							if (startupInterruption !== undefined) startReadinessRevocation(revoke);
							else if (now() >= request.semanticReadyDeadlineAt) {
								interruptStartup(cutoffFailure());
							}
						},
						() => {
							readinessPublished = true;
						},
					);
					return { published: true } as const;
				} catch (error) {
					return { published: false, error } as const;
				}
			},
			async outcome => {
				readinessPublicationCleanupComplete =
					!outcome.published && !(outcome.error instanceof LifecycleReadinessCleanupError);
			},
		);
		if (!readinessOutcome.published) {
			readinessPublicationCleanupComplete = !(readinessOutcome.error instanceof LifecycleReadinessCleanupError);
			throw readinessOutcome.error;
		}
		if (!readinessPublished) {
			readinessPublicationCleanupComplete = false;
			throw new Error("Lifecycle readiness publication completed without its commit callback.");
		}
		readinessPublicationCleanupComplete = true;
		startupComplete = true;
		revokePendingReadinessMarker = undefined;
		readinessRevocation = undefined;
		removeStartupSignalHandlers();
		process.once("SIGTERM", onReadySignal);
		process.once("SIGINT", onReadySignal);
	} catch (error) {
		removeStartupSignalHandlers();
		const failure =
			error && typeof error === "object" && "phase" in error && "reason" in error && "message" in error
				? (error as SdkStartupFailure)
				: capability.normalizeFailure("startup", "failed", error);
		const settled = capability.settleFailure(failure);
		const durableFailure = settled.status === "failed" ? settled.failure : failure;
		await failAfterRollback(durableFailure);
		throw error;
	}
	// Readiness is published; the session is live. Memory startup issues one LLM
	// request per queued rollout, so it must run outside the readiness window and
	// its failure must never take the session down.
	if (process.env.GJC_SDK_TEST_EXIT_AFTER_READY === cwd) {
		process.stderr.write("GJC_SDK_TEST_EXIT_AFTER_READY\n");
		process.exit(7);
	}
	if (process.env.GJC_SDK_TEST_REJECT_AFTER_READY === cwd) {
		// Simulates the post-readiness liveness watcher rejecting. With the
		// post-ready startup receipt removed, this unhandled rejection kills the
		// host without writing any startup receipt; the broker must classify the
		// death from published ready authority plus proven exit.
		void Promise.reject(new Error("GJC_SDK_TEST_REJECT_AFTER_READY"));
		await Bun.sleep(5_000);
	}
	startMemoryBackendAfterReadiness(startDeferredMemoryBackend);
	// Two independent bounds, either of which reaps this detached host through
	// the same graceful teardown a SIGTERM would take. The first covers a broker
	// that is gone for good; the second covers the opposite case, a perfectly
	// healthy broker whose host nobody is attached to any more and for which no
	// `session.close` will ever arrive.
	const reapReason = await Promise.race([
		watchSessionHostBrokerLiveness({ agentDir }).then(() => undefined),
		watchSessionHostClientAttachment({
			readAttachedClients: sessionHostAttachedClients,
			readWorkLease: sessionHostWorkLeaseActive,
		}),
	]);
	stop(reapReason);
	await new Promise<void>(() => {});
}

export type SdkInternalArgv =
	| { action: "broker-internal"; agentDir: string }
	| { action: "session-host-internal" }
	| { action: "stderr-drain-internal"; logPath: string; maxBytes: number };

/** Parses the exact private argv contracts used by SDK child-process spawns. */
export function parseSdkInternalArgv(argv: readonly string[]): SdkInternalArgv {
	if (argv[0] === "session-host-internal" && argv.length === 1) return { action: "session-host-internal" };
	if (
		argv[0] === "broker-internal" &&
		argv.length === 3 &&
		argv[1] === "--agent-dir" &&
		typeof argv[2] === "string" &&
		isSafeSdkInternalAgentDir(argv[2])
	)
		return { action: "broker-internal", agentDir: argv[2] };
	if (
		argv[0] === "stderr-drain-internal" &&
		argv.length === 5 &&
		argv[1] === "--path" &&
		argv[2] &&
		path.isAbsolute(argv[2]) &&
		argv[3] === "--max-bytes"
	) {
		const maxBytes = parsePositiveTimeout(argv[4], "--max-bytes");
		if (maxBytes !== undefined && maxBytes <= 64 * 1024) {
			return { action: "stderr-drain-internal", logPath: argv[2], maxBytes };
		}
	}
	throw new CliParseError("Invalid internal SDK invocation.");
}

function parsePositiveTimeout(raw: string | undefined, flagName: string): number | undefined {
	if (raw === undefined) return undefined;
	if (!/^[0-9]+$/.test(raw)) {
		throw new CliParseError(`Expected ${flagName} to be a positive safe integer, got "${raw}"`);
	}
	const value = Number(raw);
	if (!Number.isSafeInteger(value) || value <= 0) {
		throw new CliParseError(`Expected ${flagName} to be a positive safe integer, got "${raw}"`);
	}
	return value;
}

class SdkServeHelp extends Command {
	static description = "gjc sdk serve --stdio | --socket <path> [--session <id>] [--pending-ceiling <bytes>]";
	static flags = {
		stdio: Flags.boolean({ description: "Serve SDK frames over standard input and output" }),
		socket: Flags.string({ description: "Serve SDK frames over a Unix socket path" }),
		session: Flags.string({ description: "Attach to a specific SDK session" }),
		"pending-ceiling": Flags.string({ description: "Maximum queued relay bytes per direction" }),
	};
	async run(): Promise<void> {}
}

class SdkSessionHelp extends Command {
	static description =
		"Manage SDK sessions: `gjc sdk session list|inspect|send|status|tail|close|retire`, or the explicit raw hatch `gjc sdk session raw control|query|global`. The session CLI is broker-bound and credential-free.";
	static args = {
		verb: Args.string({
			description: "Session verb",
			required: false,
			options: ["list", "inspect", "send", "status", "tail", "close", "retire", "raw"],
		}),
		target: Args.string({
			description: "Session id (or the raw kind control|query|global for `raw`)",
			required: false,
		}),
		opRef: Args.string({
			description: "Operation reference for status, or session id for raw control/query",
			required: false,
		}),
	};
	static flags = {
		"agent-dir": Flags.string({ description: "SDK broker state directory" }),
		repo: Flags.string({
			description: "Workspace directory for saved-session resolution (default: current directory)",
		}),
		op: Flags.string({ description: "Raw control or global operation" }),

		query: Flags.string({ description: "Raw query name" }),
		"json-input": Flags.string({ description: "SDK request JSON object" }),
		"json-input-file": Flags.string({ description: "Read SDK request JSON from a 0600 file" }),
		"json-input-stdin": Flags.boolean({ description: "Read SDK request JSON from standard input" }),
		"idempotency-key": Flags.string({
			description: "Caller idempotency key required for lifecycle globals and terminal abort controls",
		}),
		confirm: Flags.boolean({ description: "Confirm a destructive local CLI control operation" }),
		cursor: Flags.string({
			description:
				"Raw query continuation/search cursor, or session tail checkpoint claim (tail also requires --after-transcript-id)",
		}),
		scope: Flags.string({
			description:
				"session list scope: repo (default), cwd, worktree, or all; search scope: repo (default), pwd, or global",
		}),
		limit: Flags.integer({ description: "Search or raw session.list page size from 1 to 100" }),
		json: Flags.boolean({ description: "Render search as the SdkSearchResultV1 JSON envelope" }),
		text: Flags.string({ description: "Prompt text for send (alternative to --json-input)" }),
		"op-ref": Flags.string({ description: "Operation reference for send (defaults to a generated ULID)" }),
		wait: Flags.boolean({
			description: "send --wait: poll turn.result with kind=prompt until terminal or the wait window elapses",
		}),
		"timeout-ms": Flags.string({ description: "Wait window for send --wait, status, and live tail follow" }),
		strict: Flags.boolean({ description: "tail --strict: fail closed on retention gaps" }),
		"until-idle": Flags.boolean({ description: "tail --until-idle: exit after an observed terminal turn state" }),
		"all-events": Flags.boolean({ description: "tail --all-events: include every event-ring kind" }),
		"after-transcript-id": Flags.string({
			description:
				"tail --cursor (required): omit transcript rows up to and including this row id (the caller already has them)",
		}),
		page: Flags.boolean({ description: "raw global session.list: return exactly one broker page" }),
	};
	async run(): Promise<void> {}
}

class SdkSpawnCommand extends Command {
	static description = "Spawn a task-seeded background child session (local interactive master only).";
	static flags = {
		cwd: Flags.string({ description: "Working directory for the spawned child" }),
		prompt: Flags.string({ description: "Seed task delivered once to the child" }),
		model: Flags.string({ description: "Model selector for the child" }),
		profile: Flags.string({ description: "Model profile name for the child" }),
		"agent-dir": Flags.string({ description: "SDK broker state directory" }),
		"idempotency-key": Flags.string({
			description: "Idempotency key for replaying an uncertain session.spawn result",
		}),
		json: Flags.boolean({ description: "Render the safe spawn result as JSON" }),
	};
	async run(): Promise<void> {
		const { flags } = await this.parse(SdkSpawnCommand);
		try {
			const spawn = await runSdkSpawn({
				cwd: flags.cwd,
				prompt: flags.prompt,
				model: flags.model,
				profile: flags.profile,
				agentDir: flags["agent-dir"],
				idempotencyKey: flags["idempotency-key"],
			});
			process.stdout.write(`${flags.json ? JSON.stringify(spawn.rendered) : renderSpawnTable(spawn.rendered)}\n`);
			if (spawn.exitCode !== 0) process.exitCode = spawn.exitCode;
		} catch (error) {
			if (error instanceof SdkMasterCliError) {
				process.stderr.write(`Error: ${error.code}: ${error.message}\n`);
				process.exitCode = error.exitCode;
				return;
			}
			throw error;
		}
	}
}

class SdkSearchCommand extends Command {
	static description = "Search broker-visible SDK sessions within an exact repo, pwd, or global scope.";
	static flags = {
		"agent-dir": Flags.string({ description: "SDK broker state directory" }),
		repo: Flags.string({ description: "Workspace directory for scope resolution (default: current directory)" }),
		scope: Flags.string({ description: "Search scope: repo, pwd, or global (default: repo)" }),
		limit: Flags.integer({ description: "Search page size from 1 to 100" }),
		cursor: Flags.string({ description: "Frozen scoped search continuation cursor" }),
		json: Flags.boolean({ description: "Render exactly the SdkSearchResultV1 JSON envelope" }),
	};
	async run(): Promise<void> {
		const { flags } = await this.parse(SdkSearchCommand);
		const scope = flags.scope;
		if (scope !== undefined && scope !== "repo" && scope !== "pwd" && scope !== "global")
			throw new CliParseError("--scope must be repo, pwd, or global.");
		const search = await runSdkSearch({
			agentDir: flags["agent-dir"],
			repo: flags.repo,
			scope,
			limit: flags.limit,
			cursor: flags.cursor,
		});
		process.stdout.write(`${flags.json ? JSON.stringify(search.result) : renderSdkSearchTable(search.result)}\n`);
		if (search.exitCode !== 0) process.exitCode = search.exitCode;
	}
}

class SdkSessionCommand extends Command {
	static description = SdkSessionHelp.description;
	static args = SdkSessionHelp.args;
	static flags = SdkSessionHelp.flags;
	async run(): Promise<void> {
		const { args, flags } = await this.parse(SdkSessionCommand);
		const verb = args.verb;
		const target = args.target;
		const flagRec = flags as Record<string, unknown>;
		await runSdkSessionCli({
			action: verb,
			...(verb === "raw"
				? {
						rawAction: target,
						sessionId: target === "control" || target === "query" ? args.opRef : undefined,
					}
				: { sessionId: verb === "list" ? undefined : target }),
			opRef: verb === "status" ? args.opRef : (flagRec["op-ref"] as string | undefined),
			operation: flagRec.op as string | undefined,
			query: flagRec.query as string | undefined,
			text: flagRec.text as string | undefined,
			jsonInput: flagRec["json-input"] as string | undefined,
			jsonInputFile: flagRec["json-input-file"] as string | undefined,
			jsonInputStdin: Boolean(flagRec["json-input-stdin"]),
			confirm: Boolean(flagRec.confirm),
			idempotencyKey: flagRec["idempotency-key"] as string | undefined,
			cursor: flagRec.cursor as string | undefined,
			wait: Boolean(flagRec.wait),
			timeoutMs: parsePositiveTimeout(flagRec["timeout-ms"] as string | undefined, "--timeout-ms"),
			strict: Boolean(flagRec.strict),
			untilIdle: Boolean(flagRec["until-idle"]),
			allEvents: Boolean(flagRec["all-events"]),
			afterTranscriptId: flagRec["after-transcript-id"] as string | undefined,
			page: Boolean(flagRec.page),
			limit: flagRec.limit as number | undefined,
			agentDir: flagRec["agent-dir"] as string | undefined,
			repo: flagRec.repo as string | undefined,
			scope: flagRec.scope as string | undefined,
		});
	}
}

class SdkGuidesHelp extends Command {
	static description = "Manage verified advisory SDK guides: refresh, list, show, status, or trust.";
	static args = {
		action: Args.string({ required: false, options: ["refresh", "list", "show", "status", "trust"] }),
		guideId: Args.string({ required: false, description: "Guide id for show" }),
	};
	static flags = {
		"agent-dir": Flags.string({ description: "SDK state directory for the verified guide cache" }),
		url: Flags.string({ description: "HTTPS allowlisted manifest URL for refresh" }),
		"timeout-ms": Flags.string({ description: "Bounded refresh timeout in milliseconds" }),
	};
	async run(): Promise<void> {}
}

class SdkGuidesCommand extends Command {
	static description = SdkGuidesHelp.description;
	static args = SdkGuidesHelp.args;
	static flags = SdkGuidesHelp.flags;
	async run(): Promise<void> {
		const { args, flags } = await this.parse(SdkGuidesCommand);
		const flagRec = flags as Record<string, unknown>;
		await runSdkGuidesCli({
			action: args.action,
			guideId: args.guideId,
			url: flagRec.url as string | undefined,
			agentDir: flagRec["agent-dir"] as string | undefined,
			timeoutMs: parsePositiveTimeout(flagRec["timeout-ms"] as string | undefined, "--timeout-ms"),
		});
	}
}
export default class Sdk extends Command {
	static description = "SDK command runtime; public grammar and help are registry-owned.";
	static hidden = false;
	static delegateHelp = true;
	async run(): Promise<void> {
		if (
			this.argv[0] !== "broker-internal" &&
			this.argv[0] !== "session-host-internal" &&
			this.argv[0] !== "stderr-drain-internal"
		) {
			const scan = scanPublicCommand("sdk", this.argv);
			if (scan.kind !== "operation") throw new PublicCommandFailure({ kind: "usage", proof: "pre-effect" });
			const { args, flags } = scan;
			const operation = scan.descriptor.command[1];
			const stringFlag = (name: string): string | undefined => flags[name] as string | undefined;
			const timeoutMs = flags["timeout-ms"] === undefined ? undefined : Number(flags["timeout-ms"]);
			if (operation === "spawn") {
				const spawn = await runSdkSpawn({
					cwd: stringFlag("cwd"),
					prompt: stringFlag("prompt"),
					model: stringFlag("model"),
					profile: stringFlag("profile"),
					agentDir: stringFlag("agent-dir"),
					idempotencyKey: stringFlag("idempotency-key"),
				});
				process.stdout.write(`${flags.json ? JSON.stringify(spawn.rendered) : renderSpawnTable(spawn.rendered)}\n`);
				return;
			}
			if (operation === "search") {
				const search = await runSdkSearch({
					agentDir: stringFlag("agent-dir"),
					repo: stringFlag("repo"),
					scope: stringFlag("scope"),
					limit: flags.limit as number | undefined,
					cursor: stringFlag("cursor"),
				});
				process.stdout.write(
					`${flags.json ? JSON.stringify(search.result) : renderSdkSearchTable(search.result)}\n`,
				);
				return;
			}
			if (operation === "session") {
				await runSdkSessionCli({
					action: scan.descriptor.command[2],
					rawAction: scan.descriptor.command[3],
					sessionId: args.sessionId as string | undefined,
					opRef: (args.opRef as string | undefined) ?? stringFlag("op-ref"),
					operation: stringFlag("op"),
					query: stringFlag("query"),
					text: stringFlag("text"),
					jsonInput: stringFlag("json-input"),
					jsonInputFile: stringFlag("json-input-file"),
					jsonInputStdin: Boolean(flags["json-input-stdin"]),
					confirm: Boolean(flags.confirm),
					idempotencyKey: stringFlag("idempotency-key"),
					cursor: stringFlag("cursor"),
					afterTranscriptId: stringFlag("after-transcript-id"),
					wait: Boolean(flags.wait),
					timeoutMs,
					strict: Boolean(flags.strict),
					untilIdle: Boolean(flags["until-idle"]),
					allEvents: Boolean(flags["all-events"]),
					page: Boolean(flags.page),
					limit: flags.limit as number | undefined,
					agentDir: stringFlag("agent-dir"),
					repo: stringFlag("repo"),
					scope: stringFlag("scope"),
					json: flags.json === true,
				});
				return;
			}
			if (operation === "guides") {
				await runSdkGuidesCli({
					action: scan.descriptor.command[2],
					guideId: args.guideId as string | undefined,
					url: stringFlag("url"),
					agentDir: stringFlag("agent-dir"),
					timeoutMs,
				});
				return;
			}
			if (operation === "serve") {
				try {
					await runSdkServe(scan.operationArgv.slice(1));
				} catch (error) {
					if (!(error instanceof SdkServeError)) throw error;
					// A command invoked outside the public family dispatcher still owns its
					// stderr envelope. The dispatcher itself keeps the typed failure for the
					// shared JSON/text boundary so it can render the full contract.
					if (this.config?.commands instanceof Map && this.config.commands.has("sdk")) throw error;
					process.stderr.write(
						`${JSON.stringify({
							ok: false,
							error: {
								code: error.code,
								message: error.message,
								...(error.details === undefined ? {} : { details: error.details }),
								...(error.cleanupError === undefined ? {} : { cleanupError: error.cleanupError }),
							},
						})}\n`,
					);
					process.exitCode = error.exitCode;
				}
				return;
			}
			throw new PublicCommandFailure({ kind: "usage", proof: "pre-effect" });
		}

		const internal = parseSdkInternalArgv(this.argv);
		if (internal.action === "session-host-internal") {
			await runSessionHost();
			return;
		}
		if (internal.action === "stderr-drain-internal") {
			await runSdkStderrDrainer(internal.logPath, internal.maxBytes);
			return;
		}
		const agentDir = path.resolve(internal.agentDir);
		let broker: Broker | undefined;
		let runningBroker: Broker | undefined;
		let stopSweep: (() => void) | undefined;
		let startupExitRequested = false;
		let startupExitReason: "startup-deadline" | "startup-signal" | undefined;
		let startupExitLogged = false;
		let pendingShutdownSignal: "SIGTERM" | "SIGINT" | undefined;
		let startupExitTask: Promise<boolean> | undefined;
		const startupStartedAt = process.hrtime.bigint();
		let startupExitWrite: Promise<BrokerStartupExitWriteStatus> | undefined;
		const startupAbortController = new AbortController();
		let candidateStartTask: Promise<unknown> | undefined;
		const waitForStartupAbortCleanup = async (): Promise<void> => {
			const task = candidateStartTask;
			if (!task) return;
			await Promise.race([
				task.then(
					() => undefined,
					() => undefined,
				),
				Bun.sleep(BROKER_STARTUP_MARKER_WRITE_TIMEOUT_MS),
			]);
		};
		const startupSignalExitCode = (signal: "SIGTERM" | "SIGINT"): 130 | 143 => (signal === "SIGINT" ? 130 : 143);
		const makeStartupExitRecord = (
			reason: "startup-deadline" | "startup-signal",
			exitCode: 1 | 130 | 143,
			signal: "SIGTERM" | "SIGINT" | null,
			timeoutMs?: number,
		): BrokerStartupExitRecord & Record<string, unknown> => ({
			version: 1,
			reason,
			mode: "startup",
			fenceReason: null,
			fencedForMs: 0,
			uptimeMs: Math.max(0, Number((process.hrtime.bigint() - startupStartedAt) / 1_000_000n)),
			pid: process.pid,
			signal,
			exitCode,
			timeoutMs: timeoutMs ?? null,
			writtenAt: Date.now(),
		});
		const beginStartupExitRecordWrite = (record: BrokerStartupExitRecord): Promise<BrokerStartupExitWriteStatus> => {
			const testDelayMs = Number(process.env.GJC_SDK_TEST_BROKER_STARTUP_EXIT_RECORD_DELAY_MS ?? 0);
			const beforeWriteForTest =
				Number.isSafeInteger(testDelayMs) && testDelayMs > 0 && testDelayMs <= 10_000
					? async () => {
							await emitBrokerStartupTestSignal("startup-exit-record-fallback-waiting");
							await Bun.sleep(testDelayMs);
						}
					: undefined;
			startupExitWrite ??= writeBrokerStartupExitRecordBounded(
				agentDir,
				record,
				BROKER_STARTUP_MARKER_WRITE_TIMEOUT_MS,
				beforeWriteForTest,
			);
			return startupExitWrite;
		};
		const brokerReadyForSignal = (): Broker | undefined =>
			runningBroker ?? (broker?.ownsDiscovery ? broker : undefined);
		const writeStartupExitLog = (
			record: BrokerStartupExitRecord & Record<string, unknown>,
			message: string,
		): void => {
			if (startupExitLogged) return;
			startupExitLogged = true;
			const level = record.exitCode === 1 ? "error" : "warn";
			if (record.exitCode === 1) logger.error("sdk broker: startup watchdog forcing exit", record);
			else logger.warn("sdk broker: startup interrupted", record);
			process.stderr.write(`${JSON.stringify({ level, message, ...record })}\n`);
		};
		const exitDuringStartup = (
			reason: "startup-deadline" | "startup-signal",
			exitCode: 1 | 130 | 143,
			signal: "SIGTERM" | "SIGINT" | null,
			timeoutMs?: number,
		): Promise<boolean> => {
			// The first startup exit cause owns both the persisted reason and the process exit code.
			if (startupExitTask) return startupExitReason === reason ? startupExitTask : Promise.resolve(false);
			if (startupExitRequested) return Promise.resolve(false);
			startupExitRequested = true;
			startupExitReason = reason;
			const exitRecord = makeStartupExitRecord(reason, exitCode, signal, timeoutMs);
			const message =
				reason === "startup-deadline"
					? `SDK broker startup exceeded its ${timeoutMs}ms fence deadline.`
					: `SDK broker startup interrupted by ${signal} before readiness.`;
			writeStartupExitLog(exitRecord, message);
			const recordWrittenSynchronously =
				reason === "startup-signal" && writeBrokerStartupExitRecordSynchronously(agentDir, exitRecord);
			startupExitTask = (async () => {
				const exitRecordWrite = recordWrittenSynchronously
					? { kind: "written" as const }
					: await beginStartupExitRecordWrite(exitRecord);
				const exitRecordWritten = exitRecordWrite.kind === "written";
				if (!exitRecordWritten)
					logger.error("sdk broker: startup exit record write timed out", {
						reason: "startup-exit-record-write-failed-or-timed-out",
						exitReason: reason,
						exitRecordWriteStatus: exitRecordWrite.kind,
						...(exitRecordWrite.kind === "failed" && exitRecordWrite.code
							? { exitRecordWriteErrorCode: exitRecordWrite.code }
							: {}),
						pid: process.pid,
						exitCode,
					});
				return true;
			})();
			return startupExitTask;
		};
		const unregisterPostmortem = postmortem.register("sdk-broker:exit", async reason => {
			const signal =
				reason === postmortem.Reason.SIGTERM
					? "SIGTERM"
					: reason === postmortem.Reason.SIGINT
						? "SIGINT"
						: pendingShutdownSignal;
			if (!signal) return;
			pendingShutdownSignal = signal;
			if (startupExitTask && startupExitReason === "startup-deadline") {
				await startupExitTask;
				await waitForStartupAbortCleanup();
				process.exit(1);
				return;
			}
			const activeBroker = brokerReadyForSignal();
			if (activeBroker) {
				runningBroker = activeBroker;
				stopSweep?.();
				await activeBroker.stop({ kind: "signal", signal });
				return;
			}
			startupAbortController.abort();
			await exitDuringStartup("startup-signal", startupSignalExitCode(signal), signal);
			await candidateStartTask?.catch(() => undefined);
		});
		const finishPendingStartupSignal = async (): Promise<boolean> => {
			const signal = pendingShutdownSignal;
			if (!signal) return false;
			await exitDuringStartup("startup-signal", startupSignalExitCode(signal), signal);
			return true;
		};
		try {
			const startupOperation = async (deadline: number): Promise<Broker | undefined> => {
				const remainingMs = Math.max(1, deadline - Date.now());
				const testWatchdogMs = Number(process.env.GJC_SDK_TEST_BROKER_STARTUP_WATCHDOG_MS ?? 0);
				const watchdogMs =
					Number.isSafeInteger(testWatchdogMs) && testWatchdogMs > 0 && testWatchdogMs <= remainingMs
						? testWatchdogMs
						: remainingMs;
				const startupWatchdog = setTimeout(() => {
					startupAbortController.abort();
					void exitDuringStartup("startup-deadline", 1, null, watchdogMs).then(async started => {
						if (!started) return;
						await waitForStartupAbortCleanup();
						process.exit(1);
					});
				}, watchdogMs);
				try {
					const existing = await reconcileBrokerGenerationForStartup({ agentDir }, deadline);
					if (startupAbortController.signal.aborted) return undefined;
					if (existing) {
						logger.info("sdk broker: startup reused an existing owner", {
							reason: "existing-owner-reused",
							ownerId: existing.ownerId,
							pid: existing.pid,
							exitCode: 0,
						});
						return undefined;
					}
					if (process.env.GJC_SDK_TEST_BROKER_STARTUP_STALL === "1") {
						const stalled = Promise.withResolvers<void>();
						await stalled.promise;
					}
					const testStartupSignal = process.env.GJC_SDK_TEST_BROKER_STARTUP_SIGNAL;
					if (testStartupSignal === "SIGTERM" || testStartupSignal === "SIGINT") {
						await emitBrokerStartupTestSignal("startup-signal-ready");
						process.kill(process.pid, testStartupSignal);
						const waiting = Promise.withResolvers<void>();
						await waiting.promise;
					}
					const startupGateFile = process.env.GJC_SDK_TEST_BROKER_STARTUP_GATE_FILE;
					if (startupGateFile) {
						await emitBrokerStartupTestSignal("startup-gate-waiting");
						await waitForBrokerStartupTestGate(startupGateFile);
						await emitBrokerStartupTestSignal("startup-gate-released");
					}
					const startupDelayMs = Number(process.env.GJC_SDK_TEST_BROKER_STARTUP_DELAY_MS ?? 0);
					if (Number.isSafeInteger(startupDelayMs) && startupDelayMs > 0 && startupDelayMs <= 10_000) {
						await Bun.sleep(startupDelayMs);
					}
					if (startupAbortController.signal.aborted) return undefined;
					// The real broker-internal entry point is the only place that reads this
					// launcher-supplied environment variable; it is validated here and handed
					// to Broker as a typed setting, never read a second time inside broker.ts
					// from process.env directly.
					const restartRequestEnv = process.env.GJC_BROKER_RESTART_REQUEST;
					const restartRequestId =
						typeof restartRequestEnv === "string" && /^[A-Za-z0-9_-]{1,256}$/.test(restartRequestEnv)
							? restartRequestEnv
							: undefined;
					const testPostPublicationDelayMs = Number(
						process.env.GJC_SDK_TEST_BROKER_POST_PUBLICATION_DELAY_MS ?? 0,
					);
					const startupPostPublicationDelayMs =
						Number.isSafeInteger(testPostPublicationDelayMs) &&
						testPostPublicationDelayMs > 0 &&
						testPostPublicationDelayMs <= 10_000
							? testPostPublicationDelayMs
							: undefined;
					const testPrePublicationDelayMs = Number(process.env.GJC_SDK_TEST_BROKER_PRE_PUBLICATION_DELAY_MS ?? 0);
					const startupPrePublicationDelayMs =
						Number.isSafeInteger(testPrePublicationDelayMs) &&
						testPrePublicationDelayMs > 0 &&
						testPrePublicationDelayMs <= 10_000
							? testPrePublicationDelayMs
							: undefined;
					const testAfterDiscoveryWriteDelayMs = Number(
						process.env.GJC_SDK_TEST_BROKER_AFTER_DISCOVERY_WRITE_DELAY_MS ?? 0,
					);
					const startupAfterDiscoveryWriteTestHook =
						Number.isSafeInteger(testAfterDiscoveryWriteDelayMs) &&
						testAfterDiscoveryWriteDelayMs > 0 &&
						testAfterDiscoveryWriteDelayMs <= 10_000
							? async () => {
									await emitBrokerStartupTestSignal("discovery-written-before-retain");
									const signal = startupAbortController.signal;
									if (signal.aborted) return;
									const wait = Promise.withResolvers<void>();
									const timer = setTimeout(wait.resolve, testAfterDiscoveryWriteDelayMs);
									const onAbort = (): void => wait.resolve();
									signal.addEventListener("abort", onAbort, { once: true });
									try {
										await wait.promise;
									} finally {
										clearTimeout(timer);
										signal.removeEventListener("abort", onAbort);
									}
								}
							: undefined;
					const candidate = new Broker({
						agentDir,
						startupAbortSignal: startupAbortController.signal,
						onStartupReady: () => clearTimeout(startupWatchdog),
						masterOrphanGraceMs: (await Settings.loadForScope({ cwd: process.cwd(), agentDir })).get(
							"sdk.masterOrphanGraceMs",
						),
						resolveDirectoryMigration: async cwd => {
							const settings = await Settings.loadForScope({ cwd, agentDir });
							try {
								const policy = settings.get("session.directoryMigration");
								return policy === "disabled" ? "disabled" : "copy-retain";
							} finally {
								await settings.close();
							}
						},
						...(startupPrePublicationDelayMs === undefined
							? {}
							: {
									startupPrePublicationDelayMs,
									startupPrePublicationTestHook: async () => {
										await emitBrokerStartupTestSignal("pre-publication-ready");
									},
								}),
						...(startupAfterDiscoveryWriteTestHook === undefined ? {} : { startupAfterDiscoveryWriteTestHook }),
						...(startupPostPublicationDelayMs === undefined ? {} : { startupPostPublicationDelayMs }),
						...(restartRequestId === undefined ? {} : { restartRequestId }),
					});
					broker = candidate;
					candidateStartTask = candidate.start();
					await candidateStartTask;
					if (candidate.ownsDiscovery) runningBroker = candidate;
					return candidate;
				} finally {
					clearTimeout(startupWatchdog);
				}
			};
			broker = await withBrokerStartupLock(agentDir, startupOperation, {
				onAcquired: () => void emitBrokerStartupTestSignal("fence-acquired"),
				onContended: () => void emitBrokerStartupTestSignal("fence-contended"),
			});
		} catch (error) {
			if (pendingShutdownSignal) {
				await finishPendingStartupSignal();
				return;
			}
			if (broker) {
				try {
					await broker.stop({ kind: "startup-failure" });
				} catch {
					// Preserve the startup/fence failure that made this bootstrap unusable.
				}
			}
			// This process spawns detached with stdio ignored (see ensure.ts), so the
			// durable marker is the only channel the caller has to see why start()
			// failed instead of a bare exit code (#3963).
			const startupFailureIncarnation = processIncarnation(process.pid);
			const markerWritten = await writeBrokerStartupFailureMarkerBounded(agentDir, {
				reason: error instanceof Error ? error.message : String(error),
				exitCode: 1,
				signal: null,
				pid: process.pid,
				...(startupFailureIncarnation === undefined ? {} : { incarnation: startupFailureIncarnation }),
			});
			logger.error("sdk broker: startup failed", {
				reason: "startup-failure",
				pid: process.pid,
				exitCode: 1,
				markerWritten,
			});
			unregisterPostmortem();
			throw error;
		}
		if (!broker) {
			if (pendingShutdownSignal) {
				await finishPendingStartupSignal();
				return;
			}
			unregisterPostmortem();
			return;
		}
		if (!broker.ownsDiscovery) {
			if (pendingShutdownSignal) {
				if (runningBroker) await runningBroker.completion;
				else await finishPendingStartupSignal();
				return;
			}
			// Another broker owns discovery; this process exits cleanly (code 0) as
			// the race loser. Record why so a caller polling for a winner that never
			// appears can diagnose the loss instead of seeing only a bare exit 0.
			const losingIncarnation = processIncarnation(process.pid);
			await writeBrokerStartupFailureMarkerBounded(agentDir, {
				reason: "Another broker owns the lock/discovery; this broker exited as the race loser.",
				exitCode: 0,
				signal: null,
				pid: process.pid,
				...(losingIncarnation === undefined ? {} : { incarnation: losingIncarnation }),
			});
			unregisterPostmortem();
			return;
		}
		runningBroker = broker;
		// A live broker must not keep advertising sessions whose host process is
		// gone; the sweep is the broker-side half of the host reaping bound.
		stopSweep = startBrokerDeadRegistrationSweep(runningBroker);
		try {
			await runningBroker.completion;
		} finally {
			stopSweep?.();
			if (!pendingShutdownSignal) unregisterPostmortem();
		}
		if (!pendingShutdownSignal) process.exit(0);
	}
}
