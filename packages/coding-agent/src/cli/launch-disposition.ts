export type LaunchMode = "text" | "json" | "acp";

export interface LaunchDisposition {
	autoPrint: boolean;
	isInteractive: boolean;
	/** Set when an interactive launch is impossible (non-TTY stdin, nothing to run). */
	nonInteractiveError?: string;
}

/**
 * Decides between interactive, auto-print, and fail-fast launches.
 *
 * A non-TTY stdin means the TUI can never receive input, so an interactive
 * launch would execute the initial prompt and then block in the event loop
 * forever. Prepared command-line input degrades to print mode; without any
 * input to run we fail fast instead of hanging. Explicit `--print` and
 * `--mode` launches are left untouched.
 */
export function resolveLaunchDisposition(args: {
	stdinIsTTY: boolean | undefined;
	pipedInput: string | undefined;
	hasPreparedInput: boolean;
	print: boolean;
	mode: LaunchMode | undefined;
}): LaunchDisposition {
	const explicitNonInteractive = args.print || args.mode !== undefined;
	const hasPreparedInput = args.pipedInput !== undefined || args.hasPreparedInput;
	const hasNonTtyStdin = args.stdinIsTTY !== true;
	const autoPrint = !explicitNonInteractive && hasNonTtyStdin && hasPreparedInput;
	const isInteractive = !explicitNonInteractive && !autoPrint;

	if (isInteractive && args.stdinIsTTY !== true) {
		return {
			autoPrint: false,
			isInteractive: false,
			nonInteractiveError:
				"stdin is not a TTY and no prompt or prepared input was provided; use -p/--print (or pass a prompt or @file) for non-interactive runs.",
		};
	}

	return { autoPrint, isInteractive };
}
