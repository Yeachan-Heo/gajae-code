import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { createCoordinatorMcpServer } from "../../src/coordinator-mcp/server";
import type { BrokerDiscovery } from "../../src/sdk/broker/discovery";
import { brokerProcessIncarnation, writeBrokerDiscovery } from "../../src/sdk/broker/discovery";
import type { SessionIndex } from "../../src/sdk/broker/session-index";
import type { SessionRouterClient } from "../../src/sdk/router";
import { prepareExactSessionAuthority } from "../helpers/sdk-exact-session-authority";

async function withTempRoot(run: (root: string) => Promise<void>): Promise<void> {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-coord-race-"));
	try {
		await run(root);
	} finally {
		await fs.rm(root, { recursive: true, force: true });
	}
}

/**
 * Regression for the #1964 blocker: concurrent stdio dispatch let two same-session
 * `send_prompt` calls interleave their read-active-turn → write-new-turn, persisting two
 * "active" turns while only one active-turn pointer survived. The per-session mutation lock
 * must restore the atomicity the former serial read loop provided.
 */
describe("send_prompt same-session concurrency", () => {
	it("serializes concurrent same-session send_prompts to a single active turn", async () => {
		await withTempRoot(async root => {
			const sessionId = "sdk-race-session";
			const brokerUrl = "ws://127.0.0.1:4312";
			const sessionUrl = "ws://127.0.0.1:4313";
			const agentDir = path.join(root, "agent-global");
			const brokerSessions: Array<Record<string, unknown>> = [];
			const brokerDiscovery = {
				version: 1,
				protocolVersion: 3,
				packageGeneration: "test",
				ownerId: "test-owner",
				pid: process.pid,
				incarnation: brokerProcessIncarnation(process.pid) ?? "test-incarnation",
				host: "127.0.0.1",
				port: 4312,
				url: brokerUrl,
				token: "broker-token",
				startedAt: Date.now(),
				heartbeatAt: Date.now(),
			} satisfies BrokerDiscovery;
			await writeBrokerDiscovery(agentDir, brokerDiscovery);
			const authority = await prepareExactSessionAuthority({
				agentDir,
				cwd: root,
				sessionId,
				url: sessionUrl,
				token: "session-token",
			});

			const server = await createCoordinatorMcpServer({
				env: {
					GJC_COORDINATOR_MCP_WORKDIR_ROOTS: root,
					GJC_COORDINATOR_MCP_MUTATIONS: "sessions,questions,reports",
					GJC_COORDINATOR_MCP_STATE_ROOT: path.join(root, ".state"),
					GJC_COORDINATOR_MCP_PROFILE: "race-controller",
					GJC_COORDINATOR_MCP_REPO: "repo-race",
				},
				services: {
					getAgentDir: () => agentDir,
					ensureBroker: async () => brokerDiscovery,
					readSdkBrokerDiscovery: async () => brokerDiscovery,
					connectBroker: async () =>
						({
							global: async (operation: string, input: Record<string, unknown>) => {
								if (operation === "session.create") {
									brokerSessions.push({
										sessionId,
										locator: { repo: root },
										live: true,
										endpointGeneration: 1,
										pid: authority.pid,
										endpointMtimeMs: authority.endpointMtimeMs,
									});
									// The creation verifier reconciliation (#4731) requires the
									// broker to prove which sidecar key became runtime authority.
									return {
										ok: true,
										result: {
											sessionId,
											coordinatorSidecarKeyId: input.coordinatorSidecarKeyId,
										},
									};
								}
								if (operation === "session.list") return { ok: true, result: { sessions: brokerSessions } };
								throw new Error(`unexpected broker operation: ${operation} ${JSON.stringify(input)}`);
							},
							close: async () => {},
						}) as never,
					routerDeps: {
						createIndex: () =>
							({
								open: async () => {},
								refresh: async () => {},
								refreshIfChanged: async () => true,
								listSessions: () => ({
									indexSeq: 1,
									sessions: brokerSessions.map(session => ({
										sessionId: session.sessionId,
										locator: { repo: root, stateRoot: path.join(root, ".gjc", "state") },
										live: session.live,
										endpointGeneration: session.endpointGeneration,
										pid: session.pid,
										endpointMtimeMs: session.endpointMtimeMs,
										indexSeq: 1,
									})),
									warnings: [],
								}),
							}) as unknown as SessionIndex,
						createClient: async () => {
							const client: SessionRouterClient = {
								onFrame: () => () => {},
								request: async frame => {
									if (frame.type === "event_replay") return {};
									expect(frame.type).toBe("control_request");
									expect(frame.operation).toBe("turn.prompt");
									return { accepted: true, command_id: "runtime-command", turn_id: "runtime-turn" };
								},
								close: async () => {},
								send: () => {},
							};
							return client;
						},
						setInterval: (() => 0) as unknown as typeof setInterval,
						clearInterval: (() => {}) as unknown as typeof clearInterval,
					},
				},
			});

			const started = await server.callTool("gjc_coordinator_start_session", {
				cwd: root,
				idempotency_key: "start-session",
				allow_mutation: true,
			});
			expect(started.ok).toBe(true);
			expect((started.session as { session_id: string }).session_id).toBe(sessionId);

			// The exact race the maintainer reproduced 25/25: two same-session prompts at once.
			const results = await Promise.all([
				server.callTool("gjc_coordinator_send_prompt", {
					session_id: sessionId,
					prompt: "first concurrent prompt",
					idempotency_key: "first-prompt",
					allow_mutation: true,
				}),
				server.callTool("gjc_coordinator_send_prompt", {
					session_id: sessionId,
					prompt: "second concurrent prompt",
					idempotency_key: "second-prompt",
					allow_mutation: true,
				}),
			]);

			const actives = results.filter(r => r.ok === true && r.status === "active");
			const conflicts = results.filter(
				r => r.ok === false && (r.error as { code?: string } | undefined)?.code === "active_turn_exists",
			);

			// Serialized: exactly one wins the active turn; the other observes it and is rejected.
			// Without the lock both persisted `status: "active"` (actives.length === 2).
			expect(actives.length).toBe(1);
			expect(conflicts.length).toBe(1);
			expect(conflicts[0]?.turn_id).toBe(actives[0]?.turn_id);
		});
	});
});
