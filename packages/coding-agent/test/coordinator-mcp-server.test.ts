import { afterEach, describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { createCoordinatorMcpServer } from "../src/coordinator-mcp/server";
import { schemaHash } from "../src/modes/shared/agent-wire/workflow-gate-schema";
import {
	buildAskGateAnswerSchema,
	GATE_OTHER_OPTION,
	type WorkflowGate,
} from "../src/modes/shared/agent-wire/workflow-gate-types";
import {
	type BrokerDiscovery,
	brokerDiscoveryPath,
	brokerProcessIncarnation,
	readBrokerDiscovery,
	writeBrokerDiscovery,
} from "../src/sdk/broker/discovery";
import {
	brokerOwnerForTest,
	type EnsureBrokerSettings,
	startFixtureBrokerWithLeaseForTest,
} from "../src/sdk/broker/ensure";
import { UnsupportedStateVersionError } from "../src/sdk/broker/state-version";

import { type SdkClient, SdkClientError } from "../src/sdk/client/client";
import {
	cleanupFixtureRoot,
	createFixtureBrokerEnvironment,
	createFixtureRootCleanup,
} from "./helpers/fixture-broker-cleanup";

const tempDirs: string[] = [];

async function tempRoot(): Promise<string> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-coordinator-server-"));
	const canonical = await fs.realpath(dir);
	tempDirs.push(canonical);
	return canonical;
}

/** Real detached-broker fixtures are cleaned solely by cleanupFixtureRoot. */
async function managedFixtureRoot(): Promise<string> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-coordinator-managed-broker-"));
	return fs.realpath(dir);
}

afterEach(async () => {
	await Promise.all(tempDirs.splice(0).map(dir => fs.rm(dir, { recursive: true, force: true })));
});

type SdkControl = { operation: string; input: Record<string, unknown>; idempotencyKey?: string };
function brokerEndpointIncarnation(
	sessionId: string,
	endpointGeneration: number,
	pid: number,
	endpointMtimeMs: number,
): string {
	return createHash("sha256")
		.update(JSON.stringify({ endpointGeneration, endpointMtimeMs, pid, sessionId }))
		.digest("hex");
}

type EndpointRequestHandler = (input: Record<string, unknown>, sessions: Array<Record<string, unknown>>) => unknown;
type SdkControlServerOptions = {
	platform?: NodeJS.Platform;
	canonicalizePath?: (value: string) => Promise<string>;
	controlResult?: (control: SdkControl) => unknown;
	promptAckTimeoutMs?: number;
	controlOptions?: Array<{ idempotencyKey?: string; timeoutMs?: number }>;
};
function lifecycleControls(controls: SdkControl[]): SdkControl[] {
	return controls.filter(
		control => control.operation !== "session.list" && control.operation !== "session.get_endpoint",
	);
}

function sharedAskGate(gateId: string, runtimeTurnId: string): WorkflowGate & { id: string; tag: "pending" } {
	const labels = ["Continue", "Stop"];
	const schema = buildAskGateAnswerSchema({ multi: false, allowEmpty: false }, labels);
	return {
		id: `pending:${gateId}`,
		tag: "pending",
		type: "workflow_gate",
		gate_id: gateId,
		runtime_turn_id: runtimeTurnId,
		stage: "deep-interview",
		kind: "question",
		schema,
		schema_hash: schemaHash(schema),
		required: true,
		created_at: "2026-07-17T00:00:00.000Z",
		context: {
			title: "Continue?",
			prompt: "Continue?",
			stage_state: {
				question_id: gateId,
				multi: false,
				allow_empty: false,
				options: labels,
				other_option: GATE_OTHER_OPTION,
				clarification_action: "clarify",
			},
		},
		options: labels.map(label => ({ value: label, label })),
	};
}

type BrokerTestServices = {
	ensureBroker: (settings: EnsureBrokerSettings) => Promise<BrokerDiscovery>;
	readSdkBrokerDiscovery: (agentDir: string) => Promise<BrokerDiscovery | null>;
	connectSdk: (url: string, token: string) => Promise<SdkClient>;
};

function testBrokerDiscovery(): BrokerDiscovery {
	return {
		version: 1,
		protocolVersion: 3,
		packageGeneration: "test",
		ownerId: "test-owner",
		pid: process.pid,
		incarnation: "test-incarnation",
		host: "127.0.0.1",
		port: 1,
		url: "ws://broker.example.test",
		token: "test-token",
		startedAt: Date.now(),
		heartbeatAt: Date.now(),
	};
}

function createBrokerTestServer(root: string, services: BrokerTestServices) {
	return createCoordinatorMcpServer({
		env: {
			GJC_COORDINATOR_MCP_WORKDIR_ROOTS: root,
			GJC_COORDINATOR_MCP_STATE_ROOT: path.join(root, ".gjc", "coordinator-state"),
			GJC_COORDINATOR_MCP_PROFILE: "local",
			GJC_COORDINATOR_MCP_REPO: "repo",
		},
		services: { ...services, getAgentDir: () => path.join(root, "agent-global") },
	});
}
function createRealBrokerServer(root: string, agentDir: string) {
	return createCoordinatorMcpServer({
		env: {
			GJC_COORDINATOR_MCP_WORKDIR_ROOTS: root,
			GJC_COORDINATOR_MCP_STATE_ROOT: path.join(root, ".gjc", "coordinator-state"),
			GJC_COORDINATOR_MCP_PROFILE: "local",
			GJC_COORDINATOR_MCP_REPO: "repo",
		},
		services: { getAgentDir: () => agentDir },
	});
}

function ownerLease(agentDir: string) {
	return {
		async close(): Promise<void> {
			await brokerOwnerForTest(agentDir)?.stop();
		},
	};
}

async function createSdkControlServer(
	root: string,
	controls: SdkControl[],
	queries: string[] = [],
	queryResult: (query: string, cursor?: string) => unknown = query =>
		query === "context.get"
			? {
					type: "query_response",
					id: "query-1",
					ok: true,
					page: { items: [{ isStreaming: true }], complete: true, revision: "test" },
				}
			: {
					type: "query_response",
					id: "query-1",
					ok: true,
					page: { items: ["first assistant line\nlatest assistant line"], complete: true, revision: "test" },
				},
	brokerSessions: Array<Record<string, unknown>> = [
		{
			sessionId: "visible-session",
			locator: { repo: root },
			live: true,
			endpointGeneration: 1,
			pid: 101,
			endpointMtimeMs: 1,
		},
	],
	sessionCommand?: string,
	endpointRequestHandler?: EndpointRequestHandler,
	serverOptions: SdkControlServerOptions = {},
): Promise<ReturnType<typeof createCoordinatorMcpServer>> {
	const stateRoot = path.join(root, ".gjc", "coordinator-state");
	const agentDir = path.join(root, "agent-global");
	let createdSessions = 0;
	const server = createCoordinatorMcpServer({
		env: {
			GJC_COORDINATOR_MCP_WORKDIR_ROOTS: root,
			GJC_COORDINATOR_MCP_STATE_ROOT: stateRoot,
			GJC_COORDINATOR_MCP_MUTATIONS: "sessions,questions,reports",
			GJC_COORDINATOR_MCP_PROFILE: "local",
			GJC_COORDINATOR_MCP_REPO: "repo",
			...(sessionCommand ? { GJC_COORDINATOR_MCP_SESSION_COMMAND: sessionCommand } : {}),
			...(serverOptions.promptAckTimeoutMs === undefined
				? {}
				: { GJC_COORDINATOR_MCP_PROMPT_ACK_TIMEOUT_MS: String(serverOptions.promptAckTimeoutMs) }),
		},
		platform: serverOptions.platform,
		services: {
			getAgentDir: () => agentDir,
			resolveModelProfiles: () => new Map([["codex-eco", { name: "codex-eco" }]]),
			canonicalizePath: serverOptions.canonicalizePath,
			connectSdk: async () =>
				({
					control: async (
						operation: string,
						input: Record<string, unknown>,
						options: { idempotencyKey?: string; timeoutMs?: number },
					) => {
						const control = { operation, input, idempotencyKey: options.idempotencyKey };
						controls.push(control);
						serverOptions.controlOptions?.push(options);
						return (
							serverOptions.controlResult?.(control) ?? {
								accepted: true,
								command_id: `sdk-command-${controls.length}`,
								turn_id: `sdk-turn-${controls.length}`,
							}
						);
					},
					global: async (
						operation: string,
						input: Record<string, unknown>,
						options: { idempotencyKey?: string } = {},
					) => {
						controls.push({ operation, input, idempotencyKey: options.idempotencyKey });
						if (operation === "session.list") return { ok: true, result: { sessions: brokerSessions } };
						if (operation === "session.get_endpoint") {
							if (endpointRequestHandler) return endpointRequestHandler(input, brokerSessions);
							return {
								ok: true,
								result: {
									url: "ws://broker.example.test/endpoint?token=broker-endpoint-secret",
									token: "Bearer broker-endpoint-secret",
								},
							};
						}
						if (operation === "session.close") {
							const sessionId = input.sessionId;
							const index = brokerSessions.findIndex(session => session.sessionId === sessionId);
							if (index >= 0) brokerSessions.splice(index, 1);
							return { ok: true, result: { sessionId } };
						}
						if (operation === "session.create") {
							const target = input.target as Record<string, unknown> | undefined;
							const worktree = target?.worktree as Record<string, unknown> | undefined;
							const lifecycleCwd = worktree?.enabled === true ? path.join(root, "hermes-worktree") : undefined;
							const sessionId = `created-session-${++createdSessions}`;
							const sessionCwd = lifecycleCwd ?? root;
							await fs.mkdir(path.join(sessionCwd, ".gjc", "state", "sdk"), { recursive: true });
							await Bun.write(
								path.join(sessionCwd, ".gjc", "state", "sdk", `${sessionId}.json`),
								JSON.stringify({ url: "ws://sdk.example.test", token: "test-token" }),
							);
							brokerSessions.push({
								sessionId,
								locator: { repo: sessionCwd },
								live: true,
								endpointGeneration: 1,
								pid: 10_000 + createdSessions,
								endpointMtimeMs: createdSessions,
							});
							return {
								ok: true,
								result: {
									sessionId,
									...(lifecycleCwd
										? {
												cwd: lifecycleCwd,
												worktree: {
													enabled: true,
													cwd: lifecycleCwd,
													created: true,
													reused: false,
												},
											}
										: {}),
									endpoint: {
										url: "ws://broker.example.test/new?token=created-endpoint-secret",
										token: "Bearer created-endpoint-secret",
										credentials: { nested: { token: "nested-created-endpoint-secret" } },
									},
								},
							};
						}
						return { ok: true, result: { sessionId: String(input.sessionId ?? "visible-session") } };
					},
					query: async (query: string, _input: Record<string, unknown>, cursor?: string) => {
						queries.push(query);
						return queryResult(query, cursor);
					},
					close: async () => {},
				}) as unknown as SdkClient,
		},
	});
	await fs.mkdir(path.join(root, ".gjc", "state", "sdk"), { recursive: true });
	await writeBrokerDiscovery(agentDir, {
		version: 1,
		protocolVersion: 3,
		packageGeneration: "test",
		ownerId: "test",
		pid: process.pid,
		host: "127.0.0.1",
		port: 1,
		url: "ws://sdk.example.test",
		token: "broker-discovery-secret",
		startedAt: Date.now(),
		heartbeatAt: Date.now(),
	});
	await Bun.write(
		path.join(root, ".gjc", "state", "sdk", "visible-session.json"),
		JSON.stringify({ url: "ws://sdk.example.test", token: "session-endpoint-secret" }),
	);
	return server;
}

