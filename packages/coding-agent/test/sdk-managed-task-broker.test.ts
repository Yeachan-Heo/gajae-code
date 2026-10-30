import { afterEach, describe, expect, it, spyOn } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Broker, setManagedCloseWaitForTest } from "../src/sdk/broker/broker";
import { readBrokerDiscovery } from "../src/sdk/broker/discovery";
import {
	deriveIdempotencyIdentity,
	deriveLegacyIdentity,
	deriveScopedIdempotencyIdentity,
	getBrokerIdentityKey,
} from "../src/sdk/broker/identity";
import {
	cancelManagedTasks,
	createManagedDomainBinding,
	defineManagedTaskGraph,
	loadManagedEnrollmentRecord,
	managedEnrollmentIndexPath,
	managedIdentity,
	managedTaskDomainPath,
	markManagedEnrollmentEstablished,
	markManagedEnrollmentPublishing,
	recordManagedEnrollment,
	restoreManagedAttemptRefs,
	transactManagedTaskDomain,
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
	let connected = false;
	try {
		await new Promise<void>((resolve, reject) => {
			ws.addEventListener("open", () => resolve(), { once: true });
			ws.addEventListener("error", () => reject(new Error("websocket error")), { once: true });
		});
		const hello = await nextFrame(ws);
		if (hello.type !== "broker_hello") throw new Error(`expected broker_hello, got ${JSON.stringify(hello)}`);
		connected = true;
		return ws;
	} finally {
		if (!connected) ws.close();
	}
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

function substrate(launches: { count: number }) {
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
		close: async () => ({ ok: true }),
	};
}

function trackedSubstrate() {
	const launched: number[] = [];
	const closed = new Set<number>();
	return {
		launched,
		closed,
		provider: {
			launch: async () => {
				const pid = 5000 + launched.length;
				launched.push(pid);
				return {
					ok: true as const,
					proof: {
						substrateKind: "headless" as const,
						providerIdentity: "managed-tracked-fixture",
						pid,
						processIncarnation: `inc-${pid}`,
					},
				};
			},
			verify: async (proof: { pid?: number }) =>
				proof.pid !== undefined && closed.has(proof.pid) ? ("gone" as const) : ("verified" as const),
			close: async (proof: { pid?: number }) => {
				if (proof.pid !== undefined) closed.add(proof.pid);
				return { ok: true };
			},
		},
	};
}

const promptLayer = {
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
	dispatch: async () => ({ kind: "accepted" as const, commandId: "cmd-1", turnId: "turn-1", acceptedAt: Date.now() }),
	reconcile: async () => ({ status: "terminal_ok" as const, commandId: "cmd-1", turnId: "turn-1" }),
};

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

function node(id: string, workspace: string, resource: string) {
	return {
		id,
		task: `Task ${id}`,
		workspace,
		predecessors: [] as string[],
		criteriaIdentity: managedIdentity("criteria"),
		validations: [{ name: "check", command: "true" }],
		resources: [{ kind: "integration" as const, identity: resource, mode: "write" as const }],
		artifacts: [] as never[],
	};
}

