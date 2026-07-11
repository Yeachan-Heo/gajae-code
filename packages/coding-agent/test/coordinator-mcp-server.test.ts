import { afterEach, describe, expect, it } from "bun:test";
import * as crypto from "node:crypto";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { postmortem } from "@gajae-code/utils";
import {
	boundedAwaitTurnTimeoutMs,
	boundedEventWatchTimeoutMs,
	boundedPollIntervalMs,
	boundedRuntimePromptAckTimeoutMs,
	COORDINATOR_AWAIT_TURN_TIMEOUT_MAX_MS,
	COORDINATOR_EVENT_WATCH_TIMEOUT_MAX_MS,
	COORDINATOR_MCP_TOOL_NAMES,
	COORDINATOR_POLL_INTERVAL_MAX_MS,
	coordinatorOwnerIsolationProbe,
	createCoordinatorMcpServer,
} from "../src/coordinator-mcp/server";
import {
	GJC_COORDINATOR_SESSION_ID_ENV,
	GJC_COORDINATOR_SESSION_STATE_FILE_ENV,
	persistCoordinatorRuntimeStateFromPostmortem,
} from "../src/gjc-runtime/session-state-sidecar";
import { createOwnerIntent, replaceOwnerGeneration } from "../src/gjc-runtime/tmux-owner-isolation";

const tempDirs: string[] = [];
const ORIGINAL_RUNTIME_STATE_FILE = process.env[GJC_COORDINATOR_SESSION_STATE_FILE_ENV];
const ORIGINAL_RUNTIME_SESSION_ID = process.env[GJC_COORDINATOR_SESSION_ID_ENV];

