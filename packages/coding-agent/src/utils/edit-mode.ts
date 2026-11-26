import { $pickenv } from "@gajae-code/utils/env";

export type EditMode = "replace" | "patch" | "vim" | "apply_patch";

/** Setting value for `edit.mode`: an executable mode or `auto` (model-family routing). */
export type EditModeSetting = "auto" | EditMode;

/** Fallback executable mode used when automatic routing cannot identify the model. */
export const DEFAULT_EDIT_MODE: EditMode = "replace";

/** Default `edit.mode` setting value. */
export const DEFAULT_EDIT_MODE_SETTING: EditModeSetting = "auto";

const EDIT_MODE_IDS = {
	apply_patch: "apply_patch",
	patch: "patch",
	replace: "replace",
	vim: "vim",
} as const satisfies Record<string, EditMode>;

export const EDIT_MODES = Object.keys(EDIT_MODE_IDS) as EditMode[];

export const EDIT_MODE_SETTINGS: EditModeSetting[] = ["auto", ...EDIT_MODES];

export function normalizeEditMode(mode?: string | null): EditMode | undefined {
	if (!mode) return undefined;
	return Object.hasOwn(EDIT_MODE_IDS, mode) ? EDIT_MODE_IDS[mode as keyof typeof EDIT_MODE_IDS] : undefined;
}

// ─────────────────────────────────────────────────────────────────────────────
// Model-family detection (automatic routing)
// ─────────────────────────────────────────────────────────────────────────────

export type ModelEditFamily = "gpt" | "codex" | "claude" | "deepseek" | "qwen" | "minimax" | "glm" | "kimi" | "unknown";

/**
 * Built-in family → edit mode mapping used by `edit.mode: auto`.
 *
 * GPT/Codex models are trained on the OpenAI patch grammar; Claude, DeepSeek,
 * and Qwen perform best with exact search/replace. Unknown models fall back to
 * replace, the most compatible default.
 */
const FAMILY_EDIT_MODES: Record<Exclude<ModelEditFamily, "unknown">, EditMode> = {
	gpt: "apply_patch",
	codex: "apply_patch",
	claude: "replace",
	deepseek: "replace",
	qwen: "replace",
	minimax: "replace",
	glm: "replace",
	kimi: "replace",
};

/**
 * Detect the model family from a model ID, ignoring the provider prefix so
 * equivalent models served through different providers route identically
 * (`openai/gpt-5.4`, `openrouter/openai/gpt-5.4`, `company-gateway/gpt-5.4`).
 *
 * Matching only examines the final path segment. A direct family prefix or a
 * known provider-qualified family name is accepted, while arbitrary token
 * substrings return `unknown` instead of guessing.
 */
export function detectModelEditFamily(modelId: string | undefined): ModelEditFamily {
	if (!modelId) return "unknown";
	const normalized = modelId.trim().toLowerCase();
	const segments = normalized.split("/").filter(Boolean);
	const model = segments.at(-1) ?? normalized;

	if (/^codex(?:$|[-_.\d])|^(?:gpt|(?:duo-chat|openai)-gpt)-\d+(?:[-_.][\w]+)*[-_.]codex(?:$|[-_.\d])/.test(model))
		return "codex";
	if (
		/^(?:gpt-\d+(?:$|[-_.])|gpt-oss(?:$|[-_.\d])|chatgpt(?:$|[-_.]\d))|(?:^|\.)openai\.(?:gpt|chatgpt)(?:$|[-_.\d])/.test(
			model,
		)
	)
		return "gpt";
	if (/^claude(?:$|[-_.\d])|(?:^|\.)anthropic\.claude(?:$|[-_.\d])/.test(model)) return "claude";
	if (/^deepseek(?:$|[-_.\d])|(?:^|\.)deepseek(?:$|[-_.\d])/.test(model)) return "deepseek";
	if (/^qwen(?:$|[-_.\d])|(?:^|\.)qwen\.qwen(?:$|[-_.\d])/.test(model)) return "qwen";
	if (/^minimax(?:$|[-_.\d])/.test(model)) return "minimax";
	if (/^glm(?:$|[-_.\d])/.test(model)) return "glm";
	if (/^(?:kimi|moonshot)(?:$|[-_.\d])/.test(model)) return "kimi";

	return "unknown";
}

/** Built-in mode for a detected family; `undefined` for `unknown`. */
export function builtinEditModeForFamily(family: ModelEditFamily): EditMode | undefined {
	if (family === "unknown") return undefined;
	return FAMILY_EDIT_MODES[family];
}

// ─────────────────────────────────────────────────────────────────────────────
// Resolution
// ─────────────────────────────────────────────────────────────────────────────

