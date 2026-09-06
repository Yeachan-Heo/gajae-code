/** Internal JSON-line facade for the tmux owner-isolation contract. */
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { readLinuxProcStartTime } from "./linux-proc";
import { resolveGjcTmuxBinary } from "./psmux-detect";
import { buildGjcTmuxExactSessionTarget } from "./tmux-common";
import {
	type BootstrapRequest,
	bootstrapTmuxOwnerIsolation,
	classifyCgroup,
	isTmuxControlArgvBoundToSocket,
	isTmuxShellWrapperArgv,
	isTrustedOwnerIsolationProtocolRequest,
	isTrustedTmuxControlArgv,
	type ObserveTerminalRequest,
	type OwnerIsolationProbe,
	observeOwnerTerminal,
	type PlanRequest,
	type PublishGenerationRequest,
	parseOwnerIsolationRequest,
	planTmuxOwnerIsolation,
	publishOwnerGenerationSync,
	serializeOwnerIsolationResponse,
	TMUX_OWNER_ISOLATION_MAX_LINE_BYTES,
	type TmuxServerProof,
} from "./tmux-owner-isolation";

/** Matches the sole argv shape allowed to enter the owner-isolation JSON-line protocol. */
export function isTmuxOwnerIsolationCliArgv(argv: readonly string[]): boolean {
	return argv.length === 1 && argv[0] === "--internal-tmux-owner-isolation";
}

async function readCgroup(pid = "self"): Promise<string | null> {
	try {
		return await fs.readFile(`/proc/${pid}/cgroup`, "utf8");
	} catch {
		return null;
	}
}

async function readProcessStartTime(pid: number): Promise<string | null> {
	return readLinuxProcStartTime(pid);
}

function isKnownNoServerDiagnostic(stderr: string): boolean {
	const diagnostic = stderr.trim().toLowerCase();
	return (
		diagnostic.length > 0 &&
		diagnostic.length <= 512 &&
		/no server running|failed to connect to server|error connecting to/.test(diagnostic)
	);
}

interface TmuxListSessionsResult {
	exitCode: number | null;
	stdout: string;
	stderr: string;
}

interface TmuxServerProofOptions {
	platform?: NodeJS.Platform;
	runListSessions?: (argv: string[]) => TmuxListSessionsResult;
}

export interface LifecycleCallerProbe {
	callerPid: number;
	parentPid: number;
	readParentPid(pid: number): Promise<number | null>;
	readChildren(pid: number): Promise<number[]>;
	readStartTime(pid: number): Promise<string | null>;
	authorityPipeOwnedByParent(): Promise<boolean>;
	readPane(socketKey: string, target: string): TmuxPaneAuthority | null;
	ownerSessionExists(socketKey: string, sessionId: string): boolean | null;
}

export interface TmuxPaneAuthority {
	pid: number;
	serverPid: number;
	nativeSessionId: string;
	paneId: string;
	generation: string;
	serverKey: string;
	sessionId: string;
	stateFile: string;
}

function parseProcParentPid(stat: string): number | null {
	const close = stat.lastIndexOf(")");
	if (close < 0) return null;
	const fields = stat
		.slice(close + 1)
		.trim()
		.split(/\s+/);
	if (!fields[1] || !/^\d+$/.test(fields[1])) return null;
	const pid = Number(fields[1]);
	return Number.isSafeInteger(pid) && pid > 0 ? pid : null;
}

async function readParentPid(pid: number): Promise<number | null> {
	try {
		return parseProcParentPid(await fs.readFile(`/proc/${pid}/stat`, "utf8"));
	} catch {
		return null;
	}
}

async function readChildren(pid: number): Promise<number[]> {
	try {
		const value = (await fs.readFile(`/proc/${pid}/task/${pid}/children`, "utf8")).trim();
		if (!value) return [];
		return value
			.split(/\s+/)
			.filter(child => /^\d+$/.test(child))
			.map(Number)
			.filter(child => Number.isSafeInteger(child) && child > 0);
	} catch {
		return [];
	}
}

/** @internal */
export function isLifecycleAdapterRegistrationValid(
	registration: string,
	pid: number,
	startTime: string | null,
	parentOwnsPipe = true,
): boolean {
	const fields = registration.trim().split(/\s+/);
	return (
		parentOwnsPipe &&
		fields.length === 2 &&
		fields[0] === String(pid) &&
		startTime !== null &&
		fields[1] === startTime
	);
}

