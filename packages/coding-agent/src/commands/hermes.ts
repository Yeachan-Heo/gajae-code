import { Args, Command, Flags } from "@gajae-code/utils/cli";
import { HERMES_MCP_PROTOCOL_VERSION, HERMES_MCP_SERVER_NAME, HERMES_MCP_TOOL_NAMES } from "../hermes/contract";

function writeJson(value: unknown): void {
	process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function hermesContractPayload(): {
	ok: true;
	server: { name: string; protocolVersion: string };
	readOnly: true;
	tools: string[];
} {
	return {
		ok: true,
		server: { name: HERMES_MCP_SERVER_NAME, protocolVersion: HERMES_MCP_PROTOCOL_VERSION },
		readOnly: true,
		tools: [...HERMES_MCP_TOOL_NAMES],
	};
}

export default class Hermes extends Command {
	static description = "Inspect GJC Hermes coordinator bridge contracts";
	static strict = false;

	static args = {
		action: Args.string({ description: "Action to run (check or tools)", required: false }),
	};

	static flags = {
		json: Flags.boolean({ char: "j", description: "Emit machine-readable JSON", default: false }),
	};

	async run(): Promise<void> {
		const { args, flags } = await this.parse(Hermes);
		const action = args.action ?? "check";
		if (action !== "check" && action !== "tools") {
			const payload = { ok: false, reason: "unknown_hermes_subcommand", subcommand: action };
			if (flags.json) writeJson(payload);
			else process.stderr.write(`unknown_hermes_subcommand:${action}\n`);
			process.exit(1);
		}

		const payload = hermesContractPayload();
		if (flags.json) {
			writeJson(action === "tools" ? { ok: true, tools: payload.tools } : payload);
			return;
		}
		if (action === "tools") {
			for (const tool of payload.tools) process.stdout.write(`${tool}\n`);
			return;
		}
		process.stdout.write(
			`server: ${payload.server.name}\nprotocol: ${payload.server.protocolVersion}\nreadOnly: true\ntools: ${payload.tools.length}\n`,
		);
	}
}
