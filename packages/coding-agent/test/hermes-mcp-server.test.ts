import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { COORDINATOR_MCP_TOOL_NAMES, createHermesMcpServer } from "../src/hermes-mcp/server";

const tempDirs: string[] = [];

async function tempRoot(): Promise<string> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-coordinator-server-"));
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
		expect(initialized.result.serverInfo.name).toBe("gjc-coordinator-mcp");
		expect(initialized.result.capabilities.tools).toEqual({});
		expect(initialized.result.capabilities.prompts).toEqual({});
		expect(initialized.result.capabilities.resources).toEqual({});

		const listed = await server.handleJsonRpc({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
		expect(listed.result.tools.map((tool: { name: string }) => tool.name).sort()).toEqual(
			[...COORDINATOR_MCP_TOOL_NAMES].sort(),
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
		const server = createHermesMcpServer({ env: { GJC_COORDINATOR_MCP_WORKDIR_ROOTS: root } });

		const disabled = await server.handleJsonRpc({
			jsonrpc: "2.0",
			id: 3,
			method: "tools/call",
			params: { name: "gjc_coordinator_start_session", arguments: { cwd: root, allow_mutation: true } },
		});

		expect(disabled.result.isError).toBe(true);
		expect(disabled.result.content[0].text).toContain("coordinator_mutation_class_disabled:sessions");

		const enabledServer = createHermesMcpServer({
			env: { GJC_COORDINATOR_MCP_WORKDIR_ROOTS: root, GJC_COORDINATOR_MCP_MUTATIONS: "sessions" },
		});
		const missingPerCall = await enabledServer.handleJsonRpc({
			jsonrpc: "2.0",
			id: 4,
			method: "tools/call",
			params: { name: "gjc_coordinator_start_session", arguments: { cwd: root } },
		});

		expect(missingPerCall.result.isError).toBe(true);
		expect(missingPerCall.result.content[0].text).toContain("coordinator_mutation_call_not_allowed:sessions");
	});

	it("starts sessions through the structured GJC service adapter, not arbitrary terminal relay", async () => {
		const root = await tempRoot();
		const calls: unknown[] = [];
		const server = createHermesMcpServer({
			env: {
				GJC_COORDINATOR_MCP_WORKDIR_ROOTS: root,
				GJC_COORDINATOR_MCP_MUTATIONS: "sessions",
				GJC_COORDINATOR_MCP_PROFILE: "local",
				GJC_COORDINATOR_MCP_REPO: "repo",
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
				name: "gjc_coordinator_start_session",
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
				GJC_COORDINATOR_MCP_WORKDIR_ROOTS: root,
				GJC_COORDINATOR_MCP_STATE_ROOT: stateRoot,
				GJC_COORDINATOR_MCP_MUTATIONS: "sessions,questions,reports",
				GJC_COORDINATOR_MCP_PROFILE: "local",
				GJC_COORDINATOR_MCP_REPO: "repo",
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
			params: { name: "gjc_coordinator_start_session", arguments: { cwd: root, allow_mutation: true } },
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
				name: "gjc_coordinator_send_prompt",
				arguments: { session_id: "gjc-demo", prompt: "continue", allow_mutation: true },
			},
		});
		const answer = await server.handleJsonRpc({
			jsonrpc: "2.0",
			id: 8,
			method: "tools/call",
			params: {
				name: "gjc_coordinator_submit_question_answer",
				arguments: { question_id: "q1", answer: "yes", allow_mutation: true },
			},
		});
		const report = await server.handleJsonRpc({
			jsonrpc: "2.0",
			id: 9,
			method: "tools/call",
			params: {
				name: "gjc_coordinator_report_status",
				arguments: { status: "blocked", summary: "Needs review", allow_mutation: true },
			},
		});

		expect(JSON.parse(prompt.result.content[0].text).queued).toBe(true);
		expect(JSON.parse(answer.result.content[0].text).question.status).toBe("answered");
		expect(JSON.parse(report.result.content[0].text).report.status).toBe("blocked");
	});

	it("rejects traversal-shaped session and question ids before state file access", async () => {
		const root = await tempRoot();
		const stateRoot = path.join(root, ".gjc", "state", "hermes-test");
		const server = createHermesMcpServer({
			env: {
				GJC_COORDINATOR_MCP_WORKDIR_ROOTS: root,
				GJC_COORDINATOR_MCP_STATE_ROOT: stateRoot,
				GJC_COORDINATOR_MCP_MUTATIONS: "sessions,questions",
				GJC_COORDINATOR_MCP_PROFILE: "local",
				GJC_COORDINATOR_MCP_REPO: "repo",
			},
		});
		const traversal = "../../reports/x";

		const status = await server.callTool("gjc_coordinator_read_status", { session_id: traversal });
		const tail = await server.callTool("gjc_coordinator_read_tail", { session_id: traversal });
		const prompt = await server.callTool("gjc_coordinator_send_prompt", {
			session_id: traversal,
			prompt: "continue",
			allow_mutation: true,
		});
		const answer = await server.callTool("gjc_coordinator_submit_question_answer", {
			question_id: traversal,
			answer: "yes",
			allow_mutation: true,
		});

		expect(status).toEqual({ ok: false, reason: "invalid_session_id" });
		expect(tail).toEqual({ ok: false, reason: "invalid_session_id" });
		expect(prompt).toEqual({ ok: false, reason: "invalid_session_id" });
		expect(answer).toEqual({ ok: false, reason: "invalid_question_id" });
	});

	it("creates durable turns, enforces active backpressure, and reads terminal reports", async () => {
		const root = await tempRoot();
		const stateRoot = path.join(root, ".gjc", "state", "hermes-turns");
		const server = createHermesMcpServer({
			env: {
				GJC_COORDINATOR_MCP_WORKDIR_ROOTS: root,
				GJC_COORDINATOR_MCP_STATE_ROOT: stateRoot,
				GJC_COORDINATOR_MCP_MUTATIONS: "sessions,questions,reports",
				GJC_COORDINATOR_MCP_PROFILE: "local",
				GJC_COORDINATOR_MCP_REPO: "repo",
			},
			services: {
				startSession: async input => ({
					sessionId: "gjc-demo",
					tmuxSession: "gjc-demo",
					tmuxTarget: "missing-target",
					cwd: input.cwd,
					createdAt: "2026-06-07T00:00:00.000Z",
				}),
			},
		});
		await server.callTool("gjc_coordinator_start_session", { cwd: root, allow_mutation: true });

		const first = await server.callTool("gjc_coordinator_send_prompt", {
			session_id: "gjc-demo",
			prompt: "first",
			allow_mutation: true,
		});
		expect(first.ok).toBe(true);
		expect(first.turn_id).toMatch(/^turn-/);
		expect(first.status).toBe("active");
		expect(first.delivery).toMatchObject({ delivered: false, queued: true });

		const rejected = await server.callTool("gjc_coordinator_send_prompt", {
			session_id: "gjc-demo",
			prompt: "second",
			allow_mutation: true,
		});
		expect(rejected).toEqual({
			ok: false,
			reason: "active_turn_exists",
			session_id: "gjc-demo",
			active_turn_id: first.turn_id,
		});

		const queued = await server.callTool("gjc_coordinator_send_prompt", {
			session_id: "gjc-demo",
			prompt: "second",
			queue: true,
			allow_mutation: true,
		});
		expect(queued.status).toBe("queued");
		expect(queued.delivery).toMatchObject({ delivered: false, queued: true });

		const completed = await server.callTool("gjc_coordinator_report_status", {
			session_id: "gjc-demo",
			turn_id: first.turn_id,
			status: "completed",
			summary: "Done",
			evidence_paths: ["artifact.txt"],
			allow_mutation: true,
		});
		expect(completed.ok).toBe(true);
		const completedTurn = completed.turn as {
			status: string;
			final_response: Record<string, unknown>;
			evidence: Array<Record<string, unknown>>;
		};
		expect(completedTurn.status).toBe("completed");
		expect(completedTurn.final_response).toMatchObject({ text: "Done", source: "report_status" });
		expect(completedTurn.evidence).toEqual([{ path: "artifact.txt" }]);

		const read = await server.callTool("gjc_coordinator_read_turn", {
			session_id: "gjc-demo",
			turn_id: first.turn_id,
		});
		expect(read.ok).toBe(true);
		const readTurn = read.turn as { schema_version: number; status: string };
		const advisoryStatus = read.advisory_status as { live: boolean | null };
		expect(readTurn.schema_version).toBe(1);
		expect(readTurn.status).toBe("completed");
		expect(advisoryStatus.live).toBe(false);

		const afterTerminal = await server.callTool("gjc_coordinator_send_prompt", {
			session_id: "gjc-demo",
			prompt: "third",
			allow_mutation: true,
		});
		expect(afterTerminal.ok).toBe(true);
		expect(afterTerminal.active_turn_id).toBe(afterTerminal.turn_id);
	});

	it("validates turn and question ownership before path-addressed mutations", async () => {
		const root = await tempRoot();
		const stateRoot = path.join(root, ".gjc", "state", "hermes-ids");
		const server = createHermesMcpServer({
			env: {
				GJC_COORDINATOR_MCP_WORKDIR_ROOTS: root,
				GJC_COORDINATOR_MCP_STATE_ROOT: stateRoot,
				GJC_COORDINATOR_MCP_MUTATIONS: "sessions,questions,reports",
				GJC_COORDINATOR_MCP_PROFILE: "local",
				GJC_COORDINATOR_MCP_REPO: "repo",
			},
			services: {
				startSession: async input => ({
					sessionId: "gjc-demo",
					cwd: input.cwd,
					createdAt: "2026-06-07T00:00:00.000Z",
				}),
			},
		});
		await server.callTool("gjc_coordinator_start_session", { cwd: root, allow_mutation: true });
		const turn = await server.callTool("gjc_coordinator_send_prompt", {
			session_id: "gjc-demo",
			prompt: "needs answer",
			allow_mutation: true,
		});
		const questionsDir = path.join(stateRoot, "local", "repo", "questions");
		await fs.mkdir(questionsDir, { recursive: true });
		await Bun.write(
			path.join(questionsDir, "q-safe.json"),
			JSON.stringify({ id: "q-safe", session_id: "gjc-demo", turn_id: turn.turn_id, status: "open" }),
		);
		await Bun.write(
			path.join(questionsDir, "q-other.json"),
			JSON.stringify({ id: "q-other", session_id: "other-session", turn_id: turn.turn_id, status: "open" }),
		);

		expect(await server.callTool("gjc_coordinator_read_turn", { turn_id: "../escape" })).toEqual({
			ok: false,
			reason: "invalid_turn_id",
		});
		expect(
			await server.callTool("gjc_coordinator_read_turn", { session_id: "other-session", turn_id: turn.turn_id }),
		).toEqual({
			ok: false,
			reason: "turn_session_mismatch",
		});
		expect(
			await server.callTool("gjc_coordinator_submit_question_answer", {
				session_id: "gjc-demo",
				turn_id: turn.turn_id,
				question_id: "../escape",
				answer: "bad",
				allow_mutation: true,
			}),
		).toEqual({ ok: false, reason: "invalid_question_id" });
		expect(
			await server.callTool("gjc_coordinator_submit_question_answer", {
				session_id: "gjc-demo",
				turn_id: turn.turn_id,
				question_id: "q-other",
				answer: "bad",
				allow_mutation: true,
			}),
		).toEqual({ ok: false, reason: "question_session_mismatch" });

		const answered = await server.callTool("gjc_coordinator_submit_question_answer", {
			session_id: "gjc-demo",
			turn_id: turn.turn_id,
			question_id: "q-safe",
			answer: "yes",
			allow_mutation: true,
		});
		expect(answered.ok).toBe(true);
		const answeredTurn = answered.turn as { status: string };
		const answeredQuestion = answered.question as { status: string };
		expect(answeredTurn.status).toBe("active");
		expect(answeredQuestion.status).toBe("answered");
	});

	it("awaits turns with bounded timeout and preserves queued turns", async () => {
		const root = await tempRoot();
		const stateRoot = path.join(root, ".gjc", "state", "hermes-await");
		const server = createHermesMcpServer({
			env: {
				GJC_COORDINATOR_MCP_WORKDIR_ROOTS: root,
				GJC_COORDINATOR_MCP_STATE_ROOT: stateRoot,
				GJC_COORDINATOR_MCP_MUTATIONS: "sessions",
				GJC_COORDINATOR_MCP_PROFILE: "local",
				GJC_COORDINATOR_MCP_REPO: "repo",
			},
			services: {
				startSession: async input => ({
					sessionId: "gjc-demo",
					cwd: input.cwd,
					createdAt: "2026-06-07T00:00:00.000Z",
				}),
			},
		});
		await server.callTool("gjc_coordinator_start_session", { cwd: root, allow_mutation: true });
		const queued = await server.callTool("gjc_coordinator_send_prompt", {
			session_id: "gjc-demo",
			prompt: "queued",
			queue: true,
			allow_mutation: true,
		});

		const awaited = await server.callTool("gjc_coordinator_await_turn", {
			session_id: "gjc-demo",
			turn_id: queued.turn_id,
			timeout_ms: 1,
			poll_interval_ms: 1,
		});

		expect(awaited.ok).toBe(false);
		expect(awaited.reason).toBe("timeout");
		const awaitedTurn = awaited.turn as { status: string };
		expect(awaitedTurn.status).toBe("queued");
	});
});
