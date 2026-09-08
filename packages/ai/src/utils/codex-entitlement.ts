/**
 * Model entitlement facts shared by Codex credential selection and provider
 * error presentation.
 *
 * Pro-tier Codex models such as GPT-5.6 Sol are marketed for higher plans, but
 * the provider grants them per account: trial, grandfathered and experiment
 * accounts carry an ordinary plan label and are still accepted. The plan label
 * therefore orders credentials; the provider decides entitlement. This module
 * names the plan policy used for that ordering and keeps the provider's
 * deterministic rejection wording in one place.
 */

const OPENAI_CODEX_PRO_ENTITLED_PLAN_TYPES = new Set(["pro", "business", "enterprise", "team"]);
const OPENAI_CODEX_PRO_DENIED_PLAN_TYPES = new Set(["free", "plus"]);

export type OpenAICodexProEntitlement = "entitled" | "denied" | "unknown";

/**
 * Classify a ChatGPT `plan_type` for Pro-tier Codex model preference.
 *
 * Only exact, documented tier names are classified; missing or unfamiliar
 * values stay unknown rather than being guessed from a substring. The result
 * ranks credentials — `denied` means "try this account last", not "refuse it".
 */
export function classifyOpenAICodexProEntitlement(planType: string | undefined): OpenAICodexProEntitlement {
	const normalized = planType?.trim().toLowerCase();
	if (!normalized) return "unknown";
	if (OPENAI_CODEX_PRO_ENTITLED_PLAN_TYPES.has(normalized)) return "entitled";
	if (OPENAI_CODEX_PRO_DENIED_PLAN_TYPES.has(normalized)) return "denied";
	return "unknown";
}

/** Models whose credential selection ranks candidates by ChatGPT plan tier. */
export function requiresOpenAICodexProModel(provider: string, modelId: string | undefined): boolean {
	return (
		provider === "openai-codex" &&
		typeof modelId === "string" &&
		(modelId.toLowerCase().includes("-spark") || modelId.toLowerCase() === "gpt-5.6-sol")
	);
}

export function isOpenAICodexChatGPTEntitlementError(message: string | undefined, code?: string): boolean {
	return (
		/\bnot supported when using codex with a chatgpt account\b/i.test(message ?? "") &&
		(code === undefined || code.toLowerCase() === "invalid_request_error")
	);
}

export function formatOpenAICodexChatGPTEntitlementError(modelId: string | undefined): string {
	const safeModelId = modelId
		?.replace(/[\x00-\x1f\x7f-\x9f]+/gu, " ")
		.trim()
		.slice(0, 128);
	const model = safeModelId ? ` model "${safeModelId}"` : " model";
	return `This ChatGPT Codex account cannot use${model}. Select a model available to this ChatGPT account, such as "gpt-5.5", or use an API-key credential that supports the model.`;
}
