/**
 * ACP `initialize` conformance — gates `terminal` auth methods on
 * `clientCapabilities.auth.terminal`, advertises stable agentInfo, and keeps
 * the agentCapabilities contract that downstream clients rely on.
 */
import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentSideConnection, InitializeRequest } from "@agentclientprotocol/sdk";
import acpProtocolSchema from "@agentclientprotocol/sdk/schema/schema.json" with { type: "json" };
import { getConfigRootDir, setAgentDir } from "@gajae-code/utils";
import { fromJSONSchema } from "zod/v4";
import type * as z from "zod/v4/core";
import { AcpAgent } from "../src/modes/acp/acp-agent";
import { ACP_TERMINAL_AUTH_FLAG, prepareAcpTerminalAuthArgs } from "../src/modes/acp/terminal-auth";
import { expectAcpStructure } from "./helpers/acp-schema";

const cleanupRoots: string[] = [];
const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
const fallbackAgentDir = path.join(getConfigRootDir(), "agent");
const zInitializeResponse = fromJSONSchema({
	$schema: acpProtocolSchema.$schema,
	$ref: "#/$defs/InitializeResponse",
	$defs: acpProtocolSchema.$defs,
} as unknown as z.JSONSchema.JSONSchema);

afterEach(async () => {
	if (originalAgentDir) {
		setAgentDir(originalAgentDir);
	} else {
		setAgentDir(fallbackAgentDir);
		delete process.env.PI_CODING_AGENT_DIR;
	}
	for (const root of cleanupRoots.splice(0)) {
		await fs.promises.rm(root, { recursive: true, force: true });
	}
});

async function createAgent(): Promise<AcpAgent> {
	const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "gjc-acp-init-"));
	cleanupRoots.push(root);
	const agentDir = path.join(root, "agent");
	const cwd = path.join(root, "cwd");
	await fs.promises.mkdir(agentDir, { recursive: true });
	await fs.promises.mkdir(cwd, { recursive: true });
	setAgentDir(agentDir);

	const abortController = new AbortController();
	const connection = {
		sessionUpdate: async () => {},
		signal: abortController.signal,
		closed: Promise.withResolvers<void>().promise,
	} as unknown as AgentSideConnection;

	return new AcpAgent(connection, { agentDir });
}

function buildInitializeRequest(overrides: Partial<InitializeRequest> = {}): InitializeRequest {
	return {
		protocolVersion: 1,
		clientCapabilities: {},
		...overrides,
	} as InitializeRequest;
}

describe("ACP initialize conformance", () => {
	it("only advertises the agent-managed auth method when the client lacks terminal capability", async () => {
		const agent = await createAgent();
		const response = await agent.initialize(buildInitializeRequest());
		expectAcpStructure(zInitializeResponse, response);
		expect(response.authMethods).toHaveLength(1);
		const [agentMethod] = response.authMethods!;
		// AuthMethodAgent omits the `type` discriminator per ACP spec — the absence is the signal.
		expect((agentMethod as { type?: string }).type).toBeUndefined();
		expect(agentMethod).toEqual(
			expect.objectContaining({
				id: "agent",
				name: expect.any(String),
				description: expect.any(String),
			}),
		);
	});

	it("appends the terminal setup method when the client opts in via clientCapabilities.auth.terminal", async () => {
		const agent = await createAgent();
		const response = await agent.initialize(
			buildInitializeRequest({ clientCapabilities: { auth: { terminal: true } } }),
		);
		expectAcpStructure(zInitializeResponse, response);
		expect(response.authMethods).toHaveLength(2);
		const [first, second] = response.authMethods!;
		expect((first as { type?: string }).type).toBeUndefined();
		expect(first).toEqual(expect.objectContaining({ id: "agent" }));
		expect(response.authMethods![1]).toEqual(
			expect.objectContaining({
				type: "terminal",
				id: "terminal",
				args: [ACP_TERMINAL_AUTH_FLAG],
			}),
		);
		void second;
	});

	it("uses a terminal auth arg that removes ACP mode before launching the interactive setup flow", () => {
		const result = prepareAcpTerminalAuthArgs(["--mode", "acp", "--no-extensions", ACP_TERMINAL_AUTH_FLAG]);

		expect(result).toEqual({
			args: ["--no-extensions"],
			terminalAuth: true,
		});
		expect(prepareAcpTerminalAuthArgs(["--mode=acp", ACP_TERMINAL_AUTH_FLAG])).toEqual({
			args: [],
			terminalAuth: true,
		});
	});

	it("declares agentInfo.version that matches the published package version", async () => {
		const agent = await createAgent();
		const response = await agent.initialize(buildInitializeRequest());
		const pkgPath = path.join(import.meta.dir, "..", "package.json");
		const pkg = (await Bun.file(pkgPath).json()) as { version: string };
		expect(response.agentInfo).toEqual(
			expect.objectContaining({
				name: "gajae-code",
				title: "Gajae Code",
				version: pkg.version,
			}),
		);
		expect(response.agentInfo!.version).toBe(pkg.version);
	});

	it("advertises only SDK-backed ACP capabilities", async () => {
		const agent = await createAgent();
		const response = await agent.initialize(buildInitializeRequest());
		expectAcpStructure(zInitializeResponse, response);
		expect(response.agentCapabilities).toEqual(
			expect.objectContaining({
				loadSession: true,
				promptCapabilities: expect.objectContaining({ embeddedContext: true, image: true }),
				sessionCapabilities: expect.objectContaining({
					list: expect.any(Object),
					fork: expect.any(Object),
					resume: expect.any(Object),
					close: expect.any(Object),
					delete: expect.any(Object),
				}),
			}),
		);
		expect(response.agentCapabilities).not.toHaveProperty("mcpCapabilities");
	});
});