async function registerSdkSession(server: ReturnType<typeof createCoordinatorMcpServer>, root: string) {
	return await server.callTool("gjc_coordinator_register_session", {
		session_id: "visible-session",
		cwd: root,
		tmux_session: "visible-session",
		tmux_target: "visible-session:0.0",
		idempotency_key: "register-1",
		allow_mutation: true,
	});
}

describe("Coordinator MCP canonical SDK controls", () => {
	it("uses agent-global SDK discovery and returns credential-free broker status", async () => {
		const root = await tempRoot();
		const controls: SdkControl[] = [];
		const server = await createSdkControlServer(root, controls);
		const registered = await registerSdkSession(server, root);
		expect(registered).toMatchObject({ ok: true, registered: true, session_state: { state: "ready_for_input" } });
		await Bun.write(
			path.join(root, ".gjc", "coordinator-state", "local", "repo", "sessions", "visible-session.json"),
			JSON.stringify({
				session_id: "visible-session",
				cwd: root,
				endpoint: { url: "ws://broker.example.test/endpoint?token=session-record-secret" },
				token: "Bearer session-record-secret",
			}),
		);
		await Bun.write(
			path.join(root, ".gjc", "coordinator-state", "local", "repo", "session-states", "visible-session.json"),
			JSON.stringify({
				schema_version: 1,
				session_id: "visible-session",
				state: "ready_for_input",
				ready_for_input: true,
				current_turn_id: null,
				last_turn_id: null,
				updated_at: new Date().toISOString(),
				source: "coordinator",
				live: true,
				reason: "Bearer session-state-secret",
			}),
		);
		const status = await server.callTool("gjc_coordinator_read_status", { session_id: "visible-session" });
		expect(status).toMatchObject({
			ok: true,
			session: { session_id: "visible-session" },
			status: { authority: "sdk_broker", live: true },
		});
		const publicResult = JSON.stringify(status);
		expect(publicResult).not.toContain("broker-endpoint-secret");
		expect(publicResult).not.toContain("broker-discovery-secret");
		expect(publicResult).not.toContain("session-endpoint-secret");
		expect(publicResult).not.toContain("session-record-secret");
		expect(publicResult).not.toContain("session-state-secret");
		expect(publicResult).not.toContain(root);
		expect(controls).toEqual([
			{ operation: "session.list", input: { cwd: root }, idempotencyKey: undefined },
			{
				operation: "session.get_endpoint",
				input: {
					sessionId: "visible-session",
					endpointGeneration: 1,
					endpointIncarnation: brokerEndpointIncarnation("visible-session", 1, 101, 1),
				},
				idempotencyKey: "register-1",
			},
			{ operation: "session.list", input: { cwd: root }, idempotencyKey: undefined },
		]);
	});
	it("marks lifecycle-created sessions ready after successful SDK lifecycle binding", async () => {
		const root = await tempRoot();
		const controls: SdkControl[] = [];
		const server = await createSdkControlServer(root, controls);

		const started = await server.callTool("gjc_coordinator_start_session", {
			cwd: root,
			idempotency_key: "ready-after-binding",
			allow_mutation: true,
		});

		expect(started).toMatchObject({
			ok: true,
			session: { session_id: "created-session-1" },
			session_state: { state: "ready_for_input", ready_for_input: true },
		});
		expect(controls.map(control => control.operation)).toEqual([
			"session.create",
			"session.list",
			"session.get_endpoint",
		]);
	});

	it("preserves multiline delegated task text in one SDK turn.prompt control", async () => {
		const root = await tempRoot();
		const controls: SdkControl[] = [];
		const server = await createSdkControlServer(root, controls);
		await registerSdkSession(server, root);
		const task = "first line\n\n  exact indentation\nlast line";

		const delegated = await server.callTool("gjc_delegate_execute", {
			cwd: root,
			session_id: "visible-session",
			task,
			idempotency_key: "multiline-delegation",
			allow_mutation: true,
		});

		expect(delegated).toMatchObject({ ok: true, workflow: "execute" });
		const promptControls = controls.filter(control => control.operation === "turn.prompt");
		expect(promptControls).toHaveLength(1);
		expect(promptControls[0]).toEqual(
			expect.objectContaining({
				input: { text: expect.stringContaining(`Task:\n${task}\n\nReturn durable status`) },
			}),
		);
	});

	it("normalizes camelCase runtime acknowledgement identities into durable and public turns", async () => {
		const root = await tempRoot();
		const controls: SdkControl[] = [];
		const server = await createSdkControlServer(root, controls, [], undefined, undefined, undefined, undefined, {
			controlResult: () => ({
				type: "control_response",
				id: "runtime-ack-1",
				ok: true,
				result: { accepted: true, commandId: "runtime-command-1", turnId: "runtime-turn-1" },
			}),
		});
		await registerSdkSession(server, root);

		const sent = await server.callTool("gjc_coordinator_send_prompt", {
			session_id: "visible-session",
			prompt: "acknowledged work",
			idempotency_key: "camel-ack",
			allow_mutation: true,
		});

		expect(sent).toMatchObject({
			ok: true,
			result: { accepted: true, command_id: "runtime-command-1", turn_id: "runtime-turn-1" },
			turn: {
				delivery: { runtime_command_id: "runtime-command-1", runtime_turn_id: "runtime-turn-1" },
			},
		});
		const turnId = sent.turn_id;
		if (typeof turnId !== "string") throw new Error("missing durable coordinator turn id");
		const persisted = JSON.parse(
			await fs.readFile(
				path.join(root, ".gjc", "coordinator-state", "local", "repo", "turns", `${turnId}.json`),
				"utf8",
			),
		) as { delivery: Record<string, unknown> };
		expect(persisted.delivery).toMatchObject({
			runtime_command_id: "runtime-command-1",
			runtime_turn_id: "runtime-turn-1",
		});
	});

	it("accepts drive-letter and separator differences through the injected Windows platform seam", async () => {
		const root = await tempRoot();
		const controls: SdkControl[] = [];
		const canonicalWorkspace = "C:\\Workspaces\\Coordinator\\Repo";
		const server = await createSdkControlServer(
			root,
			controls,
			[],
			undefined,
			[
				{
					sessionId: "visible-session",
					locator: { repo: "c:/workspaces/coordinator/repo" },
					live: true,
					endpointGeneration: 1,
					pid: 101,
					endpointMtimeMs: 1,
				},
			],
			undefined,
			undefined,
			{
				platform: "win32",
				canonicalizePath: async value => path.win32.normalize(value === root ? canonicalWorkspace : value),
			},
		);
		const registered = await registerSdkSession(server, root);
		expect(registered).toMatchObject({ ok: true, session: { cwd: canonicalWorkspace } });
		expect(await server.callTool("gjc_coordinator_read_status", { session_id: "visible-session" })).toMatchObject({
			ok: true,
			status: { live: true },
		});
		expect(
			await server.callTool("gjc_coordinator_send_prompt", {
				session_id: "visible-session",
				prompt: "case-safe workspace",
				idempotency_key: "windows-case-safe",
				allow_mutation: true,
			}),
		).toMatchObject({ ok: true });
	});

	it("fails closed before turn persistence for malformed acknowledgement envelopes and conflicting aliases", async () => {
		const root = await tempRoot();
		const controls: SdkControl[] = [];
		const acknowledgements: Record<string, unknown> = {
			"missing-acceptance": { commandId: "runtime-command-1", turnId: "runtime-turn-1" },
			"malformed-identity": { accepted: true, commandId: "invalid/runtime-command", turnId: "runtime-turn-2" },
			"envelope-without-ok": {
				result: { accepted: true, commandId: "runtime-command-1", turnId: "runtime-turn-1" },
			},
			"envelope-without-result": {
				ok: true,
				accepted: true,
				commandId: "runtime-command-1",
				turnId: "runtime-turn-1",
			},
			"envelope-with-error": {
				ok: true,
				result: { accepted: true, commandId: "runtime-command-1", turnId: "runtime-turn-1" },
				error: { code: "unavailable" },
			},
			"envelope-error-only": { error: { code: "unavailable" } },
			"conflicting-command-aliases": {
				ok: true,
				result: {
					accepted: true,
					commandId: "runtime-command-1",
					command_id: "runtime-command-2",
					turnId: "runtime-turn-1",
				},
			},
			"conflicting-turn-aliases": {
				accepted: true,
				commandId: "runtime-command-1",
				turnId: "runtime-turn-1",
				turn_id: "runtime-turn-2",
			},
			"follow-up-without-turn": { accepted: true, commandId: "runtime-command-1" },
		};
		const server = await createSdkControlServer(root, controls, [], undefined, undefined, undefined, undefined, {
			controlResult: control => acknowledgements[control.idempotencyKey ?? ""],
		});
		await registerSdkSession(server, root);

		for (const [idempotencyKey, queue] of [
			["missing-acceptance", false],
			["malformed-identity", false],
			["envelope-without-ok", false],
			["envelope-without-result", false],
			["envelope-with-error", false],
			["envelope-error-only", false],
			["conflicting-command-aliases", false],
			["conflicting-turn-aliases", false],
			["follow-up-without-turn", true],
		] as const) {
			expect(
				await server.callTool("gjc_coordinator_send_prompt", {
					session_id: "visible-session",
					prompt: "must not be recorded",
					idempotency_key: idempotencyKey,
					...(queue ? { queue: true } : {}),
					allow_mutation: true,
				}),
			).toMatchObject({ ok: false, error: { code: "unavailable" } });
		}
		expect(controls.filter(control => control.operation === "turn.prompt")).toHaveLength(8);
		expect(controls.filter(control => control.operation === "turn.follow_up")).toHaveLength(1);
		await expect(
			fs.readdir(path.join(root, ".gjc", "coordinator-state", "local", "repo", "turns")),
		).rejects.toMatchObject({ code: "ENOENT" });
	});
	it("passes the bounded acknowledgement timeout to the SDK and surfaces timeout errors", async () => {
		const root = await tempRoot();
		const controls: SdkControl[] = [];
		const controlOptions: Array<{ idempotencyKey?: string; timeoutMs?: number }> = [];
		const server = await createSdkControlServer(root, controls, [], undefined, undefined, undefined, undefined, {
			promptAckTimeoutMs: 17,
			controlOptions,
			controlResult: () => {
				throw new SdkClientError("timeout", "SDK request timed out after 17ms");
			},
		});
		await registerSdkSession(server, root);

		expect(
			await server.callTool("gjc_coordinator_send_prompt", {
				session_id: "visible-session",
				prompt: "bounded timeout",
				idempotency_key: "bounded-timeout",
				allow_mutation: true,
			}),
		).toMatchObject({ ok: false, error: { code: "timeout" } });
		expect(controls.filter(control => control.operation === "turn.prompt")).toEqual([
			{ operation: "turn.prompt", input: { text: "bounded timeout" }, idempotencyKey: "bounded-timeout" },
		]);
		expect(controlOptions).toContainEqual({ idempotencyKey: "bounded-timeout", timeoutMs: 17 });
		await expect(
			fs.readdir(path.join(root, ".gjc", "coordinator-state", "local", "repo", "turns")),
		).rejects.toMatchObject({ code: "ENOENT" });
	});
	it("caps and defaults prompt acknowledgement timeouts passed to the SDK", async () => {
		for (const [configuredTimeoutMs, expectedTimeoutMs] of [
			[undefined, 10_000],
			[300_001, 300_000],
		] as const) {
			const root = await tempRoot();
			const controls: SdkControl[] = [];
			const controlOptions: Array<{ idempotencyKey?: string; timeoutMs?: number }> = [];
			const server = await createSdkControlServer(root, controls, [], undefined, undefined, undefined, undefined, {
				promptAckTimeoutMs: configuredTimeoutMs,
				controlOptions,
			});
			await registerSdkSession(server, root);
			expect(
				await server.callTool("gjc_coordinator_send_prompt", {
					session_id: "visible-session",
					prompt: "bounded prompt acknowledgement",
					idempotency_key: `prompt-timeout-${expectedTimeoutMs}`,
					allow_mutation: true,
				}),
			).toMatchObject({ ok: true });
			expect(controlOptions).toEqual([
				{ idempotencyKey: `prompt-timeout-${expectedTimeoutMs}`, timeoutMs: expectedTimeoutMs },
			]);
		}
	});

	it("derives aggregate liveness from scoped broker records", async () => {
		const root = await tempRoot();
		const controls: SdkControl[] = [];
		const server = await createSdkControlServer(root, controls, [], undefined, [
			{ sessionId: "live-session", locator: { repo: root }, live: true },
			{
				sessionId: "stale-session",
				locator: { repo: root },
				live: false,
				endpoint: { url: "ws://broker.example.test/endpoint?token=stale-secret", token: "Bearer stale-secret" },
			},
			{ sessionId: "other-workdir", locator: { repo: path.join(root, "other") }, live: true },
		]);
		const status = await server.callTool("gjc_coordinator_read_status");
		expect(status).toEqual({
			ok: true,
			sessions: [
				{ session_id: "live-session", live: true },
				{ session_id: "stale-session", live: false },
			],
			statuses: [
				{
					session: { session_id: "live-session", live: true },
					status: { authority: "sdk_broker", live: true },
				},
				{
					session: { session_id: "stale-session", live: false },
					status: { authority: "sdk_broker", live: false },
				},
			],
		});
		expect(JSON.stringify(status)).not.toContain("stale-secret");
		expect(controls).toEqual([{ operation: "session.list", input: { cwd: root }, idempotencyKey: undefined }]);
	});
	it("reads bounded tail output through the SDK", async () => {
		const root = await tempRoot();
		const controls: SdkControl[] = [];
		const queries: string[] = [];
		const server = await createSdkControlServer(root, controls, queries);
		await registerSdkSession(server, root);

		await expect(
			server.callTool("gjc_coordinator_read_tail", { session_id: "visible-session", lines: 1 }),
		).resolves.toEqual({ ok: true, source: "sdk", lines: ["latest assistant line"] });
		expect(queries).toEqual(["session.last_assistant"]);
	});
	it("returns SDK query failures without a terminal fallback", async () => {
		const root = await tempRoot();
		const controls: SdkControl[] = [];
		const queries: string[] = [];
		const server = await createSdkControlServer(root, controls, queries, () => ({
			type: "query_response",
			id: "query-1",
			ok: false,
			error: { code: "unavailable", message: "session endpoint unavailable" },
		}));
		await registerSdkSession(server, root);

		await expect(
			server.callTool("gjc_coordinator_read_tail", { session_id: "visible-session" }),
		).resolves.toMatchObject({
			ok: false,
			error: { code: "unavailable" },
		});
		expect(queries).toEqual(["session.last_assistant"]);
	});
	it("reads active-turn status through SDK context", async () => {
		const root = await tempRoot();
		const controls: SdkControl[] = [];
		const queries: string[] = [];
		const server = await createSdkControlServer(root, controls, queries);
		await registerSdkSession(server, root);
		const sent = await server.callTool("gjc_coordinator_send_prompt", {
			session_id: "visible-session",
			prompt: "work",
			idempotency_key: "prompt-1",
			allow_mutation: true,
		});

		await expect(server.callTool("gjc_coordinator_read_turn", { turn_id: sent.turn_id })).resolves.toMatchObject({
			ok: true,
			advisory_status: { authority: "sdk", live: true, is_streaming: true },
		});
		expect(queries).toEqual(["Q12", "context.get"]);
	});
	it("uses the generation-bound broker endpoint when a stale local endpoint file is absent", async () => {
		const root = await tempRoot();
		const controls: SdkControl[] = [];
		const queries: string[] = [];
		const server = await createSdkControlServer(root, controls, queries);
		await registerSdkSession(server, root);
		const sent = await server.callTool("gjc_coordinator_send_prompt", {
			session_id: "visible-session",
			prompt: "work",
			idempotency_key: "prompt-1",
			allow_mutation: true,
		});
		await fs.rm(path.join(root, ".gjc", "state", "sdk", "visible-session.json"));

		await expect(server.callTool("gjc_coordinator_read_turn", { turn_id: sent.turn_id })).resolves.toMatchObject({
			ok: true,
			advisory_status: { authority: "sdk", live: true, is_streaming: true },
		});
		expect(queries).toEqual(["Q12", "context.get"]);
	});

	it("passes a resolved mpreset into the SDK lifecycle create request and persists it with the session", async () => {
		const root = await tempRoot();
		const controls: SdkControl[] = [];
		const server = await createSdkControlServer(root, controls);
		const started = await server.callTool("gjc_coordinator_start_session", {
			cwd: root,
			mpreset: "codex-eco",
			idempotency_key: "preset-start",
			allow_mutation: true,
		});
		expect(started).toMatchObject({ ok: true, session: { session_id: "created-session-1", mpreset: "codex-eco" } });
		expect(lifecycleControls(controls)).toEqual([
			{
				operation: "session.create",
				input: { cwd: root, target: { path: root }, modelPreset: "codex-eco" },
				idempotencyKey: "preset-start",
			},
		]);
		await expect(
			fs.readFile(
				path.join(root, ".gjc", "coordinator-state", "local", "repo", "sessions", "created-session-1.json"),
				"utf8",
			),
		).resolves.toContain('"mpreset": "codex-eco"');
	});
	it("keeps lifecycle endpoint credentials out of start_session results", async () => {
		const root = await tempRoot();
		const controls: SdkControl[] = [];
		const server = await createSdkControlServer(root, controls);

		const started = await server.callTool("gjc_coordinator_start_session", {
			cwd: root,
			idempotency_key: "credential-free-start",
			allow_mutation: true,
		});

		expect(started).toMatchObject({ ok: true, session: { session_id: "created-session-1" } });
		expect(started.result).toBeUndefined();
		for (const secret of ["created-endpoint-secret", "nested-created-endpoint-secret", "Bearer"]) {
			expect(JSON.stringify(started)).not.toContain(secret);
		}
		expect(started.lifecycle).toEqual({ session_id: "created-session-1" });
	});

	it("translates the documented GJC worktree command into a typed SDK lifecycle target", async () => {
		const root = await tempRoot();
		const controls: SdkControl[] = [];
		const server = await createSdkControlServer(
			root,
			controls,
			undefined,
			undefined,
			undefined,
			"gjc --worktree hermes",
		);

		const started = await server.callTool("gjc_coordinator_start_session", {
			cwd: root,
			idempotency_key: "worktree-start",
			allow_mutation: true,
		});
		expect(started).toMatchObject({
			ok: true,
			session: { cwd: path.join(root, "hermes-worktree") },
			lifecycle: {
				session_id: "created-session-1",
				worktree: {
					enabled: true,
					cwd: path.join(root, "hermes-worktree"),
					created: true,
					reused: false,
				},
			},
		});
		expect(controls).toContainEqual({
			operation: "session.create",
			input: {
				cwd: root,
				target: { path: root, worktree: { enabled: true, name: "hermes" } },
			},
			idempotencyKey: "worktree-start",
		});
	});

	it("rejects unsupported session-command flags rather than silently ignoring them", async () => {
		const root = await tempRoot();
		const controls: SdkControl[] = [];
		const server = await createSdkControlServer(
			root,
			controls,
			undefined,
			undefined,
			undefined,
			"gjc --worktree --model provider/model",
		);

		await expect(
			server.callTool("gjc_coordinator_start_session", {
				cwd: root,
				idempotency_key: "invalid-worktree-command",
				allow_mutation: true,
			}),
		).resolves.toMatchObject({ ok: false, error: { code: "invalid_input" } });
		expect(controls).toEqual([]);
	});
	it("rejects wrapper session commands instead of executing a coordinator-owned launcher", async () => {
		const root = await tempRoot();
		const controls: SdkControl[] = [];
		const server = await createSdkControlServer(
			root,
			controls,
			undefined,
			undefined,
			undefined,
			"wrapper gjc --worktree",
		);

		await expect(
			server.callTool("gjc_coordinator_start_session", {
				cwd: root,
				idempotency_key: "wrapper-command",
				allow_mutation: true,
			}),
		).resolves.toMatchObject({ ok: false, error: { code: "invalid_input" } });
		expect(controls).toEqual([]);
	});
	it("durably replays sequential prompt retries and rejects caller-key request conflicts", async () => {
		const root = await tempRoot();
		const controls: SdkControl[] = [];
		const server = await createSdkControlServer(root, controls);
		await registerSdkSession(server, root);
		const first = await server.callTool("gjc_coordinator_send_prompt", {
			session_id: "visible-session",
			prompt: "retry-safe prompt",
			idempotency_key: "same-prompt-key",
			allow_mutation: true,
		});
		const replay = await server.callTool("gjc_coordinator_send_prompt", {
			session_id: "visible-session",
			prompt: "retry-safe prompt",
			idempotency_key: "same-prompt-key",
			allow_mutation: true,
		});
		expect(replay).toEqual(first);
		expect(lifecycleControls(controls).filter(control => control.operation === "turn.prompt")).toHaveLength(1);
		await expect(
			server.callTool("gjc_coordinator_send_prompt", {
				session_id: "visible-session",
				prompt: "different prompt",
				idempotency_key: "same-prompt-key",
				allow_mutation: true,
			}),
		).resolves.toMatchObject({ ok: false, error: { code: "idempotency_conflict" } });
		expect(lifecycleControls(controls).filter(control => control.operation === "turn.prompt")).toHaveLength(1);
	});
	it("serializes concurrent same-key retries into one durable turn", async () => {
		const root = await tempRoot();
		const controls: SdkControl[] = [];
		const server = await createSdkControlServer(root, controls);
		await registerSdkSession(server, root);
		const request = {
			session_id: "visible-session",
			prompt: "concurrent retry",
			idempotency_key: "concurrent-prompt-key",
			allow_mutation: true,
		};
		const [first, replay] = await Promise.all([
			server.callTool("gjc_coordinator_send_prompt", request),
			server.callTool("gjc_coordinator_send_prompt", request),
		]);
		expect(replay).toEqual(first);
		expect(lifecycleControls(controls).filter(control => control.operation === "turn.prompt")).toHaveLength(1);
	});
	it("replays composite start and report mutations without allocating another turn or report", async () => {
		const root = await tempRoot();
		const controls: SdkControl[] = [];
		const server = await createSdkControlServer(root, controls);
		const startArgs = {
			cwd: root,
			prompt: "start once",
			idempotency_key: "composite-start",
			allow_mutation: true,
		};
		const started = await server.callTool("gjc_coordinator_start_session", startArgs);
		const replayedStart = await server.callTool("gjc_coordinator_start_session", startArgs);
		expect(replayedStart).toEqual(started);
		expect(lifecycleControls(controls).filter(control => control.operation === "session.create")).toHaveLength(1);
		expect(lifecycleControls(controls).filter(control => control.operation === "turn.prompt")).toHaveLength(1);
		const delegateArgs = {
			cwd: root,
			task: "delegate once",
			idempotency_key: "composite-delegate",
			allow_mutation: true,
		};
		const delegated = await server.callTool("gjc_delegate_execute", delegateArgs);
		const replayedDelegate = await server.callTool("gjc_delegate_execute", delegateArgs);
		expect(replayedDelegate).toEqual(delegated);
		expect(lifecycleControls(controls).filter(control => control.operation === "session.create")).toHaveLength(2);
		expect(lifecycleControls(controls).filter(control => control.operation === "turn.prompt")).toHaveLength(2);

		const reportArgs = {
			status: "running",
			summary: "one report",
			idempotency_key: "composite-report",
			allow_mutation: true,
		};
		const report = await server.callTool("gjc_coordinator_report_status", reportArgs);
		const replayedReport = await server.callTool("gjc_coordinator_report_status", reportArgs);
		expect(replayedReport).toEqual(report);
		await expect(server.callTool("gjc_coordinator_read_coordination_status")).resolves.toMatchObject({
			summary: { reports: 1 },
		});
	});
	it("fails closed when a same-generation successor has a different endpoint incarnation", async () => {
		const root = await tempRoot();
		const controls: SdkControl[] = [];
		const sessions = [
			{
				sessionId: "visible-session",
				locator: { repo: root },
				live: true,
				endpointGeneration: 1,
				pid: 101,
				endpointMtimeMs: 1,
			},
		];
		const server = await createSdkControlServer(root, controls, undefined, undefined, sessions);
		await registerSdkSession(server, root);
		const recordPath = path.join(
			root,
			".gjc",
			"coordinator-state",
			"local",
			"repo",
			"sessions",
			"visible-session.json",
		);
		const record = JSON.parse(await fs.readFile(recordPath, "utf8"));
		await Bun.write(
			recordPath,
			JSON.stringify({ ...record, ephemeral: true, created_at: new Date(Date.now() - 31 * 60_000).toISOString() }),
		);
		sessions[0]!.endpointMtimeMs = 2;

		await expect(
			server.callTool("gjc_coordinator_send_prompt", {
				session_id: "visible-session",
				prompt: "stale successor",
				idempotency_key: "stale-incarnation-prompt",
				allow_mutation: true,
			}),
		).resolves.toMatchObject({ ok: false, error: { code: "endpoint_stale" } });
		await expect(
			server.callTool("gjc_coordinator_stop_session", {
				session_id: "visible-session",
				allow_mutation: true,
			}),
		).resolves.toMatchObject({ ok: false, reason: "endpoint_stale", closed: false });
		expect(
			controls.filter(control => control.operation === "turn.prompt" || control.operation === "session.close"),
		).toEqual([]);
	});
	it("does not return successor credentials after a same-generation restart between list and endpoint retrieval", async () => {
		const root = await tempRoot();
		const controls: SdkControl[] = [];
		const sessions = [
			{
				sessionId: "visible-session",
				locator: { repo: root },
				live: true,
				endpointGeneration: 1,
				pid: 101,
				endpointMtimeMs: 1,
			},
		];
		let rotateAtEndpointRetrieval = false;
		const initialIncarnation = brokerEndpointIncarnation("visible-session", 1, 101, 1);
		const server = await createSdkControlServer(root, controls, undefined, undefined, sessions, undefined, input => {
			if (!rotateAtEndpointRetrieval)
				return {
					ok: true,
					result: {
						url: "ws://broker.example.test/endpoint?token=broker-endpoint-secret",
						token: "Bearer broker-endpoint-secret",
					},
				};
			sessions[0] = { ...sessions[0]!, pid: 202, endpointMtimeMs: 2 };
			if (input.endpointIncarnation === initialIncarnation)
				return { ok: false, error: { code: "endpoint_stale", message: "session endpoint is stale" } };
			return {
				ok: true,
				result: {
					url: "ws://broker.example.test/successor?token=successor-endpoint-secret",
					token: "Bearer successor-endpoint-secret",
				},
			};
		});
		await registerSdkSession(server, root);
		rotateAtEndpointRetrieval = true;

		const result = await server.callTool("gjc_coordinator_send_prompt", {
			session_id: "visible-session",
			prompt: "must not reach successor",
			idempotency_key: "same-generation-restart",
			allow_mutation: true,
		});
		expect(result).toMatchObject({ ok: false, error: { code: "endpoint_stale" } });
		expect(JSON.stringify(result)).not.toContain("successor-endpoint-secret");
		expect(controls.filter(control => control.operation === "turn.prompt")).toEqual([]);
		expect(controls.filter(control => control.operation === "session.get_endpoint").at(-1)).toMatchObject({
			input: {
				sessionId: "visible-session",
				endpointGeneration: 1,
				endpointIncarnation: initialIncarnation,
			},
		});
	});
	it("fails closed on corrupt or crash-left coordinator idempotency records", async () => {
		const root = await tempRoot();
		const controls: SdkControl[] = [];
		const server = await createSdkControlServer(root, controls);
		const corruptKey = "corrupt-report";
		const corruptFile = path.join(
			root,
			".gjc",
			"coordinator-state",
			"local",
			"repo",
			"idempotency",
			`${createHash("sha256").update(corruptKey).digest("hex")}.json`,
		);
		await fs.mkdir(path.dirname(corruptFile), { recursive: true });
		await Bun.write(corruptFile, "{not-json");
		await expect(
			server.callTool("gjc_coordinator_report_status", {
				status: "running",
				summary: "must not write",
				idempotency_key: corruptKey,
				allow_mutation: true,
			}),
		).resolves.toMatchObject({ ok: false, error: { code: "terminal_uncertain" } });
		expect(
			await fs.readdir(path.join(root, ".gjc", "coordinator-state", "local", "repo", "reports")).catch(() => []),
		).toEqual([]);

		await registerSdkSession(server, root);
		const registerFile = path.join(
			root,
			".gjc",
			"coordinator-state",
			"local",
			"repo",
			"idempotency",
			`${createHash("sha256").update("register-1").digest("hex")}.json`,
		);
		const completed = JSON.parse(await fs.readFile(registerFile, "utf8"));
		await Bun.write(registerFile, JSON.stringify({ ...completed, state: "in_progress" }));
		const endpointReads = controls.filter(control => control.operation === "session.get_endpoint").length;
		await expect(registerSdkSession(server, root)).resolves.toMatchObject({ ok: true, registered: true });
		expect(controls.filter(control => control.operation === "session.get_endpoint")).toHaveLength(endpointReads);
	});
	it("fails closed on workspace and endpoint-generation binding changes", async () => {
		const root = await tempRoot();
		const otherWorkspace = path.join(root, "other-workspace");
		await fs.mkdir(otherWorkspace);
		const controls: SdkControl[] = [];
		const sessions = [
			{
				sessionId: "visible-session",
				locator: { repo: root },
				live: true,
				endpointGeneration: 1,
				pid: 101,
				endpointMtimeMs: 1,
			},
		];
		const server = await createSdkControlServer(root, controls, undefined, undefined, sessions);
		await registerSdkSession(server, root);
		sessions.push({
			sessionId: "foreign-session",
			locator: { repo: otherWorkspace },
			live: true,
			endpointGeneration: 1,
			pid: 102,
			endpointMtimeMs: 2,
		});
		await expect(
			server.callTool("gjc_coordinator_register_session", {
				session_id: "foreign-session",
				cwd: root,
				idempotency_key: "foreign-workspace",
				allow_mutation: true,
			}),
		).resolves.toMatchObject({ ok: false, error: { code: "not_found" } });
		sessions[0]!.endpointGeneration = 2;
		await expect(
			server.callTool("gjc_coordinator_send_prompt", {
				session_id: "visible-session",
				prompt: "stale generation",
				idempotency_key: "stale-generation",
				allow_mutation: true,
			}),
		).resolves.toMatchObject({ ok: false, error: { code: "endpoint_stale" } });
		expect(lifecycleControls(controls).filter(control => control.operation === "turn.prompt")).toHaveLength(0);
		await expect(
			server.callTool("gjc_delegate_execute", {
				cwd: otherWorkspace,
				session_id: "visible-session",
				task: "wrong workspace",
				idempotency_key: "wrong-workspace",
				allow_mutation: true,
			}),
		).resolves.toMatchObject({ ok: false, error: { code: "workspace_mismatch" } });
	});
	it("uses an incarnation-bound close key for each reaped session incarnation", async () => {
		const root = await tempRoot();
		const controls: SdkControl[] = [];
		const sessions = [
			{
				sessionId: "visible-session",
				locator: { repo: root },
				live: true,
				endpointGeneration: 1,
				pid: 101,
				endpointMtimeMs: 1,
			},
		];
		const server = await createSdkControlServer(root, controls, undefined, undefined, sessions);
		const recordPath = path.join(
			root,
			".gjc",
			"coordinator-state",
			"local",
			"repo",
			"sessions",
			"visible-session.json",
		);
		for (const [registrationKey, endpointMtimeMs] of [
			["reap-first-registration", 1],
			["reap-second-registration", 2],
		] as const) {
			if (sessions.length === 0)
				sessions.push({
					sessionId: "visible-session",
					locator: { repo: root },
					live: true,
					endpointGeneration: 1,
					pid: 101,
					endpointMtimeMs,
				});
			else {
				sessions[0]!.endpointMtimeMs = endpointMtimeMs;
				sessions[0]!.endpointGeneration = endpointMtimeMs;
			}
			await expect(
				server.callTool("gjc_coordinator_register_session", {
					session_id: "visible-session",
					cwd: root,
					idempotency_key: registrationKey,
					allow_mutation: true,
				}),
			).resolves.toMatchObject({ ok: true });
			const record = JSON.parse(await fs.readFile(recordPath, "utf8"));
			await Bun.write(
				recordPath,
				JSON.stringify({
					...record,
					ephemeral: true,
					created_at: new Date(Date.now() - 31 * 60_000).toISOString(),
				}),
			);
			await expect(
				server.callTool("gjc_coordinator_stop_session", { session_id: "visible-session", allow_mutation: true }),
			).resolves.toMatchObject({ ok: true, closed: true });
		}
		const closes = controls.filter(control => control.operation === "session.close");
		expect(closes).toHaveLength(2);
		expect(closes.map(control => control.idempotencyKey)).toEqual([
			expect.stringMatching(/^coordinator-reap:visible-session:[a-f0-9]{64}$/),
			expect.stringMatching(/^coordinator-reap:visible-session:[a-f0-9]{64}$/),
		]);
		expect(closes[0]!.idempotencyKey).not.toBe(closes[1]!.idempotencyKey);
		expect(closes[0]!.input.endpointIncarnation).not.toBe(closes[1]!.input.endpointIncarnation);
	});
	it("never returns credential-contaminated reused session records", async () => {
		const root = await tempRoot();
		const controls: SdkControl[] = [];
		const server = await createSdkControlServer(root, controls);
		await registerSdkSession(server, root);
		const recordPath = path.join(
			root,
			".gjc",
			"coordinator-state",
			"local",
			"repo",
			"sessions",
			"visible-session.json",
		);
		const record = JSON.parse(await fs.readFile(recordPath, "utf8"));
		await Bun.write(
			recordPath,
			JSON.stringify({
				...record,
				endpoint: { token: "reused-session-secret" },
				token: "reused-session-secret",
				credentials: { nested: "reused-session-secret" },
			}),
		);
		const delegated = await server.callTool("gjc_delegate_plan", {
			cwd: root,
			session_id: "visible-session",
			task: "sanitize session",
			idempotency_key: "contaminated-reuse",
			allow_mutation: true,
		});
		expect(delegated).toMatchObject({ ok: true, session: { session_id: "visible-session" } });
		expect(JSON.stringify(delegated)).not.toContain("reused-session-secret");
		expect(await fs.readFile(recordPath, "utf8")).not.toContain("reused-session-secret");
	});

	it("routes prompts, follow-ups, abort-and-prompts, and answers through SDK controls with caller keys", async () => {
		const root = await tempRoot();
		const controls: SdkControl[] = [];
		const controlOptions: Array<{ idempotencyKey?: string; timeoutMs?: number }> = [];
		const server = await createSdkControlServer(root, controls, [], undefined, undefined, undefined, undefined, {
			promptAckTimeoutMs: 17,
			controlOptions,
		});
		await registerSdkSession(server, root);
		const first = await server.callTool("gjc_coordinator_send_prompt", {
			session_id: "visible-session",
			prompt: "first",
			idempotency_key: "prompt-1",
			allow_mutation: true,
		});
		expect(first).toMatchObject({ ok: true, operation: "turn.prompt", turn: { status: "active" } });
		const queued = await server.callTool("gjc_coordinator_send_prompt", {
			session_id: "visible-session",
			prompt: "follow up",
			queue: true,
			idempotency_key: "prompt-2",
			allow_mutation: true,
		});
		expect(queued).toMatchObject({
			ok: true,
			operation: "turn.follow_up",
			result: { accepted: true, command_id: expect.any(String), turn_id: expect.any(String) },
			turn: {
				status: "queued",
				delivery: { runtime_command_id: expect.any(String), runtime_turn_id: expect.any(String) },
			},
		});
		const queuedTurnId = queued.turn_id;
		if (typeof queuedTurnId !== "string") throw new Error("missing queued coordinator turn id");
		const queuedAcknowledgement = queued.result as { command_id?: unknown; turn_id?: unknown };
		const persistedQueuedTurn = JSON.parse(
			await fs.readFile(
				path.join(root, ".gjc", "coordinator-state", "local", "repo", "turns", `${queuedTurnId}.json`),
				"utf8",
			),
		) as { delivery: Record<string, unknown> };
		expect(persistedQueuedTurn.delivery).toMatchObject({
			runtime_command_id: queuedAcknowledgement.command_id,
			runtime_turn_id: queuedAcknowledgement.turn_id,
		});
		expect(
			await server.callTool("gjc_coordinator_send_prompt", {
				session_id: "visible-session",
				prompt: "replace",
				force: true,
				idempotency_key: "prompt-3",
				allow_mutation: true,
			}),
		).toMatchObject({ ok: true, operation: "turn.abort_and_prompt", turn: { status: "active" } });
		expect(lifecycleControls(controls)).toEqual([
			{ operation: "turn.prompt", input: { text: "first" }, idempotencyKey: "prompt-1" },
			{ operation: "turn.follow_up", input: { text: "follow up" }, idempotencyKey: "prompt-2" },
			{ operation: "turn.abort_and_prompt", input: { text: "replace" }, idempotencyKey: "prompt-3" },
		]);
		expect(controlOptions).toEqual([
			{ idempotencyKey: "prompt-1", timeoutMs: 17 },
			{ idempotencyKey: "prompt-2", timeoutMs: 17 },
			{ idempotencyKey: "prompt-3", timeoutMs: 17 },
		]);
	});

	it("materializes a legal two-page Q12 snapshot on one connection and submits its bound shared-producer answer", async () => {
		const root = await tempRoot();
		const controls: SdkControl[] = [];
		const q12Calls: Array<string | undefined> = [];
		let runtimeTurnId = "unbound";
		const server = await createSdkControlServer(
			root,
			controls,
			[],
			(query, cursor) => {
				if (query !== "Q12") return { ok: true, page: { items: [], complete: true, revision: "context" } };
				q12Calls.push(cursor);
				return cursor
					? {
							ok: true,
							page: { items: [sharedAskGate("gate-q12", runtimeTurnId)], complete: true, revision: "q12-r1" },
						}
					: {
							ok: true,
							page: {
								items: [],
								complete: false,
								preview: true,
								continuationCursor: "page-2",
								revision: "q12-r1",
							},
						};
			},
			undefined,
			undefined,
			undefined,
			{
				controlResult: control =>
					control.operation === "workflow.gate_answer" ? { status: "accepted" } : undefined,
			},
		);
		await registerSdkSession(server, root);
		const sent = await server.callTool("gjc_coordinator_send_prompt", {
			session_id: "visible-session",
			prompt: "open gate",
			idempotency_key: "gate-owner",
			allow_mutation: true,
		});
		const runtimeAcknowledgement = sent.result as { turn_id?: unknown };
		if (typeof runtimeAcknowledgement.turn_id !== "string") throw new Error("missing runtime turn id");
		runtimeTurnId = runtimeAcknowledgement.turn_id;
		const listed = await server.callTool("gjc_coordinator_list_questions", { session_id: "visible-session" });
		expect(listed).toMatchObject({ ok: true, reconciliation: { complete: true, revision: "q12-r1" } });
		expect(q12Calls).toEqual([undefined, "page-2"]);
		const question = (listed.questions as Array<Record<string, unknown>>)[0]!;
		expect(question).toMatchObject({
			question_id: "gate-q12",
			status: "pending",
		});
		expect(JSON.stringify(question)).not.toContain("codec");
		if (typeof question.answer_binding !== "string") throw new Error("missing answer binding");
		expect(question.answer_binding).toMatch(/^[A-Za-z0-9_-]{43}$/);

		const answer = await server.callTool("gjc_coordinator_submit_question_answer", {
			session_id: "visible-session",
			turn_id: sent.turn_id,
			question_id: "gate-q12",
			answer_binding: question.answer_binding,
			answer: { selected: ["opt_0"] },
			idempotency_key: "answer-q12",
			allow_mutation: true,
		});
		expect(answer).toMatchObject({
			ok: true,
			operation: "workflow.gate_answer",
			status: "accepted",
			replayed: false,
		});
		expect(controls.filter(control => control.operation === "workflow.gate_answer")).toEqual([
			expect.objectContaining({
				input: { id: "gate-q12", response: { selected: ["Continue"] }, expectedSessionId: "visible-session" },
			}),
		]);
		const replay = await server.callTool("gjc_coordinator_submit_question_answer", {
			session_id: "visible-session",
			turn_id: sent.turn_id,
			question_id: "gate-q12",
			answer_binding: question.answer_binding,
			answer: { selected: ["opt_0"] },
			idempotency_key: "answer-q12",
			allow_mutation: true,
		});
		expect(replay).toMatchObject({ ok: true, status: "accepted", replayed: false });
		expect(
			await server.callTool("gjc_coordinator_submit_question_answer", {
				session_id: "visible-session",
				turn_id: sent.turn_id,
				question_id: "gate-q12",
				answer_binding: question.answer_binding,
				answer: { selected: ["opt_1"] },
				idempotency_key: "answer-q12",
				allow_mutation: true,
			}),
		).toMatchObject({ ok: false, error: { code: "idempotency_conflict" } });
	});

	it("rejects malformed complete Q12 snapshots without mutating question authority", async () => {
		const root = await tempRoot();
		const controls: SdkControl[] = [];
		let runtimeTurnId = "unbound";
		const gates = () => [
			{ ...sharedAskGate("bad-runtime", runtimeTurnId), runtime_turn_id: "" },
			{ ...sharedAskGate("unsupported", runtimeTurnId), kind: "approval" },
		];
		const server = await createSdkControlServer(root, controls, [], query =>
			query === "Q12"
				? { ok: true, page: { items: gates(), complete: true, revision: "q12-bad" } }
				: { ok: true, page: { items: [], complete: true, revision: "context" } },
		);
		await registerSdkSession(server, root);
		const sent = await server.callTool("gjc_coordinator_send_prompt", {
			session_id: "visible-session",
			prompt: "owner",
			idempotency_key: "owner-bad",
			allow_mutation: true,
		});
		const runtimeAcknowledgement = sent.result as { turn_id?: unknown };
		if (typeof runtimeAcknowledgement.turn_id !== "string") throw new Error("missing runtime turn id");
		runtimeTurnId = runtimeAcknowledgement.turn_id;
		const first = await server.callTool("gjc_coordinator_list_questions", { session_id: "visible-session" });
		const second = await server.callTool("gjc_coordinator_list_questions", { session_id: "visible-session" });
		expect(first).toMatchObject({
			questions: [],
			diagnostics: expect.arrayContaining([expect.objectContaining({ reason: "pagination_malformed" })]),
			reconciliation: { complete: false, reason: "pagination_malformed" },
		});
		expect(second).toMatchObject({ questions: [], reconciliation: { complete: false } });
	});

	it("does not fabricate stale questions from incomplete or paginated Q12 observations", async () => {
		const root = await tempRoot();
		const controls: SdkControl[] = [];
		const queries: string[] = [];
		const server = await createSdkControlServer(root, controls, queries, query => {
			if (query === "Q12") {
				return {
					type: "query_response",
					id: "q12-incomplete",
					ok: true,
					page: { items: [], complete: false, revision: "partial-q12" },
				};
			}
			return {
				type: "query_response",
				id: "context",
				ok: true,
				page: { items: [], complete: true, revision: "context" },
			};
		});
		await registerSdkSession(server, root);
		const listed = await server.callTool("gjc_coordinator_list_questions", { session_id: "visible-session" });
		expect(listed).toMatchObject({
			ok: true,
			schema_version: 1,
			questions: [],
			reconciliation: { attempted: true, complete: false, revision: "partial-q12" },
		});
		expect(JSON.stringify(listed)).not.toContain("answer_binding");
		expect(queries).toEqual(["Q12"]);
	});

	it("delivers every delegation workflow through broker lifecycle and SDK control", async () => {
		const root = await tempRoot();
		const controls: SdkControl[] = [];
		const server = await createSdkControlServer(root, controls);
		for (const [tool, key] of [
			["gjc_delegate_plan", "plan"],
			["gjc_delegate_execute", "execute"],
			["gjc_delegate_team", "team"],
		] as const) {
			const result = await server.callTool(tool, {
				cwd: root,
				task: `${key} task`,
				idempotency_key: key,
				allow_mutation: true,
			});
			expect(result).toMatchObject({ ok: true, delivered: true, workflow: key });
		}
		expect(lifecycleControls(controls)).toEqual(
			expect.arrayContaining([
				{ operation: "session.create", input: { cwd: root, target: { path: root } }, idempotencyKey: "plan" },
				{
					operation: "turn.prompt",
					input: { text: expect.stringContaining("/skill:ralplan") },
					idempotencyKey: "plan",
				},
				{
					operation: "turn.prompt",
					input: { text: expect.stringContaining("/skill:ultragoal") },
					idempotencyKey: "execute",
				},
				{
					operation: "turn.prompt",
					input: { text: expect.stringContaining("/skill:team") },
					idempotencyKey: "team",
				},
			]),
		);
	});
	it("serializes concurrent delegations that reuse one live session", async () => {
		const root = await tempRoot();
		const controls: SdkControl[] = [];
		const server = await createSdkControlServer(root, controls);
		await registerSdkSession(server, root);

		const results = await Promise.all([
			server.callTool("gjc_delegate_execute", {
				cwd: root,
				session_id: "visible-session",
				task: "first delegated task",
				idempotency_key: "delegate-first",
				allow_mutation: true,
			}),
			server.callTool("gjc_delegate_execute", {
				cwd: root,
				session_id: "visible-session",
				task: "second delegated task",
				idempotency_key: "delegate-second",
				allow_mutation: true,
			}),
		]);

		expect(results.filter(result => result.ok === true && result.status === "active")).toHaveLength(1);
		expect(
			results.filter(
				result =>
					result.ok === false && (result.error as { code?: string } | undefined)?.code === "active_turn_exists",
			),
		).toHaveLength(1);
		expect(controls.filter(control => control.operation === "turn.prompt")).toHaveLength(1);
	});

	it("returns immediately by default and exposes bounded delegation completion when requested", async () => {
		const root = await tempRoot();
		const controls: SdkControl[] = [];
		const server = await createSdkControlServer(root, controls);
		const immediate = await server.callTool("gjc_delegate_plan", {
			cwd: root,
			task: "immediate",
			idempotency_key: "immediate",
			allow_mutation: true,
		});
		expect(immediate).toMatchObject({ ok: true, delivered: true, turn: { status: "active" } });
		expect(immediate.completion).toBeUndefined();
		const awaited = await server.callTool("gjc_delegate_execute", {
			cwd: root,
			task: "timeout",
			idempotency_key: "timeout",
			allow_mutation: true,
			await_completion: true,
			timeout_ms: 10,
			poll_interval_ms: 10,
			lines: 3,
		});
		expect(awaited).toMatchObject({
			ok: true,
			completion: { ok: false, reason: "timeout", turn: { status: "active" } },
		});
	});

	it("rejects missing caller idempotency keys without invoking the SDK", async () => {
		const root = await tempRoot();
		const controls: SdkControl[] = [];
		const server = await createSdkControlServer(root, controls);
		await registerSdkSession(server, root);
		expect(
			await server.callTool("gjc_coordinator_send_prompt", {
				session_id: "visible-session",
				prompt: "work",
				allow_mutation: true,
			}),
		).toMatchObject({ ok: false, error: { code: "invalid_request" } });
		expect(
			await server.callTool("gjc_coordinator_submit_question_answer", {
				session_id: "visible-session",
				question_id: "ask-1",
				answer: "yes",
				allow_mutation: true,
			}),
		).toMatchObject({ ok: false, error: { code: "invalid_request" } });
		expect(lifecycleControls(controls)).toEqual([]);
	});

	it("returns SDK failures rather than falling back outside SDK control", async () => {
		const root = await tempRoot();
		const server = createCoordinatorMcpServer({
			env: {
				GJC_COORDINATOR_MCP_WORKDIR_ROOTS: root,
				GJC_COORDINATOR_MCP_STATE_ROOT: path.join(root, ".gjc", "coordinator-state"),
				GJC_COORDINATOR_MCP_MUTATIONS: "sessions",
				GJC_COORDINATOR_MCP_PROFILE: "local",
				GJC_COORDINATOR_MCP_REPO: "repo",
			},
		});
		await registerSdkSession(server, root);
		expect(
			await server.callTool("gjc_coordinator_send_prompt", {
				session_id: "visible-session",
				prompt: "work",
				idempotency_key: "key-1",
				allow_mutation: true,
			}),
		).toMatchObject({ ok: false, error: { code: "not_found" } });
	});

	it("keeps coordinator metadata reports and event journals available without turning them into control authority", async () => {
		const root = await tempRoot();
		const controls: SdkControl[] = [];
		const server = await createSdkControlServer(root, controls);
		await registerSdkSession(server, root);
		const report = await server.callTool("gjc_coordinator_report_status", {
			session_id: "visible-session",
			status: "blocked",
			summary: "Awaiting SDK turn completion.",
			idempotency_key: "report-1",
			allow_mutation: true,
		});
		expect(report).toMatchObject({ ok: true, report: { status: "blocked", session_id: "visible-session" } });
		const events = await server.callTool("gjc_coordinator_watch_events", { after_seq: 0 });
		expect((events.events as Array<{ kind: string }>).map(event => event.kind)).toEqual([
			"session.state_changed",
			"session.registered",
			"report.written",
		]);
		expect(lifecycleControls(controls)).toEqual([]);
	});
	it("closes an idle ephemeral coordinator session through incarnation-bound broker lifecycle authority", async () => {
		const root = await tempRoot();
		const controls: SdkControl[] = [];
		const server = await createSdkControlServer(root, controls);
		await registerSdkSession(server, root);
		const sessionFile = path.join(
			root,
			".gjc",
			"coordinator-state",
			"local",
			"repo",
			"sessions",
			"visible-session.json",
		);
		const record = JSON.parse(await fs.readFile(sessionFile, "utf8"));
		await Bun.write(
			sessionFile,
			JSON.stringify({ ...record, ephemeral: true, created_at: new Date(Date.now() - 31 * 60_000).toISOString() }),
		);

		expect(
			await server.callTool("gjc_coordinator_stop_session", {
				session_id: "visible-session",
				allow_mutation: true,
			}),
		).toMatchObject({ ok: true, closed: true, session_id: "visible-session" });
		expect(controls.filter(control => control.operation === "session.close")).toEqual([
			expect.objectContaining({
				input: expect.objectContaining({
					sessionId: "visible-session",
					endpointGeneration: 1,
					endpointIncarnation: expect.stringMatching(/^[a-f0-9]{64}$/),
				}),
				idempotencyKey: expect.stringMatching(/^coordinator-reap:visible-session:[a-f0-9]{64}$/),
			}),
		]);
		expect(await Bun.file(sessionFile).exists()).toBe(false);
	});

	it("idle reaping selects only stale ephemeral coordinator records and uses incarnation-bound session.close", async () => {
		const root = await tempRoot();
		const controls: SdkControl[] = [];
		const brokerSessions = [
			{
				sessionId: "idle-session",
				locator: { repo: root },
				live: true,
				endpointGeneration: 1,
				pid: 202,
				endpointMtimeMs: 2,
			},
		];
		const server = await createSdkControlServer(root, controls, undefined, undefined, brokerSessions);
		await expect(
			server.callTool("gjc_coordinator_register_session", {
				session_id: "idle-session",
				cwd: root,
				idempotency_key: "register-idle",
				allow_mutation: true,
			}),
		).resolves.toMatchObject({ ok: true });
		const sessionsDir = path.join(root, ".gjc", "coordinator-state", "local", "repo", "sessions");
		const idleFile = path.join(sessionsDir, "idle-session.json");
		const idle = JSON.parse(await fs.readFile(idleFile, "utf8"));
		await Bun.write(
			idleFile,
			JSON.stringify({ ...idle, ephemeral: true, created_at: new Date(Date.now() - 31 * 60_000).toISOString() }),
		);
		await fs.rm(path.join(root, ".gjc", "coordinator-state", "local", "repo", "session-states", "idle-session.json"));
		await Bun.write(
			path.join(sessionsDir, "registered-session.json"),
			JSON.stringify({
				session_id: "registered-session",
				cwd: root,
				created_at: new Date(Date.now() - 31 * 60_000).toISOString(),
			}),
		);

		expect(await server.sessionReaper.sweepOnce()).toBe(1);
		expect(controls.filter(control => control.operation === "session.close")).toEqual([
			expect.objectContaining({
				input: expect.objectContaining({
					sessionId: "idle-session",
					endpointGeneration: 1,
					endpointIncarnation: expect.stringMatching(/^[a-f0-9]{64}$/),
				}),
				idempotencyKey: expect.stringMatching(/^coordinator-reap:idle-session:[a-f0-9]{64}$/),
			}),
		]);
		expect(await Bun.file(idleFile).exists()).toBe(false);
		expect(await Bun.file(path.join(sessionsDir, "registered-session.json")).exists()).toBe(true);
	});
	describe("Coordinator MCP real broker lifecycle", () => {
		for (const discoveryState of [
			"no discovery",
			"dead discovery",
			"stale discovery",
			"process incarnation mismatch",
			"malformed JSON",
			"canonical-shape-invalid readable discovery",
		] as const) {
			it(`boots and lists sessions with ${discoveryState}`, async () => {
				const root = await managedFixtureRoot();
				const agentDir = path.join(root, "agent-global");
				const cleanup = createFixtureRootCleanup(root, agentDir, ownerLease(agentDir));
				try {
					if (discoveryState === "malformed JSON") {
						await fs.mkdir(path.dirname(brokerDiscoveryPath(agentDir)), { recursive: true });
						await Bun.write(brokerDiscoveryPath(agentDir), "{not-json");
					} else if (discoveryState === "canonical-shape-invalid readable discovery") {
						await fs.mkdir(path.dirname(brokerDiscoveryPath(agentDir)), { recursive: true });
						await Bun.write(
							brokerDiscoveryPath(agentDir),
							JSON.stringify({ version: 1, protocolVersion: 3, host: "127.0.0.1", pid: process.pid }),
						);
					} else if (discoveryState !== "no discovery") {
						const actualIncarnation = brokerProcessIncarnation(process.pid);
						if (!actualIncarnation) throw new Error("Test process incarnation is unavailable.");
						await writeBrokerDiscovery(agentDir, {
							version: 1,
							protocolVersion: 3,
							packageGeneration: "test",
							ownerId: "stale-owner",
							pid: discoveryState === "dead discovery" ? 2_147_483_647 : process.pid,
							incarnation:
								discoveryState === "process incarnation mismatch"
									? "mismatched-incarnation"
									: actualIncarnation,
							host: "127.0.0.1",
							port: 1,
							url: "ws://127.0.0.1:1",
							token: "stale-token",
							startedAt: Date.now() - 60_000,
							heartbeatAt: discoveryState === "stale discovery" ? Date.now() - 60_000 : Date.now(),
						});
					}

					const result = await createRealBrokerServer(root, agentDir).callTool(
						"gjc_coordinator_list_sessions",
						{},
					);
					expect(result).toMatchObject({ ok: true, sessions: [] });
					const discovery = await readBrokerDiscovery(agentDir);
					expect(discovery).not.toBeNull();
					if (!discovery) throw new Error("Broker discovery was not published after bootstrap.");
					if (discoveryState !== "no discovery") expect(discovery.token).not.toBe("stale-token");
					expect(brokerOwnerForTest(agentDir)).toBeDefined();
				} finally {
					await cleanupFixtureRoot(cleanup);
					expect(brokerOwnerForTest(agentDir)).toBeUndefined();
				}
			}, 15_000);
		}

		it("reuses a live broker discovery without replacing its identity", async () => {
			const root = await managedFixtureRoot();
			const agentDir = path.join(root, "agent-global");
			const cleanup = createFixtureRootCleanup(root, agentDir, ownerLease(agentDir));
			try {
				const started = await startFixtureBrokerWithLeaseForTest({
					agentDir,
					env: createFixtureBrokerEnvironment(root, agentDir),
				});
				cleanup.lease = started.lease;
				const owner = brokerOwnerForTest(agentDir);
				expect(owner).toBeDefined();
				const result = await createRealBrokerServer(root, agentDir).callTool("gjc_coordinator_list_sessions", {});
				expect(result).toMatchObject({ ok: true, sessions: [] });
				const reused = await readBrokerDiscovery(agentDir);
				expect(reused).toMatchObject({
					pid: started.discovery.pid,
					incarnation: started.discovery.incarnation,
					ownerId: started.discovery.ownerId,
					token: started.discovery.token,
				});
				expect(brokerOwnerForTest(agentDir)).toBe(owner);
			} finally {
				await cleanupFixtureRoot(cleanup);
				expect(brokerOwnerForTest(agentDir)).toBeUndefined();
			}
		}, 15_000);

		it("routes concurrent first calls through one canonical broker owner", async () => {
			const root = await managedFixtureRoot();
			const agentDir = path.join(root, "agent-global");
			const cleanup = createFixtureRootCleanup(root, agentDir, ownerLease(agentDir));
			try {
				const server = createRealBrokerServer(root, agentDir);
				const results = await Promise.all([
					server.callTool("gjc_coordinator_list_sessions", {}),
					server.callTool("gjc_coordinator_list_sessions", {}),
				]);
				expect(results).toEqual([
					{ ok: true, sessions: [] },
					{ ok: true, sessions: [] },
				]);
				const owner = brokerOwnerForTest(agentDir);
				expect(owner).toBeDefined();
				const discovery = await readBrokerDiscovery(agentDir);
				expect(discovery).not.toBeNull();
				await expect(server.callTool("gjc_coordinator_list_sessions", {})).resolves.toMatchObject({
					ok: true,
					sessions: [],
				});
				expect(brokerOwnerForTest(agentDir)).toBe(owner);
			} finally {
				await cleanupFixtureRoot(cleanup);
				expect(brokerOwnerForTest(agentDir)).toBeUndefined();
			}
		}, 15_000);
	});

	it("ensures before re-reading broker discovery", async () => {
		const root = await tempRoot();
		const phases: string[] = [];
		const server = createBrokerTestServer(root, {
			ensureBroker: async settings => {
				phases.push(`ensure:${settings.agentDir}`);
				return testBrokerDiscovery();
			},
			readSdkBrokerDiscovery: async agentDir => {
				phases.push(`read:${agentDir}`);
				return testBrokerDiscovery();
			},
			connectSdk: async () => {
				phases.push("connect");
				return {
					global: async () => ({ ok: true, result: { sessions: [] } }),
					close: async () => {},
				} as unknown as SdkClient;
			},
		});
		await expect(server.callTool("gjc_coordinator_list_sessions", {})).resolves.toMatchObject({
			ok: true,
			sessions: [],
		});
		expect(phases).toEqual([
			`ensure:${path.join(root, "agent-global")}`,
			`read:${path.join(root, "agent-global")}`,
			"connect",
		]);
	});

	it("routes concurrent broker operations through the canonical ensure seam", async () => {
		const root = await tempRoot();
		let starts = 0;
		let inFlight: Promise<BrokerDiscovery> | undefined;
		const server = createBrokerTestServer(root, {
			ensureBroker: async () => {
				inFlight ??= Promise.resolve().then(() => {
					starts += 1;
					return testBrokerDiscovery();
				});
				return await inFlight;
			},
			readSdkBrokerDiscovery: async () => testBrokerDiscovery(),
			connectSdk: async () =>
				({
					global: async () => ({ ok: true, result: { sessions: [] } }),
					close: async () => {},
				}) as unknown as SdkClient,
		});
		await expect(
			Promise.all([
				server.callTool("gjc_coordinator_list_sessions", {}),
				server.callTool("gjc_coordinator_list_sessions", {}),
			]),
		).resolves.toEqual([
			{ ok: true, sessions: [] },
			{ ok: true, sessions: [] },
		]);
		expect(starts).toBe(1);
	});

	it("maps injected broker failures by the explicit operational phase", async () => {
		const root = await tempRoot();
		const cases: Array<{
			stage: "ensure" | "read" | "connect" | "request";
			error: Error;
			code: string;
			message?: string;
		}> = [
			{ stage: "ensure", error: new AggregateError([new Error("token-secret")]), code: "broker_cleanup_unverified" },
			{
				stage: "ensure",
				error: new UnsupportedStateVersionError("/secret/path", 2),
				code: "broker_discovery_unsupported",
			},
			{
				stage: "ensure",
				error: Object.assign(new Error("secret"), { code: "EACCES" }),
				code: "broker_discovery_access_denied",
			},
			{
				stage: "ensure",
				error: Object.assign(new Error("secret"), { code: "EPERM" }),
				code: "broker_discovery_access_denied",
			},
			{ stage: "ensure", error: new Error("token-secret"), code: "broker_bootstrap_failed" },
			{
				stage: "read",
				error: new UnsupportedStateVersionError("/secret/path", 2),
				code: "broker_discovery_unsupported",
			},
			{
				stage: "read",
				error: Object.assign(new Error("secret"), { code: "EACCES" }),
				code: "broker_discovery_access_denied",
			},
			{
				stage: "read",
				error: Object.assign(new Error("secret"), { code: "EPERM" }),
				code: "broker_discovery_access_denied",
			},
			{
				stage: "read",
				error: new AggregateError([new Error("token-secret")]),
				code: "broker_discovery_unavailable",
			},
			{ stage: "read", error: new Error("token-secret"), code: "broker_discovery_unavailable" },
			{
				stage: "connect",
				error: new AggregateError([new Error("token-secret")]),
				code: "broker_transport_unavailable",
			},
			{
				stage: "connect",
				error: new UnsupportedStateVersionError("/secret/path", 2),
				code: "broker_transport_unavailable",
			},
			{
				stage: "connect",
				error: Object.assign(new Error("secret"), { code: "EACCES" }),
				code: "broker_transport_unavailable",
			},
			{
				stage: "connect",
				error: new SdkClientError("transport_secret", "token-secret"),
				code: "broker_transport_unavailable",
			},
			{
				stage: "request",
				error: new AggregateError([new Error("token-secret")]),
				code: "broker_request_unavailable",
			},
			{
				stage: "request",
				error: new UnsupportedStateVersionError("/secret/path", 2),
				code: "broker_request_unavailable",
			},
			{
				stage: "request",
				error: Object.assign(new Error("secret"), { code: "EACCES" }),
				code: "broker_request_unavailable",
			},
			{ stage: "request", error: new Error("token-secret"), code: "broker_request_unavailable" },
			{
				stage: "request",
				error: new SdkClientError("transport_secret", "request public message"),
				code: "transport_secret",
				message: "request public message",
			},
		];
		for (const testCase of cases) {
			const client = {
				global: async () => {
					if (testCase.stage === "request") throw testCase.error;
					return { ok: true, result: { sessions: [] } };
				},
				close: async () => {},
			} as unknown as SdkClient;
			const server = createBrokerTestServer(root, {
				ensureBroker: async () => {
					if (testCase.stage === "ensure") throw testCase.error;
					return testBrokerDiscovery();
				},
				readSdkBrokerDiscovery: async () => {
					if (testCase.stage === "read") throw testCase.error;
					return testBrokerDiscovery();
				},
				connectSdk: async () => {
					if (testCase.stage === "connect") throw testCase.error;
					return client;
				},
			});
			const result = await server.callTool("gjc_coordinator_list_sessions", {});
			expect(result).toMatchObject({ ok: false, error: { code: testCase.code } });
			if (testCase.message) expect(result).toMatchObject({ error: { message: testCase.message } });
			expect(JSON.stringify(result)).not.toContain("token-secret");
			expect(JSON.stringify(result)).not.toContain("/secret/path");
		}
		const nullServer = createBrokerTestServer(root, {
			ensureBroker: async () => testBrokerDiscovery(),
			readSdkBrokerDiscovery: async () => null,
			connectSdk: async () =>
				({ global: async () => ({ ok: true }), close: async () => {} }) as unknown as SdkClient,
		});
		await expect(nullServer.callTool("gjc_coordinator_list_sessions", {})).resolves.toMatchObject({
			ok: false,
			error: { code: "broker_unavailable", message: "SDK broker is unavailable after bootstrap." },
		});
	});

	it("attempts close once and preserves the primary request failure", async () => {
		const root = await tempRoot();
		for (const requestError of [
			new SdkClientError("request_failed", "request public message"),
			new Error("request-secret"),
		]) {
			let closeCalls = 0;
			const server = createBrokerTestServer(root, {
				ensureBroker: async () => testBrokerDiscovery(),
				readSdkBrokerDiscovery: async () => testBrokerDiscovery(),
				connectSdk: async () =>
					({
						global: async () => {
							throw requestError;
						},
						close: async () => {
							closeCalls += 1;
							throw new Error("close-secret");
						},
					}) as unknown as SdkClient,
			});
			const result = await server.callTool("gjc_coordinator_list_sessions", {});
			expect(result).toMatchObject({
				ok: false,
				error: { code: requestError instanceof SdkClientError ? "request_failed" : "broker_request_unavailable" },
			});
			expect(closeCalls).toBe(1);
		}
		let closeCalls = 0;
		const closeFailureServer = createBrokerTestServer(root, {
			ensureBroker: async () => testBrokerDiscovery(),
			readSdkBrokerDiscovery: async () => testBrokerDiscovery(),
			connectSdk: async () =>
				({
					global: async () => ({ ok: true, result: { sessions: [] } }),
					close: async () => {
						closeCalls += 1;
						throw new SdkClientError("close_secret", "close-secret");
					},
				}) as unknown as SdkClient,
		});
		await expect(closeFailureServer.callTool("gjc_coordinator_list_sessions", {})).resolves.toMatchObject({
			ok: false,
			error: { code: "broker_transport_unavailable", message: "SDK broker transport is unavailable." },
		});
		expect(closeCalls).toBe(1);
	});
});

