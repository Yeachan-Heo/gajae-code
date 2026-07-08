import { getSupportedEfforts, type Model } from "@gajae-code/ai";
import { Container, Input, matchesKey, Spacer, Text, TruncatedText } from "@gajae-code/tui";
import { deriveRequiredProviders } from "../../config/model-profiles";
import type { GjcModelAssignmentTargetId, ModelRegistry } from "../../config/model-registry";
import { GJC_MODEL_ASSIGNMENT_TARGETS, MODEL_PROFILE_NAME_PATTERN } from "../../config/model-registry";
import type { ModelProfileConfig } from "../../config/models-config-schema";
import { theme } from "../theme/theme";
import { matchesAppInterrupt } from "../utils/keybinding-matchers";
import { DynamicBorder } from "./dynamic-border";
import { PROFILE_ROLE_PREVIEW_ORDER } from "./model-selector";

export interface CustomModelPresetWizardSubmit {
	name: string;
	profile: ModelProfileConfig;
}

/**
 * Options that switch the wizard from the default single-input create form into
 * the draft picker used to edit an existing custom preset. Providing this keeps
 * every create call site (which omits it) byte-identical.
 */
export interface CustomModelPresetWizardEditContext {
	mode: "edit";
	profileName: string;
	modelRegistry: Pick<ModelRegistry, "getAll">;
}

type EditPickerView = "roleList" | "modelPick" | "effortPick";

const NO_EXPLICIT_EFFORT = "__no_explicit_effort__";
const MODEL_PICK_WINDOW = 8;

