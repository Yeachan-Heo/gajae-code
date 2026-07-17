const RELOAD_COMPONENTS = new Set(["config", "models", "skills", "extensions", "tools"]);
const SERVICE_TIERS = new Set(["none", "auto", "default", "flex", "scale", "priority", "openai-only", "claude-only"]);

type Input = Record<string, unknown>;

type SecretInputError = { code: "secret_field_forbidden"; message: string };
const SECRET_FIELD = /(?:secret|token|password|credential|authorization|api[_-]?key)/i;

function containsSecretField(value: unknown): boolean {
	if (Array.isArray(value)) return value.some(containsSecretField);
	if (!value || typeof value !== "object") return false;
	return Object.entries(value).some(([key, nested]) => SECRET_FIELD.test(key) || containsSecretField(nested));
}

/** Rejects secret-bearing config patches from model-facing adapter inputs. */
export function validateAdapterSecretFields(operation: string, input: Input): SecretInputError | undefined {
	if (operation === "config.patch" && containsSecretField(input)) {
		return {
			code: "secret_field_forbidden",
			message: "config.patch secret fields are not available through this adapter.",
		};
	}
	return undefined;
}

export type AdapterValidationError = {
	code: "invalid_reload_component" | "invalid_input";
	message: string;
};

/** Validates controls that adapters must reject before forwarding them to a host. */
export function validateAdapterControl(operation: string, input: Input): AdapterValidationError | undefined {
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
	if (operation === "service_tier.set" && (typeof input.tier !== "string" || !SERVICE_TIERS.has(input.tier))) {
		return { code: "invalid_input", message: "service_tier.set tier is invalid." };
	}
	return undefined;
}
