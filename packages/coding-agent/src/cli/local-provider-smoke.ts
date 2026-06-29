import chalk from "chalk";
import { ModelsConfigFile } from "../config/model-registry";
import type { ModelsConfig } from "../config/models-config-schema";

export interface LocalProviderSmokeCommandArgs {
	model?: string;
	modelsPath?: string;
	timeoutMs?: number;
	json?: boolean;
	smoke?: boolean;
}

export interface LocalOpenAICompatConfig {
	baseUrl: string;
	apiKey?: string;
}

export type LocalProviderDiagnosticCheckName = "config" | "models" | "chat_stream";
export type LocalProviderDiagnosticStatus = "ok" | "skipped" | "error";
export type LocalProviderDiagnosticCategory =
	| "auth"
	| "timeout"
	| "unreachable"
	| "not_ready"
	| "oom"
	| "malformed_response"
	| "http_error"
	| "configuration"
	| "empty_response";

export interface LocalProviderDiagnosticCheck {
	name: LocalProviderDiagnosticCheckName;
	status: LocalProviderDiagnosticStatus;
	message: string;
	action?: string;
	category?: LocalProviderDiagnosticCategory;
	error?: string;
	httpStatus?: number;
}

export interface LocalProviderSmokeResult {
	ok: boolean;
	baseUrl?: string;
	model?: string;
	message: string;
	error?: string;
	category?: LocalProviderDiagnosticCategory;
	action?: string;
}

export interface LocalProviderDiscoveryResult {
	ok: boolean;
	provider: string;
	baseUrl?: string;
	models: string[];
	message: string;
	error?: string;
	category?: LocalProviderDiagnosticCategory;
	action?: string;
}

export interface LocalProviderStatusResult {
	ok: boolean;
	provider: "local";
	baseUrl?: string;
	model?: string;
	models: string[];
	checks: LocalProviderDiagnosticCheck[];
	message: string;
}

