import chalk from "chalk";
import { ModelsConfigFile } from "../config/model-registry";
import type { ModelsConfig } from "../config/models-config-schema";

export interface LocalProviderSmokeCommandArgs {
	model?: string;
	modelsPath?: string;
	timeoutMs?: number;
	json?: boolean;
}

export interface LocalOpenAICompatConfig {
	baseUrl: string;
	apiKey?: string;
}

export interface LocalProviderSmokeResult {
	ok: boolean;
	baseUrl?: string;
	model?: string;
	message: string;
	error?: string;
}

export interface LocalProviderDiscoveryResult {
	ok: boolean;
	provider: string;
	baseUrl?: string;
	models: string[];
	message: string;
	error?: string;
}

const DEFAULT_TIMEOUT_MS = 3000;
const DEFAULT_SMOKE_PROMPT = "Reply with ok.";

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function resolveApiKey(apiKey: string | undefined, apiKeyEnv: string | undefined): string | undefined {
	if (apiKeyEnv) return Bun.env[apiKeyEnv];
	if (!apiKey) return undefined;
	return Bun.env[apiKey] ?? apiKey;
}

function normalizeOpenAICompatBaseUrl(baseUrl: string): string {
	try {
		const parsed = new URL(baseUrl);
		const trimmedPath = parsed.pathname.replace(/\/+$/g, "");
		parsed.pathname = trimmedPath.endsWith("/v1") ? trimmedPath || "/v1" : `${trimmedPath}/v1`;
		return `${parsed.protocol}//${parsed.host}${parsed.pathname}`;
	} catch {
		const trimmed = baseUrl.replace(/\/+$/g, "");
		return trimmed.endsWith("/v1") ? trimmed : `${trimmed}/v1`;
	}
}

export function getLocalOpenAICompatConfig(config: ModelsConfig | undefined): LocalOpenAICompatConfig | undefined {
	const openaiCompat = config?.providers?.local?.openaiCompat;
	if (!openaiCompat?.baseUrl) return undefined;
	return {
		baseUrl: normalizeOpenAICompatBaseUrl(openaiCompat.baseUrl),
		apiKey: resolveApiKey(openaiCompat.apiKey, openaiCompat.apiKeyEnv),
	};
}

function extractModelIds(payload: unknown): string[] {
	if (!isRecord(payload)) {
		throw new Error("/models response was not a JSON object");
	}
	if (!Array.isArray(payload.data)) {
		throw new Error("/models response did not include a data array");
	}
	const models = payload.data.flatMap(item => {
		if (!isRecord(item) || typeof item.id !== "string") return [];
		const id = item.id.trim();
		return id ? [id] : [];
	});
	if (models.length === 0) {
		throw new Error("/models returned no model ids");
	}
	return [...new Set(models)].sort((left, right) => left.localeCompare(right));
}

async function readLocalConfig(
	modelsPath: string | undefined,
): Promise<LocalProviderSmokeResult | LocalOpenAICompatConfig> {
	const configFile = modelsPath ? ModelsConfigFile.relocate(modelsPath) : ModelsConfigFile;
	configFile.invalidate?.();
	const loaded = configFile.tryLoad();
	if (loaded.status === "error") {
		return { ok: false, message: "Failed to load models config.", error: loaded.error.message };
	}
	const localConfig = getLocalOpenAICompatConfig(loaded.value ?? undefined);
	if (!localConfig) {
		return {
			ok: false,
			message: `No local OpenAI-compatible endpoint configured. Add providers.local.openaiCompat.baseUrl to ${configFile.path()}.`,
		};
	}
	return localConfig;
}

function buildHeaders(apiKey: string | undefined): Record<string, string> {
	const headers: Record<string, string> = { "Content-Type": "application/json" };
	if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
	return headers;
}

function toErrorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

async function fetchLocalModelIds(config: LocalOpenAICompatConfig, timeoutMs: number): Promise<string[]> {
	const response = await fetch(`${config.baseUrl}/models`, {
		headers: buildHeaders(config.apiKey),
		signal: AbortSignal.timeout(timeoutMs),
	});
	if (!response.ok) {
		throw new Error(`HTTP ${response.status} from ${config.baseUrl}/models`);
	}
	let payload: unknown;
	try {
		payload = await response.json();
	} catch (error) {
		throw new Error(`Failed to parse /models JSON: ${toErrorMessage(error)}`);
	}
	return extractModelIds(payload);
}

async function discoverFirstModel(config: LocalOpenAICompatConfig, timeoutMs: number): Promise<string> {
	try {
		return (await fetchLocalModelIds(config, timeoutMs))[0]!;
	} catch (error) {
		const message = toErrorMessage(error);
		if (message === "/models returned no model ids") {
			throw new Error("/models returned no model ids; pass --model explicitly");
		}
		throw error;
	}
}

async function readStreamingBody(response: Response): Promise<number> {
	if (!response.body) return 0;
	const reader = response.body.getReader();
	let chunks = 0;
	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			if (value.byteLength > 0) chunks += 1;
		}
	} finally {
		reader.releaseLock();
	}
	return chunks;
}

