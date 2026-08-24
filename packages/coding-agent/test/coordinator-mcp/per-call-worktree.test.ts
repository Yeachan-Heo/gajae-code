import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { createCoordinatorMcpServer } from "../../src/coordinator-mcp/server";
import { type BrokerDiscovery, brokerProcessIncarnation, writeBrokerDiscovery } from "../../src/sdk/broker/discovery";
import type { SdkClient } from "../../src/sdk/client/client";
import { coordinatorFixtureRoot } from "../helpers/coordinator-session-fixture";

const tempDirs: string[] = [];

afterEach(async () => {
	await Promise.all(tempDirs.splice(0).map(dir => fs.rm(dir, { recursive: true, force: true })));
});

type BrokerCall = { operation: string; input: Record<string, unknown> };

/**
 * Captures the `session.create` lifecycle target the coordinator sends to the
 * broker. The target is what decides the worktree, so asserting on it is the
 * closest observable proof that a per-call name reached the launch path.
 */
async function createServer(root: string, sessionCommand: string | null, requireWorktree = false) {
	const agentDir = path.join(root, "agent-global");
	const discovery: BrokerDiscovery = {
		version: 1,
		protocolVersion: 3,
		packageGeneration: "test",
		ownerId: "test",
		pid: process.pid,
		incarnation: brokerProcessIncarnation(process.pid) ?? "test-incarnation",
		host: "127.0.0.1",
		port: 1,
		url: "ws://sdk.example.test",
		token: "test-token",
		startedAt: Date.now(),
		heartbeatAt: Date.now(),
	};
	await writeBrokerDiscovery(agentDir, discovery);
	const calls: BrokerCall[] = [];
	const server = createCoordinatorMcpServer({
		env: {
			GJC_COORDINATOR_MCP_WORKDIR_ROOTS: root,
			GJC_COORDINATOR_MCP_STATE_ROOT: path.join(root, ".gjc", "coordinator-state"),
			GJC_COORDINATOR_MCP_MUTATIONS: "sessions",
			GJC_COORDINATOR_MCP_PROFILE: "local",
			GJC_COORDINATOR_MCP_REPO: "repo",
			...(sessionCommand === null ? {} : { GJC_COORDINATOR_MCP_SESSION_COMMAND: sessionCommand }),
			...(requireWorktree ? { GJC_COORDINATOR_MCP_REQUIRE_WORKTREE: "true" } : {}),
		},
		services: {
			getAgentDir: () => agentDir,
			// Pin both discovery seams to the fixture so ambient broker startup and
			// package-generation authority cannot change the lifecycle assertions.
			ensureBroker: async () => discovery,
			readSdkBrokerDiscovery: async () => discovery,
			connectBroker: async () =>
				({
					global: async (operation: string, input: Record<string, unknown>) => {
						calls.push({ operation, input });
						if (operation === "session.list") return { ok: true, result: { sessions: [] } };
						return { ok: true, result: { sessionId: input.sessionId ?? "created-session" } };
					},
					close: async () => {},
				}) as unknown as SdkClient,
		},
	});
	return { server, calls };
}

function lifecycleTargets(calls: BrokerCall[]): Array<Record<string, unknown>> {
	return calls
		.filter(call => call.operation === "session.create")
		.map(call => (call.input.target ?? {}) as Record<string, unknown>);
}

async function startSession(
	server: { callTool: (name: string, args: Record<string, unknown>) => Promise<Record<string, unknown>> },
	root: string,
	extra: Record<string, unknown> = {},
	idempotencyKey = "start-1",
) {
	return await server.callTool("gjc_coordinator_start_session", {
		cwd: root,
		idempotency_key: idempotencyKey,
		allow_mutation: true,
		...extra,
	});
}

