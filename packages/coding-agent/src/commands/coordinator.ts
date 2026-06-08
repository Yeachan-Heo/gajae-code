import { Args, Command, Flags } from "@gajae-code/utils/cli";
import {
	COORDINATOR_MCP_PROTOCOL_VERSION,
	COORDINATOR_MCP_SERVER_NAME,
	COORDINATOR_MCP_TOOL_NAMES,
} from "../coordinator/contract";

function writeJson(value: unknown): void {
	process.stdout.write(`${JSON.stringify(value, null, 2)}
`);
}

function coordinatorContractPayload(): {
	ok: true;
	server: { name: string; protocolVersion: string };
	readOnly: true;
	tools: string[];
} {
	return {
		ok: true,
		server: { name: COORDINATOR_MCP_SERVER_NAME, protocolVersion: COORDINATOR_MCP_PROTOCOL_VERSION },
		readOnly: true,
		tools: [...COORDINATOR_MCP_TOOL_NAMES],
	};
}

export default class Coordinator extends Command {
	static description = "Inspect GJC coordinator MCP bridge contracts";
	static strict = false;

	static args = {
		action: Args.string({ description: "Action to run (check or tools)", required: false }),
	};

	static flags = {
		json: Flags.boolean({ char: "j", description: "Emit machine-readable JSON", default: false }),
	};

	async run(): Promise<void> {
		const { args, flags } = await this.parse(Coordinator);
		const action = args.action ?? "check";
		if (action !== "check" && action !== "tools") {
			const payload = { ok: false, reason: "unknown_coordinator_subcommand", subcommand: action };
			if (flags.json) writeJson(payload);
			else
				process.stderr.write(`unknown_coordinator_subcommand:${action}
`);
			process.exit(1);
		}

		const payload = coordinatorContractPayload();
		if (flags.json) {
			writeJson(action === "tools" ? { ok: true, tools: payload.tools } : payload);
			return;
		}
		if (action === "tools") {
			for (const tool of payload.tools)
				process.stdout.write(`${tool}
`);
			return;
		}
		process.stdout.write(
			`server: ${payload.server.name}
protocol: ${payload.server.protocolVersion}
readOnly: true
tools: ${payload.tools.length}
`,
		);
	}
}
