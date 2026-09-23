import { afterEach, describe, expect, test, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Effort, getBundledModel, type Model } from "@gajae-code/ai";
import { AsyncJobManager } from "../src/async";
import type { ModelRegistry } from "../src/config/model-registry";
import { Settings } from "../src/config/settings";
import { reconcileSettingsSchema } from "../src/config/settings-schema";
import * as sdk from "../src/sdk";
import { TaskTool } from "../src/task";
import type {
	TaskDecisionBeginInput,
	TaskDecisionObservationInput,
	TaskDecisionOutcomeInput,
	TaskDecisionRecorder,
} from "../src/task/decision-collection";
import * as collection from "../src/task/decision-collection";
import type { DecisionOutcome, DecisionProvider } from "../src/task/decision-model";
import { applyTaskDecision, buildTaskDecisionContext, createTaskDecisionProvider } from "../src/task/decision-routing";
import * as discovery from "../src/task/discovery";
import { type ExecutorOptions, runSubprocess } from "../src/task/executor";
import type { SingleResult } from "../src/task/types";
import type { ToolSession } from "../src/tools";

const roots: string[] = [];
afterEach(async () => {
	vi.restoreAllMocks();
	await Promise.all(roots.splice(0).map(root => fs.rm(root, { recursive: true, force: true })));
});
const selected = getBundledModel("anthropic", "claude-sonnet-4-5")!;
const original = getBundledModel("anthropic", "claude-opus-4-6")!;
const selector = (model: Model) => `${model.provider}/${model.id}`;
const recommendation: DecisionOutcome = { result: { choice: "fast", probabilities: { fast: 1 }, confidence: 1 } };

async function fixture(provider: DecisionProvider, mode: "shadow" | "routing" = "routing") {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-decision-routing-"));
	roots.push(root);
	const observations: TaskDecisionObservationInput[] = [];
	const outcomes: TaskDecisionOutcomeInput[] = [];
	const recorded = Promise.withResolvers<void>();
	const recorder: TaskDecisionRecorder = {
		recordModel: async () => {},
		recordDecision: async observation => {
			observations.push(observation);
			recorded.resolve();
		},
		finish: async outcome => {
			outcomes.push(outcome);
		},
	};
	const settings = Settings.isolated();
	const context = buildTaskDecisionContext({
		role: "executor",
		assignment: "synthetic bounded task",
		tierMap: { fast: [`${selector(selected)}:low`] },
		routingSnapshot: [selected, original],
		provider: { provider, providerName: "kev", mode, decisionModel: "kev-latest", timeoutMs: 5000 },
	});
	const options: ExecutorOptions = {
		cwd: root,
		agent: { name: "executor", description: "routing test", systemPrompt: "test", source: "bundled" },
		task: "synthetic bounded task",
		assignment: "synthetic bounded task",
		index: 0,
		id: "decision-routing",
		settings,
		enableLsp: false,
		modelOverride: [selector(original)],
		thinkingLevel: Effort.High,
		parentActiveModelPattern: selector(original),
		collectionRecorder: recorder,
		decisionContext: context,
		modelRegistry: {
			refresh: async () => {},
			getAvailable: () => [selected, original],
			getAll: () => [selected, original],
			getApiKey: async () => "fixture-key",
		} as unknown as ModelRegistry,
	};
	return { options, context, observations, outcomes, recorded, recorder };
}

