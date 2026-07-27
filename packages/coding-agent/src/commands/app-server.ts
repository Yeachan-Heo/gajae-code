import { Command, Flags } from "@gajae-code/utils/cli";
import { resolveAppServerArgs, runStdioServer, generateTs, generateJsonSchema, type AppServerCliArgs } from "../app-server/cli/runtime";
import { createAppServer } from "../app-server/create-app-server";

export default class AppServer extends Command {
	static description = "Run the gjc app-server — a JSON-RPC server with 100% codex app-server interface parity.";
	static strict = false;
	static flags = {
		stdio: Flags.boolean({ description: "Use stdio transport (default)" }),
		listen: Flags.string({ description: "Listen URL: stdio:// (default), ws://IP:PORT, unix://PATH, or off" }),
		"ws-auth": Flags.string({ description: "WebSocket auth mode: capability-token|signed-bearer-token" }),
		"ws-token-file": Flags.string({ description: "Capability token file path" }),
		"ws-token-sha256": Flags.string({ description: "Expected SHA-256 of the capability token" }),
		"ws-shared-secret-file": Flags.string({ description: "Signed-bearer shared secret file path" }),
		"ws-issuer": Flags.string({ description: "Expected JWT issuer (iss)" }),
		"ws-audience": Flags.string({ description: "Expected JWT audience (aud)" }),
		"ws-max-clock-skew-seconds": Flags.string({ description: "Max clock skew for exp/nbf" }),
		"max-frame-bytes": Flags.string({ description: "Maximum inbound frame size in bytes" }),
		"max-loaded-threads": Flags.string({ description: "Maximum number of loaded threads" }),
		out: Flags.string({ description: "Output directory for generate-ts / generate-json-schema" }),
		json: Flags.boolean({ description: "Output JSON" }),
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
		const server = createAppServer({ maxLoadedThreads: config.maxLoadedThreads }, { maxFrameBytes: config.maxFrameBytes });

		if (config.mode.kind === "stdio") {
			const readline = require("node:readline");
			const rl = readline.createInterface({ input: process.stdin, terminal: false });
			rl.on("line", (line: string) => {
				const result = server.process(new TextEncoder().encode(line), "stdio");
				if (result.response) process.stdout.write(result.response);
			});
			return new Promise(resolve => { rl.on("close", () => resolve()); });
		}
		if (config.mode.kind === "off") {
			// Valid standalone mode: no transport, no probes, idle until signal.
			return new Promise(resolve => {
				process.on("SIGTERM", () => { process.exitCode = 0; resolve(); });
				process.on("SIGINT", () => { process.exitCode = 0; resolve(); });
			});
		}
		// ws:// and unix:// listeners: bind a Bun WebSocket server.
		if (config.mode.kind === "ws") {
			const { host, port } = config.mode;
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
					if (server.upgrade(req)) return;
					return new Response("Not Found", { status: 404 });
				},
				websocket: {
					open(ws) {
						// Each connection gets its own connection state via a fresh AppServer.
						(ws as unknown as { _server: ReturnType<typeof createAppServer> })._server = createAppServer(
							{ maxLoadedThreads: config.maxLoadedThreads },
							{ maxFrameBytes: config.maxFrameBytes },
						);
					},
					message(ws, message) {
						const connServer = (ws as unknown as { _server: ReturnType<typeof createAppServer> })._server;
						const text = typeof message === "string" ? message : new TextDecoder().decode(message);
						const result = connServer.process(new TextEncoder().encode(text), "websocket");
						if (result.response) ws.send(new TextDecoder().decode(result.response));
					},
				},
			});
			process.stderr.write(`app-server: ws:// listening on ${host}:${port}\n`);
			return new Promise(resolve => {
				process.on("SIGTERM", () => { wsServer.stop(); resolve(); });
				process.on("SIGINT", () => { wsServer.stop(); resolve(); });
			});
		}
		// unix:// — same WebSocket-over-Unix semantics.
		if (config.mode.kind === "unix" && config.mode.path) {
			const socketPath = config.mode.path;
			const wsServer = Bun.serve({
				unix: socketPath,
			fetch(req, server) {
					const url = new URL(req.url);
					const origin = req.headers.get("origin");
					if (origin) return new Response("Forbidden", { status: 403 });
					if (req.method === "GET" && (url.pathname === "/readyz" || url.pathname === "/healthz")) {
						return new Response("OK", { status: 200 });
					}
					if (server.upgrade(req)) return;
					return new Response("Not Found", { status: 404 });
				},
				websocket: {
					open(ws) {
						(ws as unknown as { _server: ReturnType<typeof createAppServer> })._server = createAppServer(
							{ maxLoadedThreads: config.maxLoadedThreads },
							{ maxFrameBytes: config.maxFrameBytes },
						);
					},
					message(ws, message) {
						const connServer = (ws as unknown as { _server: ReturnType<typeof createAppServer> })._server;
						const text = typeof message === "string" ? message : new TextDecoder().decode(message);
						const result = connServer.process(new TextEncoder().encode(text), "unix");
						if (result.response) ws.send(new TextDecoder().decode(result.response));
					},
				},
			});
			process.stderr.write(`app-server: unix:// listening on ${socketPath}\n`);
			return new Promise(resolve => {
				process.on("SIGTERM", () => { wsServer.stop(); resolve(); });
				process.on("SIGINT", () => { wsServer.stop(); resolve(); });
			});
		}
	}
}
