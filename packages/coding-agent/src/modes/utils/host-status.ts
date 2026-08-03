/**
 * Host-terminal agent status markers.
 *
 * Terax runs `gjc` inside its own PTY and shows per-tab agent status. It reads
 * an OSC 777 marker (`notify;Terax;gjc;<event>`) from the PTY stream, so the
 * status is reported here rather than through the extension surface, which is
 * quarantined for filesystem-discovered modules.
 *
 * The marker is written only when the host advertises itself through
 * `TERAX_TERMINAL`; every other terminal sees nothing.
 */

export type HostStatusEvent = "working" | "attention" | "finished";

function marker(event: HostStatusEvent): string {
	return `\x1b]777;notify;Terax;gjc;${event}\x07`;
}

export function emitHostStatus(
	event: HostStatusEvent,
	output: Pick<NodeJS.WriteStream, "write"> = process.stdout,
): void {
	if (!process.env.TERAX_TERMINAL) return;
	try {
		output.write(marker(event));
	} catch {
		// Best-effort host integration only.
	}
}
