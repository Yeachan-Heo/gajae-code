import { expect, test, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { Process } from "@gajae-code/natives";
import { nativeProcessBindings } from "@gajae-code/utils/native-process";
import { executeTmuxOwnerIsolationPlanSync } from "../src/gjc-runtime/tmux-owner-isolation";
import {
	__setCreateOwnerIsolationForTests,
	createManagedGjcTmuxSession,
	type ManagedTmuxLaunchProof,
} from "../src/gjc-runtime/tmux-sessions";
import { Broker, type SpawnPromptLayer } from "../src/sdk/broker/broker";
import { getBrokerIdentityKey } from "../src/sdk/broker/identity";
import { setLifecycleCommandResolverForTest, writeSessionLifecycleFailure } from "../src/sdk/broker/lifecycle";
import { processIncarnation } from "../src/sdk/broker/process-incarnation";
import { SpawnAuthorityStore, type SpawnSubstrateProof } from "../src/sdk/broker/spawn-authority";
import { createSpawnSubstrateProvider } from "../src/sdk/broker/spawn-substrate";

const ownerId = "marker-test-owner";
const epoch = "marker-test-epoch";
const task = "private marker test task";

async function attest(broker: Broker, cwd: string): Promise<void> {
	const incarnation = processIncarnation(process.pid);
	if (!incarnation) throw new Error("Test owner has no process incarnation");
	for (const endpointGeneration of [0, 1]) {
		await broker.index.append({
			type: "host_registered",
			sessionId: ownerId,
			locator: { cwd, worktreeRoot: null, stateRoot: path.join(cwd, ".gjc", "state") },
			endpointGeneration,
			pid: process.pid,
			hostIncarnation: incarnation,
			masterRole: {
				version: 2,
				ownerSessionId: ownerId,
				launchPid: process.pid,
				launchProcessIncarnation: incarnation,
				role: "master",
				attestationEpoch: epoch,
			},
		});
	}
}

async function spawn(broker: Broker, cwd: string) {
	return broker.handleRequest(
		"session.spawn",
		{
			cwd,
			task,
			ownerSessionId: ownerId,
			masterCapability: "fixture-grant",
			attestationEpoch: epoch,
		},
		"marker-test-key",
	);
}

const verifier = { verifyMasterCapability: async () => ({ allowed: true }) };
const proof: SpawnSubstrateProof = {
	substrateKind: "headless",
	providerIdentity: "marker-fixture",
	pid: 4321,
	processIncarnation: "inc-4321",
};

for (const scenario of [
	"missing_pid",
	"missing_incarnation",
	"write_failure",
	"startup_failure",
	"stale_failure",
	"unproven_close",
	"unproven_verify",
] as const) {
	test(`spawn effect marker: ${scenario}`, async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-spawn-marker-"));
		let childId = "";
		let effectMarker = "";
		let closes = 0;
		let registrations = 0;
		const stateRoot = path.join(root, ".gjc", "state");
		const markerPath = () => path.join(stateRoot, "sdk", `${childId}.lifecycle.json`);
		const launchedProof = { ...proof };
		if (scenario === "missing_pid") delete launchedProof.pid;
		if (scenario === "missing_incarnation") delete launchedProof.processIncarnation;

		// A substrate that cannot be proven released keeps the claim uncertain; a
		// proven close or gone observation terminalizes it (#5542, #5728).
		const unprovenRelease = scenario === "unproven_close" || scenario === "unproven_verify";
		const layer: SpawnPromptLayer = {
			awaitRegistration: async () => {
				registrations += 1;
				expect(await Bun.file(markerPath()).json()).toEqual({ pid: 4321, incarnation: "inc-4321", effectMarker });
				await writeSessionLifecycleFailure(
					stateRoot,
					childId,
					effectMarker,
					{ phase: "startup", reason: "failed", message: task },
					{
						endpointGeneration: null,
						fenced: true,
						runtimeRemoved: true,
						hostStopped: true,
						brokerRegistrationReleased: true,
					},
					undefined,
					scenario === "stale_failure" ? "stale-incarnation" : "inc-4321",
					4321,
				);
				return { ok: false };
			},
			dispatch: async () => {
				throw new Error("Seed must not be sent");
			},
			reconcile: async () => ({ status: "unknown" }),
		};
		const broker = new Broker({
			agentDir: path.join(root, "agent"),
			masterCapabilityVerifier: verifier,
			spawnPromptLayer: layer,
			spawnSubstrateProvider: {
				launch: async spec => {
					childId = spec.childSessionId;
					effectMarker = spec.env?.GJC_LIFECYCLE_REQUEST_ID ?? "";
					if (scenario === "write_failure") await fs.mkdir(markerPath(), { recursive: true });
					return { ok: true, proof: launchedProof };
				},
				verify: async () => (scenario === "unproven_verify" ? "mismatch" : "verified"),
				resolveLifecycleOwner: async () => ({ ok: true, owner: { pid: 4321, incarnation: "inc-4321" } }),
				close: async () => {
					closes += 1;
					return { ok: scenario !== "unproven_close" };
				},
			},
		});
		await broker.start();
		try {
			await attest(broker, root);
			const response = await spawn(broker, root);
			expect(response.ok).toBe(false);
			const store = new SpawnAuthorityStore(
				broker.settings.agentDir,
				await getBrokerIdentityKey(broker.settings.agentDir),
			);
			await store.open();
			if (scenario === "missing_pid" || scenario === "missing_incarnation") {
				expect(response).toMatchObject({
					ok: false,
					error: { code: "spawn_failed", details: { code: "substrate_proof_failed" } },
				});
				expect(store.claims()[0]?.state).toBe("pre_send_rejected");
				expect(await Bun.file(markerPath()).exists()).toBe(false);
				expect(registrations).toBe(0);
				expect(closes).toBe(1);
			} else if (unprovenRelease) {
				// The substrate could not be proven released, so the claim must stay
				// uncertain instead of being collapsed into an ordinary failure.
				expect(response).toMatchObject({ ok: false, error: { code: "terminal_uncertain" } });
				expect(store.claims()[0]?.failure?.code).toBe("child_registration_release_unproven");
				expect(JSON.stringify(response)).not.toContain(task);
				expect(store.claims()[0]?.state).toBe("uncertain");
				expect(registrations).toBe(1);
				expect(closes).toBe(scenario === "unproven_close" ? 1 : 0);
			} else {
				// A proven close or gone observation terminalizes: the substrate is gone,
				// so reporting uncertainty here would be a lie (#5728).
				expect(response).toMatchObject({
					ok: false,
					error: {
						code: "spawn_failed",
						details: {
							code: scenario === "stale_failure" ? "child_registration_timeout" : "child_registration_failed",
						},
					},
				});
				expect(JSON.stringify(response)).not.toContain(task);
				expect(store.claims()[0]?.state).toBe("pre_send_rejected");
				if (scenario === "write_failure") expect(registrations).toBe(0);
				else {
					expect(registrations).toBe(1);
					expect(JSON.stringify(response).includes("startup/failed")).toBe(scenario === "startup_failure");
				}
				expect(closes).toBe(1);
			}
		} finally {
			await broker.stop();
			await fs.rm(root, { recursive: true, force: true });
		}
	});
}

