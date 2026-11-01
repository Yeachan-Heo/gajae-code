/**
 * Host-terminal agent status markers.
 *
 * Interactive turns can announce their state as an OSC 777 sequence:
 *
 *     ESC ] 777 ; notify;Terax;gjc;<event> BEL
 *
 * OSC 777 is the rxvt `notify` extension, not a private sequence: a terminal
 * that implements it does not discard the payload, it raises a desktop
 * notification. Ghostty parses `777;notify` in `osc/parsers/rxvt_extension.zig`
 * and maps it to `show_desktop_notification`, so emitting it unconditionally
 * made every turn pop notifications titled `Terax` in Ghostty and cmux.
 *
 * Emission is therefore opt-in. A host that wants per-turn agent status exports
 * `GJC_HOST_STATUS=terax` from its shell integration; every other host gets no
 * escape sequence at all. `notify;Terax;` is the wire identifier of that
 * protocol, and gjc is still named in the payload as the reporting agent.
 *
 * Interactive TUI only. Print and RPC mode stdout stays byte-for-byte parseable
 * because they never reach these controllers.
 */

export type HostStatusEvent = "working" | "attention" | "finished";

/** The host marker value that opts a terminal into agent-status markers. */
export const HOST_STATUS_MARKER_ENV = "GJC_HOST_STATUS";
const HOST_STATUS_MARKER_VALUE = "terax";

function marker(event: HostStatusEvent): string {
	return `\x1b]777;notify;Terax;gjc;${event}\x07`;
}

/** Whether the current host opted in to agent-status markers. */
export function hostStatusEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
	return env[HOST_STATUS_MARKER_ENV]?.trim().toLowerCase() === HOST_STATUS_MARKER_VALUE;
}

export function emitHostStatus(
	event: HostStatusEvent,
	output: Pick<NodeJS.WriteStream, "write"> = process.stdout,
	env: NodeJS.ProcessEnv = process.env,
): void {
	if (!hostStatusEnabled(env)) return;
	try {
		output.write(marker(event));
	} catch {
		// Best-effort host integration only.
	}
}
