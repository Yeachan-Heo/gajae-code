import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { getAgentDir, setAgentDir } from "@gajae-code/utils";
import McpServe, {
	buildCoordinatorCheckPayload,
	type CoordinatorBrokerObservation,
	formatCoordinatorCheckPayload,
	probeCoordinatorBrokerCheck,
} from "../src/commands/mcp-serve";
import {
	COORDINATOR_MCP_PROTOCOL_VERSION,
	COORDINATOR_MCP_SERVER_NAME,
	COORDINATOR_MCP_TOOL_NAMES,
} from "../src/coordinator/contract";
import {
	assertCloseAdmission,
	coordinatorStatePaths,
	createSessionTransaction,
	initializeCoordinatorNamespace,
	withNamespaceRegistry,
} from "../src/coordinator-mcp/question-state";
import { createCoordinatorMcpServer, handleCoordinatorMcpRequest } from "../src/coordinator-mcp/server";
import { brokerDiscoveryPath, brokerProcessIncarnation, writeBrokerDiscovery } from "../src/sdk/broker/discovery";
import { brokerOwnerForTest } from "../src/sdk/broker/ensure";
import { UnsupportedStateVersionError } from "../src/sdk/broker/state-version";
import { SDK_MCP_TOOL_NAMES } from "../src/sdk/mcp/server";

async function withTempRoot(run: (root: string) => Promise<void>): Promise<void> {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-coordinator-mcp-"));
	try {
		await run(root);
	} finally {
		await fs.rm(root, { recursive: true, force: true });
	}
}

async function captureMcpServeCheck(argv: string[]): Promise<string> {
	let stdout = "";
	const write = process.stdout.write;
	const exitCode = process.exitCode;
	process.stdout.write = ((chunk: string | Uint8Array) => {
		stdout += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString();
		return true;
	}) as typeof process.stdout.write;
	try {
		await new McpServe(argv, { bin: "gjc", version: "test", commands: new Map() }).run();
		return stdout;
	} finally {
		process.stdout.write = write;
		process.exitCode = exitCode;
	}
}

