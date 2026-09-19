import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { buildCoordinatorMcpConfig } from "../../src/coordinator-mcp/policy";
import {
	type CoordinatorSessionTransactionV1,
	coordinatorStatePaths,
	readSessionTransaction,
	withSessionTransaction,
} from "../../src/coordinator-mcp/question-state";
import { createCoordinatorMcpServer } from "../../src/coordinator-mcp/server";
import { MAX_REAP_FAILURES } from "../../src/coordinator-mcp/session-reaper";
import { type BrokerDiscovery, brokerProcessIncarnation, writeBrokerDiscovery } from "../../src/sdk/broker/discovery";
import type { SdkClient } from "../../src/sdk/client/client";
import {
	coordinatorFixtureRoot,
	FIXTURE_ENDPOINT_GENERATION,
	fixtureBrokerRows,
	fixtureEndpointIncarnation,
	writeDurableCoordinatorSession,
} from "../helpers/coordinator-session-fixture";

const tempDirs: string[] = [];

afterEach(async () => {
	await Promise.all(tempDirs.splice(0).map(dir => fs.rm(dir, { recursive: true, force: true })));
});

type BrokerControl = { operation: string; input: Record<string, unknown>; idempotencyKey?: string };

const ENDPOINT_GENERATION = FIXTURE_ENDPOINT_GENERATION;
const endpointIncarnation = fixtureEndpointIncarnation;

async function createServer(
	root: string,
	options: {
		forceStop?: boolean;
		closeFails?: boolean;
		closeFailures?: number;
		brokerSessionsOverride?: () => Promise<Array<Record<string, unknown>>>;
		closeHandler?: (input: Record<string, unknown>) => Promise<Record<string, unknown>>;
	} = {},
) {
	const stateRoot = path.join(root, ".gjc", "coordinator-state");
	const agentDir = path.join(root, "agent-global");
	const controls: BrokerControl[] = [];
	let closeAttempts = 0;
	const closedSessionIds = new Set<string>();
	const env: NodeJS.ProcessEnv = {
		GJC_COORDINATOR_MCP_WORKDIR_ROOTS: root,
		GJC_COORDINATOR_MCP_STATE_ROOT: stateRoot,
		GJC_COORDINATOR_MCP_MUTATIONS: "sessions",
		GJC_COORDINATOR_MCP_PROFILE: "local",
		GJC_COORDINATOR_MCP_REPO: "repo",
		...(options.forceStop ? { GJC_COORDINATOR_MCP_FORCE_STOP: "1" } : {}),
	};
	const config = buildCoordinatorMcpConfig(env);
	const registryFile = coordinatorStatePaths(stateRoot, config.namespace.identity).registry;

	// The durable layout keeps authoritative session records in the canonical
	// projections dir; the broker index mirrors whatever rows survive close.
	const projectionsSessionsDir = path.join(stateRoot, "v1", config.namespace.identity, "projections", "sessions");
	async function brokerSessions(): Promise<Array<Record<string, unknown>>> {
		const entries = await fs.readdir(projectionsSessionsDir).catch(() => []);
		return (
			await Promise.all(
				entries
					.filter(entry => entry.endsWith(".json"))
					.map(async entry => {
						const session = JSON.parse(await fs.readFile(path.join(projectionsSessionsDir, entry), "utf8")) as {
							session_id?: unknown;
						};
						const sessionId = typeof session.session_id === "string" ? session.session_id : "";
						const rows = fixtureBrokerRows(root, sessionId);
						return rows.live;
					}),
			)
		).filter(session => !closedSessionIds.has(session.sessionId as string));
	}
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
			// This suite exercises coordinator stop/reap semantics, not broker
			// bootstrap or package-generation replacement. Pin both discovery seams
			// to the fixture so ambient/local broker authority cannot change results.
			ensureBroker: async () => discovery,
			readSdkBrokerDiscovery: async () => discovery,
			connectBroker: async () =>
				({
					global: async (
						operation: string,
						input: Record<string, unknown>,
						opts: { idempotencyKey?: string } = {},
					) => {
						controls.push({ operation, input, idempotencyKey: opts.idempotencyKey });
						if (operation === "session.list") {
							if (options.brokerSessionsOverride)
								return { ok: true, result: { sessions: await options.brokerSessionsOverride() } };
							return { ok: true, result: { sessions: await brokerSessions() } };
						}
						if (operation === "session.close") {
							if (options.closeHandler) return await options.closeHandler(input);
							closeAttempts += 1;
							if (options.closeFails || closeAttempts <= (options.closeFailures ?? 0))
								return { ok: false, error: { code: "close_refused", message: "SDK refused close" } };
							closedSessionIds.add(String(input.sessionId));
						}
						return { ok: true, result: { sessionId: input.sessionId } };
					},
					close: async () => {},
				}) as unknown as SdkClient,
		},
	});
	return {
		server,
		controls,
		registryFile,
		sessionFile: (id: string) => path.join(projectionsSessionsDir, `${id}.json`),
	};
}

