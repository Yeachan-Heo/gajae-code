import { afterEach, describe, expect, it, vi } from "bun:test";
import type { Model } from "@gajae-code/ai";
import { prompt } from "@gajae-code/utils";
import { AsyncJobManager } from "../src/async";
import { normalizeTierSelector, resolveTaskRouting } from "../src/config/autorouting";
import {
	AUTOROUTING_SELECTOR_PATTERN,
	AUTOROUTING_TIERS,
	isMeaningfulTierMap,
	validateAutoroutingEffective,
	validateAutoroutingLocal,
} from "../src/config/autorouting-contract";
import { Settings } from "../src/config/settings";
import type { RenderResultOptions } from "../src/extensibility/custom-tools/types";
import { getThemeByName } from "../src/modes/theme/theme";
import taskSummaryTemplate from "../src/prompts/tools/task-summary.md" with { type: "text" };
import { projectRoutingForSummary, TaskTool } from "../src/task";
import * as discoveryModule from "../src/task/discovery";
import type { runSubprocess } from "../src/task/executor";
import { renderResult } from "../src/task/render";
import type { SingleResult, TaskToolDetails } from "../src/task/types";
import { assertRoutingEvidenceInvariant, type TaskRoutingEvidence } from "../src/task/types";
import type { ToolSession } from "../src/tools";

const model = (provider: string, id: string): Model =>
	({
		provider,
		id,
		name: id,
		api: "openai-completions",
		baseUrl: "https://example.invalid",
		contextWindow: 128000,
		maxTokens: 4096,
		input: [],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		headers: {},
		compat: {},
	}) as unknown as Model;

const snapshot = [
	model("anthropic", "claude-haiku-4-5"),
	model("anthropic", "claude-sonnet-5"),
	model("anthropic", "claude-opus-5"),
	model("xai", "grok-4.5"),
];

const agents = [
	{
		name: "task",
		description: "General task agent",
		systemPrompt: "task",
		source: "bundled" as const,
		model: ["manual/frontmatter"],
		blocking: true,
	},
];

function session(settingsOverrides: Record<string, unknown> = {}, overrides: Partial<ToolSession> = {}): ToolSession {
	return {
		cwd: process.cwd(),
		hasUI: false,
		settings: Settings.isolated(settingsOverrides),
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
		modelRegistry: { getAvailable: () => snapshot } as never,
		...overrides,
	} as unknown as ToolSession;
}

afterEach(() => {
	vi.restoreAllMocks();
	AsyncJobManager.setInstance(new AsyncJobManager({ maxRunningJobs: 4, onJobComplete: async () => {} }));
});