function isPrintableCharacter(keyData: string): boolean {
	return keyData.length === 1 && keyData >= " " && keyData !== "\x7f";
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

	// Edit-mode state (unused in create mode).
	#mode: "create" | "edit";
	#profileName = "";
	#displayName: string | undefined;
	#modelRegistry: Pick<ModelRegistry, "getAll"> | null = null;
	#draftMapping: Partial<Record<GjcModelAssignmentTargetId, string>> = {};
	#view: EditPickerView = "roleList";
	#roleCursor = 0;
	#modelCursor = 0;
	#modelFilter = "";
	#effortCursor = 0;
	#pendingRole: GjcModelAssignmentTargetId | null = null;
	#pendingModel: Model | null = null;

	constructor(
		snapshot: ModelProfileConfig,
		onSubmit: (input: CustomModelPresetWizardSubmit) => void,
		onCancel: () => void,
		onRender: () => void = () => {},
		editContext?: CustomModelPresetWizardEditContext,
	) {
		super();
		this.#snapshot = snapshot;
		this.#onSubmit = onSubmit;
		this.#onCancel = onCancel;
		this.#onRender = onRender;
		this.#mode = editContext?.mode ?? "create";
		if (editContext) {
			this.#profileName = editContext.profileName;
			this.#modelRegistry = editContext.modelRegistry;
			this.#displayName = snapshot.display_name;
			this.#draftMapping = { ...snapshot.model_mapping };
		}

		this.addChild(new DynamicBorder());
		this.addChild(new Spacer(1));
		this.addChild(
			new TruncatedText(
				theme.bold(this.#mode === "edit" ? "Edit custom model preset" : "Create custom model preset"),
			),
		);
		this.addChild(
			new TruncatedText(
				theme.fg(
					"muted",
					this.#mode === "edit"
						? `  Update role model mappings for ${this.#profileName}. Preset id and display name stay the same.`
						: "  Save the current default and explicit role models as a selectable profile.",
				),
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
		if (this.#mode === "edit") {
			this.#handleEditInput(keyData);
			return;
		}

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
		if (this.#mode === "edit") {
			this.#renderEditStep();
			return;
		}
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

	// ---- Edit mode (draft picker) ----

	#roleListLength(): number {
		return PROFILE_ROLE_PREVIEW_ORDER.length + 1; // +1 for the Save row
	}

	#filteredModels(): Model[] {
		const all = this.#modelRegistry?.getAll() ?? [];
		const filter = this.#modelFilter.trim().toLowerCase();
		if (!filter) return [...all];
		return all.filter(model => `${model.provider}/${model.id}`.toLowerCase().includes(filter));
	}

	#effortOptions(): string[] {
		let efforts: readonly string[] = [];
		if (this.#pendingModel) {
			try {
				efforts = getSupportedEfforts(this.#pendingModel);
			} catch {
				efforts = [];
			}
		}
		return [...efforts, NO_EXPLICIT_EFFORT];
	}

	#handleEditInput(keyData: string): void {
		if (this.#view === "roleList") {
			this.#handleRoleListInput(keyData);
			return;
		}
		if (this.#view === "modelPick") {
			this.#handleModelPickInput(keyData);
			return;
		}
		this.#handleEffortPickInput(keyData);
	}

	#handleRoleListInput(keyData: string): void {
		if (matchesAppInterrupt(keyData)) {
			this.#onCancel();
			return;
		}
		const total = this.#roleListLength();
		if (matchesKey(keyData, "up")) {
			this.#roleCursor = this.#roleCursor === 0 ? total - 1 : this.#roleCursor - 1;
			this.#renderStep();
			this.#onRender();
			return;
		}
		if (matchesKey(keyData, "down")) {
			this.#roleCursor = (this.#roleCursor + 1) % total;
			this.#renderStep();
			this.#onRender();
			return;
		}
		if (keyData === "s" || keyData === "S") {
			this.#submitEdit();
			return;
		}
		if (matchesKey(keyData, "enter") || matchesKey(keyData, "return") || keyData === "\n") {
			if (this.#roleCursor >= PROFILE_ROLE_PREVIEW_ORDER.length) {
				this.#submitEdit();
				return;
			}
			const role = PROFILE_ROLE_PREVIEW_ORDER[this.#roleCursor];
			if (!role) return;
			this.#pendingRole = role;
			this.#view = "modelPick";
			this.#modelFilter = "";
			this.#modelCursor = 0;
			this.#renderStep();
			this.#onRender();
		}
	}

	#handleModelPickInput(keyData: string): void {
		if (matchesAppInterrupt(keyData)) {
			this.#pendingRole = null;
			this.#modelFilter = "";
			this.#view = "roleList";
			this.#renderStep();
			this.#onRender();
			return;
		}
		const models = this.#filteredModels();
		if (matchesKey(keyData, "up")) {
			if (models.length > 0) this.#modelCursor = this.#modelCursor === 0 ? models.length - 1 : this.#modelCursor - 1;
			this.#renderStep();
			this.#onRender();
			return;
		}
		if (matchesKey(keyData, "down")) {
			if (models.length > 0) this.#modelCursor = (this.#modelCursor + 1) % models.length;
			this.#renderStep();
			this.#onRender();
			return;
		}
		if (matchesKey(keyData, "enter") || matchesKey(keyData, "return") || keyData === "\n") {
			const model = models[this.#modelCursor];
			if (!model) return;
			this.#pendingModel = model;
			this.#view = "effortPick";
			this.#effortCursor = 0;
			this.#renderStep();
			this.#onRender();
			return;
		}
		if (keyData === "\x7f" || keyData === "\b") {
			this.#modelFilter = this.#modelFilter.slice(0, -1);
			this.#modelCursor = 0;
			this.#renderStep();
			this.#onRender();
			return;
		}
		if (isPrintableCharacter(keyData)) {
			this.#modelFilter += keyData;
			this.#modelCursor = 0;
			this.#renderStep();
			this.#onRender();
		}
	}

	#handleEffortPickInput(keyData: string): void {
		if (matchesAppInterrupt(keyData)) {
			this.#pendingModel = null;
			this.#view = "modelPick";
			this.#renderStep();
			this.#onRender();
			return;
		}
		const efforts = this.#effortOptions();
		if (matchesKey(keyData, "up")) {
			this.#effortCursor = this.#effortCursor === 0 ? efforts.length - 1 : this.#effortCursor - 1;
			this.#renderStep();
			this.#onRender();
			return;
		}
		if (matchesKey(keyData, "down")) {
			this.#effortCursor = (this.#effortCursor + 1) % efforts.length;
			this.#renderStep();
			this.#onRender();
			return;
		}
		if (matchesKey(keyData, "enter") || matchesKey(keyData, "return") || keyData === "\n") {
			const effort = efforts[this.#effortCursor];
			if (effort === undefined || this.#pendingRole === null || !this.#pendingModel) return;
			const base = `${this.#pendingModel.provider}/${this.#pendingModel.id}`;
			this.#draftMapping[this.#pendingRole] = effort === NO_EXPLICIT_EFFORT ? base : `${base}:${effort}`;
			this.#pendingRole = null;
			this.#pendingModel = null;
			this.#view = "roleList";
			this.#renderStep();
			this.#onRender();
		}
	}

	#submitEdit(): void {
		this.#lastError = null;
		const mapping = { ...this.#draftMapping };
		this.#onSubmit({
			name: this.#profileName,
			profile: {
				...(this.#displayName !== undefined ? { display_name: this.#displayName } : {}),
				model_mapping: mapping,
				required_providers: deriveRequiredProviders(mapping),
			},
		});
	}

	#renderEditStep(): void {
		this.#contentContainer.clear();
		this.#input = null;
		if (this.#lastError) {
			this.#contentContainer.addChild(new Text(theme.fg("error", this.#lastError), 0, 0));
			this.#contentContainer.addChild(new Spacer(1));
		}
		if (this.#view === "roleList") {
			this.#renderRoleList();
			return;
		}
		if (this.#view === "modelPick") {
			this.#renderModelPick();
			return;
		}
		this.#renderEffortPick();
	}

	#renderRoleList(): void {
		this.#contentContainer.addChild(new Text(theme.fg("accent", "Roles"), 0, 0));
		this.#contentContainer.addChild(new Spacer(1));
		PROFILE_ROLE_PREVIEW_ORDER.forEach((role, index) => {
			const label = GJC_MODEL_ASSIGNMENT_TARGETS[role].tag ?? role.toUpperCase();
			const selector = this.#draftMapping[role] ?? "(inherit)";
			const selected = index === this.#roleCursor;
			const prefix = selected ? theme.fg("accent", `${theme.nav.cursor} `) : "  ";
			const line = `${prefix}${label}: ${selector}`;
			this.#contentContainer.addChild(new Text(selected ? theme.fg("accent", line) : line, 0, 0));
		});
		const saveSelected = this.#roleCursor === PROFILE_ROLE_PREVIEW_ORDER.length;
		const savePrefix = saveSelected ? theme.fg("accent", `${theme.nav.cursor} `) : "  ";
		const saveLine = `${savePrefix}Save`;
		this.#contentContainer.addChild(new Spacer(1));
		this.#contentContainer.addChild(new Text(saveSelected ? theme.fg("accent", saveLine) : saveLine, 0, 0));
		this.#contentContainer.addChild(new Spacer(1));
		this.#addHelp("[Up/Down to move, Enter to edit role, s to save, Esc to cancel]");
	}

	#renderModelPick(): void {
		const role = this.#pendingRole;
		const roleLabel = role ? (GJC_MODEL_ASSIGNMENT_TARGETS[role].tag ?? role.toUpperCase()) : "";
		this.#contentContainer.addChild(new Text(theme.fg("accent", `Model for ${roleLabel}`), 0, 0));
		this.#contentContainer.addChild(new Spacer(1));
		this.#contentContainer.addChild(new Text(`Filter: ${this.#modelFilter || "(type to filter)"}`, 0, 0));
		this.#contentContainer.addChild(new Spacer(1));
		const models = this.#filteredModels();
		if (models.length === 0) {
			this.#contentContainer.addChild(new Text(theme.fg("muted", "No matching models."), 0, 0));
		}
		const cursor = models.length === 0 ? 0 : Math.min(this.#modelCursor, models.length - 1);
		const start = Math.max(
			0,
			Math.min(cursor - Math.floor(MODEL_PICK_WINDOW / 2), Math.max(0, models.length - MODEL_PICK_WINDOW)),
		);
		models.slice(start, start + MODEL_PICK_WINDOW).forEach((model, offset) => {
			const index = start + offset;
			const selected = index === cursor;
			const prefix = selected ? theme.fg("accent", `${theme.nav.cursor} `) : "  ";
			const line = `${prefix}${model.provider}/${model.id}`;
			this.#contentContainer.addChild(new Text(selected ? theme.fg("accent", line) : line, 0, 0));
		});
		this.#contentContainer.addChild(new Spacer(1));
		this.#addHelp("[Up/Down to move, Enter to choose, type to filter, Esc to go back]");
	}

	#renderEffortPick(): void {
		const base = this.#pendingModel ? `${this.#pendingModel.provider}/${this.#pendingModel.id}` : "";
		this.#contentContainer.addChild(new Text(theme.fg("accent", `Effort for ${base}`), 0, 0));
		this.#contentContainer.addChild(new Spacer(1));
		this.#effortOptions().forEach((effort, index) => {
			const selected = index === this.#effortCursor;
			const prefix = selected ? theme.fg("accent", `${theme.nav.cursor} `) : "  ";
			const label = effort === NO_EXPLICIT_EFFORT ? "No explicit effort" : effort;
			const line = `${prefix}${label}`;
			this.#contentContainer.addChild(new Text(selected ? theme.fg("accent", line) : line, 0, 0));
		});
		this.#contentContainer.addChild(new Spacer(1));
		this.#addHelp("[Up/Down to move, Enter to set, Esc to go back]");
	}
}
