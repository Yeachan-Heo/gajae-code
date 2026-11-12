/**
 * ACP `turn.abort_and_prompt` replacement wire oracle — a real `gjc --mode acp` child over stdio.
 *
 * An ACP client that replaces its own running `session/prompt` through the generic
 * `_gjc/sdk/control` passthrough (`turn.abort_and_prompt`, disposition `generic_safe`) owns the
 * replacement turn on the SDK side, so the bus delivers that turn's frames to the ACP connection
 * correlated to the replacement command/turn. The ACP client must receive the replacement turn's
 * assistant output, not just its phase changes (issue #7560).
 *
 * The child environment never spreads `process.env`; every HOME/XDG/agent dir is rooted under an
 * owned temp root, and the model is a local fixture server.
 */
import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
	type Client,
	ClientSideConnection,
	ndJsonStream,
	type RequestPermissionRequest,
	type RequestPermissionResponse,
	type SessionNotification,
} from "@agentclientprotocol/sdk";
import { startFixtureBrokerWithLeaseForTest } from "../src/sdk/broker/ensure";
import {
	cleanupFixtureRoots,
	createFixtureRootCleanup,
	type FixtureRootCleanup,
	registerFixtureRuntime,
	withFixtureBrokerEnvironment,
} from "./helpers/fixture-broker-cleanup";

type AcpProc = Bun.Subprocess<"pipe", "pipe", "pipe">;

const repoRoot = path.resolve(import.meta.dir, "..", "..", "..");
const cleanupRoots: FixtureRootCleanup[] = [];
const servers: Array<{ stop(closeActiveConnections?: boolean): void }> = [];
const STDERR_CAP = 64 * 1024;

class RecordingClient implements Client {
	readonly updates: SessionNotification[] = [];
	async requestPermission(_params: RequestPermissionRequest): Promise<RequestPermissionResponse> {
		return { outcome: { outcome: "selected", optionId: "allow_once" } };
	}
	async sessionUpdate(params: SessionNotification): Promise<void> {
		this.updates.push(params);
	}
	assistantText(): string {
		let text = "";
		for (const { update } of this.updates)
			if (update.sessionUpdate === "agent_message_chunk" && update.content.type === "text")
				text += update.content.text;
		return text;
	}
}

afterEach(async () => {
	for (const server of servers.splice(0)) server.stop(true);
	await cleanupFixtureRoots(cleanupRoots);
});

const encoder = new TextEncoder();

function chatChunk(delta: Record<string, unknown>, finishReason: string | null): string {
	return `data: ${JSON.stringify({
		id: "chatcmpl-acp-abort-and-prompt",
		object: "chat.completion.chunk",
		created: 0,
		model: "fixture-model",
		choices: [{ index: 0, delta, finish_reason: finishReason }],
	})}\n\n`;
}

function completedChat(text: string): Response {
	return new Response(
		`${chatChunk({ role: "assistant", content: text }, null)}${chatChunk({}, "stop")}data: [DONE]\n\n`,
		{ headers: { "content-type": "text/event-stream" } },
	);
}

/** Streams one partial chunk, then holds the response open until the client aborts the request. */
function heldChat(text: string, signal: AbortSignal, onAbort: () => void): Response {
	const stream = new ReadableStream<Uint8Array>({
		start(controller) {
			controller.enqueue(encoder.encode(chatChunk({ role: "assistant", content: text }, null)));
			signal.addEventListener(
				"abort",
				() => {
					onAbort();
					try {
						controller.close();
					} catch {
						// already closed
					}
				},
				{ once: true },
			);
		},
	});
	return new Response(stream, { headers: { "content-type": "text/event-stream" } });
}

function subprocessInput(proc: AcpProc): WritableStream<Uint8Array> {
	return new WritableStream({
		write(chunk) {
			proc.stdin.write(chunk);
			proc.stdin.flush();
		},
		close() {
			proc.stdin.end();
		},
		abort() {
			proc.stdin.end();
		},
	});
}

function buildChildEnv(root: string): Record<string, string> {
	const env: Record<string, string> = {
		PATH: process.env.PATH ?? "/usr/bin:/bin",
		HOME: root,
		TMPDIR: path.join(root, "tmp"),
		XDG_DATA_HOME: path.join(root, ".local", "share"),
		XDG_CONFIG_HOME: path.join(root, ".config"),
		XDG_STATE_HOME: path.join(root, ".local", "state"),
		XDG_CACHE_HOME: path.join(root, ".cache"),
		XDG_RUNTIME_DIR: path.join(root, ".run"),
		GJC_CODING_AGENT_DIR: path.join(root, "agent"),
		PI_CODING_AGENT_DIR: path.join(root, "agent"),
		PI_NO_TITLE: "1",
		NO_COLOR: "1",
	};
	for (const key of ["LANG", "LC_ALL", "TZ"] as const) {
		const value = process.env[key];
		if (value !== undefined && value !== "") env[key] = value;
	}
	return env;
}

async function waitFor(predicate: () => boolean, label: string, timeoutMs = 30_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (predicate()) return;
		await Bun.sleep(20);
	}
	throw new Error(`Timed out waiting for ${label}`);
}

