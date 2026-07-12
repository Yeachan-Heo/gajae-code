import * as stream from "node:stream";
import { AgentSideConnection, ndJsonStream, type Stream } from "@agentclientprotocol/sdk";
import type { AgentSession } from "../../session/agent-session";
import { AcpAgent } from "./acp-agent";

export type AcpSessionFactory = (cwd: string) => Promise<AgentSession>;

/**
 * {@link AcpSessionFactory} bundled with the connection-wide explicit
 * `--session-dir` authority root. The descriptor is itself callable (it extends
 * {@link AcpSessionFactory}) so existing `(cwd) => …` call sites and test seams
 * keep working unchanged. {@link sessionDir}, when present, is the flat shared
 * root every per-CWD namespace resolves for its strict inventory/list/load
 * BEFORE any session is created — closing the fresh-connection scoped-list gap
 * where the configured `--session-dir` was previously unknown until the first
 * session/new. It is the authoritative source of truth: there is no heuristic
 * discovery from created/loaded sessions. Undefined means per-CWD default layout.
 */
export interface AcpSessionFactoryDescriptor extends AcpSessionFactory {
	readonly sessionDir?: string;
}

export interface AcpConnectionHandle {
	connection: AgentSideConnection;
	agent: AcpAgent;
}

export function createAcpConnection(
	transport: Stream,
	createSession: AcpSessionFactoryDescriptor,
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
	createSession: AcpSessionFactoryDescriptor,
	initialSession?: AgentSession,
): AcpConnectionHandle {
	let agent: AcpAgent | undefined;
	const connection = new AgentSideConnection(conn => {
		agent = new AcpAgent(conn, createSession, initialSession);
		return agent;
	}, transport);
	return { connection, agent: agent! };
}

export async function runAcpMode(
	createSession: AcpSessionFactoryDescriptor,
	initialSession?: AgentSession,
): Promise<never> {
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