it("repairs one terminal session without deleting another session's projections", async () => {
	const root = await tempRoot();
	const controls: SdkControl[] = [];
	const sessions = [
		{
			sessionId: "visible-session",
			locator: { repo: root },
			live: true,
			endpointGeneration: 1,
			pid: 101,
			endpointMtimeMs: 1,
		},
		{
			sessionId: "other-session",
			locator: { repo: root },
			live: true,
			endpointGeneration: 1,
			pid: 102,
			endpointMtimeMs: 1,
		},
	];
	const server = await createSdkControlServer(root, controls, undefined, undefined, sessions);
	await registerSdkSession(server, root);
	await expect(
		server.callTool("gjc_coordinator_register_session", {
			session_id: "other-session",
			cwd: root,
			idempotency_key: "register-other",
			allow_mutation: true,
		}),
	).resolves.toMatchObject({ ok: true });
	const first = await server.callTool("gjc_coordinator_send_prompt", {
		session_id: "visible-session",
		prompt: "first",
		idempotency_key: "prompt-first-session",
		allow_mutation: true,
	});
	const second = await server.callTool("gjc_coordinator_send_prompt", {
		session_id: "other-session",
		prompt: "second",
		idempotency_key: "prompt-second-session",
		allow_mutation: true,
	});
	await expect(
		server.callTool("gjc_coordinator_report_status", {
			session_id: "visible-session",
			turn_id: first.turn_id,
			status: "completed",
			summary: "done",
			idempotency_key: "complete-first-session",
			allow_mutation: true,
		}),
	).resolves.toMatchObject({ ok: true });
	const secondTurnPath = path.join(
		root,
		".gjc",
		"coordinator-state",
		"local",
		"repo",
		"turns",
		`${String(second.turn_id)}.json`,
	);
	await expect(fs.readFile(secondTurnPath, "utf8")).resolves.toContain("other-session");
});
