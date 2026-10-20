import { MAX_STAGED_PROMPT_IMAGES } from "../../utils/image-limits";

const RELOAD_COMPONENTS = new Set(["config", "models", "skills", "extensions", "tools"]);
const SERVICE_TIERS = new Set([
	"none",
	"auto",
	"default",
	"flex",
	"scale",
	"priority",
	"ultrafast",
	"openai-only",
	"claude-only",
]);

type Input = Record<string, unknown>;

type SecretInputError = { code: "secret_field_forbidden"; message: string };
const SECRET_FIELD = /(?:secret|token|password|credential|authorization|api[_-]?key)/i;

type UltrafastRestrictionError = { code: "ultrafast_tier_forbidden"; message: string };

function containsUltrafastServiceTier(value: unknown): boolean {
	if (Array.isArray(value)) return value.some(containsUltrafastServiceTier);
	if (!value || typeof value !== "object") return false;
	return Object.entries(value as Record<string, unknown>).some(
		([key, nested]) =>
			((key === "serviceTier" || key.endsWith(".serviceTier")) && nested === "ultrafast") ||
			containsUltrafastServiceTier(nested),
	);
}

function containsSecretField(value: unknown): boolean {
	if (Array.isArray(value)) return value.some(containsSecretField);
	if (!value || typeof value !== "object") return false;
	return Object.entries(value).some(([key, nested]) => SECRET_FIELD.test(key) || containsSecretField(nested));
}

/** Rejects secret-bearing and ultrafast-tier config patches from model-facing adapter inputs. */
export function validateAdapterSecretFields(
	operation: string,
	input: Input,
): SecretInputError | UltrafastRestrictionError | undefined {
	if (operation === "config.patch") {
		if (containsSecretField(input)) {
			return {
				code: "secret_field_forbidden",
				message: "config.patch secret fields are not available through this adapter.",
			};
		}
		if (containsUltrafastServiceTier(input)) {
			return {
				code: "ultrafast_tier_forbidden",
				message: "config.patch serviceTier ultrafast is restricted to trusted local sources.",
			};
		}
	}
	return undefined;
}

export type AdapterValidationError = {
	code: "invalid_reload_component" | "invalid_input";
	message: string;
};

const PROMPT_OPERATIONS = new Set(["turn.prompt", "turn.steer", "turn.follow_up", "turn.abort_and_prompt"]);

function hasUsablePromptImage(value: unknown): boolean {
	if (!value || typeof value !== "object" || Array.isArray(value)) return false;
	const image = value as Record<string, unknown>;
	return (
		typeof image.data === "string" &&
		image.data.trim().length > 0 &&
		(image.mimeType === undefined || (typeof image.mimeType === "string" && image.mimeType.length > 0))
	);
}

function hasValidStagedPromptImages(value: unknown): boolean {
	if (!Array.isArray(value) || value.length === 0 || value.length > MAX_STAGED_PROMPT_IMAGES) return false;
	const ids = new Set<string>();
	return value.every(descriptor => {
		if (!descriptor || typeof descriptor !== "object" || Array.isArray(descriptor)) return false;
		const image = descriptor as Record<string, unknown>;
		if (Object.keys(image).some(key => key !== "id") || typeof image.id !== "string" || image.id.trim().length === 0)
			return false;
		if (ids.has(image.id)) return false;
		ids.add(image.id);
		return true;
	});
}

/** Rejects instruction-bearing controls before correlation or provider work. */
export function validateRequiredPromptText(operation: string, input: Input): AdapterValidationError | undefined {
	if (operation === "turn.prompt" && input.stagedImages !== undefined) {
		if (input.images !== undefined)
			return { code: "invalid_input", message: "Direct and staged images cannot be mixed." };
		if (!hasValidStagedPromptImages(input.stagedImages))
			return {
				code: "invalid_input",
				message: `stagedImages must contain 1–${MAX_STAGED_PROMPT_IMAGES} valid image IDs.`,
			};
	}
	const hasUsableImage =
		operation === "turn.prompt" &&
		((Array.isArray(input.images) && input.images.some(hasUsablePromptImage)) ||
			hasValidStagedPromptImages(input.stagedImages));
	if (
		PROMPT_OPERATIONS.has(operation) &&
		(typeof input.text !== "string" || (input.text.trim().length === 0 && !hasUsableImage))
	) {
		return { code: "invalid_input", message: "Prompt must not be empty." };
	}
	return undefined;
}

/** Validates controls before forwarding them; adapters reject ultrafast unless explicitly trusted. */
export function validateAdapterControl(
	operation: string,
	input: Input,
	options: { allowUltrafastTier?: boolean } = {},
): AdapterValidationError | undefined {
	const promptError = validateRequiredPromptText(operation, input);
	if (promptError) return promptError;
	if (operation === "runtime.reload") {
		if (
			!Array.isArray(input.components) ||
			!input.components.every(component => typeof component === "string" && RELOAD_COMPONENTS.has(component))
		) {
			return {
				code: "invalid_reload_component",
				message: "runtime.reload components must be drawn from config, models, skills, extensions, or tools.",
			};
		}
	}
	if (
		operation === "service_tier.set" &&
		(typeof input.tier !== "string" ||
			!SERVICE_TIERS.has(input.tier) ||
			(input.tier === "ultrafast" && options.allowUltrafastTier !== true))
	) {
		return { code: "invalid_input", message: "service_tier.set tier is invalid." };
	}
	return undefined;
}
