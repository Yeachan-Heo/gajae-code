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
 * shells emit unconditionally. So there is no host sniffing and no env gate:
 * any host that wants agent status can parse the stream without gjc knowing it
 * exists.
 *
 * `notify;Terax;` is the wire identifier of the only protocol that currently
 * carries per-turn agent state, not a host check - the payload names gjc as the
 * reporting agent.
 *
 * Interactive TUI only. Print and RPC mode stdout stays byte-for-byte parseable
 * because they never reach these controllers.
 */

export type HostStatusEvent = "working" | "attention" | "finished";

function marker(event: HostStatusEvent): string {
	return `\x1b]777;notify;Terax;gjc;${event}\x07`;
}

export function emitHostStatus(
	event: HostStatusEvent,
	output: Pick<NodeJS.WriteStream, "write"> = process.stdout,
): void {
	try {
		output.write(marker(event));
	} catch {
		// Best-effort host integration only.
	}
}
