import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { resetSettingsForTest, Settings } from "../src/config/settings";
import { StatusLineComponent } from "../src/modes/components/tool-status-header";
import { initTheme } from "../src/modes/theme/theme";
import type { AgentSession } from "../src/session/agent-session";

function stripAnsi(text: string): string {
	return text.replace(/\x1b\[[0-9;]*m/g, "");
}

function makeSession(fetchUsageReports: () => Promise<unknown>): AgentSession {
	const usageStats = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, premiumRequests: 0, cost: 0 };
	return {
		state: { messages: [], model: { id: "openai-codex/gpt-5", contextWindow: 200_000 } },
		messages: [],
		systemPrompt: [],
		agent: { state: { tools: [] } },
		skills: [],
		model: { id: "openai-codex/gpt-5", contextWindow: 200_000 },
		modelRegistry: { isUsingOAuth: () => false },
		isStreaming: false,
		isFastModeActive: () => false,
		fetchUsageReports,
		sessionManager: {
			getUsageStatistics: () => usageStats,
			getSessionName: () => undefined,
		},
		getAsyncJobSnapshot: () => ({ running: [] }),
	} as unknown as AgentSession;
}

async function waitForUsageText(component: StatusLineComponent): Promise<string> {
	let text = "";
	for (let i = 0; i < 20; i++) {
		text = stripAnsi(component.getTopBorder(120).content);
		if (text.includes("1h") || text.includes("5h")) return text;
		await Bun.sleep(10);
	}
	return text;
}

beforeAll(async () => {
	resetSettingsForTest();
	await Settings.init({ inMemory: true });
	await initTheme();
});

afterAll(() => {
	resetSettingsForTest();
});

describe("status line usage segment", () => {
	it("renders OpenAI Codex primary and secondary usage windows despite plan tiers", async () => {
		const now = Date.now();
		const session = makeSession(async () => [
			{
				provider: "openai-codex",
				fetchedAt: now,
				limits: [
					{
						id: "openai-codex:primary",
						scope: { provider: "openai-codex", windowId: "5h", tier: "pro" },
						window: { id: "5h", resetsAt: now + 180 * 60_000 },
						amount: { usedFraction: 0.24, unit: "percent" },
					},
					{
						id: "openai-codex:secondary",
						scope: { provider: "openai-codex", windowId: "7d", tier: "pro" },
						window: { id: "7d", resetsAt: now + 49 * 3_600_000 },
						amount: { usedFraction: 0.51, unit: "percent" },
					},
					{
						id: "openai-codex:spark:primary",
						scope: { provider: "openai-codex", windowId: "1h", tier: "spark", modelId: "codex-spark" },
						window: { id: "1h", resetsAt: now + 10 * 60_000 },
						amount: { usedFraction: 0.99, unit: "percent" },
					},
				],
			},
		]);
		const component = new StatusLineComponent(session);
		component.updateSettings({ preset: "custom", leftSegments: [], rightSegments: ["usage"], showSkillHud: false });

		const text = await waitForUsageText(component);

		expect(text).toContain("5h 24% (3h)");
		expect(text).toContain("7d 51% (2d 1h)");
		expect(text).not.toContain("99%");
		component.dispose();
	});

	it("renders remaining quota when usage mode is remaining", async () => {
		const now = Date.now();
		const session = makeSession(async () => [
			{
				provider: "openai-codex",
				fetchedAt: now,
				limits: [
					{
						id: "openai-codex:primary",
						scope: { provider: "openai-codex", windowId: "5h", tier: "pro" },
						window: { id: "5h", resetsAt: now + 180 * 60_000 },
						amount: { usedFraction: 0.24, unit: "percent" },
					},
					{
						id: "openai-codex:secondary",
						scope: { provider: "openai-codex", windowId: "7d", tier: "pro" },
						window: { id: "7d", resetsAt: now + 49 * 3_600_000 },
						amount: { usedFraction: 0.51, unit: "percent" },
					},
				],
			},
		]);
		const component = new StatusLineComponent(session);
		component.updateSettings({
			preset: "custom",
			leftSegments: [],
			rightSegments: ["usage"],
			segmentOptions: { usage: { mode: "remaining" } },
			showSkillHud: false,
		});

		const text = await waitForUsageText(component);

		expect(text).toContain("5h 76% (3h)");
		expect(text).toContain("7d 49% (2d 1h)");
		expect(text).not.toContain("24%");
		component.dispose();
	});

	it("renders remaining quota in the default usage preset", async () => {
		const now = Date.now();
		const session = makeSession(async () => [
			{
				provider: "openai-codex",
				fetchedAt: now,
				limits: [
					{
						id: "openai-codex:primary",
						scope: { provider: "openai-codex", windowId: "5h", tier: "pro" },
						window: { id: "5h", resetsAt: now + 180 * 60_000 },
						amount: { usedFraction: 0.24, unit: "percent" },
					},
				],
			},
		]);
		const component = new StatusLineComponent(session);
		component.updateSettings({
			preset: "default-usage",
			segmentOptions: { usage: { mode: "remaining" } },
			showSkillHud: false,
		});

		const text = await waitForUsageText(component);

		expect(text).toContain("5h 76% (3h)");
		component.dispose();
	});

	it("does not render usage mode when the usage segment is hidden", async () => {
		const now = Date.now();
		const session = makeSession(async () => [
			{
				provider: "openai-codex",
				fetchedAt: now,
				limits: [
					{
						id: "openai-codex:primary",
						scope: { provider: "openai-codex", windowId: "5h", tier: "pro" },
						window: { id: "5h", resetsAt: now + 180 * 60_000 },
						amount: { usedFraction: 0.24, unit: "percent" },
					},
				],
			},
		]);
		const component = new StatusLineComponent(session);
		component.updateSettings({
			preset: "custom",
			leftSegments: [],
			rightSegments: ["context_pct"],
			segmentOptions: { usage: { mode: "remaining" } },
			showSkillHud: false,
		});

		component.getTopBorder(120);
		await Bun.sleep(10);
		const text = stripAnsi(component.getTopBorder(120).content);

		expect(text).not.toContain("5h");
		expect(text).not.toContain("76%");
		component.dispose();
	});

	it("keeps rendering non-tiered Anthropic usage windows", async () => {
		const now = Date.now();
		const session = makeSession(async () => [
			{
				provider: "anthropic",
				fetchedAt: now,
				limits: [
					{
						id: "anthropic:5h",
						scope: { provider: "anthropic", windowId: "5h" },
						window: { id: "5h", resetsAt: now + 90 * 60_000 },
						amount: { usedFraction: 0.4, unit: "percent" },
					},
					{
						id: "anthropic:7d:opus",
						scope: { provider: "anthropic", windowId: "7d", tier: "opus" },
						window: { id: "7d", resetsAt: now + 12 * 3_600_000 },
						amount: { usedFraction: 0.9, unit: "percent" },
					},
				],
			},
		]);
		const component = new StatusLineComponent(session);
		component.updateSettings({ preset: "custom", leftSegments: [], rightSegments: ["usage"], showSkillHud: false });

		const text = await waitForUsageText(component);

		expect(text).toContain("5h 40% (1h 30m)");
		expect(text).not.toContain("90%");
		component.dispose();
	});
});