// An unresolved owner is a deterministic failure only once the substrate release
// is proven; a release that cannot be proven keeps the claim uncertain.
for (const release of ["proven", "unproven"] as const) {
	test(`unresolved lifecycle owner with ${release} release writes no marker or seed`, async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-spawn-owner-release-"));
		let childId = "";
		let closes = 0;
		let registrations = 0;
		const stateRoot = path.join(root, ".gjc", "state");
		const broker = new Broker({
			agentDir: path.join(root, "agent"),
			masterCapabilityVerifier: verifier,
			spawnPromptLayer: {
				awaitRegistration: async () => {
					registrations += 1;
					return { ok: false };
				},
				dispatch: async () => {
					throw new Error("Seed must not be sent");
				},
				reconcile: async () => ({ status: "unknown" }),
			},
			spawnSubstrateProvider: {
				launch: async spec => {
					childId = spec.childSessionId;
					return { ok: true, proof: { ...proof, substrateKind: "tmux" } };
				},
				verify: async () => "verified",
				resolveLifecycleOwner: async () => ({ ok: false, code: "owner_deadline" }),
				close: async () => {
					closes += 1;
					return { ok: release === "proven" };
				},
			},
		});
		await broker.start();
		try {
			await attest(broker, root);
			const response = await spawn(broker, root);
			const store = new SpawnAuthorityStore(
				broker.settings.agentDir,
				await getBrokerIdentityKey(broker.settings.agentDir),
			);
			await store.open();
			const claims = store.claims();
			expect(claims).toHaveLength(1);
			if (release === "proven") {
				expect(response).toMatchObject({
					ok: false,
					error: { code: "spawn_failed", details: { code: "lifecycle_owner_unresolved" } },
				});
				expect(claims[0]).toMatchObject({
					state: "pre_send_rejected",
					failure: { code: "lifecycle_owner_unresolved" },
				});
			} else {
				expect(response).toMatchObject({ ok: false, error: { code: "terminal_uncertain" } });
				expect(claims[0]).toMatchObject({
					state: "uncertain",
					failure: { code: "child_registration_release_unproven" },
				});
			}
			expect(claims[0]?.seed).toBeUndefined();
			expect(closes).toBe(1);
			expect(registrations).toBe(0);
			expect(await Bun.file(path.join(stateRoot, "sdk", `${childId}.lifecycle.json`)).exists()).toBe(false);
			expect(broker.index.listSessionIdentities().filter(row => row.sessionId !== ownerId)).toHaveLength(0);
		} finally {
			await broker.stop();
			await fs.rm(root, { recursive: true, force: true });
		}
	});
}

