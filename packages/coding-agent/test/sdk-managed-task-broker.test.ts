import { afterEach, describe, expect, it, spyOn } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Broker } from "../src/sdk/broker/broker";
import { deriveIdempotencyIdentity } from "../src/sdk/broker/identity";
import { managedIdentity, managedTaskDomainPath } from "../src/sdk/broker/managed-task-dag";
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

describe("managed task.dag broker admission (test-only, no M3 recovery)", () => {
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
			const nativeA = await deriveIdempotencyIdentity(broker.settings.agentDir, "session.spawn", "key-a");
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
		const persistTransition = SpawnAuthorityStore.prototype.persistTransition;
		const entered = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		let transitionCommitted = false;
		const broker = new Broker({
			agentDir: path.join(root, "agent"),
			packageGeneration: "test",
			masterCapabilityVerifier: verifier,
			spawnSubstrateProvider: substrate(launches),
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
});
