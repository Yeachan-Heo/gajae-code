import {
	KIRO_AWS_UA,
	KIRO_AWS_X_AMZ_UA,
	KIRO_MANAGEMENT_URL,
	KIRO_ORIGIN,
	KIRO_RUNTIME_URL,
	kiroOptoutHeader,
	resolveKiroProfileArn,
} from "../../providers/kiro";
import type { Model } from "../../types";

const LIST_MODELS_TARGET = "AmazonCodeWhispererService.ListAvailableModels";

interface KiroModelPayload {
	modelId?: unknown;
	modelName?: unknown;
	description?: unknown;
	tokenLimits?: { maxInputTokens?: unknown; maxOutputTokens?: unknown };
	additionalModelRequestFieldsSchema?: unknown;
}

interface KiroModelsPayload {
	models?: unknown;
	defaultModel?: { modelId?: unknown };
}
type KiroFetcher = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export interface KiroDiscoveryOptions {
	accessToken: string;
	profileArn?: string;
	fetcher?: KiroFetcher;
}

export async function fetchKiroModels(options: KiroDiscoveryOptions): Promise<Model<"kiro-streaming">[] | null> {
	if (!options.accessToken.trim()) return null;
	const fetcher = options.fetcher ?? fetch;
	try {
		const profileArn = options.profileArn?.trim() || (await resolveKiroProfileArn(options.accessToken, fetcher));
		const url = new URL(KIRO_MANAGEMENT_URL);
		url.searchParams.set("origin", KIRO_ORIGIN);
		url.searchParams.set("profileArn", profileArn);
		const response = await fetcher(url, {
			method: "POST",
			headers: {
				Authorization: `Bearer ${options.accessToken}`,
				"Content-Type": "application/x-amz-json-1.0",
				"x-amz-target": LIST_MODELS_TARGET,
				...kiroOptoutHeader(),
				"User-Agent": KIRO_AWS_UA,
				"x-amz-user-agent": KIRO_AWS_X_AMZ_UA,
				"amz-sdk-request": "attempt=1; max=3",
				accept: "*/*",
				"accept-encoding": "gzip",
			},
			body: JSON.stringify({ origin: KIRO_ORIGIN, profileArn }),
		});
		if (!response.ok) return null;
		const payload = (await response.json()) as KiroModelsPayload;
		if (!Array.isArray(payload.models)) return null;
		const seenModelIds = new Set<string>();
		return payload.models.flatMap(value => {
			const model = value as KiroModelPayload;
			if (typeof model.modelId !== "string" || !model.modelId) return [];
			if (seenModelIds.has(model.modelId)) return [];
			seenModelIds.add(model.modelId);
			const maxInput =
				typeof model.tokenLimits?.maxInputTokens === "number" ? model.tokenLimits.maxInputTokens : 200_000;
			const maxOutput =
				typeof model.tokenLimits?.maxOutputTokens === "number" ? model.tokenLimits.maxOutputTokens : 64_000;
			const schema = model.additionalModelRequestFieldsSchema;
			const properties =
				typeof schema === "object" &&
				schema !== null &&
				"properties" in schema &&
				typeof schema.properties === "object" &&
				schema.properties !== null
					? schema.properties
					: {};
			const hasThinking = "thinking" in properties;
			const hasReasoning = "reasoning" in properties;
			// Kiro's `userInputMessage` wire format is text-only.
			return [
				{
					id: model.modelId,
					name: typeof model.modelName === "string" ? model.modelName : model.modelId,
					api: "kiro-streaming" as const,
					provider: "kiro" as const,
					baseUrl: KIRO_RUNTIME_URL,
					reasoning: (hasThinking || hasReasoning) as boolean,
					input: ["text"],
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
					contextWindow: maxInput,
					maxTokens: maxOutput,
				} satisfies Model<"kiro-streaming">,
			];
		});
	} catch {
		return null;
	}
}