const sourceCli = path.resolve(import.meta.dir, "../src/cli.ts");

// A real Linux service cgroup needs the existing user bus to establish its
// isolated owner scope. Do not inherit unrelated host configuration or state.
const linuxUserBusEnvironment: NodeJS.ProcessEnv = {};
if (process.platform === "linux") {
	for (const name of ["XDG_RUNTIME_DIR", "DBUS_SESSION_BUS_ADDRESS"] as const) {
		const value = process.env[name];
		if (value !== undefined) linuxUserBusEnvironment[name] = value;
	}
}

function captureScopedBootstrap(
	launch: () => ManagedTmuxLaunchProof,
	environment: NodeJS.ProcessEnv,
	diagnostics: string[],
): ManagedTmuxLaunchProof {
	__setCreateOwnerIsolationForTests({
		execute: (plan, dependencies) =>
			executeTmuxOwnerIsolationPlanSync(plan, {
				...dependencies,
				spawn: (argv, stdinLine) => {
					const result = dependencies.spawn(argv, stdinLine);
					if (plan.ok && plan.execution.mode === "scoped" && diagnostics.length < 2) {
						const secrets = [plan.execution.attempt.token, ...Object.values(environment)].filter(
							(value): value is string => typeof value === "string" && value.length > 0,
						);
						const redact = (text: string) => {
							for (const secret of secrets) text = text.replaceAll(secret, "[redacted]");
							return text.slice(0, 4096);
						};
						diagnostics.push(
							JSON.stringify({
								exitCode: result.exitCode,
								stdout: redact(result.stdout ?? ""),
								stderr: redact(result.stderr ?? ""),
							}),
						);
					}
					return result;
				},
			}),
	});
	try {
		return launch();
	} finally {
		__setCreateOwnerIsolationForTests(null);
	}
}

