import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { type Model as AiModel, getSupportedEfforts } from "@gajae-code/ai";
import { getAgentDir } from "@gajae-code/utils";
import { ModelRegistry } from "../../config/model-registry";
import { isModelSelectorValue, type ModelSelectorValue, selectorHead } from "../../config/model-selector-value";
import { getEnumValues, getType, SETTINGS_SCHEMA, type SettingPath, Settings } from "../../config/settings";
import { AuthStorage } from "../../session/auth-storage";
import type { HandlerResult, MethodHandler } from "./handlers";

type RecordValue = Record<string, unknown>;
type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

type SettingsDefinition = {
	type: string;
	default?: unknown;
	values?: readonly string[];
	validate?: (value: unknown) => boolean;
};

type ModelListParams = {
	cursor?: unknown;
	limit?: unknown;
	includeHidden?: unknown;
};

type ConfigWriteParams = {
	keyPath?: unknown;
	value?: unknown;
	mergeStrategy?: unknown;
	filePath?: unknown;
	expectedVersion?: unknown;
};

const invalidParams = (): HandlerResult => ({ ok: false, errorKey: "invalidParams" });
const internalError = (): HandlerResult => ({ ok: false, errorKey: "internalError" });
const notFound = (): HandlerResult => ({ ok: false, errorKey: "notFound" });

function isRecord(value: unknown): value is RecordValue {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isJsonValue(value: unknown): value is JsonValue {
	if (value === null || typeof value === "string" || typeof value === "boolean") return true;
	if (typeof value === "number") return Number.isFinite(value);
	if (Array.isArray(value)) return value.every(isJsonValue);
	if (!isRecord(value)) return false;
	return Object.values(value).every(isJsonValue);
}

function toJsonValue(value: unknown): JsonValue {
	if (value === undefined) return null;
	if (value === null || typeof value === "string" || typeof value === "boolean") return value;
	if (typeof value === "number") return Number.isFinite(value) ? value : null;
	if (typeof value === "bigint") return Number.isSafeInteger(Number(value)) ? Number(value) : String(value);
	if (Array.isArray(value)) return value.map(toJsonValue);
	if (isRecord(value))
		return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, toJsonValue(child)]));
	return String(value);
}

function resolveAgentDirectory(): string {
	const configured =
		process.env.GJC_AGENT_DIR ?? process.env.GJC_CODING_AGENT_DIR ?? process.env.PI_CODING_AGENT_DIR ?? undefined;
	return path.resolve(configured ?? getAgentDir());
}

function resolveCwd(value: unknown): string {
	return typeof value === "string" && value.length > 0 ? path.resolve(value) : process.cwd();
}

function configPath(agentDir: string): string {
	return path.join(agentDir, "config.yml");
}

function modelsPath(agentDir: string): string {
	return path.join(agentDir, "models.yml");
}

function currentVersion(filePath: string): string {
	try {
		return crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
	} catch {
		return "0";
	}
}

async function openModelRegistry(agentDir: string): Promise<{
	authStorage: AuthStorage;
	modelRegistry: ModelRegistry;
}> {
	await fs.promises.mkdir(agentDir, { recursive: true });
	const authStorage = await AuthStorage.create(path.join(agentDir, "auth.db"));
	return { authStorage, modelRegistry: new ModelRegistry(authStorage, modelsPath(agentDir)) };
}

function modelSelectorMatches(value: unknown, model: AiModel): boolean {
	if (!isModelSelectorValue(value)) return false;
	const selectors = typeof value === "string" ? [value] : value;
	const qualified = `${model.provider}/${model.id}`;
	return selectors.some(selector => selector === qualified || selector === model.id);
}

function modelEfforts(model: AiModel): string[] {
	if (!model.reasoning) return [];
	try {
		return [...getSupportedEfforts(model)].map(String);
	} catch {
		const thinking = model.thinking;
		if (!thinking) return [];
		if (thinking.levels && thinking.levels.length > 0) return thinking.levels.map(String);
		const order = ["minimal", "low", "medium", "high", "xhigh", "max"];
		const min = order.indexOf(String(thinking.minLevel));
		const max = order.indexOf(String(thinking.maxLevel));
		return min >= 0 && max >= min ? order.slice(min, max + 1) : [];
	}
}

