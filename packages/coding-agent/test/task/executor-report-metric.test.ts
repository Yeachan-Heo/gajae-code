import { afterEach, beforeEach, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentEvent } from "@gajae-code/agent-core";
import type { AssistantMessage } from "@gajae-code/ai";
import { AsyncJobManager } from "../../src/async/job-manager";
import { kNoAuth } from "../../src/config/model-registry";
import { Settings } from "../../src/config/settings";
import type { LoadExtensionsResult } from "../../src/extensibility/extensions/types";
import type { CreateAgentSessionResult } from "../../src/sdk";
import * as sdkModule from "../../src/sdk";
import type { AgentSession, AgentSessionEvent } from "../../src/session/agent-session";
import { runSubprocess } from "../../src/task/executor";
import type { AgentDefinition } from "../../src/task/types";
import { EventBus } from "../../src/utils/event-bus";

// #7440: a subagent's report_metric calls reach its progress (and so the live
// task card) as the latest chart per title, bounded, with invalid calls dropped.

const roots: string[] = [];

const agent: AgentDefinition = {
	name: "explore",
	description: "test explorer",
	systemPrompt: "test",
	source: "bundled",
};

const modelRegistry = {
	refresh: async () => {},
	getAvailable: () => [],
	getApiKey: async () => kNoAuth,
} as unknown as import("../../src/config/model-registry").ModelRegistry;

const message: AssistantMessage = {
	role: "assistant",
	content: [{ type: "text", text: "measured" }],
	api: "openai-responses",
	provider: "openai",
	model: "mock",
	usage: {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	},
	stopReason: "stop",
	timestamp: Date.now(),
};

function metricEvent(index: number, details: unknown, isError = false): AgentEvent {
	return {
		type: "tool_execution_end",
		toolCallId: `metric-${index}`,
		toolName: "report_metric",
		result: { content: [{ type: "text", text: "Metric shown" }], details },
		isError,
	};
}

function createSession(events: AgentEvent[]): AgentSession {
	const listeners: Array<(event: AgentSessionEvent) => void> = [];
	const emit = (event: AgentEvent) => {
		for (const listener of listeners) listener(event);
	};
	let prompted = false;
	return {
		state: { messages: [] },
		agent: { state: { systemPrompt: ["test"] } },
		model: undefined,
		extensionRunner: undefined,
		sessionManager: { appendSessionInit: () => {} },
		getActiveToolNames: () => ["report_metric", "yield"],
		setActiveToolsByName: async () => {},
		setConfiguredModelChain: () => {},
		getConfiguredModelChain: () => undefined,
		seedDefaultFallbackResolution: () => {},
		subscribe: (listener: (event: AgentSessionEvent) => void) => {
			listeners.push(listener);
			return () => {
				const index = listeners.indexOf(listener);
				if (index >= 0) listeners.splice(index, 1);
			};
		},
		prompt: async () => {
			if (prompted) return;
			prompted = true;
			emit({ type: "message_end", message });
			for (const event of events) emit(event);
			emit({
				type: "tool_execution_end",
				toolCallId: "yield-call",
				toolName: "yield",
				result: {
					content: [{ type: "text", text: "Result submitted" }],
					details: { status: "success", data: { ok: true } },
				},
				isError: false,
			});
			emit({ type: "agent_end", messages: [message], stopReason: "completed" });
		},
		waitForIdle: async () => {},
		getLastAssistantMessage: () => message,
		abort: async () => {},
		dispose: async () => {},
	} as unknown as AgentSession;
}

beforeEach(() => {
	AsyncJobManager.setInstance(new AsyncJobManager({ onJobComplete: async () => {} }));
});

afterEach(async () => {
	vi.restoreAllMocks();
	const manager = AsyncJobManager.instance();
	if (manager) await manager.dispose({ timeoutMs: 100 });
	AsyncJobManager.setInstance(undefined);
	await Promise.all(roots.splice(0).map(root => fs.rm(root, { recursive: true, force: true })));
});

it("keeps the latest chart per title, the newest four titles, and drops invalid calls", async () => {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-report-metric-"));
	roots.push(root);
	const chart = (title: string, value: number) => ({ title, rows: [{ label: "png", value }] });
	const events = [
		metricEvent(0, chart("pixels", 1)),
		metricEvent(1, chart("bytes", 2)),
		metricEvent(2, chart("pixels", 3)),
		metricEvent(3, chart("ms", 4)),
		metricEvent(4, chart("frames", 5)),
		metricEvent(5, chart("colors", 6)),
		metricEvent(6, { title: "negative", rows: [{ label: "x", value: -1 }] }),
		metricEvent(7, chart("errored", 7), true),
	];
	vi.spyOn(sdkModule, "createAgentSession").mockResolvedValue({
		session: createSession(events),
		extensionsResult: {} as LoadExtensionsResult,
		setToolUIContext: () => {},
		eventBus: new EventBus(),
	} as CreateAgentSessionResult);

	const result = await runSubprocess({
		cwd: root,
		agent,
		task: "measure",
		index: 0,
		id: "0-Metric",
		subagentId: "0-Metric",
		artifactsDir: path.join(root, "artifacts"),
		settings: Settings.isolated(),
		modelRegistry,
		enableLsp: false,
	});

	expect(result.exitCode).toBe(0);
	// Re-reporting "pixels" replaced its chart and moved it behind "bytes", so
	// "bytes" is the oldest title when the fifth one evicts it.
	expect(result.extractedToolData?.report_metric).toEqual([
		chart("pixels", 3),
		chart("ms", 4),
		chart("frames", 5),
		chart("colors", 6),
	]);
});