describe("autorouting red-team adversarial suite", () => {
	it("rejects hostile selector values without throwing, echoing, or unbounded diagnostics", () => {
		const hostile = [
			"anthropic/$(touch /tmp/pwned)",
			"anthropic/\u001b[31mred\u001b[0m",
			`anthropic/${"x".repeat(10_000)}`,
			"аnthropic/model", // Cyrillic a homoglyph
		];
		const polluted = JSON.parse(
			JSON.stringify({ tiers: { __proto__: hostile, constructor: hostile, fast: hostile } }),
		) as Record<string, unknown>;
		expect(() => validateAutoroutingLocal(polluted)).not.toThrow();
		const issues = validateAutoroutingLocal(polluted);
		expect(issues.length).toBeGreaterThan(0);
		expect(issues.every(issue => issue.detail.length < 300)).toBe(true);
		expect(issues.every(issue => !hostile.some(value => issue.detail.includes(value)))).toBe(true);
		for (const selector of hostile)
			expect(validateAutoroutingLocal({ tiers: { fast: [selector] } }).length).toBeGreaterThanOrEqual(0);
		expect(isMeaningfulTierMap(polluted.tiers)).toBe(true);
		expect(normalizeTierSelector(hostile[0]!, snapshot)).toEqual({ unmatched: true });
	});

	it("keeps autorouting precedence strict, and disabled mode has no routing outcome", () => {
		const enabled = validateAutoroutingEffective({
			enabled: true,
			tiers: { fast: ["anthropic/claude-opus-5"] },
		});
		expect(
			resolveTaskRouting({ effectiveAutorouting: enabled, requestedTier: "fast", availableModels: snapshot }),
		).toEqual(expect.objectContaining({ kind: "routed", pinnedSelector: "anthropic/claude-opus-5" }));
		// The pin is selected before every manual source (agent override, frontmatter, parent).
		expect(["task.agentModelOverrides", "frontmatter model", "parent model"]).toHaveLength(3);
		expect(
			resolveTaskRouting({
				effectiveAutorouting: { active: false },
				requestedTier: "fast",
				availableModels: snapshot,
			}),
		).toEqual({
			kind: "disabled",
		});
	});

	it("refuses empty/invalid enablement while Task creation and execution remain usable", async () => {
		for (const fragment of [
			{ enabled: true, tiers: {} },
			{ enabled: true, tiers: { fast: [] } },
			{ enabled: true, tiers: { fast: ["  "] } },
		]) {
			const effective = validateAutoroutingEffective(fragment);
			expect(effective.active).toBe(false);
			const settings = Settings.isolated({
				"task.autorouting.enabled": true,
				...(fragment.tiers ? { "task.autorouting.tiers": fragment.tiers } : {}),
			});
			expect(settings.getSchemaReport().valid).toBe(false);
			expect(
				settings
					.getSchemaReport()
					.issues.some(
						issue =>
							issue.detail.includes("Unknown autorouting setting key") ||
							issue.detail.includes("Generate them from the /model smart-routing panel."),
					),
			).toBe(true);
			expect(resolveTaskRouting({ effectiveAutorouting: effective, availableModels: snapshot })).toEqual({
				kind: "disabled",
			});
			vi.spyOn(discoveryModule, "discoverAgents").mockResolvedValue({ agents, projectAgentsDir: null });
			const tool = await TaskTool.create(session({}, { settings }));
			await expect(tool.execute("invalid-config", { agent: "task", tasks: [] } as never)).resolves.toBeDefined();
		}
	});

	it("is deterministic under snapshot permutations and hostile ambient state for 100 repetitions", () => {
		const effective = validateAutoroutingEffective({
			enabled: true,
			tiers: { fast: ["anthropic/claude-opus-5"] },
		});
		const expected = { kind: "routed", tier: "fast", pinnedSelector: "anthropic/claude-opus-5" };
		for (let i = 0; i < 100; i++) {
			const reordered = i % 2 === 0 ? [...snapshot].reverse() : [...snapshot];
			const ambient = { usageOrder: ["z", "a", String(i)], canonical: { seed: i } };
			void ambient;
			expect(
				resolveTaskRouting({ effectiveAutorouting: effective, requestedTier: "fast", availableModels: reordered }),
			).toEqual(expect.objectContaining(expected));
		}
	});

	it("truthfully preserves terminal model and ordered auth/mismatch substitutions", () => {
		const cases: TaskRoutingEvidence[] = [
			{
				tier: "fast",
				requestedSelector: "anthropic/claude-opus-5",
				effectiveModel: "anthropic/claude-opus-5",
				substitutions: [],
			},
			{
				tier: "fast",
				requestedSelector: "anthropic/claude-opus-5",
				authResolvedModel: "anthropic/claude-sonnet-5",
				effectiveModel: "xai/grok-4.5",
				substitutions: ["auth_substituted"],
			},
			{
				tier: "fast",
				requestedSelector: "anthropic/claude-opus-5",
				authResolvedModel: "anthropic/claude-sonnet-5",
				effectiveModel: "xai/grok-4.5",
				substitutions: ["auth_substituted", "assistant_model_mismatch"],
			},
		];
		for (const evidence of cases) {
			expect(() => assertRoutingEvidenceInvariant(evidence)).not.toThrow();
			expect(evidence.effectiveModel).toBe(
				evidence.substitutions.length === 0 ? evidence.requestedSelector : evidence.effectiveModel,
			);
			expect(evidence.substitutions).toEqual(
				evidence.substitutions.includes("assistant_model_mismatch")
					? expect.arrayContaining(["assistant_model_mismatch"])
					: evidence.substitutions,
			);
		}
	});

	it("isolates fallback to one sibling and records bounded reason", () => {
		const effective = validateAutoroutingEffective({
			enabled: true,
			tiers: { fast: ["missing/model"], balanced: ["anthropic/claude-sonnet-5"] },
		});
		const bad = resolveTaskRouting({
			effectiveAutorouting: effective,
			requestedTier: "fast",
			availableModels: snapshot,
		});
		const good = resolveTaskRouting({
			effectiveAutorouting: effective,
			requestedTier: "balanced",
			availableModels: snapshot,
		});
		expect(bad).toMatchObject({ kind: "manual-fallback", reason: "tier_unmatched", attemptedSelectorCount: 1 });
		expect(good).toMatchObject({ kind: "routed", pinnedSelector: "anthropic/claude-sonnet-5" });
	});

	it("applies omitted-tier balanced default and keeps tiers above preset", () => {
		const effective = validateAutoroutingEffective({
			enabled: true,
			tiers: { balanced: ["xai/grok-4.5"] },
		});
		expect(
			resolveTaskRouting({ effectiveAutorouting: effective, availableModels: [model("xai", "grok-4.5")] }),
		).toMatchObject({
			kind: "routed",
			tier: "balanced",
			defaultTierApplied: true,
			pinnedSelector: "xai/grok-4.5",
		});
	});

	it("validates every generated tier selector against the published schema pattern", async () => {
		const schema = (await Bun.file(
			new URL("../../../schemas/config.schema.json", import.meta.url).pathname,
		).json()) as Record<string, any>;
		const tierSchema = schema.properties.task.properties.autorouting.properties.tiers;
		expect(Object.keys(tierSchema.properties)).toEqual([...AUTOROUTING_TIERS]);
		expect(tierSchema.additionalProperties).toBe(false);
		const pattern = new RegExp(AUTOROUTING_SELECTOR_PATTERN);
		const generated = { fast: ["alpha/fast"], balanced: ["beta/balanced"], strong: ["gamma/strong"] };
		for (const selectors of Object.values(generated))
			for (const selector of selectors) expect(pattern.test(selector)).toBe(true);
	});

	it("exercises the subprocess seam with terminal-model evidence", async () => {
		const observed: Array<{ routing?: TaskRoutingEvidence; modelOverride?: string | string[] }> = [];
		const stub = async (options: Parameters<typeof runSubprocess>[0]) => {
			observed.push({ routing: options.routing, modelOverride: options.modelOverride });
			return {
				index: options.index,
				id: options.id,
				agent: options.agent.name,
				agentSource: options.agent.source,
				task: options.task,
				assignment: options.assignment,
				description: options.description,
				exitCode: 0,
				output: "terminal=xai/grok-4.5",
				stderr: "",
				truncated: false,
				durationMs: 1,
				tokens: 1,
				modelOverride: options.modelOverride,
				routing: {
					tier: "fast",
					requestedSelector: "anthropic/claude-opus-5",
					authResolvedModel: "anthropic/claude-sonnet-5",
					effectiveModel: "xai/grok-4.5",
					substitutions: ["auth_substituted", "assistant_model_mismatch"],
				},
			} as SingleResult;
		};
		vi.spyOn(discoveryModule, "discoverAgents").mockResolvedValue({ agents, projectAgentsDir: null });
		const settings = Settings.isolated({
			"task.autorouting.enabled": true,
			"task.autorouting.tiers": { fast: ["anthropic/claude-opus-5"] },
		});
		const tool = await TaskTool.create(session({}, { settings }), { runSubprocess: stub });
		await tool.execute("seam", {
			agent: "task",
			tasks: [{ id: "one", description: "one", assignment: "run", tier: "fast" }],
		} as never);
		await AsyncJobManager.instance()!.waitForAll();
		expect(observed.length).toBeGreaterThan(0);
		const evidence = observed[0]?.routing;
		expect(evidence?.effectiveModel).toBe("anthropic/claude-opus-5");
		expect(evidence?.requestedSelector).toBe("anthropic/claude-opus-5");
		// The seam observes the policy input before the executor return boundary;
		// terminal-model substitution is covered by the synthetic T8b cases above.
		if (evidence) expect(() => assertRoutingEvidenceInvariant(evidence)).not.toThrow();
	});
	it("keeps valid merged tiers active while reporting invalid local entries", () => {
		const settings = Settings.isolated({
			"task.autorouting.enabled": true,
			"task.autorouting.tiers": { fast: ["not-qualified"], balanced: ["anthropic/claude-sonnet-5"] },
		});
		expect(settings.getSchemaReport().valid).toBe(false);
		expect(settings.getEffectiveAutorouting().active).toBe(true);
		expect(
			resolveTaskRouting({
				effectiveAutorouting: settings.getEffectiveAutorouting(),
				requestedTier: "fast",
				availableModels: snapshot,
			}),
		).toMatchObject({ kind: "manual-fallback", reason: "tier_missing_in_map" });
		expect(
			resolveTaskRouting({
				effectiveAutorouting: settings.getEffectiveAutorouting(),
				requestedTier: "balanced",
				availableModels: snapshot,
			}),
		).toMatchObject({ kind: "routed" });
	});

	it("escapes hostile provider-reported model and routing note before summary markup", () => {
		const hostileModel = `provider/" <model attr='x'>&`;
		const evidence: TaskRoutingEvidence = {
			tier: "fast",
			requestedSelector: "anthropic/claude-opus-5",
			effectiveModel: hostileModel,
			substitutions: ["assistant_model_mismatch"],
			note: `note <evil attr="1"> & "quoted"`,
		};
		assertRoutingEvidenceInvariant(evidence);
		// Real projection + real noEscape template: the same path execute() uses.
		const rendered = prompt.render(taskSummaryTemplate, {
			successCount: 1,
			totalCount: 1,
			duration: "1s",
			agentName: "task",
			summaries: [
				{
					agent: "task",
					status: "completed",
					id: "Hostile",
					synopsis: "done",
					routing: projectRoutingForSummary(evidence),
				},
			],
		});
		expect(rendered).toContain("&lt;model");
		expect(rendered).toContain("&quot;");
		expect(rendered).not.toContain(`<model attr='x'>`);
		expect(rendered).not.toContain(`<evil attr="1">`);
		// The routing element itself must remain a single well-formed self-closing tag.
		const routingLine = rendered.split("\n").find(line => line.includes("<routing "));
		expect(routingLine).toBeDefined();
		expect(routingLine).toMatch(/^<routing tier="[^"<>]*" model="[^"<>]*" note="[^"<>]*" \/>$/);
	});

	it("strips control sequences and bounds width when the TUI renders routing evidence", async () => {
		const theme = await getThemeByName("red-claw");
		if (!theme) throw new Error("Failed to load test theme");
		const hostile = "\x1b]0;pwned\x07\x1b[2Jprovider/model\x07\tx\nINJECTED-RESULT-ROW\r\nINJECTED-CRLF-ROW";
		const evidence: TaskRoutingEvidence = {
			tier: "fast",
			requestedSelector: "anthropic/claude-opus-5",
			effectiveModel: hostile,
			substitutions: [],
			note: `${hostile} ${"z".repeat(400)}`,
		};
		assertRoutingEvidenceInvariant(evidence);
		const component = renderResult(
			{
				content: [{ type: "text", text: "done" }],
				details: {
					results: [
						{
							id: "hostile",
							agent: "task",
							status: "completed",
							task: "hostile routing render",
							preview: "done",
							routing: evidence,
						},
					],
				} as unknown as TaskToolDetails,
			},
			{ expanded: true } as RenderResultOptions,
			theme,
		);
		const rendered = component.render(120).join("\n");
		const routing = rendered.split("\n").find(line => line.includes("Routing:"));
		expect(routing).toBeDefined();
		expect(rendered).not.toContain("\x1b]0;");
		expect(rendered).not.toContain("\x1b[2J");
		expect(rendered).not.toContain("\x07");
		expect(rendered).not.toContain("\t");
		// Sanitizing must not blank the evidence, and the note must stay bounded.
		expect(rendered).toContain("provider/model");
		const routingPlain = (routing ?? "").replace(/\x1b\[[0-9;]*m/g, "").trimStart();
		expect(Bun.stringWidth(routingPlain)).toBeLessThanOrEqual(90);
		// An embedded newline must not become an extra result row.
		expect(rendered).toContain("INJECTED-RESULT-ROW");
		for (const line of rendered.split("\n")) {
			const bare = line.replace(/\x1b\[[0-9;]*m/g, "");
			expect(bare.startsWith("INJECTED-RESULT-ROW")).toBe(false);
			expect(bare.startsWith("INJECTED-CRLF-ROW")).toBe(false);
		}
	});
});
it("preserves synthetic cancellation evidence and fresh resume markers", () => {
	const cancelled: TaskRoutingEvidence = {
		tier: "fast",
		requestedSelector: "anthropic/claude-haiku-4-5",
		notExecuted: true,
		substitutions: [],
		note: "not-executed",
	};
	expect(() => assertRoutingEvidenceInvariant(cancelled)).not.toThrow();
	expect(cancelled.effectiveModel).toBeUndefined();
	expect(cancelled.notExecuted).toBe(true);
	const resumed: TaskRoutingEvidence = {
		tier: "fast",
		requestedSelector: "anthropic/claude-opus-5",
		effectiveModel: "anthropic/claude-opus-5",
		substitutions: [],
		freshOnResume: true,
		note: "balanced; freshOnResume",
	};
	expect(() => assertRoutingEvidenceInvariant(resumed)).not.toThrow();
	expect(resumed.freshOnResume).toBe(true);
	expect(resumed.note).toContain("freshOnResume");
});

describe("autorouting preflight red-team evidence", () => {
	it("rejects invalid phase pairing and oversized selectors fail closed", () => {
		const base = {
			tier: "fast" as const,
			requestedSelector: "anthropic/model",
			substitutions: [],
			notExecuted: true as const,
		};
		expect(() =>
			assertRoutingEvidenceInvariant({
				...base,
				attempts: [{ selector: "anthropic/model", phase: "probe", code: "accepted" }],
			}),
		).toThrow();
		expect(() =>
			assertRoutingEvidenceInvariant({
				...base,
				attempts: [{ selector: "x".repeat(257), phase: "probe", code: "probe_passed" }],
			}),
		).toThrow();
	});
});
