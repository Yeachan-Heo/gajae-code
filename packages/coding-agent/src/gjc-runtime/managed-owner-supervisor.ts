import * as crypto from "node:crypto";
import * as fsSync from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { nativeProcessBindings } from "@gajae-code/utils/native-process";
import { readLinuxProcStartTime } from "./linux-proc";
import { assertSafePathComponent } from "./session-layout";
import {
	isValidOwnerIntent,
	lifecyclePaths,
	type OwnerIntent,
	observeOwnerTerminal,
	type TerminalSignal,
} from "./tmux-owner-isolation";

export const MANAGED_OWNER_SUPERVISOR_ARG = "--internal-managed-owner-supervisor";
export const MANAGED_OWNER_CHILD_TOKEN_ENV = "GJC_MANAGED_OWNER_CHILD_TOKEN";
export const MANAGED_OWNER_COMMAND_ENV = "GJC_MANAGED_OWNER_COMMAND_JSON";
export const MANAGED_OWNER_SESSION_ID_ENV = "GJC_COORDINATOR_SESSION_ID";
export const MANAGED_OWNER_GENERATION_ENV = "GJC_TMUX_OWNER_GENERATION";
export const MANAGED_OWNER_STATE_DIR_ENV = "GJC_TMUX_OWNER_STATE_DIR";
export const MANAGED_OWNER_RUN_ID_ENV = "GJC_MANAGED_OWNER_RUN_ID";
export const MANAGED_OWNER_INCARNATION_ENV = "GJC_MANAGED_OWNER_INCARNATION";
/** Suppresses command-derived durable artifacts for Broker-owned opaque spawn children. */
export const MANAGED_OWNER_REDACT_COMMAND_ENV = "GJC_MANAGED_OWNER_REDACT_COMMAND";
const GJC_TMUX_OWNER_SERVER_KEY_ENV = "GJC_TMUX_OWNER_SERVER_KEY";

let bootstrapSigtermPending = false;
const captureBootstrapSigterm = () => {
	bootstrapSigtermPending = true;
};

export interface ManagedOwnerBinding {
	schema_version: 2;
	generation: string;
	session_id: string;
	run_id: string;
	endpoint_incarnation: string;
	child_token: string;
	command: string[];
	command_sha256: string;
	supervisor_pid: number;
	supervisor_start_time: string;
	created_at: string;
}

export interface ManagedOwnerSigabrtReceipt {
	schema_version: 2;
	generation: string;
	session_id: string;
	run_id: string;
	endpoint_incarnation: string;
	child_token: string;
	command_sha256: string;
	supervisor_pid: number;
	supervisor_start_time: string;
	child_pid: number;
	child_start_time: string;
	signal: "SIGABRT";
	signal_number: 6;
	exit_code: number | null;
	received_at: string;
}

function requiredEnvironment(name: string): string {
	const value = process.env[name]?.trim();
	if (!value) throw new Error(`managed_owner_${name.toLowerCase()}_missing`);
	return value;
}

function lifecycleRoot(): {
	root: string;
	stateDir: string;
	generation: string;
	sessionId: string;
	runId: string;
	incarnation: string;
} {
	const stateDir = requiredEnvironment(MANAGED_OWNER_STATE_DIR_ENV);
	const sessionId = requiredEnvironment(MANAGED_OWNER_SESSION_ID_ENV);
	const generation = requiredEnvironment(MANAGED_OWNER_GENERATION_ENV);
	const runId = requiredEnvironment(MANAGED_OWNER_RUN_ID_ENV);
	const incarnation = requiredEnvironment(MANAGED_OWNER_INCARNATION_ENV);
	for (const [value, label] of [
		[sessionId, "managed owner session id"],
		[generation, "managed owner generation"],
		[runId, "managed owner run id"],
		[incarnation, "managed owner incarnation"],
	] as const)
		assertSafePathComponent(value, label);
	if (!path.isAbsolute(stateDir)) throw new Error("managed_owner_lifecycle_path_unsafe");
	const root = lifecyclePaths(stateDir, sessionId, generation).root;
	if (!root.startsWith(`${path.resolve(stateDir)}${path.sep}`)) throw new Error("managed_owner_lifecycle_path_unsafe");
	return { root, stateDir, generation, sessionId, runId, incarnation };
}

function commandDigest(command: readonly string[]): string {
	return crypto.createHash("sha256").update(JSON.stringify(command)).digest("hex");
}
async function managedOwnerProcessProvenance(pid: number): Promise<string | null> {
	if (process.platform === "linux") return await readLinuxProcStartTime(pid);
	return nativeProcessBindings().Process.fromPid(pid)?.incarnation ?? null;
}

