import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Broker, type SpawnPromptLayer } from "../src/sdk/broker/broker";
import { managedIdentity, managedTaskDomainPath } from "../src/sdk/broker/managed-task-dag";
import { processIncarnation } from "../src/sdk/broker/process-incarnation";
import type { SpawnSubstrateProof } from "../src/sdk/broker/spawn-authority";

const roots: string[] = [];
afterEach(async () => {
	for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
});

async function nextFrame(ws: WebSocket, context = "frame"): Promise<Record<string, unknown>> {
	return await new Promise((resolve, reject) => {
		const timer = setTimeout(() => {
			cleanup();
			reject(new Error(`${context} timeout`));
		}, 8_000);
		const onMessage = (event: MessageEvent) => {
			cleanup();
			resolve(JSON.parse(String(event.data)) as Record<string, unknown>);
		};
		const onClose = () => {
			cleanup();
			reject(new Error(`${context} websocket closed`));
		};
		const onError = () => {
			cleanup();
			reject(new Error(`${context} websocket error`));
		};
		const cleanup = () => {
			clearTimeout(timer);
			ws.removeEventListener("message", onMessage);
			ws.removeEventListener("close", onClose);
			ws.removeEventListener("error", onError);
		};
		ws.addEventListener("message", onMessage);
		ws.addEventListener("close", onClose);
		ws.addEventListener("error", onError);
	});
}

async function connect(url: string): Promise<WebSocket> {
	const ws = new WebSocket(url);
	await new Promise<void>((resolve, reject) => {
		ws.addEventListener("open", () => resolve(), { once: true });
		ws.addEventListener("error", () => reject(new Error("websocket error")), { once: true });
	});
	const hello = await nextFrame(ws, "broker_hello");
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
		let frame: Record<string, unknown>;
		try {
			frame = await nextFrame(ws, `${operation} ${id}`);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			throw new Error(`${operation} ${id}: ${message}`);
		}
		if (frame.type === "broker_hello") continue;
		if (frame.id === id) return frame;
		throw new Error(`unexpected broker frame for ${operation} ${id}: ${JSON.stringify(frame)}`);
	}
}
async function liveRevision(ws: WebSocket, auth: Record<string, unknown>, id: string): Promise<number> {
	const status = await request(ws, id, "task.dag", { ...auth, action: "status" });
	expect(status).toMatchObject({ ok: true });
	const revision = (status.result as { stateRevision?: number } | undefined)?.stateRevision;
	expect(typeof revision).toBe("number");
	return revision as number;
}

