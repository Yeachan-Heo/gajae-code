import { Args, Command, Flags } from "@gajae-code/utils/cli";
import {
	COORDINATOR_MCP_PROTOCOL_VERSION,
	COORDINATOR_MCP_SERVER_NAME,
	COORDINATOR_MCP_TOOL_NAMES,
} from "../coordinator/contract";
import { buildCoordinatorMcpConfig } from "../coordinator-mcp/policy";

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

function coordinatorDoctorPayload(): {
	ok: boolean;
	checks: Array<{ id: string; status: "pass" | "warn" | "fail"; detail: string }>;
} {
	const config = buildCoordinatorMcpConfig(process.env);
	const checks: Array<{ id: string; status: "pass" | "warn" | "fail"; detail: string }> = [];
	checks.push({
		id: "workdir_roots",
		status: config.allowedRoots.length > 0 ? "pass" : "fail",
		detail:
			config.allowedRoots.length > 0 ? config.allowedRoots.join(":") : "GJC_COORDINATOR_MCP_WORKDIR_ROOTS is empty",
	});
	checks.push({
		id: "session_mutations",
		status: config.mutationClasses.has("sessions") ? "pass" : "fail",
		detail: config.mutationClasses.has("sessions") ? "sessions mutation enabled" : "sessions mutation disabled",
	});
	checks.push({
		id: "session_command",
		status: config.sessionCommand ? "pass" : "warn",
		detail:
			config.sessionCommand ??
			"GJC_COORDINATOR_MCP_SESSION_COMMAND is unset; registration can still reuse visible sessions",
	});
	checks.push({
		id: "namespace",
		status: config.namespace.profile && config.namespace.repo ? "pass" : "warn",
		detail: `profile=${config.namespace.profile ?? "<unset>"} repo=${config.namespace.repo ?? "<unset>"}`,
	});
	return { ok: checks.every(check => check.status !== "fail"), checks };
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
		if (action !== "check" && action !== "tools" && action !== "doctor") {
			const payload = { ok: false, reason: "unknown_coordinator_subcommand", subcommand: action };
			if (flags.json) writeJson(payload);
			else
				process.stderr.write(`unknown_coordinator_subcommand:${action}
`);
			process.exit(1);
		}

		if (action === "doctor") {
			const doctor = coordinatorDoctorPayload();
			if (flags.json) {
				writeJson(doctor);
				return;
			}
			process.stdout.write(`ok: ${doctor.ok}\n`);
			for (const check of doctor.checks) process.stdout.write(`${check.status}\t${check.id}\t${check.detail}\n`);
			return;
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
