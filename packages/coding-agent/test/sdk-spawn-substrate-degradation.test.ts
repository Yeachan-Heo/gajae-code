import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
	executeTmuxOwnerIsolationPlanSync,
	type PlanResponse,
	type TmuxServerProof,
} from "../src/gjc-runtime/tmux-owner-isolation";
import type { ManagedTmuxLaunchProof } from "../src/gjc-runtime/tmux-sessions";
import { Broker } from "../src/sdk/broker/broker";
import { getBrokerIdentityKey } from "../src/sdk/broker/identity";
import {
	SessionIndex,
	type SessionIndexEvent,
	sessionIndexChecksum,
	warningsForSession,
} from "../src/sdk/broker/session-index";
import { SpawnAuthorityStore, type SpawnClaimV2 } from "../src/sdk/broker/spawn-authority";
import {
	createSpawnSubstrateProvider,
	type SpawnSubstrateProviderDependencies,
} from "../src/sdk/broker/spawn-substrate";
import { SDK_STATE_VERSION } from "../src/sdk/broker/state-version";

const temporaryDirectories: string[] = [];
const temp = async (prefix: string): Promise<string> => {
	const directory = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
	temporaryDirectories.push(directory);
	return directory;
};

afterEach(async () => {
	await Promise.all(
		temporaryDirectories.splice(0).map(directory => fs.rm(directory, { recursive: true, force: true })),
	);
});

const managedProof = (): ManagedTmuxLaunchProof => ({
	name: "managed-child",
	nativeSessionId: "$42",
	serverPid: 700,
	serverStartTime: "darwin:100",
	ownerGeneration: "owner-generation",
	sessionId: "child-session",
	sessionStateFile: "/repo/.gjc/_session-child-session/runtime/tmux-sessions/managed-child.json",
	pid: 701,
	providerIdentity: '["native-tmux","tmux",null,null]',
});

function tmuxFirstDependencies(
	overrides: Partial<SpawnSubstrateProviderDependencies> = {},
): SpawnSubstrateProviderDependencies {
	return {
		platform: "darwin",
		selectMultiplexer: () => "tmux",
		launchManaged: () => {
			throw new Error(
				"gjc_tmux_owner_isolation_scope_bootstrap_failed:planned_spawn_failed:create window failed: fork failed: Device not configured",
			);
		},
		verifyManaged: () => "verified",
		closeManaged: async () => {},
		startHeadless: () => ({ pid: 4242, terminate() {} }),
		processIncarnation: () => "darwin:4242",
		...overrides,
	};
}

const launchSpec = (cwd: string) => ({
	childSessionId: "child-session",
	cwd,
	argv: ["child-command", "--safe"],
	env: { CHILD_SETTING: "enabled" },
});

