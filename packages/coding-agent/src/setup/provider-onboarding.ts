import * as fs from "node:fs/promises";
import * as path from "node:path";
import { getAgentDir } from "@gajae-code/utils";
import { YAML } from "bun";
import { type ModelsConfig, ModelsConfigSchema } from "../config/models-config-schema";

export type ProviderCompatibility = "openai" | "anthropic";
export type ProviderSetupApi = "openai-responses" | "openai-completions" | "anthropic-messages";

export interface ProviderSetupInput {
	compatibility?: ProviderCompatibility;
	preset?: string;
	providerId?: string;
	baseUrl?: string;
	apiKey?: string;
	apiKeyEnv?: string;
	models?: string[];
	modelsPath?: string;
	force?: boolean;
}

export interface ProviderSetupResult {
	providerId: string;
	compatibility: ProviderCompatibility;
	api: ProviderSetupApi;
	baseUrl: string;
	modelIds: string[];
	modelsPath: string;
	redactedApiKey: string;
	credentialSource: "literal" | "env";
	preset?: string;
	presetName?: string;
}

type ProviderConfig = NonNullable<NonNullable<ModelsConfig["providers"]>[string]>;
type ProviderCompatConfig = NonNullable<ProviderConfig["compat"]>;

interface ProviderPreset {
	id: string;
	aliases: readonly string[];
	name: string;
	description: string;
	compatibility: ProviderCompatibility;
	api: ProviderSetupApi;
	providerId: string;
	baseUrl: string;
	apiKeyEnv: string;
	models: readonly string[];
	compat?: ProviderCompatConfig;
}

const PROVIDER_ID_PATTERN = /^[a-z0-9][a-z0-9._-]*$/;
const REDACT_PREFIX = 4;
const REDACT_SUFFIX = 4;
// Preset compat values are onboarding snapshots for generated models.yml entries.
// Keep them aligned with provider descriptor behavior without importing descriptor internals into setup UX.
const MINIMAX_OPENAI_COMPAT: ProviderCompatConfig = {
	supportsStore: false,
	supportsDeveloperRole: false,
	supportsReasoningEffort: false,
	reasoningContentField: "reasoning_content",
};

const GLM_OPENAI_COMPAT: ProviderCompatConfig = {
	supportsDeveloperRole: false,
	supportsReasoningEffort: false,
	thinkingFormat: "zai",
	reasoningContentField: "reasoning_content",
};

export const PROVIDER_PRESETS: readonly ProviderPreset[] = [
	{
		id: "minimax",
		aliases: ["minimax-code"],
		name: "MiniMax Coding Plan",
		description: "OpenAI-compatible MiniMax Coding Plan endpoint",
		compatibility: "openai",
		api: "openai-completions",
		providerId: "minimax-code",
		baseUrl: "https://api.minimax.io/v1",
		apiKeyEnv: "MINIMAX_CODE_API_KEY",
		models: ["MiniMax-M2.5"],
		compat: MINIMAX_OPENAI_COMPAT,
	},
	{
		id: "minimax-cn",
		aliases: ["minimax-code-cn", "minimaxi"],
		name: "MiniMax Coding Plan (China)",
		description: "OpenAI-compatible MiniMax China endpoint",
		compatibility: "openai",
		api: "openai-completions",
		providerId: "minimax-code-cn",
		baseUrl: "https://api.minimaxi.com/v1",
		apiKeyEnv: "MINIMAX_CODE_CN_API_KEY",
		models: ["MiniMax-M2.5"],
		compat: MINIMAX_OPENAI_COMPAT,
	},
	{
		id: "glm",
		aliases: ["zai", "z-ai", "bigmodel"],
		name: "GLM / zAI",
		description: "OpenAI-compatible GLM endpoint from zAI/BigModel",
		compatibility: "openai",
		api: "openai-completions",
		providerId: "glm-proxy",
		baseUrl: "https://api.z.ai/api/paas/v4",
		apiKeyEnv: "ZAI_API_KEY",
		models: ["glm-4.6"],
		compat: GLM_OPENAI_COMPAT,
	},
];

export function getDefaultModelsPath(): string {
	return path.join(getAgentDir(), "models.yml");
}

export function normalizeProviderId(providerId: string): string {
	return providerId.trim().toLowerCase();
}

export function parseProviderCompatibility(value: string): ProviderCompatibility {
	const normalized = value.trim().toLowerCase();
	if (normalized === "openai" || normalized === "openai-compatible" || normalized === "oai") return "openai";
	if (normalized === "anthropic" || normalized === "anthropic-compatible" || normalized === "claude") {
		return "anthropic";
	}
	throw new Error("Provider compatibility must be 'openai' or 'anthropic'.");
}

