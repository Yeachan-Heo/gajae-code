import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import type { AgentMessage } from "@gajae-code/agent-core";
import { resetSettingsForTest, Settings } from "../src/config/settings";
import type { ContextUsage } from "../src/extensibility/extensions/types";
import { StatusLineComponent } from "../src/modes/components/tool-status-header";
import { initTheme, theme } from "../src/modes/theme/theme";
import { computeContextBreakdown, renderContextUsage } from "../src/modes/utils/context-usage";
import type { AgentSession } from "../src/session/agent-session";
import { buildContextReportText } from "../src/slash-commands/helpers/context-report";

const contextWindow = 200_000;

beforeAll(async () => {
	resetSettingsForTest();
	await Settings.init({ inMemory: true });
	await initTheme();
});

afterAll(() => {
	resetSettingsForTest();
});

function makeSession(contextUsage: ContextUsage): AgentSession {
	const messages: AgentMessage[] = [
		{ role: "user", content: "tiny prompt", timestamp: 1 } as AgentMessage,
		{
			role: "assistant",
			content: [{ type: "text", text: "tiny response" }],
			api: "openai-responses",
			provider: "openai",
			model: "test-model",
			usage: {
				input: 150_000,
				output: 1,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 150_001,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop",
			timestamp: 2,
		} as AgentMessage,
	];
	const model = { provider: "openai", id: "test-model", name: "Test Model", contextWindow };

	return {
		state: { model, messages },
		model,
		messages,
		systemPrompt: ["short system prompt"],
		agent: { state: { tools: [] } },
		skills: [],
		settings: Settings.instance,
		modelRegistry: { isUsingOAuth: () => false },
		sessionManager: {
			getUsageStatistics: () => ({
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				premiumRequests: 0,
				cost: 0,
			}),
			getSessionName: () => "cross-surface",
		},
		isStreaming: false,
		isFastModeActive: () => false,
		getAsyncJobSnapshot: () => ({ running: [] }),
		getGoalModeState: () => undefined,
		// This lightweight session stubs the pinned ContextUsage snapshot contract.
		getContextUsage: () => contextUsage,
	} as unknown as AgentSession;
}

function configureForModel(component: StatusLineComponent): void {
	component.updateSettings({
		preset: "custom",
		leftSegments: ["model"],
		rightSegments: [],
		showSkillHud: false,
		showHookStatus: false,
		sessionAccent: false,
	});
}

function buildReport(session: AgentSession): string {
	return buildContextReportText({
		session,
		sessionManager: {
			buildSessionContext: () => ({ messages: session.messages }),
			getBranch: () => [],
		},
		settings: Settings.instance,
	} as never);
}

describe("context usage cross-surface parity", () => {
	it("uses the provider-anchored snapshot instead of the category estimate", () => {
		const session = makeSession({
			tokens: 150_000,
			contextWindow,
			percent: 75,
			source: "provider_anchor",
		});
		const component = new StatusLineComponent(session);
		configureForModel(component);

		const usage = session.getContextUsage();
		if (!usage) throw new Error("Expected the fake session to return context usage");
		const breakdown = computeContextBreakdown(session);
		const rendered = Bun.stripANSI(component.render(160).join("\n"));

		expect(breakdown.source).toBe("provider_anchor");
		expect(breakdown.usedTokens).toBe(usage.tokens ?? Number.NaN);
		expect(breakdown.estimatedCategoryTotal).toBeLessThan(1_000);
		expect(breakdown.estimatedCategoryTotal).not.toBe(breakdown.usedTokens);
		expect(rendered).toContain(`${usage.percent!.toFixed(1)}%`);
		expect(rendered).not.toContain(`${((breakdown.estimatedCategoryTotal / contextWindow) * 100).toFixed(1)}%`);

		const panel = Bun.stripANSI(renderContextUsage(breakdown, theme));
		expect(panel).toContain("provider-reported");
		expect(panel).toContain(`Estimated category total: ${breakdown.estimatedCategoryTotal}`);

		const report = buildReport(session);
		expect(report).toContain("provider-reported");
		expect(report).toContain(`Estimated category total: ${breakdown.estimatedCategoryTotal.toLocaleString()}`);
		component.dispose();
	});

	it("preserves unknown context usage after compaction", () => {
		const session = makeSession({
			tokens: null,
			contextWindow,
			percent: null,
			source: "unknown",
		});
		const component = new StatusLineComponent(session);
		configureForModel(component);

		const usage = session.getContextUsage();
		if (!usage) throw new Error("Expected the fake session to return context usage");
		const breakdown = computeContextBreakdown(session);
		const rendered = Bun.stripANSI(component.render(160).join("\n"));

		expect(usage.percent).toBeNull();
		expect(rendered).toContain("?");
		expect(breakdown.source).toBe("unknown");
		expect(breakdown.usedTokens).toBeNull();
		expect(Bun.stripANSI(renderContextUsage(breakdown, theme))).toContain(
			"unknown/200k tokens (exact count unknown until next response)",
		);
		expect(Bun.stripANSI(renderContextUsage(breakdown, theme))).toContain("Free space (estimated)");
		expect(buildReport(session)).toContain(
			"Active context: unknown / 200,000 tokens (exact count unknown until next response)",
		);
		component.dispose();
	});

	it("copies a heuristic snapshot total verbatim instead of substituting category estimates", () => {
		const usage: ContextUsage = {
			tokens: 150_000,
			contextWindow,
			percent: 75,
			source: "heuristic",
		};
		const session = makeSession(usage);
		const breakdown = computeContextBreakdown(session);
		const panel = Bun.stripANSI(renderContextUsage(breakdown, theme));
		const report = buildReport(session);

		expect(breakdown.source).toBe("heuristic");
		expect(breakdown.usedTokens).toBe(usage.tokens);
		expect(breakdown.estimatedCategoryTotal).not.toBe(usage.tokens);
		expect(panel).toContain("Estimated category total:");
		expect(report).toContain("Estimated category total:");
	});
});
