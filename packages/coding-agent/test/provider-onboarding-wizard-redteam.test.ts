import { afterEach, beforeAll, describe, expect, it, mock } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { AuthStorage, SqliteAuthCredentialStore } from "@gajae-code/ai";
import { ModelRegistry } from "@gajae-code/coding-agent/config/model-registry";
import { CustomProviderWizardComponent } from "@gajae-code/coding-agent/modes/components/custom-provider-wizard";
import {
	type ProviderOnboardingAction,
	ProviderOnboardingSelectorComponent,
} from "@gajae-code/coding-agent/modes/components/provider-onboarding-selector";
import { SelectorController } from "@gajae-code/coding-agent/modes/controllers/selector-controller";
import { initTheme } from "@gajae-code/coding-agent/modes/theme/theme";
import type { InteractiveModeContext } from "@gajae-code/coding-agent/modes/types";
import { addApiCompatibleProvider, type ProviderSetupInput } from "@gajae-code/coding-agent/setup/provider-onboarding";
import { getAgentDir, setAgentDir } from "@gajae-code/utils";

const originalAgentDir = getAgentDir();
let tempAgentDir: string | undefined;

beforeAll(async () => {
	await initTheme(false);
});

afterEach(async () => {
	setAgentDir(originalAgentDir);
	if (tempAgentDir) {
		await fs.rm(tempAgentDir, { recursive: true, force: true });
		tempAgentDir = undefined;
	}
});

function visibleText(component: { render(width: number): string[] }): string {
	return Bun.stripANSI(component.render(180).join("\n"));
}

function typeText(component: { handleInput(input: string): void }, text: string): void {
	for (const char of text) component.handleInput(char);
}

function driveWizard(
	component: CustomProviderWizardComponent,
	options?: {
		providerId?: string;
		baseUrl?: string;
		credentialSource?: "env" | "literal";
		credential?: string;
		models?: string;
	},
): void {
	component.handleInput("\n");
	typeText(component, options?.providerId ?? "custom-openai");
	component.handleInput("\n");
	typeText(component, options?.baseUrl ?? "https://api.example.com/v1");
	component.handleInput("\n");
	if (options?.credentialSource === "literal") component.handleInput("\x1b[B");
	component.handleInput("\n");
	typeText(
		component,
		options?.credential ?? (options?.credentialSource === "literal" ? "sk-redteam-secret" : "CUSTOM_PROVIDER_KEY"),
	);
	component.handleInput("\n");
	typeText(component, options?.models ?? "custom-model");
	component.handleInput("\n");
}

async function withRegistry<T>(
	run: (registry: ModelRegistry, store: SqliteAuthCredentialStore) => Promise<T>,
): Promise<T> {
	tempAgentDir = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-provider-wizard-redteam-"));
	setAgentDir(tempAgentDir);
	const store = await SqliteAuthCredentialStore.open(path.join(tempAgentDir, "agent.db"));
	try {
		const authStorage = new AuthStorage(store);
		const registry = new ModelRegistry(authStorage, path.join(tempAgentDir, "models.yml"));
		return await run(registry, store);
	} finally {
		store.close();
	}
}

