/**
 * C60 `btw.ask` follow-up history through both real session hosts.
 *
 * `createAgentSession` builds one `/btw` runner per host: without notifications
 * an interactive top-level session hosts its SDK endpoint through
 * `createSdkSessionRuntimeExtension` and its `askEphemeralQuestion` closure;
 * with notifications the bus extension hosts it and calls the `runBtwTurn`
 * closure. Each case drives its closure end to end over a real SDK connection
 * against a mock Responses upstream, so the caller's earlier side exchanges
 * must reach the provider request in order and stay out of the transcript.
 */
import { afterEach, expect, setDefaultTimeout, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { closeModelCache } from "@gajae-code/ai";
import { ModelRegistry } from "../src/config/model-registry";
import { resetSettingsForTest, Settings } from "../src/config/settings";
import { initializeExtensions } from "../src/modes/runtime-init";
import { createAgentSession } from "../src/sdk";
import { startFixtureBrokerWithLeaseForTest } from "../src/sdk/broker/ensure";
import { SdkClient } from "../src/sdk/client";
import { AuthStorage } from "../src/session/auth-storage";
import { SessionManager } from "../src/session/session-manager";
import {
	cleanupFixtureRoot,
	createFixtureBrokerEnvironment,
	createFixtureRootCleanup,
	type FixtureRootCleanup,
	registerFixtureRuntime,
	withFixtureBrokerEnvironment,
} from "./helpers/fixture-broker-cleanup";

setDefaultTimeout(30_000);

let fixtureCleanup: FixtureRootCleanup | undefined;

afterEach(async () => {
	resetSettingsForTest();
	if (fixtureCleanup) await cleanupFixtureRoot(fixtureCleanup);
	fixtureCleanup = undefined;
});

function mockResponsesUpstream(): { url: string; requests: string[]; stop(): void } {
	const requests: string[] = [];
	const encoder = new TextEncoder();
	const frame = (event: Record<string, unknown>) =>
		encoder.encode(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
	const server = Bun.serve({
		port: 0,
		hostname: "127.0.0.1",
		async fetch(request) {
			if (request.method !== "POST" || !new URL(request.url).pathname.endsWith("/responses"))
				return Response.json({ object: "list", data: [] });
			requests.push(await request.text());
			const text = "side answer";
			const message = { type: "message", id: "m", role: "assistant" };
			const events = [
				{ type: "response.created", response: { id: "r", status: "in_progress", output: [] } },
				{
					type: "response.output_item.added",
					output_index: 0,
					item: { ...message, status: "in_progress", content: [] },
				},
				{
					type: "response.content_part.added",
					item_id: "m",
					output_index: 0,
					content_index: 0,
					part: { type: "output_text", text: "", annotations: [] },
				},
				{ type: "response.output_text.delta", item_id: "m", output_index: 0, content_index: 0, delta: text },
				{ type: "response.output_text.done", item_id: "m", output_index: 0, content_index: 0, text },
				{
					type: "response.output_item.done",
					output_index: 0,
					item: { ...message, status: "completed", content: [{ type: "output_text", text, annotations: [] }] },
				},
				{
					type: "response.completed",
					response: {
						id: "r",
						status: "completed",
						usage: {
							input_tokens: 1,
							output_tokens: 1,
							total_tokens: 2,
							input_tokens_details: { cached_tokens: 0 },
							output_tokens_details: { reasoning_tokens: 0 },
						},
					},
				},
			];
			return new Response(new Blob(events.map(frame)), { headers: { "content-type": "text/event-stream" } });
		},
	});
	return { url: `http://127.0.0.1:${server.port}/v1`, requests, stop: () => server.stop(true) };
}

const NOTIFICATION_ENV_KEYS = ["GJC_NOTIFY", "GJC_NOTIFICATIONS", "GJC_NOTIFICATIONS_TOKEN"] as const;

test.each([
	{ host: "SDK-only", notifications: undefined },
	{ host: "notification bus", notifications: "1" },
])("$host host btw.ask sends caller exchanges to the provider and keeps them out of the transcript", async ({
	notifications,
}) => {
	const upstream = mockResponsesUpstream();
	const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-sdk-btw-ask-e2e-"));
	const agentDir = path.join(tempDir, "agent");
	const savedEnv = NOTIFICATION_ENV_KEYS.map(key => [key, process.env[key]] as const);
	for (const key of NOTIFICATION_ENV_KEYS) delete process.env[key];
	if (notifications) process.env.GJC_NOTIFICATIONS = notifications;
	let client: SdkClient | undefined;
	try {
		const fixtureEnv = createFixtureBrokerEnvironment(tempDir, agentDir);
		const started = await withFixtureBrokerEnvironment(() =>
			startFixtureBrokerWithLeaseForTest({ agentDir, env: fixtureEnv }),
		);
		const cleanup = createFixtureRootCleanup(tempDir, agentDir, started.lease);
		fixtureCleanup = cleanup;
		const authStorage = await AuthStorage.create(path.join(agentDir, "auth.db"));
		registerFixtureRuntime(cleanup, {
			key: "auth-storage",
			requiredOwner: "runtime",
			dispose: async () => authStorage.close(),
		});
		registerFixtureRuntime(cleanup, {
			key: "model-cache",
			requiredOwner: "runtime",
			dispose: async () => void closeModelCache(path.join(agentDir, "models.db")),
		});
		const modelRegistry = new ModelRegistry(authStorage, path.join(agentDir, "models.yml"));
		modelRegistry.registerProvider("mock-responses", {
			baseUrl: upstream.url,
			apiKey: "MOCK_KEY",
			api: "openai-responses",
			models: [
				{
					id: "mock-model",
					name: "Mock",
					reasoning: false,
					input: ["text"],
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
					contextWindow: 128_000,
					maxTokens: 4_096,
				},
			],
		});
		const model = modelRegistry.find("mock-responses", "mock-model");
		if (!model) throw new Error("Expected the mock model fixture");
		const settings = await Settings.init({ cwd: tempDir, agentDir });
		const { session } = await createAgentSession({
			cwd: tempDir,
			agentDir,
			authStorage,
			modelRegistry,
			settings,
			model,
			sessionManager: SessionManager.inMemory(tempDir),
			disableExtensionDiscovery: true,
			skills: [],
			contextFiles: [],
			promptTemplates: [],
			slashCommands: [],
			enableMCP: false,
			enableLsp: false,
		});
		registerFixtureRuntime(cleanup, {
			key: `session:${session.sessionId}`,
			requiredOwner: "runtime-and-broker",
			shutdown: async () => void (await session.extensionRunner?.emit({ type: "session_shutdown" })),
			dispose: () => session.dispose(),
		});
		await initializeExtensions(session, { reportSendError: () => {}, reportRuntimeError: () => {} });

		const endpointFile = path.join(tempDir, ".gjc", "state", "sdk", `${session.sessionId}.json`);
		const deadline = Date.now() + 4_000;
		while (!(await Bun.file(endpointFile).exists())) {
			if (Date.now() > deadline) throw new Error("Timed out starting the SDK session host");
			await Bun.sleep(10);
		}
		const endpoint = (await Bun.file(endpointFile).json()) as { url: string; token: string };
		client = await SdkClient.connect(endpoint.url, endpoint.token, { timeoutMs: 10_000, reconnectAttempts: 0 });

		const before = upstream.requests.length;
		const response = await client.control("btw.ask", {
			question: "and the follow-up?",
			exchanges: [{ question: "EARLIER-SIDE-QUESTION", reply: "EARLIER-SIDE-REPLY" }],
		});
		expect(response).toMatchObject({ ok: true, result: { reply: "side answer" } });
		const sent = upstream.requests.slice(before);
		expect(sent).toHaveLength(1);
		const request = sent[0] ?? "";
		const positions = ["EARLIER-SIDE-QUESTION", "EARLIER-SIDE-REPLY", "and the follow-up?"].map(text =>
			request.indexOf(text),
		);
		expect(positions.every(position => position >= 0)).toBe(true);
		expect([...positions].sort((a, b) => a - b)).toEqual(positions);
		expect(JSON.stringify(session.sessionManager.getEntries())).not.toContain("EARLIER-SIDE");
	} finally {
		await client?.close();
		for (const [key, value] of savedEnv) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
		upstream.stop();
	}
});
