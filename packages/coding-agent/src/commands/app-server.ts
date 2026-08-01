import { Command, Flags } from "@gajae-code/utils/cli";
import {
	type AppServerCliArgs,
	generateJsonSchema,
	generateTs,
	resolveAppServerArgs,
	runStdioServer,
} from "../app-server/cli/runtime";
import { type AppServerConnection, createAppServerRuntime } from "../app-server/create-app-server";
import { createProductionThreadStartAdapter } from "../app-server/thread-runtime/production-child";
import { checkWsAuth, type WsAuthConfig } from "../app-server/transport/auth";

export interface AppServerWebSocket {
	send(frame: Uint8Array): number;
	close?(code?: number, reason?: string): void;
}

export interface AppServerWebSocketWriter {
	readonly writer: (frame: Uint8Array) => Promise<void>;
	drain(): void;
	fail(error: Error): void;
}

/** Adapts Bun's synchronous send status into the app-server's awaitable writer contract. */
export function createAppServerWebSocketWriter(ws: AppServerWebSocket): AppServerWebSocketWriter {
	let waiting: PromiseWithResolvers<void> | undefined;
	let failure: Error | undefined;
	return {
		writer: async frame => {
			if (failure) throw failure;
			const status = ws.send(frame);
			if (status > 0) return;
			if (status === 0) throw new Error("WebSocket dropped outbound app-server frame");
			waiting ??= Promise.withResolvers<void>();
			await waiting.promise;
			if (failure) throw failure;
		},
		drain: () => {
			waiting?.resolve();
			waiting = undefined;
		},
		fail: error => {
			failure ??= error;
			waiting?.reject(failure);
			waiting = undefined;
		},
	};
}

/** Close a peer that sent a malformed or oversized framed message. */
export function closeRejectedWebSocket(ws: AppServerWebSocket, reason: "malformed" | "oversize"): void {
	if (reason === "oversize") ws.close?.(1009, "Message too big");
	else ws.close?.(1002, "Protocol error");
}

function handleTransportFailure(connection: AppServerConnection, error: unknown): void {
	void connection.close().catch(closeError => {
		process.stderr.write(`app-server: failed to close transport after error: ${String(closeError)}\n`);
	});
	process.stderr.write(`app-server: transport connection failed: ${String(error)}\n`);
}

function unauthorizedUpgradeResponse(request: Request, wsAuth: WsAuthConfig | undefined): Response | undefined {
	if (!wsAuth) return undefined;
	try {
		const result = checkWsAuth(wsAuth, Object.fromEntries(request.headers.entries()));
		if (result.ok) return undefined;
		return new Response("Unauthorized", {
			status: result.statusCode,
			headers: result.wwwAuthenticate ? { "WWW-Authenticate": result.wwwAuthenticate } : undefined,
		});
	} catch {
		return new Response("Service Unavailable", { status: 503 });
	}
}

export default class AppServer extends Command {
	static description = "Run the gjc app-server — a JSON-RPC protocol subset in progress.";
	static strict = false;
	static flags = {
		stdio: Flags.boolean({ description: "Use stdio transport (default)" }),
		listen: Flags.string({
			description:
				"Listen URL: stdio:// (default), ws://IP:PORT, unix://PATH, or off. Non-loopback ws:// requires --ws-auth; loopback ws:// and unix:// may omit it for local development and filesystem-permission-protected sockets.",
		}),
		"ws-auth": Flags.string({
			description: "WebSocket auth mode required for non-loopback ws://: capability-token|signed-bearer-token",
		}),
		"ws-token-file": Flags.string({ description: "Capability token file path" }),
		"ws-token-sha256": Flags.string({ description: "Expected SHA-256 of the capability token" }),
		"ws-shared-secret-file": Flags.string({ description: "Signed-bearer shared secret file path" }),
		"ws-issuer": Flags.string({ description: "Expected JWT issuer (iss)" }),
		"ws-audience": Flags.string({ description: "Expected JWT audience (aud)" }),
		"ws-max-clock-skew-seconds": Flags.string({ description: "Max clock skew for exp/nbf" }),
		"max-frame-bytes": Flags.string({ description: "Maximum inbound frame size in bytes" }),
		"max-loaded-threads": Flags.string({ description: "Maximum number of loaded threads" }),
		out: Flags.string({ description: "Output directory for generate-ts / generate-json-schema" }),
	};
	static examples = [
		"$ gjc app-server --stdio",
		"$ gjc app-server --listen ws://127.0.0.1:8080",
		"$ gjc app-server --listen unix:///tmp/app-server.sock",
		"$ gjc app-server --listen off",
		"$ gjc app-server generate-ts --out ./generated",
		"$ gjc app-server generate-json-schema --out ./schema",
	];

