import { beforeAll, describe, expect, it, mock } from "bun:test";
import { getOAuthProviders } from "@gajae-code/ai/utils/oauth";
import { sortRankedProviders } from "@gajae-code/coding-agent/config/provider-ranking";
import { KiroLoginMethodSelectorComponent } from "@gajae-code/coding-agent/modes/components/kiro-login-method-selector";
import { OAuthSelectorComponent } from "@gajae-code/coding-agent/modes/components/oauth-selector";
import { SelectorController } from "@gajae-code/coding-agent/modes/controllers/selector-controller";
import { OAuthManualInputManager } from "@gajae-code/coding-agent/modes/oauth-manual-input";
import { getThemeByName, setThemeInstance } from "@gajae-code/coding-agent/modes/theme/theme";
import type { InteractiveModeContext } from "@gajae-code/coding-agent/modes/types";
import { executeBuiltinSlashCommand } from "@gajae-code/coding-agent/slash-commands/builtin-registry";
import { Container } from "@gajae-code/tui";

const testTheme = await getThemeByName("red-claw");

beforeAll(() => {
	if (!testTheme) throw new Error("Failed to load test theme");
	setThemeInstance(testTheme);
});

type SelectorHarness = { editorContainer: Container };

function createHarness() {
	const editor = new Container();
	const editorContainer = new Container();
	const login = mock(async (_providerId: string) => {});
	const logout = mock(async (_providerId: string) => {});
	const setActiveModelProfile = mock(async (_profileId: string) => {});
	const errors: string[] = [];
	const ui = { setFocus: mock(() => {}), requestRender: mock(() => {}) };
	const ctx = {
		editor,
		editorContainer,
		chatContainer: new Container(),
		ui,
		showStatus: mock(() => {}),
		showError: (message: string) => errors.push(message),
		showHookConfirm: mock(async () => false),
		openInBrowser: mock(() => {}),
		oauthManualInput: new OAuthManualInputManager(),
		settings: { get: () => undefined },
		session: {
			sessionId: "kiro-selector-test",
			setActiveModelProfile,
			modelRegistry: {
				authStorage: { hasAuth: () => false, login, logout },
				refresh: mock(async () => {}),
				getApiKeyForProvider: mock(async () => undefined),
				getModelProfiles: () => new Map(),
			},
		},
	} as unknown as InteractiveModeContext;

	return {
		controller: new SelectorController(ctx),
		editor,
		editorContainer,
		errors,
		login,
		logout,
		setActiveModelProfile,
		ui,
	};
}

function activeSelector(harness: SelectorHarness): OAuthSelectorComponent | KiroLoginMethodSelectorComponent {
	const selector = harness.editorContainer.children[0];
	if (!(selector instanceof OAuthSelectorComponent || selector instanceof KiroLoginMethodSelectorComponent)) {
		throw new Error("Expected an OAuth selector");
	}
	return selector;
}