// Managed task DAG publication requires Linux private durable publication (docs/managed-task-dag.md).
describe.skipIf(process.platform !== "linux")("managed task.dag broker admission (test-only, no M3 recovery)", () => {
	it("wrong token and wrong capability yield state and effects 0", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-managed-broker-auth-"));
		roots.push(root);
		const launches = { count: 0 };
		const broker = new Broker({
			agentDir: path.join(root, "agent"),
			packageGeneration: "test",
			masterCapabilityVerifier: verifier,
			spawnSubstrateProvider: substrate(launches),
			spawnPromptLayer: promptLayer,
		});
		const discovery = await broker.start();
		try {
			await attest(broker, root);
			const unauthorized = new WebSocket(`${discovery.url}/?token=wrong`);
			await new Promise<void>(resolve => unauthorized.addEventListener("close", () => resolve(), { once: true }));
			expect(launches.count).toBe(0);
			const ws = await connect(`${discovery.url}/?token=${discovery.token}`);
			const denied = await request(
				ws,
				"advance-denied",
				"task.dag",
				{
					action: "advance",
					controlRoot: root,
					enrollmentId: "enrollment",
					graphId: "a",
					nodeId: "a",
					expectedRevision: 0,
					ownerSessionId: ownerId,
					attestationEpoch: epoch,
					masterCapability: "wrong-grant",
					worktrees: [root],
				},
				"key-a",
			);
			expect(denied).toMatchObject({ ok: false, error: { code: "spawn_failed" } });
			expect(launches.count).toBe(0);
			await expect(fs.stat(managedTaskDomainPath(root))).rejects.toThrow();
			ws.close();
		} finally {
			await broker.stop();
		}
	});

	it("retries an uncommitted first define and preserves established empty-root evidence", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-managed-broker-enroll-retry-"));
		roots.push(root);
		const broker = new Broker({
			agentDir: path.join(root, "agent"),
			packageGeneration: "test",
			masterCapabilityVerifier: verifier,
			spawnSubstrateProvider: substrate({ count: 0 }),
			spawnPromptLayer: promptLayer,
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
			const failed = await request(ws, "define-invalid", "task.dag", {
				...auth,
				action: "define",
				graphId: "retry",
				expectedRevision: 0,
				nodes: "invalid",
			});
			expect(failed).toMatchObject({ ok: false, error: { code: "spawn_failed" } });
			await expect(fs.stat(managedTaskDomainPath(root))).rejects.toThrow();

			const retry = request(ws, "define-retry", "task.dag", {
				...auth,
				action: "define",
				graphId: "retry",
				expectedRevision: 0,
				nodes: [node("n", root, "retry")],
			});
			await Promise.all([restoreManagedAttemptRefs(broker.settings.agentDir), retry]);
			expect(await retry).toMatchObject({ ok: true, result: { graphId: "retry" } });
			const enrollment = await loadManagedEnrollmentRecord(broker.settings.agentDir);
			expect(enrollment.establishedRoots).toContain(root);
			expect(enrollment.nativeIdentities).toEqual([]);

			await fs.rm(managedTaskDomainPath(root), { force: true });
			expect(
				await request(ws, "define-after-delete", "task.dag", {
					...auth,
					action: "define",
					graphId: "later",
					expectedRevision: 0,
					nodes: [node("later", root, "later")],
				}),
			).toMatchObject({ ok: false, error: { message: "native managed evidence exists" } });
		} finally {
			ws.close();
			await broker.stop();
		}
	});
	it("reclaims only a never-committed root while retaining an indexed native root", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-managed-enrollment-cleanup-"));
		roots.push(root);
		const agentDir = path.join(root, "agent");
		const pendingRoot = path.join(root, "pending");
		const nativeRoot = path.join(root, "native");
		await Promise.all([
			fs.mkdir(agentDir, { mode: 0o700 }),
			fs.mkdir(pendingRoot, { mode: 0o700 }),
			fs.mkdir(nativeRoot, { mode: 0o700 }),
		]);
		await recordManagedEnrollment(agentDir, pendingRoot);
		await recordManagedEnrollment(agentDir, nativeRoot, "a".repeat(64));
		const restored = await restoreManagedAttemptRefs(agentDir);
		expect(restored.failedRoots).toContain(nativeRoot);
		const enrollment = await loadManagedEnrollmentRecord(agentDir);
		expect(enrollment.controlRoots).toEqual([nativeRoot]);
		expect(enrollment.nativeIdentities).toEqual(["a".repeat(64)]);
	});
	it("fails closed on an unmarked persisted enrollment index but initializes an absent index", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-managed-enrollment-unmarked-"));
		roots.push(root);
		const agentDir = path.join(root, "agent");
		const pendingRoot = path.join(root, "pending");
		await Promise.all([fs.mkdir(agentDir, { mode: 0o700 }), fs.mkdir(pendingRoot, { mode: 0o700 })]);

		expect(await loadManagedEnrollmentRecord(agentDir)).toEqual({
			controlRoots: [],
			establishedRoots: [],
			publishingRoots: [],
			nativeIdentities: [],
			byRoot: {},
		});

		const enrollmentPath = managedEnrollmentIndexPath(agentDir);
		await fs.mkdir(path.dirname(enrollmentPath), { recursive: true });
		await Bun.write(
			enrollmentPath,
			JSON.stringify({
				version: 1,
				controlRoots: [pendingRoot],
				nativeIdentities: [],
				byRoot: { [pendingRoot]: [] },
				state_revision: 0,
			}),
		);
		await expect(restoreManagedAttemptRefs(agentDir)).rejects.toThrow("corrupt managed enrollment index");
		await expect(fs.stat(managedTaskDomainPath(pendingRoot))).rejects.toThrow();
		expect(await Bun.file(enrollmentPath).exists()).toBe(true);
	});
	it("retains a publication-in-progress enrollment when state publication is interrupted", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-managed-enrollment-interrupted-"));
		roots.push(root);
		const agentDir = path.join(root, "agent");
		const controlRoot = path.join(root, "control");
		await Promise.all([fs.mkdir(agentDir, { mode: 0o700 }), fs.mkdir(controlRoot, { mode: 0o700 })]);
		await recordManagedEnrollment(agentDir, controlRoot);

		// Simulate a crash after the pre-write publication marker and before rename.
		await markManagedEnrollmentPublishing(agentDir, controlRoot);
		const restored = await restoreManagedAttemptRefs(agentDir);
		expect(restored.failedRoots).toContain(controlRoot);
		const enrollment = await loadManagedEnrollmentRecord(agentDir);
		expect(enrollment.controlRoots).toContain(controlRoot);
		expect(enrollment.publishingRoots).toContain(controlRoot);
		await expect(fs.stat(managedTaskDomainPath(controlRoot))).rejects.toThrow();

		const broker = new Broker({
			agentDir,
			packageGeneration: "test",
			masterCapabilityVerifier: verifier,
			spawnSubstrateProvider: substrate({ count: 0 }),
			spawnPromptLayer: promptLayer,
		});
		await expect(broker.start()).rejects.toThrow("Broker cannot establish complete managed enrollment membership.");
		expect(broker.discovery).toBeNull();
		expect(await readBrokerDiscovery(agentDir)).toBeNull();
		await broker.stop();

		const recoveredRoot = path.join(root, "published-control");
		await fs.mkdir(recoveredRoot, { mode: 0o700 });
		const binding = await createManagedDomainBinding({
			controlRoot: recoveredRoot,
			agentDir,
			enrollmentId: "enrollment",
			worktrees: [recoveredRoot],
		});
		await recordManagedEnrollment(agentDir, recoveredRoot);
		await transactManagedTaskDomain(
			{
				binding,
				expectedRevision: 0,
				assertNoManagedEvidence: async () => undefined,
				beforeFirstPublication: async () => markManagedEnrollmentPublishing(agentDir, recoveredRoot),
				// Omit the success marker update to model a crash after state rename.
			},
			async state =>
				defineManagedTaskGraph(state, {
					id: "recovered",
					owner: ownerId,
					nodes: [node("n", recoveredRoot, "recovered")],
				}),
		);
		expect((await loadManagedEnrollmentRecord(agentDir)).publishingRoots).toContain(recoveredRoot);
		const afterRecovery = await restoreManagedAttemptRefs(agentDir);
		expect(afterRecovery.failedRoots).not.toContain(recoveredRoot);
		const recoveredEnrollment = await loadManagedEnrollmentRecord(agentDir);
		expect(recoveredEnrollment.establishedRoots).toContain(recoveredRoot);
		expect(recoveredEnrollment.publishingRoots).not.toContain(recoveredRoot);
	});
	it("authenticated wire admits disjoint writers twice and denies a competing writer", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-managed-broker-admit-"));
		roots.push(root);
		const launches = { count: 0 };
		const broker = new Broker({
			agentDir: path.join(root, "agent"),
			packageGeneration: "test",
			masterCapabilityVerifier: verifier,
			spawnSubstrateProvider: substrate(launches),
			spawnPromptLayer: promptLayer,
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
					nodes: [node("a", root, "a")],
				}),
			).toMatchObject({ ok: true });
			expect(
				await request(ws, "define-b", "task.dag", {
					...auth,
					action: "define",
					graphId: "b",
					expectedRevision: 1,
					nodes: [node("b", root, "b")],
				}),
			).toMatchObject({ ok: true });
			expect(
				await request(ws, "define-c", "task.dag", {
					...auth,
					action: "define",
					graphId: "c",
					expectedRevision: 2,
					nodes: [node("c", root, "a")],
				}),
			).toMatchObject({ ok: true });
			const first = await request(
				ws,
				"advance-a",
				"task.dag",
				{ ...auth, action: "advance", graphId: "a", nodeId: "a", expectedRevision: 3, cwd: root },
				"key-a",
			);
			const firstRevision = (first as { result?: { stateRevision?: number } }).result?.stateRevision;
			expect(typeof firstRevision).toBe("number");
			const second = await request(
				ws,
				"advance-b",
				"task.dag",
				{ ...auth, action: "advance", graphId: "b", nodeId: "b", expectedRevision: firstRevision, cwd: root },
				"key-b",
			);
			expect(first).toMatchObject({ ok: true, result: { attemptId: "attempt-key-a" } });
			expect(second).toMatchObject({ ok: true, result: { attemptId: "attempt-key-b" } });
			expect(launches.count).toBe(2);
			const secondRevision = (second as { result?: { stateRevision?: number } }).result?.stateRevision;
			const conflict = await request(
				ws,
				"advance-c",
				"task.dag",
				{ ...auth, action: "advance", graphId: "c", nodeId: "c", expectedRevision: secondRevision, cwd: root },
				"key-c",
			);
			expect(conflict).toMatchObject({ ok: false });
			expect(launches.count).toBe(2);
			const nativeA = await deriveScopedIdempotencyIdentity(
				broker.settings.agentDir,
				"session.spawn",
				"key-a",
				root,
			);
			const ordinary = await request(
				ws,
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
			expect(JSON.stringify(ordinary)).not.toContain(grant);
			expect(launches.count).toBe(2);
			const persisted = JSON.parse(await fs.readFile(managedTaskDomainPath(root), "utf8")) as {
				graphs: Array<{ attempts: Array<{ native: { identity: string } }> }>;
			};
			expect(persisted.graphs.flatMap(graph => graph.attempts)).toHaveLength(2);
			expect(
				persisted.graphs.some(graph => graph.attempts.some(attempt => attempt.native.identity === nativeA)),
			).toBe(true);
		} finally {
			ws.close();
			await broker.stop();
		}
	});
	it("defines a sibling root with a live managed attempt while rejecting an already-enrolled root", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-managed-broker-sibling-root-"));
		roots.push(root);
		const rootA = path.join(root, "root-a");
		const rootB = path.join(root, "root-b");
		const enrolledRoot = path.join(root, "enrolled-root");
		await Promise.all([
			fs.mkdir(rootA, { mode: 0o700 }),
			fs.mkdir(rootB, { mode: 0o700 }),
			fs.mkdir(enrolledRoot, { mode: 0o700 }),
		]);
		const launches = { count: 0 };
		const broker = new Broker({
			agentDir: path.join(root, "agent"),
			packageGeneration: "test",
			masterCapabilityVerifier: verifier,
			spawnSubstrateProvider: substrate(launches),
			spawnPromptLayer: promptLayer,
		});
		const discovery = await broker.start();
		const ws = await connect(`${discovery.url}/?token=${discovery.token}`);
		try {
			await attest(broker, rootA);
			await recordManagedEnrollment(broker.settings.agentDir, enrolledRoot);
			await markManagedEnrollmentEstablished(broker.settings.agentDir, enrolledRoot);
			const auth = (controlRoot: string) => ({
				controlRoot,
				enrollmentId: "enrollment",
				ownerSessionId: ownerId,
				attestationEpoch: epoch,
				masterCapability: grant,
				worktrees: [controlRoot],
			});
			expect(
				await request(ws, "define-a", "task.dag", {
					...auth(rootA),
					action: "define",
					graphId: "a",
					expectedRevision: 0,
					nodes: [node("a", rootA, "a")],
				}),
			).toMatchObject({ ok: true });
			const advance = await request(
				ws,
				"advance-a",
				"task.dag",
				{ ...auth(rootA), action: "advance", graphId: "a", nodeId: "a", expectedRevision: 1 },
				"key-a",
			);
			expect(advance).toMatchObject({ ok: true, result: { attemptId: "attempt-key-a" } });
			expect(launches.count).toBe(1);
			expect(
				await request(ws, "define-b", "task.dag", {
					...auth(rootB),
					action: "define",
					graphId: "b",
					expectedRevision: 0,
					nodes: [node("b", rootB, "b")],
				}),
			).toMatchObject({ ok: true });
			expect(
				await request(ws, "define-enrolled", "task.dag", {
					...auth(enrolledRoot),
					action: "define",
					graphId: "enrolled",
					expectedRevision: 0,
					nodes: [node("enrolled", enrolledRoot, "enrolled")],
				}),
			).toMatchObject({ ok: false, error: { code: "spawn_failed", message: "native managed evidence exists" } });
		} finally {
			ws.close();
			await broker.stop();
		}
	});
	it("revise with a stale expectedRevision does not apply over unseen current state", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-managed-broker-cas-"));
		roots.push(root);
		const launches = { count: 0 };
		const broker = new Broker({
			agentDir: path.join(root, "agent"),
			packageGeneration: "test",
			masterCapabilityVerifier: verifier,
			spawnSubstrateProvider: substrate(launches),
			spawnPromptLayer: promptLayer,
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
			const defined = await request(ws, "define-a", "task.dag", {
				...auth,
				action: "define",
				graphId: "a",
				expectedRevision: 0,
				nodes: [node("a", root, "a")],
			});
			expect(defined).toMatchObject({ ok: true });
			const stale = await request(ws, "revise-stale", "task.dag", {
				...auth,
				action: "revise",
				graphId: "a",
				expectedRevision: 0,
				nodes: [node("a", root, "a-revised")],
			});
			expect(stale).toMatchObject({ ok: false });
			const current = JSON.parse(await fs.readFile(managedTaskDomainPath(root), "utf8")) as {
				state_revision: number;
				graphs: Array<{ nodes: Array<{ definition: { task: string } }> }>;
			};
			expect(current.state_revision).toBe(1);
			expect(current.graphs[0]!.nodes[0]!.definition.task).toBe("Task a");
		} finally {
			ws.close();
			await broker.stop();
		}
	});
	it("binds worker cwd to admitted workspace and rejects a mismatched caller cwd", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-managed-broker-cwd-"));
		roots.push(root);
		const workspace = path.join(root, "work");
		await fs.mkdir(workspace);
		const launches = { count: 0 };
		const broker = new Broker({
			agentDir: path.join(root, "agent"),
			packageGeneration: "test",
			masterCapabilityVerifier: verifier,
			spawnSubstrateProvider: substrate(launches),
			spawnPromptLayer: promptLayer,
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
				await request(ws, "define-w", "task.dag", {
					...auth,
					action: "define",
					graphId: "g",
					expectedRevision: 0,
					nodes: [node("a", workspace, "a")],
				}),
			).toMatchObject({ ok: true });
			const mismatch = await request(
				ws,
				"advance-mismatch",
				"task.dag",
				{ ...auth, action: "advance", graphId: "g", nodeId: "a", expectedRevision: 1, cwd: root },
				"key-mismatch",
			);
			expect(mismatch).toMatchObject({ ok: false });
			expect(launches.count).toBe(0);
			const admitted = await request(
				ws,
				"advance-ok",
				"task.dag",
				{ ...auth, action: "advance", graphId: "g", nodeId: "a", expectedRevision: 1 },
				"key-ok",
			);
			expect(admitted).toMatchObject({ ok: true });
			expect(launches.count).toBe(1);
		} finally {
			ws.close();
			await broker.stop();
		}
	});
	it("cancels only the matching graph's native child when two graphs share a node id", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-managed-broker-graphs-"));
		roots.push(root);
		const launches = { count: 0 };
		const broker = new Broker({
			agentDir: path.join(root, "agent"),
			packageGeneration: "test",
			masterCapabilityVerifier: verifier,
			spawnSubstrateProvider: {
				...substrate(launches),
				verify: async () => "gone" as const,
			},
			spawnPromptLayer: promptLayer,
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
				await request(ws, "define-g1", "task.dag", {
					...auth,
					action: "define",
					graphId: "g1",
					expectedRevision: 0,
					nodes: [node("n", root, "one")],
				}),
			).toMatchObject({ ok: true });
			expect(
				await request(ws, "define-g2", "task.dag", {
					...auth,
					action: "define",
					graphId: "g2",
					expectedRevision: 1,
					nodes: [node("n", root, "two")],
				}),
			).toMatchObject({ ok: true });
			const revisionAfterDefines = (
				(await request(ws, "rev-after-define", "task.dag", { ...auth, action: "status" })).result as {
					stateRevision: number;
				}
			).stateRevision;
			expect(
				await request(
					ws,
					"advance-g1",
					"task.dag",
					{ ...auth, action: "advance", graphId: "g1", nodeId: "n", expectedRevision: revisionAfterDefines },
					"key-g1",
				),
			).toMatchObject({ ok: true });
			const revisionAfterG1 = (
				(await request(ws, "rev-after-g1", "task.dag", { ...auth, action: "status" })).result as {
					stateRevision: number;
				}
			).stateRevision;
			expect(
				await request(
					ws,
					"advance-g2",
					"task.dag",
					{ ...auth, action: "advance", graphId: "g2", nodeId: "n", expectedRevision: revisionAfterG1 },
					"key-g2",
				),
			).toMatchObject({ ok: true });
			expect(launches.count).toBe(2);
			const revisionAfterG2 = (
				(await request(ws, "rev-after-g2", "task.dag", { ...auth, action: "status" })).result as {
					stateRevision: number;
				}
			).stateRevision;
			expect(
				await request(ws, "cancel-g1", "task.dag", {
					...auth,
					action: "cancel",
					graphId: "g1",
					expectedRevision: revisionAfterG2,
					nodeIds: ["n"],
				}),
			).toMatchObject({ ok: true });
			const domain = JSON.parse(await fs.readFile(managedTaskDomainPath(root), "utf8")) as {
				graphs: Array<{ id: string; attempts: Array<{ fence: string; worker: string }> }>;
			};
			const g1 = domain.graphs.find(graph => graph.id === "g1")!.attempts[0]!;
			const g2 = domain.graphs.find(graph => graph.id === "g2")!.attempts[0]!;
			expect(g1.fence).toBe("canceled");
			expect(g2.fence).toBe("current");
			expect(g2.worker).not.toBe("closed");
		} finally {
			ws.close();
			await broker.stop();
		}
	});
	it("holds prepared-to-substrate_starting under the domain lock so cancel cannot commit first", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-managed-broker-lock-"));
		roots.push(root);
		const launches = { count: 0 };
		const closed = new Set<number>();
		const persistTransition = SpawnAuthorityStore.prototype.persistTransition;
		const entered = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		let transitionCommitted = false;
		const broker = new Broker({
			agentDir: path.join(root, "agent"),
			packageGeneration: "test",
			masterCapabilityVerifier: verifier,
			spawnSubstrateProvider: {
				...substrate(launches),
				verify: async (proof: { pid?: number }) =>
					proof.pid !== undefined && closed.has(proof.pid) ? ("gone" as const) : ("verified" as const),
				close: async (proof: { pid?: number }) => {
					if (proof.pid !== undefined) closed.add(proof.pid);
					return { ok: true };
				},
			},
			spawnPromptLayer: promptLayer,
		});
		const discovery = await broker.start();
		const holdLaunch = spyOn(SpawnAuthorityStore.prototype, "persistTransition").mockImplementation(async function (
			this: SpawnAuthorityStore,
			identity,
			input,
		) {
			if (input.from === "prepared" && input.to === "substrate_starting") {
				entered.resolve();
				await release.promise;
				const result = await persistTransition.call(this, identity, input);
				transitionCommitted = true;
				return result;
			}
			return persistTransition.call(this, identity, input);
		});
		const ws = await connect(`${discovery.url}/?token=${discovery.token}`);
		const wsCancel = await connect(`${discovery.url}/?token=${discovery.token}`);
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
				await request(ws, "define-g", "task.dag", {
					...auth,
					action: "define",
					graphId: "g",
					expectedRevision: 0,
					nodes: [node("n", root, "lock")],
				}),
			).toMatchObject({ ok: true });
			const revision = (
				(await request(ws, "rev-before-advance", "task.dag", { ...auth, action: "status" })).result as {
					stateRevision: number;
				}
			).stateRevision;
			const advance = request(
				ws,
				"advance-held",
				"task.dag",
				{ ...auth, action: "advance", graphId: "g", nodeId: "n", expectedRevision: revision },
				"key-held",
			);
			await entered.promise;
			expect(transitionCommitted).toBe(false);
			expect(launches.count).toBe(0);
			const before = JSON.parse(await fs.readFile(managedTaskDomainPath(root), "utf8")) as {
				graphs: Array<{ attempts: Array<{ fence: string }> }>;
			};
			expect(before.graphs[0]!.attempts[0]!.fence).toBe("current");
			const cancelStarted = request(wsCancel, "cancel-held", "task.dag", {
				...auth,
				action: "cancel",
				graphId: "g",
				expectedRevision: revision + 1,
				nodeIds: ["n"],
			});
			await Promise.race([
				cancelStarted.then(() => {
					throw new Error("cancel committed before native transition");
				}),
				Bun.sleep(50),
			]);
			expect(transitionCommitted).toBe(false);
			release.resolve();
			expect(await advance).toMatchObject({ ok: true });
			expect(transitionCommitted).toBe(true);
			expect(launches.count).toBe(1);
			const cancel = await cancelStarted;
			expect(cancel).toMatchObject({ ok: false, error: { code: "spawn_failed" } });
			expect((cancel.error as { message: string }).message).toContain("state write conflict");
			const current = (
				(await request(ws, "rev-after-transition", "task.dag", { ...auth, action: "status" })).result as {
					stateRevision: number;
				}
			).stateRevision;
			expect(
				await request(wsCancel, "cancel-current", "task.dag", {
					...auth,
					action: "cancel",
					graphId: "g",
					expectedRevision: current,
					nodeIds: ["n"],
				}),
			).toMatchObject({ ok: true });
			const after = JSON.parse(await fs.readFile(managedTaskDomainPath(root), "utf8")) as {
				graphs: Array<{ attempts: Array<{ fence: string }> }>;
			};
			expect(after.graphs[0]!.attempts[0]!.fence).toBe("canceled");
		} finally {
			holdLaunch.mockRestore();
			ws.close();
			wsCancel.close();
			await broker.stop();
		}
	});
	it("holds seed dispatch under the domain lock until the handoff finishes", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-managed-broker-seed-lock-"));
		roots.push(root);
		const tracked = trackedSubstrate();
		const registrationEntered = Promise.withResolvers<void>();
		const registrationRelease = Promise.withResolvers<void>();
		const dispatchEntered = Promise.withResolvers<void>();
		const dispatchRelease = Promise.withResolvers<void>();
		const order: string[] = [];
		let dispatches = 0;
		const persistTransition = SpawnAuthorityStore.prototype.persistTransition;
		const holdDispatch = spyOn(SpawnAuthorityStore.prototype, "persistTransition").mockImplementation(async function (
			this: SpawnAuthorityStore,
			identity,
			input,
		) {
			const result = await persistTransition.call(this, identity, input);
			if (input.from === "seed_prepared" && input.to === "dispatching") order.push("dispatching-durable");
			return result;
		});
		const spawnPromptLayer = {
			...promptLayer,
			awaitRegistration: async (input: { childId: string; cwd: string; stateRoot: string }) => {
				registrationEntered.resolve();
				await registrationRelease.promise;
				return {
					ok: true as const,
					registration: {
						sessionId: input.childId,
						endpointGeneration: 1,
						pid: 4242,
						processIncarnation: "inc-4242",
						cwd: input.cwd,
						stateRoot: input.stateRoot,
					},
				};
			},
			dispatch: async () => {
				dispatches += 1;
				order.push("dispatch-entered");
				dispatchEntered.resolve();
				await dispatchRelease.promise;
				order.push("dispatch-returned");
				return {
					kind: "accepted" as const,
					commandId: "cmd-seed-lock",
					turnId: "turn-seed-lock",
					acceptedAt: Date.now(),
				};
			},
		};
		const broker = new Broker({
			agentDir: path.join(root, "agent"),
			packageGeneration: "test",
			masterCapabilityVerifier: verifier,
			spawnSubstrateProvider: tracked.provider,
			spawnPromptLayer,
		});
		const discovery = await broker.start();
		const ws = await connect(`${discovery.url}/?token=${discovery.token}`);
		const wsCancel = await connect(`${discovery.url}/?token=${discovery.token}`);
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
				await request(ws, "define-seed-lock", "task.dag", {
					...auth,
					action: "define",
					graphId: "g",
					expectedRevision: 0,
					nodes: [node("n", root, "seed-lock")],
				}),
			).toMatchObject({ ok: true });
			const beforeAdvance = (
				(await request(wsCancel, "status-seed-lock", "task.dag", { ...auth, action: "status" })).result as {
					stateRevision: number;
				}
			).stateRevision;
			const advance = request(
				ws,
				"advance-seed-lock",
				"task.dag",
				{ ...auth, action: "advance", graphId: "g", nodeId: "n", expectedRevision: beforeAdvance },
				"seed-lock-key",
			);
			await registrationEntered.promise;
			const liveRevision = (
				(await request(wsCancel, "status-before-seed", "task.dag", { ...auth, action: "status" })).result as {
					stateRevision: number;
				}
			).stateRevision;
			registrationRelease.resolve();
			await dispatchEntered.promise;
			const cancel = request(wsCancel, "cancel-seed-lock", "task.dag", {
				...auth,
				action: "cancel",
				graphId: "g",
				expectedRevision: liveRevision,
				nodeIds: ["n"],
			}).then(response => {
				order.push("cancel-returned");
				return response;
			});
			let cancelSettled = false;
			void cancel.then(() => {
				cancelSettled = true;
			});
			await Promise.race([
				cancel.then(() => {
					throw new Error("cancel returned while seed dispatch was paused");
				}),
				Bun.sleep(50),
			]);
			expect(cancelSettled).toBe(false);
			const duringDispatch = JSON.parse(await fs.readFile(managedTaskDomainPath(root), "utf8")) as {
				graphs: Array<{ attempts: Array<{ fence: string }> }>;
			};
			expect(duringDispatch.graphs[0]!.attempts[0]!.fence).toBe("current");
			expect(order).toEqual(["dispatching-durable", "dispatch-entered"]);
			dispatchRelease.resolve();
			expect(await advance).toMatchObject({ ok: true });
			expect(await cancel).toMatchObject({ ok: true });
			expect(order).toEqual(["dispatching-durable", "dispatch-entered", "dispatch-returned", "cancel-returned"]);
			expect(dispatches).toBe(1);
			expect([...tracked.closed]).toEqual([tracked.launched[0]]);
			const after = JSON.parse(await fs.readFile(managedTaskDomainPath(root), "utf8")) as {
				graphs: Array<{ attempts: Array<{ fence: string }> }>;
			};
			expect(after.graphs[0]!.attempts[0]!.fence).toBe("canceled");
		} finally {
			registrationRelease.resolve();
			dispatchRelease.resolve();
			holdDispatch.mockRestore();
			ws.close();
			wsCancel.close();
			await broker.stop();
		}
	});
	it("joins a same-key retry and keeps cancel tracking the blocked dispatch", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-managed-broker-retry-flight-"));
		roots.push(root);
		const tracked = trackedSubstrate();
		const registrationEntered = Promise.withResolvers<void>();
		const registrationRelease = Promise.withResolvers<void>();
		const dispatchEntered = Promise.withResolvers<void>();
		const dispatchRelease = Promise.withResolvers<void>();
		let dispatches = 0;
		const spawnPromptLayer = {
			...promptLayer,
			awaitRegistration: async (input: { childId: string; cwd: string; stateRoot: string }) => {
				registrationEntered.resolve();
				await registrationRelease.promise;
				return {
					ok: true as const,
					registration: {
						sessionId: input.childId,
						endpointGeneration: 1,
						pid: 4242,
						processIncarnation: "inc-4242",
						cwd: input.cwd,
						stateRoot: input.stateRoot,
					},
				};
			},
			dispatch: async () => {
				dispatches += 1;
				dispatchEntered.resolve();
				await dispatchRelease.promise;
				return {
					kind: "accepted" as const,
					commandId: "cmd-retry-flight",
					turnId: "turn-retry-flight",
					acceptedAt: Date.now(),
				};
			},
		};
		const broker = new Broker({
			agentDir: path.join(root, "agent"),
			packageGeneration: "test",
			masterCapabilityVerifier: verifier,
			spawnSubstrateProvider: tracked.provider,
			spawnPromptLayer,
		});
		const discovery = await broker.start();
		const ws = await connect(`${discovery.url}/?token=${discovery.token}`);
		const wsRetry = await connect(`${discovery.url}/?token=${discovery.token}`);
		const wsCancel = await connect(`${discovery.url}/?token=${discovery.token}`);
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
				await request(ws, "define-retry-flight", "task.dag", {
					...auth,
					action: "define",
					graphId: "g",
					expectedRevision: 0,
					nodes: [node("n", root, "retry-flight")],
				}),
			).toMatchObject({ ok: true });
			const beforeAdvance = (
				(await request(wsCancel, "status-retry-flight", "task.dag", { ...auth, action: "status" })).result as {
					stateRevision: number;
				}
			).stateRevision;
			const advanceInput = {
				...auth,
				action: "advance",
				graphId: "g",
				nodeId: "n",
				expectedRevision: beforeAdvance,
			};
			const advance = request(ws, "advance-retry-flight", "task.dag", advanceInput, "retry-flight-key");
			await registrationEntered.promise;
			const liveRevision = (
				(await request(wsCancel, "status-before-retry-dispatch", "task.dag", { ...auth, action: "status" }))
					.result as {
					stateRevision: number;
				}
			).stateRevision;
			registrationRelease.resolve();
			await dispatchEntered.promise;
			const retry = request(
				wsRetry,
				"advance-retry-again",
				"task.dag",
				{ ...advanceInput, expectedRevision: liveRevision },
				"retry-flight-key",
			);
			let retrySettled = false;
			void retry.then(() => {
				retrySettled = true;
			});
			await Promise.race([
				retry.then(() => {
					throw new Error("exact retry did not join the blocked completion");
				}),
				Bun.sleep(50),
			]);
			expect(retrySettled).toBe(false);
			const cancel = request(wsCancel, "cancel-retry-flight", "task.dag", {
				...auth,
				action: "cancel",
				graphId: "g",
				expectedRevision: liveRevision,
				nodeIds: ["n"],
			});
			let cancelSettled = false;
			void cancel.then(() => {
				cancelSettled = true;
			});
			await Promise.race([
				cancel.then(() => {
					throw new Error("cancel returned while dispatch was paused");
				}),
				Bun.sleep(50),
			]);
			expect(cancelSettled).toBe(false);
			const duringDispatch = JSON.parse(await fs.readFile(managedTaskDomainPath(root), "utf8")) as {
				graphs: Array<{ attempts: Array<{ fence: string }> }>;
			};
			expect(duringDispatch.graphs[0]!.attempts[0]!.fence).toBe("current");
			dispatchRelease.resolve();
			expect(await advance).toMatchObject({ ok: true });
			expect(await retry).toMatchObject({ ok: true });
			expect(await cancel).toMatchObject({ ok: true });
			expect(dispatches).toBe(1);
			expect(tracked.launched).toHaveLength(1);
			expect([...tracked.closed]).toEqual([tracked.launched[0]]);
			const after = JSON.parse(await fs.readFile(managedTaskDomainPath(root), "utf8")) as {
				graphs: Array<{ attempts: Array<{ fence: string; worker: string }> }>;
			};
			expect(after.graphs[0]!.attempts[0]!.fence).toBe("canceled");
			expect(after.graphs[0]!.attempts[0]!.worker).toBe("closed");
		} finally {
			registrationRelease.resolve();
			dispatchRelease.resolve();
			ws.close();
			wsRetry.close();
			wsCancel.close();
			await broker.stop();
		}
	});
	it("cancel winning the current fence before launch yields provider 0", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-managed-broker-cancel-first-"));
		roots.push(root);
		const launches = { count: 0 };
		const broker = new Broker({
			agentDir: path.join(root, "agent"),
			packageGeneration: "test",
			masterCapabilityVerifier: verifier,
			spawnSubstrateProvider: substrate(launches),
			spawnPromptLayer: promptLayer,
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
				await request(ws, "define-g", "task.dag", {
					...auth,
					action: "define",
					graphId: "g",
					expectedRevision: 0,
					nodes: [node("n", root, "first")],
				}),
			).toMatchObject({ ok: true });
			expect(
				await request(ws, "cancel-first", "task.dag", {
					...auth,
					action: "cancel",
					graphId: "g",
					expectedRevision: 1,
					nodeIds: ["n"],
				}),
			).toMatchObject({ ok: true });
			expect(
				await request(
					ws,
					"advance-canceled",
					"task.dag",
					{ ...auth, action: "advance", graphId: "g", nodeId: "n", expectedRevision: 2 },
					"key-canceled",
				),
			).toMatchObject({ ok: false });
			expect(launches.count).toBe(0);
		} finally {
			ws.close();
			await broker.stop();
		}
	});
	it("scopes a reused idempotency key to each managed control root", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-managed-broker-root-scope-"));
		roots.push(root);
		const rootA = path.join(root, "root-a");
		const rootB = path.join(root, "root-b");
		await Promise.all([fs.mkdir(rootA, { mode: 0o700 }), fs.mkdir(rootB, { mode: 0o700 })]);
		const tracked = trackedSubstrate();
		const broker = new Broker({
			agentDir: path.join(root, "agent"),
			packageGeneration: "test",
			masterCapabilityVerifier: verifier,
			spawnSubstrateProvider: tracked.provider,
			spawnPromptLayer: promptLayer,
		});
		const discovery = await broker.start();
		const ws = await connect(`${discovery.url}/?token=${discovery.token}`);
		try {
			await attest(broker, rootA);
			const auth = (controlRoot: string) => ({
				controlRoot,
				enrollmentId: "enrollment",
				ownerSessionId: ownerId,
				attestationEpoch: epoch,
				masterCapability: grant,
				worktrees: [controlRoot],
			});
			for (const [controlRoot, graphId, id] of [
				[rootA, "a", "define-a"],
				[rootB, "b", "define-b"],
			] as const) {
				expect(
					await request(ws, id, "task.dag", {
						...auth(controlRoot),
						action: "define",
						graphId,
						expectedRevision: 0,
						nodes: [node("n", controlRoot, `resource-${graphId}`)],
					}),
				).toMatchObject({ ok: true });
			}
			const advanceA = await request(
				ws,
				"advance-a",
				"task.dag",
				{ ...auth(rootA), action: "advance", graphId: "a", nodeId: "n", expectedRevision: 1 },
				"shared-key",
			);
			expect(advanceA).toMatchObject({ ok: true, result: { attemptId: "attempt-shared-key" } });

			await attest(broker, rootB);
			const advanceB = await request(
				ws,
				"advance-b",
				"task.dag",
				{ ...auth(rootB), action: "advance", graphId: "b", nodeId: "n", expectedRevision: 1 },
				"shared-key",
			);
			expect(advanceB).toMatchObject({ ok: true, result: { attemptId: "attempt-shared-key" } });
			expect(tracked.launched).toHaveLength(2);

			const identityA = await deriveScopedIdempotencyIdentity(
				broker.settings.agentDir,
				"session.spawn",
				"shared-key",
				rootA,
			);
			const identityB = await deriveScopedIdempotencyIdentity(
				broker.settings.agentDir,
				"session.spawn",
				"shared-key",
				rootB,
			);
			expect(identityA).not.toBe(identityB);
			const enrollment = await loadManagedEnrollmentRecord(broker.settings.agentDir);
			expect(enrollment.byRoot[rootA]).toContain(identityA);
			expect(enrollment.byRoot[rootB]).toContain(identityB);

			ws.close();
			await broker.stop();
			const restartedBroker = new Broker({
				agentDir: broker.settings.agentDir,
				packageGeneration: "test",
				masterCapabilityVerifier: verifier,
				spawnSubstrateProvider: tracked.provider,
				spawnPromptLayer: promptLayer,
			});
			const restartedDiscovery = await restartedBroker.start();
			const restartedWs = await connect(`${restartedDiscovery.url}/?token=${restartedDiscovery.token}`);
			try {
				await attest(restartedBroker, rootA);
				await attest(restartedBroker, rootB);
				const replayedAuthority = new SpawnAuthorityStore(
					restartedBroker.settings.agentDir,
					await getBrokerIdentityKey(restartedBroker.settings.agentDir),
				);
				await replayedAuthority.open();
				for (const ordinaryIdentity of await Promise.all([
					deriveIdempotencyIdentity(restartedBroker.settings.agentDir, "session.spawn", "shared-key"),
					deriveLegacyIdentity(restartedBroker.settings.agentDir, "session.spawn", "shared-key"),
				])) {
					expect(await replayedAuthority.claimOrJoin(ordinaryIdentity, "a".repeat(64), "b".repeat(64))).toEqual({
						kind: "managed_key_conflict",
					});
				}
				const ordinary = await request(
					restartedWs,
					"ordinary-after-restart",
					"session.spawn",
					{
						cwd: rootA,
						task: "Task n",
						ownerSessionId: ownerId,
						attestationEpoch: epoch,
						masterCapability: grant,
					},
					"shared-key",
				);
				expect(ordinary).toMatchObject({
					ok: false,
					error: {
						code: "spawn_failed",
						message: "managed native identity cannot re-enter ordinary session.spawn",
					},
				});
				expect(tracked.launched).toHaveLength(2);

				const revisionA = (
					(
						await request(restartedWs, "status-a-before-cancel", "task.dag", {
							...auth(rootA),
							action: "status",
						})
					).result as { stateRevision: number }
				).stateRevision;
				expect(
					await request(restartedWs, "cancel-a-after-restart", "task.dag", {
						...auth(rootA),
						action: "cancel",
						graphId: "a",
						expectedRevision: revisionA,
						nodeIds: ["n"],
					}),
				).toMatchObject({ ok: true });
				expect([...tracked.closed]).toEqual([tracked.launched[0]]);
				expect(await tracked.provider.verify({ pid: tracked.launched[1] })).toBe("verified");

				const revisionB = (
					(
						await request(restartedWs, "status-b-before-cancel", "task.dag", {
							...auth(rootB),
							action: "status",
						})
					).result as { stateRevision: number }
				).stateRevision;
				expect(
					await request(restartedWs, "cancel-b-after-restart", "task.dag", {
						...auth(rootB),
						action: "cancel",
						graphId: "b",
						expectedRevision: revisionB,
						nodeIds: ["n"],
					}),
				).toMatchObject({ ok: true });
				expect([...tracked.closed].sort()).toEqual([...tracked.launched].sort());
			} finally {
				restartedWs.close();
				await restartedBroker.stop();
			}
		} finally {
			ws.close();
			await broker.stop();
		}
	});
	it("an ordinary spawn claim wins the shared key before managed reservation without stranding an attempt", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-managed-broker-ordinary-first-"));
		roots.push(root);
		const launches = { count: 0 };
		const broker = new Broker({
			agentDir: path.join(root, "agent"),
			packageGeneration: "test",
			masterCapabilityVerifier: verifier,
			spawnSubstrateProvider: substrate(launches),
			spawnPromptLayer: promptLayer,
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
				await request(ws, "define-before-ordinary", "task.dag", {
					...auth,
					action: "define",
					graphId: "g",
					expectedRevision: 0,
					nodes: [node("n", root, "ordinary-first")],
				}),
			).toMatchObject({ ok: true });

			const ordinaryInput = {
				cwd: root,
				task: "ordinary first",
				ownerSessionId: ownerId,
				attestationEpoch: epoch,
				masterCapability: grant,
			};
			expect(await request(ws, "ordinary-first", "session.spawn", ordinaryInput, "shared-key")).toMatchObject({
				ok: true,
			});
			expect(launches.count).toBe(1);

			expect(
				await request(
					ws,
					"managed-after-ordinary",
					"task.dag",
					{ ...auth, action: "advance", graphId: "g", nodeId: "n", expectedRevision: 1 },
					"shared-key",
				),
			).toMatchObject({
				ok: false,
				error: {
					code: "spawn_failed",
					message: "idempotency key conflicts with an existing ordinary session.spawn claim",
				},
			});
			const domain = JSON.parse(await fs.readFile(managedTaskDomainPath(root), "utf8")) as {
				graphs: Array<{ attempts: unknown[] }>;
			};
			expect(domain.graphs[0]!.attempts).toHaveLength(0);

			expect(await request(ws, "ordinary-replay", "session.spawn", ordinaryInput, "shared-key")).toMatchObject({
				ok: true,
				result: { code: "spawn_replayed" },
			});
			expect(launches.count).toBe(1);
		} finally {
			ws.close();
			await broker.stop();
		}
	});
	it("a managed reservation wins after ordinary preflight and blocks its later claim", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-managed-broker-managed-race-"));
		roots.push(root);
		const launches = { count: 0 };
		const modelResolveEntered = Promise.withResolvers<void>();
		const releaseModelResolve = Promise.withResolvers<void>();
		const broker = new Broker({
			agentDir: path.join(root, "agent"),
			packageGeneration: "test",
			masterCapabilityVerifier: verifier,
			resolveModelPin: async raw => {
				modelResolveEntered.resolve();
				await releaseModelResolve.promise;
				return { ok: true, model: String(raw) };
			},
			spawnSubstrateProvider: substrate(launches),
			spawnPromptLayer: promptLayer,
		});
		const discovery = await broker.start();
		const ws = await connect(`${discovery.url}/?token=${discovery.token}`);
		const wsManaged = await connect(`${discovery.url}/?token=${discovery.token}`);
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
				await request(ws, "define-race", "task.dag", {
					...auth,
					action: "define",
					graphId: "race",
					expectedRevision: 0,
					nodes: [node("n", root, "race")],
				}),
			).toMatchObject({ ok: true });

			const ordinary = request(
				ws,
				"ordinary-racing",
				"session.spawn",
				{
					cwd: root,
					task: "ordinary race",
					modelId: "test-model",
					ownerSessionId: ownerId,
					attestationEpoch: epoch,
					masterCapability: grant,
				},
				"shared-key",
			);
			// Ordinary spawn has passed managed preflight but has not attempted its durable claim.
			await modelResolveEntered.promise;
			const managed = await request(
				wsManaged,
				"managed-racing",
				"task.dag",
				{ ...auth, action: "advance", graphId: "race", nodeId: "n", expectedRevision: 1 },
				"shared-key",
			);
			expect(managed).toMatchObject({ ok: true });
			expect(launches.count).toBe(1);
			releaseModelResolve.resolve();
			expect(await ordinary).toMatchObject({
				ok: false,
				error: {
					code: "idempotency_conflict",
					message: "idempotency key is reserved by a managed task.dag attempt",
				},
			});
			expect(launches.count).toBe(1);

			const ordinaryIdentities = await Promise.all([
				deriveIdempotencyIdentity(broker.settings.agentDir, "session.spawn", "shared-key"),
				deriveLegacyIdentity(broker.settings.agentDir, "session.spawn", "shared-key"),
			]);
			const journal = (await Bun.file(path.join(broker.settings.agentDir, "sdk", "spawn-authority.jsonl")).text())
				.trim()
				.split("\n")
				.map(line => JSON.parse(line) as { claim?: { lifecycleIdentity?: string } });
			expect(journal.some(row => ordinaryIdentities.includes(row.claim?.lifecycleIdentity ?? ""))).toBe(false);
			const managedIdentity = await deriveScopedIdempotencyIdentity(
				broker.settings.agentDir,
				"session.spawn",
				"shared-key",
				root,
			);
			expect(journal.some(row => row.claim?.lifecycleIdentity === managedIdentity)).toBe(true);
		} finally {
			releaseModelResolve.resolve();
			ws.close();
			wsManaged.close();
			await broker.stop();
		}
	});
	// Keep a test-level watchdog above Bun's default for the 20 fresh broker lifecycles.
	it("cancel waits for delayed launch and closes its exact child before succeeding", async () => {
		for (let iteration = 0; iteration < 20; iteration += 1) {
			const root = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-managed-broker-launch-cancel-"));
			roots.push(root);
			const launchEntered = Promise.withResolvers<void>();
			const launchRelease = Promise.withResolvers<void>();
			const closedSignal = Promise.withResolvers<void>();
			const closed = new Set<number>();
			const closeProofs: Array<{ pid?: number; processIncarnation?: string }> = [];
			let closeCalls = 0;
			const launchedPid = 6123;
			const provider = {
				launch: async () => {
					launchEntered.resolve();
					await launchRelease.promise;
					return {
						ok: true as const,
						proof: {
							substrateKind: "headless" as const,
							providerIdentity: "managed-delayed-fixture",
							pid: launchedPid,
							processIncarnation: `inc-${launchedPid}`,
						},
					};
				},
				verify: async (proof: { pid?: number }) =>
					proof.pid !== undefined && closed.has(proof.pid) ? ("gone" as const) : ("verified" as const),
				close: async (proof: { pid?: number; processIncarnation?: string }) => {
					closeCalls += 1;
					closeProofs.push({ pid: proof.pid, processIncarnation: proof.processIncarnation });
					if (closeCalls === 1) return { ok: false };
					if (proof.pid !== undefined) closed.add(proof.pid);
					closedSignal.resolve();
					return { ok: true };
				},
			};
			const broker = new Broker({
				agentDir: path.join(root, "agent"),
				packageGeneration: "test",
				masterCapabilityVerifier: verifier,
				spawnSubstrateProvider: provider,
				spawnPromptLayer: promptLayer,
			});
			let wsForCleanup: WebSocket | undefined;
			let wsCancelForCleanup: WebSocket | undefined;
			try {
				setManagedCloseWaitForTest(broker, 20);
				const discovery = await broker.start();
				const ws = await connect(`${discovery.url}/?token=${discovery.token}`);
				wsForCleanup = ws;
				const wsCancel = await connect(`${discovery.url}/?token=${discovery.token}`);
				wsCancelForCleanup = wsCancel;
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
					await request(ws, "define-delayed", "task.dag", {
						...auth,
						action: "define",
						graphId: "delayed",
						expectedRevision: 0,
						nodes: [node("n", root, "delayed")],
					}),
				).toMatchObject({ ok: true });
				const advance = request(
					ws,
					"advance-delayed",
					"task.dag",
					{ ...auth, action: "advance", graphId: "delayed", nodeId: "n", expectedRevision: 1 },
					"delayed-key",
				);
				await launchEntered.promise;
				const currentRevision = (
					(await request(wsCancel, "status-before-cancel", "task.dag", { ...auth, action: "status" })).result as {
						stateRevision: number;
					}
				).stateRevision;
				const cancel = request(wsCancel, "cancel-delayed", "task.dag", {
					...auth,
					action: "cancel",
					graphId: "delayed",
					expectedRevision: currentRevision,
					nodeIds: ["n"],
				});
				expect(await cancel).toMatchObject({ ok: false, error: { code: "terminal_uncertain" } });
				const duringLaunch = JSON.parse(await fs.readFile(managedTaskDomainPath(root), "utf8")) as {
					graphs: Array<{ attempts: Array<{ fence: string }> }>;
				};
				expect(duringLaunch.graphs[0]!.attempts[0]!.fence).toBe("canceled");
				expect(closed.size).toBe(0);
				expect(closeCalls).toBe(0);
				expect(closeProofs).toEqual([]);
				launchRelease.resolve();
				expect(await advance).toMatchObject({ ok: false });
				await closedSignal.promise;
				expect([...closed]).toEqual([launchedPid]);
				expect(closeCalls).toBeGreaterThanOrEqual(2);
				expect(closeProofs).toEqual(
					Array.from({ length: closeCalls }, () => ({
						pid: launchedPid,
						processIncarnation: `inc-${launchedPid}`,
					})),
				);
			} finally {
				launchRelease.resolve();
				setManagedCloseWaitForTest(broker, undefined);
				wsForCleanup?.close();
				wsCancelForCleanup?.close();
				await broker.stop();
			}
		}
	}, 15_000);
	it("withholds discovery when restart cannot establish managed enrollment membership", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-managed-broker-enrollment-loss-"));
		roots.push(root);
		const agentDir = path.join(root, "agent");
		const tracked = trackedSubstrate();
		const broker = new Broker({
			agentDir,
			packageGeneration: "test",
			masterCapabilityVerifier: verifier,
			spawnSubstrateProvider: tracked.provider,
			spawnPromptLayer: promptLayer,
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
				await request(ws, "define-enrollment-loss", "task.dag", {
					...auth,
					action: "define",
					graphId: "g",
					expectedRevision: 0,
					nodes: [node("n", root, "enrollment-loss")],
				}),
			).toMatchObject({ ok: true });
			expect(
				await request(
					ws,
					"advance-enrollment-loss",
					"task.dag",
					{ ...auth, action: "advance", graphId: "g", nodeId: "n", expectedRevision: 1 },
					"enrollment-loss-key",
				),
			).toMatchObject({ ok: true });
			expect(tracked.launched).toHaveLength(1);
			const managedDomainBeforeRestart = JSON.parse(await fs.readFile(managedTaskDomainPath(root), "utf8")) as {
				state_revision: number;
			};
			ws.close();
			await broker.stop();
			await Bun.write(managedEnrollmentIndexPath(agentDir), "{ corrupt enrollment index");

			const restartedBroker = new Broker({
				agentDir,
				packageGeneration: "test",
				masterCapabilityVerifier: verifier,
				spawnSubstrateProvider: tracked.provider,
				spawnPromptLayer: promptLayer,
			});
			try {
				await expect(restartedBroker.start()).rejects.toThrow(
					"Broker cannot establish complete managed enrollment membership.",
				);
				expect(restartedBroker.discovery).toBeNull();
				expect(await readBrokerDiscovery(agentDir)).toBeNull();
				expect([...tracked.closed]).toEqual([]);
				expect(await tracked.provider.verify({ pid: tracked.launched[0] })).toBe("verified");
				const after = JSON.parse(await fs.readFile(managedTaskDomainPath(root), "utf8")) as {
					state_revision: number;
					graphs: Array<{ attempts: Array<{ fence: string; retired: boolean; worker: string }> }>;
				};
				expect(after.state_revision).toBe(managedDomainBeforeRestart.state_revision);
				expect(after.graphs[0]!.attempts[0]!.fence).toBe("current");
				expect(after.graphs[0]!.attempts[0]!.retired).toBe(false);
				expect(after.graphs[0]!.attempts[0]!.worker).not.toBe("closed");
			} finally {
				await restartedBroker.stop();
			}
		} finally {
			ws.close();
			await broker.stop();
		}
	});
	it("startup closes a proof-backed child for an already fenced managed attempt before discovery", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-managed-broker-fenced-restart-"));
		roots.push(root);
		const agentDir = path.join(root, "agent");
		const launchEntered = Promise.withResolvers<void>();
		const launchRelease = Promise.withResolvers<void>();
		const closed = new Set<number>();
		const pid = 7345;
		let dispatches = 0;
		let allowClose = false;
		let restartedBroker: Broker | undefined;
		let discoveryVisibleDuringRecoveryClose: boolean | undefined;
		const provider = {
			launch: async () => {
				launchEntered.resolve();
				await launchRelease.promise;
				return {
					ok: true as const,
					proof: {
						substrateKind: "headless" as const,
						providerIdentity: "managed-fenced-restart-fixture",
						pid,
						processIncarnation: `inc-${pid}`,
					},
				};
			},
			verify: async (proof: { pid?: number }) =>
				proof.pid !== undefined && closed.has(proof.pid) ? ("gone" as const) : ("verified" as const),
			close: async (proof: { pid?: number }) => {
				if (!allowClose) return { ok: false };
				discoveryVisibleDuringRecoveryClose = restartedBroker?.discovery !== null;
				if (proof.pid !== undefined) closed.add(proof.pid);
				return { ok: true };
			},
		};
		const spawnPromptLayer = {
			...promptLayer,
			dispatch: async () => {
				dispatches += 1;
				return {
					kind: "accepted" as const,
					commandId: "cmd-fenced",
					turnId: "turn-fenced",
					acceptedAt: Date.now(),
				};
			},
		};
		const broker = new Broker({
			agentDir,
			packageGeneration: "test",
			masterCapabilityVerifier: verifier,
			spawnSubstrateProvider: provider,
			spawnPromptLayer,
		});
		const discovery = await broker.start();
		const ws = await connect(`${discovery.url}/?token=${discovery.token}`);
		const wsStatus = await connect(`${discovery.url}/?token=${discovery.token}`);
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
				await request(ws, "define-fenced", "task.dag", {
					...auth,
					action: "define",
					graphId: "fenced",
					expectedRevision: 0,
					nodes: [node("n", root, "fenced-restart")],
				}),
			).toMatchObject({ ok: true });
			const advance = request(
				ws,
				"advance-fenced",
				"task.dag",
				{ ...auth, action: "advance", graphId: "fenced", nodeId: "n", expectedRevision: 1 },
				"fenced-key",
			);
			await launchEntered.promise;
			const binding = await createManagedDomainBinding({
				controlRoot: root,
				agentDir,
				enrollmentId: "enrollment",
				worktrees: [root],
			});
			const revision = (
				(await request(wsStatus, "status-fence-in-flight", "task.dag", { ...auth, action: "status" })).result as {
					stateRevision: number;
				}
			).stateRevision;
			await transactManagedTaskDomain({ binding, expectedRevision: revision }, async state => {
				const graph = state.graphs.find(item => item.id === "fenced");
				if (!graph) throw new Error("test graph missing");
				return cancelManagedTasks(graph, ["n"]);
			});
			launchRelease.resolve();
			expect(await advance).toMatchObject({ ok: false, error: { code: "terminal_uncertain" } });
			expect(dispatches).toBe(0);
			await broker.stop();

			allowClose = true;
			restartedBroker = new Broker({
				agentDir,
				packageGeneration: "test",
				masterCapabilityVerifier: verifier,
				spawnSubstrateProvider: provider,
				spawnPromptLayer,
			});
			const restartedDiscovery = await restartedBroker.start();
			try {
				expect(restartedDiscovery.ownerId).toBeTruthy();
				expect(discoveryVisibleDuringRecoveryClose).toBe(false);
				expect([...closed]).toEqual([pid]);
				expect(dispatches).toBe(0);
			} finally {
				await restartedBroker.stop();
			}
		} finally {
			launchRelease.resolve();
			ws.close();
			wsStatus.close();
			await broker.stop();
		}
	});
});

