import { Args, Command, Flags } from "@gajae-code/utils/cli";
import {
	COORDINATOR_MCP_PROTOCOL_VERSION,
	COORDINATOR_MCP_SERVER_NAME,
	COORDINATOR_MCP_TOOL_NAMES,
} from "../coordinator/contract";
import { runCoordinatorMcpStdio } from "../coordinator-mcp/server";

function writeJson(value: unknown): void {
	process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

export function validateMcpServeSubcommandForTest(server: string | undefined): void {
	if (server !== "coordinator" && server !== "hermes") throw new Error(`unknown_mcp_serve_subcommand:${server ?? ""}`);
}

export default class McpServe extends Command {
	static description = "Serve GJC MCP compatibility bridges";
	static strict = false;

	static args = {
		server: Args.string({ description: "MCP server to run (coordinator or hermes alias)", required: false }),
	};

	static flags = {
		json: Flags.boolean({ char: "j", description: "Emit machine-readable JSON", default: false }),
		check: Flags.boolean({ description: "Validate server configuration and print a smoke summary", default: false }),
	};

	async run(): Promise<void> {
		const { args, flags } = await this.parse(McpServe);
		const server = args.server ?? "";
		try {
			validateMcpServeSubcommandForTest(server);
		} catch (error) {
			const subcommand = server;
			if (flags.json) {
				writeJson({ ok: false, reason: "unknown_mcp_serve_subcommand", subcommand });
			} else {
				process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
			}
			process.exitCode = 1;
			return;
		}

		if (flags.check) {
			const payload = {
				ok: true,
				server: { name: COORDINATOR_MCP_SERVER_NAME, protocolVersion: COORDINATOR_MCP_PROTOCOL_VERSION },
				readOnly: true,
				tools: [...COORDINATOR_MCP_TOOL_NAMES],
			};
			if (flags.json) writeJson(payload);
			else
				process.stdout.write(
					`server: ${payload.server.name}\nprotocol: ${payload.server.protocolVersion}\ntools: ${payload.tools.length}\n`,
				);
			return;
		}

		await runCoordinatorMcpStdio();
	}
}
