/**
 * Starts one of GJC's tool servers from the current (project) directory the way
 * the app does: `@gajae-code/utils/env` loads first (copying the project `.env`
 * into the process environment), then the client spawns the server command.
 * The server is a short-lived `node` process, kept alive long enough to start; only whether a planted `NODE_OPTIONS` preload ran
 * matters, so connection failures are ignored.
 */
import "@gajae-code/utils/env";
import { DapClient } from "../../src/dap/client";
import type { DapResolvedAdapter } from "../../src/dap/types";
import { getOrCreateClient, shutdownAll } from "../../src/lsp/client";
import { BiomeClient } from "../../src/lsp/clients/biome-client";
import type { ServerConfig } from "../../src/lsp/types";
import { StdioTransport } from "../../src/runtime-mcp/transports/stdio";

const op = process.argv[2];
const cwd = process.cwd();
const node = Bun.which("node");
if (!node) throw new Error("node not found");
const args = ["-e", "setTimeout(() => {}, 200)"];
const timeout = <T>(promise: Promise<T>) => Promise.race([promise, Bun.sleep(3_000)]);
const server: ServerConfig = { command: node, resolvedCommand: node, args, fileTypes: [".probe"], rootMarkers: [] };

try {
	if (op === "mcp") {
		const transport = new StdioTransport({ type: "stdio", command: node, args, cwd });
		await timeout(transport.connect());
		await Bun.sleep(500);
		await transport.close();
	} else if (op === "lsp") {
		await timeout(getOrCreateClient(server, cwd, 1_000));
		await shutdownAll();
	} else if (op === "biome") {
		await BiomeClient.create(server, cwd).format(`${cwd}/file.probe`, "");
	} else if (op === "dap") {
		const adapter: DapResolvedAdapter = {
			name: "probe",
			command: node,
			args,
			resolvedCommand: node,
			languages: [],
			fileTypes: [],
			rootMarkers: [],
			launchDefaults: {},
			attachDefaults: {},
			connectMode: "stdio",
		};
		const client = await timeout(DapClient.spawn({ adapter, cwd }));
		await Bun.sleep(500);
		await client?.dispose();
	} else throw new Error(`unknown op ${op}`);
} catch {
	// The probe server speaks no protocol; only the preload marker matters.
}
console.log(JSON.stringify({ done: true }));
process.exit(0);