async function tempRoot(): Promise<string> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-coordinator-server-"));
	tempDirs.push(dir);
	return dir;
}
function shellQuote(value: string): string {
	return `'${value.replaceAll("'", `'\\''`)}'`;
}
function tmuxSubcommand(command: string[]): string | undefined {
	return command.find(value =>
		[
			"set-buffer",
			"paste-buffer",
			"delete-buffer",
			"send-keys",
			"new-session",
			"display-message",
			"has-session",
			"set-option",
			"kill-session",
			"kill-server",
			"if-shell",
		].includes(value),
	);
}

function tmuxIdentity(command: string[]): string {
	const target = command[command.indexOf("-t") + 1] ?? "session:0.0";
	const session = target.split(":", 1)[0] || "session";
	return `$${session} %24\n`;
}

function isTmuxPromptDeliveryCommand(command: string[]): boolean {
	return ["set-buffer", "paste-buffer", "send-keys"].includes(tmuxSubcommand(command) ?? "");
}

const TMUX_PROMPT_DELIVERY_COMMANDS = ["set-buffer", "paste-buffer", "send-keys", "send-keys"];

const PRIVATE_SOCKET = "gjc-test-private-socket";
const PRIVATE_OWNER_PID = 4242;
const PRIVATE_OWNER_START_TIME = "424242";

function privateOwnerProbe(socketKey = PRIVATE_SOCKET) {
	return {
		readCallerCgroup: async () => "0::/user.slice/user-1.service",
		probeServer: async (probedSocketKey: string) =>
			probedSocketKey === socketKey
				? {
						state: "safe" as const,
						pid: PRIVATE_OWNER_PID,
						startTime: PRIVATE_OWNER_START_TIME,
						cgroup: { classification: "safe" as const },
					}
				: { state: "absent" as const },
	};
}

async function persistPrivateOwnerProof(
	stateRoot: string,
	sessionId: string,
	socketKey = PRIVATE_SOCKET,
): Promise<void> {
	const sessionPath = path.join(stateRoot, "local", "repo", "sessions", `${sessionId}.json`);
	const session = JSON.parse(await fs.readFile(sessionPath, "utf8")) as Record<string, unknown>;
	await Bun.write(
		sessionPath,
		JSON.stringify({
			...session,
			tmux_socket_key: socketKey,
			tmux_owner_server_key: socketKey,
			tmux_owner_generation: `${sessionId}-generation`,
			tmux_owner_server_pid: PRIVATE_OWNER_PID,
			tmux_owner_server_start_time: PRIVATE_OWNER_START_TIME,
			tmux_native_session_id: `$${sessionId}`,
			pane_id: "%24",
		}),
	);
}

async function privateSessionProof(stateRoot: string, sessionId: string): Promise<Record<string, unknown>> {
	return JSON.parse(
		await fs.readFile(path.join(stateRoot, "local", "repo", "sessions", `${sessionId}.json`), "utf8"),
	) as Record<string, unknown>;
}

function expectPrivateTmuxMutations(commands: string[][], socketKey = PRIVATE_SOCKET): void {
	for (const command of commands.filter(isTmuxPromptDeliveryCommand))
		expect(command).toEqual(["tmux", "-L", socketKey, ...command.slice(3)]);
}

afterEach(async () => {
	if (ORIGINAL_RUNTIME_STATE_FILE === undefined) delete process.env[GJC_COORDINATOR_SESSION_STATE_FILE_ENV];
	else process.env[GJC_COORDINATOR_SESSION_STATE_FILE_ENV] = ORIGINAL_RUNTIME_STATE_FILE;
	if (ORIGINAL_RUNTIME_SESSION_ID === undefined) delete process.env[GJC_COORDINATOR_SESSION_ID_ENV];
	else process.env[GJC_COORDINATOR_SESSION_ID_ENV] = ORIGINAL_RUNTIME_SESSION_ID;
	await Promise.all(tempDirs.splice(0).map(dir => fs.rm(dir, { recursive: true, force: true })));
});

describe("Coordinator MCP server protocol", () => {
	it("bounds await_turn and event-watch timeouts with distinct caps", () => {
		expect(boundedAwaitTurnTimeoutMs(1_800_000)).toBe(1_800_000);
		expect(boundedAwaitTurnTimeoutMs(3_600_000)).toBe(COORDINATOR_AWAIT_TURN_TIMEOUT_MAX_MS);
		expect(boundedEventWatchTimeoutMs(1_800_000)).toBe(COORDINATOR_EVENT_WATCH_TIMEOUT_MAX_MS);
		expect(boundedPollIntervalMs(10_000)).toBe(10_000);
		expect(boundedPollIntervalMs(60_000)).toBe(COORDINATOR_POLL_INTERVAL_MAX_MS);
		expect(boundedRuntimePromptAckTimeoutMs(3_600_000)).toBe(300_000);
	});

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
			expect(response).toEqual({ ok: false, reason: "coordinator_mutation_class_disabled" });
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
		expect(disabled.result.content[0].text).toContain("coordinator_mutation_class_disabled");

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
		expect(missingPerCall.result.content[0].text).toContain("coordinator_mutation_call_not_allowed");
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

	it("refuses prompt delivery for registered sessions without persisted private owner proof", async () => {
		const root = await tempRoot();
		const stateRoot = path.join(root, ".gjc", "state", "primary-enter-token");
		const deliveryCommands: string[][] = [];
		const server = createCoordinatorMcpServer({
			env: {
				GJC_COORDINATOR_MCP_WORKDIR_ROOTS: root,
				GJC_COORDINATOR_MCP_STATE_ROOT: stateRoot,
				GJC_COORDINATOR_MCP_MUTATIONS: "sessions",
				GJC_COORDINATOR_MCP_PROFILE: "local",
				GJC_COORDINATOR_MCP_REPO: "repo",
			},
			services: {
				ownerIsolationProbe: privateOwnerProbe(),
				commandRunner: async command => {
					if (tmuxSubcommand(command) === "has-session") return { exitCode: 0, stdout: "", stderr: "" };
					if (tmuxSubcommand(command) === "display-message")
						return { exitCode: 0, stdout: tmuxIdentity(command), stderr: "" };
					if (isTmuxPromptDeliveryCommand(command)) {
						deliveryCommands.push(command);
						return { exitCode: 0, stdout: "", stderr: "" };
					}
					return { exitCode: 1, stdout: "", stderr: "unexpected command" };
				},
			},
		});

		await server.callTool("gjc_coordinator_register_session", {
			session_id: "visible-session",
			cwd: root,
			tmux_session: "visible-session",
			tmux_target: "visible-session:0.0",
			visible: true,
			allow_mutation: true,
		});
		await server.callTool("gjc_coordinator_send_prompt", {
			session_id: "visible-session",
			prompt: "-primary submit token",
			allow_mutation: true,
		});

		expect(deliveryCommands).toHaveLength(0);
	});

	it("rejects pane identity proof from a different tmux session", async () => {
		const root = await tempRoot();
		const stateRoot = path.join(root, ".gjc", "state", "wrong-tmux-session");
		const deliveryCommands: string[][] = [];
		const server = createCoordinatorMcpServer({
			env: {
				GJC_COORDINATOR_MCP_WORKDIR_ROOTS: root,
				GJC_COORDINATOR_MCP_STATE_ROOT: stateRoot,
				GJC_COORDINATOR_MCP_MUTATIONS: "sessions",
				GJC_COORDINATOR_MCP_PROFILE: "local",
				GJC_COORDINATOR_MCP_REPO: "repo",
			},
			services: {
				ownerIsolationProbe: privateOwnerProbe(),
				commandRunner: async command => {
					if (tmuxSubcommand(command) === "has-session") return { exitCode: 0, stdout: "", stderr: "" };
					if (tmuxSubcommand(command) === "display-message")
						return { exitCode: 0, stdout: "$other-session %24\n", stderr: "" };
					if (isTmuxPromptDeliveryCommand(command)) deliveryCommands.push(command);
					return { exitCode: 0, stdout: "", stderr: "" };
				},
			},
		});
		await server.callTool("gjc_coordinator_register_session", {
			session_id: "visible-session",
			cwd: root,
			tmux_session: "visible-session",
			tmux_target: "visible-session:0.0",
			visible: true,
			allow_mutation: true,
		});
		await persistPrivateOwnerProof(stateRoot, "visible-session");
		const response = await server.callTool("gjc_coordinator_send_prompt", {
			session_id: "visible-session",
			prompt: "-primary submit token",
			allow_mutation: true,
		});
		expect(response).toMatchObject({ ok: true, delivered: false });
		expect(deliveryCommands).toHaveLength(0);
	});

	it.each([
		"unsafe",
		"unverifiable",
		"replaced",
	] as const)("refuses prompt mutation when persisted private owner proof is %s", async proofState => {
		const root = await tempRoot();
		const stateRoot = path.join(root, ".gjc", "state", `owner-proof-${proofState}`);
		const mutations: string[][] = [];
		const server = createCoordinatorMcpServer({
			env: {
				GJC_COORDINATOR_MCP_WORKDIR_ROOTS: root,
				GJC_COORDINATOR_MCP_STATE_ROOT: stateRoot,
				GJC_COORDINATOR_MCP_MUTATIONS: "sessions",
				GJC_COORDINATOR_MCP_PROFILE: "local",
				GJC_COORDINATOR_MCP_REPO: "repo",
			},
			services: {
				ownerIsolationProbe: {
					readCallerCgroup: async () => "0::/user.slice/user-1.service",
					probeServer: async () => {
						if (proofState === "unsafe") return { state: "unsafe" as const };
						if (proofState === "unverifiable") return { state: "absent" as const };
						return {
							state: "safe" as const,
							pid: PRIVATE_OWNER_PID + 1,
							startTime: PRIVATE_OWNER_START_TIME,
							cgroup: { classification: "safe" as const },
						};
					},
				},
				commandRunner: async command => {
					if (tmuxSubcommand(command) === "has-session") return { exitCode: 0, stdout: "", stderr: "" };
					if (tmuxSubcommand(command) === "display-message")
						return { exitCode: 0, stdout: tmuxIdentity(command), stderr: "" };
					if (isTmuxPromptDeliveryCommand(command)) mutations.push(command);
					return { exitCode: 0, stdout: "", stderr: "" };
				},
			},
		});
		await server.callTool("gjc_coordinator_register_session", {
			session_id: "visible-session",
			cwd: root,
			tmux_session: "visible-session",
			tmux_target: "visible-session:0.0",
			allow_mutation: true,
		});
		await persistPrivateOwnerProof(stateRoot, "visible-session");
		const prompt = await server.callTool("gjc_coordinator_send_prompt", {
			session_id: "visible-session",
			prompt: "do not mutate",
			allow_mutation: true,
		});
		expect(prompt.delivery).toMatchObject({ tmux_keys_sent: false, state: "unavailable" });
		expect(mutations).toEqual([]);
	});

	it("registers a visible tmux session and submits prompts with tmux Enter", async () => {
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
				ownerIsolationProbe: privateOwnerProbe(),
				commandRunner: async command => {
					commands.push(command);
					if (tmuxSubcommand(command) === "has-session") return { exitCode: 0, stdout: "", stderr: "" };
					if (tmuxSubcommand(command) === "display-message")
						return { exitCode: 0, stdout: tmuxIdentity(command), stderr: "" };
					if (isTmuxPromptDeliveryCommand(command)) return { exitCode: 0, stdout: "", stderr: "" };
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
		await persistPrivateOwnerProof(stateRoot, "visible-session");
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
		expect(commands).toEqual(
			expect.arrayContaining([
				expect.arrayContaining([
					"tmux",
					"-L",
					PRIVATE_SOCKET,
					"set-buffer",
					"-b",
					expect.any(String),
					"--",
					"do work",
				]),
				expect.arrayContaining([
					"tmux",
					"-L",
					PRIVATE_SOCKET,
					"paste-buffer",
					"-d",
					"-b",
					expect.any(String),
					"-t",
					"%24",
				]),
				["tmux", "-L", PRIVATE_SOCKET, "send-keys", "-t", "%24", "Escape"],
				["tmux", "-L", PRIVATE_SOCKET, "send-keys", "-t", "%24", "Enter"],
			]),
		);
		expect(commands).not.toContainEqual(["tmux", "-L", PRIVATE_SOCKET, "send-keys", "-t", "%24", "-l", "\x1b[13;5u"]);
		expect(commands.slice(-4).map(tmuxSubcommand)).toEqual(TMUX_PROMPT_DELIVERY_COMMANDS);
		expect(commands.at(-2)).toEqual(["tmux", "-L", PRIVATE_SOCKET, "send-keys", "-t", "%24", "Escape"]);
		expect(commands.at(-1)).toEqual(["tmux", "-L", PRIVATE_SOCKET, "send-keys", "-t", "%24", "Enter"]);
	});

	it("fails tmux-delivered turns that never receive a runtime prompt ack", async () => {
		const root = await tempRoot();
		const stateRoot = path.join(root, ".gjc", "state", "unacknowledged-delivery");
		const server = createCoordinatorMcpServer({
			env: {
				GJC_COORDINATOR_MCP_WORKDIR_ROOTS: root,
				GJC_COORDINATOR_MCP_STATE_ROOT: stateRoot,
				GJC_COORDINATOR_MCP_MUTATIONS: "sessions",
				GJC_COORDINATOR_MCP_PROFILE: "local",
				GJC_COORDINATOR_MCP_REPO: "repo",
				GJC_COORDINATOR_MCP_PROMPT_ACK_TIMEOUT_MS: "1",
			},
			services: {
				ownerIsolationProbe: privateOwnerProbe(),
				startSession: async input => ({
					sessionId: "delegate-session",
					tmuxSession: "delegate-session",
					tmuxTarget: "delegate-session:0.0",
					tmuxSocketKey: PRIVATE_SOCKET,
					tmuxOwnerServerKey: PRIVATE_SOCKET,
					tmuxOwnerGeneration: "delegate-generation",
					tmuxOwnerServerPid: PRIVATE_OWNER_PID,
					tmuxOwnerServerStartTime: PRIVATE_OWNER_START_TIME,
					tmuxNativeSessionId: "$delegate-session",
					paneId: "%24",
					cwd: input.cwd,
					createdAt: "2026-06-28T00:00:00.000Z",
				}),
				commandRunner: async command => {
					if (tmuxSubcommand(command) === "has-session") return { exitCode: 0, stdout: "", stderr: "" };
					if (tmuxSubcommand(command) === "display-message")
						return { exitCode: 0, stdout: tmuxIdentity(command), stderr: "" };
					if (isTmuxPromptDeliveryCommand(command)) return { exitCode: 0, stdout: "", stderr: "" };
					if (tmuxSubcommand(command) === "capture-pane") return { exitCode: 0, stdout: "idle\n", stderr: "" };
					return { exitCode: 1, stdout: "", stderr: "unexpected command" };
				},
			},
		});

		await server.callTool("gjc_coordinator_register_session", {
			session_id: "visible-session",
			cwd: root,
			tmux_session: "visible-session",
			tmux_target: "visible-session:0.0",
			visible: true,
			allow_mutation: true,
		});
		await persistPrivateOwnerProof(stateRoot, "visible-session");
		const sent = await server.callTool("gjc_coordinator_send_prompt", {
			session_id: "visible-session",
			prompt: "do work",
			allow_mutation: true,
		});
		expect(sent).toMatchObject({
			ok: true,
			status: "active",
			session_state: { state: "running" },
			delivery: { tmux_keys_sent: true, prompt_acknowledged: false, state: "tmux_keys_sent" },
		});

		await Bun.sleep(5);
		const read = await server.callTool("gjc_coordinator_read_turn", {
			session_id: "visible-session",
			turn_id: sent.turn_id,
		});
		expect(read).toMatchObject({
			ok: true,
			turn: {
				status: "failed",
				delivery: { tmux_keys_sent: true, prompt_acknowledged: false, state: "unacknowledged" },
				error: { code: "runtime_prompt_ack_timeout" },
				final_response: { source: "coordinator_delivery_ack_timeout" },
			},
			session_state: { state: "stale", reason: "runtime_prompt_ack_timeout" },
		});
		expect(JSON.stringify(read)).toContain("turn never started");

		const status = await server.callTool("gjc_coordinator_read_coordination_status");
		expect(status.summary).toMatchObject({ active_sessions: 1, active_turns: 0, terminal_turns: 1 });
		expect(status.turns).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					status: "failed",
					error: expect.objectContaining({ code: "runtime_prompt_ack_timeout" }),
				}),
			]),
		);
		const events = await server.callTool("gjc_coordinator_watch_events", {
			after_seq: 0,
			event_types: ["turn.failed"],
			timeout_ms: 1,
		});
		expect(events.events).toEqual(
			expect.arrayContaining([expect.objectContaining({ kind: "turn.failed", turn_id: sent.turn_id })]),
		);

		const delegated = await server.callTool("gjc_delegate_execute", {
			cwd: root,
			task: "execute delegated work",
			allow_mutation: true,
			await_completion: true,
			timeout_ms: 50,
			poll_interval_ms: 1,
		});
		expect(delegated).toMatchObject({
			ok: true,
			workflow: "execute",
			status: "failed",
			turn: {
				delivery: { tmux_keys_sent: true, prompt_acknowledged: false, state: "unacknowledged" },
				error: { code: "runtime_prompt_ack_timeout" },
			},
		});
	});

	it("redacts private owner controls from coordinator public session responses while routing internally", async () => {
		const root = await tempRoot();
		const stateRoot = path.join(root, ".gjc", "state", "public-owner-redaction");
		const commands: string[][] = [];
		let started = 0;
		const server = createCoordinatorMcpServer({
			env: {
				GJC_COORDINATOR_MCP_WORKDIR_ROOTS: root,
				GJC_COORDINATOR_MCP_STATE_ROOT: stateRoot,
				GJC_COORDINATOR_MCP_MUTATIONS: "sessions",
				GJC_COORDINATOR_MCP_PROFILE: "local",
				GJC_COORDINATOR_MCP_REPO: "repo",
			},
			services: {
				ownerIsolationProbe: privateOwnerProbe(),
				startSession: async input => ({
					sessionId: `public-session-${++started}`,
					tmuxSession: `public-session-${started}`,
					tmuxTarget: `public-session-${started}:0.0`,
					tmuxSocketKey: PRIVATE_SOCKET,
					tmuxOwnerGeneration: "private-generation",
					tmuxOwnerStateDir: "/private/state",
					tmuxOwnerServerKey: PRIVATE_SOCKET,
					tmuxOwnerServerPid: PRIVATE_OWNER_PID,
					tmuxOwnerServerStartTime: PRIVATE_OWNER_START_TIME,
					tmuxNativeSessionId: "$buffer-session",
					paneId: "%24",
					owner_terminal: {
						generation: "nested-generation",
						server_key: PRIVATE_SOCKET,
						intent_id: "nested-intent",
						dedupe_key: "nested-dedupe",
						pid: PRIVATE_OWNER_PID,
						start_time: PRIVATE_OWNER_START_TIME,
						socket_key: PRIVATE_SOCKET,
					},
					nested: {
						ownerTerminal: {
							generation: "camel-nested-generation",
							server_key: PRIVATE_SOCKET,
							intent_id: "camel-nested-intent",
							dedupe_key: "camel-nested-dedupe",
							pid: PRIVATE_OWNER_PID,
							start_time: PRIVATE_OWNER_START_TIME,
							socket_key: PRIVATE_SOCKET,
						},
					},
					cwd: input.cwd,
				}),
				commandRunner: async command => {
					commands.push(command);
					return { exitCode: 0, stdout: "", stderr: "" };
				},
			},
		});
		const start = await server.callTool("gjc_coordinator_start_session", { cwd: root, allow_mutation: true });
		const sessionId = (start.session as { session_id: string }).session_id;
		const outputs = [
			start,
			await server.callTool("gjc_coordinator_list_sessions"),
			await server.callTool("gjc_coordinator_read_status", { session_id: sessionId }),
			await server.callTool("gjc_coordinator_read_coordination_status"),
			await server.callTool("gjc_delegate_execute", {
				cwd: root,
				task: "delegate without exposing host controls",
				allow_mutation: true,
			}),
		];
		for (const output of outputs) {
			expect(JSON.stringify(output)).not.toContain(PRIVATE_SOCKET);
			expect(JSON.stringify(output)).not.toContain(String(PRIVATE_OWNER_PID));
			expect(JSON.stringify(output)).not.toContain(PRIVATE_OWNER_START_TIME);
			expect(JSON.stringify(output)).not.toMatch(
				/tmux_(socket_key|owner_(generation|state_dir|server_(key|pid|start_time)))/,
			);
			expect(JSON.stringify(output)).not.toMatch(
				/owner_?terminal|nested-(generation|intent|dedupe)|camel-nested-(generation|intent|dedupe)/,
			);
		}
		expectPrivateTmuxMutations(commands);
		const privateSession = await privateSessionProof(stateRoot, sessionId);
		expect(privateSession.tmux_socket_key).toBe(PRIVATE_SOCKET);
	});
	it("deletes tmux prompt buffers when paste delivery fails", async () => {
		const root = await tempRoot();
		const stateRoot = path.join(root, ".gjc", "state", "paste-buffer-failure-cleanup");
		const commands: string[][] = [];
		let deleteBufferSucceeded = false;
		const server = createCoordinatorMcpServer({
			env: {
				GJC_COORDINATOR_MCP_WORKDIR_ROOTS: root,
				GJC_COORDINATOR_MCP_STATE_ROOT: stateRoot,
				GJC_COORDINATOR_MCP_MUTATIONS: "sessions",
				GJC_COORDINATOR_MCP_PROFILE: "local",
				GJC_COORDINATOR_MCP_REPO: "repo",
			},
			services: {
				ownerIsolationProbe: privateOwnerProbe(),
				commandRunner: async command => {
					commands.push(command);
					if (tmuxSubcommand(command) === "has-session") return { exitCode: 0, stdout: "", stderr: "" };
					if (tmuxSubcommand(command) === "display-message")
						return { exitCode: 0, stdout: tmuxIdentity(command), stderr: "" };
					if (tmuxSubcommand(command) === "set-buffer") return { exitCode: 0, stdout: "", stderr: "" };
					if (tmuxSubcommand(command) === "paste-buffer")
						return { exitCode: 1, stdout: "", stderr: "paste failed" };
					if (tmuxSubcommand(command) === "delete-buffer") {
						deleteBufferSucceeded = true;
						return { exitCode: 0, stdout: "", stderr: "" };
					}
					return { exitCode: 1, stdout: "", stderr: "unexpected command" };
				},
			},
		});

		await server.callTool("gjc_coordinator_register_session", {
			session_id: "visible-session",
			cwd: root,
			tmux_session: "visible-session",
			tmux_target: "visible-session:0.0",
			visible: true,
			allow_mutation: true,
		});
		await persistPrivateOwnerProof(stateRoot, "visible-session");
		const response = await server.callTool("gjc_coordinator_send_prompt", {
			session_id: "visible-session",
			prompt: "sensitive multiline\n-prompt",
			allow_mutation: true,
		});

		const bufferName = commands.find(command => tmuxSubcommand(command) === "set-buffer")?.[5];
		expect(response).toMatchObject({ ok: true, status: "active" });
		expect(commands).toEqual(
			expect.arrayContaining([
				["tmux", "-L", PRIVATE_SOCKET, "set-buffer", "-b", bufferName, "--", "sensitive multiline\n-prompt"],
				["tmux", "-L", PRIVATE_SOCKET, "paste-buffer", "-d", "-b", bufferName, "-t", "%24"],
				["tmux", "-L", PRIVATE_SOCKET, "delete-buffer", "-b", bufferName],
			]),
		);
		expect(deleteBufferSucceeded).toBe(true);
		expect(commands).not.toContainEqual(["tmux", "-L", PRIVATE_SOCKET, "send-keys", "-t", "%24", "Escape"]);
		expect(commands).not.toContainEqual(["tmux", "-L", PRIVATE_SOCKET, "send-keys", "-t", "%24", "Enter"]);
	});

	it("contains prompt bytes when buffer deletion cannot be verified", async () => {
		const root = await tempRoot();
		const stateRoot = path.join(root, ".gjc", "state", "paste-buffer-delete-failure");
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
				ownerIsolationProbe: privateOwnerProbe(),
				commandRunner: async command => {
					commands.push(command);
					if (tmuxSubcommand(command) === "has-session" || tmuxSubcommand(command) === "display-message")
						return { exitCode: 0, stdout: tmuxIdentity(command), stderr: "" };
					if (tmuxSubcommand(command) === "set-buffer") return { exitCode: 0, stdout: "", stderr: "" };
					if (tmuxSubcommand(command) === "paste-buffer" || tmuxSubcommand(command) === "delete-buffer")
						return { exitCode: 1, stdout: "", stderr: "failed" };
					if (command.includes("kill-session") || command.includes("kill-server"))
						return { exitCode: 0, stdout: "", stderr: "" };
					return { exitCode: 1, stdout: "", stderr: "unexpected command" };
				},
			},
		});
		await server.callTool("gjc_coordinator_register_session", {
			session_id: "visible-session",
			cwd: root,
			tmux_session: "visible-session",
			tmux_target: "visible-session:0.0",
			allow_mutation: true,
		});
		await persistPrivateOwnerProof(stateRoot, "visible-session");
		const response = await server.callTool("gjc_coordinator_send_prompt", {
			session_id: "visible-session",
			prompt: "private prompt",
			allow_mutation: true,
		});
		expect(response).toMatchObject({ ok: false, reason: "coordinator_prompt_buffer_privacy_unverified" });
		expect(commands.filter(command => tmuxSubcommand(command) === "delete-buffer")).toHaveLength(2);
		expect(commands.some(command => tmuxSubcommand(command) === "kill-session")).toBe(false);
		expect(commands.some(command => tmuxSubcommand(command) === "kill-server")).toBe(false);
	});

	it("submits tmux-delivered prompts with tmux Enter after literal typing", async () => {
		const root = await tempRoot();
		const stateRoot = path.join(root, ".gjc", "state", "submit-chord-delivery");
		const deliveryCommands: string[][] = [];
		const server = createCoordinatorMcpServer({
			env: {
				GJC_COORDINATOR_MCP_WORKDIR_ROOTS: root,
				GJC_COORDINATOR_MCP_STATE_ROOT: stateRoot,
				GJC_COORDINATOR_MCP_MUTATIONS: "sessions",
				GJC_COORDINATOR_MCP_PROFILE: "local",
				GJC_COORDINATOR_MCP_REPO: "repo",
			},
			services: {
				ownerIsolationProbe: privateOwnerProbe(),
				commandRunner: async command => {
					if (tmuxSubcommand(command) === "has-session") return { exitCode: 0, stdout: "", stderr: "" };
					if (tmuxSubcommand(command) === "display-message")
						return { exitCode: 0, stdout: tmuxIdentity(command), stderr: "" };
					if (isTmuxPromptDeliveryCommand(command)) {
						deliveryCommands.push(command);
						return { exitCode: 0, stdout: "", stderr: "" };
					}
					if (tmuxSubcommand(command) === "capture-pane") return { exitCode: 0, stdout: "idle\n", stderr: "" };
					return { exitCode: 1, stdout: "", stderr: "unexpected command" };
				},
			},
		});

		await server.callTool("gjc_coordinator_register_session", {
			session_id: "visible-session",
			cwd: root,
			tmux_session: "visible-session",
			tmux_target: "visible-session:0.0",
			visible: true,
			allow_mutation: true,
		});
		await persistPrivateOwnerProof(stateRoot, "visible-session");
		await server.callTool("gjc_coordinator_send_prompt", {
			session_id: "visible-session",
			prompt: "line one\nline two",
			allow_mutation: true,
		});

		expect(deliveryCommands).toHaveLength(4);
		const bufferName = deliveryCommands[0]?.[5];
		expect(deliveryCommands).toEqual([
			["tmux", "-L", PRIVATE_SOCKET, "set-buffer", "-b", bufferName, "--", "line one\nline two"],
			["tmux", "-L", PRIVATE_SOCKET, "paste-buffer", "-d", "-b", bufferName, "-t", "%24"],
			["tmux", "-L", PRIVATE_SOCKET, "send-keys", "-t", "%24", "Escape"],
			["tmux", "-L", PRIVATE_SOCKET, "send-keys", "-t", "%24", "Enter"],
		]);
		expect(deliveryCommands).not.toContainEqual(["tmux", "send-keys", "-t", "%24", "-l", "\x1b[13;5u"]);
	});

	it("delivers delegated skill prompts through a tmux paste buffer preserving the slash-command separator", async () => {
		const root = await tempRoot();
		const stateRoot = path.join(root, ".gjc", "state", "delegate-paste-buffer");
		let pastedPrompt = "";
		const deliveryCommands: string[][] = [];
		const server = createCoordinatorMcpServer({
			env: {
				GJC_COORDINATOR_MCP_WORKDIR_ROOTS: root,
				GJC_COORDINATOR_MCP_STATE_ROOT: stateRoot,
				GJC_COORDINATOR_MCP_MUTATIONS: "sessions",
				GJC_COORDINATOR_MCP_PROFILE: "local",
				GJC_COORDINATOR_MCP_REPO: "repo",
			},
			services: {
				ownerIsolationProbe: privateOwnerProbe(),
				startSession: async input => ({
					sessionId: "delegate-session",
					tmuxSession: "delegate-session",
					tmuxTarget: "delegate-session:0.0",
					tmuxSocketKey: PRIVATE_SOCKET,
					tmuxOwnerServerKey: PRIVATE_SOCKET,
					tmuxOwnerGeneration: "delegate-generation",
					tmuxOwnerServerPid: PRIVATE_OWNER_PID,
					tmuxOwnerServerStartTime: PRIVATE_OWNER_START_TIME,
					tmuxNativeSessionId: "$delegate-session",
					paneId: "%24",
					cwd: input.cwd,
					createdAt: "2026-07-02T00:00:00.000Z",
				}),
				commandRunner: async command => {
					if (tmuxSubcommand(command) === "has-session") return { exitCode: 0, stdout: "", stderr: "" };
					if (tmuxSubcommand(command) === "display-message")
						return { exitCode: 0, stdout: "$delegate-session %24\n", stderr: "" };
					if (isTmuxPromptDeliveryCommand(command)) {
						deliveryCommands.push(command);
						if (tmuxSubcommand(command) === "set-buffer") pastedPrompt = command.at(-1) ?? "";
						return { exitCode: 0, stdout: "", stderr: "" };
					}
					return { exitCode: 1, stdout: "", stderr: "unexpected command" };
				},
			},
		});

		const delegated = await server.callTool("gjc_delegate_execute", {
			cwd: root,
			task: "Repro smoke only.",
			allow_mutation: true,
		});

		expect(delegated).toMatchObject({ ok: true, workflow: "execute", status: "active" });
		expect(deliveryCommands.map(tmuxSubcommand)).toEqual(TMUX_PROMPT_DELIVERY_COMMANDS);
		expect(
			pastedPrompt.startsWith("/skill:ultragoal\n\nDelegated by coordinator MCP tool: gjc_delegate_execute"),
		).toBe(true);
		expect(pastedPrompt).toContain("\nTask:\nRepro smoke only.\n");
		expect(pastedPrompt).not.toContain("/skill:ultragoalDelegated");
	});

	it("marks tmux-delivered turns acknowledged when runtime state accepts the current turn", async () => {
		const root = await tempRoot();
		const stateRoot = path.join(root, ".gjc", "state", "acknowledged-delivery");
		const server = createCoordinatorMcpServer({
			env: {
				GJC_COORDINATOR_MCP_WORKDIR_ROOTS: root,
				GJC_COORDINATOR_MCP_STATE_ROOT: stateRoot,
				GJC_COORDINATOR_MCP_MUTATIONS: "sessions",
				GJC_COORDINATOR_MCP_PROFILE: "local",
				GJC_COORDINATOR_MCP_REPO: "repo",
				GJC_COORDINATOR_MCP_PROMPT_ACK_TIMEOUT_MS: "60000",
			},
			services: {
				ownerIsolationProbe: privateOwnerProbe(),
				commandRunner: async command => {
					if (tmuxSubcommand(command) === "has-session") return { exitCode: 0, stdout: "", stderr: "" };
					if (tmuxSubcommand(command) === "display-message")
						return { exitCode: 0, stdout: tmuxIdentity(command), stderr: "" };
					if (isTmuxPromptDeliveryCommand(command)) return { exitCode: 0, stdout: "", stderr: "" };
					if (tmuxSubcommand(command) === "capture-pane") return { exitCode: 0, stdout: "working\n", stderr: "" };
					return { exitCode: 1, stdout: "", stderr: "unexpected command" };
				},
			},
		});

		await server.callTool("gjc_coordinator_register_session", {
			session_id: "visible-session",
			cwd: root,
			tmux_session: "visible-session",
			tmux_target: "visible-session:0.0",
			visible: true,
			allow_mutation: true,
		});
		await persistPrivateOwnerProof(stateRoot, "visible-session");
		const sent = await server.callTool("gjc_coordinator_send_prompt", {
			session_id: "visible-session",
			prompt: "do acknowledged work",
			allow_mutation: true,
		});
		const turnId = sent.turn_id as string;
		const sessionStatesDir = path.join(stateRoot, "local", "repo", "session-states");
		await fs.mkdir(sessionStatesDir, { recursive: true });
		await Bun.write(
			path.join(sessionStatesDir, "visible-session.json"),
			JSON.stringify({
				schema_version: 1,
				session_id: "visible-session",
				state: "running",
				ready_for_input: false,
				current_turn_id: turnId,
				last_turn_id: null,
				updated_at: "2026-06-28T00:00:01.000Z",
				source: "agent_session_event",
				live: true,
				reason: "turn_start",
			}),
		);

		const read = await server.callTool("gjc_coordinator_read_turn", {
			session_id: "visible-session",
			turn_id: turnId,
		});

		expect(read).toMatchObject({
			ok: true,
			turn: {
				status: "active",
				delivery: { tmux_keys_sent: true, prompt_acknowledged: true, state: "acknowledged" },
				error: null,
			},
			session_state: { state: "running", current_turn_id: turnId, source: "agent_session_event" },
		});
		expect((read.turn as { delivery: { attempts: Array<{ reason: string | null }> } }).delivery.attempts).toEqual(
			expect.arrayContaining([expect.objectContaining({ reason: "runtime_prompt_acknowledged" })]),
		);
	});

	it("records a durable reason when tmux disappears after prompt acknowledgement", async () => {
		const root = await tempRoot();
		const stateRoot = path.join(root, ".gjc", "state", "acknowledged-tmux-vanish");
		let tmuxLive = true;
		const server = createCoordinatorMcpServer({
			env: {
				GJC_COORDINATOR_MCP_WORKDIR_ROOTS: root,
				GJC_COORDINATOR_MCP_STATE_ROOT: stateRoot,
				GJC_COORDINATOR_MCP_MUTATIONS: "sessions",
				GJC_COORDINATOR_MCP_PROFILE: "local",
				GJC_COORDINATOR_MCP_REPO: "repo",
			},
			services: {
				ownerIsolationProbe: privateOwnerProbe(),
				commandRunner: async command => {
					if (tmuxSubcommand(command) === "has-session")
						return { exitCode: tmuxLive ? 0 : 1, stdout: "", stderr: "" };
					if (tmuxSubcommand(command) === "display-message")
						return { exitCode: 0, stdout: tmuxIdentity(command), stderr: "" };
					if (isTmuxPromptDeliveryCommand(command)) return { exitCode: 0, stdout: "", stderr: "" };
					if (tmuxSubcommand(command) === "capture-pane") return { exitCode: 0, stdout: "working\n", stderr: "" };
					return { exitCode: 1, stdout: "", stderr: "unexpected command" };
				},
			},
		});

		await server.callTool("gjc_coordinator_register_session", {
			session_id: "visible-session",
			cwd: root,
			tmux_session: "visible-session",
			tmux_target: "visible-session:0.0",
			visible: true,
			allow_mutation: true,
		});
		await persistPrivateOwnerProof(stateRoot, "visible-session");
		const sent = await server.callTool("gjc_coordinator_send_prompt", {
			session_id: "visible-session",
			prompt: "do acknowledged work before tmux disappears",
			allow_mutation: true,
		});
		const turnId = sent.turn_id as string;
		const sessionStatesDir = path.join(stateRoot, "local", "repo", "session-states");
		await fs.mkdir(sessionStatesDir, { recursive: true });
		await Bun.write(
			path.join(sessionStatesDir, "visible-session.json"),
			JSON.stringify({
				schema_version: 1,
				session_id: "visible-session",
				state: "running",
				ready_for_input: false,
				current_turn_id: turnId,
				last_turn_id: null,
				updated_at: "2026-06-28T00:00:01.000Z",
				source: "agent_session_event",
				live: true,
				reason: "turn_start",
			}),
		);

		let read = await server.callTool("gjc_coordinator_read_turn", {
			session_id: "visible-session",
			turn_id: turnId,
		});
		expect(read).toMatchObject({
			ok: true,
			turn: { delivery: { tmux_keys_sent: true, prompt_acknowledged: true, state: "acknowledged" } },
		});

		tmuxLive = false;
		read = await server.callTool("gjc_coordinator_read_turn", {
			session_id: "visible-session",
			turn_id: turnId,
		});

		expect(read).toMatchObject({
			ok: true,
			turn: {
				status: "failed",
				error: {
					code: "session_unavailable",
					message: "tmux_session_missing_after_prompt_acknowledgement",
				},
				liveness: { live: false, reason: "tmux_session_missing_after_prompt_acknowledgement" },
			},
			session_state: {
				state: "running",
				source: "agent_session_event",
				reason: "turn_start",
			},
		});
		expect((read.turn as { evidence: Array<Record<string, unknown>> }).evidence).toContainEqual(
			expect.objectContaining({
				type: "tmux_session_missing_after_prompt_acknowledgement",
				tmux_keys_sent: true,
				prompt_acknowledged: true,
			}),
		);
	});

	it("wakes watch on runtime ack and records vanished tmux after prompt acceptance", async () => {
		const root = await tempRoot();
		const stateRoot = path.join(root, ".gjc", "state", "watch-ack-vanish");
		let tmuxLive = true;
		const server = createCoordinatorMcpServer({
			env: {
				GJC_COORDINATOR_MCP_WORKDIR_ROOTS: root,
				GJC_COORDINATOR_MCP_STATE_ROOT: stateRoot,
				GJC_COORDINATOR_MCP_MUTATIONS: "sessions",
				GJC_COORDINATOR_MCP_PROFILE: "local",
				GJC_COORDINATOR_MCP_REPO: "repo",
			},
			services: {
				ownerIsolationProbe: privateOwnerProbe(),
				commandRunner: async command => {
					if (tmuxSubcommand(command) === "has-session")
						return { exitCode: tmuxLive ? 0 : 1, stdout: "", stderr: "" };
					if (tmuxSubcommand(command) === "display-message")
						return { exitCode: 0, stdout: tmuxIdentity(command), stderr: "" };
					if (isTmuxPromptDeliveryCommand(command)) return { exitCode: 0, stdout: "", stderr: "" };
					return { exitCode: 0, stdout: "", stderr: "" };
				},
			},
		});
		await server.callTool("gjc_coordinator_register_session", {
			session_id: "omx-issue-3059-state-root-resolution",
			cwd: root,
			tmux_session: "omx-issue-3059-state-root-resolution",
			tmux_target: "omx-issue-3059-state-root-resolution:0.0",
			visible: true,
			allow_mutation: true,
		});
		await persistPrivateOwnerProof(stateRoot, "omx-issue-3059-state-root-resolution");
		const sent = await server.callTool("gjc_coordinator_send_prompt", {
			session_id: "omx-issue-3059-state-root-resolution",
			prompt: "/skill:ralplan plan OmX #3059 fix",
			allow_mutation: true,
		});
		const turnId = sent.turn_id as string;
		const ackWatch = server.callTool("gjc_coordinator_watch_events", {
			after_seq: 0,
			event_types: ["turn.acknowledged"],
			timeout_ms: 1000,
		});
		const sessionStatePath = path.join(
			stateRoot,
			"local",
			"repo",
			"session-states",
			"omx-issue-3059-state-root-resolution.json",
		);
		await Bun.sleep(25);
		await Bun.write(
			sessionStatePath,
			JSON.stringify({
				schema_version: 1,
				session_id: "omx-issue-3059-state-root-resolution",
				state: "running",
				ready_for_input: false,
				current_turn_id: turnId,
				last_turn_id: null,
				updated_at: "2026-07-05T18:58:00.000Z",
				source: "agent_session_event",
				live: true,
				reason: "turn_start",
			}),
		);
		const acknowledged = await ackWatch;
		expect(acknowledged).toMatchObject({ ok: true, timed_out: false });
		expect(acknowledged.events as Array<{ kind: string; turn_id?: string }>).toContainEqual(
			expect.objectContaining({ kind: "turn.acknowledged", turn_id: turnId }),
		);

		tmuxLive = false;
		const failed = await server.callTool("gjc_coordinator_watch_events", {
			after_seq: (acknowledged.latest_seq as number) ?? 0,
			event_types: ["turn.failed"],
			timeout_ms: 5,
		});

		expect(failed).toMatchObject({ ok: true, timed_out: false });
		expect(failed.events as Array<{ kind: string; turn_id?: string }>).toContainEqual(
			expect.objectContaining({ kind: "turn.failed", turn_id: turnId }),
		);
		const read = await server.callTool("gjc_coordinator_read_turn", {
			session_id: "omx-issue-3059-state-root-resolution",
			turn_id: turnId,
		});
		expect(read).toMatchObject({
			turn: {
				status: "failed",
				error: { message: "tmux_session_missing_after_prompt_acknowledgement" },
			},
		});
	});

	it("preserves session-missing failure precedence over runtime ack timeout", async () => {
		const root = await tempRoot();
		const stateRoot = path.join(root, ".gjc", "state", "missing-session-precedence");
		const server = createCoordinatorMcpServer({
			env: {
				GJC_COORDINATOR_MCP_WORKDIR_ROOTS: root,
				GJC_COORDINATOR_MCP_STATE_ROOT: stateRoot,
				GJC_COORDINATOR_MCP_MUTATIONS: "sessions",
				GJC_COORDINATOR_MCP_PROFILE: "local",
				GJC_COORDINATOR_MCP_REPO: "repo",
				GJC_COORDINATOR_MCP_PROMPT_ACK_TIMEOUT_MS: "1",
			},
			services: {
				ownerIsolationProbe: privateOwnerProbe(),
				commandRunner: async command => {
					if (tmuxSubcommand(command) === "has-session") return { exitCode: 0, stdout: "", stderr: "" };
					if (tmuxSubcommand(command) === "display-message")
						return { exitCode: 0, stdout: tmuxIdentity(command), stderr: "" };
					if (isTmuxPromptDeliveryCommand(command)) return { exitCode: 0, stdout: "", stderr: "" };
					if (tmuxSubcommand(command) === "capture-pane") return { exitCode: 0, stdout: "idle\n", stderr: "" };
					return { exitCode: 1, stdout: "", stderr: "unexpected command" };
				},
			},
		});

		await server.callTool("gjc_coordinator_register_session", {
			session_id: "visible-session",
			cwd: root,
			tmux_session: "visible-session",
			tmux_target: "visible-session:0.0",
			visible: true,
			allow_mutation: true,
		});
		await persistPrivateOwnerProof(stateRoot, "visible-session");
		const sent = await server.callTool("gjc_coordinator_send_prompt", {
			session_id: "visible-session",
			prompt: "do work before session disappears",
			allow_mutation: true,
		});
		await fs.rm(path.join(stateRoot, "local", "repo", "sessions", "visible-session.json"), { force: true });

		await Bun.sleep(5);
		const status = await server.callTool("gjc_coordinator_read_coordination_status");
		expect(status.turns).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					status: "failed",
					error: expect.objectContaining({ code: "session_unavailable", message: "session_record_missing" }),
				}),
			]),
		);

		const read = await server.callTool("gjc_coordinator_read_turn", {
			session_id: "visible-session",
			turn_id: sent.turn_id,
		});

		expect(read).toMatchObject({
			ok: true,
			turn: {
				status: "failed",
				delivery: { tmux_keys_sent: true, state: "tmux_keys_sent" },
				error: { code: "session_unavailable", message: "session_record_missing" },
			},
			session_state: { state: "stale", reason: "session_record_missing" },
		});
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
	it("uses portable process incarnation evidence and rejects replacement or unavailable proof", async () => {
		const platform = Object.getOwnPropertyDescriptor(process, "platform");
		try {
			Object.defineProperty(process, "platform", { configurable: true, value: "darwin" });
			const startTimes = ["Sat Jul 11 10:00:00 2026", "Sat Jul 11 10:01:00 2026"];
			let psCalls = 0;
			const commands: string[][] = [];
			const probe = await coordinatorOwnerIsolationProbe(async command => {
				commands.push(command);
				if (command.includes("list-sessions"))
					return { exitCode: 0, stdout: "4242 gjc-coordinator-test\n", stderr: "" };
				if (command[0] === "ps") return { exitCode: 0, stdout: `${startTimes[psCalls++]}\n`, stderr: "" };
				return { exitCode: 1, stdout: "", stderr: "unexpected command" };
			});
			const first = await probe.probeServer("portable");
			const replacement = await probe.probeServer("portable");
			expect(first).toMatchObject({ state: "safe", pid: 4242, startTime: startTimes[0] });
			expect(replacement).toMatchObject({ state: "safe", pid: 4242, startTime: startTimes[1] });
			expect(replacement.startTime).not.toBe(first.startTime);
			expect(commands.map(command => command.join(" "))).toContain("ps -o lstart= -p 4242");

			const unavailable = await coordinatorOwnerIsolationProbe(async command =>
				command[0] === "ps"
					? { exitCode: 1, stdout: "", stderr: "process unavailable" }
					: { exitCode: 0, stdout: "4242 gjc-coordinator-test\n", stderr: "" },
			);
			expect(await unavailable.probeServer("portable")).toMatchObject({ state: "unverifiable", pid: 4242 });
		} finally {
			if (platform) Object.defineProperty(process, "platform", platform);
		}
	});
	it("surfaces a transient probe spawn failure as unverifiable instead of propagating the throw", async () => {
		const platform = Object.getOwnPropertyDescriptor(process, "platform");
		try {
			Object.defineProperty(process, "platform", { configurable: true, value: "darwin" });

			// A transient spawn failure (e.g. EAGAIN under load) on the tmux list-sessions probe must
			// not propagate: it becomes an unverifiable state so the caller's retry loop can re-probe.
			const listSessionsThrows = await coordinatorOwnerIsolationProbe(async () => {
				throw Object.assign(new Error("spawn tmux EAGAIN"), { code: "EAGAIN" });
			});
			expect(await listSessionsThrows.probeServer("portable")).toEqual({ state: "unverifiable" });

			// The same must hold when list-sessions succeeds but the portable ps incarnation probe throws.
			const psThrows = await coordinatorOwnerIsolationProbe(async command => {
				if (command[0] === "ps") throw Object.assign(new Error("spawn ps EAGAIN"), { code: "EAGAIN" });
				return { exitCode: 0, stdout: "4242 gjc-coordinator-test\n", stderr: "" };
			});
			expect(await psThrows.probeServer("portable")).toEqual({ state: "unverifiable" });
		} finally {
			if (platform) Object.defineProperty(process, "platform", platform);
		}
	});
	it("classifies a tmux >=3.7 'error connecting to' no-server diagnostic as absent, not unverifiable", async () => {
		// tmux 3.7 reports a missing server socket as `error connecting to <path> (No such file or
		// directory)` instead of the older `no server running on <path>`. The coordinator probe must
		// read that as an absent server (a fresh coordinator socket has none yet); otherwise every
		// session create fails closed with coordinator_tmux_owner_server_unverifiable on tmux >=3.7.
		const noServer = await coordinatorOwnerIsolationProbe(async () => ({
			exitCode: 1,
			stdout: "",
			stderr: "error connecting to /private/tmp/tmux-501/gjc-coordinator-abcd1234 (No such file or directory)",
		}));
		expect(await noServer.probeServer("gjc-coordinator-abcd1234")).toEqual({ state: "absent" });
	});
	it("refuses atomic cleanup after a post-spawn coordinator server replacement", async () => {
		const root = await tempRoot();
		const commands: string[][] = [];
		let proofs = 0;
		const server = createCoordinatorMcpServer({
			env: {
				GJC_COORDINATOR_MCP_WORKDIR_ROOTS: root,
				GJC_COORDINATOR_MCP_STATE_ROOT: path.join(root, ".gjc", "state", "cleanup-proof"),
				GJC_COORDINATOR_MCP_SESSION_COMMAND: "gjc --worktree",
				GJC_COORDINATOR_MCP_MUTATIONS: "sessions",
				GJC_COORDINATOR_MCP_PROFILE: "local",
				GJC_COORDINATOR_MCP_REPO: "repo",
			},
			services: {
				ownerIsolationProbe: {
					readCallerCgroup: async () => "0::/gjc-coordinator-test.scope\n",
					probeServer: async () => {
						proofs++;
						const pid = proofs === 3 ? 5002 : 5001;
						return {
							state: "safe" as const,
							pid,
							startTime: String(pid),
							cgroup: { classification: "safe" as const },
							sessionNames: ["gjc-coordinator-replacement"],
						};
					},
				},
				commandRunner: async command => {
					commands.push(command);
					if (tmuxSubcommand(command) === "new-session") {
						const sessionName = command[command.indexOf("-s") + 1]!;
						return { exitCode: 0, stdout: `${sessionName}:0.0 %1 $42\n`, stderr: "" };
					}
					if (tmuxSubcommand(command) === "if-shell")
						return { exitCode: 0, stdout: "__gjc_coordinator_cleanup_refused__\n", stderr: "" };
					return { exitCode: 1, stdout: "", stderr: "unexpected command" };
				},
			},
		});
		const response = await server.callTool("gjc_coordinator_start_session", { cwd: root, allow_mutation: true });
		expect(response).toMatchObject({
			ok: false,
			reason: "coordinator_tmux_owner_server_race",
			cleanup_status: "unverifiable",
		});
		const cleanup = commands.filter(command => tmuxSubcommand(command) === "if-shell");
		const launched = commands.find(command => tmuxSubcommand(command) === "new-session")!;
		const sessionName = launched[launched.indexOf("-s") + 1]!;
		expect(cleanup).toEqual([
			expect.arrayContaining([
				"-t",
				"$42",
				"-F",
				`#{&&:#{==:#{pid},5001},#{&&:#{==:#{session_id},$42},#{==:#{session_name},${sessionName}}}}`,
			]),
		]);
		expect(commands.some(command => tmuxSubcommand(command) === "kill-session")).toBe(false);
	});
	it("compensates durable records and appends failure history when owner publication CAS fails", async () => {
		const root = await tempRoot();
		const stateRoot = path.join(root, ".gjc", "state", "owner-cas-rollback");
		const commands: string[][] = [];
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
				ownerIsolationProbe: {
					readCallerCgroup: async () => "/user.slice/user-1.scope",
					probeServer: async () => ({
						state: "safe" as const,
						pid: PRIVATE_OWNER_PID,
						startTime: PRIVATE_OWNER_START_TIME,
						cgroup: { classification: "safe" as const },
					}),
				},
				commandRunner: async command => {
					commands.push(command);
					if (tmuxSubcommand(command) === "new-session") {
						const sessionId = command[command.indexOf("-s") + 1]!;
						return { exitCode: 0, stdout: `${sessionId}:0.0 %1 $1\n`, stderr: "" };
					}
					if (tmuxSubcommand(command) === "display-message") {
						const sessionId = command[command.indexOf("-t") + 1]!;
						await Bun.write(
							path.join(stateRoot, "local", "repo", sessionId, "owner-lifecycle", "generation.json"),
							JSON.stringify({
								schema_version: 1,
								generation: "replacement",
								session_id: sessionId,
								published_at: "2026-07-11T00:00:00.000Z",
							}),
						);
						return { exitCode: 0, stdout: `${sessionId}:0.0 %1 $1\n`, stderr: "" };
					}
					if (tmuxSubcommand(command) === "if-shell")
						return { exitCode: 0, stdout: "__gjc_coordinator_cleanup_ok__\n", stderr: "" };
					return { exitCode: 1, stdout: "", stderr: "unexpected command" };
				},
			},
		});

		const response = await server.callTool("gjc_coordinator_start_session", { cwd: root, allow_mutation: true });
		expect(response).toMatchObject({ ok: false, reason: "coordinator_tmux_start_failed", cleanup_status: "cleaned" });
		const launched = commands.find(command => tmuxSubcommand(command) === "new-session")!;
		const sessionId = launched[launched.indexOf("-s") + 1]!;
		expect(await Bun.file(path.join(stateRoot, "local", "repo", "sessions", `${sessionId}.json`)).exists()).toBe(
			false,
		);
		expect(
			JSON.parse(
				await Bun.file(path.join(stateRoot, "local", "repo", "session-states", `${sessionId}.json`)).text(),
			),
		).toMatchObject({
			state: "errored",
			ready_for_input: false,
			reason: "coordinator_start_rolled_back",
		});
		const events = await server.callTool("gjc_coordinator_watch_events", { after_seq: 0 });
		expect(events.events).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ kind: "session.started", session_id: sessionId }),
				expect.objectContaining({
					kind: "session.state_changed",
					session_id: sessionId,
					metadata: expect.objectContaining({ state: "errored" }),
				}),
			]),
		);
		expect(commands.filter(command => tmuxSubcommand(command) === "if-shell")).toEqual([
			expect.arrayContaining(["-t", "$1", "-F"]),
		]);
		expect(commands.some(command => tmuxSubcommand(command) === "kill-session")).toBe(false);
	});
	it("reports cleanup status after direct launch exits nonzero after creating a session", async () => {
		const root = await tempRoot();
		const commands: string[][] = [];
		const server = createCoordinatorMcpServer({
			env: {
				GJC_COORDINATOR_MCP_WORKDIR_ROOTS: root,
				GJC_COORDINATOR_MCP_STATE_ROOT: path.join(root, ".gjc", "state", "direct-nonzero"),
				GJC_COORDINATOR_MCP_SESSION_COMMAND: "gjc --worktree",
				GJC_COORDINATOR_MCP_MUTATIONS: "sessions",
				GJC_COORDINATOR_MCP_PROFILE: "local",
				GJC_COORDINATOR_MCP_REPO: "repo",
			},
			services: {
				ownerIsolationProbe: {
					readCallerCgroup: async () => "/user.slice/user-1.scope",
					probeServer: async () => ({
						state: "safe" as const,
						pid: PRIVATE_OWNER_PID,
						startTime: PRIVATE_OWNER_START_TIME,
						cgroup: { classification: "safe" as const },
					}),
				},
				commandRunner: async command => {
					commands.push(command);
					if (tmuxSubcommand(command) === "if-shell")
						return { exitCode: 0, stdout: "__gjc_coordinator_cleanup_ok__\n", stderr: "" };
					if (tmuxSubcommand(command) !== "new-session") return { exitCode: 0, stdout: "", stderr: "" };
					const sessionName = command[command.indexOf("-s") + 1]!;
					return {
						exitCode: 1,
						stdout: `${sessionName}:0.0 %1 $1\n`,
						stderr: "failed after create",
					};
				},
			},
		});
		expect(await server.callTool("gjc_coordinator_start_session", { cwd: root, allow_mutation: true })).toMatchObject(
			{
				ok: false,
				reason: "coordinator_tmux_start_failed",
				cleanup_status: "cleaned",
			},
		);
		expect(commands.filter(command => tmuxSubcommand(command) === "if-shell")).toEqual([
			expect.arrayContaining(["-t", "$1", "-F"]),
		]);
		expect(commands.some(command => tmuxSubcommand(command) === "kill-session")).toBe(false);
	});
	it("does not clean a foreign native session reported by a direct launch failure", async () => {
		const root = await tempRoot();
		const commands: string[][] = [];
		const server = createCoordinatorMcpServer({
			env: {
				GJC_COORDINATOR_MCP_WORKDIR_ROOTS: root,
				GJC_COORDINATOR_MCP_STATE_ROOT: path.join(root, ".gjc", "state", "direct-foreign-nonzero"),
				GJC_COORDINATOR_MCP_SESSION_COMMAND: "gjc --worktree",
				GJC_COORDINATOR_MCP_MUTATIONS: "sessions",
				GJC_COORDINATOR_MCP_PROFILE: "local",
				GJC_COORDINATOR_MCP_REPO: "repo",
			},
			services: {
				ownerIsolationProbe: {
					readCallerCgroup: async () => "/user.slice/user-1.scope",
					probeServer: async () => ({
						state: "safe" as const,
						pid: PRIVATE_OWNER_PID,
						startTime: PRIVATE_OWNER_START_TIME,
						cgroup: { classification: "safe" as const },
					}),
				},
				commandRunner: async command => {
					commands.push(command);
					return tmuxSubcommand(command) === "new-session"
						? {
								exitCode: 1,
								stdout: "gjc-coordinator-foreign:0.0 %2 $123\n",
								stderr: "failed after create",
							}
						: { exitCode: 0, stdout: "", stderr: "" };
				},
			},
		});
		expect(await server.callTool("gjc_coordinator_start_session", { cwd: root, allow_mutation: true })).toMatchObject(
			{
				ok: false,
				reason: "coordinator_tmux_start_failed",
				cleanup_status: "unverifiable",
			},
		);
		expect(commands.some(command => tmuxSubcommand(command) === "kill-session")).toBe(false);
	});
	it("reports cleanup status after scoped launch exits nonzero after creating a session", async () => {
		const root = await tempRoot();
		const commands: string[][] = [];
		let probes = 0;

		const server = createCoordinatorMcpServer({
			env: {
				GJC_COORDINATOR_MCP_WORKDIR_ROOTS: root,
				GJC_COORDINATOR_MCP_STATE_ROOT: path.join(root, ".gjc", "state", "scoped-nonzero"),
				GJC_COORDINATOR_MCP_SESSION_COMMAND: "gjc --worktree",
				GJC_COORDINATOR_MCP_MUTATIONS: "sessions",
				GJC_COORDINATOR_MCP_PROFILE: "local",
				GJC_COORDINATOR_MCP_REPO: "repo",
			},
			services: {
				ownerIsolationProbe: {
					readCallerCgroup: async () => "/user.slice/user-1.service",
					probeServer: async () =>
						++probes === 1
							? { state: "absent" as const }
							: {
									state: "safe" as const,
									pid: 99,
									startTime: "99",
									cgroup: { classification: "safe" as const },
								},
				},
				commandRunner: async (command, stdinLine) => {
					commands.push(command);
					if (tmuxSubcommand(command) === "if-shell")
						return { exitCode: 0, stdout: "__gjc_coordinator_cleanup_ok__\n", stderr: "" };
					if (command[0] === "tmux") return { exitCode: 0, stdout: "", stderr: "" };
					const request = JSON.parse(stdinLine ?? "") as { session_id: string };
					return {
						exitCode: 1,
						stdout: JSON.stringify({
							schema_version: 1,
							ok: true,
							code: "bootstrapped",
							native_session_id: "$99",
							server_pid: 99,
							server_start_time: "99",
							session_name: request.session_id,
						}),
						stderr: "failed after create",
					};
				},
			},
		});
		expect(await server.callTool("gjc_coordinator_start_session", { cwd: root, allow_mutation: true })).toMatchObject(
			{
				ok: false,
				reason: "coordinator_tmux_start_failed",
				cleanup_status: "cleaned",
			},
		);
		expect(commands).toHaveLength(2);
		expect(commands.at(-1)).toEqual(expect.arrayContaining(["if-shell", "-t", "$99", "-F"]));
	});
	it("fails closed on unknown target-server diagnostics without launching tmux", async () => {
		const root = await tempRoot();
		const commands: string[][] = [];
		const server = createCoordinatorMcpServer({
			env: {
				GJC_COORDINATOR_MCP_WORKDIR_ROOTS: root,
				GJC_COORDINATOR_MCP_STATE_ROOT: path.join(root, ".gjc", "state", "unknown-owner"),
				GJC_COORDINATOR_MCP_SESSION_COMMAND: "gjc --worktree",
				GJC_COORDINATOR_MCP_MUTATIONS: "sessions",
				GJC_COORDINATOR_MCP_PROFILE: "local",
				GJC_COORDINATOR_MCP_REPO: "repo",
			},
			services: {
				ownerIsolationProbe: privateOwnerProbe(),
				commandRunner: async command => {
					commands.push(command);
					return { exitCode: 1, stdout: "", stderr: "transport fault" };
				},
			},
		});

		const response = await server.callTool("gjc_coordinator_start_session", { cwd: root, allow_mutation: true });
		expect(response).toMatchObject({ ok: false, reason: "coordinator_tmux_start_failed" });
		expect(commands.some(command => tmuxSubcommand(command) === "new-session")).toBe(false);
	});
	it("rejects coordinator tmux startup when the target server is unsafe", async () => {
		const root = await tempRoot();
		const commands: string[][] = [];
		const server = createCoordinatorMcpServer({
			env: {
				GJC_COORDINATOR_MCP_WORKDIR_ROOTS: root,
				GJC_COORDINATOR_MCP_STATE_ROOT: path.join(root, ".gjc", "state", "unsafe-owner"),
				GJC_COORDINATOR_MCP_SESSION_COMMAND: "gjc --worktree",
				GJC_COORDINATOR_MCP_MUTATIONS: "sessions",
				GJC_COORDINATOR_MCP_PROFILE: "local",
				GJC_COORDINATOR_MCP_REPO: "repo",
			},
			services: {
				commandRunner: async command => {
					commands.push(command);
					return { exitCode: 0, stdout: "", stderr: "" };
				},
				ownerIsolationProbe: {
					readCallerCgroup: async () => "/user.slice/user-1.scope",
					probeServer: async () => ({ state: "unsafe" }),
				},
			},
		});

		const response = await server.callTool("gjc_coordinator_start_session", {
			cwd: root,
			prompt: "hello",
			allow_mutation: true,
		});

		expect(response.ok).toBe(false);
		expect(JSON.stringify(response)).toContain("coordinator_tmux_owner_server_unsafe");
		expect(commands.some(command => tmuxSubcommand(command) === "new-session")).toBe(false);
	});

	it("refuses atomic cleanup for a scoped same-name native-session replacement", async () => {
		const root = await tempRoot();
		const commands: Array<{ command: string[]; stdinLine?: string }> = [];
		let probeCalls = 0;
		let bootstrappedSessionName = "";
		const server = createCoordinatorMcpServer({
			env: {
				GJC_COORDINATOR_MCP_WORKDIR_ROOTS: root,
				GJC_COORDINATOR_MCP_STATE_ROOT: path.join(root, ".gjc", "state", "scoped-replacement"),
				GJC_COORDINATOR_MCP_SESSION_COMMAND: "gjc --worktree",
				GJC_COORDINATOR_MCP_MUTATIONS: "sessions",
				GJC_COORDINATOR_MCP_PROFILE: "local",
				GJC_COORDINATOR_MCP_REPO: "repo",
			},
			services: {
				commandRunner: async (command, stdinLine) => {
					commands.push({ command, stdinLine });
					if (command[0] === "tmux")
						return { exitCode: 0, stdout: "__gjc_coordinator_cleanup_refused__\n", stderr: "" };
					if (command[0] !== "systemd-run") return { exitCode: 1, stdout: "", stderr: "unexpected command" };
					const request = JSON.parse(stdinLine ?? "") as { session_id: string };
					bootstrappedSessionName = request.session_id;
					return {
						exitCode: 0,
						stdout: `${JSON.stringify({
							schema_version: 1,
							ok: true,
							code: "bootstrapped",
							native_session_id: "$99",
							server_pid: 99,
							server_start_time: "receipt-server",
							session_name: request.session_id,
						})}\n`,
						stderr: "",
					};
				},
				ownerIsolationProbe: {
					readCallerCgroup: async () => "0::/user.slice/user-1.service",
					probeServer: async () =>
						++probeCalls === 1
							? { state: "absent" as const }
							: {
									state: "safe" as const,
									pid: 100,
									startTime: "replacement-server",
									cgroup: { classification: "safe" as const },
									sessionNames: [bootstrappedSessionName],
								},
				},
			},
		});

		const response = await server.callTool("gjc_coordinator_start_session", { cwd: root, allow_mutation: true });

		expect(response).toMatchObject({
			ok: false,
			reason: "coordinator_tmux_owner_server_race",
			cleanup_status: "unverifiable",
		});
		expect(probeCalls).toBe(2);
		expect(bootstrappedSessionName).toMatch(/^gjc-coordinator-/);
		expect(commands).toHaveLength(2);
		expect(commands.at(-1)?.command).toEqual(
			expect.arrayContaining([
				"if-shell",
				"-t",
				"$99",
				"-F",
				`#{&&:#{==:#{pid},99},#{&&:#{==:#{session_id},$99},#{==:#{session_name},${bootstrappedSessionName}}}}`,
			]),
		);
		expect(commands.some(({ command }) => tmuxSubcommand(command) === "kill-session")).toBe(false);
	});

	it("boots an absent unsafe-service owner in a scoped server and routes follow-up through its socket", async () => {
		const root = await tempRoot();
		const stateRoot = path.join(root, ".gjc", "state", "scoped-owner");
		const commands: Array<{ command: string[]; stdinLine?: string }> = [];
		let probeCalls = 0;
		const probedSocketKeys: string[] = [];
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
				commandRunner: async (command, stdinLine) => {
					commands.push({ command, stdinLine });
					if (command[0] === "systemd-run") {
						const request = JSON.parse(stdinLine ?? "") as { session_id: string };
						return {
							exitCode: 0,
							stdout: `${JSON.stringify({
								schema_version: 1,
								ok: true,
								code: "bootstrapped",
								native_session_id: "$99",
								server_pid: 99,
								server_start_time: "42",
								session_name: request.session_id,
							})}\n`,
							stderr: "",
						};
					}
					if (tmuxSubcommand(command) === "display-message") {
						if (command.at(-1)?.includes("session_name")) {
							const target = command.at(command.indexOf("-t") + 1);
							return { exitCode: 0, stdout: `${target}:0.0 %99 $99\n`, stderr: "" };
						}
						return { exitCode: 0, stdout: "$99 %99\n", stderr: "" };
					}
					if (command.includes("has-session") || isTmuxPromptDeliveryCommand(command))
						return { exitCode: 0, stdout: "", stderr: "" };
					if (command.includes("set-option")) return { exitCode: 0, stdout: "", stderr: "" };
					return { exitCode: 1, stdout: "", stderr: "unexpected command" };
				},
				ownerIsolationProbe: {
					readCallerCgroup: async () => "0::/user.slice/user-1.service",
					probeServer: async socketKey => {
						probedSocketKeys.push(socketKey);
						return ++probeCalls === 1
							? { state: "absent" }
							: { state: "safe", pid: 99, startTime: "42", cgroup: { classification: "safe" } };
					},
				},
			},
		});

		const started = await server.callTool("gjc_coordinator_start_session", { cwd: root, allow_mutation: true });
		expect(started).toMatchObject({ ok: true });
		expect(probeCalls).toBe(3);
		const session = started.session as { session_id: string; tmux_session?: string; tmux_target?: string };
		expect(typeof session.session_id).toBe("string");
		expect(JSON.stringify(started)).not.toMatch(
			/tmux_(socket_key|owner_(generation|state_dir|server_(key|pid|start_time)))/,
		);
		const privateSession = await privateSessionProof(stateRoot, session.session_id);
		const socketKey = privateSession.tmux_socket_key as string;
		const ownerGeneration = privateSession.tmux_owner_generation as string;
		expect(socketKey).toMatch(/^gjc-coordinator-/);
		const bootstrap = commands.find(({ command }) => command[0] === "systemd-run");
		expect(bootstrap?.command).toEqual([
			"systemd-run",
			"--user",
			"--scope",
			"--quiet",
			"--unit",
			expect.stringMatching(/^gjc-owner-[0-9a-f-]+\.scope$/),
			expect.any(String),
			expect.any(String),
			"--internal-tmux-owner-isolation",
		]);
		expect(bootstrap?.stdinLine).toBeDefined();
		expect(bootstrap?.stdinLine).not.toContain("\n");
		const bootstrapRequest = JSON.parse(bootstrap?.stdinLine ?? "") as Record<string, unknown>;
		expect(bootstrap?.stdinLine).toBe(JSON.stringify(bootstrapRequest));
		expect(bootstrapRequest).toMatchObject({
			schema_version: 1,
			op: "bootstrap",
			session_id: session.session_id,
			owner_generation: ownerGeneration,
			socket_key: socketKey,
		});
		expect(bootstrapRequest.expected_scope).toBe(bootstrap?.command[5]);
		expect(probedSocketKeys).toEqual([socketKey, socketKey, socketKey]);
		expect(privateSession.tmux_owner_server_key).toBe(socketKey);
		const generation = JSON.parse(
			await fs.readFile(
				path.join(stateRoot, "local", "repo", session.session_id, "owner-lifecycle", "generation.json"),
				"utf8",
			),
		) as { generation: string; session_id: string };
		expect(generation).toMatchObject({ generation: ownerGeneration, session_id: session.session_id });

		const sent = await server.callTool("gjc_coordinator_send_prompt", {
			session_id: session.session_id,
			prompt: "follow up",
			allow_mutation: true,
		});
		expect(sent).toMatchObject({ ok: true, delivered: false, tmux_keys_sent: true });
		for (const { command } of commands.filter(({ command }) => command[0] === "tmux")) {
			expect(command).toEqual(["tmux", "-L", socketKey, ...command.slice(3)]);
		}
	});
	it("allocates distinct private socket, generation, and routing for two coordinator owners", async () => {
		const root = await tempRoot();
		const stateRoot = path.join(root, ".gjc", "state", "owner-uniqueness");
		const commands: string[][] = [];
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
				ownerIsolationProbe: {
					readCallerCgroup: async () => "/gjc-owner-test.scope\n",
					probeServer: async () => ({
						state: "safe",
						pid: process.pid,
						startTime: "owner-uniqueness",
						cgroup: { classification: "safe", scope: "/gjc-owner-test.scope" },
					}),
				},
				commandRunner: async command => {
					commands.push(command);
					if (tmuxSubcommand(command) === "new-session") {
						const name = command[command.indexOf("-s") + 1]!;
						return { exitCode: 0, stdout: `${name}:0.0 %1 $1\n`, stderr: "" };
					}
					if (tmuxSubcommand(command) === "display-message") {
						const name = command[command.indexOf("-t") + 1]!;
						return { exitCode: 0, stdout: `${name}:0.0 %1 $1\n`, stderr: "" };
					}
					return { exitCode: 0, stdout: "", stderr: "" };
				},
			},
		});
		const first = await server.callTool("gjc_coordinator_start_session", { cwd: root, allow_mutation: true });
		const second = await server.callTool("gjc_coordinator_start_session", { cwd: root, allow_mutation: true });
		expect(first.ok).toBe(true);
		expect(second.ok).toBe(true);
		const firstSession = first.session as { session_id: string };
		const secondSession = second.session as { session_id: string };
		expect(JSON.stringify([first, second])).not.toMatch(/tmux_(socket_key|owner_)/);
		const firstPrivateSession = await privateSessionProof(stateRoot, firstSession.session_id);
		const secondPrivateSession = await privateSessionProof(stateRoot, secondSession.session_id);
		const firstSocketKey = firstPrivateSession.tmux_socket_key as string;
		const secondSocketKey = secondPrivateSession.tmux_socket_key as string;
		expect(firstSocketKey).not.toBe(secondSocketKey);
		expect(firstPrivateSession.tmux_owner_generation).not.toBe(secondPrivateSession.tmux_owner_generation);
		const routedSockets = commands
			.filter(command => command[0] === "tmux" && command[1] === "-L")
			.map(command => command[2]);
		expect(routedSockets).toContain(firstSocketKey);
		expect(routedSockets).toContain(secondSocketKey);
		expect(commands.some(command => command[0] === "tmux" && command[1] !== "-L")).toBe(false);
	});

	it.each([
		["noise before receipt", 'noise\n{"schema_version":1,"ok":true,"code":"bootstrapped"}\n'],
		["extra receipt key", '{"schema_version":1,"ok":true,"code":"bootstrapped","detail":"unexpected"}\n'],
		["missing receipt key", '{"schema_version":1,"ok":true}\n'],
		["malformed bootstrap receipt", '{"schema_version":1,"ok":true,"code":\n'],
		["wrong receipt schema", '{"schema_version":2,"ok":true,"code":"bootstrapped"}\n'],
	])("rejects a scoped owner launch with %s", async (_description, stdout) => {
		const root = await tempRoot();
		const commands: Array<{ command: string[]; stdinLine?: string }> = [];
		let probeCalls = 0;
		const server = createCoordinatorMcpServer({
			env: {
				GJC_COORDINATOR_MCP_WORKDIR_ROOTS: root,
				GJC_COORDINATOR_MCP_STATE_ROOT: path.join(root, ".gjc", "state", "scoped-receipt-failure"),
				GJC_COORDINATOR_MCP_SESSION_COMMAND: "gjc --worktree",
				GJC_COORDINATOR_MCP_MUTATIONS: "sessions",
				GJC_COORDINATOR_MCP_PROFILE: "local",
				GJC_COORDINATOR_MCP_REPO: "repo",
			},
			services: {
				commandRunner: async (command, stdinLine) => {
					commands.push({ command, stdinLine });
					return command[0] === "systemd-run"
						? { exitCode: 0, stdout, stderr: "" }
						: { exitCode: 1, stdout: "", stderr: "unexpected follow-up" };
				},
				ownerIsolationProbe: {
					readCallerCgroup: async () => "0::/user.slice/user-1.service",
					probeServer: async () =>
						++probeCalls === 1
							? { state: "absent" }
							: {
									state: "safe",
									pid: PRIVATE_OWNER_PID,
									startTime: PRIVATE_OWNER_START_TIME,
									cgroup: { classification: "safe" },
								},
				},
			},
		});

		const response = await server.callTool("gjc_coordinator_start_session", { cwd: root, allow_mutation: true });
		expect(response).toMatchObject({ ok: false, reason: "coordinator_tmux_start_failed" });
		const bootstrap = commands.find(({ command }) => command[0] === "systemd-run");
		expect(bootstrap?.stdinLine).toBeDefined();
		expect(JSON.parse(bootstrap?.stdinLine ?? "")).toMatchObject({ op: "bootstrap", schema_version: 1 });
		expect(commands).toHaveLength(1);
	});

	it("delivers start-session prompts exactly once after the active turn is durable", async () => {
		const root = await tempRoot();
		const stateRoot = path.join(root, ".gjc", "state", "hermes-start-session-prompt");
		const commands: string[][] = [];
		let activeTurnExistedAtSend = false;
		const probeCalls = 0;

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
				ownerIsolationProbe: {
					readCallerCgroup: async () => "/user.slice/user-1.scope",
					probeServer: async () => ({
						state: "safe",
						pid: 1,
						startTime: "1",
						cgroup: { classification: "safe" },
					}),
				},

				commandRunner: async command => {
					commands.push(command);
					if (tmuxSubcommand(command) === "new-session") {
						const sessionId = command.at(command.indexOf("-s") + 1);
						return { exitCode: 0, stdout: `${sessionId}:0.0 %99 $99\n`, stderr: "" };
					}
					if (tmuxSubcommand(command) === "display-message") {
						const sessionId = command.at(command.indexOf("-t") + 1);
						return command.at(-1)?.includes("session_name")
							? { exitCode: 0, stdout: `${sessionId}:0.0 %99 $99\n`, stderr: "" }
							: { exitCode: 0, stdout: "$99 %99\n", stderr: "" };
					}
					if (command.includes("has-session")) return { exitCode: 0, stdout: "", stderr: "" };

					if (isTmuxPromptDeliveryCommand(command)) {
						if (tmuxSubcommand(command) === "paste-buffer") {
							const activeTurnsDir = path.join(stateRoot, "local", "repo", "active-turns");
							const activeTurns = await fs.readdir(activeTurnsDir).catch(() => []);
							activeTurnExistedAtSend = activeTurns.length === 1;
						}
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
		expect(probeCalls).toBe(0);
		expect(JSON.stringify(response)).not.toMatch(
			/tmux_(socket_key|owner_(generation|state_dir|server_(key|pid|start_time)))/,
		);
		const session = response.session as { session_id: string; tmuxTarget: string };
		const privateSession = await privateSessionProof(stateRoot, session.session_id);
		const ownerStateDir = path.join(stateRoot, "local", "repo");
		const socketKey = privateSession.tmux_socket_key as string;
		const ownerGeneration = privateSession.tmux_owner_generation as string;
		const ownerServerKey = privateSession.tmux_owner_server_key as string;
		expect(privateSession.tmux_owner_state_dir).toBe(ownerStateDir);
		expect(ownerServerKey).toBe(socketKey);
		const generation = JSON.parse(
			await fs.readFile(path.join(ownerStateDir, session.session_id, "owner-lifecycle", "generation.json"), "utf8"),
		) as { schema_version: number; generation: string; session_id: string; published_at: string };
		expect(generation).toEqual({
			schema_version: 1,
			generation: ownerGeneration,
			session_id: session.session_id,
			published_at: expect.any(String),
		});
		const launch = commands.find(command => tmuxSubcommand(command) === "new-session");
		expect(launch).toEqual([
			"tmux",
			"-L",
			ownerServerKey,
			"new-session",
			"-d",
			"-P",
			"-F",
			"#{session_name}:#{window_index}.#{pane_index} #{pane_id} #{session_id}",
			"-s",
			session.session_id,
			"-c",
			root,
			expect.stringContaining(`GJC_TMUX_OWNER_GENERATION='${ownerGeneration}'`),
		]);
		const childCommand = launch?.at(-1);
		expect(childCommand).toContain(`GJC_TMUX_OWNER_STATE_DIR='${ownerStateDir}'`);
		expect(childCommand).toContain(`GJC_TMUX_OWNER_SERVER_KEY='${ownerServerKey}'`);

		expect(activeTurnExistedAtSend).toBe(true);
		expectPrivateTmuxMutations(commands, socketKey);
		expect(commands.filter(isTmuxPromptDeliveryCommand).map(tmuxSubcommand)).toEqual(TMUX_PROMPT_DELIVERY_COMMANDS);
		expect(commands.filter(command => tmuxSubcommand(command) === "send-keys")).toEqual([
			["tmux", "-L", socketKey, "send-keys", "-t", "%99", "Escape"],
			["tmux", "-L", socketKey, "send-keys", "-t", "%99", "Enter"],
		]);
	});

	it.skipIf(!Bun.which("tmux"))(
		"acks a prompt delivered through a real tmux pane with Enter",
		async () => {
			const root = await tempRoot();
			const stateRoot = path.join(root, ".gjc", "state", "real-tmux-enter-ack");
			const runtimeScript = path.join(root, "fake-runtime.mjs");
			const runtimeLog = path.join(root, "fake-runtime.log");
			const runtimeOutput = path.join(root, "fake-runtime-output.log");
			await Bun.write(
				runtimeScript,
				`
import * as fs from "node:fs/promises";
import * as path from "node:path";

const logFile = ${JSON.stringify(runtimeLog)};
const log = async message => await fs.appendFile(logFile, message + "\\n").catch(() => {});
process.on("uncaughtException", error => {
  fs.appendFile(logFile, "uncaught:" + (error && error.stack ? error.stack : String(error)) + "\\n").finally(() => process.exit(99));
});
await log("started");

const stateFile = process.env.GJC_COORDINATOR_SESSION_STATE_FILE;
const sessionId = process.env.GJC_COORDINATOR_SESSION_ID;
if (!stateFile || !sessionId) process.exit(2);
await fs.mkdir(path.dirname(stateFile), { recursive: true });
async function writeState(payload) {
  const lockFile = stateFile + ".lock";
  let lock;
  for (let attempt = 0; attempt < 200; attempt++) {
    try {
      lock = await fs.open(lockFile, "wx", 0o600);
      break;
    } catch (error) {
      if (!error || error.code !== "EEXIST") throw error;
      await new Promise(resolve => setTimeout(resolve, 5));
    }
  }
  if (!lock) throw new Error("state lock unavailable");
  const temporary = stateFile + ".runtime-" + process.pid + "-" + Date.now() + ".tmp";
  try {
    await fs.writeFile(temporary, JSON.stringify(payload));
    await fs.rename(temporary, stateFile);
  } finally {
    await fs.rm(temporary, { force: true }).catch(() => {});
    await lock.close();
    await fs.rm(lockFile, { force: true });
  }
}
await writeState({
  schema_version: 1,
  session_id: sessionId,
  state: "ready_for_input",
  ready_for_input: true,
  current_turn_id: null,
  last_turn_id: null,
  updated_at: new Date().toISOString(),
  source: "agent_session_event",
  live: false,
  reason: null
});
await log("ready");

process.stdin.setEncoding("utf8");
process.stdin.resume();
const input = await new Promise(resolve => {
  let buffered = "";
  process.stdin.on("data", chunk => {
    buffered += String(chunk);
    if (buffered.includes("\\n") || buffered.includes("\\r")) resolve(buffered);
  });
});
await log("input:" + JSON.stringify(input));
const activeTurnPath = path.join(path.dirname(path.dirname(stateFile)), "active-turns", sessionId + ".json");
let activeTurn = null;
for (let attempt = 0; attempt < 100; attempt++) {
  try {
    activeTurn = JSON.parse(await fs.readFile(activeTurnPath, "utf8"));
    break;
  } catch {
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}
if (!activeTurn) process.exit(3);
await log("activeTurn:" + Boolean(activeTurn));
await writeState({
  schema_version: 1,
  session_id: sessionId,
  state: "running",
  ready_for_input: false,
  current_turn_id: activeTurn.turn_id,
  last_turn_id: null,
  updated_at: new Date().toISOString(),
  source: "agent_session_event",
  live: true,
  reason: input.trim().length > 0 ? "turn_start" : "empty_line"
});
await log("ack");
setInterval(() => {}, 1000);
`,
			);
			let ownerProbeCalls = 0;
			const server = createCoordinatorMcpServer({
				env: {
					GJC_COORDINATOR_MCP_WORKDIR_ROOTS: root,
					GJC_COORDINATOR_MCP_STATE_ROOT: stateRoot,
					GJC_COORDINATOR_MCP_SESSION_COMMAND: `${shellQuote(process.execPath)} ${shellQuote(runtimeScript)} > ${shellQuote(runtimeOutput)} 2>&1`,
					GJC_COORDINATOR_MCP_MUTATIONS: "sessions",
					GJC_COORDINATOR_MCP_PROFILE: "local",
					GJC_COORDINATOR_MCP_REPO: "repo",
					GJC_COORDINATOR_MCP_PROMPT_ACK_TIMEOUT_MS: "2000",
				},
				services: {
					ownerIsolationProbe: {
						readCallerCgroup: async () => "/user.slice/user-1.scope",
						probeServer: async () =>
							++ownerProbeCalls === 1
								? { state: "absent" }
								: {
										state: "safe",
										pid: process.pid,
										startTime: "test",
										cgroup: { classification: "safe", scope: "/gjc-owner-test.scope" },
									},
					},
				},
			});
			let tmuxSession: string | null = null;
			let tmuxSocketKey: string | null = null;

			try {
				const started = await server.callTool("gjc_coordinator_start_session", {
					cwd: root,
					prompt: "real tmux enter ack smoke",
					allow_mutation: true,
				});
				if (started.ok !== true) throw new Error(`real_tmux_start_failed:${JSON.stringify(started)}`);
				expect(started.ok).toBe(true);
				tmuxSession = (started.session as { tmux_session?: string }).tmux_session ?? null;
				const sessionId = started.session_id ?? (started.session as { session_id: string }).session_id;
				const privateSession = await privateSessionProof(stateRoot, sessionId as string);
				tmuxSocketKey = (privateSession.tmux_socket_key as string | undefined) ?? null;
				expect(JSON.stringify(started)).not.toMatch(/tmux_(socket_key|owner_)/);
				expect(tmuxSocketKey).toMatch(/^gjc-coordinator-/);

				const turnId = started.turn_id as string;
				let read = await server.callTool("gjc_coordinator_read_turn", {
					session_id: started.session_id ?? (started.session as { session_id: string }).session_id,
					turn_id: turnId,
				});
				if (read.ok !== true) throw new Error(`real_tmux_read_failed:${JSON.stringify(read)}`);
				for (
					let attempt = 0;
					attempt < 50 &&
					(read.turn as { delivery: { prompt_acknowledged: boolean } }).delivery.prompt_acknowledged !== true;
					attempt++
				) {
					await Bun.sleep(20);
					read = await server.callTool("gjc_coordinator_read_turn", {
						session_id: (started.session as { session_id: string }).session_id,
						turn_id: turnId,
					});
					if (read.ok !== true) throw new Error(`real_tmux_read_failed:${JSON.stringify(read)}`);
				}

				if ((read.turn as { delivery: { prompt_acknowledged: boolean } }).delivery.prompt_acknowledged !== true) {
					throw new Error(
						(await Bun.file(runtimeLog)
							.text()
							.catch(() => "missing fake runtime log")) +
							"\noutput:\n" +
							(await Bun.file(runtimeOutput)
								.text()
								.catch(() => "missing fake runtime output")),
					);
				}
				expect(read).toMatchObject({
					ok: true,
					turn: {
						status: "active",
						delivery: { tmux_keys_sent: true, prompt_acknowledged: true, state: "acknowledged" },
						error: null,
					},
					session_state: { state: "running", current_turn_id: turnId, reason: "turn_start" },
				});
			} finally {
				if (tmuxSession && tmuxSocketKey)
					Bun.spawnSync(["tmux", "-L", tmuxSocketKey, "kill-session", "-t", tmuxSession]);
			}
		},
		10_000,
	);

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
		expect(advisoryStatus.live).toBeNull();

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

	it("preserves launch errors from runtime state before tmux liveness masking", async () => {
		const root = await tempRoot();
		const stateRoot = path.join(root, ".gjc", "state", "hermes-launch-error");
		const server = createCoordinatorMcpServer({
			env: {
				GJC_COORDINATOR_MCP_WORKDIR_ROOTS: root,
				GJC_COORDINATOR_MCP_STATE_ROOT: stateRoot,
				GJC_COORDINATOR_MCP_MUTATIONS: "sessions",
				GJC_COORDINATOR_MCP_PROFILE: "local",
				GJC_COORDINATOR_MCP_REPO: "repo",
			},
			services: {
				ownerIsolationProbe: privateOwnerProbe(),
				startSession: async input => ({
					sessionId: "gjc-demo",
					tmuxSession: "gjc-demo",
					tmuxTarget: "gjc-demo:0.0",
					tmuxSocketKey: PRIVATE_SOCKET,
					tmuxOwnerServerKey: PRIVATE_SOCKET,
					tmuxOwnerGeneration: "gjc-demo-generation",
					tmuxOwnerServerPid: PRIVATE_OWNER_PID,
					tmuxOwnerServerStartTime: PRIVATE_OWNER_START_TIME,
					tmuxNativeSessionId: "$session",
					paneId: "%24",
					cwd: input.cwd,
					createdAt: "2026-06-07T00:00:00.000Z",
				}),
				commandRunner: async command => {
					if (tmuxSubcommand(command) === "has-session") return { exitCode: 0, stdout: "", stderr: "" };
					if (tmuxSubcommand(command) === "display-message")
						return { exitCode: 0, stdout: tmuxIdentity(command), stderr: "" };
					if (isTmuxPromptDeliveryCommand(command)) return { exitCode: 0, stdout: "", stderr: "" };
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
		const sessionStatesDir = path.join(stateRoot, "local", "repo", "session-states");
		await fs.mkdir(sessionStatesDir, { recursive: true });
		await Bun.write(
			path.join(sessionStatesDir, "gjc-demo.json"),
			JSON.stringify({
				schema_version: 1,
				session_id: "gjc-demo",
				state: "errored",
				ready_for_input: false,
				current_turn_id: null,
				last_turn_id: null,
				updated_at: "2026-06-07T00:00:01.000Z",
				source: "agent_session_event",
				owner_generation: "gjc-demo-generation",
				live: false,
				reason: "worktree_target_mismatch",
				final_response: {
					text: "worktree_target_mismatch:/tmp/repo.gajae-code-worktrees/main",
					format: "markdown",
					source: "launch_error",
					artifact_path: null,
					truncated: false,
				},
				error: {
					code: "worktree_target_mismatch",
					message: "worktree_target_mismatch:/tmp/repo.gajae-code-worktrees/main",
					recoverable: true,
				},
			}),
		);

		const read = await server.callTool("gjc_coordinator_read_turn", {
			session_id: "gjc-demo",
			turn_id: turnId,
		});

		expect((read.turn as { status: string }).status).toBe("failed");
		expect((read.turn as { error: { code: string } }).error.code).toBe("worktree_target_mismatch");
		expect((read.turn as { final_response: { text: string } }).final_response.text).toContain(
			"worktree_target_mismatch",
		);
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
				live: false,
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
	it("accepts process-postmortem owner terminal evidence only from the registered private owner", async () => {
		const ownerTerminal = (generation: string, socketKey: string): Record<string, unknown> => ({
			generation,
			socket_key: socketKey,
			signal: "SIGTERM",
			result: "owner_term_then_session_cleanup",
			classification: "expected_operator_shutdown",
			observer: "sidecar",
			observed_at: "2026-06-07T00:00:01.000Z",
			intent_id: "intent",
			dedupe_key: `owner-loss:gjc-demo:${generation}`,
		});
		const cases: Array<[string, Record<string, unknown> | undefined, string | null]> = [
			["missing", undefined, null],
			["stale-generation", ownerTerminal("stale-generation", PRIVATE_SOCKET), "active"],
			["cross-owner-socket", ownerTerminal("current-generation", "other-private-socket"), "active"],
			["valid", ownerTerminal("current-generation", PRIVATE_SOCKET), "completed"],
			["malformed", { ...ownerTerminal("current-generation", PRIVATE_SOCKET), socket_key: 42 }, null],
			[
				"incoherent-expected-result",
				{ ...ownerTerminal("current-generation", PRIVATE_SOCKET), result: "cleanup" },
				null,
			],
		];
		for (const [caseName, ownerTerminal, expectedStatus] of cases) {
			const root = await tempRoot();
			const stateRoot = path.join(root, ".gjc", "state", `runtime-owner-terminal-${caseName}`);
			const server = createCoordinatorMcpServer({
				env: {
					GJC_COORDINATOR_MCP_WORKDIR_ROOTS: root,
					GJC_COORDINATOR_MCP_STATE_ROOT: stateRoot,
					GJC_COORDINATOR_MCP_MUTATIONS: "sessions",
					GJC_COORDINATOR_MCP_PROFILE: "local",
					GJC_COORDINATOR_MCP_REPO: "repo",
				},
				services: {
					ownerIsolationProbe: privateOwnerProbe(),
					startSession: async input => ({
						sessionId: "gjc-demo",
						tmuxSession: "gjc-demo",
						tmuxTarget: "gjc-demo:0.0",
						tmuxSocketKey: PRIVATE_SOCKET,
						tmuxOwnerServerKey: PRIVATE_SOCKET,
						tmuxOwnerGeneration: "current-generation",
						tmuxOwnerServerPid: PRIVATE_OWNER_PID,
						tmuxOwnerServerStartTime: PRIVATE_OWNER_START_TIME,
						tmuxNativeSessionId: "$42",
						paneId: "%24",
						cwd: input.cwd,
						createdAt: "2026-06-07T00:00:00.000Z",
					}),
					commandRunner: async command => {
						if (tmuxSubcommand(command) === "has-session" || isTmuxPromptDeliveryCommand(command))
							return { exitCode: 0, stdout: "", stderr: "" };
						if (tmuxSubcommand(command) === "display-message")
							return { exitCode: 0, stdout: tmuxIdentity(command), stderr: "" };
						return { exitCode: 1, stdout: "", stderr: "unexpected command" };
					},
				},
			});
			await server.callTool("gjc_coordinator_start_session", { cwd: root, allow_mutation: true });
			const sent = await server.callTool("gjc_coordinator_send_prompt", {
				session_id: "gjc-demo",
				prompt: "work",
				allow_mutation: true,
			});
			await Bun.write(
				path.join(stateRoot, "local", "repo", "session-states", "gjc-demo.json"),
				JSON.stringify({
					schema_version: 1,
					session_id: "gjc-demo",
					state: "completed",
					ready_for_input: true,
					current_turn_id: sent.turn_id,
					last_turn_id: sent.turn_id,
					updated_at: "2026-06-07T00:00:01.000Z",
					source: "process_postmortem",
					live: false,
					reason:
						typeof ownerTerminal?.classification === "string" ? ownerTerminal.classification : "owner_terminal",
					owner_generation: "current-generation",
					event: "owner_terminal",
					...(ownerTerminal === undefined ? {} : { owner_terminal: ownerTerminal }),
				}),
			);
			const read = await server.callTool("gjc_coordinator_read_turn", {
				session_id: "gjc-demo",
				turn_id: sent.turn_id,
			});
			if (expectedStatus)
				expect([caseName, (read.turn as { status: string }).status]).toEqual([caseName, expectedStatus]);
			else expect(read).toMatchObject({ ok: false, reason: "coordinator_state_invalid" });
		}
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
				ownerIsolationProbe: privateOwnerProbe(),
				startSession: async input => ({
					sessionId: "gjc-demo",
					tmuxSession: "gjc-demo",
					tmuxTarget: "gjc-demo:0.0",
					tmuxSocketKey: PRIVATE_SOCKET,
					tmuxOwnerServerKey: PRIVATE_SOCKET,
					tmuxOwnerGeneration: "gjc-demo-generation",
					tmuxOwnerStateDir: path.join(stateRoot, "local", "repo"),
					tmuxOwnerServerPid: PRIVATE_OWNER_PID,
					tmuxOwnerServerStartTime: PRIVATE_OWNER_START_TIME,
					tmuxNativeSessionId: "$gjc-demo",
					paneId: "%24",
					cwd: input.cwd,
					createdAt: "2026-06-07T00:00:00.000Z",
				}),
				commandRunner: async command => {
					if (tmuxSubcommand(command) === "has-session") return { exitCode: 0, stdout: "", stderr: "" };
					if (tmuxSubcommand(command) === "display-message")
						return { exitCode: 0, stdout: tmuxIdentity(command), stderr: "" };
					if (tmuxSubcommand(command) === "set-buffer" || tmuxSubcommand(command) === "paste-buffer")
						return { exitCode: 0, stdout: "", stderr: "" };
					if (tmuxSubcommand(command) === "send-keys") {
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
								owner_generation: "gjc-demo-generation",
								live: false,
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
				live: false,
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
	it("fails closed for missing, corrupt, and unreadable durable session state without leaking owner controls", async () => {
		const root = await tempRoot();
		const stateRoot = path.join(root, ".gjc", "state", "state-read-failures");
		const namespace = path.join(stateRoot, "local", "repo");
		const sessionId = "durable-session";
		await fs.mkdir(path.join(namespace, "sessions"), { recursive: true });
		await Bun.write(
			path.join(namespace, "sessions", `${sessionId}.json`),
			JSON.stringify({ session_id: sessionId, cwd: root, tmux_socket_key: PRIVATE_SOCKET, pane_id: "%99" }),
		);
		const server = createCoordinatorMcpServer({
			env: {
				GJC_COORDINATOR_MCP_WORKDIR_ROOTS: root,
				GJC_COORDINATOR_MCP_STATE_ROOT: stateRoot,
				GJC_COORDINATOR_MCP_MUTATIONS: "sessions",
				GJC_COORDINATOR_MCP_PROFILE: "local",
				GJC_COORDINATOR_MCP_REPO: "repo",
			},
		});

		const missing = await server.callTool("gjc_coordinator_send_prompt", {
			session_id: sessionId,
			prompt: "missing state is allowed",
			queue: true,
			allow_mutation: true,
		});
		expect(missing.ok).toBe(true);

		const sessionStatePath = path.join(namespace, "session-states", `${sessionId}.json`);
		await fs.mkdir(path.dirname(sessionStatePath), { recursive: true });
		await Bun.write(sessionStatePath, '{"state":');
		const before = await fs.readFile(sessionStatePath, "utf8");
		const corrupt = await server.callTool("gjc_coordinator_send_prompt", {
			session_id: sessionId,
			prompt: "must not overwrite corruption",
			allow_mutation: true,
		});
		expect(corrupt).toMatchObject({ ok: false, reason: "coordinator_state_invalid" });
		expect(await fs.readFile(sessionStatePath, "utf8")).toBe(before);
		expect(JSON.stringify(corrupt)).not.toContain(PRIVATE_SOCKET);
		expect(JSON.stringify(corrupt)).not.toContain("%99");

		await fs.rm(sessionStatePath);
		await fs.mkdir(sessionStatePath);
		const unreadable = await server.callTool("gjc_coordinator_send_prompt", {
			session_id: sessionId,
			prompt: "directory is not absent state",
			allow_mutation: true,
		});
		expect(unreadable).toMatchObject({ ok: false, reason: "coordinator_state_unreadable" });
		expect(JSON.stringify(unreadable)).not.toContain(PRIVATE_SOCKET);
	});

	it("rejects malformed journal records without reusing event sequence", async () => {
		const root = await tempRoot();
		const stateRoot = path.join(root, ".gjc", "state", "journal-read-failures");
		const namespace = path.join(stateRoot, "local", "repo");
		const server = createCoordinatorMcpServer({
			env: {
				GJC_COORDINATOR_MCP_WORKDIR_ROOTS: root,
				GJC_COORDINATOR_MCP_STATE_ROOT: stateRoot,
				GJC_COORDINATOR_MCP_MUTATIONS: "sessions",
				GJC_COORDINATOR_MCP_PROFILE: "local",
				GJC_COORDINATOR_MCP_REPO: "repo",
			},
		});

		await fs.mkdir(path.join(namespace, "events"), { recursive: true });
		const journalPath = path.join(namespace, "events", "event-journal.jsonl");
		await Bun.write(journalPath, "not-json\n");
		const malformedLine = await server.callTool("gjc_coordinator_watch_events", { after_seq: 0 });
		expect(malformedLine).toMatchObject({ ok: false, reason: "coordinator_state_invalid" });
		await Bun.write(journalPath, '{"schema_version":1,"seq":7}\n');
		const malformedRecord = await server.callTool("gjc_coordinator_watch_events", { after_seq: 0 });
		expect(malformedRecord).toMatchObject({ ok: false, reason: "coordinator_state_invalid" });
		expect(await fs.readFile(journalPath, "utf8")).toBe('{"schema_version":1,"seq":7}\n');
	});
	it("rejects physically out-of-order or semantically invalid journal evidence without mutation", async () => {
		const root = await tempRoot();
		const stateRoot = path.join(root, ".gjc", "state", "journal-order");
		const namespace = path.join(stateRoot, "local", "repo");
		const journalPath = path.join(namespace, "events", "event-journal.jsonl");
		await fs.mkdir(path.dirname(journalPath), { recursive: true });
		const event = (seq: number) => ({
			schema_version: 1,
			seq,
			id: `event-${seq.toString().padStart(12, "0")}`,
			timestamp: "2026-01-01T00:00:00.000Z",
			kind: "session.started",
			summary: "prior event",
		});
		const evidence = `${JSON.stringify(event(2))}\n${JSON.stringify(event(1))}\n`;
		await Bun.write(journalPath, evidence);
		const server = createCoordinatorMcpServer({
			env: {
				GJC_COORDINATOR_MCP_WORKDIR_ROOTS: root,
				GJC_COORDINATOR_MCP_STATE_ROOT: stateRoot,
				GJC_COORDINATOR_MCP_MUTATIONS: "sessions",
				GJC_COORDINATOR_MCP_PROFILE: "local",
				GJC_COORDINATOR_MCP_REPO: "repo",
			},
		});
		const result = await server.callTool("gjc_coordinator_watch_events", { after_seq: 0 });
		expect(result).toMatchObject({ ok: false, reason: "coordinator_state_invalid" });
		expect(await fs.readFile(journalPath, "utf8")).toBe(evidence);
	});

	it("continues event sequence from a valid journal when the sequence marker is absent", async () => {
		const root = await tempRoot();
		const stateRoot = path.join(root, ".gjc", "state", "journal-sequence-recovery");
		const namespace = path.join(stateRoot, "local", "repo");
		const sessionId = "sequence-session";
		await fs.mkdir(path.join(namespace, "sessions"), { recursive: true });
		await Bun.write(
			path.join(namespace, "sessions", `${sessionId}.json`),
			JSON.stringify({ session_id: sessionId, cwd: root }),
		);
		await fs.mkdir(path.join(namespace, "events"), { recursive: true });
		await Bun.write(
			path.join(namespace, "events", "event-journal.jsonl"),
			`${JSON.stringify({ schema_version: 1, seq: 7, id: "event-000000000007", timestamp: "2026-01-01T00:00:00.000Z", kind: "session.started", summary: "prior event" })}\n`,
		);
		const server = createCoordinatorMcpServer({
			env: {
				GJC_COORDINATOR_MCP_WORKDIR_ROOTS: root,
				GJC_COORDINATOR_MCP_STATE_ROOT: stateRoot,
				GJC_COORDINATOR_MCP_MUTATIONS: "sessions",
				GJC_COORDINATOR_MCP_PROFILE: "local",
				GJC_COORDINATOR_MCP_REPO: "repo",
			},
		});

		const sent = await server.callTool("gjc_coordinator_send_prompt", {
			session_id: sessionId,
			prompt: "preserve sequence",
			queue: true,
			allow_mutation: true,
		});
		expect(sent.ok).toBe(true);
		const events = await server.callTool("gjc_coordinator_watch_events", { after_seq: 0 });
		expect((events.events as Array<{ seq: number }>).map(event => event.seq)).toContain(8);
	});
	it("rejects an ahead sequence marker and recovers a lagging marker from authoritative journal evidence", async () => {
		const root = await tempRoot();
		const stateRoot = path.join(root, ".gjc", "state", "journal-marker-recovery");
		const namespace = path.join(stateRoot, "local", "repo");
		const sessionId = "marker-session";
		await fs.mkdir(path.join(namespace, "sessions"), { recursive: true });
		await Bun.write(
			path.join(namespace, "sessions", `${sessionId}.json`),
			JSON.stringify({ session_id: sessionId, cwd: root }),
		);
		await fs.mkdir(path.join(namespace, "events"), { recursive: true });
		const journal = `${JSON.stringify({ schema_version: 1, seq: 7, id: "event-000000000007", timestamp: "2026-01-01T00:00:00.000Z", kind: "session.started", summary: "prior event" })}\n`;
		await Bun.write(path.join(namespace, "events", "event-journal.jsonl"), journal);
		const server = createCoordinatorMcpServer({
			env: {
				GJC_COORDINATOR_MCP_WORKDIR_ROOTS: root,
				GJC_COORDINATOR_MCP_STATE_ROOT: stateRoot,
				GJC_COORDINATOR_MCP_MUTATIONS: "sessions",
				GJC_COORDINATOR_MCP_PROFILE: "local",
				GJC_COORDINATOR_MCP_REPO: "repo",
			},
		});
		await Bun.write(
			path.join(namespace, "events", "latest-seq.json"),
			JSON.stringify({ seq: 8, updated_at: "2026-01-01T00:00:01.000Z" }),
		);
		expect(
			await server.callTool("gjc_coordinator_send_prompt", {
				session_id: sessionId,
				prompt: "must not reuse or skip",
				queue: true,
				allow_mutation: true,
			}),
		).toMatchObject({ ok: false, reason: "coordinator_state_invalid" });
		await Bun.write(
			path.join(namespace, "events", "latest-seq.json"),
			JSON.stringify({ seq: 6, updated_at: "2026-01-01T00:00:01.000Z" }),
		);
		expect(
			await server.callTool("gjc_coordinator_send_prompt", {
				session_id: sessionId,
				prompt: "recover marker after durable append",
				queue: true,
				allow_mutation: true,
			}),
		).toMatchObject({ ok: true });
		expect(JSON.parse(await fs.readFile(path.join(namespace, "events", "latest-seq.json"), "utf8"))).toMatchObject({
			seq: 8,
		});
		const events = await server.callTool("gjc_coordinator_watch_events", { after_seq: 0 });
		expect((events.events as Array<{ seq: number }>).map(event => event.seq)).toEqual([7, 8]);
	});

	it("preflights invalid journal evidence before start, register, or delegate side effects", async () => {
		const root = await tempRoot();
		const stateRoot = path.join(root, ".gjc", "state", "mutation-preflight");
		const namespace = path.join(stateRoot, "local", "repo");
		const commands: string[][] = [];
		let starts = 0;
		await fs.mkdir(path.join(namespace, "events"), { recursive: true });
		await Bun.write(path.join(namespace, "events", "event-journal.jsonl"), "not-json\n");
		const server = createCoordinatorMcpServer({
			env: {
				GJC_COORDINATOR_MCP_WORKDIR_ROOTS: root,
				GJC_COORDINATOR_MCP_STATE_ROOT: stateRoot,
				GJC_COORDINATOR_MCP_MUTATIONS: "sessions",
				GJC_COORDINATOR_MCP_PROFILE: "local",
				GJC_COORDINATOR_MCP_REPO: "repo",
			},
			services: {
				startSession: async () => {
					starts++;
					return { sessionId: "unexpected", cwd: root };
				},
				commandRunner: async command => {
					commands.push(command);
					return { exitCode: 0, stdout: tmuxIdentity(command), stderr: "" };
				},
			},
		});
		for (const [name, args] of [
			["gjc_coordinator_start_session", { cwd: root, allow_mutation: true }],
			[
				"gjc_coordinator_register_session",
				{
					session_id: "visible",
					cwd: root,
					tmux_session: "visible",
					tmux_target: "visible:0.0",
					allow_mutation: true,
				},
			],
			["gjc_delegate_execute", { cwd: root, task: "do not start", allow_mutation: true }],
		] as const)
			expect(await server.callTool(name, args)).toMatchObject({ ok: false, reason: "coordinator_state_invalid" });
		expect(starts).toBe(0);
		expect(commands).toEqual([]);
		expect((await fs.readdir(namespace)).sort()).toEqual(["events", "locks"]);
	});
	it("OWNER-TERMINAL-ROUNDTRIP accepts an actual sidecar terminal marker with its canonical socket_key", async () => {
		const root = await tempRoot();
		const stateRoot = path.join(root, ".gjc", "state", "owner-roundtrip");
		const sessionId = "owner-roundtrip";
		const stateFile = path.join(stateRoot, "local", "repo", "session-states", `${sessionId}.json`);
		const generation = await replaceOwnerGeneration(root, sessionId, "owner-roundtrip-generation");
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
					sessionId,
					cwd: input.cwd,
					createdAt: "2026-07-10T00:00:00.000Z",
					tmuxOwnerGeneration: generation,
					tmuxOwnerServerKey: "managed-socket-key",
				}),
			},
		});
		await server.callTool("gjc_coordinator_start_session", { cwd: root, allow_mutation: true });
		const turn = await server.callTool("gjc_coordinator_send_prompt", {
			session_id: sessionId,
			prompt: "fixed synthetic task",
			allow_mutation: true,
		});
		await createOwnerIntent(root, {
			generation,
			session_id: sessionId,
			server_key: "managed-socket-key",
			expected_terminal: { signal: "SIGTERM", result: "owner_term_then_session_cleanup" },
			dispatch_id: "fixed-dispatch",
			created_at: "2026-07-10T00:00:00.000Z",
			expires_at: "2099-01-01T00:00:00.000Z",
		});
		process.env[GJC_COORDINATOR_SESSION_STATE_FILE_ENV] = stateFile;
		process.env[GJC_COORDINATOR_SESSION_ID_ENV] = sessionId;
		await persistCoordinatorRuntimeStateFromPostmortem(postmortem.Reason.SIGTERM, {
			sessionId,
			cwd: root,
			ownerTerminal: { generation, stateDir: root, socketKey: "managed-socket-key" },
		});
		const sidecarMarker = JSON.parse(await fs.readFile(stateFile, "utf8")) as Record<string, unknown>;
		expect(sidecarMarker.owner_terminal).toMatchObject({ socket_key: "managed-socket-key" });
		const reconciled = await server.callTool("gjc_coordinator_read_turn", {
			session_id: sessionId,
			turn_id: turn.turn_id,
		});
		expect((reconciled.turn as { status: string }).status).toBe("completed");
	});

	it("TERMINAL-PRESERVATION keeps the complete runtime marker byte-stable through reconciliation and finalization", async () => {
		const root = await tempRoot();
		const stateRoot = path.join(root, ".gjc", "state", "terminal-preservation");
		const sessionId = "terminal-preservation";
		const stateFile = path.join(stateRoot, "local", "repo", "session-states", `${sessionId}.json`);
		const server = createCoordinatorMcpServer({
			env: {
				GJC_COORDINATOR_MCP_WORKDIR_ROOTS: root,
				GJC_COORDINATOR_MCP_STATE_ROOT: stateRoot,
				GJC_COORDINATOR_MCP_MUTATIONS: "sessions",
				GJC_COORDINATOR_MCP_PROFILE: "local",
				GJC_COORDINATOR_MCP_REPO: "repo",
			},
			services: {
				startSession: async input => ({ sessionId, cwd: input.cwd, createdAt: "2026-07-10T00:00:00.000Z" }),
			},
		});
		await server.callTool("gjc_coordinator_start_session", { cwd: root, allow_mutation: true });
		const turn = await server.callTool("gjc_coordinator_send_prompt", {
			session_id: sessionId,
			prompt: "fixed synthetic task",
			allow_mutation: true,
		});
		process.env[GJC_COORDINATOR_SESSION_STATE_FILE_ENV] = stateFile;
		process.env[GJC_COORDINATOR_SESSION_ID_ENV] = sessionId;
		const generation = await replaceOwnerGeneration(root, sessionId, "terminal-preservation-generation");
		await createOwnerIntent(root, {
			generation,
			session_id: sessionId,
			server_key: "managed-socket-key",
			expected_terminal: { signal: "SIGTERM", result: "owner_term_then_session_cleanup" },
			dispatch_id: "terminal-preservation-dispatch",
			created_at: "2026-07-10T00:00:00.000Z",
			expires_at: "2099-01-01T00:00:00.000Z",
		});
		await Bun.write(
			stateFile,
			`${JSON.stringify({
				schema_version: 1,
				session_id: sessionId,
				state: "completed",
				cwd: root,
				workdir: root,
				session_file: null,
				ready_for_input: true,
				current_turn_id: turn.turn_id,
				last_turn_id: turn.turn_id,
				updated_at: "2026-07-10T00:00:01.000Z",
				source: "agent_session_event",
				live: false,
				reason: "agent_end",
				final_response: {
					text: "terminal result",
					format: "markdown",
					source: "agent_end",
					artifact_path: null,
					truncated: false,
				},
			})}\n`,
		);
		const terminalBytes = await fs.readFile(stateFile, "utf8");
		await server.callTool("gjc_coordinator_read_turn", { session_id: sessionId, turn_id: turn.turn_id });
		expect(await fs.readFile(stateFile, "utf8")).toBe(terminalBytes);
		await persistCoordinatorRuntimeStateFromPostmortem(postmortem.Reason.SIGTERM, {
			sessionId,
			cwd: root,
			ownerTerminal: { generation, stateDir: root, socketKey: "managed-socket-key" },
		});
		expect(await fs.readFile(stateFile, "utf8")).toBe(terminalBytes);
		const reconciled = await server.callTool("gjc_coordinator_read_turn", {
			session_id: sessionId,
			turn_id: turn.turn_id,
		});
		expect((reconciled.turn as { status: string }).status).toBe("completed");
	});

	it("SHARED-WRITER-RACE serializes sidecar finalization behind an active coordinator transaction", async () => {
		for (const releaseSidecarFirst of [false]) {
			const root = await tempRoot();
			const stateRoot = path.join(root, ".gjc", "state", `shared-writer-${releaseSidecarFirst}`);
			const sessionId = `shared-writer-${releaseSidecarFirst}`;
			const stateFile = path.join(stateRoot, "local", "repo", "session-states", `${sessionId}.json`);
			const entered = Promise.withResolvers<void>();
			const release = Promise.withResolvers<void>();
			let blockReconciliation = false;
			const server = createCoordinatorMcpServer({
				env: {
					GJC_COORDINATOR_MCP_WORKDIR_ROOTS: root,
					GJC_COORDINATOR_MCP_STATE_ROOT: stateRoot,
					GJC_COORDINATOR_MCP_MUTATIONS: "sessions",
					GJC_COORDINATOR_MCP_PROFILE: "local",
					GJC_COORDINATOR_MCP_REPO: "repo",
				},
				services: {
					ownerIsolationProbe: privateOwnerProbe(),
					startSession: async input => ({
						sessionId,
						tmuxSession: sessionId,
						tmuxTarget: `${sessionId}:0.0`,
						cwd: input.cwd,
						createdAt: "2026-07-10T00:00:00.000Z",
					}),
					commandRunner: async command => {
						if (tmuxSubcommand(command) === "has-session" && blockReconciliation) {
							entered.resolve();
							await release.promise;
							return { exitCode: 0, stdout: "", stderr: "" };
						}
						return { exitCode: 0, stdout: tmuxIdentity(command), stderr: "" };
					},
				},
			});
			await server.callTool("gjc_coordinator_start_session", { cwd: root, allow_mutation: true });
			await persistPrivateOwnerProof(stateRoot, sessionId);
			const turn = await server.callTool("gjc_coordinator_send_prompt", {
				session_id: sessionId,
				prompt: "fixed synthetic task",
				allow_mutation: true,
			});
			blockReconciliation = true;
			process.env[GJC_COORDINATOR_SESSION_STATE_FILE_ENV] = stateFile;
			process.env[GJC_COORDINATOR_SESSION_ID_ENV] = sessionId;
			const reconcile = server.callTool("gjc_coordinator_read_turn", {
				session_id: sessionId,
				turn_id: turn.turn_id,
			});
			await Promise.race([
				entered.promise,
				reconcile.then(result => {
					throw new Error(`shared_writer_reconciliation_finished:${JSON.stringify(result)}`);
				}),
				Bun.sleep(1_000).then(() => {
					throw new Error("shared_writer_reconciliation_not_entered");
				}),
			]);
			const finalize = persistCoordinatorRuntimeStateFromPostmortem(postmortem.Reason.SIGTERM, {
				sessionId,
				cwd: root,
			});
			if (releaseSidecarFirst) await finalize;
			release.resolve();
			await reconcile;
			if (!releaseSidecarFirst) await finalize;
			const finalState = JSON.parse(await fs.readFile(stateFile, "utf8")) as { state: string; reason?: string };
			expect(finalState.state).toBe("errored");
			expect(finalState.reason).not.toBe("process_exit_before_terminal_state");
		}
	});

	it("ENOTDIR-PREFLIGHT rejects durable-parent corruption before start, register, or delegate side effects", async () => {
		const root = await tempRoot();
		const stateRoot = path.join(root, ".gjc", "state", "enotdir-preflight");
		const namespace = path.join(stateRoot, "local", "repo");
		const eventsParent = path.join(namespace, "events");
		await fs.mkdir(namespace, { recursive: true });
		await Bun.write(eventsParent, "durable parent evidence\n");
		const evidence = await fs.readFile(eventsParent, "utf8");
		let starts = 0;
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
				startSession: async input => {
					starts++;
					return { sessionId: "unexpected", cwd: input.cwd };
				},
				commandRunner: async command => {
					commands.push(command);
					return { exitCode: 0, stdout: "", stderr: "" };
				},
			},
		});
		for (const [name, args] of [
			["gjc_coordinator_start_session", { cwd: root, allow_mutation: true }],
			[
				"gjc_coordinator_register_session",
				{
					session_id: "visible",
					cwd: root,
					tmux_session: "visible",
					tmux_target: "visible:0.0",
					allow_mutation: true,
				},
			],
			["gjc_delegate_execute", { cwd: root, task: "fixed synthetic task", allow_mutation: true }],
		] as const)
			expect(await server.callTool(name, args)).toMatchObject({ ok: false, reason: "coordinator_state_unreadable" });
		expect(starts).toBe(0);
		expect(commands).toEqual([]);
		expect(await fs.readFile(eventsParent, "utf8")).toBe(evidence);
	});

	it("recovers orphaned state locks and waits for a live lock beyond the legacy retry window", async () => {
		const root = await tempRoot();
		const stateRoot = path.join(root, ".gjc", "state", "state-lock-recovery");
		const sessionId = "state-lock-recovery";
		const stateFile = path.join(stateRoot, "local", "repo", "session-states", `${sessionId}.json`);
		await fs.mkdir(path.dirname(stateFile), { recursive: true });
		await Bun.write(`${stateFile}.lock`, JSON.stringify({ pid: 999_999_999, start_time: "0", token: "orphan" }));
		const server = createCoordinatorMcpServer({
			env: {
				GJC_COORDINATOR_MCP_WORKDIR_ROOTS: root,
				GJC_COORDINATOR_MCP_STATE_ROOT: stateRoot,
				GJC_COORDINATOR_MCP_MUTATIONS: "sessions",
				GJC_COORDINATOR_MCP_PROFILE: "local",
				GJC_COORDINATOR_MCP_REPO: "repo",
			},
			services: {
				startSession: async input => ({ sessionId, cwd: input.cwd, createdAt: "2026-07-10T00:00:00.000Z" }),
			},
		});
		expect(await server.callTool("gjc_coordinator_start_session", { cwd: root, allow_mutation: true })).toMatchObject(
			{ ok: true },
		);
		const stat = await fs.readFile(`/proc/${process.pid}/stat`, "utf8");
		const startTime = stat
			.slice(stat.lastIndexOf(")") + 1)
			.trim()
			.split(/\s+/)[19];
		await Bun.write(`${stateFile}.lock`, JSON.stringify({ pid: process.pid, start_time: startTime, token: "live" }));
		const write = server.callTool("gjc_coordinator_start_session", { cwd: root, allow_mutation: true });
		await Bun.sleep(1_100);
		await fs.rm(`${stateFile}.lock`);
		expect(await write).toMatchObject({ ok: true });
	});

	it("rejects near-valid turn file/body identity mismatches without mutations", async () => {
		const root = await tempRoot();
		const stateRoot = path.join(root, ".gjc", "state", "turn-identity-mismatch");
		const namespace = path.join(stateRoot, "local", "repo");
		const sessionId = "turn-identity-mismatch";
		const server = createCoordinatorMcpServer({
			env: {
				GJC_COORDINATOR_MCP_WORKDIR_ROOTS: root,
				GJC_COORDINATOR_MCP_STATE_ROOT: stateRoot,
				GJC_COORDINATOR_MCP_MUTATIONS: "sessions,questions,reports",
				GJC_COORDINATOR_MCP_PROFILE: "local",
				GJC_COORDINATOR_MCP_REPO: "repo",
			},
			services: {
				startSession: async input => ({ sessionId, cwd: input.cwd, createdAt: "2026-07-10T00:00:00.000Z" }),
			},
		});
		await server.callTool("gjc_coordinator_start_session", { cwd: root, allow_mutation: true });
		const turn = await server.callTool("gjc_coordinator_send_prompt", {
			session_id: sessionId,
			prompt: "fixed synthetic task",
			allow_mutation: true,
		});
		const turnPath = path.join(namespace, "turns", `${turn.turn_id}.json`);
		const mismatched = JSON.parse(await fs.readFile(turnPath, "utf8")) as Record<string, unknown>;
		mismatched.turn_id = "turn-00000000-0000-4000-8000-000000000001";
		const mismatchedBytes = `${JSON.stringify(mismatched)}\n`;
		await Bun.write(turnPath, mismatchedBytes);
		const activePath = path.join(namespace, "active-turns", `${sessionId}.json`);
		const activeBytes = await fs.readFile(activePath, "utf8");
		const journalPath = path.join(namespace, "events", "event-journal.jsonl");
		const journalBytes = await fs.readFile(journalPath, "utf8");
		const scanned = await server.callTool("gjc_coordinator_read_coordination_status");
		expect(scanned).toMatchObject({ ok: false, reason: "coordinator_state_invalid" });
		expect(await fs.readFile(turnPath, "utf8")).toBe(mismatchedBytes);
		for (const [name, args] of [
			[
				"gjc_coordinator_send_prompt",
				{ session_id: sessionId, prompt: "fixed force", force: true, allow_mutation: true },
			],
			[
				"gjc_coordinator_report_status",
				{
					session_id: sessionId,
					turn_id: turn.turn_id,
					status: "completed",
					summary: "fixed",
					allow_mutation: true,
				},
			],
		] as const)
			expect(await server.callTool(name, args)).toMatchObject({ ok: false, reason: "coordinator_state_invalid" });
		expect(await fs.readFile(turnPath, "utf8")).toBe(mismatchedBytes);
		expect(await fs.readFile(activePath, "utf8")).toBe(activeBytes);
		expect(await fs.readFile(journalPath, "utf8")).toBe(journalBytes);
	});
	it("rejects queued turn filename/body mismatches before promotion can redirect mutation", async () => {
		const root = await tempRoot();
		const stateRoot = path.join(root, ".gjc", "state", "queued-turn-identity-mismatch");
		const namespace = path.join(stateRoot, "local", "repo");
		const sessionId = "queued-turn-identity-mismatch";
		const server = createCoordinatorMcpServer({
			env: {
				GJC_COORDINATOR_MCP_WORKDIR_ROOTS: root,
				GJC_COORDINATOR_MCP_STATE_ROOT: stateRoot,
				GJC_COORDINATOR_MCP_MUTATIONS: "sessions,reports",
				GJC_COORDINATOR_MCP_PROFILE: "local",
				GJC_COORDINATOR_MCP_REPO: "repo",
			},
			services: {
				startSession: async input => ({ sessionId, cwd: input.cwd, createdAt: "2026-07-10T00:00:00.000Z" }),
			},
		});
		await server.callTool("gjc_coordinator_start_session", { cwd: root, allow_mutation: true });
		const active = await server.callTool("gjc_coordinator_send_prompt", {
			session_id: sessionId,
			prompt: "fixed active task",
			allow_mutation: true,
		});
		const queued = await server.callTool("gjc_coordinator_send_prompt", {
			session_id: sessionId,
			prompt: "fixed queued task",
			queue: true,
			allow_mutation: true,
		});
		const queuedPath = path.join(namespace, "turns", `${queued.turn_id}.json`);
		const queuedRecord = JSON.parse(await fs.readFile(queuedPath, "utf8")) as Record<string, unknown>;
		const redirectedTurnId = "turn-00000000-0000-4000-8000-000000000002";
		queuedRecord.turn_id = redirectedTurnId;
		const corruptBytes = `${JSON.stringify(queuedRecord)}\n`;
		await Bun.write(queuedPath, corruptBytes);
		const result = await server.callTool("gjc_coordinator_report_status", {
			session_id: sessionId,
			turn_id: active.turn_id,
			status: "completed",
			summary: "fixed",
			allow_mutation: true,
		});
		expect(result).toMatchObject({ ok: false, reason: "coordinator_state_invalid" });
		expect(await fs.readFile(queuedPath, "utf8")).toBe(corruptBytes);
		expect(await Bun.file(path.join(namespace, "turns", `${redirectedTurnId}.json`)).exists()).toBe(false);
	});

	it("CORRUPT-TURN-NO-MUTATION fails closed for force, queue, report, and question mutations", async () => {
		for (const corruptActiveTurn of [false, true]) {
			const root = await tempRoot();
			const stateRoot = path.join(root, ".gjc", "state", `corrupt-turn-${corruptActiveTurn}`);
			const namespace = path.join(stateRoot, "local", "repo");
			const sessionId = "corrupt-session";
			const server = createCoordinatorMcpServer({
				env: {
					GJC_COORDINATOR_MCP_WORKDIR_ROOTS: root,
					GJC_COORDINATOR_MCP_STATE_ROOT: stateRoot,
					GJC_COORDINATOR_MCP_MUTATIONS: "sessions,questions,reports",
					GJC_COORDINATOR_MCP_PROFILE: "local",
					GJC_COORDINATOR_MCP_REPO: "repo",
				},
				services: {
					startSession: async input => ({ sessionId, cwd: input.cwd, createdAt: "2026-07-10T00:00:00.000Z" }),
				},
			});
			await server.callTool("gjc_coordinator_start_session", { cwd: root, allow_mutation: true });
			const turn = await server.callTool("gjc_coordinator_send_prompt", {
				session_id: sessionId,
				prompt: "fixed synthetic task",
				allow_mutation: true,
			});
			const questionPath = path.join(namespace, "questions", "fixed-question.json");
			await fs.mkdir(path.dirname(questionPath), { recursive: true });
			await Bun.write(
				questionPath,
				JSON.stringify({ id: "fixed-question", session_id: sessionId, turn_id: turn.turn_id, status: "open" }),
			);
			const corruptPath = corruptActiveTurn
				? path.join(namespace, "active-turns", `${sessionId}.json`)
				: path.join(namespace, "turns", `${turn.turn_id}.json`);
			const corruptBytes = '{"schema_version":1}\n';
			await Bun.write(corruptPath, corruptBytes);
			const journalPath = path.join(namespace, "events", "event-journal.jsonl");
			const journalBefore = await fs.readFile(journalPath, "utf8");
			for (const [name, args] of [
				[
					"gjc_coordinator_send_prompt",
					{ session_id: sessionId, prompt: "fixed force", force: true, allow_mutation: true },
				],
				[
					"gjc_coordinator_send_prompt",
					{ session_id: sessionId, prompt: "fixed queue", queue: true, allow_mutation: true },
				],
				[
					"gjc_coordinator_report_status",
					{
						session_id: sessionId,
						turn_id: turn.turn_id,
						status: "completed",
						summary: "fixed",
						allow_mutation: true,
					},
				],
				[
					"gjc_coordinator_submit_question_answer",
					{
						session_id: sessionId,
						turn_id: turn.turn_id,
						question_id: "fixed-question",
						answer: "fixed",
						allow_mutation: true,
					},
				],
			] as const)
				expect(await server.callTool(name, args)).toMatchObject({ ok: false, reason: "coordinator_state_invalid" });
			expect(await fs.readFile(corruptPath, "utf8")).toBe(corruptBytes);
			expect(await fs.readFile(journalPath, "utf8")).toBe(journalBefore);
		}
	});
});
