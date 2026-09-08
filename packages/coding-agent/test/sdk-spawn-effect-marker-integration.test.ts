import { expect, test, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
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
				verify: async () => "verified",
				resolveLifecycleOwner: async () => ({ ok: true, owner: { pid: 4321, incarnation: "inc-4321" } }),
				close: async () => {
					closes += 1;
					return { ok: true };
				},
			},
		});
		await broker.start();
		try {
			await attest(broker, root);
			const response = await spawn(broker, root);
			expect(response.ok).toBe(false);
			expect(closes).toBe(1);
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
			} else {
				expect(response).toMatchObject({ ok: false, error: { code: "terminal_uncertain" } });
				expect(JSON.stringify(response)).not.toContain(task);
				if (scenario === "write_failure") expect(registrations).toBe(0);
				else {
					expect(store.claims()[0]?.state).toBe("uncertain");
					expect(JSON.stringify(response).includes("startup/failed")).toBe(scenario === "startup_failure");
				}
			}
		} finally {
			await broker.stop();
			await fs.rm(root, { recursive: true, force: true });
		}
	});
}

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
		if (launchedProof) {
			if ((await provider.verify(launchedProof)) !== "gone") {
				expect(await provider.close(launchedProof)).toMatchObject({ ok: true });
			}
			expect(await provider.verify(launchedProof)).toBe("gone");
		}
		await broker.stop();
		setLifecycleCommandResolverForTest(broker, undefined);
		await fs.rm(root, { recursive: true, force: true });
	}
}, 30_000);
