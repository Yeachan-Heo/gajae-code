import { Buffer } from "node:buffer";
import * as crypto from "node:crypto";
import * as fsSync from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { readLinuxProcStartTime, readLinuxProcStartTimeSync } from "./linux-proc";
import { resolveGjcTmuxBinary } from "./psmux-detect";
import { tmuxRuntimeSessionPath } from "./session-layout";
import {
	GJC_COORDINATOR_SESSION_ID_ENV,
	GJC_COORDINATOR_SESSION_STATE_FILE_ENV,
	GJC_TMUX_OWNER_GENERATION_ENV,
	GJC_TMUX_OWNER_SERVER_KEY_ENV,
	GJC_TMUX_OWNER_STATE_DIR_ENV,
} from "./session-state-sidecar";
import {
	buildGjcTmuxExactOptionTarget,
	buildGjcTmuxExactSessionTarget,
	buildGjcTmuxProfileCommands,
	buildGjcTmuxSessionName,
	buildGjcTmuxSessionSlug,
	buildGjcTmuxUntaggedSessionError,
	GJC_TMUX_BRANCH_OPTION,
	GJC_TMUX_BRANCH_SLUG_OPTION,
	GJC_TMUX_OWNER_GENERATION_OPTION,
	GJC_TMUX_OWNER_SERVER_KEY_OPTION,
	GJC_TMUX_PROFILE_OPTION,
	GJC_TMUX_PROFILE_VALUE,
	GJC_TMUX_PROJECT_OPTION,
	GJC_TMUX_SESSION_ID_OPTION,
	GJC_TMUX_SESSION_STATE_FILE_OPTION,
	GJC_TMUX_VERSION_OPTION,
	normalizeTmuxCreatedAt,
	resolveGjcTmuxCommand,
} from "./tmux-common";
import {
	captureOwnerGenerationBaselineSync,
	classifyCgroup,
	closeExactTmuxOwner,
	executeTmuxOwnerIsolationPlanSync,
	isOwnerGenerationBaselineCurrentSync,
	isValidOwnerVerdict,
	lifecyclePaths,
	type OwnerIsolationProbeSync,
	type OwnerVerdict,
	type PlanResponse,
	planTmuxOwnerIsolationSync,
	replaceOwnerGenerationSync,
	type TmuxOwnerIsolationExecutionDependencies,
	type TmuxOwnerIsolationExecutionResult,
	type TmuxServerProof,
} from "./tmux-owner-isolation";
import { buildWindowsPowerShellInnerCommand } from "./windows-powershell-command";

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
}

export interface ExpectedGjcTmuxSessionIdentity {
	nativeSessionId: string;
	ownerGeneration: string;
	sessionId: string;
	sessionStateFile: string;
	project: string;
	createdAt: string;
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
}

const FORCE_CLOSE_VERDICT_TIMEOUT_MS = 5_000;
const FORCE_CLOSE_VERDICT_POLL_MS = 50;

export interface CreateGjcTmuxSessionOptions {
	platform?: NodeJS.Platform;
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

function runTmux(args: string[], env: NodeJS.ProcessEnv = process.env): string {
	const tmuxCommand = resolveGjcTmuxCommand(env);
	const result = Bun.spawnSync([tmuxCommand, ...args], {
		stdout: "pipe",
		stderr: "pipe",
		env,
	});
	if (result.exitCode === 0) return result.stdout.toString();
	throw new Error(result.stderr.toString().trim() || `tmux ${args.join(" ")} failed`);
}
function normalizeExactTmuxTarget(sessionTarget: string, env: NodeJS.ProcessEnv, kind: "session" | "option"): string {
	if (sessionTarget.startsWith("$")) return sessionTarget;
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
		nativeSessionId = "",
	] = line.split("\t");

	if (!name) return null;
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
		nativeSessionId: nativeSessionId || undefined,
	};
}