function mapModel(model: AiModel, isDefault: boolean, hidden: boolean): RecordValue {
	const efforts = modelEfforts(model);
	const defaultReasoningEffort = String(model.thinking?.defaultLevel ?? model.thinking?.minLevel ?? "off");
	const supportedReasoningEfforts = efforts.map(reasoningEffort => ({
		reasoningEffort,
		description: `${reasoningEffort} reasoning for ${model.name}`,
	}));
	return {
		id: `${model.provider}/${model.id}`,
		model: model.id,
		upgrade: null,
		upgradeInfo: null,
		availabilityNux: null,
		displayName: model.name,
		description: `${model.provider}/${model.id} (${model.api})`,
		hidden,
		supportedReasoningEfforts,
		defaultReasoningEffort,
		inputModalities: model.input.length > 0 ? [...model.input] : ["text"],
		supportsPersonality: false,
		additionalSpeedTiers: [],
		serviceTiers: [],
		defaultServiceTier: null,
		isDefault,
	};
}

function selectedModelFromSettings(settings: Settings): string | undefined {
	const roles = settings.get("modelRoles") as Record<string, ModelSelectorValue>;
	return selectorHead(roles?.default);
}

function selectedProvider(selector: string | undefined): string | undefined {
	if (!selector) return undefined;
	const slash = selector.indexOf("/");
	return slash > 0 ? selector.slice(0, slash) : undefined;
}

function effectiveSettingsTree(settings: Settings): RecordValue {
	const tree: RecordValue = {};
	for (const key of Object.keys(SETTINGS_SCHEMA) as SettingPath[]) {
		const segments = key.split(".");
		let target = tree;
		for (const segment of segments.slice(0, -1)) {
			const existing = target[segment];
			if (!isRecord(existing)) target[segment] = {};
			target = target[segment] as RecordValue;
		}
		target[segments.at(-1)!] = toJsonValue(settings.get(key));
	}
	return tree;
}

function flattenEffectiveSettings(target: RecordValue, value: RecordValue, prefix = ""): void {
	for (const [key, child] of Object.entries(value)) {
		const fullPath = prefix ? `${prefix}.${key}` : key;
		if (isRecord(child)) flattenEffectiveSettings(target, child, fullPath);
		else target[fullPath] = child;
	}
}

function canonicalConfig(settings: Settings, effective: RecordValue, agentDir: string): RecordValue {
	const selector = selectedModelFromSettings(settings);
	const serviceTier = settings.get("serviceTier");
	const thresholdTokens = settings.get("compaction.thresholdTokens");
	const config: RecordValue = {
		codexHome: agentDir,
		model: selector ?? null,
		model_provider: selectedProvider(selector) ?? null,
		model_context_window: null,
		model_auto_compact_token_limit:
			typeof thresholdTokens === "number" && Number.isSafeInteger(thresholdTokens) && thresholdTokens > 0
				? thresholdTokens
				: null,
		model_auto_compact_token_limit_scope: null,
		model_reasoning_effort:
			settings.get("defaultThinkingLevel") === "off" ? null : settings.get("defaultThinkingLevel"),
		service_tier: serviceTier === "none" ? null : serviceTier,
		web_search: null,
		instructions: null,
		developer_instructions: null,
		compact_prompt: null,
		review_model: null,
		approval_policy: null,
		sandbox_mode: null,
		tools: null,
		desktop: effective,
		// Keep the original setting paths available to clients that do not know the
		// GJC desktop grouping convention. Values are all read from Settings above.
		gjc: effective,
	};
	flattenEffectiveSettings(config, effective);
	return config;
}

function originFor(filePath: string, version: string): RecordValue {
	return { name: { type: "user", file: filePath }, version };
}

function configReadResult(settings: Settings, includeLayers: boolean, agentDir: string): RecordValue {
	const filePath = configPath(agentDir);
	const version = currentVersion(filePath);
	const effective = effectiveSettingsTree(settings);
	const config = canonicalConfig(settings, effective, agentDir);
	const origins: RecordValue = {};
	for (const key of Object.keys(SETTINGS_SCHEMA)) origins[key] = originFor(filePath, version);
	origins.codexHome = originFor(filePath, version);
	return {
		config,
		origins,
		layers: includeLayers
			? [{ name: { type: "user", file: filePath }, version, config: effective, disabledReason: null }]
			: null,
	};
}