export function findProviderPreset(value: string | undefined): ProviderPreset | undefined {
	const normalized = value?.trim().toLowerCase();
	if (!normalized) return undefined;
	return PROVIDER_PRESETS.find(preset => preset.id === normalized || preset.aliases.includes(normalized));
}

export function formatProviderPresetList(): string {
	return PROVIDER_PRESETS.map(preset => {
		const aliases = preset.aliases.length > 0 ? ` (aliases: ${preset.aliases.join(", ")})` : "";
		return `${preset.id}${aliases}: ${preset.description}`;
	}).join("\n");
}

export function parseModelList(values: readonly string[]): string[] {
	const models = values
		.flatMap(value => value.split(","))
		.map(value => value.trim())
		.filter(value => value.length > 0);
	return [...new Set(models)];
}

export function redactSecret(secret: string): string {
	const trimmed = secret.trim();
	if (trimmed.length <= REDACT_PREFIX + REDACT_SUFFIX) return "***";
	return `${trimmed.slice(0, REDACT_PREFIX)}…${trimmed.slice(-REDACT_SUFFIX)}`;
}

function apiForCompatibility(compatibility: ProviderCompatibility): ProviderSetupApi {
	return compatibility === "openai" ? "openai-responses" : "anthropic-messages";
}

function resolvePresetInput(input: ProviderSetupInput): {
	compatibility: ProviderCompatibility;
	preset?: ProviderPreset;
	providerId?: string;
	baseUrl?: string;
	apiKey?: string;
	apiKeyEnv?: string;
	models: readonly string[];
	api: ProviderSetupApi;
	compat?: ProviderCompatConfig;
} {
	const preset = input.preset ? findProviderPreset(input.preset) : undefined;
	if (input.preset && !preset) {
		throw new Error(`Unknown provider preset '${input.preset}'. Available presets:\n${formatProviderPresetList()}`);
	}
	if (preset && input.compatibility && input.compatibility !== preset.compatibility) {
		throw new Error(
			`Provider preset '${preset.id}' is ${preset.compatibility}-compatible; omit --compat or use '${preset.compatibility}'.`,
		);
	}
	if (preset && input.baseUrl !== undefined) {
		throw new Error(
			`Provider preset '${preset.id}' uses a fixed base URL; omit --base-url or use --compat openai for a custom provider.`,
		);
	}
	if (preset && input.models && input.models.length > 0) {
		throw new Error(
			`Provider preset '${preset.id}' uses fixed model ids; omit --model or use --compat openai for a custom provider.`,
		);
	}
	if (preset && input.apiKeyEnv !== undefined && input.apiKeyEnv.trim() !== preset.apiKeyEnv) {
		throw new Error(
			`Provider preset '${preset.id}' uses ${preset.apiKeyEnv}; omit --api-key-env or use --compat openai for a custom provider.`,
		);
	}
	const compatibility = preset?.compatibility ?? input.compatibility;
	if (!compatibility) {
		throw new Error("Provider compatibility is required unless --preset is used.");
	}
	return {
		compatibility,
		preset,
		providerId: input.providerId ?? preset?.providerId,
		baseUrl: input.baseUrl ?? preset?.baseUrl,
		apiKey: input.apiKey,
		apiKeyEnv: input.apiKeyEnv ?? preset?.apiKeyEnv,
		models: input.models && input.models.length > 0 ? input.models : (preset?.models ?? []),
		api: preset?.api ?? apiForCompatibility(compatibility),
		compat: preset?.compat,
	};
}

function validateSetupInput(input: ProviderSetupInput): {
	providerId: string;
	baseUrl: string;
	apiKey: string;
	credentialSource: ProviderSetupResult["credentialSource"];
	models: string[];
	compatibility: ProviderCompatibility;
	api: ProviderSetupApi;
	compat?: ProviderCompatConfig;
	preset?: ProviderPreset;
} {
	const resolved = resolvePresetInput(input);
	if (!resolved.providerId) throw new Error("Provider id is required.");
	if (!resolved.baseUrl) throw new Error("Base URL is required.");
	const providerId = normalizeProviderId(resolved.providerId);
	if (!PROVIDER_ID_PATTERN.test(providerId)) {
		throw new Error("Provider id must use lowercase letters, numbers, dots, underscores, or hyphens.");
	}

	const baseUrl = resolved.baseUrl.trim();
	let url: URL;
	try {
		url = new URL(baseUrl);
	} catch {
		throw new Error("Base URL must be a valid absolute URL.");
	}
	if (url.protocol !== "https:" && url.protocol !== "http:") {
		throw new Error("Base URL must use http or https.");
	}
	if (url.protocol === "http:" && !isLocalHttpHost(url.hostname)) {
		throw new Error("Base URL must use https unless it targets localhost or a loopback address.");
	}

	const apiKeyEnv = resolved.apiKeyEnv?.trim();
	if (apiKeyEnv) {
		if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(apiKeyEnv)) {
			throw new Error("API key environment variable must be a valid environment variable name.");
		}
	}
	const apiKey = apiKeyEnv ?? resolved.apiKey?.trim() ?? "";
	if (!apiKey) throw new Error("API key is required.");

	const models = parseModelList(resolved.models);
	if (models.length === 0) throw new Error("At least one model id is required.");

	return {
		providerId,
		baseUrl,
		apiKey,
		credentialSource: apiKeyEnv ? "env" : "literal",
		models,
		compatibility: resolved.compatibility,
		api: resolved.api,
		compat: resolved.compat,
		preset: resolved.preset,
	};
}

