import { afterEach, describe, expect, it, spyOn } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import CoordinatorCommand from "../src/commands/coordinator";
import McpServeCommand from "../src/commands/mcp-serve";
import {
	COORDINATOR_MCP_PROTOCOL_VERSION,
	COORDINATOR_MCP_SERVER_NAME,
	COORDINATOR_MCP_TOOL_NAMES,
} from "../src/coordinator/contract";
import { createCoordinatorSafetyPolicy } from "../src/coordinator-mcp/safety";
import { createCoordinatorMcpServer, handleCoordinatorMcpRequest } from "../src/coordinator-mcp/server";

const ORIGINAL_STDOUT_WRITE = process.stdout.write.bind(process.stdout);

async function withTempRoot(run: (root: string) => Promise<void>): Promise<void> {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-coordinator-mcp-"));
	try {
		await run(root);
	} finally {
		await fs.rm(root, { recursive: true, force: true });
	}
}

async function runCommand(argv: string[]): Promise<string> {
	let output = "";
	const writeSpy = spyOn(process.stdout, "write").mockImplementation((chunk: string | Uint8Array) => {
		output += chunk.toString();
		return true;
	});
	try {
		const command = new McpServeCommand(argv, { bin: "gjc", version: "0.0.0-test", commands: new Map() });
		await command.run();
		return output;
	} finally {
		writeSpy.mockRestore();
	}
}

async function runHermesCommand(argv: string[]): Promise<string> {
	let output = "";
	const writeSpy = spyOn(process.stdout, "write").mockImplementation((chunk: string | Uint8Array) => {
		output += chunk.toString();
		return true;
	});
	try {
		const command = new CoordinatorCommand(argv, { bin: "gjc", version: "0.0.0-test", commands: new Map() });
		await command.run();
		return output;
	} finally {
		writeSpy.mockRestore();
	}
}

afterEach(() => {
	process.stdout.write = ORIGINAL_STDOUT_WRITE;
	process.exitCode = 0;
});

