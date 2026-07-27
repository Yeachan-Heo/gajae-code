import * as stream from "node:stream";
import { AgentSideConnection, ndJsonStream, type Stream } from "@agentclientprotocol/sdk";
import { processIncarnation } from "../../sdk/broker/process-incarnation";
import { AcpAgent } from "./acp-agent";
import type { AcpStartupOptions } from "./startup-options";

export interface AcpModeOptions {
	agentDir?: string;
	startupOptions?: AcpStartupOptions;
}

export function createAcpConnection(transport: Stream, options: AcpModeOptions = {}): AgentSideConnection {
	// Session hosts outlive this process and a killed client sends no connection-close,
	// so publish the exact process identity they should watch before any host is launched.
	process.env.GJC_SDK_CLIENT_PID = String(process.pid);
	const incarnation = processIncarnation(process.pid);
	if (incarnation) process.env.GJC_SDK_CLIENT_INCARNATION = incarnation;
	else delete process.env.GJC_SDK_CLIENT_INCARNATION;
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