describe("fresh-subagent decision integration", () => {
	test("valid routing overrides explicit child model/effort without mutating parent inputs", async () => {
		let calls = 0;
		const f = await fixture({
			decide: async () => {
				calls++;
				return recommendation;
			},
		});
		const begins: TaskDecisionBeginInput[] = [];
		vi.spyOn(collection, "beginTaskDecision").mockImplementation(async input => {
			begins.push(input);
			return f.recorder;
		});
		const bootstrap = vi.spyOn(sdk, "createAgentSession").mockRejectedValue(new Error("synthetic bootstrap stop"));
		const result = await runSubprocess({ ...f.options, collectionRecorder: undefined });
		expect(result.exitCode).toBe(1);
		expect(bootstrap.mock.calls[0]?.[0]?.model?.id).toBe(selected.id);
		expect(bootstrap.mock.calls[0]?.[0]?.thinkingLevel).toBe(Effort.Low);
		expect(calls).toBe(1);
		expect(f.options.modelOverride).toEqual([selector(original)]);
		expect(f.options.thinkingLevel).toBe(Effort.High);
		expect(f.options.parentActiveModelPattern).toBe(selector(original));
		expect(begins[0]?.requestedSelectors).toEqual([selector(original)]);
		expect(begins[0]?.requestedEffort).toBe(Effort.High);
		expect(f.observations[0]).toMatchObject({
			requested_model: "kev-latest",
			recommended_tier: "fast",
			effective_selector: `${selector(selected)}:low`,
			effective_effort: "low",
		});
	});

	test("failure preserves original pins and runs once across preflight fallback attempts", async () => {
		let calls = 0;
		const f = await fixture({
			decide: async () => {
				calls++;
				return { error: { code: "timeout" } };
			},
		});
		const bootstrap = vi
			.spyOn(sdk, "createAgentSession")
			.mockRejectedValue(Object.assign(new Error("synthetic transient failure"), { transient: true }));
		const result = await runSubprocess({
			...f.options,
			autoroutingPreflight: true,
			autoroutingCandidates: [selector(original), selector(selected)],
		});
		expect(result.exitCode).toBe(1);
		expect(new Set(bootstrap.mock.calls.map(call => call[0]?.model?.id))).toEqual(
			new Set([original.id, selected.id]),
		);
		expect(calls).toBe(1);
		expect(f.observations).toHaveLength(1);
		expect(f.observations[0]?.error_code).toBe("timeout");
		expect(f.observations[0]?.effective_selector).toBeUndefined();
	});

	test("shadow completes the child before prediction and still records the late result", async () => {
		const pending = Promise.withResolvers<DecisionOutcome>();
		const f = await fixture({ decide: () => pending.promise }, "shadow");
		const result = await runSubprocess({ ...f.options, autoroutingPreflight: true, autoroutingCandidates: [] });
		expect(result.exitCode).toBe(1);
		expect(f.outcomes).toHaveLength(1);
		expect(f.observations).toEqual([]);
		pending.resolve(recommendation);
		await f.recorded.promise;
		expect(f.observations[0]?.recommended_tier).toBe("fast");
		expect(f.observations[0]?.effective_selector).toBeUndefined();
		expect(f.outcomes).toHaveLength(1);
	});

	test("records prediction latency before a slow child finishes, including child failures", async () => {
		const child = Promise.withResolvers<void>();
		const f = await fixture({ decide: async () => recommendation }, "shadow");
		vi.spyOn(sdk, "createAgentSession").mockImplementation(async () => {
			await child.promise;
			throw new Error("synthetic child failure");
		});
		const execution = runSubprocess(f.options);
		try {
			await f.recorded.promise;
			expect(f.outcomes).toEqual([]);
			const latency = f.observations[0]!.latency_ms;
			await Bun.sleep(20);
			child.resolve();
			await execution;
			expect(f.observations[0]!.latency_ms).toBe(latency);
			expect(f.outcomes[0]?.status).toBe("error");
		} finally {
			child.resolve();
			await execution;
		}
	});

	test("resume, message and direct preflight probes do not call or record a predictor", async () => {
		let calls = 0;
		const f = await fixture({
			decide: async () => {
				calls++;
				return recommendation;
			},
		});
		for (const patch of [
			{ runMode: "resume" as const },
			{ runMode: "message" as const },
			{ preflightProbe: true },
			{ preflightDurable: true },
		]) {
			await runSubprocess({
				...f.options,
				...patch,
				signal: AbortSignal.abort(),
				autoroutingPreflight: true,
				autoroutingCandidates: [],
			});
		}
		expect(calls).toBe(0);
		expect(f.observations).toEqual([]);
	});

	test("no candidates produce an observation without HTTP and leave the original route intact", async () => {
		let calls = 0;
		const f = await fixture({
			decide: async () => {
				calls++;
				return recommendation;
			},
		});
		const context = buildTaskDecisionContext({ role: "executor", assignment: "work", provider: f.context });
		await runSubprocess({
			...f.options,
			decisionContext: context,
			autoroutingPreflight: true,
			autoroutingCandidates: [],
		});
		expect(calls).toBe(0);
		expect(f.observations[0]?.error_code).toBe("no_candidate");
	});

	test("a synchronously throwing predictor cannot suppress child execution", async () => {
		const f = await fixture({
			decide() {
				throw new Error("private provider diagnostic");
			},
		});
		const bootstrap = vi.spyOn(sdk, "createAgentSession").mockRejectedValue(new Error("synthetic bootstrap stop"));
		await runSubprocess(f.options);
		expect(bootstrap.mock.calls[0]?.[0]?.model?.id).toBe(original.id);
		expect(f.observations[0]?.error_code).toBe("transport_error");
		expect(JSON.stringify(f.observations)).not.toContain("private provider diagnostic");
	});

	test("late actual recommendations are discarded even if a provider ignores its contract", async () => {
		const f = await fixture({
			decide: async () => {
				await Bun.sleep(10);
				return recommendation;
			},
		});
		const context = { ...f.context, timeoutMs: 1 };
		const bootstrap = vi.spyOn(sdk, "createAgentSession").mockRejectedValue(new Error("synthetic bootstrap stop"));
		await runSubprocess({ ...f.options, decisionContext: context });
		expect(bootstrap.mock.calls[0]?.[0]?.model?.id).toBe(original.id);
		expect(f.observations[0]?.error_code).toBe("timeout");
	});
});