/** @internal */
export async function authorityPipeOwnedByParent(): Promise<boolean> {
	const rawFd = process.env.GJC_TMUX_OWNER_AUTHORITY_FD;
	if (!rawFd || !/^\d+$/.test(rawFd)) return false;
	const fd = Number(rawFd);
	if (!Number.isSafeInteger(fd) || fd < 3) return false;
	try {
		const capability = await fs.stat(`/proc/self/fd/${fd}`, { bigint: true });
		if (!capability.isFIFO()) return false;
		let parentOwnsPipe = false;
		for (const parentFd of await fs.readdir(`/proc/${process.ppid}/fd`)) {
			try {
				const candidate = await fs.stat(`/proc/${process.ppid}/fd/${parentFd}`, { bigint: true });
				if (candidate.isFIFO() && candidate.dev === capability.dev && candidate.ino === capability.ino) {
					parentOwnsPipe = true;
					break;
				}
			} catch {}
		}
		const registration = await fs.readFile(`/proc/self/fd/${fd}`, "utf8");
		return isLifecycleAdapterRegistrationValid(
			registration,
			process.pid,
			await readProcessStartTime(process.pid),
			parentOwnsPipe,
		);
	} catch {
		return false;
	}
}

function tmuxControl(socketKey: string, ...args: string[]): Bun.SyncSubprocess<"pipe", "pipe"> {
	const command = resolveGjcTmuxBinary().command;
	return Bun.spawnSync([command, "-L", socketKey, ...args], { stdout: "pipe", stderr: "pipe" });
}

function readPane(socketKey: string, target: string): TmuxPaneAuthority | null {
	const result = tmuxControl(
		socketKey,
		"display-message",
		"-p",
		"-t",
		target,
		"-F",
		"#{pane_pid}\t#{pid}\t#{session_id}\t#{pane_id}\t#{@gjc-owner-generation}\t#{@gjc-owner-server-key}\t#{@gjc-session-id}\t#{@gjc-session-state-file}",
	);
	if (result.exitCode !== 0) return null;
	const [rawPid, rawServerPid, nativeSessionId, paneId, generation, serverKey, sessionId, stateFile] = Buffer.from(
		result.stdout,
	)
		.toString()
		.trim()
		.split("\t");
	if (!rawPid || !/^\d+$/.test(rawPid) || !rawServerPid || !/^\d+$/.test(rawServerPid)) return null;
	const pid = Number(rawPid);
	const serverPid = Number(rawServerPid);
	return Number.isSafeInteger(pid) && pid > 0 && Number.isSafeInteger(serverPid) && serverPid > 0
		? {
				pid,
				serverPid,
				nativeSessionId: nativeSessionId ?? "",
				paneId: paneId ?? "",
				generation: generation ?? "",
				serverKey: serverKey ?? "",
				sessionId: sessionId ?? "",
				stateFile: stateFile ?? "",
			}
		: null;
}

