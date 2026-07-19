import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { listCodexWakeEvents, recordCodexWakeEvent, registerCodexHandoff } from "../src/coordinator-mcp/codex-handoff";
import {
	appendCoordinatorEventForTest,
	awaitCodexWakePublishesForTest,
	createCoordinatorMcpServer,
} from "../src/coordinator-mcp/server";

const tempDirs: string[] = [];

async function tempRoot(): Promise<string> {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-coordinator-codex-bridge-"));
	tempDirs.push(root);
	return root;
}

afterEach(async () => {
	await Promise.all(tempDirs.splice(0).map(root => fs.rm(root, { recursive: true, force: true })));
});

function namespaceDir(root: string): string {
	return path.join(root, ".gjc", "coordinator-state", "local", "repo");
}

type CodexTransportControl = {
	status: "idle" | "running";
	throwOnFactory?: boolean;
	factoryError?: string;
};

function createServer(
	root: string,
	status: "idle" | "running" | CodexTransportControl,
	requests: Array<{ method: string; params: Record<string, unknown> }>,
) {
	const control = typeof status === "string" ? { status } : status;
	return createCoordinatorMcpServer({
		env: {
			GJC_COORDINATOR_MCP_WORKDIR_ROOTS: root,
			GJC_COORDINATOR_MCP_STATE_ROOT: path.join(root, ".gjc", "coordinator-state"),
			GJC_COORDINATOR_MCP_PROFILE: "local",
			GJC_COORDINATOR_MCP_REPO: "repo",
			GJC_COORDINATOR_MCP_MUTATIONS: "sessions",
		},
		services: {
			codexTransportFactory: async () => {
				if (control.throwOnFactory) throw new Error(control.factoryError ?? "codex_transport_unavailable");
				return {
					request: async (method, params) => {
						requests.push({ method, params });
						return method === "thread/status" ? { status: control.status } : {};
					},
					close: async () => {},
				};
			},
		},
	});
}

async function createSession(root: string): Promise<void> {
	await fs.mkdir(path.join(namespaceDir(root), "sessions"), { recursive: true });
	await Bun.write(
		path.join(namespaceDir(root), "sessions", "session-1.json"),
		JSON.stringify({ session_id: "session-1" }),
	);
}

async function registerHandoff(server: ReturnType<typeof createCoordinatorMcpServer>, root: string) {
	const tokenFile = path.join(root, "codex-token");
	await Bun.write(tokenFile, "test-token");
	return server.callTool("gjc_coordinator_register_codex_handoff", {
		session_id: "session-1",
		thread_id: "thread-1",
		endpoint: { kind: "unix", path: "/tmp/codex-app-server.sock" },
		token_file: tokenFile,
		idempotency_key: "register-codex-handoff",
		allow_mutation: true,
	});
}

