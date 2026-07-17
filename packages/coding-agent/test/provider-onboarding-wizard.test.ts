import { afterEach, beforeAll, describe, expect, it, mock } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { AuthStorage, SqliteAuthCredentialStore } from "@gajae-code/ai";
import { ModelRegistry } from "@gajae-code/coding-agent/config/model-registry";
import {
	CustomProviderWizardComponent,
	type CustomProviderWizardSubmit,
} from "@gajae-code/coding-agent/modes/components/custom-provider-wizard";
import {
	type ProviderOnboardingAction,
	ProviderOnboardingSelectorComponent,
} from "@gajae-code/coding-agent/modes/components/provider-onboarding-selector";
import { SelectorController } from "@gajae-code/coding-agent/modes/controllers/selector-controller";
import { initTheme } from "@gajae-code/coding-agent/modes/theme/theme";
import type { InteractiveModeContext } from "@gajae-code/coding-agent/modes/types";
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
	return Bun.stripANSI(component.render(160).join("\n"));
}

function typeText(component: { handleInput(input: string): void }, text: string): void {
	for (const char of text) component.handleInput(char);
}

function driveEnvWizard(
	component: CustomProviderWizardComponent,
	options?: { providerId?: string; model?: string },
): void {
	component.handleInput("\n");
	typeText(component, options?.providerId ?? "custom-openai");
	component.handleInput("\n");
	typeText(component, "https://api.example.com/v1");
	component.handleInput("\n");
	component.handleInput("\n");
	typeText(component, "CUSTOM_PROVIDER_KEY");
	component.handleInput("\n");
	typeText(component, options?.model ?? "custom-model");
	component.handleInput("\n");
}

describe("provider onboarding wizard", () => {
	it("shows Add custom provider as the first /login onboarding option", () => {
		const actions: ProviderOnboardingAction[] = [];
		const selector = new ProviderOnboardingSelectorComponent(
			action => actions.push(action),
			() => undefined,
		);

		const rendered = visibleText(selector);
		expect(rendered.indexOf("Add custom provider")).toBeLessThan(rendered.indexOf("Login with OAuth/subscription"));
		expect(rendered).toContain("Add API-compatible provider");

		selector.handleInput("\n");
		expect(actions).toEqual(["custom-provider-wizard"]);
	});

	it("emits the expected addApiCompatibleProvider input", () => {
		const submissions: unknown[] = [];
		const wizard = new CustomProviderWizardComponent(
			input => submissions.push(input),
			() => undefined,
		);

		driveEnvWizard(wizard);
		wizard.handleInput("\n");

		expect(submissions).toEqual([
			{
				compatibility: "openai",
				providerId: "custom-openai",
				baseUrl: "https://api.example.com/v1",
				apiKeyEnv: "CUSTOM_PROVIDER_KEY",
				apiKey: undefined,
				models: ["custom-model"],
				force: false,
			},
		]);
	});

	it("preserves literal credentials for force confirmation and clears them on completion", () => {
		const submissions: CustomProviderWizardSubmit[] = [];
		const wizard = new CustomProviderWizardComponent(
			input => submissions.push(input),
			() => undefined,
		);

		wizard.handleInput("\n");
		typeText(wizard, "literal-provider");
		wizard.handleInput("\n");
		typeText(wizard, "https://api.example.com/v1");
		wizard.handleInput("\n");
		wizard.handleInput("\x1b[B");
		wizard.handleInput("\n");
		typeText(wizard, "literal-secret");
		expect(visibleText(wizard)).not.toContain("literal-secret");
		wizard.handleInput("\n");
		typeText(wizard, "literal-model");
		wizard.handleInput("\n");
		wizard.handleInput("\n");
		wizard.setSubmitError("Provider setup failed: Provider 'literal-provider' already exists.");
		wizard.handleInput("\x1b[B");
		wizard.handleInput("\n");

		expect(submissions).toEqual([
			expect.objectContaining({ apiKey: "literal-secret", apiKeyEnv: undefined, force: false }),
			expect.objectContaining({ apiKey: "literal-secret", apiKeyEnv: undefined, force: true }),
		]);

		wizard.complete();
		wizard.handleInput("\n");
		expect(submissions.at(-1)).toEqual(expect.objectContaining({ apiKey: "", force: true }));
	});

	it("requires explicit force confirmation before overwrite", () => {
		const submissions: unknown[] = [];
		const wizard = new CustomProviderWizardComponent(
			input => submissions.push(input),
			() => undefined,
		);

		driveEnvWizard(wizard);
		wizard.handleInput("\n");
		wizard.setSubmitError(
			"Provider setup failed: Provider 'custom-openai' already exists. Use --force to replace it.",
		);
		wizard.handleInput("\x1b[B");
		wizard.handleInput("\n");

		expect(submissions).toEqual([
			expect.objectContaining({ force: false }),
			expect.objectContaining({ force: true }),
		]);
	});

	it("refreshes offline after success and exposes the provider in model selector data without restart", async () => {
		tempAgentDir = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-provider-wizard-"));
		setAgentDir(tempAgentDir);
		const store = await SqliteAuthCredentialStore.open(path.join(tempAgentDir, "agent.db"));
		try {
			const authStorage = new AuthStorage(store);
			const registry = new ModelRegistry(authStorage, path.join(tempAgentDir, "models.yml"));
			let refreshedMode: string | undefined;
			const originalRefresh = registry.refresh.bind(registry);
			registry.refresh = async mode => {
				refreshedMode = mode;
				await originalRefresh(mode);
			};
			let configChanged = false;
			const ctx = createControllerContext(registry, () => {
				configChanged = true;
			});
			const controller = new SelectorController(ctx);

			controller.showCustomProviderWizard();
			const wizard = ctx.ui.focused as CustomProviderWizardComponent;
			driveEnvWizard(wizard, { providerId: "live-provider", model: "live-model" });
			wizard.handleInput("\n");
			await Bun.sleep(1_000);

			expect(refreshedMode).toBe("offline");
			expect(configChanged).toBe(true);
			expect(registry.find("live-provider", "live-model")).toBeDefined();
			expect(ctx.statuses.join("\n")).toContain("Provider 'live-provider' configured");
		} finally {
			store.close();
		}
	});

	it("keeps OAuth and API guide onboarding actions routed", () => {
		const ctx = createControllerContext({ refresh: async () => undefined } as unknown as ModelRegistry);
		const controller = new SelectorController(ctx);
		const showOAuth = mock(() => undefined);
		controller.showOAuthSelector = showOAuth as unknown as SelectorController["showOAuthSelector"];

		controller.showProviderOnboarding();
		let selector = ctx.ui.focused as ProviderOnboardingSelectorComponent;
		selector.handleInput("\x1b[B");
		selector.handleInput("\n");
		expect(showOAuth).toHaveBeenCalledWith("login");

		controller.showProviderOnboarding();
		selector = ctx.ui.focused as ProviderOnboardingSelectorComponent;
		selector.handleInput("\x1b[B");
		selector.handleInput("\x1b[B");
		selector.handleInput("\n");
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
		session: { modelRegistry },
		sessionManager: { getCwd: () => process.cwd() },
		settings: {},
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
