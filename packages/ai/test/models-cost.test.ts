import { describe, expect, it } from "bun:test";
import { calculateCost, getBundledModel } from "../src/models";
import modelsJson from "../src/models.json" with { type: "json" };
import { handleMetadata } from "../src/providers/amazon-bedrock";
import { applyAnthropicUsageExtras } from "../src/providers/anthropic";
import { populateResponsesUsageFromResponse } from "../src/providers/openai-responses-shared";
import type { AssistantMessage, Model, Usage } from "../src/types";

describe("calculateCost", () => {
	it("keeps token-based calculation for GitHub Copilot models", () => {
		const model = {
			...getBundledModel("github-copilot", "gpt-4o"),
			cost: {
				input: 1000,
				output: 2000,
				cacheRead: 500,
				cacheWrite: 800,
			},
		};
		const usage: Usage = {
			input: 1000,
			output: 500,
			cacheRead: 200,
			cacheWrite: 100,
			totalTokens: 1800,
			cost: {
				input: 123,
				output: 456,
				cacheRead: 789,
				cacheWrite: 321,
				total: 1689,
			},
		};

		calculateCost(model, usage);

		expect(usage.cost.input).toBeCloseTo(1, 8);
		expect(usage.cost.output).toBeCloseTo(1, 8);
		expect(usage.cost.cacheRead).toBeCloseTo(0.1, 8);
		expect(usage.cost.cacheWrite).toBeCloseTo(0.08, 8);
		expect(usage.cost.total).toBeCloseTo(2.18, 8);
	});

	it("keeps token-based calculation for non-Copilot providers", () => {
		const model = {
			...getBundledModel("openai", "gpt-4o-mini"),
			cost: {
				input: 1000,
				output: 2000,
				cacheRead: 500,
				cacheWrite: 800,
			},
		};
		const usage: Usage = {
			input: 1000,
			output: 500,
			cacheRead: 200,
			cacheWrite: 100,
			totalTokens: 1800,
			cost: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				total: 0,
			},
		};

		calculateCost(model, usage);

		expect(usage.cost.input).toBeCloseTo(1, 8);
		expect(usage.cost.output).toBeCloseTo(1, 8);
		expect(usage.cost.cacheRead).toBeCloseTo(0.1, 8);
		expect(usage.cost.cacheWrite).toBeCloseTo(0.08, 8);
		expect(usage.cost.total).toBeCloseTo(2.18, 8);
	});

	it("bundles and calculates Cursor Composer pricing", () => {
		const expectedPricing = [
			{
				id: "composer-2.5",
				cost: { input: 0.5, output: 2.5, cacheRead: 0, cacheWrite: 0 },
				total: 0.00175,
			},
			{
				id: "composer-2.5-fast",
				cost: { input: 3, output: 15, cacheRead: 0, cacheWrite: 0 },
				total: 0.0105,
			},
		] as const;

		for (const expected of expectedPricing) {
			const model = getBundledModel("cursor", expected.id);
			const usage: Usage = {
				input: 1_000,
				output: 500,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 1_500,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			};

			expect(model.cost).toEqual(expected.cost);
			calculateCost(model, usage);
			expect(usage.cost.total).toBeCloseTo(expected.total, 8);
		}
	});

	it("ignores non-canonical long-context pricing", () => {
		const model = {
			...getBundledModel("openai", "gpt-4o-mini"),
			cost: { input: 1000, output: 2000, cacheRead: 500, cacheWrite: 800 },
			longContextPricing: {
				threshold: 1,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			},
		};
		const usage: Usage = {
			input: 1000,
			output: 500,
			cacheRead: 200,
			cacheWrite: 100,
			totalTokens: 1800,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		};

		calculateCost(model, usage);

		expect(usage.cost.total).toBeCloseTo(2.18, 8);
	});

	it("bundles the direct Haiku 5.5 long-context price tier", () => {
		const rawCatalog = modelsJson as unknown as Record<string, Record<string, Model>>;
		const expected = {
			threshold: 100_000,
			cost: { input: 0.5, output: 2.5, cacheRead: 0.05, cacheWrite: 0.625 },
		};
		const model = getBundledModel("anthropic", "claude-haiku-5-5");

		expect(rawCatalog.anthropic?.["claude-haiku-5-5"]?.longContextPricing).toEqual(expected);
		expect(model.longContextPricing).toEqual(expected);
	});

	it("bundles a Bedrock Haiku 5.5 long-context tier at 5x each profile's own rates", () => {
		for (const id of [
			"anthropic.claude-haiku-5-5",
			"au.anthropic.claude-haiku-5-5",
			"eu.anthropic.claude-haiku-5-5",
			"global.anthropic.claude-haiku-5-5",
			"jp.anthropic.claude-haiku-5-5",
			"us.anthropic.claude-haiku-5-5",
		]) {
			const model = getBundledModel("amazon-bedrock", id as never);
			expect(model.longContextPricing?.threshold).toBe(100_000);
			for (const key of ["input", "output", "cacheRead", "cacheWrite"] as const) {
				expect(model.longContextPricing?.cost[key]).toBeCloseTo(model.cost[key] * 5, 9);
			}
		}
	});

	it("bills Bedrock Haiku 5.5 at long-context rates only above 100K total prompt tokens", () => {
		const model = getBundledModel("amazon-bedrock", "us.anthropic.claude-haiku-5-5" as never);
		const usage = (input: number, cacheRead: number): Usage => ({
			input,
			output: 1_000,
			cacheRead,
			cacheWrite: 0,
			totalTokens: input + cacheRead + 1_000,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		});
		const atThreshold = usage(100_000, 0);
		const aboveThreshold = usage(80_000, 20_001);

		calculateCost(model, atThreshold);
		calculateCost(model, aboveThreshold);

		expect(atThreshold.cost.input).toBeCloseTo(0.011, 9);
		expect(aboveThreshold.cost.input).toBeCloseTo(0.044, 9);
		expect(aboveThreshold.cost.output).toBeCloseTo(0.00275, 9);
		expect(aboveThreshold.cost.cacheRead).toBeCloseTo(0.001100055, 9);
	});

	it("applies Haiku 5.5 long-context rates only above 100K total prompt tokens", () => {
		const model = getBundledModel("anthropic", "claude-haiku-5-5");
		const usage = (input: number, cacheRead: number, cacheWrite: number): Usage => ({
			input,
			output: 1_000,
			cacheRead,
			cacheWrite,
			totalTokens: input + cacheRead + cacheWrite + 1_000,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		});
		const atThreshold = usage(100_000, 0, 0);
		const aboveThreshold = usage(80_000, 20_000, 1);

		calculateCost(model, atThreshold);
		calculateCost(model, aboveThreshold);

		expect(atThreshold.cost).toEqual({
			input: 0.01,
			output: 0.0005,
			cacheRead: 0,
			cacheWrite: 0,
			total: 0.0105,
		});
		expect(aboveThreshold.cost.input).toBeCloseTo(0.04, 12);
		expect(aboveThreshold.cost.output).toBeCloseTo(0.0025, 12);
		expect(aboveThreshold.cost.cacheRead).toBeCloseTo(0.001, 12);
		expect(aboveThreshold.cost.cacheWrite).toBeCloseTo(0.000000625, 12);
		expect(aboveThreshold.cost.total).toBeCloseTo(0.043500625, 12);
	});

	it("bills Haiku 5.5 1-hour cache writes at the 1-hour rate in both prompt tiers", () => {
		const model = getBundledModel("anthropic", "claude-haiku-5-5");
		const usageWith = (input: number, cacheWrite: number, ephemeral1h?: number): Usage => ({
			input,
			output: 0,
			cacheRead: 0,
			cacheWrite,
			totalTokens: input + cacheWrite,
			...(ephemeral1h === undefined ? {} : { cttl: { ephemeral1h, ephemeral5m: cacheWrite - ephemeral1h } }),
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		});
		// 150K 1-hour writes in a 200K prompt: above the 100K tier at $1/MTok.
		const long = usageWith(50_000, 150_000, 150_000);
		calculateCost(model, long);
		expect(long.cost.cacheWrite).toBeCloseTo(0.15, 12);
		// 80K 1-hour writes in a prompt at or below 100K: $0.20/MTok.
		const short = usageWith(10_000, 80_000, 80_000);
		calculateCost(model, short);
		expect(short.cost.cacheWrite).toBeCloseTo(0.016, 12);
		// A mixed split bills each component at its own rate.
		const mixed = usageWith(50_000, 150_000, 100_000);
		calculateCost(model, mixed);
		expect(mixed.cost.cacheWrite).toBeCloseTo(0.1 + 0.03125, 12);
		// No TTL breakdown reported: fall back to the 5-minute cache-write rate.
		const unsplit = usageWith(50_000, 150_000);
		calculateCost(model, unsplit);
		expect(unsplit.cost.cacheWrite).toBeCloseTo(0.09375, 12);
	});

	it("prices Haiku 5.5 usage reported by the Anthropic provider end to end", () => {
		const model = getBundledModel("anthropic", "claude-haiku-5-5");
		const usage: Usage = {
			input: 50_000,
			output: 0,
			cacheRead: 0,
			cacheWrite: 150_000,
			totalTokens: 200_000,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		};
		applyAnthropicUsageExtras(usage, {
			cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 150_000 },
		} as never);
		calculateCost(model, usage);
		expect(usage.cttl).toEqual({ ephemeral1h: 150_000 });
		expect(usage.cost.cacheWrite).toBeCloseTo(0.15, 12);
	});

	it("bills Bedrock Haiku 5.5 usage from Converse metadata, using the 1-hour rate for long retention", () => {
		const model = getBundledModel("amazon-bedrock", "us.anthropic.claude-haiku-5-5" as never);
		const fresh = (): AssistantMessage =>
			({
				usage: {
					input: 0,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 0,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
			}) as AssistantMessage;
		const metadata = {
			usage: { inputTokens: 50_000, outputTokens: 0, cacheWriteInputTokens: 150_000, totalTokens: 200_000 },
		};

		const long = fresh();
		handleMetadata(metadata as never, model as never, long, "long");
		expect(long.usage.cttl).toEqual({ ephemeral1h: 150_000 });
		// 200K prompt tier: 2 x (5 x $0.11) = $1.10/MTok.
		expect(long.usage.cost.cacheWrite).toBeCloseTo(0.165, 9);

		const short = fresh();
		handleMetadata(metadata as never, model as never, short, "short");
		expect(short.usage.cttl).toBeUndefined();
		// 5-minute rate in the long tier: 5 x $0.1375 = $0.6875/MTok.
		expect(short.usage.cost.cacheWrite).toBeCloseTo(0.103125, 9);

		// Models without a per-TTL rate never get a TTL split attached.
		const other = fresh();
		handleMetadata(
			metadata as never,
			getBundledModel("amazon-bedrock", "us.anthropic.claude-haiku-4-5-20251001-v1:0" as never) as never,
			other,
			"long",
		);
		expect(other.usage.cttl).toBeUndefined();
	});

	it("holds seeded Bedrock Haiku 5.5 pricing properties over generated token partitions", () => {
		let state = 0x5eed_6874;
		const rand = (max: number): number => {
			state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
			return Math.floor((state / 0x1_0000_0000) * max);
		};
		const ids = [
			"anthropic.claude-haiku-5-5",
			"au.anthropic.claude-haiku-5-5",
			"eu.anthropic.claude-haiku-5-5",
			"global.anthropic.claude-haiku-5-5",
			"jp.anthropic.claude-haiku-5-5",
			"us.anthropic.claude-haiku-5-5",
		];
		const near = [0, 1, 99_999, 100_000, 100_001, 500_000];
		const fresh = (): AssistantMessage =>
			({
				usage: {
					input: 0,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 0,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
			}) as AssistantMessage;
		const round = (x: number): number => Math.round(x * 1e9) / 1e9;
		for (const id of ids) {
			const model = getBundledModel("amazon-bedrock", id as never);
			for (let i = 0; i < 100; i++) {
				const input = i % 3 === 0 ? near[rand(near.length)]! : rand(300_000);
				const cacheRead = rand(200_000);
				const cacheWrite = rand(200_000);
				const output = rand(10_000);
				const retention = i % 2 === 0 ? "long" : "short";
				const message = fresh();
				handleMetadata(
					{
						usage: {
							inputTokens: input,
							outputTokens: output,
							cacheReadInputTokens: cacheRead,
							cacheWriteInputTokens: cacheWrite,
							totalTokens: input + output + cacheRead + cacheWrite,
						},
					} as never,
					model as never,
					message,
					retention,
				);
				const u = message.usage;
				// The tier counts input + cache reads + cache writes, and the boundary is exclusive.
				const long = input + cacheRead + cacheWrite > 100_000;
				const m = long ? 5 : 1;
				// Rates stay profile-specific: scale the profile's own catalog rates.
				const rate = {
					i: round(model.cost.input * m),
					o: round(model.cost.output * m),
					r: round(model.cost.cacheRead * m),
					w5: round(model.cost.cacheWrite * m),
					w1: round(2 * model.cost.input * m),
				};
				// Long retention tags every write as 1-hour; short retention bills the 5-minute rate.
				const w = retention === "long" ? rate.w1 : rate.w5;
				expect(u.cost.input).toBeCloseTo((rate.i * input) / 1e6, 9);
				expect(u.cost.output).toBeCloseTo((rate.o * output) / 1e6, 9);
				expect(u.cost.cacheRead).toBeCloseTo((rate.r * cacheRead) / 1e6, 9);
				expect(u.cost.cacheWrite).toBeCloseTo((w * cacheWrite) / 1e6, 9);
				// TTL-weighted components sum to the total.
				expect(u.cost.total).toBeCloseTo(u.cost.input + u.cost.output + u.cost.cacheRead + u.cost.cacheWrite, 12);
				if (retention === "long" && cacheWrite > 0) expect(u.cttl).toEqual({ ephemeral1h: cacheWrite });
				else expect(u.cttl).toBeUndefined();
			}
		}
		// Profile-specific: regional profiles carry the 10% premium over unprefixed and global.
		const base = getBundledModel("amazon-bedrock", "anthropic.claude-haiku-5-5" as never);
		const regional = getBundledModel("amazon-bedrock", "us.anthropic.claude-haiku-5-5" as never);
		expect(regional.cost.input).toBeGreaterThan(base.cost.input);
		expect(regional.longContextPricing?.cost.input).toBeGreaterThan(base.longContextPricing?.cost.input ?? 0);
	});

	it("holds seeded Haiku 5.5 pricing properties over generated token partitions", () => {
		let state = 0x5eed_6872;
		const rand = (max: number): number => {
			state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
			return Math.floor((state / 0x1_0000_0000) * max);
		};
		const haiku55 = getBundledModel("anthropic", "claude-haiku-5-5");
		const haiku45 = getBundledModel("anthropic", "claude-haiku-4-5");
		const sonnet = getBundledModel("anthropic", "claude-sonnet-5-5");
		const near = [0, 1, 99_999, 100_000, 100_001, 500_000];
		for (let i = 0; i < 200; i++) {
			const input = i % 3 === 0 ? near[rand(near.length)]! : rand(300_000);
			const cacheRead = rand(200_000);
			const cacheWrite = rand(200_000);
			const oneHour = rand(cacheWrite + 1);
			const mk = (withSplit: boolean): Usage => ({
				input,
				output: rand(10_000),
				cacheRead,
				cacheWrite,
				totalTokens: input + cacheRead + cacheWrite,
				...(withSplit ? { cttl: { ephemeral1h: oneHour, ephemeral5m: cacheWrite - oneHour } } : {}),
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			});
			const total = input + cacheRead + cacheWrite;
			const tier = total > 100_000;
			const usage = mk(true);
			calculateCost(haiku55, usage);
			// Tier selection counts input, cache reads and cache writes; the boundary is exclusive.
			const rate = tier
				? { i: 0.5, o: 2.5, r: 0.05, w5: 0.625, w1: 1 }
				: { i: 0.1, o: 0.5, r: 0.01, w5: 0.125, w1: 0.2 };
			expect(usage.cost.input).toBeCloseTo((rate.i * input) / 1e6, 9);
			expect(usage.cost.output).toBeCloseTo((rate.o * usage.output) / 1e6, 9);
			expect(usage.cost.cacheRead).toBeCloseTo((rate.r * cacheRead) / 1e6, 9);
			expect(usage.cost.cacheWrite).toBeCloseTo((rate.w5 * (cacheWrite - oneHour) + rate.w1 * oneHour) / 1e6, 9);
			expect(usage.cost.total).toBeCloseTo(
				usage.cost.input + usage.cost.output + usage.cost.cacheRead + usage.cost.cacheWrite,
				12,
			);
			// Without a TTL split every write token is billed at the 5-minute rate.
			const unsplit = mk(false);
			calculateCost(haiku55, unsplit);
			expect(unsplit.cost.cacheWrite).toBeCloseTo((rate.w5 * cacheWrite) / 1e6, 9);
			// Other models never pick up Haiku 5.5's tier or 1-hour rate.
			for (const other of [haiku45, sonnet]) {
				const u = mk(true);
				calculateCost(other, u);
				expect(u.cost.cacheWrite).toBeCloseTo((other.cost.cacheWrite * cacheWrite) / 1e6, 9);
				expect(u.cost.input).toBeCloseTo((other.cost.input * input) / 1e6, 9);
			}
		}
	});

	it("prices OpenAI Codex GPT models from the matching OpenAI catalog entry", () => {
		const openAIModel = getBundledModel("openai", "gpt-5.4");
		const codexModel = getBundledModel("openai-codex", "gpt-5.4");
		const usage: Usage = {
			input: 1000,
			output: 500,
			cacheRead: 200,
			cacheWrite: 0,
			totalTokens: 1700,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		};

		expect(codexModel.cost).toEqual(openAIModel.cost);

		calculateCost(codexModel, usage);

		expect(usage.cost.total).toBeCloseTo(0.01005, 8);
	});

	it("bundles the current OpenAI Standard prices for the GPT-5.6 family", () => {
		const rawCatalog = modelsJson as Record<string, Record<string, Model>>;
		const expectedPricing = [
			{
				id: "gpt-5.6",
				short: { input: 5, output: 30, cacheRead: 0.5, cacheWrite: 6.25 },
				long: { input: 10, output: 45, cacheRead: 1, cacheWrite: 12.5 },
			},
			{
				id: "gpt-5.6-sol",
				short: { input: 5, output: 30, cacheRead: 0.5, cacheWrite: 6.25 },
				long: { input: 10, output: 45, cacheRead: 1, cacheWrite: 12.5 },
			},
			{
				id: "gpt-5.6-terra",
				short: { input: 2, output: 12, cacheRead: 0.2, cacheWrite: 2.5 },
				long: { input: 4, output: 18, cacheRead: 0.4, cacheWrite: 5 },
			},
			{
				id: "gpt-5.6-luna",
				short: { input: 0.2, output: 1.2, cacheRead: 0.02, cacheWrite: 0.25 },
				long: { input: 0.4, output: 1.8, cacheRead: 0.04, cacheWrite: 0.5 },
			},
		] as const;

		for (const expected of expectedPricing) {
			const openAIModel = getBundledModel("openai", expected.id);

			expect(rawCatalog.openai?.[expected.id]?.cost).toEqual(expected.short);
			expect(rawCatalog.openai?.[expected.id]?.longContextPricing).toEqual({
				threshold: 272_000,
				cost: expected.long,
			});
			expect(openAIModel.cost).toEqual(expected.short);
			expect(openAIModel.longContextPricing).toEqual({
				threshold: 272_000,
				cost: expected.long,
			});
			if (expected.id !== "gpt-5.6") {
				const codexModel = getBundledModel("openai-codex", expected.id);
				expect(rawCatalog["openai-codex"]?.[expected.id]?.cost).toEqual(expected.short);
				expect(rawCatalog["openai-codex"]?.[expected.id]?.longContextPricing).toEqual({
					threshold: 272_000,
					cost: expected.long,
				});
				expect(codexModel.cost).toEqual(openAIModel.cost);
				expect(codexModel.longContextPricing).toEqual(openAIModel.longContextPricing);
			}
		}
	});

	it("bundles GPT-6 Astra standard and long-context pricing", () => {
		const model = getBundledModel("openai-codex", "gpt-6-astra");

		expect(model.cost).toEqual({ input: 10, output: 50, cacheRead: 1, cacheWrite: 12.5 });
		expect(model.longContextPricing).toEqual({
			threshold: 272_000,
			cost: { input: 20, output: 75, cacheRead: 2, cacheWrite: 25 },
		});
	});

	it("bundles GPT-6 Sol family standard and long-context pricing", () => {
		const sol = getBundledModel("openai-codex", "gpt-6-sol");
		expect(sol.cost).toEqual({ input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 });
		expect(sol.longContextPricing).toEqual({
			threshold: 272_000,
			cost: { input: 4, output: 15, cacheRead: 0.4, cacheWrite: 5 },
		});

		const sol61 = getBundledModel("openai-codex", "gpt-6.1-sol");
		expect(sol61.cost).toEqual({ input: 2, output: 10, cacheRead: 0.1, cacheWrite: 2.5 });
		expect(sol61.longContextPricing).toEqual({
			threshold: 272_000,
			cost: { input: 4, output: 15, cacheRead: 0.2, cacheWrite: 5 },
		});

		const luna = getBundledModel("openai-codex", "gpt-6-luna");
		expect(luna.cost).toEqual({ input: 0.1, output: 0.5, cacheRead: 0.01, cacheWrite: 0.125 });
		expect(luna.longContextPricing).toEqual({
			threshold: 272_000,
			cost: { input: 0.2, output: 0.75, cacheRead: 0.02, cacheWrite: 0.25 },
		});
	});

	it("switches GPT-6 Sol pricing only above 272K input tokens", () => {
		const model = getBundledModel("openai-codex", "gpt-6-sol");
		const usage = (cacheWrite: number): Usage => ({
			input: 200_000,
			output: 1_000,
			cacheRead: 72_000,
			cacheWrite,
			totalTokens: 273_000 + cacheWrite,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		});
		const threshold = usage(0);
		const aboveThreshold = usage(1);

		calculateCost(model, threshold);
		calculateCost(model, aboveThreshold);

		// 200K input @ $2 + 1K output @ $10 + 72K cacheRead @ $0.20
		expect(threshold.cost.total).toBeCloseTo(0.4244, 8);
		// same request one cache-write token past the threshold, at 2x/1.5x rates
		expect(aboveThreshold.cost.total).toBeCloseTo(0.843805, 8);
	});

	it("switches GPT-6 Astra pricing only above 272K input tokens", () => {
		const model = getBundledModel("openai-codex", "gpt-6-astra");
		const usage = (cacheWrite: number): Usage => ({
			input: 200_000,
			output: 1_000,
			cacheRead: 72_000,
			cacheWrite,
			totalTokens: 273_000 + cacheWrite,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		});
		const threshold = usage(0);
		const aboveThreshold = usage(1);

		calculateCost(model, threshold);
		calculateCost(model, aboveThreshold);

		expect(threshold.cost.total).toBeCloseTo(2.122, 8);
		expect(aboveThreshold.cost.total).toBeCloseTo(4.219025, 8);
	});

	it("keeps GPT-5.6 short-context pricing at exactly 272K input tokens", () => {
		const model = getBundledModel("openai", "gpt-5.6-terra");
		const usage: Usage = {
			input: 200_000,
			output: 1_000,
			cacheRead: 72_000,
			cacheWrite: 0,
			totalTokens: 273_000,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		};

		calculateCost(model, usage);

		expect(usage.cost.input).toBeCloseTo(0.4, 8);
		expect(usage.cost.output).toBeCloseTo(0.012, 8);
		expect(usage.cost.cacheRead).toBeCloseTo(0.0144, 8);
		expect(usage.cost.total).toBeCloseTo(0.4264, 8);
	});

	it("prices the full GPT-5.6 request at long-context rates above 272K input tokens", () => {
		const model = getBundledModel("openai", "gpt-5.6-terra");
		const usage: Usage = {
			input: 200_000,
			output: 1_000,
			cacheRead: 72_000,
			cacheWrite: 1,
			totalTokens: 273_001,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		};

		calculateCost(model, usage);

		expect(usage.cost.input).toBeCloseTo(0.8, 8);
		expect(usage.cost.output).toBeCloseTo(0.018, 8);
		expect(usage.cost.cacheRead).toBeCloseTo(0.0288, 8);
		expect(usage.cost.cacheWrite).toBeCloseTo(0.000005, 8);
		expect(usage.cost.total).toBeCloseTo(0.846805, 8);
	});

	it("attributes OpenAI Responses cache-write tokens to their billable bucket", () => {
		const output: AssistantMessage = {
			role: "assistant",
			content: [],
			api: "openai-responses",
			provider: "openai",
			model: "gpt-5.6-terra",
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop",
			timestamp: 0,
		};

		populateResponsesUsageFromResponse(output, {
			input_tokens: 272_001,
			output_tokens: 1_000,
			total_tokens: 273_001,
			input_tokens_details: { cached_tokens: 72_000, cache_write_tokens: 1 },
		});

		expect(output.usage.input).toBe(200_000);
		expect(output.usage.cacheRead).toBe(72_000);
		expect(output.usage.cacheWrite).toBe(1);

		populateResponsesUsageFromResponse(output, {
			input_tokens: 10,
			output_tokens: 0,
			total_tokens: 10,
			input_tokens_details: { cache_write_tokens: -1 },
		});
		expect(output.usage.input).toBe(10);
		expect(output.usage.cacheWrite).toBe(0);
	});

	it("switches OpenRouter GPT-6 Sol pricing only above 272K input tokens", () => {
		const model = getBundledModel("openrouter", "openai/gpt-6-sol");
		const usage = (cacheWrite: number): Usage => ({
			input: 200_000,
			output: 1_000,
			cacheRead: 72_000,
			cacheWrite,
			totalTokens: 273_000 + cacheWrite,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		});
		const threshold = usage(0);
		const aboveThreshold = usage(1);

		calculateCost(model, threshold);
		calculateCost(model, aboveThreshold);

		// 200K input @ $2 + 1K output @ $10 + 72K cacheRead @ $0.20
		expect(threshold.cost.total).toBeCloseTo(0.4244, 8);
		// same request one cache-write token past the threshold, at 2x/1.5x rates
		expect(aboveThreshold.cost.total).toBeCloseTo(0.843805, 8);
	});

	it("switches OpenRouter GPT-6 Astra pricing only above 272K input tokens", () => {
		const model = getBundledModel("openrouter", "openai/gpt-6-astra");
		const usage = (cacheWrite: number): Usage => ({
			input: 200_000,
			output: 1_000,
			cacheRead: 72_000,
			cacheWrite,
			totalTokens: 273_000 + cacheWrite,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		});
		const threshold = usage(0);
		const aboveThreshold = usage(1);

		calculateCost(model, threshold);
		calculateCost(model, aboveThreshold);

		expect(threshold.cost.total).toBeCloseTo(2.122, 8);
		expect(aboveThreshold.cost.total).toBeCloseTo(4.219025, 8);
	});

	it("switches OpenRouter GPT-6 Luna pricing only above 272K input tokens", () => {
		const model = getBundledModel("openrouter", "openai/gpt-6-luna");
		const usage = (cacheWrite: number): Usage => ({
			input: 200_000,
			output: 1_000,
			cacheRead: 72_000,
			cacheWrite,
			totalTokens: 273_000 + cacheWrite,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		});
		const threshold = usage(0);
		const aboveThreshold = usage(1);

		calculateCost(model, threshold);
		calculateCost(model, aboveThreshold);

		expect(threshold.cost.total).toBeCloseTo(0.02122, 8);
		expect(aboveThreshold.cost.total).toBeCloseTo(0.04219025, 8);
	});

	it("switches OpenRouter GPT-5.6 Sol pricing only above 272K input tokens", () => {
		const model = getBundledModel("openrouter", "openai/gpt-5.6-sol");
		const usage = (cacheWrite: number): Usage => ({
			input: 200_000,
			output: 1_000,
			cacheRead: 72_000,
			cacheWrite,
			totalTokens: 273_000 + cacheWrite,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		});
		const threshold = usage(0);
		const aboveThreshold = usage(1);

		calculateCost(model, threshold);
		calculateCost(model, aboveThreshold);

		// 200K input @ $5 + 1K output @ $30 + 72K cacheRead @ $0.50 (OpenAI's tier pair)
		expect(threshold.cost.total).toBeCloseTo(1.066, 8);
		// above 272K: 200K @ $10 + 1K @ $45 + 72K @ $1 + 1 @ $12.5
		expect(aboveThreshold.cost.total).toBeCloseTo(2.1170125, 8);
	});

	it("preserves OpenRouter long-context tier through discovery and normalization", () => {
		// Fixture: OpenRouter discovery response for gpt-6-sol:batch with pricing.overrides
		// This simulates the real OpenRouter /api/v1/models response structure.
		const discoveredModel: Model<"openai-completions"> = {
			id: "openai/gpt-6-sol:batch",
			name: "GPT-6 Sol Batch",
			api: "openai-completions",
			provider: "openrouter",
			baseUrl: "https://openrouter.ai/api/v1",
			reasoning: false,
			input: ["text"],
			cost: {
				// OpenRouter's actual base rates for gpt-6-sol:batch
				input: 1_000_000,
				output: 5_000_000,
				cacheRead: 100_000,
				cacheWrite: 1_250_000,
			},
			contextWindow: 128_000,
			maxTokens: 4_096,
			longContextPricing: {
				threshold: 272_000,
				// OpenRouter's actual long-context rates for gpt-6-sol:batch at 272K+ tokens
				cost: {
					input: 2_000_000,
					output: 7_500_000,
					cacheRead: 200_000,
					cacheWrite: 2_500_000,
				},
			},
		};

		const usage = (cacheWrite: number): Usage => ({
			input: 200_000,
			output: 1_000,
			cacheRead: 72_000,
			cacheWrite,
			totalTokens: 273_000 + cacheWrite,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		});

		const threshold = usage(0);
		const aboveThreshold = usage(1);

		calculateCost(discoveredModel, threshold);
		calculateCost(discoveredModel, aboveThreshold);

		// Below 272K: 200K input @ $1/M + 1K output @ $5/M + 72K cacheRead @ $0.1/M
		expect(threshold.cost.total).toBeCloseTo(0.2072, 7);
		// Above 272K: 200K @ $2/M + 1K @ $7.5/M + 72K @ $0.2/M + 1 @ $2.5/M
		expect(aboveThreshold.cost.total).toBeCloseTo(0.414501, 7);
	});
});