describe("spawn substrate degradation (#5128)", () => {
	it("continues to the headless substrate with its own exact proof after a tmux launch failure", async () => {
		const cwd = await temp("gjc-substrate-degrade-");
		const provider = createSpawnSubstrateProvider(tmuxFirstDependencies());
		const launched = await provider.launch(launchSpec(cwd));
		expect(launched.ok).toBeTrue();
		if (!launched.ok) throw new Error("headless substrate was not reached");
		expect(launched.proof.substrateKind).toBe("headless");
		expect(launched.proof.pid).toBe(4242);
		// The headless proof still closes only through the exact-proof contract.
		expect(await provider.verify(launched.proof)).toBe("verified");
		const foreign = { ...launched.proof, processIncarnation: "darwin:replacement" };
		expect(await provider.verify(foreign)).toBe("mismatch");
		expect(await provider.close(foreign)).toEqual({ ok: false, code: "substrate_mismatch" });
	});

	it("closes an unprovable managed substrate before continuing to the headless candidate", async () => {
		const cwd = await temp("gjc-substrate-degrade-");
		let closes = 0;
		const provider = createSpawnSubstrateProvider(
			tmuxFirstDependencies({
				launchManaged: () => managedProof(),
				verifyManaged: () => "mismatch",
				closeManaged: async () => {
					closes += 1;
				},
			}),
		);
		const launched = await provider.launch(launchSpec(cwd));
		expect(closes).toBe(1);
		expect(launched).toMatchObject({ ok: true, proof: { substrateKind: "headless" } });
	});

	it("refuses to degrade when the managed cleanup failed and residue may be alive", async () => {
		const cwd = await temp("gjc-substrate-degrade-");
		let headlessStarted = false;
		const provider = createSpawnSubstrateProvider(
			tmuxFirstDependencies({
				launchManaged: () => {
					throw new AggregateError(
						[
							new Error("gjc_tmux_managed_launch_proof_unavailable"),
							new Error("gjc_tmux_cleanup_target_changed"),
						],
						"gjc_tmux_managed_launch_proof_failed_cleanup_failed",
					);
				},
				startHeadless: () => {
					headlessStarted = true;
					return { pid: 4242, terminate() {} };
				},
			}),
		);
		const launched = await provider.launch(launchSpec(cwd));
		expect(launched.ok).toBeFalse();
		if (launched.ok) throw new Error("a live tmux residue must not gain a second child");
		expect(launched.code).toBe("substrate_proof_failed");
		expect(launched.diagnostic).toContain("gjc_tmux_managed_launch_proof_failed_cleanup_failed");
		expect(launched.diagnostic).not.toContain("headless_");
		expect(headlessStarted).toBeFalse();
	});

	it("refuses to degrade when the owner isolation layer reports cleanup uncertainty", async () => {
		const cwd = await temp("gjc-substrate-degrade-");
		let headlessStarted = false;
		const provider = createSpawnSubstrateProvider(
			tmuxFirstDependencies({
				launchManaged: () => {
					throw new Error("gjc_tmux_owner_isolation_scope_bootstrap_failed:bootstrap_cleanup_uncertain");
				},
				startHeadless: () => {
					headlessStarted = true;
					return { pid: 4242, terminate() {} };
				},
			}),
		);
		expect(await provider.launch(launchSpec(cwd))).toMatchObject({
			ok: false,
			code: "substrate_proof_failed",
		});
		expect(headlessStarted).toBeFalse();
	});

	it("refuses to degrade when the exact-proof close of an unprovable managed substrate is rejected", async () => {
		const cwd = await temp("gjc-substrate-degrade-");
		let headlessStarted = false;
		const provider = createSpawnSubstrateProvider(
			tmuxFirstDependencies({
				launchManaged: () => managedProof(),
				verifyManaged: () => "mismatch",
				closeManaged: async () => {
					throw new Error("gjc_tmux_owner_changed:managed-child");
				},
				startHeadless: () => {
					headlessStarted = true;
					return { pid: 4242, terminate() {} };
				},
			}),
		);
		const launched = await provider.launch(launchSpec(cwd));
		expect(launched.ok).toBeFalse();
		if (launched.ok) throw new Error("an unclosed managed substrate must not gain a second child");
		expect(launched.code).toBe("substrate_proof_failed");
		expect(launched.diagnostic).toContain("close_failed");
		expect(headlessStarted).toBeFalse();
	});

	it("fails closed with the concrete diagnostic when every candidate substrate fails", async () => {
		const cwd = await temp("gjc-substrate-degrade-");
		const provider = createSpawnSubstrateProvider(
			tmuxFirstDependencies({
				startHeadless: () => {
					throw new Error("spawn EAGAIN");
				},
			}),
		);
		const launched = await provider.launch(launchSpec(cwd));
		expect(launched.ok).toBeFalse();
		if (launched.ok) throw new Error("an unavailable substrate set must fail closed");
		expect(launched.code).toBe("substrate_unavailable");
		expect(launched.diagnostic).toContain("planned_spawn_failed");
		expect(launched.diagnostic).toContain("Device not configured");
		expect(launched.diagnostic).toContain("headless_launch_failed");
		expect(launched.message).toContain("Device not configured");
	});

	it("keeps an unprovable multiplexer selection terminal without starting a headless child", async () => {
		const cwd = await temp("gjc-substrate-degrade-");
		let headlessStarted = false;
		const provider = createSpawnSubstrateProvider(
			tmuxFirstDependencies({
				selectMultiplexer: () => "proof_failed",
				startHeadless: () => {
					headlessStarted = true;
					return { pid: 4242, terminate() {} };
				},
			}),
		);
		expect(await provider.launch(launchSpec(cwd))).toMatchObject({
			ok: false,
			code: "substrate_proof_failed",
		});
		expect(headlessStarted).toBeFalse();
	});

	it("bounds the diagnostic and strips control characters", async () => {
		const cwd = await temp("gjc-substrate-degrade-");
		const provider = createSpawnSubstrateProvider(
			tmuxFirstDependencies({
				launchManaged: () => {
					throw new Error(`noisy\n\u0000${"x".repeat(2000)}`);
				},
				startHeadless: () => {
					throw new Error("no substrate");
				},
			}),
		);
		const launched = await provider.launch(launchSpec(cwd));
		if (launched.ok) throw new Error("expected a closed failure");
		expect(launched.diagnostic?.length).toBeLessThanOrEqual(400);
		expect(launched.diagnostic).not.toContain("\n");
		expect(launched.diagnostic).not.toContain("\u0000");
	});
});

