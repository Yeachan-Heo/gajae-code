import { describe, expect, it } from "bun:test";
import { OAuthManualInputManager } from "@gajae-code/coding-agent/modes/oauth-manual-input";
import type { InteractiveModeContext } from "@gajae-code/coding-agent/modes/types";
import { executeBuiltinSlashCommand } from "@gajae-code/coding-agent/slash-commands/builtin-registry";

type RuntimeHarness = {
	runtime: { ctx: InteractiveModeContext; handleBackgroundCommand: () => void };
	getStatus: () => string | undefined;
	getWarning: () => string | undefined;
	getSelectorMode: () => "login" | "logout" | undefined;
	getSelectorProvider: () => string | undefined;
	getProviderOnboardingShown: () => boolean;
};

const createRuntimeHarness = (manualInput: OAuthManualInputManager): RuntimeHarness => {
	let statusMessage: string | undefined;
	let warningMessage: string | undefined;
	let selectorMode: "login" | "logout" | undefined;
	let selectorProvider: string | undefined;
	let providerOnboardingShown = false;
	const ctx = {
		oauthManualInput: manualInput,
		editor: {
			setText: () => {},
		} as unknown as InteractiveModeContext["editor"],
		showStatus: (message: string) => {
			statusMessage = message;
		},
		showWarning: (message: string) => {
			warningMessage = message;
		},
		showOAuthSelector: async (mode: "login" | "logout", providerId?: string) => {
			selectorMode = mode;
			selectorProvider = providerId;
		},
		showProviderOnboarding: () => {
			providerOnboardingShown = true;
		},
	} as InteractiveModeContext;

	return {
		runtime: {
			ctx,
			handleBackgroundCommand: () => {},
		},
		getStatus: () => statusMessage,
		getWarning: () => warningMessage,
		getSelectorMode: () => selectorMode,
		getSelectorProvider: () => selectorProvider,
		getProviderOnboardingShown: () => providerOnboardingShown,
	};
};

describe("/login slash command", () => {
	it("submits manual callback URL without opening selector", async () => {
		const manualInput = new OAuthManualInputManager();
		const callbackUrl = "http://localhost:1455/auth/callback?code=abc&state=xyz";
		const pending = manualInput.waitForInput("openai-codex");
		const harness = createRuntimeHarness(manualInput);

		const handled = await executeBuiltinSlashCommand(`/login ${callbackUrl}`, harness.runtime);

		expect(handled).toBe(true);
		expect(harness.getSelectorMode()).toBeUndefined();
		expect(harness.getStatus()).toBe("OAuth callback received; completing login…");
		expect(await pending).toBe(callbackUrl);
	});

	it("opens login selector with external discovery gate when no args are provided", async () => {
		const manualInput = new OAuthManualInputManager();
		const harness = createRuntimeHarness(manualInput);

		const handled = await executeBuiltinSlashCommand("/login", harness.runtime);

		expect(handled).toBe(true);
		expect(harness.getProviderOnboardingShown()).toBe(false);
		expect(harness.getSelectorMode()).toBe("login");
		expect(harness.getSelectorProvider()).toBeUndefined();
	});

	it("routes /login kagi to direct provider login", async () => {
		const manualInput = new OAuthManualInputManager();
		const harness = createRuntimeHarness(manualInput);

		const handled = await executeBuiltinSlashCommand("/login kagi", harness.runtime);

		expect(handled).toBe(true);
		expect(harness.getSelectorMode()).toBe("login");
		expect(harness.getSelectorProvider()).toBe("kagi");
	});

	it("routes /login parallel to direct provider login", async () => {
		const manualInput = new OAuthManualInputManager();
		const harness = createRuntimeHarness(manualInput);

		const handled = await executeBuiltinSlashCommand("/login parallel", harness.runtime);

		expect(handled).toBe(true);
		expect(harness.getSelectorMode()).toBe("login");
		expect(harness.getSelectorProvider()).toBe("parallel");
	});

	it("warns when no pending login exists for manual callback", async () => {
		const manualInput = new OAuthManualInputManager();
		const harness = createRuntimeHarness(manualInput);

		const handled = await executeBuiltinSlashCommand("/login http://localhost/callback", harness.runtime);

		expect(handled).toBe(true);
		expect(harness.getSelectorMode()).toBeUndefined();
		expect(harness.getWarning()).toBe("No OAuth login is waiting for a manual callback.");
	});
});

describe("interactive provider/model auth slash wiring", () => {
	it("routes /logout provider to provider-specific interactive logout", async () => {
		const manualInput = new OAuthManualInputManager();
		const harness = createRuntimeHarness(manualInput);

		const handled = await executeBuiltinSlashCommand("/logout kagi", harness.runtime);

		expect(handled).toBe(true);
		expect(harness.getSelectorMode()).toBe("logout");
		expect(harness.getSelectorProvider()).toBe("kagi");
	});

	it("opens the model selector for /model in TUI", async () => {
		let modelSelectorShown = false;
		let editorText: string | undefined;
		const ctx = {
			editor: { setText: (text: string) => (editorText = text) } as unknown as InteractiveModeContext["editor"],
			showModelSelector: () => {
				modelSelectorShown = true;
			},
		} as InteractiveModeContext;

		const handled = await executeBuiltinSlashCommand("/model", { ctx, handleBackgroundCommand: () => {} });

		expect(handled).toBe(true);
		expect(modelSelectorShown).toBe(true);
		expect(editorText).toBe("");
	});

	it("opens provider onboarding selector for bare /provider in TUI", async () => {
		let providerOnboardingShown = false;
		let editorText: string | undefined;
		const ctx = {
			editor: { setText: (text: string) => (editorText = text) } as unknown as InteractiveModeContext["editor"],
			showProviderOnboarding: () => {
				providerOnboardingShown = true;
			},
		} as InteractiveModeContext;

		const handled = await executeBuiltinSlashCommand("/provider", { ctx, handleBackgroundCommand: () => {} });

		expect(handled).toBe(true);
		expect(providerOnboardingShown).toBe(true);
		expect(editorText).toBe("");
	});

	it("routes /provider login provider to the OAuth selector", async () => {
		const manualInput = new OAuthManualInputManager();
		const harness = createRuntimeHarness(manualInput);

		const handled = await executeBuiltinSlashCommand("/provider login kagi", harness.runtime);

		expect(handled).toBe(true);
		expect(harness.getSelectorMode()).toBe("login");
		expect(harness.getSelectorProvider()).toBe("kagi");
	});
});
