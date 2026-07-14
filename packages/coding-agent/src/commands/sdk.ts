import * as fs from "node:fs/promises";
import * as path from "node:path";
import { Args, Command, Flags } from "@gajae-code/utils/cli";
import type { Args as ParsedArgs } from "../cli/args";
import { applyStartupModelProfiles, createSessionManager } from "../main";
import { initializeExtensions } from "../modes/runtime-init";
import { createAgentSession } from "../sdk";
import { Broker } from "../sdk/broker/broker";
import {
	readSessionLifecycleLaunchRequest,
	type SessionLifecycleLaunchRequest,
	type SessionLifecycleTranscriptIdentity,
	writeSessionLifecycleReady,
} from "../sdk/broker/lifecycle";
import {
	type CapturedSessionTranscriptSnapshot,
	type ResumeSessionIdentity,
	SessionManager,
} from "../session/session-manager";

export function lifecycleArgs(request: SessionLifecycleLaunchRequest, cwd: string, agentDir: string): ParsedArgs {
	return {
		messages: [],
		fileArgs: [],
		unknownFlags: new Map(),
		...(request.operation === "session.resume" ? { resume: request.sessionPath } : {}),
		...(request.modelPreset ? { mpreset: request.modelPreset } : {}),
		...(request.operation === "session.fork"
			? {
					fork: request.sourceSessionPath ?? request.sourceSessionId,
					sessionDir: SessionManager.getDefaultSessionDirReadOnly(cwd, agentDir),
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
	actual: { dev: bigint; ino: bigint; size: number; mtimeMs: number; mtimeNs: bigint },
	expected: SessionLifecycleTranscriptIdentity,
): boolean {
	return (
		actual.dev.toString() === expected.dev &&
		actual.ino.toString() === expected.ino &&
		actual.size === expected.size &&
		actual.mtimeMs === expected.mtimeMs &&
		actual.mtimeNs.toString() === expected.mtimeNs
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

function verifyLifecycleTranscript(
	request: SessionLifecycleLaunchRequest,
	cwd: string,
	agentDir: string,
): LifecycleTranscriptSource {
	const source = lifecycleTranscriptSource(request, cwd);
	const inventory = SessionManager.inventorySessionsStrict(source.cwd, {
		sessionDir: SessionManager.getDefaultSessionDir(source.cwd, agentDir),
	});
	if (inventory.kind !== "complete")
		throw new Error("Lifecycle saved session storage could not be verified for the requested workspace.");
	const matches = inventory.candidates.filter(
		candidate =>
			candidate.path === path.resolve(source.path) &&
			candidate.id === source.id &&
			sameTranscriptIdentity(candidate.identity, source.identity),
	);
	if (matches.length !== 1)
		throw new Error("Lifecycle saved session authority changed before the session host started.");
	return source;
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

function captureLifecycleTranscript(
	request: SessionLifecycleLaunchRequest,
	cwd: string,
	agentDir: string,
): CapturedSessionTranscriptSnapshot {
	const source = verifyLifecycleTranscript(request, cwd, agentDir);
	const captured = SessionManager.captureTranscriptStrict(source.path);
	if (
		captured.kind !== "captured" ||
		captured.snapshot.sourcePath !== path.resolve(source.path) ||
		captured.snapshot.identity.sessionId !== source.id ||
		!sameTranscriptIdentity(captured.snapshot.identity, source.identity)
	)
		throw new Error("Lifecycle saved session authority changed before the session host consumed it.");
	return captured.snapshot;
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
	const parsed = lifecycleArgs(request, cwd, agentDir);
	if (request.operation === "session.create") {
		return { parsed, sessionManager: await createSessionManager(parsed, cwd) };
	}
	const snapshot = captureLifecycleTranscript(request, cwd, agentDir);
	let sessionManager: SessionManager | undefined;
	if (request.operation === "session.resume") {
		const opened = await SessionManager.openExistingStrict(snapshot.identity, parsed.sessionDir);
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
		const forked = await SessionManager.forkFromCaptured(snapshot, cwd, parsed.sessionDir);
		if (forked.kind === "error")
			throw new Error("Lifecycle saved session authority changed while the session host forked it.");
		sessionManager = forked.manager;
	}
	return { parsed, sessionManager };
}

/** Runs the same persisted AgentSession bootstrap used by the production CLI. */
async function runSessionHost(): Promise<void> {
	const request = readSessionLifecycleLaunchRequest(process.env.GJC_SDK_LIFECYCLE_REQUEST);
	const agentDir = process.env.GJC_AGENT_DIR;
	if (!agentDir) throw new Error("GJC_AGENT_DIR is required for sdk session-host-internal.");
	const cwd = process.cwd();
	if ((await fs.realpath(request.cwd)) !== (await fs.realpath(cwd)))
		throw new Error(`Lifecycle worktree mismatch: expected ${request.cwd}, got ${cwd}.`);
	if (
		process.env.GJC_STATE_ROOT !== undefined &&
		path.resolve(process.env.GJC_STATE_ROOT) !== path.resolve(request.stateRoot)
	)
		throw new Error("Lifecycle state root does not match the broker-issued request.");
	if (request.effectMarker && process.env.GJC_LIFECYCLE_REQUEST_ID !== request.effectMarker)
		throw new Error("Lifecycle effect marker does not match the broker-issued request.");
	const { parsed, sessionManager } = await openLifecycleSessionManager(request, cwd, agentDir);
	const { session } = await createAgentSession({ cwd, agentDir, sessionManager });
	// Extension initialization publishes the SDK-ready event, so profile activation
	// must finish before the broker can expose this lifecycle host.
	await applyStartupModelProfiles({
		session,
		settings: session.settings,
		modelRegistry: session.modelRegistry,
		parsedArgs: parsed,
	});
	let stopping = false;
	const stop = () => {
		if (stopping) return;
		stopping = true;
		void session.dispose().finally(() => process.exit(0));
	};
	await initializeExtensions(session, {
		reportSendError: () => {},
		reportRuntimeError: () => {},
		onShutdown: stop,
	});
	if (session.sessionManager.getSessionId() !== request.sessionId)
		throw new Error(
			`Lifecycle session id mismatch: expected ${request.sessionId}, got ${session.sessionManager.getSessionId()}.`,
		);
	await session.sessionManager.ensureOnDisk();
	if (request.effectMarker)
		await writeSessionLifecycleReady(request.stateRoot, request.sessionId, request.effectMarker);
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
		const broker = new Broker({ agentDir });
		await broker.start();
		if (!broker.ownsDiscovery) return;
		const stop = () => void broker.stop().finally(() => process.exit(0));
		process.once("SIGTERM", stop);
		process.once("SIGINT", stop);
		await new Promise<void>(() => {});
	}
}
