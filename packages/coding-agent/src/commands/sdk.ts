import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { Args, Command, Flags } from "@gajae-code/utils/cli";
import type { Args as ParsedArgs } from "../cli/args";
import { Settings } from "../config/settings";
import { applyStartupModelProfiles, createSessionManager } from "../main";
import { initializeExtensions } from "../modes/runtime-init";
import { Broker } from "../sdk/broker/broker";
import {
	type LifecycleTranscriptEvidence,
	readSessionLifecycleLaunchRequest,
	type SessionLifecycleLaunchRequest,
	type SessionLifecycleTranscriptIdentity,
	writeSessionLifecycleFailure,
	writeSessionLifecycleReady,
} from "../sdk/broker/lifecycle";
import { processIncarnation } from "../sdk/broker/process-incarnation";
import { type CreateLifecycleAgentSessionResult, createLifecycleAgentSession } from "../sdk/lifecycle-session";
import { listManagedSessionCandidates, resolveManagedSessionScope } from "../sdk/session-directory";
import {
	normalizeSdkStartupFailure,
	type SdkStartupFailure,
	type SdkStartupRollbackResult,
	SdkStartupRollbackTracker,
} from "../sdk/startup-capability";
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
		...(request.operation === "session.resume" ? { resume: request.sessionPath } : {}),
		...(request.modelPreset ? { mpreset: request.modelPreset } : {}),
		...(request.operation === "session.fork"
			? {
					fork: request.sourceSessionPath ?? request.sourceSessionId,
					sessionDir: forkSessionDir,
				}
			: {}),
	};
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
	const migrationPolicy =
		lifecycleSettings.get("session.directoryMigration") === "disabled" ? "disabled" : "copy-retain";
	if (request.operation === "session.create") {
		return { parsed, sessionManager: await createSessionManager(parsed, cwd, lifecycleSettings) };
	}
	const snapshot = await captureLifecycleTranscript(request, cwd, agentDir, migrationPolicy);
	let sessionManager: SessionManager | undefined;
	if (request.operation === "session.resume") {
		const opened = await SessionManager.openExistingStrict(
			snapshot.identity,
			parsed.sessionDir,
			undefined,
			migrationPolicy,
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
		const forked = await SessionManager.forkFromCaptured(snapshot, cwd, parsed.sessionDir, migrationPolicy);
		if (forked.kind === "error")
			throw new Error("Lifecycle saved session authority changed while the session host forked it.");
		sessionManager = forked.manager;
	}
	return { parsed, sessionManager };
}

/** Runs the same persisted AgentSession bootstrap used by the production CLI. */
export async function runSessionHost(
	timing: {
		now?: () => number;
		sleep?: (ms: number) => Promise<void>;
		cwd?: string;
		processIncarnation?: (pid: number) => string | undefined;
	} = {},
): Promise<void> {
	const now = timing.now ?? Date.now;
	const sleep = timing.sleep ?? (async ms => await Bun.sleep(ms));
	const readIncarnation = timing.processIncarnation ?? processIncarnation;
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

	let opened: { parsed: ParsedArgs; sessionManager: SessionManager | undefined };
	let created: CreateLifecycleAgentSessionResult;
	try {
		opened = await openLifecycleSessionManager(request, cwd, agentDir);
		created = await createLifecycleAgentSession({ cwd, agentDir, sessionManager: opened.sessionManager });
	} catch (error) {
		const rollback = new SdkStartupRollbackTracker();
		rollback.recordAbsent();
		const failure = normalizeSdkStartupFailure("registration", "failed", error);
		await writeFailure(failure, rollback.result);
		throw new Error(failure.message);
	}
	const { parsed } = opened;
	if ("failure" in created) {
		created.rollback.recordAbsent();
		await writeFailure(created.failure, created.rollback.result);

		throw new Error(created.failure.message);
	}
	const { session, capability, rollback } = created;
	let sessionDisposal: Promise<void> | undefined;
	const disposeSession = (): Promise<void> => {
		sessionDisposal ??= session.dispose().catch(() => {});
		return sessionDisposal;
	};
	let disposal: Promise<LifecycleTranscriptEvidence | undefined> | undefined;
	const disposeAndCapture = (): Promise<LifecycleTranscriptEvidence | undefined> => {
		disposal ??= (async () => {
			await disposeSession();
			try {
				await session.sessionManager.ensureOnDisk();
				const transcriptPath = session.sessionManager.getSessionFile();
				if (!transcriptPath) return undefined;
				const [bytes, stat] = await Promise.all([
					fs.readFile(transcriptPath),
					fs.stat(transcriptPath, { bigint: true }),
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
	const stop = () => {
		if (capability.result?.status === "started") {
			void disposeSession().finally(() => process.exit(0));
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
		const modelProfileStartup =
			process.env.GJC_SDK_TEST_HANG_MODEL_PROFILE === cwd
				? new Promise<void>(() => {})
				: applyStartupModelProfiles({
						session,
						settings: session.settings,
						modelRegistry: session.modelRegistry,
						parsedArgs: parsed,
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
	process.once("SIGTERM", stop);
	process.once("SIGINT", stop);
	await new Promise<void>(() => {});
}

export default class Sdk extends Command {
	static description = "SDK internal services";
	static hidden = true;
	static args = { action: Args.string({ required: true, options: ["broker-internal", "session-host-internal"] }) };
	static flags = { "agent-dir": Flags.string({ description: "Internal broker agent directory" }) };
	async run(): Promise<void> {
		const { args, flags } = await this.parse(Sdk);
		if (args.action === "session-host-internal") {
			await runSessionHost();
			return;
		}
		const agentDir = flags["agent-dir"] as string | undefined;
		if (!agentDir) throw new Error("--agent-dir is required for sdk broker-internal.");
		const broker = new Broker({
			agentDir,
			resolveDirectoryMigration: async cwd => {
				const policy = (await Settings.loadForScope({ cwd, agentDir })).get("session.directoryMigration");
				return policy === "disabled" ? "disabled" : "copy-retain";
			},
		});
		await broker.start();
		if (!broker.ownsDiscovery) return;
		const stop = () => void broker.stop().finally(() => process.exit(0));
		process.once("SIGTERM", stop);
		process.once("SIGINT", stop);
		await new Promise<void>(() => {});
	}
}
