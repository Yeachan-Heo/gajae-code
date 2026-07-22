import { $pickenv } from "@gajae-code/utils/env";

export type EditMode = "replace" | "patch" | "hashline" | "vim" | "apply_patch";

export const DEFAULT_EDIT_MODE: EditMode = "hashline";

const EDIT_MODE_IDS = {
	apply_patch: "apply_patch",
	hashline: "hashline",
	patch: "patch",
	replace: "replace",
	vim: "vim",
} as const satisfies Record<string, EditMode>;

export const EDIT_MODES = Object.keys(EDIT_MODE_IDS) as EditMode[];

export function normalizeEditMode(mode?: string | null): EditMode | undefined {
	if (!mode) return undefined;
	return EDIT_MODE_IDS[mode as keyof typeof EDIT_MODE_IDS];
}

export interface EditModeSettingsLike {
	get(key: "edit.mode"): unknown;
	getEditVariantForModel?(model: string | undefined): EditMode | null;
}

export interface EditModeSessionLike {
	settings: EditModeSettingsLike;
	getActiveModelString?: () => string | undefined;
}

export function resolveEditMode(session: EditModeSessionLike): EditMode {
	const activeModel = session.getActiveModelString?.();
	const modelVariant = session.settings.getEditVariantForModel?.(activeModel);
	if (modelVariant) return modelVariant;

	const envMode = normalizeEditMode($pickenv("GJC_EDIT_VARIANT", "PI_EDIT_VARIANT"));
	if (envMode) return envMode;

	const settingsMode = normalizeEditMode(String(session.settings.get("edit.mode") ?? ""));
	return settingsMode ?? DEFAULT_EDIT_MODE;
}
