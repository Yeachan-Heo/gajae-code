import { Buffer } from "node:buffer";
import * as crypto from "node:crypto";
import * as fsSync from "node:fs";

import * as path from "node:path";
import type { Process } from "@gajae-code/natives";
import { nativeProcessBindings } from "@gajae-code/utils/native-process";
import { managedSecurityFailureClassification } from "../session/internal/managed-session-storage";
import { readLinuxProcStartTime, readLinuxProcStartTimeSync } from "./linux-proc";
import {
	MANAGED_OWNER_COMMAND_ENV,
	MANAGED_OWNER_INCARNATION_ENV,
	MANAGED_OWNER_REDACT_COMMAND_ENV,
	MANAGED_OWNER_RUN_ID_ENV,
	MANAGED_OWNER_SUPERVISOR_ARG,
} from "./managed-owner-supervisor";
import { resolveGjcTmuxBinary } from "./psmux-detect";
import { GJC_DIR, GJC_SESSION_PREFIX, tmuxRuntimeSessionPath } from "./session-layout";
import {
	GJC_COORDINATOR_SESSION_ID_ENV,
	GJC_COORDINATOR_SESSION_STATE_FILE_ENV,
	GJC_TMUX_OWNER_GENERATION_ENV,
	GJC_TMUX_OWNER_SERVER_KEY_ENV,
	GJC_TMUX_OWNER_STATE_DIR_ENV,
} from "./session-state-sidecar";
import {
	assertGjcTmuxMutationAuthoritySync,
	assertSafeGjcTmuxSessionName,
	bindGjcTmuxProviderAuthority,
	buildGjcTmuxExactOptionTarget,
	buildGjcTmuxExactSessionTarget,
	buildGjcTmuxProfileCommands,
	buildGjcTmuxSessionName,
	buildGjcTmuxSessionSlug,
	buildGjcTmuxUntaggedSessionError,
	buildTmuxProviderCommand,
	GJC_TMUX_BRANCH_OPTION,
	GJC_TMUX_BRANCH_SLUG_OPTION,
	GJC_TMUX_COMMAND_ENV,
	GJC_TMUX_OWNER_GENERATION_OPTION,
	GJC_TMUX_OWNER_SERVER_KEY_OPTION,
	GJC_TMUX_PROFILE_OPTION,
	GJC_TMUX_PROFILE_VALUE,
	GJC_TMUX_PROJECT_OPTION,
	GJC_TMUX_SESSION_ID_OPTION,
	GJC_TMUX_SESSION_STATE_FILE_OPTION,
	GJC_TMUX_VERSION_OPTION,
	hasGjcTmuxProviderAuthoritySync,
	normalizeTmuxCreatedAt,
	type ProviderAuthority,
	persistGjcTmuxProviderAuthoritySync,
	readGjcTmuxProviderAuthoritySync,
	resolveGjcTmuxCommand,
	resolveGjcTmuxProviderContext,
} from "./tmux-common";
import {
	captureOwnerGenerationBaselineSync,
	classifyCgroup,
	closeExactTmuxOwner,
	executeTmuxOwnerIsolationPlanSync,
	isOwnerGenerationBaselineCurrentSync,
	isValidGenerationRecord,
	isValidOwnerVerdict,
	lifecyclePaths,
	type OwnerIsolationProbeSync,
	type OwnerVerdict,
	observeOwnerTerminal,
	type PlanResponse,
	planTmuxOwnerIsolationSync,
	readNoFollowJson,
	replaceOwnerGenerationSync,
	type TmuxOwnerIsolationExecutionDependencies,
	type TmuxOwnerIsolationExecutionResult,
	type TmuxServerProof,
} from "./tmux-owner-isolation";
import {
	assertGjcTmuxStagedMutationAuthoritySync,
	gjcTmuxAuthorityPlatform,
	listGjcTmuxProviderAuthoritiesSync,
} from "./tmux-provider-context";
import { buildWindowsPowerShellInnerCommand } from "./windows-powershell-command";

export interface ManagedTmuxLaunchSpec {
	childSessionId: string;
	cwd: string;
	argv: readonly string[];
	env?: Readonly<Record<string, string>>;
}

export interface ManagedTmuxLaunchProof {
	name: string;
	nativeSessionId: string;
	serverPid: number;
	serverStartTime: string;
	ownerGeneration: string;
	sessionId: string;
	sessionStateFile: string;
	pid: number;
	providerIdentity: string;
	psmuxIncarnation?: string;
}

function providerIdentity(
	provider: Pick<ProviderAuthority, "kind" | "command" | "namespace" | "executableIdentity">,
): string {
	return JSON.stringify([provider.kind, provider.command, provider.namespace, provider.executableIdentity]);
}

function managedOwnerSupervisorArgv(): string[] {
	const entry = process.argv[1];
	if (!entry || !/\.(?:[cm]?[jt]s)$/.test(entry) || /\.test\.[^.]+$/.test(entry))
		return [process.execPath, MANAGED_OWNER_SUPERVISOR_ARG];
	return [process.execPath, entry, MANAGED_OWNER_SUPERVISOR_ARG];
}

function validManagedLaunchSpec(spec: ManagedTmuxLaunchSpec, platform: NodeJS.Platform): boolean {
	const pathModule = platform === "win32" ? path.win32 : path;
	return (
		typeof spec.childSessionId === "string" &&
		spec.childSessionId.length > 0 &&
		!spec.childSessionId.includes("\0") &&
		typeof spec.cwd === "string" &&
		spec.cwd.length > 0 &&
		!spec.cwd.includes("\0") &&
		pathModule.isAbsolute(spec.cwd) &&
		Array.isArray(spec.argv) &&
		spec.argv.length > 0 &&
		spec.argv.every(value => typeof value === "string" && value.length > 0 && !value.includes("\0")) &&
		(spec.env === undefined ||
			Object.entries(spec.env).every(
				([name, value]) =>
					/^[A-Za-z_][A-Za-z0-9_]*$/.test(name) && typeof value === "string" && !value.includes("\0"),
			))
	);
}

export interface GjcTmuxSessionStatus {
	name: string;
	attached: boolean;
	windows: number;
	panes: number;
	bindings: string;
	createdAt: string;
	branch?: string;
	branchSlug?: string;
	project?: string;
	sessionId?: string;
	sessionStateFile?: string;
	version?: string;
	ownerGeneration?: string;
	nativeSessionId?: string;
	psmuxIncarnation?: string;
	/** Exact durable provider binding used to discover this psmux session. */
	providerAuthority?: ProviderAuthority;

	panePids: number[];
	profile?: string;
}

export interface GjcTmuxSessionTagsForGc {
	profile?: string;
	project?: string;
	branch?: string;
	branchSlug?: string;
	sessionId?: string;
	sessionStateFile?: string;
	version?: string;
	ownerGeneration?: string;
	nativeSessionId?: string;
	psmuxIncarnation?: string;

	createdAt?: string;
	attached?: boolean;
	panePids?: number[];
}

export interface GjcTmuxSessionsForGc {
	tagged: GjcTmuxSessionStatus[];
	untagged: GjcTmuxSessionStatus[];
}

export interface ProvenTmuxSessionIdentity {
	nativeSessionId: string;
	serverPid: number;
	serverStartTime: string;
	psmuxIncarnation?: string;
}

export interface ExpectedGjcTmuxSessionIdentity {
	nativeSessionId: string;
	ownerGeneration: string;
	sessionId: string;
	sessionStateFile: string;
	project: string;
	createdAt: string;
	psmuxIncarnation?: string;
}

export interface ExactOwnerIdentity {
	sessionId: string;
	stateDir: string;
	socketKey: string;
	generation: string;
	pid: number;
	startTime: string;
}

export interface ForceCloseOwnerDependencies {
	resolveOwner(sessionName: string, env: NodeJS.ProcessEnv): Promise<ExactOwnerIdentity>;
	signalTerm(pid: number): void;
	readProcessStartTime(pid: number): Promise<string | null>;
	cleanupSession(sessionTarget: string, env: NodeJS.ProcessEnv): void;
	now(): Date;
	sleep(ms: number): Promise<void>;
	listPanePids(sessionName: string, env: NodeJS.ProcessEnv): number[];
	/** Test/runtime seam for an exact owner-exit observer; durable validation remains authoritative. */
	waitForOwnerExitVerdict?(): Promise<OwnerVerdict>;
	/** Broker close pin; production callers use this to reject reused session identity. */
	expectedManagedProof?: ManagedTmuxLaunchProof;
}
const GJC_TMUX_PSMUX_INCARNATION_OPTION = "@gjc-psmux-incarnation";
const effectiveSessionEnvironments = new WeakMap<GjcTmuxSessionStatus, NodeJS.ProcessEnv>();
const fallbackSessionEnvironments = new WeakSet<GjcTmuxSessionStatus>();

const FORCE_CLOSE_VERDICT_TIMEOUT_MS = 15_000;
const FORCE_CLOSE_VERDICT_POLL_MS = 50;

export interface CreateGjcTmuxSessionOptions {
	platform?: NodeJS.Platform;
	launch?: ManagedTmuxLaunchSpec;
}

export type CreateOwnerIsolationTestDependencies = {
	probe?: Partial<OwnerIsolationProbeSync>;
	execute?: (plan: PlanResponse, deps: TmuxOwnerIsolationExecutionDependencies) => TmuxOwnerIsolationExecutionResult;
};

let createOwnerIsolationTestDependencies: CreateOwnerIsolationTestDependencies | null = null;
let mutationServerProofTestDependency: ((tmuxCommand: string, env: NodeJS.ProcessEnv) => unknown) | null = null;

/** @internal Test-only seam; production create always uses live fail-closed probes. */
export function __setCreateOwnerIsolationForTests(dependencies: CreateOwnerIsolationTestDependencies | null): void {
	createOwnerIsolationTestDependencies = dependencies;
}

/** @internal Test-only seam; production mutations always use live fail-closed proofs. */
export function __setMutationServerProofForTests(
	dependency: ((tmuxCommand: string, env: NodeJS.ProcessEnv) => unknown) | null,
): void {
	mutationServerProofTestDependency = dependency;
}

function psmuxAuthorityFromEnv(env: NodeJS.ProcessEnv): ProviderAuthority | null {
	const stateDir = env[GJC_TMUX_OWNER_STATE_DIR_ENV]?.trim();
	const sessionId = env[GJC_COORDINATOR_SESSION_ID_ENV]?.trim();
	const generation = env[GJC_TMUX_OWNER_GENERATION_ENV]?.trim();
	if (!stateDir || !sessionId || !generation) return null;
	if (!hasGjcTmuxProviderAuthoritySync({ stateDir, sessionId, generation })) return null;
	return readGjcTmuxProviderAuthoritySync({ stateDir, sessionId, generation });
}
function environmentForProviderAuthority(
	env: NodeJS.ProcessEnv,
	authority: ProviderAuthority | undefined,
): NodeJS.ProcessEnv {
	if (!authority) return env;
	return {
		...env,
		[GJC_TMUX_COMMAND_ENV]: authority.command,
		[GJC_TMUX_OWNER_STATE_DIR_ENV]: authority.stateDir,
		[GJC_COORDINATOR_SESSION_ID_ENV]: authority.sessionId,
		[GJC_TMUX_OWNER_GENERATION_ENV]: authority.generation,
	};
}

