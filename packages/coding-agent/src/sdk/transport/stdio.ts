import type { ServeHandle, ServeOptions } from "./index";
import { startRelayPair } from "./relay";

function writeDiagnostic(value: unknown): void {
	process.stderr.write(`${JSON.stringify(value)}\n`);
}

/** Serves one parent-owned JSONL connection over the process standard streams. */
export async function startStdioServe(options: ServeOptions): Promise<ServeHandle> {
	const pair = await startRelayPair({
		...options,
		downstream: process.stdin,
		downstreamSink: process.stdout,
		onTransportError: writeDiagnostic,
	});
	return { close: pair.close, done: pair.done };
}