function definitionFor(
	keyPath: string,
): { basePath: SettingPath; dynamicRole?: string; definition: SettingsDefinition } | undefined {
	if (Object.hasOwn(SETTINGS_SCHEMA, keyPath)) {
		return {
			basePath: keyPath as SettingPath,
			definition: SETTINGS_SCHEMA[keyPath as SettingPath] as SettingsDefinition,
		};
	}
	if (keyPath.startsWith("modelRoles.") && keyPath.length > "modelRoles.".length) {
		return {
			basePath: "modelRoles",
			dynamicRole: keyPath.slice("modelRoles.".length),
			definition: SETTINGS_SCHEMA.modelRoles as SettingsDefinition,
		};
	}
	return undefined;
}

function validSettingValue(
	keyPath: string,
	value: unknown,
): { setting: NonNullable<ReturnType<typeof definitionFor>>; value: unknown } | undefined {
	const setting = definitionFor(keyPath);
	if (!setting || !isJsonValue(value)) return undefined;
	if (setting.dynamicRole) return isModelSelectorValue(value) ? { setting, value } : undefined;
	const type = getType(setting.basePath);
	switch (type) {
		case "boolean":
			return typeof value === "boolean" ? { setting, value } : undefined;
		case "string":
			return typeof value === "string" ? { setting, value } : undefined;
		case "number": {
			if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
			const validate = setting.definition.validate;
			return validate && !validate(value) ? undefined : { setting, value };
		}
		case "enum": {
			const allowed = getEnumValues(setting.basePath);
			return typeof value === "string" && (!allowed || allowed.includes(value)) ? { setting, value } : undefined;
		}
		case "array":
			return Array.isArray(value) ? { setting, value } : undefined;
		case "record":
			return isRecord(value) ? { setting, value } : undefined;
		default:
			return undefined;
	}
}

function expectedFilePath(agentDir: string, value: unknown): boolean {
	return (
		value === undefined ||
		value === null ||
		(typeof value === "string" && path.resolve(value) === configPath(agentDir))
	);
}

function mergeValue(current: unknown, value: unknown, mergeStrategy: "replace" | "upsert"): unknown {
	if (mergeStrategy === "replace") return value;
	if (!isRecord(value) || !isRecord(current)) return value;
	return { ...current, ...value };
}

function parseWriteParams(params: unknown):
	| {
			keyPath: string;
			value: unknown;
			mergeStrategy: "replace" | "upsert";
			filePath?: string;
			expectedVersion?: string;
	  }
	| HandlerResult {
	if (!isRecord(params)) return invalidParams();
	if (typeof params.keyPath !== "string" || params.keyPath.length === 0) return invalidParams();
	if (!Object.hasOwn(params, "value") || !isJsonValue(params.value)) return invalidParams();
	if (params.mergeStrategy !== "replace" && params.mergeStrategy !== "upsert") return invalidParams();
	if (!expectedFilePath(resolveAgentDirectory(), params.filePath)) return invalidParams();
	if (params.filePath !== undefined && params.filePath !== null && typeof params.filePath !== "string")
		return invalidParams();
	if (
		params.expectedVersion !== undefined &&
		params.expectedVersion !== null &&
		typeof params.expectedVersion !== "string"
	)
		return invalidParams();
	return {
		keyPath: params.keyPath,
		value: params.value,
		mergeStrategy: params.mergeStrategy,
		filePath: typeof params.filePath === "string" ? params.filePath : undefined,
		expectedVersion: typeof params.expectedVersion === "string" ? params.expectedVersion : undefined,
	};
}

function writeResponse(agentDir: string): HandlerResult {
	const filePath = configPath(agentDir);
	return {
		ok: true,
		result: {
			status: "ok",
			version: currentVersion(filePath),
			filePath,
			overriddenMetadata: null,
		},
	};
}

async function applyConfigEdits(
	settings: Settings,
	agentDir: string,
	edits: readonly ConfigWriteParams[],
	expectedVersion: string | undefined,
): Promise<HandlerResult> {
	const filePath = configPath(agentDir);
	if (expectedVersion !== undefined && expectedVersion !== currentVersion(filePath))
		return { ok: false, errorKey: "conflict" };
	const patches: Array<{ path: SettingPath; op: "set"; value: unknown }> = [];
	const pendingValues = new Map<string, unknown>();
	for (const edit of edits) {
		if (typeof edit.keyPath !== "string" || edit.keyPath.length === 0) return invalidParams();
		if (!Object.hasOwn(edit, "value") || !isJsonValue(edit.value)) return invalidParams();
		if (edit.mergeStrategy !== "replace" && edit.mergeStrategy !== "upsert") return invalidParams();
		const validated = validSettingValue(edit.keyPath, edit.value);
		if (!validated) return invalidParams();
		const current = pendingValues.has(edit.keyPath)
			? pendingValues.get(edit.keyPath)
			: validated.setting.dynamicRole
				? settings.getGlobal("modelRoles") && isRecord(settings.getGlobal("modelRoles"))
					? (settings.getGlobal("modelRoles") as RecordValue)[validated.setting.dynamicRole!]
					: undefined
				: settings.getGlobal(validated.setting.basePath);
		const next = mergeValue(current, edit.value, edit.mergeStrategy);
		if (!validSettingValue(edit.keyPath, next)) return invalidParams();
		pendingValues.set(edit.keyPath, next);
		patches.push({ path: edit.keyPath as SettingPath, op: "set", value: next });
	}
	try {
		if (patches.length > 0) await settings.commitAtomicBatch(patches);
		return writeResponse(agentDir);
	} catch {
		return internalError();
	}
}