describe("ACP turn.abort_and_prompt replacement wire oracle (real subprocess stdio)", () => {
	it("streams the replacement turn's assistant output to the ACP client that replaced its own prompt", async () => {
		let providerRequests = 0;
		let firstRequestAborted = false;
		const modelServer = Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			idleTimeout: 0,
			async fetch(request) {
				const url = new URL(request.url);
				if (request.method === "GET" && url.pathname === "/v1/models")
					return Response.json({ data: [{ id: "fixture-model" }] });
				if (request.method !== "POST" || url.pathname !== "/v1/chat/completions")
					return new Response("Not found", { status: 404 });
				await request.json();
				providerRequests++;
				if (providerRequests === 1)
					return heldChat("FIRST-PARTIAL ", request.signal, () => {
						firstRequestAborted = true;
					});
				if (providerRequests === 2) return completedChat("REPLACED-OK");
				return completedChat("FOLLOWUP-OK");
			},
		});
		servers.push(modelServer);

		const root = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-acp-abort-and-prompt-"));
		const env = buildChildEnv(root);
		for (const dir of [
			env.HOME,
			env.TMPDIR,
			env.XDG_DATA_HOME,
			env.XDG_CONFIG_HOME,
			env.XDG_STATE_HOME,
			env.XDG_CACHE_HOME,
			env.XDG_RUNTIME_DIR,
			env.GJC_CODING_AGENT_DIR,
		])
			await fs.mkdir(dir!, { recursive: true });
		const workspace = path.join(root, "workspace");
		await fs.mkdir(workspace, { recursive: true });
		const agentDir = path.join(root, "agent");
		await Bun.write(
			path.join(agentDir, "models.yml"),
			`providers:\n  fixture:\n    baseUrl: http://127.0.0.1:${modelServer.port}/v1\n    apiKey: fixture-key\n    api: openai-completions\n    models:\n      - id: fixture-model\n        name: Fixture Model\n        input: [text]\n        contextWindow: 32768\n        maxTokens: 4096\nprofiles:\n  acp-fixture:\n    display_name: ACP Fixture\n    required_providers: [fixture]\n    model_mapping:\n      default: fixture/fixture-model\n`,
		);

		const started = await withFixtureBrokerEnvironment(() => startFixtureBrokerWithLeaseForTest({ agentDir, env }));
		const cleanup = createFixtureRootCleanup(root, agentDir, started.lease);
		cleanupRoots.push(cleanup);

		const proc = Bun.spawn(
			["bun", "packages/coding-agent/src/cli.ts", "--mode", "acp", "--no-extensions", "--mpreset", "acp-fixture"],
			{ cwd: repoRoot, stdin: "pipe", stdout: "pipe", stderr: "pipe", env },
		);
		let stderr = "";
		const stderrDrain = (async () => {
			const reader = proc.stderr.getReader();
			const decoder = new TextDecoder();
			for (;;) {
				const { value, done } = await reader.read();
				if (done) break;
				if (value) stderr = `${stderr}${decoder.decode(value, { stream: true })}`.slice(-STDERR_CAP);
			}
		})();
		const sessionIds: string[] = [];
		let connection: ClientSideConnection | undefined;
		registerFixtureRuntime(cleanup, {
			key: "acp-abort-and-prompt-subprocess",
			requiredOwner: "runtime-and-broker",
			shutdown: async () => {
				for (const sessionId of sessionIds.splice(0)) await connection?.closeSession({ sessionId });
				try {
					proc.stdin.end();
				} catch {
					// already closed
				}
				const graceful = await Promise.race([proc.exited.then(() => true), Bun.sleep(2_000).then(() => false)]);
				if (!graceful) proc.kill("SIGKILL");
				const exited = await Promise.race([proc.exited.then(() => true), Bun.sleep(3_000).then(() => false)]);
				if (!exited) throw new Error(`ACP subprocess did not exit after SIGKILL.\n[child stderr]\n${stderr}`);
			},
			dispose: () => stderrDrain,
		});

		const client = new RecordingClient();
		const acp = new ClientSideConnection(() => client, ndJsonStream(subprocessInput(proc), proc.stdout));
		connection = acp;

		try {
			await acp.initialize({ protocolVersion: 1, clientCapabilities: {} });
			const { sessionId } = await acp.newSession({ cwd: workspace, mcpServers: [] });
			sessionIds.push(sessionId);

			const firstPrompt = acp.prompt({ sessionId, prompt: [{ type: "text", text: "first turn" }] }).then(
				response => ({ ok: true as const, response }),
				(error: unknown) => ({ ok: false as const, error }),
			);
			await waitFor(() => client.assistantText().includes("FIRST-PARTIAL"), "the first turn's partial chunk");

			const replacement = await acp.extMethod("_gjc/sdk/control", {
				sessionId,
				operation: "turn.abort_and_prompt",
				input: { text: "replacement turn", idempotencyKey: "acp-replacement-7560" },
			});
			expect(replacement).toMatchObject({ accepted: true });
			await firstPrompt;
			expect(firstRequestAborted).toBe(true);

			// The replacement turn is this connection's own turn: its assistant output reaches the client.
			await waitFor(() => client.assistantText().includes("REPLACED-OK"), "the replacement turn's assistant chunk");
			expect(providerRequests).toBe(2);
			// It is published once, not duplicated by an uncorrelated observer copy.
			expect(client.assistantText().split("REPLACED-OK")).toHaveLength(2);

			// The session is not left busy: an ordinary follow-up prompt still owns its own turn.
			const followUp = await acp.prompt({ sessionId, prompt: [{ type: "text", text: "follow up" }] });
			expect(followUp.stopReason).toBe("end_turn");
			expect(client.assistantText()).toContain("FOLLOWUP-OK");
			expect(client.assistantText().split("REPLACED-OK")).toHaveLength(2);
		} catch (error) {
			throw new Error(`${error instanceof Error ? error.message : String(error)}\n[child stderr]\n${stderr}`);
		}
	}, 120_000);
});