export type EditModeSource = "environment" | "model-override" | "setting" | "catalog" | "builtin-family" | "fallback";

export type ResolvedEditModeDetails = {
	mode: EditMode;
	source: EditModeSource;
	modelId?: string;
	family?: ModelEditFamily;
	matchedRule?: string;
};

/** Raw `edit.modelVariants` match: pattern plus the configured (unvalidated) value. */
export type EditVariantMatch = {
	pattern: string;
	value: string;
};

export interface EditModeSettingsLike {
	get(key: "edit.mode"): unknown;
	/** Legacy accessor: first *valid* matching `edit.modelVariants` value. */
	getEditVariantForModel?(model: string | undefined): EditMode | null;
	/**
	 * Discriminated accessor: first matching `edit.modelVariants` rule with its
	 * raw value. Lets the resolver fail closed on invalid matched values
	 * instead of silently falling through to another mode.
	 */
	matchEditVariantForModel?(model: string | undefined): EditVariantMatch | null;
}

export interface EditModeSessionLike {
	settings: EditModeSettingsLike;
	getActiveModelString?: () => string | undefined;
	/**
	 * Optional model-catalog edit recommendation; beats the built-in family
	 * mapping when present.
	 *
	 * Extension point: production sessions do not wire this yet — the model
	 * catalog does not expose an edit-protocol recommendation (`applyPatchToolType`
	 * is the OpenAI wire representation of an already-selected `apply_patch`
	 * mode, not a mode selector). Catalog metadata generation is deliberately
	 * deferred until the family-based path is proven for arbitrary custom-provider
	 * IDs; when it lands, sessions can expose this hook without a resolver change.
	 */
	getCatalogEditMode?: () => EditMode | undefined;
}

/**
 * Read the forced edit mode from `GJC_EDIT_VARIANT`/`PI_EDIT_VARIANT`.
 * The environment force is the emergency kill switch and beats every other
 * source. Invalid values fail fast; empty and `auto` mean "not forced".
 */
export function resolveForcedEnvEditMode(): EditMode | undefined {
	const raw = $pickenv("GJC_EDIT_VARIANT", "PI_EDIT_VARIANT");
	if (!raw || raw === "auto") return undefined;
	const mode = normalizeEditMode(raw);
	if (!mode) {
		throw new Error(`Invalid GJC_EDIT_VARIANT: ${raw}`);
	}
	return mode;
}

/**
 * Resolve the active edit mode with provenance.
 *
 * Precedence:
 * 1. `GJC_EDIT_VARIANT`/`PI_EDIT_VARIANT` environment force (invalid → throw).
 * 2. Matching user `edit.modelVariants` rule (matched invalid → throw).
 * 3. Explicit `edit.mode` setting when it is not `auto`.
 * 4. Model-catalog edit recommendation, when the session exposes one.
 * 5. Built-in model-family mapping.
 * 6. `replace` fallback.
 */
export function resolveEditModeDetails(session: EditModeSessionLike): ResolvedEditModeDetails {
	const modelId = session.getActiveModelString?.();

	const envMode = resolveForcedEnvEditMode();
	if (envMode) return { mode: envMode, source: "environment", modelId };

	const settings = session.settings;
	if (settings.matchEditVariantForModel) {
		const match = settings.matchEditVariantForModel(modelId);
		if (match) {
			const mode = normalizeEditMode(match.value);
			if (!mode) {
				throw new Error(
					`Invalid edit.modelVariants value "${match.value}" for pattern "${match.pattern}" (expected one of: ${EDIT_MODES.join(", ")})`,
				);
			}
			return { mode, source: "model-override", modelId, matchedRule: match.pattern };
		}
	} else {
		const legacyVariant = settings.getEditVariantForModel?.(modelId);
		if (legacyVariant) return { mode: legacyVariant, source: "model-override", modelId };
	}

	const rawSetting = settings.get("edit.mode");
	const settingValue = typeof rawSetting === "string" ? rawSetting : undefined;
	if (settingValue && settingValue !== "auto") {
		const settingsMode = normalizeEditMode(settingValue);
		if (settingsMode) return { mode: settingsMode, source: "setting", modelId };
	}

	const family = detectModelEditFamily(modelId);

	const catalogMode = session.getCatalogEditMode?.();
	if (catalogMode) return { mode: catalogMode, source: "catalog", modelId, family };

	const builtinMode = builtinEditModeForFamily(family);
	if (builtinMode) return { mode: builtinMode, source: "builtin-family", modelId, family };

	return { mode: DEFAULT_EDIT_MODE, source: "fallback", modelId, family };
}

export function resolveEditMode(session: EditModeSessionLike): EditMode {
	return resolveEditModeDetails(session).mode;
}