function runTmux(
	args: string[],
	env: NodeJS.ProcessEnv = process.env,
	provisionalAuthority?: ProviderAuthority,
): string {
	const authority = provisionalAuthority ?? psmuxAuthorityFromEnv(env);
	const binary = resolveGjcTmuxBinary({ env });
	if (binary.isPsmux && !authority) throw new Error("gjc_tmux_provider_authority_unavailable");
	const tmuxCommand = authority?.command ?? binary.command;
	if (authority)
		(provisionalAuthority ? assertGjcTmuxStagedMutationAuthoritySync : assertGjcTmuxMutationAuthoritySync)(authority);
	let result: Bun.SyncSubprocess<"pipe", "pipe">;
	try {
		result = Bun.spawnSync(
			[tmuxCommand, ...(authority ? buildTmuxProviderCommand(authority, args[0]!, args.slice(1)) : args)],
			{
				stdout: "pipe",
				stderr: "pipe",
				env,
			},
		);
	} finally {
		if (authority)
			(provisionalAuthority ? assertGjcTmuxStagedMutationAuthoritySync : assertGjcTmuxMutationAuthoritySync)(
				authority,
			);
	}
	if (result.exitCode === 0) return result.stdout?.toString() ?? "";
	throw new Error(result.stderr?.toString().trim() || `${tmuxCommand} ${args.join(" ")} failed`);
}
function safeNativeTmuxSessionId(sessionTarget: string): string {
	// Native tmux session IDs are immutable `$N` handles. psmux has no native
	// numeric ID, so its session name must satisfy the human-name boundary.
	return /^\$\d+$/.test(sessionTarget) ? sessionTarget : assertSafeGjcTmuxSessionName(sessionTarget);
}

function normalizeExactTmuxTarget(sessionTarget: string, env: NodeJS.ProcessEnv, kind: "session" | "option"): string {
	// Native tmux session IDs are immutable `$N` handles, not user-controlled
	// session names. Preserve those handles for exact reads while routing every
	// other value through the bounded session-name target builders.
	if (/^\$\d+$/.test(sessionTarget)) return sessionTarget;
	return kind === "option"
		? buildGjcTmuxExactOptionTarget(sessionTarget, { env })
		: buildGjcTmuxExactSessionTarget(sessionTarget, { env });
}

function readExactSessionPanePids(sessionName: string, env: NodeJS.ProcessEnv): number[] {
	return runTmux(
		["list-panes", "-s", "-t", normalizeExactTmuxTarget(sessionName, env, "session"), "-F", "#{pane_pid}"],
		env,
	)
		.split("\n")
		.map(value => Number.parseInt(value.trim(), 10))
		.filter(pid => Number.isSafeInteger(pid) && pid > 0);
}

function parseBooleanFlag(value: string | undefined): boolean {
	return value === "1";
}

function parseNumber(value: string | undefined): number {
	const parsed = Number.parseInt(value ?? "0", 10);
	return Number.isFinite(parsed) ? parsed : 0;
}

function parseSessionLine(line: string): GjcTmuxSessionStatus | null {
	const fields = line.split("\t");
	if (fields.length > 17) throw new Error("gjc_tmux_session_row_malformed");
	while (fields.length < 17) fields.push("");
	const [
		name = "",
		windows = "0",
		attached = "0",
		created = "",
		profile = "",
		bindings = "",
		panes = "0",
		panePids = "",
		branch = "",
		branchSlug = "",
		project = "",
		sessionId = "",
		sessionStateFile = "",
		ownerGeneration = "",
		version = "",
		psmuxIncarnation = "",
		nativeSessionId = "",
	] = fields;

	if (!name) return null;
	assertSafeGjcTmuxSessionName(name);
	return {
		name,
		attached: parseBooleanFlag(attached),
		windows: parseNumber(windows),
		panes: parseNumber(panes),
		panePids: panePids
			.split(",")
			.map(pid => parseNumber(pid))
			.filter(pid => pid > 0),
		bindings,
		createdAt: normalizeTmuxCreatedAt(created),
		branch: branch || undefined,
		branchSlug: branchSlug || undefined,
		project: project || undefined,
		profile: profile || undefined,
		sessionId: sessionId || undefined,
		sessionStateFile: sessionStateFile || undefined,
		version: version || undefined,
		ownerGeneration: ownerGeneration || undefined,
		psmuxIncarnation: nativeSessionId ? psmuxIncarnation || undefined : undefined,
		nativeSessionId: nativeSessionId || (psmuxIncarnation.startsWith("$") ? psmuxIncarnation : undefined),
	};
}

/** tmux failure shapes that mean "this socket has no server", not "tmux is broken". */
function isMissingServerFailure(message: string): boolean {
	return (
		message.includes("no server running") ||
		(message.includes("failed to connect to server") && /(?:no such file or directory|not found)/iu.test(message))
	);
}

function isMissingSocketFailure(message: string): boolean {
	return (
		message.toLowerCase().includes("error connecting to ") &&
		/(?:no such file or directory|not found)/iu.test(message)
	);
}

/**
 * `$TMUX` is inherited from whatever launched gjc and names the socket tmux
 * talks to. Terminal hosts that emulate tmux for their own agents can export a
 * `$TMUX` pointing at a socket they never created, and tmux then fails with
 * `error connecting to <socket>` — the same message shape as a legitimate
 * "no server" miss. Returning the socket path lets callers tell the two apart
 * instead of reporting zero sessions while sessions are live on the default
 * socket.
 */
function inheritedTmuxSocketPath(env: NodeJS.ProcessEnv): string | null {
	const socket = env.TMUX?.split(",")[0]?.trim();
	return socket ? socket : null;
}

function namesInheritedTmuxSocket(message: string, socket: string): boolean {
	const normalizedMessage = process.platform === "win32" ? message.toLowerCase() : message;
	const normalizedSocket = process.platform === "win32" ? socket.toLowerCase() : socket;
	return (
		(normalizedMessage.includes(`error connecting to ${normalizedSocket} `) ||
			normalizedMessage.includes(`failed to connect to server: ${normalizedSocket} `)) &&
		/(?:no such file or directory|not found)/iu.test(message)
	);
}

function envWithoutInheritedTmux(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
	const withoutTmux: NodeJS.ProcessEnv = { ...env };
	delete withoutTmux.TMUX;
	return withoutTmux;
}

interface ListedTmuxSessions {
	lines: string[];
	env: NodeJS.ProcessEnv;
	synthetic?: boolean;
}

function runListSessions(format: string, env: NodeJS.ProcessEnv = process.env): ListedTmuxSessions {
	let effectiveEnv = env;
	let output = "";
	try {
		output = runTmux(["list-sessions", "-F", format], env);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		const inheritedSocket = inheritedTmuxSocketPath(env);
		// A miss on the default socket is a real empty list; only the inherited
		// socket is suspect, so retry without it before concluding there is
		// nothing to list.
		if (inheritedSocket && namesInheritedTmuxSocket(message, inheritedSocket)) {
			try {
				effectiveEnv = envWithoutInheritedTmux(env);
				output = runTmux(["list-sessions", "-F", format], effectiveEnv);
			} catch (retryError) {
				const retryMessage = retryError instanceof Error ? retryError.message : String(retryError);
				if (isMissingServerFailure(retryMessage) || isMissingSocketFailure(retryMessage))
					return { lines: [], env: effectiveEnv };
				throw retryError;
			}
		} else if (isMissingServerFailure(message) || isMissingSocketFailure(message)) return { lines: [], env };
		else throw error;
	}
	const lines = output
		.split("\n")
		.map(line => line.replace(/\r$/, ""))
		.filter(line => line.trim().length > 0);
	// psmux 3.3.0 silently ignores the tmux `-F` format flag and returns its
	// default `name: N windows (created ...)` shape. Detect that case and
	// synthesize a tab-separated row so downstream parseSessionLine /
	// hydrateSessionFromExactOptions can recover the @gjc-* ownership tags
	// via follow-up show-options calls. Without this fallback gjc session
	// list / status return an empty list on psmux even when sessions exist.
	if (lines.length > 0 && !lines[0].includes("\t")) {
		const binary = resolveGjcTmuxBinary({ env });
		if (binary.isPsmux) {
			return {
				lines: lines.map(line => {
					const match = line.match(/^([^:]+):\s*(\d+)\s+windows?\s+\(created\s+([^)]+)\)/);
					if (!match) return line;
					const [, name, windows, created] = match;
					const createdEpoch = String(Math.floor(new Date(`${created} UTC`).getTime() / 1000) || 0);

					return [name, windows, "0", createdEpoch, "", "", "0", "", "", "", "", "", "", "", "", "", ""].join(
						"\t",
					);
				}),
				env: effectiveEnv,
				synthetic: true,
			};
		}
	}
	return { lines, env: effectiveEnv };
}

function listSessionLines(env: NodeJS.ProcessEnv = process.env): ListedTmuxSessions {
	return runListSessions(
		`#{session_name}\t#{session_windows}\t#{session_attached}\t#{session_created}\t#{${GJC_TMUX_PROFILE_OPTION}}\t#{session_key_table}\t#{session_panes}\t#{pane_pid}\t#{${GJC_TMUX_BRANCH_OPTION}}\t#{${GJC_TMUX_BRANCH_SLUG_OPTION}}\t#{${GJC_TMUX_PROJECT_OPTION}}\t#{${GJC_TMUX_SESSION_ID_OPTION}}\t#{${GJC_TMUX_SESSION_STATE_FILE_OPTION}}\t#{${GJC_TMUX_OWNER_GENERATION_OPTION}}\t#{${GJC_TMUX_VERSION_OPTION}}\t#{${GJC_TMUX_PSMUX_INCARNATION_OPTION}}\t#{session_id}`,

		env,
	);
}

function listRawTmuxSessionNames(env: NodeJS.ProcessEnv = process.env): string[] {
	const listed = runListSessions("#{session_name}", env);
	return listed.lines.map(line => {
		// psmux may ignore `-F` and return its prose shape. runListSessions
		// synthesizes a tabular row for that case; only unwrap that known shape,
		// while rejecting literal tabs from a native provider's session name.
		const columns = line.split("\t");
		if (!listed.synthetic && columns.length > 1) throw new Error("gjc_tmux_session_row_malformed");
		const name = listed.synthetic ? (columns[0] ?? line) : line;
		assertSafeGjcTmuxSessionName(name);
		return name;
	});
}

function assertMutationAuthority(session: GjcTmuxSessionStatus): void {
	if (fallbackSessionEnvironments.has(session)) throw new Error("gjc_tmux_fallback_authority_unconfirmed");
}

