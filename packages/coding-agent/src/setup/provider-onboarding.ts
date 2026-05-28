import * as fs from "node:fs/promises";
import * as path from "node:path";
import { getAgentDir } from "@gajae-code/utils";
import { YAML } from "bun";
import { type ModelsConfig, ModelsConfigSchema } from "../config/models-config-schema";

export type ProviderCompatibility = "openai" | "anthropic";

export interface ProviderSetupInput {
	compatibility: ProviderCompatibility;
	providerId: string;
	baseUrl: string;
	apiKey?: string;
	apiKeyEnv?: string;
	models: string[];
	modelsPath?: string;
	force?: boolean;
}

export interface ProviderSetupResult {
	providerId: string;
	compatibility: ProviderCompatibility;
	api: "openai-responses" | "anthropic-messages";
	baseUrl: string;
	modelIds: string[];
	modelsPath: string;
	redactedApiKey: string;
	credentialSource: "literal" | "env";
}

type ProviderConfig = NonNullable<NonNullable<ModelsConfig["providers"]>[string]>;

const PROVIDER_ID_PATTERN = /^[a-z0-9][a-z0-9._-]*$/;
const REDACT_PREFIX = 4;
const REDACT_SUFFIX = 4;

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

function apiForCompatibility(compatibility: ProviderCompatibility): ProviderSetupResult["api"] {
	return compatibility === "openai" ? "openai-responses" : "anthropic-messages";
}

function validateSetupInput(input: ProviderSetupInput): {
	providerId: string;
	baseUrl: string;
	apiKey: string;
	credentialSource: ProviderSetupResult["credentialSource"];
	models: string[];
} {
	const providerId = normalizeProviderId(input.providerId);
	if (!PROVIDER_ID_PATTERN.test(providerId)) {
		throw new Error("Provider id must use lowercase letters, numbers, dots, underscores, or hyphens.");
	}

	const baseUrl = input.baseUrl.trim();
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

	const apiKeyEnv = input.apiKeyEnv?.trim();
	if (apiKeyEnv) {
		if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(apiKeyEnv)) {
			throw new Error("API key environment variable must be a valid environment variable name.");
		}
	}
	const apiKey = apiKeyEnv ?? input.apiKey?.trim() ?? "";
	if (!apiKey) throw new Error("API key is required.");

	const models = parseModelList(input.models);
	if (models.length === 0) throw new Error("At least one model id is required.");

	return { providerId, baseUrl, apiKey, credentialSource: apiKeyEnv ? "env" : "literal", models };
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
	const api = apiForCompatibility(input.compatibility);
	if (existing.providers?.[validated.providerId] && !input.force) {
		throw new Error(`Provider '${validated.providerId}' already exists. Use --force to replace it.`);
	}
	const provider: ProviderConfig = {
		baseUrl: validated.baseUrl,
		api,
		auth: "apiKey",
		models: validated.models.map(id => ({ id })),
	};
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
		compatibility: input.compatibility,
		api,
		baseUrl: validated.baseUrl,
		modelIds: validated.models,
		modelsPath,
		redactedApiKey: redactSecret(validated.apiKey),
		credentialSource: validated.credentialSource,
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
		`Models: ${result.modelIds.join(", ")}`,
		`Base URL: ${result.baseUrl}`,
		`API key: ${result.credentialSource === "env" ? `${result.redactedApiKey} (environment variable)` : result.redactedApiKey}`,
		`Config: ${result.modelsPath}`,
	].join("\n");
}