function stripAnsi(text: string): string {
	return text.replace(/\x1b\[[0-9;]*m/g, "");
}

/**
 * The login selector renders providers in ranked order (existing, then famous,
 * then the rest by label), so Kiro's row is found by its ranked position rather
 * than its `getOAuthProviders()` position.
 */
function rankedProviderIds(): string[] {
	return sortRankedProviders(
		getOAuthProviders().map(provider => ({ id: provider.id, label: provider.name, authState: "none" as const })),
	).map(entry => entry.id);
}

function focusKiroInTopLevel(harness: SelectorHarness): OAuthSelectorComponent {
	const selector = activeSelector(harness);
	if (!(selector instanceof OAuthSelectorComponent)) throw new Error("Expected the top-level OAuth selector");
	const kiroIndex = rankedProviderIds().indexOf("kiro");
	if (kiroIndex < 0) throw new Error("Kiro OAuth provider is unavailable");
	for (let index = 0; index < kiroIndex; index += 1) selector.handleInput("\x1b[B");
	return selector;
}

function selectKiroFromTopLevel(harness: SelectorHarness): void {
	focusKiroInTopLevel(harness).handleInput("\n");
}

describe("SelectorController Kiro login routing", () => {
	it("renders Kiro as the neutral top-level provider label", async () => {
		const harness = createHarness();

		await harness.controller.showOAuthSelector("login");
		const selector = focusKiroInTopLevel(harness);

		const lines = stripAnsi(selector.render(120).join("\n")).split("\n");
		const labels = lines.map(line => line.replace(/^\s*[^\p{L}(]*\s*/u, "").trim());
		expect(labels).toContain("Kiro");
		// The top-level row must stay method-neutral: no "Kiro (AWS Builder ID)"
		// style variants and no identity-method rows leaking up from the nested
		// selector.
		const rendered = lines.join("\n");
		expect(rendered).not.toContain("Kiro (");
		expect(rendered).not.toContain("AWS Builder ID");
	});
	it("opens the nested selector for direct Kiro login without invoking OAuth", async () => {
		const harness = createHarness();

		await harness.controller.showOAuthSelector("login", "kiro");

		expect(activeSelector(harness)).toBeInstanceOf(KiroLoginMethodSelectorComponent);
		expect(harness.login).not.toHaveBeenCalled();
	});

	it("routes top-level Kiro selection into the nested selector", async () => {
		const harness = createHarness();

		await harness.controller.showOAuthSelector("login");
		selectKiroFromTopLevel(harness);

		expect(activeSelector(harness)).toBeInstanceOf(KiroLoginMethodSelectorComponent);
		expect(harness.login).not.toHaveBeenCalled();
	});

	it("starts Kiro OAuth for all three personal methods", async () => {
		const harness = createHarness();
		await harness.controller.showOAuthSelector("login", "kiro");
		let selector = activeSelector(harness) as KiroLoginMethodSelectorComponent;

		selector.handleInput("\n");
		await Promise.resolve();
		expect(harness.login).toHaveBeenCalledTimes(1);

		await harness.controller.showOAuthSelector("login", "kiro");
		selector = activeSelector(harness) as KiroLoginMethodSelectorComponent;
		selector.handleInput("\x1b[B");
		selector.handleInput("\n");
		await Promise.resolve();
		expect(harness.login).toHaveBeenCalledTimes(2);

		await harness.controller.showOAuthSelector("login", "kiro");
		selector = activeSelector(harness) as KiroLoginMethodSelectorComponent;
		selector.handleInput("\x1b[B");
		selector.handleInput("\x1b[B");
		selector.handleInput("\n");
		await Promise.resolve();
		expect(harness.login).toHaveBeenCalledTimes(3);
		expect(harness.login.mock.calls.map(call => call[0])).toEqual(["kiro", "kiro", "kiro"]);
		expect(harness.setActiveModelProfile).not.toHaveBeenCalled();
	});

	it("bypasses the nested selector for Kiro logout", async () => {
		const harness = createHarness();

		await harness.controller.showOAuthSelector("logout", "kiro");

		expect(harness.logout).toHaveBeenCalledWith("kiro");
		expect(harness.editorContainer.children).toEqual([]);
	});

	it("restores editor focus and does not log in when the nested selector is cancelled", async () => {
		const harness = createHarness();
		await harness.controller.showOAuthSelector("login", "kiro");

		(activeSelector(harness) as KiroLoginMethodSelectorComponent).handleInput("\x1b");

		expect(harness.login).not.toHaveBeenCalled();
		expect(harness.editorContainer.children).toEqual([harness.editor]);
		expect(harness.ui.setFocus).toHaveBeenLastCalledWith(harness.editor);
	});

	it("routes /login kiro to the direct Kiro selector entry point", async () => {
		const manualInput = new OAuthManualInputManager();
		const showOAuthSelector = mock(async (_mode: "login" | "logout", _providerId?: string) => {});
		const ctx = {
			oauthManualInput: manualInput,
			editor: { setText: () => {} },
			showOAuthSelector,
		} as unknown as InteractiveModeContext;

		await executeBuiltinSlashCommand("/login kiro", { ctx, handleBackgroundCommand: () => {} });

		expect(showOAuthSelector).toHaveBeenCalledWith("login", "kiro");
	});
});
