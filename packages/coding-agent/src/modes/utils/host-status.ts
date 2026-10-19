/**
 * Host-terminal agent status markers.
 *
 * Interactive turns announce their state as an OSC 777 sequence:
 *
 *     ESC ] 777 ; notify;Terax;gjc;<event> BEL
 *
 * A terminal that understands the sequence (Terax reads it to drive its per-tab
 * agent status and header bell) reacts; every other terminal discards the OSC
 * as unknown, exactly like the OSC 133 prompt marks and OSC 7 cwd reports that
 * shells emit unconditionally.
 *
 * The sequence is only emitted inside a Terax-hosted terminal, which announces
 * itself with `TERAX_TERMINAL=1` in the environment of every shell it spawns.
 * That gate matters because OSC 777 `notify;` is the rxvt extension, and
 * terminals that implement it (Ghostty among them) turn it into a desktop
 * notification rather than discarding it. Emitting the marker unconditionally
 * made every other host show a "Terax" notification on every turn.
 *
 * `notify;Terax;` is the wire identifier of the only protocol that currently
 * carries per-turn agent state, not a host check - the payload names gjc as the
 * reporting agent.
 *
 * Interactive TUI only. Print and RPC mode stdout stays byte-for-byte parseable
 * because they never reach these controllers.
 */

export type HostStatusEvent = "working" | "attention" | "finished";

/**
 * Whether the hosting terminal is Terax.
 *
 * Terax exports `TERAX_TERMINAL=1` into the shells it spawns, so the variable
 * is inherited by every process those shells start, including gjc. A terminal
 * that does not set it never receives the marker, so it never raises the
 * notification that the rxvt `notify;` extension would otherwise produce.
 */
function teraxHost(): boolean {
	const value = process.env.TERAX_TERMINAL;
	return value !== undefined && value !== "";
}

function marker(event: HostStatusEvent): string {
	return `\x1b]777;notify;Terax;gjc;${event}\x07`;
}

export function emitHostStatus(
	event: HostStatusEvent,
	output: Pick<NodeJS.WriteStream, "write"> = process.stdout,
): void {
	if (!teraxHost()) return;
	try {
		output.write(marker(event));
	} catch {
		// Best-effort host integration only.
	}
}