function runListSessions(format: string, env: NodeJS.ProcessEnv = process.env): string[] {
	let output = "";
	try {
		output = runTmux(["list-sessions", "-F", format], env);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		if (
			message.includes("no server running") ||
			message.includes("failed to connect to server") ||
			message.includes("error connecting to")
		) {
			return [];
		}
		throw error;
	}
	const lines = output
		.split("\n")
		.map(line => line.trim())
		.filter(Boolean);
	// psmux 3.3.0 silently ignores the tmux `-F` format flag and returns its
	// default `name: N windows (created ...)` shape. Detect that case and
	// synthesize a tab-separated row so downstream parseSessionLine /
	// hydrateSessionFromExactOptions can recover the @gjc-* ownership tags
	// via follow-up show-options calls. Without this fallback gjc session
	// list / status return an empty list on psmux even when sessions exist.
	if (lines.length > 0 && !lines[0].includes("\t")) {
		const binary = resolveGjcTmuxBinary({ env });
		if (binary.isPsmux) {
			return lines.map(line => {
				const match = line.match(/^([^:]+):\s*(\d+)\s+windows?\s+\(created\s+([^)]+)\)/);
				if (!match) return line;
				const [, name, windows, created] = match;
				const createdEpoch = String(Math.floor(new Date(`${created} UTC`).getTime() / 1000) || 0);

				return [name, windows, "0", createdEpoch, "", "", "0", "", "", "", "", "", "", "", "", ""].join("\t");
			});
		}
	}
	return lines;
}

function listSessionLines(env: NodeJS.ProcessEnv = process.env): string[] {
	return runListSessions(
		`#{session_name}\t#{session_windows}\t#{session_attached}\t#{session_created}\t#{${GJC_TMUX_PROFILE_OPTION}}\t#{session_key_table}\t#{session_panes}\t#{pane_pid}\t#{${GJC_TMUX_BRANCH_OPTION}}\t#{${GJC_TMUX_BRANCH_SLUG_OPTION}}\t#{${GJC_TMUX_PROJECT_OPTION}}\t#{${GJC_TMUX_SESSION_ID_OPTION}}\t#{${GJC_TMUX_SESSION_STATE_FILE_OPTION}}\t#{${GJC_TMUX_OWNER_GENERATION_OPTION}}\t#{${GJC_TMUX_VERSION_OPTION}}\t#{session_id}`,

		env,
	);
}

function listRawTmuxSessionNames(env: NodeJS.ProcessEnv = process.env): string[] {
	return runListSessions("#{session_name}", env).map(line => line.split("\t")[0] ?? line);
}

export function listGjcTmuxSessions(env: NodeJS.ProcessEnv = process.env): GjcTmuxSessionStatus[] {
	return listSessionLines(env)
		.map(parseSessionLine)
		.filter((session): session is GjcTmuxSessionStatus => session != null)
		.map(session => hydrateSessionFromExactOptions(session, env))
		.filter((session): session is GjcTmuxSessionStatus => session?.profile === GJC_TMUX_PROFILE_VALUE)
		.sort((a, b) => a.name.localeCompare(b.name));
}