describe("per-call worktree name", () => {
	it("names this session's worktree instead of the configured default", async () => {
		const root = await coordinatorFixtureRoot(tempDirs);
		const { server, calls } = await createServer(root, "gjc --worktree shared-default");

		await startSession(server, root, { worktree: "task-a" });

		expect(lifecycleTargets(calls)[0]?.worktree).toEqual({ enabled: true, name: "task-a" });
	});

	it("gives concurrent sessions in one repository distinct worktrees", async () => {
		const root = await coordinatorFixtureRoot(tempDirs);
		const { server, calls } = await createServer(root, "gjc --worktree");

		await startSession(server, root, { worktree: "task-a" }, "start-a");
		await startSession(server, root, { worktree: "task-b" }, "start-b");

		// Without a per-call name both sessions resolve to the same slug derived
		// from the repository's current branch, which is the collision this fixes.
		const names = lifecycleTargets(calls).map(target => (target.worktree as { name?: string })?.name);
		expect(names).toEqual(["task-a", "task-b"]);
	});

	it("falls back to the configured name when the request omits one", async () => {
		const root = await coordinatorFixtureRoot(tempDirs);
		const { server, calls } = await createServer(root, "gjc --worktree shared-default");

		await startSession(server, root);

		expect(lifecycleTargets(calls)[0]?.worktree).toEqual({ enabled: true, name: "shared-default" });
	});

	it("requires an explicit per-task worktree when configured", async () => {
		const root = await coordinatorFixtureRoot(tempDirs);
		const { server, calls } = await createServer(root, "gjc --worktree", true);

		expect(await startSession(server, root)).toMatchObject({ ok: false, reason: "worktree_required" });
		expect(lifecycleTargets(calls)).toHaveLength(0);

		await startSession(server, root, { worktree: "task-a" }, "required-task-a");
		expect(lifecycleTargets(calls)[0]?.worktree).toEqual({ enabled: true, name: "task-a" });
	});

	it("refuses an unsatisfiable required-worktree configuration", async () => {
		const root = await coordinatorFixtureRoot(tempDirs);
		const { server, calls } = await createServer(root, "gjc", true);

		expect(await startSession(server, root, { worktree: "task-a" })).toMatchObject({
			ok: false,
			reason: "worktree_required_without_worktree_mode",
		});
		expect(lifecycleTargets(calls)).toHaveLength(0);
	});

	it("refuses to enable worktree mode for an in-place coordinator", async () => {
		const root = await coordinatorFixtureRoot(tempDirs);
		const { server, calls } = await createServer(root, "gjc");

		const result = await startSession(server, root, { worktree: "task-a" });

		// The bridge redacts error messages, so the refusal has to be a typed reason
		// or the controller cannot tell this apart from any other invalid input.
		expect(result).toMatchObject({ ok: false, reason: "worktree_not_enabled" });
		expect(lifecycleTargets(calls)).toHaveLength(0);
	});

	it("rejects names the launch selector could not carry", async () => {
		const root = await coordinatorFixtureRoot(tempDirs);
		const { server, calls } = await createServer(root, "gjc --worktree");

		for (const [index, worktree] of ["--force", "two words", "bad..branch", "branch.lock", 1].entries()) {
			expect(await startSession(server, root, { worktree }, `reject-${index}`)).toMatchObject({
				ok: false,
				reason: "invalid_worktree_name",
			});
		}
		expect(lifecycleTargets(calls)).toHaveLength(0);
	});

	it("treats a blank name as absent rather than as a rejection", async () => {
		const root = await coordinatorFixtureRoot(tempDirs);
		const { server, calls } = await createServer(root, "gjc --worktree shared-default");

		await startSession(server, root, { worktree: "   " });

		expect(lifecycleTargets(calls)[0]?.worktree).toEqual({ enabled: true, name: "shared-default" });
	});

	it("binds the worktree name to the idempotency key", async () => {
		const root = await coordinatorFixtureRoot(tempDirs);
		const { server } = await createServer(root, "gjc --worktree");

		await startSession(server, root, { worktree: "task-a" }, "same-key");
		const replayed = await startSession(server, root, { worktree: "task-b" }, "same-key");

		// Reusing a key for a different worktree is a different creation, not a
		// replay: silently returning the first session would strand task-b.
		expect(JSON.stringify(replayed)).toContain("idempotency_conflict");
	});

	it("advertises the argument on start_session and the delegate tools", async () => {
		const root = await coordinatorFixtureRoot(tempDirs);
		const { server } = await createServer(root, "gjc --worktree");

		const response = (await server.handleJsonRpc({ jsonrpc: "2.0", id: 1, method: "tools/list" })) as {
			result?: { tools?: Array<{ name: string; inputSchema?: { properties?: Record<string, unknown> } }> };
		};
		const tools = response.result?.tools ?? [];
		for (const name of ["gjc_coordinator_start_session", "gjc_delegate_execute", "gjc_delegate_plan"]) {
			const tool = tools.find(entry => entry.name === name);
			expect(tool?.inputSchema?.properties?.worktree).toBeDefined();
		}
	});
});