/** @internal */
export function classifyOwnerSessionProbe(result: { exitCode: number | null; stderr: string }): boolean | null {
	if (result.exitCode === 0) return true;
	const diagnostic = result.stderr.trim().toLowerCase();
	if (result.exitCode === 1 && (!diagnostic || /can't find session|no sessions|session not found/.test(diagnostic)))
		return false;
	return null;
}

function ownerSessionExists(socketKey: string, sessionId: string): boolean | null {
	const binary = resolveGjcTmuxBinary();
	const result = tmuxControl(socketKey, "has-session", "-t", buildGjcTmuxExactSessionTarget(sessionId, { binary }));
	return classifyOwnerSessionProbe({ exitCode: result.exitCode, stderr: Buffer.from(result.stderr).toString() });
}

function lifecycleCallerProbe(): LifecycleCallerProbe {
	return {
		callerPid: process.pid,
		parentPid: process.ppid,
		readParentPid,
		readChildren,
		readStartTime: readProcessStartTime,
		authorityPipeOwnedByParent,
		readPane,
		ownerSessionExists,
	};
}

async function ancestorChain(startPid: number, probe: LifecycleCallerProbe): Promise<number[]> {
	const chain: number[] = [];
	let pid: number | null = startPid;
	for (let depth = 0; depth < 4 && pid !== null; depth += 1) {
		chain.push(pid);
		pid = await probe.readParentPid(pid);
	}
	return chain;
}

/** Sensitive lifecycle mutations are admitted only from the exact trusted tmux pane process. */
export async function isTrustedLifecycleMutationCaller(
	request: PublishGenerationRequest | ObserveTerminalRequest,
	probe: LifecycleCallerProbe = lifecycleCallerProbe(),
): Promise<boolean> {
	if (!(await probe.authorityPipeOwnedByParent())) return false;
	if (
		!request.owner_native_session_id ||
		!request.owner_pane_id ||
		!request.owner_pid ||
		!request.owner_start_time ||
		!request.owner_server_pid ||
		!request.owner_server_start_time
	)
		return false;
	const owner = probe.readPane(request.socket_key, request.owner_pane_id);
	const expectedStateFile = path.join(request.state_dir, "runtime-state.json");
	if (
		owner &&
		owner.generation === request.owner_generation &&
		owner.nativeSessionId === request.owner_native_session_id &&
		owner.paneId === request.owner_pane_id &&
		owner.pid === request.owner_pid &&
		owner.serverPid === request.owner_server_pid &&
		owner.serverKey === request.socket_key &&
		owner.sessionId === request.session_id &&
		owner.stateFile === expectedStateFile &&
		probe.parentPid === owner.pid
	) {
		if (
			(await probe.readStartTime(owner.pid)) !== request.owner_start_time ||
			(await probe.readStartTime(owner.serverPid)) !== request.owner_server_start_time
		)
			return false;
		if (process.platform !== "linux") return true;
		const children = await probe.readChildren(owner.pid);
		if (request.op === "publish_generation") return children.length === 1 && children[0] === probe.callerPid;

		const callerStart = await probe.readStartTime(probe.callerPid);
		if (!callerStart) return false;
		for (const sibling of children) {
			if (sibling === probe.callerPid) continue;
			const siblingStart = await probe.readStartTime(sibling);
			if (siblingStart && BigInt(siblingStart) <= BigInt(callerStart)) return true;
		}
		return false;
	}
	if (request.op !== "observe_terminal" || request.observer !== "raw_monitor") return false;
	if (probe.ownerSessionExists(request.socket_key, request.owner_native_session_id) !== false) return false;
	if (
		!request.monitor_native_session_id ||
		!request.monitor_pane_id ||
		!request.monitor_pid ||
		!request.monitor_start_time
	)
		return false;
	const monitor = probe.readPane(request.socket_key, request.monitor_pane_id);
	if (
		!monitor ||
		monitor.generation !== request.owner_generation ||
		monitor.nativeSessionId !== request.monitor_native_session_id ||
		monitor.paneId !== request.monitor_pane_id ||
		monitor.pid !== request.monitor_pid ||
		monitor.serverPid !== request.owner_server_pid ||
		monitor.serverKey !== request.socket_key ||
		monitor.sessionId !== request.session_id ||
		monitor.stateFile !== expectedStateFile
	)
		return false;
	if (
		(await probe.readStartTime(monitor.pid)) !== request.monitor_start_time ||
		(await probe.readStartTime(monitor.serverPid)) !== request.owner_server_start_time
	)
		return false;
	const chain = await ancestorChain(probe.parentPid, probe);
	return chain.includes(monitor.pid);
}

function runTmuxListSessions(controlArgv: string[]): TmuxListSessionsResult {
	const subprocess = Bun.spawnSync([...controlArgv, "list-sessions", "-F", "#{pid}\t#{session_name}"], {
		stdout: "pipe",
		stderr: "pipe",
	});
	return {
		exitCode: subprocess.exitCode,
		stdout: Buffer.from(subprocess.stdout).toString(),
		stderr: Buffer.from(subprocess.stderr).toString(),
	};
}

function parseTmuxSessionRows(stdout: string): { pid: number; sessionNames: string[] } | null {
	const lines = stdout.split("\n");
	if (lines[lines.length - 1] === "") lines.pop();
	let pid: number | undefined;
	const sessionNames: string[] = [];
	for (const rawLine of lines) {
		const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
		const columns = line.split("\t");
		if (columns.length !== 2 || !/^[1-9]\d*$/.test(columns[0]) || !columns[1].trim()) return null;
		const rowPid = Number(columns[0]);
		if (!Number.isSafeInteger(rowPid) || (pid !== undefined && pid !== rowPid)) return null;
		pid = rowPid;
		sessionNames.push(columns[1]);
	}
	return pid === undefined ? null : { pid, sessionNames };
}

/** Probes a tmux server using an injectable list-sessions runner for platform-bounded callers. */
export async function tmuxServerProof(
	socketKey: string,
	tmuxControlArgv?: string[],
	options: TmuxServerProofOptions = {},
): Promise<TmuxServerProof> {
	if (!tmuxControlArgv?.length) return { state: "unverifiable" };
	const platform = options.platform ?? process.platform;
	const usingPlatformBoundTestRunner = options.runListSessions !== undefined && platform !== process.platform;
	if (!usingPlatformBoundTestRunner && platform !== process.platform) return { state: "unverifiable" };
	// A supplied list-sessions runner is the hermetic test seam. Production
	// probes must only execute the provider selected by this process, and every
	// explicit socket selector must bind to the caller's server key before spawn.
	if (isTmuxShellWrapperArgv(tmuxControlArgv)) return { state: "unverifiable" };
	if (
		!usingPlatformBoundTestRunner &&
		!isTmuxControlArgvBoundToSocket(socketKey, tmuxControlArgv, {
			allowUnselectedProvider: tmuxControlArgv[0] === socketKey,
		})
	)
		return { state: "unverifiable" };
	if (!usingPlatformBoundTestRunner && !isTrustedTmuxControlArgv(tmuxControlArgv)) return { state: "unverifiable" };
	const subprocess = options.runListSessions?.(tmuxControlArgv) ?? runTmuxListSessions(tmuxControlArgv);
	if (subprocess.exitCode !== 0)
		return isKnownNoServerDiagnostic(subprocess.stderr) ? { state: "absent" } : { state: "unverifiable" };
	if (!subprocess.stdout.trim()) return { state: "absent" };
	const rows = parseTmuxSessionRows(subprocess.stdout);
	if (!rows) return { state: "unverifiable" };
	const { pid, sessionNames } = rows;
	if (platform !== "linux") {
		return {
			state: "safe",
			pid,
			startTime: "not_applicable",
			cgroup: { classification: "not_applicable" },
			sessionNames,
		};
	}
	const cgroup = classifyCgroup({ platform, cgroupText: await readCgroup(String(pid)) });
	const startTime = await readProcessStartTime(pid);
	if (!startTime) return { state: "unverifiable", pid, cgroup, sessionNames };
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
		sessionNames,
	};
}

function probe(): OwnerIsolationProbe {
	return {
		readCallerCgroup: () => readCgroup(),
		probeServer: async (socketKey, tmuxArgv) => tmuxServerProof(socketKey, tmuxArgv),
	};
}

function cliFailure(diagnostic: string): string {
	return serializeOwnerIsolationResponse({ schema_version: 1, ok: false, code: "scope_unavailable", diagnostic });
}

/** Reads exactly one bounded JSON line and writes exactly one JSON response line. */
export async function runTmuxOwnerIsolationCli(stdin: string): Promise<string> {
	const line = stdin.endsWith("\n") ? stdin.slice(0, -1) : stdin;
	if (line.includes("\n")) return cliFailure("invalid_json_line");
	const request = parseOwnerIsolationRequest(line);
	if (!request) return cliFailure("invalid_json_line");
	if (!isTrustedOwnerIsolationProtocolRequest(request)) return cliFailure("invalid_json_line");
	if (request.op === "plan")
		return serializeOwnerIsolationResponse(await planTmuxOwnerIsolation(request as PlanRequest, probe()));
	if (request.op === "bootstrap") {
		const bootstrap = request as BootstrapRequest;
		return serializeOwnerIsolationResponse(
			await bootstrapTmuxOwnerIsolation(bootstrap, {
				readSelfCgroup: () => readCgroup(),
				spawn: argv => {
					const result = Bun.spawnSync(argv, { stdin: "ignore", stdout: "pipe", stderr: "ignore" });
					return { exitCode: result.exitCode, stdout: Buffer.from(result.stdout).toString() };
				},
				probeServer: async (socketKey, tmuxControlArgv) => tmuxServerProof(socketKey, tmuxControlArgv),
			}),
		);
	}
	if (request.op === "publish_generation") {
		if (!(await isTrustedLifecycleMutationCaller(request as PublishGenerationRequest)))
			return cliFailure("invalid_json_line");
		try {
			return serializeOwnerIsolationResponse(publishOwnerGenerationSync(request as PublishGenerationRequest));
		} catch {
			return cliFailure("generation_publication_failed");
		}
	}
	if (!(await isTrustedLifecycleMutationCaller(request as ObserveTerminalRequest)))
		return cliFailure("invalid_json_line");
	try {
		return serializeOwnerIsolationResponse(await observeOwnerTerminal(request as ObserveTerminalRequest));
	} catch {
		return cliFailure("terminal_observation_failed");
	}
}

const MAX_JSON_LINE_BYTES = TMUX_OWNER_ISOLATION_MAX_LINE_BYTES;

async function readOneBoundedJsonLine(): Promise<string | null> {
	const reader = Bun.stdin.stream().getReader();
	const bytes: number[] = [];
	let complete = false;
	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			for (const byte of value) {
				if (complete || (byte !== 0x0a && bytes.length >= MAX_JSON_LINE_BYTES)) return null;
				if (byte === 0x0a) {
					complete = true;
					continue;
				}
				bytes.push(byte);
			}
		}
	} finally {
		reader.releaseLock();
	}
	return new TextDecoder().decode(new Uint8Array(bytes));
}

export async function runTmuxOwnerIsolationCliFromStdin(): Promise<void> {
	const stdin = await readOneBoundedJsonLine();
	const output = stdin === null ? cliFailure("invalid_json_line") : await runTmuxOwnerIsolationCli(stdin);
	process.stdout.write(`${output}\n`);
	try {
		if (JSON.parse(output).ok === false) process.exitCode = 1;
	} catch {
		process.exitCode = 1;
	}
}
