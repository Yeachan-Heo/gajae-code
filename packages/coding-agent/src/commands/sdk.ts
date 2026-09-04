import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { logger } from "@gajae-code/utils";
import { Args, CliParseError, Command, Flags, renderCommandHelp } from "@gajae-code/utils/cli";
import type { Args as ParsedArgs } from "../cli/args";
import { parseModelString } from "../config/model-resolver";
import { Settings } from "../config/settings";
import { applyStartupModelProfiles, createSessionManager } from "../main";
import { initializeExtensions } from "../modes/runtime-init";
import { initTheme } from "../modes/theme/theme";
import { ACP_MCP_REQUEST_TIMEOUT_MS, ACP_MCP_STARTUP_HEADROOM_MS } from "../sdk/acp/mcp";
import { Broker } from "../sdk/broker/broker";
import { readBrokerDiscovery } from "../sdk/broker/discovery";
import { reconcileBrokerGenerationForStartup, withBrokerStartupLock } from "../sdk/broker/ensure";
import { completeBrokerProcess } from "../sdk/broker/internal";
import {
	type LifecycleTranscriptEvidence,
	readSessionLifecycleLaunchRequest,
	type SessionLifecycleLaunchRequest,
	type SessionLifecycleTranscriptIdentity,
	sessionHostAttachedClients,
	sessionHostWorkInFlight,
	startBrokerDeadRegistrationSweep,
	writeSessionLifecycleFailure,
	writeSessionLifecycleReady,
} from "../sdk/broker/lifecycle";
import { processIncarnation } from "../sdk/broker/process-incarnation";
import { writeBrokerStartupFailureMarker } from "../sdk/broker/startup-failure";
import { renderSdkSearchTable, runSdkSearch, runSdkSessionCli } from "../sdk/cli";
import { renderSpawnTable, runSdkSpawn, SdkMasterCliError } from "../sdk/cli/master-cli";
import { runSdkGuidesCli } from "../sdk/guides/cli";
import { type CreateLifecycleAgentSessionResult, createLifecycleAgentSession } from "../sdk/lifecycle-session";
import { listManagedSessionCandidates, resolveManagedSessionScope } from "../sdk/session-directory";
import {
	normalizeSdkStartupFailure,
	type SdkStartupFailure,
	type SdkStartupRollbackResult,
	SdkStartupRollbackTracker,
} from "../sdk/startup-capability";
import { runSdkServe } from "../sdk/transport/serve-cli";
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
 * How long a session host tolerates the complete absence of a live broker
 * publication before treating itself as orphaned. Hosts intentionally survive
 * broker restarts (a replacement broker republishes discovery within seconds),
 * so this must comfortably exceed a restart window while still bounding the
 * lifetime of hosts whose broker is gone for good — otherwise every crashed or
 * torn-down broker leaks a detached multi-hundred-megabyte host forever.
 */
export const SESSION_HOST_BROKER_ABSENCE_GRACE_MS = 10 * 60_000;
const SESSION_HOST_BROKER_POLL_MS = 15_000;

/**
 * Resolves only once no live broker publication has been observable in
 * `agentDir` for the full grace window. A reappearing broker (including a
 * replacement with a different pid) resets the window; an unreadable
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
	for (;;) {
		let live: unknown = null;
		try {
			live = await readDiscovery(deps.agentDir);
		} catch {
			// Transient read failures are ambiguity, not proof of orphanhood.
		}
		if (live) {
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
 * socket-subscription count, so a client that is merely idle — an editor
 * sitting on an open ACP session, a long agent turn with nobody typing — still
 * holds a socket and resets the window on every poll. Only a client that is
 * actually gone opens it, and 30 minutes is far longer than any client
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
 * `readAttachedClients` reports the host's own live client/socket subscription
 * count; `undefined` means the SDK endpoint publishes no such evidence — before
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
 * `readWorkInFlight` reports whether the host is running agent work right now.
 * Work is positive proof a client did come for this host: a prompt can only
 * arrive over an endpoint a client dialed. Live work therefore restarts both
 * windows, which is what keeps a mid-prompt host alive whether its count reads
 * zero or stops being readable at all. That still bounds a host whose SDK
 * runtime never came up: with no transport it can never receive a prompt, so it
 * never reports work and its window keeps running from process start. And any
 * real turn ends, after which the window resumes; live work defers a bound, it
 * never removes it.
 */
