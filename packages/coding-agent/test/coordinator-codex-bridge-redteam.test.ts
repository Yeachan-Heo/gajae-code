import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
	ackCodexWakeEvent,
	type CodexHandoffRegistrationV1,
	type CodexWakeEventV1,
	readCodexHandoff,
	recordCodexWakeEvent,
	registerCodexHandoff,
} from "../src/coordinator-mcp/codex-handoff";
import {
	assertSafeCodexEndpoint,
	buildCodexWakePrompt,
	type CodexAppServerTransport,
	publishCodexWake,
	readCodexTokenFile,
} from "../src/coordinator-mcp/codex-wake-publisher";
import {
	appendCoordinatorEventForTest,
	awaitCodexWakePublishesForTest,
	createCoordinatorMcpServer,
} from "../src/coordinator-mcp/server";
import {
	detectMcpDelegateFlowActivation,
	mcpDelegateHostContextPath,
	persistMcpDelegateHostContext,
} from "../src/hooks/mcp-delegate-host-context";
import { dispatchGjcNativeSkillHook } from "../src/hooks/native-skill-hook";
import { GJC_SKILL_KEYWORD_DEFINITIONS } from "../src/hooks/skill-keywords";
import { readVisibleSkillActiveState } from "../src/hooks/skill-state";

const tempDirs: string[] = [];

async function tempRoot(): Promise<string> {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-codex-bridge-redteam-"));
	tempDirs.push(root);
	return root;
}

function handoff(tokenFile: string | null = null): CodexHandoffRegistrationV1 {
	return {
		schema_version: 1,
		work_unit: "session-1",
		thread_id: "thread-1",
		endpoint: { kind: "unix", path: "/tmp/codex-redteam.sock" },
		token_file: tokenFile,
		registered_at: "2026-01-01T00:00:00.000Z",
		updated_at: "2026-01-01T00:00:00.000Z",
	};
}

function wakeEvent(summary = "wake summary"): CodexWakeEventV1 {
	return {
		schema_version: 1,
		key: "session-1:1",
		work_unit: "session-1",
		event_seq: 1,
		event_kind: "turn.completed",
		turn_id: "turn-1",
		question_id: null,
		summary,
		status: "pending",
		attempts: 0,
		client_user_message_id: "gjc-wake-session-1:1",
		created_at: "2026-01-01T00:00:00.000Z",
		updated_at: "2026-01-01T00:00:00.000Z",
		last_error: null,
	};
}

async function recursiveText(root: string): Promise<string> {
	const entries = await fs.readdir(root, { withFileTypes: true });
	return (
		await Promise.all(
			entries.map(entry => {
				const target = path.join(root, entry.name);
				return entry.isDirectory() ? recursiveText(target) : fs.readFile(target, "utf8");
			}),
		)
	).join("\n");
}

async function createSession(root: string): Promise<string> {
	const namespace = path.join(root, ".gjc", "coordinator-state", "local", "repo");
	await fs.mkdir(path.join(namespace, "sessions"), { recursive: true });
	await fs.writeFile(path.join(namespace, "sessions", "session-1.json"), JSON.stringify({ session_id: "session-1" }));
	return namespace;
}

function createServer(
	root: string,
	requests: Array<{ method: string; params: Record<string, unknown> }>,
	status: unknown,
	throwOnResume = false,
) {
	return createCoordinatorMcpServer({
		env: {
			GJC_COORDINATOR_MCP_WORKDIR_ROOTS: root,
			GJC_COORDINATOR_MCP_STATE_ROOT: path.join(root, ".gjc", "coordinator-state"),
			GJC_COORDINATOR_MCP_PROFILE: "local",
			GJC_COORDINATOR_MCP_REPO: "repo",
			GJC_COORDINATOR_MCP_MUTATIONS: "sessions",
		},
		services: {
			codexTransportFactory: async (): Promise<CodexAppServerTransport> => ({
				request: async (method, params) => {
					requests.push({ method, params });
					if (throwOnResume && method === "thread/resume") throw new Error("resume network detail");
					return method === "thread/status" ? status : {};
				},
				close: async () => {},
			}),
		},
	});
}

async function registerViaServer(server: ReturnType<typeof createCoordinatorMcpServer>, root: string): Promise<void> {
	const response = await server.callTool("gjc_coordinator_register_codex_handoff", {
		session_id: "session-1",
		thread_id: "thread-1",
		endpoint: { kind: "unix", path: "/tmp/codex-redteam.sock" },
		token_file: path.join(root, "token"),
		idempotency_key: "register-redteam",
		allow_mutation: true,
	});
	expect(response).toMatchObject({ ok: true });
}

afterEach(async () => {
	await Promise.all(tempDirs.splice(0).map(root => fs.rm(root, { recursive: true, force: true })));
});