/** @internal */
export function listTmuxSessionsForGc(env: NodeJS.ProcessEnv = process.env): GjcTmuxSessionsForGc {
	const sessions = listSessionLines(env)
		.map(parseSessionLine)
		.filter((session): session is GjcTmuxSessionStatus => session != null)
		.map(session => hydrateSessionFromExactOptions(session, env));
	const tagged = sessions
		.filter(session => session.profile === GJC_TMUX_PROFILE_VALUE)
		.sort((a, b) => a.name.localeCompare(b.name));
	const taggedNames = new Set(tagged.map(session => session.name));
	const byName = new Map(sessions.map(session => [session.name, session]));
	const untagged = listRawTmuxSessionNames(env)
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
	const platform = options.platform ?? process.platform;
	const tmuxCommand = resolveGjcTmuxCommand(env, platform);
	const sessionName = buildGjcTmuxSessionName(env);
	const cwd = process.cwd();
	const sessionId = env[GJC_COORDINATOR_SESSION_ID_ENV]?.trim() || sessionName;
	const stateFile =
		env[GJC_COORDINATOR_SESSION_STATE_FILE_ENV]?.trim() ||
		tmuxRuntimeSessionPath(cwd, env.GJC_SESSION_ID?.trim() || sessionId, buildGjcTmuxSessionSlug(sessionName));
	const stateDir = (platform === "win32" ? path.win32 : path).dirname(stateFile);
	const generation = crypto.randomUUID();
	const childEnvironment: Record<string, string> = {
		GJC_TMUX_LAUNCHED: "1",
		[GJC_TMUX_OWNER_GENERATION_ENV]: generation,
		[GJC_TMUX_OWNER_STATE_DIR_ENV]: stateDir,
		[GJC_TMUX_OWNER_SERVER_KEY_ENV]: tmuxCommand,
		[GJC_COORDINATOR_SESSION_ID_ENV]: sessionId,
		[GJC_COORDINATOR_SESSION_STATE_FILE_ENV]: stateFile,
	};
	const shellQuote = (value: string): string => `'${value.replace(/'/g, `'\\''`)}'`;
	const command =
		platform === "win32"
			? buildWindowsPowerShellInnerCommand({ command: ["gjc"], environment: childEnvironment })
			: `exec env ${Object.entries(childEnvironment)
					.map(([name, value]) => `${name}=${shellQuote(value)}`)
					.join(" ")} gjc`;
	const tmuxArgv = [
		tmuxCommand,
		"new-session",
		"-d",
		"-s",
		sessionName,
		...(platform === "win32" ? [] : ["-P", "-F", "#{session_id}"]),
		command,
	];
	function probeTmuxServer(tmuxCommand: string, env: NodeJS.ProcessEnv): TmuxServerProof {
		if (platform !== "linux") {
			return {
				state: "safe",
				pid: 1,
				startTime: "not-applicable",
				cgroup: { classification: "not_applicable" },
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

	const probeServer = () => probeTmuxServer(tmuxCommand, env);

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
	if (resolveGjcTmuxBinary({ env, platform }).isPsmux)
		throw new Error("gjc_tmux_owner_isolation_native_session_identity_unavailable");

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

	const outcome = (createOwnerIsolationTestDependencies?.execute ?? executeTmuxOwnerIsolationPlanSync)(ownerPlan, {
		socketKey: tmuxCommand,
		spawn: (argv, stdinLine) => {
			const result = stdinLine
				? Bun.spawnSync(argv, {
						stdout: "pipe",
						stderr: "pipe",
						stdin: Buffer.from(stdinLine),
						env,
					})
				: Bun.spawnSync(argv, { stdout: "pipe", stderr: "pipe", env });
			return { exitCode: result.exitCode, stdout: result.stdout.toString() };
		},
		probeServer: ownerProbe.probeServer,
		isCurrentGeneration: () => isOwnerGenerationBaselineCurrentSync(stateDir, sessionId, baseline),
		cleanupSpawned: ({ execution, nativeSessionId, server }) => {
			if (!server.pid || !server.startTime) throw new Error("gjc_tmux_cleanup_target_changed");
			cleanupExactCreatedTmuxSession(
				nativeSessionId,
				execution.attempt_session,
				tmuxCommand,
				env,
				server.pid,
				server.startTime,
			);
		},
	});
	if (!outcome.ok) throw new Error(`gjc_tmux_owner_isolation_${outcome.code}:${outcome.diagnostic}`);

	const nativeSessionId = outcome.native_session_id;
	if (!nativeSessionId) throw new Error("gjc_tmux_owner_isolation_native_session_identity_unavailable");
	const server = requireSafeTmuxServerForMutation(tmuxCommand, env);
	if (server.pid !== outcome.server_pid || server.startTime !== outcome.server_start_time)
		throw new Error("gjc_tmux_owner_changed_after_create");
	if (!isNativeTmuxSessionBoundToName(nativeSessionId, sessionName, env))
		throw new Error("gjc_tmux_owner_changed_after_create");

	try {
		tagCreatedTmuxSession(
			nativeSessionId,
			sessionName,
			outcome.server_pid,
			env,
			{
				sessionId,
				sessionStateFile: stateFile,
				ownerGeneration: generation,
				ownerServerKey: tmuxCommand,
				version: env.npm_package_version ?? null,
			},
			tmuxCommand,
		);
	} catch (tagError) {
		try {
			cleanupExactCreatedTmuxSession(
				nativeSessionId,
				sessionName,
				tmuxCommand,
				env,
				outcome.server_pid,
				outcome.server_start_time,
			);
		} catch (cleanupError) {
			throw new AggregateError([tagError, cleanupError], "gjc_tmux_profile_tag_failed_cleanup_failed");
		}
		throw tagError;
	}

	if (nativeSessionId) {
		const firstServer = requireSafeTmuxServerForMutation(tmuxCommand, env);
		if (firstServer.pid !== outcome.server_pid || firstServer.startTime !== outcome.server_start_time)
			throw new Error("gjc_tmux_owner_changed_after_create");
		const status = statusGjcTmuxSessionByNativeId(nativeSessionId, env);
		const finalServer = requireSafeTmuxServerForMutation(tmuxCommand, env);
		if (finalServer.pid !== firstServer.pid || finalServer.startTime !== firstServer.startTime)
			throw new Error("gjc_tmux_owner_changed_after_create");
		try {
			replaceOwnerGenerationSync(stateDir, sessionId, generation, baseline);
		} catch (publicationError) {
			try {
				cleanupExactCreatedTmuxSession(
					nativeSessionId,
					sessionName,
					tmuxCommand,
					env,
					outcome.server_pid,
					outcome.server_start_time,
				);
			} catch (cleanupError) {
				throw new AggregateError(
					[publicationError, cleanupError],
					"gjc_tmux_owner_generation_publish_failed_cleanup_failed",
				);
			}
			throw publicationError;
		}
		return status;
	}
	try {
		replaceOwnerGenerationSync(stateDir, sessionId, generation, baseline);
	} catch (publicationError) {
		try {
			cleanupExactCreatedTmuxSession(
				nativeSessionId,
				sessionName,
				tmuxCommand,
				env,
				outcome.server_pid,
				outcome.server_start_time,
			);
		} catch (cleanupError) {
			throw new AggregateError(
				[publicationError, cleanupError],
				"gjc_tmux_owner_generation_publish_failed_cleanup_failed",
			);
		}
		throw publicationError;
	}
	return statusGjcTmuxSession(sessionName, env);
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

function guardedTmuxSessionPredicate(
	expectedPid: number,
	nativeSessionId: string,
	sessionName: string,
	expectedOwnerGeneration?: string,
): string {
	const ownerGenerationPredicate = expectedOwnerGeneration
		? `#{==:#{${GJC_TMUX_OWNER_GENERATION_OPTION}},${expectedOwnerGeneration}}`
		: "1";
	return `#{&&:#{==:#{pid},${expectedPid}},#{&&:#{==:#{session_id},${nativeSessionId}},#{&&:#{==:#{session_name},${sessionName}},${ownerGenerationPredicate}}}}`;
}

