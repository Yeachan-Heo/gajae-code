import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { resetSettingsForTest, Settings } from "../src/config/settings";
import { StatusLineComponent } from "../src/modes/components/tool-status-header";
import { initTheme } from "../src/modes/theme/theme";
import type { AgentSession } from "../src/session/agent-session";

function stripAnsi(text: string): string {
	return text.replace(/\x1b\[[0-9;]*m/g, "");
}

function makeSession(
	fetchUsageReports: () => Promise<unknown>,
	model: { id: string; provider?: string; contextWindow: number } = {
		id: "openai-codex/gpt-5",
		provider: "openai-codex",
		contextWindow: 200_000,
	},
	options: {
		credentialSessionId?: string;
		codexCredentials?: Array<{ accountId: string }>;
		activeCodexCredentialIndex?: number;
	} = {},
): AgentSession {
	const usageStats = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, premiumRequests: 0, cost: 0 };
	const codexCredentials = options.codexCredentials ?? [{ accountId: "account-default" }];
	return {
		state: { messages: [], model },
		messages: [],
		systemPrompt: [],
		agent: { state: { tools: [] } },
		skills: [],
		model,
		modelRegistry: {
			isUsingOAuth: () => false,
			getAuthStorageOwner: () => ({}),
			authStorage: {
				getOAuthAccountId: (provider: string, sessionId?: string) => {
					if (provider !== "openai-codex" || sessionId !== options.credentialSessionId) return undefined;
					return codexCredentials[options.activeCodexCredentialIndex ?? 0]?.accountId;
				},
			},
		},
		credentialSessionId: options.credentialSessionId,
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

function setSessionModel(session: AgentSession, model: { id: string; provider?: string; contextWindow: number }): void {
	(session.state as unknown as { model: typeof model }).model = model;
	(session as unknown as { model: typeof model }).model = model;
}

async function waitForUsageText(component: StatusLineComponent): Promise<string> {
	let text = "";
	for (let i = 0; i < 20; i++) {
		text = stripAnsi(component.getTopBorder(120).content);
		if (/\b(?:1h|5h|weekly) \d+%/.test(text)) return text;
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
				metadata: { accountId: "account-default" },
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

	it("uses the active Codex credential's usage regardless of report order", async () => {
		const now = Date.now();
		const inactiveReport = {
			provider: "openai-codex",
			fetchedAt: now,
			metadata: { accountId: "account-first" },
			limits: [
				{
					id: "openai-codex:primary",
					scope: { provider: "openai-codex", accountId: "account-first", windowId: "5h" },
					window: { id: "5h", resetsAt: now + 180 * 60_000 },
					amount: { usedFraction: 0.95, unit: "percent" },
				},
				{
					id: "openai-codex:secondary",
					scope: { provider: "openai-codex", accountId: "account-first", windowId: "7d" },
					window: { id: "7d", resetsAt: now + 49 * 3_600_000 },
					amount: { usedFraction: 0.9, unit: "percent" },
				},
			],
		};
		const activeReport = {
			provider: "openai-codex",
			fetchedAt: now,
			metadata: { accountId: "account-active" },
			limits: [
				{
					id: "openai-codex:primary",
					scope: { provider: "openai-codex", accountId: "account-active", windowId: "5h" },
					window: { id: "5h", resetsAt: now + 180 * 60_000 },
					amount: { usedFraction: 0.12, unit: "percent" },
				},
				{
					id: "openai-codex:secondary",
					scope: { provider: "openai-codex", accountId: "account-active", windowId: "7d" },
					window: { id: "7d", resetsAt: now + 49 * 3_600_000 },
					amount: { usedFraction: 0.23, unit: "percent" },
				},
			],
		};

		for (const reports of [
			[inactiveReport, activeReport],
			[activeReport, inactiveReport],
		]) {
			const selection = {
				credentialSessionId: "session-active",
				codexCredentials: [{ accountId: "account-first" }, { accountId: "account-active" }],
				activeCodexCredentialIndex: 1,
			};
			const session = makeSession(async () => reports, undefined, selection);
			const component = new StatusLineComponent(session);
			component.updateSettings({
				preset: "custom",
				leftSegments: [],
				rightSegments: ["usage"],
				showSkillHud: false,
			});

			const text = await waitForUsageText(component);

			expect(text).toContain("5h 12%");
			expect(text).toContain("7d 23%");
			expect(text).not.toContain("95%");
			expect(text).not.toContain("90%");

			selection.activeCodexCredentialIndex = 0;
			const switchedText = stripAnsi(component.getTopBorder(120).content);
			expect(switchedText).toContain("5h 95%");
			expect(switchedText).toContain("7d 90%");
			component.dispose();
		}
	});

	it("does not attribute a singleton Codex report when the active account is unknown", async () => {
		const now = Date.now();
		const session = makeSession(
			async () => [
				{
					provider: "openai-codex",
					fetchedAt: now,
					metadata: { accountId: "account-unverified" },
					limits: [
						{
							id: "openai-codex:primary",
							scope: { provider: "openai-codex", accountId: "account-unverified", windowId: "5h" },
							window: { id: "5h", resetsAt: now + 180 * 60_000 },
							amount: { usedFraction: 0.81, unit: "percent" },
						},
					],
				},
			],
			undefined,
			{ credentialSessionId: "session-unresolved", codexCredentials: [] },
		);
		const component = new StatusLineComponent(session);
		component.updateSettings({ preset: "custom", leftSegments: [], rightSegments: ["usage"], showSkillHud: false });

		const text = await waitForUsageText(component);

		expect(text).not.toContain("5h");
		expect(text).not.toContain("81%");
		component.dispose();
	});

	it("rejects Codex reports with conflicting report and limit account IDs", async () => {
		const now = Date.now();
		const session = makeSession(async () => [
			{
				provider: "openai-codex",
				fetchedAt: now,
				metadata: { accountId: "account-default" },
				limits: [
					{
						id: "openai-codex:primary",
						scope: { provider: "openai-codex", accountId: "account-other", windowId: "5h" },
						window: { id: "5h", resetsAt: now + 180 * 60_000 },
						amount: { usedFraction: 0.81, unit: "percent" },
					},
				],
			},
		]);
		const component = new StatusLineComponent(session);
		component.updateSettings({ preset: "custom", leftSegments: [], rightSegments: ["usage"], showSkillHud: false });

		const text = await waitForUsageText(component);

		expect(text).not.toContain("5h");
		expect(text).not.toContain("81%");
		component.dispose();
	});

	it("does not pick a duplicate active-account report by array order", async () => {
		const now = Date.now();
		const highUsageReport = {
			provider: "openai-codex",
			fetchedAt: now,
			metadata: { accountId: "account-default" },
			limits: [
				{
					id: "openai-codex:primary",
					scope: { provider: "openai-codex", accountId: "account-default", windowId: "5h" },
					window: { id: "5h", resetsAt: now + 180 * 60_000 },
					amount: { usedFraction: 0.95, unit: "percent" },
				},
			],
		};
		const lowUsageReport = {
			provider: "openai-codex",
			fetchedAt: now,
			metadata: { accountId: "account-default" },
			limits: [
				{
					id: "openai-codex:primary",
					scope: { provider: "openai-codex", accountId: "account-default", windowId: "5h" },
					window: { id: "5h", resetsAt: now + 180 * 60_000 },
					amount: { usedFraction: 0.12, unit: "percent" },
				},
			],
		};

		for (const reports of [
			[highUsageReport, lowUsageReport],
			[lowUsageReport, highUsageReport],
		]) {
			const component = new StatusLineComponent(makeSession(async () => reports));
			component.updateSettings({
				preset: "custom",
				leftSegments: [],
				rightSegments: ["usage"],
				showSkillHud: false,
			});

			const text = await waitForUsageText(component);

			expect(text).not.toContain("5h");
			expect(text).not.toContain("95%");
			expect(text).not.toContain("12%");
			component.dispose();
		}
	});

	it("renders remaining quota when usage mode is remaining", async () => {
		const now = Date.now();
		const session = makeSession(async () => [
			{
				provider: "openai-codex",
				fetchedAt: now,
				metadata: { accountId: "account-default" },
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
				metadata: { accountId: "account-default" },
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
				metadata: { accountId: "account-default" },
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
		const session = makeSession(
			async () => [
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
			],
			{ id: "claude-sonnet-4-5", provider: "anthropic", contextWindow: 200_000 },
		);
		const component = new StatusLineComponent(session);
		component.updateSettings({ preset: "custom", leftSegments: [], rightSegments: ["usage"], showSkillHud: false });

		const text = await waitForUsageText(component);

		expect(text).toContain("5h 40% (1h 30m)");
		expect(text).not.toContain("90%");
		component.dispose();
	});

	it("renders Grok weekly quota without admitting unrelated tiered windows", async () => {
		const now = Date.now();
		const session = makeSession(
			async () => [
				{
					provider: "grok-build",
					fetchedAt: now,
					limits: [
						{
							id: "grok-build:weekly",
							scope: { provider: "grok-build", windowId: "weekly" },
							window: { id: "weekly", resetsAt: now + 6 * 24 * 3_600_000 },
							amount: { usedFraction: 0.06, unit: "percent" },
						},
						{
							id: "grok-build:weekly:heavy",
							scope: { provider: "grok-build", windowId: "weekly", tier: "heavy" },
							window: { id: "weekly", resetsAt: now + 24 * 3_600_000 },
							amount: { usedFraction: 0.99, unit: "percent" },
						},
					],
				},
			],
			{ id: "grok-build", provider: "grok-build", contextWindow: 200_000 },
		);
		const component = new StatusLineComponent(session);
		component.updateSettings({ preset: "custom", leftSegments: [], rightSegments: ["usage"], showSkillHud: false });

		const text = await waitForUsageText(component);

		expect(text).toContain("weekly 6% (6d)");
		expect(text).not.toContain("99%");
		component.dispose();
	});

	it("does not infer authoritative Grok usage from an xAI report", async () => {
		const now = Date.now();
		const session = makeSession(
			async () => [
				{
					provider: "xai",
					fetchedAt: now,
					limits: [
						{
							id: "xai:weekly",
							scope: { provider: "xai", windowId: "weekly" },
							window: { id: "weekly", resetsAt: now + 6 * 24 * 3_600_000 },
							amount: { usedFraction: 0.12, unit: "percent" },
						},
						{
							id: "xai:7d",
							scope: { provider: "xai", windowId: "7d" },
							window: { id: "7d", resetsAt: now + 20 * 24 * 3_600_000 },
							amount: { usedFraction: 0.4, unit: "percent" },
						},
					],
				},
			],
			{ id: "grok-4.6", provider: "xai", contextWindow: 200_000 },
		);
		const component = new StatusLineComponent(session);
		component.updateSettings({ preset: "custom", leftSegments: [], rightSegments: ["usage"], showSkillHud: false });

		const text = await waitForUsageText(component);

		expect(text).not.toContain("weekly");
		expect(text).not.toContain("7d");
		expect(text).not.toContain("12%");
		expect(text).not.toContain("40%");
		component.dispose();
	});

	it("reprojects cached reports after switching the active provider", async () => {
		const now = Date.now();
		const session = makeSession(
			async () => [
				{
					provider: "anthropic",
					fetchedAt: now,
					limits: [
						{
							id: "anthropic:5h",
							scope: { provider: "anthropic", windowId: "5h" },
							window: { id: "5h", resetsAt: now + 90 * 60_000 },
							amount: { usedFraction: 1, unit: "percent" },
						},
						{
							id: "anthropic:7d",
							scope: { provider: "anthropic", windowId: "7d" },
							window: { id: "7d", resetsAt: now + 68 * 3_600_000 },
							amount: { usedFraction: 0.44, unit: "percent" },
						},
					],
				},
				{
					provider: "grok-build",
					fetchedAt: now,
					limits: [
						{
							id: "grok-build:weekly",
							scope: { provider: "grok-build", windowId: "weekly" },
							window: { id: "weekly", resetsAt: now + 56 * 3_600_000 },
							amount: { usedFraction: 0.18, unit: "percent" },
						},
					],
				},
			],
			{ id: "claude-sonnet-4-5", provider: "anthropic", contextWindow: 200_000 },
		);
		const component = new StatusLineComponent(session);
		component.updateSettings({ preset: "custom", leftSegments: [], rightSegments: ["usage"], showSkillHud: false });

		const anthropicText = await waitForUsageText(component);
		expect(anthropicText).toContain("5h 100%");

		const grokModel = { id: "grok-build", provider: "grok-build", contextWindow: 200_000 };
		setSessionModel(session, grokModel);
		const grokText = stripAnsi(component.getTopBorder(120).content);

		expect(grokText).toContain("weekly 18%");
		expect(grokText).not.toContain("5h");
		expect(grokText).not.toContain("100%");
		component.dispose();
	});

	it("clears cached usage when the switched-to provider has no report", async () => {
		const now = Date.now();
		const session = makeSession(
			async () => [
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
					],
				},
			],
			{ id: "claude-sonnet-4-5", provider: "anthropic", contextWindow: 200_000 },
		);
		const component = new StatusLineComponent(session);
		component.updateSettings({ preset: "custom", leftSegments: [], rightSegments: ["usage"], showSkillHud: false });

		const anthropicText = await waitForUsageText(component);
		expect(anthropicText).toContain("5h 40%");

		setSessionModel(session, { id: "grok-build", provider: "grok-build", contextWindow: 200_000 });
		const grokText = stripAnsi(component.getTopBorder(120).content);

		expect(grokText).not.toContain("5h");
		expect(grokText).not.toContain("40%");
		component.dispose();
	});

	it("does not aggregate usage reports when no active provider is resolved", async () => {
		const now = Date.now();
		const session = makeSession(
			async () => [
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
					],
				},
			],
			{ id: "unresolved", contextWindow: 200_000 },
		);
		const component = new StatusLineComponent(session);
		component.updateSettings({ preset: "custom", leftSegments: [], rightSegments: ["usage"], showSkillHud: false });

		const text = await waitForUsageText(component);

		expect(text).not.toContain("5h");
		expect(text).not.toContain("40%");
		component.dispose();
	});

	it("uses the active fallback model in the session state over a stale session model", async () => {
		const now = Date.now();
		const session = makeSession(
			async () => [
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
					],
				},
				{
					provider: "openai-codex",
					fetchedAt: now,
					metadata: { accountId: "account-default" },
					limits: [
						{
							id: "openai-codex:primary",
							scope: { provider: "openai-codex", windowId: "5h" },
							window: { id: "5h", resetsAt: now + 90 * 60_000 },
							amount: { usedFraction: 0.8, unit: "percent" },
						},
					],
				},
			],
			{ id: "claude-sonnet-4-5", provider: "anthropic", contextWindow: 200_000 },
		);
		(session as unknown as { model: { id: string; provider: string; contextWindow: number } }).model = {
			id: "gpt-5",
			provider: "openai-codex",
			contextWindow: 200_000,
		};
		const component = new StatusLineComponent(session);
		component.updateSettings({ preset: "custom", leftSegments: [], rightSegments: ["usage"], showSkillHud: false });

		const text = await waitForUsageText(component);

		expect(text).toContain("5h 40%");
		expect(text).not.toContain("80%");
		component.dispose();
	});

	it("matches the OpenAI Codex device provider alias to its canonical report", async () => {
		const now = Date.now();
		const session = makeSession(
			async () => [
				{
					provider: "openai-codex",
					fetchedAt: now,
					metadata: { accountId: "account-default" },
					limits: [
						{
							id: "openai-codex:primary",
							scope: { provider: "openai-codex", windowId: "5h", tier: "pro" },
							window: { id: "5h", resetsAt: now + 180 * 60_000 },
							amount: { usedFraction: 0.24, unit: "percent" },
						},
					],
				},
			],
			{ id: "gpt-5", provider: "openai-codex-device", contextWindow: 200_000 },
		);
		const component = new StatusLineComponent(session);
		component.updateSettings({ preset: "custom", leftSegments: [], rightSegments: ["usage"], showSkillHud: false });

		const text = await waitForUsageText(component);

		expect(text).toContain("5h 24%");
		component.dispose();
	});
});