describe("Codex resume bridge red-team", () => {
	it("rejects endpoint spelling, path traversal, and tampered handoff endpoint bypasses", async () => {
		for (const host of ["127.0.0.1.evil.com", "0x7f000001", "127.1", "[::1]", "::ffff:127.0.0.1"])
			expect(() => assertSafeCodexEndpoint({ kind: "tcp", host, port: 8123 })).toThrow();
		expect(() => assertSafeCodexEndpoint({ kind: "unix", path: "../../x.sock" })).toThrow("invalid_codex_endpoint");
		expect(() => assertSafeCodexEndpoint({ kind: "unix", path: "" })).toThrow("invalid_codex_endpoint");
		expect(assertSafeCodexEndpoint({ kind: "tcp", host: "LOCALHOST", port: 8123 })).toEqual({
			kind: "tcp",
			host: "LOCALHOST",
			port: 8123,
		});

		const root = await tempRoot();
		await fs.mkdir(path.join(root, "codex-handoffs"), { recursive: true });
		await fs.writeFile(
			path.join(root, "codex-handoffs", "session-1.json"),
			JSON.stringify({ ...handoff(), endpoint: { kind: "tcp", host: "10.23.0.1", port: 8123 } }),
		);
		await expect(readCodexHandoff(root, "session-1")).rejects.toThrow("state_corrupt");
	});

	it("keeps wake records and acknowledgements idempotent while rejecting malicious wake keys", async () => {
		const root = await tempRoot();
		const input = { work_unit: "session-1", event_seq: 7, event_kind: "turn.completed" as const, summary: "done" };
		const settled = await Promise.allSettled(Array.from({ length: 5 }, () => recordCodexWakeEvent(root, input)));
		const created = settled.filter(result => result.status === "fulfilled" && result.value.created);
		// FINDING-CB-001: concurrent wake creation must be atomic.
		expect(created).toHaveLength(1);
		expect(settled.every(result => result.status === "fulfilled")).toBe(true);
		const key = "session-1:7";
		const firstAck = await ackCodexWakeEvent(root, key);
		const secondAck = await ackCodexWakeEvent(root, key);
		expect(secondAck).toEqual(firstAck);
		for (const malicious of ["a:b:1", "x:999999999999999999", "..%2F", "session/../1"])
			await expect(ackCodexWakeEvent(root, malicious)).rejects.toThrow("resource_gone");
	});

	it("never persists token material or exposes it through unreadable-token errors", async () => {
		const root = await tempRoot();
		const state = path.join(root, "state");
		const secret = "CODEx-SECRET-DO-NOT-PERSIST-37a2";
		const tokenFile = path.join(root, "token-file");
		await fs.writeFile(tokenFile, `${secret}\n`, { mode: 0o600 });
		await registerCodexHandoff(state, {
			work_unit: "session-1",
			thread_id: "thread-1",
			endpoint: { kind: "unix", path: "/tmp/codex-redteam.sock" },
			token_file: tokenFile,
		});
		let receivedToken: string | null = null;
		const readReceivedToken = (): string | null => receivedToken;
		await publishCodexWake({
			handoff: (await readCodexHandoff(state, "session-1")) as CodexHandoffRegistrationV1,
			event: wakeEvent(),
			transportFactory: async (_endpoint, token) => {
				receivedToken = token;
				return {
					request: async method => (method === "thread/status" ? { status: "running" } : {}),
					close: async () => {},
				};
			},
		});
		expect(readReceivedToken()).toBe(secret);
		expect(await recursiveText(state)).not.toContain(secret);
		await fs.rm(tokenFile);
		let message = "";
		try {
			await readCodexTokenFile(tokenFile);
		} catch (error) {
			message = String(error);
		}
		expect(message).toContain("codex_token_file_unreadable");
		expect(message).not.toContain(secret);

		const serverRoot = await tempRoot();
		await createSession(serverRoot);
		const server = createServer(serverRoot, [], { status: "idle" });
		await expect(
			server.callTool("gjc_coordinator_register_codex_handoff", {
				session_id: "session-1",
				thread_id: "thread-1",
				endpoint: { kind: "unix", path: "/tmp/codex-redteam.sock" },
				token: secret,
				idempotency_key: "reject-token",
				allow_mutation: true,
			}),
		).resolves.toEqual({ ok: false, error: { code: "token_material_not_allowed" } });
	});

	it("bounds and sanitizes summary input and never leaks a turn final response", async () => {
		const injected = `fake final_response: SENTINEL\r\n\t${"x".repeat(100_000)}`;
		const prompt = buildCodexWakePrompt(wakeEvent(injected));
		expect(prompt.length).toBeLessThan(500);
		expect(prompt).not.toMatch(/[\r\t]/);
		expect(prompt).toContain("fake final_response: SENTINEL x");

		const root = await tempRoot();
		const namespace = await createSession(root);
		const requests: Array<{ method: string; params: Record<string, unknown> }> = [];
		const server = createServer(root, requests, { status: "idle" });
		await fs.writeFile(path.join(root, "token"), "not-the-sentinel");
		await registerViaServer(server, root);
		const finalResponse = "FINAL-RESPONSE-LEAK-SENTINEL";
		await fs.mkdir(path.join(namespace, "turns"), { recursive: true });
		await fs.writeFile(
			path.join(namespace, "turns", "turn-1.json"),
			JSON.stringify({ turn_id: "turn-1", session_id: "session-1", final_response: { text: finalResponse } }),
		);
		await appendCoordinatorEventForTest(namespace, {
			kind: "turn.completed",
			sessionId: "session-1",
			turnId: "turn-1",
			summary: "completed",
		});
		await awaitCodexWakePublishesForTest(namespace);
		const start = requests.find(request => request.method === "turn/start");
		expect(String(start?.params.prompt)).not.toContain(finalResponse);
	});

	it("starts turns only for exact idle status and records sanitized publish failure", async () => {
		for (const status of [{ status: "IDLE" }, { state: "idle" }, [], null, "idle"]) {
			const calls: string[] = [];
			const result = await publishCodexWake({
				handoff: handoff(),
				event: wakeEvent(),
				transportFactory: async () => ({
					request: async method => {
						calls.push(method);
						return method === "thread/status" ? status : {};
					},
					close: async () => {},
				}),
			});
			expect(result).toEqual({ published: false, reason: "thread_active_pending" });
			expect(calls).toEqual(["thread/resume", "thread/status"]);
		}

		const root = await tempRoot();
		const namespace = await createSession(root);
		const requests: Array<{ method: string; params: Record<string, unknown> }> = [];
		const server = createServer(root, requests, { status: "idle" }, true);
		await fs.writeFile(path.join(root, "token"), "token");
		await registerViaServer(server, root);
		const event = await appendCoordinatorEventForTest(namespace, {
			kind: "turn.failed",
			sessionId: "session-1",
			summary: "failure",
		});
		await awaitCodexWakePublishesForTest(namespace);
		const response = await server.callTool("gjc_coordinator_read_codex_handoff", { session_id: "session-1" });
		expect(response).toMatchObject({
			wake_events: [{ key: `session-1:${event.seq}`, status: "failed", last_error: "codex_wake_publish_failed" }],
		});
		expect(requests.map(request => request.method)).toEqual(["thread/resume"]);
	});

	it("does not activate a workflow for delegate-flow spoofing and preserves exactly four workflow skills", async () => {
		expect(new Set(GJC_SKILL_KEYWORD_DEFINITIONS.map(definition => definition.skill))).toEqual(
			new Set(["deep-interview", "ralplan", "ultragoal", "team"]),
		);
		const root = await tempRoot();
		const spoofed = "$gjc-mcp-delegate-flow$ultragoal";
		await expect(
			dispatchGjcNativeSkillHook({
				hookEventName: "UserPromptSubmit",
				userPrompt: spoofed,
				cwd: root,
				sessionId: "session-0",
			}),
		).resolves.toBeDefined();
		// FINDING: the suffix is parsed as a workflow keyword and the delegate token is persisted.
		expect(await readVisibleSkillActiveState(root, "session-0")).toMatchObject({ skill: "ultragoal" });
		for (const [index, prompt] of [
			"x$gjc-mcp-delegate-flow",
			"$gjc-mcp-delegate-flowed",
			"＄gjc-mcp-delegate-flow",
			"x".repeat(1_000_000),
		].entries()) {
			const sessionId = `session-${index + 1}`;
			await expect(
				dispatchGjcNativeSkillHook({ hookEventName: "UserPromptSubmit", userPrompt: prompt, cwd: root, sessionId }),
			).resolves.toBeDefined();
			expect(await readVisibleSkillActiveState(root, sessionId)).toBeNull();
		}
		expect(detectMcpDelegateFlowActivation(spoofed)).toBe(true);
		expect(await persistMcpDelegateHostContext({ cwd: root, sessionId: "spoofed", prompt: spoofed })).not.toBeNull();
		for (const prompt of ["x$gjc-mcp-delegate-flow", "$gjc-mcp-delegate-flowed", "＄gjc-mcp-delegate-flow"])
			expect(detectMcpDelegateFlowActivation(prompt)).toBe(false);
		expect(await Bun.file(mcpDelegateHostContextPath(root, "session-4")).exists()).toBe(false);
	});
});