describe.skipIf(process.platform === "linux")("managed enrollment off Linux", () => {
	it("reads an absent index as empty but fails closed on a non-file index entry", async () => {
		const agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-managed-offlinux-"));
		roots.push(agentDir);
		expect(await loadManagedEnrollmentRecord(agentDir)).toEqual({
			controlRoots: [],
			establishedRoots: [],
			publishingRoots: [],
			nativeIdentities: [],
			byRoot: {},
		});
		const target = managedEnrollmentIndexPath(await fs.realpath(agentDir));
		await fs.mkdir(target, { recursive: true });
		await expect(loadManagedEnrollmentRecord(agentDir)).rejects.toThrow("corrupt managed enrollment index");
		await fs.rm(target, { recursive: true });
		await fs.symlink(path.join(agentDir, "missing"), target);
		await expect(loadManagedEnrollmentRecord(agentDir)).rejects.toThrow("corrupt managed enrollment index");
		// A symlinked ancestor (dangling or redirected) must not read as an absent index either.
		const namespace = path.dirname(target);
		await fs.rm(namespace, { recursive: true });
		await fs.symlink(path.join(agentDir, "missing-namespace"), namespace);
		await expect(loadManagedEnrollmentRecord(agentDir)).rejects.toThrow("corrupt managed enrollment index");
		await fs.rm(namespace);
		const elsewhere = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-managed-offlinux-elsewhere-"));
		roots.push(elsewhere);
		await fs.symlink(elsewhere, namespace);
		await expect(loadManagedEnrollmentRecord(agentDir)).rejects.toThrow("corrupt managed enrollment index");
	});

	it("starts a broker that never used task.dag", async () => {
		const agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-managed-offlinux-broker-"));
		roots.push(agentDir);
		const broker = new Broker({ agentDir: path.join(agentDir, "agent"), packageGeneration: "test" });
		try {
			expect((await broker.start()).url).toStartWith("ws");
		} finally {
			await broker.stop();
		}
	});
});
