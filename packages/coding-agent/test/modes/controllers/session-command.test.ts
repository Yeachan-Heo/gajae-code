import { beforeAll, describe, expect, it } from "bun:test";
import { getBundledModel, type Model, type Usage } from "@gajae-code/ai";
import { CommandController } from "@gajae-code/coding-agent/modes/controllers/command-controller";
import { getThemeByName, setThemeInstance } from "@gajae-code/coding-agent/modes/theme/theme";
import type { InteractiveModeContext } from "@gajae-code/coding-agent/modes/types";
import { Text } from "@gajae-code/tui";

/** OSC 52 clipboard write. The payload is the base64 of "owned". */
const OSC_CLIPBOARD = "\u001b]52;c;b3duZWQ=\u0007";
/** OSC 0 window-title sequence. */
const OSC_TITLE = "\u001b]0;owned-title\u0007";

type SessionPanelExtras = {
	appendOnly?: unknown;
	lspServers?: NonNullable<InteractiveModeContext["lspServers"]>;
	mcpNames?: string[];
	mcpToolCounts?: Record<string, number>;
};

async function renderSessionText(
	costBreakdown?: Usage["cost"],
	model?: Model,
	extras?: SessionPanelExtras,
): Promise<string> {
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
				sessionMemory: {
					sidecarEnabled: true,
					coldRetirementActive: true,
					sidecarIneligible: false,
					hotRegionBytes: 1024,
					metaDescriptorBytes: 2048,
					totalAccountedBytes: 4096,
					reservedBudgetBytes: 4096,
					allocatedCacheBytes: 512,
					hotResidentBytes: 1024,
					metadataResidentBytes: 2048,
					sidecarFileBytes: 8192,
					lastReopenTransition: undefined,
					currentCommitTransition: { kind: "exact", reason: "descriptor_and_proof_match" },
					lazyReopenAttempted: true,
					lazyReopenSucceeded: true,
					lazyReopenFallbackReason: undefined,
					retirementFallbackReason: undefined,
					autoDisabledReason: undefined,
					coldIndexBytes: 0,
					coldIndexBlockCacheBytes: 0,
					coldEntryCacheBytes: 0,
					coldEntriesRetired: 0,
					coldEntriesReloaded: 0,
					rangeReadCount: 0,
					rangeReadGenerationMismatchCount: 0,
					sidecarRebuildCount: 0,
					coldMutationPromotions: 0,
					hotOverflowTransitions: 0,
					labelDiskFallbackCount: 0,
					transcriptGeneration: 0,
					consecutiveBuildFailures: 0,
				},
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
		settings: {
			get: (key: string) => (key === "provider.appendOnlyContext" ? extras?.appendOnly : undefined),
		},
		lspServers: extras?.lspServers,
		mcpManager: extras?.mcpNames
			? {
					getConnectedServers: () => extras.mcpNames ?? [],
					getConnection: (name: string) => ({
						tools: Array.from({ length: extras?.mcpToolCounts?.[name] ?? 0 }, () => ({})),
					}),
				}
			: undefined,
		chatContainer,
		ui: { requestRender: () => undefined },
	} as unknown as InteractiveModeContext;

	const controller = new CommandController(ctx);
	await controller.handleSessionCommand();
	const content = chatContainer.children[1];
	if (!(content instanceof Text)) throw new Error("Expected /session to add a text panel");
	return content.getText();
}

async function renderSessionInfo(
	costBreakdown?: Usage["cost"],
	model?: Model,
	extras?: SessionPanelExtras,
): Promise<string> {
	return (await renderSessionText(costBreakdown, model, extras)).replace(/\x1b\[[0-9;]*m/g, "");
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

	it("renders live cold-session memory health", async () => {
		const output = await renderSessionInfo();
		expect(output).toContain("Session Memory\nCold Retirement: active");
		expect(output).toContain("Hot Resident: 1.0KB");
		expect(output).toContain("Metadata Resident: 2.0KB");
		expect(output).toContain("Allocated Caches: 512B");
		expect(output).toContain("Reserved Budget: 4.0KB");
		expect(output).toContain("Sidecar Files: 8.0KB");
		expect(output).toContain("Budget Accounted: 4.0KB");
		expect(output).toContain("Lazy Reopen: exact");
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

	it("keeps ordinary append-only settings, LSP labels, and MCP names", async () => {
		const selected = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!selected) throw new Error("Expected bundled model");
		const auto = await renderSessionInfo(undefined, selected);
		expect(auto).toContain("Append-Only: active (setting: auto (anthropic))");

		const enabled = await renderSessionInfo(undefined, undefined, {
			appendOnly: "on",
			lspServers: [
				{ name: "typescript", status: "ready", fileTypes: [".ts", ".tsx"] },
				{ name: "rust-analyzer", status: "error", error: "missing binary", fileTypes: [".rs"] },
			],
			mcpNames: ["docs"],
			mcpToolCounts: { docs: 2 },
		});
		expect(enabled).toContain("Append-Only: active (setting: on)");
		expect(enabled).toContain("typescript: ready (.ts, .tsx)");
		expect(enabled).toContain("rust-analyzer: error: missing binary (.rs)");
		expect(enabled).toContain("docs: connected (2 tools)");

		const disabled = await renderSessionInfo(undefined, selected, { appendOnly: "off" });
		expect(disabled).toContain("Append-Only: inactive (setting: off)");
	});

	it("strips OSC sequences from append-only settings, LSP fields, and MCP names", async () => {
		const raw = await renderSessionText(undefined, undefined, {
			appendOnly: `on${OSC_CLIPBOARD}`,
			lspServers: [
				{
					name: `typescript${OSC_TITLE}`,
					status: "error",
					error: `missing\nbinary${OSC_CLIPBOARD}`,
					fileTypes: [`.ts${OSC_TITLE}`, ".tsx"],
				},
			],
			mcpNames: [`docs${OSC_CLIPBOARD}`],
			mcpToolCounts: { [`docs${OSC_CLIPBOARD}`]: 2 },
		});
		const plain = raw.replace(/\x1b\[[0-9;]*m/g, "");

		expect(raw).not.toContain("\u001b]");
		expect(raw).not.toContain("\u0007");
		expect(raw).not.toContain("b3duZWQ=");
		expect(raw).not.toContain("owned-title");
		expect(plain).toContain("Append-Only: inactive (setting: on)");
		expect(plain).toContain("typescript: error: missing binary (.ts, .tsx)");
		expect(plain).toContain("docs: connected (2 tools)");
	});
});