describe("planned tmux execution diagnostics (#5128)", () => {
	const server: TmuxServerProof = { state: "safe", pid: 1, startTime: "not-applicable", pidProven: false };
	const plan: PlanResponse = {
		schema_version: 1,
		ok: true,
		code: "not_required",
		execution: {
			mode: "direct",
			argv: ["tmux", "new-session"],
			attempt_session: "gjc-child",
			server_key: "tmux",
			server_absent_before: true,
		},
		classification: { classification: "not_applicable" },
		server_state: "absent",
	};

	it("carries the spawn stderr out of a failed planned execution", () => {
		const outcome = executeTmuxOwnerIsolationPlanSync(plan, {
			socketKey: "tmux",
			spawn: () => ({
				exitCode: 1,
				stdout: "",
				stderr: "create window failed: fork failed: Device not configured\n",
			}),
			probeServer: () => server,
		});
		expect(outcome).toEqual({
			ok: false,
			code: "scope_bootstrap_failed",
			diagnostic: "planned_spawn_failed",
			detail: "create window failed: fork failed: Device not configured",
		});
	});

	it("omits the detail when the failed spawn produced no stderr", () => {
		const outcome = executeTmuxOwnerIsolationPlanSync(plan, {
			socketKey: "tmux",
			spawn: () => ({ exitCode: 1, stdout: "", stderr: "  \n" }),
			probeServer: () => server,
		});
		expect(outcome).toEqual({
			ok: false,
			code: "scope_bootstrap_failed",
			diagnostic: "planned_spawn_failed",
		});
	});
});

