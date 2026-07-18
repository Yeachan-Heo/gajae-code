import { getAgentDir } from "@gajae-code/utils";
import { Args, Command, Flags } from "@gajae-code/utils/cli";
import {
	COORDINATOR_MCP_PROTOCOL_VERSION,
	COORDINATOR_MCP_SERVER_NAME,
	COORDINATOR_MCP_TOOL_NAMES,
} from "../coordinator/contract";
import { runCoordinatorMcpStdio } from "../coordinator-mcp/server";
import { type BrokerDiscovery, readBrokerDiscovery } from "../sdk/broker/discovery";
import { UnsupportedStateVersionError } from "../sdk/broker/state-version";
import { runSdkMcpStdio, SDK_MCP_TOOL_NAMES } from "../sdk/mcp/server";

function writeJson(value: unknown): void {
	process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

export type CoordinatorBrokerDiscoveryStatus = "ready" | "unavailable" | "error";
export type CoordinatorBrokerDiscoveryReason =
	| null
	| "absent_or_invalid"
	| "unsupported_state_version"
	| "discovery_access_denied"
	| "discovery_read_failed";

export interface CoordinatorBrokerObservation {
	discovery_status: CoordinatorBrokerDiscoveryStatus;
	reason: CoordinatorBrokerDiscoveryReason;
}

export interface CoordinatorCheckProbe {
	agentDir?: string;
	readBrokerDiscovery?: (agentDir: string) => Promise<BrokerDiscovery | null>;
}

export interface CoordinatorCheckPayload {
	ok: true;
	server: { name: typeof COORDINATOR_MCP_SERVER_NAME; protocolVersion: typeof COORDINATOR_MCP_PROTOCOL_VERSION };
	readOnly: true;
	tools: readonly string[];
	catalog: { ready: true; reason: null };
	broker: CoordinatorBrokerObservation & {
		operational_ready: null;
		bootstrap_supported: true;
		bootstrap_attempted: false;
	};
}

function discoveryErrorCode(error: unknown): unknown {
	if (typeof error !== "object" || error === null || !("code" in error)) return undefined;
	return error.code;
}

export async function probeCoordinatorBrokerCheck(
	probe: CoordinatorCheckProbe = {},
): Promise<CoordinatorBrokerObservation> {
	try {
		const discovery = await (probe.readBrokerDiscovery ?? readBrokerDiscovery)(probe.agentDir ?? getAgentDir());
		return discovery
			? { discovery_status: "ready", reason: null }
			: { discovery_status: "unavailable", reason: "absent_or_invalid" };
	} catch (error) {
		if (error instanceof UnsupportedStateVersionError)
			return { discovery_status: "error", reason: "unsupported_state_version" };
		const code = discoveryErrorCode(error);
		if (code === "EACCES" || code === "EPERM")
			return { discovery_status: "error", reason: "discovery_access_denied" };
		return { discovery_status: "error", reason: "discovery_read_failed" };
	}
}

export function formatCoordinatorCheckPayload(observation: CoordinatorBrokerObservation): CoordinatorCheckPayload {
	return {
		ok: true,
		server: { name: COORDINATOR_MCP_SERVER_NAME, protocolVersion: COORDINATOR_MCP_PROTOCOL_VERSION },
		readOnly: true,
		tools: [...COORDINATOR_MCP_TOOL_NAMES],
		catalog: { ready: true, reason: null },
		broker: {
			...observation,
			operational_ready: null,
			bootstrap_supported: true,
			bootstrap_attempted: false,
		},
	};
}

export async function buildCoordinatorCheckPayload(probe?: CoordinatorCheckProbe): Promise<CoordinatorCheckPayload> {
	return formatCoordinatorCheckPayload(await probeCoordinatorBrokerCheck(probe));
}

export function validateMcpServeSubcommandForTest(server: string | undefined): void {
	if (server !== "coordinator" && server !== "hermes" && server !== "sdk")
		throw new Error(`unknown_mcp_serve_subcommand:${server ?? ""}`);
}

export default class McpServe extends Command {
	static description = "Serve GJC MCP compatibility bridges";
	static strict = false;

	static args = {
		server: Args.string({ description: "MCP server to run (sdk, coordinator, or hermes alias)", required: false }),
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
			if (!flags.json) {
				const serverName = server === "sdk" ? "gjc-sdk-mcp" : COORDINATOR_MCP_SERVER_NAME;
				const toolCount = server === "sdk" ? SDK_MCP_TOOL_NAMES.length : COORDINATOR_MCP_TOOL_NAMES.length;
				process.stdout.write(`server: ${serverName}\ntools: ${toolCount}\n`);
				return;
			}
			const payload =
				server === "sdk"
					? { ok: true, server: { name: "gjc-sdk-mcp" }, readOnly: false, tools: [...SDK_MCP_TOOL_NAMES] }
					: await buildCoordinatorCheckPayload();
			writeJson(payload);
			return;
		}

		if (server === "sdk") {
			await runSdkMcpStdio();
			return;
		}

		await runCoordinatorMcpStdio();
	}
}
