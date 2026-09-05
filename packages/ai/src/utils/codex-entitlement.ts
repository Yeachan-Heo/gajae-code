/**
 * Model entitlement facts shared by Codex credential selection and provider
 * error presentation.
 *
 * Live provider entitlement is authoritative for GPT-5.6 Sol access on Plus
 * and unknown plans: those local usage labels only rank candidates. A
 * confirmed Free-only pool remains locally unsupported. Spark retains its
 * existing local filter that excludes non-Pro candidates whenever a confirmed
 * Pro candidate exists. This module names those model policies and keeps the
 * provider's deterministic rejection wording in one place.
 */

const OPENAI_CODEX_PRO_ENTITLED_PLAN_TYPES = new Set(["pro", "business", "enterprise", "team"]);
const OPENAI_CODEX_PRO_DENIED_PLAN_TYPES = new Set(["free"]);
const OPENAI_CODEX_PRO_LIMITED_PLAN_TYPES = new Set(["plus"]);

export type OpenAICodexProEntitlement = "entitled" | "limited" | "denied" | "unknown";

/**
 * Classify a ChatGPT `plan_type` for strict Pro-tier Codex models.
 *
 * The usage endpoint remains authoritative: only exact, documented tier names
 * are classified. Known Free tiers can be rejected locally. Plus remains a
 * lower-priority provider-decided candidate, while missing or unfamiliar
 * values stay unknown and reach the provider instead of being guessed from a
 * substring.
 */
export function classifyOpenAICodexProEntitlement(planType: string | undefined): OpenAICodexProEntitlement {
	const normalized = planType?.trim().toLowerCase();
	if (!normalized) return "unknown";
	if (OPENAI_CODEX_PRO_ENTITLED_PLAN_TYPES.has(normalized)) return "entitled";
	if (OPENAI_CODEX_PRO_LIMITED_PLAN_TYPES.has(normalized)) return "limited";
	if (OPENAI_CODEX_PRO_DENIED_PLAN_TYPES.has(normalized)) return "denied";
	return "unknown";
}

export function requiresOpenAICodexProModel(provider: string, modelId: string | undefined): boolean {
	return (
		provider === "openai-codex" &&
		typeof modelId === "string" &&
		(modelId.toLowerCase().includes("-spark") || modelId.toLowerCase() === "gpt-5.6-sol")
	);
}

export function requiresStrictOpenAICodexProModel(provider: string, modelId: string | undefined): boolean {
	return provider === "openai-codex" && modelId?.toLowerCase() === "gpt-5.6-sol";
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