	async run(): Promise<void> {
		const { flags } = await this.parse(AppServer);
		const subcommand = this.argv[0];

		// Subcommands: generate-ts, generate-json-schema
		if (subcommand === "generate-ts") {
			const out = flags.out ?? ".";
			await generateTs(out);
			return;
		}
		if (subcommand === "generate-json-schema") {
			const out = flags.out ?? ".";
			await generateJsonSchema(out);
			return;
		}

		// Server modes
		const args: AppServerCliArgs = {
			listen: flags.listen as string | undefined,
			stdio: flags.stdio as boolean | undefined,
			maxFrameBytes: flags["max-frame-bytes"] as string | undefined,
			maxLoadedThreads: flags["max-loaded-threads"] as string | undefined,
			wsAuth: flags["ws-auth"] as string | undefined,
			wsTokenFile: flags["ws-token-file"] as string | undefined,
			wsTokenSha256: flags["ws-token-sha256"] as string | undefined,
			wsSharedSecretFile: flags["ws-shared-secret-file"] as string | undefined,
			wsIssuer: flags["ws-issuer"] as string | undefined,
			wsAudience: flags["ws-audience"] as string | undefined,
			wsMaxClockSkewSeconds: flags["ws-max-clock-skew-seconds"] as string | undefined,
		};
		const config = resolveAppServerArgs(args);
		if (config.mode.kind === "stdio") {
			return runStdioServer(config);
		}
		if (config.mode.kind === "off") {
			// Valid standalone mode: no transport, no probes, idle until signal.
			return new Promise(resolve => {
				process.on("SIGTERM", () => {
					process.exitCode = 0;
					resolve();
				});
				process.on("SIGINT", () => {
					process.exitCode = 0;
					resolve();
				});
			});
		}
		// ws:// and unix:// listeners: bind a Bun WebSocket server.
		if (config.mode.kind === "ws") {
			const { host, port } = config.mode;
			const runtime = createAppServerRuntime(
				{ maxLoadedThreads: config.maxLoadedThreads },
				{ maxFrameBytes: config.maxFrameBytes },
				{ threadStartAdapter: createProductionThreadStartAdapter() },
			);

			const wsServer = Bun.serve({
				port,
				hostname: host,
				fetch(req, server) {
					// Health probes (no Origin header required for /readyz and /healthz).
					const url = new URL(req.url);
					const origin = req.headers.get("origin");
					if (origin) return new Response("Forbidden", { status: 403 });
					if (req.method === "GET" && (url.pathname === "/readyz" || url.pathname === "/healthz")) {
						return new Response("OK", { status: 200 });
					}
					const unauthorized = unauthorizedUpgradeResponse(req, config.wsAuth);
					if (unauthorized) return unauthorized;
					if (server.upgrade(req)) return;
					return new Response("Not Found", { status: 404 });
				},
				websocket: {
					open(ws) {
						const writer = createAppServerWebSocketWriter(ws);
						(ws as unknown as { _connection: AppServerConnection; _writer: AppServerWebSocketWriter })._writer =
							writer;
						(
							ws as unknown as { _connection: AppServerConnection; _writer: AppServerWebSocketWriter }
						)._connection = runtime.createConnection(writer.writer, "websocket", reason =>
							closeRejectedWebSocket(ws, reason),
						);
					},
					message(ws, message) {
						const connection = (ws as unknown as { _connection: AppServerConnection })._connection;
						const text = typeof message === "string" ? message : new TextDecoder().decode(message);
						void connection
							.process(new TextEncoder().encode(text))
							.catch(error => handleTransportFailure(connection, error));
					},
					drain(ws) {
						(ws as unknown as { _writer: AppServerWebSocketWriter })._writer.drain();
					},
					close(ws) {
						const socket = ws as unknown as {
							_connection: AppServerConnection;
							_writer: AppServerWebSocketWriter;
						};
						socket._writer.fail(new Error("WebSocket closed"));
						void socket._connection.close().catch(error => handleTransportFailure(socket._connection, error));
					},
				},
			});
			process.stderr.write(`app-server: ws:// listening on ${host}:${port}\n`);
			return new Promise(resolve => {
				let shuttingDown = false;
				const shutdown = (): void => {
					if (shuttingDown) return;
					shuttingDown = true;
					wsServer.stop();
					void runtime.close().then(resolve, resolve);
				};
				process.on("SIGTERM", shutdown);
				process.on("SIGINT", shutdown);
			});
		}
		// unix:// — same WebSocket-over-Unix semantics.
		if (config.mode.kind === "unix" && config.mode.path) {
			const socketPath = config.mode.path;
			const runtime = createAppServerRuntime(
				{ maxLoadedThreads: config.maxLoadedThreads },
				{ maxFrameBytes: config.maxFrameBytes },
				{ threadStartAdapter: createProductionThreadStartAdapter() },
			);
			const wsServer = Bun.serve({
				unix: socketPath,
				fetch(req, server) {
					const url = new URL(req.url);
					const origin = req.headers.get("origin");
					if (origin) return new Response("Forbidden", { status: 403 });
					if (req.method === "GET" && (url.pathname === "/readyz" || url.pathname === "/healthz")) {
						return new Response("OK", { status: 200 });
					}
					const unauthorized = unauthorizedUpgradeResponse(req, config.wsAuth);
					if (unauthorized) return unauthorized;
					if (server.upgrade(req)) return;
					return new Response("Not Found", { status: 404 });
				},
				websocket: {
					open(ws) {
						const writer = createAppServerWebSocketWriter(ws);
						(ws as unknown as { _connection: AppServerConnection; _writer: AppServerWebSocketWriter })._writer =
							writer;
						(
							ws as unknown as { _connection: AppServerConnection; _writer: AppServerWebSocketWriter }
						)._connection = runtime.createConnection(writer.writer, "unix", reason =>
							closeRejectedWebSocket(ws, reason),
						);
					},
					message(ws, message) {
						const connection = (ws as unknown as { _connection: AppServerConnection })._connection;
						const text = typeof message === "string" ? message : new TextDecoder().decode(message);
						void connection
							.process(new TextEncoder().encode(text))
							.catch(error => handleTransportFailure(connection, error));
					},
					drain(ws) {
						(ws as unknown as { _writer: AppServerWebSocketWriter })._writer.drain();
					},
					close(ws) {
						const socket = ws as unknown as {
							_connection: AppServerConnection;
							_writer: AppServerWebSocketWriter;
						};
						socket._writer.fail(new Error("WebSocket closed"));
						void socket._connection.close().catch(error => handleTransportFailure(socket._connection, error));
					},
				},
			});
			process.stderr.write(`app-server: unix:// listening on ${socketPath}\n`);
			return new Promise(resolve => {
				let shuttingDown = false;
				const shutdown = (): void => {
					if (shuttingDown) return;
					shuttingDown = true;
					wsServer.stop();
					void runtime.close().then(resolve, resolve);
				};
				process.on("SIGTERM", shutdown);
				process.on("SIGINT", shutdown);
			});
		}
	}
}