test("managed wrong outer cannot register a valid inner CLI or substitute headless", async () => {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-wrong-outer-"));
	const env = {
		...linuxUserBusEnvironment,
		PATH: process.env.PATH ?? "",
		LANG: process.platform === "darwin" ? "en_US.UTF-8" : "C.UTF-8",
		HOME: root,
		TMPDIR: root,
		TMUX_TMPDIR: root,
		BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0",
	};
	let launched: SpawnSubstrateProof | undefined;
	const retained: { process: Process | null } = { process: null };
	let allocations = 0;
	let validInnerObserved = false;
	let headlessAttempts = 0;
	let passed = false;
	let cleanupProven = false;
	const bootstrapDiagnostics: string[] = [];
	const provider = createSpawnSubstrateProvider({
		env,
		selectMultiplexer: () => "tmux",
		startHeadless: () => {
			headlessAttempts += 1;
			throw new Error("Forbidden headless fallback");
		},
		launchManaged: (spec, environment, platform) => {
			allocations += 1;
			expect(spec.argv).toEqual([process.execPath, "run", sourceCli, "sdk", "session-host-internal"]);
			validInnerObserved = true;
			// A genuine allocated tmux pane, but deliberately not a GJC supervisor.
			// Its bounded natural exit is containment, never readiness success.
			return captureScopedBootstrap(
				() =>
					createManagedGjcTmuxSession(spec, environment, {
						platform,
						supervisorArgvForTest: ["/bin/sleep", "5"],
					}),
				environment,
				bootstrapDiagnostics,
			);
		},
	});
	const broker = new Broker({
		agentDir: path.join(root, "agent"),
		masterCapabilityVerifier: verifier,
		spawnSubstrateProvider: {
			...provider,
			launch: async spec => {
				const result = await provider.launch({ ...spec, inheritedEnv: env });
				if (result.ok) {
					launched = result.proof;
					retained.process = nativeProcessBindings().Process.fromPid(result.proof.pid!);
				}
				return result;
			},
			resolveLifecycleOwner: (proof, deadline) =>
				provider.resolveLifecycleOwner(proof, Math.min(deadline, Date.now() + 1_000)),
		},
	});
	setLifecycleCommandResolverForTest(broker, () => ({
		file: process.execPath,
		args: ["run", sourceCli, "sdk", "session-host-internal"],
	}));
	try {
		await broker.start();
		await attest(broker, root);
		const response = await spawn(broker, root);
		expect(response.ok).toBe(false);
		expect(allocations).toBe(1);
		expect(validInnerObserved).toBe(true);
		expect(headlessAttempts).toBe(0);
		expect(broker.index.listSessionIdentities().filter(row => row.sessionId !== ownerId)).toHaveLength(0);
		const ledger = await Bun.file(path.join(broker.settings.agentDir, "sdk", "spawn-authority.jsonl")).text();
		for (const state of ["authority_active", "seed_prepared", "dispatching", "accepted"])
			expect(ledger).not.toContain(`"${state}"`);
		if (!launched) throw new Error(`Wrong-outer allocation proof was not captured; retained ${root}`);
		if (launched) {
			expect(launched.substrateKind).toBe("tmux");
			const store = new SpawnAuthorityStore(
				broker.settings.agentDir,
				await getBrokerIdentityKey(broker.settings.agentDir),
			);
			await store.open();
			const claims = store.claims();
			expect(claims).toHaveLength(1);
			if (process.platform === "linux") {
				// Linux closes the exact pane through its kernel-signaled owner path, so
				// the Broker proves the release and reports a deterministic failure.
				expect(response).toMatchObject({
					ok: false,
					error: { code: "spawn_failed", details: { code: "lifecycle_owner_unresolved" } },
				});
				expect(claims[0]).toMatchObject({
					state: "pre_send_rejected",
					failure: { code: "lifecycle_owner_unresolved" },
				});
			} else {
				// Darwin close is cooperative and needs the supervisor's published
				// binding. A wrong outer never publishes one, so release stays unproven.
				expect(response).toMatchObject({ ok: false, error: { code: "terminal_uncertain" } });
				expect(claims[0]).toMatchObject({
					state: "uncertain",
					failure: { code: "child_registration_release_unproven" },
				});
			}
			if (!retained.process) throw new Error(`Missing exact wrong-outer reference; retained ${root}`);
			expect(await retained.process.waitForExit({ timeoutMs: 5_000 })).toBe(true);
			expect(await provider.verify(launched)).toBe("gone");
		}
		// This fixture owns an isolated socket namespace. Observe absence only;
		// never kill a whole server or guess which allocated pane to remove.
		const listing = Bun.spawn(["tmux", "list-sessions", "-F", "#{session_id}"], {
			env,
			stdout: "pipe",
			stderr: "pipe",
		});
		const [stdout, stderr] = await Promise.all([
			new Response(listing.stdout).text(),
			new Response(listing.stderr).text(),
		]);
		const exit = await listing.exited;
		expect(stdout.trim()).toBe("");
		expect(exit).not.toBe(0);
		expect(stderr).toMatch(/no server running|failed to connect|error connecting/);
		cleanupProven = true;
		passed = true;
	} catch (error) {
		process.stderr.write(`${JSON.stringify({ fixture: "wrong-outer", scopedBootstrap: bootstrapDiagnostics })}\n`);
		throw new AggregateError(
			[error],
			`Wrong-outer fixture failed; scoped bootstrap: ${bootstrapDiagnostics.join("; ")}`,
		);
	} finally {
		await broker.stop();
		setLifecycleCommandResolverForTest(broker, undefined);
		if (passed && cleanupProven) await fs.rm(root, { recursive: true, force: true });
	}
}, 30_000);

