import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { createHermesMcpServer, HERMES_MCP_TOOL_NAMES } from "../src/hermes-mcp/server";

const tempDirs: string[] = [];

async function tempRoot(): Promise<string> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-hermes-server-"));
	tempDirs.push(dir);
	return dir;
}

afterEach(async () => {
	await Promise.all(tempDirs.splice(0).map(dir => fs.rm(dir, { recursive: true, force: true })));
});

describe("Hermes MCP server protocol", () => {
	it("initializes with GJC Hermes server identity and lists GJC-named tools", async () => {
		const server = createHermesMcpServer({ env: {} });

		const initialized = await server.handleJsonRpc({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} });
		expect(initialized.result.serverInfo.name).toBe("gjc-hermes-mcp");
		expect(initialized.result.capabilities.tools).toEqual({});
		expect(initialized.result.capabilities.prompts).toEqual({});
		expect(initialized.result.capabilities.resources).toEqual({});

		const listed = await server.handleJsonRpc({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
		expect(listed.result.tools.map((tool: { name: string }) => tool.name).sort()).toEqual(
			[...HERMES_MCP_TOOL_NAMES].sort(),
		);
		const prompts = await server.handleJsonRpc({ jsonrpc: "2.0", id: 20, method: "prompts/list", params: {} });
		expect(prompts.result.prompts).toEqual([]);

		const resources = await server.handleJsonRpc({ jsonrpc: "2.0", id: 21, method: "resources/list", params: {} });
		expect(resources.result.resources).toEqual([]);
	});

	it("rejects unknown mcp-serve subcommands before launch fallback", async () => {
		const { validateMcpServeSubcommandForTest } = await import("../src/commands/mcp-serve");

		expect(() => validateMcpServeSubcommandForTest("bogus")).toThrow("unknown_mcp_serve_subcommand:bogus");
	});

	it("fails closed for mutating calls unless startup and per-call mutation are both enabled", async () => {
		const root = await tempRoot();
		const server = createHermesMcpServer({ env: { GJC_HERMES_MCP_WORKDIR_ROOTS: root } });

		const disabled = await server.handleJsonRpc({
			jsonrpc: "2.0",
			id: 3,
			method: "tools/call",
			params: { name: "gjc_hermes_start_session", arguments: { cwd: root, allow_mutation: true } },
		});

		expect(disabled.result.isError).toBe(true);
		expect(disabled.result.content[0].text).toContain("hermes_mutation_class_disabled:sessions");

		const enabledServer = createHermesMcpServer({
			env: { GJC_HERMES_MCP_WORKDIR_ROOTS: root, GJC_HERMES_MCP_MUTATIONS: "sessions" },
		});
		const missingPerCall = await enabledServer.handleJsonRpc({
			jsonrpc: "2.0",
			id: 4,
			method: "tools/call",
			params: { name: "gjc_hermes_start_session", arguments: { cwd: root } },
		});

		expect(missingPerCall.result.isError).toBe(true);
		expect(missingPerCall.result.content[0].text).toContain("hermes_mutation_call_not_allowed:sessions");
	});

	it("starts sessions through the structured GJC service adapter, not arbitrary terminal relay", async () => {
		const root = await tempRoot();
		const calls: unknown[] = [];
		const server = createHermesMcpServer({
			env: {
				GJC_HERMES_MCP_WORKDIR_ROOTS: root,
				GJC_HERMES_MCP_MUTATIONS: "sessions",
				GJC_HERMES_MCP_PROFILE: "local",
				GJC_HERMES_MCP_REPO: "repo",
			},
			services: {
				startSession: async input => {
					calls.push(input);
					return {
						sessionId: "gjc-demo",
						tmuxSession: "gjc-demo",
						cwd: input.cwd,
						createdAt: "2026-06-07T00:00:00.000Z",
					};
				},
				listSessions: () => [],
			},
		});

		const response = await server.handleJsonRpc({
			jsonrpc: "2.0",
			id: 5,
			method: "tools/call",
			params: {
				name: "gjc_hermes_start_session",
				arguments: { cwd: root, prompt: "hello", allow_mutation: true },
			},
		});

		expect(response.result.isError).toBe(false);
		expect(JSON.parse(response.result.content[0].text).session.session_id).toBe("gjc-demo");
		expect(calls).toEqual([
			{ cwd: root, prompt: "hello", namespace: { profile: "local", repo: "repo" }, worktree: true },
		]);
	});

	it("persists audited follow-up, question answers, and bounded reports", async () => {
		const root = await tempRoot();
		const stateRoot = path.join(root, ".gjc", "state", "hermes-test");
		const server = createHermesMcpServer({
			env: {
				GJC_HERMES_MCP_WORKDIR_ROOTS: root,
				GJC_HERMES_MCP_STATE_ROOT: stateRoot,
				GJC_HERMES_MCP_MUTATIONS: "sessions,questions,reports",
				GJC_HERMES_MCP_PROFILE: "local",
				GJC_HERMES_MCP_REPO: "repo",
			},
			services: {
				startSession: async input => ({
					sessionId: "gjc-demo",
					tmuxSession: "gjc-demo",
					cwd: input.cwd,
					createdAt: "2026-06-07T00:00:00.000Z",
				}),
				listSessions: () => [],
			},
		});
		await server.handleJsonRpc({
			jsonrpc: "2.0",
			id: 6,
			method: "tools/call",
			params: { name: "gjc_hermes_start_session", arguments: { cwd: root, allow_mutation: true } },
		});
		await Bun.write(
			path.join(stateRoot, "local", "repo", "questions", "q1.json"),
			JSON.stringify({ id: "q1", session_id: "gjc-demo", status: "open", schema: { max_length: 20 } }),
		);

		const prompt = await server.handleJsonRpc({
			jsonrpc: "2.0",
			id: 7,
			method: "tools/call",
			params: {
				name: "gjc_hermes_send_prompt",
				arguments: { session_id: "gjc-demo", prompt: "continue", allow_mutation: true },
			},
		});
		const answer = await server.handleJsonRpc({
			jsonrpc: "2.0",
			id: 8,
			method: "tools/call",
			params: {
				name: "gjc_hermes_submit_question_answer",
				arguments: { question_id: "q1", answer: "yes", allow_mutation: true },
			},
		});
		const report = await server.handleJsonRpc({
			jsonrpc: "2.0",
			id: 9,
			method: "tools/call",
			params: {
				name: "gjc_hermes_report_status",
				arguments: { status: "blocked", summary: "Needs review", allow_mutation: true },
			},
		});

		expect(JSON.parse(prompt.result.content[0].text).queued).toBe(true);
		expect(JSON.parse(answer.result.content[0].text).question.status).toBe("answered");
		expect(JSON.parse(report.result.content[0].text).report.status).toBe("blocked");
	});
});
