import { Container, Input, matchesKey, Spacer, Text, TruncatedText } from "@gajae-code/tui";
import type { ModelProfileConfig } from "../../config/models-config-schema";
import { theme } from "../theme/theme";
import { matchesAppInterrupt } from "../utils/keybinding-matchers";
import { DynamicBorder } from "./dynamic-border";

const PROFILE_NAME_PATTERN = /^[a-z0-9][a-z0-9._-]*$/;

type WizardStep = "name" | "display-name" | "provider" | "model" | "confirm";

interface WizardState {
	name: string;
	displayName: string;
	provider: string;
	model: string;
}

export interface CustomModelPresetWizardSubmit {
	name: string;
	profile: ModelProfileConfig;
}

export class CustomModelPresetWizardComponent extends Container {
	#contentContainer: Container;
	#input: Input | null = null;
	#step: WizardStep = "name";
	#selectedIndex = 0;
	#lastError: string | null = null;
	#state: WizardState = {
		name: "",
		displayName: "",
		provider: "",
		model: "",
	};
	#onSubmit: (input: CustomModelPresetWizardSubmit) => void;
	#onCancel: () => void;
	#onRender: () => void;

	constructor(
		onSubmit: (input: CustomModelPresetWizardSubmit) => void,
		onCancel: () => void,
		onRender: () => void = () => {},
	) {
		super();
		this.#onSubmit = onSubmit;
		this.#onCancel = onCancel;
		this.#onRender = onRender;

		this.addChild(new DynamicBorder());
		this.addChild(new Spacer(1));
		this.addChild(new TruncatedText(theme.bold("Create custom model preset")));
		this.addChild(
			new TruncatedText(
				theme.fg("muted", "  Save provider/model as a selectable profile. Secrets are not requested."),
				0,
				0,
			),
		);
		this.addChild(new Spacer(1));
		this.#contentContainer = new Container();
		this.addChild(this.#contentContainer);
		this.addChild(new Spacer(1));
		this.addChild(new DynamicBorder());
		this.#renderStep();
	}

	setSubmitError(error: string): void {
		this.#lastError = error;
		this.#renderStep();
		this.#onRender();
	}

	handleInput(keyData: string): void {
		if (matchesAppInterrupt(keyData)) {
			if (this.#step === "name") {
				this.#onCancel();
				return;
			}
			this.#goBack();
			return;
		}

		if (this.#input) {
			if (matchesKey(keyData, "enter") || matchesKey(keyData, "return") || keyData === "\n") {
				this.#saveInputAndProceed();
				return;
			}
			this.#input.handleInput(keyData);
			return;
		}

		if (matchesKey(keyData, "up")) {
			this.#moveSelection(-1);
			return;
		}
		if (matchesKey(keyData, "down")) {
			this.#moveSelection(1);
			return;
		}
		if (matchesKey(keyData, "enter") || matchesKey(keyData, "return") || keyData === "\n") {
			this.#selectCurrentOption();
		}
	}

	#renderStep(): void {
		this.#contentContainer.clear();
		this.#input = null;
		switch (this.#step) {
			case "name":
				this.#renderInputStep(
					"Step 1: Preset id",
					"Enter a unique preset id:",
					this.#state.name,
					"e.g. my-fast-coder",
				);
				break;
			case "display-name":
				this.#renderInputStep(
					"Step 2: Display name",
					"Enter a display name:",
					this.#state.displayName,
					"e.g. My Fast Coder",
				);
				break;
			case "provider":
				this.#renderInputStep(
					"Step 3: Provider",
					"Enter the provider id:",
					this.#state.provider,
					"e.g. openai-codex, anthropic, my-oai",
				);
				break;
			case "model":
				this.#renderInputStep(
					"Step 4: Model",
					"Enter the model id or provider/model selector:",
					this.#state.model,
					"e.g. gpt-5.5:medium or my-oai/gpt-example:low",
				);
				break;
			case "confirm":
				this.#renderConfirmStep();
				break;
		}
	}

	#renderInputStep(title: string, prompt: string, value: string, hint: string): void {
		this.#contentContainer.addChild(new Text(theme.fg("accent", title)));
		this.#contentContainer.addChild(new Spacer(1));
		if (this.#lastError) {
			this.#contentContainer.addChild(new Text(theme.fg("error", this.#lastError), 0, 0));
			this.#contentContainer.addChild(new Spacer(1));
		}
		this.#contentContainer.addChild(new Text(prompt, 0, 0));
		this.#contentContainer.addChild(new Spacer(1));
		this.#input = new Input();
		this.#input.setValue(value);
		this.#contentContainer.addChild(this.#input);
		this.#contentContainer.addChild(new Spacer(1));
		this.#addHelp(hint);
		this.#addHelp("[Enter to continue, Esc to go back]");
	}

	#renderConfirmStep(): void {
		this.#contentContainer.addChild(new Text(theme.fg("accent", "Confirm custom preset")));
		this.#contentContainer.addChild(new Spacer(1));
		if (this.#lastError) {
			this.#contentContainer.addChild(new Text(theme.fg("error", this.#lastError), 0, 0));
			this.#contentContainer.addChild(new Spacer(1));
		}
		this.#contentContainer.addChild(new Text(`Preset id: ${this.#state.name}`, 0, 0));
		this.#contentContainer.addChild(new Text(`Display name: ${this.#state.displayName}`, 0, 0));
		this.#contentContainer.addChild(new Text(`Provider: ${this.#state.provider}`, 0, 0));
		this.#contentContainer.addChild(new Text(`Default model: ${this.#selector()}`, 0, 0));
		this.#contentContainer.addChild(new Spacer(1));
		this.#addOption(0, "Create preset");
		this.#addOption(1, "Go back");
		this.#addHelp("[↑↓ to navigate, Enter to select, Esc to go back]");
	}

	#addOption(index: number, label: string): void {
		const selected = index === this.#selectedIndex;
		const prefix = selected ? theme.fg("accent", `${theme.nav.cursor} `) : "  ";
		this.#contentContainer.addChild(new Text(`${prefix}${selected ? theme.fg("accent", label) : label}`, 0, 0));
	}

	#addHelp(text: string): void {
		this.#contentContainer.addChild(new Text(theme.fg("muted", text), 0, 0));
	}

	#saveInputAndProceed(): void {
		const value = this.#input?.getValue().trim() ?? "";
		if (!value) {
			this.#lastError = this.#emptyFieldMessage();
			this.#renderStep();
			this.#onRender();
			return;
		}
		const validationError = this.#validateCurrentInput(value);
		if (validationError) {
			this.#lastError = validationError;
			this.#renderStep();
			this.#onRender();
			return;
		}
		this.#lastError = null;
		if (this.#step === "name") {
			this.#state.name = value;
			this.#step = "display-name";
		} else if (this.#step === "display-name") {
			this.#state.displayName = value;
			this.#step = "provider";
		} else if (this.#step === "provider") {
			this.#state.provider = value;
			this.#step = "model";
		} else if (this.#step === "model") {
			this.#state.model = value;
			this.#step = "confirm";
			this.#selectedIndex = 0;
		}
		this.#renderStep();
		this.#onRender();
	}

	#emptyFieldMessage(): string {
		switch (this.#step) {
			case "name":
				return "Preset id is required.";
			case "display-name":
				return "Display name is required.";
			case "provider":
				return "Provider is required.";
			case "model":
				return "Model is required.";
			case "confirm":
				return "Value is required.";
		}
	}

	#validateCurrentInput(value: string): string | undefined {
		if (this.#step === "name" && !PROFILE_NAME_PATTERN.test(value)) {
			return "Preset id must use lowercase letters, numbers, dots, underscores, or hyphens.";
		}
		if (this.#step === "provider" && !PROFILE_NAME_PATTERN.test(value)) {
			return "Provider id must use lowercase letters, numbers, dots, underscores, or hyphens.";
		}
		if (this.#step === "model" && value.includes(",")) {
			return "Model must be one selector, not a comma-separated list.";
		}
		return undefined;
	}

	#selectCurrentOption(): void {
		if (this.#step !== "confirm") return;
		if (this.#selectedIndex === 0) {
			this.#onSubmit(this.#buildInput());
			return;
		}
		this.#goBack();
	}

	#buildInput(): CustomModelPresetWizardSubmit {
		return {
			name: this.#state.name,
			profile: {
				required_providers: [this.#state.provider],
				display_name: this.#state.displayName,
				model_mapping: { default: this.#selector() },
			},
		};
	}

	#selector(): string {
		return this.#state.model.includes("/") ? this.#state.model : `${this.#state.provider}/${this.#state.model}`;
	}

	#moveSelection(delta: number): void {
		this.#selectedIndex = (this.#selectedIndex + delta + 2) % 2;
		this.#renderStep();
		this.#onRender();
	}

	#goBack(): void {
		if (this.#step === "display-name") this.#step = "name";
		else if (this.#step === "provider") this.#step = "display-name";
		else if (this.#step === "model") this.#step = "provider";
		else if (this.#step === "confirm") this.#step = "model";
		this.#selectedIndex = 0;
		this.#lastError = null;
		this.#renderStep();
		this.#onRender();
	}
}