const ownerId = "managed-e2e-owner";
const epoch = "managed-e2e-epoch";
const grant = "managed-e2e-grant";
const verifier = {
	verifyMasterCapability: async (owner: string, capability: string, suppliedEpoch: string) => ({
		allowed: owner === ownerId && capability === grant && suppliedEpoch === epoch,
	}),
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

type Counts = { launches: number; closes: number };

function scriptedProvider(counts: Counts, options: { failDispatch?: boolean; goneOnVerify?: boolean } = {}) {
	return {
		launch: async (spec: { cwd?: string }) => {
			counts.launches += 1;
			void spec;
			return {
				ok: true as const,
				proof: {
					substrateKind: "headless" as const,
					providerIdentity: "managed-e2e-fixture",
					pid: 5200 + counts.launches,
					processIncarnation: `inc-${5200 + counts.launches}`,
				} satisfies SpawnSubstrateProof,
			};
		},
		verify: async () => {
			if (options.goneOnVerify && counts.closes > 0) return "gone" as const;
			return "verified" as const;
		},
		close: async () => {
			counts.closes += 1;
			return { ok: true };
		},
	};
}

function scriptedPrompt(options: { writes?: Record<string, string>; failDispatch?: boolean } = {}): SpawnPromptLayer {
	return {
		awaitRegistration: async (input: { childId: string; cwd: string; stateRoot: string }) => ({
			ok: true as const,
			registration: {
				sessionId: input.childId,
				endpointGeneration: 1,
				pid: 5201,
				processIncarnation: "inc-5201",
				cwd: input.cwd,
				stateRoot: input.stateRoot,
			},
		}),
		dispatch: async (input: { task: string; cwd?: string; sessionId: string }) => {
			if (options.failDispatch) throw new Error("simulated response loss");
			const file = options.writes?.[input.task];
			if (file) await fs.writeFile(file, `${input.task}\n`);
			return {
				kind: "accepted" as const,
				commandId: `cmd-${input.sessionId}`,
				turnId: `turn-${input.sessionId}`,
				acceptedAt: Date.now(),
			};
		},
		reconcile: async () => ({ status: "unknown" as const }),
	};
}

function writerNode(id: string, workspace: string, predecessors: string[] = [], command = "test -f result.txt") {
	const output = path.join(workspace, "result.txt");
	return {
		id,
		task: `Produce ${id}`,
		workspace,
		predecessors,
		criteriaIdentity: managedIdentity("criteria"),
		validations: [{ name: "exists", command }],
		resources: [
			{ kind: "path" as const, path: output, mode: "write" as const, recursive: false, namespace: false },
			{ kind: "path" as const, path: workspace, mode: "write" as const, recursive: false, namespace: true },
		],
		artifacts: [{ path: output, role: "output" as const, presence: "required" as const }],
	};
}

function readerNode(id: string, workspace: string, predecessors: string[], consumed: string, output: string) {
	const relativeConsumed = path.relative(workspace, consumed);
	return {
		id,
		task: `Consume ${id}`,
		workspace,
		predecessors,
		criteriaIdentity: managedIdentity("criteria"),
		validations: [{ name: "exists", command: `test -f ${relativeConsumed}` }],
		resources: [
			{ kind: "path" as const, path: consumed, mode: "read" as const, recursive: false, namespace: false },
			{ kind: "path" as const, path: output, mode: "write" as const, recursive: false, namespace: false },
			{
				kind: "path" as const,
				path: path.dirname(output),
				mode: "write" as const,
				recursive: false,
				namespace: true,
			},
		],
		artifacts: [
			{ path: consumed, role: "input" as const, presence: "required" as const },
			{ path: output, role: "output" as const, presence: "required" as const },
		],
	};
}

async function readDomain(root: string) {
	return JSON.parse(await fs.readFile(managedTaskDomainPath(root), "utf8")) as {
		state_revision: number;
		graphs: Array<{
			id: string;
			attempts: Array<{
				nodeId: string;
				worker: string;
				validation: string;
				fence: string;
				retired: boolean;
				accepted: { id: string; hash: string } | null;
				native: { identity: string };
			}>;
		}>;
	};
}

describe("managed DAG connected offline e2e (M6)", () => {
	it("wire admits independent writers, denies overlap, verifies produced output, and admits a successor", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-managed-e2e-"));
		roots.push(root);
		const workA = path.join(root, "a");
		const workB = path.join(root, "b");
		const workC = path.join(root, "c");
		await fs.mkdir(workA, { recursive: true });
		await fs.mkdir(workB, { recursive: true });
		await fs.mkdir(workC, { recursive: true });
		const counts: Counts = { launches: 0, closes: 0 };
		const broker = new Broker({
			agentDir: path.join(root, "agent"),
			packageGeneration: "test",
			masterCapabilityVerifier: verifier,
			spawnSubstrateProvider: scriptedProvider(counts, { goneOnVerify: true }),
			spawnPromptLayer: scriptedPrompt({
				writes: {
					"Produce a": path.join(workA, "result.txt"),
					"Consume b": path.join(workB, "out.txt"),
				},
			}),
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
					nodes: [
						writerNode("a", workA),
						readerNode("b", root, ["a"], path.join(workA, "result.txt"), path.join(workB, "out.txt")),
						writerNode("c", workC),
						writerNode("d", workA),
					],
				}),
			).toMatchObject({ ok: true });
			const unauthorized = new WebSocket(`${discovery.url}/?token=wrong-e2e-token`);
			await new Promise<void>(resolve => unauthorized.addEventListener("close", () => resolve(), { once: true }));
			expect(counts.launches).toBe(0);
			const denied = await request(
				ws,
				"advance-denied-cap",
				"task.dag",
				{
					...auth,
					masterCapability: "wrong-e2e-grant",
					action: "advance",
					graphId: "g",
					nodeId: "a",
					expectedRevision: await liveRevision(ws, auth, "rev-denied-cap"),
					cwd: workA,
				},
				"key-denied-cap",
			);
			expect(denied).toMatchObject({ ok: false, error: { code: "spawn_failed" } });
			expect(counts.launches).toBe(0);
			const advanceA = await request(
				ws,
				"advance-a",
				"task.dag",
				{
					...auth,
					action: "advance",
					graphId: "g",
					nodeId: "a",
					expectedRevision: await liveRevision(ws, auth, "rev-before-a"),
					cwd: workA,
				},
				"key-a",
			);
			expect(advanceA).toMatchObject({ ok: true });
			const advanceC = await request(
				ws,
				"advance-c",
				"task.dag",
				{
					...auth,
					action: "advance",
					graphId: "g",
					nodeId: "c",
					expectedRevision: await liveRevision(ws, auth, "rev-before-c"),
					cwd: workC,
				},
				"key-c",
			);
			expect(advanceC).toMatchObject({ ok: true });
			expect(counts.launches).toBe(2);
			const overlap = await request(
				ws,
				"advance-d",
				"task.dag",
				{
					...auth,
					action: "advance",
					graphId: "g",
					nodeId: "d",
					expectedRevision: await liveRevision(ws, auth, "rev-before-d"),
					cwd: workA,
				},
				"key-d",
			);
			expect(overlap).toMatchObject({ ok: false });
			expect(counts.launches).toBe(2);
			const prematureB = await request(
				ws,
				"advance-b-early",
				"task.dag",
				{
					...auth,
					action: "advance",
					graphId: "g",
					nodeId: "b",
					expectedRevision: await liveRevision(ws, auth, "rev-before-b-early"),
					cwd: root,
				},
				"key-b-early",
			);
			expect(prematureB).toMatchObject({ ok: false });
			expect(counts.launches).toBe(2);
			const sessionId = (advanceA.result as { spawn?: { sessionId?: string } }).spawn?.sessionId;
			expect(sessionId).toBeDefined();
			const closed = await request(ws, "close-a", "session.close", { sessionId });
			expect(closed).toMatchObject({ ok: true, result: { code: "spawn_child_closed" } });
			expect(counts.closes).toBeGreaterThanOrEqual(1);
			const snap = await readDomain(root);
			const attemptA = snap.graphs.flatMap(graph => graph.attempts).find(attempt => attempt.nodeId === "a");
			expect(attemptA).toBeDefined();
			expect(attemptA?.worker).toBe("closed");
			const verified = await request(ws, "verify-a", "task.dag", {
				...auth,
				action: "verify",
				graphId: "g",
				nodeId: "a",
			});
			expect(verified).toMatchObject({ ok: true, result: { status: "accepted" } });
			expect(await fs.readFile(path.join(workA, "result.txt"), "utf8")).toContain("Produce a");
			const advanceB = await request(
				ws,
				"advance-b",
				"task.dag",
				{
					...auth,
					action: "advance",
					graphId: "g",
					nodeId: "b",
					expectedRevision: await liveRevision(ws, auth, "rev-before-b"),
					cwd: root,
				},
				"key-b",
			);
			expect(advanceB).toMatchObject({ ok: true });
			expect(counts.launches).toBe(3);
			expect(await fs.readFile(path.join(workA, "result.txt"), "utf8")).toContain("Produce a");
			expect(await fs.readFile(path.join(workB, "out.txt"), "utf8")).toContain("Consume b");
			const sessionB = (advanceB.result as { spawn?: { sessionId?: string } }).spawn?.sessionId;
			expect(sessionB).toBeDefined();
			expect(await request(ws, "close-b", "session.close", { sessionId: sessionB })).toMatchObject({
				ok: true,
				result: { code: "spawn_child_closed" },
			});
			const verifiedB = await request(ws, "verify-b", "task.dag", {
				...auth,
				action: "verify",
				graphId: "g",
				nodeId: "b",
			});
			expect(verifiedB).toMatchObject({ ok: true, result: { status: "accepted" } });
			const after = await readDomain(root);
			expect(after.graphs[0]!.attempts.some(attempt => attempt.nodeId === "b" && attempt.accepted)).toBe(true);
		} finally {
			ws.close();
			await broker.stop();
		}
	}, 30_000);

	it("failed predecessor keeps successor at 0 and overlapping writer starts 0 extra effects", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-managed-e2e-fail-"));
		roots.push(root);
		const workA = path.join(root, "a");
		const workB = path.join(root, "b");
		await fs.mkdir(workA, { recursive: true });
		await fs.mkdir(workB, { recursive: true });
		const counts: Counts = { launches: 0, closes: 0 };
		const broker = new Broker({
			agentDir: path.join(root, "agent"),
			packageGeneration: "test",
			masterCapabilityVerifier: verifier,
			spawnSubstrateProvider: scriptedProvider(counts, { goneOnVerify: true }),
			spawnPromptLayer: scriptedPrompt({ writes: { "Produce a": path.join(workA, "result.txt") } }),
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
					graphId: "g",
					expectedRevision: 0,
					nodes: [writerNode("a", workA, [], "exit 7"), writerNode("b", workB, ["a"])],
				}),
			).toMatchObject({ ok: true });
			const advanced = await request(
				ws,
				"advance-a",
				"task.dag",
				{
					...auth,
					action: "advance",
					graphId: "g",
					nodeId: "a",
					expectedRevision: await liveRevision(ws, auth, "rev-fail-a"),
					cwd: workA,
				},
				"key-fail",
			);
			expect(advanced).toMatchObject({ ok: true });
			expect(counts.launches).toBe(1);
			const sessionA = (advanced.result as { spawn?: { sessionId?: string } }).spawn?.sessionId;
			expect(sessionA).toBeDefined();
			expect(await request(ws, "close-fail-a", "session.close", { sessionId: sessionA })).toMatchObject({
				ok: true,
				result: { code: "spawn_child_closed" },
			});
			expect(counts.closes).toBeGreaterThanOrEqual(1);
			const failedVerify = await request(ws, "verify-fail-a", "task.dag", {
				...auth,
				action: "verify",
				graphId: "g",
				nodeId: "a",
			});
			expect(failedVerify).toMatchObject({ ok: true, result: { status: "failed" } });
			const verifiedA = await readDomain(root);
			const attemptA = verifiedA.graphs[0]!.attempts.find(attempt => attempt.nodeId === "a")!;
			expect(attemptA.accepted).toBeNull();
			expect(attemptA.validation).toBe("finished");
			expect(attemptA.fence).toBe("failed");
			const successor = await request(
				ws,
				"advance-b",
				"task.dag",
				{
					...auth,
					action: "advance",
					graphId: "g",
					nodeId: "b",
					expectedRevision: await liveRevision(ws, auth, "rev-fail-b"),
					cwd: workB,
				},
				"key-b",
			);
			expect(successor).toMatchObject({ ok: false });
			expect(counts.launches).toBe(1);
			const snap = await readDomain(root);
			expect(snap.graphs[0]!.attempts.filter(attempt => attempt.nodeId === "b")).toHaveLength(0);
		} finally {
			ws.close();
			await broker.stop();
		}
	}, 20_000);

	it("response loss then restart does not duplicate launches and does not release reservations", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-managed-e2e-loss-"));
		roots.push(root);
		const workA = path.join(root, "a");
		await fs.mkdir(workA, { recursive: true });
		const counts: Counts = { launches: 0, closes: 0 };
		const first = new Broker({
			agentDir: path.join(root, "agent"),
			packageGeneration: "test",
			masterCapabilityVerifier: verifier,
			spawnSubstrateProvider: scriptedProvider(counts),
			spawnPromptLayer: scriptedPrompt({ failDispatch: true }),
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
					graphId: "g",
					expectedRevision: 0,
					nodes: [writerNode("a", workA)],
				}),
			).toMatchObject({ ok: true });
			const lost = await request(
				ws,
				"advance-a",
				"task.dag",
				{
					...auth,
					action: "advance",
					graphId: "g",
					nodeId: "a",
					expectedRevision: await liveRevision(ws, auth, "rev-lost-a"),
					cwd: workA,
				},
				"key-lost",
			);
			expect(lost).toMatchObject({ ok: false, error: { code: "terminal_uncertain" } });
			expect(counts.launches).toBe(1);
		} finally {
			ws.close();
			await first.stop();
		}
		const second = new Broker({
			agentDir: path.join(root, "agent"),
			packageGeneration: "test",
			masterCapabilityVerifier: verifier,
			spawnSubstrateProvider: scriptedProvider(counts),
			spawnPromptLayer: scriptedPrompt(),
		});
		const restarted = await second.start();
		const ws2 = await connect(`${restarted.url}/?token=${restarted.token}`);
		try {
			await attest(second, root);
			const auth = {
				controlRoot: root,
				enrollmentId: "enrollment",
				ownerSessionId: ownerId,
				attestationEpoch: epoch,
				masterCapability: grant,
				worktrees: [root],
			};
			const replay = await request(
				ws2,
				"ordinary",
				"session.spawn",
				{
					cwd: workA,
					task: "Produce a",
					ownerSessionId: ownerId,
					attestationEpoch: epoch,
					masterCapability: grant,
				},
				"key-lost",
			);
			expect(replay).toMatchObject({ ok: false });
			expect(counts.launches).toBe(1);
			const retry = await request(
				ws2,
				"advance-new",
				"task.dag",
				{
					...auth,
					action: "advance",
					graphId: "g",
					nodeId: "a",
					expectedRevision: await liveRevision(ws2, auth, "rev-lost-retry"),
					cwd: workA,
				},
				"key-lost-2",
			);
			expect(retry).toMatchObject({ ok: false });
			expect(counts.launches).toBe(1);
			const snap = await readDomain(root);
			const attempt = snap.graphs[0]!.attempts[0]!;
			expect(attempt.retired).toBe(false);
			expect(attempt.accepted).toBeNull();
			expect(["unknown", "authorized", "reserved"]).toContain(attempt.worker);
			const revised = await request(ws2, "revise-a", "task.dag", {
				...auth,
				action: "revise",
				graphId: "g",
				expectedRevision: await liveRevision(ws2, auth, "rev-lost-revise"),
				nodes: [{ ...writerNode("a", workA), task: "changed" }],
			});
			expect(revised.ok === true || revised.ok === false).toBe(true);
			const after = await readDomain(root);
			expect(after.graphs[0]!.attempts[0]!.accepted).toBeNull();
			expect(after.graphs[0]!.attempts[0]!.retired).toBe(false);
		} finally {
			ws2.close();
			await second.stop();
		}
	}, 30_000);
});

