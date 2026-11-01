// Compiled entrypoint for the desktop host binary.
//
// The SDK runs its isolated shell worker chain through `process.execPath`, which
// for the app is this same binary (guardian -> supervisor -> runtime). Those
// internal modes must be dispatched before any desktop host setup: without it the
// worker lane starts a second desktop host, and its frames arrive on the worker
// pipe as unauthenticated protocol records, so every bash call fails.
import { runCli } from "@gajae-code/coding-agent/cli";
import {
	BASH_SHELL_RUNTIME_ARG,
	BASH_SHELL_SUPERVISOR_ARG,
	BASH_SHELL_WORKER_ARG,
} from "@gajae-code/coding-agent/exec/bash-shell-worker-protocol";

const internal = process.argv.length === 3 ? process.argv[2] : undefined;

if (internal === BASH_SHELL_WORKER_ARG) {
	const { runBashShellGuardian } = await import("@gajae-code/coding-agent/exec/bash-shell-guardian");
	await runBashShellGuardian();
} else if (internal === BASH_SHELL_SUPERVISOR_ARG) {
	const { runBashShellSupervisor } = await import("@gajae-code/coding-agent/exec/bash-shell-supervisor");
	await runBashShellSupervisor();
} else if (internal === BASH_SHELL_RUNTIME_ARG) {
	const { runBashShellWorker } = await import("@gajae-code/coding-agent/exec/bash-shell-worker");
	await runBashShellWorker();
} else if (process.argv[2] === "sdk") {
	// SDK broker/session-host launches use process.execPath, not PATH. The same
	// compiled image must serve those owned CLI modes without starting a second
	// desktop protocol host or stripping the SDK's child admission environment.
	await runCli(process.argv.slice(2));
} else {
	// Imported here so the desktop environment policy runs only for a real host
	// launch, never inside an internal worker process.
	const { main } = await import("./index");
	await main();
}
