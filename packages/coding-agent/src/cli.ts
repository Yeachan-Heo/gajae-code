#!/usr/bin/env bun

/** Lightweight CLI bootstrap. Heavy command registration is loaded only after
 * security admission; `gjc doctor` stays reachable when normal startup breaks. */
import { APP_NAME, formatBunRuntimeError, MIN_BUN_VERSION } from "@gajae-code/utils/dirs";
import {
	BASH_SHELL_RUNTIME_ARG,
	BASH_SHELL_SUPERVISOR_ARG,
	BASH_SHELL_WORKER_ARG,
} from "./exec/bash-shell-worker-protocol";


const MANAGED_OWNER_SUPERVISOR_ARG = "--internal-managed-owner-supervisor";
const MANAGED_OWNER_CHILD_TOKEN_ENV = "GJC_MANAGED_OWNER_CHILD_TOKEN";
const TMUX_OWNER_ISOLATION_ARG = "--internal-tmux-owner-isolation";

if (Bun.semver.order(Bun.version, MIN_BUN_VERSION) < 0) {
	process.stderr.write(
		formatBunRuntimeError({ currentVersion: Bun.version, minVersion: MIN_BUN_VERSION, execPath: process.execPath }),
	);
	process.exit(1);
}
process.title = APP_NAME;

function isDoctorArgv(argv: readonly string[]): boolean {
	return argv[0] === "doctor";
}

async function runDoctor(argv: string[]): Promise<void> {
	const { runDoctorCli } = await import("./cli/doctor-cli");
	await runDoctorCli(argv.slice(1));
}

/** Run the CLI with argv excluding process.argv prefix. */
export async function runCli(argv: string[]): Promise<void> {
	if (argv.length === 1 && argv[0] === BASH_SHELL_WORKER_ARG) {
		const { runBashShellGuardian } = await import("./exec/bash-shell-guardian");
		await runBashShellGuardian();
		return;
	}
	if (argv.length === 1 && argv[0] === BASH_SHELL_SUPERVISOR_ARG) {
		const { runBashShellSupervisor } = await import("./exec/bash-shell-supervisor");
		await runBashShellSupervisor();
		return;
	}
	if (argv.length === 1 && argv[0] === BASH_SHELL_RUNTIME_ARG) {
		const { runBashShellWorker } = await import("./exec/bash-shell-worker");
		await runBashShellWorker();
		return;
	}
	if (
		process.platform === "darwin" &&
		process.env.GJC_MALLOC_ENV_REEXEC === undefined &&
		(process.env.MallocStackLogging !== undefined || process.env.MallocStackLoggingNoCompact !== undefined)
	) {
		const { reexecWithScrubbedMallocEnv } = await import("./cli/malloc-env-guard");
		const code = await reexecWithScrubbedMallocEnv();
		if (code !== null) {
			process.exitCode = code;
			return;
		}
	}
	if (argv.length === 3 && argv[0] === "internal" && argv[1] === "memory-guard-native-smoke" && argv[2] === "--json") {
		const { runMemoryGuardNativeSmoke } = await import("./cli/native-smoke");
		runMemoryGuardNativeSmoke();
		return;
	}
	if (argv.length === 1 && argv[0] === TMUX_OWNER_ISOLATION_ARG) {
		const { runTmuxOwnerIsolationCliFromStdin } = await import("./gjc-runtime/tmux-owner-isolation-cli");
		await runTmuxOwnerIsolationCliFromStdin();
		return;
	}
	if (argv.length === 1 && argv[0] === MANAGED_OWNER_SUPERVISOR_ARG) {
		const { runManagedOwnerSupervisor } = await import("./gjc-runtime/managed-owner-supervisor");
		await runManagedOwnerSupervisor();
		return;
	}
	if (process.env[MANAGED_OWNER_CHILD_TOKEN_ENV] !== undefined) {
		const { admitManagedOwnerBeforeCli, completeManagedOwnerRecovery } = await import(
			"./gjc-runtime/managed-owner-admission"
		);
		const admission = await admitManagedOwnerBeforeCli();
		if (admission.kind === "blocked") return;
		if (admission.kind === "recovery") {
			await completeManagedOwnerRecovery(admission.context);
			return;
		}
	}
	if (argv[0] === "--internal-doctor-worker") {
		// Non-forgeable route: reachable only with the exact per-spawn token env var
		// AND a non-TTY stdin (isRoutableDoctorWorkerInvocation), so a user's own
		// interactive terminal can never land on the worker's confirmation-refusal
		// path merely by passing this argv marker.
		const { isRoutableDoctorWorkerInvocation, runDoctorWorker } = await import("./cli/doctor-worker");
		if (argv.length !== 1 || !isRoutableDoctorWorkerInvocation(process.env, process.stdin.isTTY)) {
			process.stderr.write("gjc doctor: invalid internal worker invocation\n");
			process.exitCode = 2;
			return;
		}
		await runDoctorWorker();
		return;
	}
	if (argv[0] === "--internal-doctor-probe") {
		if (argv.length !== 2 || (argv[1] !== "native" && argv[1] !== "projection")) {
			process.stderr.write("gjc doctor: invalid internal probe invocation\n");
			process.exitCode = 2;
			return;
		}
		try {
			const { runDoctorProbe } = await import("./cli/doctor/probe");
			await runDoctorProbe(argv[1]);
		} catch {
			process.stderr.write("gjc doctor: internal probe unavailable\n");
			process.exitCode = 3;
		}
		return;
	}
	if (isDoctorArgv(argv)) {
		await runDoctor(argv);
		return;
	}
	const { runCliAfterAdmission } = await import("./cli-main");
	await runCliAfterAdmission(argv);
}

if (import.meta.main) await runCli(process.argv.slice(2));
