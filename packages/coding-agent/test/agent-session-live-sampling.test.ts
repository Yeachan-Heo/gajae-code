import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as path from "node:path";
import { Agent } from "@gajae-code/agent-core";
import { getBundledModel } from "@gajae-code/ai";
import { streamOpenAICompletions } from "@gajae-code/ai/providers/openai-completions";
import { TempDir } from "@gajae-code/utils";
import { ModelRegistry } from "../src/config/model-registry";
import { Settings } from "../src/config/settings";
import { AgentSession } from "../src/session/agent-session";
import { AuthStorage } from "../src/session/auth-storage";
import { SessionManager } from "../src/session/session-manager";

const sampling = {
	temperature: 0.35,
	topP: 0.8,
	topK: 24,
	minP: 0.1,
	presencePenalty: 0.4,
	repetitionPenalty: 1.2,
} as const;

const wireSampling = {
	temperature: 0.35,
	top_p: 0.8,
	top_k: 24,
	min_p: 0.1,
	presence_penalty: 0.4,
	repetition_penalty: 1.2,
};

/** Capture the real provider serializer/HTTP boundary, not Agent property readback. */
function captureRequests(requests: Record<string, unknown>[]): typeof fetch {
	async function capture(input: string | URL | Request, init?: RequestInit): Promise<Response> {
		const request = input instanceof Request ? new Request(input, init) : new Request(String(input), init);
		requests.push((await request.json()) as Record<string, unknown>);
		return new Response(
			`data: ${JSON.stringify({
				id: "sampling-fixture",
				object: "chat.completion.chunk",
				created: 0,
				model: "gpt-4o-mini",
				choices: [{ index: 0, delta: { content: "done" }, finish_reason: "stop" }],
			})}\n\ndata: [DONE]\n\n`,
			{ headers: { "content-type": "text/event-stream" } },
		);
	}
	return Object.assign(capture, { preconnect: fetch.preconnect });
}

describe("AgentSession live sampling settings", () => {
	let tempDir: TempDir;
	let auth: AuthStorage;
	let session: AgentSession | undefined;
	let settings: Settings;
	let requests: Record<string, unknown>[];

	beforeEach(async () => {
		tempDir = TempDir.createSync("gjc-live-sampling-");
		auth = await AuthStorage.create(path.join(tempDir.path(), "auth.db"));
		auth.setRuntimeApiKey("openai", "fixture-key");
		session = undefined;
		requests = [];
	});

	afterEach(async () => {
		await session?.dispose();
		await settings?.close();
		auth.close();
		tempDir.removeSync();
	});

	function buildSession(): AgentSession {
		const model = getBundledModel<"openai-completions">("openai", "gpt-4o-mini");
		const agent = new Agent({
			getApiKey: () => "fixture-key",
			initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] },
			streamFn: (_model, context, options) =>
				streamOpenAICompletions(model, context, { ...options, fetch: captureRequests(requests) }),
		});
		return new AgentSession({
			agent,
			settings,
			sessionManager: SessionManager.inMemory(tempDir.path()),
			modelRegistry: new ModelRegistry(auth),
		});
	}

	async function request(): Promise<Record<string, unknown>> {
		await session!.prompt("Report the sampling fixture.");
		await session!.waitForIdle();
		return requests.at(-1)!;
	}

	it("applies ordinary setting changes to the next provider payload and clears sentinels", async () => {
		settings = Settings.isolated({ "compaction.enabled": false });
		session = buildSession();
		for (const [key, value] of Object.entries(sampling)) settings.set(key as keyof typeof sampling, value);
		expect(await request()).toMatchObject(wireSampling);

		for (const key of Object.keys(sampling) as Array<keyof typeof sampling>) settings.set(key, -1);
		const cleared = await request();
		for (const key of Object.keys(wireSampling)) expect(cleared).not.toHaveProperty(key);
		expect(requests).toHaveLength(2);
	});

	it("applies unset fallback and detaches observation on dispose", async () => {
		settings = Settings.isolated({ "compaction.enabled": false });
		session = buildSession();
		settings.set("temperature", 0);
		expect(await request()).toHaveProperty("temperature", 0);
		settings.unset("temperature");
		expect(await request()).not.toHaveProperty("temperature");
		await session.dispose();
		settings.set("temperature", 0.9);
		expect(session.agent.temperature).toBeUndefined();
	});

	for (const durable of [false, true]) {
		it(`applies an atomic batch and CAS restore to provider payloads (${durable ? "disk" : "memory"})`, async () => {
			const scope = { cwd: tempDir.path(), agentDir: path.join(tempDir.path(), "agent") };
			settings = durable ? await Settings.loadForScope(scope) : Settings.isolated({ "compaction.enabled": false });
			settings.set("compaction.enabled", false);
			session = buildSession();
			const receipt = await settings.commitAtomicBatch(
				(Object.keys(sampling) as Array<keyof typeof sampling>).map(key => ({
					path: key,
					op: "set" as const,
					value: sampling[key],
				})),
			);
			expect(await request()).toMatchObject(wireSampling);
			if (durable) {
				const readback = await Settings.loadReadonly(scope);
				for (const key of Object.keys(sampling) as Array<keyof typeof sampling>) {
					expect(readback.get(key)).toBe(sampling[key]);
				}
			}
			expect((await receipt.restore()).status).toBe("restored");
			const restored = await request();
			for (const key of Object.keys(wireSampling)) expect(restored).not.toHaveProperty(key);
			expect(requests).toHaveLength(2);
		});

		it(`keeps atomic receipts and live application when an observer throws (${durable ? "disk" : "memory"})`, async () => {
			settings = durable
				? await Settings.loadForScope({ cwd: tempDir.path(), agentDir: path.join(tempDir.path(), "agent") })
				: Settings.isolated({ "compaction.enabled": false });
			settings.set("compaction.enabled", false);
			const unsubscribe = settings.onChanged(() => {
				throw new Error("observer fixture failure");
			});
			try {
				session = buildSession();
				const receipt = await settings.commitAtomicBatch([{ path: "temperature", op: "set", value: 0.25 }]);
				expect(await request()).toHaveProperty("temperature", 0.25);
				expect((await receipt.restore()).status).toBe("restored");
				expect(await request()).not.toHaveProperty("temperature");
			} finally {
				unsubscribe();
			}
		});

		it(`preserves a newer sampling write when CAS restore conflicts (${durable ? "disk" : "memory"})`, async () => {
			settings = durable
				? await Settings.loadForScope({ cwd: tempDir.path(), agentDir: path.join(tempDir.path(), "agent") })
				: Settings.isolated({ "compaction.enabled": false });
			settings.set("compaction.enabled", false);
			session = buildSession();
			const receipt = await settings.commitAtomicBatch([{ path: "temperature", op: "set", value: 0.25 }]);
			settings.set("temperature", 0.75);
			await settings.flushOrThrow();
			expect((await receipt.restore()).status).toBe("conflict");
			expect(await request()).toHaveProperty("temperature", 0.75);
		});
	}
});
