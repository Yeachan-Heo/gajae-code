import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
	COORDINATOR_MCP_PROTOCOL_VERSION,
	COORDINATOR_MCP_SERVER_NAME,
	COORDINATOR_MCP_TOOL_NAMES,
} from "../src/coordinator/contract";
import { createCoordinatorMcpServer, handleCoordinatorMcpRequest } from "../src/coordinator-mcp/server";

async function withTempRoot(run: (root: string) => Promise<void>): Promise<void> {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-coordinator-mcp-"));
	try {
		await run(root);
	} finally {
		await fs.rm(root, { recursive: true, force: true });
	}
}

describe("canonical SDK coordinator compatibility handler", () => {
	it("serves initialization and the canonical tool inventory", async () => {
		await withTempRoot(async root => {
			const env = { GJC_COORDINATOR_MCP_WORKDIR_ROOTS: root };
			const initialized = await handleCoordinatorMcpRequest(
				{ jsonrpc: "2.0", id: 1, method: "initialize" },
				{ env },
			);
			expect(initialized).toMatchObject({
				jsonrpc: "2.0",
				id: 1,
				result: {
					protocolVersion: COORDINATOR_MCP_PROTOCOL_VERSION,
					serverInfo: { name: COORDINATOR_MCP_SERVER_NAME, version: expect.any(String) },
					capabilities: { tools: {}, prompts: {}, resources: {} },
				},
			});
			const listed = await handleCoordinatorMcpRequest({ jsonrpc: "2.0", id: 2, method: "tools/list" }, { env });
			expect(listed.result.tools.map((tool: { name: string }) => tool.name)).toEqual([
				...COORDINATOR_MCP_TOOL_NAMES,
			]);
			const promptTool = listed.result.tools.find(
				(tool: { name: string }) => tool.name === "gjc_coordinator_send_prompt",
			);
			expect(promptTool.inputSchema.required).toEqual(expect.arrayContaining(["idempotency_key", "allow_mutation"]));
		});
	});

	it("preserves mutation authorization and read-only artifact boundaries", async () => {
		await withTempRoot(async root => {
			const artifact = path.join(root, "result.txt");
			await Bun.write(artifact, "coordinator artifact");
			const server = createCoordinatorMcpServer({
				env: {
					GJC_COORDINATOR_MCP_WORKDIR_ROOTS: root,
					GJC_COORDINATOR_MCP_MUTATIONS: "sessions",
				},
			});
			expect(
				await server.callTool("gjc_coordinator_start_session", { cwd: root, idempotency_key: "start-1" }),
			).toEqual({ ok: false, reason: "coordinator_mutation_call_not_allowed:sessions" });
			expect(await server.callTool("gjc_coordinator_read_artifact", { path: artifact })).toMatchObject({
				ok: true,
				text: "coordinator artifact",
			});
			expect(await server.callTool("gjc_coordinator_read_artifact", { path: os.tmpdir() })).toEqual({
				ok: false,
				reason: "artifact_outside_allowed_roots",
			});
		});
	});
});