describe("Broker spawn diagnostic propagation (#5128)", () => {
	const verifier = { verifyMasterCapability: async () => ({ allowed: true }) };
	const spawnInput = () => ({
		task: "diagnostic-task",
		masterCapability: "diagnostic-capability",
		ownerSessionId: "master-diagnostic",
		attestationEpoch: "epoch-diagnostic",
		cwd: process.cwd(),
	});

	/** The issue's acceptance observable: the SPAWN RESPONSE must name the substrate that won. */
	it("answers spawn_accepted with substrateKind headless after a real tmux-first degradation", async () => {
		const agentDir = await temp("gjc-spawn-degraded-");
		let managedLaunches = 0;
		let headlessLaunches = 0;
		const broker = new Broker({
			agentDir,
			masterCapabilityVerifier: verifier,
			spawnSubstrateProvider: createSpawnSubstrateProvider({
				platform: "darwin",
				selectMultiplexer: () => "tmux",
				launchManaged: () => {
					managedLaunches += 1;
					throw new Error(
						"gjc_tmux_owner_isolation_scope_bootstrap_failed:planned_spawn_failed:create window failed: fork failed: Device not configured",
					);
				},
				verifyManaged: () => "verified",
				closeManaged: async () => {},
				startHeadless: () => {
					headlessLaunches += 1;
					return { pid: 4343, terminate() {} };
				},
				processIncarnation: () => "darwin:4343",
			}),
			spawnPromptLayer: {
				awaitRegistration: async (input: { childId: string; cwd: string; stateRoot: string }) => ({
					ok: true as const,
					registration: {
						sessionId: input.childId,
						endpointGeneration: 1,
						pid: 4343,
						processIncarnation: "darwin:4343",
						cwd: input.cwd,
						stateRoot: input.stateRoot,
					},
				}),
				dispatch: async () => ({
					kind: "accepted" as const,
					commandId: "cmd-degraded",
					turnId: "turn-degraded",
					acceptedAt: Date.now(),
				}),
				reconcile: async () => ({
					status: "terminal_ok" as const,
					commandId: "cmd-degraded",
					turnId: "turn-degraded",
				}),
			},
		});
		await broker.start();
		try {
			const response = (await broker.handleRequest(
				"session.spawn",
				{ ...spawnInput(), cwd: agentDir },
				"degraded-key",
			)) as { ok: boolean; result?: { code?: string; substrateKind?: string } };
			expect(response.ok).toBeTrue();
			expect(response.result?.code).toBe("spawn_accepted");
			expect(response.result?.substrateKind).toBe("headless");
			expect(managedLaunches).toBe(1);
			expect(headlessLaunches).toBe(1);
		} finally {
			await broker.stop();
		}
	});

	it("reports and durably records the substrate diagnostic of a failed spawn", async () => {
		const agentDir = await temp("gjc-spawn-diagnostic-");
		const diagnostic =
			"tmux_launch_failed:gjc_tmux_owner_isolation_scope_bootstrap_failed:planned_spawn_failed:create window failed: fork failed: Device not configured | headless_launch_failed:spawn EAGAIN";
		const broker = new Broker({
			agentDir,
			masterCapabilityVerifier: verifier,
			spawnSubstrateProvider: {
				launch: async () => ({
					ok: false as const,
					code: "substrate_unavailable" as const,
					message: `No safe spawn substrate is available. (${diagnostic})`,
					diagnostic,
				}),
				verify: async () => "gone" as const,
				close: async () => ({ ok: true }),
			},
			spawnPromptLayer: {
				awaitRegistration: async () => ({ ok: false as const }),
				dispatch: async () => ({ kind: "pre_send_rejected" as const }),
				reconcile: async () => ({ status: "unknown" as const }),
			},
		});
		await broker.start();
		try {
			const response = (await broker.handleRequest("session.spawn", spawnInput(), "diagnostic-key")) as {
				ok: boolean;
				error?: { code?: string; message?: string };
			};
			expect(response.ok).toBeFalse();
			expect(response.error?.code).toBe("spawn_failed");
			expect(response.error?.message).toContain("Device not configured");

			const brokerKey = await getBrokerIdentityKey(agentDir);
			const store = new SpawnAuthorityStore(agentDir, brokerKey);
			await store.open();
			const claim = store.claims().find(candidate => candidate.state === "pre_send_rejected");
			expect(claim?.substrateDiagnostic).toBe(diagnostic);

			// The terminal replay answers with the same recorded evidence.
			const replay = (await broker.handleRequest("session.spawn", spawnInput(), "diagnostic-key")) as {
				ok: boolean;
				error?: { message?: string };
			};
			expect(replay.ok).toBeFalse();
			expect(replay.error?.message).toContain("Device not configured");
		} finally {
			await broker.stop();
		}
	});

	it("refuses to persist a control-character diagnostic", async () => {
		const agentDir = await temp("gjc-spawn-diagnostic-");
		const store = new SpawnAuthorityStore(agentDir, "a".repeat(64));
		await store.open();
		const owner = await store.claimOrJoin("bad-diagnostic", "b".repeat(64));
		if (owner.kind !== "owner") throw new Error("expected owner");
		await expect(
			store.persistTransition("bad-diagnostic", {
				claimId: owner.claim.claimId,
				from: "prepared",
				to: "pre_send_rejected",
				substrateDiagnostic: "line one\nline two",
			}),
		).rejects.toThrow();
		const accepted: SpawnClaimV2 = (
			await store.persistTransition("bad-diagnostic", {
				claimId: owner.claim.claimId,
				from: "prepared",
				to: "pre_send_rejected",
				substrateDiagnostic: "tmux_launch_failed:fork failed",
			})
		).claim;
		expect(accepted.substrateDiagnostic).toBe("tmux_launch_failed:fork failed");
	});
});