export async function watchSessionHostClientAttachment(deps: {
	readAttachedClients: () => number | undefined;
	readWorkInFlight?: () => boolean;
	now?: () => number;
	sleep?: (ms: number) => Promise<void>;
	idleGraceMs?: number;
	firstAttachGraceMs?: number;
	pollMs?: number;
}): Promise<void> {
	const now = deps.now ?? Date.now;
	const sleep = deps.sleep ?? (async ms => await Bun.sleep(ms));
	const readWorkInFlight = deps.readWorkInFlight ?? (() => false);
	const idleGraceMs = deps.idleGraceMs ?? SESSION_HOST_DETACHED_IDLE_GRACE_MS;
	const firstAttachGraceMs = deps.firstAttachGraceMs ?? SESSION_HOST_FIRST_ATTACH_GRACE_MS;
	const pollMs = deps.pollMs ?? SESSION_HOST_ATTACHMENT_POLL_MS;
	let everAttached = false;
	let detachedSince: number | null = null;
	/** Start of the current window in which nobody has been shown to want this host. */
	let unattendedSince = now();
	for (;;) {
		const attached = deps.readAttachedClients();
		if (readWorkInFlight()) {
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
			if (now() - detachedSince >= idleGraceMs) return;
		} else if (now() - unattendedSince >= firstAttachGraceMs) {
			return;
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
	} = {},
): Promise<void> {
	const now = timing.now ?? Date.now;
	const sleep = timing.sleep ?? (async ms => await Bun.sleep(ms));
	const readIncarnation = timing.processIncarnation ?? processIncarnation;
	const applyModelProfiles = timing.applyStartupModelProfiles ?? applyStartupModelProfiles;
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

	// Inlined rather than extracted to a helper: TypeScript's definite-assignment
	// analysis does not see a `Promise<never>` helper as terminating, so hoisting
	// this would make `opened`/`created` "used before assigned" below.
	const registrationFailure = async (error: unknown): Promise<SdkStartupFailure> => {
		const rollback = new SdkStartupRollbackTracker();
		rollback.recordAbsent();
		const failure = normalizeSdkStartupFailure("registration", "failed", error);
		await writeFailure(failure, rollback.result);
		return failure;
	};

	let opened: { parsed: ParsedArgs; sessionManager: SessionManager | undefined };
	let created: CreateLifecycleAgentSessionResult;
	let mcpConfigDirectory: string | undefined;
	try {
		let mcpConfigPath: string | undefined;
		try {
			opened = await openLifecycleSessionManager(request, cwd, agentDir);
			if (request.mcpServers && request.mcpServers.length > 0) {
				mcpConfigDirectory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "gjc-acp-mcp-")));
				mcpConfigPath = path.join(mcpConfigDirectory, "mcp.json");
				await Bun.write(
					mcpConfigPath,
					JSON.stringify({
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
											type: "stdio",
											command: server.command,
											args: server.args,
											...(server.env ? { env: server.env } : {}),
											noInheritEnv: true,
											timeout: ACP_MCP_REQUEST_TIMEOUT_MS,
										},
							]),
						),
					}),
				);
			}
		} catch (error) {
			throw await registrationFailure(error);
		}

		try {
			await initTheme(false);
		} catch (error) {
			throw await registrationFailure(error);
		}

		// The longer MCP startup ceiling is scoped to ACP lifecycle launches only:
		// it applies when this request actually carried `mcpServers`. Ordinary
		// CLI/SDK `mcpConfigPath` consumers keep the manager's short default.
		//
		// This recheck deliberately sits OUTSIDE the registration catch above.
		// Inside it, the throw would be caught, reclassified as
		// `registration`/`failed`, and written a second time, losing the
		// `startup`/`pending` outcome the readiness cutoff is supposed to report.
		// Session-manager open, MCP config write, and theme initialization already
		// consumed part of the budget, so re-read the clock here.
		let mcpStartupTimeoutMs: number | undefined;
		if (mcpConfigPath !== undefined) {
			const remaining = request.semanticReadyDeadlineAt - now() - ACP_MCP_STARTUP_HEADROOM_MS;
			if (remaining <= 0) {
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
			mcpStartupTimeoutMs = remaining;
		}

		try {
			created = await createLifecycleAgentSession({
				cwd,
				agentDir,
				sessionManager: opened.sessionManager,
				...(mcpConfigPath ? { mcpConfigPath } : {}),
				...(mcpStartupTimeoutMs !== undefined ? { mcpStartupTimeoutMs } : {}),
				...(request.readiness ? { readiness: request.readiness } : {}),
				...(request.modelId ? { modelId: request.modelId } : {}),
				lifecycleRequestId: effectMarker,
			});
		} catch (error) {
			throw await registrationFailure(error);
		}
	} finally {
		if (mcpConfigDirectory) await fs.rm(mcpConfigDirectory, { recursive: true, force: true });
	}
	const { parsed } = opened;
	if ("failure" in created) {
		created.rollback.recordAbsent();
		await writeFailure(created.failure, created.rollback.result);

		throw created.failure;
	}
	const { session, capability, rollback, startDeferredMemoryBackend } = created;
	let lifecycleTranscriptPath: string | undefined;
	session.registerToolSessionTransitionCleanup(async () => {
		await session.sessionManager.ensureOnDisk();
		lifecycleTranscriptPath = session.sessionManager.getSessionFile();
	});
	let sessionDisposal: Promise<void> | undefined;
	const disposeSession = (): Promise<void> => {
		sessionDisposal ??= (async () => {
			try {
				await session.dispose();
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
			const transcript = await disposeAndCapture();
			if (rollback.generation === undefined) rollback.recordAbsent();
			await writeFailure(failure, rollback.result, transcript);
		})();
		return failureRollback;
	};
	const sessionEndpointPath = path.join(request.stateRoot, "sdk", `${request.sessionId}.json`);
	const exitAfterSessionDisposal = async (): Promise<void> => {
		await disposeSession();
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
	const stop = () => {
		if (capability.result?.status === "started") {
			if (stopping) return;
			stopping = true;
			void exitAfterSessionDisposal();
			return;
		}
		const failure = capability.normalizeFailure("startup", "failed", "SDK lifecycle host terminated.");
		capability.cancel();
		void failAfterRollback(failure).finally(() => process.exit(0));
	};
	const cutoffFailure = (): SdkStartupFailure => capability.normalizeFailure("startup", "pending");
	const throwIfCutoff = (): void => {
		if (now() >= request.semanticReadyDeadlineAt) {
			capability.cancel();
			throw cutoffFailure();
		}
	};
	const cutoff = sleep(Math.max(0, request.semanticReadyDeadlineAt - now())).then(() => ({ cutoff: true }) as const);
	const beforeCutoff = async <T>(stage: Promise<T>): Promise<T> => {
		const result = await Promise.race([stage.then(value => ({ cutoff: false, value }) as const), cutoff]);
		if (result.cutoff) {
			capability.cancel();
			throw cutoffFailure();
		}
		return result.value;
	};

	try {
		const startupThinkingLevel = request.modelId ? parseModelString(request.modelId)?.thinkingLevel : undefined;
		const modelProfileStartup =
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
					});
		await beforeCutoff(modelProfileStartup);
		throwIfCutoff();
		await beforeCutoff(
			initializeExtensions(session, {
				reportSendError: () => {},
				reportRuntimeError: () => {},
				onShutdown: stop,
			}),
		);
		throwIfCutoff();
		if (session.sessionManager.getSessionId() !== request.sessionId)
			throw new Error(
				`Lifecycle session id mismatch: expected ${request.sessionId}, got ${session.sessionManager.getSessionId()}.`,
			);
		const startup = await beforeCutoff(capability.promise);
		if (startup.status !== "started") throw startup.failure;
		throwIfCutoff();
		if (process.env.GJC_SDK_TEST_FAIL_AFTER_REGISTRATION === cwd)
			throw new Error("Lifecycle test failure after SDK host registration.");

		await session.sessionManager.ensureOnDisk();
		throwIfCutoff();

		await writeSessionLifecycleReady(request.stateRoot, request.sessionId, effectMarker);
	} catch (error) {
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
	process.once("SIGTERM", stop);
	process.once("SIGINT", stop);
	// Two independent bounds, either of which reaps this detached host through
	// the same graceful teardown a SIGTERM would take. The first covers a broker
	// that is gone for good; the second covers the opposite case, a perfectly
	// healthy broker whose host nobody is attached to any more and for which no
	// `session.close` will ever arrive.
	await Promise.race([
		watchSessionHostBrokerLiveness({ agentDir }),
		watchSessionHostClientAttachment({
			readAttachedClients: sessionHostAttachedClients,
			readWorkInFlight: sessionHostWorkInFlight,
		}),
	]);
	stop();
	await new Promise<void>(() => {});
}

