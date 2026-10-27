import { afterEach, describe, expect, it, spyOn } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Broker } from "../src/sdk/broker/broker";
import { readBrokerDiscovery } from "../src/sdk/broker/discovery";
import { getBrokerIdentityKey } from "../src/sdk/broker/identity";
import {
	loadManagedEnrollmentRecord,
	managedEnrollmentIndexPath,
	managedIdentity,
	managedTaskDomainPath,
	recordManagedEnrollment,
} from "../src/sdk/broker/managed-task-dag";
import { processIncarnation } from "../src/sdk/broker/process-incarnation";
import { SpawnAuthorityStore } from "../src/sdk/broker/spawn-authority";

const roots: string[] = [];
afterEach(async () => {
	for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
});

async function nextFrame(ws: WebSocket): Promise<Record<string, unknown>> {
	return await new Promise((resolve, reject) => {
		const timer = setTimeout(() => reject(new Error("frame timeout")), 5_000);
		ws.addEventListener(
			"message",
			event => {
				clearTimeout(timer);
				resolve(JSON.parse(String(event.data)) as Record<string, unknown>);
			},
			{ once: true },
		);
	});
}

async function connect(url: string): Promise<WebSocket> {
	const ws = new WebSocket(url);
	await new Promise<void>((resolve, reject) => {
		ws.addEventListener("open", () => resolve(), { once: true });
		ws.addEventListener("error", () => reject(new Error("websocket error")), { once: true });
	});
	const hello = await nextFrame(ws);
	if (hello.type !== "broker_hello") throw new Error(`expected broker_hello, got ${JSON.stringify(hello)}`);
	return ws;
}

async function request(
	ws: WebSocket,
	id: string,
	operation: string,
	input: Record<string, unknown>,
	idempotencyKey?: string,
): Promise<Record<string, unknown>> {
	ws.send(
		JSON.stringify({ type: "broker_request", id, operation, input, ...(idempotencyKey ? { idempotencyKey } : {}) }),
	);
	for (;;) {
		const frame = await nextFrame(ws);
		if (frame.type === "broker_hello") continue;
		if (frame.id === id) return frame;
		throw new Error(`unexpected broker frame for ${id}: ${JSON.stringify(frame)}`);
	}
}

const ownerId = "managed-owner";
const epoch = "managed-epoch";
const grant = "managed-grant";
const verifier = {
	verifyMasterCapability: async (owner: string, capability: string, suppliedEpoch: string) => ({
		allowed: owner === ownerId && capability === grant && suppliedEpoch === epoch,
	}),
};

function node(id: string, workspace: string) {
	return {
		id,
		task: `Task ${id}`,
		workspace,
		predecessors: [] as string[],
		criteriaIdentity: managedIdentity("criteria"),
		validations: [{ name: "check", command: "true" }],
		resources: [{ kind: "integration" as const, identity: id, mode: "write" as const }],
		artifacts: [] as never[],
	};
}

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

function substrate(launches: { count: number }, closes: { count: number }) {
	return {
		launch: async () => {
			launches.count += 1;
			return {
				ok: true as const,
				proof: {
					substrateKind: "headless" as const,
					providerIdentity: "managed-fixture",
					pid: 4242,
					processIncarnation: "inc-4242",
				},
			};
		},
		verify: async () => "verified" as const,
		close: async () => {
			closes.count += 1;
			return { ok: true };
		},
	};
}

function promptLayer(failDispatch = false) {
	return {
		awaitRegistration: async (input: { childId: string; cwd: string; stateRoot: string }) => ({
			ok: true as const,
			registration: {
				sessionId: input.childId,
				endpointGeneration: 1,
				pid: 4242,
				processIncarnation: "inc-4242",
				cwd: input.cwd,
				stateRoot: input.stateRoot,
			},
		}),
		dispatch: async () => {
			if (failDispatch) throw new Error("simulated response loss");
			return { kind: "accepted" as const, commandId: "cmd-1", turnId: "turn-1", acceptedAt: Date.now() };
		},
		reconcile: async () => ({ status: "unknown" as const }),
	};
}

