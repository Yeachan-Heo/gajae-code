import * as stream from "node:stream";
import { AgentSideConnection, ndJsonStream, type Stream } from "@agentclientprotocol/sdk";
import { AcpAgent } from "./acp-agent";
import type { AcpStartupOptions } from "./startup-options";

export interface AcpModeOptions {
	agentDir?: string;
	startupOptions?: AcpStartupOptions;
}

export function createAcpConnection(transport: Stream, options: AcpModeOptions = {}): AgentSideConnection {
	return new AgentSideConnection(conn => new AcpAgent(conn, options), transport);
}

export async function runAcpMode(options: AcpModeOptions = {}): Promise<never> {
	const input = stream.Writable.toWeb(process.stdout);
	const output = stream.Readable.toWeb(process.stdin);
	const transport = ndJsonStream(input, output);
	const connection = createAcpConnection(transport, options);
	await connection.closed;
	process.exit(0);
}
