import * as stream from "node:stream";
import { type Agent, AgentSideConnection, ndJsonStream, type Stream } from "@agentclientprotocol/sdk";
import { AcpAgent, acpRequestFailure } from "./acp-agent";
import type { AcpStartupOptions } from "./startup-options";

export interface AcpModeOptions {
	agentDir?: string;
	startupOptions?: AcpStartupOptions;
}

/**
 * Every agent method reports failures to the client, and the SDK only derives a
 * JSON-RPC code from a `RequestError` — anything else collapses to an opaque
 * `-32603 Internal error` with the reason buried in `data`. Translating once at the
 * connection boundary keeps that contract in one place instead of asking each method
 * to remember it.
 */
function withAcpRequestFailures(agent: AcpAgent): Agent {
	const wrapped = new Map<string | symbol, (...args: unknown[]) => unknown>();
	return new Proxy(agent, {
		get(target, property) {
			// Read against the target, not the proxy: `signal`/`closed` are getters that
			// touch private fields, and the proxy carries no private-field brand.
			const value = Reflect.get(target, property, target);
			if (typeof value !== "function") return value;
			const cached = wrapped.get(property);
			if (cached) return cached;
			// Cache per property so repeated reads keep a stable method identity.
			const wrapper = (...args: unknown[]) => {
				try {
					const result = (value as (...a: unknown[]) => unknown).apply(target, args);
					return result instanceof Promise
						? result.catch((error: unknown) => {
								throw acpRequestFailure(error);
							})
						: result;
				} catch (error) {
					throw acpRequestFailure(error);
				}
			};
			wrapped.set(property, wrapper);
			return wrapper;
		},
	}) as unknown as Agent;
}

export function createAcpConnection(transport: Stream, options: AcpModeOptions = {}): AgentSideConnection {
	return new AgentSideConnection(conn => withAcpRequestFailures(new AcpAgent(conn, options)), transport);
}

export async function runAcpMode(options: AcpModeOptions = {}): Promise<never> {
	const input = stream.Writable.toWeb(process.stdout);
	const output = stream.Readable.toWeb(process.stdin);
	const transport = ndJsonStream(input, output);
	const connection = createAcpConnection(transport, options);
	await connection.closed;
	process.exit(0);
}
