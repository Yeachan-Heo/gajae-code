/**
 * Compatibility tests for the three legacy Hindsight helper factories.
 *
 * These helpers are no longer registered as public coding-harness tools. They are
 * retained only for direct legacy backend/tool-call compatibility, and these tests
 * spy on `HindsightApi.prototype.{retain, recall, reflect}` while stubbing
 * Hindsight state on the fake ToolSession. We deliberately do not boot a real
 * session — these helpers only need a populated state accessor and Settings.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import { resetSettingsForTest, Settings } from "@gajae-code/coding-agent/config/settings";
import { HindsightApi } from "@gajae-code/coding-agent/hindsight/client";
import type { HindsightConfig } from "@gajae-code/coding-agent/hindsight/config";
import { HindsightSessionState } from "@gajae-code/coding-agent/hindsight/state";
import { HindsightRecallTool } from "@gajae-code/coding-agent/tools/hindsight-recall";
import { HindsightReflectTool } from "@gajae-code/coding-agent/tools/hindsight-reflect";
import { HindsightRetainTool } from "@gajae-code/coding-agent/tools/hindsight-retain";
import type { ToolSession } from "@gajae-code/coding-agent/tools/index";

const TEST_SESSION_ID = "test-session-id";
let registeredState: HindsightSessionState | undefined;

function makeConfig(overrides: Partial<HindsightConfig> = {}): HindsightConfig {
	return {
		hindsightApiUrl: "http://localhost:8888",
		hindsightApiToken: null,
		bankId: null,
		bankIdPrefix: "",
		scoping: "global",
		bankMission: "",
		retainMission: null,
		autoRecall: true,
		autoRetain: true,
		retainMode: "full-session",
		retainEveryNTurns: 3,
		retainOverlapTurns: 2,
		retainContext: "gjc",
		recallBudget: "mid",
		recallMaxTokens: 1024,
		recallTypes: ["world", "experience"],
		recallContextTurns: 1,
		recallMaxQueryChars: 800,
		recallPromptPreamble: "preamble",
		debug: false,
		mentalModelsEnabled: false,
		mentalModelAutoSeed: false,
		mentalModelRefreshIntervalMs: 5 * 60 * 1000,
		mentalModelMaxRenderChars: 16_000,
		...overrides,
	};
}

function makeSession(settings: Settings, sessionId: string | null = TEST_SESSION_ID): ToolSession {
	return {
		cwd: "/tmp",
		hasUI: false,
		settings,
		getSessionFile: () => null,
		getSessionId: () => sessionId,
		getSessionSpawns: () => null,
		getHindsightSessionState: () => (sessionId === TEST_SESSION_ID ? registeredState : undefined),
	} as unknown as ToolSession;
}

interface RegisterStateOptions {
	retainTags?: string[];
	recallTags?: string[];
	recallTagsMatch?: "any" | "all" | "any_strict" | "all_strict";
	sessionOverrides?: Record<string, unknown>;
}

function registerState(client: HindsightApi, settings?: Settings, opts: RegisterStateOptions = {}) {
	registeredState = new HindsightSessionState({
		sessionId: TEST_SESSION_ID,
		client,
		bankId: "test-bank",
		retainTags: opts.retainTags,
		recallTags: opts.recallTags,
		recallTagsMatch: opts.recallTagsMatch,
		config: makeConfig(),
		session: {
			sessionId: TEST_SESSION_ID,
			sessionManager: { getEntries: () => [] } as never,
			emitNotice: () => {},
			getHindsightSessionState: () => registeredState,
			...opts.sessionOverrides,
		} as never,
		missionsSet: new Set(),
		lastRetainedTurn: 0,
		hasRecalledForFirstTurn: false,
	});
	void settings;
}

describe("Hindsight tool factories", () => {
	beforeEach(() => {
		resetSettingsForTest();
		registeredState = undefined;
	});

	afterEach(() => {
		vi.restoreAllMocks();
		registeredState = undefined;
	});

	it("retain/recall/reflect factories return null when memory.backend !== hindsight", () => {
		const settings = Settings.isolated({ "memory.backend": "local", "memories.enabled": false });
		const session = makeSession(settings);
		expect(HindsightRetainTool.createIf(session)).toBeNull();
		expect(HindsightRecallTool.createIf(session)).toBeNull();
		expect(HindsightReflectTool.createIf(session)).toBeNull();
	});

	it("retain/recall/reflect factories return tool instances when memory.backend === hindsight", () => {
		const settings = Settings.isolated({ "memory.backend": "hindsight" });
		const session = makeSession(settings);
		expect(HindsightRetainTool.createIf(session)).toBeInstanceOf(HindsightRetainTool);
		expect(HindsightRecallTool.createIf(session)).toBeInstanceOf(HindsightRecallTool);
		expect(HindsightReflectTool.createIf(session)).toBeInstanceOf(HindsightReflectTool);
	});
});

describe("Hindsight recall injection", () => {
	beforeEach(() => {
		resetSettingsForTest();
		registeredState = undefined;
	});

	afterEach(() => {
		vi.restoreAllMocks();
		registeredState = undefined;
	});

	it("keeps recall eligible until the provider injection is accepted", () => {
		const client = new HindsightApi({ baseUrl: "http://localhost:8888" });
		registerState(client);
		registeredState!.lastRecallSnippet = "<memories>fact</memories>";
		expect(registeredState!.getRecallSnippetForInjection()).toBe("<memories>fact</memories>");
		// A cancelled preflight only reads the snippet; a retry must still receive it.
		expect(registeredState!.getRecallSnippetForInjection()).toBe("<memories>fact</memories>");
		expect(registeredState!.markRecallSnippetInjected("<memories>fact</memories>")).toBe(true);
		expect(registeredState!.getRecallSnippetForInjection()).toBeUndefined();
		registeredState!.lastRecallSnippet = "<memories>updated fact</memories>";
		expect(registeredState!.getRecallSnippetForInjection()).toBe("<memories>updated fact</memories>");
	});
});

describe("retain.execute", () => {
	beforeEach(() => {
		resetSettingsForTest();
		registeredState = undefined;
	});

	afterEach(() => {
		vi.restoreAllMocks();
		registeredState = undefined;
	});

	it("queues the memory and reports success without calling the API", async () => {
		const settings = Settings.isolated({ "memory.backend": "hindsight" });
		const client = new HindsightApi({ baseUrl: "http://localhost:8888" });
		const retainBatchSpy = vi.spyOn(HindsightApi.prototype, "retainBatch").mockResolvedValue({} as never);
		const retainSpy = vi.spyOn(HindsightApi.prototype, "retain").mockResolvedValue({} as never);
		registerState(client, settings);

		const tool = HindsightRetainTool.createIf(makeSession(settings))!;
		const result = await tool.execute("call-1", { items: [{ content: "user prefers tabs" }] });

		expect(result.content[0]).toEqual({ type: "text", text: "1 memory queued." });
		// Tool returns before any HTTP work happens.
		expect(retainBatchSpy).not.toHaveBeenCalled();
		expect(retainSpy).not.toHaveBeenCalled();
		expect(registeredState?.retainQueue.depth).toBe(1);
	});

	it("flushes a multi-item tool call as a single retainBatch call with per-item context", async () => {
		const settings = Settings.isolated({ "memory.backend": "hindsight" });
		const client = new HindsightApi({ baseUrl: "http://localhost:8888" });
		const retainBatchSpy = vi.spyOn(HindsightApi.prototype, "retainBatch").mockResolvedValue({} as never);
		registerState(client, settings, { retainTags: ["project:pi"] });

		const tool = HindsightRetainTool.createIf(makeSession(settings))!;
		const result = await tool.execute("call-batch", {
			items: [{ content: "fact one" }, { content: "fact two", context: "user override" }],
		});
		expect(result.content[0]).toEqual({ type: "text", text: "2 memories queued." });

		await registeredState?.flushRetainQueue();

		expect(retainBatchSpy).toHaveBeenCalledTimes(1);
		const [bankId, items, options] = retainBatchSpy.mock.calls[0];
		expect(bankId).toBe("test-bank");
		expect(options).toEqual(expect.objectContaining({ async: true }));
		expect(items).toEqual([
			expect.objectContaining({
				content: "fact one",
				metadata: { session_id: TEST_SESSION_ID },
				tags: ["project:pi"],
			}),
			expect.objectContaining({
				content: "fact two",
				context: "user override",
				metadata: { session_id: TEST_SESSION_ID },
				tags: ["project:pi"],
			}),
		]);
		expect(registeredState?.retainQueue.depth).toBe(0);
	});

	it("emits a UI-only warning notice when the batch flush fails", async () => {
		const settings = Settings.isolated({ "memory.backend": "hindsight" });
		const client = new HindsightApi({ baseUrl: "http://localhost:8888" });
		vi.spyOn(HindsightApi.prototype, "retainBatch").mockRejectedValue(new Error("HTTP 503"));
		const noticeSpy = vi.fn();
		registerState(client, settings, { sessionOverrides: { emitNotice: noticeSpy } });

		const tool = HindsightRetainTool.createIf(makeSession(settings))!;
		await tool.execute("call-x", { items: [{ content: "doomed fact" }] });
		await registeredState?.flushRetainQueue();

		expect(noticeSpy).toHaveBeenCalledTimes(1);
		const [level, message, source] = noticeSpy.mock.calls[0];
		expect(level).toBe("warning");
		expect(source).toBe("Hindsight");
		expect(message).toContain("HTTP 503");
		expect(message).toContain("1 memory");
	});

	it("drains a retain queued during an in-flight flush before it resolves", async () => {
		const settings = Settings.isolated({ "memory.backend": "hindsight" });
		const client = new HindsightApi({ baseUrl: "http://localhost:8888" });
		const { promise, resolve } = Promise.withResolvers<Awaited<ReturnType<HindsightApi["retainBatch"]>>>();
		const retainBatchSpy = vi
			.spyOn(HindsightApi.prototype, "retainBatch")
			.mockImplementationOnce(async () => await promise)
			.mockResolvedValue({} as never);
		registerState(client, settings);

		registeredState!.enqueueRetain("first");
		const flush = registeredState!.flushRetainQueue();
		while (retainBatchSpy.mock.calls.length === 0) await Promise.resolve();
		registeredState!.enqueueRetain("trailing");
		resolve({} as never);
		await flush;

		expect(retainBatchSpy).toHaveBeenCalledTimes(2);
		expect(retainBatchSpy.mock.calls.map(([, items]) => items.map(item => item.content))).toEqual([
			["first"],
			["trailing"],
		]);
	});

	it("flushes pending retains during disposal and rejects later enqueues", async () => {
		const settings = Settings.isolated({ "memory.backend": "hindsight" });
		const client = new HindsightApi({ baseUrl: "http://localhost:8888" });
		const retainBatchSpy = vi.spyOn(HindsightApi.prototype, "retainBatch").mockResolvedValue({} as never);
		registerState(client, settings);

		registeredState!.enqueueRetain("retain before disposal");
		await registeredState!.dispose();

		expect(retainBatchSpy).toHaveBeenCalledTimes(1);
		expect(() => registeredState!.enqueueRetain("after disposal")).toThrow(/closed/i);
	});

	it("throws when no per-session state is registered", async () => {
		const settings = Settings.isolated({ "memory.backend": "hindsight" });
		const tool = HindsightRetainTool.createIf(makeSession(settings))!;
		await expect(tool.execute("call-2", { items: [{ content: "x" }] })).rejects.toThrow(/not initialised/i);
	});
});

describe("recall.execute", () => {
	beforeEach(() => {
		resetSettingsForTest();
		registeredState = undefined;
	});

	afterEach(() => {
		vi.restoreAllMocks();
		registeredState = undefined;
	});

	it("returns the no-results sentinel when recall yields empty", async () => {
		const settings = Settings.isolated({ "memory.backend": "hindsight" });
		const client = new HindsightApi({ baseUrl: "http://localhost:8888" });
		vi.spyOn(HindsightApi.prototype, "recall").mockResolvedValue({ results: [] } as never);
		registerState(client, settings);

		const tool = HindsightRecallTool.createIf(makeSession(settings))!;
		const result = await tool.execute("call-3", { query: "anything" });
		expect(result.content[0]).toEqual({ type: "text", text: "No relevant memories found." });
	});

	it("formats non-empty results with count + UTC timestamp header", async () => {
		const settings = Settings.isolated({ "memory.backend": "hindsight" });
		const client = new HindsightApi({ baseUrl: "http://localhost:8888" });
		vi.spyOn(HindsightApi.prototype, "recall").mockResolvedValue({
			results: [
				{ text: "fact one", type: "world", id: "1" },
				{ text: "fact two", id: "2" },
			],
		} as never);
		registerState(client, settings);

		const tool = HindsightRecallTool.createIf(makeSession(settings))!;
		const result = await tool.execute("call-4", { query: "anything" });
		const block = (result.content[0] as { text: string }).text;
		expect(block).toMatch(/^Found 2 relevant memories \(as of \d{4}-\d{2}-\d{2} \d{2}:\d{2} UTC\)/);
		expect(block).toContain("- fact one [world]");
		expect(block).toContain("- fact two");
	});

	it("forwards recall tags + tagsMatch from session state when present", async () => {
		const settings = Settings.isolated({ "memory.backend": "hindsight" });
		const client = new HindsightApi({ baseUrl: "http://localhost:8888" });
		const recallSpy = vi.spyOn(HindsightApi.prototype, "recall").mockResolvedValue({ results: [] } as never);
		registerState(client, settings, { recallTags: ["project:pi"], recallTagsMatch: "any" });

		const tool = HindsightRecallTool.createIf(makeSession(settings))!;
		await tool.execute("call-tags", { query: "anything" });

		expect(recallSpy).toHaveBeenCalledWith(
			"test-bank",
			"anything",
			expect.objectContaining({ tags: ["project:pi"], tagsMatch: "any" }),
		);
	});

	it("rethrows underlying client errors", async () => {
		const settings = Settings.isolated({ "memory.backend": "hindsight" });
		const client = new HindsightApi({ baseUrl: "http://localhost:8888" });
		vi.spyOn(HindsightApi.prototype, "recall").mockRejectedValue(new Error("HTTP 503"));
		registerState(client, settings);

		const tool = HindsightRecallTool.createIf(makeSession(settings))!;
		await expect(tool.execute("call-5", { query: "anything" })).rejects.toThrow(/HTTP 503/);
	});
});

describe("reflect.execute", () => {
	beforeEach(() => {
		resetSettingsForTest();
		registeredState = undefined;
	});

	afterEach(() => {
		vi.restoreAllMocks();
		registeredState = undefined;
	});

	it("returns the reflect text and forwards context", async () => {
		const settings = Settings.isolated({ "memory.backend": "hindsight" });
		const client = new HindsightApi({ baseUrl: "http://localhost:8888" });
		const reflectSpy = vi
			.spyOn(HindsightApi.prototype, "reflect")
			.mockResolvedValue({ text: "Synthesised answer" } as never);
		registerState(client, settings);

		const tool = HindsightReflectTool.createIf(makeSession(settings))!;
		const result = await tool.execute("call-6", { query: "what does the user prefer?", context: "background" });
		expect(reflectSpy).toHaveBeenCalledWith(
			"test-bank",
			"what does the user prefer?",
			expect.objectContaining({ context: "background", budget: "mid" }),
		);
		expect((result.content[0] as { text: string }).text).toBe("Synthesised answer");
	});

	it("falls back to a sentinel when reflect returns blank text", async () => {
		const settings = Settings.isolated({ "memory.backend": "hindsight" });
		const client = new HindsightApi({ baseUrl: "http://localhost:8888" });
		vi.spyOn(HindsightApi.prototype, "reflect").mockResolvedValue({ text: "  " } as never);
		registerState(client, settings);

		const tool = HindsightReflectTool.createIf(makeSession(settings))!;
		const result = await tool.execute("call-7", { query: "anything" });
		expect((result.content[0] as { text: string }).text).toBe("No relevant information found to reflect on.");
	});
});
