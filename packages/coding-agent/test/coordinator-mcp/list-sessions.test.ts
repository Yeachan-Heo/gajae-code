import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { createCoordinatorMcpServer } from "../../src/coordinator-mcp/server";
import { type BrokerDiscovery, brokerProcessIncarnation, writeBrokerDiscovery } from "../../src/sdk/broker/discovery";
import type { SdkClient } from "../../src/sdk/client/client";
import {
	coordinatorFixtureRoot,
	fixtureBrokerRows,
	writeDurableCoordinatorSession,
} from "../helpers/coordinator-session-fixture";

const tempDirs: string[] = [];

afterEach(async () => {
	await Promise.all(tempDirs.splice(0).map(dir => fs.rm(dir, { recursive: true, force: true })));
});

const REGISTERED_ID = "11111111-1111-4111-8111-111111111111";
const BROKER_ONLY_ID = "22222222-2222-4222-8222-222222222222";

/**
 * The `GJC_COORDINATOR_MCP_*` env every server in this file is built with. The
 * state root lives under the fixture root, separate from the workdir root, so
 * tests can also assert that listing never derives paths from broker ids.
 */
function serverEnv(root: string): NodeJS.ProcessEnv {
	return {
		GJC_COORDINATOR_MCP_WORKDIR_ROOTS: root,
		GJC_COORDINATOR_MCP_STATE_ROOT: path.join(root, ".gjc", "coordinator-state"),
		GJC_COORDINATOR_MCP_MUTATIONS: "sessions",
		GJC_COORDINATOR_MCP_PROFILE: "local",
		GJC_COORDINATOR_MCP_REPO: "repo",
	};
}

/**
 * A coordinator whose broker reports `brokerSessions` under the allowed root.
 * Only projected sessions resolve through the session-scoped tools, which is the
 * split real controllers hit: the broker index is workspace-wide while
 * projections are not.
 */
async function createServerWithSessions(
	root: string,
	brokerSessions: Array<Record<string, unknown>>,
	options: { registerFirst?: boolean; env?: NodeJS.ProcessEnv } = {},
) {
	const agentDir = path.join(root, "agent-global");
	const env = options.env ?? serverEnv(root);
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
	const server = createCoordinatorMcpServer({
		env,
		services: {
			getAgentDir: () => agentDir,
			// Pin both discovery seams to the fixture so ambient broker startup and
			// package-generation authority cannot change the listing result.
			ensureBroker: async () => discovery,
			readSdkBrokerDiscovery: async () => discovery,
			connectBroker: async () =>
				({
					global: async (operation: string, input: Record<string, unknown>) => {
						if (operation === "session.list") return { ok: true, result: { sessions: brokerSessions } };
						return { ok: true, result: { sessionId: input.sessionId } };
					},
					close: async () => {},
				}) as unknown as SdkClient,
		},
	});
	if (options.registerFirst !== false)
		await writeDurableCoordinatorSession({ sessionId: REGISTERED_ID, cwd: root, env });
	return server;
}

/**
 * A coordinator whose broker reports two sessions under the allowed root. Only
 * one of them has a durable projection, which is the split real controllers
 * hit: the broker index is workspace-wide while projections are not.
 */
async function createServer(root: string, options: { registerFirst?: boolean } = {}) {
	return await createServerWithSessions(
		root,
		[fixtureBrokerRows(root, REGISTERED_ID).live, fixtureBrokerRows(root, BROKER_ONLY_ID).live],
		options,
	);
}

