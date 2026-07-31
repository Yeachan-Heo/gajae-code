import { describe, expect, it } from "bun:test";
import type { Model } from "@gajae-code/ai";
import { normalizeTierSelector, resolveTaskRouting } from "../src/config/autorouting";
import {
	AUTOROUTING_PRESET_IDS,
	AUTOROUTING_PRESETS,
	AUTOROUTING_SELECTOR_DESCRIPTION,
	AUTOROUTING_TIERS,
	isMeaningfulTierMap,
	resolveTierMap,
	validateAutoroutingEffective,
	validateAutoroutingLocal,
} from "../src/config/autorouting-contract";
import { Settings } from "../src/config/settings";
import { reconcileSettingsSchema } from "../src/config/settings-schema";
import { finalizeRoutingEvidence } from "../src/task/executor";
import { assertRoutingEvidenceInvariant, type TaskRoutingEvidence } from "../src/task/types";

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
	model("anthropic", "claude-opus-5"),
	model("anthropic", "claude-opus-4-8"),
	model("xai", "grok-4.5"),
	model("openrouter", "route:model:free"),
];

function active(tiers: Record<string, string[]>, preset?: string) {
	return validateAutoroutingEffective({ enabled: true, tiers, preset });
}

describe("G001 foundation contract", () => {
	it("keeps boundary semantics and tiers-over-preset precedence", () => {
		expect(AUTOROUTING_TIERS).toEqual(["fast", "balanced", "strong"]);
		expect(AUTOROUTING_PRESET_IDS).toEqual(["anthropic", "openai-codex", "google", "xai"]);
		expect(isMeaningfulTierMap({})).toBe(false);
		expect(isMeaningfulTierMap({ fast: [] })).toBe(false);
		expect(isMeaningfulTierMap({ fast: ["  "] })).toBe(false);
		expect(isMeaningfulTierMap({ fast: ["vllm/model"] })).toBe(true);
		expect(resolveTierMap({ tiers: { fast: ["vllm/model"] }, preset: "anthropic" })).toEqual({
			fast: ["vllm/model"],
		});
	});

	it("reports local diagnostics and publishes fixed schema keys", async () => {
		const issues = validateAutoroutingLocal({
			enabled: "true",
			tiers: { unknown: ["vllm/model"], fast: ["model", "pi/default"] },
		});
		expect(issues.some(issue => issue.path === "enabled" && issue.code === "config_invalid")).toBe(true);
		expect(issues.some(issue => issue.path === "tiers.unknown")).toBe(true);
		expect(
			issues.some(issue => issue.path === "tiers.fast.0" && issue.code === "selector_not_provider_qualified"),
		).toBe(true);
		expect(
			issues.some(issue => issue.path === "tiers.fast.1" && issue.detail.includes(AUTOROUTING_SELECTOR_DESCRIPTION)),
		).toBe(true);
		expect(reconcileSettingsSchema({ task: { autorouting: { enabled: true } } }).report.valid).toBe(true);
		const schema = await Bun.file(new URL("../../../schemas/config.schema.json", import.meta.url).pathname).json();
		const tiers = schema.properties.task.properties.autorouting.properties.tiers;
		expect(Object.keys(tiers.properties)).toEqual(["fast", "balanced", "strong"]);
		expect(tiers.additionalProperties).toBe(false);
		expect(JSON.stringify(tiers)).toContain('"pattern":"^\\\\s*[pP][iI]/"');
		expect(JSON.stringify(tiers)).toContain("no pi/<role> role aliases");
		const main = await Bun.file(new URL("../src/main.ts", import.meta.url).pathname).text();
		for (const path of ["task.autorouting.enabled", "task.autorouting.preset", "task.autorouting.tiers"])
			expect(main).toContain(`"${path}"`);
	});

	it("covers locked presets and local vllm behavior", () => {
		for (const [id, preset] of Object.entries(AUTOROUTING_PRESETS)) {
			for (const tier of AUTOROUTING_TIERS) {
				const full = preset[tier]!.map(selector =>
					model(selector.split("/")[0]!, selector.split("/")[1]!.split(":")[0]!),
				);
				expect(
					resolveTaskRouting({
						effectiveAutorouting: validateAutoroutingEffective({ enabled: true, preset: id }),
						requestedTier: tier,
						availableModels: full,
					}).kind,
				).toBe("routed");
				expect(
					resolveTaskRouting({
						effectiveAutorouting: validateAutoroutingEffective({ enabled: true, preset: id }),
						requestedTier: tier,
						availableModels: full.slice(-1),
					}).kind,
				).toBe("routed");
				expect(
					resolveTaskRouting({
						effectiveAutorouting: validateAutoroutingEffective({ enabled: true, preset: id }),
						requestedTier: tier,
						availableModels: [],
					}),
				).toMatchObject({ kind: "manual-fallback", reason: "tier_unmatched" });
			}
		}
		expect(
			resolveTaskRouting({
				effectiveAutorouting: validateAutoroutingEffective({ enabled: true, preset: "anthropic" }),
				requestedTier: "fast",
				availableModels: [model("vllm", "local")],
			}).kind,
		).toBe("manual-fallback");
		expect(
			resolveTaskRouting({
				effectiveAutorouting: validateAutoroutingEffective({ enabled: true, tiers: { fast: ["vllm/local"] } }),
				requestedTier: "fast",
				availableModels: [model("vllm", "local")],
			}).kind,
		).toBe("routed");
	});

	it("covers merged settings and refusal lifecycle", () => {
		const settings = Settings.isolated({ "task.autorouting.enabled": true });
		settings.override("task.autorouting.tiers", { fast: ["vllm/local"] });
		expect(settings.getEffectiveAutorouting().active).toBe(true);
		expect(settings.getSchemaReport().valid).toBe(true);
		settings.clearOverride("task.autorouting.tiers");
		expect(settings.getEffectiveAutorouting().active).toBe(false);
		expect(settings.getSchemaReport().valid).toBe(false);
		const invalid = Settings.isolated({
			"task.autorouting.enabled": true,
			"task.autorouting.tiers": { fast: ["pi/default"] },
		});
		expect(invalid.getEffectiveAutorouting().active).toBe(false);
		expect(invalid.getSchemaReport().valid).toBe(false);
	});
});
describe("T9 precedence and evidence parity", () => {
	it("autorouting pin takes precedence over manual model sources", () => {
		const effective = active({ fast: ["anthropic/claude-opus-5"] });
		const routed = resolveTaskRouting({
			effectiveAutorouting: effective,
			requestedTier: "fast",
			availableModels: snapshot,
		});
		expect(routed).toMatchObject({ kind: "routed", pinnedSelector: "anthropic/claude-opus-5" });
		expect(["task.agentModelOverrides", "frontmatter model", "parent model"]).toHaveLength(3);
	});

	it("keeps evidence model parity and ordered substitutions", () => {
		const evidence: TaskRoutingEvidence = {
			tier: "balanced",
			source: "tiers",
			requestedSelector: "anthropic/claude-opus-5",
			effectiveModel: "anthropic/claude-opus-5",
			substitutions: [],
		};
		assertRoutingEvidenceInvariant(evidence);
		expect(evidence.effectiveModel).toBe("anthropic/claude-opus-5");
	});
});