test("real session.spawn publishes lifecycle authority and registers a live child before seed delivery", async () => {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-spawn-real-marker-"));
	const provider = createSpawnSubstrateProvider({ selectMultiplexer: () => "none" });
	let launchedProof: SpawnSubstrateProof | undefined;
	// Stop at the durable registration boundary, before Q26 turn admission. The
	// master-mode test covers seed acceptance with its injected prompt layer.
	const registered = Promise.withResolvers<string>();
	const release = Promise.withResolvers<void>();
	const persistTransition = SpawnAuthorityStore.prototype.persistTransition;
	const transition = vi.spyOn(SpawnAuthorityStore.prototype, "persistTransition").mockImplementation(async function (
		this: SpawnAuthorityStore,
		identity,
		input,
	) {
		const result = await persistTransition.call(this, identity, input);
		if (input.to === "authority_active") {
			registered.resolve(result.claim.childId!);
			await release.promise;
			throw new Error("Fixture stopped after proving real child registration");
		}
		return result;
	});
	const broker = new Broker({
		agentDir: path.join(root, "agent"),
		masterCapabilityVerifier: verifier,
		spawnSubstrateProvider: {
			...provider,
			launch: async spec => {
				const result = await provider.launch({
					...spec,
					inheritedEnv: { PATH: process.env.PATH ?? "", HOME: root },
				});
				if (result.ok) launchedProof = result.proof;
				return result;
			},
		},
	});
	setLifecycleCommandResolverForTest(broker, () => ({
		file: process.execPath,
		args: ["run", path.resolve(import.meta.dir, "../src/cli.ts"), "sdk", "session-host-internal"],
	}));
	let spawning: Promise<unknown> | undefined;
	try {
		await broker.start();
		await attest(broker, root);
		spawning = spawn(broker, root).then(response => {
			registered.reject(new Error(`Spawn ended before the registration checkpoint: ${JSON.stringify(response)}`));
		});
		const childId = await registered.promise;
		const rows = await broker.handleRequest("session.list", { resolveSessionId: childId });
		expect(rows).toMatchObject({ ok: true, result: { sessions: [{ sessionId: childId, live: true }] } });
		if (!rows.ok) throw new Error(rows.error.message);
		expect(
			(rows.result as { sessions: Array<{ endpointGeneration: number }> }).sessions[0]!.endpointGeneration,
		).toBeGreaterThan(0);
		const marker = await Bun.file(path.join(root, ".gjc", "state", "sdk", `${childId}.lifecycle.json`)).json();
		expect(marker).toMatchObject({ pid: launchedProof?.pid, incarnation: launchedProof?.processIncarnation });
		const ledger = await Bun.file(path.join(broker.settings.agentDir, "sdk", "spawn-authority.jsonl")).text();
		expect(ledger).toContain('"authority_active"');
		expect(ledger).not.toContain('"dispatching"');
		const store = new SpawnAuthorityStore(
			broker.settings.agentDir,
			await getBrokerIdentityKey(broker.settings.agentDir),
		);
		await store.open();
		expect(store.claims().find(claim => claim.childId === childId)?.state).toBe("authority_active");
		expect(ledger).not.toContain(task);
	} finally {
		release.resolve();
		await spawning;
		transition.mockRestore();
		if (launchedProof) await provider.close(launchedProof);
		await broker.stop();
		setLifecycleCommandResolverForTest(broker, undefined);
		await fs.rm(root, { recursive: true, force: true });
	}
}, 30_000);

