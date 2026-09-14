import { afterEach, describe, expect, it, spyOn } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Broker } from "../src/sdk/broker/broker";
import { getBrokerIdentityKey } from "../src/sdk/broker/identity";
import { managedEnrollmentIndexPath, managedIdentity, managedTaskDomainPath } from "../src/sdk/broker/managed-task-dag";
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
			expect(
				await request(ws, "cancel-a", "task.dag", {
					...auth,
					action: "cancel",
					graphId: "a",
					expectedRevision: liveRevision,
					nodeIds: ["a"],
				}),
			).toMatchObject({ ok: true });
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
	it("corrupt established managed domain does not abort unmanaged broker start", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-managed-isolate-"));
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
		} finally {
			ws.close();
			await first.stop();
		}
		await fs.writeFile(managedTaskDomainPath(root), "{");
		const second = new Broker({
			agentDir,
			packageGeneration: "test",
			masterCapabilityVerifier: verifier,
			spawnSubstrateProvider: substrate(launches, closes),
			spawnPromptLayer: promptLayer(),
		});
		const restarted = await second.start();
		expect(restarted.url).toMatch(/^ws:\/\//);
		await second.stop();
	});
	it("unreadable enrollment index refuses ordinary spawn without blocking unrelated keys when the index is readable", async () => {
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
		} finally {
			ws.close();
			await first.stop();
		}
		await fs.writeFile(managedEnrollmentIndexPath(agentDir), "{");
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
			const managed = await request(
				ws2,
				"ordinary-managed",
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
			expect(managed).toMatchObject({ ok: false, error: { code: "spawn_failed" } });
			expect(launches.count).toBe(1);
			const unrelated = await request(
				ws2,
				"ordinary-unrelated",
				"session.spawn",
				{
					cwd: root,
					task: "unrelated",
					ownerSessionId: ownerId,
					attestationEpoch: epoch,
					masterCapability: grant,
				},
				"key-unrelated",
			);
			expect(unrelated).toMatchObject({ ok: false, error: { code: "spawn_failed" } });
			expect(launches.count).toBe(1);
		} finally {
			ws2.close();
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