async function tempRoot(): Promise<string> {
	return await coordinatorFixtureRoot(tempDirs);
}

async function writeSession(
	_file: string,
	root: string,
	id: string,
	overrides: Record<string, unknown> = {},
	activeTurn?: { turnId: string; status: "active" | "delivering" | "waiting_for_answer" | "completing" },
	ages?: { creationAgeMs?: number; activityAgeMs?: number },
): Promise<void> {
	// Sessions live in the durable canonical layout: initialized registry, a
	// canonical WAL transaction, and the projection row the reaper reads. The
	// legacy human-readable tree is migration input only and can no longer
	// present an unscoped session as reapable (#4731).
	await writeDurableCoordinatorSession({
		sessionId: id,
		cwd: root,
		env: {
			GJC_COORDINATOR_MCP_WORKDIR_ROOTS: root,
			GJC_COORDINATOR_MCP_STATE_ROOT: path.join(root, ".gjc", "coordinator-state"),
			GJC_COORDINATOR_MCP_MUTATIONS: "sessions",
			GJC_COORDINATOR_MCP_PROFILE: "local",
			GJC_COORDINATOR_MCP_REPO: "repo",
		},
		overrides,
		...(activeTurn ? { activeTurn } : {}),
		...(ages ?? {}),
	});
}

