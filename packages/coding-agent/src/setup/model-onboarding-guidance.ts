import { formatProviderCredentialHint } from "@gajae-code/ai/stream";

export const MODEL_ONBOARDING_API_PROVIDER_COMMAND =
	"/provider add --compat <openai|anthropic> --provider <id> --base-url <url> --api-key-env <ENV> (--model <model> | --discover)";
export const MODEL_ONBOARDING_PROVIDER_PRESET_COMMAND = "/provider add --preset <id>";

export const MODEL_ONBOARDING_SETUP_COMMAND = "gjc setup provider";
export const MODEL_ONBOARDING_OAUTH_COMMAND = "/provider login [provider-id] or /login [provider-id]";

export function formatModelOnboardingGuidance(): string {
	return [
		"Model selection only shows configured providers.",
		"Assignment targets are DEFAULT plus the GJC role agents: EXECUTOR, ARCHITECT, PLANNER, and CRITIC.",
		"Legacy model-role aliases are compatibility-only and are not shown as assignment targets.",
		`Provider presets: ${MODEL_ONBOARDING_PROVIDER_PRESET_COMMAND} (or ${MODEL_ONBOARDING_SETUP_COMMAND} --preset <preset>).`,
		`API-compatible custom providers: ${MODEL_ONBOARDING_API_PROVIDER_COMMAND}.`,
		`OAuth/subscription providers: ${MODEL_ONBOARDING_OAUTH_COMMAND}.`,
		"Then run /model to select a configured model or assign it to a target.",
	].join("\n");
}

export function formatModelOnboardingInlineHint(): string {
	return `Add MiniMax/GLM presets with ${MODEL_ONBOARDING_PROVIDER_PRESET_COMMAND}; custom API providers with ${MODEL_ONBOARDING_API_PROVIDER_COMMAND} (or ${MODEL_ONBOARDING_SETUP_COMMAND}); OAuth/subscription with ${MODEL_ONBOARDING_OAUTH_COMMAND}; then run /model for DEFAULT, EXECUTOR, ARCHITECT, PLANNER, and CRITIC.`;
}

export function formatNoModelOnboardingError(): string {
	return `No model selected.\n\n${formatModelOnboardingGuidance()}`;
}

/** Control-protocol code for a prompt refused because the session has no model. */
export const MODEL_NOT_SELECTED_CODE = "model_not_selected";

/**
 * Fixed public text for {@link MODEL_NOT_SELECTED_CODE}. The onboarding
 * guidance names providers, commands, environment variables and local setup
 * paths, so it stays local-only; external clients get this constant instead.
 */
export const MODEL_NOT_SELECTED_PUBLIC_MESSAGE =
	"No model is selected for this session. Select a model before submitting a prompt.";

/**
 * Missing-model prompt preflight failure. The message keeps the full local
 * onboarding guidance for the TUI and in-process callers; the `code` is what
 * lets the SDK control surface answer with a safe, known diagnostic instead of
 * a generic internal error.
 */
export class NoModelSelectedError extends Error {
	readonly code = MODEL_NOT_SELECTED_CODE;

	constructor() {
		super(formatNoModelOnboardingError());
		this.name = "NoModelSelectedError";
	}
}

export function formatNoCredentialOnboardingError(providerId: string): string {
	const lines = [
		`No credentials found for ${providerId}.`,
		"",
		`For MiniMax/GLM presets, configure credentials with ${MODEL_ONBOARDING_PROVIDER_PRESET_COMMAND} (or ${MODEL_ONBOARDING_SETUP_COMMAND} --preset <preset>).`,
		`For custom API-compatible providers, use ${MODEL_ONBOARDING_API_PROVIDER_COMMAND}.`,
		`For OAuth/subscription providers, use ${MODEL_ONBOARDING_OAUTH_COMMAND} (interactive; not available in headless/print mode).`,
	];
	const headlessHint = formatProviderCredentialHint(providerId);
	if (headlessHint) lines.push(headlessHint);
	lines.push(
		"Then run /model to select a configured model or assign it to DEFAULT, EXECUTOR, ARCHITECT, PLANNER, or CRITIC.",
	);
	return lines.join("\n");
}

export function formatNoModelsAvailableFallback(): string {
	return `No models available. ${formatModelOnboardingGuidance()}`;
}
