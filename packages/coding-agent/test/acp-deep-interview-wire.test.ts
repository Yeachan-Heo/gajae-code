import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
	type Client,
	ClientSideConnection,
	type CreateElicitationRequest,
	type CreateElicitationResponse,
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

function input(proc: AcpProc): WritableStream<Uint8Array> {
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

function childEnv(root: string): Record<string, string> {
	const agentDir = path.join(root, "agent");
	const env: Record<string, string> = {
		PATH: process.env.PATH ?? "/usr/bin:/bin",
		HOME: root,
		TMPDIR: path.join(root, "tmp"),
		XDG_DATA_HOME: path.join(root, ".local", "share"),
		XDG_CONFIG_HOME: path.join(root, ".config"),
		XDG_STATE_HOME: path.join(root, ".local", "state"),
		XDG_CACHE_HOME: path.join(root, ".cache"),
		XDG_RUNTIME_DIR: path.join(root, ".run"),
		GJC_CODING_AGENT_DIR: agentDir,
		PI_CODING_AGENT_DIR: agentDir,
		GJC_NOTIFICATIONS: "1",
		PI_NO_TITLE: "1",
		NO_COLOR: "1",
	};
	for (const key of ["LANG", "LC_ALL", "TZ"] as const) {
		const value = process.env[key];
		if (value) env[key] = value;
	}
	return env;
}

function chatStream(chunks: Record<string, unknown>[]): Response {
	return new Response(`${chunks.map(chunk => `data: ${JSON.stringify(chunk)}\n\n`).join("")}data: [DONE]\n\n`, {
		headers: { "content-type": "text/event-stream" },
	});
}

function chunk(delta: Record<string, unknown>, finishReason: string | null): Record<string, unknown> {
	return {
		id: "chatcmpl-acp-deep-interview",
		object: "chat.completion.chunk",
		created: 0,
		model: "fixture-model",
		choices: [{ index: 0, delta, finish_reason: finishReason }],
	};
}

async function waitFor(predicate: () => boolean, label: string, timeoutMs = 15_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (predicate()) return;
		await Bun.sleep(10);
	}
	throw new Error(`Timed out waiting for ${label}`);
}

async function bounded<T>(promise: Promise<T>, label: string, timeoutMs = 15_000): Promise<T> {
	return await Promise.race([
		promise,
		Bun.sleep(timeoutMs).then(() => {
			throw new Error(`Timed out waiting for ${label}`);
		}),
	]);
}

class InterviewClient implements Client {
	readonly elicitations: CreateElicitationRequest[] = [];
	readonly updates: SessionNotification[] = [];

	async requestPermission(_params: RequestPermissionRequest): Promise<RequestPermissionResponse> {
		return { outcome: { outcome: "selected", optionId: "allow_once" } };
	}

	async sessionUpdate(params: SessionNotification): Promise<void> {
		this.updates.push(params);
	}

	async unstable_createElicitation(params: CreateElicitationRequest): Promise<CreateElicitationResponse> {
		this.elicitations.push(params);
		return { action: "accept", content: { value: "option:0" } };
	}
}

async function stopProcess(proc: AcpProc): Promise<void> {
	try {
		proc.stdin.end();
	} catch {}
	if (!(await Promise.race([proc.exited.then(() => true), Bun.sleep(2_000).then(() => false)]))) {
		try {
			proc.kill("SIGKILL");
		} catch {}
	}
	if (!(await Promise.race([proc.exited.then(() => true), Bun.sleep(3_000).then(() => false)])))
		throw new Error("ACP subprocess did not exit after SIGKILL");
}

afterEach(async () => {
	for (const server of servers.splice(0)) server.stop(true);
	await cleanupFixtureRoots(cleanupRoots);
});