async function withAgentDir<T>(agentDir: string, run: () => Promise<T>): Promise<T> {
	const previous = getAgentDir();
	setAgentDir(agentDir);
	try {
		return await run();
	} finally {
		setAgentDir(previous);
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

	it("requires the complete public question-answer correlation tuple", async () => {
		await withTempRoot(async root => {
			const response = await handleCoordinatorMcpRequest(
				{ jsonrpc: "2.0", id: 3, method: "tools/list" },
				{ env: { GJC_COORDINATOR_MCP_WORKDIR_ROOTS: root } },
			);
			const tool = response.result.tools.find(
				(candidate: { name: string }) => candidate.name === "gjc_coordinator_submit_question_answer",
			);
			expect(tool.inputSchema.required).toEqual(
				expect.arrayContaining([
					"session_id",
					"turn_id",
					"question_id",
					"answer_binding",
					"answer",
					"idempotency_key",
					"allow_mutation",
				]),
			);
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

describe("coordinator and hermes check contract", () => {
	const discovery = {
		version: 1,
		protocolVersion: 3,
		packageGeneration: "test-generation",
		ownerId: "owner-secret",
		pid: 987654321,
		incarnation: "incarnation-secret",
		host: "127.0.0.1",
		port: 54321,
		url: "ws://127.0.0.1:54321/secret-token",
		token: "secret-token",
		startedAt: 1,
		heartbeatAt: 2,
	} as const;

	it("builds the frozen additive, redacted coordinator and hermes JSON payload", async () => {
		const coordinator = await buildCoordinatorCheckPayload({ readBrokerDiscovery: async () => discovery });
		const hermes = await buildCoordinatorCheckPayload({ readBrokerDiscovery: async () => discovery });

		expect(coordinator).toEqual(hermes);
		expect(coordinator).toEqual({
			ok: true,
			server: { name: COORDINATOR_MCP_SERVER_NAME, protocolVersion: COORDINATOR_MCP_PROTOCOL_VERSION },
			readOnly: true,
			tools: [...COORDINATOR_MCP_TOOL_NAMES],
			catalog: { ready: true, reason: null },
			broker: {
				discovery_status: "ready",
				reason: null,
				operational_ready: null,
				bootstrap_supported: true,
				bootstrap_attempted: false,
			},
		});
		const serialized = JSON.stringify(coordinator);
		for (const secret of [
			discovery.url,
			discovery.token,
			discovery.ownerId,
			discovery.incarnation,
			String(discovery.pid),
			String(discovery.port),
		])
			expect(serialized).not.toContain(secret);
	});

	it("classifies every raw discovery result without exposing errors", async () => {
		const cases: Array<{
			name: string;
			readBrokerDiscovery: () => Promise<typeof discovery | null>;
			expected: CoordinatorBrokerObservation;
		}> = [
			{
				name: "unavailable",
				readBrokerDiscovery: async () => null,
				expected: { discovery_status: "unavailable", reason: "absent_or_invalid" },
			},
			{
				name: "unsupported state version",
				readBrokerDiscovery: async () => {
					throw new UnsupportedStateVersionError("/private/broker.json", 99);
				},
				expected: { discovery_status: "error", reason: "unsupported_state_version" },
			},
			{
				name: "access denied",
				readBrokerDiscovery: async () => {
					throw Object.assign(new Error("/private/broker.json"), { code: "EACCES" });
				},
				expected: { discovery_status: "error", reason: "discovery_access_denied" },
			},
			{
				name: "permission denied",
				readBrokerDiscovery: async () => {
					throw Object.assign(new Error("/private/broker.json"), { code: "EPERM" });
				},
				expected: { discovery_status: "error", reason: "discovery_access_denied" },
			},
			{
				name: "read failure",
				readBrokerDiscovery: async () => {
					throw new Error("private failure detail");
				},
				expected: { discovery_status: "error", reason: "discovery_read_failed" },
			},
		];

		for (const testCase of cases) {
			const observation = await probeCoordinatorBrokerCheck({ readBrokerDiscovery: testCase.readBrokerDiscovery });
			expect(observation, testCase.name).toEqual(testCase.expected);
			expect(JSON.stringify(formatCoordinatorCheckPayload(observation))).not.toContain("/private/broker.json");
		}
	});

	it("observes discovery once without attempting bootstrap or transport work", async () => {
		let reads = 0;
		const payload = await buildCoordinatorCheckPayload({
			agentDir: "/private/agent-dir",
			readBrokerDiscovery: async agentDir => {
				reads++;
				expect(agentDir).toBe("/private/agent-dir");
				return null;
			},
		});

		expect(reads).toBe(1);
		expect(payload.broker).toEqual({
			discovery_status: "unavailable",
			reason: "absent_or_invalid",
			operational_ready: null,
			bootstrap_supported: true,
			bootstrap_attempted: false,
		});
	});
});

describe("mcp serve check command compatibility", () => {
	it("keeps coordinator and hermes JSON additive, SDK JSON stable, and human checks discovery-free", async () => {
		await withTempRoot(async root => {
			const agentDir = path.join(root, "broker-path-sentinel-authority-error-sentinel");
			await withAgentDir(agentDir, async () => {
				expect(await Bun.file(brokerDiscoveryPath(agentDir)).exists()).toBe(false);
				const coordinator = JSON.parse(await captureMcpServeCheck(["coordinator", "--check", "--json"]));
				const hermes = JSON.parse(await captureMcpServeCheck(["hermes", "--check", "--json"]));
				const sdk = JSON.parse(await captureMcpServeCheck(["sdk", "--check", "--json"]));

				expect(coordinator).toEqual(hermes);
				expect(coordinator).toEqual({
					ok: true,
					server: { name: COORDINATOR_MCP_SERVER_NAME, protocolVersion: COORDINATOR_MCP_PROTOCOL_VERSION },
					readOnly: true,
					tools: [...COORDINATOR_MCP_TOOL_NAMES],
					catalog: { ready: true, reason: null },
					broker: {
						discovery_status: "unavailable",
						reason: "absent_or_invalid",
						operational_ready: null,
						bootstrap_supported: true,
						bootstrap_attempted: false,
					},
				});
				expect(sdk).toEqual({
					ok: true,
					server: { name: "gjc-sdk-mcp" },
					readOnly: false,
					tools: [...SDK_MCP_TOOL_NAMES],
				});
				await fs.mkdir(brokerDiscoveryPath(agentDir), { recursive: true });
				expect(await captureMcpServeCheck(["coordinator", "--check"])).toBe(
					`server: ${COORDINATOR_MCP_SERVER_NAME}\ntools: ${COORDINATOR_MCP_TOOL_NAMES.length}\n`,
				);
				expect(await captureMcpServeCheck(["hermes", "--check"])).toBe(
					`server: ${COORDINATOR_MCP_SERVER_NAME}\ntools: ${COORDINATOR_MCP_TOOL_NAMES.length}\n`,
				);
				expect(await captureMcpServeCheck(["sdk", "--check"])).toBe(
					`server: gjc-sdk-mcp\ntools: ${SDK_MCP_TOOL_NAMES.length}\n`,
				);
				expect(brokerOwnerForTest(agentDir)).toBeUndefined();
				for (const output of [JSON.stringify(coordinator), JSON.stringify(hermes), JSON.stringify(sdk)]) {
					expect(output).not.toContain(agentDir);
					expect(output).not.toContain("authority-error-sentinel");
				}
			});
		});
	});

	it("reads a valid broker discovery without mutating its portable file snapshot", async () => {
		await withTempRoot(async root => {
			const agentDir = path.join(root, "agent-dir");
			const incarnation = brokerProcessIncarnation(process.pid);
			if (!incarnation) throw new Error("Test process incarnation is unavailable.");
			await writeBrokerDiscovery(agentDir, {
				version: 1,
				protocolVersion: 3,
				packageGeneration: "snapshot-test",
				ownerId: "authority-sentinel",
				pid: process.pid,
				incarnation,
				host: "127.0.0.1",
				port: 54321,
				url: "ws://127.0.0.1:54321/error-sentinel",
				token: "token-sentinel",
				startedAt: Date.now(),
				heartbeatAt: Date.now(),
			});
			const discoveryFile = brokerDiscoveryPath(agentDir);
			const bytes = await fs.readFile(discoveryFile);
			const before = await fs.stat(discoveryFile);

			await withAgentDir(agentDir, async () => {
				const output = await captureMcpServeCheck(["coordinator", "--check", "--json"]);
				expect(JSON.parse(output)).toMatchObject({
					ok: true,
					broker: { discovery_status: "ready", reason: null },
				});
				for (const sentinel of [agentDir, "authority-sentinel", "error-sentinel", "token-sentinel"])
					expect(output).not.toContain(sentinel);
			});

			const after = await fs.stat(discoveryFile);
			expect(await fs.readFile(discoveryFile)).toEqual(bytes);
			expect(after.size).toBe(before.size);
			expect(after.mtimeMs).toBe(before.mtimeMs);
			if (before.mode !== 0) expect(after.mode).toBe(before.mode);
			if (before.dev !== 0 && before.ino !== 0) {
				expect(after.dev).toBe(before.dev);
				expect(after.ino).toBe(before.ino);
			}
			expect(brokerOwnerForTest(agentDir)).toBeUndefined();
		});
	});
});

describe("coordinator question-state direct contracts", () => {
	it("persists the creation-session snapshot and rejects post-close admissions", async () => {
		await withTempRoot(async root => {
			const paths = coordinatorStatePaths(path.join(root, "state"), "namespace-2550");
			await initializeCoordinatorNamespace(paths);
			const session = {
				schema_version: 1 as const,
				namespace_id: "namespace-2550",
				session_id: "session-2550",
				cwd: root,
				created_at: "2026-07-17T00:00:00.000Z",
				updated_at: "2026-07-17T00:00:00.000Z",
				mpreset: null,
				source: "coordinator",
				model: null,
				tmux: { session: null, window: null, pane: null },
				broker: {
					workspace: root,
					endpoint_url: "ws://private.example.test",
					endpoint_generation: 1,
					endpoint_incarnation: "incarnation-1",
				},
				ephemeral: false,
				visible: true,
			};
			const transaction = await createSessionTransaction(paths, {
				kind: "register",
				session,
				initial_state: "ready_for_input",
				initial_events: [],
			});
			expect(transaction.canonical.session).toEqual(session);
			await withNamespaceRegistry(paths, async registry => {
				registry.deletions["close-2550"] = {
					deletion_id: "close-2550",
					session_id: session.session_id,
					endpoint_incarnation: session.broker.endpoint_incarnation,
					operation_id: "operation-2550",
					key_digest: "key",
					request_digest: "request",
					close_key: "close",
					phase: "intent",
					cleanup: { wal: false, turns: false, reports: false, session: false, events: false },
					authority_digest: "authority",
					created_at: session.created_at,
					updated_at: session.updated_at,
				};
				expect(() => assertCloseAdmission(registry, transaction)).toThrow("session_closing");
				registry.deletions["close-2550"].phase = "completed";
				expect(() => assertCloseAdmission(registry, transaction)).toThrow("session_closing");
			});
		});
	});
});