function runGuardedTmuxSessionCommand(
	nativeSessionId: string,
	sessionName: string,
	expectedPid: number,
	env: NodeJS.ProcessEnv,
	thenCommand: string,
	expectedOwnerGeneration?: string,
): void {
	const result = runTmux(
		[
			"if-shell",
			"-t",
			normalizeExactTmuxTarget(nativeSessionId, env, "session"),
			"-F",
			guardedTmuxSessionPredicate(expectedPid, nativeSessionId, sessionName, expectedOwnerGeneration),
			`${thenCommand} ; display-message -p __gjc_tmux_guarded_mutation_ok__`,
			"display-message -p __gjc_tmux_guarded_mutation_refused__",
		],
		env,
	).trim();
	if (result !== "__gjc_tmux_guarded_mutation_ok__") throw new Error("gjc_tmux_cleanup_target_changed");
}

function tagCreatedTmuxSession(
	nativeSessionId: string,
	sessionName: string,
	expectedPid: number,
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
): void {
	const target = `${nativeSessionId}:`;
	const commands = buildGjcTmuxProfileCommands(target, env, metadata, { tmuxCommand })
		.map(command => command.args.map(tmuxCommandArgument).join(" "))
		.join(" ; ");
	runGuardedTmuxSessionCommand(nativeSessionId, sessionName, expectedPid, env, commands);
}