export type SdkInternalArgv = { action: "broker-internal"; agentDir: string } | { action: "session-host-internal" };

/** Parses the exact private argv contracts used by SDK child-process spawns. */
export function parseSdkInternalArgv(argv: readonly string[]): SdkInternalArgv {
	if (argv[0] === "session-host-internal" && argv.length === 1) return { action: "session-host-internal" };
	if (argv[0] === "broker-internal" && argv.length === 3 && argv[1] === "--agent-dir" && argv[2])
		return { action: "broker-internal", agentDir: argv[2] };
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
		"Manage SDK sessions: `gjc sdk session list|inspect|send|status|tail|retire`, or the explicit raw hatch `gjc sdk session raw control|query|global`. The session CLI is broker-bound and credential-free.";
	static args = {
		verb: Args.string({
			description: "Session verb",
			required: false,
			options: ["list", "inspect", "send", "status", "tail", "retire", "raw"],
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
			description: "Raw query continuation cursor, saved checkpoint token, or search continuation cursor",
		}),
		scope: Flags.string({
			description:
				"session list scope: repo (default), cwd, worktree, or all; search scope: repo (default), pwd, or global",
		}),
		limit: Flags.integer({ description: "Search page size from 1 to 100" }),
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
	static description =
		"gjc sdk serve --stdio | --socket <path> [--session <id>]; gjc sdk search [--scope repo|pwd|global] [--json] [--limit N] [--cursor ...]; gjc sdk spawn --cwd <dir> --prompt <task> (master only); gjc sdk session list|inspect|send|status|tail; gjc sdk guides refresh|list|show|status|trust";
	static hidden = false;
	static delegateHelp = true;
	static args = {
		action: Args.string({ required: false, options: ["serve", "search", "spawn", "session", "guides"] }),
	};
	static flags = SdkServeHelp.flags;
	async run(): Promise<void> {
		const action = this.argv[0];
		if (this.argv.includes("--help") || this.argv.includes("-h")) {
			const helpAction =
				action === "serve"
					? "sdk serve"
					: action === "search"
						? "sdk search"
						: action === "spawn"
							? "sdk spawn"
							: action === "session"
								? "sdk session"
								: action === "guides"
									? "sdk guides"
									: "sdk";
			const helpCommand =
				action === "serve"
					? SdkServeHelp
					: action === "search"
						? SdkSearchCommand
						: action === "spawn"
							? SdkSpawnCommand
							: action === "session"
								? SdkSessionCommand
								: action === "guides"
									? SdkGuidesCommand
									: Sdk;
			renderCommandHelp("gjc", helpAction, helpCommand);
			return;
		}
		if (action === "search") {
			await new SdkSearchCommand(this.argv.slice(1), this.config).run();
			return;
		}
		if (action === "spawn") {
			await new SdkSpawnCommand(this.argv.slice(1), this.config).run();
			return;
		}
		if (action === "session") {
			await new SdkSessionCommand(this.argv.slice(1), this.config).run();
			return;
		}
		if (action === "guides") {
			await new SdkGuidesCommand(this.argv.slice(1), this.config).run();
			return;
		}
		if (action === "serve") {
			await runSdkServe(this.argv.slice(1));
			return;
		}
		if (action !== "broker-internal" && action !== "session-host-internal")
			throw new CliParseError("Expected action to be serve, search, spawn, session, or guides.");
		const internal = parseSdkInternalArgv(this.argv);
		if (internal.action === "session-host-internal") {
			await runSessionHost();
			return;
		}
		const agentDir = path.resolve(internal.agentDir);
		let broker: Broker | undefined;
		try {
			broker = await withBrokerStartupLock(agentDir, async deadline => {
				const remainingMs = Math.max(1, deadline - Date.now());
				const testWatchdogMs = Number(process.env.GJC_SDK_TEST_BROKER_STARTUP_WATCHDOG_MS ?? 0);
				const watchdogMs =
					Number.isSafeInteger(testWatchdogMs) && testWatchdogMs > 0 && testWatchdogMs <= remainingMs
						? testWatchdogMs
						: remainingMs;
				const startupWatchdog = setTimeout(() => {
					process.stderr.write(`SDK broker startup exceeded its ${watchdogMs}ms fence deadline.\n`);
					process.exit(1);
				}, watchdogMs);
				try {
					if (await reconcileBrokerGenerationForStartup({ agentDir }, deadline)) return undefined;
					if (process.env.GJC_SDK_TEST_BROKER_STARTUP_STALL === "1") {
						const stalled = Promise.withResolvers<void>();
						await stalled.promise;
					}
					const startupDelayMs = Number(process.env.GJC_SDK_TEST_BROKER_STARTUP_DELAY_MS ?? 0);
					if (Number.isSafeInteger(startupDelayMs) && startupDelayMs > 0 && startupDelayMs <= 10_000)
						await Bun.sleep(startupDelayMs);
					const candidate = new Broker({
						agentDir,
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
					});
					broker = candidate;
					await candidate.start();
					return candidate;
				} finally {
					clearTimeout(startupWatchdog);
				}
			});
		} catch (error) {
			if (broker) {
				try {
					await broker.stop();
				} catch {
					// Preserve the startup/fence failure that made this bootstrap unusable.
				}
			}
			// This process spawns detached with stdio ignored (see ensure.ts), so the
			// durable marker is the only channel the caller has to see why start()
			// failed instead of a bare exit code (#3963).
			const incarnation = processIncarnation(process.pid);
			if (incarnation)
				await writeBrokerStartupFailureMarker(agentDir, {
					reason: error instanceof Error ? error.message : String(error),
					exitCode: 1,
					signal: null,
					pid: process.pid,
					incarnation,
				});
			throw error;
		}
		if (!broker) return;
		const runningBroker = broker;
		if (!runningBroker.ownsDiscovery) {
			// Another broker owns discovery; this process exits cleanly (code 0) as
			// the race loser. Record why so a caller polling for a winner that never
			// appears can diagnose the loss instead of seeing only a bare exit 0.
			const incarnation = processIncarnation(process.pid);
			if (incarnation)
				await writeBrokerStartupFailureMarker(agentDir, {
					reason: "Another broker owns the lock/discovery; this broker exited as the race loser.",
					exitCode: 0,
					signal: null,
					pid: process.pid,
					incarnation,
				});
			return;
		}
		// A live broker must not keep advertising sessions whose host process is
		// gone; the sweep is the broker-side half of the host reaping bound.
		const stopSweep = startBrokerDeadRegistrationSweep(runningBroker);
		const stop = () => {
			stopSweep();
			void runningBroker.stop();
		};
		process.once("SIGTERM", stop);
		process.once("SIGINT", stop);
		try {
			await completeBrokerProcess(runningBroker);
		} finally {
			stopSweep();
		}
	}
}