describe("provider onboarding wizard red-team", () => {
	it("rejects invalid and non-https non-localhost base URLs while wizard surfaces the error without crashing", async () => {
		await expect(
			addApiCompatibleProvider({
				compatibility: "openai",
				providerId: "bad-url",
				baseUrl: "not a url",
				apiKeyEnv: "BAD_URL_KEY",
				models: ["bad-model"],
			}),
		).rejects.toThrow("Base URL must be a valid absolute URL");

		await expect(
			addApiCompatibleProvider({
				compatibility: "openai",
				providerId: "insecure-url",
				baseUrl: "http://api.example.com/v1",
				apiKeyEnv: "INSECURE_URL_KEY",
				models: ["bad-model"],
			}),
		).rejects.toThrow("Base URL must use https unless it targets localhost or a loopback address");

		const ctx = createControllerContext({ refresh: async () => undefined } as unknown as ModelRegistry);
		const controller = new SelectorController(ctx);
		controller.showCustomProviderWizard();
		const wizard = ctx.ui.focused as CustomProviderWizardComponent;
		driveWizard(wizard, { providerId: "insecure-wizard", baseUrl: "http://api.example.com/v1" });
		wizard.handleInput("\n");
		await Bun.sleep(20);

		const rendered = visibleText(wizard);
		expect(rendered).toContain("Provider setup failed");
		expect(rendered).toContain("Base URL must use https unless it targets localhost or a loopback address");
	});

	it("rejects empty provider id and empty model lists", async () => {
		await expect(
			addApiCompatibleProvider({
				compatibility: "openai",
				providerId: "",
				baseUrl: "https://api.example.com/v1",
				apiKeyEnv: "EMPTY_PROVIDER_KEY",
				models: ["custom-model"],
			}),
		).rejects.toThrow("Provider id is required");

		await expect(
			addApiCompatibleProvider({
				compatibility: "openai",
				providerId: "empty-models",
				baseUrl: "https://api.example.com/v1",
				apiKeyEnv: "EMPTY_MODELS_KEY",
				models: ["", "  ", ","],
			}),
		).rejects.toThrow("At least one model id is required");
	});

	it("requires force for an existing provider and overwrites when force is confirmed", async () => {
		await withRegistry(async () => {
			const first: ProviderSetupInput = {
				compatibility: "openai",
				providerId: "dupe-provider",
				baseUrl: "https://api.example.com/v1",
				apiKeyEnv: "DUPE_PROVIDER_KEY",
				models: ["old-model"],
			};
			await addApiCompatibleProvider(first);
			await expect(addApiCompatibleProvider({ ...first, models: ["new-model"] })).rejects.toThrow(
				"Provider 'dupe-provider' already exists. Use --force to replace it.",
			);
			const result = await addApiCompatibleProvider({ ...first, models: ["new-model"], force: true });
			expect(result.modelIds).toEqual(["new-model"]);

			const text = await Bun.file(path.join(tempAgentDir!, "models.yml")).text();
			expect(text).toContain("new-model");
			expect(text).not.toContain("old-model");
		});
	});

	it("emits env-var and pasted-key credential sources as correct ProviderSetupInput fields", () => {
		const submissions: ProviderSetupInput[] = [];
		const envWizard = new CustomProviderWizardComponent(
			input => submissions.push(input),
			() => undefined,
		);
		driveWizard(envWizard, { providerId: "env-provider", credentialSource: "env", credential: "ENV_PROVIDER_KEY" });
		envWizard.handleInput("\n");

		const literalWizard = new CustomProviderWizardComponent(
			input => submissions.push(input),
			() => undefined,
		);
		driveWizard(literalWizard, {
			providerId: "literal-provider",
			credentialSource: "literal",
			credential: "sk-literal-key",
		});
		literalWizard.handleInput("\n");

		expect(submissions).toEqual([
			expect.objectContaining({ providerId: "env-provider", apiKeyEnv: "ENV_PROVIDER_KEY", apiKey: undefined }),
			expect.objectContaining({ providerId: "literal-provider", apiKeyEnv: undefined, apiKey: "sk-literal-key" }),
		]);
	});

	it("refreshes offline, notifies config change, shows formatted result, and exposes new provider in a subsequent model selector read", async () => {
		await withRegistry(async registry => {
			const refreshModes: (string | undefined)[] = [];
			const originalRefresh = registry.refresh.bind(registry);
			registry.refresh = async mode => {
				refreshModes.push(mode);
				await originalRefresh(mode);
			};
			let configChanged = 0;
			const ctx = createControllerContext(registry, () => {
				configChanged++;
			});
			const controller = new SelectorController(ctx);

			controller.showCustomProviderWizard();
			const wizard = ctx.ui.focused as CustomProviderWizardComponent;
			driveWizard(wizard, { providerId: "visible-provider", models: "visible-model" });
			wizard.handleInput("\n");
			await Bun.sleep(50);

			expect(refreshModes).toContain("offline");
			expect(configChanged).toBe(1);
			const status = ctx.statuses.join("\n");
			expect(status).toContain("Provider 'visible-provider' configured as openai-compatible.");
			expect(status).toContain("Models: visible-model");
			expect(status).toContain("API key: CUST…_KEY (environment variable)");

			await registry.refresh("offline");
			expect(registry.find("visible-provider", "visible-model")).toBeDefined();
		});
	});

	it("keeps Add custom provider at index 0 while OAuth and API-guide actions still route", () => {
		const actions: ProviderOnboardingAction[] = [];
		const selector = new ProviderOnboardingSelectorComponent(
			action => actions.push(action),
			() => undefined,
		);
		const rendered = visibleText(selector);
		expect(rendered.indexOf("Add custom provider")).toBeLessThan(rendered.indexOf("Login with OAuth/subscription"));
		selector.handleInput("\n");
		expect(actions).toEqual(["custom-provider-wizard"]);

		const ctx = createControllerContext({ refresh: async () => undefined } as unknown as ModelRegistry);
		const controller = new SelectorController(ctx);
		const showOAuth = mock(() => undefined);
		controller.showOAuthSelector = showOAuth as unknown as SelectorController["showOAuthSelector"];

		controller.showProviderOnboarding();
		let routed = ctx.ui.focused as ProviderOnboardingSelectorComponent;
		routed.handleInput("\x1b[B");
		routed.handleInput("\n");
		expect(showOAuth).toHaveBeenCalledWith("login");

		controller.showProviderOnboarding();
		routed = ctx.ui.focused as ProviderOnboardingSelectorComponent;
		routed.handleInput("\x1b[B");
		routed.handleInput("\x1b[B");
		routed.handleInput("\n");
		expect(ctx.statuses.join("\n")).toContain("Custom API-compatible provider setup:");
	});
});

function createControllerContext(
	modelRegistry: Pick<ModelRegistry, "refresh">,
	notifyConfigChanged?: () => void,
): InteractiveModeContext & {
	statuses: string[];
	ui: { focused?: unknown; requestRender: () => void; setFocus: (component: unknown) => void };
} {
	const children: unknown[] = [];
	const editor = {};
	const statuses: string[] = [];
	return {
		ui: {
			focused: undefined as unknown,
			requestRender: () => undefined,
			setFocus(component: unknown) {
				this.focused = component;
			},
		},
		editor,
		editorContainer: {
			clear: () => {
				children.length = 0;
			},
			addChild: (child: unknown) => {
				children.push(child);
			},
		},
		session: { modelRegistry, scopedModels: [] },
		sessionManager: { getCwd: () => process.cwd() },
		settings: createSettingsStub(),
		showStatus: (message: string) => statuses.push(message),
		showError: (message: string) => statuses.push(message),
		showWarning: (message: string) => statuses.push(message),
		notifyConfigChanged,
		statuses,
	} as unknown as InteractiveModeContext & {
		statuses: string[];
		ui: { focused?: unknown; requestRender: () => void; setFocus: (component: unknown) => void };
	};
}

function createSettingsStub(): unknown {
	return {
		get(path: string) {
			if (path === "task.agentModelOverrides") return {};
			return undefined;
		},
		getStorage() {
			return { getModelUsageOrder: () => undefined };
		},
		getModelRole() {
			return undefined;
		},
		setModelRole() {
			return undefined;
		},
	};
}
