/** Internal JSON-line facade for the tmux owner-isolation contract. */
import * as fs from "node:fs/promises";
import { readLinuxProcStartTime } from "./linux-proc";
import {
	type BootstrapRequest,
	bootstrapTmuxOwnerIsolation,
	classifyCgroup,
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
	void socketKey;
	if (!tmuxControlArgv?.length) return { state: "unverifiable" };
	const platform = options.platform ?? process.platform;
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
		try {
			return serializeOwnerIsolationResponse(publishOwnerGenerationSync(request as PublishGenerationRequest));
		} catch {
			return cliFailure("generation_publication_failed");
		}
	}
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
	const request = stdin === null ? null : parseOwnerIsolationRequest(stdin);
	if (request?.op === "bootstrap") {
		try {
			if (JSON.parse(output).ok !== true) process.exitCode = 1;
		} catch {
			process.exitCode = 1;
		}
	}
}
