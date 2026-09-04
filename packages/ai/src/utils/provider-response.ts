import type { Api, AttemptScopeRef, Model, ProviderResponseMetadata, StreamOptions } from "../types";

export function normalizeProviderResponse(
	response: Response,
	requestId?: string | null,
	metadata?: Record<string, unknown>,
): ProviderResponseMetadata {
	const headers: Record<string, string> = {};
	response.headers.forEach((value, key) => {
		headers[key.toLowerCase()] = value;
	});
	const providerResponse: ProviderResponseMetadata = {
		status: response.status,
		headers,
	};
	if (requestId !== undefined) providerResponse.requestId = requestId;
	if (metadata !== undefined) providerResponse.metadata = metadata;
	return providerResponse;
}

export async function notifyProviderResponse(
	options:
		| { onResponse?: StreamOptions["onResponse"]; attemptScope?: AttemptScopeRef; signal?: AbortSignal }
		| undefined,
	response: Response,
	model?: Model<Api>,
	requestId?: string | null,
	metadata?: Record<string, unknown>,
): Promise<void> {
	if (!options?.onResponse) return;
	await options.onResponse(
		normalizeProviderResponse(response, requestId, metadata),
		model,
		options.attemptScope,
		options.signal,
	);
}