describe("decision context construction", () => {
	test("TaskTool captures configured tiers even when legacy autorouting is disabled", async () => {
		const previous = AsyncJobManager.instance();
		const manager = new AsyncJobManager({ maxRunningJobs: 2, onJobComplete: async () => {} });
		AsyncJobManager.setInstance(manager);
		const captured: ExecutorOptions[] = [];
		const settings = Settings.isolated({
			"task.decision.enabled": true,
			"task.autorouting.enabled": false,
			"task.autorouting.tiers": { fast: [`${selector(selected)}:low`] },
		});
		vi.spyOn(discovery, "discoverAgents").mockResolvedValue({
			agents: [{ name: "executor", description: "test executor", systemPrompt: "test", source: "bundled" }],
			projectAgentsDir: null,
		});
		try {
			const session = {
				cwd: process.cwd(),
				hasUI: false,
				settings,
				getSessionFile: () => null,
				getSessionSpawns: () => "*",
				getActiveModelString: () => selector(original),
				modelRegistry: {
					getAvailable: () => [selected, original],
					getAll: () => [selected, original],
					getApiKey: async () => "fixture-key",
				},
			} as unknown as ToolSession;
			const tool = await TaskTool.create(session, {
				runSubprocess: async options => {
					captured.push(options);
					return {
						index: options.index,
						id: options.id,
						agent: options.agent.name,
						agentSource: options.agent.source,
						task: options.task,
						assignment: options.assignment,
						exitCode: 0,
						output: "fixture result",
						stderr: "",
						truncated: false,
						durationMs: 1,
						tokens: 0,
					} as SingleResult;
				},
			});
			await tool.execute("decision-tasktool", {
				agent: "executor",
				tasks: [
					{
						id: "DecisionContext",
						description: "capture context",
						assignment: "Inspect only the synthetic routing fixture.",
					},
				],
			} as never);
			await manager.waitForAll();
			expect(captured).toHaveLength(1);
			expect(captured[0]?.decisionContext?.tierSelectors).toEqual({ fast: `${selector(selected)}:low` });
			expect(settings.getEffectiveAutorouting().active).toBe(false);
			expect(session.getActiveModelString?.()).toBe(selector(original));
		} finally {
			await manager.waitForAll();
			await manager.dispose();
			AsyncJobManager.setInstance(previous);
		}
	});

	test("feature-off has no decision provider, while enabled malformed setup remains auditable", () => {
		expect(createTaskDecisionProvider({ settings: Settings.isolated() })).toBeUndefined();
		const settings = Settings.isolated({
			"task.decision.enabled": true,
			"task.decision.kevEndpoint": "https://outside.invalid",
		});
		expect(createTaskDecisionProvider({ settings })).toMatchObject({
			setupError: "invalid_configuration",
			providerName: "kev",
		});
	});

	test("enforce mode is rejected and never creates a provider", () => {
		expect(reconcileSettingsSchema({ task: { decision: { mode: "enforce" } } }).report.valid).toBe(false);
		const settings = Settings.isolated({ "task.decision.enabled": true, "task.decision.mode": "enforce" as never });
		expect(createTaskDecisionProvider({ settings })).toMatchObject({ setupError: "invalid_configuration" });
	});

	test("candidate mapping survives source mutation and respects literal colon-bearing model IDs", () => {
		const models = [{ ...selected }];
		const tiers = { fast: [`${selector(selected)}:low`] };
		const provider = { providerName: "kev", mode: "routing", decisionModel: "kev-latest", timeoutMs: 5000 } as const;
		const context = buildTaskDecisionContext({
			role: "executor",
			assignment: "work",
			tierMap: tiers,
			routingSnapshot: models,
			provider,
		});
		tiers.fast[0] = "other/model:high";
		models[0]!.id = "changed";
		expect(applyTaskDecision(context, recommendation)).toEqual({
			selector: `${selector(selected)}:low`,
			tier: "fast",
			effort: Effort.Low,
		});
		const literal = { ...selected, id: "literal:high" };
		const literalContext = buildTaskDecisionContext({
			role: "executor",
			assignment: "work",
			tierMap: { fast: [selector(literal)] },
			routingSnapshot: [literal],
			provider,
		});
		expect(applyTaskDecision(literalContext, recommendation)).toEqual({
			selector: selector(literal),
			tier: "fast",
			effort: undefined,
		});
	});
});
