import { afterEach, describe, expect, it } from "bun:test";
import * as crypto from "node:crypto";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { COORDINATOR_MCP_TOOL_NAMES, createCoordinatorMcpServer } from "../src/coordinator-mcp/server";

const tempDirs: string[] = [];

async function tempRoot(): Promise<string> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-coordinator-server-"));
	tempDirs.push(dir);
	return dir;
}

afterEach(async () => {
	await Promise.all(tempDirs.splice(0).map(dir => fs.rm(dir, { recursive: true, force: true })));
});

describe("Coordinator MCP server protocol", () => {
	it("initializes with GJC coordinator server identity and lists GJC-named tools", async () => {
		const server = createCoordinatorMcpServer({ env: {} });

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

	it("does not read ambient coordinator MCP env when explicit env is provided", async () => {
		const root = await tempRoot();
		const original = process.env.GJC_COORDINATOR_MCP_MUTATIONS;
		process.env.GJC_COORDINATOR_MCP_MUTATIONS = "sessions";
		try {
			const server = createCoordinatorMcpServer({ env: { GJC_COORDINATOR_MCP_WORKDIR_ROOTS: root } });
			const response = await server.callTool("gjc_coordinator_start_session", { cwd: root, allow_mutation: true });
			expect(response).toEqual({ ok: false, reason: "coordinator_mutation_class_disabled:sessions" });
		} finally {
			if (original === undefined) {
				delete process.env.GJC_COORDINATOR_MCP_MUTATIONS;
			} else {
				process.env.GJC_COORDINATOR_MCP_MUTATIONS = original;
			}
		}
	});

	it("rejects unknown mcp-serve subcommands before launch fallback", async () => {
		const { validateMcpServeSubcommandForTest } = await import("../src/commands/mcp-serve");

		expect(() => validateMcpServeSubcommandForTest("bogus")).toThrow("unknown_mcp_serve_subcommand:bogus");
	});

	it("fails closed for mutating calls unless startup and per-call mutation are both enabled", async () => {
		const root = await tempRoot();
		const server = createCoordinatorMcpServer({ env: { GJC_COORDINATOR_MCP_WORKDIR_ROOTS: root } });

		const disabled = await server.handleJsonRpc({
			jsonrpc: "2.0",
			id: 3,
			method: "tools/call",
			params: { name: "gjc_coordinator_start_session", arguments: { cwd: root, allow_mutation: true } },
		});

		expect(disabled.result.isError).toBe(true);
		expect(disabled.result.content[0].text).toContain("coordinator_mutation_class_disabled:sessions");

		const enabledServer = createCoordinatorMcpServer({
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

	it("rejects unsafe visible session registration before tmux inspection", async () => {
		const root = await tempRoot();
		const server = createCoordinatorMcpServer({
			env: { GJC_COORDINATOR_MCP_WORKDIR_ROOTS: root, GJC_COORDINATOR_MCP_MUTATIONS: "sessions" },
		});

		expect(
			await server.callTool("gjc_coordinator_register_session", {
				session_id: "../bad",
				cwd: root,
				tmux_session: "visible",
				tmux_target: "visible:0.0",
				allow_mutation: true,
			}),
		).toEqual({ ok: false, reason: "invalid_session_id" });
		expect(
			await server.callTool("gjc_coordinator_register_session", {
				session_id: "visible",
				cwd: root,
				tmux_session: "bad/session",
				tmux_target: "visible:0.0",
				allow_mutation: true,
			}),
		).toEqual({ ok: false, reason: "invalid_tmux_session" });
	});

	it("registers a visible tmux session and sends prompts to the same authoritative target", async () => {
		const root = await tempRoot();
		const stateRoot = path.join(root, ".gjc", "state", "visible-register");
		const commands: string[][] = [];
		const server = createCoordinatorMcpServer({
			env: {
				GJC_COORDINATOR_MCP_WORKDIR_ROOTS: root,
				GJC_COORDINATOR_MCP_STATE_ROOT: stateRoot,
				GJC_COORDINATOR_MCP_MUTATIONS: "sessions",
				GJC_COORDINATOR_MCP_PROFILE: "local",
				GJC_COORDINATOR_MCP_REPO: "repo",
			},
			services: {
				commandRunner: async command => {
					commands.push(command);
					if (command[1] === "has-session") return { exitCode: 0, stdout: "", stderr: "" };
					if (command[1] === "display-message") return { exitCode: 0, stdout: "%24\n", stderr: "" };
					if (command[1] === "send-keys") return { exitCode: 0, stdout: "", stderr: "" };
					return { exitCode: 1, stdout: "", stderr: "unexpected command" };
				},
			},
		});

		const registered = await server.callTool("gjc_coordinator_register_session", {
			session_id: "visible-session",
			cwd: root,
			tmux_session: "visible-session",
			tmux_target: "visible-session:0.0",
			visible: true,
			warp_attached: true,
			source: "visible_launcher",
			model: "cliproxy/gpt-5.5",
			allow_mutation: true,
		});
		expect(registered).toMatchObject({
			ok: true,
			registered: true,
			session: {
				session_id: "visible-session",
				tmux_session: "visible-session",
				tmux_target: "visible-session:0.0",
				visible: true,
				authoritative: true,
				warp_attached: true,
				source: "visible_launcher",
				model: "cliproxy/gpt-5.5",
			},
			session_state: { state: "ready_for_input", ready_for_input: true, live: true },
		});

		const sent = await server.callTool("gjc_coordinator_send_prompt", {
			session_id: "visible-session",
			prompt: "do work",
			allow_mutation: true,
		});
		expect(sent).toMatchObject({
			ok: true,
			session_id: "visible-session",
			status: "active",
			delivery: { target: "visible-session:0.0", tmux_keys_sent: true, state: "tmux_keys_sent" },
		});
		expect(commands).toContainEqual(["tmux", "send-keys", "-t", "visible-session:0.0", "do work", "C-m", "C-m"]);
	});

	it("starts sessions through the structured GJC service adapter, not arbitrary terminal relay", async () => {
		const root = await tempRoot();
		const calls: unknown[] = [];
		const server = createCoordinatorMcpServer({
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
	it("delivers start-session prompts exactly once after the active turn is durable", async () => {
		const root = await tempRoot();
		const stateRoot = path.join(root, ".gjc", "state", "hermes-start-session-prompt");
		const commands: string[][] = [];
		let activeTurnExistedAtSend = false;
		const server = createCoordinatorMcpServer({
			env: {
				GJC_COORDINATOR_MCP_WORKDIR_ROOTS: root,
				GJC_COORDINATOR_MCP_STATE_ROOT: stateRoot,
				GJC_COORDINATOR_MCP_SESSION_COMMAND: "gjc --worktree",
				GJC_COORDINATOR_MCP_MUTATIONS: "sessions",
				GJC_COORDINATOR_MCP_PROFILE: "local",
				GJC_COORDINATOR_MCP_REPO: "repo",
			},
			services: {
				commandRunner: async command => {
					commands.push(command);
					if (command[1] === "new-session")
						return { exitCode: 0, stdout: "gjc-coordinator-test:0.0 %99\n", stderr: "" };
					if (command[1] === "has-session") return { exitCode: 0, stdout: "", stderr: "" };
					if (command[1] === "send-keys") {
						const activeTurnsDir = path.join(stateRoot, "local", "repo", "active-turns");
						const activeTurns = await fs.readdir(activeTurnsDir).catch(() => []);
						activeTurnExistedAtSend = activeTurns.length === 1;
						return { exitCode: 0, stdout: "", stderr: "" };
					}
					return { exitCode: 1, stdout: "", stderr: "unexpected command" };
				},
			},
		});

		const response = await server.callTool("gjc_coordinator_start_session", {
			cwd: root,
			prompt: "hello",
			allow_mutation: true,
		});

		expect(response.ok).toBe(true);
		expect(activeTurnExistedAtSend).toBe(true);
		expect(commands.filter(command => command[1] === "send-keys")).toEqual([
			["tmux", "send-keys", "-t", "gjc-coordinator-test:0.0", "hello", "C-m", "C-m"],
		]);
	});

	it("exposes a canonical polling coordination snapshot", async () => {
		const root = await tempRoot();
		const stateRoot = path.join(root, ".gjc", "state", "hermes-status");
		const server = createCoordinatorMcpServer({
			env: {
				GJC_COORDINATOR_MCP_WORKDIR_ROOTS: root,
				GJC_COORDINATOR_MCP_STATE_ROOT: stateRoot,
				GJC_COORDINATOR_MCP_MUTATIONS: "sessions,reports",
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
			prompt: "work",
			allow_mutation: true,
		});
		await server.callTool("gjc_coordinator_report_status", {
			session_id: "gjc-demo",
			turn_id: turn.turn_id,
			status: "completed",
			summary: "Done",
			allow_mutation: true,
		});

		const status = await server.callTool("gjc_coordinator_read_coordination_status");

		expect(status).toMatchObject({
			ok: true,
			schema_version: 1,
			transport: { mcp: "polling", push_subscriptions: false },
			summary: { sessions: 1, turns: 1, terminal_turns: 1, reports: 1 },
		});
		expect(status.sessions).toHaveLength(1);
		expect(status.session_states).toHaveLength(1);
		expect(status.turns).toHaveLength(1);
		expect(status.reports).toHaveLength(1);
		expect(status.events).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ event_type: "session_state", session_id: "gjc-demo", status: "completed" }),
				expect.objectContaining({ event_type: "turn_state", session_id: "gjc-demo", status: "completed" }),
				expect.objectContaining({ event_type: "coordination_report", session_id: "gjc-demo", status: "completed" }),
			]),
		);
	});

	it("persists audited follow-up, question answers, and bounded reports", async () => {
		const root = await tempRoot();
		const stateRoot = path.join(root, ".gjc", "state", "hermes-test");
		const server = createCoordinatorMcpServer({
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
		const server = createCoordinatorMcpServer({
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
		const server = createCoordinatorMcpServer({
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
		const queuedTurnId = queued.turn_id as string;
		expect(queued.status).toBe("queued");
		expect(queued.delivery).toMatchObject({ delivered: false, queued: true });
		const artifactPath = path.join(root, "artifact.txt");
		await Bun.write(artifactPath, "evidence");

		const completed = await server.callTool("gjc_coordinator_report_status", {
			session_id: "gjc-demo",
			turn_id: first.turn_id,
			status: "completed",
			summary: "Done",
			evidence_paths: [artifactPath],
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
		expect(completedTurn.evidence).toEqual([{ path: artifactPath }]);
		const promotedTurn = completed.promoted_turn as { status: string; turn_id: string };
		expect(promotedTurn.status).toBe("active");
		expect(promotedTurn.turn_id).toBe(queuedTurnId);

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
		expect(afterTerminal).toEqual({
			ok: false,
			reason: "active_turn_exists",
			session_id: "gjc-demo",
			active_turn_id: queued.turn_id,
		});
	});

	it("validates turn and question ownership before path-addressed mutations", async () => {
		const root = await tempRoot();
		const stateRoot = path.join(root, ".gjc", "state", "hermes-ids");
		const server = createCoordinatorMcpServer({
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
		const server = createCoordinatorMcpServer({
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

	it("wakes await_turn from durable turn changes without waiting for the fallback interval", async () => {
		const root = await tempRoot();
		const stateRoot = path.join(root, ".gjc", "state", "hermes-watch");
		const server = createCoordinatorMcpServer({
			env: {
				GJC_COORDINATOR_MCP_WORKDIR_ROOTS: root,
				GJC_COORDINATOR_MCP_STATE_ROOT: stateRoot,
				GJC_COORDINATOR_MCP_MUTATIONS: "sessions,reports",
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

		const started = Date.now();
		const timer = setTimeout(() => {
			void server.callTool("gjc_coordinator_report_status", {
				session_id: "gjc-demo",
				turn_id: queued.turn_id,
				status: "completed",
				summary: "Done",
				allow_mutation: true,
			});
		}, 25);
		try {
			const awaited = await server.callTool("gjc_coordinator_await_turn", {
				session_id: "gjc-demo",
				turn_id: queued.turn_id,
				timeout_ms: 1000,
				poll_interval_ms: 750,
			});

			expect(awaited.ok).toBe(true);
			expect((awaited.turn as { status: string }).status).toBe("completed");
			expect(Date.now() - started).toBeLessThan(500);
		} finally {
			clearTimeout(timer);
		}
	});

	it("terminalizes active turns from durable runtime session state", async () => {
		const root = await tempRoot();
		const stateRoot = path.join(root, ".gjc", "state", "hermes-runtime");
		const server = createCoordinatorMcpServer({
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
		const turn = await server.callTool("gjc_coordinator_send_prompt", {
			session_id: "gjc-demo",
			prompt: "work",
			allow_mutation: true,
		});
		const turnId = turn.turn_id as string;
		const sessionStatesDir = path.join(stateRoot, "local", "repo", "session-states");
		await fs.mkdir(sessionStatesDir, { recursive: true });
		await Bun.write(
			path.join(sessionStatesDir, "gjc-demo.json"),
			JSON.stringify({
				schema_version: 1,
				session_id: "gjc-demo",
				state: "completed",
				ready_for_input: true,
				current_turn_id: turnId,
				last_turn_id: turnId,
				updated_at: "2026-06-07T00:00:01.000Z",
				source: "agent_session_event",
				live: null,
				reason: "agent_end",
				final_response: {
					text: "Runtime final answer",
					format: "markdown",
					source: "agent_end",
					artifact_path: null,
					truncated: false,
				},
			}),
		);

		const read = await server.callTool("gjc_coordinator_read_turn", {
			session_id: "gjc-demo",
			turn_id: turnId,
		});

		expect((read.turn as { status: string }).status).toBe("completed");
		expect((read.turn as { final_response: { source: string; text: string } }).final_response).toMatchObject({
			source: "agent_end",
			text: "Runtime final answer",
		});
		expect((read.session_state as { state: string; last_turn_id: string }).state).toBe("completed");
		expect((read.session_state as { state: string; last_turn_id: string }).last_turn_id).toBe(turnId);
	});
	it("preserves runtime completion when callback wins the turn activation race", async () => {
		const root = await tempRoot();
		const stateRoot = path.join(root, ".gjc", "state", "hermes-runtime-race");
		let runtimeStatePath = "";
		const server = createCoordinatorMcpServer({
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
					tmuxSession: "gjc-demo",
					tmuxTarget: "gjc-demo:0.0",
					cwd: input.cwd,
					createdAt: "2026-06-07T00:00:00.000Z",
				}),
				commandRunner: async command => {
					if (command[1] === "has-session") return { exitCode: 0, stdout: "", stderr: "" };
					if (command[1] === "send-keys") {
						const activeTurn = JSON.parse(
							await Bun.file(path.join(stateRoot, "local", "repo", "active-turns", "gjc-demo.json")).text(),
						) as {
							turn_id: string;
						};
						runtimeStatePath = path.join(stateRoot, "local", "repo", "session-states", "gjc-demo.json");
						await fs.mkdir(path.dirname(runtimeStatePath), { recursive: true });
						await Bun.write(
							runtimeStatePath,
							JSON.stringify({
								schema_version: 1,
								session_id: "gjc-demo",
								state: "completed",
								ready_for_input: true,
								current_turn_id: activeTurn.turn_id,
								last_turn_id: activeTurn.turn_id,
								updated_at: "2026-06-07T00:00:01.000Z",
								source: "agent_session_event",
								live: null,
								reason: "agent_end",
								final_response: {
									text: "Runtime final answer",
									format: "markdown",
									source: "agent_end",
									artifact_path: null,
									truncated: false,
								},
							}),
						);
						return { exitCode: 0, stdout: "", stderr: "" };
					}
					return { exitCode: 1, stdout: "", stderr: "unexpected command" };
				},
			},
		});
		await server.callTool("gjc_coordinator_start_session", { cwd: root, allow_mutation: true });

		const turn = await server.callTool("gjc_coordinator_send_prompt", {
			session_id: "gjc-demo",
			prompt: "work",
			allow_mutation: true,
		});
		const turnId = turn.turn_id as string;
		const persistedState = JSON.parse(await Bun.file(runtimeStatePath).text()) as {
			state: string;
			current_turn_id: string;
		};
		expect(persistedState).toMatchObject({ state: "completed", current_turn_id: turnId });

		const read = await server.callTool("gjc_coordinator_read_turn", {
			session_id: "gjc-demo",
			turn_id: turnId,
		});

		expect((read.turn as { status: string }).status).toBe("completed");
		expect((read.turn as { final_response: { source: string; text: string } }).final_response).toMatchObject({
			source: "agent_end",
			text: "Runtime final answer",
		});
	});
	it("flags completed turns that lack reportable final responses", async () => {
		const root = await tempRoot();
		const stateRoot = path.join(root, ".gjc", "state", "hermes-runtime-missing-final");
		const server = createCoordinatorMcpServer({
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
		const turn = await server.callTool("gjc_coordinator_send_prompt", {
			session_id: "gjc-demo",
			prompt: "work",
			allow_mutation: true,
		});
		const turnId = turn.turn_id as string;
		const sessionStatesDir = path.join(stateRoot, "local", "repo", "session-states");
		await fs.mkdir(sessionStatesDir, { recursive: true });
		await Bun.write(
			path.join(sessionStatesDir, "gjc-demo.json"),
			JSON.stringify({
				schema_version: 1,
				session_id: "gjc-demo",
				state: "completed",
				ready_for_input: true,
				current_turn_id: turnId,
				last_turn_id: turnId,
				updated_at: "2026-06-07T00:00:01.000Z",
				source: "agent_session_event",
				live: null,
				reason: "agent_end",
			}),
		);

		const read = await server.callTool("gjc_coordinator_read_turn", {
			session_id: "gjc-demo",
			turn_id: turnId,
		});

		expect(read).toMatchObject({
			ok: true,
			completion_missing_final_response: true,
			advisory: "completion_missing_final_response",
		});
		expect((read.turn as { status: string }).status).toBe("completed");
		expect((read.turn as { evidence: Array<{ type: string }> }).evidence).toContainEqual(
			expect.objectContaining({ type: "completion_missing_final_response" }),
		);
	});
	it("terminalizes active turns quickly when the recorded tmux session is gone", async () => {
		const root = await tempRoot();
		const stateRoot = path.join(root, ".gjc", "state", "hermes-stale");
		const server = createCoordinatorMcpServer({
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
					tmuxSession: "definitely-missing-gjc-demo",
					tmuxTarget: "definitely-missing-gjc-demo:0.0",
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

		const read = await server.callTool("gjc_coordinator_read_turn", {
			session_id: "gjc-demo",
			turn_id: first.turn_id,
		});

		expect((read.turn as { status: string }).status).toBe("failed");
		expect((read.turn as { error: { code: string } }).error.code).toBe("session_unavailable");
		expect((read.session_state as { state: string }).state).toBe("stale");

		const second = await server.callTool("gjc_coordinator_send_prompt", {
			session_id: "gjc-demo",
			prompt: "second",
			allow_mutation: true,
		});
		expect(second.ok).toBe(true);
		expect(second.reason).toBeUndefined();
	});
	it("persists monotonic coordinator events and exposes long-poll watch semantics", async () => {
		const root = await tempRoot();
		const stateRoot = path.join(root, ".gjc", "state", "event-watch");
		const server = createCoordinatorMcpServer({
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
			},
		});

		await server.callTool("gjc_coordinator_start_session", { cwd: root, allow_mutation: true });
		const firstWatch = await server.callTool("gjc_coordinator_watch_events", { after_seq: 0, limit: 2 });
		expect(firstWatch.ok).toBe(true);
		expect(firstWatch.timed_out).toBe(false);
		expect(firstWatch.transport).toEqual({ mcp: "long_poll", push_subscriptions: false });
		const firstEvents = firstWatch.events as Array<{ seq: number; kind: string; session_id?: string }>;
		expect(firstEvents).toHaveLength(2);
		expect(firstEvents.map(event => event.seq)).toEqual([1, 2]);
		expect(firstEvents.map(event => event.kind)).toEqual(["session.started", "session.state_changed"]);

		const turn = await server.callTool("gjc_coordinator_send_prompt", {
			session_id: "gjc-demo",
			prompt: "continue",
			allow_mutation: true,
		});
		await server.callTool("gjc_coordinator_report_status", {
			session_id: "gjc-demo",
			turn_id: turn.turn_id,
			status: "completed",
			summary: "Done",
			allow_mutation: true,
		});

		const all = await server.callTool("gjc_coordinator_watch_events", { after_seq: 0 });
		const allEvents = all.events as Array<{
			seq: number;
			id: string;
			kind: string;
			session_id?: string;
			turn_id?: string;
		}>;
		expect(allEvents.map(event => event.seq)).toEqual(allEvents.map((_, index) => index + 1));
		expect(new Set(allEvents.map(event => event.id)).size).toBe(allEvents.length);
		expect(allEvents.map(event => event.kind)).toContain("turn.active");
		expect(allEvents.map(event => event.kind)).toContain("tmux.delivery_failed");
		expect(allEvents.map(event => event.kind)).toContain("turn.completed");
		expect(allEvents.map(event => event.kind)).toContain("report.written");

		const filtered = await server.callTool("gjc_coordinator_watch_events", {
			after_seq: 0,
			session_id: "gjc-demo",
			event_types: ["turn.completed", "report.written"],
		});
		expect((filtered.events as Array<{ kind: string }>).map(event => event.kind)).toEqual([
			"turn.completed",
			"report.written",
		]);

		const persistedServer = createCoordinatorMcpServer({
			env: {
				GJC_COORDINATOR_MCP_WORKDIR_ROOTS: root,
				GJC_COORDINATOR_MCP_STATE_ROOT: stateRoot,
				GJC_COORDINATOR_MCP_PROFILE: "local",
				GJC_COORDINATOR_MCP_REPO: "repo",
			},
		});
		const persisted = await persistedServer.callTool("gjc_coordinator_watch_events", { after_seq: 0 });
		expect((persisted.events as Array<{ seq: number }>).map(event => event.seq)).toEqual(
			allEvents.map(event => event.seq),
		);
	});

	it("serializes concurrent coordinator event appends per namespace", async () => {
		const root = await tempRoot();
		const stateRoot = path.join(root, ".gjc", "state", "event-concurrent");
		const server = createCoordinatorMcpServer({
			env: {
				GJC_COORDINATOR_MCP_WORKDIR_ROOTS: root,
				GJC_COORDINATOR_MCP_STATE_ROOT: stateRoot,
				GJC_COORDINATOR_MCP_MUTATIONS: "sessions",
				GJC_COORDINATOR_MCP_PROFILE: "local",
				GJC_COORDINATOR_MCP_REPO: "repo",
			},
			services: {
				startSession: async input => ({
					sessionId: crypto.randomUUID(),
					cwd: input.cwd,
					createdAt: "2026-06-07T00:00:00.000Z",
				}),
			},
		});

		await Promise.all(
			Array.from({ length: 8 }, () =>
				server.callTool("gjc_coordinator_start_session", { cwd: root, allow_mutation: true }),
			),
		);
		const watched = await server.callTool("gjc_coordinator_watch_events", { after_seq: 0, limit: 100 });
		const seqs = (watched.events as Array<{ seq: number }>).map(event => event.seq);
		expect(seqs).toEqual(Array.from({ length: seqs.length }, (_, index) => index + 1));
		expect(new Set(seqs).size).toBe(seqs.length);
	});

	it("long-polls coordinator events until timeout or a journal write", async () => {
		const root = await tempRoot();
		const stateRoot = path.join(root, ".gjc", "state", "event-long-poll");
		const server = createCoordinatorMcpServer({
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

		const empty = await server.callTool("gjc_coordinator_watch_events", { after_seq: 0, timeout_ms: 5 });
		expect(empty).toMatchObject({ ok: true, events: [], latest_seq: 0, timed_out: true });

		const watching = server.callTool("gjc_coordinator_watch_events", { after_seq: 0, timeout_ms: 1000 });
		const started = Promise.withResolvers<void>();
		const timer = setTimeout(() => {
			void server.callTool("gjc_coordinator_start_session", { cwd: root, allow_mutation: true }).then(
				() => started.resolve(),
				error => started.reject(error),
			);
		}, 25);
		try {
			const watched = await watching;
			expect(watched.timed_out).toBe(false);
			expect((watched.events as Array<{ kind: string }>).map(event => event.kind)).toContain("session.started");
			await started.promise;
		} finally {
			clearTimeout(timer);
		}

		const status = await server.callTool("gjc_coordinator_read_coordination_status", {});
		expect(status.latest_event_seq).toBeGreaterThanOrEqual(2);
		expect((status.recent_events as Array<{ kind: string }>).map(event => event.kind)).toContain("session.started");
	});
});
