import { describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Agent } from "@gajae-code/agent-core";
import { getBundledModel } from "@gajae-code/ai";
import { AssistantMessageEventStream } from "@gajae-code/ai/utils/event-stream";
import { ModelRegistry } from "../src/config/model-registry";
import { Settings } from "../src/config/settings";
import {
	boundedRuntimePromptAckTimeoutMs,
	COORDINATOR_RUNTIME_PROMPT_ACK_TIMEOUT_MAX_MS,
	createCoordinatorMcpServer,
} from "../src/coordinator-mcp/server";
import {
	GJC_COORDINATOR_SESSION_ID_ENV,
	GJC_COORDINATOR_SESSION_STATE_FILE_ENV,
} from "../src/gjc-runtime/session-state-sidecar";
import { processIncarnation } from "../src/sdk/broker/process-incarnation";
import type { SdkClient } from "../src/sdk/client/client";
import { AgentSession } from "../src/session/agent-session";
import { AuthStorage } from "../src/session/auth-storage";
import { SessionManager } from "../src/session/session-manager";
import { createAssistantMessage } from "./helpers/agent-session-setup";

async function waitFor(predicate: () => boolean, label: string): Promise<void> {
	const deadline = Date.now() + 4_000;
	while (!predicate()) {
		if (Date.now() > deadline) throw new Error(`Timed out waiting for ${label}`);
		await Bun.sleep(10);
	}
}