describe("gjc mcp-serve coordinator", () => {
	it("exposes a checkable Hermes MCP command and rejects unknown subcommands as JSON", async () => {
		const ok = JSON.parse(await runCommand(["coordinator", "--check", "--json"]));
		expect(ok).toEqual({
			ok: true,
			server: { name: COORDINATOR_MCP_SERVER_NAME, protocolVersion: COORDINATOR_MCP_PROTOCOL_VERSION },
			readOnly: true,
			tools: [...COORDINATOR_MCP_TOOL_NAMES],
		});

		const rejected = JSON.parse(await runCommand(["bogus", "--json"]));
		expect(rejected).toEqual({ ok: false, reason: "unknown_mcp_serve_subcommand", subcommand: "bogus" });
		expect(process.exitCode).toBe(1);
		process.exitCode = 0;
	});

	it("exposes the same Hermes contract through the read-only CLI adapter", async () => {
		const ok = JSON.parse(await runHermesCommand(["--json"]));
		expect(ok).toEqual({
			ok: true,
			server: { name: COORDINATOR_MCP_SERVER_NAME, protocolVersion: COORDINATOR_MCP_PROTOCOL_VERSION },
			readOnly: true,
			tools: [...COORDINATOR_MCP_TOOL_NAMES],
		});

		const tools = JSON.parse(await runHermesCommand(["tools", "--json"]));
		expect(tools).toEqual({ ok: true, tools: [...COORDINATOR_MCP_TOOL_NAMES] });
	});

	it("implements initialize, tools/list, and read-only mutating rejection", async () => {
		const env = { GJC_COORDINATOR_MCP_REPO: "repo-a" };
		const initialize = await handleCoordinatorMcpRequest({ jsonrpc: "2.0", id: 1, method: "initialize" }, { env });
		expect(initialize).toEqual({
			jsonrpc: "2.0",
			id: 1,
			result: {
				protocolVersion: "2024-11-05",
				capabilities: { tools: {}, prompts: {}, resources: {} },
				serverInfo: { name: "gjc-coordinator-mcp", version: expect.any(String) },
			},
		});

		const listed = await handleCoordinatorMcpRequest({ jsonrpc: "2.0", id: 2, method: "tools/list" }, { env });
		expect(listed.result.tools.map((tool: { name: string }) => tool.name)).toContain("gjc_coordinator_report_status");
		const prompts = await handleCoordinatorMcpRequest({ jsonrpc: "2.0", id: 20, method: "prompts/list" }, { env });
		expect(prompts.result.prompts).toEqual([]);

		const resources = await handleCoordinatorMcpRequest(
			{ jsonrpc: "2.0", id: 21, method: "resources/list" },
			{ env },
		);
		expect(resources.result.resources).toEqual([]);

		const called = await handleCoordinatorMcpRequest(
			{
				jsonrpc: "2.0",
				id: 3,
				method: "tools/call",
				params: { name: "gjc_coordinator_start_session", arguments: { cwd: process.cwd(), allow_mutation: true } },
			},
			{ env },
		);
		const payload = JSON.parse(called.result.content[0].text);
		expect(payload).toEqual({ ok: false, reason: "coordinator_mutation_class_disabled:sessions" });
	});

	it("requires startup mutation class and per-call allow_mutation for mutating tools", async () => {
		await withTempRoot(async root => {
			let created = false;
			const env = {
				GJC_COORDINATOR_MCP_WORKDIR_ROOTS: root,
				GJC_COORDINATOR_MCP_ENABLE_MUTATION_CLASSES: "session",
			};
			const missingPerCall = await handleCoordinatorMcpRequest(
				{
					jsonrpc: "2.0",
					id: 1,
					method: "tools/call",
					params: { name: "gjc_coordinator_start_session", arguments: { cwd: root } },
				},
				{
					env,
					createSession: () => {
						created = true;
						return { name: "x", attached: false, windows: 1, panes: 1, bindings: "root", createdAt: "now" };
					},
				},
			);
			expect(JSON.parse(missingPerCall.result.content[0].text)).toEqual({
				ok: false,
				reason: "coordinator_mutation_call_not_allowed:sessions",
			});

			const allowed = await handleCoordinatorMcpRequest(
				{
					jsonrpc: "2.0",
					id: 2,
					method: "tools/call",
					params: { name: "gjc_coordinator_start_session", arguments: { cwd: root, allow_mutation: true } },
				},
				{
					env,
					createSession: () => {
						created = true;
						return { name: "x", attached: false, windows: 1, panes: 1, bindings: "root", createdAt: "now" };
					},
				},
			);
			expect(created).toBe(true);
			const allowedPayload = JSON.parse(allowed.result.content[0].text);
			expect(allowedPayload).toMatchObject({
				ok: true,
				session: {
					session_id: "x",
					name: "x",
					attached: false,
					windows: 1,
					panes: 1,
					bindings: "root",
					created_at: "now",
					createdAt: "now",
				},
				session_state: {
					session_id: "x",
					state: "ready_for_input",
					ready_for_input: true,
				},
			});
		});
	});

	it("canonicalizes workdir roots and rejects traversal plus symlink escapes", async () => {
		await withTempRoot(async root => {
			const outside = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-coordinator-outside-"));
			try {
				const link = path.join(root, "escape");
				await fs.symlink(outside, link);
				const policy = await createCoordinatorSafetyPolicy({
					env: { GJC_COORDINATOR_MCP_WORKDIR_ROOTS: root },
				});
				expect(await policy.resolveWorkdir(path.join(root, "..", path.basename(root)))).toBe(root);
				await expect(policy.resolveWorkdir(path.join(root, "..", path.basename(outside)))).rejects.toThrow(
					"workdir_outside_allowed_roots",
				);
				await expect(policy.resolveWorkdir(link)).rejects.toThrow("workdir_outside_allowed_roots");
			} finally {
				await fs.rm(outside, { recursive: true, force: true });
			}
		});
	});

	it("bounds artifact reads and denies unsafe roots", async () => {
		await withTempRoot(async root => {
			const artifact = path.join(root, "artifact.txt");
			await Bun.write(artifact, "🙂🙂abcdef");
			const byteCap = 5;
			const env = {
				GJC_COORDINATOR_MCP_WORKDIR_ROOTS: root,
				GJC_COORDINATOR_MCP_ARTIFACT_MAX_BYTES: String(byteCap),
			};
			const server = await createCoordinatorMcpServer({ env });
			const read = await server.callTool("gjc_coordinator_read_artifact", { path: artifact });
			expect(read.ok).toBe(true);
			expect(read.path).toBe(artifact);
			expect(read.bytes).toBeLessThanOrEqual(byteCap);
			expect(read.truncated).toBe(true);
			expect(Buffer.byteLength(String(read.text))).toBeLessThanOrEqual(byteCap);
			await expect(
				server.callTool("gjc_coordinator_read_artifact", { path: path.join(os.tmpdir(), "missing.txt") }),
			).resolves.toEqual({
				ok: false,
				reason: "artifact_outside_allowed_roots",
			});
		});
	});

	it("runs a generic controller lifecycle smoke without provider credentials or local config", async () => {
		await withTempRoot(async root => {
			const stateRoot = path.join(root, ".state");
			const artifact = path.join(root, "result.txt");
			await Bun.write(artifact, "generic controller evidence");
			const env = {
				GJC_COORDINATOR_MCP_WORKDIR_ROOTS: root,
				GJC_COORDINATOR_MCP_MUTATIONS: "sessions,questions,reports",
				GJC_COORDINATOR_MCP_STATE_ROOT: stateRoot,
				GJC_COORDINATOR_MCP_PROFILE: "generic-controller",
				GJC_COORDINATOR_MCP_REPO: "repo-a",
			};
			const server = await createCoordinatorMcpServer({
				env,
				services: {
					startSession: input => ({
						name: "generic-controller-session",
						cwd: input.cwd,
						createdAt: "now",
					}),
				},
			});

			const listed = await server.handleJsonRpc({ jsonrpc: "2.0", id: 1, method: "tools/list" });
			expect(listed.result.tools.map((tool: { name: string }) => tool.name)).toEqual([
				...COORDINATOR_MCP_TOOL_NAMES,
			]);
			for (const tool of listed.result.tools as Array<{ name: string; inputSchema: { type?: string } }>) {
				expect(tool.inputSchema.type).toBe("object");
			}

			const deniedStart = await server.callTool("gjc_coordinator_start_session", { cwd: root });
			expect(deniedStart).toEqual({ ok: false, reason: "coordinator_mutation_call_not_allowed:sessions" });

			const started = await server.callTool("gjc_coordinator_start_session", {
				cwd: root,
				allow_mutation: true,
			});
			expect(started).toMatchObject({
				ok: true,
				session: { session_id: "generic-controller-session", cwd: root },
				session_state: { state: "ready_for_input" },
			});

			const sent = await server.callTool("gjc_coordinator_send_prompt", {
				session_id: "generic-controller-session",
				prompt: "Run a mocked generic controller task.",
				allow_mutation: true,
			});
			expect(sent).toMatchObject({
				ok: true,
				session_id: "generic-controller-session",
				status: "active",
			});
			const turnId = String(sent.turn_id);

			const activeConflict = await server.callTool("gjc_coordinator_send_prompt", {
				session_id: "generic-controller-session",
				prompt: "Second prompt should be protected.",
				allow_mutation: true,
			});
			expect(activeConflict).toMatchObject({ ok: false, reason: "active_turn_exists", active_turn_id: turnId });

			const queued = await server.callTool("gjc_coordinator_send_prompt", {
				session_id: "generic-controller-session",
				prompt: "Queued follow-up.",
				queue: true,
				allow_mutation: true,
			});
			expect(queued).toMatchObject({ ok: true, status: "queued", queued: true, active_turn_id: turnId });

			const questionDir = path.join(stateRoot, "generic-controller", "repo-a", "questions");
			await fs.mkdir(questionDir, { recursive: true });
			await Bun.write(
				path.join(questionDir, "question-1.json"),
				JSON.stringify({
					question_id: "question-1",
					session_id: "generic-controller-session",
					turn_id: turnId,
					status: "pending",
				}),
			);
			const questionAnswer = await server.callTool("gjc_coordinator_submit_question_answer", {
				session_id: "generic-controller-session",
				turn_id: turnId,
				question_id: "question-1",
				answer: { decision: "approve" },
				allow_mutation: true,
			});
			expect(questionAnswer).toMatchObject({ ok: true, question: { status: "answered" } });

			const reported = await server.callTool("gjc_coordinator_report_status", {
				session_id: "generic-controller-session",
				turn_id: turnId,
				status: "completed",
				summary: "Mocked lifecycle completed.",
				evidence_paths: [artifact],
				allow_mutation: true,
			});
			expect(reported).toMatchObject({
				ok: true,
				turn: { status: "completed", final_response: { text: "Mocked lifecycle completed." } },
				promoted_turn: { status: "active" },
			});

			const readTurn = await server.callTool("gjc_coordinator_read_turn", {
				session_id: "generic-controller-session",
				turn_id: turnId,
			});
			expect(readTurn).toMatchObject({ ok: true, turn: { status: "completed" } });

			const reports = await server.callTool("gjc_coordinator_read_coordination_status");
			expect(reports.ok).toBe(true);
			expect((reports.reports as Array<{ status?: string }>).some(report => report.status === "completed")).toBe(
				true,
			);
		});
	});
});