async function readModelsConfig(modelsPath: string): Promise<ModelsConfig> {
	const file = Bun.file(modelsPath);
	if (!(await file.exists())) return {};
	const text = (await file.text()).trim();
	if (!text) return {};
	const parsed = modelsPath.endsWith(".json") || modelsPath.endsWith(".jsonc") ? JSON.parse(text) : YAML.parse(text);
	const checked = ModelsConfigSchema.safeParse(parsed);
	if (!checked.success) {
		const first = checked.error.issues[0];
		const where = first?.path.length ? `/${first.path.map(String).join("/")}` : "root";
		throw new Error(`Existing models config is invalid at ${where}: ${first?.message ?? "unknown schema error"}`);
	}
	return checked.data;
}

async function writeModelsConfig(modelsPath: string, config: ModelsConfig): Promise<void> {
	const checked = ModelsConfigSchema.safeParse(config);
	if (!checked.success) {
		const first = checked.error.issues[0];
		const where = first?.path.length ? `/${first.path.map(String).join("/")}` : "root";
		throw new Error(`Generated models config is invalid at ${where}: ${first?.message ?? "unknown schema error"}`);
	}
	await fs.mkdir(path.dirname(modelsPath), { recursive: true });
	await Bun.write(modelsPath, YAML.stringify(checked.data, null, 2));
}

export async function addApiCompatibleProvider(input: ProviderSetupInput): Promise<ProviderSetupResult> {
	const validated = validateSetupInput(input);
	const modelsPath = input.modelsPath ?? getDefaultModelsPath();
	const existing = await readModelsConfig(modelsPath);
	if (existing.providers?.[validated.providerId] && !input.force) {
		throw new Error(`Provider '${validated.providerId}' already exists. Use --force to replace it.`);
	}
	const provider: ProviderConfig = {
		baseUrl: validated.baseUrl,
		api: validated.api,
		auth: "apiKey",
		models: validated.models.map(id => ({ id })),
	};
	if (validated.compat) provider.compat = validated.compat;
	if (validated.credentialSource === "env") {
		provider.apiKeyEnv = validated.apiKey;
	} else {
		provider.apiKey = validated.apiKey;
	}
	const next: ModelsConfig = {
		...existing,
		providers: {
			...(existing.providers ?? {}),
			[validated.providerId]: provider,
		},
	};
	await writeModelsConfig(modelsPath, next);
	return {
		providerId: validated.providerId,
		compatibility: validated.compatibility,
		api: validated.api,
		baseUrl: validated.baseUrl,
		modelIds: validated.models,
		modelsPath,
		redactedApiKey: redactSecret(validated.apiKey),
		credentialSource: validated.credentialSource,
		preset: validated.preset?.id,
		presetName: validated.preset?.name,
	};
}

function isLocalHttpHost(hostname: string): boolean {
	const normalized = hostname.toLowerCase().replace(/^\[(.*)]$/, "$1");
	return (
		normalized === "localhost" ||
		normalized === "127.0.0.1" ||
		normalized === "::1" ||
		normalized.endsWith(".localhost") ||
		/^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(normalized)
	);
}

export function formatProviderSetupResult(result: ProviderSetupResult): string {
	return [
		`Provider '${result.providerId}' configured as ${result.compatibility}-compatible.`,
		...(result.presetName ? [`Preset: ${result.presetName}`] : []),
		`Models: ${result.modelIds.join(", ")}`,
		`Base URL: ${result.baseUrl}`,
		`API key: ${result.credentialSource === "env" ? `${result.redactedApiKey} (environment variable)` : result.redactedApiKey}`,
		`Config: ${result.modelsPath}`,
	].join("\n");
}