describe("gjc_coordinator_list_sessions registration marker", () => {
	it("reports registered for projected sessions and unregistered for broker-only ones", async () => {
		const root = await coordinatorFixtureRoot(tempDirs);
		const server = await createServer(root);

		const listed = (await server.callTool("gjc_coordinator_list_sessions", {})) as {
			ok: boolean;
			sessions: Array<{ session_id?: string; registered?: boolean }>;
		};

		expect(listed.ok).toBe(true);
		const byId = new Map(listed.sessions.map(session => [session.session_id, session]));
		expect(byId.get(REGISTERED_ID)?.registered).toBe(true);
		expect(byId.get(BROKER_ONLY_ID)?.registered).toBe(false);
	});

	it("predicts not_found: session-scoped tools reject exactly the unregistered entries", async () => {
		const root = await coordinatorFixtureRoot(tempDirs);
		const server = await createServer(root);

		// The marker is only useful if it is the same condition other tools
		// enforce, so assert it against real tool behavior rather than against
		// the projection file it is derived from.
		for (const tool of ["gjc_coordinator_read_status", "gjc_coordinator_read_tail"]) {
			expect(await server.callTool(tool, { session_id: BROKER_ONLY_ID })).toMatchObject({
				ok: false,
				error: { code: "not_found" },
			});
		}
		// stop_session does not answer `not_found`; its unregistered outcome is the
		// `unknown_session` reason. The description must not overpromise the shape.
		expect(
			await server.callTool("gjc_coordinator_stop_session", {
				session_id: BROKER_ONLY_ID,
				allow_mutation: true,
			}),
		).toMatchObject({
			ok: false,
			reason: "unknown_session",
			closed: false,
		});
	});

	it("marks every session unregistered when no projection exists", async () => {
		const root = await coordinatorFixtureRoot(tempDirs);
		const server = await createServer(root, { registerFirst: false });

		const listed = (await server.callTool("gjc_coordinator_list_sessions", {})) as {
			sessions: Array<{ registered?: boolean }>;
		};

		expect(listed.sessions).toHaveLength(2);
		expect(listed.sessions.every(session => session.registered === false)).toBe(true);
	});

	it("stays total for malformed broker ids: no throw, no path probing", async () => {
		const root = await coordinatorFixtureRoot(tempDirs);
		// The broker is an independent index; nothing structurally prevents it from
		// returning rows whose id is empty, non-string, unsafe as a filename,
		// overlong, or duplicated. Listing must answer `registered: false` for all
		// of them without throwing and without deriving any path from the id. One
		// legitimate row stays registered, proving the scan kept working.
		const fixtureRef = await writeDurableCoordinatorSession({
			sessionId: REGISTERED_ID,
			cwd: root,
			env: serverEnv(root),
		});
		const hostile = await createServerWithSessions(
			root,
			[
				{
					sessionId: "",
					locator: { cwd: root, worktreeRoot: null, stateRoot: path.join(root, ".gjc", "state") },
					live: true,
				},
				{
					sessionId: 12345,
					locator: { cwd: root, worktreeRoot: null, stateRoot: path.join(root, ".gjc", "state") },
					live: true,
				},
				{
					sessionId: null,
					locator: { cwd: root, worktreeRoot: null, stateRoot: path.join(root, ".gjc", "state") },
					live: true,
				},
				{
					sessionId: "../escape",
					locator: { cwd: root, worktreeRoot: null, stateRoot: path.join(root, ".gjc", "state") },
					live: true,
				},
				{
					sessionId: "a/b/c",
					locator: { cwd: root, worktreeRoot: null, stateRoot: path.join(root, ".gjc", "state") },
					live: true,
				},
				{
					sessionId: `${"x".repeat(200)}`,
					locator: { cwd: root, worktreeRoot: null, stateRoot: path.join(root, ".gjc", "state") },
					live: true,
				},
				{
					sessionId: REGISTERED_ID,
					locator: { cwd: root, worktreeRoot: null, stateRoot: path.join(root, ".gjc", "state") },
					live: true,
				},
				{
					sessionId: REGISTERED_ID,
					locator: { cwd: root, worktreeRoot: null, stateRoot: path.join(root, ".gjc", "state") },
					live: true,
				},
			],
			{ registerFirst: false },
		);

		const listed = (await hostile.callTool("gjc_coordinator_list_sessions", {})) as {
			ok: boolean;
			sessions: Array<{ session_id?: string; registered?: boolean }>;
		};

		expect(listed.ok).toBe(true);
		// Rows without a usable id are published without a session_id at all and
		// can never be registered; every hostile id answers false.
		for (const session of listed.sessions) {
			if (session.session_id === REGISTERED_ID) expect(session.registered).toBe(true);
			else expect(session.registered).toBe(false);
		}
		// No path was derived from the hostile ids: the projection directory holds
		// exactly the one legitimate row.
		const { config, sessionFile } = { ...fixtureRef };
		expect(config.namespace.identity.length).toBeGreaterThan(0);
		const projections = path.join(
			root,
			".gjc",
			"coordinator-state",
			"v1",
			config.namespace.identity,
			"projections",
			"sessions",
		);
		expect(await fs.readdir(projections)).toEqual([`${REGISTERED_ID}.json`]);
		expect(sessionFile.endsWith(`${REGISTERED_ID}.json`)).toBe(true);
	});

	it("answers false for a projection row without a usable cwd (marker mirrors read_status)", async () => {
		const root = await coordinatorFixtureRoot(tempDirs);
		const { config, sessionFile } = await writeDurableCoordinatorSession({
			sessionId: REGISTERED_ID,
			cwd: root,
			env: serverEnv(root),
		});
		// Corrupt the row the way a foreign writer could: present, but with a cwd
		// read_status refuses. The marker must not claim such a row is usable.
		await Bun.write(sessionFile, `${JSON.stringify({ session_id: REGISTERED_ID, cwd: 42 })}\n`);
		expect(config.namespace.identity.length).toBeGreaterThan(0);
		const server = await createServer(root, { registerFirst: false });

		const listed = (await server.callTool("gjc_coordinator_list_sessions", {})) as {
			sessions: Array<{ session_id?: string; registered?: boolean }>;
		};

		expect(listed.sessions.find(session => session.session_id === REGISTERED_ID)?.registered).toBe(false);
		expect(await server.callTool("gjc_coordinator_read_status", { session_id: REGISTERED_ID })).toMatchObject({
			ok: false,
			error: { code: "not_found" },
		});
	});

	it("reflects a projection deleted between listings (TOCTOU is a hint, not a lock)", async () => {
		const root = await coordinatorFixtureRoot(tempDirs);
		const env = serverEnv(root);
		const fixture = await writeDurableCoordinatorSession({ sessionId: REGISTERED_ID, cwd: root, env });
		const server = await createServer(root, { registerFirst: false });

		const before = (await server.callTool("gjc_coordinator_list_sessions", {})) as {
			sessions: Array<{ session_id?: string; registered?: boolean }>;
		};
		expect(before.sessions.find(session => session.session_id === REGISTERED_ID)?.registered).toBe(true);

		// The reaper (or any concurrent coordinator) removes the projection after
		// the listing. The marker must flip to false, and the session-scoped tools
		// remain the authority either way — this pins that the listing never
		// resurrects a reaped projection.
		await fs.rm(fixture.sessionFile, { force: true });

		const after = (await server.callTool("gjc_coordinator_list_sessions", {})) as {
			sessions: Array<{ session_id?: string; registered?: boolean }>;
		};
		expect(after.sessions.find(session => session.session_id === REGISTERED_ID)?.registered).toBe(false);
		expect(await server.callTool("gjc_coordinator_read_tail", { session_id: REGISTERED_ID })).toMatchObject({
			ok: false,
			error: { code: "not_found" },
		});
	});

	it("bounds per-row cost: 400 broker rows with one projection stay well under a second", async () => {
		const root = await coordinatorFixtureRoot(tempDirs);
		const rows = Array.from({ length: 400 }, (_, index) => ({
			sessionId: `bulk-${`${index}`.padStart(4, "0")}`,
			locator: { cwd: root, worktreeRoot: null, stateRoot: path.join(root, ".gjc", "state") },
			live: true,
		}));
		rows.push({
			sessionId: REGISTERED_ID,
			locator: { cwd: root, worktreeRoot: null, stateRoot: path.join(root, ".gjc", "state") },
			live: true,
		});
		const server = await createServerWithSessions(root, rows);
		await writeDurableCoordinatorSession({ sessionId: REGISTERED_ID, cwd: root, env: serverEnv(root) });

		const startedAt = performance.now();
		const listed = (await server.callTool("gjc_coordinator_list_sessions", {})) as {
			ok: boolean;
			sessions: Array<{ session_id?: string; registered?: boolean }>;
		};
		const elapsedMs = performance.now() - startedAt;

		expect(listed.ok).toBe(true);
		expect(listed.sessions).toHaveLength(401);
		// One directory scan answers every row: the 400 broker-only rows must not
		// each pay a projection read. Generous bound — the point is O(1) reads for
		// unregistered rows, not a precise benchmark.
		expect(elapsedMs).toBeLessThan(1000);
		expect(listed.sessions.filter(session => session.registered).length).toBe(1);
	});

	it("advertises the registered contract in the tool description", async () => {
		const root = await coordinatorFixtureRoot(tempDirs);
		const server = await createServer(root);

		const response = (await server.handleJsonRpc({ jsonrpc: "2.0", id: 1, method: "tools/list" })) as {
			result?: { tools?: Array<{ name: string; description: string }> };
		};
		const listSessions = response.result?.tools?.find(tool => tool.name === "gjc_coordinator_list_sessions");

		expect(listSessions?.description).toContain("registered");
		expect(listSessions?.description).toContain("not_found");
		expect(listSessions?.description).toContain("unknown_session");
	});
});