export async function runLocalProviderDiscover(
	cmd: Omit<LocalProviderSmokeCommandArgs, "model">,
): Promise<LocalProviderDiscoveryResult> {
	const timeoutMs = cmd.timeoutMs && cmd.timeoutMs > 0 ? cmd.timeoutMs : DEFAULT_TIMEOUT_MS;
	const configResult = await readLocalConfig(cmd.modelsPath);
	if ("ok" in configResult) {
		return {
			ok: false,
			provider: "local",
			models: [],
			message: configResult.message,
			error: configResult.error,
		};
	}

	try {
		const models = await fetchLocalModelIds(configResult, timeoutMs);
		return {
			ok: true,
			provider: "local",
			baseUrl: configResult.baseUrl,
			models,
			message: `Discovered ${models.length} model${models.length === 1 ? "" : "s"}.`,
		};
	} catch (error) {
		return {
			ok: false,
			provider: "local",
			baseUrl: configResult.baseUrl,
			models: [],
			message: "Local provider model discovery failed.",
			error: toErrorMessage(error),
		};
	}
}

export async function runLocalProviderSmoke(cmd: LocalProviderSmokeCommandArgs): Promise<LocalProviderSmokeResult> {
	const timeoutMs = cmd.timeoutMs && cmd.timeoutMs > 0 ? cmd.timeoutMs : DEFAULT_TIMEOUT_MS;
	const configResult = await readLocalConfig(cmd.modelsPath);
	if ("ok" in configResult) return configResult;

	let model = cmd.model;
	try {
		model = model?.trim() || (await discoverFirstModel(configResult, timeoutMs));
		const response = await fetch(`${configResult.baseUrl}/chat/completions`, {
			method: "POST",
			headers: buildHeaders(configResult.apiKey),
			body: JSON.stringify({
				model,
				messages: [{ role: "user", content: DEFAULT_SMOKE_PROMPT }],
				stream: true,
				max_tokens: 16,
			}),
			signal: AbortSignal.timeout(timeoutMs),
		});
		if (!response.ok) {
			const text = await response.text().catch(() => "");
			return {
				ok: false,
				baseUrl: configResult.baseUrl,
				model,
				message: "Local provider streaming smoke request failed.",
				error: `HTTP ${response.status}${text ? `: ${text.slice(0, 500)}` : ""}`,
			};
		}
		const chunks = await readStreamingBody(response);
		if (chunks === 0) {
			return {
				ok: false,
				baseUrl: configResult.baseUrl,
				model,
				message: "Local provider returned an empty streaming response.",
			};
		}
		return {
			ok: true,
			baseUrl: configResult.baseUrl,
			model,
			message: `Local provider streaming smoke succeeded (${chunks} chunk${chunks === 1 ? "" : "s"}).`,
		};
	} catch (error) {
		return {
			ok: false,
			baseUrl: configResult.baseUrl,
			model,
			message: "Local provider streaming smoke request failed.",
			error: toErrorMessage(error),
		};
	}
}

export async function runLocalProviderDiscoverCommand(
	cmd: Omit<LocalProviderSmokeCommandArgs, "model">,
): Promise<void> {
	const result = await runLocalProviderDiscover(cmd);
	if (cmd.json) {
		process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
	} else if (result.ok) {
		process.stdout.write(`${chalk.green("ok")} ${result.message}\n`);
		process.stdout.write(`provider=${result.provider} baseUrl=${result.baseUrl}\n`);
		for (const model of result.models) {
			process.stdout.write(`${model}\n`);
		}
	} else {
		process.stderr.write(`${chalk.red("error")} ${result.message}\n`);
		process.stderr.write(`${chalk.dim(`provider=${result.provider} baseUrl=${result.baseUrl ?? "<unknown>"}`)}\n`);
		if (result.error) process.stderr.write(`${chalk.dim(result.error)}\n`);
	}
	if (!result.ok) process.exitCode = 1;
}

export async function runLocalProviderSmokeCommand(cmd: LocalProviderSmokeCommandArgs): Promise<void> {
	const result = await runLocalProviderSmoke(cmd);
	if (cmd.json) {
		process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
	} else if (result.ok) {
		process.stdout.write(`${chalk.green("ok")} ${result.message}\n`);
		process.stdout.write(`${chalk.dim(`endpoint=${result.baseUrl} model=${result.model}`)}\n`);
	} else {
		process.stderr.write(`${chalk.red("error")} ${result.message}\n`);
		if (result.baseUrl || result.model) {
			process.stderr.write(
				`${chalk.dim(`endpoint=${result.baseUrl ?? "<unknown>"} model=${result.model ?? "<unset>"}`)}\n`,
			);
		}
		if (result.error) process.stderr.write(`${chalk.dim(result.error)}\n`);
	}
	if (!result.ok) process.exitCode = 1;
}