test("managed task.dag advance still publishes lifecycle authority before seed delivery", async () => {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-managed-marker-"));
	const agentDir = path.join(root, "agent");
	let childId = "";
	let effectMarker = "";
	const layer: SpawnPromptLayer = {
		awaitRegistration: async () => ({ ok: false }),
		dispatch: async () => {
			throw new Error("Seed must not be sent before registration");
		},
		reconcile: async () => ({ status: "unknown" }),
	};
	const broker = new Broker({
		agentDir,
		masterCapabilityVerifier: verifier,
		spawnPromptLayer: layer,
		spawnSubstrateProvider: {
			launch: async spec => {
				childId = spec.childSessionId;
				effectMarker = spec.env?.GJC_LIFECYCLE_REQUEST_ID ?? "";
				return {
					ok: true,
					proof: { ...proof },
				};
			},
			verify: async () => "verified",
			resolveLifecycleOwner: async () => ({ ok: true, owner: { pid: 4321, incarnation: "inc-4321" } }),
			close: async () => ({ ok: true }),
		},
	});
	await broker.start();
	try {
		await attest(broker, root);
		await fs.mkdir(path.join(root, "a"), { recursive: true });
		const { managedIdentity } = await import("../src/sdk/broker/managed-task-dag");
		const define = await broker.handleRequest("task.dag", {
			action: "define",
			controlRoot: root,
			enrollmentId: "enrollment",
			graphId: "g",
			expectedRevision: 0,
			ownerSessionId: ownerId,
			attestationEpoch: epoch,
			masterCapability: "fixture-grant",
			worktrees: [root],
			nodes: [
				{
					id: "a",
					task,
					workspace: path.join(root, "a"),
					predecessors: [],
					criteriaIdentity: managedIdentity("criteria"),
					validations: [{ name: "check", command: "true" }],
					resources: [{ kind: "integration", identity: "marker-a", mode: "write" }],
					artifacts: [],
				},
			],
		});
		expect(define).toMatchObject({ ok: true });
		const advance = await broker.handleRequest(
			"task.dag",
			{
				action: "advance",
				controlRoot: root,
				enrollmentId: "enrollment",
				graphId: "g",
				nodeId: "a",
				expectedRevision: 1,
				cwd: path.join(root, "a"),
				ownerSessionId: ownerId,
				attestationEpoch: epoch,
				masterCapability: "fixture-grant",
				worktrees: [root],
			},
			"managed-marker-key",
		);
		expect(advance.ok).toBe(false);
		expect(childId.length).toBeGreaterThan(0);
		expect(effectMarker.length).toBeGreaterThan(0);
		const store = new SpawnAuthorityStore(
			broker.settings.agentDir,
			await getBrokerIdentityKey(broker.settings.agentDir),
		);
		await store.open();
		expect(store.claims().some(claim => claim.childId === childId)).toBe(true);
	} finally {
		await broker.stop();
		await fs.rm(root, { recursive: true, force: true });
	}
}, 30_000);
