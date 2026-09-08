import * as crypto from "node:crypto";
import * as fsSync from "node:fs";
import * as path from "node:path";
import { readOwnerOnlyFile, verifyOwnerOnlyPathSecurity } from "@gajae-code/natives";
import { nativeProcessBindings } from "@gajae-code/utils/native-process";
import { prepareManagedDirectoryRoot, publishManagedFileNoReplace } from "../session/internal/managed-session-storage";
import { readLinuxProcStartTime } from "./linux-proc";
import {
	isManagedOwnerBinding,
	type ManagedOwnerBinding,
	type ManagedOwnerSigabrtReceipt,
	managedOwnerCommandDigest,
} from "./managed-owner-binding";
import { assertSafePathComponent } from "./session-layout";
import { lifecyclePaths, type OwnerIntent, observeOwnerTerminal } from "./tmux-owner-isolation";

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

let bootstrapSigtermPending = false;
const captureBootstrapSigterm = () => {
	bootstrapSigtermPending = true;
};
if (process.argv.includes(MANAGED_OWNER_SUPERVISOR_ARG)) {
	process.removeAllListeners("SIGTERM");
	process.on("SIGTERM", captureBootstrapSigterm);
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
	if (!path.isAbsolute(stateDir) || stateDir.includes("\0") || stateDir.split(path.sep).includes(".."))
		throw new Error("managed_owner_lifecycle_path_unsafe");
	const root = lifecyclePaths(stateDir, sessionId, generation).root;
	if (!root.startsWith(`${path.resolve(stateDir)}${path.sep}`)) throw new Error("managed_owner_lifecycle_path_unsafe");
	return { root, stateDir, generation, sessionId, runId, incarnation };
}

async function managedOwnerProcessProvenance(pid: number): Promise<string | null> {
	if (process.platform === "linux") return await readLinuxProcStartTime(pid);
	return nativeProcessBindings().Process.fromPid(pid)?.incarnation ?? null;
}

async function writeDurableExclusive(file: string, value: object): Promise<void> {
	const root = path.dirname(file);
	const assertSafe = () => {
		if (!verifyOwnerOnlyPathSecurity(root, "directory").ok) throw new Error("managed_owner_storage_unsafe");
	};
	assertSafe();
	const authority = prepareManagedDirectoryRoot(root);
	const bytes = Buffer.from(`${JSON.stringify(value)}\n`);
	if (bytes.length > 65536) throw new Error("managed_owner_binding_too_large");
	await publishManagedFileNoReplace(file, bytes, assertSafe, authority);
	const persisted = readOwnerOnlyFile(file, 65536);
	if (!persisted.ok || !persisted.data || !bytes.equals(Buffer.from(persisted.data)))
		throw new Error("managed_owner_durable_reread_failed");
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

/** Runs one exact child and publishes authority only for a directly observed Linux signal 6. */
export async function runManagedOwnerSupervisor(): Promise<void> {
	try {
		await superviseManagedOwner();
	} catch {
		// Spawn and JSON errors can contain opaque command bytes.
		throw new Error("managed_owner_supervisor_failed");
	}
}

async function superviseManagedOwner(): Promise<void> {
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
	if (!verifyOwnerOnlyPathSecurity(root, "directory").ok) throw new Error("managed_owner_storage_unsafe");
	const childToken = crypto.randomUUID();
	const redactCommand = process.env[MANAGED_OWNER_REDACT_COMMAND_ENV] === "1";
	const binding: ManagedOwnerBinding = {
		schema_version: 3,
		generation,
		session_id: sessionId,
		run_id: runId,
		endpoint_incarnation: incarnation,
		child_token: childToken,
		...(redactCommand
			? { binding_kind: "opaque" as const }
			: {
					binding_kind: "recoverable" as const,
					command,
					command_sha256: managedOwnerCommandDigest(command),
				}),
		supervisor_pid: process.pid,
		supervisor_start_time: supervisorStartTime,
		created_at: new Date().toISOString(),
	};
	if (!isManagedOwnerBinding(binding)) throw new Error("managed_owner_binding_invalid");
	await writeDurableExclusive(path.join(root, `child-${childToken}.binding.json`), binding);
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
			if (process.platform === "linux" && binding.binding_kind === "recoverable") {
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
		if (childExited || sigtermRelayed) return;
		let candidateIntent: OwnerIntent | null = null;
		try {
			const candidate = JSON.parse(
				fsSync.readFileSync(lifecyclePaths(stateDir, sessionId, generation).intentFile, "utf8"),
			) as Partial<OwnerIntent>;
			candidateIntent = typeof candidate.dispatch_id === "string" ? (candidate as OwnerIntent) : null;
		} catch {
			candidateIntent = null;
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
	const terminalObservedAt = relayedAt as string | null;
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
		});
	}
	if (child.signalCode === "SIGABRT") {
		if (process.platform === "linux" && binding.binding_kind === "recoverable") {
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
