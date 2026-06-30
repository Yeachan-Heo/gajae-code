import { Container, Input, matchesKey, Spacer, Text, TruncatedText } from "@gajae-code/tui";
import { MODEL_PROFILE_NAME_PATTERN } from "../../config/model-registry";
import type { ModelProfileConfig } from "../../config/models-config-schema";
import { theme } from "../theme/theme";
import { matchesAppInterrupt } from "../utils/keybinding-matchers";
import { DynamicBorder } from "./dynamic-border";
export interface CustomModelPresetWizardSubmit {
	name: string;
	profile: ModelProfileConfig;
}

export class CustomModelPresetWizardComponent extends Container {
	#contentContainer: Container;
	#input: Input | null = null;
	#lastError: string | null = null;
	#name = "";
	#snapshot: ModelProfileConfig;
	#onSubmit: (input: CustomModelPresetWizardSubmit) => void;
	#onCancel: () => void;
	#onRender: () => void;

	constructor(
		snapshot: ModelProfileConfig,
		onSubmit: (input: CustomModelPresetWizardSubmit) => void,
		onCancel: () => void,
		onRender: () => void = () => {},
	) {
		super();
		this.#snapshot = snapshot;
		this.#onSubmit = onSubmit;
		this.#onCancel = onCancel;
		this.#onRender = onRender;

		this.addChild(new DynamicBorder());
		this.addChild(new Spacer(1));
		this.addChild(new TruncatedText(theme.bold("Create custom model preset")));
		this.addChild(
			new TruncatedText(
				theme.fg("muted", "  Save the current default and explicit role models as a selectable profile."),
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
			this.#onCancel();
			return;
		}

		if (this.#input) {
			if (matchesKey(keyData, "enter") || matchesKey(keyData, "return") || keyData === "\n") {
				this.#saveInputAndSubmit();
				return;
			}
			this.#input.handleInput(keyData);
		}
	}

	#renderStep(): void {
		this.#contentContainer.clear();
		this.#input = null;
		this.#contentContainer.addChild(new Text(theme.fg("accent", "Preset id")));
		this.#contentContainer.addChild(new Spacer(1));
		if (this.#lastError) {
			this.#contentContainer.addChild(new Text(theme.fg("error", this.#lastError), 0, 0));
			this.#contentContainer.addChild(new Spacer(1));
		}
		this.#contentContainer.addChild(new Text("Enter a unique preset id:", 0, 0));
		this.#contentContainer.addChild(new Spacer(1));
		this.#input = new Input();
		this.#input.setValue(this.#name);
		this.#contentContainer.addChild(this.#input);
		this.#contentContainer.addChild(new Spacer(1));
		this.#addSnapshotPreview();
		this.#addHelp("e.g. my-fast-coder");
		this.#addHelp("[Enter to create, Esc to cancel]");
	}

	#addSnapshotPreview(): void {
		this.#contentContainer.addChild(new Text(theme.fg("muted", "Snapshot:"), 0, 0));
		for (const [role, selector] of Object.entries(this.#snapshot.model_mapping)) {
			this.#contentContainer.addChild(new Text(`  ${role}: ${selector}`, 0, 0));
		}
		this.#contentContainer.addChild(new Text(`  providers: ${this.#snapshot.required_providers.join(", ")}`, 0, 0));
		this.#contentContainer.addChild(new Spacer(1));
	}

	#addHelp(text: string): void {
		this.#contentContainer.addChild(new Text(theme.fg("muted", text), 0, 0));
	}

	#saveInputAndSubmit(): void {
		const value = this.#input?.getValue().trim() ?? "";
		if (!value) {
			this.#lastError = "Preset id is required.";
			this.#renderStep();
			this.#onRender();
			return;
		}
		if (!MODEL_PROFILE_NAME_PATTERN.test(value)) {
			this.#lastError = "Preset id must use lowercase letters, numbers, dots, underscores, or hyphens.";
			this.#renderStep();
			this.#onRender();
			return;
		}
		this.#name = value;
		this.#lastError = null;
		this.#onSubmit({
			name: value,
			profile: {
				...this.#snapshot,
				display_name: value,
				model_mapping: { ...this.#snapshot.model_mapping },
				required_providers: [...this.#snapshot.required_providers],
			},
		});
	}
}