interface ClassifiedFailure {
	category: LocalProviderDiagnosticCategory;
	message: string;
	action: string;
	error?: string;
	httpStatus?: number;
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
		return {
			ok: false,
			message: "Failed to load models config.",
			error: loaded.error.message,
			category: "configuration",
			action: "Fix the models config file syntax, then retry the local-provider diagnostic.",
		};
	}
	const localConfig = getLocalOpenAICompatConfig(loaded.value ?? undefined);
	if (!localConfig) {
		return {
			ok: false,
			message: `No local OpenAI-compatible endpoint configured. Add providers.local.openaiCompat.baseUrl to ${configFile.path()}.`,
			category: "configuration",
			action: "Configure providers.local.openaiCompat.baseUrl for the local server you already run.",
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

async function responsePreview(response: Response): Promise<string> {
	const text = await response.text().catch(() => "");
	return text.slice(0, 500);
}

function bodyLooksLike(text: string | undefined, needles: readonly string[]): boolean {
	const lower = (text ?? "").toLowerCase();
	return needles.some(needle => lower.includes(needle));
}

function classifyHttpFailure(context: "models" | "chat_stream", status: number, body: string): ClassifiedFailure {
	if (status === 401 || status === 403) {
		return {
			category: "auth",
			httpStatus: status,
			message: `${context === "models" ? "GET /v1/models" : "Streaming chat smoke"} authentication failed.`,
			action:
				"Check providers.local.openaiCompat.apiKey/apiKeyEnv, or remove auth if the local server does not require it.",
			error: `HTTP ${status}${body ? `: ${body}` : ""}`,
		};
	}
	if (bodyLooksLike(body, ["out of memory", "oom", "cuda out", "insufficient memory"])) {
		return {
			category: "oom",
			httpStatus: status,
			message: `${context === "models" ? "GET /v1/models" : "Streaming chat smoke"} reported an out-of-memory condition.`,
			action: "Free GPU/CPU memory, lower the model/context size, or unload another model before retrying.",
			error: `HTTP ${status}${body ? `: ${body}` : ""}`,
		};
	}
	if (
		status === 408 ||
		status === 409 ||
		status === 425 ||
		status === 429 ||
		status === 503 ||
		status === 504 ||
		bodyLooksLike(body, ["loading", "warming", "not ready", "initializing", "starting", "model is loading"])
	) {
		return {
			category: "not_ready",
			httpStatus: status,
			message: `${context === "models" ? "GET /v1/models" : "Streaming chat smoke"} reached the server, but it is not ready.`,
			action: "Wait for the local server/model load to finish, verify the selected model is loaded, then retry.",
			error: `HTTP ${status}${body ? `: ${body}` : ""}`,
		};
	}
	return {
		category: "http_error",
		httpStatus: status,
		message: `${context === "models" ? "GET /v1/models" : "Streaming chat smoke"} returned HTTP ${status}.`,
		action:
			"Check the local server logs and confirm the configured base URL points at an OpenAI-compatible /v1 endpoint.",
		error: `HTTP ${status}${body ? `: ${body}` : ""}`,
	};
}

function classifyThrownFailure(
	context: "models" | "chat_stream",
	error: unknown,
	timeoutMs: number,
): ClassifiedFailure {
	const message = toErrorMessage(error);
	const name = error instanceof Error ? error.name : "";
	if (name === "AbortError" || name === "TimeoutError" || message.toLowerCase().includes("abort")) {
		return {
			category: "timeout",
			message: `${context === "models" ? "GET /v1/models" : "Streaming chat smoke"} timed out after ${timeoutMs}ms.`,
			action:
				"Confirm the local server is running and responsive; if it is loading a model, retry after it is ready or pass a slightly larger --timeout-ms.",
			error: message,
		};
	}
	if (
		bodyLooksLike(message, [
			"connection refused",
			"econnrefused",
			"couldn't connect",
			"failed to connect",
			"connection reset",
			"enotfound",
			"fetch failed",
		])
	) {
		return {
			category: "unreachable",
			message: `${context === "models" ? "GET /v1/models" : "Streaming chat smoke"} could not reach the configured endpoint.`,
			action:
				"Start the local OpenAI-compatible server or update providers.local.openaiCompat.baseUrl to the listening host/port.",
			error: message,
		};
	}
	if (bodyLooksLike(message, ["out of memory", "oom", "cuda out", "insufficient memory"])) {
		return {
			category: "oom",
			message: `${context === "models" ? "GET /v1/models" : "Streaming chat smoke"} reported an out-of-memory condition.`,
			action: "Free GPU/CPU memory, lower the model/context size, or unload another model before retrying.",
			error: message,
		};
	}
	return {
		category: "http_error",
		message: `${context === "models" ? "GET /v1/models" : "Streaming chat smoke"} failed.`,
		action: "Check the local server logs and retry the diagnostic after the endpoint is healthy.",
		error: message,
	};
}

function malformedFailure(error: unknown): ClassifiedFailure {
	return {
		category: "malformed_response",
		message: "GET /v1/models returned a malformed OpenAI-compatible response.",
		action:
			"Confirm the endpoint serves OpenAI-compatible JSON shaped like { data: [{ id: string }] } at /v1/models.",
		error: toErrorMessage(error),
	};
}

async function fetchLocalModelIds(config: LocalOpenAICompatConfig, timeoutMs: number): Promise<string[]> {
	const response = await fetch(`${config.baseUrl}/models`, {
		headers: buildHeaders(config.apiKey),
		signal: AbortSignal.timeout(timeoutMs),
	});
	if (!response.ok) {
		const body = await responsePreview(response);
		throw new Error(classifyHttpFailure("models", response.status, body).error);
	}
	let payload: unknown;
	try {
		payload = await response.json();
	} catch (error) {
		throw new Error(`Failed to parse /models JSON: ${toErrorMessage(error)}`);
	}
	return extractModelIds(payload);
}

async function diagnoseLocalModels(
	config: LocalOpenAICompatConfig,
	timeoutMs: number,
): Promise<{ models: string[]; check: LocalProviderDiagnosticCheck }> {
	try {
		const response = await fetch(`${config.baseUrl}/models`, {
			headers: buildHeaders(config.apiKey),
			signal: AbortSignal.timeout(timeoutMs),
		});
		if (!response.ok) {
			const body = await responsePreview(response);
			const failure = classifyHttpFailure("models", response.status, body);
			return { models: [], check: { name: "models", status: "error", ...failure } };
		}
		let payload: unknown;
		try {
			payload = await response.json();
		} catch (error) {
			const failure = malformedFailure(new Error(`Failed to parse /models JSON: ${toErrorMessage(error)}`));
			return { models: [], check: { name: "models", status: "error", ...failure } };
		}
		try {
			const models = extractModelIds(payload);
			return {
				models,
				check: {
					name: "models",
					status: "ok",
					message: `GET /v1/models succeeded and returned ${models.length} model${models.length === 1 ? "" : "s"}.`,
				},
			};
		} catch (error) {
			const failure = malformedFailure(error);
			return { models: [], check: { name: "models", status: "error", ...failure } };
		}
	} catch (error) {
		const failure = classifyThrownFailure("models", error, timeoutMs);
		return { models: [], check: { name: "models", status: "error", ...failure } };
	}
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

async function diagnoseChatStream(
	config: LocalOpenAICompatConfig,
	model: string,
	timeoutMs: number,
): Promise<LocalProviderDiagnosticCheck> {
	try {
		const response = await fetch(`${config.baseUrl}/chat/completions`, {
			method: "POST",
			headers: buildHeaders(config.apiKey),
			body: JSON.stringify({
				model,
				messages: [{ role: "user", content: DEFAULT_SMOKE_PROMPT }],
				stream: true,
				max_tokens: 16,
			}),
			signal: AbortSignal.timeout(timeoutMs),
		});
		if (!response.ok) {
			const body = await responsePreview(response);
			const failure = classifyHttpFailure("chat_stream", response.status, body);
			return { name: "chat_stream", status: "error", ...failure };
		}
		const chunks = await readStreamingBody(response);
		if (chunks === 0) {
			return {
				name: "chat_stream",
				status: "error",
				category: "empty_response",
				message: "Streaming chat smoke reached the server but returned no body chunks.",
				action:
					"Check whether the selected model supports streaming chat completions and inspect the local server logs.",
			};
		}
		return {
			name: "chat_stream",
			status: "ok",
			message: `Streaming chat smoke succeeded for ${model} (${chunks} chunk${chunks === 1 ? "" : "s"}).`,
		};
	} catch (error) {
		const failure = classifyThrownFailure("chat_stream", error, timeoutMs);
		return { name: "chat_stream", status: "error", ...failure };
	}
}

export async function runLocalProviderDiscover(
	cmd: Omit<LocalProviderSmokeCommandArgs, "model" | "smoke">,
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
			category: configResult.category,
			action: configResult.action,
		};
	}

	const diagnostics = await diagnoseLocalModels(configResult, timeoutMs);
	if (diagnostics.check.status === "ok") {
		return {
			ok: true,
			provider: "local",
			baseUrl: configResult.baseUrl,
			models: diagnostics.models,
			message: `Discovered ${diagnostics.models.length} model${diagnostics.models.length === 1 ? "" : "s"}.`,
		};
	}
	return {
		ok: false,
		provider: "local",
		baseUrl: configResult.baseUrl,
		models: [],
		message: "Local provider model discovery failed.",
		error: diagnostics.check.error,
		category: diagnostics.check.category,
		action: diagnostics.check.action,
	};
}

export async function runLocalProviderStatus(cmd: LocalProviderSmokeCommandArgs): Promise<LocalProviderStatusResult> {
	const timeoutMs = cmd.timeoutMs && cmd.timeoutMs > 0 ? cmd.timeoutMs : DEFAULT_TIMEOUT_MS;
	const checks: LocalProviderDiagnosticCheck[] = [];
	const configResult = await readLocalConfig(cmd.modelsPath);
	if ("ok" in configResult) {
		checks.push({
			name: "config",
			status: "error",
			message: configResult.message,
			error: configResult.error,
			category: configResult.category,
			action: configResult.action,
		});
		return { ok: false, provider: "local", models: [], checks, message: "Local provider diagnostics failed." };
	}

	checks.push({
		name: "config",
		status: "ok",
		message: "Found providers.local.openaiCompat without mutating config.",
	});
	const modelDiagnostics = await diagnoseLocalModels(configResult, timeoutMs);
	checks.push(modelDiagnostics.check);
	let model = cmd.model?.trim();
	const shouldSmoke = Boolean(cmd.smoke || model);
	if (!shouldSmoke) {
		checks.push({
			name: "chat_stream",
			status: "skipped",
			message: "Streaming chat smoke skipped; pass --smoke or --model to run it.",
		});
	} else if (modelDiagnostics.check.status !== "ok") {
		checks.push({
			name: "chat_stream",
			status: "skipped",
			message: "Streaming chat smoke skipped because GET /v1/models did not pass.",
			action: "Fix the /v1/models diagnostic first, then retry with --smoke or --model.",
		});
	} else {
		model = model || modelDiagnostics.models[0];
		if (!model) {
			checks.push({
				name: "chat_stream",
				status: "skipped",
				message: "Streaming chat smoke skipped because no model id was available.",
				action: "Pass --model with a loaded local model id.",
			});
		} else {
			checks.push(await diagnoseChatStream(configResult, model, timeoutMs));
		}
	}
	const ok = checks.every(check => check.status !== "error");
	return {
		ok,
		provider: "local",
		baseUrl: configResult.baseUrl,
		model,
		models: modelDiagnostics.models,
		checks,
		message: ok ? "Local provider diagnostics passed." : "Local provider diagnostics failed.",
	};
}

export async function runLocalProviderSmoke(cmd: LocalProviderSmokeCommandArgs): Promise<LocalProviderSmokeResult> {
	const timeoutMs = cmd.timeoutMs && cmd.timeoutMs > 0 ? cmd.timeoutMs : DEFAULT_TIMEOUT_MS;
	const configResult = await readLocalConfig(cmd.modelsPath);
	if ("ok" in configResult) return configResult;

	let model = cmd.model;
	try {
		model = model?.trim() || (await discoverFirstModel(configResult, timeoutMs));
		const check = await diagnoseChatStream(configResult, model, timeoutMs);
		if (check.status === "ok") {
			return {
				ok: true,
				baseUrl: configResult.baseUrl,
				model,
				message: check.message,
			};
		}
		return {
			ok: false,
			baseUrl: configResult.baseUrl,
			model,
			message: check.message,
			error: check.error,
			category: check.category,
			action: check.action,
		};
	} catch (error) {
		const failure = classifyThrownFailure("chat_stream", error, timeoutMs);
		return {
			ok: false,
			baseUrl: configResult.baseUrl,
			model,
			message: failure.message,
			error: failure.error,
			category: failure.category,
			action: failure.action,
		};
	}
}

export async function runLocalProviderDiscoverCommand(
	cmd: Omit<LocalProviderSmokeCommandArgs, "model" | "smoke">,
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
		if (result.action) process.stderr.write(`${chalk.dim(`action: ${result.action}`)}\n`);
	}
	if (!result.ok) process.exitCode = 1;
}

