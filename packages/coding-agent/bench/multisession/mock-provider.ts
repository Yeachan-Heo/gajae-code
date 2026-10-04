import type { Context, Model, SimpleStreamOptions } from "@gajae-code/ai/core";
import { createMockModel, registerMockApi, type MockContent, type MockModel, type MockResponse } from "@gajae-code/ai/providers/mock";
import type { ModelRegistry } from "../../src/config/model-registry";
import { buildWorkloadScript, type WorkloadAction } from "./workload";

const PROVIDER = "bench-mock";
const API = "bench-mock-api";
const SOURCE_PREFIX = "bench-multisession-session-";
const CONTEXT_WINDOW = 32_000;
const MAX_RETAINED_CALLS = 2;

export interface BenchMockProvider {
	root: MockModel;
	child: MockModel;
	rootModel: Model;
	childModel: Model;
	dispose(): void;
	register(): void;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function serializable(value: unknown, seen = new WeakSet<object>()): unknown {
	if (typeof value === "bigint") return `${value}n`;
	if (typeof value === "function" || typeof value === "symbol" || typeof value === "undefined") return undefined;
	if (value === null || typeof value !== "object") return value;
	if (seen.has(value)) return "[circular]";
	seen.add(value);
	let result: unknown;
	if (Array.isArray(value)) {
		result = value.map(entry => serializable(entry, seen)).filter(entry => entry !== undefined);
	} else {
		const clean: Record<string, unknown> = {};
		for (const [key, entry] of Object.entries(value)) {
			const item = serializable(entry, seen);
			if (item !== undefined) clean[key] = item;
		}
		result = clean;
	}
	seen.delete(value);
	return result;
}

const STABLE_REQUEST_OPTION_KEYS = [
	"temperature",
	"topP",
	"topK",
	"minP",
	"presencePenalty",
	"repetitionPenalty",
	"stopSequences",
	"frequencyPenalty",
	"maxTokens",
	"reasoning",
	"disableReasoning",
	"hideThinkingSummary",
	"thinkingBudgets",
	"toolChoice",
	"serviceTier",
	"kimiApiFormat",
	"syntheticApiFormat",
] as const;

function stableRequestOptions(options: SimpleStreamOptions | undefined): unknown {
	if (!options) return undefined;
	const source = options as unknown as Record<string, unknown>;
	const stable: Record<string, unknown> = {};
	for (const key of STABLE_REQUEST_OPTION_KEYS) {
		if (key in source) stable[key] = source[key];
	}
	return serializable(stable);
}

function modelVisibleMessage(message: unknown): unknown {
	if (!isRecord(message) || typeof message.role !== "string") return serializable(message);
	const visible: Record<string, unknown> = { role: message.role };
	for (const key of ["content", "api", "provider", "model", "toolCallId", "toolName", "isError", "name"] as const) {
		if (key in message) visible[key] = message[key];
	}
	return serializable(visible);
}
function serializeRequest(
	modelId: string,
	context: Context,
	options: SimpleStreamOptions | undefined,
	callsLength: number,
	requestIndex: number,
	sessionIndex: number,
): string {
	const capturedRequest = {
		sessionIndex,
		requestIndex,
		modelId,
		context: serializable({
			systemPrompt: context.systemPrompt,
			messages: context.messages.map(modelVisibleMessage),
			tools: context.tools?.map(tool => ({
				name: tool.name,
				description: tool.description,
				parameters: tool.parameters,
				strict: tool.strict,
				customFormat: tool.customFormat,
				customWireName: tool.customWireName,
			})),
		}),
		options: stableRequestOptions(options),
	};
	const requestJson = JSON.stringify(capturedRequest);
	if (requestJson === undefined) throw new Error("Unable to serialize bench-mock request evidence.");
	return `${requestJson.slice(0, -1)},"callsArrayLengthAfterTrim":${callsLength}}`;
}

function textContent(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.map(block => (isRecord(block) && block.type === "text" && typeof block.text === "string" ? block.text : ""))
		.join("\n");
}

function lastUserPrompt(context: Context): string {
	for (let index = context.messages.length - 1; index >= 0; index -= 1) {
		const message = context.messages[index];
		if (message?.role === "user") return textContent(message.content);
	}
	return "";
}

function hasToolResultAfterLastUser(context: Context): boolean {
	let lastUserIndex = -1;
	for (let index = 0; index < context.messages.length; index += 1) {
		if (context.messages[index]?.role === "user") lastUserIndex = index;
	}
	return context.messages.slice(lastUserIndex + 1).some(message => message?.role === "toolResult");
}

function toolResponse(action: Extract<WorkloadAction, { kind: "tool" }>): MockContent {
	return { type: "toolCall", name: action.name, arguments: action.arguments };
}

function rootResponse(context: Context): MockResponse {
	const prompt = lastUserPrompt(context);
	const script = [...buildWorkloadScript("full"), ...buildWorkloadScript("preflight")];
	const turn = script.find(candidate => prompt.includes(candidate.prompt.slice(0, Math.min(80, candidate.prompt.length))));
	// Use only the scripted prompt length so async job-notice durations cannot perturb compaction evidence.
	const inputTokens = Math.max(1, Math.ceil(prompt.length / 4));
	const respond = (content: MockContent[]): MockResponse =>
		turn?.key === "compaction" ? { content, usage: { input: inputTokens } } : { content };
	if (!turn) return respond(["bench maintenance summary"]);
	if (turn.action.kind === "tool" && !hasToolResultAfterLastUser(context)) {
		return respond([toolResponse(turn.action)]);
	}
	if (turn.action.kind === "text" || turn.action.kind === "compaction") {
		const response = respond([turn.action.text]);
		// A scripted latency keeps this turn in flight (preflight close barrier).
		return turn.delayMs ? { ...response, delayMs: turn.delayMs } : response;
	}
	return respond([`bench ${turn.key} tool complete`]);
}

function responseModelConfig(id: string, name: string) {
	return {
		id,
		name,
		reasoning: false,
		input: ["text"] as ("text" | "image")[],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: CONTEXT_WINDOW,
		maxTokens: 2_048,
	};
}

export function createBenchMockProviderDefinition(
	sessionIndex: number,
	writeRequest: (requestLine: string) => void | Promise<void>,
) {
	let requestIndex = 0;
	const capture = async (
		model: MockModel,
		context: Context,
		options: SimpleStreamOptions | undefined,
	): Promise<void> => {
		if (model.calls.length > MAX_RETAINED_CALLS) model.calls.splice(0, model.calls.length - MAX_RETAINED_CALLS);
		await writeRequest(serializeRequest(model.id, context, options, model.calls.length, requestIndex, sessionIndex));
		requestIndex += 1;
	};

	let root: MockModel;
	root = createMockModel({
		id: "root",
		provider: "mock",
		contextWindow: CONTEXT_WINDOW,
		maxTokens: 2_048,
		handler: async (context, options) => {
			await capture(root, context, options);
			return rootResponse(context);
		},
	});
	const child = createMockModel({
		id: "child",
		provider: PROVIDER,
		contextWindow: CONTEXT_WINDOW,
		maxTokens: 2_048,
		handler: async (context, options) => {
			await capture(child, context, options);
			return { content: ["bench child task complete"] };
		},
	});
	const config = {
		api: API,
		apiKey: "bench-mock-no-network-key",
		baseUrl: "https://bench-mock.invalid",
		authHeader: false,
		models: [responseModelConfig(root.id, "Bench Mock Root"), responseModelConfig(child.id, "Bench Mock Child")],
		streamSimple: (model: Model, context: Context, options?: SimpleStreamOptions) => {
			const scripted = model.id === child.id ? child : model.id === root.id ? root : undefined;
			if (!scripted) throw new Error(`bench-mock received unexpected model id ${model.id}`);
			return scripted.stream(scripted, context, options);
		},
	};
	return { root, child, config };
}

/** Create a provider instance scoped to one session and register its child model for task resolution. */
export function createBenchMockProvider(
	registry: ModelRegistry,
	sessionIndex: number,
	requestsPath: string,
): BenchMockProvider {
	const requestWriter = Bun.file(requestsPath).writer();
	const sourceId = `${SOURCE_PREFIX}${sessionIndex}`;
	const originalSyncExtensionSources = registry.syncExtensionSources;
	registry.syncExtensionSources = activeSourceIds =>
		originalSyncExtensionSources.call(registry, [...activeSourceIds, sourceId]);
	const definition = createBenchMockProviderDefinition(sessionIndex, async line => {
		await requestWriter.write(`${line}\n`);
		await requestWriter.flush();
	});
	const register = (): void => {
		registry.registerProvider(PROVIDER, definition.config, sourceId);
		registerMockApi(sourceId);
	};
	register();

	const rootModel = registry.find(PROVIDER, definition.root.id);
	const childModel = registry.find(PROVIDER, definition.child.id);
	if (!rootModel || !childModel) {
		requestWriter.end();
		registry.syncExtensionSources = originalSyncExtensionSources;
		registry.clearSourceRegistrations(sourceId);
		throw new Error("bench-mock provider registration did not expose both root and child models");
	}

	return {
		root: definition.root,
		child: definition.child,
		rootModel,
		childModel,
		register,
		dispose: () => {
			requestWriter.end();
			registry.syncExtensionSources = originalSyncExtensionSources;
			registry.clearSourceRegistrations(sourceId);
		},
	};
}