function cleanupExactCreatedTmuxSession(
	nativeSessionId: string,
	sessionName: string,
	tmuxCommand: string,
	env: NodeJS.ProcessEnv,
	expectedPid: number,
	expectedStartTime: string,
): void {
	const server = requireSafeTmuxServerForMutation(tmuxCommand, env);
	if (server.pid !== expectedPid || server.startTime !== expectedStartTime)
		throw new Error("gjc_tmux_cleanup_target_changed");
	runGuardedTmuxSessionCommand(
		nativeSessionId,
		sessionName,
		expectedPid,
		env,
		`kill-session -t ${tmuxCommandArgument(normalizeExactTmuxTarget(nativeSessionId, env, "session"))}`,
	);
}

function requireSafeTmuxServerForMutation(
	tmuxCommand: string,
	env: NodeJS.ProcessEnv,
): { pid: number; startTime: string } {
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
	if (process.platform !== "linux") return { pid: 1, startTime: "not-applicable" };
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
): ProvenTmuxSessionIdentity {
	const session = statusGjcTmuxSession(sessionName, env);
	if (readProfileForExactTarget(session.name, env) !== GJC_TMUX_PROFILE_VALUE)
		throw new Error(`gjc_tmux_session_not_managed:${sessionName}`);
	const firstServer = requireSafeTmuxServerForMutation(resolveGjcTmuxCommand(env), env);
	if (resolveGjcTmuxBinary({ env }).isPsmux) throw new Error(`gjc_tmux_owner_unverifiable:${sessionName}`);
	const nativeSessionId = readNativeTmuxSessionId(session.name, env);
	if (!nativeSessionId) throw new Error(`gjc_tmux_owner_unverifiable:${sessionName}`);
	if (
		readNativeTmuxSessionId(nativeSessionId, env) !== nativeSessionId ||
		readProfileForExactTarget(nativeSessionId, env) !== GJC_TMUX_PROFILE_VALUE
	)
		throw new Error(`gjc_tmux_owner_changed:${sessionName}`);
	const finalServer = requireSafeTmuxServerForMutation(resolveGjcTmuxCommand(env), env);
	if (finalServer.pid !== firstServer.pid || finalServer.startTime !== firstServer.startTime)
		throw new Error(`gjc_tmux_owner_changed:${sessionName}`);
	return {
		nativeSessionId,
		serverPid: finalServer.pid,
		serverStartTime: finalServer.startTime,
	};
}