describe("gjc_coordinator_stop_session SDK lifecycle", () => {
	it("persists one endpoint-incarnation authority across WAL, projection, and broker close", async () => {
		const root = await tempRoot();
		const { server, controls } = await createServer(root);
		const sessionId = "authority";
		const fixture = await writeDurableCoordinatorSession({
			sessionId,
			cwd: root,
			env: {
				GJC_COORDINATOR_MCP_WORKDIR_ROOTS: root,
				GJC_COORDINATOR_MCP_STATE_ROOT: path.join(root, ".gjc", "coordinator-state"),
				GJC_COORDINATOR_MCP_MUTATIONS: "sessions",
				GJC_COORDINATOR_MCP_PROFILE: "local",
				GJC_COORDINATOR_MCP_REPO: "repo",
			},
			overrides: { ephemeral: true },
		});
		const expectedIncarnation = fixtureEndpointIncarnation(sessionId);
		const wal = await readSessionTransaction(fixture.paths, sessionId);
		const projection = JSON.parse(await fs.readFile(fixture.sessionFile, "utf8")) as {
			endpoint_incarnation?: unknown;
		};

		expect(wal?.canonical.session.broker.endpoint_incarnation).toBe(expectedIncarnation);
		expect(projection.endpoint_incarnation).toBe(expectedIncarnation);
		expect(
			await server.callTool("gjc_coordinator_stop_session", { session_id: sessionId, allow_mutation: true }),
		).toMatchObject({ ok: true, closed: true, session_id: sessionId });
		expect(controls.filter(control => control.operation === "session.close")).toEqual([
			expect.objectContaining({
				input: expect.objectContaining({
					sessionId,
					endpointGeneration: ENDPOINT_GENERATION,
					endpointIncarnation: expectedIncarnation,
				}),
				idempotencyKey: `coordinator-reap:${sessionId}:${expectedIncarnation}`,
			}),
		]);
	});

	it("refuses a non-ephemeral session without force and never invokes lifecycle close", async () => {
		const root = await tempRoot();
		const { server, controls, sessionFile } = await createServer(root);
		await writeSession(sessionFile("registered"), root, "registered");

		expect(
			await server.callTool("gjc_coordinator_stop_session", { session_id: "registered", allow_mutation: true }),
		).toMatchObject({ ok: false, reason: "not_ephemeral", closed: false });
		// #4731 moved the endpoint-authority preflight (session.list) ahead of the
		// ephemeral refusal, so read-only index reads are expected; the contract is
		// that lifecycle close is never invoked.
		expect(controls.filter(control => control.operation === "session.close")).toEqual([]);
	});

	it("requires the force-stop capability before closing a non-ephemeral session", async () => {
		const root = await tempRoot();
		const { server, controls, sessionFile } = await createServer(root);
		await writeSession(sessionFile("registered"), root, "registered");

		expect(
			await server.callTool("gjc_coordinator_stop_session", {
				session_id: "registered",
				force: true,
				allow_mutation: true,
			}),
		).toMatchObject({ ok: false, reason: "force_not_authorized", closed: false });
		expect(controls.filter(control => control.operation === "session.close")).toEqual([]);
	});

	it("releases the worktree of a force-stopped endpoint_stale session before returning endpoint_stale (#5581)", async () => {
		const root = await tempRoot();
		// The broker still indexes the session, but at a rotated endpoint authority:
		// the coordinator's persisted incarnation no longer matches, so the preflight
		// resolves endpoint_stale. Before #5581 this returned without releasing the
		// worktree, and the row (still non-terminal in the index) parked the checkout
		// forever because an OS probe of the reused pid reads `uncertain`.
		const rows = fixtureBrokerRows(root, "stale");
		const { server, controls, sessionFile } = await createServer(root, {
			forceStop: true,
			brokerSessionsOverride: async () => [{ ...rows.live, endpointGeneration: ENDPOINT_GENERATION + 1 }],
		});
		await writeSession(sessionFile("stale"), root, "stale");

		expect(
			await server.callTool("gjc_coordinator_stop_session", {
				session_id: "stale",
				force: true,
				allow_mutation: true,
			}),
		).toMatchObject({ ok: false, reason: "endpoint_stale", closed: false });
		// The forced release drives a session.close carrying forceReleaseStaleWorktree,
		// bound to the exact persisted authority so a live successor is never touched.
		expect(controls.filter(control => control.operation === "session.close")).toEqual([
			expect.objectContaining({
				input: expect.objectContaining({
					sessionId: "stale",
					endpointGeneration: ENDPOINT_GENERATION,
					endpointIncarnation: endpointIncarnation("stale"),
					forceReleaseStaleWorktree: true,
				}),
			}),
		]);
		// DR-1: the session projection stays readable for inspect/tail after force-stop.
		expect(await Bun.file(sessionFile("stale")).exists()).toBe(true);
	});

	it("does not attempt a worktree release when a non-forced stop hits endpoint_stale", async () => {
		const root = await tempRoot();
		const rows = fixtureBrokerRows(root, "unforced");
		const { server, controls, sessionFile } = await createServer(root, {
			brokerSessionsOverride: async () => [{ ...rows.live, endpointGeneration: ENDPOINT_GENERATION + 1 }],
		});
		await writeSession(sessionFile("unforced"), root, "unforced", { ephemeral: true });

		expect(
			await server.callTool("gjc_coordinator_stop_session", { session_id: "unforced", allow_mutation: true }),
		).toMatchObject({ ok: false, reason: "endpoint_stale", closed: false });
		// The uncertain-counts-as-occupied guarantee is preserved for non-forced
		// stops: no session.close is issued, so nothing releases the worktree.
		expect(controls.filter(control => control.operation === "session.close")).toEqual([]);
	});

	it("releases the worktree when a force-stop passes the authority check but the broker close throws endpoint_stale (#5581)", async () => {
		const root = await tempRoot();
		// The row is still indexed at the persisted authority, so both the preflight
		// and the second authority check pass. The endpoint then vanishes before the
		// reap `session.close` reaches the broker, which throws endpoint_stale. Before
		// this fix the broad catch returned close_failed without recording a
		// terminal-uncertain claim, so the non-terminal row kept holding its checkout.
		const { server, controls, sessionFile } = await createServer(root, {
			forceStop: true,
			closeHandler: async input => {
				// The advisory release close carries forceReleaseStaleWorktree; only the
				// reap close is made to lose its endpoint mid-flight.
				if (input.forceReleaseStaleWorktree === true) return { ok: true, result: { sessionId: input.sessionId } };
				return { ok: false, error: { code: "endpoint_stale", message: "endpoint vanished mid-close" } };
			},
		});
		await writeSession(sessionFile("stale-close"), root, "stale-close");

		expect(
			await server.callTool("gjc_coordinator_stop_session", {
				session_id: "stale-close",
				force: true,
				allow_mutation: true,
			}),
		).toMatchObject({ ok: false, reason: "close_failed", detail: "endpoint_stale", closed: false });
		const closes = controls.filter(control => control.operation === "session.close");
		// The reap close was attempted at the exact persisted authority...
		expect(closes[0]).toEqual(
			expect.objectContaining({
				input: expect.objectContaining({
					sessionId: "stale-close",
					endpointGeneration: ENDPOINT_GENERATION,
					endpointIncarnation: endpointIncarnation("stale-close"),
				}),
			}),
		);
		// ...and its endpoint_stale failure drives the identity-bound release.
		expect(closes).toContainEqual(
			expect.objectContaining({
				input: expect.objectContaining({
					sessionId: "stale-close",
					endpointGeneration: ENDPOINT_GENERATION,
					endpointIncarnation: endpointIncarnation("stale-close"),
					forceReleaseStaleWorktree: true,
				}),
			}),
		);
		// The unproven close leaves the projection readable for inspect/tail.
		expect(await Bun.file(sessionFile("stale-close")).exists()).toBe(true);
	});

	it("advances an admitted deletion on the forced release claim instead of re-closing (#5581)", async () => {
		const root = await tempRoot();
		// The retry after the previous scenario: the deletion is admitted at `intent`
		// and the forced release already marked the row terminal-uncertain. An ordinary
		// `session.close` against that row is refused with terminal_uncertain, so
		// retrying one would park the manifest at `intent` forever. The forced claim is
		// itself the teardown proof, so the retry advances to broker_closed on it.
		const rows = fixtureBrokerRows(root, "recovered");
		let released = false;
		const { server, controls, sessionFile } = await createServer(root, {
			forceStop: true,
			brokerSessionsOverride: async () => [
				released ? { ...rows.live, live: false, terminalUncertain: true, forcedStaleRelease: true } : rows.live,
			],
			closeHandler: async input => {
				if (input.forceReleaseStaleWorktree === true) {
					released = true;
					return { ok: true, result: { sessionId: input.sessionId } };
				}
				// Mirrors the broker: once the row carries the terminal-uncertain claim,
				// every ordinary close is refused with terminal_uncertain.
				if (released) return { ok: false, error: { code: "terminal_uncertain", message: "ownership uncertain" } };
				return { ok: false, error: { code: "endpoint_stale", message: "endpoint vanished mid-close" } };
			},
		});
		await writeSession(sessionFile("recovered"), root, "recovered");

		expect(
			await server.callTool("gjc_coordinator_stop_session", {
				session_id: "recovered",
				force: true,
				allow_mutation: true,
			}),
		).toMatchObject({ ok: false, reason: "close_failed", detail: "endpoint_stale", closed: false });
		const closesAfterFirstStop = controls.filter(control => control.operation === "session.close").length;

		expect(
			await server.callTool("gjc_coordinator_stop_session", {
				session_id: "recovered",
				force: true,
				allow_mutation: true,
			}),
		).toMatchObject({ ok: true, closed: true });
		// The recovery issued no further close: the forced claim carried the proof.
		expect(controls.filter(control => control.operation === "session.close")).toHaveLength(closesAfterFirstStop);
		expect(await Bun.file(sessionFile("recovered")).exists()).toBe(false);
	});

	it("closes an idle ephemeral session through the SDK broker and removes only coordinator metadata", async () => {
		const root = await tempRoot();
		const { server, controls, registryFile, sessionFile } = await createServer(root);
		await writeSession(sessionFile("ephemeral"), root, "ephemeral", { ephemeral: true });
		expect(await Bun.file(registryFile).exists()).toBe(true);

		expect(
			await server.callTool("gjc_coordinator_stop_session", { session_id: "ephemeral", allow_mutation: true }),
		).toMatchObject({ ok: true, closed: true, session_id: "ephemeral" });
		expect(controls.filter(control => control.operation === "session.close")).toEqual([
			expect.objectContaining({
				input: expect.objectContaining({
					sessionId: "ephemeral",
					endpointGeneration: ENDPOINT_GENERATION,
					endpointIncarnation: endpointIncarnation("ephemeral"),
				}),
				idempotencyKey: `coordinator-reap:ephemeral:${endpointIncarnation("ephemeral")}`,
			}),
		]);
		expect(await Bun.file(sessionFile("ephemeral")).exists()).toBe(false);
	});

	it("fails closed on a malformed existing namespace registry", async () => {
		const root = await tempRoot();
		const { server, controls, registryFile, sessionFile } = await createServer(root);
		await writeSession(sessionFile("malformed"), root, "malformed", { ephemeral: true });
		await Bun.write(registryFile, "{}");

		expect(
			await server.callTool("gjc_coordinator_stop_session", { session_id: "malformed", allow_mutation: true }),
		).toMatchObject({ ok: false, error: { code: "unavailable" } });
		expect(await Bun.file(sessionFile("malformed")).exists()).toBe(true);
		expect(controls.filter(control => control.operation === "session.close")).toEqual([]);
	});

	it("retains coordinator metadata when the SDK broker cannot verify closure", async () => {
		const root = await tempRoot();
		const { server, sessionFile } = await createServer(root, { closeFails: true });
		await writeSession(sessionFile("wedged"), root, "wedged", { ephemeral: true });

		expect(
			await server.callTool("gjc_coordinator_stop_session", { session_id: "wedged", allow_mutation: true }),
			// #4731 funnels broker close failures through the public error-code
			// table; the raw broker code is no longer echoed verbatim.
		).toMatchObject({ ok: false, reason: "close_failed", detail: "unavailable", closed: false });
		expect(await Bun.file(sessionFile("wedged")).exists()).toBe(true);
	});

	it("does not close a session with an active durable turn", async () => {
		const root = await tempRoot();
		const { server, controls, sessionFile } = await createServer(root);
		const sessionId = "active";
		const turnId = "turn-00000000-0000-4000-8000-000000000001";
		// The durable holder of active-turn state is the canonical WAL; a
		// hand-written projection row is rebuilt over (#4731).
		await writeSession(
			sessionFile(sessionId),
			root,
			sessionId,
			{ ephemeral: true },
			{
				turnId,
				status: "active",
			},
		);

		expect(
			await server.callTool("gjc_coordinator_stop_session", { session_id: sessionId, allow_mutation: true }),
		).toMatchObject({ ok: false, reason: "active_turn", active_turn_id: turnId, closed: false });
		expect(controls.filter(control => control.operation === "session.close")).toEqual([]);
	});

	it("sweeps only idle ephemeral coordinator records", async () => {
		const root = await tempRoot();
		const { server, controls, sessionFile } = await createServer(root);
		await writeSession(sessionFile("idle"), root, "idle", { ephemeral: true });
		await writeSession(sessionFile("registered"), root, "registered");

		expect(await server.sessionReaper.sweepOnce()).toBe(1);
		expect(controls.filter(control => control.operation === "session.close")).toEqual([
			expect.objectContaining({
				input: expect.objectContaining({
					sessionId: "idle",
					endpointGeneration: ENDPOINT_GENERATION,
					endpointIncarnation: endpointIncarnation("idle"),
				}),
				idempotencyKey: `coordinator-reap:idle:${endpointIncarnation("idle")}`,
			}),
		]);
		expect(await Bun.file(sessionFile("idle")).exists()).toBe(false);
		expect(await Bun.file(sessionFile("registered")).exists()).toBe(true);
	});
	it("does not sweep an old ephemeral session whose last turn activity is recent", async () => {
		const root = await tempRoot();
		const { server, controls, sessionFile } = await createServer(root);
		// Created 31+ minutes ago (past the idle TTL) but its durable turn
		// watermark is 2 minutes ago: the session is in use between turns and
		// must survive the sweep. Reading the creation stamp instead of the
		// activity watermark would reap it (#4835 review finding).
		await writeSession(sessionFile("busy"), root, "busy", { ephemeral: true }, undefined, {
			creationAgeMs: 31 * 60_000,
			activityAgeMs: 2 * 60_000,
		});

		expect(await server.sessionReaper.sweepOnce()).toBe(0);
		expect(controls.filter(control => control.operation === "session.close")).toEqual([]);
		expect(await Bun.file(sessionFile("busy")).exists()).toBe(true);
	});

	describe("DR-1 narrow reap proves exact terminal row after incarnation-bound close", () => {
		it("reaps when DR-1 retains the exact terminal/non-live incarnation (the bug)", async () => {
			const root = await tempRoot();
			const rows = fixtureBrokerRows(root, "dr1-ok");
			let sawClose = false;
			const { server, sessionFile } = await createServer(root, {
				brokerSessionsOverride: async () => [sawClose ? rows.terminal : rows.live],
				closeHandler: async () => {
					sawClose = true;
					return { ok: true, result: { sessionId: "dr1-ok" } };
				},
			});
			await writeSession(sessionFile("dr1-ok"), root, "dr1-ok", { ephemeral: true });
			const res = await server.callTool("gjc_coordinator_stop_session", {
				session_id: "dr1-ok",
				allow_mutation: true,
			});
			expect(res).toMatchObject({ ok: true, closed: true });
			expect(await Bun.file(sessionFile("dr1-ok")).exists()).toBe(false);
			// idempotent completed deletion receipt
			const res2 = await server.callTool("gjc_coordinator_stop_session", {
				session_id: "dr1-ok",
				allow_mutation: true,
			});
			expect(res2).toMatchObject({ ok: true, closed: true });
		});

		it("fails closed on rotated generation", async () => {
			const root = await tempRoot();
			const rows = fixtureBrokerRows(root, "rotated");
			const rotatedRow = { ...rows.terminal, endpointGeneration: ENDPOINT_GENERATION + 1 };
			let sawClose = false;
			const { server, sessionFile } = await createServer(root, {
				brokerSessionsOverride: async () => [sawClose ? rotatedRow : rows.live],
				closeHandler: async () => {
					sawClose = true;
					return { ok: true, result: { sessionId: "rotated" } };
				},
			});
			await writeSession(sessionFile("rotated"), root, "rotated", { ephemeral: true });
			const res = await server.callTool("gjc_coordinator_stop_session", {
				session_id: "rotated",
				allow_mutation: true,
			});
			expect(res).toMatchObject({ ok: false, reason: "endpoint_stale" });
			expect(await Bun.file(sessionFile("rotated")).exists()).toBe(true);
		});

		it("fails closed on ambiguous retained row", async () => {
			const root = await tempRoot();
			const rows = fixtureBrokerRows(root, "amb");
			const ambRow = { ...rows.terminal, ambiguous: true };
			let sawClose = false;
			const { server, sessionFile } = await createServer(root, {
				brokerSessionsOverride: async () => [sawClose ? ambRow : rows.live],
				closeHandler: async () => {
					sawClose = true;
					return { ok: true, result: { sessionId: "amb" } };
				},
			});
			await writeSession(sessionFile("amb"), root, "amb", { ephemeral: true });
			const res = await server.callTool("gjc_coordinator_stop_session", {
				session_id: "amb",
				allow_mutation: true,
			});
			expect(res).toMatchObject({ ok: false, reason: "close_failed", detail: "endpoint_stale" });
			expect(await Bun.file(sessionFile("amb")).exists()).toBe(true);
		});

		it("fails closed when retained row is still live", async () => {
			const root = await tempRoot();
			const rows = fixtureBrokerRows(root, "still-live");
			let sawClose = false;
			const { server, sessionFile } = await createServer(root, {
				brokerSessionsOverride: async () => [rows.live],
				closeHandler: async () => {
					sawClose = true;
					return { ok: true, result: { sessionId: "still-live" } };
				},
			});
			await writeSession(sessionFile("still-live"), root, "still-live", { ephemeral: true });
			const res = await server.callTool("gjc_coordinator_stop_session", {
				session_id: "still-live",
				allow_mutation: true,
			});
			expect(res).toMatchObject({ ok: false, reason: "endpoint_stale" });
			expect(sawClose).toBe(true);
			expect(await Bun.file(sessionFile("still-live")).exists()).toBe(true);
		});
	});

	it("F2: revalidates active-turn state under the lock and skips force eviction when a turn started after selection", async () => {
		const root = await tempRoot();
		const sessionId = "stale-then-active";
		let goActive = false;
		let injected = false;
		// The broker index never carries a row for the session, so every reap
		// preflight fails endpoint_stale — the force-eviction trigger. On the sweep
		// that crosses MAX_REAP_FAILURES we simulate a turn starting AFTER the
		// reaper selected the (turn-less) candidate but before eviction runs.
		const { server } = await createServer(root, {
			brokerSessionsOverride: async () => {
				if (goActive && !injected) {
					injected = true;
					await withSessionTransaction(fixture.paths, sessionId, async (t: CoordinatorSessionTransactionV1) => {
						const turnId = "turn-00000000-0000-4000-8000-0000000000aa";
						const at = new Date().toISOString();
						t.canonical.turns[turnId] = {
							schema_version: 1,
							turn_id: turnId,
							session_id: sessionId,
							namespace_id: t.canonical.session.namespace_id,
							status: "active",
							prompt: { text: "reactivated mid-reap", created_at: at, source: "coordinator" },
							delivery: { delivered: false, queued: false, target: null, attempts: [] },
							runtime_provenance: null,
							question_ids: [],
							final_response: {
								text: null,
								format: "markdown",
								source: null,
								artifact_path: null,
								truncated: false,
							},
							evidence: [],
							error: null,
							liveness: {},
							created_at: at,
							updated_at: at,
							started_at: at,
							completed_at: null,
							terminal_fence: null,
						};
						t.canonical.queue.active_turn_id = turnId;
					});
				}
				return [];
			},
		});
		const fixture = await writeDurableCoordinatorSession({
			sessionId,
			cwd: root,
			env: {
				GJC_COORDINATOR_MCP_WORKDIR_ROOTS: root,
				GJC_COORDINATOR_MCP_STATE_ROOT: path.join(root, ".gjc", "coordinator-state"),
				GJC_COORDINATOR_MCP_MUTATIONS: "sessions",
				GJC_COORDINATOR_MCP_PROFILE: "local",
				GJC_COORDINATOR_MCP_REPO: "repo",
			},
			overrides: { ephemeral: true },
		});

		// Accumulate stale failures right up to the eviction boundary.
		for (let i = 0; i < MAX_REAP_FAILURES - 1; i++) expect(await server.sessionReaper.sweepOnce()).toBe(0);
		expect(await Bun.file(fixture.sessionFile).exists()).toBe(true);

		// This sweep hits MAX_REAP_FAILURES and would force-evict — but the
		// under-lock revalidation must see the freshly-active turn and abort.
		goActive = true;
		expect(await server.sessionReaper.sweepOnce()).toBe(0);
		expect(injected).toBe(true);

		// Neither the projection row nor the canonical WAL was removed.
		expect(await Bun.file(fixture.sessionFile).exists()).toBe(true);
		expect(await readSessionTransaction(fixture.paths, sessionId)).not.toBeNull();
	});

	it("F3: force eviction performs recovery-safe cleanup instead of orphaning the WAL and delivery state", async () => {
		const root = await tempRoot();
		const sessionId = "stale-evicted";
		// Endpoint is permanently stale (no broker row) so every reap fails
		// endpoint_stale and the session is force-evicted after MAX_REAP_FAILURES.
		const { server, registryFile } = await createServer(root, {
			brokerSessionsOverride: async () => [],
		});
		const fixture = await writeDurableCoordinatorSession({
			sessionId,
			cwd: root,
			env: {
				GJC_COORDINATOR_MCP_WORKDIR_ROOTS: root,
				GJC_COORDINATOR_MCP_STATE_ROOT: path.join(root, ".gjc", "coordinator-state"),
				GJC_COORDINATOR_MCP_MUTATIONS: "sessions",
				GJC_COORDINATOR_MCP_PROFILE: "local",
				GJC_COORDINATOR_MCP_REPO: "repo",
			},
			overrides: { ephemeral: true },
		});

		// The canonical WAL exists before eviction.
		expect(await readSessionTransaction(fixture.paths, sessionId)).not.toBeNull();

		for (let i = 0; i < MAX_REAP_FAILURES; i++) await server.sessionReaper.sweepOnce();

		// Projection removed AND the canonical WAL drained/removed — not orphaned.
		expect(await Bun.file(fixture.sessionFile).exists()).toBe(false);
		expect(await readSessionTransaction(fixture.paths, sessionId)).toBeNull();

		// A durable retirement record was written and completed, guaranteeing full
		// cleanup (WAL, deliveries, projections, events) is recorded.
		const registry = JSON.parse(await fs.readFile(registryFile, "utf8")) as {
			deletions: Record<string, { session_id: string; phase: string; cleanup: Record<string, unknown> }>;
		};
		const retirement = Object.values(registry.deletions).find(entry => entry.session_id === sessionId);
		expect(retirement?.phase).toBe("completed");
		expect(retirement?.cleanup).toMatchObject({ wal: true, session: true, events: true });

		// The evicted session no longer appears to the reaper.
		expect(await server.sessionReaper.sweepOnce()).toBe(0);
	});

	it("reuses the close idempotency key when the idle reaper retries", async () => {
		const root = await tempRoot();
		const { server, controls, sessionFile } = await createServer(root, { closeFailures: 1 });
		await writeSession(sessionFile("retry"), root, "retry", { ephemeral: true });

		expect(await server.sessionReaper.sweepOnce()).toBe(0);
		expect(await Bun.file(sessionFile("retry")).exists()).toBe(true);
		// The failed close leaves a fresh projection session-state stamp, but idle
		// eligibility reads the durable WAL session, so the retry is not deferred.
		expect(await server.sessionReaper.sweepOnce()).toBe(1);
		const closeRequests = controls.filter(control => control.operation === "session.close");
		expect(closeRequests).toHaveLength(2);
		expect(closeRequests.map(control => control.idempotencyKey)).toEqual([
			`coordinator-reap:retry:${endpointIncarnation("retry")}`,
			`coordinator-reap:retry:${endpointIncarnation("retry")}`,
		]);
	});
});