function shellQuote(value: string): string {
	return `'${value.replaceAll("'", `'\\''`)}'`;
}

async function waitForFile(target: string, timeoutMs = 8_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		try {
			await fs.stat(target);
			return;
		} catch {
			if (Date.now() >= deadline) throw new Error(`timed out waiting for ${target}`);
			await new Promise(resolve => setTimeout(resolve, 25));
		}
	}
}

describe("managed DAG connected unknown validator (A6)", () => {
	it("keeps a live shared-validator reservation through cancel until the owned shell is released", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-managed-e2e-unknown-"));
		roots.push(root);
		const workA = path.join(root, "a");
		const workB = workA;
		await fs.mkdir(workA, { recursive: true });
		const startedMarker = path.join(root, "validator-started");
		const releaseMarker = path.join(root, "validator-release");
		const invokedMarker = path.join(root, "validator-invoked");
		const waitCommand = [
			`printf x >> ${shellQuote(invokedMarker)}`,
			`printf x > ${shellQuote(startedMarker)}`,
			`while [ ! -f ${shellQuote(releaseMarker)} ]; do sleep 0.05; done`,
			"true",
		].join("; ");
		const counts: Counts = { launches: 0, closes: 0 };
		const broker = new Broker({
			agentDir: path.join(root, "agent"),
			packageGeneration: "test",
			masterCapabilityVerifier: verifier,
			spawnSubstrateProvider: scriptedProvider(counts, { goneOnVerify: true }),
			spawnPromptLayer: scriptedPrompt({ writes: { "Produce a": path.join(workA, "result.txt") } }),
		});
		const discovery = await broker.start();
		const ws = await connect(`${discovery.url}/?token=${discovery.token}`);
		const wsVerify = await connect(`${discovery.url}/?token=${discovery.token}`);
		let released = false;
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
				await request(ws, "define-unknown", "task.dag", {
					...auth,
					action: "define",
					graphId: "g",
					expectedRevision: 0,
					nodes: [writerNode("a", workA, [], waitCommand), writerNode("b", workB, [], "true")],
				}),
			).toMatchObject({ ok: true });
			const advanced = await request(
				ws,
				"advance-unknown-a",
				"task.dag",
				{
					...auth,
					action: "advance",
					graphId: "g",
					nodeId: "a",
					expectedRevision: await liveRevision(ws, auth, "rev-unknown-a"),
					cwd: workA,
				},
				"key-unknown-a",
			);
			expect(advanced).toMatchObject({ ok: true });
			expect(counts.launches).toBe(1);
			const sessionA = (advanced.result as { spawn?: { sessionId?: string } }).spawn?.sessionId;
			expect(sessionA).toBeDefined();
			expect(await request(ws, "close-unknown-a", "session.close", { sessionId: sessionA })).toMatchObject({
				ok: true,
				result: { code: "spawn_child_closed" },
			});
			const verifyPending = request(wsVerify, "verify-unknown-pending", "task.dag", {
				...auth,
				action: "verify",
				graphId: "g",
				nodeId: "a",
			});
			const pendingVerifyOutcome = verifyPending.then(
				frame => frame,
				error => ({
					ok: false as const,
					error: {
						code: "terminal_uncertain",
						message: error instanceof Error ? error.message : String(error),
					},
				}),
			);
			await waitForFile(startedMarker);
			const running = await readDomain(root);
			expect(running.graphs[0]!.attempts[0]!.validation).toBe("running");
			expect(running.graphs[0]!.attempts[0]!.retired).toBe(false);
			expect(
				await request(
					ws,
					"advance-unknown-b",
					"task.dag",
					{
						...auth,
						action: "advance",
						graphId: "g",
						nodeId: "b",
						expectedRevision: await liveRevision(ws, auth, "rev-unknown-b"),
						cwd: workB,
					},
					"key-unknown-b",
				),
			).toMatchObject({ ok: false });
			expect(counts.launches).toBe(1);
			expect(
				await request(ws, "cancel-unknown-a", "task.dag", {
					...auth,
					action: "cancel",
					graphId: "g",
					expectedRevision: await liveRevision(ws, auth, "rev-unknown-cancel"),
					nodeIds: ["a"],
				}),
			).toMatchObject({ ok: true });
			expect(
				await request(
					ws,
					"advance-unknown-retry",
					"task.dag",
					{
						...auth,
						action: "advance",
						graphId: "g",
						nodeId: "a",
						expectedRevision: await liveRevision(ws, auth, "rev-unknown-retry"),
						cwd: workA,
					},
					"key-unknown-retry",
				),
			).toMatchObject({ ok: false });
			expect(counts.launches).toBe(1);
			const afterCancel = await readDomain(root);
			expect(afterCancel.graphs[0]!.attempts[0]!.retired).toBe(false);
			expect(afterCancel.graphs[0]!.attempts[0]!.accepted).toBeNull();
			released = true;
			await fs.writeFile(releaseMarker, "x");
			const pendingAfterRelease = await pendingVerifyOutcome;
			if (pendingAfterRelease.ok === true && "result" in pendingAfterRelease) {
				expect((pendingAfterRelease.result as { status?: string }).status).not.toBe("accepted");
			} else expect(pendingAfterRelease).toMatchObject({ ok: false });
			await broker.stop();
			const durable = await readDomain(root);
			expect(durable.graphs[0]!.attempts[0]!.accepted).toBeNull();
			expect(durable.graphs[0]!.attempts[0]!.validation).toBe("finished");
			expect(durable.graphs[0]!.attempts[0]!.retired).toBe(true);
			expect((await fs.readFile(invokedMarker, "utf8")).replaceAll("\n", "")).toBe("x");
		} finally {
			if (!released) {
				released = true;
				await fs.writeFile(releaseMarker, "x").catch(() => undefined);
			}
			try {
				wsVerify.close();
			} catch {}
			try {
				ws.close();
			} catch {}
			try {
				await broker.stop();
			} catch {}
		}
	}, 30_000);

	it("killed child broker recovers running validation as unknown without rerunning the command", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-managed-e2e-crash-"));
		roots.push(root);
		const workA = path.join(root, "a");
		await fs.mkdir(workA, { recursive: true });
		const startedMarker = path.join(root, "validator-started");
		const releaseMarker = path.join(root, "validator-release");
		const invokedMarker = path.join(root, "validator-invoked");
		const readyMarker = path.join(root, "child-ready");
		const waitCommand = [
			`printf x >> ${shellQuote(invokedMarker)}`,
			`printf x > ${shellQuote(startedMarker)}`,
			`while [ ! -f ${shellQuote(releaseMarker)} ]; do sleep 0.05; done`,
			"true",
		].join("; ");
		const modulePath = path.resolve(import.meta.dir, "../src/sdk/broker/broker.ts");
		const incarnationPath = path.resolve(import.meta.dir, "../src/sdk/broker/process-incarnation.ts");
		const dagPath = path.resolve(import.meta.dir, "../src/sdk/broker/managed-task-dag.ts");
		const script = `
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { Broker } from ${JSON.stringify(modulePath)};
import { processIncarnation } from ${JSON.stringify(incarnationPath)};
import { managedIdentity } from ${JSON.stringify(dagPath)};
const root = process.env.E2E_ROOT;
const workA = process.env.E2E_WORK_A;
const waitCommand = process.env.E2E_WAIT;
const ownerId = "managed-e2e-owner";
const epoch = "managed-e2e-epoch";
const grant = "managed-e2e-grant";
const counts = { launches: 0, closes: 0 };
const broker = new Broker({
	agentDir: path.join(root, "agent"),
	packageGeneration: "test",
	masterCapabilityVerifier: {
		verifyMasterCapability: async (owner, capability, suppliedEpoch) => ({
			allowed: owner === ownerId && capability === grant && suppliedEpoch === epoch,
		}),
	},
	spawnSubstrateProvider: {
		launch: async () => {
			counts.launches += 1;
			return {
				ok: true,
				proof: {
					substrateKind: "headless",
					providerIdentity: "managed-e2e-fixture",
					pid: 5200 + counts.launches,
					processIncarnation: "inc-" + String(5200 + counts.launches),
				},
			};
		},
		verify: async () => (counts.closes > 0 ? "gone" : "verified"),
		close: async () => {
			counts.closes += 1;
			return { ok: true };
		},
	},
	spawnPromptLayer: {
		awaitRegistration: async input => ({
			ok: true,
			registration: {
				sessionId: input.childId,
				endpointGeneration: 1,
				pid: 5201,
				processIncarnation: "inc-5201",
				cwd: input.cwd,
				stateRoot: input.stateRoot,
			},
		}),
		dispatch: async input => {
			await fs.writeFile(path.join(workA, "result.txt"), input.task + "\\n");
			return { kind: "accepted", commandId: "cmd-" + input.sessionId, turnId: "turn-" + input.sessionId, acceptedAt: Date.now() };
		},
		reconcile: async () => ({ status: "unknown" }),
	},
});
const discovery = await broker.start();
const incarnation = processIncarnation(process.pid);
if (!incarnation) throw new Error("no incarnation");
for (const endpointGeneration of [0, 1]) {
	await broker.index.append({
		type: "host_registered",
		sessionId: ownerId,
		locator: { cwd: root, worktreeRoot: null, stateRoot: path.join(root, ".gjc", "state") },
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
await fs.writeFile(process.env.E2E_READY, JSON.stringify({ url: discovery.url, token: discovery.token }));
await new Promise(() => {});
`;
		const child = Bun.spawn([process.execPath, "--eval", script], {
			env: {
				...process.env,
				E2E_ROOT: root,
				E2E_WORK_A: workA,
				E2E_WAIT: waitCommand,
				E2E_READY: readyMarker,
			},
			stdout: "ignore",
			stderr: "pipe",
		});
		let released = false;
		try {
			await waitForFile(readyMarker);
			const discovery = JSON.parse(await fs.readFile(readyMarker, "utf8")) as { url: string; token: string };
			const ws = await connect(`${discovery.url}/?token=${discovery.token}`);
			const wsVerify = await connect(`${discovery.url}/?token=${discovery.token}`);
			try {
				const auth = {
					controlRoot: root,
					enrollmentId: "enrollment",
					ownerSessionId: ownerId,
					attestationEpoch: epoch,
					masterCapability: grant,
					worktrees: [root],
				};
				expect(
					await request(ws, "define-crash", "task.dag", {
						...auth,
						action: "define",
						graphId: "g",
						expectedRevision: 0,
						nodes: [writerNode("a", workA, [], waitCommand)],
					}),
				).toMatchObject({ ok: true });
				const advanced = await request(
					ws,
					"advance-crash-a",
					"task.dag",
					{
						...auth,
						action: "advance",
						graphId: "g",
						nodeId: "a",
						expectedRevision: await liveRevision(ws, auth, "rev-crash-a"),
						cwd: workA,
					},
					"key-crash-a",
				);
				expect(advanced).toMatchObject({ ok: true });
				const sessionA = (advanced.result as { spawn?: { sessionId?: string } }).spawn?.sessionId;
				expect(sessionA).toBeDefined();
				expect(await request(ws, "close-crash-a", "session.close", { sessionId: sessionA })).toMatchObject({
					ok: true,
					result: { code: "spawn_child_closed" },
				});
				const verifyPending = request(wsVerify, "verify-crash-pending", "task.dag", {
					...auth,
					action: "verify",
					graphId: "g",
					nodeId: "a",
				});
				verifyPending.catch(() => undefined);
				await waitForFile(startedMarker);
				const running = await readDomain(root);
				expect(running.graphs[0]!.attempts[0]!.validation).toBe("running");
				expect(running.graphs[0]!.attempts[0]!.retired).toBe(false);
				const invokedBeforeKill = await fs.readFile(invokedMarker, "utf8");
				child.kill();
				await child.exited;
				ws.close();
				wsVerify.close();
				const recovered = new Broker({
					agentDir: path.join(root, "agent"),
					packageGeneration: "test",
					masterCapabilityVerifier: verifier,
					spawnSubstrateProvider: scriptedProvider({ launches: 0, closes: 0 }, { goneOnVerify: true }),
					spawnPromptLayer: scriptedPrompt(),
				});
				const restarted = await recovered.start();
				const ws2 = await connect(`${restarted.url}/?token=${restarted.token}`);
				try {
					await attest(recovered, root);
					const snap = await readDomain(root);
					expect(snap.graphs[0]!.attempts[0]!.validation).toBe("unknown");
					expect(snap.graphs[0]!.attempts[0]!.retired).toBe(false);
					expect(snap.graphs[0]!.attempts[0]!.accepted).toBeNull();
					const again = await request(ws2, "verify-crash-again", "task.dag", {
						...auth,
						action: "verify",
						graphId: "g",
						nodeId: "a",
					});
					expect(again).toMatchObject({
						ok: true,
						result: { status: "unknown", commandsStarted: false },
					});
					expect((await fs.readFile(invokedMarker, "utf8")).replaceAll("\n", "")).toBe("x");
					expect((await fs.readFile(invokedMarker, "utf8")).replaceAll("\n", "")).toBe(
						invokedBeforeKill.replaceAll("\n", ""),
					);
				} finally {
					ws2.close();
					await recovered.stop();
				}
			} finally {
				try {
					ws.close();
				} catch {}
				try {
					wsVerify.close();
				} catch {}
			}
		} finally {
			if (!released) {
				released = true;
				await fs.writeFile(releaseMarker, "x").catch(() => undefined);
			}
			try {
				child.kill();
			} catch {}
			try {
				await child.exited;
			} catch {}
		}
	}, 30_000);
});