function readProfileForExactTarget(sessionName: string, env: NodeJS.ProcessEnv): string {
	const raw = runTmux(
		["show-options", "-qv", "-t", normalizeExactTmuxTarget(sessionName, env, "option"), GJC_TMUX_PROFILE_OPTION],
		env,
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

function readExactOptionForGc(sessionName: string, option: string, env: NodeJS.ProcessEnv): string | undefined {
	try {
		const raw = runTmux(
			["show-options", "-qv", "-t", normalizeExactTmuxTarget(sessionName, env, "option"), option],
			env,
		).trim();
		if (!raw) return undefined;
		// tmux returns just the option value (e.g. `1` for @gjc-profile).
		// psmux 3.3.0 returns `key value` (or `key "value with space"` for
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

function readNativeTmuxSessionId(sessionTarget: string, env: NodeJS.ProcessEnv): string | undefined {
	if (resolveGjcTmuxBinary({ env }).isPsmux) return undefined;
	try {
		const sessionId = runTmux(
			["display-message", "-p", "-t", normalizeExactTmuxTarget(sessionTarget, env, "option"), "#{session_id}"],
			env,
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
	if (session.profile === GJC_TMUX_PROFILE_VALUE) return session;
	const profile = readExactOptionForGc(session.name, GJC_TMUX_PROFILE_OPTION, env);
	if (profile !== GJC_TMUX_PROFILE_VALUE) return session;
	return {
		...session,
		profile,
		branch: session.branch ?? readExactOptionForGc(session.name, GJC_TMUX_BRANCH_OPTION, env),
		branchSlug: session.branchSlug ?? readExactOptionForGc(session.name, GJC_TMUX_BRANCH_SLUG_OPTION, env),
		project: session.project ?? readExactOptionForGc(session.name, GJC_TMUX_PROJECT_OPTION, env),
		sessionId: session.sessionId ?? readExactOptionForGc(session.name, GJC_TMUX_SESSION_ID_OPTION, env),
		sessionStateFile:
			session.sessionStateFile ?? readExactOptionForGc(session.name, GJC_TMUX_SESSION_STATE_FILE_OPTION, env),
		ownerGeneration:
			session.ownerGeneration ?? readExactOptionForGc(session.name, GJC_TMUX_OWNER_GENERATION_OPTION, env),

		version: session.version ?? readExactOptionForGc(session.name, GJC_TMUX_VERSION_OPTION, env),
	};
}

/** @internal */
export function readTmuxSessionTagsForGc(
	sessionName: string,
	env: NodeJS.ProcessEnv = process.env,
): GjcTmuxSessionTagsForGc {
	const session = listGjcTmuxSessions(env).find(candidate => candidate.name === sessionName);
	return {
		profile: readExactOptionForGc(sessionName, GJC_TMUX_PROFILE_OPTION, env),
		project: readExactOptionForGc(sessionName, GJC_TMUX_PROJECT_OPTION, env),
		branch: readExactOptionForGc(sessionName, GJC_TMUX_BRANCH_OPTION, env),
		branchSlug: readExactOptionForGc(sessionName, GJC_TMUX_BRANCH_SLUG_OPTION, env),
		sessionId: readExactOptionForGc(sessionName, GJC_TMUX_SESSION_ID_OPTION, env),
		sessionStateFile: readExactOptionForGc(sessionName, GJC_TMUX_SESSION_STATE_FILE_OPTION, env),
		version: readExactOptionForGc(sessionName, GJC_TMUX_VERSION_OPTION, env),
		ownerGeneration: readExactOptionForGc(sessionName, GJC_TMUX_OWNER_GENERATION_OPTION, env),
		nativeSessionId: session?.nativeSessionId,
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
	const session = statusGjcTmuxSession(sessionName, env);
	if (session.attached || session.panePids.length > 0) {
		throw new Error(`gjc_tmux_session_live:${sessionName}`);
	}
	if (
		expectedIdentity &&
		(session.nativeSessionId !== expectedIdentity.nativeSessionId ||
			session.ownerGeneration !== expectedIdentity.ownerGeneration ||
			session.sessionId !== expectedIdentity.sessionId ||
			session.sessionStateFile !== expectedIdentity.sessionStateFile ||
			session.project !== expectedIdentity.project ||
			session.createdAt !== expectedIdentity.createdAt)
	)
		throw new Error(`gjc_tmux_owner_changed:${sessionName}`);
	if (readProfileForExactTarget(session.name, env) !== GJC_TMUX_PROFILE_VALUE) {
		throw new Error(`gjc_tmux_session_not_managed:${sessionName}`);
	}
	if (resolveGjcTmuxBinary({ env }).isPsmux) throw new Error(`gjc_tmux_owner_unverifiable:${sessionName}`);
	const nativeSessionId = readNativeTmuxSessionId(session.name, env);
	if (!nativeSessionId) throw new Error(`gjc_tmux_owner_unverifiable:${sessionName}`);
	if (expectedIdentity && nativeSessionId !== expectedIdentity.nativeSessionId)
		throw new Error(`gjc_tmux_owner_changed:${sessionName}`);
	if (
		expectedIdentity &&
		readExactOptionForGc(session.name, GJC_TMUX_OWNER_GENERATION_OPTION, env) !== expectedIdentity.ownerGeneration
	)
		throw new Error(`gjc_tmux_owner_changed:${sessionName}`);
	const firstServer = requireSafeTmuxServerForMutation(resolveGjcTmuxCommand(env), env);
	if (
		readNativeTmuxSessionId(nativeSessionId, env) !== nativeSessionId ||
		readProfileForExactTarget(nativeSessionId, env) !== GJC_TMUX_PROFILE_VALUE
	)
		throw new Error(`gjc_tmux_owner_changed:${sessionName}`);
	const finalServer = requireSafeTmuxServerForMutation(resolveGjcTmuxCommand(env), env);
	if (finalServer.pid !== firstServer.pid || finalServer.startTime !== firstServer.startTime)
		throw new Error(`gjc_tmux_owner_changed:${sessionName}`);
	runGuardedTmuxSessionCommand(
		nativeSessionId,
		session.name,
		finalServer.pid,
		env,
		`kill-session -t '${nativeSessionId}'`,
		expectedIdentity?.ownerGeneration,
	);
	return session;
}

async function readProcessStartTime(pid: number): Promise<string | null> {
	return readLinuxProcStartTime(pid);
}

async function readCurrentGeneration(stateDir: string, sessionId: string): Promise<string | null> {
	try {
		const value: unknown = JSON.parse(
			await fs.readFile(path.join(stateDir, sessionId, "owner-lifecycle", "generation.json"), "utf8"),
		);
		return typeof value === "object" &&
			value !== null &&
			typeof (value as { generation?: unknown }).generation === "string"
			? (value as { generation: string }).generation
			: null;
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
	const stateDir = path.dirname(stateFile);
	const generation = await readCurrentGeneration(stateDir, sessionId);
	const pid = exactPanePid;
	const startTime = await readProcessStartTime(pid);
	if (!generation || !ownerGeneration || ownerGeneration !== generation || !ownerServerKey || !startTime)
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
	listPanePids: (sessionName: string, env: NodeJS.ProcessEnv) => number[],
	readStartTime: (pid: number) => Promise<string | null>,
): Promise<void> {
	try {
		const currentNativeSessionId = readNativeTmuxSessionId(nativeSessionId, env);
		if (!currentNativeSessionId) {
			if (readNativeTmuxSessionId(sessionName, env)) throw new Error(`gjc_tmux_owner_changed:${sessionName}`);
			return;
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
		].filter((value): value is string => value !== null);
		if (mismatches.length > 0) throw new Error(`gjc_tmux_owner_changed:${sessionName}:${mismatches.join(",")}`);
	} catch (error) {
		if (!readNativeTmuxSessionId(nativeSessionId, env)) {
			if (readNativeTmuxSessionId(sessionName, env)) throw new Error(`gjc_tmux_owner_changed:${sessionName}`);
			return;
		}
		if (error instanceof Error && error.message.startsWith(`gjc_tmux_owner_changed:${sessionName}`))
			throw new Error(`gjc_tmux_owner_changed:${sessionName}`);
		throw new Error(`gjc_tmux_owner_changed:${sessionName}`);
	}
}

async function waitForExpectedVerdict(
	identity: ExactOwnerIdentity,
	sleep: (ms: number) => Promise<void>,
	now: () => Date,
): Promise<OwnerVerdict | null> {
	const deadline = now().getTime() + FORCE_CLOSE_VERDICT_TIMEOUT_MS;
	const paths = lifecyclePaths(identity.stateDir, identity.sessionId, identity.generation);
	const verdictFile = paths.verdictFile;
	const verdictAliasFile = paths.verdictAliasFile;
	while (now().getTime() <= deadline) {
		try {
			const [verdictBody, aliasBody] = await Promise.all([
				fs.readFile(verdictFile, "utf8"),
				fs.readFile(verdictAliasFile, "utf8"),
			]);
			const verdict: unknown = JSON.parse(verdictBody);
			const alias: unknown = JSON.parse(aliasBody);
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
	if (resolveGjcTmuxBinary({ env }).isPsmux) throw new Error(`gjc_tmux_owner_unverifiable:${sessionName}`);
	const session = statusGjcTmuxSession(sessionName, env);
	if (readProfileForExactTarget(session.name, env) !== GJC_TMUX_PROFILE_VALUE)
		throw new Error(`gjc_tmux_session_not_managed:${sessionName}`);
	const exactPanePids = (deps.listPanePids ?? readExactSessionPanePids)(session.name, env);
	if (exactPanePids.length !== 1) throw new Error(`gjc_tmux_owner_unverifiable:${sessionName}`);
	const actualSessionId = readExactOptionForGc(session.name, GJC_TMUX_SESSION_ID_OPTION, env);
	const actualStateFile = readExactOptionForGc(session.name, GJC_TMUX_SESSION_STATE_FILE_OPTION, env);
	const actualGeneration = readExactOptionForGc(session.name, GJC_TMUX_OWNER_GENERATION_OPTION, env);
	const actualServerKey = readExactOptionForGc(session.name, GJC_TMUX_OWNER_SERVER_KEY_OPTION, env);

	if (expectedSessionId !== undefined && actualSessionId !== expectedSessionId)
		throw new Error(`gjc_tmux_session_id_mismatch:${sessionName}`);
	if (expectedStateFile !== undefined && actualStateFile !== expectedStateFile)
		throw new Error(`gjc_tmux_session_state_file_mismatch:${sessionName}`);
	if (!actualSessionId || !actualStateFile || !actualGeneration || !actualServerKey)
		throw new Error(`gjc_tmux_owner_unverifiable:${sessionName}`);
	const nativeSessionId = readNativeTmuxSessionId(session.name, env);
	if (!nativeSessionId) throw new Error(`gjc_tmux_owner_unverifiable:${sessionName}`);

	const resolveOwner =
		deps.resolveOwner ?? ((name, targetEnv) => resolveExactOwner(name, targetEnv, exactPanePids[0]!));
	const identity = await resolveOwner(session.name, env);
	if (identity.pid !== exactPanePids[0]) throw new Error(`gjc_tmux_owner_identity_mismatch:${sessionName}`);
	if (identity.sessionId !== actualSessionId || identity.stateDir !== path.dirname(actualStateFile))
		throw new Error(`gjc_tmux_owner_identity_mismatch:${sessionName}`);
	if (identity.generation !== actualGeneration) throw new Error(`gjc_tmux_owner_generation_mismatch:${sessionName}`);
	if (identity.socketKey !== actualServerKey) throw new Error(`gjc_tmux_owner_server_key_mismatch:${sessionName}`);
	const initialServer = requireSafeTmuxServerForMutation(resolveGjcTmuxCommand(env), env);

	const currentStartTime = await (deps.readProcessStartTime ?? readProcessStartTime)(identity.pid);
	if (currentStartTime !== identity.startTime) throw new Error("owner_pid_identity_mismatch");
	const now = deps.now ?? (() => new Date());
	const sleep = deps.sleep ?? (ms => Bun.sleep(ms));
	const dispatchId = crypto.randomUUID();
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
			expiresAt: new Date(now().getTime() + FORCE_CLOSE_VERDICT_TIMEOUT_MS).toISOString(),
		},
		{
			readStartTime: deps.readProcessStartTime ?? readProcessStartTime,
			sendSigterm: async pid => {
				if ((await (deps.readProcessStartTime ?? readProcessStartTime)(pid)) !== identity.startTime)
					throw new Error("owner_pid_identity_mismatch");
				(deps.signalTerm ?? (target => process.kill(target, "SIGTERM")))(pid);
			},

			waitForVerdict: () => waitForExpectedVerdict(identity, sleep, now),
			cleanupSession: async () => {
				await requireUnchangedOwnerForCompatibilityCleanup(
					session.name,
					nativeSessionId,
					env,
					identity,
					actualStateFile,
					initialServer,
					deps.listPanePids ?? readExactSessionPanePids,
					deps.readProcessStartTime ?? readProcessStartTime,
				);
				if (deps.cleanupSession) deps.cleanupSession(nativeSessionId, env);
				else
					runGuardedTmuxSessionCommand(
						nativeSessionId,
						session.name,
						initialServer.pid,
						env,
						`kill-session -t '${nativeSessionId}'`,
					);
			},
		},
	);
	return session;
}

export function attachGjcTmuxSession(sessionName: string, env: NodeJS.ProcessEnv = process.env): never {
	if (resolveGjcTmuxBinary({ env }).isPsmux) throw new Error(`gjc_tmux_owner_unverifiable:${sessionName}`);
	const session = statusGjcTmuxSession(sessionName, env);
	const tmuxCommand = resolveGjcTmuxCommand(env);
	requireSafeTmuxServerForMutation(tmuxCommand, env);
	const result = Bun.spawnSync(
		[tmuxCommand, "attach-session", "-t", buildGjcTmuxExactSessionTarget(session.name, { env })],
		{
			stdin: "inherit",
			stdout: "inherit",
			stderr: "inherit",
			env,
		},
	);
	process.exit(result.exitCode ?? 1);
}