/** Enumerate GJC's loaded model registry as the pinned ModelListResponse shape. */
export const modelListHandler: MethodHandler = async params => {
	const p = params === undefined || params === null ? {} : params;
	if (!isRecord(p)) return invalidParams();
	const modelParams = p as ModelListParams;
	const cursor = modelParams.cursor;
	const limit = modelParams.limit;
	const includeHidden = modelParams.includeHidden;
	if (cursor !== undefined && cursor !== null && typeof cursor !== "string") return invalidParams();
	if (limit !== undefined && limit !== null && (!Number.isSafeInteger(limit) || Number(limit) < 1))
		return invalidParams();
	if (includeHidden !== undefined && includeHidden !== null && typeof includeHidden !== "boolean")
		return invalidParams();
	const start = cursor === undefined || cursor === null || cursor === "" ? 0 : Number.parseInt(cursor, 10);
	if (!Number.isSafeInteger(start) || start < 0) return invalidParams();
	const agentDir = resolveAgentDirectory();
	let settings: Settings;
	let authStorage: AuthStorage | undefined;
	try {
		settings = await Settings.loadForScope({ cwd: resolveCwd((p as RecordValue).cwd), agentDir });
		const opened = await openModelRegistry(agentDir);
		authStorage = opened.authStorage;
		const disabledProviders = new Set(
			(settings.get("disabledProviders") as unknown[]).filter(item => typeof item === "string"),
		);
		const configuredDefault = settings.get("modelRoles");
		const models = opened.modelRegistry
			.getAll()
			.slice()
			.sort((left, right) => `${left.provider}/${left.id}`.localeCompare(`${right.provider}/${right.id}`))
			.map(model => ({
				model,
				hidden: disabledProviders.has(model.provider),
			}))
			.filter(entry => includeHidden === true || !entry.hidden);
		const page = models.slice(start, limit === undefined || limit === null ? undefined : start + Number(limit));
		const result = {
			data: page.map(entry =>
				mapModel(entry.model, modelSelectorMatches(configuredDefault, entry.model), entry.hidden),
			),
			nextCursor:
				limit !== undefined && limit !== null && start + Number(limit) < models.length
					? String(start + Number(limit))
					: null,
		};
		return { ok: true, result };
	} catch {
		return internalError();
	} finally {
		authStorage?.close();
	}
};

