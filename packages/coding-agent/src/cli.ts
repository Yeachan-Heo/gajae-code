#!/usr/bin/env bun

import type { CommandEntry } from "@gajae-code/utils/cli";
/** Lightweight CLI bootstrap. Heavy command registration is loaded only after
 * security admission; `gjc doctor` stays reachable when normal startup breaks. */
import { APP_NAME, formatBunRuntimeError, MIN_BUN_VERSION, VERSION } from "@gajae-code/utils/dirs";
import { startTiming } from "@gajae-code/utils/logger";
import {
	BASH_SHELL_RUNTIME_ARG,
	BASH_SHELL_SUPERVISOR_ARG,
	BASH_SHELL_WORKER_ARG,
} from "./exec/bash-shell-worker-protocol";
import { runSdkStderrDrainerFromArgv } from "./sdk/broker/stderr-drainer";

const MANAGED_OWNER_SUPERVISOR_ARG = "--internal-managed-owner-supervisor";
const MANAGED_OWNER_CHILD_TOKEN_ENV = "GJC_MANAGED_OWNER_CHILD_TOKEN";
const TMUX_OWNER_ISOLATION_ARG = "--internal-tmux-owner-isolation";

// Anchor startup timing before the heavy CLI module graph is loaded so the
// printed tree includes runtime/bootstrap costs as well as dispatch work.
if (process.env.GJC_TIMING || process.env.PI_TIMING) {
	startTiming();
}

if (Bun.semver.order(Bun.version, MIN_BUN_VERSION) < 0) {
	process.stderr.write(
		formatBunRuntimeError({ currentVersion: Bun.version, minVersion: MIN_BUN_VERSION, execPath: process.execPath }),
	);
	process.exit(1);
}
process.title = APP_NAME;

/** Public-family hooks kept available for private-worker tests without loading the full registry. */
export const commands: CommandEntry[] = [
	{ name: "sdk", load: () => import("./commands/sdk").then(module => module.default) },
	{ name: "daemon", load: () => import("./commands/daemon").then(module => module.default) },
];

async function installRuntimeGlobals(writeNoFileWarning?: (text: string) => void): Promise<void> {
	const { installH2Fetch } = await import("@gajae-code/ai/utils/h2-fetch");
	// Activate HTTP/2 for all `fetch()` calls (provider streams, OAuth, model
	// discovery, web tools). Bun's HTTP/2 client is gated on a startup flag we
	// can't toggle from JS, so we patch globalThis.fetch to pass
	// `protocol: "http2"` per request, with transparent HTTP/1.1 fallback on
	// `HTTP2Unsupported`. See @gajae-code/ai/utils/h2-fetch for details.
	installH2Fetch();

	const { warnIfMacOSNoFileLimitTooLow } = await import("./cli/nofile-limit");
	warnIfMacOSNoFileLimitTooLow({ writeStderr: writeNoFileWarning });

	// Secondary in-process scrub of the macOS malloc-stack-logging vars. The real
	// boundary is the darwin re-exec guard at the top of runCli(): Bun snapshots the
	// spawn-default environment at startup, so deleting these here does NOT clean the
	// env children inherit by default — it only tidies `process.env` for code that
	// reads it directly. Kept as belt-and-braces for the rare re-exec-unavailable
	// fallback; managed spawns already use filterProcessEnv and the native PTY lane
	// strips them independently.
	delete process.env.MallocStackLogging;
	delete process.env.MallocStackLoggingNoCompact;
}

async function dispatchPublicFamily(argv: string[]): Promise<void> {
	const family = argv[0];
	if (family !== "sdk" && family !== "daemon") return;
	const { dispatchPublicCommand } = await import("./cli/public-command-entry");
	const load = commands.find(entry => entry.name === family)!.load;
	await dispatchPublicCommand(argv.slice(1), {
		bin: APP_NAME,
		version: VERSION,
		command: family,
		load,
		setup: report => installRuntimeGlobals(text => report({ code: "macos_nofile_limit_low", successStderr: text })),
	});
}

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
	if (argv[0] === "sdk" && argv[1] === "stderr-drain-internal") {
		// Private lifecycle stderr drainer: must stay ahead of the public sdk family
		// dispatcher, which would otherwise reject the private argv as a usage error.
		try {
			await runSdkStderrDrainerFromArgv(argv.slice(2));
		} catch {
			process.stderr.write("gjc sdk: invalid internal stderr drainer invocation\n");
			process.exitCode = 2;
		}
		return;
	}
	if (argv[0] === "sdk" || argv[0] === "daemon") {
		await dispatchPublicFamily(argv);
		return;
	}
	if (argv.length === 1 && argv[0] === "--supports-macos-community-app") {
		process.stdout.write("macos-community-app-offer\n");
		return;
	}
	if (argv.length === 1 && argv[0] === "--internal-macos-community-app-offer") {
		try {
			const { offerMacosCommunityApp } = await import("./cli/macos-community-app");
			await offerMacosCommunityApp({ log: message => process.stderr.write(`${message}\n`) });
		} catch {
			const { COMMUNITY_APP_REPOSITORY } = await import("./cli/macos-community-app");
			process.stderr.write(
				`Optional community app offer failed; GJC remains installed. https://github.com/${COMMUNITY_APP_REPOSITORY}\n`,
			);
		}
		return;
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
