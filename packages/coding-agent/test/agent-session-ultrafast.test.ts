import { afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import * as path from "node:path";
import { Agent } from "@gajae-code/agent-core";
import type { Model, ServiceTier } from "@gajae-code/ai";
import { getBundledModel } from "@gajae-code/ai/models";
import { TempDir } from "@gajae-code/utils";
import { ModelRegistry } from "../src/config/model-registry";
import { Settings } from "../src/config/settings";
import { renderSegment, type SegmentContext } from "../src/modes/components/status-line/segments";
import { EMPTY_JOBS_SNAPSHOT } from "../src/modes/jobs-observer";
import { initTheme, theme } from "../src/modes/theme/theme";
import { AgentSession } from "../src/session/agent-session";
import { AuthStorage } from "../src/session/auth-storage";
import { SessionManager } from "../src/session/session-manager";
import { createSubagentSettings } from "../src/task/executor";

function openaiModel(supportsUltrafastTier?: boolean): Model {
	const model = getBundledModel("openai", "gpt-5.2");
	if (!model) throw new Error("Expected bundled OpenAI model");
	return { ...model, compat: { ...model.compat, supportsUltrafastTier } };
}

function context(session: AgentSession): SegmentContext {
	return {
		session,
		width: 120,
		options: { model: { showThinkingLevel: false } },
		planMode: null,
		goalMode: null,
		usageStats: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			premiumRequests: 0,
			cost: 0,
			tokensPerSecond: null,
		},
		contextPercent: 0,
		contextWindow: 0,
		autoCompactEnabled: false,
		subagentCount: 0,
		jobs: EMPTY_JOBS_SNAPSHOT,
		sessionStartTime: Date.now(),
		git: { branch: null, status: null, pr: null },
		usage: null,
	};
}

describe("ultrafast session predicate and status-line integration", () => {
	let tempDir: TempDir;
	let authStorage: AuthStorage;
	const sessions: AgentSession[] = [];

	beforeAll(async () => {
		await initTheme();
	});
	beforeEach(async () => {
		tempDir = TempDir.createSync("@pi-ultrafast-");
		authStorage = await AuthStorage.create(path.join(tempDir.path(), "auth.db"));
	});
	afterEach(async () => {
		for (const session of sessions.splice(0)) await session.dispose();
		authStorage.close();
		tempDir.removeSync();
	});

	function createSession(model: Model | undefined, settings = Settings.isolated({ "compaction.enabled": false })) {
		const tier = settings.get("serviceTier");
		const session = new AgentSession({
			agent: new Agent({
				initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] },
				serviceTier: tier === "none" ? undefined : tier,
			}),
			sessionManager: SessionManager.inMemory(),
			settings,
			modelRegistry: new ModelRegistry(authStorage),
		});
		sessions.push(session);
		return session;
	}

	for (const tier of [undefined, "priority", "flex", "openai-only"] as const) {
		it(`does not activate ultrafast for ${tier ?? "unset"} tier even on a capable model`, async () => {
			const session = createSession(openaiModel(true));
			await session.setServiceTier(tier);
			expect(session.isUltrafastActive()).toBe(false);
		});
	}

	for (const support of [undefined, false, true]) {
		it(`requires explicit model support (${String(support)}) for ultrafast`, async () => {
			const session = createSession(openaiModel(support));
			await session.setServiceTier("ultrafast");
			expect(session.isUltrafastActive()).toBe(support === true);
		});
	}

	it("does not activate ultrafast without a selected model", async () => {
		const session = createSession(undefined);
		await session.setServiceTier("ultrafast");
		expect(session.isUltrafastActive()).toBe(false);
	});

	it("re-evaluates model support after switching models without changing the tier", async () => {
		const session = createSession(openaiModel(true));
		await session.setServiceTier("ultrafast");
		expect(session.isUltrafastActive()).toBe(true);
		session.agent.setModel(openaiModel(false));
		expect(session.isUltrafastActive()).toBe(false);
		session.agent.setModel(openaiModel(true));
		expect(session.isUltrafastActive()).toBe(true);
	});

	for (const [parentTier, childTier, expected] of [
		["priority", "ultrafast", true],
		["ultrafast", "priority", false],
		["ultrafast", "none", false],
		["ultrafast", "inherit", true],
	] as const) {
		it(`uses child override ${childTier} instead of parent tier ${parentTier}`, () => {
			const settings = Settings.isolated({ serviceTier: parentTier, "task.serviceTier": childTier });
			const parent = createSession(openaiModel(true), settings);
			const child = createSession(openaiModel(true), createSubagentSettings(settings, parent.serviceTier));
			expect(child.isUltrafastActive()).toBe(expected);
			expect(parent.isUltrafastActive()).toBe(parentTier === "ultrafast");
		});
	}

	const cases: {
		name: string;
		model: Model;
		tier: ServiceTier | undefined;
		indicator: "ultrafast" | "fast" | null;
	}[] = [
		{ name: "capable OpenAI ultrafast", model: openaiModel(true), tier: "ultrafast", indicator: "ultrafast" },
		{ name: "OpenAI priority", model: openaiModel(true), tier: "priority", indicator: "fast" },
		{ name: "OpenAI without a tier", model: openaiModel(true), tier: undefined, indicator: null },
		{ name: "unsupported OpenAI ultrafast", model: openaiModel(false), tier: "ultrafast", indicator: null },
		{
			name: "Anthropic priority",
			model: getBundledModel("anthropic", "claude-sonnet-4-5")!,
			tier: "priority",
			indicator: "fast",
		},
		{
			name: "Anthropic ultrafast",
			model: getBundledModel("anthropic", "claude-sonnet-4-5")!,
			tier: "ultrafast",
			indicator: null,
		},
		{
			name: "Anthropic with OpenAI-only tier",
			model: getBundledModel("anthropic", "claude-sonnet-4-5")!,
			tier: "openai-only",
			indicator: null,
		},
	];
	for (const { name, model, tier, indicator } of cases) {
		it(`renders only the effective speed indicator for ${name}`, async () => {
			const session = createSession(model);
			const withoutIndicator = Bun.stripANSI(renderSegment("model", context(session)).content);
			await session.setServiceTier(tier);
			const rendered = renderSegment("model", context(session));
			const text = Bun.stripANSI(rendered.content);
			expect(rendered.visible).toBe(true);
			expect(session.isUltrafastActive()).toBe(indicator === "ultrafast");
			expect(text).toBe(indicator ? `${withoutIndicator} ${theme.icon[indicator]}` : withoutIndicator);
			if (indicator === "ultrafast") {
				expect(text).toContain(theme.icon.ultrafast);
			} else if (indicator === "fast") {
				expect(session.isFastModeActive()).toBe(true);
				expect(text).toContain(theme.icon.fast);
				expect(text).not.toContain(theme.icon.ultrafast);
			} else {
				expect(session.isFastModeActive()).toBe(false);
				expect(text).not.toContain(theme.icon.fast);
				expect(text).not.toContain(theme.icon.ultrafast);
			}
		});
	}
});