/** Read provider/model capabilities from GJC's real model compatibility metadata. */
export const modelProviderCapabilitiesReadHandler: MethodHandler = async params => {
	const p = params === undefined || params === null ? {} : params;
	if (!isRecord(p)) return invalidParams();
	const agentDir = resolveAgentDirectory();
	let authStorage: AuthStorage | undefined;
	try {
		const settings = await Settings.loadForScope({ cwd: resolveCwd((p as RecordValue).cwd), agentDir });
		const opened = await openModelRegistry(agentDir);
		authStorage = opened.authStorage;
		const requestedProvider = [p.provider, p.providerId, p.modelProvider].find(value => typeof value === "string") as
			| string
			| undefined;
		const requestedModel = typeof p.model === "string" ? p.model : undefined;
		const modelQualifiedProvider = requestedModel?.includes("/") ? requestedModel.split("/", 1)[0] : undefined;
		const provider =
			requestedProvider ?? modelQualifiedProvider ?? selectedProvider(selectedModelFromSettings(settings));
		const allModels = opened.modelRegistry.getAll();
		const providerModels = provider ? allModels.filter(model => model.provider === provider) : allModels;
		if (providerModels.length === 0) return notFound();
		const requestedModelId = requestedModel?.includes("/")
			? requestedModel.slice(requestedModel.indexOf("/") + 1)
			: requestedModel;
		const model = requestedModelId
			? providerModels.find(candidate => candidate.id === requestedModelId)
			: providerModels[0];
		if (!model) return notFound();
		const compat = (model.compat ?? {}) as RecordValue;
		const toolChoiceSupport = typeof compat.toolChoiceSupport === "string" ? compat.toolChoiceSupport : undefined;
		const supportsToolChoice = compat.supportsToolChoice !== false && toolChoiceSupport !== "none";
		const providerWebSearch = opened.modelRegistry.getProviderWebSearchMode(model.provider);
		return {
			ok: true,
			result: {
				namespaceTools: supportsToolChoice,
				imageGeneration: model.output?.includes("image") === true,
				// `providers.webSearch` selects a provider and has no disabled member, so only an
				// explicit per-provider `off` mode disables web search for this model.
				webSearch: providerWebSearch !== "off",
				provider: model.provider,
				model: model.id,
				toolChoiceSupport: toolChoiceSupport ?? (supportsToolChoice ? "auto" : "none"),
				contextWindow: model.contextWindow,
				maxTokens: model.maxTokens,
			},
		};
	} catch {
		return internalError();
	} finally {
		authStorage?.close();
	}
};

/** Project effective GJC settings onto the pinned ConfigReadResponse shape. */
export const configReadHandler: MethodHandler = async params => {
	const p = params === undefined || params === null ? {} : params;
	if (!isRecord(p)) return invalidParams();
	if (p.includeLayers !== undefined && p.includeLayers !== null && typeof p.includeLayers !== "boolean")
		return invalidParams();
	const agentDir = resolveAgentDirectory();
	try {
		const settings = await Settings.loadForScope({ cwd: resolveCwd(p.cwd), agentDir });
		return { ok: true, result: configReadResult(settings, p.includeLayers === true, agentDir) };
	} catch {
		return internalError();
	}
};

/** Persist one validated setting through Settings' durable atomic write seam. */
export const configValueWriteHandler: MethodHandler = async params => {
	const parsed = parseWriteParams(params);
	if ("ok" in parsed) return parsed;
	const agentDir = resolveAgentDirectory();
	const validated = validSettingValue(parsed.keyPath, parsed.value);
	if (!validated) return invalidParams();
	try {
		const settings = await Settings.loadForScope({ cwd: process.cwd(), agentDir });
		return await applyConfigEdits(settings, agentDir, [parsed], parsed.expectedVersion);
	} catch {
		return internalError();
	}
};

/** Persist a validated batch as one all-or-nothing Settings atomic batch. */
export const configBatchWriteHandler: MethodHandler = async params => {
	if (!isRecord(params) || !Array.isArray(params.edits)) return invalidParams();
	if (
		params.reloadUserConfig !== undefined &&
		params.reloadUserConfig !== null &&
		typeof params.reloadUserConfig !== "boolean"
	)
		return invalidParams();
	if (params.filePath !== undefined && params.filePath !== null && typeof params.filePath !== "string")
		return invalidParams();
	if (!expectedFilePath(resolveAgentDirectory(), params.filePath)) return invalidParams();
	if (
		params.expectedVersion !== undefined &&
		params.expectedVersion !== null &&
		typeof params.expectedVersion !== "string"
	)
		return invalidParams();
	const edits = params.edits as unknown[];
	if (
		!edits.every(
			(edit): edit is ConfigWriteParams =>
				isRecord(edit) &&
				typeof edit.keyPath === "string" &&
				Object.hasOwn(edit, "value") &&
				(edit.mergeStrategy === "replace" || edit.mergeStrategy === "upsert"),
		)
	)
		return invalidParams();
	const agentDir = resolveAgentDirectory();
	try {
		const settings = await Settings.loadForScope({ cwd: process.cwd(), agentDir });
		return await applyConfigEdits(
			settings,
			agentDir,
			edits,
			typeof params.expectedVersion === "string" ? params.expectedVersion : undefined,
		);
	} catch {
		return internalError();
	}
};

export const modelConfigHandlers: Record<string, MethodHandler> = {
	"model/list": modelListHandler,
	"modelProvider/capabilities/read": modelProviderCapabilitiesReadHandler,
	"config/read": configReadHandler,
	"config/value/write": configValueWriteHandler,
	"config/batchWrite": configBatchWriteHandler,
};
