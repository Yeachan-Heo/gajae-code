import { afterEach, describe, expect, test, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { type AssistantMessage, Effort } from "@gajae-code/ai";
import { kNoAuth, type ModelRegistry } from "../src/config/model-registry";
import { Settings } from "../src/config/settings";
import type { CreateAgentSessionResult } from "../src/sdk";
import * as sdkModule from "../src/sdk";
import type { AgentSession, AgentSessionEvent } from "../src/session/agent-session";
import type {
	TaskDecisionBeginInput,
	TaskDecisionModelInput,
	TaskDecisionOutcomeInput,
	TaskDecisionRecorder,
} from "../src/task/decision-collection";
import * as collection from "../src/task/decision-collection";
import { buildTaskDecisionContext } from "../src/task/decision-routing";
import { type ExecutorOptions, runSubprocess } from "../src/task/executor";
import { EventBus } from "../src/utils/event-bus";

const agent = {
	name: "executor",
	description: "collection test agent",
	systemPrompt: "test",
	source: "bundled" as const,
};
const roots: string[] = [];
afterEach(async () => {
	vi.restoreAllMocks();
	for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
});

function observations(): {
	recorder: TaskDecisionRecorder;
	models: TaskDecisionModelInput[];
	outcomes: TaskDecisionOutcomeInput[];
} {
	const models: TaskDecisionModelInput[] = [];
	const outcomes: TaskDecisionOutcomeInput[] = [];
	return {
		models,
		outcomes,
		recorder: {
			recordModel: async input => {
				models.push(input);
			},
			recordDecision: async () => {},
			finish: async input => {
				outcomes.push(input);
			},
		},
	};
}
function options(): ExecutorOptions {
	return {
		cwd: process.cwd(),
		agent,
		task: "do work",
		index: 0,
		id: "collection-test",
		settings: Settings.isolated(),
		enableLsp: false,
	};
}

function decisionContext(mode: "shadow" | "routing") {
	return buildTaskDecisionContext({
		role: "executor",
		assignment: "do work",
		provider: {
			provider: { decide: async () => ({ result: { choice: "fast", probabilities: { fast: 1 }, confidence: 1 } }) },
			providerName: "kev",
			mode,
			decisionModel: "kev-latest",
			timeoutMs: 5000,
		},
	});
}

/** Run one preflight-exhausted child with the store pinned to `root`, returning the resolved mode. */
async function collectAt(root: string, settings: ReturnType<typeof Settings.isolated>, mode: "shadow" | "routing") {
	const real = collection.beginTaskDecision;
	const resolved: Array<collection.TaskCollectionMode | "off" | undefined> = [];
	const spy = vi.spyOn(collection, "beginTaskDecision").mockImplementation(async (input, storeOptions) => {
		resolved.push(storeOptions?.mode);
		return real(input, { ...storeOptions, rootDir: root });
	});
	try {
		const result = await runSubprocess({
			...options(),
			settings,
			decisionContext: decisionContext(mode),
			autoroutingPreflight: true,
			autoroutingCandidates: [],
		});
		expect(result.exitCode).toBe(1);
		return resolved;
	} finally {
		spy.mockRestore();
	}
}

describe("decision collection consent", () => {
	test("enabling decisions in either mode creates no store and records nothing", async () => {
		for (const mode of ["shadow", "routing"] as const) {
			const base = await fs.mkdtemp(path.join(os.tmpdir(), "task-collection-consent-"));
			roots.push(base);
			const root = path.join(base, "task-decisions");
			const settings = Settings.isolated({ "task.decision.enabled": true, "task.decision.mode": mode });
			// Decisions are on and `task.decision.collection` is unset: no implicit metadata.
			expect(await collectAt(root, settings, mode)).toEqual([undefined]);
			await expect(fs.lstat(root)).rejects.toMatchObject({ code: "ENOENT" });
			expect(await collection.exportTaskDecisionEvents({ rootDir: root, includeContent: true })).toEqual([]);
		}
	});

	test("explicit metadata consent creates the store and records the execution without content", async () => {
		const base = await fs.mkdtemp(path.join(os.tmpdir(), "task-collection-consent-"));
		roots.push(base);
		const root = path.join(base, "task-decisions");
		const settings = Settings.isolated({
			"task.decision.enabled": true,
			"task.decision.mode": "routing",
			"task.decision.collection": "metadata",
		});
		expect(await collectAt(root, settings, "routing")).toEqual(["metadata"]);
		expect((await fs.stat(path.join(root, "task-decisions.db"))).isFile()).toBe(true);
		const events = await collection.exportTaskDecisionEvents({ rootDir: root, includeContent: true });
		expect(events.length).toBeGreaterThan(0);
		expect(events.every(event => event.mode === "metadata")).toBe(true);
		expect(events.some(event => event.event_type === "outcome")).toBe(true);
		expect(events.every(event => event.assignment === undefined)).toBe(true);
	});
});

describe("task decision collection integration", () => {
	test("routed preflight exhaustion emits one outcome and no model executions", async () => {
		const { recorder, models, outcomes } = observations();
		const result = await runSubprocess({
			...options(),
			autoroutingPreflight: true,
			autoroutingCandidates: [],
			routing: { tier: "balanced", requestedSelector: "test/absent", substitutions: [] },
			collectionRecorder: recorder,
		});
		expect(result.exitCode).toBe(1);
		expect(models).toEqual([]);
		expect(outcomes).toEqual([
			expect.objectContaining({ status: "preflight_exhausted", routingTerminalCode: "all_candidates_skipped" }),
		]);
	});

	test("resume cancellation preserves execution status", async () => {
		const { recorder, models, outcomes } = observations();
		const controller = new AbortController();
		controller.abort();
		const result = await runSubprocess({
			...options(),
			runMode: "resume",
			subagentId: "stable-subagent",
			parentSessionId: "stable-session",
			signal: controller.signal,
			collectionRecorder: recorder,
		});
		expect(result.aborted).toBe(true);
		expect(models).toEqual([]);
		expect(outcomes).toEqual([expect.objectContaining({ status: "cancelled", exitCode: 1 })]);
	});

	test("terminal recorder failures do not replace the execution result", async () => {
		const recorder: TaskDecisionRecorder = {
			recordModel: async () => {},
			recordDecision: async () => {},
			finish: () => {
				throw new Error("disk failure");
			},
		};
		const result = await runSubprocess({
			...options(),
			autoroutingPreflight: true,
			autoroutingCandidates: [],
			collectionRecorder: recorder,
		});
		expect(result.exitCode).toBe(1);
		expect(result.stderr).toBe("Autorouting preflight exhausted.");
	});

	test("collects actual session effort and provider-reported identity separately", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "task-collection-integration-"));
		roots.push(root);
		const messages: AssistantMessage[] = [];
		const listeners: Array<(event: AgentSessionEvent) => void> = [];
		const emit = (event: AgentSessionEvent) => {
			for (const listener of listeners) listener(event);
		};
		const session = {
			state: { messages },
			agent: { state: { systemPrompt: ["test"] } },
			model: { provider: "test", id: "resolved", contextWindow: 8192 },
			thinkingLevel: "low",
			extensionRunner: undefined,
			sessionManager: { appendSessionInit: () => {}, appendModelChange: () => {} },
			getActiveToolNames: () => ["yield"],
			setActiveToolsByName: async () => {},
			setConfiguredModelChain: () => {},
			getConfiguredModelChain: () => undefined,
			seedDefaultFallbackResolution: () => {},
			subscribe: (listener: (event: AgentSessionEvent) => void) => {
				listeners.push(listener);
				return () => {
					listeners.splice(listeners.indexOf(listener), 1);
				};
			},
			prompt: async () => {
				const message: AssistantMessage = {
					role: "assistant",
					content: [{ type: "text", text: "done" }],
					api: "openai-responses",
					provider: "test",
					model: "reported",
					usage: {
						input: 10,
						output: 2,
						cacheRead: 4,
						cacheWrite: 0,
						totalTokens: 16,
						cost: { input: 0.01, output: 0.02, cacheRead: 0, cacheWrite: 0, total: 0.03 },
					},
					stopReason: "stop",
					timestamp: Date.now(),
				};
				messages.push(message);
				emit({ type: "message_end", message });
				emit({ type: "agent_end", messages: [message], stopReason: "paused" });
			},
			waitForIdle: async () => {},
			getLastAssistantMessage: () => messages.at(-1),
			abort: async () => {},
			dispose: async () => {},
		} as unknown as AgentSession;
		vi.spyOn(sdkModule, "createAgentSession").mockResolvedValue({
			session,
			extensionsResult: {},
			setToolUIContext: () => {},
			eventBus: new EventBus(),
		} as unknown as CreateAgentSessionResult);
		const { recorder, models, outcomes } = observations();
		const result = await runSubprocess({
			...options(),
			cwd: root,
			collectionRecorder: recorder,
			thinkingLevel: Effort.High,
			modelRegistry: {
				refresh: async () => {},
				getAvailable: () => [],
				getApiKey: async () => kNoAuth,
			} as unknown as ModelRegistry,
		});
		expect(result.paused).toBe(true);
		expect(models).toEqual([
			expect.objectContaining({
				actualModel: "test/resolved",
				effectiveEffort: "low",
				providerReportedModel: undefined,
			}),
			expect.objectContaining({
				actualModel: "test/reported",
				effectiveEffort: "low",
				providerReportedModel: "test/reported",
			}),
		]);
		expect(outcomes).toHaveLength(1);
		expect(outcomes[0]).toMatchObject({ status: "paused", tokenUsage: { input: 10, output: 2, cacheRead: 4 } });
	});

	test("begin records message input and keeps shared session grouping", async () => {
		const begins: TaskDecisionBeginInput[] = [];
		vi.spyOn(collection, "beginTaskDecision").mockImplementation(async input => {
			begins.push(input);
			return undefined;
		});
		const controller = new AbortController();
		controller.abort();
		for (const resumeMessage of ["first update", "second update"]) {
			await runSubprocess({
				...options(),
				runMode: "message",
				resumeMessage,
				assignment: "original",
				parentSessionId: "same-session",
				signal: controller.signal,
			});
		}
		expect(begins.map(input => input.assignment)).toEqual(["first update", "second update"]);
		expect(begins[0]?.assignmentHash).not.toBe(begins[1]?.assignmentHash);
		expect(begins[0]?.sessionIdHash).toBe(begins[1]?.sessionIdHash);
	});

	test("independent installations collect and export disjoint IDs through real entrypoints", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "task-collection-machines-"));
		roots.push(root);
		const executorPath = path.resolve(import.meta.dir, "../src/task/executor.ts");
		const exporterPath = path.resolve(import.meta.dir, "../../../scripts/export-task-decisions.ts");
		const code = `
			import { runSubprocess } from ${JSON.stringify(executorPath)};
			const controller = new AbortController(); controller.abort();
			await runSubprocess({
				cwd: process.cwd(), agent: { name: "executor", description: "test", systemPrompt: "test", source: "bundled" },
				task: "private task description", assignment: "private assignment", index: 0, id: "same-task",
				parentSessionId: "same-session", signal: controller.signal, enableLsp: false,
			});
		`;
		const installationIds = new Set<string>();
		const eventIds = new Set<string>();
		for (const machine of ["a", "b", "c"]) {
			const agentDir = path.join(root, machine);
			const env = {
				...process.env,
				GJC_CODING_AGENT_DIR: agentDir,
				GJC_TASK_COLLECTION: "metadata",
				GJC_DISABLE_TELEMETRY: "0",
			};
			const run = Bun.spawnSync([process.execPath, "-e", code], { env, stdout: "pipe", stderr: "pipe" });
			expect(run.exitCode).toBe(0);
			const exported = Bun.spawnSync([process.execPath, exporterPath], { env, stdout: "pipe", stderr: "pipe" });
			expect(exported.exitCode).toBe(0);
			const text = exported.stdout.toString();
			expect(text).not.toContain("private assignment");
			const events = text
				.trim()
				.split("\n")
				.map(line => JSON.parse(line) as collection.TaskDecisionEvent);
			expect(events.map(event => event.event_type)).toEqual(["begin", "outcome"]);
			expect(events[1]?.status).toBe("cancelled");
			expect(events[0]?.decision_id).toBe(events[1]?.decision_id);
			for (const event of events) {
				installationIds.add(event.installation_id);
				eventIds.add(event.event_id);
			}
			// Read-only repeated exports retain IDs for downstream deduplication.
			const repeated = Bun.spawnSync([process.execPath, exporterPath], { env, stdout: "pipe", stderr: "pipe" });
			expect(repeated.stdout.toString()).toBe(text);
		}
		expect(installationIds.size).toBe(3);
		expect(eventIds.size).toBe(6);

		const disabledDir = path.join(root, "disabled");
		const disabled = Bun.spawnSync([process.execPath, "-e", code], {
			env: {
				...process.env,
				GJC_CODING_AGENT_DIR: disabledDir,
				GJC_TASK_COLLECTION: "content",
				GJC_DISABLE_TELEMETRY: "1",
			},
			stdout: "pipe",
			stderr: "pipe",
		});
		expect(disabled.exitCode).toBe(0);
		await expect(fs.lstat(path.join(disabledDir, "task-decisions"))).rejects.toMatchObject({ code: "ENOENT" });
	}, 30_000);
});