describe("ACP deep-interview wire path", () => {
	it("routes an advertised skill command to a real form elicitation in a headless lifecycle host", async () => {
		const requests: Array<Record<string, unknown>> = [];
		const modelServer = Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			async fetch(request) {
				const body = (await request.json()) as Record<string, unknown>;
				requests.push(body);
				if (requests.length === 1)
					return chatStream([
						chunk({ role: "assistant", content: "Wire skill completed." }, null),
						chunk({}, "stop"),
					]);
				if (requests.length === 2) {
					const args = JSON.stringify({
						questions: [
							{
								id: "acp-direction",
								question: "Which ACP direction should the interview use?",
								options: [{ label: "Keep protocol choices" }, { label: "Use plain text" }],
								recommended: 0,
							},
						],
					});
					return chatStream([
						chunk(
							{
								role: "assistant",
								tool_calls: [
									{
										index: 0,
										id: "call-acp-ask",
										type: "function",
										function: { name: "ask", arguments: args },
									},
								],
							},
							null,
						),
						chunk({}, "tool_calls"),
					]);
				}
				await Bun.sleep(3_000);
				return chatStream([
					chunk({ role: "assistant", content: "Cancellation fallback should not publish." }, null),
					chunk({}, "stop"),
				]);
			},
		});
		servers.push(modelServer);

		const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "gjc-acp-deep-interview-wire-"));
		const env = childEnv(root);
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
			await fs.promises.mkdir(dir, { recursive: true });
		const workspace = path.join(root, "workspace");
		await fs.promises.mkdir(path.join(workspace, ".gjc", "skills", "wire-skill"), { recursive: true });
		await fs.promises.writeFile(
			path.join(workspace, ".gjc", "skills", "wire-skill", "SKILL.md"),
			"---\nname: wire-skill\ndescription: Complete one deterministic ACP turn.\n---\n\nReturn one short completion message.\n",
		);
		await fs.promises.writeFile(
			path.join(workspace, ".gjc", "settings.json"),
			JSON.stringify({ skills: { enabled: true, enablePiProject: true } }),
		);
		const agentDir = env.GJC_CODING_AGENT_DIR;
		await fs.promises.writeFile(
			path.join(agentDir, "models.yml"),
			`providers:\n  fixture:\n    baseUrl: http://127.0.0.1:${modelServer.port}/v1\n    apiKey: fixture-key\n    api: openai-completions\n    models:\n      - id: fixture-model\n        name: Fixture Model\n        contextWindow: 32768\n        maxTokens: 4096\nprofiles:\n  acp-fixture:\n    display_name: ACP Fixture\n    required_providers: [fixture]\n    model_mapping:\n      default: fixture/fixture-model\n`,
		);

		const started = await withFixtureBrokerEnvironment(() => startFixtureBrokerWithLeaseForTest({ agentDir, env }));
		const cleanup = createFixtureRootCleanup(root, agentDir, started.lease);
		cleanupRoots.push(cleanup);
		const proc = Bun.spawn(["bun", "packages/coding-agent/src/cli.ts", "--mode", "acp", "--mpreset", "acp-fixture"], {
			cwd: repoRoot,
			stdin: "pipe",
			stdout: "pipe",
			stderr: "pipe",
			env,
		});
		let stderr = "";
		const stderrDrain = (async () => {
			const reader = proc.stderr.getReader();
			const decoder = new TextDecoder();
			for (;;) {
				const { value, done } = await reader.read();
				if (done) break;
				if (value) stderr = `${stderr}${decoder.decode(value, { stream: true })}`.slice(-64 * 1024);
			}
		})();
		registerFixtureRuntime(cleanup, {
			key: "acp-deep-interview-subprocess",
			requiredOwner: "runtime-and-broker",
			shutdown: () => stopProcess(proc),
			dispose: () => stderrDrain,
		});

		const client = new InterviewClient();
		const connection = new ClientSideConnection(() => client, ndJsonStream(input(proc), proc.stdout));
		try {
			await connection.initialize({ protocolVersion: 1, clientCapabilities: { elicitation: { form: {} } } });
			const { sessionId } = await connection.newSession({ cwd: workspace, mcpServers: [] });
			const response = await bounded(
				connection.prompt({
					sessionId,
					prompt: [{ type: "text", text: "/skill:wire-skill" }],
				}),
				"completed ACP skill prompt",
			);
			expect(response.stopReason).toBe("end_turn");
			expect(requests).toHaveLength(1);
			expect(stderr).not.toContain("theme.status");
			const cancelSessionId = (await connection.newSession({ cwd: workspace, mcpServers: [] })).sessionId;
			const cancelledPrompt = connection.prompt({
				sessionId: cancelSessionId,
				prompt: [{ type: "text", text: "/skill:deep-interview verify ACP cancellation" }],
			});
			await waitFor(() => client.elicitations.length === 1 && requests.length >= 3, "ACP form before cancellation");
			expect(client.elicitations).toHaveLength(1);
			expect(client.elicitations[0]).toMatchObject({
				sessionId: cancelSessionId,
				mode: "form",
				message: "Which ACP direction should the interview use?",
			});
			const choiceSchema = client.elicitations[0] as CreateElicitationRequest & {
				requestedSchema: { properties: { value: { oneOf: Array<{ const: string }> } } };
			};
			expect(choiceSchema.requestedSchema.properties.value.oneOf.map(choice => choice.const)).toEqual(
				expect.arrayContaining(["option:0", "option:1"]),
			);
			expect(JSON.stringify(requests[1]?.tools)).toContain('"name":"ask"');
			expect(JSON.stringify(requests[2]?.messages)).toContain("Keep protocol choices");
			await connection.cancel({ sessionId: cancelSessionId });
			await expect(bounded(cancelledPrompt, "cancelled ACP skill prompt")).resolves.toEqual({
				stopReason: "cancelled",
			});
		} catch (error) {
			throw new Error(
				`${error instanceof Error ? error.message : String(error)}\nforms=${client.elicitations.length} requests=${requests.length}\n[child stderr]\n${stderr}`,
			);
		}
	}, 60_000);
});
