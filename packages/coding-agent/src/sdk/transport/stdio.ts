import type { Readable, Writable } from "node:stream";
import type { ServeHandle, ServeOptions } from "./index";
import { startRelayPair } from "./relay";

function writeDiagnostic(value: unknown): void {
	process.stderr.write(`${JSON.stringify(value)}\n`);
}

/** Serves one parent-owned JSONL connection over the process standard streams. */
export async function startStdioServe(
	options: ServeOptions,
	streams: { readonly input?: Readable; readonly output?: Writable } = {},
): Promise<ServeHandle> {
	const pair = await startRelayPair({
		...options,
		downstream: streams.input ?? process.stdin,
		downstreamSink: streams.output ?? process.stdout,
		onTransportError: writeDiagnostic,
	});
	return { close: pair.close, done: pair.done };
}
