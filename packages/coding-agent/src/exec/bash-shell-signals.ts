import * as os from "node:os";

const NON_FATAL_OR_UNCATCHABLE_SIGNALS = new Set([
	"SIGCHLD",
	"SIGCONT",
	"SIGKILL",
	// Bun deliberately ignores SIGPIPE for pipe-backed runtime I/O. Turning it
	// into a fatal handler terminates healthy workers during ordinary protocol
	// teardown; because it cannot terminate this boundary, it is not an owned
	// fatal group-signal path.
	"SIGPIPE",
	"SIGSTOP",
	"SIGTSTP",
	"SIGTTIN",
	"SIGTTOU",
	"SIGURG",
	"SIGWINCH",
]);

export function fatalCatchableSignals(): NodeJS.Signals[] {
	return Object.keys(os.constants.signals).filter(
		(signal): signal is NodeJS.Signals => !NON_FATAL_OR_UNCATCHABLE_SIGNALS.has(signal),
	);
}

export function signalExitCode(signal: NodeJS.Signals): number | undefined {
	const number = os.constants.signals[signal];
	return typeof number === "number" ? 128 + number : undefined;
}
