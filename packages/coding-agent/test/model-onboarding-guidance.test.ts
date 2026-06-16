import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Agent } from "@gajae-code/agent-core";
import type { Model } from "@gajae-code/ai";
import { getBundledModel } from "@gajae-code/ai/models";
import { Settings } from "../src/config/settings";
import { createAgentSession } from "../src/sdk";
import { AgentSession } from "../src/session/agent-session";
import { SessionManager } from "../src/session/session-manager";
import {
	formatModelOnboardingGuidance,
	formatModelOnboardingInlineHint,
	formatNoCredentialOnboardingError,
	formatNoModelOnboardingError,
	formatNoModelsAvailableFallback,
} from "../src/setup/model-onboarding-guidance";
import { BUILTIN_SLASH_COMMANDS_INTERNAL } from "../src/slash-commands/builtin-registry";
import type { SlashCommandRuntime } from "../src/slash-commands/types";

const tempDirs: string[] = [];

afterEach(async () => {
	for (const tempDir of tempDirs.splice(0)) {
		await fs.rm(tempDir, { recursive: true, force: true });
	}
});

async function createTempDir(): Promise<string> {
	const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-model-onboarding-"));
	tempDirs.push(tempDir);
	return tempDir;
}

function createSessionOptions(agentDir: string, options?: { modelPattern?: string; settings?: Settings }) {
	return {
		cwd: agentDir,
		agentDir,
		settings: options?.settings,
		sessionManager: SessionManager.inMemory(),
		disableExtensionDiscovery: true,
		skills: [],
		contextFiles: [],
		promptTemplates: [],
		slashCommands: [],
		enableMCP: false,
		enableLsp: false,
		modelPattern: options?.modelPattern,
	};
}

function expectProviderOnboardingGuidance(text: string): void {
	expect(text).toContain("/provider add --compat <openai|anthropic>");
	expect(text).toContain("gjc setup provider");
	expect(text).toContain("/provider login [provider-id]");
	expect(text).toContain("/login [provider-id]");
	expect(text).toContain("/model");
}

function createRuntime(outputs: string[], availableModels = [] as Model[]): SlashCommandRuntime {
	return {
		session: {
			model: undefined,
			getAvailableModels: () => availableModels,
			setModel: async () => undefined,
		},
		sessionManager: {},
		settings: {
			get: () => ({}),
			getModelRole: () => undefined,
			getStorage: () => ({ getModelUsageOrder: () => [] }),
		},
		cwd: process.cwd(),
		output: (text: string) => outputs.push(text),
		refreshCommands: () => undefined,
		reloadPlugins: async () => undefined,
	} as unknown as SlashCommandRuntime;
}

describe("model onboarding guidance", () => {
	it("keeps all model setup fallbacks on the shared provider onboarding architecture", () => {
		for (const text of [
			formatModelOnboardingGuidance(),
			formatModelOnboardingInlineHint(),
			formatNoModelOnboardingError(),
			formatNoCredentialOnboardingError("local-openai"),
			formatNoModelsAvailableFallback(),
		]) {
			expectProviderOnboardingGuidance(text);
			expect(text).not.toContain("README");
			expect(text).not.toContain("ANTHROPIC_API_KEY, OPENAI_API_KEY");
		}
	});

	it("adds headless-aware credential guidance for OpenCode Go subscription providers (#755)", () => {
		const text = formatNoCredentialOnboardingError("opencode-go");
		expectProviderOnboardingGuidance(text);
		expect(text).toContain("interactive; not available in headless/print mode");
		expect(text).toContain("OpenCode subscriptions authenticate with an API key");
		expect(text).toContain("https://opencode.ai/auth");
		expect(text).toContain("OPENCODE_API_KEY");
		expect(text).toContain("project .env is intentionally ignored");
		expect(text).toContain("gjc auth-broker login opencode-go");
	});

	it("updates /model status output with provider setup and login routes", async () => {
		const command = BUILTIN_SLASH_COMMANDS_INTERNAL.find(entry => entry.name === "model");
		expect(command?.handle).toBeTruthy();
		const outputs: string[] = [];

		await command?.handle?.({ name: "model", args: "", text: "/model" }, createRuntime(outputs));

		const output = outputs.join("\n");
		expect(output).toContain("No model is currently selected");
		expectProviderOnboardingGuidance(output);
	});

	it("routes unknown /model selectors to provider onboarding instead of stale picker-only help", async () => {
		const command = BUILTIN_SLASH_COMMANDS_INTERNAL.find(entry => entry.name === "model");
		expect(command?.handle).toBeTruthy();
		const outputs: string[] = [];

		await command?.handle?.(
			{ name: "model", args: "missing-provider/missing-model", text: "/model missing-provider/missing-model" },
			createRuntime(outputs, [getBundledModel("anthropic", "claude-sonnet-4-5")]),
		);

		const output = outputs.join("\n");
		expect(output).toContain("Unknown model: missing-provider/missing-model");
		expectProviderOnboardingGuidance(output);
		expect(output).not.toContain("Use ACP `session/setModel`");
	});

	it("uses shared provider onboarding text for SDK no-model fallback", async () => {
		const agentDir = await createTempDir();
		const settings = Settings.isolated({ enabledModels: ["provider-without-models"] });
		const { session, modelFallbackMessage } = await createAgentSession(createSessionOptions(agentDir, { settings }));
		try {
			expect(session.model).toBeUndefined();
			expect(modelFallbackMessage).toBeDefined();
			expectProviderOnboardingGuidance(modelFallbackMessage ?? "");
		} finally {
			await session.dispose();
		}
	}, 30000);

	it("uses shared provider onboarding text for AgentSession no-model and no-credential errors", async () => {
		const noModelDir = await createTempDir();
		const noModelSettings = Settings.isolated({ enabledModels: ["provider-without-models"] });
		const noModelSession = await createAgentSession(createSessionOptions(noModelDir, { settings: noModelSettings }));
		try {
			let noModelMessage: string | undefined;
			try {
				await noModelSession.session.prompt("hello");
			} catch (error) {
				noModelMessage = error instanceof Error ? error.message : String(error);
			}
			expect(noModelMessage).toContain("No model selected");
			expectProviderOnboardingGuidance(noModelMessage ?? "");
		} finally {
			await noModelSession.session.dispose();
		}

		const noCredentialModel = getBundledModel("xai", "grok-code-fast-1");
		if (!noCredentialModel) throw new Error("Expected bundled xAI model");
		const noCredentialAgent = new Agent({
			getApiKey: () => "unused-agent-key",
			initialState: {
				model: noCredentialModel,
				systemPrompt: ["Test"],
				tools: [],
				messages: [],
			},
		});
		const noCredentialSession = new AgentSession({
			agent: noCredentialAgent,
			sessionManager: SessionManager.inMemory(),
			settings: Settings.isolated({ "compaction.enabled": false }),
			modelRegistry: {
				getApiKey: async () => undefined,
			} as never,
		});
		try {
			let noCredentialMessage: string | undefined;
			try {
				await noCredentialSession.prompt("hello");
			} catch (error) {
				noCredentialMessage = error instanceof Error ? error.message : String(error);
			}
			expect(noCredentialMessage).toContain("No credentials found for xai");
			expectProviderOnboardingGuidance(noCredentialMessage ?? "");
		} finally {
			await noCredentialSession.dispose();
		}
	});
});