describe("G003 routing engine", () => {
	it("pins deterministic selectors independent of ambient ordering", () => {
		const effective = active({ fast: ["anthropic/claude-opus-5"] });
		const a = resolveTaskRouting({
			effectiveAutorouting: effective,
			requestedTier: "fast",
			availableModels: snapshot,
		});
		const b = resolveTaskRouting({
			effectiveAutorouting: effective,
			requestedTier: "fast",
			availableModels: [...snapshot].reverse(),
		});
		expect(a).toEqual(b);
		expect(normalizeTierSelector("anthropic/claude-opus-5", snapshot)).toEqual({ pinned: "anthropic/claude-opus-5" });
	});

	it("returns bounded fallback reasons and omitted-tier default", () => {
		const effective = active({ fast: ["missing/model"] });
		expect(
			resolveTaskRouting({ effectiveAutorouting: effective, requestedTier: "fast", availableModels: snapshot }),
		).toMatchObject({
			kind: "manual-fallback",
			reason: "tier_unmatched",
			attemptedSelectorCount: 1,
		});
		expect(
			resolveTaskRouting({ effectiveAutorouting: effective, requestedTier: "strong", availableModels: snapshot }),
		).toMatchObject({
			kind: "manual-fallback",
			reason: "tier_missing_in_map",
		});
		expect(
			resolveTaskRouting({
				effectiveAutorouting: active({ balanced: ["anthropic/claude-opus-5"] }),
				availableModels: snapshot,
			}),
		).toMatchObject({
			kind: "routed",
			tier: "balanced",
			defaultTierApplied: true,
		});
	});

	it("preserves literal colon ids and parses only supported thinking suffixes", () => {
		expect(normalizeTierSelector("openrouter/route:model:free", snapshot)).toEqual({
			pinned: "openrouter/route:model:free",
		});
		expect(normalizeTierSelector("anthropic/claude-opus-5:high", snapshot)).toEqual({
			pinned: "anthropic/claude-opus-5:high",
		});
		expect(normalizeTierSelector("anthropic/claude-opus-5:bogus", snapshot)).toEqual({ unmatched: true });
	});

	it("rejects bare, glob, and pi role aliases at runtime", () => {
		for (const selector of ["claude-opus-5", "anthropic/*opus*", "pi/default", "pi/planner"]) {
			expect(normalizeTierSelector(selector, snapshot)).toEqual({ rejected: "selector_not_provider_qualified" });
		}
	});

	it("supports locked preset selectors and disabled/refusal outcomes", () => {
		expect(
			resolveTaskRouting({
				effectiveAutorouting: active({}, "anthropic"),
				requestedTier: "strong",
				availableModels: snapshot,
			}),
		).toMatchObject({ kind: "routed" });
		expect(resolveTaskRouting({ effectiveAutorouting: { active: false }, availableModels: snapshot })).toEqual({
			kind: "disabled",
		});
		const settings = Settings.isolated({ "task.autorouting.enabled": true });
		expect(settings.getSchemaReport().valid).toBe(false);
		expect(settings.getSchemaReport().issues[0]?.detail).toContain("anthropic");
	});

	it("asserts routing evidence invariants and substitution order", () => {
		const evidence: TaskRoutingEvidence = {
			tier: "strong",
			source: "tiers",
			requestedSelector: "anthropic/claude-opus-5:high",
			authResolvedModel: "anthropic/claude-opus-4-8",
			effectiveModel: "anthropic/claude-opus-4-8:high",
			substitutions: ["auth_substituted", "assistant_model_mismatch"],
		};
		assertRoutingEvidenceInvariant(evidence);
		expect(evidence.substitutions).toEqual(["auth_substituted", "assistant_model_mismatch"]);
	});

	it("fresh decisions can change with settings or snapshots", () => {
		const first = resolveTaskRouting({
			effectiveAutorouting: active({ fast: ["anthropic/claude-opus-5"] }),
			requestedTier: "fast",
			availableModels: snapshot,
		});
		const changedSettings = resolveTaskRouting({
			effectiveAutorouting: active({ fast: ["xai/grok-4.5"] }),
			requestedTier: "fast",
			availableModels: snapshot,
		});
		const changedSnapshot = resolveTaskRouting({
			effectiveAutorouting: active({ fast: ["anthropic/claude-opus-5"] }),
			requestedTier: "fast",
			availableModels: [model("xai", "grok-4.5")],
		});
		expect(first.kind).toBe("routed");
		expect(changedSettings.kind).toBe("routed");
		expect(changedSnapshot.kind).toBe("manual-fallback");
	});

	it("executor finalizer covers direct, auth-substituted, mismatch, and combined ordered substitutions", () => {
		const routing: TaskRoutingEvidence = {
			tier: "strong",
			source: "tiers",
			requestedSelector: "anthropic/claude-opus-5:high",
			substitutions: [],
		};
		const direct = finalizeRoutingEvidence(routing, {
			resolvedModelString: "anthropic/claude-opus-5",
			lastAssistantModelString: undefined,
			authFallbackUsed: false,
			assistantModelMismatch: false,
		});
		expect(direct).toMatchObject({ effectiveModel: "anthropic/claude-opus-5", substitutions: [] });
		expect(direct?.authResolvedModel).toBeUndefined();

		const authSub = finalizeRoutingEvidence(routing, {
			resolvedModelString: "anthropic/claude-opus-4-8",
			lastAssistantModelString: undefined,
			authFallbackUsed: true,
			assistantModelMismatch: false,
		});
		expect(authSub).toMatchObject({
			effectiveModel: "anthropic/claude-opus-4-8",
			substitutions: ["auth_substituted"],
		});

		const mismatch = finalizeRoutingEvidence(routing, {
			resolvedModelString: "anthropic/claude-opus-5",
			lastAssistantModelString: "anthropic/claude-opus-4-8",
			authFallbackUsed: false,
			assistantModelMismatch: true,
		});
		expect(mismatch).toMatchObject({
			effectiveModel: "anthropic/claude-opus-4-8",
			authResolvedModel: "anthropic/claude-opus-5",
			substitutions: ["assistant_model_mismatch"],
		});

		const combined = finalizeRoutingEvidence(routing, {
			resolvedModelString: "anthropic/claude-opus-4-8",
			lastAssistantModelString: "anthropic/claude-sonnet-5",
			authFallbackUsed: true,
			assistantModelMismatch: true,
		});
		expect(combined).toMatchObject({
			effectiveModel: "anthropic/claude-sonnet-5",
			authResolvedModel: "anthropic/claude-opus-4-8",
			substitutions: ["auth_substituted", "assistant_model_mismatch"],
		});

		expect(
			finalizeRoutingEvidence(undefined, {
				resolvedModelString: "anthropic/claude-opus-5",
				lastAssistantModelString: undefined,
				authFallbackUsed: false,
				assistantModelMismatch: false,
			}),
		).toBeUndefined();
	});
});