describe("session index warning scoping (#5128)", () => {
	async function writeRows(directory: string, rows: Record<string, unknown>[]): Promise<void> {
		const sessionsDir = path.join(directory, "sdk", "sessions");
		await fs.mkdir(sessionsDir, { recursive: true });
		const lines = rows
			.map(row =>
				JSON.stringify({
					...row,
					checksum: sessionIndexChecksum(row as unknown as Omit<SessionIndexEvent, "checksum">),
				}),
			)
			.join("\n");
		await fs.writeFile(path.join(sessionsDir, "index.jsonl"), `${lines}\n`);
	}

	it("keeps a warned unrelated row from fencing a healthy row", async () => {
		const directory = await temp("gjc-index-scoped-warning-");
		const stateRoot = path.join(directory, ".gjc", "state");
		await writeRows(directory, [
			{
				version: SDK_STATE_VERSION,
				indexSeq: 1,
				type: "host_registered",
				sessionId: "legacy-session",
				locator: { repo: directory, stateRoot },
				endpointGeneration: 1,
				pid: process.pid,
				ts: Date.now(),
			},
			{
				version: SDK_STATE_VERSION,
				indexSeq: 2,
				type: "host_registered",
				sessionId: "healthy-session",
				locator: { cwd: directory, worktreeRoot: null, stateRoot },
				endpointGeneration: 1,
				pid: process.pid,
				ts: Date.now(),
			},
		]);
		const index = await new SessionIndex(directory).open();
		const listing = index.listSessions();
		expect(listing.warnings).toContain("Session legacy-session has a legacy locator row and must re-register.");
		expect(warningsForSession(listing, "healthy-session")).toEqual([]);
		expect(warningsForSession(listing, "legacy-session")).toEqual([
			"Session legacy-session has a legacy locator row and must re-register.",
		]);
	});

	it("keeps an index-wide fault fencing every session", () => {
		const listing = {
			indexSeq: 1,
			sessions: [],
			warnings: ["Corrupt session index entry; replay truncated"],
			warningScope: { indexWide: ["Corrupt session index entry; replay truncated"], rows: {} },
		};
		expect(warningsForSession(listing, "any-session")).toEqual(["Corrupt session index entry; replay truncated"]);
	});

	it("fences two rows that raised an identical warning independently", () => {
		const duplicated = "Session index row was rejected.";
		const listing = {
			indexSeq: 1,
			sessions: [],
			warnings: [duplicated, duplicated],
			warningScope: { indexWide: [], rows: { first: [duplicated], second: [duplicated] } },
		};
		expect(warningsForSession(listing, "first")).toEqual([duplicated]);
		expect(warningsForSession(listing, "second")).toEqual([duplicated]);
		expect(warningsForSession(listing, "third")).toEqual([]);
	});

	it("scopes generationStatus to the requested row", async () => {
		const directory = await temp("gjc-index-scoped-generation-");
		const stateRoot = path.join(directory, ".gjc", "state");
		await writeRows(directory, [
			{
				version: SDK_STATE_VERSION,
				indexSeq: 1,
				type: "host_registered",
				sessionId: "legacy-session",
				locator: { repo: directory, stateRoot },
				endpointGeneration: 1,
				pid: process.pid,
				ts: Date.now(),
			},
			{
				version: SDK_STATE_VERSION,
				indexSeq: 2,
				type: "host_registered",
				sessionId: "healthy-session",
				locator: { cwd: directory, worktreeRoot: null, stateRoot },
				endpointGeneration: 4,
				pid: process.pid,
				ts: Date.now(),
			},
		]);
		const index = await new SessionIndex(directory).open();
		// The unrelated legacy row no longer makes THIS row's generation unreportable.
		// The row still carries no process incarnation, so it reconciles no further
		// than `reconciliation_incomplete`; the point is that it is not index_incomplete.
		const healthy = await index.generationStatus("healthy-session", 4);
		expect(healthy).not.toMatchObject({ reason: "index_incomplete" });
		const warned = await index.generationStatus("legacy-session", 1);
		expect(warned).toMatchObject({ status: "unknown", reason: "index_incomplete" });
	});

	it("treats every warning as index-wide when no row attribution is published", () => {
		const listing = { indexSeq: 1, sessions: [], warnings: ["corrupt index suffix"] };
		expect(warningsForSession(listing, "any-session")).toEqual(["corrupt index suffix"]);
	});
});
