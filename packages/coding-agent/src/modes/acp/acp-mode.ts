import * as stream from "node:stream";
import { AgentSideConnection, ndJsonStream, type Stream } from "@agentclientprotocol/sdk";
import type { AgentSession } from "../../session/agent-session";
import { AcpAgent } from "./acp-agent";

export type AcpSessionFactory = (cwd: string) => Promise<AgentSession>;

export interface AcpConnectionHandle {
	connection: AgentSideConnection;
	agent: AcpAgent;
}

export function createAcpConnection(
	transport: Stream,
	createSession: AcpSessionFactory,
	initialSession?: AgentSession,
): AgentSideConnection {
	return createAcpConnectionWithAgent(transport, createSession, initialSession).connection;
}

/**
 * Create an ACP connection and return both the {@link AgentSideConnection} and the
 * underlying {@link AcpAgent}. Callers that need to await agent shutdown (terminal
 * delete/dispose work) after transport closure should use this instead of
 * {@link createAcpConnection}.
 */
export function createAcpConnectionWithAgent(
	transport: Stream,
	createSession: AcpSessionFactory,
	initialSession?: AgentSession,
): AcpConnectionHandle {
	let agent: AcpAgent | undefined;
	const connection = new AgentSideConnection(conn => {
		agent = new AcpAgent(conn, createSession, initialSession);
		return agent;
	}, transport);
	return { connection, agent: agent! };
}

export async function runAcpMode(createSession: AcpSessionFactory, initialSession?: AgentSession): Promise<never> {
	const input = stream.Writable.toWeb(process.stdout);
	const output = stream.Readable.toWeb(process.stdin);
	const transport = ndJsonStream(input, output);
	const { connection, agent } = createAcpConnectionWithAgent(transport, createSession, initialSession);
	await connection.closed;
	// Await connection-local terminal work (active deletes, disposal) so
	// `process.exit` never kills in-flight deletion/cleanup.
	await agent.shutdownPromise;
	process.exit(0);
}