async function writeDurableExclusive(file: string, value: object): Promise<void> {
	const handle = await fs.open(file, "wx", 0o600);
	try {
		await handle.writeFile(`${JSON.stringify(value)}\n`);
		await handle.sync();
	} finally {
		await handle.close();
	}
	const directory = await fs.open(path.dirname(file), "r");
	try {
		await directory.sync();
	} finally {
		await directory.close();
	}
	const persisted = JSON.parse(await fs.readFile(file, "utf8")) as unknown;
	if (JSON.stringify(persisted) !== JSON.stringify(value)) throw new Error("managed_owner_durable_reread_failed");
}

function childCommand(): string[] {
	const command = JSON.parse(requiredEnvironment(MANAGED_OWNER_COMMAND_ENV)) as unknown;
	if (!Array.isArray(command) || command.length === 0 || command.some(value => typeof value !== "string" || !value))
		throw new Error("managed_owner_command_invalid");
	return command;
}

export function isManagedOwnerSupervisorArgv(args: readonly string[]): boolean {
	return args.length === 1 && args[0] === MANAGED_OWNER_SUPERVISOR_ARG;
}

if (isManagedOwnerSupervisorArgv(process.argv.slice(2))) {
	process.removeAllListeners("SIGTERM");
	process.on("SIGTERM", captureBootstrapSigterm);
}

