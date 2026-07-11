import { describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { buildCoordinatorMcpConfig, coordinatorNamespacePath } from "../../src/coordinator-mcp/policy";
import { createCoordinatorMcpServer } from "../../src/coordinator-mcp/server";

async function withTempRoot(run: (root: string) => Promise<void>): Promise<void> {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-coord-stop-"));
	try {
		await run(root);
	} finally {
		await fs.rm(root, { recursive: true, force: true });
	}
}

type MakeOpts = { forceStop?: boolean; forceClose?: (name: string) => Promise<unknown> };

function baseEnv(root: string, forceStop?: boolean): Record<string, string> {
	return {
		GJC_COORDINATOR_MCP_WORKDIR_ROOTS: root,
		GJC_COORDINATOR_MCP_MUTATIONS: "sessions,questions,reports",
		GJC_COORDINATOR_MCP_STATE_ROOT: path.join(root, ".state"),
		GJC_COORDINATOR_MCP_PROFILE: "stop-controller",
		GJC_COORDINATOR_MCP_REPO: "repo-stop",
		...(forceStop ? { GJC_COORDINATOR_MCP_FORCE_STOP: "1" } : {}),
	};
}

function makeServer(root: string, opts: MakeOpts = {}) {
	let n = 0;
	const calls: string[] = [];
	const env = baseEnv(root, opts.forceStop);
	const server = createCoordinatorMcpServer({
		env,
		services: {
			startSession: async (input: {
				cwd: string;
				sessionId: string;
				launchId: string;
				readinessMarkerFile: string;
			}) => {
				n += 1;
				// dev's refactored start flow requires the runtime readiness marker + launch metadata
				// (assertSessionReadinessAuthority + awaitRuntimeReadiness) before the turn is delivered.
				await Bun.write(
					input.readinessMarkerFile,
					`${JSON.stringify({
						schema_version: 1,
						session_id: input.sessionId,
						launch_id: input.launchId,
						state: "ready_for_input",
						event: "interactive_input_ready",
						source: "gjc_interactive_runtime",
						ready_for_input: true,
						created_at: "2026-07-11T00:00:00.000Z",
					})}\n`,
				);
				return {
					name: input.sessionId,
					cwd: input.cwd,
					createdAt: new Date().toISOString(),
					tmux_session: `tmux-stop-sess-${n}`,
					sessionId: input.sessionId,
					launchId: input.launchId,
					readinessMarkerFile: input.readinessMarkerFile,
				};
			},
			// Owner-proof termination is injected: the real forceCloseGjcTmuxSession is exercised only
			// by the Linux-only integration test; here we drive success/failure deterministically.
			forceCloseSession: async (name: string) => {
				calls.push(name);
				return opts.forceClose ? opts.forceClose(name) : {};
			},
		},
	});
	return { server, env, calls: () => calls };
}

/** Write an idle ephemeral session (no active turn) directly, matching a completed delegate worker. */
async function writeEphemeralSession(env: Record<string, string>, id: string): Promise<void> {
	const ns = coordinatorNamespacePath(buildCoordinatorMcpConfig(env));
	await fs.mkdir(path.join(ns, "sessions"), { recursive: true });
	await fs.writeFile(
		path.join(ns, "sessions", `${id}.json`),
		JSON.stringify({
			session_id: id,
			ephemeral: true,
			tmux_session: `tmux-${id}`,
			created_at: new Date().toISOString(),
		}),
	);
}

describe("gjc_coordinator_stop_session", () => {
	it("refuses non-ephemeral without force, and never signals termination", async () => {
		await withTempRoot(async root => {
			const { server, calls } = makeServer(root);
			const started = await server.callTool("gjc_coordinator_start_session", { cwd: root, allow_mutation: true });
			const id = String((started.session as { session_id: string }).session_id);
			const refused = await server.callTool("gjc_coordinator_stop_session", {
				session_id: id,
				allow_mutation: true,
			});
			expect(refused).toMatchObject({ ok: false, reason: "not_ephemeral", killed: false });
			expect(calls()).toEqual([]);
		});
	});

	it("refuses force when the force-stop capability is disabled", async () => {
		await withTempRoot(async root => {
			const { server, calls } = makeServer(root, { forceStop: false });
			const started = await server.callTool("gjc_coordinator_start_session", { cwd: root, allow_mutation: true });
			const id = String((started.session as { session_id: string }).session_id);
			const denied = await server.callTool("gjc_coordinator_stop_session", {
				session_id: id,
				force: true,
				allow_mutation: true,
			});
			expect(denied).toMatchObject({ ok: false, reason: "force_not_authorized", killed: false });
			expect(calls()).toEqual([]);
		});
	});

	it("reaps an idle ephemeral session and purges only after verified termination", async () => {
		await withTempRoot(async root => {
			const { server, env, calls } = makeServer(root);
			await writeEphemeralSession(env, "idle-eph");
			const reaped = await server.callTool("gjc_coordinator_stop_session", {
				session_id: "idle-eph",
				allow_mutation: true,
			});
			expect(reaped).toMatchObject({ ok: true, killed: true });
			expect(calls().length).toBe(1); // owner-proof termination invoked exactly once
			const status = await server.callTool("gjc_coordinator_read_status", { session_id: "idle-eph" });
			expect(status.session ?? null).toBeNull(); // purged
		});
	});

	it("force-reaps a non-ephemeral session when the capability is enabled", async () => {
		await withTempRoot(async root => {
			const { server, calls } = makeServer(root, { forceStop: true });
			const started = await server.callTool("gjc_coordinator_start_session", { cwd: root, allow_mutation: true });
			const id = String((started.session as { session_id: string }).session_id);
			const reaped = await server.callTool("gjc_coordinator_stop_session", {
				session_id: id,
				force: true,
				allow_mutation: true,
			});
			expect(reaped).toMatchObject({ ok: true, killed: true });
			expect(calls().length).toBe(1);
		});
	});

	it("keeps the record for retry when termination fails (no purge, no false reaped event)", async () => {
		await withTempRoot(async root => {
			const { server, env } = makeServer(root, {
				forceClose: async () => {
					throw new Error("gjc_tmux_owner_generation_mismatch:x");
				},
			});
			await writeEphemeralSession(env, "wedged-eph");
			const failed = await server.callTool("gjc_coordinator_stop_session", {
				session_id: "wedged-eph",
				allow_mutation: true,
			});
			expect(failed).toMatchObject({ ok: false, reason: "terminate_failed", killed: false });
			// Record survives so a later sweep can retry — never orphan a live tmux session.
			const status = await server.callTool("gjc_coordinator_read_status", { session_id: "wedged-eph" });
			expect(status.session ?? null).not.toBeNull();
		});
	});

	it("refuses to reap a session with an active turn (kill-time TOCTOU guard)", async () => {
		await withTempRoot(async root => {
			const { server, calls } = makeServer(root);
			// A delegate leaves an active turn; the reaper must not kill mid-turn.
			const d = await server.callTool("gjc_delegate_execute", { task: "x", cwd: root, allow_mutation: true });
			const id = String((d as { session_id: string }).session_id);
			const blocked = await server.callTool("gjc_coordinator_stop_session", {
				session_id: id,
				allow_mutation: true,
			});
			expect(blocked).toMatchObject({ ok: false, reason: "active_turn", killed: false });
			expect(calls()).toEqual([]); // never signalled
		});
	});

	it("returns unknown_session for a missing id", async () => {
		await withTempRoot(async root => {
			const { server } = makeServer(root);
			const missing = await server.callTool("gjc_coordinator_stop_session", {
				session_id: "nope",
				allow_mutation: true,
			});
			expect(missing).toMatchObject({ ok: false, reason: "unknown_session", killed: false });
		});
	});
});

// Real-tmux safety: exercises the REAL forceCloseGjcTmuxSession (no injection) to prove the
// owner-proof path refuses a foreign/non-GJC tmux session and the reaper keeps the record rather
// than orphaning it — the core #2034 blocker (raw process.kill / PID-reuse) is gone.
const tmuxBin = Bun.which("tmux");
describe.skipIf(!tmuxBin)("stop_session real-tmux owner safety", () => {
	it("real owner-proof termination refuses a foreign non-GJC session; it survives and the record is kept", async () => {
		await withTempRoot(async root => {
			const env = baseEnv(root);
			// No forceCloseSession injection → the REAL forceCloseGjcTmuxSession runs.
			const server = createCoordinatorMcpServer({ env });
			const foreign = `verify-foreign-${Date.now()}`;
			spawnSync("tmux", ["new-session", "-d", "-s", foreign, "sleep", "600"]);
			try {
				expect(spawnSync("tmux", ["has-session", "-t", foreign]).status).toBe(0);
				// A coordinator ephemeral record that (mistakenly) points at the foreign session.
				const ns = coordinatorNamespacePath(buildCoordinatorMcpConfig(env));
				await fs.mkdir(path.join(ns, "sessions"), { recursive: true });
				await fs.writeFile(
					path.join(ns, "sessions", "eph-foreign.json"),
					JSON.stringify({
						session_id: "eph-foreign",
						ephemeral: true,
						tmux_session: foreign,
						created_at: new Date().toISOString(),
					}),
				);

				const res = await server.callTool("gjc_coordinator_stop_session", {
					session_id: "eph-foreign",
					allow_mutation: true,
				});
				// Owner-proof refuses a non-GJC session → no kill, record kept for inspection/retry.
				expect(res).toMatchObject({ ok: false, reason: "terminate_failed", killed: false });
				expect(spawnSync("tmux", ["has-session", "-t", foreign]).status).toBe(0); // foreign survives
				const status = await server.callTool("gjc_coordinator_read_status", { session_id: "eph-foreign" });
				expect(status.session ?? null).not.toBeNull(); // record kept
			} finally {
				spawnSync("tmux", ["kill-session", "-t", foreign]);
			}
		});
	});
});

// BLOCKER 2 (#2044): the delegate reuse turn-activation now runs under the same per-session
// withSessionMutation lock as the reaper/stop_session. A session the reaper already reaped can no
// longer be silently reused (lost work), and no turn/state file is orphaned onto a killed session.
describe("reaper ↔ delegate-reuse composition", () => {
	it("a reaped session cleanly rejects a subsequent reused delegate and leaves no orphaned files", async () => {
		await withTempRoot(async root => {
			const { server, env } = makeServer(root);
			await writeEphemeralSession(env, "eph");
			const reaped = await server.callTool("gjc_coordinator_stop_session", {
				session_id: "eph",
				allow_mutation: true,
			});
			expect(reaped).toMatchObject({ ok: true });

			// Reusing the reaped session id must fail closed — not dispatch work into a killed lane.
			const reused = await server.callTool("gjc_delegate_execute", {
				session_id: "eph",
				task: "x",
				cwd: root,
				allow_mutation: true,
			});
			expect(reused).toMatchObject({ ok: false, reason: "unknown_session" });

			const ns = coordinatorNamespacePath(buildCoordinatorMcpConfig(env));
			const files = await fs.readdir(path.join(ns, "sessions")).catch(() => [] as string[]);
			expect(files).not.toContain("eph.json"); // no orphaned session record
		});
	});
});

// The owner-proof close must be bound to the state-file identity the record actually persists.
// startTmuxSession stores that path under `runtimeStateFile`; reading the non-existent
// `sessionStateFile` key left expectedStateFile undefined for every real delegate record, making
// the binding inert. This asserts the reaper forwards the recorded runtimeStateFile.
describe("owner state-file identity binding", () => {
	it("forwards the record's persisted runtimeStateFile to forceCloseSession (production record shape)", async () => {
		await withTempRoot(async root => {
			const captured: { stateFile?: string; sid?: string } = {};
			const env = baseEnv(root);
			const server = createCoordinatorMcpServer({
				env,
				services: {
					forceCloseSession: async (_name: string, _env: NodeJS.ProcessEnv, sid?: string, stateFile?: string) => {
						captured.sid = sid;
						captured.stateFile = stateFile;
						return {};
					},
				},
			});
			const runtimeStateFile = path.join(root, ".state", "runtime-marker.json");
			const ns = coordinatorNamespacePath(buildCoordinatorMcpConfig(env));
			await fs.mkdir(path.join(ns, "sessions"), { recursive: true });
			// A completed delegate worker, exactly as production persists it: the owner state-file path
			// is on `runtimeStateFile`, and there is no `sessionStateFile` key.
			await fs.writeFile(
				path.join(ns, "sessions", "prod-eph.json"),
				JSON.stringify({
					session_id: "prod-eph",
					ephemeral: true,
					tmux_session: "tmux-prod-eph",
					runtimeStateFile,
					created_at: new Date().toISOString(),
				}),
			);

			const reaped = await server.callTool("gjc_coordinator_stop_session", {
				session_id: "prod-eph",
				allow_mutation: true,
			});
			expect(reaped).toMatchObject({ ok: true, killed: true });
			// Discriminating: with the old `record.sessionStateFile` read this was undefined.
			expect(captured.stateFile).toBe(runtimeStateFile);
		});
	});
});
