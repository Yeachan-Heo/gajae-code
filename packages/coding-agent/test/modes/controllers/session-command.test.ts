import { beforeAll, describe, expect, it } from "bun:test";
import { getBundledModel, type Model, type Usage } from "@gajae-code/ai";
import { CommandController } from "@gajae-code/coding-agent/modes/controllers/command-controller";
import { getThemeByName, setThemeInstance } from "@gajae-code/coding-agent/modes/theme/theme";
import type { InteractiveModeContext } from "@gajae-code/coding-agent/modes/types";
import { Text } from "@gajae-code/tui";

async function renderSessionInfo(costBreakdown?: Usage["cost"], model?: Model): Promise<string> {
	const chatContainer = {
		children: [] as unknown[],
		addChild(child: unknown) {
			this.children.push(child);
		},
	};
	const ctx = {
		session: {
			getSessionStats: () => ({
				sessionFile: undefined,
				sessionId: "aggregate-session",
				userMessages: 1,
				assistantMessages: 1,
				toolCalls: 0,
				toolResults: 0,
				totalMessages: 2,
				tokens: { input: 2_000, output: 500, cacheRead: 1_000_000, cacheWrite: 40_000, total: 1_042_500 },
				premiumRequests: 0,
				cost: 0.67,
				costBreakdown,
			}),
			model,
			modelRegistry: {
				authStorage: {
					hasOAuth: () => false,
					has: () => false,
					hasAuth: () => false,
					describeCredentialSource: () => undefined,
				},
			},
			providerSessionState: undefined,
			sessionManager: { getUsageStatistics: () => ({ premiumRequests: 0 }) },
		},
		settings: { get: () => undefined },
		chatContainer,
		ui: { requestRender: () => undefined },
	} as unknown as InteractiveModeContext;

	const controller = new CommandController(ctx);
	await controller.handleSessionCommand();
	const content = chatContainer.children[1];
	if (!(content instanceof Text)) throw new Error("Expected /session to add a text panel");
	return content.getText().replace(/\x1b\[[0-9;]*m/g, "");
}

beforeAll(async () => {
	const installed = await getThemeByName("red-claw");
	if (!installed) throw new Error("Expected dark theme");
	setThemeInstance(installed);
});

describe("/session command", () => {
	it("uses persisted aggregate cache costs without a selected model", async () => {
		const output = await renderSessionInfo({
			input: 0.52,
			output: 0,
			cacheRead: 0.03,
			cacheWrite: 0.12,
			total: 0.67,
		});

		expect(output).toContain("Tokens\nInput: 2,000\nOutput: 500\nCache Read: 1,000,000\nCache Write: 40,000");
		expect(output).toContain("Cost\nTotal: 0.6700");
		expect(output).toContain("Cache Miss Cost\nUncached Input Cost: $0.52");
		expect(output).toContain("Cache Write Cost: $0.12");
		expect(output).not.toContain("Estimated Miss Premium");
		expect(output.indexOf("Tokens")).toBeLessThan(output.indexOf("Cost\nTotal: 0.6700"));
		expect(output.indexOf("Cost\nTotal: 0.6700")).toBeLessThan(output.indexOf("Cache Miss Cost"));
	});

	it("is invariant to the selected model's prices", async () => {
		const selected = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!selected) throw new Error("Expected bundled model");
		const expensive = { ...selected, cost: { input: 100, output: 100, cacheRead: 0.01, cacheWrite: 100 } };
		const costBreakdown = { input: 0.52, output: 0, cacheRead: 0.03, cacheWrite: 0.12, total: 0.67 };

		expect(await renderSessionInfo(costBreakdown, expensive)).toBe(await renderSessionInfo(costBreakdown, selected));
	});

	it("omits cache economics when aggregate provenance is absent or incomplete", async () => {
		const absent = await renderSessionInfo();
		expect(absent).not.toContain("Cache Miss Cost");

		const incomplete = await renderSessionInfo({
			input: 0.52,
			output: 0,
			cacheRead: 0.03,
			cacheWrite: Number.NaN,
			total: 0.67,
		});
		expect(incomplete).not.toContain("Cache Miss Cost");
	});

	it("does not reprice material tokens when a complete persisted aggregate is all zero", async () => {
		const selected = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!selected) throw new Error("Expected bundled model");
		const expensive = { ...selected, cost: { input: 100, output: 100, cacheRead: 0.01, cacheWrite: 100 } };
		const zeroAggregate = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 };

		const output = await renderSessionInfo(zeroAggregate, expensive);

		expect(output).toContain("Tokens\nInput: 2,000\nOutput: 500\nCache Read: 1,000,000\nCache Write: 40,000");
		expect(output).toContain("Cost\nTotal: 0.6700");
		expect(output).not.toContain("Cache Miss Cost");
		expect(output).not.toContain("Estimated Miss Premium");
	});
});