function renderStatusCheck(check: LocalProviderDiagnosticCheck): string {
	const label =
		check.status === "ok"
			? chalk.green("ok")
			: check.status === "skipped"
				? chalk.yellow("skip")
				: chalk.red("error");
	const suffix = check.category ? chalk.dim(` [${check.category}]`) : "";
	return `${label} ${check.name}: ${check.message}${suffix}\n`;
}

export async function runLocalProviderStatusCommand(cmd: LocalProviderSmokeCommandArgs): Promise<void> {
	const result = await runLocalProviderStatus(cmd);
	if (cmd.json) {
		process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
	} else {
		const stream = result.ok ? process.stdout : process.stderr;
		stream.write(`${result.ok ? chalk.green("ok") : chalk.red("error")} ${result.message}\n`);
		stream.write(
			`${chalk.dim(`provider=${result.provider} endpoint=${result.baseUrl ?? "<unknown>"}${result.model ? ` model=${result.model}` : ""}`)}\n`,
		);
		for (const check of result.checks) {
			stream.write(renderStatusCheck(check));
			if (check.error) stream.write(`${chalk.dim(`  ${check.error}`)}\n`);
			if (check.action) stream.write(`${chalk.dim(`  action: ${check.action}`)}\n`);
		}
		if (result.models.length > 0) {
			stream.write(`${chalk.dim(`models: ${result.models.join(", ")}`)}\n`);
		}
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
		if (result.action) process.stderr.write(`${chalk.dim(`action: ${result.action}`)}\n`);
	}
	if (!result.ok) process.exitCode = 1;
}