describe("managed native recovery (M3)", () => {
	it("restores enrolled managed-key refusal after broker restart without duplicate launches", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-managed-recover-"));
		roots.push(root);
		const launches = { count: 0 };
		const closes = { count: 0 };
		const agentDir = path.join(root, "agent");
		const first = new Broker({
			agentDir,
			packageGeneration: "test",
			masterCapabilityVerifier: verifier,
			spawnSubstrateProvider: substrate(launches, closes),
			spawnPromptLayer: promptLayer(),
		});
		const discovery = await first.start();
		const ws = await connect(`${discovery.url}/?token=${discovery.token}`);
		try {
			await attest(first, root);
			const auth = {
				controlRoot: root,
				enrollmentId: "enrollment",
				ownerSessionId: ownerId,
				attestationEpoch: epoch,
				masterCapability: grant,
				worktrees: [root],
			};
			expect(
				await request(ws, "define-a", "task.dag", {
					...auth,
					action: "define",
					graphId: "a",
					expectedRevision: 0,
					nodes: [node("a", root)],
				}),
			).toMatchObject({ ok: true });
			expect(
				await request(
					ws,
					"advance-a",
					"task.dag",
					{ ...auth, action: "advance", graphId: "a", nodeId: "a", expectedRevision: 1, cwd: root },
					"key-a",
				),
			).toMatchObject({ ok: true });
			expect(launches.count).toBe(1);
		} finally {
			ws.close();
			await first.stop();
		}

		const second = new Broker({
			agentDir,
			packageGeneration: "test",
			masterCapabilityVerifier: verifier,
			spawnSubstrateProvider: substrate(launches, closes),
			spawnPromptLayer: promptLayer(),
		});
		const restarted = await second.start();
		const ws2 = await connect(`${restarted.url}/?token=${restarted.token}`);
		try {
			await attest(second, root);
			const ordinary = await request(
				ws2,
				"ordinary",
				"session.spawn",
				{
					cwd: root,
					task: "Task a",
					ownerSessionId: ownerId,
					attestationEpoch: epoch,
					masterCapability: grant,
				},
				"key-a",
			);
			expect(ordinary).toMatchObject({ ok: false, error: { code: "spawn_failed" } });
			expect(launches.count).toBe(1);
			const retry = await request(
				ws2,
				"advance-again",
				"task.dag",
				{
					controlRoot: root,
					enrollmentId: "enrollment",
					ownerSessionId: ownerId,
					attestationEpoch: epoch,
					masterCapability: grant,
					worktrees: [root],
					action: "advance",
					graphId: "a",
					nodeId: "a",
					expectedRevision: 2,
					cwd: root,
				},
				"key-a-new",
			);
			expect(retry).toMatchObject({ ok: false });
			expect(launches.count).toBe(1);
			const persisted = JSON.parse(await fs.readFile(managedTaskDomainPath(root), "utf8")) as {
				graphs: Array<{ attempts: unknown[] }>;
			};
			expect(persisted.graphs.flatMap(graph => graph.attempts)).toHaveLength(1);
		} finally {
			ws2.close();
			await second.stop();
		}
	});

	it("response loss retains uncertainty and cancel does not retire without exact close", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-managed-uncertain-"));
		roots.push(root);
		const launches = { count: 0 };
		const closes = { count: 0 };
		const broker = new Broker({
			agentDir: path.join(root, "agent"),
			packageGeneration: "test",
			masterCapabilityVerifier: verifier,
			spawnSubstrateProvider: substrate(launches, closes),
			spawnPromptLayer: promptLayer(true),
		});
		const discovery = await broker.start();
		const ws = await connect(`${discovery.url}/?token=${discovery.token}`);
		try {
			await attest(broker, root);
			const auth = {
				controlRoot: root,
				enrollmentId: "enrollment",
				ownerSessionId: ownerId,
				attestationEpoch: epoch,
				masterCapability: grant,
				worktrees: [root],
			};
			expect(
				await request(ws, "define-a", "task.dag", {
					...auth,
					action: "define",
					graphId: "a",
					expectedRevision: 0,
					nodes: [node("a", root)],
				}),
			).toMatchObject({ ok: true });
			const lost = await request(
				ws,
				"advance-a",
				"task.dag",
				{ ...auth, action: "advance", graphId: "a", nodeId: "a", expectedRevision: 1, cwd: root },
				"key-lost",
			);
			expect(lost).toMatchObject({ ok: false, error: { code: "terminal_uncertain" } });
			expect(launches.count).toBe(1);
			const store = new SpawnAuthorityStore(
				broker.settings.agentDir,
				await getBrokerIdentityKey(broker.settings.agentDir),
			);
			await store.open();
			expect(store.claims().some(claim => claim.state === "uncertain" || claim.state === "dispatching")).toBe(true);
			const status = await request(ws, "status-a", "task.dag", { ...auth, action: "status" });
			expect(status).toMatchObject({ ok: true });
			const liveRevision = (status as { result?: { stateRevision?: number } }).result?.stateRevision;
			expect(typeof liveRevision).toBe("number");
			expect(
				await request(ws, "cancel-stale", "task.dag", {
					...auth,
					action: "cancel",
					graphId: "a",
					expectedRevision: 2,
					nodeIds: ["a"],
				}),
			).toMatchObject({ ok: false });
			const cancellation = await request(ws, "cancel-a", "task.dag", {
				...auth,
				action: "cancel",
				graphId: "a",
				expectedRevision: liveRevision,
				nodeIds: ["a"],
			});
			expect(cancellation).toMatchObject({ ok: false, error: { code: "terminal_uncertain" } });
			expect(closes.count).toBe(1);
			const domain = JSON.parse(await fs.readFile(managedTaskDomainPath(root), "utf8")) as {
				graphs: Array<{ attempts: Array<{ worker: string; retired: boolean; fence: string }> }>;
			};
			const attempt = domain.graphs[0]!.attempts[0]!;
			expect(attempt.retired).toBe(false);
			expect(attempt.fence).toBe("canceled");
			expect(["unknown", "authorized", "closed"]).toContain(attempt.worker);
		} finally {
			ws.close();
			await broker.stop();
		}
	});
	it("session.close observes worker closed in-process without a broker restart", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-managed-live-close-"));
		roots.push(root);
		const launches = { count: 0 };
		const closes = { count: 0 };
		const broker = new Broker({
			agentDir: path.join(root, "agent"),
			packageGeneration: "test",
			masterCapabilityVerifier: verifier,
			spawnSubstrateProvider: {
				...substrate(launches, closes),
				verify: async () => (closes.count > 0 ? ("gone" as const) : ("verified" as const)),
			},
			spawnPromptLayer: promptLayer(),
		});
		const discovery = await broker.start();
		const ws = await connect(`${discovery.url}/?token=${discovery.token}`);
		try {
			await attest(broker, root);
			const auth = {
				controlRoot: root,
				enrollmentId: "enrollment",
				ownerSessionId: ownerId,
				attestationEpoch: epoch,
				masterCapability: grant,
				worktrees: [root],
			};
			expect(
				await request(ws, "define-a", "task.dag", {
					...auth,
					action: "define",
					graphId: "a",
					expectedRevision: 0,
					nodes: [node("a", root)],
				}),
			).toMatchObject({ ok: true });
			const advanced = await request(
				ws,
				"advance-a",
				"task.dag",
				{ ...auth, action: "advance", graphId: "a", nodeId: "a", expectedRevision: 1, cwd: root },
				"key-a",
			);
			expect(advanced).toMatchObject({ ok: true });
			const spawn = (advanced as { result?: { spawn?: { sessionId?: string } } }).result?.spawn;
			expect(typeof spawn?.sessionId).toBe("string");
			expect(await request(ws, "close-a", "session.close", { sessionId: spawn!.sessionId })).toMatchObject({
				ok: true,
				result: { code: "spawn_child_closed" },
			});
			const domain = JSON.parse(await fs.readFile(managedTaskDomainPath(root), "utf8")) as {
				graphs: Array<{ attempts: Array<{ worker: string }> }>;
			};
			expect(domain.graphs[0]!.attempts[0]!.worker).toBe("closed");
		} finally {
			ws.close();
			await broker.stop();
		}
	});
	it("corrupt indexed native domain blocks startup before spawn-claim recovery", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-managed-isolate-"));
		roots.push(root);
		const launches = { count: 0 };
		const closes = { count: 0 };
		let dispatches = 0;
		const agentDir = path.join(root, "agent");
		const first = new Broker({
			agentDir,
			packageGeneration: "test",
			masterCapabilityVerifier: verifier,
			spawnSubstrateProvider: substrate(launches, closes),
			spawnPromptLayer: {
				...promptLayer(),
				dispatch: async () => {
					dispatches += 1;
					return {
						kind: "accepted" as const,
						commandId: "cmd-native-domain",
						turnId: "turn-native-domain",
						acceptedAt: Date.now(),
					};
				},
			},
		});
		const discovery = await first.start();
		const ws = await connect(`${discovery.url}/?token=${discovery.token}`);
		try {
			await attest(first, root);
			expect(
				await request(ws, "define-a", "task.dag", {
					controlRoot: root,
					enrollmentId: "enrollment",
					ownerSessionId: ownerId,
					attestationEpoch: epoch,
					masterCapability: grant,
					worktrees: [root],
					action: "define",
					graphId: "a",
					expectedRevision: 0,
					nodes: [node("a", root)],
				}),
			).toMatchObject({ ok: true });
			expect(
				await request(
					ws,
					"advance-a",
					"task.dag",
					{
						controlRoot: root,
						enrollmentId: "enrollment",
						ownerSessionId: ownerId,
						attestationEpoch: epoch,
						masterCapability: grant,
						worktrees: [root],
						action: "advance",
						graphId: "a",
						nodeId: "a",
						expectedRevision: 1,
					},
					"key-a",
				),
			).toMatchObject({ ok: true });
		} finally {
			ws.close();
			await first.stop();
		}
		expect(launches.count).toBe(1);
		expect(dispatches).toBe(1);
		await fs.writeFile(managedTaskDomainPath(root), "{");
		const recoveryEffects = { verifies: 0, dispatches: 0, reconciles: 0 };
		const probeStore = new SpawnAuthorityStore(agentDir, await getBrokerIdentityKey(agentDir));
		await probeStore.open();
		const probe = await probeStore.claimOrJoin("recovery-probe", "a".repeat(64));
		if (probe.kind !== "owner") throw new Error("expected recovery probe owner");
		await probeStore.persistTransition("recovery-probe", {
			claimId: probe.claim.claimId,
			from: "prepared",
			to: "substrate_starting",
			childId: "recovery-probe-child",
		});
		const probeAt = Date.now();
		await probeStore.persistTransition("recovery-probe", {
			claimId: probe.claim.claimId,
			from: "substrate_starting",
			to: "authority_active",
			childId: "recovery-probe-child",
			authority: {
				version: 1,
				authorityId: "recovery-probe-authority",
				claimId: probe.claim.claimId,
				childId: "recovery-probe-child",
				ownerSessionId: ownerId,
				lifecycleIdentity: "recovery-probe",
				substrateKind: "headless",
				providerIdentity: "recovery-probe-provider",
				pid: 8989,
				processIncarnation: "inc-8989",
				endpointGeneration: 1,
				endpointPid: 8989,
				endpointIncarnation: "inc-8989",
				endpointCwd: root,
				endpointStateRoot: path.join(root, ".gjc", "state"),
				closeState: "active",
				createdAt: probeAt,
				updatedAt: probeAt,
			},
		});
		const probeSeed = { version: 2 as const, phase: "prepared" as const, clientRef: "recovery-probe-client-ref" };
		await probeStore.persistTransition("recovery-probe", {
			claimId: probe.claim.claimId,
			from: "authority_active",
			to: "seed_prepared",
			seed: probeSeed,
		});
		await probeStore.persistTransition("recovery-probe", {
			claimId: probe.claim.claimId,
			from: "seed_prepared",
			to: "dispatching",
			leaseEpoch: probe.claim.preSendLease?.epoch ?? "",
			seed: { ...probeSeed, phase: "dispatching" },
		});
		await probeStore.releaseOwner("recovery-probe");
		const second = new Broker({
			agentDir,
			packageGeneration: "test",
			masterCapabilityVerifier: verifier,
			spawnSubstrateProvider: {
				...substrate(launches, closes),
				verify: async () => {
					recoveryEffects.verifies += 1;
					return "verified" as const;
				},
			},
			spawnPromptLayer: {
				...promptLayer(),
				dispatch: async () => {
					recoveryEffects.dispatches += 1;
					return {
						kind: "accepted" as const,
						commandId: "recovery-command",
						turnId: "recovery-turn",
						acceptedAt: Date.now(),
					};
				},
				reconcile: async () => {
					recoveryEffects.reconciles += 1;
					return { status: "unknown" as const };
				},
			},
		});
		try {
			await expect(second.start()).rejects.toThrow(
				"Broker cannot establish complete managed enrollment membership.",
			);
			expect(second.discovery).toBeNull();
			expect(await readBrokerDiscovery(agentDir)).toBeNull();
			expect(launches.count).toBe(1);
			expect(closes.count).toBe(0);
			expect(dispatches).toBe(1);
			expect(recoveryEffects).toEqual({ verifies: 0, dispatches: 0, reconciles: 0 });
			const recoveredProbe = new SpawnAuthorityStore(agentDir, await getBrokerIdentityKey(agentDir));
			await recoveredProbe.open();
			expect(recoveredProbe.claim("recovery-probe")?.state).toBe("dispatching");
			const enrollment = await loadManagedEnrollmentRecord(agentDir);
			expect(enrollment.byRoot[root]).toHaveLength(1);
			expect(enrollment.nativeIdentities).toEqual(enrollment.byRoot[root]);
		} finally {
			await second.stop();
		}
	});
	it("reclaims an empty pending enrollment before allowing broker startup", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-managed-pending-startup-"));
		roots.push(root);
		const agentDir = path.join(root, "agent");
		const pendingRoot = path.join(root, "pending");
		await Promise.all([fs.mkdir(agentDir, { mode: 0o700 }), fs.mkdir(pendingRoot, { mode: 0o700 })]);
		await recordManagedEnrollment(agentDir, pendingRoot);
		const broker = new Broker({
			agentDir,
			packageGeneration: "test",
			masterCapabilityVerifier: verifier,
			spawnSubstrateProvider: substrate({ count: 0 }, { count: 0 }),
			spawnPromptLayer: promptLayer(),
		});
		try {
			const discovery = await broker.start();
			expect(discovery.url).toMatch(/^ws:\/\//);
			expect(broker.discovery).not.toBeNull();
			expect((await loadManagedEnrollmentRecord(agentDir)).controlRoots).not.toContain(pendingRoot);
		} finally {
			await broker.stop();
		}
	});
	it("unreadable enrollment index prevents publication without closing or retiring managed children", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-managed-index-"));
		roots.push(root);
		const launches = { count: 0 };
		const closes = { count: 0 };
		const agentDir = path.join(root, "agent");
		const first = new Broker({
			agentDir,
			packageGeneration: "test",
			masterCapabilityVerifier: verifier,
			spawnSubstrateProvider: substrate(launches, closes),
			spawnPromptLayer: promptLayer(),
		});
		const discovery = await first.start();
		const ws = await connect(`${discovery.url}/?token=${discovery.token}`);
		let domainBeforeRestartRevision: number | undefined;
		try {
			await attest(first, root);
			expect(
				await request(ws, "define-a", "task.dag", {
					controlRoot: root,
					enrollmentId: "enrollment",
					ownerSessionId: ownerId,
					attestationEpoch: epoch,
					masterCapability: grant,
					worktrees: [root],
					action: "define",
					graphId: "a",
					expectedRevision: 0,
					nodes: [node("a", root)],
				}),
			).toMatchObject({ ok: true });
			expect(
				await request(
					ws,
					"advance-a",
					"task.dag",
					{
						controlRoot: root,
						enrollmentId: "enrollment",
						ownerSessionId: ownerId,
						attestationEpoch: epoch,
						masterCapability: grant,
						worktrees: [root],
						action: "advance",
						graphId: "a",
						nodeId: "a",
						expectedRevision: 1,
						cwd: root,
					},
					"key-a",
				),
			).toMatchObject({ ok: true });
			domainBeforeRestartRevision = (
				JSON.parse(await fs.readFile(managedTaskDomainPath(root), "utf8")) as {
					state_revision: number;
				}
			).state_revision;
		} finally {
			ws.close();
			await first.stop();
		}
		const probeStore = new SpawnAuthorityStore(agentDir, await getBrokerIdentityKey(agentDir));
		await probeStore.open();
		const probe = await probeStore.claimOrJoin("enrollment-recovery-probe", "a".repeat(64));
		if (probe.kind !== "owner") throw new Error("expected recovery probe owner");
		await probeStore.persistTransition("enrollment-recovery-probe", {
			claimId: probe.claim.claimId,
			from: "prepared",
			to: "substrate_starting",
			childId: "recovery-probe-child",
		});
		const authorityNow = Date.now();
		await probeStore.persistTransition("enrollment-recovery-probe", {
			claimId: probe.claim.claimId,
			from: "substrate_starting",
			to: "authority_active",
			childId: "recovery-probe-child",
			authority: {
				version: 1,
				authorityId: "recovery-probe-authority",
				claimId: probe.claim.claimId,
				childId: "recovery-probe-child",
				ownerSessionId: ownerId,
				lifecycleIdentity: "enrollment-recovery-probe",
				substrateKind: "headless",
				providerIdentity: "managed-fixture",
				pid: 9898,
				processIncarnation: "inc-9898",
				endpointGeneration: 1,
				endpointPid: 9898,
				endpointIncarnation: "inc-9898",
				endpointCwd: root,
				endpointStateRoot: path.join(root, ".gjc", "state"),
				closeState: "active",
				createdAt: authorityNow,
				updatedAt: authorityNow,
			},
		});
		await probeStore.releaseOwner("enrollment-recovery-probe");
		await fs.writeFile(managedEnrollmentIndexPath(agentDir), "{");
		const recoveryEffects = { verifies: 0, dispatches: 0, reconciles: 0 };
		const second = new Broker({
			agentDir,
			packageGeneration: "test",
			masterCapabilityVerifier: verifier,
			spawnSubstrateProvider: {
				...substrate(launches, closes),
				verify: async () => {
					recoveryEffects.verifies += 1;
					return "verified" as const;
				},
			},
			spawnPromptLayer: {
				...promptLayer(),
				dispatch: async () => {
					recoveryEffects.dispatches += 1;
					return {
						kind: "accepted" as const,
						commandId: "recovery-probe-command",
						turnId: "recovery-probe-turn",
						acceptedAt: Date.now(),
					};
				},
				reconcile: async () => {
					recoveryEffects.reconciles += 1;
					return { status: "unknown" as const };
				},
			},
		});
		try {
			await expect(second.start()).rejects.toThrow(
				"Broker cannot establish complete managed enrollment membership.",
			);
			expect(second.discovery).toBeNull();
			expect(await readBrokerDiscovery(agentDir)).toBeNull();
			expect(launches.count).toBe(1);
			expect(closes.count).toBe(0);
			expect(recoveryEffects).toEqual({ verifies: 0, dispatches: 0, reconciles: 0 });
			const replayedProbe = new SpawnAuthorityStore(agentDir, await getBrokerIdentityKey(agentDir));
			await replayedProbe.open();
			expect(replayedProbe.claim("enrollment-recovery-probe")?.state).toBe("authority_active");
			const after = JSON.parse(await fs.readFile(managedTaskDomainPath(root), "utf8")) as {
				state_revision: number;
				graphs: Array<{ attempts: Array<{ fence: string; retired: boolean; worker: string }> }>;
			};
			expect(after.state_revision).toBe(domainBeforeRestartRevision);
			expect(after.graphs[0]!.attempts[0]!.fence).toBe("current");
			expect(after.graphs[0]!.attempts[0]!.retired).toBe(false);
			expect(after.graphs[0]!.attempts[0]!.worker).not.toBe("closed");
		} finally {
			await second.stop();
		}
	});
	it("exact same-key retry resumes the original reservation without a second launch", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-managed-resume-"));
		roots.push(root);
		const launches = { count: 0 };
		const closes = { count: 0 };
		const broker = new Broker({
			agentDir: path.join(root, "agent"),
			packageGeneration: "test",
			masterCapabilityVerifier: verifier,
			spawnSubstrateProvider: substrate(launches, closes),
			spawnPromptLayer: promptLayer(),
		});
		const discovery = await broker.start();
		const ws = await connect(`${discovery.url}/?token=${discovery.token}`);
		try {
			await attest(broker, root);
			const auth = {
				controlRoot: root,
				enrollmentId: "enrollment",
				ownerSessionId: ownerId,
				attestationEpoch: epoch,
				masterCapability: grant,
				worktrees: [root],
			};
			expect(
				await request(ws, "define-a", "task.dag", {
					...auth,
					action: "define",
					graphId: "a",
					expectedRevision: 0,
					nodes: [node("a", root)],
				}),
			).toMatchObject({ ok: true });
			expect(
				await request(
					ws,
					"advance-a",
					"task.dag",
					{ ...auth, action: "advance", graphId: "a", nodeId: "a", expectedRevision: 1, cwd: root },
					"key-resume",
				),
			).toMatchObject({ ok: true });
			expect(launches.count).toBe(1);
			const status = await request(ws, "status-a", "task.dag", { ...auth, action: "status" });
			const liveRevision = (status as { result?: { stateRevision?: number } }).result?.stateRevision;
			expect(typeof liveRevision).toBe("number");
			const retry = await request(
				ws,
				"advance-resume",
				"task.dag",
				{ ...auth, action: "advance", graphId: "a", nodeId: "a", expectedRevision: liveRevision, cwd: root },
				"key-resume",
			);
			expect(retry).toMatchObject({ ok: true });
			expect(launches.count).toBe(1);
			const domain = JSON.parse(await fs.readFile(managedTaskDomainPath(root), "utf8")) as {
				graphs: Array<{ attempts: unknown[] }>;
			};
			expect(domain.graphs[0]!.attempts).toHaveLength(1);
		} finally {
			ws.close();
			await broker.stop();
		}
	});
	it("reservation-before-claim restart resumes the original key once after proven no-effect", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-managed-no-effect-"));
		roots.push(root);
		const launches = { count: 0 };
		const closes = { count: 0 };
		const agentDir = path.join(root, "agent");
		const first = new Broker({
			agentDir,
			packageGeneration: "test",
			masterCapabilityVerifier: verifier,
			spawnSubstrateProvider: substrate(launches, closes),
			spawnPromptLayer: promptLayer(),
		});
		const discovery = await first.start();
		const crashBeforeClaim = spyOn(SpawnAuthorityStore.prototype, "claimOrJoin").mockImplementation(async () => {
			throw new Error("crash before native claim");
		});
		const ws = await connect(`${discovery.url}/?token=${discovery.token}`);
		try {
			await attest(first, root);
			const auth = {
				controlRoot: root,
				enrollmentId: "enrollment",
				ownerSessionId: ownerId,
				attestationEpoch: epoch,
				masterCapability: grant,
				worktrees: [root],
			};
			expect(
				await request(ws, "define-a", "task.dag", {
					...auth,
					action: "define",
					graphId: "a",
					expectedRevision: 0,
					nodes: [node("a", root)],
				}),
			).toMatchObject({ ok: true });
			expect(
				await request(
					ws,
					"advance-crash",
					"task.dag",
					{ ...auth, action: "advance", graphId: "a", nodeId: "a", expectedRevision: 1, cwd: root },
					"key-original",
				),
			).toMatchObject({ ok: false });
			expect(launches.count).toBe(0);
			const reserved = JSON.parse(await fs.readFile(managedTaskDomainPath(root), "utf8")) as {
				graphs: Array<{ attempts: Array<{ worker: string; fence: string }> }>;
			};
			expect(reserved.graphs[0]!.attempts).toHaveLength(1);
			expect(reserved.graphs[0]!.attempts[0]!.fence).toBe("current");
		} finally {
			crashBeforeClaim.mockRestore();
			ws.close();
			await first.stop();
		}
		const second = new Broker({
			agentDir,
			packageGeneration: "test",
			masterCapabilityVerifier: verifier,
			spawnSubstrateProvider: substrate(launches, closes),
			spawnPromptLayer: promptLayer(),
		});
		const restarted = await second.start();
		const ws2 = await connect(`${restarted.url}/?token=${restarted.token}`);
		try {
			await attest(second, root);
			const observed = JSON.parse(await fs.readFile(managedTaskDomainPath(root), "utf8")) as {
				state_revision: number;
				graphs: Array<{ attempts: Array<{ worker: string; fence: string; retired: boolean }> }>;
			};
			expect(observed.graphs[0]!.attempts).toHaveLength(1);
			expect(observed.graphs[0]!.attempts[0]!.worker).toBe("no-effect");
			expect(observed.graphs[0]!.attempts[0]!.fence).toBe("current");
			expect(observed.graphs[0]!.attempts[0]!.retired).toBe(false);
			const liveRevision = (
				(
					await request(ws2, "rev-no-effect", "task.dag", {
						controlRoot: root,
						enrollmentId: "enrollment",
						ownerSessionId: ownerId,
						attestationEpoch: epoch,
						masterCapability: grant,
						worktrees: [root],
						action: "status",
					})
				).result as { stateRevision: number }
			).stateRevision;
			const resumed = await request(
				ws2,
				"advance-original",
				"task.dag",
				{
					controlRoot: root,
					enrollmentId: "enrollment",
					ownerSessionId: ownerId,
					attestationEpoch: epoch,
					masterCapability: grant,
					worktrees: [root],
					action: "advance",
					graphId: "a",
					nodeId: "a",
					expectedRevision: liveRevision,
					cwd: root,
				},
				"key-original",
			);
			expect(resumed).toMatchObject({ ok: true });
			expect(launches.count).toBe(1);
			const persisted = JSON.parse(await fs.readFile(managedTaskDomainPath(root), "utf8")) as {
				graphs: Array<{ attempts: unknown[] }>;
			};
			expect(persisted.graphs[0]!.attempts).toHaveLength(1);
		} finally {
			ws2.close();
			await second.stop();
		}
	});
});