async function readState(stateFile: string): Promise<Record<string, unknown>> {
	return JSON.parse(await fsp.readFile(stateFile, "utf8")) as Record<string, unknown>;
}
describe("Coordinator MCP runtime readiness", () => {
	it("bounds runtime acknowledgement waits independently of caller input", () => {
		expect(boundedRuntimePromptAckTimeoutMs(250)).toBe(250);
		expect(boundedRuntimePromptAckTimeoutMs(3_600_000)).toBe(COORDINATOR_RUNTIME_PROMPT_ACK_TIMEOUT_MAX_MS);
	});

	it("does not publish terminal runtime state until prompt and event-handler cleanup settle", async () => {
		const cwd = await fsp.mkdtemp(path.join(os.tmpdir(), "gjc-coordinator-runtime-idle-"));
		const stateFile = path.join(cwd, "runtime-state.json");
		const authStorage = await AuthStorage.create(path.join(cwd, "auth.db"));
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected bundled model");
		authStorage.setRuntimeApiKey("anthropic", "test-key");
		const stream = new AssistantMessageEventStream();
		const messageEndBarrier = Promise.withResolvers<void>();
		let messageEndHandlerStarted = false;
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] },
			streamFn: (_model, _context, options) => {
				queueMicrotask(() => {
					stream.push({ type: "start", partial: createAssistantMessage("") });
				});
				options?.signal?.addEventListener(
					"abort",
					() => stream.push({ type: "error", reason: "aborted", error: createAssistantMessage("Aborted") }),
					{ once: true },
				);
				return stream;
			},
		});
		const extensionRunner = {
			emitBeforeAgentStart: async () => undefined,
			hasHandlers: () => false,
			emit: async (event: { type: string }) => {
				if (event.type !== "message_end") return;
				messageEndHandlerStarted = true;
				await messageEndBarrier.promise;
			},
		};
		const session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings: Settings.isolated(),
			modelRegistry: new ModelRegistry(authStorage, path.join(cwd, "models.yml")),
			extensionRunner: extensionRunner as never,
		});
		const previousStateFile = process.env[GJC_COORDINATOR_SESSION_STATE_FILE_ENV];
		const previousSessionId = process.env[GJC_COORDINATOR_SESSION_ID_ENV];
		process.env[GJC_COORDINATOR_SESSION_STATE_FILE_ENV] = stateFile;
		process.env[GJC_COORDINATOR_SESSION_ID_ENV] = session.sessionId;
		try {
			const prompt = session.prompt("hold open");
			await waitFor(() => session.isStreaming && fs.existsSync(stateFile), "running runtime state");
			session.agent.emitExternalEvent({
				type: "message_end",
				message: createAssistantMessage("wait for extension cleanup"),
			});
			await waitFor(() => messageEndHandlerStarted, "message_end extension handler");

			await session.abort();
			await Bun.sleep(25);
			expect((await readState(stateFile)).state).toBe("running");
			// The provider stream may have stopped already; readiness is the durable
			// terminal state, which must remain running until the handler barrier clears.

			messageEndBarrier.resolve();
			await prompt.catch(() => {});
			await waitFor(() => {
				if (!fs.existsSync(stateFile)) return false;
				const state = JSON.parse(fs.readFileSync(stateFile, "utf8")) as { state?: unknown };
				return state.state === "completed" || state.state === "errored";
			}, "terminal runtime state");
		} finally {
			messageEndBarrier.resolve();
			if (previousStateFile === undefined) delete process.env[GJC_COORDINATOR_SESSION_STATE_FILE_ENV];
			else process.env[GJC_COORDINATOR_SESSION_STATE_FILE_ENV] = previousStateFile;
			if (previousSessionId === undefined) delete process.env[GJC_COORDINATOR_SESSION_ID_ENV];
			else process.env[GJC_COORDINATOR_SESSION_ID_ENV] = previousSessionId;
			await session.dispose();
			authStorage.close();
			await fsp.rm(cwd, { recursive: true, force: true });
		}
	});

	it("satisfies mandatory broker owner and workspace grant authority on production lifecycle calls", async () => {
		const cwd = await fsp.realpath(await fsp.mkdtemp(path.join(os.tmpdir(), "gjc-coordinator-auth-")));
		const agentDir = path.join(cwd, "agent-global");
		const stateRoot = path.join(cwd, ".gjc", "coordinator-state");
		await fsp.mkdir(path.join(agentDir, "sdk"), { recursive: true });
		await fsp.mkdir(path.join(cwd, ".gjc", "state", "sdk"), { recursive: true });

		// Strict broker: rejects any request whose brokerOwnerId is not the exact current
		// discovery owner, and rejects cwd-bearing lifecycle calls lacking a grant + {dev,ino}
		// obtained from a prior scoped session.list. Mirrors the production broker admission.
		let owner = "owner-v1";
		const grants = new Map<string, { dev: string; ino: string }>();
		const brokerSessions: Array<Record<string, unknown>> = [];
		const discoveryPath = path.join(agentDir, "sdk", "broker.json");
		const brokerIncarnation = processIncarnation(process.pid);
		if (!brokerIncarnation) throw new Error("Expected current process incarnation for broker discovery fixture.");
		const writeDiscovery = async () =>
			Bun.write(
				discoveryPath,
				JSON.stringify({
					version: 1,
					protocolVersion: 3,
					packageGeneration: "test",
					ownerId: owner,
					pid: process.pid,
					incarnation: brokerIncarnation,
					host: "127.0.0.1",
					port: 1,
					url: "ws://broker.test",
					token: "broker-secret",
					startedAt: Date.now(),
					heartbeatAt: Date.now(),
				}),
			);
		await writeDiscovery();

		let created = 0;
		const server = createCoordinatorMcpServer({
			env: {
				GJC_COORDINATOR_MCP_WORKDIR_ROOTS: cwd,
				GJC_COORDINATOR_MCP_STATE_ROOT: stateRoot,
				GJC_COORDINATOR_MCP_MUTATIONS: "sessions,questions,reports",
				GJC_COORDINATOR_MCP_PROFILE: "local",
				GJC_COORDINATOR_MCP_REPO: "repo",
			},
			services: {
				getAgentDir: () => agentDir,
				resolveModelProfiles: () => new Map(),
				connectSdk: async () =>
					({
						global: async (operation: string, input: Record<string, unknown>) => {
							if (input.brokerOwnerId !== owner)
								return {
									ok: false,
									error: { code: "endpoint_stale", message: "broker boot authority is stale" },
								};
							if (operation === "session.list") {
								const listCwd = typeof input.cwd === "string" ? input.cwd : undefined;
								if (!listCwd) return { ok: true, result: { sessions: brokerSessions } };
								const grantId = `grant:${listCwd}:${owner}`;
								grants.set(grantId, { dev: "1", ino: "1" });
								return {
									ok: true,
									result: {
										sessions: brokerSessions,
										workspaceGrantId: grantId,
										workspaceIdentity: { dev: "1", ino: "1" },
									},
								};
							}
							if (operation === "session.get_endpoint")
								return { ok: true, result: { url: "ws://sdk.test/ep", token: "Bearer ep" } };
							if (operation === "session.close") {
								const index = brokerSessions.findIndex(session => session.sessionId === input.sessionId);
								if (index >= 0) brokerSessions.splice(index, 1);
								return { ok: true, result: { sessionId: input.sessionId } };
							}
							if (operation === "session.create") {
								const grantId = typeof input.workspaceGrantId === "string" ? input.workspaceGrantId : "";
								const identity = input.workspaceIdentity as { dev?: string; ino?: string } | undefined;
								const grant = grants.get(grantId);
								if (!grant || !identity || identity.dev !== grant.dev || identity.ino !== grant.ino)
									return {
										ok: false,
										error: { code: "endpoint_stale", message: "workspace grant is stale or missing" },
									};
								const sessionId = `session-${++created}`;
								await Bun.write(
									path.join(cwd, ".gjc", "state", "sdk", `${sessionId}.json`),
									JSON.stringify({ url: "ws://sdk.test", token: "session-token" }),
								);
								brokerSessions.push({
									sessionId,
									locator: { repo: cwd },
									live: true,
									endpointGeneration: 1,
									pid: 100 + created,
									endpointMtimeMs: created,
								});
								return { ok: true, result: { sessionId } };
							}
							return { ok: true, result: {} };
						},
						control: async () => ({ accepted: true, command_id: "c", turn_id: "t" }),
						query: async () => ({
							type: "query_response",
							id: "q",
							ok: true,
							page: { items: [], complete: true, revision: "r" },
						}),
						close: async () => {},
					}) as unknown as SdkClient,
			},
		});

		// create (cwd-bearing) carries the owner proof and the grant + {dev,ino} from a
		// scoped session.list; a strict broker that rejects missing authority accepts it.
		const started = await server.callTool("gjc_coordinator_start_session", {
			cwd,
			idempotency_key: "auth-create",
			allow_mutation: true,
		});
		expect(started).toMatchObject({ ok: true, session: { session_id: "session-1" } });

		// The exact current discovery.ownerId is re-read per call: rotating the broker owner
		// flips the injected proof, and the strict broker still accepts the new owner.
		owner = "owner-v2";
		await writeDiscovery();
		const startedAgain = await server.callTool("gjc_coordinator_start_session", {
			cwd,
			idempotency_key: "auth-create-v2",
			allow_mutation: true,
		});
		expect(startedAgain).toMatchObject({ ok: true, session: { session_id: "session-2" } });

		// close (non-cwd-bearing) carries only the owner proof and is accepted by the strict broker.
		const sessionFile = path.join(stateRoot, "local", "repo", "sessions", "session-1.json");
		const record = JSON.parse(await fsp.readFile(sessionFile, "utf8"));
		await Bun.write(
			sessionFile,
			JSON.stringify({ ...record, ephemeral: true, created_at: new Date(Date.now() - 31 * 60_000).toISOString() }),
		);
		const stopped = await server.callTool("gjc_coordinator_stop_session", {
			session_id: "session-1",
			allow_mutation: true,
		});
		expect(stopped).toMatchObject({ ok: true, closed: true, session_id: "session-1" });

		await fsp.rm(cwd, { recursive: true, force: true });
	});
});
