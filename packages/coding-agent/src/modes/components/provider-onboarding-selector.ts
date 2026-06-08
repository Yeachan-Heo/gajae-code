import { Container, matchesKey, Spacer, TruncatedText } from "@gajae-code/tui";
import { theme } from "../../modes/theme/theme";
import { matchesSelectCancel } from "../../modes/utils/keybinding-matchers";
import { formatModelOnboardingGuidance } from "../../setup/model-onboarding-guidance";
import { DynamicBorder } from "./dynamic-border";

export type ProviderOnboardingAction = "custom-provider-wizard" | "oauth-login" | "api-guide";

interface ProviderOnboardingOption {
	label: string;
	description: string;
	action: ProviderOnboardingAction;
}

const PROVIDER_ONBOARDING_OPTIONS: ProviderOnboardingOption[] = [
	{
		label: "Add custom provider",
		description: "Configure an OpenAI- or Anthropic-compatible API provider interactively.",
		action: "custom-provider-wizard",
	},
	{
		label: "Login with OAuth/subscription",
		description: "Open the interactive OAuth provider selector.",
		action: "oauth-login",
	},
	{
		label: "Add API-compatible provider",
		description: "Show the /provider add and gjc setup provider commands.",
		action: "api-guide",
	},
];

export class ProviderOnboardingSelectorComponent extends Container {
	#listContainer: Container;
	#onCancel: () => void;
	#onSelect: (action: ProviderOnboardingAction) => void;
	#selectedIndex = 0;

	constructor(onSelect: (action: ProviderOnboardingAction) => void, onCancel: () => void) {
		super();
		this.#onSelect = onSelect;
		this.#onCancel = onCancel;
		this.addChild(new DynamicBorder());
		this.addChild(new Spacer(1));
		this.addChild(new TruncatedText(theme.bold("Provider onboarding")));
		this.addChild(new TruncatedText(theme.fg("muted", "  Choose how to configure models for this session."), 0, 0));
		this.addChild(new Spacer(1));
		this.#listContainer = new Container();
		this.addChild(this.#listContainer);
		this.addChild(new Spacer(1));
		for (const line of formatModelOnboardingGuidance().split("\n")) {
			this.addChild(new TruncatedText(theme.fg("dim", `  ${line}`), 0, 0));
		}
		this.addChild(new Spacer(1));
		this.addChild(new DynamicBorder());
		this.#updateList();
	}

	#updateList(): void {
		this.#listContainer.clear();
		for (let i = 0; i < PROVIDER_ONBOARDING_OPTIONS.length; i++) {
			const option = PROVIDER_ONBOARDING_OPTIONS[i];
			if (!option) continue;
			const selected = i === this.#selectedIndex;
			const prefix = selected ? theme.fg("accent", `${theme.nav.cursor} `) : "  ";
			const label = selected ? theme.fg("accent", option.label) : option.label;
			this.#listContainer.addChild(new TruncatedText(`${prefix}${label}`, 0, 0));
			this.#listContainer.addChild(new TruncatedText(theme.fg("muted", `    ${option.description}`), 0, 0));
		}
	}

	handleInput(keyData: string): void {
		if (matchesKey(keyData, "up")) {
			this.#selectedIndex =
				this.#selectedIndex === 0 ? PROVIDER_ONBOARDING_OPTIONS.length - 1 : this.#selectedIndex - 1;
			this.#updateList();
			return;
		}
		if (matchesKey(keyData, "down")) {
			this.#selectedIndex = (this.#selectedIndex + 1) % PROVIDER_ONBOARDING_OPTIONS.length;
			this.#updateList();
			return;
		}
		if (matchesKey(keyData, "enter")) {
			const option = PROVIDER_ONBOARDING_OPTIONS[this.#selectedIndex];
			if (option) this.#onSelect(option.action);
			return;
		}
		if (matchesSelectCancel(keyData)) {
			this.#onCancel();
		}
	}
}