/** Runs one exact child and publishes authority only for a directly observed Linux signal 6. */
export async function runManagedOwnerSupervisor(): Promise<void> {
	const { root, stateDir, generation, sessionId, runId, incarnation } = lifecycleRoot();
	const command = childCommand();
	let sigtermPending = bootstrapSigtermPending;
	const captureEarlySigterm = () => {
		sigtermPending = true;
	};
	process.removeAllListeners("SIGTERM");
	process.on("SIGTERM", captureEarlySigterm);
	const supervisorStartTime = await managedOwnerProcessProvenance(process.pid);
	if (!supervisorStartTime) throw new Error("managed_owner_supervisor_start_time_unavailable");
	await fs.mkdir(root, { recursive: true, mode: 0o700 });
	const childToken = crypto.randomUUID();
	const redactCommand = process.env[MANAGED_OWNER_REDACT_COMMAND_ENV] === "1";
	const binding: ManagedOwnerBinding | null = redactCommand
		? null
		: {
				schema_version: 2,
				generation,
				session_id: sessionId,
				run_id: runId,
				endpoint_incarnation: incarnation,
				child_token: childToken,
				command,
				command_sha256: commandDigest(command),
				supervisor_pid: process.pid,
				supervisor_start_time: supervisorStartTime,
				created_at: new Date().toISOString(),
			};
	if (binding) await writeDurableExclusive(path.join(root, `child-${childToken}.binding.json`), binding);
	const childEnvironment: NodeJS.ProcessEnv = { ...process.env, [MANAGED_OWNER_CHILD_TOKEN_ENV]: childToken };
	delete childEnvironment[MANAGED_OWNER_COMMAND_ENV];
	delete childEnvironment[MANAGED_OWNER_REDACT_COMMAND_ENV];
	const child = Bun.spawn({
		cmd: command,
		stdin: "inherit",
		stdout: "inherit",
		stderr: "inherit",
		env: childEnvironment,
	});
	const childStartTime = await managedOwnerProcessProvenance(child.pid);
	if (!childStartTime) throw new Error("managed_owner_child_start_time_unavailable");
	const childProcess = nativeProcessBindings().Process.fromPid(child.pid);
	if (!childProcess) {
		const exitCode = await child.exited;
		if (child.signalCode === "SIGABRT") {
			if (binding) {
				const receipt: ManagedOwnerSigabrtReceipt = {
					schema_version: 2,
					generation,
					session_id: sessionId,
					run_id: runId,
					endpoint_incarnation: incarnation,
					child_token: childToken,
					command_sha256: binding.command_sha256,
					supervisor_pid: process.pid,
					supervisor_start_time: supervisorStartTime,
					child_pid: child.pid,
					child_start_time: childStartTime,
					signal: "SIGABRT",
					signal_number: 6,
					exit_code: exitCode,
					received_at: new Date().toISOString(),
				};
				await writeDurableExclusive(path.join(root, `sigabrt-${childToken}.receipt.json`), receipt);
			}
			process.exitCode = 134;
			return;
		}
		process.exitCode = exitCode;
		return;
	}
	if (process.platform === "linux" && childProcess.incarnation !== `linux:${childStartTime}`)
		throw new Error("managed_owner_child_incarnation_mismatch");
	let childExited = false;
	let sigtermRelayed = false;
	let relayedIntent: OwnerIntent | null = null;
	let relayedAt: string | null = null;
	const relaySigterm = () => {
		if (childExited) return;
		let candidateIntent: OwnerIntent | null = null;
		let intentEvidencePresent = false;
		let expiredIntent = false;
		try {
			intentEvidencePresent = true;
			const candidate: unknown = JSON.parse(
				fsSync.readFileSync(lifecyclePaths(stateDir, sessionId, generation).intentFile, "utf8"),
			);
			if (
				isValidOwnerIntent(candidate) &&
				candidate.session_id === sessionId &&
				candidate.generation === generation
			) {
				const now = Date.now();
				const active = Date.parse(candidate.created_at) <= now && Date.parse(candidate.expires_at) > now;
				if (!active && Date.parse(candidate.expires_at) <= now) expiredIntent = true;
				else if (active && candidate.server_key === process.env[GJC_TMUX_OWNER_SERVER_KEY_ENV])
					candidateIntent = candidate;
			}
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") intentEvidencePresent = false;
			candidateIntent = null;
		}
		if (intentEvidencePresent && !candidateIntent && !expiredIntent) return;
		// One relay is enough for one exact intent. A replacement intent (including one
		// that reuses the dispatch id) must be allowed to re-arm the child relay.
		if (sigtermRelayed) {
			if (candidateIntent?.intent_id === relayedIntent?.intent_id) return;
			if (!candidateIntent && relayedIntent) return;
		}
		try {
			if (!childProcess.signalRoot(15)) return;
		} catch {
			// The child exited between intent capture and delivery.
			return;
		}
		sigtermRelayed = true;
		relayedAt = new Date().toISOString();
		relayedIntent = candidateIntent;
	};
	sigtermPending ||= bootstrapSigtermPending;
	process.removeListener("SIGTERM", captureBootstrapSigterm);
	process.removeListener("SIGTERM", captureEarlySigterm);
	process.on("SIGTERM", relaySigterm);
	if (sigtermPending) relaySigterm();
	const exitCode = await child.exited;
	childExited = true;
	process.removeListener("SIGTERM", relaySigterm);
	const terminalIntent = relayedIntent as OwnerIntent | null;
	const terminalObservedAt = new Date().toISOString();
	if (sigtermRelayed && terminalObservedAt && terminalIntent) {
		await observeOwnerTerminal({
			schema_version: 1,
			op: "observe_terminal",
			session_id: sessionId,
			owner_generation: generation,
			state_dir: stateDir,
			socket_key: process.env.GJC_TMUX_OWNER_SERVER_KEY ?? "",
			observer: "raw_monitor",
			observed_at: terminalObservedAt,
			signal: "SIGTERM",
			exit_code: exitCode,
			exit_kind: "supervisor_child_exit",
			reason: "managed_owner_supervisor_exit",
			operator_dispatch_id: terminalIntent.dispatch_id,
			operator_intent_id: terminalIntent.intent_id,
		});
	} else if (sigtermRelayed || child.signalCode || (exitCode !== 0 && exitCode !== 75)) {
		await observeOwnerTerminal({
			schema_version: 1,
			op: "observe_terminal",
			session_id: sessionId,
			owner_generation: generation,
			state_dir: stateDir,
			socket_key: process.env.GJC_TMUX_OWNER_SERVER_KEY ?? "",
			observer: "raw_monitor",
			observed_at: new Date().toISOString(),
			signal: normalizeTerminalSignal(child.signalCode),
			exit_code: exitCode,
			exit_kind: child.signalCode ?? "supervisor_child_exit",
			reason: "managed_owner_supervisor_unexpected_exit",
		}).catch(() => undefined);
	}
	if (child.signalCode === "SIGABRT") {
		if (binding) {
			const receipt: ManagedOwnerSigabrtReceipt = {
				schema_version: 2,
				generation,
				session_id: sessionId,
				run_id: runId,
				endpoint_incarnation: incarnation,
				child_token: childToken,
				command_sha256: binding.command_sha256,
				supervisor_pid: process.pid,
				supervisor_start_time: supervisorStartTime,
				child_pid: child.pid,
				child_start_time: childStartTime,
				signal: "SIGABRT",
				signal_number: 6,
				exit_code: exitCode,
				received_at: new Date().toISOString(),
			};
			await writeDurableExclusive(path.join(root, `sigabrt-${childToken}.receipt.json`), receipt);
		}
		process.exitCode = 134;
		return;
	}
	process.exitCode = exitCode;
}

function normalizeTerminalSignal(signal: NodeJS.Signals | null): TerminalSignal {
	if (signal === "SIGTERM" || signal === "SIGHUP" || signal === "SIGINT" || signal === "SIGKILL") return signal;
	if (signal === null) return "EXIT";
	return "UNKNOWN";
}