function canonicalProviderStateDirs(cwd: string): string[] {
	const gjcDir = path.join(cwd, GJC_DIR);
	let entries: fsSync.Dirent[];
	try {
		entries = fsSync.readdirSync(gjcDir, { withFileTypes: true });
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
		throw error;
	}
	return entries
		.filter(entry => entry.isDirectory() && !entry.isSymbolicLink() && entry.name.startsWith(GJC_SESSION_PREFIX))
		.map(entry => path.join(gjcDir, entry.name, "runtime", "tmux-sessions"))
		.filter(candidate => {
			try {
				return fsSync.lstatSync(candidate).isDirectory();
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
				throw error;
			}
		});
}

function psmuxAuthorityEnvironments(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv[] {
	const explicitAuthority = psmuxAuthorityFromEnv(env);
	if (explicitAuthority) return [environmentForProviderAuthority(env, explicitAuthority)];
	const explicitStateDir =
		env[GJC_TMUX_OWNER_STATE_DIR_ENV]?.trim() ??
		(env[GJC_COORDINATOR_SESSION_STATE_FILE_ENV] ? path.dirname(env[GJC_COORDINATOR_SESSION_STATE_FILE_ENV]) : "");
	const ambient = resolveGjcTmuxBinary({ env });
	if (gjcTmuxAuthorityPlatform() === "win32") {
		const ambientAvailable = path.isAbsolute(ambient.command)
			? fsSync.existsSync(ambient.command)
			: Bun.which(ambient.command) !== null;
		const shouldDiscoverPersisted = ambient.isPsmux || (!ambient.viaExplicitOverride && !ambientAvailable);
		if (shouldDiscoverPersisted) {
			const stateDirs = explicitStateDir ? [explicitStateDir] : canonicalProviderStateDirs(process.cwd());
			const authorities = stateDirs.flatMap(stateDir => {
				try {
					return listGjcTmuxProviderAuthoritiesSync(stateDir);
				} catch (error) {
					const classification = managedSecurityFailureClassification(error);
					const message =
						typeof error === "object" && error !== null && "message" in error && typeof error.message === "string"
							? error.message
							: "";
					const foreignOwner = classification === "owner_mismatch" || message.endsWith(": owner_mismatch");
					if (!explicitStateDir && foreignOwner) return [];
					throw error;
				}
			});
			if (authorities.length > 0)
				return authorities.map(authority => environmentForProviderAuthority(env, authority));
		}
		if (!ambient.viaExplicitOverride && !ambientAvailable) {
			throw new Error(
				"gjc_tmux_provider_unavailable — GJC searched for psmux, pmux, and tmux on PATH. " +
					"Install psmux from https://github.com/psmux/psmux for native Windows support, use WSL with real tmux, " +
					"or set GJC_TMUX_COMMAND (and GJC_PSMUX_COMMAND when selecting a psmux compatibility alias).",
			);
		}
	}
	if (ambient.isPsmux) throw new Error("gjc_tmux_provider_authority_unavailable");
	return [env];
}

export function listGjcTmuxSessions(env: NodeJS.ProcessEnv = process.env): GjcTmuxSessionStatus[] {
	const discovered = psmuxAuthorityEnvironments(env).flatMap(authorityEnv => {
		const listed = listSessionLines(authorityEnv);
		const authority = psmuxAuthorityFromEnv(listed.env) ?? undefined;
		return listed.lines
			.map(parseSessionLine)
			.filter((session): session is GjcTmuxSessionStatus => session != null)
			.map(session => {
				const hydrated = hydrateSessionFromExactOptions(session, listed.env);
				effectiveSessionEnvironments.set(hydrated, listed.env);
				if (listed.env !== authorityEnv) fallbackSessionEnvironments.add(hydrated);
				return hydrated;
			})
			.filter((session): session is GjcTmuxSessionStatus => session?.profile === GJC_TMUX_PROFILE_VALUE)
			.map(session => {
				const result = authority ? { ...session, providerAuthority: authority } : session;
				effectiveSessionEnvironments.set(result, listed.env);
				if (listed.env !== authorityEnv) fallbackSessionEnvironments.add(result);
				return result;
			});
	});
	const names = new Set<string>();
	for (const session of discovered) {
		if (names.has(session.name)) throw new Error(`gjc_tmux_provider_authority_ambiguous:${session.name}`);
		names.add(session.name);
	}
	return discovered.sort((a, b) => a.name.localeCompare(b.name));
}

/** @internal */
export function listTmuxSessionsForGc(env: NodeJS.ProcessEnv = process.env): GjcTmuxSessionsForGc {
	const authorityEnvironments = psmuxAuthorityEnvironments(env);
	const sessions = authorityEnvironments.flatMap(authorityEnv => {
		const listed = listSessionLines(authorityEnv);
		return listed.lines
			.map(parseSessionLine)
			.filter((session): session is GjcTmuxSessionStatus => session != null)
			.map(session => {
				const hydrated = hydrateSessionFromExactOptions(session, listed.env);
				effectiveSessionEnvironments.set(hydrated, listed.env);
				if (listed.env !== authorityEnv) fallbackSessionEnvironments.add(hydrated);
				return hydrated;
			});
	});
	const tagged = sessions
		.filter(session => session.profile === GJC_TMUX_PROFILE_VALUE)
		.sort((a, b) => a.name.localeCompare(b.name));
	const taggedNames = new Set(tagged.map(session => session.name));
	const byName = new Map(sessions.map(session => [session.name, session]));
	const untagged = authorityEnvironments
		.flatMap(authorityEnv => listRawTmuxSessionNames(authorityEnv))
		.filter(name => !taggedNames.has(name))
		.map(
			name =>
				byName.get(name) ?? {
					name,
					attached: false,
					windows: 0,
					panes: 0,
					panePids: [],
					bindings: "",
					createdAt: "",
				},
		)
		.sort((a, b) => a.name.localeCompare(b.name));
	return { tagged, untagged };
}

export function findGjcTmuxSessionByBranch(
	branch: string,
	env: NodeJS.ProcessEnv = process.env,
	project?: string | null,
): GjcTmuxSessionStatus | undefined {
	return listGjcTmuxSessions(env).find(
		session => session.branch === branch && (!project || session.project === project),
	);
}

export function findGjcTmuxSessionByName(
	sessionName: string,
	env: NodeJS.ProcessEnv = process.env,
): GjcTmuxSessionStatus | undefined {
	assertSafeGjcTmuxSessionName(sessionName);
	return listGjcTmuxSessions(env).find(session => session.name === sessionName);
}

export function findGjcTmuxSessionByScope(
	project: string,
	branch: string | null | undefined,
	env: NodeJS.ProcessEnv = process.env,
): GjcTmuxSessionStatus | undefined {
	return listGjcTmuxSessions(env).find(
		session => session.project === project && (branch ? session.branch === branch : session.branch === undefined),
	);
}
export function statusGjcTmuxSession(sessionName: string, env: NodeJS.ProcessEnv = process.env): GjcTmuxSessionStatus {
	assertSafeGjcTmuxSessionName(sessionName);
	const session = listGjcTmuxSessions(env).find(candidate => candidate.name === sessionName);
	if (session) return session;
	if (listRawTmuxSessionNames(env).includes(sessionName)) {
		throw new Error(buildGjcTmuxUntaggedSessionError(sessionName, resolveGjcTmuxCommand(env)));
	}
	throw new Error(`gjc_tmux_session_not_found:${sessionName}`);
}

export function createGjcTmuxSession(
	env: NodeJS.ProcessEnv = process.env,
	options: CreateGjcTmuxSessionOptions = {},
): GjcTmuxSessionStatus {
	const launch = options.launch;
	const platform = options.platform ?? process.platform;
	if (launch && !validManagedLaunchSpec(launch, platform)) throw new Error("gjc_tmux_managed_launch_spec_invalid");
	const provider = resolveGjcTmuxProviderContext({ env, platform });
	const tmuxCommand = provider.command;
	const launchEnvironment = launch ? { ...env, GJC_TMUX_SESSION: launch.childSessionId } : env;
	const sessionName = buildGjcTmuxSessionName(launchEnvironment);
	const cwd = launch?.cwd ?? process.cwd();
	const sessionId = launch?.childSessionId ?? (env[GJC_COORDINATOR_SESSION_ID_ENV]?.trim() || sessionName);
	const stateFile =
		(!launch ? env[GJC_COORDINATOR_SESSION_STATE_FILE_ENV]?.trim() : undefined) ||
		tmuxRuntimeSessionPath(
			cwd,
			launch?.childSessionId ?? (env.GJC_SESSION_ID?.trim() || sessionId),
			buildGjcTmuxSessionSlug(sessionName),
		);
	const stateDir = (platform === "win32" ? path.win32 : path).dirname(stateFile);
	const generation = crypto.randomUUID();
	const authority = bindGjcTmuxProviderAuthority(provider, { stateDir, sessionId, generation });
	const managedEnvironment: Record<string, string> = {
		GJC_TMUX_LAUNCHED: "1",
		[GJC_TMUX_OWNER_GENERATION_ENV]: generation,
		[GJC_TMUX_OWNER_STATE_DIR_ENV]: stateDir,
		[GJC_TMUX_OWNER_SERVER_KEY_ENV]: tmuxCommand,
		[GJC_COORDINATOR_SESSION_ID_ENV]: sessionId,
		[GJC_COORDINATOR_SESSION_STATE_FILE_ENV]: stateFile,
		...(launch
			? {
					[MANAGED_OWNER_RUN_ID_ENV]: crypto.randomUUID(),
					[MANAGED_OWNER_INCARNATION_ENV]: crypto.randomUUID(),
					[MANAGED_OWNER_REDACT_COMMAND_ENV]: "1",
				}
			: {}),
	};
	const childEnvironment: Record<string, string> = { ...(launch?.env ?? {}), ...managedEnvironment };
	const executionEnv = { ...env, ...managedEnvironment };
	const shellQuote = (value: string): string => `'${value.replace(/'/g, `'\\''`)}'`;
	const command =
		platform === "win32"
			? buildWindowsPowerShellInnerCommand({
					command: launch ? managedOwnerSupervisorArgv() : ["gjc"],
					environment: {
						...childEnvironment,
						...(launch ? { [MANAGED_OWNER_COMMAND_ENV]: JSON.stringify(launch.argv) } : {}),
					},
				})
			: (() => {
					const supervisorEnvironment = launch ? { [MANAGED_OWNER_COMMAND_ENV]: JSON.stringify(launch.argv) } : {};
					const invocation = launch ? managedOwnerSupervisorArgv() : ["gjc"];
					return `exec env ${Object.entries({ ...childEnvironment, ...supervisorEnvironment })
						.map(([name, value]) => `${name}=${shellQuote(value)}`)
						.join(" ")} ${invocation.map(shellQuote).join(" ")}`;
				})();
	const tmuxArgv = [
		tmuxCommand,
		...buildTmuxProviderCommand(provider, "new-session", [
			"-d",
			"-s",
			sessionName,
			...(launch ? ["-c", cwd] : []),
			...(platform === "win32" ? [] : ["-P", "-F", "#{session_id}"]),
			command,
		]),
	];
	function probeTmuxServer(tmuxCommand: string, env: NodeJS.ProcessEnv): TmuxServerProof {
		if (platform !== "linux") {
			return {
				state: "safe",
				pid: 1,
				startTime: "not-applicable",
				cgroup: { classification: "not_applicable" },
				pidProven: false,
			};
		}
		const result = Bun.spawnSync([tmuxCommand, "display-message", "-p", "#{pid}"], {
			stdout: "pipe",
			stderr: "pipe",
			env,
		});
		if (result.exitCode !== 0) {
			const diagnostic = result.stderr.toString();
			return /no server running|failed to connect|error connecting/.test(diagnostic)
				? { state: "absent" }
				: { state: "unverifiable" };
		}
		const pid = Number(result.stdout.toString().trim());
		if (!Number.isSafeInteger(pid) || pid <= 0) return { state: "unverifiable" };
		try {
			const startTime = readLinuxProcStartTimeSync(pid);
			if (!startTime) return { state: "unverifiable" };
			const cgroup = classifyCgroup({
				platform,
				cgroupText: fsSync.readFileSync(`/proc/${pid}/cgroup`, "utf8"),
			});
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
			};
		} catch {
			return { state: "unverifiable" };
		}
	}

	const probeServer = () => probeTmuxServer(tmuxCommand, executionEnv);

	const testOwnerProbe = createOwnerIsolationTestDependencies?.probe;
	const ownerProbe: OwnerIsolationProbeSync = {
		readCallerCgroup:
			testOwnerProbe?.readCallerCgroup ??
			(() => {
				try {
					return fsSync.readFileSync("/proc/self/cgroup", "utf8");
				} catch {
					return null;
				}
			}),
		probeServer: testOwnerProbe?.probeServer ?? probeServer,
		recordAttempt:
			testOwnerProbe?.recordAttempt ??
			(({ attempt }) => {
				const root = lifecyclePaths(stateDir, sessionId, generation).root;
				const attemptFile = path.join(root, `attempt-${attempt.token}.json`);
				fsSync.mkdirSync(root, { recursive: true, mode: 0o700 });
				const descriptor = fsSync.openSync(attemptFile, "wx", 0o600);
				try {
					fsSync.writeFileSync(
						descriptor,
						`${JSON.stringify({
							schema_version: 1,
							generation,
							session_id: sessionId,
							...attempt,
							created_at: new Date().toISOString(),
						})}\n`,
					);
					fsSync.fsyncSync(descriptor);
				} finally {
					fsSync.closeSync(descriptor);
				}
				const directory = fsSync.openSync(root, "r");
				try {
					fsSync.fsyncSync(directory);
				} finally {
					fsSync.closeSync(directory);
				}
			}),
	};

	const baseline = captureOwnerGenerationBaselineSync(stateDir, sessionId);
	const ownerPlan = planTmuxOwnerIsolationSync(
		{
			schema_version: 1,
			op: "plan",
			platform,
			session_id: sessionId,
			owner_generation: generation,
			baseline,
			cwd,
			state_dir: stateDir,
			socket_key: tmuxCommand,
			tmux_argv: tmuxArgv,
		},
		ownerProbe,
	);
	if (!ownerPlan.ok) throw new Error(`gjc_tmux_owner_isolation_${ownerPlan.code}:${ownerPlan.diagnostic}`);
	persistGjcTmuxProviderAuthoritySync(authority);

	const outcome = (createOwnerIsolationTestDependencies?.execute ?? executeTmuxOwnerIsolationPlanSync)(ownerPlan, {
		socketKey: tmuxCommand,
		spawn: (argv, stdinLine) => {
			assertGjcTmuxStagedMutationAuthoritySync(authority);
			try {
				const result = stdinLine
					? Bun.spawnSync(argv, {
							stdout: "pipe",
							stderr: "pipe",
							stdin: Buffer.from(stdinLine),
							env: executionEnv,
						})
					: Bun.spawnSync(argv, { stdout: "pipe", stderr: "pipe", env: executionEnv });
				return { exitCode: result.exitCode, stdout: result.stdout.toString(), stderr: result.stderr.toString() };
			} finally {
				assertGjcTmuxStagedMutationAuthoritySync(authority);
			}
		},
		probeServer: ownerProbe.probeServer,
		isCurrentGeneration: () => isOwnerGenerationBaselineCurrentSync(stateDir, sessionId, baseline),
		cleanupSpawned: ({ execution, nativeSessionId, server }) => {
			if (!server.pid || !server.startTime) throw new Error("gjc_tmux_cleanup_target_changed");
			cleanupExactCreatedTmuxSession(
				nativeSessionId,
				execution.attempt_session,
				tmuxCommand,
				executionEnv,
				server.pid,
				server.startTime,
				server.pidProven,
				authority,
			);
		},
	});
	if (!outcome.ok) throw new Error(`gjc_tmux_owner_isolation_${outcome.code}:${outcome.diagnostic}`);

	const nativeSessionId = outcome.native_session_id ?? (provider.binary.isPsmux ? sessionName : undefined);
	if (!nativeSessionId) throw new Error("gjc_tmux_owner_isolation_native_session_identity_unavailable");
	const psmuxIncarnation = provider.binary.isPsmux ? crypto.randomUUID() : undefined;
	const server = requireSafeTmuxServerForMutation(tmuxCommand, executionEnv);
	if (server.pid !== outcome.server_pid || server.startTime !== outcome.server_start_time)
		throw new Error("gjc_tmux_owner_changed_after_create");
	if (!provider.binary.isPsmux && !isNativeTmuxSessionBoundToName(nativeSessionId, sessionName, executionEnv))
		throw new Error("gjc_tmux_owner_changed_after_create");

	const createdMetadata = {
		sessionId,
		sessionStateFile: stateFile,
		ownerGeneration: generation,
		ownerServerKey: tmuxCommand,
		version: env.npm_package_version ?? null,
	};
	try {
		tagCreatedTmuxSession(
			nativeSessionId,
			sessionName,
			{ pid: outcome.server_pid, pidProven: server.pidProven },
			executionEnv,
			{ ...createdMetadata },
			tmuxCommand,
			authority,
		);
		if (psmuxIncarnation) {
			runTmux(
				[
					"set-option",
					"-t",
					normalizeExactTmuxTarget(sessionName, executionEnv, "option"),
					GJC_TMUX_PSMUX_INCARNATION_OPTION,
					psmuxIncarnation,
				],
				executionEnv,
				authority,
			);
		}
		if (!createdTmuxMetadataMatches(nativeSessionId, createdMetadata, psmuxIncarnation, executionEnv, authority))
			throw new Error("gjc_tmux_created_metadata_mismatch");
		const reprovenIdentity = proveGjcTmuxSessionMutationTarget(sessionName, executionEnv, authority);
		if (
			reprovenIdentity.nativeSessionId !== nativeSessionId ||
			reprovenIdentity.serverPid !== outcome.server_pid ||
			reprovenIdentity.serverStartTime !== outcome.server_start_time ||
			reprovenIdentity.psmuxIncarnation !== psmuxIncarnation
		)
			throw new Error("gjc_tmux_owner_changed_after_create");
		const firstServer = requireSafeTmuxServerForMutation(tmuxCommand, executionEnv);
		if (firstServer.pid !== outcome.server_pid || firstServer.startTime !== outcome.server_start_time)
			throw new Error("gjc_tmux_owner_changed_after_create");
		const finalServer = requireSafeTmuxServerForMutation(tmuxCommand, executionEnv);
		if (finalServer.pid !== firstServer.pid || finalServer.startTime !== firstServer.startTime)
			throw new Error("gjc_tmux_owner_changed_after_create");
		replaceOwnerGenerationSync(stateDir, sessionId, generation, baseline);
	} catch (precommitError) {
		try {
			cleanupExactCreatedTmuxSession(
				nativeSessionId,
				sessionName,
				tmuxCommand,
				executionEnv,
				outcome.server_pid,
				outcome.server_start_time,
				server.pidProven,
				authority,
			);
		} catch (cleanupError) {
			throw new AggregateError([precommitError, cleanupError], "gjc_tmux_precommit_failed_cleanup_failed");
		}
		throw precommitError;
	}
	return provider.binary.isPsmux
		? statusGjcTmuxSession(sessionName, executionEnv)
		: statusGjcTmuxSessionByNativeId(nativeSessionId, executionEnv);
}

function cleanupCreatedManagedGjcTmuxSession(
	session: GjcTmuxSessionStatus,
	sessionEnv: NodeJS.ProcessEnv,
	proof: ProvenTmuxSessionIdentity | undefined,
): void {
	const nativeSessionId = proof?.nativeSessionId ?? session.nativeSessionId;
	if (!nativeSessionId || !session.ownerGeneration)
		throw new Error(`gjc_tmux_managed_launch_cleanup_identity_unavailable:${session.name}`);
	const tmuxCommand = session.providerAuthority?.command ?? resolveGjcTmuxCommand(sessionEnv);
	const server = requireSafeTmuxServerForMutation(tmuxCommand, sessionEnv);
	if (proof && (server.pid !== proof.serverPid || server.startTime !== proof.serverStartTime))
		throw new Error("gjc_tmux_cleanup_target_changed");
	cleanupExactCreatedTmuxSession(
		nativeSessionId,
		session.name,
		tmuxCommand,
		sessionEnv,
		proof?.serverPid ?? server.pid,
		proof?.serverStartTime ?? server.startTime,
		server.pidProven,
		session.providerAuthority,
		session.ownerGeneration,
		proof?.psmuxIncarnation ?? session.psmuxIncarnation,
	);
}

/** Launches one Broker-owned child through the managed owner path and returns only re-proof inputs. */
export function createManagedGjcTmuxSession(
	spec: ManagedTmuxLaunchSpec,
	env: NodeJS.ProcessEnv = process.env,
	options: Omit<CreateGjcTmuxSessionOptions, "launch"> = {},
): ManagedTmuxLaunchProof {
	const session = createGjcTmuxSession(env, { ...options, launch: spec });
	const sessionEnv = session.providerAuthority ? environmentForProviderAuthority(env, session.providerAuthority) : env;
	let proof: ProvenTmuxSessionIdentity | undefined;
	try {
		proof = proveGjcTmuxSessionMutationTarget(session.name, sessionEnv);
		const status = statusGjcTmuxSession(session.name, sessionEnv);
		if (
			!status.sessionId ||
			!status.sessionStateFile ||
			!status.ownerGeneration ||
			status.panePids.length !== 1 ||
			proof.nativeSessionId !== status.nativeSessionId
		)
			throw new Error("gjc_tmux_managed_launch_proof_unavailable");
		return {
			name: status.name,
			nativeSessionId: proof.nativeSessionId,
			serverPid: proof.serverPid,
			serverStartTime: proof.serverStartTime,
			ownerGeneration: status.ownerGeneration,
			sessionId: status.sessionId,
			sessionStateFile: status.sessionStateFile,
			pid: status.panePids[0]!,
			providerIdentity: providerIdentity(
				session.providerAuthority ?? resolveGjcTmuxProviderContext({ env, platform: options.platform }),
			),
			psmuxIncarnation: proof.psmuxIncarnation,
		};
	} catch (proofError) {
		try {
			cleanupCreatedManagedGjcTmuxSession(session, sessionEnv, proof);
		} catch (cleanupError) {
			throw new AggregateError([proofError, cleanupError], "gjc_tmux_managed_launch_proof_failed_cleanup_failed");
		}
		throw proofError;
	}
}

function isManagedSessionGone(error: unknown): boolean {
	const message = error instanceof Error ? error.message : "";
	return (
		message.startsWith("gjc_tmux_session_not_found:") ||
		message.includes("no server running") ||
		message.includes("failed to connect to server") ||
		message.includes("error connecting to")
	);
}

function managedProofAuthority(proof: ManagedTmuxLaunchProof): ProviderAuthority | null | undefined {
	if (!proof.psmuxIncarnation) return undefined;
	try {
		const authority = readGjcTmuxProviderAuthoritySync({
			stateDir: path.dirname(proof.sessionStateFile),
			sessionId: proof.sessionId,
			generation: proof.ownerGeneration,
		});
		return authority.kind === "windows-psmux" ? authority : null;
	} catch {
		return null;
	}
}

/** Re-proves every mutable multiplexer identity field before a Broker effect. */
export function verifyManagedGjcTmuxSession(
	expected: ManagedTmuxLaunchProof,
	env: NodeJS.ProcessEnv = process.env,
): "verified" | "mismatch" | "gone" {
	const authority = managedProofAuthority(expected);
	if (authority === null) return "mismatch";
	const sessionEnv = authority ? environmentForProviderAuthority(env, authority) : env;
	try {
		const session = statusGjcTmuxSession(expected.name, sessionEnv);
		const identity = proveGjcTmuxSessionMutationTarget(expected.name, sessionEnv);
		const currentProvider = authority ?? resolveGjcTmuxProviderContext({ env: sessionEnv });
		if (
			session.name !== expected.name ||
			session.nativeSessionId !== expected.nativeSessionId ||
			session.sessionId !== expected.sessionId ||
			session.sessionStateFile !== expected.sessionStateFile ||
			session.ownerGeneration !== expected.ownerGeneration ||
			session.panePids.length !== 1 ||
			session.panePids[0] !== expected.pid ||
			identity.nativeSessionId !== expected.nativeSessionId ||
			identity.serverPid !== expected.serverPid ||
			identity.serverStartTime !== expected.serverStartTime ||
			identity.psmuxIncarnation !== expected.psmuxIncarnation ||
			providerIdentity(currentProvider) !== expected.providerIdentity
		)
			return "mismatch";
		return "verified";
	} catch (error) {
		return isManagedSessionGone(error) ? "gone" : "mismatch";
	}
}

/** Closes only an identity that passes the same exhaustive verification used for replay and reaping. */
export async function forceCloseManagedGjcTmuxSession(
	expected: ManagedTmuxLaunchProof,
	env: NodeJS.ProcessEnv = process.env,
): Promise<GjcTmuxSessionStatus> {
	const authority = managedProofAuthority(expected);
	if (authority === null || verifyManagedGjcTmuxSession(expected, env) !== "verified")
		throw new Error(`gjc_tmux_owner_changed:${expected.name}`);
	return await forceCloseGjcTmuxSession(
		expected.name,
		authority ? environmentForProviderAuthority(env, authority) : env,
		expected.sessionId,
		expected.sessionStateFile,
		{ expectedManagedProof: expected },
	);
}

function statusGjcTmuxSessionByNativeId(nativeSessionId: string, env: NodeJS.ProcessEnv): GjcTmuxSessionStatus {
	const name = runTmux(
		["display-message", "-p", "-t", normalizeExactTmuxTarget(nativeSessionId, env, "option"), "#{session_name}"],
		env,
	).trim();
	if (!name || readNativeTmuxSessionId(nativeSessionId, env) !== nativeSessionId)
		throw new Error(`gjc_tmux_owner_changed:${nativeSessionId}`);
	return statusGjcTmuxSession(name, env);
}

function tmuxCommandArgument(value: string): string {
	return `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"').replaceAll("$", "\\$").replaceAll("`", "\\`")}"`;
}

/**
 * Build the guard predicate for an exact tmux session mutation.
 *
 * The `#{pid}` clause is emitted only when the server proof actually proved a
 * PID. Non-Linux probes report a placeholder PID (see {@link TmuxServerProof}),
 * and pinning `#{pid}` to a placeholder produces a predicate no live tmux
 * server can satisfy, which refuses every mutation on those platforms. The
 * remaining clauses still pin the exact session id, session name and owner
 * generation.
 */
function guardedTmuxSessionPredicate(
	expectedServer: { pid: number; pidProven?: boolean },
	nativeSessionId: string,
	sessionName: string,
	expectedOwnerGeneration?: string,
	expectedPsmuxIncarnation?: string,
): string {
	const safeNativeSessionId = safeNativeTmuxSessionId(nativeSessionId);
	const safeSessionName = assertSafeGjcTmuxSessionName(sessionName);
	const ownerGenerationPredicate = expectedOwnerGeneration
		? `#{==:#{${GJC_TMUX_OWNER_GENERATION_OPTION}},${expectedOwnerGeneration}}`
		: "1";
	const serverPidPredicate = expectedServer.pidProven === false ? "1" : `#{==:#{pid},${expectedServer.pid}}`;
	if (!expectedPsmuxIncarnation)
		return `#{&&:${serverPidPredicate},#{&&:#{==:#{session_id},${safeNativeSessionId}},#{&&:#{==:#{session_name},${safeSessionName}},${ownerGenerationPredicate}}}}`;
	const psmuxIncarnationPredicate = `#{==:#{${GJC_TMUX_PSMUX_INCARNATION_OPTION}},${expectedPsmuxIncarnation}}`;
	return `#{&&:${serverPidPredicate},#{&&:#{==:#{session_id},${safeNativeSessionId}},#{&&:#{==:#{session_name},${safeSessionName}},#{&&:${ownerGenerationPredicate},${psmuxIncarnationPredicate}}}}}`;
}

function runGuardedTmuxSessionCommand(
	nativeSessionId: string,
	sessionName: string,
	expectedServer: { pid: number; pidProven?: boolean },
	env: NodeJS.ProcessEnv,
	thenCommand: string,
	expectedOwnerGeneration?: string,
	provisionalAuthority?: ProviderAuthority,
	expectedPsmuxIncarnation?: string,
): void {
	const result = runTmux(
		[
			"if-shell",
			"-t",
			normalizeExactTmuxTarget(nativeSessionId, env, "session"),
			"-F",
			guardedTmuxSessionPredicate(
				expectedServer,
				nativeSessionId,
				sessionName,
				expectedOwnerGeneration,
				expectedPsmuxIncarnation,
			),
			`${thenCommand} ; display-message -p __gjc_tmux_guarded_mutation_ok__`,
			"display-message -p __gjc_tmux_guarded_mutation_refused__",
		],
		env,
		provisionalAuthority,
	).trim();
	if (result !== "__gjc_tmux_guarded_mutation_ok__") throw new Error("gjc_tmux_cleanup_target_changed");
}

function tagCreatedTmuxSession(
	nativeSessionId: string,
	sessionName: string,
	expectedServer: { pid: number; pidProven?: boolean },
	env: NodeJS.ProcessEnv,
	metadata: {
		branch?: string | null;
		branchSlug?: string | null;
		project?: string | null;
		sessionId?: string | null;
		sessionStateFile?: string | null;
		ownerGeneration?: string | null;
		ownerServerKey?: string | null;
		version?: string | null;
	},
	tmuxCommand: string,
	provisionalAuthority?: ProviderAuthority,
): void {
	const safeNativeSessionId = safeNativeTmuxSessionId(nativeSessionId);
	const target = `${safeNativeSessionId}:`;
	const commands = buildGjcTmuxProfileCommands(target, env, metadata, { tmuxCommand })
		.map(command => command.args.map(tmuxCommandArgument).join(" "))
		.join(" ; ");
	runGuardedTmuxSessionCommand(
		safeNativeSessionId,
		sessionName,
		expectedServer,
		env,
		commands,
		undefined,
		provisionalAuthority,
	);
}

function cleanupExactCreatedTmuxSession(
	nativeSessionId: string,
	sessionName: string,
	tmuxCommand: string,
	env: NodeJS.ProcessEnv,
	expectedPid: number,
	expectedStartTime: string,
	expectedPidProven?: boolean,
	provisionalAuthority?: ProviderAuthority,
	expectedOwnerGeneration?: string,
	expectedPsmuxIncarnation?: string,
): void {
	const server = requireSafeTmuxServerForMutation(tmuxCommand, env);
	if (server.pid !== expectedPid || server.startTime !== expectedStartTime)
		throw new Error("gjc_tmux_cleanup_target_changed");
	runGuardedTmuxSessionCommand(
		nativeSessionId,
		sessionName,
		{ pid: expectedPid, pidProven: expectedPidProven ?? server.pidProven },
		env,
		`kill-session -t ${tmuxCommandArgument(normalizeExactTmuxTarget(nativeSessionId, env, "session"))}`,
		expectedOwnerGeneration,
		provisionalAuthority,
		expectedPsmuxIncarnation,
	);
}

function requireSafeTmuxServerForMutation(
	tmuxCommand: string,
	env: NodeJS.ProcessEnv,
): { pid: number; startTime: string; pidProven?: boolean } {
	if (mutationServerProofTestDependency) {
		const proof = mutationServerProofTestDependency(tmuxCommand, env);
		if (
			proof &&
			typeof proof === "object" &&
			Number.isSafeInteger((proof as { pid?: unknown }).pid) &&
			typeof (proof as { startTime?: unknown }).startTime === "string"
		)
			return proof as { pid: number; startTime: string };
		return { pid: 1, startTime: "test" };
	}
	if (process.platform !== "linux") return { pid: 1, startTime: "not-applicable", pidProven: false };
	const result = Bun.spawnSync([tmuxCommand, "display-message", "-p", "#{pid}"], {
		stdout: "pipe",
		stderr: "pipe",
		env,
	});
	if (result.exitCode !== 0) throw new Error("gjc_tmux_owner_isolation_server_unverifiable");
	const pid = Number(result.stdout.toString().trim());
	if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error("gjc_tmux_owner_isolation_server_unverifiable");
	try {
		const startTime = readLinuxProcStartTimeSync(pid);
		const cgroup = classifyCgroup({
			platform: process.platform,
			cgroupText: fsSync.readFileSync(`/proc/${pid}/cgroup`, "utf8"),
		});
		if (!startTime || cgroup.classification !== "safe")
			throw new Error(
				`gjc_tmux_owner_isolation_${cgroup.classification === "unsafe_service" ? "server_unsafe" : "server_unverifiable"}`,
			);
		return { pid, startTime };
	} catch (error) {
		if (error instanceof Error && error.message.startsWith("gjc_tmux_owner_isolation_")) throw error;
		throw new Error("gjc_tmux_owner_isolation_server_unverifiable");
	}
}

/** Proves a managed reusable name still resolves to one immutable session on one server. */
export function proveGjcTmuxSessionMutationTarget(
	sessionName: string,
	env: NodeJS.ProcessEnv = process.env,
	provisionalAuthority?: ProviderAuthority,
): ProvenTmuxSessionIdentity {
	assertSafeGjcTmuxSessionName(sessionName);
	const target = provisionalAuthority ? sessionName : statusGjcTmuxSession(sessionName, env).name;
	if (readProfileForExactTarget(target, env, provisionalAuthority) !== GJC_TMUX_PROFILE_VALUE)
		throw new Error(`gjc_tmux_session_not_managed:${sessionName}`);
	const firstServer = requireSafeTmuxServerForMutation(resolveGjcTmuxCommand(env), env);
	const nativeSessionId = readNativeTmuxSessionId(target, env, provisionalAuthority);
	if (!nativeSessionId) throw new Error(`gjc_tmux_owner_unverifiable:${sessionName}`);
	if (
		readNativeTmuxSessionId(nativeSessionId, env, provisionalAuthority) !== nativeSessionId ||
		readProfileForExactTarget(nativeSessionId, env, provisionalAuthority) !== GJC_TMUX_PROFILE_VALUE
	)
		throw new Error(`gjc_tmux_owner_changed:${sessionName}`);
	const finalServer = requireSafeTmuxServerForMutation(resolveGjcTmuxCommand(env), env);
	if (finalServer.pid !== firstServer.pid || finalServer.startTime !== firstServer.startTime)
		throw new Error(`gjc_tmux_owner_changed:${sessionName}`);
	const psmuxIncarnation = resolveGjcTmuxBinary({ env }).isPsmux
		? readExactOptionForGc(target, GJC_TMUX_PSMUX_INCARNATION_OPTION, env, provisionalAuthority)
		: undefined;
	if (resolveGjcTmuxBinary({ env }).isPsmux && !psmuxIncarnation)
		throw new Error(`gjc_tmux_owner_unverifiable:${sessionName}`);
	return {
		nativeSessionId,
		serverPid: finalServer.pid,
		serverStartTime: finalServer.startTime,
		psmuxIncarnation,
	};
}

function readProfileForExactTarget(
	sessionName: string,
	env: NodeJS.ProcessEnv,
	provisionalAuthority?: ProviderAuthority,
): string {
	const raw = runTmux(
		["show-options", "-qv", "-t", normalizeExactTmuxTarget(sessionName, env, "option"), GJC_TMUX_PROFILE_OPTION],
		env,
		provisionalAuthority,
	).trim();
	// tmux returns just the value; psmux returns `key value`. Strip the
	// leading key on psmux so the GJC_TMUX_PROFILE_VALUE equality check
	// against "1" works the same on both.
	if (raw && resolveGjcTmuxBinary({ env }).isPsmux) {
		const tokens = raw.split(/\s+/).filter(Boolean);
		return tokens[tokens.length - 1] ?? raw;
	}
	return raw;
}

function readExactOptionForGc(
	sessionName: string,
	option: string,
	env: NodeJS.ProcessEnv,
	provisionalAuthority?: ProviderAuthority,
): string | undefined {
	try {
		const raw = runTmux(
			["show-options", "-qv", "-t", normalizeExactTmuxTarget(sessionName, env, "option"), option],
			env,
			provisionalAuthority,
		).trim();
		if (!raw) return undefined;
		// tmux returns just the value; psmux returns `key value` (or `key "value with space"` for
		// @gjc-branch etc.). On psmux, parse the last token and strip any
		// surrounding double quotes so both shapes resolve to the same value.
		if (resolveGjcTmuxBinary({ env }).isPsmux) {
			// Prefer the last whitespace-separated token. If the value is
			// quoted, find the matching close-quote and slice.
			const lastQuote = raw.lastIndexOf('"');
			if (lastQuote > 0 && raw[lastQuote - 1] !== "\\") {
				const firstQuote = raw.lastIndexOf('"', lastQuote - 1);
				if (firstQuote > 0) return raw.slice(firstQuote + 1, lastQuote);
			}
			const tokens = raw.split(/\s+/).filter(Boolean);
			return tokens[tokens.length - 1];
		}
		return raw;
	} catch {
		return undefined;
	}
}
function readCreatedTmuxMetadataOption(
	nativeSessionId: string,
	option: string,
	env: NodeJS.ProcessEnv,
	provisionalAuthority?: ProviderAuthority,
): string | undefined {
	try {
		const raw = runTmux(
			["show-options", "-qv", "-t", normalizeExactTmuxTarget(nativeSessionId, env, "option"), option],
			env,
			provisionalAuthority,
		).replace(/\r?\n$/, "");
		if (!raw) return undefined;
		if (!resolveGjcTmuxBinary({ env }).isPsmux) return raw;
		const prefix = `${option} `;
		if (!raw.startsWith(prefix)) return undefined;
		const value = raw.slice(prefix.length);
		if (value.startsWith('"') && value.endsWith('"')) return value.slice(1, -1);
		return value;
	} catch {
		return undefined;
	}
}

function createdTmuxMetadataMatches(
	nativeSessionId: string,
	metadata: {
		sessionId: string;
		sessionStateFile: string;
		ownerGeneration: string;
		ownerServerKey: string;
		version: string | null;
	},
	psmuxIncarnation: string | undefined,
	env: NodeJS.ProcessEnv,
	provisionalAuthority?: ProviderAuthority,
): boolean {
	const expected: Array<readonly [string, string]> = [
		[GJC_TMUX_PROFILE_OPTION, GJC_TMUX_PROFILE_VALUE],
		[GJC_TMUX_SESSION_ID_OPTION, metadata.sessionId],
		[GJC_TMUX_SESSION_STATE_FILE_OPTION, metadata.sessionStateFile],
		[GJC_TMUX_OWNER_GENERATION_OPTION, metadata.ownerGeneration],
		[GJC_TMUX_OWNER_SERVER_KEY_OPTION, metadata.ownerServerKey],
	];
	if (metadata.version) expected.push([GJC_TMUX_VERSION_OPTION, metadata.version]);
	if (psmuxIncarnation) expected.push([GJC_TMUX_PSMUX_INCARNATION_OPTION, psmuxIncarnation]);
	return expected.every(
		([option, intended]) =>
			readCreatedTmuxMetadataOption(nativeSessionId, option, env, provisionalAuthority) === intended,
	);
}

function readNativeTmuxSessionId(
	sessionTarget: string,
	env: NodeJS.ProcessEnv,
	provisionalAuthority?: ProviderAuthority,
): string | undefined {
	if (resolveGjcTmuxBinary({ env }).isPsmux) return sessionTarget;
	try {
		const sessionId = runTmux(
			["display-message", "-p", "-t", normalizeExactTmuxTarget(sessionTarget, env, "option"), "#{session_id}"],
			env,
			provisionalAuthority,
		).trim();
		return sessionId || undefined;
	} catch {
		return undefined;
	}
}

function isNativeTmuxSessionBoundToName(nativeSessionId: string, sessionName: string, env: NodeJS.ProcessEnv): boolean {
	try {
		return (
			runTmux(
				[
					"display-message",
					"-p",
					"-t",
					normalizeExactTmuxTarget(sessionName, env, "option"),
					"#{session_id}\t#{session_name}",
				],
				env,
			).trim() === `${nativeSessionId}\t${sessionName}`
		);
	} catch {
		return false;
	}
}

function hydrateSessionFromExactOptions(session: GjcTmuxSessionStatus, env: NodeJS.ProcessEnv): GjcTmuxSessionStatus {
	if (session.profile !== GJC_TMUX_PROFILE_VALUE) {
		const profile = readExactOptionForGc(session.name, GJC_TMUX_PROFILE_OPTION, env);
		if (profile !== GJC_TMUX_PROFILE_VALUE) return session;
		session = { ...session, profile };
	}
	return {
		...session,
		branch: session.branch ?? readExactOptionForGc(session.name, GJC_TMUX_BRANCH_OPTION, env),
		branchSlug: session.branchSlug ?? readExactOptionForGc(session.name, GJC_TMUX_BRANCH_SLUG_OPTION, env),
		project: session.project ?? readExactOptionForGc(session.name, GJC_TMUX_PROJECT_OPTION, env),
		sessionId: session.sessionId ?? readExactOptionForGc(session.name, GJC_TMUX_SESSION_ID_OPTION, env),
		sessionStateFile:
			session.sessionStateFile ?? readExactOptionForGc(session.name, GJC_TMUX_SESSION_STATE_FILE_OPTION, env),
		ownerGeneration:
			session.ownerGeneration ?? readExactOptionForGc(session.name, GJC_TMUX_OWNER_GENERATION_OPTION, env),
		version: session.version ?? readExactOptionForGc(session.name, GJC_TMUX_VERSION_OPTION, env),
		psmuxIncarnation:
			session.psmuxIncarnation ?? readExactOptionForGc(session.name, GJC_TMUX_PSMUX_INCARNATION_OPTION, env),
		nativeSessionId: session.nativeSessionId ?? readNativeTmuxSessionId(session.name, env),
	};
}

/** @internal */
export function readTmuxSessionTagsForGc(
	sessionName: string,
	env: NodeJS.ProcessEnv = process.env,
): GjcTmuxSessionTagsForGc {
	assertSafeGjcTmuxSessionName(sessionName);
	const session = listGjcTmuxSessions(env).find(candidate => candidate.name === sessionName);
	const sessionEnv = session ? (effectiveSessionEnvironments.get(session) ?? env) : env;
	return {
		profile: readExactOptionForGc(sessionName, GJC_TMUX_PROFILE_OPTION, sessionEnv),
		project: readExactOptionForGc(sessionName, GJC_TMUX_PROJECT_OPTION, sessionEnv),
		psmuxIncarnation: readExactOptionForGc(sessionName, GJC_TMUX_PSMUX_INCARNATION_OPTION, sessionEnv),
		branch: readExactOptionForGc(sessionName, GJC_TMUX_BRANCH_OPTION, sessionEnv),
		branchSlug: readExactOptionForGc(sessionName, GJC_TMUX_BRANCH_SLUG_OPTION, sessionEnv),
		sessionId: readExactOptionForGc(sessionName, GJC_TMUX_SESSION_ID_OPTION, sessionEnv),
		sessionStateFile: readExactOptionForGc(sessionName, GJC_TMUX_SESSION_STATE_FILE_OPTION, sessionEnv),
		version: readExactOptionForGc(sessionName, GJC_TMUX_VERSION_OPTION, sessionEnv),
		ownerGeneration: readExactOptionForGc(sessionName, GJC_TMUX_OWNER_GENERATION_OPTION, sessionEnv),
		nativeSessionId: session?.nativeSessionId ?? readNativeTmuxSessionId(sessionName, sessionEnv),
		createdAt: session?.createdAt,
		attached: session?.attached,
		panePids: session?.panePids,
	};
}

export function removeGjcTmuxSession(
	sessionName: string,
	env: NodeJS.ProcessEnv = process.env,
	expectedIdentity?: ExpectedGjcTmuxSessionIdentity,
): GjcTmuxSessionStatus {
	assertSafeGjcTmuxSessionName(sessionName);
	const session = statusGjcTmuxSession(sessionName, env);
	assertMutationAuthority(session);
	if (session.providerAuthority?.kind === "windows-psmux" && !session.psmuxIncarnation)
		throw new Error(`gjc_tmux_owner_unverifiable:${sessionName}`);
	const sessionEnv =
		effectiveSessionEnvironments.get(session) ?? environmentForProviderAuthority(env, session.providerAuthority);
	if (session.attached || session.panePids.length > 0) {
		throw new Error(`gjc_tmux_session_live:${sessionName}`);
	}
	if (
		expectedIdentity &&
		(session.nativeSessionId !== expectedIdentity.nativeSessionId ||
			session.psmuxIncarnation !== expectedIdentity.psmuxIncarnation ||
			session.ownerGeneration !== expectedIdentity.ownerGeneration ||
			session.sessionId !== expectedIdentity.sessionId ||
			session.sessionStateFile !== expectedIdentity.sessionStateFile ||
			session.project !== expectedIdentity.project ||
			session.createdAt !== expectedIdentity.createdAt)
	)
		throw new Error(`gjc_tmux_owner_changed:${sessionName}`);
	if (readProfileForExactTarget(session.name, sessionEnv) !== GJC_TMUX_PROFILE_VALUE) {
		throw new Error(`gjc_tmux_session_not_managed:${sessionName}`);
	}
	const nativeSessionId = readNativeTmuxSessionId(session.name, sessionEnv);
	if (!nativeSessionId) throw new Error(`gjc_tmux_owner_unverifiable:${sessionName}`);
	if (expectedIdentity && nativeSessionId !== expectedIdentity.nativeSessionId)
		throw new Error(`gjc_tmux_owner_changed:${sessionName}`);
	if (
		expectedIdentity &&
		readExactOptionForGc(session.name, GJC_TMUX_OWNER_GENERATION_OPTION, sessionEnv) !==
			expectedIdentity.ownerGeneration
	)
		throw new Error(`gjc_tmux_owner_changed:${sessionName}`);
	const firstServer = requireSafeTmuxServerForMutation(resolveGjcTmuxCommand(sessionEnv), sessionEnv);
	if (
		readNativeTmuxSessionId(nativeSessionId, sessionEnv) !== nativeSessionId ||
		readProfileForExactTarget(nativeSessionId, sessionEnv) !== GJC_TMUX_PROFILE_VALUE
	)
		throw new Error(`gjc_tmux_owner_changed:${sessionName}`);
	const finalServer = requireSafeTmuxServerForMutation(resolveGjcTmuxCommand(sessionEnv), sessionEnv);
	if (finalServer.pid !== firstServer.pid || finalServer.startTime !== firstServer.startTime)
		throw new Error(`gjc_tmux_owner_changed:${sessionName}`);
	runGuardedTmuxSessionCommand(
		nativeSessionId,
		session.name,
		finalServer,
		sessionEnv,
		`kill-session -t '${nativeSessionId}'`,
		expectedIdentity?.ownerGeneration ?? session.ownerGeneration,
		undefined,
		session.psmuxIncarnation,
	);
	return session;
}

async function readProcessStartTime(pid: number): Promise<string | null> {
	// `/proc/<pid>/stat` only exists on Linux. Everywhere else the natives
	// process reference carries the same kernel-derived start identity (macOS
	// reports `darwin:<start_tvsec>:<start_tvusec>` from the BSD proc info), and
	// callers only ever compare these values for equality against another value
	// produced here. Returning null off Linux made every owner-identity proof
	// unverifiable, so no session could be closed there.
	if (process.platform !== "linux") return nativeProcessBindings().Process.fromPid(pid)?.incarnation ?? null;
	return readLinuxProcStartTime(pid);
}

function exactManagedOwnerSupervisor(supervisorPid: number, supervisorStartTime: string): Process {
	const supervisor = nativeProcessBindings().Process.fromPid(supervisorPid);
	if (!supervisor) throw new Error("managed_owner_supervisor_unverifiable");
	const expectedIncarnation = process.platform === "linux" ? `linux:${supervisorStartTime}` : supervisorStartTime;
	if (supervisor.incarnation !== expectedIncarnation) throw new Error("managed_owner_supervisor_incarnation_mismatch");
	return supervisor;
}

/**
 * Deliver SIGTERM to exactly one already-proved owner PID.
 *
 * `Process.signalRoot` routes through the owned pidfd on Linux and the owned
 * process handle on Windows, so PID reuse cannot redirect the signal. macOS
 * has no equivalent kernel authority, so the native binding deliberately fails
 * closed there rather than falling back to a raw PID signal.
 */
function signalManagedOwnerTerm(supervisor: Process, pid: number): boolean {
	void pid;
	return supervisor.signalRoot(15);
}

async function readCurrentGeneration(stateDir: string, sessionId: string): Promise<string | null> {
	try {
		const file = path.join(stateDir, sessionId, "owner-lifecycle", "generation.json");
		const value: unknown = await readNoFollowJson(file);
		if (
			typeof value !== "object" ||
			value === null ||
			typeof (value as { generation?: unknown }).generation !== "string" ||
			!isValidGenerationRecord(value, sessionId, (value as { generation: string }).generation)
		)
			return null;
		return (value as { generation: string }).generation;
	} catch {
		return null;
	}
}

async function resolveExactOwner(
	sessionName: string,
	env: NodeJS.ProcessEnv,
	exactPanePid: number,
): Promise<ExactOwnerIdentity> {
	const session = statusGjcTmuxSession(sessionName, env);
	const sessionId = readExactOptionForGc(session.name, GJC_TMUX_SESSION_ID_OPTION, env);
	const stateFile = readExactOptionForGc(session.name, GJC_TMUX_SESSION_STATE_FILE_OPTION, env);
	const ownerGeneration = readExactOptionForGc(session.name, GJC_TMUX_OWNER_GENERATION_OPTION, env);
	const ownerServerKey = readExactOptionForGc(session.name, GJC_TMUX_OWNER_SERVER_KEY_OPTION, env);

	if (!sessionId || !stateFile) throw new Error(`gjc_tmux_owner_unverifiable:${sessionName}`);
	if (!path.isAbsolute(stateFile) || /[\u0000-\u001F\u007F]/u.test(stateFile))
		throw new Error(`gjc_tmux_owner_unverifiable:${sessionName}`);
	const stateDir = path.dirname(stateFile);
	if (!ownerGeneration) throw new Error(`gjc_tmux_owner_unverifiable:${sessionName}`);
	if (
		sessionId === "." ||
		sessionId === ".." ||
		ownerGeneration === "." ||
		ownerGeneration === ".." ||
		/[\u0000-\u001F\u007F/\\]/u.test(sessionId) ||
		/[\u0000-\u001F\u007F/\\]/u.test(ownerGeneration)
	)
		throw new Error(`gjc_tmux_owner_unverifiable:${sessionName}`);
	let generation: string | null;
	try {
		generation = await readCurrentGeneration(stateDir, sessionId);
	} catch (error) {
		if (error instanceof Error && error.message === "owner_lifecycle_path_unsafe")
			throw new Error(`gjc_tmux_owner_isolation_scope_bootstrap_failed:${sessionName}`);
		throw error;
	}
	const pid = exactPanePid;
	const startTime = await readProcessStartTime(pid);
	if (!generation || ownerGeneration !== generation || !ownerServerKey || !startTime)
		throw new Error(`gjc_tmux_owner_unverifiable:${sessionName}`);

	return {
		sessionId,
		stateDir,
		socketKey: ownerServerKey,
		generation,
		pid,
		startTime,
	};
}

async function requireUnchangedOwnerForCompatibilityCleanup(
	sessionName: string,
	nativeSessionId: string,
	env: NodeJS.ProcessEnv,
	identity: ExactOwnerIdentity,
	initialStateFile: string,
	initialServer: { pid: number; startTime: string },
	initialPsmuxIncarnation: string | undefined,
	listPanePids: (sessionName: string, env: NodeJS.ProcessEnv) => number[],
	readStartTime: (pid: number) => Promise<string | null>,
): Promise<boolean> {
	try {
		const currentNativeSessionId = readNativeTmuxSessionId(nativeSessionId, env);
		if (!currentNativeSessionId) {
			if (readNativeTmuxSessionId(sessionName, env)) throw new Error(`gjc_tmux_owner_changed:${sessionName}`);
			return false;
		}
		const currentServer = requireSafeTmuxServerForMutation(resolveGjcTmuxCommand(env), env);
		const panePids = listPanePids(nativeSessionId, env);
		let currentPaneStartTime: string | null;
		try {
			currentPaneStartTime = await readStartTime(identity.pid);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
			currentPaneStartTime = null;
		}
		const mismatches = [
			currentServer.pid !== initialServer.pid ? "server_pid" : null,
			currentServer.startTime !== initialServer.startTime ? "server_start" : null,
			currentNativeSessionId !== nativeSessionId ? "native_id" : null,
			readProfileForExactTarget(nativeSessionId, env) !== GJC_TMUX_PROFILE_VALUE ? "profile" : null,
			panePids.length > 1 ? "pane_count" : null,
			panePids.length === 1 && panePids[0] !== identity.pid ? "pane_pid" : null,
			currentPaneStartTime !== null && currentPaneStartTime !== identity.startTime ? "pane_start" : null,
			readExactOptionForGc(nativeSessionId, GJC_TMUX_SESSION_ID_OPTION, env) !== identity.sessionId
				? "session_id"
				: null,
			readExactOptionForGc(nativeSessionId, GJC_TMUX_SESSION_STATE_FILE_OPTION, env) !== initialStateFile
				? "state_file"
				: null,
			readExactOptionForGc(nativeSessionId, GJC_TMUX_OWNER_GENERATION_OPTION, env) !== identity.generation
				? "generation"
				: null,
			readExactOptionForGc(nativeSessionId, GJC_TMUX_OWNER_SERVER_KEY_OPTION, env) !== identity.socketKey
				? "server_key"
				: null,
			initialPsmuxIncarnation !== undefined &&
			readExactOptionForGc(nativeSessionId, GJC_TMUX_PSMUX_INCARNATION_OPTION, env) !== initialPsmuxIncarnation
				? "psmux_incarnation"
				: null,
		].filter((value): value is string => value !== null);
		if (mismatches.length > 0) throw new Error(`gjc_tmux_owner_changed:${sessionName}:${mismatches.join(",")}`);
		return true;
	} catch (error) {
		if (!readNativeTmuxSessionId(nativeSessionId, env)) {
			if (readNativeTmuxSessionId(sessionName, env)) throw new Error(`gjc_tmux_owner_changed:${sessionName}`);
			return false;
		}
		if (error instanceof Error && error.message.startsWith(`gjc_tmux_owner_changed:${sessionName}`))
			throw new Error(`gjc_tmux_owner_changed:${sessionName}`);
		throw new Error(`gjc_tmux_owner_changed:${sessionName}`);
	}
}

async function waitForOwnerVerdictUntil(
	verdict: Promise<OwnerVerdict>,
	now: () => Date,
	deadline: number,
): Promise<OwnerVerdict> {
	const remainingMs = deadline - now().getTime();
	if (remainingMs <= 0) throw new Error("owner_term_verdict_timeout");
	const timeout = Promise.withResolvers<never>();
	const timer = setTimeout(() => timeout.reject(new Error("owner_term_verdict_timeout")), remainingMs);
	try {
		return await Promise.race([verdict, timeout.promise]);
	} finally {
		clearTimeout(timer);
	}
}

async function waitForExpectedVerdict(
	identity: ExactOwnerIdentity,
	sleep: (ms: number) => Promise<void>,
	now: () => Date,
	deadline: number,
): Promise<OwnerVerdict | null> {
	const paths = lifecyclePaths(identity.stateDir, identity.sessionId, identity.generation);
	const verdictFile = paths.verdictFile;
	const verdictAliasFile = paths.verdictAliasFile;
	while (now().getTime() <= deadline) {
		try {
			const [verdictBody, aliasBody] = await Promise.all([
				readNoFollowJson(verdictFile),
				readNoFollowJson(verdictAliasFile),
			]);
			const verdict: unknown = verdictBody;
			const alias: unknown = aliasBody;
			if (
				isValidOwnerVerdict(verdict) &&
				typeof alias === "object" &&
				alias !== null &&
				Object.keys(alias).length === Object.keys(verdict).length + 1 &&
				Object.keys(alias).every(key => key === "owner_generation" || Object.hasOwn(verdict, key)) &&
				(alias as Record<string, unknown>).owner_generation === identity.generation &&
				Object.entries(verdict).every(
					([key, value]) => Object.hasOwn(alias, key) && (alias as Record<string, unknown>)[key] === value,
				) &&
				verdict.generation === identity.generation &&
				verdict.session_id === identity.sessionId &&
				verdict.server_key === identity.socketKey &&
				verdict.signal === "SIGTERM" &&
				verdict.result === "owner_term_then_session_cleanup" &&
				verdict.classification === "expected_operator_shutdown"
			)
				return verdict;
		} catch {}
		await sleep(FORCE_CLOSE_VERDICT_POLL_MS);
	}
	return null;
}

/**
 * Requests an exact tagged owner shutdown. Session cleanup is compatibility-only
 * and follows a validated SIGTERM verdict; it never authorizes the close.
 */
export async function forceCloseGjcTmuxSession(
	sessionName: string,
	env: NodeJS.ProcessEnv = process.env,
	expectedSessionId?: string,
	expectedStateFile?: string,
	deps: Partial<ForceCloseOwnerDependencies> = {},
): Promise<GjcTmuxSessionStatus> {
	assertSafeGjcTmuxSessionName(sessionName);
	if (deps.expectedManagedProof && verifyManagedGjcTmuxSession(deps.expectedManagedProof, env) !== "verified")
		throw new Error(`gjc_tmux_owner_changed:${sessionName}`);
	const session = statusGjcTmuxSession(sessionName, env);
	assertMutationAuthority(session);
	const sessionEnv =
		effectiveSessionEnvironments.get(session) ?? environmentForProviderAuthority(env, session.providerAuthority);
	if (readProfileForExactTarget(session.name, sessionEnv) !== GJC_TMUX_PROFILE_VALUE)
		throw new Error(`gjc_tmux_session_not_managed:${sessionName}`);
	const exactPanePids = (deps.listPanePids ?? readExactSessionPanePids)(session.name, sessionEnv);
	if (exactPanePids.length !== 1) throw new Error(`gjc_tmux_owner_unverifiable:${sessionName}`);
	const actualSessionId = readExactOptionForGc(session.name, GJC_TMUX_SESSION_ID_OPTION, sessionEnv);
	const actualStateFile = readExactOptionForGc(session.name, GJC_TMUX_SESSION_STATE_FILE_OPTION, sessionEnv);
	const actualGeneration = readExactOptionForGc(session.name, GJC_TMUX_OWNER_GENERATION_OPTION, sessionEnv);
	const actualServerKey = readExactOptionForGc(session.name, GJC_TMUX_OWNER_SERVER_KEY_OPTION, sessionEnv);
	const isPsmux = resolveGjcTmuxBinary({ env: sessionEnv }).isPsmux;
	const initialPsmuxIncarnation = isPsmux
		? readExactOptionForGc(session.name, GJC_TMUX_PSMUX_INCARNATION_OPTION, sessionEnv)
		: undefined;
	if (expectedSessionId !== undefined && actualSessionId !== expectedSessionId)
		throw new Error(`gjc_tmux_session_id_mismatch:${sessionName}`);
	if (expectedStateFile !== undefined && actualStateFile !== expectedStateFile)
		throw new Error(`gjc_tmux_session_state_file_mismatch:${sessionName}`);
	if (
		!actualSessionId ||
		!actualStateFile ||
		!actualGeneration ||
		!actualServerKey ||
		(isPsmux && !initialPsmuxIncarnation)
	)
		throw new Error(`gjc_tmux_owner_unverifiable:${sessionName}`);
	const nativeSessionId = readNativeTmuxSessionId(session.name, sessionEnv);
	if (!nativeSessionId) throw new Error(`gjc_tmux_owner_unverifiable:${sessionName}`);

	const resolveOwner =
		deps.resolveOwner ?? ((name, targetEnv) => resolveExactOwner(name, targetEnv, exactPanePids[0]!));
	const identity = await resolveOwner(session.name, sessionEnv);
	if (identity.pid !== exactPanePids[0]) throw new Error(`gjc_tmux_owner_identity_mismatch:${sessionName}`);
	if (identity.sessionId !== actualSessionId || identity.stateDir !== path.dirname(actualStateFile))
		throw new Error(`gjc_tmux_owner_identity_mismatch:${sessionName}`);
	if (identity.generation !== actualGeneration) throw new Error(`gjc_tmux_owner_generation_mismatch:${sessionName}`);
	if (identity.socketKey !== actualServerKey) throw new Error(`gjc_tmux_owner_server_key_mismatch:${sessionName}`);
	const initialServer = requireSafeTmuxServerForMutation(resolveGjcTmuxCommand(sessionEnv), sessionEnv);

	const currentStartTime = await (deps.readProcessStartTime ?? readProcessStartTime)(identity.pid);
	if (currentStartTime !== identity.startTime) throw new Error("owner_pid_identity_mismatch");
	const now = deps.now ?? (() => new Date());
	const sleep = deps.sleep ?? (ms => Bun.sleep(ms));
	const dispatchId = crypto.randomUUID();
	const verdictDeadline = now().getTime() + FORCE_CLOSE_VERDICT_TIMEOUT_MS;
	let operatorVerdict: Promise<OwnerVerdict> | null = deps.waitForOwnerExitVerdict?.() ?? null;
	await closeExactTmuxOwner(
		{
			stateDir: identity.stateDir,
			sessionId: identity.sessionId,
			generation: identity.generation,
			serverKey: identity.socketKey,
			pid: identity.pid,
			startTime: identity.startTime,
			dispatchId,
			createdAt: now().toISOString(),
			expiresAt: new Date(verdictDeadline).toISOString(),
		},
		{
			readStartTime: deps.readProcessStartTime ?? readProcessStartTime,
			sendSigterm: async (pid, intent) => {
				if ((await (deps.readProcessStartTime ?? readProcessStartTime)(pid)) !== identity.startTime)
					throw new Error("owner_pid_identity_mismatch");
				if (deps.signalTerm) {
					deps.signalTerm(pid);
				} else {
					const supervisor = exactManagedOwnerSupervisor(pid, identity.startTime);
					if (!signalManagedOwnerTerm(supervisor, pid)) throw new Error("managed_owner_supervisor_signal_failed");
					operatorVerdict = supervisor
						.waitForExit({ timeoutMs: FORCE_CLOSE_VERDICT_TIMEOUT_MS - 500 })
						.then(async exited => {
							if (!exited) throw new Error("managed_owner_supervisor_exit_timeout");
							return await observeOwnerTerminal({
								schema_version: 1,
								op: "observe_terminal",
								session_id: identity.sessionId,
								owner_generation: identity.generation,
								state_dir: identity.stateDir,
								socket_key: identity.socketKey,
								observer: "raw_monitor",
								observed_at: now().toISOString(),
								signal: "SIGTERM",
								exit_code: null,
								exit_kind: "exact_owner_exit_observed",
								reason: "operator_observed_owner_exit",
								operator_dispatch_id: dispatchId,
								operator_intent_id: intent.intent_id,
							});
						});
				}
			},

			waitForVerdict: async () => {
				if (!operatorVerdict) return await waitForExpectedVerdict(identity, sleep, now, verdictDeadline);
				try {
					return await waitForOwnerVerdictUntil(operatorVerdict, now, verdictDeadline);
				} catch {
					// The sidecar and raw monitor intentionally race to publish the first valid
					// verdict. If the exact supervisor-exit path loses that race or times out
					// under load, recover only from the same fully validated durable evidence.
					return await waitForExpectedVerdict(identity, sleep, now, verdictDeadline);
				}
			},
			cleanupSession: async () => {
				const cleanupRequired = await requireUnchangedOwnerForCompatibilityCleanup(
					session.name,
					nativeSessionId,
					sessionEnv,
					identity,
					actualStateFile,
					initialServer,
					initialPsmuxIncarnation,
					deps.listPanePids ?? readExactSessionPanePids,
					deps.readProcessStartTime ?? readProcessStartTime,
				);
				if (!cleanupRequired) return;
				if (deps.cleanupSession) deps.cleanupSession(nativeSessionId, sessionEnv);
				else
					runGuardedTmuxSessionCommand(
						nativeSessionId,
						session.name,
						initialServer,
						sessionEnv,
						`kill-session -t '${nativeSessionId}'`,
						identity.generation,
						session.providerAuthority,
						initialPsmuxIncarnation,
					);
			},
		},
	);
	return session;
}

export function attachGjcTmuxSession(sessionName: string, env: NodeJS.ProcessEnv = process.env): never {
	assertSafeGjcTmuxSessionName(sessionName);
	const session = statusGjcTmuxSession(sessionName, env);
	assertMutationAuthority(session);
	const sessionEnv =
		effectiveSessionEnvironments.get(session) ?? environmentForProviderAuthority(env, session.providerAuthority);
	const authority = session.providerAuthority ?? psmuxAuthorityFromEnv(sessionEnv);
	const tmuxCommand = authority?.command ?? resolveGjcTmuxCommand(sessionEnv);
	if (authority) assertGjcTmuxMutationAuthoritySync(authority);
	requireSafeTmuxServerForMutation(tmuxCommand, sessionEnv);
	const result = Bun.spawnSync(
		[
			tmuxCommand,
			...(authority
				? buildTmuxProviderCommand(authority, "attach-session", [
						"-t",
						buildGjcTmuxExactSessionTarget(session.name, { binary: authority.binary }),
					])
				: ["attach-session", "-t", buildGjcTmuxExactSessionTarget(session.name, { env: sessionEnv })]),
		],
		{ stdin: "inherit", stdout: "inherit", stderr: "inherit", env: sessionEnv },
	);
	if (authority) assertGjcTmuxMutationAuthoritySync(authority);
	if (result.exitCode !== 0) throw new Error(`gjc_tmux_attach_failed:${sessionName}`);
	process.exit(0);
}