describe("Coordinator Codex resume bridge", () => {
	it("registers and reads handoffs without accepting raw token material or non-loopback endpoints", async () => {
		const root = await tempRoot();
		const requests: Array<{ method: string; params: Record<string, unknown> }> = [];
		const server = createServer(root, "idle", requests);
		await createSession(root);

		await expect(registerHandoff(server, root)).resolves.toMatchObject({
			ok: true,
			handoff: {
				work_unit: "session-1",
				endpoint: { kind: "unix", path: "/tmp/codex-app-server.sock" },
				token_file: path.join(root, "codex-token"),
			},
		});
		await expect(
			server.callTool("gjc_coordinator_read_codex_handoff", { session_id: "session-1" }),
		).resolves.toMatchObject({
			ok: true,
			handoff: { thread_id: "thread-1", token_file: path.join(root, "codex-token") },
			wake_events: [],
			pending_wake_events: [],
		});
		await expect(
			server.callTool("gjc_coordinator_register_codex_handoff", {
				session_id: "session-1",
				thread_id: "thread-1",
				endpoint: { kind: "tcp", host: "10.0.0.1", port: 8123 },
				idempotency_key: "reject-non-loopback",
				allow_mutation: true,
			}),
		).resolves.toEqual({ ok: false, error: { code: "codex_endpoint_not_loopback" } });
		await expect(
			server.callTool("gjc_coordinator_register_codex_handoff", {
				session_id: "session-1",
				thread_id: "thread-1",
				endpoint: { kind: "unix", path: "/tmp/codex-app-server.sock" },
				token: "raw-secret",
				idempotency_key: "reject-raw-token",
				allow_mutation: true,
			}),
		).resolves.toEqual({ ok: false, error: { code: "token_material_not_allowed" } });
	});
	it("bounds Codex handoff idempotency responses to the allowlisted registration shape", async () => {
		const root = await tempRoot();
		const requests: Array<{ method: string; params: Record<string, unknown> }> = [];
		const server = createServer(root, "idle", requests);
		await createSession(root);
		await expect(
			server.callTool("gjc_coordinator_register_codex_handoff", {
				session_id: "session-1",
				thread_id: "thread-1",
				endpoint: { kind: "unix", path: "/tmp/codex-app-server.sock" },
				token_file: path.join(root, `token-${"x".repeat(5000)}`),
				idempotency_key: "reject-oversized-token-file",
				allow_mutation: true,
			}),
		).resolves.toEqual({ ok: false, error: { code: "token_material_not_allowed" } });

		const tokenFile = path.join(root, "codex-token");
		const response = await server.callTool("gjc_coordinator_register_codex_handoff", {
			session_id: "session-1",
			thread_id: "thread-1",
			endpoint: { kind: "unix", path: "/tmp/codex-app-server.sock", ignored: "ignored" },
			token_file: tokenFile,
			idempotency_key: "bounded-codex-handoff",
			allow_mutation: true,
		});

		expect(response).toMatchObject({ ok: true, handoff: { token_file: tokenFile } });
		expect(Object.keys((response as { handoff: Record<string, unknown> }).handoff).sort()).toEqual([
			"endpoint",
			"registered_at",
			"schema_version",
			"thread_id",
			"token_file",
			"updated_at",
			"work_unit",
		]);
		expect(Object.keys((response as { handoff: { endpoint: Record<string, unknown> } }).handoff.endpoint)).toEqual([
			"kind",
			"path",
		]);

		const idempotencyFiles = await fs.readdir(path.join(namespaceDir(root), "idempotency"));
		const persistedFiles = await Promise.all(
			idempotencyFiles.map(async file =>
				JSON.parse(await fs.readFile(path.join(namespaceDir(root), "idempotency", file), "utf8")),
			),
		);
		const persisted = persistedFiles.find(record => record.response?.ok === true) as {
			response: { handoff: { token_file: string; endpoint: Record<string, unknown> } };
		};
		expect(persisted.response.handoff.token_file).toBe(tokenFile);
		expect(persisted.response.handoff.endpoint).not.toHaveProperty("ignored");
	});

	it("records and publishes terminal wakes without including final responses, preserving registrations across restart", async () => {
		const root = await tempRoot();
		const requests: Array<{ method: string; params: Record<string, unknown> }> = [];
		const server = createServer(root, "idle", requests);
		await createSession(root);
		await registerHandoff(server, root);

		const finalResponseSentinel = "FINAL-RESPONSE-SENTINEL-9c41 full GJC answer body";
		await fs.mkdir(path.join(namespaceDir(root), "turns"), { recursive: true });
		await Bun.write(
			path.join(namespaceDir(root), "turns", "turn-11111111-2222-4333-8444-555555555555.json"),
			JSON.stringify({
				schema_version: 1,
				turn_id: "turn-11111111-2222-4333-8444-555555555555",
				session_id: "session-1",
				status: "completed",
				final_response: { text: finalResponseSentinel },
			}),
		);
		const event = await appendCoordinatorEventForTest(namespaceDir(root), {
			kind: "turn.completed",
			sessionId: "session-1",
			turnId: "turn-11111111-2222-4333-8444-555555555555",
			summary: "Terminal coordinator event",
		});
		await awaitCodexWakePublishesForTest(namespaceDir(root));
		const read = await server.callTool("gjc_coordinator_read_codex_handoff", { session_id: "session-1" });
		expect(read).toMatchObject({
			wake_events: [
				{
					key: `session-1:${event.seq}`,
					status: "published",
					client_user_message_id: `gjc-wake-session-1:${event.seq}`,
				},
			],
		});
		expect(requests.map(request => request.method)).toEqual(["thread/resume", "thread/status", "turn/start"]);
		const start = requests.find(request => request.method === "turn/start");
		expect(start?.params).toMatchObject({ clientUserMessageId: `gjc-wake-session-1:${event.seq}` });
		expect(String(start?.params.prompt)).not.toContain(finalResponseSentinel);
		expect(String(start?.params.prompt)).not.toContain("FINAL-RESPONSE-SENTINEL-9c41");

		const restarted = createServer(root, "idle", requests);
		const duplicate = await recordCodexWakeEvent(namespaceDir(root), {
			work_unit: "session-1",
			event_seq: event.seq,
			event_kind: "turn.completed",
			turn_id: "turn-1",
			summary: "Terminal coordinator event",
		});
		expect(duplicate.created).toBe(false);
		await expect(
			restarted.callTool("gjc_coordinator_read_codex_handoff", { session_id: "session-1" }),
		).resolves.toMatchObject({
			handoff: { thread_id: "thread-1" },
			wake_events: [{ key: `session-1:${event.seq}` }],
		});
		expect(requests.filter(request => request.method === "turn/start")).toHaveLength(1);
	});

	it("leaves active Codex threads pending and acknowledges the durable wake", async () => {
		const root = await tempRoot();
		const requests: Array<{ method: string; params: Record<string, unknown> }> = [];
		const server = createServer(root, "running", requests);
		await createSession(root);
		await registerHandoff(server, root);

		const event = await appendCoordinatorEventForTest(namespaceDir(root), {
			kind: "question.opened",
			sessionId: "session-1",
			questionId: "question-1",
			summary: "Question requires an answer",
		});
		await awaitCodexWakePublishesForTest(namespaceDir(root));
		await expect(
			server.callTool("gjc_coordinator_read_codex_handoff", { session_id: "session-1" }),
		).resolves.toMatchObject({
			pending_wake_events: [{ key: `session-1:${event.seq}`, status: "pending", attempts: 1 }],
		});
		expect(requests.map(request => request.method)).toEqual(["thread/resume", "thread/status"]);
		await expect(
			server.callTool("gjc_coordinator_ack_codex_wake", {
				session_id: "session-1",
				wake_key: `session-1:${event.seq}`,
				idempotency_key: "ack-codex-wake",
				allow_mutation: true,
			}),
		).resolves.toMatchObject({ ok: true, wake_event: { status: "acked" } });
		await expect(
			server.callTool("gjc_coordinator_read_codex_handoff", { session_id: "session-1" }),
		).resolves.toMatchObject({
			pending_wake_events: [],
		});
	});
	it("records failed transport wakes without preventing coordinator event append", async () => {
		const root = await tempRoot();
		const requests: Array<{ method: string; params: Record<string, unknown> }> = [];
		const control: CodexTransportControl = {
			status: "idle",
			throwOnFactory: true,
			factoryError: "a".repeat(500),
		};
		const server = createServer(root, control, requests);
		await createSession(root);
		await registerHandoff(server, root);

		const event = await appendCoordinatorEventForTest(namespaceDir(root), {
			kind: "turn.failed",
			sessionId: "session-1",
			summary: "Terminal coordinator event",
		});
		await awaitCodexWakePublishesForTest(namespaceDir(root));

		await expect(
			server.callTool("gjc_coordinator_read_codex_handoff", { session_id: "session-1" }),
		).resolves.toMatchObject({
			wake_events: [
				{
					key: `session-1:${event.seq}`,
					status: "failed",
					attempts: 1,
					last_error: "a".repeat(240),
				},
			],
		});
		expect(await fs.readFile(path.join(namespaceDir(root), "events", "event-journal.jsonl"), "utf8")).toContain(
			event.id,
		);
	});

	it("logs corrupt handoff state while preserving terminal coordinator events", async () => {
		const root = await tempRoot();
		const requests: Array<{ method: string; params: Record<string, unknown> }> = [];
		createServer(root, "idle", requests);
		await createSession(root);
		await fs.mkdir(path.join(namespaceDir(root), "codex-handoffs"), { recursive: true });
		await fs.writeFile(path.join(namespaceDir(root), "codex-handoffs", "session-1.json"), "{invalid json");

		const event = await appendCoordinatorEventForTest(namespaceDir(root), {
			kind: "turn.completed",
			sessionId: "session-1",
			summary: "Terminal coordinator event",
		});

		expect(await fs.readFile(path.join(namespaceDir(root), "events", "event-journal.jsonl"), "utf8")).toContain(
			event.id,
		);
		expect(await fs.readFile(path.join(namespaceDir(root), "codex-wake-errors.log"), "utf8")).toContain(
			"state_corrupt",
		);
	});

	it("retries pending wakes when a later Codex wake finds the thread idle", async () => {
		const root = await tempRoot();
		const requests: Array<{ method: string; params: Record<string, unknown> }> = [];
		const control: CodexTransportControl = { status: "running" };
		const server = createServer(root, control, requests);
		await createSession(root);
		await registerHandoff(server, root);

		const pending = await appendCoordinatorEventForTest(namespaceDir(root), {
			kind: "question.opened",
			sessionId: "session-1",
			questionId: "question-1",
			summary: "Question requires an answer",
		});
		await awaitCodexWakePublishesForTest(namespaceDir(root));
		control.status = "idle";
		await appendCoordinatorEventForTest(namespaceDir(root), {
			kind: "turn.completed",
			sessionId: "session-1",
			summary: "Terminal coordinator event",
		});
		await awaitCodexWakePublishesForTest(namespaceDir(root));

		const read = (await server.callTool("gjc_coordinator_read_codex_handoff", {
			session_id: "session-1",
		})) as { wake_events: Array<{ key: string; status: string; attempts: number }> };
		expect(read.wake_events.find(event => event.key === `session-1:${pending.seq}`)).toMatchObject({
			status: "published",
			attempts: 2,
		});
		expect(requests.filter(request => request.method === "turn/start")).toHaveLength(2);
	});

	it("retries failed wakes and never resends published or acknowledged wakes", async () => {
		const root = await tempRoot();
		const requests: Array<{ method: string; params: Record<string, unknown> }> = [];
		const control: CodexTransportControl = { status: "idle", throwOnFactory: true };
		const server = createServer(root, control, requests);
		await createSession(root);
		await registerHandoff(server, root);

		const failed = await appendCoordinatorEventForTest(namespaceDir(root), {
			kind: "turn.failed",
			sessionId: "session-1",
			summary: "Terminal coordinator event",
		});
		await awaitCodexWakePublishesForTest(namespaceDir(root));
		control.throwOnFactory = false;
		const published = await appendCoordinatorEventForTest(namespaceDir(root), {
			kind: "turn.completed",
			sessionId: "session-1",
			summary: "Terminal coordinator event",
		});
		await awaitCodexWakePublishesForTest(namespaceDir(root));
		expect(requests.filter(request => request.method === "turn/start")).toHaveLength(2);
		const read = (await server.callTool("gjc_coordinator_read_codex_handoff", {
			session_id: "session-1",
		})) as { wake_events: Array<{ key: string; status: string; attempts: number }> };
		expect(read.wake_events.find(event => event.key === `session-1:${failed.seq}`)).toMatchObject({
			status: "published",
			attempts: 2,
		});

		await server.callTool("gjc_coordinator_ack_codex_wake", {
			session_id: "session-1",
			wake_key: `session-1:${published.seq}`,
			idempotency_key: "ack-published-wake",
			allow_mutation: true,
		});
		await appendCoordinatorEventForTest(namespaceDir(root), {
			kind: "turn.cancelled",
			sessionId: "session-1",
			summary: "Terminal coordinator event",
		});
		await awaitCodexWakePublishesForTest(namespaceDir(root));
		expect(requests.filter(request => request.method === "turn/start")).toHaveLength(3);
	});
	it("publishes different Codex threads independently", async () => {
		const root = await tempRoot();
		const namespace = namespaceDir(root);
		const firstEntered = Promise.withResolvers<void>();
		const releaseFirst = Promise.withResolvers<void>();
		const secondStarted = Promise.withResolvers<void>();
		createCoordinatorMcpServer({
			env: {
				GJC_COORDINATOR_MCP_WORKDIR_ROOTS: root,
				GJC_COORDINATOR_MCP_STATE_ROOT: path.join(root, ".gjc", "coordinator-state"),
				GJC_COORDINATOR_MCP_PROFILE: "local",
				GJC_COORDINATOR_MCP_REPO: "repo",
			},
			services: {
				codexTransportFactory: async endpoint => ({
					request: async method => {
						if (endpoint.kind === "unix" && endpoint.path.endsWith("one.sock") && method === "thread/resume") {
							firstEntered.resolve();
							await releaseFirst.promise;
						}
						if (endpoint.kind === "unix" && endpoint.path.endsWith("two.sock") && method === "turn/start")
							secondStarted.resolve();
						return method === "thread/status" ? { status: "idle" } : {};
					},
					close: async () => {},
				}),
			},
		});
		await registerCodexHandoff(namespace, {
			work_unit: "session-1",
			thread_id: "thread-1",
			endpoint: { kind: "unix", path: "/tmp/one.sock" },
		});
		await registerCodexHandoff(namespace, {
			work_unit: "session-2",
			thread_id: "thread-2",
			endpoint: { kind: "unix", path: "/tmp/two.sock" },
		});
		await appendCoordinatorEventForTest(namespace, {
			kind: "turn.completed",
			sessionId: "session-1",
			summary: "one",
		});
		await firstEntered.promise;
		await appendCoordinatorEventForTest(namespace, {
			kind: "turn.completed",
			sessionId: "session-2",
			summary: "two",
		});
		await Promise.race([
			secondStarted.promise,
			Bun.sleep(100).then(() => {
				throw new Error("different_thread_wake_serialized");
			}),
		]);
		releaseFirst.resolve();
		await awaitCodexWakePublishesForTest(namespace);
	});

	it("drains persisted failed wakes at server startup", async () => {
		const root = await tempRoot();
		const namespace = namespaceDir(root);
		await registerCodexHandoff(namespace, {
			work_unit: "session-1",
			thread_id: "thread-1",
			endpoint: { kind: "unix", path: "/tmp/restart.sock" },
		});
		const wake = await recordCodexWakeEvent(namespace, {
			work_unit: "session-1",
			event_seq: 1,
			event_kind: "turn.failed",
			summary: "retry",
		});
		createServer(root, "idle", []);
		await Bun.sleep(20);
		await awaitCodexWakePublishesForTest(namespace);
		expect(
			(await listCodexWakeEvents(namespace, "session-1")).find(event => event.key === wake.event.key),
		).toMatchObject({
			status: "published",
		});
	});
	it("serializes two delegates sharing a Codex thread and drains the pending wake", async () => {
		const root = await tempRoot();
		const namespace = namespaceDir(root);
		const requests: Array<{ method: string; params: Record<string, unknown> }> = [];
		const statusResponses = new Map<number, "idle" | "running">();
		let threadBusy = false;
		let startCount = 0;
		createCoordinatorMcpServer({
			env: {
				GJC_COORDINATOR_MCP_WORKDIR_ROOTS: root,
				GJC_COORDINATOR_MCP_STATE_ROOT: path.join(root, ".gjc", "coordinator-state"),
				GJC_COORDINATOR_MCP_PROFILE: "local",
				GJC_COORDINATOR_MCP_REPO: "repo",
			},
			services: {
				codexTransportFactory: async () => ({
					request: async (method, params) => {
						requests.push({ method, params });
						if (method === "thread/status") {
							const status = threadBusy ? "running" : "idle";
							statusResponses.set(requests.length - 1, status);
							return { status };
						}
						if (method === "turn/start" && ++startCount === 1) threadBusy = true;
						return {};
					},
					close: async () => {},
				}),
			},
		});
		await registerCodexHandoff(namespace, {
			work_unit: "session-1",
			thread_id: "thread-shared",
			endpoint: { kind: "unix", path: "/tmp/shared.sock" },
		});
		await registerCodexHandoff(namespace, {
			work_unit: "session-2",
			thread_id: "thread-shared",
			endpoint: { kind: "unix", path: "/tmp/shared.sock" },
		});

		const [first, second] = await Promise.all([
			appendCoordinatorEventForTest(namespace, { kind: "turn.completed", sessionId: "session-1", summary: "one" }),
			appendCoordinatorEventForTest(namespace, { kind: "turn.completed", sessionId: "session-2", summary: "two" }),
		]);
		await awaitCodexWakePublishesForTest(namespace);
		const pending = (await listCodexWakeEvents(namespace)).find(event => event.status === "pending");
		expect(pending?.key).toBe(`session-2:${second.seq}`);

		threadBusy = false;
		const later = await appendCoordinatorEventForTest(namespace, {
			kind: "turn.completed",
			sessionId: "session-2",
			summary: "drain",
		});
		await awaitCodexWakePublishesForTest(namespace);

		for (let index = 0; index < requests.length; index++)
			if (requests[index]?.method === "turn/start") {
				expect(requests[index - 1]?.method).toBe("thread/status");
				expect(statusResponses.get(index - 1)).toBe("idle");
			}
		const startsByWake = new Map<string, number>();
		for (const request of requests.filter(request => request.method === "turn/start")) {
			const id = String(request.params.clientUserMessageId);
			startsByWake.set(id, (startsByWake.get(id) ?? 0) + 1);
		}
		expect(startsByWake.get(`gjc-wake-session-1:${first.seq}`)).toBe(1);
		expect(startsByWake.get(`gjc-wake-session-2:${second.seq}`)).toBe(1);
		expect(startsByWake.get(`gjc-wake-session-2:${later.seq}`)).toBe(1);
		expect([...startsByWake.values()].every(count => count === 1)).toBe(true);
		expect(
			[...startsByWake.keys()].filter(id =>
				[`gjc-wake-session-1:${first.seq}`, `gjc-wake-session-2:${second.seq}`].includes(id),
			),
		).toEqual([`gjc-wake-session-1:${first.seq}`, `gjc-wake-session-2:${second.seq}`]);
		expect((await listCodexWakeEvents(namespace)).find(event => event.key === pending?.key)).toMatchObject({
			status: "published",
		});
	});

	it("drains a pending wake for one work unit when a later event for a sibling work unit shares the thread", async () => {
		const root = await tempRoot();
		const namespace = namespaceDir(root);
		const requests: Array<{ method: string; params: Record<string, unknown> }> = [];
		let threadBusy = true;
		createCoordinatorMcpServer({
			env: {
				GJC_COORDINATOR_MCP_WORKDIR_ROOTS: root,
				GJC_COORDINATOR_MCP_STATE_ROOT: path.join(root, ".gjc", "coordinator-state"),
				GJC_COORDINATOR_MCP_PROFILE: "local",
				GJC_COORDINATOR_MCP_REPO: "repo",
			},
			services: {
				codexTransportFactory: async () => ({
					request: async (method, params) => {
						requests.push({ method, params });
						if (method === "thread/status") return { status: threadBusy ? "running" : "idle" };
						return {};
					},
					close: async () => {},
				}),
			},
		});
		await registerCodexHandoff(namespace, {
			work_unit: "session-1",
			thread_id: "thread-shared",
			endpoint: { kind: "unix", path: "/tmp/shared.sock" },
		});
		await registerCodexHandoff(namespace, {
			work_unit: "session-2",
			thread_id: "thread-shared",
			endpoint: { kind: "unix", path: "/tmp/shared.sock" },
		});
		const blocked = await appendCoordinatorEventForTest(namespace, {
			kind: "turn.completed",
			sessionId: "session-2",
			summary: "blocked while busy",
		});
		await awaitCodexWakePublishesForTest(namespace);
		expect((await listCodexWakeEvents(namespace, "session-2"))[0]?.status).toBe("pending");

		threadBusy = false;
		const sibling = await appendCoordinatorEventForTest(namespace, {
			kind: "turn.completed",
			sessionId: "session-1",
			summary: "sibling drains the thread",
		});
		await awaitCodexWakePublishesForTest(namespace);
		const starts = requests
			.filter(request => request.method === "turn/start")
			.map(request => String(request.params.clientUserMessageId));
		expect(starts).toEqual([`gjc-wake-session-2:${blocked.seq}`, `gjc-wake-session-1:${sibling.seq}`]);
		expect((await listCodexWakeEvents(namespace, "session-2"))[0]?.status).toBe("published");
	});
});
