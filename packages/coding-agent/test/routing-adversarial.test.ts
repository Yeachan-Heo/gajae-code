import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { Usage } from "@gajae-code/ai";
import { classifyFallbackTrigger } from "@gajae-code/ai/utils/fallback-transport";
import { ModelRegistry } from "@gajae-code/coding-agent/config/model-registry";
import { resetSettingsForTest, Settings, settings } from "@gajae-code/coding-agent/config/settings";
import { AuthStorage } from "@gajae-code/coding-agent/session/auth-storage";
import {
	buildCacheBehaviorWarning,
	computeCacheMissCostSummary,
} from "@gajae-code/coding-agent/session/cache-economics";
import {
	cappedExponentialWithFullJitter,
	effectiveFallbackDelay,
	FallbackChainController,
} from "@gajae-code/coding-agent/session/fallback-chain-controller";

const THREE_HOURS_MS = 3 * 60 * 60 * 1_000;
const zeroPriceUsage: Usage = {
	input: 20_000,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 20_000,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

describe("routing adversarial contract probes", () => {
	let root: string;
	let authStorage: AuthStorage;
	let previousXaiKey: string | undefined;

	beforeEach(async () => {
		resetSettingsForTest();
		await Settings.init({ inMemory: true });
		root = fs.mkdtempSync(path.join(os.tmpdir(), "gjc-routing-adversarial-"));
		authStorage = await AuthStorage.create(path.join(root, "auth.db"));
		previousXaiKey = process.env.XAI_API_KEY;
		delete process.env.XAI_API_KEY;
	});

	afterEach(() => {
		if (previousXaiKey === undefined) delete process.env.XAI_API_KEY;
		else process.env.XAI_API_KEY = previousXaiKey;
		authStorage.close();
		fs.rmSync(root, { recursive: true, force: true });
		resetSettingsForTest();
	});

	test("does not turn hostile plan-limit prose into a retryable transport class", () => {
		expect(classifyFallbackTrigger(new Error("your plan allows 500 requests"))).toEqual({ class: "other" });
		expect(classifyFallbackTrigger({ kind: "transport", status: 429 })).toEqual({ class: "rate_limit" });
	});

	test("keeps legacy backoff capped while managed retry-after remains intentionally uncapped", () => {
		expect(cappedExponentialWithFullJitter(100, 1_000, 10, () => 1)).toBe(1_000);
		expect(Math.min(THREE_HOURS_MS, 1_000)).toBe(1_000);
		expect(effectiveFallbackDelay(100, 1_000, 1, THREE_HOURS_MS, () => 1)).toBe(THREE_HOURS_MS);
	});

	test("tries a rotated Fable credential once before falling back to Opus", () => {
		const fable = "anthropic/claude-fable-5:high";
		const opus = "anthropic/claude-opus-5:high";
		const controller = new FallbackChainController(
			{ role: "default", entries: [fable, opus], origin: "test", explicitHead: true },
			3,
		);

		for (let attempt = 1; attempt <= 3; attempt += 1) {
			controller.onAttemptStarted();
			expect(controller.onAttemptFailure("quota", `Fable credential A ${attempt}`)).toBe(
				attempt < 3 ? "retry" : "advance",
			);
		}
		expect(controller.currentSelector()).toBe(opus);

		expect(controller.restorePreviousEntryForRetry()).toBe(true);
		expect(controller.currentSelector()).toBe(fable);
		expect(controller.attemptsUsed).toBe(2);
		expect(controller.totalAttemptsUsed).toBe(3);

		controller.onAttemptStarted();
		expect(controller.onAttemptFailure("quota", "Fable credential B")).toBe("advance");
		expect(controller.currentSelector()).toBe(opus);
		expect(controller.restorePreviousEntryForRetry()).toBe(false);
		expect(controller.totalAttemptsUsed).toBe(4);
		expect(controller.tried.map(failure => failure.selector)).toEqual([fable, fable, fable, fable]);
	});

	test("bounds credential rotations without starving downstream entries", () => {
		const controller = new FallbackChainController(
			{
				role: "default",
				entries: ["xai/grok", "anthropic/claude", "openai/gpt"],
				origin: "test",
				explicitHead: true,
			},
			1,
		);

		controller.onAttemptStarted();
		expect(controller.onAttemptFailure("quota", "grok credential A")).toBe("advance");
		expect(controller.restorePreviousEntryForRetry()).toBe(true);
		controller.onAttemptStarted();
		expect(controller.onAttemptFailure("quota", "grok credential B")).toBe("advance");
		expect(controller.restorePreviousEntryForRetry()).toBe(false);
		expect(controller.currentSelector()).toBe("anthropic/claude");

		controller.onAttemptStarted();
		expect(controller.onAttemptFailure("quota", "claude credential A")).toBe("advance");
		expect(controller.restorePreviousEntryForRetry()).toBe(true);
		controller.onAttemptStarted();
		expect(controller.onAttemptFailure("quota", "claude credential B")).toBe("advance");
		expect(controller.restorePreviousEntryForRetry()).toBe(false);
		expect(controller.currentSelector()).toBe("openai/gpt");

		controller.onAttemptStarted();
		expect(controller.onAttemptFailure("quota", "gpt exhausted")).toBe("exhausted");
		expect(controller.totalAttemptsUsed).toBe(5);
		expect(controller.tried).toHaveLength(5);
		expect(controller.currentSelector()).toBeUndefined();
	});

	test("invalidates availability for every auth and environment mutation while preserving identity between mutations", () => {
		const registry = new ModelRegistry(authStorage, path.join(root, "models.json"));
		const initial = registry.getAvailable();
		expect(registry.getAvailable()).toBe(initial);

		authStorage.setRuntimeApiKey("xai", "runtime-key");
		const runtime = registry.getAvailable();
		expect(runtime).not.toBe(initial);
		expect(registry.getAvailable()).toBe(runtime);

		authStorage.removeRuntimeApiKey("xai");
		const removedRuntime = registry.getAvailable();
		expect(removedRuntime).not.toBe(runtime);

		authStorage.setConfigApiKey("xai", "config-key");
		const config = registry.getAvailable();
		expect(config).not.toBe(removedRuntime);
		authStorage.removeConfigApiKey("xai");
		expect(registry.getAvailable()).not.toBe(config);

		process.env.XAI_API_KEY = "environment-key";
		const environment = registry.getAvailable();
		expect(environment.some(model => model.provider === "xai")).toBe(true);
		expect(registry.getAvailable()).toBe(environment);
		settings.setDisabledProviders(["xai"]);
		expect(registry.getAvailable().some(model => model.provider === "xai")).toBe(false);
	});

	test("computes retention write premium exactly and fails closed on non-finite persisted economics", () => {
		const summary = computeCacheMissCostSummary(
			{ input: 20_000, cacheRead: 0, cacheWrite: 10_000 },
			{ kind: "current-model-estimate", pricing: { input: 3, cacheRead: 0.3, cacheWrite: 3.75 } },
		);
		expect(summary?.missPremiumUsd).toBeCloseTo(0.0885);
		expect(
			computeCacheMissCostSummary(
				{ input: 20_000, cacheRead: 0, cacheWrite: 0 },
				{
					kind: "persisted-aggregate",
					costBreakdown: { input: Number.NaN, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
			),
		).toBeUndefined();
		expect(
			buildCacheBehaviorWarning(zeroPriceUsage, { cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } })
				?.code,
		).toBe("provider_side_cache_miss");
	});
});
